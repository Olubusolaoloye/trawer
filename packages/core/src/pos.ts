/**
 * Offline-first POS engine (platform neutral). The Expo app plugs in WatermelonDB-backed
 * repositories; tests use the in-memory ones at the bottom of this file.
 *
 * Rules:
 *  - Prices come from the synced PriceBook via the same resolver as the server.
 *  - Offline, a till may only sell what is allocated to it (minus sales not yet synced). A
 *    manager override can sell beyond it; the server then records a conflict instead of going
 *    negative.
 *  - Every sale and payment gets a client-generated UUID, so pushing the outbox is idempotent.
 */
import { resolvePrice, type PriceBook } from './pricing';
import { toBaseQty, type ProductUnit } from './units';
import { formatNaira, type Kobo } from './money';

export type PosPaymentMethod = 'cash' | 'card_terminal' | 'transfer' | 'ussd' | 'qr';

export interface PosVariant {
  id: string;
  productId: string;
  name: string;
  label: string | null;
  sku: string;
  barcode: string | null;
  units: (ProductUnit & { barcode?: string | null })[];
  active: boolean;
  image?: string | null;
}

export interface PosCustomer { id: string; name: string; phone: string; tier: string | null }

export interface PosLine {
  variantId: string;
  unitId: string;
  qty: number;
  baseQty: number;
  unitPriceKobo: Kobo; // per base unit
  name: string;
  label: string | null;
  unitName: string;
}

export interface PosCart {
  id: string;
  label: string;
  customerId: string | null;
  lines: PosLine[];
  createdAt: string;
}

export interface PosPayment { clientId: string; method: PosPaymentMethod; amountKobo: Kobo }

export type SaleStatus = 'queued' | 'applied' | 'duplicate' | 'conflict' | 'rejected';

export interface PosSale {
  clientId: string;
  deviceId: string;
  staffId: string;
  soldAt: string;
  customerId: string | null;
  lines: PosLine[];
  payments: PosPayment[];
  totalKobo: Kobo;
  changeKobo: Kobo;
  note?: string;
  status: SaleStatus;
  orderNumber?: number;
  error?: string;
  overrideBy?: string;
}

// ------------------------------------------------------------------------------------------
// Ports
// ------------------------------------------------------------------------------------------
export interface CatalogRepo {
  get(variantId: string): Promise<PosVariant | null>;
  findByBarcode(code: string): Promise<{ variant: PosVariant; unitId: string } | null>;
  search(text: string, limit?: number): Promise<PosVariant[]>;
  upsert(variants: PosVariant[]): Promise<void>;
}

export interface OutboxRepo {
  add(sale: PosSale): Promise<void>;
  pending(): Promise<PosSale[]>;
  update(clientId: string, patch: Partial<PosSale>): Promise<void>;
  since(isoDay: string): Promise<PosSale[]>;
}

export interface StateRepo {
  getPriceBook(): Promise<PriceBook | null>;
  setPriceBook(b: PriceBook): Promise<void>;
  getAllocations(): Promise<Record<string, number>>;
  setAllocations(a: Record<string, number>): Promise<void>;
  getCustomers(): Promise<PosCustomer[]>;
  upsertCustomers(c: PosCustomer[]): Promise<void>;
  getCarts(): Promise<PosCart[]>;
  setCarts(c: PosCart[]): Promise<void>;
  getMeta(): Promise<{ lastSyncAt: string | null }>;
  setMeta(m: { lastSyncAt: string | null }): Promise<void>;
}

export interface BootstrapResponse {
  serverTime: string;
  variants: PosVariant[];
  priceBook: PriceBook;
  allocations: Record<string, number>;
  customers: PosCustomer[];
}

export interface SyncResult { client_id: string; status: 'applied' | 'duplicate' | 'conflict' | 'error'; order_number?: number; error?: string; retryable?: boolean }

export interface PosTransport {
  bootstrap(deviceId: string, since: string | null): Promise<BootstrapResponse>;
  pushSales(deviceId: string, sales: PosSale[]): Promise<SyncResult[]>;
}

export class PosError extends Error {
  constructor(public readonly code: 'not_allocated' | 'unknown_variant' | 'underpaid' | 'empty_cart' | 'no_cart' | 'not_ready' | 'invalid_qty', message?: string) {
    super(message ?? code);
  }
}

