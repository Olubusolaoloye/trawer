import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { Search, ShoppingBag, User } from 'lucide-react';
import { useApi } from '../lib/use-api';
import { useCart } from '../lib/cart';
import { useStoreLocation } from '../lib/store-context';
import { Empty, Spinner } from '../components/ui';
import { t } from '../i18n';

export interface StoreMe {
  id: string; name: string; business_name: string | null; buyer_type: string; wholesale_status: string; tier_name: string | null;
  is_wholesale_view: boolean; owing_kobo: number; oldest_owing_order: number | null; account_number: string | null; bank_name: string | null;
}
export interface StoreInfo {
  business: { id: string; slug: string; name: string; brand_colour: string; logo_url: string | null; phone: string | null; address: string | null; reservation_minutes: number };
  me: StoreMe | null;
  categories: { category: string; n: number }[];
}

/** Readable text colour on the shop's brand colour (WCAG luminance). */
export function inkFor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.4 ? '#0E1411' : '#ffffff';
}

export function useStore() {
  const { slug } = useStoreLocation();
  return useApi<StoreInfo>(`/api/store/${slug}`, { staleMs: 60_000 });
}

export function StoreLayout() {
  const { slug, href } = useStoreLocation();
  const { data, error } = useStore();
  const lines = useCart(slug);
  const count = lines.reduce((n, l) => n + l.qty, 0);
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const isHome = location.pathname === href('/') || location.pathname === `${href('/')}/`;
  const fullBleed = /\/(p|orders)\//.test(location.pathname) || /\/(cart|checkout)$/.test(location.pathname);

  useEffect(() => {
    if (!data) return;
    const root = document.documentElement;
    root.style.setProperty('--brand', data.business.brand_colour);
    root.style.setProperty('--brand-ink', inkFor(data.business.brand_colour));
    document.title = data.business.name;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', data.business.brand_colour);
  }, [data]);

  if (error) return <Empty>Store not found.</Empty>;
  if (!data) return <Spinner />;
  const me = data.me;
  return (
    <div className="min-h-dvh">
      {!fullBleed && (
        <header className="bg-brand text-brand-ink">
          <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 pb-5 pt-4">
            <div className="flex items-center gap-3">
              <Link to={href('/')} className="flex min-w-0 flex-1 items-center gap-3">
                {data.business.logo_url
                  ? <img src={data.business.logo_url} alt="" width={46} height={46} className="size-[46px] rounded-xl bg-white object-cover" />
                  : <span className="flex size-[46px] shrink-0 items-center justify-center rounded-xl bg-white font-display text-[22px] font-extrabold text-brand" aria-hidden>{data.business.name.charAt(0)}</span>}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate font-display text-[21px] font-extrabold leading-tight">{data.business.name}</span>
                  {data.business.address && <span className="truncate text-[13px] opacity-90">{data.business.address}</span>}
                </span>
              </Link>
              <Link to={href(me ? '/account' : '/account')} className="flex size-12 items-center justify-center rounded-xl bg-white/15" aria-label={t('store.account')}>
                <User className="size-6" aria-hidden />
              </Link>
              <Link to={href('/cart')} className="relative flex size-12 items-center justify-center rounded-xl bg-white/15" aria-label={`${t('store.cart')} (${count})`}>
                <ShoppingBag className="size-6" aria-hidden />
                {count > 0 && <span className="absolute right-1 top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-gold px-1 text-[11px] font-extrabold text-ink">{count}</span>}
              </Link>
            </div>
            <form role="search" onSubmit={(e) => { e.preventDefault(); navigate(`${href('/')}${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`); }}
              className="flex min-h-13 items-center gap-2.5 rounded-xl bg-white px-4 text-muted">
              <Search className="size-5 shrink-0" aria-hidden />
              <input type="search" aria-label={t('common.search')} placeholder={t('store.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-base font-medium text-ink outline-none placeholder:text-muted" />
            </form>
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
      <main className={fullBleed ? '' : 'mx-auto max-w-5xl px-4 pb-28 pt-4'}>
        <Outlet />
      </main>
      {!fullBleed && (
        <footer className={isHome && count > 0 ? 'pb-24 text-center text-xs text-muted' : 'pb-8 text-center text-xs text-muted'}>
          {t('store.poweredBy')}
        </footer>
      )}
    </div>
  );
}
