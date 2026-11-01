import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { app, Client, phone } from './client';
import { pool } from '../src/db';
import { closeLive } from '../src/live';

let owner: Client;
let businessId: string;
let slug: string;

beforeAll(async () => {
  owner = new Client();
  await owner.signIn(phone(), true);
  slug = `sf-${Date.now() % 100000}`;
  businessId = (await owner.post('/api/biz', { name: 'Design Fabrics', slug, kind: 'wholesaler', brand_colour: '#7C3AED' })).body.business_id;
});
afterAll(async () => { await closeLive(); await pool.end(); });

describe('storefront design', () => {
  it('a new shop gets the default design on its public store', async () => {
    const store = await (await app.request(`/api/store/${slug}`)).json() as any;
    expect(store.design).toMatchObject({ theme: 'market', header: 'brand', hero: { enabled: true, image_url: null } });
    expect(store.business.storefront).toBeUndefined();
  });

  it('owner saves a design; buyers see it; the change is audited', async () => {
    const design = {
      theme: 'midnight', font: 'serif', radius: 'round', header: 'glass', card: 'overlay',
      announcement: { enabled: true, text: 'Free delivery in Lagos this week' },
      hero: { enabled: true, title: 'Owambe season is here', subtitle: 'Fresh lace every Monday', cta_label: 'Shop lace', cta_category: 'Lace' },
      sections: [{ id: 'hero', on: true }, { id: 'products', on: true }, { id: 'categories', on: false }],
      socials: { instagram: 'designfabrics', whatsapp: '+2348030000001' },
      about: 'Family business since 1998.',
    };
    const r = await owner.put(`/api/biz/${businessId}/storefront`, design);
    expect(r.status).toBe(200);
    const store = await (await app.request(`/api/store/${slug}`)).json() as any;
    expect(store.design).toMatchObject({ theme: 'midnight', font: 'serif', card: 'overlay', announcement: { text: 'Free delivery in Lagos this week' } });
    expect(store.design.sections.find((s: any) => s.id === 'categories').on).toBe(false);
    const audit = await pool.query(`select 1 from audit_log where business_id = $1 and action = 'storefront.updated'`, [businessId]);
    expect(audit.rowCount).toBe(1);
  });

  it('rejects unknown choices, foreign images and other staff', async () => {
    expect((await owner.put(`/api/biz/${businessId}/storefront`, { theme: 'neon' })).status).toBe(422);
    expect((await owner.put(`/api/biz/${businessId}/storefront`, { hero: { image_path: '00000000-0000-0000-0000-000000000000/x.webp' } })).status).toBe(422);
    const cashierPhone = phone();
    await owner.post(`/api/biz/${businessId}/staff`, { phone: cashierPhone, role: 'cashier' });
    const cashier = new Client();
    await cashier.signIn(cashierPhone);
    expect((await cashier.put(`/api/biz/${businessId}/storefront`, { theme: 'bold' })).status).toBe(403);
  });
});
