import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVICE } from '../src/claims';
import { createProduct } from './catalog';
import { addStaff, createBusiness, expectPgError, pool, q, rpc, sql, type TestBusiness } from './helpers';

let biz: TestBusiness;
let cashier: Awaited<ReturnType<typeof addStaff>>;
let p1: string;
let p2: string;
let noPhoto: string;

const photo = (pid: string) => sql(`insert into variant_images (business_id, product_id, path) values ($1, $2, $3)`, [biz.id, pid, `${biz.id}/${pid}.webp`]);
const secrets = async () => (await sql(`select count(*)::int n from vault.secrets where name like $1`, [`social_%:${biz.id}:%`]))[0]!.n as number;

beforeAll(async () => {
  biz = await createBusiness('Social Co');
  cashier = await addStaff(biz, 'cashier');
  p1 = (await createProduct(biz, [{ price: 18_500_00, stock: 50 }], { name: 'Hollandais wax' })).id;
  p2 = (await createProduct(biz, [{ price: 39_000_00, stock: 50 }], { name: 'Swiss voile lace' })).id;
  noPhoto = (await createProduct(biz, [{ price: 1_000_00, stock: 5 }], { name: 'No photo yet' })).id;
  await photo(p1); await photo(p2);
});
afterAll(async () => { await pool.end(); });

async function connect() {
  const sid = await rpc<string>(biz.owner, 'public.begin_social_connect', [biz.id, JSON.stringify([
    { page_id: 'pg1', page_name: 'Balogun Fabrics', ig_id: 'ig1', ig_username: 'balogunfabrics', token: 'EAAB-page-token-1' },
    { page_id: 'pg2', page_name: 'Other Page', ig_id: null, ig_username: null, token: 'EAAB-page-token-2' },
  ])]);
  return sid;
}

describe('connecting Instagram + Facebook', () => {
  it('choices hide tokens; picking needs MFA; only the chosen token is kept', async () => {
    const sid = await connect();
    const choices = await rpc<any[]>(biz.owner, 'public.social_connect_choices', [sid]);
    expect(choices.map((c) => c.page_name)).toEqual(['Balogun Fabrics', 'Other Page']);
    expect(JSON.stringify(choices)).not.toMatch(/secret_id|EAAB/);
    expect(await rpc(cashier, 'public.social_connect_choices', [sid])).toBeNull(); // someone else's session

    await expectPgError(rpc(biz.owner, 'public.connect_social_account', [sid, 'pg1']), 'mfa_required');
    expect(await rpc(biz.owner.mfa, 'public.connect_social_account', [sid, 'pg1'])).toEqual({ facebook: 'Balogun Fabrics', instagram: 'balogunfabrics' });
    const accounts = await q(biz.owner, `select platform::text, name, status::text from social_accounts where business_id = $1 order by platform`, [biz.id]);
    expect(accounts).toEqual([{ platform: 'instagram', name: 'balogunfabrics', status: 'active' }, { platform: 'facebook', name: 'Balogun Fabrics', status: 'active' }]
      .sort((a, b) => a.platform.localeCompare(b.platform)));
    expect(await secrets()).toBe(1); // the other Page's token was destroyed
    await expectPgError(q(biz.owner, `select token_secret_id from social_accounts`), /permission denied/);
    const [{ id: igId }] = await sql(`select id from social_accounts where business_id = $1 and platform = 'instagram'`, [biz.id]);
    await expectPgError(rpc(biz.owner.mfa, 'public.social_token', [igId]), /forbidden|permission/); // not even the owner
    expect(await rpc(SERVICE, 'public.social_token', [igId])).toBe('EAAB-page-token-1');
    // the session is single-use
    await expectPgError(rpc(biz.owner.mfa, 'public.connect_social_account', [sid, 'pg1']), 'not_found');
  });
});

