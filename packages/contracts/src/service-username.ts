import { z } from 'zod';
import type { Hasher } from './operation.js';

/**
 * Every username this installation creates for a new provider service obeys ONE
 * contract, whoever authored it: a customer typing it, a preset generating it, or a
 * template rendering it.
 *
 * Four to twenty characters, from lowercase ASCII letters, digits, `_` and `-`. The
 * bound is the same at all three places a name passes — the surface that accepts it,
 * the allocator that reserves it, and the adapter that sends it — because a rule
 * enforced once is a rule that is skipped by the second caller somebody adds.
 *
 * ## Twenty, and not a number derived from a generator
 *
 * The previous ceiling in this file was 34, reasoned backwards from the shape the
 * derived generator happened to produce. That is not evidence about a panel; it is
 * evidence about our own code, and it put the product's promise at the mercy of an
 * implementation detail. Twenty is a decision: it is comfortably inside every provider
 * username field this product has driven, it leaves a support conversation something
 * sayable, and every preset below is built to fit inside it rather than the ceiling
 * being widened to fit a preset.
 *
 * ## It binds NEW names only
 *
 * Services already provisioned keep the name they have, whatever its length, and
 * nothing here renames them or refuses them retroactively — see
 * `isNewProviderUsername`, which is asked of a name being MINTED and of nothing else.
 * Renew, add-traffic and add-time send the stored name back unchanged.
 */
export const PROVIDER_USERNAME_MIN_LENGTH = 4;
export const PROVIDER_USERNAME_MAX_LENGTH = 20;

/**
 * What any accepted name may contain, after the case fold.
 *
 * Lowercase ASCII, digits, `_` and `-`. No uppercase, because two accounts differing
 * only in case are two accounts an operator reading a client list cannot tell apart and
 * case-folding behaviour across providers is not something this repository has evidence
 * for. Persian letters, Persian digits, whitespace, `@`, `.`, `/` and emoji are refused
 * rather than stripped: a name this installation altered is a name the customer did not
 * choose.
 */
export const PROVIDER_USERNAME_CHARACTERS = /^[a-z0-9_-]+$/;
/** The whole contract in one expression: the character class AND the length. */
export const PROVIDER_USERNAME_PATTERN = /^[a-z0-9_-]{4,20}$/;

/**
 * May this be minted as a NEW provider username?
 *
 * Asked of the canonical form — after the fold — at the allocator and again at the
 * adapter. It is deliberately not asked of a stored name: an existing service's name
 * predates this contract and is none of its business.
 */
export function isNewProviderUsername(canonical: string): boolean {
  return PROVIDER_USERNAME_PATTERN.test(canonical);
}

/**
 * The last check before a network request, and the reason it is an assertion.
 *
 * Every caller above this point has already validated. This runs anyway, at the
 * adapter, because the cost of the three checks disagreeing is an account created on
 * somebody's panel under a name this product cannot subsequently address — and the
 * two upstream checks are the ones a refactor can remove without a test noticing.
 * A throw here is a programming error surfacing before it reaches the panel, not an
 * operator's or a customer's mistake; both of those were answered further up with a
 * message.
 */
export function assertNewProviderUsername(canonical: string): void {
  if (!isNewProviderUsername(canonical)) {
    throw new Error(
      `a new provider username must be ${PROVIDER_USERNAME_MIN_LENGTH}-${PROVIDER_USERNAME_MAX_LENGTH} characters of [a-z0-9_-]`,
    );
  }
}

/**
 * May this name be SENT to a provider, whoever minted it and whenever?
 *
 * Wider than `isNewProviderUsername` on purpose, and the difference is the whole point:
 * "may be minted today" and "may be sent" are two questions, and answering the second
 * with the first refuses names this installation itself created.
 *
 * `createUser` is not reached only when a name is being minted. A RECONCILE-driven
 * retry of an UNKNOWN create re-sends the name the SERVICE ROW already carries, and a
 * service provisioned by the release before this one carries `nx` plus 32 hex. Asserting
 * the new contract there would turn a recoverable retry into a crash, for a service the
 * customer is holding — which is the "never retroactively rejected" rule broken by the
 * code that was supposed to enforce it.
 *
 * So: the current contract, OR the shape this product used to mint. Nothing else.
 */
export function isSendableProviderUsername(stored: string): boolean {
  return isNewProviderUsername(stored) || LEGACY_USERNAME_PATTERN.test(stored);
}

