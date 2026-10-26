import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { ProviderFailureKind, ProviderLastSeen } from '@nexa/contracts';

/**
 * The wire half of Nexa's own bridge protocol, v1 (R10 C2).
 *
 * `docs/protocols/custom-panel.md` IS the specification, and this module is its
 * transcription: the paths, the canonical strings, the error-code table and the strict
 * parsers. `tests/unit/custom-panel-protocol-doc.test.ts` reads the document's tables
 * and test vectors and compares them with the constants here, so the document and the
 * code cannot drift apart silently — which is the circularity a mock written beside the
 * adapter cannot break on its own (the fake and the adapter would agree with each other
 * and with nothing else).
 *
 * Pure: no I/O, no clock. The adapter supplies the time and the nonce.
 */

/** The `X-Nexa-Protocol` value and the path prefix. */
export const CUSTOM_PROTOCOL_VERSION = 1;
/** What `GET v1/health` must answer in `protocol`. */
export const CUSTOM_PROTOCOL_NAME = 'nexa-custom-panel';

export const HEALTH_PATH = 'v1/health';
export const ACCOUNTS_PATH = 'v1/accounts';

/** The account write suffixes, `v1/accounts/{username}/<suffix>`. */
export const ACCOUNT_SUFFIX = {
  allowance: 'allowance',
  disable: 'disable',
  enable: 'enable',
  delete: 'delete',
  rotateLink: 'rotate-link',
  links: 'links',
} as const;

/**
 * Every operation of the protocol: method and protocol path, `{username}` unfilled.
 * The document's §1 table, row for row (`custom-panel-protocol-doc.test.ts`).
 */
export const CUSTOM_ENDPOINTS: readonly {
  readonly method: 'GET' | 'POST';
  readonly path: string;
}[] = [
  { method: 'GET', path: `/${HEALTH_PATH}` },
  { method: 'POST', path: `/${ACCOUNTS_PATH}` },
  { method: 'GET', path: `/${ACCOUNTS_PATH}/{username}` },
  { method: 'POST', path: `/${ACCOUNTS_PATH}/{username}/${ACCOUNT_SUFFIX.allowance}` },
  { method: 'POST', path: `/${ACCOUNTS_PATH}/{username}/${ACCOUNT_SUFFIX.disable}` },
  { method: 'POST', path: `/${ACCOUNTS_PATH}/{username}/${ACCOUNT_SUFFIX.enable}` },
  { method: 'POST', path: `/${ACCOUNTS_PATH}/{username}/${ACCOUNT_SUFFIX.delete}` },
  { method: 'POST', path: `/${ACCOUNTS_PATH}/{username}/${ACCOUNT_SUFFIX.rotateLink}` },
  { method: 'GET', path: `/${ACCOUNTS_PATH}/{username}/${ACCOUNT_SUFFIX.links}` },
];

/** The account's path RELATIVE to the base URL — what the HTTP client resolves. */
export function accountPath(username: string, suffix?: string): string {
  return suffix === undefined
    ? `${ACCOUNTS_PATH}/${username}`
    : `${ACCOUNTS_PATH}/${username}/${suffix}`;
}

/** The PROTOCOL path that is signed: always `/v1/…`, never the operator's prefix (§3.2). */
export function protocolPath(relativePath: string): string {
  return `/${relativePath}`;
}

/** Request headers, lower-cased as they are sent. */
export const HEADER = {
  protocol: 'x-nexa-protocol',
  timestamp: 'x-nexa-timestamp',
  nonce: 'x-nexa-nonce',
  signature: 'x-nexa-signature',
  bridgeSignature: 'x-nexa-bridge-signature',
} as const;

/** `sha256("")`, the body hash of every GET (§3.2). */
export const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The six-line canonical request string (§3.2). No trailing newline. */
export function canonicalRequest(parts: {
  readonly method: 'GET' | 'POST';
  readonly protocolPath: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly bodySha256: string;
}): string {
  return [
    'NEXA-HMAC-SHA256',
    parts.method,
    parts.protocolPath,
    parts.timestamp,
    parts.nonce,
    parts.bodySha256,
  ].join('\n');
}

/** The four-line canonical response string (§3.4). */
export function canonicalResponse(parts: {
  readonly status: number;
  readonly nonce: string;
  readonly bodySha256: string;
}): string {
  return ['NEXA-HMAC-SHA256-RESPONSE', String(parts.status), parts.nonce, parts.bodySha256].join(
    '\n',
  );
}

/** `v1=` + lowercase hex HMAC-SHA256, keyed by the secret's UTF-8 bytes. */
export function sign(secret: string, canonical: string): string {
  return `v1=${createHmac('sha256', Buffer.from(secret, 'utf8')).update(canonical, 'utf8').digest('hex')}`;
}

