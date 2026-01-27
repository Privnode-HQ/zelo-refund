export const DEFAULT_FEE_PERCENT = '5';

export const parsePercentToBps = (input: string): number | null => {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ''] = trimmed.split('.');
  const bps = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isFinite(bps)) return null;
  if (bps < 0 || bps > 10000) return null;
  return bps;
};

export const applyFeeToCents = (grossCents: bigint, feeBps: number) => {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10000) {
    throw new Error('Invalid fee bps');
  }
  const feeCents = (grossCents * BigInt(feeBps)) / 10000n;
  const netCents = grossCents - feeCents;
  return { feeCents, netCents };
};

