import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { Download, Printer } from 'lucide-react';
import { api } from './lib/api';
import { cx, formatDate, formatNaira } from './lib/format';
import { Empty, Spinner } from './components/ui';
import { t, type MessageKey } from './i18n';

interface Doc {
  kind: 'invoice' | 'receipt';
  number: string;
  issued_at: string;
  business: { name: string; address: string | null; phone: string | null; brand_colour: string; slug: string; logo_url: string | null };
  customer: { name: string; business_name: string | null } | null;
  order: { number: number; created_at: string; total_kobo: number; subtotal_kobo: number; delivery_fee_kobo: number; amount_paid_kobo: number; balance_kobo: number; due_date: string | null; is_credit: boolean };
  items: { name: string; variant_label: string | null; unit_qty: number; unit: string | null; base_qty: number; unit_price_kobo: number; line_total_kobo: number }[];
  payments: { method: string; amount_kobo: number; received_at: string }[];
  payment: { method: string; amount_kobo: number; received_at: string } | null;
  pay_to: { account_number: string; bank_name: string; account_name: string } | null;
}

/** Light text on dark brand colours, ink on light ones. */
function onBrand(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.55 ? '#0E1411' : '#FFFFFF';
}

const groupAccount = (n: string) => n.replace(/^(\d{4})(\d{3})(\d+)$/, '$1 $2 $3');

