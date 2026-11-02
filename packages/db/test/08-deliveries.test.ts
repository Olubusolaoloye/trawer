import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ANON, SERVICE } from '../src/claims';
import { createProduct } from './catalog';
import { addBuyer, addStaff, createBusiness, expectPgError, pool, q, rpc, sql, type TestBusiness } from './helpers';

let biz: TestBusiness;
let other: TestBusiness;
let variant: string;
let manager: Awaited<ReturnType<typeof addStaff>>;
let cashier: Awaited<ReturnType<typeof addStaff>>;
let rider: Awaited<ReturnType<typeof addStaff>>;
let rider2: Awaited<ReturnType<typeof addStaff>>;
let riderStaffId: string;

beforeAll(async () => {
  biz = await createBusiness('Delivery Co');
  other = await createBusiness('Other Co');
  variant = (await createProduct(biz, [{ price: 10_000, stock: 100 }])).variantIds[0]!;
  manager = await addStaff(biz, 'manager');
  cashier = await addStaff(biz, 'cashier');
  rider = await addStaff(biz, 'rider');
  rider2 = await addStaff(biz, 'rider');
  riderStaffId = (await sql(`select id from staff_members where business_id = $1 and user_id = $2`, [biz.id, rider.id]))[0]!.id;
});
afterAll(async () => { await pool.end(); });

const proof = () => `${biz.id}/${randomUUID()}.webp`;
async function paidDelivery(qty = 2, method: 'delivery' | 'pickup' = 'delivery') {
  const buyer = await addBuyer(biz, 'retail_buyer');
  const o = await rpc<any>(SERVICE, 'public.place_order', [JSON.stringify({
    business_id: biz.id, channel: 'web', customer_id: buyer.customerId, items: [{ variant_id: variant, qty }],
    delivery_method: method, delivery_address: method === 'delivery' ? { line1: '12 Upper Iweka Road', city: 'Onitsha' } : undefined,
  })]);
  await sql(`select app.apply_payment($1, $2, null, $3, 'transfer')`, [biz.id, o.id, o.total_kobo]);
  return { buyer, o };
}
const onHand = async () => (await sql(`select sum(on_hand)::int n from stock_levels where variant_id = $1`, [variant]))[0]!.n as number;
const fulfil = (who: unknown, id: string, status: string, extra: { note?: string; failure?: string; proof?: string; received?: string; client?: string } = {}) =>
  rpc<any>(who as never, 'public.set_fulfilment', [id, status, extra.note ?? null, extra.failure ?? null, extra.proof ?? null, extra.received ?? null, extra.client ?? null, null]);

