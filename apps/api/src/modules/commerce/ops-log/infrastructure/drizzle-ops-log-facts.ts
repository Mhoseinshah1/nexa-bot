import { sql } from 'drizzle-orm';
import { money, type CurrencyCode, type TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { isFirstPaidPurchase } from './first-purchase-sql.js';
import { balanceInCommitOrder } from '../../wallet/infrastructure/balance-in-commit-order.js';
import type {
  MassCreditFact,
  AdminFact,
  BalanceAround,
  CustomerFact,
  LedgerEntryFact,
  OperationFact,
  OpsLogFacts,
  OrderFact,
  OrderOriginFact,
  PaymentFact,
  ServiceBeforeImage,
  ServiceFact,
  TicketFact,
} from '../application/ports.js';

type Row = Record<string, unknown>;

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const date = (value: unknown): Date | null =>
  value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const big = (value: unknown): bigint => BigInt(typeof value === 'string' ? value : String(value));

/**
 * `(p1, p2, …)` for an `IN`, one bound parameter per element, spelled out with `sql.join`
 * rather than left to how a driver or a drizzle release expands an interpolated array (Codex
 * review of #301). Never called with an empty list: every caller answers that case first,
 * because `IN ()` is not SQL.
 */
const list = (values: readonly string[]): ReturnType<typeof sql> =>
  sql`(${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )})`;

/**
 * The facts the operations log group's builders read (Round 4 PR-D), straight from the
 * tables that own them.
 *
 * Read-only and inside the caller's transaction. A balance is never read from a column — there
 * is none: `balanceAround` SUMS the ledger up to a named entry, in commit order, so a message
 * that says «موجودی قبل ← بعد» is arithmetic over the same append-only rows the wallet itself
 * is derived from.
 * Every query names the tenant; an id of another tenant's row answers null.
 */
export class DrizzleOpsLogFacts implements OpsLogFacts {
  constructor(private readonly db: Database) {}

  private exec(tx: TransactionScope): Executor {
    return tx.tx ?? this.db;
  }

  private async rows(tx: TransactionScope, query: ReturnType<typeof sql>): Promise<Row[]> {
    return (await this.exec(tx).execute(query)).rows as Row[];
  }

  async customer(
    scope: TenantContext,
    id: string,
    tx: TransactionScope,
  ): Promise<CustomerFact | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT id, telegram_user_id, username, first_name, last_name, phone_number, source,
                 status, blocked_reason
            FROM customers WHERE tenant_id = ${tenantId} AND id = ${id}`,
    );
    if (row === undefined) return null;
    return {
      id: String(row['id']),
      telegramUserId: String(row['telegram_user_id']),
      username: str(row['username']),
      firstName: str(row['first_name']),
      lastName: str(row['last_name']),
      phone: str(row['phone_number']),
      source: String(row['source']),
      status: String(row['status']),
      blockedReason: str(row['blocked_reason']),
    };
  }

  async massCredit(
    scope: TenantContext,
    operationId: string,
    tx: TransactionScope,
  ): Promise<MassCreditFact | null> {
    const tenantId = requireTenantId(scope);
    // The total is the ledger's: the MASS_CREDIT entries the operation's items point at.
    const [row] = await this.rows(
      tx,
      sql`SELECT o.id, o.amount_minor::text AS amount, o.currency, o.note, o.notify,
                 o.created_by_admin_id,
                 count(i.id) FILTER (WHERE i.state = 'CREDITED')::int AS credited,
                 count(i.id) FILTER (WHERE i.state = 'SKIPPED')::int AS skipped,
                 COALESCE(SUM(w.amount) FILTER (WHERE w.reason = 'MASS_CREDIT'
                                                 AND w.direction = 'CREDIT'), 0)::text AS total
            FROM bulk_operations o
            LEFT JOIN bulk_operation_items i
              ON i.tenant_id = o.tenant_id AND i.bulk_operation_id = o.id
            LEFT JOIN wallet_entries w
              ON w.tenant_id = i.tenant_id AND w.id = i.wallet_entry_id
           WHERE o.tenant_id = ${tenantId} AND o.id = ${operationId} AND o.kind = 'WALLET_CREDIT'
           GROUP BY o.id`,
    );
    if (row === undefined || row['amount'] === null || row['currency'] === null) return null;
    const credited = Number(row['credited']);
    if (credited === 0) return null;
    const currency = String(row['currency']) as CurrencyCode;
    return {
      id: String(row['id']),
      amount: money(big(row['amount']), currency),
      note: String(row['note']),
      notify: row['notify'] === true,
      createdByAdminId: String(row['created_by_admin_id']),
      credited,
      skipped: Number(row['skipped']),
      total: money(big(row['total']), currency),
    };
  }

  async admin(scope: TenantContext, id: string, tx: TransactionScope): Promise<AdminFact | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT id, username, display_name, telegram_user_id FROM admins
           WHERE tenant_id = ${tenantId} AND id = ${id}`,
    );
    if (row === undefined) return null;
    const roles = await this.rows(
      tx,
      sql`SELECT r.name AS name, r.key AS key FROM admin_roles ar
            JOIN roles r ON r.tenant_id = ar.tenant_id AND r.id = ar.role_id
           WHERE ar.tenant_id = ${tenantId} AND ar.admin_id = ${id}
           ORDER BY r.name`,
    );
    const [count] = await this.rows(
      tx,
      sql`SELECT count(DISTINCT rp.permission_key)::int AS n FROM admin_roles ar
            JOIN role_permissions rp ON rp.tenant_id = ar.tenant_id AND rp.role_id = ar.role_id
           WHERE ar.tenant_id = ${tenantId} AND ar.admin_id = ${id}`,
    );
    return {
      id: String(row['id']),
      username: String(row['username']),
      displayName: String(row['display_name']),
      telegramUserId: str(row['telegram_user_id']),
      roleNames: roles.map((role) => String(role['name'])),
      roleKeys: roles.map((role) => String(role['key'])),
      permissionCount: Number(count?.['n'] ?? 0),
    };
  }

  async roleNames(
    scope: TenantContext,
    keys: readonly string[],
    tx: TransactionScope,
  ): Promise<ReadonlyMap<string, string>> {
    const tenantId = requireTenantId(scope);
    if (keys.length === 0) return new Map();
    const found = await this.rows(
      tx,
      sql`SELECT key, name FROM roles WHERE tenant_id = ${tenantId} AND key IN ${list(keys)}`,
    );
    return new Map(found.map((row) => [String(row['key']), String(row['name'])]));
  }

  async permissionCountOf(
    scope: TenantContext,
    keys: readonly string[],
    tx: TransactionScope,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    if (keys.length === 0) return 0;
    const [row] = await this.rows(
      tx,
      sql`SELECT count(DISTINCT rp.permission_key)::int AS n FROM roles r
            JOIN role_permissions rp ON rp.tenant_id = r.tenant_id AND rp.role_id = r.id
           WHERE r.tenant_id = ${tenantId} AND r.key IN ${list(keys)}`,
    );
    return Number(row?.['n'] ?? 0);
  }

  private toEntry(row: Row): LedgerEntryFact {
    return {
      id: String(row['id']),
      customerId: String(row['customer_id']),
      direction: row['direction'] === 'DEBIT' ? 'DEBIT' : 'CREDIT',
      reason: String(row['reason']),
      amount: money(big(row['amount']), String(row['currency']) as CurrencyCode),
      reference: String(row['reference']),
      orderId: str(row['order_id']),
      paymentId: str(row['payment_id']),
      actorAdminId: str(row['actor_admin_id']),
      note: str(row['note']),
      createdAt: date(row['created_at']) ?? new Date(0),
    };
  }

  private static readonly ENTRY_COLUMNS = sql`id, customer_id, direction, reason, amount, currency,
      reference, order_id, payment_id, actor_admin_id, note, created_at`;

  async ledgerEntry(
    scope: TenantContext,
    id: string,
    tx: TransactionScope,
  ): Promise<LedgerEntryFact | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT ${DrizzleOpsLogFacts.ENTRY_COLUMNS} FROM wallet_entries
           WHERE tenant_id = ${tenantId} AND id = ${id}`,
    );
    return row === undefined ? null : this.toEntry(row);
  }

  async ledgerEntryByReference(
    scope: TenantContext,
    reference: string,
    tx: TransactionScope,
  ): Promise<LedgerEntryFact | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT ${DrizzleOpsLogFacts.ENTRY_COLUMNS} FROM wallet_entries
           WHERE tenant_id = ${tenantId} AND reference = ${reference}`,
    );
    return row === undefined ? null : this.toEntry(row);
  }

  async entriesOfPayment(
    scope: TenantContext,
    paymentId: string,
    reasons: readonly string[],
    tx: TransactionScope,
  ): Promise<readonly LedgerEntryFact[]> {
    const tenantId = requireTenantId(scope);
    if (reasons.length === 0) return [];
    const found = await this.rows(
      tx,
      sql`SELECT ${DrizzleOpsLogFacts.ENTRY_COLUMNS} FROM wallet_entries
           WHERE tenant_id = ${tenantId} AND payment_id = ${paymentId}
             AND reason IN ${list(reasons)}
           ORDER BY created_at, id`,
    );
    return found.map((row) => this.toEntry(row));
  }

  async entriesOfOrder(
    scope: TenantContext,
    orderId: string,
    reason: string,
    tx: TransactionScope,
  ): Promise<readonly LedgerEntryFact[]> {
    const tenantId = requireTenantId(scope);
    const found = await this.rows(
      tx,
      sql`SELECT ${DrizzleOpsLogFacts.ENTRY_COLUMNS} FROM wallet_entries
           WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND reason = ${reason}
           ORDER BY created_at, id`,
    );
    return found.map((row) => this.toEntry(row));
  }

  async balanceAround(
    scope: TenantContext,
    customerId: string,
    currency: CurrencyCode,
    entryIds: readonly string[],
    tx: TransactionScope,
  ): Promise<BalanceAround | null> {
    const tenantId = requireTenantId(scope);
    if (entryIds.length === 0) return null;
    // Summed in COMMIT order — see `balanceInCommitOrder`, the one reader.
    const [row] = await this.rows(
      tx,
      balanceInCommitOrder({ tenantId, customerId, currency, entryIds }),
    );
    if (row === undefined || row['found'] !== true) return null;
    const afterMinor = big(row['after'] ?? '0');
    const ownMinor = big(row['own'] ?? '0');
    return {
      before: money(afterMinor - ownMinor, currency),
      after: money(afterMinor, currency),
    };
  }

  async payment(
    scope: TenantContext,
    id: string,
    tx: TransactionScope,
  ): Promise<PaymentFact | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT id, code, reference, method, gateway_provider, amount, currency, state
            FROM payments WHERE tenant_id = ${tenantId} AND id = ${id}`,
    );
    return row === undefined ? null : this.toPayment(row);
  }

  async paymentOfOrder(
    scope: TenantContext,
    orderId: string,
    tx: TransactionScope,
  ): Promise<PaymentFact | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT id, code, reference, method, gateway_provider, amount, currency, state
            FROM payments
           WHERE tenant_id = ${tenantId} AND order_id = ${orderId} AND state = 'CONFIRMED'
           ORDER BY confirmed_at DESC NULLS LAST, id LIMIT 1`,
    );
    return row === undefined ? null : this.toPayment(row);
  }

  private toPayment(row: Row): PaymentFact {
    return {
      id: String(row['id']),
      code: str(row['code']),
      reference: String(row['reference']),
      method: String(row['method']),
      gatewayProvider: str(row['gateway_provider']),
      amount: money(big(row['amount']), String(row['currency']) as CurrencyCode),
      state: String(row['state']),
    };
  }

  async order(scope: TenantContext, id: string, tx: TransactionScope): Promise<OrderFact | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT o.id, o.code, o.customer_id, o.purpose, o.origin, o.source, o.state, o.line_title,
                 o.line_duration_days, o.line_traffic_bytes, o.panel_id, p.name AS panel_name,
                 pr.service_location_label AS location_label,
                 o.subtotal_amount, o.discount_amount, o.total_amount, o.currency, o.settled_at,
                 EXISTS (SELECT 1 FROM order_reseller_terms t
                          WHERE t.tenant_id = o.tenant_id AND t.order_id = o.id) AS reseller,
                 (SELECT t.list_amount FROM order_reseller_terms t
                   WHERE t.tenant_id = o.tenant_id AND t.order_id = o.id) AS reseller_list,
                 ${isFirstPaidPurchase('o')} AS first_purchase
            FROM orders o
            LEFT JOIN panels p ON p.tenant_id = o.tenant_id AND p.id = o.panel_id
            LEFT JOIN products pr ON pr.tenant_id = o.tenant_id AND pr.id = o.product_id
           WHERE o.tenant_id = ${tenantId} AND o.id = ${id}`,
    );
    if (row === undefined) return null;
    const currency = String(row['currency']) as CurrencyCode;
    return {
      id: String(row['id']),
      code: str(row['code']),
      customerId: String(row['customer_id']),
      purpose: String(row['purpose']),
      origin: String(row['origin']),
      source: String(row['source']),
      state: String(row['state']),
      title: String(row['line_title']),
      durationDays: Number(row['line_duration_days']),
      trafficBytes: big(row['line_traffic_bytes']),
      panelId: String(row['panel_id']),
      panelName: str(row['panel_name']) ?? '',
      locationLabel: str(row['location_label']),
      subtotal: money(big(row['subtotal_amount']), currency),
      discount: money(big(row['discount_amount']), currency),
      total: money(big(row['total_amount']), currency),
      settledAt: date(row['settled_at']),
      isFirstPurchase: row['first_purchase'] === true,
      reseller: row['reseller'] === true,
      resellerListPrice:
        row['reseller_list'] === null || row['reseller_list'] === undefined
          ? null
          : money(big(row['reseller_list']), currency),
    };
  }

  async orderOrigin(
    scope: TenantContext,
    orderId: string,
    tx: TransactionScope,
  ): Promise<OrderOriginFact | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT a.source_surface, a.actor_type, a.actor_id, a.actor_label
            FROM audit_logs a
           WHERE a.tenant_id = ${tenantId} AND a.result = 'SUCCESS'
             AND ((a.entity_type = 'Order' AND a.entity_id = ${orderId}
                   AND a.action = 'order.draft_create')
               OR (a.entity_type = 'Service'
                   AND a.action IN ('service.renew_draft', 'service.add_traffic_draft',
                                    'service.add_time_draft')
                   AND a.entity_id = (SELECT c.service_id::text FROM service_commercial_actions c
                                       WHERE c.tenant_id = ${tenantId} AND c.order_id = ${orderId})
                   AND a.after ->> 'orderId' = ${orderId}))
           ORDER BY a.occurred_at, a.id
           LIMIT 1`,
    );
    if (row === undefined) return null;
    const actorId = str(row['actor_id']);
    /*
     * Round 10, D1: «منبع: تمدید خودکار» is decided by the auto-renew run that NAMES this order
     * — a RENEWED run, whose `order_id` the settling transaction wrote — never by the surface.
     */
    const [auto] = await this.rows(
      tx,
      sql`SELECT 1 FROM service_auto_renew_runs r
           WHERE r.tenant_id = ${tenantId} AND r.order_id = ${orderId} AND r.state = 'RENEWED'
           LIMIT 1`,
    );
    return {
      surface: String(row['source_surface']),
      actorType: String(row['actor_type']),
      actorId: actorId !== null && UUID.test(actorId) ? actorId : null,
      actorLabel: str(row['actor_label']),
      ...(auto === undefined ? {} : { autoRenew: true as const }),
    };
  }

  async service(
    scope: TenantContext,
    id: string,
    tx: TransactionScope,
  ): Promise<ServiceFact | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT s.id, s.code, s.customer_id, s.order_id, s.panel_id, p.name AS panel_name,
                 s.provider_username, s.is_trial, s.state, s.expires_at, s.traffic_limit_bytes,
                 s.traffic_used_bytes, s.last_seen_at, s.source
            FROM services s
            LEFT JOIN panels p ON p.tenant_id = s.tenant_id AND p.id = s.panel_id
           WHERE s.tenant_id = ${tenantId} AND s.id = ${id}`,
    );
    if (row === undefined) return null;
    return {
      id: String(row['id']),
      code: str(row['code']),
      customerId: String(row['customer_id']),
      orderId: String(row['order_id']),
      panelId: String(row['panel_id']),
      panelName: str(row['panel_name']) ?? '',
      providerUsername: String(row['provider_username']),
      isTrial: row['is_trial'] === true,
      state: String(row['state']),
      expiresAt: date(row['expires_at']),
      trafficLimitBytes: big(row['traffic_limit_bytes']),
      trafficUsedBytes: big(row['traffic_used_bytes']),
      lastSeenAt: date(row['last_seen_at']),
      source: String(row['source']),
    };
  }

  async operation(
    scope: TenantContext,
    id: string,
    tx: TransactionScope,
  ): Promise<OperationFact | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT id, type, state, service_id, order_id, requested_by_customer_id, panel_id,
                 failure_kind, failure_message, target_expires_at, target_traffic_limit_bytes,
                 completed_at
            FROM provisioning_operations WHERE tenant_id = ${tenantId} AND id = ${id}`,
    );
    if (row === undefined) return null;
    return {
      id: String(row['id']),
      type: String(row['type']),
      state: String(row['state']),
      serviceId: String(row['service_id']),
      orderId: str(row['order_id']),
      requestedByCustomerId: str(row['requested_by_customer_id']),
      panelId: String(row['panel_id']),
      failureKind: str(row['failure_kind']),
      failureMessage: str(row['failure_message']),
      targetExpiresAt: date(row['target_expires_at']),
      targetTrafficLimitBytes:
        row['target_traffic_limit_bytes'] === null ||
        row['target_traffic_limit_bytes'] === undefined
          ? null
          : big(row['target_traffic_limit_bytes']),
      completedAt: date(row['completed_at']),
    };
  }

  async failedOperationOfOrder(
    scope: TenantContext,
    orderId: string,
    tx: TransactionScope,
  ): Promise<OperationFact | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT id FROM provisioning_operations
           WHERE tenant_id = ${tenantId} AND order_id = ${orderId}
             AND state IN ('FAILED', 'ABANDONED', 'UNKNOWN')
           ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC LIMIT 1`,
    );
    return row === undefined ? null : this.operation(scope, String(row['id']), tx);
  }

  async undeliverableReason(
    scope: TenantContext,
    orderId: string,
    tx: TransactionScope,
  ): Promise<string | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT context ->> 'reason' AS reason FROM operational_events
           WHERE tenant_id = ${tenantId} AND code = 'order.refunded_undeliverable'
             AND dedupe_key = ${`order.refunded_undeliverable:${orderId}`}
           ORDER BY last_seen_at DESC LIMIT 1`,
    );
    return str(row?.['reason']);
  }

  async serviceBefore(
    scope: TenantContext,
    serviceId: string,
    action: string,
    orderId: string,
    tx: TransactionScope,
  ): Promise<ServiceBeforeImage | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT before FROM audit_logs
           WHERE tenant_id = ${tenantId} AND entity_type = 'Service' AND entity_id = ${serviceId}
             AND action = ${action} AND result = 'SUCCESS'
             AND after ->> 'orderId' = ${orderId}
           ORDER BY occurred_at DESC LIMIT 1`,
    );
    const before = row?.['before'];
    if (typeof before !== 'object' || before === null) return null;
    const image = before as Record<string, unknown>;
    const expires = image['expiresAt'];
    const limit = image['trafficLimitBytes'];
    const used = image['trafficUsedBytes'];
    return {
      expiresAt: typeof expires === 'string' ? new Date(expires) : null,
      trafficLimitBytes: typeof limit === 'string' && /^\d+$/.test(limit) ? BigInt(limit) : null,
      trafficUsedBytes: typeof used === 'string' && /^\d+$/.test(used) ? BigInt(used) : null,
    };
  }

  async latestLinkOperation(
    scope: TenantContext,
    serviceId: string,
    until: Date,
    tx: TransactionScope,
  ): Promise<{ readonly type: string; readonly requestedByCustomerId: string | null } | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT type, requested_by_customer_id FROM provisioning_operations
           WHERE tenant_id = ${tenantId} AND service_id = ${serviceId}
             AND type IN ('ROTATE_SUBSCRIPTION', 'CHANGE_LOCATION') AND state = 'SUCCEEDED'
             AND completed_at <= ${until}
           ORDER BY completed_at DESC NULLS LAST, created_at DESC, id DESC LIMIT 1`,
    );
    return row === undefined
      ? null
      : { type: String(row['type']), requestedByCustomerId: str(row['requested_by_customer_id']) };
  }

  async rotationsInLast30Days(
    scope: TenantContext,
    serviceId: string,
    until: Date,
    tx: TransactionScope,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const since = new Date(until.getTime() - 30 * 86_400_000);
    const [row] = await this.rows(
      tx,
      sql`SELECT count(*)::int AS n FROM provisioning_operations
           WHERE tenant_id = ${tenantId} AND service_id = ${serviceId}
             AND type = 'ROTATE_SUBSCRIPTION' AND state = 'SUCCEEDED'
             AND completed_at > ${since} AND completed_at <= ${until}`,
    );
    return Number(row?.['n'] ?? 0);
  }

  async referrerOf(
    scope: TenantContext,
    refereeId: string,
    tx: TransactionScope,
  ): Promise<string | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT referrer_id FROM referrals WHERE tenant_id = ${tenantId} AND referee_id = ${refereeId} LIMIT 1`,
    );
    return row === undefined ? null : String(row['referrer_id']);
  }

  async referralOf(
    scope: TenantContext,
    referralId: string,
    tx: TransactionScope,
  ): Promise<{ readonly referrerId: string; readonly refereeId: string } | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT referrer_id, referee_id FROM referrals WHERE tenant_id = ${tenantId} AND id = ${referralId}`,
    );
    return row === undefined
      ? null
      : { referrerId: String(row['referrer_id']), refereeId: String(row['referee_id']) };
  }

  async ticket(
    scope: TenantContext,
    id: string,
    messageId: string,
    tx: TransactionScope,
  ): Promise<TicketFact | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT t.id, t.number::text AS number, t.code, t.customer_id, t.category_title,
                 (SELECT m.body FROM ticket_messages m
                   WHERE m.tenant_id = t.tenant_id AND m.id = ${messageId}) AS body,
                 (SELECT a.source_surface FROM audit_logs a
                   WHERE a.tenant_id = t.tenant_id AND a.entity_type = 'Ticket'
                     AND a.entity_id = t.id::text AND a.result = 'SUCCESS'
                     AND a.action IN ('ticket.open', 'ticket.customer_message')
                     AND a.after ->> 'messageId' = ${messageId}
                   ORDER BY a.occurred_at, a.id LIMIT 1) AS surface
            FROM tickets t WHERE t.tenant_id = ${tenantId} AND t.id = ${id}`,
    );
    if (row === undefined) return null;
    return {
      id: String(row['id']),
      number: String(row['number']),
      code: str(row['code']),
      customerId: String(row['customer_id']),
      categoryTitle: String(row['category_title']),
      snippetSource: str(row['body']),
      surface: str(row['surface']),
    };
  }

  async conditionClosedBy(
    scope: TenantContext,
    recoveryEventId: string,
    tx: TransactionScope,
  ): Promise<Date | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT min(first_seen_at) AS first_seen_at FROM operational_events
           WHERE tenant_id = ${tenantId} AND resolved_by_event_id = ${recoveryEventId}`,
    );
    return date(row?.['first_seen_at']);
  }

  async panelName(scope: TenantContext, id: string, tx: TransactionScope): Promise<string | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT name FROM panels WHERE tenant_id = ${tenantId} AND id = ${id}`,
    );
    return row === undefined ? null : String(row['name']);
  }

  async undeliveredCustomerCount(
    scope: TenantContext,
    botInstanceId: string,
    notificationKind: string,
    tx: TransactionScope,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows(
      tx,
      sql`SELECT COUNT(DISTINCT customer_id) AS n FROM customer_notifications
          WHERE tenant_id = ${tenantId} AND bot_instance_id = ${botInstanceId}
            AND kind = ${notificationKind} AND state IN ('PENDING', 'FAILED')`,
    );
    return row === undefined ? 0 : Number(row['n']);
  }
}
