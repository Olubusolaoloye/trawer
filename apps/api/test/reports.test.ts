import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, Client, phone } from './client';
import { pool } from '../src/db';
import { closeLive } from '../src/live';

let owner: Client;
let businessId: string;
let slug: string;
let variantId: string;
const today = new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
const weekAgo = new Date(Date.now() + 3600_000 - 6 * 86400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  owner = new Client();
  await owner.signIn(phone(), true);
  slug = `rp-${Date.now() % 100000}`;
  businessId = (await owner.post('/api/biz', { name: 'Report Fabrics', slug, kind: 'wholesaler', brand_colour: '#23308C' })).body.business_id;
  const p = await owner.post(`/api/biz/${businessId}/products`, { name: '=SUM(A1:A9)', status: 'active', base_unit: 'piece',
    variants: [{ colour: 'Blue', retail_price_kobo: 1_000_000, cost_kobo: 600_000, opening_stock: 100 }] });
  variantId = (await owner.get(`/api/biz/${businessId}/products/${p.body.id}`)).body.variants[0].id;
  const buyer = new Client();
  await buyer.signIn(phone());
  await buyer.post(`/api/store/${slug}/register`, { buyer_type: 'retail_buyer', name: 'Ada Obi', accept_terms: true });
  const o = (await buyer.post(`/api/store/${slug}/checkout`, { items: [{ variant_id: variantId, qty: 3 }] })).body.order;
  await owner.post(`/api/biz/${businessId}/orders/${o.id}/payments`, { amount_kobo: o.total_kobo, method: 'transfer' });
});
afterAll(async () => { await closeLive(); await pool.end(); });

describe('reports API', () => {
  it('summary, products and stock value over HTTP', async () => {
    const qs = `from=${weekAgo}&to=${today}`;
    const s = (await owner.get(`/api/biz/${businessId}/reports/summary?${qs}`)).body;
    expect(s).toMatchObject({ sales_kobo: 3_000_000, orders: 1, gross_profit_kobo: 1_200_000, margin_pct: 40, cost_coverage_pct: 100 });
    const p = (await owner.get(`/api/biz/${businessId}/reports/products?${qs}`)).body;
    expect(p.products[0]).toMatchObject({ base_qty: 3, gross_profit_kobo: 1_200_000 });
    const st = (await owner.get(`/api/biz/${businessId}/reports/stock`)).body;
    expect(st).toMatchObject({ units: 97, retail_value_kobo: 97_000_000, cost_value_kobo: 58_200_000 });
    expect((await owner.get(`/api/biz/${businessId}/reports/summary?from=${today}&to=${weekAgo}`)).status).toBe(422);
  });

  it('expenses: add, edit, delete; they reduce net profit', async () => {
    const add = await owner.post(`/api/biz/${businessId}/reports/expenses`, { category: 'transport', amount_kobo: 250_000, spent_on: today, description: 'Keke to Balogun' });
    expect(add.status).toBe(201);
    expect((await owner.req('PUT', `/api/biz/${businessId}/reports/expenses/${add.body.id}`, { category: 'transport', amount_kobo: 300_000, spent_on: today })).status).toBe(200);
    const s = (await owner.get(`/api/biz/${businessId}/reports/summary?from=${today}&to=${today}`)).body;
    expect(s).toMatchObject({ expenses_kobo: 300_000, net_profit_kobo: 900_000 });
    const extra = await owner.post(`/api/biz/${businessId}/reports/expenses`, { category: 'other', amount_kobo: 100, spent_on: today });
    expect((await owner.req('DELETE', `/api/biz/${businessId}/reports/expenses/${extra.body.id}`)).status).toBe(200);
    expect((await owner.get(`/api/biz/${businessId}/reports/expenses?from=${today}&to=${today}`)).body.expenses).toHaveLength(1);
  });

  it('CSV downloads open safely in spreadsheets', async () => {
    const r = await owner.get(`/api/biz/${businessId}/reports/export/products.csv?from=${weekAgo}&to=${today}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(r.headers.get('content-disposition')).toBe(`attachment; filename="trawer-products-${weekAgo}_${today}.csv"`);
    const text = r.body as string;
    expect(text).toContain(`"'=SUM(A1:A9)"`);            // a product name can't run as a formula
    expect(text.split('\r\n')[1]).toMatch(/,3,"piece",1,30000,18000,12000,40,$/);
    for (const k of ['daily', 'customers', 'expenses']) expect((await owner.get(`/api/biz/${businessId}/reports/export/${k}.csv?from=${weekAgo}&to=${today}`)).status).toBe(200);
    expect((await owner.get(`/api/biz/${businessId}/reports/export/stock.csv`)).status).toBe(200);
    expect((await owner.get(`/api/biz/${businessId}/reports/export/passwords.csv`)).status).toBe(404);
  });

  it('cashiers get neither reports nor expenses', async () => {
    const cashierPhone = phone();
    await owner.post(`/api/biz/${businessId}/staff`, { phone: cashierPhone, role: 'cashier' });
    const cashier = new Client();
    await cashier.signIn(cashierPhone);
    expect((await cashier.get(`/api/biz/${businessId}/reports/summary?from=${today}&to=${today}`)).status).toBe(403);
    expect((await cashier.post(`/api/biz/${businessId}/reports/expenses`, { category: 'rent', amount_kobo: 100, spent_on: today })).status).toBe(403);
    expect((await cashier.get(`/api/biz/${businessId}/reports/export/products.csv?from=${today}&to=${today}`)).status).toBe(403);
  });
});
