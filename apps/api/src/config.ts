import { z } from 'zod';

const parseNumber = (value: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return parsed;
};

const optionalPem = z
  .string()
  .optional()
  .transform((value) => {
    if (!value) return undefined;

    const trimmed = value.trim();
    if (!trimmed) return undefined;

    const looksLikePem = trimmed.includes('BEGIN') && trimmed.includes('KEY');
    if (looksLikePem) return trimmed;

    try {
      const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
      if (!decoded.includes('BEGIN')) {
        throw new Error('base64 did not decode to PEM');
      }
      return decoded;
    } catch {
      return trimmed;
    }
  });

const EnvSchema = z.object({
  PORT: z.string().optional().default('3001').transform(parseNumber),
  API_CORS_ORIGIN: z.string().optional().default('http://localhost:5173'),

  MYSQL_HOST: z.string().default('127.0.0.1'),
  MYSQL_PORT: z.string().optional().default('3306').transform(parseNumber),
  MYSQL_USER: z.string().default('root'),
  MYSQL_PASSWORD: z.string().optional().default(''),
  MYSQL_DATABASE: z.string().default('zelo'),

  SUPABASE_URL: z.string().optional().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(''),
  SUPABASE_JWT_SECRET: z.string().optional().default(''),

  ADMIN_EMAILS: z.string().optional().default(''),

  YIPAY_BASE_URL: z.string().optional().default('https://pay.lxsd.cn'),
  YIPAY_PID: z.string().optional().default(''),
  YIPAY_PRIVATE_KEY: optionalPem,
  YIPAY_PUBLIC_KEY: optionalPem,
  YIPAY_SIGN_ALGO: z
    .enum(['RSA-SHA256', 'RSA-SHA1'])
    .optional()
    .default('RSA-SHA256'),

  STRIPE_SECRET_KEY: z.string().optional().default('')
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  adminEmailAllowlist: Set<string>;
};

export const config: AppConfig = (() => {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment variables:\n${issues.join('\n')}`);
  }

  const adminEmailAllowlist = new Set(
    parsed.data.ADMIN_EMAILS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

  return {
    ...parsed.data,
    adminEmailAllowlist
  };
})();
