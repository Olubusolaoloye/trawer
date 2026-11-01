import { Hono } from 'hono';
import { z } from 'zod';
import { onboardingInput, paymentMethod, phoneSchema, productInput, staffRole, uuid } from '@trawer/core/schemas';
import { many, one, withUser } from '../db';
import { ApiError, body, query, requireUser, type AppEnv, type Ctx } from '../http';
import { createProduct } from '../products';
import { imageUrl, putImage } from '../storage';

export const dashboardRoutes = new Hono<AppEnv>();

function bid(c: Ctx): string {
  const r = uuid.safeParse(c.req.param('bid'));
  if (!r.success) throw new ApiError(404, 'not_found');
  return r.data;
}

/** Run as the staff user, after checking they belong to the business (RLS still applies). */
async function asStaff<T>(c: Ctx, fn: (tx: Parameters<Parameters<typeof withUser>[1]>[0], businessId: string) => Promise<T>): Promise<T> {
  const claims = requireUser(c);
  const businessId = bid(c);
  return withUser(claims, async (tx) => {
    const ok = await one(tx, `select app.staff_role($1) as role`, [businessId]);
    if (!ok?.role) throw new ApiError(403, 'not_staff');
    return fn(tx, businessId);
  });
}

// ------------------------------------------------------------------------------------------
// Onboarding + settings
// ------------------------------------------------------------------------------------------
dashboardRoutes.post('/', async (c) => {
  const claims = requireUser(c);
  const input = await body(c, onboardingInput);
  const id = await withUser(claims, async (tx) =>
    (await one<{ id: string }>(tx, `select public.create_business($1, $2, $3, $4, $5) as id`,
      [input.name, input.slug, input.kind, input.brand_colour, input.display_name]))!.id);
  return c.json({ business_id: id }, 201);
});

dashboardRoutes.get('/slug-available/:slug', async (c) => {
  const slug = c.req.param('slug').toLowerCase();
  const taken = await withUser(c.get('claims'), (tx) => one(tx, `select 1 from businesses where slug = $1`, [slug]));
  return c.json({ available: !taken && /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug) });
});

dashboardRoutes.get('/:bid', (c) => asStaff(c, async (tx, b) => {
  const [business, role, locations, stats] = await Promise.all([
    one(tx, `select * from businesses where id = $1`, [b]),
    one(tx, `select app.staff_role($1) as role`, [b]),
    many(tx, `select id, name, address, is_default from locations where business_id = $1 order by is_default desc, name`, [b]),
    one(tx, `select
      (select count(*)::int from products where business_id = $1 and status = 'active') as products,
      (select count(*)::int from orders where business_id = $1 and created_at > now() - interval '1 day') as orders_today,
      (select coalesce(sum(total_kobo),0)::bigint from orders where business_id = $1 and status in ('confirmed','completed') and created_at > date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') as sales_today_kobo,
      (select count(*)::int from customers where business_id = $1 and wholesale_status = 'pending') as pending_wholesale,
      (select count(*)::int from low_stock_variants where business_id = $1) as low_stock,
      (select count(*)::int from stock_alerts where business_id = $1 and resolved_at is null and kind = 'oversell_conflict') as conflicts`, [b]),
  ]);
  const perms = await many(tx, `select p.permission from (select distinct permission from roles_permissions) p
                                where app.has_permission($1, p.permission)`, [b]);
  return c.json({ business: { ...business, logo_url: imageUrl(business.logo_path, 200) }, role: role?.role, permissions: perms.map((p) => p.permission), locations, stats });
}));

dashboardRoutes.patch('/:bid', async (c) => {
  const input = await body(c, z.object({
    name: z.string().trim().min(2).max(120).optional(),
    brand_colour: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    phone: phoneSchema.optional(),
    address: z.string().trim().max(300).optional(),
    reservation_minutes: z.number().int().min(5).max(2880).optional(),
    low_stock_default: z.number().int().min(0).max(100000).optional(),
    caption_template: z.string().max(1000).optional(),
    data_retention_months: z.number().int().min(12).max(120).optional(),
    logo_path: z.string().max(300).optional(),
    onboarding_completed: z.boolean().optional(),
  }));
  return asStaff(c, async (tx, b) => {
    const { onboarding_completed, ...fields } = input;
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (keys.length) {
      const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      const r = await tx.query(`update businesses set ${sets} where id = $1`, [b, ...keys.map((k) => fields[k])]);
      if (r.rowCount === 0) throw new ApiError(403, 'permission_denied');
    }
    if (onboarding_completed) await tx.query(`update businesses set onboarding_completed_at = coalesce(onboarding_completed_at, now()) where id = $1`, [b]);
    return c.json({ ok: true });
  });
});

