/**
 * One redactor, used everywhere a secret could escape.
 *
 * Before this existed there were two implementations with different semantics —
 * substring matching in the audit writer, exact paths in the pino config — and
 * both had holes: neither traversed arrays, and the audit writer's key
 * normalisation stripped every non-ASCII character, so a key that was not plain
 * ASCII normalised toward the empty string and matched nothing.
 *
 * Rules:
 *   - Traverse objects AND arrays. A credential inside a list is still a credential.
 *   - Match on a normalised key, and treat a key that normalises to nothing as
 *     sensitive rather than safe. Failing closed is the only sane default here.
 *   - Bound the recursion and track visited objects, so a deep or cyclic value
 *     cannot throw inside a business transaction.
 */

export const REDACTED = '[redacted]';

/** Substrings that mark a key as carrying a secret. */
const SENSITIVE_FRAGMENTS = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'authorization',
  'auth',
  'credential',
  'ciphertext',
  'kek',
  'privatekey',
  'signature',
  'cookie',
  'session',
];

const MAX_DEPTH = 12;

/**
 * Normalises a key for matching. NFKD folds compatibility forms, and digits are
 * kept so `t0ken` still normalises to something comparable rather than being
 * silently shortened past recognition.
 */
export function normaliseKey(key: string): string {
  return key
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** Anything outside printable ASCII after NFKD folding. */
const UNASSESSABLE = /[^\x20-\x7E]/;

export function isSensitiveKey(key: string): boolean {
  const folded = key.normalize('NFKD');

  // A key we cannot read, we cannot clear. Both an entirely non-Latin key
  // (`توکن`) and a homoglyph (`tоken`, with a Cyrillic о) survive normalisation
  // as something that matches no fragment — the first as an empty string, the
  // second as `tken`. Redacting both is the only safe reading: a false positive
  // costs a log line, a false negative costs a secret.
  if (UNASSESSABLE.test(folded)) return true;

  const normalised = normaliseKey(key);
  if (normalised.length === 0) return true;

  // Known limitation: a deliberately obfuscated ASCII key (`t0ken`) is not
  // matched. Keys here are machine-authored, so this is a real gap only if
  // tenant-supplied keys ever reach `before`/`after`, which they must not.
  return SENSITIVE_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (value === null || typeof value !== 'object') return value;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1, seen);
  }
  return out;
}

/** Redacts a structured value in place of writing it anywhere durable. */
export function redactSecrets<T>(value: T): T {
  return redactValue(value, 0, new WeakSet()) as T;
}

/**
 * Key fragments that mark a secret when they label a value in FREE TEXT.
 *
 * A SEPARATE, narrower list than `SENSITIVE_FRAGMENTS`, and the difference is
 * the point. The key rule can afford to over-match — a false positive there
 * costs one field of a structured record. In prose it costs the operator the
 * sentence they needed: with the key list, `author: alice reported it` became
 * `author: [redacted] reported it` (`auth`), and `kekw: 5` lost its number.
 * So bare `auth` and `kek` are not here, while everything that names a
 * credential outright is.
 */
const TEXT_SENSITIVE_FRAGMENTS = [
  'token',
  'secret',
  'password',
  'passwd',
  'apikey',
  'api_key',
  'api-key',
  'authorization',
  'credential',
  'ciphertext',
  'privatekey',
  'signature',
  'cookie',
  'session',
];