/**
 * The adapter boundary's assertion. See `isSendableProviderUsername` for why it is not
 * `assertNewProviderUsername`.
 *
 * Still an assertion rather than a refusal: every caller above has validated, so a name
 * that fails here is our defect surfacing before it reaches somebody's panel.
 */
export function assertSendableProviderUsername(stored: string): void {
  if (!isSendableProviderUsername(stored)) {
    throw new Error(
      `a provider username must be ${PROVIDER_USERNAME_MIN_LENGTH}-${PROVIDER_USERNAME_MAX_LENGTH} characters of [a-z0-9_-], or a name this product minted before that contract`,
    );
  }
}

/**
 * How a customer's service gets the name the provider knows it by.
 *
 * Two modes, and the panel decides which of them a customer may use. They are not
 * variations of one thing: `CUSTOM` is a value the customer authored and this
 * installation must not alter, `AUTOMATIC` is a value this installation authored and
 * the customer never sees before it exists.
 *
 * `AUTOMATIC` is the MODE. Which of the four presets produces the name is the panel's
 * `UsernameStrategy`, and the two are separate on purpose: a customer chooses between
 * typing a name and being given one, and the strategy behind the second choice is an
 * operator's decision they should never have to understand.
 */
export const SERVICE_USERNAME_MODES = ['CUSTOM', 'AUTOMATIC'] as const;
export type ServiceUsernameMode = (typeof SERVICE_USERNAME_MODES)[number];
export const serviceUsernameModeSchema = z.enum(SERVICE_USERNAME_MODES);

// ---------------------------------------------------------------------------
// CUSTOM — what a customer may type
// ---------------------------------------------------------------------------

/**
 * The customer-typed range, which is the universal range and not a narrower one.
 *
 * Four to twenty. A separate, stricter customer bound would mean a name the product
 * can generate and a customer cannot ask for, which is a rule nobody can explain.
 */
export const CUSTOM_USERNAME_MIN_LENGTH = PROVIDER_USERNAME_MIN_LENGTH;
export const CUSTOM_USERNAME_MAX_LENGTH = PROVIDER_USERNAME_MAX_LENGTH;

/** What a customer may TYPE. Either case, and nothing outside ASCII. */
export const CUSTOM_USERNAME_INPUT_PATTERN = /^[A-Za-z0-9_-]{4,20}$/;
/** The same set after the case fold: what is reserved, stored and sent to a provider. */
export const CUSTOM_USERNAME_CANONICAL_PATTERN = PROVIDER_USERNAME_PATTERN;
const HAS_ASCII_LETTER = /[A-Za-z]/;
const HAS_ASCII_DIGIT = /[0-9]/;

/**
 * Is this something a customer may type?
 *
 * Asked of the RAW input, before any fold. Whitespace is refused here rather than
 * trimmed: a trailing space is a difference the customer cannot see, and silently
 * removing it is still a rewrite. They are told, and they type it again.
 *
 * At least one English letter and at least one digit. Not a strength rule — a username
 * is an identifier, not a secret. It is a legibility rule: `1234` and `----` are both
 * names a support conversation cannot say out loud, and the second is not obviously a
 * username at all.
 */
export function isValidCustomUsername(raw: string): boolean {
  return (
    CUSTOM_USERNAME_INPUT_PATTERN.test(raw) &&
    HAS_ASCII_LETTER.test(raw) &&
    HAS_ASCII_DIGIT.test(raw)
  );
}

/**
 * The one rewrite this contract permits: ASCII letters to lowercase.
 *
 * Everything durable uses the result — the uniqueness check, the reservation, the frozen
 * order snapshot, `services.provider_username`, the provider call, the audit record and
 * reconciliation — so `Ali_2026` and `ali_2026` are one identity that collides on one
 * unique index rather than two accounts for one name.
 *
 * VALIDATE FIRST, THEN FOLD, and the order is not interchangeable. `toLowerCase` is
 * Unicode-aware: `'İ'.toLowerCase()` is two code points, and a Cyrillic `А` folds to a
 * `а` that is not the `a` anybody meant. Running it before the ASCII-only check would
 * let characters this contract refuses arrive at the check already disguised as ones it
 * allows. Validated first, only `A-Z` remains, and the fold is exactly the ASCII one.
 */