describe('scheduling and publishing', () => {
  it('validates products, photos, captions and who may post', async () => {
    await expectPgError(rpc(cashier, 'public.schedule_social_post', [biz.id, 'instagram', [p1], 'Hi', null]), 'permission_denied');
    await expectPgError(rpc(biz.owner, 'public.schedule_social_post', [biz.id, 'instagram', [noPhoto], 'Hi', null]), 'product_needs_photo');
    await expectPgError(rpc(biz.owner, 'public.schedule_social_post', [biz.id, 'instagram', [p1], Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' '), null]), 'too_many_hashtags');
    await expectPgError(rpc(biz.owner, 'public.schedule_social_post', [biz.id, 'instagram', [p1], 'x'.repeat(2201), null]), 'caption_too_long');
    // 30 real hashtags plus product numbers like #001 is fine
    const ok = await rpc<string>(biz.owner, 'public.schedule_social_post', [biz.id, 'instagram', [p1], `Lace #001 #002 #003 ${Array.from({ length: 30 }, (_, i) => `#t${i}`).join(' ')}`, null]);
    await rpc(biz.owner, 'public.cancel_social_post', [ok]);
    const id = await rpc<string>(biz.owner, 'public.schedule_social_post', [biz.id, 'instagram', [p1, p2, p1], 'New arrivals!', null]);
    const [post] = await sql(`select kind, cardinality(product_ids) n, status::text from social_posts where id = $1`, [id]);
    expect(post).toEqual({ kind: 'carousel', n: 2, status: 'scheduled' });
  });

  it('worker: claim → retry with back-off → rate limit waits without using an attempt → published', async () => {
    await sql(`update social_posts set status = 'cancelled' where business_id = $1`, [biz.id]);
    const id = await rpc<string>(biz.owner, 'public.schedule_social_post', [biz.id, 'instagram', [p1], 'Fresh Hollandais', null]);
    let [claimed] = await rpc<any[]>(SERVICE, 'public.claim_social_posts', [10]).then((r) => (Array.isArray(r) ? r : [r]));
    const rows = await q(SERVICE, `select * from public.claim_social_posts(10)`); // nothing else due
    expect(rows).toEqual([]);
    claimed = (await sql(`select * from social_posts where id = $1`, [id]))[0];
    expect(claimed.status).toBe('publishing');

    await rpc(SERVICE, 'public.finish_social_post', [id, false, null, null, 'Graph 500', null, false, null]);
    let [p] = await sql(`select status::text, attempts, next_attempt_at > now() later, last_error from social_posts where id = $1`, [id]);
    expect(p).toMatchObject({ status: 'scheduled', attempts: 1, later: true, last_error: 'Graph 500' });

    await sql(`update social_posts set next_attempt_at = now() where id = $1`, [id]);
    await q(SERVICE, `select * from public.claim_social_posts(10)`);
    await rpc(SERVICE, 'public.finish_social_post', [id, false, null, null, 'publishing_limit', new Date(Date.now() + 3600_000).toISOString(), false, null]);
    [p] = await sql(`select status::text, attempts from social_posts where id = $1`, [id]);
    expect(p).toEqual({ status: 'scheduled', attempts: 1 }); // the rate-limited try didn't count

    await sql(`update social_posts set next_attempt_at = now() where id = $1`, [id]);
    await q(SERVICE, `select * from public.claim_social_posts(10)`);
    await rpc(SERVICE, 'public.finish_social_post', [id, true, '17900001', 'https://instagram.com/p/abc', null, null, false, null]);
    [p] = await sql(`select status::text, permalink, published_at is not null done from social_posts where id = $1`, [id]);
    expect(p).toEqual({ status: 'published', permalink: 'https://instagram.com/p/abc', done: true });
    await expectPgError(rpc(biz.owner, 'public.cancel_social_post', [id]), 'post_not_cancellable');
  });

  it('gives up after 5 attempts; a dead token marks the account for reconnecting', async () => {
    const id = await rpc<string>(biz.owner, 'public.schedule_social_post', [biz.id, 'facebook', [p2], 'Lace!', null]);
    for (let i = 0; i < 5; i++) {
      await sql(`update social_posts set next_attempt_at = now() where id = $1`, [id]);
      await q(SERVICE, `select * from public.claim_social_posts(10)`);
      await rpc(SERVICE, 'public.finish_social_post', [id, false, null, null, 'boom', null, false, null]);
    }
    expect((await sql(`select status::text from social_posts where id = $1`, [id]))[0]!.status).toBe('failed');
    await rpc(biz.owner, 'public.retry_social_post', [id]);
    await q(SERVICE, `select * from public.claim_social_posts(10)`);
    await rpc(SERVICE, 'public.finish_social_post', [id, false, null, null, 'Error validating access token', null, true, null]);
    const [acc] = await sql(`select status::text from social_accounts where business_id = $1 and platform = 'facebook'`, [biz.id]);
    expect(acc!.status).toBe('expired');
    expect((await sql(`select last_error from social_posts where id = $1`, [id]))[0]!.last_error).toBe('reconnect_needed');
    await expectPgError(rpc(biz.owner, 'public.schedule_social_post', [biz.id, 'facebook', [p2], 'Lace!', null]), 'account_not_connected');
  });

  it('auto-post queues one post per connected account when a product goes live, once', async () => {
    const pid = (await createProduct(biz, [{ price: 5_000_00, stock: 5 }], { name: 'Kano lace', status: 'draft' })).id;
    await photo(pid);
    await sql(`update products set social_autopost = true where id = $1`, [pid]);
    await sql(`update products set status = 'active' where id = $1`, [pid]);
    await sql(`update products set status = 'archived' where id = $1`, [pid]);
    await sql(`update products set status = 'active' where id = $1`, [pid]);
    const posts = await sql(`select platform::text, auto, caption from social_posts where product_ids = array[$1::uuid]`, [pid]);
    expect(posts).toEqual([{ platform: 'instagram', auto: true, caption: null }]); // facebook is expired → skipped
  });

  it('disconnecting cancels waiting posts and destroys the token', async () => {
    const id = await rpc<string>(biz.owner, 'public.schedule_social_post', [biz.id, 'instagram', [p1], 'Later', new Date(Date.now() + 86400_000).toISOString()]);
    await rpc(biz.owner, 'public.disconnect_social_account', [biz.id, 'instagram']);
    expect((await sql(`select status::text from social_posts where id = $1`, [id]))[0]!.status).toBe('cancelled');
    await rpc(biz.owner, 'public.disconnect_social_account', [biz.id, 'facebook']);
    expect(await secrets()).toBe(0);
  });
});
