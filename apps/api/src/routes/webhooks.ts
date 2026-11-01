import { Hono } from 'hono';
import { one, withService } from '../db';
import type { AppEnv } from '../http';
import { paymentProvider } from '../payments';
import { logError } from '../log';

export const webhookRoutes = new Hono<AppEnv>();

/**
 * Store every signed event exactly once (unique provider + event id), then process it.
 * Returns 200 for duplicates and for events we ignore so the provider stops retrying;
 * 401 for bad signatures; 500 when processing fails (provider retries; we process once).
 */
webhookRoutes.post('/paystack', async (c) => {
  const raw = await c.req.text();
  const provider = paymentProvider();
  const valid = provider.verifySignature(raw, c.req.raw.headers);
  if (!valid) return c.json({ error: 'invalid_signature' }, 401);
  let evt;
  try {
    evt = provider.parseEvent(raw);
  } catch {
    return c.json({ error: 'invalid_payload' }, 400);
  }
  const stored = await withService((tx) => one<{ id: string; processed_at: string | null }>(tx,
    `insert into webhook_events (provider, event_id, event_type, payload, signature_valid)
     values ($1, $2, $3, $4, true)
     on conflict (provider, event_id) do update set attempts = webhook_events.attempts + 1
     returning id, processed_at`, ['paystack', evt.eventId, evt.type, raw]));
  if (stored!.processed_at) return c.json({ ok: true, duplicate: true });

  try {
    await withService(async (tx) => {
      // Lock the event row so two concurrent deliveries cannot both process it.
      const row = await one(tx, `select processed_at from webhook_events where id = $1 for update`, [stored!.id]);
      if (row?.processed_at) return;
      let businessId: string | null = null;
      if (evt.type === 'payment.received' && evt.accountNumber && evt.amountKobo && evt.reference) {
        const res = await one<{ r: { business_id: string } }>(tx,
          `select public.apply_virtual_account_payment($1, $2, $3, $4, $5, null) as r`,
          [provider.name, evt.accountNumber, evt.amountKobo, evt.reference, evt.paidAt ?? new Date().toISOString()]);
        businessId = res?.r.business_id ?? null;
      } else if (evt.type === 'account.assigned' && evt.customerCode && evt.account?.accountNumber) {
        await tx.query(`update virtual_accounts set account_number = $2, account_name = $3, bank_name = $4, status = 'active'
                        where provider = $5 and provider_customer_code = $1`,
          [evt.customerCode, evt.account.accountNumber, evt.account.accountName, evt.account.bankName, provider.name]);
      }
      await tx.query(`update webhook_events set processed_at = now(), business_id = $2, last_error = null where id = $1`, [stored!.id, businessId]);
    });
  } catch (err) {
    await withService((tx) => tx.query(`update webhook_events set last_error = left($2, 500) where id = $1`, [stored!.id, (err as Error).message]));
    logError(err, { webhook: 'paystack', eventId: evt.eventId });
    return c.json({ error: 'processing_failed' }, 500);
  }
  return c.json({ ok: true });
});
