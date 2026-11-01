import { Database } from '@nozbe/watermelondb';
import SQLiteAdapter from '@nozbe/watermelondb/adapters/sqlite';
import { schema } from './schema';
import { BarcodeRow, KvRow, OutboxRow, VariantRow } from './models';

const adapter = new SQLiteAdapter({
  schema,
  dbName: 'trawer_pos',
  jsi: true,
  onSetUpError: (error) => console.error('database setup failed', error),
});

export const database = new Database({ adapter, modelClasses: [VariantRow, BarcodeRow, OutboxRow, KvRow] });
