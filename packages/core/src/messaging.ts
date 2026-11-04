/**
 * MessagingProvider: WhatsApp Business Cloud API (Meta) behind an interface, plus a console
 * provider for development and tests. Also renders order notifications: free-form text inside
 * Meta's 24-hour customer-service window, an approved template outside it.
 */
import { fetchWithTimeout } from './http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { formatNaira } from './money';
import type { Inbound, Outbound } from './whatsapp';

export interface SendTarget { to: string; phoneNumberId: string; token: string }
export interface TemplateMessage { name: string; language: string; params: string[] }

export interface MessagingProvider {
  readonly name: string;
  send(target: SendTarget, msg: Outbound): Promise<{ id: string }>;
  sendTemplate(target: SendTarget, tpl: TemplateMessage): Promise<{ id: string }>;
  verifySignature(rawBody: string, signatureHeader: string | null | undefined): boolean;
}

export interface ParsedWebhook {
  phoneNumberId: string;
  messages: { id: string; from: string; profileName?: string; timestamp: number; inbound: Inbound }[];
  statuses: { id: string; status: string; error?: string }[];
}

/** Meta's webhook body → messages + delivery statuses (one entry per phone number id). */
export function parseWhatsAppWebhook(body: unknown): ParsedWebhook[] {
  const out: ParsedWebhook[] = [];
  const entries = (body as { entry?: any[] })?.entry ?? [];
  for (const e of entries) {
    for (const ch of e?.changes ?? []) {
      const v = ch?.value;
      if (!v?.metadata?.phone_number_id) continue;
      const names = new Map<string, string>((v.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
      out.push({
        phoneNumberId: String(v.metadata.phone_number_id),
        messages: (v.messages ?? []).map((m: any) => ({
          id: String(m.id),
          from: `+${String(m.from).replace(/\D/g, '')}`,
          profileName: names.get(m.from),
          timestamp: Number(m.timestamp) * 1000,
          inbound: m.type === 'text' ? { kind: 'text', text: String(m.text?.body ?? '').slice(0, 1000) }
            : m.type === 'interactive' ? { kind: 'reply', id: String(m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? ''), title: m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title }
            : m.type === 'button' ? { kind: 'text', text: String(m.button?.text ?? '') }
            : { kind: 'other' },
        })),
        statuses: (v.statuses ?? []).map((s: any) => ({ id: String(s.id), status: String(s.status), error: s.errors?.[0]?.title })),
      });
    }
  }
  return out;
}

export function verifyMetaSignature(appSecret: string, rawBody: string, header: string | null | undefined): boolean {
  if (!header?.startsWith('sha256=') || !appSecret) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex')}`;
  return header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

function toGraphPayload(to: string, msg: Outbound): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: to.replace(/^\+/, '') };
  switch (msg.kind) {
    case 'text': return { ...base, type: 'text', text: { body: msg.text.slice(0, 4096), preview_url: true } };
    case 'image': return { ...base, type: 'image', image: { link: msg.url, caption: msg.caption.slice(0, 1024) } };
    case 'buttons': return {
      ...base, type: 'interactive',
      interactive: { type: 'button', body: { text: msg.text.slice(0, 1024) }, action: { buttons: msg.buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: b.id.slice(0, 256), title: b.title.slice(0, 20) } })) } },
    };
    case 'list': return {
      ...base, type: 'interactive',
      interactive: {
        type: 'list', body: { text: msg.text.slice(0, 1024) },
        action: { button: msg.button.slice(0, 20), sections: [{ title: 'Options', rows: msg.rows.slice(0, 10).map((r) => ({ id: r.id.slice(0, 200), title: r.title.slice(0, 24), description: r.description?.slice(0, 72) })) }] },
      },
    };
  }
}

export class MetaWhatsAppProvider implements MessagingProvider {
  readonly name = 'meta';
  constructor(private readonly appSecret: string, private readonly opts: { graphVersion?: string; fetch?: typeof fetch } = {}) {}

