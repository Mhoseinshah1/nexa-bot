import type { PaymentState } from '@nexa/contracts';
import { jitteredMs } from './inquiry-schedule.js';

/**
 * R5A item 4 — the rules that decide whether a gateway's LATE approval is credited to the
 * customer's wallet, as pure functions.
 *
 * Pure for the reason `gateway-eligibility.ts` gives: these decide whether a person's money
 * is credited, and a rule that can only be exercised through a network and a database is a
 * rule whose corners never get tested. `tests/unit/late-credit-rules.test.ts` pins each.
 *
 * Gateway-agnostic on purpose. Nothing here names a provider: a route opts in through its
 * descriptor (`lateCreditSetting`), the provider's own inquiry has already said APPROVED by
 * the time anything here is asked, and the amount rule compares two figures the caller
 * supplies. A future route that documents late approvals reuses every function unchanged.
 *
 * What is NOT here, because it is not a rule of this module: whether the approval is real.
 * Only the provider's inquiry decides that (`completed` AND `paid === true`, identity
 * matched), and it has run before the lane calls anything below. A webhook only ever brings
 * that inquiry forward.
 */

/**
 * The states a payment may be in for a late approval to be credited, judged under the
 * payment's lock — and on what BASIS it is credited.
 *
 * `LATE_APPROVAL` (R5A item 4) is credited only while the route's late-credit switch is ON:
 *
 * - `EXPIRED` — the sweep closed it; the customer was told so.
 * - `UNKNOWN` — a provider review ended with no trustworthy answer, or a mismatch held it.
 *   It is credited to the WALLET only: an UNKNOWN payment is never auto-settled into an
 *   order, and still is not.
 * - `PENDING` — only once its effective deadline has passed (the expiry sweep has not run
 *   yet). Inside the deadline the ordinary settlement owns the approval.
 *
 * `RETURNED` (R12 F1) is credited WHATEVER the switch says, because nothing else will ever
 * give that money back:
 *
 * - `CANCELLED` — Nexa withdrew the attempt (the order was paid from the wallet, the customer
 *   cancelled the order or withdrew the payment) while the provider's invoice stayed payable.
 *   The money the provider confirms for it can never pay its order. Before R12 it was recorded
 *   as a late completion and never credited.
 * - `PENDING` inside its deadline whose ORDER is no longer awaiting payment — another payment
 *   (another provider's attempt, the wallet, a transfer) settled it first. A second settlement
 *   is impossible (one confirmed payment per order), so the money goes back to the wallet.
 *
 * `CONFIRMED` is already settled (nothing is owed twice); `FAILED` was a definitive "no"
 * from the provider or an operator and is frozen — an operator's decision, recorded as a late
 * completion.
 */
export type LateCreditBasis = 'LATE_APPROVAL' | 'RETURNED';

export type LateCreditStateDecision =
  | { readonly creditable: true; readonly basis: LateCreditBasis }
  | {
      readonly creditable: false;
      readonly reason: 'ALREADY_CONFIRMED' | 'PAYMENT_CLOSED' | 'STILL_PAYABLE';
    };

export function lateCreditStateDecision(input: {
  readonly state: PaymentState;
  /** The effective deadline (`gatewaySettlementDeadline`); null is "past", never "none". */
  readonly deadline: Date | null;
  /** Read AFTER the payment's lock was taken. */
  readonly now: Date;
  /**
   * Whether the payment's ORDER still awaits payment, read under the payment's lock. Asked
   * only of a PENDING payment inside its deadline; null for a top-up (no order) or when it
   * was not read — and null is never "not awaiting": it credits nothing.
   */
  readonly orderAwaitingPayment?: boolean | null;
}): LateCreditStateDecision {
  switch (input.state) {
    case 'EXPIRED':
    case 'UNKNOWN':
      return { creditable: true, basis: 'LATE_APPROVAL' };
    case 'CANCELLED':
      return { creditable: true, basis: 'RETURNED' };
    case 'PENDING':
      if (input.deadline === null || input.now.getTime() >= input.deadline.getTime()) {
        return { creditable: true, basis: 'LATE_APPROVAL' };
      }
      return input.orderAwaitingPayment === false
        ? { creditable: true, basis: 'RETURNED' }
        : { creditable: false, reason: 'STILL_PAYABLE' };
    case 'CONFIRMED':
      return { creditable: false, reason: 'ALREADY_CONFIRMED' };
    default:
      return { creditable: false, reason: 'PAYMENT_CLOSED' };
  }
}

