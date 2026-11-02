-- Milestone 10: reports + expenses.
-- A "sale" is an order that is confirmed or completed (cancelled/expired never count; returned
-- deliveries are excluded because the goods came back). Its date is when it was confirmed, in the
-- shop's timezone. Profit uses the cost snapshot taken when each line was sold; lines without a
-- known cost are reported separately (cost coverage) instead of counting as 100% profit.
-- Cost and profit figures are only returned to staff with costs.view.

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  category text not null check (category in ('rent', 'salaries', 'transport', 'delivery', 'fuel_power', 'data_airtime', 'marketing', 'bank_charges', 'taxes_levies', 'repairs', 'packaging', 'other')),
  amount_kobo bigint not null check (amount_kobo > 0 and amount_kobo <= 100000000000),
  spent_on date not null,
  description text check (char_length(description) <= 200),
  method text not null default 'cash' check (method in ('cash', 'transfer', 'card', 'other')),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index expenses_business_day_idx on public.expenses (business_id, spent_on desc) where deleted_at is null;
create trigger expenses_touch before update on public.expenses for each row execute function app.touch_updated_at();

alter table public.expenses enable row level security;
create policy expenses_read on public.expenses for select to authenticated
  using (deleted_at is null and (app.has_permission(business_id, 'expenses.manage') or app.has_permission(business_id, 'reports.view')));
revoke insert, update, delete on public.expenses from anon, authenticated;

