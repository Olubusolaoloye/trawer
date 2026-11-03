/**
 * Applies a shop's storefront design to the page as CSS variables (no inline CSS from the
 * shop is ever accepted: every value here comes from our own closed lists).
 * Fonts are bundled and only fetched (from our own origin) when a shop picks them.
 */
import { ACCENT_FILLS, THEME_PALETTES, mix, onColour, readableOnAll, type FontChoice, type StorefrontDesign as Storefront } from '@trawer/core/storefront-theme';

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

/** Readable text colour on a background colour (whichever of white / near-black contrasts more). */
export const inkFor = onColour;

const VARS = ['--brand', '--brand-ink', '--brand-text', '--accent', '--accent-ink', '--accent-text', '--accent-soft', '--color-paper', '--color-surface', '--color-ink', '--color-ink-2', '--color-body', '--color-muted', '--color-line', '--color-line-soft',
  '--display-font', '--r-xl', '--r-2xl', '--r-3xl', '--r-card', '--card-shadow'];

/** The shop's look as CSS variables (also written into server-rendered pages, so the first paint is on-brand). */
export function storeThemeVars(design: Storefront, brand: string): Record<string, string> {
  const p = THEME_PALETTES[design.theme];
  const r = RADIUS[design.radius];
  const accent = design.accent === 'brand' || !design.accent ? brand : ACCENT_FILLS[design.accent];
  const soft = mix(p.surface, accent, 0.14);
  return {
    '--brand': brand,
    '--brand-ink': inkFor(brand),
    // Brand as text (prices, links) on this theme: adjusted until it passes WCAG AA.
    '--brand-text': readableOnAll(brand, [p.surface, p.canvas]),
    '--accent': accent,
    '--accent-ink': onColour(accent),
    // Accent text sits on cards, the page and its own tint: readable on all three.
    '--accent-text': readableOnAll(accent, [p.surface, p.canvas, soft]),
    '--accent-soft': soft,
    '--color-paper': p.canvas,
    '--color-surface': p.surface,
    '--color-ink': p.ink,
    '--color-ink-2': `color-mix(in srgb, ${p.ink} 86%, ${p.canvas})`,
    '--color-body': p.body,
    '--color-muted': p.muted,
    '--color-line': p.line,
    '--color-line-soft': p.soft,
    '--display-font': FONT_STACK[design.font],
    '--r-xl': r.xl, '--r-2xl': r['2xl'], '--r-3xl': r['3xl'], '--r-card': r.card,
    '--card-shadow': design.theme === 'bold' ? '4px 4px 0 #111111'
      : p.dark ? '0 1px 0 rgb(255 255 255 / 0.04) inset, 0 12px 30px -18px rgb(0 0 0 / 0.7)'
      : '0 1px 2px rgb(14 20 17 / 0.04), 0 10px 28px -16px rgb(14 20 17 / 0.18)',
    'color-scheme': p.dark ? 'dark' : 'light',
  };
}

export function applyStoreTheme(design: Storefront, brand: string, el: HTMLElement = document.documentElement): () => void {
  for (const [k, v] of Object.entries(storeThemeVars(design, brand))) el.style.setProperty(k, v);
  el.dataset.storeTheme = design.theme;
  void loadFont(design.font);
  return () => {
    for (const k of VARS) el.style.removeProperty(k);
    delete el.dataset.storeTheme;
    el.style.removeProperty('color-scheme');
  };
}
