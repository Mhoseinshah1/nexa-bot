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
 * Secrets inside FREE TEXT, as opposed to inside a key.
 *
 * `redactSecrets` matches on keys, which is the right rule for a structured
 * record and no rule at all for a sentence. A transport's error text is a
 * sentence, and Telegram's happens to be the one place a bot token can appear
 * in one: its API errors quote the request URL, and the token is a path segment
 * of that URL. The attempt table is append-only and is returned over HTTP, so a
 * token that lands there cannot be taken back out.
 *
 * Three patterns, and no pretence of more:
 *
 *   - a Telegram bot token, `<digits>:<35 or so opaque characters>`;
 *   - a `name=value` or `name: value` pair whose NAME is sensitive by the same
 *     fragment list the key rule uses;
 *   - an `Authorization: Bearer …` credential.
 *
 * What this does NOT do is find an unlabelled secret in prose — a bare
 * high-entropy string with nothing around it to identify it. That is not
 * solvable by matching, and claiming otherwise would be the kind of comment
 * this codebase has already had to correct once.
 */
const TELEGRAM_BOT_TOKEN = /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g;
const LABELLED_SECRET = new RegExp(
  String.raw`\b([A-Za-z0-9_.-]*(?:${SENSITIVE_FRAGMENTS.join('|')}|api[_-]?key)[A-Za-z0-9_.-]*)` +
    String.raw`(\s*[=:]\s*)("?)([^\s"'&]+)\3`,
  'gi',
);
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

export function redactSecretText(text: string): string {
  return text
    .replace(TELEGRAM_BOT_TOKEN, REDACTED)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(LABELLED_SECRET, (_match, name: string, separator: string) =>
      `${name}${separator}${REDACTED}`,
    );
}

/** Convenience for the nullable `before`/`after` audit columns. */
export function redactRecord(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return value === null ? null : (redactSecrets(value) as Record<string, unknown>);
}
