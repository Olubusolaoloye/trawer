import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVICE } from '../src/claims';
import { createProduct } from './catalog';
import { addBuyer, addStaff, createBusiness, expectPgError, pool, rpc, sql, type TestBusiness } from './helpers';

let biz: TestBusiness;
let manager: Awaited<ReturnType<typeof addStaff>>;
let cashier: Awaited<ReturnType<typeof addStaff>>;
let wax: Awaited<ReturnType<typeof createProduct>>;
let lace: Awaited<ReturnType<typeof createProduct>>;
let chidi: string;
const lagosDay = (offset = 0) => new Date(Date.now() + 3600_000 + offset * 86400_000).toISOString().slice(0, 10);
const today = lagosDay();

async function sale(items: { variant_id: string; unit_id?: string; qty: number }[], customer: string | null, opts: { channel?: string; daysAgo?: number } = {}) {
  const o = await rpc<any>(SERVICE, 'public.place_order', [JSON.stringify({ business_id: biz.id, channel: opts.channel ?? 'whatsapp', customer_id: customer ?? undefined, items, buyer_name: customer ? undefined : 'Walk-in' })]);
  await sql(`select app.apply_payment($1, $2, null, $3, 'transfer')`, [biz.id, o.id, o.total_kobo]);
  if (opts.daysAgo) await sql(`update orders set confirmed_at = now() - make_interval(days => $2) where id = $1`, [o.id, opts.daysAgo]);
  return o;
}

beforeAll(async () => {
  biz = await createBusiness('Reports Co');
  manager = await addStaff(biz, 'manager');
  cashier = await addStaff(biz, 'cashier');
  // wax: ₦100 a piece, costs ₦60; cartons of 12. lace: ₦250, no cost recorded.
  wax = await createProduct(biz, [{ price: 10_000, stock: 500, cost: 6_000 }], { name: 'Hollandais wax', cartonFactor: 12 });
  lace = await createProduct(biz, [{ price: 25_000, stock: 100 }], { name: 'Swiss lace' });
  chidi = (await addBuyer(biz, 'retailer')).customerId;

  await sale([{ variant_id: wax.variantIds[0]!, unit_id: wax.cartonUnitId, qty: 1 }], chidi);          // 12 pcs: ₦1,200 sales, ₦720 cost
  await sale([{ variant_id: wax.variantIds[0]!, qty: 3 }, { variant_id: lace.variantIds[0]!, qty: 2 }], null, { channel: 'pos' }); // ₦300 (+₦180 cost) + ₦500 (no cost)
  // cost goes up later: the old sales keep their cost
  await sql(`update variant_costs set cost_kobo = 9_000 where variant_id = $1`, [wax.variantIds[0]]);
  // previous period (8 days ago) and things that must not count
  await sale([{ variant_id: wax.variantIds[0]!, qty: 5 }], chidi, { daysAgo: 8 });
  const cancelled = await rpc<any>(SERVICE, 'public.place_order', [JSON.stringify({ business_id: biz.id, channel: 'web', customer_id: chidi, items: [{ variant_id: wax.variantIds[0]!, qty: 50 }] })]);
  await rpc(SERVICE, 'public.cancel_order', [cancelled.id, 'test']).catch(() => sql(`update orders set status = 'cancelled' where id = $1`, [cancelled.id]));
  const returned = await sale([{ variant_id: lace.variantIds[0]!, qty: 1 }], chidi);
  await sql(`update orders set fulfilment_status = 'returned' where id = $1`, [returned.id]);
});
afterAll(async () => { await pool.end(); });

