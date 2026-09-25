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
  /**
   * A catalogue key, optionally with the values its placeholders declare. Values are
   * what lets a button carry a NAME and a FIGURE from the same catalogue as the body
   * (`bot.wallet.topup_method_gift_button`, `bot.service.list_item_button`); the
   * messenger renders them through the one resolver, so a tenant's override of the
   * button's key is honoured like any other.
   */
  | { readonly kind: 'TEMPLATE'; readonly key: TemplateKey; readonly values?: TemplateValues }
  | { readonly kind: 'TEXT'; readonly text: string; readonly amount?: Money }
  /**
   * An amount and NOTHING else, formatted by the messenger.
   *
   * The wallet top-up presets: the button IS the amount, with no name to put in front of
   * it. Its own member rather than `TEXT` with an empty string, because that would render
   * a leading separator — and because a label with no text is a different thing from a
   * label whose text is blank.
   */
  | { readonly kind: 'AMOUNT'; readonly amount: Money };

/**
 * Which row a button is drawn on.
 *
 * Buttons sharing a number sit side by side, in the order given; a button without one
 * gets a row to itself, which is what every button in this product did before the
 * manual-transfer invoice needed two copy controls above one action.
 *
 * Deliberately a number on the button rather than an array of arrays. Rows-of-rows would
 * have changed the shape every one of the twenty existing call sites passes, to express
 * a layout nineteen of them do not have.
 */
export type CustomerButtonRow = number;

/**
 * One inline-keyboard button that carries a ROUTE.
 *
 * `data` is Telegram's `callback_data`, which it caps at 64 BYTES — a real constraint
 * rather than a guideline, and the reason Phase 0 recorded that a bare UUID plus a route
 * prefix leaves nothing. The callers here send `<one letter>:<uuid>`, which is 38 bytes,
 * so an opaque reference table is not needed and is deliberately not introduced.
 */
export interface CustomerCallbackButton {
  readonly label: CustomerButtonLabel;
  readonly data: string;
  readonly row?: CustomerButtonRow;
}

/**
 * One inline-keyboard button that COPIES a string to the customer's clipboard.
 *
 * Telegram's own `CopyTextButton` (Bot API 7.11). It carries no `callback_data` and
 * reaches no handler — the tap is handled entirely by the client — which is why it is a
 * separate shape rather than a flag on the one above: a copy button has no route, and a
 * type that let it have one would let a caller give it a destructive prefix.
 *
 * The alternative, a callback that replies with a message containing just the digits,
 * is what a bot does when the API has no copy button. It puts a second message in the
 * chat for every tap and leaves the customer scrolling past six identical card numbers.
 */
export interface CustomerCopyButton {
  readonly label: CustomerButtonLabel;
  /** What lands on the clipboard. Telegram caps it at 256 characters. */
  readonly copyText: string;
  readonly row?: CustomerButtonRow;
}

/**
 * One inline-keyboard button that OPENS a link.
 *
 * Telegram's URL button: the client opens `url` and nothing reaches this installation,
 * so like the copy button it has no route and cannot be given a destructive prefix.
 * The messenger admits `https://` and `tg://` and refuses anything else with a
 * validation error: an `http://` link to a subscription is the credential over
 * plaintext, and a scheme Telegram does not open is a button that does nothing.
 */
export interface CustomerUrlButton {
  readonly label: CustomerButtonLabel;
  readonly url: string;
  readonly row?: CustomerButtonRow;
}

export type CustomerButton = CustomerCallbackButton | CustomerCopyButton | CustomerUrlButton;

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
  /**
   * Attach the persistent main-menu keyboard, under the chat rather than on the message.
   *
   * A `ReplyKeyboardMarkup`, which is a different thing from `buttons`: it carries no
   * `callback_data` and therefore no identifier and no authority, it stays visible until
   * something replaces it, and a tap on it arrives as an ordinary text message. Only the
   * answer to `/start` sets it — see `PendingReply.keyboard`.
   *
   * Mutually exclusive with `buttons` in practice rather than by type: no reply carries
   * both today, and Telegram's `reply_markup` holds one or the other.
   */
  readonly keyboard?: MainMenuVariant;
}

