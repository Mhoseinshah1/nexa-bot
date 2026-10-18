import {
  COMMERCE_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  errors,
  userIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyNamespace,
  type IdempotencyRecord,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
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
import { recordAuditMany } from '../../../platform/audit/application/record-audit-many.js';
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

/** The P7 importer's permission: what `SYSTEM_JOB` holds (`SYSTEM_JOB_PERMISSIONS`). */
export const LEGACY_TRIAL_IMPORT_PERMISSION: PermissionKey = 'maintenance.run';

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

/**
 * What `preserveManyForImport` needs beyond the one-customer ports: the same reads and writes
 * for many customers at once (the Drizzle repositories and store have them).
 */
export interface LegacyTrialBulkPorts {
  readonly records: {
    findMany(
      scope: TenantContext,
      customerIds: readonly UserId[],
      tx?: TransactionScope,
    ): Promise<ReadonlyMap<string, LegacyTrialRecord>>;
    insertMany(
      scope: TenantContext,
      records: readonly Omit<LegacyTrialRecord, 'recordedAt'>[],
      now: Date,
      tx: TransactionScope,
    ): Promise<LegacyTrialRecord[]>;
  };
  readonly overrides: {
    findMany(
      scope: TenantContext,
      customerIds: readonly UserId[],
      tx?: TransactionScope,
    ): Promise<ReadonlyMap<string, { readonly limit: number }>>;
    upsertMany(
      scope: TenantContext,
      overrides: readonly { readonly customerId: UserId; readonly limit: number }[],
      now: Date,
      tx: TransactionScope,
    ): Promise<void>;
  };
  readonly wallet: {
    lockCustomers(
      scope: TenantContext,
      customerIds: readonly UserId[],
      tx: unknown,
    ): Promise<ReadonlyMap<string, string | null>>;
  };
  readonly idempotency: {
    findMany<TResult>(
      scope: TenantContext,
      namespace: IdempotencyNamespace,
      requests: readonly { readonly key: string; readonly requestHash: string }[],
    ): Promise<ReadonlyMap<string, IdempotencyRecord<TResult> | 'PAYLOAD_MISMATCH'>>;
    rememberMany<TResult>(
      scope: TenantContext,
      namespace: IdempotencyNamespace,
      entries: readonly {
        readonly key: string;
        readonly requestHash: string;
        readonly result: TResult;
      }[],
      tx?: unknown,
    ): Promise<ReadonlySet<string>>;
  };
}

/**
 * One customer's answer from `preserveManyForImport`: `preserveForImport`'s result, or
 * `PAYLOAD_MISMATCH` where it would have thrown `IDEMPOTENCY_PAYLOAD_MISMATCH` (its key was
 * used with other facts: nothing written for it).
 */
export type LegacyTrialBatchResult =
  | { readonly kind: 'RESULT'; readonly result: LegacyTrialResult }
  | { readonly kind: 'PAYLOAD_MISMATCH' };

export interface LegacyTrialEligibilityServiceDeps {
  readonly records: LegacyTrialEligibilityRepository & LegacyTrialBulkPorts['records'];
  readonly overrides: Pick<TrialOverrideRepository, 'find' | 'upsert'> &
    LegacyTrialBulkPorts['overrides'];
  /** The customer row lock — the one `TrialService.claim` decides under. */
  readonly wallet: Pick<WalletRepository, 'lockCustomer'> & LegacyTrialBulkPorts['wallet'];
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore & LegacyTrialBulkPorts['idempotency'];
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
 * this writes the same row for the same reason. Deny by default. The P7 importer, a
 * `SYSTEM_JOB` CLI, calls `preserveForImport`, charged to `maintenance.run` instead.
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
    return this.preserveUnder(TRIAL_OVERRIDE_PERMISSION, scope, actor, input);
  }

  /**
   * The same decision, charged to `maintenance.run` — the P7 importer's entry point
   * (`docs/legacy-migration/importer.md` §Actors). The importer is a CLI acting as
   * `SYSTEM_JOB`, which holds `SYSTEM_JOB_PERMISSIONS` (`maintenance.run`) and nothing
   * else; widening that set, or acting as an administrator the CLI never authenticated,
   * would each be worse than one named entry point. Like `RESOLVE_CUSTOMER_PERMISSION`,
   * the permission is chosen by the METHOD, never by inspecting the actor's type; an
   * operator who holds `maintenance.run` may call it too, and one who does not is denied
   * and audited exactly as `preserve` denies.
   */
  async preserveForImport(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly legacy: LegacyTrialFacts;
    },
  ): Promise<LegacyTrialResult> {
    return this.preserveUnder(LEGACY_TRIAL_IMPORT_PERMISSION, scope, actor, input);
  }

  private async preserveUnder(
    permission: PermissionKey,
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
    await this.authorize(scope, actor, permission, denial);

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
      permission,
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

  /**
   * `preserveForImport` for many customers: the one-time import's trial decisions, which
   * `preserveForImport` would make in a transaction each, in ONE transaction and a handful
   * of statements — the same decisions, rows and answers.
   *
   * In `preserveForImport`'s order: every id is validated first; the permission is charged
   * once (and again inside the transaction); the idempotency records of every key are read
   * (a key used with other facts is `PAYLOAD_MISMATCH`; a replay whose record exists answers
   * with its remembered outcome, as `preserveForImport` does); then, for the rest, in one
   * transaction: the scope must accept work, every customer's wallet row is locked (in id
   * order; an unknown customer throws and nothing of the batch is written — the importer's
   * resume writes it again by key), an existing decision answers REPLAYED or CONFLICT, the
   * others are decided by `decideLegacyTrial` over the override found, the override written
   * only where there was none, the record, the audit row and the idempotency record written
   * as `preserveForImport` writes them. A key another writer stored meanwhile throws
   * `IDEMPOTENCY_IN_FLIGHT`, as `rememberOnce` does.
   */
  async preserveManyForImport(
    scope: TenantContext,
    actor: ActorContext,
    inputs: readonly {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly legacy: LegacyTrialFacts;
    }[],
  ): Promise<LegacyTrialBatchResult[]> {
    if (inputs.length === 0) return [];
    const permission = LEGACY_TRIAL_IMPORT_PERMISSION;
    const items = inputs.map((input) => {
      const customerId = this.customerId(input.customerId);
      const inputHash = legacyTrialInputHash(input.legacy);
      return {
        key: input.idempotencyKey,
        customerId,
        legacy: input.legacy,
        inputHash,
        requestHash: hashRequest({ customerId, inputHash }),
      };
    });
    if (
      new Set(items.map((i) => i.key)).size !== items.length ||
      new Set(items.map((i) => i.customerId)).size !== items.length
    ) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'One batch names each customer and each key once.',
      );
    }
    const denial = { action: 'trial.legacy.preserve', entityType: 'Customer', entityId: null };
    await this.authorize(scope, actor, permission, denial);

    const results: (LegacyTrialBatchResult | null)[] = items.map(() => null);
    const replays = await this.deps.idempotency.findMany<{ outcome: LegacyTrialOutcome }>(
      scope,
      actor.surface,
      items,
    );
    const replayed = items.filter((item) => {
      const replay = replays.get(item.key);
      return replay !== undefined && replay !== 'PAYLOAD_MISMATCH';
    });
    const replayRecords =
      replayed.length === 0
        ? new Map<string, LegacyTrialRecord>()
        : await this.deps.records.findMany(
            scope,
            replayed.map((i) => i.customerId),
          );
    const pending: number[] = [];
    items.forEach((item, index) => {
      const replay = replays.get(item.key);
      if (replay === 'PAYLOAD_MISMATCH') {
        results[index] = { kind: 'PAYLOAD_MISMATCH' };
        return;
      }
      const record = replay === undefined ? undefined : replayRecords.get(item.customerId);
      if (replay !== undefined && record !== undefined) {
        results[index] = { kind: 'RESULT', result: { outcome: replay.result.outcome, record } };
        return;
      }
      pending.push(index);
    });
    if (pending.length === 0) return allDecided(results);

    const now = this.deps.clock.now();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      permission,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        const work = pending.map((index) => ({
          index,
          item: items[index] as (typeof items)[number],
        }));
        const ids = work.map((w) => w.item.customerId);
        const locked = await this.deps.wallet.lockCustomers(scope, ids, tx);
        for (const w of work) {
          if (!locked.has(w.item.customerId)) {
            throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
          }
        }
        const decidedAlready = await this.deps.records.findMany(scope, ids, tx);
        const undecided = work.filter((w) => !decidedAlready.has(w.item.customerId));
        const before = await this.deps.overrides.findMany(
          scope,
          undecided.map((w) => w.item.customerId),
          tx,
        );
        const remember: {
          key: string;
          requestHash: string;
          result: { outcome: LegacyTrialOutcome };
        }[] = [];
        for (const w of work) {
          const decided = decidedAlready.get(w.item.customerId);
          if (decided === undefined) continue;
          const outcome: LegacyTrialOutcome =
            decided.inputHash === w.item.inputHash ? 'REPLAYED' : 'CONFLICT';
          remember.push({ key: w.item.key, requestHash: w.item.requestHash, result: { outcome } });
          results[w.index] = { kind: 'RESULT', result: { outcome, record: decided } };
        }
        const verdicts = undecided.map((w) => {
          const prior = before.get(w.item.customerId);
          return { w, prior, verdict: decideLegacyTrial(w.item.legacy, prior?.limit ?? null) };
        });
        // Only ever written over NO override, and only ever as 0: the import tightens or
        // defers, and an existing override is an operator's decision it never touches.
        const overrides: { customerId: UserId; limit: number }[] = [];
        for (const { w, prior, verdict } of verdicts) {
          if (prior === undefined && verdict.overrideAfter !== null) {
            overrides.push({ customerId: w.item.customerId, limit: verdict.overrideAfter });
          }
        }
        await this.deps.overrides.upsertMany(scope, overrides, now, tx);
        const records = await this.deps.records.insertMany(
          scope,
          verdicts.map(({ w, prior, verdict }) => ({
            customerId: w.item.customerId,
            legacyLimitUsertest: verdict.legacyLimit,
            legacyHadTrial: w.item.legacy.hadTrial,
            decision: verdict.decision,
            overrideBefore: prior?.limit ?? null,
            overrideAfter: verdict.overrideAfter,
            inputHash: w.item.inputHash,
          })),
          now,
          tx,
        );
        await recordAuditMany(
          this.deps.audit,
          scope,
          actor,
          verdicts.map(({ w, prior, verdict }) => ({
            action: 'trial.legacy.preserve',
            entityType: 'Customer',
            entityId: w.item.customerId,
            before: { override: prior?.limit ?? null },
            after: {
              override: verdict.overrideAfter,
              decision: verdict.decision,
              legacyLimitUsertest: verdict.legacyLimit,
              legacyHadTrial: w.item.legacy.hadTrial,
            },
            result: 'SUCCESS' as const,
          })),
          tx,
        );
        verdicts.forEach(({ w }, i) => {
          const record = records[i];
          if (record === undefined) throw new Error('a trial record was not written');
          remember.push({
            key: w.item.key,
            requestHash: w.item.requestHash,
            result: { outcome: 'APPLIED' },
          });
          results[w.index] = { kind: 'RESULT', result: { outcome: 'APPLIED', record } };
        });
        const stored = await this.deps.idempotency.rememberMany(scope, actor.surface, remember, tx);
        const lost = remember.find((r) => !stored.has(r.key));
        if (lost !== undefined) {
          throw errors.conflict(
            PLATFORM_ERROR_CODES.IDEMPOTENCY_IN_FLIGHT,
            `Another request using idempotency key "${lost.key}" completed first. ` +
              'Retry to read its result.',
            { key: lost.key },
          );
        }
        return allDecided(results);
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
    permission: PermissionKey,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (error) {
      await recordMutationDenial(this.mutationDeps(), scope, actor, permission, denial, error);
      throw error;
    }
  }
}

/** Every answer of a batch, decided: a gap is a defect, never a silent skip. */
function allDecided(results: readonly (LegacyTrialBatchResult | null)[]): LegacyTrialBatchResult[] {
  return results.map((result) => {
    if (result === null) throw new Error('a trial in the batch was not decided');
    return result;
  });
}