export function canonicalizeCustomUsername(valid: string): string {
  return valid.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

// ---------------------------------------------------------------------------
// AUTOMATIC — the four presets
// ---------------------------------------------------------------------------

/**
 * How a panel generates a name when the customer does not type one.
 *
 * Four presets and no fifth, because each one that exists is a shape an operator can
 * be shown a preview of before saving. An open-ended generator would be the template,
 * and the template is already one of the four — bounded by its own grammar.
 */
export const USERNAME_STRATEGIES = [
  /** 12 lowercase alphanumeric characters, and nothing else. */
  'RANDOM',
  /** A literal prefix the operator chose, then random characters. */
  'PREFIX_RANDOM',
  /** `{telegram_id}_{random6}` — the customer's own Telegram id, in full. */
  'TELEGRAM_ID_RANDOM',
  /** The constrained template grammar below. */
  'CUSTOM_TEMPLATE',
] as const;
export type UsernameStrategy = (typeof USERNAME_STRATEGIES)[number];
export const usernameStrategySchema = z.enum(USERNAME_STRATEGIES);

/**
 * What a panel does when nobody has said otherwise.
 *
 * `PREFIX_RANDOM` with the prefix `nx`, which renders `nx` plus ten random lowercase
 * alphanumeric characters — twelve in total, matching `DEFAULT_USERNAME_PATTERN`.
 *
 * It is a real default rather than a null meaning "unconfigured". A nullable strategy
 * would put a migration state into a vocabulary every surface has to render, and the
 * surface would then have to explain what the absence generates — which is exactly the
 * thing an operator should be able to READ rather than infer.
 */
export const DEFAULT_USERNAME_STRATEGY: UsernameStrategy = 'PREFIX_RANDOM';
export const DEFAULT_USERNAME_PREFIX = 'nx';
/** What every panel with no explicitly saved strategy produces. Twelve characters. */
export const DEFAULT_USERNAME_PATTERN = /^nx[a-z0-9]{10}$/;

/** `RANDOM`: exactly this many characters, no prefix. */
export const RANDOM_STRATEGY_LENGTH = 12;
/** `PREFIX_RANDOM`: how many random characters are appended when there is room. */
export const PREFIX_RANDOM_TARGET_RANDOM = 10;
/** `PREFIX_RANDOM`: the floor. A prefix that would leave fewer is refused at save. */
export const PREFIX_RANDOM_MIN_RANDOM = 6;
/** `TELEGRAM_ID_RANDOM`: the length of the suffix after the underscore. */
export const TELEGRAM_ID_RANDOM_SUFFIX_LENGTH = 6;

/**
 * The longest prefix that still leaves `PREFIX_RANDOM_MIN_RANDOM` random characters.
 *
 * Fourteen. Derived rather than written, so raising the ceiling or the floor moves it
 * and no second number goes stale.
 */
export const USERNAME_PREFIX_MAX_LENGTH = PROVIDER_USERNAME_MAX_LENGTH - PREFIX_RANDOM_MIN_RANDOM;

/**
 * How many random characters `PREFIX_RANDOM` appends to this prefix.
 *
 * Ten where there is room, and as many as fit otherwise — never fewer than the floor,
 * because a prefix that would force fewer is refused at save time. `nx` therefore
 * renders twelve characters, which is what `DEFAULT_USERNAME_PATTERN` states.
 */
export function prefixRandomLength(prefix: string): number {
  return Math.min(PREFIX_RANDOM_TARGET_RANDOM, PROVIDER_USERNAME_MAX_LENGTH - prefix.length);
}

export const USERNAME_PREFIX_ISSUES = [
  'EMPTY',
  'ILLEGAL_CHARACTER',
  'NOT_LETTER_FIRST',
  'TOO_LONG',
] as const;
export type UsernamePrefixIssue = (typeof USERNAME_PREFIX_ISSUES)[number];

export interface UsernamePrefixVerdict {
  readonly ok: boolean;
  readonly issues: readonly UsernamePrefixIssue[];
  /** What this prefix renders to, in total. Zero when the prefix is unusable. */
  readonly renderedLength: number;
}

/**
 * Whether this prefix may be saved, and everything wrong with it if not.
 *
 * Every issue at once rather than the first, for the same reason the template verdict
 * gives: an operator fixing one problem per round trip is an operator who gives up.
 *
 * A leading English letter is required because a name beginning with a digit or a `-`
 * reads as an accident, and `-` first is the shape a shell or a CLI argument parser
 * mistakes for a flag.
 */
export function validateUsernamePrefix(prefix: string): UsernamePrefixVerdict {
  const issues: UsernamePrefixIssue[] = [];
  if (prefix.length === 0) {
    return { ok: false, issues: ['EMPTY'], renderedLength: 0 };
  }
  if (!PROVIDER_USERNAME_CHARACTERS.test(prefix)) issues.push('ILLEGAL_CHARACTER');
  if (!/^[a-z]/.test(prefix)) issues.push('NOT_LETTER_FIRST');
  if (prefix.length > USERNAME_PREFIX_MAX_LENGTH) issues.push('TOO_LONG');
  return {
    ok: issues.length === 0,
    issues,
    renderedLength: issues.length === 0 ? prefix.length + prefixRandomLength(prefix) : 0,
  };
}

// ---------------------------------------------------------------------------
// The template language
// ---------------------------------------------------------------------------

/**
 * Every placeholder, and the shortest and longest each one renders to.
 *
 * Both bounds, because the contract has both: a template must not be able to produce
 * fewer than four characters or more than twenty, and only `telegram_id` varies.
 *
 * - `telegram_id` — 1 to 16. Sixteen, not the 10 digits Telegram issues today: the API
 *   documents ids as safe up to 52 bits, which is 16 decimal digits, and a template
 *   that fits today's ids and not tomorrow's would fail for one customer, once, with
 *   the money already taken. One rather than a realistic floor, because no minimum is
 *   documented and the only safe assumption about a lower bound is the trivial one.
 * - `tg4` — the last four digits of that id, so exactly four.
 * - `customer4` / `order4` — a stable four-character digest, so exactly four.
 * - `random4` / `random6` / `random10` — exactly what they say.
 *
 * There is deliberately no token for a display name, a Telegram handle, a phone number,
 * a date or any other customer-authored text. A username is a durable identifier on
 * somebody else's machine; rendering a customer's own words into one is how the legacy
 * system baked an administrator's name into thirteen thousand records.
 */
export const USERNAME_TEMPLATE_TOKENS = {
  telegram_id: { min: 1, max: 16 },
  tg4: { min: 4, max: 4 },
  customer4: { min: 4, max: 4 },
  order4: { min: 4, max: 4 },
  random4: { min: 4, max: 4 },
  random6: { min: 6, max: 6 },
  random10: { min: 10, max: 10 },
} as const;
export type UsernameTemplateToken = keyof typeof USERNAME_TEMPLATE_TOKENS;
export const USERNAME_TEMPLATE_TOKEN_NAMES = Object.keys(
  USERNAME_TEMPLATE_TOKENS,
) as readonly UsernameTemplateToken[];

/**
 * The tokens that make a name unique PER ORDER.
 *
 * `telegram_id`, `tg4` and `customer4` are not here, and that is the whole of this
 * rule: one customer may own several services, so a template built only from who they
 * are renders the same string for their second purchase — which collides on the first
 * reservation and refuses a sale that should have succeeded.
 */
export const USERNAME_UNIQUENESS_TOKENS: readonly UsernameTemplateToken[] = [
  'order4',
  'random4',
  'random6',
  'random10',
];

/**
 * The tokens a REDRAW changes.
 *
 * A collision is retried by drawing these again. `order4` is not among them: it is a
 * deterministic function of the order, and regenerating it would mean changing the
 * order's identity to hide a name clash. Where a template's only uniqueness token is
 * `order4`, the second attempt renders exactly what the first did, so there is no
 * second attempt — the purchase is refused before any debit and the operator is told.
 */
export const USERNAME_REDRAWN_TOKENS: readonly UsernameTemplateToken[] = [
  'random4',
  'random6',
  'random10',
];

/**
 * How long a template's RAW TEXT may be, which is not how long its output may be.
 *
 * `{telegram_id}` is thirteen characters that render as up to sixteen, and
 * `{random10}` is eleven that render as ten. Bounding the stored string by the
 * rendered maximum would refuse templates that produce perfectly legal names, so this
 * is its own, looser bound — a storage limit, not a correctness one.
 */
export const USERNAME_TEMPLATE_MAX_LENGTH = 128;

/** `{token}`, and nothing cleverer. No conditionals, no expressions, no nesting. */
const PLACEHOLDER = /\{([a-z0-9_]*)\}/g;
/** A `{` or `}` that is not part of a well-formed placeholder is malformed, not literal. */
const STRAY_BRACE = /[{}]/;

export const USERNAME_TEMPLATE_ISSUES = [
  'EMPTY',
  'UNKNOWN_TOKEN',
  'MALFORMED',
  'NO_UNIQUENESS_TOKEN',
  'ILLEGAL_CHARACTER',
  'TOO_LONG',
  'TOO_SHORT',
] as const;
export type UsernameTemplateIssue = (typeof USERNAME_TEMPLATE_ISSUES)[number];

export interface UsernameTemplateVerdict {
  readonly ok: boolean;
  readonly issues: readonly UsernameTemplateIssue[];
  /** The tokens the template actually uses, in first-appearance order. */
  readonly tokens: readonly UsernameTemplateToken[];
  /** What this template renders to when every token is at its maximum. */
  readonly worstCaseLength: number;
  /** What it renders to when every token is at its minimum. */
  readonly bestCaseLength: number;
}

function renderedBounds(template: string): { readonly min: number; readonly max: number } {
  let min = 0;
  let max = 0;
  let cursor = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const literal = match.index - cursor;
    min += literal;
    max += literal;
    const bounds = USERNAME_TEMPLATE_TOKENS[match[1] as UsernameTemplateToken];
    // An unknown token is its own literal text: it is reported separately as
    // UNKNOWN_TOKEN, and counting it as text keeps the length honest for the report.
    min += bounds?.min ?? match[0].length;
    max += bounds?.max ?? match[0].length;
    cursor = match.index + match[0].length;
  }
  const tail = template.length - cursor;
  return { min: min + tail, max: max + tail };
}

