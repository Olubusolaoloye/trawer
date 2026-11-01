import { Link } from 'react-router';
import { useApi } from '../lib/use-api';
import { cart } from '../lib/cart';
import { useStoreLocation } from '../lib/store-context';
import { Button, Card } from '../components/ui';
import { t } from '../i18n';

/** Wholesale view: one tap to put the usual order back in the cart. */
export function ReorderStrip() {
  const { slug, href } = useStoreLocation();
  const { data } = useApi<{ items: { variant_id: string; unit_id: string; name: string; variant_label: string | null; usual_qty: number }[] }>(`/api/store/${slug}/reorder`);
  if (!data?.items.length) return null;
  const items = data.items.slice(0, 8);
  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-bold">{t('store.reorderTitle')}</h2>
        <Button size="sm" onClick={() => items.forEach((i) => cart.add(slug, { variant_id: i.variant_id, unit_id: i.unit_id, qty: i.usual_qty, product_id: '', name: i.name, label: i.variant_label }))}>
          {t('store.reorder')}
        </Button>
      </div>
      <ul className="space-y-1 text-sm text-stone-700">
        {items.map((i) => <li key={`${i.variant_id}:${i.unit_id}`}>{i.usual_qty} × {i.name}{i.variant_label ? ` (${i.variant_label})` : ''}</li>)}
      </ul>
      <Link to={href('/cart')} className="text-sm font-semibold underline">{t('cart.title')}</Link>
    </Card>
  );
}
