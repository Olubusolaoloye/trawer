import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Download, ShieldCheck, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { invalidate, useApi, useMutation } from '../lib/use-api';
import { cx, formatNaira } from '../lib/format';
import { useStoreLocation } from '../lib/store-context';
import { Button, Card, ErrorNote, Field, Input, Skeleton } from '../components/ui';
import { t } from '../i18n';
import { PageHeader } from './PageHeader';

interface Shop { business_id: string; shop: string; marketing: boolean; whatsapp_updates: boolean; owing_kobo: number }

/** NDPA: see and control what each shop may send you, take a copy of your data, or delete your account. */
export default function PrivacyPage() {
  const { href } = useStoreLocation();
  const navigate = useNavigate();
  const me = useApi<{ user: { phone: string } | null }>('/api/auth/me');
  const { data } = useApi<{ shops: Shop[] }>(me.data?.user ? '/api/me/privacy' : null);
  const consent = useMutation(async (business_id: string, kind: 'marketing' | 'whatsapp_updates', granted: boolean) => {
    await api('/api/me/consent', { json: { business_id, kind, granted } });
    await invalidate('/api/me/privacy');
  });

  if (me.data && !me.data.user) { navigate(href('/account')); return null; }
  const owing = (data?.shops ?? []).reduce((n, s) => n + s.owing_kobo, 0);

  return (
    <div className="mx-auto max-w-md">
      <PageHeader title={t('privacy.title')} back={href('/account')} />
      <div className="space-y-4 px-4 pb-10">
        <p className="flex gap-2 rounded-2xl bg-green-50 p-4 text-sm text-green-ink"><ShieldCheck className="size-5 shrink-0" aria-hidden />{t('privacy.intro')}</p>

        <Card className="space-y-3">
          <h2 className="font-display text-lg font-extrabold">{t('privacy.messages')}</h2>
          {!data ? <Skeleton className="h-24" /> : data.shops.map((s) => (
            <fieldset key={s.business_id} className="space-y-2 border-t border-line-soft pt-3 first-of-type:border-0 first-of-type:pt-0">
              <legend className="font-bold">{s.shop}</legend>
              <Switch label={t('privacy.whatsappUpdates')} hint={t('privacy.whatsappUpdatesHint')} on={s.whatsapp_updates} onChange={(v) => void consent.run(s.business_id, 'whatsapp_updates', v)} />
              <Switch label={t('privacy.marketing')} hint={t('privacy.marketingHint')} on={s.marketing} onChange={(v) => void consent.run(s.business_id, 'marketing', v)} />
            </fieldset>
          ))}
          <ErrorNote error={consent.error} />
        </Card>

        <Card className="space-y-2">
          <h2 className="font-display text-lg font-extrabold">{t('privacy.copyTitle')}</h2>
          <p className="text-sm text-body">{t('privacy.copyBody')}</p>
          <a href="/api/me/export" download className="press inline-flex min-h-12 items-center gap-2 rounded-xl border-[1.5px] border-ink/85 bg-surface px-4 font-bold">
            <Download className="size-5" aria-hidden />{t('privacy.download')}
          </a>
        </Card>

        <DeleteAccount phone={me.data?.user?.phone ?? ''} owing={owing} onDone={async () => { await invalidate('/api/'); navigate(href('/')); }} />
      </div>
    </div>
  );
}

function Switch({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div><p className="text-[15px] font-semibold">{label}</p><p className="text-sm text-muted">{hint}</p></div>
      <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}
        className={cx('relative h-7 w-12 shrink-0 rounded-full transition-colors', on ? 'bg-green' : 'bg-line')}>
        <span className={cx('absolute top-0.5 size-6 rounded-full bg-white shadow transition-[left] duration-200', on ? 'left-[22px]' : 'left-0.5')} />
      </button>
    </div>
  );
}

function DeleteAccount({ phone, owing, onDone }: { phone: string; owing: number; onDone: () => void }) {
  const [step, setStep] = useState<'idle' | 'code'>('idle');
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState('');
  const send = useMutation(async () => { await api('/api/auth/otp', { json: { phone } }); setStep('code'); });
  const del = useMutation(async () => { await api('/api/me/delete', { json: { code, confirm } }); onDone(); });
  return (
    <Card className="space-y-3 border-red/30">
      <h2 className="font-display text-lg font-extrabold text-red-ink">{t('privacy.deleteTitle')}</h2>
      <p className="text-sm text-body">{t('privacy.deleteBody')}</p>
      {owing > 0 ? (
        <p role="note" className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-ink">{t('privacy.deleteOwing', { amount: formatNaira(owing) })}</p>
      ) : step === 'idle' ? (
        <>
          <Button variant="danger" onClick={() => void send.run()} pending={send.pending}><Trash2 className="size-5" aria-hidden />{t('privacy.deleteStart')}</Button>
          <ErrorNote error={send.error} />
        </>
      ) : (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void del.run(); }}>
          <Field label={t('privacy.code')} htmlFor="dcode" hint={t('privacy.codeHint', { phone })}>
            <Input id="dcode" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Field label={t('privacy.typeDelete')} htmlFor="dconf"><Input id="dconf" required value={confirm} onChange={(e) => setConfirm(e.target.value)} autoCapitalize="characters" /></Field>
          <ErrorNote error={del.error} />
          <Button type="submit" variant="danger" className="w-full" pending={del.pending} disabled={code.length !== 6 || confirm !== 'DELETE'}>{t('privacy.deleteForever')}</Button>
        </form>
      )}
    </Card>
  );
}
