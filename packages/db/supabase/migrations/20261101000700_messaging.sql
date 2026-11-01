-- WhatsApp: per-buyer conversation sessions, the notification outbox, catalogue sync state.

alter table public.businesses
  add column whatsapp_catalog_id text,
  add column whatsapp_token_secret_id uuid,          -- vault.secrets id (per-business token); null = platform token
  add column whatsapp_catalog_synced_at timestamptz,
  add column whatsapp_display_phone text;

create table public.whatsapp_sessions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  wa_phone text not null,                             -- E.164 of the buyer
  customer_id uuid,
  profile_name text,
  state jsonb not null default '{}'::jsonb,           -- bot state machine (core/whatsapp.ts)
  human_handoff_at timestamptz,                        -- buyer asked for a person; bot stays quiet until cleared
  last_inbound_at timestamptz,                         -- start of Meta's 24-hour free-form window
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, wa_phone),
  foreign key (business_id, customer_id) references public.customers (business_id, id) on delete set null (customer_id)
);
create index whatsapp_sessions_customer_idx on public.whatsapp_sessions (customer_id);
create index whatsapp_sessions_handoff_idx on public.whatsapp_sessions (business_id) where human_handoff_at is not null;
create trigger whatsapp_sessions_touch before update on public.whatsapp_sessions for each row execute function app.touch_updated_at();

create type public.notification_kind as enum (
  'order_placed', 'payment_received', 'order_confirmed', 'packed', 'dispatched', 'delivered', 'delivery_failed',
  'debt_reminder', 'wholesale_approved'
);
create type public.notification_status as enum ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped');

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  customer_id uuid,
  order_id uuid,
  kind public.notification_kind not null,
  channel text not null default 'whatsapp' check (channel in ('whatsapp', 'sms')),
  to_phone text not null,
  params jsonb not null default '{}'::jsonb,           -- template variables (amounts, order no., links)
  dedupe_key text not null,
  status public.notification_status not null default 'queued',
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  used_template boolean,
  provider_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (business_id, dedupe_key),
  foreign key (business_id, customer_id) references public.customers (business_id, id) on delete set null (customer_id),
  foreign key (business_id, order_id) references public.orders (business_id, id) on delete set null (order_id)
);
create index notifications_due_idx on public.notifications (next_attempt_at) where status = 'queued';
create index notifications_business_idx on public.notifications (business_id, created_at desc);
create unique index notifications_provider_idx on public.notifications (provider_message_id) where provider_message_id is not null;

-- ---------------------------------------------------------------------------
-- Enqueue
-- ---------------------------------------------------------------------------
create or replace function app.enqueue_notification(
  p_business uuid, p_customer uuid, p_order uuid, p_kind public.notification_kind, p_params jsonb, p_dedupe text
) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_phone text;
begin
  select phone into v_phone from public.customers where id = p_customer and business_id = p_business;
  if v_phone is null then return; end if;  -- walk-ins: nobody to notify
  insert into public.notifications (business_id, customer_id, order_id, kind, to_phone, params, dedupe_key)
  values (p_business, p_customer, p_order, p_kind, v_phone, coalesce(p_params, '{}'::jsonb), p_dedupe)
  on conflict (business_id, dedupe_key) do nothing;
end $$;
revoke execute on function app.enqueue_notification(uuid, uuid, uuid, public.notification_kind, jsonb, text) from public, anon, authenticated;

-- Order lifecycle → notifications. POS walk-in sales and paid-at-counter sales are skipped
-- (the buyer is standing there with a receipt).
create or replace function app.orders_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  b public.businesses;
  v_params jsonb;
begin
  if new.customer_id is null then return null; end if;
  select * into b from public.businesses where id = new.business_id;
  v_params := jsonb_build_object(
    'order_number', new.order_number, 'total_kobo', new.total_kobo, 'balance_kobo', new.balance_kobo,
    'amount_paid_kobo', new.amount_paid_kobo, 'shop', b.name, 'slug', b.slug::text, 'tracking_token', new.tracking_token);

  if tg_op = 'INSERT' then
    if new.status = 'pending' and new.channel <> 'pos' then
      perform app.enqueue_notification(new.business_id, new.customer_id, new.id, 'order_placed', v_params, 'placed:' || new.id);
    end if;
    return null;
  end if;

  if new.amount_paid_kobo > old.amount_paid_kobo and new.channel <> 'pos' then
    perform app.enqueue_notification(new.business_id, new.customer_id, new.id, 'payment_received',
      v_params || jsonb_build_object('received_kobo', new.amount_paid_kobo - old.amount_paid_kobo),
      'paid:' || new.id || ':' || new.amount_paid_kobo);
  end if;
  if new.status = 'confirmed' and old.status <> 'confirmed' and new.channel <> 'pos' and new.amount_paid_kobo < new.total_kobo then
    -- confirmed on credit (fully paid orders already got payment_received)
    perform app.enqueue_notification(new.business_id, new.customer_id, new.id, 'order_confirmed', v_params, 'confirmed:' || new.id);
  end if;
  if new.fulfilment_status is distinct from old.fulfilment_status
     and new.fulfilment_status in ('packed', 'dispatched', 'delivered', 'failed') then
    perform app.enqueue_notification(new.business_id, new.customer_id, new.id,
      case new.fulfilment_status when 'failed' then 'delivery_failed' else new.fulfilment_status::text end::public.notification_kind,
      v_params, new.fulfilment_status::text || ':' || new.id);
  end if;
  return null;
end $$;
create trigger orders_enqueue_notifications after insert or update on public.orders for each row execute function app.orders_notify();

