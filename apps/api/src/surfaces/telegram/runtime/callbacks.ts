// Callback-data prefixes, whole callback data and their codecs.
// Moved verbatim out of bot-runtime.ts, which still re-exports every name it exported.
import { createHash } from 'node:crypto';
import {
  currencyCodeSchema,
  DEVICE_ADDON_MAX_QUANTITY,
  money,
  type Money,
  type SettingKey,
  telegramUserIdSchema,
  uuidV7Schema,
} from '@nexa/contracts';
import type { BotIntent } from './intents.js';

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
 * Paying an order through an external gateway (WP11A, TonPays). Carries the ORDER ID and
 * nothing else; the route is re-decided on the server when the tap arrives. Drawn only
 * when a real external route is offered for this order; a tap on a stale button when
 * none is answers `bot.payment.gateway_unavailable`.
 */
export const GATEWAY_PAY_CALLBACK_PREFIX = 'g:';

/**
 * "Check my payment" on an external-gateway attempt (WP11A). Names the PAYMENT. Reads the
 * stored state and brings the next server-to-server inquiry forward; it never calls the
 * gateway while Telegram waits, and never says paid until the payment is CONFIRMED.
 * `g` then a letter, so it cannot shadow `g:` nor be shadowed by it.
 */
export const GATEWAY_CHECK_CALLBACK_PREFIX = 'gc:';

/**
 * TonPays Telegram (`docs/tonpays-telegram-gateway-audit.md` §8.1): «📤 ارسال فیش واریزی»
 * (`gr:`) and «🔄 تعویض کارت» (`gk:`). Each names the PAYMENT — an identifier, never an
 * amount or a card — and is re-decided against the row: the owner, a card-transfer route,
 * PENDING inside the CUSTOMER window (the review deadline never reopens either), no review
 * started, a created invoice, and the bot the invoice is bound to. 3 + 36 bytes, under 64.
 * `g` then a letter, so neither shadows `g:`/`gc:`/`gp:` nor is shadowed by them.
 */
export const GATEWAY_RECEIPT_CALLBACK_PREFIX = 'gr:';
export const GATEWAY_CARD_CHANGE_CALLBACK_PREFIX = 'gk:';
/** Round 6: ask whether to cancel, confirm the cancel, and open the refund-card prompt. */
export const GATEWAY_CANCEL_ASK_CALLBACK_PREFIX = 'gq:';
export const GATEWAY_CANCEL_CALLBACK_PREFIX = 'gz:';
export const GATEWAY_REFUND_CARD_CALLBACK_PREFIX = 'gf:';

/**
 * Paying an order through ONE named external route (Package A): `gp:<order uuid>.<provider>`,
 * an order the customer owns and a member of a closed enum — the `tp:` shape. The
 * customer's choice of route travels; the amount never does. `g:` stays for messages
 * already sent, and picks the first route as it always did.
 */
export const GATEWAY_ROUTE_PAY_CALLBACK_PREFIX = 'gp:';

/*
 * WP-A7 — the ticket desk's callbacks: `tk` and one letter, so none shadows `t:` (terminate)
 * or is shadowed by it. Each names a ticket, a category, or nothing.
 */
export const TICKETS_CALLBACK_DATA = 'tkl:';
export const TICKET_NEW_CALLBACK_DATA = 'tkn:';
export const TICKET_CATEGORY_CALLBACK_PREFIX = 'tkc:';
export const TICKET_VIEW_CALLBACK_PREFIX = 'tkv:';
export const TICKET_REPLY_CALLBACK_PREFIX = 'tkr:';
export const TICKET_CLOSE_ASK_CALLBACK_PREFIX = 'tkq:';
export const TICKET_CLOSE_CALLBACK_PREFIX = 'tkx:';

/**
 * «🧾 ثبت پرداخت»: opens the payment-method selector for an order, `pm:<order uuid>`. It
 * pays nothing and starts nothing — the selector lists every route offered for the order,
 * and each of THOSE buttons carries the route's own tap (`m:` card-to-card, `gp:` an
 * external route). `px:<order uuid>` is the selector's «❌ بستن لیست», which writes nothing
 * and answers the screen the customer came from.
 */
export const PAY_METHODS_CALLBACK_PREFIX = 'pm:';
export const PAY_METHODS_CLOSE_CALLBACK_PREFIX = 'px:';

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
 * R4 A1: «🔄 تغییر شماره کارت» — `pk:<paymentId>.<sequence>`. The sequence is how many switches
 * the payment had when the keyboard was drawn, so the press is a compare-and-set: a second tap
 * of the same keyboard (a double tap, a redelivered update) finds the sequence moved, switches
 * nothing and redraws the card recorded now.
 */
export const PAY_SWITCH_CARD_CALLBACK_PREFIX = 'pk:';

/**
 * Withdrawing the ORDER, not one payment. The second destructive pair in this file.
 *
 * `x:`/`z:` close one transfer instruction and leave the order open to be paid another
 * way. These close the order itself, which `ORDER_MACHINE` has no edge out of — so the
 * quoted price goes with it. Two taps, for the reason `CANCEL_PAY_CALLBACK_PREFIX`
 * gives at length: the message carrying the first button stays in the chat for ever.
 */
