import { describe, expect, it } from 'vitest';
import { normalizeStorefront, storefrontSchema } from '../src/storefront';

describe('storefront design', () => {
  it('fills defaults for an empty config', () => {
    const s = normalizeStorefront({});
    expect(s).toMatchObject({ theme: 'market', font: 'grotesque', radius: 'soft', header: 'brand', card: 'classic', hero: { enabled: true } });
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
    expect(normalizeStorefront({ theme: 'nope' }).theme).toBe('market');
  });
});
