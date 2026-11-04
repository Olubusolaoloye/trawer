import { useState, useEffect } from 'react';
import { Link, Route, Routes, useParams, useSearchParams } from 'react-router';
import { FileText, LayoutGrid, List, MessageCircle } from 'lucide-react';
import { nairaToKobo } from '@trawer/core/money';
import { api } from '../lib/api';
import { invalidate, useApi, useMutation } from '../lib/use-api';
import { cx, formatDate, formatNaira } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Select, ListSkeleton, PageSkeleton } from '../components/ui';
import { t, type MessageKey } from '../i18n';
import { useBiz } from './context';
import { DeliveryCard } from './DeliveryCard';
import { useDebounced } from '../lib/debounce';

export default function Orders() {
  return (
    <Routes>
      <Route index element={<OrderBoard />} />
      <Route path=":oid" element={<OrderDetail />} />
    </Routes>
  );
}

interface Row { id: string; order_number: number; channel: string; status: string; payment_status: string; fulfilment_status: string; total_kobo: number; balance_kobo: number; created_at: string; needs_attention: string | null; customer: string; lines: number }
const CH_LABEL: Record<string, string> = { pos: 'TILL', whatsapp: 'WHATSAPP', web: 'WEB', instagram: 'INSTAGRAM', facebook: 'FACEBOOK' };
const tone = (s: string) => (s === 'confirmed' || s === 'completed' || s === 'paid' ? 'good' : s === 'pending' || s === 'partial' || s === 'unpaid' ? 'warn' : 'neutral') as 'good' | 'warn' | 'neutral';

const COLUMNS: { id: string; title: MessageKey; box: string; head: string; match: (o: Row) => boolean }[] = [
  { id: 'await', title: 'board.awaiting', box: 'bg-gold-50', head: 'text-gold-ink', match: (o) => o.status === 'pending' },
  { id: 'pack', title: 'board.toPack', box: 'bg-green-50', head: 'text-green-ink', match: (o) => o.status === 'confirmed' && o.fulfilment_status === 'confirmed' },
  { id: 'packed', title: 'board.packed', box: 'bg-white border border-line', head: '', match: (o) => o.fulfilment_status === 'packed' },
  { id: 'way', title: 'board.onTheWay', box: 'bg-indigo-50', head: 'text-indigo', match: (o) => o.fulfilment_status === 'dispatched' },
  { id: 'done', title: 'board.done', box: 'bg-white border border-line', head: '', match: (o) => ['delivered', 'collected'].includes(o.fulfilment_status) && o.status !== 'cancelled' },
];

