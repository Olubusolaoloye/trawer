-- Pricing: tier prices, per-customer overrides, volume breaks and the one price resolver.

create table public.tier_prices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  tier_id uuid not null,
  variant_id uuid not null,
  price_kobo bigint not null check (price_kobo >= 0),
  updated_at timestamptz not null default now(),
  unique (tier_id, variant_id),
  foreign key (business_id, tier_id) references public.customer_tiers (business_id, id) on delete cascade,
  foreign key (business_id, variant_id) references public.product_variants (business_id, id) on delete cascade
);
create index tier_prices_business_idx on public.tier_prices (business_id);
create index tier_prices_variant_idx on public.tier_prices (variant_id);

create table public.customer_price_overrides (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  customer_id uuid not null,
  variant_id uuid not null,
  price_kobo bigint not null check (price_kobo >= 0),
  note text,
  updated_at timestamptz not null default now(),
  unique (customer_id, variant_id),
  foreign key (business_id, customer_id) references public.customers (business_id, id) on delete cascade,
  foreign key (business_id, variant_id) references public.product_variants (business_id, id) on delete cascade
);
create index customer_price_overrides_business_idx on public.customer_price_overrides (business_id);

-- min_qty is in base units. tier_id null = applies to everyone without a better match.
create table public.volume_breaks (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null,
  variant_id uuid not null,
  tier_id uuid,
  min_qty int not null check (min_qty > 1),
  price_kobo bigint not null check (price_kobo >= 0),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (variant_id, tier_id, min_qty),
  foreign key (business_id, tier_id) references public.customer_tiers (business_id, id) on delete cascade,
  foreign key (business_id, variant_id) references public.product_variants (business_id, id) on delete cascade
);
create index volume_breaks_business_idx on public.volume_breaks (business_id);
create index volume_breaks_variant_idx on public.volume_breaks (variant_id, tier_id, min_qty desc);

-- Audit every price row change.
create or replace function app.price_rows_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record := coalesce(new, old);
begin
  perform app.audit(r.business_id, 'price.' || tg_table_name || '.' || lower(tg_op), tg_table_name, r.id::text,
    case when tg_op <> 'INSERT' then to_jsonb(old) end,
    case when tg_op <> 'DELETE' then to_jsonb(new) end);
  return null;
end $$;
create trigger tier_prices_audit after insert or update or delete on public.tier_prices
  for each row execute function app.price_rows_audit();
create trigger customer_price_overrides_audit after insert or update or delete on public.customer_price_overrides
  for each row execute function app.price_rows_audit();
create trigger volume_breaks_audit after insert or update or delete on public.volume_breaks
  for each row execute function app.price_rows_audit();

-- ---------------------------------------------------------------------------
-- Resolver
-- ---------------------------------------------------------------------------
create type public.price_quote as (
  unit_price_kobo bigint,          -- per base unit
  source text,                     -- override | tier_volume | tier | volume | retail
  tier_id uuid,
  retail_price_kobo bigint
);

-- Resolution order (identical on every channel; `channel` is accepted for future
-- channel-specific pricing and is not used today):
--   1. per-customer override
--   2. customer's tier — tier-scoped volume break for qty, else tier price.
--      Wholesale tiers count only for approved wholesalers; then they apply at ANY quantity.
--   3. general volume break (tier_id null), highest min_qty <= qty
--   4. retail price
-- Mirrored exactly by packages/core/src/pricing.ts (parity-tested).
create or replace function app.resolve_price_unchecked(
  p_variant uuid, p_customer uuid, p_qty int, p_channel public.sales_channel default 'web'
) returns public.price_quote
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.product_variants;
  c public.customers;
  t public.customer_tiers;
  v_price bigint;
  v_tier uuid;
  q int := greatest(coalesce(p_qty, 1), 1);
begin
  select * into v from public.product_variants where id = p_variant;
  if not found then raise exception using errcode = '22023', message = 'unknown_variant'; end if;

  if p_customer is not null then
    select * into c from public.customers where id = p_customer and business_id = v.business_id;
  end if;

  if c.id is not null then
    select o.price_kobo into v_price from public.customer_price_overrides o
     where o.customer_id = c.id and o.variant_id = v.id;
    if v_price is not null then
      return row(v_price, 'override', c.tier_id, v.retail_price_kobo)::public.price_quote;
    end if;

    if c.tier_id is not null then
      select * into t from public.customer_tiers where id = c.tier_id;
      if t.id is not null and (not t.is_wholesale or c.wholesale_status = 'approved') then
        v_tier := t.id;
        select vb.price_kobo into v_price from public.volume_breaks vb
         where vb.variant_id = v.id and vb.tier_id = t.id and vb.min_qty <= q
         order by vb.min_qty desc limit 1;
        if v_price is not null then
          return row(v_price, 'tier_volume', v_tier, v.retail_price_kobo)::public.price_quote;
        end if;
        select tp.price_kobo into v_price from public.tier_prices tp
         where tp.tier_id = t.id and tp.variant_id = v.id;
        if v_price is not null then
          return row(v_price, 'tier', v_tier, v.retail_price_kobo)::public.price_quote;
        end if;
      end if;
    end if;
  end if;

  select vb.price_kobo into v_price from public.volume_breaks vb
   where vb.variant_id = v.id and vb.tier_id is null and vb.min_qty <= q
   order by vb.min_qty desc limit 1;
  if v_price is not null then
    return row(v_price, 'volume', v_tier, v.retail_price_kobo)::public.price_quote;
  end if;

  return row(v.retail_price_kobo, 'retail', v_tier, v.retail_price_kobo)::public.price_quote;
