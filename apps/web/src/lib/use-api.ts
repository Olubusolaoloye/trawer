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
  const snapshot = useSyncExternalStore(subscribe, () => (key ? cache.get(key) : undefined));
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
