// The closed intent vocabulary and the command shape the runtime dispatches on.
// Moved verbatim out of bot-runtime.ts, which still re-exports every name it exported.
import type { Money } from '@nexa/contracts';
import type { InboundReceiptFile } from '../../../modules/commerce/payments/application/receipt-ports.js';
import type { KeysetToken } from '../keyset-token.js';
import type { InboundTutorialVideo } from '../../../modules/control/client-apps/application/client-app-video.service.js';
import { ADMIN_TUTORIAL_INTENTS } from '../admin-tutorial-video.js';

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
  /*
   * The two levels of the categorised catalogue (WP5, OQ-4B-01).
   *
   * Their own intents rather than `CATALOG` with an optional payload, for the reason
   * `SERVICES_PAGE` states: `CATALOG` arrives from a command or the main-menu keyboard
   * carrying nothing, and these carry a PAGE NUMBER the boundary validates before any
   * handler sees it. `CATEGORY` also carries the category's id.
   */
  'CATALOG_PAGE',
  'CATEGORY',
  /*
   * R11 A11: «🔁 سفارش دوباره» under an expired or cancelled order — the order's category's
   * product list, as a NEW message. Its own intent rather than `CATEGORY`, which is gated to a
   * message still showing the catalogue: the button sits on an ENDED order's closed screen.
   * Read-only: nothing is drafted until a plan is tapped, and nothing ordered until confirmed.
   */
  'REORDER_CATEGORY',
  /*
   * Take a free trial (WP6-A; R1). Carries nothing: which panels offer one, the limit and
   * the panel are all decided on the server when the tap arrives — straight to the claim
   * when one panel offers a trial, to a choice when several do.
   */
  'TRIAL_CLAIM',
  /*
   * R1: the customer chose a panel on the trial choice. Carries the panel's id; whether
   * that panel still offers a trial is decided again under the customer's lock.
   */
  'TRIAL_PANEL',
  /*
   * Package D — the custom service. MENU carries nothing and lists the locations decided
   * on the server; LOCATION carries the panel's id and opens the volume window. The
   * figures themselves arrive as `USERNAME_TEXT` and are read by their capture windows.
   */
  'CUSTOM_SERVICE_MENU',
  'CUSTOM_SERVICE_LOCATION',
  'ORDER',
  'CONFIRM',
  'WALLET',
  'PAY_WALLET',
  'PAY_MANUAL',
  'PAY_GATEWAY',
  /*
   * «🧾 ثبت پرداخت» opens the route selector for an order, and «❌ بستن لیست» closes it.
   * Both name the order and write nothing; the route buttons inside are the taps that pay.
   */
  'PAY_METHODS',
  'PAY_METHODS_CLOSE',
  /* WP11A: the customer asks what became of an external-gateway attempt. Names the payment. */
  'GATEWAY_CHECK',
  /*
   * Round 6 item 6: the customer returns from TetraPay's page through the bot's own
   * `/start tp-<payment id>` link. Names the payment and nothing else - the status shown is
   * always read from the payment, never from anything the link carried (`?status=` is not read).
   */
  'GATEWAY_RETURN',
  /*
   * TonPays Telegram (§8.1): «📤 ارسال فیش واریزی» opens the payment-scoped receipt window,
   * «🔄 تعویض کارت» asks for another card. Each names the PAYMENT and nothing else.
   */
  'GATEWAY_RECEIPT',
  'GATEWAY_CARD_CHANGE',
  /*
   * Round 6 (TonPays Telegram): «❌ لغو فاکتور» asks first and then records a cancel request,
   * and «💳 ثبت کارت بازگشت وجه» opens the refund-card prompt of an overpaid invoice. Each names
   * the PAYMENT and nothing else; the provider is called by the worker, never from the tap.
   */
  'GATEWAY_CANCEL_ASK',
  'GATEWAY_CANCEL',
  'GATEWAY_REFUND_CARD',
  'PAY_CANCEL_ASK',
  'PAY_CANCEL',
  'PAY_SENT',
  /* R4 A1: the card-to-card invoice's card-switch button. Names the payment and a sequence. */
  'PAY_SWITCH_CARD',
  'TOPUP_MENU',
  'TOPUP_PICK',
  /* R10 D4: start redeeming a gift card. Carries nothing; the feature is read on the tap. */
  'GIFT_CARD',
  /*
   * The customer's own referral link (WP9 F12). Carries nothing: whose link, and whether
   * the program is running at all, are decided on the server when the tap arrives.
   */
  'REFERRAL_INVITE',
  'ORDER_CANCEL_ASK',
  /* R12 F3 item 7: the wallet's last movements, a page at a time (`wh:` + optional keyset token). */
  'WALLET_HISTORY',
  /*
   * R12 F3 item 2: leaving a typed-input prompt. INPUT_BACK names the order whose pre-invoice
   * is drawn again; INPUT_CANCEL goes to the main menu; CUSTOM_SERVICE_BACK to the locations.
   * Each closes the customer's open text window first and writes nothing else.
   */
  'INPUT_BACK',
  /* R12 F3 item 9: the status of the live payment an order past its deadline is waiting on. */
  'ORDER_PAYMENT_STATUS',
  'INPUT_CANCEL',
  'CUSTOM_SERVICE_BACK',
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
  /** Package E: the panel's ready-made connection files, sent as documents. */
  'SERVICE_FILES',
  /*
   * B8: `SERVICE_SUSPEND` / `SERVICE_RESUME` (`u:` / `e:`) only ASK; the two confirms are
   * the only taps that plan the operation.
   */
  'SERVICE_SUSPEND',
  'SERVICE_RESUME',
  'SERVICE_SUSPEND_CONFIRM',
  'SERVICE_RESUME_CONFIRM',
  'SERVICE_TERMINATE_ASK',
  'SERVICE_TERMINATE',
  /* WP6-C: a customer's own link rotation, ask then confirm. */
  'SERVICE_ROTATE_ASK',
  'SERVICE_ROTATE',
  /*
   * WP19: a customer's refund request for a service. ASK shows what would happen and
   * writes nothing; CONFIRM opens the reason capture. The request is filed by the reason.
   */
  'SERVICE_REFUND_ASK',
  'SERVICE_REFUND_CONFIRM',
  /*
   * Package F: a customer hands a service to another customer. ASK opens the window that
   * reads the recipient's id and moves nothing; CONFIRM names the service AND the
   * recipient's id, both read again by the transfer, and is the only tap that moves one.
   */
  'SERVICE_TRANSFER_ASK',
  'SERVICE_TRANSFER_CONFIRM',
  /*
   * Round 10, D1: «تمدید خودکار». ASK names the amount and records nothing; CONFIRM is the
   * only tap that records the consent; OFF switches it off at once.
   */
  'SERVICE_AUTO_RENEW_ASK',
  'SERVICE_AUTO_RENEW_CONFIRM',
  'SERVICE_AUTO_RENEW_OFF',
  'SERVICE_RENEW',
  'SERVICE_ADD_TRAFFIC',
  'SERVICE_ADD_TIME',
  'SERVICE_BUY_TRAFFIC',
  'SERVICE_BUY_TIME',
  /* WP-A5: open the extra-users offer (`dv:`), and buy a chosen quantity (`dq:`). */
  'SERVICE_ADD_DEVICES',
  'SERVICE_BUY_DEVICES',
  /*
   * WP-A6: open the location change (`lc:`), choose a target (`lt:`), and confirm a FREE
   * move (`lf:`). A priced target goes on to the ordinary pre-invoice and `q:`.
   */
  'SERVICE_CHANGE_LOCATION',
  'SERVICE_LOCATION_TARGET',
  'SERVICE_LOCATION_CONFIRM',
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
  /*
   * WP8 P11 — a discount code on a new-purchase draft. ENTER opens the window in which
   * the customer's next plain message is read as a code; REMOVE re-quotes the draft
   * without one. The typed code itself arrives as `USERNAME_TEXT` and is offered to the
   * code window only after the username window has said it is not open — at most one
   * of the two is ever open, because opening either closes the other.
   */
  'DISCOUNT_CODE_ENTER',
  'DISCOUNT_CODE_REMOVE',
  /*
   * The customer UX completion (docs/customer-ux-completion-audit.md). Every one is a
   * callback that names an id or nothing; the screens they open re-read every fact.
   */
  'MAIN_MENU',
  'TUTORIAL',
  'TUTORIAL_PLATFORM',
  /*
   * WP-A10: one of the tenant's client apps, opened from a platform's list. Carries the
   * entry's id; the screen re-reads the entry, and a disabled or removed one is "gone".
   * `TUTORIAL` itself is also what `/apps` and «📱 دانلود برنامه و آموزش اتصال» open.
   */
  'CLIENT_APP',
  'SERVICE_CONNECTED',
  'SUPPORT',
  'TOPUP_ROUTE',
  'TOPUP_CLOSE',
  'SERVICES_SEARCH',
  'SERVICE_REFRESH',
  /* R3: the service card again, drawn IN PLACE of the message tapped (the link-change ask's back). */
  'SERVICE_CARD',
  'SERVICE_NOTE',
  'SERVICE_RENEW_QUOTE',
  /*
   * Owner rule 2026-10-18: an imported service renews from a plan of its panel the customer
   * CHOSE (`rq:`, a service-and-plan pair) — the quote it opens re-decides the plan.
   */
  'SERVICE_RENEW_PLAN',
  'REFERRAL_GIFT',
  'HELP',
  /*
   * Round N close (§D): the promotional opt-out. `/stop` and the support screen's button opt
   * the customer out of MARKETING broadcasts; the button on that reply, and on the support
   * screen afterwards, opts them back in. Neither touches a transactional notice. Both are
   * exempt from the membership guard: a customer who has not joined the channel must still
   * be able to say "stop", and the guard's own screen is not the place to be refused that.
   */
  'MARKETING_OPT_OUT',
  'MARKETING_OPT_IN',
  'RECEIPT_UPLOAD',
  /*
   * Package B — the `✅ بررسی عضویت` button. Exempt from the membership guard, and it
   * never replays what the customer first asked for: a pass answers the main menu.
   */
  'MEMBERSHIP_CHECK',
  /*
   * Program §6 — the accept button under the terms and rules. Carries the VERSION the
   * customer was shown; only that version is recorded, and only while it is still the
   * current one. Exempt from the terms gate (it is the way through it), never from the
   * membership gate, and never replays what the customer first asked for.
   */
  'TERMS_ACCEPT',
  /*
   * R10 D5 (a) — one of the four answers under the `/start` captcha: `hc:<question id>:<0-3>`.
   * Decided by the captcha gate at the very top of `guardedAct`, before membership and
   * terms; a tap from a customer the gate does not hold reaches `act` and is answered as a
   * stale button.
   */
  'CAPTCHA_ANSWER',
  /*
   * WP-A7 — the customer's support tickets. `TICKETS` is the list (the menu entry, /tickets
   * and its callback), `TICKET_NEW` the category chooser, `TICKET_CATEGORY` opens the window
   * that reads the new ticket's first message, `TICKET_VIEW` shows one conversation,
   * `TICKET_REPLY` opens the reply window, and the close is ask-then-act. Every one names an
   * id or nothing; the service re-reads the ticket and its owner on every write.
   */
  'TICKETS',
  /*
   * R10 D2 — a tap on an owner-defined main-menu button. `targetId` is the button's id, read
   * from the label map's VALUE (`mb:<id>`), never from the typed text. The route grants
   * nothing: the handler asks the server again (flag, archive, bot, published layout).
   */
  'CUSTOM_MENU_BUTTON',
  'TICKET_NEW',
  'TICKET_CATEGORY',
  'TICKET_VIEW',
  'TICKET_REPLY',
  'TICKET_CLOSE_ASK',
  'TICKET_CLOSE',
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
  /*
   * Payment File 02 §12 — the third disposition. `ADMIN_CREDIT` opens an amount capture
   * for one payment; the amount itself arrives as ordinary text and is offered to the
   * capture only when the sender is an administrator whose capture is waiting;
   * `ADMIN_CREDIT_CONFIRM` is the only callback that moves money, and it names the
   * CAPTURE, never an amount; `ADMIN_CREDIT_CANCEL` abandons it.
   */
  'ADMIN_CREDIT',
  'ADMIN_CREDIT_CONFIRM',
  'ADMIN_CREDIT_CANCEL',
  /*
   * WP10 follow-up — Block User from the receipt (File 01 §9). `ADMIN_BLOCK_ASK` writes
   * nothing; `ADMIN_BLOCK_OPEN` opens the reason capture; the reason arrives as ordinary text,
   * offered only to its own administrator's open capture; `ADMIN_BLOCK_CONFIRM` is the only
   * callback that blocks, and names the CAPTURE; `ADMIN_BLOCK_CANCEL` abandons it. None of
   * them decides anything about the payment.
   */
  'ADMIN_BLOCK_ASK',
  'ADMIN_BLOCK_OPEN',
  'ADMIN_BLOCK_CONFIRM',
  'ADMIN_BLOCK_CANCEL',
  /*
   * File 01 §7 — the rejection's mandatory reason. `ADMIN_REJECT` (the reject button) now
   * OPENS a reason capture and rejects nothing; `ADMIN_REJECT_CONFIRM` is the only callback
   * that rejects, and names the CAPTURE; `ADMIN_REJECT_CANCEL` abandons it.
   */
  'ADMIN_REJECT_CONFIRM',
  'ADMIN_REJECT_CANCEL',
  /*
   * WP19: a decision on a customer's service refund request. APPROVE opens the amount
   * capture and REJECT the reason capture — neither decides anything; CONFIRM names the
   * amount CAPTURE and is the only callback that approves; CANCEL abandons either prompt.
   */
  'ADMIN_REFUND_REQUEST_APPROVE',
  'ADMIN_REFUND_REQUEST_REJECT',
  'ADMIN_REFUND_REQUEST_CONFIRM',
  'ADMIN_REFUND_REQUEST_CANCEL',
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
   * Phase 6A — the services section.
   *
   * `ADMIN_SERVICE_TERMINATE_ASK` is the first ask-then-act pair on the ADMIN side.
   * Every admin action before it fired on one tap, which is right for approving a
   * receipt and wrong for deleting an account on a provider: the asking callback is
   * what a list or a detail screen carries, and the destructive one is produced in
   * exactly one place.
   */
  'ADMIN_SERVICES',
  /*
   * WP3 — the browsable half of the services section.
   *
   * `ADMIN_SERVICES` stays a QUEUE: the unreconciled and the undelivered, ten rows
   * that are ten decisions. These two are an INVENTORY, which is a different question
   * and needs a different list — "where is this one" rather than "what needs me".
   * Collapsing them would lose the first, because a queue that pages is no longer a
   * queue.
   *
   * Two intents rather than one with an optional payload, for the reason
   * `SERVICES_PAGE` gives: the first is a bare tap and the second carries an opaque
   * cursor the boundary validates before any handler sees it.
   */
  'ADMIN_SERVICES_BROWSE',
  'ADMIN_SERVICES_BROWSE_PAGE',
  'ADMIN_SERVICE',
  'ADMIN_SERVICE_SYNC',
  'ADMIN_SERVICE_RESEND',
  'ADMIN_SERVICE_RETRY',
  'ADMIN_SERVICE_RECONCILE',
  'ADMIN_SERVICE_SUSPEND',
  'ADMIN_SERVICE_RESUME',
  'ADMIN_SERVICE_TERMINATE_ASK',
  'ADMIN_SERVICE_TERMINATE',
  'ADMIN_SERVICE_ROTATE_ASK',
  'ADMIN_SERVICE_ROTATE',
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
  /*
   * WP10G — the two writes above are now ASKS (closing OQ-WP10F-03): `ADMIN_CUSTOMER_BLOCK`
   * draws a confirmation and `ADMIN_CUSTOMER_BLOCK_OPEN` opens the mandatory reason's capture;
   * the typed reason is restated and `ADMIN_CUSTOMER_BLOCK_CONFIRM` is the one tap that blocks.
   * `ADMIN_CUSTOMER_UNBLOCK` draws its confirmation and `ADMIN_CUSTOMER_UNBLOCK_CONFIRM` is the
   * one tap that unblocks. No one-tap write remains in the section.
   */
  'ADMIN_CUSTOMER_BLOCK_OPEN',
  'ADMIN_CUSTOMER_BLOCK_CONFIRM',
  'ADMIN_CUSTOMER_BLOCK_CANCEL',
  'ADMIN_CUSTOMER_UNBLOCK_CONFIRM',
  /*
   * WP5 — the categories section.
   *
   * Every write is `ProductCategoryService`, the one the Web Admin's `/product-categories`
   * routes call, so nothing here decides what a category may do. The taps carry a TARGET
   * (activate, hide) rather than "flip it", for the reason `ADMIN_ADMIN_STATUS` gives: a
   * double tap on a slow connection writes the state already held instead of undoing the
   * first. `ADMIN_CATEGORY_DELETE_ASK` and `ADMIN_CATEGORY_DELETE` are the ask-then-act
   * pair. The three that carry operator TEXT — a name, an emoji — are commands with their
   * argument in the same message, never a prompt that captures the next one
   * (INCIDENT-FIN-001).
   *
   * `ADMIN_CATEGORY_PRODUCTS`, `_PICK` and `_ASSIGN` are the reassignment: choose a
   * product, then the category it should move to. Chosen from a list of products rather
   * than from inside a category because the product that most needs a category is the one
   * that has NONE, and no category screen would ever list it.
   */
  'ADMIN_CATEGORIES',
  'ADMIN_CATEGORY',
  'ADMIN_CATEGORY_ACTIVATE',
  'ADMIN_CATEGORY_DEACTIVATE',
  'ADMIN_CATEGORY_SHOW',
  'ADMIN_CATEGORY_HIDE',
  'ADMIN_CATEGORY_UP',
  'ADMIN_CATEGORY_DOWN',
  'ADMIN_CATEGORY_DELETE_ASK',
  'ADMIN_CATEGORY_DELETE',
  'ADMIN_CATEGORY_NEW',
  'ADMIN_CATEGORY_RENAME',
  'ADMIN_CATEGORY_EMOJI',
  'ADMIN_CATEGORY_PRODUCTS',
  'ADMIN_CATEGORY_PICK',
  'ADMIN_CATEGORY_ASSIGN',
  'ADMIN_LINK',
  'ADMIN_ROLE',
  // Spec §7: the client apps section and its «تنظیم ویدیو» wizard (`admin-tutorial-video.ts`).
  ...ADMIN_TUTORIAL_INTENTS,
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
   * The service's ownership version a transfer confirmation (`tc:`) was drawn at (Package
   * F). Carried back so a confirmation older than the last change of owner is refused
   * rather than obeyed; absent on every other command.
   */
  readonly ownershipVersion?: number;
  /**
   * How many extra users / devices a `dq:` tap chose (WP-A5), 1 to
   * `DEVICE_ADDON_MAX_QUANTITY`; absent on every other command.
   *
   * The one callback that carries a number, and it is a CHOICE rather than an amount: the
   * customer is entitled to pick any count the rate allows, the server bounds it again
   * against the rate's maximum and what the service was already sold, and the price is
   * computed from the row — so a modified client can only choose a count it could have
   * tapped, and pays that count's price. Decoded at the boundary as a bounded integer.
   */
  readonly quantity?: number;
  /**
   * R10 D5 (a): which of the captcha's four answers a `hc:` tap chose, 0 to 3; absent on
   * every other command. A POSITION, never a value: the number it stands for is read from
   * the question the server stored, so a modified client can only pick one of the four.
   */
  readonly choice?: number;
  /**
   * Round 10, D1: the renewal total an `ay:` confirm's question SHOWED (Codex review of PR
   * 338); null for a bare `ay:` drawn before it was carried, absent on every other command.
   * A ceiling the customer agreed to, never a price: the consent recorded is the server's own
   * quote, and only when that quote is at or below this.
   */
  readonly shownTotal?: Money | null;
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
  /**
   * A PAGE NUMBER, for the two catalogue callbacks.
   *
   * Offset paging, as the owner settled in `docs/wp5-categories-audit.md` §6.4 — and
   * carried as a page rather than a raw offset, so a modified client can ask for a page
   * and nothing else. Parsed and bounded at the boundary by `parseCatalogPage`; a value
   * that fails is UNSUPPORTED before a handler sees it.
   *
   * Not `cursor`, and deliberately: a keyset cursor names a row, and `sort_order` is
   * operator-mutable, so a cursor on it is not a stable position. §6.4 forbids exactly
   * that, and a page number makes no claim of stability it could break.
   */
  readonly page?: number;
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
  /** Spec §7: the video an `ADMIN_APP_VIDEO_UPLOAD` carries, and nothing else ever does. */
  readonly video?: InboundTutorialVideo | null;
}
