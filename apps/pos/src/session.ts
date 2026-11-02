/** Staff session for the till: tokens live in the OS keystore (expo-secure-store), never in SQLite. */
import * as SecureStore from 'expo-secure-store';
import { API_URL } from './config';

interface Session { accessToken: string; refreshToken: string; expiresAt: number }
export interface DeviceBinding { deviceId: string; businessId: string; businessName: string; staffId: string; role: string }

const SESSION = 'trawer.session';
const DEVICE = 'trawer.device';

async function post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Trawer': '1', 'X-Client': 'pos', ...headers },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `http_${res.status}`);
  return json;
}

export async function requestCode(phone: string): Promise<void> {
  await post('/api/auth/otp', { phone });
}

export async function verifyCode(phone: string, code: string): Promise<{ userId: string; staffBusinessIds: string[] }> {
  const r = await post<{ user: { id: string }; staffBusinessIds: string[]; session: Session }>('/api/auth/verify', { phone, code });
  await SecureStore.setItemAsync(SESSION, JSON.stringify(r.session));
  return { userId: r.user.id, staffBusinessIds: r.staffBusinessIds };
}

let refreshing: Promise<string> | null = null;

/** A valid access token, refreshing when it is about to expire. Throws when signed out. */
export async function accessToken(): Promise<string> {
  const raw = await SecureStore.getItemAsync(SESSION);
  if (!raw) throw new Error('not_authenticated');
  const s = JSON.parse(raw) as Session;
  if (s.expiresAt - 60 > Date.now() / 1000) return s.accessToken;
  refreshing ??= post<{ session: Session }>('/api/auth/refresh', { refresh_token: s.refreshToken })
    .then(async (r) => {
      await SecureStore.setItemAsync(SESSION, JSON.stringify(r.session));
      return r.session.accessToken;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export async function authed<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'X-Trawer': '1', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `http_${res.status}`);
  return json;
}

/** Raw authenticated request (callers inspect the status themselves). */
export async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_URL}${path}`, { ...init, headers: { Authorization: `Bearer ${await accessToken()}`, 'X-Trawer': '1', ...(init.headers ?? {}) } });
}

export async function getBinding(): Promise<DeviceBinding | null> {
  const raw = await SecureStore.getItemAsync(DEVICE);
  return raw ? (JSON.parse(raw) as DeviceBinding) : null;
}

export async function setBinding(b: DeviceBinding): Promise<void> {
  await SecureStore.setItemAsync(DEVICE, JSON.stringify(b));
}

export async function signOut(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION);
}
