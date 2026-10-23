/**
 * TetraPay (Tetra98), as the owner's Round 6 brief describes it (`docs/tetrapay-gateway-audit.md`).
 *
 * Every value here is either read off the brief's description of the TetraPay API or is a Nexa
 * product decision, and the two are labelled. The brief's source document (`tetra98-api-docs.md`)
 * was NOT available when this was built, so what the brief does not state is NOT invented: the
 * host, the exact JSON field names of the verify and webhook bodies beyond those named below,
 * the error body shape and the payment's lifetime are listed in `docs/open-questions.md`
 * (`OQ-TP-01..`) and the adapter reads them defensively and FAILS CLOSED.
 */

/**
 * The production host. NULL, deliberately: the brief names the paths and not the host, and a
 * key sent to a host somebody guessed is a key sent to a stranger (`OQ-TP-01`). While it is
 * null the adapter refuses every call as the installation's own configuration
 * (`tetrapay.base_url_missing`) and nothing is sent anywhere. Filling this in is one line,
 * and an adapter test pins that a null host sends nothing.
 */
export const TETRAPAY_BASE_URL: string | null = null;

/** Documented: `POST /payments` creates a payment `{ amount, order_id, callback_url }`. */
export const TETRAPAY_CREATE_PATH = '/payments';
/**
 * Documented: `POST /payments/{token}/verify` — the SETTLEMENT authority. `GET /payments/{token}`
 * exists for display only and is never called by this installation's settlement path.
 */
export const TETRAPAY_VERIFY_PATH_SUFFIX = '/verify';

/** Documented: `Authorization: Bearer <api_key>`. The key is never logged or echoed. */
export const TETRAPAY_AUTHORIZATION_SCHEME = 'Bearer';

/** Documented: the webhook's signature header, `t=<unix>,v1=<hex>`. */
export const TETRAPAY_SIGNATURE_HEADER = 'x-tetrapay-signature';
/** Documented: stable across retries of one event; used only to deduplicate. */
export const TETRAPAY_EVENT_ID_HEADER = 'x-tetrapay-event-id';
/** Documented: the largest clock difference, in seconds, between `t` and now. */
export const TETRAPAY_WEBHOOK_TOLERANCE_SECONDS = 300;
/** Documented: the prefix of the webhook secret an operator copies from TetraPay. */
export const TETRAPAY_WEBHOOK_SECRET_PREFIX = 'whsec_';

/** Documented: the statuses a payment reports. */
export const TETRAPAY_STATUSES = ['created', 'pending', 'paid', 'expired'] as const;
export type TetraPayStatus = (typeof TETRAPAY_STATUSES)[number];

/**
 * Documented: `order_id` is 1-64 characters of `[A-Za-z0-9_.:-]`, and `callback_url` for
 * Telegram is `https://t.me/<bot_username>?start=<param>`.
 */
export const TETRAPAY_ORDER_ID_MAX_LENGTH = 64;
export const TETRAPAY_ORDER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;

/** The documented error codes (the brief's list), carried in an error body of undocumented shape. */
export const TETRAPAY_ERROR_CODES = [
  'UNAUTHORIZED',
  'GATEWAY_SUSPENDED',
  'NO_METHOD_AVAILABLE',
  'NOT_FOUND',
  'ORDER_CONFLICT',
  'AMOUNT_OUT_OF_RANGE',
  'INVALID_CALLBACK',
  'INVALID_WEBHOOK',
  'WEBHOOK_NOT_CONFIGURED',
  'RATE_LIMITED',
  'DAILY_LIMIT_REACHED',
  'VALIDATION',
  'UNSUPPORTED_MEDIA_TYPE',
  'BAD_JSON',
  'INTERNAL',
] as const;
export type TetraPayErrorCode = (typeof TETRAPAY_ERROR_CODES)[number];

/** The prefix Nexa puts on a TetraPay code it stores, so no code collides with another route's. */
export const TETRAPAY_CODE_PREFIX = 'tetrapay.';

/**
 * The codes that describe the MERCHANT'S configuration, never the customer's payment: they open
 * an operational condition for the operator and the customer is told the method is unavailable.
 * `GATEWAY_SUSPENDED` refuses a CREATE only (brief): the inquiry and verify keep working.
 */
export const TETRAPAY_CONFIGURATION_ERROR_CODES: readonly TetraPayErrorCode[] = [
  'UNAUTHORIZED',
  'GATEWAY_SUSPENDED',
  'NO_METHOD_AVAILABLE',
  'INVALID_CALLBACK',
  'INVALID_WEBHOOK',
  'WEBHOOK_NOT_CONFIGURED',
  'UNSUPPORTED_MEDIA_TYPE',
  'BAD_JSON',
];

/** The code stored when a create is refused for being outside the provider's range. */
export const TETRAPAY_AMOUNT_OUT_OF_RANGE_STORED = `${TETRAPAY_CODE_PREFIX}AMOUNT_OUT_OF_RANGE`;
/** The code stored for the daily limit, which hides the route until 00:00 Tehran. */
export const TETRAPAY_DAILY_LIMIT_STORED = `${TETRAPAY_CODE_PREFIX}DAILY_LIMIT_REACHED`;

/**
 * Nexa decision: the Tehran midnight that ends a daily-limit hiding. Iran has used a fixed
 * UTC+03:30 offset since 2022; the zone is named rather than the offset so a change in the
 * tz database is followed.
 */
export const TETRAPAY_DAILY_LIMIT_TIME_ZONE = 'Asia/Tehran';

/**
 * Documented: 60 requests a minute per key. Nexa stays below it across every replica, with a
 * floor reserved for creates, exactly as every inquiry route does.
 */
export const TETRAPAY_DOCUMENTED_REQUESTS_PER_MINUTE = 60;
export const TETRAPAY_CALL_BUDGET_PER_MINUTE = 50;
export const TETRAPAY_INQUIRY_BUDGET_PER_MINUTE = 40;

/**
 * Nexa decision: an attempt lives seventy minutes from the creation of the internal payment,
 * the rule every inquiry route shares, so a late completion means the same thing on each. How
 * long TetraPay keeps a payment payable is not stated in the brief (`OQ-TP-04`); a verify that
 * reports `paid` after this deadline goes through the late-credit decision of the route.
 */
export const TETRAPAY_ATTEMPT_LIFETIME_MINUTES = 70;

/**
 * Nexa decision: the provider's amount unit. Every TetraPay amount is in RIAL as a numeric
 * string and Nexa sells in Toman (`IRT`) or Rial (`IRR`); the one helper that converts is
 * `domain/tetrapay.ts` (x10 out, /10 in, a non-multiple of ten refused).
 */
export const TETRAPAY_AMOUNT_UNIT = 'IRR' as const;

/** The start-parameter prefix of the `callback_url` the bot answers with the payment's status. */
export const TETRAPAY_START_PARAM_PREFIX = 'tp-';