// ------------------------------------------------------------------------------------------
// Engine
// ------------------------------------------------------------------------------------------
export interface PosEngineOptions {
  deviceId: string;
  staffId: string;
  uuid?: () => string;
  now?: () => Date;
}

export class PosEngine {
  private readonly uuid: () => string;
  private readonly now: () => Date;
  private syncing: Promise<{ pushed: number; conflicts: number }> | null = null;

  constructor(
    private readonly catalog: CatalogRepo,
    private readonly outbox: OutboxRepo,
    private readonly state: StateRepo,
    private readonly transport: PosTransport,
    private readonly opts: PosEngineOptions,
  ) {
    this.uuid = opts.uuid ?? (() => crypto.randomUUID());
    this.now = opts.now ?? (() => new Date());
  }

  // ---- stock available to this till ------------------------------------------------------
  /** Allocation known from the last sync minus sales still waiting in the outbox. */
  async localAvailable(variantId: string): Promise<number> {
    const alloc = (await this.state.getAllocations())[variantId] ?? 0;
    const pending = await this.outbox.pending();
    const unsynced = pending.flatMap((s) => s.lines).filter((l) => l.variantId === variantId).reduce((n, l) => n + l.baseQty, 0);
    return Math.max(alloc - unsynced, 0);
  }

  // ---- carts -----------------------------------------------------------------------------
  async carts(): Promise<PosCart[]> {
    return this.state.getCarts();
  }

  async openCart(label?: string): Promise<PosCart> {
    const carts = await this.state.getCarts();
    const cart: PosCart = { id: this.uuid(), label: label ?? `Cart ${carts.length + 1}`, customerId: null, lines: [], createdAt: this.now().toISOString() };
    await this.state.setCarts([...carts, cart]);
    return cart;
  }

  async discardCart(cartId: string): Promise<void> {
    await this.state.setCarts((await this.state.getCarts()).filter((c) => c.id !== cartId));
  }

  async setCustomer(cartId: string, customerId: string | null): Promise<PosCart> {
    return this.mutateCart(cartId, (c) => ({ ...c, customerId }));
  }

  async scan(cartId: string, code: string): Promise<PosCart> {
    const hit = await this.catalog.findByBarcode(code.trim());
    if (!hit) throw new PosError('unknown_variant', `No product with barcode ${code}`);
    return this.add(cartId, hit.variant.id, hit.unitId, 1);
  }

  async add(cartId: string, variantId: string, unitId: string | null, qty: number): Promise<PosCart> {
    const v = await this.catalog.get(variantId);
    if (!v || !v.active) throw new PosError('unknown_variant');
    if (!Number.isInteger(qty) || qty === 0) throw new PosError('invalid_qty');
    const unit = v.units.find((u) => u.unitId === unitId) ?? v.units.find((u) => u.isBase) ?? v.units[0]!;
    return this.mutateCart(cartId, (c) => {
      const lines = [...c.lines];
      const i = lines.findIndex((l) => l.variantId === variantId && l.unitId === unit.unitId);
      const nextQty = (i >= 0 ? lines[i]!.qty : 0) + qty;
      if (i >= 0 && nextQty <= 0) lines.splice(i, 1);
      else if (i >= 0) lines[i] = { ...lines[i]!, qty: nextQty, baseQty: toBaseQty(v.units, unit.unitId, nextQty) };
      else if (qty > 0) lines.push({ variantId, unitId: unit.unitId, qty, baseQty: toBaseQty(v.units, unit.unitId, qty), unitPriceKobo: 0, name: v.name, label: v.label, unitName: unit.name });
      return { ...c, lines };
    });
  }

  async setQty(cartId: string, variantId: string, unitId: string, qty: number): Promise<PosCart> {
    const cart = await this.cart(cartId);
    const line = cart.lines.find((l) => l.variantId === variantId && l.unitId === unitId);
    return this.add(cartId, variantId, unitId, qty - (line?.qty ?? 0));
  }

