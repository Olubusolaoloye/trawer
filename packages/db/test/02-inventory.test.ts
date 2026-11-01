import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANON } from '../src/claims';
import { createProduct, ledgerMismatches, level, stubOrder, units } from './catalog';
import { addStaff, createBusiness, expectPgError, pool, q, rpc, sql, type TestBusiness, type TestUser } from './helpers';

let biz: TestBusiness;
let other: TestBusiness;
let cashier: TestUser;
let keeper: TestUser;

const SVC = { role: 'service_role' as const };

beforeAll(async () => {
  biz = await createBusiness('Inventory Co');
  other = await createBusiness('Other Co');
  cashier = await addStaff(biz, 'cashier');
  keeper = await addStaff(biz, 'store_keeper');
});

afterAll(async () => {
  expect(await ledgerMismatches()).toEqual([]);
  await pool.end();
});

describe('products, variants, units', () => {
  it('auto-generates SKU and a valid EAN-13 barcode per variant', async () => {
    const p = await createProduct(biz, [{ colour: 'Red', price: 150_000 }, { colour: 'Blue', price: 150_000 }]);
    const rows = await sql(`select sku, barcode from product_variants where product_id = $1 order by position`, [p.id]);
    expect(rows[0]!.sku).toMatch(/^TRW-\d{6}$/);
    expect(rows[0]!.sku).not.toBe(rows[1]!.sku);
    for (const { barcode } of rows) {
      expect(barcode).toMatch(/^20\d{11}$/);
      const digits = barcode.split('').map(Number);
      const sum = digits.slice(0, 12).reduce((s: number, d: number, i: number) => s + d * (i % 2 ? 3 : 1), 0);
      expect((10 - (sum % 10)) % 10).toBe(digits[12]);
    }
  });

  it('creates the base unit automatically and converts packs to base units', async () => {
    const p = await createProduct(biz, [{ price: 50_000 }], { cartonFactor: 24 });
    const u = await units();
    const [r] = await sql(`select public.to_base_qty($1, $2, 3) carton, public.to_base_qty($1, $3, 5) piece`, [p.id, u.carton, u.piece]);
    expect(r).toEqual({ carton: 72, piece: 5 });
    await expectPgError(sql(`select public.to_base_qty($1, (select id from units where name='bale' and business_id is null), 1)`, [p.id]), 'unit_not_sellable');
  });

  it('cashier can create a draft but cannot publish it or change prices on live products', async () => {
    const draft = await createProduct(biz, [{ price: 10_000 }], { status: 'draft', as: cashier });
    // still a draft: price can be tuned by the creator
    await q(cashier, `update product_variants set retail_price_kobo = 12000 where id = $1`, [draft.variantIds[0]]);
    await expectPgError(q(cashier, `update products set status = 'active' where id = $1`, [draft.id]), 'permission_denied');
    await q(biz.owner, `update products set status = 'active' where id = $1`, [draft.id]);
    // live now: cashier's update matches no rows (RLS) — price unchanged
    const res = await q(cashier, `update product_variants set retail_price_kobo = 1 where id = $1 returning id`, [draft.variantIds[0]]);
    expect(res).toHaveLength(0);
    const [v] = await sql(`select retail_price_kobo from product_variants where id = $1`, [draft.variantIds[0]]);
    expect(v!.retail_price_kobo).toBe(12000);
  });

  it('store keeper granted products.manage still needs prices.manage to change live prices', async () => {
    const p = await createProduct(biz, [{ price: 10_000 }]);
    await q(biz.owner.mfa, `insert into roles_permissions (business_id, role, permission) values ($1, 'store_keeper', 'products.manage')`, [biz.id]);
    await expectPgError(
      q(keeper, `update product_variants set retail_price_kobo = 1 where id = $1`, [p.variantIds[0]]),
      'permission_denied',
    );
    await q(biz.owner.mfa, `delete from roles_permissions where business_id = $1 and role = 'store_keeper' and permission = 'products.manage'`, [biz.id]);
  });

  it('price changes are audited', async () => {
    const p = await createProduct(biz, [{ price: 10_000 }]);
    await q(biz.owner, `update product_variants set retail_price_kobo = 11000 where id = $1`, [p.variantIds[0]]);
    const [a] = await sql(`select before, after from audit_log where action = 'price.retail_changed' and entity_id = $1`, [p.variantIds[0]]);
    expect(a).toEqual({ before: { retail_price_kobo: 10000 }, after: { retail_price_kobo: 11000 } });
  });

  it('cost prices are invisible to the storefront and to cashiers', async () => {
    const p = await createProduct(biz, [{ price: 10_000, cost: 7_000 }]);
    expect(await q(ANON, `select * from variant_costs where variant_id = $1`, [p.variantIds[0]]).catch((e) => e.code)).toBe('42501');
    expect(await q(cashier, `select * from variant_costs where variant_id = $1`, [p.variantIds[0]])).toEqual([]);
    expect(await q(biz.owner, `select cost_kobo from variant_costs where variant_id = $1`, [p.variantIds[0]])).toEqual([{ cost_kobo: 7000 }]);
  });

  it('anonymous storefront sees active products only', async () => {
    const live = await createProduct(biz, [{ price: 1 }]);
    const draft = await createProduct(biz, [{ price: 1 }], { status: 'draft' });
    const ids = (await q(ANON, `select id from products where id = any($1)`, [[live.id, draft.id]])).map((r) => r.id);
    expect(ids).toEqual([live.id]);
    expect(await q(ANON, `select id from product_variants where product_id = $1`, [draft.id])).toEqual([]);
  });
});

