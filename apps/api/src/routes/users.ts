import { Router } from 'express';
import { z } from 'zod';
import { mysqlPool } from '../mysql.js';
import { supabaseAdmin } from '../supabase.js';
import { listCustomerCharges, stripeClient, stripeRefund } from '../providers/stripe.js';
import { yipayRefund } from '../providers/yipay.js';
import {
  asBigInt,
  centsToQuota,
  centsToYuanString,
  quotaToCentsFloor,
  yuanStringToCents
} from '../utils/quota.js';
import { DEFAULT_FEE_BPS, applyFeeToCents, parseFeePercentToBps } from '../utils/fee.js';
import { isUuid } from '../utils/uuid.js';

type MysqlUserRow = {
  id: string;
  email?: string | null;
  quota: string;
  used_quota: string;
  stripe_customer?: string | null;
};

type YipayTopupRow = {
  trade_no: string;
  money: number;
  payment_method: 'alipay' | 'wxpay';
  status: string;
};

const requireSupabase = () => {
  if (!supabaseAdmin) {
    throw new Error('server_missing_supabase');
  }
  return supabaseAdmin;
};

const toSafeNumber = (value: bigint) => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('number_overflow');
  }
  return Number(value);
};

const getUserById = async (userId: string) => {
  const [rows] = await mysqlPool.execute(
    `select id, email, quota, used_quota, stripe_customer from users where id = ? limit 1`,
    [userId]
  );
  const row = Array.isArray(rows) ? (rows[0] as MysqlUserRow | undefined) : undefined;
  if (!row) return null;
  return row;
};

const sumYipayPaidCents = async (userId: string) => {
  const [rows] = await mysqlPool.execute(
    `
      select
        coalesce(sum(cast(round(money * 100) as signed)), 0) as total_cents
      from top_ups
      where user_id = ?
        and payment_method in ('alipay', 'wxpay')
        and status in ('success', 'refund')
    `,
    [userId]
  );
  const row = Array.isArray(rows) ? (rows[0] as any) : null;
  const total = row?.total_cents ?? 0;
  return asBigInt(total, 'yipay_total_cents');
};

const listUserYipayTopups = async (userId: string) => {
  const [rows] = await mysqlPool.execute(
    `
      select trade_no, money, payment_method, status
      from top_ups
      where user_id = ?
        and payment_method in ('alipay', 'wxpay')
        and status in ('success', 'refund')
      order by complete_time desc
    `,
    [userId]
  );
  return (Array.isArray(rows) ? rows : []) as unknown as YipayTopupRow[];
};

const listRefundsForUserAccounting = async (userId: string) => {
  const sb = requireSupabase();
  const { data, error } = await sb
    .from('refunds')
    .select('provider, topup_trade_no, refund_money_minor, status')
    .eq('mysql_user_id', userId)
    .in('status', ['pending', 'succeeded']);

  if (error) {
    throw new Error(`supabase_error:${error.message}`);
  }
  return data ?? [];
};

