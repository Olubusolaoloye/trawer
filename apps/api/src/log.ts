/**
 * Error reporting. Sends to Sentry when SENTRY_DSN is set (via the HTTP store endpoint, no SDK
 * needed); always logs locally. PII scrubbing: phone numbers and tokens are masked.
 */
import { env } from './env';

const PHONE = /\+?234\d{10}|\b0[789][01]\d{8}\b/g;
const TOKEN = /(eyJ[\w-]+\.[\w-]+\.[\w-]+)|(sk_(live|test)_\w+)/g;

export function scrub(s: string): string {
  return s.replace(PHONE, '[phone]').replace(TOKEN, '[token]');
}

export function logError(err: unknown, ctx: Record<string, unknown> = {}): void {
  const e = err instanceof Error ? err : new Error(String(err));
  const message = scrub(e.message);
  console.error(JSON.stringify({ level: 'error', message, stack: scrub(e.stack ?? ''), ...ctx }));
  if (!env.SENTRY_DSN) return;
  try {
    const dsn = new URL(env.SENTRY_DSN);
    const projectId = dsn.pathname.replace('/', '');
    const url = `${dsn.protocol}//${dsn.host}/api/${projectId}/store/?sentry_key=${dsn.username}&sentry_version=7`;
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        level: 'error',
        platform: 'node',
        environment: env.NODE_ENV,
        exception: { values: [{ type: e.name, value: message, stacktrace: { frames: [] } }] },
        extra: ctx,
      }),
    }).catch(() => undefined);
  } catch {
    /* never let reporting crash a request */
  }
}
