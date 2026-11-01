/**
 * Price resolver — TypeScript mirror of `app.resolve_price_unchecked` in
 * packages/db/supabase/migrations/*_pricing.sql. The offline POS uses this with a synced
 * PriceBook; a parity test runs both implementations against the same fixtures.
 *
 * Order: override → tier (tier volume break, else tier price; wholesale tiers only when
 * approved, at any qty) → general volume break → retail.
 */
import type { Kobo } from './money';

export type SalesChannel = 'web' | 'whatsapp' | 'instagram' | 'facebook' | 'pos';
export type PriceSource = 'override' | 'tier_volume' | 'tier' | 'volume' | 'retail';
export type WholesaleStatus = 'not_applicable' | 'pending' | 'approved' | 'rejected';

export interface PriceBook {
  variants: Record<string, { retailPriceKobo: Kobo }>;
  tiers: Record<string, { isWholesale: boolean }>;
  customers: Record<string, { tierId: string | null; wholesaleStatus: WholesaleStatus }>;
  /** key `${tierId}:${variantId}` */
  tierPrices: Record<string, Kobo>;
  /** key `${customerId}:${variantId}` */
  overrides: Record<string, Kobo>;
  volumeBreaks: { variantId: string; tierId: string | null; minQty: number; priceKobo: Kobo }[];
}

export interface PriceQuote {
  unitPriceKobo: Kobo;
  source: PriceSource;
  tierId: string | null;
  retailPriceKobo: Kobo;
}

export function emptyPriceBook(): PriceBook {
  return { variants: {}, tiers: {}, customers: {}, tierPrices: {}, overrides: {}, volumeBreaks: [] };
}

function bestBreak(book: PriceBook, variantId: string, tierId: string | null, qty: number): Kobo | undefined {
  let best: { minQty: number; priceKobo: Kobo } | undefined;
  for (const vb of book.volumeBreaks) {
    if (vb.variantId !== variantId || vb.tierId !== tierId || vb.minQty > qty) continue;
    if (!best || vb.minQty > best.minQty) best = vb;
  }
  return best?.priceKobo;
}

export function resolvePrice(
  book: PriceBook,
  variantId: string,
  customerId: string | null,
  qty: number,
  _channel: SalesChannel = 'web',
): PriceQuote {
  const variant = book.variants[variantId];
  if (!variant) throw new Error('unknown_variant');
  const q = Math.max(Number.isFinite(qty) ? Math.trunc(qty) : 1, 1);
  const retail = variant.retailPriceKobo;
  const customer = customerId ? book.customers[customerId] : undefined;
  let tierId: string | null = null;

  if (customer && customerId) {
    const override = book.overrides[`${customerId}:${variantId}`];
    if (override !== undefined) return { unitPriceKobo: override, source: 'override', tierId: customer.tierId, retailPriceKobo: retail };

    const tier = customer.tierId ? book.tiers[customer.tierId] : undefined;
    if (customer.tierId && tier && (!tier.isWholesale || customer.wholesaleStatus === 'approved')) {
      tierId = customer.tierId;
      const tv = bestBreak(book, variantId, tierId, q);
      if (tv !== undefined) return { unitPriceKobo: tv, source: 'tier_volume', tierId, retailPriceKobo: retail };
      const tp = book.tierPrices[`${tierId}:${variantId}`];
      if (tp !== undefined) return { unitPriceKobo: tp, source: 'tier', tierId, retailPriceKobo: retail };
    }
  }

  const general = bestBreak(book, variantId, null, q);
  if (general !== undefined) return { unitPriceKobo: general, source: 'volume', tierId, retailPriceKobo: retail };
  return { unitPriceKobo: retail, source: 'retail', tierId, retailPriceKobo: retail };
}

export function lineTotal(quote: PriceQuote, baseQty: number): Kobo {
  return quote.unitPriceKobo * baseQty;
}
