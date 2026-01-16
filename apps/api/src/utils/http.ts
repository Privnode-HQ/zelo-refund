export const toFormBody = (params: Record<string, string | number | undefined>) => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    body.set(key, String(value));
  }
  return body;
};
