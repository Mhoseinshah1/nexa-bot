import { z } from 'zod';
import { paymentIdSchema } from './ids.js';
import { PAYMENT_METHODS, type PaymentMethod } from './payment.js';

/**
 * Money going back, as financial evidence with a lifecycle.
 *
 * ## What a refund is NOT
 *
 * Four things this product already does are not refunds, and the distinction is the
 * whole reason this file exists rather than a boolean on a payment:
 *
 * - a **rejection** (`PaymentService.rejectManualTransfer`) decides a payment that never
 *   settled. No money moved, so none goes back.
 * - a **cancellation** closes an unpaid order. Same.
 * - an **admin wallet credit** (`ADMIN_CREDIT`) is an operator putting money into a
 *   wallet for a reason of their own. It has no original payment, so nothing bounds it.
 * - and pretending an external bank transfer happened is the defect this file is most
 *   carefully built against — see `REFUND_STATES`.
 *
 * A refund names the CONFIRMED payment it reverses, is bounded by what that payment
 * actually took, and records who decided and who completed it. The legacy system has
 * none of this: `docs/research/`'s financial pass found refund existing only as a log
 * verb on deleting a service (`UNK-UM-010` cannot even say which of three deletion
 * variants refunds), with no refund entity, no amount and no reviewer.
 *
 * ## Append-only, like every other financial record here
 *
 * A refund row is never deleted and its money fields are never rewritten. The original
 * payment and the original wallet debit are never touched either — a reversal is a NEW
 * append-only ledger entry, because `CLAUDE.md`'s rule is that balance is derived from
 * an append-only ledger and the legacy system's mutable balance column is what that rule
 * exists to prevent.
 */

/**
 * Where a refund is in its life.
 *
 * Four states, and the count is doing real work: the two terminal ones are what a
 * refundable balance is computed from, and `AWAITING_EXTERNAL` is the state that stops
 * this product from lying.
 *
 * - `REQUESTED` — an operator with `refunds.issue` decided money should go back, and
 *   the amount is bounded and recorded. Nothing has moved yet.
 * - `AWAITING_EXTERNAL` — the money has to leave through a channel Nexa cannot drive.
 *   A card-to-card refund is a human being making a bank transfer; this installation has
 *   no bank API and inventing one would be the `SBR-003` silent-success defect with
 *   money attached. The refund sits here until an authorized operator records that the
 *   transfer actually happened.
 * - `COMPLETED` — the money is back. For a wallet-funded payment that is true the moment
 *   the ledger entry commits, because the ledger IS the wallet. For a manual transfer it
 *   is true only because a named operator said so at a recorded time.
 * - `FAILED` — the refund was abandoned, with a reason. It frees the amount it was
 *   holding, which is why it is terminal rather than a deletion: a refund that vanished
 *   would leave the refundable balance unexplainable.
 *
 * There is deliberately no `PROCESSING` and no `UNKNOWN`. Both would describe a refund
 * in flight through a provider, and there is no provider adapter in this release —
 * `payment.ts` records the same rule for `GATEWAY`. They arrive with the adapter that
 * can actually produce them, and `REFUND_METHOD_SUPPORT` is what refuses meanwhile.
 */
export const REFUND_STATES = ['REQUESTED', 'AWAITING_EXTERNAL', 'COMPLETED', 'FAILED'] as const;
export type RefundState = (typeof REFUND_STATES)[number];
export const refundStateSchema = z.enum(REFUND_STATES);

/**
 * The states that no longer change, and the two of them mean opposite things.
 *
 * `COMPLETED` consumed its amount; `FAILED` released it. A refundable balance therefore
 * subtracts the first and ignores the second, and `REFUND_CONSUMING_STATES` below is
 * what says which — spelled out rather than derived, because deriving "not FAILED" would
 * silently start consuming any state added later.
 */
export const REFUND_TERMINAL_STATES: readonly RefundState[] = ['COMPLETED', 'FAILED'];

/**
 * The states that hold money against the payment's refundable balance.
 *
 * `REQUESTED` and `AWAITING_EXTERNAL` are here even though no money has moved, and that
 * is the point: two operators must not each request a full refund of the same payment
 * and have both succeed because neither had completed yet. An in-flight refund reserves
 * its amount.
 *
 * `FAILED` is absent, so abandoning a refund returns its amount to the balance.
 */
export const REFUND_CONSUMING_STATES: readonly RefundState[] = [
  'REQUESTED',
  'AWAITING_EXTERNAL',
  'COMPLETED',
];

/**
 * How a refund's money is expected to travel back, decided by how it arrived.
 *
 * Derived from the original payment's `PaymentMethod` rather than chosen by an operator:
 * money that came out of a wallet goes back to that wallet, and money that arrived as a
 * bank transfer has to leave as one. An operator picking the channel would be an
 * operator able to credit a wallet for a payment the customer made from their bank —
 * which is `ADMIN_CREDIT` wearing a refund's name.
 *
 * - `WALLET_CREDIT` — one append-only ledger entry, reason `REFUND`. Immediate.
 * - `EXTERNAL_MANUAL` — a person makes a transfer and records that they did.
 * - `PROVIDER` — a gateway adapter reverses its own charge. No adapter ships in this
 *   release, so `REFUND_METHOD_SUPPORT` marks it unsupported and the service refuses it
 *   rather than reporting a success nothing performed.
 */
