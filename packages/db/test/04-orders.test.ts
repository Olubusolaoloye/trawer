import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVICE } from '../src/claims';
import { createProduct, ledgerMismatches, level, type TestProduct } from './catalog';
import { addBuyer, addStaff, createBusiness, createUser, expectPgError, pool, q, rpc, sql, type TestBusiness, type TestUser } from './helpers';

let biz: TestBusiness;
let product: TestProduct;
let wholesaler: Awaited<ReturnType<typeof addBuyer>>;
let retail: Awaited<ReturnType<typeof addBuyer>>;
let cashier: TestUser;

const order = (who: Parameters<typeof q>[0], payload: Record<string, unknown>) =>
  rpc<any>(who, 'public.place_order', [JSON.stringify({ business_id: biz.id, channel: 'web', ...payload })]);

async function giveVirtualAccount(customerId: string): Promise<string> {
  const acct = String(Math.floor(1e9 + Math.random() * 8e9));
  await sql(`insert into virtual_accounts (business_id, customer_id, provider, account_number, account_name, bank_name)
             values ($1, $2, 'paystack', $3, 'Trawer/Buyer', 'Wema Bank')`, [biz.id, customerId, acct]);
  return acct;
}

const pay = (acct: string, amount: number, ref: string = randomUUID()) =>
  rpc<any>(SERVICE, 'public.apply_virtual_account_payment', ['paystack', acct, amount, ref, new Date().toISOString(), null]);

beforeAll(async () => {
  biz = await createBusiness('Orders Co');
  product = await createProduct(biz, [{ colour: 'Red', price: 10_000, cost: 6_000, stock: 100 }, { colour: 'Blue', price: 12_000, stock: 100 }], { cartonFactor: 12 });
  await q(biz.owner.mfa, `insert into tier_prices (business_id, tier_id, variant_id, price_kobo) values ($1,$2,$3,7000)`, [biz.id, biz.wholesaleTierId, product.variantIds[0]]);
  await q(biz.owner.mfa, `insert into volume_breaks (business_id, variant_id, min_qty, price_kobo) values ($1,$2,12,9000)`, [biz.id, product.variantIds[0]]);
  wholesaler = await addBuyer(biz, 'wholesaler');
  retail = await addBuyer(biz, 'retail_buyer');
  cashier = await addStaff(biz, 'cashier');
});

afterAll(async () => {
  expect(await ledgerMismatches()).toEqual([]);
  await pool.end();
});

