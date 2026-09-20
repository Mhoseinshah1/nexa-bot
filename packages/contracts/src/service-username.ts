import { z } from 'zod';

/**
 * How a customer's service gets the name the provider knows it by.
 *
 * Two modes, and the panel decides which of them a customer may use. They are not
 * variations of one thing: `CUSTOM` is a value the customer authored and this
 * installation must not alter, `RANDOM` is a value this installation authored and the
 * customer never sees before it exists.
 *
 * There is deliberately no third mode. A "legacy" panel — one whose
 * `username_template` is still null — is a RANDOM panel whose generator is
 * `providerUsernameFor` rather than a template; see `PANEL_LEGACY_TEMPLATE`. Making
 * that a mode would put a migration state into a customer-facing vocabulary, and every
 * surface would have to render it.
 */
export const SERVICE_USERNAME_MODES = ['CUSTOM', 'RANDOM'] as const;
export type ServiceUsernameMode = (typeof SERVICE_USERNAME_MODES)[number];
export const serviceUsernameModeSchema = z.enum(SERVICE_USERNAME_MODES);

/**
 * A panel whose `username_template` is null still generates RANDOM names — with the
 * generator that produced every username in production before this phase.
 *
 * Null rather than a sentinel string, because a sentinel is a value an operator can
 * type. `docs/phase6c-audit.md` A-2 records why this resolves cleanly: the legacy
 * behaviour is a pure function of the service id with no configuration behind it, so
 * "preserve what this panel does today" needs no stored evidence and no guess.
 */
export const PANEL_LEGACY_TEMPLATE = null;

// ---------------------------------------------------------------------------
// CUSTOM — what a customer may type
// ---------------------------------------------------------------------------

/**
 * The documented baseline, and a FLOOR rather than a preference.
 *
 * 8 to 16 characters from `A-Z`, `a-z`, `0-9`, `-` and `_`, containing at least one
 * English letter and at least one digit. A provider adapter may be stricter — a panel
 * that refuses `-` is entitled to — but may not broaden this, because the baseline is
 * what the customer was promised and what the Telegram copy describes.
 *
 * ## Case is INPUT, not identity
 *
 * A customer may type `Ali_2026`; the identity is `ali_2026`. Usernames here are
 * case-insensitive, and the fold happens once, at the boundary, before anything durable
 * sees the value — see `canonicalizeCustomUsername`. Accepting both spellings and
 * storing one is what makes `Ali_2026` and `ali_2026` collide on the same reservation
 * rather than becoming two accounts an operator reading a client list cannot tell apart.
 *
 * ## At least one letter and at least one digit
 *
 * Not a strength rule — a username is an identifier, not a secret. It is a legibility
 * rule: `12345678` and `--------` are both eight characters a support conversation
 * cannot say out loud, and the second is not obviously a username at all. Requiring one
 * of each keeps every accepted name pronounceable and recognisable.
 */
export const CUSTOM_USERNAME_MIN_LENGTH = 8;
export const CUSTOM_USERNAME_MAX_LENGTH = 16;

/**
 * What a customer may TYPE. Either case, and nothing outside ASCII.
 *
 * The rejections are as deliberate as the acceptances. Persian letters and Persian
 * digits, whitespace, `@`, `.`, `/` and emoji are all refused rather than stripped,
 * because a name this installation altered is a name the customer did not choose and
 * would not recognise on their own service. `۱۴۰۳` looks like digits and is not
 * `1403`; `Ali` and `Аli` with a Cyrillic А are two different strings that render
 * identically.
 */
export const CUSTOM_USERNAME_INPUT_PATTERN = /^[A-Za-z0-9_-]{8,16}$/;
/** The same set after the case fold: what is reserved, stored and sent to a provider. */
export const CUSTOM_USERNAME_CANONICAL_PATTERN = /^[a-z0-9_-]{8,16}$/;
const HAS_ASCII_LETTER = /[A-Za-z]/;
const HAS_ASCII_DIGIT = /[0-9]/;

/**
 * What a rendered or typed name may contain, whoever produced it.
 *
 * Lowercase ASCII, digits and underscore. No uppercase and no `-`, and the reason is
 * stated so the next reader does not "fix" it: a provider happening to ACCEPT uppercase
 * is not a reason to mint it. Two accounts differing only in case are two accounts an
 * operator reading a client list cannot tell apart, and case-folding behaviour across
 * Marzban, 3X-UI and whatever comes third is not something this repository has evidence
 * for.
 */
export const RENDERED_USERNAME_PATTERN = /^[a-z0-9_]+$/;

