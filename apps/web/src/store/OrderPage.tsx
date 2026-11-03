import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Check, Copy, FileText, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import { hardNav } from '../lib/demo';
import { invalidate, useApi, useMutation } from '../lib/use-api';
import { formatDate, formatNaira, cx } from '../lib/format';
import { useStoreLocation } from '../lib/store-context';
import { Badge, Button, Empty, ErrorNote, Spinner } from '../components/ui';
import { t, type MessageKey } from '../i18n';
import { AppBar, Sheet, Timeline, type TimelineStep } from './kit';

interface OrderView {
  order: any;
  virtual_account: { account_number: string; account_name: string; bank_name: string } | null;
  payments: { method: string; amount_kobo: number; received_at: string }[];
  business: { name: string; slug: string } | null;
  delivery?: { delivery: { rider_name: string | null; failure: string | null } | null; events: { status: string; at: string }[] } | null;
  sandbox?: boolean;
}

/** Live order status over Server-Sent Events (falls back to polling). */
function useLiveOrder(id: string) {
  const initial = useApi<OrderView>(`/api/orders/${id}`);
  const [live, setLive] = useState<OrderView | null>(null);
  useEffect(() => {
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => { poll ??= setInterval(() => void api<OrderView>(`/api/orders/${id}`).then(setLive).catch(() => undefined), 5000); };
    try {
      es = new EventSource(`/api/orders/${id}/events`);
      es.addEventListener('order', (e) => setLive(JSON.parse((e as MessageEvent).data)));
      es.onerror = () => { es?.close(); startPolling(); };
    } catch { startPolling(); }
    return () => { es?.close(); if (poll) clearInterval(poll); };
  }, [id]);
  return { data: live ?? initial.data, error: initial.error };
}

function useCountdown(iso: string | null | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!iso) return;
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, [iso]);
  if (!iso) return null;
  const ms = Math.max(new Date(iso).getTime() - now, 0);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

const groupDigits = (n: string) => n.replace(/^(\d{4})(\d{3})(\d{3})$/, '$1 $2 $3');

