import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Clock, Search, X } from 'lucide-react';
import { useApi } from '../lib/use-api';
import { useStoreLocation } from '../lib/store-context';
import { Empty, ProductGridSkeleton } from '../components/ui';
import { t } from '../i18n';
import { useStore } from './StoreLayout';
import { AppBar, Sheet, useBand } from './kit';
import { ProductGrid, productsUrl, type Item } from './Catalogue';
import { cx } from '../lib/format';

const RECENT = (slug: string) => `trawer:recent:${slug}`;
function readRecent(slug: string): string[] {
  try { return (JSON.parse(localStorage.getItem(RECENT(slug)) ?? '[]') as string[]).slice(0, 8); } catch { return []; }
}

/** Search with recent searches and categories to tap. */
export function SearchPage() {
  const { slug, href } = useStoreLocation();
  const store = useStore().data!;
  const band = useBand();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const [text, setText] = useState(q);
  const [recent, setRecent] = useState<string[]>(() => readRecent(slug));
  const input = useRef<HTMLInputElement>(null);
  const active = !!(q || category);
  const { data, loading } = useApi<{ items: Item[]; nextCursor: string | null }>(active ? productsUrl(slug, q, category) : null);

  useEffect(() => { if (!active) input.current?.focus(); }, [active]);

  const go = (next: { q?: string; category?: string }) => {
    const n = new URLSearchParams();
    if (next.q) n.set('q', next.q);
    if (next.category) n.set('category', next.category);
    setParams(n, { replace: true });
    if (next.q) {
      const r = [next.q, ...recent.filter((x) => x.toLowerCase() !== next.q!.toLowerCase())].slice(0, 8);
      setRecent(r);
      try { localStorage.setItem(RECENT(slug), JSON.stringify(r)); } catch { /* private mode */ }
    }
  };
  const clearRecent = () => { setRecent([]); try { localStorage.removeItem(RECENT(slug)); } catch { /* ignore */ } };
  const chip = 'press inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-semibold';

  return (
    <div className="flex flex-1 flex-col">
      <AppBar title={t('common.search')} back={href('/')}>
        <form role="search" data-field onSubmit={(e) => { e.preventDefault(); go({ q: text.trim(), category }); input.current?.blur(); }}
          className={cx('flex min-h-13 items-center gap-2.5 rounded-2xl px-4 focus-within:ring-4', band ? 'bg-surface text-ink shadow-[0_10px_26px_-14px_rgb(0_0_0/0.5)] focus-within:ring-white/35' : 'border border-line bg-surface focus-within:ring-ink/10')}>
          <Search className="size-5 shrink-0 text-muted" aria-hidden />
          <input ref={input} type="search" enterKeyHint="search" aria-label={t('common.search')} placeholder={t('store.searchPlaceholder')} value={text} onChange={(e) => setText(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-base font-medium outline-none placeholder:text-muted focus-visible:outline-none" />
          {text && <button type="button" aria-label={t('common.clear')} onClick={() => { setText(''); go({}); input.current?.focus(); }} className="flex size-8 items-center justify-center rounded-full bg-line-soft"><X className="size-4" aria-hidden /></button>}
        </form>
      </AppBar>
      <Sheet className="px-4 pb-8">
        {!active ? (
          <div className="space-y-6">
            {recent.length > 0 && (
              <section aria-labelledby="recent-h" className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <h2 id="recent-h" className="font-display text-lg font-extrabold">{t('search.recent')}</h2>
                  <button type="button" onClick={clearRecent} className="min-h-10 text-sm font-bold text-muted underline-offset-4 hover:underline">{t('common.clear')}</button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {recent.map((r, i) => (
                    <button key={r} type="button" onClick={() => { setText(r); go({ q: r }); }} className={cx(chip, i === 0 ? 'bg-ink text-paper' : 'border border-line bg-surface')}>
                      <Clock className="size-4 opacity-70" aria-hidden />{r}
                    </button>
                  ))}
                </div>
              </section>
            )}
            {store.categories.length > 0 && (
              <section aria-labelledby="cats-h" className="space-y-2.5">
                <h2 id="cats-h" className="font-display text-lg font-extrabold">{t('search.categories')}</h2>
                <ul className="grid grid-cols-2 gap-2.5">
                  {store.categories.map((c) => (
                    <li key={c.category}>
                      <button type="button" onClick={() => go({ category: c.category })}
                        className="press flex min-h-16 w-full items-center justify-between rounded-2xl border border-line/60 bg-surface px-4 text-left shadow-card">
                        <span className="font-bold">{c.category}</span>
                        <span className="num rounded-full bg-accent-soft px-2 py-0.5 text-xs font-extrabold text-accent-text">{c.n}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        ) : (
          <section aria-labelledby="results-h" className="space-y-3">
            <div className="flex items-baseline justify-between gap-3">
              <h2 id="results-h" className="font-display text-xl font-extrabold">{q ? `“${q}”` : category}</h2>
              {data && <span className="text-[13px] font-semibold text-muted">{data.items.length}{data.nextCursor ? '+' : ''} {t('store.productsCount')}</span>}
            </div>
            {category && q && <button type="button" onClick={() => go({ q })} className={cx(chip, 'bg-ink text-paper')}>{category}<X className="size-4" aria-hidden /></button>}
            {loading || !data ? <ProductGridSkeleton n={4} /> : data.items.length === 0 ? <Empty>{t('store.noProducts')}</Empty>
              : <ProductGrid items={data.items} design={store.design} wholesale={!!store.me?.is_wholesale_view} />}
          </section>
        )}
      </Sheet>
    </div>
  );
}
