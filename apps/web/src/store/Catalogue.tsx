import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowRight, Layers } from 'lucide-react';
import { api } from '../lib/api';
import { formatNaira, cx } from '../lib/format';
import { useStoreLocation } from '../lib/store-context';
import { Button, Empty, Spinner, fabricStyle } from '../components/ui';
import { t } from '../i18n';
import { useStore } from './StoreLayout';
import { ReorderCard } from './ReorderStrip';
import { useQuote } from './CartPage';

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
  const { lines, quote } = useQuote();
  const me = store.me;

  useEffect(() => {
    const ctrl = new AbortController();
    setItems(null);
    const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(category ? { category } : {}) });
    api<{ items: Item[]; nextCursor: string | null }>(`/api/store/${slug}/products?${qs}`, { signal: ctrl.signal })
      .then((r) => { setItems(r.items); setCursor(r.nextCursor); })
      .catch(() => !ctrl.signal.aborted && setItems([]));
    return () => ctrl.abort();
  }, [slug, q, category, me?.id]);

  async function more() {
    if (!cursor) return;
    setLoadingMore(true);
    const qs = new URLSearchParams({ cursor, ...(q ? { q } : {}), ...(category ? { category } : {}) });
    const r = await api<{ items: Item[]; nextCursor: string | null }>(`/api/store/${slug}/products?${qs}`).finally(() => setLoadingMore(false));
    setItems((prev) => [...(prev ?? []), ...r.items]);
    setCursor(r.nextCursor);
  }

  const setCategory = (v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set('category', v); else next.delete('category');
    setParams(next, { replace: true });
  };
  const count = lines.reduce((n, l) => n + l.qty, 0);

  return (
    <div className="space-y-4">
      {!me?.is_wholesale_view && (
        <Link to={href(me ? '/account' : '/account?wholesale=1')} className="flex items-center gap-3 rounded-2xl border border-[#C9CEEC] bg-indigo-50 p-3.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-indigo" aria-hidden><Layers className="size-5 text-white" /></span>
          <span className="flex-1 text-sm leading-snug text-indigo">
            {me?.wholesale_status === 'pending' ? t('store.pendingNudge') : <><b>{t('store.bulkTitle')}</b> {t('store.bulkBody')}</>}
          </span>
        </Link>
      )}

      {me?.is_wholesale_view && !q && !category && <ReorderCard />}

      {store.categories.length > 0 && (
        <nav aria-label="Categories" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {[{ category: '', n: 0 }, ...store.categories].map((c) => (
            <button key={c.category || 'all'} type="button" aria-pressed={category === c.category} onClick={() => setCategory(c.category)}
              className={cx('min-h-11 shrink-0 rounded-full border-2 px-4 text-sm',
                category === c.category ? 'border-ink bg-ink font-bold text-white' : 'border-line bg-white font-semibold')}>
              {c.category || t('store.all')}
            </button>
          ))}
        </nav>
      )}

      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-[22px] font-extrabold">{q ? `“${q}”` : category || t('store.newThisWeek')}</h2>
        {items && <span className="text-[13px] font-semibold text-muted">{items.length}{cursor ? '+' : ''} {t('store.productsCount')}</span>}
      </div>

      {items === null ? <Spinner /> : items.length === 0 ? <Empty>{t('store.noProducts')}</Empty> : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((p, i) => (
            <li key={p.id}>
              <Link to={href(`/p/${p.id}`)} className="flex h-full flex-col overflow-hidden rounded-[18px] border border-line bg-white">
                <div className="relative aspect-[4/3.9] bg-line-soft" style={p.image ? undefined : fabricStyle(p.id, p.swatches[0]?.hex)}>
                  {p.image && <img src={p.image} alt="" width={400} height={390} loading={i < 4 ? 'eager' : 'lazy'} decoding="async"
                    fetchPriority={i < 2 ? 'high' : undefined} className={cx('size-full object-cover', !p.in_stock && 'opacity-50 grayscale')} />}
                  {!p.in_stock && <span className="absolute left-2.5 top-2.5 rounded-full bg-ink px-2.5 py-0.5 text-[11px] font-extrabold text-white">{t('store.soldOutCaps')}</span>}
                </div>
                <div className="flex flex-1 flex-col gap-1 px-3 pb-3 pt-2.5">
                  <h3 className={cx('line-clamp-2 text-sm font-semibold leading-snug', !p.in_stock && 'text-muted')}>{p.name}</h3>
                  {p.price_kobo != null && (
                    <p className={cx('num font-display text-[19px] font-extrabold', me?.is_wholesale_view && 'text-indigo')}>
                      {formatNaira(p.price_kobo)}
                      {p.retail_price_kobo != null && p.retail_price_kobo > p.price_kobo && (
                        <s className="ml-1.5 font-sans text-xs font-medium text-muted">{formatNaira(p.retail_price_kobo)}</s>
                      )}
                    </p>
                  )}
                  {p.swatches.length > 1 && (
                    <div className="mt-auto flex items-center gap-1.5" aria-label={p.swatches.map((s) => s.colour).join(', ')}>
                      {p.swatches.slice(0, 4).map((s) => (
                        <span key={s.colour} title={s.colour} className={cx('size-3.5 rounded-full border border-black/10', !s.in_stock && 'opacity-30')} style={{ background: s.hex ?? '#d6d3d1' }} />
                      ))}
                      {p.swatches.length > 4 && <span className="text-xs text-muted">+{p.swatches.length - 4}</span>}
                    </div>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {cursor && <Button variant="secondary" className="w-full" onClick={() => void more()} pending={loadingMore}>{t('common.loadMore')}</Button>}

      {count > 0 && (
        <Link to={href('/cart')} className="fixed inset-x-3.5 bottom-4 z-30 mx-auto flex min-h-15 max-w-xl items-center justify-between rounded-[18px] bg-ink px-5 text-white shadow-[0_10px_30px_rgba(14,20,17,0.25)]">
          <span className="flex flex-col">
            <span className="text-[13px] text-[#D9D4C8]">{t('cart.itemsCount', { n: count })}</span>
            <b className="num font-display text-xl">{quote ? formatNaira(quote.subtotal_kobo) : '…'}</b>
          </span>
          <span className="flex items-center gap-2 font-bold">{t('cart.view')} <ArrowRight className="size-5 text-gold" aria-hidden /></span>
        </Link>
      )}
    </div>
  );
}