  /** Cart with prices resolved for its customer (quantity per variant summed across units). */
  async priced(cartId: string): Promise<PosCart & { totalKobo: Kobo }> {
    const cart = await this.cart(cartId);
    const book = await this.state.getPriceBook();
    if (!book) throw new PosError('not_ready', 'Sync once before selling');
    const qtyByVariant = new Map<string, number>();
    for (const l of cart.lines) qtyByVariant.set(l.variantId, (qtyByVariant.get(l.variantId) ?? 0) + l.baseQty);
    const lines = cart.lines.map((l) => ({
      ...l,
      unitPriceKobo: resolvePrice(book, l.variantId, cart.customerId, qtyByVariant.get(l.variantId)!, 'pos').unitPriceKobo,
    }));
    return { ...cart, lines, totalKobo: lines.reduce((s, l) => s + l.unitPriceKobo * l.baseQty, 0) };
  }

  /**
   * Complete a sale. Payments may exceed the total for cash (change is computed); a shortfall
   * is only allowed as a credit sale. `overrideBy` (manager id) allows selling beyond allocation.
   */
  async checkout(cartId: string, payments: { method: PosPaymentMethod; amountKobo: Kobo }[], opts: { credit?: boolean; overrideBy?: string; note?: string } = {}): Promise<PosSale> {
    const cart = await this.priced(cartId);
    if (cart.lines.length === 0) throw new PosError('empty_cart');
    const need = new Map<string, number>();
    for (const l of cart.lines) need.set(l.variantId, (need.get(l.variantId) ?? 0) + l.baseQty);
    if (!opts.overrideBy) {
      for (const [variantId, qty] of need) {
        const have = await this.localAvailable(variantId);
        if (qty > have) throw new PosError('not_allocated', `Only ${have} allocated to this till`);
      }
    }
    const paid = payments.reduce((s, p) => s + p.amountKobo, 0);
    if (paid < cart.totalKobo && !opts.credit) throw new PosError('underpaid');
    // Record exactly the amount owed; cash over-tender becomes change.
    let remaining = cart.totalKobo;
    const recorded: PosPayment[] = [];
    for (const p of [...payments].sort((a, b) => (a.method === 'cash' ? 1 : 0) - (b.method === 'cash' ? 1 : 0))) {
      const amt = Math.min(p.amountKobo, remaining);
      if (amt > 0) recorded.push({ clientId: this.uuid(), method: p.method, amountKobo: amt });
      remaining -= amt;
    }
    const sale: PosSale = {
      clientId: this.uuid(),
      deviceId: this.opts.deviceId,
      staffId: this.opts.staffId,
      soldAt: this.now().toISOString(),
      customerId: cart.customerId,
      lines: cart.lines,
      payments: recorded,
      totalKobo: cart.totalKobo,
      changeKobo: Math.max(paid - cart.totalKobo, 0),
      note: opts.note,
      status: 'queued',
      overrideBy: opts.overrideBy,
    };
    await this.outbox.add(sale);
    await this.discardCart(cartId);
    return sale;
  }

  // ---- sync ------------------------------------------------------------------------------
  /** Push queued sales, then pull catalogue / prices / allocations. Safe to call repeatedly. */
  sync(): Promise<{ pushed: number; conflicts: number }> {
    if (!this.syncing) {
      this.syncing = this.doSync().finally(() => {
        this.syncing = null;
      });
    }
    return this.syncing;
  }

  private async doSync(): Promise<{ pushed: number; conflicts: number }> {
    const pending = await this.outbox.pending();
    let pushed = 0;
    let conflicts = 0;
    for (let i = 0; i < pending.length; i += 25) {
      const batch = pending.slice(i, i + 25);
      const results = await this.transport.pushSales(this.opts.deviceId, batch);
      for (const r of results) {
        if (r.status === 'error') {
          if (!r.retryable) await this.outbox.update(r.client_id, { status: 'rejected', error: r.error });
          continue;
        }
        if (r.status === 'conflict') conflicts += 1;
        pushed += 1;
        await this.outbox.update(r.client_id, { status: r.status, orderNumber: r.order_number });
      }
    }
    const meta = await this.state.getMeta();
    const boot = await this.transport.bootstrap(this.opts.deviceId, meta.lastSyncAt);
    await this.catalog.upsert(boot.variants);
    await this.state.setPriceBook(boot.priceBook);
    await this.state.setAllocations(boot.allocations);
    await this.state.upsertCustomers(boot.customers);
    await this.state.setMeta({ lastSyncAt: boot.serverTime });
    return { pushed, conflicts };
  }

