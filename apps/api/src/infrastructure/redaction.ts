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
  // A Recovery Kit passphrase (ADR-0032) unlocks every key-encryption key.
  'passphrase',
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
  /*
   * Customer UX completion §A14. A subscription URL is a bearer capability — whoever
   * holds it is the customer — and `subscription_ref` is the panel's half of it. Nothing
   * legitimately writes either into a log, an audit row or an operational event (the
   * rotation audit and its event carry the customer id and the delivery state only), so
   * the key rule fails closed on the whole family rather than trusting every future
   * call site to remember.
   */
  'subscription',
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

/** How many values one call will visit before it stops descending. */
const MAX_NODES = 5_000;
/** How many entries of one Map, Set or array a LOG line renders. */
const MAX_COLLECTION_ENTRIES = 100;
/** How many stack lines a log line keeps. */
const MAX_STACK_LINES = 60;

interface RedactState {
  /**
   * The ANCESTORS of the value being visited, not every value seen so far. A WeakSet of
   * everything visited reported a value referenced twice — `{ err, cause: err.cause }`, or
   * one error inside two AggregateErrors — as `[circular]` on its second appearance, which
   * hid the cause from the operator although nothing was circular. `MAX_NODES` is what
   * bounds a value that is wide rather than deep.
   */
  readonly ancestors: Set<object>;
  /**
   * FIX-04 (S1): whether a STRING is redacted by its content as well as by its key. The
   * process log turns this on — a message, a stack, a provider's error text is a sentence,
   * and a key rule says nothing about a sentence. The durable writers (audit before/after,
   * operational events) keep the key rule alone: their values are structured records an
   * operator has to read back as they were written, a panel address included.
   */
  readonly content: boolean;
  nodes: number;
}

function redactValue(value: unknown, depth: number, state: RedactState): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  // The node budget is the LOG's: a log line is paid for on the event loop of
  // every request. A durable record keeps the depth bound it always had.
  state.nodes += 1;
  if (state.content && state.nodes > MAX_NODES) return '[truncated]';
  if (typeof value === 'string') return state.content ? redactSecretText(value) : value;
  if (value === null || typeof value !== 'object') return value;

  if (state.ancestors.has(value)) return '[circular]';
  state.ancestors.add(value);
  try {
    return redactObject(value, depth, state);
  } finally {
    state.ancestors.delete(value);
  }
}

/** Whether a key, read as TEXT, is itself a credential (a map keyed by token). */
function keyIsSecretText(key: string, state: RedactState): boolean {
  return state.content && redactSecretText(key) !== key;
}

function redactEntries(
  value: object,
  depth: number,
  state: RedactState,
  out: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // The pair was the secret: the key is replaced, and so is its value.
    if (keyIsSecretText(key, state)) {
      out[REDACTED] = REDACTED;
      continue;
    }
    out[key] = isSensitiveKey(key) ? REDACTED : redactValue(item, depth + 1, state);
  }
  return out;
}

