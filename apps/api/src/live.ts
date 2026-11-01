/**
 * Fan-out of order changes: one LISTEN connection per API process, many SSE subscribers.
 * Needs a session-mode connection (Supabase: direct or session pooler, not transaction mode):
 * DATABASE_LISTEN_URL, falling back to DATABASE_URL.
 */
import pg from 'pg';
import { env } from './env';

type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();
let client: pg.Client | null = null;
let connecting: Promise<void> | null = null;

async function connect(): Promise<void> {
  if (client) return;
  if (!connecting) {
    connecting = (async () => {
      const c = new pg.Client({ connectionString: process.env.DATABASE_LISTEN_URL ?? env.DATABASE_URL });
      c.on('notification', (msg) => {
        if (msg.channel !== 'trawer_orders' || !msg.payload) return;
        for (const fn of listeners.get(msg.payload) ?? []) fn();
      });
      c.on('error', () => {
        client = null;
        connecting = null;
        setTimeout(() => void connect().catch(() => undefined), 2000);
      });
      await c.connect();
      await c.query('listen trawer_orders');
      client = c;
    })().finally(() => {
      connecting = null;
    });
  }
  await connecting;
}

export async function onOrderChange(orderId: string, fn: Listener): Promise<() => void> {
  await connect();
  let set = listeners.get(orderId);
  if (!set) listeners.set(orderId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(orderId);
  };
}

export async function closeLive(): Promise<void> {
  await client?.end().catch(() => undefined);
  client = null;
}
