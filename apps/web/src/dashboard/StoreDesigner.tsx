import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, ExternalLink, ImagePlus, Monitor, Smartphone, Trash2, Upload } from 'lucide-react';
import { THEME_PALETTES, THEMES, FONTS, RADII, HEADERS, CARDS, DENSITIES, type SectionId } from '@trawer/core/storefront-theme';
import { api } from '../lib/api';
import { invalidate, useApi, useMutation } from '../lib/use-api';
import { loadFont } from '../lib/theme';
import { cx } from '../lib/format';
import { Button, ErrorNote, Field, Input, Select, Skeleton, Textarea } from '../components/ui';
import { t, type MessageKey } from '../i18n';
import { useBiz } from './context';
import type { StoreDesign } from '../store/StoreLayout';

interface Draft { design: StoreDesign; brand_colour: string; logo_url: string | null; logo_path?: string }

const SWATCHES = ['#9A3412', '#0B7A4B', '#23308C', '#7C3AED', '#BE185D', '#0E7490', '#B45309', '#0E1411'];
const FONT_FAMILY: Record<string, string> = {
  grotesque: '"Bricolage Grotesque Variable", sans-serif', serif: '"Fraunces Variable", serif', rounded: '"Nunito Variable", sans-serif', classic: '"Inter Variable", sans-serif',
};

