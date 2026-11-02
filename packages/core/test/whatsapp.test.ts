import { describe, expect, it } from 'vitest';
import { handleMessage, idle, parseQty, type BotDeps, type BotState, type Outbound } from '../src/whatsapp';
import { ConsoleMessagingProvider, inServiceWindow, notificationText, parseWhatsAppWebhook, TEMPLATES } from '../src/messaging';

const units = [
  { unitId: 'pc', name: 'piece', plural: 'pieces', factor: 1, isBase: true },
  { unitId: 'bd', name: 'bundle', plural: 'bundles', factor: 6, isBase: false },
  { unitId: 'ct', name: 'carton', plural: 'cartons', factor: 24, isBase: false },
];

function fakeDeps(over: Partial<BotDeps> = {}) {
  const cart: { variantId: string; unitId: string; qty: number }[] = [];
  const log: string[] = [];
  const product = {
    id: 'p1', name: 'Hollandais wax', image: 'https://img/1.webp', units,
    variants: [
      { id: 'v-blue', label: 'Royal blue', priceKobo: 1_850_000, available: 84 },
      { id: 'v-wine', label: 'Wine', priceKobo: 1_850_000, available: 0 },
      { id: 'v-gold', label: 'Gold', priceKobo: 1_850_000, available: 30 },
    ],
  };
  const deps: BotDeps = {
    shop: { name: 'Balogun Fabrics', storeUrl: 'https://balogun.trawer.shop' },
    customer: { name: 'Chidi Okafor', isWholesale: true },
    categories: async () => [{ name: 'Ankara', n: 40 }, { name: 'Lace', n: 20 }],
    search: async (q) => (q.text === 'zzz' ? { items: [], more: false } : q.text === 'hollandais'
      ? { items: [{ productId: 'p1', name: 'Hollandais wax', fromPriceKobo: 1_850_000, inStock: true }], more: false }
      : { items: Array.from({ length: 8 }, (_, i) => ({ productId: `p${i + 1}`, name: `Fabric ${i + 1}`, fromPriceKobo: 100_000, inStock: i !== 3 })), more: true }),
    product: async (id) => (id === 'p1' ? product : null),
    cart: async () => ({ lines: cart.map((c) => ({ name: 'Hollandais wax', label: 'Royal blue', qty: c.qty, unitName: units.find((u) => u.unitId === c.unitId)!.plural, lineTotalKobo: c.qty * units.find((u) => u.unitId === c.unitId)!.factor * 1_850_000 })), totalKobo: cart.reduce((s, c) => s + c.qty * units.find((u) => u.unitId === c.unitId)!.factor * 1_850_000, 0) }),
    addToCart: async (variantId, unitId, qty) => { cart.push({ variantId, unitId, qty }); log.push(`add:${variantId}:${unitId}:${qty}`); },
    clearCart: async () => { cart.length = 0; },
    checkout: async (i) => { log.push(`checkout:${i.method}:${i.address ?? ''}`); return { orderNumber: 1043, totalKobo: 44_400_000, account: { number: '9719799206', bank: 'Wema Bank', name: 'TRAWER/CHIDI T.' }, holdMinutes: 30, trackingUrl: 'https://trawer.shop/t/x7Kq' }; },
    recentOrders: async () => [{ orderNumber: 1018, statusText: 'Delivered', totalKobo: 900_000, balanceKobo: 4_500_000, trackingUrl: 'https://trawer.shop/t/a' }],
    requestHuman: async () => { log.push('human'); },
    ...over,
  };
  return { deps, cart, log };
}

async function say(state: BotState, deps: BotDeps, input: string | { reply: string }) {
  return handleMessage(state, typeof input === 'string' ? { kind: 'text', text: input } : { kind: 'reply', id: input.reply }, deps);
}
const textOf = (o: Outbound) => (o.kind === 'image' ? o.caption : o.text);

