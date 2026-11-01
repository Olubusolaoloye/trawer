import { randomUUID } from 'node:crypto';
import { createProduct } from './catalog';
import { addBuyer, addStaff, q, rpc, sql, type TestBusiness } from './helpers';

/**
 * Put at least one row in every tenant table for `biz`, so the generic isolation tests have
 * something to leak. Extended as milestones add tables.
 */
export async function populateBusiness(biz: TestBusiness): Promise<void> {
  await addStaff(biz, 'cashier');
  await addBuyer(biz, 'wholesaler');
  await addBuyer(biz, 'retailer');
  await rpc(biz.owner.mfa, 'public.set_payout_account', [biz.id, '058', 'GTB', '0123456789', 'Biz']);
  await sql(`insert into roles_permissions (business_id, role, permission, allowed) values ($1, 'rider', 'orders.view', true)`, [biz.id]);
  await sql(`insert into locations (business_id, name) values ($1, 'Warehouse')`, [biz.id]);

  // catalogue + inventory
  const p = await createProduct(biz, [{ colour: 'Red', price: 250_000, cost: 180_000, stock: 40 }, { colour: 'Gold', price: 260_000, stock: 2 }]);
  await createProduct(biz, [{ price: 1000, stock: 1 }], { status: 'draft', name: 'Secret draft' });
  await sql(`insert into variant_images (business_id, product_id, variant_id, path) values ($1, $2, $3, 'x/y.webp')`, [biz.id, p.id, p.variantIds[0]]);
  await sql(`insert into units (business_id, name, plural) values ($1, 'half carton', 'half cartons')`, [biz.id]);
  const [d] = await q(biz.owner, `insert into devices (business_id, location_id, name) values ($1, $2, 'Till') returning id`, [biz.id, biz.locationId]);
  await rpc(biz.owner, 'public.allocate_to_device', [d!.id, p.variantIds[0], 5]);
  await rpc({ role: 'service_role' }, 'public.reserve_stock', [randomUUID(), JSON.stringify([{ variant_id: p.variantIds[0], qty: 1 }])]);
  await sql(`insert into stock_alerts (business_id, kind, variant_id, message) values ($1, 'low_stock', $2, 'low')`, [biz.id, p.variantIds[1]]);
}
