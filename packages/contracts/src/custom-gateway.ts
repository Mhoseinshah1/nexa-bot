/**
 * The custom gateway: Nexa's OWN payment-bridge protocol, version 1
 * (`docs/protocols/custom-gateway.md`, Round 10 item C1).
 *
 * Not a provider's API. One fixed JSON-over-HTTPS protocol that a third party implements in a
 * small service — the BRIDGE — between Nexa and a payment service Nexa has no adapter for. The
 * `CUSTOM` route is ONE code-backed gateway type that speaks only this protocol; an operator
 * points it at a bridge and can never define a provider with no code behind it.
 *
 * Every value here is the protocol document's (labelled "Protocol §n") or a Nexa product
 * decision ("Nexa decision"). Where the document and this file disagree, it is a bug here.
 */

/** Protocol §3.4: the protocol name and version a bridge's ping must answer. */
export const CUSTOM_GATEWAY_PROTOCOL = 'nexa-custom-gateway';
export const CUSTOM_GATEWAY_PROTOCOL_VERSION = '1';

/**
 * Protocol §3: the endpoint paths, RELATIVE to the operator's base URL. The path signed in a
 * request (§4) is exactly one of these — never the base URL's own prefix.
 */
export const CUSTOM_GATEWAY_PATHS = {
  create: '/v1/payments',
  inquiry: '/v1/payments/inquiry',
  ping: '/v1/ping',
  /** Optional for a bridge (§3.5); Nexa v1 does not call it (`OQ-CG-04`). */
  cancel: '/v1/payments/cancel',
} as const;

/** Protocol §3.3, §4, §5: header names, lower-cased as Node delivers them. */
export const CUSTOM_GATEWAY_HEADERS = {
  protocol: 'x-nexa-protocol',
  timestamp: 'x-nexa-timestamp',
  nonce: 'x-nexa-nonce',
  signature: 'x-nexa-signature',
  idempotencyKey: 'idempotency-key',
  /** `t=<unix>,v1=<hex>[,v1=<hex>]` on every 2xx response and every callback. */
  bridgeSignature: 'x-nexa-bridge-signature',
  /** The callback's delivery id; MUST equal the body's `delivery_id` (the dedupe key). */
  deliveryId: 'x-nexa-delivery-id',
} as const;

/**
 * Protocol §4–§5 (Nexa decision, lead of Round 10): ONE per-route secret signs all three
 * directions, so each direction signs a string that starts with its OWN prefix. A signature
 * made for one direction can never verify as another: a callback signature is not a response
 * signature, and neither is a Nexa request signature.
 */
export const CUSTOM_GATEWAY_SIGNING_PREFIXES = {
  /** Nexa → bridge: `PREFIX\nMETHOD\nPATH\nTIMESTAMP\nNONCE\nBODY_SHA256`. */
  request: 'NEXA-CGW-V1-REQUEST',
  /** bridge → Nexa, a 2xx answer: `PREFIX\nt\nREQUEST_NONCE\n` + raw body bytes. */
  response: 'NEXA-CGW-V1-RESPONSE',
  /** bridge → Nexa, a callback: `PREFIX\nt\n` + raw body bytes. */
  callback: 'NEXA-CGW-V1-CALLBACK',
} as const;

/** Protocol §4, §5: how far a signed timestamp may be from Nexa's clock, either way. */
export const CUSTOM_GATEWAY_SIGNATURE_TOLERANCE_SECONDS = 300;
/** Protocol §3.4: a bridge clock further off than this is reported as a warning by the ping. */
export const CUSTOM_GATEWAY_CLOCK_WARNING_SECONDS = 60;

/** Protocol §6: the six statuses. Anything else is a protocol violation, read as still open. */
export const CUSTOM_GATEWAY_STATUSES = [
  'PENDING',
  'PAID',
  'FAILED',
  'EXPIRED',
  'UNDERPAID',
  'OVERPAID',
] as const;
export type CustomGatewayStatus = (typeof CUSTOM_GATEWAY_STATUSES)[number];

/** Protocol §3.3: the callback events. `test` names no payment: answered 200, nothing else. */
export const CUSTOM_GATEWAY_STATUS_EVENT = 'payment.status_changed';
export const CUSTOM_GATEWAY_TEST_EVENT = 'test';

/**
 * Protocol §2.2 (Nexa decision): the only wire currency of v1 is the RIAL, whose minor unit is
 * the rial itself. A Toman sale is sent x10, exactly, by the one helper that owns the factor.
 */
export const CUSTOM_AMOUNT_UNIT = 'IRR' as const;
/** Protocol §2.2: a money `value` is a decimal string of at most 19 digits, never a number. */
export const CUSTOM_MONEY_VALUE_PATTERN = /^(0|[1-9][0-9]{0,18})$/u;

