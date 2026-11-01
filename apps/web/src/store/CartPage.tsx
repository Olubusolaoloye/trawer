import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Minus, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { cart, useCart } from '../lib/cart';
import { formatNaira, cx } from '../lib/format';
import { useStoreLocation } from '../lib/store-context';
import { Empty, Spinner, fabricStyle } from '../components/ui';
import { t } from '../i18n';
import { PageHeader } from './PageHeader';

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

export function CartLineThumb({ line }: { line: Pick<QuoteLine, 'image' | 'variant_id'> }) {
  return line.image
    ? <img src={line.image} alt="" width={56} height={56} className="size-14 shrink-0 rounded-xl object-cover" />
    : <div className="size-14 shrink-0 rounded-xl" style={fabricStyle(line.variant_id)} aria-hidden />;
}

export function CartPage() {
  const { slug, href } = useStoreLocation();
  const { lines, quote } = useQuote();
  const keyOf = (l: QuoteLine) => ({ variant_id: l.variant_id, unit_id: lines.find((x) => x.variant_id === l.variant_id && x.unit_id === l.unit_id)?.unit_id });

  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col">
      <PageHeader title={t('cart.title')} back={href('/')} />
      {!lines.length ? (
        <div className="space-y-4 px-4 text-center"><Empty>{t('cart.empty')}</Empty><Link className="font-bold underline" to={href('/')}>{t('store.allProducts')}</Link></div>
      ) : !quote ? <Spinner /> : (
        <>
          <div className="flex-1 space-y-3 px-4 pb-40">
            {quote.dropped > 0 && <p className="rounded-xl bg-gold-50 p-3 text-sm text-gold-ink">{t('cart.unavailable')}</p>}
            <ul className="space-y-3">
              {quote.lines.map((l) => {
                const short = l.base_qty > l.available;
                return (
                  <li key={`${l.variant_id}:${l.unit_id}`} className={cx('flex gap-3 rounded-2xl border bg-surface p-3', short ? 'border-gold' : 'border-line')}>
                    <CartLineThumb line={l} />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <p className="font-semibold leading-tight">{l.name}{l.variant_label ? ` · ${l.variant_label}` : ''}</p>
                      <p className="text-[13px] text-muted">{formatNaira(l.unit_price_kobo)} {t('store.each')}{l.price_source !== 'retail' ? ` · ${t(`price.${l.price_source}` as never)}` : ''}</p>
                      {short && <p className="text-[13px] font-semibold text-gold-ink">{t('store.onlyPieces', { n: l.available })}</p>}
                      <div className="flex items-center gap-2">
                        <div className="flex items-center rounded-xl border-2 border-line">
                          <button type="button" className="flex size-10 items-center justify-center" aria-label={t('store.less')} onClick={() => cart.setQty(slug, keyOf(l), l.qty - 1)}><Minus className="size-4" /></button>
                          <span className="num w-14 text-center text-sm font-bold">{l.qty} {l.unit_name}</span>
                          <button type="button" className="flex size-10 items-center justify-center" aria-label={t('store.more')} onClick={() => cart.setQty(slug, keyOf(l), l.qty + 1)}><Plus className="size-4" /></button>
                        </div>
                        <button type="button" className="flex size-10 items-center justify-center rounded-xl text-muted hover:bg-line-soft" aria-label={t('cart.remove')}
                          onClick={() => cart.setQty(slug, keyOf(l), 0)}><Trash2 className="size-5" /></button>
                      </div>
                    </div>
                    <b className="num whitespace-nowrap">{formatNaira(l.line_total_kobo)}</b>
                  </li>
                );
              })}
            </ul>
            {savingOf(quote) > 0 && <p className="text-[15px] font-semibold text-green-ink">{t('cart.saving', { amount: formatNaira(savingOf(quote)) })}</p>}
          </div>
          <div className="fixed inset-x-0 bottom-0 border-t border-line bg-surface">
            <div className="mx-auto max-w-xl px-4 pb-[18px] pt-3">
              <Link to={href('/checkout')} className="flex min-h-15 items-center justify-between rounded-[18px] bg-ink px-5 font-bold text-paper">
                <span className="text-[17px]">{t('cart.checkout')}</span>
                <span className="num font-display text-[22px] font-extrabold">{formatNaira(quote.subtotal_kobo)}</span>
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
