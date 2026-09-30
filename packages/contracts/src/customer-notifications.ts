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
  /**
   * An operator confirmed a wallet top-up and the credit is on the ledger.
   * `payments.id` is the subject.
   *
   * A fact about an entity, which is what this list admits — and the one outcome a
   * customer would otherwise learn about only by opening `/wallet` and comparing two
   * numbers. Every other confirmed payment announces itself through the thing it bought;
   * a top-up buys nothing, so without this the money arrives in silence.
   *
   * It carries no amount, because the lane carries no payload (ADR 0030 §1). The
   * sentence says the balance changed and tells them where to read it, which is the same
   * shape `PAYMENT_TRANSFER_RECORDED` has.
   */
  'WALLET_TOPUP_CREDITED',
  /**
   * The order's money went back to the wallet because it could not be delivered.
   * `orders.id` is the subject.
   *
   * The second of the product's two terminal outcomes for money that arrived, and
   * the one the customer would otherwise learn about by waiting for a service that
   * is never coming. `ORDER_MACHINE` has no state for "paid and undelivered", so
   * there is no later moment at which somebody decides what to tell them: the
   * refund and this row commit in the same transaction as the state change.
   *
   * A fact about an entity with an id, with no payload — the amount is the exact
   * one they paid and is on the wallet page. Terminal, so its precondition is
   * `false`: a refund cannot stop having happened.
   */
  'ORDER_REFUNDED_TO_WALLET',
  /*
   * ## The six reminders (Phase 6C)
   *
   * Every other member of this list is a fact that happens ONCE per subject for ever:
   * an order is rejected once, a refund credited once. A reminder is not. A service
   * renewed twice crosses "three days left" three times, and
   * `customer_notifications_subject_key` — unique on `(tenant, kind, subject)` with an
   * `ON CONFLICT DO NOTHING` enqueue — would deliver the first and silently swallow the
   * other two.
   *
   * So a reminder's SUBJECT is not the service. It is a row in `service_reminders`, one
   * per (service, kind, period), and each occurrence is therefore its own subject with
   * its own guaranteed single delivery. The rule that a kind determines the table holds
   * unchanged; for these six the table is `service_reminders`.
   *
   * SIX kinds rather than two carrying a threshold. Each is its own frozen sentence
   * with its own editable template, so an operator can word "one day left" differently
   * from "three days left" — and so the CLOSED SET stays closed, which is what makes
   * `CUSTOMER_NOTIFICATION_PRECONDITIONS` exhaustive.
   *
   * They are named for the SLOT, not the number. The owner confirmed Mirza's crons
   * were configurable (CBR-003, CBR-011), so three days is a tenant's setting and
   * `SERVICE_EXPIRING_3D` would be a kind that lies the moment an operator changes it.
   *
   * These six DO render values, and that is not the payload ADR 0030 §1 refuses. A
   * payload is data a producer attaches to a message; these are read by the dispatcher
   * from the SUBJECT — the `service_reminders` row, which snapshotted them when the
   * reminder was raised. The producer still passes nothing but a kind and an id, and no
   * caller can put arbitrary text in front of a customer.
   */
  /** The tenant's FIRST expiry threshold was crossed. `service_reminders.id` is the subject. */
  'SERVICE_EXPIRY_FIRST',
  /** Its second, more urgent one. `service_reminders.id` is the subject. */
  'SERVICE_EXPIRY_SECOND',
  /** The service's own deadline passed. `service_reminders.id` is the subject. */
  'SERVICE_EXPIRED',
  /** The tenant's first usage threshold. `service_reminders.id` is the subject. */
  'SERVICE_USAGE_FIRST',
  /** Its second. `service_reminders.id` is the subject. */
  'SERVICE_USAGE_SECOND',
  /** Its final one. `service_reminders.id` is the subject. */
  'SERVICE_USAGE_FINAL',
  /**
   * A trial could not be created on its panel, and the trial was given back: it does
   * not count against the customer's limit. `orders.id` is the subject.
   *
   * The trial's counterpart of `ORDER_REFUNDED_TO_WALLET`, and deliberately not that
   * kind: that sentence tells the customer money is in their wallet, and a trial moved
   * none. `docs/wp6-audit.md` A4.
   */
  'TRIAL_NOT_DELIVERED',
  /*
   * ## WP10 and Payment File 02: money facts (`docs/payments-file02-design.md`)
   *
   * Each about an entity with an id and none carrying a payload, which is what this
   * list admits.
   */
  /**
   * A reviewer credited an amount to the wallet as a receipt's final disposition (D2).
   * `payments.id` is the subject.
   *
   * Its own sentence rather than `WALLET_TOPUP_CREDITED`: the customer must learn that
   * the transfer was not taken as payment of anything, and that what the reviewer judged
   * arrived is in the wallet to spend. A top-up sentence would not tell them that the
   * ORDER, when there is one, is still unpaid.
   */
  'RECEIPT_CREDITED_TO_WALLET',
  /**
   * A top-up earned its gateway's gift, credited as its own ledger entry (D5).
   * `payments.id` is the subject — the top-up's payment, so one gift per top-up is also
   * one sentence per top-up, by `customer_notifications_subject_key`.
   *
   * Sent beside `WALLET_TOPUP_CREDITED`, never instead of it: the principal and the gift
   * are two facts and two entries, and Payment File 02 §18 asks for two messages. A top-up
   * at 0% earns nothing and is sent nothing here.
   */
  'WALLET_TOPUP_GIFT_CREDITED',
  /**
   * An operator's refund is COMPLETE: the money is back on the wallet, or has been sent
   * back out of band. `refunds.id` is the subject — the one kind in this list whose
   * subject is a refund row, and the reason it is one row per refund: a payment refunded
   * in three parts is three facts, each told once.
   *
   * Not sent for `AWAITING_EXTERNAL`, which is a promise and not yet a fact, and not sent
   * by the automatic refund, which tells the customer `ORDER_REFUNDED_TO_WALLET` about
   * the ORDER in the same transaction. P3.
   */
  'REFUND_COMPLETED',
  /**
   * An external gateway definitively did NOT approve a payment attempt (WP11A): the
   * provider refused to create the invoice, or its inquiry answered rejected, expired or
   * canceled. `payments.id` is the subject.
   *
   * Its own sentence rather than `PAYMENT_REJECTED`, which reads an administrator's
   * reason back and tells the customer a person looked at their transfer — nobody did.
   * And not `PAYMENT_EXPIRED`, which is Nexa's own deadline. It says nothing was
   * charged through this attempt and that they may pay again; an order stays open.
   */
  'GATEWAY_PAYMENT_FAILED',
  /**
   * WP19. The customer's refund request for a service was recorded
   * (`service_refund_requests.id` is the subject). The interactive reply to their reason
   * message, and its fallback when that reply is lost to a rate limit — the
   * `PAYMENT_TRANSFER_RECORDED` shape: a customer who does not learn the request is on
   * record files it again, or gives up on it.
   */
  'SERVICE_REFUND_REQUEST_REGISTERED',
  /**
   * WP19. The request completed: the provider account was deleted and the approved amount
   * was credited to the wallet. Sent by the transaction that credits it, and by nothing
   * else — never on approval, which is a promise, and never on an ambiguous deletion. The
   * amount is read from the request's own completed refund.
   */
  'SERVICE_REFUND_REQUEST_APPROVED',
  /** WP19. An administrator refused the request; the reason is read from the request row. */
  'SERVICE_REFUND_REQUEST_REJECTED',
  /**
   * Package F. Another customer handed this customer one of their services.
   * `service_ownership_transfers.id` is the subject — one row per transfer, so a service
   * given, given away and given back is three facts, each told once.
   *
   * Its values (the account name, the location, what is left) are read at send time from
   * the transfer row and the service, and its ONE button — «مشخصات سرویس», opening the
   * service — is derived from the subject by kind, never stored: the lane still carries no
   * payload (ADR 0030 §1).
   */
  'SERVICE_TRANSFER_RECEIVED',
  /**
   * WP-A7. Support replied in one of the customer's tickets. `ticket_messages.id` is the
   * subject — ONE row per reply, so three replies are three facts, each told once.
   *
   * ## Why a reply's text is not a payload
   *
   * The text is variable, and ADR 0030 §1 refuses a producer-supplied payload: the lane must
   * not become "send this customer some text". It does not. The producer passes a kind and a
   * message id and nothing else, in the transaction that wrote the message; the dispatcher
   * reads the ticket's number, its category and the message's text from the MESSAGE ROW at
   * send time — the `SERVICE_REFUND_REQUEST_REJECTED` shape, whose reason is read from the
   * request row. The text a customer is sent is therefore exactly the text stored in their
   * ticket, and no caller can put anything else in front of them. Its one button —
   * «مشاهده تیکت» — is derived from the subject by kind, never stored.
   *
   * The message row is the source of truth, so a failed or lost send loses nothing: the
   * reply is in the ticket, which the customer opens from the bot.
   */
  'TICKET_REPLY',
  /*
   * ## WP-A9: reminders (`customer-reminders.ts`, `service-reminders.ts`)
   *
   * Two more service reminder SLOTS, whose subject is a `service_reminders` row exactly
   * like the six above; a wallet low-balance alert, whose subject is its crossing row; and
   * one reminder each for a pending payment and a pending order, whose subject is the
   * payment or the order — told at most once each, by `customer_notifications_subject_key`.
   */
  /** The tenant's week-out expiry threshold. `service_reminders.id` is the subject. */
  'SERVICE_EXPIRY_EARLY',
  /** The expiry's own calendar day has begun. `service_reminders.id` is the subject. */
  'SERVICE_EXPIRY_DAY',
  /**
   * The wallet fell below the tenant's threshold. `wallet_threshold_alerts.id` is the
   * subject — one row per crossing, so a wallet that recovers and falls again is a second
   * fact, told once.
   */
  'WALLET_LOW_BALANCE',
  /** A manual transfer's window is about to close unpaid. `payments.id` is the subject. */
  'PAYMENT_PENDING_REMINDER',
  /** An order's own window is about to close unpaid. `orders.id` is the subject. */
  'ORDER_PENDING_REMINDER',
  /**
   * HF-A7. The FILE support attached to a reply. `ticket_messages.id` is the subject — the
   * same message `TICKET_REPLY` names, so one reply with a file is two rows and two sends,
   * each with its own outcome: the text is never held hostage to a file Telegram refuses,
   * and a file is never re-sent because its text was.
   *
   * Not a payload either (ADR 0030 §1): the dispatcher reads the bytes, their type and their
   * name from `ticket_reply_files` by the message id at send time, and the caption's number
   * and category from the ticket. Once Telegram has the file, the delivery stamps Telegram's
   * `file_id` on that row and clears the bytes in the same transaction.
   */
  'TICKET_REPLY_ATTACHMENT',
  /**
   * R2 (v0.3.5 real-test item 11). A RENEWAL the customer paid for reached the panel.
   * `provisioning_operations.id` is the subject — the RENEW operation, exactly as
   * `SERVICE_ACTION_SUCCEEDED` names it — so a service renewed twice is two facts, each
   * told once.
   *
   * Its own kind rather than `SERVICE_ACTION_SUCCEEDED`, which stays the one sentence for
   * every OTHER customer-requested operation: a renewal ends with a dedicated result — the
   * account name, what was bought, the new expiry and the payment's tracking code — and a
   * button opening the renewed service. Not a payload either (ADR 0030 §1): the dispatcher
   * reads every value at send time from the operation, its order, the payment that paid for
   * it and the service; the producer passes a kind and the operation id and nothing else.
   */
  'SERVICE_RENEWED',
  /*
   * ## Round N, package D: the reseller monthly minimum (`docs/round-n-reseller-audit.md` §3.4)
   *
   * The subject of both is a `reseller_minimum_notices` row — one per (reseller, kind,
   * month) — so each is told at most once a month, the `wallet_threshold_alerts` shape.
   * Neither carries a payload: the minimum is read from the notice row and the sales figure
   * from the ledger of orders, at send time. Neither has any consequence beyond the
   * sentence: no debt, fee, debit, settlement, demotion or block exists behind them.
   */
  /**
   * The month ends in a few days and the reseller's sales are still below their minimum.
   * `reseller_minimum_notices.id` is the subject.
   */
  'RESELLER_MINIMUM_REMINDER',
  /** The reseller's sales this month reached their minimum. `reseller_minimum_notices.id`. */
  'RESELLER_MINIMUM_ACHIEVED',
  /*
   * Round N (B2): a mass wallet credit, told to the customer when the operator chose to
   * notify. The subject is the bulk item; the amount is read at send time from the
   * `MASS_CREDIT` wallet entry the item names — a reader, not a payload (ADR 0030 §1).
   * Enqueued in the transaction that writes the entry, so a credit that did not happen is
   * never announced.
   */
  'WALLET_MASS_CREDITED',
  /*
   * Round N (B2): a mass traffic or time grant that the provider AUTHORITATIVELY applied. The
   * subject is the bulk item; what was granted and to which service is read from it at send
   * time. Enqueued only when the item's operation is SUCCEEDED — never for a planned, unknown
   * or failed one.
   */
  'SERVICE_GIFT_APPLIED',
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
  /*
   * `false`, and it is the most terminal fact in this list: an append-only ledger entry.
   * A credit cannot stop having happened, and a late copy of the sentence is still true.
   */
  WALLET_TOPUP_CREDITED: false,
  /*
   * `false`, for the reason above it: the ledger entry is append-only and the
   * order is terminal. Nothing can make a refunded order un-refunded, so a late
   * copy of the sentence is still true.
   */
  ORDER_REFUNDED_TO_WALLET: false,
  /*
   * All six `true` since WP-A9, and the reader answers them from the reminder ROW.
   *
   * They were `false`, on the argument that the row asserts "the period ending at T had
   * three days left" and a renewal does not make that untrue. It does make it USELESS: a
   * "your service expires tomorrow" that leaves the queue after the customer renewed —
   * held back by a rate limit, a retry backoff or a stopped worker — tells them their
   * money did nothing. The owner's rule is that it must not be sent.
   *
   * So the reader reads the `service_reminders` row BY ITS OWN ID and the service it
   * names, never `services` by the subject id (which would find nothing and supersede
   * every reminder — the trap `PAYMENT_TRANSFER_RECORDED` documents above). A reminder
   * holds while the service still has the period it was raised against — the same
   * deadline, and for the usage kinds the same allowance — and is still in a state the
   * family speaks about; an advance expiry warning also needs the deadline still ahead.
   * A renewal, a top-up of traffic or a termination supersedes it; the next period's
   * reminder is a new row and a new subject.
   */
  SERVICE_EXPIRY_FIRST: true,
  SERVICE_EXPIRY_SECOND: true,
  SERVICE_EXPIRED: true,
  SERVICE_USAGE_FIRST: true,
  SERVICE_USAGE_SECOND: true,
  SERVICE_USAGE_FINAL: true,
  /*
   * `false`: the order is terminal and the grant is released in the same transaction
   * that enqueues this. Nothing makes an undelivered trial delivered after the fact —
   * a new trial is a new order.
   */
  TRIAL_NOT_DELIVERED: false,
  /*
   * All three `false`, and each for the reason every money fact above is: they are
   * terminal. A ledger entry is append-only, a FAILED payment is frozen, and a COMPLETED
   * refund cannot be failed. A late copy of any of these sentences is still true — and
   * `true` would send the dispatcher to a reader that reads `services` and nothing else,
   * which would SUPERSEDE the message unsent.
   */
  RECEIPT_CREDITED_TO_WALLET: false,
  WALLET_TOPUP_GIFT_CREDITED: false,
  REFUND_COMPLETED: false,
  /*
   * `false`: a FAILED payment is frozen by 0052/0114, so "this attempt was not approved"
   * cannot stop being true. A later provider completion is recorded as an anomaly and
   * never reopens the payment.
   */
  GATEWAY_PAYMENT_FAILED: false,
  /*
   * All three `false`: a recorded request stays recorded, a COMPLETED request cannot be
   * uncompleted and a REJECTED one cannot be un-rejected. Each is terminal for the fact it
   * states, and a late copy is still true.
   */
  SERVICE_REFUND_REQUEST_REGISTERED: false,
  SERVICE_REFUND_REQUEST_APPROVED: false,
  SERVICE_REFUND_REQUEST_REJECTED: false,
  /*
   * `true`, and the second kind that is: "a service was given to you" is a claim about who
   * owns the service NOW. A service passed on again before the message left would announce
   * something the recipient no longer has, and its button would open a service that
   * answers «not found». The reader checks the transfer's service is still owned by the
   * transfer's recipient, and SUPERSEDES the message when it is not.
   */
  SERVICE_TRANSFER_RECEIVED: true,
  /*
   * `false`: a reply that was written stays written — messages are append-only. A ticket
   * closed after the reply does not make the reply untrue, and a late copy is still the
   * answer the customer is waiting for.
   */
  TICKET_REPLY: false,
  /* WP-A9. The two new service reminder slots, answered like the six above. */
  SERVICE_EXPIRY_EARLY: true,
  SERVICE_EXPIRY_DAY: true,
  /*
   * `true`: "your balance is low" is a claim about the wallet NOW. A top-up that lands
   * before the message leaves makes it false, and the reader re-derives the balance from
   * the ledger and compares it with the threshold the crossing was recorded against.
   */
  WALLET_LOW_BALANCE: true,
  /*
   * Both `true`, and they are the reason these kinds exist at all: a reminder to pay is
   * worse than silence once the attempt is settled, cancelled or expired. The reader
   * requires the payment still PENDING, before its deadline, with no receipt filed and no
   * "I have paid" signal; and the order still AWAITING_PAYMENT before its own deadline.
   */
  PAYMENT_PENDING_REMINDER: true,
  ORDER_PENDING_REMINDER: true,
  /*
   * HF-A7. `false`, for `TICKET_REPLY`'s reason: the file is part of a reply that was
   * written, and a late copy is still the answer. A file whose bytes were cleared before it
   * left is not "no longer true" — the dispatcher finds nothing to send and FAILS it.
   */
  TICKET_REPLY_ATTACHMENT: false,
  /*
   * R2. `false`: a renewal that reached the panel stays renewed — the operation is terminal
   * and SUCCEEDED — and a late copy of the result is still true. Its figures are the
   * operation's own frozen target and the order's frozen line, not today's service row.
   */
  SERVICE_RENEWED: false,
  /*
   * Round N, package D. The reminder is `true`: "your sales are still below your minimum" is
   * a claim about the month NOW. The reader re-reads the notice row, the reseller and the
   * month's sales, and holds only while the reseller is ACTIVE, the month has not ended, the
   * effective minimum is still the one recorded and the sales are still below it. The
   * achievement is `false`: a month that reached its minimum did reach it, and a late copy
   * of the sentence is still true.
   */
  RESELLER_MINIMUM_REMINDER: true,
  RESELLER_MINIMUM_ACHIEVED: false,
  // Round N: both are terminal facts about work already done.
  WALLET_MASS_CREDITED: false,
  SERVICE_GIFT_APPLIED: false,
};

