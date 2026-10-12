import {
  COMMERCE_ERROR_CODES,
  LEGACY_HISTORY_AUDIT_ACTIONS,
  LEGACY_HISTORY_PAGE_DEFAULT,
  LEGACY_HISTORY_RECORD_TYPES,
  errors,
  userIdSchema,
  type ActorContext,
  type AuditWriter,
  type LegacyHistoryListQuery,
  type LegacyHistoryRecordType,
  type PermissionKey,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import type { LegacyHistoryRecordRow, LegacyHistoryRepository } from './ports.js';
import { summaryOf } from './record-map.js';
import { redactHistoryPayload } from './redaction.js';

/**
 * Mirza `.nxpkg` importer — a customer's archived Mirza history, read on Customer 360.
 *
 * Read only: there is no write here and none behind it. Charged, in order, on `users.view`
 * (the customer page, as `CustomerInsightService` charges it), the customer existing in the
 * tenant, then `legacy.history.view`. Without `legacy.invoices.pii.view` — the legacy
 * archives' personal-data key — a record is reduced to its per-type ALLOWLIST (`redaction.ts`:
 * codes, amounts, counts, flags, instants) and everything else is dropped; with it the record
 * is returned as packaged and the page is audited (record ids and counts, never a value).
 */

export const LEGACY_HISTORY_VIEW_PERMISSION = 'legacy.history.view' satisfies PermissionKey;
export const LEGACY_HISTORY_PII_PERMISSION = 'legacy.invoices.pii.view' satisfies PermissionKey;
const CUSTOMER_VIEW = 'users.view' satisfies PermissionKey;
const INVOICES_VIEW = 'legacy.invoices.view' satisfies PermissionKey;
const DEBTS_VIEW = 'legacy.debts.view' satisfies PermissionKey;

/** The customer as this read needs it. */
export interface LegacyHistoryCustomerReader {
  findById(
    scope: TenantContext,
    id: UserId,
  ): Promise<{ readonly id: string; readonly telegramUserId: string } | null>;
}

export interface LegacyHistoryReadDeps {
  readonly repository: LegacyHistoryRepository;
  readonly customers: LegacyHistoryCustomerReader;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
}

export interface LegacyHistoryReadItem {
  readonly id: string;
  readonly recordType: LegacyHistoryRecordType;
  readonly occurredAt: Date | null;
  readonly packageImportId: string;
  readonly summary: Readonly<Record<string, string | number | boolean | null>>;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly redacted: readonly string[];
  readonly legacyUserId: string | null;
}

export interface LegacyHistoryReadPage {
  readonly items: readonly LegacyHistoryReadItem[];
  /** Records matching the query (the type filter included). */
  readonly matching: number;
  readonly offset: number;
  readonly limit: number;
  readonly byType: readonly {
    readonly recordType: LegacyHistoryRecordType;
    readonly count: number;
  }[];
  readonly piiRedacted: boolean;
  readonly invoiceArchive: { readonly invoices: number } | null;
  readonly walletDebts: { readonly debts: number } | null;
}

const ROW_ENTITY = 'LegacyHistoryRecord';

export class LegacyHistoryReadService {
  constructor(private readonly deps: LegacyHistoryReadDeps) {}

  async forCustomer(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    query: LegacyHistoryListQuery,
  ): Promise<LegacyHistoryReadPage> {
    await this.deps.guard.check(scope, actor, CUSTOMER_VIEW);
    const parsed = userIdSchema.safeParse(id);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid customer identifier.',
      );
    }
    const customer = await this.deps.customers.findById(scope, parsed.data);
    if (customer === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
    await this.deps.guard.check(scope, actor, LEGACY_HISTORY_VIEW_PERMISSION);
    const held = await this.deps.guard.permissionsOf(scope, actor);
    const pii = held.has(LEGACY_HISTORY_PII_PERMISSION);

    const target = { id: customer.id, telegramUserId: customer.telegramUserId };
    const offset = query.offset ?? 0;
    const limit = query.limit ?? LEGACY_HISTORY_PAGE_DEFAULT;
    const type = query.type ?? null;
    const counts = await this.deps.repository.countsForCustomer(scope, target);
    const byType = LEGACY_HISTORY_RECORD_TYPES.filter((t) => (counts.get(t) ?? 0) > 0).map(
      (recordType) => ({ recordType, count: counts.get(recordType) ?? 0 }),
    );
    const matching =
      type === null ? byType.reduce((sum, row) => sum + row.count, 0) : (counts.get(type) ?? 0);
    const rows =
      offset >= matching
        ? []
        : await this.deps.repository.listForCustomer(scope, target, type, offset, limit);

    if (pii && rows.length > 0) {
      await this.deps.audit.record(scope, actor, {
        action: LEGACY_HISTORY_AUDIT_ACTIONS.piiView,
        entityType: ROW_ENTITY,
        entityId: null,
        before: null,
        after: {
          customerId: customer.id,
          count: rows.length,
          type,
          rowIds: rows.map((row) => row.id),
        },
        result: 'SUCCESS',
      });
    }

    return {
      items: rows.map((row) => itemOf(row, pii)),
      matching,
      offset,
      limit,
      byType,
      piiRedacted: !pii,
      invoiceArchive: held.has(INVOICES_VIEW)
        ? {
            invoices: await this.deps.repository.invoiceArchiveCount(
              scope,
              customer.telegramUserId,
            ),
          }
        : null,
      walletDebts: held.has(DEBTS_VIEW)
        ? { debts: await this.deps.repository.walletDebtCount(scope, customer.id) }
        : null,
    };
  }
}

function itemOf(row: LegacyHistoryRecordRow, pii: boolean): LegacyHistoryReadItem {
  // Without the PII key the summary is read from the allowlisted projection, never the
  // packaged record: a summary field the allowlist does not carry is not shown either.
  const view = pii
    ? { payload: row.payload, redacted: [] }
    : redactHistoryPayload(row.recordType, row.payload);
  return {
    id: row.id,
    recordType: row.recordType,
    occurredAt: row.occurredAt,
    packageImportId: row.packageImportId,
    summary: summaryOf(row.recordType, view.payload),
    payload: view.payload,
    redacted: view.redacted,
    legacyUserId: pii ? row.legacyUserId : null,
  };
}
