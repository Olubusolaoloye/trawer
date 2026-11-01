import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVICE } from '../src/claims';
import { createProduct, ledgerMismatches, level } from './catalog';
import { addBuyer, addStaff, createBusiness, expectPgError, pool, q, rpc, sql, type TestBusiness, type TestUser } from './helpers';

let biz: TestBusiness;
let cashier: TestUser;
let deviceA: string;
let deviceB: string;

async function device(name: string, b = biz): Promise<string> {
  const [d] = await q(b.owner, `insert into devices (business_id, location_id, name, platform) values ($1, $2, $3, 'android') returning id`, [b.id, b.locationId, name]);
  return d!.id;
}

const sale = (who: TestUser, payload: Record<string, unknown>) =>
  rpc<any>(who, 'public.sync_pos_sale', [JSON.stringify({ client_id: randomUUID(), sold_at: new Date().toISOString(), ...payload })]);

beforeAll(async () => {
  biz = await createBusiness('POS Co');
  cashier = await addStaff(biz, 'cashier');
  deviceA = await device('Till A');
  deviceB = await device('Till B');
});

afterAll(async () => {
  expect(await ledgerMismatches()).toEqual([]);
  await pool.end();
});

describe('sync_pos_sale', () => {
  it('draws from the device allocation first: shared availability does not change', async () => {
    const p = await createProduct(biz, [{ price: 1000, stock: 20 }]);
    const v = p.variantIds[0]!;
    await rpc(biz.owner, 'public.allocate_to_device', [deviceA, v, 6]);
    expect(await level(v)).toEqual({ on_hand: 20, reserved: 0, allocated: 6, available: 14 });
    const r = await sale(cashier, {
      device_id: deviceA, items: [{ variant_id: v, qty: 4, unit_price_kobo: 1000 }],
      payments: [{ client_id: randomUUID(), method: 'cash', amount_kobo: 4000 }],
    });
    expect(r).toMatchObject({ status: 'applied', conflicts: [], flags: [] });
    expect(await level(v)).toEqual({ on_hand: 16, reserved: 0, allocated: 2, available: 14 });
    const [o] = await sql(`select status, payment_status, fulfilment_status, channel, device_id from orders where id = $1`, [r.order_id]);
    expect(o).toEqual({ status: 'confirmed', payment_status: 'paid', fulfilment_status: 'collected', channel: 'pos', device_id: deviceA });
  });

  it('is idempotent: re-sending the same client_id changes nothing', async () => {
    const p = await createProduct(biz, [{ price: 500, stock: 10 }]);
    const v = p.variantIds[0]!;
    await rpc(biz.owner, 'public.allocate_to_device', [deviceA, v, 5]);
    const payload = { client_id: randomUUID(), device_id: deviceA, items: [{ variant_id: v, qty: 2, unit_price_kobo: 500 }], payments: [{ client_id: randomUUID(), method: 'cash', amount_kobo: 1000 }] };
    const first = await sale(cashier, payload);
    const results = await Promise.all(Array.from({ length: 5 }, () => sale(cashier, payload)));
    expect(results.every((r) => r.status === 'duplicate' && r.order_id === first.order_id)).toBe(true);
    expect(await level(v)).toMatchObject({ on_hand: 8, allocated: 3 });
    const [n] = await sql(`select count(*)::int n from payments where order_id = $1`, [first.order_id]);
    expect(n!.n).toBe(1);
  });

  it('beyond the allocation it takes from the shared pool; beyond that it records a conflict, never negative stock', async () => {
    const p = await createProduct(biz, [{ price: 100, stock: 5 }]);
    const v = p.variantIds[0]!;
    await rpc(biz.owner, 'public.allocate_to_device', [deviceA, v, 2]);
    const r = await sale(cashier, { device_id: deviceA, items: [{ variant_id: v, qty: 8, unit_price_kobo: 100 }], payments: [{ client_id: randomUUID(), method: 'cash', amount_kobo: 800 }] });
    expect(r.status).toBe('conflict');
    expect(r.conflicts).toEqual([{ variant_id: v, short: 3 }]);
    expect(await level(v)).toEqual({ on_hand: 0, reserved: 0, allocated: 0, available: 0 });
    const [alert] = await sql(`select kind, qty, device_id from stock_alerts where order_id = $1`, [r.order_id]);
    expect(alert).toEqual({ kind: 'oversell_conflict', qty: 3, device_id: deviceA });
    const [item] = await sql(`select conflict_qty from order_items where order_id = $1`, [r.order_id]);
    expect(item!.conflict_qty).toBe(3);
    const [o] = await sql(`select needs_attention from orders where id = $1`, [r.order_id]);
    expect(o!.needs_attention).toContain('stock_conflict');
  });

  it('does not take stock that is reserved for online orders', async () => {
    const p = await createProduct(biz, [{ price: 100, stock: 3 }]);
    const v = p.variantIds[0]!;
    const buyer = await addBuyer(biz, 'retail_buyer');
    await rpc(buyer, 'public.place_order', [JSON.stringify({ business_id: biz.id, items: [{ variant_id: v, qty: 3 }] })]);
    const r = await sale(cashier, { device_id: deviceB, items: [{ variant_id: v, qty: 1, unit_price_kobo: 100 }] });
    expect(r.conflicts).toEqual([{ variant_id: v, short: 1 }]);
    expect(await level(v)).toEqual({ on_hand: 3, reserved: 3, allocated: 0, available: 0 });
  });

  it('flags stale offline prices and credit sales by a cashier for review', async () => {
    const p = await createProduct(biz, [{ price: 1000, stock: 10 }]);
    const r = await sale(cashier, { device_id: deviceA, items: [{ variant_id: p.variantIds[0], qty: 1, unit_price_kobo: 900 }], payments: [] });
    expect(r.flags).toEqual(['offline_price_mismatch', 'credit_sale_needs_approval']);
    const [o] = await sql(`select is_credit, balance_kobo, total_kobo from orders where id = $1`, [r.order_id]);
    expect(o).toEqual({ is_credit: true, balance_kobo: 900, total_kobo: 900 });
  });

  it('records the sale at the time it happened offline (never in the future)', async () => {
    const p = await createProduct(biz, [{ price: 100, stock: 10 }]);
    const soldAt = new Date(Date.now() - 3 * 3600_000).toISOString();
    const r = await sale(cashier, { device_id: deviceA, sold_at: soldAt, items: [{ variant_id: p.variantIds[0], qty: 1, unit_price_kobo: 100 }] });
    const [o] = await sql(`select created_at from orders where id = $1`, [r.order_id]);
    expect(Math.abs(new Date(o!.created_at).getTime() - new Date(soldAt).getTime())).toBeLessThan(1000);
    const future = await sale(cashier, { device_id: deviceA, sold_at: new Date(Date.now() + 86400_000).toISOString(), items: [{ variant_id: p.variantIds[0], qty: 1, unit_price_kobo: 100 }] });
    const [f] = await sql(`select created_at <= now() ok from orders where id = $1`, [future.order_id]);
    expect(f!.ok).toBe(true);
  });

  it('only staff of the device’s business with sales.create can sync', async () => {
    const other = await createBusiness('Other POS');
    const outsider = await addStaff(other, 'cashier');
    const p = await createProduct(biz, [{ price: 100, stock: 10 }]);
    await expectPgError(sale(outsider, { device_id: deviceA, items: [{ variant_id: p.variantIds[0], qty: 1, unit_price_kobo: 100 }] }), 'permission_denied');
    const rider = await addStaff(biz, 'rider');
    await expectPgError(sale(rider, { device_id: deviceA, items: [{ variant_id: p.variantIds[0], qty: 1, unit_price_kobo: 100 }] }), 'permission_denied');
    const foreign = await createProduct(other, [{ price: 100, stock: 10 }]);
    await expectPgError(sale(cashier, { device_id: deviceA, items: [{ variant_id: foreign.variantIds[0], qty: 1, unit_price_kobo: 100 }] }), 'unknown_variant');
  });
});

