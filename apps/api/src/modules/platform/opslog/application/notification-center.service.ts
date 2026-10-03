import {
  COMMERCE_ERROR_CODES,
  COUNTER_CAP,
  NOTIFICATION_CATEGORY_PERMISSIONS,
  NOTIFICATION_CENTER_ERROR_CODES,
  NOTIFICATION_ENTITY_LINKS,
  NOTIFICATION_RULES,
  NOTIFICATION_WINDOW_DAYS,
  PLATFORM_ERROR_CODES,
  errors,
  isLinkableId,
  isNexaError,
  notificationRuleFor,
  visibleNotificationCategories,
  type ActorContext,
  type Clock,
  type InboxLink,
  type NotificationCategory,
  type OperationalEventRecorder,
  type OperationalSeverity,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import {
  denialEventRecorded,
  type PermissionGuard,
} from '../../access/application/permission-guard.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  InboxFilter,
  InboxRow,
  NotificationInboxRepository,
} from './notification-center.ports.js';

const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** A notification as the inbox answers it: the row, its category and its deep link. */
export interface InboxNotificationView extends InboxRow {
  readonly category: NotificationCategory;
  readonly link: InboxLink;
}

export interface NotificationCenterDeps {
  readonly repository: NotificationInboxRepository;
  readonly guard: PermissionGuard;
  /** Where a denial decided INSIDE a transaction is recorded, once that has unwound. */
  readonly opsLog: OperationalEventRecorder;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
}

/**
 * The deep link for an event: the rule's target, with the id its typed subject carries
 * (`paymentId`, `panelId`, `serviceId`, `orderId`) when that id is a UUID; otherwise the
 * list the target falls back to. Nothing from `context` reaches a link unvalidated.
 */
export function linkFor(code: string, context: Record<string, unknown> | null): InboxLink {
  const rule = notificationRuleFor(code);
  const target = rule?.link ?? 'ALERTS';
  const entity = NOTIFICATION_ENTITY_LINKS[target];
  if (entity === undefined) return { target, id: null };
  const id = context?.[entity.contextKey];
  return isLinkableId(id) ? { target, id } : { target: entity.fallback, id: null };
}

/**
 * The Web Admin Notification Center (Phase B3, `docs/notification-center.md`).
 *
 * A PROJECTION of `operational_events` through `NOTIFICATION_RULES`, filtered to the
 * categories this administrator's permissions admit — `permissionsOf`, the guard's own
 * resolution, so the inbox can never disagree with what a request would be allowed. What
 * it writes is the administrator's OWN read state, and nothing else.
 *
 * The read marks are personal view state, not an operator decision about the
 * installation: they resolve no condition, change no event and are seen by nobody else.
 * So they carry no audit row and no outbox event — auditing "Maryam read a notification"
 * would put the inbox's own noise into the log the inbox exists to keep readable. They are
 * still authorised (the event's category permission, through the guard, which records a
 * denial), scoped (tenant and administrator), checked against scope activity inside their
 * transaction, and idempotent by construction: each is a SET of state, so a repeat or a
 * double click lands in the same place.
 *
 * The authority that counts is decided INSIDE the write's transaction, before it writes —
 * the rule `runAuthorizedMutation` states and ADR-0014 records. The check before the
 * transaction is an early rejection (and what turns an invisible id into a 404); a role
 * revoked between it and the commit must still refuse the write, so `mark` charges the
 * guard again on `tx` and `markAll` resolves its filter again on `tx`.
 */
