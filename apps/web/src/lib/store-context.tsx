import { createContext, useContext } from 'react';

/**
 * Storefront location: on {slug}.trawer.shop the store lives at the root; in development or on
 * the app domain it lives under /s/{slug}. `href()` builds links for either.
 */
export interface StoreLocation { slug: string; base: string }
export const StoreCtx = createContext<StoreLocation | null>(null);

export function useStoreLocation(): StoreLocation & { href: (p: string) => string } {
  const s = useContext(StoreCtx);
  if (!s) throw new Error('outside store');
  return { ...s, href: (p: string) => `${s.base}${p.startsWith('/') ? p : `/${p}`}`.replace(/\/$/, '') || '/' };
}

const ROOT = (import.meta.env.VITE_ROOT_DOMAIN as string | undefined) ?? 'trawer.shop';
const RESERVED = new Set(['www', 'app', 'api', 'admin']);

/** Subdomain → slug (null on the app/root domain). */
export function hostStoreSlug(hostname = window.location.hostname): string | null {
  const root = ROOT.split(':')[0]!;
  if (!hostname.endsWith(`.${root}`)) return null;
  const sub = hostname.slice(0, -(root.length + 1));
  return sub && !sub.includes('.') && !RESERVED.has(sub) ? sub : null;
}
