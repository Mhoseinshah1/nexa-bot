import type { LegacyHistoryRecordType, TenantContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * Mirza `.nxpkg` importer — what the history archive (`legacy_history_records`, design §5)
 * needs. Every method is tenant-scoped; every write takes the caller's transaction. The
 * table is append-only (triggers refuse UPDATE and DELETE), so nothing here updates a row:
 * a record's customer is resolved BEFORE its insert, and a rerun inserts nothing twice.
 */

/**
 * Where the records come from. Structurally satisfied by the `.nxpkg` reader's package
 * (`files()`, `has()`, `iterJsonl()`), and by a plain object in tests; the ingest depends on
 * nothing else of the reader.
 */
export interface HistoryRecordSource {
  /** Every file of the package (paths relative to the payload root). */
  files(): readonly { readonly path: string }[];
  has(rel: string): boolean;
  iterJsonl(rel: string): AsyncIterable<Record<string, unknown>>;
}

/** One row as the ingest writes it. */
export interface NewLegacyHistoryRecord {
  readonly id: string;
  readonly recordType: LegacyHistoryRecordType;
  readonly idempotencyKey: string;
  readonly legacyUserId: string | null;
  readonly customerId: string | null;
  readonly occurredAt: Date | null;
  readonly payload: Record<string, unknown>;
}

/** One stored row, as the reads return it. */
export interface LegacyHistoryRecordRow extends NewLegacyHistoryRecord {
  readonly nxpkgImportId: string;
  readonly packageImportId: string;
  readonly createdAt: Date;
}

export interface LegacyHistoryRepository {
  /**
   * The package import row's own `package_import_id`: `undefined` when the tenant has no such
   * import, `null` while the import has not recorded one yet.
   */
  packageImportIdOf(
    scope: TenantContext,
    nxpkgImportId: string,
    tx?: TransactionScope,
  ): Promise<string | null | undefined>;
  /** Inserts the rows; a duplicate (tenant, package import, key) inserts nothing. Returns the new keys. */
  insertMany(
    scope: TenantContext,
    nxpkgImportId: string,
    packageImportId: string,
    rows: readonly NewLegacyHistoryRecord[],
    now: Date,
    tx: TransactionScope,
  ): Promise<ReadonlySet<string>>;
  /** Which of these keys this package import already archived. */
  existingKeys(
    scope: TenantContext,
    packageImportId: string,
    keys: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlySet<string>>;
  /**
   * The NEXA customer of each legacy user id the legacy importer imported
   * (`legacy_import_map`, `legacy_table = 'user'`, IMPORTED as a CUSTOMER).
   */
  customersByLegacyUser(
    scope: TenantContext,
    legacyUserIds: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, string>>;

  // --- reads -----------------------------------------------------------------------------
  /** A customer's records: linked to it, or unlinked under its Telegram id. Newest first. */
  listForCustomer(
    scope: TenantContext,
    customer: { readonly id: string; readonly telegramUserId: string },
    type: LegacyHistoryRecordType | null,
    offset: number,
    limit: number,
  ): Promise<readonly LegacyHistoryRecordRow[]>;
  countsForCustomer(
    scope: TenantContext,
    customer: { readonly id: string; readonly telegramUserId: string },
  ): Promise<ReadonlyMap<LegacyHistoryRecordType, number>>;
  /** Distinct archived legacy invoices whose `legacy_user_id` is this Telegram id. */
  invoiceArchiveCount(scope: TenantContext, telegramUserId: string): Promise<number>;
  /** Legacy wallet debts recorded for this customer. */
  walletDebtCount(scope: TenantContext, customerId: string): Promise<number>;
}
