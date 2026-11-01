import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolvePrice } from '@trawer/core/pricing';
import { ANON, SERVICE, withClaims } from '../src/claims';
import { loadPriceBook } from '../src/pricebook';
import { createProduct, type TestProduct } from './catalog';
import { addBuyer, addStaff, createBusiness, expectPgError, pool, q, sql, type TestBusiness } from './helpers';

let biz: TestBusiness;
let product: TestProduct;
let wholesaler: Awaited<ReturnType<typeof addBuyer>>;
let pending: Awaited<ReturnType<typeof addBuyer>>;
let retailBuyer: Awaited<ReturnType<typeof addBuyer>>;

beforeAll(async () => {
  biz = await createBusiness('Pricing Co');
  product = await createProduct(biz, [{ colour: 'Red', price: 10_000, stock: 100 }, { colour: 'Blue', price: 12_000, stock: 100 }]);
  const [v1, v2] = product.variantIds;
  await q(biz.owner.mfa, `insert into tier_prices (business_id, tier_id, variant_id, price_kobo) values ($1,$2,$3,7000), ($1,$2,$4,8000), ($1,$5,$3,9000)`,
    [biz.id, biz.wholesaleTierId, v1, v2, biz.retailerTierId]);
  await q(biz.owner.mfa, `insert into volume_breaks (business_id, variant_id, tier_id, min_qty, price_kobo) values ($1,$2,null,12,9500), ($1,$2,$3,120,6800)`,
    [biz.id, v1, biz.wholesaleTierId]);
  wholesaler = await addBuyer(biz, 'wholesaler');
  pending = await addBuyer(biz, 'wholesaler', { approve: false });
  retailBuyer = await addBuyer(biz, 'retail_buyer');
});

afterAll(async () => {
  await pool.end();
});

const quote = (who: Parameters<typeof q>[0], variant: string, customer: string | null, qty: number, channel = 'web') =>
  q(who, `select (r).unit_price_kobo::int price, (r).source from (select public.resolve_price($1, $2, $3, $4::sales_channel) r) x`,
    [variant, customer, qty, channel]).then((rows) => rows[0]);

describe('resolve_price', () => {
  it('approved wholesaler gets the tier price at any quantity, on every channel', async () => {
    const v1 = product.variantIds[0]!;
    for (const channel of ['web', 'whatsapp', 'instagram', 'pos']) {
      for (const qty of [1, 5, 12]) {
        expect(await quote(wholesaler, v1, wholesaler.customerId, qty, channel)).toEqual({ price: 7000, source: 'tier' });
      }
    }
    expect(await quote(wholesaler, v1, wholesaler.customerId, 120)).toEqual({ price: 6800, source: 'tier_volume' });
  });

  it('pending wholesaler and anonymous shoppers get retail / volume prices', async () => {
    const v1 = product.variantIds[0]!;
    expect(await quote(pending, v1, pending.customerId, 1)).toEqual({ price: 10000, source: 'retail' });
    expect(await quote(ANON, v1, null, 12)).toEqual({ price: 9500, source: 'volume' });
  });

  it('a buyer cannot quote using someone else’s customer id', async () => {
    const v1 = product.variantIds[0]!;
    expect(await quote(retailBuyer, v1, wholesaler.customerId, 1)).toEqual({ price: 10000, source: 'retail' });
    expect(await quote(ANON, v1, wholesaler.customerId, 1)).toEqual({ price: 10000, source: 'retail' });
  });

  it('staff (e.g. a POS cashier) can quote for any customer of the business', async () => {
    const cashier = await addStaff(biz, 'cashier');
    expect(await quote(cashier, product.variantIds[0]!, wholesaler.customerId, 1, 'pos')).toEqual({ price: 7000, source: 'tier' });
  });

  it('quote_prices uses the signed-in buyer automatically', async () => {
    const rows = await q(wholesaler, `select variant_id, unit_price_kobo::int p, source from public.quote_prices($1) order by p`, [product.variantIds]);
    expect(rows.map((r) => r.p)).toEqual([7000, 8000]);
    const anon = await q(ANON, `select unit_price_kobo::int p from public.quote_prices($1) order by p`, [product.variantIds]);
    expect(anon.map((r) => r.p)).toEqual([10000, 12000]);
  });

  it('per-customer override wins and needs prices.manage + MFA to set', async () => {
    const v2 = product.variantIds[1]!;
    await expectPgError(
      q(biz.owner, `insert into customer_price_overrides (business_id, customer_id, variant_id, price_kobo) values ($1,$2,$3,5000)`, [biz.id, wholesaler.customerId, v2]),
      '42501',
    );
    await q(biz.owner.mfa, `insert into customer_price_overrides (business_id, customer_id, variant_id, price_kobo) values ($1,$2,$3,5000)`, [biz.id, wholesaler.customerId, v2]);
    expect(await quote(wholesaler, v2, wholesaler.customerId, 1)).toEqual({ price: 5000, source: 'override' });
    const audit = await sql(`select count(*)::int n from audit_log where business_id = $1 and action like 'price.customer_price_overrides.%'`, [biz.id]);
    expect(audit[0]!.n).toBe(1);
  });
});

