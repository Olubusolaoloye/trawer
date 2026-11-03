/**
 * Choosing what to buy — colour, size, pack size, quantity — and the price that follows.
 * Shared by the product page and the quick-add sheet on product cards.
 */
import { useMemo, useState } from 'react';
import { cart } from '../lib/cart';
import { cx, formatNaira } from '../lib/format';
import { t } from '../i18n';
import type { StoreMe } from './StoreLayout';

export interface Variant {
  id: string; colour: string | null; colour_hex: string | null; size: string | null; images: string[];
  price_kobo: number; retail_price_kobo: number; price_source: string; available: number;
  volume_breaks: { min_qty: number; price_kobo: number }[];
}
export interface Unit { unit_id: string; name: string; plural: string; factor: number; is_base: boolean }
export interface ProductData { product: { id: string; name: string; description: string; category: string | null; images: string[] }; units: Unit[]; variants: Variant[] }

export function useBuy(slug: string, data: ProductData | undefined, me: StoreMe | null | undefined) {
  const [variantId, setVariantId] = useState<string | null>(null);
  const [unitId, setUnitId] = useState<string | null>(null);
  const [qty, setQtyRaw] = useState(1);
  const [added, setAdded] = useState(false);
  const colours = useMemo(() => [...new Set(data?.variants.map((v) => v.colour).filter(Boolean) as string[])], [data]);
  const sizes = useMemo(() => [...new Set(data?.variants.map((v) => v.size).filter(Boolean) as string[])], [data]);
  if (!data || !data.variants.length) return null;

  const firstInStock = data.variants.find((v) => v.available > 0) ?? data.variants[0]!;
  const variant = data.variants.find((v) => v.id === variantId) ?? firstInStock;
  const units = [...data.units].sort((a, b) => a.factor - b.factor);
  // Wholesale buyers start on the biggest pack; everyone else on single pieces.
  const defaultUnit = me?.is_wholesale_view ? units[units.length - 1] : units.find((u) => u.is_base);
  const unit = data.units.find((u) => u.unit_id === unitId) ?? defaultUnit ?? units[0]!;
  const baseQty = qty * unit.factor;
  const maxQty = Math.max(Math.floor(variant.available / unit.factor), 0);
  const soldOut = variant.available === 0;
  const wholesale = ['tier', 'tier_volume', 'override'].includes(variant.price_source);
  // Retail/volume buyers get the best visible break for this quantity (the server re-prices at checkout).
  const breakPrice = [...variant.volume_breaks].filter((b) => b.min_qty <= baseQty).sort((a, b) => b.min_qty - a.min_qty)[0];
  const each = wholesale ? variant.price_kobo : Math.min(variant.price_kobo, breakPrice?.price_kobo ?? Infinity);
  const pick = (colour: string | null, size: string | null) =>
    data.variants.find((v) => (colour == null || v.colour === colour) && (size == null || v.size === size));
  const touch = () => setAdded(false);

  return {
    data, variant, unit, units, qty, baseQty, maxQty, soldOut, wholesale, each, colours, sizes, pick, added,
    image: variant.images[0] ?? data.product.images[0] ?? null,
    total: each * baseQty,
    setVariant: (id: string) => { setVariantId(id); setQtyRaw(1); touch(); },
    setUnit: (id: string) => { setUnitId(id); setQtyRaw(1); touch(); },
    setQty: (n: number) => { setQtyRaw(Math.max(1, n)); touch(); },
    add() {
      cart.add(slug, {
        variant_id: variant.id, unit_id: unit.is_base ? undefined : unit.unit_id, qty, product_id: data.product.id,
        name: data.product.name, label: [variant.colour, variant.size].filter(Boolean).join(' / ') || null, image: variant.images[0] ?? null, unit_name: unit.name,
      });
      setAdded(true);
    },
  };
}
export type Buy = NonNullable<ReturnType<typeof useBuy>>;

