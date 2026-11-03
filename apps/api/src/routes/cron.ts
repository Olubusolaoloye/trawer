/**
 * Scheduled jobs, called by pg_cron + pg_net (Supabase) or any scheduler:
 *   POST /api/cron/<job>   Authorization: Bearer <CRON_SECRET>
 */
import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { inServiceWindow, notificationText, TEMPLATES, type NotificationKind, type NotificationParams } from '@trawer/core/messaging';
import { many, one, withService } from '../db';
import { env } from '../env';
import { ApiError, type AppEnv } from '../http';
import { logError } from '../log';
import { messagingProvider, sendTarget, trackingLink } from '../whatsapp';
import { syncWhatsAppCatalogs } from '../catalog';
import { publishDuePosts } from '../social';

export const cronRoutes = new Hono<AppEnv>();

cronRoutes.use('*', async (c, next) => {
  const got = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const want = env.CRON_SECRET;
  if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want))) throw new ApiError(401, 'not_authenticated');
  await next();
});

cronRoutes.post('/expire-reservations', async (c) => {
  const n = await withService(async (tx) => (await one<{ n: number }>(tx, `select public.expire_reservations(500) n`))!.n);
  return c.json({ expired: n });
});

cronRoutes.post('/notifications', async (c) => c.json(await drainNotifications()));
/** Daily (≈09:00 Africa/Lagos): queue debt reminders, then send them. */
cronRoutes.post('/debt-reminders', async (c) => {
  const queued = await withService(async (tx) => (await one<{ n: number }>(tx, `select public.schedule_debt_reminders() n`))!.n);
  return c.json({ queued, ...(await drainNotifications(200)) });
});
cronRoutes.post('/whatsapp-catalog', async (c) => c.json(await syncWhatsAppCatalogs()));
/** Daily: NDPA retention (anonymise long-inactive customers, prune old message logs). */
cronRoutes.post('/retention', async (c) => c.json(await withService(async (tx) => (await one<{ r: unknown }>(tx, `select public.apply_retention() r`))!.r)));
/** Every minute: publish due Instagram/Facebook posts. */
cronRoutes.post('/social', async (c) => c.json(await publishDuePosts()));

/** Send due notifications: free text inside the 24-hour window, approved template outside it. */
export async function drainNotifications(limit = 50): Promise<{ sent: number; failed: number }> {
  const batch = await withService((tx) => many(tx, `select * from public.claim_notifications($1)`, [limit]));
  let sent = 0;
  let failed = 0;
  for (const n of batch) {
    try {
      const target = await withService((tx) => sendTarget(tx, n.business_id, n.to_phone));
      if (!target) throw new Error('whatsapp_not_connected');
      const session = await withService((tx) => one<{ last_inbound_at: string | null }>(tx,
        `select last_inbound_at from whatsapp_sessions where business_id = $1 and wa_phone = $2`, [n.business_id, n.to_phone]));
      const params = n.params as NotificationParams;
      if (n.kind === 'debt_reminder' && !params.account_number) {
        const va = await withService((tx) => one(tx, `select account_number, bank_name from virtual_accounts where customer_id = $1 and status = 'active' limit 1`, [n.customer_id]));
        if (va) Object.assign(params, { account_number: va.account_number, bank: va.bank_name });
      }
      const url = params.tracking_token ? trackingLink(params.tracking_token) : `https://${params.slug}.${env.ROOT_DOMAIN}`;
      const kind = n.kind as NotificationKind;
      const inWindow = inServiceWindow(session?.last_inbound_at ? new Date(session.last_inbound_at) : null);
      const res = inWindow
        ? await messagingProvider().send(target, { kind: 'text', text: notificationText(kind, params, url) })
        : await messagingProvider().sendTemplate(target, { name: TEMPLATES[kind].name, language: 'en', params: TEMPLATES[kind].vars(params, url) });
      await withService((tx) => tx.query(`select public.finish_notification($1, true, $2, null, $3)`, [n.id, res.id, !inWindow]));
      sent += 1;
    } catch (err) {
      failed += 1;
      await withService((tx) => tx.query(`select public.finish_notification($1, false, null, $2, null)`, [n.id, (err as Error).message])).catch(() => undefined);
      if ((err as Error).message !== 'whatsapp_not_connected') logError(err, { job: 'notifications' });
    }
  }
  return { sent, failed };
}
