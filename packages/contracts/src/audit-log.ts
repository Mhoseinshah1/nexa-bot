import { z } from 'zod';
import { ACTOR_TYPES, SOURCE_SURFACES } from './actor.js';
import { uuidV7Schema } from './ids.js';
import { AUDIT_RESULTS } from './ports.js';
import type { PermissionKey } from './permissions.js';
import { isStorableInstant } from './time.js';

/**
 * The Web Admin's audit log browser (Phase D1, `docs/audit-log.md`).
 *
 * A READER over `audit_logs`, which stays exactly what it was: append-only, written inside
 * the business transaction, redacted at write time. Nothing here adds a column, rewrites a
 * row or derives a value an old row did not record. A row that has no `before`/`after`
 * shows none; a row whose entity is not a customer, order, payment or service links nowhere.
 *
 * Tenant-isolated by the session's tenant, never by a parameter: rows recorded with no
 * tenant (installation-wide work) are not part of any tenant's log.
 */

export const AUDIT_LOG_ROUTES = {
  list: '/audit-log',
  export: '/audit-log/export',
} as const;

export const AUDIT_LOG_PAGE_DEFAULT = 50;
export const AUDIT_LOG_PAGE_MAX = 100;
/**
 * The most rows one export file may hold. An export that would hold more is REFUSED with a
 * request to narrow the filter, never cut short: a truncated audit file is a file whose
 * silence about the rest reads as "nothing else happened" — the WP12 export's rule.
 */
export const AUDIT_LOG_EXPORT_ROW_MAX = 10_000;

/**
 * The three security-sensitive slices an operator can ask for.
 *
 * - `DENIED` — every row recorded with `result = 'DENIED'`: a permission refusal the
 *   service audited (the guard's own denials are operational events, on `/alerts`).
 * - `AUTH` — authentication: every `auth.*` action, and an administrator changing their
 *   own password.
 * - `CRITICAL` — an action that is ONLY reachable through a CRITICAL permission, by the
 *   table below.
 */
export const AUDIT_SECURITY_FILTERS = ['DENIED', 'AUTH', 'CRITICAL'] as const;
export type AuditSecurityFilter = (typeof AUDIT_SECURITY_FILTERS)[number];

export const AUDIT_AUTH_ACTION_PREFIX = 'auth.';
/** Authentication events that do not carry the `auth.` prefix. */
export const AUDIT_AUTH_ACTIONS: readonly string[] = ['admin.password_change'];

/**
 * The audit actions whose every successful row was charged on a CRITICAL permission, and
 * that permission (`permissions.ts`).
 *
 * Each pair was read off the service that writes the action, not inferred from its name —
 * see `docs/audit-log.md`. An action whose permission depends on a value the row may not
 * carry is NOT here: `wallet.credit` is CRITICAL only above the large-amount threshold, so
 * listing it would call ordinary credits critical. `bulk.create` is here because BOTH of
 * its kinds are charged on a CRITICAL key. `tests/unit/audit-log-contract.test.ts` holds
 * every value to `riskLevel === 'CRITICAL'`, so a permission downgraded later takes its
 * actions out of this filter loudly rather than leaving them labelled critical.
 */
export const AUDIT_CRITICAL_ACTIONS: Readonly<Record<string, readonly PermissionKey[]>> = {
  'customer.account_transfer': ['users.transfer'],
  'wallet.debit': ['users.wallet.debit'],
  'bulk.create': ['users.wallet.mass', 'services.mass.grant'],
  'payment_account.create': ['payments.accounts.edit'],
  'payment_account.update': ['payments.accounts.edit'],
  'payment_account.set_enabled': ['payments.accounts.edit'],
  'payment_account.set_default': ['payments.accounts.edit'],
  'refund.request': ['refunds.issue'],
  'refund.complete': ['refunds.issue'],
  'refund.fail': ['refunds.issue'],
  'panel.credentials.replace': ['panels.credentials.rotate'],
  'admin.create': ['admins.edit'],
  'admin.status_change': ['admins.edit'],
  'admin.roles_change': ['admins.edit'],
  'admin.telegram_binding': ['admins.edit'],
  'admin.password_reset': ['admins.edit'],
  'admin.sessions_revoked': ['admins.edit'],
  'backup.download': ['backup.download'],
  'backup.archive_downloaded': ['backup.download'],
  'recovery.confirm': ['recovery.restore'],
  'recovery.confirmed': ['recovery.restore'],
  'recovery_kit.exported': ['recovery.kit.export'],
  'recovery_kit.imported': ['recovery.kit.import'],
  'installation_key.removed': ['recovery.key.remove'],
};

export const AUDIT_CRITICAL_ACTION_CODES: readonly string[] = Object.keys(AUDIT_CRITICAL_ACTIONS);

/**
 * Which security slices one row belongs to. The SAME rule the server's filter applies in
 * SQL (`drizzle-audit-history.reader.ts`), stated once here so the badge on a row and the
 * filter that found it cannot disagree.
 */
