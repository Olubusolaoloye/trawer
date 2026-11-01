import { useState } from 'react';
import { Link, Route, Routes, useParams } from 'react-router';
import { MessageCircle } from 'lucide-react';
import { api } from '../lib/api';
import { useApi, useMutation } from '../lib/use-api';
import { cx, formatDate, formatNaira } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, Spinner } from '../components/ui';
import { t, type MessageKey } from '../i18n';
import { useBiz } from './context';

interface Report {
  total_kobo: number;
  overdue_kobo: number;
  aging: { not_due: number; d1_30: number; d31_60: number; d60_plus: number };
  customers: { id: string; name: string; business_name: string | null; phone: string; credit_limit_kobo: number; owing_kobo: number; overdue_kobo: number | null; oldest_due: string | null; max_days_late: number; open_orders: number; last_payment_at: string | null }[];
  orders: { id: string; customer_id: string; order_number: number; balance_kobo: number; due_date: string | null; days_late: number }[];
}

export default function Debtors() {
  return (
    <Routes>
      <Route index element={<Book />} />
      <Route path=":cid" element={<Statement />} />
    </Routes>
  );
}

const BUCKETS = [
  { k: 'not_due', label: 'debt.notDue', bar: 'bg-green' },
  { k: 'd1_30', label: 'debt.d1_30', bar: 'bg-gold' },
  { k: 'd31_60', label: 'debt.d31_60', bar: 'bg-[#E0701B]' },
  { k: 'd60_plus', label: 'debt.d60_plus', bar: 'bg-red' },
] as const;

