import {
  errors,
  IDENTITY_ERROR_CODES,
  type ActorContext,
  type Admin,
  type AdminId,
  type CorrelationId,
  type PermissionKey,
  type ScopeContext,
  type TenantContext,
} from '@nexa/contracts';
import type { AdminRepository } from './ports.js';
import type { AdminManagementService } from './admin-management.service.js';

/**
 * What a Telegram account may do, and who it is.
 *
 * Only what the surface needs: the administrator's own identity for the audit trail,
 * and the permission set the guard resolved. No password hash, no session, no roles —
 * the roles' only job here was to produce the permissions.
 */
export interface TelegramAdminIdentity {
  readonly admin: Admin;
  readonly actor: ActorContext;
  readonly permissions: ReadonlySet<PermissionKey>;
}

/** The two collaborators this needs, named by what they answer rather than by class. */
export interface TelegramAdminDeps {
  readonly admins: AdminRepository;
  readonly permissions: {
    resolve(
      scope: ScopeContext,
      actor: ActorContext,
      tx?: unknown,
    ): Promise<ReadonlySet<PermissionKey>>;
  };
  readonly management: Pick<AdminManagementService, 'setTelegramBinding' | 'setRoles' | 'list'>;
}

/**
 * The Telegram admin seam (Phase 5T).
 *
 * ## There is no second authorization system here
 *
 * A Telegram account does not hold permissions. It holds a BINDING to an administrator
 * — `admins.telegram_user_id`, a column that has existed since Phase 0 for exactly this
 * — and the authority is that administrator's, resolved by the same
 * `AdminPermissionResolver` that answers for the Web Admin. `TELEGRAM_ADMIN` has been in
 * `ACTOR_TYPES` and in that resolver's accepted set since the beginning; this service is
 * what finally produces one.
 *
 * So there is no Telegram role enum, no per-bot admin table and no second guard. The
 * Mirza research is emphatic about why that matters: its own `Admin` row is
 * `(numeric telegram id, role)` and nothing else, its role vocabulary disagrees with the
 * Web panel's four against seven, and whether any of it is enforced at all is
 * `UNK-ADM-001` — NOT_TESTED, because the investigation could not obtain a session to
 * test it with.
 *
 * ## Identity is the numeric id
 *
 * Never a username. Telegram usernames are reassignable and a customer can choose one
 * that looks like an administrator's; the numeric id cannot be transferred and is what
 * every Telegram update carries. `telegramUserIdSchema` is the same schema the customer
 * side validates with, and the column's CHECK repeats the shape.
 *
 * ## Revocation is immediate by construction
 *
 * `resolve` runs on EVERY turn and reads the binding and the administrator's status
 * through the resolver, which grants a non-ACTIVE administrator nothing. There is no
 * cached authority to invalidate: disabling an administrator, removing their roles or
 * removing the binding all take effect on the next update, not at some expiry.
 */
export class TelegramAdminService {
  constructor(private readonly deps: TelegramAdminDeps) {}

  /**
   * The Telegram account behind this turn, when it is an administrator's.
   *
   * `null` for every other case, and the cases are deliberately not distinguished to
   * the caller: no such binding, a DISABLED administrator, an administrator with no
   * permissions at all. The surface answers all three exactly as it answers an
   * ordinary customer, because a reply that told them apart would tell whoever holds
   * that chat whether an administrator exists behind an id they guessed.
   */
  async resolve(
    scope: TenantContext,
    telegramUserId: string,
    correlationId: CorrelationId,
  ): Promise<TelegramAdminIdentity | null> {
    const admin = await this.deps.admins.findByTelegramUserId(scope, telegramUserId);
    if (admin === null) return null;

    const actor: ActorContext = {
      type: 'TELEGRAM_ADMIN',
      id: admin.id,
      // Captured at action time so an audit row survives a rename, which is the rule
      // `ActorContext.label` states.
      label: admin.username,
      surface: 'TELEGRAM',
      correlationId,
    };

    /*
     * The RESOLVER decides, not this method.
     *
     * It applies the status check, the tenant check and the role composition, and an
     * empty set is its answer for a disabled administrator. Re-deriving any of that
     * here would be a second implementation of authority — the failure this codebase
     * is built to avoid, in the one place where it would grant rather than refuse.
     */
    const permissions = await this.deps.permissions.resolve(scope, actor);
    if (permissions.size === 0) return null;

    return { admin, actor, permissions };
  }

