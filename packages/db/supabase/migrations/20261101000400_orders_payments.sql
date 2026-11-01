-- Orders, payments, virtual accounts, webhooks, carts; checkout + payment application.

create type public.order_status as enum ('pending', 'confirmed', 'completed', 'cancelled', 'expired');
create type public.payment_status as enum ('unpaid', 'partial', 'paid', 'refunded');
create type public.fulfilment_status as enum ('unfulfilled', 'confirmed', 'packed', 'dispatched', 'delivered', 'failed', 'returned', 'collected');
create type public.payment_method as enum ('cash', 'card_terminal', 'transfer', 'ussd', 'qr', 'virtual_account', 'store_credit');
create type public.delivery_method as enum ('pickup', 'delivery', 'in_store');

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  order_number bigint not null,
  customer_id uuid,
  channel public.sales_channel not null,
  status public.order_status not null default 'pending',
  payment_status public.payment_status not null default 'unpaid',
  fulfilment_status public.fulfilment_status not null default 'unfulfilled',
  location_id uuid not null references public.locations (id),
  device_id uuid,
  staff_id uuid,
  client_id uuid,
  subtotal_kobo bigint not null default 0 check (subtotal_kobo >= 0),
  discount_kobo bigint not null default 0 check (discount_kobo >= 0),
  delivery_fee_kobo bigint not null default 0 check (delivery_fee_kobo >= 0),
  total_kobo bigint not null default 0 check (total_kobo >= 0),
  amount_paid_kobo bigint not null default 0 check (amount_paid_kobo >= 0),
  balance_kobo bigint generated always as (greatest(total_kobo - amount_paid_kobo, 0)) stored,
  is_credit boolean not null default false,
  due_date date,
  reservation_expires_at timestamptz,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  needs_attention text,
  delivery_method public.delivery_method not null default 'pickup',
  delivery_address jsonb,
  buyer_name text,
  buyer_phone text,
  note text,
  tracking_token text not null unique default app.random_token(16),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, order_number),
  unique (business_id, id),
  foreign key (business_id, customer_id) references public.customers (business_id, id) on delete set null (customer_id),
  foreign key (business_id, device_id) references public.devices (business_id, id) on delete set null (device_id)
);
create unique index orders_client_id on public.orders (business_id, client_id) where client_id is not null;
create index orders_business_created_idx on public.orders (business_id, created_at desc);
create index orders_business_status_idx on public.orders (business_id, status, created_at desc);
create index orders_customer_idx on public.orders (customer_id, created_at desc);
create index orders_expiry_idx on public.orders (reservation_expires_at) where status = 'pending';
create index orders_open_balance_idx on public.orders (business_id, customer_id) where balance_kobo > 0 and status in ('pending', 'confirmed', 'completed');
create trigger orders_touch before update on public.orders for each row execute function app.touch_updated_at();

alter table public.stock_movements
  add constraint stock_movements_order_fk foreign key (order_id) references public.orders (id) on delete set null not valid;
alter table public.stock_movements
  add constraint stock_movements_device_fk foreign key (device_id) references public.devices (id) on delete set null not valid;

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  order_id uuid not null,
  product_id uuid not null,
  variant_id uuid not null,
  unit_id uuid not null references public.units (id),
  unit_qty int not null check (unit_qty > 0),
  base_qty int not null check (base_qty > 0),
  unit_price_kobo bigint not null check (unit_price_kobo >= 0),      -- per base unit
  line_total_kobo bigint not null check (line_total_kobo >= 0),
  price_source text not null,
  unit_cost_kobo bigint,                                              -- snapshot, staff-only column
  name text not null,
  variant_label text,
  sku text,
  location_id uuid not null references public.locations (id),
  conflict_qty int not null default 0 check (conflict_qty >= 0),
  created_at timestamptz not null default now(),
  foreign key (business_id, order_id) references public.orders (business_id, id) on delete cascade,
  foreign key (business_id, variant_id) references public.product_variants (business_id, id)
);
create index order_items_order_idx on public.order_items (order_id);
create index order_items_variant_idx on public.order_items (business_id, variant_id);

