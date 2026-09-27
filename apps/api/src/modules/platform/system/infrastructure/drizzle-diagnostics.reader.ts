import { sql } from 'drizzle-orm';
import type {
  OperationState,
  OperationType,
  StuckOperationReason,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  DiagnosticsReader,
  OutboxDiagnostics,
  ProvisioningDiagnostics,
} from '../application/diagnostics.service.js';

/**
 * The diagnostics reads (WP16 D2). Each predicate is the one the sweep that owns the
 * condition uses, so "stuck" here means what the worker would act on:
 *
 * - UNKNOWN_OUTCOME: `state = 'UNKNOWN'` (`listUnknown`, `provisioning_operations_unknown_idx`).
 * - LEASE_EXPIRED:   `IN_FLIGHT` with `lease_until < now` (`releaseExpiredLeases`,
 *   `reapStrandedCalls`, `provisioning_operations_lease_idx`).
 * - RETRYING:        `PLANNED` with `attempts > 0` (the due queue's partial index).
 * - UNANNOUNCED:     the terminal predicate of `dueForAnnouncement`, older than the grace.
 *
 * The outbox reads use the tenant's partial unpublished index. No payload and no actor
 * column is selected.
 *
 * Each pair — a count and the sample drawn from the same predicate — is read inside ONE
 * `REPEATABLE READ, READ ONLY` transaction, so the two are one observation. Read statement by
 * statement, a message the relay published or failed between them could produce `failing > 0`
 * beside an empty sample, or a sample under a zero count: a diagnostic that contradicts itself.
 * (Codex review of #81.)
 */
const SNAPSHOT = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;

export class DrizzleDiagnosticsReader implements DiagnosticsReader {
  constructor(private readonly db: Database) {}

  async outbox(scope: TenantContext, sampleSize: number): Promise<OutboxDiagnostics> {
    return this.db.transaction((q) => this.readOutbox(q, scope, sampleSize), SNAPSHOT);
  }

  private async readOutbox(
    q: Executor,
    scope: TenantContext,
    sampleSize: number,
  ): Promise<OutboxDiagnostics> {
    const tenantId = requireTenantId(scope);
    const totals = await q.execute<{
      pending: string;
      failing: string;
      exhausted: string;
      oldest: Date | string | null;
    }>(sql`
      SELECT count(*)::text AS pending,
             count(*) FILTER (WHERE attempts > 0)::text AS failing,
             count(*) FILTER (WHERE exhausted_at IS NOT NULL)::text AS exhausted,
             min(occurred_at) AS oldest
        FROM outbox_messages
       WHERE tenant_id = ${tenantId} AND published_at IS NULL`);
    const sample = await q.execute<{
      id: string;
      event_type: string;
      aggregate_type: string;
      attempts: number;
      occurred_at: Date | string;
      last_error: string | null;
      next_attempt_at: Date | string | null;
      exhausted_at: Date | string | null;
    }>(sql`
      SELECT id, event_type, aggregate_type, attempts, occurred_at, last_error, next_attempt_at,
             exhausted_at
        FROM outbox_messages
       WHERE tenant_id = ${tenantId} AND published_at IS NULL AND attempts > 0
       ORDER BY occurred_at, sequence
       LIMIT ${sampleSize}`);
    const row = totals.rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      failing: Number(row?.failing ?? 0),
      exhausted: Number(row?.exhausted ?? 0),
      oldestPendingAt: row?.oldest == null ? null : new Date(row.oldest),
      failingSample: sample.rows.map((one) => ({
        id: one.id,
        eventType: one.event_type,
        aggregateType: one.aggregate_type,
        attempts: Number(one.attempts),
        occurredAt: new Date(one.occurred_at),
        lastError: one.last_error,
        nextAttemptAt: one.next_attempt_at == null ? null : new Date(one.next_attempt_at),
        exhausted: one.exhausted_at != null,
      })),
    };
  }

  async provisioning(
    scope: TenantContext,
    now: Date,
    unannouncedBefore: Date,
    sampleSize: number,
  ): Promise<ProvisioningDiagnostics> {
    return this.db.transaction(
      (q) => this.readProvisioning(q, scope, now, unannouncedBefore, sampleSize),
      SNAPSHOT,
    );
  }

  private async readProvisioning(
    q: Executor,
    scope: TenantContext,
    now: Date,
    unannouncedBefore: Date,
    sampleSize: number,
  ): Promise<ProvisioningDiagnostics> {
    const tenantId = requireTenantId(scope);
    const nowIso = now.toISOString();
    const beforeIso = unannouncedBefore.toISOString();
    /*
     * One CASE, so an operation is counted under exactly one reason and the four
     * predicates cannot overlap: the states they read are disjoint (UNKNOWN,
     * IN_FLIGHT, PLANNED, terminal).
     */
    const reasoned = sql`
      SELECT id, service_id, type, state, attempts, next_attempt_at, created_at, updated_at,
             CASE
               WHEN state = 'UNKNOWN' THEN 'UNKNOWN_OUTCOME'
               WHEN state = 'IN_FLIGHT' AND lease_until < ${nowIso}::timestamptz THEN 'LEASE_EXPIRED'
               WHEN state = 'PLANNED' AND attempts > 0 THEN 'RETRYING'
               WHEN announced_at IS NULL
                AND completed_at < ${beforeIso}::timestamptz
                AND (state IN ('SUCCEEDED', 'ABANDONED')
                     OR (state = 'FAILED' AND next_attempt_at IS NULL)) THEN 'UNANNOUNCED'
             END AS reason
        FROM provisioning_operations
       WHERE tenant_id = ${tenantId}
         AND (state = 'UNKNOWN'
              OR (state = 'IN_FLIGHT' AND lease_until < ${nowIso}::timestamptz)
              OR (state = 'PLANNED' AND attempts > 0)
              OR (announced_at IS NULL
                  AND completed_at < ${beforeIso}::timestamptz
                  AND (state IN ('SUCCEEDED', 'ABANDONED')
                       OR (state = 'FAILED' AND next_attempt_at IS NULL))))`;
    const counts = await q.execute<{ reason: StuckOperationReason; n: string }>(sql`
      SELECT reason, count(*)::text AS n FROM (${reasoned}) stuck GROUP BY reason`);
    const sample = await q.execute<{
      id: string;
      service_id: string;
      type: OperationType;
      state: OperationState;
      attempts: number;
      next_attempt_at: Date | string | null;
      created_at: Date | string;
      updated_at: Date | string;
      reason: StuckOperationReason;
    }>(sql`SELECT * FROM (${reasoned}) stuck ORDER BY updated_at, id LIMIT ${sampleSize}`);

    const byReason: Record<StuckOperationReason, number> = {
      UNKNOWN_OUTCOME: 0,
      LEASE_EXPIRED: 0,
      RETRYING: 0,
      UNANNOUNCED: 0,
    };
    for (const row of counts.rows) byReason[row.reason] = Number(row.n);
    return {
      counts: byReason,
      sample: sample.rows.map((row) => ({
        operationId: row.id,
        serviceId: row.service_id,
        type: row.type,
        state: row.state,
        reason: row.reason,
        attempts: Number(row.attempts),
        nextAttemptAt: row.next_attempt_at === null ? null : new Date(row.next_attempt_at),
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      })),
    };
  }
}
