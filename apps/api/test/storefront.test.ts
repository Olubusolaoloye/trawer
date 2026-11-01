import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { FakePaymentProvider } from '@trawer/core/payments';
import { Client, phone } from './client';
import { pool } from '../src/db';
import { closeLive } from '../src/live';

const slug = `bal-${Date.now() % 100000}`;
let owner: Client;
let businessId: string;
let productId: string;
let redId: string;
let blueId: string;

beforeAll(async () => {
  owner = new Client();
  await owner.signIn(phone(), true);
  const created = await owner.post('/api/biz', { name: 'Balogun Fabrics', slug, kind: 'wholesaler', brand_colour: '#7C2D12', display_name: 'Mama B' });
  expect(created.status).toBe(201);
  businessId = created.body.business_id;
  const p = await owner.post(`/api/biz/${businessId}/products`, {
    name: 'Hollandais wax print', category: 'Ankara', base_unit: 'piece', packs: [{ unit: 'bundle', factor: 6 }], status: 'active',
    variants: [
      { colour: 'Red', colour_hex: '#B91C1C', retail_price_kobo: 1_500_000, cost_kobo: 1_100_000, opening_stock: 30 },
      { colour: 'Blue', colour_hex: '#1D4ED8', retail_price_kobo: 1_500_000, opening_stock: 0 },
    ],
  });
  expect(p.status).toBe(201);
  productId = p.body.id;
  const detail = await owner.get(`/api/biz/${businessId}/products/${productId}`);
  [redId, blueId] = detail.body.variants.map((v: { id: string }) => v.id);
  const wholesale = detail.body.tiers.find((t: { is_wholesale: boolean }) => t.is_wholesale);
  expect((await owner.put(`/api/biz/${businessId}/variants/${redId}/tier-prices`, { tier_prices: [{ tier_id: wholesale.id, price_kobo: 1_200_000 }] })).status).toBe(200);
});

afterAll(async () => {
  await closeLive();
  await pool.end();
});