/**
 * Whether a kind is a REMINDER that the tenant's quiet hours hold back (HF-A9).
 *
 * A reminder is something the product decided on its own clock to tell a customer — a
 * deadline approaching, an allowance running down, a balance gone low, an unpaid invoice.
 * The owner's rule is that one falling due inside the quiet window is not sent at night:
 * the dispatcher moves the queued row's `next_attempt_at` to the window's end, spends no
 * attempt and writes nothing else, so it is neither dropped nor duplicated.
 *
 * `false` is everything else, and on purpose: a reply to something the customer just did
 * (a recorded transfer, a cancelled order, a ticket reply) is expected NOW, and an outcome
 * about their money or their order (rejected, refunded, credited, delivered, failed) is a
 * fact they are waiting on. Holding either until morning would make the product look
 * broken to a customer who is awake and acting.
 *
 * A Record over every kind, like `CUSTOMER_NOTIFICATION_PRECONDITIONS`, so a kind added
 * later has to decide. And every `true` here MUST also be `true` there: a held reminder is
 * sent hours after it was raised, and it may only be sent if what it reminds about still
 * holds — the owner's "not sent without reason once it has expired or become invalid".
 * `tests/unit/reminder-quiet-hours.test.ts` pins that implication.
 */
export const CUSTOMER_NOTIFICATION_QUIET_HOURS: Readonly<
  Record<CustomerNotificationKind, boolean>
