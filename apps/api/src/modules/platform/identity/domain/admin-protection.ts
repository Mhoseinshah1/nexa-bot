import { errors, IDENTITY_ERROR_CODES, OWNER_ROLE_KEY, type AdminId } from '@nexa/contracts';

/**
 * Self-protection rules for administrator changes.
 *
 * Pure functions, deliberately: these are the rules an installation's
 * recoverability depends on, and a rule that needs a database to be tested is a
 * rule that gets tested less. The services below call them; the migration's
 * triggers repeat the last-owner one as a backstop.
 *
 * The legacy system has none of this. Its roles cannot be changed at all
 * (demotion means delete and recreate), re-adding an admin reports success and
 * writes nothing, and whether a restricted admin can reach admin management and
 * escalate themselves is an open question nobody can answer (`UNK-ADM-005`).
 * The answer here is that they cannot, because privilege changes to oneself are
 * refused regardless of what permissions one holds.
 */

export interface OwnerChangeContext {
  /** Active admins currently holding the owner role, counted under a row lock. */
  readonly activeOwnerCount: number;
  /** Whether the admin being changed is one of them. */
  readonly targetIsActiveOwner: boolean;
}

/**
 * Refuses a change that would leave the installation with no active owner.
 *
 * This is the rule that keeps a self-hosted install recoverable. Losing the
 * last owner is not a permission problem to be solved by granting more; it
 * means editing the database by hand to get back in.
 */
export function assertOwnerSurvives(context: OwnerChangeContext): void {
  if (context.targetIsActiveOwner && context.activeOwnerCount <= 1) {
    throw errors.conflict(
      IDENTITY_ERROR_CODES.ADMIN_LAST_OWNER,
      'This is the last active owner. Grant the owner role to another active administrator first.',
      { ownerRoleKey: OWNER_ROLE_KEY },
    );
  }
}

/**
 * Refuses a privilege change an admin makes to themselves.
 *
 * Holding `admins.edit` is permission to administer OTHER administrators. An
 * admin who can edit their own roles or overrides can grant themselves
 * anything, which makes every other permission boundary decorative — and an
 * admin who can disable themselves can lock the installation out by accident.
 *
 * Changing one's own PASSWORD is not this: it takes the current password and
 * grants nothing, so it goes through a different path.
 *
 * The comparison folds case. It reads as belt-and-braces now that
 * `uuidV7Schema` canonicalises at the boundary, and it is not: this comparison
 * decides an authorization question in JavaScript about a row the DATABASE will
 * resolve, and Postgres `uuid` equality is case-insensitive. When the two
 * disagree, the guard loses. A security review defeated the earlier `===` by
 * upper-casing the acting admin's own id in the request path — the guard saw a
 * different string, and every query afterwards resolved it back to the caller.
 * Callers should also re-check against the id the database returned; see
 * `AdminManagementService`.
 */
export function assertNotSelf(actingAdminId: AdminId | null, targetAdminId: AdminId): void {
  if (actingAdminId !== null && sameAdmin(actingAdminId, targetAdminId)) {
    throw errors.conflict(
      IDENTITY_ERROR_CODES.ADMIN_SELF_MODIFICATION,
      'An administrator cannot change their own roles or status. Ask another administrator.',
    );
  }
}

/**
 * Whether two identifiers name the same administrator.
 *
 * Case-folded because the database folds. Never compare admin ids with `===`.
 */
export function sameAdmin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The role keys being added and removed, for the audit row and the event. */
export interface RoleDelta {
  readonly added: string[];
  readonly removed: string[];
  readonly unchanged: string[];
}

export function diffRoles(current: readonly string[], next: readonly string[]): RoleDelta {
  const currentSet = new Set(current);
  const nextSet = new Set(next);
  return {
    added: [...nextSet].filter((key) => !currentSet.has(key)).sort(),
    removed: [...currentSet].filter((key) => !nextSet.has(key)).sort(),
    unchanged: [...nextSet].filter((key) => currentSet.has(key)).sort(),
  };
}

/** True when a role change takes the owner role away from this admin. */
export function losesOwnerRole(delta: RoleDelta): boolean {
  return delta.removed.includes(OWNER_ROLE_KEY);
}
