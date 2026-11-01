-- Demo data: Balogun Fabrics (Lagos Island fabric wholesaler).
-- 200 products · 3 price tiers · 5 customers · sample orders across channels. Deterministic.
-- Staff sign in with these phones (dev OTP 000000):
--   owner +2348030000001 · manager +2348030000002 · cashier +2348030000003
--   store keeper +2348030000004 · rider +2348030000005
-- Buyers: +2348090000001..5

do $seed$
declare
  v_owner uuid; v_manager uuid; v_cashier uuid; v_keeper uuid; v_rider uuid;
  v_biz uuid; v_loc uuid; v_wh_tier uuid; v_rt_tier uuid; v_vip_tier uuid;
  v_piece uuid; v_bundle uuid; v_carton uuid; v_yard uuid;
  v_cust uuid[] := '{}';
  v_buyer uuid;
  v_product uuid; v_variant uuid;
  v_categories text[] := array['Ankara','Lace','Aso-oke','Adire','George','Voile','Chiffon','Guinea brocade'];
  v_prefix text[] := array['Hollandais','Super wax','Royal','Classic','Premium','Lagos','Abeokuta','Kano','Ibadan','Golden','Silver','Supreme','Grand','Elegant','Heritage','Festival','Owambe','Asoebi','Market queen','Iya oja'];
  v_colours text[] := array['Red','Royal blue','Emerald','Gold','Wine','Black','Peach','Purple','Orange','Sky blue','Cream','Olive'];
  v_hex text[] := array['#B91C1C','#1D4ED8','#047857','#CA8A04','#7F1D1D','#111827','#FDBA74','#6D28D9','#EA580C','#38BDF8','#FEF3C7','#4D7C0F'];
  v_cat text; v_base_price bigint; v_ncol int; c int; i int; v_name text; v_variants uuid[] := '{}';
  o jsonb; v_order uuid;
