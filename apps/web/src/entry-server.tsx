/**
 * Server rendering of storefront pages (built with `vite build --ssr`, loaded by the API server).
 * The API passes in the same JSON answers the browser would have fetched; the page is rendered
 * from them, and the browser picks up from that HTML (hydrateRoot) with the same data.
 */
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { resetCache, seedCache } from './lib/use-api';
import { productsUrl, featuredUrl } from './store/Catalogue';
import { storeThemeVars } from './lib/theme';

export { productsUrl, featuredUrl, storeThemeVars };

export function render(url: string, data: Record<string, unknown>, subdomainSlug: string | null): string {
  // Rendering is synchronous, so this request's data can't leak into another's.
  resetCache();
  seedCache(data);
  try {
    return renderToString(
      <StrictMode>
        <ErrorBoundary>
          <StaticRouter location={url}><App subdomainSlug={subdomainSlug} /></StaticRouter>
        </ErrorBoundary>
      </StrictMode>,
    );
  } finally {
    resetCache();
  }
}
