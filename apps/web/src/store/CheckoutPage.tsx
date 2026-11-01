import { useMemo, useState } from 'react';
import { Navigate } from 'react-router';
import { Check, Lock, MapPin } from 'lucide-react';
import { api } from '../lib/api';
import { cart } from '../lib/cart';
import { useApi, useMutation } from '../lib/use-api';
import { formatNaira, cx } from '../lib/format';
import { useStoreLocation } from '../lib/store-context';
import { ErrorNote, Field, Input, Spinner, Textarea } from '../components/ui';
import { t } from '../i18n';
import { CartLineThumb, savingOf, useQuote } from './CartPage';
import { useStore } from './StoreLayout';
import { PageHeader } from './PageHeader';

interface Address { line1: string; area: string; city: string; state: string; landmark: string }
const ADDR_KEY = 'trawer:address';
function savedAddress(): Address {
  try { return { line1: '', area: '', city: '', state: 'Lagos', landmark: '', ...JSON.parse(localStorage.getItem(ADDR_KEY) ?? '{}') }; }
  catch { return { line1: '', area: '', city: '', state: 'Lagos', landmark: '' }; }
}

export function CheckoutPage() {
  const { slug, href } = useStoreLocation();
  const me = useApi<{ user: { phone: string } | null }>('/api/auth/me');
  const store = useStore().data!;
  const { lines, quote } = useQuote();
  const [method, setMethod] = useState<'pickup' | 'delivery'>('pickup');
  const [addr, setAddr] = useState<Address>(savedAddress);
  const [editAddr, setEditAddr] = useState(() => !savedAddress().line1);
  const [note, setNote] = useState('');
  const [placedId, setPlacedId] = useState<string | null>(null);
  const clientId = useMemo(() => crypto.randomUUID(), []); // retry-safe: same id → same order
  const place = useMutation(async () => {
    if (method === 'delivery') { try { localStorage.setItem(ADDR_KEY, JSON.stringify(addr)); } catch { /* ignore */ } }
    const r = await api<{ order: { id: string } }>(`/api/store/${slug}/checkout`, { json: {
      client_id: clientId,
      items: lines.map((l) => ({ variant_id: l.variant_id, unit_id: l.unit_id, qty: l.qty })),
      delivery_method: method,
      delivery_address: method === 'delivery' ? { ...addr, area: addr.area || undefined, landmark: addr.landmark || undefined } : undefined,
      note: note || undefined,
      channel: new URLSearchParams(window.location.search).get('ch') === 'ig' ? 'instagram' : 'web',
    } });
    setPlacedId(r.order.id);
    cart.clear(slug);
  });

  if (placedId) return <Navigate to={href(`/orders/${placedId}`)} replace />;
  if (!me.data) return <Spinner />;
  if (!me.data.user || !store.me) return <Navigate to={href('/account?next=/checkout')} replace />;
  if (!lines.length) return <Navigate to={href('/cart')} replace />;
  if (!quote) return <Spinner />;
  const addressOk = method === 'pickup' || (addr.line1.trim().length >= 3 && addr.city.trim().length >= 2);

  return (
    <form className="mx-auto flex min-h-dvh max-w-xl flex-col" onSubmit={(e) => { e.preventDefault(); void place.run(); }}>
      <PageHeader title={t('checkout.title')} back={href('/cart')}
        right={<span className="inline-flex items-center gap-1.5 rounded-full bg-green-50 px-2.5 py-1.5 text-xs font-bold text-green-ink"><Lock className="size-3.5" aria-hidden />{t('checkout.held', { n: store.business.reservation_minutes })}</span>} />

      <div className="flex-1 space-y-3.5 px-4 pb-44">
        <section aria-label={t('checkout.items')} className="rounded-[18px] border border-line bg-surface px-3.5 py-1.5">
          {quote.lines.map((l, i) => (
            <div key={`${l.variant_id}:${l.unit_id}`} className={cx('flex items-center gap-3 py-2.5', i > 0 && 'border-t border-line-soft')}>
              <CartLineThumb line={l} />
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-bold leading-tight">{l.name}{l.variant_label ? ` · ${l.variant_label}` : ''}</p>
                <p className="text-[13px] text-muted">{l.qty} {l.unit_name}{l.base_qty !== l.qty ? ` (${l.base_qty} pcs)` : ''} · {formatNaira(l.unit_price_kobo)} {t('store.each')}</p>
              </div>
              <b className="num">{formatNaira(l.line_total_kobo)}</b>
            </div>
          ))}
        </section>

        <fieldset>
          <legend className="mb-2 text-[15px] font-bold">{t('checkout.delivery')}</legend>
          <div className="grid grid-cols-2 gap-2">
            {(['pickup', 'delivery'] as const).map((m) => (
              <button key={m} type="button" aria-pressed={method === m} onClick={() => setMethod(m)}
                className={cx('flex min-h-[72px] flex-col items-start justify-center gap-0.5 rounded-2xl border-2 px-3.5 text-left',
                  method === m ? 'border-ink bg-ink text-paper' : 'border-line bg-surface')}>
                <b className="text-[15px]">{m === 'pickup' ? t('checkout.pickup') : t('checkout.deliver')}</b>
                <span className={cx('text-xs', method === m ? 'text-paper/75' : 'text-muted')}>{m === 'pickup' ? (store.business.address ?? t('checkout.atShop')) : t('checkout.feeConfirmed')}</span>
              </button>
            ))}
          </div>
        </fieldset>

        {method === 'delivery' && (editAddr ? (
          <div className="space-y-3 rounded-[18px] border border-line bg-surface p-3.5">
            <Field label={t('checkout.address')} htmlFor="l1"><Input id="l1" required minLength={3} autoComplete="street-address" value={addr.line1} onChange={(e) => setAddr({ ...addr, line1: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('checkout.area')} htmlFor="area"><Input id="area" value={addr.area} onChange={(e) => setAddr({ ...addr, area: e.target.value })} /></Field>
              <Field label={t('checkout.city')} htmlFor="city"><Input id="city" required value={addr.city} onChange={(e) => setAddr({ ...addr, city: e.target.value })} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('checkout.state')} htmlFor="state"><Input id="state" required value={addr.state} onChange={(e) => setAddr({ ...addr, state: e.target.value })} /></Field>
              <Field label={t('checkout.landmark')} htmlFor="lm"><Input id="lm" value={addr.landmark} onChange={(e) => setAddr({ ...addr, landmark: e.target.value })} /></Field>
            </div>
          </div>
        ) : (
          <section className="flex items-start gap-3 rounded-[18px] border border-line bg-surface p-3.5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gold-50"><MapPin className="size-5 text-gold-ink" aria-hidden /></span>
            <div className="flex-1"><b className="text-[15px]">{addr.line1}</b><p className="text-[13px] text-body">{[addr.area, addr.city].filter(Boolean).join(', ')}{addr.landmark ? ` · ${addr.landmark}` : ''}</p></div>
            <button type="button" className="min-h-10 px-2.5 text-sm font-bold underline" onClick={() => setEditAddr(true)}>{t('checkout.change')}</button>
          </section>
        ))}

        <section className="flex items-center gap-3 rounded-[18px] border border-line bg-surface p-3.5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-green-50"><Check className="size-5 text-green-ink" aria-hidden /></span>
          <div className="flex-1"><b className="text-[15px]">{store.me.name} · {me.data.user.phone}</b><p className="text-[13px] text-body">{t('checkout.verified')}</p></div>
        </section>

        <Field label={`${t('checkout.note')} (${t('common.optional')})`} htmlFor="note">
          <Textarea id="note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        <dl className="space-y-1.5 px-1 text-[15px]">
          <div className="flex justify-between"><dt className="text-body">{t('checkout.itemsTotal')}</dt><dd className="num">{formatNaira(quote.subtotal_kobo)}</dd></div>
          {savingOf(quote) > 0 && <div className="flex justify-between font-semibold text-green-ink"><dt>{t('checkout.youSave')}</dt><dd className="num">−{formatNaira(savingOf(quote))}</dd></div>}
        </dl>
        <ErrorNote error={place.error} />
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-line bg-surface">
        <div className="mx-auto max-w-xl space-y-2 px-4 pb-[18px] pt-3">
          <button type="submit" disabled={place.pending || !addressOk}
            className="flex min-h-15 w-full items-center justify-between rounded-[18px] bg-green px-5 font-bold text-white disabled:opacity-60">
            <span className="text-[17px]">{place.pending ? t('common.loading') : t('checkout.payByTransfer')}</span>
            <span className="num font-display text-[22px] font-extrabold">{formatNaira(quote.subtotal_kobo)}</span>
          </button>
          <p className="text-center text-[13px] text-muted">{t('checkout.payHint')}</p>
        </div>
      </div>
    </form>
  );
}