create table public.virtual_accounts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  customer_id uuid not null,
  provider text not null,
  provider_customer_code text,
  provider_ref text,
  account_number text not null,
  account_name text not null,
  bank_name text not null,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  unique (business_id, customer_id, provider),
  unique (provider, account_number),
  foreign key (business_id, customer_id) references public.customers (business_id, id) on delete cascade
);
create index virtual_accounts_business_idx on public.virtual_accounts (business_id);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  order_id uuid,
  customer_id uuid,
  method public.payment_method not null,
  amount_kobo bigint not null check (amount_kobo > 0),
  status text not null default 'succeeded' check (status in ('succeeded', 'reversed')),
  provider text,
  provider_ref text,
  client_id uuid,
  device_id uuid,
  received_by uuid,
  note text,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  foreign key (business_id, order_id) references public.orders (business_id, id) on delete set null (order_id),
  foreign key (business_id, customer_id) references public.customers (business_id, id) on delete set null (customer_id)
);
create unique index payments_provider_ref on public.payments (provider, provider_ref) where provider_ref is not null;
create unique index payments_client_id on public.payments (business_id, client_id) where client_id is not null;
create index payments_order_idx on public.payments (order_id);
create index payments_business_idx on public.payments (business_id, received_at desc);
create index payments_customer_unallocated_idx on public.payments (business_id, customer_id) where order_id is null;

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  event_id text not null,
  event_type text,
  business_id uuid references public.businesses (id) on delete set null,
  payload jsonb not null,
  signature_valid boolean not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  attempts int not null default 0,
  last_error text,
  unique (provider, event_id)
);
create index webhook_events_unprocessed_idx on public.webhook_events (received_at) where processed_at is null;

create table public.carts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  customer_id uuid,
  channel public.sales_channel not null,
  status text not null default 'open' check (status in ('open', 'converted', 'abandoned')),
  order_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (business_id, customer_id) references public.customers (business_id, id) on delete cascade,
  unique (business_id, id)
);
create index carts_customer_idx on public.carts (customer_id, status);
create trigger carts_touch before update on public.carts for each row execute function app.touch_updated_at();

create table public.cart_items (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  cart_id uuid not null,
  variant_id uuid not null,
  unit_id uuid not null references public.units (id),
  unit_qty int not null check (unit_qty > 0),
  created_at timestamptz not null default now(),
  unique (cart_id, variant_id, unit_id),
  foreign key (business_id, cart_id) references public.carts (business_id, id) on delete cascade,
  foreign key (business_id, variant_id) references public.product_variants (business_id, id) on delete cascade
);
create index cart_items_business_idx on public.cart_items (business_id);

-- ---------------------------------------------------------------------------
-- Checkout
-- ---------------------------------------------------------------------------

-- Who may place an order with which channel / customer. Returns the effective customer id.
create or replace function app.checkout_actor(p_business uuid, p_channel public.sales_channel, p_customer uuid)
returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare v_self uuid;
begin
  if app.is_service() then
    return p_customer;
  end if;
  if app.has_permission(p_business, 'sales.create') then
    if p_customer is not null and not exists (select 1 from public.customers where id = p_customer and business_id = p_business) then
      raise exception using errcode = '22023', message = 'unknown_customer';
    end if;
    return p_customer;
  end if;
  -- buyer self-checkout: always themselves, web/instagram/facebook only
  if p_channel not in ('web', 'instagram', 'facebook') then
    perform app.raise_forbidden('channel_not_allowed');
  end if;
  v_self := public.my_customer_id(p_business);
  if v_self is null then perform app.raise_forbidden('register_first'); end if;
  return v_self;
end $$;