export const CANCEL_ORDER_ASK_CALLBACK_PREFIX = 'd:';
/**
 * R12 F3 item 2: the buttons under a typed-input prompt. `ib:<order uuid>` is «🔙 بازگشت به
 * پیش‌فاکتور» (and the wallet shortfall's): it closes the customer's open text window and
 * draws the order's pre-invoice again. `iz:` is «انصراف»: it closes the window and answers
 * the main menu. `ik:` is the custom service's «🔙 بازگشت به مکان‌ها». None of them writes
 * anything but the window's closing; the pre-invoice they draw is read, not re-priced.
 */
export const INPUT_BACK_CALLBACK_PREFIX = 'ib:';
/**
 * R12 F3 item 9: «📊 وضعیت پرداخت» under `bot.order.payment_in_review` — `os:<order uuid>`. Reads
 * the order's live payment and draws its own screen (a gateway attempt's status) or repeats the
 * review sentence; it pays nothing and creates no payment.
 */
export const ORDER_PAYMENT_STATUS_CALLBACK_PREFIX = 'os:';
export const INPUT_CANCEL_CALLBACK_DATA = 'iz:';
export const CUSTOM_SERVICE_BACK_CALLBACK_DATA = 'ik:';
export const CANCEL_ORDER_CALLBACK_PREFIX = 'f:';
/**
 * A tap on one of the customer's own services, and a request to send its link again.
 *
 * Both name a SERVICE id and nothing else, which is the same trust boundary the payment
 * prefixes state: a callback is an intent and an identifier, never a quantity and never
 * a subscription. The link a resend produces is read from the row, so a modified client
 * has nothing to tamper with beyond the id — and an id that is not theirs fails at
 * `getForCustomer`, by id and owner in one query, with the same answer an id that does
 * not exist gets.
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
/**
 * R10 D4: «🎁 کارت هدیه» under the balance. Carries NOTHING: matched on the whole string, and
 * whether gift cards are on is decided when the tap arrives. `wg:` — `w:`, `wa:`…`wo:` exist,
 * and `wg:` differs from each at its second character.
 */
export const GIFT_CARD_CALLBACK_DATA = 'wg:';
export const TOPUP_PICK_CALLBACK_PREFIX = 'y:';
/**
 * The wallet screen's invite button (WP9). Matched on the whole string, like the top-up menu.
 *
 * F5: the wallet no longer draws it — the wallet shows wallet operations only, and the
 * referral program is its own main-menu action. Still PARSED, so a wallet message drawn
 * before F5 opens the same referral screen the menu's button does.
 */
export const REFERRAL_INVITE_CALLBACK_PREFIX = 'rf:';

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
 * Four prefixes, and since WP15 G1 only the first two plan anything. `t:` and `k:` were
 * a customer's TERMINATE, ask then confirm; the owner removed the capability, and the two
 * prefixes stay RESERVED and recognised so a message drawn before that release — or a
 * replayed callback — is answered with a refusal instead of falling through to whatever
 * a later prefix might mean. Neither plans an operation. Nothing
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
/**
 * B8: the switch asks before it acts, in both directions. `u:` and `e:` — on every card,
 * including one drawn before this release — now only draw the question; these two are the
 * question's confirm buttons and the only taps that plan SUSPEND or RESUME. `u` then `q` and
 * `e` then `q`: neither begins, or is begun by, any other prefix (pinned in
 * `bot-runtime.test.ts`). A uuid after three characters is 39 bytes, inside the 64 bytes
 * Telegram allows a `callback_data`.
 */
export const SERVICE_SUSPEND_CONFIRM_CALLBACK_PREFIX = 'uq:';
export const SERVICE_RESUME_CONFIRM_CALLBACK_PREFIX = 'eq:';
export const SERVICE_TERMINATE_ASK_CALLBACK_PREFIX = 't:';
export const SERVICE_TERMINATE_CALLBACK_PREFIX = 'k:';
/**
 * A customer's own link rotation (WP6-C), ask then confirm.
 *
 * Two characters because every single letter is taken. Neither is a prefix of another
 * prefix here and none is a prefix of them: `r:` differs from both at the second
 * character, and the operator's `ra:`/`rb:` at the second as well. The confirmation
 * carries only the service id — no link stamp, unlike the operator's `rb:` — because a
 * stale confirmation lands on the cooldown, and one tapped after the cooldown has
 * passed is a real request from the person the service belongs to
 * (`docs/wp6c-audit.md` C4).
 */
export const SERVICE_ROTATE_ASK_CALLBACK_PREFIX = 'rc:';
export const SERVICE_ROTATE_CALLBACK_PREFIX = 'rd:';
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
 * Extra users / devices (WP-A5). `dv:<service id>` opens the offer and buys nothing;
 * `dq:<service id + rate id, as a pair>.<quantity>` quotes that many. Two characters, like
 * the other late prefixes, and neither begins nor is begun by `d:`, `dc:` or `dx:`.
 */
