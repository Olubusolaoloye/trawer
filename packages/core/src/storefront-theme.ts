/** Storefront design choices + theme palettes (no validation library: safe to ship to every shop page). */
export const THEMES = ['market', 'linen', 'midnight', 'bold'] as const;
export const FONTS = ['grotesque', 'serif', 'rounded', 'classic'] as const;
export const RADII = ['sharp', 'soft', 'round'] as const;
export const HEADERS = ['brand', 'clean', 'glass'] as const;
export const CARDS = ['classic', 'overlay', 'minimal'] as const;
export const DENSITIES = ['comfy', 'compact'] as const;
export const SECTION_IDS = ['hero', 'categories', 'wholesale', 'reorder', 'featured', 'products'] as const;

export type Theme = (typeof THEMES)[number];
export type FontChoice = (typeof FONTS)[number];
export type SectionId = (typeof SECTION_IDS)[number];

export interface StorefrontDesign {
  theme: Theme; font: FontChoice; radius: (typeof RADII)[number]; header: (typeof HEADERS)[number]; card: (typeof CARDS)[number]; density: (typeof DENSITIES)[number];
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
  linen: { canvas: '#FFFFFF', surface: '#F7F5F2', ink: '#1A1A1A', body: '#404040', muted: '#666159', line: '#E9E5DF', soft: '#F1EEEA', dark: false },
  midnight: { canvas: '#0F1412', surface: '#19201C', ink: '#F4F1EA', body: '#D5D1C7', muted: '#A7A397', line: '#2C352F', soft: '#232B26', dark: true },
  bold: { canvas: '#FFF8E7', surface: '#FFFFFF', ink: '#111111', body: '#2B2B2B', muted: '#5A5650', line: '#111111', soft: '#FCEFC9', dark: false },
};
