import type {
  CashbackState,
  CurrencyCode,
  DiscountCodeCaptureCloseReason,
  DiscountKind,
  DiscountStatus,
  DiscountType,
  DiscountablePurpose,
  CashbackRuleStatus,
  Money,
  PriceQuoteCashback,
  TenantContext,
} from '@nexa/contracts';
import type { CashbackRule, DiscountRule, DiscountUsage } from '../domain/pricing-engine.js';

/**
 * The pricing module's ports (`docs/wp8-pricing-audit.md`).
 *
 * Three repositories, because they hold three different kinds of fact: the rules an
 * operator curates (discounts, cashback), and the per-order records a sale produces
 * (redemptions, the cashback promise and its reversals). Nothing here decides a price —
 * `pricing-engine.ts` does — and nothing in the engine reads a row.
 */

export interface DiscountRuleRecord extends DiscountRule {
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What an operator writes. `status` is absent: activation is its own command. */
export interface DiscountRuleWrite {
  readonly kind: DiscountKind;
  readonly code: string | null;
  readonly label: string;
  readonly type: DiscountType;
  readonly value: bigint;
  readonly currency: CurrencyCode | null;
  readonly appliesTo: readonly DiscountablePurpose[];
  readonly productId: string | null;
  readonly categoryId: string | null;
  readonly customerId: string | null;
  readonly firstPurchaseOnly: boolean;
  readonly minimumSubtotal: bigint | null;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly totalLimit: number | null;
  readonly perCustomerLimit: number | null;
  readonly priority: number;
  readonly stackable: boolean;
}

/** The admin list's cursor: the immutable `(createdAt, id)`. */
export interface RuleCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface DiscountRulePage {
  readonly items: readonly DiscountRuleRecord[];
  readonly nextCursor: RuleCursor | null;
}

export interface DiscountRuleSearch {
  readonly kind?: DiscountKind;
  readonly status?: DiscountStatus;
}

export interface RedemptionRecord {
  readonly discountId: string;
  readonly amount: Money;
  readonly createdAt: Date;
}

export interface DiscountRepository {
  /** Null when the code is already taken in this tenant — the unique index decides. */
  create(
    scope: TenantContext,
    id: string,
    write: DiscountRuleWrite,
    now: Date,
    tx?: unknown,
  ): Promise<DiscountRuleRecord | null>;

  update(
    scope: TenantContext,
    id: string,
    write: DiscountRuleWrite,
    now: Date,
    tx?: unknown,
  ): Promise<DiscountRuleRecord | null>;

  /** A conditional UPDATE naming its `from` state; false when the row did not move. */
  setStatus(
    scope: TenantContext,
    id: string,
    from: DiscountStatus,
    to: DiscountStatus,
    now: Date,
    tx?: unknown,
  ): Promise<boolean>;

  findById(scope: TenantContext, id: string, tx?: unknown): Promise<DiscountRuleRecord | null>;

  /** A `CODE` rule by its NORMALISED code, whatever its status. */
  findByCode(scope: TenantContext, code: string, tx?: unknown): Promise<DiscountRuleRecord | null>;

  /** Every `AUTOMATIC` rule that is `ACTIVE`. The window is the engine's question. */
  listLiveAutomatic(scope: TenantContext, tx?: unknown): Promise<readonly DiscountRuleRecord[]>;

  list(
    scope: TenantContext,
    search: DiscountRuleSearch,
    limit: number,
    cursor: RuleCursor | null,
    tx?: unknown,
  ): Promise<DiscountRulePage>;

  /**
   * LIVE redemptions per rule — whose order is `AWAITING_PAYMENT` or `PAID` — in total and
   * for one customer.
   *
   * `excludingOrderId` leaves one order's own redemptions out: a confirmation replayed
   * while its first attempt is committing must not count itself against the limit it is
   * checking (P6).
   */
  usage(
    scope: TenantContext,
    ruleIds: readonly string[],
    customerId: string | null,
    excludingOrderId: string | null,
    tx?: unknown,
  ): Promise<ReadonlyMap<string, DiscountUsage>>;

  /**
   * `SELECT … FOR UPDATE` on the rules, in id order, returning them as they are NOW.
   *
   * Id order so two confirmations redeeming overlapping sets cannot lock them in opposite
   * orders. Taken after the order's own lock, which is the outermost lock of this domain.
   */
  lockForRedemption(
    scope: TenantContext,
    ruleIds: readonly string[],
    tx: unknown,
  ): Promise<readonly DiscountRuleRecord[]>;

  /**
   * A transaction-scoped advisory lock on `(tenant, customer)` for the first-purchase
   * question. Only confirmation takes it, so it cannot close a cycle with any row lock.
   */
  lockFirstPurchase(scope: TenantContext, customerId: string, tx: unknown): Promise<void>;

  /** True when the customer has no OTHER `NEW_SERVICE` order in `AWAITING_PAYMENT` or `PAID`. */
  isFirstPurchase(
    scope: TenantContext,
    customerId: string,
    excludingOrderId: string | null,
    tx?: unknown,
  ): Promise<boolean>;

