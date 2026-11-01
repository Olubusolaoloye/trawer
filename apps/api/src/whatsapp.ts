/**
 * Server side of the WhatsApp channel: provider selection, per-business send target, and the
 * bot's data access (BotDeps) bound to one business + one customer. Runs with the service role,
 * so EVERY query below is explicitly scoped by business_id.
 */
import { ConsoleMessagingProvider, MetaWhatsAppProvider, type MessagingProvider, type SendTarget } from '@trawer/core/messaging';
import type { BotDeps, BotProduct } from '@trawer/core/whatsapp';
import { env } from './env';
import { many, one, withService, type Tx } from './db';
import { imageUrl } from './storage';
import { ensureVirtualAccount } from './payments';

let provider: MessagingProvider | null = null;
export function messagingProvider(): MessagingProvider {
  provider ??= env.MESSAGING_PROVIDER === 'meta'
    ? new MetaWhatsAppProvider(env.META_APP_SECRET ?? '', { graphVersion: env.META_GRAPH_VERSION })
    : new ConsoleMessagingProvider(env.META_APP_SECRET ?? 'dev-meta-app-secret', env.NODE_ENV === 'test');
  return provider;
}
export function setMessagingProvider(p: MessagingProvider): void {
  provider = p;
}

/** Where to send for this business: its own number + Vault token, else the platform defaults. */
export async function sendTarget(tx: Tx, businessId: string, to: string): Promise<SendTarget | null> {
  const b = await one<{ phone_number_id: string | null; token: string | null }>(tx,
    `select whatsapp_phone_number_id phone_number_id, public.whatsapp_token(id) token from businesses where id = $1`, [businessId]);
  const phoneNumberId = b?.phone_number_id ?? env.WHATSAPP_PHONE_NUMBER_ID;
  const token = b?.token ?? env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || (!token && env.MESSAGING_PROVIDER === 'meta')) return null;
  return { to, phoneNumberId, token: token ?? 'console' };
}

export function absoluteUrl(path: string | null): string | null {
  if (!path) return null;
  return /^https?:\/\//.test(path) ? path : new URL(path, env.APP_URL).toString();
}

export function trackingLink(token: string): string {
  return new URL(`/t/${token}`, env.APP_URL).toString();
}

const PAGE = 8;