describe('parseQty', () => {
  it('understands numbers, words and units', () => {
    expect(parseQty('2 cartons', units)).toEqual({ qty: 2, unitId: 'ct' });
    expect(parseQty('a carton', units)).toEqual({ qty: 1, unitId: 'ct' });
    expect(parseQty('five bundles', units)).toEqual({ qty: 5, unitId: 'bd' });
    expect(parseQty('12', units)).toEqual({ qty: 12, unitId: undefined });
    expect(parseQty('ctn', units)).toEqual({ qty: 1, unitId: 'ct' });
    expect(parseQty('hello', units)).toBeNull();
    expect(parseQty('0', units)).toBeNull();
  });
});

describe('WhatsApp bot', () => {
  it('greets with a menu and mentions wholesale prices for wholesalers', async () => {
    const { deps } = fakeDeps();
    const r = await say(idle(), deps, 'Hi');
    expect(r.replies[0]).toMatchObject({ kind: 'buttons' });
    expect(textOf(r.replies[0]!)).toContain('Welcome to Balogun Fabrics, Chidi');
    expect(textOf(r.replies[0]!)).toContain('wholesale prices');
  });

  it('full order: search → colour → carton → quantity → cart → delivery → address → place order', async () => {
    const { deps, log } = fakeDeps();
    let r = await say(idle(), deps, 'how much hollandais?');
    expect(r.replies[0]).toMatchObject({ kind: 'image' });
    expect(textOf(r.replies[0]!)).toContain('Royal blue: ₦18,500');
    expect(textOf(r.replies[0]!)).toContain('Wine: ₦18,500 — sold out');
    const colourList = r.replies[1]!;
    expect(colourList.kind === 'list' && colourList.rows.map((x) => x.id)).toEqual(['var:v-blue', 'var:v-gold']); // sold out not offered
    r = await say(r.state, deps, { reply: 'var:v-blue' });
    expect(r.replies[0]).toMatchObject({ kind: 'buttons' });
    r = await say(r.state, deps, { reply: 'unit:ct' });
    expect(textOf(r.replies[0]!)).toContain('How many cartons');
    r = await say(r.state, deps, '5');
    expect(textOf(r.replies[0]!)).toContain('We only have 3 cartons');
    r = await say(r.state, deps, '2');
    expect(log).toContain('add:v-blue:ct:2');
    expect(textOf(r.replies[0]!)).toContain('Cart total: *₦888,000*');
    r = await say(r.state, deps, { reply: 'checkout' });
    r = await say(r.state, deps, { reply: 'delivery' });
    r = await say(r.state, deps, 'short');
    expect(textOf(r.replies[0]!)).toContain('full address');
    r = await say(r.state, deps, '12 Upper Iweka Road, Onitsha, near the park');
    expect(textOf(r.replies[0]!)).toContain('Deliver to: 12 Upper Iweka Road');
    r = await say(r.state, deps, { reply: 'confirm' });
    expect(log).toContain('checkout:delivery:12 Upper Iweka Road, Onitsha, near the park');
    expect(textOf(r.replies[0]!)).toContain('9719799206');
    expect(textOf(r.replies[0]!)).toContain('Track your order');
    expect(r.state).toEqual(idle());
  });

  it('accepts "2 bundles" while choosing the unit', async () => {
    const { deps, log } = fakeDeps();
    let r = await say(idle(), deps, { reply: 'prod:p1' });
    r = await say(r.state, deps, { reply: 'var:v-gold' });
    r = await say(r.state, deps, '2 bundles');
    expect(log).toContain('add:v-gold:bd:2');
  });

  it('browses categories with a paged list and a "more" row', async () => {
    const { deps } = fakeDeps();
    let r = await say(idle(), deps, { reply: 'browse' });
    expect(r.replies[0]).toMatchObject({ kind: 'list' });
    r = await say(r.state, deps, { reply: 'cat:Ankara' });
    const list = r.replies[0]!;
    expect(list.kind === 'list' && list.rows.length).toBe(9);
    expect(list.kind === 'list' && list.rows.at(-1)!.id).toBe('more:8');
    expect(list.kind === 'list' && list.rows[3]!.description).toBe('Sold out');
    expect(list.kind === 'list' && list.rows.every((x) => x.title.length <= 24)).toBe(true);
  });

  it('handles empty searches, cart, orders and human hand-off', async () => {
    const { deps, log } = fakeDeps();
    expect(textOf((await say(idle(), deps, 'zzz')).replies[0]!)).toContain(`couldn't find "zzz"`);
    expect(textOf((await say(idle(), deps, 'my cart')).replies[0]!)).toContain('cart is empty');
    expect(textOf((await say(idle(), deps, 'checkout')).replies[0]!)).toContain('cart is empty');
    expect(textOf((await say(idle(), deps, 'where is my order')).replies[0]!)).toContain('#1018');
    await say(idle(), deps, 'I want to talk to a person');
    expect(log).toContain('human');
  });

  it('a stale "Place order" tap without a confirmed checkout restarts checkout instead of ordering', async () => {
    const { deps, log } = fakeDeps();
    await deps.addToCart('v-blue', 'pc', 1);
    const r = await say(idle(), deps, { reply: 'confirm' });
    expect(log.some((l) => l.startsWith('checkout:'))).toBe(false);
    expect(textOf(r.replies[0]!)).toContain('How do you want to get it');
  });
});

