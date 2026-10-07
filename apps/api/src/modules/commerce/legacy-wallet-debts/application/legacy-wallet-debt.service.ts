import {
  LEGACY_WALLET_DEBT_AUDIT_ACTIONS,
  LEGACY_WALLET_DEBT_CURRENCY,
  LEGACY_WALLET_DEBT_DECIDED_STATES,
  LEGACY_WALLET_DEBT_ERROR_CODES,
  LEGACY_WALLET_DEBT_PAGE_MAX,
  LEGACY_WALLET_DEBT_STATES,
  errors,
  legacyWalletDebtDecideRequestSchema,
  legacyWalletDebtReopenRequestSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type LegacyWalletDebtListQuery,
  type LegacyWalletDebtState,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  LegacyWalletDebtAggregate,
  LegacyWalletDebtRecord,
  LegacyWalletDebtRepository,
} from './ports.js';

export const LEGACY_DEBTS_VIEW_PERMISSION = 'legacy.debts.view' satisfies PermissionKey;
export const LEGACY_DEBTS_DECIDE_PERMISSION = 'legacy.debts.decide' satisfies PermissionKey;

const ENTITY = 'LegacyWalletDebt';

export interface LegacyWalletDebtServiceDeps {
  readonly repository: LegacyWalletDebtRepository;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
}

export interface LegacyWalletDebtSummary {
  readonly currency: typeof LEGACY_WALLET_DEBT_CURRENCY;
  readonly total: LegacyWalletDebtAggregate;
  readonly byState: Readonly<Record<LegacyWalletDebtState, LegacyWalletDebtAggregate>>;
}

/**
 * Mirza migration PR4 — the owner's review of legacy wallet debts (owner decision 6).
 *
 * A debt is RECORDED by the opening-balance path of the importer (`maintenance.run`,
 * migration-only, never here). This service is what the Web Admin reaches:
 *
 * - reads (`legacy.debts.view`): the list, one debt, and the aggregate by state;
 * - the owner's decision (`legacy.debts.decide`): ACKNOWLEDGED or WAIVED from
 *   PENDING_REVIEW, and reopen back to PENDING_REVIEW. Each takes an idempotency key,
 *   binds to the version the operator saw, is ONE conditional UPDATE naming its from-states
 *   inside a transaction that re-checks the permission and the scope's activity, and is
 *   audited (DENIED too).
 *
 * NOTHING here moves money. There is deliberately no wallet, ledger, payment or order
 * dependency: a decision is a label on the record, and the customer's balance is the
 * ledger, which no debt is part of. Collecting a debt would need a new ledger reason and an
 * explicit owner instruction (`docs/migration-opening-balance.md`).
 */
