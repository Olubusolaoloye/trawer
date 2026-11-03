import { expect, test } from '@playwright/test';

// Each test is its own session: start every test with fresh OTP rate-limit windows
// (the suite signs in as the same owner many times; the limiter itself is tested in the API suite).
test.beforeEach(async () => {
  const pg = await import('pg');
  const c = new pg.default.Client({ connectionString: process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/trawer_dev' });
  await c.connect();
  await c.query('delete from rate_limits');
  await c.end();
});

async function signIn(page: import('@playwright/test').Page, phone: string) {
  await page.getByLabel('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('000000');
  const done = page.waitForResponse((r) => r.url().includes('/api/auth/verify') && r.ok());
  await page.getByRole('button', { name: 'Verify' }).click();
  await done;
}

test('retail buyer: browse → swatch → cart → sign up → checkout → pay by transfer → confirmed live', async ({ page }) => {
  await page.goto('/s/balogun');
  await expect(page.getByRole('link', { name: /Balogun Fabrics/ })).toBeVisible();
  const cards = page.getByRole('listitem').filter({ has: page.locator('h3') });
  await expect(cards.first()).toBeVisible();

  // Open a multi-colour product and switch colour: the image changes instantly.
  await page.goto('/s/balogun?q=%23003');
  await cards.first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('#003');
  const img = page.locator('article img').first();
  const before = await img.getAttribute('src');
  await page.locator('fieldset button[aria-pressed="false"].rounded-full').first().click();
  await expect.poll(async () => img.getAttribute('src')).not.toBe(before);

  await page.getByRole('button', { name: /Add to cart/ }).click();
  await page.getByRole('link', { name: /Added · view cart/ }).click();
  await expect(page.getByRole('heading', { name: 'Your cart' })).toBeVisible();
  await page.getByRole('link', { name: /Checkout/ }).click();

  // Not signed in → account page → OTP → register → back to checkout
  const phone = `+23481${String(Date.now()).slice(-8)}`;
  await signIn(page, phone);
  await page.getByLabel('Your name').fill('Playwright Buyer');
  await page.getByText('I agree to the terms').click();
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Checkout' })).toBeVisible();
  await page.getByRole('button', { name: /Pay by transfer/ }).click();

  await expect(page.getByText('Transfer exactly')).toBeVisible();
  await expect(page.getByText(/^\d{4} \d{3} \d{3}$/)).toBeVisible();
  await page.getByRole('button', { name: 'Simulate transfer (sandbox)' }).click();
  // Live update over SSE — no reload.
  await expect(page.getByRole('status').filter({ hasText: /received/ })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/is confirmed/)).toBeVisible();
});

test('approved wholesaler sees wholesale prices; anonymous shopper sees retail', async ({ page }) => {
  await page.goto('/s/balogun?q=%23001');
  const card = page.getByRole('listitem').filter({ has: page.locator('h3') }).first();
  const retail = (await card.locator('p.font-display').first().textContent())!.trim();

  await page.goto('/s/balogun/account');
  await signIn(page, '+2348090000001'); // Chidi — approved wholesaler (seed)
  await page.goto('/s/balogun?q=%23001');
  await expect(page.getByText('Wholesale prices', { exact: false }).first()).toBeVisible();
  const wholesale = (await card.locator('p.font-display').first().textContent())!.trim();
  const n = (s: string) => Number(/₦([\d,]+)/.exec(s)![1]!.replace(/,/g, ''));
  expect(n(wholesale)).toBeLessThan(n(retail));
});

test('dashboard: owner signs in and sees today’s numbers and the wholesale queue', async ({ page }) => {
  await page.goto('/dashboard');
  await signIn(page, '+2348030000001');
  await expect(page.getByText("You've taken today")).toBeVisible();
  await expect(page.getByRole('heading', { name: /Needs you/ })).toBeVisible();
  await page.getByRole('link', { name: 'Review' }).click();
  await expect(page.getByText('Ngozi Eze')).toBeVisible();
  await page.goto(page.url().replace(/\/customers.*$/, '/orders'));
  await expect(page.getByText('Awaiting transfer').first()).toBeVisible();
});

test('public tracking link works without signing in and shows no personal details', async ({ page }) => {
  const pg = await import('pg');
  const c = new pg.default.Client({ connectionString: process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/trawer_dev' });
  await c.connect();
  const { rows } = await c.query(`select tracking_token, order_number from orders where delivery_method = 'delivery' order by order_number limit 1`);
  await c.end();
  await page.goto(`/t/${rows[0].tracking_token}`);
  await expect(page.getByRole('heading', { name: `Order #${rows[0].order_number}` })).toBeVisible();
  await expect(page.getByText('Balogun Fabrics').first()).toBeVisible();
  await expect(page.getByText(/\+234|Ojuelegba/)).toHaveCount(0);
});

test('owner connects WhatsApp in settings (token stays hidden, MFA asked)', async ({ page }) => {
  await page.goto('/dashboard');
  await signIn(page, '+2348030000001');
  await page.getByText("You've taken today").waitFor();
  await page.goto(page.url().replace(/\/?$/, '/settings'));
  await page.getByLabel('Phone number ID').fill('123456789012');
  await page.getByLabel('Access token').fill('a-fake-token-for-the-e2e-test-0123456789');
  await page.locator('form', { has: page.getByLabel('Phone number ID') }).getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Confirm it’s you' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('6-digit code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText(/Connected/)).toBeVisible();
  await expect(page.getByLabel('Access token')).toHaveValue('');
});

test('credit sale: owner sells on credit → debtors book → shareable invoice + PDF', async ({ page, request }) => {
  // A fresh pending order for a seeded buyer (placed the way the WhatsApp bot does, as the service role).
  const pg = await import('pg');
  const c = new pg.default.Client({ connectionString: process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/trawer_dev' });
  await c.connect();
  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
  await c.query('set local role service_role');
  const { rows: [pick] } = await c.query(`
    select b.id business_id, cu.id customer_id, cu.name, v.id variant_id, pu.unit_id
    from businesses b join customers cu on cu.business_id = b.id and cu.phone = '+2348090000003'
    join product_variants v on v.business_id = b.id and v.is_active
    join stock_levels sl on sl.variant_id = v.id and sl.available >= 2
    join product_units pu on pu.product_id = v.product_id and pu.is_base
    where b.slug = 'balogun' limit 1`);
  const { rows: [placed] } = await c.query(`select public.place_order($1::jsonb) o`, [JSON.stringify({
    business_id: pick.business_id, channel: 'whatsapp', customer_id: pick.customer_id,
    items: [{ variant_id: pick.variant_id, unit_id: pick.unit_id, qty: 2 }], delivery_method: 'pickup',
  })]);
  await c.query('commit');
  const order = placed.o;

  await page.goto('/dashboard');
  await signIn(page, '+2348030000001');
  await page.getByText("You've taken today").waitFor();
  const base = page.url().replace(/\/$/, '');
  await page.goto(`${base}/orders/${order.id}`);
  await expect(page.getByRole('heading', { name: 'Sell on credit' })).toBeVisible();
  await page.getByRole('button', { name: /Confirm on credit/ }).click();
  await expect(page.getByRole('heading', { name: 'On credit' })).toBeVisible();

  // Invoice: create, then open the public page from the documents list.
  await page.getByRole('button', { name: /Create invoice/ }).click();
  const view = page.getByRole('link', { name: /^View INV-/ });
  await expect(view).toBeVisible();
  const invoiceUrl = new URL((await view.getAttribute('href'))!, page.url()).toString();
  await expect(page.getByRole('link', { name: /^Send on WhatsApp INV-/ })).toHaveAttribute('href', /^https:\/\/wa\.me\/\?text=/);

  // Debtors book lists the buyer with this order.
  await page.goto(`${base}/debtors`);
  await expect(page.getByRole('heading', { name: 'Who owes you' })).toBeVisible();
  await expect(page.getByRole('link', { name: `#${order.order_number}` })).toBeVisible();
  await page.getByRole('link', { name: /Statement/ }).first().click();
  await expect(page.getByText('Bought on credit').first()).toBeVisible();

  // Public invoice: no sign-in needed, balance shown, no phone numbers, PDF downloads.
  await page.context().clearCookies();
  await page.goto(invoiceUrl);
  await expect(page.getByRole('heading', { name: 'Invoice' })).toBeVisible();
  await expect(page.getByText('Balance to pay')).toBeVisible();
  await expect(page.getByText(/\+234|0803/)).toHaveCount(0);
  const pdfHref = await page.getByRole('link', { name: 'Download PDF' }).getAttribute('href');
  const pdf = await request.get(pdfHref!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
  await c.end();
});

test('owner customises the store: theme + announcement show in the live preview, then for buyers after publishing', async ({ page }) => {
  await page.goto('/dashboard');
  await signIn(page, '+2348030000001');
  await page.getByText("You've taken today").waitFor();
  await page.goto(`${page.url().replace(/\/$/, '')}/design`);
  await expect(page.getByRole('heading', { name: 'Store design' })).toBeVisible();

  await page.getByRole('button', { name: /Midnight/ }).click();
  await page.getByRole('switch', { name: 'Show a message at the very top' }).click();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Free delivery in Lagos this week');
  await page.getByRole('tab', { name: 'Preview' }).click();
  const preview = page.frameLocator('iframe[title="Live preview"]');
  await expect(preview.getByText('Free delivery in Lagos this week')).toBeVisible();
  await expect(preview.locator('html')).toHaveAttribute('data-store-theme', 'midnight');

  await page.getByRole('button', { name: 'Publish changes' }).click();
  await expect(page.getByRole('button', { name: 'Published' })).toBeVisible();

  await page.context().clearCookies();
  await page.goto('/s/balogun');
  await expect(page.getByText('Free delivery in Lagos this week')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-store-theme', 'midnight');

  // Leave the demo store as it was for other tests.
  const pg = await import('pg');
  const c = new pg.default.Client({ connectionString: process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/trawer_dev' });
  await c.connect();
  await c.query(`update businesses set storefront = '{}', storefront_updated_at = null where slug = 'balogun'`);
  await c.end();
});

test('delivery: owner packs, sends out and confirms with a proof photo; the public tracking page shows the timeline', async ({ page }) => {
  const pg = await import('pg');
  const c = new pg.default.Client({ connectionString: process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/trawer_dev' });
  await c.connect();
  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
  await c.query('set local role service_role');
  const { rows: [pick] } = await c.query(`
    select b.id business_id, cu.id customer_id, v.id variant_id, pu.unit_id
    from businesses b join customers cu on cu.business_id = b.id and cu.phone = '+2348090000002'
    join product_variants v on v.business_id = b.id and v.is_active
    join stock_levels sl on sl.variant_id = v.id and sl.available >= 2
    join product_units pu on pu.product_id = v.product_id and pu.is_base
    where b.slug = 'balogun' limit 1`);
  const { rows: [placed] } = await c.query(`select public.place_order($1::jsonb) o`, [JSON.stringify({
    business_id: pick.business_id, channel: 'web', customer_id: pick.customer_id, items: [{ variant_id: pick.variant_id, unit_id: pick.unit_id, qty: 1 }],
    delivery_method: 'delivery', delivery_address: { line1: '5 Aba Road', city: 'Port Harcourt', state: 'Rivers' },
  })]);
  await c.query('commit');
  await c.query(`select app.apply_payment($1, $2, null, $3, 'transfer')`, [pick.business_id, placed.o.id, placed.o.total_kobo]);
  const { rows: [{ tracking_token }] } = await c.query(`select tracking_token from orders where id = $1`, [placed.o.id]);
  await c.end();

  await page.goto('/dashboard');
  await signIn(page, '+2348030000001');
  await page.getByText("You've taken today").waitFor();
  await page.goto(`${page.url().replace(/\/$/, '')}/orders/${placed.o.id}`);
  await page.getByRole('button', { name: 'Mark packed' }).click();
  await page.getByRole('button', { name: 'Send out for delivery' }).click();
  await page.getByRole('button', { name: 'Mark delivered' }).click();
  // 1x1 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await page.getByLabel('Add photo').setInputFiles({ name: 'proof.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText('Change photo')).toBeVisible();
  await page.getByLabel('Received by (optional)').fill('Mrs Eze');
  await page.getByRole('button', { name: 'Confirm delivered' }).click();
  await expect(page.getByRole('img', { name: 'Proof of delivery' })).toBeVisible();
  await expect(page.getByText('Received by Mrs Eze')).toBeVisible();

  await page.context().clearCookies();
  await page.goto(`/t/${tracking_token}`);
  const progress = page.getByRole('list', { name: 'Order progress' });
  await expect(progress.getByText('Delivered')).toBeVisible();
  await expect(progress.locator('p.text-muted')).toHaveCount(4); // a time under every step
  await expect(page.getByRole('img')).toHaveCount(0);           // no proof photo in public
});

test('social: owner connects Instagram + Facebook (sandbox), posts a product, and sees it published', async ({ page, request }) => {
  const pg = await import('pg');
  const db = new pg.default.Client({ connectionString: process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/trawer_dev' });
  await db.connect();
  await db.query(`delete from social_posts using businesses b where b.id = social_posts.business_id and b.slug = 'balogun'`);
  await db.query(`delete from social_accounts using businesses b where b.id = social_accounts.business_id and b.slug = 'balogun'`);

  await page.goto('/dashboard');
  await signIn(page, '+2348030000001');
  await page.getByText("You've taken today").waitFor();
  await page.goto(`${page.url().replace(/\/$/, '')}/social`);
  await page.getByRole('button', { name: 'Connect with Facebook' }).click();
  // Sandbox Facebook Login comes straight back with the Pages to choose from.
  await expect(page.getByRole('heading', { name: 'Which Page should we post to?' })).toBeVisible();
  await expect(page.getByLabel(/My Shop \(Facebook Page\)/)).toBeChecked();
  await page.getByRole('button', { name: 'Use this Page' }).click();
  await expect(page.getByRole('heading', { name: 'Confirm it’s you' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('6-digit code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByText('@myshop.ng').first()).toBeVisible();

  await page.getByLabel('Find products').fill('Kano');
  await page.getByRole('list', { name: 'Products' }).getByRole('button').first().click();
  await expect(page.getByLabel('Caption')).toHaveValue(/Kano Lace .* — ₦/);
  await page.getByRole('button', { name: 'Post now' }).click();
  await expect(page.getByText('Posting now')).toBeVisible();

  const cron = await request.post('/api/cron/social', { headers: { authorization: 'Bearer dev-cron-secret-change-me' } });
  expect(await cron.json()).toMatchObject({ published: 2 });
  await page.reload();
  await page.getByRole('tab', { name: /Published/ }).click();
  await expect(page.getByRole('link', { name: 'View' })).toHaveCount(2);
  await db.end();
});

test('reports: owner sees sales and profit, adds an expense, and downloads a CSV', async ({ page }) => {
  await page.goto('/dashboard');
  await signIn(page, '+2348030000001');
  await page.getByText("You've taken today").waitFor();
  // phones reach Reports from the Today shortcuts
  await page.getByRole('navigation', { name: 'More' }).getByRole('link', { name: 'Reports' }).click();
  await expect(page.getByRole('heading', { name: 'Reports', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: '30 days' }).click();
  const headline = page.getByRole('region', { name: 'Headline numbers' });
  await expect(headline.getByText('Gross profit', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sales by channel' })).toBeVisible();
  await expect(page.getByRole('img', { name: /Bar chart of sales and gross profit/ })).toBeVisible();

  await page.getByRole('tab', { name: 'Expenses' }).click();
  const before = await headline.getByText(/^₦/).nth(2).textContent();
  await page.getByLabel('Amount (₦)').fill('2500');
  await page.getByLabel('Category').selectOption('transport');
  const note = `Keke to Balogun market ${Date.now()}`; // unique: the dev database keeps earlier runs' expenses
  await page.getByLabel('Note').fill(note);
  await page.getByRole('button', { name: 'Add expense' }).click();
  await expect(page.getByRole('cell', { name: note })).toBeVisible();
  await expect.poll(async () => headline.getByText(/^₦/).nth(2).textContent()).not.toBe(before);

  const download = page.waitForEvent('download');
  await page.getByRole('tab', { name: 'Best sellers' }).click();
  await page.getByRole('link', { name: 'Download CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^trawer-products-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
});

test.describe('server-rendered store home', () => {
  test.use({ javaScriptEnabled: false });
  test('shows the shop and its products before any JavaScript runs', async ({ page }) => {
    const res = await page.goto('/s/balogun');
    expect(res!.headers()['cache-control']).toBe('private, no-cache');
    await expect(page).toHaveTitle('Balogun Fabrics');
    await expect(page.getByRole('heading', { name: 'Balogun Fabrics' }).first()).toBeVisible();
    await expect(page.locator('a[href^="/s/balogun/p/"]').first()).toBeVisible();
    await expect(page.locator('#products-h')).toBeVisible();
  });
});

test('server-rendered store home wakes up without refetching and stays interactive', async ({ page }) => {
  const calls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/')) calls.push(new URL(r.url()).pathname); });
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/s/balogun', { waitUntil: 'networkidle' });
  expect(calls).toEqual([]); // products and shop came with the page
  await page.getByRole('button', { name: /^Ankara/ }).click();
  await expect(page.locator('#products-h')).toHaveText('Ankara');
  expect(errors).toEqual([]); // includes React hydration mismatch reports
});

test('new staff member adds 20 products from a pasted WhatsApp list in well under 10 minutes', async ({ page }) => {
  const started = Date.now();
  await page.goto('/dashboard');
  await signIn(page, '+2348030000001');
  await page.getByText("You've taken today").waitFor();
  const base = page.url().replace(/\/$/, '');
  await page.goto(`${base}/products/import`);
  const stamp = Date.now() % 100000;
  const list = Array.from({ length: 20 }, (_, i) => `${i + 1}. Import test ${stamp} item ${i + 1} ${['red', 'blue', 'gold', 'green'][i % 4]} - ₦${(5 + i) * 1000} x ${10 + i}`).join('\n');
  await page.getByLabel('Your list').fill(list);
  await page.getByRole('button', { name: 'Read my list' }).click();
  await expect(page.getByRole('button', { name: 'Import 20 products' })).toBeVisible();
  await page.getByRole('button', { name: 'Import 20 products' }).click();
  await expect(page.getByRole('heading', { name: '20 products added' })).toBeVisible();
  expect(Date.now() - started).toBeLessThan(10 * 60_000);
});

test('snap-to-upload: photo + note → drafted product form → saved with the photo', async ({ page }) => {
  await page.goto('/dashboard');
  await signIn(page, '+2348030000001');
  await page.getByText("You've taken today").waitFor();
  const base = page.url().replace(/\/$/, '');
  await page.goto(`${base}/products/snap`);
  // A small red JPEG is enough for the sandbox drafter.
  const jpeg = Buffer.from('/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAQABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABQf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCIAAK0/9k=', 'base64');
  await page.getByLabel('Take or choose a photo').setInputFiles({ name: 'snap.jpg', mimeType: 'image/jpeg', buffer: jpeg });
  const note = `Snap test ${Date.now() % 100000}, ankara in red and blue, 15k`;
  await page.getByLabel(/Tell us about it/).fill(note);
  await page.getByRole('button', { name: 'Draft my product' }).click();
  await expect(page.getByText('Drafted from your photo')).toBeVisible();
  await expect(page.getByLabel('Product name')).toHaveValue(note.split(',')[0]!);
  await expect(page.getByLabel(/^Price ₦/).first()).toHaveValue('15000');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/products\/[0-9a-f-]{36}$/);
});

test('spreadsheet import: Excel file → columns matched → bad row reported → products added', async ({ page }) => {
  await page.goto('/dashboard');
  await signIn(page, '+2348030000001');
  await page.getByText("You've taken today").waitFor();
  await page.goto(`${page.url().replace(/\/$/, '')}/products/import`);
  await page.getByLabel('Choose a file').setInputFiles(new URL('./fixtures/stock.xlsx', import.meta.url).pathname);
  await expect(page.getByRole('heading', { name: 'Match your columns' })).toBeVisible();
  await expect(page.getByLabel('Product name *')).toHaveValue('0');
  await expect(page.getByLabel('Price (₦) *')).toHaveValue('2');
  // The dev database keeps earlier runs' products: add them again rather than skip as duplicates.
  await page.getByLabel(/Skip products already in my shop/).uncheck();
  await page.getByRole('button', { name: 'Check my products' }).click();
  await expect(page.getByText(/Row 5 · “call me” is not a price/)).toBeVisible();
  await page.getByRole('button', { name: 'Import 2 products' }).click();
  await expect(page.getByRole('heading', { name: '2 products added' })).toBeVisible();
});

test('special price: owner gives Chidi his own price (2FA asked), then removes it', async ({ page }) => {
  await page.goto('/dashboard');
  await signIn(page, '+2348030000001');
  await page.getByText("You've taken today").waitFor();
  await page.goto(`${page.url().replace(/\/$/, '')}/customers`);
  await page.getByRole('link', { name: /Chidi Okafor/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Special prices' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Find a product' }).fill('Kano Lace #001');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: /Kano Lace #001/ }).first().click();
  await page.getByLabel('Special price (₦ each)').fill('30000');
  await page.getByRole('button', { name: /^Save for \d+ colour/ }).click();
  const mfa = page.getByRole('dialog');
  await mfa.getByRole('button', { name: 'Continue' }).click();
  await mfa.getByLabel(/code/i).fill('000000');
  await mfa.getByRole('button', { name: /verify/i }).click();
  await expect(page.getByText('₦30,000').first()).toBeVisible();
  // Clean up (the dev database is shared by every run).
  const remove = page.getByRole('button', { name: /Remove special price for Kano Lace #001/ });
  while (await remove.count()) { await remove.first().click(); await page.waitForTimeout(300); }
  await expect(page.getByText('No special prices yet.')).toBeVisible();
});

test('barcode labels: pick a product, choose the sticker sheet, download a PDF', async ({ page }) => {
  await page.goto('/dashboard');
  await signIn(page, '+2348030000001');
  await page.getByText("You've taken today").waitFor();
  await page.goto(`${page.url().replace(/\/$/, '')}/products/labels`);
  await page.getByRole('searchbox', { name: 'Find a product' }).fill('Kano Lace #001');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: /Kano Lace #001/ }).first().click();
  await expect(page.getByRole('heading', { name: /To print: [1-9]/ })).toBeVisible();
  await page.getByLabel('Stickers already used on the first sheet').fill('3');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download labels (PDF)' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^labels-\d{4}-\d{2}-\d{2}\.pdf$/);
  const fs = await import('node:fs/promises');
  const bytes = await fs.readFile((await download.path())!);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
});
