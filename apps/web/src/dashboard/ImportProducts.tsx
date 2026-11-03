import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CheckCircle2, ClipboardPaste, Download, FileSpreadsheet, TriangleAlert, Upload } from 'lucide-react';
import { IMPORT_FIELDS, IMPORT_TEMPLATE, applyMapping, guessMapping, parseCsv, parseTextList, rowsToProducts, type ImportField, type Mapping, type RowIssue } from '@trawer/core/import';
import type { ProductInput } from '@trawer/core/schemas';
import { api, ApiError } from '../lib/api';
import { invalidate, useMutation } from '../lib/use-api';
import { cx, formatNaira } from '../lib/format';
import { Badge, Button, Card, ErrorNote, Field, Select, Textarea } from '../components/ui';
import { t, type MessageKey } from '../i18n';
import { useBiz } from './context';

interface ReportLine { index: number; name: string; variants: number; status: 'new' | 'duplicate' | 'invalid' | 'created' | 'failed' | 'skipped'; messages: string[] }
interface Report { report: ReportLine[]; summary: Record<'new' | 'created' | 'duplicate' | 'skipped' | 'invalid' | 'failed', number> }

type Step =
  | { at: 'pick' }
  | { at: 'map'; file: string; header: string[]; rows: string[][]; mapping: Mapping }
  | { at: 'review'; source: 'import' | 'text_list'; products: ProductInput[]; issues: RowIssue[]; dry: Report }
  | { at: 'done'; result: Report };

const REQUIRED: ImportField[] = ['name', 'price'];

