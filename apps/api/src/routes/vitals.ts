/**
 * Real-user speed tracking: each page view sends its Core Web Vitals here once (no third-party
 * script, nothing personal: page type, device class, connection type and the timings).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { withService } from '../db';
import { body, clientIp, type AppEnv } from '../http';
import { rateLimit } from '../limits';

export const vitalsRoutes = new Hono<AppEnv>();

const ms = (max: number) => z.number().min(0).max(max).transform(Math.round).optional();
const report = z.object({
  page: z.string().regex(/^[a-z_]{1,40}$/),
  ssr: z.boolean().default(false),
  mobile: z.boolean().default(true),
  connection: z.string().regex(/^[a-z0-9-]{1,10}$/).optional(),
  lcp: ms(120_000), fcp: ms(120_000), ttfb: ms(120_000), inp: ms(60_000),
  cls: z.number().min(0).max(50).optional(),
});

vitalsRoutes.post('/', async (c) => {
  if (Number(c.req.header('content-length') ?? 0) > 2_048) return c.body(null, 413);
  await rateLimit('public', `vitals:${clientIp(c)}`, 120, 600);
  const r = await body(c, report);
  if (r.lcp == null && r.fcp == null && r.ttfb == null && r.inp == null && r.cls == null) return c.body(null, 204);
  await withService((tx) => tx.query(
    `insert into web_vitals (page, ssr, mobile, connection, lcp_ms, fcp_ms, ttfb_ms, inp_ms, cls) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [r.page, r.ssr, r.mobile, r.connection ?? null, r.lcp ?? null, r.fcp ?? null, r.ttfb ?? null, r.inp ?? null, r.cls ?? null]));
  return c.body(null, 204);
});
