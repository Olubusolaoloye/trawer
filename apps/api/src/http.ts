import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { z } from 'zod';
import type { Claims } from '@trawer/db';
import { env } from './env';
import type { Session } from './auth';

export type AppEnv = { Variables: { claims: Claims | null; session: Session | null; requestId: string } };
export type Ctx = Context<AppEnv>;

export class ApiError extends HTTPException {
  constructor(status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500, public readonly code: string, public readonly details?: unknown) {
    super(status, { message: code });
  }
}

export async function body<S extends z.ZodTypeAny>(c: Ctx, schema: S): Promise<z.infer<S>> {
  const raw = await c.req.json().catch(() => {
    throw new ApiError(400, 'invalid_json');
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(422, 'validation_failed', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return parsed.data;
}

export function query<S extends z.ZodTypeAny>(c: Ctx, schema: S): z.infer<S> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) throw new ApiError(422, 'validation_failed', parsed.error.issues.map((i) => i.path.join('.')));
  return parsed.data;
}

export function requireUser(c: Ctx): Claims {
  const claims = c.get('claims');
  if (!claims) throw new ApiError(401, 'not_authenticated');
  return claims;
}

const ACCESS = 'tw_at';
const REFRESH = 'tw_rt';

function cookieDomain(): string | undefined {
  const host = env.ROOT_DOMAIN.split(':')[0]!;
  return host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host) ? undefined : `.${host}`;
}

export function readSessionCookies(c: Ctx): { access?: string; refresh?: string } {
  return { access: getCookie(c, ACCESS), refresh: getCookie(c, REFRESH) };
}

export function writeSession(c: Ctx, s: Session): void {
  const base = { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'Lax' as const, path: '/', domain: cookieDomain() };
  setCookie(c, ACCESS, s.accessToken, { ...base, maxAge: Math.max(60, s.expiresAt - Math.floor(Date.now() / 1000)) });
  setCookie(c, REFRESH, s.refreshToken, { ...base, maxAge: 30 * 86400 });
}

export function clearSession(c: Ctx): void {
  deleteCookie(c, ACCESS, { path: '/', domain: cookieDomain() });
  deleteCookie(c, REFRESH, { path: '/', domain: cookieDomain() });
}

export function clientIp(c: Ctx): string {
  return c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';
}