  /** Idempotent per `(order, rule)`. True when this call wrote the row. */
  recordRedemption(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly discountId: string;
      readonly customerId: string;
      readonly orderId: string;
      readonly amount: Money;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean>;

  redemptionsForOrder(
    scope: TenantContext,
    orderId: string,
    tx?: unknown,
  ): Promise<readonly RedemptionRecord[]>;
}

export interface CashbackRuleRecord extends CashbackRule {
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CashbackRuleWrite {
  readonly label: string;
  readonly percent: number;
  readonly appliesTo: readonly DiscountablePurpose[];
  readonly productId: string | null;
  readonly categoryId: string | null;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
}

export interface CashbackRulePage {
  readonly items: readonly CashbackRuleRecord[];
  readonly nextCursor: RuleCursor | null;
}

export interface CashbackRuleRepository {
  create(
    scope: TenantContext,
    id: string,
    write: CashbackRuleWrite,
    now: Date,
    tx?: unknown,
  ): Promise<CashbackRuleRecord>;
  update(
    scope: TenantContext,
    id: string,
    write: CashbackRuleWrite,
    now: Date,
    tx?: unknown,
  ): Promise<CashbackRuleRecord | null>;
  setStatus(
    scope: TenantContext,
    id: string,
    from: CashbackRuleStatus,
    to: CashbackRuleStatus,
    now: Date,
    tx?: unknown,
  ): Promise<boolean>;
  findById(scope: TenantContext, id: string, tx?: unknown): Promise<CashbackRuleRecord | null>;
  list(
    scope: TenantContext,
    search: { readonly status?: CashbackRuleStatus },
    limit: number,
    cursor: RuleCursor | null,
    tx?: unknown,
  ): Promise<CashbackRulePage>;
  /** Every `ACTIVE` rule. The window and the scope are the engine's questions. */
  listLive(scope: TenantContext, tx?: unknown): Promise<readonly CashbackRuleRecord[]>;
}

export interface OrderCashbackRecord {
  readonly id: string;
  readonly orderId: string;
  readonly customerId: string;
  readonly ruleId: string;
  readonly ruleLabel: string;
  readonly percent: number;
  readonly amount: Money;
  readonly state: CashbackState;
  readonly earnedAmount: bigint | null;
  readonly earnedEntryId: string | null;
  readonly earnedAt: Date | null;
  readonly voidedAt: Date | null;
}

export interface CashbackReversalRecord {
  readonly id: string;
  readonly refundId: string;
  readonly due: bigint;
  readonly recovered: bigint;
  readonly unrecovered: bigint;
  readonly walletEntryId: string | null;
  readonly createdAt: Date;
}

/**
 * A promise whose order has come to an end, for the earner (P9).
 *
 * `delivered` is the provisioner's own definition of delivery: an operation of type
 * `PURCHASED_AS[order.purpose]` for this order is `SUCCEEDED`. `ended` is the order
 * reaching `CANCELLED`, `EXPIRED` or `REFUNDED` without that.
 */
export interface DueCashback {
  readonly orderId: string;
  readonly delivered: boolean;
  readonly ended: boolean;
}

export interface OrderCashbackRepository {
  /** Idempotent per order. True when this call wrote the promise. */
  promise(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly orderId: string;
      readonly customerId: string;
      readonly cashback: PriceQuoteCashback;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<boolean>;

  findByOrder(
    scope: TenantContext,
    orderId: string,
    tx?: unknown,
  ): Promise<OrderCashbackRecord | null>;

  /** `SELECT … FOR UPDATE`. Taken AFTER the customer's wallet lock, never before. */
  lockByOrder(
    scope: TenantContext,
    orderId: string,
    tx: unknown,
  ): Promise<OrderCashbackRecord | null>;

  /** `PENDING` promises whose order was delivered or has ended, oldest first, bounded. */
  due(scope: TenantContext, limit: number, tx?: unknown): Promise<readonly DueCashback[]>;

  /** The same answer for one order, or null while its order is still in flight. */
  dueFor(scope: TenantContext, orderId: string, tx?: unknown): Promise<DueCashback | null>;

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
    orderCashbackId: string,
    tx?: unknown,
  ): Promise<readonly CashbackReversalRecord[]>;

  /** Idempotent per refund. True when this call wrote the row. */
  recordReversal(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly orderCashbackId: string;
      readonly orderId: string;
      readonly customerId: string;
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
}

/** An open window in which the customer's next plain message is a discount code (P11). */
export interface DiscountCodeCaptureRecord {
  readonly id: string;
  readonly botInstanceId: string;
  readonly customerId: string;
  readonly orderId: string;
  readonly openedAt: Date;
  readonly expiresAt: Date;
}

/**
 * `UsernameCaptureRepository`'s shape, for the same question: when may an ordinary
 * message be read as an answer. Every method takes the transaction, because every caller
 * holds the customer's window lock while it asks.
 */
export interface DiscountCodeCaptureRepository {
  /** Closes whatever discount-code window was open for this customer and bot, then opens one. */
  open(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly botInstanceId: string;
      readonly customerId: string;
      readonly orderId: string;
      readonly openedAt: Date;
      readonly expiresAt: Date;
    },
    tx: unknown,
  ): Promise<DiscountCodeCaptureRecord>;

  findOpen(
    scope: TenantContext,
    botInstanceId: string,
    customerId: string,
    tx: unknown,
  ): Promise<DiscountCodeCaptureRecord | null>;

  /** Conditional on still being open, so a redelivery cannot rewrite the reason. */
  close(
    scope: TenantContext,
    id: string,
    reason: DiscountCodeCaptureCloseReason,
    at: Date,
    tx: unknown,
  ): Promise<boolean>;
}
