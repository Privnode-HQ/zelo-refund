export const DEFAULT_FEE_BPS = 500;

export const parseFeePercentToBps = (value: unknown, defaultBps: number = DEFAULT_FEE_BPS) => {
  if (!Number.isInteger(defaultBps) || defaultBps < 0 || defaultBps > 10000) {
    throw new Error('invalid_default_fee');
  }

  if (value === undefined || value === null) return defaultBps;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('invalid_fee_percent');
    }
    const bps = Math.round(value * 100);
    if (!Number.isFinite(bps) || bps < 0 || bps > 10000) {
      throw new Error('invalid_fee_percent');
    }
    return bps;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return defaultBps;
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
      throw new Error('invalid_fee_percent');
    }
    const [whole, frac = ''] = trimmed.split('.');
    const bps = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
    if (!Number.isFinite(bps) || bps < 0 || bps > 10000) {
      throw new Error('invalid_fee_percent');
    }
    return bps;
  }

  throw new Error('invalid_fee_percent');
};

export const applyFeeToCents = (grossCents: bigint, feeBps: number) => {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) {
    throw new Error('invalid_fee_bps');
  }
  const feeCents = (grossCents * BigInt(feeBps)) / 10000n;
  const netCents = grossCents - feeCents;
  return { feeCents, netCents };
};

