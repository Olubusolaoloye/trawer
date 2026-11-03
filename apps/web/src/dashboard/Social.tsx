import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { CalendarClock, Check, ExternalLink, Heart, Image as ImageIcon, Link2, MessageCircle, RotateCcw, Search, Send, X } from 'lucide-react';
import { CAPTION_MAX, HASHTAG_MAX, countHashtags } from '@trawer/core/social-caption';
import { api } from '../lib/api';
import { ask, hardNav } from '../lib/demo';
import { invalidate, useApi, useMutation } from '../lib/use-api';
import { cx, formatDate, formatNaira } from '../lib/format';
import { Badge, Button, Card, Empty, ErrorNote, Input, Skeleton, Textarea } from '../components/ui';
import { t, type MessageKey } from '../i18n';
import { useBiz } from './context';
import { useMfaMutation } from './MfaGate';

type Platform = 'instagram' | 'facebook';
interface Account { id: string; platform: Platform; name: string; status: 'active' | 'expired' | 'revoked'; quota_used: number | null; quota_total: number | null; last_error: string | null }
interface Post {
  id: string; platform: Platform; kind: string; caption: string | null; auto: boolean; status: string; scheduled_for: string; attempts: number;
  last_error: string | null; permalink: string | null; published_at: string | null; products: { id: string; name: string; image: string | null }[];
}
interface SocialData { accounts: Account[]; posts: Post[]; template: string; provider: 'meta' | 'console' }
interface Pick { id: string; name: string; image: string | null; price_kobo: number | null }

const LABEL: Record<Platform, string> = { instagram: 'Instagram', facebook: 'Facebook' };

export default function Social() {
  const b = useBiz();
  const key = `/api/biz/${b.business.id}/social`;
  const { data, error } = useApi<SocialData>(key, { staleMs: 5_000 });
  const [params, setParams] = useSearchParams();
  const connectSession = params.get('connect');
  const connectError = params.get('connect_error');

  if (error) return <ErrorNote error={error} />;
  if (!data) return <div className="space-y-4"><Skeleton className="h-10 w-64" /><Skeleton className="h-40" /><Skeleton className="h-96" /></div>;
  const active = data.accounts.filter((a) => a.status === 'active');

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-[30px] font-extrabold tracking-tight lg:text-[34px]">{t('social.title')}</h1>
        <p className="text-body">{t('social.subtitle')}</p>
      </div>
      {connectError && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-ink">{t(`social.err.${connectError}` as MessageKey)}</p>}
      {connectSession && <PickPage sid={connectSession} onDone={() => { setParams({}, { replace: true }); void invalidate(key); }} />}
      <Accounts data={data} />
      {active.length > 0 ? <Composer accounts={active} /> : null}
      <Posts posts={data.posts} />
    </div>
  );
}

function ConnectButton({ label, variant = 'primary' }: { label: string; variant?: 'primary' | 'secondary' }) {
  const b = useBiz();
  const go = useMutation(async () => { const r = await api<{ url: string }>(`/api/biz/${b.business.id}/social/connect`); hardNav(r.url); });
  return <><Button variant={variant} onClick={() => void go.run()} pending={go.pending}><Link2 className="size-5" aria-hidden />{label}</Button><ErrorNote error={go.error} /></>;
}

function Accounts({ data }: { data: SocialData }) {
  const b = useBiz();
  const off = useMutation(async (platform: Platform) => { await api(`/api/biz/${b.business.id}/social/disconnect`, { json: { platform } }); await invalidate(`/api/biz/${b.business.id}/social`); });
  const shown = data.accounts.filter((a) => a.status !== 'revoked');
  if (!shown.length) {
    return (
      <section className="relative overflow-hidden rounded-3xl bg-ink p-6 text-white shadow-float sm:p-8">
        <div className="glow-brand absolute inset-0 opacity-60" aria-hidden />
        <div className="relative max-w-xl space-y-3">
          <h2 className="font-display text-2xl font-extrabold leading-tight sm:text-3xl">{t('social.connectTitle')}</h2>
          <p className="text-[#E7E2D6]">{t('social.connectBody')}</p>
          <ConnectButton label={t('social.connect')} />
          {data.provider === 'console' && <p className="text-sm text-[#C9C3B6]">{t('social.sandbox')}</p>}
        </div>
      </section>
    );
  }
  return (
    <section className="grid gap-3 sm:grid-cols-2" aria-label={t('social.accounts')}>
      {shown.map((a) => (
        <Card key={a.id} className={cx('flex items-center gap-3', a.status === 'expired' && 'border-l-4 border-l-red')}>
          <PlatformMark p={a.platform} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-bold">{a.platform === 'instagram' ? `@${a.name}` : a.name}</p>
            <p className="text-sm text-muted">
              {a.status === 'expired' ? <span className="font-semibold text-red-ink">{t('social.expired')}</span>
                : a.platform === 'instagram' && a.quota_total ? t('social.quota', { used: a.quota_used ?? 0, total: a.quota_total }) : t('social.connected')}
            </p>
          </div>
          {a.status === 'expired' ? <ConnectButton label={t('social.reconnect')} variant="secondary" />
            : <Button size="sm" variant="ghost" onClick={() => { if (ask(t('social.disconnectConfirm', { name: LABEL[a.platform] }))) void off.run(a.platform); }}>{t('social.disconnect')}</Button>}
        </Card>
      ))}
      <ErrorNote error={off.error} />
    </section>
  );
}