describe('price visibility', () => {
  it('only the approved wholesaler (and staff) can read wholesale tier prices', async () => {
    expect((await q(wholesaler, `select * from tier_prices where tier_id = $1`, [biz.wholesaleTierId])).length).toBe(2);
    expect(await q(pending, `select * from tier_prices`)).toEqual([]);
    expect(await q(retailBuyer, `select * from tier_prices`)).toEqual([]);
    await expectPgError(q(ANON, `select * from tier_prices`), '42501');
  });

  it('anonymous shoppers see general volume breaks but not tier ones', async () => {
    const rows = await q(ANON, `select tier_id, min_qty from volume_breaks where variant_id = $1`, [product.variantIds[0]]);
    expect(rows).toEqual([{ tier_id: null, min_qty: 12 }]);
  });
});

describe('SQL ↔ TypeScript parity', () => {
  it('resolve_price and core resolvePrice agree on a randomised matrix', async () => {
    const pb = await createBusiness('Parity Co');
    const rand = mulberry32(42);
    const p = await createProduct(pb, Array.from({ length: 6 }, () => ({ price: 1000 + Math.floor(rand() * 9000) })));
    const [vip] = await q(pb.owner.mfa, `insert into customer_tiers (business_id, name, is_wholesale) values ($1, 'VIP', true) returning id`, [pb.id]);
    const tiers = [pb.wholesaleTierId, pb.retailerTierId, vip!.id as string];
    for (const v of p.variantIds) {
      for (const t of tiers) {
        if (rand() < 0.7) await q(pb.owner.mfa, `insert into tier_prices (business_id, tier_id, variant_id, price_kobo) values ($1,$2,$3,$4)`, [pb.id, t, v, 500 + Math.floor(rand() * 5000)]);
        if (rand() < 0.4) await q(pb.owner.mfa, `insert into volume_breaks (business_id, variant_id, tier_id, min_qty, price_kobo) values ($1,$2,$3,$4,$5)`, [pb.id, v, t, 2 + Math.floor(rand() * 100), 400 + Math.floor(rand() * 5000)]);
      }
      for (const minQty of [6, 12, 60]) {
        if (rand() < 0.5) await q(pb.owner.mfa, `insert into volume_breaks (business_id, variant_id, tier_id, min_qty, price_kobo) values ($1,$2,null,$3,$4)`, [pb.id, v, minQty, 400 + Math.floor(rand() * 5000)]);
      }
    }
    const buyers = [
      await addBuyer(pb, 'wholesaler'),
      await addBuyer(pb, 'wholesaler', { approve: false }),
      await addBuyer(pb, 'retailer'),
      await addBuyer(pb, 'retail_buyer'),
    ];
    const vipBuyer = await addBuyer(pb, 'wholesaler', { approve: false });
    await q(pb.owner, `select public.review_wholesale_application($1, true, $2, null)`, [vipBuyer.customerId, vip!.id]);
    buyers.push(vipBuyer);
    for (const v of p.variantIds.slice(0, 3)) {
      await q(pb.owner.mfa, `insert into customer_price_overrides (business_id, customer_id, variant_id, price_kobo) values ($1,$2,$3,$4)`, [pb.id, buyers[0]!.customerId, v, 333]);
    }

    const book = await withClaims(pool, SERVICE, (c) => loadPriceBook(c, pb.id));
    const customers: (string | null)[] = [null, ...buyers.map((b) => b.customerId)];
    const qtys = [0, 1, 2, 5, 6, 11, 12, 13, 59, 60, 61, 99, 100, 500];
    let checked = 0;
    for (const v of p.variantIds) {
      for (const cust of customers) {
        const rows = await sql(`select qty, (public.resolve_price($1, $2, qty)).* from unnest($3::int[]) qty`, [v, cust, qtys]);
        for (const r of rows) {
          const ts = resolvePrice(book, v, cust, r.qty);
          expect({ v, cust, qty: r.qty, price: ts.unitPriceKobo, source: ts.source, tier: ts.tierId })
            .toEqual({ v, cust, qty: r.qty, price: r.unit_price_kobo, source: r.source, tier: r.tier_id });
          checked += 1;
        }
      }
    }
    expect(checked).toBe(6 * 6 * qtys.length);
  });
});

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
