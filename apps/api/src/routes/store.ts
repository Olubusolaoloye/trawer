import { Hono } from 'hono';
import { z } from 'zod';
import { checkoutInput, orderItemInput, registerBuyerInput } from '@trawer/core/schemas';
import { many, one, withUser, type Tx } from '../db';
import { ApiError, body, query, requireUser, type AppEnv, type Ctx } from '../http';
import { imageUrl } from '../storage';
import { ensureVirtualAccount } from '../payments';
import { designView } from '../storefront';
import { limitUserAndIp } from '../limits';
import { normalizeStorefront } from '@trawer/core/storefront';

const fewLeft = (n: number) => (n > 0 && n <= 10 ? n : null);

export const storeRoutes = new Hono<AppEnv>();

interface StoreBusiness {
  id: string;
  slug: string;
  name: string;
  kind: string;
  brand_colour: string;
  logo_path: string | null;
  phone: string | null;
  address: string | null;
  reservation_minutes: number;
  storefront: unknown;
}

async function business(tx: Tx, slug: string): Promise<StoreBusiness> {
  const b = await one<StoreBusiness>(tx,
    `select id, slug::text, name, kind, brand_colour, logo_path, phone, address, reservation_minutes, storefront
     from businesses where slug = $1 and status = 'active'`, [slug.toLowerCase()]);
  if (!b) throw new ApiError(404, 'store_not_found');
  return b;
}

async function viewer(tx: Tx, businessId: string) {
  return one<{ id: string; name: string; business_name: string | null; buyer_type: string; wholesale_status: string; tier_name: string | null;
    is_wholesale_view: boolean; owing_kobo: number; oldest_owing_order: number | null; account_number: string | null; bank_name: string | null }>(tx,
    `select c.id, c.name, c.business_name, c.buyer_type, c.wholesale_status, t.name tier_name,
            coalesce(t.is_wholesale and c.wholesale_status = 'approved', false) as is_wholesale_view,
            (select coalesce(sum(o.balance_kobo), 0) from orders o where o.customer_id = c.id and o.status in ('confirmed','completed')) as owing_kobo,
            (select o.order_number from orders o where o.customer_id = c.id and o.status in ('confirmed','completed') and o.balance_kobo > 0
             order by o.created_at limit 1) as oldest_owing_order,
            va.account_number, va.bank_name
     from customers c left join customer_tiers t on t.id = c.tier_id
     left join virtual_accounts va on va.customer_id = c.id and va.status = 'active'
     where c.business_id = $1 and c.user_id = auth.uid()`, [businessId]);
}

storeRoutes.get('/:slug', async (c) => {
  const data = await withUser(c.get('claims'), async (tx) => {
    const b = await business(tx, c.req.param('slug'));
    const [me, categories] = await Promise.all([
      c.get('claims') ? viewer(tx, b.id) : Promise.resolve(null),
      many(tx, `select category, count(*)::int n from products where business_id = $1 and status = 'active' and category is not null
                group by 1 order by 2 desc limit 30`, [b.id]),
    ]);
    const { storefront, ...biz } = b;
    return { business: { ...biz, logo_url: imageUrl(b.logo_path, 200) }, me, categories, design: designView(storefront) };
  });
  // Varies by signed-in buyer (wholesale view), so never reuse without revalidating.
  c.header('Cache-Control', 'private, no-cache');
  c.header('Vary', 'Cookie');
  return c.json(data);
});

const listQuery = z.object({
  q: z.string().trim().max(80).optional(),
  category: z.string().trim().max(80).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(48).default(24),
});

function decodeCursor(cursor?: string): { t: string; id: string } | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return z.object({ t: z.string().datetime({ offset: true }), id: z.string().uuid() }).parse(v);
  } catch {
    throw new ApiError(400, 'bad_cursor');
  }
}

