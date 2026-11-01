import { createProduct, stubOrder } from './catalog';
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
  await rpc({ role: 'service_role' }, 'public.reserve_stock', [await stubOrder(biz.id), JSON.stringify([{ variant_id: p.variantIds[0], qty: 1 }])]);
  // pricing
  const buyer = await addBuyer(biz, 'wholesaler');
  await sql(`insert into tier_prices (business_id, tier_id, variant_id, price_kobo) values ($1, $2, $3, 200000)`, [biz.id, biz.wholesaleTierId, p.variantIds[0]]);
  await sql(`insert into customer_price_overrides (business_id, customer_id, variant_id, price_kobo) values ($1, $2, $3, 190000)`, [biz.id, buyer.customerId, p.variantIds[0]]);
  await sql(`insert into volume_breaks (business_id, variant_id, tier_id, min_qty, price_kobo) values ($1, $2, null, 12, 240000), ($1, $2, $3, 120, 180000)`, [biz.id, p.variantIds[0], biz.wholesaleTierId]);
  await sql(`insert into stock_alerts (business_id, kind, variant_id, message) values ($1, 'low_stock', $2, 'low')`, [biz.id, p.variantIds[1]]);

  // orders + payments
  const o = await rpc<any>(buyer, 'public.place_order', [JSON.stringify({ business_id: biz.id, channel: 'web', items: [{ variant_id: p.variantIds[0], qty: 2 }] })]);
  await sql(`insert into virtual_accounts (business_id, customer_id, provider, account_number, account_name, bank_name)
             values ($1, $2, 'paystack', $3, 'Buyer', 'Wema')`, [biz.id, buyer.customerId, String(Math.floor(1e9 + Math.random() * 8e9))]);
  await sql(`select app.apply_payment($1, $2, null, 1000, 'transfer')`, [biz.id, o.id]);
  const [cart] = await sql(`insert into carts (business_id, customer_id, channel) values ($1, $2, 'whatsapp') returning id`, [biz.id, buyer.customerId]);
  await sql(`insert into cart_items (business_id, cart_id, variant_id, unit_id, unit_qty) values ($1, $2, $3, $4, 1)`, [biz.id, cart!.id, p.variantIds[0], p.pieceUnitId]);
  await sql(`insert into webhook_events (provider, event_id, business_id, payload, signature_valid) values ('paystack', $1, $2, '{}', true)`, [`evt-${biz.id}`, biz.id]);
}
