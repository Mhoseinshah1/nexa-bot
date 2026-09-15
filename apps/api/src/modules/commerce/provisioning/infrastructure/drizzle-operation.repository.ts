import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { isMutatingOperation, OPERATION_MAX_ATTEMPTS, OPERATION_TYPES } from '@nexa/contracts';
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
import { provisioningOperations, services } from '../../../../infrastructure/persistence/schema.js';
import type { OperationDraft, OperationRecord, OperationRepository } from '../application/ports.js';

/** Local alias so the predicate below reads as the rule rather than as a constant. */
const MAX_ATTEMPTS = OPERATION_MAX_ATTEMPTS;

/**
 * The operation types that change nothing on the provider, DERIVED from the contract.
 *
 * Listed by asking `isMutatingOperation` rather than by writing the two names out,
 * because a hand-written copy is a second definition that the next operation type
 * silently falsifies — and the direction it fails in is the expensive one: a new
 * mutating type omitted from a hardcoded list would be treated as a read, and a read
 * whose answer was lost is resolved by retrying it.
 */
const NON_MUTATING_TYPES: readonly OperationType[] = OPERATION_TYPES.filter(
  (type) => !isMutatingOperation(type),
);

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
        /*
         * Due NOW, stamped rather than left null.
         *
         * "Not yet attempted" used to be an ABSENCE, and an absence has no position in
         * an ordering: PostgreSQL's `ASC` is NULLS LAST, so a customer who had just
         * paid sorted behind every backed-off retry that had come due. Writing the time
         * makes the claim a plain FIFO over one comparable column, lets
         * `provisioning_operations_due_idx` serve the ordering exactly, and makes the
         * operations view able to say when a row became due without a special case.
         *
         * The `IS NULL` arm of the due predicate and the explicit `NULLS FIRST` in the
         * ordering both stay. Nothing writes a null here any more, and neither of them
         * costs anything — but an ordering that is only correct because of what happens
         * to be in the column is the kind of claim that rots quietly.
         */
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    const inserted = rows[0];
    if (inserted !== undefined) return toRecord(inserted);

    const existing =
      (await this.findByOperationId(scope, draft.operationId, tx)) ??
      /*
       * The OTHER unique index this insert can lose on.
       *
       * `provisioning_operations_open_provision_key` admits one open PROVISION per
       * service, so a second retry carrying a different idempotency key conflicts here
       * rather than on the derived id — and the read-back above finds nothing. Returning
       * the operation that won is the same answer for the same reason: the caller cannot
       * tell whether it or somebody else planned the attempt, and does not need to.
       */
      (await this.findOpen(scope, draft.serviceId, draft.type, tx));
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

  async findOpen(
    scope: TenantContext,
    serviceId: string,
    type: OperationType,
    tx?: unknown,
  ): Promise<OperationRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(provisioningOperations)
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.serviceId, serviceId),
          eq(provisioningOperations.type, type),
          inArray(provisioningOperations.state, ['PLANNED', 'IN_FLIGHT']),
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
    tx: TransactionScope,
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
      /*
       * NULLS FIRST, explicitly, because PostgreSQL's ASC default is NULLS LAST.
       *
       * `plan` never sets `next_attempt_at`, so a freshly planned operation — a
       * customer who has just paid and is waiting — carries NULL. Under the default it
       * sorted BEHIND every backed-off retry that had come due, which is the exact
       * inversion the leading column exists to prevent: a backlog of failing operations
       * delayed every new order by a tick per ten of them.
       */
      .orderBy(
        sql`${provisioningOperations.nextAttemptAt} ASC NULLS FIRST`,
        asc(provisioningOperations.createdAt),
      )
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
   * Stamps `call_started_at`, in a transaction of its own.
   *
   * The transaction must be the caller's OWN and must hold nothing else. Committing
   * this alongside the RESULT would mean a crash rolled it back, which is precisely
   * the case it exists to record: this column is the one fact that distinguishes "a
   * worker died before calling the provider" from "a worker died during the call", and
   * therefore the one fact that decides whether a lease expiry may safely hand the row
   * to somebody else.
   *
   * It used to take no transaction at all and write on the pool. That put it outside
   * `DrizzleUnitOfWork.run`, and therefore outside ADR-0028's quiesce gate — so a
   * restore found the provisioner still stamping rows in the database it was replacing.
   *
   * ## Why it is fenced on the LEASE and not just on the id
   *
   * It matched on the id and a null stamp alone, and that is not enough, because the
   * window between the claim and this statement is exactly the window a lease can
   * expire in. A worker that stalled past its lease — a long GC pause, a frozen
   * container, a slow database — is released by another replica's
   * `releaseExpiredLeases` (legal: nothing was stamped yet) and the operation is
   * claimed by a second worker. The stalled worker then wakes and stamps, because the
   * row still has no `call_started_at` and its id has not changed; the second worker's
   * own stamp then finds one and quietly does nothing. BOTH then call the provider.
   *
   * Two concurrent creates for one paid order is the single thing this phase exists to
   * prevent, so the stamp now asserts the whole claim: still `IN_FLIGHT`, still THIS
   * worker's, and the lease still in the future. It RETURNS whether it stamped, and the
   * executor makes no provider call when it did not — a refusal costs a tick, where
   * proceeding costs a customer a duplicate account.
   *
   * An expired-but-unreclaimed lease is refused too, deliberately. The row is about to
   * be released by the next sweep, so aborting hands it back cleanly; calling anyway
   * would race that sweep for the same outcome.
   */
  async markCallStarted(
    scope: TenantContext,
    id: string,
    worker: string,
    at: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(provisioningOperations)
      .set({ callStartedAt: at, updatedAt: at })
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.id, id),
          eq(provisioningOperations.state, 'IN_FLIGHT'),
          eq(provisioningOperations.claimedBy, worker),
          sql`${provisioningOperations.leaseUntil} > ${at}`,
          isNull(provisioningOperations.callStartedAt),
        ),
      )
      .returning({ id: provisioningOperations.id });
    return rows.length > 0;
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
        /*
         * A row that is no longer in flight holds no claim, and a row going BACK to
         * `PLANNED` has no call in progress. The first because
         * `provisioning_operations_claim_check` requires it; the third because
         * `call_started_at` is the fact that decides whether a lease expiry may
         * release this row, and a stale one disables that decision for ever.
         *
         * Without this, a first attempt that reached the wire and came back retryable
         * left `call_started_at` set. The row went back to PLANNED, was claimed again,
         * and if THAT process died before calling anything the lease sweep refused to
         * release it — `releaseExpiredLeases` requires `call_started_at IS NULL` — so
         * the operation stayed IN_FLIGHT for ever with no operational event and a
         * service stuck in PENDING_PROVISION. It is the one failure in this module
         * that had no operator signal at all.
         *
         * `markCallStarted` only writes when the column is null, so clearing it here
         * is what lets the next attempt stamp its own.
         */
        ...(to === 'IN_FLIGHT' ? {} : { claimedBy: null, leaseUntil: null }),
        // Cleared on the way back to PLANNED ONLY. A terminal row keeps the fact that a
        // call was made — history an operator reads, and the lease sweep never looks at
        // a terminal row.
        ...(to === 'PLANNED' ? { callStartedAt: null } : {}),
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
   * Puts a claimed operation back and refunds the attempt the claim counted.
   *
   * `attempts - 1` in SQL rather than from a value the caller read, for the same
   * reason `recordDelivery` advances its counter that way: two workers that both read
   * `3` and both wrote `2` would leave an operation one attempt richer than it earned.
   *
   * `GREATEST(…, 0)` because `provisioning_operations_attempts_check` requires a
   * non-negative count, and a hold-off on a row whose attempts somehow read zero must
   * not be refused by the database — it would abort the transaction that was trying to
   * put the row back, and leave it IN_FLIGHT holding a lease for nothing.
   */
  async holdOff(
    scope: TenantContext,
    id: string,
    retryAt: Date,
    note: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(provisioningOperations)
      .set({
        state: 'PLANNED',
        attempts: sql`GREATEST(${provisioningOperations.attempts} - 1, 0)`,
        nextAttemptAt: retryAt,
        failureMessage: note,
        claimedBy: null,
        leaseUntil: null,
        callStartedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.id, id),
          eq(provisioningOperations.state, 'IN_FLIGHT'),
        ),
      )
      .returning({ id: provisioningOperations.id });
    return rows.length > 0;
  }

  /**
   * Fails `PLANNED` operations whose attempts are spent, and returns them.
   *
   * A conditional UPDATE with the ceiling written out, which is the only way a row
   * that `claimDue` can no longer select ever reaches a terminal state. Bounded by the
   * caller, and `RETURNING` the rows so the operational event can name the service.
   */
  async retireExhausted(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly OperationRecord[]> {
    const tenantId = requireTenantId(scope);
    const spent = this.exec(tx)
      .select({ id: provisioningOperations.id })
      .from(provisioningOperations)
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.state, 'PLANNED'),
          sql`${provisioningOperations.attempts} >= ${MAX_ATTEMPTS}`,
        ),
      )
      .limit(limit);

    const rows = await this.exec(tx)
      .update(provisioningOperations)
      .set({
        state: 'FAILED',
        completedAt: now,
        claimedBy: null,
        leaseUntil: null,
        failureMessage: 'the attempts were spent and no worker reported an outcome',
        nextAttemptAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.state, 'PLANNED'),
          sql`${provisioningOperations.id} IN ${spent}`,
        ),
      )
      .returning();
    return rows.map(toRecord);
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
  async releaseExpiredLeases(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const expired = this.exec(tx)
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

    const rows = await this.exec(tx)
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

  /**
   * The operations a crash stranded MID-CALL, moved off `IN_FLIGHT` for good.
   *
   * The other half of `releaseExpiredLeases`, and the half that was missing. That sweep
   * deliberately refuses a row whose `call_started_at` is set, because handing it to
   * another worker would repeat a mutation that may have taken effect. Its comment then
   * said such a row is "left `IN_FLIGHT` for ever until a person or the reconciler deals
   * with it" — and neither had a path to it. The reconciler scans `UNKNOWN`;
   * `retireExhausted` scans `PLANNED`; `retryProvisioning` finds the open operation and
   * hands it back unchanged. So a process that died between stamping and answering left
   * a paid order in `PENDING_PROVISION` for ever, with no operator condition anywhere.
   *
   * This is the transition that ends it, and it is `UNKNOWN` rather than `PLANNED`
   * precisely because the call may have landed: `UNKNOWN` is the state whose only exit
   * is a READ, which is what `listUnknown` and `planReconciles` already implement. The
   * stranded row therefore joins the queue that was built for exactly this question.
   *
   * A NON-mutating operation goes to `FAILED` instead, for the reason `failureOutcome`
   * gives: a read that did not answer changed nothing, so there is nothing to reconcile
   * and a fresh one is simply planned. The split is derived from the contract, never
   * restated here.
   *
   * Conditional and bounded like every other sweep in this file, so two replicas racing
   * it produce one winner per row and a long backlog does not become one long
   * transaction.
   */
  async reapStrandedCalls(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly OperationRecord[]> {
    const tenantId = requireTenantId(scope);
    const stranded = this.exec(tx)
      .select({ id: provisioningOperations.id })
      .from(provisioningOperations)
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.state, 'IN_FLIGHT'),
          lte(provisioningOperations.leaseUntil, now),
          sql`${provisioningOperations.callStartedAt} IS NOT NULL`,
        ),
      )
      .limit(limit);

    /*
     * One branch, used twice, because the two columns are bound by a CHECK.
     *
     * `provisioning_operations_completed_check` says terminal states carry a completion
     * time and live ones do not. `FAILED` is terminal and `UNKNOWN` is not, so stamping
     * `completed_at` on every reaped row made the whole statement fail — which is the
     * database refusing to store the contradiction rather than the code noticing it.
     */
    const isRead = inArray(provisioningOperations.type, NON_MUTATING_TYPES);
    const rows = await this.exec(tx)
      .update(provisioningOperations)
      .set({
        state: sql`CASE WHEN ${isRead} THEN 'FAILED' ELSE 'UNKNOWN' END`,
        claimedBy: null,
        leaseUntil: null,
        failureMessage: 'the worker holding this operation died after the provider call began',
        /*
         * Cast explicitly, because a raw `sql` template has no column to borrow a type
         * from. Drizzle types a plain `completedAt: now` from the schema; inside a CASE
         * it is just a parameter, and with `NULL` in the other branch PostgreSQL has
         * nothing to infer from and refuses to plan the statement at all.
         */
        completedAt: sql`CASE WHEN ${isRead} THEN ${now.toISOString()}::timestamptz ELSE NULL END`,
        updatedAt: now,
      })
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.state, 'IN_FLIGHT'),
          lte(provisioningOperations.leaseUntil, now),
          sql`${provisioningOperations.callStartedAt} IS NOT NULL`,
          sql`${provisioningOperations.id} IN ${stranded}`,
        ),
      )
      .returning();
    return rows.map(toRecord);
  }

  /**
   * Resolves a service's outstanding `UNKNOWN` operations, once a read has answered.
   *
   * `OPERATION_MACHINE` has carried `UNKNOWN -> SUCCEEDED on RECONCILE_SUCCEEDED` and
   * `UNKNOWN -> FAILED on RECONCILE_FAILED` since the machine was written, both guarded
   * by `providerStateRead`, and until now NOTHING used either edge. That was the defect:
   * `UNKNOWN` had no exit, so a reconcile resolved the SERVICE and left the operation
   * that lost track sitting in the queue for ever.
   *
   * What that costs is not cosmetic. `listUnknown` is ordered oldest-first and filtered
   * on the service being `UNRECONCILED` — which is true again the moment a SECOND create
   * loses track. The sweep then returns the FIRST, already-reconciled operation;
   * `planReconciles` derives its reconcile id from that row, finds the terminal reconcile
   * that already ran, and plans nothing. The service stays `UNRECONCILED` with no open
   * work, for ever, and `SERVICE_PROVISION_CYCLE_LIMIT` is never reached because the
   * cycle stops dead in round two.
   *
   * Every outstanding unknown for the service, not just the one this reconcile was
   * derived from, because the fact a read established is about the SERVICE. On ABSENT
   * that is exact: the panel does not have the account, so no create took effect and
   * each is `FAILED`. On ADOPT the read cannot attribute WHICH create made the account,
   * and `SUCCEEDED` for all of them is the honest reading of "the thing they were each
   * trying to achieve is true" — the alternative, leaving the others `UNKNOWN`, is the
   * bug above.
   */
  async resolveUnknownForService(
    scope: TenantContext,
    serviceId: string,
    to: Extract<OperationState, 'SUCCEEDED' | 'FAILED'>,
    now: Date,
    tx: TransactionScope,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(provisioningOperations)
      .set({ state: to, completedAt: now, updatedAt: now })
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.serviceId, serviceId),
          eq(provisioningOperations.state, 'UNKNOWN'),
        ),
      )
      .returning({ id: provisioningOperations.id });
    return rows.length;
  }

  /**
   * The operations whose outcome is unknown AND whose service is still waiting.
   *
   * Three conditions, and each removes a way this queue would starve or spin:
   *
   * - `state = 'UNKNOWN'` — the operation whose answer was lost;
   * - the service is still `UNRECONCILED` — so a row whose reconcile already ran drops
   *   out on its own, without anything having to rewrite the historical operation;
   * - no open `RECONCILE` for that service — so a tick does not re-plan one that is
   *   already planned or in flight.
   *
   * The last two are in the QUERY rather than checked afterwards. `UNKNOWN` is not a
   * terminal state and nothing clears it, so the pile of resolved ones grows for ever;
   * filtering them in the caller would let them fill the limit window and starve the
   * service that is actually waiting — which is the one failure this queue exists to
   * end.
   */
  async listUnknown(
    scope: TenantContext,
    limit: number,
    tx?: unknown,
  ): Promise<readonly OperationRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ operation: provisioningOperations })
      .from(provisioningOperations)
      .innerJoin(
        services,
        and(
          eq(services.tenantId, provisioningOperations.tenantId),
          eq(services.id, provisioningOperations.serviceId),
        ),
      )
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.state, 'UNKNOWN'),
          eq(services.state, 'UNRECONCILED'),
          sql`NOT EXISTS (
            SELECT 1 FROM ${provisioningOperations} AS open_reconcile
             WHERE open_reconcile.tenant_id = ${provisioningOperations.tenantId}
               AND open_reconcile.service_id = ${provisioningOperations.serviceId}
               AND open_reconcile.type = 'RECONCILE'
               AND open_reconcile.state IN ('PLANNED', 'IN_FLIGHT'))`,
        ),
      )
      .orderBy(asc(provisioningOperations.createdAt), asc(provisioningOperations.id))
      .limit(limit);
    return rows.map((row) => toRecord(row.operation));
  }
}
