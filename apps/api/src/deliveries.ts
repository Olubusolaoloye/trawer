/** Shared by the dashboard (staff) and the POS rider screen: one input shape, one database call. */
import { z } from 'zod';
import { uuid } from '@trawer/core/schemas';

export const fulfilmentInput = z.object({
  status: z.enum(['packed', 'dispatched', 'delivered', 'failed', 'returned', 'collected']),
  note: z.string().trim().max(300).optional(),
  failure: z.enum(['not_home', 'wrong_address', 'refused', 'unreachable', 'damaged', 'other']).optional(),
  proof_path: z.string().max(300).optional(),
  received_by: z.string().trim().max(80).optional(),
  client_id: uuid.optional(),
  occurred_at: z.string().datetime({ offset: true }).optional(),
});
export type FulfilmentInput = z.infer<typeof fulfilmentInput>;

export const setFulfilmentSql = `select public.set_fulfilment($1, $2::public.fulfilment_status, $3, $4::public.delivery_failure, $5, $6, $7, $8) r`;
export const fulfilmentArgs = (orderId: string, f: FulfilmentInput) =>
  [orderId, f.status, f.note ?? null, f.failure ?? null, f.proof_path ?? null, f.received_by ?? null, f.client_id ?? null, f.occurred_at ?? null];
