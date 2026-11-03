import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { HTTPException } from 'hono/http-exception';
import { randomUUID } from 'node:crypto';
import { AuthError, refreshSession, tokenExpiry, verifyAccessToken } from './auth';
import { dbErrorCode } from './db';
import { ApiError, readSessionCookies, writeSession, clearSession, type AppEnv } from './http';
import { authRoutes } from './routes/auth';
import { storeRoutes } from './routes/store';
import { orderRoutes } from './routes/orders';
import { webhookRoutes } from './routes/webhooks';
import { posRoutes } from './routes/pos';
import { whatsappWebhook } from './routes/whatsapp-webhook';
import { cronRoutes } from './routes/cron';
import { trackRoutes } from './routes/track';
import { docRoutes } from './routes/docs';
import { dashboardRoutes } from './routes/dashboard';
import { catalogRoutes } from './routes/catalog';
import { socialBizRoutes, socialPublicRoutes } from './routes/social';
import { reportRoutes } from './routes/reports';
import { meRoutes } from './routes/me';
import { clientErrorRoutes } from './routes/client-errors';
import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';
import { rateLimit } from './limits';
import { clientIp } from './http';
import type { MiddlewareHandler } from 'hono';
import { devRoutes } from './routes/dev';
import { env } from './env';
import { logError } from './log';

const publicLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  await rateLimit('public', `ip:${clientIp(c)}`, 300, 3600);
  await next();
};

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('*', secureHeaders({
    strictTransportSecurity: 'max-age=63072000; includeSubDomains',
    // Only our own store designer may frame pages (live preview); nobody else can.
    xFrameOptions: 'SAMEORIGIN',
    referrerPolicy: 'strict-origin-when-cross-origin',
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // React style attributes (brand colours)
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      fontSrc: ["'self'"], // fonts are bundled; never a third-party font host
      connectSrc: ["'self'"],
      frameSrc: ["'self'"],
      frameAncestors: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
    // Browser powers we don't use are switched off; the microphone stays for voice-note product drafts.
    permissionsPolicy: { camera: [], geolocation: [], payment: [], usb: [], microphone: ['self'] },
    crossOriginOpenerPolicy: 'same-origin',
  }));

  // Request size: 1 MB of JSON is plenty; photo uploads may be up to 12 MB.
  app.use('/api/*', async (c, next) => {
    const upload = /\/(uploads|proof|images)(\?|$)/.test(c.req.path) || c.req.path.endsWith('/proof');
    return bodyLimit({ maxSize: (upload ? 13 : 1) * 1024 * 1024, onError: (cc) => cc.json({ error: 'too_large' }, 413) })(c, next);
  });

  // Compress API JSON (not the live order stream, which must flush each event at once, nor PDFs/images).
  const gzip = compress();
  app.use('/api/*', async (c, next) => (c.req.path.endsWith('/events') || /\/(pdf|image|proof|media)\b/.test(c.req.path) ? next() : gzip(c, next)));

  // Public token pages (tracking, invoices) are unguessable; this also stops anyone hammering them.
  app.use('/api/track/*', publicLimit);
  app.use('/api/docs/*', publicLimit);

  app.use('*', async (c, next) => {
    c.set('requestId', c.req.header('x-request-id') ?? randomUUID());
    c.set('claims', null);
    c.set('session', null);
    // Cron jobs and webhooks authenticate with their own secret / signature, never a user session.
    if (c.req.path.startsWith('/api/cron/') || c.req.path.startsWith('/api/webhooks/')) return next();
    // Devices (POS) send a bearer token; browsers use httpOnly cookies.
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer) {
      try {
        c.set('claims', await verifyAccessToken(bearer));
        c.set('session', { accessToken: bearer, refreshToken: '', expiresAt: tokenExpiry(bearer) });
      } catch {
        throw new ApiError(401, 'not_authenticated');
      }
      return next();
    }
    if (c.req.path.startsWith('/api/pos/')) {
      // POS endpoints skip the CSRF check, so they must never accept ambient cookies.
      return next();
    }
    const { access, refresh } = readSessionCookies(c);
    let token = access;
    if ((!token || tokenExpiry(token) < Date.now() / 1000 + 30) && refresh) {
      try {
        const s = await refreshSession(refresh);
        writeSession(c, s);
        token = s.accessToken;
        c.set('session', s);
      } catch {
        clearSession(c);
        token = undefined;
      }
    }
    if (token) {
      try {
        c.set('claims', await verifyAccessToken(token));
        if (!c.get('session')) c.set('session', { accessToken: token, refreshToken: refresh ?? '', expiresAt: tokenExpiry(token) });
      } catch {
        clearSession(c);
      }
    }
    await next();
  });

  // CSRF: state-changing browser calls must be JSON with our header (webhooks are exempt and signed).
  app.use('/api/*', async (c, next) => {
    const m = c.req.method;
    if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS' && !c.req.path.startsWith('/api/webhooks/') && !c.req.path.startsWith('/api/cron/')
        && !c.req.path.startsWith('/api/pos/')) {
      if (c.req.header('x-trawer') !== '1') throw new ApiError(403, 'forbidden');
    }
    await next();
  });

  app.use('/api/*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
  });

  app.get('/api/health', (c) => c.json({ ok: true }));
  app.route('/api/auth', authRoutes);
  app.route('/api/store', storeRoutes);
  app.route('/api/orders', orderRoutes);
  app.route('/api/webhooks/whatsapp', whatsappWebhook);
  app.route('/api/webhooks', webhookRoutes);
  app.route('/api/cron', cronRoutes);
  app.route('/api/track', trackRoutes);
  app.route('/api/docs', docRoutes);
  app.route('/api/pos', posRoutes);
  app.route('/api/social', socialPublicRoutes);
  app.route('/api/biz/:bid/social', socialBizRoutes);
  app.route('/api/biz/:bid/reports', reportRoutes);
  app.route('/api/me', meRoutes);
  app.route('/api/client-errors', clientErrorRoutes);
  app.route('/api/biz', catalogRoutes);
  app.route('/api/biz', dashboardRoutes);
  if (env.NODE_ENV !== 'production') app.route('/api/dev', devRoutes);

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.code, details: err.details }, err.status);
    if (err instanceof AuthError) return c.json({ error: err.code }, err.status as 400);
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    const code = dbErrorCode(err);
    const status = (err as { code?: string }).code === '42501' ? 403
      : code === 'rate_limited' ? 429
      : code === 'insufficient_stock' || code === 'insufficient_allocation' || code === 'duplicate' ? 409
      : code === 'server_error' ? 500 : 422;
    if (status === 500) logError(err, { requestId: c.get('requestId'), path: c.req.path });
    const detail = code === 'insufficient_stock' ? safeJson((err as { detail?: string }).detail) : undefined;
    return c.json({ error: code, details: detail }, status);
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  return app;
}

function safeJson(s?: string) {
  try {
    return s ? JSON.parse(s) : undefined;
  } catch {
    return undefined;
  }
}
