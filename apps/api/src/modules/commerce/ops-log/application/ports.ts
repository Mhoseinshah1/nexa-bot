import type {
  Money,
  OpsLogButton,
  OpsLogTypeId,
  ScopeContext,
  TemplateKey,
  TemplateValues,
  TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { NightlyReportData } from './nightly-report.js';

/**
 * Round 4 PR-D — what the operations log group's builders read and write.
 *
 * Every figure a log prints comes from a FACT read here — the ledger, the orders, the
 * services — never from a value a producer carried along, and never recomputed from a
 * balance column (there is none). The builders (`presenters.ts`) are pure functions over
 * these facts, so a message can be rendered and asserted without a database.
 */

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export interface CustomerFact {
  readonly id: string;
  readonly telegramUserId: string;
  readonly username: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  /** A VERIFIED phone number only; null when nobody verified one. */
  readonly phone: string | null;
  /** `NEXA`, or the legacy bot's name for an imported row — an imported row never logs. */
  readonly source: string;
  readonly status: string;
  readonly blockedReason: string | null;
}

export interface AdminFact {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly telegramUserId: string | null;
  readonly roleNames: readonly string[];
  readonly roleKeys: readonly string[];
  readonly permissionCount: number;
}

export interface LedgerEntryFact {
  readonly id: string;
  readonly customerId: string;
  readonly direction: 'CREDIT' | 'DEBIT';
  readonly reason: string;
  readonly amount: Money;
  readonly reference: string;
  readonly orderId: string | null;
  readonly paymentId: string | null;
  readonly actorAdminId: string | null;
  readonly note: string | null;
  readonly createdAt: Date;
}

/** A wallet's balance on either side of one or more of ITS OWN entries. */
export interface BalanceAround {
  readonly before: Money;
  readonly after: Money;
}

export interface PaymentFact {
  readonly id: string;
  readonly code: string | null;
  readonly reference: string;
  readonly method: string;
  readonly gatewayProvider: string | null;
  readonly amount: Money;
  readonly state: string;
}

export interface OrderFact {
  readonly id: string;
  readonly code: string | null;
  readonly customerId: string;
  readonly purpose: string;
  readonly origin: string;
  readonly source: string;
  readonly state: string;
  readonly title: string;
  readonly durationDays: number;
  readonly trafficBytes: bigint;
  readonly panelId: string;
  readonly panelName: string;
  readonly locationLabel: string | null;
  readonly subtotal: Money;
  readonly discount: Money;
  readonly total: Money;
  readonly settledAt: Date | null;
  /** The customer's first settled purchase of a service (a trial is not one). */
  readonly isFirstPurchase: boolean;
  /** An `order_reseller_terms` row exists: the order was sold at a reseller's standing. */
  readonly reseller: boolean;
  /** The product's list price recorded with the reseller terms; null for an ordinary order. */
  readonly resellerListPrice: Money | null;
}

/**
 * Who created an order and from where, read from the audit row written in the creating
 * transaction (R9 C2). The source line of a purchase / renewal / extra traffic / extra time
 * log is its `surface`; an order an administrator placed from the Web Admin is told apart by
 * `actorType === 'WEB_ADMIN'`.
 */
export interface OrderOriginFact {
  /** `audit_logs.source_surface`: `TELEGRAM`, `WEB`, `MINI_APP`, … */
  readonly surface: string;
  readonly actorType: string;
  /** The acting administrator's id when `actorType` is `WEB_ADMIN` and the id is a uuid. */
  readonly actorId: string | null;
  /** The label captured at action time, so the message survives a deleted administrator. */
  readonly actorLabel: string | null;
  /**
   * Round 10, D1: present (and true) when an automatic-renewal run paid this order — decided
   * by the run row that names it, never by the surface an order was written from.
   */
  readonly autoRenew?: true;
}

export interface ServiceFact {
  readonly id: string;
  readonly code: string | null;
  readonly customerId: string;
  readonly orderId: string;
  readonly panelId: string;
  readonly panelName: string;
  readonly providerUsername: string;
  readonly isTrial: boolean;
  readonly state: string;
  readonly expiresAt: Date | null;
  readonly trafficLimitBytes: bigint;
  readonly trafficUsedBytes: bigint;
  readonly lastSeenAt: Date | null;
  readonly source: string;
}

export interface OperationFact {
  readonly id: string;
  readonly type: string;
  readonly state: string;
  readonly serviceId: string;
  readonly orderId: string | null;
  readonly requestedByCustomerId: string | null;
  readonly panelId: string;
  readonly failureKind: string | null;
  readonly failureMessage: string | null;
  readonly targetExpiresAt: Date | null;
  readonly targetTrafficLimitBytes: bigint | null;
  readonly completedAt: Date | null;
}

/** What an operation changed on a service, read from the audit row written with it. */
export interface ServiceBeforeImage {
  readonly expiresAt: Date | null;
  readonly trafficLimitBytes: bigint | null;
  readonly trafficUsedBytes: bigint | null;
}

export interface TicketFact {
  readonly id: string;
  readonly number: string;
  readonly code: string | null;
  readonly customerId: string;
  readonly categoryTitle: string;
  readonly snippetSource: string | null;
  /**
   * `audit_logs.source_surface` of the audit row written with the message (R9 C2); null when
   * none is recorded, which the log reads as the bot.
   */
  readonly surface: string | null;
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

/**
 * The facts a log builder reads. Every method is tenant-scoped, runs in the caller's
 * transaction, and answers null for a row that is gone — a log never fails a transaction
 * for want of a fact.
 */
/**
 * R8 A4: one mass wallet credit as its summary message states it — the per-customer amount,
 * the operation's own note and notify switch, and what the LEDGER says it credited (the
 * `MASS_CREDIT` entries its items name), never the planned audience size.
 */
export interface MassCreditFact {
  readonly id: string;
  readonly amount: Money;
  readonly note: string;
  readonly notify: boolean;
  readonly createdByAdminId: string;
  readonly credited: number;
  readonly skipped: number;
  readonly total: Money;
}

/** R10 D4: what a gift card redemption's log names besides the money: the batch, the code, the surface. */
export interface GiftCardRedemptionFact {
  readonly batchLabel: string;
  readonly last4: string;
  /** `audit_logs.source_surface` of the redemption's audit row; null when there is none. */
  readonly surface: string | null;
}

/** R10 D4: a gift card batch, as its creation log prints it. */
export interface GiftCardBatchFact {
  readonly id: string;
  readonly label: string;
  readonly amount: Money;
  readonly codeCount: number;
  readonly expiresAt: Date;
  readonly reason: string;
  readonly createdByAdminId: string | null;
}

export interface OpsLogFacts {
  customer(scope: TenantContext, id: string, tx: TransactionScope): Promise<CustomerFact | null>;
  /** R10 D4: the redeemed code's batch label, last four symbols and surface; null for none. */
  giftCardRedemption(
    scope: TenantContext,
    codeId: string,
    tx: TransactionScope,
  ): Promise<GiftCardRedemptionFact | null>;
  /** R10 D4: one gift card batch, or null. */
  giftCardBatch(
    scope: TenantContext,
    batchId: string,
    tx: TransactionScope,
  ): Promise<GiftCardBatchFact | null>;
  /** R8 A4: a WALLET_CREDIT bulk operation's summary; null for any other kind or none credited. */
  massCredit(
    scope: TenantContext,
    operationId: string,
    tx: TransactionScope,
  ): Promise<MassCreditFact | null>;
  admin(scope: TenantContext, id: string, tx: TransactionScope): Promise<AdminFact | null>;
  /** The display names of roles, by their keys. A key with no role is absent from the map. */
  roleNames(
    scope: TenantContext,
    keys: readonly string[],
    tx: TransactionScope,
  ): Promise<ReadonlyMap<string, string>>;
  /** How many distinct permissions the roles with these keys grant together. */
  permissionCountOf(
    scope: TenantContext,
    keys: readonly string[],
    tx: TransactionScope,
  ): Promise<number>;
  ledgerEntry(
    scope: TenantContext,
    id: string,
    tx: TransactionScope,
  ): Promise<LedgerEntryFact | null>;
  /**
   * The wallet on either side of these entries, derived from the ledger: `after` is the sum of
   * every entry of the customer up to and including the LAST of them in COMMIT order, and
   * `before` is `after` minus their own signed sum. Never a stored balance.
   *
   * Commit order is the per-customer sequence of the entries' `WalletEntryRecorded` events
   * (`aggregate_sequences` is a row lock every wallet writer takes, held to commit), never
   * `created_at`: a writer stamps its entry BEFORE it waits for the customer lock, so the
   * entry that waited can carry the earlier stamp. An entry without an event (none is
   * written that way today) is placed by `(created_at, id)`. Null when none of the entries
   * is the customer's in that currency.
   */
  balanceAround(
    scope: TenantContext,
    customerId: string,
    currency: Money['currency'],
    entryIds: readonly string[],
    tx: TransactionScope,
  ): Promise<BalanceAround | null>;
  /** The ledger entry written under this idempotency reference, or null. */
  ledgerEntryByReference(
    scope: TenantContext,
    reference: string,
    tx: TransactionScope,
  ): Promise<LedgerEntryFact | null>;
  /** The ledger entries one payment wrote with these reasons, oldest first. */
  entriesOfPayment(
    scope: TenantContext,
    paymentId: string,
    reasons: readonly string[],
    tx: TransactionScope,
  ): Promise<readonly LedgerEntryFact[]>;
  /** The ledger entries of one order with this reason, oldest first. */
  entriesOfOrder(
    scope: TenantContext,
    orderId: string,
    reason: string,
    tx: TransactionScope,
  ): Promise<readonly LedgerEntryFact[]>;
  payment(scope: TenantContext, id: string, tx: TransactionScope): Promise<PaymentFact | null>;
  /** The confirmed payment of an order, or null. */
  paymentOfOrder(
    scope: TenantContext,
    orderId: string,
    tx: TransactionScope,
  ): Promise<PaymentFact | null>;
  order(scope: TenantContext, id: string, tx: TransactionScope): Promise<OrderFact | null>;
  /**
   * R9 C2: who created the order and from which surface — the `order.draft_create` audit row
   * of a new service, or the `service.<kind>_draft` row of a renewal / extra traffic / extra
   * time. Null when no such row exists (an order from before it was audited, or an import).
   */
  orderOrigin(
    scope: TenantContext,
    orderId: string,
    tx: TransactionScope,
  ): Promise<OrderOriginFact | null>;
  service(scope: TenantContext, id: string, tx: TransactionScope): Promise<ServiceFact | null>;
  operation(scope: TenantContext, id: string, tx: TransactionScope): Promise<OperationFact | null>;
  /**
   * The service as it was BEFORE the operation of this order changed it, from the audit row
   * the provisioner wrote in the same transaction as the change. Null when no such row exists
   * (an operation from before it was recorded this way): the log then omits the "before"
   * rather than invent one.
   */
  serviceBefore(
    scope: TenantContext,
    serviceId: string,
    action: string,
    orderId: string,
    tx: TransactionScope,
  ): Promise<ServiceBeforeImage | null>;
  /** The latest operation that tried to deliver this order and did not succeed, or null. */
  failedOperationOfOrder(
    scope: TenantContext,
    orderId: string,
    tx: TransactionScope,
  ): Promise<OperationFact | null>;
  /** The closed reason code the refund of an undeliverable order recorded, or null. */
  undeliverableReason(
    scope: TenantContext,
    orderId: string,
    tx: TransactionScope,
  ): Promise<string | null>;
  /**
   * The latest operation completed by `until` that changes a service's link — a rotation or a
   * location change — and who asked for it (a customer id, or null when an operator did). The
   * fallback for an event that does not name its operation.
   */
  latestLinkOperation(
    scope: TenantContext,
    serviceId: string,
    /** Only operations completed by this instant: the event's own time. */
    until: Date,
    tx: TransactionScope,
  ): Promise<{ readonly type: string; readonly requestedByCustomerId: string | null } | null>;
  /** How many link rotations the service had in the 30 days up to `until`, this one included. */
  rotationsInLast30Days(
    scope: TenantContext,
    serviceId: string,
    until: Date,
    tx: TransactionScope,
  ): Promise<number>;
  /** The referrer of a customer, or null. */
  referrerOf(scope: TenantContext, refereeId: string, tx: TransactionScope): Promise<string | null>;
  /**
   * The referral a signup-gift ledger reference names: the two customers and the referral
   * row's own provenance (`NEXA`, or `MIRZA` for an attribution the import carried), or null.
   */
  referralOf(
    scope: TenantContext,
    referralId: string,
    tx: TransactionScope,
  ): Promise<{
    readonly referrerId: string;
    readonly refereeId: string;
    readonly source: string;
  } | null>;
  ticket(
    scope: TenantContext,
    id: string,
    messageId: string,
    tx: TransactionScope,
  ): Promise<TicketFact | null>;
  /**
   * The operational-event rows a recovery event closed, as the earliest first-seen time among
   * them — when the condition began. Null when it closed none.
   */
  conditionClosedBy(
    scope: TenantContext,
    recoveryEventId: string,
    tx: TransactionScope,
  ): Promise<Date | null>;
  /** The panel's name, or null. */
  panelName(scope: TenantContext, id: string, tx: TransactionScope): Promise<string | null>;
  /**
   * Round 5A item 1: how many DISTINCT customers of this bot still have a notification of this
   * kind that was not delivered — queued (`PENDING`) or refused (`FAILED`). The "customers
   * affected" of a failing-send message.
   */
  undeliveredCustomerCount(
    scope: TenantContext,
    botInstanceId: string,
    notificationKind: string,
    tx: TransactionScope,
  ): Promise<number>;
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

/**
 * The Persian words the builders need (`OPS_LOG_WORDS_FA`). A port because application code
 * may not import the catalogue package; the container binds the real table.
 */
export interface OpsLogWords {
  readonly noName: string;
  readonly noUsername: string;
  readonly noTelegram: string;
  readonly none: string;
  methodName(method: string, gatewayProvider: string | null): string;
  gatewayName(provider: string | null): string;
  /** How a gateway payment was paid, as the provider reported it (`online` | `card`), or null. */
  providerMethodName(method: string | null): string | null;
  evidenceName(kind: string | null): string;
  paymentFailure(cause: string): string;
  /**
   * R8 A3: the real cause of a gateway failure, from the provider's status or the machine code
   * the payment was closed with; an unknown code is the generic sentence with the code beside it.
   */
  gatewayFailureCause(code: string | null): string;
  /** R8 A3: who cancelled an invoice. */
  cancelledBy(by: 'CUSTOMER' | 'NEXA' | 'PROVIDER'): string;
  /** R8 A3: a rejected receipt's reasons, prefixed by who rejected it. */
  rejectReasons(by: 'OPERATOR' | 'PROVIDER', reasons: readonly string[]): string;
  /** R8 A4: whether the customer is sent a message about an administrator's change. */
  customerNotified(yes: boolean): string;
  customerNotifiedBulk(yes: boolean): string;
  refundChannel(channel: string): string;
  refundFailure(cause: string): string;
  refundRequestOutcome(outcome: string): string;
  cryptoKindTitle(topup: boolean): string;
  walletAdjustHeading(direction: 'CREDIT' | 'DEBIT'): string;
  /** `" · 🥇 اولین خرید · 🧑‍💼 نماینده"`, or null when neither applies. */
  badges(badges: { readonly firstPurchase: boolean; readonly reseller: boolean }): string | null;
  /**
   * R9 C2: where a request came from, in Persian: `BOT` (ربات) or `MINI_APP` (مینی‌اپ); Round 10
   * D1: `AUTO_RENEW` (تمدید خودکار) for a renewal the worker made on the customer's consent.
   */
  sourceName(source: 'BOT' | 'MINI_APP' | 'AUTO_RENEW'): string;
  /** R9 C2: the value of the «first purchase of the customer» line. */
  readonly firstPurchaseYes: string;
  failedOperation(type: string): string;
  /** What a paid order was for (log L2): خرید / تمدید / حجم / زمان, by the order's purpose. */
  paidOperation(purpose: string): string;
  operationState(state: 'FAILED' | 'UNKNOWN'): string;
  byWhom(kind: 'CUSTOMER' | 'ADMIN' | 'SYSTEM'): string;
  providerFailure(kind: string | null): string;
  /** Why an undeliverable order was refunded: the recorded reason, else the failure kind. */
  refundReason(reason: string | null, failureKind: string | null): string;
  paymentLinkCause(kind: string): string;
  retry(kind: 'YES' | 'NO' | 'UNKNOWN'): string;
  impact(kind: string): string;
  serviceState(state: string): string;
  reminderHeading(kind: string): string;
  /** Round 5A item 1: a customer notification kind in Persian; a kind this build lacks is a Persian word too. */
  notificationKindName(kind: string | null): string;
  /** Round 5A item 1: the labels and causes of the failing-send message. */
  customerSend: {
    cause(reason: string): string;
    readonly kindLabel: string;
    readonly customersLabel: string;
  };
  timeLeft(days: number | null): string;
  panelSalesStopped(stopped: boolean): string;
  downtime(minutes: number): string;
  block(kind: 'blocked' | 'unblocked' | 'manual' | 'spam' | 'until'): string;
  adminHeading(kind: 'created' | 'rolesChanged' | 'disabled' | 'enabled'): string;
  noRole: string;
  system: string;
  resellerHeading(change: string): string;
  resellerOrdinary: string;
  stormHeading: string;
  eventTitle(code: string): string;
  /** The Persian sentence of an event's English log message, or null where the message already reads. */
  eventMessage?(code: string): string | null;
  /** The Persian title of a stalled NON-PROVISION operation; null for an unknown type. */
  stalledOperationTitle(operationType: string): string | null;
  /**
   * The words of a stalled / recovered background loop (`job.loop_stalled`, `job.loop_recovered`):
   * the Persian name of the loop and of the process role, each falling back to a Persian
   * «unknown» phrase, and the label of the line that names the role.
   */
  loopStall: {
    loopName(loop: string): string;
    roleName(role: string): string;
    roleLabel: string;
  };
  /** R11 A3: the words of a role that keeps restarting (`process.restart_storm`) and of its end. */
  restartStorm: {
    heading(role: string): string;
    endedHeading(role: string): string;
    detail(restarts: string, minutes: string): string;
  };
  severity(klass: string): string;
  cleanupLine(countText: string): string;
  /** Round 9 C3: the data compaction's part of the cleanup line; `parts` is already worded. */
  compactionLine(applied: boolean, parts: string): string;
  compactionClass(cls: string): string;
  reportHealth(state: string): string;
  reportMethod(key: string): string;
  reportUnit(kind: 'gb' | 'orders'): string;
  reportNoActivity: string;
  reportResellers: string;
  /** R9 C2: the heading of the nightly top-resellers block. */
  reportTopResellers: string;
}

// ---------------------------------------------------------------------------
// The lane
// ---------------------------------------------------------------------------

/** What a builder hands the notification lane. `NotificationService.queue` is it. */
export interface OpsLogLane {
  queue(
    scope: ScopeContext,
    input: {
      readonly kind: 'OPERATIONAL_EVENT';
      readonly dedupeKey: string;
      readonly templateKey: TemplateKey;
      readonly values: TemplateValues;
      readonly correlationId?: string;
      readonly logType: OpsLogTypeId;
      readonly buttons?: readonly OpsLogButton[];
      readonly storm?: {
        readonly key: string;
        readonly customer: string | null;
        readonly rollup: {
          readonly heading: string;
          readonly cause: string;
          readonly technical?: string;
          readonly panelName?: string;
        };
      };
    },
    tx?: unknown,
  ): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// The nightly reports
// ---------------------------------------------------------------------------

/** One report day and the one before it, both half-open `[start, end)`. */
export interface NightlyReportWindow {
  readonly start: Date;
  readonly end: Date;
  readonly previousStart: Date;
  readonly previousEnd: Date;
  readonly currency: Money['currency'];
  /** The IANA zone the «best hour» is read in. */
  readonly timezone: string;
}

export interface NightlyReportReader {
  /** Whether a notification under this dedupe key exists: the report was already queued. */
  alreadyPosted(scope: TenantContext, dedupeKey: string, tx: TransactionScope): Promise<boolean>;
  read(
    scope: TenantContext,
    window: NightlyReportWindow,
    tx: TransactionScope,
  ): Promise<Omit<NightlyReportData, 'day'>>;
}
