import {
  AUDIT_LOG_EXPORT_ROW_MAX,
  AUDIT_LOG_PAGE_DEFAULT,
  auditSecurityClasses,
  CONTROL_ERROR_CODES,
  errors,
  type ActorContext,
  type ActorType,
  type AuditLogEntry,
  type AuditLogLinks,
  type AuditResult,
  type AuditSecurityFilter,
  type AuditWriter,
  type Clock,
  type OperationalEventRecorder,
  type TenantContext,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import { recordMutationDenial } from '../../access/application/authorized-mutation.js';
import {
  AUDIT_EXPORT_PERMISSION,
  AUDIT_VIEW_PERMISSION,
  type AuditExportColumn,
  type AuditLogExportWriter,
  type AuditLogFilter,
  type AuditLogPosition,
  type AuditLogReader,
  type AuditLogRecord,
} from './ports.js';

/**
 * The audit log browser (Phase D1, program §16, `docs/audit-log.md`).
 *
 * Read-only over `audit_logs`, which keeps every property it had: append-only by trigger,
 * written inside the business transaction, redacted at write time. This adds a way to READ
 * it — filtered, keyset-paged, tenant-isolated — and a way to take the same rows away as a
 * file, which is itself audited.
 *
 * Authority is charged HERE, before anything is read: `audit.view` for the list, and
 * `audit.export` on top for the file. The Web Admin hiding a button protects nothing.
 */

/** The filters as the surface parsed them (`auditLogListQuerySchema`). */
export interface AuditLogQuery {
  readonly actor?: string | undefined;
  readonly actorType?: ActorType | undefined;
  readonly customerId?: string | undefined;
  readonly action?: string | undefined;
  readonly entityType?: string | undefined;
  readonly entityId?: string | undefined;
  readonly result?: AuditResult | undefined;
  readonly security?: AuditSecurityFilter | undefined;
  /**
   * Half-open `[from, to)`, as the VALIDATED ISO text the surface received
   * (`auditLogListQuerySchema`), never a `Date`: a `Date` keeps milliseconds, so
   * `…00.000500Z` would become `…00.000Z` and the bound would move by up to 999 µs. The
   * text goes to PostgreSQL as `timestamptz`, which keeps every microsecond.
   */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export interface AuditLogPage {
  readonly entries: readonly AuditLogEntry[];
  readonly next: AuditLogPosition | null;
}

export interface AuditLogFile {
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly rows: number;
}

export interface AuditLogServiceDeps {
  readonly guard: PermissionGuard;
  readonly reader: AuditLogReader;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly writer: AuditLogExportWriter;
  readonly clock: Clock;
}

/** How many rows the export reads per statement while it walks the keyset. */
const EXPORT_BATCH = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export class AuditLogService {
  constructor(private readonly deps: AuditLogServiceDeps) {}

  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: AuditLogQuery,
    page: { readonly limit?: number | undefined; readonly after?: AuditLogPosition | undefined },
  ): Promise<AuditLogPage> {
    await this.deps.guard.check(scope, actor, AUDIT_VIEW_PERMISSION);
    const filter = await this.filterOf(scope, query);
    const limit = page.limit ?? AUDIT_LOG_PAGE_DEFAULT;
    // One past the page, so `next` is the server's answer rather than a guess from the size.
    const rows = await this.deps.reader.page(scope, filter, limit + 1, page.after ?? null);
    const shown = rows.slice(0, limit);
    const last = shown[shown.length - 1];
    return {
      entries: await this.entriesOf(scope, shown),
      next: rows.length > limit && last !== undefined ? last.position : null,
    };
  }

  /**
   * The filtered log as a CSV: exactly the rows the list would show, every page of them, in
   * the same order — the SAME filter object, read by the SAME reader. Larger than
   * `AUDIT_LOG_EXPORT_ROW_MAX` is refused rather than cut short. A successful export is
   * recorded as `audit.export` with the filter and the row count; a denied one as DENIED.
   */
  async export(
    scope: TenantContext,
    actor: ActorContext,
    query: AuditLogQuery,
  ): Promise<AuditLogFile> {
    await this.deps.guard.check(scope, actor, AUDIT_VIEW_PERMISSION);
    try {
      await this.deps.guard.check(scope, actor, AUDIT_EXPORT_PERMISSION);
    } catch (denied) {
      await recordMutationDenial(
        { guard: this.deps.guard, audit: this.deps.audit, opsLog: this.deps.opsLog },
        scope,
        actor,
        AUDIT_EXPORT_PERMISSION,
        { action: 'audit.export', entityType: 'AuditLog', entityId: null },
        denied,
      );
      throw denied;
    }
    const filter = await this.filterOf(scope, query);
    const rows: AuditLogRecord[] = [];
    let after: AuditLogPosition | null = null;
    for (;;) {
      const batch = await this.deps.reader.page(scope, filter, EXPORT_BATCH, after);
      rows.push(...batch);
      if (rows.length > AUDIT_LOG_EXPORT_ROW_MAX) {
        // A refused export is on the record too (`docs/audit-log.md`), BEFORE the refusal
        // leaves: who tried to take the log away, with which filter, and why it was refused.
        await this.deps.audit.record(scope, actor, {
          action: 'audit.export',
          entityType: 'AuditLog',
          entityId: null,
          before: null,
          after: {
            format: 'csv',
            limit: AUDIT_LOG_EXPORT_ROW_MAX,
            filter: filterRecord(query),
          },
          reason: 'EXPORT_ROW_LIMIT_EXCEEDED',
          result: 'DENIED',
        });
        throw errors.validation(
          CONTROL_ERROR_CODES.INVALID_VALUE,
          `This export has more than ${AUDIT_LOG_EXPORT_ROW_MAX} rows. Narrow the filter.`,
          { limit: AUDIT_LOG_EXPORT_ROW_MAX },
        );
      }
      const last = batch[batch.length - 1];
      if (batch.length < EXPORT_BATCH || last === undefined) break;
      after = last.position;
    }
    const bytes = this.deps.writer.csv(rows.map(exportRowOf));
    const now = this.deps.clock.now();
    await this.deps.audit.record(scope, actor, {
      action: 'audit.export',
      entityType: 'AuditLog',
      entityId: null,
      before: null,
      after: { format: 'csv', rows: rows.length, filter: filterRecord(query) },
      result: 'SUCCESS',
    });
    return {
      // Built from the clock alone — digits and dashes — so it is safe inside the header.
      fileName: `nexa-audit-log-${now.toISOString().slice(0, 19).replaceAll(':', '-')}Z.csv`,
      contentType: 'text/csv; charset=utf-8',
      bytes,
      rows: rows.length,
    };
  }

  /**
   * The parsed query as the reader's filter. `actor` is an id or a username, and is always
   * read as BOTH: resolved as a CURRENT username in this tenant AND kept as a literal
   * `actor_id`, so a system job's id typed back from a row still finds that job's rows and a
   * uuid-shaped username still finds its admin's.
   */
  private async filterOf(scope: TenantContext, query: AuditLogQuery): Promise<AuditLogFilter> {
    let actorIds: readonly string[] | undefined;
    if (query.actor !== undefined) {
      const raw = query.actor.trim();
      const username = raw.startsWith('@') ? raw.slice(1) : raw;
      const ids = username === '' ? [] : await this.deps.reader.adminIdsByUsername(scope, username);
      // A uuid is an id — lowercased, as ids are stored — AND, because a username may be
      // uuid-shaped (`adminUsernameSchema` admits `[a-z0-9._-]`), a username too. Both are
      // exact matches, ORed: neither reading may hide the other's rows.
      actorIds = [...new Set([...ids, UUID.test(raw) ? raw.toLowerCase() : raw])];
    }
    return {
      ...(actorIds === undefined ? {} : { actorIds }),
      ...(query.actorType === undefined ? {} : { actorType: query.actorType }),
      ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
      ...(query.action === undefined
        ? {}
        : {
            action: query.action.endsWith('.') ? { prefix: query.action } : { exact: query.action },
          }),
      ...(query.entityType === undefined ? {} : { entityType: query.entityType }),
      ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
      ...(query.result === undefined ? {} : { result: query.result }),
      ...(query.security === undefined ? {} : { security: query.security }),
      ...(query.from === undefined ? {} : { from: query.from }),
      ...(query.to === undefined ? {} : { to: query.to }),
    };
  }

  /** The page's rows with their security slices and their links — one read per entity kind. */
  private async entriesOf(
    scope: TenantContext,
    rows: readonly AuditLogRecord[],
  ): Promise<AuditLogEntry[]> {
    const ids = (type: string) => [
      ...new Set(
        rows
          .filter(
            (row) => row.entityType === type && row.entityId !== null && UUID.test(row.entityId),
          )
          .map((row) => (row.entityId as string).toLowerCase()),
      ),
    ];
    const owners = await this.deps.reader.ownersOf(scope, {
      // A Customer or Wallet row is the customer itself, and still links only when that
      // customer exists in this tenant — a well-formed uuid is not a customer.
      customers: [...new Set([...ids('Customer'), ...ids('Wallet')])],
      orders: ids('Order'),
      payments: ids('Payment'),
      services: ids('Service'),
    });
    return rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      actorType: row.actorType,
      actorId: row.actorId,
      actorLabel: row.actorLabel,
      surface: row.surface,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      result: row.result,
      reason: row.reason,
      correlationId: row.correlationId,
      before: row.before,
      after: row.after,
      security: auditSecurityClasses(row),
      links: linksOf(row, owners),
    }));
  }
}