/**
 * Whether a response is signed by the holder of `secret`, for THIS request's nonce.
 *
 * Constant-time over equal-length values; a header of any other shape is simply "not
 * signed". Binding the request's nonce is what stops an old answer — a signed 404 from
 * yesterday — being replayed as the answer to today's question.
 */
export function responseSignatureValid(
  secret: string,
  answer: { readonly status: number; readonly nonce: string; readonly bodyText: string },
  header: string | undefined,
): boolean {
  if (header === undefined || !/^v1=[0-9a-f]{64}$/.test(header)) return false;
  const expected = sign(
    secret,
    canonicalResponse({
      status: answer.status,
      nonce: answer.nonce,
      bodySha256: sha256Hex(answer.bodyText),
    }),
  );
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(header, 'utf8'));
}

/**
 * What a SIGNED error code means, with the one status it is valid under (§7.2).
 *
 * `NOT_FOUND` is not a failure kind: it is the positive "the panel holds no such
 * account", which each operation reads differently (absent, already gone, not found).
 *
 * A code not in this table, or one arriving with any other status, is read as
 * `PROVIDER_ERROR` — UNKNOWN for a write — never as a refusal. A refusal is DEFINITIVE
 * and a refused create is refunded; reading an unrecognised answer as one would refund
 * an account the customer may be holding. Reading it as an error costs a READ.
 */
export const CUSTOM_ERROR_CODES: Readonly<
  Record<string, { readonly status: number; readonly reading: ProviderFailureKind | 'NOT_FOUND' }>
> = {
  INVALID_REQUEST: { status: 400, reading: 'PROVIDER_REFUSED' },
  UNSUPPORTED_PROTOCOL_VERSION: { status: 400, reading: 'PROVIDER_REFUSED' },
  INVALID_SIGNATURE: { status: 401, reading: 'AUTHENTICATION_FAILED' },
  TIMESTAMP_OUT_OF_WINDOW: { status: 401, reading: 'AUTHENTICATION_FAILED' },
  NONCE_REPLAYED: { status: 401, reading: 'AUTHENTICATION_FAILED' },
  ACCOUNT_NOT_FOUND: { status: 404, reading: 'NOT_FOUND' },
  ALREADY_EXISTS: { status: 409, reading: 'PROVIDER_REFUSED' },
  ACCOUNT_NOT_BOUND: { status: 409, reading: 'PROVIDER_REFUSED' },
  IDEMPOTENCY_KEY_REUSED: { status: 409, reading: 'PROVIDER_REFUSED' },
  RULE_REFUSED: { status: 422, reading: 'PROVIDER_REFUSED' },
  RATE_LIMITED: { status: 429, reading: 'RATE_LIMITED' },
  INTERNAL_ERROR: { status: 500, reading: 'PROVIDER_ERROR' },
  UPSTREAM_UNAVAILABLE: { status: 503, reading: 'PROVIDER_ERROR' },
  UNSUPPORTED_OPERATION: { status: 501, reading: 'UNSUPPORTED_CAPABILITY' },
};

/** The reading of one SIGNED non-2xx answer, from its status and its error code. */
export function readSignedError(
  status: number,
  body: Readonly<Record<string, unknown>> | null,
): ProviderFailureKind | 'NOT_FOUND' {
  const error = body?.['error'];
  const code =
    typeof error === 'object' && error !== null && !Array.isArray(error)
      ? (error as Record<string, unknown>)['code']
      : undefined;
  if (typeof code !== 'string' || !Object.prototype.hasOwnProperty.call(CUSTOM_ERROR_CODES, code)) {
    return 'PROVIDER_ERROR';
  }
  const row = CUSTOM_ERROR_CODES[code]!;
  return row.status === status ? row.reading : 'PROVIDER_ERROR';
}

/**
 * The reading of an UNSIGNED (or wrongly signed) answer (§3.4).
 *
 * Nothing that changes what Nexa believes may rest on it. A 401/403 is what a proxy in
 * front of the bridge, or a bridge holding another secret, answers; a 429 is a rate
 * limiter; a 5xx is an error, UNKNOWN for a write. Everything else — a 2xx, a 404, any
 * other 4xx — is a malformed answer: in particular an unsigned 404 is NEVER "account not
 * found", because that is what a wrong base URL pointing at some other web server says,
 * and it is the one answer that would let Nexa create an account again.
 */
export function readUnsigned(status: number): ProviderFailureKind {
  if (status === 401 || status === 403) return 'AUTHENTICATION_FAILED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500 && status <= 599) return 'PROVIDER_ERROR';
  return 'MALFORMED_RESPONSE';
}

// --- Data types (§4) -----------------------------------------------------------------

