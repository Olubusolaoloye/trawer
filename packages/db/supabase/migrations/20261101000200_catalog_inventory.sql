-- Catalogue (products, variants, units, images) and the inventory ledger.

create type public.product_status as enum ('draft', 'active', 'archived');
create type public.movement_type as enum (
  'receive', 'sale', 'reserve', 'release', 'transfer_in', 'transfer_out', 'adjust', 'return',
  'allocate', 'deallocate'
);
create type public.stock_alert_kind as enum ('oversell_conflict', 'low_stock', 'sync_error');

-- Per-business monotonically increasing counters (order numbers, SKUs, barcodes, invoices).
create table public.business_counters (
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null,
  value bigint not null default 0,
  primary key (business_id, name)
);
alter table public.business_counters enable row level security;
revoke all on public.business_counters from anon, authenticated;

create or replace function app.next_counter(p_business uuid, p_name text) returns bigint
language sql volatile security definer set search_path = '' as $$
  insert into public.business_counters as bc (business_id, name, value) values (p_business, p_name, 1)
  on conflict (business_id, name) do update set value = bc.value + 1
  returning value
$$;
revoke execute on function app.next_counter(uuid, text) from public, anon, authenticated;

-- EAN-13 from a 12 digit body.
create or replace function app.ean13(p_body text) returns text
language plpgsql immutable set search_path = '' as $$
declare s int := 0; i int;
begin
  if p_body !~ '^[0-9]{12}$' then raise exception 'ean13 body must be 12 digits'; end if;
  for i in 1..12 loop
    s := s + substr(p_body, i, 1)::int * case when i % 2 = 0 then 3 else 1 end;
  end loop;
  return p_body || ((10 - s % 10) % 10)::text;
end $$;

-- ---------------------------------------------------------------------------
-- Units of measure
-- ---------------------------------------------------------------------------
create table public.units (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references public.businesses (id) on delete cascade,  -- null = platform unit
  name text not null,
  plural text not null,
  unique nulls not distinct (business_id, name)
);
insert into public.units (business_id, name, plural) values
  (null, 'piece', 'pieces'), (null, 'carton', 'cartons'), (null, 'pack', 'packs'),
  (null, 'dozen', 'dozens'), (null, 'bale', 'bales'), (null, 'roll', 'rolls'),
  (null, 'yard', 'yards'), (null, 'bag', 'bags'), (null, 'box', 'boxes'),
  (null, 'bundle', 'bundles'), (null, 'set', 'sets'), (null, 'pair', 'pairs'),
  (null, 'kg', 'kg'), (null, 'litre', 'litres'), (null, 'crate', 'crates');

-- ---------------------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------------------
create table public.products (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  description text not null default '',
  category text,
  brand text,
  tags text[] not null default '{}',
  status public.product_status not null default 'draft',
  base_unit_id uuid not null references public.units (id),
  source text not null default 'manual' check (source in ('manual', 'snap', 'import', 'text_list')),
  ai_draft jsonb,
  social_autopost boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector generated always as (
    setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(category, '') || ' ' || coalesce(brand, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'C')
  ) stored,
  unique (business_id, id)
);
create index products_listing_idx on public.products (business_id, status, created_at desc, id);
create index products_category_idx on public.products (business_id, category) where status = 'active';
create index products_search_idx on public.products using gin (search);
create index products_name_trgm on public.products using gin (name extensions.gin_trgm_ops);
create trigger products_touch before update on public.products
  for each row execute function app.touch_updated_at();

