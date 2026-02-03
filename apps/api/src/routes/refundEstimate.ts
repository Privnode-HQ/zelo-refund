import { Router } from 'express';
import { z } from 'zod';
import { mysqlPool } from '../mysql.js';
import { supabaseAdmin } from '../supabase.js';
import { listCustomerCharges, stripeClient } from '../providers/stripe.js';
import { asBigInt, centsToQuota, centsToYuanString } from '../utils/quota.js';
import { computeRefundDueV2, withSyntheticGiftPoolOrder } from '../utils/refundAlgo.js';

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

type RefundEstimateUsersResult = {
  computed_at: string;
  duration_ms: number;
  input: {
    user_ids_requested: number;
    user_ids_valid: number;
    user_ids_invalid: string[];
    users_found: number;
    users_not_found: number;
    user_ids_not_found: string[];
  };
  totals: RefundEstimateResult['totals'];
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
  items: Array<{
    user_id: string;
    due_yuan: string;
    due_cents: string;
    plan: {
      stripe_yuan: string;
      stripe_cents: string;
      yipay_yuan: string;
      yipay_cents: string;
    };
    warning?: string;
  }>;
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

type YipayTopupAlgoRow = {
  user_id: string | number;
  trade_no: string;
  money_cents: string | number;
  amount_cents: string | number;
  created_ts: number;
};

type StripeTopupAlgoRow = {
  user_id: string | number;
  trade_no: string;
  amount_cents: string | number;
};

type StripeChargeAlgo = {
  id: string;
  created: number;
  currency: string;
  payment_intent?: string;
  amount_cents: bigint;
  refunded_cents: bigint;
  remaining_cents: bigint;
};

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

  // 2) Load top_ups for algo (yipay + stripe grants)
  const [yipayTopupRows] = await mysqlPool.query(
    `
      select
        user_id,
        trade_no,
        cast(round(money * 100) as signed) as money_cents,
        cast(round(amount * 100) as signed) as amount_cents,
        unix_timestamp(create_time) as created_ts
      from top_ups
      where payment_method in ('alipay', 'wxpay')
        and status in ('success', 'refund')
    `
  );
  const yipayTopupsByUser = new Map<string, YipayTopupAlgoRow[]>();
  for (const row of (Array.isArray(yipayTopupRows) ? yipayTopupRows : []) as any[]) {
    const userId = String(row.user_id ?? '');
    if (!userId) continue;
    const list = yipayTopupsByUser.get(userId) ?? [];
    list.push(row as YipayTopupAlgoRow);
    yipayTopupsByUser.set(userId, list);
  }

  const [stripeTopupRows] = await mysqlPool.query(
    `
      select user_id, trade_no, cast(round(amount * 100) as signed) as amount_cents
      from top_ups
      where payment_method = 'stripe'
        and status in ('success', 'refund')
    `
  );
  const stripeGrantByUserTradeNo = new Map<string, Map<string, bigint>>();
  for (const row of (Array.isArray(stripeTopupRows) ? stripeTopupRows : []) as any[]) {
    const userId = String(row.user_id ?? '');
    if (!userId) continue;
    const tradeNo = String(row.trade_no ?? '').trim();
    if (!tradeNo) continue;
    const amountCents = asBigInt(row.amount_cents ?? 0, 'amount_cents');
    if (amountCents <= 0n) continue;
    const perUser = stripeGrantByUserTradeNo.get(userId) ?? new Map<string, bigint>();
    perUser.set(tradeNo, centsToQuota(amountCents));
    stripeGrantByUserTradeNo.set(userId, perUser);
  }

  // 3) Refund adjustments (pending+succeeded): yipay cash/quota by topup, stripe quota by charge
  const yipayRefundedCashByTopup = new Map<string, bigint>();
  const yipayRefundedQuotaByTopup = new Map<string, bigint>();
  const stripeRefundedQuotaByCharge = new Map<string, bigint>();
  {
    const pageSize = 1000;
    let from = 0;
    for (;;) {
      const { data, error } = await supabaseAdmin
        .from('refunds')
        .select('provider, topup_trade_no, stripe_charge_id, refund_money_minor, quota_delta, status')
        .in('status', ['pending', 'succeeded'])
        .order('created_at', { ascending: true })
        .range(from, from + pageSize - 1);

      if (error) {
        throw new Error(`supabase_error:${error.message}`);
      }

      const rows = data ?? [];
      for (const r of rows as any[]) {
        const provider = String(r.provider ?? '');
        if (provider === 'yipay') {
          const tradeNo = r.topup_trade_no ? String(r.topup_trade_no) : '';
          if (!tradeNo) continue;
          const refundedCents = asBigInt(r.refund_money_minor ?? 0, 'refund_money_minor');
          if (refundedCents > 0n) {
            const prev = yipayRefundedCashByTopup.get(tradeNo) ?? 0n;
            yipayRefundedCashByTopup.set(tradeNo, prev + refundedCents);
          }
          const deltaQuota = asBigInt(r.quota_delta ?? 0, 'quota_delta');
          if (deltaQuota > 0n) {
            const prev = yipayRefundedQuotaByTopup.get(tradeNo) ?? 0n;
            yipayRefundedQuotaByTopup.set(tradeNo, prev + deltaQuota);
          }
        }

        if (provider === 'stripe') {
          const chargeId = r.stripe_charge_id ? String(r.stripe_charge_id) : '';
          if (!chargeId) continue;
          const deltaQuota = asBigInt(r.quota_delta ?? 0, 'quota_delta');
          if (deltaQuota > 0n) {
            const prev = stripeRefundedQuotaByCharge.get(chargeId) ?? 0n;
            stripeRefundedQuotaByCharge.set(chargeId, prev + deltaQuota);
          }
        }
      }

      if (rows.length < pageSize) break;
      from += pageSize;
    }
  }

  // 4) Stripe charges by customer (only currency=cny, single currency)
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
  const stripeChargesByCustomerCny = new Map<string, StripeChargeAlgo[]>();
  let stripeCustomersFailed = 0;
  let stripeCustomersMultiCurrency = 0;
  let stripeCustomersNonCny = 0;

  if (stripeClient && stripeCustomers.length) {
    await asyncPool(5, stripeCustomers, async (customerId) => {
      try {
        const charges = await listCustomerCharges(customerId);
        let currency: string | null = null;
        let net = 0n;
        const items: StripeChargeAlgo[] = [];
        for (const ch of charges) {
          if (!ch.paid) continue;
          if (ch.status !== 'succeeded') continue;
          if (!currency) currency = ch.currency;
          if (currency !== ch.currency) {
            currency = 'MULTI';
            break;
          }
          const amountCents = BigInt(ch.amount);
          const refundedCents = BigInt(ch.amount_refunded ?? 0);
          const remaining = amountCents > refundedCents ? amountCents - refundedCents : 0n;
          if (remaining > 0n) {
            net += remaining;
          }
          items.push({
            id: ch.id,
            created: ch.created,
            currency: ch.currency,
            payment_intent: typeof ch.payment_intent === 'string' ? ch.payment_intent : undefined,
            amount_cents: amountCents,
            refunded_cents: refundedCents,
            remaining_cents: remaining
          });
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
        if (items.length) {
          stripeChargesByCustomerCny.set(customerId, items);
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
    const customerId = u.stripe_customer ? String(u.stripe_customer).trim() : '';
    const stripeNet = customerId ? (stripeNetPaidByCustomerCny.get(customerId) ?? 0n) : 0n;
    const stripeCharges = customerId ? (stripeChargesByCustomerCny.get(customerId) ?? []) : [];

    const yipayTopups = yipayTopupsByUser.get(userId) ?? [];
    let yipayNet = 0n;

    const perUserStripeGrant = stripeGrantByUserTradeNo.get(userId);

    const orders = [
      ...yipayTopups.map((t) => {
        const tradeNo = String(t.trade_no ?? '').trim();
        const moneyCentsRaw = asBigInt(t.money_cents ?? 0, 'money_cents');
        const refundedCents = yipayRefundedCashByTopup.get(tradeNo) ?? 0n;
        const paidCents = moneyCentsRaw > refundedCents ? moneyCentsRaw - refundedCents : 0n;
        yipayNet += paidCents;

        const amountCents = asBigInt(t.amount_cents ?? 0, 'amount_cents');
        const grantOriginal = amountCents > 0n ? centsToQuota(amountCents) : centsToQuota(moneyCentsRaw);
        const refundedQuota = yipayRefundedQuotaByTopup.get(tradeNo) ?? 0n;
        const grantQuota = grantOriginal > refundedQuota ? grantOriginal - refundedQuota : 0n;

        return {
          id: `yipay:${tradeNo}`,
          paid_cents: paidCents,
          grant_quota: grantQuota,
          created_at: Number(t.created_ts ?? 0)
        };
      }),
      ...stripeCharges.map((c) => {
        const originalGrant =
          perUserStripeGrant?.get(c.id) ??
          (c.payment_intent ? perUserStripeGrant?.get(c.payment_intent) : undefined) ??
          centsToQuota(c.amount_cents);

        const refundedQuota = stripeRefundedQuotaByCharge.get(c.id) ?? 0n;
        const grantQuota = originalGrant > refundedQuota ? originalGrant - refundedQuota : 0n;
        return {
          id: `stripe:${c.id}`,
          paid_cents: c.remaining_cents,
          grant_quota: grantQuota,
          created_at: c.created
        };
      })
    ].filter((o) => o.paid_cents > 0n || o.grant_quota > 0n);

    const totalNetPaid = stripeNet + yipayNet;
    if (totalNetPaid > 0n) payingUsers += 1;

    const { orders: ordersWithGiftPool } = withSyntheticGiftPoolOrder(orders, quota + usedQuota);
    const algo = computeRefundDueV2(ordersWithGiftPool, usedQuota);
    let due = algo.due_cents;
    if (due > totalNetPaid) due = totalNetPaid;
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

const parseUserIdsText = (input: string) =>
  input
    .split(/[\n\r,，]+/g)
    .map((s) => s.trim())
    .filter(Boolean);

const normalizeUserIds = (userIds: string[]) => {
  const normalized: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const raw of userIds) {
    const value = String(raw).trim();
    if (!value) continue;
    if (!/^\d+$/.test(value)) {
      invalid.push(value);
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }

  return { userIds: normalized, invalid };
};

const fetchYipayRefundedByUser = async (userIds: string[]) => {
  if (!supabaseAdmin) {
    throw new Error('server_missing_supabase');
  }

  const refundedByUser = new Map<string, bigint>();

  const chunkSize = 100;
  const pageSize = 1000;

  for (let offset = 0; offset < userIds.length; offset += chunkSize) {
    const chunk = userIds.slice(offset, offset + chunkSize);
    if (!chunk.length) continue;

    let from = 0;
    for (;;) {
      const { data, error } = await supabaseAdmin
        .from('refunds')
        .select('mysql_user_id, refund_money_minor, provider, status')
        .eq('provider', 'yipay')
        .in('status', ['pending', 'succeeded'])
        .in('mysql_user_id', chunk)
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
        const prev = refundedByUser.get(userId) ?? 0n;
        refundedByUser.set(userId, prev + cents);
      }

      if (rows.length < pageSize) break;
      from += pageSize;
    }
  }

  return refundedByUser;
};

const fetchRefundAdjustmentsForUsers = async (userIds: string[]) => {
  if (!supabaseAdmin) {
    throw new Error('server_missing_supabase');
  }

  const yipayRefundedCashByTopup = new Map<string, bigint>();
  const yipayRefundedQuotaByTopup = new Map<string, bigint>();
  const stripeRefundedQuotaByCharge = new Map<string, bigint>();

  const chunkSize = 100;
  const pageSize = 1000;

  for (let offset = 0; offset < userIds.length; offset += chunkSize) {
    const chunk = userIds.slice(offset, offset + chunkSize);
    if (!chunk.length) continue;

    let from = 0;
    for (;;) {
      const { data, error } = await supabaseAdmin
        .from('refunds')
        .select('provider, topup_trade_no, stripe_charge_id, refund_money_minor, quota_delta, status, mysql_user_id')
        .in('provider', ['yipay', 'stripe'])
        .in('status', ['pending', 'succeeded'])
        .in('mysql_user_id', chunk)
        .order('created_at', { ascending: true })
        .range(from, from + pageSize - 1);

      if (error) {
        throw new Error(`supabase_error:${error.message}`);
      }

      const rows = data ?? [];
      for (const r of rows as any[]) {
        const provider = String(r.provider ?? '');
        if (provider === 'yipay') {
          const tradeNo = r.topup_trade_no ? String(r.topup_trade_no) : '';
          if (!tradeNo) continue;
          const refundedCents = asBigInt(r.refund_money_minor ?? 0, 'refund_money_minor');
          if (refundedCents > 0n) {
            const prev = yipayRefundedCashByTopup.get(tradeNo) ?? 0n;
            yipayRefundedCashByTopup.set(tradeNo, prev + refundedCents);
          }
          const deltaQuota = asBigInt(r.quota_delta ?? 0, 'quota_delta');
          if (deltaQuota > 0n) {
            const prev = yipayRefundedQuotaByTopup.get(tradeNo) ?? 0n;
            yipayRefundedQuotaByTopup.set(tradeNo, prev + deltaQuota);
          }
        }

        if (provider === 'stripe') {
          const chargeId = r.stripe_charge_id ? String(r.stripe_charge_id) : '';
          if (!chargeId) continue;
          const deltaQuota = asBigInt(r.quota_delta ?? 0, 'quota_delta');
          if (deltaQuota > 0n) {
            const prev = stripeRefundedQuotaByCharge.get(chargeId) ?? 0n;
            stripeRefundedQuotaByCharge.set(chargeId, prev + deltaQuota);
          }
        }
      }

      if (rows.length < pageSize) break;
      from += pageSize;
    }
  }

  return {
    yipayRefundedCashByTopup,
    yipayRefundedQuotaByTopup,
    stripeRefundedQuotaByCharge
  };
};

const computeRefundEstimateForUsers = async (requestedUserIds: string[]): Promise<RefundEstimateUsersResult> => {
  const startedAtMs = Date.now();

  const { userIds, invalid } = normalizeUserIds(requestedUserIds);
  if (!userIds.length) {
    throw new Error('invalid_user_ids');
  }

  const MAX_USERS = 1500;
  if (userIds.length > MAX_USERS) {
    throw new Error(`too_many_user_ids:${MAX_USERS}`);
  }

  const [userRows] = await mysqlPool.query(
    `select id, quota, used_quota, stripe_customer from users where id in (?)`,
    [userIds]
  );
  const users = (Array.isArray(userRows) ? userRows : []) as any[];
  const foundIds = new Set(users.map((u) => String(u.id)));
  const notFoundIds = userIds.filter((id) => !foundIds.has(id));

  // Load top_ups for algo (yipay + stripe grants)
  const [yipayTopupRows] = await mysqlPool.query(
    `
      select
        user_id,
        trade_no,
        cast(round(money * 100) as signed) as money_cents,
        cast(round(amount * 100) as signed) as amount_cents,
        unix_timestamp(create_time) as created_ts
      from top_ups
      where user_id in (?)
        and payment_method in ('alipay', 'wxpay')
        and status in ('success', 'refund')
    `,
    [userIds]
  );
  const yipayTopupsByUser = new Map<string, YipayTopupAlgoRow[]>();
  for (const row of (Array.isArray(yipayTopupRows) ? yipayTopupRows : []) as any[]) {
    const userId = String(row.user_id ?? '');
    if (!userId) continue;
    const list = yipayTopupsByUser.get(userId) ?? [];
    list.push(row as YipayTopupAlgoRow);
    yipayTopupsByUser.set(userId, list);
  }

  const [stripeTopupRows] = await mysqlPool.query(
    `
      select user_id, trade_no, cast(round(amount * 100) as signed) as amount_cents
      from top_ups
      where user_id in (?)
        and payment_method = 'stripe'
        and status in ('success', 'refund')
    `,
    [userIds]
  );
  const stripeGrantByUserTradeNo = new Map<string, Map<string, bigint>>();
  for (const row of (Array.isArray(stripeTopupRows) ? stripeTopupRows : []) as any[]) {
    const userId = String(row.user_id ?? '');
    if (!userId) continue;
    const tradeNo = String(row.trade_no ?? '').trim();
    if (!tradeNo) continue;
    const amountCents = asBigInt(row.amount_cents ?? 0, 'amount_cents');
    if (amountCents <= 0n) continue;
    const perUser = stripeGrantByUserTradeNo.get(userId) ?? new Map<string, bigint>();
    perUser.set(tradeNo, centsToQuota(amountCents));
    stripeGrantByUserTradeNo.set(userId, perUser);
  }

  const { yipayRefundedCashByTopup, yipayRefundedQuotaByTopup, stripeRefundedQuotaByCharge } =
    await fetchRefundAdjustmentsForUsers(userIds);

  // Stripe net paid cents by customer (only currency=cny, single currency)
  const stripeCustomers = Array.from(
    new Set(
      users
        .map((u) => (u.stripe_customer ? String(u.stripe_customer).trim() : ''))
        .filter((v) => Boolean(v))
    )
  );

  const stripeNetPaidByCustomerCny = new Map<string, bigint>();
  const stripeChargesByCustomerCny = new Map<string, StripeChargeAlgo[]>();
  const stripeCustomerStatus = new Map<string, { status: 'ok' | 'failed' | 'multi_currency' | 'non_cny' }>();
  let stripeCustomersFailed = 0;
  let stripeCustomersMultiCurrency = 0;
  let stripeCustomersNonCny = 0;

  if (stripeClient && stripeCustomers.length) {
    await asyncPool(5, stripeCustomers, async (customerId) => {
      try {
        const charges = await listCustomerCharges(customerId);
        let currency: string | null = null;
        let net = 0n;
        const items: StripeChargeAlgo[] = [];
        for (const ch of charges) {
          if (!ch.paid) continue;
          if (ch.status !== 'succeeded') continue;
          if (!currency) currency = ch.currency;
          if (currency !== ch.currency) {
            currency = 'MULTI';
            break;
          }
          const amountCents = BigInt(ch.amount);
          const refundedCents = BigInt(ch.amount_refunded ?? 0);
          const remaining = amountCents > refundedCents ? amountCents - refundedCents : 0n;
          if (remaining > 0n) {
            net += remaining;
          }
          items.push({
            id: ch.id,
            created: ch.created,
            currency: ch.currency,
            payment_intent: typeof ch.payment_intent === 'string' ? ch.payment_intent : undefined,
            amount_cents: amountCents,
            refunded_cents: refundedCents,
            remaining_cents: remaining
          });
        }

        if (currency === 'MULTI') {
          stripeCustomersMultiCurrency += 1;
          stripeCustomerStatus.set(customerId, { status: 'multi_currency' });
          return;
        }

        const normalizedCurrency = (currency ?? '').toLowerCase();
        if (normalizedCurrency && normalizedCurrency !== 'cny') {
          stripeCustomersNonCny += 1;
          stripeCustomerStatus.set(customerId, { status: 'non_cny' });
          return;
        }

        stripeCustomerStatus.set(customerId, { status: 'ok' });
        if (net > 0n) {
          stripeNetPaidByCustomerCny.set(customerId, net);
        }
        if (items.length) {
          stripeChargesByCustomerCny.set(customerId, items);
        }
      } catch {
        stripeCustomersFailed += 1;
        stripeCustomerStatus.set(customerId, { status: 'failed' });
      }
    });
  }

  // Per-user due + plan
  let totalDueCents = 0n;
  let stripePlanCents = 0n;
  let yipayPlanCents = 0n;
  let payingUsers = 0;
  let refundableUsers = 0;

  const userById = new Map<string, any>(users.map((u) => [String(u.id), u]));
  const usersWithStripeCustomer = users.filter((u) => Boolean(String(u.stripe_customer ?? '').trim())).length;

  const items: RefundEstimateUsersResult['items'] = [];

  for (const userId of userIds) {
    const u = userById.get(userId);
    if (!u) continue;

    const quota = asBigInt(u.quota ?? 0, 'quota');
    const usedQuota = asBigInt(u.used_quota ?? 0, 'used_quota');
    const customerId = u.stripe_customer ? String(u.stripe_customer).trim() : '';
    const stripeNet = customerId ? (stripeNetPaidByCustomerCny.get(customerId) ?? 0n) : 0n;
    const stripeCharges = customerId ? (stripeChargesByCustomerCny.get(customerId) ?? []) : [];

    const yipayTopups = yipayTopupsByUser.get(userId) ?? [];
    let yipayNet = 0n;

    const perUserStripeGrant = stripeGrantByUserTradeNo.get(userId);

    const orders = [
      ...yipayTopups.map((t) => {
        const tradeNo = String(t.trade_no ?? '').trim();
        const moneyCentsRaw = asBigInt(t.money_cents ?? 0, 'money_cents');
        const refundedCents = yipayRefundedCashByTopup.get(tradeNo) ?? 0n;
        const paidCents = moneyCentsRaw > refundedCents ? moneyCentsRaw - refundedCents : 0n;
        yipayNet += paidCents;

        const amountCents = asBigInt(t.amount_cents ?? 0, 'amount_cents');
        const grantOriginal = amountCents > 0n ? centsToQuota(amountCents) : centsToQuota(moneyCentsRaw);
        const refundedQuota = yipayRefundedQuotaByTopup.get(tradeNo) ?? 0n;
        const grantQuota = grantOriginal > refundedQuota ? grantOriginal - refundedQuota : 0n;

        return {
          id: `yipay:${tradeNo}`,
          paid_cents: paidCents,
          grant_quota: grantQuota,
          created_at: Number(t.created_ts ?? 0)
        };
      }),
      ...stripeCharges.map((c) => {
        const originalGrant =
          perUserStripeGrant?.get(c.id) ??
          (c.payment_intent ? perUserStripeGrant?.get(c.payment_intent) : undefined) ??
          centsToQuota(c.amount_cents);

        const refundedQuota = stripeRefundedQuotaByCharge.get(c.id) ?? 0n;
        const grantQuota = originalGrant > refundedQuota ? originalGrant - refundedQuota : 0n;
        return {
          id: `stripe:${c.id}`,
          paid_cents: c.remaining_cents,
          grant_quota: grantQuota,
          created_at: c.created
        };
      })
    ].filter((o) => o.paid_cents > 0n || o.grant_quota > 0n);

    const totalNetPaid = stripeNet + yipayNet;
    if (totalNetPaid > 0n) payingUsers += 1;

    const { orders: ordersWithGiftPool } = withSyntheticGiftPoolOrder(orders, quota + usedQuota);
    const algo = computeRefundDueV2(ordersWithGiftPool, usedQuota);
    let due = algo.due_cents;
    if (due > totalNetPaid) due = totalNetPaid;
    if (due > 0n) refundableUsers += 1;

    const stripePart = due > stripeNet ? stripeNet : due;
    const yipayPart = due - stripePart;

    totalDueCents += due;
    stripePlanCents += stripePart;
    yipayPlanCents += yipayPart;

    let warning: string | undefined;
    if (stripeClient && customerId) {
      const status = stripeCustomerStatus.get(customerId)?.status;
      if (status === 'failed') warning = 'Stripe Customer 拉取失败（该用户 Stripe 部分未计入测算）';
      if (status === 'multi_currency') warning = 'Stripe Customer 多币种（该用户 Stripe 部分未计入测算）';
      if (status === 'non_cny') warning = 'Stripe Customer 非 CNY（该用户 Stripe 部分未计入测算）';
    }

    items.push({
      user_id: userId,
      due_yuan: centsToYuanString(due),
      due_cents: due.toString(),
      plan: {
        stripe_yuan: centsToYuanString(stripePart),
        stripe_cents: stripePart.toString(),
        yipay_yuan: centsToYuanString(yipayPart),
        yipay_cents: yipayPart.toString()
      },
      ...(warning ? { warning } : {})
    });
  }

  const durationMs = Date.now() - startedAtMs;

  return {
    computed_at: nowIso(),
    duration_ms: durationMs,
    input: {
      user_ids_requested: requestedUserIds.length,
      user_ids_valid: userIds.length,
      user_ids_invalid: invalid,
      users_found: users.length,
      users_not_found: notFoundIds.length,
      user_ids_not_found: notFoundIds
    },
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
      users_with_stripe_customer: usersWithStripeCustomer,
      stripe_customers_total: stripeCustomers.length,
      stripe_customers_processed: stripeClient ? stripeCustomers.length : 0,
      stripe_customers_failed: stripeCustomersFailed,
      stripe_customers_multi_currency: stripeCustomersMultiCurrency,
      stripe_customers_non_cny: stripeCustomersNonCny
    },
    items
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

refundEstimateRouter.post('/users', async (req, res) => {
  try {
    const BodySchema = z
      .object({
        user_ids: z.array(z.string()).optional(),
        user_ids_text: z.string().optional()
      })
      .refine((v) => (v.user_ids?.length ?? 0) > 0 || Boolean(v.user_ids_text?.trim()), {
        message: 'missing_user_ids'
      });

    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
    }

    const rawUserIds = [
      ...(parsed.data.user_ids ?? []),
      ...(parsed.data.user_ids_text ? parseUserIdsText(parsed.data.user_ids_text) : [])
    ];

    const result = await computeRefundEstimateForUsers(rawUserIds);
    return res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error';
    if (message.startsWith('too_many_user_ids:')) {
      const limit = message.split(':')[1] ?? '';
      return res.status(400).json({ error: 'too_many_user_ids', message: limit ? `最多支持 ${limit} 个用户ID，请拆分后再测算` : message });
    }
    if (message === 'invalid_user_ids' || message === 'missing_user_ids') {
      return res.status(400).json({ error: message });
    }
    return res.status(500).json({ error: 'refund_estimate_users_failed', message });
  }
});
