/** Public order tracking by unguessable token. Returns no personal data (no name, phone or address). */
import { Hono } from 'hono';
import { many, one, withService } from '../db';
import { ApiError, type AppEnv } from '../http';

export const trackRoutes = new Hono<AppEnv>();

trackRoutes.get('/:token', async (c) => {
  const token = c.req.param('token');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw new ApiError(404, 'not_found');
  const data = await withService(async (tx) => {
    const o = await one(tx, `select o.id, o.order_number, o.status, o.payment_status, o.fulfilment_status, o.delivery_method, o.total_kobo,
                                    o.balance_kobo, o.created_at, o.confirmed_at, b.name shop, b.slug::text slug, b.brand_colour
                             from orders o join businesses b on b.id = o.business_id where o.tracking_token = $1`, [token]);
    if (!o) return null;
    const items = await many(tx, `select name, variant_label, unit_qty, (select case when unit_qty = 1 then name else plural end from units where id = unit_id) unit from order_items where order_id = $1 order by created_at`, [o.id]);
    const timeline = (await one<{ t: any }>(tx, `select public.tracking_events($1) t`, [token]))!.t;
    const { id: _id, ...rest } = o;
    return { order: rest, items, ...timeline };
  });
  if (!data) throw new ApiError(404, 'not_found');
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex');
  return c.json(data);
});
