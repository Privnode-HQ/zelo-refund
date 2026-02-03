# zelo-refund

退款后台（React Router + HeroUI + Supabase Auth + Supabase Postgres）

要求：Node.js 18+

## 架构

- `apps/admin`: 管理后台前端（Vite + React Router + HeroUI + Supabase）
- `apps/api`: API 服务（Express）
  - 数据来源：独立 MySQL（`users` / `top_ups`）
  - 审计/日志：Supabase Postgres（`refunds` 等）
  - 退款通道：
    - `alipay` / `wxpay`：易支付 `https://pay.lxsd.cn/api/pay/refund`
    - `stripe`：Stripe Refunds API

## 本地启动（开发）

### 1) Supabase

在你的 Supabase 项目里执行 `supabase/schema.sql`。

然后在 Supabase Auth 里创建管理员账号（Email + Password），并把该账号的 `auth.users.id` 写入 `public.admins` 表。

示例：

```sql
insert into public.admins(user_id)
values ('00000000-0000-0000-0000-000000000000');
```

注意：后端会验证 Supabase JWT（需要 `SUPABASE_JWT_SECRET`），再通过 `public.admins` 表判断是否为管理员。

如果你不想接入 Supabase Auth，可以使用 `ADMIN_API_KEY`（见下方环境变量说明）。

### 2) 配置环境变量

- 前端：复制 `apps/admin/.env.example` -> `apps/admin/.env`
- 后端：复制 `apps/api/.env.example` -> `apps/api/.env`

后端必须配置：

- `MYSQL_*`: 连接到业务 MySQL（数据来源）
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`: 用于写入审计日志（`public.refunds`）和检查管理员表
- `SUPABASE_JWT_SECRET`: 用于校验管理员登录后的 `access_token`

可选（不使用 Supabase Auth 时使用）：

- `ADMIN_API_KEY`: 管理员 API Key（前端登录页填写，后端按 Bearer Token 校验）

易支付（alipay/wxpay）退款必须配置：

- `YIPAY_PID`
- `YIPAY_PRIVATE_KEY`：支持 PEM / PEM(base64) / DER(base64, PKCS#8/PKCS#1)
- `YIPAY_SIGN_ALGO`：默认 `RSA-SHA256`，如上游要求可改为 `RSA-SHA1`

可选：

- `ADMIN_EMAILS`：逗号分隔的管理员邮箱白名单（当你暂时不想维护 `public.admins` 表时可用）
- `API_CORS_ORIGIN`：前端域名（默认 `http://localhost:5173`）

Stripe 退款必须配置：

- `STRIPE_SECRET_KEY`

### 3) 安装依赖并启动

```bash
npm install
npm run dev:api
npm run dev:admin
```

前端默认 `http://localhost:5173`，后端默认 `http://localhost:3001`。

登录后，前端会携带 Supabase `access_token` 调用后端：

- `GET /api/topups`：订单列表（来源 MySQL）
- `GET /api/topups/:tradeNo`：订单详情（来源 MySQL）
- `GET /api/users`：用户搜索（来源 MySQL）
- `GET /api/users/:userId/refund-quote`：计算“应退金额”（自动使用 `users.stripe_customer` 搜索 Stripe 订单）
- `POST /api/users/:userId/refund`：执行整体退款（优先 Stripe，余额不足再走易支付）
- `GET /api/refunds`：退款审计日志（来源 Supabase Postgres）

## Docker（建议用于部署/联调）

1) 准备后端环境变量：复制 `apps/api/.env.example` -> `apps/api/.env`

2) 准备前端构建变量：在项目根目录创建 `.env`（给 docker-compose 用），至少包含：

```bash
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_API_BASE_URL=
```

3) 启动：

```bash
docker compose up --build
```

- 管理后台：`http://localhost:25173`
- API：`http://localhost:23001`

注意：`VITE_*` 是前端编译期变量，修改后需要重新 `docker compose build refund-admin`。

## 关键业务规则

- 用户余额换算：
  - 剩余余额（元）= `users.quota / 500000`
  - 已用余额（元）= `users.used_quota / 500000`
  - 总余额（元，含赠送）= `(quota + used_quota) / 500000`
- 整体退款会先计算“应退金额”（不要求逐笔选择订单）：
  - 对用户每笔订单 `i`（Stripe Charge + 易支付 top_ups），取：
    - `p_i`：该单剩余实付金额换算成额度（已扣历史退款；`p_i = paid_cents * 5000`）
    - `g_i`：该单剩余额度（含赠送，按 `quota` 计；会扣掉历史退款对应的 `quota_delta`）
  - 用户全局：`U = users.used_quota`（已用额度，按 `quota` 计）
  - 排序（商家最优）：先算 `r_i = (g_i - p_i) / g_i`（`g_i=0` 时记为 0），按 `r` 降序；若相同按 `g` 降序；仍相同按创建时间更早优先
  - 将 `U` 依次分配到每单（前面的订单先“吃掉”已用额度）：
    - `u_i = max(0, min(g_i, U - sum(prev_g)))`
  - 每单可退额度：`f_i = max(0, p_i - u_i)`；应退上限（分）=`floor(sum(f_i) / 5000)`
- 执行退款顺序：
  - 先从 Stripe 订单退款（自动拆分到多笔 Charge，可部分退款）
  - 如仍不足，再按易支付订单退款（自动拆分到多笔订单）
- 退款成功后：
  - 回滚用户余额：默认按退款金额扣减 `users.quota`（精确到分：`quota_delta = refund_cents * 5000`）
  - 可选：当接口参数 `clear_balance=true` 时，会清零 `users.quota`，确保退款后余额为 0
  - 在 Supabase Postgres 记录 `refunds` 审计日志
  - 若某笔易支付订单被全额退完，会把该笔 `top_ups.status` 更新为 `refund`

## Stripe 特别说明

- `top_ups.money` 对于 `stripe` 订单不可信：整体退款实付金额以 Stripe Charge 为准
- `top_ups.amount` 存的是“获得额度折算成元”（不是 quota）：用于参与应退测算（会按 `amount_yuan * 500000` 换算成 quota）；若 `top_ups.trade_no` 能匹配 `ch_...` / `pi_...` 则优先用来获取该笔订单额度，否则按“无赠送”处理
- 退款会通过 `users.stripe_customer`（`cus_...`）自动拉取该 Customer 的 Stripe Charge 列表并优先退款

## 目录

- `apps/api/src/providers/yipay.ts`: 易支付退款（RSA 签名）
- `apps/api/src/providers/stripe.ts`: Stripe 退款 + 列出 Customer Charges
- `apps/api/src/routes/users.ts`: 用户搜索 + 应退计算 + 整体退款
- `apps/admin/src/routes`: 登录、订单列表、用户退款、退款记录
- `supabase/schema.sql`: Supabase 表结构与 RLS

## 易支付签名规则（实现说明）

当前实现会：

- 过滤掉 `sign` / `sign_type`，并忽略空值参数
- 按参数名升序排序后拼接为 `k1=v1&k2=v2...`
- 使用 `YIPAY_PRIVATE_KEY` 做 RSA 签名（base64 输出）

如果你的易支付上游签名规则不同（例如是否包含 `sign_type`），请调整 `apps/api/src/utils/sign.ts` 的 `createSignString`。
