import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useNavigate, useParams } from 'react-router';
import { Boxes, Home, Plus, Settings, ShoppingCart, Users } from 'lucide-react';
import { api } from '../lib/api';
import { invalidate, useApi, useMutation } from '../lib/use-api';
import { PhoneSignIn } from '../components/PhoneSignIn';
import { Button, Empty, ErrorNote, Field, Input, Spinner } from '../components/ui';
import { cx } from '../lib/format';
import { t } from '../i18n';
import { BizCtx, type BizInfo } from './context';

const TodayPage = lazy(() => import('./Today'));
const Products = lazy(() => import('./Products'));
const Orders = lazy(() => import('./Orders'));
const Customers = lazy(() => import('./Customers'));
const SettingsPage = lazy(() => import('./SettingsPage'));
const Tills = lazy(() => import('./Tills'));

interface Me { user: { id: string; phone: string; aal: string } | null; staff: { business_id: string; role: string; name: string; slug: string }[] }

export default function DashboardApp() {
  const me = useApi<Me>('/api/auth/me');
  useEffect(() => {
    document.title = 'Trawer';
    document.documentElement.style.removeProperty('--brand');
  }, []);
  if (!me.data) return <Spinner />;
  if (!me.data.user) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-4 py-10">
        <Logo />
        <h1 className="font-display text-4xl font-extrabold leading-tight tracking-tight">{t('dash.signInTitle')}</h1>
        <PhoneSignIn onDone={() => undefined} />
      </main>
    );
  }
  return (
    <Routes>
      <Route index element={<BusinessPicker me={me.data} />} />
      <Route path="new" element={<Onboarding />} />
      <Route path=":bid/*" element={<BusinessShell />} />
    </Routes>
  );
}

function Logo({ light }: { light?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex size-10 items-center justify-center rounded-xl bg-green" aria-hidden>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16M12 6v14" /><circle cx="18.5" cy="17.5" r="2.2" fill="#F2B705" stroke="none" /></svg>
      </span>
      <span className={cx('font-display text-2xl font-extrabold', light && 'text-white')}>trawer</span>
    </span>
  );
}

function BusinessPicker({ me }: { me: Me }) {
  const navigate = useNavigate();
  useEffect(() => {
    if (me.staff.length === 1) navigate(`/dashboard/${me.staff[0]!.business_id}`, { replace: true });
    if (me.staff.length === 0) navigate('/dashboard/new', { replace: true });
  }, [me, navigate]);
  return (
    <main className="mx-auto max-w-md space-y-3 px-4 py-10">
      <Logo />
      <h1 className="pt-4 font-display text-3xl font-extrabold">{t('dash.chooseBusiness')}</h1>
      {me.staff.map((s) => (
        <Link key={s.business_id} to={`/dashboard/${s.business_id}`} className="flex min-h-16 items-center justify-between rounded-2xl border border-line bg-white px-4 font-bold">
          {s.name}<span className="text-sm font-semibold capitalize text-muted">{s.role.replace('_', ' ')}</span>
        </Link>
      ))}
      <Link to="/dashboard/new" className="block py-3 text-center font-bold underline">{t('dash.createBusiness')}</Link>
    </main>
  );
}

