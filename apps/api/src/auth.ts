/**
 * Authentication.
 *  - supabase mode: phone OTP + TOTP MFA via Supabase Auth (GoTrue REST). SMS goes through Termii,
 *    configured as the Supabase SMS provider.
 *  - dev mode: same JWT shape signed locally; OTP and TOTP codes are always 000000.
 * Either way the API ends up with verified Supabase-style claims that feed withUser() → RLS.
 */
import { SignJWT, createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Claims } from '@trawer/db';
import { env } from './env';
import { one, withService } from './db';
import { fetchWithTimeout } from '@trawer/core/http';

const http = fetchWithTimeout(10_000);

export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch seconds
}

export class AuthError extends Error {
  constructor(public readonly code: string, public readonly status = 400) {
    super(code);
  }
}

const devSecret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET ?? 'dev-only-jwt-secret-not-for-production-use');
const jwks = env.SUPABASE_URL && !env.SUPABASE_JWT_SECRET
  ? createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`))
  : null;

export async function verifyAccessToken(token: string): Promise<Claims> {
  const { payload } = jwks
    ? await jwtVerify(token, jwks, { audience: 'authenticated' })
    : await jwtVerify(token, devSecret, { audience: 'authenticated' });
  if (payload.role !== 'authenticated' || typeof payload.sub !== 'string') throw new AuthError('invalid_token', 401);
  return {
    sub: payload.sub,
    role: 'authenticated',
    phone: typeof payload.phone === 'string' ? (payload.phone.startsWith('+') ? payload.phone : `+${payload.phone}`) : undefined,
    aal: payload.aal === 'aal2' ? 'aal2' : 'aal1',
  };
}

/** Decode exp without verifying (only to decide whether to refresh). */
export function tokenExpiry(token: string): number {
  try {
    const part = token.split('.')[1] ?? '';
    const json = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as JWTPayload;
    return json.exp ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------------------------
// GoTrue REST helpers (supabase mode)
// ---------------------------------------------------------------------------------------------
async function gotrue<T>(path: string, body: unknown, accessToken?: string): Promise<T> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) throw new AuthError('auth_not_configured', 500);
  const res = await http(`${env.SUPABASE_URL}/auth/v1${path}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error_code?: string; msg?: string };
  if (!res.ok) {
    const code = json.error_code ?? (res.status === 429 ? 'rate_limited' : 'auth_failed');
    throw new AuthError(code, res.status === 429 ? 429 : 400);
  }
  return json;
}

function toSession(r: { access_token: string; refresh_token: string; expires_at?: number; expires_in?: number }): Session {
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresAt: r.expires_at ?? Math.floor(Date.now() / 1000) + (r.expires_in ?? 3600),
  };
}

// ---------------------------------------------------------------------------------------------
// Dev mode token issuer
// ---------------------------------------------------------------------------------------------
const DEV_CODE = '000000';

async function devIssue(userId: string, phone: string, aal: 'aal1' | 'aal2'): Promise<Session> {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await new SignJWT({ role: 'authenticated', phone, aal })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setAudience('authenticated')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(devSecret);
  const refreshToken = await new SignJWT({ typ: 'refresh', phone, aal })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setAudience('refresh')
    .setExpirationTime(now + 30 * 86400)
    .sign(devSecret);
  return { accessToken, refreshToken, expiresAt: now + 3600 };
}

function assertDev() {
  if (env.NODE_ENV === 'production') throw new AuthError('auth_not_configured', 500);
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------
export async function requestOtp(phone: string, ip: string): Promise<void> {
  await withService(async (tx) => {
    await tx.query(`select public.check_rate_limit('otp', $1, 5, 3600)`, [phone]);
    await tx.query(`select public.check_rate_limit('otp', $1, 30, 3600)`, [`ip:${ip}`]);
  });
  if (env.AUTH_MODE === 'supabase') {
    await gotrue('/otp', { phone, create_user: true });
  } else {
    assertDev();
    console.info(`[dev-auth] OTP for ${phone.slice(0, 7)}****: ${DEV_CODE}`);
  }
}

export async function verifyOtp(phone: string, code: string): Promise<Session> {
  if (env.AUTH_MODE === 'supabase') {
    return toSession(await gotrue('/verify', { type: 'sms', phone, token: code }));
  }
  assertDev();
  if (code !== DEV_CODE) throw new AuthError('invalid_code');
  const user = await withService((tx) =>
    one<{ id: string }>(tx, `insert into auth.users (phone) values ($1)
                             on conflict (phone) do update set phone = excluded.phone returning id`, [phone]),
  );
  return devIssue(user!.id, phone, 'aal1');
}

/**
 * Refresh tokens rotate, so two requests refreshing the same token at once would race and the
 * loser would sign the person out. Concurrent refreshes of one token share a single call, and the
 * result is kept for 15 s for requests that arrive just after.
 */
const inflight = new Map<string, { p: Promise<Session>; at: number }>();
export function refreshSession(refreshToken: string): Promise<Session> {
  const now = Date.now();
  for (const [k, v] of inflight) if (now - v.at > 15_000) inflight.delete(k);
  const hit = inflight.get(refreshToken);
  if (hit) return hit.p;
  const p = doRefresh(refreshToken);
  inflight.set(refreshToken, { p, at: now });
  p.catch(() => inflight.delete(refreshToken));
  return p;
}

async function doRefresh(refreshToken: string): Promise<Session> {
  if (env.AUTH_MODE === 'supabase') {
    return toSession(await gotrue('/token?grant_type=refresh_token', { refresh_token: refreshToken }));
  }
  assertDev();
  const { payload } = await jwtVerify(refreshToken, devSecret, { audience: 'refresh' }).catch(() => {
    throw new AuthError('invalid_refresh', 401);
  });
  return devIssue(payload.sub!, String(payload.phone), payload.aal === 'aal2' ? 'aal2' : 'aal1');
}

/** Start TOTP enrolment. Returns the otpauth URI to show as a QR code. */
export async function enrollTotp(session: Session): Promise<{ factorId: string; uri: string; secret: string }> {
  if (env.AUTH_MODE === 'supabase') {
    const r = await gotrue<{ id: string; totp: { uri: string; secret: string } }>(
      '/factors', { factor_type: 'totp', friendly_name: 'Trawer' }, session.accessToken);
    return { factorId: r.id, uri: r.totp.uri, secret: r.totp.secret };
  }
  assertDev();
  return { factorId: 'dev-factor', uri: 'otpauth://totp/Trawer:dev?secret=DEVDEVDEVDEVDEV&issuer=Trawer', secret: 'DEVDEVDEVDEVDEV' };
}

/** Verify a TOTP code; returns an aal2 session. */
export async function verifyTotp(session: Session, factorId: string, code: string): Promise<Session> {
  if (env.AUTH_MODE === 'supabase') {
    const ch = await gotrue<{ id: string }>(`/factors/${encodeURIComponent(factorId)}/challenge`, {}, session.accessToken);
    return toSession(await gotrue(`/factors/${encodeURIComponent(factorId)}/verify`, { challenge_id: ch.id, code }, session.accessToken));
  }
  assertDev();
  if (code !== DEV_CODE) throw new AuthError('invalid_code');
  const claims = await verifyAccessToken(session.accessToken);
  return devIssue(claims.sub!, claims.phone ?? '', 'aal2');
}
