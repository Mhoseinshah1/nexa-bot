import type {
  CurrencyCode,
  LegacyReviewReasonCode,
  ProviderType,
  TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * Migration P6 — the adoption write path's public types and its one storage port
 * (`docs/migration-p6-service-adoption.md`).
 *
 * ADOPTION IS NOT PROVISIONING. Nothing in this module holds, imports or is handed a
 * provider client, an adapter or an HTTP transport: every runtime fact about the account
 * is an INPUT the P7 importer read through the read-only inventory (#169).
 * `tests/unit/legacy-adoption-boundary.test.ts` pins that on the source.
 */

/** The RickPanel account states the read-only inventory folds a record's `status` into. */
export const ADOPTION_PROVIDER_STATES = [
  'active',
  'disabled',
  'limited',
  'expired',
  'on_hold',
  'UNKNOWN',
] as const;
export type AdoptionProviderState = (typeof ADOPTION_PROVIDER_STATES)[number];

/**
 * The verified inventory match (#169 `LegacyServiceMatch`), restated structurally so this
 * application layer does not import the providers module. The importer passes the matcher's
 * answer as it came back.
 */
export type AdoptionInventoryMatch =
  | {
      readonly kind: 'ELIGIBLE';
      readonly panelId: string;
      /** The lowercase matching key. */
      readonly username: string;
      /** The panel's EXACT spelling — what the service stores (C3 constraint 3). */
      readonly providerUsername: string;
    }
  | {
      readonly kind: 'MANUAL_REVIEW';
      readonly reason:
        'PROVIDER_MISSING' | 'AMBIGUOUS_PANEL' | 'PANEL_UNMAPPED' | 'USERNAME_CASE_COLLISION';
      readonly candidatePanels: number;
    }
  | { readonly kind: 'SKIPPED'; readonly reason: 'TEST_PANEL' }
  | { readonly kind: 'INVALID'; readonly reason: 'INVALID_SOURCE_ROW' }
  | { readonly kind: 'UNDECIDABLE'; readonly reason: 'INVENTORY_INCOMPLETE' };

/**
 * What RickPanel said about the account, as the inventory (or a single read-only lookup)
 * returned it. Runtime truth: never the invoice snapshot.
 */
export interface AdoptionRuntimeFacts {
  readonly state: AdoptionProviderState;
  /** Null when the record's usage fields were absent or malformed — never a fake zero. */
  readonly usage: {
    readonly usedBytes: bigint;
    /** Null = unlimited (the panel's `data_limit` absent or zero). */
    readonly totalBytes: bigint | null;
    /** Null = no expiry. */
    readonly expiresAt: Date | null;
  } | null;
  /** When the importer read these figures. Stored as `usage_synced_at`. */
  readonly observedAt: Date;
  /**
   * The provider's OWN subscription link, if the importer read one (a GET; C3 constraint
   * 1). Never constructed from anything. Null = adopted without a link. Never logged,
   * audited, evented or mapped.
   */
  readonly subscriptionUrl: string | null;
}

export interface LegacyAdoptionCommand {
  /** The RUNNING `APPLY` legacy import run this decision is recorded under. */
  readonly runId: string;
  /** `invoice.id_invoice` — the map's `legacy_id` for `legacy_table = 'invoice'`. */
  readonly legacyInvoiceKey: string;
  /** SHA-256 (lowercase hex) of the source invoice row, for the map row. */
  readonly sourceChecksum: string;
  /** The legacy `user.id` = the customer's Telegram id within the tenant. */
  readonly telegramUserId: string;
  readonly match: AdoptionInventoryMatch;
  /** Required when `match.kind === 'ELIGIBLE'`; ignored otherwise. */
  readonly runtime: AdoptionRuntimeFacts | null;
  /** The resolved hidden/current product; null = unresolved (manual review). */
  readonly productId: string | null;
  /** The legacy purchase time, for the order's `settled_at`; null = adoption time. */
  readonly legacyPurchasedAt: Date | null;
  readonly idempotencyKey: string;
  /**
   * The customer the importer created or matched for this Telegram id, when it knows one.
   * The adoption still finds the customer itself, by `(tenant, telegram_user_id)`, inside its
   * transaction; a different answer is `CONFLICTING_EXISTING_ENTITY`, never a silent pick.
   */
  readonly expectedCustomerId?: string;
}

/**
 * The P7 importer's candidate (its `LegacyAdoptionPort`), restated structurally so neither
 * module imports the other, plus the two facts adoption cannot do without and must never
 * guess: the account's RUNTIME facts (from the read-only inventory record) and — for a
 * named legacy product — the NEXA product the operator's explicit product map resolved it to.
 * A hidden shape needs no product id: the shape row names its own product.
 */
export interface LegacyAdoptionCandidate {
  readonly runId: string;
  readonly legacyInvoiceId: string;
  readonly checksum: string;
  readonly telegramUserId: string;
  readonly customerId: string;
  readonly panelId: string;
  readonly providerUsername: string;
  readonly product:
    | {
        readonly kind: 'NAMED_PRODUCT';
        readonly codeProduct: string;
        readonly productId?: string | null;
      }
    | {
        readonly kind: 'HIDDEN_SHAPE';
        readonly shapeKey: string;
        readonly custom: boolean;
        readonly shapeId: string;
      };
  /** Null when the importer has no record for the account: a FAILED read, retried later. */
  readonly runtime: AdoptionRuntimeFacts | null;
  readonly legacyPurchasedAt?: Date | null;
}

/**
 * Why an invoice went to manual review. A closed set, and every member is a
 * `LEGACY_REVIEW_REASON_CODES` member (Item 9's queue vocabulary) — the type below fails the
 * build otherwise. `PROVIDER_READ_FAILED` is deliberately NOT here: an unreadable provider
 * record is a FAILED attempt a rerun processes again, not a question for a person.
 */
export const LEGACY_ADOPTION_REVIEW_REASONS = [
  'PROVIDER_MISSING',
  'AMBIGUOUS_PANEL',
  'PANEL_UNMAPPED',
  'USERNAME_CASE_COLLISION',
  'INVENTORY_INCOMPLETE',
  'INVALID_SOURCE_ROW',
  'CUSTOMER_MISSING',
  'PRODUCT_MAPPING_UNRESOLVED',
  'SUBSCRIPTION_REF_BLOCKED',
  'CONFLICTING_EXISTING_ENTITY',
  'UNSUPPORTED_SHAPE',
] as const satisfies readonly LegacyReviewReasonCode[];
export type LegacyAdoptionReviewReason = (typeof LEGACY_ADOPTION_REVIEW_REASONS)[number];

export interface AdoptionCapacity {
  readonly maxServices: number | null;
  /** Slots in use on the panel after this adoption (services + live holds). */
  readonly usedAfter: number;
  /** True when this adoption left the panel above its cap. Never refused; reported. */
  readonly overCap: boolean;
}

export type LegacyAdoptionOutcome =
  | {
      readonly kind: 'ADOPTED';
      readonly serviceId: string;
      readonly orderId: string;
      readonly customerId: string;
      readonly panelId: string;
      readonly state: 'ACTIVE' | 'SUSPENDED' | 'EXPIRED';
      readonly capacity: AdoptionCapacity;
      /** The reminder kinds recorded as already passed (burst protection). */
      readonly remindersSeeded: readonly string[];
    }
  | {
      readonly kind: 'ALREADY_ADOPTED';
      readonly serviceId: string;
      readonly orderId: string;
      readonly customerId: string;
      readonly panelId: string;
      /** The source row's checksum differs from the one it was adopted from. */
      readonly sourceChanged: boolean;
    }
  | { readonly kind: 'SKIPPED'; readonly reason: 'TEST_PANEL' }
  /**
   * The provider record could not be read (no usage figures, an unusable link): a map row
   * `FAILED / PROVIDER_READ_FAILED`, which a rerun with a fresh read processes again.
   */
  | { readonly kind: 'FAILED'; readonly reason: 'PROVIDER_READ_FAILED' }
  /**
   * A person closed this invoice's review in a way a rerun must not act on (Item 9:
   * DISMISSED, or RESOLVED other than RETRY_AFTER_FIX). Nothing is written; reopen it first.
   */
  | { readonly kind: 'REVIEW_CLOSED'; readonly reason: LegacyReviewReasonCode | null }
  | {
      readonly kind: 'MANUAL_REVIEW';
      readonly reason: LegacyAdoptionReviewReason;
      /**
       * Whether a MANUAL_REVIEW map row was written. False only for an invoice key outside
       * the map's evidenced shape, which the map refuses by design: the importer reports it.
       */
      readonly recorded: boolean;
    };

// --- storage ---------------------------------------------------------------------------

export interface AdoptionPanel {
  readonly id: string;
  readonly providerType: ProviderType | string;
  readonly baseUrl: string;
}

export interface AdoptedServiceRecord {
  readonly serviceId: string;
  readonly orderId: string;
  readonly customerId: string;
  readonly panelId: string;
}

export interface AdoptionInsert {
  readonly orderId: string;
  readonly serviceId: string;
  readonly reservationId: string;
  readonly customerId: string;
  readonly panelId: string;
  readonly productId: string;
  readonly line: {
    readonly title: string;
    readonly durationDays: number;
    readonly trafficBytes: bigint;
    readonly deviceLimit: number | null;
  };
  readonly currency: CurrencyCode;
  readonly settledAt: Date;
  readonly service: {
    readonly state: 'ACTIVE' | 'SUSPENDED' | 'EXPIRED';
    readonly providerUsername: string;
    readonly subscriptionRef: string;
    readonly providerClientId: string;
    readonly subscriptionUrl: string | null;
    readonly expiresAt: Date | null;
    readonly trafficLimitBytes: bigint;
    readonly trafficUsedBytes: bigint;
    readonly usageSyncedAt: Date;
  };
  readonly reservation: { readonly namespaceKey: string; readonly username: string };
  readonly now: Date;
}

/**
 * The adoption's own reads and its one write. Narrow, and in this module, because no
 * existing repository may write a PAID order at birth or a live service with no operation —
 * `OrderRepository.create` writes DRAFT and `ServiceRepository.create` PENDING_PROVISION,
 * deliberately, and widening either would hand every caller a way to skip payment or
 * provisioning.
 */
export interface LegacyAdoptionStore {
  /** Serialises every adoption of one invoice for the rest of the transaction. */
  lockInvoice(scope: TenantContext, legacyInvoiceKey: string, tx: TransactionScope): Promise<void>;
  findCustomerByTelegramId(
    scope: TenantContext,
    telegramUserId: string,
    tx: TransactionScope,
  ): Promise<string | null>;
  /** `SELECT … FOR UPDATE` on the panel row — the lock capacity `reserve` takes first. */
  lockPanel(
    scope: TenantContext,
    panelId: string,
    tx: TransactionScope,
  ): Promise<AdoptionPanel | null>;
  /** The legacy shape row id whose hidden product this is, or null. */
  shapeIdForProduct(
    scope: TenantContext,
    productId: string,
    tx: TransactionScope,
  ): Promise<string | null>;
  /**
   * Whether this name is already somebody's on this panel or in its namespace: any service
   * on the panel whose name folds to it (any state), or a reservation of the lowercase name
   * in the namespace (any tenant — the namespace is the host's).
   */
  usernameTaken(
    scope: TenantContext,
    input: { readonly panelId: string; readonly namespaceKey: string; readonly canonical: string },
    tx: TransactionScope,
  ): Promise<boolean>;
  insertAdoption(scope: TenantContext, input: AdoptionInsert, tx: TransactionScope): Promise<void>;
  findService(
    scope: TenantContext,
    serviceId: string,
    tx: TransactionScope,
  ): Promise<AdoptedServiceRecord | null>;
}
