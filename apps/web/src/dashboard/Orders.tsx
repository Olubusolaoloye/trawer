import { useState } from 'react';
import { Link, Route, Routes, useParams, useSearchParams } from 'react-router';
import { nairaToKobo } from '@trawer/core/money';
import { api } from '../lib/api';
import { invalidate, useApi, useMutation } from '../lib/use-api';
import { cx, formatDate, formatNaira } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Select, Spinner } from '../components/ui';
import { t, type MessageKey } from '../i18n';
import { useBiz } from './context';

export default function Orders() {
  return (
    <Routes>
      <Route index element={<OrderList />} />
      <Route path=":oid" element={<OrderDetail />} />
    </Routes>
  );
}

const tone = (s: string) => (s === 'confirmed' || s === 'completed' || s === 'paid' ? 'good' : s === 'pending' || s === 'partial' || s === 'unpaid' ? 'warn' : 'neutral');

function OrderList() {
  const b = useBiz();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const qs = new URLSearchParams([...params].filter(([, v]) => v));
  const { data } = useApi<{ orders: any[] }>(`/api/biz/${b.business.id}/orders?${qs}`, { staleMs: 5_000 });
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t('dash.orders')}</h1>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); set('q', q); }}>
        <Input type="search" placeholder="Order no., name or phone" aria-label={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" variant="secondary">{t('common.search')}</Button>
      </form>
      <div className="grid grid-cols-3 gap-2">
        <Select aria-label="Channel" value={params.get('channel') ?? ''} onChange={(e) => set('channel', e.target.value)}>
          <option value="">All channels</option>{['web', 'whatsapp', 'instagram', 'pos'].map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Select aria-label="Status" value={params.get('status') ?? ''} onChange={(e) => set('status', e.target.value)}>
          <option value="">All statuses</option>{['pending', 'confirmed', 'completed', 'cancelled', 'expired'].map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Select aria-label="Payment" value={params.get('payment') ?? ''} onChange={(e) => set('payment', e.target.value)}>
          <option value="">All payments</option>{['unpaid', 'partial', 'paid'].map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
      </div>
      {!data ? <Spinner /> : data.orders.length === 0 ? <Empty>{t('common.none')}</Empty> : (
        <ul className="divide-y rounded-2xl border bg-white">
          {data.orders.map((o) => (
            <li key={o.id}>
              <Link to={`${b.base}/orders/${o.id}`} className="flex min-h-16 items-center justify-between gap-3 px-4 py-2">
                <div className="min-w-0">
                  <p className="font-semibold">#{o.order_number} · {o.customer}</p>
                  <p className="text-sm text-stone-600">{o.channel} · {formatDate(o.created_at, true)}{o.needs_attention ? ' · ⚠️' : ''}</p>
                </div>
                <div className="text-right">
                  <p className="font-bold">{formatNaira(o.total_kobo)}</p>
                  <div className="flex justify-end gap-1"><Badge tone={tone(o.status)}>{o.status}</Badge><Badge tone={tone(o.payment_status)}>{o.payment_status}</Badge></div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OrderDetail() {
  const b = useBiz();
  const { oid = '' } = useParams();
  const key = `/api/biz/${b.business.id}/orders/${oid}`;
  const { data } = useApi<any>(key, { staleMs: 3_000 });
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const pay = useMutation(async () => {
    await api(`${key}/payments`, { json: { amount_kobo: nairaToKobo(amount), method, client_id: crypto.randomUUID() } });
    setAmount(''); invalidate(key); invalidate(`/api/biz/${b.business.id}/orders?`);
  });
  const cancel = useMutation(async () => { await api(`${key}/cancel`, { json: {} }); invalidate(key); });
  if (!data) return <Spinner />;
  const o = data.order;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">Order #{o.order_number}</h1>
        <div className="flex gap-1"><Badge tone={tone(o.status)}>{o.status}</Badge><Badge tone={tone(o.payment_status)}>{o.payment_status}</Badge><Badge>{t(`order.fulfil.${o.fulfilment_status}` as MessageKey)}</Badge></div>
      </div>
      {o.needs_attention && <p className="rounded-xl bg-amber-50 p-3 font-semibold text-amber-900">⚠️ {o.needs_attention.replaceAll('_', ' ')}</p>}
      <Card className="space-y-1 text-sm">
        <p><span className="font-semibold">Customer:</span> {data.customer ? `${data.customer.name} (${data.customer.phone})` : o.buyer_name ?? 'Walk-in'}</p>
        <p><span className="font-semibold">Channel:</span> {o.channel} · {o.delivery_method}</p>
        {o.delivery_address && <p><span className="font-semibold">Address:</span> {[o.delivery_address.line1, o.delivery_address.area, o.delivery_address.city, o.delivery_address.state].filter(Boolean).join(', ')}</p>}
        {o.note && <p><span className="font-semibold">Note:</span> {o.note}</p>}
      </Card>
      <Card className="space-y-2">
        {o.items.map((i: any) => (
          <div key={i.id} className="flex justify-between gap-3 text-sm">
            <span>{i.unit_qty} × {i.name}{i.variant_label ? ` (${i.variant_label})` : ''} <span className="text-stone-500">· {i.price_source}</span></span>
            <span className="font-semibold">{formatNaira(i.line_total_kobo)}</span>
          </div>
        ))}
        <div className="flex justify-between border-t pt-2 font-bold"><span>Total</span><span>{formatNaira(o.total_kobo)}</span></div>
        <div className="flex justify-between text-sm"><span>Paid</span><span>{formatNaira(o.amount_paid_kobo)}</span></div>
        <div className={cx('flex justify-between font-bold', o.balance_kobo > 0 && 'text-red-700')}><span>Balance</span><span>{formatNaira(o.balance_kobo)}</span></div>
      </Card>
      {data.payments.length > 0 && (
        <Card className="space-y-1 text-sm">
          <p className="font-semibold">Payments</p>
          {data.payments.map((p: any) => <p key={p.id}>{formatDate(p.received_at, true)} · {p.method} · {formatNaira(p.amount_kobo)}</p>)}
        </Card>
      )}
      {b.can('payments.record') && o.balance_kobo > 0 && o.status !== 'cancelled' && (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void pay.run(); }}>
          <h2 className="font-bold">Record payment</h2>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Amount ₦" htmlFor="amt"><Input id="amt" required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={String(o.balance_kobo / 100)} /></Field>
            <Field label="Method" htmlFor="m">
              <Select id="m" value={method} onChange={(e) => setMethod(e.target.value)}>
                {[['cash', 'Cash'], ['card_terminal', 'Card (POS terminal)'], ['transfer', 'Bank transfer'], ['ussd', 'USSD'], ['qr', 'QR']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </Select>
            </Field>
          </div>
          <ErrorNote error={pay.error} />
          <Button type="submit" className="w-full" pending={pay.pending}>Record</Button>
        </form>
      )}
      {b.can('orders.manage') && o.status === 'pending' && (
        <><ErrorNote error={cancel.error} /><Button variant="danger" className="w-full" pending={cancel.pending} onClick={() => void cancel.run()}>Cancel order and release stock</Button></>
      )}
    </div>
  );
}