const BYTES = /^(0|[1-9][0-9]{0,18})$/;
const MAX_BYTES = 9_223_372_036_854_775_807n;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;
const USERNAME = /^[a-z0-9_-]{4,20}$/;
const NEXA_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const ACCOUNT_STATUSES = ['ACTIVE', 'DISABLED', 'LIMITED', 'EXPIRED'] as const;
export type CustomAccountStatus = (typeof ACCOUNT_STATUSES)[number];

/** A `Bytes` value: a canonical decimal STRING, never a JSON number. */
export function parseBytes(value: unknown): bigint | null {
  if (typeof value !== 'string' || !BYTES.test(value)) return null;
  const parsed = BigInt(value);
  return parsed > MAX_BYTES ? null : parsed;
}

/** `Bytes` on the wire. */
export function formatBytes(value: bigint): string {
  return value.toString();
}

/** A `Timestamp`: RFC 3339, UTC `Z` only, a real calendar date. */
export function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const match = TIMESTAMP.exec(value);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const millis = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3));
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
  if (at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  return at;
}

/** A `Timestamp` on the wire: seconds precision, `Z`. Sub-second parts are dropped. */
export function formatTimestamp(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The instant a `Timestamp` Nexa sends denotes, for comparison with what comes back. */
export function toWireSecond(at: Date): number {
  return Math.floor(at.getTime() / 1000);
}

/** The `Account` object (§4.1), parsed. */
export interface CustomAccount {
  readonly username: string;
  readonly nexaRef: string | null;
  readonly status: CustomAccountStatus;
  readonly trafficUsedBytes: bigint;
  readonly trafficLimitBytes: bigint;
  readonly expiresAt: Date | null;
  readonly deviceLimit: number | null;
  readonly lastConnection: ProviderLastSeen;
  readonly subscriptionUrl: string;
}

/**
 * One `Account` object, strictly, or null.
 *
 * Every required field must be present and well-formed, and `username` must be the
 * one asked about: an answer about another account is not an answer about this one.
 * Null is `MALFORMED_RESPONSE` to the caller — never a partial account with a figure
 * filled in, because a fabricated zero is a wrong statement about a customer's traffic.
 */
export function parseAccount(value: unknown, expectedUsername: string): CustomAccount | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  const username = record['username'];
  if (typeof username !== 'string' || !USERNAME.test(username) || username !== expectedUsername) {
    return null;
  }
  const nexaRef = record['nexaRef'];
  if (!(nexaRef === null || (typeof nexaRef === 'string' && NEXA_REF.test(nexaRef)))) return null;
  const status = record['status'];
  if (typeof status !== 'string' || !(ACCOUNT_STATUSES as readonly string[]).includes(status)) {
    return null;
  }
  const used = parseBytes(record['trafficUsedBytes']);
  const limit = parseBytes(record['trafficLimitBytes']);
  if (used === null || limit === null) return null;

  if (!Object.prototype.hasOwnProperty.call(record, 'expiresAt')) return null;
  const rawExpiry = record['expiresAt'];
  const expiresAt = rawExpiry === null ? null : parseTimestamp(rawExpiry);
  if (rawExpiry !== null && expiresAt === null) return null;

  if (!Object.prototype.hasOwnProperty.call(record, 'deviceLimit')) return null;
  const deviceLimit = record['deviceLimit'];
  if (!(
    deviceLimit === null ||
    (typeof deviceLimit === 'number' &&
      Number.isInteger(deviceLimit) &&
      deviceLimit >= 1 &&
      deviceLimit <= 1000)
  )) {
    return null;
  }

  const lastConnection = parseLastConnection(record['lastConnection']);
  if (lastConnection === null) return null;

  const subscriptionUrl = parseSubscriptionUrl(record['subscriptionUrl']);
  if (subscriptionUrl === null) return null;

  return {
    username,
    nexaRef,
    status: status as CustomAccountStatus,
    trafficUsedBytes: used,
    trafficLimitBytes: limit,
    expiresAt,
    deviceLimit,
    lastConnection,
    subscriptionUrl,
  };
}

function parseLastConnection(value: unknown): ProviderLastSeen | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record['supported'] === false) return { kind: 'UNSUPPORTED' };
  if (record['supported'] !== true) return null;
  if (!Object.prototype.hasOwnProperty.call(record, 'at')) return null;
  if (record['at'] === null) return { kind: 'NEVER' };
  const at = parseTimestamp(record['at']);
  return at === null ? null : { kind: 'AT', at };
}

/** An absolute `https` link of at most 2048 characters — what the customer receives. */
function parseSubscriptionUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  if (/\s/.test(value)) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return parsed.protocol === 'https:' && parsed.hostname.length > 0 ? value : null;
}

/** Bounded and character-restricted: persisted and shown to an operator (§5.1). */
export function safeBridgeVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  return /^[A-Za-z0-9._+-]+$/.test(trimmed) ? trimmed : null;
}

/** A JSON object, or null. Never throws and never carries the body forward. */
export function parseJsonObject(bodyText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
