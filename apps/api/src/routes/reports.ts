/** Reports + expenses: /api/biz/:bid/reports/*. Permission checks happen in the database functions. */
import { Hono } from 'hono';
import { z } from 'zod';
import { uuid } from '@trawer/core/schemas';
import { naira, toCsv } from '@trawer/core/csv';
import { many, one, withUser } from '../db';
import { ApiError, body, query, requireUser, type AppEnv, type Ctx } from '../http';

export const reportRoutes = new Hono<AppEnv>();

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const range = z.object({
  from: day, to: day,
  channel: z.enum(['web', 'whatsapp', 'instagram', 'facebook', 'pos']).optional(),
});
const bizId = (c: Ctx) => uuid.parse(c.req.param('bid'));
const asUser = <T>(c: Ctx, fn: Parameters<typeof withUser<T>>[1]) => withUser(requireUser(c), fn);

reportRoutes.get('/summary', async (c) => {
  const r = query(c, range);
  return c.json((await asUser(c, (tx) => one(tx, `select public.report_summary($1, $2, $3, $4) r`, [bizId(c), r.from, r.to, r.channel ?? null])))!.r);
});
reportRoutes.get('/products', async (c) => {
  const r = query(c, range);
  return c.json((await asUser(c, (tx) => one(tx, `select public.report_products($1, $2, $3, $4, 200) r`, [bizId(c), r.from, r.to, r.channel ?? null])))!.r);
});
reportRoutes.get('/customers', async (c) => {
  const r = query(c, range);
  return c.json((await asUser(c, (tx) => one(tx, `select public.report_customers($1, $2, $3, $4, 100) r`, [bizId(c), r.from, r.to, r.channel ?? null])))!.r);
});
reportRoutes.get('/stock', async (c) =>
  c.json((await asUser(c, (tx) => one(tx, `select public.report_stock_value($1) r`, [bizId(c)])))!.r));

// ------------------------------------------------------------------------------------------
// Expenses
// ------------------------------------------------------------------------------------------
const expenseInput = z.object({
  category: z.enum(['rent', 'salaries', 'transport', 'delivery', 'fuel_power', 'data_airtime', 'marketing', 'bank_charges', 'taxes_levies', 'repairs', 'packaging', 'other']),
  amount_kobo: z.number().int().positive().max(100_000_000_000),
  spent_on: day,
  description: z.string().trim().max(200).optional(),
  method: z.enum(['cash', 'transfer', 'card', 'other']).default('cash'),
});
const listExpenses = (c: Ctx, from: string, to: string) => asUser(c, (tx) => many(tx,
  `select id, category, amount_kobo, spent_on, description, method, created_at from expenses
   where business_id = $1 and deleted_at is null and spent_on between $2 and $3 order by spent_on desc, created_at desc limit 500`, [bizId(c), from, to]));

reportRoutes.get('/expenses', async (c) => {
  const r = query(c, range);
  return c.json({ expenses: await listExpenses(c, r.from, r.to) });
});
reportRoutes.post('/expenses', async (c) => {
  const e = await body(c, expenseInput);
  const r = await asUser(c, (tx) => one<{ id: string }>(tx, `select public.save_expense($1, null, $2, $3, $4, $5, $6) id`, [bizId(c), e.category, e.amount_kobo, e.spent_on, e.description ?? null, e.method]));
  return c.json({ id: r!.id }, 201);
});
reportRoutes.put('/expenses/:eid', async (c) => {
  const e = await body(c, expenseInput);
  await asUser(c, (tx) => tx.query(`select public.save_expense($1, $2, $3, $4, $5, $6, $7)`, [bizId(c), uuid.parse(c.req.param('eid')), e.category, e.amount_kobo, e.spent_on, e.description ?? null, e.method]));
  return c.json({ ok: true });
});
reportRoutes.delete('/expenses/:eid', async (c) => {
  await asUser(c, (tx) => tx.query(`select public.delete_expense($1)`, [uuid.parse(c.req.param('eid'))]));
  return c.json({ ok: true });
});

