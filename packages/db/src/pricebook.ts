import type { PoolClient } from 'pg';
import type { PriceBook } from '@trawer/core/pricing';

/**
 * Load the full price book for a business (what the offline POS needs to price any sale).
 * Runs with the caller's privileges, so RLS decides what is visible.
 */
export async function loadPriceBook(client: Pick<PoolClient, 'query'>, businessId: string): Promise<PriceBook> {
  const [variants, tiers, customers, tierPrices, overrides, breaks] = await Promise.all([
    client.query(`select id, retail_price_kobo from public.product_variants where business_id = $1`, [businessId]),
    client.query(`select id, is_wholesale from public.customer_tiers where business_id = $1`, [businessId]),
    client.query(`select id, tier_id, wholesale_status from public.customers where business_id = $1`, [businessId]),
    client.query(`select tier_id, variant_id, price_kobo from public.tier_prices where business_id = $1`, [businessId]),
    client.query(`select customer_id, variant_id, price_kobo from public.customer_price_overrides where business_id = $1`, [businessId]),
    client.query(`select variant_id, tier_id, min_qty, price_kobo from public.volume_breaks where business_id = $1`, [businessId]),
  ]);
  const book: PriceBook = { variants: {}, tiers: {}, customers: {}, tierPrices: {}, overrides: {}, volumeBreaks: [] };
  for (const r of variants.rows) book.variants[r.id] = { retailPriceKobo: Number(r.retail_price_kobo) };
  for (const r of tiers.rows) book.tiers[r.id] = { isWholesale: r.is_wholesale };
  for (const r of customers.rows) book.customers[r.id] = { tierId: r.tier_id, wholesaleStatus: r.wholesale_status };
  for (const r of tierPrices.rows) book.tierPrices[`${r.tier_id}:${r.variant_id}`] = Number(r.price_kobo);
  for (const r of overrides.rows) book.overrides[`${r.customer_id}:${r.variant_id}`] = Number(r.price_kobo);
  for (const r of breaks.rows) {
    book.volumeBreaks.push({ variantId: r.variant_id, tierId: r.tier_id, minQty: r.min_qty, priceKobo: Number(r.price_kobo) });
  }
  return book;
}