export const SERVICE_ADD_DEVICES_CALLBACK_PREFIX = 'dv:';
export const SERVICE_BUY_DEVICES_CALLBACK_PREFIX = 'dq:';

/** `dq:` data for one quantity button: the pair, a dot, then the count in decimal. */
export function encodeDeviceQuantity(serviceId: string, addonId: string, quantity: number): string {
  return `${SERVICE_BUY_DEVICES_CALLBACK_PREFIX}${encodeIdPair(serviceId, addonId)}.${String(quantity)}`;
}

/**
 * A `dq:` tap, decoded, or null. The pair through the same validation every id-carrying
 * callback uses, and the count as a bounded decimal with no sign, no leading zero and no
 * room for anything else — so a malformed tap is UNSUPPORTED rather than a draft.
 */
export function decodeDeviceQuantity(
  data: string,
): { readonly serviceId: string; readonly addonId: string; readonly quantity: number } | null {
  if (!data.startsWith(SERVICE_BUY_DEVICES_CALLBACK_PREFIX)) return null;
  const [pairPart, countPart, ...rest] = data
    .slice(SERVICE_BUY_DEVICES_CALLBACK_PREFIX.length)
    .split('.');
  if (rest.length > 0 || pairPart === undefined || countPart === undefined) return null;
  if (!/^[1-9][0-9]?$/.test(countPart)) return null;
  const quantity = Number.parseInt(countPart, 10);
  if (quantity > DEVICE_ADDON_MAX_QUANTITY) return null;
  const pair = decodeIdPair(pairPart);
  if (pair === null) return null;
  const service = uuidV7Schema.safeParse(pair.first);
  const addon = uuidV7Schema.safeParse(pair.second);
  if (!service.success || !addon.success) return null;
  return { serviceId: service.data, addonId: addon.data, quantity };
}

/**
 * Service location change (WP-A6). `lc:<service id>` opens the choice and buys nothing;
 * `lt:<service id + location id, as a pair>` chooses a target; `lf:<the same pair>`
 * confirms a FREE move. Two characters each, none begun by `l:` or another prefix.
 */
export const SERVICE_CHANGE_LOCATION_CALLBACK_PREFIX = 'lc:';
export const SERVICE_LOCATION_TARGET_CALLBACK_PREFIX = 'lt:';
export const SERVICE_LOCATION_CONFIRM_CALLBACK_PREFIX = 'lf:';

/**
 * The service and location of an `lt:` or `lf:` tap, or null. Both halves through the
 * validation every id-carrying callback uses, so a malformed tap is UNSUPPORTED.
 */
export function decodeServiceLocationPair(
  encoded: string,
): { readonly serviceId: string; readonly locationId: string } | null {
  const pair = decodeIdPair(encoded);
  if (pair === null) return null;
  const service = uuidV7Schema.safeParse(pair.first);
  const location = uuidV7Schema.safeParse(pair.second);
  if (!service.success || !location.success) return null;
  return { serviceId: service.data, locationId: location.data };
}

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
 * The two discount-code buttons on a new-purchase summary (WP8 P11).
 *
 * Both carry the ORDER and nothing else. The code is never callback data: it is typed,
 * into a window the server opened for this one draft, and re-decided by the engine when
 * it arrives.
 */
export const DISCOUNT_CODE_ENTER_CALLBACK_PREFIX = 'dc:';
export const DISCOUNT_CODE_REMOVE_CALLBACK_PREFIX = 'dx:';
/*
 * The customer UX completion's callbacks. Two letters each so none is a prefix of an
 * existing one-letter route; the delivery card's three (`tu:`, `ok:`, `sp:`) are
 * declared beside the composer that draws them and imported here.
 */
export const MAIN_MENU_CALLBACK_DATA = 'mm:';
/** Round N close (§D): the promotional opt-out and opt-in buttons. No id: the tapper is the subject. */
export const MARKETING_OPT_OUT_CALLBACK_DATA = 'mk:out';
export const MARKETING_OPT_IN_CALLBACK_DATA = 'mk:in';
/** Package B: the membership check button's callback data. */
export const MEMBERSHIP_CHECK_CALLBACK_DATA = 'mc:';
/**
 * Program §6: `ac:<terms version uuid>` — accept THAT version of the terms and rules. Two
 * letters: `a:` is taken, and `ac:` differs from it at the second character. 39 bytes.
 */
export const TERMS_ACCEPT_CALLBACK_PREFIX = 'ac:';
/**
 * R10 D5 (a): `hc:<question uuid>:<0-3>` — one answer under the `/start` captcha. Two
 * letters: `h:` is taken (add time), and `hc:` differs from it at the second character.
 * 41 bytes. The answer itself is never in it, only the question's id and a position.
 */
