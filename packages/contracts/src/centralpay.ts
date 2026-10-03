/**
 * CentralPay, as the owner-supplied "CentralPay Deposit Method" guide describes it
 * (`docs/centralpay-gateway-audit.md`).
 *
 * Every value here is either read off that guide or is a Nexa product decision, and the two
 * are labelled. What the guide does NOT say — the failure body, whether verify has side
 * effects before the customer paid, the integer width of `orderId`/`userId`, how long a link
 * stays payable, rate limits — is listed in the audit's §4 and `OQ-CP-*`, never invented here.
 * The guide documents NO webhook; Nexa accepts none for this route.
 */

/** Documented. The production host; no sandbox is documented and none is assumed. */
export const CENTRALPAY_BASE_URL = 'https://centralapi.org';

/**
 * Documented: `POST` JSON `{ api_key, type: "deposit", amount, userId, orderId, returnUrl }`.
 * Success is `{ success: true, data: { redirectUrl } }`; the customer is sent to it.
 */
export const CENTRALPAY_GET_LINK_PATH = '/webservice/basic/getLink.php';
/**
 * Documented: `POST` JSON `{ api_key, orderId }` with the SEPARATE verify key. Success data
 * carries `referenceId`, `amount` (Toman), `userId` and `userCardNumber`. A repeated verify
 * of a paid order may keep answering `success: true` — so a repeat is never a second credit.
 */
export const CENTRALPAY_VERIFY_PATH = '/webservice/basic/verify.php';

/** Documented: the one `type` this integration sends. */
export const CENTRALPAY_DEPOSIT_TYPE = 'deposit' as const;

/**
 * Documented: `amount` is an integer number of TOMAN, sent and verified. An IRR installation
 * converts only when the payable is a whole number of Toman (TonPays' `tomanAmountOf`).
 */
export const CENTRALPAY_AMOUNT_UNIT = 'IRT' as const;

/**
 * Nexa vocabulary for what a verify answered, recorded as the inquiry's status (the guide
 * names no status field): `verified` — `success: true`; `unverified` — anything else
 * readable. Only `verified` with every local check passing is ever an approval.
 */
export const CENTRALPAY_STATUSES = ['verified', 'unverified'] as const;
export type CentralPayStatus = (typeof CENTRALPAY_STATUSES)[number];

/**
 * Nexa decision: the integers CentralPay is sent as `orderId` (per attempt) and `userId`
 * (per customer, stable) are drawn at random from this range. The guide says "integer" and
 * no width (`OQ-CP-02`), so the range stays inside a signed 32-bit integer; random rather
 * than a sequence so two installations (staging and production) sharing one merchant account
 * never hand out the same numbers, and ten digits so they cannot collide with a small
 * auto-increment another system used on the same account. Unique across every tenant of this
 * installation: tenants that share one merchant account share its namespace.
 */
export const CENTRALPAY_INTEGER_MIN = 1_000_000_000n;
export const CENTRALPAY_INTEGER_MAX = 2_147_483_647n;

/**
 * Nexa decision: an attempt lives seventy minutes from the creation of the internal payment
 * — the rule every inquiry route shares, so a late completion means the same thing on each.
 * How long CentralPay keeps a link payable is undocumented (`OQ-CP-04`).
 */
export const CENTRALPAY_ATTEMPT_LIFETIME_MINUTES = 70;

/**
 * Nexa decision: calls per minute per tenant across every replica, and the part background
 * verifies may use. CentralPay publishes no limit (`OQ-CP-05`).
 */
export const CENTRALPAY_CALL_BUDGET_PER_MINUTE = 50;
export const CENTRALPAY_INQUIRY_BUDGET_PER_MINUTE = 40;

/** The largest verify key an operator may submit, in characters. Printable ASCII only. */
export const CENTRALPAY_VERIFY_KEY_MAX_LENGTH = 256;

/** The largest `referenceId` recorded (it becomes the attempt's write-once charge id). */
export const CENTRALPAY_REFERENCE_ID_MAX_LENGTH = 255;

/**
 * The path the customer's browser is sent back to (`<origin><prefix>/centralpay/<tenant>
 * ?orderId=<n>`): GET, carries no payment data, and only ever brings a verify forward.
 */
export const GATEWAY_RETURN_PATH_PREFIX = '/payments/return';
