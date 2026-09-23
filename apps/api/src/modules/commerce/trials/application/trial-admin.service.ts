import {
  COMMERCE_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  TRIAL_ADMIN_REASON_MAX_LENGTH,
  TRIAL_LIMIT_MAX,
  TRIAL_LIMIT_MIN,
  TRIAL_RESET_PREVIEW_SAMPLE,
  errors,
  userIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
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
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { FeatureFlagResolver } from '../../../control/features/application/feature-flags.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import type { WalletRepository } from '../../wallet/application/ports.js';
import type {
  TrialGrantRepository,
  TrialOverrideCursor,
  TrialOverrideListRow,
  TrialOverrideRepository,
  TrialResetCursor,
  TrialResetPreview,
  TrialResetRecord,
  TrialResetRepository,
} from './ports.js';
import { trialAllowanceFor, type TrialAllowance } from './trial-allowance.js';

/** Reading a customer's allowance, and the list of custom limits: customer data. */
export const TRIAL_VIEW_PERMISSION: PermissionKey = 'users.view';
/** Setting or removing one customer's custom limit (`docs/wp6-audit.md` B2). */
export const TRIAL_OVERRIDE_PERMISSION: PermissionKey = 'users.trial.edit';
/** The global reset, preview included: a bulk mutation under ADR-0010 (B3). */
export const TRIAL_RESET_PERMISSION: PermissionKey = 'settings.destructive';
/** The reset history: a record of configuration changes, readable like settings. */
export const TRIAL_RESET_HISTORY_PERMISSION: PermissionKey = 'settings.view';

const NAMESPACE = 'WEB' as const;

export interface TrialAdminServiceDeps {
  readonly grants: Pick<TrialGrantRepository, 'countCounting'>;
  readonly overrides: TrialOverrideRepository;
  readonly resets: TrialResetRepository;
  readonly customers: Pick<CustomerRepository, 'findById'>;
  /** The customer row lock — the one a trial claim decides under. */
  readonly wallet: Pick<WalletRepository, 'lockCustomer'>;
  readonly settings: SettingsResolver;
  readonly features: FeatureFlagResolver;
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

/**
 * The operator's side of trials: ADR-0015's per-customer override, its global reset
 * and the view that shows both. `docs/wp6-audit.md` §7.
 *
 * Every number shown comes from `trialAllowanceFor`, the evaluator `TrialService`
 * decides a claim with, so this screen cannot compute an allowance the claim would not.
 * Every write takes a `ScopeContext` and an `ActorContext`, checks its permission
 * through the guard, reads scope activity inside its transaction, is idempotent by key
 * and is audited with before and after.
 */
export class TrialAdminService {
  constructor(private readonly deps: TrialAdminServiceDeps) {}

  /** One customer's allowance, the stored override echoed (ADR-0015). */
  async allowance(
    scope: TenantContext,
    actor: ActorContext,
    candidate: string,
  ): Promise<TrialAllowance> {
    await this.deps.guard.check(scope, actor, TRIAL_VIEW_PERMISSION);
    const customerId = this.customerId(candidate);
    await this.requireCustomer(scope, customerId);
    return trialAllowanceFor(this.deps, scope, customerId);
  }

  async listOverrides(
    scope: TenantContext,
    actor: ActorContext,
    page: { readonly limit: number; readonly cursor: TrialOverrideCursor | null },
  ): Promise<{
    readonly items: readonly TrialOverrideListRow[];
    readonly nextCursor: TrialOverrideCursor | null;
  }> {
    await this.deps.guard.check(scope, actor, TRIAL_VIEW_PERMISSION);
    return this.deps.overrides.list(scope, page.limit, page.cursor);
  }

  /** Set, or replace, a customer's custom limit. */
  async setOverride(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly limit: number;
      readonly reason: string | null;
    },
  ): Promise<TrialAllowance> {
    const customerId = this.customerId(input.customerId);
    if (
      !Number.isInteger(input.limit) ||
      input.limit < TRIAL_LIMIT_MIN ||
      input.limit > TRIAL_LIMIT_MAX
    ) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        `A trial limit is a whole number from ${String(TRIAL_LIMIT_MIN)} to ${String(TRIAL_LIMIT_MAX)}.`,
      );
    }
    const reason = this.note(input.reason);
    return this.writeOverride(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      customerId,
      reason,
      to: input.limit,
    });
  }

  /**
   * Remove a customer's custom limit. The row is DELETED, never overwritten with the
   * default's value, so a later change to the default applies to them again.
   */
  async removeOverride(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly reason: string | null;
    },
  ): Promise<TrialAllowance> {
    const customerId = this.customerId(input.customerId);
    return this.writeOverride(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      customerId,
      reason: this.note(input.reason),
      to: null,
    });
  }

  /**
   * Both directions in one place, so neither can lose its lock, its audit row or its
   * activity check. `to: null` removes.
   */
  private async writeOverride(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: UserId;
      readonly reason: string | null;
      readonly to: number | null;
    },
  ): Promise<TrialAllowance> {
    const action = input.to === null ? 'trial.override.remove' : 'trial.override.set';
    const denial = { action, entityType: 'Customer', entityId: input.customerId };
    const requestHash = hashRequest({
      customerId: input.customerId,
      to: input.to,
      reason: input.reason,
    });
    // Before the replay, under the COMMAND's permission: a replay is the same decision.
    await this.authorize(scope, actor, TRIAL_OVERRIDE_PERMISSION, denial);

    const replay = await this.deps.idempotency.find<{ customerId: string }>(
      scope,
      NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      // The allowance as it is NOW. A replay answers "is it done", and the override is
      // the stored value — echoing a snapshot from the first call would show a limit
      // somebody may since have changed.
      await this.requireCustomer(scope, input.customerId);
      return trialAllowanceFor(this.deps, scope, input.customerId);
    }

    const now = this.deps.clock.now();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      TRIAL_OVERRIDE_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        /*
         * The customer's row lock, the one `TrialService.claim` decides under. A claim
         * in flight therefore finishes with the limit it read, and the next one reads
         * this; an override never lands between a claim's count and its insert.
         */
        if (!(await this.deps.wallet.lockCustomer(scope, input.customerId, tx))) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }
        const before = await this.deps.overrides.find(scope, input.customerId, tx);
        let changed: boolean;
        if (input.to === null) {
          changed = await this.deps.overrides.remove(scope, input.customerId, tx);
        } else {
          changed = before?.limit !== input.to;
          await this.deps.overrides.upsert(scope, input.customerId, input.to, now, tx);
        }
        const after = await trialAllowanceFor(this.deps, scope, input.customerId, tx);

        await this.deps.audit.record(
          scope,
          actor,
          {
            action,
            entityType: 'Customer',
            entityId: input.customerId,
            before: { override: before === null ? null : before.limit },
            after: {
              override: after.override === null ? null : after.override.limit,
              effectiveLimit: after.effectiveLimit,
              used: after.used,
              changed,
            },
            result: 'SUCCESS',
            ...(input.reason === null ? {} : { reason: input.reason }),
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          NAMESPACE,
          input.idempotencyKey,
          requestHash,
          { customerId: input.customerId },
          tx,
        );
        return after;
      },
    );
  }

  /**
   * ADR-0010 steps 1 and 2: what a reset would stamp now. Writes nothing.
   *
   * Charged `users.view` as well as `settings.destructive` (Codex, PR #65): the sample
   * names customers — their ids, Telegram ids, usernames and first names — and the
   * catalogue gates that data behind `users.view`, which `settings.destructive` does not
   * require. A custom role holding one and not the other must not read customers
   * through the reset screen.
   */
  async previewReset(scope: TenantContext, actor: ActorContext): Promise<TrialResetPreview> {
    await this.deps.guard.check(scope, actor, TRIAL_RESET_PERMISSION);
    await this.deps.guard.check(scope, actor, TRIAL_VIEW_PERMISSION);
    return this.deps.resets.preview(scope, TRIAL_RESET_PREVIEW_SAMPLE);
  }

  /**
   * ADR-0010 steps 3 to 5: the confirmed reset, audited and recorded.
   *
   * `expectedGrants` is the count the operator was shown and typed back. The reset
   * stamps, then compares, in one transaction: a different count rolls everything back
   * and is refused as `TRIAL_RESET_STALE`, so a preview can only ever authorise the
   * reset it described.
   */
  async executeReset(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly expectedGrants: number;
      readonly expectedFingerprint: string;
      readonly reason: string;
    },
  ): Promise<TrialResetRecord> {
    const reason = this.note(input.reason);
    if (reason === null) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'A global trial reset needs a reason.',
      );
    }
    if (!Number.isInteger(input.expectedGrants) || input.expectedGrants < 1) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'Confirm the number of trials the preview showed.',
      );
    }
    const denial = { action: 'trial.reset', entityType: 'Tenant', entityId: scope.tenantId };
    const requestHash = hashRequest({
      expectedGrants: input.expectedGrants,
      expectedFingerprint: input.expectedFingerprint,
      reason,
    });
    await this.authorize(scope, actor, TRIAL_RESET_PERMISSION, denial);
    // `trial_resets.actor_admin_id` is NOT NULL: a reset is a person's decision, and a
    // job holding the permission is not a person who can be asked why.
    const actorAdminId = actor.id;
    if ((actor.type !== 'WEB_ADMIN' && actor.type !== 'TELEGRAM_ADMIN') || actorAdminId === null) {
      throw errors.permissionDenied(
        PLATFORM_ERROR_CODES.PERMISSION_DENIED,
        'Only an administrator can reset trials.',
      );
    }

    const replay = await this.deps.idempotency.find<{ resetId: string }>(
      scope,
      NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const recorded = await this.deps.resets.findById(scope, replay.result.resetId);
      if (recorded !== null) return recorded;
    }

    const now = this.deps.clock.now();
    const id = this.deps.ids.uuid();
    try {
      return await this.stampAndRecord(scope, actor, denial, requestHash, {
        ...input,
        id,
        actorAdminId,
        reason,
        now,
      });
    } catch (error) {
      /*
       * The same command, twice, at once (Codex, PR #65).
       *
       * Both miss the replay read above; the winner stamps, remembers its key and commits;
       * the loser's UPDATE waits on the winner's rows and then stamps nothing, so it is
       * refused as NOTHING — or as STALE, when a claim arrived meanwhile — although the
       * identical request succeeded. Its transaction has rolled back, so a fresh read now
       * sees the winner's key, and the loser answers with the reset that was recorded.
       */
      const code = (error as { code?: unknown } | null)?.code;
      if (
        code === COMMERCE_ERROR_CODES.TRIAL_RESET_NOTHING ||
        code === COMMERCE_ERROR_CODES.TRIAL_RESET_STALE
      ) {
        const settled = await this.deps.idempotency.find<{ resetId: string }>(
          scope,
          NAMESPACE,
          input.idempotencyKey,
          requestHash,
        );
        if (settled !== null) {
          const recorded = await this.deps.resets.findById(scope, settled.result.resetId);
          if (recorded !== null) return recorded;
        }
      }
      throw error;
    }
  }

  /** The one transaction a reset is: stamp, compare with the confirmation, audit, remember. */
  private stampAndRecord(
    scope: TenantContext,
    actor: ActorContext,
    denial: { readonly action: string; readonly entityType: string; readonly entityId: string },
    requestHash: string,
    input: {
      readonly idempotencyKey: string;
      readonly expectedGrants: number;
      readonly expectedFingerprint: string;
      readonly id: string;
      readonly actorAdminId: string;
      readonly reason: string;
      readonly now: Date;
    },
  ): Promise<TrialResetRecord> {
    const { id, actorAdminId, reason, now } = input;
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      TRIAL_RESET_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const recorded = await this.deps.resets.execute(
          scope,
          { id, actorAdminId, reason, now },
          tx,
        );
        if (recorded === null) {
          throw errors.preconditionFailed(
            COMMERCE_ERROR_CODES.TRIAL_RESET_NOTHING,
            'No customer has a trial that counts, so there is nothing to reset.',
          );
        }
        /*
         * The count AND the set (Codex, PR #65). A count alone is satisfied by a
         * different set of the same size — one previewed grant released and another
         * customer's claimed — and then this would reset a grant the operator never saw.
         */
        if (
          recorded.affectedGrants !== input.expectedGrants ||
          recorded.fingerprint !== input.expectedFingerprint
        ) {
          // Thrown INSIDE the transaction: the stamps and the record roll back with it.
          throw errors.conflict(
            COMMERCE_ERROR_CODES.TRIAL_RESET_STALE,
            `The preview showed ${String(input.expectedGrants)} trials and ${String(
              recorded.affectedGrants,
            )} count now. Nothing was reset; preview again.`,
            { expectedGrants: input.expectedGrants, currentGrants: recorded.affectedGrants },
          );
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'trial.reset',
            entityType: 'Tenant',
            entityId: scope.tenantId,
            before: null,
            after: {
              resetId: recorded.id,
              affectedGrants: recorded.affectedGrants,
              affectedCustomers: recorded.affectedCustomers,
            },
            result: 'SUCCESS',
            reason,
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          NAMESPACE,
          input.idempotencyKey,
          requestHash,
          { resetId: recorded.id },
          tx,
        );
        // The fingerprint was for the comparison above; the answer is the record, the
        // same shape a replay reads back from `findById`.
        const { fingerprint: _stamped, ...record } = recorded;
        return record;
      },
    );
  }

  async listResets(
    scope: TenantContext,
    actor: ActorContext,
    page: { readonly limit: number; readonly cursor: TrialResetCursor | null },
  ): Promise<{
    readonly items: readonly TrialResetRecord[];
    readonly nextCursor: TrialResetCursor | null;
  }> {
    await this.deps.guard.check(scope, actor, TRIAL_RESET_HISTORY_PERMISSION);
    return this.deps.resets.list(scope, page.limit, page.cursor);
  }

  /** A customer id, or a 400 rather than a 500 at the uuid cast. See `CustomerService`. */
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

  private async requireCustomer(scope: TenantContext, customerId: UserId): Promise<void> {
    if ((await this.deps.customers.findById(scope, customerId)) === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
  }

  private note(raw: string | null): string | null {
    if (raw === null) return null;
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed.slice(0, TRIAL_ADMIN_REASON_MAX_LENGTH);
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

  /** `recordMutationDenial`, not a bare check — see `ProductService.authorize`. */
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
