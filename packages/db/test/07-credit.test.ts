import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANON, SERVICE } from '../src/claims';
import { createProduct } from './catalog';
import { addBuyer, addStaff, createBusiness, expectPgError, pool, q, rpc, sql, type TestBusiness } from './helpers';

let biz: TestBusiness;
let variant: string;
let manager: Awaited<ReturnType<typeof addStaff>>;
let cashier: Awaited<ReturnType<typeof addStaff>>;

beforeAll(async () => {
  biz = await createBusiness('Credit Co');
  variant = (await createProduct(biz, [{ price: 10_000, stock: 500 }])).variantIds[0]!;
  manager = await addStaff(biz, 'manager');
  cashier = await addStaff(biz, 'cashier');
});
afterAll(async () => { await pool.end(); });

const order = (customer: string, qty = 1) =>
  rpc<any>(SERVICE, 'public.place_order', [JSON.stringify({ business_id: biz.id, channel: 'whatsapp', customer_id: customer, items: [{ variant_id: variant, qty }] })]);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const inDays = (n: number) => ymd(new Date(Date.now() + n * 86400_000));

describe('credit sales and the debtors book', () => {
  it('confirming on credit commits stock, records a charge, and part payments reduce it', async () => {
    const buyer = await addBuyer(biz, 'retailer');
    const o = await order(buyer.customerId, 3);
    await expectPgError(rpc(cashier, 'public.confirm_on_credit', [o.id, inDays(14), null]), 'permission_denied');
    await rpc(manager, 'public.confirm_on_credit', [o.id, inDays(14), 'pays Friday']);
    const [row] = await sql(`select status, is_credit, due_date::text, balance_kobo from orders where id = $1`, [o.id]);
    expect(row).toEqual({ status: 'confirmed', is_credit: true, due_date: inDays(14), balance_kobo: 30_000 });
    expect((await sql(`select sum(on_hand)::int n from stock_levels where variant_id = $1`, [variant]))[0]!.n).toBe(497);

    await sql(`select app.apply_payment($1, $2, null, 12000, 'transfer')`, [biz.id, o.id]);
    await sql(`select app.apply_payment($1, $2, null, 18000, 'cash')`, [biz.id, o.id]);
    const st = await rpc<any>(manager, 'public.customer_statement', [buyer.customerId]);
    expect(st.entries.map((e: any) => [e.kind, e.amount_kobo, e.running_kobo])).toEqual([['charge', 30000, 30000], ['payment', -12000, 18000], ['payment', -18000, 0]]);
    // the buyer sees their own statement, another buyer cannot
    expect((await rpc<any>(buyer, 'public.customer_statement', [buyer.customerId])).entries).toHaveLength(3);
    const other = await addBuyer(biz, 'retail_buyer');
    await expectPgError(rpc(other, 'public.customer_statement', [buyer.customerId]), 'not_found');
  });

  it('enforces a customer credit limit when one is set', async () => {
    const buyer = await addBuyer(biz, 'retailer');
    await sql(`update customers set credit_limit_kobo = 25000 where id = $1`, [buyer.customerId]);
    const a = await order(buyer.customerId, 2);
    await rpc(manager, 'public.confirm_on_credit', [a.id, null, null]);
    const b = await order(buyer.customerId, 1);
    await expectPgError(rpc(manager, 'public.confirm_on_credit', [b.id, null, null]), 'credit_limit_exceeded');
    const [row] = await sql(`select due_date::text from orders where id = $1`, [a.id]);
    expect(row!.due_date).toBe(inDays(7)); // shop default terms
  });

  it('a cashier credit sale from a till lands in the debtors book with default terms and can be approved', async () => {
    const buyer = await addBuyer(biz, 'retailer');
    const [d] = await q(biz.owner, `insert into devices (business_id, location_id, name) values ($1,$2,'Till') returning id`, [biz.id, biz.locationId]);
    const r = await rpc<any>(cashier, 'public.sync_pos_sale', [JSON.stringify({ device_id: d!.id, client_id: randomUUID(), customer_id: buyer.customerId,
      items: [{ variant_id: variant, qty: 2, unit_price_kobo: 10000 }], payments: [{ client_id: randomUUID(), method: 'cash', amount_kobo: 5000 }] })]);
    const [o] = await sql(`select is_credit, due_date::text, balance_kobo, needs_attention from orders where id = $1`, [r.order_id]);
    expect(o).toEqual({ is_credit: true, due_date: inDays(7), balance_kobo: 15000, needs_attention: 'credit_sale_needs_approval' });
    expect((await sql(`select kind, amount_kobo from credit_entries where order_id = $1`, [r.order_id]))).toEqual([{ kind: 'charge', amount_kobo: 15000 }]);
    await rpc(manager, 'public.confirm_on_credit', [r.order_id, inDays(10), null]);
    const [after] = await sql(`select needs_attention, due_date::text from orders where id = $1`, [r.order_id]);
    expect(after).toEqual({ needs_attention: null, due_date: inDays(10) });
    // no duplicate charge
    expect((await sql(`select count(*)::int n from credit_entries where order_id = $1 and kind = 'charge'`, [r.order_id]))[0]!.n).toBe(1);
  });

  it('ordinary paid sales never touch the debtors book', async () => {
    const buyer = await addBuyer(biz, 'retailer');
    const o = await order(buyer.customerId, 1);
    await sql(`select app.apply_payment($1, $2, null, 4000, 'transfer')`, [biz.id, o.id]);
    await sql(`select app.apply_payment($1, $2, null, 6000, 'transfer')`, [biz.id, o.id]);
    expect(await sql(`select * from credit_entries where order_id = $1`, [o.id])).toEqual([]);
  });

  it('debtors report: totals, overdue and ageing buckets', async () => {
    const b2 = await createBusiness('Aging Co');
    const v = (await createProduct(b2, [{ price: 1000, stock: 100 }])).variantIds[0]!;
    const mk = async (days: number) => {
      const buyer = await addBuyer(b2, 'retailer');
      const o = await rpc<any>(SERVICE, 'public.place_order', [JSON.stringify({ business_id: b2.id, channel: 'web', customer_id: buyer.customerId, items: [{ variant_id: v, qty: 1 }] })]);
      await rpc(b2.owner, 'public.confirm_on_credit', [o.id, inDays(1), null]);
      await sql(`update orders set due_date = $2 where id = $1`, [o.id, inDays(days)]);
    };
    await mk(5); await mk(-10); await mk(-45); await mk(-90);
    const r = await rpc<any>(b2.owner, 'public.debtors_report', [b2.id]);
    expect(r).toMatchObject({ total_kobo: 4000, overdue_kobo: 3000, aging: { not_due: 1000, d1_30: 1000, d31_60: 1000, d60_plus: 1000 } });
    expect(r.customers).toHaveLength(4);
    expect(r.customers[0].max_days_late).toBe(90);
    await expectPgError(rpc(biz.owner, 'public.debtors_report', [b2.id]), '42501');
  });
});

