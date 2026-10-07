import { z } from 'zod';
import { paymentGatewayProviderSchema } from './payment-gateways.js';
import { REPORT_RANGES, reportLocalDateSchema } from './reporting.js';

/**
 * The Payment Operations Center (program §10, `docs/payment-operations-center.md`).
 *
 * ONE cross-provider workspace over the payment domain as it already is. Nothing here is a
 * payment state: `PAYMENT_STATES` stays the only answer to "where is this payment", and a
 * queue is a FACET of what has been recorded about it — an `UNKNOWN` payment whose gateway
 * recorded a partial payment is in two queues and still has one state. A queue never moves
 * money and never decides anything; the operator's actions are the existing commands
 * (`payments.reconcile`'s reconcile and "ask again", `refunds.issue`'s refund).
 *
 * Each queue is ONE SQL predicate in the payment repository, shared by the list filter and
 * the attention counts, so a count and the list it opens cannot disagree.
 *
 * - `PENDING` — `payments.state = 'PENDING'`.
 * - `UNKNOWN` — `payments.state = 'UNKNOWN'`: no outcome; resolvable only by reconciliation.
 * - `NEEDS_RECONCILIATION` — an `UNKNOWN` gateway payment whose RECORDED inquiry already
 *   supports a terminal resolution under the per-provider evidence table
 *   (`domain/gateway-reconciliation.ts`) — the ones an operator can reconcile now, rather
 *   than ask about again first.
 * - `MISMATCH` — the gateway lane held this payment for a mismatch (`payment.lose_track`
 *   audited with a machine `reason`: another amount, another customer, a reused or missing
 *   reference). Any state: whether it is still open is the state column's answer.
 * - `PARTIAL` — the provider's recorded status is its own "partially paid" (NOWPayments'
 *   `partially_paid`). Only providers that expose one can land here.
 * - `LATE_COMPLETION` — the provider approved after the attempt stopped being eligible
 *   (`gateway_invoices.outcome = 'LATE_COMPLETION'`). Nothing moved; an operator decides.
 * - `PROVIDER_ERROR` — the provider side recorded an error: a create refused
 *   (`CREATE_FAILED`) or lost (`CREATE_UNKNOWN`), or the latest inquiry ended in an error
 *   code (cleared by the next good answer).
 * - `REFUND_RELATED` — at least one refund row exists against the payment, automatic or an
 *   operator's, in any refund state.
 * - `NEEDS_ACTION` — roadmap E1/E2 (`docs/payments-under-review-ux.md`): the payments a PERSON
 *   must act on for them to move on — exactly `PAYMENT_SITUATIONS_NEEDING_ACTION` of
 *   `paymentSituationOf`, in SQL: a manual transfer the customer says they sent, still
 *   PENDING; every UNKNOWN; a late completion or a partial payment on a payment that is not
 *   CONFIRMED; and a CONFIRMED payment with a refund still open. Listed oldest first, like
 *   every queue, which is the attention order: the oldest unresolved is the most at risk.
 *   An integration test holds the SQL and the classifier to the same answer.
 */
export const PAYMENT_OPS_QUEUES = [
  'PENDING',
  'UNKNOWN',
  'NEEDS_RECONCILIATION',
  'MISMATCH',
  'PARTIAL',
  'LATE_COMPLETION',
  'PROVIDER_ERROR',
  'REFUND_RELATED',
  'NEEDS_ACTION',
] as const;
export type PaymentOpsQueue = (typeof PAYMENT_OPS_QUEUES)[number];
export const paymentOpsQueueSchema = z.enum(PAYMENT_OPS_QUEUES);

/**
 * The created-at window a queue list or a count runs over: the reports' own ranges, resolved
 * by the reports' own resolver in the tenant's timezone and calendar, half-open. ABSENT
 * means no bound — the default, because an `UNKNOWN` never resolves on its own and must not
 * age out of an operator's view. `from` and `to` exist exactly when `range` is CUSTOM.
 */
export const paymentOpsWindowShape = {
  range: z.enum(REPORT_RANGES).optional(),
  from: reportLocalDateSchema.optional(),
  to: reportLocalDateSchema.optional(),
};

/** The CUSTOM rule `reportRangeQuerySchema` states, for an optional range. */
export function refinePaymentOpsWindow(
  value: { range?: string | undefined; from?: string | undefined; to?: string | undefined },
  context: z.RefinementCtx,
): void {
  const custom = value.range === 'CUSTOM';
  for (const key of ['from', 'to'] as const) {
    if (custom && value[key] === undefined) {
      context.addIssue({ code: 'custom', path: [key], message: `a CUSTOM range needs ${key}` });
    }
    if (!custom && value[key] !== undefined) {
      context.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} is accepted only with range=CUSTOM`,
      });
    }
  }
}

export const paymentAttentionQuerySchema = z
  .object(paymentOpsWindowShape)
  .superRefine(refinePaymentOpsWindow);
export type PaymentAttentionQuery = z.infer<typeof paymentAttentionQuerySchema>;

const queueCounts = z.object(
  Object.fromEntries(
    PAYMENT_OPS_QUEUES.map((queue) => [queue, z.number().int().nonnegative()]),
  ) as {
    [K in PaymentOpsQueue]: z.ZodNumber;
  },
);
export type PaymentOpsQueueCounts = Readonly<Record<PaymentOpsQueue, number>>;

/**
 * "Operational attention" (program §10–§12): how many payments sit in each queue, per
 * gateway route, over a window. The shared read model — Gateway Health and the Notification
 * Center read the same counts through `PaymentAttentionReader` rather than a copy of the
 * predicates. `gatewayProvider` null is a payment offered through no route (a wallet
 * settlement, or one created before the column existed). Rows with every count zero are
 * omitted; `totals` is the sum over the rows.
 */
export const paymentAttentionResponseSchema = z.object({
  window: z.object({ start: z.iso.datetime(), end: z.iso.datetime() }).nullable(),
  byGateway: z.array(
    z.object({
      gatewayProvider: paymentGatewayProviderSchema.nullable(),
      counts: queueCounts,
    }),
  ),
  totals: queueCounts,
  generatedAt: z.iso.datetime(),
});
export type PaymentAttentionResponse = z.infer<typeof paymentAttentionResponseSchema>;

export const PAYMENT_OPS_ROUTES = {
  /** The attention counts, under `payments.view`. */
  attention: '/payment-operations/attention',
} as const;