/**
 * Where a row leads. Only from the row's own entity, only to an id this installation issues,
 * and only when that entity — the customer itself for a Customer or Wallet row, the order,
 * payment or service otherwise — exists in this tenant: a link is navigation and must not
 * point at something that is not there.
 */
export function linksOf(
  row: Pick<AuditLogRecord, 'entityType' | 'entityId'>,
  owners: ReadonlyMap<string, string>,
): AuditLogLinks {
  const links = { customerId: null, orderId: null, paymentId: null, serviceId: null };
  const id = row.entityId?.toLowerCase() ?? null;
  if (id === null || !UUID.test(id)) return links;
  switch (row.entityType) {
    case 'Customer':
    case 'Wallet':
      return owners.has(`Customer:${id}`) ? { ...links, customerId: id } : links;
    case 'Order': {
      const owner = owners.get(`Order:${id}`);
      return owner === undefined ? links : { ...links, orderId: id, customerId: owner };
    }
    case 'Payment': {
      const owner = owners.get(`Payment:${id}`);
      return owner === undefined ? links : { ...links, paymentId: id, customerId: owner };
    }
    case 'Service': {
      const owner = owners.get(`Service:${id}`);
      return owner === undefined ? links : { ...links, serviceId: id, customerId: owner };
    }
    default:
      return links;
  }
}

function exportRowOf(row: AuditLogRecord): Readonly<Record<AuditExportColumn, string>> {
  return {
    occurredAt: row.occurredAt.toISOString(),
    actorType: row.actorType,
    actorLabel: row.actorLabel ?? '',
    actorId: row.actorId ?? '',
    surface: row.surface,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId ?? '',
    result: row.result,
    security: auditSecurityClasses(row).join(' '),
    reason: row.reason ?? '',
    // Already redacted by the reader; serialised as stored, never re-shaped.
    before: row.before === null ? '' : JSON.stringify(row.before),
    after: row.after === null ? '' : JSON.stringify(row.after),
    correlationId: row.correlationId,
    id: row.id,
  };
}

/** The filter an export ran with, for its own audit row. Absent filters are omitted. */
function filterRecord(query: AuditLogQuery): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}
