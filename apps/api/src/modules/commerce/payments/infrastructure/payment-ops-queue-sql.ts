import { sql, type SQL } from 'drizzle-orm';
import type { PaymentGatewayProvider, PaymentOpsQueue } from '@nexa/contracts';
import { payments } from '../../../../infrastructure/persistence/schema.js';
import {
  PARTIAL_PAYMENT_STATUSES,
  reconciliationVocabularies,
} from '../domain/gateway-reconciliation.js';
import { PAYMENT_LOSE_TRACK_ACTION } from '../application/gateway-payment.service.js';

/**
 * The Payment Operations Center's queues as SQL (program §10, `payment-operations.ts` in the
 * contracts, which states each definition in words).
 *
 * ONE predicate per queue, correlated on the `payments` row, used by BOTH the list filter
 * (`DrizzlePaymentRepository.listStatement`) and the attention counts
 * (`DrizzlePaymentAttentionReader`) — so a count and the list it opens are the same
 * question. Every one is a read of what some flow has already recorded; none of them is a
 * state, and none of them is written anywhere.
 */
export function paymentOpsQueueCondition(queue: PaymentOpsQueue): SQL {
  switch (queue) {
    case 'PENDING':
      return sql`${payments.state} = 'PENDING'`;
    case 'UNKNOWN':
      return sql`${payments.state} = 'UNKNOWN'`;
    case 'NEEDS_RECONCILIATION':
      return sql`(${payments.state} = 'UNKNOWN' AND ${payments.method} = 'GATEWAY' AND ${invoiceWhere(reconcilableEvidence())})`;
    case 'MISMATCH':
      /*
       * The lane's own record of a mismatch hold: the `payment.lose_track` audit row with a
       * machine `reason` (`GatewayPaymentService.holdMismatch`). A lapsed provider review
       * writes the same action WITHOUT a reason, and is UNKNOWN but not a mismatch.
       */
      return sql`EXISTS (
        SELECT 1 FROM audit_logs a
         WHERE a.tenant_id = ${payments.tenantId}
           AND a.entity_type = 'Payment'
           AND a.entity_id = ${payments.id}::text
           AND a.action = ${PAYMENT_LOSE_TRACK_ACTION}
           AND a.after ->> 'reason' IS NOT NULL)`;
    case 'PARTIAL':
      return invoiceWhere(partialStatus());
    case 'LATE_COMPLETION':
      return invoiceWhere(sql`gi.outcome = 'LATE_COMPLETION'`);
    case 'PROVIDER_ERROR':
      return invoiceWhere(
        sql`(gi.creation_state IN ('CREATE_FAILED', 'CREATE_UNKNOWN') OR gi.last_inquiry_error_code IS NOT NULL)`,
      );
    case 'REFUND_RELATED':
      return sql`EXISTS (
        SELECT 1 FROM refunds r
         WHERE r.tenant_id = ${payments.tenantId}
           AND r.payment_id = ${payments.id})`;
    case 'NEEDS_ACTION':
      return needsActionCondition();
  }
}

/**
 * A refund still open against the payment: REQUESTED or AWAITING_EXTERNAL. The classifier's
 * `refundOpen` fact, and the `REFUND_IN_PROGRESS` arm of `NEEDS_ACTION`.
 */
export function openRefundCondition(): SQL {
  return sql`EXISTS (
    SELECT 1 FROM refunds r
     WHERE r.tenant_id = ${payments.tenantId}
       AND r.payment_id = ${payments.id}
       AND r.state IN ('REQUESTED', 'AWAITING_EXTERNAL'))`;
}

/** A refund COMPLETED against the payment: the classifier's `refundCompleted` fact. */
export function completedRefundCondition(): SQL {
  return sql`EXISTS (
    SELECT 1 FROM refunds r
     WHERE r.tenant_id = ${payments.tenantId}
       AND r.payment_id = ${payments.id}
       AND r.state = 'COMPLETED')`;
}

/**
 * `paymentNeedsAction` of `paymentSituationOf` (contracts, `payment-situations.ts`) in SQL,
 * arm by arm, each one a payment with an existing command as its exit:
 *
 * - `CUSTOMER_SIGNALLED`: a PENDING manual transfer the customer says they sent, outside a
 *   provider review and not a partial — the classifier's precedence for PENDING;
 * - every UNKNOWN (reconciliation);
 * - `REFUND_IN_PROGRESS`: CONFIRMED with a refund still open.
 *
 * Late or partial money on a payment that already ended is deliberately absent: nothing in
 * the domain resolves it (`OQ-WP11A-03`), so here it would never leave. It stays in its own
 * facet. `payment-situations.test.ts` (integration) holds this and the classifier to the same
 * answer over every arm.
 */
function needsActionCondition(): SQL {
  return sql`(
    (${payments.state} = 'PENDING'
      AND ${payments.method} = 'MANUAL_TRANSFER'
      AND ${payments.customerSignalledAt} IS NOT NULL
      AND ${payments.providerReviewUntil} IS NULL
      AND NOT ${paymentOpsQueueCondition('PARTIAL')})
    OR ${payments.state} = 'UNKNOWN'
    OR (${payments.state} = 'CONFIRMED' AND ${openRefundCondition()})
  )`;
}

/** The payment's own `gateway_invoices` row satisfies `condition` (aliased `gi`). */
function invoiceWhere(condition: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM gateway_invoices gi
     WHERE gi.tenant_id = ${payments.tenantId}
       AND gi.payment_id = ${payments.id}
       AND ${condition})`;
}

function textList(values: readonly string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

function statusIn(values: readonly string[]): SQL {
  return values.length === 0 ? sql`false` : sql`gi.provider_status IN (${textList(values)})`;
}

/**
 * `reconcilableNow` (`domain/gateway-reconciliation.ts`) in SQL, one arm per provider in the
 * evidence table. A provider with no vocabulary has no arm, so it is never reconcilable —
 * exactly the TypeScript's answer.
 */
function reconcilableEvidence(): SQL {
  const arms = reconciliationVocabularies().map((v) => {
    const approving = statusIn(v.confirmed);
    const confirmable = v.confirmRequiresReference
      ? sql`(${approving} AND gi.provider_paid IS TRUE AND gi.provider_charge_id IS NOT NULL)`
      : sql`(${approving} AND gi.provider_paid IS TRUE)`;
    const failable = v.failsUnpaidApproval
      ? sql`(${statusIn(v.failed)} OR (${approving} AND gi.provider_paid IS NOT TRUE))`
      : statusIn(v.failed);
    return sql`(gi.provider = ${v.provider} AND gi.provider_status IS NOT NULL AND (${confirmable} OR ${failable}))`;
  });
  return arms.length === 0 ? sql`false` : sql`(${sql.join(arms, sql` OR `)})`;
}

function partialStatus(): SQL {
  const arms = (
    Object.entries(PARTIAL_PAYMENT_STATUSES) as [PaymentGatewayProvider, readonly string[]][]
  ).map(([provider, statuses]) => sql`(gi.provider = ${provider} AND ${statusIn(statuses)})`);
  return arms.length === 0 ? sql`false` : sql`(${sql.join(arms, sql` OR `)})`;
}
