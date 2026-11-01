/**
 * WhatsApp order bot — a pure state machine. The API injects data access (BotDeps) and sends
 * the returned replies; nothing here talks to the network or the database.
 *
 * Flow: menu → categories / search → product (colour) → unit → quantity → cart → pickup or
 * delivery → address → place order → transfer details. Prices always come from deps (which use
 * the same resolve_price as the web and POS), so a wholesaler sees their tier price here too.
 */
import { formatNaira, type Kobo } from './money';

export type Inbound =
  | { kind: 'text'; text: string }
  | { kind: 'reply'; id: string; title?: string }
  | { kind: 'other' };

export type Outbound =
  | { kind: 'text'; text: string }
  | { kind: 'buttons'; text: string; buttons: { id: string; title: string }[] }
  | { kind: 'list'; text: string; button: string; rows: { id: string; title: string; description?: string }[] }
  | { kind: 'image'; url: string; caption: string };

export type BotStep = 'idle' | 'product' | 'unit' | 'qty' | 'checkout_method' | 'checkout_address' | 'confirm';

export interface BotState {
  step: BotStep;
  productId?: string;
  variantId?: string;
  unitId?: string;
  query?: string;
  category?: string;
  offset?: number;
  method?: 'pickup' | 'delivery';
  address?: string;
}

export interface BotProductSummary { productId: string; name: string; fromPriceKobo: Kobo; inStock: boolean }
export interface BotUnit { unitId: string; name: string; plural: string; factor: number; isBase: boolean }
export interface BotVariant { id: string; label: string | null; priceKobo: Kobo; available: number }
export interface BotProduct { id: string; name: string; image: string | null; variants: BotVariant[]; units: BotUnit[] }
export interface BotCartLine { name: string; label: string | null; qty: number; unitName: string; lineTotalKobo: Kobo }
export interface BotCart { lines: BotCartLine[]; totalKobo: Kobo }
export interface BotOrderPlaced { orderNumber: number; totalKobo: Kobo; account: { number: string; bank: string; name: string }; holdMinutes: number; trackingUrl: string }
export interface BotRecentOrder { orderNumber: number; statusText: string; totalKobo: Kobo; balanceKobo: Kobo; trackingUrl: string }

export interface BotDeps {
  shop: { name: string; storeUrl: string };
  customer: { name: string; isWholesale: boolean };
  categories(): Promise<{ name: string; n: number }[]>;
  search(q: { text?: string; category?: string }, offset: number): Promise<{ items: BotProductSummary[]; more: boolean }>;
  product(productId: string): Promise<BotProduct | null>;
  cart(): Promise<BotCart>;
  addToCart(variantId: string, unitId: string, qty: number): Promise<void>;
  clearCart(): Promise<void>;
  checkout(input: { method: 'pickup' | 'delivery'; address?: string }): Promise<BotOrderPlaced>;
  recentOrders(): Promise<BotRecentOrder[]>;
  requestHuman(): Promise<void>;
}

export class BotUserError extends Error {}

const PAGE = 8;
export const idle = (): BotState => ({ step: 'idle' });
const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const UNIT_ALIASES: Record<string, string[]> = {
  carton: ['ctn', 'ctns', 'cartoon', 'cartoons'], piece: ['pc', 'pcs', 'pcs.'], bundle: ['bdl', 'bdls'], dozen: ['doz'], yard: ['yd', 'yds'],
};
const NUMBER_WORDS: Record<string, number> = { one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20 };

/** "2 cartons", "carton", "3", "five bundles" → qty (+ unit if named). */
export function parseQty(text: string, units: BotUnit[]): { qty: number; unitId?: string } | null {
  const t = text.trim().toLowerCase().replace(/[,.!]/g, ' ');
  const m = t.match(/(\d+|one|a|an|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty)?\s*([a-z]+)?/);
  if (!m) return null;
  const qty = m[1] ? (/^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]]!) : undefined;
  const word = m[2];
  const unit = word ? units.find((u) => [u.name, u.plural, ...(UNIT_ALIASES[u.name] ?? [])].includes(word) || (word.length > 3 && u.plural.startsWith(word))) : undefined;
  if (qty === undefined && !unit) return null;
  if (qty !== undefined && (!Number.isInteger(qty) || qty <= 0 || qty > 100_000)) return null;
  return { qty: qty ?? 1, unitId: unit?.unitId };
}

const INTENTS: [RegExp, string][] = [
  [/^(hi|hello|hey|good (morning|afternoon|evening)|menu|start|home|helo|hy|wetin dey)\b/i, 'menu'],
  [/\b(cart|basket|bag)\b/i, 'cart'],
  [/\b(checkout|check out|pay|i want to pay|buy now)\b/i, 'checkout'],
  [/\b(order|orders|track|status|where is my)\b/i, 'orders'],
  [/\b(agent|human|person|talk to|call me|customer care|madam|oga)\b/i, 'human'],
  [/\b(empty|clear) (my )?cart\b/i, 'clear'],
];

