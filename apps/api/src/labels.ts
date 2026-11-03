/**
 * Barcode label sheets (PDF): A4 sticker sheets (21 per page, 63.5 × 38.1 mm, the common size in
 * stationery shops) or one 50 × 30 mm label per page for thermal label printers.
 */
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { ean13Bars, ean13Text } from '@trawer/core/barcode';
import { formatNaira } from '@trawer/core/money';
import { loadFonts } from './pdf';

const MM = 72 / 25.4;
export const LABEL_LAYOUTS = {
  'a4-21': { page: [210, 297], label: [63.5, 38.1], cols: 3, rows: 7, left: 7.2, top: 15.1, gapX: 2.5, gapY: 0, barHeight: 11 },
  'roll-50x30': { page: [50, 30], label: [50, 30], cols: 1, rows: 1, left: 0, top: 0, gapX: 0, gapY: 0, barHeight: 10 },
} as const;
export type LabelLayout = keyof typeof LABEL_LAYOUTS;

export interface LabelItem { name: string; variant: string | null; barcode: string; price_kobo: number | null }

const INK = rgb(0.05, 0.08, 0.07);
const MUTED = rgb(0.35, 0.37, 0.34);

function fit(text: string, font: PDFFont, size: number, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > width) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/** Up to two lines, word-wrapped, the second shortened with an ellipsis. */
function twoLines(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = text.split(/\s+/);
  let first = '';
  while (words.length && font.widthOfTextAtSize(`${first} ${words[0]}`.trim(), size) <= width) first = `${first} ${words.shift()}`.trim();
  if (!first) return [fit(text, font, size, width)];
  return words.length ? [first, fit(words.join(' '), font, size, width)] : [first];
}

function drawLabel(page: PDFPage, x: number, yTop: number, w: number, h: number, barHeight: number, item: LabelItem, shop: string, fonts: { reg: PDFFont; bold: PDFFont }) {
  const pad = 2.6 * MM;
  const inner = w - pad * 2;
  let y = yTop - pad;
  page.drawText(fit(shop.toUpperCase(), fonts.reg, 5, inner), { x: x + pad, y: y - 5, size: 5, font: fonts.reg, color: MUTED });
  y -= 7.5;
  for (const line of twoLines(item.name, fonts.bold, 7.5, inner)) {
    page.drawText(line, { x: x + pad, y: y - 7.5, size: 7.5, font: fonts.bold, color: INK });
    y -= 8.6;
  }
  const price = item.price_kobo != null ? formatNaira(item.price_kobo) : '';
  const priceW = price ? fonts.bold.widthOfTextAtSize(price, 10) : 0;
  if (item.variant) page.drawText(fit(item.variant, fonts.reg, 6.5, inner - priceW - 4), { x: x + pad, y: y - 8, size: 6.5, font: fonts.reg, color: MUTED });
  if (price) page.drawText(price, { x: x + w - pad - priceW, y: y - 9, size: 10, font: fonts.bold, color: INK });

  // Bars sit above the digits at the bottom; 9 modules of quiet zone on each side.
  const module = inner / (95 + 18);
  const digitsSize = 6.5;
  const barBottom = yTop - h + pad + digitsSize + 1.5;
  const barH = Math.min(barHeight * MM, y - 11 - barBottom);
  const x0 = x + pad + 9 * module;
  for (const [start, width] of ean13Bars(item.barcode)) {
    page.drawRectangle({ x: x0 + start * module, y: barBottom, width: width * module, height: barH, color: rgb(0, 0, 0) });
  }
  const text = ean13Text(item.barcode);
  const tw = fonts.reg.widthOfTextAtSize(text, digitsSize);
  page.drawText(text, { x: x + (w - tw) / 2, y: yTop - h + pad, size: digitsSize, font: fonts.reg, color: INK });
}

export async function renderLabelsPdf(items: LabelItem[], layout: LabelLayout, shop: string, skip = 0): Promise<Uint8Array> {
  const L = LABEL_LAYOUTS[layout];
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`${shop} labels`);
  pdf.setCreator('Trawer');
  const [regBytes, boldBytes] = await loadFonts();
  const fonts = { reg: await pdf.embedFont(regBytes, { subset: false }), bold: await pdf.embedFont(boldBytes, { subset: false }) };
  const perPage = L.cols * L.rows;
  const [pw, ph] = [L.page[0] * MM, L.page[1] * MM];
  const [lw, lh] = [L.label[0] * MM, L.label[1] * MM];
  let page: PDFPage | null = null;
  items.forEach((item, n) => {
    const slot = n + skip;
    const onPage = slot % perPage;
    if (!page || onPage === 0 || n === 0) page = pdf.addPage([pw, ph]);
    const col = onPage % L.cols;
    const row = Math.floor(onPage / L.cols);
    const x = (L.left + col * (L.label[0] + L.gapX)) * MM;
    const yTop = ph - (L.top + row * (L.label[1] + L.gapY)) * MM;
    drawLabel(page, x, yTop, lw, lh, L.barHeight, item, shop, fonts);
  });
  if (!items.length) pdf.addPage([pw, ph]);
  return pdf.save();
}
