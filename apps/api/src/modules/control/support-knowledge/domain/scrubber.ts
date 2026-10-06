import type { SupportLearningSensitiveKind } from '@nexa/contracts';

/**
 * TB8 — the deterministic scrubber of controlled learning (program §29, ADR-0035 §2).
 *
 * It runs TWICE: over the conversation BEFORE anything is sent to a provider (so a model never
 * reads a phone number, a card, a link or an id), and over the model's proposal AFTERWARDS (so
 * a candidate that still carries one is rejected automatically, never queued for a reviewer).
 *
 * It is a VALUE scrubber over free text. It is not `infrastructure/redaction.ts`, which redacts
 * by KEY inside structured values bound for logs and audit rows; the two answer different
 * questions and neither can stand in for the other.
 *
 * Rules, each a way to learn somebody's data that this refuses:
 *
 *   - Persian (۰-۹) and Arabic-Indic (٠-٩) digits are folded to ASCII before matching, and the
 *     scrubbed text keeps the folded digits: a phone typed in Persian digits is a phone.
 *   - Digit groups may be separated by RUNS (up to three) of spaces, hyphens, en and em dashes,
 *     dots, Arabic separators and zero-width characters: `6037  9975 – 1234 – 5678` is a card.
 *   - Every URL is a hit: `URL_TOKEN` when it carries a query, a fragment, userinfo or a
 *     token-shaped path segment, `HOST` otherwise. So is a bare domain (`de1.example.com`), a
 *     scheme-less subscription path, a `t.me/<name>` link, a secret word followed by a value
 *     («password is hunter2», «رمزتون abc123 هست») and an amount in digits, `k` or words.
 *   - Patterns run most-specific first (a subscription link before a URL, a card before a bare
 *     long number), and each match is replaced by `[REDACTED:<KIND>]`. Only the KIND is ever
 *     reported or stored, never the match.
 *   - The scrubber's own marker in a model's output is itself a hit (`REDACTION_MARK`): a
 *     lesson written about a redacted value is about one customer.
 *   - It over-matches on purpose. A false positive costs a candidate; a false negative teaches
 *     the support agent a customer's data, which it would then repeat.
 */

export const REDACTION_MARK = 'REDACTED';

/**
 * Characters that may sit between the digits of one number without ending it: a RUN of up to
 * three, so `6037  9975` (two spaces) and `6037 – 9975` (space, en dash, space) are one number.
 * Spaces, zero-width characters, dots, the Arabic decimal and thousands separators, hyphens
 * and the en and em dashes, underscores and slashes.
 */
const SEP = '[\\s\\u200b-\\u200d\\u2060\\ufeff.\\-\\u2010-\\u2015\\u066b\\u066c_/]{0,3}';
const d = (n: number) => Array.from({ length: n }, () => '\\d').join(SEP);

/** A domain name: labels and a top-level label that starts with a letter (`1.8.2` is not one). */
const DOMAIN = '(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z][a-z0-9-]{1,23}';
const IPV4 = '(?:\\d{1,3}\\.){3}\\d{1,3}';
/** A path that names a subscription, after a host. */
const SUB_PATH = '(?:sub|subs|subscription|subscribe|api/v\\d+/client)';

/** Persian and English number words, for an amount written out («صد و پنجاه هزار تومان»). */
const NUMBER_WORDS =
  '(?:یک|يک|دو|سه|چهار|پنج|شش|شیش|هفت|هشت|نه|ده|یازده|دوازده|سیزده|چهارده|پانزده|پونزده|شانزده|هفده|هجده|نوزده|بیست|سی|چهل|پنجاه|شصت|هفتاد|هشتاد|نود|صد|یکصد|دویست|سیصد|چهارصد|پانصد|پونصد|ششصد|هفتصد|هشتصد|نهصد|هزار|میلیون|ملیون|میلیارد|نیم|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|half)';
const CURRENCY =
  '(?:تومان|تومن|ریال|toman|tomans|rial|rials|irr|irt|usd|usdt|tether|تتر|dollars?|bucks|دلار|ton|تون|euro|euros|یورو|€|\\$)';