describe('stock ledger', () => {
  it('receive increases on_hand and writes a movement; nothing writes stock directly', async () => {
    const p = await createProduct(biz, [{ price: 100, stock: 30 }]);
    expect(await level(p.variantIds[0]!)).toEqual({ on_hand: 30, reserved: 0, allocated: 0, available: 30 });
    await expectPgError(q(biz.owner, `update stock_levels set on_hand = 999 where variant_id = $1`, [p.variantIds[0]]), '42501');
    await expectPgError(
      q(biz.owner, `insert into stock_movements (business_id, variant_id, location_id, type, qty_delta) values ($1,$2,$3,'receive',5)`,
        [biz.id, p.variantIds[0], biz.locationId]),
      '42501',
    );
    await expectPgError(rpc(biz.owner, 'public.reserve_stock', [randomUUID(), JSON.stringify([{ variant_id: p.variantIds[0], qty: 1 }])]), '42501');
  });

  it('reserve_stock is all-or-nothing and reports every short line', async () => {
    const p = await createProduct(biz, [{ price: 1, stock: 5 }, { price: 1, stock: 2 }, { price: 1, stock: 9 }]);
    const [a, b, c] = p.variantIds as [string, string, string];
    const order = await stubOrder(biz.id);
    const err = await rpc(SVC, 'public.reserve_stock', [order, JSON.stringify([
      { variant_id: a, qty: 3 }, { variant_id: b, qty: 3 }, { variant_id: c, qty: 10 },
    ])]).catch((e) => e);
    expect(err.message).toBe('insufficient_stock');
    const detail = JSON.parse(err.detail);
    expect(detail.map((d: { variant_id: string }) => d.variant_id).sort()).toEqual([b, c].sort());
    expect((await level(a)).reserved).toBe(0);
  });

  it('merges duplicate lines of the same variant', async () => {
    const p = await createProduct(biz, [{ price: 1, stock: 5 }]);
    const v = p.variantIds[0]!;
    await expectPgError(rpc(SVC, 'public.reserve_stock', [await stubOrder(biz.id), JSON.stringify([{ variant_id: v, qty: 3 }, { variant_id: v, qty: 3 }])]), 'insufficient_stock');
    await rpc(SVC, 'public.reserve_stock', [await stubOrder(biz.id), JSON.stringify([{ variant_id: v, qty: 2 }, { variant_id: v, qty: 3 }])]);
    expect(await level(v)).toMatchObject({ reserved: 5, available: 0 });
  });

  it('commit_sale and release_reservation are idempotent', async () => {
    const p = await createProduct(biz, [{ price: 1, stock: 10 }]);
    const v = p.variantIds[0]!;
    const o1 = await stubOrder(biz.id);
    const o2 = await stubOrder(biz.id);
    await rpc(SVC, 'public.reserve_stock', [o1, JSON.stringify([{ variant_id: v, qty: 4 }])]);
    await rpc(SVC, 'public.reserve_stock', [o2, JSON.stringify([{ variant_id: v, qty: 3 }])]);
    expect(await level(v)).toEqual({ on_hand: 10, reserved: 7, allocated: 0, available: 3 });
    expect(await rpc(SVC, 'public.commit_sale', [o1, 'web'])).toBe(4);
    expect(await rpc(SVC, 'public.commit_sale', [o1, 'web'])).toBe(0);
    expect(await rpc(SVC, 'public.release_reservation', [o2, 'expired'])).toBe(3);
    expect(await rpc(SVC, 'public.release_reservation', [o2, 'expired'])).toBe(0);
    // releasing a committed order does nothing
    expect(await rpc(SVC, 'public.release_reservation', [o1, 'cancel'])).toBe(0);
    expect(await level(v)).toEqual({ on_hand: 6, reserved: 0, allocated: 0, available: 6 });
  });

  it('refuses items from another business in one reservation', async () => {
    const mine = await createProduct(biz, [{ price: 1, stock: 5 }]);
    const theirs = await createProduct(other, [{ price: 1, stock: 5 }]);
    await expectPgError(
      rpc(SVC, 'public.reserve_stock', [await stubOrder(biz.id), JSON.stringify([
        { variant_id: mine.variantIds[0], qty: 1 }, { variant_id: theirs.variantIds[0], qty: 1 },
      ])]),
      'cross_tenant_items',
    );
  });

  it('adjust_stock needs stock.adjust and a reason, cannot go negative, and is audited', async () => {
    const p = await createProduct(biz, [{ price: 1, stock: 5 }]);
    const v = p.variantIds[0]!;
    await expectPgError(rpc(cashier, 'public.adjust_stock', [v, -1, 'damaged', null]), 'permission_denied');
    await expectPgError(rpc(biz.owner, 'public.adjust_stock', [v, -1, '  ', null]), 'reason_required');
    await expectPgError(rpc(biz.owner, 'public.adjust_stock', [v, -6, 'lost', null]), 'insufficient_stock');
    await rpc(biz.owner, 'public.adjust_stock', [v, -2, 'water damage', null]);
    expect((await level(v)).on_hand).toBe(3);
    const [a] = await sql(`select after from audit_log where action = 'stock.adjusted' and entity_id = $1`, [v]);
    expect(a!.after).toMatchObject({ delta: -2, on_hand: 3, reason: 'water damage' });
  });

  it('count_stock writes the difference', async () => {
    const p = await createProduct(biz, [{ price: 1, stock: 12 }]);
    expect(await rpc(biz.owner, 'public.count_stock', [p.variantIds[0], 9, null, 'monthly count'])).toBe(-3);
    expect((await level(p.variantIds[0]!)).on_hand).toBe(9);
  });

  it('cannot reduce on_hand below what is reserved', async () => {
    const p = await createProduct(biz, [{ price: 1, stock: 5 }]);
    const v = p.variantIds[0]!;
    await rpc(SVC, 'public.reserve_stock', [await stubOrder(biz.id), JSON.stringify([{ variant_id: v, qty: 4 }])]);
    await expectPgError(rpc(biz.owner, 'public.adjust_stock', [v, -2, 'theft', null]), 'insufficient_stock');
  });

  it('device allocation removes stock from the shared pool', async () => {
    const p = await createProduct(biz, [{ price: 1, stock: 10 }]);
    const v = p.variantIds[0]!;
    const [d] = await q(biz.owner, `insert into devices (business_id, location_id, name) values ($1, $2, 'Till 1') returning id`, [biz.id, biz.locationId]);
    await rpc(keeper, 'public.allocate_to_device', [d!.id, v, 6]);
    expect(await level(v)).toEqual({ on_hand: 10, reserved: 0, allocated: 6, available: 4 });
    await expectPgError(rpc(SVC, 'public.reserve_stock', [await stubOrder(biz.id), JSON.stringify([{ variant_id: v, qty: 5 }])]), 'insufficient_stock');
    await expectPgError(rpc(keeper, 'public.allocate_to_device', [d!.id, v, 5]), 'insufficient_stock');
    await expectPgError(rpc(keeper, 'public.allocate_to_device', [d!.id, v, -7]), 'insufficient_allocation');
    await rpc(keeper, 'public.allocate_to_device', [d!.id, v, -6]);
    expect(await level(v)).toMatchObject({ allocated: 0, available: 10 });
    await expectPgError(rpc(cashier, 'public.allocate_to_device', [d!.id, v, 1]), 'permission_denied');
  });

  it('public availability endpoint hides drafts and exposes only totals', async () => {
    const live = await createProduct(biz, [{ price: 1, stock: 7 }]);
    const draft = await createProduct(biz, [{ price: 1, stock: 7 }], { status: 'draft' });
    const rows = await q(ANON, `select * from public.variant_availability($1)`, [[live.variantIds[0], draft.variantIds[0]]]);
    expect(rows).toEqual([{ variant_id: live.variantIds[0], available: 7 }]);
  });

  it('flags low stock using the variant or business threshold', async () => {
    const p = await createProduct(biz, [{ price: 1, stock: 3 }, { price: 1, stock: 50 }]);
    const rows = await q(biz.owner, `select variant_id from low_stock_variants where product_id = $1`, [p.id]);
    expect(rows.map((r) => r.variant_id)).toEqual([p.variantIds[0]]);
  });
});

