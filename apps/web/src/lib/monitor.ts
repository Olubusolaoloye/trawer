/**
 * Browser error reporting → /api/client-errors on our own origin (the server scrubs and relays to
 * Sentry). No third-party script, so the strict CSP stays as it is. Never throws, never loops.
 */
const seen = new Set<string>();
let sent = 0;

export function reportError(err: unknown, extra: { component?: string } = {}): void {
  try {
    if (import.meta.env.DEV) { console.error(err); return; }
    const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Non-error thrown');
    const key = `${e.name}:${e.message}`;
    if (seen.has(key) || sent >= 10) return; // each distinct error once per page, at most 10
    seen.add(key);
    sent += 1;
    void fetch('/api/client-errors', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-Trawer': '1' },
      body: JSON.stringify({
        message: e.message.slice(0, 1000) || e.name, type: e.name.slice(0, 80), stack: e.stack?.slice(0, 8000),
        url: `${location.origin}${location.pathname}`, // never the query string (may hold codes or tokens)
        release: import.meta.env.VITE_RELEASE as string | undefined, component: extra.component?.slice(0, 200),
      }),
    }).catch(() => undefined);
  } catch {
    /* reporting must never break the page */
  }
}

export function installGlobalHandlers(): void {
  window.addEventListener('error', (ev) => {
    if (ev.filename && !ev.filename.startsWith(location.origin)) return; // extensions, injected scripts
    reportError(ev.error ?? ev.message);
  });
  window.addEventListener('unhandledrejection', (ev) => reportError(ev.reason));
}
