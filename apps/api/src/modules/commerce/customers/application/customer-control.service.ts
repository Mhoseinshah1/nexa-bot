import {
  COMMERCE_ERROR_CODES,
  errors,
  normalisePhoneNumber,
  userIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type LocationChangeLimits,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
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
  CustomerLocationOverrideRecord,
  CustomerLocationOverrideRepository,
} from '../../locations/application/ports.js';
import { CUSTOMER_VIEW_PERMISSION } from './customer.service.js';
import type { CustomerRecord, CustomerRepository } from './ports.js';

export const CHANNEL_EXEMPTION_PERMISSION: PermissionKey = 'users.channel_membership.exempt';
export const PHONE_VERIFY_PERMISSION: PermissionKey = 'users.phone.verify';
export const LOCATION_OVERRIDE_PERMISSION: PermissionKey = 'users.location.edit';
export const NOTIFICATIONS_PERMISSION: PermissionKey = 'users.notifications.edit';

/** Everything the Customer 360 page shows about one customer's controls. */
export interface CustomerOverview {
  readonly customer: CustomerRecord;
  readonly locationOverride: CustomerLocationOverrideRecord | null;
}

export interface CustomerControlDeps {
  readonly customers: Pick<
    CustomerRepository,
    'findById' | 'setChannelMembershipExemption' | 'setVerifiedPhone' | 'setMarketingOptOut'
  >;
  readonly locationOverrides: CustomerLocationOverrideRepository;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly idempotency: IdempotencyStore;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/** What one control's write did, for the shared skeleton below. */
interface ControlChange {
  readonly changed: boolean;
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
  /** The domain event, written only when `changed`, in the same transaction. */
  readonly emit: (tx: TransactionScope) => Promise<unknown>;
}

/**
 * Customer 360's per-customer controls (spec §11.4): the channel-membership exemption, a
 * manually verified phone number, the location-change limit override, and the promotional
 * notification preference set on the customer's behalf.
 *
 * One skeleton for all four, so none can lose a step: the permission through the guard (a
 * denial audited), the idempotency key under the ACTOR's surface (a replay answers the state
 * now), and then ONE transaction holding the scope-activity read, the conditional write,
 * the audit row with the operator's reason, the outbox event when something changed, and
 * the remembered key. A write that changed nothing is still audited (`changed: false`) and
 * answered as success: the state the operator asked for holds.
 *
 * Each control has its own key (`permissions.ts` says why `users.edit` is none of them).
 */
/**
 * A phone number as a durable log may hold it: the last four digits, never the number. The
 * audit log is append-only — a full number written there could never be taken back — and
 * the customer's timeline reads it.
 */
export function maskPhone(phone: string | null): string | null {
  if (phone === null) return null;
  return `…${phone.slice(-4)}`;
}

export class CustomerControlService {
  constructor(private readonly deps: CustomerControlDeps) {}

  /** The controls as stored. `users.view`, the customer page's own read. */
  async overview(scope: TenantContext, actor: ActorContext, id: string): Promise<CustomerOverview> {
    await this.deps.guard.check(scope, actor, CUSTOMER_VIEW_PERMISSION);
    return this.read(scope, this.customerId(id));
  }

  /**
   * Exempt a customer from mandatory channel membership, or lift the exemption. The
   * Telegram gate reads the column on every update (`BotRuntime.guardedAct`).
   */
  async setChannelExemption(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly exempt: boolean;
      readonly reason: string;
    },
  ): Promise<{ readonly overview: CustomerOverview; readonly changed: boolean }> {
    return this.run(scope, actor, {
      permission: CHANNEL_EXEMPTION_PERMISSION,
      action: input.exempt
        ? 'customer.channel_exemption.grant'
        : 'customer.channel_exemption.revoke',
      idempotencyKey: input.idempotencyKey,
      customerId: input.customerId,
      reason: input.reason,
      command: { exempt: input.exempt },
      write: async (customerId, before, now, tx) => {
        const changed = await this.deps.customers.setChannelMembershipExemption(
          scope,
          customerId,
          input.exempt,
          now,
          tx,
        );
        return {
          changed,
          before: { exemptAt: before.channelMembershipExemptAt?.toISOString() ?? null },
          after: { exempt: input.exempt },
          emit: (tx) =>
            this.deps.outbox.write(tx, actor, {
              eventType: 'CustomerChannelMembershipExemptionChanged',
              aggregateType: 'Customer',
              aggregateId: customerId,
              payload: { exempt: input.exempt },
            }),
        };
      },
    });
  }

