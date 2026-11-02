-- Debtors' book: most overdue first, then the longest late, then the biggest balance (stable order for equal amounts).
create or replace function public.debtors_report(p_business uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.has_permission(p_business, 'customers.view') then perform app.raise_forbidden(); end if;
  return (
    with open_orders as (
      select o.customer_id, o.balance_kobo, o.due_date, o.order_number, o.id, o.created_at,
             greatest(current_date - coalesce(o.due_date, o.created_at::date), 0) days_late
      from public.orders o
      where o.business_id = p_business and o.status in ('confirmed', 'completed') and o.balance_kobo > 0 and o.customer_id is not null),
    per_customer as (
      select c.id, c.name, c.business_name, c.phone, c.credit_limit_kobo,
             sum(oo.balance_kobo)::bigint owing_kobo,
             sum(oo.balance_kobo) filter (where oo.due_date < current_date)::bigint overdue_kobo,
             min(oo.due_date) oldest_due, max(oo.days_late) max_days_late, count(*)::int open_orders,
             (select max(p.received_at) from public.payments p where p.customer_id = c.id) last_payment_at
      from open_orders oo join public.customers c on c.id = oo.customer_id
      group by c.id)
    select jsonb_build_object(
      'total_kobo', coalesce((select sum(balance_kobo) from open_orders), 0),
      'overdue_kobo', coalesce((select sum(balance_kobo) from open_orders where due_date < current_date), 0),
      'aging', jsonb_build_object(
        'not_due', coalesce((select sum(balance_kobo) from open_orders where due_date is null or due_date >= current_date), 0),
        'd1_30', coalesce((select sum(balance_kobo) from open_orders where due_date < current_date and current_date - due_date between 1 and 30), 0),
        'd31_60', coalesce((select sum(balance_kobo) from open_orders where due_date < current_date and current_date - due_date between 31 and 60), 0),
        'd60_plus', coalesce((select sum(balance_kobo) from open_orders where due_date < current_date and current_date - due_date > 60), 0)),
      'customers', coalesce((select jsonb_agg(to_jsonb(pc) order by pc.overdue_kobo desc nulls last, pc.max_days_late desc, pc.owing_kobo desc, pc.name) from per_customer pc), '[]'::jsonb),
      'orders', coalesce((select jsonb_agg(jsonb_build_object('id', oo.id, 'customer_id', oo.customer_id, 'order_number', oo.order_number,
                           'balance_kobo', oo.balance_kobo, 'due_date', oo.due_date, 'days_late', oo.days_late) order by oo.due_date nulls last)
                         from open_orders oo), '[]'::jsonb))
  );
end $$;
revoke execute on function public.debtors_report(uuid) from public, anon;
