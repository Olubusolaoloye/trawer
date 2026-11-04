/** Minimal stale-while-revalidate cache (keeps the bundle small; no query library). */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, ApiError } from './api';

interface Entry { data?: unknown; error?: ApiError; at: number; promise?: Promise<unknown> }
const cache = new Map<string, Entry>();
const subs = new Map<string, Set<() => void>>();

function notify(key: string) {
  for (const fn of subs.get(key) ?? []) fn();
}

function load(key: string): Promise<unknown> {
  const e = cache.get(key) ?? { at: 0 };
  if (e.promise) return e.promise;
  const p = api(key)
    .then((data) => cache.set(key, { data, at: Date.now() }))
    .catch((error) => cache.set(key, { ...cache.get(key), error, at: Date.now() }))
    .finally(() => notify(key));
  cache.set(key, { ...e, promise: p });
  return p;
}

/** Answers delivered with a server-rendered page: components start with them instead of fetching. */
export function seedCache(entries: Record<string, unknown>): void {
  const at = Date.now();
  for (const [key, data] of Object.entries(entries)) cache.set(key, { data, at });
}

/** Server rendering only: forget everything between requests (one render never sees another's data). */
export function resetCache(): void {
  cache.clear();
  subs.clear();
}

/** Already-loaded data for a key, if any (no fetch). */
export function peek<T>(key: string): T | undefined {
  return cache.get(key)?.data as T | undefined;
}

/** Start loading a key before any component asks for it (e.g. at page start-up). */
export function preload(key: string): void {
  if (!cache.has(key)) void load(key);
}

/**
 * Re-fetch every cached key matching prefix (call after mutations). Resolves once the mounted
 * queries have fresh data, so callers can await it before navigating.
 */
export function invalidate(prefix: string): Promise<void> {
  const pending: Promise<unknown>[] = [];
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      const e = cache.get(key)!;
      cache.set(key, { ...e, at: 0, promise: undefined });
      if (subs.get(key)?.size) pending.push(load(key));
    }
  }
  return Promise.all(pending).then(() => undefined);
}

export function useApi<T = any>(key: string | null, opts: { staleMs?: number } = {}) {
  const stale = opts.staleMs ?? 15_000;
  const subscribe = useCallback((fn: () => void) => {
    if (!key) return () => undefined;
    let set = subs.get(key);
    if (!set) subs.set(key, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }, [key]);
  const get = () => (key ? cache.get(key) : undefined);
  const snapshot = useSyncExternalStore(subscribe, get, get);
  useEffect(() => {
    if (!key) return;
    const e = cache.get(key);
    if (!e || (!e.promise && Date.now() - e.at > stale)) void load(key);
  }, [key, stale]);
  return {
    data: snapshot?.data as T | undefined,
    error: snapshot?.error,
    loading: !!key && !snapshot?.data && !snapshot?.error,
    reload: () => key && invalidate(key),
  };
}

/** Mutation helper with pending + error state. */
export function useMutation<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fn(...args);
    } catch (e) {
      if (alive.current) setError(e instanceof ApiError ? e : new ApiError(0, 'network_error'));
      return undefined;
    } finally {
      if (alive.current) setPending(false);
    }
  }, [fn]);
  return { run, pending, error, setError };
}

/**
 * Optimistic update: change the cached data for `key` now, send the request, roll back if it fails,
 * then refresh from the server to settle any difference.
 */
export async function optimistic<T>(key: string, update: (data: T) => T, request: () => Promise<unknown>): Promise<void> {
  const before = cache.get(key);
  if (before?.data !== undefined) {
    cache.set(key, { ...before, data: update(before.data as T) });
    notify(key);
  }
  try {
    await request();
  } catch (err) {
    if (before) { cache.set(key, before); notify(key); }
    throw err;
  } finally {
    void invalidate(key);
  }
}
