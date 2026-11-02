/** Caption rendering within Instagram's limits. Pure (safe for the browser composer). */
import { formatNaira } from './money';

export interface CaptionProduct { name: string; price_kobo: number | null; colours: string[]; category: string | null; url: string }
export const CAPTION_MAX = 2200;
export const HASHTAG_MAX = 30;
/** A hashtag needs at least one letter: Instagram doesn't link number-only tags like a product's "#001". */
const HASHTAG = /#[\p{N}_]*\p{L}[\p{L}\p{N}_]*/gu;
export const DEFAULT_TEMPLATE = '{name} — {price}{variants}\nOrder: {link}';

/** Keep Instagram's limits: at most 30 hashtags (extra ones dropped) and 2,200 characters. */
export function fitCaption(text: string): string {
  let n = 0;
  const kept = text.replace(HASHTAG, (tag) => (++n <= HASHTAG_MAX ? tag : '')).replace(/[ \t]{2,}/g, ' ').trim();
  return kept.length <= CAPTION_MAX ? kept : `${kept.slice(0, CAPTION_MAX - 1).trimEnd()}…`;
}

export function countHashtags(text: string): number {
  return (text.match(HASHTAG) ?? []).length;
}

/** One product with the shop's template ({name} {price} {variants} {link} {shop} {category}). */
export function renderCaption(template: string, p: CaptionProduct, shop: string): string {
  const vars: Record<string, string> = {
    name: p.name,
    price: p.price_kobo != null ? formatNaira(p.price_kobo) : '',
    variants: p.colours.length > 1 ? ` · Colours: ${p.colours.slice(0, 8).join(', ')}${p.colours.length > 8 ? '…' : ''}` : '',
    link: p.url,
    shop,
    category: p.category ?? '',
  };
  return fitCaption((template || DEFAULT_TEMPLATE).replace(/\{(name|price|variants|link|shop|category)\}/g, (_, k: string) => vars[k] ?? ''));
}

/** New-arrivals carousel: numbered list + one link to the store. */
export function renderCarouselCaption(products: CaptionProduct[], shop: string, storeUrl: string): string {
  const lines = products.map((p, i) => `${i + 1}. ${p.name}${p.price_kobo != null ? ` — ${formatNaira(p.price_kobo)}` : ''}`);
  return fitCaption(`New arrivals at ${shop}\n\n${lines.join('\n')}\n\nSwipe to see them all. Order here: ${storeUrl}`);
}