export default function StoreDesigner() {
  const b = useBiz();
  const { data } = useApi<{ design: StoreDesign }>(`/api/biz/${b.business.id}/storefront`, { staleMs: 0 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<string>('');
  useEffect(() => { void loadFont('serif'); void loadFont('rounded'); }, []);
  useEffect(() => {
    if (data && !draft) {
      const d = { design: data.design, brand_colour: b.business.brand_colour, logo_url: b.business.logo_url };
      setDraft(d);
      setSaved(JSON.stringify(d));
    }
  }, [data, draft, b.business]);
  if (!draft) return <div className="grid gap-6 lg:grid-cols-[minmax(340px,420px)_1fr]"><Skeleton className="h-[70vh]" /><Skeleton className="h-[70vh]" /></div>;
  return <Designer draft={draft} setDraft={setDraft} dirty={JSON.stringify(draft) !== saved} onSaved={(d) => setSaved(JSON.stringify(d))} />;
}

function Designer({ draft, setDraft, dirty, onSaved }: { draft: Draft; setDraft: (d: Draft) => void; dirty: boolean; onSaved: (d: Draft) => void }) {
  const b = useBiz();
  const d = draft.design;
  const store = useApi<{ categories: { category: string; n: number }[] }>(`/api/store/${b.business.slug}`, { staleMs: 60_000 });
  const categories = store.data?.categories ?? [];
  const [device, setDevice] = useState<'phone' | 'desktop'>('phone');
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const [justSaved, setJustSaved] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);

  const set = (patch: Partial<StoreDesign>) => setDraft({ ...draft, design: { ...d, ...patch } });
  const setHero = (patch: Partial<StoreDesign['hero']>) => set({ hero: { ...d.hero, ...patch } });

  // Live preview: push the draft into the same-origin store iframe.
  const send = () => frame.current?.contentWindow?.postMessage({ type: 'trawer:design', draft: { design: d, brand_colour: draft.brand_colour, logo_url: draft.logo_url } }, window.location.origin);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin === window.location.origin && e.source === frame.current?.contentWindow && (e.data as { type?: string })?.type === 'trawer:ready') send();
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  });
  useEffect(send, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api<{ path: string; url: string }>(`/api/biz/${b.business.id}/uploads`, { form });
  };
  const heroUpload = useMutation(async (file: File) => { const r = await upload(file); setHero({ image_path: r.path, image_url: r.url }); });
  const logoUpload = useMutation(async (file: File) => { const r = await upload(file); setDraft({ ...draft, logo_url: r.url, logo_path: r.path }); });
  const publish = useMutation(async () => {
    const { image_url: _drop, ...hero } = d.hero;
    await api(`/api/biz/${b.business.id}/storefront`, { method: 'PUT', json: { ...d, hero } });
    await api(`/api/biz/${b.business.id}`, { method: 'PATCH', json: { brand_colour: draft.brand_colour, ...(draft.logo_path ? { logo_path: draft.logo_path } : {}) } });
    onSaved(draft);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2500);
    void invalidate(`/api/biz/${b.business.id}`);
    void invalidate(`/api/store/${b.business.slug}`);
  });

  const move = (i: number, by: -1 | 1) => {
    const s = [...d.sections];
    const j = i + by;
    if (j < 0 || j >= s.length) return;
    [s[i], s[j]] = [s[j]!, s[i]!];
    set({ sections: s });
  };

  const storeUrl = `/s/${b.business.slug}`;
  const previewSrc = useMemo(() => `${storeUrl}?design_preview=1`, [storeUrl]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[30px] font-extrabold tracking-tight lg:text-[34px]">{t('design.title')}</h1>
          <p className="text-body">{t('design.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <a href={storeUrl} target="_blank" rel="noopener" className="press inline-flex min-h-11 items-center gap-2 rounded-xl border border-line bg-white px-4 text-sm font-bold hover:bg-paper">
            <ExternalLink className="size-4" aria-hidden />{t('design.viewStore')}
          </a>
          <div className="hidden lg:block">
            <Button onClick={() => void publish.run()} pending={publish.pending} disabled={!dirty && !publish.pending}>
              {justSaved ? <><Check className="size-5" aria-hidden />{t('design.published')}</> : t('design.publish')}
            </Button>
          </div>
        </div>
      </div>
      <ErrorNote error={publish.error ?? heroUpload.error ?? logoUpload.error} />

      {/* Phone: switch between the controls and the preview */}
      <div role="tablist" aria-label={t('design.title')} className="grid grid-cols-2 rounded-xl bg-line-soft p-1 lg:hidden">
        {(['edit', 'preview'] as const).map((x) => (
          <button key={x} role="tab" type="button" aria-selected={tab === x} onClick={() => setTab(x)}
            className={cx('min-h-11 rounded-lg text-sm font-bold transition', tab === x ? 'bg-white shadow-card' : 'text-body')}>{t(`design.tab.${x}` as MessageKey)}</button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(340px,420px)_1fr]">
        <div className={cx('space-y-4 pb-24 lg:pb-0', tab === 'preview' && 'hidden lg:block')}>
          <Panel title={t('design.brand')}>
            <div className="flex items-center gap-4">
              <div className="relative">
                {draft.logo_url
                  ? <img src={draft.logo_url} alt="" className="size-16 rounded-2xl border border-line object-cover" />
                  : <span className="flex size-16 items-center justify-center rounded-2xl font-display text-2xl font-extrabold text-white" style={{ background: draft.brand_colour }} aria-hidden>{b.business.name.charAt(0)}</span>}
              </div>
              <FilePick label={t('design.uploadLogo')} pending={logoUpload.pending} onFile={(f) => void logoUpload.run(f)} icon={<Upload className="size-4" aria-hidden />} />
            </div>
            <fieldset>
              <legend className="mb-2 text-[15px] font-bold">{t('design.colour')}</legend>
              <div className="flex flex-wrap items-center gap-2.5">
                {SWATCHES.map((c) => (
                  <button key={c} type="button" aria-label={c} aria-pressed={draft.brand_colour.toLowerCase() === c.toLowerCase()} onClick={() => setDraft({ ...draft, brand_colour: c })}
                    className={cx('press size-10 rounded-full transition', draft.brand_colour.toLowerCase() === c.toLowerCase() ? 'ring-[3px] ring-ink ring-offset-2' : 'ring-1 ring-black/10')} style={{ background: c }} />
                ))}
                <label className="press relative flex size-10 cursor-pointer items-center justify-center rounded-full border-2 border-dashed border-line text-xs font-bold text-muted" title={t('onboard.customColour')}>
                  +<input type="color" aria-label={t('onboard.customColour')} className="absolute inset-0 cursor-pointer opacity-0" value={draft.brand_colour} onChange={(e) => setDraft({ ...draft, brand_colour: e.target.value })} />
                </label>
              </div>
            </fieldset>
          </Panel>

          <Panel title={t('design.theme')}>
            <div className="grid grid-cols-2 gap-2.5">
              {THEMES.map((th) => {
                const p = THEME_PALETTES[th];
                return (
                  <Choice key={th} on={d.theme === th} onClick={() => set({ theme: th })} label={t(`design.theme.${th}` as MessageKey)}>
                    <div className="flex h-16 overflow-hidden rounded-lg border border-black/10" style={{ background: p.canvas }} aria-hidden>
                      <div className="m-2 flex flex-1 flex-col justify-between rounded-md p-1.5" style={{ background: p.surface, boxShadow: th === 'bold' ? '2px 2px 0 #111' : undefined, border: `1px solid ${p.line}` }}>
                        <span className="h-1.5 w-3/4 rounded-full" style={{ background: p.ink }} />
                        <span className="h-2.5 w-1/2 rounded-full" style={{ background: draft.brand_colour }} />
                      </div>
                    </div>
                  </Choice>
                );
              })}
            </div>
          </Panel>

          <Panel title={t('design.font')}>
            <div className="grid grid-cols-2 gap-2.5">
              {FONTS.map((f) => (
                <Choice key={f} on={d.font === f} onClick={() => set({ font: f })} label={t(`design.font.${f}` as MessageKey)}>
                  <span className="block text-[28px] font-extrabold leading-none" style={{ fontFamily: FONT_FAMILY[f] }} aria-hidden>Aa ₦</span>
                </Choice>
              ))}
            </div>
          </Panel>

          <Panel title={t('design.layout')}>
            <Segmented label={t('design.header')} value={d.header} options={HEADERS} onChange={(header) => set({ header })} />
            <Segmented label={t('design.cards')} value={d.card} options={CARDS} onChange={(card) => set({ card })} />
            <Segmented label={t('design.corners')} value={d.radius} options={RADII} onChange={(radius) => set({ radius })} />
            <Segmented label={t('design.density')} value={d.density} options={DENSITIES} onChange={(density) => set({ density })} />
            <Toggle label={t('design.showStock')} hint={t('design.showStockHint')} on={d.show_stock} onChange={(show_stock) => set({ show_stock })} />
          </Panel>

          <Panel title={t('design.banner')}>
            <Toggle label={t('design.showBanner')} on={d.hero.enabled} onChange={(enabled) => setHero({ enabled })} />
            {d.hero.enabled && <>
              <div className="relative overflow-hidden rounded-xl border border-dashed border-line bg-paper">
                {d.hero.image_url
                  ? <img src={d.hero.image_url} alt="" className="aspect-[16/7] w-full object-cover" />
                  : <div className="flex aspect-[16/7] items-center justify-center text-sm font-semibold text-muted"><ImagePlus className="mr-2 size-5" aria-hidden />{t('design.noPhoto')}</div>}
                <div className="absolute bottom-2 right-2 flex gap-2">
                  <FilePick label={d.hero.image_url ? t('design.changePhoto') : t('design.addPhoto')} pending={heroUpload.pending} onFile={(f) => void heroUpload.run(f)} icon={<ImagePlus className="size-4" aria-hidden />} small />
                  {d.hero.image_url && <button type="button" onClick={() => setHero({ image_path: null, image_url: null })} aria-label={t('design.removePhoto')} className="press flex size-10 items-center justify-center rounded-lg bg-white/95 shadow-card"><Trash2 className="size-4" aria-hidden /></button>}
                </div>
              </div>
              <Field label={t('design.bannerTitle')} htmlFor="ht"><Input id="ht" maxLength={80} value={d.hero.title} placeholder={b.business.name} onChange={(e) => setHero({ title: e.target.value })} /></Field>
              <Field label={t('design.bannerSubtitle')} htmlFor="hs"><Input id="hs" maxLength={160} value={d.hero.subtitle} placeholder={t('store.heroDefault')} onChange={(e) => setHero({ subtitle: e.target.value })} /></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('design.buttonLabel')} htmlFor="hc"><Input id="hc" maxLength={30} value={d.hero.cta_label} placeholder={t('store.heroCta')} onChange={(e) => setHero({ cta_label: e.target.value })} /></Field>
                <Field label={t('design.buttonOpens')} htmlFor="hk">
                  <Select id="hk" value={d.hero.cta_category ?? ''} onChange={(e) => setHero({ cta_category: e.target.value || null })}>
                    <option value="">{t('design.allProducts')}</option>
                    {categories.map((c) => <option key={c.category} value={c.category}>{c.category}</option>)}
                  </Select>
                </Field>
              </div>
            </>}
          </Panel>

          <Panel title={t('design.announcement')}>
            <Toggle label={t('design.showAnnouncement')} on={d.announcement.enabled} onChange={(enabled) => set({ announcement: { ...d.announcement, enabled } })} />
            {d.announcement.enabled && <Field label={t('design.announcementText')} htmlFor="an"><Input id="an" maxLength={140} value={d.announcement.text} placeholder={t('design.announcementPlaceholder')} onChange={(e) => set({ announcement: { ...d.announcement, text: e.target.value } })} /></Field>}
          </Panel>

          <Panel title={t('design.featured')}>
            <Field label={t('design.featuredCategory')} htmlFor="fc">
              <Select id="fc" value={d.featured.category ?? ''} onChange={(e) => set({ featured: { ...d.featured, category: e.target.value || null } })}>
                <option value="">{t('design.none')}</option>
                {categories.map((c) => <option key={c.category} value={c.category}>{c.category} ({c.n})</option>)}
              </Select>
            </Field>
            {d.featured.category && <Field label={t('design.featuredTitle')} htmlFor="ft"><Input id="ft" maxLength={60} value={d.featured.title} placeholder={d.featured.category} onChange={(e) => set({ featured: { ...d.featured, title: e.target.value } })} /></Field>}
          </Panel>

          <Panel title={t('design.sections')} hint={t('design.sectionsHint')}>
            <ol className="divide-y divide-line-soft rounded-xl border border-line">
              {d.sections.map((s, i) => (
                <li key={s.id} className="flex items-center gap-2 px-3 py-2">
                  <span className={cx('flex-1 text-[15px] font-semibold', !s.on && 'text-muted line-through decoration-1')}>{t(`design.section.${s.id}` as MessageKey)}</span>
                  <IconBtn label={t('design.moveUp', { name: t(`design.section.${s.id}` as MessageKey) })} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-4" aria-hidden /></IconBtn>
                  <IconBtn label={t('design.moveDown', { name: t(`design.section.${s.id}` as MessageKey) })} disabled={i === d.sections.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" aria-hidden /></IconBtn>
                  <Switch on={s.on} disabled={s.id === 'products'} label={t(`design.section.${s.id}` as MessageKey)}
                    onChange={(on) => set({ sections: d.sections.map((x) => (x.id === s.id ? { ...x, on } : x)) as { id: SectionId; on: boolean }[] })} />
                </li>
              ))}
            </ol>
          </Panel>

          <Panel title={t('design.about')}>
            <Field label={t('design.aboutText')} htmlFor="ab" hint={`${d.about.length}/600`}><Textarea id="ab" rows={4} maxLength={600} value={d.about} placeholder={t('design.aboutPlaceholder')} onChange={(e) => set({ about: e.target.value })} /></Field>
            <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
              <Field label="Instagram" htmlFor="ig"><Input id="ig" maxLength={60} value={d.socials.instagram} placeholder="balogunfabrics" onChange={(e) => set({ socials: { ...d.socials, instagram: e.target.value.replace(/^@/, '').replace(/[^A-Za-z0-9._-]/g, '') } })} /></Field>
              <Field label="TikTok" htmlFor="tt"><Input id="tt" maxLength={60} value={d.socials.tiktok} placeholder="balogunfabrics" onChange={(e) => set({ socials: { ...d.socials, tiktok: e.target.value.replace(/^@/, '').replace(/[^A-Za-z0-9._-]/g, '') } })} /></Field>
              <Field label="WhatsApp" htmlFor="wa"><Input id="wa" inputMode="tel" maxLength={20} value={d.socials.whatsapp} placeholder="+234…" onChange={(e) => set({ socials: { ...d.socials, whatsapp: e.target.value.replace(/[^\d+]/g, '') } })} /></Field>
            </div>
          </Panel>
        </div>

        {/* Live preview */}
        <div className={cx('lg:sticky lg:top-6 lg:self-start', tab === 'edit' && 'hidden lg:block')}>
          <div className="mb-3 flex items-center justify-between">
            <p className="flex items-center gap-2 text-sm font-bold text-muted"><span className="relative flex size-2.5"><span className="pulse-ring absolute inline-flex size-full rounded-full bg-green" /><span className="relative inline-flex size-2.5 rounded-full bg-green" /></span>{t('design.livePreview')}</p>
            <div className="flex rounded-xl bg-line-soft p-1" role="group" aria-label={t('design.device')}>
              {([['phone', Smartphone], ['desktop', Monitor]] as const).map(([v, Icon]) => (
                <button key={v} type="button" aria-pressed={device === v} onClick={() => setDevice(v)} aria-label={t(`design.device.${v}` as MessageKey)}
                  className={cx('flex size-10 items-center justify-center rounded-lg transition', device === v ? 'bg-white shadow-card' : 'text-muted')}><Icon className="size-5" aria-hidden /></button>
              ))}
            </div>
          </div>
          <div className={cx('mx-auto overflow-hidden bg-ink shadow-float transition-[width,border-radius] duration-500', device === 'phone' ? 'w-[min(390px,100%)] rounded-[44px] p-3' : 'w-full rounded-2xl p-2')}>
            <iframe ref={frame} src={previewSrc} title={t('design.livePreview')} className={cx('block w-full bg-white', device === 'phone' ? 'h-[min(760px,72dvh)] rounded-[34px]' : 'h-[min(760px,72dvh)] rounded-xl')} />
          </div>
        </div>
      </div>

      {/* Phone: sticky publish bar */}
      <div className="glass fixed inset-x-0 bottom-[84px] z-20 border-t border-line/60 px-4 py-3 lg:hidden">
        <Button className="w-full" onClick={() => void publish.run()} pending={publish.pending} disabled={!dirty && !publish.pending}>
          {justSaved ? <><Check className="size-5" aria-hidden />{t('design.published')}</> : dirty ? t('design.publish') : t('design.noChanges')}
        </Button>
      </div>
    </div>
  );
}

function Panel({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-3.5 rounded-2xl border border-line/70 bg-white p-4 shadow-card">
      <div><h2 className="font-display text-lg font-extrabold tracking-tight">{title}</h2>{hint && <p className="text-sm text-muted">{hint}</p>}</div>
      {children}
    </section>
  );
}

function Choice({ on, onClick, label, children }: { on: boolean; onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={cx('press relative flex flex-col gap-2 rounded-xl border-[1.5px] p-2.5 text-left transition', on ? 'border-ink bg-paper shadow-card' : 'border-line hover:border-muted/50')}>
      {children}
      <span className="flex items-center justify-between text-sm font-bold">{label}{on && <Check className="size-4 text-green" aria-hidden />}</span>
    </button>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-[15px] font-bold">{label}</legend>
      <div className="flex rounded-xl bg-line-soft p-1">
        {options.map((o) => (
          <button key={o} type="button" aria-pressed={value === o} onClick={() => onChange(o)}
            className={cx('min-h-10 flex-1 rounded-lg px-2 text-sm font-semibold transition', value === o ? 'bg-white font-bold shadow-card' : 'text-body hover:text-ink')}>
            {t(`design.opt.${o}` as MessageKey)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className={cx('relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50', on ? 'bg-green' : 'bg-line')}>
      <span className={cx('absolute top-0.5 size-6 rounded-full bg-white shadow transition-[left] duration-200', on ? 'left-[22px]' : 'left-0.5')} />
    </button>
  );
}

function Toggle({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div><p className="text-[15px] font-bold">{label}</p>{hint && <p className="text-sm text-muted">{hint}</p>}</div>
      <Switch on={on} onChange={onChange} label={label} />
    </div>
  );
}

function IconBtn({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-label={label} disabled={disabled} onClick={onClick} className="press flex size-9 items-center justify-center rounded-lg text-body hover:bg-line-soft disabled:opacity-30">{children}</button>;
}

function FilePick({ label, onFile, pending, icon, small }: { label: string; onFile: (f: File) => void; pending?: boolean; icon: ReactNode; small?: boolean }) {
  return (
    <label className={cx('press inline-flex cursor-pointer items-center gap-2 rounded-lg font-bold', small ? 'min-h-10 bg-white/95 px-3 text-sm shadow-card' : 'min-h-11 border border-line bg-white px-4 text-sm hover:bg-paper', pending && 'opacity-60')}>
      {icon}{pending ? '…' : label}
      <input type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" className="sr-only" disabled={pending}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
    </label>
  );
}
