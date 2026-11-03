/**
 * Invoice / receipt PDFs (A4) with pdf-lib. Inter is embedded (subset) so naira amounts print
 * with the ₦ sign; standard PDF fonts don't have that glyph.
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { formatNaira } from '@trawer/core/money';

const require = createRequire(import.meta.url);
let fonts: Promise<[Uint8Array, Uint8Array]> | null = null;
export function loadFonts() {
  fonts ??= Promise.all([
    readFile(require.resolve('@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf')),
    readFile(require.resolve('@expo-google-fonts/inter/700Bold/Inter_700Bold.ttf')),
  ]) as Promise<[Uint8Array, Uint8Array]>;
  return fonts;
}

export interface DocData {
  kind: 'invoice' | 'receipt';
  number: string;
  issued_at: string;
  business: { name: string; address: string | null; phone: string | null; brand_colour: string };
  customer: { name: string; business_name: string | null } | null;
  order: { number: number; created_at: string; total_kobo: number; subtotal_kobo: number; delivery_fee_kobo: number; amount_paid_kobo: number; balance_kobo: number; due_date: string | null; is_credit: boolean };
  items: { name: string; variant_label: string | null; unit_qty: number; unit: string | null; base_qty: number; unit_price_kobo: number; line_total_kobo: number }[];
  payments: { method: string; amount_kobo: number; received_at: string }[];
  payment: { method: string; amount_kobo: number; received_at: string } | null;
  pay_to: { account_number: string; bank_name: string; account_name: string } | null;
}

const hex = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const INK = hex('#0E1411');
const MUTED = hex('#5B5F57');
const LINE = hex('#E4DED2');
const RED = hex('#9A1C13');
const GREEN = hex('#075C38');
const METHOD: Record<string, string> = { cash: 'Cash', card_terminal: 'Card', transfer: 'Bank transfer', ussd: 'USSD', qr: 'QR', virtual_account: 'Bank transfer', store_credit: 'Store credit' };
const date = (iso: string) => new Date(iso).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' });

function inkOn(h: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.55 ? INK : rgb(1, 1, 1);
}

function fit(text: string, font: PDFFont, size: number, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > width) t = t.slice(0, -1);
  return `${t}…`;
}

export async function renderDocumentPdf(d: DocData, verifyUrl: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const [regBytes, boldBytes] = await loadFonts();
  // Full embedding: pdf-lib's subsetter drops glyphs from these Inter builds.
  const reg = await pdf.embedFont(regBytes, { subset: false });
  const bold = await pdf.embedFont(boldBytes, { subset: false });
  pdf.setTitle(`${d.kind === 'invoice' ? 'Invoice' : 'Receipt'} ${d.number} · ${d.business.name}`);
  pdf.setAuthor(d.business.name);
  pdf.setProducer('Trawer');

  const W = 595.28;
  const H = 841.89;
  const M = 44;
  let page: PDFPage = pdf.addPage([W, H]);
  let y = H;

  const text = (s: string, x: number, yy: number, o: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; right?: boolean } = {}) => {
    const f = o.font ?? reg;
    const size = o.size ?? 10;
    page.drawText(s, { x: o.right ? x - f.widthOfTextAtSize(s, size) : x, y: yy, size, font: f, color: o.color ?? INK });
  };

  // Header band in the shop's colour
  const band = hex(d.business.brand_colour);
  const bandInk = inkOn(d.business.brand_colour);
  page.drawRectangle({ x: 0, y: H - 112, width: W, height: 112, color: band });
  text(fit(d.business.name, bold, 22, 330), M, H - 52, { size: 22, font: bold, color: bandInk });
  const contact = [d.business.address, d.business.phone].filter(Boolean).join('  ·  ');
  if (contact) text(fit(contact, reg, 9.5, 330), M, H - 72, { size: 9.5, color: bandInk });
  text(d.kind === 'invoice' ? 'INVOICE' : 'RECEIPT', W - M, H - 50, { size: 18, font: bold, color: bandInk, right: true });
  text(d.number, W - M, H - 70, { size: 10, color: bandInk, right: true });
  text(date(d.issued_at), W - M, H - 86, { size: 10, color: bandInk, right: true });
  y = H - 146;

  // Bill to + order meta
  text(d.kind === 'invoice' ? 'BILL TO' : 'RECEIVED FROM', M, y, { size: 8.5, font: bold, color: MUTED });
  text(`ORDER #${d.order.number}`, W - M, y, { size: 8.5, font: bold, color: MUTED, right: true });
  y -= 16;
  text(d.customer ? (d.customer.business_name || d.customer.name || 'Customer') : 'Walk-in customer', M, y, { size: 12, font: bold });
  text(`Placed ${date(d.order.created_at)}`, W - M, y, { size: 10, right: true });
  if (d.customer?.business_name && d.customer.name) { y -= 14; text(d.customer.name, M, y, { size: 10, color: MUTED }); }
  if (d.order.due_date && d.order.balance_kobo > 0) { text(`Due ${date(d.order.due_date)}`, W - M, y - (d.customer?.business_name ? 0 : 14), { size: 10, font: bold, color: RED, right: true }); }
  y -= 34;

  // Items table
  const cols = { qty: W - M - 250, price: W - M - 90, amount: W - M };
  const header = () => {
    page.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: 22, color: hex('#FAF7F0') });
    text('ITEM', M + 8, y, { size: 8.5, font: bold, color: MUTED });
    text('QTY', cols.qty, y, { size: 8.5, font: bold, color: MUTED });
    text('PRICE / PC', cols.price, y, { size: 8.5, font: bold, color: MUTED, right: true });
    text('AMOUNT', cols.amount - 8, y, { size: 8.5, font: bold, color: MUTED, right: true });
    y -= 26;
  };
  header();
  for (const i of d.items) {
    if (y < 190) {
      text('continued on next page', W - M, 60, { size: 8.5, color: MUTED, right: true });
      page = pdf.addPage([W, H]);
      y = H - 60;
      header();
    }
    const name = `${i.name}${i.variant_label ? ` · ${i.variant_label}` : ''}`;
    text(fit(name, reg, 10, cols.qty - M - 20), M + 8, y, { size: 10 });
    text(`${i.unit_qty} ${i.unit ?? ''}${i.base_qty !== i.unit_qty ? ` (${i.base_qty} pcs)` : ''}`, cols.qty, y, { size: 10 });
    text(formatNaira(i.unit_price_kobo), cols.price, y, { size: 10, right: true });
    text(formatNaira(i.line_total_kobo), cols.amount - 8, y, { size: 10, font: bold, right: true });
    y -= 8;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: LINE });
    y -= 16;
  }

  // Totals
  y -= 4;
  const row = (label: string, value: string, o: { bold?: boolean; color?: ReturnType<typeof rgb>; size?: number } = {}) => {
    text(label, W - M - 190, y, { size: o.size ?? 10.5, font: o.bold ? bold : reg, color: o.color });
    text(value, W - M - 8, y, { size: o.size ?? 10.5, font: o.bold ? bold : reg, color: o.color, right: true });
    y -= (o.size ?? 10.5) + 8;
  };
  if (d.order.delivery_fee_kobo > 0) { row('Items', formatNaira(d.order.subtotal_kobo)); row('Delivery', formatNaira(d.order.delivery_fee_kobo)); }
  row('Total', formatNaira(d.order.total_kobo), { bold: true, size: 13 });
  if (d.kind === 'receipt' && d.payment) row(`Received (${METHOD[d.payment.method] ?? d.payment.method})`, formatNaira(d.payment.amount_kobo), { color: GREEN, bold: true });
  row('Paid so far', formatNaira(d.order.amount_paid_kobo), { color: GREEN });
  row(d.order.balance_kobo > 0 ? 'Balance to pay' : 'Balance', formatNaira(d.order.balance_kobo), { bold: true, color: d.order.balance_kobo > 0 ? RED : GREEN, size: 12 });

  // Payment history
  if (d.payments.length) {
    y -= 6;
    text('PAYMENTS', M, y, { size: 8.5, font: bold, color: MUTED });
    y -= 15;
    for (const p of d.payments.slice(0, 8)) {
      text(`${date(p.received_at)} · ${METHOD[p.method] ?? p.method}`, M, y, { size: 9.5, color: MUTED });
      text(formatNaira(p.amount_kobo), M + 230, y, { size: 9.5, color: MUTED, right: true });
      y -= 14;
    }
  }

  // How to pay
  if (d.order.balance_kobo > 0 && d.pay_to) {
    const boxH = 70;
    const boxY = Math.max(y - boxH - 10, 70);
    page.drawRectangle({ x: M, y: boxY, width: W - 2 * M, height: boxH, color: INK });
    text('PAY BY BANK TRANSFER', M + 16, boxY + boxH - 20, { size: 8.5, font: bold, color: hex('#F2B705') });
    text(d.pay_to.account_number.replace(/^(\d{4})(\d{3})(\d{3})$/, '$1 $2 $3'), M + 16, boxY + 18, { size: 20, font: bold, color: rgb(1, 1, 1) });
    text(`${d.pay_to.bank_name} · ${d.pay_to.account_name}`, W - M - 16, boxY + 20, { size: 10, color: rgb(1, 1, 1), right: true });
  }

  // Footer on every page
  for (const p of pdf.getPages()) {
    p.drawLine({ start: { x: M, y: 48 }, end: { x: W - M, y: 48 }, thickness: 0.6, color: LINE });
    p.drawText('Thank you for your business.', { x: M, y: 32, size: 8.5, font: reg, color: MUTED });
    const v = `Check this document: ${verifyUrl}`;
    p.drawText(v, { x: W - M - reg.widthOfTextAtSize(v, 8.5), y: 32, size: 8.5, font: reg, color: MUTED });
  }
  return pdf.save();
}
