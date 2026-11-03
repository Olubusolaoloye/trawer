/**
 * Snap-to-upload: the product draft an AI model fills in from a photo (+ an optional note).
 * Kept free of closed-list constraints the structured-output schema can't express (min/max, regex):
 * the API cleans the result with `cleanDraft` before anyone sees it.
 */
import { z } from 'zod';

export const BASE_UNITS = ['piece', 'yard', 'pair', 'set', 'kg', 'litre', 'pack'] as const;
export const PACK_UNITS = ['carton', 'bale', 'bundle', 'dozen', 'box', 'bag', 'roll', 'crate'] as const;

export const productDraftSchema = z.object({
  name: z.string().describe('Short product name a Nigerian buyer would search for, e.g. "Hollandais wax print" (no price, no colour)'),
  category: z.string().nullable().describe("One of the shop's existing categories when it fits, else a short new one, else null"),
  description: z.string().describe('One or two plain sentences: material, pattern, typical length or use. No prices, no hype.'),
  base_unit: z.enum(BASE_UNITS).describe('How one item is counted'),
  pack: z.object({ unit: z.enum(PACK_UNITS), factor: z.number().int() }).nullable()
    .describe('Wholesale pack only if the photo or note shows one (e.g. "bundle of 6"), else null'),
  variants: z.array(z.object({
    colour: z.string().nullable().describe('Colour name as a trader would say it, e.g. "Royal blue"'),
    colour_hex: z.string().nullable().describe('#RRGGBB swatch for that colour'),
    size: z.string().nullable(),
  })).describe('One entry per colour/size visible in the photo or named in the note (at least one)'),
  suggested_price_naira: z.number().nullable().describe('Retail price per base unit in naira, from the price hints; null if there is no basis'),
  price_reason: z.string().describe('One short sentence on where the suggested price comes from'),
  check: z.array(z.string()).describe('Up to 3 short things the owner should double-check (e.g. "Confirm the length is 6 yards")'),
});
export type ProductDraft = z.infer<typeof productDraftSchema>;

/** Clamp and tidy a draft from any provider so it is always safe to show and to save. */
export function cleanDraft(d: ProductDraft): ProductDraft {
  const hex = (h: string | null) => (h && /^#[0-9A-Fa-f]{6}$/.test(h) ? h.toUpperCase() : null);
  const text = (s: string | null | undefined, max: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const variants = d.variants.slice(0, 12).map((v) => ({ colour: text(v.colour, 60) || null, colour_hex: hex(v.colour_hex), size: text(v.size, 40) || null }));
  const price = d.suggested_price_naira != null && Number.isFinite(d.suggested_price_naira) && d.suggested_price_naira > 0 && d.suggested_price_naira < 100_000_000
    ? Math.round(d.suggested_price_naira) : null;
  return {
    name: text(d.name, 200) || 'New product',
    category: text(d.category, 80) || null,
    description: text(d.description, 1000),
    base_unit: d.base_unit,
    pack: d.pack && Number.isInteger(d.pack.factor) && d.pack.factor >= 2 && d.pack.factor <= 100_000 ? d.pack : null,
    variants: variants.length ? variants : [{ colour: null, colour_hex: null, size: null }],
    suggested_price_naira: price,
    price_reason: text(d.price_reason, 200),
    check: d.check.slice(0, 3).map((c) => text(c, 140)).filter(Boolean),
  };
}