export class NotificationCenterService {
  constructor(private readonly deps: NotificationCenterDeps) {}

  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: {
      readonly limit: number;
      readonly category?: NotificationCategory;
      readonly unreadOnly: boolean;
      readonly before: { readonly at: Date; readonly id: string } | null;
    },
  ): Promise<readonly InboxNotificationView[]> {
    const filter = await this.filterFor(scope, actor, query.category, query.unreadOnly);
    if (filter === null) return [];
    const rows = await this.deps.repository.list(scope, filter, {
      limit: query.limit,
      before: query.before,
    });
    return rows.flatMap((row) => this.view(row));
  }

  async summary(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<{
    readonly unread: number;
    readonly atLeast: boolean;
    readonly highest: OperationalSeverity | null;
  }> {
    const filter = await this.filterFor(scope, actor, undefined, true);
    if (filter === null) return { unread: 0, atLeast: false, highest: null };
    const { count, highest } = await this.deps.repository.unread(scope, filter, COUNTER_CAP);
    return { unread: count, atLeast: count >= COUNTER_CAP, highest };
  }

  /** Read or unread, for one notification this administrator may see. */
  async mark(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly id: string; readonly read: boolean },
  ): Promise<InboxNotificationView> {
    const adminId = this.adminIdOf(actor);
    if (!UUID.test(input.id)) throw this.notFound();
    const filter = await this.filterFor(scope, actor, undefined, false);
    const found = filter === null ? null : await this.deps.repository.find(scope, filter, input.id);
    const rule = found === null ? null : notificationRuleFor(found.code);
    if (filter === null || found === null || rule === null) throw this.notFound();
    // Charged through the guard, so a revoked key is refused (and the refusal recorded)
    // even when the page that offered the button was drawn before the revocation.
    const permission = NOTIFICATION_CATEGORY_PERMISSIONS[rule.category];
    await this.deps.guard.check(scope, actor, permission);
    await this.inTransaction(scope, actor, permission, async (tx) => {
      // Authoritative: a revocation that committed after the early check refuses here.
      await this.deps.guard.check(scope, actor, permission, tx);
      await this.assertScopeActive(scope, tx);
      await this.deps.repository.mark(
        scope,
        adminId,
        input.id,
        input.read,
        this.deps.clock.now(),
        tx,
      );
    });
    const after = await this.deps.repository.find(scope, filter, input.id);
    /* istanbul ignore next -- operational events are never deleted. */
    if (after === null) throw this.notFound();
    const [view] = this.view(after);
    /* istanbul ignore next -- the same rule admitted it above. */
    if (view === undefined) throw this.notFound();
    return view;
  }

  /** Every unread notification this administrator may see (in one category, if named). */
  async markAll(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly category?: NotificationCategory },
  ): Promise<number> {
    const permission =
      input.category === undefined ? null : NOTIFICATION_CATEGORY_PERMISSIONS[input.category];
    if (permission !== null) await this.deps.guard.check(scope, actor, permission);
    if ((await this.filterFor(scope, actor, input.category, true)) === null) return 0;
    return this.inTransaction(scope, actor, permission, async (tx) => {
      // Authoritative: the permission AND the filter are decided again on `tx`, so a
      // category revoked after the early read is neither charged nor marked.
      if (permission !== null) await this.deps.guard.check(scope, actor, permission, tx);
      const filter = await this.filterFor(scope, actor, input.category, true, tx);
      if (filter === null) return 0;
      await this.assertScopeActive(scope, tx);
      return this.deps.repository.markAll(scope, filter, this.deps.clock.now(), tx);
    });
  }

  // --- helpers ----------------------------------------------------------------------------

  /**
   * The administrator's filter: the rules of every category their permissions admit,
   * narrowed to `category` when one is asked for. Null when nothing is visible — an
   * empty inbox, never an error: an administrator with no notifiable permission simply
   * has no notifications.
   */
  private async filterFor(
    scope: TenantContext,
    actor: ActorContext,
    category: NotificationCategory | undefined,
    unreadOnly: boolean,
    tx?: TransactionScope,
  ): Promise<InboxFilter | null> {
    const adminId = this.adminIdOf(actor);
    const held = await this.deps.guard.permissionsOf(scope, actor, tx);
    const categories = visibleNotificationCategories(held).filter(
      (one) => category === undefined || one === category,
    );
    if (categories.length === 0) return null;
    const rules = NOTIFICATION_RULES.filter((rule) => categories.includes(rule.category));
    return {
      adminId,
      rules,
      windowStart: new Date(this.deps.clock.now().getTime() - NOTIFICATION_WINDOW_DAYS * DAY_MS),
      unreadOnly,
    };
  }

  /**
   * A write's unit of work, recording a denial decided inside it once it has unwound. The
   * guard writes no event from inside a transaction (it would take a second pool
   * connection while holding one), so the caller records it — here, and only when the
   * guard says it could not. No audit row: a read mark is personal view state.
   */
  private async inTransaction<T>(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey | null,
    fn: (tx: TransactionScope) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.deps.uow.run(scope, fn);
    } catch (error) {
      if (
        isNexaError(error) &&
        error.kind === 'PERMISSION_DENIED' &&
        permission !== null &&
        error.details['permission'] === permission &&
        !denialEventRecorded(error)
      ) {
        await this.deps.opsLog.record(scope, this.deps.guard.denialEvent(actor, permission));
      }
      throw error;
    }
  }

  /** A row with its category and link; empty when no rule claims it (defence in depth). */
  private view(row: InboxRow): InboxNotificationView[] {
    const rule = notificationRuleFor(row.code);
    if (rule === null) return [];
    return [{ ...row, category: rule.category, link: linkFor(row.code, row.context) }];
  }

  private adminIdOf(actor: ActorContext): string {
    if ((actor.type === 'WEB_ADMIN' || actor.type === 'TELEGRAM_ADMIN') && actor.id !== null) {
      return actor.id;
    }
    throw errors.permissionDenied(
      PLATFORM_ERROR_CODES.PERMISSION_DENIED,
      'Only an administrator has a notification inbox.',
    );
  }

  private notFound() {
    return errors.notFound(NOTIFICATION_CENTER_ERROR_CODES.NOT_FOUND, 'No such notification.');
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
  }
}