export const START_CAPTCHA_CALLBACK_PREFIX = 'hc:';
export const TUTORIAL_PLATFORM_CALLBACK_PREFIX = 'to:';
/** WP-A10: `ca:<entry uuid>` — one of the tenant's client apps. Begins with `c` like `c:`, `cg:`, `ck:`. */
export const CLIENT_APP_CALLBACK_PREFIX = 'ca:';
/** `tp:<capture uuid>.<provider>` — a capture the customer owns and a member of a closed enum. */
export const TOPUP_ROUTE_CALLBACK_PREFIX = 'tp:';
export const TOPUP_CLOSE_CALLBACK_PREFIX = 'tx:';
/** `sl:<page number>` — a position, clamped server-side; never an identifier. */
export const SERVICES_LIST_PAGE_CALLBACK_PREFIX = 'sl:';
export const SERVICES_SEARCH_CALLBACK_DATA = 'ss:';
export const SERVICE_REFRESH_CALLBACK_PREFIX = 'rs:';
/** `sf:<service id>` — the panel's connection files for that service (Package E). */
export const SERVICE_FILES_CALLBACK_PREFIX = 'sf:';

export const SERVICE_NOTE_CALLBACK_PREFIX = 'nt:';
export const SERVICE_RENEW_QUOTE_CALLBACK_PREFIX = 'nr:';
/**
 * `rq:<service id, plan id>` (an id pair, `encodeIdPair`) — owner rule 2026-10-18: an imported
 * service renewed from one of its panel's current plans, the one the customer tapped.
 */
export const SERVICE_RENEW_PLAN_CALLBACK_PREFIX = 'rq:';
export const REFERRAL_GIFT_CALLBACK_DATA = 'rg:';
/**
 * Owner spec §2.2: open the wallet screen, or the catalogue, as a NEW message — the two
 * buttons under a wallet-credit message, which must stay in the chat as the record of the
 * credit. No id and no state: a tap on one a year later opens today's wallet or catalogue,
 * which is exactly what it says. Neither is a wizard button, so neither edits the message.
 */
export const WALLET_OPEN_CALLBACK_DATA = 'wo:';
/**
 * R12 F3 item 7: «📜 تراکنش‌ها». `wh:` is the newest page; `wh:<keyset token>` the page after
 * the movement the token names. Edits the tapped message, ten movements a page.
 */
export const WALLET_HISTORY_CALLBACK_PREFIX = 'wh:';
export const CATALOG_OPEN_CALLBACK_DATA = 'co:';

export const ADMIN_PANEL_CALLBACK_PREFIX = 'A:';
export const ADMIN_RECEIPTS_CALLBACK_PREFIX = 'B:';
export const ADMIN_RECEIPT_CALLBACK_PREFIX = 'C:';
/**
 * WP19 — a customer's refund request for one service, and an administrator's decision on it
 * (`docs/wp19-service-refund-request-audit.md`). Two-letter prefixes, beside `f:` and `q:`
 * rather than inside them: the router matches on the whole prefix, colon included.
 *
 * Customer:
 * - `fa:<service uuid>` opens the request screen: what will happen, and one confirm button.
 *   Reads only. 39 bytes.
 * - `fb:<service uuid>` confirms, and opens the reason capture. The request is filed by the
 *   reason itself, so a confirm that is never followed by a reason files nothing.
 *
 * Administrator (the review card, and the two captures behind it):
 * - `qa:<request uuid>` approve: opens the amount capture.
 * - `qb:<request uuid>` reject: opens the reason capture. The typed reason rejects at once
 *   (brief §2.9): nothing is deleted or moved, so there is nothing to confirm twice.
 * - `qc:<capture uuid>` / `qd:<capture uuid>` confirm or cancel an approval. The callback
 *   names the CAPTURE, never the figure: the amount is on the capture row, so a stale or
 *   forged button cannot carry a different number. `qd:` also cancels a reason prompt.
 */
export const SERVICE_REFUND_ASK_CALLBACK_PREFIX = 'fa:';
export const SERVICE_REFUND_CONFIRM_CALLBACK_PREFIX = 'fb:';
/**
 * Package F — a customer's service transfer (`docs/package-f-service-transfer-audit.md`).
 * Two letters, like `fa:`/`fb:`: every single letter is taken, and neither begins another
 * prefix or is begun by one — `t:`, `to:`, `tp:`, `tr:`, `tu:` and `tx:` all differ at the
 * second character.
 *
 * - `ta:<service uuid>` opens the window that reads the recipient's numeric id. Moves
 *   nothing. 39 bytes.
 * - `tc:<service uuid>.<recipient telegram id>` confirms. At most 3 + 36 + 1 + 19 = 59 bytes,
 *   inside Telegram's 64. Nothing on it is trusted: the transfer reads the owner, the
 *   recipient and the service again, under the service's locks.
 */
export const SERVICE_TRANSFER_ASK_CALLBACK_PREFIX = 'ta:';
/**
 * Round 10, D1: «تمدید خودکار». `ar:` asks (names the amount, records nothing), `ay:` is the
 * question's confirm and the only tap that records the consent, `an:` switches it off at once.
 * `a` then a letter, like `ac:`; none begins, or is begun by, another prefix (pinned in
 * `bot-runtime.test.ts`). A uuid after three characters is 39 bytes.
 */
