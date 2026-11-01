// Runs the real WatermelonDB repositories on the LokiJS adapter (same Watermelon API as SQLite).
import { describe, expect, it } from 'vitest';
import { Database } from '@nozbe/watermelondb';
import LokiJSAdapter from '@nozbe/watermelondb/adapters/lokijs';
import { emptyPriceBook } from '@trawer/core/pricing';
import { PosEngine, type BootstrapResponse, type PosTransport } from '@trawer/core/pos';
import { schema } from '../src/db/schema';
import { BarcodeRow, KvRow, OutboxRow, VariantRow } from '../src/db/models';
import { WatermelonCatalog, WatermelonOutbox, WatermelonState } from '../src/db/repos';

function db() {
  const adapter = new LokiJSAdapter({ schema, useWebWorker: false, useIncrementalIndexedDB: false, dbName: `t${Math.random()}` });
  return new Database({ adapter, modelClasses: [VariantRow, BarcodeRow, OutboxRow, KvRow] });
}

const units = [
  { unitId: 'pc', name: 'piece', plural: 'pieces', factor: 1, isBase: true, barcode: null },
  { unitId: 'ctn', name: 'carton', plural: 'cartons', factor: 12, isBase: false, barcode: '2000000009990' },
];

function boot(): BootstrapResponse {
  const priceBook = emptyPriceBook();
  priceBook.variants.v1 = { retailPriceKobo: 1000 };
  return {
    serverTime: '2026-11-01T10:00:00.000Z',
    variants: Array.from({ length: 1200 }, (_, i) => ({
      id: i === 0 ? 'v1' : `v${i + 1}`, productId: `p${i}`, name: i === 0 ? 'Ankara wax' : `Fabric ${i}`, label: 'Red', sku: `SKU${i}`,
      barcode: `20000000${String(i).padStart(5, '0')}`, units, active: true,
    })).map((v, i) => (i === 0 ? v : { ...v, units: [units[0]!] })),
    priceBook, allocations: { v1: 24 }, customers: [{ id: 'c1', name: 'Chidi', phone: '+2348090000001', tier: null }],
  };
}

describe('WatermelonDB repositories', () => {
  it('upserts a large catalogue in chunks and finds variant and pack barcodes', async () => {
    const d = db();
    const cat = new WatermelonCatalog(d);
    await cat.upsert(boot().variants);
    expect(await d.get('variants').query().fetchCount()).toBe(1200);
    expect((await cat.findByBarcode('2000000000000'))?.variant.id).toBe('v1');
    expect(await cat.findByBarcode('2000000009990')).toMatchObject({ unitId: 'ctn' });
    expect((await cat.search('ankara')).map((v) => v.id)).toEqual(['v1']);
    // re-upsert (delta sync) updates in place, no duplicates
    await cat.upsert([{ ...boot().variants[0]!, name: 'Ankara wax (new)', active: false }]);
    expect(await d.get('variants').query().fetchCount()).toBe(1200);
    expect(await cat.findByBarcode('2000000000000')).toBeNull(); // inactive
    expect(await d.get('barcodes').query().fetchCount()).toBe(1201);
  });

  it('drives the engine end to end on Watermelon storage', async () => {
    const d = db();
    const pushed: string[] = [];
    const transport: PosTransport = {
      bootstrap: async () => boot(),
      pushSales: async (_id, sales) => sales.map((s) => { pushed.push(s.clientId); return { client_id: s.clientId, status: 'applied', order_number: pushed.length }; }),
    };
    const engine = new PosEngine(new WatermelonCatalog(d), new WatermelonOutbox(d), new WatermelonState(d), transport, { deviceId: 'd1', staffId: 's1' });
    await engine.sync();
    const cart = await engine.openCart();
    await engine.scan(cart.id, '2000000009990');
    const sale = await engine.checkout(cart.id, [{ method: 'cash', amountKobo: 12_000 }]);
    expect(sale.totalKobo).toBe(12_000);
    expect(await engine.localAvailable('v1')).toBe(12);
    expect(await engine.pendingCount()).toBe(1);
    await engine.sync();
    expect(pushed).toEqual([sale.clientId]);
    expect(await engine.pendingCount()).toBe(0);
    expect(await engine.carts()).toEqual([]);
  });
});