/** Public invoice / receipt (link sent on WhatsApp). Unguessable token, no sign-in, no phone numbers. */
export default function InvoicePage() {
  const { token = '' } = useParams();
  const [doc, setDoc] = useState<Doc | null>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    api<Doc>(`/api/docs/${encodeURIComponent(token)}`).then((d) => { setDoc(d); document.title = `${d.number} · ${d.business.name}`; }).catch(() => setMissing(true));
  }, [token]);
  if (missing) return <Empty>{t('doc.notFound')}</Empty>;
  if (!doc) return <Spinner />;

  const o = doc.order;
  const receipt = doc.kind === 'receipt';
  const today = new Date().toISOString().slice(0, 10);
  const overdue = !receipt && o.balance_kobo > 0 && !!o.due_date && o.due_date < today;
  const fg = onBrand(doc.business.brand_colour);

  return (
    <main className="mx-auto min-h-dvh max-w-2xl bg-paper print:max-w-none print:bg-white">
      <header className="flex flex-wrap items-start justify-between gap-4 px-5 py-6 sm:px-8" style={{ background: doc.business.brand_colour, color: fg }}>
        <div className="min-w-0">
          <p className="font-display text-2xl font-extrabold leading-tight">{doc.business.name}</p>
          {doc.business.address && <p className="mt-1 text-sm opacity-90">{doc.business.address}</p>}
        </div>
        <div className="text-right">
          <h1 className="font-display text-2xl font-extrabold uppercase tracking-wide">{t(`doc.${doc.kind}` as MessageKey)}</h1>
          <p className="num text-sm opacity-90">{doc.number}</p>
          <p className="text-sm opacity-90">{formatDate(doc.issued_at)}</p>
        </div>
      </header>

      <div className="space-y-5 px-5 py-6 sm:px-8">
        <section className="flex flex-wrap justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-wider text-muted">{t('doc.billTo')}</p>
            <p className="font-bold">{doc.customer?.business_name ?? doc.customer?.name ?? '—'}</p>
            {doc.customer?.business_name && <p className="text-sm text-body">{doc.customer.name}</p>}
          </div>
          <div className="text-right text-sm">
            <p className="text-xs font-bold uppercase tracking-wider text-muted">{t('doc.forOrder', { n: o.number })}</p>
            <p>{t('doc.placed', { date: formatDate(o.created_at) })}</p>
            {o.due_date && o.balance_kobo > 0 && !receipt && (
              <p className={cx('font-bold', overdue ? 'text-red-ink' : 'text-body')}>{t(overdue ? 'doc.overdue' : 'doc.due', { date: formatDate(o.due_date) })}</p>
            )}
          </div>
        </section>

        {receipt && doc.payment ? (
          <section className="rounded-2xl bg-green-50 p-5 text-green-ink">
            <p className="text-sm font-bold">{t('doc.received')} · {t(`method.${doc.payment.method}` as MessageKey)} · {formatDate(doc.payment.received_at, true)}</p>
            <p className="num font-display text-[40px] font-extrabold leading-tight">{formatNaira(doc.payment.amount_kobo)}</p>
          </section>
        ) : null}

        <section className="overflow-hidden rounded-2xl border border-line bg-white">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('doc.item')}</caption>
            <thead className="bg-paper text-left text-xs uppercase tracking-wider text-muted">
              <tr><th scope="col" className="px-4 py-2.5">{t('doc.item')}</th><th scope="col" className="px-2 py-2.5">{t('doc.qty')}</th><th scope="col" className="px-4 py-2.5 text-right">{t('doc.amount')}</th></tr>
            </thead>
            <tbody>
              {doc.items.map((i, k) => (
                <tr key={k} className="border-t border-line align-top">
                  <td className="px-4 py-2.5">{i.name}{i.variant_label ? <span className="text-muted"> · {i.variant_label}</span> : null}</td>
                  <td className="whitespace-nowrap px-2 py-2.5">{i.unit_qty} {i.unit ?? ''}{i.base_qty !== i.unit_qty ? <span className="block text-xs text-muted">{i.base_qty} pcs</span> : null}</td>
                  <td className="num whitespace-nowrap px-4 py-2.5 text-right font-semibold">{formatNaira(i.line_total_kobo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="space-y-1.5 border-t border-line px-4 py-3 text-sm">
            {o.delivery_fee_kobo > 0 && <>
              <Row k={t('doc.subtotal')} v={formatNaira(o.subtotal_kobo)} />
              <Row k={t('doc.delivery')} v={formatNaira(o.delivery_fee_kobo)} />
            </>}
            <Row k={t('order.total')} v={formatNaira(o.total_kobo)} strong />
            {o.amount_paid_kobo > 0 && <Row k={t('doc.paidSoFar')} v={formatNaira(o.amount_paid_kobo)} className="text-green-ink" />}
            {o.balance_kobo > 0
              ? <Row k={t('doc.balanceToPay')} v={formatNaira(o.balance_kobo)} strong className="text-red-ink" />
              : <p className="pt-1 text-right font-bold text-green-ink">{t('doc.paidInFull')}</p>}
          </dl>
        </section>

        {doc.payments.length > 0 && (
          <section>
            <h2 className="text-xs font-bold uppercase tracking-wider text-muted">{t('doc.payments')}</h2>
            <ul className="mt-1.5 space-y-1 text-sm">
              {doc.payments.map((p, k) => <li key={k} className="flex justify-between gap-3"><span>{formatDate(p.received_at)} · {t(`method.${p.method}` as MessageKey)}</span><span className="num">{formatNaira(p.amount_kobo)}</span></li>)}
            </ul>
          </section>
        )}

        {doc.pay_to && o.balance_kobo > 0 && (
          <section aria-label={t('doc.payByTransfer')} className="rounded-3xl bg-ink p-5 text-white">
            <p className="text-xs font-bold uppercase tracking-wider text-gold">{t('doc.payByTransfer')}</p>
            <p className="num mt-1 font-display text-[32px] font-extrabold tracking-wide">{groupAccount(doc.pay_to.account_number)}</p>
            <p className="text-sm text-[#E7E2D6]">{doc.pay_to.bank_name} · {doc.pay_to.account_name}</p>
          </section>
        )}

        <div className="flex flex-wrap gap-2 print:hidden">
          <a href={`/api/docs/${encodeURIComponent(token)}/pdf`} className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-green px-5 font-bold text-white" download={`${doc.number}.pdf`}>
            <Download className="size-5" aria-hidden />{t('doc.downloadPdf')}
          </a>
          <button type="button" onClick={() => window.print()} className="inline-flex min-h-12 items-center gap-2 rounded-xl border border-line bg-white px-5 font-bold">
            <Printer className="size-5" aria-hidden />{t('doc.print')}
          </button>
        </div>
        <p className="border-t border-line pt-4 text-sm text-muted">{t('doc.thanks')} <a className="font-bold underline" href={`/s/${doc.business.slug}`}>{doc.business.name}</a></p>
      </div>
    </main>
  );
}

function Row({ k, v, strong, className }: { k: string; v: string; strong?: boolean; className?: string }) {
  return (
    <div className={cx('flex justify-between gap-3', strong && 'text-base font-bold', className)}>
      <dt>{k}</dt><dd className="num">{v}</dd>
    </div>
  );
}