/**
 * The longest name this installation has EVIDENCE a real panel accepts.
 *
 * 34, because that is `providerUsernameFor` — `nx` plus 32 hex — and
 * `tests/acceptance/real-panel-marzban.test.ts` and its 3X-UI counterpart have driven
 * the shipped adapters against real panels using exactly that shape. Every account
 * this product has ever created on a real panel is 34 characters.
 *
 * It is NOT a claim about either provider's true limit, which is UNKNOWN
 * (`docs/open-questions.md`, OQ-6C-01) because `ProviderAdapter` exposes no username
 * length and neither panel's documentation states one. A generous guess was the first
 * version of this constant and is the wrong shape of error: it would let an operator
 * save a 60-character template, and the first customer to hit the provider's real
 * limit would find out AFTER their money moved. Refusing an over-long template while
 * the operator is still looking at the field costs them a shorter template; the other
 * ordering costs a customer a failed purchase.
 *
 * Raising this is a real-panel acceptance task, not an edit — the rule
 * `docs/real-panel-acceptance.md` states: a fake this repository wrote and an adapter
 * this repository wrote can only prove they agree with each other.
 */
export const PROVEN_PROVIDER_USERNAME_MAX_LENGTH = 34;

/**
 * How long a template's RAW TEXT may be, which is not how long its output may be.
 *
 * `{telegram_id}` is thirteen characters that render as up to sixteen, and
 * `{random10}` is eleven that render as ten. Bounding the stored string by the
 * rendered maximum would refuse templates that produce perfectly legal names, so this
 * is its own, looser bound — a storage limit, not a correctness one.
 * `worstCaseRenderedLength` is what decides whether the OUTPUT fits.
 */
export const USERNAME_TEMPLATE_MAX_LENGTH = 128;

/**
 * Is this something a customer may type?
 *
 * Asked of the RAW input, before any fold. Whitespace is refused here rather than
 * trimmed: a trailing space is a difference the customer cannot see, and silently
 * removing it is still a rewrite — the same class of act as stripping an emoji, and the
 * legacy behaviour this product exists to replace. They are told, and they type it
 * again.
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
// The template language
// ---------------------------------------------------------------------------

/**
 * Every placeholder, and the worst case each one renders to.
 *
 * The lengths are what `worstCaseRenderedLength` sums, so a template is refused at save
 * time rather than at a customer's purchase. Each is the true maximum, not a typical
 * value:
 *
 * - `telegram_id` — 16, not the 10 digits Telegram issues today. The API documents ids
 *   as safe up to 52 bits, which is 16 decimal digits, and a template that fits today's
 *   ids and not tomorrow's would fail for one customer, once, with the money already
 *   taken.
 * - `customer_id` / `order_id` — 32, a UUID with its dashes removed.
 * - `random6` / `random10` — exactly what they say.
 */
export const USERNAME_TEMPLATE_TOKENS = {
  telegram_id: 16,
  customer_id: 32,
  order_id: 32,
  random6: 6,
  random10: 10,
} as const;
export type UsernameTemplateToken = keyof typeof USERNAME_TEMPLATE_TOKENS;
export const USERNAME_TEMPLATE_TOKEN_NAMES = Object.keys(
  USERNAME_TEMPLATE_TOKENS,
) as readonly UsernameTemplateToken[];

/**
 * The tokens that make a name unique PER ORDER.
 *
 * `telegram_id` and `customer_id` are not here, and that is the whole of this rule: one
 * customer may own several services, so a template built only from who they are renders
 * the same string for their second purchase — which collides on the first reservation
 * and refuses a sale that should have succeeded.
 */
export const USERNAME_UNIQUENESS_TOKENS: readonly UsernameTemplateToken[] = [
  'order_id',
  'random6',
  'random10',
];

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
] as const;
export type UsernameTemplateIssue = (typeof USERNAME_TEMPLATE_ISSUES)[number];

export interface UsernameTemplateVerdict {
  readonly ok: boolean;
  readonly issues: readonly UsernameTemplateIssue[];
  /** The tokens the template actually uses, in first-appearance order. */
  readonly tokens: readonly UsernameTemplateToken[];
  /** What this template renders to when every token is at its maximum. */
  readonly worstCaseLength: number;
}

/**
 * The longest string this template can produce.
 *
 * Literal text counts as itself; each placeholder counts as its token's maximum. A
 * template validated on a typical render would pass at save time and then produce a name
 * the panel refuses for the one customer whose Telegram id is longer than the operator's
 * — after the money moved.
 */
