import { z } from 'zod';
import type { StateMachineDefinition } from './state-machine.js';
import type { TemplateKey } from './templates.js';

/**
 * The lane that tells a customer something they did not ask for.
 *
 * Before Phase 4H this product could tell a customer exactly ONE such thing — the
 * subscription link, from `DeliveryService` — and Phases 4D–4G created several more:
 * a payment rejected or expired, an operation they asked for finishing or failing,
 * provisioning that has stalled. `docs/phase4h-audit.md` §1 measures that absence and
 * `ADR 0030` decides the shape; this file is the vocabulary both refer to.
 *
 * Why its own vocabulary rather than the Phase 2 `notifications` one: that lane's
 * destinations are OPERATOR channels and its `DELIVERY_OUTCOMES` enum is pinned by a
 * CHECK constraint. An operator alert that arrives late is still useful and a duplicate
 * is merely noise; for a customer both are different answers. ADR 0025 already records
 * what happens when one enum is made to serve two purposes.
 */

/**
 * What the lane can tell a customer.
 *
 * A closed set, and each member names a FACT rather than a screen — the template that
 * renders it is `CUSTOMER_NOTIFICATION_TEMPLATES` below, so a tenant rewording the
 * message does not change what the producer enqueued.
 *
 * Deliberately NOT a general "send this customer some text". A caller that could pass a
 * template key would be a caller that could bypass this list, and the list is what makes
 * `CUSTOMER_NOTIFICATION_PRECONDITIONS` exhaustive.
 */
export const CUSTOMER_NOTIFICATION_KINDS = [
  /** An operator rejected the manual transfer. `payments.id` is the subject. */
  'PAYMENT_REJECTED',
  /** The payment window closed with nothing confirmed. `payments.id` is the subject. */
  'PAYMENT_EXPIRED',
  /** The order's own window closed unpaid. `orders.id` is the subject. */
  'ORDER_EXPIRED',
  /** A customer-requested operation reached the panel. `services.id` is the subject. */
  'SERVICE_ACTION_SUCCEEDED',
  /** A customer-requested operation will not happen. `services.id` is the subject. */
  'SERVICE_ACTION_FAILED',
  /** Provisioning has not finished and is no longer prompt. `services.id` is the subject. */
  'SERVICE_PROVISION_DELAYED',
  /**
   * The customer's claim that they sent the transfer was recorded. `payments.id`
   * is the subject.
   *
   * ## Why an INTERACTIVE reply has a kind here at all
   *
   * `OQ-4H-01`: the durable write commits, the synchronous Telegram reply gets a
   * 429, and the customer is left believing nothing happened — so they send the
   * money twice, or they do not send it at all. Everything else in this lane is
   * something the customer did NOT ask for; these last two are the answer to
   * something they did.
   *
   * That does not make the lane a message queue, and this is the line that keeps
   * it from becoming one. The reply these stand in for carries `values: {}` and
   * `buttons: []` — it is a FACT about an entity with an id, which is exactly
   * what every other member of this list is. A reply that RENDERS state (a menu,
   * a catalogue, a service list) has no subject and no fact, and putting one here
   * would need a parameterised payload, which `ADR 0030` §1 refuses and which
   * would turn each of these into "send this customer some text".
   *
   * So the rule, stated once: a reply that is a fact about an entity the customer
   * just changed may fall back to this lane; a reply that renders state may not,
   * and is reproduced by the customer's next tap.
   */
  'PAYMENT_TRANSFER_RECORDED',
  /** The customer withdrew their own unpaid order. `orders.id` is the subject. */
  'ORDER_CANCELLED',
] as const;
export type CustomerNotificationKind = (typeof CUSTOMER_NOTIFICATION_KINDS)[number];
export const customerNotificationKindSchema = z.enum(CUSTOMER_NOTIFICATION_KINDS);

