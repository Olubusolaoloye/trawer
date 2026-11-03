import { useState } from 'react';
import { Link, Navigate } from 'react-router';
import { ChevronRight, Package, ReceiptText } from 'lucide-react';
import { useApi } from '../lib/use-api';
import { cx, formatDate, formatNaira } from '../lib/format';
import { useStoreLocation } from '../lib/store-context';
import { Empty, Skeleton } from '../components/ui';
import { t, type MessageKey } from '../i18n';
import { AppBar, PillTabs, Sheet } from './kit';

interface Row { id: string; order_number: number; status: string; payment_status: string; fulfilment_status: string; total_kobo: number; balance_kobo: number; channel: string; created_at: string }
type Filter = 'all' | 'pay' | 'active' | 'done';

const owes = (o: Row) => o.balance_kobo > 0 && !['pending', 'expired', 'cancelled'].includes(o.status);
const group = (o: Row): Exclude<Filter, 'all'> | null =>
  o.status === 'pending' || owes(o) ? 'pay'
    : ['delivered', 'collected'].includes(o.fulfilment_status) || o.status === 'completed' ? 'done'
    : o.status === 'confirmed' ? 'active' : null;

export function OrdersPage() {
  const { slug, href } = useStoreLocation();
  const me = useApi<{ user: unknown }>('/api/auth/me');
  const { data, error } = useApi<{ orders: Row[] }>(me.data?.user ? `/api/store/${slug}/orders` : null);
  const [filter, setFilter] = useState<Filter>('all');
  if (me.data && !me.data.user) return <Navigate to={href('/account?next=/orders')} replace />;
  const rows = (data?.orders ?? []).filter((o) => filter === 'all' || group(o) === filter);
  const n = (f: Filter) => (data?.orders ?? []).filter((o) => f === 'all' || group(o) === f).length;

  return (
    <div className="flex flex-1 flex-col">
      <AppBar title={t('store.orders')} back={href('/')} />
      <Sheet className="px-4 pb-8">
        <PillTabs label={t('orders.filter')} value={filter} onChange={setFilter} className="mb-4"
          options={(['all', 'pay', 'active', 'done'] as const).map((f) => ({ value: f, label: <>{t(`orders.tab.${f}` as MessageKey)}{data ? <span className="ml-1.5 text-xs opacity-70">{n(f)}</span> : null}</> }))} />
        {error ? <Empty>{t('error.register_first')}</Empty> : !data ? (
          <div className="space-y-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[84px] rounded-[22px]" />)}</div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-14 text-center">
            <span className="flex size-16 items-center justify-center rounded-full bg-accent-soft"><ReceiptText className="size-7 text-accent-text" aria-hidden /></span>
            <p className="text-muted">{t('common.none')}</p>
          </div>
        ) : (
          <ul className="space-y-3">
            {rows.map((o) => {
              const g = group(o);
              const tone = g === 'pay' ? 'bg-gold-50 text-gold-ink' : g === 'done' ? 'bg-green-50 text-green-ink' : g === 'active' ? 'bg-indigo-50 text-indigo' : 'bg-line-soft text-body';
              return (
                <li key={o.id}>
                  <Link to={href(`/orders/${o.id}`)} className="press flex items-center gap-3 rounded-[22px] border border-line/60 bg-surface p-3 shadow-card">
                    <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-line-soft"><Package className="size-6 text-body" aria-hidden /></span>
                    <span className="min-w-0 flex-1">
                      <b className="block">{t('order.title', { n: o.order_number })}</b>
                      <span className="text-sm text-muted">{formatDate(o.created_at)}</span>
                    </span>
                    <span className="flex flex-col items-end gap-1">
                      <span className="num font-display text-lg font-extrabold">{formatNaira(o.total_kobo)}</span>
                      <span className={cx('rounded-full px-2.5 py-0.5 text-xs font-bold', tone)}>
                        {owes(o) ? t('store.owes', { amount: formatNaira(o.balance_kobo) })
                          : g === 'active' ? t(`order.fulfil.${o.fulfilment_status}` as MessageKey) : t(`order.status.${o.status}` as MessageKey)}
                      </span>
                    </span>
                    <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Sheet>
    </div>
  );
}
