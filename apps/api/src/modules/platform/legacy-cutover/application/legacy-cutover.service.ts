import {
  LEGACY_CUTOVER_AUDIT_ACTIONS,
  LEGACY_CUTOVER_ERROR_CODES,
  LEGACY_CUTOVER_PAGE_MAX,
  LEGACY_CUTOVER_READ_SET_FIELDS,
  LEGACY_CUTOVER_SUPERSEDING_RUN_STATUSES,
  errors,
  legacyCutoverApproveRequestSchema,
  legacyCutoverRevokeRequestSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type LegacyCutoverListQuery,
  type LegacyReadSetName,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../access/application/authorized-mutation.js';
import { rememberOnce } from '../../idempotency/application/remember-once.js';
import { hashRequest } from '../../idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../identity/application/ports.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  bindingMatches,
  decideCutoverImport,
  type CutoverDecision,
  type CutoverExpectation,
} from '../domain/cutover-rules.js';
import type {
  LegacyCutoverApplyOutcome,
  LegacyCutoverApplyRunRecord,
  LegacyCutoverApprovalRecord,
  LegacyCutoverArchiveFacts,
  LegacyCutoverDuplicateFacts,
  LegacyCutoverProductRow,
  LegacyCutoverReadSetRecord,
  LegacyCutoverRepository,
  LegacyCutoverStopSalesFacts,
} from './ports.js';

export const LEGACY_CUTOVER_VIEW_PERMISSION = 'legacy.cutover.view' satisfies PermissionKey;
export const LEGACY_CUTOVER_APPROVE_PERMISSION = 'legacy.cutover.approve' satisfies PermissionKey;

const ENTITY = 'LegacyCutoverApproval';

export interface LegacyCutoverServiceDeps {
  readonly repository: LegacyCutoverRepository;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** What the final report v2 and the cutover gate read about one source. Read only. */
export interface LegacyCutoverReportFacts {
  readonly approvals: readonly LegacyCutoverApprovalRecord[];
  readonly applyRuns: readonly LegacyCutoverApplyRunRecord[];
  readonly readSets: Readonly<Record<LegacyReadSetName, LegacyCutoverReadSetRecord | null>>;
  readonly productRows: readonly LegacyCutoverProductRow[];
  readonly archive: LegacyCutoverArchiveFacts | null;
  readonly duplicates: LegacyCutoverDuplicateFacts;
  /** The reported run's recorded leftovers; null when none was recorded. */
  readonly applyOutcome: LegacyCutoverApplyOutcome | null;
  /** The CUTOVER approval the reported run started under (its start audit); null if none. */
  readonly runCutoverApprovalId: string | null;
}

/**
 * Mirza migration PR6 — the owner's cutover approval (owner constraint 3; audit §6.2).
 *
 * Two audiences, deliberately apart:
 *
 * - the Web Admin (`legacy.cutover.view` to list; `legacy.cutover.approve`, CRITICAL, to
 *   record or revoke). The authenticated owner records an approval bound to seven exact
 *   values; it is checked against what was RECORDED (each read set's observation of that
 *   same source must exist, and agree on its evidence class), audited — DENIED too — and
 *   replayed with its original answer under the same idempotency key.
 * - the importer, which calls `decideImport` INSIDE its own start transaction (charged to
 *   `maintenance.run` there) and refuses before any write unless an unrevoked approval
 *   matches every value it was given and no earlier source is superseded unacknowledged.
 *
 * Nothing here imports, adopts, writes a ledger entry or calls a provider.
 */
export class LegacyCutoverService {
  constructor(private readonly deps: LegacyCutoverServiceDeps) {}

  // --- reads (legacy.cutover.view) -------------------------------------------------------

  async listApprovals(scope: TenantContext, actor: ActorContext, query: LegacyCutoverListQuery) {
    await this.deps.guard.check(scope, actor, LEGACY_CUTOVER_VIEW_PERMISSION);
    const limit = query.limit ?? LEGACY_CUTOVER_PAGE_MAX;
    const rows = await this.deps.repository.listApprovals(scope, {
      ...(query.after === undefined ? {} : { after: query.after }),
      limit: limit + 1,
    });
    return page(rows, limit);
  }

  async listReadSets(scope: TenantContext, actor: ActorContext, query: LegacyCutoverListQuery) {
    await this.deps.guard.check(scope, actor, LEGACY_CUTOVER_VIEW_PERMISSION);
    const limit = query.limit ?? LEGACY_CUTOVER_PAGE_MAX;
    const rows = await this.deps.repository.listReadSetRuns(scope, {
      ...(query.after === undefined ? {} : { after: query.after }),
      limit: limit + 1,
    });
    return page(rows, limit);
  }

