/**
 * Server side of Instagram/Facebook posting: provider selection, signed OAuth state, the JPEG
 * image endpoint Instagram fetches, and the publishing worker (cron).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import sharp from 'sharp';
import {
  ConsoleSocialProvider, MetaGraphSocialProvider, SocialError, renderCaption, renderCarouselCaption,
  type CaptionProduct, type SocialPlatform, type SocialProvider,
} from '@trawer/core/social';
import { many, one, withService, type Tx } from './db';
import { env } from './env';
import { logError } from './log';
import { readProductOriginal } from './storage';

let provider: SocialProvider | null = null;
export function socialProvider(): SocialProvider {
  provider ??= env.SOCIAL_PROVIDER === 'meta'
    ? new MetaGraphSocialProvider(env.META_APP_ID!, env.META_APP_SECRET!, { graphVersion: env.META_GRAPH_VERSION })
    : new ConsoleSocialProvider(env.APP_URL, env.NODE_ENV === 'test');
  return provider;
}
export function setSocialProvider(p: SocialProvider): void { provider = p; }

export const callbackUrl = () => new URL('/api/social/callback', env.APP_URL).toString();

// ------------------------------------------------------------------------------------------
// OAuth state: who started the connect, for which shop, expiring in 10 minutes. HMAC-signed so the
// callback can't be replayed for another user or shop (CSRF), with a nonce so each one is unique.
// ------------------------------------------------------------------------------------------
const stateKey = () => createHash('sha256').update(`trawer-social-state:${env.META_APP_SECRET ?? ''}:${env.CRON_SECRET}`).digest();
export function signState(businessId: string, userId: string): string {
  const body = Buffer.from(JSON.stringify({ b: businessId, u: userId, n: randomBytes(8).toString('hex'), e: Date.now() + 10 * 60_000 })).toString('base64url');
  return `${body}.${createHmac('sha256', stateKey()).update(body).digest('base64url')}`;
}
export function verifyState(state: string, userId: string): { businessId: string } | null {
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const want = createHmac('sha256', stateKey()).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString()) as { b: string; u: string; e: number };
    return v.u === userId && v.e > Date.now() ? { businessId: v.b } : null;
  } catch { return null; }
}

// ------------------------------------------------------------------------------------------
// Instagram only accepts JPEG at 4:5 … 1.91:1. Product photos are WebP of any shape, so this
// endpoint pads them onto the shop's paper colour instead of cropping the fabric.
// ------------------------------------------------------------------------------------------
export function socialImageUrl(path: string): string {
  return new URL(`/api/social/image/${path.replace(/\.webp$/, '')}.jpg`, env.APP_URL).toString();
}
const jpegCache = new Map<string, Buffer>();
export async function instagramJpeg(path: string): Promise<Buffer | null> {
  const hit = jpegCache.get(path);
  if (hit) return hit;
  const src = await readProductOriginal(path);
  if (!src) return null;
  const img = sharp(src).rotate().resize({ width: 1080, height: 1350, fit: 'inside', withoutEnlargement: false });
  const { data, info } = await img.toBuffer({ resolveWithObject: true });
  const ratio = info.width / info.height;
  let out = sharp(data);
  if (ratio < 0.8) { const pad = Math.ceil((info.height * 0.8 - info.width) / 2); out = out.extend({ left: pad, right: pad, background: '#FAF7F0' }); }
  else if (ratio > 1.91) { const pad = Math.ceil((info.width / 1.91 - info.height) / 2); out = out.extend({ top: pad, bottom: pad, background: '#FAF7F0' }); }
  const jpg = await out.flatten({ background: '#FAF7F0' }).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
  if (jpegCache.size > 200) jpegCache.clear();
  jpegCache.set(path, jpg);
  return jpg;
}

// ------------------------------------------------------------------------------------------
// Captions from live product data
// ------------------------------------------------------------------------------------------
export async function captionProducts(tx: Tx, businessId: string, productIds: string[]): Promise<{ products: (CaptionProduct & { id: string; image: string | null })[]; shop: string; slug: string; template: string }> {
  const b = await one<{ name: string; slug: string; caption_template: string }>(tx, `select name, slug::text, caption_template from businesses where id = $1`, [businessId]);
  const rows = await many<{ id: string; name: string; category: string | null; price: number | null; colours: string[] | null; image: string | null }>(tx, `
    select p.id, p.name, p.category,
      (select min(v.retail_price_kobo) from product_variants v where v.product_id = p.id and v.is_active) price,
      (select array_agg(distinct v.colour) filter (where v.colour is not null) from product_variants v where v.product_id = p.id and v.is_active) colours,
      (select vi.path from variant_images vi where vi.product_id = p.id order by vi.variant_id nulls first, vi.position limit 1) image
    from products p where p.business_id = $1 and p.id = any($2::uuid[])`, [businessId, productIds]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const store = `https://${b!.slug}.${env.ROOT_DOMAIN}`;
  const products = productIds.map((id) => byId.get(id)).filter(Boolean).map((r) => ({
    id: r!.id, name: r!.name, price_kobo: r!.price, colours: r!.colours ?? [], category: r!.category, url: `${store}/p/${r!.id}`, image: r!.image,
  }));
  return { products, shop: b!.name, slug: b!.slug, template: b!.caption_template };
}

export function defaultCaption(c: Awaited<ReturnType<typeof captionProducts>>): string {
  return c.products.length > 1
    ? renderCarouselCaption(c.products, c.shop, `https://${c.slug}.${env.ROOT_DOMAIN}`)
    : renderCaption(c.template, c.products[0]!, c.shop);
}

// ------------------------------------------------------------------------------------------
// Publishing worker
// ------------------------------------------------------------------------------------------
interface ClaimedPost { id: string; business_id: string; account_id: string; platform: SocialPlatform; product_ids: string[]; caption: string | null }

export async function publishDuePosts(limit = 10): Promise<{ published: number; waiting: number; failed: number }> {
  const out = { published: 0, waiting: 0, failed: 0 };
  const posts = await withService((tx) => many<ClaimedPost>(tx, `select * from public.claim_social_posts($1)`, [limit]));
  for (const post of posts) {
    const finish = (ok: boolean, o: { id?: string; permalink?: string | null; error?: string; retryAt?: Date; reconnect?: boolean; caption?: string } = {}) =>
      withService((tx) => tx.query(`select public.finish_social_post($1, $2, $3, $4, $5, $6, $7, $8)`,
        [post.id, ok, o.id ?? null, o.permalink ?? null, o.error ?? null, o.retryAt?.toISOString() ?? null, o.reconnect ?? false, o.caption ?? null]));
    try {
      const { account, token, info } = await withService(async (tx) => ({
        account: (await one<{ external_id: string; page_id: string }>(tx, `select external_id, page_id from social_accounts where id = $1`, [post.account_id]))!,
        token: (await one<{ t: string | null }>(tx, `select public.social_token($1) t`, [post.account_id]))?.t ?? null,
        info: await captionProducts(tx, post.business_id, post.product_ids),
      }));
      if (!token) { await finish(false, { error: 'no token', reconnect: true }); out.failed += 1; continue; }
      const images = info.products.map((p) => p.image).filter((x): x is string => !!x);
      if (images.length === 0) { await finish(false, { error: 'product_needs_photo', retryAt: new Date(Date.now() + 30 * 60_000) }); out.waiting += 1; continue; }
      const target = { platform: post.platform, externalId: account.external_id, pageId: account.page_id, token };
      const p = socialProvider();

      let quota: { used: number; total: number } | null = null;
      if (post.platform === 'instagram') {
        const q = (quota = await p.publishingLimit(target));
        await withService((tx) => tx.query(`select public.record_social_quota($1, $2, $3)`, [post.account_id, q.used, q.total]));
        if (q.used >= q.total) { await finish(false, { error: 'publishing_limit_reached', retryAt: new Date(Date.now() + 60 * 60_000) }); out.waiting += 1; continue; }
      }
      const caption = post.caption ?? defaultCaption(info);
      const r = await p.publish(target, images.map(socialImageUrl), caption);
      await finish(true, { id: r.id, permalink: r.permalink, caption });
      // keep the dashboard's "posts used today" honest without another API call
      if (quota) await withService((tx) => tx.query(`select public.record_social_quota($1, $2, $3)`, [post.account_id, quota!.used + 1, quota!.total]));
      out.published += 1;
    } catch (e) {
      const err = e instanceof SocialError ? e : new SocialError((e as Error).message, 'transient');
      if (!(e instanceof SocialError)) logError(e, { at: 'social_publish', post: post.id });
      if (err.kind === 'auth') { await finish(false, { error: err.message, reconnect: true }); out.failed += 1; }
      else if (err.kind === 'rate_limit') { await finish(false, { error: err.message, retryAt: new Date(Date.now() + err.retryAfterMs) }); out.waiting += 1; }
      else { await finish(false, { error: err.message }); out.failed += 1; }
    }
  }
  return out;
}
