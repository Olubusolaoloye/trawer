-- Milestone 8: delivery tracking.
-- One delivery per order (address snapshot, rider, timestamps per stage, proof photo) plus an
-- append-only event timeline. All changes go through set_fulfilment(), which enforces the allowed
-- transitions and who may make them, keeps orders.fulfilment_status in step (that column drives
-- the buyer's WhatsApp updates, see 0700) and is idempotent for riders working offline.

create type public.delivery_failure as enum ('not_home', 'wrong_address', 'refused', 'unreachable', 'damaged', 'other');

create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  order_id uuid not null unique,
  rider_id uuid references public.staff_members (id) on delete set null,
  address jsonb,
  recipient_name text,
  recipient_phone text,
  collect_kobo bigint not null default 0 check (collect_kobo >= 0),   -- cash to collect at the door (balance when dispatched)
  attempts int not null default 0,
  packed_at timestamptz,
  dispatched_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  returned_at timestamptz,
  failure public.delivery_failure,
  failure_note text,
  proof_path text check (proof_path is null or proof_path ~ '^[A-Za-z0-9/_-]+\.webp$'),
  received_by text check (char_length(received_by) <= 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (business_id, order_id) references public.orders (business_id, id) on delete cascade
);
create index deliveries_rider_idx on public.deliveries (rider_id, updated_at desc);
create index deliveries_business_idx on public.deliveries (business_id, updated_at desc);
create trigger deliveries_touch before update on public.deliveries for each row execute function app.touch_updated_at();

create table public.delivery_events (
  id bigint generated always as identity primary key,
  business_id uuid not null references public.businesses (id) on delete cascade,
  delivery_id uuid not null references public.deliveries (id) on delete cascade,
  order_id uuid not null,
  status public.fulfilment_status not null,
  actor_id uuid,
  actor_name text,
  note text check (char_length(note) <= 300),
  failure public.delivery_failure,
  photo_path text,
  client_id uuid,
  occurred_at timestamptz not null default now(),   -- when it happened on the rider's phone
  created_at timestamptz not null default now()
);
create unique index delivery_events_client_idx on public.delivery_events (business_id, client_id) where client_id is not null;
create index delivery_events_delivery_idx on public.delivery_events (delivery_id, occurred_at);

-- Create the delivery record on first use (snapshot of where and to whom).
create or replace function app.ensure_delivery(p_order uuid) returns public.deliveries
language plpgsql volatile security definer set search_path = '' as $$
declare d public.deliveries; o public.orders; c public.customers;
begin
  select * into d from public.deliveries where order_id = p_order;
  if found then return d; end if;
  select * into o from public.orders where id = p_order;
  select * into c from public.customers where id = o.customer_id;
  insert into public.deliveries (business_id, order_id, address, recipient_name, recipient_phone)
  values (o.business_id, o.id, o.delivery_address, coalesce(c.name, o.buyer_name), coalesce(c.phone, o.buyer_phone))
  on conflict (order_id) do nothing;
  select * into d from public.deliveries where order_id = p_order;
  return d;
end $$;
revoke execute on function app.ensure_delivery(uuid) from public, anon, authenticated;

-- Allowed next steps per fulfilment status and delivery method.
create or replace function app.fulfilment_next(p_from public.fulfilment_status, p_method public.delivery_method)
returns public.fulfilment_status[]
language sql immutable set search_path = '' as $$
  select case p_from
    when 'confirmed' then array['packed']::public.fulfilment_status[]
    when 'packed' then case when p_method = 'delivery' then array['dispatched']::public.fulfilment_status[] else array['collected']::public.fulfilment_status[] end
    when 'dispatched' then array['delivered', 'failed']::public.fulfilment_status[]
    when 'failed' then array['dispatched', 'returned']::public.fulfilment_status[]
    else array[]::public.fulfilment_status[]
  end
$$;

-- Return delivered-then-returned goods to the shelf, once (only what this order actually sold).
create or replace function app.restock_order(p_order uuid) returns int
language plpgsql volatile security definer set search_path = '' as $$
declare r record; v_total int := 0;
begin
  if exists (select 1 from public.stock_movements where order_id = p_order and type = 'return') then return 0; end if;
  for r in
    select business_id, variant_id, location_id, -sum(qty_delta)::int qty
    from public.stock_movements where order_id = p_order and type = 'sale'
    group by 1, 2, 3 having -sum(qty_delta) > 0
  loop
    perform app.lock_stock_level(r.business_id, r.variant_id, r.location_id);
    perform app.apply_movement(r.business_id, r.variant_id, r.location_id, 'return', r.qty, null, p_order, null, 'delivery_returned');
    v_total := v_total + r.qty;
  end loop;
  return v_total;
end $$;
revoke execute on function app.restock_order(uuid) from public, anon, authenticated;

/**
 * Move an order to its next fulfilment step.
 *  - staff with deliveries.manage: any allowed step on any order of the shop
 *  - riders (deliveries.update): only on deliveries assigned to them, and only dispatched/delivered/failed
 * Delivered (by delivery) needs a proof photo; failed needs a reason. Idempotent on p_client_id.
 */
create or replace function public.set_fulfilment(
  p_order uuid, p_status public.fulfilment_status, p_note text default null, p_failure public.delivery_failure default null,
  p_proof_path text default null, p_received_by text default null, p_client_id uuid default null, p_occurred_at timestamptz default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  o public.orders; d public.deliveries; s public.staff_members;
  v_manage boolean; v_at timestamptz := least(coalesce(p_occurred_at, now()), now());
begin
  select * into o from public.orders where id = p_order for update;
  if not found or not app.is_staff(o.business_id) then perform app.raise_forbidden('not_found'); end if;

  if p_client_id is not null and exists (select 1 from public.delivery_events where business_id = o.business_id and client_id = p_client_id) then
    return jsonb_build_object('status', o.fulfilment_status, 'duplicate', true);
  end if;

  v_manage := app.has_permission(o.business_id, 'deliveries.manage');
  select * into s from public.staff_members where business_id = o.business_id and user_id = auth.uid() and status = 'active';
  d := app.ensure_delivery(o.id);
  if not v_manage then
    if not app.has_permission(o.business_id, 'deliveries.update') or d.rider_id is distinct from s.id
       or p_status not in ('dispatched', 'delivered', 'failed') then
      perform app.raise_forbidden('permission_denied');
    end if;
  end if;

  if o.status not in ('confirmed', 'completed') then raise exception using errcode = '22023', message = 'order_not_ready'; end if;
  if not (p_status = any (app.fulfilment_next(o.fulfilment_status, o.delivery_method))) then
    raise exception using errcode = '22023', message = 'invalid_transition';
  end if;
  if p_status = 'delivered' and p_proof_path is null then raise exception using errcode = '22023', message = 'proof_required'; end if;
  if p_proof_path is not null and p_proof_path !~ ('^' || o.business_id::text || '/[A-Za-z0-9_-]+\.webp$') then
    raise exception using errcode = '22023', message = 'invalid_proof';
  end if;
  if p_status = 'failed' and p_failure is null then raise exception using errcode = '22023', message = 'reason_required'; end if;

  update public.deliveries set
    packed_at = case when p_status = 'packed' then v_at else packed_at end,
    dispatched_at = case when p_status = 'dispatched' then v_at else dispatched_at end,
    attempts = attempts + (p_status = 'dispatched')::int,
    collect_kobo = case when p_status = 'dispatched' then o.balance_kobo else collect_kobo end,
    delivered_at = case when p_status in ('delivered', 'collected') then v_at else delivered_at end,
    failed_at = case when p_status = 'failed' then v_at else failed_at end,
    returned_at = case when p_status = 'returned' then v_at else returned_at end,
    failure = case when p_status = 'failed' then p_failure else failure end,
    failure_note = case when p_status = 'failed' then p_note else failure_note end,
    proof_path = coalesce(p_proof_path, proof_path),
    received_by = coalesce(nullif(trim(p_received_by), ''), received_by)
  where id = d.id;

  insert into public.delivery_events (business_id, delivery_id, order_id, status, actor_id, actor_name, note, failure, photo_path, client_id, occurred_at)
  values (o.business_id, d.id, o.id, p_status, auth.uid(), nullif(s.display_name, ''), p_note, p_failure, p_proof_path, p_client_id, v_at);

  -- This update drives the buyer's WhatsApp notification (orders_enqueue_notifications).
  update public.orders set fulfilment_status = p_status,
    status = case when p_status in ('delivered', 'collected') then 'completed'::public.order_status else status end
  where id = o.id;

  if p_status = 'returned' then perform app.restock_order(o.id); end if;

  perform app.audit(o.business_id, 'fulfilment.' || p_status::text, 'order', o.id::text,
    jsonb_build_object('fulfilment', o.fulfilment_status), jsonb_build_object('fulfilment', p_status, 'failure', p_failure));
  return jsonb_build_object('status', p_status, 'duplicate', false);
end $$;
revoke execute on function public.set_fulfilment(uuid, public.fulfilment_status, text, public.delivery_failure, text, text, uuid, timestamptz) from public, anon;
grant execute on function public.set_fulfilment(uuid, public.fulfilment_status, text, public.delivery_failure, text, text, uuid, timestamptz) to authenticated;

-- Assign (or unassign) a rider. The rider must be active staff of the shop who can update deliveries.
create or replace function public.assign_rider(p_order uuid, p_staff uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare o public.orders; d public.deliveries;
begin
  select * into o from public.orders where id = p_order;
  if not found then perform app.raise_forbidden('not_found'); end if;
  perform app.require_permission(o.business_id, 'deliveries.manage');
  if o.delivery_method <> 'delivery' then raise exception using errcode = '22023', message = 'not_a_delivery'; end if;
  if p_staff is not null and not exists (
    select 1 from public.staff_members sm join public.roles_permissions rp on rp.role = sm.role and rp.permission = 'deliveries.update'
    where sm.id = p_staff and sm.business_id = o.business_id and sm.status = 'active') then
    raise exception using errcode = '22023', message = 'not_a_rider';
  end if;
  d := app.ensure_delivery(o.id);
  update public.deliveries set rider_id = p_staff where id = d.id;
  perform app.audit(o.business_id, 'delivery.rider_assigned', 'order', o.id::text, jsonb_build_object('rider', d.rider_id), jsonb_build_object('rider', p_staff));
end $$;
revoke execute on function public.assign_rider(uuid, uuid) from public, anon;
grant execute on function public.assign_rider(uuid, uuid) to authenticated;

-- A rider's run sheet: their open deliveries (and today's finished ones) across their shops.
create or replace function public.my_deliveries(p_business uuid default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x.sort, x.dispatched_at nulls last, x.order_number), '[]'::jsonb) from (
    select d.id, d.order_id, o.order_number, o.fulfilment_status status, d.address, d.recipient_name, d.recipient_phone,
           case when o.fulfilment_status in ('packed', 'dispatched', 'failed') then o.balance_kobo else d.collect_kobo end collect_kobo,
           d.attempts, d.dispatched_at, d.delivered_at, d.failed_at, d.failure, d.business_id, b.name shop, o.note,
           (select coalesce(jsonb_agg(jsonb_build_object('name', i.name, 'label', i.variant_label, 'qty', i.unit_qty,
                     'unit', (select case when i.unit_qty = 1 then u.name else u.plural end from public.units u where u.id = i.unit_id)) order by i.created_at), '[]'::jsonb)
              from public.order_items i where i.order_id = o.id) items,
           case o.fulfilment_status when 'dispatched' then 0 when 'packed' then 1 when 'failed' then 2 else 3 end sort
    from public.deliveries d
    join public.staff_members sm on sm.id = d.rider_id and sm.user_id = auth.uid() and sm.status = 'active'
    join public.orders o on o.id = d.order_id
    join public.businesses b on b.id = d.business_id
    where (p_business is null or d.business_id = p_business)
      and (o.fulfilment_status in ('packed', 'dispatched', 'failed')
           or (o.fulfilment_status in ('delivered', 'returned') and d.updated_at > now() - interval '18 hours'))
  ) x
$$;
revoke execute on function public.my_deliveries(uuid) from public, anon;
grant execute on function public.my_deliveries(uuid) to authenticated;

-- Staff + buyer view of one order's delivery (timeline, rider first name). Proof photo path is staff-only.
create or replace function public.order_delivery(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o public.orders; d public.deliveries; v_staff boolean;
begin
  select * into o from public.orders where id = p_order;
  if not found then return null; end if;
  v_staff := app.has_permission(o.business_id, 'orders.view')
          or exists (select 1 from public.deliveries x join public.staff_members sm on sm.id = x.rider_id where x.order_id = o.id and sm.user_id = auth.uid());
  if not (v_staff or o.customer_id in (select app.my_customer_ids())) then return null; end if;
  select * into d from public.deliveries where order_id = o.id;
  return jsonb_build_object(
    'fulfilment_status', o.fulfilment_status, 'delivery_method', o.delivery_method,
    'delivery', case when d.id is null then null else jsonb_build_object(
      'id', d.id, 'rider_id', case when v_staff then d.rider_id end,
      'rider_name', (select split_part(nullif(sm.display_name, ''), ' ', 1) from public.staff_members sm where sm.id = d.rider_id),
      'attempts', d.attempts, 'collect_kobo', d.collect_kobo, 'failure', d.failure, 'received_by', d.received_by,
      'packed_at', d.packed_at, 'dispatched_at', d.dispatched_at, 'delivered_at', d.delivered_at, 'failed_at', d.failed_at, 'returned_at', d.returned_at,
      'has_proof', d.proof_path is not null, 'proof_path', case when v_staff then d.proof_path end) end,
    'events', coalesce((select jsonb_agg(jsonb_build_object('status', e.status, 'at', e.occurred_at, 'failure', e.failure,
                 'note', case when v_staff then e.note end, 'by', case when v_staff then e.actor_name end) order by e.occurred_at, e.id)
               from public.delivery_events e where e.order_id = o.id), '[]'::jsonb));
end $$;
revoke execute on function public.order_delivery(uuid) from public, anon;
grant execute on function public.order_delivery(uuid) to authenticated;

-- Public tracking timeline (no names, notes or photos): status + time only.
create or replace function public.tracking_events(p_token text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'events', coalesce((select jsonb_agg(jsonb_build_object('status', e.status, 'at', e.occurred_at) order by e.occurred_at, e.id)
                        from public.delivery_events e where e.order_id = o.id), '[]'::jsonb),
    'rider_name', (select split_part(nullif(sm.display_name, ''), ' ', 1) from public.deliveries d join public.staff_members sm on sm.id = d.rider_id
                   where d.order_id = o.id and o.fulfilment_status = 'dispatched'),
    'failure', (select d.failure from public.deliveries d where d.order_id = o.id and o.fulfilment_status = 'failed'))
  from public.orders o where o.tracking_token = p_token
$$;
revoke execute on function public.tracking_events(text) from public, anon, authenticated;

-- RLS: read-only for staff who can see orders, and for the assigned rider; writes only via the functions above.
alter table public.deliveries enable row level security;
alter table public.delivery_events enable row level security;
create policy deliveries_read on public.deliveries for select to authenticated
  using (app.has_permission(business_id, 'orders.view')
         or rider_id in (select sm.id from public.staff_members sm where sm.user_id = auth.uid() and sm.status = 'active'));
create policy delivery_events_read on public.delivery_events for select to authenticated
  using (app.has_permission(business_id, 'orders.view'));
revoke insert, update, delete on public.deliveries, public.delivery_events from anon, authenticated;
