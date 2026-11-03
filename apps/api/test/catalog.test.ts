import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { IMPORT_TEMPLATE, applyMapping, guessMapping, parseCsv, parseTextList, rowsToProducts } from '@trawer/core/import';
import { Client, phone } from './client';
import { pool } from '../src/db';
import { closeLive } from '../src/live';

let owner: Client;
let cashier: Client;
let b: string;

beforeAll(async () => {
  owner = new Client();
  await owner.signIn(phone(), true);
  b = (await owner.post('/api/biz', { name: 'Import Fabrics', slug: `imp-${Date.now() % 100000}`, kind: 'wholesaler', brand_colour: '#1C2A5C' })).body.business_id;
  // One existing product so duplicates and price hints have something to find.
  expect((await owner.post(`/api/biz/${b}/products`, {
    name: 'Swiss voile lace', category: 'Lace', status: 'active', variants: [{ colour: 'Gold', retail_price_kobo: 4_000_000 }, { colour: 'Silver', retail_price_kobo: 5_000_000 }],
  })).status).toBe(201);
  const cp = phone();
  expect((await owner.post(`/api/biz/${b}/staff`, { phone: cp, role: 'cashier', display_name: 'Till' })).status).toBe(201);
  cashier = new Client();
  await cashier.signIn(cp);
});
afterAll(async () => { await closeLive(); await pool.end(); });

const fromTemplate = () => {
  const rows = parseCsv(IMPORT_TEMPLATE);
  return rowsToProducts(applyMapping(rows.slice(1), guessMapping(rows[0]!)), { status: 'active', source: 'import' }).products;
};

describe('bulk import', () => {
  it('dry run reports new, duplicate and invalid products and saves nothing', async () => {
    const products = [...fromTemplate(), { name: '', variants: [] }];
    const r = await owner.post(`/api/biz/${b}/import`, { dry_run: true, products });
    expect(r.status).toBe(200);
    expect(r.body.report.map((l: any) => l.status)).toEqual(['new', 'duplicate', 'invalid']);
    expect(r.body.summary).toMatchObject({ new: 1, duplicate: 1, invalid: 1 });
    const { rows } = await pool.query(`select count(*)::int n from products where business_id = $1`, [b]);
    expect(rows[0].n).toBe(1);
  });

  it('import creates the good products with variants, packs and opening stock; skips duplicates', async () => {
    const r = await owner.post(`/api/biz/${b}/import`, { dry_run: false, products: fromTemplate() });
    expect(r.status).toBe(200);
    expect(r.body.summary).toMatchObject({ created: 1, skipped: 1 });
    const { rows: [p] } = await pool.query(`
      select p.id, p.source, p.status, (select count(*)::int from product_variants v where v.product_id = p.id) variants,
             (select factor from product_units pu where pu.product_id = p.id and not pu.is_base) pack,
             (select sum(on_hand)::int from stock_levels s join product_variants v on v.id = s.variant_id where v.product_id = p.id) stock
      from products p where p.business_id = $1 and p.name = 'Hollandais wax print'`, [b]);
    expect(p).toMatchObject({ source: 'import', status: 'active', variants: 2, pack: 6, stock: 42 });
  });

  it('pasted WhatsApp list imports as drafts; SKU clashes are reported, not saved', async () => {
    const { rows } = parseTextList('Chiffon blue 8,500 (20 pcs)\nChiffon red 8,500 x 5\nGeorge wrapper 15k qty 3');
    const products = rowsToProducts(rows, { status: 'draft', source: 'text_list' }).products;
    products[1]!.variants[0]!.sku = 'ANK-001'; // already used by the template import
    const r = await owner.post(`/api/biz/${b}/import`, { dry_run: false, products });
    expect(r.body.report.map((l: any) => l.status)).toEqual(['created', 'invalid']);
    expect(r.body.report[1].messages[0]).toMatch(/ANK-001 is already used/);
    const { rows: [c] } = await pool.query(`select status, source, (select count(*)::int from product_variants v where v.product_id = p.id) n from products p where business_id = $1 and name = 'Chiffon'`, [b]);
    expect(c).toMatchObject({ status: 'draft', source: 'text_list', n: 2 });
  });

  it('is limited to staff of the shop, and to 1000 products per request', async () => {
    const stranger = new Client();
    await stranger.signIn(phone());
    expect((await stranger.post(`/api/biz/${b}/import`, { dry_run: true, products: fromTemplate() })).status).toBe(403);
    const many = Array.from({ length: 1001 }, (_, i) => ({ name: `P${i}`, variants: [{ retail_price_kobo: 100 }] }));
    expect((await owner.post(`/api/biz/${b}/import`, { dry_run: true, products: many })).status).toBe(422);
  });
});

describe('snap-to-upload', () => {
  const photo = async (rgb: [number, number, number]) => {
    const buf = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).jpeg().toBuffer();
    return new File([new Uint8Array(buf)], 'snap.jpg', { type: 'image/jpeg' });
  };

  it('drafts a product from a photo and note, stores the photo, and prices from the shop history', async () => {
    const form = new FormData();
    form.append('file', await photo([200, 30, 40]));
    form.append('note', 'Lace in gold and silver, bundle of 5');
    const r = await owner.upload(`/api/biz/${b}/products/snap`, form);
    expect(r.status).toBe(200);
    expect(r.body.image.path).toMatch(/\.webp$/);
    expect(r.body.draft).toMatchObject({ category: 'Lace', pack: { unit: 'bundle', factor: 5 }, suggested_price_naira: 45_000 });
    expect(r.body.draft.variants.map((v: any) => v.colour)).toEqual(['Gold', 'Silver'].filter((c) => r.body.draft.variants.some((v: any) => v.colour === c)));

    // Owner confirms: the draft it came from is kept with the product.
    const created = await owner.post(`/api/biz/${b}/products`, {
      name: 'Lace', category: 'Lace', source: 'snap', status: 'draft', ai_draft: r.body.draft,
      variants: [{ colour: 'Gold', retail_price_kobo: 4_500_000, image_path: r.body.image.path }],
    });
    expect(created.status).toBe(201);
    const { rows: [p] } = await pool.query(`select source, ai_draft->>'category' cat, (select count(*)::int from variant_images vi where vi.product_id = products.id) imgs from products where id = $1`, [created.body.id]);
    expect(p).toMatchObject({ source: 'snap', cat: 'Lace', imgs: 1 });
  });

  it('rejects non-images and people who are not staff', async () => {
    const bad = new FormData();
    bad.append('file', new File(['hello'], 'x.txt', { type: 'text/plain' }));
    expect((await owner.upload(`/api/biz/${b}/products/snap`, bad)).body.error).toBe('unsupported_image');
    const stranger = new Client();
    await stranger.signIn(phone());
    const form = new FormData();
    form.append('file', await photo([10, 10, 10]));
    expect((await stranger.upload(`/api/biz/${b}/products/snap`, form)).status).toBe(403);
  });

  it('cashiers can snap too (drafts only)', async () => {
    const form = new FormData();
    form.append('file', await photo([20, 60, 200]));
    const r = await cashier.upload(`/api/biz/${b}/products/snap`, form);
    expect(r.status).toBe(200);
    expect(r.body.draft.variants[0].colour_hex).toMatch(/^#[0-9A-F]{6}$/);
  });
});