/**
 * Nexa decision: an attempt's `invoice_id` is `cg_` and 26 Crockford base32 characters (130
 * random bits) — unique across the installation, since tenants may share one bridge. It is a
 * strict subset of the protocol's `^[A-Za-z0-9_-]{1,64}$` (§2.3).
 */
export const CUSTOM_ORDER_ID_PREFIX = 'cg_';
export const CUSTOM_ORDER_ID_PATTERN = /^cg_[0-9A-HJKMNP-TV-Z]{26}$/u;
/** Protocol §2.3: any `invoice_id` a bridge may echo. */
export const CUSTOM_INVOICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
/** Protocol §2.3: the bridge's `reference` and a callback's `delivery_id`. */
export const CUSTOM_REFERENCE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;
export const CUSTOM_DELIVERY_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;
/** Protocol §3.1: the payment page link, `https://` only, never with userinfo. */
export const CUSTOM_PAYMENT_URL_MAX_LENGTH = 2048;
/** Protocol §8: an error `code`. An unknown one is stored as `UNKNOWN_CODE`. */
export const CUSTOM_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,47}$/u;

/**
 * Nexa decision (owner, Round 9 rule for every inquiry route): an attempt lives seventy minutes
 * from the creation of the internal payment. A `PAID` read after it goes through the route's
 * late-credit decision, switch OFF by default.
 */
export const CUSTOM_ATTEMPT_LIFETIME_MINUTES = 70;

/** Protocol §7: Nexa's calls a minute per store on one bridge, and the inquiries' share. */
export const CUSTOM_CALL_BUDGET_PER_MINUTE = 60;
export const CUSTOM_INQUIRY_BUDGET_PER_MINUTE = 40;
/** Protocol §7: every call's whole budget — DNS, connect, TLS, the body. */
export const CUSTOM_GATEWAY_TIMEOUT_MS = 15_000;
/** Protocol §2.1: Nexa stops reading a bridge's answer past this. */
export const CUSTOM_GATEWAY_MAX_RESPONSE_BYTES = 64 * 1024;
/** Protocol §7: the longest `Retry-After` Nexa honours, so a bridge cannot park an attempt. */
export const CUSTOM_GATEWAY_RETRY_AFTER_MAX_MS = 60_000;

/** Protocol §1, §9.3: the per-route secret, printable ASCII. */
export const CUSTOM_GATEWAY_SECRET_MIN_LENGTH = 32;
export const CUSTOM_GATEWAY_SECRET_MAX_LENGTH = 512;
/** Protocol §1: the operator's base URL. */
export const CUSTOM_GATEWAY_BASE_URL_MAX_LENGTH = 512;
/** Protocol §9.2: the optional callback IP allow-list. */
export const CUSTOM_GATEWAY_IP_ALLOWLIST_MAX = 32;

/** The prefix on every code Nexa stores for a bridge's answer, so none collides with a provider's. */
export const CUSTOM_CODE_PREFIX = 'custom.';

/**
 * Protocol §8: the error codes a bridge may answer with, and Nexa's own names for what it read
 * (`custom.<NAME>`). Never a bridge's free-text `message`: that is neither stored nor shown.
 *
 * Nexa's own:
 * - `UNKNOWN_CODE` — an error `code` this list does not name; read by its HTTP status.
 * - `UNSIGNED` — a 2xx answer whose signature did not verify (create: UNKNOWN, inquiry: no
 *   information, ping: failed). TLS alone is not trusted to approve a payment.
 * - `UNREADABLE` — a signed 2xx whose body is not the documented shape.
 * - `ECHO_MISMATCH` — a create answer naming another `invoice_id` or amount: refused, the link
 *   never shown, the bridge's reference kept for an operator.
 * - `LINK_REJECTED` — a create answer whose `payment_url` is not an `https://` URL.
 * - `PROTOCOL_MISMATCH`, `CURRENCY_UNSUPPORTED` — a ping that names another protocol or
 *   version, or no `IRR`.
 * - `ENDPOINT_MISSING` — the attempt carries no base URL (never sent).
 * - `CLOCK_SKEW` — a ping that passed while the bridge's clock is more than a minute off.
 */