dashboardRoutes.post('/:bid/locations', async (c) => {
  const input = await body(c, z.object({ name: z.string().trim().min(2).max(80), address: z.string().trim().max(300).optional() }));
  return asStaff(c, async (tx, b) => {
    const r = await one(tx, `insert into locations (business_id, name, address) values ($1, $2, $3) returning id`, [b, input.name, input.address ?? null]);
    return c.json(r, 201);
  });
});

dashboardRoutes.put('/:bid/payout', async (c) => {
  const input = await body(c, z.object({
    bank_code: z.string().regex(/^\d{3,6}$/), bank_name: z.string().max(80),
    account_number: z.string().regex(/^\d{10}$/), account_name: z.string().max(120),
  }));
  return asStaff(c, async (tx, b) => {
    await tx.query(`select public.set_payout_account($1, $2, $3, $4, $5)`, [b, input.bank_code, input.bank_name, input.account_number, input.account_name]);
    return c.json({ ok: true });
  });
});

dashboardRoutes.get('/:bid/payout', (c) => asStaff(c, async (tx, b) => {
  const r = await one(tx, `select bank_name, account_name, right(account_number, 4) last4, updated_at from business_payout_accounts where business_id = $1`, [b]);
  return c.json({ payout: r });
}));

// ------------------------------------------------------------------------------------------
// Staff
// ------------------------------------------------------------------------------------------
dashboardRoutes.get('/:bid/staff', (c) => asStaff(c, async (tx, b) =>
  c.json({ staff: await many(tx, `select id, phone, display_name, role, status, joined_at from staff_members where business_id = $1 order by role, display_name`, [b]) })));

dashboardRoutes.post('/:bid/staff', async (c) => {
  const input = await body(c, z.object({ phone: phoneSchema, role: staffRole.exclude(['owner']), display_name: z.string().trim().max(80).default('') }));
  return asStaff(c, async (tx, b) => {
    const r = await one(tx, `select public.invite_staff($1, $2, $3, $4) as id`, [b, input.phone, input.role, input.display_name]);
    return c.json(r, 201);
  });
});

dashboardRoutes.patch('/:bid/staff/:sid', async (c) => {
  const input = await body(c, z.object({ role: staffRole.exclude(['owner']), status: z.enum(['active', 'disabled']).optional() }));
  return asStaff(c, async (tx) => {
    await tx.query(`select public.set_staff_role($1, $2, $3)`, [c.req.param('sid'), input.role, input.status ?? null]);
    return c.json({ ok: true });
  });
});

// ------------------------------------------------------------------------------------------
// Uploads (images → WebP)
// ------------------------------------------------------------------------------------------
dashboardRoutes.post('/:bid/uploads', (c) => asStaff(c, async (_tx, b) => {
  const form = await c.req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) throw new ApiError(422, 'file_required');
  if (file.size > 12 * 1024 * 1024) throw new ApiError(422, 'file_too_large');
  if (!/^image\/(jpeg|png|webp|heic|heif|avif)$/.test(file.type)) throw new ApiError(422, 'unsupported_image');
  const out = await putImage('products', b, Buffer.from(await file.arrayBuffer()));
  return c.json({ path: out.path, url: imageUrl(out.path, 640) }, 201);
}));

