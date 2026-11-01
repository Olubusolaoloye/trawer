import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect } from 'vitest';
import { withClaims, type Claims } from '../src/claims';

// numeric/bigint come back as strings by default; tests compare numbers.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 80 });

/** Superuser query (bypasses RLS) — fixtures and assertions only. */
export async function sql<R extends pg.QueryResultRow = any>(text: string, params: unknown[] = []): Promise<R[]> {
  const res = await pool.query<R>(text, params);
  return res.rows;
}

export interface TestUser {
  id: string;
  phone: string;
  claims: Claims;
  /** Same user with a TOTP-verified (aal2) session. */
  mfa: Claims;
}

let phoneCounter = 0;
export function uniquePhone(): string {
  phoneCounter += 1;
  const n = (Date.now() % 1_000_000) * 100 + phoneCounter;
  return `+23480${String(n).padStart(8, '0').slice(-8)}`;
}

export async function createUser(phone = uniquePhone()): Promise<TestUser> {
  const [row] = await sql<{ id: string }>('insert into auth.users (phone) values ($1) returning id', [phone]);
  const base: Claims = { sub: row!.id, role: 'authenticated', phone, aal: 'aal1' };
  return { id: row!.id, phone, claims: base, mfa: { ...base, aal: 'aal2' } };
}

/** Run a single statement as the given identity (own transaction, RLS applies). */
export async function q<R extends pg.QueryResultRow = any>(
  who: Claims | TestUser,
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const claims: Claims = 'claims' in who ? (who as TestUser).claims : (who as Claims);
  return withClaims(pool, claims, async (c) => (await c.query<R>(text, params)).rows);
}

export async function rpc<R = any>(who: Claims | TestUser, fn: string, args: unknown[] = []): Promise<R> {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await q(who, `select ${fn}(${placeholders}) as result`, args);
  return rows[0]?.result as R;
}

export async function expectPgError(p: Promise<unknown>, match: string | RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; code?: string };
    const text = `${e.code ?? ''} ${e.message ?? ''}`;
    if (typeof match === 'string') expect(text).toContain(match);
    else expect(text).toMatch(match);
    return;
  }
  throw new Error(`expected error matching ${String(match)} but the statement succeeded`);
}

export interface TestBusiness {
  id: string;
  slug: string;
  owner: TestUser;
  locationId: string;
  wholesaleTierId: string;
  retailerTierId: string;
}

export async function createBusiness(name = 'Test Biz'): Promise<TestBusiness> {
  const owner = await createUser();
  const slug = `t-${randomUUID().slice(0, 8)}`;
  const id = await rpc<string>(owner, 'public.create_business', [name, slug, 'wholesaler', '#123456', 'Owner']);
  const [loc] = await sql<{ id: string }>('select id from locations where business_id = $1 and is_default', [id]);
  const tiers = await sql<{ id: string; default_for: string }>(
    'select id, default_for from customer_tiers where business_id = $1',
    [id],
  );
  return {
    id,
    slug,
    owner,
    locationId: loc!.id,
    wholesaleTierId: tiers.find((t) => t.default_for === 'wholesaler')!.id,
    retailerTierId: tiers.find((t) => t.default_for === 'retailer')!.id,
  };
}

/** Invite + accept a staff member with the given role. */
export async function addStaff(biz: TestBusiness, role: string): Promise<TestUser> {
  const user = await createUser();
  await rpc(biz.owner.mfa, 'public.invite_staff', [biz.id, user.phone, role, role]);
  await q(user, 'select * from public.staff_sign_in()');
  return user;
}

/** Register a buyer at the business storefront. */
export async function addBuyer(
  biz: TestBusiness,
  type: 'wholesaler' | 'retailer' | 'retail_buyer' = 'retail_buyer',
  opts: { approve?: boolean } = {},
): Promise<TestUser & { customerId: string }> {
  const user = await createUser();
  const customerId = await rpc<string>(user, 'public.register_buyer', [
    biz.slug,
    type,
    `Buyer ${type}`,
    null,
    type === 'wholesaler' ? 'RC123456' : null,
    null,
    'v1',
    false,
  ]);
  if (type === 'wholesaler' && opts.approve !== false) {
    await rpc(biz.owner, 'public.review_wholesale_application', [customerId, true, null, null]);
  }
  return { ...user, customerId };
}
