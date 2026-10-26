// Refusal codes the runtime answers and the reply each one renders.
// Moved verbatim out of bot-runtime.ts, which still re-exports every name it exported.
import {
  COMMERCE_ERROR_CODES,
  PAYMENT_RECEIPT_MAX_PER_PAYMENT,
  PLATFORM_ERROR_CODES,
  type TemplateKey,
  type TemplateValues,
  isNexaError,
} from '@nexa/contracts';
import type { PendingReply } from './replies.js';

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
  /*
   * WP8. ONE sentence for every reason a code is refused — unknown, exhausted, out of
   * window, not for this plan — because a bot that told them apart would be an oracle
   * for guessing codes. The window stays open, so the customer can type another.
   */
  [COMMERCE_ERROR_CODES.DISCOUNT_CODE_REJECTED]: 'bot.discount.rejected',
  /*
   * At confirmation: a discount the summary included no longer holds. Nothing was
   * charged and the order was not re-priced — the customer starts again and sees the
   * quote as it now stands.
   */
  [COMMERCE_ERROR_CODES.DISCOUNT_NO_LONGER_VALID]: 'bot.discount.no_longer_valid',
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_EXHAUSTED]: 'bot.username.exhausted',
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_UNGENERATABLE]: 'bot.username.unavailable',
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_MODE_UNAVAILABLE]: 'bot.username.mode_unavailable',
  [COMMERCE_ERROR_CODES.SERVICE_USERNAME_STALE]: 'bot.username.stale',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_PURCHASABLE]: 'bot.order.unavailable',
  // The SAME sentence as the others, deliberately. A customer told "this is for
  // resellers" learns a tenant's pricing structure from a refusal.
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_FOR_AUDIENCE]: 'bot.order.unavailable',
  /*
   * A reseller whose tier does not grant this purchase (`docs/wp9-reseller-audit.md` R6):
   * the SAME sentence as `PRODUCT_NOT_FOR_AUDIENCE`, so the bot does not enumerate a
   * tier's grants — which operation, product, panel or bot it lacked is in the refusal's
   * detail and the audit row. It was unmapped, so `refusal` rethrew it and a reseller
   * following a product button they were not entitled to was answered with silence.
   */
  [COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED]: 'bot.order.unavailable',
  /*
   * At confirmation: the reseller's price changed since the summary (R9). The reseller
   * counterpart of `DISCOUNT_NO_LONGER_VALID` — nothing was charged, the order was not
   * re-priced, and they start again. Unmapped until the PR #69 review, which is silence.
   */
  [COMMERCE_ERROR_CODES.RESELLER_TERMS_CHANGED]: 'bot.order.terms_changed',
  /*
   * Package D. Off, not offered here, or not priced: one sentence, like
   * `bot.order.unavailable` — the audit row carries which. A changed rule at confirmation
   * and an extension of a custom service each have their own.
   */
  [COMMERCE_ERROR_CODES.CUSTOM_SERVICE_DISABLED]: 'bot.custom_service.unavailable',
  [COMMERCE_ERROR_CODES.CUSTOM_SERVICE_UNAVAILABLE]: 'bot.custom_service.unavailable',
  [COMMERCE_ERROR_CODES.CUSTOM_SERVICE_TERMS_CHANGED]: 'bot.custom_service.terms_changed',
  [COMMERCE_ERROR_CODES.CUSTOM_SERVICE_NOT_EXTENDABLE]: 'bot.custom_service.not_extendable',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_PRICED]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_FULFILLABLE]: 'bot.order.unavailable',
  /*
   * The two category refusals, answered with the SAME sentence as the five above.
   *
   * `PRODUCT_NOT_CATEGORISED` is an operator's half-finished product and
   * `CATEGORY_NOT_PURCHASABLE` is a whole section they have switched off; a customer
   * holding a direct reference can reach either, because the confirmation transaction
   * re-decides under its own lock rather than trusting the list the message was drawn
   * from. Neither is something the buyer can act on, and naming which one it was would
   * tell them how the seller has arranged their shop. The reason is in the refusal's
   * detail and the audit row, which is where an operator looks.
   *
   * HIDDEN is deliberately absent: it is not a refusal at all. A hidden category is
   * left out of the lists and stays orderable through a reference the customer already
   * holds, which is exactly what distinguishes it from INACTIVE.
   */
  [COMMERCE_ERROR_CODES.PRODUCT_NOT_CATEGORISED]: 'bot.order.unavailable',
  [COMMERCE_ERROR_CODES.CATEGORY_NOT_PURCHASABLE]: 'bot.order.unavailable',
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
   * A service that does not exist and one that belongs to another customer, from the
   * actions that read it through the commercial service (extra traffic, time, users,
   * location). The flows that look the service up themselves already answer
   * `bot.service.not_found`; these three threw instead, so the same id got two different
   * answers by action. ONE key for both cases, for the reason the template gives.
   */
  [COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND]: 'bot.service.not_found',
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
  // Owner decision 2026-10-17: a wallet carried over below zero buys nothing until topped up.
  [COMMERCE_ERROR_CODES.WALLET_NEGATIVE_TOP_UP_REQUIRED]: 'bot.wallet.negative_balance',
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
   * The typed top-up's ceiling (`wallet.topup.maximum`, customer UX completion §F),
   * mapped to the same generic sentence for now so the code is never unanswered. The
   * typed-amount flow that renders `bot.wallet.topup_above_maximum` with the figure
   * reads the ceiling itself before the service is asked; this entry is the backstop
   * for the transaction refusing what the prompt admitted a moment earlier.
   */
  [COMMERCE_ERROR_CODES.TOPUP_ABOVE_MAXIMUM]: 'bot.wallet.topup_refused',
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
  // Package A, Codex review of #85: a Stars payment approved at checkout is on its way.
  [COMMERCE_ERROR_CODES.PAYMENT_CHECKOUT_IN_PROGRESS]: 'bot.payment.checkout_in_progress',
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
   * Round 10, D1: «تمدید خودکار» cannot be switched on — the feature is off, or this service
   * cannot be renewed automatically. One Persian sentence for both; nothing was recorded.
   */
  [COMMERCE_ERROR_CODES.AUTO_RENEW_DISABLED]: 'bot.service.auto_renew_unavailable',
  [COMMERCE_ERROR_CODES.AUTO_RENEW_NOT_AVAILABLE]: 'bot.service.auto_renew_unavailable',
  /*
   * WP-A6: the three location-change refusals a customer can act on, each its own
   * sentence — already there, moved too recently, no changes left in the period.
   */
  [COMMERCE_ERROR_CODES.LOCATION_CHANGE_SAME_LOCATION]: 'bot.service.location_same',
  [COMMERCE_ERROR_CODES.LOCATION_CHANGE_COOLDOWN]: 'bot.service.location_cooldown',
  [COMMERCE_ERROR_CODES.LOCATION_CHANGE_LIMIT_REACHED]: 'bot.service.location_limit',
  /*
   * A renewal priced in a unit this store has stopped selling.
   *
   * Reachable from a callback drawn before `sales.currency` moved: `availableFor` and
   * `offer` both filter on it now, and neither un-draws a message already in the chat.
   * The configuration sentence, because that is what it is.
   */
  [COMMERCE_ERROR_CODES.PRODUCT_CURRENCY_UNSUPPORTED]: 'bot.service.action_unavailable',
  // The customer UX completion's refusals. The ones that carry a figure (a bound, a
  // maximum) are answered by their handlers, which have the figure.
  [COMMERCE_ERROR_CODES.SERVICE_SYNC_TOO_SOON]: 'bot.service.refresh_too_soon',
  [COMMERCE_ERROR_CODES.REFERRAL_GIFT_DISABLED]: 'bot.referral.gift_disabled',
  [COMMERCE_ERROR_CODES.CAPTURE_NOT_OPEN]: 'bot.wallet.topup_expired',
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

/** Whether `refusal` answers this error with a sentence, rather than rethrowing it. */
export function hasRefusalReply(error: unknown): boolean {
  return isNexaError(error) && REFUSAL_REPLIES[error.code] !== undefined;
}

/**
 * Pre-support A2: what a card's opportunistic read on open may be refused with SILENTLY —
 * a typed refusal the open did not ask about: the installation is
 * quiesced for a recovery, the actor may not read (`PERMISSION_DENIED`), or a failure the
 * taxonomy marks retryable. Anything else (an untyped error, a non-retryable internal one
 * such as an undecryptable credential) still draws the stored card, and is reported.
 */
export function isExpectedRefreshRefusal(error: unknown): boolean {
  if (!isNexaError(error)) return false;
  return (
    error.code === PLATFORM_ERROR_CODES.RECOVERY_QUIESCED ||
    error.kind === 'PERMISSION_DENIED' ||
    error.retryable
  );
}

export function refusal(error: unknown): PendingReply {
  const key = isNexaError(error) ? REFUSAL_REPLIES[error.code] : undefined;
  if (key === undefined) throw error;
  return { key, values: refusalValuesFor(key), buttons: [], orderId: null };
}
