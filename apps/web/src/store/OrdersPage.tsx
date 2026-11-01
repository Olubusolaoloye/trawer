import { Link, Navigate } from 'react-router';
import { useApi } from '../lib/use-api';
import { formatDate, formatNaira } from '../lib/format';
import { useStoreLocation } from '../lib/store-context';
import { Badge, Card, Empty, Spinner } from '../components/ui';
import { t, type MessageKey } from '../i18n';

export function OrdersPage() {
  const { slug, href } = useStoreLocation();
  const me = useApi<{ user: unknown }>('/api/auth/me');
  const { data, error } = useApi<{ orders: any[] }>(me.data?.user ? `/api/store/${slug}/orders` : null);
  if (me.data && !me.data.user) return <Navigate to={href('/account?next=/orders')} replace />;
  if (error) return <Empty>{t('error.register_first')}</Empty>;
  if (!data) return <Spinner />;
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold">{t('store.orders')}</h1>
      {data.orders.length === 0 && <Empty>{t('common.none')}</Empty>}
      {data.orders.map((o) => (
        <Link key={o.id} to={href(`/orders/${o.id}`)} className="block">
          <Card className="flex items-center justify-between gap-3">
            <div>
              <p className="font-bold">#{o.order_number}</p>
              <p className="text-sm text-stone-600">{formatDate(o.created_at)}</p>
            </div>
            <div className="text-right">
              <p className="font-bold">{formatNaira(o.total_kobo)}</p>
              <Badge tone={o.status === 'confirmed' || o.status === 'completed' ? 'good' : o.status === 'pending' ? 'warn' : 'neutral'}>{t(`order.status.${o.status}` as MessageKey)}</Badge>
            </div>
          </Card>
        </Link>
      ))}
    </div>
  );
}
