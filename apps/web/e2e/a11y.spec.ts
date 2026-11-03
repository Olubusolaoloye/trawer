import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import pg from 'pg';

const DB = process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/trawer_dev';

async function signIn(page: Page, phone: string) {
  await page.getByLabel('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('6-digit code').fill('000000');
  const done = page.waitForResponse((r) => r.url().includes('/api/auth/verify') && r.ok());
  await page.getByRole('button', { name: 'Verify' }).click();
  await done;
}

/** WCAG 2.2 A/AA. Every violation is listed with the offending selectors so it can be fixed. */
async function audit(page: Page, name: string) {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const problems = r.violations.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(problems, `${name}\n${problems.join('\n')}`).toEqual([]);
}

test.beforeEach(async () => {
  const c = new pg.Client({ connectionString: DB });
  await c.connect();
  await c.query('delete from rate_limits');
  await c.end();
});

test('storefront pages (buyer)', async ({ page }) => {
  await page.goto('/s/balogun'); await page.getByRole('heading', { name: /New this week/ }).waitFor(); await audit(page, 'store home');
  await page.getByRole('listitem').filter({ has: page.locator('h3') }).first().click(); await page.getByRole('heading', { level: 1 }).waitFor(); await audit(page, 'product');
  await page.goto('/s/balogun/cart'); await audit(page, 'cart');
  await page.goto('/s/balogun/account'); await audit(page, 'sign in');
  await signIn(page, '+2348090000001');
  await page.goto('/s/balogun/account'); await page.getByText('Privacy & your data').waitFor(); await audit(page, 'account');
  await page.goto('/s/balogun/account/privacy'); await page.getByRole('heading', { name: 'Messages from shops' }).waitFor(); await audit(page, 'privacy');
  await page.goto('/s/balogun/orders'); await audit(page, 'orders');
});

test('public pages: tracking + invoice', async ({ page }) => {
  const c = new pg.Client({ connectionString: DB }); await c.connect();
  const { rows: [o] } = await c.query(`select tracking_token from orders where delivery_method = 'delivery' limit 1`);
  const { rows: [i] } = await c.query(`select public_token from invoices limit 1`);
  await c.end();
  await page.goto(`/t/${o.tracking_token}`); await page.getByRole('heading', { level: 1 }).waitFor(); await audit(page, 'tracking');
  if (i) { await page.goto(`/i/${i.public_token}`); await page.getByRole('heading', { level: 1 }).waitFor(); await audit(page, 'invoice'); }
});

test('dashboard pages (owner)', async ({ page }) => {
  await page.goto('/dashboard');
  await signIn(page, '+2348030000001');
  await page.getByText("You've taken today").waitFor();
  const base = page.url().replace(/\/$/, '');
  await audit(page, 'today');
  for (const [path, wait] of [
    ['orders', 'Orders'], ['products', 'Products'], ['customers', 'Customers'], ['debtors', 'Who owes you'], ['reports', 'Reports'],
    ['social', 'Instagram & Facebook'], ['design', 'Store design'], ['settings', 'Settings'], ['tills', 'Tills'],
  ] as const) {
    await page.goto(`${base}/${path}`);
    await page.getByRole('heading', { name: new RegExp(wait), level: 1 }).first().waitFor();
    await audit(page, path);
  }
});

test('every store theme stays accessible (owners can pick any of them)', async ({ page }) => {
  const c = new pg.Client({ connectionString: DB }); await c.connect();
  try {
    for (const theme of ['market', 'linen', 'midnight', 'bold']) {
      await c.query(`update businesses set storefront = $1::jsonb where slug = 'balogun'`, [JSON.stringify({
        theme, header: theme === 'midnight' ? 'glass' : theme === 'bold' ? 'clean' : 'brand', card: theme === 'linen' ? 'minimal' : theme === 'midnight' ? 'overlay' : 'classic',
        announcement: { enabled: true, text: 'Free delivery in Lagos this week' }, show_stock: true,
      })]);
      await page.goto('/s/balogun'); await page.getByRole('heading', { name: /New this week/ }).waitFor();
      await audit(page, `theme ${theme}`);
    }
  } finally {
    await c.query(`update businesses set storefront = '{}' where slug = 'balogun'`);
    await c.end();
  }
});
