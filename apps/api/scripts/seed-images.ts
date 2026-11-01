// Local dev only: generate a patterned "fabric" WebP for every seeded variant without an image.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import sharp from 'sharp';

const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/trawer_dev' });
await db.connect();
const { rows } = await db.query(`
  select v.id, v.business_id, v.product_id, v.colour_hex, p.category, v.position
  from product_variants v join products p on p.id = v.product_id
  where not exists (select 1 from variant_images i where i.variant_id = v.id)`);
const root = resolve(process.cwd(), '.uploads', 'products');
const patterns = [
  (c: string) => `<circle cx="40" cy="40" r="22" fill="${c}"/><circle cx="0" cy="0" r="14" fill="#fff" opacity=".6"/><circle cx="80" cy="80" r="14" fill="#fff" opacity=".6"/>`,
  (c: string) => `<path d="M0 40 Q20 0 40 40 T80 40" stroke="${c}" stroke-width="10" fill="none"/><path d="M0 80 Q20 40 40 80 T80 80" stroke="#fff" stroke-width="6" fill="none" opacity=".6"/>`,
  (c: string) => `<rect x="10" y="10" width="25" height="25" fill="${c}"/><rect x="45" y="45" width="25" height="25" fill="${c}"/><rect x="45" y="10" width="25" height="25" fill="#fff" opacity=".4"/>`,
  (c: string) => `<polygon points="40,5 75,40 40,75 5,40" fill="${c}"/><circle cx="40" cy="40" r="10" fill="#fff" opacity=".7"/>`,
];
let n = 0;
for (const r of rows) {
  const c = r.colour_hex ?? '#a8a29e';
  const pat = patterns[(r.category?.length ?? 0) % patterns.length]!(c);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="800"><defs><pattern id="p" width="80" height="80" patternUnits="userSpaceOnUse">
    <rect width="80" height="80" fill="${c}" opacity=".35"/>${pat}</pattern></defs><rect width="800" height="800" fill="#fafaf9"/><rect width="800" height="800" fill="url(#p)"/></svg>`;
  const path = `${r.business_id}/seed-${r.id}.webp`;
  await mkdir(join(root, r.business_id), { recursive: true });
  await writeFile(join(root, path), await sharp(Buffer.from(svg)).webp({ quality: 70 }).toBuffer());
  await db.query(`insert into variant_images (business_id, product_id, variant_id, path, position) values ($1, $2, $3, $4, 0)`, [r.business_id, r.product_id, r.id, path]);
  n += 1;
}
console.log(`generated ${n} images`);
await db.end();
