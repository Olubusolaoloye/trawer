import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api';
import { invalidate, useApi, useMutation } from '../lib/use-api';
import { formatDate } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, Input, Select, Spinner } from '../components/ui';
import { useBiz } from './context';

/** Tills (POS devices): offline stock allocations and conflicts from offline sales. */
export default function Tills() {
  const b = useBiz();
  const id = b.business.id;
  const devices = useApi<{ devices: any[] }>(`/api/biz/${id}/devices`);
  const alerts = useApi<{ alerts: any[] }>(`/api/biz/${id}/stock-alerts`);
  const [q, setQ] = useState('');
  const search = useApi<{ products: any[] }>(q.length >= 2 ? `/api/biz/${id}/products?q=${encodeURIComponent(q)}` : null);
  const [pick, setPick] = useState<{ productId: string } | null>(null);
  const detail = useApi<any>(pick ? `/api/biz/${id}/products/${pick.productId}` : null);
  const [form, setForm] = useState({ device: '', variant: '', qty: '' });
  const allocate = useMutation(async () => {
    await api(`/api/biz/${id}/devices/${form.device}/allocate`, { json: { variant_id: form.variant, qty: Number(form.qty) } });
    setForm({ ...form, qty: '' });
    await invalidate(`/api/biz/${id}/devices`);
    if (pick) await invalidate(`/api/biz/${id}/products/${pick.productId}`);
  });
  const resolve = useMutation(async (aid: string) => { await api(`/api/biz/${id}/stock-alerts/${aid}/resolve`, { json: {} }); await invalidate(`/api/biz/${id}/stock-alerts`); });

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Tills & stock alerts</h1>

      <section className="space-y-2">
        <h2 className="text-lg font-bold">Conflicts from offline sales</h2>
        {!alerts.data ? <Spinner /> : alerts.data.alerts.length === 0 ? <p className="text-stone-600">No open alerts.</p> : alerts.data.alerts.map((a) => (
          <Card key={a.id} className="space-y-1 border-amber-300 bg-amber-50">
            <p className="font-semibold">{a.product}{a.label ? ` (${a.label})` : ''} · short {a.qty}</p>
            <p className="text-sm">{a.message}</p>
            <p className="text-sm text-stone-600">{a.device} · {formatDate(a.created_at, true)}{a.order_number ? <> · <Link className="underline" to={`${b.base}/orders/${a.order_id}`}>order #{a.order_number}</Link></> : null}</p>
            <div className="flex gap-2 pt-1">
              <Link to={`${b.base}/products/${a.product_id}`}><Button size="sm" variant="secondary">Recount stock</Button></Link>
              {b.can('stock.adjust') && <Button size="sm" onClick={() => void resolve.run(a.id)}>Mark resolved</Button>}
            </div>
          </Card>
        ))}
        <ErrorNote error={resolve.error} />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-bold">Tills</h2>
        {!devices.data ? <Spinner /> : devices.data.devices.length === 0 ? <Empty>Install the Trawer POS app and add a till from it.</Empty> : devices.data.devices.map((d) => (
          <Card key={d.id} className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="font-semibold">{d.name} <span className="text-sm text-stone-600">· {d.location}</span></p>
              <Badge tone={d.last_sync_at ? 'good' : 'warn'}>{d.last_sync_at ? `synced ${formatDate(d.last_sync_at, true)}` : 'never synced'}</Badge>
            </div>
            {d.allocations.length > 0 ? (
              <ul className="text-sm">{d.allocations.map((a: any) => <li key={a.variant_id}>{a.qty} × {a.name}{a.label ? ` (${a.label})` : ''}</li>)}</ul>
            ) : <p className="text-sm text-stone-600">No stock allocated — this till can only sell while online.</p>}
          </Card>
        ))}
      </section>

      {b.can('stock.allocate') && devices.data && devices.data.devices.length > 0 && (
        <Card className="space-y-3">
          <h2 className="font-bold">Allocate stock to a till</h2>
          <p className="text-sm text-stone-600">Allocated stock is held for the till so it can sell offline. Use a negative number to take it back.</p>
          <Select aria-label="Till" value={form.device} onChange={(e) => setForm({ ...form, device: e.target.value })}>
            <option value="">Choose till</option>{devices.data.devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
          <Input type="search" aria-label="Find product" placeholder="Find product" value={q} onChange={(e) => setQ(e.target.value)} />
          {search.data && !pick && (
            <ul className="divide-y rounded-xl border">{search.data.products.slice(0, 8).map((p) => (
              <li key={p.id}><button type="button" className="min-h-12 w-full px-3 text-left" onClick={() => setPick({ productId: p.id })}>{p.name}</button></li>
            ))}</ul>
          )}
          {pick && detail.data && (
            <Select aria-label="Variant" value={form.variant} onChange={(e) => setForm({ ...form, variant: e.target.value })}>
              <option value="">Choose colour / size</option>
              {detail.data.variants.map((v: any) => <option key={v.id} value={v.id}>{[v.colour, v.size].filter(Boolean).join(' / ') || 'Default'} — {v.available} available</option>)}
            </Select>
          )}
          <Input aria-label="Quantity in pieces" inputMode="numeric" placeholder="Pieces" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value.replace(/[^\d-]/g, '') })} />
          <ErrorNote error={allocate.error} />
          <div className="flex gap-2">
            <Button disabled={!form.device || !form.variant || !form.qty} pending={allocate.pending} onClick={() => void allocate.run()}>Allocate</Button>
            {pick && <Button variant="ghost" onClick={() => { setPick(null); setForm({ ...form, variant: '' }); }}>Change product</Button>}
          </div>
        </Card>
      )}
    </div>
  );
}
