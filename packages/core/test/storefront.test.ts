import { describe, expect, it } from 'vitest';
import { ACCENT_FILLS, THEME_PALETTES, contrast, mix, normalizeStorefront, onColour, readableOn, readableOnAll, storefrontSchema } from '../src/storefront';

describe('storefront design', () => {
  it('fills defaults for an empty config', () => {
    const s = normalizeStorefront({});
    expect(s).toMatchObject({ theme: 'fresh', font: 'grotesque', radius: 'soft', header: 'brand', card: 'classic', hero: { enabled: true } });
    expect(s.sections.map((x) => x.id)).toEqual(['hero', 'wholesale', 'reorder', 'categories', 'featured', 'products']);
  });

  it('keeps the owner order, removes duplicates, adds missing sections, never hides the catalogue', () => {
    const s = normalizeStorefront({ sections: [{ id: 'products', on: false }, { id: 'hero', on: false }, { id: 'hero', on: true }] });
    const ids = s.sections.map((x) => x.id);
    expect(ids.indexOf('products')).toBeLessThan(ids.indexOf('hero'));
    expect(s.sections.find((x) => x.id === 'products')!.on).toBe(true);
    expect(s.sections.find((x) => x.id === 'hero')!.on).toBe(false);
    expect(new Set(s.sections.map((x) => x.id)).size).toBe(6);
  });

  it('rejects anything that is not a closed choice or bounded text', () => {
    expect(storefrontSchema.safeParse({ theme: 'hacker' }).success).toBe(false);
    expect(storefrontSchema.safeParse({ hero: { image_path: '../../etc/passwd' } }).success).toBe(false);
    expect(storefrontSchema.safeParse({ hero: { image_path: 'https://evil.example/x.webp' } }).success).toBe(false);
    expect(storefrontSchema.safeParse({ socials: { instagram: '<script>' } }).success).toBe(false);
    expect(storefrontSchema.safeParse({ about: 'x'.repeat(601) }).success).toBe(false);
    // bad stored config degrades to defaults instead of breaking the store
    expect(normalizeStorefront({ theme: 'nope' }).theme).toBe('fresh');
  });
});

describe('accent colours stay readable', () => {
  it('defaults to coral and rejects unknown accents', () => {
    expect(normalizeStorefront({}).accent).toBe('coral');
    expect(normalizeStorefront({ accent: 'neon' }).accent).toBe('coral');
    expect(normalizeStorefront({ theme: 'fresh', accent: 'sky' })).toMatchObject({ theme: 'fresh', accent: 'sky' });
  });

  it('every accent has readable text on every theme, and readable icons on itself', () => {
    for (const [name, p] of Object.entries(THEME_PALETTES)) {
      for (const fill of [...Object.values(ACCENT_FILLS), '#7C2D12', '#FDE047', '#0B7A4B']) {
        expect(contrast(readableOn(fill, p.surface), p.surface), `${fill} text on ${name}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(readableOn(fill, p.canvas), p.canvas), `${fill} text on ${name} canvas`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(onColour(fill), fill), `icon on ${fill}`).toBeGreaterThanOrEqual(3);
        const soft = mix(p.surface, fill, 0.14);
        const text = readableOnAll(fill, [p.surface, p.canvas, soft]);
        for (const bg of [p.surface, p.canvas, soft]) expect(contrast(text, bg), `${fill} text on ${bg} (${name})`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('colour maths matches WCAG reference values', () => {
    expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21, 1);
    expect(contrast('#767676', '#FFFFFF')).toBeCloseTo(4.54, 1);
    expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080');
  });
});