  async pendingCount(): Promise<number> {
    return (await this.outbox.pending()).length;
  }

  /** Local end-of-day totals for this staff member (what the till believes it took). */
  async localCashUp(isoDay: string): Promise<Record<PosPaymentMethod, Kobo>> {
    const out = { cash: 0, card_terminal: 0, transfer: 0, ussd: 0, qr: 0 } as Record<PosPaymentMethod, Kobo>;
    for (const s of await this.outbox.since(isoDay)) {
      if (s.staffId !== this.opts.staffId || s.status === 'rejected') continue;
      for (const p of s.payments) out[p.method] += p.amountKobo;
    }
    return out;
  }

  private async cart(cartId: string): Promise<PosCart> {
    const c = (await this.state.getCarts()).find((x) => x.id === cartId);
    if (!c) throw new PosError('no_cart');
    return c;
  }

  private async mutateCart(cartId: string, fn: (c: PosCart) => PosCart): Promise<PosCart> {
    const carts = await this.state.getCarts();
    const i = carts.findIndex((c) => c.id === cartId);
    if (i < 0) throw new PosError('no_cart');
    const next = fn(carts[i]!);
    carts[i] = next;
    await this.state.setCarts(carts);
    return next;
  }
}

/** Shape the server's /api/pos/sync expects. */
export function toSyncPayload(s: PosSale) {
  return {
    client_id: s.clientId,
    sold_at: s.soldAt,
    customer_id: s.customerId,
    note: s.note,
    items: s.lines.map((l) => ({ variant_id: l.variantId, unit_id: l.unitId, qty: l.qty, unit_price_kobo: l.unitPriceKobo })),
    payments: s.payments.map((p) => ({ client_id: p.clientId, method: p.method, amount_kobo: p.amountKobo })),
  };
}

// ------------------------------------------------------------------------------------------
// Receipts (thermal printer + WhatsApp)
// ------------------------------------------------------------------------------------------
const METHOD_LABEL: Record<PosPaymentMethod, string> = { cash: 'Cash', card_terminal: 'Card', transfer: 'Transfer', ussd: 'USSD', qr: 'QR' };

function row(left: string, right: string, width: number): string {
  const space = Math.max(width - left.length - right.length, 1);
  return left.length + right.length + 1 > width ? `${left}\n${' '.repeat(Math.max(width - right.length, 0))}${right}` : left + ' '.repeat(space) + right;
}

