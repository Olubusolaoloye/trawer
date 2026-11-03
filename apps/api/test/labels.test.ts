import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { app, Client, phone } from './client';
import { pool } from '../src/db';
import { closeLive } from '../src/live';

let owner: Client;
let b: string;
let variants: string[];

beforeAll(async () => {
  owner = new Client();
  await owner.signIn(phone(), true);
  b = (await owner.post('/api/biz', { name: 'Label Fabrics', slug: `lb-${Date.now() % 100000}`, kind: 'wholesaler', brand_colour: '#1C2A5C' })).body.business_id;
  const p = await owner.post(`/api/biz/${b}/products`, { name: 'Hollandais wax print extra long name for wrapping', status: 'active', variants: [{ colour: 'Wine', size: '6 yards', retail_price_kobo: 1_500_000 }, { colour: 'Royal blue', retail_price_kobo: 1_550_000 }] });
  variants = (await owner.get(`/api/biz/${b}/products/${p.body.id}`)).body.variants.map((v: any) => v.id);
});
afterAll(async () => { await closeLive(); await pool.end(); });

async function labels(body: unknown, who = owner) {
  const res = await app.request(`/api/biz/${b}/labels`, {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-trawer': '1', host: 'app.trawer.test', cookie: (who as any).jar ? [...(who as any).jar].map(([k, v]: [string, string]) => `${k}=${v}`).join('; ') : '' },
  });
  return res;
}

describe('barcode labels', () => {
  it('A4 sheet: 21 per page, copies respected, used stickers skipped', async () => {
    const res = await labels({ items: [{ variant_id: variants[0], copies: 20 }, { variant_id: variants[1], copies: 3 }] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="labels-/);
    const pdf = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    expect(pdf.getPageCount()).toBe(2); // 23 labels
    const skipped = await PDFDocument.load(new Uint8Array(await (await labels({ items: [{ variant_id: variants[0], copies: 2 }], skip: 20 })).arrayBuffer()));
    expect(skipped.getPageCount()).toBe(2); // 20 used + 2 → spills onto a second sheet
  });

  it('thermal roll: one 50 × 30 mm label per page', async () => {
    const res = await labels({ items: [{ variant_id: variants[1], copies: 4 }], layout: 'roll-50x30', show_price: false });
    const pdf = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
    expect(pdf.getPageCount()).toBe(4);
    const [w, h] = [pdf.getPage(0).getWidth(), pdf.getPage(0).getHeight()];
    expect(Math.round(w / (72 / 25.4))).toBe(50);
    expect(Math.round(h / (72 / 25.4))).toBe(30);
  });

  it("refuses other shops' products and absurd quantities", async () => {
    const stranger = new Client();
    await stranger.signIn(phone());
    expect((await labels({ items: [{ variant_id: variants[0], copies: 1 }] }, stranger)).status).toBe(403);
    expect((await labels({ items: [{ variant_id: '00000000-0000-4000-8000-000000000000', copies: 1 }] })).status).toBe(422);
    expect((await labels({ items: [{ variant_id: variants[0], copies: 500 }, { variant_id: variants[1], copies: 500 }, { variant_id: variants[0], copies: 500 }, { variant_id: variants[1], copies: 500 }, { variant_id: variants[0], copies: 500 }] })).status).toBe(422);
  });
});