function OrderBoard() {
  const b = useBiz();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  // Search as you type, once typing pauses (no request per keystroke).
  const dq = useDebounced(q.trim());
  useEffect(() => {
    if (dq === (params.get('q') ?? '')) return;
    const n = new URLSearchParams(params);
    if (dq) n.set('q', dq); else n.delete('q');
    setParams(n, { replace: true });
  }, [dq]); // eslint-disable-line react-hooks/exhaustive-deps
  const view = params.get('view') ?? 'board';
  const qs = new URLSearchParams([...params].filter(([k, v]) => v && k !== 'view'));
  const { data } = useApi<{ orders: Row[] }>(`/api/biz/${b.business.id}/orders?${qs}`, { staleMs: 5_000 });
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const channel = params.get('channel') ?? '';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-[30px] font-extrabold lg:text-[34px]">{t('dash.orders')}</h1>
        <div className="flex gap-2" role="group" aria-label={t('board.view')}>
          <button type="button" aria-pressed={view === 'board'} onClick={() => set('view', '')} aria-label={t('board.boardView')} className={cx('flex size-11 items-center justify-center rounded-xl border-2', view === 'board' ? 'border-ink bg-ink text-white' : 'border-line bg-white')}><LayoutGrid className="size-5" /></button>
          <button type="button" aria-pressed={view === 'list'} onClick={() => set('view', 'list')} aria-label={t('board.listView')} className={cx('flex size-11 items-center justify-center rounded-xl border-2', view === 'list' ? 'border-ink bg-ink text-white' : 'border-line bg-white')}><List className="size-5" /></button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {['', 'whatsapp', 'web', 'pos', 'instagram'].map((c) => (
          <button key={c || 'all'} type="button" aria-pressed={channel === c} onClick={() => set('channel', c)}
            className={cx('min-h-[42px] rounded-full border-2 px-4 text-sm', channel === c ? 'border-ink bg-ink font-bold text-white' : 'border-line bg-white font-semibold')}>
            {c ? t(`channel.${c}` as MessageKey) : t('board.allChannels')}
          </button>
        ))}
        <form className="flex min-w-60 flex-1 gap-2" onSubmit={(e) => { e.preventDefault(); set('q', q); }}>
          <Input type="search" placeholder={t('board.searchPlaceholder')} aria-label={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} className="min-h-[42px]" />
        </form>
      </div>

      {!data ? <ListSkeleton /> : data.orders.length === 0 ? <Empty>{t('common.none')}</Empty> : view === 'list' ? (
        <ul className="divide-y divide-line-soft rounded-2xl border border-line/70 bg-white shadow-card">
          {data.orders.map((o) => (
            <li key={o.id} className="cv-row">
              <Link to={`${b.base}/orders/${o.id}`} className="flex min-h-16 items-center justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0"><p className="font-bold">#{o.order_number} · {o.customer}</p><p className="text-sm text-muted">{CH_LABEL[o.channel]} · {formatDate(o.created_at, true)}{o.needs_attention ? ' · ⚠' : ''}</p></div>
                <div className="text-right"><p className="num font-display font-extrabold">{formatNaira(o.total_kobo)}</p><Badge tone={tone(o.payment_status)}>{o.payment_status}</Badge></div>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 pb-2">
          <div className="grid min-w-[1150px] grid-cols-5 gap-3.5">
            {COLUMNS.map((col) => {
              const rows = data.orders.filter(col.match);
              return (
                <section key={col.id} className={cx('flex flex-col gap-2.5 rounded-[20px] p-3', col.box)}>
                  <div className={cx('flex items-center justify-between font-bold', col.head)}><span>{t(col.title)}</span><span className="font-extrabold">{rows.length}</span></div>
                  {rows.slice(0, 12).map((o) => (
                    <Link key={o.id} to={`${b.base}/orders/${o.id}`} className={cx('flex flex-col gap-1.5 rounded-[14px] bg-white p-3', o.needs_attention ? 'border-2 border-red' : col.id === 'pack' ? 'border-2 border-ink' : 'border border-line')}>
                      <div className="flex justify-between"><b>#{o.order_number}</b><span className="text-xs font-bold text-muted">{CH_LABEL[o.channel]}</span></div>
                      <span className="truncate text-sm">{o.customer} · {t(o.lines === 1 ? 'board.line' : 'board.lines', { n: o.lines })}</span>
                      <div className="flex items-center justify-between">
                        <b className="num font-display text-lg">{formatNaira(o.total_kobo)}</b>
                        {o.balance_kobo > 0 && o.status !== 'pending' && <Badge tone="bad">{t('store.owes', { amount: formatNaira(o.balance_kobo) })}</Badge>}
                      </div>
                    </Link>
                  ))}
                  {rows.length === 0 && <p className="py-4 text-center text-sm text-muted">—</p>}
                </section>
              );
            })}
          </div>
        </div>
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
    setAmount('');
    await invalidate(key);
    await invalidate(`/api/biz/${b.business.id}/`);
  });
  const cancel = useMutation(async () => { await api(`${key}/cancel`, { json: {} }); await invalidate(key); });
  if (!data) return <PageSkeleton />;
  const o = data.order;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link to={`${b.base}/orders`} className="text-sm font-bold text-muted">← {t('dash.orders')}</Link>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-[30px] font-extrabold">#{o.order_number}</h1>
        <div className="flex flex-wrap gap-1.5"><Badge tone={tone(o.status)}>{t(`order.status.${o.status}` as MessageKey)}</Badge><Badge tone={tone(o.payment_status)}>{o.payment_status}</Badge><Badge tone="info">{t(`order.fulfil.${o.fulfilment_status}` as MessageKey)}</Badge></div>
      </div>
      {o.needs_attention && <p className="rounded-2xl border-2 border-red bg-red-50 p-4 font-semibold text-red-ink">{t(`attention.${o.needs_attention.split(',')[0]}` as MessageKey)}</p>}
      <Card className="space-y-1.5 text-[15px]">
        <p><b>{t('board.customer')}:</b> {data.customer ? `${data.customer.name} · ${data.customer.phone}` : o.buyer_name ?? t('board.walkIn')}{data.customer?.wholesale_status === 'approved' && <Badge tone="wholesale" className="ml-2">{t('store.wholesaleCaps')}</Badge>}</p>
        <p><b>{t('board.channel')}:</b> {t(`channel.${o.channel}` as MessageKey)} · {o.delivery_method}</p>
        {o.delivery_address && <p><b>{t('checkout.address')}:</b> {[o.delivery_address.line1, o.delivery_address.area, o.delivery_address.city, o.delivery_address.state].filter(Boolean).join(', ')}{o.delivery_address.landmark ? ` · ${o.delivery_address.landmark}` : ''}</p>}
        {o.note && <p><b>{t('checkout.note')}:</b> {o.note}</p>}
      </Card>
      <Card className="space-y-2">
        {o.items.map((i: any) => (
          <div key={i.id} className="flex justify-between gap-3 text-[15px]">
            <span>{i.unit_qty} × {i.name}{i.variant_label ? ` (${i.variant_label})` : ''} <span className="text-sm text-muted">· {i.price_source}</span>{i.conflict_qty > 0 && <Badge tone="bad" className="ml-2">{t('board.short', { n: i.conflict_qty })}</Badge>}</span>
            <span className="num font-semibold">{formatNaira(i.line_total_kobo)}</span>
          </div>
        ))}
        <div className="flex justify-between border-t border-line pt-2 font-bold"><span>{t('order.total')}</span><span className="num">{formatNaira(o.total_kobo)}</span></div>
        <div className="flex justify-between text-sm"><span>{t('board.paid')}</span><span className="num">{formatNaira(o.amount_paid_kobo)}</span></div>
        <div className={cx('flex justify-between font-bold', o.balance_kobo > 0 && 'text-red-ink')}><span>{t('order.balance')}</span><span className="num">{formatNaira(o.balance_kobo)}</span></div>
        {data.payments.map((p: any) => <p key={p.id} className="text-sm text-muted">{formatDate(p.received_at, true)} · {t(`method.${p.method}` as MessageKey)} · {formatNaira(p.amount_kobo)}</p>)}
      </Card>
      {b.can('payments.record') && o.balance_kobo > 0 && o.status !== 'cancelled' && (
        <Card strong>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void pay.run(); }}>
            <h2 className="font-display text-xl font-extrabold">{t('board.recordPayment')}</h2>
            <div className="grid grid-cols-2 gap-2">
              <Field label={t('board.amount')} htmlFor="amt"><Input id="amt" required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={String(o.balance_kobo / 100)} /></Field>
              <Field label={t('board.method')} htmlFor="m">
                <Select id="m" value={method} onChange={(e) => setMethod(e.target.value)}>
                  {['cash', 'card_terminal', 'transfer', 'ussd', 'qr'].map((v) => <option key={v} value={v}>{t(`method.${v}` as MessageKey)}</option>)}
                </Select>
              </Field>
            </div>
            <ErrorNote error={pay.error} />
            <Button type="submit" className="w-full" pending={pay.pending}>{t('board.record')}</Button>
          </form>
        </Card>
      )}
      {o.customer_id && (o.status === 'pending' || o.status === 'confirmed' || o.status === 'completed') && <CreditCard order={o} customerName={data.customer?.business_name ?? data.customer?.name ?? ''} orderKey={key} />}
      <DeliveryCard orderId={oid} orderStatus={o.status} />
      {(o.status === 'confirmed' || o.status === 'completed') && <DocumentsCard orderId={oid} orderNumber={o.order_number} />}
      {b.can('orders.manage') && o.status === 'pending' && (
        <><ErrorNote error={cancel.error} /><Button variant="danger" className="w-full" pending={cancel.pending} onClick={() => void cancel.run()}>{t('board.cancelRelease')}</Button></>
      )}
    </div>
  );
}

