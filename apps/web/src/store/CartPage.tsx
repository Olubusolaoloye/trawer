import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight, ShoppingBag, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { cart, useCart } from '../lib/cart';
import { formatNaira, cx } from '../lib/format';
import { useStoreLocation } from '../lib/store-context';
import { Skeleton, fabricStyle } from '../components/ui';
import { t } from '../i18n';
import { AppBar, Sheet, Stepper } from './kit';

export interface QuoteLine {
  variant_id: string; unit_id: string; qty: number; base_qty: number; name: string; variant_label: string | null; unit_name: string;
  image: string | null; unit_price_kobo: number; retail_price_kobo: number; price_source: string; line_total_kobo: number; available: number;
}
export interface Quote { lines: QuoteLine[]; subtotal_kobo: number; dropped: number }

export function useQuote() {
  const { slug } = useStoreLocation();
  const lines = useCart(slug);
  const [quote, setQuote] = useState<Quote | null>(null);
  useEffect(() => {
    if (!lines.length) { setQuote({ lines: [], subtotal_kobo: 0, dropped: 0 }); return; }
    const ctrl = new AbortController();
    api<Quote>(`/api/store/${slug}/quote`, { json: { items: lines.map((l) => ({ variant_id: l.variant_id, unit_id: l.unit_id, qty: l.qty })) }, signal: ctrl.signal })
      .then(setQuote).catch(() => undefined);
    return () => ctrl.abort();
  }, [slug, lines]);
  return { lines, quote };
}

/** Saving vs retail for the whole cart (bundle/volume/wholesale prices). */
export function savingOf(q: Quote): number {
  return q.lines.reduce((s, l) => s + Math.max(l.retail_price_kobo - l.unit_price_kobo, 0) * l.base_qty, 0);
}