// ------------------------------------------------------------------------------------------
// CSV downloads (open in Excel / Google Sheets)
// ------------------------------------------------------------------------------------------
reportRoutes.get('/export/:kind{(daily|products|customers|expenses|stock)\\.csv}', async (c) => {
  const kind = c.req.param('kind').replace('.csv', '');
  const r = kind === 'stock' ? null : query(c, range);
  const args = r ? [bizId(c), r.from, r.to, r.channel ?? null] : [bizId(c)];
  let csv: string;
  if (kind === 'daily') {
    const s = (await asUser(c, (tx) => one(tx, `select public.report_summary($1, $2, $3, $4) r`, args)))!.r;
    csv = toCsv(s.days as any[], [
      { header: 'Date', value: (d) => d.day }, { header: 'Orders', value: (d) => d.orders },
      { header: 'Sales (₦)', value: (d) => naira(d.sales_kobo) },
      ...(s.costs_visible ? [{ header: 'Gross profit (₦)', value: (d: any) => naira(d.gross_profit_kobo) }] : []),
    ]);
  } else if (kind === 'products') {
    const p = (await asUser(c, (tx) => one(tx, `select public.report_products($1, $2, $3, $4, 500) r`, args)))!.r;
    csv = toCsv(p.products as any[], [
      { header: 'Product', value: (x) => x.name }, { header: 'Category', value: (x) => x.category },
      { header: 'Units sold', value: (x) => x.base_qty }, { header: 'Base unit', value: (x) => x.base_unit },
      { header: 'Orders', value: (x) => x.orders }, { header: 'Sales (₦)', value: (x) => naira(x.sales_kobo) },
      ...(p.costs_visible ? [
        { header: 'Cost (₦)', value: (x: any) => naira(x.cost_kobo) }, { header: 'Gross profit (₦)', value: (x: any) => naira(x.gross_profit_kobo) },
        { header: 'Margin %', value: (x: any) => x.margin_pct }, { header: 'Cost missing', value: (x: any) => (x.missing_cost ? 'yes' : null) },
      ] : []),
    ]);
  } else if (kind === 'customers') {
    const p = (await asUser(c, (tx) => one(tx, `select public.report_customers($1, $2, $3, $4, 500) r`, args)))!.r;
    csv = toCsv(p.customers as any[], [
      { header: 'Customer', value: (x) => x.name }, { header: 'Type', value: (x) => x.buyer_type }, { header: 'Orders', value: (x) => x.orders },
      { header: 'Sales (₦)', value: (x) => naira(x.sales_kobo) }, { header: 'Owes now (₦)', value: (x) => naira(x.owing_kobo) }, { header: 'Last order', value: (x) => x.last_order_day },
    ]);
  } else if (kind === 'expenses') {
    const rows = await listExpenses(c, r!.from, r!.to);
    csv = toCsv(rows, [
      { header: 'Date', value: (x) => x.spent_on }, { header: 'Category', value: (x) => x.category }, { header: 'Description', value: (x) => x.description },
      { header: 'Paid by', value: (x) => x.method }, { header: 'Amount (₦)', value: (x) => naira(x.amount_kobo) },
    ]);
  } else {
    const s = (await asUser(c, (tx) => one(tx, `select public.report_stock_value($1) r`, args)))!.r;
    csv = toCsv(s.categories as any[], [
      { header: 'Category', value: (x) => x.category }, { header: 'Units on hand', value: (x) => x.units },
      { header: 'Retail value (₦)', value: (x) => naira(x.retail_value_kobo) },
      ...(s.costs_visible ? [{ header: 'Cost value (₦)', value: (x: any) => naira(x.cost_value_kobo) }] : []),
    ]);
  }
  const name = `trawer-${kind}${r ? `-${r.from}_${r.to}` : ''}.csv`;
  return c.body(csv, 200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
});

