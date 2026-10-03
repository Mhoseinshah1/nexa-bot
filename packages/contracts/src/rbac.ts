import { z } from 'zod';
import { adminChangeReasonSchema, OWNER_ROLE_KEY } from './identity.js';
import {
  isPermissionKey,
  PERMISSION_DEPENDENCIES,
  PERMISSION_REQUIRES,
  PERMISSIONS,
  permissionDefinition,
  type PermissionDomain,
  type PermissionKey,
} from './permissions.js';

/**
 * Role management over the EXISTING authorization model (Phase D3, program §18).
 *
 * Nothing here changes what a permission means. A role is still a tenant-scoped,
 * editable composition over the frozen catalogue; effective authority is still
 * `resolveEffectivePermissions` — `(roles ∪ GRANT) − DENY`, minus every action whose
 * read did not survive. What this adds is the vocabulary for editing roles safely:
 *
 *   - the OWNER role is immutable. It is the carrier of the whole catalogue, and every
 *     last-owner protection counts holders of it; an owner role that could lose
 *     `admins.edit` would be an installation whose owners cannot administer it. The
 *     other system roles may be edited (their permissions were always a creation
 *     default, see `ensureSystemRoles`) but not renamed by key and never deleted;
 *   - a role's permission set must be COHERENT: every action carries the read it needs
 *     (`PERMISSION_REQUIRES`). The resolver drops an incoherent grant silently, which is
 *     right on every request and wrong at the moment somebody composes the set, so the
 *     server refuses one at write time;
 *   - a change touching a CRITICAL permission needs a typed confirmation — the role's
 *     own key — checked by the server, not only drawn by the page;
 *   - edits are versioned: a role saved from a stale read is refused, never merged.
 */

export const roleKeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
export const roleNameSchema = z.string().trim().min(1).max(80);

/** Whether a role may be edited or deleted at all. Only the owner role is frozen. */
export function isImmutableRole(key: string): boolean {
  return key === OWNER_ROLE_KEY;
}

const permissionListSchema = z.array(z.string().min(1).max(100)).max(PERMISSIONS.length);

export const roleAssigneeSchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  status: z.enum(['ACTIVE', 'DISABLED']),
});

export const roleViewSchema = z.object({
  key: z.string(),
  name: z.string(),
  isSystem: z.boolean(),
  /** True for the owner role: no edit, no delete. */
  immutable: z.boolean(),
  /** Optimistic concurrency: an edit names the version it was made from. */
  version: z.number().int().positive(),
  permissions: z.array(z.string()),
  assignedAdmins: z.array(roleAssigneeSchema),
});
export type RoleView = z.infer<typeof roleViewSchema>;

export const roleViewListResponseSchema = z.object({ roles: z.array(roleViewSchema) });
export type RoleViewListResponse = z.infer<typeof roleViewListResponseSchema>;

/**
 * `confirmation` is the role's own key, typed by the operator. Required — by the server
 * — whenever the change adds or removes a CRITICAL permission, or deletes a role that
 * holds one. Optional otherwise, and ignored.
 */
export const createRoleRequestSchema = z.object({
  key: roleKeySchema,
  name: roleNameSchema,
  permissions: permissionListSchema,
  reason: adminChangeReasonSchema,
  /** When the role was cloned, the key it was cloned from — recorded in the audit row. */
  clonedFrom: roleKeySchema.optional(),
  confirmation: z.string().max(64).optional(),
  idempotencyKey: z.string().min(8).max(255).optional(),
});
export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;

export const updateRoleRequestSchema = z.object({
  name: roleNameSchema,
  permissions: permissionListSchema,
  expectedVersion: z.number().int().positive(),
  reason: adminChangeReasonSchema,
  confirmation: z.string().max(64).optional(),
  idempotencyKey: z.string().min(8).max(255).optional(),
});
export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>;

export const deleteRoleRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  reason: adminChangeReasonSchema,
  confirmation: z.string().max(64).optional(),
  idempotencyKey: z.string().min(8).max(255).optional(),
});
export type DeleteRoleRequest = z.infer<typeof deleteRoleRequestSchema>;