/**
 * The longest string this template can produce.
 *
 * Literal text counts as itself; each placeholder counts as its token's maximum. A
 * template validated on a typical render would pass at save time and then produce a
 * name the panel refuses for the one customer whose Telegram id is longer than the
 * operator's — after the money moved.
 */
export function worstCaseRenderedLength(template: string): number {
  return renderedBounds(template).max;
}

/** The shortest string this template can produce. The other half of the bound. */
export function bestCaseRenderedLength(template: string): number {
  return renderedBounds(template).min;
}

/**
 * Whether this template may be saved, and everything wrong with it if not.
 *
 * Every issue at once rather than the first, for the reason the config loader states:
 * an operator fixing one problem per round trip is an operator who gives up. The
 * verdict also carries the tokens and both length bounds, so a surface can render them
 * without parsing the template a second time with its own regex.
 *
 * Both bounds are checked. A template that can render nineteen characters for one
 * customer and twenty-three for another is refused at the operator's keyboard, not at
 * the second customer's checkout.
 */
export function validateUsernameTemplate(template: string): UsernameTemplateVerdict {
  const issues: UsernameTemplateIssue[] = [];
  const tokens: UsernameTemplateToken[] = [];
  const trimmed = template.trim();

  if (trimmed.length === 0) {
    return { ok: false, issues: ['EMPTY'], tokens: [], worstCaseLength: 0, bestCaseLength: 0 };
  }

  let literal = '';
  let cursor = 0;
  for (const match of trimmed.matchAll(PLACEHOLDER)) {
    literal += trimmed.slice(cursor, match.index);
    const name = match[1] as string;
    if (Object.prototype.hasOwnProperty.call(USERNAME_TEMPLATE_TOKENS, name)) {
      const token = name as UsernameTemplateToken;
      if (!tokens.includes(token)) tokens.push(token);
    } else {
      issues.push('UNKNOWN_TOKEN');
    }
    cursor = match.index + match[0].length;
  }
  literal += trimmed.slice(cursor);

  // A brace left in the literal remainder never formed a placeholder.
  if (STRAY_BRACE.test(literal)) issues.push('MALFORMED');
  // The literal text between placeholders obeys the same character class as the result.
  if (literal.length > 0 && !PROVIDER_USERNAME_CHARACTERS.test(literal)) {
    issues.push('ILLEGAL_CHARACTER');
  }
  if (!tokens.some((token) => USERNAME_UNIQUENESS_TOKENS.includes(token))) {
    issues.push('NO_UNIQUENESS_TOKEN');
  }

  const { min: bestCaseLength, max: worstCaseLength } = renderedBounds(trimmed);
  if (worstCaseLength > PROVIDER_USERNAME_MAX_LENGTH) issues.push('TOO_LONG');
  if (bestCaseLength < PROVIDER_USERNAME_MIN_LENGTH) issues.push('TOO_SHORT');

  return { ok: issues.length === 0, issues, tokens, worstCaseLength, bestCaseLength };
}

