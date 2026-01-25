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
    limit: z
      .string()
      .optional()
      .default('50')
      .transform((v) => Math.min(Math.max(Number(v) || 50, 1), 200))
  });
  const parsed = QuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_query', details: parsed.error.flatten() });
  }

  const { limit } = parsed.data;

  const { data, error } = await supabaseAdmin
    .from('refunds')
    .select('id, created_at, payment_method, refund_money, provider, status')
    .order('created_at', { ascending: false })
    .range(0, limit - 1);

  if (error) {
    return res.status(500).json({ error: 'supabase_error', details: error.message });
  }

  return res.json({ items: data ?? [], limit });
});
