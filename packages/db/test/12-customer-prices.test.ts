import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProduct, type TestProduct } from './catalog';
import { addBuyer, addStaff, createBusiness, expectPgError, pool, q, rpc, sql, type TestBusiness } from './helpers';

let biz: TestBusiness;
let other: TestBusiness;
let wax: TestProduct;
let otherProduct: TestProduct;
let chidi: Awaited<ReturnType<typeof addBuyer>>;
let ngozi: Awaited<ReturnType<typeof addBuyer>>;
let manager: Awaited<ReturnType<typeof addStaff>>;
let cashier: Awaited<ReturnType<typeof addStaff>>;

beforeAll(async () => {
  biz = await createBusiness('Special Prices Co');
  other = await createBusiness('Other Co');
  wax = await createProduct(biz, [{ colour: 'Red', price: 15_000, stock: 50 }, { colour: 'Blue', price: 15_000, stock: 50 }]);
  otherProduct = await createProduct(other, [{ price: 1_000, stock: 5 }]);
  await q(biz.owner.mfa, `insert into tier_prices (business_id, tier_id, variant_id, price_kobo) values ($1, $2, $3, 12_000)`, [biz.id, biz.wholesaleTierId, wax.variantIds[0]]);
  chidi = await addBuyer(biz, 'wholesaler');
  ngozi = await addBuyer(biz, 'wholesaler');
  manager = await addStaff(biz, 'manager');
  cashier = await addStaff(biz, 'cashier');
});
afterAll(async () => { await pool.end(); });

const price = (who: Parameters<typeof q>[0], variant: string, customer: string, channel = 'web') =>
  q(who, `select (r).unit_price_kobo::int price, (r).source from (select public.resolve_price($1, $2, 1, $3::sales_channel) r) x`, [variant, customer, channel]).then((r) => r[0]);

describe('per-customer special prices', () => {
  it('set for several colours at once; that customer gets it on every channel, others keep their tier price', async () => {
    expect(await rpc(manager.mfa, 'public.set_customer_price', [chidi.customerId, wax.variantIds, 11_000, 'Loyal since 2019'])).toBe(2);
    for (const channel of ['web', 'whatsapp', 'instagram', 'pos']) {
      expect(await price(chidi, wax.variantIds[0]!, chidi.customerId, channel)).toEqual({ price: 11_000, source: 'override' });
    }
    expect(await price(ngozi, wax.variantIds[0]!, ngozi.customerId)).toEqual({ price: 12_000, source: 'tier' });
  });

  it('updating replaces the price; clearing goes back to the tier price', async () => {
    await rpc(manager.mfa, 'public.set_customer_price', [chidi.customerId, [wax.variantIds[0]], 10_500, null]);
    expect((await price(chidi, wax.variantIds[0]!, chidi.customerId)).price).toBe(10_500);
    expect(await rpc(manager.mfa, 'public.clear_customer_price', [chidi.customerId, [wax.variantIds[0]]])).toBe(1);
    expect(await price(chidi, wax.variantIds[0]!, chidi.customerId)).toEqual({ price: 12_000, source: 'tier' });
  });

  it('needs prices.manage and a 2FA session; every change is audited', async () => {
    await expectPgError(rpc(manager, 'public.set_customer_price', [chidi.customerId, wax.variantIds, 9_000, null]), 'mfa_required');
    await expectPgError(rpc(cashier.mfa, 'public.set_customer_price', [chidi.customerId, wax.variantIds, 9_000, null]), 'permission_denied');
    // Another shop can't even see the customer (no hint that they exist).
    await expectPgError(rpc(other.owner.mfa, 'public.set_customer_price', [chidi.customerId, wax.variantIds, 9_000, null]), 'not_found');
    const audit = await sql(`select count(*)::int n from audit_log where business_id = $1 and entity = 'customer_price_overrides'`, [biz.id]);
    expect(audit[0]!.n).toBeGreaterThanOrEqual(3);
  });

  it("refuses another shop's products and bad prices", async () => {
    await expectPgError(rpc(manager.mfa, 'public.set_customer_price', [chidi.customerId, [otherProduct.variantIds[0]], 500, null]), 'invalid_variants');
    await expectPgError(rpc(manager.mfa, 'public.set_customer_price', [chidi.customerId, [wax.variantIds[0]], -1, null]), 'invalid_price');
    await expectPgError(rpc(manager.mfa, 'public.set_customer_price', [chidi.customerId, [], 500, null]), 'invalid_variants');
  });

  it('a buyer sees only their own special prices', async () => {
    await rpc(manager.mfa, 'public.set_customer_price', [chidi.customerId, [wax.variantIds[1]], 11_000, null]);
    expect(await q(ngozi, `select * from customer_price_overrides`)).toEqual([]);
    expect((await q(chidi, `select price_kobo from customer_price_overrides`)).map((r) => Number(r.price_kobo))).toEqual([11_000]);
  });
});
