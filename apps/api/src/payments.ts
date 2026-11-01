import { FakePaymentProvider, PaystackProvider, type PaymentProvider } from '@trawer/core/payments';
import { env } from './env';
import { one, withService } from './db';

let provider: PaymentProvider | null = null;
export function paymentProvider(): PaymentProvider {
  if (!provider) {
    provider = env.PAYMENT_PROVIDER === 'paystack'
      ? new PaystackProvider(env.PAYSTACK_SECRET_KEY ?? '', { preferredBank: env.PAYSTACK_PREFERRED_BANK })
      : new FakePaymentProvider();
  }
  return provider;
}
export function setPaymentProvider(p: PaymentProvider): void {
  provider = p;
}

export interface VirtualAccountView {
  account_number: string;
  account_name: string;
  bank_name: string;
}

/**
 * Get (or create) the buyer's dedicated virtual account at this business. Creates the business's
 * settlement subaccount on first use so funds settle directly to the trader.
 */
export async function ensureVirtualAccount(customerId: string): Promise<VirtualAccountView> {
  const p = paymentProvider();
  const existing = await withService((tx) => one<VirtualAccountView>(tx,
    `select account_number, account_name, bank_name from virtual_accounts where customer_id = $1 and provider = $2 and status = 'active'`,
    [customerId, p.name]));
  if (existing) return existing;

  const ctx = await withService((tx) => one<{ business_id: string; name: string; phone: string; business_name: string;
    bank_code: string | null; account_number: string | null; subaccount: string | null }>(tx,
    `select c.business_id, c.name, c.phone, b.name business_name, pa.bank_code, pa.account_number,
            pa.provider_subaccount_code subaccount
     from customers c join businesses b on b.id = c.business_id
     left join business_payout_accounts pa on pa.business_id = c.business_id
     where c.id = $1`, [customerId]));
  if (!ctx) throw new Error('unknown customer');

  let subaccount = ctx.subaccount;
  if (!subaccount && ctx.bank_code && ctx.account_number) {
    subaccount = await p.ensureSubaccount({ businessName: ctx.business_name, bankCode: ctx.bank_code, accountNumber: ctx.account_number });
    await withService((tx) => tx.query(`update business_payout_accounts set provider_subaccount_code = $2 where business_id = $1`, [ctx.business_id, subaccount]));
  }
  if (!subaccount && env.PAYMENT_PROVIDER === 'paystack') {
    // Without a settlement subaccount the money would land in the platform account: refuse.
    throw new Error('payout_account_missing');
  }
  const [first, ...rest] = (ctx.name || 'Trawer Buyer').split(/\s+/);
  const acct = await p.createDedicatedAccount(
    { customerId, phone: ctx.phone, firstName: first || 'Trawer', lastName: rest.join(' ') || 'Buyer' },
    subaccount ?? undefined,
  );
  return withService(async (tx) => {
    const row = await one<VirtualAccountView>(tx,
      `insert into virtual_accounts (business_id, customer_id, provider, provider_customer_code, provider_ref, account_number, account_name, bank_name)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (business_id, customer_id, provider) do update set status = 'active'
       returning account_number, account_name, bank_name`,
      [ctx.business_id, customerId, p.name, acct.providerCustomerCode ?? null, acct.providerRef ?? null,
       acct.accountNumber, acct.accountName, acct.bankName]);
    return row!;
  });
}