create table public.product_variants (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  product_id uuid not null,
  sku text not null,
  barcode text,
  colour text,
  colour_hex text check (colour_hex is null or colour_hex ~ '^#[0-9A-Fa-f]{6}$'),
  size text,
  retail_price_kobo bigint not null check (retail_price_kobo >= 0),
  low_stock_threshold int check (low_stock_threshold is null or low_stock_threshold >= 0),
  position int not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (business_id, product_id) references public.products (business_id, id) on delete cascade,
  unique (business_id, sku),
  unique (business_id, id)
);
create unique index product_variants_barcode on public.product_variants (business_id, barcode) where barcode is not null;
create index product_variants_product_idx on public.product_variants (product_id, position);
create trigger product_variants_touch before update on public.product_variants
  for each row execute function app.touch_updated_at();

-- Cost per base unit lives apart from the variant so storefront reads can never expose it.
create table public.variant_costs (
  variant_id uuid primary key,
  business_id uuid not null,
  cost_kobo bigint not null check (cost_kobo >= 0),
  updated_at timestamptz not null default now(),
  foreign key (business_id, variant_id) references public.product_variants (business_id, id) on delete cascade
);
create index variant_costs_business_idx on public.variant_costs (business_id);

create table public.variant_images (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  product_id uuid not null,
  variant_id uuid,
  path text not null,
  width int,
  height int,
  alt text,
  position int not null default 0,
  created_at timestamptz not null default now(),
  foreign key (business_id, product_id) references public.products (business_id, id) on delete cascade,
  foreign key (business_id, variant_id) references public.product_variants (business_id, id) on delete cascade
);
create index variant_images_product_idx on public.variant_images (product_id, position);
create index variant_images_variant_idx on public.variant_images (variant_id);

create table public.product_units (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  product_id uuid not null,
  unit_id uuid not null references public.units (id),
  factor int not null check (factor > 0),        -- base units per one of this unit
  is_base boolean not null default false,
  barcode text,
  sellable boolean not null default true,
  foreign key (business_id, product_id) references public.products (business_id, id) on delete cascade,
  unique (product_id, unit_id),
  check (not is_base or factor = 1)
);
create unique index product_units_one_base on public.product_units (product_id) where is_base;
create index product_units_business_idx on public.product_units (business_id);

-- ---------------------------------------------------------------------------
-- Inventory: levels + ledger
-- ---------------------------------------------------------------------------
create table public.stock_levels (
  business_id uuid not null,
  variant_id uuid not null,
  location_id uuid not null references public.locations (id) on delete cascade,
  on_hand int not null default 0,
  reserved int not null default 0,
  allocated int not null default 0,
  available int generated always as (on_hand - reserved - allocated) stored,
  updated_at timestamptz not null default now(),
  primary key (variant_id, location_id),
  foreign key (business_id, variant_id) references public.product_variants (business_id, id) on delete cascade,
  constraint stock_on_hand_nonneg check (on_hand >= 0),
  constraint stock_reserved_nonneg check (reserved >= 0),
  constraint stock_allocated_nonneg check (allocated >= 0),
  constraint stock_available_nonneg check (on_hand - reserved - allocated >= 0)
);
create index stock_levels_business_idx on public.stock_levels (business_id, location_id);

create table public.stock_movements (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  variant_id uuid not null,
  location_id uuid not null references public.locations (id) on delete cascade,
  type public.movement_type not null,
  qty_delta int not null check (qty_delta <> 0),
  channel public.sales_channel,
  order_id uuid,
  device_id uuid,
  actor_id uuid,
  reason text,
  created_at timestamptz not null default now(),
  foreign key (business_id, variant_id) references public.product_variants (business_id, id) on delete cascade,
  constraint movement_sign check (
    case type
      when 'receive' then qty_delta > 0
      when 'return' then qty_delta > 0
      when 'transfer_in' then qty_delta > 0
      when 'sale' then qty_delta < 0
      when 'transfer_out' then qty_delta < 0
      when 'reserve' then qty_delta > 0
      when 'release' then qty_delta < 0
      when 'allocate' then qty_delta > 0
      when 'deallocate' then qty_delta < 0
      else true
    end)
);
create index stock_movements_variant_idx on public.stock_movements (business_id, variant_id, created_at desc);
create index stock_movements_order_idx on public.stock_movements (order_id) where order_id is not null;
create index stock_movements_device_idx on public.stock_movements (device_id) where device_id is not null;

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  location_id uuid not null references public.locations (id),
  name text not null,
  platform text,
  status text not null default 'active' check (status in ('active', 'retired')),
  last_sync_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (business_id, id)
);
create index devices_business_idx on public.devices (business_id);

