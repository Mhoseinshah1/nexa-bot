import { z } from 'zod';
import type { StateMachineDefinition } from './state-machine.js';

/**
 * Payments and the wallet.
 *
 * ## The honest starting position
 *
 * The research is unambiguous and uncomfortable: the legacy system surfaces **no
 * Payment entity at all**, its wallet is a mutable balance column an admin
 * increments directly with no ledger and no history, "receipt" and "payment" name the
 * same record (PRBR-004), refund exists only as a log verb on deleting a service, and
 * **no exchange rate exists anywhere** — absent from all seven inspected gateways.
 *
 * So there is nothing to port. What follows is designed from the invariants, and the
 * invariant that drives it is `ledger.ts`: the ledger is append-only, amounts are
 * positive with a separate direction, and a reversal is a new entry. The unexplained
 * 916,550 residual in the legacy data is what the alternative produces.
 *
 * ## Why `OUTCOME_UNKNOWN` is a first-class state
 *
 * `backup.ts` already learned this about Telegram delivery, and it is in `CLAUDE.md`
 * as a rule: a 5xx, a 429, a timeout and an unreadable 2xx are **unknown**, never
 * "retryable", because the remote side can accept an effect and fail to say so. A
 * payment is the same shape with money attached. A gateway that times out may have
 * taken the customer's money; treating that as a failure and letting them pay again is
 * a double charge, and treating it as a success is theft in the other direction.
 *
 * So `UNKNOWN` is terminal for the PAYMENT and resolvable only by reconciliation — an
 * operator or a gateway query establishing what really happened, recorded as a new
 * transition. Nothing retries it automatically.
 */

export const PAYMENT_STATES = [
  /** Created, nothing attempted. The customer has been shown instructions or a link. */
  'PENDING',
  /** Money confirmed by evidence this installation trusts. */
  'CONFIRMED',
  /** The attempt definitively did not take money. */
  'FAILED',
  /** Withdrawn before confirmation. */
  'CANCELLED',
  /** Nobody confirmed or withdrew it in the window. */
  'EXPIRED',
  /**
   * The external side may or may not have taken money, and this installation cannot
   * tell. Terminal until reconciled; never retried automatically.
   */
  'UNKNOWN',
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];
export const paymentStateSchema = z.enum(PAYMENT_STATES);

export const PAYMENT_TERMINAL_STATES = ['CONFIRMED', 'FAILED', 'CANCELLED', 'EXPIRED'] as const;

/**
 * The terminal states a payment reaches WITHOUT money having moved.
 *
 * `PAYMENT_TERMINAL_STATES` minus `CONFIRMED`, named rather than derived because three
 * separate things need the same list and a derived one would be re-derived differently
 * in at least one of them: the schema's `payments_resolved_check`, the repository's
 * `from` guards, and the surfaces deciding whether anything can still be done to a row.
 *
 * What they share is the fact `payments_confirmed_check` states from the other side —
 * `confirmed_at` and `evidence_kind` belong to a confirmation, so a payment that ended
 * without one has nothing to put in them. It needs its own three: WHEN it was resolved,
 * WHO resolved it if a person did, and WHY. The legacy receipt review records none of
 * that for an approval (`UNK-PR-010`), and the question about a rejection is the same
 * question.
 *
 * Deliberately NOT a parallel `resolution_kind` enum. The state is the classification
 * already — `commerce.ts` argues exactly this for orders, that *"the customer changed
 * their mind" and "we stopped waiting" are different facts about the same row* and must
 * not be merged — so a kind column would today be derivable from `state` by a rule, and
 * a second source of truth that can disagree with the first. A gateway-driven or
 * reconciled failure, when one exists, is distinguished by `resolved_by_admin_id` being
 * null, not by a member added here in advance of its producer.
 */
export const PAYMENT_RESOLVED_STATES = ['FAILED', 'CANCELLED', 'EXPIRED'] as const;
export type PaymentResolvedState = (typeof PAYMENT_RESOLVED_STATES)[number];

/**
 * The bounds on how long a PENDING payment is held open.
 *
 * The maximum is the owner's, stated in owner revision 4 and recorded in
 * `docs/open-questions.md` under `OQ-4C-01`:
 *
 * > «مهلت پرداخت حداکثر **یک ساعت** است و پس از آن پرداخت و سفارش باید منقضی یا لغو
 * > شوند. این قاعده باید در دامنه و سرور اجرا شود، نه با یک تایمر در مرورگر.»
 *
 * At most one hour; after it, the payment AND the order must be expired or cancelled;
 * and the rule belongs in the domain and on the server rather than in a browser timer.
 * So the hour is the CEILING, not the default-and-suggestion: a tenant may hold a
 * transfer open for less time than the owner fixed and may not hold one for longer.
 *
 * The floor is five minutes, matching `ORDER_EXPIRY_MINUTES_MIN`, and for the reason
 * that setting gives: a window shorter than the time it takes a customer to open their
 * banking app expires the payment underneath them.
 *
 * This is NOT `sales.order_expiry_minutes`. That one bounds a DRAFT's price hold, and
 * its own registry entry already records the distinction — a customer holding a quote
 * and a customer holding bank details and an amount are in different situations.
 */
export const PAYMENT_WINDOW_MINUTES_MIN = 5;
export const PAYMENT_WINDOW_MINUTES_MAX = 60;

export const PAYMENT_EVENTS = [
  'CONFIRM',
  'FAIL',
  'CANCEL',
  'EXPIRE',
  'LOSE_TRACK',
  'RECONCILE_CONFIRMED',
  'RECONCILE_FAILED',
] as const;
export type PaymentEvent = (typeof PAYMENT_EVENTS)[number];

