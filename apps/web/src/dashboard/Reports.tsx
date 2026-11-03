import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Download, Minus, Plus, Table2, Trash2 } from 'lucide-react';
import { nairaToKobo } from '@trawer/core/money';
import { api } from '../lib/api';
import { ask } from '../lib/demo';
import { invalidate, useApi, useMutation } from '../lib/use-api';
import { cx, formatDate, formatNaira } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Select, Skeleton } from '../components/ui';
import { t, type MessageKey } from '../i18n';
import { useBiz } from './context';

// Validated with the dataviz palette checker (light surface): sales/profit pass all checks;
// the 5 channel hues pass with secondary encoding (direct labels + gaps), which the channel chart uses.
const SALES = '#2a78d6';
const PROFIT = '#0B7A4B';
const CHANNEL: Record<string, { label: string; colour: string }> = {
  web: { label: 'Web store', colour: '#2a78d6' }, pos: { label: 'Till', colour: '#eb6834' }, whatsapp: { label: 'WhatsApp', colour: '#1baf7a' },
  instagram: { label: 'Instagram', colour: '#e87ba4' }, facebook: { label: 'Facebook', colour: '#6250d6' },
};
const CATEGORIES = ['rent', 'salaries', 'transport', 'delivery', 'fuel_power', 'data_airtime', 'marketing', 'bank_charges', 'taxes_levies', 'repairs', 'packaging', 'other'] as const;

interface Summary {
  from: string; to: string; costs_visible: boolean; sales_kobo: number; orders: number; units: number; avg_order_kobo: number;
  cost_kobo: number | null; gross_profit_kobo: number | null; margin_pct: number | null; cost_coverage_pct: number | null;
  expenses_kobo: number; net_profit_kobo: number | null; payments_kobo: number;
  previous: { from: string; to: string; sales_kobo: number; orders: number; gross_profit_kobo: number | null; expenses_kobo: number };
  days: { day: string; sales_kobo: number; gross_profit_kobo: number | null; orders: number }[];
  channels: { channel: string; sales_kobo: number; orders: number; gross_profit_kobo: number | null }[];
  expense_categories: { category: string; amount_kobo: number; entries: number }[];
}

