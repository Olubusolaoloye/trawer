import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { api } from '../lib/api';
import { invalidate, useApi, useMutation } from '../lib/use-api';
import { Badge, Button, Card, ErrorNote, Field, Input, Select } from '../components/ui';
import { t } from '../i18n';
import { useBiz } from './context';
import { useMfaMutation } from './MfaGate';
import { WhatsAppCard } from './WhatsAppCard';

/** Runs a mutation; if the API wants MFA, shows the TOTP prompt and retries once verified. */
export default function SettingsPage() {
  const b = useBiz();
  const [params] = useSearchParams();
  const id = b.business.id;
  const [f, setF] = useState({ brand_colour: b.business.brand_colour, reservation_minutes: String(b.business.reservation_minutes) });
  const saveBiz = useMutation(async () => {
    await api(`/api/biz/${id}`, { method: 'PATCH', json: { brand_colour: f.brand_colour, reservation_minutes: Number(f.reservation_minutes), onboarding_completed: true } });
    invalidate(`/api/biz/${id}`);
  });
  const [loc, setLoc] = useState('');
  const addLoc = useMutation(async () => { await api(`/api/biz/${id}/locations`, { json: { name: loc } }); setLoc(''); invalidate(`/api/biz/${id}`); });

  const payout = useApi<{ payout: any }>(b.can('payouts.manage') ? `/api/biz/${id}/payout` : null);
  const [bank, setBank] = useState({ bank_code: '', bank_name: '', account_number: '', account_name: '' });
  const savePayout = useMfaMutation(async () => { await api(`/api/biz/${id}/payout`, { method: 'PUT', json: bank }); invalidate(`/api/biz/${id}/payout`); });

  const staff = useApi<{ staff: any[] }>(b.can('staff.manage') ? `/api/biz/${id}/staff` : null);
  const [inv, setInv] = useState({ phone: '', role: 'cashier', display_name: '' });
  const invite = useMfaMutation(async () => { await api(`/api/biz/${id}/staff`, { json: inv }); setInv({ phone: '', role: 'cashier', display_name: '' }); invalidate(`/api/biz/${id}/staff`); });

  const tiers = useApi<{ tiers: any[] }>(`/api/biz/${id}/tiers`);
  const [tier, setTier] = useState({ name: '', is_wholesale: false });
  const addTier = useMfaMutation(async () => { await api(`/api/biz/${id}/tiers`, { json: tier }); setTier({ name: '', is_wholesale: false }); invalidate(`/api/biz/${id}/tiers`); });

  return (
    <div className="space-y-5">
      {savePayout.prompt ?? invite.prompt ?? addTier.prompt}
      <h1 className="font-display text-[30px] font-extrabold lg:text-[34px]">{t('dash.settings')}</h1>
      {params.get('welcome') && <p className="rounded-xl bg-green-50 p-3 font-semibold text-green-ink">Your shop is live at {b.business.slug}.trawer.shop. Add your bank account, locations and staff below.</p>}

      {b.can('settings.manage') && (
        <Card>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void saveBiz.run(); }}>
            <h2 className="font-display text-lg font-extrabold">Shop</h2>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Brand colour" htmlFor="bc"><input id="bc" type="color" className="h-12 w-24 rounded-lg" value={f.brand_colour} onChange={(e) => setF({ ...f, brand_colour: e.target.value })} /></Field>
              <Field label="Hold stock for unpaid orders (minutes)" htmlFor="rm"><Input id="rm" inputMode="numeric" value={f.reservation_minutes} onChange={(e) => setF({ ...f, reservation_minutes: e.target.value.replace(/\D/g, '') })} /></Field>
            </div>
            <ErrorNote error={saveBiz.error} />
            <Button type="submit" pending={saveBiz.pending}>{t('common.save')}</Button>
          </form>
        </Card>
      )}

      <WhatsAppCard />

      <Link to={`${b.base}/tills`} className="flex min-h-14 items-center justify-between rounded-2xl border bg-white px-4 font-semibold">Tills (POS) & stock alerts <span aria-hidden>›</span></Link>

      <Card className="space-y-3">
        <h2 className="font-display text-lg font-extrabold">Locations</h2>
        <ul className="space-y-1">{b.locations.map((l) => <li key={l.id}>{l.name} {l.is_default && <Badge>default</Badge>}</li>)}</ul>
        {b.can('settings.manage') && (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void addLoc.run(); }}>
            <Input aria-label="New location" required placeholder="e.g. Idumota warehouse" value={loc} onChange={(e) => setLoc(e.target.value)} />
            <Button type="submit" variant="secondary" pending={addLoc.pending}>Add</Button>
          </form>
        )}
        <ErrorNote error={addLoc.error} />
      </Card>

      {b.can('payouts.manage') && (
        <Card>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void savePayout.run(); }}>
            <h2 className="font-display text-lg font-extrabold">Bank account for transfers</h2>
            <p className="text-sm text-body">Buyers pay into virtual accounts that settle straight to this account. Trawer never holds your money.</p>
            {payout.data?.payout && <p className="text-sm">Current: {payout.data.payout.bank_name} ••••{payout.data.payout.last4} ({payout.data.payout.account_name})</p>}
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Bank name" htmlFor="bn"><Input id="bn" required value={bank.bank_name} onChange={(e) => setBank({ ...bank, bank_name: e.target.value })} /></Field>
              <Field label="Bank code" htmlFor="bk" hint="e.g. 058 for GTBank"><Input id="bk" required inputMode="numeric" value={bank.bank_code} onChange={(e) => setBank({ ...bank, bank_code: e.target.value })} /></Field>
              <Field label="Account number" htmlFor="an"><Input id="an" required inputMode="numeric" maxLength={10} value={bank.account_number} onChange={(e) => setBank({ ...bank, account_number: e.target.value.replace(/\D/g, '') })} /></Field>
              <Field label="Account name" htmlFor="am"><Input id="am" required value={bank.account_name} onChange={(e) => setBank({ ...bank, account_name: e.target.value })} /></Field>
            </div>
            {savePayout.error?.code !== 'mfa_required' && <ErrorNote error={savePayout.error} />}
            <Button type="submit" pending={savePayout.pending}>{t('common.save')}</Button>
          </form>
        </Card>
      )}

      {b.can('staff.manage') && (
        <Card className="space-y-3">
          <h2 className="font-display text-lg font-extrabold">Staff</h2>
          <ul className="divide-y">
            {staff.data?.staff.map((s) => (
              <li key={s.id} className="flex items-center justify-between py-2"><span>{s.display_name || s.phone} <span className="text-sm text-body">{s.phone}</span></span><span className="flex gap-1"><Badge>{s.role}</Badge><Badge tone={s.status === 'active' ? 'good' : 'warn'}>{s.status}</Badge></span></li>
            ))}
          </ul>
          <form className="grid gap-2 sm:grid-cols-[1fr_1fr_10rem_auto]" onSubmit={(e) => { e.preventDefault(); void invite.run(); }}>
            <Input aria-label="Staff phone" required type="tel" placeholder="Phone" value={inv.phone} onChange={(e) => setInv({ ...inv, phone: e.target.value })} />
            <Input aria-label="Staff name" placeholder="Name" value={inv.display_name} onChange={(e) => setInv({ ...inv, display_name: e.target.value })} />
            <Select aria-label="Role" value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>
              {['manager', 'cashier', 'store_keeper', 'rider'].map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
            </Select>
            <Button type="submit" pending={invite.pending}>Invite</Button>
          </form>
          {invite.error?.code !== 'mfa_required' && <ErrorNote error={invite.error} />}
        </Card>
      )}

      <Card className="space-y-3">
        <h2 className="font-display text-lg font-extrabold">Price tiers</h2>
        <ul className="space-y-1">{tiers.data?.tiers.map((x) => <li key={x.id}>{x.name} {x.is_wholesale && <Badge tone="wholesale">wholesale</Badge>} <span className="text-sm text-body">· {x.customers} customers</span></li>)}</ul>
        {b.can('prices.manage') && (
          <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void addTier.run(); }}>
            <Input aria-label="Tier name" required placeholder="e.g. VIP wholesale" value={tier.name} onChange={(e) => setTier({ ...tier, name: e.target.value })} className="flex-1" />
            <label className="flex items-center gap-2"><input type="checkbox" className="size-5" checked={tier.is_wholesale} onChange={(e) => setTier({ ...tier, is_wholesale: e.target.checked })} />Wholesale</label>
            <Button type="submit" variant="secondary" pending={addTier.pending}>Add tier</Button>
          </form>
        )}
        {addTier.error?.code !== 'mfa_required' && <ErrorNote error={addTier.error} />}
      </Card>
    </div>
  );
}