/** Bulk import: a spreadsheet (CSV or Excel) or a pasted WhatsApp-style list → preview → import. */
export function ImportProducts() {
  const b = useBiz();
  const base = `/api/biz/${b.business.id}`;
  const [step, setStep] = useState<Step>({ at: 'pick' });
  const [text, setText] = useState('');
  const [publish, setPublish] = useState(false);
  const [duplicates, setDuplicates] = useState<'skip' | 'add'>('skip');
  const canPublish = b.can('products.manage');

  const check = useMutation(async (source: 'import' | 'text_list', products: ProductInput[], issues: RowIssue[]) => {
    if (!products.length) throw new ApiError(0, 'import_nothing_found');
    const dry = await api<Report>(`${base}/import`, { json: { dry_run: true, duplicates, products } });
    setStep({ at: 'review', source, products, issues, dry });
  });
  const run = useMutation(async (products: ProductInput[]) => {
    const result = await api<Report>(`${base}/import`, { json: { dry_run: false, duplicates, products } });
    void invalidate(base);
    setStep({ at: 'done', result });
  });
  const read = useMutation(async (file: File) => {
    let rows: string[][];
    if (/\.xlsx$/i.test(file.name)) {
      const { default: readXlsxFile } = await import('read-excel-file/browser');
      const sheets = await readXlsxFile(file);
      rows = (sheets[0]?.data ?? []).map((r) => r.map((c) => (c == null ? '' : c instanceof Date ? c.toISOString().slice(0, 10) : String(c))));
    } else if (/\.(csv|txt|tsv)$/i.test(file.name) || file.type.startsWith('text/')) {
      rows = parseCsv(await file.text());
    } else {
      throw new ApiError(0, 'import_file_type');
    }
    if (rows.length < 2) throw new ApiError(0, 'import_nothing_found');
    const header = rows[0]!.map((h, i) => h.trim() || `Column ${i + 1}`);
    setStep({ at: 'map', file: file.name, header, rows: rows.slice(1), mapping: guessMapping(header) });
  });
  const status = publish && canPublish ? 'active' : 'draft';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to={`${b.base}/products`} className="text-sm font-bold text-muted">← {t('dash.products')}</Link>
          <h1 className="font-display text-[30px] font-extrabold">{t('imp.title')}</h1>
          <p className="text-body">{t('imp.intro')}</p>
        </div>
        <Steps at={step.at} />
      </div>

      {step.at === 'pick' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="space-y-3">
            <h2 className="flex items-center gap-2 font-display text-xl font-extrabold"><FileSpreadsheet className="size-6 text-green" aria-hidden />{t('imp.fileTitle')}</h2>
            <p className="text-sm text-body">{t('imp.fileHint')}</p>
            <label className="press flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line bg-paper p-4 text-center hover:border-ink/40">
              <Upload className="size-7 text-muted" aria-hidden />
              <span className="font-bold">{read.pending ? t('common.loading') : t('imp.chooseFile')}</span>
              <span className="text-xs text-muted">CSV · Excel (.xlsx)</span>
              <input type="file" accept=".csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void read.run(f); }} />
            </label>
            <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(IMPORT_TEMPLATE)}`} download="trawer-products-template.csv"
              className="inline-flex items-center gap-1.5 text-sm font-bold underline underline-offset-4"><Download className="size-4" aria-hidden />{t('imp.template')}</a>
            <ErrorNote error={read.error} />
          </Card>
          <Card className="space-y-3">
            <h2 className="flex items-center gap-2 font-display text-xl font-extrabold"><ClipboardPaste className="size-6 text-indigo" aria-hidden />{t('imp.pasteTitle')}</h2>
            <p className="text-sm text-body">{t('imp.pasteHint')}</p>
            <Field label={t('imp.pasteLabel')} htmlFor="list">
              <Textarea id="list" rows={7} value={text} onChange={(e) => setText(e.target.value)}
                placeholder={'1. Ankara wax print red - ₦12,500 x 30\nSwiss lace (gold) 45k qty 10\nChiffon blue 8,500 (20 pcs)'} />
            </Field>
            <Options publish={publish} setPublish={setPublish} canPublish={canPublish} duplicates={duplicates} setDuplicates={setDuplicates} />
            <Button className="w-full" disabled={!text.trim()} pending={check.pending} onClick={() => {
              const parsed = parseTextList(text);
              const built = rowsToProducts(parsed.rows, { status, source: 'text_list' }, 1);
              // Map row positions back to the line numbers people see in their list.
              const issues = [...parsed.issues, ...built.issues.map((i) => ({ ...i, row: parsed.lines[i.row - 1] ?? i.row }))].sort((a, c) => a.row - c.row);
              void check.run('text_list', built.products, issues);
            }}>{t('imp.readList')}</Button>
            <ErrorNote error={check.error} />
          </Card>
        </div>
      )}

      {step.at === 'map' && (
        <MapColumns step={step} onChange={(mapping) => setStep({ ...step, mapping })} pending={check.pending} error={check.error}
          options={<Options publish={publish} setPublish={setPublish} canPublish={canPublish} duplicates={duplicates} setDuplicates={setDuplicates} />}
          onBack={() => setStep({ at: 'pick' })}
          onNext={() => {
            const built = rowsToProducts(applyMapping(step.rows, step.mapping), { status, source: 'import' });
            void check.run('import', built.products, built.issues);
          }} />
      )}

      {step.at === 'review' && (
        <Review step={step} pending={run.pending} error={run.error} onBack={() => setStep({ at: 'pick' })}
          onImport={() => void run.run(step.products.filter((_, i) => step.dry.report.find((r) => r.index === i)?.status === 'new'))} />
      )}

      {step.at === 'done' && (
        <Card className="space-y-4 text-center">
          <CheckCircle2 className="mx-auto size-14 text-green" aria-hidden />
          <h2 className="font-display text-2xl font-extrabold">{t('imp.doneTitle', { n: step.result.summary.created })}</h2>
          <p className="text-body">{t('imp.doneBody', { skipped: step.result.summary.skipped, failed: step.result.summary.failed + step.result.summary.invalid })}</p>
          {step.result.report.some((r) => r.status === 'failed' || r.status === 'invalid') && <ReportTable lines={step.result.report.filter((r) => r.status === 'failed' || r.status === 'invalid')} />}
          <div className="flex flex-wrap justify-center gap-2">
            <Link to={`${b.base}/products${status === 'draft' ? '?status=draft' : ''}`} className="press inline-flex min-h-13 items-center rounded-xl bg-green px-5 font-bold text-white">{t('imp.viewProducts')}</Link>
            <Button variant="secondary" onClick={() => { setText(''); setStep({ at: 'pick' }); }}>{t('imp.again')}</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function Steps({ at }: { at: Step['at'] }) {
  const all: Step['at'][] = ['pick', 'map', 'review', 'done'];
  const i = all.indexOf(at);
  return (
    <ol className="flex items-center gap-1.5 text-xs font-bold" aria-label={t('imp.progress')}>
      {all.map((s, k) => (
        <li key={s} aria-current={k === i ? 'step' : undefined}
          className={cx('rounded-full px-3 py-1.5', k === i ? 'bg-ink text-paper' : k < i ? 'bg-green-50 text-green-ink' : 'bg-line-soft text-muted')}>
          {k + 1}. {t(`imp.step.${s}` as MessageKey)}
        </li>
      ))}
    </ol>
  );
}

function Options({ publish, setPublish, canPublish, duplicates, setDuplicates }: {
  publish: boolean; setPublish: (v: boolean) => void; canPublish: boolean; duplicates: 'skip' | 'add'; setDuplicates: (v: 'skip' | 'add') => void;
}) {
  return (
    <div className="space-y-2 rounded-xl bg-line-soft p-3 text-sm">
      {canPublish
        ? <label className="flex min-h-10 items-center gap-2.5 font-semibold"><input type="checkbox" className="size-5" checked={publish} onChange={(e) => setPublish(e.target.checked)} />{t('imp.publishNow')}</label>
        : <p className="text-body">{t('imp.asDrafts')}</p>}
      <label className="flex min-h-10 items-center gap-2.5 font-semibold"><input type="checkbox" className="size-5" checked={duplicates === 'skip'} onChange={(e) => setDuplicates(e.target.checked ? 'skip' : 'add')} />{t('imp.skipDuplicates')}</label>
    </div>
  );
}

function MapColumns({ step, onChange, onBack, onNext, pending, error, options }: {
  step: Extract<Step, { at: 'map' }>; onChange: (m: Mapping) => void; onBack: () => void; onNext: () => void; pending: boolean; error: unknown; options: React.ReactNode;
}) {
  const sample = step.rows.slice(0, 3);
  const missing = REQUIRED.filter((f) => step.mapping[f] === undefined);
  return (
    <Card className="space-y-4">
      <div>
        <h2 className="font-display text-xl font-extrabold">{t('imp.mapTitle')}</h2>
        <p className="text-sm text-body">{t('imp.mapHint', { file: step.file, n: step.rows.length })}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {IMPORT_FIELDS.map((f) => {
          const col = step.mapping[f];
          return (
            <Field key={f} label={`${t(`imp.field.${f}` as MessageKey)}${REQUIRED.includes(f) ? ' *' : ''}`} htmlFor={`map-${f}`}
              hint={col !== undefined && sample[0] ? `${t('imp.eg')} ${sample.map((r) => r[col]).filter(Boolean).slice(0, 2).join(' · ') || '—'}` : undefined}>
              <Select id={`map-${f}`} value={col ?? ''} aria-invalid={REQUIRED.includes(f) && col === undefined}
                onChange={(e) => { const m = { ...step.mapping }; if (e.target.value === '') delete m[f]; else m[f] = Number(e.target.value); onChange(m); }}>
                <option value="">{t('imp.notInFile')}</option>
                {step.header.map((h, i) => <option key={i} value={i}>{h}</option>)}
              </Select>
            </Field>
          );
        })}
      </div>
      {options}
      {missing.length > 0 && <p role="alert" className="rounded-xl bg-gold-50 p-3 text-sm font-semibold text-gold-ink">{t('imp.mapMissing', { fields: missing.map((f) => t(`imp.field.${f}` as MessageKey)).join(', ') })}</p>}
      <ErrorNote error={error as never} />
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onBack}>{t('common.back')}</Button>
        <Button className="flex-1" disabled={missing.length > 0} pending={pending} onClick={onNext}>{t('imp.check')}</Button>
      </div>
    </Card>
  );
}

function Review({ step, onImport, onBack, pending, error }: { step: Extract<Step, { at: 'review' }>; onImport: () => void; onBack: () => void; pending: boolean; error: unknown }) {
  const s = step.dry.summary;
  const variants = useMemo(() => step.products.reduce((n, p) => n + p.variants.length, 0), [step.products]);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={t('imp.willAdd')} value={s.new} tone="good" sub={t('imp.variants', { n: variants })} />
        <Stat label={t('imp.alreadyIn')} value={s.duplicate} tone="neutral" />
        <Stat label={t('imp.needFixing')} value={s.invalid} tone={s.invalid ? 'bad' : 'neutral'} />
        <Stat label={t('imp.rowsSkipped')} value={step.issues.filter((i) => i.field === 'name' || i.field === 'price' || i.field === 'row').length} tone={step.issues.length ? 'warn' : 'neutral'} />
      </div>
      {step.issues.length > 0 && (
        <Card className="space-y-2">
          <h2 className="flex items-center gap-2 font-display text-lg font-extrabold"><TriangleAlert className="size-5 text-gold-ink" aria-hidden />{t('imp.issuesTitle')}</h2>
          <ul className="max-h-60 space-y-1 overflow-y-auto text-sm" tabIndex={0} aria-label={t('imp.issuesTitle')}>
            {step.issues.map((i, k) => <li key={k}><b className="num">{t(step.source === 'text_list' ? 'imp.line' : 'imp.row', { n: i.row })}</b> · {i.message}</li>)}
          </ul>
        </Card>
      )}
      <ReportTable lines={step.dry.report} products={step.products} />
      <ErrorNote error={error as never} />
      <div className="flex gap-2">
        <Button variant="secondary" onClick={onBack}>{t('common.back')}</Button>
        <Button className="flex-1" size="lg" disabled={s.new === 0} pending={pending} onClick={onImport}>{t('imp.importN', { n: s.new })}</Button>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: number; sub?: string; tone: 'good' | 'bad' | 'warn' | 'neutral' }) {
  return (
    <div className={cx('rounded-2xl p-4', tone === 'good' ? 'bg-green-50 text-green-ink' : tone === 'bad' ? 'bg-red-50 text-red-ink' : tone === 'warn' ? 'bg-gold-50 text-gold-ink' : 'bg-line-soft text-body')}>
      <p className="text-sm font-semibold">{label}</p>
      <p className="num font-display text-3xl font-extrabold">{value}</p>
      {sub && <p className="text-xs">{sub}</p>}
    </div>
  );
}

const TONE: Record<ReportLine['status'], 'good' | 'neutral' | 'bad' | 'warn'> = { new: 'good', created: 'good', duplicate: 'neutral', skipped: 'neutral', invalid: 'bad', failed: 'bad' };

function ReportTable({ lines, products }: { lines: ReportLine[]; products?: ProductInput[] }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-line/70 bg-surface shadow-card" tabIndex={0} role="region" aria-label={t('imp.preview')}>
      <table className="w-full min-w-[560px] text-left text-sm">
        <caption className="sr-only">{t('imp.preview')}</caption>
        <thead className="bg-paper text-xs uppercase tracking-wider text-muted">
          <tr><th scope="col" className="px-4 py-2.5">{t('imp.field.name')}</th><th scope="col" className="px-3 py-2.5">{t('imp.colours')}</th><th scope="col" className="px-3 py-2.5">{t('imp.field.price')}</th><th scope="col" className="px-3 py-2.5">{t('imp.field.stock')}</th><th scope="col" className="px-4 py-2.5">{t('imp.status')}</th></tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const p = products?.[l.index];
            const prices = p ? p.variants.map((v) => v.retail_price_kobo) : [];
            return (
              <tr key={l.index} className="border-t border-line-soft align-top">
                <td className="px-4 py-2.5 font-semibold">{l.name || '—'}{p?.category ? <span className="block text-xs font-normal text-muted">{p.category}</span> : null}</td>
                <td className="px-3 py-2.5">{p ? p.variants.map((v) => [v.colour, v.size].filter(Boolean).join(' / ') || '—').join(', ') : l.variants}</td>
                <td className="num px-3 py-2.5">{prices.length ? (Math.min(...prices) === Math.max(...prices) ? formatNaira(prices[0]!) : `${formatNaira(Math.min(...prices))}–${formatNaira(Math.max(...prices))}`) : '—'}</td>
                <td className="num px-3 py-2.5">{p ? p.variants.reduce((n, v) => n + (v.opening_stock ?? 0), 0) : '—'}</td>
                <td className="px-4 py-2.5"><Badge tone={TONE[l.status]}>{t(`imp.st.${l.status}` as MessageKey)}</Badge>{l.messages.map((m, k) => <span key={k} className="mt-1 block text-xs text-muted">{m}</span>)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
