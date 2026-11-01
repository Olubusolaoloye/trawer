import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ChevronRight, Layers } from 'lucide-react';
import { api } from '../lib/api';
import { invalidate, useApi, useMutation } from '../lib/use-api';
import { useStoreLocation } from '../lib/store-context';
import { PhoneSignIn } from '../components/PhoneSignIn';
import { Badge, Button, ErrorNote, Field, Input } from '../components/ui';
import { cx, formatNaira } from '../lib/format';
import { LOCALES, setLocale, t, type Locale } from '../i18n';
import { useStore } from './StoreLayout';
import { PageHeader } from './PageHeader';

export function AccountPage() {
  const { href } = useStoreLocation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const me = useApi<{ user: { phone: string } | null }>('/api/auth/me');
  const store = useStore();
  const next = params.get('next');
  const done = () => navigate(next ? href(next) : href('/'));

  if (!me.data) return null;
  if (!me.data.user) {
    return (
      <div className="mx-auto max-w-md">
        <PageHeader title={t('auth.title')} back={href('/')} />
        <div className="px-4">
          {params.get('wholesale') && <p className="mb-4 rounded-2xl bg-indigo-50 p-4 text-sm text-indigo">{t('register.wholesaleIntro')}</p>}
          <PhoneSignIn onDone={() => undefined} />
        </div>
      </div>
    );
  }
  if (!store.data?.me) return <RegisterForm onDone={done} wholesale={!!params.get('wholesale')} />;
  const c = store.data.me;
  return (
    <div className="mx-auto max-w-md">
      <PageHeader title={t('store.account')} back={href('/')} />
      <div className="space-y-3 px-4 pb-8">
        <section className={cx('space-y-2 rounded-2xl p-5', c.is_wholesale_view ? 'dots bg-indigo text-white' : 'border border-line bg-surface')}>
          <p className="font-display text-2xl font-extrabold">{c.business_name ?? c.name}</p>
          <p className={c.is_wholesale_view ? 'text-[#DCE0F7]' : 'text-body'}>{me.data.user.phone}</p>
          {c.is_wholesale_view ? <Badge tone="warn">{t('store.wholesaleBadge')}{c.tier_name ? ` · ${c.tier_name}` : ''}</Badge>
            : c.wholesale_status === 'pending' ? <Badge tone="info">{t('store.pendingBadge')}</Badge>
            : <Badge>{c.tier_name ?? t('register.retailBuyer')}</Badge>}
        </section>
        {c.owing_kobo > 0 && <p className="rounded-2xl bg-red-50 p-4 font-bold">{t('store.youOwe', { amount: formatNaira(c.owing_kobo) })}</p>}
        {c.account_number && (
          <p className="rounded-2xl border border-line bg-surface p-4 text-sm">{t('store.yourAccountLine', { n: c.account_number, bank: c.bank_name ?? '' })}</p>
        )}
        {[{ to: '/orders', label: t('store.orders') }].map((l) => (
          <Link key={l.to} to={href(l.to)} className="flex min-h-14 items-center justify-between rounded-2xl border border-line bg-surface px-4 font-bold">{l.label}<ChevronRight className="size-5" aria-hidden /></Link>
        ))}
        <LanguagePicker />
        <Button variant="secondary" className="w-full" onClick={async () => { await api('/api/auth/sign-out', { json: {} }); await invalidate('/api/'); navigate(href('/')); }}>{t('common.signOut')}</Button>
      </div>
    </div>
  );
}