-- Place an order: price every line server-side with resolve_price, then reserve all stock in the
-- same transaction. Input:
-- { business_id, channel, customer_id?, client_id?, device_id?, location_id?,
--   items: [{variant_id, unit_id?, qty}], delivery_method?, delivery_address?, delivery_fee_kobo?,
--   buyer_name?, buyer_phone?, note? }
-- Idempotent on client_id: a retry returns the original order.
create or replace function public.place_order(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_business uuid := (p ->> 'business_id')::uuid;
  v_channel public.sales_channel := coalesce(p ->> 'channel', 'web')::public.sales_channel;
  v_client uuid := (p ->> 'client_id')::uuid;
  v_customer uuid;
  v_location uuid;
  v_order public.orders;
  v_biz public.businesses;
  v_items jsonb := '[]'::jsonb;
  v_reserve jsonb := '[]'::jsonb;
  it record;
  agg record;
  v_quote public.price_quote;
  v_subtotal bigint := 0;
  v_fee bigint := greatest(coalesce((p ->> 'delivery_fee_kobo')::bigint, 0), 0);
begin
  select * into v_biz from public.businesses where id = v_business and status = 'active';
  if not found then raise exception using errcode = '22023', message = 'unknown_business'; end if;

  if v_client is not null then
    select * into v_order from public.orders where business_id = v_business and client_id = v_client;
    if found then return app.order_json(v_order.id); end if;
  end if;

  v_customer := app.checkout_actor(v_business, v_channel, (p ->> 'customer_id')::uuid);
  if not app.is_service() then
    perform app.rate_limit('checkout:' || coalesce(auth.uid()::text, 'anon'), 60, interval '10 minutes');
  end if;

  v_location := coalesce((p ->> 'location_id')::uuid, app.default_location(v_business));
  if not exists (select 1 from public.locations where id = v_location and business_id = v_business) then
    raise exception using errcode = '22023', message = 'invalid_location';
  end if;
  if jsonb_typeof(p -> 'items') <> 'array' or jsonb_array_length(p -> 'items') = 0 then
    raise exception using errcode = '22023', message = 'no_items';
  end if;
  if jsonb_array_length(p -> 'items') > 200 then
    raise exception using errcode = '22023', message = 'too_many_items';
  end if;

  -- Resolve each line to base units.
  for it in
    select (i ->> 'variant_id')::uuid as variant_id, (i ->> 'unit_id')::uuid as unit_id, (i ->> 'qty')::int as qty
    from jsonb_array_elements(p -> 'items') i
  loop
    declare
      v public.product_variants;
      pr public.products;
      v_unit uuid;
      v_base int;
    begin
      select * into v from public.product_variants where id = it.variant_id and business_id = v_business;
      if not found then raise exception using errcode = '22023', message = 'unknown_variant'; end if;
      select * into pr from public.products where id = v.product_id;
      if pr.status <> 'active' or not v.is_active then
        raise exception using errcode = '22023', message = 'product_unavailable', detail = v.id::text;
      end if;
      if it.qty is null or it.qty <= 0 or it.qty > 1000000 then
        raise exception using errcode = '22023', message = 'invalid_qty';
      end if;
      v_unit := coalesce(it.unit_id, pr.base_unit_id);
      v_base := public.to_base_qty(pr.id, v_unit, it.qty);
      v_items := v_items || jsonb_build_object(
        'variant_id', v.id, 'product_id', pr.id, 'unit_id', v_unit, 'unit_qty', it.qty, 'base_qty', v_base,
        'name', pr.name, 'variant_label', nullif(concat_ws(' / ', v.colour, v.size), ''), 'sku', v.sku);
    end;
  end loop;

  -- Price on the total base quantity per variant (1 carton + 3 pieces counts as 15 pieces).
  for agg in
    select (x ->> 'variant_id')::uuid as variant_id, sum((x ->> 'base_qty')::int)::int as base_qty
    from jsonb_array_elements(v_items) x group by 1
  loop
    v_quote := app.resolve_price_unchecked(agg.variant_id, v_customer, agg.base_qty, v_channel);
    select jsonb_agg(case when (x ->> 'variant_id')::uuid = agg.variant_id
                          then x || jsonb_build_object('unit_price_kobo', (v_quote).unit_price_kobo, 'price_source', (v_quote).source)
                          else x end)
      into v_items from jsonb_array_elements(v_items) x;
    v_reserve := v_reserve || jsonb_build_object('variant_id', agg.variant_id, 'qty', agg.base_qty, 'location_id', v_location);
  end loop;

  select coalesce(sum((x ->> 'unit_price_kobo')::bigint * (x ->> 'base_qty')::int), 0) into v_subtotal
  from jsonb_array_elements(v_items) x;

  insert into public.orders (business_id, order_number, customer_id, channel, location_id, device_id, staff_id,
                             client_id, subtotal_kobo, delivery_fee_kobo, total_kobo, reservation_expires_at,
                             delivery_method, delivery_address, buyer_name, buyer_phone, note)
  values (v_business, app.next_counter(v_business, 'order'), v_customer, v_channel, v_location,
          (p ->> 'device_id')::uuid, case when app.is_staff(v_business) and not app.is_service() then auth.uid() end,
          v_client, v_subtotal, v_fee, v_subtotal + v_fee,
          now() + make_interval(mins => v_biz.reservation_minutes),
          coalesce(p ->> 'delivery_method', case when v_channel = 'pos' then 'in_store' else 'pickup' end)::public.delivery_method,
          p -> 'delivery_address', left(p ->> 'buyer_name', 120),
          case when p ->> 'buyer_phone' is not null then app.normalize_phone(p ->> 'buyer_phone') end,
          left(p ->> 'note', 1000))
  returning * into v_order;

  insert into public.order_items (business_id, order_id, product_id, variant_id, unit_id, unit_qty, base_qty,
                                  unit_price_kobo, line_total_kobo, price_source, unit_cost_kobo, name,
                                  variant_label, sku, location_id)
  select v_business, v_order.id, (x ->> 'product_id')::uuid, (x ->> 'variant_id')::uuid, (x ->> 'unit_id')::uuid,
         (x ->> 'unit_qty')::int, (x ->> 'base_qty')::int, (x ->> 'unit_price_kobo')::bigint,
         (x ->> 'unit_price_kobo')::bigint * (x ->> 'base_qty')::int, x ->> 'price_source',
         (select vc.cost_kobo from public.variant_costs vc where vc.variant_id = (x ->> 'variant_id')::uuid),
         x ->> 'name', x ->> 'variant_label', x ->> 'sku', v_location
  from jsonb_array_elements(v_items) x;

  perform public.reserve_stock(v_order.id, v_reserve, v_channel);

  if v_order.total_kobo = 0 then
    perform app.confirm_order(v_order.id);
  end if;
  return app.order_json(v_order.id);
end $$;

create or replace function app.order_json(p_order uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select to_jsonb(o) - 'client_id' || jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(i) - 'unit_cost_kobo' - 'business_id' order by i.created_at, i.name)
                       from public.order_items i where i.order_id = o.id), '[]'::jsonb))
  from public.orders o where o.id = p_order
