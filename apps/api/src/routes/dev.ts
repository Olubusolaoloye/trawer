/** Development-only helpers (never mounted in production). */
import { Hono } from 'hono';
import { z } from 'zod';
import { FakePaymentProvider } from '@trawer/core/payments';
import { one, withService } from '../db';
import { ApiError, body, type AppEnv } from '../http';
import { paymentProvider } from '../payments';
import { webhookRoutes } from './webhooks';

export const devRoutes = new Hono<AppEnv>();

/** Simulate a bank transfer into the buyer's virtual account (goes through the real webhook). */
devRoutes.post('/simulate-transfer', async (c) => {
  const p = paymentProvider();
  if (!(p instanceof FakePaymentProvider)) throw new ApiError(400, 'only_with_fake_provider');
  const { order_id, amount_kobo } = await body(c, z.object({ order_id: z.string().uuid(), amount_kobo: z.number().int().positive().optional() }));
  const row = await withService((tx) => one<{ account_number: string; balance_kobo: number }>(tx,
    `select va.account_number, o.balance_kobo from orders o join virtual_accounts va on va.customer_id = o.customer_id
     where o.id = $1 and va.status = 'active'`, [order_id]));
  if (!row) throw new ApiError(404, 'no_virtual_account');
  const { body: payload, signature } = p.simulateTransfer(row.account_number, amount_kobo ?? row.balance_kobo, `sim_${crypto.randomUUID()}`);
  const res = await webhookRoutes.request('/paystack', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature },
    body: payload,
  });
  return c.json({ webhook_status: res.status });
});
