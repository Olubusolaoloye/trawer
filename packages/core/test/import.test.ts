import { describe, expect, it } from 'vitest';
import { IMPORT_TEMPLATE, applyMapping, guessMapping, parseCsv, parseNairaToKobo, parseTextList, rowsToProducts } from '../src/import';
import { productInput } from '../src/schemas';

describe('CSV', () => {
  it('handles quotes, escaped quotes, CRLF, BOM and blank lines', () => {
    const rows = parseCsv('﻿name,price\r\n"Lace, gold ""heavy""",45000\r\n\r\nVoile,"12,500"\n');
    expect(rows).toEqual([['name', 'price'], ['Lace, gold "heavy"', '45000'], ['Voile', '12,500']]);
  });
  it('detects semicolon and tab separators', () => {
    expect(parseCsv('name;price\nA;1')).toEqual([['name', 'price'], ['A', '1']]);
    expect(parseCsv('name\tprice\nA\t1')).toEqual([['name', 'price'], ['A', '1']]);
  });
});

describe('column matching', () => {
  it('maps common header spellings', () => {
    const m = guessMapping(['Product Name', 'Color', 'Selling Price', 'Qty', 'Cost Price', 'Item Code', 'Category']);
    expect(m).toMatchObject({ name: 0, colour: 1, price: 2, stock: 3, cost: 4, sku: 5, category: 6 });
  });
  it('maps the downloadable template exactly', () => {
    const [h] = parseCsv(IMPORT_TEMPLATE);
    const m = guessMapping(h!);
    expect(Object.keys(m).sort()).toEqual(['barcode', 'category', 'colour', 'cost', 'description', 'name', 'pack_size', 'pack_unit', 'price', 'size', 'sku', 'stock', 'unit'].sort());
  });
});

describe('prices', () => {
  it.each([
    ['₦12,500', 1_250_000], ['N12500', 1_250_000], ['12.5k', 1_250_000], ['45k', 4_500_000], ['12,500.50', 1_250_050], ['NGN 3000', 300_000], ['1.2m', 120_000_000],
  ])('%s → %i kobo', (raw, kobo) => expect(parseNairaToKobo(raw)).toBe(kobo));
  it.each(['', 'free', '12-500', 'abc'])('rejects %j', (raw) => expect(parseNairaToKobo(raw)).toBeNull());
});

describe('rows → products', () => {
  it('groups rows by name into variants, keeps packs, and every product passes the API schema', () => {
    const rows = parseCsv(IMPORT_TEMPLATE);
    const r = rowsToProducts(applyMapping(rows.slice(1), guessMapping(rows[0]!)), { status: 'draft', source: 'import' });
    expect(r.issues).toEqual([]);
    expect(r.products).toHaveLength(2);
    const ankara = r.products[0]!;
    expect(ankara.variants.map((v) => v.colour)).toEqual(['Red', 'Blue']);
    expect(ankara.variants[0]!.colour_hex).toBe('#C62828');
    expect(ankara.packs).toEqual([{ unit: 'bundle', factor: 6 }]);
    for (const p of r.products) expect(productInput.safeParse(p).success).toBe(true);
  });
  it('reports bad rows with row numbers and keeps the good ones', () => {
    const r = rowsToProducts([
      { name: 'Good', price: '5000', stock: '3' },
      { name: '', price: '5000' },
      { name: 'No price', price: 'call me' },
      { name: 'Bad stock', price: '100', stock: '2.5', barcode: '12' },
      { name: 'Good', price: '5000' }, // duplicate variant of "Good"
    ], { status: 'active', source: 'import' });
    expect(r.products.map((p) => p.name)).toEqual(['Good', 'Bad stock']);
    expect(r.issues.map((i) => [i.row, i.field])).toEqual([[3, 'name'], [4, 'price'], [5, 'stock'], [5, 'barcode'], [6, 'row']]);
    expect(r.products[1]!.variants[0]).toMatchObject({ opening_stock: undefined, barcode: null });
  });
});

describe('pasted WhatsApp lists', () => {
  it('reads the ways traders write prices and quantities', () => {
    const { rows, issues } = parseTextList([
      '1. Ankara wax print red - ₦12,500 x 30',
      '• Swiss lace (gold) 45k qty 10',
      'Chiffon blue 8,500 (20 pcs)',
      '- George wrapper 15000 for 5 pieces',
      'Hello everyone 👋',
      '',
    ].join('\n'));
    expect(rows).toEqual([
      { name: 'Ankara Wax Print', colour: 'Red', price: '₦12,500', stock: '30' },
      { name: 'Swiss Lace', colour: 'Gold', price: '45k', stock: '10' },
      { name: 'Chiffon', colour: 'Blue', price: '8,500', stock: '20' },
      { name: 'George Wrapper', colour: undefined, price: '15000', stock: '5' },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ row: 5, field: 'price' });
    const r = rowsToProducts(rows, { status: 'draft', source: 'text_list' });
    expect(r.products).toHaveLength(4);
    expect(r.products[0]!.variants[0]).toMatchObject({ retail_price_kobo: 1_250_000, opening_stock: 30, colour_hex: '#C62828' });
  });

  it('prefers the marked price over product codes and other numbers', () => {
    const { rows } = parseTextList('Lace 2041 gold - ₦12,500 x 4\nGeorge 3301 wine 18,000\nAso-oke set 2024 edition 45k');
    expect(rows.map((r) => [r.name, r.price])).toEqual([['Lace 2041', '₦12,500'], ['George 3301', '18,000'], ['Aso-oke Set 2024 Edition', '45k']]);
  });
});