storeRoutes.get('/:slug/products', async (c) => {
  const { q, category, cursor, limit } = query(c, listQuery);
  const cur = decodeCursor(cursor);
  const data = await withUser(c.get('claims'), async (tx) => {
    const b = await business(tx, c.req.param('slug'));
    const rows = await many(tx, `
      select p.id, p.name, p.category, p.created_at,
        (select vi.path from variant_images vi where vi.product_id = p.id order by vi.variant_id nulls first, vi.position limit 1) as image,
        (select json_agg(json_build_object('id', v.id, 'colour', v.colour, 'hex', v.colour_hex) order by v.position)
           from product_variants v where v.product_id = p.id and v.is_active) as variants
      from products p
      where p.business_id = $1 and p.status = 'active'
        and ($2::text is null or p.search @@ websearch_to_tsquery('simple', $2) or p.name ilike '%' || $2 || '%')
        and ($3::text is null or p.category = $3)
        and ($4::timestamptz is null or (p.created_at, p.id) < ($4::timestamptz, $5::uuid))
      order by p.created_at desc, p.id desc
      limit $6`, [b.id, q || null, category || null, cur?.t ?? null, cur?.id ?? null, limit + 1]);
    const page = rows.slice(0, limit);
    const variantIds = page.flatMap((r) => (r.variants ?? []).map((v: { id: string }) => v.id));
    const [prices, stock] = variantIds.length
      ? await Promise.all([
          many(tx, `select variant_id, unit_price_kobo, retail_price_kobo from public.quote_prices($1::uuid[], 1, 'web')`, [variantIds]),
          many(tx, `select variant_id, available from public.variant_availability($1::uuid[])`, [variantIds]),
        ])
      : [[], []];
    const showStock = normalizeStorefront(b.storefront).show_stock;
    const priceOf = new Map(prices.map((p) => [p.variant_id, p]));
    const stockOf = new Map(stock.map((s) => [s.variant_id, s.available]));
    const items = page.map((r) => {
      const vs = (r.variants ?? []) as { id: string; colour: string | null; hex: string | null }[];
      const quotes = vs.map((v) => priceOf.get(v.id)).filter(Boolean);
      const min = quotes.length ? Math.min(...quotes.map((x) => x.unit_price_kobo)) : null;
      const minRetail = quotes.length ? Math.min(...quotes.map((x) => x.retail_price_kobo)) : null;
      return {
        id: r.id,
        name: r.name,
        category: r.category,
        image: imageUrl(r.image, 400),
        price_kobo: min,
        retail_price_kobo: minRetail,
        in_stock: vs.some((v) => (stockOf.get(v.id) ?? 0) > 0),
        // Only when the shop opts in, and only when it's genuinely low (exact stock isn't public).
        few_left: showStock ? fewLeft(vs.reduce((n, v) => n + (stockOf.get(v.id) ?? 0), 0)) : null,
        swatches: vs.filter((v) => v.colour).slice(0, 6).map((v) => ({ colour: v.colour, hex: v.hex, in_stock: (stockOf.get(v.id) ?? 0) > 0 })),
      };
    });
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last
      ? Buffer.from(JSON.stringify({ t: new Date(last.created_at).toISOString(), id: last.id })).toString('base64url')
      : null;
    return { items, nextCursor };
  });
  return c.json(data);
});

