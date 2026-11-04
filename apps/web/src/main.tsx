import { StrictMode, Suspense, lazy } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router';
// Fonts are bundled and served from our own origin (no third-party font requests).
import '@fontsource-variable/inter';
import '@fontsource-variable/bricolage-grotesque/opsz.css';
import './index.css';
import { hostStoreSlug } from './lib/store-context';
import { App } from './App';
import { LOCALES, setLocale, type Locale } from './i18n';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installGlobalHandlers } from './lib/monitor';
import { startEarlyFetches } from './lib/early';
import { seedCache } from './lib/use-api';
import { startVitals } from './lib/vitals';

const saved = (() => { try { return localStorage.getItem('trawer:locale'); } catch { return null; } })();
const otherLocale = !!saved && (LOCALES as readonly string[]).includes(saved) && saved !== 'en';
// Load the buyer's language before the first render (server-rendered pages are in English).
const localeReady = otherLocale ? setLocale(saved as Locale).catch(() => undefined) : Promise.resolve();

// Demo build: install the in-browser sample backend before anything talks to the API.
// (Inline env check so normal builds drop the demo code entirely.)
const DEMO = import.meta.env.VITE_DEMO === '1';
const ready = Promise.all([DEMO ? import('./demo/mock').then((m) => m.install()) : undefined, localeReady]);
const Router = DEMO ? HashRouter : BrowserRouter;
const DemoBar = DEMO ? lazy(() => import('./demo/DemoBar')) : null;

// After a deploy, a tab opened earlier may ask for script files that no longer exist: reload once
// to pick up the new version instead of showing an error.
window.addEventListener('vite:preloadError', (e) => {
  try {
    if (sessionStorage.getItem('trawer:reloaded') === location.pathname) return;
    sessionStorage.setItem('trawer:reloaded', location.pathname);
  } catch { return; }
  e.preventDefault();
  location.reload();
});

/** Data a server-rendered page was made with (a non-executable JSON block; see the API's ssr.ts). */
function serverData(): Record<string, unknown> | null {
  const el = document.getElementById('ssr-data');
  if (!el?.textContent) return null;
  try { return JSON.parse(el.textContent) as Record<string, unknown>; } catch { return null; }
}

void ready.then(() => {
  const ssr = DEMO ? null : serverData();
  if (ssr) seedCache(ssr);
  if (!DEMO) {
    installGlobalHandlers();
    if (!ssr) startEarlyFetches();
    // Speed tracking starts when the browser is idle (observers replay earlier entries), never before the page.
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1));
    idle(() => startVitals(!!hostStoreSlug()));
  }
  const root = document.getElementById('root')!;
  const tree = (
    <StrictMode>
      <ErrorBoundary>
        <Router>
          {DemoBar && <Suspense fallback={null}><DemoBar /></Suspense>}
          <App subdomainSlug={hostStoreSlug()} />
        </Router>
      </ErrorBoundary>
    </StrictMode>
  );
  if (ssr && root.firstElementChild && !otherLocale) {
    hydrateRoot(root, tree);
    // Entrance animations are off for the server-rendered first paint; back on for later pages.
    requestAnimationFrame(() => delete document.documentElement.dataset.ssr);
  } else {
    delete document.documentElement.dataset.ssr;
    createRoot(root).render(tree);
  }
});
