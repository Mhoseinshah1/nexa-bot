import { sql } from 'drizzle-orm';
import type { TenantContext } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  AdoptedServiceRecord,
  AdoptionInsert,
  AdoptionPanel,
  LegacyAdoptionStore,
} from '../application/legacy-adoption-ports.js';

/**
 * Migration P6 — the adoption's storage, in PostgreSQL.
 *
 * Raw SQL for the three inserts, because each writes a row no other repository may: an
 * order that is `PAID` at birth with `origin = LEGACY_ADOPTION`, a service in its live
 * state with no provisioning operation, and a username hold funded at creation. The
 * database's own rules still decide what is valid — `orders_legacy_adoption_shape_check`,
 * `nexa_service_requires_purchase_order`, `services_provisioned_at_check`,
 * `services_usage_synced_check`, `services_delivered_at_check`, the per-panel username and
 * subscription-ref unique indexes and the namespace unique index — so a wrong value here
 * is a refused statement, not a stored one.
 */
export class DrizzleLegacyAdoptionStore implements LegacyAdoptionStore {
  constructor(private readonly db: Database) {}

  /**
   * A transaction-scoped advisory lock on `(tenant, invoice key)`, the `legacy-shape:` form
   * (`hashtextextended` of a namespaced string). Taken FIRST in the adoption transaction and
   * never together with another advisory lock, so it adds no edge to any lock order.
   */
  async lockInvoice(
    scope: TenantContext,
    legacyInvoiceKey: string,
    tx: TransactionScope,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await tx.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`legacy-adoption:${tenantId}:invoice:${legacyInvoiceKey}`}, 0))`,
    );
  }

  async findCustomerByTelegramId(
    scope: TenantContext,
    telegramUserId: string,
    tx: TransactionScope,
  ): Promise<string | null> {
    const tenantId = requireTenantId(scope);
    const result = await tx.tx.execute(sql`
      SELECT id FROM customers
       WHERE tenant_id = ${tenantId} AND telegram_user_id = ${telegramUserId}
       LIMIT 1`);
    const row = (result.rows as { id: string }[])[0];
    return row?.id ?? null;
  }

  async lockPanel(
    scope: TenantContext,
    panelId: string,
    tx: TransactionScope,
  ): Promise<AdoptionPanel | null> {
    const tenantId = requireTenantId(scope);
    const result = await tx.tx.execute(sql`
      SELECT id, provider_type, base_url FROM panels
       WHERE tenant_id = ${tenantId} AND id = ${panelId}
       FOR UPDATE`);
    const row = (result.rows as { id: string; provider_type: string; base_url: string }[])[0];
    return row === undefined
      ? null
      : { id: row.id, providerType: row.provider_type, baseUrl: row.base_url };
  }

  async shapeIdForProduct(
    scope: TenantContext,
    productId: string,
    tx: TransactionScope,
  ): Promise<string | null> {
    const tenantId = requireTenantId(scope);
    const result = await tx.tx.execute(sql`
      SELECT id FROM legacy_product_shapes
       WHERE tenant_id = ${tenantId} AND product_id = ${productId}
       LIMIT 1`);
    const row = (result.rows as { id: string }[])[0];
    return row?.id ?? null;
  }

  /**
   * Any service on the panel whose name folds to the candidate — any state, any tenant
   * (`services_panel_provider_username_key` is per panel, not per tenant, and a TERMINATED
   * row still holds its exact spelling) — or any hold of the lowercase name in the
   * namespace, which is the host's and not the tenant's.
   */
  async usernameTaken(
    _scope: TenantContext,
    input: { readonly panelId: string; readonly namespaceKey: string; readonly canonical: string },
    tx: TransactionScope,
  ): Promise<boolean> {
    const result = await tx.tx.execute(sql`
      SELECT EXISTS (
               SELECT 1 FROM services
                WHERE panel_id = ${input.panelId}
                  AND lower(provider_username) = ${input.canonical})
          OR EXISTS (
               SELECT 1 FROM service_username_reservations
                WHERE namespace_key = ${input.namespaceKey}
                  AND username = ${input.canonical}) AS taken`);
    return (result.rows as { taken: boolean }[])[0]?.taken === true;
  }

  async insertAdoption(
    scope: TenantContext,
    input: AdoptionInsert,
    tx: TransactionScope,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    const quote = JSON.stringify({
      productId: input.productId,
      quotedAt: input.settledAt.toISOString(),
      currency: input.currency,
      finalAmount: { amountMinor: '0', currency: input.currency },
      trace: [
        {
          step: 'BASE_PRICE',
          effect: 'REPLACES',
          ruleId: null,
          ruleLabel: 'legacy adoption',
          amountBefore: { amountMinor: '0', currency: input.currency },
          amountAfter: { amountMinor: '0', currency: input.currency },
        },
      ],
    });
    /*
     * The order: NEW_SERVICE + LEGACY_ADOPTION, PAID at birth, every amount zero, no code,
     * no deadline, no category snapshot (null = unknown, never invented). The line is the
     * resolved product's specification at unit price 0 — never the legacy price.
     */
    await tx.tx.execute(sql`
      INSERT INTO orders
        (id, tenant_id, customer_id, state, purpose, origin, product_id, panel_id, line_title,
         line_duration_days, line_traffic_bytes, line_device_limit, line_unit_price_amount,
         line_quantity, subtotal_amount, discount_amount, total_amount, currency, quote,
         confirmed_at, settled_at, created_at, updated_at)
      VALUES
        (${input.orderId}, ${tenantId}, ${input.customerId}, 'PAID', 'NEW_SERVICE',
         'LEGACY_ADOPTION', ${input.productId}, ${input.panelId}, ${input.line.title},
         ${input.line.durationDays}, ${input.line.trafficBytes}, ${input.line.deviceLimit}, 0,
         1, 0, 0, 0, ${input.currency}, ${quote}::jsonb,
         ${input.settledAt}, ${input.settledAt}, ${input.now}, ${input.now})`);
    /*
     * The service, live: provisioned and delivered at adoption (the customer already holds
     * the account and its link), usage measured at `observedAt`. No operation is written —
     * an adopted service is never on a CREATE path (C3 constraint 5).
     */
    const s = input.service;
    await tx.tx.execute(sql`
      INSERT INTO services
        (id, tenant_id, customer_id, order_id, panel_id, product_id, state, provider_username,
         subscription_ref, provider_client_id, subscription_url, expires_at,
         traffic_limit_bytes, traffic_used_bytes, usage_synced_at, delivery_state,
         delivered_at, provisioned_at, created_at, updated_at)
      VALUES
        (${input.serviceId}, ${tenantId}, ${input.customerId}, ${input.orderId},
         ${input.panelId}, ${input.productId}, ${s.state}, ${s.providerUsername},
         ${s.subscriptionRef}, ${s.providerClientId}::uuid, ${s.subscriptionUrl},
         ${s.expiresAt}, ${s.trafficLimitBytes}, ${s.trafficUsedBytes}, ${s.usageSyncedAt},
         'DELIVERED', ${input.now}, ${input.now}, ${input.now}, ${input.now})`);
    /*
     * The name's hold in the panel's namespace, funded now: it is never reapable, exactly as
     * a purchased name after settlement. `expires_at` is required and meaningless once
     * funded; it is set to the adoption time.
     */
    await tx.tx.execute(sql`
      INSERT INTO service_username_reservations
        (id, tenant_id, namespace_key, username, panel_id, order_id, customer_id, mode,
         funded_at, expires_at, created_at)
      VALUES
        (${input.reservationId}, ${tenantId}, ${input.reservation.namespaceKey},
         ${input.reservation.username}, ${input.panelId}, ${input.orderId}, ${input.customerId},
         'CUSTOM', ${input.now}, ${input.now}, ${input.now})`);
  }

  async findService(
    scope: TenantContext,
    serviceId: string,
    tx: TransactionScope,
  ): Promise<AdoptedServiceRecord | null> {
    const tenantId = requireTenantId(scope);
    const result = await tx.tx.execute(sql`
      SELECT s.id, s.order_id, s.customer_id, s.panel_id
        FROM services s
        JOIN orders o ON o.tenant_id = s.tenant_id AND o.id = s.order_id
       WHERE s.tenant_id = ${tenantId} AND s.id = ${serviceId}
         AND o.origin = 'LEGACY_ADOPTION'`);
    const row = (
      result.rows as { id: string; order_id: string; customer_id: string; panel_id: string }[]
    )[0];
    return row === undefined
      ? null
      : {
          serviceId: row.id,
          orderId: row.order_id,
          customerId: row.customer_id,
          panelId: row.panel_id,
        };
  }
}