/**
 * Whether a kind's fact can stop being true between enqueue and send.
 *
 * ADR 0030 §3: staleness is per-kind and re-checked after the claim, NOT a TTL column.
 * Most of what the lane carries is a TERMINAL fact — rejected, expired, an operation
 * finished — and an hour-late one is still true and still actionable. One kind is a
 * claim about a transient state and is false the moment the state moves on: telling a
 * customer their service is delayed, a second after sending them the link, is worse than
 * not telling them at all.
 *
 * `true` here means the dispatcher MUST re-read the subject and confirm the fact still
 * holds before sending, and move the row to `SUPERSEDED` if it does not. `false` means
 * the producer's word is final. A kind added later has to choose, which is the friction
 * this table exists to create — the alternative is a "still working on it" message
 * arriving after the work finished, and nobody noticing until a customer says so.
 */
export const CUSTOMER_NOTIFICATION_PRECONDITIONS: Readonly<
  Record<CustomerNotificationKind, boolean>
> = {
  PAYMENT_REJECTED: false,
  PAYMENT_EXPIRED: false,
  ORDER_EXPIRED: false,
  SERVICE_ACTION_SUCCEEDED: false,
  SERVICE_ACTION_FAILED: false,
  SERVICE_PROVISION_DELAYED: true,
  /*
   * Both `false`, and both TERMINAL facts rather than claims about a transient
   * state. A recorded transfer stays recorded; a cancelled order stays cancelled.
   * An hour-late copy of either is still true and still worth reading, which is
   * the whole test this column applies.
   *
   * `DrizzleNotificationSubjectReader.stillHolds` REFUSES any kind declaring no
   * precondition, so neither of these ever reaches it. It also refuses any kind it
   * cannot ANSWER — it reads the `services` table and nothing else, so without that
   * second refusal, marking either of these `true` would have read `services` with a
   * payment or order id, found no row, and SUPERSEDED the message: the customer never
   * told, silently. Both refusals are asserted in
   * `tests/integration/customer-notifications.test.ts`.
   */
  PAYMENT_TRANSFER_RECORDED: false,
  ORDER_CANCELLED: false,
};

/**
 * The one template each kind renders as.
 *
 * Frozen here rather than chosen by the producer, and that is the whole reason the kinds
 * are a closed set. A producer that could pass a template key could send a customer any
 * string in the catalogue from a background loop, and the audit trail would say only
 * that "a notification" was sent.
 *
 * Two of the first six are keys that have existed with no producer since the phase that
 * declared them — `bot.order.expired` since 4B and `bot.service.provision_delayed`
 * since 4D. They were the right sentences all along and had no lane to travel on.
 */
export const CUSTOMER_NOTIFICATION_TEMPLATES: Readonly<
  Record<CustomerNotificationKind, TemplateKey>
> = {
  PAYMENT_REJECTED: 'bot.payment.rejected',
  PAYMENT_EXPIRED: 'bot.payment.expired',
  ORDER_EXPIRED: 'bot.order.expired',
  SERVICE_ACTION_SUCCEEDED: 'bot.service.action_succeeded',
  SERVICE_ACTION_FAILED: 'bot.service.action_failed',
  SERVICE_PROVISION_DELAYED: 'bot.service.provision_delayed',
  /*
   * The SAME keys the interactive path already renders.
   *
   * No new template, and that is the point: this lane is not saying something new,
   * it is delivering the sentence a 429 stopped. A second wording would mean a
   * customer who hit the rate limit read different words from one who did not.
   */
  PAYMENT_TRANSFER_RECORDED: 'bot.payment.received_for_review',
  ORDER_CANCELLED: 'bot.order.cancelled',
};

/**
 * Where a queued message gets to.
 *
 * `SERVICE_DELIVERY_STATES` is the parent of this list and the first four mean exactly
 * what they mean there, including the rule that matters most: `UNCONFIRMED` is never
 * retried automatically, because a retried "your payment was rejected" is a customer
 * wondering which message is true.
 *
 * - `PENDING` — queued, or definitely refused and not yet out of attempts. The only
 *   state the dispatcher claims. A definite refusal changed nothing, so it stays here
 *   rather than earning a fifth value; `SERVICE_DELIVERY_STATES` makes the same choice.
 *   A RATE LIMIT also stays here and is not an attempt — see
 *   `CUSTOMER_NOTIFICATION_MAX_ATTEMPTS`.
 * - `DELIVERED` — Telegram accepted it.
 * - `UNCONFIRMED` — the outcome was `UNKNOWN`: a timeout, a 5xx, or a 2xx whose body
 *   would not parse. The customer MAY have it. **A 429 is NOT one of these** — ADR 0030
 *   §2 states why, and it is the one place this list deliberately departs from the
 *   docblock on `SERVICE_DELIVERY_STATES`.
 * - `FAILED` — definitely refused `CUSTOMER_NOTIFICATION_MAX_ATTEMPTS` times. Something
 *   is wrong that another attempt will not fix: the customer has blocked the bot, or the
 *   token is dead.
 * - `SUPERSEDED` — claimed, then the precondition said the fact had stopped being true.
 *   Its own state rather than `DELIVERED` or `FAILED`, because it is neither: nothing was
 *   sent and nothing went wrong. Folding it into either would make one of those two
 *   counts a lie, and the counts are what an operator reads.
 */
