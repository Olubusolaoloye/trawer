import { useState } from 'react';
import { Bike, Camera, Check, PackageCheck, RotateCcw, TriangleAlert, Undo2 } from 'lucide-react';
import { api } from '../lib/api';
import { invalidate, useApi, useMutation } from '../lib/use-api';
import { cx, formatDate, formatNaira } from '../lib/format';
import { Badge, Button, Card, ErrorNote, Field, Input, Select } from '../components/ui';
import { t, type MessageKey } from '../i18n';
import { useBiz } from './context';

export const FAILURES = ['not_home', 'wrong_address', 'refused', 'unreachable', 'damaged', 'other'] as const;
interface DeliveryView {
  fulfilment_status: string;
  delivery_method: string;
  delivery: null | { id: string; rider_id: string | null; rider_name: string | null; attempts: number; collect_kobo: number; failure: string | null; received_by: string | null; proof_url: string | null };
  events: { status: string; at: string; failure: string | null; note: string | null; by: string | null }[];
}

/** Packing, rider, dispatch, proof of delivery — the order's whole delivery story in one card. */
export function DeliveryCard({ orderId, orderStatus }: { orderId: string; orderStatus: string }) {
  const b = useBiz();
  const base = `/api/biz/${b.business.id}/orders/${orderId}`;
  const { data } = useApi<DeliveryView>(`${base}/delivery`, { staleMs: 3_000 });
  const riders = useApi<{ riders: { id: string; name: string; role: string; carrying: number }[] }>(b.can('deliveries.manage') ? `/api/biz/${b.business.id}/riders` : null);
  const [mode, setMode] = useState<'idle' | 'deliver' | 'fail'>('idle');
  const [proof, setProof] = useState<{ path: string; preview: string } | null>(null);
  const [receivedBy, setReceivedBy] = useState('');
  const [failure, setFailure] = useState<string>('');
  const [note, setNote] = useState('');
  const refresh = async () => { setMode('idle'); setProof(null); await Promise.all([invalidate(`${base}/delivery`), invalidate(base)]); void invalidate(`/api/biz/${b.business.id}/`); };
  const step = useMutation(async (status: string, extra: Record<string, unknown> = {}) => { await api(`${base}/fulfilment`, { json: { status, ...extra } }); await refresh(); });
  const assign = useMutation(async (staff_id: string) => { await api(`${base}/rider`, { json: { staff_id: staff_id || null } }); await refresh(); void invalidate(`/api/biz/${b.business.id}/riders`); });
  const upload = useMutation(async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    const r = await api<{ path: string }>(`/api/biz/${b.business.id}/uploads?kind=proof`, { form });
    setProof({ path: r.path, preview: URL.createObjectURL(file) });
  });

  if (!data || orderStatus === 'pending' || orderStatus === 'cancelled' || orderStatus === 'expired') return null;
  const s = data.fulfilment_status;
  const d = data.delivery;
  const isDelivery = data.delivery_method === 'delivery';
  const manage = b.can('deliveries.manage');
  const err = step.error ?? assign.error ?? upload.error;

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-xl font-extrabold">{t(isDelivery ? 'deliv.title' : 'deliv.pickupTitle')}</h2>
        <Badge tone={s === 'failed' ? 'bad' : s === 'dispatched' ? 'info' : ['delivered', 'collected'].includes(s) ? 'good' : 'neutral'}>{t(`order.fulfil.${s}` as MessageKey)}</Badge>
      </div>

      {/* Timeline */}
      <ol className="space-y-0" aria-label={t('deliv.timeline')}>
        {data.events.length === 0 && <li className="text-sm text-muted">{t('deliv.notStarted')}</li>}
        {data.events.map((e, i) => (
          <li key={i} className="flex gap-3">
            <div className="flex w-5 flex-col items-center">
              <span className={cx('mt-1 size-3 rounded-full', e.status === 'failed' ? 'bg-red' : e.status === 'returned' ? 'bg-muted' : 'bg-green')} />
              {i < data.events.length - 1 && <span className="w-0.5 flex-1 bg-line" />}
            </div>
            <div className="pb-3 text-sm">
              <p className="font-bold">{t(`order.fulfil.${e.status}` as MessageKey)}{e.failure ? ` · ${t(`deliv.fail.${e.failure}` as MessageKey)}` : ''}</p>
              <p className="text-muted">{formatDate(e.at, true)}{e.by ? ` · ${e.by}` : ''}</p>
              {e.note && <p className="mt-0.5 text-body">“{e.note}”</p>}
            </div>
          </li>
        ))}
      </ol>

      {d?.proof_url && (
        <figure className="flex items-center gap-3 rounded-xl bg-green-50 p-2.5">
          <a href={d.proof_url} target="_blank" rel="noopener" className="shrink-0"><img src={`${d.proof_url}?w=200`} alt={t('deliv.proof')} className="size-20 rounded-lg object-cover" /></a>
          <figcaption className="text-sm text-green-ink"><b className="block">{t('deliv.proof')}</b>{d.received_by ? t('deliv.receivedBy', { name: d.received_by }) : null}</figcaption>
        </figure>
      )}

      {/* Rider */}
      {isDelivery && manage && !['delivered', 'returned'].includes(s) && (
        <Field label={t('deliv.rider')} htmlFor="rider" hint={riders.data && riders.data.riders.length === 0 ? t('deliv.noRiders') : undefined}>
          <Select id="rider" value={d?.rider_id ?? ''} onChange={(e) => void assign.run(e.target.value)} disabled={assign.pending}>
            <option value="">{t('deliv.noRider')}</option>
            {riders.data?.riders.map((r) => <option key={r.id} value={r.id}>{r.name} · {t(`role.${r.role}` as MessageKey)}{r.carrying ? ` · ${t('deliv.carrying', { n: r.carrying })}` : ''}</option>)}
          </Select>
        </Field>
      )}
      {d?.rider_name && !manage && <p className="text-sm"><b>{t('deliv.rider')}:</b> {d.rider_name}</p>}
      {s === 'dispatched' && d && d.collect_kobo > 0 && <p className="rounded-xl bg-gold-50 p-3 text-sm font-bold text-gold-ink">{t('deliv.collect', { amount: formatNaira(d.collect_kobo) })}</p>}

      {/* Next step */}
      {mode === 'idle' && (
        <div className="flex flex-wrap gap-2">
          {s === 'confirmed' && <Button onClick={() => void step.run('packed')} pending={step.pending}><PackageCheck className="size-5" aria-hidden />{t('deliv.markPacked')}</Button>}
          {s === 'packed' && isDelivery && <Button onClick={() => void step.run('dispatched')} pending={step.pending}><Bike className="size-5" aria-hidden />{t('deliv.dispatch')}</Button>}
          {s === 'packed' && !isDelivery && <Button onClick={() => void step.run('collected')} pending={step.pending}><Check className="size-5" aria-hidden />{t('deliv.collected')}</Button>}
          {s === 'dispatched' && <>
            <Button onClick={() => setMode('deliver')}><Camera className="size-5" aria-hidden />{t('deliv.markDelivered')}</Button>
            <Button variant="secondary" onClick={() => setMode('fail')}><TriangleAlert className="size-5" aria-hidden />{t('deliv.markFailed')}</Button>
          </>}
          {s === 'failed' && manage && <>
            <Button onClick={() => void step.run('dispatched')} pending={step.pending}><RotateCcw className="size-5" aria-hidden />{t('deliv.retry')}</Button>
            <Button variant="secondary" onClick={() => void step.run('returned')} pending={step.pending}><Undo2 className="size-5" aria-hidden />{t('deliv.returned')}</Button>
          </>}
        </div>
      )}

      {mode === 'deliver' && (
        <form className="space-y-3 rounded-xl border border-line p-3" onSubmit={(e) => { e.preventDefault(); if (proof) void step.run('delivered', { proof_path: proof.path, received_by: receivedBy || undefined }); }}>
          <p className="text-sm text-body">{t('deliv.proofHint')}</p>
          <label className="flex cursor-pointer items-center gap-3">
            {proof ? <img src={proof.preview} alt="" className="size-20 rounded-lg object-cover" /> : <span className="flex size-20 items-center justify-center rounded-lg border-2 border-dashed border-line"><Camera className="size-6 text-muted" aria-hidden /></span>}
            <span className="font-bold underline">{upload.pending ? '…' : proof ? t('deliv.changePhoto') : t('deliv.addPhoto')}</span>
            <input type="file" accept="image/*" capture="environment" className="sr-only" aria-label={t('deliv.addPhoto')} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload.run(f); }} />
          </label>
          <Field label={t('deliv.receivedByLabel')} htmlFor="rb"><Input id="rb" maxLength={80} value={receivedBy} onChange={(e) => setReceivedBy(e.target.value)} /></Field>
          <div className="flex gap-2">
            <Button type="submit" disabled={!proof} pending={step.pending}><Check className="size-5" aria-hidden />{t('deliv.confirmDelivered')}</Button>
            <Button type="button" variant="ghost" onClick={() => setMode('idle')}>{t('common.cancel')}</Button>
          </div>
        </form>
      )}

      {mode === 'fail' && (
        <form className="space-y-3 rounded-xl border border-line p-3" onSubmit={(e) => { e.preventDefault(); void step.run('failed', { failure, note: note || undefined }); }}>
          <Field label={t('deliv.whatHappened')} htmlFor="fr">
            <Select id="fr" required value={failure} onChange={(e) => setFailure(e.target.value)}>
              <option value="" disabled>{t('deliv.pickReason')}</option>
              {FAILURES.map((f) => <option key={f} value={f}>{t(`deliv.fail.${f}` as MessageKey)}</option>)}
            </Select>
          </Field>
          <Field label={t('deliv.note')} htmlFor="fn"><Input id="fn" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="flex gap-2">
            <Button type="submit" variant="danger" disabled={!failure} pending={step.pending}>{t('deliv.markFailed')}</Button>
            <Button type="button" variant="ghost" onClick={() => setMode('idle')}>{t('common.cancel')}</Button>
          </div>
        </form>
      )}
      <ErrorNote error={err} />
    </Card>
  );
}
