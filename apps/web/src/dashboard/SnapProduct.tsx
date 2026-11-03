import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Camera, Mic, MicOff, Sparkles } from 'lucide-react';
import type { ProductDraft } from '@trawer/core/ai-draft';
import { api } from '../lib/api';
import { useMutation } from '../lib/use-api';
import { cx } from '../lib/format';
import { Button, Card, ErrorNote, Field, Textarea } from '../components/ui';
import { t } from '../i18n';
import { useBiz } from './context';

export interface SnapResult { draft: ProductDraft; image: { path: string; url: string | null } }

/* Minimal typing for the browser speech API (Chrome on Android ships it as webkitSpeechRecognition). */
interface Recognition { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null }
const SpeechRecognition = (typeof window !== 'undefined'
  ? (window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }).SpeechRecognition
    ?? (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition
  : undefined);

/** Snap-to-upload: photo (+ spoken or typed note) → AI draft → the normal product form, pre-filled. */
export function SnapProduct() {
  const b = useBiz();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [interim, setInterim] = useState('');
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  useEffect(() => () => rec.current?.stop(), []);

  const toggleMic = () => {
    if (!SpeechRecognition) return;
    if (listening) { rec.current?.stop(); return; }
    const r = new SpeechRecognition();
    r.lang = 'en-NG';
    r.interimResults = true;
    r.continuous = true;
    r.onresult = (e) => {
      let finalText = '', live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) finalText += res[0]!.transcript; else live += res[0]!.transcript;
      }
      if (finalText) setNote((n) => `${n}${n && !n.endsWith(' ') ? ' ' : ''}${finalText.trim()}`.slice(0, 1000));
      setInterim(live);
    };
    r.onend = () => { setListening(false); setInterim(''); };
    r.onerror = () => { setListening(false); setInterim(''); };
    rec.current = r;
    r.start();
    setListening(true);
  };

  const draft = useMutation(async () => {
    if (!file) return;
    rec.current?.stop();
    const form = new FormData();
    form.append('file', file);
    form.append('note', note);
    const r = await api<SnapResult>(`/api/biz/${b.business.id}/products/snap`, { form });
    navigate(`${b.base}/products/new`, { state: { snap: r } });
  });

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <div>
        <Link to={`${b.base}/products`} className="text-sm font-bold text-muted">← {t('dash.products')}</Link>
        <h1 className="font-display text-[30px] font-extrabold">{t('snap.title')}</h1>
        <p className="text-body">{t('snap.intro')}</p>
      </div>

      <label className={cx('press relative flex aspect-[4/3] cursor-pointer flex-col items-center justify-center gap-3 overflow-hidden rounded-3xl border-2 border-dashed text-center',
        preview ? 'border-transparent' : 'border-line bg-surface hover:border-ink/40')}>
        {preview
          ? <img src={preview} alt={t('snap.photoAlt')} className="absolute inset-0 size-full object-cover" />
          : <>
              <span className="flex size-16 items-center justify-center rounded-full bg-ink text-paper"><Camera className="size-8" aria-hidden /></span>
              <span className="font-display text-lg font-extrabold">{t('snap.takePhoto')}</span>
              <span className="max-w-xs text-sm text-muted">{t('snap.photoHint')}</span>
            </>}
        {preview && <span className="absolute bottom-3 right-3 rounded-full bg-ink/80 px-3 py-1.5 text-sm font-bold text-paper">{t('snap.retake')}</span>}
        <input type="file" accept="image/*" capture="environment" className="sr-only" aria-label={t('snap.takePhoto')}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); setPreview(URL.createObjectURL(f)); } }} />
      </label>

      <Card className="space-y-3">
        <Field label={t('snap.noteLabel')} htmlFor="note" hint={SpeechRecognition ? t('snap.noteHintVoice') : t('snap.noteHint')}>
          <div className="relative">
            <Textarea id="note" rows={3} maxLength={1000} value={note + (interim ? ` ${interim}` : '')} onChange={(e) => { setNote(e.target.value); setInterim(''); }}
              placeholder={t('snap.notePlaceholder')} className={cx(SpeechRecognition && 'pr-16')} />
            {SpeechRecognition && (
              <button type="button" onClick={toggleMic} aria-pressed={listening} aria-label={listening ? t('snap.stopTalking') : t('snap.talk')}
                className={cx('press absolute right-2 top-2 flex size-12 items-center justify-center rounded-full', listening ? 'bg-red text-white' : 'bg-ink text-paper')}>
                {listening ? <MicOff className="size-5" aria-hidden /> : <Mic className="size-5" aria-hidden />}
                {listening && <span className="pulse-ring absolute inset-0 rounded-full bg-red" aria-hidden />}
              </button>
            )}
          </div>
        </Field>
        {listening && <p role="status" className="text-sm font-semibold text-red-ink">{t('snap.listening')}</p>}
      </Card>

      <ErrorNote error={draft.error} />
      <Button size="lg" className="w-full" disabled={!file} pending={draft.pending} onClick={() => void draft.run()}>
        <Sparkles className="size-5" aria-hidden />{draft.pending ? t('snap.drafting') : t('snap.draft')}
      </Button>
      <p className="text-center text-xs text-muted">{t('snap.privacy')}</p>
    </div>
  );
}
