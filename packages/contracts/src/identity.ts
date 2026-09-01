import { z } from 'zod';
import type { AdminId, AdminSessionId, RoleId, TenantId } from './ids.js';
import type { PermissionKey } from './permissions.js';

/**
 * Identity: administrators, roles and sessions.
 *
 * Three separations are structural here, and all three are legacy defects:
 *
 *   - An Admin is NOT a Customer. The legacy system keeps both in one table
 *     addressed by Telegram id, so "is this person an admin" and "is this
 *     person a buyer" are the same question asked of the same row.
 *   - A Role is NOT an enum. The legacy column holds four values in one surface
 *     and seven in the other (`CON-WEB-001`), a role cannot be changed at all
 *     (demotion means delete and recreate), and no privilege change is audited.
 *     A role here is a tenant-scoped, editable composition over the frozen
 *     permission catalog.
 *   - A Session is NOT the credential. The token a browser holds is opaque and
 *     random; only its hash is stored, so a database read cannot impersonate
 *     anyone.
 *
 * Phase 1 scope: administrators belong to the TENANT as a whole. There is
 * deliberately no bot-instance-scoped admin — `UNK-ADM-004` is unresolved and
 * the narrower model is the one that can be widened later without a rewrite.
 * `telegramUserId` exists so a Telegram admin surface can attach to the same
 * identity in a later phase without a second admin table.
 */

/** DISABLED is not deleted. History keeps naming the admin who acted. */
export const ADMIN_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type AdminStatus = (typeof ADMIN_STATUSES)[number];
export const adminStatusSchema = z.enum(ADMIN_STATUSES);

/**
 * Usernames are stored already lower-cased and matched exactly.
 *
 * Case-folding at the boundary rather than in the index keeps the uniqueness
 * constraint a plain composite unique index: `Owner` and `owner` cannot become
 * two accounts, and no query has to remember to call `lower()`.
 */
export const ADMIN_USERNAME_MIN = 3;
export const ADMIN_USERNAME_MAX = 64;
export const adminUsernameSchema = z
  .string()
  .trim()
  .min(ADMIN_USERNAME_MIN)
  .max(ADMIN_USERNAME_MAX)
  .regex(/^[a-z0-9._-]+$/, 'may contain only lowercase letters, digits, dot, underscore or hyphen');

/**
 * Password policy.
 *
 * A length floor and nothing else. Composition rules ("one symbol, one digit")
 * measurably push people toward `Password1!` and are not recommended by any
 * current guidance; length plus a slow hash is what actually costs an attacker.
 */
export const ADMIN_PASSWORD_MIN = 12;
export const ADMIN_PASSWORD_MAX = 1024;
export const adminPasswordSchema = z.string().min(ADMIN_PASSWORD_MIN).max(ADMIN_PASSWORD_MAX);

export interface Admin {
  readonly id: AdminId;
  readonly tenantId: TenantId;
  readonly username: string;
  readonly displayName: string;
  readonly status: AdminStatus;
  /** The seam for a later Telegram admin surface. Null until linked. */
  readonly telegramUserId: string | null;
  readonly createdAt: Date;
  readonly lastLoginAt: Date | null;
  readonly disabledAt: Date | null;
}

/**
 * The role a tenant's administrators are composed from.
 *
 * `key` is the stable machine identifier; `name` is a display label and may be
 * edited freely. System roles are seeded from `ROLE_SEEDS` and cannot be
 * deleted — an installation that deletes its owner role has no way back in.
 */
export interface Role {
  readonly id: RoleId;
  readonly tenantId: TenantId;
  readonly key: string;
  readonly name: string;
  readonly isSystem: boolean;
  readonly permissions: readonly PermissionKey[];
}

/**
 * The role that must always exist and must always have at least one active
 * holder. Every last-owner protection resolves against this key.
 */
export const OWNER_ROLE_KEY = 'owner';

export interface AdminSession {
  readonly id: AdminSessionId;
  readonly tenantId: TenantId;
  readonly adminId: AdminId;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly lastSeenAt: Date;
  readonly revokedAt: Date | null;
}

/**
 * A session token, returned exactly once at login.
 *
 * The store holds only a SHA-256 of this value, so the plaintext exists in the
 * response body and nowhere else. There is no endpoint that can read it back.
 */
export interface IssuedSession {
  readonly token: string;
  readonly session: AdminSession;
}

/** How an authenticated request presented its session. */
export const SESSION_TRANSPORTS = ['COOKIE', 'BEARER'] as const;
export type SessionTransport = (typeof SESSION_TRANSPORTS)[number];

/**
 * The session cookie's name, in two spellings.
 *
 * `__Host-` is not decoration: a browser refuses to store a cookie under that
 * prefix unless it is `Secure`, has `Path=/`, and names no `Domain`. That last
 * condition is the one that matters. Without it, a sibling host under a shared
 * parent domain — `evil.example.com` beside `admin.example.com` — can set a
 * cookie of the same name for `Domain=example.com` with a longer `Path`, and
 * browsers send longer-path cookies FIRST. Every conventional cookie parser
 * takes the first occurrence, so the attacker's value is the one read: enough
 * to keep a victim permanently logged out, and enough for anyone holding any
 * administrator credential to toss their own session into a victim's browser.
 * The prefix removes the possibility rather than the ordering, since such a
 * cookie can no longer be set at all.
 *
 * The prefix demands `Secure`, which a plain-HTTP development server cannot
 * offer, so the unprefixed spelling remains for non-production. Both names are
 * declared here rather than assembled at the surface, so the reader and the
 * writer cannot disagree about what a session cookie is called.
 */
export const SESSION_COOKIE_NAME = 'nexa_admin_session';
export const SESSION_COOKIE_NAME_SECURE = `__Host-${SESSION_COOKIE_NAME}` as const;

/**
 * The names a request may present a session under, most trusted first.
 *
 * Order is load-bearing: a `__Host-` cookie carries a guarantee the plain one
 * does not, so when both arrive the prefixed one wins regardless of the order
 * the browser sent them in.
 */
export const SESSION_COOKIE_NAMES = [SESSION_COOKIE_NAME_SECURE, SESSION_COOKIE_NAME] as const;

/**
 * Why a login attempt failed.
 *
 * Internal only. Every one of these is reported to the caller as the SAME
 * generic failure: an error that distinguishes "no such user" from "wrong
 * password" is a username oracle, and one that distinguishes "disabled" tells
 * an attacker which accounts are worth attacking. The distinction survives here
 * so the audit log can record what actually happened.
 */
export const LOGIN_FAILURE_REASONS = [
  'NO_SUCH_ADMIN',
  'BAD_PASSWORD',
  'ADMIN_DISABLED',
  'TENANT_INACTIVE',
  'THROTTLED',
] as const;
export type LoginFailureReason = (typeof LOGIN_FAILURE_REASONS)[number];