/** What a render needs. Every field is required, so a missing one cannot render empty. */
export interface UsernameTemplateValues {
  readonly telegram_id: string;
  readonly tg4: string;
  readonly customer4: string;
  readonly order4: string;
  readonly random4: string;
  readonly random6: string;
  readonly random10: string;
}

/**
 * Substitute, and refuse anything the substitution produced that is not a legal name.
 *
 * The second half is not belt-and-braces. `validateUsernameTemplate` bounds the worst
 * and best cases; a real render can still be illegal if a caller passes a value this
 * contract did not shape — a Telegram id with a minus sign, a digest that kept its
 * dashes. Checking the RESULT is the check that cannot be fooled by a caller's mistake,
 * and it runs before the name is reserved rather than after the panel refuses it.
 *
 * It throws rather than returning a verdict because every value here is produced by
 * this codebase: a failure is a defect on our side, and the two things it must not do
 * are reach a panel and be reported to a customer as their mistake.
 */
export function renderUsernameTemplate(template: string, values: UsernameTemplateValues): string {
  const rendered = template
    .trim()
    .replace(PLACEHOLDER, (whole, name: string) =>
      Object.prototype.hasOwnProperty.call(values, name)
        ? values[name as UsernameTemplateToken]
        : whole,
    );
  assertNewProviderUsername(rendered);
  return rendered;
}

