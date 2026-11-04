/**
 * Error monitoring. Always logs a structured line locally; also sends to Sentry when SENTRY_DSN is
 * set, through Sentry's envelope endpoint (no SDK, nothing third-party in the browser: browser
 * errors come to /api/client-errors on our own origin and are relayed from here).
 * Personal data never leaves: phone numbers, JWTs, secret keys, emails and long URL tokens (tracking,
 * invoice and connect links) are masked in messages, stacks and context.
 */
import { randomUUID } from 'node:crypto';
import { env } from './env';
import { fetchWithTimeout } from '@trawer/core/http';

const PHONE = /\+?234\d{10}|\b0[789][01]\d{8}\b/g;
const TOKEN = /(eyJ[\w-]+\.[\w-]+\.[\w-]+)|(sk_(live|test)_\w+)|(EAA[A-Za-z0-9]{20,})/g;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const URL_TOKEN = /\/(t|i|docs|track|choices)\/[A-Za-z0-9_-]{12,}/g;

export function scrub(s: string): string {
  return s.replace(TOKEN, '[token]').replace(PHONE, '[phone]').replace(EMAIL, '[email]').replace(URL_TOKEN, '/$1/[token]');
}

function scrubValue(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return scrub(v).slice(0, 2000);
  if (depth > 3 || v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => scrubValue(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v).slice(0, 40)) out[k] = /token|secret|password|authorization|cookie|phone|code/i.test(k) ? '[redacted]' : scrubValue(x, depth + 1);
  return out;
}

/** "at fn (file:line:col)" → Sentry frames (oldest first, as Sentry expects). */
function frames(stack: string): { function?: string; filename?: string; lineno?: number; colno?: number }[] {
  return stack.split('\n').slice(1, 40).map((l) => {
    const m = /at (?:(.+?) )?\(?(.+?):(\d+):(\d+)\)?$/.exec(l.trim());
    return m ? { function: m[1], filename: scrub(m[2]!), lineno: Number(m[3]), colno: Number(m[4]) } : null;
  }).filter((f): f is NonNullable<typeof f> => !!f).reverse();
}

// Flood guard: the same error at most 5 times a minute per process.
const recent = new Map<string, { n: number; at: number }>();
function allow(key: string): boolean {
  const now = Date.now();
  const r = recent.get(key);
  if (!r || now - r.at > 60_000) { recent.set(key, { n: 1, at: now }); if (recent.size > 500) recent.clear(); return true; }
  r.n += 1;
  return r.n <= 5;
}

export interface Report { message: string; type: string; stack?: string; platform: 'node' | 'javascript'; level?: 'error' | 'warning'; tags?: Record<string, string>; extra?: Record<string, unknown> }

export function sendToSentry(r: Report): void {
  if (!env.SENTRY_DSN) return;
  try {
    const dsn = new URL(env.SENTRY_DSN);
    const project = dsn.pathname.replace(/^\//, '');
    const eventId = randomUUID().replace(/-/g, '');
    const event = {
      event_id: eventId, timestamp: Date.now() / 1000, platform: r.platform, level: r.level ?? 'error',
      environment: env.NODE_ENV, release: process.env.RELEASE ?? undefined, tags: r.tags,
      exception: { values: [{ type: r.type, value: r.message, stacktrace: r.stack ? { frames: frames(r.stack) } : undefined }] },
      extra: r.extra,
    };
    const body = `${JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`;
    void fetchWithTimeout(5_000)(`${dsn.protocol}//${dsn.host}/api/${project}/envelope/?sentry_key=${dsn.username}&sentry_version=7`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-sentry-envelope' }, body,
    }).catch(() => undefined);
  } catch {
    /* reporting must never break a request */
  }
}

export function logError(err: unknown, ctx: Record<string, unknown> = {}): void {
  const e = err instanceof Error ? err : new Error(String(err));
  const message = scrub(e.message);
  const extra = scrubValue(ctx) as Record<string, unknown>;
  console.error(JSON.stringify({ level: 'error', message, stack: scrub(e.stack ?? ''), ...extra }));
  if (!allow(`${e.name}:${message}`)) return;
  sendToSentry({ message, type: e.name, stack: e.stack, platform: 'node', extra,
    tags: { ...(typeof extra.at === 'string' ? { at: extra.at } : {}), ...(typeof extra.requestId === 'string' ? { request_id: extra.requestId } : {}) } });
}

/** A browser error relayed by /api/client-errors (already size-limited and rate-limited). */
export function logClientError(r: { message: string; type?: string; stack?: string; url?: string; release?: string; component?: string }): void {
  const message = scrub(r.message).slice(0, 500);
  const extra = scrubValue({ url: r.url, component: r.component, release: r.release }) as Record<string, unknown>;
  console.error(JSON.stringify({ level: 'error', source: 'browser', message, ...extra }));
  if (!allow(`client:${message}`)) return;
  sendToSentry({ message, type: (r.type ?? 'Error').slice(0, 60), stack: r.stack ? scrub(r.stack).slice(0, 8000) : undefined, platform: 'javascript', extra, tags: { source: 'browser' } });
}
