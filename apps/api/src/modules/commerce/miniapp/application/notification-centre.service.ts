import {
  COMMERCE_ERROR_CODES,
  MINIAPP_ERROR_CODES,
  MINIAPP_NOTIFICATION_PAGE_SIZE,
  MINIAPP_NOTIFICATION_WINDOW_DAYS,
  errors,
  type ActorContext,
  type AuditWriter,
  type BotInstanceId,
  type Clock,
  type FeatureFlagKey,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type {
  NotificationCentreItem,
  NotificationCentrePosition,
  NotificationCentreRepository,
} from './ports.js';

/** The feature flag the whole centre sits behind (default OFF). */
export const NOTIFICATION_CENTRE_FEATURE = 'notification_centre' satisfies FeatureFlagKey;

/**
 * The customer-own permission, held by the mini app's session job exactly as the wallet's own
 * balance read holds it (`WALLET_OWN_VIEW_PERMISSION`): the customer is the session's and never
 * a client's, so there is no id here that could point at somebody else.
 */
const CENTRE_PERMISSION: PermissionKey = 'maintenance.run';

const DAY_MS = 86_400_000;

export interface NotificationCentreDeps {
  readonly repository: NotificationCentreRepository;
  readonly features: {
    isEnabled(
      scope: TenantContext,
      key: typeof NOTIFICATION_CENTRE_FEATURE,
      tx?: unknown,
    ): Promise<boolean>;
  };
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly idempotency: IdempotencyStore;
  readonly clock: Clock;
}

export interface NotificationCentreOwner {
  readonly customerId: UserId;
  readonly botInstanceId: BotInstanceId;
}

export interface NotificationCentrePage {
  readonly items: readonly NotificationCentreItem[];
  readonly next: NotificationCentrePosition | null;
  readonly unreadCount: number;
}

export interface NotificationReadResult {
  readonly marked: number;
  readonly unreadCount: number;
}

/**
 * The customer's notification centre in the mini app (Round 11, B1): the bot messages the
 * customer notification lane has already DELIVERED to them, with read and unread.
 *
 * What it is NOT: a message store of its own and a way to send anything. The rows are the
 * lane's (`customer_notifications`), written by the dispatcher's own `DELIVERED` outcome; the
 * words are the ones rendered at that moment. This service reads them for the session's
 * customer and one bot, and writes exactly one fact: `customer_read_at`.
 *
 * Marking read is a per-customer view preference, not a business fact, so it leaves no audit
 * row and no outbox event — but it is a write path like any other: authorised, behind the
 * scope-activity check and the flag read INSIDE its transaction, and idempotent twice over
 * (the surface's key, and a conditional UPDATE that cannot move a read row).
 *
 * With the flag off every method answers as the mini app does when it is off — a 404
 * `MINIAPP_UNAVAILABLE` — except `summary`, which `/me` uses to decide whether to draw a
 * bell and which answers `null`.
 */
export class NotificationCentreService {
  constructor(private readonly deps: NotificationCentreDeps) {}

  /** `/me`'s block: the unread count, or null while the centre is off (no bell). */
  async summary(
    scope: TenantContext,
    actor: ActorContext,
    owner: NotificationCentreOwner,
  ): Promise<{ readonly unreadCount: number } | null> {
    if (!(await this.deps.features.isEnabled(scope, NOTIFICATION_CENTRE_FEATURE))) return null;
    await this.deps.guard.check(scope, actor, CENTRE_PERMISSION);
    return { unreadCount: await this.unread(scope, owner) };
  }

  /** One page, newest first, bounded to the window; the count is the window's whole unread. */
  async list(
    scope: TenantContext,
    actor: ActorContext,
    owner: NotificationCentreOwner,
    after: NotificationCentrePosition | null,
  ): Promise<NotificationCentrePage> {
    await this.assertEnabled(scope);
    await this.deps.guard.check(scope, actor, CENTRE_PERMISSION);
    const page = await this.deps.repository.list(scope, {
      ...owner,
      since: this.windowStart(),
      after,
      limit: MINIAPP_NOTIFICATION_PAGE_SIZE,
    });
    return { items: page.items, next: page.next, unreadCount: await this.unread(scope, owner) };
  }

  /**
   * Marks one message read. Another customer's, another bot's, another tenant's and a
   * message that does not exist are one `MINIAPP_NOT_FOUND`; a message already read answers
   * `marked: 0` and changes nothing.
   */
  async markRead(
    scope: TenantContext,
    actor: ActorContext,
    input: NotificationCentreOwner & {
      readonly notificationId: string;
      readonly idempotencyKey: string;
    },
  ): Promise<NotificationReadResult> {
    return this.write(
      scope,
      actor,
      input,
      { operation: 'mark_read', notificationId: input.notificationId },
      'notification_centre.mark_read',
      input.notificationId,
      async (tx, at) => {
        const outcome = await this.deps.repository.markRead(
          scope,
          { ...input, id: input.notificationId, at },
          tx,
        );
        if (outcome === 'NOT_FOUND') {
          throw errors.notFound(MINIAPP_ERROR_CODES.MINIAPP_NOT_FOUND, 'Not found.');
        }
        return outcome === 'MARKED' ? 1 : 0;
      },
    );
  }

  /** Marks every unread message of this customer read. */
  async markAllRead(
    scope: TenantContext,
    actor: ActorContext,
    input: NotificationCentreOwner & { readonly idempotencyKey: string },
  ): Promise<NotificationReadResult> {
    return this.write(
      scope,
      actor,
      input,
      { operation: 'mark_all_read' },
      'notification_centre.mark_all_read',
      null,
      (tx, at) => this.deps.repository.markAllRead(scope, { ...input, at }, tx),
    );
  }

  // ---------------------------------------------------------------------------------------

  private async write(
    scope: TenantContext,
    actor: ActorContext,
    owner: NotificationCentreOwner & { readonly idempotencyKey: string },
    shape: Readonly<Record<string, string>>,
    action: string,
    entityId: string | null,
    change: (tx: TransactionScope, at: Date) => Promise<number>,
  ): Promise<NotificationReadResult> {
    await this.assertEnabled(scope);
    const namespace = actor.surface;
    const requestHash = hashRequest({
      customerId: owner.customerId,
      botInstanceId: owner.botInstanceId,
      ...shape,
    });
    const replay = await this.deps.idempotency.find<{ marked: number }>(
      scope,
      namespace,
      owner.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      await this.deps.guard.check(scope, actor, CENTRE_PERMISSION);
      return { marked: replay.result.marked, unreadCount: await this.unread(scope, owner) };
    }
    const marked = await runAuthorizedMutation(
      this.deps,
      scope,
      actor,
      CENTRE_PERMISSION,
      { action, entityType: 'CustomerNotification', entityId },
      async (tx) => {
        // Read INSIDE the transaction: a stop or a switch-off that committed after the
        // request arrived is refused here, not discovered afterwards.
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        if (!(await this.deps.features.isEnabled(scope, NOTIFICATION_CENTRE_FEATURE, tx))) {
          throw this.unavailable();
        }
        const changed = await change(tx, this.deps.clock.now());
        await rememberOnce(
          this.deps.idempotency,
          scope,
          namespace,
          owner.idempotencyKey,
          requestHash,
          { marked: changed },
          tx,
        );
        return changed;
      },
    );
    return { marked, unreadCount: await this.unread(scope, owner) };
  }

  private unread(scope: TenantContext, owner: NotificationCentreOwner): Promise<number> {
    return this.deps.repository.unreadCount(scope, { ...owner, since: this.windowStart() });
  }

  private windowStart(): Date {
    return new Date(this.deps.clock.now().getTime() - MINIAPP_NOTIFICATION_WINDOW_DAYS * DAY_MS);
  }

  private async assertEnabled(scope: TenantContext): Promise<void> {
    if (!(await this.deps.features.isEnabled(scope, NOTIFICATION_CENTRE_FEATURE))) {
      throw this.unavailable();
    }
  }

  private unavailable(): Error {
    return errors.notFound(
      MINIAPP_ERROR_CODES.MINIAPP_UNAVAILABLE,
      'The mini app is not available.',
    );
  }
}
