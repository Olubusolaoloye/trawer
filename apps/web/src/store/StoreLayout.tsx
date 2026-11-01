import { useEffect } from 'react';
import { Link, Outlet } from 'react-router';
import { ShoppingBag, User } from 'lucide-react';
import { useApi } from '../lib/use-api';
import { useCart } from '../lib/cart';
import { useStoreLocation } from '../lib/store-context';
import { Badge, Empty, Spinner } from '../components/ui';
import { t } from '../i18n';

export interface StoreInfo {
  business: { id: string; slug: string; name: string; brand_colour: string; logo_url: string | null; phone: string | null; address: string | null; reservation_minutes: number };
  me: { id: string; name: string; buyer_type: string; wholesale_status: string; tier_name: string | null; is_wholesale_view: boolean } | null;
  categories: { category: string; n: number }[];
}

/** Readable text colour on a brand background (WCAG luminance). */
function inkFor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.4 ? '#111111' : '#ffffff';
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
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 bg-brand text-brand-ink shadow">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <Link to={href('/')} className="flex min-h-12 flex-1 items-center gap-3 truncate text-lg font-bold">
            {data.business.logo_url && <img src={data.business.logo_url} alt="" width={36} height={36} className="size-9 rounded-lg bg-white object-cover" />}
            <span className="truncate">{data.business.name}</span>
          </Link>
          <Link to={href('/account')} className="flex size-12 items-center justify-center rounded-xl hover:bg-black/10" aria-label={t('store.account')}>
            <User className="size-6" aria-hidden />
          </Link>
          <Link to={href('/cart')} className="relative flex size-12 items-center justify-center rounded-xl hover:bg-black/10" aria-label={`${t('store.cart')} (${count})`}>
            <ShoppingBag className="size-6" aria-hidden />
            {count > 0 && <span className="absolute right-0.5 top-0.5 min-w-5 rounded-full bg-white px-1 text-center text-xs font-bold text-stone-900">{count}</span>}
          </Link>
        </div>
        {data.me?.is_wholesale_view && (
          <div className="bg-black/15 px-4 py-1.5 text-center text-sm font-semibold">{t('store.wholesaleBadge')}{data.me.tier_name ? ` · ${data.me.tier_name}` : ''}</div>
        )}
        {data.me?.wholesale_status === 'pending' && (
          <div className="bg-black/15 px-4 py-1.5 text-center text-sm">{t('store.pendingBadge')}</div>
        )}
      </header>
      <main className="mx-auto max-w-5xl px-4 pb-24 pt-4">
        <Outlet />
      </main>
      {count > 0 && <div className="sr-only" aria-live="polite">{count}</div>}
      <footer className="mx-auto max-w-5xl px-4 pb-8 text-center text-xs text-stone-500">
        <Badge>Powered by Trawer</Badge>
      </footer>
    </div>
  );
}
