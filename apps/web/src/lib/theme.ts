/**
 * Applies a shop's storefront design to the page as CSS variables (no inline CSS from the
 * shop is ever accepted: every value here comes from our own closed lists).
 * Fonts are bundled and only fetched (from our own origin) when a shop picks them.
 */
import { THEME_PALETTES, type FontChoice, type StorefrontDesign as Storefront } from '@trawer/core/storefront-theme';

export type { Storefront };

const FONT_STACK: Record<FontChoice, string> = {
  grotesque: '"Bricolage Grotesque Variable", "Inter Variable", system-ui, sans-serif',
  serif: '"Fraunces Variable", Georgia, "Times New Roman", serif',
  rounded: '"Nunito Variable", "Inter Variable", system-ui, sans-serif',
  classic: '"Inter Variable", system-ui, sans-serif',
};

const loaded = new Set<FontChoice>(['grotesque', 'classic']);
export function loadFont(f: FontChoice): Promise<unknown> {
  if (loaded.has(f)) return Promise.resolve();
  loaded.add(f);
  return f === 'serif' ? import('@fontsource-variable/fraunces') : import('@fontsource-variable/nunito');
}

const RADIUS = {
  sharp: { xl: '6px', '2xl': '8px', '3xl': '10px', card: '6px' },
  soft: { xl: '14px', '2xl': '20px', '3xl': '26px', card: '20px' },
  round: { xl: '999px', '2xl': '26px', '3xl': '32px', card: '28px' },
} as const;

/** Readable text colour on a background colour (WCAG relative luminance). */
export function inkFor(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.4 ? '#0E1411' : '#ffffff';
}

const VARS = ['--brand', '--brand-ink', '--color-paper', '--color-surface', '--color-ink', '--color-ink-2', '--color-body', '--color-muted', '--color-line', '--color-line-soft',
  '--display-font', '--r-xl', '--r-2xl', '--r-3xl', '--r-card', '--card-shadow'];

export function applyStoreTheme(design: Storefront, brand: string, el: HTMLElement = document.documentElement): () => void {
  const p = THEME_PALETTES[design.theme];
  const r = RADIUS[design.radius];
  const set = (k: string, v: string) => el.style.setProperty(k, v);
  set('--brand', brand);
  set('--brand-ink', inkFor(brand));
  set('--color-paper', p.canvas);
  set('--color-surface', p.surface);
  set('--color-ink', p.ink);
  set('--color-ink-2', `color-mix(in srgb, ${p.ink} 86%, ${p.canvas})`);
  set('--color-body', p.body);
  set('--color-muted', p.muted);
  set('--color-line', p.line);
  set('--color-line-soft', p.soft);
  set('--display-font', FONT_STACK[design.font]);
  set('--r-xl', r.xl); set('--r-2xl', r['2xl']); set('--r-3xl', r['3xl']); set('--r-card', r.card);
  set('--card-shadow', design.theme === 'bold' ? '4px 4px 0 #111111'
    : p.dark ? '0 1px 0 rgb(255 255 255 / 0.04) inset, 0 12px 30px -18px rgb(0 0 0 / 0.7)'
    : '0 1px 2px rgb(14 20 17 / 0.04), 0 10px 28px -16px rgb(14 20 17 / 0.18)');
  el.dataset.storeTheme = design.theme;
  el.style.colorScheme = p.dark ? 'dark' : 'light';
  void loadFont(design.font);
  return () => {
    for (const k of VARS) el.style.removeProperty(k);
    delete el.dataset.storeTheme;
    el.style.removeProperty('color-scheme');
  };
}