/**
 * The last four digits of a Telegram id, left-padded when the id is shorter.
 *
 * Padded rather than refused, because `{tg4}` is declared as exactly four characters and
 * a shorter render would break the length bound the operator was shown at save time.
 */
export function telegramIdSuffix4(telegramId: string): string {
  return telegramId.slice(-4).padStart(4, '0');
}

/**
 * A stable four-character lowercase digest of an internal id.
 *
 * Used by `{customer4}` and `{order4}`. The hasher is supplied rather than imported,
 * because `packages/contracts` depends on nothing — the same arrangement
 * `operationIdFrom` uses, and for the same reason.
 *
 * Four base-36 characters is 1,679,616 values, which is not a lot. That is deliberate
 * and bounded: it is an identifier fragment, not a uniqueness guarantee, and the
 * template grammar refuses to treat `customer4` as a uniqueness token at all. Where
 * `order4` IS the only uniqueness token, a collision is a refusal before any debit
 * rather than a silent redraw — see `USERNAME_REDRAWN_TOKENS`.
 */
export function usernameDigest4(value: string, hash: Hasher): string {
  const digest = hash(value);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error('a username digest hasher must return 64 lowercase hex characters');
  }
  return (parseInt(digest.slice(0, 8), 16) % 36 ** 4).toString(36).padStart(4, '0');
}

/**
 * How many times a colliding AUTOMATIC candidate is regenerated before the sale is
 * refused.
 *
 * Five, and then a refusal BEFORE any debit. Not an infinite retry: a template with no
 * random component at all collides identically every time, and a loop against it would
 * turn a configuration mistake into a hung checkout rather than a message an operator
 * can act on.
 */
export const RANDOM_USERNAME_MAX_ATTEMPTS = 5;

/**
 * The alphabet for every random component: lowercase letters and digits, 36 symbols.
 *
 * `random6` is therefore ~31 bits, `random10` ~51 and the twelve of `RANDOM` ~62.
 * None is a secret — a username is an identifier, and `services.subscription_ref` is
 * where this product keeps the thing that IS a capability — but all are minted from the
 * same CSPRNG the secrets port uses, because a predictable name lets somebody enumerate
 * an operator's client list.
 */
export const RANDOM_USERNAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * `length` characters of `RANDOM_USERNAME_ALPHABET`, from hex the caller drew.
 *
 * Here rather than in the allocator because three callers need it — the allocator, the
 * settlement fallback and the preview — and three copies of a draw is three chances for
 * one of them to reach for `Math.random`.
 *
 * `% 36` over a byte is very slightly biased: four of the thirty-six characters are
 * drawn 8/256 of the time rather than 7/256. That is accepted deliberately. Nothing
 * here is guarding against somebody predicting the next draw, only against two draws
 * colliding, and a 1.14x bias on one character changes the collision probability by
 * nothing an operator could measure.
 */
export function drawUsernameCharacters(hex: string, length: number): string {
  if (hex.length < length * 2) {
    throw new Error('a username draw needs two hex characters per output character');
  }
  let drawn = '';
  for (let index = 0; index < length; index += 1) {
    const pair = hex.slice(index * 2, index * 2 + 2);
    drawn += RANDOM_USERNAME_ALPHABET[parseInt(pair, 16) % RANDOM_USERNAME_ALPHABET.length];
  }
  return drawn;
}

