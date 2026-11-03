/**
 * NDPA data-subject rights for the signed-in person (buyers; staff accounts must leave their
 * shops before deleting): see/export their data, set consent, delete the account.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { otpSchema, uuid } from '@trawer/core/schemas';
import { verifyOtp } from '../auth';
import { many, one, withUser } from '../db';
import { ApiError, body, clearSession, requireUser, type AppEnv } from '../http';
import { limitUserAndIp } from '../limits';
import { AuthError } from '../auth';

export const meRoutes = new Hono<AppEnv>();

/** Download everything we hold about you (JSON file). */
meRoutes.get('/export', async (c) => {
  const claims = requireUser(c);
  await limitUserAndIp(c, 'privacy', claims.sub!, 10, 30);
  const data = await withUser(claims, (tx) => one<{ d: unknown }>(tx, `select public.my_data_export() d`));
  return c.body(JSON.stringify(data!.d, null, 2), 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="trawer-my-data-${new Date().toISOString().slice(0, 10)}.json"`,
    'Cache-Control': 'no-store',
  });
});

/** Shops you buy from and your current choices (newest record per shop + kind wins). */
meRoutes.get('/privacy', async (c) => {
  const claims = requireUser(c);
  const rows = await withUser(claims, (tx) => many(tx, `
    select b.id business_id, b.name shop,
      coalesce((select k.granted from consents k where k.user_id = auth.uid() and k.kind = 'marketing' and (k.business_id = b.id or k.business_id is null) order by k.created_at desc limit 1), false) marketing,
      coalesce((select k.granted from consents k where k.user_id = auth.uid() and k.kind = 'whatsapp_updates' and (k.business_id = b.id or k.business_id is null) order by k.created_at desc limit 1), true) whatsapp_updates,
      coalesce((select sum(o.balance_kobo) from orders o where o.customer_id = cu.id and o.status in ('confirmed', 'completed') and o.balance_kobo > 0), 0) owing_kobo
    from customers cu join businesses b on b.id = cu.business_id where cu.user_id = auth.uid() order by b.name`));
  return c.json({ shops: rows });
});

meRoutes.post('/consent', async (c) => {
  const claims = requireUser(c);
  const input = await body(c, z.object({ business_id: uuid.nullable(), kind: z.enum(['marketing', 'whatsapp_updates']), granted: z.boolean() }));
  await withUser(claims, (tx) => tx.query(`select public.set_my_consent($1, $2, $3)`, [input.business_id, input.kind, input.granted]));
  return c.json({ ok: true });
});

/**
 * Delete my account. Irreversible, so it needs a fresh one-time code sent to the account's own
 * phone (request it with POST /api/auth/otp first) and the word DELETE.
 */
meRoutes.post('/delete', async (c) => {
  const claims = requireUser(c);
  const input = await body(c, z.object({ code: otpSchema, confirm: z.literal('DELETE') }));
  await limitUserAndIp(c, 'privacy', claims.sub!, 5, 30);
  if (!claims.phone) throw new ApiError(400, 'reauth_required');
  try {
    await verifyOtp(claims.phone, input.code);
  } catch (e) {
    if (e instanceof AuthError) throw new ApiError(401, 'invalid_code');
    throw e;
  }
  const r = await withUser(claims, (tx) => one<{ r: unknown }>(tx, `select public.delete_my_account('DELETE') r`));
  clearSession(c);
  return c.json(r!.r);
});
