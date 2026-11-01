-- Invoices + receipts (shareable by token) and the debtors' book (credit ledger, reminders).

alter table public.businesses
  add column debt_reminders_enabled boolean not null default true,
  add column default_credit_days int not null default 7 check (default_credit_days between 1 and 365);

alter table public.orders add column last_reminded_at timestamptz, add column reminders_sent int not null default 0;
create index orders_due_idx on public.orders (business_id, due_date) where balance_kobo > 0 and status in ('confirmed', 'completed');

create type public.document_kind as enum ('invoice', 'receipt');

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  kind public.document_kind not null,
  number text not null,
  order_id uuid not null,
  payment_id uuid,
  public_token text not null unique default app.random_token(18),
  issued_at timestamptz not null default now(),
  issued_by uuid,
  unique (business_id, kind, number),
  foreign key (business_id, order_id) references public.orders (business_id, id) on delete cascade,
  foreign key (payment_id) references public.payments (id) on delete cascade
);
create unique index invoices_one_per_order on public.invoices (order_id) where kind = 'invoice';
create unique index invoices_one_per_payment on public.invoices (payment_id) where kind = 'receipt';
create index invoices_business_idx on public.invoices (business_id, issued_at desc);

-- Debtors' book: every credit charge and every payment against credit, per customer.
create type public.credit_entry_kind as enum ('charge', 'payment', 'adjustment');
create table public.credit_entries (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  customer_id uuid not null,
  order_id uuid,
  kind public.credit_entry_kind not null,
  amount_kobo bigint not null check (amount_kobo <> 0),   -- + owed to the shop, − paid back
  due_date date,
  note text,
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (business_id, customer_id) references public.customers (business_id, id) on delete cascade,
  foreign key (business_id, order_id) references public.orders (business_id, id) on delete set null (order_id)
);
create index credit_entries_customer_idx on public.credit_entries (customer_id, created_at);
create index credit_entries_business_idx on public.credit_entries (business_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
create or replace function app.issue_document(p_business uuid, p_kind public.document_kind, p_order uuid, p_payment uuid default null)
returns public.invoices
language plpgsql volatile security definer set search_path = '' as $$
declare r public.invoices; v_prefix text := case p_kind when 'invoice' then 'INV' else 'RCT' end;
begin
  if p_kind = 'invoice' then
    select * into r from public.invoices where order_id = p_order and kind = 'invoice';
  else
    select * into r from public.invoices where payment_id = p_payment and kind = 'receipt';
  end if;
  if found then return r; end if;
  insert into public.invoices (business_id, kind, number, order_id, payment_id, issued_by)
  values (p_business, p_kind, v_prefix || '-' || lpad(app.next_counter(p_business, p_kind::text)::text, 6, '0'), p_order, p_payment, auth.uid())
  on conflict do nothing
  returning * into r;
  if r.id is null then  -- lost a race: read the winner
    select * into r from public.invoices where (p_kind = 'invoice' and order_id = p_order and kind = 'invoice') or (p_kind = 'receipt' and payment_id = p_payment);
  end if;
  return r;
end $$;
revoke execute on function app.issue_document(uuid, public.document_kind, uuid, uuid) from public, anon, authenticated;

-- Staff (orders.view) or the buyer of the order may get the shareable invoice.
create or replace function public.order_invoice(p_order uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare o public.orders; r public.invoices;
begin
  select * into o from public.orders where id = p_order;
  if not found or not (app.has_permission(o.business_id, 'orders.view') or o.customer_id in (select app.my_customer_ids())) then
    perform app.raise_forbidden('not_found');
  end if;
  r := app.issue_document(o.business_id, 'invoice', o.id);
  return jsonb_build_object('number', r.number, 'token', r.public_token);
end $$;
revoke execute on function public.order_invoice(uuid) from public, anon;

-- Every payment against an order gets a receipt automatically.
create or replace function app.payments_receipt() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.order_id is not null and new.status = 'succeeded' then
    perform app.issue_document(new.business_id, 'receipt', new.order_id, new.id);
  end if;
  return null;
end $$;
create trigger payments_receipt after insert on public.payments for each row execute function app.payments_receipt();

-- Public document by token (the link the shop shares). Business details, buyer name, lines,
-- payments and how to pay the balance. No phone numbers.
create or replace function public.document_by_token(p_token text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare d public.invoices; o public.orders; b public.businesses; c public.customers; p public.payments;
begin
  select * into d from public.invoices where public_token = p_token;
  if not found then return null; end if;
  select * into o from public.orders where id = d.order_id;
  select * into b from public.businesses where id = d.business_id;
  select * into c from public.customers where id = o.customer_id;
  if d.payment_id is not null then select * into p from public.payments where id = d.payment_id; end if;
  return jsonb_build_object(
    'kind', d.kind, 'number', d.number, 'issued_at', d.issued_at,
    'business', jsonb_build_object('name', b.name, 'slug', b.slug::text, 'address', b.address, 'phone', b.phone, 'brand_colour', b.brand_colour, 'logo_path', b.logo_path),
    'customer', case when c.id is null then null else jsonb_build_object('name', c.name, 'business_name', c.business_name) end,
    'order', jsonb_build_object('number', o.order_number, 'created_at', o.created_at, 'status', o.status, 'channel', o.channel,
      'subtotal_kobo', o.subtotal_kobo, 'delivery_fee_kobo', o.delivery_fee_kobo, 'total_kobo', o.total_kobo,
      'amount_paid_kobo', o.amount_paid_kobo, 'balance_kobo', o.balance_kobo, 'due_date', o.due_date, 'is_credit', o.is_credit,
      'tracking_token', o.tracking_token),
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', i.name, 'variant_label', i.variant_label, 'unit_qty', i.unit_qty,
                         'unit', (select case when i.unit_qty = 1 then u.name else u.plural end from public.units u where u.id = i.unit_id), 'base_qty', i.base_qty,
                         'unit_price_kobo', i.unit_price_kobo, 'line_total_kobo', i.line_total_kobo) order by i.created_at, i.name)
                       from public.order_items i where i.order_id = o.id), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object('method', x.method, 'amount_kobo', x.amount_kobo, 'received_at', x.received_at) order by x.received_at)
                          from public.payments x where x.order_id = o.id and x.status = 'succeeded'), '[]'::jsonb),
    'payment', case when p.id is null then null else jsonb_build_object('method', p.method, 'amount_kobo', p.amount_kobo, 'received_at', p.received_at) end,
    'pay_to', (select jsonb_build_object('account_number', va.account_number, 'bank_name', va.bank_name, 'account_name', va.account_name)
               from public.virtual_accounts va where va.customer_id = o.customer_id and va.status = 'active' limit 1)
  );
