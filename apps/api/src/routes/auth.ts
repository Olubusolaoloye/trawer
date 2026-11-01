import { Hono } from 'hono';
import { z } from 'zod';
import { otpSchema, phoneSchema } from '@trawer/core/schemas';
import { enrollTotp, requestOtp, verifyAccessToken, verifyOtp, verifyTotp } from '../auth';
import { many, withUser } from '../db';
import { ApiError, body, clearSession, clientIp, requireUser, writeSession, type AppEnv } from '../http';

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/otp', async (c) => {
  const { phone } = await body(c, z.object({ phone: phoneSchema }));
  await requestOtp(phone, clientIp(c));
  return c.json({ sent: true });
});

authRoutes.post('/verify', async (c) => {
  const { phone, code } = await body(c, z.object({ phone: phoneSchema, code: otpSchema }));
  const session = await verifyOtp(phone, code);
  writeSession(c, session);
  const claims = await verifyAccessToken(session.accessToken);
  // Link pending staff invites to this phone and audit staff logins.
  const staffOf = await withUser(claims, (tx) => many(tx, `select * from public.staff_sign_in() as business_id`));
  return c.json({ user: { id: claims.sub, phone: claims.phone, aal: claims.aal }, staffBusinessIds: staffOf.map((r) => r.business_id) });
});

authRoutes.post('/sign-out', (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

authRoutes.get('/me', async (c) => {
  const claims = c.get('claims');
  if (!claims) return c.json({ user: null, staff: [], customers: [] });
  const [staff, customers] = await withUser(claims, (tx) => Promise.all([
    many(tx, `select s.business_id, s.role, b.name, b.slug, b.brand_colour, b.onboarding_completed_at
              from staff_members s join businesses b on b.id = s.business_id
              where s.user_id = auth.uid() and s.status = 'active' order by b.name`),
    many(tx, `select c.id, c.business_id, c.buyer_type, c.wholesale_status, c.name from customers c where c.user_id = auth.uid()`),
  ]));
  return c.json({ user: { id: claims.sub, phone: claims.phone, aal: claims.aal }, staff, customers });
});

authRoutes.post('/mfa/enroll', async (c) => {
  requireUser(c);
  const s = c.get('session');
  if (!s) throw new ApiError(401, 'not_authenticated');
  return c.json(await enrollTotp(s));
});

authRoutes.post('/mfa/verify', async (c) => {
  requireUser(c);
  const s = c.get('session');
  if (!s) throw new ApiError(401, 'not_authenticated');
  const { factorId, code } = await body(c, z.object({ factorId: z.string().min(1).max(100), code: otpSchema }));
  const next = await verifyTotp(s, factorId, code);
  writeSession(c, next);
  return c.json({ aal: 'aal2' });
});
