/**
 * Bulk product import: spreadsheets (CSV / Excel rows) and pasted WhatsApp-style lists.
 *
 * Everything here is pure (no I/O) so the same code runs in the browser (preview) and is unit-tested.
 * Rows with the same product name become one product with several colour/size variants.
 */
import type { ProductInput } from './schemas';

export const IMPORT_FIELDS = ['name', 'category', 'description', 'colour', 'size', 'sku', 'barcode', 'price', 'cost', 'stock', 'unit', 'pack_unit', 'pack_size'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type Mapping = Partial<Record<ImportField, number>>;
export type ImportRow = Partial<Record<ImportField, string>>;

export interface RowIssue { row: number; field: ImportField | 'row'; message: string }
export interface ImportResult { products: ProductInput[]; issues: RowIssue[]; rowsUsed: number; rowsSkipped: number }

// ---------------------------------------------------------------- CSV

/** RFC 4180 CSV (quotes, "" escapes, CRLF, BOM). Detects comma, semicolon or tab separators. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const);
  const delim = counts.sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// ---------------------------------------------------------------- column matching

const SYNONYMS: Record<ImportField, string[]> = {
  name: ['name', 'product', 'product name', 'item', 'item name', 'title', 'description of goods', 'goods'],
  category: ['category', 'type', 'group', 'collection', 'department'],
  description: ['description', 'details', 'notes', 'about'],
  colour: ['colour', 'color', 'shade', 'variant', 'design'],
  size: ['size', 'length', 'yards', 'dimension'],
  sku: ['sku', 'code', 'item code', 'product code', 'ref', 'reference'],
  barcode: ['barcode', 'ean', 'upc', 'gtin', 'bar code'],
  price: ['price', 'selling price', 'retail price', 'retail', 'unit price', 'amount', 'sp', 'rate', 'price (₦)', 'price ngn'],
  cost: ['cost', 'cost price', 'buying price', 'cp', 'purchase price'],
  stock: ['stock', 'qty', 'quantity', 'in stock', 'available', 'units', 'count', 'pieces'],
  unit: ['unit', 'sold in', 'uom', 'base unit'],
  pack_unit: ['pack', 'pack unit', 'carton', 'bulk unit'],
  pack_size: ['pack size', 'per pack', 'pieces per pack', 'per carton', 'carton size', 'qty per carton'],
};

const norm = (s: string) => s.toLowerCase().replace(/[_\-.]+/g, ' ').replace(/[^\p{L}\p{N}₦ ()]/gu, '').replace(/\s+/g, ' ').trim();

/** Best guess of which column holds which field (exact synonym first, then "contains"). */
export function guessMapping(headers: string[]): Mapping {
  const h = headers.map(norm);
  const taken = new Set<number>();
  const map: Mapping = {};
  for (const pass of ['exact', 'contains'] as const) {
    for (const field of IMPORT_FIELDS) {
      if (map[field] !== undefined) continue;
      const i = h.findIndex((x, j) => !taken.has(j) && SYNONYMS[field].some((s) => (pass === 'exact' ? x === s : x.includes(s) && s.length >= 3)));
      if (i >= 0) { map[field] = i; taken.add(i); }
    }
  }
  return map;
}

export function applyMapping(rows: string[][], mapping: Mapping): ImportRow[] {
  return rows.map((r) => {
    const out: ImportRow = {};
    for (const f of IMPORT_FIELDS) { const i = mapping[f]; if (i !== undefined) out[f] = (r[i] ?? '').trim(); }
    return out;
  });
}

// ---------------------------------------------------------------- values

/** "₦12,500", "N12500", "12.5k", "12,500.00", "45000" → kobo; null when it isn't a price. */
export function parseNairaToKobo(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const s = raw.toLowerCase().replace(/naira|ngn|₦|\bn(?=\s?\d)/g, '').replace(/[\s,]/g, '');
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === 'k' ? 1_000 : m[2] === 'm' ? 1_000_000 : 1);
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000_000 ? Math.round(n * 100) : null;
}