/** Colour, size and pack-size pickers. */
export function BuyOptions({ buy }: { buy: Buy }) {
  const { variant, unit, units, colours, sizes, pick } = buy;
  return (
    <div className="space-y-4">
      {colours.length > 0 && (
        <fieldset>
          <legend className="mb-2.5 text-sm font-bold">{t('store.colour')} <span className="font-semibold text-muted">· {variant.colour}</span></legend>
          <div className="flex flex-wrap gap-3">
            {colours.map((c) => {
              const v = pick(c, variant.size) ?? pick(c, null)!;
              const out = v.available === 0;
              const on = variant.colour === c;
              return (
                <button key={c} type="button" onClick={() => buy.setVariant(v.id)} aria-pressed={on} aria-label={`${c}${out ? `, ${t('store.outOfStock')}` : ''}`}
                  className={cx('press relative size-11 rounded-full', on ? 'border-[3px] border-surface ring-[3px] ring-ink' : 'border-2 border-line', out && 'opacity-35')}
                  style={{ background: v.colour_hex ?? '#d6d3d1' }}>
                  {out && <span className="absolute inset-0 m-auto h-0.5 w-9 rotate-45 bg-ink" aria-hidden />}
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
                <button key={s} type="button" disabled={!v} onClick={() => v && buy.setVariant(v.id)} aria-pressed={variant.size === s}
                  className={cx('press min-h-11 min-w-11 rounded-full border px-4 text-sm font-bold', variant.size === s ? 'border-ink bg-ink text-paper' : 'border-line bg-surface',
                    (!v || v.available === 0) && 'text-muted line-through')}>{s}</button>
              );
            })}
          </div>
        </fieldset>
      )}
      {units.length > 1 && (
        <fieldset>
          <legend className="mb-2 text-sm font-bold">{t('store.unit')}</legend>
          <div className="grid grid-flow-col gap-2" style={{ gridAutoColumns: '1fr' }}>
            {units.map((u) => (
              <button key={u.unit_id} type="button" onClick={() => buy.setUnit(u.unit_id)} aria-pressed={unit.unit_id === u.unit_id}
                className={cx('press flex min-h-14 flex-col items-center justify-center rounded-2xl border px-2 text-sm',
                  unit.unit_id === u.unit_id ? 'border-ink bg-ink text-paper' : 'border-line bg-surface')}>
                <b className="capitalize">{u.name}</b>
                <span className={cx('text-xs', unit.unit_id === u.unit_id ? 'text-paper/75' : 'text-muted')}>{u.factor > 1 ? t('store.packOf', { n: u.factor }) : t('store.single')}</span>
              </button>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}

/** "Only 4 left" / "In stock" line. */
export function StockLine({ buy }: { buy: Buy }) {
  const { variant, soldOut } = buy;
  return (
    <span className={cx('text-sm font-semibold', soldOut ? 'text-red-ink' : variant.available < 20 ? 'text-gold-ink' : 'text-green-ink')}>
      {soldOut ? t('store.outOfStock') : variant.available < 20 ? t('store.onlyPieces', { n: variant.available }) : t('store.inStockPieces', { n: variant.available })}
    </span>
  );
}

/** Price for the chosen pack, with the per-piece price and retail comparison when useful. */
export function BuyPrice({ buy, size = 'lg' }: { buy: Buy; size?: 'lg' | 'md' }) {
  const { each, unit, wholesale, variant } = buy;
  return (
    <div className="space-y-1">
      {wholesale && <span className="inline-flex rounded-full bg-indigo px-2.5 py-0.5 text-xs font-bold text-white">{t('store.yourWholesalePrice')}</span>}
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className={cx('num font-display font-extrabold', size === 'lg' ? 'text-[32px]' : 'text-2xl', wholesale ? 'text-indigo' : 'text-accent-text')}>{formatNaira(each * unit.factor)}</span>
        <span className="text-sm font-medium text-body">/ {unit.factor > 1 ? `${unit.name} · ${unit.factor}` : unit.name}</span>
      </p>
      {(wholesale || unit.factor > 1) && (
        <p className="text-sm text-body">
          {formatNaira(each)} {t('store.each')}
          {variant.retail_price_kobo > each && <> · {t('store.retail')} <s>{formatNaira(variant.retail_price_kobo)}</s></>}
        </p>
      )}
    </div>
  );
}
