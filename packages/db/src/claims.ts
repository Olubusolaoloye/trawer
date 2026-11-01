import type { PoolClient, Pool } from 'pg';

/** JWT claims as issued by Supabase Auth (subset Trawer relies on). */
export interface Claims {
  sub?: string;
  role: 'anon' | 'authenticated' | 'service_role';
  phone?: string;
  aal?: 'aal1' | 'aal2';
  [k: string]: unknown;
}

export const ANON: Claims = { role: 'anon' };
export const SERVICE: Claims = { role: 'service_role' };

/**
 * Run `fn` inside a transaction that impersonates an API role exactly like PostgREST does:
 * `SET LOCAL ROLE <role>` + `request.jwt.claims`. RLS therefore applies to every statement.
 * The transaction is committed if `fn` resolves and rolled back if it throws.
 */
export async function withClaims<T>(pool: Pool, claims: Claims, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await applyClaims(client, claims);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Apply claims to an already-open transaction. */
export async function applyClaims(client: PoolClient, claims: Claims): Promise<void> {
  const role = claims.role;
  if (role !== 'anon' && role !== 'authenticated' && role !== 'service_role') {
    throw new Error(`invalid role ${String(role)}`);
  }
  // role is from a closed set, so interpolation is safe; claims go through a bind parameter.
  await client.query(`set local role ${role}`);
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
}
