import type {
  CurrencyCode,
  CustomerStatus,
  Money,
  ReferralCommissionScope,
  ReferralCommissionState,
  ReferralSignupGiftSide,
  ReferralTrigger,
  TenantContext,
} from '@nexa/contracts';

/**
 * The referral module's persistence (`docs/wp9-referral-audit.md`).
 *
 * Every method carries the tenant. Methods that take a `tx` run inside the caller's
 * transaction; the rest are reads for the operator's surfaces.
 */

/** One party to a referral, as the operator sees them. */
export interface ReferralParty {
  readonly customerId: string;
  readonly telegramUserId: string;
  readonly displayName: string | null;
}

export interface ReferralRecord {
  readonly id: string;
  readonly referrerId: string;
  readonly refereeId: string;
  readonly trigger: ReferralTrigger;
  readonly createdAt: Date;
}

export interface ReferralListing extends ReferralRecord {
  readonly referrer: ReferralParty;
  readonly referee: ReferralParty;
}

export interface ReferralCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface ReferralCommissionRecord {
  readonly id: string;
  readonly orderId: string;
  readonly referralId: string;
  readonly referrerId: string;
  readonly refereeId: string;
  readonly scope: ReferralCommissionScope;
  readonly percent: number;
  readonly basis: Money;
  readonly amount: Money;
  readonly state: ReferralCommissionState;
  readonly earnedAmount: bigint | null;
  readonly earnedEntryId: string | null;
  readonly earnedAt: Date | null;
  readonly voidedAt: Date | null;
  readonly createdAt: Date;
}

export interface ReferralCommissionListing extends ReferralCommissionRecord {
  readonly referrer: ReferralParty;
  readonly referee: ReferralParty;
  /** The sum of every reversal's due. */
  readonly reversed: bigint;
  /** The part of `reversed` the referrer's balance could not cover. */
  readonly unrecovered: bigint;
}

export interface ReferralCommissionReversalRecord {
  readonly id: string;
  readonly refundId: string;
  readonly due: bigint;
  readonly recovered: bigint;
  readonly unrecovered: bigint;
  readonly walletEntryId: string | null;
  readonly createdAt: Date;
}

/** A pending commission whose order has an answer: delivered, or ended without delivery. */
export interface DueReferralCommission {
  readonly orderId: string;
  readonly delivered: boolean;
  readonly ended: boolean;
}

/** One currency's commission totals for a referrer. */
export interface ReferralTotals {
  readonly currency: CurrencyCode;
  readonly pending: bigint;
  readonly earned: bigint;
  readonly reversed: bigint;
  /** The part of `reversed` the referrer's balance could not cover. */
  readonly unrecovered: bigint;
}

export interface ReferralRepository {
  /**
   * Records `code` as `customerId`'s, the first time they ask for it.
   *
   * `EXISTS` when the customer already has a code row — the derivation is a function of
   * the id, so it is the same code. `TAKEN` when ANOTHER customer of this tenant already
   * holds the code: the 40-bit collision the audit handles rather than assumes away (F3).
   */
  ensureCode(
    scope: TenantContext,
    input: { readonly customerId: string; readonly code: string; readonly now: Date },
    tx: unknown,
  ): Promise<'CREATED' | 'EXISTS' | 'TAKEN'>;

  /** Whose code this is, in this tenant, with their standing. Null when nobody's. */
  findCodeOwner(
    scope: TenantContext,
    code: string,
    tx?: unknown,
  ): Promise<{ readonly customerId: string; readonly status: CustomerStatus } | null>;