// ------------------------------------------------------------------------------------------
// Products + inventory
// ------------------------------------------------------------------------------------------
dashboardRoutes.get('/:bid/products', (c) => asStaff(c, async (tx, b) => {
  const { q, status, page } = query(c, z.object({
    q: z.string().trim().max(80).optional(),
    status: z.enum(['draft', 'active', 'archived']).optional(),
    page: z.coerce.number().int().min(0).max(5000).default(0),
  }));
  const rows = await many(tx, `
    select p.id, p.name, p.category, p.status, p.source, p.created_at,
      (select path from variant_images vi where vi.product_id = p.id order by vi.position limit 1) image,
      (select count(*)::int from product_variants v where v.product_id = p.id) variants,
      (select coalesce(sum(sl.on_hand),0)::int from stock_levels sl join product_variants v on v.id = sl.variant_id where v.product_id = p.id) on_hand,
      (select coalesce(sum(sl.available),0)::int from stock_levels sl join product_variants v on v.id = sl.variant_id where v.product_id = p.id) available,
      (select min(retail_price_kobo) from product_variants v where v.product_id = p.id) price_kobo
    from products p where p.business_id = $1
      and ($2::text is null or p.search @@ websearch_to_tsquery('simple', $2) or p.name ilike '%' || $2 || '%'
           or exists (select 1 from product_variants v where v.product_id = p.id and (v.sku = $2 or v.barcode = $2)))
      and ($3::product_status is null or p.status = $3)
    order by p.created_at desc, p.id desc limit 50 offset $4`, [b, q || null, status ?? null, page * 50]);
  return c.json({ products: rows.map((r) => ({ ...r, image: imageUrl(r.image, 200) })) });
}));

dashboardRoutes.post('/:bid/products', async (c) => {
  const input = await body(c, productInput);
  return asStaff(c, async (tx, b) => c.json({ id: await createProduct(tx, b, input) }, 201));
});

dashboardRoutes.get('/:bid/products/:pid', (c) => asStaff(c, async (tx, b) => {
  const pid = c.req.param('pid');
  const p = await one(tx, `select * from products where id = $1 and business_id = $2`, [pid, b]);
  if (!p) throw new ApiError(404, 'not_found');
  const [variants, units, images, tierPrices, breaks, tiers] = await Promise.all([
    many(tx, `select v.*, vc.cost_kobo,
                (select coalesce(sum(on_hand),0)::int from stock_levels where variant_id = v.id) on_hand,
                (select coalesce(sum(reserved),0)::int from stock_levels where variant_id = v.id) reserved,
                (select coalesce(sum(allocated),0)::int from stock_levels where variant_id = v.id) allocated,
                (select coalesce(sum(available),0)::int from stock_levels where variant_id = v.id) available
              from product_variants v left join variant_costs vc on vc.variant_id = v.id
              where v.product_id = $1 order by v.position`, [pid]),
    many(tx, `select pu.id, pu.unit_id, u.name, u.plural, pu.factor, pu.is_base from product_units pu join units u on u.id = pu.unit_id where pu.product_id = $1 order by factor`, [pid]),
    many(tx, `select id, variant_id, path from variant_images where product_id = $1 order by position`, [pid]),
    many(tx, `select tier_id, variant_id, price_kobo from tier_prices where variant_id in (select id from product_variants where product_id = $1)`, [pid]),
    many(tx, `select id, tier_id, variant_id, min_qty, price_kobo from volume_breaks where variant_id in (select id from product_variants where product_id = $1) order by min_qty`, [pid]),
    many(tx, `select id, name, is_wholesale from customer_tiers where business_id = $1 order by position`, [b]),
  ]);
  return c.json({ product: p, variants, units, images: images.map((i) => ({ ...i, url: imageUrl(i.path, 400) })), tier_prices: tierPrices, volume_breaks: breaks, tiers });
}));

dashboardRoutes.patch('/:bid/products/:pid', async (c) => {
  const input = await body(c, z.object({
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
    category: z.string().trim().max(80).nullable().optional(),
    status: z.enum(['draft', 'active', 'archived']).optional(),
    social_autopost: z.boolean().optional(),
  }));
  return asStaff(c, async (tx, b) => {
    const keys = Object.keys(input) as (keyof typeof input)[];
    if (!keys.length) return c.json({ ok: true });
    const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
    const r = await tx.query(`update products set ${sets} where id = $1 and business_id = $2`, [c.req.param('pid'), b, ...keys.map((k) => input[k])]);
    if (r.rowCount === 0) throw new ApiError(403, 'permission_denied');
    return c.json({ ok: true });
  });
});

