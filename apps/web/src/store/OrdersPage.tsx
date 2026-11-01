import { Link, Navigate } from 'react-router';
import { useApi } from '../lib/use-api';
import { formatDate, formatNaira } from '../lib/format';
import { useStoreLocation } from '../lib/store-context';
import { Badge, Empty, Spinner } from '../components/ui';
import { t, type MessageKey } from '../i18n';
import { PageHeader } from './PageHeader';

export function OrdersPage() {
  const { slug, href } = useStoreLocation();
  const me = useApi<{ user: unknown }>('/api/auth/me');
  const { data, error } = useApi<{ orders: any[] }>(me.data?.user ? `/api/store/${slug}/orders` : null);
  if (me.data && !me.data.user) return <Navigate to={href('/account?next=/orders')} replace />;
  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title={t('store.orders')} back={href('/')} />
      <div className="space-y-3 px-4 pb-8">
        {error ? <Empty>{t('error.register_first')}</Empty> : !data ? <Spinner /> : data.orders.length === 0 ? <Empty>{t('common.none')}</Empty> : data.orders.map((o) => (
          <Link key={o.id} to={href(`/orders/${o.id}`)} className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-white p-4">
            <div>
              <p className="font-bold">#{o.order_number}</p>
              <p className="text-sm text-muted">{formatDate(o.created_at)}</p>
            </div>
            <div className="flex flex-col items-end gap-1">
              <p className="num font-display text-lg font-extrabold">{formatNaira(o.total_kobo)}</p>
              {o.balance_kobo > 0 && o.status !== 'pending' && o.status !== 'expired' && o.status !== 'cancelled'
                ? <Badge tone="bad">{t('store.owes', { amount: formatNaira(o.balance_kobo) })}</Badge>
                : <Badge tone={o.status === 'confirmed' || o.status === 'completed' ? 'good' : o.status === 'pending' ? 'warn' : 'neutral'}>{t(`order.status.${o.status}` as MessageKey)}</Badge>}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
