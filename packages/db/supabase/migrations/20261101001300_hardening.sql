-- Milestone 11: hardening + NDPA (Nigeria Data Protection Act 2023) data-subject rights.

-- ---------------------------------------------------------------------------
-- 1. Least privilege
-- ---------------------------------------------------------------------------
-- Anonymous visitors never write directly; every buyer action is signed in or goes through a
-- function. RLS already blocked these writes; now the grants are gone too (defence in depth).
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from anon;
revoke truncate, references, trigger on all tables in schema public from authenticated;
alter default privileges in schema public revoke insert, update, delete, truncate, references, trigger on tables from anon;
alter default privileges in schema public revoke truncate, references, trigger on tables from authenticated;

-- More scopes: public token lookups, browser error reports and privacy requests.
create or replace function public.check_rate_limit(p_scope text, p_subject text, p_max int, p_window_seconds int)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_scope not in ('otp', 'signup', 'checkout', 'wa_inbound', 'ai_draft', 'import', 'public', 'client_error', 'privacy') then
    raise exception using errcode = '22023', message = 'invalid_scope';
  end if;
  perform app.rate_limit(
    p_scope || ':' || encode(extensions.digest(coalesce(p_subject, ''), 'sha256'), 'hex'),
    greatest(1, least(p_max, 1000)),
    make_interval(secs => greatest(1, least(p_window_seconds, 86400))));
end $$;

-- check_rate_limit was callable by anyone: a stranger could fill a victim's OTP bucket and lock
-- them out of signing in. Only the server (service role) checks rate limits.
revoke execute on function public.check_rate_limit(text, text, int, int) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. NDPA: see, export, control and erase your own data
-- ---------------------------------------------------------------------------
-- Everything Trawer holds about the signed-in person, across every shop they buy from.
create or replace function public.my_data_export() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then perform app.raise_forbidden('not_authenticated'); end if;
  return jsonb_build_object(
    'generated_at', now(),
    'account', (select jsonb_build_object('phone', u.phone, 'created_at', u.created_at) from auth.users u where u.id = v_uid),
    'consents', coalesce((select jsonb_agg(jsonb_build_object('shop', b.name, 'kind', c.kind, 'granted', c.granted, 'version', c.version, 'at', c.created_at) order by c.created_at)
                          from public.consents c left join public.businesses b on b.id = c.business_id where c.user_id = v_uid), '[]'::jsonb),
    'shops', coalesce((select jsonb_agg(jsonb_build_object(
        'shop', b.name,
        'profile', jsonb_build_object('name', cu.name, 'business_name', cu.business_name, 'phone', cu.phone, 'email', cu.email, 'buyer_type', cu.buyer_type,
                     'wholesale_status', cu.wholesale_status, 'cac_number', cu.cac_number, 'default_address', cu.default_address, 'marketing_opt_in', cu.marketing_opt_in,
                     'credit_limit_kobo', cu.credit_limit_kobo, 'customer_since', cu.created_at),
        'orders', coalesce((select jsonb_agg(jsonb_build_object('order_number', o.order_number, 'placed_at', o.created_at, 'channel', o.channel, 'status', o.status,
                     'payment_status', o.payment_status, 'fulfilment_status', o.fulfilment_status, 'total_kobo', o.total_kobo, 'paid_kobo', o.amount_paid_kobo,
                     'balance_kobo', o.balance_kobo, 'delivery_method', o.delivery_method, 'delivery_address', o.delivery_address,
                     'items', (select jsonb_agg(jsonb_build_object('name', i.name, 'variant', i.variant_label, 'qty', i.unit_qty, 'line_total_kobo', i.line_total_kobo)) from public.order_items i where i.order_id = o.id))
                   order by o.created_at) from public.orders o where o.customer_id = cu.id), '[]'::jsonb),
        'payments', coalesce((select jsonb_agg(jsonb_build_object('amount_kobo', p.amount_kobo, 'method', p.method, 'received_at', p.received_at) order by p.received_at)
                   from public.payments p where p.customer_id = cu.id), '[]'::jsonb),
        'transfer_accounts', coalesce((select jsonb_agg(jsonb_build_object('bank', va.bank_name, 'account_number', va.account_number, 'status', va.status))
                   from public.virtual_accounts va where va.customer_id = cu.id), '[]'::jsonb),
        'whatsapp_messages_sent_to_you', (select count(*) from public.notifications n where n.customer_id = cu.id))
      order by b.name) from public.customers cu join public.businesses b on b.id = cu.business_id where cu.user_id = v_uid), '[]'::jsonb));
end $$;

