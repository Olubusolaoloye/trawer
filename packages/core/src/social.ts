/**
 * Instagram / Facebook posting behind one interface (`SocialProvider`): Meta Graph API in production,
 * a console provider in development and tests. Pure helpers (caption rendering, error classes) are
 * shared by the API and the dashboard preview.
 */
import { fetchWithTimeout } from './http';
import { createHmac } from 'node:crypto';
export * from './social-caption';

export type SocialPlatform = 'instagram' | 'facebook';

export interface PageCandidate { page_id: string; page_name: string; ig_id: string | null; ig_username: string | null; token: string }
export interface PublishTarget { platform: SocialPlatform; externalId: string; pageId: string; token: string }
export interface Published { id: string; permalink: string | null }
export interface Quota { used: number; total: number }

export interface SocialProvider {
  authorizeUrl(redirectUri: string, state: string): string;
  /** OAuth code → the user's Pages (with linked Instagram Business accounts) and long-lived Page tokens. */
  exchange(code: string, redirectUri: string): Promise<PageCandidate[]>;
  /** Instagram only: posts used in the rolling 24 h window. */
  publishingLimit(t: PublishTarget): Promise<Quota>;
  publish(t: PublishTarget, imageUrls: string[], caption: string): Promise<Published>;
}

/** Why a publish failed, so the worker knows whether to retry, wait or ask for a reconnect. */
export class SocialError extends Error {
  constructor(message: string, public readonly kind: 'transient' | 'rate_limit' | 'auth' | 'permanent', public readonly retryAfterMs = 0) { super(message); }
}

export function classifyGraphError(status: number, body: { error?: { message?: string; code?: number; error_subcode?: number } } | null): SocialError {
  const e = body?.error ?? {};
  const msg = (e.message ?? `HTTP ${status}`).slice(0, 300);
  if (e.code === 190 || e.code === 102 || e.code === 10 || e.code === 200 && /permission/i.test(msg)) return new SocialError(msg, 'auth');
  if ([4, 17, 32, 341, 613].includes(e.code ?? -1) || e.error_subcode === 2207042 || status === 429) return new SocialError(msg, 'rate_limit', 60 * 60_000);
  if (status >= 500 || e.code === 1 || e.code === 2 || e.error_subcode === 2207001) return new SocialError(msg, 'transient');
  return new SocialError(msg, 'permanent');
}

// ------------------------------------------------------------------------------------------
// Meta Graph API
// ------------------------------------------------------------------------------------------
const SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'business_management', 'instagram_basic', 'instagram_content_publish'];

export class MetaGraphSocialProvider implements SocialProvider {
  private readonly base: string;
  constructor(private readonly appId: string, private readonly appSecret: string, opts: { graphVersion?: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}) {
    this.base = `https://graph.facebook.com/${opts.graphVersion ?? 'v21.0'}`;
    this.http = fetchWithTimeout(30_000, opts.fetch ?? fetch);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }
  private readonly http: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  /** Every call carries appsecret_proof, so a leaked token alone can't be used against our app. */
  private proof(token: string) { return createHmac('sha256', this.appSecret).update(token).digest('hex'); }

