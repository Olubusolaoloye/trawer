import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { api } from '../lib/api';
import { invalidate, useApi, useMutation } from '../lib/use-api';
import { formatNaira } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Select, Spinner } from '../components/ui';
import { t } from '../i18n';
import { useBiz } from './context';

export default function Customers() {
  const b = useBiz();
  const [params, setParams] = useSearchParams();
  const pending = params.get('pending') === '1';
  const [q, setQ] = useState('');
  const key = `/api/biz/${b.business.id}/customers?${new URLSearchParams({ ...(pending ? { pending: 'true' } : {}), ...(params.get('q') ? { q: params.get('q')! } : {}) })}`;
  const { data } = useApi<{ customers: any[] }>(key);
  const tiers = useApi<{ tiers: any[] }>(`/api/biz/${b.business.id}/tiers`);
  const [add, setAdd] = useState({ name: '', phone: '', buyer_type: 'retail_buyer' });
  const create = useMutation(async () => { await api(`/api/biz/${b.business.id}/customers`, { json: add }); setAdd({ name: '', phone: '', buyer_type: 'retail_buyer' }); invalidate(`/api/biz/${b.business.id}/customers`); });
  const review = useMutation(async (id: string, approve: boolean, tier_id?: string) => {
    await api(`/api/biz/${b.business.id}/customers/${id}/wholesale`, { json: { approve, tier_id } });
    invalidate(`/api/biz/${b.business.id}`);
  });
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">{t('dash.customers')}</h1>
      <div className="flex gap-2">
        <Button variant={pending ? 'secondary' : 'primary'} size="sm" onClick={() => setParams({})}>All</Button>
        <Button variant={pending ? 'primary' : 'secondary'} size="sm" onClick={() => setParams({ pending: '1' })}>{t('dash.pendingWholesale')}</Button>
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setParams(q ? { q } : {}); }}>
        <Input type="search" aria-label={t('common.search')} placeholder="Name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" variant="secondary">{t('common.search')}</Button>
      </form>
      <ErrorNote error={review.error} />
      {!data ? <Spinner /> : data.customers.length === 0 ? <Empty>{t('common.none')}</Empty> : (
        <ul className="space-y-2">
          {data.customers.map((c) => (
            <li key={c.id}>
              <Card className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold">{c.name || '—'} {c.business_name && <span className="text-stone-600">· {c.business_name}</span>}</p>
                    <p className="text-sm text-stone-600">{c.phone} · {c.buyer_type.replace('_', ' ')}{c.tier ? ` · ${c.tier}` : ''}</p>
                  </div>
                  <div className="flex gap-1">
                    {c.wholesale_status !== 'not_applicable' && <Badge tone={c.wholesale_status === 'approved' ? 'good' : c.wholesale_status === 'pending' ? 'warn' : 'bad'}>{c.wholesale_status}</Badge>}
                    {c.owing_kobo > 0 && <Badge tone="bad">owes {formatNaira(c.owing_kobo)}</Badge>}
                  </div>
                </div>
                {c.wholesale_status === 'pending' && b.can('customers.approve_wholesale') && (
                  <div className="space-y-2 rounded-xl bg-stone-50 p-3">
                    <p className="text-sm">CAC: <span className="font-mono">{c.cac_number ?? '—'}</span></p>
                    <div className="flex flex-wrap gap-2">
                      <Select aria-label="Tier" id={`tier-${c.id}`} defaultValue="" className="max-w-56">
                        <option value="">Default wholesale tier</option>
                        {tiers.data?.tiers.filter((x) => x.is_wholesale).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </Select>
                      <Button size="sm" onClick={() => void review.run(c.id, true, (document.getElementById(`tier-${c.id}`) as HTMLSelectElement).value || undefined)}>Approve</Button>
                      <Button size="sm" variant="secondary" onClick={() => void review.run(c.id, false)}>Reject</Button>
                    </div>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
      {b.can('customers.manage') && (
        <Card>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void create.run(); }}>
            <h2 className="font-bold">Add customer</h2>
            <div className="grid gap-2 sm:grid-cols-3">
              <Field label="Name" htmlFor="cn"><Input id="cn" required value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} /></Field>
              <Field label="Phone" htmlFor="cp"><Input id="cp" required type="tel" value={add.phone} onChange={(e) => setAdd({ ...add, phone: e.target.value })} /></Field>
              <Field label="Type" htmlFor="ct">
                <Select id="ct" value={add.buyer_type} onChange={(e) => setAdd({ ...add, buyer_type: e.target.value })}>
                  <option value="retail_buyer">Retail buyer</option><option value="retailer">Retailer</option><option value="wholesaler">Wholesaler</option>
                </Select>
              </Field>
            </div>
            <ErrorNote error={create.error} />
            <Button type="submit" pending={create.pending}>Add</Button>
          </form>
        </Card>
      )}
    </div>
  );
}
