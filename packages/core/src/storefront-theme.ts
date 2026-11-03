/** Storefront design choices + theme palettes (no validation library: safe to ship to every shop page). */
export const THEMES = ['market', 'fresh', 'linen', 'midnight', 'bold'] as const;
export const FONTS = ['grotesque', 'serif', 'rounded', 'classic'] as const;
export const RADII = ['sharp', 'soft', 'round'] as const;
export const HEADERS = ['brand', 'clean', 'glass'] as const;
export const CARDS = ['classic', 'overlay', 'minimal'] as const;
export const DENSITIES = ['comfy', 'compact'] as const;
/** Second colour for quick actions (add buttons, badges, highlights). 'brand' = the shop colour. */
export const ACCENTS = ['coral', 'leaf', 'gold', 'berry', 'sky', 'brand'] as const;
export const SECTION_IDS = ['hero', 'categories', 'wholesale', 'reorder', 'featured', 'products'] as const;

export type Theme = (typeof THEMES)[number];
export type Accent = (typeof ACCENTS)[number];
export type FontChoice = (typeof FONTS)[number];
export type SectionId = (typeof SECTION_IDS)[number];

export interface StorefrontDesign {
  theme: Theme; accent: Accent; font: FontChoice; radius: (typeof RADII)[number]; header: (typeof HEADERS)[number]; card: (typeof CARDS)[number]; density: (typeof DENSITIES)[number];
  announcement: { enabled: boolean; text: string };
  hero: { enabled: boolean; title: string; subtitle: string; image_path: string | null; cta_label: string; cta_category: string | null };
  featured: { title: string; category: string | null };
  sections: { id: SectionId; on: boolean }[];
  show_stock: boolean;
  about: string;
  socials: { instagram: string; tiktok: string; whatsapp: string };
}

/** Theme palettes (applied as CSS variables on the store). The shop colour is always the accent. */
export const THEME_PALETTES: Record<Theme, { canvas: string; surface: string; ink: string; body: string; muted: string; line: string; soft: string; dark: boolean }> = {
  market: { canvas: '#FAF7F0', surface: '#FFFFFF', ink: '#0E1411', body: '#3E433C', muted: '#5B5F57', line: '#E4DED2', soft: '#F0EBE1', dark: false },
  fresh: { canvas: '#F3F4F8', surface: '#FFFFFF', ink: '#141B3C', body: '#3D4466', muted: '#5E6585', line: '#E2E5EE', soft: '#ECEEF4', dark: false },
  linen: { canvas: '#FFFFFF', surface: '#F7F5F2', ink: '#1A1A1A', body: '#404040', muted: '#666159', line: '#E9E5DF', soft: '#F1EEEA', dark: false },
  midnight: { canvas: '#0F1412', surface: '#19201C', ink: '#F4F1EA', body: '#D5D1C7', muted: '#A7A397', line: '#2C352F', soft: '#232B26', dark: true },
  bold: { canvas: '#FFF8E7', surface: '#FFFFFF', ink: '#111111', body: '#2B2B2B', muted: '#5A5650', line: '#111111', soft: '#FCEFC9', dark: false },
};

export const ACCENT_FILLS: Record<Exclude<Accent, 'brand'>, string> = {
  coral: '#F0703F', leaf: '#2FA36B', gold: '#F2B705', berry: '#D9467A', sky: '#2F7FE0',
};

// ---- colour maths (WCAG 2.x), so every shop colour stays readable whatever the owner picks ----

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');

export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => v / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x! + 0.05) / (y! + 0.05);
}

/** `a` moved `t` (0–1) of the way towards `b`. */
export function mix(a: string, b: string, t: number): string {
  const [p, q] = [rgb(a), rgb(b)];
  return `#${p.map((v, i) => hex2(v + (q[i]! - v) * t)).join('')}`;
}

/** Text/icon colour for something filled with `fill`: whichever of white or near-black reads better. */
export function onColour(fill: string): string {
  return contrast(fill, '#FFFFFF') >= contrast(fill, '#0E1411') ? '#FFFFFF' : '#0E1411';
}

/** `colour` darkened (light backgrounds) or lightened (dark ones) just enough to reach `min` contrast on `bg`. */
export function readableOn(colour: string, bg: string, min = 4.5): string {
  const towards = luminance(bg) > 0.4 ? '#0E1411' : '#FFFFFF';
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const c = mix(colour, towards, t);
    if (contrast(c, bg) >= min) return c;
  }
  return towards;
}

/** Like readableOn, but readable on every one of `bgs` (e.g. card, page and tint). */
export function readableOnAll(colour: string, bgs: string[], min = 4.5): string {
  let c = colour;
  for (let i = 0; i < 3; i++) for (const bg of bgs) c = readableOn(c, bg, min);
  return c;
}