begin
  perform setseed(0.42);

  -- auth users (on Supabase these come from phone sign-ups; inserted directly for the demo)
  insert into auth.users (phone) values ('+2348030000001') on conflict (phone) do update set phone = excluded.phone returning id into v_owner;
  insert into auth.users (phone) values ('+2348030000002') on conflict (phone) do update set phone = excluded.phone returning id into v_manager;
  insert into auth.users (phone) values ('+2348030000003') on conflict (phone) do update set phone = excluded.phone returning id into v_cashier;
  insert into auth.users (phone) values ('+2348030000004') on conflict (phone) do update set phone = excluded.phone returning id into v_keeper;
  insert into auth.users (phone) values ('+2348030000005') on conflict (phone) do update set phone = excluded.phone returning id into v_rider;

  -- business, created exactly like the onboarding RPC does (as the owner)
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated', 'phone', '+2348030000001', 'aal', 'aal2')::text, true);
  v_biz := public.create_business('Balogun Fabrics', 'balogun', 'wholesaler', '#7C2D12', 'Alhaja Balogun');
  perform set_config('request.jwt.claims', '', true);

  update public.businesses set address = '24 Balogun Street, Lagos Island', phone = '+2348030000001',
    onboarding_completed_at = now(), reservation_minutes = 45 where id = v_biz;
  select id into v_loc from public.locations where business_id = v_biz and is_default;
  update public.locations set name = 'Balogun Market shop', address = 'Shop C12, Balogun Market' where id = v_loc;
  insert into public.locations (business_id, name, address) values (v_biz, 'Idumota warehouse', '3 Idumota Road');
  insert into public.business_payout_accounts (business_id, bank_code, bank_name, account_number, account_name)
    values (v_biz, '058', 'GTBank', '0123456789', 'BALOGUN FABRICS LTD');

  insert into public.staff_members (business_id, user_id, phone, display_name, role, status, joined_at) values
    (v_biz, v_manager, '+2348030000002', 'Tunde (manager)', 'manager', 'active', now()),
    (v_biz, v_cashier, '+2348030000003', 'Kemi (cashier)', 'cashier', 'active', now()),
    (v_biz, v_keeper, '+2348030000004', 'Musa (store)', 'store_keeper', 'active', now()),
    (v_biz, v_rider, '+2348030000005', 'Emeka (rider)', 'rider', 'active', now());

  select id into v_wh_tier from public.customer_tiers where business_id = v_biz and default_for = 'wholesaler';
  select id into v_rt_tier from public.customer_tiers where business_id = v_biz and default_for = 'retailer';
  insert into public.customer_tiers (business_id, name, is_wholesale, position) values (v_biz, 'VIP wholesale', true, 3) returning id into v_vip_tier;

  select id into v_piece from public.units where business_id is null and name = 'piece';
  select id into v_bundle from public.units where business_id is null and name = 'bundle';
  select id into v_carton from public.units where business_id is null and name = 'carton';
  select id into v_yard from public.units where business_id is null and name = 'yard';

  -- 200 products
  for i in 1..200 loop
    v_cat := v_categories[1 + (i % array_length(v_categories, 1))];
    v_name := v_prefix[1 + ((i * 7) % array_length(v_prefix, 1))] || ' ' || v_cat || ' #' || lpad(i::text, 3, '0');
    v_base_price := case v_cat
      when 'Lace' then 4500000 when 'Aso-oke' then 3500000 when 'George' then 6000000 when 'Guinea brocade' then 2500000
      when 'Voile' then 2800000 when 'Chiffon' then 1200000 when 'Adire' then 900000 else 1500000 end
      + (floor(random() * 20) * 50000)::bigint;
    insert into public.products (business_id, name, description, category, base_unit_id, status, source, created_at)
    values (v_biz, v_name,
      'Quality ' || lower(v_cat) || ' sold per 6-yard piece. Colourfast, fresh stock from the warehouse.',
      v_cat, v_piece, 'draft', 'import', now() - make_interval(hours => i))
    returning id into v_product;
    insert into public.product_units (business_id, product_id, unit_id, factor) values (v_biz, v_product, v_bundle, 6), (v_biz, v_product, v_carton, 24);
    v_ncol := 1 + (i % 4);
    for c in 1..v_ncol loop
      insert into public.product_variants (business_id, product_id, colour, colour_hex, retail_price_kobo, position, low_stock_threshold)
      values (v_biz, v_product, v_colours[1 + ((i + c * 3) % 12)], v_hex[1 + ((i + c * 3) % 12)], v_base_price, c, 6)
      returning id into v_variant;
      insert into public.variant_costs (business_id, variant_id, cost_kobo) values (v_biz, v_variant, (v_base_price * 0.72)::bigint);
      insert into public.tier_prices (business_id, tier_id, variant_id, price_kobo) values
        (v_biz, v_wh_tier, v_variant, (v_base_price * 0.82)::bigint),
        (v_biz, v_rt_tier, v_variant, (v_base_price * 0.92)::bigint),
        (v_biz, v_vip_tier, v_variant, (v_base_price * 0.78)::bigint);
      if i % 5 = 0 then
        insert into public.volume_breaks (business_id, variant_id, tier_id, min_qty, price_kobo) values
          (v_biz, v_variant, null, 6, (v_base_price * 0.95)::bigint),
          (v_biz, v_variant, v_wh_tier, 48, (v_base_price * 0.79)::bigint);
      end if;
      -- opening stock; every 17th product has a sold-out colour, every 11th is low
      if not (i % 17 = 0 and c = v_ncol) then
        perform public.receive_stock(v_variant, case when i % 11 = 0 then 4 else 24 + floor(random() * 200)::int end, v_loc, 'opening stock');
      end if;
      if i <= 40 and i % 11 <> 0 and i % 17 <> 0 then v_variants := v_variants || v_variant; end if;
    end loop;
    update public.products set status = 'active' where id = v_product;
  end loop;

  -- 5 customers
  for i in 1..5 loop
    insert into auth.users (phone) values ('+234809000000' || i) on conflict (phone) do update set phone = excluded.phone returning id into v_buyer;
    perform set_config('request.jwt.claims', json_build_object('sub', v_buyer, 'role', 'authenticated', 'phone', '+234809000000' || i)::text, true);
    v_cust := v_cust || public.register_buyer('balogun',
      (array['wholesaler','wholesaler','wholesaler','retailer','retail_buyer'])[i]::public.buyer_type,
      (array['Chidi Okafor','Aisha Bello','Ngozi Eze','Yetunde Adeyemi','Femi Johnson'])[i],
      (array['Chidi Textiles, Onitsha','Bello Fabrics, Kano','Ngozi Couture, Aba','Yetty Boutique, Ikeja',null])[i],
      (array['RC1234567','RC7654321','BN2345678',null,null])[i], null, 'v1', i <= 2);
    perform set_config('request.jwt.claims', '', true);
  end loop;
  perform public.review_wholesale_application(v_cust[1], true, null, null);       -- Chidi: wholesale
  perform public.review_wholesale_application(v_cust[2], true, v_vip_tier, null); -- Aisha: VIP
  -- v_cust[3] Ngozi stays pending in the approval queue
  update public.customers set credit_limit_kobo = 50000000 where id = v_cust[1];

  -- sample orders (placed through the same function every channel uses)
  for i in 1..16 loop
    o := public.place_order(jsonb_build_object(
      'business_id', v_biz,
      'channel', (array['web','whatsapp','pos','instagram'])[1 + i % 4],
      'customer_id', v_cust[1 + (i + 1) % 5],
      'items', jsonb_build_array(
        jsonb_build_object('variant_id', v_variants[1 + (i * 3) % array_length(v_variants, 1)], 'qty', 1 + i % 3,
                           'unit_id', case when i % 2 = 0 then v_bundle else v_piece end),
        jsonb_build_object('variant_id', v_variants[1 + (i * 5 + 1) % array_length(v_variants, 1)], 'qty', 2)),
      'delivery_method', case when i % 4 = 2 then 'in_store' when i % 3 = 0 then 'delivery' else 'pickup' end,
      'delivery_address', case when i % 3 = 0 then jsonb_build_object('line1', '5 Ojuelegba Road', 'city', 'Surulere', 'state', 'Lagos') end));
    v_order := (o ->> 'id')::uuid;
    update public.orders set created_at = now() - make_interval(days => 16 - i) where id = v_order;
    if i % 5 <> 0 then
      perform app.apply_payment(v_biz, v_order, null, (o ->> 'total_kobo')::bigint,
        (array['virtual_account','cash','transfer','card_terminal'])[1 + i % 4]::public.payment_method,
        case when i % 4 = 0 then 'paystack' end, case when i % 4 = 0 then 'seed-' || i end);
    elsif i = 10 then
      perform app.apply_payment(v_biz, v_order, null, (o ->> 'total_kobo')::bigint / 2, 'transfer');
    end if;
  end loop;

end $seed$;