export function auditSecurityClasses(row: {
  readonly action: string;
  readonly result: string;
}): AuditSecurityFilter[] {
  const classes: AuditSecurityFilter[] = [];
  if (row.result === 'DENIED') classes.push('DENIED');
  if (row.action.startsWith(AUDIT_AUTH_ACTION_PREFIX) || AUDIT_AUTH_ACTIONS.includes(row.action)) {
    classes.push('AUTH');
  }
  if (Object.hasOwn(AUDIT_CRITICAL_ACTIONS, row.action)) classes.push('CRITICAL');
  return classes;
}

const instant = z.iso
  .datetime()
  .refine((v) => isStorableInstant(new Date(v)), { message: 'must be a storable instant' });

/**
 * An action filter: an exact code (`payment.confirm`) or a family ending in a dot
 * (`payment.`). Machine codes only — lowercase, digits, `_` and `.` — so the prefix needs
 * no LIKE escaping beyond `_`, which the reader escapes.
 */
export const auditActionFilterSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9_.]+$/u, 'must be an action code or a family ending in a dot');

/** An entity type as the writers spell it: `Customer`, `ServiceRefundRequest`. */
export const auditEntityTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/u, 'must be an entity type');

/**
 * The filters, shared by the list and the export so the file holds exactly the rows the
 * page showed. Every filter is ANDed. `from`/`to` bound `occurredAt` as `[from, to)`.
 *
 * `actor` is an administrator's id or their CURRENT username (with or without `@`); the
 * server resolves a username to the id inside the tenant, so a renamed administrator's
 * earlier rows are found too. Any other string matches the stored `actor_id` exactly —
 * which is how a `SYSTEM_JOB`'s rows are found from a row's own actor link.
 */
const auditLogFilterShape = {
  actor: z.string().trim().min(1).max(128).optional(),
  actorType: z.enum(ACTOR_TYPES).optional(),
  customerId: uuidV7Schema.optional(),
  action: auditActionFilterSchema.optional(),
  entityType: auditEntityTypeSchema.optional(),
  entityId: z.string().trim().min(1).max(128).optional(),
  result: z.enum(AUDIT_RESULTS).optional(),
  security: z.enum(AUDIT_SECURITY_FILTERS).optional(),
  from: instant.optional(),
  to: instant.optional(),
};

type FilterShape = {
  readonly entityType?: string | undefined;
  readonly entityId?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
};

/** An entity id names nothing without its type; the index leads with the type too. */
const entityIdNeedsType = (query: FilterShape) =>
  query.entityId === undefined || query.entityType !== undefined;
const orderedRange = (query: FilterShape) =>
  query.from === undefined ||
  query.to === undefined ||
  new Date(query.from).getTime() < new Date(query.to).getTime();

export const auditLogListQuerySchema = z
  .object({
    ...auditLogFilterShape,
    limit: z.coerce.number().int().positive().max(AUDIT_LOG_PAGE_MAX).optional(),
    /** Opaque; a cursor this server did not mint is a 400, never page one. */
    cursor: z.string().max(512).optional(),
  })
  .refine(entityIdNeedsType, { message: 'entityId needs entityType.', path: ['entityId'] })
  .refine(orderedRange, { message: 'from must be before to.', path: ['to'] });
export type AuditLogListQuery = z.infer<typeof auditLogListQuerySchema>;

export const AUDIT_LOG_EXPORT_FORMATS = ['csv'] as const;

export const auditLogExportQuerySchema = z
  .object({ ...auditLogFilterShape, format: z.enum(AUDIT_LOG_EXPORT_FORMATS).default('csv') })
  .refine(entityIdNeedsType, { message: 'entityId needs entityType.', path: ['entityId'] })
  .refine(orderedRange, { message: 'from must be before to.', path: ['to'] });
export type AuditLogExportQuery = z.infer<typeof auditLogExportQuerySchema>;

/**
 * Where a row leads, decided by the server from the row's own entity — and, for an order,
 * payment or service, the customer that entity belongs to NOW (ownership can move by an
 * account transfer; the link is navigation, not a recorded fact). Absent when the row's
 * entity is none of these, or its id is not one this installation issues.
 */
export const auditLogLinksSchema = z.object({
  customerId: z.string().nullable(),
  orderId: z.string().nullable(),
  paymentId: z.string().nullable(),
  serviceId: z.string().nullable(),
});
export type AuditLogLinks = z.infer<typeof auditLogLinksSchema>;

export const auditLogEntrySchema = z.object({
  id: z.string(),
  occurredAt: z.iso.datetime(),
  actorType: z.enum(ACTOR_TYPES),
  actorId: z.string().nullable(),
  /** Captured when the action happened, so it survives a rename. */
  actorLabel: z.string().nullable(),
  surface: z.enum(SOURCE_SURFACES),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  result: z.enum(AUDIT_RESULTS),
  reason: z.string().nullable(),
  correlationId: z.string(),
  /**
   * As stored, redacted again on the way out. Null when the row recorded none or recorded
   * something that is not an object — never reconstructed.
   */
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  security: z.array(z.enum(AUDIT_SECURITY_FILTERS)),
  links: auditLogLinksSchema,
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

export const auditLogListResponseSchema = z.object({
  entries: z.array(auditLogEntrySchema),
  nextCursor: z.string().nullable(),
});
export type AuditLogListResponse = z.infer<typeof auditLogListResponseSchema>;
