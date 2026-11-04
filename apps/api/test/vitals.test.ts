import { afterAll, describe, expect, it } from 'vitest';
import { app } from './client';
import { pool } from '../src/db';
import { closeLive } from '../src/live';

afterAll(async () => { await closeLive(); await pool.end(); });

const post = (body: unknown, ip = '10.250.0.1') => app.request('/api/vitals', {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'content-type': 'application/json', 'x-trawer': '1', host: 'app.trawer.test', 'x-forwarded-for': ip },
});

describe('real-user speed tracking', () => {
  it('stores page timings and reports p75 per page type to operators only', async () => {
    for (const lcp of [1200, 1800, 2400, 3900]) expect((await post({ page: 'store_home', ssr: true, mobile: true, connection: '4g', lcp, inp: 120, cls: 0.02, ttfb: 300, fcp: 900 })).status).toBe(204);
    const r = await app.request('/api/cron/vitals', { headers: { authorization: 'Bearer test-cron-secret-0123456789' } });
    expect(r.status).toBe(200);
    const row = (await r.json() as any).pages.find((p: any) => p.page === 'store_home' && p.ssr);
    expect(row.visits).toBeGreaterThanOrEqual(4);
    expect(row.lcp_p75_ms).toBeGreaterThanOrEqual(2400);
    expect((await app.request('/api/cron/vitals')).status).toBe(401);
  });

  it('rejects anything that could carry personal data or junk', async () => {
    expect((await post({ page: '/s/balogun?phone=0803', lcp: 100 })).status).toBe(422);
    expect((await post({ page: 'store_home', lcp: 1e9 })).status).toBe(422);
    expect((await post({ page: 'store_home', email: 'x@y.z' })).status).toBe(204); // unknown fields dropped; nothing stored
    const { rows } = await pool.query(`select count(*)::int n from web_vitals where page = 'store_home' and lcp_ms is null and inp_ms is null and cls is null and ttfb_ms is null and fcp_ms is null`);
    expect(rows[0].n).toBe(0);
  });

  it('every API response says how long the server took', async () => {
    const r = await app.request('/api/health');
    expect(r.headers.get('server-timing')).toMatch(/^app;dur=\d+(\.\d)?$/);
  });
});