/**
 * Why a username-entry window stopped being open.
 *
 * The same three the receipt window has, and for the same reasons: the customer typed
 * a name, they started the step again elsewhere, or the deadline passed. `RECEIVED`
 * covers an ACCEPTED name only — a refused one leaves the window open, because the
 * customer is being asked to type another and closing it would strand them.
 */
export const USERNAME_CAPTURE_CLOSE_REASONS = ['RECEIVED', 'SUPERSEDED', 'EXPIRED'] as const;
export type UsernameCaptureCloseReason = (typeof USERNAME_CAPTURE_CLOSE_REASONS)[number];

/**
 * How long a customer has to type their username before the window closes.
 *
 * Short on purpose. An open window is the one thing in this flow that makes an
 * ORDINARY message mean something, and the legacy prompt capture this product replaces
 * swallowed a normal message and overwrote a production gateway setting
 * (INCIDENT-FIN-001) precisely because its window outlived the question. Ten minutes is
 * long enough to think of a name and short enough that a customer who wandered off is
 * typing into nothing.
 *
 * The blast radius is bounded independently of the deadline: the only thing an open
 * window can do is validate a name against ONE draft order of ONE customer, so even a
 * window that outlived its question cannot reach a setting, a payment or another order.
 */
export const USERNAME_CAPTURE_TTL_MS = 10 * 60 * 1000;

/**
 * The shape the derived generator produced before this contract existed.
 *
 * `nx` plus 32 hex, 34 characters. Nothing mints it any more — the default is
 * `DEFAULT_USERNAME_PATTERN`, twelve characters — and this predicate exists only so a
 * validation path can tell "a name from before the contract" from "a name somebody
 * typed wrongly" without reaching for the service id. Services carrying one keep it.
 */
export const LEGACY_USERNAME_PATTERN = /^nx[0-9a-f]{32}$/;

// ---------------------------------------------------------------------------
// The whole policy: one evaluator, and one preview
// ---------------------------------------------------------------------------

/**
 * A panel's username policy, as stored and as submitted. The application layer's
 * `PanelUsernamePolicy` is structurally this, and the duplication is deliberate:
 * `packages/contracts` may not import from `apps/api`, and this is the shape the one
 * evaluator below reads.
 */
export interface UsernamePolicyDraft {
  readonly allowCustom: boolean;
  readonly allowAutomatic: boolean;
  readonly strategy: UsernameStrategy;
  readonly prefix: string | null;
  readonly template: string | null;
}

export const USERNAME_POLICY_REFUSALS = [
  'NO_MODE',
  'STRATEGY_CONFIGURATION',
  'PREFIX',
  'TEMPLATE',
] as const;
export type UsernamePolicyRefusal = (typeof USERNAME_POLICY_REFUSALS)[number];

export interface UsernamePolicyVerdict {
  readonly ok: boolean;
  /** Which of the four questions failed, or null. The first one that did. */
  readonly refusal: UsernamePolicyRefusal | null;
  /** Why, in Persian, for a surface that renders words rather than a code. */
  readonly reason: string | null;
  /** The prefix's own verdict when the strategy uses one. */
  readonly prefix: UsernamePrefixVerdict | null;
  /** The template's own verdict when the strategy uses one. */
  readonly template: UsernameTemplateVerdict | null;
}

/**
 * Whether this policy describes one working generator, and why not if it does not.
 *
 * ONE evaluator with three callers — `PanelService`, the Web Admin's live preview and
 * the Telegram Admin section — for the reason `decideEligibility` states: a predicate
 * copied into three places disagrees with itself invisibly, and here the disagreement
 * is an operator saving a policy one surface said was fine and a customer's purchase
 * failing on it.
 *
 * The prefix and the template are checked only when the saved strategy USES them, and
 * that is not laziness: a template left behind by a strategy change is inert, and
 * refusing to save an unrelated change because of it would trap an operator. What is
 * NOT allowed is a strategy with nothing behind it — `PREFIX_RANDOM` and no prefix is
 * a panel that fails at a customer's purchase, so it is refused at the save.
 *
 * `reason` is Persian prose rather than a code because two surfaces render it directly
 * to an operator. The typed `refusal` is what a caller maps to an error code.
 */