export const REFUND_CHANNELS = ['WALLET_CREDIT', 'EXTERNAL_MANUAL', 'PROVIDER'] as const;
export type RefundChannel = (typeof REFUND_CHANNELS)[number];
export const refundChannelSchema = z.enum(REFUND_CHANNELS);

/**
 * The channel each payment method refunds through, and whether this release can do it.
 *
 * A table rather than a branch, so a caller asks what a method supports instead of
 * inferring it — and so adding a method to `PAYMENT_METHODS` without deciding how it
 * refunds is a compile error rather than a payment nobody can give back.
 *
 * `GATEWAY` is `supported: false`, which is the honest statement of this release: the
 * channel is named, the capability is declared absent, and `RefundService` refuses. A
 * future adapter flips the flag in the same commit that implements the reversal — the
 * rule `provider.ts` states for panel capabilities, where a capability is declared
 * AFTER the acceptance proves it.
 */
export interface RefundMethodSupport {
  readonly channel: RefundChannel;
  readonly supported: boolean;
}

export const REFUND_METHOD_SUPPORT: {
  readonly [K in PaymentMethod]: RefundMethodSupport;
} = {
  WALLET: { channel: 'WALLET_CREDIT', supported: true },
  MANUAL_TRANSFER: { channel: 'EXTERNAL_MANUAL', supported: true },
  GATEWAY: { channel: 'PROVIDER', supported: false },
};

/**
 * The channel an automatic refund travels on, whatever the money arrived by.
 *
 * `REFUND_METHOD_SUPPORT` above answers a different question — how an OPERATOR'S
 * refund of a given method is expected to travel — and deliberately refuses to let
 * one person credit a wallet for money that came from a bank. This is not that. An
 * order this installation took money for and cannot deliver has exactly two
 * outcomes (`ORDER_MACHINE`), the second is "the money goes back", and it has to
 * happen in the transaction that discovers the first is impossible, with nobody
 * present. A bank transfer cannot be reversed from inside a transaction and a
 * gateway reversal has no adapter, so the only channel that can honour that
 * promise unattended is the wallet.
 *
 * The consequence is stated rather than hidden: money that arrived as a bank
 * transfer comes back as store credit, not as a transfer. That is a product
 * decision, and the alternative it replaced was a queue of undelivered paid orders
 * waiting for somebody to notice. An operator who wants to send the money out of
 * the wallet still can, through `ADMIN_DEBIT` and their own bank.
 */
export const AUTOMATIC_REFUND_CHANNEL = 'WALLET_CREDIT' satisfies RefundChannel;

/**
 * The reason recorded on every automatic refund, and the one `OrderRefunded` carries.
 *
 * A CONSTANT rather than a sentence assembled at the call site, because
 * `refunds.reason` is otherwise an operator's own words and a reader has to be able
 * to tell the two apart — a reconciliation that counts "how much did this
 * installation give back because it could not deliver" is a filter on this value,
 * not a LIKE over free text. What specifically went wrong is on the operation row
 * and in the operational event; this says which lane produced the refund.
 */
export const AUTOMATIC_REFUND_REASON = 'UNDELIVERABLE';

/**
 * The transitions a refund may make, and nothing else.
 *
 * Written as a map from state to its permitted successors, checked by the service before
 * every write and by a conditional UPDATE naming its `from` — the mechanism ADR-0028
 * records for recovery, and for the same three reasons: a replay, a double-click and two
 * replicas are all made safe by one thing rather than by three checks.
 *
 * `REQUESTED → COMPLETED` exists for the wallet channel, where the credit commits in the
 * same transaction that creates the refund. `REQUESTED → AWAITING_EXTERNAL` is the
 * manual channel's first step. A terminal state has no successors, so a completed refund
 * cannot be re-completed and a failed one cannot be resurrected — a reversal of a
 * reversal is a new payment, not an edit.
 */
export const REFUND_TRANSITIONS: {
  readonly [K in RefundState]: readonly RefundState[];
} = {
  REQUESTED: ['AWAITING_EXTERNAL', 'COMPLETED', 'FAILED'],
  AWAITING_EXTERNAL: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
};

/** Whether a refund may move from one state to another. Total, and used before every write. */
export function refundMayTransition(from: RefundState, to: RefundState): boolean {
  return REFUND_TRANSITIONS[from].includes(to);
}

/**
 * The operator's own words, required on a request and on a completion.
 *
 * Required rather than optional, because the legacy `/admin/logs` is a free-text Persian
 * sentence with no entity and no before/after, and the question it cannot answer is
 * exactly this one: why did this customer get money back. A refund with no reason is a
 * refund nobody can review.
 */
