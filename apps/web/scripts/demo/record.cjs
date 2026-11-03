const { chromium, devices } = require('playwright');
const fs = require('fs');
const BASE = process.env.DEMO_API ?? 'http://localhost:8811';
const out = {};
async function crawl(role, phone, starts, allow, max) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'], baseURL: BASE });
  if (phone) {
    const h = { 'X-Trawer': '1' };
    await ctx.request.post('/api/auth/otp', { data: { phone }, headers: h });
    const r = await ctx.request.post('/api/auth/verify', { data: { phone, code: '000000' }, headers: h });
    console.log(role, 'login', r.status());
  }
  const page = await ctx.newPage();
  page.on('response', async (res) => {
    const u = new URL(res.url());
    if (!u.pathname.startsWith('/api/') || res.request().method() !== 'GET') return;
    const ct = res.headers()['content-type'] || '';
    if (!ct.includes('json')) return;
    try { out[`${role}|${u.pathname}${u.search}`] = { status: res.status(), body: await res.json() }; } catch {}
  });
  const seen = new Set(); const queue = [...starts];
  while (queue.length && seen.size < max) {
    const p = queue.shift(); if (seen.has(p)) continue; seen.add(p);
    try { await page.goto(p, { waitUntil: 'networkidle', timeout: 20000 }); } catch (e) { console.log('fail', p); continue; }
    await page.waitForTimeout(400);
    const links = await page.$$eval('a[href^="/"]', (as) => as.map((a) => a.getAttribute('href')));
    for (const l of links) { const path = l.split('#')[0]; if (allow(path) && !seen.has(path)) queue.push(path); }
  }
  console.log(role, 'pages', seen.size);
  await browser.close();
}
(async () => {
  const store = (p) => p.startsWith('/s/balogun') && !p.includes('/api/');
  await crawl('anon', null, ['/s/balogun', '/s/balogun/cart', '/s/balogun/account', '/'], store, 120);
  await crawl('buyer', '+2348090000001', ['/s/balogun', '/s/balogun/account', '/s/balogun/orders', '/s/balogun/account/privacy'], store, 140);
  const bid = process.env.DEMO_BID;
  const reports = [];
  for (const range of ['today', '7d', '30d', 'month', 'last_month']) for (const tab of ['products', 'customers', 'units', 'expenses', 'stock']) reports.push(`/dashboard/${bid}/reports?range=${range}&tab=${tab}`);
  await crawl('owner', '+2348030000001', ['/dashboard', ...(bid ? reports : [])], (p) => (p.startsWith('/dashboard') && !p.includes('/reports')) || p.startsWith('/i/') || p.startsWith('/t/'), 450);
  fs.writeFileSync(process.argv[2], JSON.stringify(out));
  console.log('keys', Object.keys(out).length);
})();
