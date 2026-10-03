import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  AUDIT_AUTH_ACTION_PREFIX,
  AUDIT_AUTH_ACTIONS,
  AUDIT_CRITICAL_ACTION_CODES,
  type ActorType,
  type AuditResult,
  type SourceSurface,
  type TenantContext,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import {
  admins,
  auditLogs,
  customers,
  orders,
  payments,
  services,
} from '../../../../infrastructure/persistence/schema.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import { redactRecord, redactSecretText } from '../../../../infrastructure/redaction.js';
import type {
  AuditLogFilter,
  AuditLogPosition,
  AuditLogReader,
  AuditLogRecord,
} from '../application/ports.js';

/**
 * The audit log browser's reads (Phase D1, `docs/audit-log.md`).
 *
 * Every statement opens with `tenant_id = $scope`, so the four tenant-led keyset indexes in
 * `ONLINE_INDEXES` (`audit_logs_tenant_*_page_idx`) are what serves it and a row with no
 * tenant, or another tenant's, cannot be selected. The order is `(occurred_at, id)` DESC on
 * both — `occurred_at` is a per-transaction `Clock.now()`, so many rows share it, and the id
 * is the tie-break that keeps a group straddling a page boundary on exactly one page.
 *
 * The columns are listed, so `ip` and `user_agent` are never selected. `before`, `after` and
 * `reason` were redacted when they were written; they are redacted AGAIN here, by the same
 * one implementation, because a row is read for years and the redactor has learned keys
 * since (`subscription`, `passphrase`) that older rows were written without.
 */
export class DrizzleAuditLogReader implements AuditLogReader {
  constructor(private readonly db: Database) {}