describe('messaging helpers', () => {
  it('parses Meta webhooks (messages, interactive replies, statuses)', () => {
    const parsed = parseWhatsAppWebhook({ entry: [{ changes: [{ value: {
      metadata: { phone_number_id: '111' }, contacts: [{ wa_id: '2348090000001', profile: { name: 'Chidi' } }],
      messages: [{ id: 'wamid.1', from: '2348090000001', timestamp: '1700000000', type: 'interactive', interactive: { button_reply: { id: 'checkout', title: 'Checkout' } } }],
      statuses: [{ id: 'wamid.out', status: 'read' }],
    } }] }] });
    expect(parsed[0]).toMatchObject({ phoneNumberId: '111', statuses: [{ id: 'wamid.out', status: 'read' }] });
    expect(parsed[0]!.messages[0]).toMatchObject({ from: '+2348090000001', profileName: 'Chidi', inbound: { kind: 'reply', id: 'checkout' } });
  });

  it('verifies signatures in constant time', () => {
    const p = new ConsoleMessagingProvider('secret', true);
    expect(p.verifySignature('{"a":1}', p.sign('{"a":1}'))).toBe(true);
    expect(p.verifySignature('{"a":2}', p.sign('{"a":1}'))).toBe(false);
    expect(p.verifySignature('{"a":1}', null)).toBe(false);
  });

  it('knows the 24-hour window and renders both text and template forms', () => {
    const now = new Date('2026-11-01T12:00:00Z');
    expect(inServiceWindow(new Date('2026-11-01T00:00:00Z'), now)).toBe(true);
    expect(inServiceWindow(new Date('2026-10-31T11:00:00Z'), now)).toBe(false);
    expect(inServiceWindow(null, now)).toBe(false);
    const params = { order_number: 1042, received_kobo: 30_650_000, shop: 'Balogun Fabrics', slug: 'balogun', tracking_token: 'x7' };
    expect(notificationText('payment_received', params, 'https://trawer.shop/t/x7')).toBe('₦306,500 received for order #1042. Thank you! Balogun Fabrics is getting it ready. Track it: https://trawer.shop/t/x7');
    expect(TEMPLATES.payment_received.vars(params, 'u')).toEqual(['₦306,500', '1042', 'Balogun Fabrics', 'u']);
    expect(notificationText('dispatched', { ...params, rider: 'Musa', collect_kobo: 4_500_000 }, 'https://trawer.shop/t/x7'))
      .toBe('Order #1042 from Balogun Fabrics is on the way with Musa! Please have ₦45,000 ready to pay on delivery. Track it: https://trawer.shop/t/x7');
    expect(notificationText('dispatched', params, 'u')).toBe('Order #1042 from Balogun Fabrics is on the way! Track it: u');
  });
});