const isoDay = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const plusDays = (n: number) => isoDay(new Date(Date.now() + n * 86_400_000));

/** Sell on credit (pending order) or manage the due date / reminders of a credit sale. */
function CreditCard({ order: o, customerName, orderKey }: { order: any; customerName: string; orderKey: string }) {
  const b = useBiz();
  const [due, setDue] = useState<string>(o.due_date ?? plusDays(7));
  const [note, setNote] = useState('');
  const [reminded, setReminded] = useState(false);
  const refresh = async () => { await invalidate(orderKey); void invalidate(`/api/biz/${b.business.id}/`); };
  const credit = useMutation(async () => { await api(`${orderKey}/credit`, { json: { due_date: due, note: note || undefined } }); await refresh(); });
  const setDueDate = useMutation(async () => { await api(`${orderKey}/due-date`, { json: { due_date: due } }); await refresh(); });
  const remind = useMutation(async () => { await api(`${orderKey}/remind`, { json: {} }); setReminded(true); });
  if (!b.can('credit.manage')) return null;
  const needsApproval = String(o.needs_attention ?? '').includes('credit_sale_needs_approval');

  if (!o.is_credit || needsApproval || o.status === 'pending') {
    if (o.balance_kobo <= 0) return null;
    return (
      <Card strong>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void credit.run(); }}>
          <h2 className="font-display text-xl font-extrabold">{t('credit.title')}</h2>
          <p className="text-sm text-body">{t('credit.body', { name: customerName || '—' })}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Field label={t('credit.dueDate')} htmlFor="due"><Input id="due" type="date" required min={isoDay(new Date())} value={due} onChange={(e) => setDue(e.target.value)} /></Field>
            <Field label={t('credit.note')} htmlFor="cnote"><Input id="cnote" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          </div>
          <ErrorNote error={credit.error} />
          <Button type="submit" variant="secondary" className="w-full" pending={credit.pending}>{t('credit.confirm')} · {formatNaira(o.balance_kobo)}</Button>
        </form>
      </Card>
    );
  }
  if (o.balance_kobo <= 0) return null;
  const late = o.due_date && o.due_date < isoDay(new Date());
  return (
    <Card className={cx('space-y-3', late && 'border-l-4 border-l-red')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-xl font-extrabold">{t('credit.onCredit')}</h2>
        {o.due_date && <Badge tone={late ? 'bad' : 'warn'}>{t(late ? 'doc.overdue' : 'doc.due', { date: formatDate(o.due_date) })}</Badge>}
      </div>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void setDueDate.run(); }}>
        <Field label={t('credit.changeDue')} htmlFor="due2"><Input id="due2" type="date" required value={due} onChange={(e) => setDue(e.target.value)} /></Field>
        <Button type="submit" variant="secondary" pending={setDueDate.pending}>{t('credit.save')}</Button>
      </form>
      {reminded
        ? <p className="font-bold text-green-ink">{t('debt.reminded')}</p>
        : <Button variant="secondary" onClick={() => void remind.run()} pending={remind.pending}><MessageCircle className="size-4" aria-hidden />{t('debt.remind')}</Button>}
      <ErrorNote error={setDueDate.error ?? remind.error} />
    </Card>
  );
}

