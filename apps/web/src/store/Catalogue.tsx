import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowRight, Layers } from 'lucide-react';
import { api } from '../lib/api';
import { takeEarly } from '../lib/early';
import { formatNaira, cx } from '../lib/format';
import { useStoreLocation } from '../lib/store-context';
import { Button, Empty, ProductGridSkeleton, fabricStyle } from '../components/ui';
import { t } from '../i18n';
import { useStore, type StoreDesign, type StoreInfo } from './StoreLayout';
import { ReorderCard } from './ReorderStrip';
import { useQuote } from './CartPage';

export interface Item {
  id: string; name: string; category: string | null; image: string | null;
  price_kobo: number | null; retail_price_kobo: number | null; in_stock: boolean; few_left?: number | null;
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
  const d = store.design;
  const browsing = !!(q || category);

  useEffect(() => {
    const ctrl = new AbortController();
    setItems(null);
    const qs = new URLSearchParams({ ...(q ? { q } : {}), ...(category ? { category } : {}) });
    const url = `/api/store/${slug}/products?${qs}`;
    (takeEarly<{ items: Item[]; nextCursor: string | null }>(url) ?? api<{ items: Item[]; nextCursor: string | null }>(url, { signal: ctrl.signal }))
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

  const sections: Record<string, React.ReactNode> = {
    hero: !browsing && d.hero.enabled && <Hero store={store} onShop={setCategory} />,
    wholesale: !browsing && !me?.is_wholesale_view && (
      <Link to={href(me ? '/account' : '/account?wholesale=1')} className="lift flex items-center gap-3 rounded-2xl border border-indigo/15 bg-indigo-50 p-3.5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-indigo shadow-[0_8px_18px_-8px_rgb(35_48_140/0.8)]" aria-hidden><Layers className="size-5 text-white" /></span>
        <span className="flex-1 text-sm leading-snug text-indigo">
          {me?.wholesale_status === 'pending' ? t('store.pendingNudge') : <><b>{t('store.bulkTitle')}</b> {t('store.bulkBody')}</>}
        </span>
        <ArrowRight className="size-5 shrink-0 text-indigo" aria-hidden />
      </Link>
    ),
    reorder: !browsing && me?.is_wholesale_view && <ReorderCard />,
    categories: store.categories.length > 0 && (
      <nav aria-label="Categories" className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {[{ category: '', n: 0 }, ...store.categories].map((c) => (
          <button key={c.category || 'all'} type="button" aria-pressed={category === c.category} onClick={() => setCategory(c.category)}
            className={cx('press min-h-11 shrink-0 rounded-full px-4 text-sm transition-colors',
              category === c.category ? 'bg-ink font-bold text-paper' : 'border border-line bg-surface font-semibold hover:bg-line-soft')}>
            {c.category || t('store.all')}
            {c.n > 0 && <span className={cx('ml-1.5 text-xs', category === c.category ? 'opacity-70' : 'text-muted')}>{c.n}</span>}
          </button>
        ))}
      </nav>
    ),
    featured: !browsing && d.featured.category && <Featured design={d} onAll={() => setCategory(d.featured.category!)} />,
    products: (
      <section className="space-y-3" aria-labelledby="products-h">
        <div className="flex items-baseline justify-between">
          <h2 id="products-h" className="font-display text-[22px] font-extrabold tracking-tight sm:text-2xl">{q ? `“${q}”` : category || t('store.newThisWeek')}</h2>
          {items && <span className="text-[13px] font-semibold text-muted">{items.length}{cursor ? '+' : ''} {t('store.productsCount')}</span>}
        </div>
        {items === null ? <ProductGridSkeleton /> : items.length === 0 ? <Empty>{t('store.noProducts')}</Empty> : <ProductGrid items={items} design={d} wholesale={!!me?.is_wholesale_view} />}
        {cursor && <Button variant="secondary" className="w-full" onClick={() => void more()} pending={loadingMore}>{t('common.loadMore')}</Button>}
      </section>
    ),
  };

  return (
    <div className="space-y-5">
      {d.sections.filter((s) => s.on || s.id === 'products' || (s.id === 'categories' && browsing)).map((s) => sections[s.id] ? <div key={s.id}>{sections[s.id]}</div> : null)}

      {count > 0 && (
        <Link to={href('/cart')} viewTransition className="glass-ink rise fixed inset-x-3.5 bottom-4 z-30 mx-auto flex min-h-15 max-w-xl items-center justify-between rounded-[20px] px-5 text-paper shadow-float">
          <span className="flex flex-col">
            <span className="text-[13px] text-paper/75">{t('cart.itemsCount', { n: count })}</span>
            <b className="num font-display text-xl">{quote ? formatNaira(quote.subtotal_kobo) : '…'}</b>
          </span>
          <span className="flex items-center gap-2 font-bold">{t('cart.view')} <ArrowRight className="size-5 text-gold" aria-hidden /></span>
        </Link>
      )}
    </div>
  );
}

function Hero({ store, onShop }: { store: StoreInfo; onShop: (c: string) => void }) {
  const h = store.design.hero;
  const title = h.title || store.business.name;
  const subtitle = h.subtitle || t('store.heroDefault');
  const cta = h.cta_label || t('store.heroCta');
  const shop = () => {
    if (h.cta_category) onShop(h.cta_category);
    else document.getElementById('products-h')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return (
    <section aria-label={title} className={cx('relative isolate overflow-hidden rounded-3xl', h.image_url ? 'text-white' : 'glow-brand bg-brand text-brand-ink')}>
      {h.image_url ? (
        <>
          <img src={h.image_url} alt="" className="absolute inset-0 -z-10 size-full object-cover" fetchPriority="high" />
          <div className="absolute inset-0 -z-10 bg-gradient-to-tr from-black/85 via-black/55 to-black/25" />
        </>
      ) : <div className="dots absolute inset-0 -z-10 opacity-40 [mask-image:linear-gradient(to_left,black,transparent_70%)]" />}
      <div className="flex min-h-[200px] flex-col justify-end gap-3 p-5 sm:min-h-[300px] sm:p-9">
        <h2 className="max-w-xl font-display text-[30px] font-extrabold leading-[1.05] tracking-tight [text-shadow:0_2px_18px_rgb(0_0_0/0.35)] sm:text-5xl">{title}</h2>
        <p className="max-w-lg text-[15px] opacity-90 sm:text-lg">{subtitle}</p>
        <button type="button" onClick={shop} className={cx('press mt-1 inline-flex min-h-12 w-fit items-center gap-2 rounded-xl px-5 font-bold shadow-[0_12px_24px_-12px_rgb(0_0_0/0.6)]',
          h.image_url ? 'bg-white text-[#0E1411]' : 'bg-surface text-ink')}>
          {cta}<ArrowRight className="size-5" aria-hidden />
        </button>
      </div>
    </section>
  );
}

function Featured({ design, onAll }: { design: StoreDesign; onAll: () => void }) {
  const { slug } = useStoreLocation();
  const me = useStore().data?.me;
  const [items, setItems] = useState<Item[] | null>(null);
  const cat = design.featured.category!;
  useEffect(() => {
    const ctrl = new AbortController();
    api<{ items: Item[] }>(`/api/store/${slug}/products?${new URLSearchParams({ category: cat, limit: '12' })}`, { signal: ctrl.signal })
      .then((r) => setItems(r.items)).catch(() => !ctrl.signal.aborted && setItems([]));
    return () => ctrl.abort();
  }, [slug, cat, me?.id]);
  if (items && items.length === 0) return null;
  return (
    <section className="space-y-3" aria-labelledby="featured-h">
      <div className="flex items-baseline justify-between">
        <h2 id="featured-h" className="font-display text-[22px] font-extrabold tracking-tight sm:text-2xl">{design.featured.title || cat}</h2>
        <button type="button" onClick={onAll} className="flex items-center gap-1 text-sm font-bold">{t('store.seeAll')}<ArrowRight className="size-4" aria-hidden /></button>
      </div>
      <ul className="no-scrollbar -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2">
        {(items ?? Array.from({ length: 4 }, () => null)).map((p, i) => (
          <li key={p?.id ?? i} className="w-[46%] shrink-0 snap-start sm:w-[23%]">
            {p ? <ProductCard p={p} i={i} design={design} wholesale={!!me?.is_wholesale_view} /> : <div className="skeleton aspect-[4/5] rounded-card" />}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ProductGrid({ items, design, wholesale }: { items: Item[]; design: StoreDesign; wholesale: boolean }) {
  return (
    <ul className={cx('stagger grid', design.density === 'compact' ? 'grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6' : 'grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4')}>
      {items.map((p, i) => <li key={p.id}><ProductCard p={p} i={i} design={design} wholesale={wholesale} /></li>)}
    </ul>
  );
}

function ProductCard({ p, i, design, wholesale }: { p: Item; i: number; design: StoreDesign; wholesale: boolean }) {
  const { href } = useStoreLocation();
  const compact = design.density === 'compact';
  const img = (
    <>
      {p.image && <img src={p.image} alt="" width={400} height={390} loading={i < 4 ? 'eager' : 'lazy'} decoding="async" fetchPriority={i < 2 ? 'high' : undefined}
        className={cx('size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]', !p.in_stock && 'opacity-50 grayscale')} />}
      {!p.in_stock
        ? <span className="absolute left-2.5 top-2.5 rounded-full bg-ink px-2.5 py-0.5 text-[11px] font-extrabold text-paper">{t('store.soldOutCaps')}</span>
        : p.few_left ? <span className="absolute left-2.5 top-2.5 rounded-full bg-gold px-2.5 py-0.5 text-[11px] font-extrabold text-[#0E1411]">{t('store.fewLeft', { n: p.few_left })}</span> : null}
    </>
  );
  const price = p.price_kobo != null && (
    <p className={cx('num font-display font-extrabold', compact ? 'text-[15px]' : 'text-[19px]', wholesale && design.card !== 'overlay' && 'text-indigo')}>
      {formatNaira(p.price_kobo)}
      {p.retail_price_kobo != null && p.retail_price_kobo > p.price_kobo && <s className="ml-1.5 font-sans text-xs font-medium opacity-70">{formatNaira(p.retail_price_kobo)}</s>}
    </p>
  );
  const swatches = p.swatches.length > 1 && !compact && (
    <div className="mt-auto flex items-center gap-1.5 pt-1" aria-label={p.swatches.map((s) => s.colour).join(', ')}>
      {p.swatches.slice(0, 4).map((s) => <span key={s.colour} title={s.colour} className={cx('size-3.5 rounded-full ring-1 ring-black/10', !s.in_stock && 'opacity-30')} style={{ background: s.hex ?? '#d6d3d1' }} />)}
      {p.swatches.length > 4 && <span className="text-xs opacity-70">+{p.swatches.length - 4}</span>}
    </div>
  );
  const name = <h3 className={cx('line-clamp-2 font-semibold leading-snug', compact ? 'text-[13px]' : 'text-sm', !p.in_stock && 'opacity-60')}>{p.name}</h3>;

  if (design.card === 'overlay') {
    return (
      <Link to={href(`/p/${p.id}`)} viewTransition className="store-card group lift relative flex aspect-[4/5] flex-col justify-end overflow-hidden rounded-card bg-line-soft text-white shadow-card"
        style={p.image ? undefined : fabricStyle(p.id, p.swatches[0]?.hex)}>
        <div className="absolute inset-0">{img}</div>
        <div className="relative space-y-0.5 bg-gradient-to-t from-black/80 via-black/45 to-transparent p-3 pt-10">{name}{price}</div>
      </Link>
    );
  }
  if (design.card === 'minimal') {
    return (
      <Link to={href(`/p/${p.id}`)} viewTransition className="group flex h-full flex-col gap-2">
        <div className="store-card relative aspect-[4/4.6] overflow-hidden rounded-card bg-line-soft" style={p.image ? undefined : fabricStyle(p.id, p.swatches[0]?.hex)}>{img}</div>
        <div className="flex flex-1 flex-col gap-0.5 px-0.5">{name}{price}{swatches}</div>
      </Link>
    );
  }
  return (
    <Link to={href(`/p/${p.id}`)} viewTransition className="store-card group lift flex h-full flex-col overflow-hidden rounded-card border border-line/70 bg-surface shadow-card">
      <div className="relative aspect-[4/3.9] overflow-hidden bg-line-soft" style={p.image ? undefined : fabricStyle(p.id, p.swatches[0]?.hex)}>{img}</div>
      <div className={cx('flex flex-1 flex-col gap-1', compact ? 'px-2 pb-2 pt-1.5' : 'px-3 pb-3 pt-2.5')}>{name}{price}{swatches}</div>
    </Link>
  );
}
