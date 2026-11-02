/**
 * Instagram / Facebook posting.
 *   Public:    GET /api/social/callback (Facebook Login return), GET /api/social/image/<path>.jpg (what Instagram fetches)
 *   Dashboard: /api/biz/:bid/social/* (mounted from dashboard routes via `socialBizRoutes`)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { uuid } from '@trawer/core/schemas';
import { many, one, withUser } from '../db';
import { env } from '../env';
import { ApiError, body, requireUser, type AppEnv, type Ctx } from '../http';
import { logError } from '../log';
import { imageUrl } from '../storage';
import { callbackUrl, captionProducts, defaultCaption, instagramJpeg, signState, socialProvider, verifyState } from '../social';

export const socialPublicRoutes = new Hono<AppEnv>();

socialPublicRoutes.get('/callback', async (c) => {
  const claims = requireUser(c);
  const back = (bid: string | null, q: string) => c.redirect(new URL(bid ? `/dashboard/${bid}/social?${q}` : `/dashboard?${q}`, env.APP_URL).toString(), 302);
  const st = verifyState(c.req.query('state') ?? '', claims.sub!);
  if (!st) return back(null, 'connect_error=expired');
  if (c.req.query('error') || !c.req.query('code')) return back(st.businessId, 'connect_error=cancelled');
  try {
    const pages = await socialProvider().exchange(c.req.query('code')!, callbackUrl());
    if (!pages.length) return back(st.businessId, 'connect_error=no_pages');
    const sid = await withUser(claims, async (tx) => (await one<{ id: string }>(tx, `select public.begin_social_connect($1, $2::jsonb) id`, [st.businessId, JSON.stringify(pages.slice(0, 50))]))!.id);
    return back(st.businessId, `connect=${sid}`);
  } catch (e) {
    logError(e, { at: 'social_callback' });
    return back(st.businessId, 'connect_error=failed');
  }
});

socialPublicRoutes.get('/image/:path{.+\\.jpg}', async (c) => {
  const path = `${c.req.param('path').replace(/\.jpg$/, '')}.webp`;
  if (!/^[0-9a-f-]{36}\/[A-Za-z0-9_-]+\.webp$/.test(path)) throw new ApiError(404, 'not_found');
  const jpg = await instagramJpeg(path);
  if (!jpg) throw new ApiError(404, 'not_found');
  return c.body(new Uint8Array(jpg), 200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
});

// ------------------------------------------------------------------------------------------
// Dashboard
// ------------------------------------------------------------------------------------------
export const socialBizRoutes = new Hono<AppEnv>();

async function asSocialManager<T>(c: Ctx, fn: (tx: Parameters<Parameters<typeof withUser>[1]>[0], businessId: string) => Promise<T>): Promise<T> {
  const claims = requireUser(c);
  const bid = uuid.parse(c.req.param('bid'));
  return withUser(claims, async (tx) => {
    const ok = await one<{ ok: boolean }>(tx, `select app.has_permission($1, 'social.manage') ok`, [bid]);
    if (!ok?.ok) throw new ApiError(403, 'permission_denied');
    return fn(tx, bid);
  });
}

socialBizRoutes.get('/', (c) => asSocialManager(c, async (tx, b) => {
  const [accounts, posts, biz] = await Promise.all([
    many(tx, `select id, platform, name, status, quota_used, quota_total, quota_checked_at, last_error, connected_at from social_accounts where business_id = $1 order by platform`, [b]),
    many(tx, `select sp.id, sp.platform, sp.kind, sp.product_ids, sp.caption, sp.auto, sp.status, sp.scheduled_for, sp.attempts, sp.last_error, sp.permalink, sp.published_at,
                     (select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name,
                        'image', (select vi.path from variant_images vi where vi.product_id = p.id order by vi.variant_id nulls first, vi.position limit 1))
                        order by array_position(sp.product_ids, p.id)), '[]') from products p where p.id = any(sp.product_ids)) products
              from social_posts sp where sp.business_id = $1 order by coalesce(sp.published_at, sp.scheduled_for) desc limit 60`, [b]),
    one<{ caption_template: string }>(tx, `select caption_template from businesses where id = $1`, [b]),
  ]);
  for (const p of posts) for (const pr of p.products) pr.image = imageUrl(pr.image, 200);
  return c.json({ accounts, posts, template: biz!.caption_template, provider: env.SOCIAL_PROVIDER });
}));

socialBizRoutes.get('/connect', (c) => asSocialManager(c, async (_tx, b) =>
  c.json({ url: socialProvider().authorizeUrl(callbackUrl(), signState(b, requireUser(c).sub!)) })));

socialBizRoutes.get('/choices/:sid', (c) => asSocialManager(c, async (tx) => {
  const r = await one<{ c: unknown }>(tx, `select public.social_connect_choices($1) c`, [uuid.parse(c.req.param('sid'))]);
  if (!r?.c) throw new ApiError(404, 'not_found');
  return c.json({ choices: r.c });
}));

socialBizRoutes.post('/connect', async (c) => {
  const input = await body(c, z.object({ session_id: uuid, page_id: z.string().min(1).max(64) }));
  return asSocialManager(c, async (tx) => c.json((await one(tx, `select public.connect_social_account($1, $2) r`, [input.session_id, input.page_id]))!.r));
});

socialBizRoutes.post('/disconnect', async (c) => {
  const input = await body(c, z.object({ platform: z.enum(['instagram', 'facebook']) }));
  return asSocialManager(c, async (tx, b) => { await tx.query(`select public.disconnect_social_account($1, $2)`, [b, input.platform]); return c.json({ ok: true }); });
});

const productIds = z.array(uuid).min(1).max(10);

socialBizRoutes.post('/caption', async (c) => {
  const input = await body(c, z.object({ product_ids: productIds }));
  return asSocialManager(c, async (tx, b) => {
    const info = await captionProducts(tx, b, input.product_ids);
    if (!info.products.length) throw new ApiError(422, 'product_unavailable');
    return c.json({ caption: defaultCaption(info) });
  });
});

socialBizRoutes.post('/posts', async (c) => {
  const input = await body(c, z.object({
    platforms: z.array(z.enum(['instagram', 'facebook'])).min(1).max(2),
    product_ids: productIds,
    caption: z.string().trim().min(1).max(2200),
    scheduled_for: z.string().datetime({ offset: true }).optional(),
  }));
  return asSocialManager(c, async (tx, b) => {
    const ids: string[] = [];
    for (const platform of [...new Set(input.platforms)]) {
      ids.push((await one<{ id: string }>(tx, `select public.schedule_social_post($1, $2, $3::uuid[], $4, $5) id`,
        [b, platform, input.product_ids, input.caption, input.scheduled_for ?? null]))!.id);
    }
    return c.json({ ids }, 201);
  });
});

socialBizRoutes.post('/posts/:pid/cancel', (c) => asSocialManager(c, async (tx) => {
  await tx.query(`select public.cancel_social_post($1)`, [uuid.parse(c.req.param('pid'))]);
  return c.json({ ok: true });
}));
socialBizRoutes.post('/posts/:pid/retry', (c) => asSocialManager(c, async (tx) => {
  await tx.query(`select public.retry_social_post($1)`, [uuid.parse(c.req.param('pid'))]);
  return c.json({ ok: true });
}));
