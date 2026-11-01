import { useMemo, useState } from 'react';
import { useParams } from 'react-router';
import { Check, Minus, Plus } from 'lucide-react';
import { useApi } from '../lib/use-api';
import { cart } from '../lib/cart';
import { formatNaira, cx } from '../lib/format';
import { useStoreLocation } from '../lib/store-context';
import { Badge, Button, Empty, Spinner } from '../components/ui';
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
  const { slug } = useStoreLocation();
  const store = useStore().data!;
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
  // Wholesale buyers default to the largest pack (carton); everyone else to pieces.
  const defaultUnit = store.me?.is_wholesale_view ? [...data.units].sort((a, b) => b.factor - a.factor)[0] : data.units.find((u) => u.is_base);
  const unit = data.units.find((u) => u.unit_id === unitId) ?? defaultUnit ?? data.units[0]!;
  const baseQty = qty * unit.factor;
  const maxQty = Math.floor(variant.available / unit.factor);
  const image = variant.images[0] ?? data.product.images[0];
  const pick = (colour: string | null, size: string | null) =>
    data.variants.find((v) => (colour == null || v.colour === colour) && (size == null || v.size === size));

  // Price shown = resolver's per-piece price for qty 1, or the best visible volume break for the chosen qty.
  const breakPrice = [...variant.volume_breaks].filter((b) => b.min_qty <= baseQty).sort((a, b) => b.min_qty - a.min_qty)[0];
  const unitPrice = variant.price_source === 'retail' || variant.price_source === 'volume'
    ? Math.min(variant.price_kobo, breakPrice?.price_kobo ?? Infinity)
    : variant.price_kobo;

  function add() {
    cart.add(slug, {
      variant_id: variant.id, unit_id: unit.is_base ? undefined : unit.unit_id, qty, product_id: data!.product.id,
      name: data!.product.name, label: [variant.colour, variant.size].filter(Boolean).join(' / ') || null, image: variant.images[0] ?? null,
      unit_name: unit.name,
    });
    setAdded(true);
    setTimeout(() => setAdded(false), 1800);
  }

  return (
    <article className="grid gap-6 md:grid-cols-2">
      <div className="overflow-hidden rounded-2xl bg-stone-100">
        {image && <img key={image} src={image} alt={`${data.product.name} ${variant.colour ?? ''}`} width={960} height={960} fetchPriority="high"
          className={cx('aspect-square size-full object-cover', variant.available === 0 && 'opacity-60 grayscale')} />}
      </div>
      <div className="space-y-5">
        <div className="space-y-2">
          {data.product.category && <p className="text-sm font-semibold uppercase tracking-wide text-stone-500">{data.product.category}</p>}
          <h1 className="text-2xl font-bold leading-tight">{data.product.name}</h1>
          <p className="text-3xl font-extrabold">
            {formatNaira(unitPrice * unit.factor)}
            <span className="ml-1 text-base font-medium text-stone-600">/ {unit.name}</span>
          </p>
          {unit.factor > 1 && <p className="text-sm text-stone-600">{unit.factor} pieces · {formatNaira(unitPrice)} each</p>}
          {variant.price_source !== 'retail' && variant.retail_price_kobo > unitPrice && (
            <Badge tone="good">{t('store.retailPrice', { price: formatNaira(variant.retail_price_kobo) })}</Badge>
          )}
        </div>

        {colours.length > 0 && (
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">{t('store.colour')}: <span className="font-normal">{variant.colour}</span></legend>
            <div className="flex flex-wrap gap-3">
              {colours.map((c) => {
                const v = pick(c, variant.size) ?? pick(c, null)!;
                const soldOut = v.available === 0;
                return (
                  <button key={c} type="button" onClick={() => { setVariantId(v.id); setQty(1); }}
                    aria-pressed={variant.colour === c} aria-label={`${c}${soldOut ? ` — ${t('store.outOfStock')}` : ''}`}
                    className={cx('relative size-12 rounded-full border-2 ring-offset-2', variant.colour === c ? 'border-stone-900 ring-2 ring-stone-900' : 'border-stone-300',
                      soldOut && 'opacity-35')}
                    style={{ background: v.colour_hex ?? '#d6d3d1' }}>
                    {soldOut && <span className="absolute inset-0 m-auto h-0.5 w-10 rotate-45 bg-stone-900" aria-hidden />}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}

        {sizes.length > 0 && (
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">{t('store.size')}</legend>
            <div className="flex flex-wrap gap-2">
              {sizes.map((s) => {
                const v = pick(variant.colour, s);
                const disabled = !v || v.available === 0;
                return (
                  <button key={s} type="button" disabled={!v} onClick={() => v && setVariantId(v.id)} aria-pressed={variant.size === s}
                    className={cx('min-h-12 min-w-12 rounded-xl border-2 px-3 font-semibold', variant.size === s ? 'border-stone-900 bg-stone-900 text-white' : 'border-stone-300 bg-white',
                      disabled && 'text-stone-400 line-through')}>
                    {s}
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}

        {data.units.length > 1 && (
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">{t('store.unit')}</legend>
            <div className="flex flex-wrap gap-2">
              {data.units.map((u) => (
                <button key={u.unit_id} type="button" onClick={() => { setUnitId(u.unit_id); setQty(1); }} aria-pressed={unit.unit_id === u.unit_id}
                  className={cx('min-h-12 rounded-xl border-2 px-4 font-semibold', unit.unit_id === u.unit_id ? 'border-brand bg-brand text-brand-ink' : 'border-stone-300 bg-white')}>
                  {u.name}{u.factor > 1 ? ` (${u.factor})` : ''}
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {variant.volume_breaks.length > 0 && variant.price_source !== 'tier' && variant.price_source !== 'override' && (
          <ul className="space-y-1 rounded-xl bg-amber-50 p-3 text-sm text-amber-950">
            {variant.volume_breaks.map((b) => (
              <li key={b.min_qty}>{t('store.volumeBreak', { qty: b.min_qty, unit: 'pieces', price: formatNaira(b.price_kobo) })}</li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-xl border-2 border-stone-300 bg-white" role="group" aria-label={t('store.quantity')}>
            <button type="button" className="flex size-12 items-center justify-center" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="−"><Minus className="size-5" /></button>
            <input aria-label={t('store.quantity')} inputMode="numeric" className="w-14 text-center text-lg font-bold" value={qty}
              onChange={(e) => setQty(Math.max(1, Math.min(maxQty || 1, Number(e.target.value.replace(/\D/g, '')) || 1)))} />
            <button type="button" className="flex size-12 items-center justify-center" onClick={() => setQty((q) => Math.min(Math.max(maxQty, 1), q + 1))} aria-label="+"><Plus className="size-5" /></button>
          </div>
          <p className="text-sm text-stone-600">{variant.available > 0 ? t('store.available', { n: variant.available }) : t('store.outOfStock')}</p>
        </div>

        <Button size="lg" className="w-full" disabled={variant.available === 0 || baseQty > variant.available} onClick={add}>
          {added ? <><Check className="size-5" aria-hidden /> {t('store.added')}</> : variant.available === 0 ? t('store.outOfStock') : `${t('store.addToCart')} · ${formatNaira(unitPrice * baseQty)}`}
        </Button>

        {data.product.description && <p className="whitespace-pre-line leading-relaxed text-stone-800">{data.product.description}</p>}
      </div>
    </article>
  );
}