describe('two devices offline + online storm', () => {
  it('syncing both devices while online buyers race never makes stock negative and accounts for every unit', async () => {
    const p = await createProduct(biz, [{ price: 1000, stock: 15 }], { name: 'Storm' });
    const v = p.variantIds[0]!;
    await rpc(biz.owner, 'public.allocate_to_device', [deviceA, v, 5]);
    await rpc(biz.owner, 'public.allocate_to_device', [deviceB, v, 5]);
    // While offline: Till A sold 8 (3 over its allocation), Till B sold 6 (1 over).
    const offlineA = Array.from({ length: 8 }, () => ({ client_id: randomUUID(), device_id: deviceA, items: [{ variant_id: v, qty: 1, unit_price_kobo: 1000 }], payments: [{ client_id: randomUUID(), method: 'cash', amount_kobo: 1000 }] }));
    const offlineB = Array.from({ length: 6 }, () => ({ client_id: randomUUID(), device_id: deviceB, items: [{ variant_id: v, qty: 1, unit_price_kobo: 1000 }], payments: [{ client_id: randomUUID(), method: 'card_terminal', amount_kobo: 1000 }] }));
    const cashier2 = await addStaff(biz, 'cashier');
    const buyers = await Promise.all(Array.from({ length: 4 }, () => addBuyer(biz, 'retail_buyer')));

    let minAvailable = Infinity;
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        const l = await level(v);
        minAvailable = Math.min(minAvailable, l.available, l.on_hand, l.allocated);
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    const jobs = [
      ...offlineA.map((s) => sale(cashier, s)),
      ...offlineB.map((s) => sale(cashier2, s)),
      ...offlineA.slice(0, 3).map((s) => sale(cashier, s)), // retries of the same sales
      ...Array.from({ length: 10 }, (_, i) => rpc(buyers[i % 4]!, 'public.place_order', [JSON.stringify({ business_id: biz.id, items: [{ variant_id: v, qty: 1 }] })])),
    ];
    const results = await Promise.allSettled(jobs);
    watching = false;
    await watcher;

    expect(minAvailable).toBeGreaterThanOrEqual(0);
    const syncs = results.slice(0, 17).map((r) => (r as PromiseFulfilledResult<any>).value);
    expect(results.slice(0, 17).every((r) => r.status === 'fulfilled')).toBe(true);
    expect(new Set(syncs.filter((s) => s.status !== 'duplicate').map((s) => s.client_id)).size).toBe(14);
    const online = results.slice(17).filter((r) => r.status === 'fulfilled').length;

    const l = await level(v);
    const [c] = await sql(`select coalesce(sum(qty),0)::int short from stock_alerts where variant_id = $1 and kind = 'oversell_conflict'`, [v]);
    // Every one of the 15 units is either sold offline, reserved online, or still available;
    // anything the tills sold beyond that is a recorded conflict.
    const soldOffline = 14 - c!.short;
    expect(soldOffline + online + l.available).toBe(15);
    expect(l).toMatchObject({ allocated: 0, reserved: online, on_hand: 15 - soldOffline });
    expect(await ledgerMismatches(biz.id)).toEqual([]);
  });
});