describe('reports', () => {
  it('summary: sales, profit from the cost at the time of sale, cost coverage, expenses, previous period', async () => {
    await rpc(biz.owner, 'public.save_expense', [biz.id, null, 'transport', 15_000, today, 'Keke to Balogun', 'cash']);
    const r = await rpc<any>(manager, 'public.report_summary', [biz.id, lagosDay(-6), today, null]);
    expect(r).toMatchObject({
      sales_kobo: 200_000, orders: 2, units: 17, avg_order_kobo: 100_000, costs_visible: true,
      cost_kobo: 90_000,                   // 15 pcs × ₦60 (snapshot), not the new ₦90
      gross_profit_kobo: 60_000,           // on the ₦1,500 of costed sales
      cost_coverage_pct: 75,               // ₦500 of lace had no cost
      expenses_kobo: 15_000, net_profit_kobo: 45_000,
      previous: { sales_kobo: 50_000, orders: 1, gross_profit_kobo: 5_000 }, // sold after the cost rose to ₦90
    });
    expect(r.days).toHaveLength(7);
    expect(r.days.at(-1)).toMatchObject({ sales_kobo: 200_000, gross_profit_kobo: 60_000, orders: 2 });
    expect(r.channels.map((c: any) => [c.channel, c.sales_kobo])).toEqual([['pos', 80_000], ['whatsapp', 120_000]].sort((a, b) => (b[1] as number) - (a[1] as number)));
    expect(r.expense_categories).toEqual([{ category: 'transport', amount_kobo: 15_000, entries: 1 }]);
    // channel filter
    expect((await rpc<any>(manager, 'public.report_summary', [biz.id, lagosDay(-6), today, 'pos'])).sales_kobo).toBe(80_000);
  });

  it('products and units: carton vs piece, missing cost flagged', async () => {
    const r = await rpc<any>(biz.owner, 'public.report_products', [biz.id, lagosDay(-6), today, null, 100]);
    const w = r.products.find((p: any) => p.name === 'Hollandais wax');
    expect(w).toMatchObject({ base_qty: 15, sales_kobo: 150_000, cost_kobo: 90_000, gross_profit_kobo: 60_000, margin_pct: 40, missing_cost: false, base_unit: 'piece' });
    expect(w.by_unit.map((u: any) => [u.unit, u.qty])).toEqual([['carton', 1], ['piece', 3]]);
    expect(r.products.find((p: any) => p.name === 'Swiss lace')).toMatchObject({ sales_kobo: 50_000, missing_cost: true, gross_profit_kobo: null });
    expect(r.units.map((u: any) => u.unit).sort()).toEqual(['carton', 'piece']);
  });

  it('best customers (walk-ins grouped) with what they owe', async () => {
    const r = await rpc<any>(biz.owner, 'public.report_customers', [biz.id, lagosDay(-6), today, null, 10]);
    expect(r.customers.map((c: any) => [c.name, c.sales_kobo, c.orders])).toEqual([['Buyer retailer', 120_000, 1], ['Walk-in customers', 80_000, 1]]);
  });

  it('stock value at cost and retail, missing costs counted, slow movers listed', async () => {
    const r = await rpc<any>(biz.owner, 'public.report_stock_value', [biz.id]);
    // wax: 500 − 12 − 3 − 5 = 480 pcs; lace: 100 − 2 − 1 (returned order keeps its sale movement until restocked) = 97
    expect(r).toMatchObject({ units: 577, retail_value_kobo: 480 * 10_000 + 97 * 25_000, cost_value_kobo: 480 * 9_000, variants_without_cost: 1 });
    expect(r.categories[0]).toMatchObject({ category: 'Fabrics', units: 577 });
  });

  it('expenses: only managers/owners, edit and delete are audited, deleted ones disappear', async () => {
    await expectPgError(rpc(cashier, 'public.save_expense', [biz.id, null, 'rent', 1_000, today, null, 'cash']), 'permission_denied');
    await expectPgError(rpc(manager, 'public.save_expense', [biz.id, null, 'rent', 1_000, lagosDay(5), null, 'cash']), 'bad_expense_date');
    await expectPgError(rpc(manager, 'public.save_expense', [biz.id, null, 'lottery', 1_000, today, null, 'cash']), /check constraint|violates/);
    const id = await rpc<string>(manager, 'public.save_expense', [biz.id, null, 'rent', 5_000_000, today, 'Shop rent November', 'transfer']);
    await rpc(manager, 'public.save_expense', [biz.id, id, 'rent', 4_500_000, today, 'Shop rent November (discount)', 'transfer']);
    await rpc(manager, 'public.delete_expense', [id]);
    const actions = (await sql(`select action from audit_log where entity_id = $1 order by id`, [id])).map((r) => r.action);
    expect(actions).toEqual(['expense.added', 'expense.changed', 'expense.deleted']);
    expect((await rpc<any>(manager, 'public.report_summary', [biz.id, today, today, null])).expenses_kobo).toBe(15_000);
  });

  it('cashiers cannot see reports; date ranges are bounded', async () => {
    await expectPgError(rpc(cashier, 'public.report_summary', [biz.id, today, today, null]), 'permission_denied');
    await expectPgError(rpc(biz.owner, 'public.report_summary', [biz.id, today, lagosDay(-1), null]), 'bad_date_range');
    await expectPgError(rpc(biz.owner, 'public.report_summary', [biz.id, lagosDay(-800), today, null]), 'bad_date_range');
  });
});