describe('place_order', () => {
  it('prices every line server-side with resolve_price and reserves stock', async () => {
    const before = await level(product.variantIds[0]!);
    const o = await order(wholesaler, { items: [{ variant_id: product.variantIds[0], qty: 2 }], customer_id: retail.customerId });
    expect(o.customer_id).toBe(wholesaler.customerId); // cannot order as someone else
    expect(o.status).toBe('pending');
    expect(o.total_kobo).toBe(14_000);
    expect(o.items[0]).toMatchObject({ unit_price_kobo: 7000, price_source: 'tier', base_qty: 2 });
    expect(o.items[0].unit_cost_kobo).toBeUndefined();
    expect(new Date(o.reservation_expires_at).getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
    expect((await level(product.variantIds[0]!)).reserved).toBe(before.reserved + 2);
  });

  it('converts cartons to pieces and applies volume pricing on the combined quantity', async () => {
    const o = await order(retail, { items: [
      { variant_id: product.variantIds[0], unit_id: product.cartonUnitId, qty: 1 },
      { variant_id: product.variantIds[0], qty: 3 },
    ] });
    expect(o.items.map((i: any) => i.base_qty).sort()).toEqual([12, 3]);
    expect(o.items.every((i: any) => i.unit_price_kobo === 9000 && i.price_source === 'volume')).toBe(true);
    expect(o.total_kobo).toBe(15 * 9000);
  });

  it('is idempotent on client_id', async () => {
    const client_id = randomUUID();
    const a = await order(retail, { client_id, items: [{ variant_id: product.variantIds[1], qty: 1 }] });
    const b = await order(retail, { client_id, items: [{ variant_id: product.variantIds[1], qty: 1 }] });
    expect(b.id).toBe(a.id);
    const [n] = await sql(`select count(*)::int n from orders where client_id = $1`, [client_id]);
    expect(n!.n).toBe(1);
  });

  it('rolls back the whole order when stock is short', async () => {
    const p = await createProduct(biz, [{ price: 100, stock: 1 }]);
    const [{ n: before }] = (await sql(`select count(*)::int n from orders where business_id = $1`, [biz.id])) as any;
    await expectPgError(order(retail, { items: [{ variant_id: p.variantIds[0], qty: 2 }] }), 'insufficient_stock');
    const [{ n: after }] = (await sql(`select count(*)::int n from orders where business_id = $1`, [biz.id])) as any;
    expect(after).toBe(before);
  });

  it('rejects drafts, unregistered users and buyer-initiated POS orders', async () => {
    const draft = await createProduct(biz, [{ price: 100, stock: 5 }], { status: 'draft' });
    await expectPgError(order(retail, { items: [{ variant_id: draft.variantIds[0], qty: 1 }] }), 'product_unavailable');
    const stranger = await createUser();
    await expectPgError(order(stranger, { items: [{ variant_id: product.variantIds[0], qty: 1 }] }), 'register_first');
    await expectPgError(order(retail, { channel: 'pos', items: [{ variant_id: product.variantIds[0], qty: 1 }] }), 'channel_not_allowed');
  });

  it('a buyer can read their order but not other buyers’ orders, and never cost columns', async () => {
    const o = await order(retail, { items: [{ variant_id: product.variantIds[0], qty: 1 }] });
    expect((await q(retail, `select id from orders where id = $1`, [o.id])).length).toBe(1);
    expect(await q(wholesaler, `select id from orders where id = $1`, [o.id])).toEqual([]);
    expect(await rpc(wholesaler, 'public.get_order', [o.id])).toBeNull();
    await expectPgError(q(retail, `select unit_cost_kobo from order_items where order_id = $1`, [o.id]), '42501');
    await expectPgError(q(biz.owner, `select unit_cost_kobo from order_items where order_id = $1`, [o.id]), '42501');
    const [cost] = await sql(`select unit_cost_kobo from order_items where order_id = $1`, [o.id]);
    expect(cost!.unit_cost_kobo).toBe(6000);
  });

  it('nobody can edit order money columns directly', async () => {
    const o = await order(retail, { items: [{ variant_id: product.variantIds[0], qty: 1 }] });
    await expectPgError(q(biz.owner, `update orders set total_kobo = 1 where id = $1`, [o.id]), '42501');
    await expectPgError(q(biz.owner, `update orders set status = 'confirmed' where id = $1`, [o.id]), '42501');
  });
});

describe('payments', () => {
  it('virtual account transfers confirm the order once fully paid; duplicates are ignored', async () => {
    const buyer = await addBuyer(biz, 'retail_buyer');
    const acct = await giveVirtualAccount(buyer.customerId);
    const o = await order(buyer, { items: [{ variant_id: product.variantIds[1], qty: 2 }] });
    const before = await level(product.variantIds[1]!);
    await pay(acct, 10_000, 'ref-part-1');
    let [row] = await sql(`select status, payment_status, amount_paid_kobo, balance_kobo from orders where id = $1`, [o.id]);
    expect(row).toEqual({ status: 'pending', payment_status: 'partial', amount_paid_kobo: 10_000, balance_kobo: 14_000 });
    await pay(acct, 10_000, 'ref-part-1'); // webhook retry
    await pay(acct, 14_000, 'ref-part-2');
    [row] = await sql(`select status, payment_status, balance_kobo, fulfilment_status from orders where id = $1`, [o.id]);
    expect(row).toEqual({ status: 'confirmed', payment_status: 'paid', balance_kobo: 0, fulfilment_status: 'confirmed' });
    const after = await level(product.variantIds[1]!);
    expect(after.on_hand).toBe(before.on_hand - 2);
    expect(after.reserved).toBe(before.reserved - 2);
    const [n] = await sql(`select count(*)::int n from payments where order_id = $1`, [o.id]);
    expect(n!.n).toBe(2);
  });

  it('keeps overpayments and payments without an order as unallocated customer money', async () => {
    const buyer = await addBuyer(biz, 'retail_buyer');
    const acct = await giveVirtualAccount(buyer.customerId);
    const o = await order(buyer, { items: [{ variant_id: product.variantIds[1], qty: 1 }] });
    await pay(acct, 20_000, 'over-1');
    const rows = await sql(`select order_id, amount_kobo from payments where customer_id = $1 order by amount_kobo desc`, [buyer.customerId]);
    expect(rows).toEqual([{ order_id: o.id, amount_kobo: 12_000 }, { order_id: null, amount_kobo: 8_000 }]);
    await pay(acct, 5_000, 'no-order-1');
    const [u] = await sql(`select coalesce(sum(amount_kobo),0)::int n from payments where customer_id = $1 and order_id is null`, [buyer.customerId]);
    expect(u!.n).toBe(13_000);
  });

  it('cashier records cash; virtual-account payments can only come from webhooks', async () => {
    const o = await order(cashier, { channel: 'pos', items: [{ variant_id: product.variantIds[1], qty: 1 }] });
    expect(o.delivery_method).toBe('in_store');
    await expectPgError(rpc(cashier, 'public.record_payment', [o.id, 12_000, 'virtual_account', null, null]), 'virtual_account_payments_come_from_webhooks');
    await rpc(cashier, 'public.record_payment', [o.id, 12_000, 'cash', null, null]);
    const [row] = await sql(`select status, fulfilment_status from orders where id = $1`, [o.id]);
    expect(row).toEqual({ status: 'confirmed', fulfilment_status: 'collected' });
    await expectPgError(rpc(retail, 'public.record_payment', [o.id, 100, 'cash', null, null]), 'permission_denied');
    await expectPgError(rpc(cashier, 'public.apply_virtual_account_payment', ['paystack', '1', 1, 'x', null, null]), '42501');
  });
});

describe('transfer allocation', () => {
  it('prefers an open order whose balance equals the amount paid', async () => {
    const buyer = await addBuyer(biz, 'retail_buyer');
    const acct = await giveVirtualAccount(buyer.customerId);
    const older = await order(buyer, { items: [{ variant_id: product.variantIds[0], qty: 1 }] });
    const exact = await order(buyer, { items: [{ variant_id: product.variantIds[1], qty: 1 }] });
    const res = await pay(acct, 12_000);
    expect(res.order_id).toBe(exact.id);
    const res2 = await pay(acct, 3_000);
    expect(res2.order_id).toBe(older.id);
  });
});

describe('reservation lifecycle', () => {
  it('expire_reservations releases unpaid orders after the timer', async () => {
    const p = await createProduct(biz, [{ price: 500, stock: 3 }]);
    const o = await order(retail, { items: [{ variant_id: p.variantIds[0], qty: 3 }] });
    expect((await level(p.variantIds[0]!)).available).toBe(0);
    await sql(`update orders set reservation_expires_at = now() - interval '1 minute' where id = $1`, [o.id]);
    expect(await rpc(SERVICE, 'public.expire_reservations', [500])).toBeGreaterThanOrEqual(1);
    expect((await level(p.variantIds[0]!)).available).toBe(3);
    const [row] = await sql(`select status from orders where id = $1`, [o.id]);
    expect(row!.status).toBe('expired');
  });

  it('a payment after expiry re-reserves if stock is still there, else flags the order', async () => {
    const p = await createProduct(biz, [{ price: 500, stock: 1 }]);
    const buyer = await addBuyer(biz, 'retail_buyer');
    const acct = await giveVirtualAccount(buyer.customerId);
    const o1 = await order(buyer, { items: [{ variant_id: p.variantIds[0], qty: 1 }] });
    await sql(`update orders set reservation_expires_at = now() - interval '1 minute' where id = $1`, [o1.id]);
    await rpc(SERVICE, 'public.expire_reservations', [500]);
    await pay(acct, 500, 'late-1');
    let [row] = await sql(`select status, needs_attention from orders where id = $1`, [o1.id]);
    expect(row).toEqual({ status: 'confirmed', needs_attention: null });
    expect((await level(p.variantIds[0]!)).on_hand).toBe(0);

    // second time there is no stock left → flagged for staff, payment kept
    const p2 = await createProduct(biz, [{ price: 500, stock: 1 }]);
    const o2 = await order(buyer, { items: [{ variant_id: p2.variantIds[0], qty: 1 }] });
    await sql(`update orders set reservation_expires_at = now() - interval '1 minute' where id = $1`, [o2.id]);
    await rpc(SERVICE, 'public.expire_reservations', [500]);
    await order(retail, { items: [{ variant_id: p2.variantIds[0], qty: 1 }] }); // someone else takes the last one
    await pay(acct, 500, 'late-2');
    [row] = await sql(`select status, payment_status, needs_attention from orders where id = $1`, [o2.id]);
    expect(row).toEqual({ status: 'expired', payment_status: 'paid', needs_attention: 'paid_after_expiry_out_of_stock' });
  });

  it('buyer can cancel an unpaid pending order; confirmed orders cannot be cancelled', async () => {
    const o = await order(retail, { items: [{ variant_id: product.variantIds[0], qty: 1 }] });
    const before = await level(product.variantIds[0]!);
    await rpc(retail, 'public.cancel_order', [o.id, 'changed my mind']);
    expect((await level(product.variantIds[0]!)).reserved).toBe(before.reserved - 1);
    await expectPgError(rpc(wholesaler, 'public.cancel_order', [o.id, 'x']), 'permission_denied');
    const o2 = await order(cashier, { channel: 'pos', items: [{ variant_id: product.variantIds[0], qty: 1 }] });
    await rpc(cashier, 'public.record_payment', [o2.id, 10_000, 'cash', null, null]);
    await expectPgError(rpc(biz.owner, 'public.cancel_order', [o2.id, 'x']), 'order_already_confirmed');
  });
});

describe('concurrency: 50 parallel checkouts for the last 10 units', () => {
  it('across web, WhatsApp and two POS devices exactly 10 succeed and stock never goes negative', async () => {
    const p = await createProduct(biz, [{ price: 1_000, stock: 10 }], { name: 'Last ten' });
    const v = p.variantIds[0]!;
    const [d1] = await q(biz.owner, `insert into devices (business_id, location_id, name) values ($1,$2,'Till A') returning id`, [biz.id, biz.locationId]);
    const [d2] = await q(biz.owner, `insert into devices (business_id, location_id, name) values ($1,$2,'Till B') returning id`, [biz.id, biz.locationId]);
    const cashier2 = await addStaff(biz, 'cashier');
    const webBuyers = await Promise.all(Array.from({ length: 5 }, () => addBuyer(biz, 'retail_buyer')));
    const waCustomers = webBuyers.slice(0, 3).map((b) => b.customerId);

    const attempts = Array.from({ length: 50 }, (_, i) => {
      const items = [{ variant_id: v, qty: 1 }];
      switch (i % 4) {
        case 0: return { channel: 'web', run: () => order(webBuyers[i % 5]!, { items }) };
        case 1: return { channel: 'whatsapp', run: () => rpc(SERVICE, 'public.place_order', [JSON.stringify({ business_id: biz.id, channel: 'whatsapp', customer_id: waCustomers[i % 3], items })]) };
        case 2: return { channel: 'pos-a', run: () => order(cashier, { channel: 'pos', device_id: d1!.id, items }) };
        default: return { channel: 'pos-b', run: () => order(cashier2, { channel: 'pos', device_id: d2!.id, items }) };
      }
    });
    // Watch the level while the storm runs.
    let minAvailable = Infinity;
    let watching = true;
    const watcher = (async () => {
      while (watching) {
        const l = await level(v);
        minAvailable = Math.min(minAvailable, l.available, l.on_hand);
        await new Promise((r) => setTimeout(r, 2));
      }
    })();
    const results = await Promise.allSettled(attempts.map((a) => a.run()));
    watching = false;
    await watcher;

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(10);
    expect(new Set(failed.map((f) => (f.reason as Error).message))).toEqual(new Set(['insufficient_stock']));
    expect(minAvailable).toBeGreaterThanOrEqual(0);
    expect(await level(v)).toEqual({ on_hand: 10, reserved: 10, allocated: 0, available: 0 });
    const channels = new Set(results.map((r, i) => (r.status === 'fulfilled' ? attempts[i]!.channel : null)).filter(Boolean));
    expect(channels.size).toBeGreaterThan(1);

    // Pay for all of them → on_hand reaches exactly 0, never below.
    const orders = await sql(`select o.id from orders o join order_items i on i.order_id = o.id where i.variant_id = $1 and o.status = 'pending'`, [v]);
    for (const o of orders) await sql(`select app.apply_payment($1, $2, null, 1000, 'transfer')`, [biz.id, o.id]);
    expect(await level(v)).toEqual({ on_hand: 0, reserved: 0, allocated: 0, available: 0 });
    expect(await ledgerMismatches(biz.id)).toEqual([]);
  });
});
