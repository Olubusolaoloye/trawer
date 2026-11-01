/**
 * POS device API. Bearer-token auth only (see app.ts). Each sale syncs in its own transaction so
 * one bad sale cannot block the rest of the outbox.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { uuid } from '@trawer/core/schemas';
import type { PosVariant, SyncResult } from '@trawer/core/pos';
import { loadPriceBook } from '@trawer/db';
import { dbErrorCode, many, one, withUser } from '../db';
import { ApiError, body, query, requireUser, type AppEnv } from '../http';
import { imageUrl } from '../storage';

export const posRoutes = new Hono<AppEnv>();

posRoutes.use('*', async (c, next) => {
  if (!c.req.header('authorization')) throw new ApiError(401, 'bearer_token_required');
  await next();
});

/** Register this phone/tablet as a till (manager). */
posRoutes.post('/devices', async (c) => {
  const claims = requireUser(c);
  const input = await body(c, z.object({ business_id: uuid, name: z.string().trim().min(1).max(60), location_id: uuid.optional(), platform: z.string().max(30).optional() }));
  const d = await withUser(claims, (tx) => one(tx,
    `insert into devices (business_id, location_id, name, platform, created_by)
     values ($1, coalesce($2, app.default_location($1)), $3, $4, auth.uid()) returning id, business_id, location_id, name`,
    [input.business_id, input.location_id ?? null, input.name, input.platform ?? null]));
  if (!d) throw new ApiError(403, 'permission_denied');
  return c.json({ device: d }, 201);
});

posRoutes.get('/devices', async (c) => {
  const claims = requireUser(c);
  const { business_id } = query(c, z.object({ business_id: uuid }));
  const rows = await withUser(claims, (tx) => many(tx,
    `select d.id, d.name, d.platform, d.status, d.last_sync_at, l.name location from devices d join locations l on l.id = d.location_id
     where d.business_id = $1 order by d.name`, [business_id]));
  return c.json({ devices: rows });
});

posRoutes.get('/bootstrap', async (c) => {
  const claims = requireUser(c);
  const { device_id, since } = query(c, z.object({ device_id: uuid, since: z.string().datetime({ offset: true }).optional() }));
  const data = await withUser(claims, async (tx) => {
    const device = await one(tx, `select d.*, b.name business_name, b.address, b.phone, b.brand_colour
                                  from devices d join businesses b on b.id = d.business_id where d.id = $1 and d.status = 'active'`, [device_id]);
    if (!device) throw new ApiError(404, 'unknown_device');
    const role = (await one(tx, `select app.staff_role($1) r`, [device.business_id]))?.r;
    if (!role) throw new ApiError(403, 'not_staff');
    const serverTime = (await one<{ t: string }>(tx, `select now() t`))!.t;
    const [variants, units, allocations, customers, priceBook] = await Promise.all([
      many(tx, `
        select v.id, v.product_id, p.name, nullif(concat_ws(' / ', v.colour, v.size), '') label, v.sku, v.barcode,
               (v.is_active and p.status = 'active') active,
               (select path from variant_images vi where vi.product_id = p.id and (vi.variant_id = v.id or vi.variant_id is null)
                order by vi.variant_id nulls last, vi.position limit 1) image
        from product_variants v join products p on p.id = v.product_id
        where v.business_id = $1 and ($2::timestamptz is null or greatest(v.updated_at, p.updated_at) > $2)
        order by v.id limit 20000`, [device.business_id, since ?? null]),
      many(tx, `select pu.product_id, pu.unit_id, u.name, u.plural, pu.factor, pu.is_base, pu.barcode
                from product_units pu join units u on u.id = pu.unit_id where pu.business_id = $1 and pu.sellable`, [device.business_id]),
      many(tx, `select variant_id, qty from device_allocations where device_id = $1`, [device_id]),
      many(tx, `select c.id, c.name, c.phone, t.name tier from customers c left join customer_tiers t on t.id = c.tier_id
                where c.business_id = $1 and ($2::timestamptz is null or c.updated_at > $2)`, [device.business_id, since ?? null]),
      loadPriceBook(tx, device.business_id),
    ]);
    const unitsByProduct = new Map<string, PosVariant['units']>();
    for (const u of units) {
      const list = unitsByProduct.get(u.product_id) ?? [];
      list.push({ unitId: u.unit_id, name: u.name, plural: u.plural, factor: u.factor, isBase: u.is_base, barcode: u.barcode });
      unitsByProduct.set(u.product_id, list);
    }
    const posVariants: PosVariant[] = variants.map((v) => ({
      id: v.id, productId: v.product_id, name: v.name, label: v.label, sku: v.sku, barcode: v.barcode, active: v.active,
      image: imageUrl(v.image, 200), units: (unitsByProduct.get(v.product_id) ?? []).sort((a, b) => a.factor - b.factor),
    }));
    return {
      serverTime: new Date(serverTime).toISOString(),
      device: { id: device.id, name: device.name, business_id: device.business_id, location_id: device.location_id },
      business: { name: device.business_name, address: device.address, phone: device.phone, brand_colour: device.brand_colour },
      role,
      variants: posVariants,
      priceBook,
      allocations: Object.fromEntries(allocations.map((a) => [a.variant_id, a.qty])),
      customers,
    };
  });
  return c.json(data);
});