const COLOURS: Record<string, string> = {
  red: '#C62828', wine: '#7B1E2B', maroon: '#6D1A1A', burgundy: '#6D1A2A', pink: '#E26D9C', peach: '#F6B18A', orange: '#EF6C1A',
  yellow: '#F2C318', gold: '#C9A227', cream: '#F3E7C9', beige: '#D8C3A0', brown: '#7A4B2A', green: '#2E7D32', 'army green': '#4B5320',
  olive: '#6B7A2E', teal: '#0F7C7C', blue: '#1F5FBF', 'royal blue': '#2A4BB8', navy: '#1C2A5C', 'sky blue': '#5AB4E8', purple: '#6A2C91',
  lilac: '#B79BD6', black: '#111111', white: '#F7F7F7', grey: '#8A8A8A', gray: '#8A8A8A', silver: '#BFC4C8', 'off white': '#EFEBE1',
};

/** A known colour name → swatch hex (null when unknown). */
export function colourHex(name: string | null | undefined): string | null {
  if (!name) return null;
  return COLOURS[name.trim().toLowerCase()] ?? null;
}

const title = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/(^|\s)\p{Ll}/gu, (m) => m.toUpperCase());

// ---------------------------------------------------------------- rows → products

export interface BuildOptions { status: 'draft' | 'active'; source: 'import' | 'text_list'; defaultUnit?: string }

/** Validate rows and group them into products (same name + category → one product, each row a variant). */
export function rowsToProducts(rows: ImportRow[], opts: BuildOptions, firstRowNumber = 2): ImportResult {
  const issues: RowIssue[] = [];
  const groups = new Map<string, { input: ProductInput; seen: Set<string> }>();
  let used = 0, skipped = 0;
  rows.forEach((r, idx) => {
    const rowNo = idx + firstRowNumber;
    const bad = (field: RowIssue['field'], message: string) => issues.push({ row: rowNo, field, message });
    if (!Object.values(r).some((v) => v && v.trim())) { skipped++; return; }
    const name = (r.name ?? '').trim();
    if (!name) { bad('name', 'Product name is missing'); skipped++; return; }
    if (name.length > 200) { bad('name', 'Product name is longer than 200 characters'); skipped++; return; }
    const price = parseNairaToKobo(r.price);
    if (price === null || price === 0) { bad('price', r.price ? `“${r.price}” is not a price` : 'Price is missing'); skipped++; return; }
    const cost = r.cost ? parseNairaToKobo(r.cost) : null;
    if (r.cost && cost === null) bad('cost', `“${r.cost}” is not a price (cost left empty)`);
    let stock: number | undefined;
    if (r.stock) {
      const n = Number(r.stock.replace(/[,\s]/g, ''));
      if (!Number.isInteger(n) || n < 0) bad('stock', `“${r.stock}” is not a whole number (stock left at 0)`);
      else stock = n;
    }
    const barcode = (r.barcode ?? '').replace(/\s/g, '');
    if (barcode && !/^\d{8,14}$/.test(barcode)) bad('barcode', `“${r.barcode}” is not 8–14 digits (barcode left empty)`);
    const packSize = r.pack_size ? Number(r.pack_size.replace(/[,\s]/g, '')) : null;
    if (r.pack_size && (!Number.isInteger(packSize) || packSize! < 2)) bad('pack_size', `“${r.pack_size}” is not a pack size of 2 or more`);

    const colour = r.colour ? title(r.colour) : null;
    const size = r.size?.trim() || null;
    const key = `${name.toLowerCase()}|${(r.category ?? '').trim().toLowerCase()}`;
    let g = groups.get(key);
    if (!g) {
      const packs = packSize && Number.isInteger(packSize) && packSize >= 2 ? [{ unit: (r.pack_unit || 'carton').trim().toLowerCase(), factor: packSize }] : [];
      g = {
        input: {
          name, description: (r.description ?? '').trim(), category: r.category?.trim() || null, brand: null,
          base_unit: (r.unit || opts.defaultUnit || 'piece').trim().toLowerCase(), packs, status: opts.status, source: opts.source, variants: [],
        },
        seen: new Set(),
      };
      groups.set(key, g);
    }
    const vkey = `${(colour ?? '').toLowerCase()}|${(size ?? '').toLowerCase()}`;
    if (g.seen.has(vkey)) { bad('row', `Same colour/size as an earlier row for “${name}” (skipped)`); skipped++; return; }
    if (g.input.variants.length >= 100) { bad('row', `More than 100 colours/sizes for “${name}” (skipped)`); skipped++; return; }
    g.seen.add(vkey);
    g.input.variants.push({
      colour, colour_hex: colourHex(colour), size, sku: r.sku?.trim() || null, barcode: barcode && /^\d{8,14}$/.test(barcode) ? barcode : null,
      retail_price_kobo: price, cost_kobo: cost, opening_stock: stock, image_path: null,
    });
    used++;
  });
  return { products: [...groups.values()].map((g) => g.input), issues, rowsUsed: used, rowsSkipped: skipped };
}