/**
 * Whether the figure the provider reports for the request agrees with the figure Nexa sent.
 *
 * Only the REQUEST amount is compared — the provider's echo of what Nexa asked for. The
 * provider's `final_amount` is deliberately not: TonPays documents it as differing from the
 * request (a unique transfer figure, a fee) and the audits fix it as metadata that settles
 * nothing. An echo that is ABSENT is not a mismatch for the same reason; a PRESENT echo that
 * differs is: the invoice is not provably this payment's, and no money moves.
 *
 * The amount CREDITED is never read from the provider: it is the payment's own frozen
 * snapshot.
 */
export function lateCreditAmountMatches(input: {
  readonly providerRequestAmount: bigint | null;
  readonly sentAmount: bigint;
}): boolean {
  return input.providerRequestAmount === null || input.providerRequestAmount === input.sentAmount;
}

/** The idempotency identity of a payment's late credit: the ledger reference and the replay key. */
export function lateCreditReference(paymentId: string): string {
  return `${paymentId}:late-credit`;
}

/**
 * How soon a closed payment's open invoice is asked about again: 5 minutes, then 15, then
 * hourly. `step` is the number of post-deadline inquiries already made (0 for the first
 * late poll); the last interval repeats.
 */
export const LATE_CREDIT_POLL_BACKOFF_MS: readonly number[] = [300_000, 900_000, 3_600_000];

export function lateCreditPollDelayMs(step: number): number {
  const last = LATE_CREDIT_POLL_BACKOFF_MS.length - 1;
  const index = Number.isFinite(step) ? Math.min(Math.max(0, Math.trunc(step)), last) : 0;
  return LATE_CREDIT_POLL_BACKOFF_MS[index] ?? 3_600_000;
}

/** The last instant a closed payment's invoice is still asked about. */
export function lateCreditWindowEnd(deadline: Date, windowMs: number): Date {
  return new Date(deadline.getTime() + windowMs);
}

/**
 * When the NEXT late poll is due, or null when the window is over.
 *
 * Jittered ±10 % like every scheduled inquiry, deterministically (a hash of the payment and
 * the step), and clamped so the last question is asked AT the window's end rather than after
 * it. The tenant's inquiry budget bounds how many of these leave in any minute; this decides
 * only when each is due.
 */
export function lateCreditPollAt(input: {
  readonly at: Date;
  readonly paymentId: string;
  readonly step: number;
  /** The effective deadline: the window is measured from it. */
  readonly deadline: Date;
  readonly windowMs: number;
}): Date | null {
  const end = lateCreditWindowEnd(input.deadline, input.windowMs);
  if (input.at.getTime() >= end.getTime()) return null;
  const next = new Date(
    input.at.getTime() + jitteredMs(lateCreditPollDelayMs(input.step), input.paymentId, input.step),
  );
  return next.getTime() > end.getTime() ? end : next;
}

/**
 * A route's late-credit policy, as the lane's scheduling reads it: whether the switch is on,
 * and for how long after the deadline the invoice keeps being asked about.
 */
export interface LateCreditPolicy {
  readonly enabled: boolean;
  readonly windowMs: number;
}

/**
 * R12 F1: whether a CANCELLED attempt is still asked about on its ORDINARY schedule. Nexa
 * withdrew it, but the provider's invoice stays payable until the attempt's own deadline, and
 * money the customer sends before then is returned to the wallet (`RETURNED` above) — so the
 * attempt is polled like an open one until that deadline, and no longer. A null deadline is
 * "past", never "none". Independent of the late-credit switch.
 */
export function cancelledAttemptPollingOpen(input: {
  /** A string: the claim carries the state as the row holds it. */
  readonly state: string;
  readonly now: Date;
  readonly deadline: Date | null;
}): boolean {
  return (
    input.state === 'CANCELLED' &&
    input.deadline !== null &&
    input.now.getTime() < input.deadline.getTime()
  );
}

/** Whether a late poll may still be asked: the window is open and the payment is not closed for good. */
export function lateCreditPollingOpen(input: {
  /** A string: the claim carries the state as the row holds it. */
  readonly state: string;
  readonly now: Date;
  readonly deadline: Date | null;
  readonly windowMs: number;
}): boolean {
  if (input.deadline === null) return false;
  if (input.state === 'CONFIRMED' || input.state === 'FAILED' || input.state === 'CANCELLED') {
    return false;
  }
  return input.now.getTime() < lateCreditWindowEnd(input.deadline, input.windowMs).getTime();
}