interface Pattern {
  readonly regex: RegExp;
  /** The kind a match is; or, for a URL, decided from the match. */
  readonly kind: SupportLearningSensitiveKind | ((match: string) => SupportLearningSensitiveKind);
}

/**
 * A URL with a scheme carries a credential when it has userinfo, a query or a fragment, or a
 * path segment that looks like a token (a digit, or upper and lower case mixed). Any other URL
 * still names a server: `HOST`. Every URL is a hit; only the kind differs.
 */
function urlKind(match: string): SupportLearningSensitiveKind {
  const rest = match.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '');
  const slash = rest.search(/[/?#]/u);
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const tail = slash < 0 ? '' : rest.slice(slash);
  if (authority.includes('@') || /[?#]/u.test(tail)) return 'URL_TOKEN';
  const tokenSegment = tail
    .split('/')
    .some((segment) => /\d/u.test(segment) || /[a-z][A-Z]|[A-Z][a-z]*[A-Z]/u.test(segment));
  return tokenSegment ? 'URL_TOKEN' : 'HOST';
}

/** Order matters: the first pattern to claim a span replaces it. */
const PATTERNS: readonly Pattern[] = [
  { kind: 'REDACTION_MARK', regex: /\[\s*REDACTED[^\]]{0,40}\]/giu },
  // Proxy share links are bearer capabilities: whoever holds one is the customer.
  {
    kind: 'SUBSCRIPTION_LINK',
    regex:
      /\b(?:vless|vmess|trojan|ssr?|socks5?|hysteria2?|hy2|tuic|wireguard|wg|juicity|naive\+https?|reality):\/\/\S+/giu,
  },
  {
    kind: 'SUBSCRIPTION_LINK',
    regex: new RegExp(`\\bhttps?://\\S*?/${SUB_PATH}(?:[/?#]\\S*)?(?![A-Za-z0-9])`, 'giu'),
  },
  // Telegram invite links are a door into a private group; a t.me/<name> link names a person.
  {
    kind: 'URL_TOKEN',
    regex: /(?:https?:\/\/)?\b(?:t|telegram)\.me\/(?:\+|joinchat\/)[A-Za-z0-9_-]+/giu,
  },
  {
    kind: 'USERNAME',
    regex: /(?:https?:\/\/)?\b(?:t|telegram)\.me\/(?:s\/)?[A-Za-z][A-Za-z0-9_]{2,31}/giu,
  },
  // Any other URL with a scheme: a credential in it, or at least a server's name.
  {
    kind: urlKind,
    regex: /\b(?:https?|wss?|tg|grpc|tcp|udp|ftp|quic|h2|http2):\/\/\S+/giu,
  },
  { kind: 'EMAIL', regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gu },
  // A subscription path without a scheme: `panel.example.com/sub/abcdef`, `1.2.3.4:2096/sub/x`.
  {
    kind: 'SUBSCRIPTION_LINK',
    regex: new RegExp(
      `(?<![\\w@.-])(?:${DOMAIN}|${IPV4})(?::\\d{1,5})?/(?:\\S*?/)?${SUB_PATH}(?:[/?#]\\S*)?(?![A-Za-z0-9])`,
      'giu',
    ),
  },
  {
    kind: 'SECRET',
    regex:
      /(?:password|passwd|pass|pwd|secret|token|api[\s_-]?key|رمز(?:\s*عبور)?|پسورد|گذرواژه|کلمه\s*عبور)\s*[:=：]\s*\S+/giu,
  },
  // A secret in prose: «password is hunter2», «رمزتون abc123 هست», «کد 4821». The value must be
  // Latin letters, digits or symbols, so «رمز عبور را عوض کنید» is help text, not a secret.
  {
    kind: 'SECRET',
    regex:
      /(?<![A-Za-z])(?:password|passwd|passcode|passphrase|pwd|secret|token|api[\s_-]?key|otp|رمز(?:\s*(?:عبور|ورود))?|پسورد|پسوورد|گذرواژه|کلمه[\s\u200c]*(?:ی[\s\u200c]*)?(?:عبور|رمز)|کد)(?:[\s\u200c]*(?:تون|تان|ت|شما|من|م|ش|اتون|ات))?\s*(?:(?:[:=：–-]|is|was|هست|است|اینه|این|میشه|می\u200cشه|شده|جدید|new)\s*){0,3}(?<![A-Za-z0-9])[A-Za-z0-9!#$%^&*+=_.-]{3,}/giu,
  },
  { kind: 'SECRET', regex: /\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}/gu },
  {
    kind: 'UUID',
    regex: /\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/giu,
  },
  // An IBAN: IR and 24 digits (grouped or not), or any country's shape.
  { kind: 'IBAN', regex: new RegExp(`\\bIR${SEP}${d(24)}(?![\\d])`, 'giu') },
  { kind: 'IBAN', regex: /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/gu },
  // A bank card: 16 digits, grouped or not. Before the phone and the bare long number.
  { kind: 'CARD', regex: new RegExp(`(?<![\\d])${d(16)}(?![\\d])`, 'gu') },
  // A long run of letters and digits that looks like a key (base64, hex).
  {
    kind: 'SECRET',
    regex: /\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{28,}={0,2}/gu,
  },
  { kind: 'IP_ADDRESS', regex: new RegExp(`\\b${IPV4}(?::\\d{1,5})?\\b`, 'gu') },
  { kind: 'IP_ADDRESS', regex: /\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/giu },
  // A server by name, without a scheme: `de1.example.com`, `de1.example.com:443/path`.
  {
    kind: 'HOST',
    regex: new RegExp(`(?<![\\w@.-])${DOMAIN}(?![\\w-])(?::\\d{1,5})?(?:/\\S*)?`, 'giu'),
  },
  // Phones: international (+ or 00), Iranian mobile (09…, or 9… with ten digits), landline.
  {
    kind: 'PHONE',
    regex: new RegExp(`(?:\\+|\\b00)${SEP}\\d{1,3}(?:${SEP}\\d){7,12}(?![\\d])`, 'gu'),
  },
  { kind: 'PHONE', regex: new RegExp(`(?<![\\d])0?9${SEP}${d(9)}(?![\\d])`, 'gu') },
  { kind: 'PHONE', regex: new RegExp(`(?<![\\d])0${SEP}\\d{2}${SEP}${d(8)}(?![\\d])`, 'gu') },
  // Money tied to a figure: «۲۵۰ هزار تومان», «۲۵۰٫۰۰۰ تومان», «150,000 ریال», «$12», «10 USDT»,
  // «150k», and an amount in words: «صد و پنجاه هزار تومان», «fifty dollars».
  {
    kind: 'AMOUNT',
    regex: new RegExp(
      `(?:[$€£]\\s?\\d[\\d,٬٫.]*)|(?:\\d[\\d,٬٫.'\\s]*\\s*(?:هزار|میلیون|ملیون|میلیارد|k|m)?\\s*${CURRENCY}(?![A-Za-z]))`,
      'giu',
    ),
  },
  {
    kind: 'AMOUNT',
    regex:
      /(?<![\w.])\d+(?:[.,٫٬]\d+)?\s?(?:k|K|kk|هزار|تومنی|تومانی|میلیون|ملیون|تومن)(?![A-Za-z])/gu,
  },
  {
    kind: 'AMOUNT',
    regex: new RegExp(
      `(?<![\\u0600-\\u06ffA-Za-z])${NUMBER_WORDS}(?:(?:\\s*(?:و|and|-)\\s*|[\\s\\u200c]+)${NUMBER_WORDS})*[\\s\\u200c]*${CURRENCY}(?![A-Za-z])`,
      'giu',
    ),
  },
  // A Telegram username.
  { kind: 'USERNAME', regex: /(?<![A-Za-z0-9_])@[A-Za-z][A-Za-z0-9_]{3,31}\b/gu },
  // Whatever long number is left: a Telegram id, an order or a transaction number.
  // Separated only by runs of spaces or zero-width characters, so a date (`2026-10-04`) is not
  // one.
  {
    kind: 'LONG_NUMBER',
    regex: /(?<![\d])\d(?:[\s\u200b-\u200d\u2060\ufeff]{0,3}\d){6,}(?![\d])/gu,
  },
];

/** Persian and Arabic-Indic digits to ASCII, one code unit for one: positions are kept. */
export function foldDigits(text: string): string {
  return text.replace(/[۰-۹٠-٩]/gu, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

export interface ScrubResult {
  /** The text with every match replaced by `[REDACTED:<KIND>]` (digits folded to ASCII). */
  readonly text: string;
  /** The kinds that matched, each once, in catalogue order. Never the matched values. */
  readonly kinds: readonly SupportLearningSensitiveKind[];
}

/**
 * L3 — a Telegram handle as one comparable form: `@name`, `t.me/name` and
 * `https://telegram.me/name` all read `name`, lower case.
 */
export function handleKey(handle: string): string {
  return handle
    .trim()
    .replace(/^(?:https?:\/\/)?(?:t|telegram)\.me\/(?:s\/)?/iu, '')
    .replace(/^@/u, '')
    .toLowerCase();
}

export interface ScrubOptions {
  /**
   * L3: the installation's OWN public support handles (the `support.accounts` setting). A
   * USERNAME hit that is exactly one of them is the business pointing customers at itself, not
   * a person's data, and is left as it is. Every other handle — a customer's, an operator's —
   * is still scrubbed, and no other kind is affected.
   */
  readonly allowedHandles?: readonly string[];
}

/** Scrubs `text`: every sensitive span becomes a marker naming its kind. */
export function scrubSensitive(text: string, options: ScrubOptions = {}): ScrubResult {
  let out = foldDigits(text.normalize('NFKC'));
  const found = new Set<SupportLearningSensitiveKind>();
  const allowed = new Set(
    (options.allowedHandles ?? []).map(handleKey).filter((key) => key.length > 0),
  );
  const kept: string[] = [];
  for (const pattern of PATTERNS) {
    out = out.replace(pattern.regex, (match) => {
      const kind = typeof pattern.kind === 'function' ? pattern.kind(match) : pattern.kind;
      // An allowed handle is set aside under a private-use mark no later pattern reads (a
      // `t.me/name` would otherwise be a HOST), and put back at the end.
      if (kind === 'USERNAME' && allowed.has(handleKey(match))) {
        kept.push(match);
        return `\uE000${String(kept.length - 1)}\uE001`;
      }
      // A marker an earlier pattern wrote is not re-scrubbed; one in the INPUT is a hit.
      if (kind !== 'REDACTION_MARK' && match.includes(`[${REDACTION_MARK}:`)) return match;
      found.add(kind);
      return `[${REDACTION_MARK}:${kind}]`;
    });
  }
  out = out.replace(/\uE000(\d+)\uE001/gu, (mark: string, index: string) =>
    kept.length === 0 ? mark : (kept[Number(index)] ?? mark),
  );
  return { text: out, kinds: orderKinds(found) };
}

/** The kinds `text` contains, without changing it. Empty means nothing was recognised. */
export function detectSensitive(
  text: string,
  options: ScrubOptions = {},
): readonly SupportLearningSensitiveKind[] {
  return scrubSensitive(text, options).kinds;
}

const KIND_ORDER: readonly SupportLearningSensitiveKind[] = [
  'EMAIL',
  'PHONE',
  'CARD',
  'IBAN',
  'SUBSCRIPTION_LINK',
  'URL_TOKEN',
  'IP_ADDRESS',
  'HOST',
  'UUID',
  'SECRET',
  'USERNAME',
  'AMOUNT',
  'LONG_NUMBER',
  'REDACTION_MARK',
];

function orderKinds(found: ReadonlySet<SupportLearningSensitiveKind>) {
  return KIND_ORDER.filter((kind) => found.has(kind));
}