function PlatformMark({ p, small }: { p: Platform; small?: boolean }) {
  return (
    <span aria-label={LABEL[p]} role="img" className={cx('flex shrink-0 items-center justify-center rounded-xl font-display font-extrabold text-white', small ? 'size-6 text-[11px]' : 'size-11 text-lg')}
      style={{ background: p === 'instagram' ? 'linear-gradient(135deg,#F58529,#DD2A7B 45%,#8134AF 75%,#515BD4)' : '#1877F2' }}>
      {p === 'instagram' ? 'IG' : 'f'}
    </span>
  );
}

function PickPage({ sid, onDone }: { sid: string; onDone: () => void }) {
  const b = useBiz();
  const { data, error } = useApi<{ choices: { page_id: string; page_name: string; ig_id: string | null; ig_username: string | null }[] }>(`/api/biz/${b.business.id}/social/choices/${sid}`);
  const [page, setPage] = useState('');
  const pick = useMfaMutation(async () => { await api(`/api/biz/${b.business.id}/social/connect`, { json: { session_id: sid, page_id: page } }); onDone(); });
  useEffect(() => { if (data?.choices.length && !page) setPage((data.choices.find((c) => c.ig_id) ?? data.choices[0]!).page_id); }, [data, page]);
  if (error) return <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-ink">{t('social.err.expired')}</p>;
  if (!data) return <Skeleton className="h-40" />;
  return (
    <Card strong className="space-y-3">
      <h2 className="font-display text-xl font-extrabold">{t('social.pickTitle')}</h2>
      <fieldset className="space-y-2">
        <legend className="sr-only">{t('social.pickTitle')}</legend>
        {data.choices.map((c) => (
          <label key={c.page_id} className={cx('flex cursor-pointer items-center gap-3 rounded-xl border-[1.5px] p-3', page === c.page_id ? 'border-ink bg-paper' : 'border-line')}>
            <input type="radio" name="page" value={c.page_id} checked={page === c.page_id} onChange={() => setPage(c.page_id)} className="size-5 accent-green" />
            <span className="flex-1"><b className="block">{c.page_name}</b>
              <span className="text-sm text-muted">{c.ig_username ? t('social.withInstagram', { name: c.ig_username }) : t('social.noInstagram')}</span></span>
          </label>
        ))}
      </fieldset>
      <ErrorNote error={pick.error?.code === 'mfa_required' ? null : pick.error} />
      <Button onClick={() => void pick.run()} pending={pick.pending} disabled={!page}><Check className="size-5" aria-hidden />{t('social.useThisPage')}</Button>
      {pick.prompt}
    </Card>
  );
}