describe('delivery tracking', () => {
  it('packed → dispatched → delivered with rider, proof photo, timeline, WhatsApp updates and a completed order', async () => {
    const { buyer, o } = await paidDelivery(2);
    await expectPgError(fulfil(cashier, o.id, 'packed'), 'permission_denied');
    await fulfil(manager, o.id, 'packed', { note: 'Two bundles in the blue bag' });
    await expectPgError(rpc(manager, 'public.assign_rider', [o.id, (await sql(`select id from staff_members where business_id = $1 and role = 'cashier'`, [biz.id]))[0]!.id]), 'not_a_rider');
    await rpc(manager, 'public.assign_rider', [o.id, riderStaffId]);

    // The rider sees it on their run sheet; another rider does not.
    const sheet = await rpc<any[]>(rider, 'public.my_deliveries', [null]);
    expect(sheet.find((x) => x.order_id === o.id)).toMatchObject({ status: 'packed', recipient_name: 'Buyer retail_buyer', address: { line1: '12 Upper Iweka Road' } });
    expect((await rpc<any[]>(rider2, 'public.my_deliveries', [null])).some((x) => x.order_id === o.id)).toBe(false);
    await expectPgError(fulfil(rider2, o.id, 'dispatched'), 'permission_denied');

    await fulfil(rider, o.id, 'dispatched');
    await expectPgError(fulfil(rider, o.id, 'delivered'), 'proof_required');
    await expectPgError(fulfil(rider, o.id, 'delivered', { proof: `${other.id}/${randomUUID()}.webp` }), 'invalid_proof');
    await fulfil(rider, o.id, 'delivered', { proof: proof(), received: 'Mrs Okafor' });

    const [ord] = await sql(`select status, fulfilment_status from orders where id = $1`, [o.id]);
    expect(ord).toEqual({ status: 'completed', fulfilment_status: 'delivered' });
    const [d] = await sql(`select attempts, received_by, packed_at is not null p, dispatched_at is not null s, delivered_at is not null dl from deliveries where order_id = $1`, [o.id]);
    expect(d).toEqual({ attempts: 1, received_by: 'Mrs Okafor', p: true, s: true, dl: true });
    const kinds = (await sql(`select kind::text from notifications where order_id = $1 order by created_at`, [o.id])).map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['packed', 'dispatched', 'delivered']));

    // Staff see the full timeline + proof; the buyer sees the timeline but not the photo path or notes.
    const staffView = await rpc<any>(manager, 'public.order_delivery', [o.id]);
    expect(staffView.events.map((e: any) => e.status)).toEqual(['packed', 'dispatched', 'delivered']);
    expect(staffView.delivery).toMatchObject({ has_proof: true, rider_id: riderStaffId });
    expect(staffView.delivery.proof_path).toMatch(/\.webp$/);
    const buyerView = await rpc<any>(buyer, 'public.order_delivery', [o.id]);
    expect(buyerView.delivery.proof_path).toBeNull();
    expect(buyerView.events[0].note).toBeNull();
    // Nothing more can happen to a delivered order.
    await expectPgError(fulfil(manager, o.id, 'dispatched'), 'invalid_transition');
  });

  it('failed attempt needs a reason; retry, then returned puts the stock back exactly once', async () => {
    const { o } = await paidDelivery(3);
    const before = await onHand();
    await fulfil(manager, o.id, 'packed');
    await rpc(manager, 'public.assign_rider', [o.id, riderStaffId]);
    await fulfil(rider, o.id, 'dispatched');
    await expectPgError(fulfil(rider, o.id, 'failed'), 'reason_required');
    await fulfil(rider, o.id, 'failed', { failure: 'not_home', note: 'Gate locked' });
    await fulfil(rider, o.id, 'dispatched');
    await fulfil(rider, o.id, 'failed', { failure: 'unreachable' });
    await expectPgError(fulfil(rider, o.id, 'returned'), 'permission_denied'); // riders can't book returns
    // Each attempt notifies the buyer again (not swallowed as a duplicate) and names the rider.
    const sent = await sql(`select params from notifications where order_id = $1 and kind = 'dispatched' order by created_at`, [o.id]);
    expect(sent.map((r) => r.params.attempt)).toEqual([1, 2]);
    expect(sent[0]!.params.rider).toBe('rider');
    await fulfil(manager, o.id, 'returned');
    expect(await onHand()).toBe(before + 3);
    expect((await sql(`select attempts from deliveries where order_id = $1`, [o.id]))[0]!.attempts).toBe(2);
    expect((await sql(`select count(*)::int n from stock_movements where order_id = $1 and type = 'return'`, [o.id]))[0]!.n).toBe(1);
  });

  it('offline rider updates are idempotent on client id', async () => {
    const { o } = await paidDelivery(1);
    await fulfil(manager, o.id, 'packed');
    await rpc(manager, 'public.assign_rider', [o.id, riderStaffId]);
    const client = randomUUID();
    expect(await fulfil(rider, o.id, 'dispatched', { client })).toMatchObject({ duplicate: false });
    expect(await fulfil(rider, o.id, 'dispatched', { client })).toMatchObject({ duplicate: true });
    expect((await sql(`select count(*)::int n from delivery_events where order_id = $1`, [o.id]))[0]!.n).toBe(2);
  });

  it('pickups go packed → collected; unpaid orders cannot be packed', async () => {
    const { o } = await paidDelivery(1, 'pickup');
    await expectPgError(fulfil(manager, o.id, 'dispatched'), 'invalid_transition');
    await fulfil(manager, o.id, 'packed');
    await fulfil(manager, o.id, 'collected');
    expect((await sql(`select status from orders where id = $1`, [o.id]))[0]!.status).toBe('completed');
    await expectPgError(rpc(manager, 'public.assign_rider', [o.id, riderStaffId]), 'not_a_delivery');

    const buyer = await addBuyer(biz, 'retail_buyer');
    const pending = await rpc<any>(SERVICE, 'public.place_order', [JSON.stringify({ business_id: biz.id, channel: 'web', customer_id: buyer.customerId, items: [{ variant_id: variant, qty: 1 }], delivery_method: 'pickup' })]);
    await expectPgError(fulfil(manager, pending.id, 'packed'), 'order_not_ready');
  });

  it('public tracking shows statuses and times only; tables are not writable directly', async () => {
    const { o } = await paidDelivery(1);
    await fulfil(manager, o.id, 'packed');
    const [{ tracking_token }] = await sql(`select tracking_token from orders where id = $1`, [o.id]);
    const t = await rpc<any>(SERVICE, 'public.tracking_events', [tracking_token]);
    expect(t.events).toHaveLength(1);
    expect(Object.keys(t.events[0]).sort()).toEqual(['at', 'status']);
    await expectPgError(rpc(ANON, 'public.tracking_events', [tracking_token]), /permission denied/);
    await expectPgError(q(manager, `update deliveries set proof_path = null where order_id = $1`, [o.id]), /permission denied/);
    await expectPgError(q(manager, `insert into delivery_events (business_id, delivery_id, order_id, status) select business_id, id, order_id, 'delivered' from deliveries where order_id = $1`, [o.id]), /permission denied/);
  });
});
