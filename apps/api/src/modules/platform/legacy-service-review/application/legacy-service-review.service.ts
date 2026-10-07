import {
  LEGACY_SERVICE_OUTCOMES,
  LEGACY_SERVICE_REOPENABLE_STATES,
  LEGACY_SERVICE_REVIEW_AUDIT_ACTIONS,
  LEGACY_SERVICE_REVIEW_ERROR_CODES,
  LEGACY_SERVICE_REVIEW_PAGE_MAX,
  LEGACY_SERVICE_REVIEW_STATES,
  errors,
  legacyServiceAdoptRequestSchema,
  legacyServiceDecideRequestSchema,
  legacyServiceReopenRequestSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type LegacyServiceCandidateListQuery,
  type LegacyServiceOutcome,
  type LegacyServiceReviewState,
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
import { adoptPanelsOf, decideAdoptRequest } from '../domain/candidate-rules.js';
import type {
  LegacyServiceArchiveSummary,
  LegacyServiceCandidateRecord,
  LegacyServiceCandidateRepository,
  LegacyServiceReviewChange,
} from './ports.js';

export const LEGACY_SERVICES_VIEW_PERMISSION = 'legacy.services.view' satisfies PermissionKey;
export const LEGACY_SERVICES_DECIDE_PERMISSION = 'legacy.services.decide' satisfies PermissionKey;
/** The archive revision's fields are the invoice archive's (PR3): shown with ITS view key. */
const LEGACY_INVOICES_VIEW_PERMISSION = 'legacy.invoices.view' satisfies PermissionKey;

const ENTITY = 'LegacyServiceCandidate';

export interface LegacyServiceReviewServiceDeps {
  readonly repository: LegacyServiceCandidateRepository;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
}

export interface LegacyServiceCandidateDetail {
  readonly candidate: LegacyServiceCandidateRecord;
  readonly archive: LegacyServiceArchiveSummary | null;
  readonly importOutcome: {
    readonly status: string;
    readonly reasonCode: string | null;
    readonly reviewState: string | null;
  } | null;
  readonly adoptPanels: readonly string[];
}

/**
 * Mirza migration PR5 — the operator's review of legacy service candidates (Area D; owner
 * decision 8).
 *
 * The OUTCOMES are written by the importer (`maintenance.run`, migration-only, never here).
 * This service is what the Web Admin reaches, and it is its OWN service — not the terminal
 * Manual Review Queue (whose boundary test keeps it off every surface, and whose resolutions
 * are charged to the CRITICAL `maintenance.run`), and not the P6 adoption (which no surface
 * may reach):
 *
 * - reads (`legacy.services.view`): the list, one candidate with its archive revision and
 *   evidence, and the counts by outcome and review state;
 * - decisions (`legacy.services.decide`): ACKNOWLEDGE, KEEP_AS_HISTORY, an explicit ADOPT
 *   approval, and reopen. Each takes an idempotency key, binds to the version the operator
 *   saw, is ONE conditional UPDATE naming its from-states inside a transaction that re-checks
 *   the permission and the scope's activity, and is audited (DENIED too).
 *
 * An ADOPT approval adopts NOTHING here: no service, order or map row is written and no
 * provider is called. It records the operator's request, bound to the invoice checksum and
 * outcome they saw (and the panel they named), and the NEXT import run executes it — after
 * re-running every adoption check against the inventory it walks twice — through the one P6
 * path (`docs/legacy-migration/service-review.md` §Adopt).
 */
export class LegacyServiceReviewService {
  constructor(private readonly deps: LegacyServiceReviewServiceDeps) {}

  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: LegacyServiceCandidateListQuery,
  ): Promise<{
    readonly items: readonly LegacyServiceCandidateRecord[];
    readonly nextCursor: string | null;
  }> {
    await this.deps.guard.check(scope, actor, LEGACY_SERVICES_VIEW_PERMISSION);
    const limit = query.limit ?? LEGACY_SERVICE_REVIEW_PAGE_MAX;
    const rows = await this.deps.repository.list(scope, {
      ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
      ...(query.reviewState === undefined ? {} : { reviewState: query.reviewState }),
      ...(query.panelCode === undefined ? {} : { panelCode: query.panelCode }),
      ...(query.productCode === undefined ? {} : { productCode: query.productCode }),
      ...(query.invoiceId === undefined ? {} : { invoiceIdPrefix: query.invoiceId }),
      ...(query.after === undefined ? {} : { after: query.after }),
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page, nextCursor: rows.length > limit && last !== undefined ? last.id : null };
  }

  async get(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<LegacyServiceCandidateDetail> {
    await this.deps.guard.check(scope, actor, LEGACY_SERVICES_VIEW_PERMISSION);
    const candidate = await this.deps.repository.findById(scope, id);
    if (candidate === null) throw notFound();
    const archiveVisible =
      candidate.archiveId !== null &&
      (await this.deps.guard.has(scope, actor, LEGACY_INVOICES_VIEW_PERMISSION));
    const [archive, importOutcome] = await Promise.all([
      archiveVisible && candidate.archiveId !== null
        ? this.deps.repository.archiveSummary(scope, candidate.archiveId)
        : Promise.resolve(null),
      this.deps.repository.importOutcome(scope, candidate.invoiceKey),
    ]);
    return {
      candidate,
      archive,
      importOutcome,
      adoptPanels:
        candidate.reviewState === 'OPEN' || candidate.reviewState === 'ACKNOWLEDGED'
          ? adoptPanelsOf(candidate.evidence)
          : [],
    };
  }

  async summary(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<{
    readonly total: number;
    readonly byOutcome: Readonly<Record<LegacyServiceOutcome, number>>;
    readonly byReviewState: Readonly<Record<LegacyServiceReviewState, number>>;
  }> {
    await this.deps.guard.check(scope, actor, LEGACY_SERVICES_VIEW_PERMISSION);
    const stored = await this.deps.repository.aggregate(scope);
    const byOutcome = Object.fromEntries(
      LEGACY_SERVICE_OUTCOMES.map((o) => [o, stored.byOutcome[o] ?? 0]),
    ) as Record<LegacyServiceOutcome, number>;
    const byReviewState = Object.fromEntries(
      LEGACY_SERVICE_REVIEW_STATES.map((s) => [s, stored.byReviewState[s] ?? 0]),
    ) as Record<LegacyServiceReviewState, number>;
    const total = Object.values(byOutcome).reduce((a, b) => a + b, 0);
    return { total, byOutcome, byReviewState };
  }

  /** ACKNOWLEDGE (from OPEN) or KEEP_AS_HISTORY (from OPEN or ACKNOWLEDGED). */
  async decide(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    body: unknown,
  ): Promise<LegacyServiceCandidateRecord> {
    const command = legacyServiceDecideRequestSchema.parse(body);
    const acknowledge = command.decision === 'ACKNOWLEDGE';
    return this.transition(scope, actor, id, {
      action: LEGACY_SERVICE_REVIEW_AUDIT_ACTIONS.decide,
      idempotencyKey: command.idempotencyKey,
      request: { ...command, idempotencyKey: undefined },
      from: acknowledge ? ['OPEN'] : ['OPEN', 'ACKNOWLEDGED'],
      expectedVersion: command.expectedVersion,
      change: () => ({
        reviewState: acknowledge ? 'ACKNOWLEDGED' : 'KEPT_AS_HISTORY',
        decisionReason: command.reason,
      }),
    });
  }

  /**
   * An explicit ADOPT approval (from OPEN or ACKNOWLEDGED). Decided against the row as it is
   * under its lock: the outcome must be one a person can clear, and the panel — required when
   * the map gives the invoice none — must be a mapped panel whose inventory held the account
   * (`decideAdoptRequest`). Bound to the checksum and outcome the operator saw. Nothing is
   * adopted here; the next import run executes it after every check again.
   */
  async approveAdoption(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    body: unknown,
  ): Promise<LegacyServiceCandidateRecord> {
    const command = legacyServiceAdoptRequestSchema.parse(body);
    return this.transition(scope, actor, id, {
      action: LEGACY_SERVICE_REVIEW_AUDIT_ACTIONS.approveAdoption,
      idempotencyKey: command.idempotencyKey,
      request: { ...command, idempotencyKey: undefined },
      from: ['OPEN', 'ACKNOWLEDGED'],
      expectedVersion: command.expectedVersion,
      change: (before) => {
        const verdict = decideAdoptRequest(before, command.panelId);
        if (!verdict.ok) {
          throw errors.conflict(
            verdict.code === 'NOT_ADOPTABLE'
              ? LEGACY_SERVICE_REVIEW_ERROR_CODES.NOT_ADOPTABLE
              : LEGACY_SERVICE_REVIEW_ERROR_CODES.PANEL_REFUSED,
            verdict.message,
            { outcome: before.outcome },
          );
        }
        return {
          reviewState: 'ADOPT_APPROVED',
          approvedPanelId: verdict.approvedPanelId,
          approvedChecksum: before.invoiceChecksum,
          approvedOutcome: before.outcome,
          lastApprovalRefusal: null,
          decisionReason: command.reason,
        };
      },
    });
  }

  /** ACKNOWLEDGED, KEPT_AS_HISTORY or a waiting ADOPT_APPROVED back to OPEN. */
  async reopen(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    body: unknown,
  ): Promise<LegacyServiceCandidateRecord> {
    const command = legacyServiceReopenRequestSchema.parse(body);
    return this.transition(scope, actor, id, {
      action: LEGACY_SERVICE_REVIEW_AUDIT_ACTIONS.reopen,
      idempotencyKey: command.idempotencyKey,
      request: { ...command, idempotencyKey: undefined },
      from: LEGACY_SERVICE_REOPENABLE_STATES,
      expectedVersion: command.expectedVersion,
      change: () => ({
        reviewState: 'OPEN',
        approvedPanelId: null,
        approvedChecksum: null,
        approvedOutcome: null,
        decisionReason: command.reason,
      }),
    });
  }

  /**
   * The decision write path, once: the early permission check (refusal audited), the replay,
   * then ONE transaction that re-checks session and permission, reads scope activity, locks
   * the row, checks state and version, moves it conditionally, audits and remembers.
   */
  private async transition(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    spec: {
      readonly action: string;
      readonly idempotencyKey: string;
      readonly request: Record<string, unknown>;
      readonly from: readonly LegacyServiceReviewState[];
      readonly expectedVersion: number;
      readonly change: (
        before: LegacyServiceCandidateRecord,
      ) => Omit<LegacyServiceReviewChange, 'updatedAt' | 'decidedAt' | 'decidedByAdminId'>;
    },
  ): Promise<LegacyServiceCandidateRecord> {
    const denial = { action: spec.action, entityType: ENTITY, entityId: id };
    try {
      await this.deps.guard.check(scope, actor, LEGACY_SERVICES_DECIDE_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        LEGACY_SERVICES_DECIDE_PERMISSION,
        denial,
        error,
      );
      throw error;
    }

    const requestHash = hashRequest({ action: spec.action, candidateId: id, ...spec.request });
    const found = await this.deps.idempotency.find<StoredCandidate>(
      scope,
      actor.surface,
      spec.idempotencyKey,
      requestHash,
    );
    // The ORIGINAL answer, exactly as first returned — never the candidate as it stands now,
    // which a reopen, another decision or an import run may have moved since.
    if (found !== null) return reviveCandidate(found.result);

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      LEGACY_SERVICES_DECIDE_PERMISSION,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            LEGACY_SERVICE_REVIEW_ERROR_CODES.SCOPE_STOPPED,
            'This installation has stopped accepting work.',
          );
        }
        const now = this.deps.clock.now();
        const located = await this.deps.repository.findById(scope, id, tx);
        if (located === null) throw notFound();
        // The invoice's lock FIRST — the one P6's adoption takes first — so this decision and
        // an adoption of the same invoice are serialised; then the row's own lock.
        await this.deps.repository.lockInvoice(scope, located.invoiceKey, tx);
        const before = await this.deps.repository.findById(scope, id, tx, { forUpdate: true });
        if (before === null) throw notFound();
        if (!spec.from.includes(before.reviewState)) throw notInState(before.reviewState);
        // An invoice P6 adopted since the last run recorded it is a service now: no decision
        // made from the outcome the operator saw may land on it.
        const mapped = await this.deps.repository.importOutcome(scope, before.invoiceKey, tx);
        if (mapped?.status === 'IMPORTED') throw notInState('ADOPTED');
        if (before.version !== spec.expectedVersion) {
          throw errors.conflict(
            LEGACY_SERVICE_REVIEW_ERROR_CODES.VERSION_CONFLICT,
            'This candidate changed since you opened it (a decision, or an import run). Reload it and decide again.',
            { version: before.version },
          );
        }
        const after = await this.deps.repository.transition(
          scope,
          id,
          { from: spec.from, version: before.version },
          {
            ...spec.change(before),
            decidedByAdminId: adminIdOf(actor),
            decidedAt: now,
            updatedAt: now,
          },
          tx,
        );
        if (after === null) {
          const current = await this.deps.repository.findById(scope, id, tx);
          throw current === null ? notFound() : notInState(current.reviewState);
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: spec.action,
            entityType: ENTITY,
            entityId: id,
            before: decisionView(before),
            after: decisionView(after),
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          spec.idempotencyKey,
          requestHash,
          storeCandidate(after),
          tx,
        );
        return after;
      },
    );
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

function adminIdOf(actor: ActorContext): string {
  // The guard decides WHO may decide; this only names them. A SYSTEM_JOB holds no decide
  // permission, and the decider column is an admin of this tenant (composite foreign key).
  if (actor.id === null) {
    throw errors.permissionDenied('platform.permission_denied', 'Only an administrator decides.');
  }
  return actor.id;
}

function notFound(): Error {
  return errors.notFound(
    LEGACY_SERVICE_REVIEW_ERROR_CODES.NOT_FOUND,
    'No such legacy service candidate.',
  );
}

function notInState(state: LegacyServiceReviewState): Error {
  return errors.conflict(
    LEGACY_SERVICE_REVIEW_ERROR_CODES.NOT_IN_STATE,
    `This candidate is ${state}; that decision cannot be made from it.`,
    { state },
  );
}

/**
 * What a decision audit row records: codes, NEXA ids, the checksum bound and the version —
 * never the invoice key's owner, a username or a Telegram id (the candidate holds none).
 */
function decisionView(row: LegacyServiceCandidateRecord): Record<string, unknown> {
  return {
    reviewState: row.reviewState,
    outcome: row.outcome,
    approvedPanelId: row.approvedPanelId,
    approvedChecksum: row.approvedChecksum,
    approvedOutcome: row.approvedOutcome,
    decisionReason: row.decisionReason,
    synthetic: row.synthetic,
    version: row.version,
  };
}

/**
 * A decision's response as the idempotency store keeps it: JSON-safe (instants as strings),
 * revived exactly on a replay.
 */
interface StoredCandidate extends Omit<
  LegacyServiceCandidateRecord,
  'decidedAt' | 'observedAt' | 'firstDecidedAt' | 'updatedAt'
> {
  readonly decidedAt: string | null;
  readonly observedAt: string | null;
  readonly firstDecidedAt: string;
  readonly updatedAt: string;
}

function storeCandidate(row: LegacyServiceCandidateRecord): StoredCandidate {
  return {
    ...row,
    decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
    observedAt: row.observedAt === null ? null : row.observedAt.toISOString(),
    firstDecidedAt: row.firstDecidedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function reviveCandidate(stored: StoredCandidate): LegacyServiceCandidateRecord {
  return {
    ...stored,
    decidedAt: stored.decidedAt === null ? null : new Date(stored.decidedAt),
    observedAt: stored.observedAt === null ? null : new Date(stored.observedAt),
    firstDecidedAt: new Date(stored.firstDecidedAt),
    updatedAt: new Date(stored.updatedAt),
  };
}