  private async call<T>(method: 'GET' | 'POST', path: string, token: string | null, params: Record<string, string> = {}): Promise<T> {
    const q = new URLSearchParams(params);
    if (token) { q.set('access_token', token); q.set('appsecret_proof', this.proof(token)); }
    const url = `${this.base}${path}`;
    let res: Response;
    try {
      res = method === 'GET' ? await this.http(`${url}?${q}`) : await this.http(url, { method: 'POST', body: q, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    } catch (e) {
      throw new SocialError(`network: ${(e as Error).message}`, 'transient');
    }
    const body = (await res.json().catch(() => null)) as T & { error?: unknown } | null;
    if (!res.ok || !body || (body as { error?: unknown }).error) throw classifyGraphError(res.status, body as never);
    return body;
  }

  authorizeUrl(redirectUri: string, state: string): string {
    const q = new URLSearchParams({ client_id: this.appId, redirect_uri: redirectUri, state, response_type: 'code', scope: SCOPES.join(',') });
    return `https://www.facebook.com/${this.base.split('/').pop()}/dialog/oauth?${q}`;
  }

  async exchange(code: string, redirectUri: string): Promise<PageCandidate[]> {
    const short = await this.call<{ access_token: string }>('GET', '/oauth/access_token', null, { client_id: this.appId, client_secret: this.appSecret, redirect_uri: redirectUri, code });
    const long = await this.call<{ access_token: string }>('GET', '/oauth/access_token', null, { grant_type: 'fb_exchange_token', client_id: this.appId, client_secret: this.appSecret, fb_exchange_token: short.access_token });
    // Page tokens obtained with a long-lived user token don't expire.
    const pages = await this.call<{ data: { id: string; name: string; access_token: string; instagram_business_account?: { id: string; username?: string } }[] }>(
      'GET', '/me/accounts', long.access_token, { fields: 'id,name,access_token,instagram_business_account{id,username}', limit: '50' });
    return pages.data.map((p) => ({ page_id: p.id, page_name: p.name, ig_id: p.instagram_business_account?.id ?? null, ig_username: p.instagram_business_account?.username ?? null, token: p.access_token }));
  }

  async publishingLimit(t: PublishTarget): Promise<Quota> {
    const r = await this.call<{ data: { quota_usage: number; config?: { quota_total: number } }[] }>('GET', `/${t.externalId}/content_publishing_limit`, t.token, { fields: 'quota_usage,config' });
    return { used: r.data[0]?.quota_usage ?? 0, total: r.data[0]?.config?.quota_total ?? 50 };
  }

  async publish(t: PublishTarget, imageUrls: string[], caption: string): Promise<Published> {
    return t.platform === 'instagram' ? this.publishInstagram(t, imageUrls, caption) : this.publishFacebook(t, imageUrls, caption);
  }

  private async waitReady(container: string, token: string) {
    for (let i = 0; i < 20; i++) {
      const s = await this.call<{ status_code: string }>('GET', `/${container}`, token, { fields: 'status_code' });
      if (s.status_code === 'FINISHED') return;
      if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new SocialError(`media container ${s.status_code.toLowerCase()}`, 'permanent');
      await this.sleep(1500);
    }
    throw new SocialError('media still processing', 'transient');
  }

  private async publishInstagram(t: PublishTarget, urls: string[], caption: string): Promise<Published> {
    let container: string;
    if (urls.length === 1) {
      container = (await this.call<{ id: string }>('POST', `/${t.externalId}/media`, t.token, { image_url: urls[0]!, caption })).id;
    } else {
      const children: string[] = [];
      for (const u of urls) children.push((await this.call<{ id: string }>('POST', `/${t.externalId}/media`, t.token, { image_url: u, is_carousel_item: 'true' })).id);
      for (const c of children) await this.waitReady(c, t.token);
      container = (await this.call<{ id: string }>('POST', `/${t.externalId}/media`, t.token, { media_type: 'CAROUSEL', children: children.join(','), caption })).id;
    }
    await this.waitReady(container, t.token);
    const media = await this.call<{ id: string }>('POST', `/${t.externalId}/media_publish`, t.token, { creation_id: container });
    const link = await this.call<{ permalink?: string }>('GET', `/${media.id}`, t.token, { fields: 'permalink' }).catch(() => ({ permalink: undefined }));
    return { id: media.id, permalink: link.permalink ?? null };
  }

  private async publishFacebook(t: PublishTarget, urls: string[], caption: string): Promise<Published> {
    let postId: string;
    if (urls.length === 1) {
      const r = await this.call<{ id: string; post_id?: string }>('POST', `/${t.pageId}/photos`, t.token, { url: urls[0]!, message: caption });
      postId = r.post_id ?? r.id;
    } else {
      const ids: string[] = [];
      for (const u of urls) ids.push((await this.call<{ id: string }>('POST', `/${t.pageId}/photos`, t.token, { url: u, published: 'false' })).id);
      const params: Record<string, string> = { message: caption };
      ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
      postId = (await this.call<{ id: string }>('POST', `/${t.pageId}/feed`, t.token, params)).id;
    }
    const link = await this.call<{ permalink_url?: string }>('GET', `/${postId}`, t.token, { fields: 'permalink_url' }).catch(() => ({ permalink_url: undefined }));
    return { id: postId, permalink: link.permalink_url ?? null };
  }
}

// ------------------------------------------------------------------------------------------
// Console provider (development, tests, demos): no network, everything recorded.
// ------------------------------------------------------------------------------------------
export class ConsoleSocialProvider implements SocialProvider {
  readonly published: { platform: SocialPlatform; target: string; images: string[]; caption: string }[] = [];
  quota: Quota = { used: 0, total: 50 };
  failNext: SocialError | null = null;
  constructor(private readonly appUrl: string, private readonly quiet = false) {}

  authorizeUrl(redirectUri: string, state: string): string {
    return `${redirectUri}?${new URLSearchParams({ code: 'sandbox-code', state })}`;
  }

  async exchange(code: string): Promise<PageCandidate[]> {
    if (code !== 'sandbox-code') throw new SocialError('invalid code', 'permanent');
    return [
      { page_id: 'sandbox-page-1', page_name: 'My Shop (Facebook Page)', ig_id: 'sandbox-ig-1', ig_username: 'myshop.ng', token: 'sandbox-page-token-1' },
      { page_id: 'sandbox-page-2', page_name: 'Old Page (no Instagram)', ig_id: null, ig_username: null, token: 'sandbox-page-token-2' },
    ];
  }

  async publishingLimit(): Promise<Quota> { return { ...this.quota }; }

  async publish(t: PublishTarget, imageUrls: string[], caption: string): Promise<Published> {
    if (this.failNext) { const e = this.failNext; this.failNext = null; throw e; }
    this.published.push({ platform: t.platform, target: t.externalId, images: imageUrls, caption });
    if (t.platform === 'instagram') this.quota.used += 1;
    const n = this.published.length;
    if (!this.quiet) console.info(`[social:${t.platform}] ${imageUrls.length} image(s) → ${t.externalId}: ${caption.slice(0, 80)}`);
    return { id: `sandbox_${n}`, permalink: t.platform === 'instagram' ? `${this.appUrl}/sandbox/instagram/p/${n}` : `${this.appUrl}/sandbox/facebook/posts/${n}` };
  }
}