interface DocRow { kind: 'invoice' | 'receipt'; number: string; token: string; issued_at: string }

/** Invoice + receipts for the order, with view / PDF / WhatsApp share. */
function DocumentsCard({ orderId, orderNumber }: { orderId: string; orderNumber: number }) {
  const b = useBiz();
  const key = `/api/biz/${b.business.id}/orders/${orderId}/documents`;
  const { data } = useApi<{ documents: DocRow[] }>(key);
  const make = useMutation(async () => { await api(`/api/biz/${b.business.id}/orders/${orderId}/invoice`, { json: {} }); await invalidate(key); });
  if (!data) return null;
  const hasInvoice = data.documents.some((d) => d.kind === 'invoice');
  const share = (d: DocRow) => {
    const url = `${location.origin}/i/${d.token}`;
    const text = t('docs.shareText', { shop: b.business.name, kind: t(`doc.${d.kind}` as MessageKey), number: d.number, url });
    return `https://wa.me/?text=${encodeURIComponent(text)}`;
  };
  return (
    <Card className="space-y-3">
      <h2 className="font-display text-xl font-extrabold">{t('docs.title')}</h2>
      <ul className="divide-y divide-line-soft">
        {data.documents.map((d) => (
          <li key={d.token} className="flex flex-wrap items-center gap-2 py-2.5">
            <FileText className="size-5 text-muted" aria-hidden />
            <span className="flex-1"><b className="num">{d.number}</b> <span className="text-sm text-muted">· {t(`doc.${d.kind}` as MessageKey)} · {formatDate(d.issued_at)}</span></span>
            <a href={`/i/${d.token}`} target="_blank" rel="noopener" className="text-sm font-bold underline" aria-label={`${t('docs.view')} ${d.number}`}>{t('docs.view')}</a>
            <a href={`/api/docs/${d.token}/pdf`} target="_blank" rel="noopener" className="text-sm font-bold underline" aria-label={`${t('docs.pdf')} ${d.number}`}>{t('docs.pdf')}</a>
            <a href={share(d)} target="_blank" rel="noopener" className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-green px-3 text-sm font-bold text-white" aria-label={`${t('docs.share')} ${d.number}`}>
              <MessageCircle className="size-4" aria-hidden />{t('docs.share')}
            </a>
          </li>
        ))}
      </ul>
      {!hasInvoice && <Button variant="secondary" onClick={() => void make.run()} pending={make.pending} aria-label={`${t('docs.makeInvoice')} #${orderNumber}`}>{t('docs.makeInvoice')}</Button>}
      <ErrorNote error={make.error} />
    </Card>
  );
}
