-- Per-customer special prices ("Chidi pays ₦11,000 for the red wax print, whatever his tier says").
-- Table + RLS + audit trigger already exist (0300); resolve_price already prefers them. These functions
-- give the dashboard clean errors (permission / 2FA / wrong shop) and set several colours at once.

create or replace function public.set_customer_price(p_customer uuid, p_variant_ids uuid[], p_price_kobo bigint, p_note text default null)
returns int
language plpgsql security invoker set search_path = '' as $$
declare
  v_business uuid;
  v_n int;
begin
  select business_id into v_business from public.customers where id = p_customer;
  if v_business is null then raise exception using errcode = 'P0002', message = 'not_found'; end if;
  perform app.require_permission(v_business, 'prices.manage');
  perform app.require_aal2();
  if p_price_kobo is null or p_price_kobo < 0 or p_price_kobo > 100000000000 then
    raise exception using errcode = '22023', message = 'invalid_price';
  end if;
  if coalesce(array_length(p_variant_ids, 1), 0) = 0 or array_length(p_variant_ids, 1) > 200 then
    raise exception using errcode = '22023', message = 'invalid_variants';
  end if;
  if exists (select 1 from unnest(p_variant_ids) x(id)
             where not exists (select 1 from public.product_variants v where v.id = x.id and v.business_id = v_business)) then
    raise exception using errcode = '22023', message = 'invalid_variants';
  end if;
  insert into public.customer_price_overrides (business_id, customer_id, variant_id, price_kobo, note)
  select v_business, p_customer, x.id, p_price_kobo, nullif(left(trim(coalesce(p_note, '')), 200), '')
  from (select distinct id from unnest(p_variant_ids) x(id)) x
  on conflict (customer_id, variant_id) do update set price_kobo = excluded.price_kobo, note = excluded.note, updated_at = now();
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.clear_customer_price(p_customer uuid, p_variant_ids uuid[])
returns int
language plpgsql security invoker set search_path = '' as $$
declare
  v_business uuid;
  v_n int;
begin
  select business_id into v_business from public.customers where id = p_customer;
  if v_business is null then raise exception using errcode = 'P0002', message = 'not_found'; end if;
  perform app.require_permission(v_business, 'prices.manage');
  perform app.require_aal2();
  delete from public.customer_price_overrides where customer_id = p_customer and variant_id = any(p_variant_ids);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke execute on function public.set_customer_price(uuid, uuid[], bigint, text) from public, anon;
revoke execute on function public.clear_customer_price(uuid, uuid[]) from public, anon;
grant execute on function public.set_customer_price(uuid, uuid[], bigint, text) to authenticated;
grant execute on function public.clear_customer_price(uuid, uuid[]) to authenticated;
