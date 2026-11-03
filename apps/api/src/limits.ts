/** Rate limits (server-only: the database refuses these calls from browsers). Keys are hashed in the DB. */
import { withService } from './db';
import { clientIp, type Ctx } from './http';

export type LimitScope = 'signup' | 'checkout' | 'public' | 'client_error' | 'privacy' | 'import' | 'ai_draft';
export async function rateLimit(scope: LimitScope, subject: string, max: number, windowSeconds: number): Promise<void> {
  await withService((tx) => tx.query(`select public.check_rate_limit($1, $2, $3, $4)`, [scope, subject, max, windowSeconds]));
}

/** Per-user and per-IP limits together (the IP limit is looser: shared phones and offices). */
export async function limitUserAndIp(c: Ctx, scope: LimitScope, userId: string, perUser: number, perIp: number, windowSeconds = 3600): Promise<void> {
  await rateLimit(scope, `u:${userId}`, perUser, windowSeconds);
  await rateLimit(scope, `ip:${clientIp(c)}`, perIp, windowSeconds);
}
