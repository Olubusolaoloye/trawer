import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { HttpPosTransport, MemoryCatalog, MemoryOutbox, MemoryState, PosEngine, type PosSale, type SyncResult } from '@trawer/core/pos';
import { app, Client, phone } from './client';
import { pool } from '../src/db';
import { closeLive } from '../src/live';

let owner: Client;
let businessId: string;
let variantId: string;
let ownerToken: string;
const devices: string[] = [];

async function deviceToken(p: string): Promise<string> {
  const c = new Client();
  await c.post('/api/auth/otp', { phone: p });
  const r = await c.req('POST', '/api/auth/verify', { phone: p, code: '000000' }, { 'x-client': 'pos' });
  expect(r.body.session.accessToken).toBeTruthy();
  expect(r.headers.getSetCookie()).toEqual([]); // devices get tokens, not cookies
  return r.body.session.accessToken;
}

const appFetch: typeof fetch = (input, init) => Promise.resolve(app.request(String(input), init as RequestInit));

function makeEngine(deviceId: string, token: string, staffId = 'staff') {
  const transport = new HttpPosTransport('', async () => token, appFetch);
  return { engine: new PosEngine(new MemoryCatalog(), new MemoryOutbox(), new MemoryState(), transport, { deviceId, staffId }), transport };
}

async function level() {
  const r = await pool.query(`select sum(on_hand)::int on_hand, sum(reserved)::int reserved, sum(allocated)::int allocated, sum(available)::int available from stock_levels where variant_id = $1`, [variantId]);
  return r.rows[0];
}

beforeAll(async () => {
  owner = new Client();
  const ownerPhone = phone();
  await owner.signIn(ownerPhone, true);
  const b = await owner.post('/api/biz', { name: 'Till Shop', slug: `till-${Date.now() % 100000}`, kind: 'retailer', brand_colour: '#123456' });
  businessId = b.body.business_id;
  const p = await owner.post(`/api/biz/${businessId}/products`, { name: 'Guinea brocade', status: 'active', base_unit: 'piece', packs: [{ unit: 'bundle', factor: 5 }], variants: [{ colour: 'Gold', retail_price_kobo: 250_000, opening_stock: 20 }] });
  variantId = (await owner.get(`/api/biz/${businessId}/products/${p.body.id}`)).body.variants[0].id;
  ownerToken = await deviceToken(ownerPhone);
  for (const name of ['Till A', 'Till B']) {
    const r = await app.request('/api/pos/devices', { method: 'POST', headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ business_id: businessId, name }) });
    expect(r.status).toBe(201);
    devices.push(((await r.json()) as any).device.id);
  }
  for (const d of devices) {
    const r = await app.request('/api/pos/allocate', { method: 'POST', headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ device_id: d, variant_id: variantId, qty: 5 }) });
    expect(r.status).toBe(200);
  }
});

afterAll(async () => {
  await closeLive();
  await pool.end();
});

