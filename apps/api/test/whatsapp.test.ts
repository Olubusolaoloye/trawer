import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ConsoleMessagingProvider } from '@trawer/core/messaging';
import { FakePaymentProvider } from '@trawer/core/payments';
import { app, Client, phone } from './client';
import { pool } from '../src/db';
import { closeLive } from '../src/live';
import { setMessagingProvider } from '../src/whatsapp';
import { catalogPushes } from '../src/catalog';

const wa = new ConsoleMessagingProvider('test-meta-app-secret', true);
setMessagingProvider(wa);
const PHONE_ID = `10${Date.now() % 1e9}`;
const CRON = { authorization: 'Bearer test-cron-secret-0123456789' };
let owner: Client;
let businessId: string;
let slug: string;
let blueId: string;
let n = 0;

async function inbound(from: string, msg: Record<string, unknown>, id = `wamid.in.${Date.now()}.${++n}`) {
  const body = JSON.stringify({ entry: [{ changes: [{ value: {
    metadata: { phone_number_id: PHONE_ID }, contacts: [{ wa_id: from.replace('+', ''), profile: { name: 'Chidi Okafor' } }],
    messages: [{ id, from: from.replace('+', ''), timestamp: String(Math.floor(Date.now() / 1000)), ...msg }],
  } }] }] });
  const before = wa.sent.length;
  const res = await app.request('/api/webhooks/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': wa.sign(body) }, body });
  expect(res.status).toBe(200);
  return wa.sent.slice(before);
}
const text = (t: string) => ({ type: 'text', text: { body: t } });
const tap = (id: string) => ({ type: 'interactive', interactive: { button_reply: { id, title: id } } });
const pick = (id: string) => ({ type: 'interactive', interactive: { list_reply: { id, title: id } } });
const bodyOf = (s: (typeof wa.sent)[number]) => (s.msg ? (s.msg.kind === 'image' ? s.msg.caption : s.msg.text) : '');
const cron = (job: string) => app.request(`/api/cron/${job}`, { method: 'POST', headers: CRON });

beforeAll(async () => {
  owner = new Client();
  await owner.signIn(phone(), true);
  slug = `wa-${Date.now() % 100000}`;
  businessId = (await owner.post('/api/biz', { name: 'Balogun Fabrics', slug, kind: 'wholesaler', brand_colour: '#9A3412' })).body.business_id;
  const p = await owner.post(`/api/biz/${businessId}/products`, {
    name: 'Hollandais wax', category: 'Ankara', status: 'active', base_unit: 'piece', packs: [{ unit: 'carton', factor: 24 }],
    variants: [{ colour: 'Royal blue', retail_price_kobo: 2_280_000, opening_stock: 84 }, { colour: 'Gold', retail_price_kobo: 2_280_000, opening_stock: 30 }],
  });
  const detail = (await owner.get(`/api/biz/${businessId}/products/${p.body.id}`)).body;
  blueId = detail.variants[0].id;
  const tier = detail.tiers.find((t: any) => t.is_wholesale).id;
  for (const v of detail.variants) await owner.put(`/api/biz/${businessId}/variants/${v.id}/tier-prices`, { tier_prices: [{ tier_id: tier, price_kobo: 1_850_000 }] });
  const r = await owner.put(`/api/biz/${businessId}/whatsapp`, { phone_number_id: PHONE_ID, display_phone: '0803 000 0001', catalog_id: '123456789', token: 'x'.repeat(40) });
  expect(r.status).toBe(200);
});

afterAll(async () => {
  await closeLive();
  await pool.end();
});

