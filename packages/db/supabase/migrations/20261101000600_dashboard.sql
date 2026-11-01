-- Owner "Today" command centre in one round trip. Africa/Lagos day boundaries.
create or replace function public.dashboard_today(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text := (select timezone from public.businesses where id = p_business);
  v_start timestamptz;
  v_week timestamptz;
  v_out jsonb;
  v_costs boolean;
begin
  if not app.is_staff(p_business) then perform app.raise_forbidden(); end if;
  v_start := date_trunc('day', now() at time zone v_tz) at time zone v_tz;
  v_week := v_start - interval '6 days';
  v_costs := app.has_permission(p_business, 'costs.view');

  with sold as (
    select o.* from public.orders o
    where o.business_id = p_business and o.status in ('confirmed', 'completed') and coalesce(o.confirmed_at, o.created_at) >= v_start
  )
  select jsonb_build_object(
    'taken_today_kobo', (select coalesce(sum(p.amount_kobo), 0) from public.payments p
                         where p.business_id = p_business and p.status = 'succeeded' and p.received_at >= v_start),
    'taken_same_day_last_week_kobo', (select coalesce(sum(p.amount_kobo), 0) from public.payments p
                         where p.business_id = p_business and p.status = 'succeeded'
                           and p.received_at >= v_start - interval '7 days' and p.received_at < now() - interval '7 days'),
    'sales_today_kobo', (select coalesce(sum(total_kobo), 0) from sold),
    'profit_today_kobo', case when v_costs then (
        select coalesce(sum(i.line_total_kobo - coalesce(i.unit_cost_kobo, 0) * i.base_qty), 0)
        from public.order_items i join sold s on s.id = i.order_id) end,
    'orders_today', (select count(*) from public.orders where business_id = p_business and created_at >= v_start),
    'to_pack', (select count(*) from public.orders where business_id = p_business and status = 'confirmed' and fulfilment_status = 'confirmed'),
    'on_the_way', (select count(*) from public.orders where business_id = p_business and fulfilment_status = 'dispatched'),
    'awaiting_transfer', (select count(*) from public.orders where business_id = p_business and status = 'pending'),
    'owed_kobo', (select coalesce(sum(balance_kobo), 0) from public.orders where business_id = p_business and status in ('confirmed', 'completed')),
    'late_kobo', (select coalesce(sum(balance_kobo), 0) from public.orders where business_id = p_business and status in ('confirmed', 'completed') and due_date < current_date),
    'by_channel', (select coalesce(jsonb_object_agg(channel, total), '{}'::jsonb) from (
        select channel::text, sum(total_kobo) total from sold group by 1) c),
    'by_hour', (select coalesce(jsonb_agg(jsonb_build_object('hour', h, 'channel', ch, 'total', t) order by h), '[]'::jsonb) from (
        select extract(hour from coalesce(confirmed_at, created_at) at time zone v_tz)::int h, channel::text ch, sum(total_kobo) t
        from sold group by 1, 2) x),
    'needs_you', jsonb_build_object(
      'wholesale_pending', (select count(*) from public.customers where business_id = p_business and wholesale_status = 'pending'),
      'wholesale_first', (select coalesce(business_name, name) from public.customers where business_id = p_business and wholesale_status = 'pending' order by created_at limit 1),
      'unplaced_payments', (select count(*) from public.payments where business_id = p_business and order_id is null and status = 'succeeded'),
      'unplaced_kobo', (select coalesce(sum(amount_kobo), 0) from public.payments where business_id = p_business and order_id is null and status = 'succeeded'),
      'conflicts', (select count(*) from public.stock_alerts where business_id = p_business and kind = 'oversell_conflict' and resolved_at is null),
      'conflict_first', (select message from public.stock_alerts where business_id = p_business and kind = 'oversell_conflict' and resolved_at is null order by created_at desc limit 1),
      'low_stock', (select count(*) from public.low_stock_variants where business_id = p_business),
      'low_first', (select product_name || coalesce(' · ' || colour, '') || ' · ' || available || ' left'
                    from public.low_stock_variants where business_id = p_business order by available limit 1),
      'attention_orders', (select count(*) from public.orders where business_id = p_business and needs_attention is not null and status <> 'cancelled')
    ),
    'live_orders', (select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
        select o.id, o.order_number, o.channel, o.status, o.payment_status, o.total_kobo, o.created_at,
               coalesce(c.business_name, c.name, o.buyer_name, 'Walk-in') customer
        from public.orders o left join public.customers c on c.id = o.customer_id
        where o.business_id = p_business order by o.created_at desc limit 6) x),
    'best_sellers', (select coalesce(jsonb_agg(x order by x.qty desc), '[]'::jsonb) from (
        select i.name || coalesce(', ' || i.variant_label, '') as name, sum(i.base_qty)::int qty
        from public.order_items i join public.orders o on o.id = i.order_id
        where o.business_id = p_business and o.status in ('confirmed', 'completed') and o.created_at >= v_week
        group by 1 order by 2 desc limit 5) x),
    'tills', (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'name', d.name, 'last_sync_at', d.last_sync_at) order by d.name), '[]'::jsonb)
              from public.devices d where d.business_id = p_business and d.status = 'active')
  ) into v_out;
  return v_out;
end $$;
revoke execute on function public.dashboard_today(uuid) from public, anon;