/**
 * Secrets inside FREE TEXT, as opposed to inside a key.
 *
 * `redactSecrets` matches on keys, which is the right rule for a structured
 * record and no rule at all for a sentence. A transport's error text is a
 * sentence, and it can carry a bot token: the token is a path segment of the
 * request URL, and `fetch` quotes that URL verbatim in its own `TypeError`
 * when the URL will not parse — so a misconfigured API base produces
 * `Failed to parse URL from https://api.telegram.org:99999/bot<token>/…`, which
 * `TelegramTransport` catches and passes on as the attempt's error message.
 * (Telegram's own API errors carry only a `description` and no URL; an earlier
 * version of this comment attributed the vector to them, which was wrong and
 * would have made this function look unnecessary to anyone who checked.) The
 * attempt table is append-only and is returned over HTTP, so a token that lands
 * there cannot be taken back out.
 *
 * Three patterns:
 *
 *   - a Telegram bot token, `<digits>:<20 or more opaque characters>`;
 *   - a `name=value` or `name: value` pair whose NAME is sensitive, INCLUDING
 *     the JSON spelling `"name": "value"` and single-quoted values. Those two
 *     were the first version's real gap, and it went unnoticed because the
 *     docblock listed a limitation ("an unlabelled secret in prose") that was
 *     not the gap: `{"token":"…"}` is a labelled secret in exactly the shape
 *     the rule claimed to cover, and it passed through untouched;
 *   - an `Authorization: Bearer …` credential, and a bare `Bearer …`.
 *
 * What this genuinely does NOT do is find an unlabelled secret in prose — a
 * bare high-entropy string with nothing around it to identify it. That is not
 * solvable by matching.
 */
const TELEGRAM_BOT_TOKEN = /\d{5,}:[A-Za-z0-9_-]{20,}/g;

// The name's quotes are captured so they can be put back: redacting inside a
// JSON fragment should leave something a person still recognises as JSON.
//
// Both character classes are BOUNDED. Unbounded `[A-Za-z0-9_.-]*` either side
// of an alternation backtracks quadratically — measured at five seconds on a
// 64 KB input of `a.a.a.…token` — and this function is exported, so the next
// caller would have inherited that without the one existing caller's slice.
const LABELLED_SECRET = new RegExp(
  String.raw`(["']?)([A-Za-z0-9_.-]{0,64}(?:` +
    TEXT_SENSITIVE_FRAGMENTS.map(escapeForRegExp).join('|') +
    String.raw`)[A-Za-z0-9_.-]{0,64})(["']?)(\s*[=:]\s*)` +
    String.raw`("[^"]{0,4096}"|'[^']{0,4096}'|(?:Bearer\s+)?[^\s"',&}]{1,4096})`,
  'gi',
);

/** An unlabelled bearer credential, for text that does not name the header. */
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]{4,}=*/g;

/**
 * A fragment as a literal, not as a pattern.
 *
 * The list is interpolated into a `RegExp`, and every entry today is
 * `[a-z_-]+` so nothing needs escaping — which is exactly why the escape has
 * to be here rather than assumed: the day somebody adds `x.509` or `api(v2)`
 * the alternation would either silently change meaning or throw at module
 * load. A unit test asserts the list stays simple; this makes the failure
 * impossible rather than merely detected.
 */
function escapeForRegExp(fragment: string): string {
  return fragment.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

/** The longest text this will scan. Beyond it, matching is not worth the pause. */
const MAX_REDACTABLE_LENGTH = 8_000;

export function redactSecretText(text: string): string {
  // Bounded HERE rather than at the call site. The one caller today slices to
  // 2 000 characters, but this is exported and the cost of a long input is
  // paid on the event loop.
  const bounded = text.length > MAX_REDACTABLE_LENGTH ? text.slice(0, MAX_REDACTABLE_LENGTH) : text;

  return bounded
    .replace(TELEGRAM_BOT_TOKEN, REDACTED)
    .replace(
      LABELLED_SECRET,
      (_match, openQuote: string, name: string, closeQuote: string, separator: string) =>
        `${openQuote}${name}${closeQuote}${separator}${REDACTED}`,
    )
    .replace(BEARER, `Bearer ${REDACTED}`);
}

/** Every fragment the text rule interpolates, for the test that keeps it simple. */
export const TEXT_SENSITIVE_FRAGMENTS_FOR_TEST: readonly string[] = TEXT_SENSITIVE_FRAGMENTS;

/** Convenience for the nullable `before`/`after` audit columns. */
export function redactRecord(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return value === null ? null : (redactSecrets(value) as Record<string, unknown>);
}
