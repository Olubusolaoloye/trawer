import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Search, Tag, Trash2 } from 'lucide-react';
import { nairaToKobo } from '@trawer/core/money';
import { api } from '../lib/api';
import { invalidate, useApi } from '../lib/use-api';
import { cx, formatNaira } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Skeleton } from '../components/ui';
import { t } from '../i18n';
import { useBiz } from './context';
import { useMfaMutation } from './MfaGate';

interface Special {
  variant_id: string; product_id: string; product_name: string; variant_label: string | null; colour_hex: string | null; sku: string | null;
  price_kobo: number; retail_price_kobo: number; tier_price_kobo: number | null; note: string | null;
}
interface Detail {
  customer: { id: string; name: string; phone: string; business_name: string | null; buyer_type: string; wholesale_status: string; tier: string | null; owing_kobo: number; orders: number };
  prices: Special[];
  can_edit: boolean;
}

/** One customer: who they are, what they owe, and their special prices. */
export function CustomerDetail() {
  const b = useBiz();
  const { cid = '' } = useParams();
  const key = `/api/biz/${b.business.id}/customers/${cid}`;
  const { data, error } = useApi<Detail>(key);
  if (error) return <Empty>{t('common.none')}</Empty>;
  if (!data) return <Skeleton className="h-64" />;
  const c = data.customer;
  return (
    <div className="space-y-5">
      <div>
        <Link to={`${b.base}/customers`} className="text-sm font-bold text-muted">← {t('dash.customers')}</Link>
        <h1 className="font-display text-[30px] font-extrabold leading-tight">{c.business_name ?? c.name}</h1>
        <p className="text-body">{c.business_name ? `${c.name} · ` : ''}{c.phone}</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Badge>{c.buyer_type.replace('_', ' ')}</Badge>
          {c.tier && <Badge tone="info">{c.tier}</Badge>}
          <Badge>{t('cust.orders', { n: c.orders })}</Badge>
          {c.owing_kobo > 0 && <Link to={`${b.base}/debtors/${c.id}`}><Badge tone="bad">{t('cust.owes', { amount: formatNaira(c.owing_kobo) })} →</Badge></Link>}
        </div>
      </div>
      <SpecialPrices data={data} reloadKey={key} />
    </div>
  );
}

function SpecialPrices({ data, reloadKey }: { data: Detail; reloadKey: string }) {
  const b = useBiz();
  const base = `/api/biz/${b.business.id}/customers/${data.customer.id}/prices`;
  // A ref, not state: the request (and its retry after the 2FA prompt) must see the row just tapped.
  const removing = useRef<string[]>([]);
  const remove = useMfaMutation(async () => {
    await api(`${base}/clear`, { json: { variant_ids: removing.current } });
    await invalidate(reloadKey);
  });
  const groups = data.prices.reduce<Record<string, Special[]>>((g, p) => { (g[p.product_id] ??= []).push(p); return g; }, {});
  return (
    <Card className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 font-display text-xl font-extrabold"><Tag className="size-5 text-accent-text" aria-hidden />{t('cust.specialTitle')}</h2>
        <p className="text-sm text-body">{t('cust.specialHint')}</p>
      </div>
      {data.prices.length === 0 ? <p className="rounded-xl bg-line-soft p-3 text-sm text-body">{t('cust.specialNone')}</p> : (
        <ul className="divide-y divide-line-soft rounded-xl border border-line/70">
          {Object.values(groups).map((rows) => rows.map((p) => {
            const normal = p.tier_price_kobo ?? p.retail_price_kobo;
            return (
              <li key={p.variant_id} className="flex items-center gap-3 px-3 py-2.5">
                <span className="size-6 shrink-0 rounded-full ring-1 ring-black/10" style={{ background: p.colour_hex ?? '#d6d3d1' }} aria-hidden />
                <span className="min-w-0 flex-1">
                  <b className="block truncate">{p.product_name}{p.variant_label ? <span className="font-normal text-muted"> · {p.variant_label}</span> : null}</b>
                  {p.note && <span className="block truncate text-xs text-muted">{p.note}</span>}
                </span>
                <span className="text-right">
                  <span className="num block font-display text-lg font-extrabold text-accent-text">{formatNaira(p.price_kobo)}</span>
                  <span className="num block text-xs text-muted">{t(p.tier_price_kobo != null ? 'cust.tierWas' : 'cust.retailWas', { price: formatNaira(normal) })}</span>
                </span>
                {data.can_edit && (
                  <button type="button" aria-label={t('cust.removeSpecial', { name: `${p.product_name}${p.variant_label ? ` ${p.variant_label}` : ''}` })}
                    onClick={() => { removing.current = [p.variant_id]; void remove.run(); }}
                    className="press flex size-10 shrink-0 items-center justify-center rounded-xl text-muted hover:bg-red-50 hover:text-red-ink"><Trash2 className="size-5" aria-hidden /></button>
                )}
              </li>
            );
          }))}
        </ul>
      )}
      {remove.prompt}
      <ErrorNote error={remove.error?.code === 'mfa_required' ? null : remove.error} />
      {data.can_edit ? <AddSpecial base={base} reloadKey={reloadKey} /> : <p className="text-sm text-muted">{t('cust.specialManagersOnly')}</p>}
    </Card>
  );
}

