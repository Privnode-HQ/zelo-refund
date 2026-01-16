import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../supabase.js';

export const refundsRouter = Router();

refundsRouter.get('/', async (req, res) => {
  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'server_missing_supabase' });
  }

  const QuerySchema = z.object({
    mysql_user_id: z.string().optional(),
    topup_trade_no: z.string().optional(),
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

  const { limit, offset, mysql_user_id, topup_trade_no } = parsed.data;
  let query = supabaseAdmin.from('refunds').select('*').order('created_at', { ascending: false });

  if (mysql_user_id) {
    query = query.eq('mysql_user_id', mysql_user_id);
  }
  if (topup_trade_no) {
    query = query.eq('topup_trade_no', topup_trade_no);
  }

  const { data, error } = await query.range(offset, offset + limit - 1);

  if (error) {
    return res.status(500).json({ error: 'supabase_error', details: error.message });
  }
  return res.json({ items: data ?? [], limit, offset });
});
