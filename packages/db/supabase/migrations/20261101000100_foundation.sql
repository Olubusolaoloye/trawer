-- Trawer foundation: tenancy, staff, permissions, customers, tiers, consent, audit, rate limits.
-- Conventions:
--   * every tenant table has business_id and RLS enabled
--   * money is bigint kobo
--   * privileged writes happen in SECURITY DEFINER functions with a pinned search_path

create schema if not exists app;
grant usage on schema app to anon, authenticated, service_role;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.staff_role as enum ('owner', 'manager', 'cashier', 'store_keeper', 'rider');
create type public.staff_status as enum ('invited', 'active', 'disabled');
create type public.buyer_type as enum ('wholesaler', 'retailer', 'retail_buyer');
create type public.wholesale_status as enum ('not_applicable', 'pending', 'approved', 'rejected');
create type public.business_kind as enum ('wholesaler', 'retailer');
create type public.sales_channel as enum ('web', 'whatsapp', 'instagram', 'facebook', 'pos');

-- ---------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------
create or replace function app.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- True when the caller is trusted server code: the service_role JWT, or a direct DB session
-- (migrations, seed, cron) that is not impersonating an API role.
create or replace function app.is_service() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'role', '') = 'service_role'
      or (
        coalesce(auth.jwt() ->> 'role', '') = ''
        and coalesce(current_setting('role', true), 'none') not in ('anon', 'authenticated')
      )
$$;

create or replace function app.is_aal2() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2' or app.is_service()
$$;

create or replace function app.raise_forbidden(p_message text default 'forbidden') returns void
language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '42501', message = p_message;
end $$;

-- Short, unguessable, URL-safe token (default 128 bits).
create or replace function app.random_token(p_bytes int default 16) returns text
language sql volatile set search_path = '' as $$
  select translate(rtrim(encode(extensions.gen_random_bytes(p_bytes), 'base64'), '='), '+/', '-_')
$$;

-- E.164-ish Nigerian phone normaliser: 0803... / 234803... / +234803... → +234803...
create or replace function app.normalize_phone(p text) returns text
language plpgsql immutable set search_path = '' as $$
declare d text := regexp_replace(coalesce(p, ''), '[^0-9+]', '', 'g');
begin
  if d = '' then return null; end if;
  if left(d, 1) = '+' then d := substr(d, 2);
  elsif left(d, 3) = '234' then null;
  elsif left(d, 1) = '0' then d := '234' || substr(d, 2);
  end if;
  if d !~ '^[0-9]{8,15}$' then
    raise exception using errcode = '22023', message = 'invalid_phone';
  end if;
  return '+' || d;
end $$;

-- ---------------------------------------------------------------------------
-- Businesses (tenants)
-- ---------------------------------------------------------------------------
create table public.businesses (
  id uuid primary key default gen_random_uuid(),
  slug extensions.citext not null unique
    check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'
           and slug not in ('www', 'app', 'api', 'admin', 'shop', 'mail', 'static', 'cdn', 'trawer', 'help', 'status')),
  name text not null check (char_length(name) between 2 and 120),
  kind public.business_kind not null default 'wholesaler',
  logo_path text,
  brand_colour text not null default '#0F766E' check (brand_colour ~ '^#[0-9A-Fa-f]{6}$'),
  phone text,
  email text,
  address text,
  currency char(3) not null default 'NGN',
  timezone text not null default 'Africa/Lagos',
  status text not null default 'active' check (status in ('active', 'suspended')),
  onboarding_completed_at timestamptz,
  -- operational settings
  reservation_minutes int not null default 30 check (reservation_minutes between 5 and 2880),
  allow_credit_sales boolean not null default true,
  low_stock_default int not null default 5 check (low_stock_default >= 0),
  caption_template text not null default '{name} — {price}{variants}\nOrder: {link}',
  data_retention_months int not null default 72 check (data_retention_months between 12 and 120),
  whatsapp_phone_number_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger businesses_touch before update on public.businesses
  for each row execute function app.touch_updated_at();

