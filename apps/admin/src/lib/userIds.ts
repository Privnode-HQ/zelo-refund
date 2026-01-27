export const parseUserIds = (input: string) => {
  const rawParts = input
    .split(/[\n\r,，]+/g)
    .map((s) => s.trim())
    .filter(Boolean);

  const userIds: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const part of rawParts) {
    if (!/^\d+$/.test(part)) {
      invalid.push(part);
      continue;
    }
    if (seen.has(part)) continue;
    seen.add(part);
    userIds.push(part);
  }

  return { userIds, invalid };
};