const buildRefundQuote = async (userId: string) => {
  const user = await getUserById(userId);
  if (!user) {
    return { user: null };
  }

  const quota = asBigInt(user.quota, 'quota');
  const usedQuota = asBigInt(user.used_quota, 'used_quota');
  const remainingCentsByQuota = quotaToCentsFloor(quota);

  const yipayPaidCents = await sumYipayPaidCents(userId);
  const refundsForAccounting = await listRefundsForUserAccounting(userId);

  const yipayRefundedCents = refundsForAccounting
    .filter((r) => r.provider === 'yipay')
    .reduce((sum, r) => sum + asBigInt(r.refund_money_minor ?? 0, 'refund_money_minor'), 0n);

  const yipayNetPaidCents = yipayPaidCents > yipayRefundedCents ? yipayPaidCents - yipayRefundedCents : 0n;

  let stripeCurrency: string | null = null;
  let stripeNetPaidCents = 0n;
  let stripeRefundableCharges: Array<{
    id: string;
    created: number;
    payment_intent?: string;
    currency: string;
    remaining_cents: bigint;
  }> = [];

  const stripeCustomer = user.stripe_customer ? String(user.stripe_customer) : '';
  if (stripeCustomer && stripeClient) {
    const charges = await listCustomerCharges(stripeCustomer);
    for (const charge of charges) {
      if (!charge.paid) continue;
      if (charge.status !== 'succeeded') continue;
      const remaining = BigInt(charge.amount - (charge.amount_refunded ?? 0));
      if (!stripeCurrency) stripeCurrency = charge.currency;
      if (stripeCurrency !== charge.currency) {
        throw new Error('stripe_multiple_currencies');
      }
      if (remaining > 0n) {
        stripeRefundableCharges.push({
          id: charge.id,
          created: charge.created,
          payment_intent: typeof charge.payment_intent === 'string' ? charge.payment_intent : undefined,
          currency: charge.currency,
          remaining_cents: remaining
        });
        stripeNetPaidCents += remaining;
      }
    }

    stripeRefundableCharges = stripeRefundableCharges.sort((a, b) => b.created - a.created);
  }

  const totalNetPaidCents = stripeNetPaidCents + yipayNetPaidCents;
  const totalQuota = quota + usedQuota;
  const dueCents = (() => {
    if (totalNetPaidCents <= 0n) return 0n;
    if (quota <= 0n) return 0n;
    if (totalQuota <= 0n) return 0n;
    const raw = (totalNetPaidCents * quota) / totalQuota;
    if (raw <= 0n) return 0n;
    return raw > totalNetPaidCents ? totalNetPaidCents : raw;
  })();

  const stripePlanCents = dueCents > stripeNetPaidCents ? stripeNetPaidCents : dueCents;
  const yipayPlanCents = dueCents - stripePlanCents;

  const yipayRefundedByTopup = new Map<string, bigint>();
  for (const r of refundsForAccounting) {
    if (r.provider !== 'yipay') continue;
    const tradeNo = r.topup_trade_no ? String(r.topup_trade_no) : '';
    if (!tradeNo) continue;
    const prev = yipayRefundedByTopup.get(tradeNo) ?? 0n;
    yipayRefundedByTopup.set(tradeNo, prev + asBigInt(r.refund_money_minor ?? 0, 'refund_money_minor'));
  }

  return {
    user,
    quota,
    usedQuota,
    remainingCentsByQuota,
    yipayPaidCents,
    yipayRefundedCents,
    yipayNetPaidCents,
    stripeCustomer,
    stripeCurrency,
    stripeNetPaidCents,
    stripeRefundableCharges,
    totalNetPaidCents,
    dueCents,
    plan: {
      stripeCents: stripePlanCents,
      yipayCents: yipayPlanCents
    },
    yipayRefundedByTopup
  };
};

export const usersRouter = Router();