end $$;
revoke execute on function app.resolve_price_unchecked(uuid, uuid, int, public.sales_channel) from public, anon, authenticated;

-- Public entry point. Staff (and service code) may price for any customer of their business;
-- buyers may only price for themselves — any other customer id is ignored (retail quote).
create or replace function public.resolve_price(
  p_variant uuid, p_customer uuid, p_qty int, p_channel public.sales_channel default 'web'
) returns public.price_quote
language plpgsql stable security definer set search_path = '' as $$
declare v_business uuid := app.variant_business(p_variant); v_customer uuid := p_customer;
begin
  if v_business is null then raise exception using errcode = '22023', message = 'unknown_variant'; end if;
  if not exists (select 1 from public.product_variants pv join public.products p on p.id = pv.product_id
                 where pv.id = p_variant and (p.status = 'active' or app.is_staff(v_business))) then
    raise exception using errcode = '22023', message = 'unknown_variant';
  end if;
  if v_customer is not null and not app.is_staff(v_business)
     and v_customer not in (select app.my_customer_ids()) then
    v_customer := null;
  end if;
  return app.resolve_price_unchecked(p_variant, v_customer, p_qty, p_channel);
end $$;

create or replace function public.my_customer_id(p_business uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.customers where business_id = p_business and user_id = auth.uid()
$$;

-- Batch quote for storefront grids and the WhatsApp catalogue: prices for the signed-in buyer.
create or replace function public.quote_prices(
  p_variant_ids uuid[], p_qty int default 1, p_channel public.sales_channel default 'web',
  p_customer uuid default null
) returns table (variant_id uuid, unit_price_kobo bigint, source text, retail_price_kobo bigint)
language sql stable security definer set search_path = '' as $$
  select v.id, (q).unit_price_kobo, (q).source, (q).retail_price_kobo
  from public.product_variants v
  cross join lateral (
    select public.resolve_price(v.id,
             coalesce(p_customer, public.my_customer_id(v.business_id)),
             p_qty, p_channel) as q) x
  where v.id = any (p_variant_ids)
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
create or replace function app.my_effective_tier_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select c.tier_id from public.customers c
  join public.customer_tiers t on t.id = c.tier_id
  where c.user_id = auth.uid() and (not t.is_wholesale or c.wholesale_status = 'approved')
$$;

alter table public.tier_prices enable row level security;
alter table public.customer_price_overrides enable row level security;
alter table public.volume_breaks enable row level security;

create policy tier_prices_read on public.tier_prices for select to authenticated
  using (business_id in (select app.staff_business_ids())
         or tier_id in (select app.my_effective_tier_ids()));
create policy tier_prices_write on public.tier_prices for all to authenticated
  using (app.has_permission(business_id, 'prices.manage') and app.is_aal2())
  with check (app.has_permission(business_id, 'prices.manage') and app.is_aal2());

create policy overrides_read on public.customer_price_overrides for select to authenticated
  using (business_id in (select app.staff_business_ids()) or customer_id in (select app.my_customer_ids()));
create policy overrides_write on public.customer_price_overrides for all to authenticated
  using (app.has_permission(business_id, 'prices.manage') and app.is_aal2())
  with check (app.has_permission(business_id, 'prices.manage') and app.is_aal2());

create policy volume_breaks_read on public.volume_breaks for select to anon, authenticated
  using ((tier_id is null and app.product_visible(business_id, (select pv.product_id from public.product_variants pv where pv.id = variant_id)))
         or business_id in (select app.staff_business_ids())
         or tier_id in (select app.my_effective_tier_ids()));
create policy volume_breaks_write on public.volume_breaks for all to authenticated
  using (app.has_permission(business_id, 'prices.manage') and app.is_aal2())
  with check (app.has_permission(business_id, 'prices.manage') and app.is_aal2());

revoke all on public.tier_prices, public.customer_price_overrides from anon;