create table public.device_allocations (
  business_id uuid not null,
  device_id uuid not null,
  variant_id uuid not null,
  location_id uuid not null references public.locations (id) on delete cascade,
  qty int not null default 0 check (qty >= 0),
  updated_at timestamptz not null default now(),
  primary key (device_id, variant_id, location_id),
  foreign key (business_id, device_id) references public.devices (business_id, id) on delete cascade,
  foreign key (business_id, variant_id) references public.product_variants (business_id, id) on delete cascade
);
create index device_allocations_business_idx on public.device_allocations (business_id);

create table public.stock_alerts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  kind public.stock_alert_kind not null,
  variant_id uuid,
  location_id uuid,
  device_id uuid,
  order_id uuid,
  qty int,
  message text not null,
  resolved_at timestamptz,
  resolved_by uuid,
  created_at timestamptz not null default now()
);
create index stock_alerts_open_idx on public.stock_alerts (business_id, created_at desc) where resolved_at is null;

-- ---------------------------------------------------------------------------
-- Ledger core. Internal only: callers must hold the stock_levels row lock.
-- ---------------------------------------------------------------------------
create or replace function app.lock_stock_level(p_business uuid, p_variant uuid, p_location uuid)
returns public.stock_levels
language plpgsql volatile security definer set search_path = '' as $$
declare r public.stock_levels;
begin
  select * into r from public.stock_levels
   where variant_id = p_variant and location_id = p_location for update;
  if not found then
    if not exists (select 1 from public.locations where id = p_location and business_id = p_business) then
      raise exception using errcode = '22023', message = 'invalid_location';
    end if;
    insert into public.stock_levels (business_id, variant_id, location_id)
    values (p_business, p_variant, p_location)
    on conflict (variant_id, location_id) do nothing;
    select * into r from public.stock_levels
     where variant_id = p_variant and location_id = p_location for update;
  end if;
  if r.business_id <> p_business then
    raise exception using errcode = '42501', message = 'cross_tenant_stock';
  end if;
  return r;
end $$;

create or replace function app.apply_movement(
  p_business uuid, p_variant uuid, p_location uuid, p_type public.movement_type, p_qty_delta int,
  p_channel public.sales_channel default null, p_order uuid default null, p_device uuid default null,
  p_reason text default null
) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_constraint text;
begin
  if p_qty_delta = 0 then return; end if;
  case
    when p_type in ('receive', 'sale', 'adjust', 'return', 'transfer_in', 'transfer_out') then
      update public.stock_levels set on_hand = on_hand + p_qty_delta, updated_at = now()
       where variant_id = p_variant and location_id = p_location;
    when p_type in ('reserve', 'release') then
      update public.stock_levels set reserved = reserved + p_qty_delta, updated_at = now()
       where variant_id = p_variant and location_id = p_location;
    when p_type in ('allocate', 'deallocate') then
      update public.stock_levels set allocated = allocated + p_qty_delta, updated_at = now()
       where variant_id = p_variant and location_id = p_location;
  end case;
  if not found then
    raise exception using errcode = 'P0002', message = 'stock_level_missing';
  end if;
  insert into public.stock_movements (business_id, variant_id, location_id, type, qty_delta, channel,
                                      order_id, device_id, actor_id, reason)
  values (p_business, p_variant, p_location, p_type, p_qty_delta, p_channel, p_order, p_device, auth.uid(), p_reason);