-- Payout destination for dedicated virtual accounts (sensitive, owner + aal2 only).
create table public.business_payout_accounts (
  business_id uuid primary key references public.businesses (id) on delete cascade,
  provider text not null default 'paystack',
  bank_code text not null,
  bank_name text,
  account_number text not null check (account_number ~ '^[0-9]{10}$'),
  account_name text,
  provider_subaccount_code text,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null,
  address text,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (business_id, name)
);
create index locations_business_idx on public.locations (business_id);
create unique index locations_one_default on public.locations (business_id) where is_default;

-- ---------------------------------------------------------------------------
-- Staff + permissions
-- ---------------------------------------------------------------------------
create table public.staff_members (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  phone text not null,
  display_name text not null default '',
  role public.staff_role not null,
  status public.staff_status not null default 'invited',
  invited_by uuid,
  invited_at timestamptz not null default now(),
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, phone)
);
create unique index staff_members_user_business on public.staff_members (business_id, user_id) where user_id is not null;
create index staff_members_user_idx on public.staff_members (user_id) where status = 'active';
create trigger staff_members_touch before update on public.staff_members
  for each row execute function app.touch_updated_at();

-- Permission matrix. Rows with business_id null are platform defaults; a business row overrides.
create table public.roles_permissions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses (id) on delete cascade,
  role public.staff_role not null,
  permission text not null,
  allowed boolean not null default true,
  unique nulls not distinct (business_id, role, permission)
);
create index roles_permissions_business_idx on public.roles_permissions (business_id);

insert into public.roles_permissions (business_id, role, permission, allowed)
select null, r.role::public.staff_role, p.permission, true
from (values
  -- owner: everything
  ('owner', 'products.draft'), ('owner', 'products.manage'), ('owner', 'products.import'),
  ('owner', 'prices.manage'), ('owner', 'costs.view'),
  ('owner', 'stock.receive'), ('owner', 'stock.adjust'), ('owner', 'stock.allocate'),
  ('owner', 'orders.view'), ('owner', 'orders.manage'), ('owner', 'sales.create'), ('owner', 'sales.void'),
  ('owner', 'payments.record'), ('owner', 'refunds.issue'), ('owner', 'credit.manage'),
  ('owner', 'customers.view'), ('owner', 'customers.manage'), ('owner', 'customers.approve_wholesale'),
  ('owner', 'staff.manage'), ('owner', 'settings.manage'), ('owner', 'payouts.manage'),
  ('owner', 'reports.view'), ('owner', 'audit.view'), ('owner', 'deliveries.manage'),
  ('owner', 'deliveries.update'), ('owner', 'social.manage'), ('owner', 'expenses.manage'),
  ('owner', 'devices.manage'),
  -- manager: everything except staff and payouts
  ('manager', 'products.draft'), ('manager', 'products.manage'), ('manager', 'products.import'),
  ('manager', 'prices.manage'), ('manager', 'costs.view'),
  ('manager', 'stock.receive'), ('manager', 'stock.adjust'), ('manager', 'stock.allocate'),
  ('manager', 'orders.view'), ('manager', 'orders.manage'), ('manager', 'sales.create'), ('manager', 'sales.void'),
  ('manager', 'payments.record'), ('manager', 'refunds.issue'), ('manager', 'credit.manage'),
  ('manager', 'customers.view'), ('manager', 'customers.manage'), ('manager', 'customers.approve_wholesale'),
  ('manager', 'settings.manage'), ('manager', 'reports.view'), ('manager', 'audit.view'),
  ('manager', 'deliveries.manage'), ('manager', 'deliveries.update'), ('manager', 'social.manage'),
  ('manager', 'expenses.manage'), ('manager', 'devices.manage'),
  -- cashier: sell, take payment, look up customers. Cannot change prices, void, or adjust stock.
  ('cashier', 'products.draft'), ('cashier', 'orders.view'), ('cashier', 'sales.create'),
  ('cashier', 'payments.record'), ('cashier', 'customers.view'), ('cashier', 'customers.manage'),
  -- store keeper: stock in/out, packing, product drafts
  ('store_keeper', 'products.draft'), ('store_keeper', 'products.import'),
  ('store_keeper', 'stock.receive'), ('store_keeper', 'stock.allocate'),
  ('store_keeper', 'orders.view'), ('store_keeper', 'deliveries.manage'), ('store_keeper', 'deliveries.update'),
  -- rider: update own deliveries
  ('rider', 'deliveries.update')
) as p(role, permission)
cross join lateral (select p.role) as r(role);