$$;

-- Stock leaves the shelf: reservation → sale. Called when fully paid or confirmed on credit.
create or replace function app.confirm_order(p_order uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order for update;
  if o.status in ('confirmed', 'completed') then return; end if;
  if o.status in ('cancelled', 'expired') then
    -- stock was released; take it again or flag the order for a human.
    begin
      perform public.reserve_stock(o.id,
        (select jsonb_agg(jsonb_build_object('variant_id', variant_id, 'qty', base_qty, 'location_id', location_id))
         from public.order_items where order_id = o.id), o.channel);
    exception when sqlstate 'P0409' then
      update public.orders set needs_attention = 'paid_after_expiry_out_of_stock' where id = o.id;
      return;
    end;
  end if;
  perform public.commit_sale(o.id, o.channel);
  update public.orders set status = 'confirmed', confirmed_at = now(), reservation_expires_at = null,
    fulfilment_status = case when o.channel = 'pos' and o.delivery_method = 'in_store' then 'collected'::public.fulfilment_status
                             else 'confirmed'::public.fulfilment_status end
  where id = o.id;
end $$;

-- Apply money to an order (idempotent on provider_ref / client_id). Confirms the order when paid
-- in full. Overpayments and payments without an order stay unallocated on the customer.
create or replace function app.apply_payment(
  p_business uuid, p_order uuid, p_customer uuid, p_amount bigint, p_method public.payment_method,
  p_provider text default null, p_provider_ref text default null, p_client_id uuid default null,
  p_device uuid default null, p_note text default null, p_received_at timestamptz default now()
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_payment uuid;
  o public.orders;
  v_apply bigint;
begin
  if p_amount is null or p_amount <= 0 then raise exception using errcode = '22023', message = 'invalid_amount'; end if;
  if p_provider_ref is not null then
    select id into v_payment from public.payments where provider = p_provider and provider_ref = p_provider_ref;
    if found then return v_payment; end if;
  end if;
  if p_client_id is not null then
    select id into v_payment from public.payments where business_id = p_business and client_id = p_client_id;
    if found then return v_payment; end if;
  end if;

  if p_order is not null then
    select * into o from public.orders where id = p_order and business_id = p_business for update;
    if not found then raise exception using errcode = '22023', message = 'unknown_order'; end if;
  end if;

  v_apply := case when o.id is null then 0 else least(p_amount, greatest(o.total_kobo - o.amount_paid_kobo, 0)) end;

  if v_apply > 0 then
    insert into public.payments (business_id, order_id, customer_id, method, amount_kobo, provider, provider_ref,
                                 client_id, device_id, received_by, note, received_at)
    values (p_business, o.id, coalesce(o.customer_id, p_customer), p_method, v_apply, p_provider, p_provider_ref,
            p_client_id, p_device, auth.uid(), p_note, p_received_at)
    returning id into v_payment;
    update public.orders set amount_paid_kobo = amount_paid_kobo + v_apply,
      payment_status = case when amount_paid_kobo + v_apply >= total_kobo then 'paid'::public.payment_status
                            else 'partial'::public.payment_status end
    where id = o.id returning * into o;
    if o.amount_paid_kobo >= o.total_kobo then
      perform app.confirm_order(o.id);
    end if;
  end if;

  if p_amount - v_apply > 0 then
    -- remainder (or the whole amount when there is no order) is kept as an unallocated payment
    insert into public.payments (business_id, order_id, customer_id, method, amount_kobo, provider, provider_ref,
                                 client_id, device_id, received_by, note, received_at)
    values (p_business, null, coalesce(o.customer_id, p_customer), p_method, p_amount - v_apply, p_provider,
            case when v_apply > 0 and p_provider_ref is not null then p_provider_ref || ':excess' else p_provider_ref end,
            case when v_apply > 0 then null else p_client_id end, p_device, auth.uid(),
            coalesce(p_note, 'unallocated'), p_received_at)
    returning id into v_payment;
  end if;
  return v_payment;
end $$;

-- Staff records a payment (cash / terminal / transfer / USSD / QR) against an order.
create or replace function public.record_payment(
  p_order uuid, p_amount bigint, p_method public.payment_method, p_note text default null, p_client_id uuid default null
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order;
  if not found then perform app.raise_forbidden('not_found'); end if;
  perform app.require_permission(o.business_id, 'payments.record');
  if p_method = 'virtual_account' then
    raise exception using errcode = '22023', message = 'virtual_account_payments_come_from_webhooks';
  end if;
  return app.apply_payment(o.business_id, o.id, o.customer_id, p_amount, p_method, null, null, p_client_id);
end $$;

-- Paystack (or any provider) dedicated-account credit, called by the webhook handler (service).
create or replace function public.apply_virtual_account_payment(
  p_provider text, p_account_number text, p_amount bigint, p_reference text,
  p_paid_at timestamptz default now(), p_order uuid default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare va public.virtual_accounts; v_order uuid := p_order; v_payment uuid;
begin
  if not app.is_service() then perform app.raise_forbidden(); end if;
  select * into va from public.virtual_accounts where provider = p_provider and account_number = p_account_number;
  if not found then raise exception using errcode = '22023', message = 'unknown_virtual_account'; end if;
  if v_order is null then
    -- Transfers to a dedicated account carry no order id. Allocate to: an open order whose
    -- balance equals the amount (newest first), else the oldest pending order, else the oldest
    -- order with a balance (credit sales). Anything left stays unallocated on the customer.
    select id into v_order from public.orders
     where business_id = va.business_id and customer_id = va.customer_id
       and balance_kobo > 0 and status in ('pending', 'confirmed', 'completed', 'expired')
     order by (balance_kobo = p_amount) desc,
              case when balance_kobo = p_amount then created_at end desc nulls last,
              (status = 'pending') desc, created_at
     limit 1 for update;
  end if;
  v_payment := app.apply_payment(va.business_id, v_order, va.customer_id, p_amount, 'virtual_account',
                                 p_provider, p_reference, null, null, null, p_paid_at);
  return jsonb_build_object('business_id', va.business_id, 'customer_id', va.customer_id,
                            'order_id', v_order, 'payment_id', v_payment);
end $$;

create or replace function public.cancel_order(p_order uuid, p_reason text default null) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then perform app.raise_forbidden('not_found'); end if;
  if not (app.has_permission(o.business_id, 'orders.manage')
          or (o.customer_id in (select app.my_customer_ids()) and o.status = 'pending' and o.amount_paid_kobo = 0)) then
    perform app.raise_forbidden('permission_denied');
  end if;
  if o.status in ('cancelled', 'expired') then return; end if;
  if o.status in ('confirmed', 'completed') then
    raise exception using errcode = '22023', message = 'order_already_confirmed',
      hint = 'Use a return/refund for confirmed orders.';
  end if;
  perform public.release_reservation(o.id, coalesce(p_reason, 'cancelled'));
  update public.orders set status = 'cancelled', cancelled_at = now(), cancel_reason = p_reason,
    reservation_expires_at = null
  where id = o.id;
  perform app.audit(o.business_id, 'order.cancelled', 'order', o.id::text,
    jsonb_build_object('status', o.status), jsonb_build_object('status', 'cancelled', 'reason', p_reason));
end $$;

-- pg_cron, every minute. Unpaid pending orders past their timer give stock back.
create or replace function public.expire_reservations(p_limit int default 500) returns int
language plpgsql volatile security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in
    select id from public.orders
     where status = 'pending' and payment_status = 'unpaid' and reservation_expires_at < now()
     order by reservation_expires_at
     limit p_limit
     for update skip locked
  loop
    perform public.release_reservation(r.id, 'expired');
    update public.orders set status = 'expired', reservation_expires_at = null where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Buyer-facing order read (own orders) without staff-only fields.
create or replace function public.get_order(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order;
  if not found or not (app.is_staff(o.business_id) or o.customer_id in (select app.my_customer_ids())) then
    return null;
  end if;
  return app.order_json(o.id);
end $$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.virtual_accounts enable row level security;
alter table public.payments enable row level security;
alter table public.webhook_events enable row level security;
alter table public.carts enable row level security;
alter table public.cart_items enable row level security;

create policy orders_read on public.orders for select to authenticated
  using (app.has_permission(business_id, 'orders.view') or customer_id in (select app.my_customer_ids()));
create policy orders_staff_update on public.orders for update to authenticated
  using (app.has_permission(business_id, 'orders.manage'))
  with check (app.has_permission(business_id, 'orders.manage'));

create policy order_items_read on public.order_items for select to authenticated
  using (app.has_permission(business_id, 'orders.view')
         or order_id in (select o.id from public.orders o where o.customer_id in (select app.my_customer_ids())));

create policy virtual_accounts_read on public.virtual_accounts for select to authenticated
  using (app.has_permission(business_id, 'customers.view') or customer_id in (select app.my_customer_ids()));

create policy payments_read on public.payments for select to authenticated
  using (app.has_permission(business_id, 'orders.view') or customer_id in (select app.my_customer_ids()));

-- webhook_events: service role only (no policies)

create policy carts_own on public.carts for all to authenticated
  using (customer_id in (select app.my_customer_ids()) or app.has_permission(business_id, 'sales.create'))
  with check (customer_id in (select app.my_customer_ids()) or app.has_permission(business_id, 'sales.create'));
create policy cart_items_own on public.cart_items for all to authenticated
  using (cart_id in (select c.id from public.carts c where c.customer_id in (select app.my_customer_ids()))
         or app.has_permission(business_id, 'sales.create'))
  with check (cart_id in (select c.id from public.carts c where c.customer_id in (select app.my_customer_ids()))
              or app.has_permission(business_id, 'sales.create'));

-- Only the functions above write orders, items, payments and virtual accounts.
revoke insert, delete, truncate on public.orders from anon, authenticated;
revoke all on public.order_items, public.payments, public.virtual_accounts, public.webhook_events from anon;
revoke insert, update, delete, truncate on public.order_items, public.payments, public.virtual_accounts from authenticated;
revoke all on public.webhook_events from authenticated;
revoke all on public.orders, public.carts, public.cart_items from anon;
-- Cost snapshots are staff-report data: hide the column from API roles entirely.
revoke select on public.order_items from authenticated;
grant select (id, business_id, order_id, product_id, variant_id, unit_id, unit_qty, base_qty, unit_price_kobo,
              line_total_kobo, price_source, name, variant_label, sku, location_id, conflict_qty, created_at)
  on public.order_items to authenticated;
-- Staff may only change fulfilment-ish fields directly; money/state columns change through functions.
revoke update on public.orders from authenticated;
grant update (note, delivery_address, delivery_method, needs_attention) on public.orders to authenticated;

revoke execute on function public.apply_virtual_account_payment(text, text, bigint, text, timestamptz, uuid) from public, anon, authenticated;
revoke execute on function public.expire_reservations(int) from public, anon, authenticated;
revoke execute on function public.place_order(jsonb) from public, anon;
revoke execute on function public.record_payment(uuid, bigint, public.payment_method, text, uuid) from public, anon;
revoke execute on function public.cancel_order(uuid, text) from public, anon;
do $$ declare f text; begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app' and p.proname in ('apply_payment', 'confirm_order', 'checkout_actor', 'order_json')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- Realtime: buyers subscribe to their own order row (RLS applies to Realtime too).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.orders;
  end if;
end $$;

-- Live order updates for the API's SSE stream (LISTEN trawer_orders). Payload is only the id;
-- listeners re-read through RLS.
create or replace function app.notify_order_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status or new.payment_status is distinct from old.payment_status
     or new.fulfilment_status is distinct from old.fulfilment_status or new.amount_paid_kobo is distinct from old.amount_paid_kobo then
    perform pg_notify('trawer_orders', new.id::text);
  end if;
  return null;
end $$;
create trigger orders_notify after insert or update on public.orders
  for each row execute function app.notify_order_change();
