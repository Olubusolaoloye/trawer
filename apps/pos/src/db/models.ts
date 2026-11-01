/**
 * WatermelonDB models with explicit accessors (equivalent to @field/@text, without needing the
 * Babel decorators transform).
 */
import { Model } from '@nozbe/watermelondb';

type Raw = string | number | boolean | null;
function col<T extends Raw>(name: string) {
  return {
    get(this: Model): T { return (this._raw as unknown as Record<string, Raw>)[name] as T; },
    set(this: Model, v: T) { this._setRaw(name, v); },
    enumerable: true,
    configurable: true,
  };
}
function define(cls: typeof Model, cols: Record<string, string>) {
  for (const [prop, column] of Object.entries(cols)) Object.defineProperty(cls.prototype, prop, col(column));
}

export interface VariantRow {
  productId: string;
  name: string;
  label: string | null;
  sku: string;
  searchText: string;
  unitsJson: string;
  image: string | null;
  active: boolean;
}
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class VariantRow extends Model {
  static override table = 'variants';
}
define(VariantRow, { productId: 'product_id', name: 'name', label: 'label', sku: 'sku', searchText: 'search_text', unitsJson: 'units_json', image: 'image', active: 'active' });

export interface BarcodeRow {
  code: string;
  variantId: string;
  unitId: string;
}
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class BarcodeRow extends Model {
  static override table = 'barcodes';
}
define(BarcodeRow, { code: 'code', variantId: 'variant_id', unitId: 'unit_id' });

export interface OutboxRow {
  clientId: string;
  status: string;
  soldAt: string;
  payload: string;
}
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class OutboxRow extends Model {
  static override table = 'outbox';
}
define(OutboxRow, { clientId: 'client_id', status: 'status', soldAt: 'sold_at', payload: 'payload' });

export interface KvRow {
  key: string;
  value: string;
}
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class KvRow extends Model {
  static override table = 'kv';
}
define(KvRow, { key: 'key', value: 'value' });