storeRoutes.get('/:slug/products/:id', async (c) => {
  const id = z.string().uuid().safeParse(c.req.param('id'));
  if (!id.success) throw new ApiError(404, 'not_found');
  const data = await withUser(c.get('claims'), async (tx) => {
    const b = await business(tx, c.req.param('slug'));
    const p = await one(tx, `select id, name, description, category, brand, base_unit_id from products
                             where id = $1 and business_id = $2 and status = 'active'`, [id.data, b.id]);
    if (!p) throw new ApiError(404, 'not_found');
    const [variants, images, units, breaks] = await Promise.all([
      many(tx, `select id, sku, colour, colour_hex, size, position from product_variants
                where product_id = $1 and is_active order by position`, [p.id]),
      many(tx, `select variant_id, path, alt from variant_images where product_id = $1 order by position`, [p.id]),
      many(tx, `select pu.unit_id, u.name, u.plural, pu.factor, pu.is_base from product_units pu join units u on u.id = pu.unit_id
                where pu.product_id = $1 and pu.sellable order by pu.factor`, [p.id]),
      many(tx, `select variant_id, min_qty, price_kobo from volume_breaks
                where variant_id in (select id from product_variants where product_id = $1) order by min_qty`, [p.id]),
    ]);
    const ids = variants.map((v) => v.id);
    const [prices, stock] = await Promise.all([
      many(tx, `select variant_id, unit_price_kobo, source, retail_price_kobo from public.quote_prices($1::uuid[], 1, 'web')`, [ids]),
      many(tx, `select variant_id, available from public.variant_availability($1::uuid[])`, [ids]),
    ]);
    const priceOf = new Map(prices.map((x) => [x.variant_id, x]));
    const stockOf = new Map(stock.map((x) => [x.variant_id, x.available]));
    const productImages = images.filter((i) => !i.variant_id).map((i) => imageUrl(i.path, 960));
    return {
      product: { ...p, images: productImages },
      units,
      variants: variants.map((v) => {
        const own = images.filter((i) => i.variant_id === v.id).map((i) => imageUrl(i.path, 960));
        const pr = priceOf.get(v.id);
        return {
          ...v,
          images: own.length ? own : productImages,
          price_kobo: pr?.unit_price_kobo ?? null,
          retail_price_kobo: pr?.retail_price_kobo ?? null,
          price_source: pr?.source ?? 'retail',
          available: stockOf.get(v.id) ?? 0,
          volume_breaks: breaks.filter((x) => x.variant_id === v.id).map((x) => ({ min_qty: x.min_qty, price_kobo: x.price_kobo })),
        };
      }),
    };
  });
  return c.json(data);
});

/** Price a cart for the signed-in buyer (same resolver as checkout). */
storeRoutes.post('/:slug/quote', async (c) => {
  const { items } = await body(c, z.object({ items: z.array(orderItemInput).min(1).max(200) }));
  const data = await withUser(c.get('claims'), async (tx) => {
    const b = await business(tx, c.req.param('slug'));
    const lines = await many(tx, `
      with input as (
        select (i ->> 'variant_id')::uuid variant_id, (i ->> 'unit_id')::uuid unit_id, (i ->> 'qty')::int qty, ord
        from jsonb_array_elements($2::jsonb) with ordinality as t(i, ord)),
      resolved as (
        select i.*, v.product_id, p.name, nullif(concat_ws(' / ', v.colour, v.size), '') variant_label,
               coalesce(i.unit_id, p.base_unit_id) unit, pu.factor, u.name unit_name, u.plural unit_plural,
               (select path from variant_images vi where vi.product_id = p.id and (vi.variant_id = v.id or vi.variant_id is null)
                order by vi.variant_id nulls last, vi.position limit 1) image
        from input i
        join product_variants v on v.id = i.variant_id and v.business_id = $1 and v.is_active
        join products p on p.id = v.product_id and p.status = 'active'
        join product_units pu on pu.product_id = p.id and pu.unit_id = coalesce(i.unit_id, p.base_unit_id) and pu.sellable
        join units u on u.id = pu.unit_id),
      totals as (select variant_id, sum(qty * factor)::int base_total from resolved group by 1)
      select r.ord, r.variant_id, r.unit unit_id, r.qty, r.factor, r.name, r.variant_label, r.unit_name, r.unit_plural, r.image,
             (q).unit_price_kobo, (q).source, (q).retail_price_kobo, a.available
      from resolved r join totals t using (variant_id)
      cross join lateral (select public.resolve_price(r.variant_id, public.my_customer_id($1), t.base_total, 'web') q) x
      left join public.variant_availability(array[r.variant_id]) a on true
      order by r.ord`, [b.id, JSON.stringify(items)]);
    const out = lines.map((l) => ({
      variant_id: l.variant_id,
      unit_id: l.unit_id,
      qty: l.qty,
      base_qty: l.qty * l.factor,
      name: l.name,
      variant_label: l.variant_label,
      unit_name: l.qty === 1 ? l.unit_name : l.unit_plural,
      image: imageUrl(l.image, 200),
      unit_price_kobo: l.unit_price_kobo,
      retail_price_kobo: l.retail_price_kobo,
      price_source: l.source,
      line_total_kobo: l.unit_price_kobo * l.qty * l.factor,
      available: l.available,
    }));
    return { lines: out, subtotal_kobo: out.reduce((s, l) => s + l.line_total_kobo, 0), dropped: items.length - out.length };
  });
  return c.json(data);
});

