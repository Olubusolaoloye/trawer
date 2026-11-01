import { describe, expect, it } from 'vitest';
import {
  MemoryCatalog, MemoryOutbox, MemoryState, PosEngine, escposReceipt, receiptLines, whatsappReceiptLink,
  type BootstrapResponse, type PosSale, type PosTransport, type SyncResult,
} from '../src/pos';
import { emptyPriceBook } from '../src/pricing';

const units = [
  { unitId: 'pc', name: 'piece', plural: 'pieces', factor: 1, isBase: true, barcode: null },
  { unitId: 'ctn', name: 'carton', plural: 'cartons', factor: 12, isBase: false, barcode: '2000000000999' },
];

function bootstrap(alloc: Record<string, number>): BootstrapResponse {
  const priceBook = emptyPriceBook();
  priceBook.variants.v1 = { retailPriceKobo: 1000 };
  priceBook.variants.v2 = { retailPriceKobo: 500 };
  priceBook.tiers.w = { isWholesale: true };
  priceBook.customers.chidi = { tierId: 'w', wholesaleStatus: 'approved' };
  priceBook.tierPrices['w:v1'] = 800;
  priceBook.volumeBreaks.push({ variantId: 'v1', tierId: null, minQty: 12, priceKobo: 900 });
  return {
    serverTime: '2026-11-01T10:00:00.000Z',
    variants: [
      { id: 'v1', productId: 'p1', name: 'Ankara', label: 'Red', sku: 'A1', barcode: '2000000000012', units, active: true },
      { id: 'v2', productId: 'p2', name: 'Lace', label: null, sku: 'L1', barcode: '2000000000029', units: [units[0]!], active: true },
    ],
    priceBook,
    allocations: alloc,
    customers: [{ id: 'chidi', name: 'Chidi', phone: '+2348090000001', tier: 'Wholesale' }],
  };
}

class FakeTransport implements PosTransport {
  online = true;
  alloc: Record<string, number> = { v1: 30, v2: 5 };
  received: PosSale[] = [];
  async bootstrap(): Promise<BootstrapResponse> {
    if (!this.online) throw new Error('offline');
    return bootstrap(this.alloc);
  }
  async pushSales(_d: string, sales: PosSale[]): Promise<SyncResult[]> {
    if (!this.online) throw new Error('offline');
    return sales.map((s) => {
      const dup = this.received.some((r) => r.clientId === s.clientId);
      if (!dup) {
        this.received.push(s);
        for (const l of s.lines) this.alloc[l.variantId] = Math.max((this.alloc[l.variantId] ?? 0) - l.baseQty, 0);
      }
      return { client_id: s.clientId, status: dup ? 'duplicate' : 'applied', order_number: this.received.length };
    });
  }
}

async function setup() {
  const transport = new FakeTransport();
  let n = 0;
  const engine = new PosEngine(new MemoryCatalog(), new MemoryOutbox(), new MemoryState(), transport, {
    deviceId: 'dev1', staffId: 'kemi', uuid: () => `id-${++n}`, now: () => new Date('2026-11-01T12:00:00Z'),
  });
  await engine.sync();
  return { engine, transport };
}

