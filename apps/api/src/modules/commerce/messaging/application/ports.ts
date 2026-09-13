import type { BotInstanceId, TemplateKey, TemplateValues, TenantContext } from '@nexa/contracts';

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