/**
 * WHICH persistent keyboard to draw.
 *
 * `MAIN_MENU` is every customer's. `MAIN_MENU_ADMIN` is the same rows with the
 * management-panel entry appended, and it is drawn only for a turn whose Telegram
 * account resolved to an ACTIVE administrator holding one of the panel's permissions.
 *
 * A variant rather than a boolean flag on the message, because the rows themselves stay
 * in `@nexa/contracts` where both the keyboard and the route map read them: a surface
 * that composed its own rows could draw a button nothing routes, which is the failure
 * the shared-catalogue comment on `send` states.
 *
 * Drawing the admin row is NOT authorization. Every action behind it re-checks its
 * permission server-side; this only decides what a person can see.
 */
export type MainMenuVariant = 'MAIN_MENU' | 'MAIN_MENU_ADMIN';

/**
 * A file this installation already holds, sent on to somebody who may see it.
 *
 * Phase 5T: a receipt, forwarded to an administrator reviewing it. Carried by `fileId`,
 * which is what Telegram gave us when the customer uploaded it — so no byte is
 * downloaded, no URL is built, and the bot token never leaves the transport. A
 * `file_id` is scoped to the BOT that received it, which is why `botInstanceId` is
 * required and never "the tenant's active bot".
 */
export interface CustomerFileMessage {
  readonly chatId: string;
  readonly botInstanceId: BotInstanceId;
  readonly kind: 'PHOTO' | 'DOCUMENT';
  /**
   * Where the bytes come from.
   *
   * `FILE_ID` is a file Telegram already holds for this bot — a receipt a customer
   * uploaded — and nothing is downloaded or re-uploaded to send it on. `BYTES` is a file
   * this installation rendered itself, a subscription QR code, and goes up as a
   * multipart upload. A union rather than two optional fields so a message cannot name
   * both, or neither.
   *
   * `mimeType` is closed to the two raster types `sendPhoto` accepts. A document of an
   * arbitrary type is not something this product sends a customer.
   */
  readonly source: CustomerFileSource;
  /**
   * The caption, as a template key and its values — never text, for the reason
   * `CustomerMessage` gives: rendering happens where the tenant's overrides live, and the
   * format (and so the escaping) is the key's.
   *
   * Payment File 02 §10: the reviewer's receipt is ONE message, so the facts travel on the
   * image rather than in a second message beside it. Absent means a bare file, which is
   * what every further receipt of the same payment is.
   */
  readonly caption?: { readonly templateKey: TemplateKey; readonly values: TemplateValues };
  /** An inline keyboard on the file, with `CustomerMessage.buttons`' rules. */
  readonly buttons?: readonly CustomerButton[];
}

export type CustomerFileSource =
  | { readonly kind: 'FILE_ID'; readonly fileId: string }
  | {
      readonly kind: 'BYTES';
      readonly bytes: Uint8Array;
      readonly fileName: string;
      readonly mimeType: 'image/png' | 'image/jpeg';
    };

/**
 * Whether a customer-facing send landed.
 *
 * FOUR outcomes, and the two that are not `DELIVERED`/`REFUSED` are each the point.
 *
 * `UNKNOWN` means Telegram MAY have delivered it: a timeout, a 5xx, or a 2xx whose body
 * would not parse. Nothing retries it automatically, because a retried greeting is noise
 * and a retried "your service is ready" is a customer wondering which one is true. That
 * is the same third outcome `backup.ts` and `payment.ts` insist on.
 *
 * `RATE_LIMITED` used to be folded into `UNKNOWN` and must not be. A 429 is Telegram
 * DECLINING the request and telling us when to come back; it is not a send whose fate is
 * unknown. ADR 0030 §2 carries the argument and `docs/phase4h-audit.md` §6b the
 * consequence of the old grouping: a single rate limit parked a paid customer's
 * subscription link in `UNCONFIRMED`, which the delivery sweep never re-claims, until a
 * person noticed — and a 429 is what Telegram sends precisely when the most customers
 * are waiting.
 */