export const REFUND_REASON_MIN_LENGTH = 3;
export const REFUND_REASON_MAX_LENGTH = 500;

/**
 * What an operator records when the external transfer has actually happened.
 *
 * A reference rather than a free note, and optional, because a bank transfer's own
 * identifier is what makes a completion checkable against a statement — but an operator
 * refunding in cash across a counter has none, and refusing them would mean a refund
 * that can never be completed.
 */
export const REFUND_EXTERNAL_REFERENCE_MAX_LENGTH = 140;

export const refundReasonSchema = z
  .string()
  .trim()
  .min(REFUND_REASON_MIN_LENGTH)
  .max(REFUND_REASON_MAX_LENGTH);

/**
 * What an operator submits to start a refund.
 *
 * `amountMinor` is a decimal STRING because JSON has no bigint, and the service is what
 * bounds it: the refundable balance is computed server-side from the CONFIRMED payment
 * minus the refunds already consuming it, inside the transaction, under a lock. A
 * browser's idea of the refundable amount is a suggestion.
 *
 * There is no `currency` field. A refund is denominated by the payment it reverses, and
 * letting a caller name one would admit a refund in a currency the payment was never
 * made in — with no conversion anywhere in this product able to resolve it.
 *
 * There is no `channel` field either: `REFUND_METHOD_SUPPORT` derives it from the
 * payment's own method, for the reason `REFUND_CHANNELS` states.
 */
export const refundRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  /*
   * PARSED, not merely typed.
   *
   * `payments.id` is a `uuid` column, so a malformed path segment reaching the
   * repository is compared against it by PostgreSQL and raises `invalid input syntax
   * for type uuid` — a 500 for what is an unroutable identifier, which is a 404. The
   * same class Phase 4B's review found three times; this is where it is refused for
   * refunds, so no caller has to remember to.
   */
  paymentId: paymentIdSchema,
  amountMinor: z.string().regex(/^[0-9]{1,19}$/u, 'must be a positive integer string'),
  reason: refundReasonSchema,
});
export type RefundRequestInput = z.infer<typeof refundRequestSchema>;

/**
 * What an operator records when money has actually gone back out of band.
 *
 * Its own command, and the separation is the load-bearing part of the manual channel: a
 * refund is not completed by being requested. `docs/conventions.md`'s silent-success
 * rule and `SBR-003` are why — the legacy system reported an admin re-added when it
 * wrote nothing, and a refund that marked itself complete on request would tell a
 * customer their money is back before anybody had moved it.
 */
export const refundCompletionSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  note: refundReasonSchema,
  externalReference: z
    .union([z.string(), z.null()])
    .optional()
    .transform((value) => {
      if (value === undefined || value === null) return null;
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed;
    })
    .refine((value) => value === null || value.length <= REFUND_EXTERNAL_REFERENCE_MAX_LENGTH, {
      message: `must be at most ${REFUND_EXTERNAL_REFERENCE_MAX_LENGTH} characters`,
    }),
});
export type RefundCompletionInput = z.infer<typeof refundCompletionSchema>;

/** Abandoning a refund, which RELEASES its amount back to the refundable balance. */
export const refundFailureSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  note: refundReasonSchema,
});
export type RefundFailureInput = z.infer<typeof refundFailureSchema>;

/**
 * A guard for the one arithmetic rule that matters, expressed where both callers see it.
 *
 * `requested + consumed <= paid` and nothing else. Written as a function rather than
 * inlined at the service, because the service applies it and the unit test exercises it
 * over the boundary cases — a rule with no test is a rule that gets silently reverted,
 * which `CLAUDE.md` records as having happened five times in one commit.
 *
 * `bigint` throughout. A float here is the defect the whole money model exists to
 * refuse, and it would show up as a refund of 0.30000000000000004.
 */
export function refundFitsWithin(input: {
  readonly paidMinor: bigint;
  readonly consumedMinor: bigint;
  readonly requestedMinor: bigint;
}): boolean {
  if (input.requestedMinor <= 0n) return false;
  if (input.consumedMinor < 0n || input.paidMinor < 0n) return false;
  return input.consumedMinor + input.requestedMinor <= input.paidMinor;
}

/** What is left to refund on a payment. Never negative, whatever the rows say. */
export function refundableMinor(paidMinor: bigint, consumedMinor: bigint): bigint {
  const remaining = paidMinor - consumedMinor;
  return remaining > 0n ? remaining : 0n;
}

/** The catalogue is closed, so a surface can render a state without holding a copy. */
export const REFUND_STATE_COUNT = REFUND_STATES.length;

/** Every payment method has a refund channel decided for it — asserted, not assumed. */
export const REFUND_SUPPORTED_METHODS: readonly PaymentMethod[] = PAYMENT_METHODS.filter(
  (method) => REFUND_METHOD_SUPPORT[method].supported,
);
