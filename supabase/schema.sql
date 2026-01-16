create extension if not exists pgcrypto;

create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;

create policy "admins can read admins" on public.admins
for select
using (
  exists (
    select 1
    from public.admins a
    where a.user_id = auth.uid()
  )
);

create type public.refund_status as enum ('pending', 'succeeded', 'failed');

create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  mysql_user_id bigint,
  topup_trade_no text,
  stripe_charge_id text,
  stripe_payment_intent_id text,

  payment_method text not null,
  currency text not null default 'cny',
  refund_money numeric(12, 2),
  refund_money_minor bigint,
  quota_delta bigint,

  provider text not null,
  out_refund_no text,
  provider_refund_no text,

  status public.refund_status not null default 'pending',
  error_message text,

  performed_by uuid references auth.users(id),
  executed_at timestamptz,

  raw_request jsonb,
  raw_response jsonb
);

create index if not exists refunds_by_user_id
  on public.refunds (mysql_user_id, created_at desc);

create index if not exists refunds_by_topup_trade_no
  on public.refunds (topup_trade_no);

create index if not exists refunds_by_stripe_charge
  on public.refunds (stripe_charge_id);

alter table public.refunds enable row level security;

create policy "admins can view refunds" on public.refunds
for select
using (
  exists (
    select 1
    from public.admins a
    where a.user_id = auth.uid()
  )
);
