import pg from 'pg';
import { ANON, SERVICE, withClaims, type Claims } from '@trawer/db';
import { env } from './env';

pg.types.setTypeParser(20, (v) => Number(v)); // bigint (kobo) → number; values stay < 2^53
pg.types.setTypeParser(1700, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v); // date stays 'YYYY-MM-DD'

const globalForPool = globalThis as unknown as { __trawerPool?: pg.Pool };
export const pool =
  globalForPool.__trawerPool ??
  new pg.Pool({ connectionString: env.DATABASE_URL, max: 10, idleTimeoutMillis: 30_000, application_name: 'trawer-web' });
if (env.NODE_ENV !== 'production') globalForPool.__trawerPool = pool;

export type Tx = pg.PoolClient;

/** Query as the signed-in user (or anon). RLS applies to every statement. */
export function withUser<T>(claims: Claims | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withClaims(pool, claims ?? ANON, fn);
}

/** Trusted server work only (webhooks, cron, system jobs). Bypasses RLS. */
export function withService<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withClaims(pool, SERVICE, fn);
}

export async function one<T = any>(tx: Tx, text: string, params: unknown[] = []): Promise<T | null> {
  const r = await tx.query(text, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = any>(tx: Tx, text: string, params: unknown[] = []): Promise<T[]> {
  return (await tx.query(text, params)).rows as T[];
}

/** Map Postgres errors raised by our functions to user-facing error codes. */
export function dbErrorCode(err: unknown): string {
  const e = err as { message?: string; code?: string };
  // Our own functions raise snake_case codes (register_first, mfa_required, ...); keep them.
  if (e?.code === '42501') return e.message && /^[a-z_]+$/.test(e.message) ? e.message : 'permission_denied';
  if (e?.code === 'P0429') return 'rate_limited';
  if (e?.code === 'P0002') return 'not_found';
  if (e?.code === 'P0409') return e.message === 'insufficient_allocation' ? 'insufficient_allocation' : 'insufficient_stock';
  if (e?.code === '23505') return 'duplicate';
  if (e?.code === '22023' || e?.code === '23514') return e.message ?? 'invalid_input';
  return 'server_error';
}
