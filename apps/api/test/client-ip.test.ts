import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { clientIp, type AppEnv } from '../src/http';

const app = new Hono<AppEnv>();
app.get('/ip', (c) => c.text(clientIp(c)));
const ip = async (xff?: string) => (await app.request('/ip', { headers: xff ? { 'x-forwarded-for': xff } : {} })).text();

describe('client IP for rate limits (TRUST_PROXY_HOPS=1 in tests)', () => {
  it('uses the address our proxy appended, never the spoofable left-most entry', async () => {
    expect(await ip('6.6.6.6, 41.58.10.20')).toBe('41.58.10.20');   // attacker typed 6.6.6.6
    expect(await ip('41.58.10.20')).toBe('41.58.10.20');
    expect(await ip()).toBe('unknown');                                // no socket in-process
  });
});