dashboardRoutes.patch('/:bid/variants/:vid', async (c) => {
  const input = await body(c, z.object({
    retail_price_kobo: z.number().int().min(0).optional(),
    cost_kobo: z.number().int().min(0).optional(),
    low_stock_threshold: z.number().int().min(0).nullable().optional(),
    is_active: z.boolean().optional(),
    colour: z.string().max(60).nullable().optional(),
    colour_hex: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
    size: z.string().max(40).nullable().optional(),
  }));
  return asStaff(c, async (tx, b) => {
    const vid = c.req.param('vid');
    const { cost_kobo, ...fields } = input;
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (keys.length) {
      const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');
      const r = await tx.query(`update product_variants set ${sets} where id = $1 and business_id = $2`, [vid, b, ...keys.map((k) => fields[k])]);
      if (r.rowCount === 0) throw new ApiError(403, 'permission_denied');
    }
    if (cost_kobo != null) {
      const r = await tx.query(`insert into variant_costs (business_id, variant_id, cost_kobo) values ($1, $2, $3)
                                on conflict (variant_id) do update set cost_kobo = excluded.cost_kobo, updated_at = now()`, [b, vid, cost_kobo]);
      if (r.rowCount === 0) throw new ApiError(403, 'permission_denied');
    }
    return c.json({ ok: true });
  });
});

dashboardRoutes.put('/:bid/variants/:vid/tier-prices', async (c) => {
  const input = await body(c, z.object({
    tier_prices: z.array(z.object({ tier_id: uuid, price_kobo: z.number().int().min(0).nullable() })).max(50),
    volume_breaks: z.array(z.object({ tier_id: uuid.nullable(), min_qty: z.number().int().min(2), price_kobo: z.number().int().min(0) })).max(50).optional(),
  }));
  return asStaff(c, async (tx, b) => {
    const vid = c.req.param('vid');
    for (const tp of input.tier_prices) {
      if (tp.price_kobo == null) await tx.query(`delete from tier_prices where variant_id = $1 and tier_id = $2`, [vid, tp.tier_id]);
      else await tx.query(`insert into tier_prices (business_id, tier_id, variant_id, price_kobo) values ($1, $2, $3, $4)
                           on conflict (tier_id, variant_id) do update set price_kobo = excluded.price_kobo, updated_at = now()`, [b, tp.tier_id, vid, tp.price_kobo]);
    }
    if (input.volume_breaks) {
      await tx.query(`delete from volume_breaks where variant_id = $1`, [vid]);
      for (const vb of input.volume_breaks) {
        await tx.query(`insert into volume_breaks (business_id, variant_id, tier_id, min_qty, price_kobo) values ($1, $2, $3, $4, $5)`, [b, vid, vb.tier_id, vb.min_qty, vb.price_kobo]);
      }
    }
    return c.json({ ok: true });
  });
});

dashboardRoutes.post('/:bid/stock', async (c) => {
  const input = await body(c, z.object({
    variant_id: uuid,
    action: z.enum(['receive', 'adjust', 'count']),
    qty: z.number().int(),
    reason: z.string().trim().max(200).optional(),
    location_id: uuid.optional(),
  }));
  return asStaff(c, async (tx) => {
    if (input.action === 'receive') await tx.query(`select public.receive_stock($1, $2, $3, $4)`, [input.variant_id, input.qty, input.location_id ?? null, input.reason ?? 'received']);
    else if (input.action === 'adjust') await tx.query(`select public.adjust_stock($1, $2, $3, $4)`, [input.variant_id, input.qty, input.reason ?? '', input.location_id ?? null]);
    else await tx.query(`select public.count_stock($1, $2, $3, $4)`, [input.variant_id, input.qty, input.location_id ?? null, input.reason ?? 'stock count']);
    return c.json({ ok: true });
  });
});

dashboardRoutes.get('/:bid/variants/:vid/history', (c) => asStaff(c, async (tx) => {
  const rows = await many(tx, `select m.id, m.type, m.qty_delta, m.channel, m.reason, m.created_at, m.order_id, o.order_number, l.name location,
                                      coalesce(s.display_name, s.phone) actor
                               from stock_movements m join locations l on l.id = m.location_id
                               left join orders o on o.id = m.order_id
                               left join staff_members s on s.user_id = m.actor_id and s.business_id = m.business_id
                               where m.variant_id = $1 order by m.created_at desc, m.id desc limit 200`, [c.req.param('vid')]);
  return c.json({ history: rows });
}));

dashboardRoutes.get('/:bid/low-stock', (c) => asStaff(c, async (tx, b) =>
  c.json({ items: await many(tx, `select * from low_stock_variants where business_id = $1 order by available, product_name limit 200`, [b]) })));