const saleSchema = z.object({
  client_id: uuid,
  sold_at: z.string().datetime({ offset: true }),
  customer_id: uuid.nullable().optional(),
  note: z.string().max(1000).optional(),
  items: z.array(z.object({ variant_id: uuid, unit_id: uuid.nullable().optional(), qty: z.number().int().positive().max(1_000_000), unit_price_kobo: z.number().int().min(0) })).min(1).max(200),
  payments: z.array(z.object({ client_id: uuid, method: z.enum(['cash', 'card_terminal', 'transfer', 'ussd', 'qr']), amount_kobo: z.number().int().positive() })).max(10),
});

posRoutes.post('/sync', async (c) => {
  const claims = requireUser(c);
  const { device_id, sales } = await body(c, z.object({ device_id: uuid, sales: z.array(z.unknown()).max(100) }));
  const results: SyncResult[] = [];
  for (const raw of sales) {
    const parsed = saleSchema.safeParse(raw);
    const clientId = (raw as { client_id?: string })?.client_id ?? 'unknown';
    if (!parsed.success) {
      results.push({ client_id: clientId, status: 'error', error: 'validation_failed', retryable: false });
      continue;
    }
    try {
      const r = await withUser(claims, (tx) => one<{ r: any }>(tx, `select public.sync_pos_sale($1::jsonb) r`, [JSON.stringify({ ...parsed.data, device_id })]));
      results.push({ client_id: parsed.data.client_id, status: r!.r.status, order_number: r!.r.order_number });
    } catch (err) {
      const code = dbErrorCode(err);
      // Server/network problems are retried; permission or data errors will never succeed.
      results.push({ client_id: parsed.data.client_id, status: 'error', error: code, retryable: code === 'server_error' || code === 'rate_limited' });
    }
  }
  return c.json({ results });
});

posRoutes.post('/allocate', async (c) => {
  const claims = requireUser(c);
  const input = await body(c, z.object({ device_id: uuid, variant_id: uuid, qty: z.number().int().refine((n) => n !== 0) }));
  await withUser(claims, (tx) => tx.query(`select public.allocate_to_device($1, $2, $3)`, [input.device_id, input.variant_id, input.qty]));
  return c.json({ ok: true });
});

posRoutes.get('/cash-up', async (c) => {
  const claims = requireUser(c);
  const { business_id, day } = query(c, z.object({ business_id: uuid, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }));
  const expected = await withUser(claims, (tx) => one(tx, `select public.cash_up_summary($1, $2::date, null) s`, [business_id, day]));
  return c.json({ expected: expected?.s ?? {} });
});

posRoutes.post('/cash-up', async (c) => {
  const claims = requireUser(c);
  const input = await body(c, z.object({ business_id: uuid, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), counted_cash_kobo: z.number().int().min(0), device_id: uuid.optional(), note: z.string().max(300).optional() }));
  const r = await withUser(claims, (tx) => one(tx, `select public.submit_cash_up($1, $2::date, $3, $4, $5) r`,
    [input.business_id, input.day, input.counted_cash_kobo, input.device_id ?? null, input.note ?? null]));
  return c.json({ cash_up: r!.r });
});