function menu(deps: BotDeps, greet = true): Outbound[] {
  const hello = greet ? `Welcome to ${deps.shop.name}${deps.customer.name ? `, ${deps.customer.name.split(' ')[0]}` : ''}! ` : '';
  return [{
    kind: 'buttons',
    text: `${hello}What would you like to do?${deps.customer.isWholesale ? '\n\nYou see your wholesale prices here.' : ''}\n\nYou can also type what you're looking for, e.g. "royal blue ankara".`,
    buttons: [{ id: 'browse', title: 'See products' }, { id: 'cart', title: 'My cart' }, { id: 'orders', title: 'My orders' }],
  }];
}

async function showCart(deps: BotDeps): Promise<Outbound[]> {
  const cart = await deps.cart();
  if (!cart.lines.length) return [{ kind: 'buttons', text: 'Your cart is empty.', buttons: [{ id: 'browse', title: 'See products' }] }];
  const lines = cart.lines.map((l) => `• ${l.qty} ${l.unitName} ${l.name}${l.label ? ` (${l.label})` : ''} — ${formatNaira(l.lineTotalKobo)}`).join('\n');
  return [{
    kind: 'buttons',
    text: `Your cart:\n${lines}\n\nTotal: *${formatNaira(cart.totalKobo)}*`,
    buttons: [{ id: 'checkout', title: 'Checkout' }, { id: 'browse', title: 'Keep shopping' }, { id: 'clear', title: 'Empty cart' }],
  }];
}

async function showList(deps: BotDeps, state: BotState): Promise<{ state: BotState; replies: Outbound[] }> {
  const offset = state.offset ?? 0;
  const res = await deps.search({ text: state.query, category: state.category }, offset);
  if (!res.items.length) {
    return { state: idle(), replies: [{ kind: 'buttons', text: state.query ? `I couldn't find "${state.query}". Try another word, or see all products.` : 'Nothing here yet.', buttons: [{ id: 'browse', title: 'See products' }, { id: 'human', title: 'Ask the shop' }] }] };
  }
  if (res.items.length === 1 && offset === 0 && state.query) {
    return showProduct(deps, { ...state, step: 'product', productId: res.items[0]!.productId });
  }
  const rows = res.items.slice(0, res.more ? 9 : 10).map((p) => ({
    id: `prod:${p.productId}`, title: cut(p.name, 24),
    description: cut(p.inStock ? `from ${formatNaira(p.fromPriceKobo)}${deps.customer.isWholesale ? ' (your price)' : ''}` : 'Sold out', 72),
  }));
  if (res.more) rows.push({ id: `more:${offset + PAGE}`, title: 'More products', description: 'See the next page' });
  const heading = state.query ? `Results for "${state.query}"` : state.category ? state.category : 'Our products';
  return { state: { ...state, step: 'idle', offset }, replies: [{ kind: 'list', text: `${heading}. Pick one to see colours and prices.`, button: 'View products', rows }] };
}

async function showProduct(deps: BotDeps, state: BotState): Promise<{ state: BotState; replies: Outbound[] }> {
  const p = state.productId ? await deps.product(state.productId) : null;
  if (!p) return { state: idle(), replies: [{ kind: 'text', text: 'That product is no longer available.' }, ...menu(deps, false)] };
  const priceLines = p.variants.map((v) => `• ${v.label ?? 'Standard'}: ${formatNaira(v.priceKobo)}${v.available === 0 ? ' — sold out' : v.available < 20 ? ` — only ${v.available} left` : ''}`).join('\n');
  const caption = `*${p.name}*\n${priceLines}\n\nPrice per piece${deps.customer.isWholesale ? ' (your wholesale price)' : ''}.`;
  const replies: Outbound[] = p.image ? [{ kind: 'image', url: p.image, caption }] : [{ kind: 'text', text: caption }];
  const inStock = p.variants.filter((v) => v.available > 0);
  if (!inStock.length) {
    replies.push({ kind: 'buttons', text: 'This one is sold out right now.', buttons: [{ id: 'browse', title: 'See other products' }, { id: 'human', title: 'Ask the shop' }] });
    return { state: idle(), replies };
  }
  if (inStock.length === 1) return chooseUnit(deps, { ...state, step: 'unit', variantId: inStock[0]!.id }, p, replies);
  replies.push({
    kind: 'list', text: 'Which colour?', button: 'Choose colour',
    rows: inStock.slice(0, 10).map((v) => ({ id: `var:${v.id}`, title: cut(v.label ?? 'Standard', 24), description: `${formatNaira(v.priceKobo)} · ${v.available} in stock` })),
  });
  return { state: { ...state, step: 'product', productId: p.id }, replies };
}