-- Marketing / WhatsApp-updates consent per shop (or everywhere when p_business is null). Append-only.
create or replace function public.set_my_consent(p_business uuid, p_kind text, p_granted boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if auth.uid() is null then perform app.raise_forbidden('not_authenticated'); end if;
  if p_kind not in ('marketing', 'whatsapp_updates') then raise exception using errcode = '22023', message = 'invalid_consent'; end if;
  if p_business is not null and not exists (select 1 from public.customers where business_id = p_business and user_id = auth.uid()) then
    perform app.raise_forbidden('not_found');
  end if;
  insert into public.consents (user_id, business_id, kind, version, granted) values (auth.uid(), p_business, p_kind, 'v1', p_granted);
  if p_kind = 'marketing' then
    update public.customers set marketing_opt_in = p_granted where user_id = auth.uid() and (p_business is null or business_id = p_business);
  end if;
end $$;

create or replace function app.erased_phone(p_id uuid) returns text
language sql immutable set search_path = '' as $$
  select '+000' || lpad((('x' || substr(md5(p_id::text), 1, 12))::bit(48)::bigint % 100000000000)::text, 11, '0')
$$;

-- Anonymise one customer row and the personal data hanging off it. Orders and payments stay
-- (shops must keep sales records) but no longer identify the person.
create or replace function app.erase_customer(p_customer uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare c public.customers;
begin
  select * into c from public.customers where id = p_customer for update;
  if not found then return; end if;
  -- '+000…' is never a real number (no country code 000) but still passes phone normalisation.
  update public.customers set name = 'Erased customer', business_name = null, phone = app.erased_phone(c.id), email = null,
    cac_number = null, shop_photo_path = null, default_address = null, notes = null, marketing_opt_in = false, user_id = null
   where id = c.id;
  update public.orders set delivery_address = null, buyer_name = null, buyer_phone = null, note = null where customer_id = c.id;
  update public.deliveries set address = null, recipient_name = null, recipient_phone = null, received_by = null
   where order_id in (select id from public.orders where customer_id = c.id);
  delete from public.whatsapp_sessions where customer_id = c.id or wa_phone = c.phone;
  delete from public.notifications where customer_id = c.id;
  update public.virtual_accounts set status = 'inactive' where customer_id = c.id and status = 'active';
  perform app.audit(c.business_id, 'customer.erased', 'customer', c.id::text, null, jsonb_build_object('reason', p_reason));
end $$;
revoke execute on function app.erase_customer(uuid, text) from public, anon, authenticated;

-- "Delete my account": refuses while you owe a shop (records kept for a legal obligation) or
-- while you are staff somewhere; otherwise cancels unpaid held orders, anonymises every shop's
-- customer record and removes the sign-in.
create or replace function public.delete_my_account(p_confirm text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_owed bigint; r_cust record; r_order record; v_n int := 0;
begin
  if v_uid is null then perform app.raise_forbidden('not_authenticated'); end if;
  if p_confirm is distinct from 'DELETE' then raise exception using errcode = '22023', message = 'confirm_required'; end if;
  if exists (select 1 from public.staff_members where user_id = v_uid and status = 'active') then
    raise exception using errcode = '22023', message = 'staff_must_leave_first';
  end if;
  select coalesce(sum(o.balance_kobo), 0) into v_owed from public.orders o join public.customers cu on cu.id = o.customer_id
   where cu.user_id = v_uid and o.status in ('confirmed', 'completed') and o.balance_kobo > 0;
  if v_owed > 0 then raise exception using errcode = '22023', message = 'balance_outstanding', detail = v_owed::text; end if;

  for r_order in select ord.id from public.orders ord join public.customers cu on cu.id = ord.customer_id
           where cu.user_id = v_uid and ord.status = 'pending' and ord.amount_paid_kobo = 0 loop
    perform public.cancel_order(r_order.id, 'account_deleted');
  end loop;
  for r_cust in select id from public.customers where user_id = v_uid loop
    perform app.erase_customer(r_cust.id, 'data_subject_request');
    v_n := v_n + 1;
  end loop;
  delete from auth.users where id = v_uid;   -- consents cascade; nothing else refers to the person
  return jsonb_build_object('erased_shops', v_n);
end $$;

-- Retention (daily, service only): customers with no orders or messages for longer than the shop's
-- retention period and nothing owed are anonymised; old message logs and raw webhooks are pruned.
create or replace function public.apply_retention() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare r record; v_customers int := 0; v_notifications int; v_webhooks int;
begin
  if not app.is_service() then perform app.raise_forbidden(); end if;
  for r in
    select cu.id from public.customers cu join public.businesses b on b.id = cu.business_id
    where cu.phone not like '+000%'
      and cu.created_at < now() - make_interval(months => b.data_retention_months)
      and not exists (select 1 from public.orders o where o.customer_id = cu.id
                      and (o.created_at > now() - make_interval(months => b.data_retention_months) or o.balance_kobo > 0 and o.status in ('confirmed', 'completed', 'pending')))
      and not exists (select 1 from public.whatsapp_sessions s where s.customer_id = cu.id and s.updated_at > now() - make_interval(months => b.data_retention_months))
      and not exists (select 1 from public.staff_members sm where sm.business_id = cu.business_id and sm.user_id = cu.user_id and sm.status = 'active')
    limit 1000
  loop
    perform app.erase_customer(r.id, 'retention');
    v_customers := v_customers + 1;
  end loop;
  delete from public.notifications where created_at < now() - interval '12 months';
  get diagnostics v_notifications = row_count;
  update public.webhook_events set payload = jsonb_build_object('pruned', true) where received_at < now() - interval '90 days' and payload ? 'pruned' is not true;
  get diagnostics v_webhooks = row_count;
  return jsonb_build_object('customers_erased', v_customers, 'notifications_deleted', v_notifications, 'webhooks_pruned', v_webhooks);
end $$;

revoke execute on function public.my_data_export() from public, anon;
revoke execute on function public.set_my_consent(uuid, text, boolean) from public, anon;
revoke execute on function public.delete_my_account(text) from public, anon;
revoke execute on function public.apply_retention() from public, anon, authenticated;
grant execute on function public.my_data_export(), public.set_my_consent(uuid, text, boolean), public.delete_my_account(text) to authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('trawer-retention', '17 2 * * *', 'select public.apply_retention()');
  end if;
end $$;
