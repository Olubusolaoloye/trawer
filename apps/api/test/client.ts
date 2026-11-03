import { expect } from 'vitest';
import { createApp } from '../src/app';

export const app = createApp();

let ipSeq = (Date.now() % 50_000) * 7;

/** Tiny cookie-jar client around app.request(). */
export class Client {
  private jar = new Map<string, string>();
  // Each simulated device has its own address, like real buyers/staff (the OTP limiter is per IP).
  private readonly ip = `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;
  constructor(private readonly host = 'app.trawer.test') {}

  async req<T = any>(method: string, path: string, json?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers }> {
    const res = await app.request(path, {
      method,
      headers: {
        host: this.host,
        'x-forwarded-for': this.ip,
        ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'x-trawer': '1' } : {}),
        cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const [k, v] = pair!.split('=');
      if (/max-age=0/i.test(sc) || v === '') this.jar.delete(k!);
      else this.jar.set(k!, v!);
    }
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body, headers: res.headers };
  }

  /** Multipart upload (cookies + CSRF header like the browser). */
  async upload<T = any>(path: string, form: FormData): Promise<{ status: number; body: T }> {
    const res = await app.request(path, {
      method: 'POST', body: form,
      headers: { host: this.host, 'x-forwarded-for': this.ip, 'x-trawer': '1', cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body };
  }

  get = <T = any>(p: string) => this.req<T>('GET', p);
  post = <T = any>(p: string, j: unknown = {}) => this.req<T>('POST', p, j);
  put = <T = any>(p: string, j: unknown = {}) => this.req<T>('PUT', p, j);
  patch = <T = any>(p: string, j: unknown = {}) => this.req<T>('PATCH', p, j);

  async signIn(phone: string, mfa = false) {
    expect((await this.post('/api/auth/otp', { phone })).status).toBe(200);
    const r = await this.post('/api/auth/verify', { phone, code: '000000' });
    expect(r.status).toBe(200);
    if (mfa) {
      const e = await this.post('/api/auth/mfa/enroll');
      expect((await this.post('/api/auth/mfa/verify', { factorId: e.body.factorId, code: '000000' })).status).toBe(200);
    }
    return r.body;
  }
}

let n = 0;
export function phone(): string {
  n += 1;
  return `+23481${String((Date.now() % 100000) * 100 + n).padStart(8, '0').slice(-8)}`;
}