export const roleMutationResponseSchema = z.object({ role: roleViewSchema });
export type RoleMutationResponse = z.infer<typeof roleMutationResponseSchema>;

export const deleteRoleResponseSchema = z.object({ deleted: z.literal(true), key: z.string() });
export type DeleteRoleResponse = z.infer<typeof deleteRoleResponseSchema>;

/**
 * One administrator's authority, explained: the roles and overrides it comes from, and
 * the EFFECTIVE set — computed by the same resolver the request guard uses, never by
 * the surface. A permission in `rolePermissions` but not in `effective` was taken away
 * by a DENY override or by `PERMISSION_REQUIRES`; the page says which by reading the
 * overrides and the dependency table, both in this contract.
 */
export const effectivePermissionsResponseSchema = z.object({
  adminId: z.string(),
  /** A disabled administrator holds nothing, whatever their roles say. */
  active: z.boolean(),
  roles: z.array(z.object({ key: z.string(), name: z.string() })),
  rolePermissions: z.array(z.string()),
  overrides: z.array(
    z.object({
      permissionKey: z.string(),
      effect: z.enum(['GRANT', 'DENY']),
      reason: z.string(),
      expiresAt: z.string().nullable(),
      /** False when it has expired and no longer applies. */
      active: z.boolean(),
    }),
  ),
  effective: z.array(z.string()),
});
export type EffectivePermissionsResponse = z.infer<typeof effectivePermissionsResponseSchema>;

/** The CRITICAL keys a change from `before` to `after` adds or removes, sorted. */
export function criticalPermissionChanges(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const was = new Set(before);
  const now = new Set(after);
  const changed = [
    ...after.filter((key) => !was.has(key)),
    ...before.filter((key) => !now.has(key)),
  ];
  return [...new Set(changed)]
    .filter((key) => {
      const definition = PERMISSIONS.find((one) => one.key === key);
      return definition?.riskLevel === 'CRITICAL';
    })
    .sort();
}

/** Whether a set holds any CRITICAL permission (deleting such a role needs confirming). */
export function holdsCriticalPermission(keys: readonly string[]): boolean {
  return keys.some((key) => {
    const definition = PERMISSIONS.find((one) => one.key === key);
    return definition?.riskLevel === 'CRITICAL';
  });
}

/** The read a permission needs, or null. One level deep, by `PERMISSION_REQUIRES`. */
export function prerequisiteOf(key: string): PermissionKey | null {
  // A string the catalogue does not name has no prerequisite: it is not a permission.
  if (!isPermissionKey(key)) return null;
  return PERMISSION_REQUIRES[key] ?? null;
}

/** The actions that need `key` as their read. */
export function dependentsOf(key: string): PermissionKey[] {
  return PERMISSION_DEPENDENCIES.filter(([, prerequisite]) => prerequisite === key)
    .map(([dependent]) => dependent)
    .sort();
}

/** `keys` plus every prerequisite they need — what selecting an action pulls in. */
export function withPrerequisites(keys: readonly PermissionKey[]): PermissionKey[] {
  const out = new Set<PermissionKey>(keys);
  for (const key of keys) {
    const prerequisite = prerequisiteOf(key);
    if (prerequisite !== null) out.add(prerequisite);
  }
  return [...out].sort();
}

/** The catalogue's domains, in catalogue order: a permission's `resource`. */
export const PERMISSION_DOMAINS: readonly PermissionDomain[] = [
  ...new Set(PERMISSIONS.map((definition) => definition.resource)),
];

/** Re-exported for the matrix: the risk of one key. */
export function riskOf(key: PermissionKey) {
  return permissionDefinition(key).riskLevel;
}

export const RBAC_ROUTES = {
  roles: '/rbac/roles',
  role: (key: string) => `/rbac/roles/${encodeURIComponent(key)}`,
  deleteRole: (key: string) => `/rbac/roles/${encodeURIComponent(key)}/delete`,
  effective: (adminId: string) => `/admins/${encodeURIComponent(adminId)}/effective-permissions`,
} as const;
