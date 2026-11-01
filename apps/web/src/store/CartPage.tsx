import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { cart, useCart } from '../lib/cart';
import { formatNaira } from '../lib/format';
import { useStoreLocation } from '../lib/store-context';
import { Button, Card, Empty, Spinner } from '../components/ui';
import { t } from '../i18n';

export interface QuoteLine {
  variant_id: string; unit_id: string; qty: number; base_qty: number; name: string; variant_label: string | null; unit_name: string;
  image: string | null; unit_price_kobo: number; retail_price_kobo: number; line_total_kobo: number; available: number;
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

export function CartPage() {
  const { slug, href } = useStoreLocation();
  const navigate = useNavigate();
  const { lines, quote } = useQuote();
  if (!lines.length) return (
    <div className="space-y-4 text-center"><Empty>{t('cart.empty')}</Empty><Link className="font-semibold underline" to={href('/')}>{t('store.allProducts')}</Link></div>
  );
  if (!quote) return <Spinner />;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t('cart.title')}</h1>
      {quote.dropped > 0 && <p className="rounded-xl bg-amber-50 p-3 text-sm">{t('cart.unavailable')}</p>}
      <ul className="space-y-3">
        {quote.lines.map((l) => {
          const key = { variant_id: l.variant_id, unit_id: lines.find((x) => x.variant_id === l.variant_id && (x.unit_id ?? '') !== '' && x.unit_id === l.unit_id)?.unit_id };
          return (
            <li key={`${l.variant_id}:${l.unit_id}`}>
              <Card className="flex gap-3">
                {l.image ? <img src={l.image} alt="" width={80} height={80} className="size-20 rounded-xl object-cover" /> : <div className="size-20 rounded-xl bg-stone-100" />}
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-semibold leading-tight">{l.name}</p>
                  {l.variant_label && <p className="text-sm text-stone-600">{l.variant_label}</p>}
                  <p className="text-sm">{l.qty} {l.unit_name} · {formatNaira(l.unit_price_kobo)} each piece</p>
                  {l.base_qty > l.available && <p className="text-sm font-semibold text-red-700">{t('store.available', { n: l.available })}</p>}
                  <div className="flex items-center gap-2">
                    <select aria-label={t('store.quantity')} className="min-h-11 rounded-lg border-2 border-stone-300 px-2" value={l.qty}
                      onChange={(e) => cart.setQty(slug, key, Number(e.target.value))}>
                      {Array.from({ length: Math.max(20, l.qty) }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                    <button type="button" className="flex size-11 items-center justify-center rounded-lg text-stone-600 hover:bg-stone-100" aria-label={t('cart.remove')}
                      onClick={() => cart.setQty(slug, key, 0)}><Trash2 className="size-5" /></button>
                  </div>
                </div>
                <p className="font-bold">{formatNaira(l.line_total_kobo)}</p>
              </Card>
            </li>
          );
        })}
      </ul>
      <Card className="flex items-center justify-between text-lg font-bold">
        <span>{t('cart.subtotal')}</span><span>{formatNaira(quote.subtotal_kobo)}</span>
      </Card>
      <p className="text-sm text-stone-600">{t('cart.priceChanged')}</p>
      <Button size="lg" className="w-full" onClick={() => navigate(href('/checkout'))}>{t('cart.checkout')}</Button>
    </div>
  );
}