function Composer({ accounts }: { accounts: Account[] }) {
  const b = useBiz();
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const results = useApi<{ products: (Pick & { status: string })[] }>(`/api/biz/${b.business.id}/products?${new URLSearchParams({ status: 'active', ...(q ? { q } : {}) })}`);
  const [picked, setPicked] = useState<Pick[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>(accounts.map((a) => a.platform));
  const [caption, setCaption] = useState('');
  const [edited, setEdited] = useState(false);
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const [done, setDone] = useState<string | null>(null);

  // Arriving from a product ("Post to Instagram"): preselect it.
  const preset = params.get('products');
  useEffect(() => {
    if (!preset || picked.length) return;
    void api<{ product: { id: string; name: string }; images: { url: string }[]; variants: { retail_price_kobo: number }[] }>(`/api/biz/${b.business.id}/products/${preset}`)
      .then((r) => setPicked([{ id: r.product.id, name: r.product.name, image: r.images[0]?.url ?? null, price_kobo: Math.min(...r.variants.map((v) => v.retail_price_kobo)) }]))
      .catch(() => undefined);
  }, [preset]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fresh caption from the shop template whenever the selection changes (until the owner edits it).
  const ids = picked.map((p) => p.id).join(',');
  useEffect(() => {
    if (!ids || edited) return;
    void api<{ caption: string }>(`/api/biz/${b.business.id}/social/caption`, { json: { product_ids: ids.split(',') } }).then((r) => setCaption(r.caption)).catch(() => undefined);
  }, [ids, edited, b.business.id]);

  const toggle = (p: Pick) => setPicked((cur) => cur.some((x) => x.id === p.id) ? cur.filter((x) => x.id !== p.id) : cur.length >= 10 ? cur : [...cur, p]);
  const tags = countHashtags(caption);
  const tooLong = caption.length > CAPTION_MAX || tags > HASHTAG_MAX;
  const minAt = useMemo(() => { const d = new Date(Date.now() + 5 * 60_000); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }, []);
  const noPhoto = picked.filter((p) => !p.image);

  const post = useMutation(async () => {
    await api(`/api/biz/${b.business.id}/social/posts`, { json: { platforms, product_ids: picked.map((p) => p.id), caption, scheduled_for: when === 'later' && at ? new Date(at).toISOString() : undefined } });
    setDone(when === 'later' ? t('social.scheduledOk', { when: formatDate(new Date(at).toISOString(), true) }) : t('social.queuedOk'));
    setPicked([]); setCaption(''); setEdited(false); setWhen('now'); setAt('');
    await invalidate(`/api/biz/${b.business.id}/social`);
  });

  const ig = accounts.find((a) => a.platform === 'instagram');
  return (
    <section className="grid gap-4 lg:grid-cols-[1fr_340px]" aria-labelledby="compose-h">
      <Card className="space-y-4">
        <h2 id="compose-h" className="font-display text-xl font-extrabold">{t('social.newPost')}</h2>
        {done && <p role="status" className="flex items-center gap-2 rounded-xl bg-green-50 p-3 text-sm font-bold text-green-ink"><Check className="size-4" aria-hidden />{done}</p>}

        <div className="space-y-2">
          <p className="text-[15px] font-bold">{t('social.products')} <span className="font-semibold text-muted">· {t('social.upTo10')}</span></p>
          {picked.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {picked.map((p, i) => (
                <li key={p.id} className="flex items-center gap-2 rounded-full border border-line bg-paper py-1 pl-1 pr-2 text-sm font-semibold">
                  {p.image ? <img src={p.image} alt="" className="size-7 rounded-full object-cover" /> : <span className="flex size-7 items-center justify-center rounded-full bg-red-50"><ImageIcon className="size-4 text-red-ink" aria-hidden /></span>}
                  <span className="max-w-40 truncate">{i + 1}. {p.name}</span>
                  <button type="button" aria-label={t('social.remove', { name: p.name })} onClick={() => toggle(p)} className="rounded-full p-0.5 hover:bg-line-soft"><X className="size-4" aria-hidden /></button>
                </li>
              ))}
            </ul>
          )}
          <label className="flex min-h-12 items-center gap-2.5 rounded-xl border-[1.5px] border-line bg-surface px-3.5 focus-within:border-ink">
            <Search className="size-5 text-muted" aria-hidden />
            <input type="search" aria-label={t('social.findProducts')} placeholder={t('social.findProducts')} value={q} onChange={(e) => setQ(e.target.value)} className="min-w-0 flex-1 bg-transparent outline-none" />
          </label>
          <ul className="grid max-h-56 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3" aria-label={t('social.products')}>
            {results.data?.products.slice(0, 18).map((p) => {
              const on = picked.some((x) => x.id === p.id);
              return (
                <li key={p.id}>
                  <button type="button" aria-pressed={on} onClick={() => toggle(p)} disabled={!on && picked.length >= 10}
                    className={cx('press flex w-full items-center gap-2 rounded-xl border-[1.5px] p-1.5 text-left text-sm transition disabled:opacity-40', on ? 'border-green bg-green-50' : 'border-line hover:border-muted/50')}>
                    {p.image ? <img src={p.image} alt="" className="size-10 shrink-0 rounded-lg object-cover" /> : <span className="size-10 shrink-0 rounded-lg bg-line-soft" />}
                    <span className="min-w-0 flex-1"><span className="line-clamp-1 font-semibold">{p.name}</span>{p.price_kobo != null && <span className="text-xs text-muted">{formatNaira(p.price_kobo)}</span>}</span>
                    {on && <Check className="size-4 shrink-0 text-green" aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
          {noPhoto.length > 0 && <p className="text-sm font-semibold text-red-ink">{t('social.needsPhoto', { name: noPhoto[0]!.name })}</p>}
        </div>

        <fieldset>
          <legend className="mb-1.5 text-[15px] font-bold">{t('social.postTo')}</legend>
          <div className="flex flex-wrap gap-2">
            {accounts.map((a) => {
              const on = platforms.includes(a.platform);
              return (
                <button key={a.platform} type="button" aria-pressed={on} onClick={() => setPlatforms(on ? platforms.filter((x) => x !== a.platform) : [...platforms, a.platform])}
                  className={cx('press flex min-h-11 items-center gap-2 rounded-full border-[1.5px] px-3 font-semibold', on ? 'border-ink bg-ink text-paper' : 'border-line')}>
                  <PlatformMark p={a.platform} small />{a.platform === 'instagram' ? `@${a.name}` : a.name}
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="space-y-1.5">
          <label htmlFor="cap" className="block text-[15px] font-bold">{t('social.caption')}</label>
          <Textarea id="cap" rows={6} value={caption} onChange={(e) => { setCaption(e.target.value); setEdited(true); }} aria-describedby="cap-count" placeholder={t('social.captionHint')} />
          <p id="cap-count" className={cx('flex justify-between text-sm', tooLong ? 'font-bold text-red-ink' : 'text-muted')}>
            <span>{t('social.hashtags', { n: tags, max: HASHTAG_MAX })}</span><span>{caption.length} / {CAPTION_MAX}</span>
          </p>
          {edited && picked.length > 0 && <button type="button" className="text-sm font-bold underline" onClick={() => setEdited(false)}>{t('social.resetCaption')}</button>}
        </div>

        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-[15px] font-bold">{t('social.when')}</legend>
          <div className="flex rounded-xl bg-line-soft p-1">
            {(['now', 'later'] as const).map((w) => (
              <button key={w} type="button" aria-pressed={when === w} onClick={() => setWhen(w)}
                className={cx('min-h-10 flex-1 rounded-lg text-sm font-semibold transition', when === w ? 'bg-white font-bold shadow-card' : 'text-body')}>{t(`social.when.${w}` as MessageKey)}</button>
            ))}
          </div>
          {when === 'later' && <Input type="datetime-local" aria-label={t('social.pickTime')} min={minAt} value={at} onChange={(e) => setAt(e.target.value)} />}
        </fieldset>

        <ErrorNote error={post.error} />
        <Button className="w-full" size="lg" pending={post.pending}
          disabled={!picked.length || !platforms.length || !caption.trim() || tooLong || noPhoto.length > 0 || (when === 'later' && !at)}
          onClick={() => void post.run()}>
          {when === 'later' ? <><CalendarClock className="size-5" aria-hidden />{t('social.schedule')}</> : <><Send className="size-5" aria-hidden />{t('social.postNow')}</>}
        </Button>
      </Card>

      <Preview picked={picked} caption={caption} handle={ig?.name ?? b.business.slug} />
    </section>
  );
}

/** Instagram-style preview: first photo, carousel dots, caption with "more". */
function Preview({ picked, caption, handle }: { picked: Pick[]; caption: string; handle: string }) {
  const [i, setI] = useState(0);
  useEffect(() => setI(0), [picked.length]);
  const cur = picked[Math.min(i, picked.length - 1)];
  return (
    <aside aria-label={t('social.preview')} className="lg:sticky lg:top-6 lg:self-start">
      <p className="mb-2 text-sm font-bold text-muted">{t('social.preview')}</p>
      <div className="overflow-hidden rounded-2xl border border-line/70 bg-white shadow-card">
        <div className="flex items-center gap-2 p-3">
          <span className="size-8 rounded-full p-[2px]" style={{ background: 'linear-gradient(135deg,#F58529,#DD2A7B,#8134AF)' }}><span className="block size-full rounded-full border-2 border-white bg-ink" /></span>
          <b className="text-sm">{handle}</b>
        </div>
        <div className="relative aspect-[4/5] bg-line-soft">
          {cur?.image ? <img src={cur.image.replace(/w=\d+/, 'w=640')} alt="" className="size-full object-cover" /> : <div className="flex size-full items-center justify-center text-sm text-muted"><ImageIcon className="mr-2 size-5" aria-hidden />{t('social.pickToPreview')}</div>}
          {picked.length > 1 && <>
            <span className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-bold text-white">{Math.min(i, picked.length - 1) + 1}/{picked.length}</span>
            <button type="button" aria-label={t('social.next')} onClick={() => setI((x) => (x + 1) % picked.length)} className="absolute inset-y-0 right-0 w-1/3" />
          </>}
        </div>
        <div className="space-y-1.5 p-3">
          <div className="flex gap-3" aria-hidden><Heart className="size-6" /><MessageCircle className="size-6" /><Send className="size-6" /></div>
          {picked.length > 1 && <div className="flex justify-center gap-1" aria-hidden>{picked.map((_, k) => <span key={k} className={cx('size-1.5 rounded-full', k === Math.min(i, picked.length - 1) ? 'bg-[#0095F6]' : 'bg-line')} />)}</div>}
          <p className="whitespace-pre-line text-sm"><b>{handle}</b> {caption.length > 180 ? <>{caption.slice(0, 180)}… <span className="text-muted">more</span></> : caption}</p>
        </div>
      </div>
    </aside>
  );
}

function Posts({ posts }: { posts: Post[] }) {
  const b = useBiz();
  const [tab, setTab] = useState<'upcoming' | 'published' | 'attention'>('upcoming');
  const act = useMutation(async (id: string, what: 'cancel' | 'retry') => { await api(`/api/biz/${b.business.id}/social/posts/${id}/${what}`, { json: {} }); await invalidate(`/api/biz/${b.business.id}/social`); });
  const groups = {
    upcoming: posts.filter((p) => p.status === 'scheduled' || p.status === 'publishing'),
    published: posts.filter((p) => p.status === 'published'),
    attention: posts.filter((p) => p.status === 'failed'),
  };
  const list = groups[tab];
  return (
    <section className="space-y-3" aria-labelledby="posts-h">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="posts-h" className="font-display text-xl font-extrabold">{t('social.posts')}</h2>
        <div role="tablist" className="flex rounded-xl bg-line-soft p-1">
          {(Object.keys(groups) as (keyof typeof groups)[]).map((k) => (
            <button key={k} role="tab" type="button" aria-selected={tab === k} onClick={() => setTab(k)}
              className={cx('min-h-9 rounded-lg px-3 text-sm font-semibold', tab === k ? 'bg-white font-bold shadow-card' : 'text-body', k === 'attention' && groups.attention.length > 0 && tab !== k && 'text-red-ink')}>
              {t(`social.tab.${k}` as MessageKey)} · {groups[k].length}
            </button>
          ))}
        </div>
      </div>
      {list.length === 0 ? <Empty>{t(`social.empty.${tab}` as MessageKey)}</Empty> : (
        <ul className="stagger space-y-2">
          {list.map((p) => (
            <li key={p.id}>
              <Card className="flex flex-wrap items-center gap-3">
                <div className="flex -space-x-3">
                  {p.products.slice(0, 3).map((pr) => pr.image ? <img key={pr.id} src={pr.image} alt="" className="size-12 rounded-xl border-2 border-white object-cover" /> : <span key={pr.id} className="size-12 rounded-xl border-2 border-white bg-line-soft" />)}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-bold"><PlatformMark p={p.platform} small />
                    <span className="truncate">{p.kind === 'carousel' ? t('social.carousel', { n: p.products.length }) : p.products[0]?.name}</span>
                    {p.auto && <Badge tone="info">{t('social.auto')}</Badge>}</p>
                  <p className="text-sm text-muted">
                    {p.status === 'published' && p.published_at ? t('social.postedAt', { when: formatDate(p.published_at, true) })
                      : p.status === 'publishing' ? t('social.publishing')
                      : p.status === 'failed' ? <span className="font-semibold text-red-ink">{t(p.last_error === 'reconnect_needed' ? 'social.reconnectNeeded' : 'social.failedAfter', { n: p.attempts })}</span>
                      : <>{t('social.scheduledFor', { when: formatDate(p.scheduled_for, true) })}{p.last_error === 'publishing_limit_reached' ? ` · ${t('social.limitWait')}` : ''}</>}
                  </p>
                </div>
                {p.permalink && <a href={p.permalink} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-sm font-bold underline">{t('social.view')}<ExternalLink className="size-4" aria-hidden /></a>}
                {p.status === 'failed' && p.last_error !== 'reconnect_needed' && <Button size="sm" variant="secondary" onClick={() => void act.run(p.id, 'retry')}><RotateCcw className="size-4" aria-hidden />{t('social.retry')}</Button>}
                {(p.status === 'scheduled' || p.status === 'failed') && <Button size="sm" variant="ghost" onClick={() => void act.run(p.id, 'cancel')}>{t('social.cancel')}</Button>}
              </Card>
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={act.error} />
    </section>
  );
}
