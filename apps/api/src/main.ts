import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createApp } from './app';
import { env } from './env';
import { isPublicBucket, readLocalImage } from './storage';

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
  app.use('/assets/*', serveStatic({ root, onFound: (_p, c) => c.header('Cache-Control', 'public, max-age=31536000, immutable') }));
  app.use('/*', serveStatic({ root }));
  const index = await readFile(join(root, 'index.html'), 'utf8');
  app.get('*', (c) => (c.req.path.startsWith('/api/') ? c.notFound() : c.html(index)));
}

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.info(`trawer api listening on :${info.port}`);
});
