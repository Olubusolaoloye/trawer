import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(here, '..', 'supabase', 'migrations');
export const SHIM_FILE = join(here, '..', 'test', 'supabase-shim.sql');
export const SEED_FILE = join(here, '..', 'supabase', 'seed.sql');

export async function listMigrations(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
}

/** Drop + recreate `dbName` on the server behind `adminUrl`, apply shim and all migrations. */
export async function resetDatabase(adminUrl: string, dbName: string, opts: { seed?: boolean } = {}): Promise<string> {
  if (!/^[a-z0-9_]+$/.test(dbName)) throw new Error('unsafe database name');
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${dbName} with (force)`);
    await admin.query(`create database ${dbName}`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const target = url.toString();
  const client = new pg.Client({ connectionString: target });
  await client.connect();
  try {
    await client.query(await readFile(SHIM_FILE, 'utf8'));
    for (const file of await listMigrations()) {
      try {
        await client.query(await readFile(join(MIGRATIONS_DIR, file), 'utf8'));
      } catch (err) {
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
    if (opts.seed) await client.query(await readFile(SEED_FILE, 'utf8'));
  } finally {
    await client.end();
  }
  return target;
}
