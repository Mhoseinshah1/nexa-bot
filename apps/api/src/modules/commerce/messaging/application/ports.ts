import type {
  BotInstanceId,
  CustomerNotificationKind,
  CustomerNotificationState,
  Money,
  TemplateKey,
  TemplateValues,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * What a button says.
 *
 * Two kinds, because there are two kinds of text on a button and only one of them is
 * ours. A label like "Confirm the order" is catalogue text and travels as a KEY, so a
 * tenant can reword it and `nexa-conventions` is not broken by a literal in a surface.
 * A product's title is the TENANT'S OWN DATA and has no key — it is the same string the
 * order snapshot copies, and routing it through the catalogue would mean inventing a
 * template key per product.
 *
 * `amount` exists so a catalogue button can read "Basic plan — 250,000 Toman" without a
 * caller formatting money itself. The formatting is the messenger's, using the shared
 * `formatMoney`, so a price on a button and a price in a message cannot be written two
 * different ways.
 */
export type CustomerButtonLabel =
  | { readonly kind: 'TEMPLATE'; readonly key: TemplateKey }
  | { readonly kind: 'TEXT'; readonly text: string; readonly amount?: Money };

/**
 * One inline-keyboard button.
 *
 * `data` is Telegram's `callback_data`, which it caps at 64 BYTES — a real constraint
 * rather than a guideline, and the reason Phase 0 recorded that a bare UUID plus a route
 * prefix leaves nothing. The callers here send `<one letter>:<uuid>`, which is 38 bytes,
 * so an opaque reference table is not needed and is deliberately not introduced.
 */
export interface CustomerButton {
  readonly label: CustomerButtonLabel;
  readonly data: string;
}

/**
 * One message to one customer.
 *
 * The text is NOT here. A template key and its values are, because
 * `nexa-conventions` forbids a string literal in a surface and because the rendering
 * has to happen where the tenant's overrides live. A caller that could pass text would
 * be a caller that could bypass the catalogue.
 */
export interface CustomerMessage {
  /** Telegram's numeric chat id for a private chat — the customer's own id. */
  readonly chatId: string;
  readonly templateKey: TemplateKey;
  readonly values: TemplateValues;
  /**
   * Which bot to send from.
   *
   * Required, and never "the tenant's active bot". A customer wrote to a specific bot
   * and a reply from a different one arrives from an account they have never heard of —
   * which, for a tenant running a public bot and a reseller bot, leaks the relationship
   * between them. The notification transport's `activeTokenForTenant` is correct for
   * operations messages and wrong for this.
   */
  readonly botInstanceId: BotInstanceId;
  /**
   * An inline keyboard, ONE BUTTON PER ROW.
   *
   * A single column rather than a grid: the labels are product titles in Persian and a
   * two-column layout truncates them at exactly the width where two plans stop being
   * distinguishable. Absent means no keyboard at all, which is not the same as an empty
   * one — Telegram renders an empty `inline_keyboard` as a message with a blank
   * attachment.
   */
  readonly buttons?: readonly CustomerButton[];
}

/**
 * Whether a customer-facing send landed.
 *
 * Three outcomes, not two, and the third is the point — the same shape `backup.ts` and
 * `payment.ts` already use. `UNKNOWN` means Telegram may have delivered it: a timeout,
 * a 5xx, a 429, or a 2xx whose body would not parse. Nothing here retries
 * automatically, because a retried greeting is noise and a retried "your service is
 * ready" is a customer wondering which one is true.
 */
export type CustomerSendOutcome = 'DELIVERED' | 'REFUSED' | 'UNKNOWN';

export interface CustomerMessenger {
  /**
   * Sends, and never throws for a send failure.
   *
   * A failure to greet a customer must not roll back the fact that they arrived, and a
   * thrown error on the webhook path becomes a non-2xx, which makes Telegram redeliver
   * the update — turning one failed send into an unbounded loop. So the outcome is
   * RETURNED and the caller decides, which for the webhook is "record it and answer
   * 200".
   */
  send(scope: TenantContext, message: CustomerMessage): Promise<CustomerSendOutcome>;

  /**
   * Stops the spinner on a tapped button. Best effort, and the outcome is not returned.
   *
   * Telegram spins the button until the bot answers the callback query, so NOT calling
   * this is a visible defect for several seconds on every tap. It is also purely
   * cosmetic: the durable work is already committed by the time this runs, and a
   * failure here must not change what the customer is told. So it cannot fail the turn
   * and has nothing to report — which is why it returns `void` rather than an outcome
   * nobody could act on.
   */
  acknowledge(
    scope: TenantContext,
    input: { readonly callbackQueryId: string; readonly botInstanceId: BotInstanceId },
  ): Promise<void>;
}

/**
 * Whether ONE bot instance's send-failure condition is still open.
 *
 * Declared here, by the consumer, rather than added to `OperationalConditionReader`
 * in the opslog module: this file already declares `CustomerTemplateRenderer` and
 * `BotInstanceTokenSource` as narrow ports for the same reason — a messenger that
 * held the whole operational-event reader could browse every tenant's operations
 * log, and a send path has no business being able to. `DrizzleOperationalConditionReader`
 * satisfies this structurally, so no adapter exists only to narrow it.
 *
 * The answer must come from the ROW, never from a field a process set on itself.
 * A process that remembers "I opened the condition" cannot resolve one it did not
 * open — a replica restart, or two replicas, and the condition stays open for ever
 * describing a failure that has ended. That exact defect is recorded on
 * `OperationalConditionReader` in the opslog module, where it was paid for once.
 */
export interface CustomerSendConditionReader {
  conditionIsOpen(scope: TenantContext, dedupeKey: string): Promise<boolean>;
}

/**
 * One queued customer notification, as the lane sees it.
 *
 * `ADR 0030` decides the lane and `customer_notifications` holds it. The producer's
 * half is `CustomerNotificationEnqueue`; everything else here belongs to the dispatcher.
 */
export interface CustomerNotificationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly customerId: UserId;
  readonly botInstanceId: BotInstanceId;
  readonly kind: CustomerNotificationKind;
  readonly subjectId: string;
  readonly state: CustomerNotificationState;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly sendStartedAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
}

