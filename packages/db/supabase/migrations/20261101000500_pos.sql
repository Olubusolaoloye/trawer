-- POS: offline sale sync (idempotent), device state, end-of-day cash-up.

create table public.cash_ups (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  staff_user_id uuid not null,
  device_id uuid,
  day date not null,
  expected jsonb not null,                -- {"cash": kobo, "card_terminal": kobo, ...} from the server ledger
  counted_cash_kobo bigint not null check (counted_cash_kobo >= 0),
  variance_kobo bigint not null,          -- counted - expected cash
  note text,
  created_at timestamptz not null default now(),
  unique (business_id, staff_user_id, day),
  foreign key (business_id, device_id) references public.devices (business_id, id) on delete set null (device_id)
);
create index cash_ups_business_day_idx on public.cash_ups (business_id, day desc);

alter table public.cash_ups enable row level security;
create policy cash_ups_read on public.cash_ups for select to authenticated
  using (staff_user_id = auth.uid() or app.has_permission(business_id, 'reports.view'));
revoke insert, update, delete on public.cash_ups from anon, authenticated;
revoke all on public.cash_ups from anon;

-- Sale recorded on a device while offline (or online). Payload:
-- { device_id, client_id, sold_at, customer_id?, note?,
--   items: [{variant_id, unit_id?, qty, unit_price_kobo}],   -- price the device charged, per base unit
--   payments: [{client_id, method, amount_kobo}] }
-- Stock for each line comes from: 1) the device's allocation, 2) the shared pool, 3) otherwise
-- the shortfall is recorded as a conflict (stock_alerts + order_items.conflict_qty). Online stock
-- never goes negative. Retrying the same client_id returns the original result.
create or replace function public.sync_pos_sale(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  d public.devices;
  v_client uuid := (p ->> 'client_id')::uuid;
  v_existing public.orders;
  v_order public.orders;
  v_customer uuid := (p ->> 'customer_id')::uuid;
  v_sold_at timestamptz := least(coalesce((p ->> 'sold_at')::timestamptz, now()), now());
  it record;
  agg record;
  lvl public.stock_levels;
  v_alloc int;
  v_from_alloc int;
  v_from_pool int;
  v_short int;
  v_conflicts jsonb := '[]'::jsonb;
  v_flags text[] := '{}';
  v_subtotal bigint := 0;
  pay record;
  v_server_price bigint;
begin
  select * into d from public.devices where id = (p ->> 'device_id')::uuid;
  if not found or d.status <> 'active' then raise exception using errcode = '22023', message = 'invalid_device'; end if;
  perform app.require_permission(d.business_id, 'sales.create');
  if v_client is null then raise exception using errcode = '22023', message = 'client_id_required'; end if;

  -- Idempotency: serialise concurrent retries of the same sale, then look it up.
  perform pg_advisory_xact_lock(hashtextextended(d.business_id::text || v_client::text, 0));
  select * into v_existing from public.orders where business_id = d.business_id and client_id = v_client;
  if found then
    return jsonb_build_object('status', 'duplicate', 'client_id', v_client, 'order_id', v_existing.id,
                              'order_number', v_existing.order_number);
  end if;

  if v_customer is not null and not exists (select 1 from public.customers where id = v_customer and business_id = d.business_id) then
    v_customer := null;
    v_flags := array_append(v_flags, 'unknown_customer');
  end if;
  if jsonb_typeof(p -> 'items') <> 'array' or jsonb_array_length(p -> 'items') = 0 then
    raise exception using errcode = '22023', message = 'no_items';
  end if;

  insert into public.orders (business_id, order_number, customer_id, channel, status, payment_status, fulfilment_status,
                             location_id, device_id, staff_id, client_id, delivery_method, note, confirmed_at, created_at)
  values (d.business_id, app.next_counter(d.business_id, 'order'), v_customer, 'pos', 'confirmed', 'unpaid', 'collected',
          d.location_id, d.id, auth.uid(), v_client, 'in_store', left(p ->> 'note', 1000), v_sold_at, v_sold_at)
  returning * into v_order;

  for it in
    select (i ->> 'variant_id')::uuid variant_id, (i ->> 'unit_id')::uuid unit_id, (i ->> 'qty')::int qty,
           (i ->> 'unit_price_kobo')::bigint unit_price_kobo, ord
    from jsonb_array_elements(p -> 'items') with ordinality as t(i, ord)
  loop
    declare v public.product_variants; pr public.products; v_unit uuid; v_base int;
    begin
      select * into v from public.product_variants where id = it.variant_id and business_id = d.business_id;
      if not found then raise exception using errcode = '22023', message = 'unknown_variant'; end if;
      select * into pr from public.products where id = v.product_id;
      if it.qty is null or it.qty <= 0 then raise exception using errcode = '22023', message = 'invalid_qty'; end if;
      if it.unit_price_kobo is null or it.unit_price_kobo < 0 then raise exception using errcode = '22023', message = 'invalid_price'; end if;
      v_unit := coalesce(it.unit_id, pr.base_unit_id);
      v_base := public.to_base_qty(pr.id, v_unit, it.qty);
      insert into public.order_items (business_id, order_id, product_id, variant_id, unit_id, unit_qty, base_qty,
                                      unit_price_kobo, line_total_kobo, price_source, unit_cost_kobo, name, variant_label, sku, location_id)
      values (d.business_id, v_order.id, pr.id, v.id, v_unit, it.qty, v_base, it.unit_price_kobo,
              it.unit_price_kobo * v_base, 'pos_offline',
              (select cost_kobo from public.variant_costs where variant_id = v.id),
              pr.name, nullif(concat_ws(' / ', v.colour, v.size), ''), v.sku, d.location_id);
      v_subtotal := v_subtotal + it.unit_price_kobo * v_base;
    end;
  end loop;

  -- Stock + price check per variant (deterministic lock order).
  for agg in
    select variant_id, sum(base_qty)::int qty, max(unit_price_kobo) charged
    from public.order_items where order_id = v_order.id group by variant_id order by variant_id
  loop
    lvl := app.lock_stock_level(d.business_id, agg.variant_id, d.location_id);
    select qty into v_alloc from public.device_allocations
     where device_id = d.id and variant_id = agg.variant_id and location_id = d.location_id for update;
    v_alloc := coalesce(v_alloc, 0);

    v_from_alloc := least(agg.qty, v_alloc);
    if v_from_alloc > 0 then
      perform app.apply_movement(d.business_id, agg.variant_id, d.location_id, 'deallocate', -v_from_alloc, 'pos', v_order.id, d.id, 'offline sale');
      perform app.apply_movement(d.business_id, agg.variant_id, d.location_id, 'sale', -v_from_alloc, 'pos', v_order.id, d.id);
      update public.device_allocations set qty = qty - v_from_alloc, updated_at = now()
       where device_id = d.id and variant_id = agg.variant_id and location_id = d.location_id;
    end if;

    select available into v_from_pool from public.stock_levels where variant_id = agg.variant_id and location_id = d.location_id;
    v_from_pool := greatest(least(agg.qty - v_from_alloc, v_from_pool), 0);
    if v_from_pool > 0 then
      perform app.apply_movement(d.business_id, agg.variant_id, d.location_id, 'sale', -v_from_pool, 'pos', v_order.id, d.id, 'offline sale beyond allocation');
    end if;

    v_short := agg.qty - v_from_alloc - v_from_pool;
    if v_short > 0 then
      update public.order_items set conflict_qty = least(base_qty, v_short)
       where id = (select id from public.order_items where order_id = v_order.id and variant_id = agg.variant_id order by base_qty desc limit 1);
      insert into public.stock_alerts (business_id, kind, variant_id, location_id, device_id, order_id, qty, message)
      values (d.business_id, 'oversell_conflict', agg.variant_id, d.location_id, d.id, v_order.id, v_short,
              format('Offline sale on %s sold %s more than was available online. Recount or cancel an online order.', d.name, v_short));
      v_conflicts := v_conflicts || jsonb_build_object('variant_id', agg.variant_id, 'short', v_short);
    end if;

    v_server_price := (app.resolve_price_unchecked(agg.variant_id, v_customer, agg.qty, 'pos')).unit_price_kobo;
    if agg.charged <> v_server_price and not ('offline_price_mismatch' = any (v_flags)) then
      v_flags := array_append(v_flags, 'offline_price_mismatch');
    end if;
  end loop;

  update public.orders set subtotal_kobo = v_subtotal, total_kobo = v_subtotal where id = v_order.id;

  for pay in
    select (x ->> 'client_id')::uuid client_id, (x ->> 'method')::public.payment_method method, (x ->> 'amount_kobo')::bigint amount
    from jsonb_array_elements(coalesce(p -> 'payments', '[]'::jsonb)) x
  loop
    if pay.method = 'virtual_account' then raise exception using errcode = '22023', message = 'invalid_payment_method'; end if;
    perform app.apply_payment(d.business_id, v_order.id, v_customer, pay.amount, pay.method, null, null, pay.client_id, d.id,
                              null, v_sold_at);
  end loop;

  select * into v_order from public.orders where id = v_order.id;
  if v_order.balance_kobo > 0 then
    update public.orders set is_credit = true where id = v_order.id;
    if not app.has_permission(d.business_id, 'credit.manage') then v_flags := array_append(v_flags, 'credit_sale_needs_approval'); end if;
  end if;
  if array_length(v_flags, 1) > 0 or jsonb_array_length(v_conflicts) > 0 then
    update public.orders set needs_attention = array_to_string(
      v_flags || case when jsonb_array_length(v_conflicts) > 0 then array['stock_conflict'] else '{}'::text[] end, ',')
    where id = v_order.id;
  end if;
  update public.devices set last_sync_at = now() where id = d.id;

  return jsonb_build_object('status', case when jsonb_array_length(v_conflicts) > 0 then 'conflict' else 'applied' end,
                            'client_id', v_client, 'order_id', v_order.id, 'order_number', v_order.order_number,
                            'conflicts', v_conflicts, 'flags', to_jsonb(v_flags));
end $$;
revoke execute on function public.sync_pos_sale(jsonb) from public, anon;

-- What a device should hold right now.
create or replace function public.pos_device_state(p_device uuid)
returns table (variant_id uuid, allocated int, available_online int)
language plpgsql stable security definer set search_path = '' as $$
declare d public.devices;
begin
  select * into d from public.devices where id = p_device;
  if not found or not app.is_staff(d.business_id) then perform app.raise_forbidden('invalid_device'); end if;
  return query
    select sl.variant_id, coalesce(da.qty, 0), sl.available
    from public.stock_levels sl
    left join public.device_allocations da on da.device_id = d.id and da.variant_id = sl.variant_id and da.location_id = sl.location_id
    where sl.business_id = d.business_id and sl.location_id = d.location_id;
end $$;

-- Expected takings for one staff member on one day (Africa/Lagos), from the payments ledger.
create or replace function public.cash_up_summary(p_business uuid, p_day date, p_staff uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_staff uuid := coalesce(p_staff, auth.uid());
begin
  if v_staff <> auth.uid() and not app.has_permission(p_business, 'reports.view') then perform app.raise_forbidden(); end if;
  if not app.is_staff(p_business) then perform app.raise_forbidden(); end if;
  return coalesce((
    select jsonb_object_agg(method, total) from (
      select method::text, sum(amount_kobo)::bigint total from public.payments
      where business_id = p_business and received_by = v_staff and status = 'succeeded'
        and (received_at at time zone 'Africa/Lagos')::date = p_day
      group by method) s), '{}'::jsonb);
end $$;

create or replace function public.submit_cash_up(p_business uuid, p_day date, p_counted_cash bigint, p_device uuid default null, p_note text default null)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_expected jsonb; v_row public.cash_ups;
begin
  perform app.require_permission(p_business, 'sales.create');
  v_expected := public.cash_up_summary(p_business, p_day, auth.uid());
  insert into public.cash_ups (business_id, staff_user_id, device_id, day, expected, counted_cash_kobo, variance_kobo, note)
  values (p_business, auth.uid(), p_device, p_day, v_expected, p_counted_cash,
          p_counted_cash - coalesce((v_expected ->> 'cash')::bigint, 0), p_note)
  on conflict (business_id, staff_user_id, day) do update set
    expected = excluded.expected, counted_cash_kobo = excluded.counted_cash_kobo,
    variance_kobo = excluded.variance_kobo, note = excluded.note, created_at = now()
  returning * into v_row;
  if v_row.variance_kobo <> 0 then
    perform app.audit(p_business, 'cash_up.variance', 'cash_up', v_row.id::text, v_expected,
      jsonb_build_object('counted_cash_kobo', p_counted_cash, 'variance_kobo', v_row.variance_kobo));
  end if;
  return to_jsonb(v_row);
end $$;
revoke execute on function public.submit_cash_up(uuid, date, bigint, uuid, text) from public, anon;
revoke execute on function public.cash_up_summary(uuid, date, uuid) from public, anon;
revoke execute on function public.pos_device_state(uuid) from public, anon;