describe('cash-up', () => {
  it('summarises takings per staff per day and records the variance (audited)', async () => {
    const cashier3 = await addStaff(biz, 'cashier');
    const p = await createProduct(biz, [{ price: 1000, stock: 50 }]);
    for (const method of ['cash', 'cash', 'card_terminal', 'transfer']) {
      await sale(cashier3, { device_id: deviceA, items: [{ variant_id: p.variantIds[0], qty: 1, unit_price_kobo: 1000 }], payments: [{ client_id: randomUUID(), method, amount_kobo: 1000 }] });
    }
    const today = (await sql(`select (now() at time zone 'Africa/Lagos')::date::text d`))[0]!.d;
    const summary = await rpc(cashier3, 'public.cash_up_summary', [biz.id, today, null]);
    expect(summary).toEqual({ cash: 2000, card_terminal: 1000, transfer: 1000 });
    const up = await rpc<any>(cashier3, 'public.submit_cash_up', [biz.id, today, 1500, deviceA, 'short 500']);
    expect(up.variance_kobo).toBe(-500);
    const [a] = await sql(`select count(*)::int n from audit_log where action = 'cash_up.variance' and entity_id = $1`, [up.id]);
    expect(a!.n).toBe(1);
    // another cashier cannot read this cashier's summary; a manager can
    await expectPgError(rpc(cashier, 'public.cash_up_summary', [biz.id, today, cashier3.id]), '42501');
    expect(await rpc(biz.owner, 'public.cash_up_summary', [biz.id, today, cashier3.id])).toEqual(summary);
    expect(await q(cashier, `select * from cash_ups where id = $1`, [up.id])).toEqual([]);
  });
});

void SERVICE;

describe('dashboard_today', () => {
  it('summarises the day for staff, hides profit from roles without costs.view, refuses outsiders', async () => {
    const b = await createBusiness('Dash Co');
    const p = await createProduct(b, [{ price: 1000, cost: 600, stock: 50 }]);
    const [d] = await q(b.owner, `insert into devices (business_id, location_id, name) values ($1,$2,'Till') returning id`, [b.id, b.locationId]);
    const till = await addStaff(b, 'cashier');
    await rpc(till, 'public.sync_pos_sale', [JSON.stringify({ device_id: d!.id, client_id: randomUUID(), items: [{ variant_id: p.variantIds[0], qty: 3, unit_price_kobo: 1000 }], payments: [{ client_id: randomUUID(), method: 'cash', amount_kobo: 3000 }] })]);
    const owner = await rpc<any>(b.owner, 'public.dashboard_today', [b.id]);
    expect(owner).toMatchObject({ taken_today_kobo: 3000, sales_today_kobo: 3000, profit_today_kobo: 1200, orders_today: 1, by_channel: { pos: 3000 } });
    expect(owner.best_sellers[0]).toMatchObject({ qty: 3 });
    const cashierView = await rpc<any>(till, 'public.dashboard_today', [b.id]);
    expect(cashierView.profit_today_kobo).toBeNull();
    const outsider = await createBusiness('Nosy Co');
    await expectPgError(rpc(outsider.owner, 'public.dashboard_today', [b.id]), '42501');
  });
});
