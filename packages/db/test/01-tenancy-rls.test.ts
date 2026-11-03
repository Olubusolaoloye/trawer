import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ANON, SERVICE } from '../src/claims';
import {
  addBuyer,
  addStaff,
  createBusiness,
  createUser,
  expectPgError,
  pool,
  q,
  rpc,
  sql,
  type TestBusiness,
} from './helpers';
import { populateBusiness } from './fixtures';

const PUBLIC_CATALOGUE = new Set(['products', 'product_variants', 'variant_images', 'product_units', 'units', 'volume_breaks']);

let A: TestBusiness;
let B: TestBusiness;

beforeAll(async () => {
  A = await createBusiness('Alpha Fabrics');
  B = await createBusiness('Beta Shoes');
  await populateBusiness(A);
  await populateBusiness(B);
});

afterAll(async () => {
  await pool.end();
});

describe('RLS coverage', () => {
  it('has row level security enabled on every table in public', async () => {
    const rows = await sql<{ relname: string }>(`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
      order by 1`);
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('has a business_id column on every tenant table', async () => {
    const globalTables = new Set(['businesses', 'consents', 'rate_limits', 'webhook_events', 'units', 'privacy_requests']);
    const rows = await sql<{ table_name: string }>(`
      select t.table_name from information_schema.tables t
      where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
        and not exists (select 1 from information_schema.columns c
                        where c.table_schema = 'public' and c.table_name = t.table_name and c.column_name = 'business_id')
      order by 1`);
    expect(rows.map((r) => r.table_name).filter((t) => !globalTables.has(t))).toEqual([]);
  });
});

describe('tenant isolation', () => {
  it("business A's owner cannot read any of business B's rows, in any table", async () => {
    const tables = await sql<{ table_name: string }>(`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'business_id'
        and table_name in (select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE')
      order by 1`);
    expect(tables.length).toBeGreaterThan(5);
    const leaks: string[] = [];
    let populated = 0;
    for (const { table_name } of tables) {
      const [total] = await sql(`select count(*)::int as n from public.${table_name} where business_id = $1`, [B.id]);
      if (total!.n > 0) populated += 1;
      try {
        const sqlText = `select count(*)::int as n from public.${table_name} where business_id = $1`;
        const visible = await q(A.owner.mfa, sqlText, [B.id]);
        // Storefront catalogue tables are public by design: A may see exactly what an anonymous
        // shopper sees (active products), never more (drafts, archived, private rows).
        const allowed = PUBLIC_CATALOGUE.has(table_name) ? (await q(ANON, sqlText, [B.id]))[0]!.n : 0;
        if (visible[0]!.n > allowed) leaks.push(`${table_name} (${visible[0]!.n} rows, ${allowed} public)`);
      } catch (err) {
        // no SELECT grant at all is also isolation
        if ((err as { code?: string }).code !== '42501') throw err;
      }
    }
    expect(leaks).toEqual([]);
    expect(populated).toBeGreaterThan(5);
  });

  it("business A's owner cannot update or delete B's rows in any table", async () => {
    const tables = await sql<{ table_name: string }>(`
      select c.table_name from information_schema.columns c
      join information_schema.tables t on t.table_name = c.table_name and t.table_schema = c.table_schema
      where c.table_schema = 'public' and c.column_name = 'business_id' and t.table_type = 'BASE TABLE'
      order by 1`);
    for (const { table_name } of tables) {
      // Each statement either errors (no grant) or affects zero rows (RLS); both are isolation.
      for (const stmt of [
        `update public.${table_name} set business_id = business_id where business_id = $1`,
        `delete from public.${table_name} where business_id = $1`,
      ]) {
        try {
          const rows = await q(A.owner.mfa, `with x as (${stmt} returning 1) select count(*)::int as n from x`, [B.id]);
          expect.soft(rows[0]!.n, `${table_name}: ${stmt}`).toBe(0);
        } catch (err) {
          expect.soft((err as { code?: string }).code, `${table_name}: ${stmt}`).toBe('42501');
        }
      }
    }
    const [still] = await sql('select count(*)::int as n from customers where business_id = $1', [B.id]);
    expect(still!.n).toBeGreaterThan(0);
  });

  it("business A's owner cannot insert rows into business B", async () => {
    await expectPgError(
      q(A.owner.mfa, `insert into customers (business_id, phone, name) values ($1, '+2348000000001', 'x')`, [B.id]),
      '42501',
    );
    await expectPgError(
      q(A.owner.mfa, `insert into locations (business_id, name) values ($1, 'Sneaky')`, [B.id]),
      '42501',
    );
    await expectPgError(
      q(A.owner.mfa, `insert into customer_tiers (business_id, name) values ($1, 'Sneaky')`, [B.id]),
      '42501',
    );
    await expectPgError(rpc(A.owner.mfa, 'public.invite_staff', [B.id, '+2348000000002', 'cashier', 'x']), 'permission_denied');
    await expectPgError(
      rpc(A.owner.mfa, 'public.set_payout_account', [B.id, '058', 'GTB', '0123456789', 'X']),
      'permission_denied',
    );
  });

  it('a business-B staff role change is impossible from business A', async () => {
    const [staff] = await sql(`select id from staff_members where business_id = $1 and role <> 'owner' limit 1`, [B.id]);
    await expectPgError(rpc(A.owner.mfa, 'public.set_staff_role', [staff!.id, 'manager', null]), 'permission_denied');
  });
});

describe('roles and permissions', () => {
  it('cashier cannot invite staff, set payout accounts or approve wholesalers', async () => {
    const cashier = await addStaff(A, 'cashier');
    await expectPgError(rpc(cashier.mfa, 'public.invite_staff', [A.id, '+2348000000003', 'cashier', 'x']), 'permission_denied');
    await expectPgError(rpc(cashier.mfa, 'public.set_payout_account', [A.id, '058', 'GTB', '0123456789', 'X']), 'permission_denied');
    const buyer = await addBuyer(A, 'wholesaler', { approve: false });
    await expectPgError(rpc(cashier, 'public.review_wholesale_application', [buyer.customerId, true, null, null]), 'permission_denied');
    await expectPgError(
      q(cashier, 'update customers set tier_id = $2 where id = $1', [buyer.customerId, A.wholesaleTierId]),
      'permission_denied',
    );
  });

  it('owner needs a TOTP (aal2) session for staff, payout and price tier changes', async () => {
    await expectPgError(rpc(A.owner, 'public.invite_staff', [A.id, '+2348000000004', 'cashier', 'x']), 'mfa_required');
    await expectPgError(rpc(A.owner, 'public.set_payout_account', [A.id, '058', 'GTB', '0123456789', 'X']), 'mfa_required');
    await expectPgError(q(A.owner, `insert into customer_tiers (business_id, name) values ($1, 'VIP')`, [A.id]), '42501');
    // With MFA it works, and is audited.
    await rpc(A.owner.mfa, 'public.set_payout_account', [A.id, '058', 'GTB', '0123456789', 'Alpha Fabrics']);
    const rows = await q(A.owner.mfa, `insert into customer_tiers (business_id, name) values ($1, 'VIP') returning id`, [A.id]);
    expect(rows).toHaveLength(1);
    const audit = await sql(`select action from audit_log where business_id = $1 and action = 'payout.updated'`, [A.id]);
    expect(audit.length).toBeGreaterThanOrEqual(2);
  });

  it('business-level permission overrides take effect', async () => {
    const cashier = await addStaff(A, 'cashier');
    await expectPgError(rpc(cashier, 'app.require_permission', [A.id, 'stock.adjust']), 'permission_denied');
    await q(A.owner.mfa, `insert into roles_permissions (business_id, role, permission, allowed) values ($1, 'cashier', 'stock.adjust', true)`, [A.id]);
    await rpc(cashier, 'app.require_permission', [A.id, 'stock.adjust']);
    // Override cannot be planted into another business.
    await expectPgError(
      q(A.owner.mfa, `insert into roles_permissions (business_id, role, permission, allowed) values ($1, 'cashier', 'stock.adjust', true)`, [B.id]),
      '42501',
    );
    await q(A.owner.mfa, `delete from roles_permissions where business_id = $1 and role = 'cashier' and permission = 'stock.adjust'`, [A.id]);
  });

  it('owner role cannot be granted or removed through set_staff_role', async () => {
    const [owner] = await sql(`select id from staff_members where business_id = $1 and role = 'owner'`, [A.id]);
    await expectPgError(rpc(A.owner.mfa, 'public.set_staff_role', [owner!.id, 'cashier', null]), 'owner_role_locked');
  });

  it('staff login and role changes are audited', async () => {
    const m = await addStaff(A, 'store_keeper');
    const [staff] = await sql(`select id from staff_members where user_id = $1`, [m.id]);
    await rpc(A.owner.mfa, 'public.set_staff_role', [staff!.id, 'manager', null]);
    const actions = (await sql(`select action from audit_log where business_id = $1 and (entity_id = $2 or entity_id = $3)`, [A.id, m.id, staff!.id])).map((r) => r.action);
    expect(actions).toContain('staff.login');
    expect(actions).toContain('staff.role_changed');
  });
});

describe('buyers', () => {
  it('a wholesaler registers as pending and only gets the tier after approval', async () => {
    const buyer = await addBuyer(A, 'wholesaler', { approve: false });
    let [c] = await q(buyer, 'select wholesale_status, tier_id from customers where id = $1', [buyer.customerId]);
    expect(c).toMatchObject({ wholesale_status: 'pending', tier_id: null });
    await rpc(A.owner, 'public.review_wholesale_application', [buyer.customerId, true, null, null]);
    [c] = await q(buyer, 'select wholesale_status, tier_id from customers where id = $1', [buyer.customerId]);
    expect(c).toMatchObject({ wholesale_status: 'approved', tier_id: A.wholesaleTierId });
  });

  it('wholesale registration requires a CAC number or shop photo', async () => {
    const u = await createUser();
    await expectPgError(
      rpc(u, 'public.register_buyer', [A.slug, 'wholesaler', 'No proof', null, null, null, 'v1', false]),
      'wholesale_proof_required',
    );
  });

  it('a retailer gets the retailer tier immediately; consent is captured', async () => {
    const buyer = await addBuyer(A, 'retailer');
    const [c] = await q(buyer, 'select tier_id from customers where id = $1', [buyer.customerId]);
    expect(c!.tier_id).toBe(A.retailerTierId);
    const consents = await q(buyer, 'select kind, granted from consents where user_id = $1 order by kind', [buyer.id]);
    expect(consents.map((r) => r.kind)).toEqual(['marketing', 'privacy', 'terms']);
  });

  it('a buyer cannot promote themselves to a wholesale tier', async () => {
    const buyer = await addBuyer(A, 'retail_buyer');
    // No update policy for buyers at all → zero rows, no change.
    const rows = await q(buyer, 'update customers set tier_id = $2 where id = $1 returning id', [buyer.customerId, A.wholesaleTierId]);
    expect(rows).toHaveLength(0);
    // Re-registering as wholesaler does not grant the tier either.
    await rpc(buyer, 'public.register_buyer', [A.slug, 'wholesaler', 'Me', null, 'RC1', null, 'v1', false]);
    const [c] = await sql('select tier_id, wholesale_status from customers where id = $1', [buyer.customerId]);
    expect(c).toMatchObject({ wholesale_status: 'pending' });
    expect(c!.tier_id).not.toBe(A.wholesaleTierId);
  });

  it('a buyer sees only their own customer row and cannot see other buyers', async () => {
    const b1 = await addBuyer(A, 'retail_buyer');
    await addBuyer(A, 'retail_buyer');
    const rows = await q(b1, 'select id from customers');
    expect(rows.map((r) => r.id)).toEqual([b1.customerId]);
  });

  it('anonymous visitors can read active storefront businesses but not customers or staff', async () => {
    expect((await q(ANON, 'select slug from businesses where id = $1', [A.id])).length).toBe(1);
    expect(await q(ANON, 'select id from customers')).toEqual([]);
    await expectPgError(q(ANON, 'select id from staff_members'), '42501');
  });
});

describe('rate limits', () => {
  it('blocks after the configured number of OTP attempts per window', async () => {
    const subject = `+234801${Date.now() % 10_000_000}`;
    for (let i = 0; i < 3; i++) await rpc(SERVICE, 'public.check_rate_limit', ['otp', subject, 3, 600]);
    await expectPgError(rpc(SERVICE, 'public.check_rate_limit', ['otp', subject, 3, 600]), 'rate_limited');
    // Nobody but the server can touch the counters (otherwise a stranger could lock someone out).
    await expectPgError(rpc(ANON, 'public.check_rate_limit', ['otp', subject, 1000, 600]), /permission denied/);
    // Stored key does not contain the phone number.
    const keys = await sql(`select key from rate_limits where key like 'otp:%'`);
    expect(keys.some((k) => k.key.includes(subject))).toBe(false);
  });
});

describe('phone normalisation', () => {
  it('normalises Nigerian formats to E.164', async () => {
    const rows = await sql(`select app.normalize_phone('0803 123 4567') a, app.normalize_phone('2348031234567') b, app.normalize_phone('+234 803-123-4567') c`);
    expect(rows[0]).toEqual({ a: '+2348031234567', b: '+2348031234567', c: '+2348031234567' });
  });
});