  async listApplyRuns(scope: TenantContext, actor: ActorContext, query: LegacyCutoverListQuery) {
    await this.deps.guard.check(scope, actor, LEGACY_CUTOVER_VIEW_PERMISSION);
    const limit = query.limit ?? LEGACY_CUTOVER_PAGE_MAX;
    const rows = await this.deps.repository.listApplyRuns(scope, {
      ...(query.after === undefined ? {} : { after: query.after }),
      limit: limit + 1,
    });
    return page(rows, limit);
  }

  // --- decisions (legacy.cutover.approve) ------------------------------------------------

  /**
   * Records one approval. Refused unless each named read set fingerprint is RECORDED in
   * `legacy_read_set_runs` against that same source, the three agree on their evidence class
   * (which the approval keeps), a re-run acknowledgement names a prior source this tenant has
   * a finished import of, and no identical unrevoked approval exists.
   */
  async approve(
    scope: TenantContext,
    actor: ActorContext,
    body: unknown,
  ): Promise<LegacyCutoverApprovalRecord> {
    const action = LEGACY_CUTOVER_AUDIT_ACTIONS.approve;
    // The permission FIRST: a caller without it is audited DENIED and learns nothing about
    // what a valid body looks like (the other audited services do the same).
    await this.requireApprove(scope, actor, action, null);
    const command = legacyCutoverApproveRequestSchema.parse(body);
    const { idempotencyKey, ...request } = command;
    const requestHash = hashRequest({ action, ...request });
    // The ORIGINAL answer, exactly as first returned — never the approval as it stands now,
    // which a revocation may have changed since.
    const replay = () =>
      this.deps.idempotency.find<StoredApproval>(scope, actor.surface, idempotencyKey, requestHash);
    const found = await replay();
    if (found !== null) return reviveApproval(found.result);

    const id = this.deps.ids.uuid();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      LEGACY_CUTOVER_APPROVE_PERMISSION,
      { action, entityType: ENTITY, entityId: id },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.deps.repository.lockTenantApprovals(scope, tx);
        // Asked again UNDER the lock: a concurrent request with this key that committed while
        // this one waited is a replay, and gets its stored answer — not ALREADY_APPROVED.
        const committed = await replay();
        if (committed !== null) return reviveApproval(committed.result);
        const binding = {
          sourceFingerprint: command.sourceFingerprint,
          panelMapFingerprint: command.panelMapFingerprint,
          inventoryFingerprint: command.inventoryFingerprint,
          productsFingerprint: command.productsFingerprint,
          invoiceArchiveFingerprint: command.invoiceArchiveFingerprint,
          freezeProofSha256: command.freezeProofSha256,
          finalDumpSha256: command.finalDumpSha256,
        };
        // Each read set the approval names must be an observation NEXA recorded of this very
        // source (PR1: the read's own session recomputed the v1 fingerprint and found it).
        const evidence: boolean[] = [];
        for (const [readSet, field] of Object.entries(LEGACY_CUTOVER_READ_SET_FIELDS) as [
          LegacyReadSetName,
          keyof typeof binding,
        ][]) {
          const run = await this.deps.repository.findReadSetRun(
            scope,
            readSet,
            binding[field],
            binding.sourceFingerprint,
            tx,
          );
          if (run === null) {
            throw errors.conflict(
              LEGACY_CUTOVER_ERROR_CODES.READ_SET_NOT_RECORDED,
              `No ${readSet} read set ${binding[field]} is recorded for source ${binding.sourceFingerprint}: run that read with --expected-fingerprint first.`,
              { readSet },
            );
          }
          evidence.push(run.synthetic);
        }
        const synthetic = evidence.every(Boolean);
        if (!synthetic && evidence.some(Boolean)) {
          throw errors.conflict(
            LEGACY_CUTOVER_ERROR_CODES.READ_SET_EVIDENCE_MIXED,
            'The named read sets disagree on whether their source was synthetic. Nothing was recorded.',
          );
        }
        if (command.kind === 'RERUN_OVER_PRIOR_IMPORT') {
          const finished: ReadonlySet<string> = new Set(LEGACY_CUTOVER_SUPERSEDING_RUN_STATUSES);
          const runs = await this.deps.repository.applyRuns(scope, tx);
          const prior = runs.some(
            (run) =>
              finished.has(run.status) && run.sourceFingerprint === command.priorSourceFingerprint,
          );
          if (!prior) {
            throw errors.conflict(
              LEGACY_CUTOVER_ERROR_CODES.NO_PRIOR_IMPORT,
              'This tenant has no finished import of the prior source this acknowledgement names.',
            );
          }
        }
        const existing = await this.deps.repository.approvalsForSource(
          scope,
          binding.sourceFingerprint,
          tx,
        );
        const same = existing.find(
          (row) =>
            row.revocation === null &&
            row.kind === command.kind &&
            row.priorSourceFingerprint === command.priorSourceFingerprint &&
            bindingMatches(row, binding),
        );
        if (same !== undefined) {
          throw errors.conflict(
            LEGACY_CUTOVER_ERROR_CODES.ALREADY_APPROVED,
            'An unrevoked approval with exactly these values already exists.',
            { approvalId: same.id },
          );
        }
        const approval = await this.deps.repository.insertApproval(
          scope,
          {
            id,
            kind: command.kind,
            ...binding,
            priorSourceFingerprint: command.priorSourceFingerprint,
            synthetic,
            reason: command.reason,
            approvedByAdminId: adminIdOf(actor),
            approvedAt: this.deps.clock.now(),
          },
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action,
            entityType: ENTITY,
            entityId: approval.id,
            before: null,
            after: auditView(approval),
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          idempotencyKey,
          requestHash,
          storeApproval(approval),
          tx,
        );
        return approval;
      },
    );
  }

  /** Withdraws an approval, once, for good. A new approval is a new row. */
  async revoke(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    body: unknown,
  ): Promise<LegacyCutoverApprovalRecord> {
    const action = LEGACY_CUTOVER_AUDIT_ACTIONS.revoke;
    await this.requireApprove(scope, actor, action, id);
    const command = legacyCutoverRevokeRequestSchema.parse(body);
    const requestHash = hashRequest({ action, approvalId: id, reason: command.reason });
    const replay = () =>
      this.deps.idempotency.find<StoredApproval>(
        scope,
        actor.surface,
        command.idempotencyKey,
        requestHash,
      );
    const found = await replay();
    if (found !== null) return reviveApproval(found.result);

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      LEGACY_CUTOVER_APPROVE_PERMISSION,
      { action, entityType: ENTITY, entityId: id },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        await this.deps.repository.lockTenantApprovals(scope, tx);
        // Under the lock, as in approve: a concurrent same-key revoke that committed first is
        // a replay with its stored answer, not ALREADY_REVOKED.
        const committed = await replay();
        if (committed !== null) return reviveApproval(committed.result);
        const before = await this.deps.repository.findApproval(scope, id, tx);
        if (before === null) throw notFound();
        if (before.revocation !== null) {
          throw errors.conflict(
            LEGACY_CUTOVER_ERROR_CODES.ALREADY_REVOKED,
            'This approval was already revoked.',
          );
        }
        await this.deps.repository.insertRevocation(
          scope,
          {
            id: this.deps.ids.uuid(),
            approvalId: id,
            reason: command.reason,
            revokedByAdminId: adminIdOf(actor),
            revokedAt: this.deps.clock.now(),
          },
          tx,
        );
        const after = await this.deps.repository.findApproval(scope, id, tx);
        if (after === null) throw notFound();
        await this.deps.audit.record(
          scope,
          actor,
          {
            action,
            entityType: ENTITY,
            entityId: id,
            before: auditView(before),
            after: auditView(after),
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          storeApproval(after),
          tx,
        );
        return after;
      },
    );
  }

  // --- the importer's gate (inside ITS transaction, under maintenance.run) ------------------

  /**
   * Whether an import may proceed where the cutover gate applies — the one evaluator,
   * `decideCutoverImport`, over the approvals and APPLY runs read IN THE CALLER'S
   * transaction (the importer's start transaction), so a revocation committed before it
   * is seen, and one committed after it cannot un-start what already started. Each read set
   * the approval names must still be recorded for the source.
   */
  async decideImport(
    scope: TenantContext,
    input: {
      readonly expectation: CutoverExpectation;
      readonly snapshotSynthetic: boolean;
      readonly productionLikeTarget: boolean;
    },
    tx: TransactionScope,
  ): Promise<CutoverDecision> {
    const source = input.expectation.sourceFingerprint;
    const [approvals, applyRuns] = await Promise.all([
      source === null
        ? Promise.resolve([])
        : this.deps.repository.approvalsForSource(scope, source, tx),
      this.deps.repository.applyRuns(scope, tx),
    ]);
    const decision = decideCutoverImport({
      expectation: input.expectation,
      approvals: approvals.map((row) => ({ ...row, revoked: row.revocation !== null })),
      applyRuns,
      snapshotSynthetic: input.snapshotSynthetic,
      productionLikeTarget: input.productionLikeTarget,
    });
    if (!decision.ok || source === null) return decision;
    for (const [readSet, field] of Object.entries(LEGACY_CUTOVER_READ_SET_FIELDS) as [
      LegacyReadSetName,
      (typeof LEGACY_CUTOVER_READ_SET_FIELDS)[LegacyReadSetName],
    ][]) {
      const fingerprint = input.expectation[field];
      const run =
        fingerprint === null
          ? null
          : await this.deps.repository.findReadSetRun(scope, readSet, fingerprint, source, tx);
      if (run === null) {
        return {
          ok: false,
          code: 'APPROVAL_MISSING',
          message: `the ${readSet} read set the approval names is not recorded for this source. Nothing was written.`,
          detail: [readSet],
        };
      }
    }
    return decision;
  }

  /** The facts the final report v2 reads about one source. Read only; no permission of its own. */
  async reportFacts(
    scope: TenantContext,
    sourceFingerprint: string,
    runId: string,
  ): Promise<LegacyCutoverReportFacts> {
    const { repository } = this.deps;
    const [
      approvals,
      applyRuns,
      inventory,
      products,
      archiveSet,
      productRows,
      archive,
      duplicates,
      applyOutcome,
      runCutoverApprovalId,
    ] = await Promise.all([
      repository.approvalsForSource(scope, sourceFingerprint),
      repository.applyRuns(scope),
      repository.latestReadSetRun(scope, 'inventory', sourceFingerprint),
      repository.latestReadSetRun(scope, 'products', sourceFingerprint),
      repository.latestReadSetRun(scope, 'invoice-archive', sourceFingerprint),
      repository.productReviewRows(scope),
      repository.latestCompletedArchiveRun(scope, sourceFingerprint),
      repository.duplicateFacts(scope),
      repository.applyOutcome(scope, runId),
      repository.runCutoverApprovalId(scope, runId),
    ]);
    return {
      approvals,
      applyRuns,
      readSets: { inventory, products, 'invoice-archive': archiveSet },
      productRows,
      archive,
      duplicates,
      applyOutcome,
      runCutoverApprovalId,
    };
  }

  /** The destination's stop-sales state (cutover gate step 1). Read only. */
  stopSalesFacts(scope: TenantContext): Promise<LegacyCutoverStopSalesFacts> {
    return this.deps.repository.stopSalesFacts(scope);
  }

  // --- internals -----------------------------------------------------------------------

  private async requireApprove(
    scope: TenantContext,
    actor: ActorContext,
    action: string,
    entityId: string | null,
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, LEGACY_CUTOVER_APPROVE_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        LEGACY_CUTOVER_APPROVE_PERMISSION,
        { action, entityType: ENTITY, entityId },
        error,
      );
      throw error;
    }
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        LEGACY_CUTOVER_ERROR_CODES.SCOPE_STOPPED,
        'This installation has stopped accepting work.',
      );
    }
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}