/** What a producer supplies. The id is the caller's, so it exists before the insert. */
export interface CustomerNotificationEnqueue {
  readonly id: string;
  readonly customerId: UserId;
  readonly botInstanceId: BotInstanceId;
  readonly kind: CustomerNotificationKind;
  readonly subjectId: string;
}

export interface CustomerNotificationRepository {
  /**
   * Queues one notification, inside the caller's transaction, and says whether it is new.
   *
   * `false` means `customer_notifications_subject_key` already holds one for this
   * (tenant, kind, subject) — a replay, a second worker replica, or a redelivered
   * outbox message. The caller does NOT treat that as an error: told-once is the
   * lane's contract and the constraint is what enforces it.
   *
   * `tx` is REQUIRED, not optional. A notification enqueued outside the transaction
   * that produced the fact is a notification that can exist without the fact, or the
   * fact without it, and both are the failure this lane was built to end.
   */
  enqueue(
    scope: TenantContext,
    input: CustomerNotificationEnqueue,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Takes the notifications due now and leases them to this pass.
   *
   * `ServiceRepository.claimDeliveryDue` is the shape, including the part that is easy
   * to get wrong: a BLOCKED customer is excluded AT THE QUERY rather than skipped
   * afterwards, so a block pauses the lane and an unblock resumes it with no attempt
   * spent and nothing to remember.
   */
  claimDue(
    scope: TenantContext,
    now: Date,
    leaseUntil: Date,
    limit: number,
    tx?: unknown,
  ): Promise<readonly CustomerNotificationRecord[]>;

  /** Stamps a send as in flight, in its own transaction, before it leaves. */
  markSendStarted(
    scope: TenantContext,
    id: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Records a resolved outcome. Spends one attempt.
   *
   * For a DEFINITE refusal that has not reached the ceiling the state stays `PENDING`
   * and `nextAttemptAt` carries the backoff; every other call names a terminal state.
   */
  record(
    scope: TenantContext,
    id: string,
    to: CustomerNotificationState,
    stamps: { readonly resolvedAt: Date | null; readonly nextAttemptAt: Date | null },
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Records a RATE LIMIT: back to the queue, no attempt spent.
   *
   * Its own method rather than a flag on `record`, because the difference is exactly
   * the one ADR 0030 §2 exists to make and a boolean parameter is how it would be lost.
   * A 429 is Telegram declining to look at the message, not an outcome about it, so the
   * attempt counter — which bounds refusals OF THIS MESSAGE — must not move.
   */
  rateLimited(
    scope: TenantContext,
    id: string,
    retryAt: Date,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Resolves sends handed to Telegram by a process that then died, to `UNCONFIRMED`.
   *
   * `ServiceRepository.reapStrandedSends` for this lane. No attempt is spent either
   * way: an attempt means an outcome somebody observed, and nobody observed this one.
   */
  reapStranded(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<number>;
}
