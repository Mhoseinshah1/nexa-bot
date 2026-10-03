/**
 * The Persian column headers of the audit log export (Phase D1, `docs/audit-log.md`).
 *
 * In the shared catalogue for the reason `reports.fa.ts` gives: an export file is a surface,
 * and a surface carries no Persian literals. The ORDER of this object is the column order of
 * the file, and the API builds each row from the same keys.
 */
export const AUDIT_EXPORT_HEADERS_FA = {
  occurredAt: 'زمان (UTC)',
  actorType: 'نوع انجام‌دهنده',
  actorLabel: 'انجام‌دهنده',
  actorId: 'شناسه انجام‌دهنده',
  surface: 'مسیر',
  action: 'عملیات',
  entityType: 'نوع موجودیت',
  entityId: 'شناسه موجودیت',
  result: 'نتیجه',
  security: 'حساسیت امنیتی',
  reason: 'دلیل',
  before: 'پیش از تغییر',
  after: 'پس از تغییر',
  correlationId: 'شناسه پیگیری',
  id: 'شناسه رکورد',
} as const;

export type AuditExportHeaderKey = keyof typeof AUDIT_EXPORT_HEADERS_FA;
