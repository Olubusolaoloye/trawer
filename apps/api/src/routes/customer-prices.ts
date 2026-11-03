/** Customer detail + per-customer special prices (set with 2FA by staff with prices.manage). */
import { Hono } from 'hono';
import { z } from 'zod';
import { uuid } from '@trawer/core/schemas';
import { many, one } from '../db';
import { ApiError, body, type AppEnv } from '../http';
import { asStaff } from './dashboard';

export const customerPriceRoutes = new Hono<AppEnv>();

customerPriceRoutes.get('/:bid/customers/:cid', (c) => asStaff(c, async (tx, b) => {
  const cid = c.req.param('cid');
  const customer = await one(tx, `
    select c.id, c.name, c.phone, c.business_name, c.buyer_type, c.wholesale_status, c.created_at, t.id tier_id, t.name tier,
      (select coalesce(sum(balance_kobo), 0)::bigint from orders o where o.customer_id = c.id and o.status in ('confirmed', 'completed')) owing_kobo,
      (select count(*)::int from orders o where o.customer_id = c.id and o.status in ('confirmed', 'completed')) orders
    from customers c left join customer_tiers t on t.id = c.tier_id
    where c.id = $1 and c.business_id = $2`, [cid, b]);
  if (!customer) throw new ApiError(404, 'not_found');
  const prices = await many(tx, `
    select o.variant_id, o.price_kobo, o.note, o.updated_at, p.id product_id, p.name product_name,
      nullif(concat_ws(' / ', v.colour, v.size), '') variant_label, v.colour_hex, v.sku, v.retail_price_kobo,
      (select tp.price_kobo from tier_prices tp where tp.variant_id = v.id and tp.tier_id = $2) tier_price_kobo
    from customer_price_overrides o
    join product_variants v on v.id = o.variant_id
    join products p on p.id = v.product_id
    where o.customer_id = $1
    order by p.name, v.position`, [cid, customer.tier_id]);
  return c.json({ customer, prices, can_edit: !!(await one(tx, `select app.has_permission($1, 'prices.manage') ok`, [b]))?.ok });
}));

customerPriceRoutes.put('/:bid/customers/:cid/prices', async (c) => {
  const input = await body(c, z.object({
    variant_ids: z.array(uuid).min(1).max(200),
    price_kobo: z.number().int().min(0).max(100_000_000_000),
    note: z.string().trim().max(200).optional(),
  }));
  return asStaff(c, async (tx) => {
    const r = await one<{ n: number }>(tx, `select public.set_customer_price($1, $2::uuid[], $3, $4) n`, [c.req.param('cid'), input.variant_ids, input.price_kobo, input.note ?? null]);
    return c.json({ updated: r!.n });
  });
});

customerPriceRoutes.post('/:bid/customers/:cid/prices/clear', async (c) => {
  const input = await body(c, z.object({ variant_ids: z.array(uuid).min(1).max(200) }));
  return asStaff(c, async (tx) => {
    const r = await one<{ n: number }>(tx, `select public.clear_customer_price($1, $2::uuid[]) n`, [c.req.param('cid'), input.variant_ids]);
    return c.json({ cleared: r!.n });
  });
});
