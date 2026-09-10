import type { OperationId } from './operation.js';
import type { OrderId, ServiceId } from './ids.js';

/**
 * The note this installation writes on a provider-side user, when it can.
 *
 * ## What exists and what does not
 *
 * There is NO write path to any provider-side user field. Both adapters can
 * authenticate and read status, and nothing else. So this file is a format and a
 * set of rules, with no caller — deliberately, and the audit (item L) classifies
 * it that way: the format can exist now without inventing a Phase 4 entity, and
 * the capability must NOT be advertised until an adapter performs it.
 *
 * That last point is a rule with history. `provider.ts` records that Marzban's
 * descriptor once advertised fourteen operations no code could perform, and that
 * it was rejected — because the endpoint publishing that array is how the product
 * tells an operator what it can do. So `PROVIDER_CAPABILITIES` gains nothing here.
 *
 * ## Whether providers even have such a field is UNKNOWN
 *
 * The research corpus says nothing about a provider-side note. Per `CLAUDE.md`
 * that is `NOT_EXPOSED` — "the UI did not show it" — and never proof of absence,
 * so it is an open question rather than a decision. See `docs/open-questions.md`.
 *
 * ## The format
 *
 *     TG: <telegram numeric id> | Service: <service id> | LastOrder: <order id> | LastOp: <operation id>
 *
 * Telegram id FIRST, because the note is read by a human looking at somebody
 * else's panel trying to work out whose account this is, and the Telegram id is
 * the answer to that question. Every other field answers a follow-up.
 *
 * No `NEXA` prefix. A prefix costs five characters of a 500-character budget and
 * buys nothing: the operator reading the note knows which system wrote it, and a
 * machine that needed to know would match the field names.
 *
 * `LastOrder` and `LastOp` are named LAST on purpose. A service is renewed and
 * extended many times; each is a new order and a new operation against the same
 * service. The note carries the most recent of each, not a history, because a
 * 500-character field is not a log and trying to make it one is how it overflows.
 */

/**
 * The cap, in characters.
 *
 * 500 because that is the figure the owner's specification fixes. It is NOT known
 * to be any provider's real limit — no provider's note field has been observed at
 * all — so this is a self-imposed budget chosen to be smaller than any plausible
 * one, not a measured constraint. When a provider's actual limit is known, the
 * smaller of the two wins and this comment stops being a caveat.
 */
export const PROVIDER_NOTE_MAX_LENGTH = 500;

/** The separator between fields. Spaces included, so a reader can scan it. */
export const PROVIDER_NOTE_SEPARATOR = ' | ';

export interface ProviderNoteFacts {
  /**
   * The customer's Telegram numeric id, as a string.
   *
   * A string rather than a number, and not because of precision: this value is
   * never arithmetic. Telegram ids are already past 2^32 and the Bot API documents
   * them as up to 52 bits, so a `number` would survive — but every use of this one
   * is identity, and a numeric type invites comparison, sorting and formatting
   * that identity does not want.
   *
   * Never the `@username`. A username changes, disappears and is reused, so a note
   * keyed on one names whoever holds it today. The numeric id is the account.
   */
  readonly telegramId: string;
  readonly serviceId: ServiceId;
  readonly orderId: OrderId;
  readonly operationId: OperationId;
}

/**
 * Renders the note.
 *
 * Total and pure. It refuses rather than truncates when over budget: a truncated
 * note is a note whose last field is half an identifier, and half an identifier is
 * worse than no field — it looks like data. With the real field widths this cannot
 * happen (the four values are about 90 characters together), so a refusal here
 * means a caller passed something unexpected, which is exactly when silence is
 * wrong.
 */
export function formatProviderNote(facts: ProviderNoteFacts): string {
  if (facts.telegramId === '') throw new Error('a provider note needs a Telegram id');
  const note = [
    `TG: ${facts.telegramId}`,
    `Service: ${facts.serviceId}`,
    `LastOrder: ${facts.orderId}`,
    `LastOp: ${facts.operationId}`,
  ].join(PROVIDER_NOTE_SEPARATOR);
  if (note.length > PROVIDER_NOTE_MAX_LENGTH) {
    throw new Error(
      `a provider note may be at most ${PROVIDER_NOTE_MAX_LENGTH} characters; this one is ${note.length}`,
    );
  }
  return note;
}

/**
 * Whether a note was written by this installation.
 *
 * The READ half of read-before-write, and the reason the write half cannot be
 * written yet. The rule is that an operator's own note is never silently
 * overwritten — so a caller must read the field first and refuse to replace
 * anything it did not write.
 *
 * Recognition is by SHAPE, not by a marker, because there is no marker: the note
 * has no prefix by design. A note this returns false for is somebody else's, and
 * the conservative reading of an ambiguous case is "somebody else's" — a refusal
 * costs an operator one manual edit, and a wrong overwrite destroys a human's
 * note with no copy anywhere.
 *
 * An EMPTY field is not somebody else's note; it is an empty field, and writing
 * into it overwrites nothing.
 */
export function isNexaProviderNote(existing: string): boolean {
  const trimmed = existing.trim();
  if (trimmed === '') return true;
  return /^TG: \S+ \| Service: \S+ \| LastOrder: \S+ \| LastOp: [0-9a-f]{16}$/.test(trimmed);
}
