import { appSchema, tableSchema } from '@nozbe/watermelondb';

export const schema = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'variants',
      columns: [
        { name: 'product_id', type: 'string' },
        { name: 'name', type: 'string' },
        { name: 'label', type: 'string', isOptional: true },
        { name: 'sku', type: 'string', isIndexed: true },
        { name: 'search_text', type: 'string' },
        { name: 'units_json', type: 'string' },
        { name: 'image', type: 'string', isOptional: true },
        { name: 'active', type: 'boolean' },
      ],
    }),
    // Every scannable code: variant barcodes and pack (carton/bundle) barcodes.
    tableSchema({
      name: 'barcodes',
      columns: [
        { name: 'code', type: 'string', isIndexed: true },
        { name: 'variant_id', type: 'string', isIndexed: true },
        { name: 'unit_id', type: 'string' },
      ],
    }),
    tableSchema({
      name: 'outbox',
      columns: [
        { name: 'client_id', type: 'string', isIndexed: true },
        { name: 'status', type: 'string', isIndexed: true },
        { name: 'sold_at', type: 'string', isIndexed: true },
        { name: 'payload', type: 'string' },
      ],
    }),
    tableSchema({
      name: 'kv',
      columns: [
        { name: 'key', type: 'string', isIndexed: true },
        { name: 'value', type: 'string' },
      ],
    }),
  ],
});
