import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Check, ChevronLeft, Share2 } from 'lucide-react';
import { useApi } from '../lib/use-api';
import { cart } from '../lib/cart';
import { formatNaira, cx } from '../lib/format';
import { useStoreLocation } from '../lib/store-context';
import { Empty, Spinner, fabricStyle } from '../components/ui';
import { t } from '../i18n';
import { useStore } from './StoreLayout';

interface Variant {
  id: string; colour: string | null; colour_hex: string | null; size: string | null; images: string[];
  price_kobo: number; retail_price_kobo: number; price_source: string; available: number;
  volume_breaks: { min_qty: number; price_kobo: number }[];
}
interface Unit { unit_id: string; name: string; plural: string; factor: number; is_base: boolean }
interface ProductData { product: { id: string; name: string; description: string; category: string | null; images: string[] }; units: Unit[]; variants: Variant[] }

export function ProductPage() {
  const { id } = useParams();
  const { slug, href } = useStoreLocation();
  const navigate = useNavigate();
  const me = useStore().data!.me;
  const { data, error } = useApi<ProductData>(`/api/store/${slug}/products/${id}`);
  const [variantId, setVariantId] = useState<string | null>(null);
  const [unitId, setUnitId] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);

  const colours = useMemo(() => [...new Set(data?.variants.map((v) => v.colour).filter(Boolean) as string[])], [data]);
  const sizes = useMemo(() => [...new Set(data?.variants.map((v) => v.size).filter(Boolean) as string[])], [data]);

  if (error) return <Empty>{t('store.noProducts')}</Empty>;
  if (!data) return <Spinner />;

  const firstInStock = data.variants.find((v) => v.available > 0) ?? data.variants[0]!;
  const variant = data.variants.find((v) => v.id === variantId) ?? firstInStock;
  const byFactor = [...data.units].sort((a, b) => a.factor - b.factor);
  // Wholesale buyers start on the biggest pack; everyone else on single pieces.
  const defaultUnit = me?.is_wholesale_view ? byFactor[byFactor.length - 1] : byFactor.find((u) => u.is_base);
  const unit = data.units.find((u) => u.unit_id === unitId) ?? defaultUnit ?? byFactor[0]!;
  const baseQty = qty * unit.factor;
  const maxQty = Math.max(Math.floor(variant.available / unit.factor), 0);
  const image = variant.images[0] ?? data.product.images[0];
  const soldOut = variant.available === 0;
  const pick = (colour: string | null, size: string | null) =>
    data.variants.find((v) => (colour == null || v.colour === colour) && (size == null || v.size === size));
  const wholesale = variant.price_source === 'tier' || variant.price_source === 'tier_volume' || variant.price_source === 'override';
  // Retail/volume buyers get the best visible break for this quantity (the server re-prices at checkout).
  const breakPrice = [...variant.volume_breaks].filter((b) => b.min_qty <= baseQty).sort((a, b) => b.min_qty - a.min_qty)[0];
  const each = wholesale ? variant.price_kobo : Math.min(variant.price_kobo, breakPrice?.price_kobo ?? Infinity);
  const stockTone = soldOut ? 'text-red-ink' : variant.available < 20 ? 'text-gold-ink' : 'text-green-ink';

  function add() {
    cart.add(slug, {
      variant_id: variant.id, unit_id: unit.is_base ? undefined : unit.unit_id, qty, product_id: data!.product.id,
      name: data!.product.name, label: [variant.colour, variant.size].filter(Boolean).join(' / ') || null, image: variant.images[0] ?? null, unit_name: unit.name,
    });
    setAdded(true);
  }

  return (
    <article className="mx-auto flex min-h-dvh max-w-xl flex-col bg-paper">
      <div className="relative h-[330px] shrink-0 sm:h-[420px]" style={image ? undefined : fabricStyle(variant.id, variant.colour_hex)}>
        {image && <img key={image} src={image} alt={`${data.product.name}${variant.colour ? `, ${variant.colour}` : ''}`} width={960} height={960} fetchPriority="high"
          className={cx('size-full object-cover', soldOut && 'opacity-60 grayscale')} />}
        <button type="button" onClick={() => (history.length > 1 ? navigate(-1) : navigate(href('/')))} aria-label={t('common.back')}
          className="absolute left-3.5 top-3.5 flex size-[46px] items-center justify-center rounded-full bg-surface shadow-md"><ChevronLeft className="size-6" aria-hidden /></button>
        <button type="button" aria-label={t('store.share')} onClick={() => void navigator.share?.({ title: data.product.name, url: location.href }).catch(() => undefined)}
          className="absolute right-3.5 top-3.5 flex size-[46px] items-center justify-center rounded-full bg-surface shadow-md"><Share2 className="size-5" aria-hidden /></button>
        {variant.colour && <span className="absolute bottom-8 left-3.5 rounded-full bg-ink/80 px-3 py-1.5 text-[13px] font-bold text-paper">{variant.colour}{soldOut ? ` · ${t('store.outOfStock').toLowerCase()}` : ''}</span>}
      </div>

      <div className="relative -mt-[18px] flex flex-1 flex-col gap-4 rounded-t-3xl bg-paper px-[18px] pb-32 pt-5">
        <div className="flex flex-col gap-1">
          {data.product.category && <span className="text-xs font-extrabold uppercase tracking-wider text-brand">{data.product.category}</span>}
          <h1 className="font-display text-[25px] font-extrabold leading-tight">{data.product.name}</h1>
        </div>

        <div className="flex flex-col gap-1.5">
          {wholesale && <span className="self-start rounded-full bg-indigo px-2.5 py-0.5 text-xs font-bold text-white">{t('store.yourWholesalePrice')}</span>}
          <p className="flex items-baseline gap-2">
            <span className={cx('num font-display text-[34px] font-extrabold', wholesale && 'text-indigo')}>{formatNaira(each * unit.factor)}</span>
            <span className="text-[15px] font-medium text-body">/ {unit.factor > 1 ? `${unit.name} · ${unit.factor}` : unit.name}</span>
          </p>
          {(wholesale || unit.factor > 1) && (
            <p className="text-sm text-body">
              {formatNaira(each)} {t('store.each')}
              {variant.retail_price_kobo > each && <> · {t('store.retail')} <s>{formatNaira(variant.retail_price_kobo)}</s></>}
            </p>
          )}
        </div>

        {colours.length > 0 && (
          <fieldset>
            <legend className="mb-2.5 text-sm font-bold">{t('store.colour')}</legend>
            <div className="flex flex-wrap gap-3">
              {colours.map((c) => {
                const v = pick(c, variant.size) ?? pick(c, null)!;
                const out = v.available === 0;
                const on = variant.colour === c;
                return (
                  <button key={c} type="button" onClick={() => { setVariantId(v.id); setQty(1); setAdded(false); }}
                    aria-pressed={on} aria-label={`${c}${out ? `, ${t('store.outOfStock')}` : ''}`}
                    className={cx('relative size-12 rounded-full', on ? 'border-[3px] border-white ring-[3px] ring-ink' : 'border-2 border-line', out && 'opacity-35')}
                    style={{ background: v.colour_hex ?? '#d6d3d1' }}>
                    {out && <span className="absolute inset-0 m-auto h-0.5 w-10 rotate-45 bg-ink" aria-hidden />}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}

        {sizes.length > 0 && (
          <fieldset>
            <legend className="mb-2 text-sm font-bold">{t('store.size')}</legend>
            <div className="flex flex-wrap gap-2">
              {sizes.map((s) => {
                const v = pick(variant.colour, s);
                return (
                  <button key={s} type="button" disabled={!v} onClick={() => v && (setVariantId(v.id), setAdded(false))} aria-pressed={variant.size === s}
                    className={cx('min-h-12 min-w-12 rounded-xl border-2 px-3 font-bold', variant.size === s ? 'border-ink bg-ink text-paper' : 'border-line bg-surface',
                      (!v || v.available === 0) && 'text-muted line-through')}>{s}</button>
                );
              })}
            </div>
          </fieldset>
        )}

        {byFactor.length > 1 && (
          <div className="flex gap-2" role="group" aria-label={t('store.unit')}>
            {byFactor.map((u) => (
              <button key={u.unit_id} type="button" onClick={() => { setUnitId(u.unit_id); setQty(1); setAdded(false); }} aria-pressed={unit.unit_id === u.unit_id}
                className={cx('min-h-12 flex-1 rounded-xl border-2 text-sm capitalize', unit.unit_id === u.unit_id ? 'border-ink bg-ink font-bold text-paper' : 'border-line bg-surface font-semibold')}>
                {u.name}{u.factor > 1 ? ` · ${u.factor}` : ''}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3">
          <div className="flex items-center overflow-hidden rounded-xl border-2 border-ink bg-surface" role="group" aria-label={t('store.quantity')}>
            <button type="button" className="h-13 w-13 text-2xl font-bold" onClick={() => { setQty((q) => Math.max(1, q - 1)); setAdded(false); }} aria-label={t('store.less')}>−</button>
            <span className="num w-10 text-center font-display text-2xl font-extrabold" aria-live="polite">{qty}</span>
            <button type="button" className="h-13 w-13 text-2xl font-bold disabled:text-muted" disabled={qty >= maxQty} onClick={() => { setQty((q) => q + 1); setAdded(false); }} aria-label={t('store.more')}>+</button>
          </div>
          <span className={cx('text-sm font-semibold', stockTone)}>
            {soldOut ? t('store.outOfStock') : variant.available < 20 ? t('store.onlyPieces', { n: variant.available }) : t('store.inStockPieces', { n: variant.available })}
          </span>
        </div>

        {!wholesale && me?.wholesale_status !== 'pending' && (
          <Link to={href('/account?wholesale=1')} className="flex items-center gap-2.5 rounded-xl border-[1.5px] border-dashed border-indigo px-3.5 py-3 text-sm text-indigo">
            <span className="rounded-full bg-indigo px-2 py-0.5 text-[11px] font-extrabold text-white">{t('store.wholesaleCaps')}</span>
            <span>{t('store.wholesaleNudge')}</span>
          </Link>
        )}

        {variant.volume_breaks.length > 0 && !wholesale && (
          <ul className="space-y-1 rounded-xl bg-gold-50 p-3 text-sm text-gold-ink">
            {variant.volume_breaks.map((b) => <li key={b.min_qty}>{t('store.volumeBreak', { qty: b.min_qty, unit: t('store.pieces'), price: formatNaira(b.price_kobo) })}</li>)}
          </ul>
        )}

        {data.product.description && <p className="whitespace-pre-line leading-relaxed text-body">{data.product.description}</p>}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface">
        <div className="mx-auto flex max-w-xl items-center gap-3 px-[18px] pb-[18px] pt-3">
          <div className="flex flex-col">
            <span className="text-xs font-semibold text-muted">{soldOut ? t('store.outOfStock') : `${baseQty} ${t('store.pieces')} · ${formatNaira(each)} ${t('store.each')}`}</span>
            <b className="num font-display text-[22px]">{soldOut ? '—' : formatNaira(each * baseQty)}</b>
          </div>
          {soldOut ? (
            <button type="button" disabled className="min-h-14 flex-1 rounded-2xl bg-line font-bold text-body">{t('store.soldOutNotify')}</button>
          ) : added ? (
            <Link to={href('/cart')} className="flex min-h-14 flex-1 items-center justify-center gap-2 rounded-2xl bg-green text-[17px] font-bold text-white">
              <Check className="size-5" aria-hidden /> {t('store.addedViewCart')}
            </Link>
          ) : (
            <button type="button" onClick={add} disabled={baseQty > variant.available}
              className="min-h-14 flex-1 rounded-2xl bg-brand text-[17px] font-bold text-brand-ink disabled:opacity-60">{t('store.addToCart')}</button>
          )}
        </div>
      </div>
    </article>
  );
}
