/** Storefront design as served to the store and the editor (image paths → URLs). */
import { normalizeStorefront, type Storefront } from '@trawer/core/storefront';
import { imageUrl } from './storage';

export type DesignView = Storefront & { hero: Storefront['hero'] & { image_url: string | null } };

export function designView(raw: unknown): DesignView {
  const d = normalizeStorefront(raw);
  return { ...d, hero: { ...d.hero, image_url: imageUrl(d.hero.image_path, 1600) } };
}
