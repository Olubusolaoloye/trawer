import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, phone } from './client';
import { pool } from '../src/db';
import { closeLive } from '../src/live';

let owner: Client;
let buyer: Client;
let b: string;
let slug: string;
let cid: string;
let variants: string[];

beforeAll(async () => {
  owner = new Client();
  await owner.signIn(phone(), true);
  slug = `cp-${Date.now() % 100000}`;
  b = (await owner.post('/api/biz', { name: 'Special Co', slug, kind: 'wholesaler', brand_colour: '#1C2A5C' })).body.business_id;
  const p = await owner.post(`/api/biz/${b}/products`, { name: 'Wax print', status: 'active', variants: [{ colour: 'Red', retail_price_kobo: 1_500_000, opening_stock: 20 }, { colour: 'Blue', retail_price_kobo: 1_500_000, opening_stock: 20 }] });
  variants = (await owner.get(`/api/biz/${b}/products/${p.body.id}`)).body.variants.map((v: any) => v.id);
  buyer = new Client();
  await buyer.signIn(phone());
  cid = (await buyer.post(`/api/store/${slug}/register`, { buyer_type: 'retail_buyer', name: 'Chidi', accept_terms: true, marketing_opt_in: false })).body.customer_id;
});
afterAll(async () => { await closeLive(); await pool.end(); });

describe('per-customer special prices', () => {
  it('owner sets a special price; the buyer sees it in the store and pays it at checkout', async () => {
    expect((await owner.put(`/api/biz/${b}/customers/${cid}/prices`, { variant_ids: variants, price_kobo: 1_100_000, note: 'Family' })).body).toEqual({ updated: 2 });
    const detail = await owner.get(`/api/biz/${b}/customers/${cid}`);
    expect(detail.body.can_edit).toBe(true);
    expect(detail.body.prices).toHaveLength(2);
    expect(detail.body.prices[0]).toMatchObject({ product_name: 'Wax print', price_kobo: 1_100_000, retail_price_kobo: 1_500_000, note: 'Family' });

    const q = await buyer.post(`/api/store/${slug}/quote`, { items: [{ variant_id: variants[0], qty: 2 }] });
    expect(q.body.lines[0]).toMatchObject({ unit_price_kobo: 1_100_000, price_source: 'override' });
    const order = await buyer.post(`/api/store/${slug}/checkout`, { items: [{ variant_id: variants[0], qty: 2 }], delivery_method: 'pickup' });
    expect(order.status).toBe(201);
    expect(order.body.order.total_kobo).toBe(2_200_000);

    // Someone else still pays the normal price.
    const anon = new Client();
    expect((await anon.post(`/api/store/${slug}/quote`, { items: [{ variant_id: variants[0], qty: 1 }] })).body.lines[0].unit_price_kobo).toBe(1_500_000);
  });

  it('clearing goes back to the normal price', async () => {
    expect((await owner.post(`/api/biz/${b}/customers/${cid}/prices/clear`, { variant_ids: [variants[1]] })).body).toEqual({ cleared: 1 });
    const q = await buyer.post(`/api/store/${slug}/quote`, { items: [{ variant_id: variants[1], qty: 1 }] });
    expect(q.body.lines[0]).toMatchObject({ unit_price_kobo: 1_500_000, price_source: 'retail' });
  });

  it('needs a 2FA session; strangers get not found', async () => {
    const manager = new Client();
    const mp = phone();
    await owner.post(`/api/biz/${b}/staff`, { phone: mp, role: 'manager', display_name: 'Mgr' });
    await manager.signIn(mp);
    expect((await manager.put(`/api/biz/${b}/customers/${cid}/prices`, { variant_ids: variants, price_kobo: 1 })).body.error).toBe('mfa_required');
    const stranger = new Client();
    await stranger.signIn(phone(), true);
    expect((await stranger.get(`/api/biz/${b}/customers/${cid}`)).status).toBe(403);
    const otherBiz = (await stranger.post('/api/biz', { name: 'Other', slug: `cpo-${Date.now() % 100000}`, kind: 'retailer', brand_colour: '#123456' })).body.business_id;
    expect((await stranger.put(`/api/biz/${otherBiz}/customers/${cid}/prices`, { variant_ids: variants, price_kobo: 1 })).status).toBe(404);
  });
});