describe('POS API', () => {
  it('refuses POS endpoints without a bearer token, even with a browser session cookie', async () => {
    const r = await owner.get(`/api/pos/devices?business_id=${businessId}`);
    expect(r.status).toBe(401);
  });

  it('two tills sell offline, sync later, and the server stays consistent', async () => {
    const cashierPhone = phone();
    await owner.post(`/api/biz/${businessId}/staff`, { phone: cashierPhone, role: 'cashier' });
    const cashierToken = await deviceToken(cashierPhone);
    const a = makeEngine(devices[0]!, cashierToken);
    const b = makeEngine(devices[1]!, ownerToken);
    await a.engine.sync();
    await b.engine.sync();
    expect(await a.engine.localAvailable(variantId)).toBe(5);

    // Offline: A sells a bundle (5) — its whole allocation; B sells 3 and then 4 more with manager override.
    const ca = await a.engine.openCart();
    const bundle = (await (a.engine as any).catalog.get(variantId)).units.find((u: any) => u.name === 'bundle');
    await a.engine.add(ca.id, variantId, bundle.unitId, 1);
    await a.engine.checkout(ca.id, [{ method: 'cash', amountKobo: 5 * 250_000 }]);
    const cb = await b.engine.openCart();
    await b.engine.add(cb.id, variantId, null, 3);
    await b.engine.checkout(cb.id, [{ method: 'card_terminal', amountKobo: 3 * 250_000 }]);
    const cb2 = await b.engine.openCart();
    await b.engine.add(cb2.id, variantId, null, 4);
    await expect(b.engine.checkout(cb2.id, [{ method: 'cash', amountKobo: 1_000_000 }])).rejects.toThrow('allocated');
    await b.engine.checkout(cb2.id, [{ method: 'cash', amountKobo: 1_000_000 }], { overrideBy: 'owner' });

    expect(await level()).toMatchObject({ on_hand: 20, allocated: 10, available: 10 }); // nothing synced yet

    const [ra, rb] = await Promise.all([a.engine.sync(), b.engine.sync()]);
    expect(ra).toEqual({ pushed: 1, conflicts: 0 });
    expect(rb).toEqual({ pushed: 2, conflicts: 0 }); // 2 over allocation came from the shared pool
    expect(await level()).toEqual({ on_hand: 8, reserved: 0, allocated: 0, available: 8 });
    expect(await a.engine.localAvailable(variantId)).toBe(0);
  });

  it('a lost acknowledgement is safe: the device re-pushes and the server answers duplicate', async () => {
    const { engine, transport } = makeEngine(devices[0]!, ownerToken);
    await engine.sync();
    await app.request('/api/pos/allocate', { method: 'POST', headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ device_id: devices[0], variant_id: variantId, qty: 2 }) });
    await engine.sync();
    const c = await engine.openCart();
    await engine.add(c.id, variantId, null, 1);
    await engine.checkout(c.id, [{ method: 'cash', amountKobo: 250_000 }]);
    // First push reaches the server but the response is lost.
    const realPush = transport.pushSales.bind(transport);
    transport.pushSales = async (d: string, s: PosSale[]): Promise<SyncResult[]> => { await realPush(d, s); throw new Error('network dropped'); };
    await expect(engine.sync()).rejects.toThrow('network dropped');
    transport.pushSales = realPush;
    await engine.sync();
    const before = await level();
    await engine.sync();
    expect(await level()).toEqual(before);
    const r = await pool.query(`select count(*)::int n from orders where business_id = $1 and channel = 'pos'`, [businessId]);
    expect(r.rows[0].n).toBe(4);
  });

  it('cash-up compares what the till took with the server ledger', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
    const h = { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' };
    const exp = await app.request(`/api/pos/cash-up?business_id=${businessId}&day=${today}`, { headers: h });
    const expected = ((await exp.json()) as any).expected;
    expect(expected.card_terminal).toBe(750_000);
    const up = await app.request('/api/pos/cash-up', { method: 'POST', headers: h, body: JSON.stringify({ business_id: businessId, day: today, counted_cash_kobo: expected.cash }) });
    expect(((await up.json()) as any).cash_up.variance_kobo).toBe(0);
  });

  it('dashboard: manager allocates to a till, sees conflicts from an over-sale and resolves them', async () => {
    const r1 = await owner.post(`/api/biz/${businessId}/devices/${devices[1]}/allocate`, { variant_id: variantId, qty: 2 });
    expect(r1.status).toBe(200);
    const list = await owner.get(`/api/biz/${businessId}/devices`);
    const tillB = list.body.devices.find((d: any) => d.id === devices[1]);
    expect(tillB.allocations).toEqual([expect.objectContaining({ variant_id: variantId, qty: 2 })]);
    // Till B oversells far beyond everything that exists (manager override, offline).
    const { engine } = makeEngine(devices[1]!, ownerToken);
    await engine.sync();
    const c = await engine.openCart();
    await engine.add(c.id, variantId, null, 50);
    await engine.checkout(c.id, [{ method: 'cash', amountKobo: 50 * 250_000 }], { overrideBy: 'owner' });
    expect(await engine.sync()).toEqual({ pushed: 1, conflicts: 1 });
    // Till B never takes stock allocated to Till A (1 unit left from the previous test).
    expect(await level()).toEqual({ on_hand: 1, reserved: 0, allocated: 1, available: 0 });
    const alerts = await owner.get(`/api/biz/${businessId}/stock-alerts`);
    expect(alerts.body.alerts).toHaveLength(1);
    expect(alerts.body.alerts[0].qty).toBeGreaterThan(0);
    expect((await owner.post(`/api/biz/${businessId}/stock-alerts/${alerts.body.alerts[0].id}/resolve`)).status).toBe(200);
    expect((await owner.get(`/api/biz/${businessId}/stock-alerts`)).body.alerts).toEqual([]);
    const summary = await owner.get(`/api/biz/${businessId}`);
    expect(summary.body.stats.conflicts).toBe(0);
  });
});
