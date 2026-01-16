import type { Router } from 'express';
import { z } from 'zod';
import { mysqlPool } from '../mysql.js';
import { supabaseAdmin } from '../supabase.js';
import { formatMoneyYuan } from '../utils/money.js';
import { stripeClient, stripeRefund } from '../providers/stripe.js';
import { yipayRefund } from '../providers/yipay.js';
import { asBigInt, centsToQuota, centsToYuanString, yuanStringToCents } from '../utils/quota.js';
import { isUuid } from '../utils/uuid.js';

type RefundCreateRouterOptions = {
  router: Router;
};

export const registerRefundCreateRoute = ({ router }: RefundCreateRouterOptions) => {
  router.post('/', async (req, res) => {
    const BodySchema = z.object({
      tradeNo: z.string().min(1),
      yipayOrderNoField: z.enum(['trade_no', 'out_trade_no']).optional(),
      refundMoney: z.union([z.string().min(1), z.number()]).optional(),
      stripePaymentIntentId: z.string().optional(),
      stripeChargeId: z.string().optional()
    });

    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    }

    if (!req.admin) {
      return res.status(500).json({ error: 'missing_admin_context' });
    }

    const performedBy = isUuid(req.admin.userId) ? req.admin.userId : undefined;

    if (!supabaseAdmin) {
      return res.status(500).json({ error: 'server_missing_supabase' });
    }

    const { tradeNo, yipayOrderNoField, refundMoney, stripeChargeId, stripePaymentIntentId } = parsed.data;

    const conn = await mysqlPool.getConnection();
    let refundRowId: string | null = null;

    try {
      await conn.beginTransaction();

      const [rows] = await conn.execute(
        `
          select
            tu.id,
            tu.user_id,
            tu.amount,
            tu.money,
            tu.trade_no,
            tu.status,
            tu.payment_method,
            u.quota as user_quota,
            u.used_quota as user_used_quota,
            u.stripe_customer as user_stripe_customer
          from top_ups tu
          left join users u on u.id = tu.user_id
          where tu.trade_no = ?
          limit 1
          for update
        `,
        [tradeNo]
      );

      const topup = Array.isArray(rows) ? (rows[0] as any) : null;
      if (!topup) {
        await conn.rollback();
        return res.status(404).json({ error: 'topup_not_found' });
      }
      if (topup.status !== 'success') {
        await conn.rollback();
        return res.status(409).json({ error: 'topup_not_refundable', status: topup.status });
      }
      if (!topup.user_id) {
        await conn.rollback();
        return res.status(409).json({ error: 'topup_missing_user' });
      }

      const amountQuota = asBigInt(topup.amount ?? 0, 'amount');
      const userQuota = asBigInt(topup.user_quota ?? 0, 'user_quota');

      let quotaDelta: bigint | null = null;
      let yipayMoneyYuan: string | null = null;
      let yipayMoneyCents: bigint | null = null;

      const outRefundNo = `refund_${tradeNo}_${Date.now()}`;
      const isYipay = topup.payment_method === 'alipay' || topup.payment_method === 'wxpay';

      if (isYipay) {
        if (refundMoney === undefined) {
          throw new Error('refundMoney is required for alipay/wxpay');
        }
        const moneyYuan = typeof refundMoney === 'number' ? formatMoneyYuan(refundMoney) : refundMoney;
        const moneyCents = yuanStringToCents(moneyYuan);
        if (moneyCents <= 0n) {
          await conn.rollback();
          return res.status(400).json({ error: 'invalid_refund_amount' });
        }

        yipayMoneyYuan = moneyYuan;
        yipayMoneyCents = moneyCents;
        quotaDelta = centsToQuota(moneyCents);
      } else if (amountQuota > 0n) {
        quotaDelta = amountQuota;
      }

      if (quotaDelta && quotaDelta > 0n && userQuota < quotaDelta) {
        await conn.rollback();
        return res.status(400).json({
          error: 'insufficient_user_quota',
          user_quota: userQuota.toString(),
          quota_delta: quotaDelta.toString()
        });
      }

      const { data: refundRow, error: insertErr } = await supabaseAdmin
        .from('refunds')
        .insert({
          mysql_user_id: String(topup.user_id),
          topup_trade_no: tradeNo,
          payment_method: topup.payment_method,
          provider: isYipay ? 'yipay' : 'stripe',
          out_refund_no: outRefundNo,
          ...(quotaDelta ? { quota_delta: quotaDelta.toString() } : {}),
          status: 'pending',
          performed_by: performedBy,
          raw_request: {
            tradeNo,
            yipayOrderNoField,
            refundMoney,
            stripePaymentIntentId,
            stripeChargeId
          }
        })
        .select('id')
        .single();

      if (insertErr) {
        await conn.rollback();
        return res.status(500).json({ error: 'refund_log_insert_failed', details: insertErr.message });
      }
      refundRowId = refundRow.id;

      let providerResult: any;

      if (isYipay) {
        if (!yipayMoneyYuan || yipayMoneyCents === null || !quotaDelta) {
          throw new Error('yipay_refund_context_missing');
        }

        const ts = Math.floor(Date.now() / 1000);
        providerResult = await yipayRefund({
          orderNoField: yipayOrderNoField ?? 'out_trade_no',
          orderNo: tradeNo,
          money: yipayMoneyYuan,
          outRefundNo,
          timestamp: ts
        });

        await supabaseAdmin
          .from('refunds')
          .update({
            refund_money: yipayMoneyYuan,
            refund_money_minor: yipayMoneyCents.toString(),
            currency: 'cny',
            quota_delta: quotaDelta.toString()
          })
          .eq('id', refundRowId);
      } else if (topup.payment_method === 'stripe') {
        const hint = String(topup.trade_no ?? '');
        const inferredPaymentIntentId = hint.startsWith('pi_') ? hint : undefined;
        const inferredChargeId = hint.startsWith('ch_') ? hint : undefined;

        const expectedCustomer = topup.user_stripe_customer ? String(topup.user_stripe_customer) : '';
        const candidatePaymentIntentId = stripePaymentIntentId ?? inferredPaymentIntentId;
        const candidateChargeId = stripeChargeId ?? inferredChargeId;

        if (stripeClient && expectedCustomer && candidatePaymentIntentId) {
          const pi = await stripeClient.paymentIntents.retrieve(candidatePaymentIntentId);
          const customer = typeof pi.customer === 'string' ? pi.customer : pi.customer?.id;
          if (customer && customer !== expectedCustomer) {
            throw new Error('stripe_customer_mismatch');
          }
          if (pi.status !== 'succeeded') {
            throw new Error(`stripe_payment_intent_not_succeeded:${pi.status}`);
          }
        }

        if (stripeClient && expectedCustomer && candidateChargeId) {
          const ch = await stripeClient.charges.retrieve(candidateChargeId);
          const customer = typeof ch.customer === 'string' ? ch.customer : ch.customer?.id;
          if (customer && customer !== expectedCustomer) {
            throw new Error('stripe_customer_mismatch');
          }
        }

        providerResult = await stripeRefund({
          paymentIntentId: candidatePaymentIntentId,
          chargeId: candidateChargeId,
          idempotencyKey: outRefundNo
        });

        if (typeof providerResult?.amount !== 'number') {
          throw new Error('stripe_refund_missing_amount');
        }

        quotaDelta = centsToQuota(BigInt(providerResult.amount));

        if (providerResult?.charge && typeof providerResult.charge === 'string') {
          await supabaseAdmin
            .from('refunds')
            .update({
              stripe_charge_id: providerResult.charge
            })
            .eq('id', refundRowId);
        }

        const cents = BigInt(providerResult.amount);
        await supabaseAdmin
          .from('refunds')
          .update({
            refund_money: centsToYuanString(cents),
            refund_money_minor: cents.toString(),
            currency: String(providerResult.currency ?? 'cny'),
            quota_delta: quotaDelta.toString()
          })
          .eq('id', refundRowId);
      } else {
        throw new Error(`Unsupported payment_method: ${topup.payment_method}`);
      }

      const [updateTopup] = await conn.execute(
        `update top_ups set status = 'refund' where trade_no = ? and status = 'success'`,
        [tradeNo]
      );
      const topupAffected = (updateTopup as any).affectedRows ?? 0;
      if (topupAffected !== 1) {
        throw new Error('topup_already_updated');
      }

      if (quotaDelta && quotaDelta > 0n) {
        const [updateUser] = await conn.execute(
          `update users set quota = quota - ? where id = ? and quota >= ?`,
          [quotaDelta.toString(), topup.user_id, quotaDelta.toString()]
        );
        const userAffected = (updateUser as any).affectedRows ?? 0;
        if (userAffected !== 1) {
          throw new Error('insufficient_user_quota');
        }
      }

      await conn.commit();

      await supabaseAdmin
        .from('refunds')
        .update({
          status: 'succeeded',
          executed_at: new Date().toISOString(),
          provider_refund_no:
            topup.payment_method === 'stripe'
              ? providerResult?.id
              : providerResult?.response?.refund_no,
          raw_response: providerResult
        })
        .eq('id', refundRowId);

      return res.json({ ok: true, refund: providerResult });
    } catch (err) {
      await conn.rollback();
      const message = err instanceof Error ? err.message : 'unknown_error';
      if (refundRowId) {
        await supabaseAdmin
          .from('refunds')
          .update({
            status: 'failed',
            error_message: message,
            executed_at: new Date().toISOString()
          })
          .eq('id', refundRowId);
      }

      return res.status(500).json({ error: 'refund_failed', message });
    } finally {
      conn.release();
    }
  });
};
