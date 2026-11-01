import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useParams } from 'react-router';
// Fonts are bundled and served from our own origin (no third-party font requests).
import '@fontsource-variable/inter';
import '@fontsource-variable/bricolage-grotesque/opsz.css';
import './index.css';
import { StoreCtx, hostStoreSlug } from './lib/store-context';
import { StoreLayout } from './store/StoreLayout';
import { Catalogue } from './store/Catalogue';
import { ProductPage } from './store/ProductPage';
import { CartPage } from './store/CartPage';
import { CheckoutPage } from './store/CheckoutPage';
import { AccountPage } from './store/AccountPage';
import { OrdersPage } from './store/OrdersPage';
import { OrderPage } from './store/OrderPage';
import { Spinner } from './components/ui';
import { LOCALES, setLocale, type Locale } from './i18n';

// Everything staff-facing is split out of the storefront bundle.
const Dashboard = lazy(() => import('./dashboard/DashboardApp'));
const Landing = lazy(() => import('./Landing'));

function storeRoutes() {
  return (
    <>
      <Route index element={<Catalogue />} />
      <Route path="p/:id" element={<ProductPage />} />
      <Route path="cart" element={<CartPage />} />
      <Route path="checkout" element={<CheckoutPage />} />
      <Route path="account" element={<AccountPage />} />
      <Route path="orders" element={<OrdersPage />} />
      <Route path="orders/:id" element={<OrderPage />} />
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
        <Route path="/" element={<StoreCtx.Provider value={{ slug: subdomainSlug, base: '' }}><StoreLayout /></StoreCtx.Provider>}>{storeRoutes()}</Route>
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/" element={lazyEl(<Landing />)} />
      <Route path="/s/:slug" element={<PathStore />}>{storeRoutes()}</Route>
      <Route path="/dashboard/*" element={lazyEl(<Dashboard />)} />
    </Routes>
  );
}

const saved = (() => { try { return localStorage.getItem('trawer:locale'); } catch { return null; } })();
if (saved && (LOCALES as readonly string[]).includes(saved) && saved !== 'en') void setLocale(saved as Locale);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter><App /></BrowserRouter>
  </StrictMode>,
);
