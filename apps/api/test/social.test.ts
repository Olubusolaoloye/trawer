import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { ConsoleSocialProvider, SocialError } from '@trawer/core/social';
import { app, Client, phone } from './client';
import { pool } from '../src/db';
import { closeLive } from '../src/live';
import { setSocialProvider } from '../src/social';
import { putImage } from '../src/storage';

const sandbox = new ConsoleSocialProvider('https://app.trawer.test', true);
setSocialProvider(sandbox);
const CRON = { authorization: 'Bearer test-cron-secret-0123456789' };
let owner: Client;
let businessId: string;
let productId: string;

const cron = async () => (await app.request('/api/cron/social', { method: 'POST', headers: CRON })).json() as Promise<{ published: number; waiting: number; failed: number }>;
const due = () => pool.query(`update social_posts set next_attempt_at = now() where business_id = $1 and status = 'scheduled'`, [businessId]);

beforeAll(async () => {
  owner = new Client();
  await owner.signIn(phone(), true);
  const slug = `so-${Date.now() % 100000}`;
  businessId = (await owner.post('/api/biz', { name: 'Social Fabrics', slug, kind: 'wholesaler', brand_colour: '#7C3AED' })).body.business_id;
  const p = await owner.post(`/api/biz/${businessId}/products`, { name: 'Swiss voile lace', status: 'active', base_unit: 'piece',
    variants: [{ colour: 'Rose', retail_price_kobo: 3_900_000, opening_stock: 10 }, { colour: 'Gold', retail_price_kobo: 4_100_000, opening_stock: 10 }] });
  productId = p.body.id;
  // a tall photo (taller than Instagram's 4:5) so the JPEG endpoint has to pad it
  const tall = await sharp({ create: { width: 600, height: 1200, channels: 3, background: '#BE185D' } }).png().toBuffer();
  const img = await putImage('products', businessId, tall);
  await pool.query(`insert into variant_images (business_id, product_id, path, width, height) values ($1, $2, $3, $4, $5)`, [businessId, productId, img.path, img.width, img.height]);
});
afterAll(async () => { await closeLive(); await pool.end(); });

describe('Instagram + Facebook', () => {
  it('connects through Facebook Login with a signed state, then the owner picks the Page (MFA)', async () => {
    const { url } = (await owner.get(`/api/biz/${businessId}/social/connect`)).body;
    const back = await owner.get(new URL(url).pathname + new URL(url).search);
    expect(back.status).toBe(302);
    const sid = new URL(back.headers.get('location')!).searchParams.get('connect')!;
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);

    // A state signed for someone else (or tampered) is refused.
    const stranger = new Client();
    await stranger.signIn(phone());
    const forged = await stranger.get(new URL(url).pathname + new URL(url).search);
    expect(new URL(forged.headers.get('location')!).searchParams.get('connect_error')).toBe('expired');

    const choices = (await owner.get(`/api/biz/${businessId}/social/choices/${sid}`)).body.choices;
    expect(choices.map((x: any) => x.page_name)).toEqual(['My Shop (Facebook Page)', 'Old Page (no Instagram)']);
    expect(JSON.stringify(choices)).not.toMatch(/token/);
    const r = await owner.post(`/api/biz/${businessId}/social/connect`, { session_id: sid, page_id: 'sandbox-page-1' });
    expect(r.body).toEqual({ facebook: 'My Shop (Facebook Page)', instagram: 'myshop.ng' });
    const s = (await owner.get(`/api/biz/${businessId}/social`)).body;
    expect(s.accounts.map((a: any) => [a.platform, a.status])).toEqual([['instagram', 'active'], ['facebook', 'active']]);
  });

  it('caption from the shop template; post now to both; the cron publishes with Instagram-ready JPEGs', async () => {
    const { caption } = (await owner.post(`/api/biz/${businessId}/social/caption`, { product_ids: [productId] })).body;
    expect(caption).toContain('Swiss voile lace — ₦39,000 · Colours: Gold, Rose');
    const created = await owner.post(`/api/biz/${businessId}/social/posts`, { platforms: ['instagram', 'facebook'], product_ids: [productId], caption: `${caption} #lace` });
    expect(created.status).toBe(201);
    expect(await cron()).toEqual({ published: 2, waiting: 0, failed: 0 });

    const ig = sandbox.published.find((p) => p.platform === 'instagram')!;
    expect(ig.caption.endsWith('#lace')).toBe(true);
    const jpgPath = new URL(ig.images[0]!).pathname;
    const jpg = await app.request(jpgPath);
    expect([jpg.status, jpg.headers.get('content-type')]).toEqual([200, 'image/jpeg']);
    const meta = await sharp(Buffer.from(await jpg.arrayBuffer())).metadata();
    expect(meta.width! / meta.height!).toBeGreaterThanOrEqual(0.8); // padded to 4:5, not cropped
    expect((await app.request('/api/social/image/../../etc/passwd.jpg')).status).toBe(404);

    const s = (await owner.get(`/api/biz/${businessId}/social`)).body;
    expect(s.posts.filter((p: any) => p.status === 'published')).toHaveLength(2);
    expect(s.posts[0].permalink).toMatch(/^https:\/\/app\.trawer\.test\/sandbox\//);
    expect(s.accounts.find((a: any) => a.platform === 'instagram')).toMatchObject({ quota_used: 1, quota_total: 50 });
  });

  it("waits when Instagram's daily limit is used up, and asks to reconnect when the token dies", async () => {
    sandbox.quota = { used: 50, total: 50 };
    await owner.post(`/api/biz/${businessId}/social/posts`, { platforms: ['instagram'], product_ids: [productId], caption: 'Later today' });
    expect(await cron()).toMatchObject({ waiting: 1, published: 0 });
    let s = (await owner.get(`/api/biz/${businessId}/social`)).body;
    expect(s.posts.find((p: any) => p.caption === 'Later today')).toMatchObject({ status: 'scheduled', last_error: 'publishing_limit_reached' });

    sandbox.quota = { used: 0, total: 50 };
    sandbox.failNext = new SocialError('Error validating access token', 'auth');
    await due();
    expect(await cron()).toMatchObject({ failed: 1 });
    s = (await owner.get(`/api/biz/${businessId}/social`)).body;
    expect(s.posts.find((p: any) => p.caption === 'Later today')).toMatchObject({ status: 'failed', last_error: 'reconnect_needed' });
    expect(s.accounts.find((a: any) => a.platform === 'instagram').status).toBe('expired');
  });

  it('only staff who manage social media can use it', async () => {
    const cashierPhone = phone();
    await owner.post(`/api/biz/${businessId}/staff`, { phone: cashierPhone, role: 'cashier' });
    const cashier = new Client();
    await cashier.signIn(cashierPhone);
    expect((await cashier.get(`/api/biz/${businessId}/social`)).status).toBe(403);
    expect((await cashier.post(`/api/biz/${businessId}/social/posts`, { platforms: ['facebook'], product_ids: [productId], caption: 'x' })).status).toBe(403);
  });
});
