import { foldCustomerText } from './auto-reply-guards.js';

/**
 * Phase 4 PR-1 (cross-cutting hardening, item 3) — the server-side output validator, run on
 * every automatic reply AFTER the model and the decision guards. Pure: no clock, no database.
 *
 * Even a fully fooled model can only send what NEXA already holds for THIS customer or has
 * published itself:
 *
 * - every LINK is one the context carries (the tenant's published content — knowledge, client
 *   apps, support accounts — or this customer's own facts) or a whitelisted tenant link (the
 *   bot's own start link);
 * - every NUMBER of four digits or more — an amount, a card, a phone, a Telegram id, a tracking
 *   code — is one the context carries (the customer's own facts or published content), or one
 *   a plugged-in price family recognises (PR-2 adds the live catalogue). Shorter numbers (a
 *   step, «۳۰ روز», «۵۰ گیگ») are not identifiers and pass;
 * - every Telegram HANDLE is one the context carries;
 * - no PROMISE word (refund, compensation, free, discount, «برمی‌گردونیم», «رایگان», «تخفیف
 *   می‌دم», their Finglish forms…) unless that very word is in approved knowledge.
 *
 * A failure is regenerated once by the caller; a second failure hands off (`OUTPUT_POLICY`).
 */

export type OutputPolicyViolation = 'link' | 'number' | 'handle' | 'promise';

export type OutputPolicyVerdict =
  { readonly ok: true } | { readonly ok: false; readonly violation: OutputPolicyViolation };

/** PR-2's live price family plugs in here: a number the catalogue would quote is allowed. */
export interface OutputPriceFamily {
  has(digits: string): boolean;
}

export interface OutputPolicyAllowance {
  readonly links: ReadonlySet<string>;
  readonly numbers: ReadonlySet<string>;
  readonly handles: ReadonlySet<string>;
  /** Approved knowledge's text, folded (`foldCustomerText`): where a promise word may come from. */
  readonly knowledgeText: string;
  readonly priceFamily?: OutputPriceFamily;
}

const URL_PATTERN = /(?:https?:\/\/|(?<![\p{L}\p{N}.])t\.me\/)[^\s<>"«»()]+/giu;
const HANDLE_PATTERN = /(?<![\p{L}\p{N}_])@([A-Za-z][A-Za-z0-9_]{3,31})/gu;
/** A digit run, Persian and Arabic digits included, thousands separators inside it allowed. */
const NUMBER_PATTERN = /[0-9۰-۹٠-٩](?:[0-9۰-۹٠-٩]|[,٬،.](?=[0-9۰-۹٠-٩]{3}))*/gu;
/** A card or phone number written in groups («6037-9912-3456-7893», «0912 123 4567»). */
const GROUPED_PATTERN = /[0-9۰-۹٠-٩](?:[0-9۰-۹٠-٩]|[\s-](?=[0-9۰-۹٠-٩])){7,}/gu;
/** Shorter than this, a number is a count or a step, never an identifier or an amount. */
const IDENTIFIER_MIN_DIGITS = 4;

/** Latin digits, separators dropped. */
export function digitsOf(text: string): string {
  return text
    .replace(/[۰-۹]/gu, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/gu, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[^0-9]/gu, '');
}

/** A link as compared: scheme and `www.` dropped, host lower-cased, no trailing punctuation. */
export function normaliseLink(link: string): string {
  const trimmed = link.replace(/[.,;:!?؟،)\]]+$/u, '');
  const bare = trimmed.replace(/^https?:\/\//iu, '').replace(/^www\./iu, '');
  const slash = bare.indexOf('/');
  const host = (slash < 0 ? bare : bare.slice(0, slash)).toLowerCase();
  const path = slash < 0 ? '' : bare.slice(slash).replace(/\/+$/u, '');
  return `${host}${path}`;
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
      for (const match of value.matchAll(URL_PATTERN)) links.add(normaliseLink(match[0]));
      for (const match of value.matchAll(HANDLE_PATTERN)) handles.add(match[1]!.toLowerCase());
      for (const match of value.matchAll(GROUPED_PATTERN)) numbers.add(digitsOf(match[0]));
      for (const match of value.matchAll(NUMBER_PATTERN)) {
        const digits = digitsOf(match[0]);
        if (digits === '') continue;
        numbers.add(digits);
        // An amount in minor units may be quoted in tomans or in thousands («۱۵۰ هزار»).
        for (const divisor of ['0', '000']) {
          if (digits.length > divisor.length && digits.endsWith(divisor)) {
            numbers.add(digits.slice(0, -divisor.length));
          }
        }
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
    handles,
    knowledgeText: foldCustomerText(knowledge.join('\n')),
    ...(extra.priceFamily === undefined ? {} : { priceFamily: extra.priceFamily }),
  };
}

/** Whether a reply names only what the allowance holds. */
export function checkOutputPolicy(
  reply: string,
  allowance: OutputPolicyAllowance,
): OutputPolicyVerdict {
  let rest = reply;
  for (const match of reply.matchAll(URL_PATTERN)) {
    if (!allowance.links.has(normaliseLink(match[0]))) return { ok: false, violation: 'link' };
    // A number inside an allowed link is the link's, not an amount.
    rest = rest.replace(match[0], ' ');
  }
  // A grouped card or phone number is judged whole, then left out of the per-number pass.
  for (const match of rest.matchAll(GROUPED_PATTERN)) {
    const digits = digitsOf(match[0]);
    if (digits.length < 8 || match[0] === digits) continue;
    if (!allowance.numbers.has(digits)) return { ok: false, violation: 'number' };
    rest = rest.replace(match[0], ' ');
  }
  for (const match of rest.matchAll(HANDLE_PATTERN)) {
    if (!allowance.handles.has(match[1]!.toLowerCase())) return { ok: false, violation: 'handle' };
  }
  for (const match of rest.matchAll(NUMBER_PATTERN)) {
    const digits = digitsOf(match[0]);
    if (digits.length < IDENTIFIER_MIN_DIGITS) continue;
    const known =
      allowance.numbers.has(digits) ||
      allowance.numbers.has(digits.replace(/^0+/u, '')) ||
      allowance.priceFamily?.has(digits) === true;
    if (!known) return { ok: false, violation: 'number' };
  }
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
