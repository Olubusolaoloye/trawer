import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { app, Client, phone } from './client';
import { pool } from '../src/db';
import { closeLive } from '../src/live';
import { setMessagingProvider } from '../src/whatsapp';
import { ConsoleMessagingProvider } from '@trawer/core/messaging';

setMessagingProvider(new ConsoleMessagingProvider('test-meta-app-secret', true));
let owner: Client;
let businessId: string;
let slug: string;
let variantId: string;
let riderPhone: string;
let riderToken: string;
let riderStaffId: string;

async function bearer(p: string): Promise<string> {
  const c = new Client();
  await c.post('/api/auth/otp', { phone: p });
  const r = await c.req('POST', '/api/auth/verify', { phone: p, code: '000000' }, { 'x-client': 'pos' });
  return r.body.session.accessToken;
}
const pos = (path: string, init: { method?: string; json?: unknown; form?: FormData } = {}) => app.request(path, {
  method: init.method ?? (init.json || init.form ? 'POST' : 'GET'),
  headers: { authorization: `Bearer ${riderToken}`, ...(init.json ? { 'content-type': 'application/json' } : {}) },
  body: init.form ?? (init.json ? JSON.stringify(init.json) : undefined),
});

beforeAll(async () => {
  owner = new Client();
  await owner.signIn(phone(), true);
  slug = `dl-${Date.now() % 100000}`;
  businessId = (await owner.post('/api/biz', { name: 'Delivery Fabrics', slug, kind: 'wholesaler', brand_colour: '#0B7A4B' })).body.business_id;
  const p = await owner.post(`/api/biz/${businessId}/products`, { name: 'Hollandais wax', status: 'active', base_unit: 'piece', variants: [{ colour: 'Blue', retail_price_kobo: 1_850_000, opening_stock: 50 }] });
  variantId = (await owner.get(`/api/biz/${businessId}/products/${p.body.id}`)).body.variants[0].id;
  riderPhone = phone();
  riderStaffId = (await owner.post(`/api/biz/${businessId}/staff`, { phone: riderPhone, role: 'rider', display_name: 'Musa Ibrahim' })).body.id;
  riderToken = await bearer(riderPhone);
});
afterAll(async () => { await closeLive(); await pool.end(); });

async function paidDeliveryOrder() {
  const buyer = new Client();
  await buyer.signIn(phone());
  await buyer.post(`/api/store/${slug}/register`, { buyer_type: 'retail_buyer', name: 'Ada Obi', accept_terms: true });
  const o = (await buyer.post(`/api/store/${slug}/checkout`, { items: [{ variant_id: variantId, qty: 2 }], delivery_method: 'delivery',
    delivery_address: { line1: '12 Upper Iweka Road', city: 'Onitsha', state: 'Anambra', landmark: 'Opposite the park' } })).body.order;
  await owner.post(`/api/biz/${businessId}/orders/${o.id}/payments`, { amount_kobo: o.total_kobo, method: 'transfer' });
  return { buyer, order: o };
}

