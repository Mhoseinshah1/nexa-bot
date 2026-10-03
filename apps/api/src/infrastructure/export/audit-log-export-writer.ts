import { AUDIT_EXPORT_HEADERS_FA } from '@nexa/i18n';
import {
  AUDIT_EXPORT_COLUMNS,
  type AuditExportColumn,
  type AuditLogExportWriter,
} from '../../modules/platform/audit/application/ports.js';
import { textCsv } from './report-export-writer.js';

/**
 * The audit log export file (Phase D1). Every cell is text, formula-guarded, through the one
 * CSV writer this installation has. The header catalogue must name every column — the
 * `satisfies` is what turns a missing header into a compile error rather than a blank cell.
 */
const HEADERS = AUDIT_EXPORT_HEADERS_FA satisfies Readonly<Record<AuditExportColumn, string>>;

export class DefaultAuditLogExportWriter implements AuditLogExportWriter {
  csv(rows: readonly Readonly<Record<AuditExportColumn, string>>[]): Uint8Array {
    return textCsv(
      AUDIT_EXPORT_COLUMNS.map((column) => HEADERS[column]),
      rows.map((row) => AUDIT_EXPORT_COLUMNS.map((column) => row[column])),
    );
  }
}
