import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../supabase.js';

export const publicRefundsRouter = Router();

const publicSensitiveKeys = new Set([
  'topup_trade_no',
  'trade_no',
  'stripe_customer',
  'stripe_charge_id',
  'stripe_payment_intent_id',
  'charge_id',
  'payment_intent',
  'provider_refund_no',
  'out_refund_no'
]);

const redactText = (text: string) =>
  text
    .replace(/\bch_[A-Za-z0-9]+\b/g, 'ch_[redacted]')
    .replace(/\bpi_[A-Za-z0-9]+\b/g, 'pi_[redacted]')
    .replace(/\bcus_[A-Za-z0-9]+\b/g, 'cus_[redacted]');

const redactForPublic = (value: unknown, key?: string): unknown => {
  if (key && publicSensitiveKeys.has(key)) {
    return '[redacted]';
  }

  if (typeof value === 'string') {
    return redactText(value);
  }

  if (Array.isArray(value)) {
    if (value.length > 50) {
      return { count: value.length, truncated: true };
    }
    return value.map((v) => redactForPublic(v));
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (publicSensitiveKeys.has(k)) {
        out[k] = '[redacted]';
        continue;
      }

      if ((k === 'refundable_charges' || k === 'refunds' || k === 'refunded_by_topup') && Array.isArray(v)) {
        out[k] = { count: v.length };
        continue;
      }

      out[k] = redactForPublic(v, k);
    }
    return out;
  }

  return value;
};

publicRefundsRouter.get('/activity', async (req, res) => {
  res.setHeader('cache-control', 'no-store');

  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'server_missing_supabase' });
  }

  const QuerySchema = z.object({
    mysql_user_id: z
      .string()
      .trim()
      .regex(/^\d+$/)
      .transform((v) => Number(v))
      .refine((v) => Number.isSafeInteger(v), { message: 'invalid_mysql_user_id' })
      .optional(),
    status: z.enum(['pending', 'succeeded', 'failed']).optional(),
    payment_method: z.string().trim().optional(),
    start_at: z
      .string()
      .trim()
      .refine((v) => Number.isFinite(Date.parse(v)), { message: 'invalid_start_at' })
      .optional(),
    end_at: z
      .string()
      .trim()
      .refine((v) => Number.isFinite(Date.parse(v)), { message: 'invalid_end_at' })
      .optional(),
    limit: z
      .string()
      .optional()
      .default('50')
      .transform((v) => Math.min(Math.max(Number(v) || 50, 1), 200)),
    offset: z
      .string()
      .optional()
      .default('0')
      .transform((v) => Math.max(Number(v) || 0, 0))
  });
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_query', details: parsed.error.flatten() });
  }

  const { limit, offset, mysql_user_id, status, payment_method, start_at, end_at } = parsed.data;
  if (start_at && end_at && Date.parse(start_at) > Date.parse(end_at)) {
    return res.status(400).json({ error: 'invalid_query', message: 'start_at_must_be_before_end_at' });
  }

  let query = supabaseAdmin
    .from('refunds')
    .select('id, created_at, mysql_user_id, payment_method, refund_money, provider, status', { count: 'exact' })
    .order('created_at', { ascending: false });

  if (mysql_user_id != null) {
    query = query.eq('mysql_user_id', mysql_user_id);
  }
  if (status) {
    query = query.eq('status', status);
  }
  if (payment_method) {
    query = query.eq('payment_method', payment_method);
  }
  if (start_at) {
    query = query.gte('created_at', start_at);
  }
  if (end_at) {
    query = query.lte('created_at', end_at);
  }

  const { data, error, count } = await query.range(offset, offset + limit - 1);

  if (error) {
    return res.status(500).json({ error: 'supabase_error', details: error.message });
  }

  return res.json({ items: data ?? [], limit, offset, total: count ?? null });
});

publicRefundsRouter.get('/activity/:id', async (req, res) => {
  res.setHeader('cache-control', 'no-store');

  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'server_missing_supabase' });
  }

  const ParamsSchema = z.object({
    id: z.string().uuid()
  });
  const parsed = ParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_refund_id', details: parsed.error.flatten() });
  }

  const { id } = parsed.data;
  const { data, error } = await supabaseAdmin
    .from('refunds')
    .select('id, created_at, mysql_user_id, payment_method, refund_money, provider, status, error_message, raw_request')
    .eq('id', id)
    .single();

  if (error) {
    const code = (error as any).code;
    if (code === 'PGRST116') {
      return res.status(404).json({ error: 'refund_not_found' });
    }
    return res.status(500).json({ error: 'supabase_error', details: error.message });
  }

  const rawRequest = (data as any).raw_request;
  const calcTrace = rawRequest && typeof rawRequest === 'object' && rawRequest !== null ? (rawRequest as any).calc_trace : null;

  return res.json({
    item: {
      id: (data as any).id,
      created_at: (data as any).created_at,
      mysql_user_id: (data as any).mysql_user_id,
      payment_method: (data as any).payment_method,
      refund_money: (data as any).refund_money,
      provider: (data as any).provider,
      status: (data as any).status,
      error_message: typeof (data as any).error_message === 'string' ? redactText((data as any).error_message) : null
    },
    calc_trace: calcTrace ? redactForPublic(calcTrace) : null
  });
});
