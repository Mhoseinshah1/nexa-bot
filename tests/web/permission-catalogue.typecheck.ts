/**
 * Type-level tests for the permission catalogue (program Item 2).
 *
 * Not a vitest file — nothing here runs. `pnpm typecheck:tests` compiles it through
 * `tsconfig.tests.web.json`, and that is the whole test: every `@ts-expect-error` below is
 * a claim that the line after it must NOT compile. If the type system ever stops refusing
 * one — `PermissionKey` widened back to `string`, a label table typed `Record<string, …>`
 * again — the directive itself becomes the error ("Unused '@ts-expect-error' directive")
 * and the gate fails. The runtime halves of the same rules stay in
 * `tests/unit/permissions.test.ts` and `tests/web/roles.test.tsx`.
 *
 * It lives under `tests/web/` because it imports the Web Admin's label tables, which only
 * the web test config compiles.
 */
import {
  isPermissionKey,
  type PERMISSION_REQUIRES,
  permissionDefinition,
  resolveEffectivePermissions,
  type PermissionDomain,
  type PermissionKey,
} from '@nexa/contracts';
import type { WebKey } from '../../apps/web/src/i18n/web.fa';
import { PERMISSION_DOMAIN_LABELS, PERMISSION_LABELS } from '../../apps/web/src/rbac-labels';
import type { NavEntry } from '../../apps/web/src/nav';

type IsWideString<T> = string extends T ? true : false;

// --- The key and the domain are literal unions, never `string` ------------------------

export const keyIsLiteral: IsWideString<PermissionKey> = false;
export const domainIsLiteral: IsWideString<PermissionDomain> = false;

// --- An unknown key does not compile ---------------------------------------------------

export const knownKey: PermissionKey = 'users.view';
// @ts-expect-error: not a catalogued permission.
export const unknownKey: PermissionKey = 'users.obliterate';
// @ts-expect-error: a misspelt key is refused where a guard would take it.
export const misspelt = () => permissionDefinition('users.veiw');
export const knownDomain: PermissionDomain = 'users';
// @ts-expect-error: not a catalogued domain.
export const unknownDomain: PermissionDomain = 'features';
export const navEntryKey: NavEntry['permission'] = 'terms.view';
// @ts-expect-error: a nav entry cannot be gated on a key the server never charges.
export const navEntryUnknown: NavEntry['permission'] = 'features.edit';

// --- A missing or invented label does not compile --------------------------------------

const { 'users.view': _droppedLabel, ...labelsMissingOne } = PERMISSION_LABELS;
// @ts-expect-error: `users.view` has no Persian label.
export const missingLabel: Readonly<Record<PermissionKey, WebKey>> = labelsMissingOne;
export const inventedLabel: Readonly<Record<PermissionKey, WebKey>> = {
  ...PERMISSION_LABELS,
  // @ts-expect-error: a label for a permission that does not exist.
  'users.obliterate': 'web.perm_users_view',
};

const { users: _droppedDomain, ...domainsMissingOne } = PERMISSION_DOMAIN_LABELS;
// @ts-expect-error: the `users` domain has no Persian label.
export const missingDomain: Readonly<Record<PermissionDomain, WebKey>> = domainsMissingOne;

// --- A dependency must name catalogued keys on both sides ------------------------------

export const unknownDependent: typeof PERMISSION_REQUIRES = {
  // @ts-expect-error: the dependent is not a permission.
  'users.obliterate': 'users.view',
};
export const unknownPrerequisite: typeof PERMISSION_REQUIRES = {
  // @ts-expect-error: the prerequisite is not a permission.
  'users.trial.edit': 'users.obliterate',
};

// --- A string from a row or a request is not a key until the boundary says so ----------

export function fromStorage(stored: string): void {
  // @ts-expect-error: an unparsed string cannot be resolved as a grant.
  resolveEffectivePermissions([stored], [], new Date());
  if (isPermissionKey(stored)) resolveEffectivePermissions([stored], [], new Date());
}
