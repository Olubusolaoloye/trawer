-- Storefront design: each shop customises the look of its own store (theme, font, layout,
-- banner, announcement, section order, about + social links). The shape is validated in the
-- API with the shared zod schema (@trawer/core/storefront); the database keeps it bounded.

alter table public.businesses
  add column storefront jsonb not null default '{}'::jsonb,
  add column storefront_updated_at timestamptz,
  add constraint businesses_storefront_shape check (jsonb_typeof(storefront) = 'object' and pg_column_size(storefront) <= 16384);

-- Only through this function (audited); a direct UPDATE of the column is not granted.
create or replace function public.set_storefront(p_business uuid, p_config jsonb) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_old jsonb;
begin
  perform app.require_permission(p_business, 'settings.manage');
  if jsonb_typeof(p_config) <> 'object' then
    raise exception using errcode = '22023', message = 'invalid_storefront';
  end if;
  select storefront into v_old from public.businesses where id = p_business for update;
  update public.businesses set storefront = p_config, storefront_updated_at = now() where id = p_business;
  perform app.audit(p_business, 'storefront.updated', 'business', p_business::text, v_old, p_config);
end $$;
revoke execute on function public.set_storefront(uuid, jsonb) from public, anon;
grant execute on function public.set_storefront(uuid, jsonb) to authenticated;
