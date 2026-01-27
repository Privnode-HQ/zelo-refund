import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../supabase.js';

export const refundsRouter = Router();

refundsRouter.get('/', async (req, res) => {
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
    topup_trade_no: z.string().trim().optional(),
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

  const { limit, offset, mysql_user_id, topup_trade_no, status, payment_method, start_at, end_at } = parsed.data;
  if (start_at && end_at && Date.parse(start_at) > Date.parse(end_at)) {
    return res.status(400).json({ error: 'invalid_query', message: 'start_at_must_be_before_end_at' });
  }

  let query = supabaseAdmin
    .from('refunds')
    .select(
      'id, created_at, mysql_user_id, topup_trade_no, stripe_charge_id, payment_method, refund_money, provider, status, error_message',
      { count: 'exact' }
    )
    .order('created_at', { ascending: false });

  if (mysql_user_id != null) {
    query = query.eq('mysql_user_id', mysql_user_id);
  }
  if (topup_trade_no) {
    query = query.eq('topup_trade_no', topup_trade_no);
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

refundsRouter.get('/:id', async (req, res) => {
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
  const { data, error } = await supabaseAdmin.from('refunds').select('*').eq('id', id).single();

  if (error) {
    const code = (error as any).code;
    if (code === 'PGRST116') {
      return res.status(404).json({ error: 'refund_not_found' });
    }
    return res.status(500).json({ error: 'supabase_error', details: error.message });
  }

  return res.json(data);
});
