import {
  COMMERCE_ERROR_CODES,
  LEGACY_CUSTOMER_INVOICES_PAGE_DEFAULT,
  LEGACY_HISTORY_AUDIT_ACTIONS,
  LEGACY_HISTORY_ERROR_CODES,
  LEGACY_HISTORY_PAGE_DEFAULT,
  LEGACY_HISTORY_RECORD_TYPES,
  LEGACY_INVOICE_ARCHIVE_AUDIT_ACTIONS,
  errors,
  userIdSchema,
  type ActorContext,
  type AuditWriter,
  type LegacyCustomerAdoptionsQuery,
  type LegacyCustomerInvoicesQuery,
  type LegacyHistoryListQuery,
  type LegacyHistoryRecordType,
  type PermissionKey,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import type {
  LegacyCustomerInvoiceRow,
  LegacyHistoryRecordRow,
  LegacyHistoryRepository,
} from './ports.js';
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
const SERVICES_VIEW = 'legacy.services.view' satisfies PermissionKey;

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
  /** A ticket message: the id of its ticket record (this archive's own id); else absent. */
  readonly ticketRecordId?: string | null;
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
const ARCHIVE_ENTITY = 'LegacyInvoiceArchive';

/** A customer's legacy invoices page (`invoicesForCustomer`). */
export interface LegacyCustomerInvoicesPage {
  readonly rows: readonly LegacyCustomerInvoiceRow[];
  readonly nextCursor: string | null;
  readonly piiRedacted: boolean;
  readonly candidatesVisible: boolean;
}

/** The keyset cursor: the last invoice key of the page, opaque to the client. */
export function encodeCustomerInvoiceCursor(invoiceKey: string): string {
  return `k${Buffer.from(invoiceKey, 'utf8').toString('base64url')}`;
}

export function decodeCustomerInvoiceCursor(cursor: string): string {
  const key = Buffer.from(cursor.slice(1), 'base64url').toString('utf8');
  if (!cursor.startsWith('k') || encodeCustomerInvoiceCursor(key) !== cursor) {
    throw errors.validation(LEGACY_HISTORY_ERROR_CODES.REQUEST_INVALID, 'Bad cursor.');
  }
  return key;
}

export class LegacyHistoryReadService {
  constructor(private readonly deps: LegacyHistoryReadDeps) {}

  /**
   * The customer's Mirza invoices — the latest visible archive revision of each, beside the
   * importer's ONE outcome for it as a service. History only: nothing here is an order. Charged
   * on `users.view`, the customer existing, then `legacy.invoices.view`; the candidates come
   * only with `legacy.services.view`, the legacy username only with `legacy.invoices.pii.view`
   * (and such a page is audited as the archive audits its own unredacted list).
   */
  async invoicesForCustomer(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    query: LegacyCustomerInvoicesQuery,
  ): Promise<LegacyCustomerInvoicesPage> {
    const customer = await this.customerOf(scope, actor, id);
    await this.deps.guard.check(scope, actor, INVOICES_VIEW);
    const held = await this.deps.guard.permissionsOf(scope, actor);
    const pii = held.has(LEGACY_HISTORY_PII_PERMISSION);
    const candidatesVisible = held.has(SERVICES_VIEW);
    const limit = query.limit ?? LEGACY_CUSTOMER_INVOICES_PAGE_DEFAULT;
    const after = query.after === undefined ? null : decodeCustomerInvoiceCursor(query.after);
    const fetched = await this.deps.repository.invoicesForCustomer(
      scope,
      customer.telegramUserId,
      after,
      limit + 1,
    );
    const page = fetched.slice(0, limit);
    const last = page[page.length - 1];
    if (pii && page.length > 0) {
      await this.deps.audit.record(scope, actor, {
        action: LEGACY_INVOICE_ARCHIVE_AUDIT_ACTIONS.piiView,
        entityType: ARCHIVE_ENTITY,
        entityId: null,
        before: null,
        // Ids and a count only: never a Telegram id or a username.
        after: {
          list: true,
          customerId: customer.id,
          count: page.length,
          rowIds: page.map((row) => row.archiveId),
        },
        result: 'SUCCESS',
      });
    }
    return {
      rows: page.map((row) => ({
        ...row,
        username: pii ? row.username : null,
        candidate: candidatesVisible ? row.candidate : null,
      })),
      nextCursor:
        fetched.length > limit && last !== undefined
          ? encodeCustomerInvoiceCursor(last.invoiceKey)
          : null,
      piiRedacted: !pii,
      candidatesVisible,
    };
  }

  /**
   * Which of these services of the customer were adopted from a Mirza invoice. Charged on
   * `users.view`, the customer existing, then `legacy.services.view`. A service of another
   * customer (or tenant) is simply not in the answer.
   */
  async adoptionsForCustomer(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    query: LegacyCustomerAdoptionsQuery,
  ): Promise<readonly { readonly serviceId: string; readonly invoiceKey: string }[]> {
    const customer = await this.customerOf(scope, actor, id);
    await this.deps.guard.check(scope, actor, SERVICES_VIEW);
    return this.deps.repository.adoptionsForCustomer(scope, customer.id, [
      ...new Set(query.serviceIds),
    ]);
  }

  /** `users.view`, then the customer in this tenant (a 404 otherwise). */
  private async customerOf(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<{ readonly id: string; readonly telegramUserId: string }> {
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
    return customer;
  }

  async forCustomer(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    query: LegacyHistoryListQuery,
  ): Promise<LegacyHistoryReadPage> {
    const customer = await this.customerOf(scope, actor, id);
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

export function itemOf(row: LegacyHistoryRecordRow, pii: boolean): LegacyHistoryReadItem {
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
    ...(row.ticketRecordId === undefined ? {} : { ticketRecordId: row.ticketRecordId }),
  };
}
