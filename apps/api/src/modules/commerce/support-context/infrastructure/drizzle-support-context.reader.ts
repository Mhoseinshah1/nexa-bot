import { and, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
import type {
  CurrencyCode,
  OrderPurpose,
  OrderState,
  PaymentGatewayProvider,
  PaymentMethod,
  PaymentState,
  ScopeContext,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  customers,
  orders,
  payments,
  services,
} from '../../../../infrastructure/persistence/schema.js';
import { paymentOpsQueueCondition } from '../../payments/infrastructure/payment-ops-queue-sql.js';
import type {
  SupportContextReader,
  SupportIncidentFact,
  SupportOrderFact,
  SupportPaymentFact,
  SupportServiceCardFact,
} from '../application/ports.js';

/**
 * Whether a payment is «under review» (ADR-0034 §4): its recorded outcome is ambiguous, or
 * a human or a provider has still to decide it. Built ONLY from the Payment Operations
 * Center's own queue predicates (`paymentOpsQueueCondition`), never a second calculation:
 *
 *  - the `UNKNOWN` queue — the external side may or may not have taken money;
 *  - the `PENDING` queue AND a signal that it is waiting on someone: the customer said
 *    they paid (`customer_signalled_at`) or a provider review is open
 *    (`provider_review_started_at`). A PENDING payment nobody has acted on is just unpaid;
 *  - the `PARTIAL` or `LATE_COMPLETION` queue on a payment that is not CONFIRMED and is
 *    not in the `REFUND_RELATED` queue — money arrived that settled nothing, and no refund
 *    has been started for it yet: an operator decides (`OQ-TB-12`).
 */
export function underReviewCondition(): SQL {
  return sql`(
    ${paymentOpsQueueCondition('UNKNOWN')}
    OR (${paymentOpsQueueCondition('PENDING')}
        AND (${payments.customerSignalledAt} IS NOT NULL
             OR ${payments.providerReviewStartedAt} IS NOT NULL))
    OR ((${paymentOpsQueueCondition('PARTIAL')} OR ${paymentOpsQueueCondition('LATE_COMPLETION')})
        AND ${payments.state} <> 'CONFIRMED'
        AND NOT ${paymentOpsQueueCondition('REFUND_RELATED')})
  )`;
}

/**
 * TB3's customer-scoped reads, in PostgreSQL. One statement each; the tenant AND the
 * customer in every WHERE; newest first; bounded. Each SELECT names its columns, so a
 * column the payload does not carry is never even fetched — a payment's `reference`,
 * `external_reference` and notes, an order's quote and discount code.
 */
export class DrizzleSupportContextReader implements SupportContextReader {
  constructor(private readonly db: Database) {}

  async recentOrders(
    scope: TenantContext,
    customerId: UserId,
    limit: number,
  ): Promise<readonly SupportOrderFact[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select({
        id: orders.id,
        state: orders.state,
        purpose: orders.purpose,
        title: orders.lineTitle,
        totalMinor: orders.totalAmount,
        currency: orders.currency,
        createdAt: orders.createdAt,
        settledAt: orders.settledAt,
        expiresAt: orders.expiresAt,
      })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.customerId, customerId),
          // A DRAFT is a quote nobody confirmed (`OQ-TB-13`).
          ne(orders.state, 'DRAFT'),
        ),
      )
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(Math.max(1, limit));
    return rows.map((row) => ({
      ...row,
      state: row.state as OrderState,
      purpose: row.purpose as OrderPurpose,
      currency: row.currency as CurrencyCode,
    }));
  }

  /**
   * TB7 (substitute review of PR #202, finding 1) — the four flags the automatic-reply guards
   * decide on, read again INSIDE the transaction that enqueues the reply, so a guard never
   * decides on facts that changed during the provider call. The same predicates as the payload's
   * flags (`underReviewCondition`, a service `UNRECONCILED`, a `BLOCKED` customer), but over ALL
   * of the customer's services rather than a page of them: broader is the fail-closed direction.
   */
  async autoGuardFlags(
    scope: ScopeContext,
    customerId: string | null,
    tx?: unknown,
  ): Promise<{
    readonly identityLinked: boolean;
    readonly customerBlocked: boolean;
    readonly hasUnderReviewPayment: boolean;
    readonly hasUnreconciledService: boolean;
  }> {
    const none = {
      identityLinked: false,
      customerBlocked: false,
      hasUnderReviewPayment: false,
      hasUnreconciledService: false,
    };
    if (customerId === null) return none;
    const tenantId = requireTenantId(scope);
    const executor: Executor = (tx as TransactionScope | undefined)?.tx ?? this.db;
    const [row] = await executor
      .select({
        status: customers.status,
        underReview: sql<boolean>`EXISTS (
          SELECT 1 FROM ${payments}
           WHERE ${payments.tenantId} = ${tenantId}
             AND ${payments.customerId} = ${customerId}
             AND ${underReviewCondition()})`,
        unreconciled: sql<boolean>`EXISTS (
          SELECT 1 FROM ${services}
           WHERE ${services.tenantId} = ${tenantId}
             AND ${services.customerId} = ${customerId}
             AND ${services.state} = 'UNRECONCILED')`,
      })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)));
    if (row === undefined) return none;
    return {
      identityLinked: true,
      customerBlocked: row.status === 'BLOCKED',
      hasUnderReviewPayment: row.underReview === true,
      hasUnreconciledService: row.unreconciled === true,
    };
  }

  async recentPayments(
    scope: TenantContext,
    customerId: UserId,
    limit: number,
  ): Promise<{ readonly items: readonly SupportPaymentFact[]; readonly anyUnderReview: boolean }> {
    const tenantId = requireTenantId(scope);
    const underReview = underReviewCondition();
    const owned = and(eq(payments.tenantId, tenantId), eq(payments.customerId, customerId));
    const recent = this.db
      .select({
        id: payments.id,
        amountMinor: payments.amount,
        currency: payments.currency,
        method: payments.method,
        gatewayProvider: payments.gatewayProvider,
        state: payments.state,
        createdAt: payments.createdAt,
        confirmedAt: payments.confirmedAt,
        underReview: sql<boolean>`${underReview}`,
      })
      .from(payments)
      .where(owned)
      .orderBy(desc(payments.createdAt), desc(payments.id))
      .limit(Math.max(1, limit));
    /*
     * The flag is over EVERY payment of the customer, not only the five returned, so an
     * older payment still under review keeps it a hard handoff topic. Its own statement,
     * `LIMIT 1` over the same predicate: it stops at the first match instead of evaluating
     * the correlated queue subqueries for every payment the customer ever made.
     */
    const flagged = this.db
      .select({ one: sql<number>`1` })
      .from(payments)
      .where(and(owned, underReview))
      .limit(1);
    const [rows, anyRows] = await Promise.all([recent, flagged]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        amountMinor: row.amountMinor,
        currency: row.currency as CurrencyCode,
        method: row.method as PaymentMethod,
        gatewayProvider: row.gatewayProvider as PaymentGatewayProvider | null,
        state: row.state as PaymentState,
        underReview: row.underReview === true,
        createdAt: row.createdAt,
        confirmedAt: row.confirmedAt,
      })),
      anyUnderReview: anyRows.length > 0,
    };
  }

  /**
   * `DrizzleIncidentRepository.audience`'s matching rule, for ONE customer and every ACTIVE
   * incident at once:
   *
   *  - the customer has a LIVE service (`ACTIVE`/`SUSPENDED`) on the incident's scope — a
   *    panel it names, the panel of a location it names, or a product it names;
   *  - an incident that names no panel, no RESOLVABLE location and no product (a gateway
   *    outage, an installation-wide window) reaches every customer with a live service —
   *    exactly as `audience` treats an empty `panels` list and an empty `products` list.
   *
   * Only the service match is mirrored. `audience` also asks whether a notice can be
   * DELIVERED (customer ACTIVE, a reachable bot); that is the notice lane's question, not
   * whether this customer is affected. An integration test pins the two answers equal for
   * a deliverable customer. SCHEDULED incidents are not read (`OQ-TB-14`), and only
   * `customer_message` leaves the row — never the title or the description.
   */
  async activeIncidentNotices(
    scope: TenantContext,
    customerId: UserId,
    limit: number,
  ): Promise<readonly SupportIncidentFact[]> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute(sql`
      SELECT i.customer_message, i.started_at, i.scheduled_end_at
        FROM incidents i
       WHERE i.tenant_id = ${tenantId}
         AND i.status = 'ACTIVE'
         AND i.customer_message IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM services s
            WHERE s.tenant_id = i.tenant_id
              AND s.customer_id = ${customerId}
              AND s.state IN ('ACTIVE', 'SUSPENDED')
              AND (
                NOT EXISTS (
                  SELECT 1 FROM incident_targets t
                   WHERE t.tenant_id = i.tenant_id AND t.incident_id = i.id
                     AND (t.kind IN ('PANEL', 'PRODUCT')
                          OR (t.kind = 'LOCATION' AND EXISTS (
                                SELECT 1 FROM service_locations l
                                 WHERE l.tenant_id = t.tenant_id
                                   AND l.id::text = lower(t.ref)))))
                OR EXISTS (
                  SELECT 1 FROM incident_targets t
                   WHERE t.tenant_id = i.tenant_id AND t.incident_id = i.id
                     AND ((t.kind = 'PANEL' AND lower(t.ref) = s.panel_id::text)
                          OR (t.kind = 'PRODUCT' AND lower(t.ref) = s.product_id::text)
                          OR (t.kind = 'LOCATION' AND EXISTS (
                                SELECT 1 FROM service_locations l
                                 WHERE l.tenant_id = t.tenant_id
                                   AND l.id::text = lower(t.ref)
                                   AND l.panel_id = s.panel_id))))
              )
         )
       ORDER BY i.started_at DESC, i.id DESC
       LIMIT ${Math.max(1, limit)}`);
    return (
      result.rows as {
        customer_message: string;
        started_at: Date | string;
        scheduled_end_at: Date | string | null;
      }[]
    ).map((row) => ({
      customerMessage: row.customer_message,
      startedAt: new Date(row.started_at),
      scheduledEndAt: row.scheduled_end_at === null ? null : new Date(row.scheduled_end_at),
    }));
  }

  async serviceCardFacts(
    scope: TenantContext,
    customerId: UserId,
    refs: readonly { readonly orderId: string; readonly productId: string | null }[],
  ): Promise<readonly SupportServiceCardFact[]> {
    if (refs.length === 0) return [];
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute(sql`
      SELECT u.ord, o.line_title, p.service_location_label
        FROM unnest(${sql.param(refs.map((ref) => ref.orderId))}::uuid[],
                    ${sql.param(refs.map((ref) => ref.productId))}::uuid[])
             WITH ORDINALITY AS u(order_id, product_id, ord)
        LEFT JOIN orders o
          ON o.tenant_id = ${tenantId} AND o.customer_id = ${customerId} AND o.id = u.order_id
        LEFT JOIN products p
          ON p.tenant_id = ${tenantId} AND p.id = u.product_id
       ORDER BY u.ord`);
    const rows = result.rows as {
      line_title: string | null;
      service_location_label: string | null;
    }[];
    return rows.map((row) => ({
      title: row.line_title,
      productLocationLabel: row.service_location_label,
    }));
  }
}
