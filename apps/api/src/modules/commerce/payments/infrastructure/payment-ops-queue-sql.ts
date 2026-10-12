import { sql, type SQL } from 'drizzle-orm';
import type { PaymentGatewayProvider, PaymentOpsQueue, TimePeriod } from '@nexa/contracts';
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
           AND ${mismatchHoldAudit()})`;
    case 'PARTIAL':
      return invoiceWhere(partialStatus());
    case 'LATE_COMPLETION':
      return invoiceWhere(lateCompletionInvoice());
    case 'PROVIDER_ERROR':
      return invoiceWhere(providerErrorInvoice());
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
 * Only a canonical (lowercase) uuid can equal `payments.id::text`, which is what MISMATCH
 * compares; anything else names no payment. The CASE, rather than a WHERE beside the cast,
 * is what guarantees the cast never sees a malformed id — PostgreSQL does not promise the
 * order it evaluates ANDed quals in.
 */
const CANONICAL_UUID = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

/**
 * The ids of the tenant's payments that CAN be in some queue: a superset of every queue's
 * rows, read from the rows that make a payment eligible rather than from every payment the
 * tenant ever took (FIX-11: the attention counts scanned all of them, 2.5 s at 400k).
 *
 * Every queue's predicate implies one of these arms, which is what makes it a superset:
 *
 * - PENDING, NEEDS_ACTION's receipt arm         → `state = 'PENDING'`;
 * - UNKNOWN, NEEDS_RECONCILIATION, NEEDS_ACTION → `state = 'UNKNOWN'`;
 * - PARTIAL, LATE_COMPLETION, PROVIDER_ERROR    → an invoice satisfying that queue's own
 *   invoice condition (the same functions, not a restatement);
 * - REFUND_RELATED, NEEDS_ACTION's refund arm   → any refund against the payment;
 * - MISMATCH                                    → the lane's audited hold.
 *
 * It only narrows the rows the queue predicates are then asked about; it never decides a
 * count. A new queue whose predicate implies none of these arms must add one here, and
 * `payment-operations.test.ts` compares the counts with the full scan to catch it.
 */
export function paymentOpsCandidateIds(tenantId: string, window: TimePeriod | null): SQL {
  // The caller bounds `payments.created_at` itself; repeating the window on the payment arm
  // only lets that arm use it too. The other arms carry no `created_at` of the payment.
  const inWindow =
    window === null
      ? sql``
      : sql` AND p.created_at >= ${window.start.toISOString()}::timestamptz AND p.created_at < ${window.end.toISOString()}::timestamptz`;
  return sql`(
    SELECT p.id FROM payments p
     WHERE p.tenant_id = ${tenantId}::uuid AND p.state IN ('PENDING', 'UNKNOWN')${inWindow}
    UNION ALL
    SELECT gi.payment_id FROM gateway_invoices gi
     WHERE gi.tenant_id = ${tenantId}::uuid
       AND (${partialStatus()} OR ${lateCompletionInvoice()} OR ${providerErrorInvoice()})
    UNION ALL
    SELECT r.payment_id FROM refunds r WHERE r.tenant_id = ${tenantId}::uuid
    UNION ALL
    SELECT CASE WHEN a.entity_id ~ ${CANONICAL_UUID} THEN a.entity_id::uuid END
      FROM audit_logs a
     WHERE a.tenant_id = ${tenantId}::uuid
       AND a.entity_type = 'Payment'
       AND ${mismatchHoldAudit()}
  )`;
}

/** The lane's audited mismatch hold (`a` is the `audit_logs` row). */
function mismatchHoldAudit(): SQL {
  return sql`a.action = ${PAYMENT_LOSE_TRACK_ACTION} AND a.after ->> 'reason' IS NOT NULL`;
}

/**
 * The durable marker as well as the outcome (review of PR #243, CX1): an attempt the
 * provider refused first (UNSUCCESSFUL) and approved later keeps its first outcome, and only
 * `late_completion_observed_at` says the money arrived. `gi` is the invoice.
 */
function lateCompletionInvoice(): SQL {
  return sql`(gi.outcome = 'LATE_COMPLETION' OR gi.late_completion_observed_at IS NOT NULL)`;
}

function providerErrorInvoice(): SQL {
  return sql`(gi.creation_state IN ('CREATE_FAILED', 'CREATE_UNKNOWN') OR gi.last_inquiry_error_code IS NOT NULL)`;
}

/**
 * An OPERATOR's refund still open against the payment: REQUESTED or AWAITING_EXTERNAL, and not
 * a service refund request's reservation — that one is settled by its own workflow, and
 * `RefundService.complete`/`fail` refuse it (review of PR #243, CX3). The classifier's
 * `refundOpen` fact, and the `REFUND_IN_PROGRESS` arm of `NEEDS_ACTION`. A reservation is
 * still `REFUND_RELATED`.
 */
export function openRefundCondition(): SQL {
  return sql`EXISTS (
    SELECT 1 FROM refunds r
     WHERE r.tenant_id = ${payments.tenantId}
       AND r.payment_id = ${payments.id}
       AND r.state IN ('REQUESTED', 'AWAITING_EXTERNAL')
       AND NOT EXISTS (
         SELECT 1 FROM service_refund_requests s
          WHERE s.tenant_id = r.tenant_id AND s.refund_id = r.id))`;
}

/** At least one receipt filed against the payment: the classifier's `receiptFiled` fact. */
export function receiptFiledCondition(): SQL {
  return sql`EXISTS (
    SELECT 1 FROM payment_receipts pr
     WHERE pr.tenant_id = ${payments.tenantId}
       AND pr.payment_id = ${payments.id})`;
}

/**
 * Something is left to refund: the principal exceeds what the consuming refunds (REQUESTED,
 * AWAITING_EXTERNAL, COMPLETED) hold — `refundableMinor` in SQL. The classifier's
 * `refundRemaining` fact; the server still decides the amount under the payment's lock.
 */
export function refundRemainingCondition(): SQL {
  return sql`${payments.amount} > coalesce((
    SELECT sum(r.amount) FROM refunds r
     WHERE r.tenant_id = ${payments.tenantId}
       AND r.payment_id = ${payments.id}
       AND r.state IN ('REQUESTED', 'AWAITING_EXTERNAL', 'COMPLETED')), 0)`;
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
 * - `RECEIPT_UNDER_REVIEW`: a PENDING manual transfer holding a filed receipt, with no late
 *   approval, provider review or partial ahead of it in the classifier's precedence;
 * - every UNKNOWN (reconciliation);
 * - `REFUND_IN_PROGRESS`: CONFIRMED with an operator's refund still open.
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
      AND ${receiptFiledCondition()}
      AND ${payments.providerReviewUntil} IS NULL
      AND NOT ${paymentOpsQueueCondition('LATE_COMPLETION')}
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