export const CUSTOMER_NOTIFICATION_STATES = [
  'PENDING',
  'DELIVERED',
  'UNCONFIRMED',
  'FAILED',
  'SUPERSEDED',
] as const;
export type CustomerNotificationState = (typeof CUSTOMER_NOTIFICATION_STATES)[number];
export const customerNotificationStateSchema = z.enum(CUSTOMER_NOTIFICATION_STATES);

/** The states a background pass may act on. Everything else is resolved. */
export const CUSTOMER_NOTIFICATION_CLAIMABLE_STATES: readonly CustomerNotificationState[] = [
  'PENDING',
];

export type CustomerNotificationEvent = 'DELIVER' | 'LOSE_TRACK' | 'EXHAUST' | 'SUPERSEDE';

/**
 * Every exit from `PENDING`, and there is no way back into it.
 *
 * A refusal below the ceiling is not an edge here for the same reason it is not a state:
 * it leaves the row exactly as it was. The edges are the four ways a queued message stops
 * being queued.
 */
export const CUSTOMER_NOTIFICATION_MACHINE: StateMachineDefinition<
  CustomerNotificationState,
  CustomerNotificationEvent
> = {
  name: 'CustomerNotification',
  initial: 'PENDING',
  states: CUSTOMER_NOTIFICATION_STATES,
  terminal: ['DELIVERED', 'UNCONFIRMED', 'FAILED', 'SUPERSEDED'],
  transitions: [
    { from: 'PENDING', to: 'DELIVERED', on: 'DELIVER' },
    { from: 'PENDING', to: 'UNCONFIRMED', on: 'LOSE_TRACK' },
    { from: 'PENDING', to: 'FAILED', on: 'EXHAUST' },
    { from: 'PENDING', to: 'SUPERSEDED', on: 'SUPERSEDE', guard: 'preconditionNoLongerHolds' },
  ],
};

/**
 * How many DEFINITE refusals before the lane gives up on a message.
 *
 * Three, matching `DELIVERY_MAX_ATTEMPTS`, and matching it on purpose: both are the same
 * judgement about the same transport — a Telegram send refused three times is being
 * refused for a reason a fourth attempt does not change.
 *
 * What counts as an attempt is the part worth stating. An attempt is an outcome SOMEBODY
 * OBSERVED about this message: Telegram accepted it, or Telegram rejected it. A rate
 * limit is neither — it is Telegram declining to look at it yet — so it does not spend
 * one. Spending attempts on rate limits would fail a message that was never rejected on
 * its merits, and it would do so in exactly the conditions that cause rate limits, which
 * is when the most customers are waiting.
 */
export const CUSTOMER_NOTIFICATION_MAX_ATTEMPTS = 3;

/**
 * How long after a definite refusal the lane tries again.
 *
 * Only for a refusal. A RATE LIMIT waits for Telegram's own `retry_after` instead, and
 * that preference is the rule the transport already states: a back-off we invented would
 * be ruder or slower than the number the server asked for.
 */
export const CUSTOMER_NOTIFICATION_BACKOFF_MS = 60_000;

/**
 * The bound on one pass.
 *
 * ADR 0030 §4: fairness is the loop's scope and this bound, not a second rate budget.
 * Oldest-first within the bound is what stops one customer's backlog monopolising a pass.
 */
export const CUSTOMER_NOTIFICATION_SWEEP_LIMIT = 200;