function redactObject(value: object, depth: number, state: RedactState): unknown {
  if (Array.isArray(value)) {
    const items = state.content ? value.slice(0, MAX_COLLECTION_ENTRIES) : value;
    const out = items.map((item) => redactValue(item, depth + 1, state));
    if (items.length < value.length) out.push(`[${String(value.length - items.length)} more]`);
    return out;
  }

  // An Error keeps `message` and `stack` as NON-ENUMERABLE own properties, so
  // the `Object.entries` rebuild below drops both and returns `{}`.
  //
  // That is not a cosmetic loss. Every unattended failure in this codebase is
  // reported by logging the error object — `panel monitor tick failed`,
  // `panel monitor probe failed`, the retention sweeper — and each of them was
  // reaching the operator as `"err":{}`. The heartbeat correctly went stale and
  // the container correctly went unhealthy; the one line that said WHY had been
  // emptied on the way out. A `NexaError` fared slightly better and still lost
  // its message, because `name`, `kind` and `code` happen to be enumerable.
  //
  // The copied fields are then redacted BY CONTENT, whatever mode the caller
  // asked for: an error's message is the most likely place for a secret to appear
  // by accident, and its stack repeats the message on its first line. FIX-04 (S1):
  // an earlier version said so and did not do it — the message went through the
  // key rule, which returns every string untouched, and the stack was copied
  // verbatim — so `fetch`'s "Failed to parse URL from …/bot<token>/…" reached the
  // log twice.
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: redactSecretText(String(value.name)),
      message: redactSecretText(String(value.message)),
    };
    if (typeof value.stack === 'string') out['stack'] = redactStack(value.stack);
    redactEntries(value, depth, state, out);
    // `cause` and an AggregateError's `errors` are own NON-ENUMERABLE properties,
    // so the entries above never see them — and each is the failure's real reason.
    if (value.cause !== undefined) out['cause'] = redactValue(value.cause, depth + 1, state);
    const errors: unknown = (value as { errors?: unknown }).errors;
    if (Array.isArray(errors) && !('errors' in out)) {
      out['errors'] = redactValue(errors, depth + 1, state);
    }
    return out;
  }

  if (state.content) {
    // FIX-04 (S5): what the LOG makes of values JSON cannot represent. A Map and a
    // Set enumerate nothing and became `{}`; a Buffer became an object of its bytes,
    // content included; a Date became `{}`.
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      const name = typeof value.constructor === 'function' ? value.constructor.name : 'binary';
      return `[${name} ${String(value.byteLength)} bytes]`;
    }
    if (value instanceof Map) {
      const entries: Record<string, unknown> = {};
      let shown = 0;
      for (const [key, item] of value as Map<unknown, unknown>) {
        if (shown >= MAX_COLLECTION_ENTRIES) break;
        shown += 1;
        const label =
          typeof key === 'string' ? key : JSON.stringify(redactValue(key, depth + 1, state));
        if (keyIsSecretText(label, state)) {
          entries[REDACTED] = REDACTED;
          continue;
        }
        entries[label] = isSensitiveKey(label) ? REDACTED : redactValue(item, depth + 1, state);
      }
      return { type: 'Map', size: value.size, entries };
    }
    if (value instanceof Set) {
      const values: unknown[] = [];
      for (const item of value as Set<unknown>) {
        if (values.length >= MAX_COLLECTION_ENTRIES) break;
        values.push(redactValue(item, depth + 1, state));
      }
      return { type: 'Set', size: value.size, values };
    }
    if (value instanceof URL || value instanceof RegExp) return redactSecretText(String(value));
  }

  return redactEntries(value, depth, state, {});
}

/**
 * A stack, kept useful and made safe. Its first lines are the error's `Name: message`,
 * which is free text and is redacted as such. A frame line that is EXACTLY the shape V8
 * writes — `at fn (path:line:col)` with nothing in the path but path characters — is kept
 * verbatim, because the file and line are why a stack is logged at all, and the text rule
 * would otherwise read `session.service.js:42:7` as a label and its value. Any other line
 * is redacted as text: a frame is not where a secret is expected, which is not the same as
 * a place one cannot be.
 */
const SAFE_STACK_FRAME =
  /^\s{1,16}at (?:async )?(?:(?:new )?[^\s()]{1,256}(?: \[as [^\]\s]{1,64}\])? \()?(?:file:\/\/\/?|node:)?[A-Za-z0-9_./@+~\\-]{1,512}(?::\d{1,7}){1,2}\)?$|^\s{1,16}at (?:async )?(?:[^\s()]{1,256} \()?<anonymous>\)?$/;

export function redactStack(stack: string): string {
  const lines = stack.split('\n');
  const kept = lines.slice(0, MAX_STACK_LINES);
  const firstFrame = kept.findIndex((line) => /^\s+at /.test(line));
  const headerEnd = firstFrame === -1 ? kept.length : firstFrame;
  const header = redactSecretText(kept.slice(0, headerEnd).join('\n'));
  const frames = kept
    .slice(headerEnd)
    .map((line) => (SAFE_STACK_FRAME.test(line) ? line : redactSecretText(line)));
  const dropped = lines.length - kept.length;
  const tail = dropped > 0 ? [`    … ${String(dropped)} more lines`] : [];
  return [header, ...frames, ...tail].join('\n');
}

/**
 * Redacts a structured value by KEY before it is written anywhere durable — an audit row's
 * before/after, an operational event's context. A string is returned as written, except
 * inside an Error, whose message and stack are always redacted by content.
 */
export function redactSecrets<T>(value: T): T {
  return redactValue(value, 0, { ancestors: new Set(), content: false, nodes: 0 }) as T;
}

/**
 * FIX-04 (S1): the PROCESS LOG's redactor — the key rule above AND every string by its
 * content (`redactSecretText`), at any depth, inside arrays, Maps, Sets and errors. A log
 * line is the one destination where a sentence and a record arrive together, and before
 * this only the record's keys were judged: a token in the message argument, in a stack,
 * or in a nested provider text reached stdout verbatim.
 */