function Onboarding() {
  const navigate = useNavigate();
  const [f, setF] = useState({ name: '', slug: '', kind: 'wholesaler', brand_colour: '#9A3412', display_name: '' });
  const [slugEdited, setSlugEdited] = useState(false);
  const slug = slugEdited ? f.slug : f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const avail = useApi<{ available: boolean }>(slug.length >= 3 ? `/api/biz/slug-available/${slug}` : null);
  const create = useMutation(async () => {
    const r = await api<{ business_id: string }>('/api/biz', { json: { ...f, slug } });
    await invalidate('/api/auth/me');
    navigate(`/dashboard/${r.business_id}/settings?welcome=1`);
  });
  const swatches = ['#9A3412', '#0B7A4B', '#23308C', '#7C3AED', '#BE185D', '#0E1411'];
  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <form className="space-y-5" onSubmit={(e) => { e.preventDefault(); void create.run(); }}>
        <Logo />
        <div>
          <h1 className="font-display text-4xl font-extrabold leading-tight tracking-tight">{t('onboard.title')}</h1>
          <p className="mt-1 text-body">{t('onboard.subtitle')}</p>
        </div>
        <Field label={t('onboard.name')} htmlFor="n"><Input id="n" required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Balogun Fabrics" /></Field>
        <Field label={t('onboard.slug')} htmlFor="s" hint={`${slug || 'your-shop'}.trawer.shop`} error={avail.data && !avail.data.available ? t('onboard.slugTaken') : undefined}>
          <Input id="s" required value={slug} onChange={(e) => { setSlugEdited(true); setF({ ...f, slug: e.target.value.toLowerCase() }); }} />
        </Field>
        <fieldset>
          <legend className="mb-2 text-[15px] font-bold">{t('onboard.kind')}</legend>
          <div className="grid grid-cols-2 gap-2">
            {(['wholesaler', 'retailer'] as const).map((k) => (
              <button key={k} type="button" aria-pressed={f.kind === k} onClick={() => setF({ ...f, kind: k })}
                className={cx('min-h-13 rounded-xl border-2 font-bold capitalize', f.kind === k ? 'border-ink bg-ink text-white' : 'border-line bg-white')}>{k}</button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="mb-2 text-[15px] font-bold">{t('onboard.colour')}</legend>
          <div className="flex flex-wrap items-center gap-3">
            {swatches.map((c) => (
              <button key={c} type="button" aria-label={c} aria-pressed={f.brand_colour === c} onClick={() => setF({ ...f, brand_colour: c })}
                className={cx('size-11 rounded-full', f.brand_colour === c ? 'border-[3px] border-white ring-[3px] ring-ink' : 'border-2 border-line')} style={{ background: c }} />
            ))}
            <input type="color" aria-label={t('onboard.customColour')} className="size-11 cursor-pointer rounded-full" value={f.brand_colour} onChange={(e) => setF({ ...f, brand_colour: e.target.value })} />
          </div>
        </fieldset>
        <Field label={t('onboard.yourName')} htmlFor="dn"><Input id="dn" value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></Field>
        <ErrorNote error={create.error} />
        <Button type="submit" size="lg" className="w-full" pending={create.pending}>{t('onboard.create')}</Button>
      </form>
    </main>
  );
}

function BusinessShell() {
  const { bid = '' } = useParams();
  const { data, error } = useApi<BizInfo>(`/api/biz/${bid}`);
  if (error) return <Empty>{t('error.permission_denied')}</Empty>;
  if (!data) return <Spinner />;
  const base = `/dashboard/${bid}`;
  const nav = [
    { to: base, label: t('dash.home'), icon: Home, end: true },
    { to: `${base}/orders`, label: t('dash.orders'), icon: ShoppingCart },
    { to: `${base}/products`, label: t('dash.products'), icon: Boxes },
    { to: `${base}/customers`, label: t('dash.customers'), icon: Users, badge: data.stats.pending_wholesale },
    { to: `${base}/settings`, label: t('dash.settings'), icon: Settings },
  ];
  return (
    <BizCtx.Provider value={{ ...data, base, can: (p) => data.permissions.includes(p) }}>
      <div className="min-h-dvh pb-24 lg:pb-0 lg:pl-60">
        {/* Desktop: ink side menu */}
        <nav aria-label="Dashboard" className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col gap-1.5 bg-ink px-4 py-5 text-white lg:flex">
          <div className="flex items-center gap-2.5 px-2 pb-5">
            <span className="flex size-[38px] items-center justify-center rounded-[11px] font-display font-extrabold" style={{ background: data.business.brand_colour }}>{data.business.name.charAt(0)}</span>
            <span className="flex min-w-0 flex-col"><b className="truncate text-[15px]">{data.business.name}</b><span className="truncate text-xs text-[#C9C3B6]">{data.business.slug}.trawer.shop</span></span>
          </div>
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => cx('flex min-h-11 items-center gap-3 rounded-xl px-3 text-[15px]',
              isActive ? 'bg-ink-2 font-bold text-white' : 'font-semibold text-[#E7E2D6] hover:bg-ink-2')}>
              {({ isActive }) => (<>
                <span className={cx('size-2 rounded-full', isActive ? 'bg-gold' : 'bg-transparent')} aria-hidden />
                <span className="flex-1">{n.label}</span>
                {!!n.badge && <span className="rounded-full bg-indigo px-2 text-xs font-bold">{n.badge}</span>}
              </>)}
            </NavLink>
          ))}
          <NavLink to={`${base}/tills`} className={({ isActive }) => cx('flex min-h-11 items-center gap-3 rounded-xl px-3 text-[15px]', isActive ? 'bg-ink-2 font-bold' : 'font-semibold text-[#E7E2D6] hover:bg-ink-2')}>
            <span className="size-2" aria-hidden /><span className="flex-1">{t('dash.tills')}</span>
            {data.stats.conflicts > 0 && <span className="rounded-full bg-red px-2 text-xs font-bold">{data.stats.conflicts}</span>}
          </NavLink>
          {data.permissions.includes('products.draft') && (
            <Link to={`${base}/products/new`} className="mt-auto flex min-h-12 items-center justify-center gap-2 rounded-xl bg-green font-bold"><Plus className="size-5" aria-hidden />{t('dash.newProduct')}</Link>
          )}
        </nav>

        {/* Phone: bottom tabs with the add button in the middle */}
        <nav aria-label="Dashboard" className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-around border-t border-line bg-white px-1.5 pb-3.5 pt-2 lg:hidden">
          {[nav[0]!, nav[1]!].map((n) => <TabLink key={n.to} {...n} />)}
          <Link to={`${base}/products/new`} aria-label={t('dash.newProduct')} className="-mt-7 flex size-15 items-center justify-center rounded-full border-4 border-paper bg-green shadow-[0_8px_20px_rgba(11,122,75,0.35)]">
            <Plus className="size-7 text-white" aria-hidden />
          </Link>
          {[nav[2]!, nav[3]!].map((n) => <TabLink key={n.to} {...n} />)}
        </nav>

        <main className="mx-auto max-w-6xl px-4 py-5 lg:px-10 lg:py-7">
          <Suspense fallback={<Spinner />}>
            <Routes>
              <Route index element={<TodayPage />} />
              <Route path="products/*" element={<Products />} />
              <Route path="orders/*" element={<Orders />} />
              <Route path="customers/*" element={<Customers />} />
              <Route path="settings/*" element={<SettingsPage />} />
              <Route path="tills" element={<Tills />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </BizCtx.Provider>
  );
}

function TabLink({ to, label, icon: Icon, end, badge }: { to: string; label: string; icon: typeof Home; end?: boolean; badge?: number }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => cx('relative flex min-h-13 w-16 flex-col items-center justify-center gap-0.5 text-xs', isActive ? 'font-extrabold text-green' : 'font-semibold text-body')}>
      <Icon className="size-6" aria-hidden />{label}
      {!!badge && <span className="absolute right-2 top-0 rounded-full bg-indigo px-1.5 text-[10px] font-bold text-white">{badge}</span>}
    </NavLink>
  );
}
