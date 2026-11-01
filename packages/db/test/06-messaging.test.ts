import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVICE } from '../src/claims';
import { createProduct } from './catalog';
import { addBuyer, addStaff, createBusiness, expectPgError, pool, q, rpc, sql, type TestBusiness } from './helpers';

let biz: TestBusiness;
let buyer: Awaited<ReturnType<typeof addBuyer>>;
let variant: string;

beforeAll(async () => {
  biz = await createBusiness('Notify Co');
  buyer = await addBuyer(biz, 'retail_buyer');
  variant = (await createProduct(biz, [{ price: 1000, stock: 100 }])).variantIds[0]!;
});
afterAll(async () => { await pool.end(); });

const place = (who: any, extra: Record<string, unknown> = {}) =>
  rpc<any>(who, 'public.place_order', [JSON.stringify({ business_id: biz.id, items: [{ variant_id: variant, qty: 1 }], ...extra })]);
const kinds = async (orderId: string) => (await sql(`select kind from notifications where order_id = $1 order by created_at, kind`, [orderId])).map((r) => r.kind);

describe('notification outbox', () => {
  it('queues order placed → payment received → dispatched → delivered, once each', async () => {
    const o = await place(buyer);
    expect(await kinds(o.id)).toEqual(['order_placed']);
    await sql(`select app.apply_payment($1, $2, null, 1000, 'transfer')`, [biz.id, o.id]);
    await sql(`update orders set fulfilment_status = 'dispatched' where id = $1`, [o.id]);
    await sql(`update orders set fulfilment_status = 'dispatched' where id = $1`, [o.id]); // no change, no duplicate
    await sql(`update orders set fulfilment_status = 'delivered' where id = $1`, [o.id]);
    expect((await kinds(o.id)).sort()).toEqual(['delivered', 'dispatched', 'order_placed', 'payment_received']);
    const [row] = await sql(`select to_phone, params from notifications where order_id = $1 and kind = 'payment_received'`, [o.id]);
    expect(row!.to_phone).toBe(buyer.phone);
    expect(row!.params).toMatchObject({ received_kobo: 1000, shop: 'Notify Co' });
  });

  it('partial payments each notify; walk-in POS sales do not', async () => {
    const o = await place(buyer, {});
    await sql(`select app.apply_payment($1, $2, null, 400, 'transfer')`, [biz.id, o.id]);
    await sql(`select app.apply_payment($1, $2, null, 600, 'transfer')`, [biz.id, o.id]);
    expect((await kinds(o.id)).filter((k) => k === 'payment_received')).toHaveLength(2);
    const cashier = await addStaff(biz, 'cashier');
    const pos = await place(cashier, { channel: 'pos' });
    expect(await kinds(pos.id)).toEqual([]);
  });

  it('workers never claim the same notification twice; failures back off and retry', async () => {
    const o = await place(buyer);
    const claims = await Promise.all(Array.from({ length: 5 }, () => rpc<any>(SERVICE, 'public.claim_notifications', [100]).then(() => null)));
    void claims;
    const claimed = await sql(`select id, status, attempts from notifications where order_id = $1`, [o.id]);
    expect(claimed.every((r) => r.status === 'sending' && r.attempts === 1)).toBe(true);
    const id = claimed[0]!.id;
    await sql(`select public.finish_notification($1, false, null, 'timeout', null)`, [id]);
    const [r] = await sql(`select status, last_error, next_attempt_at > now() as later from notifications where id = $1`, [id]);
    expect(r).toMatchObject({ status: 'queued', last_error: 'timeout', later: true });
    await sql(`select public.finish_notification($1, true, 'wamid.x${randomUUID()}', null, false)`, [id]);
    expect((await sql(`select status from notifications where id = $1`, [id]))[0]!.status).toBe('sent');
  });

  it('only service code can claim/finish; buyers see their own notifications, staff see the business’s', async () => {
    await expectPgError(rpc(biz.owner, 'public.claim_notifications', [10]), '42501');
    const mine = await q(buyer, `select count(*)::int n from notifications`);
    const all = await sql(`select count(*)::int n from notifications where customer_id = $1`, [buyer.customerId]);
    expect(mine[0]!.n).toBe(all[0]!.n);
    const other = await addBuyer(biz, 'retail_buyer');
    expect((await q(other, `select count(*)::int n from notifications`))[0]!.n).toBe(0);
  });

  it('the WhatsApp token is write-only: stored in Vault, needs MFA, never readable by API roles', async () => {
    await expectPgError(rpc(biz.owner, 'public.set_whatsapp_connection', [biz.id, '1234567', '', '', 'token-value-123456789']), 'mfa_required');
    await rpc(biz.owner.mfa, 'public.set_whatsapp_connection', [biz.id, '1234567', '0803', '', 'token-value-123456789']);
    await expectPgError(rpc(biz.owner.mfa, 'public.whatsapp_token', [biz.id]), '42501');
    expect(await rpc(SERVICE, 'public.whatsapp_token', [biz.id])).toBe('token-value-123456789');
    const audit = await sql(`select after from audit_log where business_id = $1 and action = 'whatsapp.connection_changed'`, [biz.id]);
    expect(JSON.stringify(audit)).not.toContain('token-value');
  });
});
