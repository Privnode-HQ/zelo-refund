import { Router } from 'express';
import { z } from 'zod';
import { mysqlPool } from '../mysql.js';

export const topupsRouter = Router();

topupsRouter.get('/', async (req, res) => {
  const QuerySchema = z.object({
    q: z.string().optional(),
    status: z.string().optional().default('success'),
    payment_method: z.enum(['alipay', 'wxpay', 'stripe']).optional(),
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

  const { q, status, payment_method, limit, offset } = parsed.data;
  const where: string[] = ['tu.status = ?'];
  const params: Array<string | number> = [status];

  if (payment_method) {
    where.push('tu.payment_method = ?');
    params.push(payment_method);
  }

  if (q) {
    where.push('(tu.trade_no like ? OR u.email like ? OR cast(tu.user_id as char) like ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const sql = `
    select
      tu.id,
      tu.user_id,
      tu.amount,
      tu.money,
      tu.trade_no,
      tu.create_time,
      tu.complete_time,
      tu.status,
      tu.payment_method,
      u.email as user_email,
      u.quota as user_quota,
      u.used_quota as user_used_quota,
      u.stripe_customer as user_stripe_customer
    from top_ups tu
    left join users u on u.id = tu.user_id
    where ${where.join(' and ')}
    order by tu.complete_time desc
    limit ? offset ?
  `;
  params.push(limit, offset);

  const [rows] = await mysqlPool.query(sql, params);
  return res.json({ items: rows, limit, offset });
});

topupsRouter.get('/:tradeNo', async (req, res) => {
  const tradeNo = req.params.tradeNo;
  const sql = `
    select
      tu.id,
      tu.user_id,
      tu.amount,
      tu.money,
      tu.trade_no,
      tu.create_time,
      tu.complete_time,
      tu.status,
      tu.payment_method,
      u.email as user_email,
      u.quota as user_quota,
      u.used_quota as user_used_quota,
      u.stripe_customer as user_stripe_customer
    from top_ups tu
    left join users u on u.id = tu.user_id
    where tu.trade_no = ?
    limit 1
  `;
  const [rows] = await mysqlPool.query(sql, [tradeNo]);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) {
    return res.status(404).json({ error: 'not_found' });
  }
  return res.json(row);
});