-- Businesses where the current user is an active staff member (used by RLS, evaluated once per query).
create or replace function app.staff_business_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select s.business_id from public.staff_members s
  where s.user_id = auth.uid() and s.status = 'active'
$$;

create or replace function app.staff_role(p_business uuid) returns public.staff_role
language sql stable security definer set search_path = '' as $$
  select s.role from public.staff_members s
  where s.business_id = p_business and s.user_id = auth.uid() and s.status = 'active'
$$;

create or replace function app.is_staff(p_business uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_service() or app.staff_role(p_business) is not null
$$;

create or replace function app.has_permission(p_business uuid, p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_service() or coalesce((
    select coalesce(
      (select rp.allowed from public.roles_permissions rp
        where rp.business_id = p_business and rp.role = r.role and rp.permission = p_permission),
      (select rp.allowed from public.roles_permissions rp
        where rp.business_id is null and rp.role = r.role and rp.permission = p_permission),
      false)
    from (select app.staff_role(p_business) as role) r
    where r.role is not null
  ), false)
$$;

create or replace function app.require_permission(p_business uuid, p_permission text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.has_permission(p_business, p_permission) then
    raise exception using errcode = '42501', message = 'permission_denied', detail = p_permission;
  end if;
end $$;

-- Owner-sensitive actions (pricing tiers, staff, payouts) need a TOTP-verified session.
create or replace function app.require_aal2() returns void
language plpgsql stable set search_path = '' as $$
begin
  if not app.is_aal2() then
    raise exception using errcode = '42501', message = 'mfa_required',
      hint = 'Verify your authenticator code to continue.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Audit log (append-only; written by app.audit only)
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  actor_id uuid,
  actor_role text,
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_business_created_idx on public.audit_log (business_id, created_at desc);
create index audit_log_entity_idx on public.audit_log (business_id, entity, entity_id);

create or replace function app.audit(
  p_business uuid, p_action text, p_entity text, p_entity_id text,
  p_before jsonb default null, p_after jsonb default null
) returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.audit_log (business_id, actor_id, actor_role, action, entity, entity_id, before, after)
  values (p_business, auth.uid(),
          coalesce(app.staff_role(p_business)::text, case when app.is_service() then 'system' else 'buyer' end),
          p_action, p_entity, p_entity_id, p_before, p_after)
$$;

-- ---------------------------------------------------------------------------
-- Rate limiting (fixed window, keyed by caller-supplied key)
-- ---------------------------------------------------------------------------
create table public.rate_limits (
  key text primary key,
  window_start timestamptz not null,
  hits int not null
);

create or replace function app.rate_limit(p_key text, p_max int, p_window interval) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_hits int;
begin
  insert into public.rate_limits as rl (key, window_start, hits)
  values (p_key, now(), 1)
  on conflict (key) do update set
    hits = case when rl.window_start < now() - p_window then 1 else rl.hits + 1 end,
    window_start = case when rl.window_start < now() - p_window then now() else rl.window_start end
  returning hits into v_hits;
  if v_hits > p_max then
    raise exception using errcode = 'P0429', message = 'rate_limited',
      hint = 'Too many attempts. Please wait and try again.';
  end if;
end $$;

-- Public wrapper used by the app for OTP requests / sign-up attempts. The key is hashed so no
-- phone numbers are stored in plain text in this table.
create or replace function public.check_rate_limit(p_scope text, p_subject text, p_max int, p_window_seconds int)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_scope not in ('otp', 'signup', 'checkout', 'wa_inbound', 'ai_draft', 'import') then
    raise exception using errcode = '22023', message = 'invalid_scope';
  end if;
  perform app.rate_limit(
    p_scope || ':' || encode(extensions.digest(coalesce(p_subject, ''), 'sha256'), 'hex'),
    greatest(1, least(p_max, 1000)),
    make_interval(secs => greatest(1, least(p_window_seconds, 86400))));
end $$;

-- ---------------------------------------------------------------------------
-- Customer tiers + customers (buyers)
-- ---------------------------------------------------------------------------
create table public.customer_tiers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null,
  is_wholesale boolean not null default false,
  default_for public.buyer_type,
  position int not null default 0,
  created_at timestamptz not null default now(),
  unique (business_id, name),
  unique (business_id, id)
);
create unique index customer_tiers_default_for on public.customer_tiers (business_id, default_for)
  where default_for is not null;

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  phone text not null,
  name text not null default '',
  business_name text,
  email text,
  buyer_type public.buyer_type not null default 'retail_buyer',
  wholesale_status public.wholesale_status not null default 'not_applicable',
  tier_id uuid,
  cac_number text,
  shop_photo_path text,
  wholesale_reviewed_by uuid,
  wholesale_reviewed_at timestamptz,
  wholesale_rejection_reason text,
  credit_limit_kobo bigint not null default 0 check (credit_limit_kobo >= 0),
  default_address jsonb,
  notes text,
  marketing_opt_in boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, phone),
  unique (business_id, id),
  foreign key (business_id, tier_id) references public.customer_tiers (business_id, id) on delete set null (tier_id)
);
create index customers_business_idx on public.customers (business_id, created_at desc);
create index customers_user_idx on public.customers (user_id);
create index customers_pending_idx on public.customers (business_id) where wholesale_status = 'pending';
create index customers_name_trgm on public.customers using gin (name extensions.gin_trgm_ops);
create trigger customers_touch before update on public.customers
  for each row execute function app.touch_updated_at();

