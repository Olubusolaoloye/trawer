-- Milestone 9: Instagram / Facebook posting.
-- Accounts are connected with Facebook Login: the callback stores the candidate Pages (and their
-- linked Instagram Business accounts) in a short-lived connect session, tokens straight into Vault;
-- the owner picks one (MFA) and the others' tokens are destroyed. Posts are scheduled per platform
-- (single product or a carousel of up to 10), published by a cron job that checks Instagram's
-- publishing limit first, with retries and back-off. Products with "auto-post" queue a post when
-- they go live.

create type public.social_platform as enum ('instagram', 'facebook');
create type public.social_account_status as enum ('active', 'expired', 'revoked');
create type public.social_post_status as enum ('scheduled', 'publishing', 'published', 'failed', 'cancelled');

create table public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  platform public.social_platform not null,
  external_id text not null,                 -- IG user id or Facebook Page id
  page_id text not null,                     -- the Facebook Page behind it (IG accounts are linked to a Page)
  name text not null,                        -- @username or Page name
  token_secret_id uuid,                      -- Vault (page access token)
  status public.social_account_status not null default 'active',
  quota_used int,
  quota_total int,
  quota_checked_at timestamptz,
  last_error text,
  connected_by uuid,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, platform)
);
create trigger social_accounts_touch before update on public.social_accounts for each row execute function app.touch_updated_at();

create table public.social_connect_sessions (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  user_id uuid not null,
  candidates jsonb not null,                 -- [{page_id, page_name, ig_id, ig_username, secret_id}] — never tokens
  expires_at timestamptz not null default now() + interval '15 minutes',
  created_at timestamptz not null default now()
);