export class LegacyWalletDebtService {
  constructor(private readonly deps: LegacyWalletDebtServiceDeps) {}

  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: LegacyWalletDebtListQuery,
  ): Promise<{
    readonly items: readonly LegacyWalletDebtRecord[];
    readonly nextCursor: string | null;
  }> {
    await this.deps.guard.check(scope, actor, LEGACY_DEBTS_VIEW_PERMISSION);
    const limit = query.limit ?? LEGACY_WALLET_DEBT_PAGE_MAX;
    const rows = await this.deps.repository.list(scope, {
      ...(query.state === undefined ? {} : { state: query.state }),
      ...(query.legacyUserId === undefined ? {} : { legacyUserId: query.legacyUserId }),
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
  ): Promise<LegacyWalletDebtRecord> {
    await this.deps.guard.check(scope, actor, LEGACY_DEBTS_VIEW_PERMISSION);
    const found = await this.deps.repository.findById(scope, id);
    if (found === null) throw notFound();
    return found;
  }

  async summary(scope: TenantContext, actor: ActorContext): Promise<LegacyWalletDebtSummary> {
    await this.deps.guard.check(scope, actor, LEGACY_DEBTS_VIEW_PERMISSION);
    const stored = await this.deps.repository.aggregate(scope);
    const byState = Object.fromEntries(
      LEGACY_WALLET_DEBT_STATES.map((s) => [s, stored[s] ?? { count: 0, sumMinor: 0n }]),
    ) as Record<LegacyWalletDebtState, LegacyWalletDebtAggregate>;
    const total = Object.values(byState).reduce(
      (a, b) => ({ count: a.count + b.count, sumMinor: a.sumMinor + b.sumMinor }),
      { count: 0, sumMinor: 0n },
    );
    return { currency: LEGACY_WALLET_DEBT_CURRENCY, total, byState };
  }

  /** ACKNOWLEDGED or WAIVED, from PENDING_REVIEW. A label: no money moves either way. */
  async decide(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    body: unknown,
  ): Promise<LegacyWalletDebtRecord> {
    const command = legacyWalletDebtDecideRequestSchema.parse(body);
    return this.transition(scope, actor, id, {
      action: LEGACY_WALLET_DEBT_AUDIT_ACTIONS.decide,
      idempotencyKey: command.idempotencyKey,
      request: { ...command, idempotencyKey: undefined },
      from: ['PENDING_REVIEW'],
      to: command.decision,
      expectedVersion: command.expectedVersion,
      reason: command.reason,
    });
  }

  /** A decided debt back to PENDING_REVIEW. */
  async reopen(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    body: unknown,
  ): Promise<LegacyWalletDebtRecord> {
    const command = legacyWalletDebtReopenRequestSchema.parse(body);
    return this.transition(scope, actor, id, {
      action: LEGACY_WALLET_DEBT_AUDIT_ACTIONS.reopen,
      idempotencyKey: command.idempotencyKey,
      request: { ...command, idempotencyKey: undefined },
      from: LEGACY_WALLET_DEBT_DECIDED_STATES,
      to: 'PENDING_REVIEW',
      expectedVersion: command.expectedVersion,
      reason: command.reason,
    });
  }

  /**
   * The decision write path, once: the early permission check (refusal audited), the
   * replay, then ONE transaction that re-checks session and permission, reads scope
   * activity, locks the row, moves it conditionally, audits and remembers.
   */
  private async transition(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
    spec: {
      readonly action: string;
      readonly idempotencyKey: string;
      readonly request: Record<string, unknown>;
      readonly from: readonly LegacyWalletDebtState[];
      readonly to: LegacyWalletDebtState;
      readonly expectedVersion: number;
      readonly reason: string;
    },
  ): Promise<LegacyWalletDebtRecord> {
    const denial = { action: spec.action, entityType: ENTITY, entityId: id };
    try {
      await this.deps.guard.check(scope, actor, LEGACY_DEBTS_DECIDE_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        LEGACY_DEBTS_DECIDE_PERMISSION,
        denial,
        error,
      );
      throw error;
    }

    const requestHash = hashRequest({ action: spec.action, debtId: id, ...spec.request });
    const found = await this.deps.idempotency.find<{ readonly id: string }>(
      scope,
      actor.surface,
      spec.idempotencyKey,
      requestHash,
    );
    if (found !== null) {
      const replayed = await this.deps.repository.findById(scope, found.result.id);
      if (replayed !== null) return replayed;
    }

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      LEGACY_DEBTS_DECIDE_PERMISSION,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            LEGACY_WALLET_DEBT_ERROR_CODES.SCOPE_STOPPED,
            'This installation has stopped accepting work.',
          );
        }
        const now = this.deps.clock.now();
        const before = await this.deps.repository.findById(scope, id, tx, { forUpdate: true });
        if (before === null) throw notFound();
        if (!(spec.from as readonly string[]).includes(before.state))
          throw notInState(before.state);
        if (before.version !== spec.expectedVersion) {
          throw errors.conflict(
            LEGACY_WALLET_DEBT_ERROR_CODES.VERSION_CONFLICT,
            'This legacy debt changed since you opened it. Reload it and decide again.',
            { version: before.version },
          );
        }
        const after = await this.deps.repository.decide(
          scope,
          id,
          { from: spec.from, version: before.version },
          {
            state: spec.to,
            decisionReason: spec.reason,
            decidedByAdminId: adminIdOf(actor),
            decidedAt: now,
            updatedAt: now,
          },
          tx,
        );
        if (after === null) {
          const current = await this.deps.repository.findById(scope, id, tx);
          throw current === null ? notFound() : notInState(current.state);
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
          { id: after.id },
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
  return errors.notFound(LEGACY_WALLET_DEBT_ERROR_CODES.NOT_FOUND, 'No such legacy debt.');
}

function notInState(state: LegacyWalletDebtState): Error {
  return errors.conflict(
    LEGACY_WALLET_DEBT_ERROR_CODES.NOT_IN_STATE,
    `This legacy debt is ${state}; that decision cannot be made from it.`,
    { state },
  );
}

/**
 * What a decision audit row records: the decision, the amount and the provenance — the
 * debt's own id names the customer; the Telegram id is not repeated into the audit log.
 */
function decisionView(row: LegacyWalletDebtRecord): Record<string, unknown> {
  return {
    state: row.state,
    amountMinor: row.amountMinor.toString(),
    currency: row.currency,
    sourceFingerprint: row.sourceFingerprint,
    decisionReason: row.decisionReason,
    version: row.version,
  };
}
