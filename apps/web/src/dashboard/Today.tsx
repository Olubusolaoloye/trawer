import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight, ChartColumn, HandCoins, Megaphone, MonitorSmartphone, Palette, Settings } from 'lucide-react';
import { useApi } from '../lib/use-api';
import { cx, formatNaira } from '../lib/format';
import { Badge, StatusPill, PageSkeleton } from '../components/ui';
import { setLocale, t, type MessageKey } from '../i18n';
import { useBiz } from './context';

interface TodayData {
  taken_today_kobo: number; taken_same_day_last_week_kobo: number; sales_today_kobo: number; profit_today_kobo: number | null;
  orders_today: number; to_pack: number; on_the_way: number; awaiting_transfer: number; owed_kobo: number; late_kobo: number;
  by_channel: Record<string, number>; by_hour: { hour: number; channel: string; total: number }[];
  needs_you: { whatsapp_handoffs?: number; wholesale_pending: number; wholesale_first: string | null; unplaced_payments: number; unplaced_kobo: number; conflicts: number; conflict_first: string | null; low_stock: number; low_first: string | null; attention_orders: number };
  live_orders: { id: string; order_number: number; channel: string; status: string; payment_status: string; total_kobo: number; customer: string }[];
  best_sellers: { name: string; qty: number }[];
  tills: { id: string; name: string; last_sync_at: string | null }[];
}

const short = (k: number) => (k >= 100_000_000 ? `₦${(k / 100_000_000).toFixed(2)}m` : k >= 100_000 ? `₦${Math.round(k / 100_000)}k` : formatNaira(k));
const CH: Record<string, { label: string; colour: string }> = {
  // Same validated channel colours as Reports (every channel its own hue, always with a label).
  web: { label: 'Web', colour: 'bg-[#2a78d6]' }, pos: { label: 'Till', colour: 'bg-[#eb6834]' }, whatsapp: { label: 'WhatsApp', colour: 'bg-[#1baf7a]' },
  instagram: { label: 'Instagram', colour: 'bg-[#e87ba4]' }, facebook: { label: 'Facebook', colour: 'bg-[#6250d6]' },
};

function greeting(): MessageKey {
  const h = Number(new Date().toLocaleString('en-NG', { hour: 'numeric', hour12: false, timeZone: 'Africa/Lagos' }));
  return h < 12 ? 'dash.goodMorning' : h < 17 ? 'dash.goodAfternoon' : 'dash.goodEvening';
}

