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
 *   - an authorization credential, labelled or bare, for any of the schemes in
 *     `AUTH_SCHEMES`. Naming only `Bearer` was a bug rather than a
 *     simplification: `Authorization: Basic dXNlcjpwYXNz` matched the labelled
 *     rule with `Basic` as its whole value, so the credential after it was
 *     stored verbatim — and the same held for `Digest`, `Token` and every
 *     other scheme. A rule about one scheme is not a rule about the header.
 *
 * What this genuinely does NOT do is find an unlabelled secret in prose — a
 * bare high-entropy string with nothing around it to identify it. That is not
 * solvable by matching.
 */
const TELEGRAM_BOT_TOKEN = /\d{5,}:[A-Za-z0-9_-]{20,}/g;

/**
 * Names whose value is an authorization credential, whatever scheme it uses.
 *
 * For these, the redaction takes the REST OF THE LINE rather than one
 * whitespace-delimited token. Two attempts at this were wrong in the same way:
 * the first named `Bearer`, the second named seven schemes, and both left the
 * credential behind for the eighth. `Authorization: SSWS 00QCjAl4MlV-WPXM`
 * (Okta), `NTLM`, `DPoP`, `SCRAM-SHA-256`, `GoogleLogin` — each redacted the
 * scheme word and stored the secret after it. A list of schemes cannot be
 * right, because the set is open; what is closed is the set of HEADER NAMES
 * whose entire value is a credential.
 */
const CREDENTIAL_HEADER_LINE = /((?:proxy-)?authorization)(\s*[=:]\s*)[^\r\n]+/gi;

/**
 * Schemes for the UNLABELLED rule, where a list IS the right conservatism:
 * there is no name to tell us the line is a credential, so the scheme word is
 * the only evidence.
 *
 * Case-SENSITIVE, and deliberately short. `Token`, `Mutual` and `ApiKey` are
 * ordinary English words, and with the `i` flag they turned
 * `token expired for tenant 019abc` into `token [redacted] for tenant 019abc`
 * — eating the operator's sentence, which is the harm the list was introduced
 * to avoid. All three are already covered by the labelled rule via `token` and
 * `apikey`, so dropping them here costs nothing.
 */
const BARE_SCHEMES = ['Bearer', 'Basic', 'Digest', 'Negotiate'];

/**
 * Schemes recognised as the START OF A VALUE, under any header name.
 *
 * `X-Auth-Token: Token abc123def456` names no credential header, so the
 * labelled rule would otherwise take only `Token` and leave the credential.
 * Wider than `BARE_SCHEMES` because here there IS a sensitive name in front of
 * it — the evidence is stronger, so the list can be.
 */
const ANY_SCHEME = `(?:${[...BARE_SCHEMES, 'Token', 'ApiKey', 'Mutual', 'SSWS', 'NTLM', 'DPoP'].join('|')})`;

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
    // A quoted value in full, spaces included; or a quoted run whose closing
    // quote is NOT within the bound; or a known scheme plus the credential
    // after it; or one whitespace-delimited token.
    //
    // That third alternative is the fail-closed one. Without it a
    // `privateKey="<5000 characters>"` matched nothing at all — the bounded
    // quoted alternatives need their terminator inside 4 096, and the unquoted
    // alternative refuses to begin at a quote — so the value was returned
    // untouched and `redactErrorMessage` then stored its first 2 000
    // characters. A bound that makes a matcher give up has to make it give up
    // by redacting more, never by redacting nothing.
    //
    // NOT "everything to the end of the line". That was tried, and it made this
    // rule match once per LINE rather than once per secret: the first match
    // swallowed the rest, so `api_key=… and password: hunter2` lost the api key
    // and kept the password. The end-of-line case belongs to
    // `CREDENTIAL_HEADER_LINE`, which is the only place the whole remainder is
    // known to be one value.
    String.raw`("[^"]{0,4096}"|'[^']{0,4096}'|["'][^\r\n]{0,8192}|(?:${ANY_SCHEME}\s+)?[^\s"',&}]{1,4096})`,
  'gi',
);

