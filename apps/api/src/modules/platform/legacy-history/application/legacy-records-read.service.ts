import {
  LEGACY_HISTORY_AUDIT_ACTIONS,
  LEGACY_HISTORY_RECORD_TYPES,
  LEGACY_RECORDS_PAGE_DEFAULT,
  LEGACY_SERVICE_RECORDS_MAX,
  type ActorContext,
  type AuditWriter,
  type LegacyHistoryRecordType,
  type LegacyRecordsListQuery,
  type PermissionKey,
  type TenantContext,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import {
  itemOf,
  LEGACY_HISTORY_PII_PERMISSION,
  LEGACY_HISTORY_VIEW_PERMISSION,
  type LegacyHistoryReadItem,
} from './legacy-history-read.service.js';
import type { LegacyInactivePanelRow, LegacyRecordsRepository } from './ports.js';

/**
 * «سوابق و تنظیمات میرزا» — the tenant-wide, read-only view of the Mirza history archive, and
 * a service's own Mirza records. Charged on `legacy.history.view` (the service section also on
 * `services.view`). Redaction is the Customer 360 card's: without `legacy.invoices.pii.view`
 * every payload is reduced to its per-type allowlist; a page shown to a PII reader is audited
 * with record ids and a count, never a value. No write exists here or behind it.
 */

const SERVICE_VIEW = 'services.view' satisfies PermissionKey;
const ROW_ENTITY = 'LegacyHistoryRecord';

export interface LegacyRecordItem extends LegacyHistoryReadItem {
  readonly customerLinked: boolean;
}

export interface LegacyRecordsSummary {
  readonly byType: readonly {
    readonly recordType: LegacyHistoryRecordType;
    readonly records: number;
    readonly unlinked: number;
  }[];
  readonly records: number;
  readonly unlinked: number;
  readonly inactivePanels: readonly LegacyInactivePanelRow[];
}

export interface LegacyRecordsPage {
  readonly items: readonly LegacyRecordItem[];
  readonly nextCursor: string | null;
  readonly piiRedacted: boolean;
}

export interface LegacyServiceHistory {
  readonly invoiceKeys: readonly string[];
  readonly items: readonly LegacyRecordItem[];
  readonly truncated: boolean;
  readonly piiRedacted: boolean;
}

export interface LegacyRecordsReadDeps {
  readonly repository: LegacyRecordsRepository;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
}

export class LegacyRecordsReadService {
  constructor(private readonly deps: LegacyRecordsReadDeps) {}

  /** Every record type with its counts (global and customer-less ones included). */
  async summary(scope: TenantContext, actor: ActorContext): Promise<LegacyRecordsSummary> {
    await this.deps.guard.check(scope, actor, LEGACY_HISTORY_VIEW_PERMISSION);
    const [counts, panels, pii] = await Promise.all([
      this.deps.repository.countsByType(scope),
      this.deps.repository.inactivePanels(scope),
      this.holdsPii(scope, actor),
    ]);
    // A panel's name is free text, which the history projection withholds without
    // legacy.invoices.pii.view; the code, type and status are codes and stay.
    const inactivePanels = pii ? panels : panels.map((panel) => ({ ...panel, name: null }));
    const byId = new Map(counts.map((row) => [row.type, row]));
    // Known types in the contract's order; a type the contract does not know is not listed.
    const byType = LEGACY_HISTORY_RECORD_TYPES.filter((t) => (byId.get(t)?.records ?? 0) > 0).map(
      (recordType) => ({
        recordType,
        records: byId.get(recordType)?.records ?? 0,
        unlinked: byId.get(recordType)?.unlinked ?? 0,
      }),
    );
    return {
      byType,
      records: byType.reduce((sum, row) => sum + row.records, 0),
      unlinked: byType.reduce((sum, row) => sum + row.unlinked, 0),
      inactivePanels,
    };
  }

  /** One page of records by id, optionally one type and/or linked / not linked to a customer. */
  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: LegacyRecordsListQuery,
  ): Promise<LegacyRecordsPage> {
    await this.deps.guard.check(scope, actor, LEGACY_HISTORY_VIEW_PERMISSION);
    const pii = await this.holdsPii(scope, actor);
    const limit = query.limit ?? LEGACY_RECORDS_PAGE_DEFAULT;
    const fetched = await this.deps.repository.listRecords(
      scope,
      {
        type: query.type ?? null,
        linked: query.linked === undefined ? null : query.linked === 'yes',
        after: query.after ?? null,
      },
      limit + 1,
    );
    const page = fetched.slice(0, limit);
    await this.auditPii(scope, actor, pii, page, { type: query.type ?? null });
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({ ...itemOf(row, pii), customerLinked: row.customerId !== null })),
      nextCursor: fetched.length > limit && last !== undefined ? last.id : null,
      piiRedacted: !pii,
    };
  }

  /**
   * A service's Mirza records: the candidate(s) adopted as this service give their invoice
   * key(s); the operations, cancellation requests and ownership records of those invoices
   * follow. A service that was not adopted from Mirza (or is not this tenant's) has none.
   */
  async forService(
    scope: TenantContext,
    actor: ActorContext,
    serviceId: string,
  ): Promise<LegacyServiceHistory> {
    await this.deps.guard.check(scope, actor, SERVICE_VIEW);
    await this.deps.guard.check(scope, actor, LEGACY_HISTORY_VIEW_PERMISSION);
    const pii = await this.holdsPii(scope, actor);
    const invoiceKeys = await this.deps.repository.invoiceKeysOfService(scope, serviceId);
    const fetched = await this.deps.repository.recordsOfInvoices(
      scope,
      invoiceKeys,
      LEGACY_SERVICE_RECORDS_MAX + 1,
    );
    const page = fetched.slice(0, LEGACY_SERVICE_RECORDS_MAX);
    await this.auditPii(scope, actor, pii, page, { serviceId });
    return {
      invoiceKeys,
      items: page.map((row) => ({ ...itemOf(row, pii), customerLinked: row.customerId !== null })),
      truncated: fetched.length > LEGACY_SERVICE_RECORDS_MAX,
      piiRedacted: !pii,
    };
  }

  private async holdsPii(scope: TenantContext, actor: ActorContext): Promise<boolean> {
    return (await this.deps.guard.permissionsOf(scope, actor)).has(LEGACY_HISTORY_PII_PERMISSION);
  }

  private async auditPii(
    scope: TenantContext,
    actor: ActorContext,
    pii: boolean,
    rows: readonly { readonly id: string }[],
    context: Readonly<Record<string, string | null>>,
  ): Promise<void> {
    if (!pii || rows.length === 0) return;
    await this.deps.audit.record(scope, actor, {
      action: LEGACY_HISTORY_AUDIT_ACTIONS.piiView,
      entityType: ROW_ENTITY,
      entityId: null,
      before: null,
      // Ids and a count only: never a Telegram id, a username or a message.
      after: { ...context, count: rows.length, rowIds: rows.map((row) => row.id) },
      result: 'SUCCESS',
    });
  }
}
