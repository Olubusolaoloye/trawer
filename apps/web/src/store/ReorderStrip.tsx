import { Link, useNavigate } from 'react-router';
import { useApi } from '../lib/use-api';
import { cart } from '../lib/cart';
import { formatNaira, cx } from '../lib/format';
import { useStoreLocation } from '../lib/store-context';
import { t } from '../i18n';
import { useStore } from './StoreLayout';

interface UsualLine { variant_id: string; unit_id: string; name: string; variant_label: string | null; usual_qty: number; unit_name: string | null; factor: number | null; unit_price_kobo: number; available: number }

/** Wholesale home: the usual order in one tap, plus what they owe. */
export function ReorderCard() {
  const { slug, href } = useStoreLocation();
  const navigate = useNavigate();
  const me = useStore().data?.me;
  const { data } = useApi<{ items: UsualLine[] }>(`/api/store/${slug}/reorder`);
  const items = (data?.items ?? []).slice(0, 5).map((i) => {
    const factor = i.factor ?? 1;
    const canUnits = Math.floor((i.available ?? 0) / factor);
    const qty = Math.min(i.usual_qty, canUnits);
    return { ...i, factor, qty, short: qty < i.usual_qty, total: qty * factor * i.unit_price_kobo };
  });
  const sellable = items.filter((i) => i.qty > 0);
  const total = sellable.reduce((s, i) => s + i.total, 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-[15px] text-muted">{t('store.welcomeBack')}</span>
        <span className="font-display text-[26px] font-extrabold leading-tight">{me?.business_name ?? me?.name}</span>
      </div>
      {sellable.length > 0 && (
        <section className="space-y-3 rounded-[22px] border-2 border-indigo bg-surface p-4">
          <div className="flex items-baseline justify-between">
            <h2 className="font-display text-[21px] font-extrabold">{t('store.reorderTitle')}</h2>
          </div>
          <ul className="space-y-2 text-[15px]">
            {items.map((i) => (
              <li key={`${i.variant_id}:${i.unit_id}`} className={cx('flex justify-between gap-3', i.short && '-mx-2.5 rounded-xl bg-gold-50 px-2.5 py-2')}>
                <span>
                  {i.short ? <b>{i.usual_qty} → {i.qty}</b> : i.qty} {i.unit_name ?? ''} · {i.name}{i.variant_label ? `, ${i.variant_label}` : ''}
                  {i.short && <span className="block text-[13px] text-gold-ink">{i.qty === 0 ? t('store.outToday') : t('store.onlyLeft', { n: i.qty, unit: i.unit_name ?? '' })}</span>}
                </span>
                <b className="num whitespace-nowrap">{i.qty > 0 ? formatNaira(i.total) : '—'}</b>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => {
            for (const i of sellable) cart.add(slug, { variant_id: i.variant_id, unit_id: i.factor > 1 ? i.unit_id : undefined, qty: i.qty, product_id: '', name: i.name, label: i.variant_label, unit_name: i.unit_name ?? undefined });
            navigate(href('/cart'));
          }} className="flex min-h-[58px] w-full items-center justify-between rounded-2xl bg-indigo px-5 font-bold text-white">
            <span className="text-[17px]">{t('store.reorderAll')}</span>
            <span className="num font-display text-[21px] font-extrabold">{formatNaira(total)}</span>
          </button>
          {me?.account_number && <p className="text-center text-[13px] text-body">{t('store.sameAccount', { n: me.account_number })}</p>}
        </section>
      )}
      {me && me.owing_kobo > 0 && (
        <section className="flex items-center gap-3 rounded-2xl bg-red-50 p-3.5">
          <div className="flex flex-1 flex-col gap-0.5">
            <b className="text-base">{t('store.youOwe', { amount: formatNaira(me.owing_kobo) })}</b>
            {me.oldest_owing_order && <span className="text-[13px] text-body">{t('store.fromOrder', { n: me.oldest_owing_order })}</span>}
          </div>
          <Link to={href('/orders')} className="flex min-h-[46px] items-center rounded-xl bg-ink px-4 text-[15px] font-bold text-paper">{t('store.payNow')}</Link>
        </section>
      )}
    </div>
  );
}