> = {
  PAYMENT_REJECTED: false,
  PAYMENT_EXPIRED: false,
  ORDER_EXPIRED: false,
  SERVICE_ACTION_SUCCEEDED: false,
  SERVICE_ACTION_FAILED: false,
  SERVICE_PROVISION_DELAYED: false,
  PAYMENT_TRANSFER_RECORDED: false,
  ORDER_CANCELLED: false,
  WALLET_TOPUP_CREDITED: false,
  ORDER_REFUNDED_TO_WALLET: false,
  // The service reminders: every slot of both families, including the after-the-fact notice.
  SERVICE_EXPIRY_FIRST: true,
  SERVICE_EXPIRY_SECOND: true,
  SERVICE_EXPIRED: true,
  SERVICE_USAGE_FIRST: true,
  SERVICE_USAGE_SECOND: true,
  SERVICE_USAGE_FINAL: true,
  TRIAL_NOT_DELIVERED: false,
  RECEIPT_CREDITED_TO_WALLET: false,
  WALLET_TOPUP_GIFT_CREDITED: false,
  REFUND_COMPLETED: false,
  GATEWAY_PAYMENT_FAILED: false,
  SERVICE_REFUND_REQUEST_REGISTERED: false,
  SERVICE_REFUND_REQUEST_APPROVED: false,
  SERVICE_REFUND_REQUEST_REJECTED: false,
  SERVICE_TRANSFER_RECEIVED: false,
  TICKET_REPLY: false,
  SERVICE_EXPIRY_EARLY: true,
  SERVICE_EXPIRY_DAY: true,
  WALLET_LOW_BALANCE: true,
  /*
   * Both reminders, so both are held. A pending attempt's window is at most an hour, so a
   * reminder held past its deadline is SUPERSEDED at the window's end by its own
   * precondition — the attempt has lapsed, and the expiry sweep tells the customer that
   * instead. That is the owner's rule applied as written: held, not dropped, and not sent
   * once it has stopped being true.
   */
  PAYMENT_PENDING_REMINDER: true,
  ORDER_PENDING_REMINDER: true,
  // HF-A7: support's file on a ticket reply is part of the reply, sent with its text — never held.
  TICKET_REPLY_ATTACHMENT: false,
  // R2: the result of a renewal the customer just paid for is expected NOW.
  SERVICE_RENEWED: false,
  // Round N, package D: the month-end reminder is held like every reminder; the achievement is not.
  RESELLER_MINIMUM_REMINDER: true,
  RESELLER_MINIMUM_ACHIEVED: false,
  WALLET_MASS_CREDITED: false,
  SERVICE_GIFT_APPLIED: false,
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
  WALLET_TOPUP_CREDITED: 'bot.wallet.topup_credited',
  ORDER_REFUNDED_TO_WALLET: 'bot.order.refunded_to_wallet',
  /*
   * One frozen sentence per threshold. None carries a figure — the lane has no payload,
   * and «سه روز» inside the sentence is the same information a `{days}` placeholder
   * would carry with none of the machinery a placeholder needs.
   */
  SERVICE_EXPIRY_FIRST: 'bot.service.expiry_first',
  SERVICE_EXPIRY_SECOND: 'bot.service.expiry_second',
  SERVICE_EXPIRED: 'bot.service.expired',
  SERVICE_USAGE_FIRST: 'bot.service.usage_first',
  SERVICE_USAGE_SECOND: 'bot.service.usage_second',
  SERVICE_USAGE_FINAL: 'bot.service.usage_final',
  TRIAL_NOT_DELIVERED: 'bot.trial.not_delivered',
  /*
   * None with a placeholder: the lane carries no payload, and the figures are on the
   * wallet page, derived from the ledger.
   */
  RECEIPT_CREDITED_TO_WALLET: 'bot.payment.receipt_credited_to_wallet',
  WALLET_TOPUP_GIFT_CREDITED: 'bot.wallet.topup_gift_credited',
  REFUND_COMPLETED: 'bot.refund.completed',
  GATEWAY_PAYMENT_FAILED: 'bot.payment.gateway_failed',
  SERVICE_REFUND_REQUEST_REGISTERED: 'bot.service.refund_request_registered',
  SERVICE_REFUND_REQUEST_APPROVED: 'bot.service.refund_request_approved',
  SERVICE_REFUND_REQUEST_REJECTED: 'bot.service.refund_request_rejected',
  SERVICE_TRANSFER_RECEIVED: 'bot.service.transfer_received',
  TICKET_REPLY: 'bot.ticket.support_replied',
  SERVICE_EXPIRY_EARLY: 'bot.service.expiry_early',
  SERVICE_EXPIRY_DAY: 'bot.service.expiry_day',
  WALLET_LOW_BALANCE: 'bot.wallet.low_balance',
  PAYMENT_PENDING_REMINDER: 'bot.payment.pending_reminder',
  ORDER_PENDING_REMINDER: 'bot.order.pending_reminder',
  // HF-A7: the file's caption. PLAIN_TEXT, so an over-long override is cut, never refused.
  TICKET_REPLY_ATTACHMENT: 'bot.ticket.support_attachment',
  // R2: the dedicated renewal result, its values read at send time from the operation.
  SERVICE_RENEWED: 'bot.service.renewed',
  // Round N, package D: values read at send time from the notice row and the month's sales.
  RESELLER_MINIMUM_REMINDER: 'bot.reseller.minimum_reminder',
  RESELLER_MINIMUM_ACHIEVED: 'bot.reseller.minimum_achieved',
  WALLET_MASS_CREDITED: 'bot.wallet.mass_credited',
  SERVICE_GIFT_APPLIED: 'bot.service.gift_applied',
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
