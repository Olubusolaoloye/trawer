import { expect, test } from '@playwright/test';

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