function Book() {
  const b = useBiz();
  const { data, error } = useApi<Report>(`/api/biz/${b.business.id}/debtors`);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const remind = useMutation(async (orderId: string) => {
    setBusy(orderId);
    try {
      await api(`/api/biz/${b.business.id}/orders/${orderId}/remind`, { json: {} });
      setSent((s) => new Set(s).add(orderId));
    } finally { setBusy(null); }
  });
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Spinner />;
  const max = Math.max(1, ...BUCKETS.map((x) => data.aging[x.k]));

  return (
    <div className="space-y-5">
      <h1 className="font-display text-[30px] font-extrabold lg:text-[34px]">{t('debt.title')}</h1>

      <section className="grid gap-3 sm:grid-cols-[1fr_1.4fr]">
        <div className="space-y-3 rounded-3xl bg-ink p-5 text-white">
          <div>
            <p className="text-sm font-semibold text-[#C9C3B6]">{t('debt.total')}</p>
            <p className="num font-display text-[40px] font-extrabold leading-none tracking-tight">{formatNaira(data.total_kobo)}</p>
          </div>
          <div>
            <p className="text-sm font-semibold text-[#C9C3B6]">{t('debt.overdue')}</p>
            <p className={cx('num font-display text-2xl font-extrabold', data.overdue_kobo > 0 ? 'text-[#FF8A7F]' : 'text-white')}>{formatNaira(data.overdue_kobo)}</p>
          </div>
        </div>
        <Card>
          <ul className="space-y-3" aria-label={t('debt.title')}>
            {BUCKETS.map((x) => (
              <li key={x.k}>
                <div className="flex justify-between text-sm"><span className="font-semibold">{t(x.label as MessageKey)}</span><span className="num font-bold">{formatNaira(data.aging[x.k])}</span></div>
                <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-line-soft" aria-hidden>
                  <div className={cx('h-full rounded-full', x.bar)} style={{ width: `${(data.aging[x.k] / max) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      {data.customers.length === 0 ? <Empty>{t('debt.none')}</Empty> : (
        <ul className="space-y-3">
          {data.customers.map((c) => {
            const orders = data.orders.filter((o) => o.customer_id === c.id);
            const late = (c.overdue_kobo ?? 0) > 0;
            return (
              <li key={c.id}>
                <Card className={cx('space-y-3', late && 'border-l-4 border-l-red')}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-bold">{c.business_name ?? c.name}</p>
                      <p className="text-sm text-muted">{c.business_name ? `${c.name} · ` : ''}{c.last_payment_at ? t('debt.lastPaid', { date: formatDate(c.last_payment_at) }) : t('debt.neverPaid')}</p>
                    </div>
                    <div className="text-right">
                      <p className="num font-display text-2xl font-extrabold">{formatNaira(c.owing_kobo)}</p>
                      {late && <Badge tone="bad">{t('debt.daysLate', { n: c.max_days_late })}</Badge>}
                    </div>
                  </div>
                  <ul className="divide-y divide-line-soft text-sm">
                    {orders.map((o) => (
                      <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <Link to={`${b.base}/orders/${o.id}`} className="font-semibold underline-offset-2 hover:underline">#{o.order_number}</Link>
                        <span className={cx('text-muted', o.due_date && o.days_late > 0 && 'font-semibold text-red-ink')}>
                          {o.due_date ? (o.days_late > 0 ? t('debt.daysLate', { n: o.days_late }) : t('debt.dueOn', { date: formatDate(o.due_date) })) : t('debt.noDueDate')}
                        </span>
                        <span className="num font-bold">{formatNaira(o.balance_kobo)}</span>
                        {b.can('credit.manage') && (
                          sent.has(o.id)
                            ? <span className="text-sm font-bold text-green-ink">{t('debt.reminded')}</span>
                            : <Button size="sm" variant="secondary" onClick={() => void remind.run(o.id)} pending={busy === o.id}><MessageCircle className="size-4" aria-hidden />{t('debt.remind')}</Button>
                        )}
                      </li>
                    ))}
                  </ul>
                  <Link to={c.id} className="inline-block text-sm font-bold underline">{t('debt.statement')} →</Link>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
      <ErrorNote error={remind.error} />
    </div>
  );
}

interface StatementData {
  customer: { id: string; name: string; business_name: string | null; credit_limit_kobo: number };
  entries: { created_at: string; kind: 'charge' | 'payment' | 'adjustment'; amount_kobo: number; due_date: string | null; note: string | null; order_number: number | null; running_kobo: number }[];
}

function Statement() {
  const b = useBiz();
  const { cid = '' } = useParams();
  const { data, error } = useApi<StatementData>(`/api/biz/${b.business.id}/customers/${cid}/statement`);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Spinner />;
  const balance = data.entries.at(-1)?.running_kobo ?? 0;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link to={`${b.base}/debtors`} className="text-sm font-bold text-muted">← {t('debt.title')}</Link>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[30px] font-extrabold">{data.customer.business_name ?? data.customer.name}</h1>
          <p className="text-sm text-muted">{t('debt.statement')}{data.customer.credit_limit_kobo > 0 ? ` · ${t('debt.limit', { amount: formatNaira(data.customer.credit_limit_kobo) })}` : ''}</p>
        </div>
        <p className={cx('num font-display text-3xl font-extrabold', balance > 0 && 'text-red-ink')}>{formatNaira(balance)}</p>
      </div>
      {data.entries.length === 0 ? <Empty>{t('debt.noEntries')}</Empty> : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="bg-paper text-left text-xs uppercase tracking-wider text-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5">{t('debt.date')}</th>
                <th scope="col" className="px-2 py-2.5">{t('debt.entry')}</th>
                <th scope="col" className="px-2 py-2.5 text-right">{t('doc.amount')}</th>
                <th scope="col" className="px-4 py-2.5 text-right">{t('debt.runningBalance')}</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="whitespace-nowrap px-4 py-2.5">{formatDate(e.created_at)}</td>
                  <td className="px-2 py-2.5">{t(`debt.kind.${e.kind}` as MessageKey)}{e.order_number ? ` · #${e.order_number}` : ''}{e.note ? <span className="block text-xs text-muted">{e.note}</span> : null}</td>
                  <td className={cx('num whitespace-nowrap px-2 py-2.5 text-right font-semibold', e.amount_kobo < 0 && 'text-green-ink')}>{e.amount_kobo < 0 ? '−' : ''}{formatNaira(Math.abs(e.amount_kobo))}</td>
                  <td className="num whitespace-nowrap px-4 py-2.5 text-right font-bold">{formatNaira(e.running_kobo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
