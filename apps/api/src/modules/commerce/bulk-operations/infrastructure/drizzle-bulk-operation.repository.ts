import { sql, type SQL } from 'drizzle-orm';
import {
  canonicalAudienceDefinition,
  type BulkCounts,
  type BulkItemState,
  type BulkOperationKind,
  type BulkOperationState,
  type BulkSkipReason,
  type CurrencyCode,
  type CustomerNotificationState,
  type TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  audienceCustomersQuery,
  audienceServicesQuery,
  fingerprintOf,
  type AudienceEvaluation,
} from '../../audience/infrastructure/audience-sql.js';
import type {
  BulkItemPageRow,
  BulkOperationDraft,
  BulkOperationRecord,
  BulkOperationRepository,
  BulkSampleRow,
  FrozenItems,
  GrantEligibility,
  LockedItem,
} from '../application/ports.js';

type Instant = Date | string;
const date = (value: Instant): Date => (value instanceof Date ? value : new Date(value));
const maybeDate = (value: Instant | null): Date | null => (value === null ? null : date(value));

interface OperationRow {
  id: string;
  kind: BulkOperationKind;
  state: BulkOperationState;
  amount_minor: string | null;
  currency: CurrencyCode | null;
  traffic_bytes: string | null;
  duration_days: number | null;
  notify: boolean;
  note: string;
  audience_definition: unknown;
  audience_hash: string;
  audience_as_of: Instant;
  item_count: number;
  audience_fingerprint: string;
  not_before: Instant | null;
  created_by_id: string | null;
  created_by_username: string | null;
  created_at: Instant;
  completed_at: Instant | null;
  cancelled_at: Instant | null;
}

function toRecord(row: OperationRow): BulkOperationRecord {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    amountMinor: row.amount_minor === null ? null : BigInt(row.amount_minor),
    currency: row.currency,
    trafficBytes: row.traffic_bytes === null ? null : BigInt(row.traffic_bytes),
    durationDays: row.duration_days,
    notify: row.notify,
    note: row.note,
    audienceDefinition: canonicalAudienceDefinition(row.audience_definition),
    audienceHash: row.audience_hash,
    audienceAsOf: date(row.audience_as_of),
    itemCount: row.item_count,
    audienceFingerprint: row.audience_fingerprint,
    notBefore: maybeDate(row.not_before),
    createdBy:
      row.created_by_id === null
        ? null
        : { id: row.created_by_id, username: row.created_by_username ?? '' },
    createdAt: date(row.created_at),
    completedAt: maybeDate(row.completed_at),
    cancelledAt: maybeDate(row.cancelled_at),
  };
}

const EMPTY: BulkCounts = {
  total: 0,
  pending: 0,
  credited: 0,
  planned: 0,
  awaitingReconciliation: 0,
  succeeded: 0,
  failed: 0,
  skipped: 0,
  cancelled: 0,
  notified: 0,
  notificationQueued: 0,
};

/**
 * The item's notice as the notification lane holds it. `notified_at` on the item is only the
 * instant it was ENQUEUED; whether the customer was told is the lane's row, found by its
 * unique key (tenant, kind, subject = the item). Codex R4 on PR #117.
 */
const NOTICE_JOIN = sql`LEFT JOIN customer_notifications n
                   ON n.tenant_id = i.tenant_id AND n.subject_id = i.id
                  AND n.kind IN ('WALLET_MASS_CREDITED', 'SERVICE_GIFT_APPLIED')`;

/**
 * The eligibility rule a grant adds to the audience's service block: ACTIVE (the one state
 * `ADD_TRAFFIC` and `ADD_TIME` are legal from), a finite limit in the granted dimension, and
 * a panel on which the operation is operable now. Shared by the preview and the
 * materialisation, so the count the operator confirmed and the set frozen are one question.
 */
