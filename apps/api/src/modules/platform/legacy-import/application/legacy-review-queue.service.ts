import {
  COMMERCE_ERROR_CODES,
  LEGACY_IMPORT_ERROR_CODES,
  LEGACY_REVIEW_RESOLUTION_CODES,
  LEGACY_REVIEW_STATES,
  errors,
  isLegacyImportSourceTable,
  isLegacyReviewReasonCode,
  type ActorContext,
  type ActorType,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type LegacyReviewReasonCode,
  type LegacyReviewResolutionCode,
  type LegacyReviewState,
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
import type { SessionRepository } from '../../identity/application/ports.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { OutboxWriter } from '../../eventing/infrastructure/outbox-writer.js';
import { rememberOnce } from '../../idempotency/application/remember-once.js';
import { hashRequest } from '../../idempotency/infrastructure/drizzle-idempotency-store.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  LEGACY_IMPORT_REVIEW_PAGE_MAX,
  assertLegacyKey,
  type LegacyImportMapRecord,
  type LegacyImportRepository,
  type LegacyImportReviewCursor,
  type LegacyReviewTransitionOutcome,
} from './legacy-import-ports.js';

/**
 * The queue is system work, like the import that fills it: the P7 CLI acts as
 * `systemJobActor('legacy-import:…', …)`, whose only permission is `maintenance.run`. The
 * check is MADE, never skipped by actor type — an administrator holding `maintenance.run`
 * passes it too, which is why this service has no HTTP, Telegram or web surface
 * (`tests/unit/legacy-review-queue-boundary.test.ts`). No narrower existing key fits: the
 * queue is a step of the migration, not of an ongoing product area.
 */
export const LEGACY_REVIEW_QUEUE_PERMISSION: PermissionKey = 'maintenance.run';

const AUDIT_RESOLVE = 'legacy_import.review_resolve';
const AUDIT_REOPEN = 'legacy_import.review_reopen';
const ENTITY = 'LegacyImportMapRow';

export interface LegacyReviewQueueDeps {
  readonly repository: Pick<
    LegacyImportRepository,
    'countReview' | 'listManualReview' | 'resolveReview' | 'reopenReview' | 'findByLegacyKeys'
  >;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly outbox: OutboxWriter;
  readonly idempotency: IdempotencyStore;
  readonly clock: Clock;
}

/**
 * One review row as an operator sees it: SAFE context only. The legacy table and key, the
 * closed reason, the run that last decided it, the review state, closed codes and
 * timestamps. Never a source value (no username, phone, balance, link) — the map holds none
 * — and never the source checksum, which is provenance, not context.
 */