create or replace function app.my_customer_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select c.id from public.customers c where c.user_id = auth.uid()
$$;

-- (customers_guard is defined after the RPCs below)

-- ---------------------------------------------------------------------------
-- Consent (NDPA 2023)
-- ---------------------------------------------------------------------------
create table public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  business_id uuid references public.businesses (id) on delete cascade,
  kind text not null check (kind in ('terms', 'privacy', 'marketing', 'whatsapp_updates')),
  version text not null,
  granted boolean not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index consents_user_idx on public.consents (user_id, kind, created_at desc);
create index consents_business_idx on public.consents (business_id);

-- ---------------------------------------------------------------------------
-- RPCs: onboarding, staff, buyers
-- ---------------------------------------------------------------------------
create or replace function public.create_business(
  p_name text, p_slug text, p_kind public.business_kind default 'wholesaler',
  p_brand_colour text default '#0F766E', p_display_name text default ''
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_phone text := app.normalize_phone(auth.jwt() ->> 'phone');
  v_business uuid;
begin
  if v_user is null then perform app.raise_forbidden('not_authenticated'); end if;
  if v_phone is null then
    raise exception using errcode = '22023', message = 'phone_required';
  end if;
  perform app.rate_limit('create_business:' || v_user::text, 5, interval '1 day');

  insert into public.businesses (name, slug, kind, brand_colour, phone)
  values (trim(p_name), lower(trim(p_slug)), p_kind, p_brand_colour, v_phone)
  returning id into v_business;

  insert into public.staff_members (business_id, user_id, phone, display_name, role, status, joined_at)
  values (v_business, v_user, v_phone, coalesce(p_display_name, ''), 'owner', 'active', now());

  insert into public.locations (business_id, name, is_default) values (v_business, 'Main shop', true);

  insert into public.customer_tiers (business_id, name, is_wholesale, default_for, position) values
    (v_business, 'Wholesale', true, 'wholesaler', 1),
    (v_business, 'Retailer', false, 'retailer', 2);

  perform app.audit(v_business, 'business.created', 'business', v_business::text, null,
    jsonb_build_object('name', p_name, 'slug', p_slug));
  return v_business;
end $$;

create or replace function public.set_payout_account(
  p_business uuid, p_bank_code text, p_bank_name text, p_account_number text, p_account_name text
) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_before jsonb;
begin
  perform app.require_permission(p_business, 'payouts.manage');
  perform app.require_aal2();
  select to_jsonb(p) - 'account_number' || jsonb_build_object('account_last4', right(p.account_number, 4))
    into v_before from public.business_payout_accounts p where p.business_id = p_business;
  insert into public.business_payout_accounts (business_id, bank_code, bank_name, account_number, account_name, updated_by, updated_at)
  values (p_business, p_bank_code, p_bank_name, p_account_number, p_account_name, auth.uid(), now())
  on conflict (business_id) do update set
    bank_code = excluded.bank_code, bank_name = excluded.bank_name,
    account_number = excluded.account_number, account_name = excluded.account_name,
    provider_subaccount_code = null, updated_by = excluded.updated_by, updated_at = now();
  perform app.audit(p_business, 'payout.updated', 'business_payout_account', p_business::text, v_before,
    jsonb_build_object('bank_code', p_bank_code, 'account_last4', right(p_account_number, 4)));
end $$;

create or replace function public.invite_staff(
  p_business uuid, p_phone text, p_role public.staff_role, p_display_name text default ''
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform app.require_permission(p_business, 'staff.manage');
  perform app.require_aal2();
  if p_role = 'owner' then
    raise exception using errcode = '22023', message = 'cannot_invite_owner';
  end if;
  insert into public.staff_members (business_id, phone, display_name, role, status, invited_by)
  values (p_business, app.normalize_phone(p_phone), coalesce(p_display_name, ''), p_role, 'invited', auth.uid())
  on conflict (business_id, phone) do update
    set role = excluded.role, display_name = excluded.display_name,
        status = case when public.staff_members.status = 'disabled' then 'invited'::public.staff_status
                      else public.staff_members.status end
  returning id into v_id;
  perform app.audit(p_business, 'staff.invited', 'staff_member', v_id::text, null,
    jsonb_build_object('role', p_role));
  return v_id;
end $$;

create or replace function public.set_staff_role(p_staff_id uuid, p_role public.staff_role, p_status public.staff_status default null)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare r public.staff_members;
begin
  select * into r from public.staff_members where id = p_staff_id for update;
  if not found then perform app.raise_forbidden('not_found'); end if;
  perform app.require_permission(r.business_id, 'staff.manage');
  perform app.require_aal2();
  if r.role = 'owner' or p_role = 'owner' then
    raise exception using errcode = '22023', message = 'owner_role_locked';
  end if;
  update public.staff_members set role = p_role, status = coalesce(p_status, status) where id = p_staff_id;
  perform app.audit(r.business_id, 'staff.role_changed', 'staff_member', r.id::text,
    jsonb_build_object('role', r.role, 'status', r.status),
    jsonb_build_object('role', p_role, 'status', coalesce(p_status, r.status)));
end $$;

-- Called after a staff member signs in: links pending invites to this phone and logs the login.
create or replace function public.staff_sign_in() returns setof uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_phone text := app.normalize_phone(auth.jwt() ->> 'phone');
  v_b uuid;
begin
  if v_user is null then perform app.raise_forbidden('not_authenticated'); end if;
  if v_phone is not null then
    update public.staff_members set user_id = v_user, status = 'active', joined_at = now()
    where phone = v_phone and status = 'invited' and user_id is null;
  end if;
  for v_b in select business_id from public.staff_members where user_id = v_user and status = 'active' loop
    perform app.audit(v_b, 'staff.login', 'staff_member', v_user::text, null,
      jsonb_build_object('aal', coalesce(auth.jwt() ->> 'aal', 'aal1')));
    return next v_b;
  end loop;
end $$;

-- Buyer self-registration at a business storefront (phone comes from the verified OTP session).
create or replace function public.register_buyer(
  p_business_slug text, p_buyer_type public.buyer_type, p_name text,
  p_business_name text default null, p_cac_number text default null, p_shop_photo_path text default null,
  p_terms_version text default 'v1', p_marketing_opt_in boolean default false
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_phone text := app.normalize_phone(auth.jwt() ->> 'phone');
  v_business uuid;
  v_customer uuid;
  v_tier uuid;
  v_status public.wholesale_status;
begin
  if v_user is null or v_phone is null then perform app.raise_forbidden('not_authenticated'); end if;
  perform app.rate_limit('signup:' || v_user::text, 10, interval '1 hour');
  select id into v_business from public.businesses where slug = lower(p_business_slug) and status = 'active';
  if v_business is null then perform app.raise_forbidden('business_not_found'); end if;

  if p_buyer_type = 'wholesaler' then
    if coalesce(nullif(trim(p_cac_number), ''), nullif(trim(p_shop_photo_path), '')) is null then
      raise exception using errcode = '22023', message = 'wholesale_proof_required',
        hint = 'Add your CAC number or a photo of your shop.';
    end if;
    v_status := 'pending';
  else
    v_status := 'not_applicable';
    select id into v_tier from public.customer_tiers where business_id = v_business and default_for = p_buyer_type;
  end if;

  insert into public.consents (user_id, business_id, kind, version, granted) values
    (v_user, v_business, 'terms', p_terms_version, true),
    (v_user, v_business, 'privacy', p_terms_version, true),
    (v_user, v_business, 'marketing', p_terms_version, coalesce(p_marketing_opt_in, false));

  insert into public.customers (business_id, user_id, phone, name, business_name, buyer_type,
                                wholesale_status, tier_id, cac_number, shop_photo_path, marketing_opt_in)
  values (v_business, v_user, v_phone, trim(p_name), p_business_name, p_buyer_type,
          v_status, v_tier, nullif(trim(p_cac_number), ''), p_shop_photo_path, coalesce(p_marketing_opt_in, false))
  on conflict (business_id, phone) do update set
    user_id = excluded.user_id,
    name = coalesce(nullif(excluded.name, ''), public.customers.name),
    business_name = coalesce(excluded.business_name, public.customers.business_name),
    buyer_type = excluded.buyer_type,
    wholesale_status = case
      when public.customers.wholesale_status = 'approved' then public.customers.wholesale_status
      else excluded.wholesale_status end,
    tier_id = case
      when public.customers.wholesale_status = 'approved' then public.customers.tier_id
      else excluded.tier_id end,
    cac_number = coalesce(excluded.cac_number, public.customers.cac_number),
    shop_photo_path = coalesce(excluded.shop_photo_path, public.customers.shop_photo_path),
    marketing_opt_in = excluded.marketing_opt_in
  returning id into v_customer;
  return v_customer;
end $$;

create or replace function public.review_wholesale_application(
  p_customer uuid, p_approve boolean, p_tier uuid default null, p_reason text default null
) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare c public.customers; v_tier uuid;
begin
  select * into c from public.customers where id = p_customer for update;
  if not found then perform app.raise_forbidden('not_found'); end if;
  perform app.require_permission(c.business_id, 'customers.approve_wholesale');
  if p_approve then
    v_tier := coalesce(p_tier, (select id from public.customer_tiers
                                where business_id = c.business_id and default_for = 'wholesaler'));
    if v_tier is null then
      raise exception using errcode = '22023', message = 'no_wholesale_tier';
    end if;
    update public.customers set wholesale_status = 'approved', buyer_type = 'wholesaler', tier_id = v_tier,
      wholesale_reviewed_by = auth.uid(), wholesale_reviewed_at = now(), wholesale_rejection_reason = null
    where id = p_customer;
  else
    update public.customers set wholesale_status = 'rejected',
      wholesale_reviewed_by = auth.uid(), wholesale_reviewed_at = now(), wholesale_rejection_reason = p_reason
    where id = p_customer;
  end if;
end $$;

-- Guard: pricing-relevant customer fields. Anyone who may write the row may assign the
-- non-wholesale default tier for the buyer's type; approving wholesale, choosing any other tier,
-- demoting an approved wholesaler or changing credit limits needs extra permissions. Audited.
create or replace function app.tier_is_self_service(p_business uuid, p_tier uuid, p_type public.buyer_type)
returns boolean
language sql stable security definer set search_path = '' as $$
  select p_tier is null or exists (
    select 1 from public.customer_tiers t
    where t.id = p_tier and t.business_id = p_business and not t.is_wholesale and t.default_for = p_type)
$$;

create or replace function app.customers_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old_status public.wholesale_status := case when tg_op = 'UPDATE' then old.wholesale_status end;
  v_old_tier uuid := case when tg_op = 'UPDATE' then old.tier_id end;
  v_old_limit bigint := case when tg_op = 'UPDATE' then old.credit_limit_kobo else 0 end;
  v_needs_approval boolean;
begin
  new.phone := app.normalize_phone(new.phone);
  v_needs_approval :=
       (new.wholesale_status = 'approved' and v_old_status is distinct from 'approved')
    or (v_old_status = 'approved' and new.wholesale_status <> 'approved')
    or (new.tier_id is distinct from v_old_tier
        and not app.tier_is_self_service(new.business_id, new.tier_id, new.buyer_type));
  if v_needs_approval and not app.has_permission(new.business_id, 'customers.approve_wholesale') then
    perform app.raise_forbidden('permission_denied');
  end if;
  if new.credit_limit_kobo is distinct from v_old_limit
     and not app.has_permission(new.business_id, 'credit.manage') then
    perform app.raise_forbidden('permission_denied');
  end if;
  if tg_op = 'UPDATE' and (new.tier_id is distinct from old.tier_id
       or new.wholesale_status is distinct from old.wholesale_status
       or new.credit_limit_kobo is distinct from old.credit_limit_kobo) then
    perform app.audit(new.business_id, 'customer.pricing_change', 'customer', new.id::text,
      jsonb_build_object('tier_id', old.tier_id, 'wholesale_status', old.wholesale_status, 'credit_limit_kobo', old.credit_limit_kobo),
      jsonb_build_object('tier_id', new.tier_id, 'wholesale_status', new.wholesale_status, 'credit_limit_kobo', new.credit_limit_kobo));
  end if;
  return new;
end $$;
create trigger customers_guard before insert or update on public.customers
  for each row execute function app.customers_guard();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.businesses enable row level security;
alter table public.business_payout_accounts enable row level security;
alter table public.locations enable row level security;
alter table public.staff_members enable row level security;
alter table public.roles_permissions enable row level security;
alter table public.audit_log enable row level security;
alter table public.rate_limits enable row level security;
alter table public.customer_tiers enable row level security;
alter table public.customers enable row level security;
alter table public.consents enable row level security;

-- businesses: public storefront info is readable; staff with settings.manage may update.
create policy businesses_public_read on public.businesses for select to anon, authenticated
  using (status = 'active' or id in (select app.staff_business_ids()));
create policy businesses_update on public.businesses for update to authenticated
  using (app.has_permission(id, 'settings.manage'))
  with check (app.has_permission(id, 'settings.manage'));
-- inserts go through create_business(); no insert/delete policy.

create policy payout_read on public.business_payout_accounts for select to authenticated
  using (app.has_permission(business_id, 'payouts.manage'));
-- writes only through set_payout_account()

create policy locations_read on public.locations for select to authenticated
  using (business_id in (select app.staff_business_ids()));
create policy locations_write on public.locations for all to authenticated
  using (app.has_permission(business_id, 'settings.manage'))
  with check (app.has_permission(business_id, 'settings.manage'));

create policy staff_read on public.staff_members for select to authenticated
  using (business_id in (select app.staff_business_ids()) or user_id = auth.uid());
-- writes only through invite_staff() / set_staff_role()

create policy roles_permissions_read on public.roles_permissions for select to authenticated
  using (business_id is null or business_id in (select app.staff_business_ids()));
create policy roles_permissions_write on public.roles_permissions for all to authenticated
  using (business_id is not null and app.has_permission(business_id, 'staff.manage') and app.is_aal2())
  with check (business_id is not null and app.has_permission(business_id, 'staff.manage') and app.is_aal2());

create policy audit_read on public.audit_log for select to authenticated
  using (app.has_permission(business_id, 'audit.view'));

-- rate_limits: no policies (deny all to API roles)

create policy tiers_staff_read on public.customer_tiers for select to authenticated
  using (business_id in (select app.staff_business_ids())
         or id in (select c.tier_id from public.customers c where c.user_id = auth.uid()));
create policy tiers_write on public.customer_tiers for all to authenticated
  using (app.has_permission(business_id, 'prices.manage') and app.is_aal2())
  with check (app.has_permission(business_id, 'prices.manage') and app.is_aal2());

create policy customers_staff_read on public.customers for select to authenticated
  using (app.has_permission(business_id, 'customers.view') or user_id = auth.uid());
create policy customers_staff_insert on public.customers for insert to authenticated
  with check (app.has_permission(business_id, 'customers.manage'));
create policy customers_staff_update on public.customers for update to authenticated
  using (app.has_permission(business_id, 'customers.manage'))
  with check (app.has_permission(business_id, 'customers.manage'));

create policy consents_own on public.consents for select to authenticated using (user_id = auth.uid());
create policy consents_insert_own on public.consents for insert to authenticated with check (user_id = auth.uid());

-- Ledger-like tables are never written directly by API roles.
revoke insert, update, delete on public.audit_log, public.rate_limits, public.business_payout_accounts
  from anon, authenticated;
revoke insert, update, delete on public.staff_members from anon, authenticated;
revoke all on public.staff_members, public.roles_permissions, public.audit_log, public.business_payout_accounts from anon;
revoke insert, delete on public.businesses from anon, authenticated;
revoke all on public.rate_limits from anon, authenticated;

-- Function execution: helpers are callable (they are needed inside RLS), RPCs are for authenticated.
revoke execute on function app.audit(uuid, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function app.rate_limit(text, int, interval) from public, anon, authenticated;
revoke execute on function public.create_business(text, text, public.business_kind, text, text) from public, anon;
revoke execute on function public.set_payout_account(uuid, text, text, text, text) from public, anon;
revoke execute on function public.invite_staff(uuid, text, public.staff_role, text) from public, anon;
revoke execute on function public.set_staff_role(uuid, public.staff_role, public.staff_status) from public, anon;
revoke execute on function public.staff_sign_in() from public, anon;
revoke execute on function public.register_buyer(text, public.buyer_type, text, text, text, text, text, boolean) from public, anon;
revoke execute on function public.review_wholesale_application(uuid, boolean, uuid, text) from public, anon;
