import { useMemo, useState } from 'react';
import { Navigate } from 'react-router';
import { Check, Landmark, Lock, MapPin, ShieldCheck, Store, Truck } from 'lucide-react';
import { api } from '../lib/api';
import { pageSearch } from '../lib/demo';
import { cart } from '../lib/cart';
import { useApi, useMutation } from '../lib/use-api';
import { formatNaira, cx } from '../lib/format';
import { useStoreLocation } from '../lib/store-context';
import { ErrorNote, Field, Input, Textarea, PageSkeleton } from '../components/ui';
import { t } from '../i18n';
import { CartLineThumb, savingOf, useQuote } from './CartPage';
import { useStore } from './StoreLayout';
import { AppBar, Sheet } from './kit';

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
      channel: pageSearch().get('ch') === 'ig' ? 'instagram' : 'web',
    } });
    setPlacedId(r.order.id);
    cart.clear(slug);
  });

  if (placedId) return <Navigate to={href(`/orders/${placedId}`)} replace />;
  if (!me.data) return <PageSkeleton />;
  if (!me.data.user || !store.me) return <Navigate to={href('/account?next=/checkout')} replace />;
  if (!lines.length) return <Navigate to={href('/cart')} replace />;
  if (!quote) return <PageSkeleton />;
  const addressOk = method === 'pickup' || (addr.line1.trim().length >= 3 && addr.city.trim().length >= 2);

  return (
    <form className="flex min-h-dvh flex-col" onSubmit={(e) => { e.preventDefault(); void place.run(); }}>
      <AppBar title={t('checkout.title')} back={href('/cart')} />
      <Sheet className="space-y-5 px-4 pb-48">
        <p className="flex items-center gap-2 rounded-2xl bg-green-50 px-3.5 py-2.5 text-sm font-semibold text-green-ink"><Lock className="size-4 shrink-0" aria-hidden />{t('checkout.held', { n: store.business.reservation_minutes })}</p>
        <section aria-label={t('checkout.items')} className="rounded-[22px] border border-line/60 bg-surface px-3.5 py-1.5 shadow-card">
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

        <fieldset className="space-y-2.5">
          <legend className="mb-2.5 font-display text-lg font-extrabold">{t('checkout.delivery')}</legend>
          {(['pickup', 'delivery'] as const).map((m) => {
            const Icon = m === 'pickup' ? Store : Truck;
            const on = method === m;
            return (
              <button key={m} type="button" aria-pressed={on} onClick={() => setMethod(m)}
                className={cx('press flex w-full items-center gap-3 rounded-[22px] border-2 bg-surface p-3.5 text-left shadow-card transition-colors', on ? 'border-ink' : 'border-transparent')}>
                <span className={cx('flex size-11 shrink-0 items-center justify-center rounded-2xl', on ? 'bg-ink text-paper' : 'bg-line-soft text-body')}><Icon className="size-5" aria-hidden /></span>
                <span className="min-w-0 flex-1">
                  <b className="block text-[15px]">{m === 'pickup' ? t('checkout.pickup') : t('checkout.deliver')}</b>
                  <span className="text-[13px] text-muted">{m === 'pickup' ? (store.business.address ?? t('checkout.atShop')) : t('checkout.feeConfirmed')}</span>
                </span>
                <span className={cx('flex size-6 shrink-0 items-center justify-center rounded-full border-2', on ? 'border-ink bg-ink' : 'border-line')} aria-hidden>{on && <Check className="size-3.5 text-paper" strokeWidth={3.2} />}</span>
              </button>
            );
          })}
        </fieldset>

        {method === 'delivery' && (editAddr ? (
          <div className="space-y-3 rounded-[22px] border border-line/60 bg-surface p-3.5 shadow-card">
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
          <section className="flex items-start gap-3 rounded-[22px] border border-line/60 bg-surface p-3.5 shadow-card">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gold-50"><MapPin className="size-5 text-gold-ink" aria-hidden /></span>
            <div className="flex-1"><b className="text-[15px]">{addr.line1}</b><p className="text-[13px] text-body">{[addr.area, addr.city].filter(Boolean).join(', ')}{addr.landmark ? ` · ${addr.landmark}` : ''}</p></div>
            <button type="button" className="min-h-10 px-2.5 text-sm font-bold underline" onClick={() => setEditAddr(true)}>{t('checkout.change')}</button>
          </section>
        ))}

        <section aria-labelledby="pay-h" className="space-y-2.5">
          <h2 id="pay-h" className="font-display text-lg font-extrabold">{t('checkout.payment')}</h2>
          <div className="flex items-center gap-3 rounded-[22px] border-2 border-ink bg-surface p-3.5 shadow-card">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-ink text-paper"><Landmark className="size-5" aria-hidden /></span>
            <span className="min-w-0 flex-1"><b className="block text-[15px]">{t('checkout.transferTitle')}</b><span className="text-[13px] text-muted">{t('checkout.transferHint')}</span></span>
            <ShieldCheck className="size-6 shrink-0 text-green-ink" aria-hidden />
          </div>
        </section>

        <section className="flex items-center gap-3 rounded-[22px] bg-line-soft p-3.5">
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
      </Sheet>

      <div className="fixed inset-x-0 bottom-0 z-30">
        <div className="mx-auto max-w-xl space-y-2 rounded-t-[28px] border-t border-line/60 bg-surface px-4 pb-[max(18px,env(safe-area-inset-bottom))] pt-4 shadow-float">
          <button type="submit" disabled={place.pending || !addressOk}
            className="press flex min-h-15 w-full items-center justify-between rounded-2xl bg-green px-5 font-bold text-white shadow-[0_12px_24px_-12px_rgb(11_122_75/0.8)] disabled:opacity-60">
            <span className="text-[17px]">{place.pending ? t('common.loading') : t('checkout.payByTransfer')}</span>
            <span className="num font-display text-[22px] font-extrabold">{formatNaira(quote.subtotal_kobo)}</span>
          </button>
          <p className="text-center text-[13px] text-muted">{t('checkout.payHint')}</p>
        </div>
      </div>
    </form>
  );
}
