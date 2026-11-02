/**
 * CSV for spreadsheet downloads. Every cell is quoted; text that a spreadsheet would run as a
 * formula (=, +, -, @, tab, CR) gets a leading apostrophe, so a product or customer name like
 * "=HYPERLINK(...)" can never execute in Excel/Sheets. Numbers stay numbers.
 */
export type CsvValue = string | number | boolean | null | undefined;
export interface CsvColumn<T> { header: string; value: (row: T) => CsvValue }

function cell(v: CsvValue): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((c) => cell(c.header)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(c.value(r))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`; // BOM: Excel opens UTF-8 (₦, names) correctly
}

/** Kobo → naira as a plain number for spreadsheets (2 decimals). */
export const naira = (kobo: number | null | undefined): number | null => (kobo == null ? null : Math.round(kobo) / 100);