function eligibility(rule: GrantEligibility, service: SQL = sql`s`): SQL {
  const finite =
    rule.kind === 'SERVICE_TRAFFIC'
      ? sql`${service}.traffic_limit_bytes > 0`
      : sql`${service}.expires_at IS NOT NULL`;
  return sql`${service}.state = 'ACTIVE' AND ${finite}
             AND ${service}.panel_id = ANY(${sql.param([...rule.operablePanelIds])}::uuid[])`;
}

/**
 * The mass-operation tables (round N, B2). Tenant-bound everywhere; every item transition is
 * a conditional UPDATE out of the state it names.
 */
export class DrizzleBulkOperationRepository implements BulkOperationRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  private async rows<T>(query: SQL, tx?: unknown): Promise<T[]> {
    const result = await this.exec(tx).execute<T & Record<string, unknown>>(query);
    return result.rows as T[];
  }

  private select(where: SQL, suffix: SQL = sql``): SQL {
    return sql`SELECT o.id, o.kind, o.state, o.amount_minor::text AS amount_minor, o.currency,
                      o.traffic_bytes::text AS traffic_bytes, o.duration_days, o.notify, o.note,
                      o.audience_definition, o.audience_hash, o.audience_as_of, o.item_count,
                      o.audience_fingerprint, o.not_before,
                      o.created_by_admin_id AS created_by_id, a.username AS created_by_username,
                      o.created_at, o.completed_at, o.cancelled_at
                 FROM bulk_operations o
                 LEFT JOIN admins a ON a.id = o.created_by_admin_id
                WHERE ${where} ${suffix}`;
  }

  async create(scope: TenantContext, draft: BulkOperationDraft, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    const at = draft.now.toISOString();
    await this.exec(tx).execute(sql`
      INSERT INTO bulk_operations (id, tenant_id, kind, state, amount_minor, currency, traffic_bytes,
                                   duration_days, notify, note, audience_definition, audience_hash,
                                   audience_as_of, item_count, audience_fingerprint, not_before,
                                   created_by_admin_id, created_at, updated_at)
      VALUES (${draft.id}::uuid, ${tenantId}::uuid, ${draft.kind}, 'RUNNING',
              ${draft.amountMinor?.toString() ?? null}::bigint, ${draft.currency},
              ${draft.trafficBytes?.toString() ?? null}::bigint, ${draft.durationDays},
              ${draft.notify}, ${draft.note}, ${draft.audienceJson}::jsonb, ${draft.audienceHash},
              ${draft.audienceAsOf.toISOString()}::timestamptz, ${draft.itemCount},
              ${draft.fingerprint}, ${draft.notBefore?.toISOString() ?? null}::timestamptz,
              ${draft.createdByAdminId}::uuid, ${at}::timestamptz, ${at}::timestamptz)`);
  }

  async find(scope: TenantContext, id: string, tx?: unknown) {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows<OperationRow>(
      this.select(sql`o.tenant_id = ${tenantId}::uuid AND o.id = ${id}::uuid`),
      tx,
    );
    return row === undefined ? null : toRecord(row);
  }

  async lock(scope: TenantContext, id: string, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(
      sql`SELECT 1 FROM bulk_operations WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`,
    );
    return this.find(scope, id, tx);
  }

  async list(
    scope: TenantContext,
    limit: number,
    cursor: { readonly createdAt: Date; readonly id: string } | null,
  ) {
    const tenantId = requireTenantId(scope);
    const after =
      cursor === null
        ? sql`true`
        : sql`(o.created_at, o.id) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`;
    const rows = await this.rows<OperationRow>(
      this.select(
        sql`o.tenant_id = ${tenantId}::uuid AND ${after}`,
        sql`ORDER BY o.created_at DESC, o.id DESC LIMIT ${limit}`,
      ),
    );
    return rows.map(toRecord);
  }

  async counts(scope: TenantContext, ids: readonly string[]) {
    const tenantId = requireTenantId(scope);
    const result = new Map<string, BulkCounts>();
    if (ids.length === 0) return result;
    for (const id of ids) result.set(id, { ...EMPTY });
    const rows = await this.rows<{
      bulk_operation_id: string;
      state: BulkItemState;
      n: number;
      unknown: number;
      notified: number;
      queued: number;
    }>(
      sql`SELECT i.bulk_operation_id, i.state, count(*)::int AS n,
                 count(*) FILTER (WHERE p.state = 'UNKNOWN')::int AS unknown,
                 count(*) FILTER (WHERE n.state = 'DELIVERED')::int AS notified,
                 count(*) FILTER (WHERE n.state = 'PENDING')::int AS queued
            FROM bulk_operation_items i
            LEFT JOIN provisioning_operations p
                   ON p.tenant_id = i.tenant_id AND p.id = i.provisioning_operation_id
            ${NOTICE_JOIN}
           WHERE i.tenant_id = ${tenantId}::uuid
             AND i.bulk_operation_id = ANY(${sql.param([...ids])}::uuid[])
           GROUP BY i.bulk_operation_id, i.state`,
    );
    for (const row of rows) {
      const current = result.get(row.bulk_operation_id) ?? { ...EMPTY };
      const key = row.state.toLowerCase() as keyof BulkCounts;
      result.set(row.bulk_operation_id, {
        ...current,
        [key]: row.n,
        total: current.total + row.n,
        notified: current.notified + row.notified,
        notificationQueued: current.notificationQueued + row.queued,
        awaitingReconciliation:
          current.awaitingReconciliation + (row.state === 'PLANNED' ? row.unknown : 0),
      });
    }
    return result;
  }

  async creditedTotals(scope: TenantContext, ids: readonly string[]) {
    const tenantId = requireTenantId(scope);
    const result = new Map<string, bigint>();
    if (ids.length === 0) return result;
    const rows = await this.rows<{ bulk_operation_id: string; total: string }>(
      sql`SELECT i.bulk_operation_id, coalesce(sum(w.amount), 0)::text AS total
            FROM bulk_operation_items i
            JOIN wallet_entries w ON w.tenant_id = i.tenant_id AND w.id = i.wallet_entry_id
           WHERE i.tenant_id = ${tenantId}::uuid
             AND i.bulk_operation_id = ANY(${sql.param([...ids])}::uuid[])
           GROUP BY i.bulk_operation_id`,
    );
    for (const id of ids) result.set(id, 0n);
    for (const row of rows) result.set(row.bulk_operation_id, BigInt(row.total));
    return result;
  }

  async items(
    scope: TenantContext,
    id: string,
    input: {
      readonly state: BulkItemState | null;
      readonly limit: number;
      readonly after: string | null;
    },
  ): Promise<readonly BulkItemPageRow[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows<{
      id: string;
      customer_id: string;
      first_name: string | null;
      username: string | null;
      service_id: string | null;
      service_label: string | null;
      state: BulkItemState;
      skip_reason: BulkSkipReason | null;
      operation_state: string | null;
      failure_kind: string | null;
      notice_state: CustomerNotificationState | null;
      processed_at: Instant | null;
    }>(
      sql`SELECT i.id, i.customer_id, c.first_name, c.username, i.service_id,
                 s.provider_username AS service_label, i.state, i.skip_reason,
                 p.state AS operation_state, p.failure_kind, n.state AS notice_state,
                 i.processed_at
            FROM bulk_operation_items i
            JOIN customers c ON c.tenant_id = i.tenant_id AND c.id = i.customer_id
            LEFT JOIN services s ON s.tenant_id = i.tenant_id AND s.id = i.service_id
            LEFT JOIN provisioning_operations p
                   ON p.tenant_id = i.tenant_id AND p.id = i.provisioning_operation_id
            ${NOTICE_JOIN}
           WHERE i.tenant_id = ${tenantId}::uuid AND i.bulk_operation_id = ${id}::uuid
             AND ${input.state === null ? sql`true` : sql`i.state = ${input.state}`}
             AND ${input.after === null ? sql`true` : sql`i.id > ${input.after}::uuid`}
           ORDER BY i.id
           LIMIT ${input.limit}`,
    );
    return rows.map((row) => ({
      id: row.id,
      customerId: row.customer_id,
      firstName: row.first_name,
      username: row.username,
      serviceId: row.service_id,
      serviceLabel: row.service_label,
      state: row.state,
      skipReason: row.skip_reason,
      operationState: row.operation_state,
      failureKind: row.failure_kind,
      notified: row.notice_state === 'DELIVERED',
      notificationState: row.notice_state,
      processedAt: maybeDate(row.processed_at),
    }));
  }

  async panelsFor(
    scope: TenantContext,
    evaluation: AudienceEvaluation,
    kind: 'SERVICE_TRAFFIC' | 'SERVICE_TIME',
    tx?: unknown,
  ) {
    const finite =
      kind === 'SERVICE_TRAFFIC' ? sql`s.traffic_limit_bytes > 0` : sql`s.expires_at IS NOT NULL`;
    requireTenantId(scope);
    const rows = await this.rows<{ panel_id: string }>(
      sql`SELECT DISTINCT a.panel_id FROM (${audienceServicesQuery(
        evaluation,
        sql`s.state = 'ACTIVE' AND ${finite}`,
      )}) a`,
      tx,
    );
    return rows.map((row) => row.panel_id);
  }

  async previewServices(
    scope: TenantContext,
    evaluation: AudienceEvaluation,
    rule: GrantEligibility,
    sampleSize: number,
  ) {
    const tenantId = requireTenantId(scope);
    const query = audienceServicesQuery(evaluation, eligibility(rule));
    const [summary] = await this.rows<{ count: number; customers: number; fingerprint: string }>(
      sql`SELECT count(*)::int AS count, count(DISTINCT a.customer_id)::int AS customers,
                 ${fingerprintOf(sql`a.service_id`)} AS fingerprint
            FROM (${query}) a`,
    );
    const sample = await this.rows<{
      customer_id: string;
      first_name: string | null;
      username: string | null;
      service_id: string;
      service_label: string;
    }>(
      sql`SELECT a.customer_id, c.first_name, c.username, a.service_id, a.service_label
            FROM (${query}) a
            JOIN customers c ON c.tenant_id = ${tenantId}::uuid AND c.id = a.customer_id
           ORDER BY a.service_id LIMIT ${sampleSize}`,
    );
    return {
      count: summary?.count ?? 0,
      customers: summary?.customers ?? 0,
      fingerprint: summary?.fingerprint ?? '',
      sample: sample.map((row) => ({
        customerId: row.customer_id,
        firstName: row.first_name,
        username: row.username,
        serviceId: row.service_id,
        serviceLabel: row.service_label,
      })),
    };
  }

  async sampleCustomers(
    scope: TenantContext,
    evaluation: AudienceEvaluation,
    sampleSize: number,
  ): Promise<readonly BulkSampleRow[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows<{
      customer_id: string;
      first_name: string | null;
      username: string | null;
    }>(
      sql`SELECT a.customer_id, c.first_name, c.username
            FROM (${audienceCustomersQuery(evaluation)}) a
            JOIN customers c ON c.tenant_id = ${tenantId}::uuid AND c.id = a.customer_id
           ORDER BY a.customer_id LIMIT ${sampleSize}`,
    );
    return rows.map((row) => ({
      customerId: row.customer_id,
      firstName: row.first_name,
      username: row.username,
      serviceId: null,
      serviceLabel: null,
    }));
  }

  /*
   * The two materialisations. Item ids are minted by the DATABASE (`gen_random_uuid()`), the
   * one deliberate exception to application-generated UUIDv7 keys: an INSERT ... SELECT over
   * an audience of tens of thousands must not ship every id through Node, and nothing needs
   * an item's id before its row exists — nothing writes it into an outbox row in the same
   * batch, and no surface parses it as a v7.
   */

  async materialiseCustomers(
    scope: TenantContext,
    id: string,
    evaluation: AudienceEvaluation,
    now: Date,
    tx: TransactionScope,
  ): Promise<FrozenItems> {
    const tenantId = requireTenantId(scope);
    const at = now.toISOString();
    await this.exec(tx).execute(sql`
      INSERT INTO bulk_operation_items (id, tenant_id, bulk_operation_id, customer_id, created_at,
                                        updated_at)
      SELECT gen_random_uuid(), ${tenantId}::uuid, ${id}::uuid, a.customer_id,
             ${at}::timestamptz, ${at}::timestamptz
        FROM (${audienceCustomersQuery(evaluation)}) a`);
    return this.frozen(tenantId, id, sql`i.customer_id`, tx);
  }

  async materialiseServices(
    scope: TenantContext,
    id: string,
    evaluation: AudienceEvaluation,
    rule: GrantEligibility,
    now: Date,
    tx: TransactionScope,
  ): Promise<FrozenItems> {
    const tenantId = requireTenantId(scope);
    const at = now.toISOString();
    await this.exec(tx).execute(sql`
      INSERT INTO bulk_operation_items (id, tenant_id, bulk_operation_id, customer_id, service_id,
                                        created_at, updated_at)
      SELECT gen_random_uuid(), ${tenantId}::uuid, ${id}::uuid, a.customer_id, a.service_id,
             ${at}::timestamptz, ${at}::timestamptz
        FROM (${audienceServicesQuery(evaluation, eligibility(rule))}) a`);
    return this.frozen(tenantId, id, sql`i.service_id`, tx);
  }

  private async frozen(tenantId: string, id: string, subject: SQL, tx: TransactionScope) {
    const [row] = await this.rows<{ count: number; customers: number; fingerprint: string }>(
      sql`SELECT count(*)::int AS count, count(DISTINCT i.customer_id)::int AS customers,
                 ${fingerprintOf(subject)} AS fingerprint
            FROM bulk_operation_items i
           WHERE i.tenant_id = ${tenantId}::uuid AND i.bulk_operation_id = ${id}::uuid`,
      tx,
    );
    return {
      count: row?.count ?? 0,
      customers: row?.customers ?? 0,
      fingerprint: row?.fingerprint ?? '',
    };
  }

  async cancel(scope: TenantContext, id: string, now: Date, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    const at = sql`${now.toISOString()}::timestamptz`;
    const moved = await this.rows<{ id: string }>(
      sql`UPDATE bulk_operations SET state = 'CANCELLED', cancelled_at = ${at}, updated_at = ${at}
           WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid AND state = 'RUNNING'
       RETURNING id`,
      tx,
    );
    if (moved.length === 0) return false;
    /*
     * Only what has NOT been processed. An item a processor holds is locked, so this UPDATE
     * waits for it and then finds it no longer PENDING: a credit already written stays
     * written, a grant already planned runs to its own end.
     */
    await this.exec(tx).execute(sql`
      UPDATE bulk_operation_items SET state = 'CANCELLED', updated_at = ${at}
       WHERE tenant_id = ${tenantId}::uuid AND bulk_operation_id = ${id}::uuid AND state = 'PENDING'`);
    return true;
  }

  // --- the processor's half -----------------------------------------------------------

  async lockNextPending(
    scope: TenantContext,
    now: Date,
    exclude: readonly string[],
    tx: TransactionScope,
  ) {
    const tenantId = requireTenantId(scope);
    const at = sql`${now.toISOString()}::timestamptz`;
    const [row] = await this.rows<{
      id: string;
      bulk_operation_id: string;
      customer_id: string;
      service_id: string | null;
      kind: BulkOperationKind;
      amount_minor: string | null;
      currency: CurrencyCode | null;
      traffic_bytes: string | null;
      duration_days: number | null;
      notify: boolean;
      note: string;
      created_by_admin_id: string;
      customer_status: string | null;
    }>(
      sql`SELECT i.id, i.bulk_operation_id, i.customer_id, i.service_id, o.kind,
                 o.amount_minor::text AS amount_minor, o.currency,
                 o.traffic_bytes::text AS traffic_bytes, o.duration_days, o.notify, o.note,
                 o.created_by_admin_id,
                 o.audience_definition ->> 'customerStatus' AS customer_status
            FROM bulk_operation_items i
            JOIN bulk_operations o ON o.tenant_id = i.tenant_id AND o.id = i.bulk_operation_id
           WHERE i.tenant_id = ${tenantId}::uuid AND i.state = 'PENDING'
             AND o.state = 'RUNNING'
             AND (o.not_before IS NULL OR o.not_before <= ${at})
             AND NOT (i.id = ANY(${sql.param([...exclude])}::uuid[]))
           ORDER BY i.bulk_operation_id, i.id
           LIMIT 1
           FOR UPDATE OF i SKIP LOCKED`,
      tx,
    );
    if (row === undefined) return null;
    return {
      id: row.id,
      operationId: row.bulk_operation_id,
      customerId: row.customer_id,
      serviceId: row.service_id,
      kind: row.kind,
      amountMinor: row.amount_minor === null ? null : BigInt(row.amount_minor),
      currency: row.currency,
      trafficBytes: row.traffic_bytes === null ? null : BigInt(row.traffic_bytes),
      durationDays: row.duration_days,
      notify: row.notify,
      note: row.note,
      createdByAdminId: row.created_by_admin_id,
      requiresActiveCustomer: row.customer_status === 'ACTIVE',
    } satisfies LockedItem;
  }

  private async moveFromPending(
    tenantId: string,
    itemId: string,
    set: SQL,
    tx: TransactionScope,
  ): Promise<void> {
    const rows = await this.rows<{ id: string }>(
      sql`UPDATE bulk_operation_items SET ${set}
           WHERE tenant_id = ${tenantId}::uuid AND id = ${itemId}::uuid AND state = 'PENDING'
       RETURNING id`,
      tx,
    );
    if (rows.length !== 1) {
      // The item is locked by this transaction; not finding it PENDING is a broken invariant.
      throw new Error(`bulk item ${itemId} left PENDING under its own lock`);
    }
  }

  async markCredited(
    scope: TenantContext,
    itemId: string,
    walletEntryId: string,
    now: Date,
    tx: TransactionScope,
  ) {
    const at = sql`${now.toISOString()}::timestamptz`;
    await this.moveFromPending(
      requireTenantId(scope),
      itemId,
      sql`state = 'CREDITED', wallet_entry_id = ${walletEntryId}::uuid, processed_at = ${at},
          updated_at = ${at}`,
      tx,
    );
  }

  async markPlanned(
    scope: TenantContext,
    itemId: string,
    rowId: string,
    now: Date,
    tx: TransactionScope,
  ) {
    const at = sql`${now.toISOString()}::timestamptz`;
    await this.moveFromPending(
      requireTenantId(scope),
      itemId,
      sql`state = 'PLANNED', provisioning_operation_id = ${rowId}::uuid, processed_at = ${at},
          updated_at = ${at}`,
      tx,
    );
  }

  async markSkipped(
    scope: TenantContext,
    itemId: string,
    reason: BulkSkipReason,
    now: Date,
    tx: TransactionScope,
  ) {
    const at = sql`${now.toISOString()}::timestamptz`;
    await this.moveFromPending(
      requireTenantId(scope),
      itemId,
      sql`state = 'SKIPPED', skip_reason = ${reason}, processed_at = ${at}, updated_at = ${at}`,
      tx,
    );
  }

  async markNotified(scope: TenantContext, itemId: string, now: Date, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    await this.exec(tx).execute(sql`
      UPDATE bulk_operation_items SET notified_at = ${now.toISOString()}::timestamptz
       WHERE tenant_id = ${tenantId}::uuid AND id = ${itemId}::uuid AND notified_at IS NULL`);
  }

  async settlePlanned(scope: TenantContext, now: Date, limit: number, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    const at = sql`${now.toISOString()}::timestamptz`;
    const rows = await this.rows<{
      id: string;
      customer_id: string;
      state: 'SUCCEEDED' | 'FAILED';
      notify: boolean;
    }>(
      sql`UPDATE bulk_operation_items i
             SET state = CASE WHEN due.op_state = 'SUCCEEDED' THEN 'SUCCEEDED' ELSE 'FAILED' END,
                 updated_at = ${at}
            FROM (
              SELECT i2.tenant_id, i2.id, p.state AS op_state, o.notify
                FROM bulk_operation_items i2
                JOIN provisioning_operations p
                  ON p.tenant_id = i2.tenant_id AND p.id = i2.provisioning_operation_id
                JOIN bulk_operations o ON o.tenant_id = i2.tenant_id AND o.id = i2.bulk_operation_id
               WHERE i2.tenant_id = ${tenantId}::uuid AND i2.state = 'PLANNED'
                 AND p.state IN ('SUCCEEDED', 'FAILED', 'ABANDONED')
               LIMIT ${limit}
               FOR UPDATE OF i2 SKIP LOCKED
            ) due
           WHERE i.tenant_id = due.tenant_id AND i.id = due.id
       RETURNING i.id, i.customer_id, i.state, due.notify`,
      tx,
    );
    return rows.map((row) => ({
      itemId: row.id,
      customerId: row.customer_id,
      to: row.state,
      notify: row.notify,
    }));
  }

  async completeFinished(scope: TenantContext, now: Date, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    const at = sql`${now.toISOString()}::timestamptz`;
    const rows = await this.rows<{ id: string; kind: string; item_count: number }>(
      sql`UPDATE bulk_operations o SET state = 'COMPLETED', completed_at = ${at}, updated_at = ${at}
           WHERE o.tenant_id = ${tenantId}::uuid AND o.state = 'RUNNING'
             AND NOT EXISTS (SELECT 1 FROM bulk_operation_items i
                              WHERE i.tenant_id = o.tenant_id AND i.bulk_operation_id = o.id
                                AND i.state IN ('PENDING', 'PLANNED'))
       RETURNING o.id, o.kind, o.item_count`,
      tx,
    );
    return rows.map((row) => ({ id: row.id, kind: row.kind, items: row.item_count }));
  }

  async customerStatus(scope: TenantContext, customerId: string, tx: TransactionScope) {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows<{ status: string }>(
      sql`SELECT status FROM customers WHERE tenant_id = ${tenantId}::uuid AND id = ${customerId}::uuid`,
      tx,
    );
    return row?.status ?? null;
  }

  async notificationValues(
    scope: TenantContext,
    kind: 'WALLET_MASS_CREDITED' | 'SERVICE_GIFT_APPLIED',
    itemId: string,
  ) {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows<{
      amount: string | null;
      currency: CurrencyCode | null;
      service_label: string | null;
      traffic_bytes: string | null;
      duration_days: number | null;
      state: BulkItemState;
    }>(
      sql`SELECT w.amount::text AS amount, w.currency, s.provider_username AS service_label,
                 o.traffic_bytes::text AS traffic_bytes, o.duration_days, i.state
            FROM bulk_operation_items i
            JOIN bulk_operations o ON o.tenant_id = i.tenant_id AND o.id = i.bulk_operation_id
            LEFT JOIN wallet_entries w ON w.tenant_id = i.tenant_id AND w.id = i.wallet_entry_id
            LEFT JOIN services s ON s.tenant_id = i.tenant_id AND s.id = i.service_id
           WHERE i.tenant_id = ${tenantId}::uuid AND i.id = ${itemId}::uuid`,
    );
    if (row === undefined) return null;
    // A notification names only an effect that HAPPENED: a credit written, a grant applied.
    if (kind === 'WALLET_MASS_CREDITED' && (row.state !== 'CREDITED' || row.amount === null)) {
      return null;
    }
    if (kind === 'SERVICE_GIFT_APPLIED' && row.state !== 'SUCCEEDED') return null;
    return {
      amountMinor: row.amount === null ? null : BigInt(row.amount),
      currency: row.currency,
      serviceLabel: row.service_label,
      trafficBytes: row.traffic_bytes === null ? null : BigInt(row.traffic_bytes),
      durationDays: row.duration_days,
    };
  }
}
