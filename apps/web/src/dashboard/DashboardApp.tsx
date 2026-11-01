import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useNavigate, useParams } from 'react-router';
import { Boxes, Home, Settings, ShoppingCart, Users } from 'lucide-react';
import { api } from '../lib/api';
import { invalidate, useApi, useMutation } from '../lib/use-api';
import { PhoneSignIn } from '../components/PhoneSignIn';
import { Button, Card, Empty, ErrorNote, Field, Input, Spinner } from '../components/ui';
import { cx, formatNaira } from '../lib/format';
import { t } from '../i18n';
import { BizCtx, useBiz, type BizInfo } from './context';

const Products = lazy(() => import('./Products'));
const Orders = lazy(() => import('./Orders'));
const Customers = lazy(() => import('./Customers'));
const SettingsPage = lazy(() => import('./SettingsPage'));

interface Me { user: { id: string; phone: string; aal: string } | null; staff: { business_id: string; role: string; name: string; slug: string }[] }

export default function DashboardApp() {
  const me = useApi<Me>('/api/auth/me');
  useEffect(() => { document.title = 'Trawer dashboard'; }, []);
  if (!me.data) return <Spinner />;
  if (!me.data.user) {
    return (
      <main className="mx-auto max-w-md px-4 py-10">
        <Card className="space-y-4"><h1 className="text-2xl font-bold">{t('auth.title')}</h1><PhoneSignIn onDone={() => invalidate('/api/auth/me')} /></Card>
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

function BusinessPicker({ me }: { me: Me }) {
  const navigate = useNavigate();
  useEffect(() => {
    if (me.staff.length === 1) navigate(`/dashboard/${me.staff[0]!.business_id}`, { replace: true });
    if (me.staff.length === 0) navigate('/dashboard/new', { replace: true });
  }, [me, navigate]);
  return (
    <main className="mx-auto max-w-md space-y-3 px-4 py-10">
      <h1 className="text-2xl font-bold">{t('dash.chooseBusiness')}</h1>
      {me.staff.map((s) => (
        <Link key={s.business_id} to={`/dashboard/${s.business_id}`} className="flex min-h-14 items-center justify-between rounded-2xl border bg-white px-4 font-semibold">
          {s.name}<span className="text-sm text-stone-500">{s.role}</span>
        </Link>
      ))}
      <Link to="/dashboard/new" className="block text-center font-semibold underline">{t('dash.createBusiness')}</Link>
    </main>
  );
}

function Onboarding() {
  const navigate = useNavigate();
  const [f, setF] = useState({ name: '', slug: '', kind: 'wholesaler', brand_colour: '#0F766E', display_name: '' });
  const [slugEdited, setSlugEdited] = useState(false);
  const slug = slugEdited ? f.slug : f.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const avail = useApi<{ available: boolean }>(slug.length >= 3 ? `/api/biz/slug-available/${slug}` : null);
  const create = useMutation(async () => {
    const r = await api<{ business_id: string }>('/api/biz', { json: { ...f, slug } });
    await invalidate('/api/auth/me');
    navigate(`/dashboard/${r.business_id}/settings?welcome=1`);
  });
  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void create.run(); }}>
        <h1 className="text-2xl font-bold">{t('onboard.title')}</h1>
        <Field label={t('onboard.name')} htmlFor="n"><Input id="n" required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={t('onboard.slug')} htmlFor="s" hint={`${slug || 'your-shop'}.trawer.shop`} error={avail.data && !avail.data.available ? t('onboard.slugTaken') : undefined}>
          <Input id="s" required value={slug} onChange={(e) => { setSlugEdited(true); setF({ ...f, slug: e.target.value.toLowerCase() }); }} />
        </Field>
        <Field label={t('onboard.kind')} htmlFor="k">
          <div className="grid grid-cols-2 gap-2">
            {(['wholesaler', 'retailer'] as const).map((k) => (
              <button key={k} type="button" aria-pressed={f.kind === k} onClick={() => setF({ ...f, kind: k })}
                className={cx('min-h-12 rounded-xl border-2 font-semibold capitalize', f.kind === k ? 'border-stone-900 bg-stone-900 text-white' : 'border-stone-300 bg-white')}>{k}</button>
            ))}
          </div>
        </Field>
        <Field label={t('onboard.colour')} htmlFor="c"><input id="c" type="color" className="h-12 w-24 rounded-lg" value={f.brand_colour} onChange={(e) => setF({ ...f, brand_colour: e.target.value })} /></Field>
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
  useEffect(() => {
    if (data) document.documentElement.style.setProperty('--brand', data.business.brand_colour);
  }, [data]);
  if (error) return <Empty>{t('error.permission_denied')}</Empty>;
  if (!data) return <Spinner />;
  const base = `/dashboard/${bid}`;
  const nav = [
    { to: base, label: t('dash.home'), icon: Home, end: true },
    { to: `${base}/products`, label: t('dash.products'), icon: Boxes },
    { to: `${base}/orders`, label: t('dash.orders'), icon: ShoppingCart },
    { to: `${base}/customers`, label: t('dash.customers'), icon: Users },
    { to: `${base}/settings`, label: t('dash.settings'), icon: Settings },
  ];
  return (
    <BizCtx.Provider value={{ ...data, base, can: (p) => data.permissions.includes(p) }}>
      <div className="min-h-dvh pb-20 md:pb-0 md:pl-56">
        <nav aria-label="Dashboard" className="fixed inset-x-0 bottom-0 z-30 flex border-t bg-white md:inset-y-0 md:left-0 md:right-auto md:w-56 md:flex-col md:border-r md:border-t-0 md:p-3">
          <p className="hidden truncate px-3 py-4 text-lg font-bold md:block">{data.business.name}</p>
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => cx('flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs font-semibold md:flex-none md:flex-row md:justify-start md:gap-3 md:rounded-xl md:px-3 md:text-base',
              isActive ? 'text-brand md:bg-stone-100' : 'text-stone-600')}>
              <n.icon className="size-6" aria-hidden />{n.label}
            </NavLink>
          ))}
        </nav>
        <main className="mx-auto max-w-5xl px-4 py-5">
          <Suspense fallback={<Spinner />}>
            <Routes>
              <Route index element={<HomePage />} />
              <Route path="products/*" element={<Products />} />
              <Route path="orders/*" element={<Orders />} />
              <Route path="customers/*" element={<Customers />} />
              <Route path="settings/*" element={<SettingsPage />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </BizCtx.Provider>
  );
}

