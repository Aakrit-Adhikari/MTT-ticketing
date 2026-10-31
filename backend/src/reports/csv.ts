/**
 * Minimal, safe CSV writer.
 *  - Quotes every field and doubles embedded quotes.
 *  - Neutralises spreadsheet formula injection: a customer-controlled value such as "=HYPERLINK(...)" would
 *    otherwise run as a formula when staff open the file in Excel. Such cells are prefixed with an apostrophe.
 *  - Leading BOM so Excel reads UTF-8 (Nepali names) correctly.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (FORMULA_START.test(s) && !/^[+-]?\d+([.,]\d+)*$/.test(s)) s = `'${s}`; // plain numbers (e.g. -5.00) stay numbers
  return `"${s.replace(/"/g, '""')}"`;
};

export function toCsv<T>(columns: { header: string; value: (row: T) => unknown }[], rows: T[]): string {
  const lines = [columns.map((c) => csvCell(c.header)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(c.value(r))).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export const nepalText = (d: Date | null | undefined): string =>
  d ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kathmandu', dateStyle: 'short', timeStyle: 'short' }).format(d) : '';
