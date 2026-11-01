import { describe, expect, it } from 'vitest';
import { emptyPriceBook, resolvePrice, type PriceBook } from '../src/pricing';

function book(): PriceBook {
  const b = emptyPriceBook();
  b.variants.v1 = { retailPriceKobo: 10_000 };
  b.tiers.whole = { isWholesale: true };
  b.tiers.trade = { isWholesale: false };
  b.tierPrices['whole:v1'] = 7_000;
  b.tierPrices['trade:v1'] = 9_000;
  b.customers.approved = { tierId: 'whole', wholesaleStatus: 'approved' };
  b.customers.pending = { tierId: 'whole', wholesaleStatus: 'pending' };
  b.customers.trader = { tierId: 'trade', wholesaleStatus: 'not_applicable' };
  b.customers.vip = { tierId: 'whole', wholesaleStatus: 'approved' };
  b.overrides['vip:v1'] = 6_500;
  b.volumeBreaks.push(
    { variantId: 'v1', tierId: null, minQty: 12, priceKobo: 9_500 },
    { variantId: 'v1', tierId: null, minQty: 60, priceKobo: 9_000 },
    { variantId: 'v1', tierId: 'whole', minQty: 120, priceKobo: 6_800 },
  );
  return b;
}

describe('resolvePrice', () => {
  it('retail for anonymous buyers, volume breaks by quantity', () => {
    expect(resolvePrice(book(), 'v1', null, 1)).toMatchObject({ unitPriceKobo: 10_000, source: 'retail' });
    expect(resolvePrice(book(), 'v1', null, 12)).toMatchObject({ unitPriceKobo: 9_500, source: 'volume' });
    expect(resolvePrice(book(), 'v1', null, 59)).toMatchObject({ unitPriceKobo: 9_500 });
    expect(resolvePrice(book(), 'v1', null, 60)).toMatchObject({ unitPriceKobo: 9_000 });
  });

  it('approved wholesaler gets the tier price at ANY quantity', () => {
    for (const qty of [1, 2, 11, 12, 100]) {
      expect(resolvePrice(book(), 'v1', 'approved', qty)).toMatchObject({ unitPriceKobo: 7_000, source: 'tier', tierId: 'whole' });
    }
    expect(resolvePrice(book(), 'v1', 'approved', 120)).toMatchObject({ unitPriceKobo: 6_800, source: 'tier_volume' });
  });

  it('pending wholesaler pays retail/volume until approved', () => {
    expect(resolvePrice(book(), 'v1', 'pending', 1)).toMatchObject({ unitPriceKobo: 10_000, source: 'retail', tierId: null });
    expect(resolvePrice(book(), 'v1', 'pending', 12)).toMatchObject({ unitPriceKobo: 9_500, source: 'volume' });
  });

  it('non-wholesale tiers need no approval', () => {
    expect(resolvePrice(book(), 'v1', 'trader', 1)).toMatchObject({ unitPriceKobo: 9_000, source: 'tier' });
  });

  it('per-customer override beats everything', () => {
    expect(resolvePrice(book(), 'v1', 'vip', 500)).toMatchObject({ unitPriceKobo: 6_500, source: 'override' });
  });

  it('falls through to general breaks when the tier has no price for the variant', () => {
    const b = book();
    delete b.tierPrices['trade:v1'];
    expect(resolvePrice(b, 'v1', 'trader', 12)).toMatchObject({ unitPriceKobo: 9_500, source: 'volume', tierId: 'trade' });
  });

  it('is channel independent', () => {
    const channels = ['web', 'whatsapp', 'instagram', 'pos'] as const;
    const prices = channels.map((c) => resolvePrice(book(), 'v1', 'approved', 3, c).unitPriceKobo);
    expect(new Set(prices).size).toBe(1);
  });

  it('rejects unknown variants', () => {
    expect(() => resolvePrice(book(), 'nope', null, 1)).toThrow('unknown_variant');
  });
});
