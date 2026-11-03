import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'node:fs/promises';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { createApp } from './app';
import { env } from './env';
import { isPublicBucket, readLocalImage } from './storage';
import { loadSsr } from './ssr';

const app = createApp();

// Local storage driver: serve resized WebP product images.
app.get('/media/:bucket/*', async (c) => {
  const bucket = c.req.param('bucket');
  if (!isPublicBucket(bucket)) return c.notFound();
  const path = c.req.path.replace(`/media/${bucket}/`, '');
  const img = await readLocalImage(bucket, decodeURIComponent(path), Number(c.req.query('w') ?? 640));
  if (!img) return c.notFound();
  return c.body(new Uint8Array(img), 200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable' });
});

// Production: serve the built SPA from the same origin (cookies + no CORS).
if (env.WEB_DIST) {
  const root = resolve(env.WEB_DIST);
  // Never serve source maps or dotfiles even if a build left some behind.
  app.use('*', async (c, next) => (/\.map$|\/\./.test(c.req.path) ? c.notFound() : next()));
  // Pre-compressed (brotli/gzip) copies are made at build time; served by Accept-Encoding.
  app.use('/assets/*', serveStatic({ root, precompressed: true, onFound: (_p, c) => { c.header('Cache-Control', 'public, max-age=31536000, immutable'); c.header('Vary', 'Accept-Encoding'); } }));
  app.use('/*', serveStatic({ root, precompressed: true }));
  const index = await readFile(join(root, 'index.html'));
  const indexBr = brotliCompressSync(index);
  const indexGz = gzipSync(index);
  // Store home pages are server-rendered (falls back to the app shell below if anything is off).
  const ssr = await loadSsr(app, index.toString('utf8'));
  console.info(ssr ? 'store home pages: server-rendered' : 'store home pages: app shell (no SSR bundle)');
  app.get('*', async (c) => {
    // Unknown API routes and missing build files are real 404s (never the HTML page, which would
    // break a browser loading an old script after a deploy).
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/assets/')) return c.notFound();
    const rendered = ssr ? await ssr(c) : null;
    if (rendered) return rendered;
    const accept = c.req.header('accept-encoding') ?? '';
    const [bytes, enc] = /\bbr\b/.test(accept) ? [indexBr, 'br'] : /\bgzip\b/.test(accept) ? [indexGz, 'gzip'] : [index, null];
    return c.body(new Uint8Array(bytes), 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding', ...(enc ? { 'Content-Encoding': enc } : {}) });
  });
}

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.info(`trawer api listening on :${info.port}`);
});
