import { describe, expect, it } from 'vitest';
import { describeQty, splitIntoUnits, toBaseQty, type ProductUnit } from '../src/units';
import { formatNaira, nairaToKobo } from '../src/money';

const units: ProductUnit[] = [
  { unitId: 'pc', name: 'piece', plural: 'pieces', factor: 1, isBase: true },
  { unitId: 'ctn', name: 'carton', plural: 'cartons', factor: 12, isBase: false },
  { unitId: 'bale', name: 'bale', plural: 'bales', factor: 120, isBase: false, sellable: false },
];

describe('units', () => {
  it('converts to base units', () => {
    expect(toBaseQty(units, 'ctn', 3)).toBe(36);
    expect(toBaseQty(units, 'pc', 5)).toBe(5);
    expect(() => toBaseQty(units, 'bale', 1)).toThrow('unit_not_sellable');
    expect(() => toBaseQty(units, 'pc', 0)).toThrow('invalid_qty');
    expect(() => toBaseQty(units, 'pc', 1.5)).toThrow('invalid_qty');
  });

  it('splits into cartons and pieces for display', () => {
    expect(splitIntoUnits(units, 30).map((x) => [x.unit.unitId, x.qty])).toEqual([['ctn', 2], ['pc', 6]]);
    expect(describeQty(units, 25)).toBe('2 cartons + 1 piece');
    expect(describeQty(units, 12)).toBe('1 carton');
  });
});

describe('money', () => {
  it('parses and formats naira', () => {
    expect(nairaToKobo('₦12,500.50')).toBe(1_250_050);
    expect(nairaToKobo(3.333)).toBe(333);
    expect(formatNaira(1_250_000)).toBe('₦12,500');
    expect(() => nairaToKobo('-1')).toThrow();
  });
});
