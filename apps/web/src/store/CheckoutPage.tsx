import { useMemo, useState } from 'react';
import { Navigate } from 'react-router';
import { api } from '../lib/api';
import { cart } from '../lib/cart';
import { useApi, useMutation } from '../lib/use-api';
import { formatNaira, cx } from '../lib/format';
import { useStoreLocation } from '../lib/store-context';
import { Button, Card, ErrorNote, Field, Input, Spinner, Textarea } from '../components/ui';
import { t } from '../i18n';
import { useQuote } from './CartPage';
import { useStore } from './StoreLayout';

export function CheckoutPage() {
  const { slug, href } = useStoreLocation();
  const me = useApi<{ user: unknown }>('/api/auth/me');
  const store = useStore().data!;
  const { lines, quote } = useQuote();
  const [method, setMethod] = useState<'pickup' | 'delivery'>('pickup');
  const [addr, setAddr] = useState({ line1: '', area: '', city: '', state: 'Lagos', landmark: '' });
  const [note, setNote] = useState('');
  const [placedId, setPlacedId] = useState<string | null>(null);
  const clientId = useMemo(() => crypto.randomUUID(), []); // retry-safe: same id → same order
  const place = useMutation(async () => {
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

  return (
    <form className="mx-auto max-w-lg space-y-5" onSubmit={(e) => { e.preventDefault(); void place.run(); }}>
      <h1 className="text-2xl font-bold">{t('checkout.title')}</h1>
      <fieldset className="grid grid-cols-2 gap-2">
        <legend className="mb-2 text-sm font-semibold">{t('checkout.delivery')}</legend>
        {(['pickup', 'delivery'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={method === m} onClick={() => setMethod(m)}
            className={cx('min-h-14 rounded-xl border-2 font-semibold', method === m ? 'border-brand bg-brand text-brand-ink' : 'border-stone-300 bg-white')}>
            {m === 'pickup' ? t('checkout.pickup') : t('checkout.deliver')}
          </button>
        ))}
      </fieldset>
      {method === 'delivery' && (
        <div className="space-y-3">
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
      )}
      <Field label={`${t('checkout.note')} (${t('common.optional')})`} htmlFor="note">
        <Textarea id="note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Card className="space-y-1">
        {quote.lines.map((l) => (
          <div key={`${l.variant_id}:${l.unit_id}`} className="flex justify-between gap-3 text-sm">
            <span>{l.qty} {l.unit_name} × {l.name}{l.variant_label ? ` (${l.variant_label})` : ''}</span><span className="font-semibold">{formatNaira(l.line_total_kobo)}</span>
          </div>
        ))}
      </Card>
      <ErrorNote error={place.error} />
      <Button type="submit" size="lg" className="w-full" pending={place.pending}>{t('checkout.place', { total: formatNaira(quote.subtotal_kobo) })}</Button>
    </form>
  );
}
