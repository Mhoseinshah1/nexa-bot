import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { OPERATION_MAX_ATTEMPTS } from '@nexa/contracts';
import type {
  OperationId,
  OperationState,
  OperationType,
  OrderId,
  PanelId,
  ProviderFailureKind,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { provisioningOperations } from '../../../../infrastructure/persistence/schema.js';
import type { OperationDraft, OperationRecord, OperationRepository } from '../application/ports.js';

/** Local alias so the predicate below reads as the rule rather than as a constant. */
const MAX_ATTEMPTS = OPERATION_MAX_ATTEMPTS;

type Row = typeof provisioningOperations.$inferSelect;

function toRecord(row: Row): OperationRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    operationId: row.operationId as OperationId,
    serviceId: row.serviceId,
    orderId: row.orderId as OrderId | null,
    panelId: row.panelId as PanelId,
    type: row.type as OperationType,
    state: row.state as OperationState,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    claimedBy: row.claimedBy,
    leaseUntil: row.leaseUntil,
    callStartedAt: row.callStartedAt,
    providerReference: row.providerReference,
    failureKind: row.failureKind as ProviderFailureKind | null,
    failureMessage: row.failureMessage,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Provisioning operations, in PostgreSQL.
 *
 * Three statements here carry the whole concurrency design, and none of them takes a
 * lock: `plan` is an upsert on the derived id, `claimDue` is a conditional UPDATE over
 * one row, and `releaseExpiredLeases` is a conditional UPDATE with the machine's guard
 * written out as a WHERE clause. Two replicas are the normal case on every rolling
 * update, and the correctness does not depend on there being one.
 */
export class DrizzleOperationRepository implements OperationRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  /**
   * Plans an operation, or returns the one that already carries this derived id.
   *
   * `ON CONFLICT DO NOTHING` on `(tenant_id, operation_id)` and a read-back when it
   * fired. Returning the EXISTING row rather than throwing is what makes a retried
   * command idempotent at the only place it can be: the caller cannot tell whether it
   * or somebody else planned the operation, and does not need to.
   */
  async plan(
    scope: TenantContext,
    draft: OperationDraft,
    now: Date,
    tx: TransactionScope,
  ): Promise<OperationRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(provisioningOperations)
      .values({
        id: draft.id,
        tenantId,
        operationId: draft.operationId,
        serviceId: draft.serviceId,
        orderId: draft.orderId,
        panelId: draft.panelId,
        type: draft.type,
        state: 'PLANNED',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    const inserted = rows[0];
    if (inserted !== undefined) return toRecord(inserted);

    const existing = await this.findByOperationId(scope, draft.operationId, tx);
    if (existing === null) {
      /*
       * The insert conflicted and the row is not there.
       *
       * Unreachable inside one transaction, and refused rather than retried: the only
       * ways to get here are a conflict on a DIFFERENT constraint — which would mean
       * the primary key collided, so a caller reused an id — or a concurrent delete,
       * and `provisioning_operations` has no delete path. Silently planning again
       * would be the one outcome that could produce a second provider call.
       */
      throw new Error(
        `operation ${draft.operationId} conflicted on insert but does not exist; the id was reused`,
      );
    }
    return existing;
  }

  async findById(scope: TenantContext, id: string, tx?: unknown): Promise<OperationRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(provisioningOperations)
      .where(and(eq(provisioningOperations.tenantId, tenantId), eq(provisioningOperations.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findByOperationId(
    scope: TenantContext,
    operationId: OperationId,
    tx?: unknown,
  ): Promise<OperationRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(provisioningOperations)
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.operationId, operationId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async listForService(
    scope: TenantContext,
    serviceId: string,
    limit: number,
    tx?: unknown,
  ): Promise<readonly OperationRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(provisioningOperations)
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.serviceId, serviceId),
        ),
      )
      .orderBy(asc(provisioningOperations.createdAt), asc(provisioningOperations.id))
      .limit(limit);
    return rows.map(toRecord);
  }

  /**
   * Takes one due operation for this worker, or reports there is none.
   *
   * The claim and the attempt increment are ONE statement, and that is not an
   * optimisation. A claim that did not count its attempt is a claim that can be
   * retried for ever — the ceiling would never be reached, and a permanently failing
   * operation would dial somebody's panel until an operator noticed.
   *
   * The row is chosen by a sub-select ordered by the due index and re-checked in the
   * WHERE clause, so two replicas racing the same candidate produce one winner: the
   * loser's `state = 'PLANNED'` predicate no longer holds. No `FOR UPDATE SKIP LOCKED`
   * and no advisory lock, for the reason CLAUDE.md gives about the monitor — nothing
   * about a claim is decided in a process.
   *
   * `attempts < OPERATION_MAX_ATTEMPTS` is in the predicate rather than checked after,
   * so an exhausted operation is not claimed at all. Checking afterwards would consume
   * a claim to discover the claim was not allowed.
   */
  async claimDue(
    scope: TenantContext,
    worker: string,
    now: Date,
    leaseUntil: Date,
    tx?: unknown,
  ): Promise<OperationRecord | null> {
    const tenantId = requireTenantId(scope);
    const due = this.exec(tx)
      .select({ id: provisioningOperations.id })
      .from(provisioningOperations)
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.state, 'PLANNED'),
          sql`${provisioningOperations.attempts} < ${MAX_ATTEMPTS}`,
          or(
            isNull(provisioningOperations.nextAttemptAt),
            lte(provisioningOperations.nextAttemptAt, now),
          ),
        ),
      )
      .orderBy(asc(provisioningOperations.nextAttemptAt), asc(provisioningOperations.createdAt))
      .limit(1);

    const rows = await this.exec(tx)
      .update(provisioningOperations)
      .set({
        state: 'IN_FLIGHT',
        claimedBy: worker,
        leaseUntil,
        attempts: sql`${provisioningOperations.attempts} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.state, 'PLANNED'),
          sql`${provisioningOperations.id} IN ${due}`,
        ),
      )
      .returning();
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /**
   * Stamps `call_started_at`, on its own connection and its own transaction.
   *
   * Takes no transaction argument DELIBERATELY. Committing this inside the caller's
   * transaction would mean a crash rolled it back, which is precisely the case it
   * exists to record: this column is the one fact that distinguishes "a worker died
   * before calling the provider" from "a worker died during the call", and therefore
   * the one fact that decides whether a lease expiry may safely hand the row to
   * somebody else.
   */
  async markCallStarted(scope: TenantContext, id: string, at: Date): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.db
      .update(provisioningOperations)
      .set({ callStartedAt: at, updatedAt: at })
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.id, id),
          isNull(provisioningOperations.callStartedAt),
        ),
      );
  }

  async transition(
    scope: TenantContext,
    id: string,
    from: OperationState,
    to: OperationState,
    result: {
      readonly providerReference?: string | null;
      readonly failureKind?: ProviderFailureKind | null;
      readonly failureMessage?: string | null;
      readonly nextAttemptAt?: Date | null;
      readonly completedAt?: Date | null;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const terminal = to === 'SUCCEEDED' || to === 'FAILED' || to === 'ABANDONED';
    const rows = await this.exec(tx)
      .update(provisioningOperations)
      .set({
        state: to,
        ...(result.providerReference === undefined
          ? {}
          : { providerReference: result.providerReference }),
        ...(result.failureKind === undefined ? {} : { failureKind: result.failureKind }),
        ...(result.failureMessage === undefined ? {} : { failureMessage: result.failureMessage }),
        ...(result.nextAttemptAt === undefined ? {} : { nextAttemptAt: result.nextAttemptAt }),
        /*
         * `provisioning_operations_completed_check` binds the terminal states to this
         * stamp, so it is written by the same statement rather than left to a caller.
         * A non-terminal state clears it for the same reason: a RELEASE back to
         * PLANNED from a row that somehow carried one would be refused by the check.
         */
        completedAt: terminal ? (result.completedAt ?? now) : null,
        // A row that is no longer in flight holds no claim. Both together, because
        // `provisioning_operations_claim_check` requires it.
        ...(to === 'IN_FLIGHT' ? {} : { claimedBy: null, leaseUntil: null }),
        updatedAt: now,
      })
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.id, id),
          eq(provisioningOperations.state, from),
        ),
      )
      .returning({ id: provisioningOperations.id });
    return rows.length > 0;
  }

  /**
   * Returns expired leases to `PLANNED`, but only where no provider call was started.
   *
   * `leaseExpiredAndCallNeverStarted`, the guard `OPERATION_MACHINE` names, written as
   * a WHERE clause — which is the only place it can be enforced, because the decision
   * has to be made against the row rather than against what a process remembers.
   *
   * A row whose `call_started_at` is set is deliberately left `IN_FLIGHT` for ever
   * until a person or the reconciler deals with it. Handing it to another worker would
   * repeat a mutation that may have taken effect; leaving it is what makes the
   * situation visible and recoverable.
   *
   * Tenant-scoped like everything else, and NOT global: a sweep that crossed tenants
   * would be the one query in this file that could return another tenant's row.
   */
  async releaseExpiredLeases(scope: TenantContext, now: Date, limit: number): Promise<number> {
    const tenantId = requireTenantId(scope);
    const expired = this.db
      .select({ id: provisioningOperations.id })
      .from(provisioningOperations)
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.state, 'IN_FLIGHT'),
          lte(provisioningOperations.leaseUntil, now),
          isNull(provisioningOperations.callStartedAt),
        ),
      )
      .limit(limit);

    const rows = await this.db
      .update(provisioningOperations)
      .set({ state: 'PLANNED', claimedBy: null, leaseUntil: null, updatedAt: now })
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.state, 'IN_FLIGHT'),
          isNull(provisioningOperations.callStartedAt),
          sql`${provisioningOperations.id} IN ${expired}`,
        ),
      )
      .returning({ id: provisioningOperations.id });
    return rows.length;
  }

  async listUnknown(
    scope: TenantContext,
    limit: number,
    tx?: unknown,
  ): Promise<readonly OperationRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(provisioningOperations)
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.state, 'UNKNOWN'),
        ),
      )
      .orderBy(asc(provisioningOperations.createdAt), asc(provisioningOperations.id))
      .limit(limit);
    return rows.map(toRecord);
  }
}