export function receiptLines(sale: PosSale, shop: { name: string; address?: string | null; phone?: string | null }, width = 32): string[] {
  const center = (s: string) => ' '.repeat(Math.max(Math.floor((width - s.length) / 2), 0)) + s;
  const rule = '-'.repeat(width);
  const out = [center(shop.name.slice(0, width))];
  if (shop.address) out.push(center(shop.address.slice(0, width)));
  if (shop.phone) out.push(center(shop.phone));
  out.push(rule, new Date(sale.soldAt).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' }));
  if (sale.orderNumber) out.push(`Receipt #${sale.orderNumber}`);
  out.push(rule);
  for (const l of sale.lines) {
    out.push(`${l.name}${l.label ? ` (${l.label})` : ''}`.slice(0, width));
    out.push(row(`  ${l.qty} ${l.unitName} x ${formatNaira(l.unitPriceKobo * (l.baseQty / l.qty))}`, formatNaira(l.unitPriceKobo * l.baseQty), width));
  }
  out.push(rule, row('TOTAL', formatNaira(sale.totalKobo), width));
  for (const p of sale.payments) out.push(row(METHOD_LABEL[p.method], formatNaira(p.amountKobo), width));
  if (sale.changeKobo > 0) out.push(row('Change', formatNaira(sale.changeKobo), width));
  const paid = sale.payments.reduce((s, p) => s + p.amountKobo, 0);
  if (paid < sale.totalKobo) out.push(row('BALANCE DUE', formatNaira(sale.totalKobo - paid), width));
  out.push(rule, center('Thank you!'), center('Powered by Trawer'));
  return out;
}

/** ESC/POS bytes for 58mm Bluetooth printers. Naira sign is replaced by "N" (no glyph in most code pages). */
export function escposReceipt(lines: string[]): Uint8Array {
  const ESC = 0x1b;
  const GS = 0x1d;
  const text = lines.join('\n').replace(/₦/g, 'N').replace(/[^\x0A\x20-\x7E]/g, '?') + '\n\n\n';
  const body = Array.from(text, (ch) => ch.charCodeAt(0));
  return new Uint8Array([ESC, 0x40, ...body, GS, 0x56, 0x42, 0x00]);
}

/** wa.me link that opens WhatsApp with the receipt text (works with no Business API). */
export function whatsappReceiptLink(phoneE164: string, lines: string[]): string {
  return `https://wa.me/${phoneE164.replace(/\D/g, '')}?text=${encodeURIComponent(lines.join('\n'))}`;
}

// ------------------------------------------------------------------------------------------
// In-memory repositories (tests, web preview)
// ------------------------------------------------------------------------------------------
export class MemoryCatalog implements CatalogRepo {
  private readonly byId = new Map<string, PosVariant>();
  async get(id: string) { return this.byId.get(id) ?? null; }
  async findByBarcode(code: string) {
    for (const v of this.byId.values()) {
      if (!v.active) continue;
      if (v.barcode === code) return { variant: v, unitId: v.units.find((u) => u.isBase)?.unitId ?? v.units[0]!.unitId };
      const u = v.units.find((x) => x.barcode === code);
      if (u) return { variant: v, unitId: u.unitId };
    }
    return null;
  }
  async search(text: string, limit = 30) {
    const t = text.toLowerCase();
    return [...this.byId.values()].filter((v) => v.active && (`${v.name} ${v.label ?? ''} ${v.sku}`.toLowerCase().includes(t))).slice(0, limit);
  }
  async upsert(vs: PosVariant[]) { for (const v of vs) this.byId.set(v.id, v); }
}

export class MemoryOutbox implements OutboxRepo {
  readonly sales: PosSale[] = [];
  async add(s: PosSale) { this.sales.push(structuredClone(s)); }
  async pending() { return this.sales.filter((s) => s.status === 'queued').map((s) => structuredClone(s)); }
  async update(id: string, patch: Partial<PosSale>) { const s = this.sales.find((x) => x.clientId === id); if (s) Object.assign(s, patch); }
  async since(day: string) { return this.sales.filter((s) => s.soldAt.slice(0, 10) >= day); }
}

export class MemoryState implements StateRepo {
  private book: PriceBook | null = null;
  private alloc: Record<string, number> = {};
  private customers: PosCustomer[] = [];
  private cartsList: PosCart[] = [];
  private meta = { lastSyncAt: null as string | null };
  async getPriceBook() { return this.book; }
  async setPriceBook(b: PriceBook) { this.book = b; }
  async getAllocations() { return { ...this.alloc }; }
  async setAllocations(a: Record<string, number>) { this.alloc = { ...a }; }
  async getCustomers() { return this.customers; }
  async upsertCustomers(c: PosCustomer[]) { const m = new Map(this.customers.map((x) => [x.id, x])); for (const x of c) m.set(x.id, x); this.customers = [...m.values()]; }
  async getCarts() { return structuredClone(this.cartsList); }
  async setCarts(c: PosCart[]) { this.cartsList = structuredClone(c); }
  async getMeta() { return this.meta; }
  async setMeta(m: { lastSyncAt: string | null }) { this.meta = m; }
}

// ------------------------------------------------------------------------------------------
// HTTP transport (used by apps/pos)
// ------------------------------------------------------------------------------------------
export class HttpPosTransport implements PosTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => Promise<string>,
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async call<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${await this.getToken()}`,
        'X-Trawer': '1',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `http_${res.status}`);
    return json;
  }

  bootstrap(deviceId: string, since: string | null): Promise<BootstrapResponse> {
    const qs = new URLSearchParams({ device_id: deviceId, ...(since ? { since } : {}) });
    return this.call(`/api/pos/bootstrap?${qs}`, { method: 'GET' });
  }

  async pushSales(deviceId: string, sales: PosSale[]): Promise<SyncResult[]> {
    const r = await this.call<{ results: SyncResult[] }>('/api/pos/sync', { method: 'POST', body: { device_id: deviceId, sales: sales.map(toSyncPayload) } });
    return r.results;
  }
}
