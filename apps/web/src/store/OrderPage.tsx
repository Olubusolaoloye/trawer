import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { CheckCircle2, Copy } from 'lucide-react';
import { api } from '../lib/api';
import { invalidate, useApi, useMutation } from '../lib/use-api';
import { formatDate, formatNaira } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, Spinner } from '../components/ui';
import { t, type MessageKey } from '../i18n';

interface OrderView {
  order: any;
  virtual_account: { account_number: string; account_name: string; bank_name: string } | null;
  payments: { method: string; amount_kobo: number; received_at: string }[];
  sandbox?: boolean;
}

/** Live order status over Server-Sent Events (falls back to polling if SSE is blocked). */
function useLiveOrder(id: string) {
  const initial = useApi<OrderView>(`/api/orders/${id}`);
  const [live, setLive] = useState<OrderView | null>(null);
  useEffect(() => {
    let es: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    try {
      es = new EventSource(`/api/orders/${id}/events`);
      es.addEventListener('order', (e) => setLive(JSON.parse((e as MessageEvent).data)));
      es.onerror = () => {
        es?.close();
        if (!poll) poll = setInterval(() => void api<OrderView>(`/api/orders/${id}`).then(setLive).catch(() => undefined), 5000);
      };
    } catch {
      poll = setInterval(() => void api<OrderView>(`/api/orders/${id}`).then(setLive).catch(() => undefined), 5000);
    }
    return () => { es?.close(); if (poll) clearInterval(poll); };
  }, [id]);
  return { data: live ?? initial.data, error: initial.error };
}

export function OrderPage() {
  const { id = '' } = useParams();
  const { data, error } = useLiveOrder(id);
  const [copied, setCopied] = useState(false);
  const cancel = useMutation(async () => { await api(`/api/orders/${id}/cancel`, { json: {} }); invalidate(`/api/orders/${id}`); });
  const simulate = useMutation(async () => { await api('/api/dev/simulate-transfer', { json: { order_id: id } }); });

  if (error) return <Empty>Order not found.</Empty>;
  if (!data) return <Spinner />;
  const o = data.order;
  const paid = o.payment_status === 'paid';
  const timeline = ['confirmed', 'packed', 'dispatched', 'delivered'];
  const step = timeline.indexOf(o.fulfilment_status);

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t('order.title', { n: o.order_number })}</h1>
        <Badge tone={o.status === 'pending' ? 'warn' : o.status === 'confirmed' || o.status === 'completed' ? 'good' : 'neutral'}>{t(`order.status.${o.status}` as MessageKey)}</Badge>
      </div>

      {o.status === 'pending' && o.balance_kobo > 0 && data.virtual_account && (
        <Card className="space-y-3 border-2 border-brand">
          <h2 className="text-lg font-bold">{t('order.payTitle')}</h2>
          <p>{t('order.payBody', { amount: formatNaira(o.balance_kobo) })}</p>
          <dl className="space-y-2 rounded-xl bg-stone-50 p-3">
            <div className="flex items-center justify-between gap-2">
              <div><dt className="text-xs text-stone-600">{t('order.accountNumber')}</dt><dd className="text-2xl font-extrabold tracking-wider">{data.virtual_account.account_number}</dd></div>
              <Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(data.virtual_account!.account_number); setCopied(true); }}>
                <Copy className="size-4" aria-hidden />{copied ? t('order.copied') : t('order.copy')}
              </Button>
            </div>
            <div><dt className="text-xs text-stone-600">{t('order.bank')}</dt><dd className="font-semibold">{data.virtual_account.bank_name}</dd></div>
            <div><dt className="text-xs text-stone-600">{t('order.accountName')}</dt><dd className="font-semibold">{data.virtual_account.account_name}</dd></div>
          </dl>
          {o.reservation_expires_at && <p className="text-sm text-stone-600">{t('order.expires', { time: formatDate(o.reservation_expires_at, true) })}</p>}
          <p className="sr-only" aria-live="polite">{o.payment_status}</p>
          {data.sandbox && <Button variant="secondary" className="w-full" pending={simulate.pending} onClick={() => void simulate.run()}>{t('order.simulate')}</Button>}
        </Card>
      )}

      {paid && (
        <Card className="flex items-center gap-3 bg-emerald-50" >
          <CheckCircle2 className="size-8 text-emerald-700" aria-hidden />
          <p className="font-semibold text-emerald-900" role="status">{t('order.paid')}</p>
        </Card>
      )}

      {(o.status === 'confirmed' || o.status === 'completed') && o.delivery_method === 'delivery' && (
        <Card>
          <ol className="grid grid-cols-4 gap-1 text-center text-xs font-semibold">
            {timeline.map((s, i) => (
              <li key={s} className={i <= step ? 'text-stone-900' : 'text-stone-400'}>
                <span className={`mx-auto mb-1 block h-2 rounded-full ${i <= step ? 'bg-brand' : 'bg-stone-200'}`} />
                {t(`order.fulfil.${s}` as MessageKey)}
              </li>
            ))}
          </ol>
        </Card>
      )}

      <Card className="space-y-2">
        {o.items.map((i: any) => (
          <div key={i.id} className="flex justify-between gap-3 text-sm">
            <span>{i.unit_qty} × {i.name}{i.variant_label ? ` (${i.variant_label})` : ''}</span>
            <span className="font-semibold">{formatNaira(i.line_total_kobo)}</span>
          </div>
        ))}
        <div className="flex justify-between border-t pt-2 font-bold"><span>{t('order.total')}</span><span>{formatNaira(o.total_kobo)}</span></div>
        {o.balance_kobo > 0 && o.amount_paid_kobo > 0 && <div className="flex justify-between text-sm"><span>{t('order.balance')}</span><span>{formatNaira(o.balance_kobo)}</span></div>}
      </Card>

      {o.status === 'pending' && o.amount_paid_kobo === 0 && (
        <>
          <ErrorNote error={cancel.error} />
          <Button variant="ghost" className="w-full" pending={cancel.pending} onClick={() => void cancel.run()}>{t('order.cancel')}</Button>
        </>
      )}
    </div>
  );
}