export const SERVICE_AUTO_RENEW_ASK_CALLBACK_PREFIX = 'ar:';
export const SERVICE_AUTO_RENEW_CONFIRM_CALLBACK_PREFIX = 'ay:';
export const SERVICE_AUTO_RENEW_OFF_CALLBACK_PREFIX = 'an:';

/**
 * `ay:<service id>.<total in minor units>.<currency>` — the confirm names the renewal total the
 * question SHOWED (Codex review of PR 338), so the consent is bound to it: the server records
 * its own fresh quote only when that is at or below this figure. Not an authority — a modified
 * client can only raise its own ceiling, and the recorded consent is still the server's quote.
 * At most 63 bytes: 3 + 36 + 1 + 18 digits + 1 + 4.
 */
export function encodeAutoRenewConfirm(serviceId: string, shown: Money): string {
  return `${SERVICE_AUTO_RENEW_CONFIRM_CALLBACK_PREFIX}${serviceId}.${shown.amountMinor.toString()}.${shown.currency}`;
}

/**
 * An `ay:` tap, decoded, or null when malformed. A bare `ay:<service id>` — a question drawn
 * before the figure was carried — decodes with `shown: null`, which records nothing and asks
 * again at today's price.
 */
export function decodeAutoRenewConfirm(
  data: string,
): { readonly serviceId: string; readonly shown: Money | null } | null {
  if (!data.startsWith(SERVICE_AUTO_RENEW_CONFIRM_CALLBACK_PREFIX)) return null;
  const parts = data.slice(SERVICE_AUTO_RENEW_CONFIRM_CALLBACK_PREFIX.length).split('.');
  const service = uuidV7Schema.safeParse(parts[0]);
  if (!service.success) return null;
  if (parts.length === 1) return { serviceId: service.data, shown: null };
  const [, amountPart, currencyPart, ...rest] = parts;
  if (rest.length > 0 || amountPart === undefined || !/^(0|[1-9][0-9]{0,17})$/.test(amountPart)) {
    return null;
  }
  const currency = currencyCodeSchema.safeParse(currencyPart);
  if (!currency.success) return null;
  return { serviceId: service.data, shown: money(BigInt(amountPart), currency.data) };
}

export const SERVICE_TRANSFER_CONFIRM_CALLBACK_PREFIX = 'tc:';
export const ADMIN_REFUND_REQUEST_APPROVE_CALLBACK_PREFIX = 'qa:';
export const ADMIN_REFUND_REQUEST_REJECT_CALLBACK_PREFIX = 'qb:';
export const ADMIN_REFUND_REQUEST_APPROVE_CONFIRM_CALLBACK_PREFIX = 'qc:';
export const ADMIN_REFUND_REQUEST_APPROVE_CANCEL_CALLBACK_PREFIX = 'qd:';

export const ADMIN_APPROVE_CALLBACK_PREFIX = 'D:';
export const ADMIN_REJECT_CALLBACK_PREFIX = 'E:';
export const ADMIN_SECTION_CALLBACK_PREFIX = 'F:';
/*
 * The credit-to-wallet disposition's three callbacks (Payment File 02 §12). Two
 * characters, because every single one is taken: `w` then a letter, so the customer's
 * `w:` (pay from the wallet) begins none of them and none begins it — the property
 * `bot-runtime.test.ts` checks over every prefix. `wa:` names a PAYMENT; `wb:` and `wc:`
 * name a CAPTURE. 3 + 36 = 39 bytes, inside Telegram's 64.
 */
export const ADMIN_CREDIT_CALLBACK_PREFIX = 'wa:';
/** The one credit-to-wallet callback that moves money. Produced by the confirmation alone. */
export const ADMIN_CREDIT_CONFIRM_CALLBACK_PREFIX = 'wb:';
export const ADMIN_CREDIT_CANCEL_CALLBACK_PREFIX = 'wc:';
/*
 * Block User's four callbacks (WP10 follow-up §4). `x` then a letter, for the reason the
 * credit's are `w` then a letter: `x:` is taken, and `xa:` neither begins nor is begun by it.
 * `xa:` and `xb:` name a PAYMENT; `xc:` and `xd:` name a CAPTURE. 39 bytes at most.
 */
export const ADMIN_BLOCK_ASK_CALLBACK_PREFIX = 'xa:';
export const ADMIN_BLOCK_OPEN_CALLBACK_PREFIX = 'xb:';
/** The one Block User callback that blocks. Produced by the restating confirmation alone. */
export const ADMIN_BLOCK_CONFIRM_CALLBACK_PREFIX = 'xc:';
export const ADMIN_BLOCK_CANCEL_CALLBACK_PREFIX = 'xd:';
/** The one rejecting callback. Produced by the confirmation that restates the reason alone. */
export const ADMIN_REJECT_CONFIRM_CALLBACK_PREFIX = 'xe:';
export const ADMIN_REJECT_CANCEL_CALLBACK_PREFIX = 'xf:';
export const ADMIN_REVOKE_CALLBACK_PREFIX = 'G:';

/*
 * The services section, Phase 6A. One prefix per action, which is the pattern the
 * CUSTOMER half already uses for its own service actions and the reason the registry
 * above is readable: a prefix means one thing. Each carries one uuid, so `X:` plus a
 * service id is 38 bytes and the pair-carrying codec is not needed.
 */
