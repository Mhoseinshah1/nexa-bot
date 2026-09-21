import {
  COMMERCE_ERROR_CODES,
  PANEL_ERROR_CODES,
  providerDescriptor,
  isNexaError,
  currencyCodeSchema,
  money,
  PAYMENT_RECEIPT_MAX_PER_PAYMENT,
  plainAmount,
  uuidV7Schema,
  USAGE_REMINDER_PERCENT_MAX,
  USAGE_REMINDER_PERCENT_MIN,
} from '@nexa/contracts';
import type {
  ActorContext,
  BotInstanceId,
  Clock,
  CorrelationId,
  CustomerArrival,
  CustomerNotificationKind,
  Money,
  OrderId,
  OrderPurpose,
  PaymentId,
  PermissionKey,
  ServiceActionAvailability,
  ServiceOperatorAction,
  ServiceReminderThresholds,
  SettingKey,
  TemplateKey,
  TemplateValues,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import {
  ADMIN_MENU_COMMAND,
  DEFAULT_USERNAME_PREFIX,
  previewUsername,
  validateUsernamePolicy,
} from '@nexa/contracts';
import type { PanelUsernamePolicy } from '../../modules/platform/panels/application/ports.js';
import type { CustomerService } from '../../modules/commerce/customers/application/customer.service.js';
import type { PaymentDestinationRenderer } from '../../modules/commerce/payments/infrastructure/destination-renderer.js';
import type { InboundReceiptFile } from '../../modules/commerce/payments/application/receipt-ports.js';
import type { ReceiptService } from '../../modules/commerce/payments/application/receipt.service.js';
import type {
  CustomerButton,
  CustomerSendOutcome,
  CustomerMessenger,
  MainMenuVariant,
} from '../../modules/commerce/messaging/application/ports.js';
import type { CustomerRecord } from '../../modules/commerce/customers/application/ports.js';
import type { ProductService } from '../../modules/commerce/catalog/application/product.service.js';
import type { CommercialActionService } from '../../modules/commerce/commercial/application/commercial-action.service.js';
import type { OrderService } from '../../modules/commerce/orders/application/order.service.js';
import type { OrderRecord } from '../../modules/commerce/orders/application/ports.js';
import type {
  ManualTransferInstruction,
  PaymentService,
} from '../../modules/commerce/payments/application/payment.service.js';
import type { WalletService } from '../../modules/commerce/wallet/application/wallet.service.js';
import { ProvisioningService } from '../../modules/commerce/provisioning/application/provisioning.service.js';
import type { CustomerServiceOperation } from '../../modules/commerce/provisioning/application/provisioning.service.js';
import type { DeliveryService } from '../../modules/commerce/provisioning/application/delivery.service.js';
import type {
  ServiceCursor,
  ServiceRecord,
} from '../../modules/commerce/provisioning/application/ports.js';
import type { OperatorServiceOperation } from '../../modules/commerce/provisioning/application/provisioning.service.js';
import type { ServiceAdminService } from '../../modules/commerce/provisioning/application/service-admin.service.js';
import { decodeKeysetToken, encodeKeysetToken, type KeysetToken } from './keyset-token.js';
import type { PanelService } from '../../modules/platform/panels/application/panel.service.js';

import { readHealth } from '../../modules/platform/panels/application/panel-health-view.js';

/**
 * What the customer asked for.
 *
 * A tiny closed vocabulary rather than a parsed command string, decided at the
 * boundary and never passed onward as text. Phase 4A handles `/start` and answers
 * everything else with the unsupported-input fallback; later subphases add members.
 *
 * There is no FSM and no conversation state. The legacy system's prompt capture
 * swallowed an ordinary message and overwrote a production gateway setting
 * (INCIDENT-FIN-001), which is what a stateful prompt does when it outlives the
 * question it was asked for.
 */
export const BOT_INTENTS = [
  'START',
  'CATALOG',
  'ORDER',
  'CONFIRM',
  'WALLET',
  'PAY_WALLET',
  'PAY_MANUAL',
  'PAY_GATEWAY',
  'PAY_CANCEL_ASK',
  'PAY_CANCEL',
  'PAY_SENT',
  'TOPUP_MENU',
  'TOPUP_PICK',
  'ORDER_CANCEL_ASK',
  'ORDER_CANCEL',
  'SERVICES',
  /*
   * The NEXT page of a customer's own services.
   *
   * Phase 6A. Its own intent rather than `SERVICES` with an optional payload, because
   * the two are parsed differently: `SERVICES` comes from a command or the main-menu
   * keyboard and carries nothing, and this one carries an opaque cursor that the
   * boundary validates before any handler sees it.
   */
  'SERVICES_PAGE',
  'SERVICE',
  'SERVICE_RESEND',
  'SERVICE_SUSPEND',
  'SERVICE_RESUME',
  'SERVICE_TERMINATE_ASK',
  'SERVICE_TERMINATE',
  'SERVICE_RENEW',
  'SERVICE_ADD_TRAFFIC',
  'SERVICE_ADD_TIME',
  'SERVICE_BUY_TRAFFIC',
  'SERVICE_BUY_TIME',
  'SERVICE_ACTION_CONFIRM',
  /*
   * The three the username step needs (Deliverable A).
   *
   * `USERNAME_TEXT` is the only intent in this vocabulary produced by an ORDINARY
   * message rather than a command or a button, and that is exactly the shape
   * INCIDENT-FIN-001 warns about. It is safe here because it decides nothing: the
   * handler asks the database whether a window is open, and `NO_WINDOW` — the answer
   * for almost every message — falls through to the same fallback as before.
   */
  'USERNAME_CUSTOM',
  'USERNAME_AUTOMATIC',
  'USERNAME_TEXT',
  'HELP',
  'RECEIPT_UPLOAD',
  /*
   * Phase 5T — the management panel.
   *
   * These are intents like any other, and that is the point: they are parsed from the
   * update with no knowledge of who sent it, and the HANDLER resolves the Telegram
   * account's binding and charges a permission. A customer who crafts one of these
   * callbacks reaches `adminTurn`, resolves to no administrator and is answered with
   * the ordinary unsupported-input fallback — the same reply they get for any other
   * string this bot does not understand.
   */
  'ADMIN_PANEL',
  'ADMIN_RECEIPTS',
  'ADMIN_RECEIPT',
  'ADMIN_APPROVE',
  'ADMIN_REJECT',
  'ADMIN_SECTION',
  /*
   * WP1 — one administrator, and the one write this surface may make about them.
   *
   * `ADMIN_ADMIN_STATUS` carries the TARGET status rather than "flip it", the same
   * shape the username toggles use: a second tap on a slow connection then writes the
   * value already held instead of undoing the first.
   *
   * There is deliberately no `ADMIN_ADMIN_PASSWORD` and no session listing. A
   * credential must not cross Telegram at all, and a message naming the IP an
   * administrator signs in from is forwardable for ever — both stay in the Web Admin,
   * where the operator acting on them already is.
   */
  'ADMIN_ADMIN',
  'ADMIN_ADMIN_STATUS',
  'ADMIN_REVOKE',
  /*
   * Phase 6A \u2014 the services section.
   *
   * `ADMIN_SERVICE_TERMINATE_ASK` is the first ask-then-act pair on the ADMIN side.
   * Every admin action before it fired on one tap, which is right for approving a
   * receipt and wrong for deleting an account on a provider: the asking callback is
   * what a list or a detail screen carries, and the destructive one is produced in
   * exactly one place.
   */
  'ADMIN_SERVICES',
  'ADMIN_SERVICE',
  'ADMIN_SERVICE_SYNC',
  'ADMIN_SERVICE_RESEND',
  'ADMIN_SERVICE_RETRY',
  'ADMIN_SERVICE_RECONCILE',
  'ADMIN_SERVICE_SUSPEND',
  'ADMIN_SERVICE_RESUME',
  'ADMIN_SERVICE_TERMINATE_ASK',
  'ADMIN_SERVICE_TERMINATE',
  /*
   * Phase 6B — the panels section.
   *
   * `ADMIN_PANELS` is the section and `ADMIN_PANEL` is the management panel itself,
   * which already existed: the singular one is the whole screen and the plural one is
   * a fleet. `ADMIN_PANEL_DETAIL` is one panel, so no intent is named after two
   * different things.
   *
   * `ADMIN_PANEL_ARCHIVE_ASK` and `ADMIN_PANEL_ARCHIVE` are the ask-then-act pair, the
   * second on this surface. Archiving is reversible — it is the Web Admin's Restore
   * button — and still gets a confirmation, because it takes a panel out of the
   * catalogue and off the monitor's schedule on one tap from a phone.
   */
  'ADMIN_PANELS',
  'ADMIN_PANELS_PAGE',
  'ADMIN_PANEL_DETAIL',
  'ADMIN_PANEL_TEST',
  'ADMIN_PANEL_ENABLE',
  'ADMIN_PANEL_DISABLE',
  'ADMIN_PANEL_ARCHIVE_ASK',
  'ADMIN_PANEL_ARCHIVE',
  /*
   * Phase 6C — a panel's username policy, read back and edited.
   *
   * Five intents. Three are taps and carry only what was tapped; two are COMMANDS that
   * carry their argument in the same message, because a prefix and a template are text
   * an operator authors and this surface has no prompt that captures the next message.
   * INCIDENT-FIN-001 is what such a prompt does when it outlives its question.
   */
  'ADMIN_USERNAME',
  'ADMIN_USERNAME_TOGGLE',
  'ADMIN_USERNAME_STRATEGY',
  'ADMIN_USERNAME_PREFIX',
  'ADMIN_USERNAME_TEMPLATE',
  /*
   * Phase 6C — the reminder settings section.
   *
   * Three intents and no fourth, because there is no typed-value turn: `ADMIN_REMINDERS`
   * is the whole configuration printed at once, `ADMIN_REMINDER_EDIT` is one setting and
   * the values it may take, and `ADMIN_REMINDER_SET` is a tap on one of them. The value
   * travels in the callback data, so this section has no pending prompt and therefore no
   * way to swallow an unrelated message (INCIDENT-FIN-001).
   *
   * There is deliberately no intent for turning a reminder family off. All three flags
   * are TENANT_WIDE, and ADR-0010 asks for a typed confirmation and a recorded reason at
   * that blast radius — a button that supplied either would be the safeguard removed
   * rather than satisfied, so the section says where to do it instead.
   */
  'ADMIN_REMINDERS',
  'ADMIN_REMINDER_EDIT',
  'ADMIN_REMINDER_SET',
  /*
   * WP2 — the customers section.
   *
   * Six intents. `ADMIN_CUSTOMERS` and `ADMIN_CUSTOMERS_PAGE` are one paged list;
   * `ADMIN_CUSTOMER` is one person by their internal id, reached by tapping a row;
   * `ADMIN_CUSTOMER_FIND` is the same screen reached by the numeric Telegram id an
   * operator quotes from a support conversation, which is a DIFFERENT question and
   * charges `users.search` on top of `users.view` because the permission catalogue
   * already separates them. `ADMIN_CUSTOMER_BLOCK` and `ADMIN_CUSTOMER_UNBLOCK` are the
   * two writes, and there is no third because `CUSTOMER_STATUSES` has no third member.
   *
   * The lookup is a COMMAND carrying its argument, not a prompt that captures the next
   * message — the rule `/link`, `/role` and `/service` state, and INCIDENT-FIN-001 is
   * what the other kind does when it outlives its question.
   */
  'ADMIN_CUSTOMERS',
  'ADMIN_CUSTOMERS_PAGE',
  'ADMIN_CUSTOMER',
  'ADMIN_CUSTOMER_FIND',
  'ADMIN_CUSTOMER_BLOCK',
  'ADMIN_CUSTOMER_UNBLOCK',
  'ADMIN_LINK',
  'ADMIN_ROLE',
  'UNSUPPORTED',
] as const;
export type BotIntent = (typeof BOT_INTENTS)[number];

/**
 * The intent and the ONE id it refers to.
 *
 * `ORDER` and `CONFIRM` arrive as button taps and name a product or an order. The id is
 * carried as a separate, VALIDATED field rather than as the raw callback string, so
 * nothing downstream re-parses it — and it is checked as a UUID here, at the boundary,
 * because `callback_data` is client-supplied text and a customer can send any of it.
 *
 * This is not conversation state. There is still no FSM: everything the runtime needs is
 * in the update it is handling, which is what makes a redelivery a replay instead of a
 * step in a half-finished dialogue. INCIDENT-FIN-001 is what a stateful prompt does when
 * it outlives the question it was asked for.
 */
export interface BotCommand {
  readonly intent: BotIntent;
  readonly targetId: string | null;
  /**
   * A SECOND identifier, for the one callback that needs two.
   *
   * Buying a package names both the service it is for and the package itself, and
   * neither can be inferred from the other: the customer owns the service and CHOOSES
   * the package. With no conversation state there is nowhere else to keep the first
   * while they pick the second — that absence is deliberate, and `INCIDENT-FIN-001` is
   * what a stateful prompt does when it outlives its question.
   *
   * Still an identifier and never a quantity. `encodeIdPair` is what makes two of them
   * fit in Telegram's 64 bytes, and both come back through the same UUID validation the
   * single-id path uses.
   */
  readonly secondaryId?: string | null;
  /**
   * The words after a slash command, for the two the management panel accepts.
   *
   * `/link <telegram id> <username>` and `/role <username> <role key>` carry their
   * arguments in the SAME message as the verb, which is what makes them commands rather
   * than a prompt that captures the next message — the shape INCIDENT-FIN-001 is about.
   * Split on whitespace and otherwise untouched: every argument is validated by the
   * service that uses it (`telegramUserIdSchema`, the username lookup, the role key),
   * because the boundary cannot know which administrator a name refers to.
   */
  readonly args?: readonly string[];
  /**
   * A decoded LIST POSITION, for the two callbacks that page rather than act.
   *
   * Not `targetId`: a cursor is not an identifier, nothing is looked up by it, and a
   * field documented as an id would eventually be passed to a repository as one. It
   * arrives as an opaque token in `callback_data` and is decoded — and therefore
   * validated — at the boundary, so a handler either receives a well-formed position or
   * the update is UNSUPPORTED before it gets there.
   *
   * `KeysetToken` and not one module's cursor type: the customer's services list and
   * the administrator's panels list both page this way, and a `BotCommand` that named
   * the provisioning module's type to carry a panel's position would be a lie about
   * what the field holds. Both cursors ARE this shape, and the handler passes the value
   * to the repository that minted it.
   */
  readonly cursor?: KeysetToken | null;
  /** Telegram's id for the tapped button, so the spinner can be stopped. */
  readonly callbackQueryId: string | null;
  /**
   * The file a `RECEIPT_UPLOAD` carries, and nothing else ever carries one.
   *
   * It is not conversation state: everything here came out of the update being handled,
   * which is what keeps a redelivery a replay rather than a step in a half-finished
   * dialogue. What the file attaches TO is decided by the capture window in the
   * database, never by this field — so a client that invents one reaches a payment only
   * if a window for that customer on that bot is genuinely open.
   *
   * The CAPTION is deliberately absent. A Persian caption as an identifier is
   * `entities-states.md`'s worst finding, and nothing in this flow needs the text.
   */
  readonly file?: InboundReceiptFile | null;
}

/**
 * Two UUIDs in 45 bytes, because `callback_data` holds 64 and two of them spell 73.
 *
 * Raw base64url of the thirty-two bytes the pair actually is — not hex, which spells
 * sixty-six and still would not fit, and not a shortened id, which would stop being the
 * id. An encoding, not a token: it carries no authority, it is not signed, and nothing
 * downstream trusts it. Both halves are re-validated as UUIDs and then checked against
 * rows — the service against the customer who owns it, the package against the kind the
 * path is for.
 *
 * `callback_ref`, the registry table Phase 0 planned for exactly this, was dropped by
 * `0002_drop_callback_refs` for having no producer and no reader. This needs no row: the
 * two ids ARE the message, so there is nothing to look up.
 */
export function encodeIdPair(first: string, second: string): string {
  const bytes = Buffer.concat([uuidBytes(first), uuidBytes(second)]);
  return bytes.toString('base64url');
}

export function decodeIdPair(encoded: string): { first: string; second: string } | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(encoded, 'base64url');
  } catch {
    return null;
  }
  if (bytes.length !== 32) return null;
  return { first: uuidFrom(bytes.subarray(0, 16)), second: uuidFrom(bytes.subarray(16, 32)) };
}

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function uuidFrom(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The callback-data prefixes. One letter each, because Telegram caps `callback_data` at
 * 64 BYTES and a UUID is 36 of them.
 */
export const ORDER_CALLBACK_PREFIX = 'p:';
export const CONFIRM_CALLBACK_PREFIX = 'c:';
/**
 * The payment-method taps. Each names an ORDER and nothing else.
 *
 * That is the trust boundary, not an encoding detail: a callback is an INTENT and an
 * IDENTIFIER, never a quantity. There is no prefix here that could carry an amount, a
 * currency or a customer, so a modified client has nothing to tamper with beyond the
 * order id — and an id that is not theirs, or not awaiting payment, fails at MUTATION
 * time against the row rather than at render time against what the tap claimed.
 */
export const WALLET_PAY_CALLBACK_PREFIX = 'w:';
export const MANUAL_PAY_CALLBACK_PREFIX = 'm:';
/**
 * A rail this installation does not have.
 *
 * The button is NOT drawn — `paymentButtons` offers only what can be performed — and the
 * prefix exists anyway, because a customer holding an older message can still tap one.
 * Answering it with `bot.payment.unconfigured` is the honest reply; letting it fall
 * through to `bot.unknown_command` would tell them they typed something wrong.
 */
export const GATEWAY_PAY_CALLBACK_PREFIX = 'g:';

/**
 * Withdrawing a pending out-of-band payment. It names the PAYMENT, not the order.
 *
 * The only customer callback in this file that carries a payment id, and it has to: a
 * withdrawal names the thing being withdrawn, and an order can have had several
 * payments over its life. The id is still only an IDENTIFIER — the owner, the state and
 * the money are all re-read inside the transaction, which is what makes a guessed id
 * useless rather than dangerous.
 */
export const CANCEL_PAY_ASK_CALLBACK_PREFIX = 'x:';

/**
 * The second tap, and the only prefix that actually withdraws anything.
 *
 * TWO taps, because the first one sits on the message that told the customer to go and
 * transfer money and that message stays in their chat for ever. A customer who has
 * already paid and mis-touches it would otherwise have closed the payment their
 * transfer was against — permanently, since `PAYMENT_MACHINE` has no edge out of
 * `CANCELLED` and migration 0052 freezes the row — and nothing would tell the operator.
 *
 * `SERVICE_TERMINATE_ASK_CALLBACK_PREFIX` and its partner are the same pair for the
 * same reason, and that precedent is why this is not an invention: a destructive tap a
 * customer can reach by scrolling is asked about, not performed.
 */
export const CANCEL_PAY_CALLBACK_PREFIX = 'z:';

/**
 * The customer saying they have sent the transfer. The opposite of `x:`/`z:`.
 *
 * ONE tap, not two, and the asymmetry is deliberate: the withdrawal pair is asked about
 * because it closes a payment for ever, and this closes nothing. It stamps a claim that
 * an operator reads, and a claim made by accident is corrected by the operator finding
 * no transfer — which is the same thing they do for a claim made in good faith about a
 * transfer their bank later bounces.
 *
 * It names the PAYMENT, like the withdrawal pair and for the same reason: an order can
 * have had several payments over its life and this message is about one of them.
 */
export const PAY_SENT_CALLBACK_PREFIX = 'i:';

/**
 * Withdrawing the ORDER, not one payment. The second destructive pair in this file.
 *
 * `x:`/`z:` close one transfer instruction and leave the order open to be paid another
 * way. These close the order itself, which `ORDER_MACHINE` has no edge out of — so the
 * quoted price goes with it. Two taps, for the reason `CANCEL_PAY_CALLBACK_PREFIX`
 * gives at length: the message carrying the first button stays in the chat for ever.
 */
export const CANCEL_ORDER_ASK_CALLBACK_PREFIX = 'd:';
export const CANCEL_ORDER_CALLBACK_PREFIX = 'f:';
/**
 * A tap on one of the customer's own services, and a request to send its link again.
 *
 * Both name a SERVICE id and nothing else, which is the same trust boundary the payment
 * prefixes state: a callback is an intent and an identifier, never a quantity and never
 * a subscription. The link a resend produces is read from the row, so a modified client
 * has nothing to tamper with beyond the id — and an id that is not theirs fails at
 * `getForCustomer`, against the row, with the same answer an id that does not exist
 * gets.
 */
/**
 * Starting a wallet top-up, and choosing one of the offered amounts.
 *
 * `o:` carries NOTHING — it is the button under the balance, and the amounts it shows are
 * read from `wallet.topup.presets` when the tap arrives rather than baked into the data.
 *
 * `y:` carries the chosen amount in MINOR UNITS, and it is the one callback in this file
 * that carries a figure. `WalletTopupIntent` states why at length: there is no order to
 * read an amount from, the service MATCHES this against the configured presets rather
 * than believing it, and an index into the list would be silently honoured as a different
 * amount when an operator edits the presets between the keyboard and the tap.
 */
export const TOPUP_MENU_CALLBACK_PREFIX = 'o:';
export const TOPUP_PICK_CALLBACK_PREFIX = 'y:';

export const SERVICE_CALLBACK_PREFIX = 's:';
/**
 * The next page of the customer's own service list.
 *
 * `l:` because every other lowercase letter is taken; the table above is the registry.
 * What follows is `encodeKeysetToken`'s token, not a uuid, which is why this prefix is
 * routed separately from every other one here.
 */
export const SERVICES_PAGE_CALLBACK_PREFIX = 'l:';
export const SERVICE_RESEND_CALLBACK_PREFIX = 'r:';

/**
 * The three management actions, and the two halves of ending a service.
 *
 * Four prefixes for three operations, because TERMINATE is TWO taps: `t:` opens the
 * confirmation and `k:` is the only callback in this surface that plans one. Nothing
 * about which operation to perform is parsed out of the payload — the type is decided
 * by WHICH prefix matched, and each is a fixed two-character string. A modified client
 * can change the id after the colon and nothing else, and an id that is not theirs is
 * refused against the row.
 *
 * The letters are arbitrary, as `p:` for an order and `c:` for a confirmation already
 * are; what matters is that no prefix is a prefix of another, which `intentOf` relies
 * on and a unit test pins.
 */
export const SERVICE_SUSPEND_CALLBACK_PREFIX = 'u:';
export const SERVICE_RESUME_CALLBACK_PREFIX = 'e:';
export const SERVICE_TERMINATE_ASK_CALLBACK_PREFIX = 't:';
export const SERVICE_TERMINATE_CALLBACK_PREFIX = 'k:';
/*
 * The five commercial prefixes.
 *
 * `n:`, `v:` and `h:` each open a QUOTE and buy nothing — they name a service. `a:` and
 * `b:` name a service AND a package, and they are TWO prefixes rather than one because
 * the KIND has to come from which button was pressed: with one shared prefix the kind
 * would have to be read off the package the customer chose, and then the check that an
 * `ADD_TIME` package cannot be bought through the extra-traffic path would be checking
 * a value against itself. `q:` names the order the quote produced and is the only one
 * that commits.
 *
 * None of them carries a price, a quantity or a duration, which is the rule the whole
 * prefix table exists to make structural: a callback is an intent and an identifier.
 * `v:` and `h:` are single letters for the reason the others are — `callback_data` is
 * capped at 64 bytes and a UUID is 36 of them.
 */
export const SERVICE_RENEW_CALLBACK_PREFIX = 'n:';
export const SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX = 'v:';
export const SERVICE_ADD_TIME_CALLBACK_PREFIX = 'h:';
export const SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX = 'a:';
export const SERVICE_BUY_TIME_CALLBACK_PREFIX = 'b:';
export const SERVICE_ACTION_CONFIRM_CALLBACK_PREFIX = 'q:';

/**
 * The two username-mode buttons.
 *
 * Both carry the ORDER, not the mode-plus-order: the mode is which button was tapped,
 * and a callback that carried it as data would be a mode a client could choose for
 * itself. The server re-checks the chosen mode against the panel's policy anyway —
 * a button drawn before an operator changed the policy is not authorisation.
 */
export const USERNAME_CUSTOM_CALLBACK_PREFIX = 'j:';
export const USERNAME_AUTOMATIC_CALLBACK_PREFIX = 'Z:';

/**
 * The management panel's prefixes (Phase 5T), deliberately UPPERCASE.
 *
 * Every customer-facing prefix above is a lowercase letter, so no admin prefix can ever
 * become a prefix of one of those — the collision the resend/service pair states as a
 * silent failure, where every tap routes to whichever branch was tested first.
 *
 * `callback_data` is capped at 64 bytes, which is what decides the shape of these: a
 * prefix plus ONE uuid (38 bytes) fits and a prefix plus two does not. So the panel
 * carries a payment or an administrator and never a pair, and nothing here carries a
 * Telegram id — that arrives by command, where there is room for it.
 */
/**
 * How many queue rows one screen shows.
 *
 * A bound on a KEYBOARD, like `TOPUP_PRESETS_MAX`: Telegram refuses a reply_markup past
 * its own limits, and an unbounded queue is a panel that stops working exactly when an
 * installation is busiest. Ten is what the service asks for, applied in SQL against the
 * same predicate — so ten rows are ten decisions still to make.
 */
const ADMIN_QUEUE_LIMIT = 10;
/*
 * How many roster rows one keyboard carries.
 *
 * Larger than `ADMIN_QUEUE_LIMIT` because these are not work items to be
 * cleared — an operator is looking somebody up, and a roster is people created
 * by hand rather than a customer-sized set. Small enough that the keyboard is
 * well inside Telegram's limit whatever the usernames are. The header prints
 * `shown` against `total`, so reaching this bound is visible rather than silent.
 */
const ADMIN_ROSTER_LIMIT = 30;

/**
 * What `bot.admin.panel_detail` renders for a panel with no cap.
 *
 * A LITERAL rather than a template key, and that is a deliberate exception worth
 * stating: `cap` is a `STRING` placeholder inside a message the catalogue owns, and a
 * surface may not compose one template out of another. What it may do is pass a value,
 * and the honest value for "unlimited" is a dash — a figure would read as a cap and
 * `0` would read as a full panel, which is the exact inversion a null means.
 */
const UNCAPPED = '\u2014';

/**
 * The two marks `bot.admin.panel_detail` renders for a username mode.
 *
 * Symbols and not words, for exactly the reason `UNCAPPED` is an em dash: the copy
 * belongs to the catalogue and a surface may pass a VALUE into it but may not compose
 * one message out of another. `ON` is a tick and `OFF` is the same dash the cap uses
 * for "there is none", so the three lines of this block read consistently.
 */
const MODE_ON = '\u2713';
const MODE_OFF = UNCAPPED;

/**
 * The two permissions the panel's sections charge, named once.
 *
 * Read through the guard by the services behind each section; these constants only
 * decide which BUTTONS exist, which is not authorization — `docs/conventions.md`:
 * never by not drawing a button.
 */
const RECEIPTS_VIEW_PERMISSION = 'receipts.view' as PermissionKey;
const ADMINS_VIEW_PERMISSION = 'admins.view' as PermissionKey;
/*
 * What the roster's status buttons are DRAWN for, and nothing more.
 * `AdminManagementService.setStatus` charges it through the same guard the Web Admin
 * uses, and re-checks it inside the writing transaction, so a crafted `7:` callback
 * from an administrator who lacks it is refused there and leaves the denial record.
 */
const ADMINS_EDIT_PERMISSION = 'admins.edit' as PermissionKey;
const RECEIPTS_REVIEW_PERMISSION = 'receipts.review' as PermissionKey;
/*
 * The three the services section reads, and the same rule applies: these decide which
 * BUTTONS exist, which is not authorization. `ServiceAdminService`, `ProvisioningService`
 * and `DeliveryService` each charge their own key through the same guard the Web Admin
 * uses, so a crafted callback from an administrator who lacks one is refused there.
 */
const SERVICES_VIEW_PERMISSION = 'services.view' as PermissionKey;
const SERVICES_EDIT_PERMISSION = 'services.edit' as PermissionKey;
const SERVICES_TERMINATE_PERMISSION = 'services.terminate' as PermissionKey;
/*
 * The two the panels section reads, and the same rule again: these decide which BUTTONS
 * exist, never what is allowed. `PanelService.list` and `.get` charge `panels.view`;
 * `.testConnection` and `.setStatus` charge `panels.edit`, through the same guard the
 * Web Admin uses. There is deliberately no third key here, because this surface never
 * touches a credential: `panels.credentials.rotate` has no button in Telegram at all.
 */
const PANELS_VIEW_PERMISSION = 'panels.view' as PermissionKey;
/*
 * ONE key for both halves of the reminders section, because there is only one.
 *
 * The section prints five SETTINGS and three FLAGS, and this used to gate it on
 * `settings.view` AND `features.view` — a pair that reads sensibly and cannot be
 * satisfied: `features.view` is in no catalogue. `PERMISSIONS` does not define it, so
 * no role can be granted it, so the button was drawn for nobody, including the owner.
 *
 * The real answer is that flags are not separately permissioned in this product:
 * `FeatureFlagsService` charges `settings.view` for a read and `settings.edit` for a
 * write, deliberately and in terms. So does this.
 */
const SETTINGS_VIEW_PERMISSION = 'settings.view' as PermissionKey;
const PANELS_EDIT_PERMISSION = 'panels.edit' as PermissionKey;
/*
 * The two the customers section reads, and the same rule a fourth time: these decide
 * which BUTTONS exist, never what is allowed. `CustomerService.list` and `.get` charge
 * `users.view`; `.list` charges `users.search` ON TOP of it when the search names a
 * Telegram id, which is why the lookup command is a different question from the list;
 * `.block` and `.unblock` charge `users.block` and re-check it inside the writing
 * transaction. A crafted `9:` callback from an administrator holding none of them is
 * refused there and leaves the denial record.
 *
 * `users.edit` is deliberately absent. It is declared, it is seeded to `operator`, and
 * nothing charges it — see the comment above it in `packages/contracts/src/permissions.ts`
 * for why that is the product's answer rather than an unfinished feature. Drawing an
 * edit button here would be the first thing to make it a lie.
 */
const CUSTOMERS_VIEW_PERMISSION = 'users.view' as PermissionKey;
const CUSTOMERS_BLOCK_PERMISSION = 'users.block' as PermissionKey;

/**
 * The key each section of the management panel is ADVERTISED by, in one list.
 *
 * Two readers: `adminTurn`, which answers as a customer when an administrator holds
 * none of them, and `isAdmin`, which decides whether `/start` draws the panel row at
 * all. The comment on `isAdmin` already said these two must agree — "the keyboard must
 * not promise a panel the turn would refuse, and it must not withhold one from an
 * administrator who has a section" — and they had stopped agreeing: the reminders
 * section was added with `settings.view` and only one of the two lists learned about
 * it, so an administrator whose only section was the reminders got no panel row and no
 * way to reach one from the keyboard. That is precisely the "missing arm" the comment
 * names, hand-maintained in two places.
 *
 * So there is one list and both read it, the way `ADMIN_INTENTS` is derived rather than
 * listed. Adding a section means adding one entry here, and it cannot half-land.
 *
 * `users.block`, `panels.edit`, `services.edit` and the rest are deliberately absent:
 * this list is what OPENS a section, never what may be done inside one.
 */
const PANEL_SECTION_PERMISSIONS: readonly PermissionKey[] = [
  RECEIPTS_VIEW_PERMISSION,
  ADMINS_VIEW_PERMISSION,
  SERVICES_VIEW_PERMISSION,
  PANELS_VIEW_PERMISSION,
  SETTINGS_VIEW_PERMISSION,
  CUSTOMERS_VIEW_PERMISSION,
];

/** Whether these permissions open any section of the panel. */
function hasAnyPanelSection(permissions: ReadonlySet<PermissionKey>): boolean {
  return PANEL_SECTION_PERMISSIONS.some((key) => permissions.has(key));
}

/**
 * The intents `adminTurn` owns, so `act` has one branch rather than nineteen.
 *
 * DERIVED from the name rather than listed, and that is the fix for a defect rather
 * than a tidy-up: it was a hand-kept copy of a naming convention, and Phase 6A added
 * ten `ADMIN_*` intents to `BOT_INTENTS`, wired every one into `adminTurn`'s switch,
 * and did not add them here. `act` never routed them, so an administrator who pressed
 * the services buttons got the unknown-input reply — the exact answer a customer gets,
 * which is why nothing about it looked broken.
 *
 * The convention is total: every intent this runtime routes to the management panel is
 * named `ADMIN_…`, and nothing else is. A new section now reaches the panel by being
 * named, which is one fewer list to forget.
 */
const ADMIN_INTENTS: ReadonlySet<BotIntent> = new Set<BotIntent>(
  BOT_INTENTS.filter((intent) => intent.startsWith('ADMIN_')),
);

export const ADMIN_PANEL_CALLBACK_PREFIX = 'A:';
export const ADMIN_RECEIPTS_CALLBACK_PREFIX = 'B:';
export const ADMIN_RECEIPT_CALLBACK_PREFIX = 'C:';
export const ADMIN_APPROVE_CALLBACK_PREFIX = 'D:';
export const ADMIN_REJECT_CALLBACK_PREFIX = 'E:';
export const ADMIN_SECTION_CALLBACK_PREFIX = 'F:';
export const ADMIN_REVOKE_CALLBACK_PREFIX = 'G:';
/*
 * The services section, Phase 6A. One prefix per action, which is the pattern the
 * CUSTOMER half already uses for its own service actions and the reason the registry
 * above is readable: a prefix means one thing. Each carries one uuid, so `X:` plus a
 * service id is 38 bytes and the pair-carrying codec is not needed.
 */
export const ADMIN_SERVICES_CALLBACK_PREFIX = 'H:';
export const ADMIN_SERVICE_CALLBACK_PREFIX = 'I:';
export const ADMIN_SERVICE_SYNC_CALLBACK_PREFIX = 'J:';
export const ADMIN_SERVICE_RESEND_CALLBACK_PREFIX = 'K:';
export const ADMIN_SERVICE_RETRY_CALLBACK_PREFIX = 'L:';
export const ADMIN_SERVICE_RECONCILE_CALLBACK_PREFIX = 'M:';
export const ADMIN_SERVICE_SUSPEND_CALLBACK_PREFIX = 'N:';
export const ADMIN_SERVICE_RESUME_CALLBACK_PREFIX = 'O:';
export const ADMIN_SERVICE_TERMINATE_ASK_CALLBACK_PREFIX = 'P:';
/** The one destructive admin callback. Produced by the confirmation screen alone. */
export const ADMIN_SERVICE_TERMINATE_CALLBACK_PREFIX = 'Q:';
/*
 * The panels section, Phase 6B. `R:` and `S:` are the section and one panel; `Y:` is
 * the only one of the eight that carries a CURSOR rather than a uuid, which is why it
 * is decoded at the boundary like `l:` and not run through `callbackCommand`.
 */
export const ADMIN_PANELS_CALLBACK_PREFIX = 'R:';
export const ADMIN_PANEL_DETAIL_CALLBACK_PREFIX = 'S:';
export const ADMIN_PANEL_TEST_CALLBACK_PREFIX = 'T:';
export const ADMIN_PANEL_ENABLE_CALLBACK_PREFIX = 'U:';
export const ADMIN_PANEL_DISABLE_CALLBACK_PREFIX = 'V:';
export const ADMIN_PANEL_ARCHIVE_ASK_CALLBACK_PREFIX = 'W:';
/** The one archiving callback. Produced by the confirmation screen alone. */
export const ADMIN_PANEL_ARCHIVE_CALLBACK_PREFIX = 'X:';
export const ADMIN_PANELS_PAGE_CALLBACK_PREFIX = 'Y:';

/**
 * The reminder settings section.
 *
 * DIGITS, because every one of the fifty-two single letters is already a prefix. The
 * shape is unchanged — one character, a colon, then the payload — and a digit cannot
 * collide with a letter, so the dispatch order below stays unambiguous.
 */
export const ADMIN_REMINDERS_CALLBACK_PREFIX = '0:';
export const ADMIN_REMINDER_EDIT_CALLBACK_PREFIX = '1:';
export const ADMIN_REMINDER_SET_CALLBACK_PREFIX = '2:';

/**
 * The username-policy section's three tap prefixes.
 *
 * Digits, because every letter in both cases is already spoken for by the table above
 * — and a digit can never become a prefix of a lettered one, which is the collision
 * that whole table exists to prevent.
 *
 * `4:` and `5:` carry a code AND a uuid, separated by a colon, which fits inside the
 * 64-byte `callback_data` cap with room to spare (42 bytes at the longest). The code
 * in `4:` is the TARGET value rather than "flip it": a double tap then writes the same
 * value twice instead of toggling twice, which is the difference between an idempotent
 * button and one that undoes itself on a slow connection.
 */
/*
 * The administrator roster's two tap prefixes, WP1. Digits, for the reason the block
 * above gives: every letter is spoken for. `7:` carries a status CODE and a uuid the
 * way `4:` carries a field and one, which is 39 bytes at the longest.
 */
export const ADMIN_ADMIN_CALLBACK_PREFIX = '6:';
export const ADMIN_ADMIN_STATUS_CALLBACK_PREFIX = '7:';

/*
 * The customers section, WP2. The LAST two free prefixes on this surface.
 *
 * Fifty-two letters and eight digits were already spoken for, so these are `8:` and
 * `9:` and there is no `10:` — a two-character prefix would break the one property
 * `intentOf` relies on, that no prefix is a prefix of another. A seventh section will
 * need that registry reorganised rather than extended, and this comment is where the
 * next author finds that out before designing around a prefix that does not exist.
 *
 * So the two carry more than one meaning each, and both are disambiguated at the
 * boundary rather than downstream:
 *
 * - `8:` alone is the section; `8:<token>` is a page of it. One meaning — "show me a
 *   page of customers" — with the payload deciding which page, so there is no reading
 *   of this prefix that acts on anybody.
 * - `9:<code>:<uuid>` is one customer, where the code says which of the three things to
 *   do with them. A TABLE maps code to intent, for the reason `ADMIN_SERVICE_CALLBACKS`
 *   gives: three near-identical `if`s is three chances to point a code at the wrong
 *   intent, and the one that matters is the code that BLOCKS. 39 bytes at the longest,
 *   the same shape `7:` uses for an administrator's status.
 */
export const ADMIN_CUSTOMERS_CALLBACK_PREFIX = '8:';
export const ADMIN_CUSTOMER_CALLBACK_PREFIX = '9:';

/**
 * What a `9:` code means, as a table rather than a chain of comparisons.
 *
 * `v` reads, `b` blocks, `u` unblocks. Validated at the boundary against this map, so
 * an unknown code is UNSUPPORTED and never becomes an intent — the same treatment the
 * reminder codes, the username toggles and the administrator statuses get.
 */
const ADMIN_CUSTOMER_CODES = {
  v: 'ADMIN_CUSTOMER',
  b: 'ADMIN_CUSTOMER_BLOCK',
  u: 'ADMIN_CUSTOMER_UNBLOCK',
} as const;
type AdminCustomerCode = keyof typeof ADMIN_CUSTOMER_CODES;

function isAdminCustomerCode(value: string): value is AdminCustomerCode {
  return Object.hasOwn(ADMIN_CUSTOMER_CODES, value);
}

export const ADMIN_USERNAME_CALLBACK_PREFIX = '3:';
export const ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX = '4:';
export const ADMIN_USERNAME_STRATEGY_CALLBACK_PREFIX = '5:';

/**
 * The two statuses a roster tap can set, and the letter each travels as.
 *
 * There is no third letter because there is no third status: `audit_logs` references
 * administrators and refuses DELETE, so `DISABLED` is this product's answer to
 * removing one and a deletion button would have nothing behind it.
 */
const ADMIN_STATUS_CODES = { a: 'ACTIVE', d: 'DISABLED' } as const;
type AdminStatusCode = keyof typeof ADMIN_STATUS_CODES;
function isAdminStatusCode(value: string): value is AdminStatusCode {
  return Object.prototype.hasOwnProperty.call(ADMIN_STATUS_CODES, value);
}

/** Which of the two customer choices a `4:` tap is setting. */
const USERNAME_TOGGLE_FIELDS = { c: 'allowCustom', a: 'allowAutomatic' } as const;
type UsernameToggleField = keyof typeof USERNAME_TOGGLE_FIELDS;
function isUsernameToggleField(value: string): value is UsernameToggleField {
  return Object.prototype.hasOwnProperty.call(USERNAME_TOGGLE_FIELDS, value);
}

/**
 * The three presets a TAP can select, and the letter each travels as.
 *
 * `CUSTOM_TEMPLATE` is deliberately absent. The other three either take no
 * configuration or have a default prefix, so a tap is a complete instruction; a
 * template does not exist until somebody writes one, and the message that writes it —
 * `/panel_template` — is what selects the preset. A button that selected
 * `CUSTOM_TEMPLATE` with nothing behind it could only ever be refused.
 */
const USERNAME_STRATEGY_CODES = {
  r: 'RANDOM',
  p: 'PREFIX_RANDOM',
  t: 'TELEGRAM_ID_RANDOM',
} as const;
type UsernameStrategyCode = keyof typeof USERNAME_STRATEGY_CODES;
function isUsernameStrategyCode(value: string): value is UsernameStrategyCode {
  return Object.prototype.hasOwnProperty.call(USERNAME_STRATEGY_CODES, value);
}
const USERNAME_STRATEGY_BUTTONS: readonly (readonly [UsernameStrategyCode, TemplateKey])[] = [
  ['r', 'bot.admin.username_strategy_random'],
  ['p', 'bot.admin.username_strategy_prefix_random'],
  ['t', 'bot.admin.username_strategy_telegram_id_random'],
];

/**
 * The five editable thresholds, as the two-letter codes the callback data carries.
 *
 * A closed map rather than the registry key itself, because `callback_data` is capped
 * at 64 bytes and `reminders.usage_second_percent` is half of it before a value is
 * appended. It is also the VALIDATION: a code that is not in this map is refused at the
 * boundary, so no client-supplied string ever reaches the settings service as a key.
 */
export const REMINDER_SETTING_CODES = {
  ef: 'reminders.expiry_first_days',
  es: 'reminders.expiry_second_days',
  uf: 'reminders.usage_first_percent',
  us: 'reminders.usage_second_percent',
  un: 'reminders.usage_final_percent',
} as const satisfies Record<string, SettingKey>;
export type ReminderSettingCode = keyof typeof REMINDER_SETTING_CODES;

/** The button label for each code's chooser. One template per setting, so each names itself. */
const REMINDER_SETTING_BUTTONS = {
  ef: 'bot.admin.reminder_expiry_first_button',
  es: 'bot.admin.reminder_expiry_second_button',
  uf: 'bot.admin.reminder_usage_first_button',
  us: 'bot.admin.reminder_usage_second_button',
  un: 'bot.admin.reminder_usage_final_button',
} as const satisfies Record<ReminderSettingCode, TemplateKey>;

/**
 * The values a tap may choose, per family.
 *
 * A SMALL MENU OF SCALARS, which is CBR-011's shape (B) and the one Mirza uses for the
 * settings that are not free text. Every entry is inside the contract's own bounds, so
 * a tap cannot propose a value the schema would reject — the schema still checks, and
 * the combination guard still checks, but an operator never meets a refusal they could
 * not have avoided.
 */
const REMINDER_DAY_OPTIONS = [1, 2, 3, 5, 7, 10, 14, 30] as const;
const REMINDER_PERCENT_OPTIONS = [50, 60, 70, 75, 80, 85, 90, 95, 100] as const;

function reminderOptionsFor(code: ReminderSettingCode): readonly number[] {
  return code === 'ef' || code === 'es' ? REMINDER_DAY_OPTIONS : REMINDER_PERCENT_OPTIONS;
}

/** The order the section draws its five buttons in: expiry first, then usage. */
const REMINDER_SETTING_CODE_ORDER = [
  'ef',
  'es',
  'uf',
  'us',
  'un',
] as const satisfies readonly ReminderSettingCode[];

/** The value a code currently names, so the chooser can print it before replacing it. */
function reminderValueOf(config: ServiceReminderThresholds, code: ReminderSettingCode): number {
  switch (code) {
    case 'ef':
      return config.expiryFirstDays;
    case 'es':
      return config.expirySecondDays;
    case 'uf':
      return config.usageFirstPercent;
    case 'us':
      return config.usageSecondPercent;
    case 'un':
      return config.usageFinalPercent;
  }
}

/**
 * A switch, as the section prints it.
 *
 * A SYMBOL and not a word, and that is the whole reason this compiles: `check:i18n`
 * refuses hard-coded customer-facing strings in a surface, and «روشن»/«خاموش» here was
 * exactly that — a translatable sentence fragment living outside the catalogue. An
 * earlier revision of this function had them with a comment explaining why it was
 * acceptable; the comment was wrong and the check said so.
 *
 * The pair is also the vocabulary an operator already reads: Mirza's capability list
 * marks every toggle ✅ or ❌ (CBR-009), so this says the same thing the same way.
 */
function onOff(enabled: boolean): string {
  return enabled ? '\u2705' : '\u274c';
}

/** Unknown codes fail closed, which is what makes the map above a boundary check. */
function isReminderSettingCode(value: string): value is ReminderSettingCode {
  return Object.prototype.hasOwnProperty.call(REMINDER_SETTING_CODES, value);
}

/**
 * Each services-section prefix and the intent it parses to, in ONE place.
 *
 * Read by the boundary and by nothing else. Written as a table so the prefix and the
 * intent are chosen together: nine separate branches would be nine chances to point one
 * at the wrong intent, and the row that would matter is the last, where a mis-wiring
 * would turn the asking callback into the destructive one.
 */
/**
 * The operation each acting intent plans, and the button that offers it.
 *
 * `ADMIN_SERVICE_RESEND` and `ADMIN_SERVICE_RETRY` are absent from the operation map on
 * purpose: a resend plans none, and a retry goes through `retryProvisioning`, which has
 * its own refusal for the case that matters — an UNRECONCILED service is reconciled
 * rather than given a second provider account.
 */
const ADMIN_SERVICE_OPERATIONS: Readonly<Partial<Record<BotIntent, OperatorServiceOperation>>> = {
  ADMIN_SERVICE_SYNC: 'SYNC_USAGE',
  ADMIN_SERVICE_RECONCILE: 'RECONCILE',
  ADMIN_SERVICE_SUSPEND: 'SUSPEND',
  ADMIN_SERVICE_RESUME: 'RESUME',
  ADMIN_SERVICE_TERMINATE: 'TERMINATE',
};

/**
 * Each action's button: which verdict offers it, which permission allows it, and where
 * it points.
 *
 * TERMINATE points at the ASKING prefix. That is the row this table exists to make
 * visible, because a destructive callback drawn on a detail screen is a one-tap
 * deletion, and the difference between the two prefixes is one letter.
 */
const ADMIN_SERVICE_BUTTONS: readonly {
  readonly action: ServiceOperatorAction;
  readonly key: TemplateKey;
  readonly prefix: string;
  readonly permission: PermissionKey;
}[] = [
  {
    action: 'SYNC_USAGE',
    key: 'bot.admin.service_sync_button',
    prefix: ADMIN_SERVICE_SYNC_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
  {
    action: 'RESEND_CONFIG',
    key: 'bot.admin.service_resend_button',
    prefix: ADMIN_SERVICE_RESEND_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
  {
    action: 'RETRY_PROVISION',
    key: 'bot.admin.service_retry_button',
    prefix: ADMIN_SERVICE_RETRY_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
  {
    action: 'RECONCILE',
    key: 'bot.admin.service_reconcile_button',
    prefix: ADMIN_SERVICE_RECONCILE_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
  {
    action: 'SUSPEND',
    key: 'bot.admin.service_suspend_button',
    prefix: ADMIN_SERVICE_SUSPEND_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
  {
    action: 'RESUME',
    key: 'bot.admin.service_resume_button',
    prefix: ADMIN_SERVICE_RESUME_CALLBACK_PREFIX,
    permission: SERVICES_EDIT_PERMISSION,
  },
  {
    action: 'TERMINATE',
    key: 'bot.admin.service_terminate_button',
    prefix: ADMIN_SERVICE_TERMINATE_ASK_CALLBACK_PREFIX,
    permission: SERVICES_TERMINATE_PERMISSION,
  },
];

/**
 * The buttons one service's detail draws, for one administrator.
 *
 * TWO conditions, and both are necessary. The VERDICT says the service allows the action
 * right now — the state, the provider's capabilities, the panel's configuration, and
 * whether one of that type is already open — and comes from the same evaluator the write
 * paths agree with. The PERMISSION says this administrator may ask for it. Drawing a
 * button that fails either is drawing a control whose every press records a denial,
 * which is the noise the alerts page exists to keep clear.
 *
 * Neither is authorization. Every action re-checks its permission and all its conditions
 * inside its own request; `docs/conventions.md` names the rule this must not be read as
 * satisfying — never by not drawing a button.
 */
function adminServiceButtons(
  serviceId: string,
  actions: readonly ServiceActionAvailability[],
  permissions: ReadonlySet<PermissionKey>,
): CustomerButton[] {
  const available = new Set(
    actions.filter((entry) => entry.available).map((entry) => entry.action),
  );
  return ADMIN_SERVICE_BUTTONS.filter(
    (button) => available.has(button.action) && permissions.has(button.permission),
  ).map((button) => ({
    label: { kind: 'TEMPLATE' as const, key: button.key },
    data: `${button.prefix}${serviceId}`,
  }));
}

/**
 * What a customer's row says, in the order an operator recognises them.
 *
 * `@username` when there is one, else the name Telegram reported, else the numeric id.
 * A customer may have none of the first two, so the id is the fallback rather than a
 * dash: a row reading `— ACTIVE` names nobody, and a keyboard of them is unusable.
 *
 * The numeric id is NOT withheld here the way an administrator's is. The reason that
 * roster withholds it is that a forwardable message naming where an administrator signs
 * in from is most of the way to finding them; a customer's Telegram id is the handle the
 * support conversation already quoted, it is on the Web Admin list, and this surface
 * exists so an operator can act on it from a phone.
 *
 * The status rides along, because the one thing an operator scanning this list is
 * looking for is who is blocked.
 */
function adminCustomerLabel(customer: CustomerRecord): string {
  const name = [customer.firstName, customer.lastName].filter((part) => part !== null).join(' ');
  const who =
    customer.username !== null
      ? `@${customer.username}`
      : name !== ''
        ? name
        : customer.telegramUserId;
  return `${who} — ${customer.status}`;
}

/**
 * The detail screen for one customer, shared by the read, the lookup and the write.
 *
 * ONE builder, so the buttons an operator sees after a change are the buttons the new
 * state actually offers — a second copy is how a block leaves a "block" button on the
 * screen, which is the defect `adminAdminReply` was written to avoid and the same one
 * applies here.
 *
 * The status button offered is the OPPOSITE of the status held, and neither is drawn
 * without `users.block`. That is a courtesy: `CustomerService.setStatus` charges the key
 * through the guard and re-checks it inside the writing transaction, so a crafted `9:b:`
 * callback from an administrator who lacks it is refused there and leaves the record.
 *
 * What this screen carries is a person and nothing they bought. No wallet balance, no
 * order, no service, no subscription reference: each is a different permission, and a
 * Telegram message is forwardable — which is the argument ADR-0023 makes about panel
 * credentials and `services.tsx` makes about subscription URLs.
 */
function adminCustomerReply(
  customer: CustomerRecord,
  permissions: ReadonlySet<PermissionKey>,
): PendingReply {
  const buttons: CustomerButton[] = [];
  if (permissions.has(CUSTOMERS_BLOCK_PERMISSION)) {
    const blocked = customer.status === 'BLOCKED';
    buttons.push({
      label: {
        kind: 'TEMPLATE',
        key: blocked ? 'bot.admin.customer_unblock_button' : 'bot.admin.customer_block_button',
      },
      /*
       * The TARGET status, not "flip it".
       *
       * A double tap then writes the same status twice — which `setStatus`'s conditional
       * UPDATE answers as a successful no-op — instead of toggling twice, which is the
       * difference between an idempotent button and one that undoes itself on a slow
       * connection. The same reasoning `4:` and `7:` record.
       */
      data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}${blocked ? 'u' : 'b'}:${customer.id}`,
    });
  }
  buttons.push({
    label: { kind: 'TEMPLATE', key: 'bot.admin.customers_back_button' },
    data: ADMIN_CUSTOMERS_CALLBACK_PREFIX,
  });
  const name = [customer.firstName, customer.lastName].filter((part) => part !== null).join(' ');
  return {
    key: 'bot.admin.customer_detail',
    values: {
      telegramId: customer.telegramUserId,
      username: customer.username === null ? '—' : `@${customer.username}`,
      name: name === '' ? '—' : name,
      status: customer.status,
      /*
       * The operator note, or a dash — never a stale one.
       *
       * `setStatus` clears it on an unblock precisely so a reason cannot outlive the
       * block it explains, and this renders whatever it finds rather than deciding by
       * status: two places deciding when a reason is current is how they disagree.
       */
      reason: customer.blockedReason ?? '—',
      firstSeen: customer.firstSeenAt,
      lastSeen: customer.lastSeenAt,
    },
    buttons,
    orderId: null,
  };
}

/**
 * Whether a refusal is about the SERVICE rather than about the administrator.
 *
 * The four service refusals are things a person can act on — the state moved, the
 * provider cannot do it, the panel needs fixing, one of that type is already under way —
 * and they earn the sentence that says so. Everything else, a permission denial above
 * all, falls through to the panel's single refusal, which tells whoever holds that chat
 * nothing about what exists.
 */
function isServiceRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED ||
    code === COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE ||
    code === COMMERCE_ERROR_CODES.SERVICE_UNRECONCILED ||
    code === COMMERCE_ERROR_CODES.SERVICE_NOT_DELIVERABLE ||
    code === COMMERCE_ERROR_CODES.ORDER_STATE_INVALID
  );
}

/**
 * Whether a refusal means "no such customer" rather than "not you".
 *
 * The section's read paths catch NARROWLY, on these two codes alone, and rethrow
 * everything else — and that distinction is the whole point rather than tidiness. A
 * catch-all was the first version, and it answered an administrator who lacks
 * `users.view` with `bot.admin.customer_gone`: a sentence saying the person does not
 * exist, to somebody who was only refused permission to look. An operator acts on that
 * — they tell the customer there is no account — and the fact they were actually told
 * is about THEMSELVES, not about anybody's data, so there is nothing to protect by
 * blurring it.
 *
 * A denial therefore falls through to `adminTurn`'s single refusal, which is what every
 * other denial on this surface answers with, and `customer_gone` stays the one answer
 * for the four cases that genuinely mean "not here": unknown, malformed, another
 * tenant's, and a lookup that matched nobody.
 *
 * `COMMERCE_REQUEST_INVALID` is in the pair because `CustomerService.customerId`
 * raises it for an id that is not a UUIDv7 — which the callback boundary has already
 * refused, so it is reachable only from a typed command, and is still "no such
 * customer" from where an operator sits.
 */
function isCustomerMiss(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND ||
    code === COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID
  );
}

/**
 * Whether a refusal is about the PANEL rather than about the administrator.
 *
 * `PANEL_NOT_VALIDATED` earns its own answer, because it is the one refusal on this
 * screen an administrator can resolve without leaving it: the Test button is right
 * there. The rest — a status that moved, credentials that do not satisfy the
 * provider's shape, a spent probe budget, a lost race — are one sentence pointing at
 * the Web Admin, for the reason `isServiceRefusal` gives. A permission denial is in
 * neither set and falls through to the panel's single refusal, which tells whoever
 * holds that chat nothing about what exists.
 */
function isPanelRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return (
    code === PANEL_ERROR_CODES.PANEL_ARCHIVED ||
    code === PANEL_ERROR_CODES.PANEL_CREDENTIALS_MISSING ||
    code === PANEL_ERROR_CODES.PANEL_CREDENTIAL_UNSUPPORTED ||
    code === PANEL_ERROR_CODES.PANEL_PROBE_LIMITED ||
    code === PANEL_ERROR_CODES.PANEL_CONFIGURATION_CHANGED ||
    code === PANEL_ERROR_CODES.PANEL_NAME_TAKEN
  );
}

const ADMIN_PANEL_CALLBACKS: readonly (readonly [string, BotIntent])[] = [
  [ADMIN_PANEL_DETAIL_CALLBACK_PREFIX, 'ADMIN_PANEL_DETAIL'],
  [ADMIN_PANEL_TEST_CALLBACK_PREFIX, 'ADMIN_PANEL_TEST'],
  [ADMIN_PANEL_ENABLE_CALLBACK_PREFIX, 'ADMIN_PANEL_ENABLE'],
  [ADMIN_PANEL_DISABLE_CALLBACK_PREFIX, 'ADMIN_PANEL_DISABLE'],
  [ADMIN_PANEL_ARCHIVE_ASK_CALLBACK_PREFIX, 'ADMIN_PANEL_ARCHIVE_ASK'],
  /*
   * LAST, and the row that makes this a table rather than seven `if`s: a mis-wiring
   * here would make the ASKING callback the one that archives, which is the same
   * one-character mistake `ADMIN_SERVICE_CALLBACKS` names in its own comment.
   */
  [ADMIN_PANEL_ARCHIVE_CALLBACK_PREFIX, 'ADMIN_PANEL_ARCHIVE'],
  [ADMIN_USERNAME_CALLBACK_PREFIX, 'ADMIN_USERNAME'],
];

const ADMIN_SERVICE_CALLBACKS: readonly (readonly [string, BotIntent])[] = [
  [ADMIN_SERVICE_CALLBACK_PREFIX, 'ADMIN_SERVICE'],
  [ADMIN_SERVICE_SYNC_CALLBACK_PREFIX, 'ADMIN_SERVICE_SYNC'],
  [ADMIN_SERVICE_RESEND_CALLBACK_PREFIX, 'ADMIN_SERVICE_RESEND'],
  [ADMIN_SERVICE_RETRY_CALLBACK_PREFIX, 'ADMIN_SERVICE_RETRY'],
  [ADMIN_SERVICE_RECONCILE_CALLBACK_PREFIX, 'ADMIN_SERVICE_RECONCILE'],
  [ADMIN_SERVICE_SUSPEND_CALLBACK_PREFIX, 'ADMIN_SERVICE_SUSPEND'],
  [ADMIN_SERVICE_RESUME_CALLBACK_PREFIX, 'ADMIN_SERVICE_RESUME'],
  [ADMIN_SERVICE_TERMINATE_ASK_CALLBACK_PREFIX, 'ADMIN_SERVICE_TERMINATE_ASK'],
  [ADMIN_SERVICE_TERMINATE_CALLBACK_PREFIX, 'ADMIN_SERVICE_TERMINATE'],
];

/**
 * How many services one `/services` answer shows.
 *
 * A BOUND, not a page, and stated for the same reason `CATALOG_PAGE_SIZE` is: a customer
 * with more than twenty services sees twenty and is told nothing about the rest. How a
 * customer reaches a long list over Telegram is a product decision with no evidence
 * behind it in `docs/research/`, and `docs/open-questions.md` carries it rather than
 * this file guessing.
 */
export const SERVICES_PAGE_SIZE = 20;

/**
 * How many products one `/catalog` answer shows.
 *
 * A BOUND, not a page. `listCatalog` reports `hasMore` and this surface drops it on the
 * floor, so a tenant with more than twenty sellable products shows twenty and says
 * nothing about the rest. That is a real limit and it is stated here rather than left to
 * be discovered: how a customer reaches a long catalogue over Telegram — a next button,
 * categories, a search — is a product decision with no evidence behind it in
 * `docs/research/`, and `docs/open-questions.md` carries it rather than this file
 * guessing. Twenty is above any catalogue the research shows.
 */
export const CATALOG_PAGE_SIZE = 20;

/**
 * Reads the intent out of an update.
 *
 * Reads through passthrough fields rather than a modelled `message` shape, exactly as
 * `isPingCommand` already does: `telegramUpdateSchema` states what this installation
 * depends on and the rest of an update stays unmodelled on purpose. Anything unexpected
 * is `UNSUPPORTED`, which is a real answer and not an error.
 *
 * The command is matched on the FIRST token only, so `/start payload` is still `/start` —
 * Telegram's deep links put a payload there and 4F's referral codes arrive that way.
 * The payload itself is deliberately NOT returned here: nothing in 4A consumes it, and a
 * field nothing consumes is a field that gets logged.
 */
/**
 * What a tap on the persistent main menu sends, and the command it means.
 *
 * Telegram delivers a `ReplyKeyboardMarkup` tap as an ORDINARY TEXT MESSAGE whose body
 * is the button's label. There is no `callback_data`, no signature and no id — which is
 * why the menu carries no authority and every contextual action stays on the callback
 * architecture with its validated identifier and its ownership check.
 *
 * PASSED IN rather than read here, because a surface may not reach the catalogue: the
 * boundary check refuses `@nexa/i18n` in `surfaces/`, and its reason is this exact
 * shape — a surface that renders text itself is a second renderer beside the template
 * resolver. The composition root builds this map from the same catalogue the messenger
 * draws the keyboard from, so the string that is drawn and the string that is matched
 * come from one place and cannot disagree.
 *
 * Matched on the EXACT string. No case folding and no fuzzy match: an unknown text is
 * `UNSUPPORTED` exactly as it was before this existed.
 */
export type MainMenuRoutes = ReadonlyMap<string, string>;

/** No menu configured. The slash commands still answer; nothing else changes. */
const NO_MENU: MainMenuRoutes = new Map();

export function intentOf(update: unknown, menu: MainMenuRoutes = NO_MENU): BotCommand {
  const callback = (update as { callback_query?: { id?: unknown; data?: unknown } } | null)
    ?.callback_query;
  if (callback !== undefined && callback !== null) {
    const id = typeof callback.id === 'string' ? callback.id : null;
    const data = typeof callback.data === 'string' ? callback.data : '';
    /*
     * Validated here, not cast.
     *
     * `callback_data` is whatever the client sent. Telegram signs nothing about it, so a
     * modified client can put any string after the prefix — and the two services below
     * take an id. A malformed one is UNSUPPORTED, which answers the customer, rather
     * than a 500 at the `uuid` cast or a refusal that names the column.
     */
    if (data.startsWith(ORDER_CALLBACK_PREFIX)) {
      return callbackCommand('ORDER', data.slice(ORDER_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(CONFIRM_CALLBACK_PREFIX)) {
      return callbackCommand('CONFIRM', data.slice(CONFIRM_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(WALLET_PAY_CALLBACK_PREFIX)) {
      return callbackCommand('PAY_WALLET', data.slice(WALLET_PAY_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(MANUAL_PAY_CALLBACK_PREFIX)) {
      return callbackCommand('PAY_MANUAL', data.slice(MANUAL_PAY_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(GATEWAY_PAY_CALLBACK_PREFIX)) {
      return callbackCommand('PAY_GATEWAY', data.slice(GATEWAY_PAY_CALLBACK_PREFIX.length), id);
    }
    /*
     * ASK before the destructive prefix, and they are different letters so the order
     * cannot matter today. Fixed anyway for the reason the resend/service pair states:
     * if one ever became a prefix of the other every tap would route to whichever
     * branch came first, and here that is the difference between showing a customer a
     * question and closing the payment their money is against.
     */
    if (data.startsWith(CANCEL_PAY_ASK_CALLBACK_PREFIX)) {
      return callbackCommand(
        'PAY_CANCEL_ASK',
        data.slice(CANCEL_PAY_ASK_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(CANCEL_PAY_CALLBACK_PREFIX)) {
      return callbackCommand('PAY_CANCEL', data.slice(CANCEL_PAY_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(PAY_SENT_CALLBACK_PREFIX)) {
      return callbackCommand('PAY_SENT', data.slice(PAY_SENT_CALLBACK_PREFIX.length), id);
    }
    /*
     * The menu carries no target, so it is matched on the WHOLE string. `callbackCommand`
     * validates its slice as a uuid and would refuse an empty one, which is right for
     * every other prefix here and wrong for this: the tap means "show me the amounts".
     */
    if (data === TOPUP_MENU_CALLBACK_PREFIX) {
      return { intent: 'TOPUP_MENU', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(TOPUP_PICK_CALLBACK_PREFIX)) {
      /*
       * DIGITS, and the shape is validated here rather than parsed in the handler: the
       * data is client-supplied, so anything that is not a plain positive integer is
       * UNSUPPORTED — which answers the customer — instead of reaching `BigInt()` and
       * throwing a SyntaxError inside a transaction. The length bound stops a
       * megabyte-long number being converted at all; `PAYMENT_AMOUNT_MAX_MINOR` is
       * thirteen digits, and the service refuses anything not on the preset list anyway.
       */
      const raw = data.slice(TOPUP_PICK_CALLBACK_PREFIX.length);
      if (!/^[1-9]\d{0,19}$/.test(raw)) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return { intent: 'TOPUP_PICK', targetId: raw, callbackQueryId: id };
    }
    /* ASK before the destructive one, exactly as the payment pair above is ordered. */
    if (data.startsWith(CANCEL_ORDER_ASK_CALLBACK_PREFIX)) {
      return callbackCommand(
        'ORDER_CANCEL_ASK',
        data.slice(CANCEL_ORDER_ASK_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(CANCEL_ORDER_CALLBACK_PREFIX)) {
      return callbackCommand('ORDER_CANCEL', data.slice(CANCEL_ORDER_CALLBACK_PREFIX.length), id);
    }
    /*
     * The resend prefix is tested BEFORE the service prefix.
     *
     * `'r:'` and `'s:'` share no first character, so today the order is irrelevant — it
     * is fixed anyway because the failure it prevents is silent: a prefix that is a
     * prefix of another routes every tap to whichever branch comes first, and the
     * customer gets the wrong screen with nothing anywhere saying so.
     */
    if (data.startsWith(SERVICE_RESEND_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_RESEND',
        data.slice(SERVICE_RESEND_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_SUSPEND_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_SUSPEND',
        data.slice(SERVICE_SUSPEND_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_RESUME_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_RESUME',
        data.slice(SERVICE_RESUME_CALLBACK_PREFIX.length),
        id,
      );
    }
    /*
     * The ASK prefix is tested before the TERMINATE prefix, and they are different
     * letters so the order cannot matter today. It is fixed anyway for the reason the
     * resend/service pair states: if one ever became a prefix of the other, every tap
     * would route to whichever branch came first — and here that would be the
     * difference between showing a customer a question and deleting their account.
     */
    if (data.startsWith(SERVICE_TERMINATE_ASK_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_TERMINATE_ASK',
        data.slice(SERVICE_TERMINATE_ASK_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_TERMINATE_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_TERMINATE',
        data.slice(SERVICE_TERMINATE_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_RENEW_CALLBACK_PREFIX)) {
      return callbackCommand('SERVICE_RENEW', data.slice(SERVICE_RENEW_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_ADD_TRAFFIC',
        data.slice(SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_ADD_TIME_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_ADD_TIME',
        data.slice(SERVICE_ADD_TIME_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (
      data.startsWith(SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX) ||
      data.startsWith(SERVICE_BUY_TIME_CALLBACK_PREFIX)
    ) {
      const buying = data.startsWith(SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX)
        ? ('SERVICE_BUY_TRAFFIC' as const)
        : ('SERVICE_BUY_TIME' as const);
      /*
       * The one callback carrying two ids, and both go through the SAME validation the
       * single-id path uses. A malformed pair is `UNSUPPORTED`, not a 500 at a `uuid`
       * cast, and not a half-read that would buy a package for a service nobody named.
       */
      const pair = decodeIdPair(data.slice(2));
      if (pair === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      const service = uuidV7Schema.safeParse(pair.first);
      const addon = uuidV7Schema.safeParse(pair.second);
      if (!service.success || !addon.success) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return {
        intent: buying,
        targetId: service.data,
        secondaryId: addon.data,
        callbackQueryId: id,
      };
    }
    if (data.startsWith(USERNAME_CUSTOM_CALLBACK_PREFIX)) {
      return callbackCommand(
        'USERNAME_CUSTOM',
        data.slice(USERNAME_CUSTOM_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(USERNAME_AUTOMATIC_CALLBACK_PREFIX)) {
      return callbackCommand(
        'USERNAME_AUTOMATIC',
        data.slice(USERNAME_AUTOMATIC_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICE_ACTION_CONFIRM_CALLBACK_PREFIX)) {
      return callbackCommand(
        'SERVICE_ACTION_CONFIRM',
        data.slice(SERVICE_ACTION_CONFIRM_CALLBACK_PREFIX.length),
        id,
      );
    }
    if (data.startsWith(SERVICES_PAGE_CALLBACK_PREFIX)) {
      /*
       * The one callback that carries a POSITION rather than an identifier.
       *
       * Decoded here, which is the same place `callbackCommand` validates a uuid and
       * for the same reason: a crafted token must be UNSUPPORTED at the boundary rather
       * than an invalid cast inside a query. Nothing is authorized by it — the list is
       * scoped to the tenant and to the customer resolved from the update — so the
       * decode is about shape, not trust.
       */
      const cursor = decodeKeysetToken(data.slice(SERVICES_PAGE_CALLBACK_PREFIX.length));
      if (cursor === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'SERVICES_PAGE', targetId: null, cursor, callbackQueryId: id };
    }
    if (data.startsWith(SERVICE_CALLBACK_PREFIX)) {
      return callbackCommand('SERVICE', data.slice(SERVICE_CALLBACK_PREFIX.length), id);
    }
    /*
     * The panel's three screens carry no target, so they match the WHOLE string — the
     * same rule the top-up menu states. The three that act carry one uuid and go
     * through `callbackCommand`, which validates it: a crafted id is UNSUPPORTED here
     * rather than a 500 at a cast, and an id belonging to another tenant finds nothing
     * because every repository read is tenant-scoped.
     */
    if (data === ADMIN_PANEL_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_PANEL', targetId: null, callbackQueryId: id };
    }
    if (data === ADMIN_SERVICES_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_SERVICES', targetId: null, callbackQueryId: id };
    }
    if (data === ADMIN_PANELS_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_PANELS', targetId: null, callbackQueryId: id };
    }
    if (data === ADMIN_REMINDERS_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_REMINDERS', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(ADMIN_REMINDER_EDIT_CALLBACK_PREFIX)) {
      /*
       * The setting code, validated HERE against the closed map.
       *
       * `callback_data` is client-supplied text, so an unknown code must be UNSUPPORTED
       * at the boundary rather than a settings key assembled from it downstream. The
       * same rule the UUID paths above follow, for the same reason.
       */
      const code = data.slice(ADMIN_REMINDER_EDIT_CALLBACK_PREFIX.length);
      if (!isReminderSettingCode(code)) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return { intent: 'ADMIN_REMINDER_EDIT', targetId: code, callbackQueryId: id };
    }
    if (data.startsWith(ADMIN_REMINDER_SET_CALLBACK_PREFIX)) {
      const [code, raw] = data.slice(ADMIN_REMINDER_SET_CALLBACK_PREFIX.length).split(':');
      /*
       * BOTH halves validated, and the value against the widest bound any of the five
       * keys declares rather than against the option list.
       *
       * The list is what a tap can produce; the bound is what the contract permits. A
       * value outside the bound is a crafted callback and is refused here; one inside
       * it but not on the list is still checked by the key's own schema and by the
       * combination guard, so nothing downstream trusts this number — it is only
       * stopped from being a string, a float or a megabyte of digits.
       */
      const value = raw === undefined ? Number.NaN : Number(raw);
      if (
        code === undefined ||
        !isReminderSettingCode(code) ||
        !Number.isInteger(value) ||
        value < USAGE_REMINDER_PERCENT_MIN ||
        value > USAGE_REMINDER_PERCENT_MAX
      ) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      return {
        intent: 'ADMIN_REMINDER_SET',
        targetId: code,
        args: [String(value)],
        callbackQueryId: id,
      };
    }
    if (data.startsWith(ADMIN_PANELS_PAGE_CALLBACK_PREFIX)) {
      /*
       * The panels section's own page button, decoded HERE for the reason
       * `SERVICES_PAGE_CALLBACK_PREFIX` states: a crafted token must be UNSUPPORTED at
       * the boundary rather than an invalid cast inside a query. Nothing is authorized
       * by it — the list is tenant-scoped and `panels.view` is charged in the handler
       * — so the decode is about shape, not trust.
       */
      const cursor = decodeKeysetToken(data.slice(ADMIN_PANELS_PAGE_CALLBACK_PREFIX.length));
      if (cursor === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'ADMIN_PANELS_PAGE', targetId: null, cursor, callbackQueryId: id };
    }
    if (data.startsWith(ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX)) {
      /*
       * `<field>:<value>:<panelId>`, all three validated HERE.
       *
       * `callback_data` is client-supplied text. An unknown field, a value that is
       * not one of the two, or a panel id that is not a uuid must be UNSUPPORTED at
       * the boundary rather than something assembled downstream — the same rule the
       * reminder codes above follow. The panel id itself is checked by
       * `callbackCommand`, which is why it is passed through it.
       */
      const [field, value, panelId] = data
        .slice(ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX.length)
        .split(':');
      if (
        field === undefined ||
        !isUsernameToggleField(field) ||
        (value !== '0' && value !== '1') ||
        panelId === undefined
      ) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      const command = callbackCommand('ADMIN_USERNAME_TOGGLE', panelId, id);
      return command.targetId === null ? command : { ...command, args: [field, value] };
    }
    if (data.startsWith(ADMIN_USERNAME_STRATEGY_CALLBACK_PREFIX)) {
      const [code, panelId] = data.slice(ADMIN_USERNAME_STRATEGY_CALLBACK_PREFIX.length).split(':');
      if (code === undefined || !isUsernameStrategyCode(code) || panelId === undefined) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      const command = callbackCommand('ADMIN_USERNAME_STRATEGY', panelId, id);
      return command.targetId === null ? command : { ...command, args: [code] };
    }
    for (const [prefix, intent] of ADMIN_PANEL_CALLBACKS) {
      if (data.startsWith(prefix)) return callbackCommand(intent, data.slice(prefix.length), id);
    }
    /*
     * The services section's id-carrying callbacks, all through `callbackCommand`.
     *
     * A table rather than nine `if`s, because nine near-identical branches is nine
     * chances to point a prefix at the wrong intent — and the one that matters is the
     * last row, where a mis-wiring would make the ASKING callback the destructive one.
     */
    for (const [prefix, intent] of ADMIN_SERVICE_CALLBACKS) {
      if (data.startsWith(prefix)) return callbackCommand(intent, data.slice(prefix.length), id);
    }
    if (data === ADMIN_RECEIPTS_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_RECEIPTS', targetId: null, callbackQueryId: id };
    }
    if (data === ADMIN_SECTION_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_SECTION', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(ADMIN_RECEIPT_CALLBACK_PREFIX)) {
      return callbackCommand('ADMIN_RECEIPT', data.slice(ADMIN_RECEIPT_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(ADMIN_APPROVE_CALLBACK_PREFIX)) {
      return callbackCommand('ADMIN_APPROVE', data.slice(ADMIN_APPROVE_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(ADMIN_REJECT_CALLBACK_PREFIX)) {
      return callbackCommand('ADMIN_REJECT', data.slice(ADMIN_REJECT_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(ADMIN_REVOKE_CALLBACK_PREFIX)) {
      return callbackCommand('ADMIN_REVOKE', data.slice(ADMIN_REVOKE_CALLBACK_PREFIX.length), id);
    }
    if (data.startsWith(ADMIN_ADMIN_CALLBACK_PREFIX)) {
      return callbackCommand('ADMIN_ADMIN', data.slice(ADMIN_ADMIN_CALLBACK_PREFIX.length), id);
    }
    if (data === ADMIN_CUSTOMERS_CALLBACK_PREFIX) {
      return { intent: 'ADMIN_CUSTOMERS', targetId: null, callbackQueryId: id };
    }
    if (data.startsWith(ADMIN_CUSTOMERS_CALLBACK_PREFIX)) {
      /*
       * The same prefix carrying a POSITION, decoded HERE for the reason
       * `ADMIN_PANELS_PAGE_CALLBACK_PREFIX` states: a crafted token must be UNSUPPORTED
       * at the boundary rather than an invalid cast inside a query. The bare-prefix
       * branch above runs FIRST, so `8:` alone is never offered to the decoder.
       */
      const cursor = decodeKeysetToken(data.slice(ADMIN_CUSTOMERS_CALLBACK_PREFIX.length));
      if (cursor === null) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      return { intent: 'ADMIN_CUSTOMERS_PAGE', targetId: null, cursor, callbackQueryId: id };
    }
    if (data.startsWith(ADMIN_CUSTOMER_CALLBACK_PREFIX)) {
      const [code, customerId] = data.slice(ADMIN_CUSTOMER_CALLBACK_PREFIX.length).split(':');
      if (code === undefined || !isAdminCustomerCode(code) || customerId === undefined) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      /*
       * The TABLE picks the intent. A chain of comparisons here would be the place a
       * read and a block could be transposed, and the uuid still goes through
       * `callbackCommand` so a malformed one is refused before either is chosen.
       */
      return callbackCommand(ADMIN_CUSTOMER_CODES[code], customerId, id);
    }
    if (data.startsWith(ADMIN_ADMIN_STATUS_CALLBACK_PREFIX)) {
      const [code, adminId] = data.slice(ADMIN_ADMIN_STATUS_CALLBACK_PREFIX.length).split(':');
      /*
       * The code is validated HERE, at the boundary, exactly as the username toggles
       * are: an unreadable callback is UNSUPPORTED and never becomes an intent, so the
       * handler receives one of the two statuses or is not reached. A cast downstream
       * would be a third place the vocabulary is spelled out.
       */
      if (code === undefined || !isAdminStatusCode(code) || adminId === undefined) {
        return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
      }
      const command = callbackCommand('ADMIN_ADMIN_STATUS', adminId, id);
      return command.targetId === null ? command : { ...command, args: [code] };
    }
    return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: id };
  }

  /*
   * A FILE before the text, because a photo message has no `text` at all — Telegram
   * puts any accompanying words in `caption`, which this deliberately ignores.
   *
   * Reading through passthrough fields, as the rest of this function does: nothing about
   * the file is trusted as a fact about money, and an update whose file shape is not one
   * of the two this installation accepts falls through to the text path and then to
   * `UNSUPPORTED`, exactly as it did before this existed.
   */
  const file = receiptFileOf((update as { message?: unknown } | null)?.message);
  if (file !== null) {
    return { intent: 'RECEIPT_UPLOAD', targetId: null, callbackQueryId: null, file };
  }

  const text = (update as { message?: { text?: unknown } } | null)?.message?.text;
  if (typeof text !== 'string') return UNSUPPORTED;
  /*
   * A menu tap first, and it is matched on the WHOLE message rather than its first
   * word: the labels contain spaces, and `خرید اشتراک` split on whitespace is not a
   * command. Resolving to the slash command it stands for is what makes the button and
   * the command literally the same path rather than two that agree today.
   */
  const trimmed = text.trim();
  const asCommand = menu.get(trimmed) ?? trimmed;
  const first = asCommand.split(/\s+/)[0]?.toLowerCase();
  // `/start@somebot` is what Telegram sends in a group. Stripped, because the bot it
  // names is the bot that received it.
  const command = first?.split('@')[0];
  if (command === '/start') return { intent: 'START', targetId: null, callbackQueryId: null };
  if (command === '/catalog') return { intent: 'CATALOG', targetId: null, callbackQueryId: null };
  if (command === '/wallet') return { intent: 'WALLET', targetId: null, callbackQueryId: null };
  if (command === '/services') {
    return { intent: 'SERVICES', targetId: null, callbackQueryId: null };
  }
  /*
   * The command that makes the other four findable.
   *
   * `docs/phase4h-audit.md` §9: the bot answered four commands, registered none with
   * Telegram, and `bot.start.welcome` named only `/catalog` — so `/wallet` and
   * `/services` were reachable only by guessing. `BOT_COMMANDS` is what both this and
   * `setMyCommands` render, so the menu and the help cannot disagree.
   */
  if (command === '/help') return { intent: 'HELP', targetId: null, callbackQueryId: null };
  /*
   * The management panel's three text entries (Phase 5T).
   *
   * `/admin` is deliberately NOT registered with `setMyCommands` — Telegram's command
   * list is per bot, not per user, so registering it would advertise the panel to every
   * customer. It is reachable by the keyboard button an administrator gets and by
   * typing it; both answer the same way, and a customer who types it resolves to no
   * administrator and gets this function's fallback.
   *
   * The two that carry arguments split on whitespace and validate nothing here: what
   * makes `123456789` a Telegram account and `owner` an administrator is a question for
   * the services that look them up.
   */
  if (command === `/${ADMIN_MENU_COMMAND}`) {
    return { intent: 'ADMIN_PANEL', targetId: null, callbackQueryId: null };
  }
  /*
   * Exact lookup, Phase 6A: `/service <id>`.
   *
   * A command carrying its argument rather than a prompt that captures the next
   * message, for the reason `/link` and `/role` state — INCIDENT-FIN-001 is what a
   * stateful prompt does when it outlives the question it was asked for. Not registered
   * with `setMyCommands` for the same reason `/admin` is not: the command list is per
   * bot rather than per user, so registering it would advertise the panel to every
   * customer.
   */
  if (command === '/service') {
    return {
      intent: 'ADMIN_SERVICE',
      targetId: null,
      args: asCommand.trim().split(/\s+/).slice(1),
      callbackQueryId: null,
    };
  }
  /*
   * `/panel_prefix <panel id> <prefix>` and `/panel_template <panel id> <template>`.
   *
   * Commands rather than a prompt, for the reason `/link` and `/role` state. The
   * template argument is joined back with single spaces AFTER the split, so a
   * template is one token in practice — and a template containing a space is refused
   * by the grammar anyway, since a space is not in the permitted character class.
   * Nothing is validated here: what makes a string a legal prefix or template is the
   * shared evaluator's question, and answering it twice is how two answers diverge.
   */
  if (command === '/panel_prefix' || command === '/panel_template') {
    const args = asCommand.trim().split(/\s+/).slice(1);
    return {
      intent: command === '/panel_prefix' ? 'ADMIN_USERNAME_PREFIX' : 'ADMIN_USERNAME_TEMPLATE',
      targetId: null,
      args,
      callbackQueryId: null,
    };
  }
  /*
   * Exact lookup, WP2: `/customer <telegram id>`.
   *
   * The numeric Telegram id, because that is what a support conversation quotes — not
   * the internal uuid, which nobody outside the Web Admin has ever seen. Nothing is
   * validated here: what makes a string a Telegram account is a question for the service
   * that looks it up, and the boundary splitting a command's words cannot know which of
   * them was meant to be an id.
   *
   * Not registered with `setMyCommands`, for the reason `/admin` and `/service` are not:
   * Telegram's command list is per bot rather than per user, so registering it would
   * advertise the management panel to every customer.
   */
  if (command === '/customer') {
    return {
      intent: 'ADMIN_CUSTOMER_FIND',
      targetId: null,
      args: asCommand.trim().split(/\s+/).slice(1),
      callbackQueryId: null,
    };
  }
  if (command === '/link' || command === '/role') {
    const args = asCommand.trim().split(/\s+/).slice(1);
    return {
      intent: command === '/link' ? 'ADMIN_LINK' : 'ADMIN_ROLE',
      targetId: null,
      args,
      callbackQueryId: null,
    };
  }
  /*
   * Anything else MIGHT be a username, and only the database knows.
   *
   * This is the last branch on purpose: every command above is matched first, so a
   * `/start` typed while a window is open is still `/start`. The text is carried
   * UNTOUCHED — not trimmed, not lowercased — because `isValidCustomUsername` is asked
   * of the raw input and a surface that tidied it first would be deciding what the
   * customer typed.
   *
   * It is `USERNAME_TEXT` rather than `UNSUPPORTED` only as a routing label. The
   * handler asks whether a window is open and, for almost every message, is told no
   * and answers exactly as `UNSUPPORTED` always did.
   */
  return { intent: 'USERNAME_TEXT', targetId: null, args: [text], callbackQueryId: null };
}

const UNSUPPORTED: BotCommand = { intent: 'UNSUPPORTED', targetId: null, callbackQueryId: null };

/**
 * The receipt inside a message, or null when there is not one.
 *
 * Two shapes and the list is closed, because `PAYMENT_RECEIPT_KINDS` is: a photo is
 * what most customers send and a document is what a banking app's PDF export produces.
 * Everything else a message can carry — a voice note, a location, a contact, a sticker,
 * a video — is NOT a receipt and is answered exactly as any other message this bot does
 * not understand.
 *
 * The photo arrives as an array of sizes. The LARGEST is chosen by `file_size`, and by
 * width where a size reports none: Telegram documents the array as ascending and
 * trusting that means trusting a client to order its own upload, which is the class of
 * assumption this file exists to avoid. A reviewer looking for a transfer reference
 * needs the biggest one there is.
 *
 * `file_size` is read as a NUMBER from the wire and carried as `bigint`, because it
 * reaches a `bigint` column and `payment_receipts_size_check` refuses a non-positive
 * one — so a zero or a negative becomes null here rather than a constraint violation
 * two layers down.
 */
function receiptFileOf(message: unknown): InboundReceiptFile | null {
  if (typeof message !== 'object' || message === null) return null;
  const record = message as Record<string, unknown>;
  const telegramMessageId =
    typeof record['message_id'] === 'number' && Number.isSafeInteger(record['message_id'])
      ? BigInt(record['message_id'])
      : null;

  const photo = record['photo'];
  if (Array.isArray(photo) && photo.length > 0) {
    const largest = largestPhoto(photo);
    if (largest !== null) {
      return {
        kind: 'PHOTO',
        fileId: largest.fileId,
        fileUniqueId: largest.fileUniqueId,
        // A photo size carries neither, and Telegram re-encodes it: claiming a type
        // this installation did not observe would be a fabricated fact about a file.
        mimeType: null,
        fileName: null,
        fileSize: largest.fileSize,
        telegramMessageId,
      };
    }
  }

  const document = record['document'];
  if (typeof document === 'object' && document !== null) {
    const fields = document as Record<string, unknown>;
    const fileId = fields['file_id'];
    const fileUniqueId = fields['file_unique_id'];
    if (typeof fileId === 'string' && typeof fileUniqueId === 'string') {
      return {
        kind: 'DOCUMENT',
        fileId,
        fileUniqueId,
        mimeType: typeof fields['mime_type'] === 'string' ? fields['mime_type'] : null,
        fileName: typeof fields['file_name'] === 'string' ? fields['file_name'] : null,
        fileSize: positiveSize(fields['file_size']),
        telegramMessageId,
      };
    }
  }
  return null;
}

/**
 * The biggest usable size in a `photo` array, ranked by PIXELS with bytes as the
 * tie-breaker.
 *
 * Two comparable numbers, never one of each. Ranking by `file_size` where it exists and
 * by width where it does not compares byte counts against pixel counts: a 5 KB thumbnail
 * ranks 5000 and a 1920-pixel original with no declared size ranks 1920, so the
 * thumbnail wins and the receipt an operator opens is unreadable. Telegram documents
 * `file_size` as optional on a `PhotoSize`, so that is not a hypothetical shape.
 *
 * Pixels first because they are what makes a receipt legible, and `width * height`
 * rather than width alone because a wide, short crop is not a bigger image. Bytes break
 * a tie only among equal dimensions, which is where they mean compression rather than
 * size.
 */
function largestPhoto(sizes: readonly unknown[]): {
  readonly fileId: string;
  readonly fileUniqueId: string;
  readonly fileSize: bigint | null;
} | null {
  let best: {
    fileId: string;
    fileUniqueId: string;
    fileSize: bigint | null;
    pixels: number;
    bytes: number;
  } | null = null;
  for (const candidate of sizes) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const fields = candidate as Record<string, unknown>;
    const fileId = fields['file_id'];
    const fileUniqueId = fields['file_unique_id'];
    if (typeof fileId !== 'string' || typeof fileUniqueId !== 'string') continue;
    const size = positiveSize(fields['file_size']);
    const width = dimension(fields['width']);
    const height = dimension(fields['height']);
    // A missing dimension is 1 rather than 0, so a size with no dimensions at all is
    // still comparable — ranked last among anything that declared them, not discarded.
    const pixels = Math.max(1, width) * Math.max(1, height);
    const bytes = size === null ? 0 : Number(size);
    if (best === null || pixels > best.pixels || (pixels === best.pixels && bytes > best.bytes)) {
      best = { fileId, fileUniqueId, fileSize: size, pixels, bytes };
    }
  }
  return best === null
    ? null
    : { fileId: best.fileId, fileUniqueId: best.fileUniqueId, fileSize: best.fileSize };
}

/** A declared pixel count, or 0. Non-integers and negatives are not dimensions. */
function dimension(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** A declared byte count, or null. Zero and negatives are null: the CHECK refuses them. */
function positiveSize(value: unknown): bigint | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? BigInt(value)
    : null;
}

/** A tap on a button, with its id checked before anything is asked to look it up. */
function callbackCommand(
  intent: BotIntent,
  rawId: string,
  callbackQueryId: string | null,
): BotCommand {
  const parsed = uuidV7Schema.safeParse(rawId);
  if (!parsed.success) return { intent: 'UNSUPPORTED', targetId: null, callbackQueryId };
  return { intent, targetId: parsed.data, callbackQueryId };
}

/**
 * The customer's chat id for a private conversation.
 *
 * Telegram's private chat id IS the user id, but the update carries both and they can
 * differ — in a group, `chat.id` is the group. A reply to a group chat would publish a
 * customer's balance to everyone in it, so this prefers the chat id only when the chat
 * is private and otherwise has no answer.
 */
export function privateChatIdOf(update: unknown): string | null {
  const shaped = update as {
    message?: { chat?: { id?: unknown; type?: unknown } };
    // A tapped button carries the message it was attached to, and that message carries
    // the chat. Read second, so a real `message` still wins for an ordinary command.
    callback_query?: { message?: { chat?: { id?: unknown; type?: unknown } } };
  } | null;
  const chat = shaped?.message?.chat ?? shaped?.callback_query?.message?.chat;
  if (chat === undefined || chat === null) return null;
  if (chat.type !== 'private') return null;
  return typeof chat.id === 'number' || typeof chat.id === 'string' ? String(chat.id) : null;
}

export interface BotRuntimeDeps {
  readonly customers: CustomerService;
  readonly messenger: CustomerMessenger;
  readonly products: ProductService;
  readonly commercial: CommercialActionService;
  readonly orders: OrderService;
  readonly payments: PaymentService;
  /**
   * Composes the destination block for a manual-transfer instruction.
   *
   * Injected rather than imported, for the reason `MainMenuRoutes` is: the four line
   * templates are catalogue text, `check-boundaries.sh` refuses an `@nexa/i18n` import
   * in a surface, and resolving a tenant override is the application layer's job. What
   * this surface holds is a function from a frozen snapshot to a string.
   */
  readonly destinations: PaymentDestinationRenderer;
  /**
   * Files the receipt a customer sends, and refuses the file nobody asked for.
   *
   * A separate service from `payments` on purpose: it holds the payment READ alone, so
   * the path a customer's photo travels cannot confirm, reject or settle anything. The
   * addendum's own words — *"settlement still requires the existing authorized operator
   * confirmation"* — are a dependency here rather than only a permission.
   */
  readonly receipts: Pick<ReceiptService, 'submit' | 'reviewQueue' | 'reviewItem'>;
  readonly wallet: WalletService;
  readonly services: ProvisioningService;
  /**
   * The operator's READ of a service, for the admin panel's section.
   *
   * A `Pick` rather than the class, so this surface can list, read one with its action
   * verdicts, and read its history — and cannot reach anything that acts. What acts is
   * `services` and `delivery`, and both charge their own permissions.
   */
  readonly serviceAdmin: Pick<ServiceAdminService, 'list' | 'detail' | 'operations'>;
  /**
   * The operator's panel operations, for the panels section.
   *
   * A `Pick` of FOUR, and what is absent is the point: `setCredentials` is not here, so
   * no code path in this surface can write a credential even by mistake. Credential
   * creation and rotation are the Web Admin's, behind `panels.credentials.rotate`, and
   * the owner's instruction for this phase says so in as many words.
   *
   * `create` is absent for the same reason — a panel needs credentials, so creating one
   * here would either be a panel that cannot be operated or a credential typed into a
   * chat.
   */
  readonly panelAdmin: Pick<
    PanelService,
    'list' | 'get' | 'testConnection' | 'setStatus' | 'update'
  >;
  /**
   * The clock, for the ONE thing this surface decides about time.
   *
   * `readHealth` needs "now" to say whether a probe is stale, and `CLAUDE.md` is
   * explicit that every timestamp comes from the `Clock` port — a `new Date()` here
   * would be the one unfakeable value in a runtime whose whole test suite depends on
   * being able to fix the clock. Nothing else on this surface reads it: every other
   * timestamp in a reply is a stored value rendered by the template layer.
   */
  readonly clock: Clock;
  readonly delivery: DeliveryService;
  /**
   * Puts a rate-limited FACT on the customer notification lane.
   *
   * A narrow function and not the notifier itself, because `CustomerNotifier.notify`
   * takes a transaction and a SURFACE must not open one — `CLAUDE.md`: "Surfaces
   * call application services and never touch the database." The container owns
   * the unit of work and the clock; this hands over the two values only the turn
   * knows.
   *
   * Returns nothing. The turn's own outcome is already `RATE_LIMITED` and stays
   * that way: the operational log records what happened to the REPLY, and
   * reporting a successful enqueue as a successful send is the kind of
   * cheerfulness this codebase removes.
   */
  /**
   * The persistent main menu's label-to-command map.
   *
   * Supplied by the composition root, which is the only place allowed to read the
   * catalogue on this path — see `MainMenuRoutes`. An empty map is a bot with no
   * keyboard and unchanged slash commands, which is what every test that does not care
   * about the menu gets.
   */
  /**
   * The reminder configuration, read and written through the ONE application path.
   *
   * A narrow port rather than `SettingsService` and `FeatureFlagsService`, for the
   * reason every other port on this interface gives: handing a Telegram surface the
   * settings service would hand it every key in the registry, including the operations
   * chat id and the sales currency. This one can read the eight reminder values and
   * write the five numbers, and nothing else.
   *
   * Neither method is authorized by HAVING the port. `read` charges `settings.view` and
   * `settings.view`, `write` charges `settings.edit`, and both go through the same
   * guard, the same audit row and the same combination validation the Web Admin does —
   * which is the "one application service and one authorization/audit path" the surface
   * is required to share with it.
   */
  readonly reminderConfig: {
    read: (scope: TenantContext, actor: ActorContext) => Promise<ServiceReminderThresholds>;
    /**
     * Writes one threshold, or reports why the combination was refused.
     *
     * A refusal is a VALUE and not an exception, because it is an ordinary answer an
     * operator caused and must read: `ReminderThresholdsGuard` returns Persian prose
     * naming which of the five is wrong. An exception here would be caught by the
     * generic handler and rendered as "something went wrong", which is Mirza's
     * `⭕️ ورودی نا معتبر` with extra steps.
     */
    write: (
      scope: TenantContext,
      actor: ActorContext,
      key: SettingKey,
      value: number,
      idempotencyKey: string,
    ) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  };
  readonly mainMenu: MainMenuRoutes;
  readonly queueRateLimitedFact: (
    scope: TenantContext,
    customerId: UserId,
    kind: CustomerNotificationKind,
    subjectId: string,
    /**
     * Telegram's own `retry_after`, when it supplied one.
     *
     * Passed through rather than dropped, because it is the one thing this path
     * knows and the lane does not. Without it the row is due immediately and the
     * next sweep walks into the same refusal — a request Telegram already
     * declined, and a longer throttle for every other message to that chat.
     */
    retryAfterMs: number | undefined,
  ) => Promise<void>;
  /**
   * The plan a service was SOLD as, from the order's frozen snapshot.
   *
   * A narrow port rather than `OrderService`, for the reason the provisioner's
   * `PurchaseSnapshotReader` gives one: handing this surface the order service would
   * also hand a customer-facing runtime the ability to confirm and cancel orders.
   *
   * From the ORDER and never from the product. `nexa_orders_snapshot_guard` froze the
   * title at confirmation, so it is the only copy that still says what the customer
   * agreed to — a product renamed since would otherwise rewrite what somebody was
   * told they bought, which is the legacy defect where renaming a product rewrote
   * past reports, applied to something the customer can read back.
   */
  readonly purchaseTitle: (scope: TenantContext, orderId: OrderId) => Promise<string | null>;
  /**
   * The management panel's seam (Phase 5T).
   *
   * A narrow port rather than the service, so this surface can resolve a binding, read
   * who holds one, and ask for a binding or a role change — and cannot reach anything
   * else about identity. Every method behind it charges its own permission through the
   * same guard the Web Admin uses; nothing here is authorized by having the port.
   */
  readonly telegramAdmins?: TelegramAdminPort;
  /**
   * Tells the administrators who may decide a receipt that one is waiting.
   *
   * A narrow function for `queueRateLimitedFact`'s reason: the notification lane takes
   * a transaction and a surface must not open one, so the composition root owns the
   * unit of work and this hands over the two values only the turn knows.
   *
   * Returns nothing and must not throw. The receipt is already filed and the customer
   * has already been answered; a failure to poke a reviewer changes neither, and the
   * queue in the panel is the durable record either way.
   */
  readonly notifyReviewers?: (scope: TenantContext, paymentId: PaymentId) => Promise<void>;
}

/**
 * What the surface may ask about Telegram administrators.
 *
 * Structural rather than the class, which is what keeps `bot-runtime.test.ts` able to
 * stand one up without an identity module — and what stops this file from acquiring the
 * ability to create an administrator, change a password or read a hash.
 */
export interface TelegramAdminPort {
  resolve(
    scope: TenantContext,
    telegramUserId: string,
    correlationId: CorrelationId,
  ): Promise<{
    readonly admin: {
      readonly id: string;
      readonly username: string;
      readonly telegramUserId: string | null;
    };
    readonly actor: ActorContext;
    readonly permissions: ReadonlySet<PermissionKey>;
  } | null>;
  listBound(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<
    readonly {
      readonly id: string;
      readonly username: string;
      readonly telegramUserId: string | null;
    }[]
  >;
  link(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly username: string; readonly telegramUserId: string; readonly reason: string },
  ): Promise<{ readonly username: string }>;
  revoke(
    scope: TenantContext,
    actor: ActorContext,
    targetId: string,
    reason: string,
  ): Promise<{ readonly username: string }>;
  setRoles(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly username: string;
      readonly roleKeys: readonly string[];
      readonly reason: string;
      /** The update's key, so a redelivered command is replayed rather than run twice. */
      readonly idempotencyKey: string;
    },
  ): Promise<{ readonly admin: { readonly username: string }; readonly roleKeys: string[] }>;
  /**
   * The roster: every administrator on this tenant, with their role keys.
   *
   * `listBound` is NOT this and is not being replaced — it answers "who can be reached
   * in Telegram", which is what the receipt lane needs. This answers "who exists",
   * which is what a section that can disable somebody needs.
   */
  listAll(scope: TenantContext, actor: ActorContext): Promise<readonly AdminRosterEntry[]>;
  /** ACTIVE or DISABLED, through the same service and the same guard the Web Admin uses. */
  setStatus(
    scope: TenantContext,
    actor: ActorContext,
    targetId: string,
    status: 'ACTIVE' | 'DISABLED',
    reason: string,
    /** The update's key. A Telegram callback is redelivered, so it is replayed, not re-run. */
    idempotencyKey: string,
  ): Promise<AdminRosterEntry>;
}

/**
 * One administrator, as the roster and the detail screen need them.
 *
 * Structural, like every other shape on this port: the surface declares what it reads
 * and the identity module's projection satisfies it. What is NOT here is the point —
 * no password hash, no session, no `lastLoginAt`, no IP. A detail message is
 * forwardable for ever and a credential must never cross this surface at all.
 */
export interface AdminRosterEntry {
  readonly admin: {
    readonly id: string;
    readonly username: string;
    readonly displayName: string;
    readonly status: string;
    readonly telegramUserId: string | null;
  };
  readonly roleKeys: readonly string[];
}

/**
 * What a handled update produced.
 *
 * Returned rather than logged, so the webhook controller decides what to do with it and
 * the tests can assert it. `sent` is deliberately not a boolean: a reply that may or may
 * not have arrived is a third thing, and the messenger already distinguishes it.
 */
export interface BotTurnResult {
  readonly intent: BotIntent;
  readonly arrival: CustomerArrival | null;
  readonly customerId: string | null;
  readonly replyKey: TemplateKey | null;
  /** The order this turn created or confirmed, when it was one of those. */
  readonly orderId: string | null;
  readonly sent: CustomerSendOutcome | 'NOT_ATTEMPTED';
}

/**
 * A reply that has been decided and not yet sent.
 *
 * Assembled BEFORE any network call, so the whole turn is: commit, decide, send. A
 * branch that sent from inside its own decision would be a second send path, and the
 * `resolve -> commit -> reply` order is the one rule this surface exists to keep.
 */
interface PendingReply {
  readonly key: TemplateKey | null;
  readonly values: TemplateValues;
  readonly buttons: readonly CustomerButton[];
  readonly orderId: string | null;
  /**
   * A SECOND message, sent after the first, about a different fact.
   *
   * One handler, two sentences, because they are two facts and merging them would make
   * one of them false. Settlement is the case it exists for: `bot.order.settled` says
   * the money arrived and is complete on its own, and `bot.service.provisioning` says
   * something is now being made — which is not true of a renewal, so it cannot simply
   * be appended to the settled copy.
   *
   * Sent only if the FIRST one was, and its outcome is not the turn's. A follow-up that
   * failed leaves the customer with the message that mattered; a follow-up that arrived
   * without its subject would be a sentence about nothing.
   *
   * It carries no values and no buttons on purpose. A second message that needed either
   * would be a second reply, and this is deliberately not a general mechanism — the
   * turn still has ONE answer, with a note after it.
   */
  readonly followUpKey?: TemplateKey;
  /**
   * The lane kind this reply falls back to when Telegram rate-limits it.
   *
   * `OQ-4H-01`: the durable write commits, the synchronous reply gets a 429, and
   * the customer sees nothing — so they send the transfer twice, or conclude the
   * cancellation did not happen. The background lanes already handle a 429 by
   * requeueing at Telegram's own `retryAfterMs` with no attempt spent; the
   * interactive path had nowhere to put it.
   *
   * Set on exactly the replies that are a FACT about an entity the customer just
   * changed — a recorded transfer, a cancelled order. Those carry `values: {}`
   * and `buttons: []`, which is what makes them expressible as a lane kind at
   * all.
   *
   * DELIBERATELY absent on every reply that RENDERS state. A menu, a catalogue
   * and a service list have no subject and no fact; queueing one would deliver a
   * stale screen minutes later against state that has moved, and would need the
   * parameterised payload `ADR 0030` §1 refuses. The customer's next tap
   * reproduces those, which is why they need no fallback.
   */
  readonly fallback?: {
    readonly kind: CustomerNotificationKind;
    readonly subjectId: string;
  };
  /**
   * Attach the persistent main-menu keyboard to this reply.
   *
   * ONE reply sets it — the answer to `/start` — because Telegram keeps a
   * `ReplyKeyboardMarkup` shown until something replaces or removes it, and nothing in
   * this product removes it. Re-sending it on every reply would be a second copy of a
   * keyboard the customer already has, and would fight with the inline keyboards the
   * contextual flows attach.
   */
  readonly keyboard?: MainMenuVariant;
}

/**
 * A refusal the customer can be told about.
 *
 * The three product codes collapse to ONE message, deliberately: the operational log and
 * the Web Admin name which of withdrawn, unpriced and unbound it was, and the customer
 * can act on none of them. "This plan has no panel" tells them about our configuration.
 *
 * Anything NOT in this map is re-thrown. That is the important half — a bug in the order
 * path must not be reported to a customer as "this is unavailable", which would make
 * every failure look like an ordinary product state and leave nothing in the operational
 * log. The webhook's catch records it and still answers 200.
 */
export const REFUSAL_REPLIES: Readonly<Record<string, TemplateKey>> = {
  /*
   * The five username refusals, and they are five sentences rather than one.
   *
   * `INVALID` and `TAKEN` answer a name the customer TYPED, so both end with "send
   * another one" and only those two do. `EXHAUSTED` and `UNGENERATABLE` answer a name
   * they never saw — there is nothing for them to choose differently, and telling them
   * to try a different name would be advice they cannot follow. `STALE` is the one
   * that asks them to choose again for a reason that is nobody's fault. All five are
   * raised before any debit and every body says so.
   */
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_INVALID]: 'bot.username.invalid',
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_TAKEN]: 'bot.username.taken',
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_EXHAUSTED]: 'bot.username.exhausted',
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_UNGENERATABLE]: 'bot.username.unavailable',
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_MODE_UNAVAILABLE]: 'bot.username.mode_unavailable',
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_STALE]: 'bot.username.stale',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_PURCHASABLE]: 'bot.order.unavailable',
  // The SAME sentence as the others, deliberately. A customer told "this is for
  // resellers" learns a tenant's pricing structure from a refusal.
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_FOR_AUDIENCE]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_PRICED]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_FULFILLABLE]: 'bot.order.unavailable',
  /*
   * The panel is archived, disabled, confirmed down, or full — and the customer is
   * told none of that.
   *
   * The same sentence as the four above, for the reason `PRODUCT_NOT_FOR_AUDIENCE`
   * gets it: which of somebody's machines is full, or unreachable, is an operational
   * fact about the seller's infrastructure. What the buyer needs is that this plan
   * cannot be bought right now, which is what the template says. The REASON is in the
   * refusal's detail, the audit row and the operations log, where an operator looks.
   */
  [COMMERCE_ERROR_CODES.PANEL_NOT_ELIGIBLE]: 'bot.order.unavailable',
  // An order that is gone, or that belongs to somebody else — the service answers both
  // the same way on purpose, so this does too.
  [COMMERCE_ERROR_CODES.ORDER_NOT_FOUND]: 'bot.order.unavailable',
  /*
   * The ORDER, not the product. `bot.order.unavailable` says a PLAN cannot be bought,
   * and the ordinary way to reach this code is a customer tapping the pay button a
   * second time on the message they just paid from — the buttons stay in the chat
   * after settlement. Telling somebody who has just been debited that their service is
   * unavailable is the class of untruth 4C rewrote `bot.order.settled` to remove.
   */
  [COMMERCE_ERROR_CODES.ORDER_STATE_INVALID]: 'bot.order.not_awaiting_payment',
  [COMMERCE_ERROR_CODES.ORDER_EXPIRED]: 'bot.order.expired',
  // Reachable despite the surface's own check: an operator can block a customer between
  // the resolve and the order write, and the service refuses it inside the transaction.
  [COMMERCE_ERROR_CODES.CUSTOMER_BLOCKED]: 'bot.blocked',
  /*
   * A rail this installation cannot perform. NAMED rather than hidden — the button is
   * not drawn, and a customer holding an older message still gets a sentence that says
   * what happened instead of "unknown command".
   */
  [COMMERCE_ERROR_CODES.PAYMENT_METHOD_UNAVAILABLE]: 'bot.payment.unconfigured',
  /*
   * The order is still live and this rail cannot be used inside what is left of it.
   *
   * Its own key rather than `bot.order.expired`, because the two say different things
   * to the same customer: that one means the window has closed, this one means it is
   * about to and a transfer started now could not be confirmed afterwards. The remedy
   * is the same — order again — and saying which is which is what stops a customer
   * transferring money against a reference that dies before it arrives.
   */
  [COMMERCE_ERROR_CODES.PAYMENT_WINDOW_TOO_SHORT]: 'bot.payment.window_too_short',
  [COMMERCE_ERROR_CODES.PAYMENT_NOT_FOUND]: 'bot.order.unavailable',
  /*
   * The three top-up refusals. Every code a customer path can throw MUST be here: an
   * unmapped one makes `refusal` rethrow, the webhook swallows it by design, and the
   * customer is answered with silence while a durable write may have committed. That is
   * F5R-12 on this branch and it cost a whole debugging session.
   */
  [COMMERCE_ERROR_CODES.TOPUP_UNAVAILABLE]: 'bot.wallet.topup_unavailable',
  [COMMERCE_ERROR_CODES.TOPUP_NOT_OFFERED]: 'bot.wallet.topup_refused',
  [COMMERCE_ERROR_CODES.TOPUP_BELOW_MINIMUM]: 'bot.wallet.topup_refused',
  /*
   * And the two the payment ROUTE can throw (Phase 5C), mapped to the same two
   * sentences rather than to new ones — because they are the same two facts.
   *
   * `PAYMENT_GATEWAY_UNAVAILABLE` means no route can carry this payment right now, for
   * any of four reasons the customer cannot act on and must not be told apart: three
   * are the operator's thresholds and naming which one refused would tell whoever holds
   * this chat how the installation's payment gating is configured. "This is not
   * available at the moment" is the whole of what the customer can use.
   *
   * `PAYMENT_GATEWAY_AMOUNT_REJECTED` means a preset falls outside what the route
   * accepts, which is a MISCONFIGURATION — the same class as `TOPUP_BELOW_MINIMUM`, and
   * it shares that key's copy for the reason that key exists: telling a customer an
   * amount is "unavailable" while the button sits on their screen sends them looking
   * for it again.
   *
   * Both are here rather than left unmapped, which is not a formality: an unmapped code
   * makes `refusal` RETHROW, the webhook swallows it by design, and the customer is
   * answered with silence. That is F5R-12, and it cost a whole debugging session.
   */
  /*
   * The three the 5F flow pass found reaching a customer with NO entry here, which
   * means `refusal` rethrew, the webhook swallowed it, and the customer was answered
   * with silence. All three are generic on purpose — see `bot.request_unavailable`.
   *
   * `PAYMENT_DESTINATION_UNCONFIGURED` is the one the code already predicted:
   * `requestManualTransfer` says in so many words that the surface draws the transfer
   * button from a read that can be a moment stale, so the last enabled account can be
   * disabled between the button and the tap, "and this is where that lands". It landed
   * nowhere. `bot.payment.unconfigured` is the truthful answer — from the customer's
   * side a method with nowhere to send money is a method that is not available.
   *
   * `COMMERCE_REQUEST_INVALID` is `assertScopeActive`: an installation that has stopped
   * accepting work, refusing a tap that was already on screen.
   *
   * `CUSTOMER_NOT_FOUND` is `settleFromWallet`'s `lockCustomer` — unreachable in
   * practice, because nothing deletes a customer, and mapped anyway: the cost of an
   * entry is one line and the cost of a missing one is a customer who taps pay and is
   * told nothing.
   */
  [COMMERCE_ERROR_CODES.PAYMENT_DESTINATION_UNCONFIGURED]: 'bot.payment.unconfigured',
  [COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID]: 'bot.request_unavailable',
  [COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND]: 'bot.request_unavailable',
  /*
   * The FALL-THROUGH for insufficient funds, not its reply.
   *
   * `walletPurchase` catches this code and answers `bot.wallet.insufficient` with the
   * shortfall, which is the useful reply and stays the one a customer gets. But that
   * catch requires `shortfallOf(details)` to yield a figure, and when it does not it
   * falls through to `refusal` — onto this code, which had no entry. So the one case
   * the fall-through exists for was the one case that said nothing.
   */
  [COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS]: 'bot.request_unavailable',
  [COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_UNAVAILABLE]: 'bot.wallet.topup_unavailable',
  [COMMERCE_ERROR_CODES.PAYMENT_GATEWAY_AMOUNT_REJECTED]: 'bot.wallet.topup_refused',
  /*
   * The four receipt refusals, and they are four SENTENCES because the remedy differs.
   *
   * Collapsing them into one would be the legacy system's "unknown command" for a
   * customer who did exactly what they were asked: nothing was expected, the window
   * closed, the payment is full, and the payment is no longer pending are four different
   * situations and three of them have an action the customer can take.
   */
  [COMMERCE_ERROR_CODES.RECEIPT_NOT_EXPECTED]: 'bot.payment.receipt_not_expected',
  [COMMERCE_ERROR_CODES.RECEIPT_WINDOW_EXPIRED]: 'bot.payment.receipt_expired',
  [COMMERCE_ERROR_CODES.RECEIPT_LIMIT_REACHED]: 'bot.payment.receipt_limit',
  /*
   * The payment, not the order. Its own key since 4G made the state reachable.
   *
   * A customer meets this by scrolling back to a message that was live when it was
   * sent and pressing the button on it — after the sweep expired the payment, after an
   * operator rejected it, or after they withdrew it themselves. Answering "this service
   * is not available" reads as a fault in the product; saying the payment is no longer
   * pending says what happened.
   */
  [COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID]: 'bot.payment.not_pending',
  /*
   * The order is LIVE and the customer's own earlier claim is what stops them.
   *
   * Its own key rather than `bot.order.not_awaiting_payment`, which says the order can
   * no longer be acted on — the opposite of what is true here. A customer told the
   * wrong one of those two taps again, because the sentence they read describes a
   * situation they can see is false.
   */
  [COMMERCE_ERROR_CODES.ORDER_TRANSFER_UNDER_REVIEW]: 'bot.order.transfer_under_review',
  /*
   * The guard refused. ONE sentence for every reason it gives, exactly as the product
   * refusals collapse: the customer can act on none of "the amount does not match", "the
   * currency does not match" and "another customer's payment", and each of them tells
   * them something about our data. The `reason` detail is in the audit row and the
   * operational log, which is where it is useful.
   */
  [COMMERCE_ERROR_CODES.SETTLEMENT_NOT_FUNDED]: 'bot.order.unavailable',
  /*
   * This entry is for `WALLET_CURRENCY_UNSUPPORTED`, and the comment here used to
   * describe a DIFFERENT code — it explained a fallback for
   * `WALLET_INSUFFICIENT_FUNDS`, which is not the key below and is not in this map.
   *
   * What is actually true of each:
   *
   * - `WALLET_INSUFFICIENT_FUNDS` is answered inside `walletPayment`, because
   *   `bot.wallet.insufficient` renders the shortfall and this map carries no values.
   *   It has NO entry here, so if that handler could not read the shortfall the turn
   *   would reach `refusal`'s `throw` and the customer would get no reply. It cannot
   *   today: the service always attaches a positive `shortfallMinor` bounded by
   *   `PAYMENT_AMOUNT_MAX_MINOR` and a valid `currency`, which is exactly what
   *   `shortfallOf` parses. Left as is rather than given a key that would exist for an
   *   unreachable branch — but stated, because the previous comment implied a
   *   protection that is not here.
   * - `WALLET_CURRENCY_UNSUPPORTED` has no Telegram producer at all: only
   *   `WalletService.adjust` raises it and no customer path calls that. It stays
   *   listed because an unlisted code is the failure mode, not a tidy absence.
   */
  [COMMERCE_ERROR_CODES.WALLET_CURRENCY_UNSUPPORTED]: 'bot.order.unavailable',
  /*
   * The commercial refusals, split exactly where the CUSTOMER's next step differs.
   *
   * `SERVICE_ACTION_NOT_ALLOWED` is the service's own state — a terminated service
   * cannot be renewed, a suspended one cannot be topped up — and that is something the
   * customer can act on, so it says so.
   *
   * `SERVICE_ACTION_UNAVAILABLE` and the two add-on refusals are CONFIGURATION: nothing
   * is offered, the plan was withdrawn, the package was deactivated between the list
   * and the tap. One sentence for all three, because the customer's next step is the
   * same and naming which would describe an operator's configuration to them — the same
   * reasoning `PRODUCT_NOT_FOR_AUDIENCE` follows above. The operational log and the
   * audit row carry the distinction an operator needs.
   *
   * `PANEL_NOT_OPERABLE` used to be absent here, with a comment saying it "stays with
   * 4E's `bot.service.capability_unsupported`". That was FALSE, and the falsehood is
   * worth recording because it is the shape this map exists to prevent: 4E answers the
   * code inside `serviceAction`, which the commercial handlers never pass through. They
   * go to `refusal`, an unmapped code reaches its `throw`, and the customer who tapped
   * a renewal button drawn before the operator disabled the panel got no reply at all —
   * the exact "unknown code, no answer" failure the `WALLET_INSUFFICIENT_FUNDS` note
   * above spells out. It is the SAME sentence 4E uses, reached the ordinary way.
   *
   * `SERVICE_ACTION_IN_PROGRESS` is the one TRANSIENT refusal in this group and gets
   * its own sentence for that reason: every other answer here means "not for you" or
   * "not offered", and this one means "try again in a moment". Telling a customer whose
   * renewal is seconds from being applied that the action is unavailable would send
   * them to support over a wait.
   */
  [COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED]: 'bot.service.action_not_allowed',
  [COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE]: 'bot.service.action_unavailable',
  [COMMERCE_ERROR_CODES.ADDON_NOT_FOUND]: 'bot.service.action_unavailable',
  [COMMERCE_ERROR_CODES.ADDON_NOT_PURCHASABLE]: 'bot.service.action_unavailable',
  [COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE]: 'bot.service.capability_unsupported',
  [COMMERCE_ERROR_CODES.SERVICE_ACTION_IN_PROGRESS]: 'bot.service.action_in_progress',
  /*
   * A renewal priced in a unit this store has stopped selling.
   *
   * Reachable from a callback drawn before `sales.currency` moved: `availableFor` and
   * `offer` both filter on it now, and neither un-draws a message already in the chat.
   * The configuration sentence, because that is what it is.
   */
  [COMMERCE_ERROR_CODES.PRODUCT_CURRENCY_UNSUPPORTED]: 'bot.service.action_unavailable',
};

/**
 * The refusal keys that need a VALUE, and the value each one needs.
 *
 * Almost every refusal is a bare sentence, which is why `refusal` supplied `{}` for all
 * of them. `bot.payment.receipt_limit` is not: it declares a required `{limit}` so that
 * `PAYMENT_RECEIPT_MAX_PER_PAYMENT` and the Persian text cannot disagree — and the
 * resolver VALIDATES values against the declaration, so the empty object refused the
 * whole render and the customer was told nothing at all.
 *
 * That is the second instance of one defect on this branch (the first was the receipt
 * prompt's `minutes`), which is why `bot-runtime.test.ts` now asserts the RULE rather
 * than this row: every key in `REFUSAL_REPLIES` must have every required token supplied
 * here. A key added with a placeholder and no entry fails that test instead of failing
 * silently in front of a customer.
 */
const REFUSAL_VALUES: Readonly<Partial<Record<TemplateKey, TemplateValues>>> = {
  'bot.payment.receipt_limit': { limit: PAYMENT_RECEIPT_MAX_PER_PAYMENT },
};

export function refusalValuesFor(key: TemplateKey): TemplateValues {
  return REFUSAL_VALUES[key] ?? {};
}

function refusal(error: unknown): PendingReply {
  const key = isNexaError(error) ? REFUSAL_REPLIES[error.code] : undefined;
  if (key === undefined) throw error;
  return { key, values: refusalValuesFor(key), buttons: [], orderId: null };
}

/**
 * One turn of the customer-facing bot.
 *
 * The ORDER is the contract, and it is the same order `CLAUDE.md` fixes for the backup
 * pipeline and ADR-0028 fixes for recovery:
 *
 *   1. resolve and commit the state change — the customer exists, their profile is
 *      fresh, `last_seen_at` has moved;
 *   2. THEN send, outside any transaction.
 *
 * Never the other way round and never in one transaction. A send inside the transaction
 * could be rolled back after Telegram had delivered it, and a failed send must not undo
 * the fact that the customer arrived. `telegramSend` asserts the second half of that by
 * refusing to run inside a transaction at all.
 *
 * Nothing here throws for a send failure. A throw becomes a non-2xx, a non-2xx makes
 * Telegram redeliver the update, and a redelivered update whose only problem was a
 * failed reply is an unbounded loop that bumps `last_seen_at` for ever.
 */
export class BotRuntime {
  constructor(private readonly deps: BotRuntimeDeps) {}

  async handle(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
      readonly telegramUserId: string;
      readonly from: unknown;
    },
  ): Promise<BotTurnResult> {
    const command = intentOf(input.update, this.deps.mainMenu);
    const { intent } = command;

    /*
     * 1. The state change, committed.
     *
     * Runs for every intent this runtime SEES, not only `/start`. The customer's
     * existence and their `last_seen_at` are facts about any contact, and a "last seen"
     * that only moved on `/start` would be a column an operator reads as activity and
     * is not.
     *
     * One update never reaches here: `/ping`, which the webhook answers and returns
     * from. That is an idempotency-key collision rather than a product decision, and
     * `webhook.controller.ts` states it where the `return` is — named here too, because
     * "every intent" is the sentence a reader would otherwise take as complete.
     */
    const { customer, arrival } = await this.deps.customers.resolveFromUpdate(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      telegramUserId: input.telegramUserId,
      from: input.from,
      botInstanceId: input.botInstanceId,
    });

    /*
     * 2. The commercial work, still before any send.
     *
     * A BLOCKED customer never reaches it: `replyFor` answers `bot.blocked` whatever they
     * asked for, and this is gated on the same condition rather than on its own copy of
     * the rule. The order service refuses a blocked customer too — that is the
     * authoritative check, inside the transaction, and this one exists so the surface
     * does not ask for work it already knows will be refused.
     *
     * ADMIN INTENTS ARE EXEMPT, and the exemption is the identity model rather than a
     * convenience.
     *
     * A Telegram account that is bound as an administrator is ALSO resolved as a customer
     * here, because it is the same account. Customer standing and administrator standing
     * are independent in this product — `docs/research` records the legacy system
     * treating them as "mutually blind", and Phase 4A kept them separate deliberately. So
     * a blanket `bot.blocked` meant that blocking somebody's PURCHASES silently revoked
     * their management panel: the intent never reached `adminTurn`, and the only way back
     * was to unblock the customer, which is not what the operator who pressed Block
     * decided.
     *
     * Blocking is still enforced for everything a customer can do. This routes the admin
     * intents to the one door that resolves the binding, and `adminTurn` returning null —
     * a blocked customer who is NOT an administrator, including one crafting `D:<uuid>` —
     * falls back to the same `bot.blocked` as before. Authority is not granted here: every
     * admin action re-checks its own permission inside its own transaction.
     */
    const blocked: PendingReply = {
      key: 'bot.blocked' as TemplateKey,
      values: {},
      buttons: [],
      orderId: null,
    };
    const reply =
      arrival === 'BLOCKED'
        ? ((ADMIN_INTENTS.has(command.intent)
            ? await this.adminTurn(scope, actor, command, input)
            : null) ?? blocked)
        : await this.act(scope, actor, command, customer, arrival, input);

    const chatId = privateChatIdOf(input.update);

    /*
     * 3. The reply, after the commit, and only into a private chat.
     *
     * A REDELIVERED update replies AGAIN, and that is a decision rather than an
     * oversight. Every durable effect above is idempotent — the customer row, the
     * audit rows, the order, the `OrderConfirmed` event — so a replay repeats none of
     * them. The reply cannot join them: Telegram's `sendMessage` has no idempotency
     * key, so "exactly once" is not on offer and the choice is between a duplicate
     * message and a missing one.
     *
     * Telegram redelivers precisely when it did not see a 200, which includes the
     * case where the first turn committed and the send never happened. Suppressing
     * the reply on a replay would leave that customer staring at nothing, for ever,
     * with nothing anywhere saying so — the invisible failure this codebase exists
     * to remove. A second copy of the same summary is visible and self-correcting.
     *
     * What would change this is persisting the SEND OUTCOME and re-sending only when
     * the first one was not `DELIVERED`. That needs a second durable write after the
     * commit, which is a mechanism rather than a line. Nothing sent here costs money
     * to duplicate: the most a customer sees twice is one order summary naming the
     * SAME order, because the idempotency key is the update's.
     */
    if (reply.key === null || chatId === null) {
      await this.stopSpinner(scope, command, input.botInstanceId);
      return {
        intent,
        arrival,
        customerId: customer.id,
        replyKey: reply.key,
        orderId: reply.orderId,
        sent: 'NOT_ATTEMPTED',
      };
    }

    const sent = await this.deps.messenger.send(scope, {
      chatId,
      templateKey: reply.key,
      values: reply.values,
      botInstanceId: input.botInstanceId,
      ...(reply.buttons.length === 0 ? {} : { buttons: reply.buttons }),
      ...(reply.keyboard === undefined ? {} : { keyboard: reply.keyboard }),
    });

    /*
     * The follow-up, after the answer and only if the answer went out.
     *
     * `docs/phase4h-audit.md` §5: a customer who had paid saw `bot.order.settled` and
     * then nothing at all until the subscription link arrived, however long that took.
     * This is the sentence for that window.
     *
     * Its outcome is NOT the turn's, and that asymmetry is the point. The turn reports
     * whether the customer was told the thing that mattered — that their money arrived
     * — and a failed note about provisioning must not make a successful settlement look
     * like a failed send in the operational log. The customer meets the same fact again
     * when the link arrives, or through `bot.service.provision_delayed` if it does not.
     */
    if (reply.followUpKey !== undefined && sent.outcome === 'DELIVERED') {
      await this.deps.messenger.send(scope, {
        chatId,
        templateKey: reply.followUpKey,
        values: {},
        botInstanceId: input.botInstanceId,
      });
    }

    /*
     * A rate-limited FACT goes on the lane rather than being lost.
     *
     * `OQ-4H-01`. The durable write has already committed by the time this runs —
     * the transfer claim is recorded, the order is cancelled — and Telegram
     * answered 429. Telegram does not redeliver the update and nothing here
     * rescheduled the reply, so the customer was left believing nothing happened.
     * For a transfer that means sending the money twice.
     *
     * ONLY on `RATE_LIMITED`, and the narrowness is the design:
     *
     * - `DELIVERED` needs nothing.
     * - `REFUSED` is Telegram saying it will never accept this — a blocked bot, a
     *   dead chat — and queueing a second copy would produce a row the dispatcher
     *   burns attempts on for a destination that is gone.
     * - `UNKNOWN` is the one this must not touch. The send may have arrived; the
     *   lane's own `UNCONFIRMED` state exists because a retried "your payment was
     *   rejected" is a customer wondering which message is true, and this would
     *   be that mistake one layer up.
     *
     * The enqueue is idempotent by `customer_notifications_subject_key`, so a
     * customer who taps twice and is limited twice still hears once. It is also
     * the only write here and it happens AFTER the business transaction closed,
     * so nothing is held open across a Telegram call.
     */
    if (sent.outcome === 'RATE_LIMITED' && reply.fallback !== undefined) {
      await this.deps.queueRateLimitedFact(
        scope,
        customer.id,
        reply.fallback.kind,
        reply.fallback.subjectId,
        sent.retryAfterMs,
      );
    }

    // After the real answer, not before it. The spinner is cosmetic and its failure is
    // silent; putting it first would let a slow acknowledgement delay the message the
    // customer is actually waiting for.
    await this.stopSpinner(scope, command, input.botInstanceId);

    return {
      intent,
      arrival,
      customerId: customer.id,
      replyKey: reply.key,
      orderId: reply.orderId,
      sent: sent.outcome,
    };
  }

  /**
   * The management panel's turn (Phase 5T), or `null` when this is not an administrator.
   *
   * `null` rather than a refusal, because the caller then falls through to the ordinary
   * unsupported-input reply — the SAME answer any unrecognised string gets. That is the
   * whole of the "a customer cannot open the admin menu by crafting callback data"
   * property: the callback parses, this method resolves no administrator behind the
   * Telegram id that sent it, and the customer learns nothing about what exists.
   *
   * The administrator's OWN actor is what every call below carries — `TELEGRAM_ADMIN`
   * with their administrator id — so the audit row names the person and not the bot, and
   * the guard resolves their real permissions. The turn's `SYSTEM_JOB` actor stops here.
   */
  private async adminTurn(
    scope: TenantContext,
    actor: ActorContext,
    command: BotCommand,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
      readonly telegramUserId: string;
    },
  ): Promise<PendingReply | null> {
    const admins = this.deps.telegramAdmins;
    if (admins === undefined) return null;

    const identity = await admins.resolve(scope, input.telegramUserId, actor.correlationId);
    if (identity === null) return null;

    const { actor: adminActor, permissions } = identity;
    // An administrator who holds neither of the panel's permissions has no panel, and
    // is answered exactly as a customer is. Nothing is hidden from them that they could
    // otherwise have done: both sections charge these keys server-side as well.
    const mayReview = permissions.has(RECEIPTS_VIEW_PERMISSION);
    const maySeeAdmins = permissions.has(ADMINS_VIEW_PERMISSION);
    const maySeeServices = permissions.has(SERVICES_VIEW_PERMISSION);
    const maySeePanels = permissions.has(PANELS_VIEW_PERMISSION);
    /*
     * The reminder section needs BOTH read permissions, because it prints both halves:
     * the five settings and the three switches. Drawing it for an administrator who
     * holds only one would produce a screen that denies itself on arrival.
     */
    const maySeeReminders = permissions.has(SETTINGS_VIEW_PERMISSION);
    const maySeeCustomers = permissions.has(CUSTOMERS_VIEW_PERMISSION);
    if (!hasAnyPanelSection(permissions)) return null;

    try {
      switch (command.intent) {
        case 'ADMIN_PANEL':
          return {
            key: 'bot.admin.panel',
            values: {},
            buttons: [
              ...(mayReview
                ? [
                    {
                      label: {
                        kind: 'TEMPLATE' as const,
                        key: 'bot.admin.receipts_button' as const,
                      },
                      data: ADMIN_RECEIPTS_CALLBACK_PREFIX,
                    },
                  ]
                : []),
              ...(maySeeServices
                ? [
                    {
                      label: {
                        kind: 'TEMPLATE' as const,
                        key: 'bot.admin.services_button' as const,
                      },
                      data: ADMIN_SERVICES_CALLBACK_PREFIX,
                    },
                  ]
                : []),
              ...(maySeePanels
                ? [
                    {
                      label: {
                        kind: 'TEMPLATE' as const,
                        key: 'bot.admin.panels_button' as const,
                      },
                      data: ADMIN_PANELS_CALLBACK_PREFIX,
                    },
                  ]
                : []),
              ...(maySeeReminders
                ? [
                    {
                      label: {
                        kind: 'TEMPLATE' as const,
                        key: 'bot.admin.reminders_button' as const,
                      },
                      data: ADMIN_REMINDERS_CALLBACK_PREFIX,
                    },
                  ]
                : []),
              ...(maySeeCustomers
                ? [
                    {
                      label: {
                        kind: 'TEMPLATE' as const,
                        key: 'bot.admin.customers_button' as const,
                      },
                      data: ADMIN_CUSTOMERS_CALLBACK_PREFIX,
                    },
                  ]
                : []),
              ...(maySeeAdmins
                ? [
                    {
                      label: {
                        kind: 'TEMPLATE' as const,
                        key: 'bot.admin.section_button' as const,
                      },
                      data: ADMIN_SECTION_CALLBACK_PREFIX,
                    },
                  ]
                : []),
            ],
            orderId: null,
          };
        case 'ADMIN_RECEIPTS':
          return await this.adminReceipts(scope, adminActor);
        case 'ADMIN_RECEIPT':
          return command.targetId === null
            ? null
            : await this.adminReceipt(
                scope,
                adminActor,
                command.targetId,
                input,
                permissions.has(RECEIPTS_REVIEW_PERMISSION),
              );
        case 'ADMIN_APPROVE':
        case 'ADMIN_REJECT':
          return command.targetId === null
            ? null
            : await this.adminDecide(
                scope,
                adminActor,
                command.targetId,
                command.intent === 'ADMIN_APPROVE',
                input.idempotencyKey,
              );
        case 'ADMIN_SERVICES':
          return await this.adminServices(scope, adminActor);
        case 'ADMIN_SERVICE': {
          /*
           * Reached two ways: a queue button carrying a uuid the boundary validated, and
           * `/service <id>` typed by hand, which it did not — the boundary splits a
           * command's words and cannot know which of them is meant to be an id.
           *
           * Neither is re-validated HERE, and the empty string stands in for a bare
           * `/service`. That is the result of a mutation rather than an omission: this
           * handler validated the typed id and refused an absent one, and BOTH checks
           * survived being reverted, because `ServiceAdminService.get` runs every id
           * through `serviceIdOrNotFound` and `SERVICE_NOT_FOUND` is what the catch
           * below already renders as `bot.admin.service_gone`.
           *
           * A guard that survives its own mutation is a rule in name only, and the
           * danger is not the dead code — it is the next reader taking it for the one
           * holding the line and removing the one that is. So the answer has ONE place
           * it is decided, which is also where the permission is charged first, so an
           * administrator without `services.view` cannot learn whether an id is even
           * well-formed.
           */
          const typed = command.targetId ?? (command.args ?? [])[0] ?? '';
          return await this.adminService(scope, adminActor, typed, permissions);
        }
        case 'ADMIN_SERVICE_TERMINATE_ASK':
          return command.targetId === null
            ? null
            : await this.adminServiceTerminateAsk(scope, adminActor, command.targetId, permissions);
        case 'ADMIN_SERVICE_SYNC':
        case 'ADMIN_SERVICE_RESEND':
        case 'ADMIN_SERVICE_RETRY':
        case 'ADMIN_SERVICE_RECONCILE':
        case 'ADMIN_SERVICE_SUSPEND':
        case 'ADMIN_SERVICE_RESUME':
        case 'ADMIN_SERVICE_TERMINATE':
          return command.targetId === null
            ? null
            : await this.adminServiceAct(
                scope,
                adminActor,
                command.intent,
                command.targetId,
                input.idempotencyKey,
              );
        case 'ADMIN_PANELS':
          return await this.adminPanels(scope, adminActor, null);
        case 'ADMIN_REMINDERS':
          return await this.adminReminders(scope, adminActor);
        case 'ADMIN_REMINDER_EDIT':
          /*
           * The cast is safe because the BOUNDARY validated it: `callbackCommand`
           * refuses any code not in `REMINDER_SETTING_CODES` before an intent is
           * produced, so `targetId` here is one of the five or the intent is
           * UNSUPPORTED. The same shape the UUID paths use.
           */
          return command.targetId === null
            ? null
            : await this.adminReminderEdit(
                scope,
                adminActor,
                command.targetId as ReminderSettingCode,
              );
        case 'ADMIN_REMINDER_SET': {
          const chosen = command.args?.[0];
          if (command.targetId === null || chosen === undefined) return null;
          return await this.adminReminderSet(
            scope,
            adminActor,
            command.targetId as ReminderSettingCode,
            Number(chosen),
            input.idempotencyKey,
          );
        }
        case 'ADMIN_PANELS_PAGE':
          /*
           * The cursor is decoded at the boundary, so an unparseable one never reaches
           * here — it is UNSUPPORTED, the same answer every other unreadable callback
           * gets. `null` cannot happen and is handled anyway: the first page is the
           * safe reading of "no position", and throwing on a shape the boundary
           * guarantees would be a crash for a case that cannot occur.
           */
          return await this.adminPanels(scope, adminActor, command.cursor ?? null);
        case 'ADMIN_PANEL_DETAIL':
          return command.targetId === null
            ? null
            : await this.adminPanelDetail(scope, adminActor, command.targetId, permissions);
        case 'ADMIN_PANEL_ARCHIVE_ASK':
          return command.targetId === null
            ? null
            : await this.adminPanelArchiveAsk(scope, adminActor, command.targetId, permissions);
        case 'ADMIN_PANEL_TEST':
        case 'ADMIN_PANEL_ENABLE':
        case 'ADMIN_PANEL_DISABLE':
        case 'ADMIN_PANEL_ARCHIVE':
          return command.targetId === null
            ? null
            : await this.adminPanelAct(
                scope,
                adminActor,
                command.intent,
                command.targetId,
                input.idempotencyKey,
              );
        case 'ADMIN_USERNAME':
          return command.targetId === null
            ? null
            : await this.adminUsername(scope, adminActor, command.targetId, permissions);
        case 'ADMIN_USERNAME_TOGGLE': {
          /*
           * The casts are safe because the BOUNDARY validated them: `callbackCommand`
           * refuses any field outside `USERNAME_TOGGLE_FIELDS` and any value that is
           * not `0` or `1` before an intent is produced. The same shape the reminder
           * codes use.
           */
          const field = command.args?.[0];
          const value = command.args?.[1];
          if (command.targetId === null || field === undefined || value === undefined) return null;
          return await this.adminUsernameWrite(
            scope,
            adminActor,
            command.targetId,
            permissions,
            (policy) => ({
              ...policy,
              [USERNAME_TOGGLE_FIELDS[field as UsernameToggleField]]: value === '1',
            }),
            input.idempotencyKey,
          );
        }
        case 'ADMIN_USERNAME_STRATEGY': {
          const code = command.args?.[0];
          if (command.targetId === null || code === undefined) return null;
          const strategy = USERNAME_STRATEGY_CODES[code as UsernameStrategyCode];
          return await this.adminUsernameWrite(
            scope,
            adminActor,
            command.targetId,
            permissions,
            (policy) => ({
              ...policy,
              strategy,
              /*
               * A preset that needs a prefix and has none gets the default one rather
               * than a refusal. `nx` is what an unconfigured panel already uses, so
               * the tap does exactly what the button says; the operator changes it
               * with `/panel_prefix` afterwards if they want a different one.
               */
              prefix:
                strategy === 'PREFIX_RANDOM' ? (policy.prefix ?? DEFAULT_USERNAME_PREFIX) : null,
              template: null,
            }),
            input.idempotencyKey,
          );
        }
        case 'ADMIN_USERNAME_PREFIX':
        case 'ADMIN_USERNAME_TEMPLATE': {
          const [panelId, ...rest] = command.args ?? [];
          const written = rest.join(' ');
          if (panelId === undefined || written === '') {
            return { key: 'bot.admin.panel_gone', values: {}, buttons: [], orderId: null };
          }
          const wantsTemplate = command.intent === 'ADMIN_USERNAME_TEMPLATE';
          return await this.adminUsernameWrite(
            scope,
            adminActor,
            panelId,
            permissions,
            (policy) => ({
              ...policy,
              /*
               * The command selects the preset as well as supplying its value, and it
               * has to: `panels_username_template_check` is a biconditional, so a
               * template without `CUSTOM_TEMPLATE` beside it is not a storable row.
               * Saying "use this template here" in one message is also what an
               * operator means by sending it.
               */
              strategy: wantsTemplate ? 'CUSTOM_TEMPLATE' : 'PREFIX_RANDOM',
              prefix: wantsTemplate ? null : written,
              template: wantsTemplate ? written : null,
            }),
            input.idempotencyKey,
          );
        }
        case 'ADMIN_CUSTOMERS':
          return await this.adminCustomers(scope, adminActor, null);
        case 'ADMIN_CUSTOMERS_PAGE':
          /*
           * The cursor is decoded at the boundary, so an unparseable one never reaches
           * here — the same shape `ADMIN_PANELS_PAGE` has.
           */
          return await this.adminCustomers(scope, adminActor, command.cursor ?? null);
        case 'ADMIN_CUSTOMER':
          return command.targetId === null
            ? null
            : await this.adminCustomer(scope, adminActor, command.targetId, permissions);
        case 'ADMIN_CUSTOMER_FIND':
          return await this.adminCustomerFind(
            scope,
            adminActor,
            (command.args ?? [])[0] ?? '',
            permissions,
          );
        case 'ADMIN_CUSTOMER_BLOCK':
        case 'ADMIN_CUSTOMER_UNBLOCK':
          return command.targetId === null
            ? null
            : await this.adminCustomerStatus(
                scope,
                adminActor,
                command.targetId,
                command.intent === 'ADMIN_CUSTOMER_BLOCK',
                permissions,
                input.idempotencyKey,
              );
        case 'ADMIN_SECTION':
          return await this.adminSection(scope, adminActor);
        case 'ADMIN_ADMIN':
          return command.targetId === null
            ? null
            : await this.adminAdmin(scope, adminActor, command.targetId, permissions);
        case 'ADMIN_ADMIN_STATUS': {
          /*
           * The cast is safe because the BOUNDARY validated it: `callbackCommand` is
           * only reached for a code in `ADMIN_STATUS_CODES`, so this is one of the two
           * or the intent is UNSUPPORTED. The same shape the reminder codes use.
           */
          const code = command.args?.[0];
          if (command.targetId === null || code === undefined) return null;
          return await this.adminAdminStatus(
            scope,
            adminActor,
            command.targetId,
            ADMIN_STATUS_CODES[code as AdminStatusCode],
            permissions,
            input.idempotencyKey,
          );
        }
        case 'ADMIN_REVOKE':
          return command.targetId === null
            ? null
            : await this.adminRevokeAccess(scope, adminActor, command.targetId);
        case 'ADMIN_LINK':
          return await this.adminLink(scope, adminActor, command.args ?? []);
        case 'ADMIN_ROLE':
          return await this.adminRole(scope, adminActor, command.args ?? [], input.idempotencyKey);
        default:
          return null;
      }
    } catch {
      /*
       * ONE refusal for everything, and the distinctions are deliberately not rendered.
       *
       * A permission denial, an unknown administrator, a Telegram account already bound
       * and an attempted escalation are four different facts, all of them recorded — the
       * guard writes an operational event, the services write audit rows, and both carry
       * the error code. What a reply must not do is tell whoever holds that chat WHICH
       * of the four they hit, because the answer is a fact about other administrators.
       */
      return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
    }
  }

  /**
   * Whether this turn's Telegram account is an administrator with a panel.
   *
   * Used for ONE thing — whether `/start` draws the panel row — and it makes the same
   * resolution the actions make, so the keyboard cannot promise a section the guard
   * would refuse. It answers false for every case `adminTurn` treats as "not an
   * administrator", including an ACTIVE administrator holding neither panel permission.
   */
  private async isAdmin(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly telegramUserId: string },
  ): Promise<boolean> {
    const admins = this.deps.telegramAdmins;
    if (admins === undefined) return false;
    const identity = await admins.resolve(scope, input.telegramUserId, actor.correlationId);
    if (identity === null) return false;
    /*
     * The SAME list `adminTurn` gates on, and now literally the same one.
     *
     * The rule has always been that the keyboard must not promise a panel the turn
     * would refuse, and must not withhold one from an administrator who has a section.
     * It was two hand-kept copies, and they had already diverged over the reminders
     * section — see `PANEL_SECTION_PERMISSIONS` for what that cost.
     */
    return hasAnyPanelSection(identity.permissions);
  }

  /**
   * The queue: the manual transfers that hold a receipt and are still pending.
   *
   * Bounded by `ADMIN_QUEUE_LIMIT` and ordered oldest first by the service, so the
   * buttons are the work in the order it arrived. The rows carry the REFERENCE and the
   * amount rather than a payment id: the reference is what the customer quoted to their
   * bank and what a reviewer matches against a statement.
   */
  private async adminReceipts(scope: TenantContext, actor: ActorContext): Promise<PendingReply> {
    const items = await this.deps.receipts.reviewQueue(scope, actor, ADMIN_QUEUE_LIMIT);
    if (items.length === 0) {
      return { key: 'bot.admin.receipts_none', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.admin.receipts_list',
      values: {},
      buttons: items.map((item) => ({
        label: { kind: 'TEXT' as const, text: item.payment.reference, amount: item.payment.amount },
        data: `${ADMIN_RECEIPT_CALLBACK_PREFIX}${item.payment.id}`,
      })),
      orderId: null,
    };
  }

  /**
   * One queue item: the facts, the media, and the two decisions.
   *
   * The MEDIA goes first and the decision message second, which is the order a reviewer
   * needs — look, then decide. Sending it here is safe and is not the "decide then
   * send" rule being broken: every read above has committed, nothing durable is
   * pending, and `telegramSend` still refuses to run inside a transaction.
   *
   * A failed media send does not fail the turn. The reviewer still gets the facts and
   * the buttons, and the receipt is still in the Web Admin — an approval decided on the
   * reference and the amount is the same approval.
   */
  private async adminReceipt(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    input: { readonly update: unknown },
    /** Whether the resolved identity holds `receipts.review`. The buttons are drawn only then. */
    mayDecide: boolean,
  ): Promise<PendingReply> {
    const item = await this.deps.receipts.reviewItem(scope, actor, paymentId as PaymentId);
    if (item === null) {
      return { key: 'bot.admin.receipt_gone', values: {}, buttons: [], orderId: null };
    }

    const chatId = privateChatIdOf(input.update);
    if (chatId !== null) {
      for (const receipt of item.receipts) {
        await this.deps.messenger.sendFile(scope, {
          chatId,
          // The bot that RECEIVED the upload, from the row. A `file_id` is scoped to
          // that bot, and the wrong token answers "file not found" for a receipt that
          // exists — which is why the column is on `payment_receipts` at all.
          botInstanceId: receipt.botInstanceId,
          kind: receipt.kind === 'PHOTO' ? 'PHOTO' : 'DOCUMENT',
          fileId: receipt.fileId,
        });
      }
    }

    return {
      key: 'bot.admin.receipt',
      values: {
        reference: item.payment.reference,
        total: item.payment.amount,
        // The customer's Telegram id, which is the identity this installation holds for
        // them. Not a display name: a name is chosen by the person it names, and a
        // reviewer deciding money needs the id the rest of the system uses.
        customer: item.customer?.telegramUserId ?? item.payment.customerId,
      },
      /*
       * The decision buttons only for an identity that may DECIDE. `receipts.view` opens
       * this screen and the seeded observer holds it without `receipts.review`; drawing
       * approve and reject for them produced two buttons whose every tap failed the guard
       * with the generic refusal — the advertised workflow, unusable for every view-only
       * administrator. The guard still runs on the tap; this is the surface not promising
       * what the tap will refuse.
       */
      buttons: mayDecide
        ? [
            {
              label: { kind: 'TEMPLATE', key: 'bot.admin.approve_button' },
              data: `${ADMIN_APPROVE_CALLBACK_PREFIX}${item.payment.id}`,
              row: 0,
            },
            {
              label: { kind: 'TEMPLATE', key: 'bot.admin.reject_button' },
              data: `${ADMIN_REJECT_CALLBACK_PREFIX}${item.payment.id}`,
              row: 0,
            },
          ]
        : [],
      orderId: null,
    };
  }

  /**
   * Approve or reject, through the SAME application methods the Web Admin calls.
   *
   * `confirmManualTransfer` and `rejectManualTransfer` — no parallel settlement, no
   * second ledger write, no second notification. Everything that makes a decision safe
   * lives in there: the permission, the conditional state transition, the wallet credit
   * keyed on the payment, the customer's notification, the audit row.
   *
   * A duplicate tap is safe TWICE OVER. The idempotency key is the update's, so
   * Telegram's redelivery of one tap is a replay; and two different taps race a
   * conditional UPDATE that only one can win, after which the loser reads a payment
   * that is no longer pending and is told so rather than settling anything again.
   */
  private async adminDecide(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    approve: boolean,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const item = await this.deps.receipts.reviewItem(scope, actor, paymentId as PaymentId);
    if (item === null) {
      return { key: 'bot.admin.receipt_gone', values: {}, buttons: [], orderId: null };
    }

    if (approve) {
      await this.deps.payments.confirmManualTransfer(scope, actor, paymentId, {
        idempotencyKey: `${idempotencyKey}:admin-approve`,
        // An ASCII note, and an audit field rather than customer-facing text: it says
        // through which surface the decision was taken, which is exactly what a
        // reviewer reading the payment later wants to know.
        note: 'Approved in the Telegram management panel.',
      });
      return { key: 'bot.admin.approved', values: {}, buttons: [], orderId: null };
    }

    await this.deps.payments.rejectManualTransfer(scope, actor, paymentId, {
      idempotencyKey: `${idempotencyKey}:admin-reject`,
      note: 'Rejected in the Telegram management panel.',
    });
    return { key: 'bot.admin.rejected', values: {}, buttons: [], orderId: null };
  }

  /**
   * The services queue: what needs an administrator, and nothing else.
   *
   * TWO searches, and the choice of which two is the whole design. `UNRECONCILED` is a
   * service whose create was lost — nothing resolves it on its own, and 4D made it a
   * dead end deliberately so that nobody asks a panel for a second account. A `FAILED`
   * delivery is a customer who paid and has no link, after the automatic lane gave up
   * at its attempt ceiling. Every other state either settles itself or belongs to the
   * customer, and a queue that listed them would be a list of things not to do.
   *
   * Bounded by `ADMIN_QUEUE_LIMIT` per search and NOT paged, for the reason that
   * constant gives: this is a keyboard, Telegram refuses an oversized one, and ten rows
   * are ten decisions. An installation with more than ten of either has a bigger
   * question than the eleventh row, and the Web Admin pages properly.
   */
  private async adminServices(scope: TenantContext, actor: ActorContext): Promise<PendingReply> {
    const [unreconciled, undelivered] = await Promise.all([
      this.deps.serviceAdmin.list(scope, actor, {
        limit: ADMIN_QUEUE_LIMIT,
        search: { state: 'UNRECONCILED' },
      }),
      this.deps.serviceAdmin.list(scope, actor, {
        limit: ADMIN_QUEUE_LIMIT,
        search: { deliveryState: 'FAILED' },
      }),
    ]);

    /*
     * De-duplicated by id: a service can be BOTH unreconciled and undelivered, and two
     * buttons for one service is a list that looks longer than the work is.
     */
    const seen = new Set<string>();
    const buttons: CustomerButton[] = [];
    for (const service of [...unreconciled.items, ...undelivered.items]) {
      if (seen.has(service.id)) continue;
      seen.add(service.id);
      buttons.push({
        /*
         * The provider username, which is the handle an operator types into the panel
         * and is NOT a credential. Not the subscription ref and not the client id —
         * both are bearer capabilities, and this message stays in the chat for ever.
         */
        label: { kind: 'TEXT' as const, text: service.providerUsername },
        data: `${ADMIN_SERVICE_CALLBACK_PREFIX}${service.id}`,
      });
    }
    if (buttons.length === 0) {
      return { key: 'bot.admin.services_none', values: {}, buttons: [], orderId: null };
    }
    return { key: 'bot.admin.services_section', values: {}, buttons, orderId: null };
  }

  // -------------------------------------------------------------------------
  // The panels section (Phase 6B)
  // -------------------------------------------------------------------------

  /**
   * The fleet: one button per live panel, newest first, and a page button when there
   * is more.
   *
   * PAGED rather than bounded-and-truncated, which is the opposite of what the services
   * queue does, and the difference is what each list IS. The services section is a
   * QUEUE of work — ten rows are ten decisions and an eleventh is a bigger question than
   * the row. A fleet is an inventory: every panel is a legitimate destination, and an
   * installation with twenty of them must be able to reach the twentieth. So this
   * carries the repository's own keyset cursor, through the codec that makes it fit
   * Telegram's 64 bytes.
   *
   * `LIVE` and not `ALL`: an archived panel has no action on this surface — restoring
   * one may need a new name, and a name is not typed into a chat here — so listing them
   * would be a list of buttons that can only report what cannot be done.
   *
   * `list` charges `panels.view` itself, so an administrator who reached this through a
   * crafted callback without it is refused there rather than here.
   */
  /**
   * Every reminder setting and switch, printed before anything is editable.
   *
   * The whole point of the screen, and the cure for the defect CBR-013 and BC-SB-003
   * name: seven of twelve legacy settings screens never show the value they are about
   * to replace, so "an admin cannot read the current configuration without overwriting
   * it". Here the read is a read.
   *
   * `reminderConfig.read` charges `settings.view` itself — the one key both the
   * settings and the flags are read under. The
   * button that led here was drawn behind the same pair, and this is checked ANYWAY:
   * not drawing a button is never the control, because a callback can be replayed from
   * an old message after a role change.
   */
  private async adminReminders(scope: TenantContext, actor: ActorContext): Promise<PendingReply> {
    const config = await this.deps.reminderConfig.read(scope, actor);
    return {
      key: 'bot.admin.reminders_section',
      values: {
        expiry: onOff(config.expiryEnabled),
        expired: onOff(config.expiredNoticeEnabled),
        usage: onOff(config.usageEnabled),
        firstDays: config.expiryFirstDays,
        secondDays: config.expirySecondDays,
        firstPercent: config.usageFirstPercent,
        secondPercent: config.usageSecondPercent,
        finalPercent: config.usageFinalPercent,
      },
      buttons: REMINDER_SETTING_CODE_ORDER.map((code) => ({
        label: { kind: 'TEMPLATE' as const, key: REMINDER_SETTING_BUTTONS[code] },
        data: `${ADMIN_REMINDER_EDIT_CALLBACK_PREFIX}${code}`,
      })),
      orderId: null,
    };
  }

  /** One setting, its current value, and the values a tap may replace it with. */
  private async adminReminderEdit(
    scope: TenantContext,
    actor: ActorContext,
    code: ReminderSettingCode,
  ): Promise<PendingReply> {
    const config = await this.deps.reminderConfig.read(scope, actor);
    return {
      key: 'bot.admin.reminder_choose',
      values: {
        setting: REMINDER_SETTING_CODES[code],
        current: reminderValueOf(config, code),
      },
      /*
       * The options are plain TEXT labels, because a number is data and not a sentence.
       * `check:i18n` forbids hard-coded customer-facing STRINGS in a surface; rendering
       * `String(85)` is neither hard-coded nor a string a translator would touch.
       */
      buttons: reminderOptionsFor(code).map((option) => ({
        label: { kind: 'TEXT' as const, text: String(option) },
        data: `${ADMIN_REMINDER_SET_CALLBACK_PREFIX}${code}:${String(option)}`,
      })),
      orderId: null,
    };
  }

  /**
   * Writes one threshold, or says why the combination was refused.
   *
   * The write goes through `SettingsService.set`, which is the SAME path the Web Admin
   * uses: the same permission, the same audit row, the same idempotency record and the
   * same `ReminderThresholdsGuard`. This surface adds no rule of its own, which is what
   * makes the two surfaces impossible to drift apart.
   *
   * A refusal is rendered, not thrown. `refuseReminderThresholds` produces Persian
   * prose naming which of the five is wrong; letting it reach the generic error handler
   * would replace that with a shrug, which is the legacy `⭕️ ورودی نا معتبر` this whole
   * section is written against.
   */
  private async adminReminderSet(
    scope: TenantContext,
    actor: ActorContext,
    code: ReminderSettingCode,
    value: number,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const key = REMINDER_SETTING_CODES[code];
    /*
     * SUFFIXED, and the suffix is load-bearing — the same note `draft` carries.
     *
     * The update's bare key is already consumed by the turn that resolved this
     * account, so presenting it again with a different payload is
     * `platform.idempotency_payload_mismatch`. That throws, `adminTurn` catches
     * everything as `bot.admin.refused`, and the operator sees a generic denial for a
     * write that was never refused by any permission. Every other admin write on this
     * surface suffixes; this one did not.
     */
    const result = await this.deps.reminderConfig.write(
      scope,
      actor,
      key,
      value,
      `${idempotencyKey}:reminder-${code}`,
    );
    if (!result.ok) {
      return {
        key: 'bot.admin.reminder_refused',
        values: { reason: result.reason },
        buttons: [],
        orderId: null,
      };
    }
    return {
      key: 'bot.admin.reminder_saved',
      values: { setting: key, value },
      buttons: [],
      orderId: null,
    };
  }

  private async adminPanels(
    scope: TenantContext,
    actor: ActorContext,
    cursor: KeysetToken | null,
  ): Promise<PendingReply> {
    const page = await this.deps.panelAdmin.list(scope, actor, {
      limit: ADMIN_QUEUE_LIMIT,
      archived: 'LIVE',
      cursor,
    });

    const buttons: CustomerButton[] = page.panels.map((view) => ({
      /*
       * The NAME the operator gave it, and nothing else. Not the base URL: an address
       * is most of what somebody needs to go looking, and this message stays in that
       * chat for ever and is forwardable.
       */
      label: { kind: 'TEXT' as const, text: view.panel.name },
      data: `${ADMIN_PANEL_DETAIL_CALLBACK_PREFIX}${view.panel.id}`,
    }));
    if (buttons.length === 0) {
      return { key: 'bot.admin.panels_none', values: {}, buttons: [], orderId: null };
    }

    /*
     * The next page, appended only when the cursor ENCODES — the rule the customer's
     * own services list states: a cursor this codec cannot carry would become a button
     * whose `callback_data` is a bare prefix, and the honest answer to that is the same
     * as having no further page.
     */
    const token = page.nextCursor === null ? null : encodeKeysetToken(page.nextCursor);
    if (token !== null) {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.panels_more_button' },
        data: `${ADMIN_PANELS_PAGE_CALLBACK_PREFIX}${token}`,
      });
    }
    return { key: 'bot.admin.panels_section', values: {}, buttons, orderId: null };
  }

  /**
   * One panel: what it is, what its last probe said, how full it is, and the actions
   * this administrator may take on it.
   *
   * The health three — the state, when it was checked, and whether that is stale — come
   * from `readHealth`, the SAME projection the Web Admin's response builder calls, so
   * the two surfaces cannot come to disagree about whether a disabled panel reads as
   * `DISABLED`. The occupancy comes from the capacity projection the service attaches,
   * for the same reason.
   *
   * What it does NOT carry: the base URL, any credential, any masked stand-in for one,
   * and the provider's response body. The failure is the KIND from the frozen taxonomy,
   * because a provider's own error text can carry a hostname, a path or a token
   * fragment — and the Web Admin is where a probe is read in full.
   */
  private async adminPanelDetail(
    scope: TenantContext,
    actor: ActorContext,
    panelId: string,
    permissions: ReadonlySet<PermissionKey>,
  ): Promise<PendingReply> {
    let view;
    try {
      view = await this.deps.panelAdmin.get(scope, actor, panelId);
    } catch {
      /*
       * Unknown, another tenant's, or malformed — ONE answer for all three, the rule
       * `bot.admin.service_gone` states: telling them apart would let anybody holding a
       * panel id learn whether it exists.
       */
      return { key: 'bot.admin.panel_gone', values: {}, buttons: [], orderId: null };
    }

    const reading = readHealth(view.panel, view.health, this.deps.clock.now());
    const mayEdit = permissions.has(PANELS_EDIT_PERMISSION);
    const buttons: CustomerButton[] = [];
    if (mayEdit) {
      /*
       * Test is offered for a panel that is not archived, which is the same condition
       * `testConnection` enforces: it refuses an ARCHIVED panel, so a button for one
       * could only ever record a refusal.
       */
      if (view.panel.status !== 'ARCHIVED') {
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.admin.panel_test_button' },
          data: `${ADMIN_PANEL_TEST_CALLBACK_PREFIX}${view.panel.id}`,
        });
      }
      if (view.panel.status === 'DISABLED') {
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.admin.panel_enable_button' },
          data: `${ADMIN_PANEL_ENABLE_CALLBACK_PREFIX}${view.panel.id}`,
        });
      }
      if (view.panel.status === 'ACTIVE') {
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.admin.panel_disable_button' },
          data: `${ADMIN_PANEL_DISABLE_CALLBACK_PREFIX}${view.panel.id}`,
        });
      }
      if (view.panel.status !== 'ARCHIVED') {
        buttons.push({
          /*
           * The ASKING prefix. `W:` opens the question and `X:` archives, and the two
           * differ by one character in a table — which is why that table exists and why
           * the archiving row is its last one.
           */
          label: { kind: 'TEMPLATE', key: 'bot.admin.panel_archive_button' },
          data: `${ADMIN_PANEL_ARCHIVE_ASK_CALLBACK_PREFIX}${view.panel.id}`,
        });
      }
      /*
       * Offered for an ARCHIVED panel too, and deliberately: `update` refuses one, so
       * the button records a refusal rather than working — but the SECTION behind it
       * is also where the policy is read, and an operator should be able to see what
       * an archived panel was configured to do.
       */
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.username_button' },
        data: `${ADMIN_USERNAME_CALLBACK_PREFIX}${view.panel.id}`,
      });
    }

    return {
      key: 'bot.admin.panel_detail',
      values: {
        name: view.panel.name,
        /*
         * The descriptor's canonical name, with the stored type as the fallback the
         * Web Admin's own projection uses. `providerDescriptor` is nullable because a
         * stored row could in principle name a type this build has no adapter for —
         * which panel creation refuses, so the fallback is a belt rather than a case.
         */
        provider:
          providerDescriptor(view.panel.providerType)?.canonicalName ?? view.panel.providerType,
        status: view.panel.status,
        health: reading.state,
        ...(reading.checkedAt === null ? {} : { checkedAt: reading.checkedAt }),
        ...(reading.failure === null ? {} : { failure: reading.failure }),
        services: view.capacity.services,
        reservations: view.capacity.reservations,
        /*
         * A STRING, and `bot.admin.panel_detail` says why: "no cap" is one of this
         * field's values, and rendering that as 0 would read as a full panel — the
         * exact inversion a null cap means.
         */
        cap: view.capacity.maxServices === null ? UNCAPPED : String(view.capacity.maxServices),
        /*
         * The policy, and it is configuration rather than a secret.
         *
         * An administrator reading the template is the only way to answer "why is this
         * customer's account called that" — the question a support conversation starts
         * from. The base URL and the credentials stay out of this message for the
         * reasons the docblock gives; a list of placeholder tokens is neither of those.
         *
         * The DASH for a null prefix or template is the same value the cap uses for
         * "there is none", and means the same thing here: this preset takes no
         * configuration, so there is nothing to read.
         */
        usernameCustom: view.panel.usernamePolicy.allowCustom ? MODE_ON : MODE_OFF,
        usernameAutomatic: view.panel.usernamePolicy.allowAutomatic ? MODE_ON : MODE_OFF,
        usernamePrefix: view.panel.usernamePolicy.prefix ?? UNCAPPED,
        usernameTemplate: view.panel.usernamePolicy.template ?? UNCAPPED,
      },
      buttons,
      orderId: null,
    };
  }

  /**
   * A panel's username policy, read back in full before anything is edited.
   *
   * Everything the operator can change is on this one screen WITH its current value —
   * the two customer choices, the selected preset, the prefix, the template, and a
   * preview rendered from synthetic values. That is the answer to the legacy
   * write-only settings screen, where the only way to read a price was to overwrite
   * it: nothing here has to be guessed at by changing it.
   *
   * The preview costs nothing and reserves nothing. `previewUsername` renders from
   * `USERNAME_PREVIEW_VALUES`, so looking at this screen cannot consume randomness a
   * customer would have got or take a name out of the namespace.
   */
  private async adminUsername(
    scope: TenantContext,
    actor: ActorContext,
    panelId: string,
    permissions: ReadonlySet<PermissionKey>,
  ): Promise<PendingReply> {
    let view;
    try {
      view = await this.deps.panelAdmin.get(scope, actor, panelId);
    } catch {
      return { key: 'bot.admin.panel_gone', values: {}, buttons: [], orderId: null };
    }
    return this.usernameSection(
      view.panel.id,
      view.panel.name,
      view.panel.usernamePolicy,
      permissions,
    );
  }

  /**
   * The section, rendered from a policy. Shared by the read and by every write.
   *
   * A write re-renders through this rather than telling the operator it succeeded and
   * leaving them to go and look: the screen they are left on shows what is stored NOW,
   * which is the only way a save can be checked without a second round trip.
   */
  private usernameSection(
    panelId: string,
    panelName: string,
    policy: PanelUsernamePolicy,
    permissions: ReadonlySet<PermissionKey>,
  ): PendingReply {
    const buttons: CustomerButton[] = [];
    /*
     * Drawn only with `panels.edit`, and that is presentation and not enforcement:
     * `PanelService.update` charges the same permission through the same guard, so a
     * crafted callback from an administrator without it is refused there and the
     * refusal is recorded. Not drawing a button is never the check — `CLAUDE.md`.
     */
    if (permissions.has(PANELS_EDIT_PERMISSION)) {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.username_custom_button' },
        data: `${ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX}c:${policy.allowCustom ? '0' : '1'}:${panelId}`,
      });
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.username_automatic_button' },
        data: `${ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX}a:${policy.allowAutomatic ? '0' : '1'}:${panelId}`,
      });
      for (const [code, key] of USERNAME_STRATEGY_BUTTONS) {
        buttons.push({
          label: { kind: 'TEMPLATE', key },
          data: `${ADMIN_USERNAME_STRATEGY_CALLBACK_PREFIX}${code}:${panelId}`,
        });
      }
    }
    return {
      key: 'bot.admin.username_section',
      values: {
        panel: panelName,
        custom: policy.allowCustom ? MODE_ON : MODE_OFF,
        automatic: policy.allowAutomatic ? MODE_ON : MODE_OFF,
        random: policy.strategy === 'RANDOM' ? MODE_ON : MODE_OFF,
        prefixRandom: policy.strategy === 'PREFIX_RANDOM' ? MODE_ON : MODE_OFF,
        telegramIdRandom: policy.strategy === 'TELEGRAM_ID_RANDOM' ? MODE_ON : MODE_OFF,
        customTemplate: policy.strategy === 'CUSTOM_TEMPLATE' ? MODE_ON : MODE_OFF,
        prefix: policy.prefix ?? UNCAPPED,
        template: policy.template ?? UNCAPPED,
        preview: previewUsername(policy) ?? UNCAPPED,
      },
      buttons,
      orderId: null,
    };
  }

  /**
   * Read the stored policy, apply ONE change to it, and write the whole thing back.
   *
   * Whole-policy rather than a field, because `PanelService.update` replaces the
   * policy as a unit and three CHECK constraints are about combinations of its
   * columns — a partial write is what reaches a state none of them individually
   * forbids. The edit is expressed as a function of what is stored, so the caller
   * never has to assemble a policy it did not read.
   *
   * Every tap carries the TARGET value rather than "flip it", so a double tap writes
   * the same policy twice. The turn's idempotency key makes the second one a replay
   * on top of that, and the service takes the panel's row lock: three mechanisms, and
   * the only one that would survive two administrators editing at once is the lock.
   * Last write wins between two people, which is what an absolute value means; what
   * cannot happen is one person's slow connection undoing their own change.
   *
   * A refusal is rendered with the shared evaluator's own words and NOTHING is
   * written — the service refuses the whole update, so the operator is looking at the
   * policy that is still stored.
   */
  private async adminUsernameWrite(
    scope: TenantContext,
    actor: ActorContext,
    panelId: string,
    permissions: ReadonlySet<PermissionKey>,
    edit: (policy: PanelUsernamePolicy) => PanelUsernamePolicy,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    let before;
    try {
      before = await this.deps.panelAdmin.get(scope, actor, panelId);
    } catch {
      return { key: 'bot.admin.panel_gone', values: {}, buttons: [], orderId: null };
    }
    const wanted = edit(before.panel.usernamePolicy);
    try {
      const after = await this.deps.panelAdmin.update(scope, actor, panelId, {
        idempotencyKey: `${idempotencyKey}:panel-username`,
        usernamePolicy: wanted,
      });
      return this.usernameSection(
        after.panel.id,
        after.panel.name,
        after.panel.usernamePolicy,
        permissions,
      );
    } catch (error) {
      /*
       * The evaluator's own Persian, not a sentence composed here.
       *
       * `validateUsernamePolicy` is the one place that decides whether a policy is
       * storable, and it carries the words for each refusal. Writing them again on
       * this surface would be the second opinion that goes stale — and the Web Admin
       * renders the same function's `reason`, so the two surfaces cannot disagree
       * about why something was refused.
       */
      const reason = validateUsernamePolicy(wanted).reason;
      if (reason !== null) {
        return {
          key: 'bot.admin.username_refused',
          values: { reason },
          buttons: [],
          orderId: null,
        };
      }
      return refusal(error);
    }
  }

  /**
   * The confirmation screen for archiving, and the count it is decided against.
   *
   * Re-reads the panel rather than trusting the callback, for the two reasons the
   * services terminate-ask gives: the permission is charged again by `get`, and the
   * count on this screen is the one that is true NOW rather than when the list was
   * drawn. A stale tap lands on a panel that has since been archived and is answered
   * `bot.admin.panel_gone` by the status check below rather than by a button that
   * cannot work.
   */
  private async adminPanelArchiveAsk(
    scope: TenantContext,
    actor: ActorContext,
    panelId: string,
    permissions: ReadonlySet<PermissionKey>,
  ): Promise<PendingReply> {
    if (!permissions.has(PANELS_EDIT_PERMISSION)) {
      return { key: 'bot.admin.panel_unavailable', values: {}, buttons: [], orderId: null };
    }
    let view;
    try {
      view = await this.deps.panelAdmin.get(scope, actor, panelId);
    } catch {
      return { key: 'bot.admin.panel_gone', values: {}, buttons: [], orderId: null };
    }
    if (view.panel.status === 'ARCHIVED') {
      return { key: 'bot.admin.panel_unavailable', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.admin.panel_archive_ask',
      values: { services: view.capacity.services },
      buttons: [
        {
          label: { kind: 'TEMPLATE', key: 'bot.admin.panel_archive_confirm_button' },
          data: `${ADMIN_PANEL_ARCHIVE_CALLBACK_PREFIX}${view.panel.id}`,
        },
      ],
      orderId: null,
    };
  }

  /**
   * The four actions: test, enable, disable, archive.
   *
   * Every one of them goes through `PanelService`, which charges `panels.edit` through
   * the same guard the Web Admin uses and writes the same audit row — so a crafted
   * callback from an administrator without that key is refused there, and the refusal is
   * recorded rather than silently swallowed. This surface decides which buttons to draw
   * and nothing about what is allowed.
   *
   * The idempotency key is the TURN's, suffixed by the action. A double tap is the same
   * command twice, which is what makes the second one a replay rather than a second
   * write — and for the test that is the difference between one probe of somebody's
   * panel and two.
   */
  private async adminPanelAct(
    scope: TenantContext,
    actor: ActorContext,
    intent: BotIntent,
    panelId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      if (intent === 'ADMIN_PANEL_TEST') {
        const result = await this.deps.panelAdmin.testConnection(scope, actor, panelId, {
          idempotencyKey: `${idempotencyKey}:panel-test`,
        });
        /*
         * `probed: false` means the stored health came back WITHOUT a new probe — a
         * replay under the same key, or a probe of this configuration recently enough
         * that repeating it would be a way to hammer somebody's provider. Reporting
         * that as "tested" is the legacy "✅ updated" for a write that did nothing.
         */
        return {
          key: result.probed ? 'bot.admin.panel_tested' : 'bot.admin.panel_test_replayed',
          values: {},
          buttons: [],
          orderId: null,
        };
      }

      const status =
        intent === 'ADMIN_PANEL_ENABLE'
          ? 'ACTIVE'
          : intent === 'ADMIN_PANEL_DISABLE'
            ? 'DISABLED'
            : 'ARCHIVED';
      await this.deps.panelAdmin.setStatus(scope, actor, panelId, {
        status,
        idempotencyKey: `${idempotencyKey}:panel-${status.toLowerCase()}`,
      });
      return {
        key:
          status === 'ACTIVE'
            ? 'bot.admin.panel_enabled'
            : status === 'DISABLED'
              ? 'bot.admin.panel_disabled'
              : 'bot.admin.panel_archived',
        values: {},
        buttons: [],
        orderId: null,
      };
    } catch (error) {
      /*
       * The one refusal this screen can resolve gets its own sentence, because the
       * remedy is the Test button an administrator is already looking at. Every other
       * panel refusal is one sentence pointing at the Web Admin, and a permission
       * denial is neither — it falls through to `act`'s own handling, which tells
       * whoever holds that chat nothing about what exists.
       */
      if ((error as { code?: unknown } | null)?.code === PANEL_ERROR_CODES.PANEL_NOT_VALIDATED) {
        return { key: 'bot.admin.panel_not_validated', values: {}, buttons: [], orderId: null };
      }
      if (isPanelRefusal(error)) {
        return { key: 'bot.admin.panel_unavailable', values: {}, buttons: [], orderId: null };
      }
      throw error;
    }
  }

  /**
   * One service, and the actions this administrator may actually take on it.
   *
   * The verdicts come from `ServiceAdminService.detail` — the SAME evaluator the Web
   * Admin renders and the write paths agree with — so this surface decides nothing about
   * availability. What it adds is the second filter: a verdict says the SERVICE allows
   * an action, and the permission says this administrator may ask for it. A button drawn
   * without both is a button whose every tap records a denial.
   *
   * `detail` charges `services.view` itself, so an administrator who reached this
   * through a crafted callback without it is refused there rather than here.
   */
  private async adminService(
    scope: TenantContext,
    actor: ActorContext,
    serviceId: string,
    permissions: ReadonlySet<PermissionKey>,
  ): Promise<PendingReply> {
    let found;
    try {
      found = await this.deps.serviceAdmin.detail(scope, actor, serviceId);
    } catch {
      /*
       * Unknown, another tenant's, or malformed — ONE answer for all three, which is
       * the rule `bot.service.not_found` states on the customer side. Telling them
       * apart would let anybody holding a service id learn whether it exists.
       */
      return { key: 'bot.admin.service_gone', values: {}, buttons: [], orderId: null };
    }

    const { service, actions } = found;
    const [operations, title] = await Promise.all([
      this.deps.serviceAdmin.operations(scope, actor, service.id).catch(() => []),
      this.deps.purchaseTitle(scope, service.orderId),
    ]);
    const latest = operations[0];

    return {
      key: 'bot.admin.service',
      values: {
        customer: service.customerId,
        username: service.providerUsername,
        panel: service.panelId,
        product: title ?? service.productId,
        state: service.state,
        delivery: service.deliveryState,
        usedTrafficBytes: service.trafficUsedBytes,
        totalTrafficBytes: service.trafficLimitBytes,
        ...(service.usageSyncedAt === null ? {} : { syncedAt: service.usageSyncedAt }),
        ...(service.expiresAt === null ? {} : { expiresAt: service.expiresAt }),
        /*
         * The latest operation AND its outcome, which is what tells a planned action
         * apart from a completed one. Both words come from the frozen vocabularies, so
         * an administrator reading this message and the Web Admin screen sees the same
         * token for the same fact.
         */
        operation: latest === undefined ? '-' : `${latest.type} ${latest.state}`,
      },
      buttons: adminServiceButtons(service.id, actions, permissions),
      orderId: null,
    };
  }

  /**
   * The confirmation screen, and the only place the destructive callback is produced.
   *
   * Phase 6A, and the first ask-then-act flow the admin panel has. Terminate deletes the
   * account on somebody's panel while the customer keeps the order they paid for, so it
   * costs two taps — the same rule the customer half has held since 4E, and the reason
   * `service-management.test.ts` asserts the destructive prefix appears on no list and
   * no detail screen.
   *
   * The permission is checked again here: an administrator who reached the asking
   * callback without `services.terminate` is not shown a button they cannot press.
   */
  private async adminServiceTerminateAsk(
    scope: TenantContext,
    actor: ActorContext,
    serviceId: string,
    permissions: ReadonlySet<PermissionKey>,
  ): Promise<PendingReply> {
    if (!permissions.has(SERVICES_TERMINATE_PERMISSION)) {
      return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
    }
    let found;
    try {
      found = await this.deps.serviceAdmin.detail(scope, actor, serviceId);
    } catch {
      return { key: 'bot.admin.service_gone', values: {}, buttons: [], orderId: null };
    }
    /*
     * The verdict is read AGAIN, on the confirmation screen.
     *
     * A terminate that became illegal between the detail and this tap — the service was
     * ended by somebody else, or its panel was disabled — must not be offered a second
     * button. The write path refuses it anyway; this is the screen not promising what
     * the tap would refuse.
     */
    const verdict = found.actions.find((entry) => entry.action === 'TERMINATE');
    if (verdict === undefined || !verdict.available) {
      return { key: 'bot.admin.service_unavailable', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.admin.service_terminate_ask',
      values: {},
      buttons: [
        {
          label: { kind: 'TEMPLATE' as const, key: 'bot.admin.service_terminate_confirm_button' },
          data: `${ADMIN_SERVICE_TERMINATE_CALLBACK_PREFIX}${found.service.id}`,
        },
      ],
      orderId: null,
    };
  }

  /**
   * One action, through the SAME application method the Web Admin's button calls.
   *
   * `requestFromOperator`, `retryProvisioning` and `resendForOperator` — no parallel
   * service logic, no second audit row, no second notification. Everything that makes an
   * action safe lives in there: the permission, the legal-state check, the panel's
   * operability, the scope-activity read inside the transaction, the open-operation
   * return that makes a double tap idempotent, and the audit row naming this
   * administrator.
   *
   * The reply distinguishes the two honest outcomes and nothing else. An operation comes
   * back PLANNED, so the answer is that the request was recorded — not that it was done,
   * which is the legacy "updated" for a write whose effect has not happened. A resend
   * plans no operation and says it was sent. Anything the write path refuses is one
   * sentence: which of the four refusals it was belongs to the operational log and the
   * audit row, and an administrator's next step is the Web Admin either way.
   */
  private async adminServiceAct(
    scope: TenantContext,
    actor: ActorContext,
    intent: BotIntent,
    serviceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const key = `${idempotencyKey}:${intent.toLowerCase()}`;
    try {
      if (intent === 'ADMIN_SERVICE_RESEND') {
        await this.deps.delivery.resendForOperator(scope, actor, serviceId);
        return { key: 'bot.admin.service_resent', values: {}, buttons: [], orderId: null };
      }
      if (intent === 'ADMIN_SERVICE_RETRY') {
        await this.deps.services.retryProvisioning(scope, actor, serviceId, {
          idempotencyKey: key,
        });
        return { key: 'bot.admin.service_planned', values: {}, buttons: [], orderId: null };
      }
      const operation = ADMIN_SERVICE_OPERATIONS[intent];
      /*
       * Unreachable while the dispatch and this table name the same intents, and
       * answered rather than asserted: a non-null assertion here would turn a future
       * edit that adds an intent to one and not the other into a runtime throw, on a
       * button an administrator pressed to fix somebody's service.
       */
      if (operation === undefined) {
        return { key: 'bot.admin.service_unavailable', values: {}, buttons: [], orderId: null };
      }
      await this.deps.services.requestFromOperator(scope, actor, serviceId, operation, {
        idempotencyKey: key,
      });
      return { key: 'bot.admin.service_planned', values: {}, buttons: [], orderId: null };
    } catch (error) {
      /*
       * A refusal about the SERVICE is answered differently from a refusal about the
       * ADMINISTRATOR, and the difference is deliberate. A stale button — the state
       * moved, the panel was disabled, an operation of that type is already open — is
       * something the person can act on, so it says the action is not possible now. A
       * permission denial falls through to `adminTurn`'s single refusal, which tells
       * whoever holds the chat nothing about what exists.
       */
      if (isServiceRefusal(error)) {
        return { key: 'bot.admin.service_unavailable', values: {}, buttons: [], orderId: null };
      }
      throw error;
    }
  }

  /**
   * The customers section: a page of this tenant's customers, oldest first.
   *
   * ## Why it pages rather than bounding like the queues do
   *
   * `adminServices` is a QUEUE — the ten things needing attention — and drops its
   * `nextCursor` on the floor deliberately, because the eleventh unreconciled service is
   * not a thing an operator scrolls to. A customer list is an INVENTORY: the customer an
   * operator is looking for is as likely to be the four-hundredth as the fourth, so this
   * pages the way `adminPanels` does, through the codec that makes a keyset cursor fit
   * Telegram's 64-byte `callback_data`.
   *
   * ## And why the lookup command exists beside it
   *
   * Paging to the four-hundredth customer is forty taps. The command in the section's
   * own text takes the numeric id from a support conversation straight to the detail
   * screen, and charges `users.search` on top of `users.view` for doing it — a list of
   * a tenant's own customers and a lookup of one specific person are different
   * questions, which is why `CustomerService.list` separates them.
   *
   * ## No counts
   *
   * The rule `bot.admin.panels_section` states: a figure in this message goes stale
   * between the render and the tap. `adminSection` prints `shown of total` because an
   * administrator roster is a bounded hand-made list that is NOT paged, so its bound
   * would otherwise be silent. This one has a next-page button instead, which is the
   * same honesty by a different means.
   */
  private async adminCustomers(
    scope: TenantContext,
    actor: ActorContext,
    cursor: KeysetToken | null,
  ): Promise<PendingReply> {
    const page = await this.deps.customers.list(scope, actor, {
      limit: ADMIN_QUEUE_LIMIT,
      /*
       * The decoded token, used as this module's cursor.
       *
       * `CustomerCursor.id` is branded `UserId` and a token's is a plain string, so the
       * brand is asserted rather than parsed — deliberately, and for the reason
       * `keyset-cursor.ts` gives about accepting any UUID version: this id only ever
       * feeds a `>` comparison against `(created_at, id)`, never a lookup of a person,
       * and `decodeKeysetToken` has already guaranteed it is thirty-two hex digits in a
       * UUID's shape. Running it through `userIdSchema` would refuse a v4 row an import
       * or a restore created and end that traversal early.
       */
      cursor: cursor === null ? null : { createdAt: cursor.createdAt, id: cursor.id as UserId },
    });
    if (page.items.length === 0) {
      /*
       * Empty is empty, cursor or not.
       *
       * Reachable WITH a cursor: an operator pages forward and the last of the customers
       * was on the previous page. `bot.admin.customers_none` reads correctly in both
       * cases, because it says nobody is here rather than that nobody exists.
       */
      return { key: 'bot.admin.customers_none', values: {}, buttons: [], orderId: null };
    }

    const buttons: CustomerButton[] = page.items.map((customer) => ({
      label: { kind: 'TEXT' as const, text: adminCustomerLabel(customer) },
      data: `${ADMIN_CUSTOMER_CALLBACK_PREFIX}v:${customer.id}`,
    }));
    /*
     * The next page, appended only when the cursor ENCODES — the rule `adminPanels` and
     * the customer's own services list both state. A cursor this codec cannot carry
     * would become a button whose tap Telegram rejects, and a list that ends is the
     * safe direction.
     */
    const token = page.nextCursor === null ? null : encodeKeysetToken(page.nextCursor);
    if (token !== null) {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.admin.customers_more_button' },
        data: `${ADMIN_CUSTOMERS_CALLBACK_PREFIX}${token}`,
      });
    }
    return { key: 'bot.admin.customers_section', values: {}, buttons, orderId: null };
  }

  /**
   * One customer, by the internal id a row carries.
   *
   * An id that is unknown, malformed or another tenant's gets ONE answer — the rule
   * `bot.admin.panel_gone` states — so nobody holding an id can learn whether it names
   * anybody on this installation. `CustomerService.get` charges `users.view` BEFORE it
   * validates the id, so an administrator without the permission cannot even learn
   * whether an id is well-formed.
   */
  private async adminCustomer(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
    permissions: ReadonlySet<PermissionKey>,
  ): Promise<PendingReply> {
    let customer: CustomerRecord;
    try {
      customer = await this.deps.customers.get(scope, actor, customerId);
    } catch (error) {
      // NARROW. See `isCustomerMiss`: a denial is not a missing person, and saying so
      // is what an operator would act on.
      if (isCustomerMiss(error)) {
        return { key: 'bot.admin.customer_gone', values: {}, buttons: [], orderId: null };
      }
      throw error;
    }
    return adminCustomerReply(customer, permissions);
  }

  /**
   * The same screen, reached by the numeric Telegram id an operator quotes.
   *
   * Through `list` with its EXACT `telegramUserId` filter, which is the one way this
   * codebase asks that question — `CustomerRepository` says so in the comment where
   * `findByTelegramId` used to be, and two ways to ask one question is how two answers
   * start. The filter is exact rather than a prefix for a reason stated there too: a
   * partial match on a Telegram id is a way to enumerate them.
   *
   * A blank or unmatched argument gets the SYNTAX rather than a prompt for the missing
   * one, because a prompt that outlives its question swallows the next unrelated
   * message (INCIDENT-FIN-001). An id that matches nobody gets `customer_gone`, the
   * same single answer the row path gives.
   */
  private async adminCustomerFind(
    scope: TenantContext,
    actor: ActorContext,
    telegramUserId: string,
    permissions: ReadonlySet<PermissionKey>,
  ): Promise<PendingReply> {
    const needle = telegramUserId.trim();
    /*
     * The shape is checked HERE and the permission is NOT.
     *
     * An empty or non-numeric argument is a typing mistake, not a lookup, and answering
     * it with the syntax costs nothing and tells nobody anything: it is a fact about the
     * message that was sent, not about this installation's customers. Everything that
     * IS a fact about them — whether that id exists — goes through `list`, which charges
     * `users.view` and then `users.search` before it looks.
     */
    if (!/^\d{1,32}$/.test(needle)) {
      return { key: 'bot.admin.customer_usage', values: {}, buttons: [], orderId: null };
    }
    /*
     * NOT wrapped in a catch at all.
     *
     * `list` refuses with a permission denial or it answers; there is no "miss" it can
     * raise, because an id that matches nobody comes back as an empty page. So a
     * denial — an administrator holding `users.view` and not `users.search` — reaches
     * `adminTurn`'s single refusal, which is the same answer every other denial on this
     * surface gets and is not `customer_gone`: that sentence would tell somebody who
     * was refused permission that the person does not exist.
     */
    const page = await this.deps.customers.list(scope, actor, {
      search: { telegramUserId: needle },
      limit: 1,
    });
    const customer = page.items[0];
    if (customer === undefined) {
      return { key: 'bot.admin.customer_gone', values: {}, buttons: [], orderId: null };
    }
    return adminCustomerReply(customer, permissions);
  }

  /**
   * Blocks or unblocks one customer.
   *
   * `CustomerService.block`/`.unblock` carry every refusal this needs — the permission
   * is charged and re-checked inside the writing transaction, the scope's activity is
   * read there too, the id is validated and lower-cased before the idempotency hash, and
   * the update is CONDITIONAL on the status it expects to find. So this adds none of its
   * own and catches nothing: `adminTurn`'s single refusal answers a denial, and which
   * denial it was belongs to the audit row.
   *
   * The reply names the status the customer now HOLDS rather than the button that was
   * pressed, so a redelivered update reads as the state it found instead of claiming a
   * second change — and the buttons come from the SAME builder the read uses, so a block
   * does not leave a "block" button on the screen.
   *
   * The reason recorded is this surface's own sentence and not operator text, because
   * this surface has no prompt to collect operator text with and will not grow one.
   */
  private async adminCustomerStatus(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
    blocking: boolean,
    permissions: ReadonlySet<PermissionKey>,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const input = {
      idempotencyKey,
      customerId,
      reason: blocking ? 'Blocked from the Telegram management panel.' : null,
    };
    const updated = blocking
      ? await this.deps.customers.block(scope, actor, input)
      : await this.deps.customers.unblock(scope, actor, input);
    return {
      key: 'bot.admin.customer_status_changed',
      values: { telegramId: updated.telegramUserId, status: updated.status },
      buttons: adminCustomerReply(updated, permissions).buttons,
      orderId: null,
    };
  }

  /**
   * The administrator section: who holds Telegram access, and the two commands.
   *
   * The rows are buttons that REVOKE, which is the one thing the research found its
   * own section could do besides list and create — and the label is the administrator's
   * username plus their Telegram id, because identity here is the numeric id and a
   * reviewer needs to see which account they are removing.
   */
  private async adminSection(scope: TenantContext, actor: ActorContext): Promise<PendingReply> {
    const roster = await this.deps.telegramAdmins?.listAll(scope, actor);
    if (roster === undefined || roster.length === 0) {
      return { key: 'bot.admin.admins_none', values: {}, buttons: [], orderId: null };
    }
    /*
     * BOUNDED, and the bound is printed rather than applied silently.
     *
     * A Telegram inline keyboard has a size limit, and `create` enforces no
     * ceiling on how many administrators a tenant may hold — so mapping an
     * unbounded roster into one keyboard eventually fails the whole send, and
     * the section stops working at exactly the size where an operator most
     * needs it. Every other list on this surface bounds itself for the same
     * reason.
     *
     * What is NOT acceptable is the quiet version: a truncated roster reads
     * exactly like a complete one, and an operator who cannot find somebody
     * concludes they are not an administrator. The header carries both counts,
     * so a bound that was reached says so.
     */
    const page = roster.slice(0, ADMIN_ROSTER_LIMIT);
    return {
      key: 'bot.admin.section',
      values: { shown: page.length, total: roster.length },
      /*
       * EVERY administrator, not only the Telegram-bound ones.
       *
       * Until WP1 this listed `listBound`, which put the operator's most urgent reason
       * to open this surface out of reach: the administrator you need to disable from a
       * phone is under no obligation to have a Telegram binding, and one who had none
       * simply did not appear. `listBound` still exists and still answers a different
       * question — who can be REACHED here — which is what the receipt lane needs.
       *
       * The row carries the username and the status and nothing else. A row is a
       * button label, so it is as forwardable as the detail screen and gets the same
       * treatment: no numeric Telegram id, which belongs on the screen where the
       * revoke button that acts on it is.
       */
      buttons: page.map((entry) => ({
        label: {
          kind: 'TEXT' as const,
          text: `${entry.admin.username} — ${entry.admin.status}`,
        },
        data: `${ADMIN_ADMIN_CALLBACK_PREFIX}${entry.admin.id}`,
      })),
      orderId: null,
    };
  }

  /**
   * One administrator, and the two writes this surface may make about them.
   *
   * The roster is re-read rather than a per-administrator repository method being
   * added, and the reason is the rule rather than convenience: `management.list` is
   * the one projection that charges `admins.view`, scopes to the tenant and resolves
   * role keys, and a second read path would be a second answer to "what may be shown".
   * An administrator roster is people an operator created by hand, so the cost is a
   * bounded scan, not a table.
   *
   * An id that is unknown, another tenant's or malformed gets ONE answer — the rule
   * `bot.admin.panel_gone` states — so nobody holding an id can learn whether it names
   * anything.
   */
  private async adminAdmin(
    scope: TenantContext,
    actor: ActorContext,
    adminId: string,
    permissions: ReadonlySet<PermissionKey>,
  ): Promise<PendingReply> {
    const roster = (await this.deps.telegramAdmins?.listAll(scope, actor)) ?? [];
    const found = roster.find((entry) => entry.admin.id === adminId);
    if (found === undefined) {
      return { key: 'bot.admin.admin_gone', values: {}, buttons: [], orderId: null };
    }
    return this.adminAdminReply(found, actor, permissions);
  }

  /**
   * Activates or disables one administrator.
   *
   * `setStatus` carries every refusal this needs — the caller may not act on
   * themselves, the last remaining owner survives, an actor cannot restore more
   * privilege than they hold, the tenant is locked and the permission is re-checked
   * inside the writing transaction — so this adds none of its own and catches nothing:
   * `adminTurn`'s single refusal is what answers a denial, and which denial it was
   * belongs to the audit row.
   *
   * The reply names the STATUS the administrator now holds rather than the button that
   * was pressed. A redelivered update therefore reads as the state it found instead of
   * claiming a second change, which is the same property the target-valued callback
   * gives the tap itself.
   */
  private async adminAdminStatus(
    scope: TenantContext,
    actor: ActorContext,
    adminId: string,
    status: 'ACTIVE' | 'DISABLED',
    permissions: ReadonlySet<PermissionKey>,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const admins = this.deps.telegramAdmins;
    if (admins === undefined) {
      return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
    }
    const updated = await admins.setStatus(
      scope,
      actor,
      adminId,
      status,
      'Status changed from the Telegram management panel.',
      idempotencyKey,
    );
    return {
      key: 'bot.admin.admin_status_changed',
      values: { username: updated.admin.username, status: updated.admin.status },
      buttons: this.adminAdminReply(updated, actor, permissions).buttons,
      orderId: null,
    };
  }

  /**
   * The detail screen for one administrator, shared by the read and the write.
   *
   * ONE builder, so the buttons an operator sees after a change are the buttons the
   * new state actually offers — a second copy is how a disable leaves an "disable"
   * button on the screen.
   *
   * The status button offered is the OPPOSITE of the current status, and it is not
   * drawn at all for the caller themselves: `setStatus` refuses self-modification
   * outright, so a button there could only ever record a refusal. That is a courtesy,
   * not the enforcement — the service refuses it whether or not the button exists.
   */
  private adminAdminReply(
    entry: AdminRosterEntry,
    actor: ActorContext,
    permissions: ReadonlySet<PermissionKey>,
  ): PendingReply {
    const isSelf = actor.id === entry.admin.id;
    const mayEdit = permissions.has(ADMINS_EDIT_PERMISSION);
    const buttons: CustomerButton[] = [];
    if (mayEdit && !isSelf) {
      const next = entry.admin.status === 'ACTIVE' ? 'd' : 'a';
      buttons.push({
        label: {
          kind: 'TEMPLATE',
          key:
            entry.admin.status === 'ACTIVE'
              ? 'bot.admin.admin_disable_button'
              : 'bot.admin.admin_enable_button',
        },
        data: `${ADMIN_ADMIN_STATUS_CALLBACK_PREFIX}${next}:${entry.admin.id}`,
      });
      if (entry.admin.telegramUserId !== null) {
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.admin.revoke_button' },
          data: `${ADMIN_REVOKE_CALLBACK_PREFIX}${entry.admin.id}`,
        });
      }
    }
    buttons.push({
      label: { kind: 'TEMPLATE', key: 'bot.admin.admins_back_button' },
      data: ADMIN_SECTION_CALLBACK_PREFIX,
    });
    return {
      key: 'bot.admin.admin_detail',
      values: {
        username: entry.admin.username,
        displayName: entry.admin.displayName,
        status: entry.admin.status,
        roles: entry.roleKeys.join(', '),
        telegram: entry.admin.telegramUserId ?? '—',
      },
      buttons,
      orderId: null,
    };
  }

  /** Removes one administrator's Telegram access, by the button beside their row. */
  private async adminRevokeAccess(
    scope: TenantContext,
    actor: ActorContext,
    targetId: string,
  ): Promise<PendingReply> {
    const admins = this.deps.telegramAdmins;
    if (admins === undefined) {
      return { key: 'bot.admin.refused', values: {}, buttons: [], orderId: null };
    }
    const revoked = await admins.revoke(
      scope,
      actor,
      targetId,
      'Telegram access revoked from the management panel.',
    );
    return {
      key: 'bot.admin.revoked',
      values: { username: revoked.username },
      buttons: [],
      orderId: null,
    };
  }

  /**
   * `/link <telegram id> <username>` — gives an existing administrator Telegram access.
   *
   * TWO arguments in one message, which is what makes this a command rather than a
   * prompt: nothing is remembered between updates, so there is no window in which an
   * ordinary message can be swallowed as an answer (INCIDENT-FIN-001).
   *
   * It cannot create an administrator, and that is stated in the reply rather than
   * worked around: a Telegram-only administrator would need a row with no usable
   * password hash, and this identity model has no such shape.
   */
  private async adminLink(
    scope: TenantContext,
    actor: ActorContext,
    args: readonly string[],
  ): Promise<PendingReply> {
    const admins = this.deps.telegramAdmins;
    const telegramUserId = args[0];
    const username = args[1];
    if (admins === undefined || telegramUserId === undefined || username === undefined) {
      return { key: 'bot.admin.usage', values: {}, buttons: [], orderId: null };
    }
    const linked = await admins.link(scope, actor, {
      telegramUserId,
      username,
      reason: 'Telegram access granted from the management panel.',
    });
    return {
      key: 'bot.admin.linked',
      values: { username: linked.username },
      buttons: [],
      orderId: null,
    };
  }

  /**
   * `/role <username> <role key>` — sets an administrator's roles to one Nexa preset.
   *
   * Nexa's roles, not a second enum. The four labels the Mirza research observed are
   * expressible as presets that already exist (`owner`, `sales`, `support`,
   * `receipt_reviewer`), and `setRoles` carries the escalation rule, the last-owner
   * protection and the audit row that a Telegram-side enum would not.
   *
   * ONE role, because a keyboard-free command that took a list would be a list a
   * reviewer cannot see; the Web Admin is where a multi-role composition is edited.
   */
  private async adminRole(
    scope: TenantContext,
    actor: ActorContext,
    args: readonly string[],
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const admins = this.deps.telegramAdmins;
    const username = args[0];
    const roleKey = args[1];
    if (admins === undefined || username === undefined || roleKey === undefined) {
      return { key: 'bot.admin.usage', values: {}, buttons: [], orderId: null };
    }
    const result = await admins.setRoles(scope, actor, {
      username,
      roleKeys: [roleKey],
      reason: 'Roles set from the Telegram management panel.',
      // The update's own key, as the payment decisions pass theirs: a redelivered
      // command is answered from the store, never run twice.
      idempotencyKey,
    });
    return {
      key: 'bot.admin.roles_set',
      values: { username: result.admin.username, roles: result.roleKeys.join(', ') },
      buttons: [],
      orderId: null,
    };
  }

  /**
   * What this intent produces, as a reply that has not been sent yet.
   *
   * Every branch returns; there is no fallthrough that leaves a customer unanswered,
   * which is the failure mode the legacy bot has for anything it does not recognise.
   */
  private async act(
    scope: TenantContext,
    actor: ActorContext,
    command: BotCommand,
    customer: CustomerRecord,
    arrival: CustomerArrival,
    input: {
      readonly idempotencyKey: string;
      readonly botInstanceId: BotInstanceId;
      readonly update: unknown;
      /**
       * WHO sent it, by Telegram's numeric id.
       *
       * Carried because the management panel resolves an administrator from it, and
       * never used as a fact about a customer — `resolveFromUpdate` already turned it
       * into a row before this runs. Never a username: usernames are reassignable and a
       * customer can choose one that looks like an administrator's.
       */
      readonly telegramUserId: string;
    },
  ): Promise<PendingReply> {
    if (command.intent === 'CATALOG') return this.catalogue(scope, actor);
    if (command.intent === 'ORDER' && command.targetId !== null) {
      return this.draft(
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'CONFIRM' && command.targetId !== null) {
      return this.confirm(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'USERNAME_CUSTOM' && command.targetId !== null) {
      return this.customUsername(
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'USERNAME_AUTOMATIC' && command.targetId !== null) {
      return this.automaticUsername(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    /*
     * The one intent produced by an ordinary message, and the one place this surface
     * asks the database what an ordinary message meant.
     *
     * `args[0]` is the raw text, untouched: `isValidCustomUsername` is asked of the raw
     * input, and a surface that trimmed it first would be deciding what the customer
     * typed. `NO_WINDOW` returns the same fallback any unrecognised string has always
     * got, which is what makes routing plain text here safe.
     */
    if (command.intent === 'USERNAME_TEXT') {
      const text = command.args?.[0];
      if (text !== undefined) {
        return this.typedUsername(
          scope,
          actor,
          text,
          customer,
          input.botInstanceId,
          input.idempotencyKey,
        );
      }
    }
    if (command.intent === 'WALLET') return this.walletBalance(scope, actor, customer);
    if (command.intent === 'TOPUP_MENU') return this.topupMenu(scope);
    if (command.intent === 'TOPUP_PICK' && command.targetId !== null) {
      return this.topupPick(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'PAY_WALLET' && command.targetId !== null) {
      return this.walletPayment(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'PAY_MANUAL' && command.targetId !== null) {
      return this.manualPayment(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    /*
     * A rail with no adapter, answered rather than simulated.
     *
     * No button offers it — `paymentButtons` draws only what can be performed — so this
     * is reached by a customer holding an older message, and it is the one place that
     * answer is produced. Nothing here pretends money moved.
     */
    if (command.intent === 'PAY_GATEWAY') {
      return { key: 'bot.payment.unconfigured', values: {}, buttons: [], orderId: null };
    }
    if (command.intent === 'PAY_CANCEL_ASK' && command.targetId !== null) {
      return this.cancelPaymentAsk(scope, command.targetId, customer);
    }
    if (command.intent === 'PAY_CANCEL' && command.targetId !== null) {
      return this.cancelPayment(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'RECEIPT_UPLOAD' && command.file != null) {
      return this.submitReceipt(
        scope,
        actor,
        customer,
        input.botInstanceId,
        command.file,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'PAY_SENT' && command.targetId !== null) {
      return this.signalTransferSent(
        scope,
        actor,
        command.targetId,
        customer,
        input.botInstanceId,
        input.idempotencyKey,
      );
    }
    if (command.intent === 'ORDER_CANCEL_ASK' && command.targetId !== null) {
      return this.cancelOrderAsk(scope, command.targetId, customer);
    }
    if (command.intent === 'ORDER_CANCEL' && command.targetId !== null) {
      return this.cancelOrder(scope, actor, command.targetId, customer, input.idempotencyKey);
    }
    if (command.intent === 'SERVICE_RENEW' && command.targetId !== null) {
      return this.commercialQuote(scope, actor, customer, command.targetId, 'RENEW', null, input);
    }
    if (command.intent === 'SERVICE_ADD_TRAFFIC' && command.targetId !== null) {
      return this.addonChoice(scope, actor, customer, command.targetId, 'ADD_TRAFFIC');
    }
    if (command.intent === 'SERVICE_ADD_TIME' && command.targetId !== null) {
      return this.addonChoice(scope, actor, customer, command.targetId, 'ADD_TIME');
    }
    if (
      command.intent === 'SERVICE_BUY_TRAFFIC' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      return this.commercialQuote(
        scope,
        actor,
        customer,
        command.targetId,
        'ADD_TRAFFIC',
        command.secondaryId,
        input,
      );
    }
    if (
      command.intent === 'SERVICE_BUY_TIME' &&
      command.targetId !== null &&
      command.secondaryId != null
    ) {
      return this.commercialQuote(
        scope,
        actor,
        customer,
        command.targetId,
        'ADD_TIME',
        command.secondaryId,
        input,
      );
    }
    if (command.intent === 'SERVICE_ACTION_CONFIRM' && command.targetId !== null) {
      return this.commercialConfirm(scope, actor, customer, command.targetId, input);
    }
    if (command.intent === 'SERVICES') return this.services(scope, customer, null);
    if (command.intent === 'SERVICES_PAGE') {
      return this.services(scope, customer, command.cursor ?? null);
    }
    if (command.intent === 'SERVICE' && command.targetId !== null) {
      return this.serviceDetail(scope, actor, customer, command.targetId);
    }
    if (command.intent === 'SERVICE_RESEND' && command.targetId !== null) {
      return this.serviceResend(scope, customer, command.targetId, input);
    }
    if (command.intent === 'SERVICE_SUSPEND' && command.targetId !== null) {
      return this.serviceAction(
        scope,
        actor,
        customer,
        command.targetId,
        'SUSPEND',
        input.idempotencyKey,
      );
    }
    if (command.intent === 'SERVICE_RESUME' && command.targetId !== null) {
      return this.serviceAction(
        scope,
        actor,
        customer,
        command.targetId,
        'RESUME',
        input.idempotencyKey,
      );
    }
    if (command.intent === 'SERVICE_TERMINATE_ASK' && command.targetId !== null) {
      return this.serviceTerminateAsk(scope, customer, command.targetId);
    }
    if (command.intent === 'SERVICE_TERMINATE' && command.targetId !== null) {
      return this.serviceAction(
        scope,
        actor,
        customer,
        command.targetId,
        'TERMINATE',
        input.idempotencyKey,
      );
    }
    /*
     * The main menu rides on `/start`, and on nothing else.
     *
     * Real v0.2.0 staging acceptance is what put it here: the bot registered five
     * commands with Telegram and an ordinary customer still had to know to type a
     * slash. Telegram keeps a `ReplyKeyboardMarkup` shown until something replaces it,
     * so attaching it once — to the first message anybody ever receives — is enough,
     * and attaching it to every reply would fight the inline keyboards the contextual
     * flows use.
     *
     * A BLOCKED customer gets `bot.blocked` and NO keyboard: the reply above returns
     * before this, and drawing a menu for somebody who may not use it is the untruthful
     * surface this codebase keeps refusing.
     */
    /*
     * The management panel, and it is reached through ONE door.
     *
     * Every admin intent lands here, whoever sent it, and `adminTurn` resolves the
     * Telegram account's binding before it decides anything. A customer who crafts
     * `D:<uuid>` reaches this line, resolves to no administrator, and falls through to
     * the same unsupported-input reply below that any other unrecognised string gets.
     */
    if (ADMIN_INTENTS.has(command.intent)) {
      const reply = await this.adminTurn(scope, actor, command, input);
      if (reply !== null) return reply;
    }

    const key = replyFor(command.intent, arrival);
    /*
     * The admin row is added for a Telegram account that resolves to an administrator,
     * and the resolution is the SAME one every admin action makes. A keyboard is not
     * authority — the actions re-check — but a button nobody behind it can use is the
     * untruthful surface this codebase keeps refusing.
     */
    const menu =
      command.intent === 'START'
        ? ({
            keyboard: (await this.isAdmin(scope, actor, input)) ? 'MAIN_MENU_ADMIN' : 'MAIN_MENU',
          } as const)
        : {};
    return { key, values: {}, buttons: [], orderId: null, ...menu };
  }

  /**
   * The customer's own services: a heading and one button each.
   *
   * The same shape as the catalogue and for the same reason — `bot.service.list_heading`
   * declares no placeholders and a template is not a list renderer — so the services are
   * BUTTONS whose `callback_data` is the id. The empty case is a different KEY rather
   * than the heading with nothing under it, because an empty list reads as a failure
   * and `bot.service.list_empty` says what it actually is.
   *
   * `listForCustomer` takes the customer id from the RESOLVED customer row, never from
   * anything the update carried, so there is no id here for a modified client to change.
   */
  private async services(
    scope: TenantContext,
    customer: CustomerRecord,
    cursor: ServiceCursor | null,
  ): Promise<PendingReply> {
    const page = await this.deps.services.listForCustomer(
      scope,
      customer.id,
      SERVICES_PAGE_SIZE,
      cursor,
    );
    if (page.items.length === 0) {
      /*
       * An empty PAGE is the empty answer, cursor or not.
       *
       * Reachable with a cursor: a customer pages forward and the last of their
       * services is terminated and swept between the render and the tap. Saying they
       * have none is truthful about what this page holds and is the answer they get for
       * having none at all — the alternative, a "nothing further" sentence, is a second
       * key for a state the customer cannot act on differently.
       */
      return { key: 'bot.service.list_empty', values: {}, buttons: [], orderId: null };
    }
    const buttons: CustomerButton[] = [];
    for (const service of page.items) {
      /*
       * The label is the plan as it was SOLD, from the order's frozen snapshot.
       *
       * A service whose order snapshot cannot be read is skipped rather than labelled
       * with its id or its state: a button a customer cannot identify is a button they
       * cannot safely tap, and the id is not a name. Unreachable through any path in
       * this release — the composite foreign key requires the order — and skipped
       * rather than defaulted because every default available here is a claim about
       * what somebody bought.
       */
      const title = await this.deps.purchaseTitle(scope, service.orderId);
      if (title === null) continue;
      buttons.push({
        label: { kind: 'TEXT', text: title },
        data: `${SERVICE_CALLBACK_PREFIX}${service.id}`,
      });
    }
    if (buttons.length === 0) {
      return { key: 'bot.service.list_empty', values: {}, buttons: [], orderId: null };
    }
    /*
     * The NEXT page, when the repository says there is one.
     *
     * Phase 6A, and what it replaces is the defect this handler shipped with: the page
     * carried a `nextCursor` and this surface dropped it, so a customer with more than
     * twenty services saw twenty and was told nothing. Twenty is above any list the
     * research shows, which is why it went unnoticed and not why it was acceptable.
     *
     * The token is appended only when it ENCODES. A cursor this codec cannot carry
     * would otherwise become a button whose `callback_data` is a bare prefix, and the
     * honest answer to that is the same as having no further page: a list that ends.
     */
    const token = page.nextCursor === null ? null : encodeKeysetToken(page.nextCursor);
    if (token !== null) {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.service.list_more' },
        data: `${SERVICES_PAGE_CALLBACK_PREFIX}${token}`,
      });
    }
    return { key: 'bot.service.list_heading', values: {}, buttons, orderId: null };
  }

  /**
   * One service, as its owner sees it.
   *
   * `getForCustomer` compares ownership against the row rather than filtering the query,
   * so an id that is not theirs and an id that does not exist both arrive here as
   * `SERVICE_NOT_FOUND` — and both answer `bot.service.not_found`. Keeping them the same
   * answer is what stops this being an oracle for guessing service ids.
   *
   * The usage figure is reported WITH the moment it was read. A figure with no `asOf` is
   * a figure a customer reads as live, and `usage_synced_at` is null until the first
   * `SYNC_USAGE` succeeds — so the template gets an absent `syncedAt` rather than a
   * fabricated one, which is the whole reason that placeholder is not required.
   */
  private async serviceDetail(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    const service = await this.ownedService(scope, customer, serviceId);
    if (service === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    const title = await this.deps.purchaseTitle(scope, service.orderId);
    if (title === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }

    /*
     * The resend button is offered only when a resend would do something.
     *
     * `ProvisioningService.isDeliverable` is the authority — a live state AND a
     * subscription URL — and drawing the button otherwise would offer a customer an
     * action that answers with a refusal. Not drawing it is NOT the security control:
     * `redeliver` checks ownership against the row and `deliver` refuses a service with
     * no configuration, and both still run if somebody taps an older message.
     */
    const buttons: CustomerButton[] = ProvisioningService.isDeliverable(service)
      ? [
          {
            label: { kind: 'TEMPLATE', key: 'bot.service.resend_button' },
            data: `${SERVICE_RESEND_CALLBACK_PREFIX}${service.id}`,
          },
        ]
      : [];

    /*
     * The management buttons, offered only where tapping one would do something.
     *
     * `customerActionsFor` answers with both conditions applied: the service must be in
     * a state the operation is legal from, and the PANEL must declare the capability.
     * A 3X-UI-backed service gets an empty list, because this release cannot disable,
     * re-enable or delete a client there — and a product that draws a button it cannot
     * honour is the legacy defect this codebase keeps naming.
     *
     * Not drawing the button is not the control. `requestFromCustomer` re-checks
     * ownership, the state and the capability when the tap arrives, so a customer
     * scrolling back to an older message is refused rather than served.
     */
    for (const action of await this.deps.services.customerActionsFor(scope, service)) {
      if (action === 'SUSPEND') {
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.service.suspend_button' },
          data: `${SERVICE_SUSPEND_CALLBACK_PREFIX}${service.id}`,
        });
      }
      if (action === 'RESUME') {
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.service.resume_button' },
          data: `${SERVICE_RESUME_CALLBACK_PREFIX}${service.id}`,
        });
      }
      if (action === 'TERMINATE') {
        /*
         * The terminate button opens a QUESTION and carries the ask prefix.
         *
         * `SERVICE_TERMINATE_CALLBACK_PREFIX` is never written here, and that is the
         * confirmation step made structural rather than remembered: the only place the
         * destructive callback is produced is the confirmation screen below, so there
         * is no message anywhere in this product whose single tap ends a service.
         */
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.service.terminate_button' },
          data: `${SERVICE_TERMINATE_ASK_CALLBACK_PREFIX}${service.id}`,
        });
      }
    }

    /*
     * The commercial buttons, offered on the same terms as the management ones: the
     * state must allow it, the panel must declare the capability, AND there must be
     * something configured to sell. `availableFor` applies all three — a renewal whose
     * plan has been withdrawn, or an extra-traffic button with no package behind it, is
     * a button whose tap is a refusal.
     *
     * Each opens a QUOTE and buys nothing. There is no callback anywhere in this surface
     * that takes a customer's money in one tap, which is the same structural rule the
     * terminate confirmation follows.
     */
    for (const action of await this.deps.commercial.availableFor(scope, actor, service)) {
      if (action === 'RENEW') {
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.service.renew_button' },
          data: `${SERVICE_RENEW_CALLBACK_PREFIX}${service.id}`,
        });
      }
      if (action === 'ADD_TRAFFIC') {
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.service.add_traffic_button' },
          data: `${SERVICE_ADD_TRAFFIC_CALLBACK_PREFIX}${service.id}`,
        });
      }
      if (action === 'ADD_TIME') {
        buttons.push({
          label: { kind: 'TEMPLATE', key: 'bot.service.add_time_button' },
          data: `${SERVICE_ADD_TIME_CALLBACK_PREFIX}${service.id}`,
        });
      }
    }

    return {
      key: 'bot.service.detail',
      values: {
        productTitle: title,
        // Localised by the surface, per the placeholder's own description. The state is
        // a closed vocabulary, so this is a lookup and not a string a tenant can edit.
        state: service.state,
        usedTrafficBytes: service.trafficUsedBytes,
        totalTrafficBytes: service.trafficLimitBytes,
        ...(service.expiresAt === null ? {} : { expiresAt: service.expiresAt }),
        ...(service.usageSyncedAt === null ? {} : { syncedAt: service.usageSyncedAt }),
      },
      buttons,
      orderId: null,
    };
  }

  /**
   * A customer asking for their configuration again.
   *
   * The remedy `UNCONFIRMED` and `FAILED` were designed around: an announcement whose
   * outcome was never observed leaves a customer with nothing, and until now they had
   * no way to recover it themselves. `DeliveryService.redeliver` is what sends it —
   * through the SAME `markSendStarted` stamp and the same delivery accounting the
   * automatic lane uses, so a customer-requested send and a swept one cannot race each
   * other into two messages.
   *
   * This returns `key: null`, which `handle` reads as "nothing further to send". The
   * delivery service has already sent the subscription; a second message here would be
   * the runtime and the delivery lane both answering the same tap.
   */
  /**
   * The packages a customer may buy for one service, as buttons.
   *
   * A read and nothing else — no order, no row, no money. Each button carries the
   * service AND the package, because with no conversation state there is nowhere to
   * keep the first while the customer chooses the second, and neither can be inferred
   * from the other: they OWN the service and CHOOSE the package.
   *
   * The amount and the price are rendered from the row the operator configured, and
   * neither travels in the callback. What comes back is two identifiers.
   */
  private async addonChoice(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    kind: 'ADD_TRAFFIC' | 'ADD_TIME',
  ): Promise<PendingReply> {
    let offer;
    try {
      offer = await this.deps.commercial.offer(scope, actor, customer.id, serviceId, kind);
    } catch (error) {
      return refusal(error);
    }

    const prefix =
      kind === 'ADD_TRAFFIC'
        ? SERVICE_BUY_TRAFFIC_CALLBACK_PREFIX
        : SERVICE_BUY_TIME_CALLBACK_PREFIX;
    return {
      key: 'bot.service.addon_choice',
      values: {},
      /*
       * Unpriced rows are dropped rather than rendered at zero.
       *
       * `listOfferable` already filters them out in SQL, so this cannot fire — and it
       * is a filter rather than a `?? zero` because `catalog.ts` says an absent price
       * means unsellable and never free. A zero here would offer a customer a package
       * for nothing, which is the one way to be wrong that money cannot be taken back
       * from.
       */
      buttons: offer.addons
        .filter((addon): addon is typeof addon & { price: Money } => addon.price !== null)
        .map((addon) => ({
          label: {
            kind: 'TEMPLATE' as const,
            key: 'bot.service.addon_option' as const,
            values: {
              // A MONEY value, rendered by the catalogue with its currency. A bare
              // number is the legacy defect where one template said تومان and its twin
              // ریال for the same figure, a factor of ten apart.
              title: addon.title,
              price: addon.price,
            },
          },
          data: `${prefix}${encodeIdPair(serviceId, addon.id)}`,
        })),
      orderId: null,
    };
  }

  /**
   * The quote a customer answers: what this action buys, and what it costs.
   *
   * It writes a DRAFT order and its invoice line — both in one transaction — and
   * commits the customer to nothing. The number shown is the number the order was
   * written with, and it is never re-taken: confirming re-checks that the service and
   * the package are still eligible and leaves the price exactly as the customer saw it.
   *
   * `idempotencyKey` is the update's, so Telegram redelivering the same tap produces
   * the same draft rather than a second one.
   */
  private async commercialQuote(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    kind: 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME',
    addonId: string | null,
    input: { readonly idempotencyKey: string },
  ): Promise<PendingReply> {
    try {
      const { order } = await this.deps.commercial.draft(scope, actor, customer.id, {
        serviceId,
        kind,
        ...(addonId === null ? {} : { addonId }),
        idempotencyKey: `${input.idempotencyKey}:${kind.toLowerCase()}`,
      });
      return {
        key: 'bot.service.action_quote',
        values: {
          // The order's own line snapshot, which is what was quoted — the plan's title
          // for a renewal, the package's for a quantity purchase.
          productTitle: order.line.title,
          total: order.totals.total,
          /*
           * WHAT is being bought, beside what it costs, and from the same frozen line.
           *
           * A title is free text an operator wrote: «بسته ویژه» encodes no allowance at
           * all. This screen is the one the customer answers, so it is where the figures
           * have to be — exactly as `bot.order.summary` carries them for a product, and
           * for the same reason a product's catalogue button does not.
           */
          trafficBytes: order.line.specification.trafficBytes,
          durationDays: order.line.specification.durationDays,
        },
        buttons: [
          {
            label: { kind: 'TEMPLATE', key: 'bot.service.action_confirm_button' },
            data: `${SERVICE_ACTION_CONFIRM_CALLBACK_PREFIX}${order.id}`,
          },
        ],
        orderId: order.id,
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * The customer answering the quote: DRAFT to AWAITING_PAYMENT, then the payment
   * buttons.
   *
   * The same two steps a product purchase takes, and deliberately the same screen after
   * them — `paymentButtons` is shared, so wallet and manual transfer work on a
   * commercial order without knowing it is one.
   */
  private async commercialConfirm(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    orderId: string,
    input: { readonly idempotencyKey: string },
  ): Promise<PendingReply> {
    try {
      const order = await this.deps.commercial.confirm(scope, actor, customer.id, {
        orderId,
        idempotencyKey: `${input.idempotencyKey}:action_confirm`,
      });
      return {
        key: 'bot.order.awaiting_payment',
        values: {
          total: order.totals.total,
          ...(order.expiresAt === null ? {} : { expiresAt: order.expiresAt }),
        },
        buttons: paymentButtons(order.id, await this.deps.payments.manualTransferOffered(scope)),
        orderId: order.id,
      };
    } catch (error) {
      return refusal(error);
    }
  }

  private async serviceResend(
    scope: TenantContext,
    customer: CustomerRecord,
    serviceId: string,
    input: { readonly botInstanceId: BotInstanceId; readonly update: unknown },
  ): Promise<PendingReply> {
    const service = await this.ownedService(scope, customer, serviceId);
    if (service === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    const chatId = privateChatIdOf(input.update);
    if (chatId === null) {
      /*
       * A tap from somewhere that is not a private chat.
       *
       * Refused with the same answer as an unknown service rather than sent to the
       * chat the service was FIRST delivered to: a subscription link is a bearer
       * capability, and delivering it anywhere other than where it was asked for is
       * how one lands in a group.
       */
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    try {
      await this.deps.delivery.redeliver(scope, service, customer.id, chatId, input.botInstanceId);
      return { key: null, values: {}, buttons: [], orderId: null };
    } catch {
      /*
       * Every refusal `deliver` can produce, as one customer-facing answer.
       *
       * `SERVICE_NOT_DELIVERABLE` carries a `reason` — NO_SUBSCRIPTION, SCOPE_INACTIVE,
       * SEND_IN_PROGRESS — and its own docblock says a surface maps them to a template
       * key. They are mapped to ONE here because a customer can act on none of them
       * and because the third is a race whose honest description is "try again in a
       * moment", which is what a service that answers nothing already tells them.
       * `bot.service.provisioning` is the closest true sentence for a service that has
       * no link yet and it is NOT used, because it would be wrong for the other two.
       */
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
  }

  /**
   * The one screen between a customer and the deletion of their provider account.
   *
   * It plans nothing, writes nothing and contacts nothing. Its only job is to say what
   * is about to happen, name the service in words the customer recognises, and offer
   * the ONE button that carries the destructive prefix.
   *
   * The ability is re-checked here rather than trusted from whichever message was
   * tapped: a customer whose service has since expired, or whose panel an operator
   * disabled, is told it cannot be done instead of being shown a question whose answer
   * would be refused.
   */
  private async serviceTerminateAsk(
    scope: TenantContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<PendingReply> {
    const service = await this.ownedService(scope, customer, serviceId);
    if (service === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    const title = await this.deps.purchaseTitle(scope, service.orderId);
    if (title === null) {
      return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
    }
    const actions = await this.deps.services.customerActionsFor(scope, service);
    if (!actions.includes('TERMINATE')) {
      return { key: 'bot.service.capability_unsupported', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.service.terminate_confirm',
      values: { productTitle: title },
      buttons: [
        {
          label: { kind: 'TEMPLATE', key: 'bot.service.terminate_confirm_button' },
          data: `${SERVICE_TERMINATE_CALLBACK_PREFIX}${service.id}`,
        },
      ],
      orderId: null,
    };
  }

  /**
   * A customer asking for one of the three management actions on their own service.
   *
   * The TYPE is a literal chosen by which callback prefix matched, never parsed out of
   * the payload. That is the property worth stating: nothing a client sends can turn a
   * tap on "pause" into a terminate, because the only thing that crosses the boundary
   * is a service id.
   *
   * What this does is PLAN an operation. The provisioner claims it on its next tick and
   * calls the panel; this surface never touches a provider, which is why the reply says
   * the request was recorded rather than that it is done. Saying "your service is
   * paused" here would be a claim about somebody else's machine, made before anything
   * was asked of it.
   *
   * Every refusal `requestFromCustomer` can produce is answered BY NAME, and the
   * mapping is a closed list rather than a catch-all. `SERVICE_NOT_FOUND` is the same
   * answer an id that is not theirs gets. The other three — a state the action is not
   * legal from, a panel that cannot perform it, a tenant that has stopped — are one
   * sentence, because that sentence is true for all of them, none is the customer's to
   * fix, and telling them apart would describe an operator's panel to a customer.
   *
   * Anything ELSE is re-thrown, and that is the part worth stating. A catch-all here
   * would answer a database failure with "this action is not available for your
   * service" — a false statement about the customer's panel, made to hide an outage,
   * and indistinguishable from the three real refusals in every log this installation
   * keeps. The runtime's own error path exists for the unknown case.
   */
  private async serviceAction(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    serviceId: string,
    type: CustomerServiceOperation,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      await this.deps.services.requestFromCustomer(scope, actor, customer.id, serviceId, type, {
        idempotencyKey,
      });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND) {
        return { key: 'bot.service.not_found', values: {}, buttons: [], orderId: null };
      }
      const refusals: readonly unknown[] = [
        COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
        COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
      ];
      if (!refusals.includes(code)) throw error;
      return { key: 'bot.service.capability_unsupported', values: {}, buttons: [], orderId: null };
    }
    return { key: 'bot.service.action_requested', values: {}, buttons: [], orderId: null };
  }

  /** One of the customer's own services, or null. Never anybody else's, never a throw. */
  private async ownedService(
    scope: TenantContext,
    customer: CustomerRecord,
    serviceId: string,
  ): Promise<ServiceRecord | null> {
    try {
      return await this.deps.services.getForCustomer(scope, customer.id, serviceId);
    } catch {
      // `SERVICE_NOT_FOUND` for an id that is not theirs and one that does not exist
      // alike. Caught rather than propagated because a surface answers a customer.
      return null;
    }
  }

  /**
   * The catalogue: a heading and one button per product.
   *
   * The product list cannot be interpolated into `bot.catalog.heading` — it declares no
   * placeholders, and a template is not a list renderer. So the products are BUTTONS,
   * whose labels are the tenant's own data and whose `callback_data` is the id. That is
   * also why the empty case is a different KEY rather than the same message with nothing
   * under it: `bot.catalog.empty` says why there is nothing, and an empty list reads as
   * a failure.
   */
  private async catalogue(scope: TenantContext, actor: ActorContext): Promise<PendingReply> {
    const { items } = await this.deps.products.browse(scope, actor, CATALOG_PAGE_SIZE);
    if (items.length === 0) {
      return { key: 'bot.catalog.empty', values: {}, buttons: [], orderId: null };
    }
    const buttons: CustomerButton[] = [];
    for (const product of items) {
      // `browse` returns only priced products — that is one of its four predicates — so
      // a null price here would mean the read model had changed under this surface.
      // Skipped rather than rendered as a button with no amount, because a plan whose
      // price a customer cannot see is a plan they cannot consent to.
      if (product.price === null) continue;
      buttons.push({
        label: { kind: 'TEXT', text: product.title, amount: product.price },
        data: `${ORDER_CALLBACK_PREFIX}${product.id}`,
      });
    }
    return { key: 'bot.catalog.heading', values: {}, buttons, orderId: null };
  }

  /**
   * The summary a customer confirms, with the name their service will carry.
   *
   * One builder for every path that reaches it — the draft, the two mode buttons and
   * the typed name — because the summary is the thing the customer AGREES to, and four
   * copies of it are four chances for one of them to show a figure the order does not
   * have. `username` is omitted rather than blanked when there is none: the placeholder
   * is optional, so a body that renders it simply does not, and a body a tenant
   * overrode before this step existed is unaffected.
   */
  private orderSummary(order: OrderRecord, username: string | null): PendingReply {
    return {
      key: 'bot.order.summary',
      // From the ORDER's own snapshot, not from the product and not from the callback
      // data. `templates.ts` says so in terms: "Every figure in it comes from the price
      // quote, never from callback data."
      values: {
        productTitle: order.line.title,
        total: order.totals.total,
        durationDays: order.line.specification.durationDays,
        trafficBytes: order.line.specification.trafficBytes,
        // The CANONICAL form the allocator returned, never what the customer typed.
        ...(username === null ? {} : { username }),
      },
      buttons: [
        {
          label: { kind: 'TEMPLATE', key: 'bot.order.confirm_button' },
          data: `${CONFIRM_CALLBACK_PREFIX}${order.id}`,
        },
      ],
      orderId: order.id,
    };
  }

  /**
   * What to show once a draft exists: the summary, or the username question first.
   *
   * The question is skipped in two cases and both are deliberate. A name already
   * reserved — a redelivered tap, a customer who came back — goes straight to the
   * summary carrying it, because asking again would suggest the first answer did not
   * take. And a panel offering only RANDOM has no question to ask: one button is a tap
   * that teaches nothing, so the name is drawn and the summary shows it.
   *
   * A panel offering only CUSTOM still shows this screen rather than opening the
   * window unasked. The window makes an ordinary message mean something, and opening
   * one the customer did not ask for is the half of INCIDENT-FIN-001 that is about
   * surprise rather than duration.
   */
  private async afterDraft(
    scope: TenantContext,
    actor: ActorContext,
    order: OrderRecord,
    customer: CustomerRecord,
    botInstanceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    const step = await this.deps.orders.usernameStep(scope, actor, {
      customerId: customer.id,
      orderId: order.id,
    });
    if (step.reservation !== null) return this.orderSummary(order, step.reservation.username);
    if (step.modes.length === 0) return this.orderSummary(order, null);
    /*
     * ONE mode is not a question, whichever mode it is.
     *
     * An earlier version made an exception for CUSTOM: a single AUTOMATIC button was
     * skipped, but a single CUSTOM button was still drawn, on the reasoning that
     * opening a typing window the customer did not ask for is the surprise half of
     * INCIDENT-FIN-001. The owner overruled that, and the overruling is right — what
     * INCIDENT-FIN-001 is about is a window that outlives its question and swallows an
     * unrelated message. This window is opened BY the purchase the customer is in the
     * middle of, it names that one order, and it says in full what it is waiting for.
     *
     * What the exception actually produced was a screen offering one button, which
     * teaches the customer nothing and costs them a tap.
     */
    if (step.modes.length === 1) {
      return step.modes[0] === 'AUTOMATIC'
        ? this.automaticUsername(scope, actor, order.id, customer, idempotencyKey)
        : this.customUsername(scope, actor, order.id, customer, botInstanceId, idempotencyKey);
    }

    const buttons: CustomerButton[] = [];
    if (step.modes.includes('CUSTOM')) {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.username.custom_button' },
        data: `${USERNAME_CUSTOM_CALLBACK_PREFIX}${order.id}`,
      });
    }
    if (step.modes.includes('AUTOMATIC')) {
      buttons.push({
        label: { kind: 'TEMPLATE', key: 'bot.username.automatic_button' },
        data: `${USERNAME_AUTOMATIC_CALLBACK_PREFIX}${order.id}`,
      });
    }
    return { key: 'bot.username.choose', values: {}, buttons, orderId: order.id };
  }

  /** The installation draws a name, and the summary shows the one it drew. */
  private async automaticUsername(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const reservation = await this.deps.orders.chooseUsername(scope, actor, {
        idempotencyKey: `${idempotencyKey}:username`,
        customerId: customer.id,
        orderId,
        choice: { mode: 'AUTOMATIC' },
      });
      /*
       * The CUSTOMER's read, not the operator's. `get` charges `orders.view`, which a
       * customer turn does not hold — so it threw here AFTER the reservation had
       * committed, and the customer saw nothing at all.
       */
      const order = await this.deps.orders.orderForCustomer(scope, actor, {
        customerId: customer.id,
        orderId,
      });
      return this.orderSummary(order, reservation.username);
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * Open the typing window and state the whole rule.
   *
   * The rule is sent in FULL, once, before the customer types, which is why
   * `bot.username.invalid` names no clause: a refusal that said which rule was broken
   * would add nothing they were not already told and would turn each attempt into a
   * probe of the validator.
   */
  private async customUsername(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    botInstanceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      await this.deps.orders.beginUsernameEntry(scope, actor, {
        idempotencyKey: `${idempotencyKey}:username-entry`,
        botInstanceId,
        customerId: customer.id,
        orderId,
      });
      return { key: 'bot.username.instructions', values: {}, buttons: [], orderId };
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * An ordinary message, which is a username only if a window says so.
   *
   * `NO_WINDOW` is the answer for almost every message this bot receives, and it
   * returns the same fallback the surface has always given. That is the whole safety
   * argument for routing plain text here at all: the decision is the database's, the
   * default is unchanged, and nothing about this path can reach anything but one draft
   * order of one customer.
   */
  private async typedUsername(
    scope: TenantContext,
    actor: ActorContext,
    text: string,
    customer: CustomerRecord,
    botInstanceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const result = await this.deps.orders.submitTypedUsername(scope, actor, {
        idempotencyKey: `${idempotencyKey}:username-text`,
        botInstanceId,
        customerId: customer.id,
        text,
      });
      if (result.outcome === 'NO_WINDOW') {
        return { key: 'bot.unknown_command', values: {}, buttons: [], orderId: null };
      }
      // The customer's read. See `automaticUsername` for what `get` did here.
      const order = await this.deps.orders.orderForCustomer(scope, actor, {
        customerId: customer.id,
        orderId: result.reservation.orderId,
      });
      return this.orderSummary(order, result.reservation.username);
    } catch (error) {
      /*
       * Every refusal through the shared table, and NOTHING about the window.
       *
       * The two the customer can act on — an invalid name and a taken one — leave the
       * window OPEN, because `submitTypedUsername` closes it only for an accepted
       * name, so they type another and are answered again.
       *
       * They used to be mapped by two branches here rather than in `REFUSAL_REPLIES`,
       * which meant the same refusal arriving through the AUTOMATIC path had no entry
       * at all and `refusal` rethrew it. One table for all five is what makes the two
       * paths answer alike.
       */
      return refusal(error);
    }
  }

  /** The summary a customer confirms. Every figure comes from the ORDER, never the tap. */
  private async draft(
    scope: TenantContext,
    actor: ActorContext,
    productId: string,
    customer: CustomerRecord,
    botInstanceId: string,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const order = await this.deps.orders.createDraft(scope, actor, {
        // Suffixed, and the suffix is load-bearing. `resolveFromUpdate` already consumed
        // the bare update key in the `TELEGRAM` namespace, and presenting it again with
        // a different payload is `platform.idempotency_payload_mismatch` — the exact
        // collision `webhook.controller.ts` records for `/ping`. The update's identity is
        // still the base; this names the second command WITHIN that update.
        idempotencyKey: `${idempotencyKey}:draft`,
        customerId: customer.id,
        productId,
      });
      return this.afterDraft(scope, actor, order, customer, botInstanceId, idempotencyKey);
    } catch (error) {
      return refusal(error);
    }
  }

  /** DRAFT to AWAITING_PAYMENT, and the message that says what that means. */
  private async confirm(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const order = await this.deps.orders.confirm(scope, actor, {
        idempotencyKey: `${idempotencyKey}:confirm`,
        customerId: customer.id,
        orderId,
      });
      return {
        key: 'bot.order.awaiting_payment',
        /*
         * What is owed, until when, and — since 4C — the buttons that pay it.
         *
         * The sentence here used to say there was no way to pay, which was true when
         * this message was written and false the moment `paymentButtons` was attached
         * below. The deadline it renders is now enforced where the money moves:
         * `orderAwaitingPayment` refuses a tap after `expiresAt`, so «اعتبار تا» is a
         * fact rather than decoration on a button that worked for ever.
         *
         * `expiresAt` is required by the key's declaration, and an order that reached
         * AWAITING_PAYMENT always has one — the draft carried it. The fallback is the
         * renderer's rule rather than a guess: a missing required value throws in the
         * resolver, which is better than a customer reading a literal `{expiresAt}`.
         */
        values: {
          total: order.totals.total,
          ...(order.expiresAt === null ? {} : { expiresAt: order.expiresAt }),
        },
        buttons: paymentButtons(order.id, await this.deps.payments.manualTransferOffered(scope)),
        orderId: order.id,
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * The customer's own balance, derived from the ledger every time it is asked for.
   *
   * There is no balance column to read and no cache to go stale — `balanceOf` sums the
   * entries. `bot.wallet.balance` declares exactly one placeholder and this supplies
   * exactly that.
   */
  private async walletBalance(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    const balance = await this.deps.wallet.balanceForCustomer(scope, actor, customer.id);
    /*
     * The top-up button is drawn only when a top-up could actually be performed: at
     * least one preset amount in the selling currency, AND an enabled account to
     * transfer to. `paymentButtons` applies the same rule to the manual-transfer button
     * and for the same reason — a button that leads to a refusal is worse than no button.
     *
     * Both reads can be a moment stale, which is why the service checks again inside the
     * transaction. This decides what to DRAW; that decides what may happen.
     */
    const offered = await this.deps.payments.topupPresets(scope);
    const fundable = offered.length > 0 && (await this.deps.payments.manualTransferOffered(scope));
    return {
      key: 'bot.wallet.balance',
      values: { balance: money(balance.amountMinor, balance.currency) },
      buttons: fundable
        ? [
            {
              label: { kind: 'TEMPLATE', key: 'bot.wallet.topup_button' },
              data: TOPUP_MENU_CALLBACK_PREFIX,
            },
          ]
        : [],
      orderId: null,
    };
  }

  /**
   * The offered amounts, one button each, read when the tap arrives.
   *
   * No amount is baked into the message that drew this: a customer scrolling back to an
   * old balance and tapping gets today's presets, not the ones that were configured when
   * it was sent. The refusal when nothing is offered is the same one the service gives,
   * so a customer who taps a button that has since become unfundable is told the same
   * thing either way.
   */
  private async topupMenu(scope: TenantContext): Promise<PendingReply> {
    const presets = await this.deps.payments.topupPresets(scope);
    if (presets.length === 0 || !(await this.deps.payments.manualTransferOffered(scope))) {
      return { key: 'bot.wallet.topup_unavailable', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.wallet.topup_choose',
      values: {},
      /*
       * The label is the AMOUNT and nothing else, formatted by the messenger from the
       * money value — so the digits a customer reads on a button and the digits in the
       * invoice that follows come from one formatter. A surface may not import the
       * catalogue to format money itself; `check:boundaries` enforces that.
       */
      buttons: presets.map((preset) => ({
        label: { kind: 'AMOUNT' as const, amount: preset },
        data: `${TOPUP_PICK_CALLBACK_PREFIX}${preset.amountMinor.toString()}`,
      })),
      orderId: null,
    };
  }

  /**
   * A chosen amount becomes an invoice — the SAME invoice an order's transfer produces.
   *
   * `renderTransferInstruction` is shared, so the customer gets the structured
   * card-to-card destination, the two copy buttons and the combined
   * «پرداخت را انجام دادم | ارسال رسید» button that 5A and 5R built. A top-up has no
   * order, so nothing here names one.
   */
  private async topupPick(
    scope: TenantContext,
    actor: ActorContext,
    amountMinor: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const instruction = await this.deps.payments.requestWalletTopup(scope, actor, customer.id, {
        // Suffixed within the update's own key, the shape every other callback here uses:
        // a REDELIVERED update recomputes the same suffix, which is what makes the replay
        // answer with the payment it already created rather than a second one.
        idempotencyKey: `${idempotencyKey}:topup`,
        amountMinor: BigInt(amountMinor),
      });
      return this.transferInstruction(scope, instruction, null);
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * Paying for an order from the wallet. The tap carries the ORDER ID AND NOTHING ELSE.
   *
   * Every figure that decides how much money moves is read by the service inside the
   * transaction that moves it — the amount and currency from the order's frozen
   * snapshot, the owner from the order row, the state by the conditional UPDATE. Nothing
   * this surface passes could change any of them: it has an id and a customer, and the
   * customer comes from the resolved Telegram user rather than from the tap.
   *
   * The success reply is `bot.order.settled`, which says the payment was confirmed and
   * the order is paid. It does NOT say a service is being prepared, because nothing in
   * this release prepares one.
   */
  private async walletPayment(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const { order } = await this.deps.payments.settleFromWallet(scope, actor, customer.id, {
        // Suffixed within the update's own key, the shape `draft` and `confirm` use: the
        // bare key was consumed by `resolveFromUpdate`, and presenting it again with a
        // different payload is an idempotency payload mismatch. A REDELIVERED update
        // recomputes this same suffix, which is what makes the replay produce one debit.
        idempotencyKey: `${idempotencyKey}:wallet-pay`,
        orderId,
      });
      return {
        key: 'bot.order.settled',
        values: {},
        buttons: [],
        orderId: order.id,
        ...followUpForSettlement(order.purpose),
      };
    } catch (error) {
      /*
       * Insufficient funds is answered HERE rather than through `REFUSAL_REPLIES`,
       * because the reply needs the shortfall and that map carries no values.
       *
       * The shortfall comes from the ERROR's detail, which the service computed from the
       * ledger inside its transaction — not recomputed here, which would be a second
       * statement of the same subtraction reading a balance from a different moment.
       *
       * What is deliberately NOT offered: a top-up for the difference. That would need a
       * standalone top-up with an authoritative amount, and `docs/phase4c-audit.md`
       * records why there is none — combining a shortfall with a configured minimum is a
       * financial product rule no contract states. The customer is told what is missing
       * and left to act on it.
       */
      if (isNexaError(error) && error.code === COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS) {
        const shortfall = shortfallOf(error.details);
        if (shortfall !== null) {
          return {
            key: 'bot.wallet.insufficient',
            values: { shortfall },
            buttons: [],
            orderId,
          };
        }
      }
      return refusal(error);
    }
  }

  /**
   * Choosing to pay out of band: a PENDING payment, WHERE to send the money, and the
   * code to quote.
   *
   * No money moves and nothing settles. Every figure comes from what the service
   * committed — the total from the order's frozen snapshot, the reference GENERATED
   * because a customer who could choose it could choose somebody else's, and the bank
   * details from `payment_destinations`, which was written in the same transaction as
   * the payment and can never be edited afterwards.
   *
   * That last one is the whole of 5A. Before it, this message said «طبق راهنمای
   * فروشنده» — follow the seller's instructions — and the only place an operator could
   * put a card number was inside an overridden copy of this very template, where editing
   * it rewrote what every already-issued instruction said.
   *
   * A payment issued BEFORE 5A has no snapshot, and falls back to the old key. That is
   * not a lesser rendering of the same thing: it is the only thing this installation can
   * truthfully say about a payment whose destination was never recorded.
   */
  private async manualPayment(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const instruction = await this.deps.payments.requestManualTransfer(
        scope,
        actor,
        customer.id,
        { idempotencyKey: `${idempotencyKey}:manual-pay`, orderId },
      );
      return this.transferInstruction(scope, instruction, orderId);
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * The transfer invoice, rendered once for every payment that needs one.
   *
   * Shared by the order path and the wallet top-up path — the owner's 5B instruction is
   * to reuse this UX rather than build a second one, and sharing the FUNCTION is what
   * makes that structural: a change to the destination block, the copy buttons or the
   * receipt button reaches both, and neither can drift into telling a customer something
   * the other does not.
   *
   * `orderId` is null for a top-up. It travels on the reply rather than being read off
   * the payment because the messenger uses it for correlation, and a top-up correlates
   * to no order.
   */
  private async transferInstruction(
    scope: TenantContext,
    { payment, destination }: ManualTransferInstruction,
    orderId: string | null,
  ): Promise<PendingReply> {
    /*
     * The two copy controls, and they exist only when there is a snapshot to copy from.
     *
     * `copy_text` is Telegram's own clipboard button: no callback data, no handler,
     * nothing reaches this server when one is tapped. The amount is copied as BARE
     * digits — `plainAmount`, not `formatMoney` — because a banking app rejects
     * «۱٬۵۰۰٬۰۰۰ تومان` and accepts `1500000`.
     *
     * `row: 0` puts them side by side above the actions, which is the layout the owner
     * specified after staging acceptance.
     */
    const copies: CustomerButton[] =
      destination === null
        ? []
        : [
            {
              label: { kind: 'TEMPLATE', key: 'bot.payment.copy_card_button' },
              copyText: destination.cardNumber,
              row: 0,
            },
            {
              label: { kind: 'TEMPLATE', key: 'bot.payment.copy_amount_button' },
              copyText: plainAmount(payment.amount),
              row: 0,
            },
          ];

    return {
      key:
        destination === null
          ? 'bot.payment.manual_instructions'
          : 'bot.payment.transfer_instructions',
      values: {
        total: payment.amount,
        reference: payment.reference,
        /*
         * Composed behind the application layer, by the renderer this surface is
         * handed. A surface may not resolve the catalogue — `check-boundaries.sh`
         * refuses an `@nexa/i18n` import here — and the four destination lines are
         * catalogue text like any other.
         */
        ...(destination === null
          ? {}
          : { destination: await this.deps.destinations.render(scope, destination) }),
      },
      /*
       * The way out, beside the instructions that created the obligation.
       *
       * It names the PAYMENT rather than the order, which is the only id here that
       * identifies what a withdrawal would close: an order can have had several
       * payments over its life, and this message is about one of them.
       *
       * It carries the ASK prefix. Tapping it closes nothing — it answers with a
       * question and one further button — because this message stays in the chat for
       * ever and a customer who has already transferred the money is one mis-touch
       * away from closing the payment it was against.
       */
      buttons: [
        ...copies,
        /*
         * The step the instructions now tell them to take.
         *
         * The Persian used to end «سپس رسید را ارسال نمایید» — send the receipt — and
         * no surface in this product accepts one (owner revision 17). So a customer
         * who had transferred the money had nothing to do and nothing to say, and
         * `bot.payment.received_for_review` was a frozen sentence with no producer.
         *
         * The owner's 5A addendum reverses that revision and asks for this label to
         * become «✅ پرداخت را انجام دادم | ارسال رسید», which is what 5R made it: one
         * button whose tap records the claim AND opens the upload window. The label is
         * a template key, so the catalogue carries the wording and this carries the
         * intent.
         *
         * First among the actions, before the withdrawal: it is what most customers
         * who come back to this message want, and the destructive one should not be
         * the nearest thumb.
         */
        {
          label: { kind: 'TEMPLATE', key: 'bot.payment.sent_button' },
          data: `${PAY_SENT_CALLBACK_PREFIX}${payment.id}`,
        },
        {
          label: { kind: 'TEMPLATE', key: 'bot.payment.cancel_button' },
          data: `${CANCEL_PAY_ASK_CALLBACK_PREFIX}${payment.id}`,
        },
      ],
      orderId,
    };
  }

  /**
   * Withdrawing a pending transfer the customer decided not to make.
   *
   * The button that reaches this is attached to `bot.payment.manual_instructions` — the
   * message that gave them the reference — so it sits beside the thing it undoes. That
   * message lives in the chat for ever, which is exactly why the service re-reads the
   * state rather than trusting the tap: a customer scrolling back to it a week later
   * gets `bot.payment.not_pending`, not a second withdrawal of something already closed.
   *
   * The reply does NOT say the order is gone, because it is not: a withdrawal closes the
   * payment and leaves the order open until its own deadline, so the customer may pay
   * from their wallet instead. `bot.payment.cancelled` says so.
   */
  /**
   * The question between the cancel button and the withdrawal.
   *
   * It writes nothing and closes nothing. Its only job is to say what is about to
   * happen and offer the ONE button that carries the destructive prefix —
   * `serviceTerminateAsk` is the same shape one aggregate over.
   *
   * The payment is re-read here rather than trusted from whichever message was tapped:
   * a customer whose payment an operator has since rejected, or the sweep has expired,
   * is told it is no longer pending instead of being shown a question whose answer
   * would be refused.
   */
  private async cancelPaymentAsk(
    scope: TenantContext,
    paymentId: string,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    const payment = await this.deps.payments.pendingTransferForCustomer(
      scope,
      customer.id,
      paymentId,
    );
    if (payment === null) {
      return { key: 'bot.payment.not_pending', values: {}, buttons: [], orderId: null };
    }
    return {
      key: 'bot.payment.cancel_confirm',
      values: {},
      buttons: [
        {
          label: { kind: 'TEMPLATE', key: 'bot.payment.cancel_confirm_button' },
          data: `${CANCEL_PAY_CALLBACK_PREFIX}${payment.id}`,
        },
      ],
      orderId: null,
    };
  }

  private async cancelPayment(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      await this.deps.payments.withdrawPending(scope, actor, customer.id, {
        idempotencyKey: `${idempotencyKey}:cancel-pay`,
        paymentId,
      });
      return { key: 'bot.payment.cancelled', values: {}, buttons: [], orderId: null };
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * The customer saying they have sent the transfer, AND asking to send its receipt.
   *
   * ONE tap for both, which is what the Payment UX addendum fixes: the button reads
   * «✅ پرداخت را انجام دادم | ارسال رسید» and `signalTransferSent` stamps the claim
   * and opens the upload window in the same transaction. Two buttons would be two ways
   * to reach one action, and a customer who pressed only the first would have a window
   * open with no idea it was there.
   *
   * It still moves no money and no state. `bot.payment.receipt_prompt` says exactly
   * what is true — the claim is recorded, nothing has been received or verified, and
   * the file may be sent now — and the caution `bot.payment.received_for_review`
   * carries applies to it word for word.
   *
   * Two replies, because `receiptWindow` is genuinely null in two cases: a redelivered
   * tap whose window has since closed, and a payment already past its own deadline,
   * where asking for evidence nobody can act on would be the wrong thing to do. Those
   * get the older sentence, which is true without promising an upload.
   *
   * No button on either. The instructions message above still carries both, which is
   * where a customer who wants to withdraw after all will look — and re-offering "I
   * have sent it" under a message saying it is recorded invites a second tap.
   */
  private async signalTransferSent(
    scope: TenantContext,
    actor: ActorContext,
    paymentId: string,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const { receiptWindow } = await this.deps.payments.signalTransferSent(
        scope,
        actor,
        customer.id,
        { idempotencyKey: `${idempotencyKey}:pay-sent`, paymentId, botInstanceId },
      );
      if (receiptWindow === null) {
        return {
          key: 'bot.payment.received_for_review',
          values: {},
          buttons: [],
          orderId: null,
          fallback: { kind: 'PAYMENT_TRANSFER_RECORDED', subjectId: paymentId },
        };
      }
      return {
        key: 'bot.payment.receipt_prompt',
        /*
         * A NUMBER, not a string. `minutes` is declared `type: 'NUMBER'`, and the
         * resolver VALIDATES values against the declaration — a string refused the
         * whole render, which the webhook then swallowed: the claim committed and the
         * customer was told nothing at all after tapping the button.
         */
        values: { minutes: receiptWindow.minutes },
        buttons: [],
        orderId: null,
        /*
         * The fallback is the CLAIM, not the prompt.
         *
         * `PAYMENT_TRANSFER_RECORDED` is what the notification lane can say, and it is
         * the half that matters when the interactive reply could not be delivered: a
         * customer who does not learn their claim is on record sends the money again.
         * Asking for a receipt through a lane whose messages arrive minutes later
         * would ask for one after the window it names had closed.
         */
        fallback: { kind: 'PAYMENT_TRANSFER_RECORDED', subjectId: paymentId },
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * A file the customer sent while a window was open for them.
   *
   * What it attaches to is decided by the WINDOW, never by anything in the update: the
   * row names one payment, and `ReceiptService` re-reads that payment's state and owner
   * inside the transaction that files the row. So a client that invents a file reaches a
   * payment only if a window for that customer on that bot is genuinely open, and a
   * customer who sends a screenshot at random is told nothing was expected.
   *
   * `filed === false` gets the SAME reply as a new row. That is Telegram redelivering an
   * update whose file is already on the payment; the customer's situation is identical
   * either way, and a different sentence for a retry they cannot see would be a
   * difference they cannot act on.
   *
   * No fallback. The notification lane's kinds are a closed set with no payload, and
   * there is no frozen kind that means "your receipt arrived" — inventing one to cover
   * a failed interactive send is what ADR-0030 §1 refuses. A customer whose reply was
   * lost sees their receipt on the invoice thread and may tap the button again.
   */
  private async submitReceipt(
    scope: TenantContext,
    actor: ActorContext,
    customer: CustomerRecord,
    botInstanceId: BotInstanceId,
    file: InboundReceiptFile,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      const result = await this.deps.receipts.submit(scope, actor, customer.id, {
        idempotencyKey: `${idempotencyKey}:receipt`,
        botInstanceId,
        file,
      });
      /*
       * The reviewers are poked AFTER the receipt is filed, and only for a NEW row
       * (Phase 5T).
       *
       * `filed === false` is Telegram redelivering an update whose file is already on
       * the payment, and a second poke for one receipt is a reviewer opening the queue
       * to find what they already saw. The lane's dedupe key makes that harmless; not
       * sending it makes it absent.
       *
       * The poke cannot fail this turn, and that is enforced in TWO places rather than
       * asserted once. The composition root catches and logs, because it owns the
       * transaction; this `catch` is the surface's own guarantee, because the call sits
       * inside the try whose handler is `refusal` — and `refusal` RETHROWS anything it
       * has no reply for. Without it a database error while telling reviewers would
       * have cost the customer the acknowledgement for a receipt already committed, and
       * Telegram's redelivery answers `filed: false`, which skips the poke for ever.
       */
      if (result.filed) {
        try {
          await this.deps.notifyReviewers?.(scope, result.paymentId);
        } catch {
          // Deliberately not rethrown and deliberately not reported from here: the
          // container logs it, the queue in the panel is the durable record, and the
          // customer's answer is about their receipt rather than about our plumbing.
        }
      }
      return { key: 'bot.payment.receipt_received', values: {}, buttons: [], orderId: null };
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * The question between the cancel-order button and the cancellation.
   *
   * `cancelPaymentAsk` one aggregate over is the same shape and states the reasons: it
   * writes nothing, it offers the ONE button carrying the destructive prefix, and it
   * re-reads rather than trusting whichever message was tapped.
   *
   * The re-read goes through `awaitingPaymentForCustomer`, NOT `orders.get`. That one
   * is the operator's read and checks `orders.view`, which this turn does not hold —
   * a job actor holds `maintenance.run` and nothing else (see the job permission list
   * in `packages/contracts/src/permissions.ts`, named there rather than here because
   * `check:boundaries` refuses a surface that so much as mentions it) — so the first
   * version of this method refused every customer who tapped the button. Nothing
   * asserting only that the BUTTON was drawn would have noticed.
   *
   * Ownership and state are both compared against the ROW, so a customer holding
   * somebody else's order id is answered exactly as one holding an id that does not
   * exist. The cancellation re-checks both inside its own transaction; this check is
   * about not drawing a question, not about authorization.
   */
  private async cancelOrderAsk(
    scope: TenantContext,
    orderId: string,
    customer: CustomerRecord,
  ): Promise<PendingReply> {
    try {
      const order = await this.deps.orders.awaitingPaymentForCustomer(scope, customer.id, orderId);
      if (order === null) {
        return { key: 'bot.order.not_awaiting_payment', values: {}, buttons: [], orderId: null };
      }
      return {
        key: 'bot.order.cancel_confirm',
        values: {},
        buttons: [
          {
            label: { kind: 'TEMPLATE', key: 'bot.order.cancel_confirm_button' },
            data: `${CANCEL_ORDER_CALLBACK_PREFIX}${order.id}`,
          },
        ],
        orderId: order.id,
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /**
   * The customer withdrawing their own unpaid order.
   *
   * `ORDER_MACHINE`'s `CANCEL` edge reaching a surface at last —
   * `docs/phase4h-audit.md` §3 measured that 4G made it writable and left it with no
   * caller, and `bot.order.cancelled` a frozen sentence with nowhere to be sent from.
   *
   * The reply says the ORDER is gone and says nothing about a payment, although the
   * service withdrew any pending transfer in the same transaction. That is not an
   * omission: a customer who reaches this has been told about the order, which is the
   * thing they acted on, and a second sentence about a reference they were about to
   * stop using is noise. The refusal when they HAVE claimed to pay is the case where
   * the payment matters, and it has its own key.
   */
  private async cancelOrder(
    scope: TenantContext,
    actor: ActorContext,
    orderId: string,
    customer: CustomerRecord,
    idempotencyKey: string,
  ): Promise<PendingReply> {
    try {
      await this.deps.orders.cancelByCustomer(scope, actor, {
        idempotencyKey: `${idempotencyKey}:cancel-order`,
        customerId: customer.id,
        orderId,
      });
      return {
        key: 'bot.order.cancelled',
        values: {},
        buttons: [],
        orderId: null,
        // The order is gone. A customer who does not learn that keeps waiting for
        // a service that will never be made.
        fallback: { kind: 'ORDER_CANCELLED', subjectId: orderId },
      };
    } catch (error) {
      return refusal(error);
    }
  }

  /** Best effort, after the answer, and never allowed to fail the turn. */
  private async stopSpinner(
    scope: TenantContext,
    command: BotCommand,
    botInstanceId: BotInstanceId,
  ): Promise<void> {
    if (command.callbackQueryId === null) return;
    await this.deps.messenger.acknowledge(scope, {
      callbackQueryId: command.callbackQueryId,
      botInstanceId,
    });
  }
}

/**
 * What follows `bot.order.settled`, if anything.
 *
 * A pure function of the ORDER PURPOSE, exported for the same reason `replyFor` is:
 * the decision is testable without a database or a Telegram server, and a rule that
 * can only be reached through a webhook is a rule the suite cannot distinguish from
 * its absence. It could be: no test in this repository settles a RENEW over Telegram,
 * so an unconditional follow-up stayed green until this function existed.
 *
 * `NEW_SERVICE` is the only purpose that PROVISIONS. `orderPurposeTargetsExistingService` states
 * the same rule from the other side and `COMMERCIAL_ORDER_PURPOSES` derives itself by
 * exclusion, so a purpose added without thought lands on the safe side — as one that
 * does not provision. A renewal settles and CHANGES a service that already exists;
 * telling that customer their service is being created describes something that is not
 * happening, and they would then wait for a link that is never coming because they
 * already have it.
 *
 * The three commercial purposes are not silent either: they answer with
 * `bot.service.action_requested` through their own path, and 4H's outcome announcer
 * tells them how it turned out.
 */
export function followUpForSettlement(purpose: OrderPurpose): {
  readonly followUpKey?: TemplateKey;
} {
  return purpose === 'NEW_SERVICE' ? { followUpKey: 'bot.service.provisioning' } : {};
}

/**
 * Which template answers this turn.
 *
 * A pure function of the intent and the arrival, so the decision is testable without a
 * database or a Telegram server — and so the blocked case cannot be forgotten by one
 * branch. BLOCKED wins over everything: a blocked customer gets the block message
 * whatever they asked for, because every other answer is a service they are not
 * entitled to.
 *
 * `UNSUPPORTED` for an ACTIVE customer gets the existing `bot.unknown_command`, which
 * Phase 1 already declared — a new key for the same sentence would be a second string to
 * keep in step.
 */
export function replyFor(intent: BotIntent, arrival: CustomerArrival): TemplateKey | null {
  if (arrival === 'BLOCKED') return 'bot.blocked';
  if (intent === 'START') {
    return arrival === 'FIRST_SEEN' ? 'bot.start.welcome' : 'bot.start.welcome_back';
  }
  if (intent === 'HELP') return 'bot.help';
  return 'bot.unknown_command';
}

/** Re-exported so the controller need not know the record shape to log an outcome. */
export type { CustomerRecord };

/**
 * The payment methods this installation can actually perform RIGHT NOW, as buttons.
 *
 * `WALLET` always, `MANUAL_TRANSFER` only when the tenant has an enabled destination. A
 * gateway button is NOT drawn, and that is the rule `provider.ts` records applied to
 * money: Marzban's descriptor advertising fourteen operations no code could perform was
 * rejected, because what a product publishes is how it tells a user what it can do.
 *
 * Each button carries the ORDER ID and nothing else. There is no amount in a callback
 * and no place to put one.
 */
function paymentButtons(orderId: string, manualAvailable: boolean): readonly CustomerButton[] {
  return [
    {
      label: { kind: 'TEMPLATE', key: 'bot.payment.wallet_button' },
      data: `${WALLET_PAY_CALLBACK_PREFIX}${orderId}`,
    },
    /*
     * Drawn only when there is somewhere for the money to go.
     *
     * Since 5A a manual transfer is refused outright when the tenant has no enabled
     * account — `PAYMENT_DESTINATION_UNCONFIGURED` — so a button drawn regardless would
     * be a button whose only outcome is an error. That is the rule stated two lines
     * below for a gateway, applied to the rail that CAN be unconfigured.
     *
     * The read can be a moment stale: the last enabled account may be disabled between
     * this render and the tap. The service refuses that case, which is why the check
     * exists in both places rather than only here.
     */
    ...(manualAvailable
      ? [
          {
            label: { kind: 'TEMPLATE' as const, key: 'bot.payment.manual_button' as const },
            data: `${MANUAL_PAY_CALLBACK_PREFIX}${orderId}`,
          },
        ]
      : []),
    /*
     * The way out, beside the two ways in.
     *
     * Before 4H a customer who changed their mind had exactly one option — never pay —
     * and the order sat `AWAITING_PAYMENT` until a sweep expired it, which is the state
     * `docs/phase4h-audit.md` §3 records as the CANCEL edge having no caller at all.
     *
     * It carries the ASK prefix. Tapping it closes nothing: this message stays in the
     * chat for ever and `ORDER_MACHINE` has no edge out of CANCELLED, so a mis-touch
     * would take the customer's quoted price with it.
     */
    {
      label: { kind: 'TEMPLATE', key: 'bot.order.cancel_button' },
      data: `${CANCEL_ORDER_ASK_CALLBACK_PREFIX}${orderId}`,
    },
  ];
}

/**
 * The shortfall the service put on the refusal, or null.
 *
 * Parsed rather than cast, because `details` is `Record<string, unknown>` and a template
 * that declares a MONEY placeholder will refuse a string. Returning null on anything
 * unexpected sends the customer the generic refusal instead of a message with a hole in
 * it — the shortfall is a number they act on, and a wrong one is worse than none.
 */
function shortfallOf(details: Record<string, unknown> | undefined): Money | null {
  const minor = details?.shortfallMinor;
  const currency = details?.currency;
  if (typeof minor !== 'string' || !/^\d{1,19}$/u.test(minor)) return null;
  const parsed = currencyCodeSchema.safeParse(currency);
  if (!parsed.success) return null;
  return money(BigInt(minor), parsed.data);
}