export type CustomerSendOutcome = 'DELIVERED' | 'REFUSED' | 'UNKNOWN' | 'RATE_LIMITED';

/**
 * What a send did, and how long to wait when Telegram said so.
 *
 * A result rather than a bare outcome, because `RATE_LIMITED` is the one answer that
 * carries a number nobody else can supply. `telegram-transport.test.ts` already states
 * the preference it serves: a back-off we invented would be ruder or slower than the
 * one the server asked for.
 *
 * `retryAfterMs` is present only with `RATE_LIMITED`, and even then only when Telegram
 * sent `parameters.retry_after` — it may omit it, and a caller must have its own floor.
 */
export interface CustomerSendResult {
  readonly outcome: CustomerSendOutcome;
  readonly retryAfterMs?: number;
  /**
   * Why the MESSENGER refused, when it did so without asking Telegram.
   *
   * Present only with `REFUSED`, and only for a refusal decided here. A caller that
   * arranged a caption Telegram would not take is told so before a request is spent,
   * and can choose another arrangement — the file bare and the text beside it — rather
   * than reading a 400 that names neither the field nor the bound.
   */
  readonly reason?: CustomerSendRefusal;
}

/**
 * The one local refusal today: an HTML caption over `TELEGRAM_CAPTION_MAX`.
 *
 * A plain-text caption is cut with a visible ellipsis instead (`boundCaption`), which
 * the receipt review relies on; an HTML one cannot be cut without risking a split tag,
 * and Telegram's answer to that is the same 400 as to a long one — so it is refused
 * whole, and the caller decides what to send instead.
 */
export type CustomerSendRefusal = 'CAPTION_OVER_BOUND';

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
  send(scope: TenantContext, message: CustomerMessage): Promise<CustomerSendResult>;

  /**
   * Sends a file: one Telegram already holds, by `file_id`, or bytes this installation
   * rendered, as an upload. With an optional caption template and inline keyboard.
   *
   * Same contract as `send`: it does not throw for a send failure, because a receipt
   * that could not be re-sent must not roll back or fail the turn that was showing it.
   * The reviewer's screen still carries the facts and the two decisions; the media is
   * the evidence beside them.
   *
   * A caption the messenger can tell Telegram would refuse is answered `REFUSED` with
   * a `reason`, without a request — see `CustomerSendRefusal`.
   */
  sendFile(scope: TenantContext, message: CustomerFileMessage): Promise<CustomerSendResult>;

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
  /**
   * The earliest the dispatcher may try, when the PRODUCER already knows one.
   *
   * Absent or null means now, which is right for every background producer: the
   * fact became true and nobody has spoken to Telegram about it.
   *
   * The rate-limit fallback is the one that knows better. It exists because
   * Telegram answered the interactive reply 429 with a `retry_after`, and
   * queueing that fact with no floor lets the very next sweep — up to a minute
   * later, or immediately if one is already due — walk into the same refusal.
   * That costs a request Telegram already declined and lengthens the throttle
   * for every other message to that chat. The deadline it was given is the one
   * piece of knowledge the interactive path has and the lane does not.
   */
  readonly nextAttemptAt?: Date | null;
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
   * Puts a claimed row back on the queue at `retryAt`: no attempt spent.
   *
   * Its own method rather than a flag on `record`, because the difference is exactly
   * the one ADR 0030 §2 exists to make and a boolean parameter is how it would be lost.
   * A 429 is Telegram declining to LOOK at the message, not an outcome about it, so the
   * attempt counter — which bounds refusals OF THIS MESSAGE — must not move.
   *
   * Two callers, and the second is why the name is about the effect rather than the
   * cause: a customer blocked between the claim and the contact lookup has an outcome
   * nobody observed either, and `claimDue` already declines to claim such a row at all.
   */
  deferUntil(
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
