import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { many, one, withUser } from '../db';
import { ApiError, body, requireUser, type AppEnv, type Ctx } from '../http';
import { onOrderChange } from '../live';
import { env } from '../env';

export const orderRoutes = new Hono<AppEnv>();

function orderId(c: Ctx): string {
  const r = z.string().uuid().safeParse(c.req.param('id'));
  if (!r.success) throw new ApiError(404, 'not_found');
  return r.data;
}

async function loadOrder(c: Ctx, id: string) {
  return withUser(c.get('claims'), async (tx) => {
    const order = (await one<{ result: any }>(tx, `select public.get_order($1) as result`, [id]))?.result;
    if (!order) return null;
    const [account, payments, business, delivery] = await Promise.all([
      order.customer_id
        ? one(tx, `select account_number, account_name, bank_name from virtual_accounts where customer_id = $1 and status = 'active' limit 1`, [order.customer_id])
        : null,
      many(tx, `select method, amount_kobo, received_at from payments where order_id = $1 order by received_at`, [id]),
      one(tx, `select name, slug::text, brand_colour, phone from businesses where id = $1`, [order.business_id]),
      one<{ r: unknown }>(tx, `select public.order_delivery($1) r`, [id]),
    ]);
    return { order, virtual_account: account, payments, business, delivery: delivery?.r ?? null, sandbox: env.PAYMENT_PROVIDER === 'fake' };
  });
}

orderRoutes.get('/:id', async (c) => {
  requireUser(c);
  const data = await loadOrder(c, orderId(c));
  if (!data) throw new ApiError(404, 'not_found');
  return c.json(data);
});

/** Live status (Server-Sent Events). Sends a snapshot on every change, plus a heartbeat. */
orderRoutes.get('/:id/events', async (c) => {
  requireUser(c);
  const id = orderId(c);
  const first = await loadOrder(c, id);
  if (!first) throw new ApiError(404, 'not_found');
  return streamSSE(c, async (stream) => {
    let dirty = false;
    let wake: (() => void) | null = null;
    const off = await onOrderChange(id, () => {
      dirty = true;
      wake?.();
    });
    stream.onAbort(off);
    await stream.writeSSE({ event: 'order', data: JSON.stringify(first) });
    while (!stream.aborted) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 20_000);
      });
      wake = null;
      if (stream.aborted) break;
      if (dirty) {
        dirty = false;
        const snap = await loadOrder(c, id).catch(() => null);
        if (snap) await stream.writeSSE({ event: 'order', data: JSON.stringify(snap) });
      } else {
        await stream.writeSSE({ event: 'ping', data: '' });
      }
    }
    off();
  });
});

orderRoutes.post('/:id/cancel', async (c) => {
  const claims = requireUser(c);
  const { reason } = await body(c, z.object({ reason: z.string().trim().max(300).optional() }));
  await withUser(claims, (tx) => tx.query(`select public.cancel_order($1, $2)`, [orderId(c), reason ?? 'cancelled by buyer']));
  return c.json({ ok: true });
});

/** The buyer's shareable invoice for their order. */
orderRoutes.post('/:id/invoice', async (c) => {
  const claims = requireUser(c);
  const r = await withUser(claims, (tx) => one<{ r: { number: string; token: string } }>(tx, `select public.order_invoice($1) r`, [orderId(c)]));
  return c.json(r!.r);
});
