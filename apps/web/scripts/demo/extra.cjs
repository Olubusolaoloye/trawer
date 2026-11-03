// Prices for every variant/unit (per role) + an order lifecycle template, from the real API.
const { request } = require('playwright');
const fs = require('fs');
const BASE = 'http://localhost:8811';
const H = { 'X-Trawer': '1' };
async function ctxFor(phone) {
  const r = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { 'x-forwarded-for': '10.9.9.' + Math.floor(Math.random() * 200) } });
  if (phone) { await r.post('/api/auth/otp', { data: { phone }, headers: H }); await r.post('/api/auth/verify', { data: { phone, code: '000000' }, headers: H }); }
  return r;
}
(async () => {
  const out = { products: {}, prices: {}, lists: {}, order: {} };
  const anon = await ctxFor(null);
  let cursor = null; const items = [];
  do {
    const r = await (await anon.get(`/api/store/balogun/products?limit=48${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`)).json();
    items.push(...r.items); cursor = r.nextCursor;
  } while (cursor);
  out.lists.all = items;
  const lines = [];
  for (const it of items) {
    const d = await (await anon.get(`/api/store/balogun/products/${it.id}`)).json();
    out.products[it.id] = d;
    for (const v of d.variants ?? []) for (const u of d.units ?? []) lines.push({ variant_id: v.id, unit_id: u.unit_id ?? u.id, qty: 1 });
  }
  console.log('products', items.length, 'lines', lines.length, 'sample product keys', Object.keys(out.products[items[0].id]));
  for (const [role, phone] of [['anon', null], ['buyer', '+2348090000001']]) {
    const c = role === 'anon' ? anon : await ctxFor(phone);
    out.prices[role] = {};
    for (let i = 0; i < lines.length; i += 40) {
      const r = await c.post('/api/store/balogun/quote', { data: { items: lines.slice(i, i + 40) }, headers: H });
      const q = await r.json();
      if (!q.lines) { console.log('quote fail', r.status(), JSON.stringify(q).slice(0, 200)); break; }
      for (const l of q.lines) out.prices[role][`${l.variant_id}|${l.unit_id}`] = l;
    }
    console.log(role, 'prices', Object.keys(out.prices[role]).length);
    if (role === 'buyer') {
      out.buyerProducts = {};
      for (const it of items) out.buyerProducts[it.id] = await (await c.get(`/api/store/balogun/products/${it.id}`)).json();
    }
  }
  // order lifecycle as the buyer
  const b = await ctxFor('+2348090000001');
  const first = lines[0];
  const co = await b.post('/api/store/balogun/checkout', { data: { items: [{ ...first, qty: 2 }], delivery_method: 'pickup' }, headers: H });
  const cj = await co.json(); console.log('checkout', co.status(), JSON.stringify(cj).slice(0, 300));
  out.order.checkout = cj;
  if (cj.order) {
    out.order.pending = await (await b.get(`/api/orders/${cj.order.id}`)).json();
    const st = await b.post('/api/dev/simulate-transfer', { data: { order_id: cj.order.id }, headers: H }); console.log('sim', st.status());
    await new Promise((r) => setTimeout(r, 1500));
    out.order.paid = await (await b.get(`/api/orders/${cj.order.id}`)).json();
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(out));
})();