describe('webhook security', () => {
  it('answers Meta’s verification handshake only with the right token', async () => {
    const ok = await app.request('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify-token-123&hub.challenge=abc');
    expect(await ok.text()).toBe('abc');
    expect((await app.request('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=abc')).status).toBe(403);
  });

  it('rejects unsigned or wrongly signed deliveries without saying why', async () => {
    const res = await app.request('/api/webhooks/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('');
  });

  it('never returns the stored token', async () => {
    const r = await owner.get(`/api/biz/${businessId}/whatsapp`);
    expect(r.body.connection).toMatchObject({ connected: true, own_token: true, catalog: true });
    expect(JSON.stringify(r.body)).not.toContain('xxxxxxxxxx');
  });

  it('cron endpoints need the cron secret', async () => {
    expect((await app.request('/api/cron/notifications', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/api/cron/notifications', { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
  });
});

describe('ordering on WhatsApp', () => {
  it('an approved wholesaler gets the same tier price as on the web, orders a carton and gets transfer details', async () => {
    // Register + approve the wholesaler on the web first.
    const buyerPhone = phone();
    const web = new Client();
    await web.signIn(buyerPhone);
    const reg = await web.post(`/api/store/${slug}/register`, { buyer_type: 'wholesaler', name: 'Chidi Okafor', business_name: 'Chidi Textiles', cac_number: 'RC123456', accept_terms: true });
    await owner.post(`/api/biz/${businessId}/customers/${reg.body.customer_id}/wholesale`, { approve: true });
    const webQuote = (await web.post(`/api/store/${slug}/quote`, { items: [{ variant_id: blueId, qty: 1 }] })).body.lines[0].unit_price_kobo;
    expect(webQuote).toBe(1_850_000);

    let out = await inbound(buyerPhone, text('Hello'));
    expect(bodyOf(out[0]!)).toContain('Welcome to Balogun Fabrics, Chidi');
    expect(bodyOf(out[0]!)).toContain('wholesale prices');

    out = await inbound(buyerPhone, text('how much hollandais?'));
    expect(bodyOf(out[0]!)).toContain('Royal blue: ₦18,500'); // same as web
    out = await inbound(buyerPhone, pick(`var:${blueId}`));
    const unitButtons = out[0]!.msg!;
    expect(unitButtons.kind === 'buttons' && unitButtons.buttons.map((b) => b.title)).toEqual(['piece', 'carton (24)']);
    const cartonId = unitButtons.kind === 'buttons' ? unitButtons.buttons[1]!.id : '';
    out = await inbound(buyerPhone, tap(cartonId));
    out = await inbound(buyerPhone, text('1'));
    expect(bodyOf(out[0]!)).toContain('Cart total: *₦444,000*');
    await inbound(buyerPhone, tap('checkout'));
    await inbound(buyerPhone, tap('pickup'));
    out = await inbound(buyerPhone, tap('confirm'));
    const msg = bodyOf(out[0]!);
    expect(msg).toMatch(/Order \*#\d+\* is held for you/);
    expect(msg).toMatch(/\*\d{10}\*/);
    expect(msg).toContain('https://app.trawer.test/t/');

    const r = await pool.query(`select channel, total_kobo, status from orders where business_id = $1 and customer_id = $2`, [businessId, reg.body.customer_id]);
    expect(r.rows).toEqual([{ channel: 'whatsapp', total_kobo: 44_400_000, status: 'pending' }]);
  });

  it('first contact from an unknown number creates a retail customer; retail prices apply', async () => {
    const stranger = phone();
    await inbound(stranger, text('hi'));
    const out = await inbound(stranger, text('hollandais'));
    expect(bodyOf(out[0]!)).toContain('Royal blue: ₦22,800');
    const c = await pool.query(`select buyer_type, name from customers where business_id = $1 and phone = $2`, [businessId, stranger]);
    expect(c.rows[0]).toMatchObject({ buyer_type: 'retail_buyer', name: 'Chidi Okafor' });
  });

  it('a redelivered message is processed once', async () => {
    const p = phone();
    const id = `wamid.dup.${Date.now()}`;
    expect(await inbound(p, text('hi'), id)).toHaveLength(1);
    expect(await inbound(p, text('hi'), id)).toHaveLength(0);
  });

  it('“talk to a person” hands the chat to staff and the bot goes quiet until “menu”', async () => {
    const p = phone();
    await inbound(p, text('hi'));
    expect(bodyOf((await inbound(p, text('I want to talk to a person')))[0]!)).toContain('will reply here shortly');
    expect(await inbound(p, text('hello?'))).toHaveLength(0);
    const today = await owner.get(`/api/biz/${businessId}/today`);
    expect(today.body.needs_you.whatsapp_handoffs).toBeGreaterThanOrEqual(1);
    expect((await inbound(p, text('menu'))).length).toBeGreaterThan(0);
  });
});

describe('notifications', () => {
  it('transfer received → WhatsApp message (free text inside 24h), receipts update status; template outside 24h', async () => {
    const buyerPhone = phone();
    await inbound(buyerPhone, text('hi')); // opens the 24-hour window
    await inbound(buyerPhone, text('hollandais'));
    await inbound(buyerPhone, pick(`var:${blueId}`));
    await inbound(buyerPhone, text('2'));
    await inbound(buyerPhone, tap('checkout'));
    await inbound(buyerPhone, tap('pickup'));
    await inbound(buyerPhone, tap('confirm'));
    const order = (await pool.query(`select o.id, o.total_kobo, va.account_number from orders o join customers c on c.id = o.customer_id
                                     join virtual_accounts va on va.customer_id = c.id where c.phone = $1 and o.business_id = $2`, [buyerPhone, businessId])).rows[0];

    const fake = new FakePaymentProvider();
    const { body, signature } = fake.simulateTransfer(order.account_number, order.total_kobo, `wa-pay-${order.id}`);
    await app.request('/api/webhooks/paystack', { method: 'POST', headers: { 'content-type': 'application/json', 'x-paystack-signature': signature }, body });

    const queued = await pool.query(`select kind, status from notifications where order_id = $1 order by created_at`, [order.id]);
    expect(queued.rows.map((r) => r.kind)).toEqual(['order_placed', 'payment_received']);

    const before = wa.sent.length;
    const res = await (await cron('notifications')).json() as { sent: number };
    expect(res.sent).toBeGreaterThanOrEqual(2);
    const toBuyer = wa.sent.slice(before).filter((s) => s.to === buyerPhone);
    expect(toBuyer.map((s) => s.msg?.kind)).toEqual(['text', 'text']);
    expect(toBuyer.some((s) => /^₦45,600 received for order #\d+/.test(bodyOf(s)))).toBe(true);
    expect(toBuyer.some((s) => /order #\d+ is held for you/.test(bodyOf(s)))).toBe(true);

    // Meta delivery receipt
    const sentRow = (await pool.query(`select provider_message_id from notifications where order_id = $1 and kind = 'payment_received'`, [order.id])).rows[0];
    const receipt = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: PHONE_ID }, statuses: [{ id: sentRow.provider_message_id, status: 'read' }] } }] }] });
    await app.request('/api/webhooks/whatsapp', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': wa.sign(receipt) }, body: receipt });
    expect((await pool.query(`select status from notifications where provider_message_id = $1`, [sentRow.provider_message_id])).rows[0].status).toBe('read');

    // Outside the window an approved template is used instead.
    await pool.query(`update whatsapp_sessions set last_inbound_at = now() - interval '2 days' where wa_phone = $1`, [buyerPhone]);
    await pool.query(`update orders set fulfilment_status = 'dispatched' where id = $1`, [order.id]);
    const b2 = wa.sent.length;
    await cron('notifications');
    const tpl = wa.sent.slice(b2).find((s) => s.to === buyerPhone)!;
    expect(tpl.template).toMatchObject({ name: 'trawer_order_dispatched', language: 'en' });
  });

  it('wholesale approval notifies the buyer', async () => {
    const p = phone();
    const web = new Client();
    await web.signIn(p);
    const reg = await web.post(`/api/store/${slug}/register`, { buyer_type: 'wholesaler', name: 'Ngozi Eze', cac_number: 'BN2345678', accept_terms: true });
    await owner.post(`/api/biz/${businessId}/customers/${reg.body.customer_id}/wholesale`, { approve: true });
    const r = await pool.query(`select kind from notifications where customer_id = $1`, [reg.body.customer_id]);
    expect(r.rows.map((x) => x.kind)).toEqual(['wholesale_approved']);
  });
});

describe('public tracking and catalogue sync', () => {
  it('tracking page data has no personal details and unknown tokens 404', async () => {
    const token = (await pool.query(`select tracking_token from orders where business_id = $1 limit 1`, [businessId])).rows[0].tracking_token;
    const r = await app.request(`/api/track/${token}`);
    const json = await r.json() as any;
    expect(json.order).toMatchObject({ shop: 'Balogun Fabrics' });
    expect(JSON.stringify(json)).not.toMatch(/\+234|buyer_phone|delivery_address|customer/);
    expect((await app.request('/api/track/not-a-real-token-123456')).status).toBe(404);
  });

  it('pushes live stock to the WhatsApp catalogue, then only what changed', async () => {
    catalogPushes.length = 0;
    await cron('whatsapp-catalog');
    const first = catalogPushes.find((x) => x.businessId === businessId)!;
    expect(first.items.map((i) => i.title).sort()).toEqual(['Hollandais wax · Gold', 'Hollandais wax · Royal blue']);
    catalogPushes.length = 0;
    await cron('whatsapp-catalog');
    expect(catalogPushes.find((x) => x.businessId === businessId)).toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    await owner.post(`/api/biz/${businessId}/stock`, { variant_id: blueId, action: 'receive', qty: 10 });
    await cron('whatsapp-catalog');
    const delta = catalogPushes.find((x) => x.businessId === businessId)!;
    expect(delta.items.map((i) => i.title)).toEqual(['Hollandais wax · Royal blue']);
  });
});
