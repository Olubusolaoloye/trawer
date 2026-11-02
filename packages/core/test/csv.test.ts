import { describe, expect, it } from 'vitest';
import { naira, toCsv } from '../src/csv';

describe('csv', () => {
  it('quotes, escapes and neutralises spreadsheet formulas', () => {
    const out = toCsv([{ name: '=HYPERLINK("http://evil","x")', qty: 3, price: 1_850_000 }, { name: 'Ada "Mama" Obi, Onitsha', qty: -2, price: null }],
      [{ header: 'Name', value: (r) => r.name }, { header: 'Qty', value: (r) => r.qty }, { header: 'Price (₦)', value: (r) => naira(r.price) }]);
    expect(out).toBe('﻿"Name","Qty","Price (₦)"\r\n"\'=HYPERLINK(""http://evil"",""x"")",3,18500\r\n"Ada ""Mama"" Obi, Onitsha",-2,\r\n');
  });
  it('keeps negative numbers as numbers but guards text that starts with a minus', () => {
    expect(toCsv([{ a: '-1+cmd' }], [{ header: 'A', value: (r) => r.a }])).toContain(`"'-1+cmd"`);
  });
});
