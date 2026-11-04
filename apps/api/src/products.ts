/**
 * Product creation shared by the dashboard form, snap-to-upload (AI draft) and bulk import.
 * Runs as the staff user: RLS + guard triggers decide what is allowed (e.g. cashiers can only
 * create drafts; publishing and live price changes need products.manage / prices.manage).
 */
import type { ProductInput } from '@trawer/core/schemas';
import { many, one, type Tx } from './db';

export async function unitIds(tx: Tx, businessId: string, names: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(names.map((n) => n.trim().toLowerCase()))];
  const rows = await many<{ id: string; name: string; business_id: string | null }>(tx,
    `select id, lower(name) as name, business_id from units
     where (business_id is null or business_id = $1) and (lower(name) = any($2) or lower(plural) = any($2))
     order by business_id nulls last`, [businessId, wanted]);
  const map = new Map<string, string>();
  for (const r of rows) if (!map.has(r.name)) map.set(r.name, r.id);
  for (const n of wanted) {
    if (map.has(n)) continue;
    const plural = await one<{ id: string; name: string }>(tx,
      `select id, lower(name) name from units where (business_id is null or business_id = $1) and lower(plural) = $2 limit 1`, [businessId, n]);
    if (plural) {
      map.set(n, plural.id);
      continue;
    }
    const created = await one<{ id: string }>(tx,
      `insert into units (business_id, name, plural) values ($1, $2, $2 || 's') returning id`, [businessId, n]);
    map.set(n, created!.id);
  }
  return map;
}

export async function createProduct(tx: Tx, businessId: string, input: ProductInput, opts: { aiDraft?: unknown } = {}): Promise<string> {
  const units = await unitIds(tx, businessId, [input.base_unit, ...input.packs.map((p) => p.unit)]);
  const product = await one<{ id: string }>(tx,
    `insert into products (business_id, name, description, category, brand, base_unit_id, status, source, ai_draft)
     values ($1, $2, $3, $4, $5, $6, 'draft', $7, $8) returning id`,
    [businessId, input.name, input.description, input.category ?? null, input.brand ?? null,
     units.get(input.base_unit.toLowerCase()), input.source, opts.aiDraft ? JSON.stringify(opts.aiDraft) : null]);
  const pid = product!.id;
  // One statement per step, whatever the number of packs or colours (no query per row).
  if (input.packs.length) {
    await tx.query(`insert into product_units (business_id, product_id, unit_id, factor)
                    select $1, $2, u, f from unnest($3::uuid[], $4::int[]) as x(u, f)
                    on conflict (product_id, unit_id) do update set factor = excluded.factor`,
      [businessId, pid, input.packs.map((p) => units.get(p.unit.toLowerCase())), input.packs.map((p) => p.factor)]);
  }
  const v = input.variants;
  const col = <T>(f: (x: (typeof v)[number]) => T) => v.map(f);
  const ids = (await many<{ id: string; position: number }>(tx,
    `insert into product_variants (business_id, product_id, sku, barcode, colour, colour_hex, size, retail_price_kobo, position)
     select $1, $2, sku, barcode, colour, hex, size, price, pos
     from unnest($3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::bigint[], $9::int[]) as x(sku, barcode, colour, hex, size, price, pos)
     order by pos
     returning id, position`,
    [businessId, pid, col((x) => x.sku || null), col((x) => x.barcode || null), col((x) => x.colour || null), col((x) => x.colour_hex || null),
     col((x) => x.size || null), col((x) => x.retail_price_kobo), v.map((_, i) => i)]))
    .sort((a, b) => a.position - b.position).map((r) => r.id);
  const withCost = v.flatMap((x, i) => (x.cost_kobo != null ? [[ids[i]!, x.cost_kobo] as const] : []));
  if (withCost.length) {
    await tx.query(`insert into variant_costs (business_id, variant_id, cost_kobo) select $1, id, c from unnest($2::uuid[], $3::bigint[]) as x(id, c)`,
      [businessId, withCost.map((w) => w[0]), withCost.map((w) => w[1])]);
  }
  const withImage = v.flatMap((x, i) => (x.image_path ? [[v.length > 1 ? ids[i]! : null, x.image_path] as const] : []));
  if (withImage.length) {
    await tx.query(`insert into variant_images (business_id, product_id, variant_id, path, position) select $1, $2, id, path, 0 from unnest($3::uuid[], $4::text[]) as x(id, path)`,
      [businessId, pid, withImage.map((w) => w[0]), withImage.map((w) => w[1])]);
  }
  const withStock = v.flatMap((x, i) => (x.opening_stock ? [[ids[i]!, x.opening_stock] as const] : []));
  if (withStock.length) {
    await tx.query(`select public.receive_stock(id, qty, null, 'opening stock') from unnest($1::uuid[], $2::int[]) as x(id, qty)`,
      [withStock.map((w) => w[0]), withStock.map((w) => w[1])]);
  }
  // Publish last so drafts-with-price rules apply while variants are inserted.
  if (input.status === 'active') {
    await tx.query(`update products set status = 'active' where id = $1`, [pid]);
  }
  return pid;
}