export function botDeps(ctx: { businessId: string; customerId: string; sessionId: string; shop: { name: string; slug: string }; customer: { name: string; isWholesale: boolean } }): BotDeps {
  const b = ctx.businessId;
  const c = ctx.customerId;
  const q = <T>(fn: (tx: Tx) => Promise<T>) => withService(fn);

  async function openCart(tx: Tx): Promise<string> {
    const existing = await one<{ id: string }>(tx, `select id from carts where business_id = $1 and customer_id = $2 and channel = 'whatsapp' and status = 'open' order by created_at desc limit 1`, [b, c]);
    if (existing) return existing.id;
    return (await one<{ id: string }>(tx, `insert into carts (business_id, customer_id, channel) values ($1, $2, 'whatsapp') returning id`, [b, c]))!.id;
  }

  async function cartLines(tx: Tx) {
    return many(tx, `
      with items as (
        select ci.variant_id, ci.unit_id, ci.unit_qty, pu.factor, p.name, nullif(concat_ws(' / ', v.colour, v.size), '') label,
               case when ci.unit_qty = 1 then u.name else u.plural end unit_name
        from carts ct join cart_items ci on ci.cart_id = ct.id
        join product_variants v on v.id = ci.variant_id and v.business_id = $1
        join products p on p.id = v.product_id and p.status = 'active'
        join product_units pu on pu.product_id = p.id and pu.unit_id = ci.unit_id
        join units u on u.id = ci.unit_id
        where ct.business_id = $1 and ct.customer_id = $2 and ct.channel = 'whatsapp' and ct.status = 'open'),
      totals as (select variant_id, sum(unit_qty * factor)::int base from items group by 1)
      select i.*, (public.resolve_price(i.variant_id, $2, t.base, 'whatsapp')).unit_price_kobo price
      from items i join totals t using (variant_id) order by i.name`, [b, c]);
  }

  return {
    shop: { name: ctx.shop.name, storeUrl: `https://${ctx.shop.slug}.${env.ROOT_DOMAIN}` },
    customer: ctx.customer,

    categories: () => q((tx) => many(tx, `select category as name, count(*)::int n from products where business_id = $1 and status = 'active' and category is not null group by 1 order by 2 desc limit 9`, [b])),

    search: (query, offset) => q(async (tx) => {
      const rows = await many(tx, `
        select p.id, p.name,
          (select min((public.resolve_price(v.id, $5, 1, 'whatsapp')).unit_price_kobo) from product_variants v where v.product_id = p.id and v.is_active) price,
          exists (select 1 from product_variants v join stock_levels sl on sl.variant_id = v.id where v.product_id = p.id and v.is_active and sl.available > 0) in_stock
        from products p
        where p.business_id = $1 and p.status = 'active'
          and ($2::text is null or p.search @@ websearch_to_tsquery('simple', $2) or p.name ilike '%' || $2 || '%')
          and ($3::text is null or p.category = $3)
        order by (p.name ilike $2 || '%') desc nulls last, p.created_at desc
        limit ${PAGE + 1} offset $4`, [b, query.text ?? null, query.category ?? null, offset, c]);
      return { items: rows.slice(0, PAGE).map((r) => ({ productId: r.id, name: r.name, fromPriceKobo: r.price ?? 0, inStock: r.in_stock })), more: rows.length > PAGE };
    }),

    product: (productId) => q(async (tx): Promise<BotProduct | null> => {
      const p = await one(tx, `select id, name from products where id = $1 and business_id = $2 and status = 'active'`, [productId, b]);
      if (!p) return null;
      const [variants, units, img] = await Promise.all([
        many(tx, `select v.id, nullif(concat_ws(' / ', v.colour, v.size), '') label,
                         (public.resolve_price(v.id, $2, 1, 'whatsapp')).unit_price_kobo price,
                         coalesce((select sum(available) from stock_levels where variant_id = v.id), 0)::int available
                  from product_variants v where v.product_id = $1 and v.is_active order by v.position`, [productId, c]),
        many(tx, `select pu.unit_id, u.name, u.plural, pu.factor, pu.is_base from product_units pu join units u on u.id = pu.unit_id
                  where pu.product_id = $1 and pu.sellable order by pu.factor`, [productId]),
        one(tx, `select path from variant_images where product_id = $1 order by variant_id nulls first, position limit 1`, [productId]),
      ]);
      return {
        id: p.id, name: p.name, image: absoluteUrl(imageUrl(img?.path, 960)),
        variants: variants.map((v) => ({ id: v.id, label: v.label, priceKobo: v.price, available: v.available })),
        units: units.map((u) => ({ unitId: u.unit_id, name: u.name, plural: u.plural, factor: u.factor, isBase: u.is_base })),
      };
    }),

    cart: () => q(async (tx) => {
      const lines = await cartLines(tx);
      const out = lines.map((l) => ({ name: l.name, label: l.label, qty: l.unit_qty, unitName: l.unit_name, lineTotalKobo: l.price * l.unit_qty * l.factor }));
      return { lines: out, totalKobo: out.reduce((s, l) => s + l.lineTotalKobo, 0) };
    }),

    addToCart: (variantId, unitId, qty) => q(async (tx) => {
      const ok = await one(tx, `select 1 from product_variants where id = $1 and business_id = $2`, [variantId, b]);
      if (!ok) throw new Error('unknown_variant');
      const cart = await openCart(tx);
      await tx.query(`insert into cart_items (business_id, cart_id, variant_id, unit_id, unit_qty) values ($1, $2, $3, $4, $5)
                      on conflict (cart_id, variant_id, unit_id) do update set unit_qty = cart_items.unit_qty + excluded.unit_qty`, [b, cart, variantId, unitId, qty]);
    }),

    clearCart: () => q(async (tx) => {
      await tx.query(`update carts set status = 'abandoned' where business_id = $1 and customer_id = $2 and channel = 'whatsapp' and status = 'open'`, [b, c]);
    }),

    checkout: async (input) => {
      const placed = await q(async (tx) => {
        const lines = await cartLines(tx);
        if (!lines.length) throw new Error('empty_cart');
        const r = await one<{ o: any }>(tx, `select public.place_order($1::jsonb) o`, [JSON.stringify({
          business_id: b, channel: 'whatsapp', customer_id: c,
          items: lines.map((l) => ({ variant_id: l.variant_id, unit_id: l.unit_id, qty: l.unit_qty })),
          delivery_method: input.method,
          delivery_address: input.method === 'delivery' ? { line1: input.address, source: 'whatsapp' } : undefined,
        })]);
        await tx.query(`update carts set status = 'converted', order_id = $3 where business_id = $1 and customer_id = $2 and channel = 'whatsapp' and status = 'open'`, [b, c, r!.o.id]);
        const biz = await one<{ reservation_minutes: number }>(tx, `select reservation_minutes from businesses where id = $1`, [b]);
        return { order: r!.o, holdMinutes: biz!.reservation_minutes };
      });
      const account = await ensureVirtualAccount(c);
      return {
        orderNumber: placed.order.order_number, totalKobo: placed.order.total_kobo, holdMinutes: placed.holdMinutes,
        account: { number: account.account_number, bank: account.bank_name, name: account.account_name },
        trackingUrl: trackingLink(placed.order.tracking_token),
      };
    },

    recentOrders: () => q(async (tx) => {
      const rows = await many(tx, `select order_number, status, payment_status, fulfilment_status, total_kobo, balance_kobo, tracking_token
                                   from orders where business_id = $1 and customer_id = $2 order by created_at desc limit 5`, [b, c]);
      const label = (o: any) => (o.status === 'pending' ? 'Waiting for payment' : o.status === 'cancelled' || o.status === 'expired' ? 'Cancelled'
        : ({ confirmed: 'Confirmed', packed: 'Packed', dispatched: 'On the way', delivered: 'Delivered', collected: 'Collected', failed: 'Delivery failed', returned: 'Returned', unfulfilled: 'Confirmed' } as Record<string, string>)[o.fulfilment_status] ?? 'Confirmed');
      return rows.map((o) => ({ orderNumber: o.order_number, statusText: label(o), totalKobo: o.total_kobo, balanceKobo: o.status === 'pending' ? 0 : o.balance_kobo, trackingUrl: trackingLink(o.tracking_token) }));
    }),

    requestHuman: () => q(async (tx) => {
      await tx.query(`update whatsapp_sessions set human_handoff_at = now() where id = $1 and business_id = $2`, [ctx.sessionId, b]);
    }),
  };
}