storeRoutes.post('/:slug/register', async (c) => {
  const claims = requireUser(c);
  await limitUserAndIp(c, 'signup', claims.sub!, 10, 40);
  const input = await body(c, registerBuyerInput.extend({ shop_photo_path: z.string().max(300).optional() }));
  const id = await withUser(claims, async (tx) => {
    const r = await one<{ id: string }>(tx, `select public.register_buyer($1, $2, $3, $4, $5, $6, 'v1', $7) as id`, [
      c.req.param('slug'), input.buyer_type, input.name, input.business_name ?? null,
      input.cac_number || null, input.shop_photo_path ?? null, input.marketing_opt_in,
    ]);
    return r!.id;
  });
  return c.json({ customer_id: id });
});

storeRoutes.post('/:slug/checkout', async (c) => {
  const claims = requireUser(c);
  await limitUserAndIp(c, 'checkout', claims.sub!, 30, 120);
  const raw = await body(c, z.record(z.string(), z.unknown()));
  const data = await withUser(claims, async (tx) => {
    const b = await business(tx, c.req.param('slug'));
    const parsed = checkoutInput.safeParse({ ...raw, business_id: b.id, channel: raw.channel === 'instagram' ? 'instagram' : 'web' });
    if (!parsed.success) throw new ApiError(422, 'validation_failed', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
    const order = await one<{ result: any }>(tx, `select public.place_order($1::jsonb) as result`, [JSON.stringify(parsed.data)]);
    return order!.result;
  });
  // Virtual account creation calls the provider: do it outside the order transaction.
  const account = data.status === 'pending' && data.customer_id ? await ensureVirtualAccount(data.customer_id) : null;
  return c.json({ order: data, virtual_account: account }, 201);
});

storeRoutes.get('/:slug/orders', async (c) => {
  const claims = requireUser(c);
  const data = await withUser(claims, async (tx) => {
    const b = await business(tx, c.req.param('slug'));
    return many(tx, `select id, order_number, status, payment_status, fulfilment_status, total_kobo, balance_kobo, channel, created_at
                     from orders where business_id = $1 and customer_id = public.my_customer_id($1)
                     order by created_at desc limit 50`, [b.id]);
  });
  return c.json({ orders: data });
});

/** Quick reorder for wholesale buyers: their most-bought lines, re-priced now. */
storeRoutes.get('/:slug/reorder', async (c) => {
  const claims = requireUser(c);
  const data = await withUser(claims, async (tx) => {
    const b = await business(tx, c.req.param('slug'));
    return many(tx, `
      select i.variant_id, i.unit_id, max(i.name) as name, max(i.variant_label) as variant_label,
             round(avg(i.unit_qty))::int as usual_qty, count(*)::int as times, max(o.created_at) as last_ordered,
             (select case when round(avg(i.unit_qty)) = 1 then u.name else u.plural end from units u where u.id = i.unit_id) as unit_name,
             (select pu.factor from product_units pu join product_variants v on v.product_id = pu.product_id
              where v.id = i.variant_id and pu.unit_id = i.unit_id) as factor,
             (select (public.resolve_price(i.variant_id, public.my_customer_id($1), 1, 'web')).unit_price_kobo) as unit_price_kobo,
             (select a.available from public.variant_availability(array[i.variant_id]) a) as available
      from order_items i join orders o on o.id = i.order_id
      where o.business_id = $1 and o.customer_id = public.my_customer_id($1) and o.status in ('confirmed', 'completed')
        and exists (select 1 from product_variants v join products p on p.id = v.product_id
                    where v.id = i.variant_id and v.is_active and p.status = 'active')
      group by i.variant_id, i.unit_id
      order by count(*) desc, max(o.created_at) desc limit 30`, [b.id]);
  });
  return c.json({ items: data });
});

export type { Ctx };