export default function Today() {
  const b = useBiz();
  const { data } = useApi<TodayData>(`/api/biz/${b.business.id}/today`, { staleMs: 20_000 });
  const [pidgin, setPidgin] = useState(() => { try { return localStorage.getItem('trawer:locale') === 'pcm'; } catch { return false; } });
  if (!data) return <PageSkeleton />;
  const n = data.needs_you;
  const change = data.taken_same_day_last_week_kobo > 0 ? Math.round(((data.taken_today_kobo - data.taken_same_day_last_week_kobo) / data.taken_same_day_last_week_kobo) * 100) : null;
  const hours = Array.from({ length: 11 }, (_, i) => 8 + i);
  const maxHour = Math.max(1, ...hours.map((h) => data.by_hour.filter((x) => x.hour === h).reduce((s, x) => s + x.total, 0)));
  const needs = [
    (n.whatsapp_handoffs ?? 0) > 0 && { tone: 'border-2 border-green', title: t('dash.chatsWaiting', { n: n.whatsapp_handoffs ?? 0 }), body: t('dash.chatsWaitingBody'), cta: t('dash.open'), to: 'settings#whatsapp', btn: 'bg-green text-white' },
    n.wholesale_pending > 0 && { tone: 'border-2 border-indigo', title: t(n.wholesale_pending === 1 ? 'dash.waitingWholesaleOne' : 'dash.waitingWholesale', { n: n.wholesale_pending }), body: n.wholesale_first ?? '', cta: t('dash.review'), to: 'customers?pending=1', btn: 'bg-indigo text-white' },
    n.unplaced_payments > 0 && { tone: 'border-2 border-red', title: t('dash.unplaced', { amount: formatNaira(n.unplaced_kobo) }), body: t('dash.unplacedBody', { n: n.unplaced_payments }), cta: t('dash.placeIt'), to: 'orders', btn: 'bg-ink text-white' },
    n.conflicts > 0 && { tone: 'border border-line', title: t('dash.conflictsTitle', { n: n.conflicts }), body: n.conflict_first ?? '', cta: t('dash.count'), to: 'tills', btn: 'border-2 border-ink' },
    n.low_stock > 0 && { tone: 'border border-line', title: t('dash.lowTitle', { n: n.low_stock }), body: n.low_first ?? '', cta: t('dash.restock'), to: 'products?low=1', btn: 'border-2 border-ink' },
    n.attention_orders > 0 && { tone: 'border border-line', title: t('dash.attentionTitle', { n: n.attention_orders }), body: t('dash.attentionBody'), cta: t('dash.open'), to: 'orders', btn: 'border-2 border-ink' },
  ].filter(Boolean) as { tone: string; title: string; body: string; cta: string; to: string; btn: string }[];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-muted">{new Date().toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Lagos' })}</p>
          <h1 className="font-display text-[28px] font-extrabold tracking-tight lg:text-[34px]">{t(greeting())}</h1>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={async () => { await setLocale(pidgin ? 'en' : 'pcm'); setPidgin(!pidgin); location.reload(); }}
            className="min-h-10 rounded-full border-2 border-ink bg-white px-3.5 text-[13px] font-extrabold">{pidgin ? 'Pidgin' : 'English'}</button>
          <a href={`/s/${b.business.slug}`} target="_blank" rel="noreferrer" className="hidden min-h-10 items-center rounded-full border border-line bg-white px-3.5 text-[13px] font-bold sm:flex">{b.business.slug}.trawer.shop</a>
          <Link to="settings" aria-label={t('dash.settings')} className="flex size-10 items-center justify-center rounded-full border border-line bg-white lg:hidden"><Settings className="size-5" aria-hidden /></Link>
        </div>
      </div>

      {b.can('settings.manage') && !b.business.storefront_updated_at && (
        <Link to="design" className="lift group relative flex items-center gap-4 overflow-hidden rounded-3xl border border-line/70 bg-white p-4 shadow-card sm:p-5">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl text-white shadow-[0_10px_22px_-10px_rgb(0_0_0/0.5)]" style={{ background: `linear-gradient(135deg, ${b.business.brand_colour}, #F2B705)` }} aria-hidden><Palette className="size-6" /></span>
          <span className="flex-1">
            <b className="block font-display text-lg leading-tight">{t('design.promoTitle')}</b>
            <span className="text-sm text-body">{t('design.promoBody')}</span>
          </span>
          <ArrowRight className="size-5 shrink-0 transition-transform group-hover:translate-x-1" aria-hidden />
        </Link>
      )}

      <section aria-label={t('dash.inNumbers')} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="glow-green col-span-2 space-y-2 rounded-3xl bg-ink p-5 text-white shadow-float lg:col-span-1">
          <p className="text-sm font-semibold text-[#C9C3B6]">{t('dash.takenToday')}</p>
          <p className="num font-display text-[40px] font-extrabold leading-none tracking-tight">{short(data.taken_today_kobo)}</p>
          {change !== null && <p className={cx('text-sm font-semibold', change >= 0 ? 'text-[#8EE0B5]' : 'text-[#F5A399]')}>{change >= 0 ? '▲' : '▼'} {Math.abs(change)}% {t('dash.vsLastWeek')}</p>}
          {/* The headline is money received; these tiles are sales (orders confirmed today, credit included). */}
          {Object.keys(data.by_channel).length > 0 && <p className="pt-1 text-xs font-semibold text-[#C9C3B6]">{t('dash.salesByChannel')} · <span className="num">{short(data.sales_today_kobo)}</span></p>}
          <div className="grid grid-cols-2 gap-1.5">
            {Object.entries(data.by_channel).map(([ch, v]) => (
              <span key={ch} className="rounded-xl bg-white/10 px-2 py-1.5 backdrop-blur"><span className="block text-[11px] text-[#C9C3B6]">{CH[ch]?.label ?? ch}</span><b className="num text-sm">{short(v)}</b></span>
            ))}
          </div>
        </div>
        {data.profit_today_kobo !== null && (
          <div className="space-y-1.5 rounded-2xl border border-line/70 bg-white shadow-card p-4"><p className="text-sm font-semibold text-muted">{t('dash.profitToday')}</p><p className="num font-display text-[28px] font-extrabold">{short(data.profit_today_kobo)}</p>
            <p className="text-[13px] text-body">{data.sales_today_kobo ? t('dash.margin', { n: Math.round((data.profit_today_kobo / data.sales_today_kobo) * 100) }) : '—'}</p></div>
        )}
        <Link to="orders" className="lift space-y-1.5 rounded-2xl border border-line/70 bg-white shadow-card p-4"><p className="text-sm font-semibold text-muted">{t('dash.orders')}</p><p className="font-display text-[28px] font-extrabold">{data.orders_today}</p>
          <p className="text-[13px] text-body">{t('dash.toPackOnWay', { a: data.to_pack, b: data.on_the_way })}</p></Link>
        <Link to="debtors" className="lift space-y-1.5 rounded-2xl bg-red-50 p-4"><p className="text-sm font-bold text-red-ink">{t('dash.owedToYou')}</p><p className="num font-display text-[28px] font-extrabold">{short(data.owed_kobo)}</p>
          <p className="text-[13px] text-body">{data.late_kobo > 0 ? t('dash.lateAmount', { amount: short(data.late_kobo) }) : t('dash.nothingLate')}</p></Link>
      </section>

      {/* Phones: the bottom bar has room for four tabs; everything else is one tap away here. */}
      <nav aria-label={t('dash.more')} className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 lg:hidden">
        {[
          b.can('reports.view') && { to: 'reports', label: t('dash.reports'), icon: ChartColumn },
          { to: 'debtors', label: t('debt.title'), icon: HandCoins },
          b.can('social.manage') && { to: 'social', label: t('dash.social'), icon: Megaphone },
          { to: 'tills', label: t('dash.tills'), icon: MonitorSmartphone },
          b.can('settings.manage') && { to: 'design', label: t('dash.design'), icon: Palette },
        ].filter(Boolean).map((x) => {
          const l = x as { to: string; label: string; icon: typeof Palette };
          return (
            <Link key={l.to} to={l.to} className="press flex min-h-12 shrink-0 items-center gap-2 rounded-xl border border-line/70 bg-white px-3.5 text-sm font-bold shadow-card">
              <l.icon className="size-5 text-green" aria-hidden />{l.label}
            </Link>
          );
        })}
      </nav>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
        <section className="space-y-3">
          <h2 className="font-display text-[22px] font-extrabold">{t('dash.needsYou')}{needs.length ? ` · ${needs.length}` : ''}</h2>
          {needs.length === 0 && <p className="rounded-2xl bg-green-50 p-4 font-semibold text-green-ink">{t('dash.allClear')}</p>}
          {needs.map((x) => (
            <div key={x.title} className={cx('flex items-center gap-3 rounded-[18px] bg-white p-3.5', x.tone)}>
              <div className="min-w-0 flex-1"><b className="block">{x.title}</b><span className="line-clamp-2 text-sm text-body">{x.body}</span></div>
              <Link to={x.to} className={cx('flex min-h-[42px] shrink-0 items-center rounded-xl px-3.5 text-sm font-bold', x.btn)}>{x.cta}</Link>
            </div>
          ))}
          {data.tills.length > 0 && (
            <div className="space-y-2.5 rounded-[18px] border border-line/70 bg-white shadow-card p-3.5">
              <b>{t('dash.tills')}</b>
              {data.tills.map((d) => {
                const fresh = d.last_sync_at && Date.now() - new Date(d.last_sync_at).getTime() < 10 * 60_000;
                return <div key={d.id} className="flex items-center justify-between gap-2 text-[15px]"><span>{d.name}</span>
                  <StatusPill tone={fresh ? 'live' : 'offline'}>{fresh ? t('dash.live') : d.last_sync_at ? t('dash.lastSync', { time: new Date(d.last_sync_at).toLocaleTimeString('en-NG', { hour: 'numeric', minute: '2-digit' }) }) : t('dash.neverSynced')}</StatusPill></div>;
              })}
            </div>
          )}
        </section>

        <section className="space-y-3">
          <h2 className="font-display text-[22px] font-extrabold">{t('dash.salesByChannel')}</h2>
          <div className="space-y-3.5 rounded-[20px] border border-line/70 bg-white shadow-card p-4">
            <div aria-hidden className="grid h-40 grid-cols-11 items-end gap-2">
              {hours.map((h) => {
                const parts = data.by_hour.filter((x) => x.hour === h);
                const total = parts.reduce((s, x) => s + x.total, 0);
                return (
                  <div key={h} className="flex flex-col justify-end gap-0.5" style={{ height: `${Math.max((total / maxHour) * 100, 2)}%` }}>
                    {total === 0 ? <span className="h-0.5 bg-line" /> : parts.map((p) => <span key={p.channel} className={cx('rounded-sm', CH[p.channel]?.colour ?? 'bg-muted')} style={{ flex: p.total }} />)}
                  </div>
                );
              })}
            </div>
            <div className="grid grid-cols-11 gap-2 text-center text-[11px] text-muted">{hours.map((h) => <span key={h}>{h > 12 ? h - 12 : h}{h === 8 ? 'am' : h === 12 ? 'pm' : ''}</span>)}</div>
            <div className="flex flex-wrap gap-4 text-sm">
              {Object.entries(data.by_channel).map(([ch, v]) => <span key={ch} className="inline-flex items-center gap-1.5"><span className={cx('size-3 rounded-sm', CH[ch]?.colour)} />{CH[ch]?.label ?? ch} {short(v)}</span>)}
              {Object.keys(data.by_channel).length === 0 && <span className="text-muted">{t('dash.noSalesYet')}</span>}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2.5 rounded-[20px] border border-line/70 bg-white shadow-card p-4">
              <div className="flex items-center justify-between"><b>{t('dash.liveOrders')}</b><Link to="orders" aria-label={t('dash.orders')}><ArrowRight className="size-5" /></Link></div>
              {data.live_orders.map((o) => (
                <Link key={o.id} to={`orders/${o.id}`} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate"><b>#{o.order_number}</b> {o.customer} · {CH[o.channel]?.label ?? o.channel}</span>
                  <Badge tone={o.payment_status === 'paid' ? 'good' : o.status === 'pending' ? 'warn' : 'neutral'}>{o.payment_status === 'paid' ? t('dash.paid') : o.status === 'pending' ? t('dash.awaitingTransfer') : t(`order.status.${o.status}` as MessageKey)}</Badge>
                </Link>
              ))}
            </div>
            <div className="space-y-2.5 rounded-[20px] border border-line/70 bg-white shadow-card p-4">
              <b>{t('dash.bestSellers')}</b>
              {data.best_sellers.length === 0 && <p className="text-sm text-muted">{t('dash.noSalesYet')}</p>}
              {data.best_sellers.map((s, i) => <div key={s.name} className="flex justify-between gap-2 text-sm"><span className="truncate">{i + 1}. {s.name}</span><b className="num">{s.qty} pcs</b></div>)}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