/**
 * An unlabelled credential, for text that does not name the header.
 *
 * The credential has to LOOK like one: at least eight characters, and at least
 * one that is not a letter. Four was too loose in both directions —
 * `Basic auth failed for user alice` lost `auth`, `Digest mismatch: …` lost
 * `mismatch`, and `Negotiate handshake failed` lost `handshake`, because those
 * are ordinary words after ordinary words.
 *
 * The known miss is an unlabelled scheme followed by base64 that happens to be
 * all letters (`Basic dXNlcjpwYXNz`). Realistic base64 carries digits or
 * `+/=`, and the labelled form — which is how a header appears when a client
 * quotes one — is covered by the credential-header rule above. Stated because
 * a gap named is worth more than a gap implied.
 */
const BARE_CREDENTIAL = new RegExp(
  String.raw`\b(?:${BARE_SCHEMES.join('|')})\s+` +
    String.raw`(?=[A-Za-z0-9._~+/-]*[0-9._~+/-])[A-Za-z0-9._~+/-]{8,}=*`,
  'g',
);

/**
 * A credential-shaped token sitting immediately after a redaction marker.
 *
 * This is the general answer to "the value was `<scheme> <secret>` and the
 * scheme is not one we name". Rather than trying to enumerate schemes — a set
 * that is open, and that this module has now guessed wrong at three times — it
 * observes that whatever was redacted swallowed only the first token, and asks
 * whether the NEXT one looks like a credential: at least eight characters with
 * something in it that is not a letter.
 *
 * `token: abc reported by alice` keeps its sentence, because `reported` is
 * letters. `token=GoogleLogin sk-live-ZQ7hV2…` does not, because the thing
 * after the scheme is plainly not a word.
 */
const TRAILING_CREDENTIAL = new RegExp(
  `(${escapeForRegExp(REDACTED)})` +
    String.raw`\s+` +
    String.raw`(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,}`,
  'g',
);

/**
 * Whether a value BEGINS with an authorization scheme.
 *
 * `X-Auth-Token: Token abc123def456` is not one of the two credential header
 * names, so only its first whitespace-delimited token would be taken — which
 * is the scheme, leaving the credential. When the value opens with a scheme,
 * the whole value is the credential whatever the header is called.
 */

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
  //
  // The tail is DROPPED rather than passed through, and that is the whole
  // point. `redactErrorMessage` was corrected to redact before truncating,
  // because slicing at a fixed offset can cut a bot token below the pattern's
  // length threshold and store the surviving half — and this bound would have
  // reintroduced exactly that at 8 000 for the next caller. Unscanned text is
  // not text this function may return.
  if (text.length > MAX_REDACTABLE_LENGTH) {
    return `${redactSecretText(text.slice(0, MAX_REDACTABLE_LENGTH))}… [${text.length - MAX_REDACTABLE_LENGTH} characters not scanned and dropped]`;
  }
  const bounded = text;

  return (
    bounded
      .replace(TELEGRAM_BOT_TOKEN, REDACTED)
      // FIRST, because a credential header's whole value is the credential
      // whatever scheme it names, and the labelled rule below would otherwise
      // take only its first token.
      .replace(
        CREDENTIAL_HEADER_LINE,
        (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`,
      )
      .replace(
        LABELLED_SECRET,
        (
          _match,
          openQuote: string,
          name: string,
          closeQuote: string,
          separator: string,
          value: string,
        ) => {
          // The value's quotes come back as quotes. `{"token":[redacted]}` does
          // not parse, and the comment above promises something a person still
          // recognises as JSON.
          const replacement = /^["']/.test(value) ? `"${REDACTED}"` : REDACTED;
          return `${openQuote}${name}${closeQuote}${separator}${replacement}`;
        },
      )
      .replace(BARE_CREDENTIAL, (match) => `${/^\S+/.exec(match)?.[0] ?? ''} ${REDACTED}`)
      // LAST, so it can see what every pass above left behind.
      .replace(TRAILING_CREDENTIAL, '$1')
  );
}

/** Every fragment the text rule interpolates, for the test that keeps it simple. */
export const TEXT_SENSITIVE_FRAGMENTS_FOR_TEST: readonly string[] = TEXT_SENSITIVE_FRAGMENTS;

/** Convenience for the nullable `before`/`after` audit columns. */
export function redactRecord(
  value: Record<string, unknown> | null,
): Record<string, unknown> | null {
  return value === null ? null : (redactSecrets(value) as Record<string, unknown>);
}