create or replace function app.customers_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.wholesale_status = 'approved' and old.wholesale_status is distinct from 'approved' then
    perform app.enqueue_notification(new.business_id, new.id, null, 'wholesale_approved',
      jsonb_build_object('shop', (select name from public.businesses where id = new.business_id),
                         'slug', (select slug::text from public.businesses where id = new.business_id)),
      'wholesale:' || new.id);
  end if;
  return null;
end $$;
create trigger customers_enqueue_notifications after update on public.customers for each row execute function app.customers_notify();

-- ---------------------------------------------------------------------------
-- Worker API (service role)
-- ---------------------------------------------------------------------------
-- Claim due notifications; concurrent workers never get the same row.
create or replace function public.claim_notifications(p_limit int default 50)
returns setof public.notifications
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not app.is_service() then perform app.raise_forbidden(); end if;
  return query
    update public.notifications n set status = 'sending', attempts = n.attempts + 1
    where n.id in (
      select id from public.notifications
      where status = 'queued' and next_attempt_at <= now()
      order by next_attempt_at limit p_limit
      for update skip locked)
    returning n.*;
end $$;

-- Result of one send. Failures back off 1, 4, 9, 16… minutes; give up after 6 attempts.
create or replace function public.finish_notification(
  p_id uuid, p_ok boolean, p_provider_id text default null, p_error text default null, p_used_template boolean default null
) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not app.is_service() then perform app.raise_forbidden(); end if;
  update public.notifications set
    status = case when p_ok then 'sent'::public.notification_status
                  when attempts >= 6 then 'failed'::public.notification_status
                  else 'queued'::public.notification_status end,
    provider_message_id = coalesce(p_provider_id, provider_message_id),
    used_template = coalesce(p_used_template, used_template),
    last_error = case when p_ok then null else left(p_error, 500) end,
    sent_at = case when p_ok then now() else sent_at end,
    next_attempt_at = case when p_ok then next_attempt_at else now() + make_interval(mins => attempts * attempts) end
  where id = p_id;
end $$;

-- Delivery receipts from Meta (sent → delivered → read, or failed).
create or replace function public.notification_receipt(p_provider_id text, p_status text, p_error text default null)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not app.is_service() then perform app.raise_forbidden(); end if;
  update public.notifications set
    status = case p_status when 'delivered' then 'delivered' when 'read' then 'read' when 'failed' then 'failed' else status::text end::public.notification_status,
    last_error = coalesce(p_error, last_error)
  where provider_message_id = p_provider_id
    and not (status = 'read' and p_status = 'delivered');   -- receipts can arrive out of order
end $$;

-- Per-business WhatsApp token in Vault. Settings + MFA; the token never comes back out through the API.
create or replace function public.set_whatsapp_connection(
  p_business uuid, p_phone_number_id text, p_display_phone text, p_catalog_id text, p_token text default null
) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_secret uuid;
begin
  perform app.require_permission(p_business, 'settings.manage');
  perform app.require_aal2();
  select whatsapp_token_secret_id into v_secret from public.businesses where id = p_business;
  if p_token is not null and p_token <> '' then
    if v_secret is null then
      v_secret := vault.create_secret(p_token, 'whatsapp_token:' || p_business, 'WhatsApp Cloud API token');
    else
      perform vault.update_secret(v_secret, p_token);
    end if;
  end if;
  update public.businesses set whatsapp_phone_number_id = nullif(trim(p_phone_number_id), ''),
    whatsapp_display_phone = nullif(trim(p_display_phone), ''), whatsapp_catalog_id = nullif(trim(p_catalog_id), ''),
    whatsapp_token_secret_id = v_secret
  where id = p_business;
  perform app.audit(p_business, 'whatsapp.connection_changed', 'business', p_business::text, null,
    jsonb_build_object('phone_number_id', p_phone_number_id, 'catalog_id', p_catalog_id, 'token_changed', p_token is not null and p_token <> ''));
end $$;

-- Service only: the business's token (or null → use the platform token).
create or replace function public.whatsapp_token(p_business uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  if not app.is_service() then perform app.raise_forbidden(); end if;
  select ds.decrypted_secret into v from vault.decrypted_secrets ds
  join public.businesses b on b.whatsapp_token_secret_id = ds.id where b.id = p_business;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.whatsapp_sessions enable row level security;
alter table public.notifications enable row level security;

create policy whatsapp_sessions_staff on public.whatsapp_sessions for select to authenticated
  using (app.has_permission(business_id, 'orders.view'));
create policy whatsapp_sessions_handoff on public.whatsapp_sessions for update to authenticated
  using (app.has_permission(business_id, 'orders.manage')) with check (app.has_permission(business_id, 'orders.manage'));
create policy notifications_staff on public.notifications for select to authenticated
  using (app.has_permission(business_id, 'orders.view') or customer_id in (select app.my_customer_ids()));

revoke all on public.whatsapp_sessions, public.notifications from anon;
revoke insert, delete on public.whatsapp_sessions from authenticated;
revoke update on public.whatsapp_sessions from authenticated;
grant update (human_handoff_at) on public.whatsapp_sessions to authenticated;
revoke insert, update, delete on public.notifications from authenticated;
revoke execute on function public.claim_notifications(int) from public, anon, authenticated;
revoke execute on function public.finish_notification(uuid, boolean, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.notification_receipt(text, text, text) from public, anon, authenticated;
revoke execute on function public.whatsapp_token(uuid) from public, anon, authenticated;
revoke execute on function public.set_whatsapp_connection(uuid, text, text, text, text) from public, anon;

-- ---------------------------------------------------------------------------
-- Scheduled jobs (only where pg_cron exists, i.e. on Supabase). HTTP jobs (notifications,
-- catalogue sync) are called by pg_net or any scheduler hitting /api/cron/* with CRON_SECRET.
-- ---------------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('trawer-expire-reservations', '* * * * *', 'select public.expire_reservations(500)');
  end if;
end $$;