// ---------------------------------------------------------------- pasted lists

const COLOUR_WORDS = Object.keys(COLOURS).sort((a, b) => b.length - a.length);
// Prices marked with ₦/N/NGN or "k" win; otherwise the last plain number of 4+ digits (codes tend to come first).
const MARKED_PRICE = [/(?:₦|\bN|\bngn\s?)\s?\d[\d,]*(?:\.\d+)?k?\b/i, /\b\d[\d,]*(?:\.\d+)?k\b/i];
const PLAIN_PRICE = /\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{4,}\b/g;
function findPrice(s: string): { index: number; text: string } | null {
  for (const re of MARKED_PRICE) { const m = re.exec(s); if (m) return { index: m.index, text: m[0] }; }
  const all = [...s.matchAll(PLAIN_PRICE)];
  const last = all[all.length - 1];
  return last ? { index: last.index!, text: last[0] } : null;
}
const QTY_RES = [
  /\bx\s?(\d+)\b/i, /\b(\d+)\s?x\b(?!\s?\d)/i,
  /\bqty\.?\s*:?\s*(\d+)/i, /\b(\d+)\s*(?:pcs|pieces|pcs\.|units|left|in stock|yards|yds|bundles|cartons|rolls|pairs)\b/i, /\((\d+)\)/,
];

/**
 * One product per line, the way traders type them on WhatsApp:
 *   "1. Ankara wax print red - ₦12,500 x 30"   "Lace (gold) 45k qty 10"   "Chiffon blue 8,500 (20 pcs)"
 * Name, optional colour, price and quantity are picked out; anything unreadable is reported.
 */
export function parseTextList(text: string): { rows: ImportRow[]; lines: number[]; issues: RowIssue[] } {
  const rows: ImportRow[] = [];
  const lines: number[] = [];
  const issues: RowIssue[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    let s = raw.replace(/^\s*(?:[-*•▪◦]|\d{1,3}[.)])\s*/, '').replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ').trim();
    if (!s) return;
    let stock: string | undefined;
    for (const re of QTY_RES) {
      const m = re.exec(s);
      if (m) { stock = m[1]; s = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).trim(); break; }
    }
    const pm = findPrice(s);
    if (!pm) { issues.push({ row: i + 1, field: 'price', message: `No price found in “${raw.trim()}”` }); return; }
    const price = pm.text;
    s = (s.slice(0, pm.index) + ' ' + s.slice(pm.index + pm.text.length)).replace(/\b(?:at|@|for|price|each|per piece|per yard)\b/gi, ' ');
    let colour: string | undefined;
    const paren = /\(([^)]+)\)/.exec(s);
    if (paren && COLOUR_WORDS.includes(paren[1]!.trim().toLowerCase())) { colour = paren[1]!.trim(); s = s.replace(paren[0], ' '); }
    if (!colour) {
      const lower = ` ${s.toLowerCase()} `;
      const hit = COLOUR_WORDS.find((c) => lower.includes(` ${c} `));
      if (hit) { colour = hit; s = s.replace(new RegExp(`\\b${hit}\\b`, 'i'), ' '); }
    }
    const name = title(s.replace(/\(\s*\)|\[\s*\]/g, ' ').replace(/(^|\s)[-–—:|=]+(?=\s|$)/g, ' ').replace(/[,;|]+/g, ' ').replace(/\s+/g, ' ').trim());
    if (!name) { issues.push({ row: i + 1, field: 'name', message: `No product name found in “${raw.trim()}”` }); return; }
    rows.push({ name, price, stock, colour: colour ? title(colour) : undefined });
    lines.push(i + 1);
  });
  return { rows, lines, issues };
}

/** CSV template offered for download on the import page. */
export const IMPORT_TEMPLATE = [
  'name,category,colour,size,price,cost,stock,sku,barcode,unit,pack_unit,pack_size,description',
  'Hollandais wax print,Ankara,Red,6 yards,15000,11000,30,ANK-001,,piece,bundle,6,Real wax. Colourfast.',
  'Hollandais wax print,Ankara,Blue,6 yards,15000,11000,12,ANK-002,,piece,bundle,6,',
  'Swiss voile lace,Lace,Gold,5 yards,45000,32000,10,LAC-001,,piece,,,Heavy beaded voile',
].join('\n');
