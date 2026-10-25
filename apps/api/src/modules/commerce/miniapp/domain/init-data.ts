import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  MINIAPP_INIT_DATA_CLOCK_SKEW_SECONDS,
  MINIAPP_INIT_DATA_MAX_LENGTH,
} from '@nexa/contracts';

/**
 * Telegram Mini App `initData` verification (Round 9, C5), exactly as Telegram specifies it
 * ("Validating data received via the Mini App"):
 *
 *   data_check_string = every received field EXCEPT `hash`, as `key=value` with the value
 *                       URL-decoded, sorted by key, joined by "\n"
 *   secret_key        = HMAC_SHA256(key = "WebAppData", message = bot_token)
 *   hash              = hex(HMAC_SHA256(key = secret_key, message = data_check_string))
 *
 * A pure function of the string, the bot's token and "now". Nothing here trusts anything
 * the client sent beyond the signed fields: the bot is not named in `initData` at all, so
 * verifying against the token of the bot the URL names is what proves which bot launched it
 * — a launch from another bot fails the HMAC like a forgery does. `signature` (Telegram's
 * third-party Ed25519 field) is an ordinary field here and is covered by the HMAC.
 *
 * Refusals are coarse on purpose (`INVALID`, `EXPIRED`): which part of a forged launch was
 * wrong is not something a caller is told.
 */

/** The verified user, as Telegram's `WebAppUser` — the same shape as an update's `from`. */
export interface InitDataUser {
  readonly id: number;
  readonly is_bot?: boolean;
  readonly first_name?: string;
  readonly last_name?: string;
  readonly username?: string;
  readonly language_code?: string;
  readonly is_premium?: boolean;
}

export type InitDataVerdict =
  | {
      readonly outcome: 'VALID';
      /** The launch's own `hash` field, lower-case hex: the replay key. */
      readonly hash: string;
      readonly authDate: Date;
      readonly user: InitDataUser;
      /** The raw `user` object as Telegram signed it, handed on as an update's `from`. */
      readonly from: Record<string, unknown>;
    }
  | { readonly outcome: 'INVALID' }
  | { readonly outcome: 'EXPIRED' };

const HASH_SHAPE = /^[0-9a-f]{64}$/u;
const AUTH_DATE_SHAPE = /^[1-9][0-9]{0,11}$/u;

/** `HMAC_SHA256("WebAppData", token)`: the key the launch's hash is made with. */
export function initDataSecretKey(botToken: string): Buffer {
  return createHmac('sha256', 'WebAppData').update(botToken).digest();
}

/**
 * The fields of a launch as Telegram sent them, URL-decoded, or null when the string is not
 * a well-formed query (a key repeated, an undecodable escape, an empty key). A repeated key
 * is refused rather than resolved: two values for one signed field leave "which one was
 * signed" to whoever reads it second.
 */
export function parseInitData(raw: string): ReadonlyMap<string, string> | null {
  if (raw.length === 0 || raw.length > MINIAPP_INIT_DATA_MAX_LENGTH) return null;
  const fields = new Map<string, string>();
  for (const pair of raw.split('&')) {
    if (pair === '') return null;
    const at = pair.indexOf('=');
    const rawKey = at === -1 ? pair : pair.slice(0, at);
    const rawValue = at === -1 ? '' : pair.slice(at + 1);
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/gu, ' '));
      value = decodeURIComponent(rawValue.replace(/\+/gu, ' '));
    } catch (error) {
      if (error instanceof URIError) return null;
      throw error;
    }
    if (key === '' || fields.has(key)) return null;
    fields.set(key, value);
  }
  return fields;
}

/** Telegram's data-check-string: every field but `hash`, `key=value`, sorted by key, "\n"-joined. */
export function dataCheckString(fields: ReadonlyMap<string, string>): string {
  return [...fields.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/** The hash Telegram would have put on these fields for this bot, lower-case hex. */
export function expectedInitDataHash(
  fields: ReadonlyMap<string, string>,
  botToken: string,
): string {
  return createHmac('sha256', initDataSecretKey(botToken))
    .update(dataCheckString(fields))
    .digest('hex');
}

/**
 * Constant-time comparison of two 64-hex hashes. Both are decoded to 32 bytes first, so the
 * comparison never short-circuits on the first different character and never sees two
 * lengths (the shape was checked before this is called).
 */
export function hashesMatch(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== 32 || b.length !== 32) return false;
  return timingSafeEqual(a, b);
}

/**
 * The whole verdict on one launch.
 *
 * Order matters and is the cheap-first order: shape, then the HMAC (nothing below it is
 * read from an unsigned string), then the freshness window, then the user. An `auth_date`
 * more than `MINIAPP_INIT_DATA_CLOCK_SKEW_SECONDS` in the future is EXPIRED too: a launch
 * signed "later than now" is not one Telegram made for this moment.
 */
export function verifyInitData(input: {
  readonly raw: string;
  readonly botToken: string;
  readonly now: Date;
  readonly maxAgeSeconds: number;
}): InitDataVerdict {
  const fields = parseInitData(input.raw);
  if (fields === null) return { outcome: 'INVALID' };
  const supplied = fields.get('hash');
  if (supplied === undefined || !HASH_SHAPE.test(supplied)) return { outcome: 'INVALID' };
  if (!hashesMatch(supplied, expectedInitDataHash(fields, input.botToken))) {
    return { outcome: 'INVALID' };
  }

  const authDateText = fields.get('auth_date');
  if (authDateText === undefined || !AUTH_DATE_SHAPE.test(authDateText)) {
    return { outcome: 'INVALID' };
  }
  const authSeconds = Number(authDateText);
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  if (authSeconds > nowSeconds + MINIAPP_INIT_DATA_CLOCK_SKEW_SECONDS)
    return { outcome: 'EXPIRED' };
  if (nowSeconds - authSeconds > input.maxAgeSeconds) return { outcome: 'EXPIRED' };

  const userText = fields.get('user');
  if (userText === undefined) return { outcome: 'INVALID' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(userText);
  } catch (error) {
    if (error instanceof SyntaxError) return { outcome: 'INVALID' };
    throw error;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { outcome: 'INVALID' };
  }
  const from = parsed as Record<string, unknown>;
  const id = from['id'];
  // Identity is read strictly, as the webhook reads `from.id`: a bot is not a customer.
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return { outcome: 'INVALID' };
  if (from['is_bot'] === true) return { outcome: 'INVALID' };

  return {
    outcome: 'VALID',
    hash: supplied,
    authDate: new Date(authSeconds * 1000),
    user: from as unknown as InitDataUser,
    from,
  };
}
