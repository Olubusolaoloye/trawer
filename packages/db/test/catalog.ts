import { q, sql, type TestBusiness, type TestUser } from './helpers';

export interface VariantSpec {
  colour?: string;
  size?: string;
  price: number; // kobo per base unit
  cost?: number;
  stock?: number;
}

export interface TestProduct {
  id: string;
  variantIds: string[];
  cartonUnitId: string;
  pieceUnitId: string;
}

let unitCache: { piece: string; carton: string } | null = null;
export async function units() {
  if (!unitCache) {
    const rows = await sql<{ id: string; name: string }>(`select id, name from units where business_id is null and name in ('piece','carton')`);
    unitCache = {
      piece: rows.find((r) => r.name === 'piece')!.id,
      carton: rows.find((r) => r.name === 'carton')!.id,
    };
  }
  return unitCache;
}

/** Create an active product (as the owner) with variants, a carton unit and optional stock. */
export async function createProduct(
  biz: TestBusiness,
  variants: VariantSpec[] = [{ price: 100_000, stock: 10 }],
  opts: { name?: string; cartonFactor?: number; status?: 'active' | 'draft'; as?: TestUser } = {},
): Promise<TestProduct> {
  const u = await units();
  const actor = opts.as ?? biz.owner;
  const [p] = await q(actor, `insert into products (business_id, name, category, base_unit_id, status)
                              values ($1, $2, 'Fabrics', $3, $4) returning id`,
    [biz.id, opts.name ?? 'Ankara wax print', u.piece, opts.status ?? 'active']);
  await q(actor, `insert into product_units (business_id, product_id, unit_id, factor) values ($1, $2, $3, $4)`,
    [biz.id, p!.id, u.carton, opts.cartonFactor ?? 12]);
  const variantIds: string[] = [];
  for (const [i, v] of variants.entries()) {
    const [row] = await q(actor, `insert into product_variants (business_id, product_id, colour, size, retail_price_kobo, position)
                                  values ($1, $2, $3, $4, $5, $6) returning id`,
      [biz.id, p!.id, v.colour ?? null, v.size ?? null, v.price, i]);
    variantIds.push(row!.id);
    if (v.cost != null) {
      await q(actor, `insert into variant_costs (business_id, variant_id, cost_kobo) values ($1, $2, $3)`, [biz.id, row!.id, v.cost]);
    }
    if (v.stock) {
      await q(actor, `select public.receive_stock($1, $2, null, 'opening stock')`, [row!.id, v.stock]);
    }
  }
  return { id: p!.id, variantIds, cartonUnitId: u.carton, pieceUnitId: u.piece };
}

export async function level(variantId: string) {
  const [r] = await sql(`select coalesce(sum(on_hand),0)::int on_hand, coalesce(sum(reserved),0)::int reserved,
                         coalesce(sum(allocated),0)::int allocated, coalesce(sum(available),0)::int available
                         from stock_levels where variant_id = $1`, [variantId]);
  return r as { on_hand: number; reserved: number; allocated: number; available: number };
}

/** Recompute every bucket from the ledger and compare to stock_levels. Returns mismatches. */
export async function ledgerMismatches(businessId?: string) {
  return sql(`
    with replay as (
      select variant_id, location_id,
        coalesce(sum(qty_delta) filter (where type in ('receive','sale','adjust','return','transfer_in','transfer_out')), 0) as on_hand,
        coalesce(sum(qty_delta) filter (where type in ('reserve','release')), 0) as reserved,
        coalesce(sum(qty_delta) filter (where type in ('allocate','deallocate')), 0) as allocated
      from stock_movements where $1::uuid is null or business_id = $1 group by 1, 2)
    select sl.variant_id, sl.on_hand, r.on_hand as replay_on_hand, sl.reserved, r.reserved as replay_reserved,
           sl.allocated, r.allocated as replay_allocated
    from stock_levels sl left join replay r using (variant_id, location_id)
    where ($1::uuid is null or sl.business_id = $1)
      and (sl.on_hand <> coalesce(r.on_hand,0) or sl.reserved <> coalesce(r.reserved,0) or sl.allocated <> coalesce(r.allocated,0))`,
    [businessId ?? null]);
}

/** Insert a bare pending order (superuser) so low-level stock functions have a real order id. */
export async function stubOrder(businessId: string): Promise<string> {
  const [o] = await sql(`insert into orders (business_id, order_number, channel, location_id)
                         values ($1, app.next_counter($1, 'order'), 'web', app.default_location($1)) returning id`, [businessId]);
  return o!.id;
}
