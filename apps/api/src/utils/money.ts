export const formatMoneyYuan = (value: number) => {
  if (!Number.isFinite(value)) {
    throw new Error('Invalid money');
  }
  return value.toFixed(2);
};
