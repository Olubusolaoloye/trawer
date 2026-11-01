import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api } from '../lib/api';
import { invalidate, useApi, useMutation } from '../lib/use-api';
import { useStoreLocation } from '../lib/store-context';
import { PhoneSignIn } from '../components/PhoneSignIn';
import { Button, Card, ErrorNote, Field, Input } from '../components/ui';
import { cx } from '../lib/format';
import { t } from '../i18n';
import { useStore } from './StoreLayout';

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
      <Card className="mx-auto max-w-md space-y-4">
        <h1 className="text-2xl font-bold">{t('auth.title')}</h1>
        <PhoneSignIn onDone={() => undefined} />
      </Card>
    );
  }
  if (!store.data?.me) return <RegisterForm onDone={done} />;
  const c = store.data.me;
  return (
    <div className="mx-auto max-w-md space-y-4">
      <Card className="space-y-2">
        <h1 className="text-2xl font-bold">{c.name}</h1>
        <p className="text-stone-700">{me.data.user.phone}</p>
        <p className="text-sm text-stone-600">{c.buyer_type.replace('_', ' ')} · {c.wholesale_status === 'approved' ? 'wholesale approved' : c.wholesale_status === 'pending' ? 'wholesale pending' : c.tier_name ?? 'retail'}</p>
      </Card>
      <Link to={href('/orders')} className="flex min-h-14 items-center rounded-2xl border border-stone-200 bg-white px-4 font-semibold">{t('store.orders')}</Link>
      <Link to={href('/privacy')} className="flex min-h-14 items-center rounded-2xl border border-stone-200 bg-white px-4 font-semibold">Privacy & my data</Link>
      <Button variant="secondary" className="w-full" onClick={async () => { await api('/api/auth/sign-out', { json: {} }); invalidate('/api/'); navigate(href('/')); }}>{t('common.signOut')}</Button>
    </div>
  );
}

function RegisterForm({ onDone }: { onDone: () => void }) {
  const { slug } = useStoreLocation();
  const [type, setType] = useState<'wholesaler' | 'retailer' | 'retail_buyer'>('retail_buyer');
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
    <form className="mx-auto max-w-md space-y-4" onSubmit={(e) => { e.preventDefault(); void submit.run(); }}>
      <h1 className="text-2xl font-bold">{t('register.title')}</h1>
      <Field label={t('register.name')} htmlFor="name">
        <Input id="name" required minLength={2} autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-semibold">{t('register.type')}</legend>
        {opts.map((o) => (
          <label key={o.v} className={cx('flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border-2 bg-white p-3', type === o.v ? 'border-brand' : 'border-stone-300')}>
            <input type="radio" name="type" className="size-5 accent-[var(--color-brand)]" checked={type === o.v} onChange={() => setType(o.v)} />
            <span><span className="block font-semibold">{o.l}</span><span className="text-sm text-stone-600">{o.h}</span></span>
          </label>
        ))}
      </fieldset>
      {type !== 'retail_buyer' && (
        <Field label={t('register.businessName')} htmlFor="bn">
          <Input id="bn" value={form.business_name} onChange={(e) => setForm({ ...form, business_name: e.target.value })} />
        </Field>
      )}
      {type === 'wholesaler' && (
        <Field label={t('register.cac')} htmlFor="cac" hint="RC123456">
          <Input id="cac" required value={form.cac_number} onChange={(e) => setForm({ ...form, cac_number: e.target.value })} />
        </Field>
      )}
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" required className="mt-0.5 size-5" checked={form.accept_terms} onChange={(e) => setForm({ ...form, accept_terms: e.target.checked })} />
        <span>{t('register.terms')}</span>
      </label>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" className="mt-0.5 size-5" checked={form.marketing_opt_in} onChange={(e) => setForm({ ...form, marketing_opt_in: e.target.checked })} />
        <span>{t('register.marketing')}</span>
      </label>
      <ErrorNote error={submit.error} />
      <Button type="submit" size="lg" className="w-full" pending={submit.pending}>{t('register.submit')}</Button>
    </form>
  );
}