/**
 * The payment machine.
 *
 * `UNKNOWN` is NOT in the terminal list, and that is the only surprising thing here:
 * it is not an outcome, it is an absence of one, and leaving it reachable-but-not-final
 * is what makes the reconciliation paths below legal. A machine that made it terminal
 * would need a "reopen" transition, and a reopened payment is a payment whose
 * confirmed-at timestamp cannot be trusted.
 *
 * Both reconciliation transitions carry guards, named here and implemented in the
 * module: reconciliation is an assertion about the outside world, so it requires
 * recorded evidence rather than an operator's recollection.
 */
export const PAYMENT_MACHINE: StateMachineDefinition<PaymentState, PaymentEvent> = {
  name: 'payment',
  initial: 'PENDING',
  states: PAYMENT_STATES,
  terminal: PAYMENT_TERMINAL_STATES,
  transitions: [
    { from: 'PENDING', to: 'CONFIRMED', on: 'CONFIRM', guard: 'evidenceVerified' },
    { from: 'PENDING', to: 'FAILED', on: 'FAIL' },
    { from: 'PENDING', to: 'CANCELLED', on: 'CANCEL' },
    { from: 'PENDING', to: 'EXPIRED', on: 'EXPIRE' },
    { from: 'PENDING', to: 'UNKNOWN', on: 'LOSE_TRACK' },
    {
      from: 'UNKNOWN',
      to: 'CONFIRMED',
      on: 'RECONCILE_CONFIRMED',
      guard: 'reconciliationEvidenceRecorded',
    },
    {
      from: 'UNKNOWN',
      to: 'FAILED',
      on: 'RECONCILE_FAILED',
      guard: 'reconciliationEvidenceRecorded',
    },
  ],
};

/**
 * How money can arrive.
 *
 * Only mechanisms this installation can actually perform are listed, and the list is
 * deliberately short. `provider.ts` records the rule that settles this: Marzban's
 * descriptor once advertised fourteen operations no code could perform and it was
 * rejected, because the thing publishing the list is how the product tells an operator
 * what it can do. A `ZARINPAL` member with no adapter behind it would be the same
 * defect with money attached.
 *
 * - `WALLET` — settled from the customer's own ledger balance. Fully implemented:
 *   it needs no third party, so there is nothing to configure and nothing to fake.
 * - `MANUAL_TRANSFER` — the customer pays out of band and submits evidence; an
 *   operator with `receipts.review` confirms it. This is the mechanism the research
 *   actually documents, and a human in the loop is its whole point.
 *
 * A gateway is reached through `PaymentGatewayPort` and there is no adapter in this
 * release. An unconfigured gateway is REFUSED, not simulated.
 */
export const PAYMENT_METHODS = ['WALLET', 'MANUAL_TRANSFER', 'GATEWAY'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);

/** The methods this release can settle without external configuration. */
export const SELF_CONTAINED_PAYMENT_METHODS: readonly PaymentMethod[] = [
  'WALLET',
  'MANUAL_TRANSFER',
];

/**
 * What a confirmation rests on.
 *
 * Stored on the payment so a confirmation can be re-examined later. The legacy
 * system's receipt review records neither the reviewer nor the time (UNK-PR-010), which
 * is why "was this approved by a human" is unanswerable there.
 */
export const PAYMENT_EVIDENCE_KINDS = [
  /** An operator with `receipts.review` looked at out-of-band proof and approved it. */
  'OPERATOR_REVIEW',
  /** A debit committed against the customer's own ledger in the same transaction. */
  'WALLET_DEBIT',
  /** A signed, verified callback from a configured gateway. No adapter ships yet. */
  'GATEWAY_CALLBACK',
  /** An operator resolved an UNKNOWN outcome against the gateway's own records. */
  'RECONCILIATION',
] as const;
export type PaymentEvidenceKind = (typeof PAYMENT_EVIDENCE_KINDS)[number];
export const paymentEvidenceKindSchema = z.enum(PAYMENT_EVIDENCE_KINDS);

/**
 * The bound on a single payment, as a sanity rail rather than a policy.
 *
 * No amount limit is a POLICY here — per-gateway and global limits are operator
 * settings and the research records that their precedence is unresolved (FBR-008).
 * This is only the ceiling above which a request is certainly a mistake or an attack,
 * expressed in minor units so it is currency-agnostic.
 */
export const PAYMENT_AMOUNT_MAX_MINOR = 1_000_000_000_000n;

/**
 * Whether a wallet may go below zero.
 *
 * FALSE, and it is a constant rather than an `if` so that the reseller credit line in
 * 4F has to change data rather than code to enable it. The legacy system cannot answer
 * whether its balance can go negative (UNK-UM-005), which means nothing stops it.
 *
 * A reseller with a configured credit limit is the ONE exception, and it is expressed
 * as a per-customer allowance checked against this floor — not as a second code path.
 */
export const WALLET_ALLOWS_NEGATIVE_BALANCE = false;

/**
 * How many top-up amounts a tenant may offer.
 *
 * A bound on a KEYBOARD, which is why it is small and why it is here rather than left to
 * the operator: `wallet.topup.presets` renders as inline buttons, and Telegram refuses a
 * reply_markup past its own limits — so an unbounded list is a configuration that makes
 * the top-up button stop working for everybody. Eight is above every top-up menu in
 * `docs/research/`.
 */
export const TOPUP_PRESETS_MAX = 8;

/**
 * A ledger entry's amount is positive; direction is separate.
 *
 * Restated here as a function because it is the invariant the whole ledger rests on and
 * the place it will be violated is a service that computes a delta and stores it.
 */
export function isValidLedgerAmount(amountMinor: bigint): boolean {
  return amountMinor > 0n && amountMinor <= PAYMENT_AMOUNT_MAX_MINOR;
}
