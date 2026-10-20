import {
  errors,
  LEGACY_COMPACTION_CONFIRMATION_PHRASE,
  PLATFORM_ERROR_CODES,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type IdGenerator,
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
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import { rememberOnce } from '../../idempotency/application/remember-once.js';
import type { LegacyCompactionRepository, LegacyCompactionRow } from './ports.js';
import { compactionDropTypes } from './read-map.js';

/**
 * «فشرده‌سازی داده‌های ربات قبلی» (Round 4 PR-E, E1).
 *
 * The REQUEST is the owner's: `legacy.migration.apply` (CRITICAL, the permission that started
 * the import), the typed phrase, a completed import and none in flight, and never twice (it
 * is one-time). It writes one REQUESTED row and an audit row, and nothing else: the work is
 * the worker's (`LegacyCompactionExecutor`), never this request's.
 */

export const LEGACY_COMPACTION_PERMISSION: PermissionKey = 'legacy.migration.apply';
const VIEW_PERMISSION: PermissionKey = 'legacy.migration.view';

export interface LegacyCompactionServiceDeps {
  readonly repository: LegacyCompactionRepository;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
}

export class LegacyCompactionService {
  constructor(private readonly deps: LegacyCompactionServiceDeps) {}

  async status(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<{ available: boolean; run: LegacyCompactionRow | null }> {
    await this.authorize(scope, actor, VIEW_PERMISSION, 'legacy.compaction.status');
    const [readiness, run, completed] = await Promise.all([
      this.deps.repository.importReadiness(scope.tenantId),
      this.deps.repository.latest(scope.tenantId),
      this.deps.repository.completedExists(scope.tenantId),
    ]);
    const active = run !== null && run.state !== 'COMPLETED' && run.state !== 'FAILED';
    return {
      available: readiness.completed && !readiness.inFlight && !active && !completed,
      run,
    };
  }

  async request(
    scope: TenantContext,
    actor: ActorContext,
    command: { readonly idempotencyKey: string; readonly phrase: string },
  ): Promise<LegacyCompactionRow> {
    await this.authorize(scope, actor, LEGACY_COMPACTION_PERMISSION, 'legacy.compaction.request');
    if (command.phrase.trim() !== LEGACY_COMPACTION_CONFIRMATION_PHRASE) {
      throw errors.validation(
        PLATFORM_ERROR_CODES.LEGACY_COMPACTION_PHRASE_INVALID,
        `Type ${LEGACY_COMPACTION_CONFIRMATION_PHRASE} exactly to confirm.`,
      );
    }
    const requestHash = 'legacy.compaction.request.v1';
    const replay = await this.deps.idempotency.find<{ id: string }>(
      scope,
      actor.surface,
      command.idempotencyKey,
      requestHash,
    );
    if (replay) {
      const row = await this.deps.repository.latest(scope.tenantId);
      if (row !== null) return row;
    }
    const id = this.deps.ids.uuid();
    await runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      LEGACY_COMPACTION_PERMISSION,
      { action: 'legacy.compaction.request', entityType: 'LegacyCompaction', entityId: null },
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.notFound(
            PLATFORM_ERROR_CODES.TENANT_NOT_FOUND,
            'This scope is not accepting work.',
          );
        }
        // Decided INSIDE the transaction: an import approved a moment ago is in flight.
        const readiness = await this.deps.repository.importReadiness(scope.tenantId, tx.tx);
        if (!readiness.completed || readiness.inFlight) {
          throw errors.conflict(
            PLATFORM_ERROR_CODES.LEGACY_COMPACTION_UNAVAILABLE,
            'The legacy data can be compacted only after an import has completed and while none is running.',
          );
        }
        if (await this.deps.repository.completedExists(scope.tenantId, tx.tx)) {
          throw errors.conflict(
            PLATFORM_ERROR_CODES.LEGACY_COMPACTION_ACTIVE,
            'The legacy data has already been compacted.',
          );
        }
        const now = this.deps.clock.now();
        const created = await this.deps.repository.create(
          {
            id,
            tenantId: scope.tenantId,
            now,
            adminId: actor.type === 'WEB_ADMIN' ? actor.id : null,
            label: actor.label,
          },
          tx.tx,
        );
        if (!created) {
          throw errors.conflict(
            PLATFORM_ERROR_CODES.LEGACY_COMPACTION_ACTIVE,
            'A compaction of the legacy data is already running.',
          );
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'legacy.compaction.request',
            entityType: 'LegacyCompaction',
            entityId: id,
            before: null,
            after: { state: 'REQUESTED', dropTypes: [...compactionDropTypes()] },
            reason: 'The owner confirmed the irreversible compaction of the legacy data.',
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
          { id },
          tx,
        );
      },
    );
    const row = await this.deps.repository.latest(scope.tenantId);
    if (row === null) throw new Error('a compaction row could not be read back');
    return row;
  }

  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
    action: string,
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (denied) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        permission,
        { action, entityType: 'LegacyCompaction', entityId: null },
        denied,
      );
      throw denied;
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