export function CartLineThumb({ line, size = 'md' }: { line: Pick<QuoteLine, 'image' | 'variant_id'>; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'size-[76px] rounded-2xl' : 'size-14 rounded-xl';
  return line.image
    ? <img loading="lazy" decoding="async" src={line.image} alt="" width={76} height={76} className={cx('shrink-0 bg-line-soft object-cover', box)} />
    : <div className={cx('shrink-0', box)} style={fabricStyle(line.variant_id)} aria-hidden />;
}

/** A row that can be swiped left to reveal "Remove" (the stepper's bin does the same for keyboards). */
function SwipeRow({ children, onRemove, label }: { children: React.ReactNode; onRemove: () => void; label: string }) {
  const [x, setX] = useState(0);
  const drag = useRef<{ start: number; from: number; moved: boolean } | null>(null);
  const open = x <= -60;
  return (
    <li className="relative overflow-hidden rounded-[22px]">
      <button type="button" onClick={onRemove} tabIndex={open ? 0 : -1} aria-hidden={!open} aria-label={label}
        className="absolute inset-y-0 right-0 flex w-24 items-center justify-center rounded-r-[22px] bg-red text-white">
        <Trash2 className="size-6" aria-hidden />
      </button>
      <div
        className="relative touch-pan-y transition-transform duration-200 ease-out"
        style={{ transform: `translateX(${x}px)`, transitionDuration: drag.current?.moved ? '0ms' : undefined }}
        onPointerDown={(e) => { if (e.pointerType !== 'mouse') drag.current = { start: e.clientX, from: x, moved: false }; }}
        onPointerMove={(e) => {
          const d = drag.current; if (!d) return;
          const dx = e.clientX - d.start;
          if (Math.abs(dx) > 6) d.moved = true;
          if (d.moved) setX(Math.min(0, Math.max(-112, d.from + dx)));
        }}
        onPointerUp={() => { if (drag.current?.moved) setX((v) => (v < -48 ? -96 : 0)); drag.current = null; }}
        onPointerCancel={() => { drag.current = null; setX(0); }}
      >
        {children}
      </div>
    </li>
  );
}

export function CartPage() {
  const { slug, href } = useStoreLocation();
  const { lines, quote } = useQuote();
  const keyOf = (l: QuoteLine) => ({ variant_id: l.variant_id, unit_id: lines.find((x) => x.variant_id === l.variant_id && x.unit_id === l.unit_id)?.unit_id });
  const count = lines.reduce((n, l) => n + l.qty, 0);

  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar title={t('cart.title')} back={href('/')} right={count > 0 ? <span className="num rounded-full bg-accent px-2.5 py-1 text-sm font-extrabold text-accent-ink">{count}</span> : undefined} />
      <Sheet>
        {!lines.length ? (
          <div className="flex flex-col items-center gap-4 px-6 py-16 text-center">
            <span className="flex size-20 items-center justify-center rounded-full bg-accent-soft"><ShoppingBag className="size-9 text-accent-text" aria-hidden /></span>
            <p className="font-display text-xl font-extrabold">{t('cart.empty')}</p>
            <Link className="press inline-flex min-h-12 items-center rounded-full bg-ink px-6 font-bold text-paper" to={href('/')}>{t('store.allProducts')}</Link>
          </div>
        ) : !quote ? <div className="space-y-3 px-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[100px] rounded-[22px]" />)}</div> : (
          <div className="space-y-4 px-4 pb-48">
            {quote.dropped > 0 && <p className="rounded-2xl bg-gold-50 p-3 text-sm text-gold-ink">{t('cart.unavailable')}</p>}
            <ul className="space-y-3">
              {quote.lines.map((l) => {
                const short = l.base_qty > l.available;
                return (
                  <SwipeRow key={`${l.variant_id}:${l.unit_id}`} label={`${t('cart.remove')}: ${l.name}`} onRemove={() => cart.setQty(slug, keyOf(l), 0)}>
                    <div className={cx('flex items-center gap-3 rounded-[22px] border bg-surface p-2.5 shadow-card', short ? 'border-gold' : 'border-line/60')}>
                      <CartLineThumb line={l} size="lg" />
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="line-clamp-2 font-bold leading-tight">{l.name}</p>
                        <p className="truncate text-xs text-muted">{[l.variant_label, `${formatNaira(l.unit_price_kobo)} ${t('store.each')}`].filter(Boolean).join(' · ')}{l.price_source !== 'retail' ? ` · ${t(`price.${l.price_source}` as never)}` : ''}</p>
                        {short && <p className="text-xs font-semibold text-gold-ink">{t('store.onlyPieces', { n: l.available })}</p>}
                        <p className={cx('num font-display text-lg font-extrabold', l.price_source !== 'retail' ? 'text-indigo' : 'text-accent-text')}>{formatNaira(l.line_total_kobo)}</p>
                      </div>
                      <div className="flex flex-col items-center gap-1">
                        <Stepper size="sm" removable value={l.qty} onChange={(n) => cart.setQty(slug, keyOf(l), n)} label={`${t('store.quantity')}: ${l.name}`} />
                        <span className="text-[11px] font-semibold text-muted">{l.unit_name}</span>
                      </div>
                    </div>
                  </SwipeRow>
                );
              })}
            </ul>
            <p className="text-center text-xs text-muted sm:hidden">{t('cart.swipeHint')}</p>
          </div>
        )}
      </Sheet>
      {quote && lines.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30">
          <div className="mx-auto max-w-xl rounded-t-[28px] border-t border-line/60 bg-surface px-4 pb-[max(18px,env(safe-area-inset-bottom))] pt-4 shadow-float">
            <dl className="mb-3 space-y-1 text-[15px]">
              <div className="flex justify-between"><dt className="text-body">{t('cart.subtotal', { n: count })}</dt><dd className="num font-bold">{formatNaira(quote.subtotal_kobo)}</dd></div>
              {savingOf(quote) > 0 && <div className="flex justify-between font-semibold text-green-ink"><dt>{t('checkout.youSave')}</dt><dd className="num">−{formatNaira(savingOf(quote))}</dd></div>}
            </dl>
            <Link to={href('/checkout')} className="press flex min-h-14 items-center justify-between rounded-2xl bg-ink px-5 font-bold text-paper">
              <span className="text-[17px]">{t('cart.checkout')}</span>
              <span className="flex items-center gap-2"><span className="num font-display text-xl font-extrabold">{formatNaira(quote.subtotal_kobo)}</span><ArrowRight className="size-5 text-accent" aria-hidden /></span>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