const iso = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
function preset(id: string): { from: string; to: string } {
  const now = new Date();
  const d = (n: number) => iso(new Date(now.getTime() - n * 86400_000));
  switch (id) {
    case 'today': return { from: d(0), to: d(0) };
    case '30d': return { from: d(29), to: d(0) };
    case 'month': return { from: iso(new Date(now.getFullYear(), now.getMonth(), 1)), to: d(0) };
    case 'last_month': return { from: iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: iso(new Date(now.getFullYear(), now.getMonth(), 0)) };
    default: return { from: d(6), to: d(0) };
  }
}
const short = (k: number) => {
  const n = Math.abs(k) / 100;
  const s = n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}m` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
  return `${k < 0 ? '−' : ''}₦${s}`;
};

export default function Reports() {
  const b = useBiz();
  const [params, setParams] = useSearchParams();
  const p = params.get('range') ?? '7d';
  const range = p === 'custom' ? { from: params.get('from') ?? preset('7d').from, to: params.get('to') ?? preset('7d').to } : preset(p);
  const channel = params.get('channel') ?? '';
  const tab = params.get('tab') ?? 'products';
  const qs = new URLSearchParams({ ...range, ...(channel ? { channel } : {}) }).toString();
  const base = `/api/biz/${b.business.id}/reports`;
  const summary = useApi<Summary>(`${base}/summary?${qs}`);
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) if (v == null || v === '') next.delete(k); else next.set(k, v);
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-[30px] font-extrabold tracking-tight lg:text-[34px]">{t('rep.title')}</h1>
        <p className="text-body">{t('rep.subtitle')}</p>
      </div>

      {/* Filters: one row above everything they control */}
      <div className="flex flex-wrap items-end gap-2" role="group" aria-label={t('rep.filters')}>
        <div className="flex flex-wrap rounded-xl bg-line-soft p-1">
          {['today', '7d', '30d', 'month', 'last_month', 'custom'].map((id) => (
            <button key={id} type="button" aria-pressed={p === id} onClick={() => set(id === 'custom' ? { range: 'custom', from: range.from, to: range.to } : { range: id, from: null, to: null })}
              className={cx('min-h-10 rounded-lg px-3 text-sm font-semibold transition', p === id ? 'bg-white font-bold shadow-card' : 'text-body hover:text-ink')}>
              {t(`rep.range.${id}` as MessageKey)}
            </button>
          ))}
        </div>
        {p === 'custom' && <>
          <label className="text-sm font-semibold">{t('rep.from')} <Input type="date" className="mt-1 min-h-10 w-40" value={range.from} max={range.to} onChange={(e) => set({ from: e.target.value })} /></label>
          <label className="text-sm font-semibold">{t('rep.to')} <Input type="date" className="mt-1 min-h-10 w-40" value={range.to} min={range.from} onChange={(e) => set({ to: e.target.value })} /></label>
        </>}
        <label className="ml-auto text-sm font-semibold">{t('rep.channel')}
          <Select className="mt-1 min-h-10 w-44" value={channel} onChange={(e) => set({ channel: e.target.value })}>
            <option value="">{t('rep.allChannels')}</option>
            {Object.entries(CHANNEL).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
        </label>
      </div>

      {summary.error ? <ErrorNote error={summary.error} /> : !summary.data ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-32" />)}</div> : <>
        <Tiles s={summary.data} />
        <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
          <TrendChart s={summary.data} />
          <ChannelChart s={summary.data} />
        </div>
      </>}

      <div role="tablist" aria-label={t('rep.details')} className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4">
        {['products', 'customers', 'units', 'expenses', 'stock'].map((id) => (
          <button key={id} role="tab" type="button" aria-selected={tab === id} onClick={() => set({ tab: id })}
            className={cx('min-h-11 shrink-0 rounded-full px-4 text-sm font-bold transition', tab === id ? 'bg-ink text-paper' : 'border border-line bg-white hover:bg-line-soft')}>
            {t(`rep.tab.${id}` as MessageKey)}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'products' && <ProductsTab base={base} qs={qs} />}
        {tab === 'customers' && <CustomersTab base={base} qs={qs} />}
        {tab === 'units' && <UnitsTab base={base} qs={qs} />}
        {tab === 'expenses' && <ExpensesTab base={base} qs={qs} range={range} summary={summary.data} />}
        {tab === 'stock' && <StockTab base={base} />}
      </div>
    </div>
  );
}

function Delta({ now, before, onInk }: { now: number; before: number; onInk?: boolean }) {
  if (before === 0) return now === 0 ? null : <span className={cx('text-sm font-semibold', onInk ? 'text-[#C9C3B6]' : 'text-muted')}>{t('rep.new')}</span>;
  const pct = Math.round(((now - before) / Math.abs(before)) * 100);
  const Icon = pct > 0 ? ArrowUpRight : pct < 0 ? ArrowDownRight : Minus;
  return (
    <span className={cx('inline-flex items-center gap-0.5 text-sm font-bold', pct > 0 ? (onInk ? 'text-[#9BE3BE]' : 'text-green-ink') : pct < 0 ? (onInk ? 'text-[#FFB3AB]' : 'text-red-ink') : onInk ? 'text-[#C9C3B6]' : 'text-muted')}>
      <Icon className="size-4" aria-hidden />{pct > 0 ? '+' : ''}{pct}%<span className="sr-only"> {t('rep.vsPrevious')}</span>
    </span>
  );
}

function Tiles({ s }: { s: Summary }) {
  return (
    <section aria-label={t('rep.headline')} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="glow-green space-y-1 rounded-3xl bg-ink p-5 text-white shadow-float">
          <p className="text-sm font-semibold text-[#C9C3B6]">{t('rep.sales')}</p>
          <p className="num font-display text-[34px] font-extrabold leading-none tracking-tight">{formatNaira(s.sales_kobo)}</p>
          <p className="flex flex-wrap items-center gap-2 text-sm text-[#C9C3B6]">
            <Delta onInk now={s.sales_kobo} before={s.previous.sales_kobo} />
            {t('rep.ordersAvg', { n: s.orders, avg: formatNaira(Math.round(s.avg_order_kobo / 100) * 100) })}
          </p>
        </div>
        {s.costs_visible && (
          <Card className="space-y-1">
            <p className="text-sm font-semibold text-muted">{t('rep.gross')}</p>
            <p className="num font-display text-[28px] font-extrabold">{formatNaira(s.gross_profit_kobo ?? 0)}</p>
            <p className="flex items-center gap-2 text-sm text-body">{s.margin_pct != null && t('rep.margin', { n: s.margin_pct })} <Delta now={s.gross_profit_kobo ?? 0} before={s.previous.gross_profit_kobo ?? 0} /></p>
          </Card>
        )}
        <Card className="space-y-1">
          <p className="text-sm font-semibold text-muted">{t('rep.expenses')}</p>
          <p className="num font-display text-[28px] font-extrabold">{formatNaira(s.expenses_kobo)}</p>
          <p className="text-sm text-body">{t('rep.prevAmount', { amount: formatNaira(s.previous.expenses_kobo) })}</p>
        </Card>
        {s.costs_visible ? (
          <Card className={cx('space-y-1', (s.net_profit_kobo ?? 0) < 0 && 'bg-red-50')}>
            <p className="text-sm font-semibold text-muted">{t('rep.net')}</p>
            <p className={cx('num font-display text-[28px] font-extrabold', (s.net_profit_kobo ?? 0) < 0 && 'text-red-ink')}>{formatNaira(s.net_profit_kobo ?? 0)}</p>
            <p className="text-sm text-body">{t('rep.netHint')}</p>
          </Card>
        ) : (
          <Card className="space-y-1">
            <p className="text-sm font-semibold text-muted">{t('rep.received')}</p>
            <p className="num font-display text-[28px] font-extrabold">{formatNaira(s.payments_kobo)}</p>
          </Card>
        )}
      </div>
      {s.costs_visible && s.cost_coverage_pct != null && s.cost_coverage_pct < 100 && (
        <p role="note" className="flex items-start gap-2 rounded-xl bg-gold-50 p-3 text-sm font-semibold text-gold-ink">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />{t('rep.coverage', { pct: s.cost_coverage_pct })}
        </p>
      )}
    </section>
  );
}

/** Sales and gross profit per day (or per week for long ranges), one ₦ axis, hover tooltip, table view. */
function TrendChart({ s }: { s: Summary }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const buckets = useMemo(() => {
    if (s.days.length <= 45) return s.days.map((d) => ({ label: d.day, ...d }));
    const out: { label: string; day: string; sales_kobo: number; gross_profit_kobo: number | null; orders: number }[] = [];
    s.days.forEach((d, i) => {
      if (i % 7 === 0) out.push({ label: d.day, day: d.day, sales_kobo: 0, gross_profit_kobo: s.costs_visible ? 0 : null, orders: 0 });
      const w = out[out.length - 1]!;
      w.sales_kobo += d.sales_kobo; w.orders += d.orders;
      if (w.gross_profit_kobo != null) w.gross_profit_kobo += d.gross_profit_kobo ?? 0;
    });
    return out;
  }, [s]);
  const weekly = s.days.length > 45;
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.sales_kobo, b.gross_profit_kobo ?? 0)));
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const label = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-NG', buckets.length > 10 ? { day: 'numeric', month: 'short' } : { weekday: 'short', day: 'numeric' });
  const h = hover != null ? buckets[hover] : null;

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-lg font-extrabold">{t(weekly ? 'rep.trendWeekly' : 'rep.trend')}</h2>
        <div className="flex items-center gap-3 text-sm">
          <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded-sm" style={{ background: SALES }} aria-hidden />{t('rep.sales')}</span>
          {s.costs_visible && <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded-sm" style={{ background: PROFIT }} aria-hidden />{t('rep.gross')}</span>}
          <button type="button" aria-pressed={asTable} onClick={() => setAsTable(!asTable)} className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 font-bold hover:bg-line-soft"><Table2 className="size-4" aria-hidden />{t('rep.table')}</button>
        </div>
      </div>
      {asTable ? (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white text-left text-xs uppercase tracking-wider text-muted"><tr><th className="py-1.5">{t(weekly ? 'rep.weekOf' : 'rep.day')}</th><th className="text-right">{t('rep.orders')}</th><th className="text-right">{t('rep.sales')}</th>{s.costs_visible && <th className="text-right">{t('rep.gross')}</th>}</tr></thead>
            <tbody>{buckets.map((b) => <tr key={b.day} className="border-t border-line-soft"><td className="py-1.5">{formatDate(`${b.day}T12:00:00`)}</td><td className="num text-right">{b.orders}</td><td className="num text-right">{formatNaira(b.sales_kobo)}</td>{s.costs_visible && <td className="num text-right">{formatNaira(b.gross_profit_kobo ?? 0)}</td>}</tr>)}</tbody>
          </table>
        </div>
      ) : (
        <div className="relative" onMouseLeave={() => setHover(null)}>
          <div className="pointer-events-none absolute inset-x-0 top-0 h-48" aria-hidden>
            {ticks.map((v) => <div key={v} className="absolute inset-x-0 border-t border-line-soft" style={{ bottom: `${(v / max) * 100}%` }}><span className="absolute -top-2.5 left-0 bg-white pr-1 text-[11px] text-muted">{short(v)}</span></div>)}
          </div>
          <div className="relative ml-10 flex h-48 items-end" role="img" aria-label={t('rep.trendAlt', { from: formatDate(s.from), to: formatDate(s.to), total: formatNaira(s.sales_kobo) })}>
            {buckets.map((b, i) => (
              <div key={b.day} className={cx('flex h-full flex-1 items-end justify-center gap-[2px] px-[1px]', hover === i && 'bg-line-soft/70')}
                onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1}>
                <span className="w-full max-w-4 rounded-t-[4px]" style={{ height: `${(b.sales_kobo / max) * 100}%`, minHeight: b.sales_kobo ? 2 : 0, background: SALES }} />
                {s.costs_visible && <span className="w-full max-w-4 rounded-t-[4px]" style={{ height: `${(Math.max(b.gross_profit_kobo ?? 0, 0) / max) * 100}%`, minHeight: (b.gross_profit_kobo ?? 0) > 0 ? 2 : 0, background: PROFIT }} />}
              </div>
            ))}
          </div>
          {/* A few full date labels, centred under their bar (never truncated per bar). */}
          <div className="relative ml-10 mt-1 h-4 text-[11px] text-muted" aria-hidden>
            {buckets.map((b, i) => {
              const every = Math.max(1, Math.ceil(buckets.length / 7));
              if (buckets.length > 7 && i % every !== 0) return null;
              return <span key={b.day} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${((i + 0.5) / buckets.length) * 100}%` }}>{label(b.day)}</span>;
            })}
          </div>
          {h && (
            <div role="status" className="pointer-events-none absolute top-0 z-10 w-48 rounded-xl border border-line bg-white p-2.5 text-sm shadow-lift"
              style={(hover! + 0.5) / buckets.length > 0.5
                ? { right: `calc(${(1 - hover! / buckets.length) * 100}% - ${(1 - hover! / buckets.length) * 2.5}rem + 0.75rem)` }
                : { left: `calc(2.5rem + ${((hover! + 1) / buckets.length) * 100}% - ${((hover! + 1) / buckets.length) * 2.5}rem + 0.75rem)` }}>
              <p className="font-bold">{weekly ? t('rep.weekOfDate', { date: formatDate(`${h.day}T12:00:00`) }) : formatDate(`${h.day}T12:00:00`)}</p>
              <p className="flex justify-between"><span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: SALES }} />{t('rep.sales')}</span><b className="num">{formatNaira(h.sales_kobo)}</b></p>
              {s.costs_visible && <p className="flex justify-between"><span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: PROFIT }} />{t('rep.gross')}</span><b className="num">{formatNaira(h.gross_profit_kobo ?? 0)}</b></p>}
              <p className="flex justify-between text-muted"><span>{t('rep.orders')}</span><span className="num">{h.orders}</span></p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** Channels: ranked bars, each channel's fixed colour plus a direct label (never colour alone). */
