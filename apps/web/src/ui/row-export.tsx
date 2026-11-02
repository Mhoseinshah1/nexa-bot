import { useMemo, useState } from 'react';
import { t } from '../i18n/web.fa';
import { Button, type Column } from './kit';

/**
 * R12 F3 item 8: row selection and a CSV export on the users, orders and payments lists.
 *
 * What it is: the rows the operator has ALREADY been shown, the ones they ticked, written as a
 * CSV in the browser. So it is permission-checked by construction — the rows came from a list
 * the server only answered because the viewer holds its `*.view` permission, the export is drawn
 * only while that list is readable (`allowed`), and it carries exactly the fields the list's
 * columns show (each page names them) — no secret, and no PII the list did not already print.
 * It is capped: at most `CSV_EXPORT_MAX_ROWS` rows leave in one file.
 *
 * What it is not: an export of the whole filtered list. That would be a server operation with a
 * counted preview, an audit row and its own permission; it is recorded in the round's open
 * questions and not built here.
 */
export const CSV_EXPORT_MAX_ROWS = 200;

export interface ExportColumn<T> {
  readonly header: string;
  /** The cell's text — what the list's column prints, as plain text. */
  readonly value: (row: T) => string;
}

/**
 * One CSV cell: quoted when it holds a comma, quote or line break, and defanged when a
 * spreadsheet would read it as a formula (`= + - @`, tab or carriage return) — a customer's
 * display name is attacker-controlled text that an operator opens in Excel.
 */
export function csvCell(value: string): string {
  const defanged = /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
  return /[",\r\n]/u.test(defanged) ? `"${defanged.replaceAll('"', '""')}"` : defanged;
}

export function toCsv<T>(rows: readonly T[], columns: readonly ExportColumn<T>[]): string {
  const lines = [
    columns.map((column) => csvCell(column.header)).join(','),
    ...rows.map((row) => columns.map((column) => csvCell(column.value(row))).join(',')),
  ];
  // A BOM so Excel reads the Persian as UTF-8; CRLF as RFC 4180 writes it.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export interface RowSelection<T> {
  readonly selected: ReadonlySet<string>;
  readonly rows: readonly T[];
  readonly chosen: readonly T[];
  toggle(key: string): void;
  /** Ticks every row of the page (up to the cap), or clears them when all are ticked. */
  toggleAll(): void;
  clear(): void;
}

/** The ticked rows of the CURRENT page: a page turn forgets the ticks of rows no longer shown. */
export function useRowSelection<T>(rows: readonly T[], keyOf: (row: T) => string): RowSelection<T> {
  const [raw, setRaw] = useState<ReadonlySet<string>>(new Set());
  const shown = useMemo(() => new Set(rows.map(keyOf)), [rows, keyOf]);
  const selected = useMemo(() => new Set([...raw].filter((key) => shown.has(key))), [raw, shown]);
  return {
    selected,
    rows,
    chosen: rows.filter((row) => selected.has(keyOf(row))).slice(0, CSV_EXPORT_MAX_ROWS),
    toggle: (key) =>
      setRaw((current) => {
        const next = new Set([...current].filter((one) => shown.has(one)));
        if (next.has(key)) next.delete(key);
        else if (next.size < CSV_EXPORT_MAX_ROWS) next.add(key);
        return next;
      }),
    toggleAll: () =>
      setRaw(() =>
        selected.size === Math.min(rows.length, CSV_EXPORT_MAX_ROWS)
          ? new Set()
          : new Set(rows.slice(0, CSV_EXPORT_MAX_ROWS).map(keyOf)),
      ),
    clear: () => setRaw(new Set()),
  };
}

/** The row's tick, drawn as the list's last column so the first column stays the row's title. */
export function selectColumn<T>(selection: RowSelection<T>, keyOf: (row: T) => string): Column<T> {
  return {
    key: 'select',
    header: t('web.export_select'),
    render: (row) => {
      const key = keyOf(row);
      return (
        <input
          type="checkbox"
          aria-label={t('web.export_select_row')}
          checked={selection.selected.has(key)}
          onChange={() => selection.toggle(key)}
        />
      );
    },
  };
}

/** Starts the browser's download of `text` as a UTF-8 CSV file. */
export function downloadCsv(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/**
 * The bar above a selectable list: select the page, how many are ticked, and the export. Not
 * drawn at all unless the list is readable (`allowed`) and has rows.
 */
export function RowExportBar<T>({
  selection,
  columns,
  filename,
  allowed,
}: {
  selection: RowSelection<T>;
  columns: readonly ExportColumn<T>[];
  /** The file's name without its extension. */
  filename: string;
  /** The list's own view permission, held — the same gate that lets the list answer at all. */
  allowed: boolean;
}) {
  if (!allowed || selection.rows.length === 0) return null;
  const count = selection.chosen.length;
  return (
    <div className="row-export-bar" role="group" aria-label={t('web.export_bar')}>
      <label className="check">
        <input
          type="checkbox"
          checked={count > 0 && count === Math.min(selection.rows.length, CSV_EXPORT_MAX_ROWS)}
          onChange={selection.toggleAll}
        />
        <span>{t('web.export_select_all')}</span>
      </label>
      <span className="muted small" aria-live="polite">
        {t('web.export_selected')} {count}
      </span>
      <Button
        size="sm"
        disabled={count === 0}
        onClick={() => downloadCsv(`${filename}.csv`, toCsv(selection.chosen, columns))}
      >
        {t('web.export_csv')}
      </Button>
      <span className="muted small">
        {t('web.export_cap')} {CSV_EXPORT_MAX_ROWS}
      </span>
    </div>
  );
}
