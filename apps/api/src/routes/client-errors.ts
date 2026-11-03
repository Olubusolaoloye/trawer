/**
 * Browser errors → our own origin → Sentry (no third-party script in the page, CSP stays strict).
 * Anyone can post (errors happen before sign-in), so it is small, rate-limited and scrubbed.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { body, clientIp, type AppEnv } from '../http';
import { rateLimit } from '../limits';
import { logClientError } from '../log';

export const clientErrorRoutes = new Hono<AppEnv>();

const report = z.object({
  message: z.string().min(1).max(1000),
  type: z.string().max(80).optional(),
  stack: z.string().max(8000).optional(),
  url: z.string().max(500).optional(),
  release: z.string().max(60).optional(),
  component: z.string().max(200).optional(),
});

clientErrorRoutes.post('/', async (c) => {
  if (Number(c.req.header('content-length') ?? 0) > 16_384) return c.body(null, 413);
  await rateLimit('client_error', `ip:${clientIp(c)}`, 30, 600);
  const r = await body(c, report);
  // only report errors from our own pages (drop browser-extension noise)
  if (r.url && !/^https?:\/\/[^/]+\//.test(r.url)) return c.body(null, 204);
  logClientError(r);
  return c.body(null, 204);
});