interface ProductRow { id: string; name: string; category: string | null; price_kobo: number | null; variants: number }
interface VariantRow { id: string; colour: string | null; size: string | null; colour_hex: string | null; retail_price_kobo: number }

function AddSpecial({ base, reloadKey }: { base: string; reloadKey: string }) {
  const b = useBiz();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [product, setProduct] = useState<ProductRow | null>(null);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [price, setPrice] = useState('');
  const [note, setNote] = useState('');
  const found = useApi<{ products: ProductRow[] }>(search ? `/api/biz/${b.business.id}/products?${new URLSearchParams({ q: search, status: 'active' })}` : null);
  const detail = useApi<{ variants: VariantRow[] }>(product ? `/api/biz/${b.business.id}/products/${product.id}` : null);
  const variants = detail.data?.variants ?? [];
  const chosen = picked ?? variants.map((v) => v.id);
  const save = useMfaMutation(async () => {
    await api(base, { method: 'PUT', json: { variant_ids: chosen, price_kobo: nairaToKobo(price), note: note || undefined } });
    await invalidate(reloadKey);
    setProduct(null); setPicked(null); setPrice(''); setNote(''); setQ(''); setSearch('');
  });

  return (
    <div className="space-y-3 rounded-2xl bg-line-soft p-3.5">
      <h3 className="font-bold">{t('cust.addSpecial')}</h3>
      {!product ? (
        <>
          <form role="search" className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); }}>
            <Input type="search" aria-label={t('cust.findProduct')} placeholder={t('cust.findProduct')} value={q} onChange={(e) => setQ(e.target.value)} />
            <Button type="submit" variant="secondary"><Search className="size-5" aria-hidden /><span className="sr-only sm:not-sr-only">{t('common.search')}</span></Button>
          </form>
          {search && (found.data ? (found.data.products.length === 0 ? <p className="text-sm text-muted">{t('common.none')}</p> : (
            <ul className="max-h-64 space-y-1.5 overflow-y-auto">
              {found.data.products.slice(0, 20).map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => { setProduct(p); setPicked(null); }}
                    className="press flex min-h-12 w-full items-center justify-between gap-3 rounded-xl bg-surface px-3 text-left">
                    <span><b>{p.name}</b>{p.category ? <span className="text-sm text-muted"> · {p.category}</span> : null}</span>
                    {p.price_kobo != null && <span className="num text-sm text-body">{formatNaira(p.price_kobo)}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )) : <Skeleton className="h-24" />)}
        </>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
          <div className="flex items-center justify-between gap-2">
            <b>{product.name}</b>
            <button type="button" className="text-sm font-bold underline" onClick={() => setProduct(null)}>{t('cust.changeProduct')}</button>
          </div>
          {!detail.data ? <Skeleton className="h-16" /> : variants.length > 1 && (
            <fieldset>
              <legend className="mb-1.5 text-sm font-bold">{t('cust.whichColours')}</legend>
              <div className="flex flex-wrap gap-2">
                {variants.map((v) => {
                  const on = chosen.includes(v.id);
                  return (
                    <label key={v.id} className={cx('flex min-h-11 cursor-pointer items-center gap-2 rounded-full border bg-surface px-3 text-sm font-semibold', on ? 'border-ink' : 'border-line')}>
                      <input type="checkbox" className="size-4" checked={on} onChange={() => setPicked(on ? chosen.filter((x) => x !== v.id) : [...chosen, v.id])} />
                      <span className="size-4 rounded-full ring-1 ring-black/10" style={{ background: v.colour_hex ?? '#d6d3d1' }} aria-hidden />
                      {[v.colour, v.size].filter(Boolean).join(' / ') || t('cust.allOne')}
                      <span className="num text-muted">{formatNaira(v.retail_price_kobo)}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}
          <div className="grid grid-cols-[1fr_1.4fr] gap-2">
            <Field label={t('cust.specialPrice')} htmlFor="sp"><Input id="sp" required inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
            <Field label={`${t('cust.note')} (${t('common.optional')})`} htmlFor="sn"><Input id="sn" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('cust.notePlaceholder')} /></Field>
          </div>
          <ErrorNote error={save.error?.code === 'mfa_required' ? null : save.error} />
          <Button type="submit" className="w-full" pending={save.pending} disabled={!price || chosen.length === 0}>{t('cust.saveSpecial', { n: chosen.length })}</Button>
        </form>
      )}
      {/* Outside the form: the 2FA prompt has its own form, and forms can't be nested. */}
      {save.prompt}
    </div>
  );
}
