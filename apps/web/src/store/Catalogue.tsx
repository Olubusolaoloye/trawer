import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Search } from 'lucide-react';
import { api } from '../lib/api';
import { formatNaira, cx } from '../lib/format';
import { useStoreLocation } from '../lib/store-context';
import { Button, Empty, Input, Spinner } from '../components/ui';
import { t } from '../i18n';
import { useStore } from './StoreLayout';
import { ReorderStrip } from './ReorderStrip';

interface Item {
  id: string; name: string; category: string | null; image: string | null;
  price_kobo: number | null; retail_price_kobo: number | null; in_stock: boolean;
  swatches: { colour: string; hex: string | null; in_stock: boolean }[];
}

export function Catalogue() {
  const { slug, href } = useStoreLocation();
  const store = useStore().data!;
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const [items, setItems] = useState<Item[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [draft, setDraft] = useState(q);

  useEffect(() => {
    const ctrl = new AbortController();
    setItems(null);
    const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(category ? { category } : {}) });
    api<{ items: Item[]; nextCursor: string | null }>(`/api/store/${slug}/products?${qs}`, { signal: ctrl.signal })
      .then((r) => { setItems(r.items); setCursor(r.nextCursor); })
      .catch(() => !ctrl.signal.aborted && setItems([]));
    return () => ctrl.abort();
  }, [slug, q, category, store.me?.id]);

  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    const qs = new URLSearchParams({ cursor, ...(q ? { q } : {}), ...(category ? { category } : {}) });
    const r = await api<{ items: Item[]; nextCursor: string | null }>(`/api/store/${slug}/products?${qs}`).finally(() => setLoadingMore(false));
    setItems((prev) => [...(prev ?? []), ...r.items]);
    setCursor(r.nextCursor);
  }

  const setFilter = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-4">
      <form role="search" onSubmit={(e) => { e.preventDefault(); setFilter('q', draft.trim()); }} className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-stone-500" aria-hidden />
        <Input type="search" aria-label={t('common.search')} placeholder={t('store.searchPlaceholder')} value={draft} onChange={(e) => setDraft(e.target.value)} className="pl-12" />
      </form>

      {store.categories.length > 0 && (
        <nav aria-label="Categories" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {[{ category: '', n: 0 }, ...store.categories].map((c) => (
            <button key={c.category || 'all'} type="button" onClick={() => setFilter('category', c.category)}
              className={cx('min-h-11 shrink-0 rounded-full border-2 px-4 text-sm font-semibold',
                category === c.category ? 'border-brand bg-brand text-brand-ink' : 'border-stone-300 bg-white')}>
              {c.category || t('store.allProducts')}
            </button>
          ))}
        </nav>
      )}

      {store.me?.is_wholesale_view && !q && !category && <ReorderStrip />}

      {items === null ? <Spinner /> : items.length === 0 ? <Empty>{t('store.noProducts')}</Empty> : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((p, i) => (
            <li key={p.id}>
              <Link to={href(`/p/${p.id}`)} className="block overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm">
                <div className="relative aspect-square bg-stone-100">
                  {p.image && <img src={p.image} alt="" width={400} height={400} loading={i < 4 ? 'eager' : 'lazy'} decoding="async"
                    fetchPriority={i < 2 ? 'high' : undefined} className={cx('size-full object-cover', !p.in_stock && 'opacity-50 grayscale')} />}
                  {!p.in_stock && <span className="absolute left-2 top-2 rounded-full bg-stone-900 px-2 py-0.5 text-xs font-bold text-white">{t('store.outOfStock')}</span>}
                </div>
                <div className="space-y-1 p-3">
                  <h2 className="line-clamp-2 text-sm font-semibold leading-snug">{p.name}</h2>
                  {p.price_kobo != null && (
                    <p className="text-base font-bold">
                      {formatNaira(p.price_kobo)}
                      {p.retail_price_kobo != null && p.retail_price_kobo > p.price_kobo && (
                        <span className="ml-1.5 text-xs font-normal text-stone-500 line-through">{formatNaira(p.retail_price_kobo)}</span>
                      )}
                    </p>
                  )}
                  {p.swatches.length > 1 && (
                    <div className="flex gap-1" aria-label={p.swatches.map((s) => s.colour).join(', ')}>
                      {p.swatches.map((s) => (
                        <span key={s.colour} title={s.colour} className={cx('size-4 rounded-full border border-stone-300', !s.in_stock && 'opacity-30')} style={{ background: s.hex ?? '#d6d3d1' }} />
                      ))}
                    </div>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {cursor && (
        <Button variant="secondary" className="w-full" onClick={() => void more()} pending={loadingMore}>{t('common.loadMore')}</Button>
      )}
    </div>
  );
}
