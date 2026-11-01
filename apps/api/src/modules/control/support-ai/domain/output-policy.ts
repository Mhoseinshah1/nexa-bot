import { domainToASCII } from 'node:url';
import { foldCustomerText } from './auto-reply-guards.js';

/**
 * Phase 4 PR-1 (cross-cutting hardening, item 3) — the server-side output validator, run on
 * every automatic reply AFTER the model and the decision guards. Pure: no database; the time is
 * passed in (from the Clock port) for the date rule.
 *
 * It is a BACKSTOP. The primary control is that nothing secret is in the model's context at all
 * (item 2: the payload carries only this customer's own facts and the tenant's published
 * content), so a fooled model has nothing to leak. This only refuses a reply that names what the
 * context does not hold. Its rules are deliberately blunt (second security review: no regex arms
 * race) — a false positive costs one regeneration, then a soft handoff, never a wrong message:
 *
 * - LINKS and EMAILS: any `scheme://…`, any `local@domain`, any domain-like token — labels of
 *   letters (any script, punycode `xn--` included) and digits with a TLD — must equal (after
 *   IDNA `domainToASCII` and lower-casing) a link the context or the tenant whitelists; a bare
 *   host passes when an allowed link lives on it.
 * - NUMBERS: after the allowed links and the numbers the context holds are removed, ALL digits of
 *   a line, and of the whole reply, are joined (every script, normalised to Latin, whatever
 *   separates them); a joined sequence of 8+ digits must occur in the context's own joined
 *   digits, and every digit group of 4+ must be a number the context holds (or the price
 *   family's, PR-2). A DATE is removed first only when its year is within ±1 of now (Gregorian or
 *   Jalali); any other date is digits like the rest.
 * - HANDLES: any `@handle` must be one the context holds.
 * - PROMISES: refund, compensation, free, discount, «برمی‌گردونیم», «رایگان», «تخفیف می‌دم»…
 *   only when approved knowledge carries the same word.
 */

export type OutputPolicyViolation = 'link' | 'number' | 'handle' | 'promise';

export type OutputPolicyVerdict =
  { readonly ok: true } | { readonly ok: false; readonly violation: OutputPolicyViolation };

/** PR-2's live price family plugs in here: a number the catalogue would quote is allowed. */
export interface OutputPriceFamily {
  has(digits: string): boolean;
}

export interface OutputPolicyAllowance {
  /** Normalised links and emails (`normaliseLink`). */
  readonly links: ReadonlySet<string>;
  /** Every digit group the context holds, and every amount's ÷10 / ÷1000 form. */
  readonly numbers: ReadonlySet<string>;
  /** Each context string's digits, joined: where an 8+ digit sequence of a reply may occur. */
  readonly joinedDigits: readonly string[];
  readonly handles: ReadonlySet<string>;
  /** Approved knowledge's text, folded (`foldCustomerText`): where a promise word may come from. */
  readonly knowledgeText: string;
  readonly priceFamily?: OutputPriceFamily;
}

const LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]{0,62}[\\p{L}\\p{N}])?';
/** A TLD: Latin letters, punycode, or the Persian IDN TLD. */
const TLD = '(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59}|ایران)';
const HOST = `(?:${LABEL}\\.)+${TLD}(?![\\p{L}\\p{N}])`;
const LINK_PATTERN = new RegExp(
  [
    // any scheme: http, https, tg, …
    '[a-z][a-z0-9+.-]*:\\/\\/[^\\s<>"«»()]+',
    // an email
    `[\\p{L}\\p{N}._%+-]+@${HOST}`,
    // a bare host, with or without a path
    `(?<![\\p{L}\\p{N}@._-])${HOST}(?:[/?#:][^\\s<>"«»()]*)?`,
  ].join('|'),
  'giu',
);
const HANDLE_PATTERN = /(?<![\p{L}\p{N}_.])@([A-Za-z][A-Za-z0-9_]{3,31})(?![A-Za-z0-9_.])/gu;
/** One digit group: digits with thousands separators inside it. */
const GROUP_PATTERN = /[0-9۰-۹٠-٩](?:[0-9۰-۹٠-٩]|[,٬،.](?=[0-9۰-۹٠-٩]{3}))*/gu;
/** A date: year, month, day with any single separator; digits of any script. */
const DATE_PATTERN =
  /(?<![0-9۰-۹٠-٩])([0-9۰-۹٠-٩]{4})[/.-]([0-9۰-۹٠-٩]{1,2})[/.-]([0-9۰-۹٠-٩]{1,2})(?![0-9۰-۹٠-٩])/gu;
