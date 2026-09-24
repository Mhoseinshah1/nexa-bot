import { and, eq } from 'drizzle-orm';
import type { OrderId, OrderPurpose, TenantContext } from '@nexa/contracts';
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
export class DrizzleReceiptReviewFactsReader implements ReceiptReviewFactsReader {
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
    if (purpose === 'NEW_SERVICE') {
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
      durationDays: purpose === 'ADD_TRAFFIC' ? null : order.durationDays,
      trafficBytes: purpose === 'ADD_TIME' ? null : order.trafficBytes,
      serviceUsername,
    };
  }
}
