/** WatermelonDB implementations of the core POS engine's ports. */
import { Q, type Database } from '@nozbe/watermelondb';
import type { CatalogRepo, OutboxRepo, PosCart, PosCustomer, PosSale, PosVariant, StateRepo } from '@trawer/core/pos';
import type { PriceBook } from '@trawer/core/pricing';
import type { BarcodeRow, KvRow, OutboxRow, VariantRow } from './models';

function toVariant(r: VariantRow): PosVariant {
  return { id: r.id, productId: r.productId, name: r.name, label: r.label, sku: r.sku, barcode: null, units: JSON.parse(r.unitsJson), active: r.active, image: r.image };
}

export class WatermelonCatalog implements CatalogRepo {
  constructor(private readonly db: Database) {}

  async get(id: string) {
    const r = await this.db.get<VariantRow>('variants').find(id).catch(() => null);
    return r ? toVariant(r) : null;
  }

  async findByBarcode(code: string) {
    const [hit] = await this.db.get<BarcodeRow>('barcodes').query(Q.where('code', code), Q.take(1)).fetch();
    if (!hit) return null;
    const v = await this.get(hit.variantId);
    return v && v.active ? { variant: v, unitId: hit.unitId } : null;
  }

  async search(text: string, limit = 30) {
    const rows = await this.db.get<VariantRow>('variants')
      .query(Q.where('active', true), Q.where('search_text', Q.like(`%${Q.sanitizeLikeString(text.toLowerCase())}%`)), Q.take(limit))
      .fetch();
    return rows.map(toVariant);
  }

  async upsert(variants: PosVariant[]) {
    if (!variants.length) return;
    const table = this.db.get<VariantRow>('variants');
    const codes = this.db.get<BarcodeRow>('barcodes');
    for (let i = 0; i < variants.length; i += 500) {
      const chunk = variants.slice(i, i + 500);
      const ids = chunk.map((v) => v.id);
      await this.db.write(async () => {
        const existing = new Map((await table.query(Q.where('id', Q.oneOf(ids))).fetch()).map((r) => [r.id, r]));
        const oldCodes = await codes.query(Q.where('variant_id', Q.oneOf(ids))).fetch();
        const ops = [
          ...oldCodes.map((c) => c.prepareDestroyPermanently()),
          ...chunk.map((v) => {
            const apply = (r: VariantRow) => {
              r.productId = v.productId; r.name = v.name; r.label = v.label; r.sku = v.sku; r.active = v.active;
              r.searchText = `${v.name} ${v.label ?? ''} ${v.sku} ${v.barcode ?? ''}`.toLowerCase();
              r.unitsJson = JSON.stringify(v.units); r.image = v.image ?? null;
            };
            const row = existing.get(v.id);
            return row ? row.prepareUpdate(apply) : table.prepareCreate((r) => { r._raw.id = v.id; apply(r); });
          }),
          ...chunk.flatMap((v) => [
            ...(v.barcode ? [{ code: v.barcode, unitId: v.units.find((u) => u.isBase)?.unitId ?? v.units[0]?.unitId ?? '' }] : []),
            ...v.units.filter((u) => u.barcode).map((u) => ({ code: u.barcode!, unitId: u.unitId })),
          ].map((b) => codes.prepareCreate((r) => { r.code = b.code; r.variantId = v.id; r.unitId = b.unitId; }))),
        ];
        await this.db.batch(...ops);
      });
    }
  }
}

export class WatermelonOutbox implements OutboxRepo {
  constructor(private readonly db: Database) {}
  private table() { return this.db.get<OutboxRow>('outbox'); }

  async add(sale: PosSale) {
    await this.db.write(async () => {
      await this.table().create((r) => { r.clientId = sale.clientId; r.status = sale.status; r.soldAt = sale.soldAt; r.payload = JSON.stringify(sale); });
    });
  }
  async pending() {
    const rows = await this.table().query(Q.where('status', 'queued'), Q.sortBy('sold_at', Q.asc)).fetch();
    return rows.map((r) => JSON.parse(r.payload) as PosSale);
  }
  async update(clientId: string, patch: Partial<PosSale>) {
    await this.db.write(async () => {
      const [row] = await this.table().query(Q.where('client_id', clientId)).fetch();
      if (!row) return;
      const next = { ...(JSON.parse(row.payload) as PosSale), ...patch };
      await row.update((r) => { r.status = next.status; r.payload = JSON.stringify(next); });
    });
  }
  async since(isoDay: string) {
    const rows = await this.table().query(Q.where('sold_at', Q.gte(isoDay))).fetch();
    return rows.map((r) => JSON.parse(r.payload) as PosSale);
  }
}

export class WatermelonState implements StateRepo {
  constructor(private readonly db: Database) {}

  private async get<T>(key: string, fallback: T): Promise<T> {
    const [row] = await this.db.get<KvRow>('kv').query(Q.where('key', key)).fetch();
    return row ? (JSON.parse(row.value) as T) : fallback;
  }
  private async set(key: string, value: unknown): Promise<void> {
    await this.db.write(async () => {
      const table = this.db.get<KvRow>('kv');
      const [row] = await table.query(Q.where('key', key)).fetch();
      const v = JSON.stringify(value);
      if (row) await row.update((r) => { r.value = v; });
      else await table.create((r) => { r.key = key; r.value = v; });
    });
  }

  /** Small app-level values (rider outbox, cached run sheet). */
  kvGet<T>(key: string, fallback: T) { return this.get<T>(key, fallback); }
  kvSet(key: string, value: unknown) { return this.set(key, value); }

  getPriceBook() { return this.get<PriceBook | null>('price_book', null); }
  setPriceBook(b: PriceBook) { return this.set('price_book', b); }
  getAllocations() { return this.get<Record<string, number>>('allocations', {}); }
  setAllocations(a: Record<string, number>) { return this.set('allocations', a); }
  getCustomers() { return this.get<PosCustomer[]>('customers', []); }
  async upsertCustomers(c: PosCustomer[]) {
    const m = new Map((await this.getCustomers()).map((x) => [x.id, x]));
    for (const x of c) m.set(x.id, x);
    await this.set('customers', [...m.values()]);
  }
  getCarts() { return this.get<PosCart[]>('carts', []); }
  setCarts(c: PosCart[]) { return this.set('carts', c); }
  getMeta() { return this.get<{ lastSyncAt: string | null }>('meta', { lastSyncAt: null }); }
  setMeta(m: { lastSyncAt: string | null }) { return this.set('meta', m); }
}
