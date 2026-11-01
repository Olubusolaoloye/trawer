/**
 * PaymentProvider: dedicated virtual accounts (DVA). Paystack is primary; Monnify can be added
 * by implementing this interface. Trawer never stores card data and never holds funds: DVAs are
 * created against the business's Paystack subaccount so settlement goes straight to the trader.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface DvaCustomer {
  customerId: string;
  phone: string;
  firstName: string;
  lastName: string;
  email?: string;
}

export interface DedicatedAccount {
  accountNumber: string;
  accountName: string;
  bankName: string;
  providerCustomerCode?: string;
  providerRef?: string;
}

export interface PayoutDestination {
  businessName: string;
  bankCode: string;
  accountNumber: string;
}

export interface PaymentEvent {
  eventId: string;
  type: 'payment.received' | 'account.assigned' | 'ignored';
  accountNumber?: string;
  amountKobo?: number;
  reference?: string;
  paidAt?: string;
  customerCode?: string;
  account?: DedicatedAccount;
}

export interface PaymentProvider {
  readonly name: string;
  ensureSubaccount(dest: PayoutDestination): Promise<string>;
  createDedicatedAccount(customer: DvaCustomer, subaccountCode?: string): Promise<DedicatedAccount>;
  verifySignature(rawBody: string, headers: Headers): boolean;
  parseEvent(rawBody: string): PaymentEvent;
}

export function hmacHex(alg: 'sha256' | 'sha512', secret: string, body: string): string {
  return createHmac(alg, secret).update(body, 'utf8').digest('hex');
}

export function safeEqualHex(a: string | null | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

type Fetch = typeof fetch;

export class PaystackProvider implements PaymentProvider {
  readonly name = 'paystack';
  constructor(
    private readonly secretKey: string,
    private readonly opts: { preferredBank?: string; baseUrl?: string; fetch?: Fetch } = {},
  ) {
    if (!secretKey) throw new Error('payment_not_configured');
  }

  private async call<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> {
    const f = this.opts.fetch ?? fetch;
    const res = await f(`${this.opts.baseUrl ?? 'https://api.paystack.co'}${path}`, {
      method: init.method,
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const json = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: T };
    if (!res.ok || !json.status) throw new Error(`paystack ${path} failed: ${json.message ?? res.status}`);
    return json.data as T;
  }

  async ensureSubaccount(dest: PayoutDestination): Promise<string> {
    const data = await this.call<{ subaccount_code: string }>('/subaccount', {
      method: 'POST',
      body: {
        business_name: dest.businessName,
        settlement_bank: dest.bankCode,
        account_number: dest.accountNumber,
        percentage_charge: 0,
      },
    });
    return data.subaccount_code;
  }

  async createDedicatedAccount(c: DvaCustomer, subaccountCode?: string): Promise<DedicatedAccount> {
    // Paystack requires an email; buyers sign in by phone, so we use a non-routable alias.
    const email = c.email ?? `${c.customerId}@buyers.trawer.shop`;
    const customer = await this.call<{ customer_code: string }>('/customer', {
      method: 'POST',
      body: { email, first_name: c.firstName, last_name: c.lastName, phone: c.phone, metadata: { trawer_customer_id: c.customerId } },
    });
    const dva = await this.call<{
      id: number;
      account_number: string;
      account_name: string;
      bank: { name: string };
    }>('/dedicated_account', {
      method: 'POST',
      body: {
        customer: customer.customer_code,
        preferred_bank: this.opts.preferredBank ?? 'wema-bank',
        ...(subaccountCode ? { subaccount: subaccountCode } : {}),
      },
    });
    return {
      accountNumber: dva.account_number,
      accountName: dva.account_name,
      bankName: dva.bank.name,
      providerCustomerCode: customer.customer_code,
      providerRef: String(dva.id),
    };
  }

  verifySignature(rawBody: string, headers: Headers): boolean {
    return safeEqualHex(headers.get('x-paystack-signature'), hmacHex('sha512', this.secretKey, rawBody));
  }

  parseEvent(rawBody: string): PaymentEvent {
    const evt = JSON.parse(rawBody) as { event: string; data: Record<string, any> };
    const d = evt.data ?? {};
    const eventId = `${evt.event}:${d.id ?? d.reference ?? ''}`;
    if (evt.event === 'charge.success' && d.authorization?.channel === 'dedicated_nuban') {
      return {
        eventId,
        type: 'payment.received',
        accountNumber: String(d.authorization.receiver_bank_account_number ?? ''),
        amountKobo: Number(d.amount),
        reference: String(d.reference),
        paidAt: d.paid_at ?? d.paidAt,
        customerCode: d.customer?.customer_code,
      };
    }
    if (evt.event === 'dedicatedaccount.assign.success') {
      return {
        eventId,
        type: 'account.assigned',
        customerCode: d.customer?.customer_code,
        account: {
          accountNumber: d.dedicated_account?.account_number,
          accountName: d.dedicated_account?.account_name,
          bankName: d.dedicated_account?.bank?.name,
          providerCustomerCode: d.customer?.customer_code,
          providerRef: String(d.dedicated_account?.id ?? ''),
        },
      };
    }
    return { eventId, type: 'ignored' };
  }
}

/**
 * Local sandbox: deterministic account numbers, HMAC-signed fake webhooks. Lets the full
 * checkout → transfer → confirmation flow run without network access.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';
  constructor(private readonly secret = 'fake-paystack-secret') {}

  async ensureSubaccount(dest: PayoutDestination): Promise<string> {
    return `ACCT_fake_${dest.accountNumber}`;
  }

  async createDedicatedAccount(c: DvaCustomer): Promise<DedicatedAccount> {
    const digits = hmacHex('sha256', this.secret, c.customerId).replace(/\D/g, '').padEnd(10, '7').slice(0, 9);
    return {
      accountNumber: `9${digits}`,
      accountName: `TRAWER/${c.firstName} ${c.lastName}`.toUpperCase().slice(0, 40),
      bankName: 'Test Bank (sandbox)',
      providerCustomerCode: `CUS_fake_${c.customerId.slice(0, 8)}`,
      providerRef: `fake-${c.customerId}`,
    };
  }

  /** Build a Paystack-shaped transfer event + signature (for tests and the dev "simulate" button). */
  simulateTransfer(accountNumber: string, amountKobo: number, reference: string): { body: string; signature: string } {
    const body = JSON.stringify({
      event: 'charge.success',
      data: {
        id: reference,
        reference,
        amount: amountKobo,
        paid_at: new Date().toISOString(),
        authorization: { channel: 'dedicated_nuban', receiver_bank_account_number: accountNumber },
      },
    });
    return { body, signature: hmacHex('sha512', this.secret, body) };
  }

  verifySignature(rawBody: string, headers: Headers): boolean {
    return safeEqualHex(headers.get('x-paystack-signature'), hmacHex('sha512', this.secret, rawBody));
  }

  parseEvent(rawBody: string): PaymentEvent {
    return new PaystackProvider('fake').parseEvent(rawBody);
  }
}
