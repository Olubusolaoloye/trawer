import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { ConsoleSocialProvider, MetaGraphSocialProvider, SocialError, classifyGraphError, countHashtags, fitCaption, renderCaption, renderCarouselCaption } from '../src/social';

const product = { name: 'Hollandais wax print', price_kobo: 1_850_000, colours: ['Royal blue', 'Gold', 'Emerald'], category: 'Ankara', url: 'https://balogun.trawer.shop/p/1' };

describe('captions', () => {
  it('fills the shop template', () => {
    expect(renderCaption('{name} — {price}{variants}\nOrder: {link} #ankara #{shop}', product, 'Balogun'))
      .toBe('Hollandais wax print — ₦18,500 · Colours: Royal blue, Gold, Emerald\nOrder: https://balogun.trawer.shop/p/1 #ankara #Balogun');
  });
  it('keeps Instagram limits: 30 hashtags and 2,200 characters', () => {
    const many = Array.from({ length: 40 }, (_, i) => `#tag${i}`).join(' ');
    expect(countHashtags(fitCaption(many))).toBe(30);
    expect(fitCaption('x'.repeat(3000)).length).toBe(2200);
    // product numbers like "#001" are not hashtags
    expect(countHashtags('Kano Lace #001 and #009 #lace #owambe2026')).toBe(2);
  });
  it('builds a numbered new-arrivals carousel caption', () => {
    expect(renderCarouselCaption([product, { ...product, name: 'Swiss lace', price_kobo: 3_900_000 }], 'Balogun Fabrics', 'https://balogun.trawer.shop'))
      .toBe('New arrivals at Balogun Fabrics\n\n1. Hollandais wax print — ₦18,500\n2. Swiss lace — ₦39,000\n\nSwipe to see them all. Order here: https://balogun.trawer.shop');
  });
});

describe('Graph errors', () => {
  it('knows when to retry, wait or reconnect', () => {
    expect(classifyGraphError(400, { error: { code: 190, message: 'Error validating access token' } }).kind).toBe('auth');
    expect(classifyGraphError(400, { error: { code: 9, error_subcode: 2207042, message: 'max posts' } }).kind).toBe('rate_limit');
    expect(classifyGraphError(500, null).kind).toBe('transient');
    expect(classifyGraphError(400, { error: { code: 100, message: 'Invalid image' } }).kind).toBe('permanent');
  });
});

describe('Meta Graph provider', () => {
  function fakeGraph(responses: Record<string, unknown[]>) {
    const calls: { method: string; path: string; params: URLSearchParams }[] = [];
    const f = (async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const params = init?.body ? new URLSearchParams(String(init.body)) : url.searchParams;
      const path = url.pathname.replace(/^\/v[\d.]+/, '');
      calls.push({ method: init?.method ?? 'GET', path, params });
      const key = `${init?.method ?? 'GET'} ${path.replace(/\/\d+$/, '/:id').replace(/\/c\d+$/, '/:c')}`;
      const queue = responses[key] ?? responses[`${init?.method ?? 'GET'} ${path}`];
      const body = queue?.shift() ?? { error: { code: 100, message: `unexpected ${key}` } };
      return new Response(JSON.stringify(body), { status: (body as { error?: unknown }).error ? 400 : 200 });
    }) as unknown as typeof fetch;
    return { f, calls };
  }
  const target = { platform: 'instagram' as const, externalId: 'ig1', pageId: 'pg1', token: 'PAGE_TOKEN' };

  it('instagram carousel: children → wait → carousel container → publish → permalink, with appsecret_proof', async () => {
    const { f, calls } = fakeGraph({
      'POST /ig1/media': [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }],
      'GET /c1': [{ status_code: 'FINISHED' }], 'GET /c2': [{ status_code: 'IN_PROGRESS' }, { status_code: 'FINISHED' }], 'GET /c3': [{ status_code: 'FINISHED' }],
      'POST /ig1/media_publish': [{ id: '1790' }], 'GET /1790': [{ permalink: 'https://instagram.com/p/xyz' }],
    });
    const p = new MetaGraphSocialProvider('app', 'app-secret', { fetch: f, sleep: async () => undefined });
    expect(await p.publish(target, ['https://x/1.jpg', 'https://x/2.jpg'], 'New arrivals')).toEqual({ id: '1790', permalink: 'https://instagram.com/p/xyz' });
    const container = calls.find((c) => c.params.get('media_type') === 'CAROUSEL')!;
    expect(container.params.get('children')).toBe('c1,c2');
    expect(container.params.get('caption')).toBe('New arrivals');
    expect(calls.every((c) => c.params.get('appsecret_proof') === createHmac('sha256', 'app-secret').update('PAGE_TOKEN').digest('hex'))).toBe(true);
  });

  it('facebook multi-photo post: unpublished photos → one feed post', async () => {
    const { f, calls } = fakeGraph({ 'POST /pg1/photos': [{ id: 'f1' }, { id: 'f2' }], 'POST /pg1/feed': [{ id: 'pg1_99' }], 'GET /pg1_99': [{ permalink_url: 'https://facebook.com/pg1/posts/99' }] });
    const p = new MetaGraphSocialProvider('app', 'app-secret', { fetch: f, sleep: async () => undefined });
    const r = await p.publish({ ...target, platform: 'facebook' }, ['https://x/1.jpg', 'https://x/2.jpg'], 'Lace!');
    expect(r.permalink).toBe('https://facebook.com/pg1/posts/99');
    const feed = calls.find((c) => c.path === '/pg1/feed')!;
    expect(feed.params.get('attached_media[1]')).toBe('{"media_fbid":"f2"}');
  });

  it('turns Graph errors into SocialError kinds', async () => {
    const { f } = fakeGraph({ 'POST /ig1/media': [{ error: { code: 190, message: 'token expired' } }] });
    const p = new MetaGraphSocialProvider('app', 'app-secret', { fetch: f, sleep: async () => undefined });
    await expect(p.publish(target, ['https://x/1.jpg'], 'Hi')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('console provider records posts and counts the Instagram quota', async () => {
    const c = new ConsoleSocialProvider('https://app.trawer.test', true);
    await c.publish(target, ['u'], 'Hi');
    expect(await c.publishingLimit()).toEqual({ used: 1, total: 50 });
    c.failNext = new SocialError('down', 'transient');
    await expect(c.publish(target, ['u'], 'Hi')).rejects.toBeInstanceOf(SocialError);
  });
});
