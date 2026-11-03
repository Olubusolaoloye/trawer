import { createContext, useContext, useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { Camera, MapPin, MessageCircle, Music2, Search, ShoppingBag, User } from 'lucide-react';
import { useApi } from '../lib/use-api';
import { msgOriginOk, msgTarget, pageSearch } from '../lib/demo';
import { useCart } from '../lib/cart';
import { useStoreLocation } from '../lib/store-context';
import { applyStoreTheme, type Storefront } from '../lib/theme';
import { cx } from '../lib/format';
import { Empty, ProductGridSkeleton, Skeleton } from '../components/ui';
import { t } from '../i18n';
import { StoreTabBar } from './kit';

export { inkFor } from '../lib/theme';

export interface StoreMe {
  id: string; name: string; business_name: string | null; buyer_type: string; wholesale_status: string; tier_name: string | null;
  is_wholesale_view: boolean; owing_kobo: number; oldest_owing_order: number | null; account_number: string | null; bank_name: string | null;
}
export type StoreDesign = Storefront & { hero: Storefront['hero'] & { image_url: string | null } };
export interface StoreInfo {
  business: { id: string; slug: string; name: string; brand_colour: string; logo_url: string | null; phone: string | null; address: string | null; reservation_minutes: number };
  me: StoreMe | null;
  categories: { category: string; n: number }[];
  design: StoreDesign;
}

/** Draft design pushed by the dashboard's store designer (same-origin iframe only). */
interface PreviewDraft { design: StoreDesign; brand_colour: string; logo_url: string | null }
const PREVIEW = typeof window !== 'undefined' && window.parent !== window && pageSearch().get('design_preview') === '1';

const PreviewCtx = createContext<PreviewDraft | null>(null);

export function useStore() {
  const { slug } = useStoreLocation();
  const res = useApi<StoreInfo>(`/api/store/${slug}`, { staleMs: 60_000 });
  const draft = useContext(PreviewCtx);
  if (!res.data || !draft) return res;
  return { ...res, data: { ...res.data, design: draft.design, business: { ...res.data.business, brand_colour: draft.brand_colour, logo_url: draft.logo_url } } };
}

function usePreviewDraft(): PreviewDraft | null {
  const [draft, setDraft] = useState<PreviewDraft | null>(null);
  useEffect(() => {
    if (!PREVIEW) return;
    const onMsg = (e: MessageEvent) => {
      if (!msgOriginOk(e) || e.source !== window.parent) return;
      const m = e.data as { type?: string; draft?: PreviewDraft };
      if (m?.type === 'trawer:design' && m.draft) setDraft(m.draft);
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage({ type: 'trawer:ready' }, msgTarget());
    return () => window.removeEventListener('message', onMsg);
  }, []);
  return draft;
}

export function StoreLayout() {
  const draft = usePreviewDraft();
  return <PreviewCtx.Provider value={draft}><StoreShell /></PreviewCtx.Provider>;
}

function StoreShell() {
  const { slug, href } = useStoreLocation();
  const { data, error } = useStore();
  const lines = useCart(slug);
  const count = lines.reduce((n, l) => n + l.qty, 0);
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const isHome = location.pathname === href('/') || location.pathname === `${href('/')}/`;
  // Only the home page has the shop header + footer; inner pages draw their own header band.
  const fullBleed = !isHome;
  const rest = isHome ? '/' : location.pathname.slice(href('/').length).replace(/\/$/, '');
  const tabbed = isHome || ['/search', '/orders', '/account'].includes(rest.startsWith('/') ? rest : `/${rest}`);

  useEffect(() => {
    if (!data) return;
    const undo = applyStoreTheme(data.design, data.business.brand_colour);
    document.title = data.business.name;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', data.design.header === 'brand' ? data.business.brand_colour : getComputedStyle(document.documentElement).getPropertyValue('--color-paper'));
    return undo;
  }, [data]);

  if (error) return <Empty>Store not found.</Empty>;
  if (!data) return <ShellSkeleton />;
  const { business: b, design: d, me } = data;
  const style = d.header;
  const onBrand = style === 'brand';

  return (
    <div className="flex min-h-dvh flex-col bg-paper text-ink">
      {d.announcement.enabled && d.announcement.text && !fullBleed && (
        <p className="bg-ink px-4 py-2 text-center text-[13px] font-semibold text-paper">{d.announcement.text}</p>
      )}
      {!fullBleed && (
        <header className={cx(
          style === 'brand' && 'glow-brand bg-brand text-brand-ink',
          style === 'clean' && 'border-b border-line bg-surface text-ink',
          style === 'glass' && 'glass sticky top-0 z-40 border-b border-line/60 text-ink',
        )}>
          <div className={cx('mx-auto flex max-w-6xl flex-col gap-3.5 px-4', style === 'glass' ? 'py-3 sm:flex-row sm:items-center' : 'pb-5 pt-4 sm:flex-row sm:items-center sm:py-4')}>
            <div className="flex items-center gap-3 sm:min-w-0 sm:flex-1">
              <Link to={href('/')} viewTransition className="flex min-w-0 flex-1 items-center gap-3">
                {b.logo_url
                  ? <img src={b.logo_url} alt="" width={46} height={46} className="size-[46px] rounded-xl bg-surface object-cover shadow-sm" />
                  : <span className={cx('flex size-[46px] shrink-0 items-center justify-center rounded-xl font-display text-[22px] font-extrabold shadow-sm', onBrand ? 'bg-surface text-brand' : 'bg-brand text-brand-ink')} aria-hidden>{b.name.charAt(0)}</span>}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-display text-[21px] font-extrabold leading-tight tracking-tight">{b.name}</span>
                  {b.address && <span className={cx('truncate text-[13px]', onBrand ? 'opacity-85' : 'text-muted')}>{b.address}</span>}
                </span>
              </Link>
            </div>
            <form role="search" data-field onSubmit={(e) => { e.preventDefault(); navigate(`${href('/search')}${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`); }}
              className={cx('flex min-h-12 items-center gap-2.5 rounded-xl px-4 text-muted transition-shadow focus-within:ring-4 sm:w-[min(420px,40vw)]',
                onBrand ? 'bg-surface shadow-[0_8px_24px_-14px_rgb(0_0_0/0.45)] focus-within:ring-white/35' : 'border border-line bg-paper focus-within:ring-ink/10')}>
              <Search className="size-5 shrink-0" aria-hidden />
              <input type="search" aria-label={t('common.search')} placeholder={t('store.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-base font-medium text-ink outline-none placeholder:text-muted focus-visible:outline-none" />
            </form>
            <div className="hidden gap-2 sm:flex"><HeaderIcons onBrand={onBrand} count={count} /></div>
          </div>
          {me?.is_wholesale_view && (
            <div className="dots bg-indigo px-4 py-2 text-center text-sm font-bold text-white">
              <span className="rounded-md bg-indigo px-2 py-0.5">{t('store.wholesaleBadge')}{me.tier_name && !/^wholesale$/i.test(me.tier_name) ? ` · ${me.tier_name}` : ''}</span>
            </div>
          )}
          {me?.wholesale_status === 'pending' && (
            <div className="bg-black/20 px-4 py-2 text-center text-sm font-semibold">{t('store.pendingBadge')}</div>
          )}
        </header>
      )}
      <main key={location.pathname} className={cx('rise flex flex-1 flex-col', !fullBleed && 'mx-auto w-full max-w-6xl px-4 pb-28 pt-5', fullBleed && tabbed && 'pb-28 sm:pb-8')}>
        <Outlet />
      </main>
      {!fullBleed && <StoreFooter data={data} padForCart={isHome && count > 0} />}
      {tabbed && !PREVIEW && <StoreTabBar count={count} />}
    </div>
  );
}

function HeaderIcons({ onBrand, count }: { onBrand: boolean; count: number }) {
  const { href } = useStoreLocation();
  const btn = cx('press relative flex size-12 items-center justify-center rounded-xl transition-colors', onBrand ? 'bg-white/15 hover:bg-white/25' : 'border border-line bg-surface hover:bg-line-soft');
  return (
    <>
      <Link to={href('/account')} viewTransition className={btn} aria-label={t('store.account')}><User className="size-6" aria-hidden /></Link>
      <Link to={href('/cart')} viewTransition className={btn} aria-label={`${t('store.cart')} (${count})`}>
        <ShoppingBag className="size-6" aria-hidden />
        {count > 0 && <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-gold px-1 text-[11px] font-extrabold text-ink ring-2 ring-paper">{count}</span>}
      </Link>
    </>
  );
}

function StoreFooter({ data, padForCart }: { data: StoreInfo; padForCart: boolean }) {
  const { business: b, design: d } = data;
  const s = d.socials;
  const links = [
    s.instagram && { href: `https://instagram.com/${encodeURIComponent(s.instagram)}`, label: `Instagram @${s.instagram}`, icon: Camera },
    s.tiktok && { href: `https://www.tiktok.com/@${encodeURIComponent(s.tiktok)}`, label: `TikTok @${s.tiktok}`, icon: Music2 },
    s.whatsapp && { href: `https://wa.me/${s.whatsapp.replace(/\D/g, '')}`, label: t('store.chatWhatsApp'), icon: MessageCircle },
  ].filter(Boolean) as { href: string; label: string; icon: typeof Camera }[];
  const hasAbout = d.about || links.length || b.address;
  return (
    <footer className={cx('border-t border-line/70 bg-surface', padForCart ? 'pb-44 sm:pb-28' : 'pb-28 sm:pb-8')}>
      {hasAbout && (
        <div className="mx-auto grid max-w-6xl gap-6 px-4 pt-8 sm:grid-cols-[1.4fr_1fr]">
          <div className="space-y-2">
            <p className="font-display text-lg font-extrabold">{b.name}</p>
            {d.about && <p className="max-w-prose whitespace-pre-line text-sm leading-relaxed text-body">{d.about}</p>}
            {b.address && <p className="flex items-center gap-1.5 text-sm text-muted"><MapPin className="size-4" aria-hidden />{b.address}</p>}
          </div>
          {links.length > 0 && (
            <ul className="flex flex-wrap content-start gap-2 sm:justify-end">
              {links.map((l) => (
                <li key={l.href}>
                  <a href={l.href} target="_blank" rel="noopener noreferrer" className="press inline-flex min-h-11 items-center gap-2 rounded-full border border-line bg-paper px-4 text-sm font-semibold hover:bg-line-soft">
                    <l.icon className="size-4" aria-hidden />{l.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="pt-6 text-center text-xs text-muted">{t('store.poweredBy')}</p>
    </footer>
  );
}

function ShellSkeleton() {
  return (
    <div className="min-h-dvh">
      <div className="skeleton h-[132px] rounded-none" />
      <div className="mx-auto max-w-6xl space-y-4 px-4 pt-5">
        <Skeleton className="h-40 w-full rounded-3xl" />
        <div className="flex gap-2">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-11 w-20 rounded-full" />)}</div>
        <ProductGridSkeleton n={4} />
      </div>
    </div>
  );
}
