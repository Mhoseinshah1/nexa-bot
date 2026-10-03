import {
  COMMERCE_ERROR_CODES,
  errors,
  userIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type TenantContext,
  type UnitOfWork,
  type UserId,
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
import type { WalletRepository } from '../../wallet/application/ports.js';
import type { TrialOverrideRepository } from './ports.js';
import {
  decideLegacyTrial,
  legacyTrialInputHash,
  type LegacyTrialEligibilityRepository,
  type LegacyTrialFacts,
  type LegacyTrialRecord,
} from './legacy-trial-eligibility.js';
import { TRIAL_OVERRIDE_PERMISSION } from './trial-admin.service.js';

/**
 * - `APPLIED` — decided now, the override (if any) written in the same transaction.
 * - `REPLAYED` — this customer was already decided from the same legacy facts; nothing
 *   changed, whatever the override is today (an operator may have lifted it since).
 * - `CONFLICT` — already decided from DIFFERENT legacy facts; nothing changed. A caller
 *   bug or a changed archive, and either way a person's question, not a rewrite.
 */
export type LegacyTrialOutcome = 'APPLIED' | 'REPLAYED' | 'CONFLICT';

export interface LegacyTrialResult {
  readonly outcome: LegacyTrialOutcome;
  readonly record: LegacyTrialRecord;
}

export interface LegacyTrialEligibilityServiceDeps {
  readonly records: LegacyTrialEligibilityRepository;
  readonly overrides: Pick<TrialOverrideRepository, 'find' | 'upsert'>;
  /** The customer row lock — the one `TrialService.claim` decides under. */
  readonly wallet: Pick<WalletRepository, 'lockCustomer'>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
}

/**
 * Preserves one migrated customer's legacy trial entitlement (program Item 15,
 * `docs/legacy-migration/trial-eligibility.md`), so nobody gets a fresh trial merely
 * because NEXA is new to them.
 *
 * The decision is `decideLegacyTrial`'s; its only effect is the ordinary per-customer
 * override (ADR-0015) — written as 0, never anything else, and only when the customer has
 * none — taken under the same customer lock a claim and an operator's override take, so
 * an import never lands between a claim's count and its insert. The record of the
 * decision is written once, beside it, and is what explains the override afterwards.
 *
 * Charged against `users.trial.edit`, the permission an operator's override write takes:
 * this writes the same row for the same reason. Deny by default — the P7 importer, on
 * hold, will act as an actor that holds it.
 */
export class LegacyTrialEligibilityService {
  constructor(private readonly deps: LegacyTrialEligibilityServiceDeps) {}

  async preserve(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly legacy: LegacyTrialFacts;
    },
  ): Promise<LegacyTrialResult> {
    const customerId = this.customerId(input.customerId);
    const denial = {
      action: 'trial.legacy.preserve',
      entityType: 'Customer',
      entityId: customerId,
    };
    await this.authorize(scope, actor, denial);

    const inputHash = legacyTrialInputHash(input.legacy);
    const requestHash = hashRequest({ customerId, inputHash });
    const replay = await this.deps.idempotency.find<{ outcome: LegacyTrialOutcome }>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const record = await this.deps.records.find(scope, customerId);
      if (record !== null) return { outcome: replay.result.outcome, record };
    }

    const now = this.deps.clock.now();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      TRIAL_OVERRIDE_PERMISSION,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        if (!(await this.deps.wallet.lockCustomer(scope, customerId, tx))) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }

        const decided = await this.deps.records.find(scope, customerId, tx);
        if (decided !== null) {
          const outcome: LegacyTrialOutcome =
            decided.inputHash === inputHash ? 'REPLAYED' : 'CONFLICT';
          await rememberOnce(
            this.deps.idempotency,
            scope,
            actor.surface,
            input.idempotencyKey,
            requestHash,
            { outcome },
            tx,
          );
          return { outcome, record: decided };
        }

        const before = await this.deps.overrides.find(scope, customerId, tx);
        const verdict = decideLegacyTrial(input.legacy, before?.limit ?? null);
        // Only ever written over NO override, and only ever as 0: the import tightens or
        // defers, and an existing override is an operator's decision it never touches.
        if (before === null && verdict.overrideAfter !== null) {
          await this.deps.overrides.upsert(scope, customerId, verdict.overrideAfter, now, tx);
        }
        const record = await this.deps.records.insert(
          scope,
          {
            customerId,
            legacyLimitUsertest: verdict.legacyLimit,
            legacyHadTrial: input.legacy.hadTrial,
            decision: verdict.decision,
            overrideBefore: before?.limit ?? null,
            overrideAfter: verdict.overrideAfter,
            inputHash,
          },
          now,
          tx,
        );

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'trial.legacy.preserve',
            entityType: 'Customer',
            entityId: customerId,
            before: { override: before?.limit ?? null },
            after: {
              override: verdict.overrideAfter,
              decision: verdict.decision,
              legacyLimitUsertest: verdict.legacyLimit,
              legacyHadTrial: input.legacy.hadTrial,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          actor.surface,
          input.idempotencyKey,
          requestHash,
          { outcome: 'APPLIED' },
          tx,
        );
        return { outcome: 'APPLIED' as const, record };
      },
    );
  }

  private customerId(candidate: string): UserId {
    const parsed = userIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid customer identifier.',
      );
    }
    return parsed.data;
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

  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, TRIAL_OVERRIDE_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        TRIAL_OVERRIDE_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }
}
