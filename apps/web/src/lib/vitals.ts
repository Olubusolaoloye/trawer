/**
 * Real-user speed tracking (Core Web Vitals), sent once per page load to our own API.
 * No third-party script and nothing personal: page type (not the URL), phone or computer,
 * connection type, and the timings. Measured the way Chrome defines them:
 *   LCP  largest content painted (until the first input)      good ≤ 2.5 s
 *   INP  slowest interaction (tap → next paint)                good ≤ 200 ms
 *   CLS  biggest burst of layout shifts (session windows)       good ≤ 0.1
 *   FCP / TTFB  first paint / first byte
 */
type Report = { page: string; ssr: boolean; mobile: boolean; connection?: string; lcp?: number; fcp?: number; ttfb?: number; inp?: number; cls?: number };

/** Page type from the path ("store_home", "product", "dashboard"…), never the path itself. */
export function pageType(path: string, onSubdomain: boolean): string {
  const p = onSubdomain ? `/s/x${path === '/' ? '' : path}` : path;
  if (/^\/s\/[^/]+\/?$/.test(p)) return 'store_home';
  const m = /^\/s\/[^/]+\/([a-z]+)/.exec(p);
  if (m) return ({ p: 'product', cart: 'cart', checkout: 'checkout', search: 'search', orders: 'orders', account: 'account' } as Record<string, string>)[m[1]!] ?? 'store_other';
  if (p.startsWith('/dashboard')) return 'dashboard';
  if (p.startsWith('/t/')) return 'tracking';
  if (p.startsWith('/i/')) return 'invoice';
  return p === '/' ? 'landing' : 'other';
}

export function startVitals(onSubdomain: boolean): void {
  if (typeof PerformanceObserver === 'undefined') return;
  const r: Report = {
    page: pageType(location.pathname, onSubdomain),
    ssr: !!document.getElementById('ssr-data'),
    mobile: matchMedia('(pointer: coarse)').matches,
    connection: (navigator as Navigator & { connection?: { effectiveType?: string } }).connection?.effectiveType,
  };
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (nav) r.ttfb = nav.responseStart;

  const observe = (type: string, cb: (entries: PerformanceEntry[]) => void, opts: Record<string, unknown> = {}) => {
    try { new PerformanceObserver((l) => cb(l.getEntries())).observe({ type, buffered: true, ...opts } as PerformanceObserverInit); } catch { /* unsupported */ }
  };
  observe('paint', (es) => { for (const e of es) if (e.name === 'first-contentful-paint') r.fcp = e.startTime; });
  let lcpFrozen = false;
  observe('largest-contentful-paint', (es) => { if (!lcpFrozen && es.length) r.lcp = es[es.length - 1]!.startTime; });
  // CLS: largest "session window" of shifts (gap < 1 s, window < 5 s), ignoring shifts right after input.
  let win = 0, winStart = 0, last = 0;
  observe('layout-shift', (es) => {
    for (const e of es as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
      if (e.hadRecentInput) continue;
      if (win && e.startTime - last < 1000 && e.startTime - winStart < 5000) win += e.value;
      else { win = e.value; winStart = e.startTime; }
      last = e.startTime;
      r.cls = Math.max(r.cls ?? 0, win);
    }
  });
  // INP: the slowest interaction seen (one value per interaction id).
  observe('event', (es) => {
    for (const e of es as (PerformanceEntry & { interactionId?: number })[]) {
      if (!e.interactionId) continue;
      lcpFrozen = true;
      r.inp = Math.max(r.inp ?? 0, e.duration);
    }
  }, { durationThreshold: 40 });
  addEventListener('pointerdown', () => { lcpFrozen = true; }, { once: true, capture: true });

  let sent = false;
  // Sent once, when the visitor leaves or switches away (the page may never "unload" on phones).
  const send = (force = false) => {
    if (sent || (!force && document.visibilityState !== 'hidden')) return;
    sent = true;
    const body = JSON.stringify({ ...r, cls: r.cls != null ? Number(r.cls.toFixed(4)) : undefined });
    void fetch('/api/vitals', { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Trawer': '1' }, body }).catch(() => undefined);
  };
  addEventListener('visibilitychange', () => send());
  addEventListener('pagehide', () => send(true));
}
