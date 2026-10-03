import { z } from 'zod';
import { telegramUserIdSchema } from './customer.js';
import { uuidV7Schema } from './ids.js';

/**
 * The ONE free-text search box a Web Admin list page draws (spec §10).
 *
 * Before this, each list carried its own row of text inputs — a Telegram id box and a
 * username box on `/users`, two internal-uuid boxes on `/orders`, three on `/payments`,
 * three on `/services` — and an operator answering a support message had to know which
 * box the string in front of them belonged in. The commonest mistake, recorded in
 * `apps/web/src/pages/orders.tsx`, was pasting a TELEGRAM id into a box that wanted the
 * internal uuid.
 *
 * So a list takes one `q`, and the SERVER decides what it is by its shape. The shapes
 * do not overlap, which is what makes one box safe:
 *
 * - `TELEGRAM_ID` — digits only, the contract's own `telegramUserIdSchema`. Matched
 *   EXACTLY, never as a prefix: a partial match on a Telegram id would be a way to
 *   enumerate them, and an operator holding one has all of it.
 * - `UUID` — an internal id (an order, a payment, a customer, a product, a panel),
 *   lower-cased because Postgres compares `uuid` case-insensitively and JavaScript does
 *   not. Matched exactly against whichever id columns the list carries.
 * - `USERNAME` — a leading `@`, stripped. A Telegram username prefix, case-folded.
 * - `TEXT` — anything else: a name, a product name, a payment reference, a provider
 *   username. What each list matches it against is that list's own decision, and each
 *   one is bounded by an index (see `docs/web-admin-search.md`).
 *
 * The classifier lives in the CONTRACT so the Web Admin can tell an operator what their
 * text was read as, from the same function the server decides with. Two copies would be
 * two answers to "what did I just search for".
 */
export const LIST_SEARCH_MAX_LENGTH = 64;

/** The `q` parameter every searchable list accepts: trimmed, non-empty, bounded. */
export const listSearchQuerySchema = z.string().trim().min(1).max(LIST_SEARCH_MAX_LENGTH);

export const LIST_SEARCH_KINDS = ['TELEGRAM_ID', 'UUID', 'USERNAME', 'TEXT'] as const;
export type ListSearchKind = (typeof LIST_SEARCH_KINDS)[number];

export type ListSearchTerm =
  | { readonly kind: 'TELEGRAM_ID'; readonly value: string }
  | { readonly kind: 'UUID'; readonly value: string }
  | { readonly kind: 'USERNAME'; readonly value: string }
  /**
   * `value` is the trimmed text as typed (an exact match on a payment reference is
   * case-sensitive, because the column is); `folded` is its lower-case form, for the
   * case-insensitive prefix matches.
   */
  | { readonly kind: 'TEXT'; readonly value: string; readonly folded: string };

/**
 * What a search string IS, decided by shape alone. `null` for an empty string — no
 * search — so a caller cannot mistake whitespace for a query that matched nothing.
 *
 * A bare `@` with nothing after it is TEXT, not an empty username: an empty prefix would
 * match every customer with a username, which is a list, not a search.
 */
export function classifyListSearch(raw: string): ListSearchTerm | null {
  const text = raw.trim();
  if (text === '') return null;
  if (telegramUserIdSchema.safeParse(text).success) return { kind: 'TELEGRAM_ID', value: text };
  if (uuidV7Schema.safeParse(text).success) return { kind: 'UUID', value: text.toLowerCase() };
  if (text.startsWith('@') && text.length > 1) {
    return { kind: 'USERNAME', value: text.slice(1).toLowerCase() };
  }
  return { kind: 'TEXT', value: text, folded: text.toLowerCase() };
}
