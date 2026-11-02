/**
 * Rider outbox: delivery status updates (and their proof photos) are saved on the phone first and
 * sent in order when there is network. Each update carries a client id, so a retry after a dropped
 * connection can never record the same step twice (the server is idempotent on it).
 */
export type RiderStatus = 'dispatched' | 'delivered' | 'failed';
export type FailureReason = 'not_home' | 'wrong_address' | 'refused' | 'unreachable' | 'damaged' | 'other';

export interface RiderAction {
  clientId: string;
  orderId: string;
  orderNumber: number;
  status: RiderStatus;
  failure?: FailureReason;
  note?: string;
  receivedBy?: string;
  photoUri?: string;      // local file until uploaded
  proofPath?: string;     // set once the photo is uploaded
  occurredAt: string;
}

export interface RiderStore { load(): Promise<RiderAction[]>; save(items: RiderAction[]): Promise<void> }
export interface RiderApi {
  upload(orderId: string, photoUri: string): Promise<string>;
  status(orderId: string, body: { status: RiderStatus; failure?: FailureReason; note?: string; received_by?: string; proof_path?: string; client_id: string; occurred_at: string }): Promise<unknown>;
}

/** Errors the server will never accept on retry (as opposed to "no network"). */
export class RejectedError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export interface FlushResult { sent: number; rejected: { action: RiderAction; code: string }[]; offline: boolean }

export class RiderQueue {
  private running: Promise<FlushResult> | null = null;
  constructor(private readonly store: RiderStore, private readonly api: RiderApi) {}

  pending(): Promise<RiderAction[]> { return this.store.load(); }

  async enqueue(a: RiderAction): Promise<void> {
    const items = await this.store.load();
    if (!items.some((x) => x.clientId === a.clientId)) await this.store.save([...items, a]);
  }

  /** Send everything that's waiting, oldest first. Safe to call often; concurrent calls share one run. */
  flush(): Promise<FlushResult> {
    this.running ??= this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run(): Promise<FlushResult> {
    const out: FlushResult = { sent: 0, rejected: [], offline: false };
    let items = await this.store.load();
    while (items.length) {
      const a = items[0]!;
      try {
        if (a.photoUri && !a.proofPath) {
          const path = await this.api.upload(a.orderId, a.photoUri);
          items = [{ ...a, proofPath: path }, ...items.slice(1)];
          await this.store.save(items);           // don't upload the same photo twice
          continue;
        }
        await this.api.status(a.orderId, {
          status: a.status, failure: a.failure, note: a.note, received_by: a.receivedBy, proof_path: a.proofPath,
          client_id: a.clientId, occurred_at: a.occurredAt,
        });
        out.sent += 1;
      } catch (e) {
        if (!(e instanceof RejectedError)) { out.offline = true; break; }
        out.rejected.push({ action: a, code: e.code });
      }
      items = items.slice(1);
      await this.store.save(items);
    }
    return out;
  }
}

/** What the rider should see for an order: the server's status, overridden by anything still queued. */
export function effectiveStatus(serverStatus: string, orderId: string, queued: RiderAction[]): string {
  const mine = queued.filter((q) => q.orderId === orderId);
  return mine.length ? mine[mine.length - 1]!.status : serverStatus;
}

export const FAILURE_LABEL: Record<FailureReason, string> = {
  not_home: 'Nobody at home', wrong_address: 'Wrong address', refused: 'Customer refused',
  unreachable: "Can't reach on phone", damaged: 'Goods damaged', other: 'Other reason',
};

export function addressLine(a: { line1?: string; area?: string; city?: string; state?: string; landmark?: string } | null | undefined): string {
  if (!a) return '';
  return [a.line1, a.area, a.city, a.state].filter(Boolean).join(', ');
}

export function mapsUrl(a: Parameters<typeof addressLine>[0]): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addressLine(a))}`;
}
