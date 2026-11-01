import { useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router';
import { ImagePlus, Plus, Trash2 } from 'lucide-react';
import { nairaToKobo } from '@trawer/core/money';
import { api } from '../lib/api';
import { invalidate, useApi, useMutation } from '../lib/use-api';
import { cx, formatDate, formatNaira } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Select, Spinner, Textarea } from '../components/ui';
import { t } from '../i18n';
import { useBiz } from './context';
import { useMfaRetry } from './MfaGate';

export default function Products() {
  return (
    <Routes>
      <Route index element={<ProductList />} />
      <Route path="new" element={<NewProduct />} />
      <Route path=":pid" element={<ProductDetail />} />
    </Routes>
  );
}

function ProductList() {
  const b = useBiz();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const status = params.get('status') ?? '';
  const low = params.get('low') === '1';
  const list = useApi<{ products: any[] }>(low ? null : `/api/biz/${b.business.id}/products?${new URLSearchParams({ ...(params.get('q') ? { q: params.get('q')! } : {}), ...(status ? { status } : {}) })}`);
  const lowList = useApi<{ items: any[] }>(low ? `/api/biz/${b.business.id}/low-stock` : null);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-display text-[30px] font-extrabold lg:text-[34px]">{t('dash.products')}</h1>
        {b.can('products.draft') && <Link to={`${b.base}/products/new`}><Button><Plus className="size-5" aria-hidden />{t('dash.newProduct')}</Button></Link>}
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setParams(q ? { q } : {}); }}>
        <Input type="search" placeholder="Name, SKU or barcode" aria-label={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" variant="secondary">{t('common.search')}</Button>
      </form>
      <div className="flex gap-2 overflow-x-auto">
        {[['', 'All'], ['active', 'Live'], ['draft', 'Drafts'], ['archived', 'Archived']].map(([v, l]) => (
          <button key={v} type="button" onClick={() => setParams(v ? { status: v } : {})}
            className={cx('min-h-10 rounded-full border-2 px-4 text-sm font-semibold', !low && status === v ? 'border-ink bg-ink text-white' : 'border-line bg-white')}>{l}</button>
        ))}
        <button type="button" onClick={() => setParams({ low: '1' })} className={cx('min-h-10 rounded-full border-2 px-4 text-sm font-semibold', low ? 'border-gold bg-gold text-ink text-white' : 'border-line bg-white')}>{t('dash.lowStock')}</button>
      </div>
      {low ? (
        !lowList.data ? <Spinner /> : lowList.data.items.length === 0 ? <Empty>{t('common.none')}</Empty> : (
          <ul className="divide-y rounded-2xl border bg-white">
            {lowList.data.items.map((i) => (
              <li key={`${i.variant_id}:${i.location_id}`}>
                <Link to={`${b.base}/products/${i.product_id}`} className="flex min-h-14 items-center justify-between gap-3 px-4 py-2">
                  <span><span className="font-semibold">{i.product_name}</span> <span className="text-sm text-body">{[i.colour, i.size].filter(Boolean).join(' / ')}</span></span>
                  <Badge tone={i.available === 0 ? 'bad' : 'warn'}>{i.available} left</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : !list.data ? <Spinner /> : list.data.products.length === 0 ? <Empty>{t('common.none')}</Empty> : (
        <ul className="divide-y rounded-2xl border bg-white">
          {list.data.products.map((p) => (
            <li key={p.id}>
              <Link to={`${b.base}/products/${p.id}`} className="flex min-h-16 items-center gap-3 px-3 py-2">
                {p.image ? <img src={p.image} alt="" width={48} height={48} loading="lazy" className="size-12 rounded-lg object-cover" /> : <div className="size-12 rounded-lg bg-line-soft" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{p.name}</p>
                  <p className="text-sm text-body">{p.variants} variant{p.variants === 1 ? '' : 's'} · {p.available} available</p>
                </div>
                <div className="text-right">
                  <p className="font-semibold">{p.price_kobo != null ? formatNaira(p.price_kobo) : '—'}</p>
                  <Badge tone={p.status === 'active' ? 'good' : p.status === 'draft' ? 'warn' : 'neutral'}>{p.status}</Badge>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface VariantRow { colour: string; colour_hex: string; size: string; price: string; cost: string; stock: string; image_path?: string; image_url?: string }
const emptyRow = (): VariantRow => ({ colour: '', colour_hex: '#9CA3AF', size: '', price: '', cost: '', stock: '' });

export async function uploadImage(businessId: string, file: File): Promise<{ path: string; url: string }> {
  const form = new FormData();
  form.append('file', file);
  return api(`/api/biz/${businessId}/uploads`, { form });
}

function NewProduct() {
  const b = useBiz();
  const navigate = useNavigate();
  const [p, setP] = useState({ name: '', category: '', description: '', base_unit: 'piece', pack_unit: 'carton', pack_factor: '' });
  const [rows, setRows] = useState<VariantRow[]>([emptyRow()]);
  const [publish, setPublish] = useState(b.can('products.manage'));
  const upd = (i: number, patch: Partial<VariantRow>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const upload = useMutation(async (i: number, file: File) => {
    const r = await uploadImage(b.business.id, file);
    upd(i, { image_path: r.path, image_url: r.url });
  });
  const save = useMutation(async () => {
    const r = await api<{ id: string }>(`/api/biz/${b.business.id}/products`, { json: {
      name: p.name, category: p.category || null, description: p.description, base_unit: p.base_unit,
      packs: p.pack_factor ? [{ unit: p.pack_unit, factor: Number(p.pack_factor) }] : [],
      status: publish ? 'active' : 'draft', source: 'manual',
      variants: rows.map((r) => ({
        colour: r.colour || null, colour_hex: r.colour ? r.colour_hex : null, size: r.size || null,
        retail_price_kobo: nairaToKobo(r.price || '0'), cost_kobo: r.cost ? nairaToKobo(r.cost) : null,
        opening_stock: r.stock ? Number(r.stock) : undefined, image_path: r.image_path ?? null,
      })),
    } });
    invalidate(`/api/biz/${b.business.id}`);
    navigate(`${b.base}/products/${r.id}`, { replace: true });
  });
  return (
    <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-display text-[30px] font-extrabold">{t('dash.newProduct')}</h1>
</div>
      <Card className="space-y-4">
        <Field label="Product name" htmlFor="pn"><Input id="pn" required value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category" htmlFor="pc"><Input id="pc" value={p.category} onChange={(e) => setP({ ...p, category: e.target.value })} placeholder="Ankara, Lace…" /></Field>
          <Field label="Sold in" htmlFor="bu">
            <Select id="bu" value={p.base_unit} onChange={(e) => setP({ ...p, base_unit: e.target.value })}>
              {['piece', 'yard', 'pair', 'set', 'kg', 'litre', 'pack'].map((u) => <option key={u}>{u}</option>)}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Pack (${t('common.optional')})`} htmlFor="pu">
            <Select id="pu" value={p.pack_unit} onChange={(e) => setP({ ...p, pack_unit: e.target.value })}>
              {['carton', 'bale', 'bundle', 'dozen', 'box', 'bag', 'roll', 'crate'].map((u) => <option key={u}>{u}</option>)}
            </Select>
          </Field>
          <Field label={`${p.base_unit}s per ${p.pack_unit}`} htmlFor="pf"><Input id="pf" inputMode="numeric" value={p.pack_factor} onChange={(e) => setP({ ...p, pack_factor: e.target.value.replace(/\D/g, '') })} placeholder="12" /></Field>
        </div>
        <Field label="Description" htmlFor="pd"><Textarea id="pd" rows={3} value={p.description} onChange={(e) => setP({ ...p, description: e.target.value })} /></Field>
      </Card>

      <div className="space-y-3">
        <h2 className="font-display text-xl font-extrabold">Colours / sizes</h2>
        {rows.map((r, i) => (
          <Card key={i} className="space-y-3">
            <div className="flex items-start gap-3">
              <label className="flex size-20 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-xl border-2 border-dashed border-line bg-line-soft">
                {r.image_url ? <img src={r.image_url} alt="" className="size-full object-cover" /> : <ImagePlus className="size-7 text-muted" aria-label="Add photo" />}
                <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => e.target.files?.[0] && void upload.run(i, e.target.files[0])} />
              </label>
              <div className="grid flex-1 grid-cols-[1fr_auto] gap-2">
                <Input aria-label="Colour" placeholder="Colour (e.g. Red)" value={r.colour} onChange={(e) => upd(i, { colour: e.target.value })} />
                <input aria-label="Swatch colour" type="color" className="h-12 w-12 rounded-lg" value={r.colour_hex} onChange={(e) => upd(i, { colour_hex: e.target.value })} />
                <Input aria-label="Size" placeholder="Size (optional)" value={r.size} onChange={(e) => upd(i, { size: e.target.value })} className="col-span-2" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Field label={`Price ₦ / ${p.base_unit}`} htmlFor={`pr${i}`}><Input id={`pr${i}`} required inputMode="decimal" value={r.price} onChange={(e) => upd(i, { price: e.target.value })} /></Field>
              <Field label="Cost ₦" htmlFor={`co${i}`}><Input id={`co${i}`} inputMode="decimal" value={r.cost} onChange={(e) => upd(i, { cost: e.target.value })} /></Field>
              <Field label={`Stock (${p.base_unit}s)`} htmlFor={`st${i}`}><Input id={`st${i}`} inputMode="numeric" value={r.stock} onChange={(e) => upd(i, { stock: e.target.value.replace(/\D/g, '') })} /></Field>
            </div>
            {rows.length > 1 && <Button type="button" variant="ghost" size="sm" onClick={() => setRows(rows.filter((_, j) => j !== i))}><Trash2 className="size-4" aria-hidden />Remove</Button>}
          </Card>
        ))}
        <Button type="button" variant="secondary" className="w-full" onClick={() => setRows([...rows, { ...emptyRow(), price: rows[rows.length - 1]?.price ?? '', cost: rows[rows.length - 1]?.cost ?? '' }])}>
          <Plus className="size-5" aria-hidden />Add colour / size
        </Button>
      </div>

      {b.can('products.manage') && (
        <label className="flex min-h-12 items-center gap-3 font-semibold"><input type="checkbox" className="size-5" checked={publish} onChange={(e) => setPublish(e.target.checked)} />Publish to the shop now</label>
      )}
      <ErrorNote error={save.error ?? upload.error} />
      <Button type="submit" size="lg" className="w-full" pending={save.pending}>{t('common.save')}</Button>
    </form>
  );
}

function ProductDetail() {
  const b = useBiz();
  const { pid = '' } = useParams();
  const key = `/api/biz/${b.business.id}/products/${pid}`;
  const { data } = useApi<any>(key);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const mfa = useMfaRetry();
  const setStatus = useMutation(async (status: string) => { await api(key, { method: 'PATCH', json: { status } }); invalidate(key); });
  if (!data) return <Spinner />;
  const p = data.product;
  return (
    <div className="space-y-5">
      {mfa.prompt}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-[30px] font-extrabold">{p.name}</h1>
          <p className="text-sm text-body">{p.category ?? 'No category'} · added {formatDate(p.created_at)} · {p.source}</p>
        </div>
        <div className="flex gap-2">
          <Badge tone={p.status === 'active' ? 'good' : 'warn'}>{p.status}</Badge>
          {b.can('products.manage') && (p.status === 'active'
            ? <Button size="sm" variant="secondary" onClick={() => void setStatus.run('archived')}>Archive</Button>
            : <Button size="sm" onClick={() => void setStatus.run('active')}>Publish</Button>)}
        </div>
      </div>
      <ErrorNote error={setStatus.error} />
      {data.images.length > 0 && (
        <div className="flex gap-2 overflow-x-auto">{data.images.map((i: any) => <img key={i.id} src={i.url} alt="" className="size-24 rounded-xl object-cover" />)}</div>
      )}
      <p className="text-sm text-body">Units: {data.units.map((u: any) => `${u.name}${u.factor > 1 ? ` = ${u.factor}` : ''}`).join(' · ')}</p>
      {data.variants.map((v: any) => (
        <VariantCard key={v.id} v={v} tiers={data.tiers} tierPrices={data.tier_prices.filter((x: any) => x.variant_id === v.id)} reload={() => invalidate(key)}
          onHistory={() => setHistoryFor(historyFor === v.id ? null : v.id)} showHistory={historyFor === v.id} mfa={mfa} />
      ))}
    </div>
  );
}

function VariantCard({ v, tiers, tierPrices, reload, onHistory, showHistory, mfa }: {
  v: any; tiers: any[]; tierPrices: any[]; reload: () => void; onHistory: () => void; showHistory: boolean; mfa: ReturnType<typeof useMfaRetry>;
}) {
  const b = useBiz();
  const [action, setAction] = useState<'receive' | 'adjust' | 'count'>('receive');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [price, setPrice] = useState(String(v.retail_price_kobo / 100));
  const [tp, setTp] = useState<Record<string, string>>(Object.fromEntries(tierPrices.map((x) => [x.tier_id, String(x.price_kobo / 100)])));
  const stock = useMutation(async () => {
    await api(`/api/biz/${b.business.id}/stock`, { json: { variant_id: v.id, action, qty: Number(qty), reason: reason || undefined } });
    setQty(''); setReason(''); reload();
  });
  const savePrice = useMutation(async () => {
    await api(`/api/biz/${b.business.id}/variants/${v.id}`, { method: 'PATCH', json: { retail_price_kobo: nairaToKobo(price) } });
    reload();
  });
  const saveTiers = useMutation(async () => {
    await api(`/api/biz/${b.business.id}/variants/${v.id}/tier-prices`, { method: 'PUT', json: {
      tier_prices: tiers.map((tr) => ({ tier_id: tr.id, price_kobo: tp[tr.id] ? nairaToKobo(tp[tr.id]!) : null })),
    } });
    reload();
  });
  const history = useApi<{ history: any[] }>(showHistory ? `/api/biz/${b.business.id}/variants/${v.id}/history` : null);
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {v.colour_hex && <span className="size-6 rounded-full border" style={{ background: v.colour_hex }} />}
          <h2 className="font-display text-lg font-extrabold">{[v.colour, v.size].filter(Boolean).join(' / ') || 'Default'}</h2>
          <span className="text-sm text-body">SKU {v.sku} · {v.barcode}</span>
        </div>
        <a className="text-sm font-semibold underline" href={`/api/biz/${b.business.id}/variants/${v.id}/label.pdf`} target="_blank" rel="noreferrer">Print label</a>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between"><span className="text-sm font-semibold text-muted">{t('stock.canSell')}</span><b className={cx('num font-display text-2xl', v.available === 0 ? 'text-red-ink' : v.available <= (v.low_stock_threshold ?? 5) ? 'text-gold-ink' : '')}>{v.available}</b></div>
        <div role="img" aria-label={t('stock.barLabel', { onHand: v.on_hand, available: v.available, reserved: v.reserved, allocated: v.allocated })} className="flex h-3.5 overflow-hidden rounded-full bg-line-soft">
          <span className="bg-green" style={{ flex: v.available }} /><span className="bg-gold" style={{ flex: v.reserved }} /><span className="bg-indigo" style={{ flex: v.allocated }} />
        </div>
        <p className="text-xs text-muted">{t('stock.breakdown', { onHand: v.on_hand, reserved: v.reserved, allocated: v.allocated })}</p>
      </div>
      {(b.can('stock.receive') || b.can('stock.adjust')) && (
        <form className="grid grid-cols-[auto_1fr] gap-2 sm:grid-cols-[auto_8rem_1fr_auto]" onSubmit={(e) => { e.preventDefault(); void stock.run(); }}>
          <Select aria-label="Stock action" value={action} onChange={(e) => setAction(e.target.value as typeof action)} className="w-36">
            {b.can('stock.receive') && <option value="receive">Receive</option>}
            {b.can('stock.adjust') && <option value="adjust">Adjust ±</option>}
            {b.can('stock.adjust') && <option value="count">Count</option>}
          </Select>
          <Input aria-label="Quantity" required inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d-]/g, ''))} placeholder="Qty" />
          <Input aria-label="Reason" required={action === 'adjust'} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" className="col-span-2 sm:col-span-1" />
          <Button type="submit" pending={stock.pending} className="col-span-2 sm:col-span-1">Update</Button>
        </form>
      )}
      <ErrorNote error={stock.error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void savePrice.run(); }}>
          <Field label="Retail price ₦ per piece" htmlFor={`rp${v.id}`}>
            <div className="flex gap-2">
              <Input id={`rp${v.id}`} inputMode="decimal" value={price} disabled={!b.can('prices.manage')} onChange={(e) => setPrice(e.target.value)} />
              {b.can('prices.manage') && <Button type="submit" variant="secondary" pending={savePrice.pending}>{t('common.save')}</Button>}
            </div>
          </Field>
          <ErrorNote error={savePrice.error} />
        </form>
        {b.can('prices.manage') && tiers.length > 0 && (
          <form className="space-y-2 rounded-2xl border-2 border-indigo p-3" onSubmit={async (e) => {
            e.preventDefault();
            await saveTiers.run();
          }}>
            <div className="flex items-center justify-between"><p className="text-sm font-bold">{t('stock.tierPrices')}</p><Badge tone="info">2FA</Badge></div>
            {tiers.map((tr) => (
              <div key={tr.id} className="flex items-center gap-2">
                <label htmlFor={`tp${v.id}${tr.id}`} className="w-28 shrink-0 text-sm">{tr.name}{tr.is_wholesale ? ' (W)' : ''}</label>
                <Input id={`tp${v.id}${tr.id}`} inputMode="decimal" value={tp[tr.id] ?? ''} onChange={(e) => setTp({ ...tp, [tr.id]: e.target.value })} placeholder="—" />
              </div>
            ))}
            <Button type="submit" variant="secondary" className="w-full" pending={saveTiers.pending}>Save tier prices</Button>
            {saveTiers.error?.code === 'mfa_required'
              ? <Button type="button" className="w-full" onClick={() => mfa.guard(saveTiers.error, () => void saveTiers.run())}>{t('auth.mfaTitle')}</Button>
              : <ErrorNote error={saveTiers.error} />}
          </form>
        )}
      </div>
      <Button variant="ghost" size="sm" onClick={onHistory}>{showHistory ? 'Hide history' : 'Stock history'}</Button>
      {showHistory && (!history.data ? <Spinner /> : (
        <ul className="divide-y text-sm">
          {history.data.history.map((h) => (
            <li key={h.id} className="flex justify-between gap-3 py-2">
              <span><span className="font-semibold">{h.type}</span> {h.order_number ? `#${h.order_number}` : ''} {h.reason ?? ''} <span className="text-muted">· {h.actor ?? h.channel ?? ''}</span></span>
              <span className={cx('font-mono', h.qty_delta > 0 ? 'text-green-ink' : 'text-red-ink')}>{h.qty_delta > 0 ? '+' : ''}{h.qty_delta}</span>
              <span className="text-muted">{formatDate(h.created_at, true)}</span>
            </li>
          ))}
        </ul>
      ))}
    </Card>
  );
}
