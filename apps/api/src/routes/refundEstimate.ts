import { Router } from 'express';
import { z } from 'zod';
import { mysqlPool } from '../mysql.js';
import { supabaseAdmin } from '../supabase.js';
import { listCustomerCharges, stripeClient } from '../providers/stripe.js';
import { asBigInt, centsToYuanString } from '../utils/quota.js';

type RefundEstimateResult = {
  computed_at: string;
  duration_ms: number;
  totals: {
    total_yuan: string;
    total_cents: string;
    stripe_yuan: string;
    stripe_cents: string;
    yipay_yuan: string;
    yipay_cents: string;
  };
  counts: {
    users_total: number;
    paying_users: number;
    refundable_users: number;
    users_with_stripe_customer: number;
    stripe_customers_total: number;
    stripe_customers_processed: number;
    stripe_customers_failed: number;
    stripe_customers_multi_currency: number;
    stripe_customers_non_cny: number;
  };
};

type RefundEstimateState = {
  status: 'idle' | 'running' | 'ready' | 'error';
  started_at?: string;
  computed_at?: string;
  duration_ms?: number;
  progress?: {
    phase: 'loading' | 'stripe' | 'finalizing';
    users_total: number;
    stripe_customers_total: number;
    stripe_customers_done: number;
    stripe_customers_failed: number;
    stripe_customers_multi_currency: number;
    stripe_customers_non_cny: number;
  };
  result?: RefundEstimateResult;
  last_result?: RefundEstimateResult;
  error?: string;
};

let state: RefundEstimateState = { status: 'idle' };

const nowIso = () => new Date().toISOString();

const asyncPool = async <T>(
  concurrency: number,
  items: T[],
  iterator: (item: T, index: number) => Promise<void>
) => {
  const workers = Array.from({ length: Math.max(1, concurrency) }, async (_v, workerIndex) => {
    for (let index = workerIndex; index < items.length; index += concurrency) {
      await iterator(items[index], index);
    }
  });
  await Promise.all(workers);
};

