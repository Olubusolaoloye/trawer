import { Link, useParams } from 'react-router';
import { Check, Share2 } from 'lucide-react';
import { useApi } from '../lib/use-api';
import { formatNaira, cx } from '../lib/format';
import { useStoreLocation } from '../lib/store-context';
import { Empty, Skeleton, fabricStyle } from '../components/ui';
import { t } from '../i18n';
import { useStore } from './StoreLayout';
import { BackButton, Stepper } from './kit';
import { BuyOptions, BuyPrice, StockLine, useBuy, type ProductData } from './buy';
import { ProductCard, type Item } from './Catalogue';

export function ProductPage() {
  const { id } = useParams();
  const { slug, href } = useStoreLocation();
  const store = useStore().data!;
  const { data, error } = useApi<ProductData>(`/api/store/${slug}/products/${id}`);
  const buy = useBuy(slug, data, store.me);

  if (error) return <Empty>{t('store.noProducts')}</Empty>;
  if (!data || !buy) return <ProductSkeleton />;
  const { variant, image, soldOut } = buy;

  return (
    <article className="mx-auto flex min-h-dvh w-full max-w-xl flex-col bg-paper">
      {/* Photo stage */}
      <div className="relative overflow-hidden rounded-b-[36px] bg-line-soft shadow-[0_18px_40px_-30px_rgb(0_0_0/0.6)]">
        <div className="aspect-[1/0.92] w-full sm:aspect-[1/0.8]" style={image ? undefined : fabricStyle(variant.id, variant.colour_hex)}>
          {image && <img key={image} src={image} alt={`${data.product.name}${variant.colour ? `, ${variant.colour}` : ''}`} width={960} height={880} fetchPriority="high"
            className={cx('size-full object-cover', soldOut && 'opacity-60 grayscale')} />}
        </div>
        <div className="absolute inset-x-0 top-0 flex justify-between p-3.5">
          <BackButton className="bg-surface/95 backdrop-blur" />
          <button type="button" aria-label={t('store.share')} onClick={() => void navigator.share?.({ title: data.product.name, url: location.href }).catch(() => undefined)}
            className="press flex size-11 items-center justify-center rounded-full border border-line bg-surface/95 shadow-card backdrop-blur"><Share2 className="size-5" aria-hidden /></button>
        </div>
        {data.variants.length > 1 && (
          <div className="absolute inset-x-0 bottom-4 flex justify-center gap-1.5" aria-hidden>
            {data.variants.slice(0, 8).map((v) => <span key={v.id} className={cx('h-1.5 rounded-full transition-all', v.id === variant.id ? 'w-6 bg-ink' : 'w-1.5 bg-ink/30')} />)}
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-5 px-[18px] pb-36 pt-5">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            {data.product.category && <span className="text-xs font-extrabold uppercase tracking-wider text-brand-text">{data.product.category}</span>}
            <h1 className="font-display text-[26px] font-extrabold leading-tight tracking-tight">{data.product.name}</h1>
            <StockLine buy={buy} />
          </div>
          {!soldOut && <Stepper value={buy.qty} onChange={buy.setQty} max={buy.maxQty} label={t('store.quantity')} />}
        </div>

        <BuyPrice buy={buy} />
        <BuyOptions buy={buy} />

        {!buy.wholesale && store.me?.wholesale_status !== 'pending' && (
          <Link to={href('/account?wholesale=1')} className="flex items-center gap-3 rounded-2xl bg-indigo-50 p-3.5 text-sm text-indigo">
            <span className="rounded-full bg-indigo px-2 py-0.5 text-[11px] font-extrabold text-white">{t('store.wholesaleCaps')}</span>
            <span>{t('store.wholesaleNudge')}</span>
          </Link>
        )}

        {variant.volume_breaks.length > 0 && !buy.wholesale && (
          <section className="rounded-2xl bg-accent-soft p-3.5">
            <h2 className="mb-1 text-sm font-bold">{t('store.buyMoreSave')}</h2>
            <ul className="space-y-0.5 text-sm text-body">
              {variant.volume_breaks.map((b) => <li key={b.min_qty}>{t('store.volumeBreak', { qty: b.min_qty, unit: t('store.pieces'), price: formatNaira(b.price_kobo) })}</li>)}
            </ul>
          </section>
        )}

        {data.product.description && (
          <section className="space-y-1.5">
            <h2 className="font-display text-lg font-extrabold">{t('store.details')}</h2>
            <p className="whitespace-pre-line leading-relaxed text-body">{data.product.description}</p>
          </section>
        )}

        {data.product.category && <Similar category={data.product.category} exclude={data.product.id} />}
      </div>

      {/* Dark bottom bar: total + add */}
      <div className="fixed inset-x-0 bottom-0 z-30">
        <div className="mx-auto flex max-w-xl items-center gap-3 rounded-t-[28px] bg-ink px-5 pb-[max(18px,env(safe-area-inset-bottom))] pt-4 text-paper shadow-float">
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-xs font-semibold text-paper/70">{soldOut ? t('store.outOfStock') : `${buy.baseQty} ${t('store.pieces')} · ${formatNaira(buy.each)} ${t('store.each')}`}</span>
            <b className="num font-display text-2xl">{soldOut ? '—' : formatNaira(buy.total)}</b>
          </div>
          {soldOut ? (
            <button type="button" disabled className="ml-auto min-h-13 rounded-full bg-paper/15 px-6 font-bold text-paper/70">{t('store.soldOutNotify')}</button>
          ) : buy.added ? (
            <Link to={href('/cart')} className="press ml-auto inline-flex min-h-13 items-center gap-2 rounded-full bg-accent px-6 font-bold text-accent-ink">
              <Check className="size-5" aria-hidden />{t('store.addedViewCart')}
            </Link>
          ) : (
            <button type="button" onClick={buy.add} disabled={buy.baseQty > variant.available}
              className="press ml-auto min-h-13 rounded-full bg-paper px-7 text-[17px] font-bold text-ink disabled:opacity-60">{t('store.addToCart')}</button>
          )}
        </div>
      </div>
    </article>
  );
}

/** Other products from the same category. */
function Similar({ category, exclude }: { category: string; exclude: string }) {
  const { slug } = useStoreLocation();
  const store = useStore().data!;
  const { data } = useApi<{ items: Item[] }>(`/api/store/${slug}/products?${new URLSearchParams({ category, limit: '9' })}`, { staleMs: 60_000 });
  const items = (data?.items ?? []).filter((p) => p.id !== exclude).slice(0, 8);
  if (data && !items.length) return null;
  return (
    <section aria-labelledby="similar-h" className="space-y-3">
      <h2 id="similar-h" className="font-display text-lg font-extrabold">{t('store.similar')}</h2>
      <ul className="no-scrollbar -mx-[18px] flex snap-x gap-3 overflow-x-auto px-[18px] pb-2">
        {(data ? items : Array.from({ length: 3 }, () => null)).map((p, i) => (
          <li key={p?.id ?? i} className="w-[44%] shrink-0 snap-start sm:w-[30%]">
            {p ? <ProductCard p={p} i={9} design={store.design} wholesale={!!store.me?.is_wholesale_view} /> : <div className="skeleton aspect-[3/4] rounded-card" />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function ProductSkeleton() {
  return (
    <div className="mx-auto w-full max-w-xl" role="status" aria-label={t('common.loading')}>
      <div className="skeleton aspect-[1/0.92] rounded-b-[36px]" />
      <div className="space-y-3 p-[18px]"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-3/4" /><Skeleton className="h-10 w-1/2" /><Skeleton className="h-24 w-full" /></div>
    </div>
  );
}
