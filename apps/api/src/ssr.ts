/**
 * Server-rendered store home pages.
 *
 * A storefront's home page (/s/:slug, or / on the shop's own subdomain) is rendered here with React
 * (apps/web/src/entry-server.tsx, built to dist-ssr), so buyers on slow phones see the shop and its
 * products in the first response instead of waiting for the app to download and fetch. The data comes
 * from our own API routes, called in-process with the visitor's cookies, so the page is exactly what
 * the browser would have built (wholesale prices for wholesale buyers). The browser then takes over
 * the same HTML with the same data, without fetching again.
 *
 * Anything unexpected (unknown shop, render error, bundle missing) falls back to the plain app shell.
 */
import { existsSync } from 'node:fs';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import type { Context, Hono } from 'hono';
import { env } from './env';
import { logError } from './log';

interface SsrBundle {
  render(url: string, data: Record<string, unknown>, subdomainSlug: string | null): string;
  productsUrl(slug: string, q: string, category: string): string;
  featuredUrl(slug: string, category: string): string;
  storeThemeVars(design: unknown, brand: string): Record<string, string>;
}

interface StoreInfo {
  business: { name: string; brand_colour: string; address: string | null; logo_url: string | null };
  design: { header: string; hero: { subtitle?: string | null; enabled?: boolean }; featured: { category: string | null }; about?: string | null } & Record<string, unknown>;
}

const RESERVED = new Set(['www', 'app', 'api', 'admin']);
const SLUG = /^[a-z0-9-]{1,63}$/;

/** Shop slug for a store subdomain ({slug}.ROOT_DOMAIN), else null. Same rule as the web app. */
export function subdomainSlug(host: string | undefined): string | null {
  const root = env.ROOT_DOMAIN.split(':')[0]!;
  const hostname = (host ?? '').split(':')[0]!.toLowerCase();
  if (!hostname.endsWith(`.${root}`)) return null;
  const sub = hostname.slice(0, -(root.length + 1));
  return sub && !sub.includes('.') && !RESERVED.has(sub) && SLUG.test(sub) ? sub : null;
}

/** Which store home (if any) this request is for. */
export function storeHomeFor(path: string, host: string | undefined): { slug: string; subdomain: boolean } | null {
  const sub = subdomainSlug(host);
  if (sub) return path === '/' ? { slug: sub, subdomain: true } : null;
  const m = /^\/s\/([a-z0-9-]{1,63})\/?$/.exec(path);
  return m ? { slug: m[1]!, subdomain: false } : null;
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
/** JSON inside <script type="application/json">: nothing in it can close the tag or run. */
export const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** Merge Set-Cookie updates (e.g. a refreshed session) into a Cookie header for the next in-process call. */
function withCookies(cookie: string, setCookies: string[]): string {
  const jar = new Map(cookie.split(/;\s*/).filter(Boolean).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)] as const));
  for (const sc of setCookies) {
    const pair = sc.split(';')[0]!;
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

const defaultBundle = () => env.WEB_SSR ?? (env.WEB_DIST ? `${env.WEB_DIST.replace(/\/$/, '')}/../dist-ssr/entry-server.js` : null);

export async function loadSsr(app: Hono<any>, indexHtml: string, file = defaultBundle()): Promise<((c: Context) => Promise<Response | null>) | null> {
  if (!file || !existsSync(file)) return null;
  const bundle = (await import(pathToFileURL(file).href)) as SsrBundle;
  if (!indexHtml.includes('<div id="root"></div>')) return null;

  return async (c) => {
    const home = storeHomeFor(c.req.path, c.req.header('host'));
    if (!home) return null;
    try {
      const url = new URL(c.req.url);
      const q = url.searchParams.get('q') ?? '';
      const category = url.searchParams.get('category') ?? '';
      const setCookies: string[] = [];
      let cookie = c.req.header('cookie') ?? '';
      const call = async (path: string) => {
        const headers: Record<string, string> = { cookie };
        for (const h of ['x-forwarded-for', 'user-agent']) { const v = c.req.header(h); if (v) headers[h] = v; }
        const res = await app.request(path, { headers });
        const sc = res.headers.getSetCookie();
        if (sc.length) { setCookies.push(...sc); cookie = withCookies(cookie, sc); }
        return res.ok ? ((await res.json()) as unknown) : null;
      };

      // Shop first: it may refresh the visitor's session, and later calls must use the new cookies.
      const storeKey = `/api/store/${home.slug}`;
      const store = (await call(storeKey)) as StoreInfo | null;
      if (!store) return null;
      const productsKey = bundle.productsUrl(home.slug, q, category);
      const featuredCat = !q && !category ? store.design.featured?.category : null;
      const featuredKey = featuredCat ? bundle.featuredUrl(home.slug, featuredCat) : null;
      const [products, featured] = await Promise.all([call(productsKey), featuredKey ? call(featuredKey) : null]);
      if (!products) return null;

      const data: Record<string, unknown> = { [storeKey]: store, [productsKey]: products, ...(featuredKey && featured ? { [featuredKey]: featured } : {}) };
      const body = bundle.render(`${url.pathname}${url.search}`, data, home.subdomain ? home.slug : null);

      const b = store.business;
      const vars = bundle.storeThemeVars(store.design, b.brand_colour);
      const style = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
      const description = (store.design.hero?.subtitle || store.design.about || `Order from ${b.name} on Trawer`).slice(0, 200);
      const page = indexHtml
        .replace('<html lang="en">', `<html lang="en" data-ssr data-store-theme="${escHtml(String(store.design.theme ?? ''))}" style="${escHtml(style)}">`)
        .replace(/<title>[^<]*<\/title>/, `<title>${escHtml(b.name)}</title>\n    <meta property="og:title" content="${escHtml(b.name)}" />\n    <meta property="og:description" content="${escHtml(description)}" />${b.logo_url ? `\n    <meta property="og:image" content="${escHtml(b.logo_url)}" />` : ''}`)
        .replace(/<meta name="description" content="[^"]*"/, `<meta name="description" content="${escHtml(description)}"`)
        .replace(/<meta name="theme-color" content="[^"]*"/, `<meta name="theme-color" content="${escHtml(store.design.header === 'brand' ? b.brand_colour : vars['--color-paper'] ?? '#F7F5EF')}"`)
        .replace('<div id="root"></div>', `<div id="root">${body}</div>\n    <script type="application/json" id="ssr-data">${safeJson(data)}</script>`);

      const accept = c.req.header('accept-encoding') ?? '';
      const raw = Buffer.from(page);
      const [bytes, enc] = /\bbr\b/.test(accept)
        ? [brotliCompressSync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5 } }), 'br']
        : /\bgzip\b/.test(accept) ? [gzipSync(raw, { level: 6 }), 'gzip'] : [raw, null];
      const res = c.body(new Uint8Array(bytes), 200, {
        'Content-Type': 'text/html; charset=utf-8',
        // Personal (prices depend on who is signed in): never stored by shared caches.
        'Cache-Control': 'private, no-cache',
        Vary: 'Accept-Encoding, Cookie',
        ...(enc ? { 'Content-Encoding': enc } : {}),
      });
      // The outer request may already have refreshed the session (same tokens): send each cookie once.
      const name = (sc: string) => sc.slice(0, sc.indexOf('='));
      const sent = new Set(res.headers.getSetCookie().map(name));
      for (const sc of setCookies) if (!sent.has(name(sc))) { sent.add(name(sc)); res.headers.append('Set-Cookie', sc); }
      return res;
    } catch (err) {
      logError(err, { at: 'ssr', path: c.req.path });
      return null;
    }
  };
}