describe('concurrency', () => {
  it('40 parallel reservations for the last 5 units: exactly 5 succeed', async () => {
    const p = await createProduct(biz, [{ price: 1, stock: 5 }]);
    const v = p.variantIds[0]!;
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, async () => rpc(SVC, 'public.reserve_stock', [await stubOrder(biz.id), JSON.stringify([{ variant_id: v, qty: 1 }])])),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
    for (const r of results) if (r.status === 'rejected') expect((r.reason as Error).message).toBe('insufficient_stock');
    expect(await level(v)).toEqual({ on_hand: 5, reserved: 5, allocated: 0, available: 0 });
  });

  it('opposite line order in concurrent orders does not deadlock', async () => {
    const p = await createProduct(biz, [{ price: 1, stock: 100 }, { price: 1, stock: 100 }]);
    const [a, b] = p.variantIds as [string, string];
    const jobs = Array.from({ length: 30 }, async (_, i) =>
      rpc(SVC, 'public.reserve_stock', [await stubOrder(biz.id), JSON.stringify(i % 2
        ? [{ variant_id: a, qty: 1 }, { variant_id: b, qty: 1 }]
        : [{ variant_id: b, qty: 1 }, { variant_id: a, qty: 1 }])]));
    await Promise.all(jobs);
    expect((await level(a)).reserved).toBe(30);
    expect((await level(b)).reserved).toBe(30);
  });
});