describe('delivery tracking', () => {
  it('owner packs and assigns; the rider sees it, uploads a proof photo and marks it delivered from the till app', async () => {
    const { buyer, order } = await paidDeliveryOrder();
    expect((await owner.post(`/api/biz/${businessId}/orders/${order.id}/fulfilment`, { status: 'packed' })).status).toBe(200);
    const riders = (await owner.get(`/api/biz/${businessId}/riders`)).body.riders;
    expect(riders[0]).toMatchObject({ id: riderStaffId, name: 'Musa Ibrahim', role: 'rider', carrying: 0 });
    expect((await owner.post(`/api/biz/${businessId}/orders/${order.id}/rider`, { staff_id: riderStaffId })).status).toBe(200);

    const sheet = await (await pos(`/api/pos/deliveries?business_id=${businessId}`)).json() as any;
    expect(sheet.deliveries[0]).toMatchObject({ order_id: order.id, status: 'packed', recipient_name: 'Ada Obi', address: { landmark: 'Opposite the park' } });

    const client = crypto.randomUUID();
    expect((await pos(`/api/pos/deliveries/${order.id}/status`, { json: { status: 'dispatched', client_id: client } })).status).toBe(200);
    // replayed from the offline queue: no second event
    expect(await (await pos(`/api/pos/deliveries/${order.id}/status`, { json: { status: 'dispatched', client_id: client } })).json()).toMatchObject({ duplicate: true });

    const missing = await pos(`/api/pos/deliveries/${order.id}/status`, { json: { status: 'delivered' } });
    expect([missing.status, (await missing.json() as any).error]).toEqual([422, 'proof_required']);

    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#0B7A4B' } }).jpeg().toBuffer();
    const form = new FormData();
    form.append('file', new File([new Uint8Array(jpeg)], 'proof.jpg', { type: 'image/jpeg' }));
    const up = await pos(`/api/pos/deliveries/${order.id}/proof`, { form });
    expect(up.status).toBe(201);
    const { path } = await up.json() as any;
    expect(path.startsWith(`${businessId}/`)).toBe(true);
    expect((await pos(`/api/pos/deliveries/${order.id}/status`, { json: { status: 'delivered', proof_path: path, received_by: 'Ada' } })).status).toBe(200);

    // Staff: timeline with who did what, and the private proof photo.
    const d = (await owner.get(`/api/biz/${businessId}/orders/${order.id}/delivery`)).body;
    expect(d.events.map((e: any) => [e.status, e.by])).toEqual([['packed', null], ['dispatched', 'Musa Ibrahim'], ['delivered', 'Musa Ibrahim']]);
    expect(d.delivery).toMatchObject({ rider_name: 'Musa', received_by: 'Ada', has_proof: true });
    expect(d.delivery.proof_path).toBeUndefined();
    const img = await owner.req('GET', d.delivery.proof_url);
    expect([img.status, img.headers.get('content-type')]).toEqual([200, 'image/webp']);
    // The photo is not public, and not visible to another shop's owner.
    expect((await app.request(`/media/proofs/${path}`)).status).toBe(404);
    const stranger = new Client();
    await stranger.signIn(phone(), true);
    expect((await stranger.req('GET', d.delivery.proof_url)).status).toBe(403);

    // Buyer: sees the timeline on their order, not the photo or staff notes.
    const mine = (await buyer.get(`/api/orders/${order.id}`)).body;
    expect(mine.order.status).toBe('completed');
    expect(mine.delivery.events.map((e: any) => e.status)).toEqual(['packed', 'dispatched', 'delivered']);
    expect(mine.delivery.delivery.proof_path).toBeNull();
    expect(mine.delivery.events[1].by).toBeNull();

    // Public tracking: statuses and times only.
    const [{ tracking_token }] = (await pool.query(`select tracking_token from orders where id = $1`, [order.id])).rows;
    const t = await (await app.request(`/api/track/${tracking_token}`)).json() as any;
    expect(t.events.map((e: any) => e.status)).toEqual(['packed', 'dispatched', 'delivered']);
    expect(JSON.stringify(t)).not.toMatch(/Musa|Ada|Iweka|\+234/);
  });

  it('a rider cannot touch deliveries that are not theirs, or book packing/returns', async () => {
    const { order } = await paidDeliveryOrder();
    const r1 = await pos(`/api/pos/deliveries/${order.id}/status`, { json: { status: 'packed' } });
    expect(r1.status).toBe(403);
    await owner.post(`/api/biz/${businessId}/orders/${order.id}/fulfilment`, { status: 'packed' });
    const r2 = await pos(`/api/pos/deliveries/${order.id}/status`, { json: { status: 'dispatched' } });
    expect(r2.status).toBe(403); // not assigned to them
    const bad = await owner.post(`/api/biz/${businessId}/orders/${order.id}/fulfilment`, { status: 'delivered' });
    expect([bad.status, bad.body.error]).toEqual([422, 'invalid_transition']);
  });
});
