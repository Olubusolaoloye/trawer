import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter, Route, Routes, useParams } from 'react-router';
// Fonts are bundled and served from our own origin (no third-party font requests).
import '@fontsource-variable/inter';
import '@fontsource-variable/bricolage-grotesque/opsz.css';
import './index.css';
import { StoreCtx, hostStoreSlug } from './lib/store-context';
import { StoreLayout } from './store/StoreLayout';
import { Catalogue } from './store/Catalogue';
import { CartPage } from './store/CartPage';
import { Spinner } from './components/ui';
import { LOCALES, setLocale, type Locale } from './i18n';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installGlobalHandlers } from './lib/monitor';
import { startEarlyFetches } from './lib/early';

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
const subdomainSlug = hostStoreSlug();

function App() {
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

const saved = (() => { try { return localStorage.getItem('trawer:locale'); } catch { return null; } })();
if (saved && (LOCALES as readonly string[]).includes(saved) && saved !== 'en') void setLocale(saved as Locale);

// Demo build: install the in-browser sample backend before anything talks to the API.
// (Inline env check so normal builds drop the demo code entirely.)
const DEMO = import.meta.env.VITE_DEMO === '1';
const ready = DEMO ? import('./demo/mock').then((m) => m.install()) : Promise.resolve();
const Router = DEMO ? HashRouter : BrowserRouter;
const DemoBar = DEMO ? lazy(() => import('./demo/DemoBar')) : null;

void ready.then(() => {
  if (!DEMO) { installGlobalHandlers(); startEarlyFetches(); }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <Router>
          {DemoBar && <Suspense fallback={null}><DemoBar /></Suspense>}
          <App />
        </Router>
      </ErrorBoundary>
    </StrictMode>,
  );
});