exception
  when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint like 'stock\_%' then
      raise exception using errcode = 'P0409', message = 'insufficient_stock',
        detail = jsonb_build_object('variant_id', p_variant, 'location_id', p_location)::text;
    end if;
    raise;
end $$;

create or replace function app.variant_business(p_variant uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select business_id from public.product_variants where id = p_variant
$$;

create or replace function app.default_location(p_business uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.locations where business_id = p_business order by is_default desc, created_at limit 1
$$;

-- Normalise an items array into (variant_id, location_id, qty) rows, merging duplicates, ordered
-- for deterministic locking. Item shape: {"variant_id": uuid, "qty": int, "location_id"?: uuid}
create or replace function app.normalize_items(p_business uuid, p_items jsonb)
returns table (variant_id uuid, location_id uuid, qty int)
language sql stable security definer set search_path = '' as $$
  select (i ->> 'variant_id')::uuid,
         coalesce((i ->> 'location_id')::uuid, app.default_location(p_business)),
         sum((i ->> 'qty')::int)::int
  from jsonb_array_elements(p_items) i
  group by 1, 2
  order by 1, 2
$$;

-- Net quantity still reserved for an order, per (variant, location).
create or replace function app.order_reserved(p_order uuid)
returns table (business_id uuid, variant_id uuid, location_id uuid, qty int)
language sql stable security definer set search_path = '' as $$
  select m.business_id, m.variant_id, m.location_id, sum(m.qty_delta)::int
  from public.stock_movements m
  where m.order_id = p_order and m.type in ('reserve', 'release')
  group by 1, 2, 3
  having sum(m.qty_delta) <> 0
  order by 2, 3
$$;

-- ---------------------------------------------------------------------------
-- Public stock functions
-- ---------------------------------------------------------------------------

-- Atomically reserve every line of an order, or none. Raises insufficient_stock (P0409) with a
-- JSON detail listing each short line. Lines: {"variant_id", "qty" (base units), "location_id"?}
create or replace function public.reserve_stock(
  p_order_id uuid, p_items jsonb, p_channel public.sales_channel default null
) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_business uuid;
  it record;
  lvl public.stock_levels;
  v_short jsonb := '[]'::jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'no_items';
  end if;
  v_business := app.variant_business((p_items -> 0 ->> 'variant_id')::uuid);
  if v_business is null then raise exception using errcode = '22023', message = 'unknown_variant'; end if;

  for it in select * from app.normalize_items(v_business, p_items) loop
    if it.qty is null or it.qty <= 0 then
      raise exception using errcode = '22023', message = 'invalid_qty';
    end if;
    if app.variant_business(it.variant_id) is distinct from v_business then
      raise exception using errcode = '42501', message = 'cross_tenant_items';
    end if;
    lvl := app.lock_stock_level(v_business, it.variant_id, it.location_id);
    if lvl.available < it.qty then
      v_short := v_short || jsonb_build_object('variant_id', it.variant_id, 'location_id', it.location_id,
                                              'requested', it.qty, 'available', lvl.available);
    end if;
  end loop;

  if jsonb_array_length(v_short) > 0 then
    raise exception using errcode = 'P0409', message = 'insufficient_stock', detail = v_short::text;
  end if;

  for it in select * from app.normalize_items(v_business, p_items) loop
    perform app.apply_movement(v_business, it.variant_id, it.location_id, 'reserve', it.qty, p_channel, p_order_id);
  end loop;
end $$;

-- Give back whatever is still reserved for the order. Idempotent.
create or replace function public.release_reservation(p_order_id uuid, p_reason text default 'released')
returns int
language plpgsql volatile security definer set search_path = '' as $$
declare r record; v_total int := 0;
begin
  for r in select * from app.order_reserved(p_order_id) loop
    perform app.lock_stock_level(r.business_id, r.variant_id, r.location_id);
    perform app.apply_movement(r.business_id, r.variant_id, r.location_id, 'release', -r.qty, null, p_order_id, null, p_reason);
    v_total := v_total + r.qty;
  end loop;
  return v_total;
end $$;

-- Turn the order's reservation into a sale (on_hand decreases). Idempotent.
create or replace function public.commit_sale(p_order_id uuid, p_channel public.sales_channel default null)
returns int
language plpgsql volatile security definer set search_path = '' as $$
declare r record; v_total int := 0;
begin
  for r in select * from app.order_reserved(p_order_id) loop
    perform app.lock_stock_level(r.business_id, r.variant_id, r.location_id);
    perform app.apply_movement(r.business_id, r.variant_id, r.location_id, 'release', -r.qty, p_channel, p_order_id, null, 'committed');
    perform app.apply_movement(r.business_id, r.variant_id, r.location_id, 'sale', -r.qty, p_channel, p_order_id);
    v_total := v_total + r.qty;
  end loop;
  return v_total;
end $$;

create or replace function public.receive_stock(
  p_variant uuid, p_qty int, p_location uuid default null, p_reason text default null
) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_business uuid := app.variant_business(p_variant); v_loc uuid;
begin
  if v_business is null then raise exception using errcode = '22023', message = 'unknown_variant'; end if;
  perform app.require_permission(v_business, 'stock.receive');
  if p_qty is null or p_qty <= 0 then raise exception using errcode = '22023', message = 'invalid_qty'; end if;
  v_loc := coalesce(p_location, app.default_location(v_business));
  perform app.lock_stock_level(v_business, p_variant, v_loc);
  perform app.apply_movement(v_business, p_variant, v_loc, 'receive', p_qty, null, null, null, p_reason);
end $$;

-- Manual correction (damage, theft, recount). Needs stock.adjust; always audited.
create or replace function public.adjust_stock(
  p_variant uuid, p_delta int, p_reason text, p_location uuid default null
) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_business uuid := app.variant_business(p_variant); v_loc uuid; lvl public.stock_levels;
begin
  if v_business is null then raise exception using errcode = '22023', message = 'unknown_variant'; end if;
  perform app.require_permission(v_business, 'stock.adjust');
  if coalesce(trim(p_reason), '') = '' then raise exception using errcode = '22023', message = 'reason_required'; end if;
  v_loc := coalesce(p_location, app.default_location(v_business));
  lvl := app.lock_stock_level(v_business, p_variant, v_loc);
  perform app.apply_movement(v_business, p_variant, v_loc, 'adjust', p_delta, null, null, null, p_reason);
  perform app.audit(v_business, 'stock.adjusted', 'product_variant', p_variant::text,
    jsonb_build_object('on_hand', lvl.on_hand, 'location_id', v_loc),
    jsonb_build_object('on_hand', lvl.on_hand + p_delta, 'delta', p_delta, 'reason', p_reason));
end $$;

-- Stocktake: set the counted quantity; writes the difference as an adjustment.
create or replace function public.count_stock(
  p_variant uuid, p_counted int, p_location uuid default null, p_reason text default 'stock count'
) returns int
language plpgsql volatile security definer set search_path = '' as $$
declare v_business uuid := app.variant_business(p_variant); v_loc uuid; lvl public.stock_levels; v_delta int;
begin
  if v_business is null then raise exception using errcode = '22023', message = 'unknown_variant'; end if;
  perform app.require_permission(v_business, 'stock.adjust');
  v_loc := coalesce(p_location, app.default_location(v_business));
  lvl := app.lock_stock_level(v_business, p_variant, v_loc);
  v_delta := p_counted - lvl.on_hand;
  if v_delta <> 0 then
    perform public.adjust_stock(p_variant, v_delta, p_reason, v_loc);
  end if;
  return v_delta;
end $$;

-- Move stock from the shared pool to a POS device so it can sell offline.
create or replace function public.allocate_to_device(
  p_device uuid, p_variant uuid, p_qty int
) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare d public.devices; v_business uuid := app.variant_business(p_variant);
begin
  select * into d from public.devices where id = p_device and status = 'active';
  if not found or d.business_id is distinct from v_business then
    raise exception using errcode = '22023', message = 'invalid_device';
  end if;
  perform app.require_permission(d.business_id, 'stock.allocate');
  if p_qty is null or p_qty = 0 then return; end if;
  perform app.lock_stock_level(d.business_id, p_variant, d.location_id);
  insert into public.device_allocations (business_id, device_id, variant_id, location_id, qty)
  values (d.business_id, d.id, p_variant, d.location_id, 0)
  on conflict do nothing;
  perform 1 from public.device_allocations
   where device_id = d.id and variant_id = p_variant and location_id = d.location_id for update;
  if p_qty > 0 then
    perform app.apply_movement(d.business_id, p_variant, d.location_id, 'allocate', p_qty, 'pos', null, d.id);
  else
    if (select qty from public.device_allocations
         where device_id = d.id and variant_id = p_variant and location_id = d.location_id) < -p_qty then
      raise exception using errcode = 'P0409', message = 'insufficient_allocation';
    end if;
    perform app.apply_movement(d.business_id, p_variant, d.location_id, 'deallocate', p_qty, 'pos', null, d.id);
  end if;
  update public.device_allocations set qty = qty + p_qty, updated_at = now()
   where device_id = d.id and variant_id = p_variant and location_id = d.location_id;
end $$;

-- Storefront availability (sum across locations) for active products, without exposing levels.
create or replace function public.variant_availability(p_variant_ids uuid[])
returns table (variant_id uuid, available int)
language sql stable security definer set search_path = '' as $$
  select v.id, coalesce(sum(sl.available), 0)::int
  from public.product_variants v
  join public.products p on p.id = v.product_id
  left join public.stock_levels sl on sl.variant_id = v.id
  where v.id = any (p_variant_ids)
    and (p.status = 'active' or p.business_id in (select app.staff_business_ids()) or app.is_service())
  group by v.id
$$;

-- Low stock list for the dashboard.
create or replace view public.low_stock_variants with (security_invoker = true) as
  select sl.business_id, sl.variant_id, sl.location_id, v.product_id, p.name as product_name,
         v.sku, v.colour, v.size, sl.on_hand, sl.available,
         coalesce(v.low_stock_threshold, b.low_stock_default) as threshold
  from public.stock_levels sl
  join public.product_variants v on v.id = sl.variant_id
  join public.products p on p.id = v.product_id
  join public.businesses b on b.id = sl.business_id
  where p.status = 'active' and v.is_active
    and sl.available <= coalesce(v.low_stock_threshold, b.low_stock_default);

-- ---------------------------------------------------------------------------
-- Product guards: price changes need prices.manage (unless still a draft) and are audited;
-- publishing needs products.manage. Auto SKU + EAN-13 barcode.
-- ---------------------------------------------------------------------------
create or replace function app.product_is_draft(p_product uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select status = 'draft' from public.products where id = p_product), true)
$$;

create or replace function app.variants_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.sku is null or new.sku = '' then
      new.sku := 'TRW-' || lpad(app.next_counter(new.business_id, 'sku')::text, 6, '0');
    end if;
    if new.barcode is null or new.barcode = '' then
      -- 20-29 prefix = in-store numbering; 2 + 9 digit counter + check digit
      new.barcode := app.ean13('20' || lpad(app.next_counter(new.business_id, 'barcode')::text, 10, '0'));
    end if;
    if not app.product_is_draft(new.product_id) and not app.has_permission(new.business_id, 'prices.manage') then
      perform app.raise_forbidden('permission_denied');
    end if;
  elsif tg_op = 'UPDATE' then
    if new.business_id <> old.business_id or new.product_id <> old.product_id then
      perform app.raise_forbidden('immutable_fields');
    end if;
    if new.retail_price_kobo <> old.retail_price_kobo then
      if not app.product_is_draft(new.product_id) and not app.has_permission(new.business_id, 'prices.manage') then
        perform app.raise_forbidden('permission_denied');
      end if;
      perform app.audit(new.business_id, 'price.retail_changed', 'product_variant', new.id::text,
        jsonb_build_object('retail_price_kobo', old.retail_price_kobo),
        jsonb_build_object('retail_price_kobo', new.retail_price_kobo));
    end if;
  end if;
  return new;
end $$;
create trigger product_variants_guard before insert or update on public.product_variants
  for each row execute function app.variants_guard();

create or replace function app.products_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    if new.status <> 'draft' and not app.has_permission(new.business_id, 'products.manage') then
      perform app.raise_forbidden('permission_denied');
    end if;
  elsif new.status <> old.status and not app.has_permission(new.business_id, 'products.manage') then
    perform app.raise_forbidden('permission_denied');
  end if;
  return new;
end $$;
create trigger products_guard before insert or update on public.products
  for each row execute function app.products_guard();

create or replace function app.variant_costs_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.cost_kobo = old.cost_kobo then return new; end if;
  perform app.audit(new.business_id, 'price.cost_changed', 'product_variant', new.variant_id::text,
    case when tg_op = 'UPDATE' then jsonb_build_object('cost_kobo', old.cost_kobo) end,
    jsonb_build_object('cost_kobo', new.cost_kobo));
  return new;
end $$;
create trigger variant_costs_audit after insert or update on public.variant_costs
  for each row execute function app.variant_costs_audit();

-- Base unit row is created automatically for every product.
create or replace function app.products_base_unit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.product_units (business_id, product_id, unit_id, factor, is_base)
  values (new.business_id, new.id, new.base_unit_id, 1, true)
  on conflict (product_id, unit_id) do nothing;
  return new;
end $$;
create trigger products_base_unit after insert on public.products
  for each row execute function app.products_base_unit();

-- Convert a quantity in any unit of the product to base units.
create or replace function public.to_base_qty(p_product uuid, p_unit uuid, p_qty int) returns int
language plpgsql stable security definer set search_path = '' as $$
declare f int;
begin
  select factor into f from public.product_units where product_id = p_product and unit_id = p_unit and sellable;
  if f is null then raise exception using errcode = '22023', message = 'unit_not_sellable'; end if;
  return p_qty * f;
end $$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.units enable row level security;
alter table public.products enable row level security;
alter table public.product_variants enable row level security;
alter table public.variant_costs enable row level security;
alter table public.variant_images enable row level security;
alter table public.product_units enable row level security;
alter table public.stock_levels enable row level security;
alter table public.stock_movements enable row level security;
alter table public.devices enable row level security;
alter table public.device_allocations enable row level security;
alter table public.stock_alerts enable row level security;

create or replace function app.active_product_ids_of(p_business uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select id from public.products where business_id = p_business and status = 'active'
$$;

create policy units_read on public.units for select to anon, authenticated
  using (business_id is null or business_id in (select app.staff_business_ids())
         or business_id in (select id from public.businesses where status = 'active'));
create policy units_write on public.units for all to authenticated
  using (business_id is not null and app.has_permission(business_id, 'products.manage'))
  with check (business_id is not null and app.has_permission(business_id, 'products.manage'));

create policy products_public_read on public.products for select to anon, authenticated
  using (status = 'active' or business_id in (select app.staff_business_ids()));
create policy products_insert on public.products for insert to authenticated
  with check (app.has_permission(business_id, 'products.draft') or app.has_permission(business_id, 'products.manage'));
create policy products_update on public.products for update to authenticated
  using (app.has_permission(business_id, 'products.manage')
         or (status = 'draft' and app.has_permission(business_id, 'products.draft')))
  with check (app.has_permission(business_id, 'products.manage')
         or (status = 'draft' and app.has_permission(business_id, 'products.draft')));
create policy products_delete on public.products for delete to authenticated
  using (app.has_permission(business_id, 'products.manage'));

-- Children of products share one rule set.
create or replace function app.can_write_product(p_business uuid, p_product uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.has_permission(p_business, 'products.manage')
      or (app.product_is_draft(p_product) and app.has_permission(p_business, 'products.draft'))
$$;

create or replace function app.product_visible(p_business uuid, p_product uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.products p where p.id = p_product and p.status = 'active')
      or p_business in (select app.staff_business_ids())
$$;

create policy variants_read on public.product_variants for select to anon, authenticated
  using (app.product_visible(business_id, product_id));
create policy variants_write on public.product_variants for all to authenticated
  using (app.can_write_product(business_id, product_id))
  with check (app.can_write_product(business_id, product_id));

create policy images_read on public.variant_images for select to anon, authenticated
  using (app.product_visible(business_id, product_id));
create policy images_write on public.variant_images for all to authenticated
  using (app.can_write_product(business_id, product_id))
  with check (app.can_write_product(business_id, product_id));

create policy product_units_read on public.product_units for select to anon, authenticated
  using (app.product_visible(business_id, product_id));
create policy product_units_write on public.product_units for all to authenticated
  using (app.can_write_product(business_id, product_id))
  with check (app.can_write_product(business_id, product_id));

create policy variant_costs_read on public.variant_costs for select to authenticated
  using (app.has_permission(business_id, 'costs.view'));
create policy variant_costs_write on public.variant_costs for all to authenticated
  using (app.has_permission(business_id, 'prices.manage'))
  with check (app.has_permission(business_id, 'prices.manage'));

create policy stock_levels_read on public.stock_levels for select to authenticated
  using (business_id in (select app.staff_business_ids()));
create policy stock_movements_read on public.stock_movements for select to authenticated
  using (business_id in (select app.staff_business_ids()));
create policy devices_read on public.devices for select to authenticated
  using (business_id in (select app.staff_business_ids()));
create policy devices_write on public.devices for all to authenticated
  using (app.has_permission(business_id, 'devices.manage'))
  with check (app.has_permission(business_id, 'devices.manage'));
create policy device_allocations_read on public.device_allocations for select to authenticated
  using (business_id in (select app.staff_business_ids()));
create policy stock_alerts_read on public.stock_alerts for select to authenticated
  using (business_id in (select app.staff_business_ids()));
create policy stock_alerts_resolve on public.stock_alerts for update to authenticated
  using (app.has_permission(business_id, 'stock.adjust'))
  with check (app.has_permission(business_id, 'stock.adjust'));

-- The ledger is only ever written by the functions above.
revoke insert, update, delete, truncate on public.stock_levels, public.stock_movements, public.device_allocations
  from anon, authenticated;
revoke insert, delete, truncate on public.stock_alerts from anon, authenticated;
revoke all on public.stock_levels, public.stock_movements, public.device_allocations, public.stock_alerts,
  public.variant_costs, public.devices from anon;

revoke execute on function public.reserve_stock(uuid, jsonb, public.sales_channel) from public, anon, authenticated;
revoke execute on function public.release_reservation(uuid, text) from public, anon, authenticated;
revoke execute on function public.commit_sale(uuid, public.sales_channel) from public, anon, authenticated;
revoke execute on function public.receive_stock(uuid, int, uuid, text) from public, anon;
revoke execute on function public.adjust_stock(uuid, int, text, uuid) from public, anon;
revoke execute on function public.count_stock(uuid, int, uuid, text) from public, anon;
revoke execute on function public.allocate_to_device(uuid, uuid, int) from public, anon;
do $$ declare f text; begin
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app' and p.proname in ('lock_stock_level', 'apply_movement')
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;
