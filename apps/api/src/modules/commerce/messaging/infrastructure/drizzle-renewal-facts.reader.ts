import { sql } from 'drizzle-orm';
import { paymentTrackingCode, type TemplateValues, type TenantContext } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * R2 (v0.3.5 real-test item 11): what the renewal result (`SERVICE_RENEWED`) renders, read at
 * send time from the RENEW operation the notification names.
 *
 * A READER, not a payload (ADR 0030 §1): the announcer enqueued a kind and an operation id,
 * and every value is derived from rows that id names —
 *
 *   - the account name: the service's `provider_username`, as the service card shows it;
 *   - the duration: the order's frozen `line_duration_days`, what the customer bought;
 *   - the new expiry: the operation's own `target_expires_at`, the absolute value the renewal
 *     was written to make true (a later renewal cannot rewrite it), else the service's expiry;
 *   - the tracking code: the reference of the CONFIRMED payment that paid for the order.
 *
 * `null` unless the operation is a SUCCEEDED renewal of a service that still exists: the
 * dispatcher then sends nothing, because a result with no account name in it is worse than
 * silence. The optional values are simply omitted when there is none, and their line is
 * dropped by the renderer.
 */
export class DrizzleRenewalFactsReader {
  constructor(private readonly db: Database) {}

  /**
   * FIX-08: the order a SUCCEEDED paid action was bought by, or null. `PURCHASED_AS` in SQL:
   * the operation's type must be the order's purpose, so a SUSPEND — which carries the order
   * that created its service — is never answered on that order's payment message.
   */
  async purchasedOrderFor(scope: TenantContext, operationId: string): Promise<string | null> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute(sql`
      SELECT op.order_id
      FROM provisioning_operations op
      JOIN orders o ON o.tenant_id = op.tenant_id AND o.id = op.order_id
      WHERE op.tenant_id = ${tenantId}
        AND op.id = ${operationId}
        AND op.state = 'SUCCEEDED'
        AND op.type IN ('ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES', 'CHANGE_LOCATION')
        AND o.purpose = op.type
      LIMIT 1`);
    const row = result.rows[0] as { order_id: string | null } | undefined;
    return row?.order_id ?? null;
  }

  async notificationFacts(
    scope: TenantContext,
    operationId: string,
  ): Promise<{
    readonly values: TemplateValues;
    readonly serviceId: string;
    readonly orderId: string | null;
  } | null> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute(sql`
      SELECT s.id AS service_id,
             s.provider_username,
             COALESCE(op.target_expires_at, s.expires_at) AS expires_at,
             op.order_id,
             o.line_duration_days,
             (SELECT p.reference FROM payments p
               WHERE p.tenant_id = op.tenant_id
                 AND p.order_id = op.order_id
                 AND p.state = 'CONFIRMED'
               ORDER BY p.confirmed_at DESC NULLS LAST
               LIMIT 1) AS reference
      FROM provisioning_operations op
      JOIN services s ON s.tenant_id = op.tenant_id AND s.id = op.service_id
      LEFT JOIN orders o ON o.tenant_id = op.tenant_id AND o.id = op.order_id
      WHERE op.tenant_id = ${tenantId}
        AND op.id = ${operationId}
        AND op.type = 'RENEW'
        AND op.state = 'SUCCEEDED'
      LIMIT 1`);
    const row = result.rows[0] as
      | {
          service_id: string;
          provider_username: string;
          expires_at: string | Date | null;
          order_id: string | null;
          line_duration_days: number | string | null;
          reference: string | null;
        }
      | undefined;
    if (row === undefined) return null;
    return {
      serviceId: row.service_id,
      orderId: row.order_id,
      values: {
        username: row.provider_username,
        ...(row.line_duration_days === null
          ? {}
          : { durationDays: Number(row.line_duration_days) }),
        ...(row.expires_at === null ? {} : { expiresAt: new Date(row.expires_at) }),
        ...(row.reference === null ? {} : { reference: paymentTrackingCode(row.reference) }),
      },
    };
  }
}