  /**
   * The administrators that hold Telegram access, for the section that lists them.
   *
   * Read through the repository rather than `management.list()` filtered afterwards,
   * because the predicate belongs in SQL — and because this list is small by
   * construction: it is the people an operator deliberately gave a second channel to.
   */
  async listBound(scope: TenantContext, actor: ActorContext): Promise<readonly Admin[]> {
    // `admins.view` is what reading administrators takes anywhere else in this
    // product, and it is charged here through the same guard the Web Admin uses.
    await this.deps.management.list(scope, actor);
    return this.deps.admins.listTelegramBound(scope);
  }

  /**
   * Everyone who may decide a receipt AND could be told about one in Telegram.
   *
   * Both halves are required and neither is assumed: a bound administrator without
   * `receipts.review` is not told (they could do nothing about it), and an
   * administrator with the permission but no binding has no chat to be told in. The
   * permission is resolved per administrator through the same resolver a request
   * would use, so a role change is reflected on the next receipt rather than at some
   * refresh.
   *
   * Bounded by the number of bound administrators, which is why a per-administrator
   * resolve is acceptable here and would not be for a customer-sized set.
   */
  async reviewers(
    scope: TenantContext,
    permission: PermissionKey,
    correlationId: CorrelationId,
    tx?: unknown,
  ): Promise<readonly TelegramAdminIdentity[]> {
    const bound = await this.deps.admins.listTelegramBound(scope, tx);
    const found: TelegramAdminIdentity[] = [];
    for (const admin of bound) {
      const actor: ActorContext = {
        type: 'TELEGRAM_ADMIN',
        id: admin.id,
        label: admin.username,
        surface: 'TELEGRAM',
        correlationId,
      };
      const permissions = await this.deps.permissions.resolve(scope, actor, tx);
      if (permissions.has(permission)) found.push({ admin, actor, permissions });
    }
    return found;
  }

  /**
   * Binds a Telegram account to the administrator with this username.
   *
   * The username is how a person names an administrator, and the id is how Telegram
   * names an account; both arrive in ONE message, which is what makes this a command
   * rather than a captured prompt. `admin.not_found` is thrown for an unknown
   * username — the surface renders one refusal for every case here, so the code is for
   * the audit row and the operator, not for the chat.
   */
  async link(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly username: string; readonly telegramUserId: string; readonly reason: string },
  ): Promise<Admin> {
    const target = await this.requireByUsername(scope, input.username);
    const result = await this.deps.management.setTelegramBinding(scope, actor, target.id, {
      telegramUserId: input.telegramUserId,
      reason: input.reason,
    });
    return result.admin;
  }

  /** Removes one administrator's Telegram access. Their account and roles are untouched. */
  async revoke(
    scope: TenantContext,
    actor: ActorContext,
    targetId: AdminId,
    reason: string,
  ): Promise<Admin> {
    const result = await this.deps.management.setTelegramBinding(scope, actor, targetId, {
      telegramUserId: null,
      reason,
    });
    return result.admin;
  }

  /**
   * Sets an administrator's roles from Telegram, through the SAME method the Web Admin
   * calls.
   *
   * Nexa's roles, not a Mirza-shaped enum of four: the four labels the research
   * observed (`مدیر کل`, `فروشنده`, `پشتیبان`, `تأییدکنندهٔ رسید`) are all expressible as
   * role presets that already exist here — `owner`, `sales`, `support`,
   * `receipt_reviewer` — and `setRoles` carries the escalation rule, the last-owner
   * rule and the audit trail that a second enum would not.
   */
  async setRoles(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly username: string;
      readonly roleKeys: readonly string[];
      readonly reason: string;
    },
  ): Promise<{ admin: Admin; roleKeys: string[] }> {
    const target = await this.requireByUsername(scope, input.username);
    return this.deps.management.setRoles(scope, actor, target.id, {
      roleKeys: [...input.roleKeys],
      reason: input.reason,
    });
  }

  private async requireByUsername(scope: TenantContext, username: string): Promise<Admin> {
    // Lower-cased before the lookup, because the column is stored lower-cased and its
    // CHECK enforces that — an operator typing a capital letter is not a typo to
    // refuse.
    const found = await this.deps.admins.findByUsername(scope, username.trim().toLowerCase());
    if (found === null) {
      throw errors.notFound(IDENTITY_ERROR_CODES.ADMIN_NOT_FOUND, 'No such administrator.');
    }
    return found;
  }
}
