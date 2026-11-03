/**
 * Start-up prefetch: on a storefront home page, ask for the shop and its first page of products
 * the moment the script runs, in parallel with React starting, instead of one after the other.
 * Components then pick up these in-flight requests (no second fetch).
 */
import { api } from './api';
import { preload } from './use-api';
import { hostStoreSlug } from './store-context';

const early = new Map<string, Promise<unknown>>();

/** Use a prefetched response once if it's for exactly this URL; otherwise null. */
export function takeEarly<T>(url: string): Promise<T> | null {
  const p = early.get(url) as Promise<T> | undefined;
  if (p) early.delete(url);
  return p ?? null;
}

export function startEarlyFetches(): void {
  const sub = hostStoreSlug();
  const m = sub ? ['', sub] : /^\/s\/([a-z0-9-]+)\/?$/.exec(location.pathname);
  if (!m) return;
  if (sub && location.pathname !== '/') return;
  const slug = m[1]!;
  preload(`/api/store/${slug}`);
  const sp = new URLSearchParams(location.search);
  const qs = new URLSearchParams({ ...(sp.get('q') ? { q: sp.get('q')! } : {}), ...(sp.get('category') ? { category: sp.get('category')! } : {}) });
  const url = `/api/store/${slug}/products?${qs}`;
  const p = api(url);
  p.catch(() => undefined);
  early.set(url, p);
}