create table public.social_posts (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses (id) on delete cascade,
  account_id uuid not null references public.social_accounts (id) on delete cascade,
  platform public.social_platform not null,
  kind text not null check (kind in ('single', 'carousel')),
  product_ids uuid[] not null check (cardinality(product_ids) between 1 and 10),
  caption text check (char_length(caption) <= 2200),
  auto boolean not null default false,       -- queued by product auto-post (caption rendered at publish time)
  status public.social_post_status not null default 'scheduled',
  scheduled_for timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  attempts int not null default 0,
  last_error text,
  external_id text,
  permalink text,
  published_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index social_posts_due_idx on public.social_posts (next_attempt_at) where status = 'scheduled';
create index social_posts_business_idx on public.social_posts (business_id, scheduled_for desc);
create trigger social_posts_touch before update on public.social_posts for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Connecting
-- ---------------------------------------------------------------------------
-- Small helper: delete a Vault secret by id (text), ignoring nulls.
create or replace function public.vault_delete(p_id text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_id is not null then delete from vault.secrets where id = p_id::uuid; end if;
end $$;
revoke execute on function public.vault_delete(text) from public, anon, authenticated;

-- Called by the OAuth callback (as the signed-in user). Tokens go into Vault immediately.
create or replace function public.begin_social_connect(p_business uuid, p_candidates jsonb) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v_id uuid; c jsonb; v_out jsonb := '[]'::jsonb; v_secret uuid;
begin
  perform app.require_permission(p_business, 'social.manage');
  -- drop this shop's stale sessions (and their tokens)
  perform public.vault_delete(s.value ->> 'secret_id')
    from public.social_connect_sessions x, jsonb_array_elements(x.candidates) s
   where x.business_id = p_business and x.expires_at < now();
  delete from public.social_connect_sessions where business_id = p_business and expires_at < now();
  if jsonb_typeof(p_candidates) <> 'array' or jsonb_array_length(p_candidates) = 0 or jsonb_array_length(p_candidates) > 50 then
    raise exception using errcode = '22023', message = 'no_pages';
  end if;
  for c in select * from jsonb_array_elements(p_candidates) loop
    v_secret := vault.create_secret(c ->> 'token', 'social_candidate:' || p_business || ':' || (c ->> 'page_id') || ':' || gen_random_uuid(), 'Facebook Page token (pending)');
    v_out := v_out || jsonb_build_object('page_id', c ->> 'page_id', 'page_name', left(c ->> 'page_name', 120),
      'ig_id', c ->> 'ig_id', 'ig_username', left(c ->> 'ig_username', 60), 'secret_id', v_secret);
  end loop;
  insert into public.social_connect_sessions (business_id, user_id, candidates) values (p_business, auth.uid(), v_out) returning id into v_id;
  return v_id;
end $$;

-- What the owner chooses from (no secrets).
create or replace function public.social_connect_choices(p_session uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_agg(c - 'secret_id') from public.social_connect_sessions s, jsonb_array_elements(s.candidates) c
  where s.id = p_session and s.user_id = auth.uid() and s.expires_at > now()
$$;

-- Owner picks a Page: Facebook (+ Instagram when linked) accounts are created with that Page's token.
create or replace function public.connect_social_account(p_session uuid, p_page_id text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare s public.social_connect_sessions; c jsonb; v_secret uuid; v_old uuid[];
begin
  select * into s from public.social_connect_sessions where id = p_session for update;
  if not found or s.user_id is distinct from auth.uid() or s.expires_at < now() then perform app.raise_forbidden('not_found'); end if;
  perform app.require_permission(s.business_id, 'social.manage');
  perform app.require_aal2();
  select x into c from jsonb_array_elements(s.candidates) x where x ->> 'page_id' = p_page_id;
  if c is null then raise exception using errcode = '22023', message = 'unknown_page'; end if;
  v_secret := (c ->> 'secret_id')::uuid;
  perform vault.update_secret(v_secret, null, 'social_token:' || s.business_id || ':' || p_page_id || ':' || gen_random_uuid(), 'Facebook Page token');

  select array_agg(token_secret_id) into v_old from public.social_accounts where business_id = s.business_id and token_secret_id is distinct from v_secret;
  insert into public.social_accounts (business_id, platform, external_id, page_id, name, token_secret_id, status, connected_by, last_error)
  values (s.business_id, 'facebook', p_page_id, p_page_id, c ->> 'page_name', v_secret, 'active', auth.uid(), null)
  on conflict (business_id, platform) do update set external_id = excluded.external_id, page_id = excluded.page_id, name = excluded.name,
    token_secret_id = excluded.token_secret_id, status = 'active', connected_by = excluded.connected_by, connected_at = now(), last_error = null;
  if c ->> 'ig_id' is not null then
    insert into public.social_accounts (business_id, platform, external_id, page_id, name, token_secret_id, status, connected_by, last_error)
    values (s.business_id, 'instagram', c ->> 'ig_id', p_page_id, coalesce(c ->> 'ig_username', c ->> 'page_name'), v_secret, 'active', auth.uid(), null)
    on conflict (business_id, platform) do update set external_id = excluded.external_id, page_id = excluded.page_id, name = excluded.name,
      token_secret_id = excluded.token_secret_id, status = 'active', connected_by = excluded.connected_by, connected_at = now(), last_error = null,
      quota_used = null, quota_total = null, quota_checked_at = null;
  else
    update public.social_accounts set status = 'revoked', token_secret_id = null where business_id = s.business_id and platform = 'instagram';
  end if;

  -- destroy every other token from this session, and the ones the shop used before
  perform public.vault_delete(x ->> 'secret_id') from jsonb_array_elements(s.candidates) x where x ->> 'page_id' <> p_page_id;
  perform public.vault_delete(o::text) from unnest(coalesce(v_old, '{}')) o
   where o is not null and not exists (select 1 from public.social_accounts a where a.token_secret_id = o);
  delete from public.social_connect_sessions where id = s.id;

  perform app.audit(s.business_id, 'social.connected', 'business', s.business_id::text, null,
    jsonb_build_object('page_id', p_page_id, 'page', c ->> 'page_name', 'instagram', c ->> 'ig_username'));
  return jsonb_build_object('facebook', c ->> 'page_name', 'instagram', c ->> 'ig_username');
end $$;

create or replace function public.disconnect_social_account(p_business uuid, p_platform public.social_platform) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare a public.social_accounts;
begin
  perform app.require_permission(p_business, 'social.manage');
  select * into a from public.social_accounts where business_id = p_business and platform = p_platform for update;
  if not found then return; end if;
  update public.social_accounts set status = 'revoked', token_secret_id = null where id = a.id;
  update public.social_posts set status = 'cancelled', last_error = 'account_disconnected' where account_id = a.id and status in ('scheduled', 'failed');
  if a.token_secret_id is not null and not exists (select 1 from public.social_accounts x where x.token_secret_id = a.token_secret_id and x.id <> a.id and x.status = 'active') then
    perform public.vault_delete(a.token_secret_id::text);
  end if;
  perform app.audit(p_business, 'social.disconnected', 'business', p_business::text, jsonb_build_object('platform', p_platform, 'name', a.name), null);
end $$;

-- Service only: the account's token.
create or replace function public.social_token(p_account uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare v text;
begin
  if not app.is_service() then perform app.raise_forbidden(); end if;
  select ds.decrypted_secret into v from vault.decrypted_secrets ds join public.social_accounts a on a.token_secret_id = ds.id
   where a.id = p_account and a.status = 'active';
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Posts
-- ---------------------------------------------------------------------------
create or replace function public.schedule_social_post(
  p_business uuid, p_platform public.social_platform, p_product_ids uuid[], p_caption text, p_scheduled_for timestamptz default null
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare a public.social_accounts; v_id uuid; v_when timestamptz := coalesce(p_scheduled_for, now()); v_ids uuid[];
begin
  perform app.require_permission(p_business, 'social.manage');
  select * into a from public.social_accounts where business_id = p_business and platform = p_platform and status = 'active';
  if not found then raise exception using errcode = '22023', message = 'account_not_connected'; end if;
  select array_agg(distinct x) into v_ids from unnest(p_product_ids) x;
  if v_ids is null or cardinality(v_ids) < 1 or cardinality(v_ids) > 10 then raise exception using errcode = '22023', message = 'pick_1_to_10_products'; end if;
  if exists (select 1 from unnest(v_ids) x where not exists (
      select 1 from public.products p where p.id = x and p.business_id = p_business and p.status = 'active')) then
    raise exception using errcode = '22023', message = 'product_unavailable';
  end if;
  if exists (select 1 from unnest(v_ids) x where not exists (select 1 from public.variant_images vi where vi.product_id = x)) then
    raise exception using errcode = '22023', message = 'product_needs_photo';
  end if;
  if p_caption is null or char_length(trim(p_caption)) = 0 then raise exception using errcode = '22023', message = 'caption_required'; end if;
  if char_length(p_caption) > 2200 then raise exception using errcode = '22023', message = 'caption_too_long'; end if;
  if (select count(*) from regexp_matches(p_caption, '#[[:digit:]_]*[[:alpha:]][[:alnum:]_]*', 'g')) > 30 then raise exception using errcode = '22023', message = 'too_many_hashtags'; end if;
  if v_when < now() - interval '5 minutes' or v_when > now() + interval '75 days' then raise exception using errcode = '22023', message = 'bad_schedule_time'; end if;

  insert into public.social_posts (business_id, account_id, platform, kind, product_ids, caption, scheduled_for, next_attempt_at, created_by)
  values (p_business, a.id, p_platform, case when cardinality(v_ids) > 1 then 'carousel' else 'single' end, v_ids, p_caption,
          greatest(v_when, now()), greatest(v_when, now()), auth.uid())
  returning id into v_id;
  perform app.audit(p_business, 'social.post_scheduled', 'social_post', v_id::text, null,
    jsonb_build_object('platform', p_platform, 'products', cardinality(v_ids), 'at', v_when));
  return v_id;
end $$;

create or replace function public.cancel_social_post(p_post uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare p public.social_posts;
begin
  select * into p from public.social_posts where id = p_post for update;
  if not found then perform app.raise_forbidden('not_found'); end if;
  perform app.require_permission(p.business_id, 'social.manage');
  if p.status not in ('scheduled', 'failed') then raise exception using errcode = '22023', message = 'post_not_cancellable'; end if;
  update public.social_posts set status = 'cancelled' where id = p.id;
end $$;

create or replace function public.retry_social_post(p_post uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare p public.social_posts;
begin
  select * into p from public.social_posts where id = p_post for update;
  if not found then perform app.raise_forbidden('not_found'); end if;
  perform app.require_permission(p.business_id, 'social.manage');
  if p.status <> 'failed' then raise exception using errcode = '22023', message = 'post_not_failed'; end if;
  if not exists (select 1 from public.social_accounts where id = p.account_id and status = 'active') then
    raise exception using errcode = '22023', message = 'account_not_connected';
  end if;
  update public.social_posts set status = 'scheduled', attempts = 0, next_attempt_at = now(), last_error = null where id = p.id;
end $$;

-- Worker: claim due posts (skip locked so several workers can run).
create or replace function public.claim_social_posts(p_limit int default 10) returns setof public.social_posts
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not app.is_service() then perform app.raise_forbidden(); end if;
  -- a worker that died mid-publish: hand the post back after 10 minutes
  update public.social_posts set status = 'scheduled', next_attempt_at = now()
   where status = 'publishing' and updated_at < now() - interval '10 minutes';
  return query
    update public.social_posts sp set status = 'publishing', attempts = sp.attempts + 1
    where sp.id in (
      select p.id from public.social_posts p join public.social_accounts a on a.id = p.account_id and a.status = 'active'
      where p.status = 'scheduled' and p.next_attempt_at <= now()
      order by p.next_attempt_at limit p_limit
      for update of p skip locked)
    returning sp.*;
end $$;

/**
 * Result of one publish attempt.
 *  ok → published.  p_retry_at set (rate limit / quota) → back to scheduled at that time, attempt not counted.
 *  p_reconnect → the token is dead: account marked expired, post failed with a clear reason.
 *  otherwise → back-off 2, 8, 18, 32 min; failed after 5 attempts.
 */
create or replace function public.finish_social_post(
  p_post uuid, p_ok boolean, p_external_id text default null, p_permalink text default null, p_error text default null,
  p_retry_at timestamptz default null, p_reconnect boolean default false, p_caption text default null
) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare p public.social_posts;
begin
  if not app.is_service() then perform app.raise_forbidden(); end if;
  select * into p from public.social_posts where id = p_post for update;
  if not found or p.status <> 'publishing' then return; end if;
  if p_ok then
    update public.social_posts set status = 'published', external_id = p_external_id, permalink = p_permalink, published_at = now(),
      last_error = null, caption = coalesce(p_caption, caption) where id = p.id;
  elsif p_reconnect then
    update public.social_accounts set status = 'expired', last_error = left(p_error, 300) where id = p.account_id;
    update public.social_posts set status = 'failed', last_error = 'reconnect_needed' where id = p.id;
  elsif p_retry_at is not null then
    update public.social_posts set status = 'scheduled', next_attempt_at = p_retry_at, attempts = greatest(attempts - 1, 0), last_error = left(p_error, 300) where id = p.id;
  elsif p.attempts >= 5 then
    update public.social_posts set status = 'failed', last_error = left(p_error, 300) where id = p.id;
  else
    update public.social_posts set status = 'scheduled', next_attempt_at = now() + make_interval(mins => 2 * p.attempts * p.attempts), last_error = left(p_error, 300) where id = p.id;
  end if;
end $$;

create or replace function public.record_social_quota(p_account uuid, p_used int, p_total int) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not app.is_service() then perform app.raise_forbidden(); end if;
  update public.social_accounts set quota_used = p_used, quota_total = p_total, quota_checked_at = now() where id = p_account;
end $$;

-- Auto-post: a product with social_autopost going live queues a post on every connected account.
create or replace function app.products_autopost() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.social_autopost and new.status = 'active' and (tg_op = 'INSERT' or old.status is distinct from 'active') then
    insert into public.social_posts (business_id, account_id, platform, kind, product_ids, caption, auto, scheduled_for, next_attempt_at)
    select new.business_id, a.id, a.platform, 'single', array[new.id], null, true, now() + interval '3 minutes', now() + interval '3 minutes'
    from public.social_accounts a where a.business_id = new.business_id and a.status = 'active'
      and not exists (select 1 from public.social_posts sp where sp.account_id = a.id and sp.auto and sp.product_ids = array[new.id] and sp.status <> 'cancelled');
  end if;
  return null;
end $$;
create trigger products_autopost after insert or update of status, social_autopost on public.products for each row execute function app.products_autopost();

-- ---------------------------------------------------------------------------
-- RLS: staff who manage social see accounts (never tokens) and posts; writes only via functions.
-- ---------------------------------------------------------------------------
alter table public.social_accounts enable row level security;
alter table public.social_posts enable row level security;
alter table public.social_connect_sessions enable row level security;
create policy social_accounts_read on public.social_accounts for select to authenticated using (app.has_permission(business_id, 'social.manage'));
create policy social_posts_read on public.social_posts for select to authenticated using (app.has_permission(business_id, 'social.manage'));
revoke insert, update, delete on public.social_accounts, public.social_posts from anon, authenticated;
revoke all on public.social_connect_sessions from anon, authenticated;
-- Token references are not even visible: only these columns can be read.
revoke select on public.social_accounts from authenticated;
grant select (id, business_id, platform, external_id, page_id, name, status, quota_used, quota_total, quota_checked_at, last_error, connected_at, updated_at)
  on public.social_accounts to authenticated;

revoke execute on function public.begin_social_connect(uuid, jsonb) from public, anon;
revoke execute on function public.social_connect_choices(uuid) from public, anon;
revoke execute on function public.connect_social_account(uuid, text) from public, anon;
revoke execute on function public.disconnect_social_account(uuid, public.social_platform) from public, anon;
revoke execute on function public.social_token(uuid) from public, anon, authenticated;
revoke execute on function public.schedule_social_post(uuid, public.social_platform, uuid[], text, timestamptz) from public, anon;
revoke execute on function public.cancel_social_post(uuid) from public, anon;
revoke execute on function public.retry_social_post(uuid) from public, anon;
revoke execute on function public.claim_social_posts(int) from public, anon, authenticated;
revoke execute on function public.finish_social_post(uuid, boolean, text, text, text, timestamptz, boolean, text) from public, anon, authenticated;
revoke execute on function public.record_social_quota(uuid, int, int) from public, anon, authenticated;
grant execute on function public.begin_social_connect(uuid, jsonb), public.social_connect_choices(uuid), public.connect_social_account(uuid, text),
  public.disconnect_social_account(uuid, public.social_platform), public.schedule_social_post(uuid, public.social_platform, uuid[], text, timestamptz),
  public.cancel_social_post(uuid), public.retry_social_post(uuid) to authenticated;