// ------------------------------------------------------------------------------------------
// Orders
// ------------------------------------------------------------------------------------------
dashboardRoutes.get('/:bid/orders', (c) => asStaff(c, async (tx, b) => {
  const f = query(c, z.object({
    channel: z.enum(['web', 'whatsapp', 'instagram', 'facebook', 'pos']).optional(),
    status: z.enum(['pending', 'confirmed', 'completed', 'cancelled', 'expired']).optional(),
    payment: z.enum(['unpaid', 'partial', 'paid', 'refunded']).optional(),
    fulfilment: z.string().max(20).optional(),
    q: z.string().trim().max(60).optional(),
    page: z.coerce.number().int().min(0).default(0),
  }));
  const rows = await many(tx, `
    select o.id, o.order_number, o.channel, o.status, o.payment_status, o.fulfilment_status, o.total_kobo, o.balance_kobo,
           o.created_at, o.needs_attention, coalesce(c.name, o.buyer_name, 'Walk-in') customer, c.phone customer_phone,
           (select count(*)::int from order_items i where i.order_id = o.id) lines
    from orders o left join customers c on c.id = o.customer_id
    where o.business_id = $1
      and ($2::sales_channel is null or o.channel = $2) and ($3::order_status is null or o.status = $3)
      and ($4::payment_status is null or o.payment_status = $4)
      and ($5::text is null or o.fulfilment_status::text = $5)
      and ($6::text is null or o.order_number::text = $6 or c.name ilike '%' || $6 || '%' or c.phone like '%' || $6)
    order by o.created_at desc limit 50 offset $7`,
    [b, f.channel ?? null, f.status ?? null, f.payment ?? null, f.fulfilment ?? null, f.q || null, f.page * 50]);
  return c.json({ orders: rows });
}));

dashboardRoutes.get('/:bid/orders/:oid', (c) => asStaff(c, async (tx) => {
  const oid = c.req.param('oid');
  const order = (await one(tx, `select public.get_order($1) as r`, [oid]))?.r;
  if (!order) throw new ApiError(404, 'not_found');
  const [customer, payments] = await Promise.all([
    order.customer_id ? one(tx, `select id, name, phone, buyer_type, wholesale_status from customers where id = $1`, [order.customer_id]) : null,
    many(tx, `select id, method, amount_kobo, received_at, note from payments where order_id = $1 order by received_at`, [oid]),
  ]);
  return c.json({ order, customer, payments });
}));

dashboardRoutes.post('/:bid/orders/:oid/payments', async (c) => {
  const input = await body(c, z.object({ amount_kobo: z.number().int().positive(), method: paymentMethod, note: z.string().max(200).optional(), client_id: uuid.optional() }));
  return asStaff(c, async (tx) => {
    const r = await one(tx, `select public.record_payment($1, $2, $3, $4, $5) as id`, [c.req.param('oid'), input.amount_kobo, input.method, input.note ?? null, input.client_id ?? null]);
    return c.json(r, 201);
  });
});

dashboardRoutes.post('/:bid/orders/:oid/cancel', async (c) => {
  const { reason } = await body(c, z.object({ reason: z.string().trim().max(300).optional() }));
  return asStaff(c, async (tx) => {
    await tx.query(`select public.cancel_order($1, $2)`, [c.req.param('oid'), reason ?? 'cancelled by staff']);
    return c.json({ ok: true });
  });
});

// ------------------------------------------------------------------------------------------
// Customers, tiers, wholesale approvals
// ------------------------------------------------------------------------------------------
dashboardRoutes.get('/:bid/customers', (c) => asStaff(c, async (tx, b) => {
  const { q, pending } = query(c, z.object({ q: z.string().trim().max(60).optional(), pending: z.coerce.boolean().optional() }));
  const rows = await many(tx, `
    select c.id, c.name, c.phone, c.business_name, c.buyer_type, c.wholesale_status, c.cac_number, c.shop_photo_path, t.name tier, c.created_at,
      (select coalesce(sum(balance_kobo),0)::bigint from orders o where o.customer_id = c.id and o.status in ('confirmed','completed')) owing_kobo
    from customers c left join customer_tiers t on t.id = c.tier_id
    where c.business_id = $1 and ($2::text is null or c.name ilike '%' || $2 || '%' or c.phone like '%' || $2 || '%')
      and (not coalesce($3, false) or c.wholesale_status = 'pending')
    order by c.created_at desc limit 100`, [b, q || null, pending ?? null]);
  return c.json({ customers: rows });
}));