const LOCALE_NAMES: Record<Locale, string> = { en: 'English', pcm: 'Pidgin', yo: 'Yorùbá', ha: 'Hausa', ig: 'Igbo' };
export function LanguagePicker() {
  const [, force] = useState(0);
  const current = (() => { try { return (localStorage.getItem('trawer:locale') as Locale) ?? 'en'; } catch { return 'en'; } })();
  return (
    <fieldset className="rounded-2xl border border-line bg-surface p-4">
      <legend className="sr-only">{t('common.language')}</legend>
      <p className="mb-2 text-sm font-bold">{t('common.language')}</p>
      <div className="flex flex-wrap gap-2">
        {LOCALES.map((l) => (
          <button key={l} type="button" aria-pressed={current === l} onClick={async () => { await setLocale(l); force((n) => n + 1); location.reload(); }}
            className={cx('min-h-11 rounded-full border-2 px-4 text-sm font-bold', current === l ? 'border-ink bg-ink text-paper' : 'border-line')}>{LOCALE_NAMES[l]}</button>
        ))}
      </div>
    </fieldset>
  );
}

function RegisterForm({ onDone, wholesale }: { onDone: () => void; wholesale: boolean }) {
  const { slug, href } = useStoreLocation();
  const [type, setType] = useState<'wholesaler' | 'retailer' | 'retail_buyer'>(wholesale ? 'wholesaler' : 'retail_buyer');
  const [form, setForm] = useState({ name: '', business_name: '', cac_number: '', accept_terms: false, marketing_opt_in: false });
  const submit = useMutation(async () => {
    await api(`/api/store/${slug}/register`, { json: { ...form, buyer_type: type, cac_number: form.cac_number || undefined, business_name: form.business_name || undefined } });
    await invalidate(`/api/store/${slug}`);
    onDone();
  });
  const opts = [
    { v: 'retail_buyer', l: t('register.retailBuyer'), h: t('register.retailBuyerHint') },
    { v: 'retailer', l: t('register.retailer'), h: t('register.retailerHint') },
    { v: 'wholesaler', l: t('register.wholesaler'), h: t('register.wholesalerHint') },
  ] as const;
  return (
    <form className="mx-auto max-w-md" onSubmit={(e) => { e.preventDefault(); void submit.run(); }}>
      <PageHeader title={t('register.title')} back={href('/')} />
      <div className="space-y-4 px-4 pb-8">
        <Field label={t('register.name')} htmlFor="name">
          <Input id="name" required minLength={2} autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-[15px] font-bold">{t('register.type')}</legend>
          {opts.map((o) => (
            <label key={o.v} className={cx('flex min-h-16 cursor-pointer items-center gap-3 rounded-2xl border-2 bg-surface p-3.5',
              type === o.v ? (o.v === 'wholesaler' ? 'border-indigo' : 'border-ink') : 'border-line')}>
              <input type="radio" name="type" className="size-5 accent-ink" checked={type === o.v} onChange={() => setType(o.v)} />
              <span className="flex-1"><span className="block font-bold">{o.l}</span><span className="text-sm text-muted">{o.h}</span></span>
              {o.v === 'wholesaler' && <Layers className="size-5 text-indigo" aria-hidden />}
            </label>
          ))}
        </fieldset>
        {type !== 'retail_buyer' && (
          <Field label={t('register.businessName')} htmlFor="bn">
            <Input id="bn" value={form.business_name} onChange={(e) => setForm({ ...form, business_name: e.target.value })} />
          </Field>
        )}
        {type === 'wholesaler' && (
          <>
            <Field label={t('register.cac')} htmlFor="cac" hint="RC123456">
              <Input id="cac" required value={form.cac_number} onChange={(e) => setForm({ ...form, cac_number: e.target.value })} />
            </Field>
            <p className="rounded-2xl bg-indigo-50 p-3.5 text-sm text-indigo">{t('register.approvalNote')}</p>
          </>
        )}
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" required className="mt-0.5 size-5 accent-green" checked={form.accept_terms} onChange={(e) => setForm({ ...form, accept_terms: e.target.checked })} />
          <span>{t('register.terms')}</span>
        </label>
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-0.5 size-5 accent-green" checked={form.marketing_opt_in} onChange={(e) => setForm({ ...form, marketing_opt_in: e.target.checked })} />
          <span>{t('register.marketing')}</span>
        </label>
        <ErrorNote error={submit.error} />
        <Button type="submit" size="lg" className="w-full" pending={submit.pending}>{t('register.submit')}</Button>
      </div>
    </form>
  );
}
