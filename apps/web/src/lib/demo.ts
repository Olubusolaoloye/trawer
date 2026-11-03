/**
 * Demo build (VITE_DEMO=1): the app runs with sample data and an in-browser stand-in for the API,
 * with hash URLs so it can be hosted as a single static page. In normal builds DEMO is the constant
 * `false`, so every branch below is removed by the bundler.
 */
export const DEMO = import.meta.env.VITE_DEMO === '1';

/** Query string of the current page (in the demo it lives after the `#`). */
export function pageSearch(): URLSearchParams {
  if (!DEMO) return new URLSearchParams(window.location.search);
  const h = window.location.hash, i = h.indexOf('?');
  return new URLSearchParams(i < 0 ? '' : h.slice(i + 1));
}

/** Full-page navigation to an app path. */
export function hardNav(path: string): void {
  if (DEMO) window.location.hash = path;
  else window.location.assign(path);
}

/** Link to an app page as it appears in the address bar. */
export const pageHref = (path: string): string => (DEMO ? `${window.location.pathname}${window.location.search}#${path}` : path);

/** Ask before a destructive action (the demo host blocks browser dialogs, so the demo just proceeds). */
export const ask = (message: string): boolean => DEMO || window.confirm(message);

/** postMessage between the designer and its preview frame (the demo host gives frames an opaque origin). */
export const msgTarget = (): string => (DEMO ? '*' : window.location.origin);
export const msgOriginOk = (e: MessageEvent): boolean => DEMO || e.origin === window.location.origin;