dashboardRoutes.post('/:bid/customers', async (c) => {
  const input = await body(c, z.object({ phone: phoneSchema, name: z.string().trim().min(1).max(120), buyer_type: z.enum(['wholesaler', 'retailer', 'retail_buyer']).default('retail_buyer') }));
  return asStaff(c, async (tx, b) => {
    const r = await one(tx, `insert into customers (business_id, phone, name, buyer_type) values ($1, $2, $3, $4)
                             on conflict (business_id, phone) do update set name = excluded.name returning id`, [b, input.phone, input.name, input.buyer_type]);
    return c.json(r, 201);
  });
});

dashboardRoutes.post('/:bid/customers/:cid/wholesale', async (c) => {
  const input = await body(c, z.object({ approve: z.boolean(), tier_id: uuid.optional(), reason: z.string().max(300).optional() }));
  return asStaff(c, async (tx) => {
    await tx.query(`select public.review_wholesale_application($1, $2, $3, $4)`, [c.req.param('cid'), input.approve, input.tier_id ?? null, input.reason ?? null]);
    return c.json({ ok: true });
  });
});

dashboardRoutes.get('/:bid/tiers', (c) => asStaff(c, async (tx, b) =>
  c.json({ tiers: await many(tx, `select t.*, (select count(*)::int from customers c where c.tier_id = t.id) customers from customer_tiers t where business_id = $1 order by position, name`, [b]) })));

dashboardRoutes.post('/:bid/tiers', async (c) => {
  const input = await body(c, z.object({ name: z.string().trim().min(2).max(60), is_wholesale: z.boolean().default(false) }));
  return asStaff(c, async (tx, b) => {
    const r = await one(tx, `insert into customer_tiers (business_id, name, is_wholesale, position)
                             values ($1, $2, $3, (select coalesce(max(position),0)+1 from customer_tiers where business_id = $1)) returning id`, [b, input.name, input.is_wholesale]);
    return c.json(r, 201);
  });
});

// ------------------------------------------------------------------------------------------
// Tills (devices), allocations, stock conflict alerts
// ------------------------------------------------------------------------------------------
dashboardRoutes.get('/:bid/devices', (c) => asStaff(c, async (tx, b) => {
  const devices = await many(tx, `
    select d.id, d.name, d.platform, d.status, d.last_sync_at, l.name location,
      coalesce((select json_agg(json_build_object('variant_id', da.variant_id, 'qty', da.qty, 'name', p.name,
                 'label', nullif(concat_ws(' / ', v.colour, v.size), ''), 'sku', v.sku) order by p.name)
               from device_allocations da join product_variants v on v.id = da.variant_id join products p on p.id = v.product_id
               where da.device_id = d.id and da.qty > 0), '[]') allocations
    from devices d join locations l on l.id = d.location_id where d.business_id = $1 order by d.name`, [b]);
  return c.json({ devices });
}));

dashboardRoutes.post('/:bid/devices/:did/allocate', async (c) => {
  const input = await body(c, z.object({ variant_id: uuid, qty: z.number().int().refine((n) => n !== 0) }));
  return asStaff(c, async (tx) => {
    await tx.query(`select public.allocate_to_device($1, $2, $3)`, [c.req.param('did'), input.variant_id, input.qty]);
    return c.json({ ok: true });
  });
});

dashboardRoutes.get('/:bid/stock-alerts', (c) => asStaff(c, async (tx, b) => {
  const alerts = await many(tx, `
    select a.id, a.kind, a.qty, a.message, a.created_at, a.order_id, o.order_number, d.name device,
           p.name product, nullif(concat_ws(' / ', v.colour, v.size), '') label, a.variant_id, v.product_id
    from stock_alerts a left join orders o on o.id = a.order_id left join devices d on d.id = a.device_id
    left join product_variants v on v.id = a.variant_id left join products p on p.id = v.product_id
    where a.business_id = $1 and a.resolved_at is null order by a.created_at desc limit 100`, [b]);
  return c.json({ alerts });
}));

dashboardRoutes.post('/:bid/stock-alerts/:aid/resolve', (c) => asStaff(c, async (tx, b) => {
  const r = await tx.query(`update stock_alerts set resolved_at = now(), resolved_by = auth.uid() where id = $1 and business_id = $2 and resolved_at is null`, [c.req.param('aid'), b]);
  if (r.rowCount === 0) throw new ApiError(403, 'permission_denied');
  return c.json({ ok: true });
}));