const computeRefundEstimate = async (): Promise<RefundEstimateResult> => {
  if (!supabaseAdmin) {
    throw new Error('server_missing_supabase');
  }

  const startedAtMs = Date.now();

  // 1) Load users
  const [userRows] = await mysqlPool.query(`select id, quota, used_quota, stripe_customer from users`);
  const users = (Array.isArray(userRows) ? userRows : []) as any[];
  if (state.status === 'running' && state.progress) {
    state.progress.phase = 'loading';
    state.progress.users_total = users.length;
  }

  // 2) Yipay paid cents by user
  const [yipayPaidRows] = await mysqlPool.query(
    `
      select
        user_id,
        coalesce(sum(cast(round(money * 100) as signed)), 0) as total_cents
      from top_ups
      where payment_method in ('alipay', 'wxpay')
        and status in ('success', 'refund')
      group by user_id
    `
  );
  const yipayPaidByUser = new Map<string, bigint>();
  for (const row of (Array.isArray(yipayPaidRows) ? yipayPaidRows : []) as any[]) {
    const userId = String(row.user_id);
    const cents = asBigInt(row.total_cents ?? 0, 'yipay_total_cents');
    if (cents > 0n) {
      yipayPaidByUser.set(userId, cents);
    }
  }

  // 3) Yipay refunded cents by user (pending+succeeded)
  const yipayRefundedByUser = new Map<string, bigint>();
  {
    const pageSize = 1000;
    let from = 0;
    for (;;) {
      const { data, error } = await supabaseAdmin
        .from('refunds')
        .select('mysql_user_id, refund_money_minor, provider, status')
        .eq('provider', 'yipay')
        .in('status', ['pending', 'succeeded'])
        .order('created_at', { ascending: true })
        .range(from, from + pageSize - 1);

      if (error) {
        throw new Error(`supabase_error:${error.message}`);
      }

      const rows = data ?? [];
      for (const r of rows as any[]) {
        const userId = String(r.mysql_user_id ?? '');
        if (!userId) continue;
        const cents = asBigInt(r.refund_money_minor ?? 0, 'refund_money_minor');
        if (cents <= 0n) continue;
        const prev = yipayRefundedByUser.get(userId) ?? 0n;
        yipayRefundedByUser.set(userId, prev + cents);
      }

      if (rows.length < pageSize) break;
      from += pageSize;
    }
  }

  // 4) Stripe net paid cents by customer (only currency=cny, single currency)
  const stripeCustomers = Array.from(
    new Set(
      users
        .map((u) => (u.stripe_customer ? String(u.stripe_customer).trim() : ''))
        .filter((v) => Boolean(v))
    )
  );

  if (state.status === 'running' && state.progress) {
    state.progress.phase = 'stripe';
    state.progress.stripe_customers_total = stripeCustomers.length;
    state.progress.stripe_customers_done = 0;
    state.progress.stripe_customers_failed = 0;
    state.progress.stripe_customers_multi_currency = 0;
    state.progress.stripe_customers_non_cny = 0;
  }

  const stripeNetPaidByCustomerCny = new Map<string, bigint>();
  let stripeCustomersFailed = 0;
  let stripeCustomersMultiCurrency = 0;
  let stripeCustomersNonCny = 0;

  if (stripeClient && stripeCustomers.length) {
    await asyncPool(5, stripeCustomers, async (customerId) => {
      try {
        const charges = await listCustomerCharges(customerId);
        let currency: string | null = null;
        let net = 0n;
        for (const ch of charges) {
          if (!ch.paid) continue;
          if (ch.status !== 'succeeded') continue;
          if (!currency) currency = ch.currency;
          if (currency !== ch.currency) {
            currency = 'MULTI';
            break;
          }
          const remaining = BigInt(ch.amount - (ch.amount_refunded ?? 0));
          if (remaining > 0n) {
            net += remaining;
          }
        }

        if (currency === 'MULTI') {
          stripeCustomersMultiCurrency += 1;
          return;
        }

        const normalized = (currency ?? '').toLowerCase();
        if (normalized && normalized !== 'cny') {
          stripeCustomersNonCny += 1;
          return;
        }

        if (net > 0n) {
          stripeNetPaidByCustomerCny.set(customerId, net);
        }
      } catch {
        stripeCustomersFailed += 1;
      } finally {
        if (state.status === 'running' && state.progress) {
          state.progress.stripe_customers_done += 1;
          state.progress.stripe_customers_failed = stripeCustomersFailed;
          state.progress.stripe_customers_multi_currency = stripeCustomersMultiCurrency;
          state.progress.stripe_customers_non_cny = stripeCustomersNonCny;
        }
      }
    });
  }

  if (state.status === 'running' && state.progress) {
    state.progress.phase = 'finalizing';
  }

  // 5) Per-user due + plan
  let totalDueCents = 0n;
  let stripePlanCents = 0n;
  let yipayPlanCents = 0n;
  let payingUsers = 0;
  let refundableUsers = 0;

  for (const u of users) {
    const userId = String(u.id);
    const quota = asBigInt(u.quota ?? 0, 'quota');
    const usedQuota = asBigInt(u.used_quota ?? 0, 'used_quota');
    const totalQuota = quota + usedQuota;
    const yipayPaid = yipayPaidByUser.get(userId) ?? 0n;
    const yipayRefunded = yipayRefundedByUser.get(userId) ?? 0n;
    const yipayNet = yipayPaid > yipayRefunded ? yipayPaid - yipayRefunded : 0n;

    const customerId = u.stripe_customer ? String(u.stripe_customer).trim() : '';
    const stripeNet = customerId ? (stripeNetPaidByCustomerCny.get(customerId) ?? 0n) : 0n;

    const totalNetPaid = stripeNet + yipayNet;
    if (totalNetPaid > 0n) payingUsers += 1;

    let due = 0n;
    if (totalNetPaid > 0n && quota > 0n && totalQuota > 0n) {
      const raw = (totalNetPaid * quota) / totalQuota;
      due = raw > 0n ? (raw > totalNetPaid ? totalNetPaid : raw) : 0n;
    }
    if (due > 0n) refundableUsers += 1;

    const stripePart = due > stripeNet ? stripeNet : due;
    const yipayPart = due - stripePart;

    totalDueCents += due;
    stripePlanCents += stripePart;
    yipayPlanCents += yipayPart;
  }

  const durationMs = Date.now() - startedAtMs;

  return {
    computed_at: nowIso(),
    duration_ms: durationMs,
    totals: {
      total_yuan: centsToYuanString(totalDueCents),
      total_cents: totalDueCents.toString(),
      stripe_yuan: centsToYuanString(stripePlanCents),
      stripe_cents: stripePlanCents.toString(),
      yipay_yuan: centsToYuanString(yipayPlanCents),
      yipay_cents: yipayPlanCents.toString()
    },
    counts: {
      users_total: users.length,
      paying_users: payingUsers,
      refundable_users: refundableUsers,
      users_with_stripe_customer: users.filter((u) => Boolean(String(u.stripe_customer ?? '').trim())).length,
      stripe_customers_total: stripeCustomers.length,
      stripe_customers_processed: stripeClient ? stripeCustomers.length : 0,
      stripe_customers_failed: stripeCustomersFailed,
      stripe_customers_multi_currency: stripeCustomersMultiCurrency,
      stripe_customers_non_cny: stripeCustomersNonCny
    }
  };
};

const startEstimateJob = () => {
  if (state.status === 'running') return;

  const last = state.result ?? state.last_result;
  state = {
    status: 'running',
    started_at: nowIso(),
    progress: {
      phase: 'loading',
      users_total: 0,
      stripe_customers_total: 0,
      stripe_customers_done: 0,
      stripe_customers_failed: 0,
      stripe_customers_multi_currency: 0,
      stripe_customers_non_cny: 0
    },
    ...(last ? { last_result: last } : {})
  };

  void (async () => {
    try {
      const result = await computeRefundEstimate();
      state = {
        status: 'ready',
        result,
        computed_at: result.computed_at,
        duration_ms: result.duration_ms,
        last_result: result
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown_error';
      state = {
        status: 'error',
        error: message,
        last_result: last
      };
    }
  })();
};

export const refundEstimateRouter = Router();

refundEstimateRouter.get('/', async (req, res) => {
  const QuerySchema = z.object({
    autostart: z
      .union([z.literal('1'), z.literal('0')])
      .optional()
      .default('0')
      .transform((v) => v === '1')
  });
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_query', details: parsed.error.flatten() });
  }

  if (parsed.data.autostart) {
    startEstimateJob();
  }

  return res.json(state);
});

refundEstimateRouter.post('/recompute', async (_req, res) => {
  startEstimateJob();
  return res.json({ ok: true, status: state.status });
});
