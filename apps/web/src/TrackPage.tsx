import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { Check } from 'lucide-react';
import { api } from './lib/api';
import { formatDate, formatNaira, cx } from './lib/format';
import { Empty, Spinner } from './components/ui';
import { t, type MessageKey } from './i18n';

interface Track {
  order: { order_number: number; status: string; payment_status: string; fulfilment_status: string; delivery_method: string; total_kobo: number; balance_kobo: number; created_at: string; confirmed_at: string | null; shop: string; slug: string; brand_colour: string };
  items: { name: string; variant_label: string | null; unit_qty: number; unit: string }[];
}

/** Public order tracking (link sent on WhatsApp). No sign-in, no personal details. */
export default function TrackPage() {
  const { token = '' } = useParams();
  const [data, setData] = useState<Track | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const load = () => api<Track>(`/api/track/${token}`).then(setData).catch(() => setMissing(true));
    void load();
    const i = setInterval(load, 30_000);
    return () => clearInterval(i);
  }, [token]);
  if (missing) return <Empty>{t('track.notFound')}</Empty>;
  if (!data) return <Spinner />;
  const o = data.order;
  const steps = o.delivery_method === 'delivery' ? ['confirmed', 'packed', 'dispatched', 'delivered'] : ['confirmed', 'packed', 'collected'];
  const at = o.status === 'pending' ? -1 : Math.max(steps.indexOf(o.fulfilment_status), 0);
  return (
    <main className="mx-auto min-h-dvh max-w-md bg-paper">
      <header className="px-5 pb-6 pt-6 text-white" style={{ background: o.brand_colour }}>
        <p className="text-sm font-semibold opacity-90">{o.shop}</p>
        <h1 className="font-display text-3xl font-extrabold">{t('order.title', { n: o.order_number })}</h1>
        <p className="mt-1 text-sm opacity-90">{formatDate(o.created_at, true)}</p>
      </header>
      <div className="space-y-5 px-5 py-6">
        {o.status === 'pending' && <p className="rounded-2xl bg-gold-50 p-4 font-semibold text-gold-ink">{t('track.awaitingPayment', { amount: formatNaira(o.balance_kobo) })}</p>}
        {(o.status === 'cancelled' || o.status === 'expired') && <p className="rounded-2xl bg-line-soft p-4 font-semibold">{t(`order.status.${o.status}` as MessageKey)}</p>}
        <ol aria-label={t('track.progress')}>
          {steps.map((s, i) => (
            <li key={s} className="flex gap-3.5">
              <div className="flex w-7 flex-col items-center">
                <span className={cx('flex size-7 items-center justify-center rounded-full', i <= at ? 'bg-green' : i === at + 1 ? 'border-4 border-indigo bg-white' : 'border-[3px] border-line bg-white')}>
                  {i <= at && <Check className="size-3.5 text-white" strokeWidth={3.4} aria-hidden />}
                </span>
                {i < steps.length - 1 && <span className={cx('min-h-7 w-[3px] flex-1', i < at ? 'bg-green' : 'bg-line')} />}
              </div>
              <b className={cx('pb-5', i > at && 'text-muted', i === at + 1 && 'text-indigo')}>{t(`order.fulfil.${s}` as MessageKey)}</b>
            </li>
          ))}
        </ol>
        <section className="space-y-1.5 rounded-2xl border border-line bg-white p-4 text-sm">
          {data.items.map((i, k) => <p key={k}>{i.unit_qty} {i.unit} · {i.name}{i.variant_label ? ` (${i.variant_label})` : ''}</p>)}
          <p className="border-t border-line pt-2 font-bold">{t('order.total')}: <span className="num">{formatNaira(o.total_kobo)}</span></p>
        </section>
        <a href={`/s/${o.slug}`} className="block text-center font-bold underline">{t('track.visitShop', { shop: o.shop })}</a>
      </div>
    </main>
  );
}
