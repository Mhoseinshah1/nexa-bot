import { z } from 'zod';
import type { UserId } from './ids.js';

/**
 * The customer — the person on the other end of a Telegram bot.
 *
 * ## Why there is no `CustomerId`
 *
 * `ids.ts` already declares `UserId`, and the Phase 4 audit found it unused by any
 * table. So the canonical customer identifier is `UserId`, and this file does not
 * mint a second one. An entity with two names is the legacy system's defining
 * defect — "receipt" and "payment" name the same record there (PRBR-004) — and the
 * cost is paid by every later reader who has to work out which one a function
 * means.
 *
 * ## Identity is the Telegram numeric id, and only that
 *
 * Uniqueness is `(tenant_id, telegram_user_id)`.
 *
 * - **Per tenant, not global.** One installation can serve several tenants, and the
 *   same human may legitimately be a customer of two of them. A global unique index
 *   would make the second tenant's first `/start` collide with a row it cannot see,
 *   which is a cross-tenant information leak expressed as a constraint violation.
 * - **Not the bot instance.** A tenant owns several bot instances and a customer who
 *   writes to two of them is one customer. Keying on `(bot_instance_id,
 *   telegram_user_id)` would split them, and the split is invisible until the
 *   customer asks why their wallet is empty in one bot.
 * - **Never the username.** A Telegram username is mutable, removable and
 *   reassignable: a row keyed on one names whoever holds it today. The legacy system
 *   keyed a Persian caption as an identifier and the research records what that cost.
 *   So `username` is metadata here, nullable, and nothing resolves a customer by it
 *   except an explicit operator SEARCH, which is allowed to return nothing.
 *
 * The Telegram id is carried as a STRING rather than a number, for the reason
 * `provider-note.ts` already gives about the same value: every use of it is
 * identity, and a numeric type invites arithmetic, sorting and formatting that
 * identity does not want. Telegram documents ids as up to 52 bits, so a `number`
 * would survive — surviving is not the argument.
 */
export type CustomerId = UserId;

/**
 * Telegram's own id for an account, as text.
 *
 * Digits only, no sign, no leading zero, and bounded. Telegram ids are positive for
 * users; a negative id is a chat, and a chat is not a customer. The 19-character
 * bound is past any 64-bit value and exists so an absurd input is refused at the
 * boundary rather than stored.
 */
export const telegramUserIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,18}$/, 'must be a positive Telegram numeric id');

/**
 * Whether this installation will serve this customer.
 *
 * Two states, because a third would have to mean something and nothing in the
 * research supports one. `BLOCKED` is an operator decision about a person, and it is
 * deliberately NOT the same axis as a tenant being stopped or a bot being disabled —
 * those are installation states and they already have their own columns.
 *
 * A block is not a soft delete. The customer's orders, payments, ledger entries and
 * services all survive it, because they are facts and a block is not a retraction.
 */
export const CUSTOMER_STATUSES = ['ACTIVE', 'BLOCKED'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];
export const customerStatusSchema = z.enum(CUSTOMER_STATUSES);

/**
 * The metadata a customer row may hold, and nothing beyond it.
 *
 * Every field here is either identity, something a surface renders, or something a
 * support conversation needs. Telegram sends a great deal more on every update and
 * none of it is stored: an update carries message text, entities, forwarded origins
 * and chat metadata, and a row that accumulated those would be a copy of the
 * customer's conversation in a table nobody audits.
 *
 * `languageCode` is stored and deliberately not yet consulted. The product ships one
 * Persian catalogue (`@nexa/i18n`), so acting on this field would mean inventing a
 * second one; recording it costs nothing and is the evidence a second catalogue would
 * be designed from.
 */
export interface CustomerProfileFacts {
  /** Telegram's `from.username`, without the `@`. Null when the account has none. */
  readonly username: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  /** Telegram's IETF language tag, e.g. `fa`, `en-GB`. Recorded, not yet consulted. */
  readonly languageCode: string | null;
}

/**
 * The bounds a stored profile field is held to.
 *
 * Telegram does not document limits for all of these, so these are OUR bounds, set
 * so an oversized value is refused at the boundary instead of widening a column
 * later. A value over the bound is TRUNCATED rather than refused, and the difference
 * matters: this data arrives from a third party on a path that must answer 200, so
 * refusing it would turn a long display name into an update Telegram redelivers for
 * ever.
 */
export const CUSTOMER_USERNAME_MAX_LENGTH = 64;
export const CUSTOMER_NAME_MAX_LENGTH = 128;
export const CUSTOMER_LANGUAGE_CODE_MAX_LENGTH = 16;

/**
 * Normalises one profile field for storage.
 *
 * Trims, collapses an empty result to null, and truncates to the bound. Null and
 * empty are the SAME thing here — Telegram omits a field it has no value for, and a
 * client that sends `""` means the same — so storing both would give two
 * representations of "absent" and every query would have to know.
 */
export function normaliseProfileField(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/**
 * The profile facts carried by a Telegram `from` object, normalised.
 *
 * Total: anything that is not the expected shape yields nulls rather than throwing.
 * This runs on the webhook path, where the alternative to a null is an update
 * Telegram retries for ever.
 */
export function profileFactsFrom(from: unknown): CustomerProfileFacts {
  const source = (from ?? {}) as Record<string, unknown>;
  return {
    username: normaliseProfileField(source.username, CUSTOMER_USERNAME_MAX_LENGTH),
    firstName: normaliseProfileField(source.first_name, CUSTOMER_NAME_MAX_LENGTH),
    lastName: normaliseProfileField(source.last_name, CUSTOMER_NAME_MAX_LENGTH),
    languageCode: normaliseProfileField(source.language_code, CUSTOMER_LANGUAGE_CODE_MAX_LENGTH),
  };
}

/**
 * What `/start` did, as the surface needs to know it.
 *
 * Three outcomes rather than a boolean, because the third one is the one that gets
 * forgotten: a BLOCKED customer who sends `/start` must not be greeted, must not be
 * unblocked, and must not be silently ignored either — an operator needs the event
 * and the customer needs a bounded answer.
 */
export const CUSTOMER_ARRIVALS = ['FIRST_SEEN', 'RETURNING', 'BLOCKED'] as const;
export type CustomerArrival = (typeof CUSTOMER_ARRIVALS)[number];