function ChannelChart({ s }: { s: Summary }) {
  const total = s.channels.reduce((n, c) => n + c.sales_kobo, 0);
  const max = Math.max(1, ...s.channels.map((c) => c.sales_kobo));
  return (
    <Card className="space-y-3">
      <h2 className="font-display text-lg font-extrabold">{t('rep.byChannel')}</h2>
      {s.channels.length === 0 ? <p className="py-6 text-center text-sm text-muted">{t('rep.noSales')}</p> : (
        <ul className="space-y-3">
          {s.channels.map((c) => {
            const meta = CHANNEL[c.channel] ?? { label: c.channel, colour: '#5B5F57' };
            return (
              <li key={c.channel}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="font-semibold">{meta.label}</span>
                  <span><b className="num">{formatNaira(c.sales_kobo)}</b> <span className="text-muted">· {Math.round((c.sales_kobo / total) * 100)}%{s.costs_visible && c.gross_profit_kobo != null ? ` · ${t('rep.profitShort', { amount: short(c.gross_profit_kobo) })}` : ''}</span></span>
                </div>
                <div className="mt-1 h-3 rounded-full bg-line-soft" aria-hidden>
                  <div className="h-full rounded-full" style={{ width: `${(c.sales_kobo / max) * 100}%`, background: meta.colour }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function CsvLink({ base, kind, qs }: { base: string; kind: string; qs?: string }) {
  return (
    <a href={`${base}/export/${kind}.csv${qs ? `?${qs}` : ''}`} download className="press inline-flex min-h-10 items-center gap-1.5 rounded-xl border border-line bg-white px-3 text-sm font-bold hover:bg-line-soft">
      <Download className="size-4" aria-hidden />{t('rep.csv')}
    </a>
  );
}

function TableCard({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card className="space-y-3 p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4"><h2 className="font-display text-lg font-extrabold">{title}</h2>{action}</div>
      {/* keyboard users can scroll wide tables too */}
      <div className="overflow-x-auto pb-2 focus-visible:outline-offset-[-3px]" tabIndex={0} role="region" aria-label={title}>{children}</div>
    </Card>
  );
}
const th = 'px-4 py-2 text-left text-xs font-bold uppercase tracking-wider text-muted';
const td = 'px-4 py-2.5';

function ProductsTab({ base, qs }: { base: string; qs: string }) {
  const { data } = useApi<{ costs_visible: boolean; products: { id: string; name: string; category: string | null; base_qty: number; base_unit: string; base_unit_plural: string; sales_kobo: number; orders: number; cost_kobo: number | null; gross_profit_kobo: number | null; margin_pct: number | null; missing_cost: boolean; by_unit: { unit: string; plural: string; qty: number }[] }[] }>(`${base}/products?${qs}`);
  if (!data) return <Skeleton className="h-64" />;
  return (
    <TableCard title={t('rep.bestSellers')} action={<CsvLink base={base} kind="products" qs={qs} />}>
      {data.products.length === 0 ? <Empty>{t('rep.noSales')}</Empty> : (
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-line"><tr><th className={th}>#</th><th className={th}>{t('rep.product')}</th><th className={cx(th, 'text-right')}>{t('rep.sold')}</th><th className={cx(th, 'text-right')}>{t('rep.sales')}</th>
            {data.costs_visible && <><th className={cx(th, 'text-right')}>{t('rep.gross')}</th><th className={cx(th, 'text-right')}>{t('rep.marginCol')}</th></>}</tr></thead>
          <tbody>
            {data.products.map((p, i) => (
              <tr key={p.id} className="border-b border-line-soft last:border-0">
                <td className={cx(td, 'text-muted')}>{i + 1}</td>
                <td className={td}><b>{p.name}</b>{p.category && <span className="text-muted"> · {p.category}</span>}</td>
                <td className={cx(td, 'text-right')}><span className="num font-semibold">{p.base_qty} {p.base_qty === 1 ? p.base_unit : p.base_unit_plural}</span>
                  {p.by_unit.length > 1 && <span className="block text-xs text-muted">{p.by_unit.map((u) => `${u.qty} ${u.qty === 1 ? u.unit : u.plural}`).join(' · ')}</span>}</td>
                <td className={cx(td, 'num text-right font-semibold')}>{formatNaira(p.sales_kobo)}</td>
                {data.costs_visible && <>
                  <td className={cx(td, 'num text-right')}>{p.gross_profit_kobo != null ? formatNaira(p.gross_profit_kobo) : '—'}{p.missing_cost && <Badge tone="warn" className="ml-1.5">{t('rep.noCost')}</Badge>}</td>
                  <td className={cx(td, 'num text-right', (p.margin_pct ?? 0) < 0 && 'font-bold text-red-ink')}>{p.margin_pct != null ? `${p.margin_pct}%` : '—'}</td>
                </>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TableCard>
  );
}

function CustomersTab({ base, qs }: { base: string; qs: string }) {
  const { data, error } = useApi<{ customers: { id: string | null; name: string; wholesale: boolean | null; orders: number; sales_kobo: number; gross_profit_kobo: number | null; last_order_day: string; owing_kobo: number }[] }>(`${base}/customers?${qs}`);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Skeleton className="h-64" />;
  return (
    <TableCard title={t('rep.bestCustomers')} action={<CsvLink base={base} kind="customers" qs={qs} />}>
      {data.customers.length === 0 ? <Empty>{t('rep.noSales')}</Empty> : (
        <table className="w-full min-w-[600px] text-sm">
          <thead className="border-b border-line"><tr><th className={th}>#</th><th className={th}>{t('rep.customer')}</th><th className={cx(th, 'text-right')}>{t('rep.orders')}</th><th className={cx(th, 'text-right')}>{t('rep.sales')}</th><th className={cx(th, 'text-right')}>{t('rep.owes')}</th><th className={cx(th, 'text-right')}>{t('rep.lastOrder')}</th></tr></thead>
          <tbody>
            {data.customers.map((c, i) => (
              <tr key={c.id ?? 'walkin'} className="border-b border-line-soft last:border-0">
                <td className={cx(td, 'text-muted')}>{i + 1}</td>
                <td className={td}><b>{c.name}</b>{c.wholesale && <Badge tone="wholesale" className="ml-2">{t('store.wholesaleCaps')}</Badge>}</td>
                <td className={cx(td, 'num text-right')}>{c.orders}</td>
                <td className={cx(td, 'num text-right font-semibold')}>{formatNaira(c.sales_kobo)}</td>
                <td className={cx(td, 'num text-right', c.owing_kobo > 0 && 'font-semibold text-red-ink')}>{c.owing_kobo > 0 ? formatNaira(c.owing_kobo) : '—'}</td>
                <td className={cx(td, 'text-right text-muted')}>{formatDate(`${c.last_order_day}T12:00:00`)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TableCard>
  );
}

function UnitsTab({ base, qs }: { base: string; qs: string }) {
  const { data } = useApi<{ costs_visible: boolean; units: { unit: string; plural: string; qty: number; sales_kobo: number; gross_profit_kobo: number | null }[] }>(`${base}/products?${qs}`);
  if (!data) return <Skeleton className="h-40" />;
  const total = data.units.reduce((n, u) => n + u.sales_kobo, 0);
  return (
    <TableCard title={t('rep.byUnit')}>
      {data.units.length === 0 ? <Empty>{t('rep.noSales')}</Empty> : (
        <table className="w-full min-w-[480px] text-sm">
          <thead className="border-b border-line"><tr><th className={th}>{t('rep.unit')}</th><th className={cx(th, 'text-right')}>{t('rep.qty')}</th><th className={cx(th, 'text-right')}>{t('rep.sales')}</th><th className={cx(th, 'text-right')}>{t('rep.share')}</th>{data.costs_visible && <th className={cx(th, 'text-right')}>{t('rep.gross')}</th>}</tr></thead>
          <tbody>{data.units.map((u) => (
            <tr key={u.unit} className="border-b border-line-soft last:border-0">
              <td className={cx(td, 'font-bold capitalize')}>{u.plural}</td><td className={cx(td, 'num text-right')}>{u.qty}</td>
              <td className={cx(td, 'num text-right font-semibold')}>{formatNaira(u.sales_kobo)}</td><td className={cx(td, 'num text-right')}>{total ? Math.round((u.sales_kobo / total) * 100) : 0}%</td>
              {data.costs_visible && <td className={cx(td, 'num text-right')}>{u.gross_profit_kobo != null ? formatNaira(u.gross_profit_kobo) : '—'}</td>}
            </tr>))}</tbody>
        </table>
      )}
    </TableCard>
  );
}

function ExpensesTab({ base, qs, range, summary }: { base: string; qs: string; range: { from: string; to: string }; summary?: Summary }) {
  const b = useBiz();
  const key = `${base}/expenses?${qs}`;
  const { data, error } = useApi<{ expenses: { id: string; category: string; amount_kobo: number; spent_on: string; description: string | null; method: string }[] }>(key);
  const [f, setF] = useState({ category: 'transport', amount: '', spent_on: range.to, description: '', method: 'cash' });
  const refresh = async () => { await invalidate(key); await invalidate(`${base}/summary`); };
  const add = useMutation(async () => {
    await api(`${base}/expenses`, { json: { category: f.category, amount_kobo: nairaToKobo(f.amount), spent_on: f.spent_on, description: f.description || undefined, method: f.method } });
    setF({ ...f, amount: '', description: '' });
    await refresh();
  });
  const del = useMutation(async (id: string) => { await api(`${base}/expenses/${id}`, { method: 'DELETE' }); await refresh(); });
  if (error) return <ErrorNote error={error} />;
  const cats = summary?.expense_categories ?? [];
  const catMax = Math.max(1, ...cats.map((c) => c.amount_kobo));
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <TableCard title={t('rep.expenses')} action={<CsvLink base={base} kind="expenses" qs={qs} />}>
        {!data ? <Skeleton className="m-4 h-40" /> : data.expenses.length === 0 ? <Empty>{t('rep.noExpenses')}</Empty> : (
          <table className="w-full min-w-[520px] text-sm">
            <thead className="border-b border-line"><tr><th className={th}>{t('rep.day')}</th><th className={th}>{t('rep.category')}</th><th className={th}>{t('rep.note')}</th><th className={cx(th, 'text-right')}>{t('rep.amount')}</th><th className={th}><span className="sr-only">{t('rep.actions')}</span></th></tr></thead>
            <tbody>{data.expenses.map((e) => (
              <tr key={e.id} className="border-b border-line-soft last:border-0">
                <td className={cx(td, 'whitespace-nowrap')}>{formatDate(`${e.spent_on}T12:00:00`)}</td>
                <td className={td}>{t(`exp.${e.category}` as MessageKey)}</td>
                <td className={cx(td, 'text-muted')}>{e.description ?? ''}<span className="block text-xs">{t(`exp.method.${e.method}` as MessageKey)}</span></td>
                <td className={cx(td, 'num text-right font-semibold')}>{formatNaira(e.amount_kobo)}</td>
                <td className={cx(td, 'text-right')}>{b.can('expenses.manage') && <button type="button" aria-label={t('rep.deleteExpense', { what: t(`exp.${e.category}` as MessageKey), amount: formatNaira(e.amount_kobo) })} onClick={() => { if (ask(t('rep.deleteConfirm'))) void del.run(e.id); }} className="rounded-lg p-2 text-muted hover:bg-red-50 hover:text-red-ink"><Trash2 className="size-4" aria-hidden /></button>}</td>
              </tr>))}</tbody>
          </table>
        )}
      </TableCard>
      <div className="order-first space-y-4 lg:order-none">
        {b.can('expenses.manage') && (
          <Card strong>
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void add.run(); }}>
              <h2 className="font-display text-lg font-extrabold">{t('rep.addExpense')}</h2>
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('rep.amount')} htmlFor="ea"><Input id="ea" required inputMode="decimal" placeholder="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
                <Field label={t('rep.day')} htmlFor="ed"><Input id="ed" type="date" required max={preset('today').to} value={f.spent_on} onChange={(e) => setF({ ...f, spent_on: e.target.value })} /></Field>
              </div>
              <Field label={t('rep.category')} htmlFor="ec"><Select id="ec" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{t(`exp.${c}` as MessageKey)}</option>)}</Select></Field>
              <Field label={t('rep.note')} htmlFor="en"><Input id="en" maxLength={200} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder={t('rep.notePlaceholder')} /></Field>
              <Field label={t('rep.paidBy')} htmlFor="em"><Select id="em" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{['cash', 'transfer', 'card', 'other'].map((m) => <option key={m} value={m}>{t(`exp.method.${m}` as MessageKey)}</option>)}</Select></Field>
              <ErrorNote error={add.error ?? del.error} />
              <Button type="submit" className="w-full" pending={add.pending} disabled={!f.amount || nairaToKobo(f.amount) <= 0}><Plus className="size-5" aria-hidden />{t('rep.addExpense')}</Button>
            </form>
          </Card>
        )}
        {cats.length > 0 && (
          <Card className="space-y-2.5">
            <h2 className="font-display text-lg font-extrabold">{t('rep.byCategory')}</h2>
            <ul className="space-y-2.5">{cats.map((c) => (
              <li key={c.category}>
                <div className="flex justify-between text-sm"><span className="font-semibold">{t(`exp.${c.category}` as MessageKey)}</span><b className="num">{formatNaira(c.amount_kobo)}</b></div>
                <div className="mt-1 h-2.5 rounded-full bg-line-soft" aria-hidden><div className="h-full rounded-full" style={{ width: `${(c.amount_kobo / catMax) * 100}%`, background: SALES }} /></div>
              </li>))}</ul>
          </Card>
        )}
      </div>
    </div>
  );
}

function StockTab({ base }: { base: string }) {
  const { data } = useApi<{ costs_visible: boolean; units: number; retail_value_kobo: number; cost_value_kobo: number | null; variants_without_cost: number | null;
    categories: { category: string; units: number; retail_value_kobo: number; cost_value_kobo: number | null }[]; slow_movers: { id: string; name: string; units: number; value_kobo: number; last_sold: string | null }[] }>(`${base}/stock`);
  if (!data) return <Skeleton className="h-64" />;
  const max = Math.max(1, ...data.categories.map((c) => c.retail_value_kobo));
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="space-y-1"><p className="text-sm font-semibold text-muted">{t('rep.onShelves')}</p><p className="num font-display text-[28px] font-extrabold">{data.units.toLocaleString('en-NG')}</p><p className="text-sm text-body">{t('rep.unitsAllProducts')}</p></Card>
        <Card className="space-y-1"><p className="text-sm font-semibold text-muted">{t('rep.atRetail')}</p><p className="num font-display text-[28px] font-extrabold">{formatNaira(data.retail_value_kobo)}</p></Card>
        {data.costs_visible && <Card className="space-y-1"><p className="text-sm font-semibold text-muted">{t('rep.atCost')}</p><p className="num font-display text-[28px] font-extrabold">{formatNaira(data.cost_value_kobo ?? 0)}</p>
          {!!data.variants_without_cost && <p className="text-sm font-semibold text-gold-ink">{t('rep.withoutCost', { n: data.variants_without_cost })}</p>}</Card>}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <TableCard title={t('rep.byCategory')} action={<CsvLink base={base} kind="stock" />}>
          <ul className="space-y-3 px-4 pb-2">{data.categories.map((c) => (
            <li key={c.category}>
              <div className="flex justify-between gap-2 text-sm"><span className="font-semibold">{c.category} <span className="font-normal text-muted">· {c.units.toLocaleString('en-NG')}</span></span><b className="num">{formatNaira(c.retail_value_kobo)}</b></div>
              <div className="mt-1 h-2.5 rounded-full bg-line-soft" aria-hidden><div className="h-full rounded-full" style={{ width: `${(c.retail_value_kobo / max) * 100}%`, background: SALES }} /></div>
            </li>))}</ul>
        </TableCard>
        <TableCard title={t('rep.slowMovers')}>
          {data.slow_movers.length === 0 ? <Empty>{t('rep.noSlow')}</Empty> : (
            <table className="w-full text-sm"><tbody>{data.slow_movers.map((s) => (
              <tr key={s.id} className="border-b border-line-soft last:border-0">
                <td className={td}><b>{s.name}</b><span className="block text-xs text-muted">{s.last_sold ? t('rep.lastSold', { date: formatDate(s.last_sold) }) : t('rep.neverSold')}</span></td>
                <td className={cx(td, 'num text-right')}>{s.units}</td><td className={cx(td, 'num text-right font-semibold')}>{formatNaira(s.value_kobo)}</td>
              </tr>))}</tbody></table>
          )}
        </TableCard>
      </div>
    </div>
  );
}