  /**
   * Record a phone number an operator verified out of band, or revoke it (`null`). The
   * number is normalised to `+` and digits and refused rather than guessed when it has no
   * country code. It is never put in an event, and the audit row carries only its last four
   * digits (`maskPhone`).
   */
  async setVerifiedPhone(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly phoneNumber: string | null;
      readonly reason: string;
    },
  ): Promise<{ readonly overview: CustomerOverview; readonly changed: boolean }> {
    const phone = input.phoneNumber === null ? null : normalisePhoneNumber(input.phoneNumber);
    if (input.phoneNumber !== null && phone === null) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.CUSTOMER_PHONE_INVALID,
        'Give the number with its country code, for example +989121234567.',
      );
    }
    return this.run(scope, actor, {
      permission: PHONE_VERIFY_PERMISSION,
      action: phone === null ? 'customer.phone.revoke' : 'customer.phone.verify',
      idempotencyKey: input.idempotencyKey,
      customerId: input.customerId,
      reason: input.reason,
      command: { phone },
      write: async (customerId, before, now, tx) => {
        const changed = await this.deps.customers.setVerifiedPhone(
          scope,
          customerId,
          phone,
          now,
          tx,
        );
        return {
          changed,
          // Masked: the audit log is append-only and the timeline reads it, so the full
          // number is never written there (Codex review of #146). The row keeps it.
          before: { phoneNumber: maskPhone(before.phoneNumber) },
          after: { phoneNumber: maskPhone(phone) },
          emit: (tx) =>
            this.deps.outbox.write(tx, actor, {
              eventType: 'CustomerPhoneVerificationChanged',
              aggregateType: 'Customer',
              aggregateId: customerId,
              payload: { verified: phone !== null },
            }),
        };
      },
    });
  }

  /**
   * Set (or, with `null`, remove) the limits that replace the configured cooldown and
   * rolling limit for this customer's location changes. `LocationChangePolicy` reads the
   * row at every decision, so the next button, quote and confirmation apply it.
   */
  async setLocationOverride(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly limits: LocationChangeLimits | null;
      readonly reason: string;
    },
  ): Promise<{ readonly overview: CustomerOverview; readonly changed: boolean }> {
    const limits = input.limits;
    if (limits !== null && (limits.maxChanges === null) !== (limits.periodDays === null)) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'A rolling limit is a count and a period, or neither.',
      );
    }
    return this.run(scope, actor, {
      permission: LOCATION_OVERRIDE_PERMISSION,
      action:
        limits === null ? 'customer.location_override.remove' : 'customer.location_override.set',
      idempotencyKey: input.idempotencyKey,
      customerId: input.customerId,
      reason: input.reason,
      command: { limits },
      write: async (customerId, _before, now, tx) => {
        const previous = await this.deps.locationOverrides.find(scope, customerId, tx);
        const changed =
          limits === null
            ? await this.deps.locationOverrides.remove(scope, customerId, tx)
            : await this.deps.locationOverrides.upsert(scope, customerId, limits, now, tx);
        return {
          changed,
          before: { limits: previous?.limits ?? null },
          after: { limits },
          emit: (tx) =>
            this.deps.outbox.write(tx, actor, {
              eventType: 'CustomerLocationChangeOverrideChanged',
              aggregateType: 'Customer',
              aggregateId: customerId,
              payload: { overridden: limits !== null },
            }),
        };
      },
    });
  }

  /**
   * The promotional opt-out, set on the customer's behalf — the same column and the same
   * conditional UPDATE `/stop` writes, so the broadcast audience reads one fact whoever set
   * it. Transactional notifications are never affected.
   */
  async setMarketingPreference(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly optedOut: boolean;
      readonly reason: string;
    },
  ): Promise<{ readonly overview: CustomerOverview; readonly changed: boolean }> {
    return this.run(scope, actor, {
      permission: NOTIFICATIONS_PERMISSION,
      action: input.optedOut ? 'customer.marketing_opt_out' : 'customer.marketing_opt_in',
      idempotencyKey: input.idempotencyKey,
      customerId: input.customerId,
      reason: input.reason,
      command: { marketingOptOut: input.optedOut },
      write: async (customerId, before, now, tx) => {
        const changed = await this.deps.customers.setMarketingOptOut(
          scope,
          customerId,
          input.optedOut,
          now,
          tx,
        );
        return {
          changed,
          before: { marketingOptOutAt: before.marketingOptOutAt?.toISOString() ?? null },
          after: { optedOut: input.optedOut },
          emit: (tx) =>
            this.deps.outbox.write(tx, actor, {
              eventType: 'CustomerMarketingOptOutChanged',
              aggregateType: 'Customer',
              aggregateId: customerId,
              payload: { optedOut: input.optedOut },
            }),
        };
      },
    });
  }

  // --- the skeleton ------------------------------------------------------------------------

  private async run(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly permission: PermissionKey;
      readonly action: string;
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly reason: string;
      /** What the command asks for: hashed with the customer and the reason. */
      readonly command: Readonly<Record<string, unknown>>;
      readonly write: (
        customerId: UserId,
        before: CustomerRecord,
        now: Date,
        tx: TransactionScope,
      ) => Promise<ControlChange>;
    },
  ): Promise<{ readonly overview: CustomerOverview; readonly changed: boolean }> {
    const customerId = this.customerId(input.customerId);
    const reason = input.reason.trim();
    const denial = { action: input.action, entityType: 'Customer', entityId: customerId };
    // Before the replay, under the COMMAND's permission: a replay is the same decision.
    await this.authorize(scope, actor, input.permission, denial);
    if (reason === '') {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'A reason is required for this change.',
      );
    }
    const requestHash = hashRequest({
      customerId,
      action: input.action,
      command: input.command,
      reason,
    });
    const namespace = actor.surface;
    const replay = await this.deps.idempotency.find<{ changed: boolean }>(
      scope,
      namespace,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      // The controls as they are NOW: a replay answers "is it done", not a snapshot.
      return { overview: await this.read(scope, customerId), changed: replay.result.changed };
    }

    const now = this.deps.clock.now();
    const changed = await runAuthorizedMutation(
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
      input.permission,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        const before = await this.deps.customers.findById(scope, customerId, tx);
        if (before === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }
        const change = await input.write(customerId, before, now, tx);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: input.action,
            entityType: 'Customer',
            entityId: customerId,
            before: change.before,
            after: { ...change.after, changed: change.changed },
            result: 'SUCCESS',
            reason,
          },
          tx,
        );
        if (change.changed) await change.emit(tx);
        await rememberOnce(
          this.deps.idempotency,
          scope,
          namespace,
          input.idempotencyKey,
          requestHash,
          { changed: change.changed },
          tx,
        );
        return change.changed;
      },
    );
    return { overview: await this.read(scope, customerId), changed };
  }

  private async read(scope: TenantContext, customerId: UserId): Promise<CustomerOverview> {
    const customer = await this.deps.customers.findById(scope, customerId);
    if (customer === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
    return {
      customer,
      locationOverride: await this.deps.locationOverrides.find(scope, customerId),
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
      await recordMutationDenial(
        { guard: this.deps.guard, audit: this.deps.audit, opsLog: this.deps.opsLog },
        scope,
        actor,
        permission,
        denial,
        error,
      );
      throw error;
    }
  }

  /** A customer id, or a 400 — never a 500 at the `uuid` cast (`CustomerService.customerId`). */
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
}
