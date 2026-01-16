export const QUOTA_PER_YUAN = 500000n;
export const QUOTA_PER_CENT = 5000n;

export const asBigInt = (value: unknown, fieldName: string): bigint => {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.trim() !== '') return BigInt(value);
  throw new Error(`Invalid bigint for ${fieldName}`);
};

export const centsToQuota = (cents: bigint) => cents * QUOTA_PER_CENT;
export const quotaToCentsFloor = (quota: bigint) => quota / QUOTA_PER_CENT;

export const centsToYuanString = (cents: bigint) => {
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  const yuan = abs / 100n;
  const cent = abs % 100n;
  return `${sign}${yuan}.${cent.toString().padStart(2, '0')}`;
};

export const yuanStringToCents = (yuan: string) => {
  const trimmed = yuan.trim();
  if (!trimmed) throw new Error('Invalid yuan');
  const negative = trimmed.startsWith('-');
  const normalized = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ''] = normalized.split('.');
  const cent = frac.padEnd(2, '0').slice(0, 2);
  const cents = BigInt(whole || '0') * 100n + BigInt(cent || '0');
  return negative ? -cents : cents;
};

