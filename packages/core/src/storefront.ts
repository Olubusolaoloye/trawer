/**
 * Storefront design: what a shop owner can customise about their store, with safe defaults.
 * Shared by the API (validation) and the web app (rendering + the design editor).
 * Everything is a closed choice or bounded text; no raw CSS/HTML is ever accepted.
 */
import { z } from 'zod';

import { ACCENTS, CARDS, DENSITIES, FONTS, HEADERS, RADII, SECTION_IDS, THEMES, type SectionId } from './storefront-theme';

export * from './storefront-theme';

const text = (max: number) => z.string().trim().max(max);
const handle = z.string().trim().max(60).regex(/^[A-Za-z0-9._-]*$/, 'handle');

export const storefrontSchema = z.object({
  theme: z.enum(THEMES).default('market'),
  accent: z.enum(ACCENTS).default('coral'),
  font: z.enum(FONTS).default('grotesque'),
  radius: z.enum(RADII).default('soft'),
  header: z.enum(HEADERS).default('brand'),
  card: z.enum(CARDS).default('classic'),
  density: z.enum(DENSITIES).default('comfy'),
  announcement: z.object({ enabled: z.boolean().default(false), text: text(140).default('') }).prefault({}),
  hero: z.object({
    enabled: z.boolean().default(true),
    title: text(80).default(''),
    subtitle: text(160).default(''),
    image_path: z.string().max(300).regex(/^[A-Za-z0-9/_-]+\.webp$/).nullable().default(null),
    cta_label: text(30).default(''),
    cta_category: text(80).nullable().default(null),
  }).prefault({}),
  featured: z.object({ title: text(60).default(''), category: text(80).nullable().default(null) }).prefault({}),
  sections: z.array(z.object({ id: z.enum(SECTION_IDS), on: z.boolean() })).max(SECTION_IDS.length).default([]),
  show_stock: z.boolean().default(false),
  about: text(600).default(''),
  socials: z.object({ instagram: handle.default(''), tiktok: handle.default(''), whatsapp: z.string().trim().max(20).regex(/^\+?\d*$/).default('') }).prefault({}),
});

export type StorefrontInput = z.input<typeof storefrontSchema>;
export type Storefront = z.output<typeof storefrontSchema> & { sections: { id: SectionId; on: boolean }[] };

const DEFAULT_SECTIONS: { id: SectionId; on: boolean }[] = [
  { id: 'hero', on: true }, { id: 'wholesale', on: true }, { id: 'reorder', on: true },
  { id: 'categories', on: true }, { id: 'featured', on: false }, { id: 'products', on: true },
];

/** Parse stored/untrusted config into a complete design; unknown or bad fields fall back to defaults. */
export function normalizeStorefront(raw: unknown): Storefront {
  const parsed = storefrontSchema.safeParse(raw ?? {});
  const v = parsed.success ? parsed.data : storefrontSchema.parse({});
  // Every section exactly once, in the owner's order; new section types appear at their default spot.
  const seen = new Set<SectionId>();
  const sections = v.sections.filter((s) => !seen.has(s.id) && seen.add(s.id));
  const fresh = !sections.length;
  for (const d of DEFAULT_SECTIONS) {
    if (seen.has(d.id)) continue;
    // Missing sections keep their default position for a new shop, otherwise slot in just above the catalogue.
    const at = fresh ? sections.length : sections.findIndex((x) => x.id === 'products');
    sections.splice(at < 0 ? sections.length : at, 0, { ...d });
  }
  if (!sections.some((s) => s.id === 'products' && s.on)) sections.find((s) => s.id === 'products')!.on = true; // the catalogue can't be hidden
  return { ...v, sections };
}
