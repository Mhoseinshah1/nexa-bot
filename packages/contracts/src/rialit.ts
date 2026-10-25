/**
 * Rialit, as the owner-provided Rialit API document (version 1) describes it
 * (`docs/rialit-gateway-audit.md`). The document itself is NOT in the repository.
 *
 * Every value here is either read off that document (labelled "Documented", with the section
 * it comes from) or is a Nexa product decision (labelled "Nexa decision"). What the document
 * does not settle — whether a 5xx on a create can still have created a payment, whether the
 * payer fee can be forced to zero, the webhook sender addresses — is in `docs/open-questions.md`
 * (`OQ-RL-*`) and is not invented here.
 */

/** Documented ("Quick reference"). The production API; no sandbox is documented. */
export const RIALIT_BASE_URL = 'https://api.rialit.io/api/v1';

/** Documented ("Create a payment"): `POST /send` `{ amount, order_id, payer_id }`. */
export const RIALIT_CREATE_PATH = '/send';
/**
 * Documented ("Get a payment"): `GET /status/{token}` — the SETTLEMENT authority. Nothing
 * else this installation hears from Rialit (a webhook, a customer's tap) can approve a payment.
 */
export const RIALIT_STATUS_PATH = '/status';

/** Documented ("The payment page"): the page the payer is sent to, `<base><token>`. */
export const RIALIT_PAY_PAGE_BASE = 'https://pay.rialit.io/v1/';

/** Documented ("Authentication"): `Authorization: Bearer <API key>` on every request. */
export const RIALIT_AUTHORIZATION_SCHEME = 'Bearer';

/** Documented ("Webhooks"): the header that repeats the body's `event_id` (the dedupe key). */
export const RIALIT_DELIVERY_HEADER = 'x-rialit-delivery';
/** Documented: the header that repeats the body's `type`. Informative only; the body decides. */
export const RIALIT_EVENT_HEADER = 'x-rialit-event';

/** Documented ("Payment statuses"). */
export const RIALIT_STATUSES = ['pending', 'paid', 'expired', 'cancelled'] as const;
export type RialitStatus = (typeof RIALIT_STATUSES)[number];

/** Documented ("Webhooks" section): the four events. */
export const RIALIT_WEBHOOK_EVENTS = [
  'payment.paid',
  'payment.expired',
  'payment.cancelled',
  'webhook.test',
] as const;
export type RialitWebhookEvent = (typeof RIALIT_WEBHOOK_EVENTS)[number];
/** Documented: the dashboard's test delivery. It names no payment: answered 200, nothing else. */
export const RIALIT_TEST_EVENT: RialitWebhookEvent = 'webhook.test';

/**
 * Documented ("Create a payment", `CreatePaymentRequest.amount`): a whole number of TOMAN from
 * 50,000 to 10,000,000. Nexa decision: the bound applies to what Nexa SENDS — the payable, the
 * principal plus Nexa's own customer fee — and an amount outside it is refused locally, before
 * any call, with these figures on the customer's screen.
 */
export const RIALIT_AMOUNT_MIN_TOMAN = 50_000n;
export const RIALIT_AMOUNT_MAX_TOMAN = 10_000_000n;

/** Documented ("Quick reference"): every Rialit amount is in Toman. */
export const RIALIT_AMOUNT_UNIT = 'IRT' as const;

/**
 * Documented: `order_id` is 1-64 bytes of UTF-8 with no leading or trailing space, no double
 * space, no control or invisible character and none of `<>&"'`. Nexa decision: it generates
 * only the strict subset `[A-Za-z0-9_.:-]`, which satisfies every one of those rules and is
 * one byte per character, so the 64-character pattern is also the 64-byte bound.
 */
export const RIALIT_ORDER_ID_MAX_BYTES = 64;
export const RIALIT_ORDER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;

/** Documented (`GET /status/{token}` path parameter): 1-64 letters and digits. */
export const RIALIT_TOKEN_PATTERN = /^[A-Za-z0-9]{1,64}$/u;

/**
 * Documented ("The payment page"): the link is open for 30 minutes. Shown to the customer as
 * the deadline to pay; it does NOT shorten the attempt (below).
 */
export const RIALIT_LINK_LIFETIME_MINUTES = 30;

