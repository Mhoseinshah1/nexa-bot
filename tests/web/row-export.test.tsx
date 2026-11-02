import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  CSV_EXPORT_MAX_ROWS,
  RowExportBar,
  csvCell,
  selectColumn,
  toCsv,
  useRowSelection,
} from '../../apps/web/src/ui/row-export';
import { t } from '../../apps/web/src/i18n/web.fa';

/**
 * R12 F3 item 8 — row selection and the CSV export. The file carries exactly the columns a
 * list names, is capped, is not drawn for a viewer whose list is denied, and neutralises a
 * spreadsheet formula in attacker-controlled text.
 */

interface Row {
  readonly id: string;
  readonly name: string;
}
const columns = [
  { header: 'id', value: (row: Row) => row.id },
  { header: 'name', value: (row: Row) => row.name },
];
const keyOf = (row: Row) => row.id;

describe('toCsv', () => {
  it('quotes commas, quotes and line breaks, and writes a BOM and CRLF', () => {
    const csv = toCsv(
      [
        { id: '1', name: 'a,b' },
        { id: '2', name: 'say "hi"' },
        { id: '3', name: 'two\nlines' },
      ],
      columns,
    );
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toBe('\uFEFFid,name\r\n1,"a,b"\r\n2,"say ""hi"""\r\n3,"two\nlines"\r\n');
  });

  it('defangs a cell a spreadsheet would run as a formula', () => {
    for (const hostile of ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tx']) {
      expect(csvCell(hostile), hostile).toBe(`'${hostile}`);
    }
    expect(csvCell('علی')).toBe('علی');
    expect(csvCell('@')).toBe("'@");
  });
});

function Harness({ rows, allowed }: { rows: readonly Row[]; allowed: boolean }) {
  const selection = useRowSelection(rows, keyOf);
  return (
    <>
      <RowExportBar selection={selection} columns={columns} filename="list" allowed={allowed} />
      {rows.slice(0, 5).map((row) => (
        <label key={row.id}>
          {selectColumn(selection, keyOf).render(row)}
          {row.name}
        </label>
      ))}
    </>
  );
}

describe('the export bar', () => {
  const rows = Array.from({ length: 300 }, (_, n) => ({ id: String(n), name: `n${String(n)}` }));

  it('is not drawn when the list is denied or empty', () => {
    const { container, rerender } = render(<Harness rows={rows} allowed={false} />);
    expect(container.querySelector('.row-export-bar')).toBeNull();
    rerender(<Harness rows={[]} allowed />);
    expect(container.querySelector('.row-export-bar')).toBeNull();
  });

  it('exports only the ticked rows, and never more than the cap', () => {
    const created: string[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (blob: Blob) => {
        created.push(String(blob.size));
        return 'blob:test';
      },
      revokeObjectURL: () => undefined,
    });
    const clicked: string[] = [];
    const original = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      clicked.push(this.download);
    };
    render(<Harness rows={rows} allowed />);
    const exportButton = screen.getByRole('button', { name: t('web.export_csv') });
    expect((exportButton as HTMLButtonElement).disabled).toBe(true);
    // Select the whole page: capped at CSV_EXPORT_MAX_ROWS of the 300 shown.
    fireEvent.click(screen.getByLabelText(t('web.export_select_all')));
    expect(
      screen.getByText(`${t('web.export_selected')} ${String(CSV_EXPORT_MAX_ROWS)}`),
    ).toBeTruthy();
    expect((exportButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(exportButton);
    expect(clicked).toEqual(['list.csv']);
    expect(created).toHaveLength(1);
    HTMLAnchorElement.prototype.click = original;
    vi.unstubAllGlobals();
  });
});
