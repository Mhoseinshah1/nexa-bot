import type { ExportColumnKind } from '../application/data-export-inventory.js';

/** The UTF-8 byte order mark: what makes a spreadsheet open the file as UTF-8, Persian intact. */
export const UTF8_BOM = String.fromCharCode(0xfeff);

/**
 * A text cell that starts with `= + - @` or a control character would run as a formula when a
 * spreadsheet opens the file (`=HYPERLINK(...)` in a customer's Telegram first name is
 * somebody else's code in the owner's Excel). Such a cell is written with a leading `'`.
 * Only TEXT cells are guarded: a negative balance must stay a number.
 */
export function guardFormula(text: string): string {
  return /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text;
}

/** RFC 4180 quoting: a field with a comma, a quote or a line break is quoted, quotes doubled. */
export function csvField(text: string): string {
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** One cell: `null` is an empty field; only `text` cells are formula-guarded. */
export function csvCell(kind: ExportColumnKind, value: string | null): string {
  if (value === null) return '';
  return csvField(kind === 'text' ? guardFormula(value) : value);
}

/** One CSV record, CRLF-terminated (RFC 4180). */
export function csvLine(cells: readonly string[]): string {
  return `${cells.join(',')}\r\n`;
}