end $$;
grant execute on function public.document_by_token(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Credit
-- ---------------------------------------------------------------------------
-- Ledger entries follow the orders table: a charge when an order is confirmed with a balance,
-- a payment entry whenever money comes in against a credit order.
create or replace function app.orders_credit_ledger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.customer_id is null then return null; end if;
  -- Charge: the moment an order is both confirmed and on credit (web/WhatsApp via confirm_on_credit,
  -- or a till credit sale flagged by sync_pos_sale).
  if new.is_credit and new.status = 'confirmed' and new.balance_kobo > 0
     and not (old.is_credit and old.status = 'confirmed') then
    insert into public.credit_entries (business_id, customer_id, order_id, kind, amount_kobo, due_date, created_by, note)
    values (new.business_id, new.customer_id, new.id, 'charge', new.balance_kobo, new.due_date, auth.uid(), 'Order #' || new.order_number);
  elsif new.amount_paid_kobo > old.amount_paid_kobo and old.is_credit and old.status in ('confirmed', 'completed') and old.balance_kobo > 0 then
    insert into public.credit_entries (business_id, customer_id, order_id, kind, amount_kobo, created_by, note)
    values (new.business_id, new.customer_id, new.id, 'payment',
            -least(new.amount_paid_kobo - old.amount_paid_kobo, old.balance_kobo), auth.uid(), 'Payment on order #' || new.order_number);
  end if;
  return null;
end $$;
create trigger orders_credit_ledger after update on public.orders for each row execute function app.orders_credit_ledger();

-- Confirm an unpaid / part-paid order on credit: stock leaves now, the balance goes to the
-- debtors' book. Needs credit.manage. A customer credit limit (> 0) is enforced.
create or replace function public.confirm_on_credit(p_order uuid, p_due_date date default null, p_note text default null)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare o public.orders; c public.customers; v_owing bigint; v_due date;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then perform app.raise_forbidden('not_found'); end if;
  perform app.require_permission(o.business_id, 'credit.manage');
  if o.customer_id is null then raise exception using errcode = '22023', message = 'credit_needs_customer'; end if;
  if o.status not in ('pending', 'confirmed') then raise exception using errcode = '22023', message = 'order_not_open'; end if;
  select * into c from public.customers where id = o.customer_id;
  select coalesce(sum(balance_kobo), 0) into v_owing from public.orders
   where customer_id = c.id and status in ('confirmed', 'completed') and id <> o.id;
  if c.credit_limit_kobo > 0 and v_owing + o.balance_kobo > c.credit_limit_kobo then
    raise exception using errcode = '22023', message = 'credit_limit_exceeded',
      detail = jsonb_build_object('limit_kobo', c.credit_limit_kobo, 'owing_kobo', v_owing)::text;
  end if;
  v_due := coalesce(p_due_date, current_date + (select default_credit_days from public.businesses where id = o.business_id));
  if v_due < current_date then raise exception using errcode = '22023', message = 'due_date_in_past'; end if;
  update public.orders set is_credit = true, due_date = v_due,
    needs_attention = nullif(array_to_string(array_remove(string_to_array(coalesce(needs_attention, ''), ','), 'credit_sale_needs_approval'), ','), ''),
    note = coalesce(nullif(p_note, ''), note)
  where id = o.id;
  if o.status = 'pending' then perform app.confirm_order(o.id); end if;
  perform app.audit(o.business_id, 'credit.granted', 'order', o.id::text, null,
    jsonb_build_object('balance_kobo', o.balance_kobo, 'due_date', v_due));
  return jsonb_build_object('order_id', o.id, 'due_date', v_due);
end $$;
revoke execute on function public.confirm_on_credit(uuid, date, text) from public, anon;

create or replace function public.set_due_date(p_order uuid, p_due_date date) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then perform app.raise_forbidden('not_found'); end if;
  perform app.require_permission(o.business_id, 'credit.manage');
  update public.orders set due_date = p_due_date, reminders_sent = 0, last_reminded_at = null where id = p_order;
  update public.credit_entries set due_date = p_due_date where order_id = p_order and kind = 'charge';
  perform app.audit(o.business_id, 'credit.due_date_changed', 'order', o.id::text,
    jsonb_build_object('due_date', o.due_date), jsonb_build_object('due_date', p_due_date));
end $$;
revoke execute on function public.set_due_date(uuid, date) from public, anon;

-- ---------------------------------------------------------------------------
-- Reminders: on the due date, then every 7 days while overdue, at most 4 per order.
-- ---------------------------------------------------------------------------
create or replace function app.queue_debt_reminder(o public.orders) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare b public.businesses; v_rows int;
begin
  select * into b from public.businesses where id = o.business_id;
  insert into public.notifications (business_id, customer_id, order_id, kind, to_phone, params, dedupe_key)
  select o.business_id, o.customer_id, o.id, 'debt_reminder', c.phone,
         jsonb_build_object('shop', b.name, 'slug', b.slug::text, 'order_number', o.order_number, 'balance_kobo', o.balance_kobo,
                            'due_date', o.due_date, 'tracking_token', o.tracking_token),
         'debt:' || o.id || ':' || current_date
  from public.customers c where c.id = o.customer_id
    -- NDPA: a buyer who switched off WhatsApp updates (for this shop or everywhere) gets no reminders.
    and coalesce((select k.granted from public.consents k
                   where k.user_id = c.user_id and k.kind = 'whatsapp_updates' and (k.business_id is null or k.business_id = o.business_id)
                   order by k.created_at desc limit 1), true)
  on conflict (business_id, dedupe_key) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    update public.orders set last_reminded_at = now(), reminders_sent = reminders_sent + 1 where id = o.id;
  end if;
  return v_rows > 0;
end $$;
revoke execute on function app.queue_debt_reminder(public.orders) from public, anon, authenticated;

create or replace function public.schedule_debt_reminders() returns int
language plpgsql volatile security definer set search_path = '' as $$
declare o public.orders; n int := 0;
begin
  if not app.is_service() then perform app.raise_forbidden(); end if;
  for o in
    select ord.* from public.orders ord join public.businesses b on b.id = ord.business_id
    where b.debt_reminders_enabled and ord.customer_id is not null
      and ord.status in ('confirmed', 'completed') and ord.balance_kobo > 0 and ord.due_date is not null
      and ord.due_date <= current_date and ord.reminders_sent < 4
      and (ord.last_reminded_at is null or ord.last_reminded_at < now() - interval '7 days')
  loop
    if app.queue_debt_reminder(o) then n := n + 1; end if;
  end loop;
  return n;
end $$;
revoke execute on function public.schedule_debt_reminders() from public, anon, authenticated;

-- Staff "remind now" (once per order per day).
create or replace function public.remind_debtor(p_order uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order for update;
  if not found then perform app.raise_forbidden('not_found'); end if;
  perform app.require_permission(o.business_id, 'credit.manage');
  if o.balance_kobo <= 0 or o.status not in ('confirmed', 'completed') then raise exception using errcode = '22023', message = 'nothing_owed'; end if;
  return app.queue_debt_reminder(o);
end $$;
revoke execute on function public.remind_debtor(uuid) from public, anon;

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------
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
      'customers', coalesce((select jsonb_agg(to_jsonb(pc) order by pc.overdue_kobo desc nulls last, pc.owing_kobo desc) from per_customer pc), '[]'::jsonb),
      'orders', coalesce((select jsonb_agg(jsonb_build_object('id', oo.id, 'customer_id', oo.customer_id, 'order_number', oo.order_number,
                           'balance_kobo', oo.balance_kobo, 'due_date', oo.due_date, 'days_late', oo.days_late) order by oo.due_date nulls last)
                         from open_orders oo), '[]'::jsonb))
  );
