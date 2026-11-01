import { z } from 'zod';
import { LIST_SEARCH_MAX_LENGTH } from './list-search.js';

/**
 * The Web Admin's global search (R11 A1, the top-bar search of the approved demo).
 *
 * ONE read-only route that answers "which customer, order or service is this?" for a string an
 * operator typed, so the search box is no longer a page navigator only. It is NOT a new
 * capability and adds NO permission: each kind is searched, and returned, only when the actor
 * already holds the permission that kind's own list requires —
 *
 *   - `CUSTOMER`: `users.view` AND `users.search` (the `/users` list's own pair);
 *   - `ORDER`:    `orders.view`;
 *   - `SERVICE`:  `services.view`;
 *   - `PAYMENT`:  `payments.view` — found by its public tracking code (R12 F3 item 8);
 *   - `TICKET`:   `tickets.view` — found by its number (R12 F3 item 8).
 *
 * A kind the actor may not read is ABSENT from `groups` — not an empty group, not an error —
 * so the response never reveals that a matching record exists to someone who may not list it.
 * The string is classified by `classifyListSearch` exactly as each list's `q` is (a Telegram id
 * is matched whole, never as a prefix), and each kind is bounded by `limit` hits (default 5, at
 * most 10) with a `hasMore` flag, so this is a jump-to-record box and not a second list.
 *
 * A hit carries no secret: no subscription link, no panel credential, no balance.
 */

export const GLOBAL_SEARCH_ROUTES = { search: '/search' } as const;

/** The kinds, in the order their groups are returned. */
export const GLOBAL_SEARCH_KINDS = [
  'CUSTOMER',
  'ORDER',
  'SERVICE',
  // R12 F3 item 8: a payment's tracking code and a ticket's number.
  'PAYMENT',
  'TICKET',
] as const;
export type GlobalSearchKind = (typeof GLOBAL_SEARCH_KINDS)[number];

export const GLOBAL_SEARCH_LIMIT_DEFAULT = 5;
export const GLOBAL_SEARCH_LIMIT_MAX = 10;

/** `q`: trimmed, non-empty, at most `LIST_SEARCH_MAX_LENGTH` characters; `limit` per kind. */
export const globalSearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(LIST_SEARCH_MAX_LENGTH),
    limit: z.coerce.number().int().min(1).max(GLOBAL_SEARCH_LIMIT_MAX).optional(),
  })
  .strict();
export type GlobalSearchQuery = z.infer<typeof globalSearchQuerySchema>;

export const globalSearchHitSchema = z
  .object({
    /** The record's id: the web links `/users/:id`, `/orders/:id` or `/services/:id` with it. */
    id: z.string().min(1),
    /** What the row is called: a customer's name or @username, an order's or service's code. */
    title: z.string(),
    /** One more fact to tell two hits apart (a username, a product line); null when none. */
    subtitle: z.string().nullable(),
    /** The record's state code (a customer status, an order state, a service state). */
    state: z.string().nullable(),
  })
  .strict();
export type GlobalSearchHit = z.infer<typeof globalSearchHitSchema>;

export const globalSearchGroupSchema = z
  .object({
    kind: z.enum(GLOBAL_SEARCH_KINDS),
    hits: z.array(globalSearchHitSchema).max(GLOBAL_SEARCH_LIMIT_MAX),
    /** True when the kind's list holds more matches than `hits` shows. */
    hasMore: z.boolean(),
  })
  .strict();
export type GlobalSearchGroup = z.infer<typeof globalSearchGroupSchema>;

export const globalSearchResponseSchema = z
  .object({ groups: z.array(globalSearchGroupSchema).max(GLOBAL_SEARCH_KINDS.length) })
  .strict();
export type GlobalSearchResponse = z.infer<typeof globalSearchResponseSchema>;
