import type { TenantContext } from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { NeverPaidOrderState, ShapeCells } from './ended-services.rules.js';

/**
 * The storage the ended-services step reads and writes. Every read is by key or by page (a
 * 10^5-invoice package is the normal size), and every write is one ended invoice: an order and
 * its service, together, never one without the other — or one never-paid invoice: an order
 * alone, never a service.
 *
 * Writes go straight to the tables, never through a business service: nothing here may reach
 * the outbox, a notification, a reminder, a provider or the ledger.
 */

/** One archived invoice: the latest visible revision of one `id_invoice`. */
export interface ArchivedInvoiceRow extends ShapeCells {
  readonly invoiceKey: string;
  readonly keyShapeEvidenced: boolean;
  readonly status: string | null;
  readonly isTest: boolean | null;
  /** `id_user` verbatim: the legacy user, which is the customer's Telegram id. */
  readonly legacyUserId: string | null;
  readonly username: string | null;
  /** `code_panel`, trimmed; null when blank (the archive's own column). */
  readonly panelCode: string | null;
  readonly productName: string | null;
  /** IRT minor units; null when the price cell does not read. */
  readonly priceMinor: bigint | null;
  readonly soldAt: Date | null;
}

export interface MapFactRow {
  readonly status: string;
  readonly reasonCode: string | null;
  readonly entityType: string | null;
}

/** The hidden product a shape stands for. */
export interface ShapeProductRow {
  readonly productId: string;
  readonly title: string;
  readonly durationDays: number;
  readonly trafficBytes: bigint;
}

/** What NEXA already holds under an invoice's `source_ref`, to tell a rerun from a divergence. */
export interface CarriedInvoice {
  readonly orderId: string | null;
  readonly orderOrigin: string | null;
  readonly orderState: string | null;
  readonly orderCustomerId: string | null;
  readonly orderPanelId: string | null;
  readonly orderTotal: bigint | null;
  readonly serviceId: string | null;
  readonly serviceState: string | null;
  readonly serviceCustomerId: string | null;
  readonly serviceIsTest: boolean | null;
}

export interface EndedInvoiceInsert {
  readonly orderId: string;
  readonly serviceId: string;
  readonly sourceRef: string;
  readonly customerId: string;
  readonly panelId: string;
  readonly product: ShapeProductRow;
  readonly lineTitle: string;
  readonly providerUsername: string;
  readonly subscriptionRef: string;
  /** IRT minor units: the invoice's own price, 0 when it did not read. */
  readonly amountMinor: bigint;
  readonly currency: 'IRT';
  /** The original purchase time, or the import time when the archive could not read one. */
  readonly purchasedAt: Date;
  readonly isTest: boolean;
  readonly now: Date;
}

/**
 * A never-paid invoice as an order and nothing else: `LEGACY_HISTORY`, in a terminal unpaid
 * state, at the invoice's own amount and date. No service, no payment, no ledger entry.
 */
export interface NeverPaidOrderInsert {
  readonly orderId: string;
  readonly sourceRef: string;
  readonly state: NeverPaidOrderState;
  readonly customerId: string;
  readonly panelId: string;
  readonly product: ShapeProductRow;
  readonly lineTitle: string;
  /** IRT minor units: the invoice's own price, 0 when it did not read. */
  readonly amountMinor: bigint;
  readonly currency: 'IRT';
  /** The original invoice time, or the import time when the archive could not read one. */
  readonly createdAt: Date;
  readonly now: Date;
}

/** The NEXA side of the exact-match report, read from the tables. */
export interface EndedServicesCounts {
  /** Services with `source = MIRZA` and an `invoice:` ref: adopted and ended alike. */
  readonly services: number;
  /** Services of those that are TERMINATED. */
  readonly terminatedServices: number;
  /**
   * Orders of origin `LEGACY_HISTORY` with an `invoice:` ref (a paid invoice's) or an
   * `invoice-never-paid:` ref (a never-paid one's): every invoice NEXA holds as an order.
   */
  readonly historyOrders: number;
  /** The total of those orders that are PAID: the never-paid amounts are never in it. */
  readonly paidHistoryOrdersTotalMinor: bigint;
  /** Of `historyOrders`, those under an `invoice-never-paid:` ref, and their total. */
  readonly neverPaidOrders: number;
  readonly neverPaidOrdersTotalMinor: bigint;
}

export interface EndedServicesRepository {
  /** The latest visible archive revision per invoice recorded under this source, key order. */
  archivePage(
    scope: TenantContext,
    sourceFingerprint: string,
    after: string | null,
    limit: number,
  ): Promise<readonly ArchivedInvoiceRow[]>;
  mapFacts(
    scope: TenantContext,
    invoiceKeys: readonly string[],
  ): Promise<ReadonlyMap<string, MapFactRow>>;
  /** Legacy user id → the NEXA customer the importer created or matched for it. */
  importedCustomers(
    scope: TenantContext,
    legacyUserIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  /** `code_panel` → NEXA panel id, as the operator bound them for this package import. */
  panelBindings(
    scope: TenantContext,
    packageImportId: string,
  ): Promise<ReadonlyMap<string, string>>;
  shapeProducts(
    scope: TenantContext,
    shapeKeys: readonly string[],
  ): Promise<ReadonlyMap<string, ShapeProductRow>>;
  carried(
    scope: TenantContext,
    sourceRefs: readonly string[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, CarriedInvoice>>;
  /** Serialises two executors of this step for the rest of the transaction. */
  lock(scope: TenantContext, tx: TransactionScope): Promise<void>;
  /** Writes the order then the service; both or neither. */
  insertEnded(scope: TenantContext, input: EndedInvoiceInsert, tx: TransactionScope): Promise<void>;
  /** `insertEnded` for many invoices: the same order and service rows, many a statement. */
  insertEndedMany(
    scope: TenantContext,
    inputs: readonly EndedInvoiceInsert[],
    tx: TransactionScope,
  ): Promise<void>;
  /** Writes a never-paid invoice's order, and nothing else. */
  insertNeverPaid(
    scope: TenantContext,
    input: NeverPaidOrderInsert,
    tx: TransactionScope,
  ): Promise<void>;
  counts(scope: TenantContext): Promise<EndedServicesCounts>;
}
