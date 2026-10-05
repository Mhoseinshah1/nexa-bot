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
 *   - Digit groups may be separated by spaces, dashes, dots and zero-width characters.
 *   - Patterns run most-specific first (a subscription link before a URL, a card before a bare
 *     long number), and each match is replaced by `[REDACTED:<KIND>]`. Only the KIND is ever
 *     reported or stored, never the match.
 *   - The scrubber's own marker in a model's output is itself a hit (`REDACTION_MARK`): a
 *     lesson written about a redacted value is about one customer.
 *   - It over-matches on purpose. A false positive costs a candidate; a false negative teaches
 *     the support agent a customer's data, which it would then repeat.
 */

export const REDACTION_MARK = 'REDACTED';

/** Characters that may sit between the digits of one number without ending it. */
const SEP = '[\\s\\u200b-\\u200d\\u2060\\ufeff.\\-_/]?';
const d = (n: number) => Array.from({ length: n }, () => '\\d').join(SEP);

interface Pattern {
  readonly kind: SupportLearningSensitiveKind;
  readonly regex: RegExp;
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
    regex:
      /\bhttps?:\/\/\S*?\/(?:sub|subs|subscription|subscribe|api\/v\d+\/client)(?:[/?#]\S*)?/giu,
  },
  // A URL carrying a credential: userinfo, a token-named parameter, or a token-shaped segment.
  {
    kind: 'URL_TOKEN',
    regex:
      /\b(?:https?|tg):\/\/(?:[^\s/@]+@\S+|\S*?[?&#](?:token|key|apikey|api_key|secret|auth|sig|signature|password|pass|pwd|code|session|sid|access|hash|uuid)=\S*|\S*?[/=][A-Za-z0-9_-]{20,}\S*)/giu,
  },
  // Telegram invite links are a door into a private group.
  { kind: 'URL_TOKEN', regex: /\b(?:t|telegram)\.me\/(?:\+|joinchat\/)[A-Za-z0-9_-]+/giu },
  { kind: 'EMAIL', regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/gu },
  {
    kind: 'SECRET',
    regex:
      /(?:password|passwd|pass|pwd|secret|token|api[\s_-]?key|رمز(?:\s*عبور)?|پسورد|گذرواژه|کلمه\s*عبور)\s*[:=：]\s*\S+/giu,
  },
  { kind: 'SECRET', regex: /\b(?:sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{12,}/gu },
  {
    kind: 'UUID',
    regex: /\b[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\b/giu,
  },
  // An IBAN: IR and 24 digits (grouped or not), or any country's shape.
  { kind: 'IBAN', regex: new RegExp(`\\bIR${SEP}${d(24)}\\b`, 'giu') },
  { kind: 'IBAN', regex: /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){11,30}\b/gu },
  // A bank card: 16 digits, grouped or not. Before the phone and the bare long number.
  { kind: 'CARD', regex: new RegExp(`(?<![\\d])${d(16)}(?![\\d])`, 'gu') },
  // A long run of letters and digits that looks like a key (base64, hex).
  {
    kind: 'SECRET',
    regex: /\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Za-z])[A-Za-z0-9+/_-]{28,}={0,2}/gu,
  },
  { kind: 'IP_ADDRESS', regex: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/gu },
  { kind: 'IP_ADDRESS', regex: /\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/giu },
  // Phones: international (+ or 00), Iranian mobile (09…, or 9… with ten digits), landline.
  {
    kind: 'PHONE',
    regex: new RegExp(`(?:\\+|\\b00)${SEP}\\d{1,3}(?:${SEP}\\d){7,12}(?![\\d])`, 'gu'),
  },
  { kind: 'PHONE', regex: new RegExp(`(?<![\\d])0?9${SEP}${d(9)}(?![\\d])`, 'gu') },
  { kind: 'PHONE', regex: new RegExp(`(?<![\\d])0${SEP}\\d{2}${SEP}${d(8)}(?![\\d])`, 'gu') },
  // Money tied to a figure: «۲۵۰ هزار تومان», «150,000 ریال», «$12», «10 USDT».
  {
    kind: 'AMOUNT',
    regex:
      /(?:[$€£]\s?\d[\d,٬.]*)|(?:\d[\d,٬.\s]*\s*(?:هزار|میلیون|میلیارد|k|m)?\s*(?:تومان|تومن|ریال|toman|tomans|rial|rials|irr|irt|usd|usdt|dollars?|دلار|ton|تون|euro|یورو|€|\$))/giu,
  },
  // A Telegram username.
  { kind: 'USERNAME', regex: /(?<![A-Za-z0-9_])@[A-Za-z][A-Za-z0-9_]{3,31}\b/gu },
  // Whatever long number is left: a Telegram id, an order or a transaction number.
  // Separated only by spaces or zero-width characters, so a date (`2026-10-04`) is not one.
  {
    kind: 'LONG_NUMBER',
    regex: /(?<![\d])\d(?:[\s\u200b-\u200d\u2060\ufeff]?\d){6,}(?![\d])/gu,
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

/** Scrubs `text`: every sensitive span becomes a marker naming its kind. */
export function scrubSensitive(text: string): ScrubResult {
  let out = foldDigits(text.normalize('NFKC'));
  const found = new Set<SupportLearningSensitiveKind>();
  for (const { kind, regex } of PATTERNS) {
    out = out.replace(regex, (match) => {
      // A marker an earlier pattern wrote is not re-scrubbed; one in the INPUT is a hit.
      if (kind !== 'REDACTION_MARK' && match.includes(`[${REDACTION_MARK}:`)) return match;
      found.add(kind);
      return `[${REDACTION_MARK}:${kind}]`;
    });
  }
  return { text: out, kinds: orderKinds(found) };
}

/** The kinds `text` contains, without changing it. Empty means nothing was recognised. */
export function detectSensitive(text: string): readonly SupportLearningSensitiveKind[] {
  return scrubSensitive(text).kinds;
}

const KIND_ORDER: readonly SupportLearningSensitiveKind[] = [
  'EMAIL',
  'PHONE',
  'CARD',
  'IBAN',
  'SUBSCRIPTION_LINK',
  'URL_TOKEN',
  'IP_ADDRESS',
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