end $$;
revoke execute on function public.debtors_report(uuid) from public, anon;

-- A customer's statement: every credit charge and payment with a running balance.
create or replace function public.customer_statement(p_customer uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare c public.customers;
begin
  select * into c from public.customers where id = p_customer;
  if not found or not (app.has_permission(c.business_id, 'customers.view') or c.user_id = auth.uid()) then
    perform app.raise_forbidden('not_found');
  end if;
  return jsonb_build_object(
    'customer', jsonb_build_object('id', c.id, 'name', c.name, 'business_name', c.business_name, 'credit_limit_kobo', c.credit_limit_kobo),
    'entries', coalesce((select jsonb_agg(x order by x.created_at) from (
       select e.created_at, e.kind, e.amount_kobo, e.due_date, e.note, o.order_number,
              sum(e.amount_kobo) over (order by e.created_at, e.id) running_kobo
       from public.credit_entries e left join public.orders o on o.id = e.order_id
       where e.customer_id = c.id) x), '[]'::jsonb));
end $$;
revoke execute on function public.customer_statement(uuid) from public, anon;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.invoices enable row level security;
alter table public.credit_entries enable row level security;

create policy invoices_read on public.invoices for select to authenticated
  using (app.has_permission(business_id, 'orders.view')
         or order_id in (select o.id from public.orders o where o.customer_id in (select app.my_customer_ids())));
create policy credit_entries_read on public.credit_entries for select to authenticated
  using (app.has_permission(business_id, 'customers.view') or customer_id in (select app.my_customer_ids()));

revoke all on public.invoices, public.credit_entries from anon;
revoke insert, update, delete on public.invoices, public.credit_entries from authenticated;

-- Credit sales without an explicit due date (e.g. from a till) get the shop's default terms.
create or replace function app.orders_default_due() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.is_credit and new.due_date is null then
    new.due_date := current_date + (select default_credit_days from public.businesses where id = new.business_id);
  end if;
  return new;
end $$;
create trigger orders_default_due before insert or update of is_credit, due_date on public.orders
  for each row execute function app.orders_default_due();