/** Shorter than this, a digit group is a count or a step, never an identifier or an amount. */
const IDENTIFIER_MIN_DIGITS = 4;
/** A joined sequence this long is an identifier (a card, a phone, an id), never a count. */
const SEQUENCE_MIN_DIGITS = 8;

/** Latin digits, everything else dropped. */
export function digitsOf(text: string): string {
  return text
    .replace(/[۰-۹]/gu, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/gu, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[^0-9]/gu, '');
}

/**
 * A link or email as compared: scheme and `www.` dropped, the host through IDNA
 * (`domainToASCII`) and lower-cased, Telegram's aliases folded to t.me, no trailing punctuation.
 */
export function normaliseLink(link: string): string {
  const trimmed = link.replace(/[.,;:!?؟،)\]]+$/u, '');
  const at = trimmed.indexOf('@');
  if (at > 0 && !trimmed.includes('://')) {
    return `${trimmed.slice(0, at).toLowerCase()}@${asciiHost(trimmed.slice(at + 1))}`;
  }
  const bare = trimmed.replace(/^https?:\/\//iu, '');
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//iu.exec(bare)?.[0].toLowerCase() ?? '';
  const rest = bare.slice(scheme.length);
  const cut = rest.search(/[/?#]/u);
  const host = asciiHost((cut < 0 ? rest : rest.slice(0, cut)).replace(/^www\./iu, '')).replace(
    /^(?:telegram\.me|telegram\.dog)$/u,
    't.me',
  );
  const path = cut < 0 ? '' : rest.slice(cut).replace(/\/+$/u, '');
  return `${scheme}${host}${path}`;
}

function asciiHost(host: string): string {
  const lower = host.toLowerCase();
  const ascii = domainToASCII(lower);
  return ascii === '' ? lower : ascii;
}

/**
 * The promise words, folded. Each is refused unless the same word is in approved knowledge.
 * Persian, Finglish and English.
 */
const PROMISE_TERMS: readonly RegExp[] = [
  /(?<!\p{L})(?:رایگان|مجانی|مفت)(?!\p{L})/u,
  /(?<!\p{L})تخفیف/u,
  /(?<!\p{L})(?:جبران|غرامت|خسارت)/u,
  /(?<!\p{L})(?:برمی ?گردون|برمی ?گردان|بر ?میگردون|پس ?می ?(?:دیم|دهیم|دیم)|عودت ?می|بازپرداخت|استرداد)/u,
  /(?<!\p{L})(?:ری?فا?ند|ریفاند)/u,
  /(?<!\p{L})(?:شارژ|اعتبار)\s*(?:هدیه|رایگان)/u,
  /\b(?:rayegan|raigan|majani|takhfif\w*|jobran\w*|gharamat|bargardoon\w*|bargardun\w*|pas\s*midim)\b/u,
  /\b(?:refund\w*|compensat\w*|discount\w*|reimburs\w*|money\s*back|for\s+free|free\s+(?:of\s+charge|month|service|account|days?))\b/u,
];

/** Builds what a reply may name from the context the model was given (its JSON). */
export function outputPolicyAllowanceFromContext(
  contextJson: string | null,
  extra: {
    readonly links?: readonly string[];
    readonly priceFamily?: OutputPriceFamily;
  } = {},
): OutputPolicyAllowance {
  const links = new Set<string>((extra.links ?? []).map(normaliseLink));
  const numbers = new Set<string>();
  const joinedDigits: string[] = [];
  const handles = new Set<string>();
  const knowledge: string[] = [];
  let payload: unknown;
  try {
    payload = contextJson === null ? null : (JSON.parse(contextJson) as unknown);
  } catch {
    payload = null;
  }
  const visit = (value: unknown, inKnowledge: boolean): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(LINK_PATTERN)) links.add(normaliseLink(match[0]));
      for (const match of value.matchAll(HANDLE_PATTERN)) handles.add(match[1]!.toLowerCase());
      for (const match of value.matchAll(GROUP_PATTERN)) {
        const digits = digitsOf(match[0]);
        numbers.add(digits);
        // An amount in minor units may be quoted in tomans or in thousands («۱۵۰ هزار»).
        for (const zeros of ['0', '000']) {
          if (digits.length > zeros.length && digits.endsWith(zeros)) {
            numbers.add(digits.slice(0, -zeros.length));
          }
        }
      }
      for (const line of value.split(/\n/u)) {
        const joined = digitsOf(line);
        if (joined.length >= SEQUENCE_MIN_DIGITS) joinedDigits.push(joined);
      }
      if (inKnowledge) knowledge.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inKnowledge);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value))
        visit(item, inKnowledge || key === 'knowledge');
    }
  };
  visit(payload, false);
  return {
    links,
    numbers,
    joinedDigits,
    handles,
    knowledgeText: foldCustomerText(knowledge.join('\n')),
    ...(extra.priceFamily === undefined ? {} : { priceFamily: extra.priceFamily }),
  };
}

