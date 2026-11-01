import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { parseWhatsAppWebhook, type ParsedWebhook } from '@trawer/core/messaging';
import { handleMessage, idle, type BotState, type Outbound } from '@trawer/core/whatsapp';
import { many, one, withService } from '../db';
import { env } from '../env';
import type { AppEnv } from '../http';
import { logError } from '../log';
import { botDeps, messagingProvider, sendTarget } from '../whatsapp';

export const whatsappWebhook = new Hono<AppEnv>();

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Meta's subscription handshake. */
whatsappWebhook.get('/', (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token') ?? '';
  const challenge = c.req.query('hub.challenge') ?? '';
  if (mode === 'subscribe' && env.META_WEBHOOK_VERIFY_TOKEN && same(token, env.META_WEBHOOK_VERIFY_TOKEN)) return c.text(challenge);
  return c.body(null, 403);
});

whatsappWebhook.post('/', async (c) => {
  const raw = await c.req.text();
  if (!messagingProvider().verifySignature(raw, c.req.header('x-hub-signature-256'))) return c.body(null, 401);
  let parsed: ParsedWebhook[];
  try {
    parsed = parseWhatsAppWebhook(JSON.parse(raw));
  } catch {
    return c.body(null, 400);
  }
  for (const batch of parsed) {
    for (const s of batch.statuses) {
      await withService((tx) => tx.query(`select public.notification_receipt($1, $2, $3)`, [s.id, s.status, s.error ?? null])).catch((e) => logError(e, { webhook: 'whatsapp-status' }));
    }
    for (const m of batch.messages) {
      // Store once; a redelivery of the same message id is ignored.
      const fresh = await withService((tx) => one(tx,
        `insert into webhook_events (provider, event_id, event_type, payload, signature_valid) values ('whatsapp', $1, 'message', $2, true)
         on conflict (provider, event_id) do nothing returning id`, [m.id, JSON.stringify({ phoneNumberId: batch.phoneNumberId, ...m })]));
      if (!fresh) continue;
      try {
        await handleInbound(batch.phoneNumberId, m);
        await withService((tx) => tx.query(`update webhook_events set processed_at = now() where id = $1`, [fresh.id]));
      } catch (err) {
        logError(err, { webhook: 'whatsapp' });
        await withService((tx) => tx.query(`update webhook_events set last_error = left($2, 500) where id = $1`, [fresh.id, (err as Error).message]));
      }
    }
  }
  return c.json({ ok: true }); // always 200 for valid signatures so Meta does not retry storms
});

export async function handleInbound(phoneNumberId: string, m: ParsedWebhook['messages'][number]): Promise<Outbound[]> {
  const ctx = await withService(async (tx) => {
    const biz = await one<{ id: string; name: string; slug: string }>(tx,
      `select id, name, slug::text from businesses where whatsapp_phone_number_id = $1 and status = 'active'`, [phoneNumberId]);
    if (!biz) return null;
    await tx.query(`select public.check_rate_limit('wa_inbound', $1, 60, 3600)`, [`${biz.id}:${m.from}`]);
    // The buyer is identified by their WhatsApp number; first contact creates a retail customer.
    let cust = await one<{ id: string; name: string; is_wholesale: boolean }>(tx,
      `select c.id, c.name, coalesce(t.is_wholesale and c.wholesale_status = 'approved', false) is_wholesale
       from customers c left join customer_tiers t on t.id = c.tier_id where c.business_id = $1 and c.phone = app.normalize_phone($2)`, [biz.id, m.from]);
    if (!cust) {
      cust = await one(tx, `insert into customers (business_id, phone, name, buyer_type) values ($1, $2, $3, 'retail_buyer')
                            returning id, name, false as is_wholesale`, [biz.id, m.from, (m.profileName ?? '').slice(0, 120)]);
    }
    const session = await one<{ id: string; state: BotState; human_handoff_at: string | null }>(tx,
      `insert into whatsapp_sessions (business_id, wa_phone, customer_id, profile_name, last_inbound_at)
       values ($1, app.normalize_phone($2), $3, $4, now())
       on conflict (business_id, wa_phone) do update set last_inbound_at = now(), customer_id = excluded.customer_id,
         profile_name = coalesce(excluded.profile_name, whatsapp_sessions.profile_name)
       returning id, state, human_handoff_at`, [biz.id, m.from, cust!.id, m.profileName ?? null]);
    return { biz, cust: cust!, session: session! };
  });
  if (!ctx) return [];

  const { biz, cust, session } = ctx;
  // A person from the shop is handling this chat: stay quiet for 12 hours unless the buyer asks for the menu.
  const handoffActive = session.human_handoff_at && Date.now() - new Date(session.human_handoff_at).getTime() < 12 * 3600_000;
  const wantsMenu = m.inbound.kind === 'text' && /^\s*(menu|start)\s*$/i.test(m.inbound.text);
  if (handoffActive && !wantsMenu) return [];

  const deps = botDeps({ businessId: biz.id, customerId: cust.id, sessionId: session.id, shop: biz, customer: { name: cust.name, isWholesale: cust.is_wholesale } });
  let result: { state: BotState; replies: Outbound[] };
  try {
    result = await handleMessage(Object.keys(session.state ?? {}).length ? session.state : idle(), m.inbound, deps);
  } catch (err) {
    const code = (err as { message?: string }).message;
    result = {
      state: idle(),
      replies: [{ kind: 'text', text: code === 'insufficient_stock'
        ? 'Sorry, some items just sold out. Type "cart" to check your cart and try again.'
        : 'Sorry, something went wrong on our side. Please try again, or type "agent" to talk to the shop.' }],
    };
    if (code !== 'insufficient_stock') logError(err, { bot: biz.id });
  }
  await withService((tx) => tx.query(
    `update whatsapp_sessions set state = $2, human_handoff_at = case when $3 then null else human_handoff_at end where id = $1`,
    [session.id, JSON.stringify(result.state), wantsMenu]));

  const target = await withService((tx) => sendTarget(tx, biz.id, m.from));
  if (target) for (const r of result.replies) await messagingProvider().send(target, r);
  return result.replies;
}

export async function listHandoffs(businessId: string) {
  return withService((tx) => many(tx, `select id, wa_phone, profile_name, human_handoff_at from whatsapp_sessions
                                       where business_id = $1 and human_handoff_at > now() - interval '12 hours' order by human_handoff_at desc`, [businessId]));
}
