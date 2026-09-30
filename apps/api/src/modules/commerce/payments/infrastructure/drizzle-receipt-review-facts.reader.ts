import { and, eq, sql } from 'drizzle-orm';
import type {
  CurrencyCode,
  OrderId,
  OrderPurpose,
  PaymentId,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  orders,
  serviceCommercialActions,
  serviceUsernameReservations,
  services,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  ReceiptReviewFacts,
  ReceiptReviewFactsReader,
  ReceiptWalletMovement,
  ReceiptWalletMovementReader,
} from '../application/receipt-review-caption.js';

/**
 * The order-side facts File 01 §4 asks a reviewer's caption to carry, read by reference to
 * the ORDER's own frozen snapshot (`docs/wp10-followup-audit.md` §6).
 *
 * - The product title, traffic and duration are the order line's snapshot, never the
 *   product's current row — a renamed product must not rewrite what a customer paid for.
 * - The service username is the name the order RESERVED for a new service, or the existing
 *   service's panel name for a renewal or an add-on (`service_commercial_actions`). A panel
 *   with no username template has no name until provisioning, and that is a null, not a guess.
 *
 * Read-only, no lock: a caption is a snapshot at render time and must never wait on a
 * disposition's row locks.
 */
export class DrizzleReceiptReviewFactsReader
  implements ReceiptReviewFactsReader, ReceiptWalletMovementReader
{
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async factsFor(
    scope: TenantContext,
    orderId: OrderId | null,
    tx?: unknown,
  ): Promise<ReceiptReviewFacts> {
    if (orderId === null) {
      return {
        purpose: null,
        productTitle: null,
        durationDays: null,
        trafficBytes: null,
        serviceUsername: null,
      };
    }
    const tenantId = requireTenantId(scope);
    const [order] = await this.exec(tx)
      .select({
        purpose: orders.purpose,
        title: orders.lineTitle,
        durationDays: orders.lineDurationDays,
        trafficBytes: orders.lineTrafficBytes,
      })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
      .limit(1);
    if (order === undefined) {
      return {
        purpose: null,
        productTitle: null,
        durationDays: null,
        trafficBytes: null,
        serviceUsername: null,
      };
    }
    const purpose = order.purpose as OrderPurpose;

    let serviceUsername: string | null;
    // An order that creates a service reads the name it reserved; a custom service reserves
    // one exactly as a catalogue purchase does (Package D).
    if (purpose === 'NEW_SERVICE' || purpose === 'CUSTOM_SERVICE') {
      const [held] = await this.exec(tx)
        .select({ username: serviceUsernameReservations.username })
        .from(serviceUsernameReservations)
        .where(
          and(
            eq(serviceUsernameReservations.tenantId, tenantId),
            eq(serviceUsernameReservations.orderId, orderId),
          ),
        )
        .limit(1);
      serviceUsername = held?.username ?? null;
    } else {
      const [acted] = await this.exec(tx)
        .select({ username: services.providerUsername })
        .from(serviceCommercialActions)
        .innerJoin(
          services,
          and(
            eq(services.tenantId, serviceCommercialActions.tenantId),
            eq(services.id, serviceCommercialActions.serviceId),
          ),
        )
        .where(
          and(
            eq(serviceCommercialActions.tenantId, tenantId),
            eq(serviceCommercialActions.orderId, orderId),
          ),
        )
        .limit(1);
      serviceUsername = acted?.username ?? null;
    }

    /*
     * An add-on's line carries ZERO in the amount it did not buy (`orders_quantity_line_check`,
     * `CommercialActionService`): "none was bought", not a fact about the service. The caption
     * shows that as a dash, so it is null here. A service line's zero means unlimited and is
     * the order's own frozen value, so it is passed through.
     */
    return {
      purpose,
      productTitle: order.title,
      // WP-A5 / WP-A6: an extra-users line and a location change buy neither: both dashes.
      durationDays:
        purpose === 'ADD_TRAFFIC' || purpose === 'ADD_DEVICES' || purpose === 'CHANGE_LOCATION'
          ? null
          : order.durationDays,
      trafficBytes:
        purpose === 'ADD_TIME' || purpose === 'ADD_DEVICES' || purpose === 'CHANGE_LOCATION'
          ? null
          : order.trafficBytes,
      serviceUsername,
    };
  }

  /**
   * F1 (round N): what ONE payment's own ledger entries did to the customer's wallet, read off
   * the ledger and nothing else — the running balance in `(created_at, id)` order, the same
   * window the low-balance lane takes, since there is no balance column to read.
   *
   * `before` is the balance immediately before the payment's first entry and `after` the
   * balance immediately after its last, so an entry written LATER (another top-up, a
   * purchase) never leaks into either figure. Null when the payment wrote no entry in this
   * currency. Read-only and unlocked, like everything a caption reads.
   */
  async movementOf(
    scope: TenantContext,
    customerId: UserId,
    paymentId: PaymentId,
    currency: CurrencyCode,
    tx?: unknown,
  ): Promise<ReceiptWalletMovement | null> {
    const tenantId = requireTenantId(scope);
    const result = await this.exec(tx).execute(sql`
      WITH running AS (
        SELECT e.id, e.created_at, e.payment_id,
               CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END AS signed,
               SUM(CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END)
                 OVER (ORDER BY e.created_at, e.id
                       ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS after_entry
        FROM wallet_entries e
        WHERE e.tenant_id = ${tenantId} AND e.customer_id = ${customerId}
          AND e.currency = ${currency}
      ),
      ours AS (SELECT * FROM running WHERE payment_id = ${paymentId})
      SELECT
        (SELECT (after_entry - signed)::text FROM ours ORDER BY created_at, id LIMIT 1) AS before,
        (SELECT after_entry::text FROM ours ORDER BY created_at DESC, id DESC LIMIT 1) AS after,
        (SELECT SUM(signed)::text FROM ours) AS moved
    `);
    const row = result.rows[0] as
      { before: string | null; after: string | null; moved: string | null } | undefined;
    if (row === undefined || row.before === null || row.after === null || row.moved === null) {
      return null;
    }
    // `BigInt(string)`: SUM over bigint is numeric, handed back as a string (`balanceOf`).
    return { moved: BigInt(row.moved), before: BigInt(row.before), after: BigInt(row.after) };
  }
}