create or replace function public.save_expense(
  p_business uuid, p_id uuid, p_category text, p_amount_kobo bigint, p_spent_on date, p_description text, p_method text
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_old public.expenses; v_id uuid;
begin
  perform app.require_permission(p_business, 'expenses.manage');
  if p_spent_on > (now() at time zone (select timezone from public.businesses where id = p_business))::date + 1
     or p_spent_on < current_date - interval '3 years' then
    raise exception using errcode = '22023', message = 'bad_expense_date';
  end if;
  if p_id is null then
    insert into public.expenses (business_id, category, amount_kobo, spent_on, description, method, created_by)
    values (p_business, p_category, p_amount_kobo, p_spent_on, nullif(trim(p_description), ''), coalesce(p_method, 'cash'), auth.uid())
    returning id into v_id;
    perform app.audit(p_business, 'expense.added', 'expense', v_id::text, null, jsonb_build_object('category', p_category, 'amount_kobo', p_amount_kobo, 'spent_on', p_spent_on));
  else
    select * into v_old from public.expenses where id = p_id and business_id = p_business and deleted_at is null for update;
    if not found then perform app.raise_forbidden('not_found'); end if;
    update public.expenses set category = p_category, amount_kobo = p_amount_kobo, spent_on = p_spent_on,
      description = nullif(trim(p_description), ''), method = coalesce(p_method, 'cash') where id = p_id;
    v_id := p_id;
    perform app.audit(p_business, 'expense.changed', 'expense', v_id::text,
      jsonb_build_object('category', v_old.category, 'amount_kobo', v_old.amount_kobo, 'spent_on', v_old.spent_on),
      jsonb_build_object('category', p_category, 'amount_kobo', p_amount_kobo, 'spent_on', p_spent_on));
  end if;
  return v_id;
end $$;

-- Soft delete (kept for the audit trail, hidden everywhere else).
create or replace function public.delete_expense(p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare e public.expenses;
begin
  select * into e from public.expenses where id = p_id and deleted_at is null for update;
  if not found then perform app.raise_forbidden('not_found'); end if;
  perform app.require_permission(e.business_id, 'expenses.manage');
  update public.expenses set deleted_at = now() where id = e.id;
  perform app.audit(e.business_id, 'expense.deleted', 'expense', e.id::text, jsonb_build_object('category', e.category, 'amount_kobo', e.amount_kobo), null);
end $$;

-- ---------------------------------------------------------------------------
-- Sold lines in a period (shared by every report). Day boundaries in the shop's timezone.
-- ---------------------------------------------------------------------------
create or replace function app.sold_lines(p_business uuid, p_from date, p_to date, p_channel public.sales_channel default null)
returns table (order_id uuid, order_number int, customer_id uuid, channel public.sales_channel, day date, product_id uuid, variant_id uuid,
               unit_id uuid, unit_qty int, base_qty int, sales_kobo bigint, cost_kobo bigint)
language sql stable security definer set search_path = '' as $$
  with b as (select timezone tz from public.businesses where id = p_business)
  select o.id, o.order_number, o.customer_id, o.channel, (coalesce(o.confirmed_at, o.created_at) at time zone b.tz)::date,
         i.product_id, i.variant_id, i.unit_id, i.unit_qty, i.base_qty, i.line_total_kobo,
         case when i.unit_cost_kobo is null then null else i.unit_cost_kobo * i.base_qty end
  from public.orders o cross join b
  join public.order_items i on i.order_id = o.id
  where o.business_id = p_business and o.status in ('confirmed', 'completed') and o.fulfilment_status <> 'returned'
    and coalesce(o.confirmed_at, o.created_at) >= (p_from::timestamp at time zone b.tz)
    and coalesce(o.confirmed_at, o.created_at) < ((p_to + 1)::timestamp at time zone b.tz)
    and (p_channel is null or o.channel = p_channel)
$$;
revoke execute on function app.sold_lines(uuid, date, date, public.sales_channel) from public, anon, authenticated;

create or replace function app.check_report_range(p_business uuid, p_from date, p_to date) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  perform app.require_permission(p_business, 'reports.view');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 731 then
    raise exception using errcode = '22023', message = 'bad_date_range';
  end if;
  return app.has_permission(p_business, 'costs.view');
end $$;
revoke execute on function app.check_report_range(uuid, date, date) from public, anon, authenticated;

-- Headline numbers, previous period of the same length, daily series, channels, expenses by category.
create or replace function public.report_summary(p_business uuid, p_from date, p_to date, p_channel public.sales_channel default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_costs boolean := app.check_report_range(p_business, p_from, p_to);
  v_len int := p_to - p_from + 1;
begin
  return (
    with cur as (select * from app.sold_lines(p_business, p_from, p_to, p_channel)),
    prev as (select * from app.sold_lines(p_business, p_from - v_len, p_from - 1, p_channel)),
    ex as (select * from public.expenses where business_id = p_business and deleted_at is null and spent_on between p_from and p_to),
    exprev as (select * from public.expenses where business_id = p_business and deleted_at is null and spent_on between p_from - v_len and p_from - 1),
    tot as (
      select coalesce(sum(sales_kobo), 0) sales, count(distinct order_id) orders, coalesce(sum(cost_kobo), 0) cost,
             coalesce(sum(sales_kobo) filter (where cost_kobo is not null), 0) costed_sales, coalesce(sum(base_qty), 0) units
      from cur),
    ptot as (
      select coalesce(sum(sales_kobo), 0) sales, count(distinct order_id) orders,
             coalesce(sum(sales_kobo - cost_kobo) filter (where cost_kobo is not null), 0) gross
      from prev),
    days as (
      select d::date as day,
             coalesce((select sum(sales_kobo) from cur where cur.day = d::date), 0) sales,
             coalesce((select sum(sales_kobo - cost_kobo) from cur where cur.day = d::date and cost_kobo is not null), 0) gross,
             (select count(distinct order_id) from cur where cur.day = d::date) orders
      from generate_series(p_from, p_to, interval '1 day') d)
    select jsonb_build_object(
      'from', p_from, 'to', p_to, 'channel', p_channel, 'costs_visible', v_costs,
      'sales_kobo', t.sales, 'orders', t.orders, 'units', t.units,
      'avg_order_kobo', case when t.orders > 0 then round(t.sales::numeric / t.orders) else 0 end,
      'cost_kobo', case when v_costs then t.cost end,
      'gross_profit_kobo', case when v_costs then t.costed_sales - t.cost end,
      'margin_pct', case when v_costs and t.costed_sales > 0 then round(100.0 * (t.costed_sales - t.cost) / t.costed_sales, 1) end,
      'cost_coverage_pct', case when v_costs then case when t.sales > 0 then round(100.0 * t.costed_sales / t.sales, 1) else 100 end end,
      'expenses_kobo', (select coalesce(sum(amount_kobo), 0) from ex),
      'net_profit_kobo', case when v_costs then t.costed_sales - t.cost - (select coalesce(sum(amount_kobo), 0) from ex) end,
      'payments_kobo', (select coalesce(sum(p.amount_kobo), 0) from public.payments p, public.businesses bz
                        where bz.id = p_business and p.business_id = p_business and p.status = 'succeeded'
                          and p.received_at >= (p_from::timestamp at time zone bz.timezone) and p.received_at < ((p_to + 1)::timestamp at time zone bz.timezone)),
      'previous', jsonb_build_object('from', p_from - v_len, 'to', p_from - 1, 'sales_kobo', pt.sales, 'orders', pt.orders,
                    'gross_profit_kobo', case when v_costs then pt.gross end, 'expenses_kobo', (select coalesce(sum(amount_kobo), 0) from exprev)),
      'days', (select jsonb_agg(jsonb_build_object('day', day, 'sales_kobo', sales, 'gross_profit_kobo', case when v_costs then gross end, 'orders', orders) order by day) from days),
      'channels', coalesce((select jsonb_agg(x order by x.sales_kobo desc) from (
          select channel, sum(sales_kobo) sales_kobo, count(distinct order_id) orders,
                 case when v_costs then sum(sales_kobo - cost_kobo) filter (where cost_kobo is not null) end gross_profit_kobo
          from cur group by channel) x), '[]'::jsonb),
      'expense_categories', coalesce((select jsonb_agg(x order by x.amount_kobo desc) from (
          select category, sum(amount_kobo) amount_kobo, count(*) entries from ex group by category) x), '[]'::jsonb))
    from tot t, ptot pt
  );
end $$;

-- Products (and the units they were sold in): units, sales, cost, profit, margin.
create or replace function public.report_products(p_business uuid, p_from date, p_to date, p_channel public.sales_channel default null, p_limit int default 100)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_costs boolean := app.check_report_range(p_business, p_from, p_to);
begin
  return jsonb_build_object(
    'products', coalesce((select jsonb_agg(x order by x.sales_kobo desc, x.name) from (
        select l.product_id id, p.name, p.category, sum(l.base_qty)::int base_qty, sum(l.sales_kobo)::bigint sales_kobo, count(distinct l.order_id)::int orders,
               case when v_costs then sum(l.cost_kobo)::bigint end cost_kobo,
               case when v_costs then (sum(l.sales_kobo - l.cost_kobo) filter (where l.cost_kobo is not null))::bigint end gross_profit_kobo,
               case when v_costs and sum(l.sales_kobo) filter (where l.cost_kobo is not null) > 0
                    then round(100.0 * sum(l.sales_kobo - l.cost_kobo) filter (where l.cost_kobo is not null) / sum(l.sales_kobo) filter (where l.cost_kobo is not null), 1) end margin_pct,
               bool_or(l.cost_kobo is null) missing_cost,
               (select u.name from public.units u where u.id = p.base_unit_id) base_unit,
               (select u.plural from public.units u where u.id = p.base_unit_id) base_unit_plural,
               (select jsonb_agg(jsonb_build_object('unit', u2.name, 'plural', u2.plural, 'qty', z.qty, 'sales_kobo', z.sales) order by z.sales desc)
                  from (select unit_id, sum(unit_qty)::int qty, sum(sales_kobo)::bigint sales from app.sold_lines(p_business, p_from, p_to, p_channel) s
                        where s.product_id = l.product_id group by unit_id) z join public.units u2 on u2.id = z.unit_id) by_unit
        from app.sold_lines(p_business, p_from, p_to, p_channel) l join public.products p on p.id = l.product_id
        group by l.product_id, p.name, p.category, p.base_unit_id
        order by sum(l.sales_kobo) desc limit greatest(least(p_limit, 500), 1)) x), '[]'::jsonb),
    'units', coalesce((select jsonb_agg(x order by x.sales_kobo desc) from (
        select u.name unit, u.plural, sum(l.unit_qty)::int qty, sum(l.sales_kobo)::bigint sales_kobo,
               case when v_costs then (sum(l.sales_kobo - l.cost_kobo) filter (where l.cost_kobo is not null))::bigint end gross_profit_kobo
        from app.sold_lines(p_business, p_from, p_to, p_channel) l join public.units u on u.id = l.unit_id
        group by u.name, u.plural) x), '[]'::jsonb),
    'costs_visible', v_costs);
end $$;

-- Best customers by sales in the period (walk-ins grouped together), with what they owe now.
create or replace function public.report_customers(p_business uuid, p_from date, p_to date, p_channel public.sales_channel default null, p_limit int default 50)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_costs boolean := app.check_report_range(p_business, p_from, p_to);
begin
  if not app.has_permission(p_business, 'customers.view') then perform app.raise_forbidden('permission_denied'); end if;
  return jsonb_build_object('customers', coalesce((select jsonb_agg(x order by x.sales_kobo desc) from (
      select l.customer_id id, coalesce(c.business_name, c.name, 'Walk-in customers') name,
             c.buyer_type, c.wholesale_status = 'approved' wholesale,
             count(distinct l.order_id)::int orders, sum(l.sales_kobo)::bigint sales_kobo,
             case when v_costs then (sum(l.sales_kobo - l.cost_kobo) filter (where l.cost_kobo is not null))::bigint end gross_profit_kobo,
             max(l.day) last_order_day,
             case when l.customer_id is null then 0 else coalesce((select sum(o.balance_kobo) from public.orders o
               where o.customer_id = l.customer_id and o.status in ('confirmed', 'completed') and o.balance_kobo > 0), 0) end owing_kobo
      from app.sold_lines(p_business, p_from, p_to, p_channel) l left join public.customers c on c.id = l.customer_id
      group by l.customer_id, c.business_name, c.name, c.buyer_type, c.wholesale_status
      order by sum(l.sales_kobo) desc limit greatest(least(p_limit, 500), 1)) x), '[]'::jsonb));
end $$;

-- What's on the shelves now: at cost (staff with costs.view) and at retail price, by category.
create or replace function public.report_stock_value(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_costs boolean;
begin
  perform app.require_permission(p_business, 'reports.view');
  v_costs := app.has_permission(p_business, 'costs.view');
  return (
    with v as (
      select p.id product_id, p.name, coalesce(p.category, 'Uncategorised') category, pv.id variant_id, pv.retail_price_kobo,
             vc.cost_kobo, coalesce((select sum(sl.on_hand) from public.stock_levels sl where sl.variant_id = pv.id), 0)::int on_hand,
             (select max(o.confirmed_at) from public.order_items i join public.orders o on o.id = i.order_id
               where i.variant_id = pv.id and o.status in ('confirmed', 'completed')) last_sold
      from public.product_variants pv join public.products p on p.id = pv.product_id
      left join public.variant_costs vc on vc.variant_id = pv.id
      where pv.business_id = p_business and p.status <> 'archived' and pv.is_active)
    select jsonb_build_object(
      'costs_visible', v_costs,
      'units', coalesce(sum(on_hand) filter (where on_hand > 0), 0),
      'retail_value_kobo', coalesce(sum(on_hand::bigint * retail_price_kobo) filter (where on_hand > 0), 0),
      'cost_value_kobo', case when v_costs then coalesce(sum(on_hand::bigint * cost_kobo) filter (where on_hand > 0 and cost_kobo is not null), 0) end,
      'variants_without_cost', case when v_costs then count(*) filter (where on_hand > 0 and cost_kobo is null) end,
      'categories', (select coalesce(jsonb_agg(c order by c.retail_value_kobo desc), '[]'::jsonb) from (
          select category, sum(on_hand)::int units, sum(on_hand::bigint * retail_price_kobo)::bigint retail_value_kobo,
                 case when v_costs then sum(on_hand::bigint * cost_kobo) filter (where cost_kobo is not null)::bigint end cost_value_kobo
          from v where on_hand > 0 group by category) c),
      'slow_movers', (select coalesce(jsonb_agg(s order by s.value_kobo desc), '[]'::jsonb) from (
          select product_id id, name, sum(on_hand)::int units, sum(on_hand::bigint * retail_price_kobo)::bigint value_kobo, max(last_sold) last_sold
          from v where on_hand > 0 group by product_id, name
          having max(last_sold) is null or max(last_sold) < now() - interval '60 days'
          order by sum(on_hand::bigint * retail_price_kobo) desc limit 20) s))
    from v
  );
end $$;

revoke execute on function public.save_expense(uuid, uuid, text, bigint, date, text, text) from public, anon;
revoke execute on function public.delete_expense(uuid) from public, anon;
revoke execute on function public.report_summary(uuid, date, date, public.sales_channel) from public, anon;
revoke execute on function public.report_products(uuid, date, date, public.sales_channel, int) from public, anon;
revoke execute on function public.report_customers(uuid, date, date, public.sales_channel, int) from public, anon;
revoke execute on function public.report_stock_value(uuid) from public, anon;
grant execute on function public.save_expense(uuid, uuid, text, bigint, date, text, text), public.delete_expense(uuid),
  public.report_summary(uuid, date, date, public.sales_channel), public.report_products(uuid, date, date, public.sales_channel, int),
  public.report_customers(uuid, date, date, public.sales_channel, int), public.report_stock_value(uuid) to authenticated;
