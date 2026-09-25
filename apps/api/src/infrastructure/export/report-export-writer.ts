import { crc32, deflateRawSync } from 'node:zlib';
import { CURRENCY_EXPONENT } from '@nexa/contracts';
import { REPORT_EXPORT_HEADERS_FA, REPORT_EXPORT_SHEETS_FA } from '@nexa/i18n';
import type {
  ExportCell,
  ExportColumn,
  ExportColumnKey,
  ExportTable,
  ReportExportWriter,
} from '../../modules/commerce/reporting/application/ports.js';

/**
 * WP12's two export formats, written on the server (`docs/wp12-business-analytics-audit.md` §8).
 *
 * No spreadsheet dependency: a CSV is text, and an XLSX is a ZIP of five small XML parts
 * that OOXML specifies exactly. `zlib` supplies both the compression and the CRC-32, so
 * nothing here implements a codec. Both writers are deterministic — the same table gives
 * the same bytes — which is what lets a test pin them.
 */
export class DefaultReportExportWriter implements ReportExportWriter {
  csv(table: ExportTable): Uint8Array {
    const lines = [
      table.columns.map((c) => csvField(headerOf(c.key))).join(','),
      ...table.rows.map((row) =>
        table.columns
          .map((column) => csvField(cellText(column, row[column.key] ?? null)))
          .join(','),
      ),
    ];
    // A BOM, so a spreadsheet opens the file as UTF-8 and the Persian headers survive;
    // CRLF, as RFC 4180 specifies.
    return Buffer.from(`${BOM}${lines.join('\r\n')}\r\n`, 'utf8');
  }

  xlsx(table: ExportTable): Uint8Array {
    return zip([
      ['[Content_Types].xml', CONTENT_TYPES],
      ['_rels/.rels', ROOT_RELS],
      ['xl/workbook.xml', workbook(REPORT_EXPORT_SHEETS_FA[table.report])],
      ['xl/_rels/workbook.xml.rels', WORKBOOK_RELS],
      ['xl/styles.xml', STYLES],
      ['xl/worksheets/sheet1.xml', sheet(table)],
    ]);
  }
}

const BOM = String.fromCharCode(0xfeff);

/**
 * The Persian header of a column. Every key in `REPORT_EXPORT_COLUMN_KEYS` has one — a test
 * holds the catalogue to the list — so the fallback to the key is unreachable in practice
 * and exists only so a gap would show as an English key rather than an empty heading.
 */
export function headerOf(key: ExportColumnKey): string {
  return (REPORT_EXPORT_HEADERS_FA as Readonly<Record<string, string>>)[key] ?? key;
}

// --- Cells ------------------------------------------------------------------------

/**
 * The exact text of a cell. Money is scaled by its OWN currency's exponent on the digits,
 * never through a float, so `1500000` Toman stays `1500000` and `1234` USD cents is `12.34`.
 */
export function cellText(column: ExportColumn, cell: ExportCell): string {
  if (cell === null) return '';
  if (typeof cell === 'object')
    return minorToDecimal(cell.amountMinor, CURRENCY_EXPONENT[cell.currency]);
  if (column.kind === 'text') return guardFormula(String(cell));
  return String(cell);
}

function minorToDecimal(minor: bigint, exponent: number): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(exponent + 1, '0');
  const whole = exponent === 0 ? digits : digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? '' : digits.slice(digits.length - exponent);
  return `${negative ? '-' : ''}${whole}${fraction === '' ? '' : `.${fraction}`}`;
}

/**
 * A TEXT cell that a spreadsheet would read as a formula is prefixed with `'`.
 *
 * A product title or a route code is operator-entered text, and `=HYPERLINK(...)` in one
 * would run when the owner opens the file. Numeric cells are written raw — a negative
 * balance must stay a number — so only text is guarded.
 */
function guardFormula(text: string): string {
  return /^[=+\-@\t\r]/u.test(text) ? `'${text}` : text;
}

function csvField(text: string): string {
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

// --- OOXML ------------------------------------------------------------------------

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const CONTENT_TYPES = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

const ROOT_RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

const WORKBOOK_RELS = `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

/** One font, one fill pair, one border, and two cell formats: plain, and the bold header. */
const STYLES = `${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;

function workbook(sheetName: string): string {
  // Excel's own limits on a sheet name: 31 characters and none of `[]:*?/\`.
  const name = sheetName.replaceAll(/[[\]:*?/\\]/gu, ' ').slice(0, 31) || 'Report';
  return `${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
}

function sheet(table: ExportTable): string {
  const header = table.columns
    .map((column, c) => inlineString(ref(c, 1), headerOf(column.key), 1))
    .join('');
  const body = table.rows
    .map((row, r) => {
      const cells = table.columns
        .map((column, c) => {
          const cell = row[column.key] ?? null;
          if (cell === null) return '';
          const at = ref(c, r + 2);
          // A NUMERIC cell for counts, bytes and money: `<v>` holds the exact decimal text.
          if (column.kind !== 'text' && typeof cell !== 'string') {
            return `<c r="${at}"><v>${cellText(column, cell)}</v></c>`;
          }
          return inlineString(at, cellText(column, cell), 0);
        })
        .join('');
      return `<row r="${r + 2}">${cells}</row>`;
    })
    .join('');
  // Right to left, because the headers are Persian and the owner reads them that way.
  return `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" rightToLeft="1"/></sheetViews><sheetData><row r="1">${header}</row>${body}</sheetData></worksheet>`;
}

function inlineString(at: string, text: string, style: number): string {
  return `<c r="${at}" t="inlineStr"${style === 0 ? '' : ` s="${style}"`}><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
}

/** `A1`-style reference; column index is 0-based, row 1-based. */
function ref(column: number, row: number): string {
  let name = '';
  for (let n = column + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return `${name}${row}`;
}

function xmlEscape(text: string): string {
  return (
    text
      // Characters XML 1.0 cannot carry at all are dropped rather than escaped.
      // eslint-disable-next-line no-control-regex
      .replaceAll(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/gu, '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
  );
}

// --- ZIP --------------------------------------------------------------------------

/**
 * A ZIP archive of deflated entries, per APPNOTE: a local header and data per entry, a
 * central directory, and the end record. Every timestamp is the DOS epoch (1980-01-01),
 * so the archive's bytes depend only on its contents.
 */
function zip(entries: readonly (readonly [string, string])[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = (1 << 5) | 1; // 1980-01-01

  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const packed = deflateRawSync(data);
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(0, 38); // external attributes
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + packed.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, directory, end]);
}
