import type {
  GiftCardBatchState,
  GiftCardCodeState,
  GiftCardRejection,
  Money,
  TenantContext,
  UserId,
} from '@nexa/contracts';

/** A sealed export: the SecretCipher envelope and the key that wrote it. */
export interface SealedGiftCardExport {
  readonly ciphertext: string;
  readonly keyId: string;
}

export interface GiftCardBatchRecord {
  readonly id: string;
  readonly label: string;
  /** The face value of ONE code. */
  readonly amount: Money;
  readonly codeCount: number;
  readonly perCustomerLimit: number | null;
  readonly expiresAt: Date;
  readonly state: GiftCardBatchState;
  readonly reason: string;
  readonly createdByAdminId: string | null;
  readonly createdAt: Date;
  readonly disabledAt: Date | null;
  readonly disabledByAdminId: string | null;
  readonly exportExpiresAt: Date;
  /** Null once purged (or never sealed). */
  readonly sealedExport: SealedGiftCardExport | null;
}

/** Counted by the database over the batch's code rows. */
export interface GiftCardBatchCounts {
  readonly redeemed: number;
  readonly disabled: number;
  readonly unredeemed: number;
}

export interface GiftCardBatchListing {
  readonly batch: GiftCardBatchRecord;
  readonly counts: GiftCardBatchCounts;
}

export interface GiftCardCodeRecord {
  readonly id: string;
  readonly batchId: string;
  readonly last4: string;
  readonly state: GiftCardCodeState;
  readonly redeemedAt: Date | null;
  readonly redeemedByCustomerId: string | null;
  readonly walletEntryId: string | null;
}

/** `(createdAt, id)`, PostgreSQL's own microsecond text, like every other keyset here. */
export interface GiftCardBatchCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface NewGiftCardBatch {
  readonly id: string;
  readonly label: string;
  readonly amount: Money;
  readonly codeCount: number;
  readonly perCustomerLimit: number | null;
  readonly expiresAt: Date;
  readonly reason: string;
  readonly createdByAdminId: string | null;
  readonly createdAt: Date;
  readonly exportExpiresAt: Date;
  readonly sealedExport: SealedGiftCardExport;
}

export interface NewGiftCardCode {
  readonly id: string;
  readonly codeHash: string;
  readonly last4: string;
}

export interface GiftCardRepository {
  /** The batch and every code, in the caller's transaction. A hash collision fails the insert. */
  insertBatch(
    scope: TenantContext,
    batch: NewGiftCardBatch,
    codes: readonly NewGiftCardCode[],
    tx: unknown,
  ): Promise<void>;

  /**
   * One batch of this tenant. `lock: 'share'` is what a redemption holds (many redeem at once,
   * a disable waits for them); `'update'` is what a disable holds.
   */
  findBatch(
    scope: TenantContext,
    batchId: string,
    options: { readonly lock?: 'share' | 'update' },
    tx?: unknown,
  ): Promise<GiftCardBatchRecord | null>;

  /** Newest first, keyset, each with its counts. */
  listBatches(
    scope: TenantContext,
    query: { readonly limit: number; readonly cursor?: GiftCardBatchCursor },
  ): Promise<{
    readonly items: readonly GiftCardBatchListing[];
    readonly next: GiftCardBatchCursor | null;
  }>;

  counts(scope: TenantContext, batchId: string, tx?: unknown): Promise<GiftCardBatchCounts>;

  findCodeByHash(
    scope: TenantContext,
    codeHash: string,
    tx: unknown,
  ): Promise<GiftCardCodeRecord | null>;

  /**
   * THE redemption: a conditional UPDATE from "not redeemed and ACTIVE" stamping the customer,
   * the entry and the instant. False when it changed nothing — another redeemer won, or the
   * code was disabled. The row's own state decides, never an earlier read.
   */
  redeemCode(
    scope: TenantContext,
    input: {
      readonly codeId: string;
      readonly customerId: UserId;
      readonly entryId: string;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean>;

  /** How many of this batch's codes this customer has redeemed. */
  countRedeemedBy(
    scope: TenantContext,
    batchId: string,
    customerId: UserId,
    tx: unknown,
  ): Promise<number>;

  /**
   * ACTIVE -> DISABLED for the batch and its UNREDEEMED codes, conditionally. `changed` false
   * when the batch was already disabled. A redeemed code is never touched.
   */
  disableBatch(
    scope: TenantContext,
    batchId: string,
    input: { readonly adminId: string | null; readonly now: Date },
    tx: unknown,
  ): Promise<{ readonly changed: boolean; readonly codesDisabled: number }>;

  recordAttempt(
    scope: TenantContext,
    attempt: {
      readonly id: string;
      readonly customerId: UserId;
      readonly at: Date;
      readonly outcome: GiftCardRejection;
      readonly codeId: string | null;
    },
    tx: unknown,
  ): Promise<void>;

  /** Refused attempts by this customer at or after `since`. */
  countFailedSince(
    scope: TenantContext,
    customerId: UserId,
    since: Date,
    tx: unknown,
  ): Promise<number>;
}

/**
 * The worker's sweep: purge the sealed exports whose window has passed, and delete attempt
 * rows older than the retention. In the caller's transaction, for one tenant.
 */
export interface GiftCardSweepRepository {
  purgeExpiredExports(scope: TenantContext, now: Date, tx: unknown): Promise<number>;
  deleteAttemptsBefore(scope: TenantContext, cutoff: Date, tx: unknown): Promise<number>;
}

/** Seals and opens a batch's plaintext codes (SecretCipher, `gift_card.batch_export`). */
export interface GiftCardExportSealer {
  seal(scope: TenantContext, batchId: string, codes: readonly string[]): SealedGiftCardExport;
  open(scope: TenantContext, batchId: string, sealed: SealedGiftCardExport): readonly string[];
}

/** Renders a batch's codes as the downloadable CSV, in the tenant's calendar and time zone. */
export interface GiftCardCsvRenderer {
  render(
    scope: TenantContext,
    batch: GiftCardBatchRecord,
    codes: readonly string[],
  ): Promise<{ readonly fileName: string; readonly content: string }>;
}