function chooseUnit(deps: BotDeps, state: BotState, p: BotProduct, replies: Outbound[] = []): { state: BotState; replies: Outbound[] } {
  const units = [...p.units].sort((a, b) => a.factor - b.factor);
  if (units.length <= 1) {
    return { state: { ...state, step: 'qty', unitId: units[0]?.unitId }, replies: [...replies, { kind: 'text', text: `How many ${units[0]?.plural ?? 'pieces'}? Reply with a number.` }] };
  }
  replies.push({
    kind: 'buttons', text: 'Buy by piece or by pack?',
    buttons: units.slice(0, 3).map((u) => ({ id: `unit:${u.unitId}`, title: cut(u.factor > 1 ? `${u.name} (${u.factor})` : u.name, 20) })),
  });
  return { state: { ...state, step: 'unit' }, replies };
}

async function addQty(deps: BotDeps, state: BotState, qty: number, unitId?: string): Promise<{ state: BotState; replies: Outbound[] }> {
  const p = await deps.product(state.productId!);
  const v = p?.variants.find((x) => x.id === state.variantId);
  const unit = p?.units.find((u) => u.unitId === (unitId ?? state.unitId)) ?? p?.units.find((u) => u.isBase);
  if (!p || !v || !unit) return { state: idle(), replies: menu(deps, false) };
  if (qty * unit.factor > v.available) {
    const can = Math.floor(v.available / unit.factor);
    return { state, replies: [{ kind: 'text', text: can > 0 ? `We only have ${can} ${can === 1 ? unit.name : unit.plural} (${v.available} pieces) right now. Reply with a smaller number.` : `Not enough for a full ${unit.name}. We have ${v.available} pieces — try buying by the piece.` }] };
  }
  await deps.addToCart(v.id, unit.unitId, qty);
  const cart = await deps.cart();
  return {
    state: idle(),
    replies: [{
      kind: 'buttons',
      text: `Added ${qty} ${qty === 1 ? unit.name : unit.plural} of ${p.name}${v.label ? ` (${v.label})` : ''}.\nCart total: *${formatNaira(cart.totalKobo)}*`,
      buttons: [{ id: 'checkout', title: 'Checkout' }, { id: 'browse', title: 'Keep shopping' }, { id: 'cart', title: 'View cart' }],
    }],
  };
}

async function startCheckout(deps: BotDeps): Promise<{ state: BotState; replies: Outbound[] }> {
  const cart = await deps.cart();
  if (!cart.lines.length) return { state: idle(), replies: [{ kind: 'buttons', text: 'Your cart is empty.', buttons: [{ id: 'browse', title: 'See products' }] }] };
  return {
    state: { step: 'checkout_method' },
    replies: [{ kind: 'buttons', text: `Total so far: *${formatNaira(cart.totalKobo)}*.\nHow do you want to get it?`, buttons: [{ id: 'pickup', title: "I'll pick up" }, { id: 'delivery', title: 'Deliver to me' }] }],
  };
}

async function confirmStep(deps: BotDeps, state: BotState): Promise<{ state: BotState; replies: Outbound[] }> {
  const cart = await deps.cart();
  const lines = cart.lines.map((l) => `• ${l.qty} ${l.unitName} ${l.name}${l.label ? ` (${l.label})` : ''}`).join('\n');
  const where = state.method === 'delivery' ? `Deliver to: ${state.address}\n(the shop confirms the delivery fee)` : 'Pickup at the shop';
  return {
    state: { ...state, step: 'confirm' },
    replies: [{ kind: 'buttons', text: `Please confirm:\n${lines}\n\n${where}\nTotal: *${formatNaira(cart.totalKobo)}*`, buttons: [{ id: 'confirm', title: 'Place order' }, { id: 'cart', title: 'Change cart' }] }],
  };
}

export async function handleMessage(state: BotState, msg: Inbound, deps: BotDeps): Promise<{ state: BotState; replies: Outbound[] }> {
  try {
    return await route(state ?? idle(), msg, deps);
  } catch (err) {
    if (err instanceof BotUserError) return { state: idle(), replies: [{ kind: 'text', text: err.message }, ...menu(deps, false)] };
    throw err;
  }
}

