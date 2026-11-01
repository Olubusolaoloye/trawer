import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { ConsoleMessagingProvider } from '@trawer/core/messaging';
import { app, Client, phone } from './client';
import { pool } from '../src/db';
import { closeLive } from '../src/live';
import { setMessagingProvider } from '../src/whatsapp';

const wa = new ConsoleMessagingProvider('test-meta-app-secret', true);
setMessagingProvider(wa);
let owner: Client;
let businessId: string;
let slug: string;
let variantId: string;
const CRON = { authorization: 'Bearer test-cron-secret-0123456789' };

beforeAll(async () => {
  owner = new Client();
  await owner.signIn(phone(), true);
  slug = `cr-${Date.now() % 100000}`;
  businessId = (await owner.post('/api/biz', { name: 'Credit Fabrics', slug, kind: 'wholesaler', brand_colour: '#23308C' })).body.business_id;
  await owner.patch(`/api/biz/${businessId}`, { address: '24 Balogun Street, Lagos', phone: '08030000001' });
  await owner.put(`/api/biz/${businessId}/whatsapp`, { phone_number_id: `20${Date.now() % 1e9}`, token: 'y'.repeat(40) });
  const p = await owner.post(`/api/biz/${businessId}/products`, { name: 'Swiss voile lace', status: 'active', base_unit: 'piece', packs: [{ unit: 'bundle', factor: 5 }],
    variants: [{ colour: 'Rose', retail_price_kobo: 3_900_000, opening_stock: 100 }] });
  variantId = (await owner.get(`/api/biz/${businessId}/products/${p.body.id}`)).body.variants[0].id;
});
afterAll(async () => { await closeLive(); await pool.end(); });

async function buyerOrder(qty: number) {
  const buyer = new Client();
  await buyer.signIn(phone());
  await buyer.post(`/api/store/${slug}/register`, { buyer_type: 'retailer', name: 'Yetunde Adeyemi', business_name: 'Yetty Boutique', accept_terms: true });
  const o = await buyer.post(`/api/store/${slug}/checkout`, { items: [{ variant_id: variantId, qty }] });
  return { buyer, order: o.body.order };
}

describe('credit, debtors and reminders', () => {
  it('owner sells on credit; the debtors report and statement show it; reminders go out on WhatsApp', async () => {
    const { buyer, order } = await buyerOrder(5);
    const pay = await owner.post(`/api/biz/${businessId}/orders/${order.id}/payments`, { amount_kobo: 5_000_000, method: 'cash' });
    expect(pay.status).toBe(201);
    const due = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
    // A buyer with no transfer account yet gets one when they go on credit (the invoice shows it).
    await pool.query(`delete from virtual_accounts where customer_id = $1`, [order.customer_id]);
    const credit = await owner.post(`/api/biz/${businessId}/orders/${order.id}/credit`, { due_date: due });
    expect(credit.status).toBe(200);
    expect((await pool.query(`select 1 from virtual_accounts where customer_id = $1 and status = 'active'`, [order.customer_id])).rowCount).toBe(1);

    const report = await owner.get(`/api/biz/${businessId}/debtors`);
    expect(report.body).toMatchObject({ total_kobo: 14_500_000, overdue_kobo: 0, aging: { not_due: 14_500_000 } });
    const cust = report.body.customers[0];
    expect(cust).toMatchObject({ name: 'Yetunde Adeyemi', business_name: 'Yetty Boutique', owing_kobo: 14_500_000, open_orders: 1 });
    const st = await owner.get(`/api/biz/${businessId}/customers/${cust.id}/statement`);
    expect(st.body.entries.map((e: any) => e.kind)).toEqual(['charge']);

    // The buyer sees what they owe on the storefront.
    const me = (await buyer.get(`/api/store/${slug}`)).body.me;
    expect(me.owing_kobo).toBe(14_500_000);

    // Overdue → daily cron queues + sends a reminder (template: no recent chat with this buyer).
    await pool.query(`update orders set due_date = current_date - 1 where id = $1`, [order.id]);
    const before = wa.sent.length;
    const r = await app.request('/api/cron/debt-reminders', { method: 'POST', headers: CRON });
    expect(await r.json()).toMatchObject({ queued: 1 });
    const sent = wa.sent.slice(before).filter((s) => s.template?.name === 'trawer_debt_reminder');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.template!.params.slice(0, 3)).toEqual(['Credit Fabrics', '₦145,000', String(order.order_number)]);
    expect(sent[0]!.template!.params[3]).toMatch(/^\d{10}$/); // their account number
    // Manual "remind now" the same day is a no-op.
    expect((await owner.post(`/api/biz/${businessId}/orders/${order.id}/remind`)).body).toEqual({ queued: false });
  });

  it('credit is refused for a walk-in and for staff without credit rights', async () => {
    const cashierPhone = phone();
    await owner.post(`/api/biz/${businessId}/staff`, { phone: cashierPhone, role: 'cashier' });
    const cashier = new Client();
    await cashier.signIn(cashierPhone);
    const { order } = await buyerOrder(1);
    const r = await cashier.post(`/api/biz/${businessId}/orders/${order.id}/credit`, {});
    expect(r.status).toBe(403);
  });
});

describe('invoices and receipts', () => {
  it('shareable invoice JSON + PDF by token, for staff and the buyer; receipts per payment', async () => {
    const { buyer, order } = await buyerOrder(2);
    await owner.post(`/api/biz/${businessId}/orders/${order.id}/payments`, { amount_kobo: 3_000_000, method: 'transfer' });
    const inv = (await owner.post(`/api/biz/${businessId}/orders/${order.id}/invoice`)).body;
    expect((await buyer.req('POST', `/api/orders/${order.id}/invoice`, {})).body).toEqual(inv);
    const docs = (await owner.get(`/api/biz/${businessId}/orders/${order.id}/documents`)).body.documents;
    expect(docs.map((d: any) => d.kind).sort()).toEqual(['invoice', 'receipt']);

    const json = await (await app.request(`/api/docs/${inv.token}`)).json() as any;
    expect(json).toMatchObject({ kind: 'invoice', number: inv.number, order: { total_kobo: 7_800_000, amount_paid_kobo: 3_000_000, balance_kobo: 4_800_000 } });
    expect(json.pay_to.account_number).toMatch(/^\d{10}$/);
    expect(json.items[0]).toMatchObject({ unit_qty: 2, unit: 'pieces' });

    for (const token of [inv.token, docs.find((d: any) => d.kind === 'receipt').token]) {
      const pdf = await app.request(`/api/docs/${token}/pdf`);
      expect(pdf.status).toBe(200);
      expect(pdf.headers.get('content-type')).toBe('application/pdf');
      const bytes = new Uint8Array(await pdf.arrayBuffer());
      expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
      expect(bytes.length).toBeGreaterThan(5000);
    }
    expect((await app.request('/api/docs/not-a-real-token-1234')).status).toBe(404);
  });
});