/** Whether a reply names only what the allowance holds. `now` is the Clock's. */
export function checkOutputPolicy(
  reply: string,
  allowance: OutputPolicyAllowance,
  now: Date,
): OutputPolicyVerdict {
  let rest = reply;
  // 1. Links and emails.
  for (const match of reply.matchAll(LINK_PATTERN)) {
    const link = normaliseLink(match[0]);
    // A bare host is allowed when an allowed link lives on it.
    const hostOnly =
      !link.includes('/') &&
      !link.includes('@') &&
      [...allowance.links].some((allowed) => allowed.startsWith(`${link}/`));
    if (!allowance.links.has(link) && !hostOnly) return { ok: false, violation: 'link' };
    // A number inside an allowed link is the link's, not an amount.
    rest = rest.replace(match[0], ' ');
  }
  // 2. Handles.
  for (const match of rest.matchAll(HANDLE_PATTERN)) {
    if (!allowance.handles.has(match[1]!.toLowerCase())) return { ok: false, violation: 'handle' };
  }
  // 3. Numbers. A date of this year (±1, Gregorian or Jalali) is not an identifier.
  const year = now.getUTCFullYear();
  const years = new Set([year - 1, year, year + 1, year - 622, year - 621, year - 620]);
  rest = rest.replace(DATE_PATTERN, (date, y: string, m: string, d: string) => {
    const month = Number(digitsOf(m));
    const day = Number(digitsOf(d));
    const fine =
      years.has(Number(digitsOf(y))) && month >= 1 && month <= 12 && day >= 1 && day <= 31;
    return fine ? ' ' : date;
  });
  const known = (digits: string) =>
    allowance.numbers.has(digits) ||
    allowance.numbers.has(digits.replace(/^0+/u, '')) ||
    allowance.priceFamily?.has(digits) === true;
  const inCorpus = (joined: string) =>
    known(joined) || allowance.joinedDigits.some((corpus) => corpus.includes(joined));
  for (const match of rest.matchAll(GROUP_PATTERN)) {
    const digits = digitsOf(match[0]);
    if (digits.length < IDENTIFIER_MIN_DIGITS) continue;
    const fine = digits.length >= SEQUENCE_MIN_DIGITS ? inCorpus(digits) : known(digits);
    if (!fine) return { ok: false, violation: 'number' };
  }
  // The context's own amounts and identifiers (4+ digits) are taken out; every other digit —
  // small ones included, however they are separated — is joined, per line and for the whole.
  const unknownDigits = rest.replace(GROUP_PATTERN, (group) => {
    const digits = digitsOf(group);
    return digits.length >= IDENTIFIER_MIN_DIGITS && inCorpus(digits) ? ' ' : group;
  });
  for (const piece of [...unknownDigits.split(/\n/u), unknownDigits]) {
    const joined = digitsOf(piece);
    if (joined.length >= SEQUENCE_MIN_DIGITS && !inCorpus(joined)) {
      return { ok: false, violation: 'number' };
    }
  }
  // 4. Promises.
  const folded = foldCustomerText(reply);
  for (const term of PROMISE_TERMS) {
    const hit = term.exec(folded);
    if (hit !== null && !allowance.knowledgeText.includes(hit[0].trim())) {
      return { ok: false, violation: 'promise' };
    }
  }
  return { ok: true };
}

/** The instruction a regenerated request carries after a refused reply (never the reply). */
export const OUTPUT_POLICY_REGENERATE_NOTE =
  'Your previous reply was refused and NOT sent: it named a link, a number (an amount, a card, a phone, an id or a code), a Telegram handle or a promise (refund, compensation, free, discount) that is not in the NEXA facts or the approved knowledge. Write the reply again using ONLY links, numbers and handles that appear in the NEXA facts, and promise nothing.';

/** Phase 4 PR-1 item 2: the instruction a regenerated request carries after repeated advice. */
export const REPEATED_ADVICE_REGENERATE_NOTE =
  'Your previous reply was refused and NOT sent: it repeated advice the customer already received in this conversation. Do not repeat earlier advice: give the NEXT step, ask one clarifying question about what happened when they tried, or choose HANDOFF.';
