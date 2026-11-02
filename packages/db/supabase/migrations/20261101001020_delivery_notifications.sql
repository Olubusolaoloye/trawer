-- Delivery messages: one per attempt (a retry after a failed attempt must notify again), and they
-- carry the rider's first name + cash to collect so the buyer knows who is coming and what to pay.
create or replace function app.orders_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  b public.businesses;
  v_params jsonb;
  v_attempt int; v_rider text; v_collect bigint;
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
    select d.attempts, split_part(nullif(sm.display_name, ''), ' ', 1), d.collect_kobo
      into v_attempt, v_rider, v_collect
      from public.deliveries d left join public.staff_members sm on sm.id = d.rider_id where d.order_id = new.id;
    perform app.enqueue_notification(new.business_id, new.customer_id, new.id,
      case new.fulfilment_status when 'failed' then 'delivery_failed' else new.fulfilment_status::text end::public.notification_kind,
      v_params || jsonb_strip_nulls(jsonb_build_object('rider', v_rider, 'collect_kobo', nullif(v_collect, 0), 'attempt', v_attempt)),
      new.fulfilment_status::text || ':' || new.id || case when new.fulfilment_status in ('dispatched', 'failed') then ':' || coalesce(v_attempt, 0) else '' end);
  end if;
  return null;
end $$;
