import { centsToQuota, quotaToCentsFloor } from './quota.js';

export type RefundAlgoOrder = {
  id: string;
  paid_cents: bigint;
  grant_quota: bigint;
  created_at: number;
};

export type RefundAlgoOrderComputed = RefundAlgoOrder & {
  paid_quota: bigint;
  promo_ratio_num: bigint;
  promo_ratio_den: bigint;
  used_alloc_quota: bigint;
  refundable_quota: bigint;
};

export type RefundAlgoResult = {
  due_cents: bigint;
  due_quota: bigint;
  used_total_quota: bigint;
  orders_sorted: RefundAlgoOrderComputed[];
};

const clampNonNegative = (value: bigint) => (value < 0n ? 0n : value);

const comparePromoRatioDesc = (
  a: Pick<RefundAlgoOrderComputed, 'grant_quota' | 'promo_ratio_num'>,
  b: Pick<RefundAlgoOrderComputed, 'grant_quota' | 'promo_ratio_num'>
) => {
  const gA = a.grant_quota;
  const gB = b.grant_quota;

  // r = (g - p) / g when g>0, else 0
  if (gA === 0n && gB === 0n) return 0;
  if (gA === 0n) {
    // rA = 0, compare against rB = numB / gB
    const nB = b.promo_ratio_num;
    if (nB === 0n) return 0;
    return nB > 0n ? 1 : -1;
  }
  if (gB === 0n) {
    const nA = a.promo_ratio_num;
    if (nA === 0n) return 0;
    return nA > 0n ? -1 : 1;
  }

  const left = a.promo_ratio_num * gB;
  const right = b.promo_ratio_num * gA;
  if (left === right) return 0;
  return left > right ? -1 : 1;
};

export const computeRefundDueV2 = (orders: RefundAlgoOrder[], usedTotalQuota: bigint): RefundAlgoResult => {
  const normalized = orders.map((o) => {
    const paidCents = clampNonNegative(o.paid_cents);
    const grantQuota = clampNonNegative(o.grant_quota);
    const paidQuota = centsToQuota(paidCents);
    const promoNum = grantQuota > 0n ? grantQuota - paidQuota : 0n;
    return {
      ...o,
      paid_cents: paidCents,
      grant_quota: grantQuota,
      paid_quota: paidQuota,
      promo_ratio_num: promoNum,
      promo_ratio_den: grantQuota,
      used_alloc_quota: 0n,
      refundable_quota: 0n
    } satisfies RefundAlgoOrderComputed;
  });

  const sorted = normalized.slice().sort((a, b) => {
    const ratioCmp = comparePromoRatioDesc(a, b);
    if (ratioCmp !== 0) return ratioCmp;
    if (a.grant_quota !== b.grant_quota) return a.grant_quota > b.grant_quota ? -1 : 1;
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });

  const U = clampNonNegative(usedTotalQuota);
  let allocatedSum = 0n;
  let totalRefundableQuota = 0n;

  for (const o of sorted) {
    const remaining = U - allocatedSum;
    const u = remaining <= 0n ? 0n : remaining >= o.grant_quota ? o.grant_quota : remaining;
    o.used_alloc_quota = u;
    allocatedSum += u;

    const refundable = o.paid_quota > u ? o.paid_quota - u : 0n;
    o.refundable_quota = refundable;
    totalRefundableQuota += refundable;
  }

  return {
    due_cents: quotaToCentsFloor(totalRefundableQuota),
    due_quota: totalRefundableQuota,
    used_total_quota: U,
    orders_sorted: sorted
  };
};
