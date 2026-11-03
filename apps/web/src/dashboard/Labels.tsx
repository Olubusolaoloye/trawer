import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Barcode, Download, Search, Trash2 } from 'lucide-react';
import { ApiError } from '../lib/api';
import { useApi, useMutation } from '../lib/use-api';
import { cx, formatNaira } from '../lib/format';
import { Button, Card, ErrorNote, Field, Input, Skeleton } from '../components/ui';
import { t } from '../i18n';
import { useBiz } from './context';

interface VariantRow { id: string; colour: string | null; size: string | null; colour_hex: string | null; barcode: string | null; retail_price_kobo: number; on_hand: number }
interface Line { variant_id: string; product: string; label: string | null; barcode: string | null; price_kobo: number; on_hand: number; copies: number }
type Layout = 'a4-21' | 'roll-50x30';

/** Print barcode labels: A4 sticker sheets or a thermal label printer. */
export function Labels() {
  const b = useBiz();
  const [params] = useSearchParams();
  const [lines, setLines] = useState<Line[]>([]);
  const [layout, setLayout] = useState<Layout>('a4-21');
  const [showPrice, setShowPrice] = useState(true);
  const [skip, setSkip] = useState(0);
  const [pick, setPick] = useState<string | null>(params.get('product'));
  const total = lines.reduce((n, l) => n + l.copies, 0);
  const pages = layout === 'a4-21' ? Math.ceil((total + skip) / 21) : total;

  const add = (product: string, variants: VariantRow[]) => setLines((cur) => {
    const next = [...cur];
    for (const v of variants) {
      if (next.some((l) => l.variant_id === v.id)) continue;
      next.push({ variant_id: v.id, product, label: [v.colour, v.size].filter(Boolean).join(' / ') || null, barcode: v.barcode, price_kobo: v.retail_price_kobo, on_hand: v.on_hand, copies: 1 });
    }
    return next;
  });
  const setCopies = (id: string, copies: number) => setLines((cur) => cur.map((l) => (l.variant_id === id ? { ...l, copies: Math.max(1, Math.min(500, copies || 1)) } : l)));

  const download = useMutation(async () => {
    const res = await fetch(`/api/biz/${b.business.id}/labels`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Trawer': '1' },
      body: JSON.stringify({ items: lines.map((l) => ({ variant_id: l.variant_id, copies: l.copies })), layout, show_price: showPrice, skip: layout === 'a4-21' ? skip : 0 }),
    });
    if (!res.ok || !res.headers.get('content-type')?.includes('pdf')) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(res.status, body.error ?? 'download_unavailable');
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `labels-${new Date().toISOString().slice(0, 10)}.pdf`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  });

  return (
    <div className="space-y-5">
      <div>
        <Link to={`${b.base}/products`} className="text-sm font-bold text-muted">← {t('dash.products')}</Link>
        <h1 className="font-display text-[30px] font-extrabold">{t('lbl.title')}</h1>
        <p className="text-body">{t('lbl.intro')}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="space-y-4">
          <ProductPicker onPick={setPick} />
          {pick && <AddVariants productId={pick} onAdd={(name, vs) => { add(name, vs); setPick(null); }} onCancel={() => setPick(null)} />}
          <Card className="space-y-2">
            <h2 className="font-display text-lg font-extrabold">{t('lbl.toPrint', { n: total })}</h2>
            {lines.length === 0 ? <p className="text-sm text-muted">{t('lbl.empty')}</p> : (
              <>
                <ul className="divide-y divide-line-soft">
                  {lines.map((l) => (
                    <li key={l.variant_id} className="flex flex-wrap items-center gap-3 py-2.5">
                      <span className="min-w-0 flex-1">
                        <b className="block truncate">{l.product}{l.label ? <span className="font-normal text-muted"> · {l.label}</span> : null}</b>
                        <span className="num text-xs text-muted">{l.barcode} · {formatNaira(l.price_kobo)} · {t('lbl.inStock', { n: l.on_hand })}</span>
                      </span>
                      <label className="flex items-center gap-2 text-sm font-semibold">
                        {t('lbl.copies')}
                        <Input type="number" min={1} max={500} inputMode="numeric" value={l.copies} onChange={(e) => setCopies(l.variant_id, Number(e.target.value))}
                          className="min-h-11 w-20 px-2 text-center" aria-label={t('lbl.copiesFor', { name: `${l.product}${l.label ? ` ${l.label}` : ''}` })} />
                      </label>
                      <button type="button" onClick={() => setLines((cur) => cur.filter((x) => x.variant_id !== l.variant_id))}
                        aria-label={t('lbl.remove', { name: `${l.product}${l.label ? ` ${l.label}` : ''}` })}
                        className="press flex size-10 items-center justify-center rounded-xl text-muted hover:bg-red-50 hover:text-red-ink"><Trash2 className="size-5" aria-hidden /></button>
                    </li>
                  ))}
                </ul>
                <Button variant="secondary" size="sm" onClick={() => setLines((cur) => cur.map((l) => ({ ...l, copies: Math.max(1, Math.min(500, l.on_hand)) })))}>{t('lbl.onePerItem')}</Button>
              </>
            )}
          </Card>
        </div>

        <Card className="h-fit space-y-4">
          <fieldset className="space-y-2">
            <legend className="mb-1 font-bold">{t('lbl.printer')}</legend>
            {([['a4-21', t('lbl.a4'), t('lbl.a4Hint')], ['roll-50x30', t('lbl.roll'), t('lbl.rollHint')]] as const).map(([v, name, hint]) => (
              <label key={v} className={cx('flex cursor-pointer items-start gap-3 rounded-2xl border-2 bg-surface p-3', layout === v ? 'border-ink' : 'border-line')}>
                <input type="radio" name="layout" className="mt-1 size-4" checked={layout === v} onChange={() => setLayout(v)} />
                <span><b className="block">{name}</b><span className="text-sm text-muted">{hint}</span></span>
              </label>
            ))}
          </fieldset>
          {layout === 'a4-21' && (
            <Field label={t('lbl.skip')} htmlFor="skip" hint={t('lbl.skipHint')}>
              <Input id="skip" type="number" min={0} max={20} inputMode="numeric" value={skip} onChange={(e) => setSkip(Math.max(0, Math.min(20, Number(e.target.value) || 0)))} className="w-24" />
            </Field>
          )}
          <label className="flex min-h-11 items-center gap-3 font-semibold"><input type="checkbox" className="size-5" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} />{t('lbl.showPrice')}</label>
          <p className="text-sm text-body">{t(layout === 'a4-21' ? 'lbl.summaryA4' : 'lbl.summaryRoll', { n: total, pages })}</p>
          <ErrorNote error={download.error} />
          <Button size="lg" className="w-full" disabled={total === 0} pending={download.pending} onClick={() => void download.run()}>
            <Download className="size-5" aria-hidden />{t('lbl.download')}
          </Button>
          <p className="flex gap-2 text-xs text-muted"><Barcode className="size-4 shrink-0" aria-hidden />{t('lbl.scanHint')}</p>
        </Card>
      </div>
    </div>
  );
}

