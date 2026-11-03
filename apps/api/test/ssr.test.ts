import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { Client, phone } from './client';
import { pool } from '../src/db';
import { closeLive } from '../src/live';
import { createApp } from '../src/app';
import { loadSsr, safeJson, storeHomeFor, subdomainSlug } from '../src/ssr';

const bundle = fileURLToPath(new URL('../../web/dist-ssr/entry-server.js', import.meta.url));
const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta name="theme-color" content="#0B7A4B" />
    <meta name="description" content="Order wholesale and retail on Trawer" />
    <title>Trawer</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

describe('which pages are server-rendered', () => {
  it('store homes on the app domain and on shop subdomains, nothing else', () => {
    expect(storeHomeFor('/s/balogun', 'app.trawer.test')).toEqual({ slug: 'balogun', subdomain: false });
    expect(storeHomeFor('/s/balogun/', 'app.trawer.test')).toEqual({ slug: 'balogun', subdomain: false });
    expect(storeHomeFor('/', 'balogun.trawer.test')).toEqual({ slug: 'balogun', subdomain: true });
    expect(storeHomeFor('/s/balogun/cart', 'app.trawer.test')).toBeNull();
    expect(storeHomeFor('/dashboard', 'app.trawer.test')).toBeNull();
    expect(storeHomeFor('/cart', 'balogun.trawer.test')).toBeNull();
    expect(subdomainSlug('www.trawer.test')).toBeNull();
    expect(subdomainSlug('a.b.trawer.test')).toBeNull();
    expect(subdomainSlug('evil.com')).toBeNull();
  });

  it('embedded data can never close its script tag', () => {
    const out = safeJson({ name: '</script><script>alert(1)</script>', amp: 'a&b', ls: '\u2028' });
    expect(out).not.toMatch(/<|>|&|\u2028/);
    expect(JSON.parse(out)).toEqual({ name: '</script><script>alert(1)</script>', amp: 'a&b', ls: '\u2028' });
  });
});

describe.skipIf(!existsSync(bundle))('server-rendered store home (needs `pnpm --filter @trawer/web build`)', () => {
  const slug = `ssr-${Date.now() % 100000}`;
  let app: Hono<any>;
  let businessId: string;

  beforeAll(async () => {
    app = createApp();
    const ssr = await loadSsr(app, TEMPLATE, bundle);
    expect(ssr).not.toBeNull();
    app.get('*', async (c) => (await ssr!(c)) ?? c.text('shell'));

    const owner = new Client();
    await owner.signIn(phone(), true);
    const created = await owner.post('/api/biz', { name: 'Iya Bisi Textiles', slug, kind: 'wholesaler', brand_colour: '#7C2D12', display_name: 'Bisi' });
    businessId = created.body.business_id;
    const p = await owner.post(`/api/biz/${businessId}/products`, {
      name: 'Royal Hollandais', category: 'Ankara', base_unit: 'piece', status: 'active',
      variants: [{ colour: 'Red', colour_hex: '#B91C1C', retail_price_kobo: 1_500_000, opening_stock: 30 }],
    });
    expect(p.status).toBe(201);
  });

  afterAll(async () => {
    await closeLive();
    await pool.end();
  });

  const get = (path: string, host = 'app.trawer.test') => app.request(path, { headers: { host, 'x-forwarded-for': '10.200.0.1' } });

  it('sends the shop, its products and the data in the first response', async () => {
    const r = await get(`/s/${slug}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('private, no-cache');
    expect(r.headers.get('vary')).toContain('Cookie');
    const html = await r.text();
    expect(html).toContain('<title>Iya Bisi Textiles</title>');
    expect(html).toContain('Royal Hollandais');
    expect(html).toContain('₦15,000');
    expect(html).toMatch(/<html lang="en" data-ssr data-store-theme="\w+" style="--brand:#7C2D12;/);
    const data = JSON.parse(/<script type="application\/json" id="ssr-data">(.*?)<\/script>/s.exec(html)![1]!);
    expect(Object.keys(data)).toEqual(expect.arrayContaining([`/api/store/${slug}`, `/api/store/${slug}/products?`]));
  });

  it('renders the shop subdomain home and search results', async () => {
    expect(await (await get('/', `${slug}.trawer.test`)).text()).toContain('Royal Hollandais');
    const html = await (await get(`/s/${slug}?q=nothing-matches`)).text();
    expect(html).not.toContain('Royal Hollandais');
    expect(html).toContain('ssr-data');
  });

  it('falls back to the app shell for unknown shops', async () => {
    expect(await (await get('/s/no-such-shop-here')).text()).toBe('shell');
  });

  it('escapes whatever a shop owner types', async () => {
    await pool.query(`update businesses set name = $2 where id = $1`, [businessId, `Bisi </title><script>alert(1)</script>`]);
    const html = await (await get(`/s/${slug}`)).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&#60;/title&#62;');
  });
});