export function validateUsernamePolicy(policy: UsernamePolicyDraft): UsernamePolicyVerdict {
  const empty = { prefix: null, template: null } as const;
  if (!policy.allowCustom && !policy.allowAutomatic) {
    return {
      ok: false,
      refusal: 'NO_MODE',
      reason: 'حداقل یکی از دو روش انتخاب یوزرنیم باید فعال باشد.',
      ...empty,
    };
  }
  if (policy.strategy === 'PREFIX_RANDOM' && policy.prefix === null) {
    return {
      ok: false,
      refusal: 'STRATEGY_CONFIGURATION',
      reason: 'برای روش «پیشوند + تصادفی» باید یک پیشوند ذخیره شود.',
      ...empty,
    };
  }
  if (policy.strategy === 'CUSTOM_TEMPLATE' && policy.template === null) {
    return {
      ok: false,
      refusal: 'STRATEGY_CONFIGURATION',
      reason: 'برای روش «الگوی دلخواه» باید یک الگو ذخیره شود.',
      ...empty,
    };
  }

  const prefix =
    policy.strategy === 'PREFIX_RANDOM' && policy.prefix !== null
      ? validateUsernamePrefix(policy.prefix)
      : null;
  if (prefix !== null && !prefix.ok) {
    return {
      ok: false,
      refusal: 'PREFIX',
      reason:
        'پیشوند باید با یک حرف انگلیسی کوچک شروع شود، فقط شامل حروف کوچک انگلیسی، رقم، خط تیره و زیرخط باشد و حداکثر ' +
        `${USERNAME_PREFIX_MAX_LENGTH} نویسه داشته باشد.`,
      prefix,
      template: null,
    };
  }

  const template =
    policy.strategy === 'CUSTOM_TEMPLATE' && policy.template !== null
      ? validateUsernameTemplate(policy.template)
      : null;
  if (template !== null && !template.ok) {
    return {
      ok: false,
      refusal: 'TEMPLATE',
      reason:
        'الگو باید فقط از نگهدارنده‌های مجاز و حروف کوچک انگلیسی، رقم، خط تیره و زیرخط ساخته شود، دست‌کم یک نگهدارندهٔ یکتاکننده داشته باشد و خروجی آن همیشه بین ' +
        `${PROVIDER_USERNAME_MIN_LENGTH} تا ${PROVIDER_USERNAME_MAX_LENGTH} نویسه بماند.`,
      prefix,
      template,
    };
  }

  return { ok: true, refusal: null, reason: null, prefix, template };
}

/**
 * Values that look real and are not, for a preview an operator reads before saving.
 *
 * Fixed rather than drawn. A preview that consumed the CSPRNG would be indistinguishable
 * from an allocation in a log, and a preview that reserved anything would let an
 * operator exhaust a namespace by looking at a screen. `5973087728` is a
 * plausibly-shaped Telegram id and belongs to nobody.
 */
export const USERNAME_PREVIEW_VALUES: UsernameTemplateValues = {
  telegram_id: '5973087728',
  tg4: '7728',
  customer4: 'c4d2',
  order4: 'o9k1',
  random4: 'a3f9',
  random6: 'a3f91c',
  random10: '4fa2bc91de',
};

/**
 * One name this policy would produce, from `USERNAME_PREVIEW_VALUES`.
 *
 * Shown on both admin surfaces before a save, which is the answer to the legacy
 * write-only settings screen: an operator can see the shape before a customer gets it.
 * It never draws randomness and never reserves.
 *
 * It returns null rather than throwing when the policy is not valid, because a surface
 * calls this WHILE the operator is typing — a half-written template is the normal case,
 * not an error, and the refusal beside it already says what is wrong.
 */
export function previewUsername(policy: UsernamePolicyDraft): string | null {
  if (!validateUsernamePolicy(policy).ok) return null;
  const pool = `${USERNAME_PREVIEW_VALUES.random6}${USERNAME_PREVIEW_VALUES.random10}`;
  switch (policy.strategy) {
    case 'RANDOM':
      return pool.slice(0, RANDOM_STRATEGY_LENGTH);
    case 'PREFIX_RANDOM': {
      const prefix = policy.prefix ?? DEFAULT_USERNAME_PREFIX;
      return `${prefix}${pool.slice(0, prefixRandomLength(prefix))}`;
    }
    case 'TELEGRAM_ID_RANDOM':
      return `${USERNAME_PREVIEW_VALUES.telegram_id}_${USERNAME_PREVIEW_VALUES.random6}`;
    case 'CUSTOM_TEMPLATE':
      return renderUsernameTemplate(policy.template ?? '', USERNAME_PREVIEW_VALUES);
  }
}
