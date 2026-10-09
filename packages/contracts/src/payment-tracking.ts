import { OPERATION_ID_LENGTH } from './operation.js';

/**
 * A payment's PUBLIC tracking code (FIX-02, 2026-10-09) — the one code a customer is shown
 * on every invoice, before anything is paid, and quotes to support afterwards.
 *
 * ## What it is
 *
 * The operation-id half of the payment's stored `reference`. Every payment is created with
 * `reference = <operation id>:<role>` (`PaymentService.referenceFor`): the operation id is
 * DERIVED from the command's idempotency key (`operation.ts`), and the role (`manual`,
 * `topup`, `gateway`, `gateway-topup`, `wallet`) is what lets ONE command write a payment
 * and a ledger entry without their references colliding. The role is an OPERATIONAL part of
 * the key and means nothing to a customer — `7d433a363380f69e:topup` printed on an invoice
 * is an internal key leaking — so the public code is the operation id alone:
 * `7d433a363380f69e`.
 *
 * ## Why it is derived and not stored
 *
 * - Stable: `payments.reference` is written once, in the transaction that creates the
 *   payment; the repository has no write that sets it again, and
 *   `nexa_payments_confirmation_guard` (0033) refuses changing it on a confirmed payment.
 *   So a function of it cannot change across
 *   the lifecycle — the invoice, the receipt, the rejection, the expiry, the credit, the
 *   Web Admin and the search all compute the same answer from the same row.
 * - No new code on a retry: a replayed tap re-reads the SAME payment, and a worker retrying
 *   a gateway create works on the SAME payment, so neither can mint a second code. A
 *   fresh attempt after a closed one is a new payment with its own code, by design.
 * - Nothing in the database changes: the stored reference, the ledger's `<payment id>:topup`
 *   key, the idempotency rows and every provider id are untouched, so accounting and
 *   provider matching cannot be broken by the presentation.
 *
 * ## Uniqueness
 *
 * 64 bits of SHA-256 over a namespaced idempotency key, which the idempotency store binds
 * to ONE request — so one key opens at most one payment. A coincidence between two keys is
 * the birthday bound of `operation.ts` (billions of payments per tenant). The search treats
 * the code as a lookup that may match more than one row and shows every match, so even
 * that coincidence misdirects nobody to a single wrong payment.
 *
 * ## Backward compatibility
 *
 * A reference of any other shape — nothing writes one today, but a row is not a promise —
 * is returned unchanged rather than cut somewhere a colon happens to be: a guess that
 * shortened an unknown reference could make two different payments print one code.
 */
export const PAYMENT_TRACKING_CODE_PATTERN = new RegExp(`^[0-9a-f]{${OPERATION_ID_LENGTH}}$`);

/** `<operation id>:<role>` — the only shape a payment reference is written in. */
const DERIVED_REFERENCE = new RegExp(`^([0-9a-f]{${OPERATION_ID_LENGTH}}):[a-z][a-z-]*$`);

/**
 * THE derivation. Every surface that shows a payment's code — the bot, the customer
 * notification lane, the operator's Telegram review, the financial log, the operational
 * events and the Web Admin — calls this, so there is one answer to "what is this payment's
 * tracking code".
 */
export function paymentTrackingCode(reference: string): string {
  const derived = DERIVED_REFERENCE.exec(reference);
  return derived === null ? reference : (derived[1] as string);
}

/**
 * What a typed search term would be as a tracking code, or null. Case and surrounding
 * whitespace are forgiven (a code read aloud or retyped from a screenshot), and a full
 * stored reference pasted from an older screen is reduced to its code, so both find the
 * payment.
 */
export function trackingCodeFromSearch(term: string): string | null {
  const value = term.trim().toLowerCase();
  if (PAYMENT_TRACKING_CODE_PATTERN.test(value)) return value;
  const derived = DERIVED_REFERENCE.exec(value);
  return derived === null ? null : (derived[1] as string);
}