export interface LegacyReviewItem {
  readonly legacyTable: string;
  readonly legacyId: string;
  readonly reasonCode: LegacyReviewReasonCode;
  readonly runId: string;
  readonly reviewState: LegacyReviewState;
  readonly resolutionCode: LegacyReviewResolutionCode | null;
  readonly reviewedAt: Date | null;
  readonly reviewedByActorType: ActorType | null;
  readonly reviewedByActorId: string | null;
  readonly reopenedCount: number;
  readonly attempts: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LegacyReviewPage {
  readonly items: readonly LegacyReviewItem[];
  readonly next: LegacyImportReviewCursor | null;
}

export interface LegacyReviewListQuery {
  readonly legacyTable?: string;
  readonly reasonCode?: LegacyReviewReasonCode;
  readonly reviewState?: LegacyReviewState;
  /** Only rows this run last decided. */
  readonly runId?: string;
  readonly after?: LegacyImportReviewCursor;
  /** 1..LEGACY_IMPORT_REVIEW_PAGE_MAX. */
  readonly limit: number;
}

/** Counts per reason, split by review state, plus totals. Aggregates only. */
export interface LegacyReviewCounts {
  readonly runId: string | null;
  readonly rowCount: number;
  readonly byState: Readonly<Record<LegacyReviewState, number>>;
  readonly byReason: readonly {
    readonly legacyTable: string;
    readonly reasonCode: LegacyReviewReasonCode;
    readonly open: number;
    readonly resolved: number;
    readonly dismissed: number;
    readonly rowCount: number;
  }[];
}

export interface LegacyReviewResolveCommand {
  readonly legacyTable: string;
  readonly legacyId: string;
  /** The reason the operator saw; a row a rerun has moved since is a conflict, not resolved. */
  readonly expectedReasonCode: LegacyReviewReasonCode;
  readonly resolutionCode: LegacyReviewResolutionCode;
  readonly idempotencyKey: string;
}

export interface LegacyReviewReopenCommand {
  readonly legacyTable: string;
  readonly legacyId: string;
  readonly idempotencyKey: string;
}

/**
 * - `RESOLVED` / `REOPENED` — this call moved the row.
 * - `ALREADY` — the row was already where this call would put it (a replay of the same key,
 *   or a second identical request). Nothing written, no event, no audit row.
 */
export type LegacyReviewDecisionOutcome =
  | { readonly kind: 'RESOLVED'; readonly item: LegacyReviewItem }
  | { readonly kind: 'REOPENED'; readonly item: LegacyReviewItem }
  | { readonly kind: 'ALREADY'; readonly item: LegacyReviewItem };

/**
 * Program 4 Item 9 — the Manual Review Queue over `legacy_import_map`
 * (`docs/legacy-import-metadata.md` § Manual review queue).
 *
 * The import routes every row it would have had to guess to `MANUAL_REVIEW` with a closed
 * reason; this service is how a person sees and closes them. It never decides an import
 * itself and never touches the provider: resolving is a statement about the ROW, and the
 * next import run acts on it — `RETRY_AFTER_FIX` invites the rerun to decide again,
 * every other resolution makes the rerun leave the row alone until it is reopened.
 *
 * Every write: permission through the guard (charged before anything is read, audited when
 * refused), the session re-checked and the permission re-run inside the transaction,
 * `ScopeActivityReader` inside the transaction, an idempotency key, one conditional UPDATE
 * naming its from-state, an audit row and an outbox event in the same transaction.
 */
export class LegacyReviewQueueService {
  constructor(private readonly deps: LegacyReviewQueueDeps) {}

