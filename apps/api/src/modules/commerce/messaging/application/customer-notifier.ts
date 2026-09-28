import type {
  BotInstanceId,
  CustomerNotificationKind,
  IdGenerator,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerNotificationRepository } from './ports.js';

/**
 * Which bot a customer is reachable on.
 *
 * A NARROW port, for the reason `CustomerContactReader` gives one module away: handing
 * a producer the customer repository would also hand it `setStatus`, and therefore the
 * ability to block a customer from inside a payment sweep.
 *
 * `null` means there is no durable customer-to-bot link, which is the same answer
 * `CustomerContactReader` calls `NONE`. It is never "fall back to the tenant's active
 * bot": a customer wrote to a specific bot, and a message from a different one arrives
 * from an account they have never heard of.
 */
export interface CustomerBotReader {
  botFor(
    scope: TenantContext,
    customerId: UserId,
    tx: TransactionScope,
  ): Promise<BotInstanceId | null>;
}

/**
 * The one way a producer queues a customer notification.
 *
 * A single object rather than each producer building its own row, because the parts that
 * are easy to get wrong are the same every time: the id has to exist before the insert,
 * the bot has to be the customer's own, and the write has to be INSIDE the caller's
 * transaction. A producer that assembled this itself could get any of the three wrong
 * and nothing would fail until a customer was not told.
 *
 * Every method takes the caller's `tx` and none of them opens one. A notification
 * enqueued outside the transaction that produced its fact is a notification that can
 * exist without the fact, or the fact without it.
 */
export class CustomerNotifier {
  constructor(
    private readonly deps: {
      readonly notifications: CustomerNotificationRepository;
      readonly bots: CustomerBotReader;
      readonly ids: IdGenerator;
    },
  ) {}

  /**
   * Queues one, and answers whether this call is the one that queued it.
   *
   * `false` covers two different situations and the caller acts on neither:
   *
   *   - the customer has no bot link, so there is nobody to send to. Not an error: a
   *     customer row can exist before any durable link does, and refusing the whole
   *     business transaction because a notification cannot be addressed would let a
   *     messaging concern veto a payment.
   *   - `customer_notifications_subject_key` already holds one. Told-once is the lane's
   *     contract; a replay, a second replica and a redelivered outbox message all land
   *     here and all must be no-ops.
   */
  async notify(
    scope: TenantContext,
    customerId: UserId,
    kind: CustomerNotificationKind,
    subjectId: string,
    now: Date,
    tx: TransactionScope,
    /**
     * The earliest the dispatcher may try, when the caller already knows one.
     *
     * Optional and trailing, so every background producer stays as it was: a
     * fact that just became true is due now. Only the rate-limit fallback
     * passes it, carrying the `retry_after` Telegram answered the interactive
     * send with — see `CustomerNotificationEnqueue.nextAttemptAt`.
     */
    notBefore?: Date | null,
  ): Promise<boolean> {
    const botInstanceId = await this.deps.bots.botFor(scope, customerId, tx);
    if (botInstanceId === null) return false;
    return this.enqueue(scope, customerId, botInstanceId, kind, subjectId, now, tx, notBefore);
  }

  /**
   * Queues one through a bot the SUBJECT names, rather than the customer's first bot.
   *
   * WP-A7: a support ticket is a conversation with ONE bot — the one the customer opened it
   * through — and a reply sent from another bot of the tenant arrives from an account the
   * customer did not write to, which for a tenant running a public bot and a reseller bot
   * exposes the link between them (Codex review of #96). The bot is a fact of the subject,
   * read by the producer in its own transaction; the row still carries a kind and an id and
   * nothing else, so the lane still carries no payload (ADR 0030 §1).
   */
  async notifyThrough(
    scope: TenantContext,
    customerId: UserId,
    botInstanceId: BotInstanceId,
    kind: CustomerNotificationKind,
    subjectId: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    return this.enqueue(scope, customerId, botInstanceId, kind, subjectId, now, tx, null);
  }

  private enqueue(
    scope: TenantContext,
    customerId: UserId,
    botInstanceId: BotInstanceId,
    kind: CustomerNotificationKind,
    subjectId: string,
    now: Date,
    tx: TransactionScope,
    notBefore: Date | null | undefined,
  ): Promise<boolean> {
    return this.deps.notifications.enqueue(
      scope,
      {
        id: this.deps.ids.uuid(),
        customerId,
        botInstanceId,
        kind,
        subjectId,
        nextAttemptAt: notBefore ?? null,
      },
      now,
      tx,
    );
  }
}
