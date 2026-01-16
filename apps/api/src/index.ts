import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { requireAdmin } from './auth.js';
import { topupsRouter } from './routes/topups.js';
import { refundsRouter } from './routes/refunds.js';
import { registerRefundCreateRoute } from './routes/refundCreate.js';
import { usersRouter } from './routes/users.js';

const app = express();

app.use(helmet());
app.use(
  cors({
    origin: config.API_CORS_ORIGIN,
    credentials: true
  })
);
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api', requireAdmin);

app.use('/api/topups', topupsRouter);
app.use('/api/users', usersRouter);
app.use('/api/refunds', refundsRouter);

const refundRouter = express.Router();
registerRefundCreateRoute({ router: refundRouter });
app.use('/api/refund', refundRouter);

app.listen(config.PORT, () => {
  console.log(`API listening on http://localhost:${config.PORT}`);
});