  async counts(
    scope: TenantContext,
    actor: ActorContext,
    query: { readonly runId?: string } = {},
  ): Promise<LegacyReviewCounts> {
    await this.deps.guard.check(scope, actor, LEGACY_REVIEW_QUEUE_PERMISSION);
    const rows = await this.deps.repository.countReview(
      scope,
      query.runId === undefined ? {} : { runId: query.runId },
    );
    const byState: Record<LegacyReviewState, number> = { OPEN: 0, RESOLVED: 0, DISMISSED: 0 };
    const buckets = new Map<
      string,
      {
        legacyTable: string;
        reasonCode: LegacyReviewReasonCode;
        open: number;
        resolved: number;
        dismissed: number;
        rowCount: number;
      }
    >();
    let rowCount = 0;
    for (const row of rows) {
      rowCount += row.count;
      byState[row.reviewState] += row.count;
      const key = `${row.legacyTable}\u0000${row.reasonCode}`;
      const bucket = buckets.get(key) ?? {
        legacyTable: row.legacyTable,
        reasonCode: row.reasonCode,
        open: 0,
        resolved: 0,
        dismissed: 0,
        rowCount: 0,
      };
      if (row.reviewState === 'OPEN') bucket.open += row.count;
      else if (row.reviewState === 'RESOLVED') bucket.resolved += row.count;
      else bucket.dismissed += row.count;
      bucket.rowCount += row.count;
      buckets.set(key, bucket);
    }
    return { runId: query.runId ?? null, rowCount, byState, byReason: [...buckets.values()] };
  }

  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: LegacyReviewListQuery,
  ): Promise<LegacyReviewPage> {
    await this.deps.guard.check(scope, actor, LEGACY_REVIEW_QUEUE_PERMISSION);
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > LEGACY_IMPORT_REVIEW_PAGE_MAX
    ) {
      throw errors.validation(LEGACY_IMPORT_ERROR_CODES.INVALID, 'page size out of range');
    }
    if (query.legacyTable !== undefined && !isLegacyImportSourceTable(query.legacyTable)) {
      throw errors.validation(LEGACY_IMPORT_ERROR_CODES.INVALID, 'not a legacy source table');
    }
    if (query.reasonCode !== undefined && !isLegacyReviewReasonCode(query.reasonCode)) {
      throw errors.validation(LEGACY_IMPORT_ERROR_CODES.INVALID, 'not a review reason');
    }
    if (
      query.reviewState !== undefined &&
      !(LEGACY_REVIEW_STATES as readonly string[]).includes(query.reviewState)
    ) {
      throw errors.validation(LEGACY_IMPORT_ERROR_CODES.INVALID, 'not a review state');
    }
    if (query.after !== undefined) assertLegacyKey(query.after.legacyTable, query.after.legacyId);
    const page = await this.deps.repository.listManualReview(scope, {
      ...(query.legacyTable === undefined ? {} : { legacyTable: query.legacyTable }),
      ...(query.reasonCode === undefined ? {} : { reasonCode: query.reasonCode }),
      ...(query.reviewState === undefined ? {} : { reviewState: query.reviewState }),
      ...(query.runId === undefined ? {} : { runId: query.runId }),
      ...(query.after === undefined ? {} : { after: query.after }),
      limit: query.limit,
    });
    return { items: page.items.map(toItem), next: page.next };
  }

  async resolve(
    scope: TenantContext,
    actor: ActorContext,
    command: LegacyReviewResolveCommand,
  ): Promise<LegacyReviewDecisionOutcome> {
    assertLegacyKey(command.legacyTable, command.legacyId);
    if (!isLegacyReviewReasonCode(command.expectedReasonCode)) {
      throw errors.validation(LEGACY_IMPORT_ERROR_CODES.INVALID, 'not a review reason');
    }
    if (!(LEGACY_REVIEW_RESOLUTION_CODES as readonly string[]).includes(command.resolutionCode)) {
      throw errors.validation(LEGACY_IMPORT_ERROR_CODES.INVALID, 'not a review resolution');
    }
    const reviewer = this.reviewerOf(actor);
    const denial = { action: AUDIT_RESOLVE, entityType: ENTITY, entityId: null };
    await this.authorize(scope, actor, denial);

    const requestHash = hashRequest({
      op: AUDIT_RESOLVE,
      legacyTable: command.legacyTable,
      legacyId: command.legacyId,
      expectedReasonCode: command.expectedReasonCode,
      resolutionCode: command.resolutionCode,
    });
    const replay = await this.deps.idempotency.find<{ kind: 'RESOLVED' | 'ALREADY' }>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      // The stored answer, with the row as it stands now.
      return { kind: replay.result.kind, item: await this.current(scope, command) };
    }

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      LEGACY_REVIEW_QUEUE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const now = this.deps.clock.now();
        const outcome = await this.deps.repository.resolveReview(
          scope,
          {
            legacyTable: command.legacyTable,
            legacyId: command.legacyId,
            expectedReasonCode: command.expectedReasonCode,
            resolutionCode: command.resolutionCode,
            actor: reviewer,
            now,
          },
          tx,
        );
        const result = await this.settle(scope, actor, tx, outcome, AUDIT_RESOLVE);
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          { kind: result.kind },
          tx,
        );
        return result;
      },
    );
  }

  async reopen(
    scope: TenantContext,
    actor: ActorContext,
    command: LegacyReviewReopenCommand,
  ): Promise<LegacyReviewDecisionOutcome> {
    assertLegacyKey(command.legacyTable, command.legacyId);
    const denial = { action: AUDIT_REOPEN, entityType: ENTITY, entityId: null };
    await this.authorize(scope, actor, denial);

    const requestHash = hashRequest({
      op: AUDIT_REOPEN,
      legacyTable: command.legacyTable,
      legacyId: command.legacyId,
    });
    const replay = await this.deps.idempotency.find<{ kind: 'REOPENED' | 'ALREADY' }>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      return { kind: replay.result.kind, item: await this.current(scope, command) };
    }

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      LEGACY_REVIEW_QUEUE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const outcome = await this.deps.repository.reopenReview(
          scope,
          {
            legacyTable: command.legacyTable,
            legacyId: command.legacyId,
            now: this.deps.clock.now(),
          },
          tx,
        );
        const result = await this.settle(scope, actor, tx, outcome, AUDIT_REOPEN);
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          command.idempotencyKey,
          requestHash,
          { kind: result.kind },
          tx,
        );
        return result;
      },
    );
  }

  /**
   * Turns a repository outcome into the caller's answer, and — only for a real change —
   * writes the audit row and the outbox event in the same transaction.
   */
  private async settle(
    scope: TenantContext,
    actor: ActorContext,
    tx: TransactionScope,
    outcome: LegacyReviewTransitionOutcome,
    action: typeof AUDIT_RESOLVE | typeof AUDIT_REOPEN,
  ): Promise<LegacyReviewDecisionOutcome> {
    switch (outcome.kind) {
      case 'NOT_FOUND':
        throw errors.notFound(
          LEGACY_IMPORT_ERROR_CODES.REVIEW_NOT_FOUND,
          'No legacy import decision for this key.',
        );
      case 'NOT_IN_REVIEW':
        throw errors.conflict(
          LEGACY_IMPORT_ERROR_CODES.REVIEW_NOT_IN_REVIEW,
          'This legacy record is not in manual review.',
          { status: outcome.record.status },
        );
      case 'CONFLICT':
        throw errors.conflict(
          LEGACY_IMPORT_ERROR_CODES.REVIEW_CONFLICT,
          'This review row changed since it was read; list it again.',
          {
            reviewState: outcome.record.reviewState,
            reasonCode: outcome.record.reasonCode,
            resolutionCode: outcome.record.reviewResolutionCode,
          },
        );
      case 'UNCHANGED':
        return { kind: 'ALREADY', item: toItem(outcome.record) };
      case 'CHANGED': {
        const item = toItem(outcome.record);
        // The row's uuid, never its legacy key: a `user` key is a Telegram id, and the audit
        // log is append-only.
        const entityId = outcome.record.ref;
        await this.deps.audit.record(
          scope,
          actor,
          {
            action,
            entityType: ENTITY,
            entityId,
            before: { reviewState: outcome.from },
            after: {
              reviewState: item.reviewState,
              reasonCode: item.reasonCode,
              resolutionCode: item.resolutionCode,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await this.deps.outbox.write(tx, actor, {
          eventType: 'LegacyImportReviewStateChanged',
          aggregateType: 'LegacyImportMapRow',
          aggregateId: entityId,
          payload: {
            legacyTable: item.legacyTable,
            reasonCode: item.reasonCode,
            from: outcome.from,
            to: item.reviewState,
            resolutionCode: item.resolutionCode,
          },
        });
        return { kind: action === AUDIT_RESOLVE ? 'RESOLVED' : 'REOPENED', item };
      }
    }
  }

  /** The row as it stands now, for a replayed key. */
  private async current(
    scope: TenantContext,
    key: { readonly legacyTable: string; readonly legacyId: string },
  ): Promise<LegacyReviewItem> {
    const [row] = await this.deps.repository.findByLegacyKeys(scope, key.legacyTable, [
      key.legacyId,
    ]);
    if (row === undefined) {
      throw errors.notFound(
        LEGACY_IMPORT_ERROR_CODES.REVIEW_NOT_FOUND,
        'No legacy import decision for this key.',
      );
    }
    if (row.status !== 'MANUAL_REVIEW') {
      throw errors.conflict(
        LEGACY_IMPORT_ERROR_CODES.REVIEW_NOT_IN_REVIEW,
        'This legacy record is not in manual review.',
        { status: row.status },
      );
    }
    return toItem(row);
  }

  /** The closing actor as the row records it: a type and a stable identifier. */
  private reviewerOf(actor: ActorContext): { type: ActorType; id: string } {
    if (actor.id === null || !/^[A-Za-z0-9._:-]{1,128}$/.test(actor.id)) {
      throw errors.validation(
        LEGACY_IMPORT_ERROR_CODES.INVALID,
        'A review is closed by an identified actor.',
      );
    }
    return { type: actor.type, id: actor.id };
  }

  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, LEGACY_REVIEW_QUEUE_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        LEGACY_REVIEW_QUEUE_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
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

function toItem(record: LegacyImportMapRecord): LegacyReviewItem {
  if (
    record.status !== 'MANUAL_REVIEW' ||
    record.reviewState === null ||
    record.reasonCode === null ||
    !isLegacyReviewReasonCode(record.reasonCode)
  ) {
    // Unreachable: the CHECKs pin a review row's reason and state.
    throw errors.internal(LEGACY_IMPORT_ERROR_CODES.INVALID, 'not a review row');
  }
  return {
    legacyTable: record.legacyTable,
    legacyId: record.legacyId,
    reasonCode: record.reasonCode,
    runId: record.runId,
    reviewState: record.reviewState,
    resolutionCode: record.reviewResolutionCode,
    reviewedAt: record.reviewedAt,
    reviewedByActorType: record.reviewedByActorType,
    reviewedByActorId: record.reviewedByActorId,
    reopenedCount: record.reviewReopenedCount,
    attempts: record.attempts,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