export const CUSTOM_GATEWAY_ERROR_CODES = [
  'BAD_REQUEST',
  'SIGNATURE_INVALID',
  'TIMESTAMP_OUT_OF_WINDOW',
  'NONCE_REPLAYED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVOICE_CONFLICT',
  'CANCEL_NOT_ALLOWED',
  'UNSUPPORTED_CURRENCY',
  'AMOUNT_OUT_OF_RANGE',
  'AMOUNT_NOT_PAYABLE',
  'EXPIRES_AT_INVALID',
  'CALLBACK_URL_REJECTED',
  'RATE_LIMITED',
  'INTERNAL',
  'UNAVAILABLE',
  'UNKNOWN_CODE',
  'UNSIGNED',
  'UNREADABLE',
  'ECHO_MISMATCH',
  'LINK_REJECTED',
  'PROTOCOL_MISMATCH',
  'CURRENCY_UNSUPPORTED',
  'ENDPOINT_MISSING',
  'CLOCK_SKEW',
] as const;
export type CustomGatewayErrorCode = (typeof CUSTOM_GATEWAY_ERROR_CODES)[number];

/**
 * The codes that describe the OPERATOR's configuration (the bridge, its secret, its account),
 * never the customer's payment: they open the route's misconfiguration condition, and the
 * customer is told the method is unavailable.
 */
export const CUSTOM_GATEWAY_CONFIGURATION_ERRORS: readonly CustomGatewayErrorCode[] = [
  'BAD_REQUEST',
  'SIGNATURE_INVALID',
  'TIMESTAMP_OUT_OF_WINDOW',
  'NONCE_REPLAYED',
  'FORBIDDEN',
  'UNSUPPORTED_CURRENCY',
  'EXPIRES_AT_INVALID',
  'CALLBACK_URL_REJECTED',
  'ECHO_MISMATCH',
  'LINK_REJECTED',
  'ENDPOINT_MISSING',
];

/**
 * A base URL an operator typed, normalised — or null when the protocol refuses it (§1, §9.1):
 * `https://` only, a host, no userinfo, no query, no fragment, no whitespace, at most 512
 * characters. A trailing `/` on the path is dropped, so `…/nexa/` and `…/nexa` are one bridge.
 * Whether the HOST may be contacted (loopback, link-local, Nexa's own networks) is the
 * installation's URL policy's question, asked by the server; this is only the shape.
 */
export function normaliseCustomGatewayBaseUrl(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0 || text.length > CUSTOM_GATEWAY_BASE_URL_MAX_LENGTH) return null;
  /*
   * Parsed by one strict pattern rather than `URL` (this package runs in the browser and the
   * server with no DOM or Node library): a scheme, a host (a DNS name or a bracketed IPv6
   * literal), an optional port and a path of unreserved characters. Userinfo (`@`), a query, a
   * fragment, a backslash and whitespace are all outside it.
   */
  const match =
    /^https:\/\/(\[[0-9A-Fa-f:]{2,39}\]|[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)(?::([0-9]{1,5}))?((?:\/[A-Za-z0-9._~%-]*)*)$/iu.exec(
      text,
    );
  if (match === null) return null;
  const host = (match[1] ?? '').toLowerCase();
  if (host.startsWith('[') && !ipv6Valid(host.slice(1, -1))) return null;
  const port = match[2];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65_535)) return null;
  const path = (match[3] ?? '').replace(/\/+$/u, '');
  // A dot segment would make the signed path and the requested one two different things.
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  return `https://${host}${port === undefined ? '' : `:${port}`}${path}`;
}

function ipv4Bytes(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/u.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

function ipv6Valid(text: string): boolean {
  // No embedded IPv4 form: it is refused rather than guessed at (the trusted-proxy rule).
  if (text.includes('.') || !/^[0-9a-f:]+$/iu.test(text)) return false;
  const halves = text.split('::');
  if (halves.length > 2) return false;
  const groupsOf = (half: string) => (half === '' ? [] : half.split(':'));
  const head = groupsOf(halves[0] ?? '');
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? '') : [];
  const groups = [...head, ...tail];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/iu.test(group))) return false;
  return halves.length === 2 ? groups.length <= 7 : groups.length === 8;
}

/**
 * One entry of a callback IP allow-list, normalised to lower case — or null. An IPv4 or IPv6
 * address, or a CIDR whose prefix is at least 1 (a `/0` would allow the whole internet, which is
 * no list at all). Protocol §9.2.
 */
export function normaliseAllowlistEntry(raw: string): string | null {
  const text = raw.trim().toLowerCase();
  if (text.length === 0 || text.length > 64) return null;
  const [address = '', prefix, ...rest] = text.split('/');
  if (rest.length > 0) return null;
  const v4 = ipv4Bytes(address) !== null;
  const v6 = !v4 && ipv6Valid(address);
  if (!v4 && !v6) return null;
  if (prefix === undefined) return text;
  if (!/^[1-9][0-9]{0,2}$/u.test(prefix)) return null;
  return Number(prefix) <= (v4 ? 32 : 128) ? text : null;
}