function ProductPicker({ onPick }: { onPick: (id: string) => void }) {
  const b = useBiz();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const found = useApi<{ products: { id: string; name: string; category: string | null; variants: number }[] }>(search ? `/api/biz/${b.business.id}/products?${new URLSearchParams({ q: search })}` : null);
  return (
    <Card className="space-y-3">
      <form role="search" className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(q.trim()); }}>
        <Input type="search" aria-label={t('lbl.find')} placeholder={t('lbl.find')} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" variant="secondary"><Search className="size-5" aria-hidden /><span className="sr-only sm:not-sr-only">{t('common.search')}</span></Button>
      </form>
      {search && (!found.data ? <Skeleton className="h-20" /> : found.data.products.length === 0 ? <p className="text-sm text-muted">{t('common.none')}</p> : (
        <ul className="max-h-64 space-y-1.5 overflow-y-auto">
          {found.data.products.slice(0, 20).map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => onPick(p.id)} className="press flex min-h-12 w-full items-center justify-between gap-3 rounded-xl bg-line-soft px-3 text-left">
                <span><b>{p.name}</b>{p.category ? <span className="text-sm text-muted"> · {p.category}</span> : null}</span>
                <span className="text-sm text-muted">{t('lbl.variants', { n: p.variants })}</span>
              </button>
            </li>
          ))}
        </ul>
      ))}
    </Card>
  );
}

/** Loads one product and adds all its colours/sizes to the print list. */
function AddVariants({ productId, onAdd, onCancel }: { productId: string; onAdd: (name: string, v: VariantRow[]) => void; onCancel: () => void }) {
  const b = useBiz();
  const { data, error } = useApi<{ product: { name: string }; variants: VariantRow[] }>(`/api/biz/${b.business.id}/products/${productId}`);
  useEffect(() => { if (data) onAdd(data.product.name, data.variants); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <ErrorNote error={error} />;
  return <div className="flex items-center gap-3"><Skeleton className="h-12 flex-1" /><Button variant="ghost" size="sm" onClick={onCancel}>{t('common.cancel')}</Button></div>;
}