  async page(
    scope: TenantContext,
    filter: AuditLogFilter,
    limit: number,
    after: AuditLogPosition | null,
  ): Promise<readonly AuditLogRecord[]> {
    const rows = await this.pageQuery(scope, filter, limit, after);
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorType: row.actorType as ActorType,
      actorId: row.actorId,
      actorLabel: row.actorLabel,
      surface: row.surface as SourceSurface,
      result: row.result as AuditResult,
      occurredAt: row.occurredAt,
      entityType: row.entityType,
      entityId: row.entityId,
      reason: row.reason === null ? null : redactSecretText(row.reason),
      correlationId: row.correlationId,
      before: redactedObject(row.before),
      after: redactedObject(row.after),
      position: { occurredAt: row.occurredAtText, id: row.id },
    }));
  }

  /**
   * The exact statement `page` sends, for `audit-log-plan.test.ts` to EXPLAIN — so the plan
   * that is asserted is production's, not a retyped look-alike.
   */
  pageStatement(
    scope: TenantContext,
    filter: AuditLogFilter,
    limit: number,
    after: AuditLogPosition | null,
  ): { sql: string; params: unknown[] } {
    return this.pageQuery(scope, filter, limit, after).toSQL();
  }

  private pageQuery(
    scope: TenantContext,
    filter: AuditLogFilter,
    limit: number,
    after: AuditLogPosition | null,
  ) {
    const tenantId = requireTenantId(scope);
    const conditions = auditLogConditions(tenantId, filter);
    if (after !== null) {
      conditions.push(
        sql`(${auditLogs.occurredAt}, ${auditLogs.id}) < (${after.occurredAt}::timestamptz, ${after.id}::uuid)`,
      );
    }
    return this.db
      .select({
        id: auditLogs.id,
        occurredAt: auditLogs.occurredAt,
        occurredAtText: sql<string>`to_char(${auditLogs.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        actorType: auditLogs.actorType,
        actorId: auditLogs.actorId,
        actorLabel: auditLogs.actorLabel,
        surface: auditLogs.sourceSurface,
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        result: auditLogs.result,
        reason: auditLogs.reason,
        correlationId: auditLogs.correlationId,
        before: auditLogs.before,
        after: auditLogs.after,
      })
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.id))
      .limit(limit);
  }

  async adminIdsByUsername(scope: TenantContext, username: string): Promise<readonly string[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select({ id: admins.id })
      .from(admins)
      .where(
        and(eq(admins.tenantId, tenantId), sql`lower(${admins.username}) = lower(${username})`),
      );
    return rows.map((row) => row.id);
  }

  async ownersOf(
    scope: TenantContext,
    refs: {
      readonly customers: readonly string[];
      readonly orders: readonly string[];
      readonly payments: readonly string[];
      readonly services: readonly string[];
    },
  ): Promise<ReadonlyMap<string, string>> {
    const tenantId = requireTenantId(scope);
    const owners = new Map<string, string>();
    if (refs.customers.length > 0) {
      const rows = await this.db
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.tenantId, tenantId), inArray(customers.id, [...refs.customers])));
      for (const row of rows) owners.set(`Customer:${row.id}`, row.id);
    }
    if (refs.orders.length > 0) {
      const rows = await this.db
        .select({ id: orders.id, customerId: orders.customerId })
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), inArray(orders.id, [...refs.orders])));
      for (const row of rows) owners.set(`Order:${row.id}`, row.customerId);
    }
    if (refs.payments.length > 0) {
      const rows = await this.db
        .select({ id: payments.id, customerId: payments.customerId })
        .from(payments)
        .where(and(eq(payments.tenantId, tenantId), inArray(payments.id, [...refs.payments])));
      for (const row of rows) owners.set(`Payment:${row.id}`, row.customerId);
    }
    if (refs.services.length > 0) {
      const rows = await this.db
        .select({ id: services.id, customerId: services.customerId })
        .from(services)
        .where(and(eq(services.tenantId, tenantId), inArray(services.id, [...refs.services])));
      for (const row of rows) owners.set(`Service:${row.id}`, row.customerId);
    }
    return owners;
  }
}

/**
 * The WHERE clause, shared by every read of the browser and exported so the plan test runs
 * the statement the browser sends rather than a hand-written look-alike.
 */
export function auditLogConditions(tenantId: string, filter: AuditLogFilter): SQL[] {
  const conditions: SQL[] = [eq(auditLogs.tenantId, tenantId)];
  if (filter.actorIds !== undefined) {
    // An actor nobody resolved to is a filter that matches nothing, never "no filter".
    conditions.push(
      filter.actorIds.length === 0 ? sql`false` : inArray(auditLogs.actorId, [...filter.actorIds]),
    );
  }
  if (filter.actorType !== undefined) conditions.push(eq(auditLogs.actorType, filter.actorType));
  if (filter.customerId !== undefined) {
    conditions.push(customerCondition(tenantId, filter.customerId));
  }
  if (filter.action !== undefined) {
    conditions.push(
      'exact' in filter.action
        ? eq(auditLogs.action, filter.action.exact)
        : sql`${auditLogs.action} LIKE ${likePrefix(filter.action.prefix)}`,
    );
  }
  if (filter.entityType !== undefined) {
    conditions.push(eq(auditLogs.entityType, filter.entityType));
  }
  if (filter.entityId !== undefined) conditions.push(eq(auditLogs.entityId, filter.entityId));
  if (filter.result !== undefined) conditions.push(eq(auditLogs.result, filter.result));
  if (filter.security !== undefined) conditions.push(securityCondition(filter.security));
  if (filter.from !== undefined) {
    conditions.push(sql`${auditLogs.occurredAt} >= ${filter.from}::timestamptz`);
  }
  if (filter.to !== undefined) {
    conditions.push(sql`${auditLogs.occurredAt} < ${filter.to}::timestamptz`);
  }
  return conditions;
}

/**
 * One customer's rows: about them, or about something of theirs.
 *
 * Each arm is `entity_type = … AND entity_id = ANY(ARRAY(subquery))`, never `IN (subquery)`:
 * the ARRAY form is an InitPlan, evaluated once, so every arm is an index condition on
 * `audit_logs_tenant_entity_page_idx` and the OR is a BitmapOr rather than a filter over a
 * walk of the tenant's whole log. Ownership is read NOW — after an account transfer, an order
 * the customer brought with them is theirs, and its history comes with it.
 */
function customerCondition(tenantId: string, customerId: string): SQL {
  const owned = (table: typeof orders | typeof payments | typeof services) =>
    sql`ARRAY(SELECT ${table.id}::text FROM ${table} WHERE ${table.tenantId} = ${tenantId} AND ${table.customerId} = ${customerId})`;
  return sql`(
    (${auditLogs.entityType} IN ('Customer', 'Wallet') AND ${auditLogs.entityId} = ${customerId})
    OR (${auditLogs.entityType} = 'Order' AND ${auditLogs.entityId} = ANY(${owned(orders)}))
    OR (${auditLogs.entityType} = 'Payment' AND ${auditLogs.entityId} = ANY(${owned(payments)}))
    OR (${auditLogs.entityType} = 'Service' AND ${auditLogs.entityId} = ANY(${owned(services)}))
  )`;
}

/** The SQL form of `auditSecurityClasses` in the contract — the same rule, one per slice. */
function securityCondition(security: AuditLogFilter['security']): SQL {
  switch (security) {
    case 'DENIED':
      // A literal, so the predicate visibly implies `audit_logs_tenant_denied_page_idx`'s.
      return sql`${auditLogs.result} = 'DENIED'`;
    case 'AUTH':
      return sql`(${auditLogs.action} LIKE ${likePrefix(AUDIT_AUTH_ACTION_PREFIX)} OR ${inArray(auditLogs.action, [...AUDIT_AUTH_ACTIONS])})`;
    case 'CRITICAL':
      return inArray(auditLogs.action, [...AUDIT_CRITICAL_ACTION_CODES]);
    default:
      return sql`true`;
  }
}

/**
 * A LIKE pattern that matches exactly the strings starting with `prefix`. The action schema
 * admits only `[a-z0-9_.]`, but `_` is a LIKE wildcard — `reseller_tier.` would otherwise
 * also match `resellerXtier.` — so the escape is done here rather than assumed.
 */
function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
}

function redactedObject(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? redactRecord(value as Record<string, unknown>)
    : null;
}