async function route(state: BotState, msg: Inbound, deps: BotDeps): Promise<{ state: BotState; replies: Outbound[] }> {
  if (msg.kind === 'other') return { state, replies: [{ kind: 'text', text: 'I can read text and button taps for now. Type what you want, or "menu".' }] };

  // ---- button / list replies --------------------------------------------------------------
  if (msg.kind === 'reply') {
    const [key, arg] = [msg.id.split(':')[0]!, msg.id.slice(msg.id.indexOf(':') + 1)];
    switch (key) {
      case 'menu': return { state: idle(), replies: menu(deps) };
      case 'browse': {
        const cats = await deps.categories();
        if (cats.length > 1) {
          return { state: idle(), replies: [{ kind: 'list', text: 'What are you looking for?', button: 'Categories', rows: [...cats.slice(0, 9).map((c) => ({ id: `cat:${c.name}`, title: cut(c.name, 24), description: `${c.n} products` })), { id: 'cat:', title: 'Everything' }] }] };
        }
        return showList(deps, { step: 'idle' });
      }
      case 'cat': return showList(deps, { step: 'idle', category: arg || undefined });
      case 'more': return showList(deps, { ...state, offset: Number(arg) || 0 });
      case 'prod': return showProduct(deps, { step: 'product', productId: arg });
      case 'var': {
        const p = state.productId ? await deps.product(state.productId) : null;
        if (!p) return { state: idle(), replies: menu(deps, false) };
        return chooseUnit(deps, { ...state, variantId: arg }, p);
      }
      case 'unit': {
        const p = await deps.product(state.productId!);
        const u = p?.units.find((x) => x.unitId === arg);
        return { state: { ...state, step: 'qty', unitId: arg }, replies: [{ kind: 'text', text: `How many ${u?.plural ?? 'pieces'}? Reply with a number.` }] };
      }
      case 'cart': return { state: idle(), replies: await showCart(deps) };
      case 'clear': await deps.clearCart(); return { state: idle(), replies: [{ kind: 'text', text: 'Your cart is empty now.' }, ...menu(deps, false)] };
      case 'checkout': return startCheckout(deps);
      case 'pickup': return confirmStep(deps, { step: 'confirm', method: 'pickup' });
      case 'delivery': return { state: { step: 'checkout_address', method: 'delivery' }, replies: [{ kind: 'text', text: 'Send your delivery address: street, area, city and a landmark.' }] };
      case 'confirm': {
        if (state.step !== 'confirm' || !state.method) return startCheckout(deps);
        const o = await deps.checkout({ method: state.method, address: state.address });
        return {
          state: idle(),
          replies: [{
            kind: 'text',
            text: `Order *#${o.orderNumber}* is held for you for ${o.holdMinutes} minutes.\n\nPay *${formatNaira(o.totalKobo)}* to:\n*${o.account.number}*\n${o.account.bank} · ${o.account.name}\n\nIt's your own account number — save it as a beneficiary. I'll confirm the moment your transfer lands.\n\nTrack your order: ${o.trackingUrl}`,
          }],
        };
      }
      case 'orders': return showOrders(deps);
      case 'human': await deps.requestHuman(); return { state: idle(), replies: [{ kind: 'text', text: `Okay! Someone from ${deps.shop.name} will reply here shortly.` }] };
      default: return { state: idle(), replies: menu(deps, false) };
    }
  }

  // ---- free text ------------------------------------------------------------------------------
  const text = msg.text.trim();
  if (state.step === 'checkout_address') {
    if (text.length < 8) return { state, replies: [{ kind: 'text', text: 'Please send the full address: street, area, city.' }] };
    return confirmStep(deps, { ...state, address: text.slice(0, 300) });
  }
  if (state.step === 'qty' || state.step === 'unit') {
    const p = await deps.product(state.productId!);
    const parsed = p ? parseQty(text, p.units) : null;
    if (parsed) return addQty(deps, state, parsed.qty, parsed.unitId);
  }
  for (const [re, intent] of INTENTS) {
    if (re.test(text)) return route(state, { kind: 'reply', id: intent === 'menu' ? 'menu' : intent }, deps);
  }
  const query = text.replace(/^(how much(\s+(is|for))?|price(\s+(of|for))?|do you have|i want|i need|una get)\s+/i, '').replace(/\?+$/, '').trim();
  if (query.length < 2) return { state: idle(), replies: menu(deps) };
  return showList(deps, { step: 'idle', query: query.slice(0, 60) });
}

async function showOrders(deps: BotDeps): Promise<{ state: BotState; replies: Outbound[] }> {
  const orders = await deps.recentOrders();
  if (!orders.length) return { state: idle(), replies: [{ kind: 'buttons', text: "You don't have any orders yet.", buttons: [{ id: 'browse', title: 'See products' }] }] };
  const text = orders.slice(0, 5).map((o) => `*#${o.orderNumber}* · ${formatNaira(o.totalKobo)} · ${o.statusText}${o.balanceKobo > 0 ? ` · owes ${formatNaira(o.balanceKobo)}` : ''}\n${o.trackingUrl}`).join('\n\n');
  return { state: idle(), replies: [{ kind: 'text', text: `Your recent orders:\n\n${text}` }] };
}