describe('security basics', () => {
  it('rejects state-changing requests without the CSRF header', async () => {
    const c = new Client();
    const r = await c.req('POST', '/api/auth/otp', { phone: phone() }, { 'x-trawer': '' });
    expect(r.status).toBe(403);
  });

  it('sets httpOnly session cookies scoped to the root domain', async () => {
    const c = new Client();
    await c.post('/api/auth/otp', { phone: phone() });
    const r = await c.post('/api/auth/verify', { phone: '+2348030000001', code: '000000' });
    const cookies = r.headers.getSetCookie().join('\n');
    expect(cookies).toMatch(/tw_at=.*HttpOnly/);
    expect(cookies).toMatch(/Domain=\.trawer\.test/);
  });

  it('rate limits OTP requests per phone', async () => {
    const c = new Client();
    const p = phone();
    for (let i = 0; i < 5; i++) expect((await c.post('/api/auth/otp', { phone: p })).status).toBe(200);
    expect((await c.post('/api/auth/otp', { phone: p })).status).toBe(429);
  });

  it('rejects a wrong OTP and invalid phone numbers', async () => {
    const c = new Client();
    expect((await c.post('/api/auth/verify', { phone: phone(), code: '123456' })).status).toBe(400);
    expect((await c.post('/api/auth/otp', { phone: '12345' })).status).toBe(422);
  });

  it('owner without TOTP cannot invite staff', async () => {
    const c = new Client();
    const p = phone();
    await c.signIn(p);
    const b = await c.post('/api/biz', { name: 'No MFA', slug: `nomfa-${Date.now() % 100000}`, kind: 'retailer', brand_colour: '#000000' });
    const r = await c.post(`/api/biz/${b.body.business_id}/staff`, { phone: phone(), role: 'cashier' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('mfa_required');
  });
});

describe('storefront', () => {
  it('shows the catalogue to anonymous visitors with retail prices and sold-out swatches', async () => {
    const anon = new Client();
    const store = await anon.get(`/api/store/${slug}`);
    expect(store.body.business.name).toBe('Balogun Fabrics');
    const list = await anon.get(`/api/store/${slug}/products`);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ price_kobo: 1_500_000, in_stock: true });
    expect(list.body.items[0].swatches).toEqual([
      { colour: 'Red', hex: '#B91C1C', in_stock: true },
      { colour: 'Blue', hex: '#1D4ED8', in_stock: false },
    ]);
    const detail = await anon.get(`/api/store/${slug}/products/${productId}`);
    expect(detail.body.variants.map((v: any) => v.available)).toEqual([30, 0]);
    expect(JSON.stringify(detail.body)).not.toContain('1100000'); // cost never leaks
  });

  it('paginates with a cursor', async () => {
    for (let i = 0; i < 3; i++) {
      await owner.post(`/api/biz/${businessId}/products`, { name: `Lace ${i}`, status: 'active', variants: [{ retail_price_kobo: 100_000 }] });
    }
    const anon = new Client();
    const p1 = await anon.get(`/api/store/${slug}/products?limit=2`);
    expect(p1.body.items).toHaveLength(2);
    const p2 = await anon.get(`/api/store/${slug}/products?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items).toHaveLength(2);
    expect(new Set([...p1.body.items, ...p2.body.items].map((i: any) => i.id)).size).toBe(4);
    const search = await anon.get(`/api/store/${slug}/products?q=hollandais`);
    expect(search.body.items.map((i: any) => i.id)).toEqual([productId]);
  });

  it('wholesaler: apply → approved → sees wholesale price → checks out → pays by transfer → confirmed', async () => {
    const buyer = new Client(`${slug}.trawer.test`);
    await buyer.signIn(phone());
    const reg = await buyer.post(`/api/store/${slug}/register`, { buyer_type: 'wholesaler', name: 'Chidi Okafor', business_name: 'Chidi Textiles', cac_number: 'RC123456', accept_terms: true });
    expect(reg.status).toBe(200);
    let store = await buyer.get(`/api/store/${slug}`);
    expect(store.body.me).toMatchObject({ wholesale_status: 'pending', is_wholesale_view: false });
    const pendingQuote = await buyer.post(`/api/store/${slug}/quote`, { items: [{ variant_id: redId, qty: 1 }] });
    expect(pendingQuote.body.lines[0].unit_price_kobo).toBe(1_500_000);

    const queue = await owner.get(`/api/biz/${businessId}/customers?pending=true`);
    expect(queue.body.customers.map((c: any) => c.id)).toContain(reg.body.customer_id);
    expect((await owner.post(`/api/biz/${businessId}/customers/${reg.body.customer_id}/wholesale`, { approve: true })).status).toBe(200);

    store = await buyer.get(`/api/store/${slug}`);
    expect(store.body.me).toMatchObject({ wholesale_status: 'approved', is_wholesale_view: true });
    const quote = await buyer.post(`/api/store/${slug}/quote`, { items: [{ variant_id: redId, qty: 1 }] });
    expect(quote.body.lines[0]).toMatchObject({ unit_price_kobo: 1_200_000, price_source: 'tier' });

    const units = (await buyer.get(`/api/store/${slug}/products/${productId}`)).body.units;
    const bundle = units.find((u: any) => u.name === 'bundle');
    const checkout = await buyer.post(`/api/store/${slug}/checkout`, {
      items: [{ variant_id: redId, unit_id: bundle.unit_id, qty: 1 }, { variant_id: redId, qty: 2 }],
      delivery_method: 'delivery',
      delivery_address: { line1: '12 Balogun Street', city: 'Lagos Island', state: 'Lagos' },
    });
    expect(checkout.status).toBe(201);
    const order = checkout.body.order;
    expect(order.total_kobo).toBe(8 * 1_200_000);
    expect(checkout.body.virtual_account.account_number).toMatch(/^\d{10}$/);

    // Transfer arrives via the signed webhook
    const fake = new FakePaymentProvider();
    const { body, signature } = fake.simulateTransfer(checkout.body.virtual_account.account_number, order.total_kobo, `ref-${order.id}`);
    const hook = new Client();
    const w1 = await hook.req('POST', '/api/webhooks/paystack', JSON.parse(body), { 'x-paystack-signature': signature, 'x-trawer': '' });
    expect(w1.status).toBe(200);
    const w2 = await hook.req('POST', '/api/webhooks/paystack', JSON.parse(body), { 'x-paystack-signature': signature });
    expect(w2.body).toMatchObject({ duplicate: true });

    const view = await buyer.get(`/api/orders/${order.id}`);
    expect(view.body.order).toMatchObject({ status: 'confirmed', payment_status: 'paid', balance_kobo: 0 });
    expect(view.body.payments).toHaveLength(1);

    const reorder = await buyer.get(`/api/store/${slug}/reorder`);
    expect(reorder.body.items.length).toBeGreaterThan(0);

    const stock = (await owner.get(`/api/biz/${businessId}/products/${productId}`)).body.variants[0];
    expect(stock).toMatchObject({ on_hand: 22, reserved: 0, available: 22 });
  });

  it('rejects a webhook with a bad signature', async () => {
    const hook = new Client();
    const r = await hook.req('POST', '/api/webhooks/paystack', { event: 'charge.success', data: {} }, { 'x-paystack-signature': 'nope' });
    expect(r.status).toBe(401);
  });

  it('checkout fails cleanly when a variant is sold out', async () => {
    const buyer = new Client();
    await buyer.signIn(phone());
    await buyer.post(`/api/store/${slug}/register`, { buyer_type: 'retail_buyer', name: 'Ada', accept_terms: true });
    const r = await buyer.post(`/api/store/${slug}/checkout`, { items: [{ variant_id: blueId, qty: 1 }] });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('insufficient_stock');
  });

  it('delivery checkout requires an address; unregistered users are told to register', async () => {
    const buyer = new Client();
    await buyer.signIn(phone());
    const r1 = await buyer.post(`/api/store/${slug}/checkout`, { items: [{ variant_id: redId, qty: 1 }] });
    expect(r1.body.error).toBe('register_first');
    await buyer.post(`/api/store/${slug}/register`, { buyer_type: 'retail_buyer', name: 'Bola', accept_terms: true });
    const r2 = await buyer.post(`/api/store/${slug}/checkout`, { items: [{ variant_id: redId, qty: 1 }], delivery_method: 'delivery' });
    expect(r2.status).toBe(422);
  });

  it("buyers cannot see another buyer's order", async () => {
    const a = new Client();
    await a.signIn(phone());
    await a.post(`/api/store/${slug}/register`, { buyer_type: 'retail_buyer', name: 'Ade', accept_terms: true });
    const o = await a.post(`/api/store/${slug}/checkout`, { items: [{ variant_id: redId, qty: 1 }] });
    const b = new Client();
    await b.signIn(phone());
    expect((await b.get(`/api/orders/${o.body.order.id}`)).status).toBe(404);
  });
});
