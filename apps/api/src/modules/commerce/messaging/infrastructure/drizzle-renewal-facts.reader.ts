import { sql } from 'drizzle-orm';
import {
  money,
  paymentTrackingCode,
  type CurrencyCode,
  type TemplateValues,
  type TenantContext,
} from '@nexa/contracts';
import { balanceInCommitOrder } from '../../wallet/infrastructure/balance-in-commit-order.js';
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
             pay.payment_reference, pay.payment_code
      FROM provisioning_operations op
      JOIN services s ON s.tenant_id = op.tenant_id AND s.id = op.service_id
      LEFT JOIN orders o ON o.tenant_id = op.tenant_id AND o.id = op.order_id
      LEFT JOIN LATERAL (
        SELECT p.reference AS payment_reference, p.code AS payment_code FROM payments p
         WHERE p.tenant_id = op.tenant_id
           AND p.order_id = op.order_id
           AND p.state = 'CONFIRMED'
         ORDER BY p.confirmed_at DESC NULLS LAST
         LIMIT 1) pay ON true
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
          payment_reference: string | null;
          payment_code: string | null;
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
        // The PUBLIC tracking code (PR-C), never the stored reference.
        ...(row.payment_reference === null
          ? {}
          : {
              reference: paymentTrackingCode({
                code: row.payment_code,
                reference: row.payment_reference,
              }),
            }),
      },
    };
  }

  /**
   * R5C-1 item 4: what the receipt of a PAID extra-traffic / extra-time package renders
   * (`SERVICE_TRAFFIC_ADDED` / `SERVICE_TIME_ADDED`), read at send time from the operation the
   * notification names. A reader, not a payload (ADR 0030 §1):
   *
   *   - the package: the order's frozen line (title, the bytes or days it added) and total;
   *   - the new total traffic / expiry: the operation's own frozen target, the absolute value
   *     it was written to make true (a later purchase cannot rewrite it), else the service's;
   *   - paid from the wallet: the balance before and after the order's PURCHASE debit, summed
   *     in COMMIT order (`balanceInCommitOrder`, the one reader);
   *   - paid any other way: the tracking code of the CONFIRMED payment, never a stored reference;
   *   - the order's own 8-character code.
   *
   * `PURCHASED_AS` in SQL: the operation's type must be the order's purpose, so an operation
   * that merely carries the order that created its service never renders a receipt. Null unless
   * the operation SUCCEEDED, which sends nothing: a receipt for something that did not happen
   * is worse than silence. The optional values are omitted when absent and their lines dropped.
   */
  async addonReceiptFacts(
    scope: TenantContext,
    operationId: string,
  ): Promise<{
    readonly kind: 'ADD_TRAFFIC' | 'ADD_TIME';
    readonly values: TemplateValues;
    readonly serviceId: string;
    readonly orderId: string;
  } | null> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute(sql`
      SELECT op.type AS op_type, s.id AS service_id, s.provider_username,
             COALESCE(op.target_expires_at, s.expires_at) AS expires_at,
             COALESCE(op.target_traffic_limit_bytes, s.traffic_limit_bytes)::text AS total_traffic,
             o.id AS order_id, o.customer_id, o.code AS order_code, o.line_title,
             o.line_traffic_bytes::text AS line_traffic, o.line_duration_days,
             o.total_amount::text AS total_amount, o.currency,
             pay.method AS payment_method, pay.payment_reference, pay.payment_code
      FROM provisioning_operations op
      JOIN services s ON s.tenant_id = op.tenant_id AND s.id = op.service_id
      JOIN orders o ON o.tenant_id = op.tenant_id AND o.id = op.order_id AND o.purpose = op.type
      LEFT JOIN LATERAL (
        SELECT p.method, p.reference AS payment_reference, p.code AS payment_code FROM payments p
         WHERE p.tenant_id = op.tenant_id
           AND p.order_id = op.order_id
           AND p.state = 'CONFIRMED'
         ORDER BY p.confirmed_at DESC NULLS LAST
         LIMIT 1) pay ON true
      WHERE op.tenant_id = ${tenantId}
        AND op.id = ${operationId}
        AND op.type IN ('ADD_TRAFFIC', 'ADD_TIME')
        AND op.state = 'SUCCEEDED'
      LIMIT 1`);
    const row = result.rows[0] as
      | {
          op_type: 'ADD_TRAFFIC' | 'ADD_TIME';
          service_id: string;
          provider_username: string;
          expires_at: string | Date | null;
          total_traffic: string | null;
          order_id: string;
          customer_id: string;
          order_code: string | null;
          line_title: string;
          line_traffic: string;
          line_duration_days: number | string;
          total_amount: string;
          currency: string;
          payment_method: string | null;
          payment_reference: string | null;
          payment_code: string | null;
        }
      | undefined;
    if (row === undefined) return null;
    const currency = row.currency as CurrencyCode;

    // The wallet's own two figures, only for a wallet payment: the PURCHASE debit the settling
    // transaction wrote for this order.
    let balances: { before: ReturnType<typeof money>; after: ReturnType<typeof money> } | null =
      null;
    if (row.payment_method === 'WALLET') {
      const debits = await this.db.execute(sql`
        SELECT id::text AS id FROM wallet_entries
         WHERE tenant_id = ${tenantId} AND order_id = ${row.order_id}
           AND reason = 'PURCHASE' AND direction = 'DEBIT'`);
      const entryIds = (debits.rows as { id: string }[]).map((entry) => entry.id);
      if (entryIds.length > 0) {
        const around = (
          await this.db.execute(
            balanceInCommitOrder({ tenantId, customerId: row.customer_id, currency, entryIds }),
          )
        ).rows[0] as { found: boolean; after: string; own: string } | undefined;
        if (around?.found === true) {
          const after = BigInt(around.after);
          balances = {
            before: money(after - BigInt(around.own), currency),
            after: money(after, currency),
          };
        }
      }
    }

    const traffic = row.op_type === 'ADD_TRAFFIC';
    return {
      kind: row.op_type,
      serviceId: row.service_id,
      orderId: row.order_id,
      values: {
        title: row.line_title,
        ...(traffic
          ? { traffic: BigInt(row.line_traffic) }
          : { durationDays: Number(row.line_duration_days) }),
        price: money(BigInt(row.total_amount), currency),
        ...(balances === null
          ? {}
          : { balanceBefore: balances.before, balanceAfter: balances.after }),
        // The PUBLIC tracking code (PR-C), never the stored reference; not for the wallet,
        // whose receipt carries the balances instead.
        ...(row.payment_method === 'WALLET' ||
        row.payment_method === null ||
        row.payment_reference === null
          ? {}
          : {
              reference: paymentTrackingCode({
                code: row.payment_code,
                reference: row.payment_reference,
              }),
            }),
        username: row.provider_username,
        ...(traffic
          ? row.total_traffic === null
            ? {}
            : { totalTraffic: BigInt(row.total_traffic) }
          : row.expires_at === null
            ? {}
            : { expiresAt: new Date(row.expires_at) }),
        ...(row.order_code === null ? {} : { orderCode: row.order_code }),
      },
    };
  }
}
