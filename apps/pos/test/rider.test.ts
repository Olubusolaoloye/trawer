import { describe, expect, it } from 'vitest';
import { RejectedError, RiderQueue, effectiveStatus, mapsUrl, type RiderAction, type RiderApi, type RiderStore } from '../src/rider';

function memoryStore(): RiderStore & { items: RiderAction[] } {
  const s = { items: [] as RiderAction[], load: async () => [...s.items], save: async (i: RiderAction[]) => { s.items = [...i]; } };
  return s;
}
const act = (over: Partial<RiderAction>): RiderAction => ({ clientId: crypto.randomUUID(), orderId: 'o1', orderNumber: 1043, status: 'dispatched', occurredAt: '2026-11-02T10:00:00Z', ...over });

describe('rider outbox', () => {
  it('keeps updates while offline and sends them in order (photo first) when back online', async () => {
    const store = memoryStore();
    let online = false;
    const calls: string[] = [];
    const api: RiderApi = {
      upload: async (o, uri) => { if (!online) throw new Error('network'); calls.push(`upload:${o}:${uri}`); return 'biz/p.webp'; },
      status: async (o, b) => { if (!online) throw new Error('network'); calls.push(`status:${o}:${b.status}:${b.proof_path ?? ''}`); return {}; },
    };
    const q = new RiderQueue(store, api);
    await q.enqueue(act({ status: 'dispatched' }));
    const d = act({ status: 'delivered', photoUri: 'file:///proof.jpg', receivedBy: 'Ada' });
    await q.enqueue(d);
    await q.enqueue(d); // double tap: same client id, queued once
    expect(await q.flush()).toMatchObject({ sent: 0, offline: true });
    expect(store.items).toHaveLength(2);
    expect(effectiveStatus('packed', 'o1', store.items)).toBe('delivered');

    online = true;
    expect(await q.flush()).toMatchObject({ sent: 2, offline: false });
    expect(calls).toEqual(['status:o1:dispatched:', 'upload:o1:file:///proof.jpg', 'status:o1:delivered:biz/p.webp']);
    expect(store.items).toEqual([]);
  });

  it('does not re-upload a photo after a dropped connection, and skips updates the server rejects', async () => {
    const store = memoryStore();
    let uploads = 0;
    let failNextStatus = true;
    const api: RiderApi = {
      upload: async () => { uploads += 1; return 'biz/p.webp'; },
      status: async (o) => {
        if (o === 'bad') throw new RejectedError('invalid_transition');
        if (failNextStatus) { failNextStatus = false; throw new Error('network'); }
        return {};
      },
    };
    const q = new RiderQueue(store, api);
    await q.enqueue(act({ orderId: 'bad' }));
    await q.enqueue(act({ status: 'delivered', photoUri: 'file:///a.jpg' }));
    const first = await q.flush();
    expect(first.rejected.map((r) => r.code)).toEqual(['invalid_transition']);
    expect(first.offline).toBe(true);
    expect(store.items[0]!.proofPath).toBe('biz/p.webp');
    await q.flush();
    expect(uploads).toBe(1);
    expect(store.items).toEqual([]);
  });

  it('builds a maps link from the delivery address', () => {
    expect(mapsUrl({ line1: '12 Upper Iweka Road', city: 'Onitsha', state: 'Anambra' })).toBe('https://www.google.com/maps/search/?api=1&query=12%20Upper%20Iweka%20Road%2C%20Onitsha%2C%20Anambra');
  });
});