  /** Idempotent per referee. True when this call wrote the attribution. */
  attribute(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly referrerId: string;
      readonly refereeId: string;
      readonly trigger: ReferralTrigger;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean>;

  findByReferee(
    scope: TenantContext,
    refereeId: string,
    tx?: unknown,
  ): Promise<ReferralRecord | null>;

  countReferredBy(scope: TenantContext, referrerId: string, tx?: unknown): Promise<number>;

  /** The code recorded for this customer, or null until they first asked for it. */
  codeOf(scope: TenantContext, customerId: string): Promise<string | null>;

  list(
    scope: TenantContext,
    filter: { readonly referrerId?: string },
    limit: number,
    cursor: ReferralCursor | null,
  ): Promise<{ readonly items: readonly ReferralListing[]; readonly next: ReferralCursor | null }>;

  findListingByReferee(scope: TenantContext, refereeId: string): Promise<ReferralListing | null>;
}

export interface ReferralCommissionRepository {
  /** Idempotent per order. True when this call wrote the promise. */
  promise(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly orderId: string;
      readonly referralId: string;
      readonly referrerId: string;
      readonly refereeId: string;
      readonly scope: ReferralCommissionScope;
      readonly percent: number;
      readonly basis: Money;
      readonly amount: Money;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean>;

  findByOrder(
    scope: TenantContext,
    orderId: string,
    tx?: unknown,
  ): Promise<ReferralCommissionRecord | null>;

  /** `SELECT … FOR UPDATE`. Taken AFTER the referrer's wallet lock, never before. */
  lockByOrder(
    scope: TenantContext,
    orderId: string,
    tx: unknown,
  ): Promise<ReferralCommissionRecord | null>;

  /** `PENDING` commissions whose order was delivered or has ended, oldest first, bounded. */
  due(scope: TenantContext, limit: number, tx?: unknown): Promise<readonly DueReferralCommission[]>;

  /** The same answer for one order, or null while its order is still in flight. */
  dueFor(
    scope: TenantContext,
    orderId: string,
    tx?: unknown,
  ): Promise<DueReferralCommission | null>;

  /** Whether this referral already has an EARNED commission other than `exceptId`. */
  hasEarnedForReferral(
    scope: TenantContext,
    referralId: string,
    exceptId: string,
    tx: unknown,
  ): Promise<boolean>;

  /** `PENDING -> EARNED`, conditional. False when the row had already moved. */
  earn(
    scope: TenantContext,
    id: string,
    input: { readonly earnedAmount: bigint; readonly entryId: string | null; readonly now: Date },
    tx: unknown,
  ): Promise<boolean>;

  /** `PENDING -> VOID`, conditional. */
  void(scope: TenantContext, id: string, now: Date, tx: unknown): Promise<boolean>;

  reversals(
    scope: TenantContext,
    commissionId: string,
    tx?: unknown,
  ): Promise<readonly ReferralCommissionReversalRecord[]>;

  /** One per refund. True when this call wrote it. */
  recordReversal(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly commissionId: string;
      readonly orderId: string;
      readonly referrerId: string;
      readonly refundId: string;
      readonly due: bigint;
      readonly recovered: bigint;
      readonly unrecovered: bigint;
      readonly currency: CurrencyCode;
      readonly walletEntryId: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean>;

  list(
    scope: TenantContext,
    filter: { readonly state?: ReferralCommissionState; readonly referrerId?: string },
    limit: number,
    cursor: ReferralCursor | null,
  ): Promise<{
    readonly items: readonly ReferralCommissionListing[];
    readonly next: ReferralCursor | null;
  }>;

  totalsForReferrer(scope: TenantContext, referrerId: string): Promise<readonly ReferralTotals[]>;
}

// --- The signup gift (docs/customer-ux-completion-audit.md §I) -------------------

/** One referral's gift row: the terms snapshotted at the first claim, and each side's stamp. */
export interface ReferralSignupGiftRecord {
  readonly id: string;
  readonly referralId: string;
  readonly referrerId: string;
  readonly refereeId: string;
  readonly total: Money;
  readonly referrerAmount: bigint;
  readonly refereeAmount: bigint;
  readonly referrerEntryId: string | null;
  readonly refereeEntryId: string | null;
  readonly referrerClaimedAt: Date | null;
  readonly refereeClaimedAt: Date | null;
  readonly createdAt: Date;
}

/**
 * A side of a referral a customer has not been paid for. `snapshotAmount` is the gift
 * row's figure for that side, or null while no row exists yet — in which case the
 * current terms decide whether there is anything to claim.
 */
export interface OpenReferralSignupGiftSide {
  readonly referralId: string;
  readonly side: ReferralSignupGiftSide;
  readonly snapshotAmount: bigint | null;
}

/** What a referrer's referees have bought and had delivered, in one currency. */
export interface ReferredPurchaseTotals {
  readonly count: number;
  readonly total: bigint;
}

export interface ReferralSignupGiftRepository {
  /**
   * Every side of every referral this customer is party to that has not been stamped
   * claimed, with the snapshotted amount when a gift row exists. Never locks: it decides
   * whether a button is drawn, and the claim re-decides under the lock.
   */
  openSides(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<readonly OpenReferralSignupGiftSide[]>;

  /**
   * The referrals this customer is party to, `FOR UPDATE`, in id order. The stable order
   * is what keeps two claimants who share a referral from locking in opposite orders.
   */
  lockReferralsOf(
    scope: TenantContext,
    customerId: string,
    tx: unknown,
  ): Promise<readonly ReferralRecord[]>;

  /** The gift row of one referral, `FOR UPDATE` when asked. Null until the first claim. */
  findByReferral(
    scope: TenantContext,
    referralId: string,
    options: { readonly forUpdate: boolean },
    tx: unknown,
  ): Promise<ReferralSignupGiftRecord | null>;

  /** One per referral, by the unique index. True when this call wrote it. */
  insert(
    scope: TenantContext,
    draft: {
      readonly id: string;
      readonly referralId: string;
      readonly referrerId: string;
      readonly refereeId: string;
      readonly total: Money;
      readonly referrerAmount: bigint;
      readonly refereeAmount: bigint;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean>;

  /**
   * Stamps one side claimed, conditionally: `WHERE <side>_claimed_at IS NULL`. False when
   * the side had already been stamped, which is the caller's signal to write nothing.
   */
  claimSide(
    scope: TenantContext,
    giftId: string,
    side: ReferralSignupGiftSide,
    stamp: { readonly entryId: string; readonly now: Date },
    tx: unknown,
  ): Promise<boolean>;

  /** Delivered, paid-for orders of this referrer's referees, in `currency`. */
  referredPurchases(
    scope: TenantContext,
    referrerId: string,
    currency: CurrencyCode,
    tx?: unknown,
  ): Promise<ReferredPurchaseTotals>;

  /** `REFERRAL_COMMISSION` credits minus `REFERRAL_COMMISSION_REVERSAL` debits, from the ledger. */
  netCommission(
    scope: TenantContext,
    customerId: string,
    currency: CurrencyCode,
    tx?: unknown,
  ): Promise<bigint>;
}