export function OrderPage() {
  const { id = '' } = useParams();
  const { href } = useStoreLocation();
  const { data, error } = useLiveOrder(id);
  const [copied, setCopied] = useState(false);
  const cancel = useMutation(async () => { await api(`/api/orders/${id}/cancel`, { json: {} }); await invalidate(`/api/orders/${id}`); });
  const simulate = useMutation(async () => { await api('/api/dev/simulate-transfer', { json: { order_id: id } }); });
  const left = useCountdown(data?.order.status === 'pending' ? data.order.reservation_expires_at : null);

  if (error) return <Empty>Order not found.</Empty>;
  if (!data) return <Spinner />;
  const o = data.order;
  const paidInFull = o.payment_status === 'paid';
  const awaiting = o.status === 'pending' && o.balance_kobo > 0;

  if (awaiting && data.virtual_account) {
    const va = data.virtual_account;
    return (
      <div className="mx-auto flex min-h-dvh max-w-xl flex-col gap-3.5 px-4 pb-6 pt-4">
        <div className="flex items-center justify-between">
          <Link to={href('/orders')} className="text-sm font-bold text-muted">{t('order.title', { n: o.order_number })} · {data.business?.name}</Link>
          {left && <span className="rounded-full bg-gold-50 px-2.5 py-1.5 text-[13px] font-bold text-gold-ink">{t('order.heldFor', { time: left })}</span>}
        </div>
        <div>
          <p className="text-base text-body">{t('order.transferExactly')}</p>
          <p className="num font-display text-[52px] font-extrabold leading-none tracking-tight">{formatNaira(o.balance_kobo)}</p>
          {o.amount_paid_kobo > 0 && <p className="mt-1 text-sm font-semibold text-green-ink">{t('order.alreadyPaid', { amount: formatNaira(o.amount_paid_kobo) })}</p>}
        </div>

        <section aria-label={t('order.accountNumber')} className="dots relative overflow-hidden rounded-3xl bg-ink p-5 text-paper">
          <div className="absolute inset-2.5 rounded-[18px] bg-ink/90" aria-hidden />
          <div className="relative space-y-4">
            <div>
              <p className="text-[13px] font-semibold text-paper/75">{t('order.yourAccount')}</p>
              <p className="num font-display text-[38px] font-extrabold tracking-[3px]">{groupDigits(va.account_number)}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><p className="text-xs text-paper/75">{t('order.bank')}</p><p className="font-bold">{va.bank_name}</p></div>
              <div><p className="text-xs text-paper/75">{t('order.nameYouSee')}</p><p className="font-bold">{va.account_name}</p></div>
            </div>
            <Button variant="gold" size="lg" className="w-full" onClick={() => { void navigator.clipboard?.writeText(va.account_number); setCopied(true); }}>
              {copied ? <Check className="size-5" aria-hidden /> : <Copy className="size-5" aria-hidden />}{copied ? t('order.copied') : t('order.copyNumber')}
            </Button>
          </div>
        </section>

        <ol className="space-y-2.5">
          {[t('order.step1'), t('order.step2', { amount: formatNaira(o.balance_kobo) }), t('order.step3')].map((s, i) => (
            <li key={i} className="flex items-center gap-3">
              <span className={cx('flex size-[30px] shrink-0 items-center justify-center rounded-full text-sm font-extrabold', i === 2 ? 'bg-green text-white' : 'border-2 border-ink bg-surface')}>{i + 1}</span>
              <span className="text-[15px]">{s}</span>
            </li>
          ))}
        </ol>

        <div className="flex items-center gap-3.5 rounded-[18px] border border-line bg-surface p-4" role="status">
          <span className="relative size-5 shrink-0" aria-hidden>
            <span className="pulse-ring absolute inset-0 rounded-full bg-green" />
            <span className="absolute inset-1 rounded-md bg-green" />
          </span>
          <span className="flex-1"><b className="block">{t('order.waiting')}</b><span className="text-[13px] text-muted">{t('order.waitingHint')}</span></span>
        </div>

        {data.sandbox && <Button variant="secondary" className="w-full" pending={simulate.pending} onClick={() => void simulate.run()}>{t('order.simulate')}</Button>}
        {o.amount_paid_kobo === 0 && (
          <>
            <ErrorNote error={cancel.error} />
            <Button variant="ghost" className="w-full" pending={cancel.pending} onClick={() => void cancel.run()}>{t('order.cancel')}</Button>
          </>
        )}
        <p className="mt-auto flex items-center justify-center gap-2 text-center text-[13px] text-body">
          <ShieldCheck className="size-4 shrink-0 text-green-ink" aria-hidden />{t('order.trust', { shop: data.business?.name ?? '' })}
        </p>
      </div>
    );
  }

  const delivery = o.delivery_method === 'delivery';
  const failed = o.fulfilment_status === 'failed' || o.fulfilment_status === 'returned';
  const when: Record<string, string | undefined> = { placed: o.created_at, paid: data.payments[0]?.received_at ?? o.confirmed_at ?? undefined };
  for (const e of data.delivery?.events ?? []) when[e.status] = e.at;
  const riderName = data.delivery?.delivery?.rider_name;
  const isLive = o.status === 'confirmed' || o.status === 'completed';
  const reached = (s: string) => {
    const order = delivery ? ['confirmed', 'packed', 'dispatched', 'delivered'] : ['confirmed', 'packed', 'collected'];
    const at = order.indexOf(o.fulfilment_status === 'failed' || o.fulfilment_status === 'returned' ? 'dispatched' : o.fulfilment_status);
    return order.indexOf(s) <= at;
  };
  const raw: { key: string; title: string; detail?: string; done: boolean }[] = [
    { key: 'placed', title: t('timeline.placed'), detail: t('timeline.placedHint'), done: true },
    { key: 'paid', title: t(o.is_credit ? 'timeline.credit' : 'timeline.paid'), detail: o.is_credit ? undefined : t('timeline.paidHint'), done: isLive },
    { key: 'packed', title: t('order.fulfil.packed'), detail: t('timeline.packedHint'), done: isLive && reached('packed') },
    ...(delivery
      ? [{ key: 'dispatched', title: t('order.fulfil.dispatched'), detail: riderName ? t('track.onTheWayWith', { name: riderName }) : t('timeline.dispatchedHint'), done: isLive && reached('dispatched') },
         { key: 'delivered', title: t('order.fulfil.delivered'), detail: failed ? t('track.failed', { reason: t(`deliv.fail.${data.delivery?.delivery?.failure ?? 'other'}` as MessageKey) }) : t('timeline.deliveredHint', { place: o.delivery_address?.city ?? '' }), done: isLive && reached('delivered') }]
      : [{ key: 'collected', title: t('order.fulfil.collected'), detail: t('timeline.collectHint'), done: isLive && reached('collected') }]),
  ];
  const firstTodo = raw.findIndex((r) => !r.done);
  const steps: TimelineStep[] = raw.map((r, i) => ({
    title: r.title, detail: r.detail, at: r.done && when[r.key] ? clock(when[r.key]!) : null,
    state: r.done ? 'done' : failed && r.key === 'delivered' ? 'failed' : i === firstTodo && o.status !== 'cancelled' && o.status !== 'expired' ? 'current' : 'todo',
  }));

  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar title={t('order.title', { n: o.order_number })} back={href('/orders')} />
      <Sheet className="space-y-4 px-4 pb-10">
        {paidInFull && (
          <section role="status" className="flex items-center gap-3.5 rounded-[22px] bg-green p-4 text-white shadow-card">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-white"><Check className="size-7 text-green" strokeWidth={3} aria-hidden /></span>
            <div>
              <p className="font-display text-xl font-extrabold leading-tight">{t('order.received', { amount: formatNaira(o.amount_paid_kobo) })}</p>
              <p className="text-sm text-[#D7F0E2]">{t('order.confirmedLine', { n: o.order_number })}</p>
            </div>
          </section>
        )}
        {!paidInFull && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted">{formatDate(o.created_at, true)}{data.business ? ` · ${data.business.name}` : ''}</p>
            <Badge tone={isLive ? 'good' : 'neutral'}>{t(`order.status.${o.status}` as MessageKey)}</Badge>
          </div>
        )}
        {o.needs_attention === 'paid_after_expiry_out_of_stock' && (
          <p className="rounded-2xl bg-gold-50 p-4 text-sm text-gold-ink">{t('order.paidAfterExpiry')}</p>
        )}

        <section aria-labelledby="progress-h" className="rounded-[22px] border border-line/60 bg-surface p-4 pr-3 shadow-card">
          <h2 id="progress-h" className="mb-4 font-display text-lg font-extrabold">{delivery ? t('order.deliveryTo', { place: o.delivery_address?.city ?? '' }) : t('timeline.pickupTitle')}</h2>
          <Timeline steps={steps} />
        </section>

        <section aria-labelledby="items-h" className="rounded-[22px] border border-line/60 bg-surface p-4 shadow-card">
          <h2 id="items-h" className="mb-2 font-display text-lg font-extrabold">{t('timeline.products')}</h2>
          <ul className="divide-y divide-line-soft">
            {o.items.map((i: any) => (
              <li key={i.id} className="flex items-center gap-3 py-2.5">
                <span className="num flex size-9 shrink-0 items-center justify-center rounded-xl bg-line-soft text-sm font-extrabold">{i.unit_qty}×</span>
                <span className="min-w-0 flex-1 text-sm"><b className="block truncate">{i.name}</b>{i.variant_label && <span className="text-muted">{i.variant_label}</span>}</span>
                <span className="num font-semibold">{formatNaira(i.line_total_kobo)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-2 space-y-1 border-t border-line pt-3 text-[15px]">
            <div className="flex justify-between font-bold"><dt>{t('order.total')}</dt><dd className="num">{formatNaira(o.total_kobo)}</dd></div>
            {o.balance_kobo > 0 && o.amount_paid_kobo > 0 && <div className="flex justify-between font-semibold text-red-ink"><dt>{t('order.balance')}</dt><dd className="num">{formatNaira(o.balance_kobo)}</dd></div>}
          </dl>
          {data.payments.map((p, i) => <p key={i} className="mt-1 text-[13px] text-muted">{formatDate(p.received_at, true)} · {formatNaira(p.amount_kobo)}</p>)}
        </section>

        {isLive && <InvoiceLink orderId={o.id} />}
        <p className="rounded-2xl bg-indigo-50 p-4 text-sm text-indigo">{t('order.whatsappUpdates')}</p>
      </Sheet>
    </div>
  );
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' });

/** Opens the buyer's shareable invoice (issued on first request). */
function InvoiceLink({ orderId }: { orderId: string }) {
  const get = useMutation(async () => {
    const r = await api<{ token: string }>(`/api/orders/${orderId}/invoice`, { json: {} });
    hardNav(`/i/${r.token}`);
  });
  return (
    <>
      <Button variant="secondary" className="w-full" pending={get.pending} onClick={() => void get.run()}>
        <FileText className="size-5" aria-hidden />{t('order.getInvoice')}
      </Button>
      <ErrorNote error={get.error} />
    </>
  );
}