export const ADMIN_SERVICES_CALLBACK_PREFIX = 'H:';

/**
 * The browsable list, under the services prefix rather than beside it.
 *
 * Every one of the fifty-two letters and all ten digits is already a section prefix,
 * so there is no fifty-third to take — and this does not need one. `H:` is the
 * services section; `H:b` and `H:b:<token>` are a screen INSIDE it, which is what a
 * sub-code is for. The structural rule still holds: no prefix may be a prefix of
 * another, and `H:` is matched by EQUALITY while these two are matched after it, so
 * the queue's own bare tap can never be read as a browse.
 *
 * The token is base-36 digits and hex, so it can contain no colon and the split below
 * is unambiguous. `H:b:` plus a 44-character token is 48 bytes, inside Telegram's
 * 64-byte `callback_data` cap with room to spare.
 */
export const ADMIN_SERVICES_BROWSE_CALLBACK_DATA = `${ADMIN_SERVICES_CALLBACK_PREFIX}b`;
export const ADMIN_SERVICES_BROWSE_PAGE_CALLBACK_PREFIX = `${ADMIN_SERVICES_BROWSE_CALLBACK_DATA}:`;
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
 * A new subscription link, asked then confirmed. TWO characters, because every single
 * character is taken: `r` then a letter, so the customer's `r:` (resend) begins neither
 * and neither begins it. Asked first because the tap replaces the link the customer is
 * using, and a mis-tap on a phone is not a reason for them to lose it.
 */
export const ADMIN_SERVICE_ROTATE_ASK_CALLBACK_PREFIX = 'ra:';
/**
 * The rotating callback. Produced by the confirmation screen alone, and bound to the
 * link that screen was asked about: `rb:<serviceId>.<stamp>`, where the stamp is
 * `rotationStamp` of the service's link at the time of asking. Once a rotation has
 * replaced that link the stamp no longer matches and the old button is refused, so a
 * confirmation is spent by the rotation it confirmed rather than living on in the chat.
 * 3 + 36 + 1 + 12 = 52 bytes, inside Telegram's 64.
 */
export const ADMIN_SERVICE_ROTATE_CALLBACK_PREFIX = 'rb:';

/**
 * A short digest of a subscription link, for binding a confirmation to it.
 *
 * The first twelve hex characters of a SHA-256: enough that two links a rotation
 * produced do not collide by accident, and a one-way function of a high-entropy token,
 * so the chat carries nothing a link can be recovered from. The link itself never
 * reaches an admin message.
 */
export function rotationStamp(subscriptionUrl: string | null): string {
  return createHash('sha256')
    .update(subscriptionUrl ?? '')
    .digest('hex')
    .slice(0, ROTATION_STAMP_LENGTH);
}
const ROTATION_STAMP_LENGTH = 12;
export const ROTATION_STAMP_PATTERN = /^[0-9a-f]{12}$/;
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
 * `v` reads. `b` ASKS to block and `u` ASKS to unblock (WP10G — neither writes). `o` opens the
 * block's reason capture for a customer, `c` confirms a block from a CAPTURE and `x` cancels it;
 * `n` confirms an unblock. `b`, `u`, `o` and `n` carry a customer id; `c` and `x` a capture id.
 * Validated at the boundary against this map, so an unknown code is UNSUPPORTED and never
 * becomes an intent — the same treatment the reminder codes, the username toggles and the
 * administrator statuses get. 40 bytes at the longest.
 */
export const ADMIN_CUSTOMER_CODES = {
  v: 'ADMIN_CUSTOMER',
  b: 'ADMIN_CUSTOMER_BLOCK',
  u: 'ADMIN_CUSTOMER_UNBLOCK',
  o: 'ADMIN_CUSTOMER_BLOCK_OPEN',
  c: 'ADMIN_CUSTOMER_BLOCK_CONFIRM',
  x: 'ADMIN_CUSTOMER_BLOCK_CANCEL',
  n: 'ADMIN_CUSTOMER_UNBLOCK_CONFIRM',
} as const;
type AdminCustomerCode = keyof typeof ADMIN_CUSTOMER_CODES;

export function isAdminCustomerCode(value: string): value is AdminCustomerCode {
  return Object.hasOwn(ADMIN_CUSTOMER_CODES, value);
}

export const ADMIN_USERNAME_CALLBACK_PREFIX = '3:';