function page<T extends { readonly id: string }>(rows: readonly T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last !== undefined ? last.id : null };
}

function adminIdOf(actor: ActorContext): string {
  // The guard decides WHO may approve; this only names them. A SYSTEM_JOB holds no approve
  // permission, and the approver column is an admin of this tenant (composite foreign key).
  if (actor.id === null) {
    throw errors.permissionDenied('platform.permission_denied', 'Only the owner approves.');
  }
  return actor.id;
}

function notFound(): Error {
  return errors.notFound(LEGACY_CUTOVER_ERROR_CODES.NOT_FOUND, 'No such cutover approval.');
}

/** What an approval's audit row records: fingerprints, digests, kind, class. No legacy row. */
function auditView(row: LegacyCutoverApprovalRecord): Record<string, unknown> {
  return {
    kind: row.kind,
    sourceFingerprint: row.sourceFingerprint,
    panelMapFingerprint: row.panelMapFingerprint,
    inventoryFingerprint: row.inventoryFingerprint,
    productsFingerprint: row.productsFingerprint,
    invoiceArchiveFingerprint: row.invoiceArchiveFingerprint,
    freezeProofSha256: row.freezeProofSha256,
    finalDumpSha256: row.finalDumpSha256,
    priorSourceFingerprint: row.priorSourceFingerprint,
    synthetic: row.synthetic,
    revoked: row.revocation !== null,
  };
}

interface StoredApproval extends Omit<LegacyCutoverApprovalRecord, 'approvedAt' | 'revocation'> {
  readonly approvedAt: string;
  readonly revocation: {
    readonly revokedByAdminId: string;
    readonly revokedAt: string;
    readonly reason: string;
  } | null;
}

function storeApproval(row: LegacyCutoverApprovalRecord): StoredApproval {
  return {
    ...row,
    approvedAt: row.approvedAt.toISOString(),
    revocation:
      row.revocation === null
        ? null
        : { ...row.revocation, revokedAt: row.revocation.revokedAt.toISOString() },
  };
}

function reviveApproval(stored: StoredApproval): LegacyCutoverApprovalRecord {
  return {
    ...stored,
    approvedAt: new Date(stored.approvedAt),
    revocation:
      stored.revocation === null
        ? null
        : { ...stored.revocation, revokedAt: new Date(stored.revocation.revokedAt) },
  };
}
