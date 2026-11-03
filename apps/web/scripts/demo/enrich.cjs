// Adds credit sales, deliveries, expenses and social posts to the seeded demo shop, through the real API
// (and SQL for the Instagram/Facebook connection, which needs a real Facebook login otherwise).
const { request } = require('playwright');
const { execFileSync } = require('child_process');
const BASE = process.env.DEMO_API ?? 'http://localhost:8811';
const DB = process.env.DEMO_DB ?? 'postgres://postgres:postgres@localhost:5432/trawer_demo';
const H = { 'X-Trawer': '1' };
const sql = (q) => execFileSync('psql', [DB, '-Atc', q]).toString().trim();
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
(async () => {
  const r = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { 'x-forwarded-for': '10.7.7.7' } });
  await r.post('/api/auth/otp', { data: { phone: '+2348030000001' }, headers: H });
  await r.post('/api/auth/verify', { data: { phone: '+2348030000001', code: '000000' }, headers: H });
  const f = await (await r.post('/api/auth/mfa/enroll', { data: {}, headers: H })).json();
  console.log('mfa', (await r.post('/api/auth/mfa/verify', { data: { factorId: f.factorId, code: '000000' }, headers: H })).status());
  const bid = sql(`select id from businesses where slug = 'balogun'`);
  const B = `/api/biz/${bid}`;
  const post = async (p, data) => { const x = await r.post(B + p, { data, headers: H }); if (!x.ok()) console.log('FAIL', p, x.status(), (await x.text()).slice(0, 200)); return x; };
  const { orders } = await (await r.get(`${B}/orders`)).json();

  // Credit: unpaid orders become invoices on credit; backdate one so it is overdue.
  const unpaid = orders.filter((o) => o.payment_status !== 'paid' && o.status !== 'cancelled' && o.customer);
  console.log('unpaid', unpaid.map((o) => o.order_number));
  for (const [i, o] of unpaid.slice(0, 3).entries()) await post(`/orders/${o.id}/credit`, { due_date: day([10, 3, 21][i]), note: 'Regular buyer — pays end of month' });
  if (unpaid[1]) sql(`update orders set due_date = current_date - 12 where id = '${unpaid[1].id}'`);
  if (unpaid[2]) sql(`update orders set due_date = current_date - 40 where id = '${unpaid[2].id}'`);

  // Deliveries: paid delivery orders get packed, a rider, and go out.
  const { riders } = await (await r.get(`${B}/riders`)).json();
  const rider = riders.find((x) => x.role === 'rider');
  const paid = orders.filter((o) => o.payment_status === 'paid' && o.fulfilment_status === 'confirmed');
  const deliveries = [];
  for (const o of paid) { const det = await (await r.get(`${B}/orders/${o.id}`)).json(); if (det.order?.delivery_method === 'delivery') deliveries.push(o); }
  for (const [i, o] of deliveries.entries()) {
    await post(`/orders/${o.id}/fulfilment`, { status: 'packed' });
    if (rider) await post(`/orders/${o.id}/rider`, { staff_id: rider.id });
    if (i % 2 === 0) await post(`/orders/${o.id}/fulfilment`, { status: 'dispatched' });
  }

  // Expenses this month.
  const ex = [['rent', 45000000, 'Shop rent (quarter share)'], ['transport', 1850000, 'Bus to Kano for stock'], ['data_airtime', 500000, 'Data for WhatsApp'],
    ['packaging', 1200000, 'Nylon bags and tape'], ['salaries', 12000000, 'Musa and Emeka'], ['fuel_power', 2400000, 'Generator diesel']];
  for (const [i, [category, amount_kobo, description]] of ex.entries()) await post('/reports/expenses', { category, amount_kobo, spent_on: day(-i * 2), description, method: 'cash' });

  // Social: a connected Instagram + Facebook page, with posts in each state.
  sql(`insert into social_accounts (business_id, platform, external_id, page_id, name, quota_used, quota_total, quota_checked_at)
       values ('${bid}', 'instagram', 'ig-demo', 'pg-demo', 'balogunfabrics', 4, 100, now()), ('${bid}', 'facebook', 'pg-demo', 'pg-demo', 'Balogun Fabrics', null, null, null)
       on conflict do nothing`);
  const prods = sql(`select id from products where business_id = '${bid}' order by created_at limit 8`).split('\n');
  const acc = (p) => `(select id from social_accounts where business_id = '${bid}' and platform = '${p}')`;
  const posts = [
    ['instagram', 'single', [prods[0]], 'published', -2, 'New Kano lace in Wine and Gold — wholesale by the bundle. #KanoLace #LagosFabrics'],
    ['facebook', 'carousel', prods.slice(1, 5), 'published', -1, 'This week at Balogun Fabrics: Aso-oke, Adire, George and Voile. Order on WhatsApp.'],
    ['instagram', 'carousel', prods.slice(2, 6), 'scheduled', 1, 'Weekend sale on Adire — tap the link in bio. #Adire #Ankara'],
    ['facebook', 'single', [prods[6]], 'scheduled', 2, 'Fresh Ibadan George just landed.'],
    ['instagram', 'single', [prods[7]], 'failed', -1, 'Festival voile restock.'],
  ];
  for (const [p, kind, ids, status, d, caption] of posts) {
    sql(`insert into social_posts (business_id, account_id, platform, kind, product_ids, caption, status, scheduled_for, published_at, permalink, last_error, attempts)
         values ('${bid}', ${acc(p)}, '${p}', '${kind}', array[${ids.map((x) => `'${x}'`).join(',')}]::uuid[], '${caption.replace(/'/g, "''")}', '${status}',
         now() + interval '${d} day', ${status === 'published' ? `now() + interval '${d} day'` : 'null'}, ${status === 'published' ? `'https://www.instagram.com/'` : 'null'},
         ${status === 'failed' ? `'The image was too small for Instagram (minimum 320px).'` : 'null'}, ${status === 'failed' ? 3 : 0})`);
  }
  console.log('enriched', bid);
})();
