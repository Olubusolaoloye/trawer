import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { app, Client, phone } from './client';
import { pool } from '../src/db';
import { closeLive } from '../src/live';
import { scrub } from '../src/log';

let owner: Client;
let slug: string;
let variantId: string;

beforeAll(async () => {
  owner = new Client();
  await owner.signIn(phone(), true);
  slug = `hd-${Date.now() % 100000}`;
  const bid = (await owner.post('/api/biz', { name: 'Hardening Fabrics', slug, kind: 'wholesaler', brand_colour: '#0B7A4B' })).body.business_id;
  const p = await owner.post(`/api/biz/${bid}/products`, { name: 'Ankara', status: 'active', base_unit: 'piece', variants: [{ colour: 'Blue', retail_price_kobo: 100_000, opening_stock: 500 }] });
  variantId = (await owner.get(`/api/biz/${bid}/products/${p.body.id}`)).body.variants[0].id;
});
afterAll(async () => { await closeLive(); await pool.end(); });

async function buyer() {
  const b = new Client();
  const ph = phone();
  await b.signIn(ph);
  await b.post(`/api/store/${slug}/register`, { buyer_type: 'retail_buyer', name: 'Ada Obi', accept_terms: true });
  return { b, ph };
}

describe('NDPA endpoints', () => {
  it('export downloads my data as a file; consent can be changed', async () => {
    const { b } = await buyer();
    await b.post(`/api/store/${slug}/checkout`, { items: [{ variant_id: variantId, qty: 1 }] });
    const r = await b.get('/api/me/export');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="trawer-my-data-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(r.body.shops[0]).toMatchObject({ shop: 'Hardening Fabrics', profile: { name: 'Ada Obi' } });
    expect(r.body.shops[0].orders).toHaveLength(1);
    const shops = (await b.get('/api/me/privacy')).body.shops;
    expect((await b.post('/api/me/consent', { business_id: shops[0].business_id, kind: 'whatsapp_updates', granted: false })).status).toBe(200);
    expect((await b.get('/api/me/privacy')).body.shops[0]).toMatchObject({ whatsapp_updates: false, marketing: false });
    expect((await new Client().get('/api/me/export')).status).toBe(401);
  });

  it('delete needs a fresh code for my own phone and the word DELETE, then signs me out', async () => {
    const { b, ph } = await buyer();
    expect((await b.post('/api/me/delete', { code: '000000', confirm: 'delete' })).status).toBe(422);
    expect((await b.post('/api/me/delete', { code: '123456', confirm: 'DELETE' })).body.error).toBe('invalid_code');
    await b.post('/api/auth/otp', { phone: ph });
    const r = await b.post('/api/me/delete', { code: '000000', confirm: 'DELETE' });
    expect([r.status, r.body]).toEqual([200, { erased_shops: 1 }]);
    expect((await b.get('/api/auth/me')).body.user).toBeNull();
  });
});

describe('abuse limits', () => {
  it('checkout is rate limited per buyer', async () => {
    const { b } = await buyer();
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) statuses.push((await b.post(`/api/store/${slug}/checkout`, { items: [{ variant_id: variantId, qty: 1 }] })).status);
    expect(statuses.filter((s) => s === 200 || s === 201).length).toBe(30);
    expect(statuses.at(-1)).toBe(429);
  });

  it('oversized requests are refused before they are parsed', async () => {
    const big = 'x'.repeat(1_200_000);
    const r = await owner.post(`/api/store/${slug}/register`, { buyer_type: 'retail_buyer', name: big, accept_terms: true });
    expect([r.status, r.body.error]).toEqual([413, 'too_large']);
  });

  it('security headers on every response', async () => {
    const r = await app.request('/api/health');
    expect(r.headers.get('permissions-policy')).toContain('camera=()');
    expect(r.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    expect(r.headers.get('strict-transport-security')).toContain('max-age=63072000');
  });
});

describe('error monitoring', () => {
  it('scrubs phones, tokens, emails and link tokens before anything is logged or sent', () => {
    expect(scrub('call +2348031234567 or 08031234567, mail ada@x.ng, jwt eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl, /api/track/AbCdEfGhIjKlMnOp12'))
      .toBe('call [phone] or [phone], mail [email], jwt [token], /api/track/[token]');
  });

  it('browser errors are accepted from our pages, scrubbed, and rate limited', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const browser = new Client(); // one device, one IP
    const send = (message: string) => browser.post('/api/client-errors', { message, type: 'TypeError', url: 'https://app.trawer.test/s/balogun', stack: 'TypeError: x\n    at f (https://app.trawer.test/assets/index.js:1:2)' });
    expect((await send('Cannot read properties of undefined (buyer +2348031234567)')).status).toBe(204);
    const line = spy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('"source":"browser"'))!;
    expect(line).toContain('[phone]');
    expect(line).not.toContain('2348031234567');
    let last = 204;
    for (let i = 0; i < 35; i++) last = (await send(`boom ${i}`)).status;
    expect(last).toBe(429);
    spy.mockRestore();
  });
});

describe('sessions', () => {
  it('parallel requests with an expired access token share one refresh (nobody gets signed out)', async () => {
    const { refreshSession, verifyOtp } = await import('../src/auth');
    const session = await verifyOtp(phone(), '000000');
    const [a, b] = await Promise.all([refreshSession(session.refreshToken), refreshSession(session.refreshToken)]);
    expect(a).toBe(b);
    expect(a.accessToken).toBeTruthy();
  });
});
