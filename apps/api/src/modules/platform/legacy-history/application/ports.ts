import type {
  LegacyHistoryRecordType,
  LegacyInvoiceArchiveClass,
  LegacyServiceOutcome,
  LegacyServiceReviewState,
  TenantContext,
} from '@nexa/contracts';
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

/**
 * One of a customer's legacy invoices as Customer 360 reads it: the latest VISIBLE archive
 * revision (its run COMPLETED, no newer visible one) beside the service candidate of the same
 * invoice key, when an import run decided one. Every field is the stored one, unchanged.
 */
export interface LegacyCustomerInvoiceRow {
  readonly archiveId: string;
  readonly invoiceKey: string;
  readonly revision: number;
  readonly classification: LegacyInvoiceArchiveClass;
  readonly live: boolean;
  readonly status: string | null;
  readonly isTest: boolean | null;
  readonly username: string | null;
  readonly panelCode: string | null;
  readonly productCode: string | null;
  readonly productName: string | null;
  readonly priceMinor: bigint | null;
  readonly priceCurrency: string | null;
  readonly soldAt: Date | null;
  readonly candidate: {
    readonly id: string;
    readonly outcome: LegacyServiceOutcome;
    readonly blocker: string | null;
    readonly reviewState: LegacyServiceReviewState;
    readonly serviceId: string | null;
  } | null;
}

/** One stored row, as the reads return it. */
export interface LegacyHistoryRecordRow extends NewLegacyHistoryRecord {
  readonly nxpkgImportId: string;
  readonly packageImportId: string;
  readonly createdAt: Date;
  /**
   * A `ticket_message` read for a customer: the id of the `ticket` record (same tenant, same
   * package import) it belongs to. Only the customer reads fill it; null elsewhere.
   */
  readonly ticketRecordId?: string | null;
}

/** A Mirza panel the registry records as not ACTIVE. */
export interface LegacyInactivePanelRow {
  readonly code: string;
  readonly name: string | null;
  readonly panelType: string | null;
  readonly status: string;
}

/** The tenant-wide reads behind «سوابق و تنظیمات میرزا» and the service page's section. */
export interface LegacyRecordsRepository {
  /** Per record type: all records, and the ones with no customer. */
  countsByType(
    scope: TenantContext,
  ): Promise<
    readonly { readonly type: string; readonly records: number; readonly unlinked: number }[]
  >;
  /** Registry panels whose normalised status is not ACTIVE, by panel code. */
  inactivePanels(scope: TenantContext): Promise<readonly LegacyInactivePanelRow[]>;
  /** Records by id (keyset), optionally one type and/or linked / not linked to a customer. */
  listRecords(
    scope: TenantContext,
    filter: {
      readonly type: LegacyHistoryRecordType | null;
      readonly linked: boolean | null;
      readonly after: string | null;
    },
    limit: number,
  ): Promise<readonly LegacyHistoryRecordRow[]>;
  /** Invoice keys of the candidates adopted as this service. */
  invoiceKeysOfService(scope: TenantContext, serviceId: string): Promise<readonly string[]>;
  /**
   * Service operations, cancellation requests and ownership records of these invoice keys,
   * newest first (id as the tiebreak). The caller asks for one more than it shows.
   */
  recordsOfInvoices(
    scope: TenantContext,
    invoiceKeys: readonly string[],
    limit: number,
  ): Promise<readonly LegacyHistoryRecordRow[]>;
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
  /**
   * The latest visible archive revision of each legacy invoice whose `legacy_user_id` is this
   * Telegram id, with its candidate. Invoice-key order; keys strictly after `after`.
   */
  invoicesForCustomer(
    scope: TenantContext,
    telegramUserId: string,
    after: string | null,
    limit: number,
  ): Promise<readonly LegacyCustomerInvoiceRow[]>;
  /**
   * Of these service ids, the ones that belong to this customer AND are a candidate's adopted
   * service, with the candidate's invoice key.
   */
  adoptionsForCustomer(
    scope: TenantContext,
    customerId: string,
    serviceIds: readonly string[],
  ): Promise<readonly { readonly serviceId: string; readonly invoiceKey: string }[]>;
}