/*
 * The categories section, WP5 — and the first ADMIN section with two-character prefixes.
 *
 * The comment on `ADMIN_CUSTOMERS_CALLBACK_PREFIX` says a seventh section would need the
 * registry reorganised, because `10:` would break the rule that no prefix begins another.
 * The customer catalogue found the way out: a LETTER then a letter then a colon. `k:` is
 * `k` then a colon and these are `k` then a letter, so neither begins the other — which
 * `bot-runtime.test.ts` checks over every exported prefix rather than trusting.
 *
 * - `ka:<page>` is one page of the operator's category list. A PAGE, not a keyset cursor,
 *   for the reason §6.4 of the WP5 audit gives about the customer list: `sort_order` is
 *   operator-mutable, so a cursor on it is not a stable position.
 * - `kb:<code>:<uuid>` is one category and what to do with it; the code is looked up in
 *   `ADMIN_CATEGORY_CODES`, so an unknown one is UNSUPPORTED. 41 bytes at the longest.
 * - `kc:` is the product list for reassignment, and `kc:<token>` a later page of it —
 *   products ARE keyset-paged, by the immutable `(created_at, id)`.
 * - `kd:<product uuid>.<page>` is the destination picker for one product. 43 bytes.
 * - `ke:<pair>` moves a product: `encodeIdPair(product, category)`, 46 bytes.
 */
export const ADMIN_CATEGORIES_CALLBACK_PREFIX = 'ka:';
export const ADMIN_CATEGORY_CALLBACK_PREFIX = 'kb:';
export const ADMIN_CATEGORY_PRODUCTS_CALLBACK_PREFIX = 'kc:';
export const ADMIN_CATEGORY_PICK_CALLBACK_PREFIX = 'kd:';
export const ADMIN_CATEGORY_ASSIGN_CALLBACK_PREFIX = 'ke:';

/**
 * What a `kb:` code means. A table, for the reason `ADMIN_CUSTOMER_CODES` is one: the row
 * that matters is the LAST, where a transposition would make the asking tap the deleting
 * one. Lower-case `x` asks; upper-case `X` deletes, and only the ask screen draws it.
 */
export const ADMIN_CATEGORY_CODES = {
  v: 'ADMIN_CATEGORY',
  a: 'ADMIN_CATEGORY_ACTIVATE',
  d: 'ADMIN_CATEGORY_DEACTIVATE',
  s: 'ADMIN_CATEGORY_SHOW',
  h: 'ADMIN_CATEGORY_HIDE',
  u: 'ADMIN_CATEGORY_UP',
  w: 'ADMIN_CATEGORY_DOWN',
  x: 'ADMIN_CATEGORY_DELETE_ASK',
  X: 'ADMIN_CATEGORY_DELETE',
} as const satisfies Record<string, BotIntent>;
export type AdminCategoryCode = keyof typeof ADMIN_CATEGORY_CODES;

export function isAdminCategoryCode(value: string): value is AdminCategoryCode {
  return Object.hasOwn(ADMIN_CATEGORY_CODES, value);
}
export const ADMIN_USERNAME_TOGGLE_CALLBACK_PREFIX = '4:';
export const ADMIN_USERNAME_STRATEGY_CALLBACK_PREFIX = '5:';

/**
 * The two statuses a roster tap can set, and the letter each travels as.
 *
 * There is no third letter because there is no third status: `audit_logs` references
 * administrators and refuses DELETE, so `DISABLED` is this product's answer to
 * removing one and a deletion button would have nothing behind it.
 */
export const ADMIN_STATUS_CODES = { a: 'ACTIVE', d: 'DISABLED' } as const;
export type AdminStatusCode = keyof typeof ADMIN_STATUS_CODES;
export function isAdminStatusCode(value: string): value is AdminStatusCode {
  return Object.prototype.hasOwnProperty.call(ADMIN_STATUS_CODES, value);
}

