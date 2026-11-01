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
  for (const pack of input.packs) {
    await tx.query(`insert into product_units (business_id, product_id, unit_id, factor) values ($1, $2, $3, $4)
                    on conflict (product_id, unit_id) do update set factor = excluded.factor`,
      [businessId, pid, units.get(pack.unit.toLowerCase()), pack.factor]);
  }
  for (const [i, v] of input.variants.entries()) {
    const variant = await one<{ id: string }>(tx,
      `insert into product_variants (business_id, product_id, sku, barcode, colour, colour_hex, size, retail_price_kobo, position)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [businessId, pid, v.sku || null, v.barcode || null, v.colour || null, v.colour_hex || null, v.size || null, v.retail_price_kobo, i]);
    if (v.cost_kobo != null) {
      await tx.query(`insert into variant_costs (business_id, variant_id, cost_kobo) values ($1, $2, $3)`, [businessId, variant!.id, v.cost_kobo]);
    }
    if (v.image_path) {
      await tx.query(`insert into variant_images (business_id, product_id, variant_id, path, position) values ($1, $2, $3, $4, 0)`,
        [businessId, pid, input.variants.length > 1 ? variant!.id : null, v.image_path]);
    }
    if (v.opening_stock) {
      await tx.query(`select public.receive_stock($1, $2, null, 'opening stock')`, [variant!.id, v.opening_stock]);
    }
  }
  // Publish last so drafts-with-price rules apply while variants are inserted.
  if (input.status === 'active') {
    await tx.query(`update products set status = 'active' where id = $1`, [pid]);
  }
  return pid;
}
