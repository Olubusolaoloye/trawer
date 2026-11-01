import { addBuyer, addStaff, rpc, sql, type TestBusiness } from './helpers';

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
  for (const extend of extenders) await extend(biz);
}

type Extender = (biz: TestBusiness) => Promise<void>;
const extenders: Extender[] = [];
export function registerFixture(fn: Extender): void {
  extenders.push(fn);
}