/** Which of the two customer choices a `4:` tap is setting. */
export const USERNAME_TOGGLE_FIELDS = { c: 'allowCustom', a: 'allowAutomatic' } as const;
export type UsernameToggleField = keyof typeof USERNAME_TOGGLE_FIELDS;
export function isUsernameToggleField(value: string): value is UsernameToggleField {
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
export const USERNAME_STRATEGY_CODES = {
  r: 'RANDOM',
  p: 'PREFIX_RANDOM',
  t: 'TELEGRAM_ID_RANDOM',
} as const;
export type UsernameStrategyCode = keyof typeof USERNAME_STRATEGY_CODES;
export function isUsernameStrategyCode(value: string): value is UsernameStrategyCode {
  return Object.prototype.hasOwnProperty.call(USERNAME_STRATEGY_CODES, value);
}

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

/** Unknown codes fail closed, which is what makes the map above a boundary check. */
export function isReminderSettingCode(value: string): value is ReminderSettingCode {
  return Object.prototype.hasOwnProperty.call(REMINDER_SETTING_CODES, value);
}

/**
 * The highest page number a catalogue callback may name.
 *
 * A bound on what a MODIFIED client can ask the database to OFFSET past, not a limit on
 * a real catalogue: a thousand pages of eight is eight thousand categories. A value
 * above it is UNSUPPORTED at the boundary.
 */
export const CATALOG_BROWSE_MAX_PAGE = 999;

/**
 * The two catalogue callbacks. TWO characters, because every single character is taken.
 *
 * `cg:<page>` is a page of the category list; `ck:<categoryId>.<page>` is a page of one
 * category's products. Neither is shadowed by the single-letter `c:` (confirm): that
 * prefix is `c` then `:`, and these are `c` then a letter. The registry test in
 * `bot-runtime.test.ts` asserts it over every prefix this runtime knows.
 *
 * A category button carries the category's ID, and a product button its product's ID —
 * never a position in a list. §6.4: a stale callback must fail or recover truthfully and
 * never silently select a different product, and an index into a list that has since
 * been reordered is exactly how that happens.
 */
export const CATALOG_PAGE_CALLBACK_PREFIX = 'cg:';
export const CATEGORY_CALLBACK_PREFIX = 'ck:';
/**
 * R11 A11: «🔁 سفارش دوباره» under an ended order whose category was recorded —
 * `ro:<category uuid>`, the category's product list as a new message. An identifier only;
 * the list is re-read for the tapping customer. `r:` is resend's and `ro:` does not start
 * with it.
 */
export const REORDER_CATEGORY_CALLBACK_PREFIX = 'ro:';
/**
 * The catalogue's trial button (WP6-A). The WHOLE data, not a prefix: it carries no
 * id and no figure, because nothing about a trial is the client's to say. Two letters
 * because every single-letter prefix is taken; `t:` is terminate's, and `tr:` does not
 * start with it.
 *
 * F5: the catalogue no longer draws it — a trial is its own main-menu action, not a step
 * of buying. It is still PARSED, so a catalogue message drawn before F5 and still sitting
 * in a chat answers its tap exactly as the menu's button does (the claim decides).
 */
export const TRIAL_CALLBACK_DATA = 'tr:';
/**
 * R1: one panel on the trial choice — the panel's id, validated at the boundary. `tp:` is
 * the top-up route's, so `tq:`; neither starts with the single-letter `t:`.
 */
export const TRIAL_PANEL_CALLBACK_PREFIX = 'tq:';
/**
 * Package D. The catalogue's custom-service button (the whole data: it carries nothing),
 * and a location's button (the panel's id). Two letters each, parsed before the one-letter
 * prefixes: `c:` is confirm's, and neither `cu:` nor `cv:` starts with it.
 */
export const CUSTOM_SERVICE_CALLBACK_DATA = 'cu:';
export const CUSTOM_SERVICE_LOCATION_CALLBACK_PREFIX = 'cv:';

/**
 * A page number out of callback data, or null.
 *
 * Digits only — no sign, no exponent, no leading zeros beyond a lone `0` — so `Number`'s
 * leniency (`' 1'`, `'1e2'`, `'0x10'`) cannot turn a crafted string into a page.
 */
export function parseCatalogPage(raw: string): number | null {
  if (!/^(0|[1-9][0-9]{0,3})$/.test(raw)) return null;
  const page = Number(raw);
  return page <= CATALOG_BROWSE_MAX_PAGE ? page : null;
}

/**
 * The largest ownership version a `tc:` payload can carry: four base-36 digits. With the
 * 36-byte service id and a 19-digit recipient the payload is then at most 64 bytes,
 * Telegram's limit. A service that has changed hands more often than this is not offered
 * a confirmation at all (`transferConfirmData` returns null) rather than one Telegram
 * would refuse to draw.
 */
export const TRANSFER_CONFIRM_VERSION_MAX = 36 ** 4 - 1;

/**
 * `tc:<service uuid>.<recipient telegram id>.<ownership version, base 36>` — at most 64
 * bytes. Null past `TRANSFER_CONFIRM_VERSION_MAX`.
 */
export function transferConfirmData(
  serviceId: string,
  recipientTelegramUserId: string,
  ownershipVersion: number,
): string | null {
  if (
    !Number.isSafeInteger(ownershipVersion) ||
    ownershipVersion < 0 ||
    ownershipVersion > TRANSFER_CONFIRM_VERSION_MAX
  ) {
    return null;
  }
  return `${SERVICE_TRANSFER_CONFIRM_CALLBACK_PREFIX}${serviceId}.${recipientTelegramUserId}.${ownershipVersion.toString(36)}`;
}

/**
 * A `tc:` payload's three parts, each validated here — the service as a UUIDv7, the
 * recipient by `telegramUserIdSchema`, the version as one to four lower-case base-36 digits
 * with no leading zero — or null. Anything else is UNSUPPORTED rather than a half-read that
 * could transfer a service nobody named, or at a version nobody saw.
 */
export function decodeTransferConfirm(data: string): {
  readonly serviceId: string;
  readonly recipientTelegramUserId: string;
  readonly ownershipVersion: number;
} | null {
  if (!data.startsWith(SERVICE_TRANSFER_CONFIRM_CALLBACK_PREFIX)) return null;
  const parts = data.slice(SERVICE_TRANSFER_CONFIRM_CALLBACK_PREFIX.length).split('.');
  if (parts.length !== 3) return null;
  const service = uuidV7Schema.safeParse(parts[0]);
  const recipient = telegramUserIdSchema.safeParse(parts[1]);
  const version = parts[2] ?? '';
  if (!service.success || !recipient.success || !/^(0|[1-9a-z][0-9a-z]{0,3})$/.test(version)) {
    return null;
  }
  return {
    serviceId: service.data,
    recipientTelegramUserId: recipient.data,
    ownershipVersion: Number.parseInt(version, 36),
  };
}
