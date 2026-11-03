import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANON, SERVICE } from '../src/claims';
import { createProduct } from './catalog';
import { addBuyer, addStaff, createBusiness, expectPgError, pool, q, rpc, sql, type TestBusiness } from './helpers';

let biz: TestBusiness;
let variant: string;

beforeAll(async () => {
  biz = await createBusiness('Privacy Co');
  variant = (await createProduct(biz, [{ price: 10_000, stock: 100 }])).variantIds[0]!;
});
afterAll(async () => { await pool.end(); });

describe('security review (automated)', () => {
  it('every SECURITY DEFINER function pins its search_path', async () => {
    const bad = await sql(`
      select n.nspname || '.' || p.proname fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'app') and p.prosecdef
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`);
    expect(bad).toEqual([]);
  });

  it('anonymous visitors have no write grants on any table', async () => {
    const bad = await sql(`
      select c.relname || ':' || priv x from pg_class c join pg_namespace n on n.oid = c.relnamespace,
        unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) priv
      where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('anon', c.oid, priv)`);
    expect(bad).toEqual([]);
  });

  it('only the reviewed storefront functions are open to anonymous visitors', async () => {
    const open = (await sql(`
      select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') order by 1`)).map((r) => r.proname);
    // Each one is safe for strangers: public catalogue prices (own tier only), stock levels, unit maths,
    // a document by unguessable token, and order/customer lookups that return only the caller's own data.
    expect(open).toEqual(['document_by_token', 'get_order', 'my_customer_id', 'quote_prices', 'resolve_price', 'to_base_qty', 'variant_availability']);
  });

  it('app roles cannot read Vault secrets', async () => {
    await expectPgError(q(ANON, `select * from vault.decrypted_secrets`), /permission denied/);
    await expectPgError(q(biz.owner.mfa, `select * from vault.decrypted_secrets`), /permission denied/);
  });
});

describe('NDPA: your data', () => {
  async function buyerWithOrder(paid: 'full' | 'none' | 'part') {
    const b = await addBuyer(biz, 'retailer');
    const o = await rpc<any>(SERVICE, 'public.place_order', [JSON.stringify({ business_id: biz.id, channel: 'web', customer_id: b.customerId, items: [{ variant_id: variant, qty: 2 }],
      delivery_method: 'delivery', delivery_address: { line1: '12 Upper Iweka Road', city: 'Onitsha', state: 'Anambra' } })]);
    if (paid === 'full') await sql(`select app.apply_payment($1, $2, null, $3, 'transfer')`, [biz.id, o.id, o.total_kobo]);
    if (paid === 'part') { await rpc(biz.owner, 'public.confirm_on_credit', [o.id, null, null]); await sql(`select app.apply_payment($1, $2, null, 5000, 'cash')`, [biz.id, o.id]); }
    return { b, o };
  }

  it('export: everything about me across shops, nothing about anyone else', async () => {
    const { b, o } = await buyerWithOrder('full');
    const out = await rpc<any>(b, 'public.my_data_export', []);
    expect(out.account.phone).toBe(b.phone);
    expect(out.shops).toHaveLength(1);
    expect(out.shops[0]).toMatchObject({ shop: 'Privacy Co', profile: { name: 'Buyer retailer' } });
    expect(out.shops[0].orders[0]).toMatchObject({ order_number: o.order_number, total_kobo: 20_000, delivery_address: { line1: '12 Upper Iweka Road' } });
    expect(out.consents.length).toBeGreaterThan(0);
    await expectPgError(rpc(ANON, 'public.my_data_export', []), /permission denied|not_authenticated/);
  });

  it('consent can be withdrawn per shop and is recorded, not overwritten', async () => {
    const { b } = await buyerWithOrder('none');
    await rpc(b, 'public.set_my_consent', [biz.id, 'marketing', true]);
    await rpc(b, 'public.set_my_consent', [biz.id, 'marketing', false]);
    const rows = await sql(`select granted from consents where user_id = $1 and kind = 'marketing' order by created_at`, [b.id]);
    expect(rows.map((r) => r.granted).slice(-2)).toEqual([true, false]);  // after the sign-up record
    expect((await sql(`select marketing_opt_in from customers where id = $1`, [b.customerId]))[0]!.marketing_opt_in).toBe(false);
    await expectPgError(rpc(b, 'public.set_my_consent', [biz.id, 'sell_my_data', true]), 'invalid_consent');
  });

  it('delete my account: refused while I owe the shop or am staff; otherwise anonymised, sign-in removed, sales kept', async () => {
    const owing = await buyerWithOrder('part');
    await expectPgError(rpc(owing.b, 'public.delete_my_account', ['DELETE']), 'balance_outstanding');

    const staff = await addStaff(biz, 'cashier');
    await expectPgError(rpc(staff, 'public.delete_my_account', ['DELETE']), 'staff_must_leave_first');

    const { b, o } = await buyerWithOrder('full');
    const pending = await rpc<any>(SERVICE, 'public.place_order', [JSON.stringify({ business_id: biz.id, channel: 'web', customer_id: b.customerId, items: [{ variant_id: variant, qty: 1 }] })]);
    await expectPgError(rpc(b, 'public.delete_my_account', ['yes']), 'confirm_required');
    expect(await rpc(b, 'public.delete_my_account', ['DELETE'])).toEqual({ erased_shops: 1 });

    const [cu] = await sql(`select name, phone, user_id, default_address from customers where id = $1`, [b.customerId]);
    expect(cu).toMatchObject({ name: 'Erased customer', user_id: null, default_address: null });
    expect(cu!.phone).toMatch(/^\+000\d{11}$/);
    const [ord] = await sql(`select total_kobo, delivery_address, status from orders where id = $1`, [o.id]);
    expect(ord).toEqual({ total_kobo: 20_000, delivery_address: null, status: 'confirmed' });   // the shop's sales record stays
    expect((await sql(`select status from orders where id = $1`, [pending.id]))[0]!.status).toBe('cancelled');
    expect(await sql(`select 1 from auth.users where id = $1`, [b.id])).toEqual([]);
    expect((await sql(`select count(*)::int n from audit_log where entity_id = $1 and action = 'customer.erased'`, [b.customerId]))[0]!.n).toBe(1);
  });

  it('retention: long-inactive customers with nothing owed are anonymised by the daily job', async () => {
    const { b, o } = await buyerWithOrder('full');
    const active = await buyerWithOrder('full');
    await sql(`update customers set created_at = now() - interval '8 years' where id = $1`, [b.customerId]);
    await sql(`update orders set created_at = now() - interval '7 years' where id = $1`, [o.id]);
    await expectPgError(rpc(biz.owner, 'public.apply_retention', []), /forbidden|permission/);
    const r = await rpc<any>(SERVICE, 'public.apply_retention', []);
    expect(r.customers_erased).toBeGreaterThanOrEqual(1);
    expect((await sql(`select name from customers where id = $1`, [b.customerId]))[0]!.name).toBe('Erased customer');
    expect((await sql(`select name from customers where id = $1`, [active.b.customerId]))[0]!.name).toBe('Buyer retailer');
  });
});