/**
 * Nexa decision (owner, Round 9): an attempt lives seventy minutes from the creation of the
 * internal payment, the rule every inquiry route shares, so a late completion means the same
 * thing on each. Rialit's `pending` can outlive the link and an `expired` / `cancelled` can
 * still become `paid`; a `paid` read after this deadline goes through the route's late-credit
 * decision (switch OFF by default).
 */
export const RIALIT_ATTEMPT_LIFETIME_MINUTES = 70;

/**
 * Documented ("Rate limits"): 10 creates and 5 status reads a second per merchant, 30 a second
 * per address. Nexa decision: far below that, per tenant and across every replica, with a
 * floor reserved for creates, exactly as every inquiry route does.
 */
export const RIALIT_CALL_BUDGET_PER_MINUTE = 60;
export const RIALIT_INQUIRY_BUDGET_PER_MINUTE = 40;
/** Documented: a 429 carries no `Retry-After`; wait about one second. */
export const RIALIT_RATE_LIMIT_WAIT_MS = 1_000;

/** The prefix Nexa puts on a Rialit code it stores, so no code collides with another route's. */
export const RIALIT_CODE_PREFIX = 'rialit.';

/**
 * Nexa's names for what Rialit answered. Rialit's errors carry ONE English `error` string and
 * no code ("Errors"), so each is classified by its HTTP status and, where the document gives
 * one, its exact text; the English is never stored, logged or shown. Named `..._PROVIDER_ERRORS`
 * like TetraPay's: a provider's words stored on an attempt, labelled through
 * `PROVIDER_CODE_LABELS`, not codes this API raises.
 *
 * - `PAYER_FEE_NONZERO` — Nexa's own: the create answered a payer fee (or a payer amount
 *   other than the amount sent). The customer would pay Rialit's fee on top of Nexa's quote,
 *   so the link is never shown; the owner sets the payer fee to zero in Rialit's dashboard.
 * - `PAYER_AMOUNT_UNREADABLE` — Nexa's own: the create's `payer_fee` / `payer_amount` could
 *   not be read, so whether the customer would pay more than the quote is unknown; the same
 *   refusal.
 */
export const RIALIT_PROVIDER_ERRORS = [
  'UNAUTHORIZED',
  'IP_NOT_ALLOWED',
  'MERCHANT_INACTIVE',
  'FORBIDDEN',
  'BAD_REQUEST',
  'AMOUNT_OUT_OF_RANGE',
  'INVALID_ORDER_ID',
  'INVALID_PAYER_ID',
  'NOT_FOUND',
  'ORDER_CONFLICT',
  'RATE_LIMITED',
  'PAYER_FEE_NONZERO',
  'PAYER_AMOUNT_UNREADABLE',
] as const;
export type RialitProviderError = (typeof RIALIT_PROVIDER_ERRORS)[number];

/**
 * The codes that describe the MERCHANT's configuration (or Nexa's request), never the
 * customer's payment: they open the operator's misconfiguration condition, and the customer is
 * told the method is unavailable. `MERCHANT_INACTIVE` refuses a CREATE only ("Authentication":
 * `GET /status` keeps working, so open payments are still followed).
 */
export const RIALIT_CONFIGURATION_ERRORS: readonly RialitProviderError[] = [
  'UNAUTHORIZED',
  'IP_NOT_ALLOWED',
  'MERCHANT_INACTIVE',
  'FORBIDDEN',
  'BAD_REQUEST',
  'INVALID_ORDER_ID',
  'NOT_FOUND',
  'PAYER_FEE_NONZERO',
  'PAYER_AMOUNT_UNREADABLE',
];

/**
 * The code stored when an amount is outside Rialit's range, with the bounds in Toman:
 * `rialit.AMOUNT_OUT_OF_RANGE:<min>:<max>` (TetraPay's shape, so one screen reads both).
 */
export const RIALIT_AMOUNT_OUT_OF_RANGE_STORED = `${RIALIT_CODE_PREFIX}AMOUNT_OUT_OF_RANGE`;
/** The code stored when the create answered a payer fee: the link is never shown. */
export const RIALIT_PAYER_FEE_STORED = `${RIALIT_CODE_PREFIX}PAYER_FEE_NONZERO`;
/** The code stored when the create's payer figures could not be read: the same refusal. */
export const RIALIT_PAYER_AMOUNT_UNREADABLE_STORED = `${RIALIT_CODE_PREFIX}PAYER_AMOUNT_UNREADABLE`;