describe('reminders', () => {
  it('reminds on/after the due date, at most once a week and four times; manual remind once a day', async () => {
    const buyer = await addBuyer(biz, 'retailer');
    const o = await order(buyer.customerId, 1);
    await rpc(manager, 'public.confirm_on_credit', [o.id, inDays(3), null]);
    await rpc(SERVICE, 'public.schedule_debt_reminders', []);
    expect(await sql(`select * from notifications where order_id = $1 and kind = 'debt_reminder'`, [o.id])).toEqual([]);
    await sql(`update orders set due_date = current_date where id = $1`, [o.id]);
    await rpc(SERVICE, 'public.schedule_debt_reminders', []);
    await rpc(SERVICE, 'public.schedule_debt_reminders', []);
    const rows = await sql(`select params from notifications where order_id = $1 and kind = 'debt_reminder'`, [o.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.params).toMatchObject({ balance_kobo: 10000, shop: 'Credit Co' });
    // manual remind the same day is de-duplicated
    expect(await rpc(manager, 'public.remind_debtor', [o.id])).toBe(false);
    await expectPgError(rpc(cashier, 'public.remind_debtor', [o.id]), 'permission_denied');
    // after 4 reminders, stop
    await sql(`update orders set reminders_sent = 4, last_reminded_at = now() - interval '30 days' where id = $1`, [o.id]);
    await sql(`delete from notifications where order_id = $1 and kind = 'debt_reminder'`, [o.id]);
    await rpc(SERVICE, 'public.schedule_debt_reminders', []);
    expect(await sql(`select * from notifications where order_id = $1 and kind = 'debt_reminder'`, [o.id])).toEqual([]);
  });
});

describe('reminders and consent', () => {
  it('buyers who switched off WhatsApp updates are never reminded (NDPA)', async () => {
    const buyer = await addBuyer(biz, 'retailer');
    const o = await order(buyer.customerId, 1);
    await rpc(manager, 'public.confirm_on_credit', [o.id, inDays(0), null]);
    await sql(`insert into consents (user_id, business_id, kind, version, granted) values ($1, $2, 'whatsapp_updates', 'v1', false)`, [buyer.id, biz.id]);
    await rpc(SERVICE, 'public.schedule_debt_reminders', []);
    expect(await rpc(manager, 'public.remind_debtor', [o.id])).toBe(false);
    expect(await sql(`select * from notifications where order_id = $1 and kind = 'debt_reminder'`, [o.id])).toEqual([]);
  });
});

describe('invoices and receipts', () => {
  it('every payment gets a numbered receipt; the order gets one invoice with a shareable token', async () => {
    const buyer = await addBuyer(biz, 'retailer');
    const o = await order(buyer.customerId, 2);
    await sql(`select app.apply_payment($1, $2, null, 5000, 'transfer')`, [biz.id, o.id]);
    const receipts = await sql(`select number from invoices where order_id = $1 and kind = 'receipt'`, [o.id]);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.number).toMatch(/^RCT-\d{6}$/);
    const inv1 = await rpc<any>(manager, 'public.order_invoice', [o.id]);
    const inv2 = await rpc<any>(buyer, 'public.order_invoice', [o.id]);
    expect(inv1).toEqual(inv2);
    expect(inv1.number).toMatch(/^INV-\d{6}$/);
    const other = await addBuyer(biz, 'retail_buyer');
    await expectPgError(rpc(other, 'public.order_invoice', [o.id]), 'not_found');

    const doc = await rpc<any>(ANON, 'public.document_by_token', [inv1.token]);
    expect(doc).toMatchObject({ kind: 'invoice', number: inv1.number, order: { total_kobo: 20000, amount_paid_kobo: 5000, balance_kobo: 15000 } });
    expect(doc.items).toHaveLength(1);
    expect(JSON.stringify(doc)).not.toContain(buyer.phone);
    expect(await rpc(ANON, 'public.document_by_token', ['nope'])).toBeNull();
  });
});