function HomePage() {
  const b = useBiz();
  const s = b.stats;
  const tiles = [
    { label: t('dash.salesToday'), value: formatNaira(s.sales_today_kobo) },
    { label: t('dash.ordersToday'), value: s.orders_today, to: 'orders' },
    { label: t('dash.activeProducts'), value: s.products, to: 'products' },
    { label: t('dash.lowStock'), value: s.low_stock, to: 'products?low=1', warn: s.low_stock > 0 },
    { label: t('dash.pendingWholesale'), value: s.pending_wholesale, to: 'customers?pending=1', warn: s.pending_wholesale > 0 },
    { label: t('dash.conflicts'), value: s.conflicts, warn: s.conflicts > 0 },
  ];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{b.business.name}</h1>
        <a className="text-sm font-semibold underline" href={`/s/${b.business.slug}`} target="_blank" rel="noreferrer">{b.business.slug}.trawer.shop</a>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {tiles.map((x) => {
          const inner = (
            <Card className={cx('h-full', x.warn && 'border-amber-400 bg-amber-50')}>
              <p className="text-sm text-stone-600">{x.label}</p>
              <p className="mt-1 text-2xl font-extrabold">{x.value}</p>
            </Card>
          );
          return x.to ? <Link key={x.label} to={`${b.base}/${x.to}`}>{inner}</Link> : <div key={x.label}>{inner}</div>;
        })}
      </div>
      {b.can('products.draft') && <Link to={`${b.base}/products/new`}><Button size="lg" className="w-full md:w-auto">{t('dash.newProduct')}</Button></Link>}
    </div>
  );
}
