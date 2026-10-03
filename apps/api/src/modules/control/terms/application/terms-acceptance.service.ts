import {
  COMMERCE_ERROR_CODES,
  TERMS_ENFORCEMENT_FLAG,
  errors,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { FeatureFlagResolver } from '../../features/application/feature-flags.service.js';
import type { PublishedTermsVersion, TermsAcceptanceRecord, TermsRepository } from './ports.js';

/**
 * The permission a customer's acceptance is written under. The Telegram surface acts as
 * `SYSTEM_JOB`, which holds exactly `maintenance.run`, as `CustomerService` does for the
 * customer's own row (`RESOLVE_CUSTOMER_PERMISSION`): system work triggered by a customer.
 */
export const TERMS_ACCEPT_PERMISSION = 'maintenance.run' satisfies PermissionKey;

export interface TermsAcceptanceServiceDeps {
  readonly repository: TermsRepository;
  readonly flags: Pick<FeatureFlagResolver, 'isEnabled'>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly outbox: OutboxWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/** What the accept button produced. */
export type TermsAcceptOutcome =
  | {
      /** Recorded now (`changed`) or already recorded before: either way, accepted. */
      readonly outcome: 'ACCEPTED';
      readonly changed: boolean;
      readonly version: PublishedTermsVersion;
    }
  | {
      /**
       * The button named a version that is not the current one — the rules changed after
       * the customer was shown them, or the id was never one of this tenant's. NOTHING was
       * written; `current` is what to show instead (null: nothing is published).
       */
      readonly outcome: 'STALE';
      readonly current: PublishedTermsVersion | null;
    };

/** One customer's standing, as Customer 360 shows it and as the gate decides it. */
export interface CustomerTermsStanding {
  readonly enforced: boolean;
  readonly current: PublishedTermsVersion | null;
  readonly lastAccepted: TermsAcceptanceRecord | null;
  readonly acceptedCurrent: boolean;
  readonly reacceptanceRequired: boolean;
}

interface AcceptReplay {
  readonly outcome: 'ACCEPTED' | 'STALE';
  readonly changed: boolean;
}

/**
 * The customer's side of the terms and rules (program §6).
 *
 * `requirement` is the ONE question the Telegram gate asks (`BotRuntime.guardedAct`):
 * which version, if any, this customer must accept before anything else is done for them.
 * It reads the flag, the newest published version and this customer's acceptance of THAT
 * version — so a new publication requires everybody again with nothing written, and an
 * older acceptance never counts for a newer version.
 *
 * `accept` records the version the BUTTON names, and only when it is still the current
 * one: a button under an old message, or a crafted id, writes nothing and answers STALE
 * with what to show instead. A repeated tap writes nothing either (the once-key), so it is
 * idempotent by the row as well as by the update's key.
 */
export class TermsAcceptanceService {
  constructor(private readonly deps: TermsAcceptanceServiceDeps) {}

  /** The version this customer must accept now, or null when nothing stops them. */
  async requirement(
    scope: TenantContext,
    customerId: string,
  ): Promise<PublishedTermsVersion | null> {
    if (!(await this.deps.flags.isEnabled(scope, TERMS_ENFORCEMENT_FLAG))) return null;
    const current = await this.deps.repository.current(scope);
    if (current === null) return null;
    return (await this.deps.repository.hasAccepted(scope, customerId, current.id)) ? null : current;
  }

  /**
   * The customer's standing for Customer 360. Charges nothing itself: its only caller is
   * the overview, which has already charged `users.view` for this customer.
   */
  async standing(scope: TenantContext, customerId: string): Promise<CustomerTermsStanding> {
    const [enforced, current, lastAccepted] = await Promise.all([
      this.deps.flags.isEnabled(scope, TERMS_ENFORCEMENT_FLAG),
      this.deps.repository.current(scope),
      this.deps.repository.lastAcceptance(scope, customerId),
    ]);
    const acceptedCurrent =
      current !== null && (await this.deps.repository.hasAccepted(scope, customerId, current.id));
    return {
      enforced,
      current,
      lastAccepted,
      acceptedCurrent,
      reacceptanceRequired: enforced && current !== null && !acceptedCurrent,
    };
  }

  async accept(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly termsVersionId: string;
      readonly botInstanceId: string | null;
    },
  ): Promise<TermsAcceptOutcome> {
    await this.deps.guard.check(scope, actor, TERMS_ACCEPT_PERMISSION);
    const requestHash = hashRequest({
      customerId: input.customerId,
      termsVersionId: input.termsVersionId,
    });
    const replay = await this.deps.idempotency.find<AcceptReplay>(
      scope,
      actor.surface,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const current = await this.deps.repository.current(scope);
      if (replay.result.outcome === 'ACCEPTED' && current?.id === input.termsVersionId) {
        return { outcome: 'ACCEPTED', changed: replay.result.changed, version: current };
      }
      if (replay.result.outcome === 'STALE') return { outcome: 'STALE', current };
      // Accepted then, superseded since: answered as what it is now.
    }

    const now = this.deps.clock.now();
    return runAuthorizedMutation(
      {
        uow: this.deps.uow,
        guard: this.deps.guard,
        audit: this.deps.audit,
        opsLog: this.deps.opsLog,
        sessions: this.deps.sessions,
        clock: this.deps.clock,
      },
      scope,
      actor,
      TERMS_ACCEPT_PERMISSION,
      { action: 'customer.terms_accept', entityType: 'Customer', entityId: input.customerId },
      async (tx): Promise<TermsAcceptOutcome> => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        /*
         * Decided here, inside the write's transaction: the version the button names must be
         * the CURRENT one. An older version (a newer one was published after the message was
         * sent) or an id that is not this tenant's at all writes nothing. A publication that
         * commits after this read records an acceptance of the version the customer was
         * actually shown — a true fact — and the gate asks again for the new one.
         */
        const current = await this.deps.repository.current(scope, tx);
        if (current === null || current.id !== input.termsVersionId) {
          await this.remember(scope, actor, input.idempotencyKey, requestHash, 'STALE', false, tx);
          return { outcome: 'STALE', current };
        }
        const changed = await this.deps.repository.insertAcceptance(
          scope,
          {
            id: this.deps.ids.uuid(),
            customerId: input.customerId,
            termsVersionId: current.id,
            acceptedAt: now,
            source: 'TELEGRAM',
            botInstanceId: input.botInstanceId,
            correlationId: actor.correlationId,
          },
          tx,
        );
        // Only the row that was written is audited and announced: a repeated tap changed
        // nothing, and an audit entry for a change that did not happen is an activity feed.
        if (changed) {
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'customer.terms_accept',
              entityType: 'Customer',
              entityId: input.customerId,
              before: null,
              after: {
                termsVersionId: current.id,
                versionNumber: current.versionNumber,
                source: 'TELEGRAM',
              },
              result: 'SUCCESS',
            },
            tx,
          );
          await this.deps.outbox.write(tx, actor, {
            eventType: 'CustomerTermsAccepted',
            aggregateType: 'Customer',
            aggregateId: input.customerId,
            payload: { termsVersionId: current.id, versionNumber: current.versionNumber },
          });
        }
        await this.remember(
          scope,
          actor,
          input.idempotencyKey,
          requestHash,
          'ACCEPTED',
          changed,
          tx,
        );
        return { outcome: 'ACCEPTED', changed, version: current };
      },
    );
  }

  private async remember(
    scope: TenantContext,
    actor: ActorContext,
    idempotencyKey: string,
    requestHash: string,
    outcome: AcceptReplay['outcome'],
    changed: boolean,
    tx: TransactionScope,
  ): Promise<void> {
    await rememberOnce(
      this.deps.idempotency,
      scope,
      actor.surface,
      idempotencyKey,
      requestHash,
      { outcome, changed } satisfies AcceptReplay,
      tx,
    );
  }
}