export function redactForLog<T>(value: T): T {
  return redactValue(value, 0, { ancestors: new Set(), content: true, nodes: 0 }) as T;
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
  // A Recovery Kit passphrase (ADR-0032) unlocks every key-encryption key.
  'passphrase',
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
  /*
   * A subscription URL is a bearer capability and `subscription_ref` the panel's half of it
   * (the `subscription` entry of `SENSITIVE_FRAGMENTS`). Here the COMPOUND names only, in
   * each spelling the codebase and the panels use — `subscriptionUrl`, `subscription_url`,
   * `subscription-ref`, … (the pattern is case-insensitive). Bare `subscription` stays out
   * for the reason bare `auth` does: `subscription: renewed` is an operator's sentence. A
   * bare `subscription` label is still caught when its value is a URL, by
   * `SUBSCRIPTION_URL_VALUE` below.
   */
  'subscriptionurl',
  'subscription_url',
  'subscription-url',
  'subscriptionref',
  'subscription_ref',
  'subscription-ref',
  'subscriptionlink',
  'subscription_link',
  'subscription-link',
  'sub_url',
  'sub-url',
];

/**
 * `subscription: https://…` — a subscription-labelled value that IS a URL, whatever the rest
 * of the label says. The compound names above take any value; the bare word takes only a
 * URL, which is never the next word of a sentence. The URL ends at whitespace or a quote, so
 * a JSON value keeps its closing quote.
 */
