import { Suspense, lazy } from 'react';
import { Route, Routes, useParams } from 'react-router';
import { StoreCtx } from './lib/store-context';
import { StoreLayout } from './store/StoreLayout';
import { Catalogue } from './store/Catalogue';
import { CartPage } from './store/CartPage';
import { Spinner } from './components/ui';

// Everything staff-facing is split out of the storefront bundle.
const Dashboard = lazy(() => import('./dashboard/DashboardApp'));
const Landing = lazy(() => import('./Landing'));
const TrackPage = lazy(() => import('./TrackPage'));
const InvoicePage = lazy(() => import('./InvoicePage'));
const PrivacyPage = lazy(() => import('./store/PrivacyPage'));
// Only the store home is in the first download; other store pages load when visited.
const ProductPage = lazy(() => import('./store/ProductPage').then((m) => ({ default: m.ProductPage })));
const CheckoutPage = lazy(() => import('./store/CheckoutPage').then((m) => ({ default: m.CheckoutPage })));
const AccountPage = lazy(() => import('./store/AccountPage').then((m) => ({ default: m.AccountPage })));
const OrdersPage = lazy(() => import('./store/OrdersPage').then((m) => ({ default: m.OrdersPage })));
const OrderPage = lazy(() => import('./store/OrderPage').then((m) => ({ default: m.OrderPage })));

function storeRoutes() {
  return (
    <>
      <Route index element={<Catalogue />} />
      <Route path="p/:id" element={lazyEl(<ProductPage />)} />
      <Route path="cart" element={<CartPage />} />
      <Route path="checkout" element={lazyEl(<CheckoutPage />)} />
      <Route path="account" element={lazyEl(<AccountPage />)} />
      <Route path="account/privacy" element={lazyEl(<PrivacyPage />)} />
      <Route path="orders" element={lazyEl(<OrdersPage />)} />
      <Route path="orders/:id" element={lazyEl(<OrderPage />)} />
    </>
  );
}

function PathStore() {
  const { slug = '' } = useParams();
  return <StoreCtx.Provider value={{ slug, base: `/s/${slug}` }}><StoreLayout /></StoreCtx.Provider>;
}

const lazyEl = (el: React.ReactNode) => <Suspense fallback={<Spinner />}>{el}</Suspense>;

/** The whole app's routes. `subdomainSlug` is set when the page is a shop's own subdomain. */
export function App({ subdomainSlug }: { subdomainSlug: string | null }) {
  if (subdomainSlug) {
    return (
      <Routes>
        <Route path="/t/:token" element={lazyEl(<TrackPage />)} />
        <Route path="/i/:token" element={lazyEl(<InvoicePage />)} />
        <Route path="/" element={<StoreCtx.Provider value={{ slug: subdomainSlug, base: '' }}><StoreLayout /></StoreCtx.Provider>}>{storeRoutes()}</Route>
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/" element={lazyEl(<Landing />)} />
      <Route path="/t/:token" element={lazyEl(<TrackPage />)} />
      <Route path="/i/:token" element={lazyEl(<InvoicePage />)} />
      <Route path="/s/:slug" element={<PathStore />}>{storeRoutes()}</Route>
      <Route path="/dashboard/*" element={lazyEl(<Dashboard />)} />
    </Routes>
  );
}

