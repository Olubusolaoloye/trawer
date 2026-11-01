/** Cart lives in localStorage per store (fast, works offline); prices are always re-quoted by the API. */
import { useSyncExternalStore } from 'react';

export interface CartLine { variant_id: string; unit_id?: string; qty: number; product_id: string; name: string; label?: string | null; image?: string | null; unit_name?: string }

const listeners = new Set<() => void>();
const key = (slug: string) => `trawer:cart:${slug}`;
const memo = new Map<string, { raw: string | null; lines: CartLine[] }>();

export function readCart(slug: string): CartLine[] {
  let raw: string | null = null;
  try { raw = localStorage.getItem(key(slug)); } catch { /* private mode */ }
  const m = memo.get(slug);
  if (m && m.raw === raw) return m.lines;
  let lines: CartLine[] = [];
  try { lines = raw ? (JSON.parse(raw) as CartLine[]) : []; } catch { lines = []; }
  memo.set(slug, { raw, lines });
  return lines;
}

function write(slug: string, lines: CartLine[]) {
  try { localStorage.setItem(key(slug), JSON.stringify(lines)); } catch { /* ignore */ }
  for (const fn of listeners) fn();
}

const same = (a: CartLine, b: Pick<CartLine, 'variant_id' | 'unit_id'>) => a.variant_id === b.variant_id && (a.unit_id ?? '') === (b.unit_id ?? '');

export const cart = {
  add(slug: string, line: CartLine) {
    const lines = [...readCart(slug)];
    const i = lines.findIndex((l) => same(l, line));
    if (i >= 0) lines[i] = { ...lines[i]!, qty: lines[i]!.qty + line.qty };
    else lines.push(line);
    write(slug, lines);
  },
  setQty(slug: string, line: Pick<CartLine, 'variant_id' | 'unit_id'>, qty: number) {
    write(slug, readCart(slug).flatMap((l) => (same(l, line) ? (qty > 0 ? [{ ...l, qty }] : []) : [l])));
  },
  clear(slug: string) {
    write(slug, []);
  },
};

export function useCart(slug: string): CartLine[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      const onStorage = (e: StorageEvent) => e.key === key(slug) && fn();
      window.addEventListener('storage', onStorage);
      return () => { listeners.delete(fn); window.removeEventListener('storage', onStorage); };
    },
    () => readCart(slug),
  );
}