describe('PosEngine', () => {
  it('prices with the synced price book: tier price for the selected wholesaler, volume break for walk-ins', async () => {
    const { engine } = await setup();
    const a = await engine.openCart();
    await engine.scan(a.id, '2000000000999'); // a carton barcode → 12 pieces
    expect((await engine.priced(a.id)).totalKobo).toBe(12 * 900);
    await engine.setCustomer(a.id, 'chidi');
    expect((await engine.priced(a.id)).totalKobo).toBe(12 * 800);
  });

  it('keeps several carts open at once', async () => {
    const { engine } = await setup();
    const a = await engine.openCart('Mama Tolu');
    const b = await engine.openCart('Walk-in');
    await engine.add(a.id, 'v1', 'pc', 2);
    await engine.add(b.id, 'v2', null, 1);
    const carts = await engine.carts();
    expect(carts.map((c) => [c.label, c.lines.length])).toEqual([['Mama Tolu', 1], ['Walk-in', 1]]);
    await engine.checkout(b.id, [{ method: 'cash', amountKobo: 500 }]);
    expect((await engine.carts()).map((c) => c.label)).toEqual(['Mama Tolu']);
  });

  it('works offline within the allocation and refuses beyond it without a manager override', async () => {
    const { engine, transport } = await setup();
    transport.online = false;
    const c = await engine.openCart();
    await engine.add(c.id, 'v2', null, 4);
    await engine.checkout(c.id, [{ method: 'cash', amountKobo: 2000 }]);
    expect(await engine.localAvailable('v2')).toBe(1);
    const c2 = await engine.openCart();
    await engine.add(c2.id, 'v2', null, 2);
    await expect(engine.checkout(c2.id, [{ method: 'cash', amountKobo: 1000 }])).rejects.toThrow('Only 1 allocated');
    const s = await engine.checkout(c2.id, [{ method: 'cash', amountKobo: 1000 }], { overrideBy: 'manager-1' });
    expect(s.status).toBe('queued');
    expect(await engine.pendingCount()).toBe(2);
    await expect(engine.sync()).rejects.toThrow('offline');
    expect(await engine.pendingCount()).toBe(2);
  });

  it('pushes the outbox once back online; re-pushing is harmless', async () => {
    const { engine, transport } = await setup();
    transport.online = false;
    const c = await engine.openCart();
    await engine.add(c.id, 'v1', 'pc', 3);
    await engine.checkout(c.id, [{ method: 'card_terminal', amountKobo: 3000 }]);
    transport.online = true;
    const [r1, r2] = await Promise.all([engine.sync(), engine.sync()]); // concurrent calls share one run
    expect(r1).toEqual({ pushed: 1, conflicts: 0 });
    expect(r2).toBe(r1);
    expect(transport.received).toHaveLength(1);
    expect(await engine.pendingCount()).toBe(0);
    expect(await engine.localAvailable('v1')).toBe(27);
  });

  it('records exact amounts: cash over-tender becomes change; underpayment needs credit', async () => {
    const { engine } = await setup();
    const c = await engine.openCart();
    await engine.add(c.id, 'v1', 'pc', 2);
    await expect(engine.checkout(c.id, [{ method: 'cash', amountKobo: 1000 }])).rejects.toThrow('underpaid');
    const sale = await engine.checkout(c.id, [{ method: 'transfer', amountKobo: 1500 }, { method: 'cash', amountKobo: 1000 }]);
    expect(sale.payments.map((p) => [p.method, p.amountKobo])).toEqual([['transfer', 1500], ['cash', 500]]);
    expect(sale.changeKobo).toBe(500);
    const c2 = await engine.openCart();
    await engine.add(c2.id, 'v1', 'pc', 1);
    const credit = await engine.checkout(c2.id, [], { credit: true });
    expect(credit.payments).toEqual([]);
    expect(await engine.localCashUp('2026-11-01')).toMatchObject({ cash: 500, transfer: 1500 });
  });

  it('formats a 32-column receipt, ESC/POS bytes and a WhatsApp link', async () => {
    const { engine } = await setup();
    const c = await engine.openCart();
    await engine.add(c.id, 'v1', 'ctn', 1);
    const sale = await engine.checkout(c.id, [{ method: 'cash', amountKobo: 20000 }]);
    const lines = receiptLines(sale, { name: 'Balogun Fabrics', phone: '0803 000 0001' });
    expect(lines.every((l) => l.split('\n').every((x) => x.length <= 32))).toBe(true);
    expect(lines.join('\n')).toContain('TOTAL');
    expect(lines.join('\n')).toContain('Change');
    const bytes = escposReceipt(lines);
    expect([...bytes.slice(0, 2)]).toEqual([0x1b, 0x40]);
    expect(whatsappReceiptLink('+2348090000001', lines)).toMatch(/^https:\/\/wa\.me\/2348090000001\?text=/);
  });
});
