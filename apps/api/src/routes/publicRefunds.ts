import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../supabase.js';

export const publicRefundsRouter = Router();

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