const SUBSCRIPTION_URL_VALUE =
  /(["']?)([A-Za-z0-9_.-]{0,64}subscription[A-Za-z0-9_.-]{0,64})(["']?)(\s*[=:]\s*)(["']?)[a-z][a-z0-9+.-]{0,16}:\/\/[^\s"'<>]{1,8192}/gi;

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
 * FIX-04 (S3): a JSON Web Token with nothing around it to label it. Its header is base64url
 * JSON and therefore always begins `eyJ` (`{"`), which is evidence enough on its own: no
 * sentence an operator writes contains `eyJ<8+>.<8+>.`.
 */
const BARE_JWT = /\beyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{0,4096}/g;

/**
 * FIX-04 (S3): any URL, taken apart. The scheme, host and port are kept — which panel, which
 * API, which port is what an operator needs from a failed request — and everything that can
 * carry a capability is not: the userinfo, the query, the fragment, and every path segment
 * that is not a plain lowercase word. A Telegram request path is `/bot<token>/…`, a
 * subscription link is `/sub/<token>`, a 3x-ui panel's base path is itself a secret, and a
 * signed payment link signs its path or its query; `/panel/api/inbounds` survives, and so
 * does `/telegram/webhook`. `file://` is left alone: it is how an ES module's stack names
 * its own files.
 */
const URL_IN_TEXT = /\b([a-z][a-z0-9+.-]{1,16}):\/\/([^\s"'<>/?#\\]{0,512})([^\s"'<>]{0,4096})/gi;

/** A path segment that is a word, not a value: lowercase letters joined by `-`/`_`, or `v1`. */
const SAFE_URL_SEGMENT = /^(?:[a-z]{1,32}(?:[-_][a-z]{1,32}){0,4}|v[0-9]{1,2})$/;

function redactUrlParts(match: string, scheme: string, authority: string, rest: string): string {
  if (scheme.toLowerCase() === 'file') return match;
  const at = authority.lastIndexOf('@');
  const host = at === -1 ? authority : `${REDACTED}@${authority.slice(at + 1)}`;
  const queryAt = rest.search(/[?#]/);
  const path = queryAt === -1 ? rest : rest.slice(0, queryAt);
  const segments = path
    .split('/')
    .map((segment) => (segment === '' || SAFE_URL_SEGMENT.test(segment) ? segment : REDACTED));
  const query = queryAt === -1 ? '' : `${rest.charAt(queryAt)}${REDACTED}`;
  return `${scheme}://${host}${segments.join('/')}${query}`;
}

/**
 * Format characters that render as nothing: zero-width spaces and joiners, bidi controls,
 * the soft hyphen, the BOM, variation selectors. Each one splits a token into two strings
 * no pattern recognises, while a person reading the log, or pasting from it, sees one.
 *
 * Written as code points rather than as the characters themselves, which a reader of this
 * file could not see either.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul fillers
  [0x17b4, 0x17b5], // Khmer inherent vowels
  [0x180b, 0x180f], // Mongolian variation selectors and vowel separator
  [0x200b, 0x200f], // zero-width space, non-joiner, joiner; LRM, RLM
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2060, 0x206f], // word joiner, invisible operators, bidi isolates
  [0x3164, 0x3164], // Hangul filler
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // byte-order mark
  [0xffa0, 0xffa0], // halfwidth Hangul filler
];

function codePointClass(ranges: readonly (readonly [number, number])[]): RegExp {
  const escape = (codePoint: number): string => `\\u${codePoint.toString(16).padStart(4, '0')}`;
  const body = ranges
    .map(([from, to]) => (from === to ? escape(from) : `${escape(from)}-${escape(to)}`))
    .join('');
  return new RegExp(`[${body}]`, 'g');
}

const INVISIBLE_CHARACTERS = codePointClass(INVISIBLE_RANGES);

/** Arabic-Indic (U+0660…) and Persian (U+06F0…) digits; NFKC already folds fullwidth ones. */
const EASTERN_DIGITS = codePointClass([
  [0x0660, 0x0669],
  [0x06f0, 0x06f9],
]);

/**
 * The delimiters a secret's SHAPE depends on, percent-encoded — once, or again as `%25…` up
 * to three times: `:` (a bot token), `=` (a labelled value), `/` `?` `#` `@` (a URL's parts).
 * `&` is NOT decoded: inside an encoded value it is part of the value, and decoding it would
 * end the labelled rule's match early and leave the rest of the value behind.
 */
const ENCODED_DELIMITER = /%(?:25){0,3}(3[AaDdFf]|2[Ff]|40|23)/g;

/**
 * The text the rules read: invisible characters removed, NFKC compatibility forms folded
 * (a fullwidth `：` or `１２３` becomes `:` or `123`), eastern digits folded to ASCII, and the
 * structural delimiters percent-decoded. Linear in the length, which `redactSecretText` has
 * already bounded.
 */
export function normaliseForScan(text: string): string {
  return text
    .replace(INVISIBLE_CHARACTERS, '')
    .normalize('NFKC')
    .replace(EASTERN_DIGITS, (digit) => String.fromCharCode(48 + (digit.charCodeAt(0) & 0x0f)))
    .replace(ENCODED_DELIMITER, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

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
const AUTH_SCHEME_WORDS = [...BARE_SCHEMES, 'Token', 'ApiKey', 'Mutual', 'SSWS', 'NTLM', 'DPoP'];

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
    // A quoted value in full — INCLUDING escaped quotes, because
    // `password="abc\"secret"` used to end the match at the escaped delimiter
    // and leave everything after it; or a quoted run whose closing quote is not
    // within the bound; or a scheme plus the credential after it; or one
    // whitespace-delimited token.
    //
    // The scheme alternative accepts any Capitalised word, not only the ones
    // `AUTH_SCHEME_WORDS` names. `token=GoogleLogin dXNlcjpwYXNz` leaked because the
    // scheme was unlisted AND its credential was letters-only, so the
    // trailing-credential pass below — which needs a digit or punctuation —
    // refused it too. A capital is what distinguishes a scheme from the next
    // word of a sentence: `token: abc reported by alice` keeps its sentence.
    //
    // Every bound is 8 192 rather than 4 096, which is the whole input's own
    // ceiling. At 4 096 an over-long UNQUOTED value had its first 4 096
    // characters collapsed to the marker and its tail left in place — and the
    // collapse moved that tail into the first 2 000 characters the attempt
    // table then stored.
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
    String.raw`("(?:[^"\\]|\\.){0,8192}"|'(?:[^'\\]|\\.){0,8192}'|["'][^\r\n]{0,8192}` +
    // The leading word is its own group so the replacer can judge its CASE.
    // It cannot be judged here: this pattern carries the `i` flag for the
    // name, and under `i` a class like `[A-Z]` matches lowercase too — which
    // turned `token: abc reported by alice` into `token: [redacted] by alice`,
    // eating the word after the value.
    String.raw`|(?:([A-Za-z][A-Za-z0-9-]{1,30})\s+)?([^\s"',&}]{1,8192}))`,
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
  // `bearer` in either case as well: `bearer eyJ…` is how a lower-casing client
  // quotes it, and unlike `token` the word is not one an operator's sentence uses.
  String.raw`\b(?:${BARE_SCHEMES.join('|')}|bearer|BEARER)\s+` +
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

  // FIX-04 (S3): the rules below read the text AFTER `normaliseForScan`, so a
  // token written with a fullwidth colon, split by a zero-width space, spelled in
  // Persian digits or percent-encoded (`bot123%3AAA…`) is the token it is. When
  // nothing is found the caller gets back exactly what it passed — a Persian
  // sentence keeps its digits and its zero-width non-joiners. When something IS
  // found it gets the normalised text, redacted: the original cannot be redacted
  // by offsets the normalisation moved, and returning it unredacted is the one
  // answer this function may never give.
  const scanned = normaliseForScan(text);
  const redacted = redactCardCandidates(applyTextRules(scanned));
  return redacted === scanned ? text : redacted;
}

function applyTextRules(text: string): string {
  return (
    text
      .replace(TELEGRAM_BOT_TOKEN, REDACTED)
      .replace(BARE_JWT, REDACTED)
      .replace(
        SUBSCRIPTION_URL_VALUE,
        (_match, open: string, name: string, close: string, separator: string, quote: string) =>
          `${open}${name}${close}${separator}${quote}${REDACTED}`,
      )
      // After the subscription rule, which takes the whole URL when its label
      // says what it is; this one takes the secret-bearing PARTS of any other.
      .replace(URL_IN_TEXT, redactUrlParts)
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
          leadingWord: string | undefined,
          rest: string | undefined,
        ) => {
          const label = `${openQuote}${name}${closeQuote}${separator}`;

          // The value's quotes come back as quotes. `{"token":[redacted]}` does
          // not parse, and the comment above promises something a person still
          // recognises as JSON.
          if (/^["']/.test(value)) return `${label}"${REDACTED}"`;

          // A leading word is a SCHEME — and the credential after it goes with
          // it — when it is capitalised, or is one this module names. The case
          // test lives HERE because the pattern is case-insensitive for the
          // name's sake, and under `i` a `[A-Z]` class matches lowercase too.
          const isScheme =
            leadingWord !== undefined &&
            (/^[A-Z]/.test(leadingWord) ||
              AUTH_SCHEME_WORDS.some(
                (scheme) => scheme.toLowerCase() === leadingWord.toLowerCase(),
              ));
          if (isScheme || leadingWord === undefined) return `${label}${REDACTED}`;

          // Otherwise the leading word WAS the value, and what the pattern
          // swallowed after it is the next word of a sentence. It goes back.
          return `${label}${REDACTED} ${rest ?? ''}`;
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

/**
 * FIX-04/05: a payment card number in free text — 13 to 19 digits, optionally grouped by
 * spaces, hyphens or dots (up to two between digits), and Luhn-valid. The Luhn check is what
 * keeps an order id, an amount in minor units or a Telegram id (all digit runs) out of the
 * redaction: a random digit run passes it one time in ten, a real card number always.
 *
 * FIX-04 (S3): Persian, Arabic-Indic and fullwidth digits are digits — `normaliseForScan`
 * folds them first. And a run that touches a `<hex>-` boundary is the inside of a UUID, not
 * a card: `01900000-0000-7000-…` passed Luhn one time in ten and lost part of an id, which
 * mattered little in an operator channel and would matter on every log line.
 */
const CARD_CANDIDATE =
  /(?<![0-9]|[0-9A-Fa-f]-)[0-9](?:[ .-]{0,2}[0-9]){12,18}(?![0-9]|-[0-9A-Fa-f])/g;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** The card rule over text `normaliseForScan` has already folded. */
function redactCardCandidates(text: string): string {
  return text.replace(CARD_CANDIDATE, (match) => {
    const digits = match.replace(/[ .-]/g, '');
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) ? REDACTED : match;
  });
}

export function redactCardNumbers(text: string): string {
  const scanned = normaliseForScan(text);
  const redacted = redactCardCandidates(scanned);
  return redacted === scanned ? text : redacted;
}

/**
 * Any URL in free text. A payment link is signed or is a bearer capability, a callback URL
 * names the tenant's webhook, and a provider's error page can quote the request — none of
 * them belongs in an operator channel, so the whole URL goes, scheme included.
 */
const ANY_URL = /\b[a-z][a-z0-9+.-]{1,16}:\/\/[^\s"'<>]{1,2048}/gi;

export function redactUrls(text: string): string {
  return text.replace(ANY_URL, REDACTED);
}

/**
 * Text bound for the operations log group or any other operator channel: every secret the
 * text rule finds, then every URL, then every card number. The ONE composition, so a
 * caller cannot apply two of the three and believe it applied all of them.
 */
export function redactOperatorText(text: string): string {
  return redactCardNumbers(redactUrls(redactSecretText(text)));
}
