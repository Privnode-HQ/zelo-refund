import { z } from 'zod';
import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  type PrivateKeyInput,
  type PublicKeyInput
} from 'node:crypto';

const parseNumber = (value: string) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return parsed;
};

const normalizeEnvNewlines = (value: string) => value.replaceAll('\\n', '\n');

const looksLikePem = (value: string) => value.includes('BEGIN') && value.includes('KEY');

const exportKeyToPem = (keyObject: KeyObject) => {
  try {
    return keyObject.export({ format: 'pem', type: 'pkcs8' }).toString();
  } catch {
    // ignore
  }
  try {
    return keyObject.export({ format: 'pem', type: 'pkcs1' }).toString();
  } catch {
    // ignore
  }
  try {
    return keyObject.export({ format: 'pem', type: 'spki' }).toString();
  } catch {
    // ignore
  }
  return null;
};

const tryDecodeKeyPemFromBase64 = (base64: string) => {
  const decoded = Buffer.from(base64, 'base64').toString('utf8').trim();
  const normalized = normalizeEnvNewlines(decoded);
  if (looksLikePem(normalized)) return normalized;
  return null;
};

const tryDecodeKeyPemFromDerBase64 = (base64: string) => {
  const der = Buffer.from(base64, 'base64');
  if (!der.length) return null;

  const privateAttempts: PrivateKeyInput[] = [
    { key: der, format: 'der', type: 'pkcs8' },
    { key: der, format: 'der', type: 'pkcs1' }
  ];
  for (const input of privateAttempts) {
    try {
      const obj = createPrivateKey(input);
      const pem = exportKeyToPem(obj);
      if (pem) return pem;
    } catch {
      // ignore
    }
  }

  const publicAttempts: PublicKeyInput[] = [
    { key: der, format: 'der', type: 'spki' },
    { key: der, format: 'der', type: 'pkcs1' }
  ];
  for (const input of publicAttempts) {
    try {
      const obj = createPublicKey(input);
      const pem = exportKeyToPem(obj);
      if (pem) return pem;
    } catch {
      // ignore
    }
  }

  return null;
};

const optionalKeyPem = z
  .string()
  .optional()
  .transform((value) => {
    if (!value) return undefined;

    const trimmed = value.trim();
    if (!trimmed) return undefined;

    const normalized = normalizeEnvNewlines(trimmed);
    if (looksLikePem(normalized)) return normalized;

    // Base64 of PEM
    try {
      const pem = tryDecodeKeyPemFromBase64(trimmed);
      if (pem) return pem;
    } catch {
      // ignore
    }

    // Base64 of DER (PKCS#8 / PKCS#1 / SPKI)
    try {
      const pem = tryDecodeKeyPemFromDerBase64(trimmed);
      if (pem) return pem;
    } catch {
      // ignore
    }

    return normalized;
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
  YIPAY_PRIVATE_KEY: optionalKeyPem,
  YIPAY_PUBLIC_KEY: optionalKeyPem,
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