  private async post(target: SendTarget, payload: Record<string, unknown>): Promise<{ id: string }> {
    const f = fetchWithTimeout(15_000, this.opts.fetch ?? fetch);
    const res = await f(`https://graph.facebook.com/${this.opts.graphVersion ?? 'v23.0'}/${encodeURIComponent(target.phoneNumberId)}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string; code?: number } };
    if (!res.ok || !json.messages?.[0]) throw new Error(`whatsapp_send_failed:${json.error?.code ?? res.status}`);
    return { id: json.messages[0].id };
  }

  send(target: SendTarget, msg: Outbound) {
    return this.post(target, toGraphPayload(target.to, msg));
  }

  sendTemplate(target: SendTarget, tpl: TemplateMessage) {
    return this.post(target, {
      messaging_product: 'whatsapp', to: target.to.replace(/^\+/, ''), type: 'template',
      template: { name: tpl.name, language: { code: tpl.language }, components: [{ type: 'body', parameters: tpl.params.map((p) => ({ type: 'text', text: p })) }] },
    });
  }

  verifySignature(rawBody: string, header: string | null | undefined) {
    return verifyMetaSignature(this.appSecret, rawBody, header);
  }
}

/** Records everything instead of sending (dev + tests). */
export class ConsoleMessagingProvider implements MessagingProvider {
  readonly name = 'console';
  readonly sent: { to: string; msg?: Outbound; template?: TemplateMessage; id: string }[] = [];
  private n = 0;
  constructor(private readonly appSecret = 'dev-meta-app-secret', private readonly quiet = false) {}

  async send(target: SendTarget, msg: Outbound) {
    const id = `wamid.console.${++this.n}`;
    this.sent.push({ to: target.to, msg, id });
    if (!this.quiet) console.info(`[whatsapp → ${target.to.slice(0, 7)}****] ${msg.kind === 'text' || msg.kind === 'buttons' || msg.kind === 'list' ? msg.text.split('\n')[0] : msg.caption.split('\n')[0]}`);
    return { id };
  }

  async sendTemplate(target: SendTarget, template: TemplateMessage) {
    const id = `wamid.console.${++this.n}`;
    this.sent.push({ to: target.to, template, id });
    if (!this.quiet) console.info(`[whatsapp template ${template.name} → ${target.to.slice(0, 7)}****]`);
    return { id };
  }

  verifySignature(rawBody: string, header: string | null | undefined) {
    return verifyMetaSignature(this.appSecret, rawBody, header);
  }

  /** Signature header for a test/dev webhook body. */
  sign(rawBody: string): string {
    return `sha256=${createHmac('sha256', this.appSecret).update(rawBody, 'utf8').digest('hex')}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------
export type NotificationKind = 'order_placed' | 'payment_received' | 'order_confirmed' | 'packed' | 'dispatched' | 'delivered' | 'delivery_failed' | 'debt_reminder' | 'wholesale_approved';

export interface NotificationParams {
  order_number?: number; total_kobo?: number; balance_kobo?: number; received_kobo?: number; amount_paid_kobo?: number;
  shop: string; slug: string; tracking_token?: string; due_date?: string; account_number?: string; bank?: string;
  rider?: string; collect_kobo?: number; attempt?: number;
}

/**
 * Template names + body variables. Each must be created and approved in Meta Business Manager
 * (category: utility) with exactly these {{n}} variables, in this order — see README.
 */
export const TEMPLATES: Record<NotificationKind, { name: string; vars: (p: NotificationParams, trackUrl: string) => string[] }> = {
  order_placed: { name: 'trawer_order_placed', vars: (p, u) => [p.shop, String(p.order_number), formatNaira(p.total_kobo ?? 0), u] },
  payment_received: { name: 'trawer_payment_received', vars: (p, u) => [formatNaira(p.received_kobo ?? 0), String(p.order_number), p.shop, u] },
  order_confirmed: { name: 'trawer_order_confirmed', vars: (p, u) => [String(p.order_number), p.shop, formatNaira(p.balance_kobo ?? 0), u] },
  packed: { name: 'trawer_order_packed', vars: (p, u) => [String(p.order_number), p.shop, u] },
  dispatched: { name: 'trawer_order_dispatched', vars: (p, u) => [String(p.order_number), p.shop, u] },
  delivered: { name: 'trawer_order_delivered', vars: (p) => [String(p.order_number), p.shop] },
  delivery_failed: { name: 'trawer_delivery_failed', vars: (p, u) => [String(p.order_number), p.shop, u] },
  debt_reminder: { name: 'trawer_debt_reminder', vars: (p) => [p.shop, formatNaira(p.balance_kobo ?? 0), String(p.order_number), p.account_number ?? '', p.bank ?? ''] },
  wholesale_approved: { name: 'trawer_wholesale_approved', vars: (p) => [p.shop, `https://${p.slug}.trawer.shop`] },
};

export function trackingUrl(p: NotificationParams, rootDomain: string): string {
  return p.tracking_token ? `https://${rootDomain}/t/${p.tracking_token}` : `https://${p.slug}.${rootDomain}`;
}

/** Free-form text (inside the 24-hour window). Mirrors the templates' wording. */
export function notificationText(kind: NotificationKind, p: NotificationParams, trackUrl: string): string {
  const n = p.order_number;
  switch (kind) {
    case 'order_placed': return `${p.shop}: order #${n} is held for you. Pay ${formatNaira(p.total_kobo ?? 0)} to your account number to confirm it. Track it: ${trackUrl}`;
    case 'payment_received': return `${formatNaira(p.received_kobo ?? 0)} received for order #${n}. Thank you! ${p.shop} is getting it ready. Track it: ${trackUrl}`;
    case 'order_confirmed': return `Order #${n} at ${p.shop} is confirmed. Balance to pay: ${formatNaira(p.balance_kobo ?? 0)}. Track it: ${trackUrl}`;
    case 'packed': return `Order #${n} from ${p.shop} is packed and ready. Track it: ${trackUrl}`;
    case 'dispatched': return `Order #${n} from ${p.shop} is on the way${p.rider ? ` with ${p.rider}` : ''}!${p.collect_kobo ? ` Please have ${formatNaira(p.collect_kobo)} ready to pay on delivery.` : ''} Track it: ${trackUrl}`;
    case 'delivered': return `Order #${n} from ${p.shop} has been delivered. Thank you for buying!`;
    case 'delivery_failed': return `We couldn't deliver order #${n} from ${p.shop}. We'll call you to arrange it. Details: ${trackUrl}`;
    case 'debt_reminder': return `Hello from ${p.shop}. A friendly reminder: ${formatNaira(p.balance_kobo ?? 0)} is due on order #${n}. Pay to ${p.account_number} (${p.bank}). Thank you!`;
    case 'wholesale_approved': return `Good news! ${p.shop} has approved your wholesale account. Sign in to see your wholesale prices: https://${p.slug}.trawer.shop`;
  }
}

export const WINDOW_MS = 24 * 60 * 60 * 1000;
export function inServiceWindow(lastInboundAt: Date | null | undefined, now = new Date()): boolean {
  return !!lastInboundAt && now.getTime() - lastInboundAt.getTime() < WINDOW_MS - 5 * 60_000; // 5-minute safety margin
}

// ---------------------------------------------------------------------------------------------
// WhatsApp (Meta Commerce) catalogue sync — live stock + retail price per variant
// ---------------------------------------------------------------------------------------------
export interface CatalogItem {
  retailerId: string;          // variant SKU
  title: string;
  description: string;
  priceKobo: number;           // public (retail) price; tier prices are quoted in chat per buyer
  inventory: number;
  imageUrl: string | null;
  link: string;
}

export function catalogBatchRequests(items: CatalogItem[]) {
  return items.map((i) => ({
    method: 'UPDATE',
    data: {
      id: i.retailerId,
      title: i.title.slice(0, 150),
      description: (i.description || i.title).slice(0, 5000),
      availability: i.inventory > 0 ? 'in stock' : 'out of stock',
      inventory: Math.max(i.inventory, 0),
      price: `${(i.priceKobo / 100).toFixed(2)} NGN`,
      condition: 'new',
      link: i.link,
      ...(i.imageUrl ? { image_link: i.imageUrl } : {}),
    },
  }));
}

export interface CatalogSyncer {
  syncCatalog(catalogId: string, token: string, items: CatalogItem[]): Promise<void>;
}

export async function metaSyncCatalog(catalogId: string, token: string, items: CatalogItem[], opts: { graphVersion?: string; fetch?: typeof fetch } = {}): Promise<void> {
  const f = fetchWithTimeout(60_000, opts.fetch ?? fetch);
  for (let i = 0; i < items.length; i += 1000) {
    const res = await f(`https://graph.facebook.com/${opts.graphVersion ?? 'v23.0'}/${encodeURIComponent(catalogId)}/items_batch`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_type: 'PRODUCT_ITEM', requests: catalogBatchRequests(items.slice(i, i + 1000)) }),
    });
    if (!res.ok) throw new Error(`catalog_sync_failed:${res.status}`);
  }
}
