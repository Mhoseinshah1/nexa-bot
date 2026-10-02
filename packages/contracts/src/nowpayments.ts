/**
 * NOWPayments, as its own API documentation describes it (`docs/nowpayments-gateway-audit.md`).
 *
 * Every value here is either read off NOWPayments' published API reference (the Postman
 * collection `7907941`, mirrored as an OpenAPI document) or is a Nexa product decision,
 * and the two are labelled. What the documentation does NOT say — whether the invoice's
 * payment list answers an API key without a JWT, how long a hosted invoice stays open, the
 * exact shape of every error — is listed in the audit's §4 and is not invented here.
 */

/** Documented. The production API; the sandbox is a different host and is never used. */
export const NOWPAYMENTS_BASE_URL = 'https://api.nowpayments.io';

/** Documented: `POST /v1/invoice` creates a hosted invoice and answers its `invoice_url`. */
export const NOWPAYMENTS_INVOICE_PATH = '/v1/invoice';
/** Documented: `GET /v1/payment/{payment_id}` — the payment's status, read with the key. */
export const NOWPAYMENTS_PAYMENT_PATH = '/v1/payment';
/**
 * Documented: `GET /v1/payment/?invoiceId=…` lists the payments made against one invoice.
 * The reference shows a JWT `Authorization` header on it beside the key; whether the key
 * alone is answered is UNKNOWN (`OQ-NP-02`). Nexa sends the key only and never stores the
 * account's e-mail or password to mint a JWT.
 */
export const NOWPAYMENTS_PAYMENT_LIST_PATH = '/v1/payment/';
/**
 * Documented: `GET /v1/estimate` answers an approximate crypto price for a fiat amount
 * and requires the API key. Read-only and harmless, so it is the credential check.
 */
export const NOWPAYMENTS_ESTIMATE_PATH = '/v1/estimate';

/** Documented: the authentication header. The value is never logged or echoed. */
export const NOWPAYMENTS_API_KEY_HEADER = 'x-api-key';
/** Documented: the IPN's signature header, HMAC-SHA512 hex over the key-sorted body. */
export const NOWPAYMENTS_SIGNATURE_HEADER = 'x-nowpayments-sig';

/**
 * Documented: the payment statuses.
 *
 * - `waiting` — the customer has not sent anything yet;
 * - `confirming` — the coins were seen on chain and are being confirmed;
 * - `confirmed` — the chain confirmed them;
 * - `sending` — NOWPayments is forwarding them to the merchant;
 * - `partially_paid` — less than the price arrived;
 * - `finished` — the money reached the merchant: the one success;
 * - `failed`, `refunded`, `expired` — the payment did not complete.
 */
export const NOWPAYMENTS_STATUSES = [
  'waiting',
  'confirming',
  'confirmed',
  'sending',
  'partially_paid',
  'finished',
  'failed',
  'refunded',
  'expired',
] as const;
export type NowPaymentsStatus = (typeof NOWPAYMENTS_STATUSES)[number];

/**
 * Nexa decision: the price is sent in US dollars (`price_currency = usd`), and `pay_currency`
 * is NEVER sent, so the customer picks the asset on NOWPayments' own page (owner, §16).
 */
export const NOWPAYMENTS_PRICE_CURRENCY = 'usd' as const;

/**
 * Nexa decision: the provider unit is the US CENT, and one USDT — the asset the central FX
 * layer quotes — is pegged at one dollar, so 100 cents. A fixed denomination, not a rate an
 * operator maintains (§16.5: "no gateway-specific manually maintained USD rate").
 */
export const NOWPAYMENTS_CENTS_PER_USDT = 100n;
export const NOWPAYMENTS_AMOUNT_UNIT = 'USD' as const;

/**
 * Nexa decision: the provider order id. `NP` and eighteen Crockford base32 characters
 * (ninety random bits), exactly twenty characters, the TonPays shape.
 */
export const NOWPAYMENTS_ORDER_ID_PREFIX = 'NP';
export const NOWPAYMENTS_ORDER_ID_LENGTH = 20;

/**
 * Nexa decision: an attempt lives seventy minutes from the creation of the internal
 * payment, with no grace — the TonPays rule, so a late completion means the same thing on
 * every inquiry route. Coins seen on chain before the deadline open the bounded provider
 * review window, which is what lets a slow chain finish (`docs/nowpayments-gateway-audit.md` §5.4).
 */
export const NOWPAYMENTS_ATTEMPT_LIFETIME_MINUTES = 70;

/**
 * Nexa decision: calls per minute per tenant across every replica, and the part background
 * inquiries may use. NOWPayments publishes no per-key limit (`OQ-NP-04`); these stay well
 * below anything a payment API could reasonably refuse.
 */
export const NOWPAYMENTS_CALL_BUDGET_PER_MINUTE = 50;
export const NOWPAYMENTS_INQUIRY_BUDGET_PER_MINUTE = 40;

/** The largest IPN secret an operator may submit, in characters. Printable ASCII only. */
export const NOWPAYMENTS_IPN_SECRET_MAX_LENGTH = 256;