usersRouter.get('/', async (req, res) => {
  try {
    const QuerySchema = z.object({
      q: z.string().optional(),
      limit: z
        .string()
        .optional()
        .default('20')
        .transform((v) => Math.min(Math.max(Number(v) || 20, 1), 100))
    });
    const parsed = QuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_query', details: parsed.error.flatten() });
    }

    const { q, limit } = parsed.data;
    const where: string[] = [];
    const params: Array<string | number> = [];

    if (q) {
      if (/^\d+$/.test(q)) {
        where.push('(cast(id as char) = ? or email like ?)');
        params.push(q, `%${q}%`);
      } else {
        where.push('email like ?');
        params.push(`%${q}%`);
      }
    }

    const sql = `
      select id, email, quota, used_quota, stripe_customer
      from users
      ${where.length ? `where ${where.join(' and ')}` : ''}
      order by id desc
      limit ?
    `;
    params.push(limit);

    const [rows] = await mysqlPool.query(sql, params);
    return res.json({ items: rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error';
    return res.status(500).json({ error: 'users_failed', message });
  }
});

usersRouter.get('/:userId/refund-quote', async (req, res) => {
  try {
    const userId = req.params.userId;
    if (!/^\d+$/.test(userId)) {
      return res.status(400).json({ error: 'invalid_user_id' });
    }

    const quote = await buildRefundQuote(userId);
    if (!quote.user) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    return res.json({
      user: {
        id: quote.user.id,
        email: quote.user.email,
        stripe_customer: quote.stripeCustomer,
        quota: quote.quota.toString(),
        used_quota: quote.usedQuota.toString()
      },
      balance: {
        remaining_yuan: centsToYuanString(quote.remainingCentsByQuota),
        used_yuan: centsToYuanString(quotaToCentsFloor(quote.usedQuota)),
        total_yuan: centsToYuanString(quotaToCentsFloor(quote.quota + quote.usedQuota))
      },
      amounts: {
        yipay_paid_yuan: centsToYuanString(quote.yipayPaidCents),
        yipay_refunded_yuan: centsToYuanString(quote.yipayRefundedCents),
        yipay_net_paid_yuan: centsToYuanString(quote.yipayNetPaidCents),
        stripe_net_paid_yuan: centsToYuanString(quote.stripeNetPaidCents),
        total_net_paid_yuan: centsToYuanString(quote.totalNetPaidCents)
      },
      refund: {
        due_yuan: centsToYuanString(quote.dueCents),
        due_cents: quote.dueCents.toString(),
        plan: {
          stripe_yuan: centsToYuanString(quote.plan.stripeCents),
          stripe_cents: quote.plan.stripeCents.toString(),
          yipay_yuan: centsToYuanString(quote.plan.yipayCents),
          yipay_cents: quote.plan.yipayCents.toString()
        }
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error';
    return res.status(500).json({ error: 'quote_failed', message });
  }
});

usersRouter.post('/:userId/refund', async (req, res) => {
  try {
    if (!req.admin) {
      return res.status(500).json({ error: 'missing_admin_context' });
    }

    const performedBy = isUuid(req.admin.userId) ? req.admin.userId : undefined;

    const userId = req.params.userId;
    if (!/^\d+$/.test(userId)) {
      return res.status(400).json({ error: 'invalid_user_id' });
    }

    const BodySchema = z.object({
      amount_yuan: z.string().optional(),
      fee_percent: z.union([z.string(), z.number()]).optional(),
      min_refund_yuan: z.string().optional(),
      max_refund_yuan: z.string().optional(),
      clear_balance: z.boolean().optional().default(false),
      dry_run: z.boolean().optional().default(false)
    });
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    }

    const quote = await buildRefundQuote(userId);
    if (!quote.user) {
      return res.status(404).json({ error: 'user_not_found' });
    }

    const feeBps = (() => {
      try {
        return parseFeePercentToBps(parsed.data.fee_percent, DEFAULT_FEE_BPS);
      } catch {
        return null;
      }
    })();
    if (feeBps === null) {
      return res.status(400).json({ error: 'invalid_fee_percent' });
    }

    let requestedCents: bigint | null = null;
    let grossCents = quote.dueCents;
    if (parsed.data.amount_yuan) {
      try {
        requestedCents = yuanStringToCents(parsed.data.amount_yuan);
      } catch {
        return res.status(400).json({ error: 'invalid_amount' });
      }
      if (requestedCents <= 0n) {
        return res.status(400).json({ error: 'invalid_amount' });
      }
      grossCents = requestedCents > quote.dueCents ? quote.dueCents : requestedCents;
    }

    if (grossCents <= 0n) {
      return res.status(409).json({ error: 'nothing_to_refund' });
    }

    const { feeCents, netCents } = applyFeeToCents(grossCents, feeBps);
    if (netCents <= 0n) {
      return res.status(400).json({ error: 'fee_too_high' });
    }

    const parseOptionalYuanToCents = (input: string | undefined) => {
      const trimmed = (input ?? '').trim();
      if (!trimmed) return null;
      const cents = yuanStringToCents(trimmed);
      if (cents < 0n) {
        throw new Error('negative_amount');
      }
      return cents;
    };

    let minRefundCents: bigint | null = null;
    let maxRefundCents: bigint | null = null;
    try {
      minRefundCents = parseOptionalYuanToCents(parsed.data.min_refund_yuan);
    } catch {
      return res.status(400).json({ error: 'invalid_min_refund_amount' });
    }
    try {
      maxRefundCents = parseOptionalYuanToCents(parsed.data.max_refund_yuan);
    } catch {
      return res.status(400).json({ error: 'invalid_max_refund_amount' });
    }

    if (minRefundCents !== null && maxRefundCents !== null && minRefundCents > maxRefundCents) {
      return res.status(400).json({ error: 'invalid_refund_amount_range' });
    }

    if (
      (minRefundCents !== null && netCents < minRefundCents) ||
      (maxRefundCents !== null && netCents > maxRefundCents)
    ) {
      const rangeDesc = (() => {
        if (minRefundCents !== null && maxRefundCents !== null) {
          return `[${centsToYuanString(minRefundCents)}, ${centsToYuanString(maxRefundCents)}]`;
        }
        if (minRefundCents !== null) {
          return `>= ${centsToYuanString(minRefundCents)}`;
        }
        return `<= ${centsToYuanString(maxRefundCents ?? 0n)}`;
      })();
      return res.status(409).json({
        error: 'refund_amount_out_of_range',
        message: `refund_amount_out_of_range: 实际退款 ${centsToYuanString(netCents)} 不在限制范围 ${rangeDesc}`
      });
    }

    if (parsed.data.dry_run) {
      return res.json({
        ok: true,
        dry_run: true,
        refund_yuan: centsToYuanString(netCents),
        refund_gross_yuan: centsToYuanString(grossCents),
        refund_fee_yuan: centsToYuanString(feeCents),
        fee_bps: feeBps,
        clear_balance: parsed.data.clear_balance,
        plan: {
          stripe_yuan: centsToYuanString(netCents > quote.stripeNetPaidCents ? quote.stripeNetPaidCents : netCents),
          yipay_yuan: centsToYuanString(
            netCents > quote.stripeNetPaidCents ? netCents - quote.stripeNetPaidCents : 0n
          )
        }
      });
    }

    const sb = requireSupabase();
    const batchId = `userrefund_${userId}_${Date.now()}`;

    const targetQuotaDelta = parsed.data.clear_balance ? quote.quota : centsToQuota(grossCents);

    let remainingCents = netCents;
    let remainingQuotaDelta = targetQuotaDelta;
    const operations: Array<{ id: string; provider: string; amount_yuan: string; warning?: string }> = [];

    const calcTraceSteps: Array<{ i: number; name: string; detail: Record<string, unknown> }> = [];
    const addCalcStep = (name: string, detail: Record<string, unknown>) => {
      calcTraceSteps.push({ i: calcTraceSteps.length + 1, name, detail });
    };

    const computedAt = new Date().toISOString();
    const totalQuota = quote.quota + quote.usedQuota;
    const dueRawCents =
      quote.totalNetPaidCents > 0n && quote.quota > 0n && totalQuota > 0n
        ? (quote.totalNetPaidCents * quote.quota) / totalQuota
        : 0n;
    const dueClampedCents = (() => {
      if (dueRawCents <= 0n) return 0n;
      return dueRawCents > quote.totalNetPaidCents ? quote.totalNetPaidCents : dueRawCents;
    })();

    addCalcStep('input', {
      mysql_user_id: userId,
      amount_yuan: parsed.data.amount_yuan ?? null,
      fee_percent: parsed.data.fee_percent ?? null,
      min_refund_yuan: parsed.data.min_refund_yuan ?? null,
      max_refund_yuan: parsed.data.max_refund_yuan ?? null,
      clear_balance: parsed.data.clear_balance,
      dry_run: parsed.data.dry_run
    });
    addCalcStep('quote.user', {
      user_id: quote.user.id,
      email: quote.user.email ?? null,
      stripe_customer: quote.stripeCustomer || null
    });
    addCalcStep('quote.quota', {
      quota: quote.quota.toString(),
      used_quota: quote.usedQuota.toString(),
      total_quota: totalQuota.toString(),
      remaining_cents_by_quota: quote.remainingCentsByQuota.toString(),
      remaining_yuan_by_quota: centsToYuanString(quote.remainingCentsByQuota)
    });
    addCalcStep('quote.yipay', {
      paid_cents: quote.yipayPaidCents.toString(),
      refunded_cents: quote.yipayRefundedCents.toString(),
      net_paid_cents: quote.yipayNetPaidCents.toString(),
      refunded_by_topup: Array.from(quote.yipayRefundedByTopup.entries()).map(([tradeNo, cents]) => ({
        topup_trade_no: tradeNo,
        refunded_cents: cents.toString()
      }))
    });
    addCalcStep('quote.stripe', {
      stripe_customer: quote.stripeCustomer || null,
      currency: quote.stripeCurrency,
      net_paid_cents: quote.stripeNetPaidCents.toString(),
      refundable_charges: quote.stripeRefundableCharges.map((c) => ({
        id: c.id,
        created: c.created,
        payment_intent: c.payment_intent,
        currency: c.currency,
        remaining_cents: c.remaining_cents.toString()
      }))
    });
    addCalcStep('quote.due', {
      formula: 'floor(P * R / T)',
      P_total_net_paid_cents: quote.totalNetPaidCents.toString(),
      R_quota: quote.quota.toString(),
      T_total_quota: totalQuota.toString(),
      due_raw_cents: dueRawCents.toString(),
      due_clamped_cents: dueClampedCents.toString(),
      due_final_cents: quote.dueCents.toString(),
      due_final_yuan: centsToYuanString(quote.dueCents),
      due_plan: {
        stripe_cents: quote.plan.stripeCents.toString(),
        yipay_cents: quote.plan.yipayCents.toString()
      }
    });
    addCalcStep('amount.override', {
      requested_yuan: parsed.data.amount_yuan ?? null,
      requested_cents: requestedCents?.toString() ?? null,
      gross_cents: grossCents.toString(),
      gross_yuan: centsToYuanString(grossCents)
    });
    addCalcStep('fee', {
      fee_percent: parsed.data.fee_percent ?? null,
      fee_bps: feeBps,
      fee_cents: feeCents.toString(),
      fee_yuan: centsToYuanString(feeCents),
      net_cents: netCents.toString(),
      net_yuan: centsToYuanString(netCents)
    });
    addCalcStep('quota_delta', {
      clear_balance: parsed.data.clear_balance,
      rule: parsed.data.clear_balance ? 'clear_balance => quota' : 'gross_cents * QUOTA_PER_CENT',
      target_quota_delta: targetQuotaDelta.toString(),
      quota_per_cent: '5000'
    });
    addCalcStep('execution.init', {
      remaining_cents: remainingCents.toString(),
      remaining_quota_delta: remainingQuotaDelta.toString()
    });

    const calcTraceBase = {
      version: 1,
      computed_at: computedAt,
      batch_id: batchId,
      mysql_user_id: userId,
      steps: calcTraceSteps,
      summary: {
        due_cents: quote.dueCents.toString(),
        gross_cents: grossCents.toString(),
        fee_bps: feeBps,
        fee_cents: feeCents.toString(),
        net_cents: netCents.toString(),
        target_quota_delta: targetQuotaDelta.toString()
      }
    };

    const allocateQuotaDelta = (amountCents: bigint) => {
      if (amountCents <= 0n) return 0n;
      if (amountCents >= remainingCents) return remainingQuotaDelta;
      if (remainingCents <= 0n) return 0n;
      return (remainingQuotaDelta * amountCents) / remainingCents;
    };

    const reserveQuota = async (deltaQuota: bigint) => {
      const [result] = await mysqlPool.execute(
        `update users set quota = quota - ? where id = ? and quota >= ?`,
        [deltaQuota.toString(), userId, deltaQuota.toString()]
      );
      const affected = (result as any).affectedRows ?? 0;
      if (affected !== 1) {
        throw new Error('insufficient_user_quota');
      }
    };

    const releaseQuota = async (deltaQuota: bigint) => {
      await mysqlPool.execute(`update users set quota = quota + ? where id = ?`, [deltaQuota.toString(), userId]);
    };

    const insertRefundLog = async (row: Record<string, unknown>) => {
      const { data, error } = await sb.from('refunds').insert(row).select('id').single();
      if (error) {
        throw new Error(`refund_log_insert_failed:${error.message}`);
      }
      return String((data as any).id);
    };

    const updateRefundLog = async (id: string, patch: Record<string, unknown>) => {
      const { error } = await sb.from('refunds').update(patch).eq('id', id);
      if (error) {
        throw new Error(`refund_log_update_failed:${error.message}`);
      }
    };

    // 1) Stripe first
    if (remainingCents > 0n && quote.stripeCustomer && stripeClient && quote.stripeRefundableCharges.length) {
      for (const charge of quote.stripeRefundableCharges) {
        if (remainingCents <= 0n) break;
        const refundable = charge.remaining_cents;
        if (refundable <= 0n) continue;
        const amountCents = remainingCents > refundable ? refundable : remainingCents;
        const deltaQuota = allocateQuotaDelta(amountCents);
        const outRefundNo = `sr_${batchId}_${charge.id}_${amountCents}`;

        const opTrace = {
          provider: 'stripe',
          stripe_charge_id: charge.id,
          stripe_payment_intent_id: charge.payment_intent ?? null,
          amount_cents: amountCents.toString(),
          amount_yuan: centsToYuanString(amountCents),
          remaining_cents_before: remainingCents.toString(),
          remaining_quota_delta_before: remainingQuotaDelta.toString(),
          quota_delta: deltaQuota.toString(),
          remaining_cents_after_expected: (remainingCents - amountCents).toString(),
          remaining_quota_delta_after_expected: (remainingQuotaDelta - deltaQuota).toString()
        };

        if (deltaQuota > 0n) {
          await reserveQuota(deltaQuota);
        }
        let logId: string | null = null;
        let providerSucceeded = false;
        try {
          logId = await insertRefundLog({
            mysql_user_id: userId,
            stripe_charge_id: charge.id,
            stripe_payment_intent_id: charge.payment_intent,
            payment_method: 'stripe',
            currency: charge.currency,
            refund_money: centsToYuanString(amountCents),
            refund_money_minor: amountCents.toString(),
            quota_delta: deltaQuota.toString(),
            provider: 'stripe',
            out_refund_no: outRefundNo,
            status: 'pending',
            performed_by: performedBy,
            raw_request: {
              batchId,
              clear_balance: parsed.data.clear_balance,
              fee_percent: parsed.data.fee_percent,
              fee_bps: feeBps,
              refund_gross_cents_total: grossCents.toString(),
              refund_fee_cents_total: feeCents.toString(),
              refund_net_cents_total: netCents.toString(),
              calc_trace: {
                ...calcTraceBase,
                operation: opTrace
              },
              charge_id: charge.id,
              amount_cents: amountCents.toString()
            }
          });

          const refund = await stripeRefund({
            chargeId: charge.id,
            amountMinor: toSafeNumber(amountCents),
            idempotencyKey: outRefundNo
          });

          providerSucceeded = true;

          let warning: string | undefined;
          try {
            await updateRefundLog(logId, {
              status: 'succeeded',
              executed_at: new Date().toISOString(),
              provider_refund_no: refund.id,
              raw_response: refund
            });
          } catch (err) {
            warning = err instanceof Error ? err.message : 'refund_log_update_failed';
          }

          operations.push({
            id: logId,
            provider: 'stripe',
            amount_yuan: centsToYuanString(amountCents),
            ...(warning ? { warning } : {})
          });
          remainingCents -= amountCents;
          remainingQuotaDelta -= deltaQuota;
        } catch (err) {
          if (!providerSucceeded) {
            if (deltaQuota > 0n) {
              await releaseQuota(deltaQuota);
            }
          }
          const message = err instanceof Error ? err.message : 'unknown_error';
          if (logId && !providerSucceeded) {
            await updateRefundLog(logId, {
              status: 'failed',
              executed_at: new Date().toISOString(),
              error_message: message
            });
          }
          throw err;
        }
      }
    }

    // 2) Yipay fallback
    if (remainingCents > 0n) {
      const topups = await listUserYipayTopups(userId);
      const refundsForAccounting = await listRefundsForUserAccounting(userId);
      const refundedByTopup = new Map<string, bigint>();
      for (const r of refundsForAccounting) {
        if (r.provider !== 'yipay') continue;
        const tradeNo = r.topup_trade_no ? String(r.topup_trade_no) : '';
        if (!tradeNo) continue;
        const prev = refundedByTopup.get(tradeNo) ?? 0n;
        refundedByTopup.set(tradeNo, prev + asBigInt(r.refund_money_minor ?? 0, 'refund_money_minor'));
      }

      for (const topup of topups) {
        if (remainingCents <= 0n) break;
        const tradeNo = String(topup.trade_no);
        const topupCents = BigInt(Math.round(Number(topup.money) * 100));
        const already = refundedByTopup.get(tradeNo) ?? 0n;
        const refundable = topupCents > already ? topupCents - already : 0n;
        if (refundable <= 0n) continue;

        const amountCents = remainingCents > refundable ? refundable : remainingCents;
        const deltaQuota = allocateQuotaDelta(amountCents);
        const outRefundNo = `yr_${batchId}_${tradeNo}_${amountCents}`;

        const opTrace = {
          provider: 'yipay',
          topup_trade_no: tradeNo,
          topup_cents: topupCents.toString(),
          already_refunded_cents: already.toString(),
          refundable_cents: refundable.toString(),
          amount_cents: amountCents.toString(),
          amount_yuan: centsToYuanString(amountCents),
          remaining_cents_before: remainingCents.toString(),
          remaining_quota_delta_before: remainingQuotaDelta.toString(),
          quota_delta: deltaQuota.toString(),
          remaining_cents_after_expected: (remainingCents - amountCents).toString(),
          remaining_quota_delta_after_expected: (remainingQuotaDelta - deltaQuota).toString()
        };

        if (deltaQuota > 0n) {
          await reserveQuota(deltaQuota);
        }
        let logId: string | null = null;
        let providerSucceeded = false;
        try {
          logId = await insertRefundLog({
            mysql_user_id: userId,
            topup_trade_no: tradeNo,
            payment_method: topup.payment_method,
            currency: 'cny',
            refund_money: centsToYuanString(amountCents),
            refund_money_minor: amountCents.toString(),
            quota_delta: deltaQuota.toString(),
            provider: 'yipay',
            out_refund_no: outRefundNo,
            status: 'pending',
            performed_by: performedBy,
            raw_request: {
              batchId,
              clear_balance: parsed.data.clear_balance,
              fee_percent: parsed.data.fee_percent,
              fee_bps: feeBps,
              refund_gross_cents_total: grossCents.toString(),
              refund_fee_cents_total: feeCents.toString(),
              refund_net_cents_total: netCents.toString(),
              calc_trace: {
                ...calcTraceBase,
                operation: opTrace
              },
              trade_no: tradeNo,
              amount_cents: amountCents.toString()
            }
          });

          const providerResult = await yipayRefund({
            orderNoField: 'out_trade_no',
            orderNo: tradeNo,
            money: centsToYuanString(amountCents),
            outRefundNo,
            timestamp: Math.floor(Date.now() / 1000)
          });

          providerSucceeded = true;

          let warning: string | undefined;
          try {
            await updateRefundLog(logId, {
              status: 'succeeded',
              executed_at: new Date().toISOString(),
              provider_refund_no: providerResult.response?.refund_no,
              raw_response: providerResult
            });
          } catch (err) {
            warning = err instanceof Error ? err.message : 'refund_log_update_failed';
          }

          operations.push({
            id: logId,
            provider: 'yipay',
            amount_yuan: centsToYuanString(amountCents),
            ...(warning ? { warning } : {})
          });
          remainingCents -= amountCents;
          remainingQuotaDelta -= deltaQuota;
          refundedByTopup.set(tradeNo, already + amountCents);

          const nowRefunded = refundedByTopup.get(tradeNo) ?? 0n;
          if (nowRefunded >= topupCents && topup.status !== 'refund') {
            await mysqlPool.execute(`update top_ups set status = 'refund' where trade_no = ?`, [tradeNo]);
          }
        } catch (err) {
          if (!providerSucceeded) {
            if (deltaQuota > 0n) {
              await releaseQuota(deltaQuota);
            }
          }
          const message = err instanceof Error ? err.message : 'unknown_error';
          if (logId && !providerSucceeded) {
            await updateRefundLog(logId, {
              status: 'failed',
              executed_at: new Date().toISOString(),
              error_message: message
            });
          }
          throw err;
        }
      }
    }

    if (remainingCents > 0n) {
      return res.status(500).json({
        error: 'refund_incomplete',
        refunded_yuan: centsToYuanString(netCents - remainingCents),
        remaining_yuan: centsToYuanString(remainingCents),
        operations
      });
    }

    return res.json({
      ok: true,
      refunded_yuan: centsToYuanString(netCents),
      refund_gross_yuan: centsToYuanString(grossCents),
      refund_fee_yuan: centsToYuanString(feeCents),
      fee_bps: feeBps,
      operations
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error';
    return res.status(500).json({ error: 'refund_failed', message });
  }
});