export function worstCaseRenderedLength(template: string): number {
  let length = 0;
  let cursor = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    length += match.index - cursor;
    const token = match[1] as UsernameTemplateToken;
    length += USERNAME_TEMPLATE_TOKENS[token] ?? match[0].length;
    cursor = match.index + match[0].length;
  }
  return length + (template.length - cursor);
}

/**
 * Whether this template may be saved, and everything wrong with it if not.
 *
 * Every issue at once rather than the first, for the reason the config loader states:
 * an operator fixing one problem per round trip is an operator who gives up. The verdict
 * also carries the tokens and the worst case, so a surface can render both without
 * parsing the template a second time with its own regex.
 *
 * `maxLength` comes from the selected provider's adapter, falling back to
 * `PROVEN_PROVIDER_USERNAME_MAX_LENGTH`. It is a parameter rather than a constant
 * because the same template may be legal on one provider and not on another, and the
 * panel is what binds the two together.
 */
export function validateUsernameTemplate(
  template: string,
  maxLength: number = PROVEN_PROVIDER_USERNAME_MAX_LENGTH,
): UsernameTemplateVerdict {
  const issues: UsernameTemplateIssue[] = [];
  const tokens: UsernameTemplateToken[] = [];
  const trimmed = template.trim();

  if (trimmed.length === 0) {
    return { ok: false, issues: ['EMPTY'], tokens: [], worstCaseLength: 0 };
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
  if (literal.length > 0 && !RENDERED_USERNAME_PATTERN.test(literal)) {
    issues.push('ILLEGAL_CHARACTER');
  }
  if (!tokens.some((token) => USERNAME_UNIQUENESS_TOKENS.includes(token))) {
    issues.push('NO_UNIQUENESS_TOKEN');
  }

  const worstCaseLength = worstCaseRenderedLength(trimmed);
  if (worstCaseLength > maxLength) issues.push('TOO_LONG');

  return { ok: issues.length === 0, issues, tokens, worstCaseLength };
}

/** What a render needs. Every field is required, so a missing one cannot render empty. */
export interface UsernameTemplateValues {
  readonly telegram_id: string;
  readonly customer_id: string;
  readonly order_id: string;
  readonly random6: string;
  readonly random10: string;
}

/**
 * Substitute, and refuse anything the substitution produced that is not a legal name.
 *
 * The second half is not belt-and-braces. `validateUsernameTemplate` bounds the WORST
 * case; a real render can still be illegal if a caller passes a value this contract did
 * not shape — a Telegram id with a minus sign, a uuid that kept its dashes. Checking the
 * RESULT is the check that cannot be fooled by a caller's mistake, and it runs before
 * the name is reserved rather than after the panel refuses it.
 */
export function renderUsernameTemplate(template: string, values: UsernameTemplateValues): string {
  const rendered = template
    .trim()
    .replace(PLACEHOLDER, (whole, name: string) =>
      Object.prototype.hasOwnProperty.call(values, name)
        ? values[name as UsernameTemplateToken]
        : whole,
    );
  if (!RENDERED_USERNAME_PATTERN.test(rendered)) {
    throw new Error('a rendered service username must be lowercase letters, digits or _');
  }
  return rendered;
}

/**
 * How many times a colliding RANDOM candidate is regenerated before the sale is refused.
 *
 * Five, and then a refusal BEFORE any debit. Not an infinite retry: a template with no
 * real entropy — one whose only uniqueness token is `{order_id}`, rendered for an order
 * that already has a reservation — collides identically every time, and a loop would
 * turn a configuration mistake into a hung checkout rather than a message an operator
 * can act on.
 */
export const RANDOM_USERNAME_MAX_ATTEMPTS = 5;

/**
 * The alphabet for `{random6}` and `{random10}`.
 *
 * Lowercase letters and digits, 36 symbols. `random6` is therefore ~31 bits and
 * `random10` ~51: the first is for a template that already carries an order or customer
 * id, the second for one that does not. Neither is a secret — a username is an
 * identifier, and `services.subscription_ref` is where this product keeps the thing that
 * IS a capability — but both are minted from the same CSPRNG the secrets port uses,
 * because a predictable name lets somebody enumerate an operator's client list.
 */
export const RANDOM_USERNAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Is this the shape `providerUsernameFor` produces?
 *
 * Existing services carry a 34-character derived name that the CUSTOM contract above
 * would reject on length alone. Nothing renames them, and nothing may retroactively
 * refuse them: this predicate is what lets a validation path tell "a legacy name" from
 * "a name somebody typed wrongly" without reaching for the service id.
 */
export const LEGACY_USERNAME_PATTERN = /^nx[0-9a-f]{32}$/;
