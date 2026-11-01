import * as Network from 'expo-network';
import { HttpPosTransport, PosEngine } from '@trawer/core/pos';
import { database } from './db';
import { WatermelonCatalog, WatermelonOutbox, WatermelonState } from './db/repos';
import { API_URL } from './config';
import { accessToken, type DeviceBinding } from './session';

export interface SyncStatus { online: boolean; pending: number; lastSyncAt: string | null; syncing: boolean; error: string | null; conflicts: number }

let engine: PosEngine | null = null;
export const catalog = new WatermelonCatalog(database);
export const stateRepo = new WatermelonState(database);
const outbox = new WatermelonOutbox(database);

export function getEngine(binding: DeviceBinding): PosEngine {
  engine ??= new PosEngine(catalog, outbox, stateRepo, new HttpPosTransport(API_URL, accessToken), {
    deviceId: binding.deviceId,
    staffId: binding.staffId,
  });
  return engine;
}

/** Background sync: every 30s while online, immediately when connectivity returns. */
export function startSyncLoop(e: PosEngine, onStatus: (s: SyncStatus) => void): () => void {
  let stopped = false;
  let status: SyncStatus = { online: false, pending: 0, lastSyncAt: null, syncing: false, error: null, conflicts: 0 };
  const emit = (patch: Partial<SyncStatus>) => { status = { ...status, ...patch }; onStatus(status); };

  async function tick() {
    if (stopped) return;
    const net = await Network.getNetworkStateAsync().catch(() => null);
    const online = !!net?.isConnected && net.isInternetReachable !== false;
    emit({ online, pending: await e.pendingCount() });
    if (!online) return;
    emit({ syncing: true });
    try {
      const r = await e.sync();
      emit({ syncing: false, error: null, lastSyncAt: new Date().toISOString(), pending: await e.pendingCount(), conflicts: status.conflicts + r.conflicts });
    } catch (err) {
      emit({ syncing: false, error: (err as Error).message, pending: await e.pendingCount() });
    }
  }

  void tick();
  const timer = setInterval(() => void tick(), 30_000);
  const sub = Network.addNetworkStateListener((s) => { if (s.isConnected) void tick(); });
  return () => { stopped = true; clearInterval(timer); sub.remove(); };
}
