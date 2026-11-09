/**
 * Database schema — identity: administrators, roles, sessions and admin security.
 *
 * One part of `../schema.ts`, which re-exports every part; import from there.
 */
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { ADMIN_KINDS, ADMIN_STATUSES, PERMISSION_OVERRIDE_EFFECTS } from '@nexa/contracts';
import { enumCheck, timestamptz } from './_shared.js';
import { tenants } from './tenancy.js';

// ---------------------------------------------------------------------------
// Identity and RBAC — Phase 1
// ---------------------------------------------------------------------------

/**
 * Administrators.
 *
 * Scoped to the TENANT, not to a bot instance. `UNK-ADM-004` is unresolved, and
 * the tenant-wide model is the one that can be narrowed later — adding
 * `bot_instance_id` to `admin_roles` is additive, while removing a scope that
 * turned out to be wrong is not.
 *
 * An Admin is not a Customer. They will not share a table, an id space or a
 * status vocabulary, because in the legacy system they do and "is this person
 * an admin" is therefore the same row as "is this person a buyer".
 *
 * `username` is stored already lower-cased — the CHECK enforces it — so the
 * composite unique index is enough to stop `Owner` and `owner` becoming two
 * accounts, with no query needing to remember `lower()`.
 */
export const admins = pgTable(
  'admins',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    username: text('username').notNull(),
    displayName: text('display_name').notNull(),
    /**
     * The self-describing output of the PasswordHasher: algorithm, parameters,
     * salt and digest in one string. Never a plaintext, never a bare digest,
     * and never returned by any query a surface can reach.
     *
     * NULL exactly for the `HOST` kind (phase 6B, `admins_kind_password_check`): the
     * installation owner's principal in a hosted tenant has no password and cannot sign in.
     */
    passwordHash: text('password_hash'),
    passwordUpdatedAt: timestamptz('password_updated_at').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    /**
     * `OPERATOR` (everyone who signs in) or `HOST` (phase 6B «ورود به پنل»: the installation
     * owner's principal in a hosted tenant, one per tenant, never edited by its admins — the
     * `nexa_host_admin_guard` trigger, migration 0334_host_admin_guard).
     */
    kind: text('kind').notNull().default('OPERATOR'),
    /**
     * The Telegram admin seam. A later Telegram admin surface attaches to THIS
     * identity rather than creating a second admin table — which is how the
     * legacy system ended up with two role vocabularies for one column.
     * Stored as text: Telegram ids exceed 2^53 and must not become floats.
     */
    telegramUserId: text('telegram_user_id'),
    lastLoginAt: timestamptz('last_login_at'),
    disabledAt: timestamptz('disabled_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    // Redundant with the primary key on `id` alone, and deliberately so: it is
    // the candidate key that lets a child row say "this admin, IN THIS TENANT".
    unique('admins_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('admins_tenant_username_key').on(table.tenantId, table.username),
    // Partial: two tenants may each have an admin with no Telegram link.
    uniqueIndex('admins_tenant_telegram_key')
      .on(table.tenantId, table.telegramUserId)
      .where(sql`telegram_user_id IS NOT NULL`),
    index('admins_tenant_status_idx').on(table.tenantId, table.status),
    check('admins_status_check', enumCheck('status', ADMIN_STATUSES)),
    check('admins_username_lowercase_check', sql`username = lower(username)`),
    check('admins_username_shape_check', sql`username ~ '^[a-z0-9._-]{3,64}$'`),
    check(
      'admins_telegram_shape_check',
      sql`telegram_user_id IS NULL OR telegram_user_id ~ '^[0-9]{1,20}$'`,
    ),
    // A disabled admin has a disabling timestamp and an active one does not, so
    // the two columns cannot drift into disagreeing about the same fact.
    check(
      'admins_disabled_at_check',
      sql`(status = 'DISABLED' AND disabled_at IS NOT NULL) OR (status <> 'DISABLED' AND disabled_at IS NULL)`,
    ),
    check('admins_kind_check', enumCheck('kind', ADMIN_KINDS)),
    // A HOST has no password and every OPERATOR has one: the sign-in can never reach a HOST.
    check('admins_kind_password_check', sql`(kind = 'HOST') = (password_hash IS NULL)`),
    // One HOST per tenant: «میزبان» is one principal, whoever the owner is.
    uniqueIndex('admins_tenant_host_key')
      .on(table.tenantId)
      .where(sql`kind = 'HOST'`),
  ],
);

/**
 * Roles: a tenant-scoped, editable composition over the frozen permission
 * catalog. Never an enum — the legacy role column is one, which is why it holds
 * four values in one surface and seven in the other, cannot be changed, and
 * audits nothing.
 *
 * System roles are seeded from `ROLE_SEEDS` and cannot be deleted. An
 * installation that deleted its owner role would have no way back in.
 */
export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    key: text('key').notNull(),
    name: text('name').notNull(),
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /**
     * Phase D3: optimistic concurrency for the role editor. An edit names the version it
     * was made from and the UPDATE matches on it; a zero row count is a conflict, never
     * a merge (ADR-0021's rule for every versioned edit).
     */
    version: integer('version').notNull().default(1),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (table) => [
    unique('roles_tenant_id_key').on(table.tenantId, table.id),
    check('roles_version_check', sql`version >= 1`),
    uniqueIndex('roles_tenant_key_key').on(table.tenantId, table.key),
    check('roles_key_shape_check', sql`key ~ '^[a-z][a-z0-9_]{1,63}$'`),
  ],
);

/**
 * Which permissions a role carries.
 *
 * `tenant_id` is carried here as well as on `roles`, and is part of the unique
 * index. It is denormalised on purpose: it makes every scoped query a
 * single-table predicate rather than a join the caller could forget, which is
 * the whole basis of application-level tenant isolation (ADR-0004).
 */
export const rolePermissions = pgTable(
  'role_permissions',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    roleId: uuid('role_id').notNull(),
    permissionKey: text('permission_key').notNull(),
  },
  (table) => [
    uniqueIndex('role_permissions_pkey').on(table.tenantId, table.roleId, table.permissionKey),
    index('role_permissions_role_idx').on(table.roleId),
    // Composite: the role must belong to THIS tenant. A single-column reference
    // would let a row name tenant A while granting tenant B's role.
    foreignKey({
      name: 'role_permissions_tenant_role_fk',
      columns: [table.tenantId, table.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }),
  ],
);

/** Role assignment. An admin may hold several roles; effective = the union. */
export const adminRoles = pgTable(
  'admin_roles',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    roleId: uuid('role_id').notNull(),
    assignedAt: timestamptz('assigned_at').notNull().defaultNow(),
    /**
     * The admin who granted this. NULL only for the installation bootstrap,
     * which has no acting administrator because none exists yet — a fabricated
     * actor there would be the invented identity this codebase refuses. The
     * audit row, with actor SYSTEM_JOB, carries the full story.
     */
    assignedByAdminId: uuid('assigned_by_admin_id'),
  },
  (table) => [
    uniqueIndex('admin_roles_pkey').on(table.tenantId, table.adminId, table.roleId),
    index('admin_roles_admin_idx').on(table.adminId),
    index('admin_roles_role_idx').on(table.roleId),
    foreignKey({
      name: 'admin_roles_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    foreignKey({
      name: 'admin_roles_tenant_role_fk',
      columns: [table.tenantId, table.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }),
    // Only an administrator of this tenant can have granted a role in it.
    foreignKey({
      name: 'admin_roles_tenant_assigned_by_fk',
      columns: [table.tenantId, table.assignedByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * Per-admin overrides on top of their roles.
 *
 * Justified by the resolution rule already frozen in the contract
 * (`resolveEffectivePermissions`): effective = (roles ∪ GRANT) − DENY, DENY
 * always wins, and an expired override stops applying without anyone running a
 * cleanup job. A `reason` is mandatory — an unexplained standing exception is
 * indistinguishable from a mistake six months later.
 */
export const adminPermissionOverrides = pgTable(
  'admin_permission_overrides',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    permissionKey: text('permission_key').notNull(),
    effect: text('effect').notNull(),
    reason: text('reason').notNull(),
    expiresAt: timestamptz('expires_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    createdByAdminId: uuid('created_by_admin_id'),
  },
  (table) => [
    uniqueIndex('admin_permission_overrides_pkey').on(
      table.tenantId,
      table.adminId,
      table.permissionKey,
      table.effect,
    ),
    index('admin_permission_overrides_admin_idx').on(table.adminId),
    check(
      'admin_permission_overrides_effect_check',
      enumCheck('effect', PERMISSION_OVERRIDE_EFFECTS),
    ),
    foreignKey({
      name: 'admin_permission_overrides_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    foreignKey({
      name: 'admin_permission_overrides_tenant_created_by_fk',
      columns: [table.tenantId, table.createdByAdminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * Sessions.
 *
 * Only the SHA-256 of the token is stored, so reading this table cannot
 * impersonate anyone — a database backup, a log line or a support screenshot
 * carries nothing usable. The plaintext exists in exactly one response body and
 * is never recoverable afterwards.
 *
 * Revocation is a timestamp rather than a delete, so "when was this session
 * killed, and by what" survives.
 */
export const adminSessions = pgTable(
  'admin_sessions',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    issuedAt: timestamptz('issued_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    lastSeenAt: timestamptz('last_seen_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
    revokedReason: text('revoked_reason'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /**
     * Phase 6B «ورود به پنل» (ADR-0039 § 9): set on a session the installation owner entered
     * into this hosted tenant — the owner's admin id in the INSTALLATION tenant, and the
     * «میزبانی‌ها» section session it was opened from and ends with. Plain uuids, no foreign
     * key: they name another tenant's rows, and `admin_sessions` is never exported.
     */
    impersonatedByAdminId: uuid('impersonated_by_admin_id'),
    impersonationHostingSessionId: uuid('impersonation_hosting_session_id'),
  },
  (table) => [
    check(
      'admin_sessions_impersonation_check',
      sql`(impersonated_by_admin_id IS NULL) = (impersonation_hosting_session_id IS NULL)`,
    ),
    // The section-close revocation's read: the entered sessions of one section session.
    index('admin_sessions_impersonation_idx')
      .on(table.impersonationHostingSessionId)
      .where(sql`impersonation_hosting_session_id IS NOT NULL`),
    // Global rather than per-tenant: the token is the lookup key and is
    // presented before any tenant is known, so it must be unique everywhere.
    uniqueIndex('admin_sessions_token_key').on(table.tokenHash),
    index('admin_sessions_admin_idx').on(table.tenantId, table.adminId),
    index('admin_sessions_expiry_idx')
      .on(table.expiresAt)
      .where(sql`revoked_at IS NULL`),
    // Retention, and deliberately NOT partial.
    //
    // The index above is partial on `revoked_at IS NULL`, which is right for
    // finding live sessions and useless to the sweeper: retention collects
    // revoked rows too, so its query cannot imply that predicate and would fall
    // back to a sequential scan. Harmless on a small table, and not harmless at
    // all now that connections carry a statement timeout — a backlog big enough
    // to scan past it would have made every sweep fail, leaving growth an
    // attacker can drive permanent.
    index('admin_sessions_retention_idx').on(table.expiresAt),
    // The session lookup is the one read that is unscoped by necessity, and it
    // RETURNS the tenant everything downstream is scoped to. A row naming the
    // wrong tenant would hand a caller a scope that is not theirs.
    foreignKey({
      name: 'admin_sessions_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * Login throttling.
 *
 * Durable rather than in Redis, for two reasons: an attacker must not be able
 * to clear their own counter by waiting for a cache eviction or a restart, and
 * the tests must be deterministic — the window advances by the injected Clock,
 * not by sleeping.
 *
 * Keyed by subject rather than by admin id, so a username that does not exist
 * is throttled exactly like one that does. Throttling only real accounts would
 * turn the lockout itself into a username oracle.
 */
export const adminLoginThrottle = pgTable(
  'admin_login_throttle',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    subjectKind: text('subject_kind').notNull(),
    subject: text('subject').notNull(),
    failedCount: integer('failed_count').notNull().default(0),
    windowStartedAt: timestamptz('window_started_at').notNull(),
    lockedUntil: timestamptz('locked_until'),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('admin_login_throttle_pkey').on(table.tenantId, table.subjectKind, table.subject),
    // Retention. The unique index above leads with `tenant_id` and serves the
    // per-subject lookups; nothing supported the sweeper's predicate, so every
    // batch scanned the whole table — the one an unauthenticated caller can
    // grow at will, and the one a statement timeout then makes unsweepable.
    index('admin_login_throttle_retention_idx').on(table.windowStartedAt, table.lockedUntil),
    check('admin_login_throttle_kind_check', enumCheck('subject_kind', ['USERNAME', 'IP'])),
    check('admin_login_throttle_count_check', sql`failed_count >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// Owner security alerts — Phase 6A D0
// ---------------------------------------------------------------------------

/**
 * The addresses each administrator has signed in to the Web Admin from (Phase 6A D0).
 *
 * A sign-in from an address NOT in this table, for an administrator who already has a row,
 * is `auth.login_new_ip` in the installation owner's operations group. The first sign-in an
 * administrator ever makes only remembers its address: an owner told about every new
 * account's first login would learn to ignore the alert. Written in the transaction that
 * mints the session, so a remembered address always belongs to a session that exists.
 *
 * Only addresses the trusted-proxy configuration lets the API believe are recorded; an
 * unbelievable one (null) is neither remembered nor alerted on. Tenant-owned, so row-level
 * security covers it like every admin table.
 */
export const adminKnownIps = pgTable(
  'admin_known_ips',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    ip: text('ip').notNull(),
    firstSeenAt: timestamptz('first_seen_at').notNull(),
    lastSeenAt: timestamptz('last_seen_at').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'admin_known_ips_pkey',
      columns: [table.tenantId, table.adminId, table.ip],
    }),
    foreignKey({
      name: 'admin_known_ips_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    check('admin_known_ips_ip_check', sql`length(ip) BETWEEN 2 AND 64`),
  ],
);

/**
 * How many rows each administrator read through the Web Admin in one fixed window
 * (Phase 6A D0, `security.bulk_read_*`). One row per (admin, window start); the window is
 * half-open `[window_start, window_start + length)`. `alerted_at` is set by the one increment
 * that crossed the threshold, so a window is announced to the owner at most once. Rows older
 * than a day are removed by the next read of the same administrator.
 */
export const adminReadWindows = pgTable(
  'admin_read_windows',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    windowStart: timestamptz('window_start').notNull(),
    rowsRead: bigint('rows_read', { mode: 'number' }).notNull().default(0),
    alertedAt: timestamptz('alerted_at'),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    primaryKey({
      name: 'admin_read_windows_pkey',
      columns: [table.tenantId, table.adminId, table.windowStart],
    }),
    foreignKey({
      name: 'admin_read_windows_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
    check('admin_read_windows_rows_check', sql`rows_read >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// Admin security — Phase D2 (program §17)
// ---------------------------------------------------------------------------

/**
 * An administrator's TOTP factor (RFC 6238). At most ONE row per administrator.
 *
 * `PENDING` is an enrolment that has displayed its secret and is waiting for the first
 * code; `ACTIVE` is a factor sign-in demands. No row is "disabled": disabling DELETES the
 * row, so a turned-off factor leaves no ciphertext behind, and enrolling again mints a new
 * row id — which is the entity the secret's AEAD context names, so an old ciphertext
 * cannot be put back.
 *
 * `last_used_step` is the replay defence: the 30-second step of the last code accepted.
 * A code is accepted only for a step STRICTLY greater, decided by a conditional UPDATE
 * under the row lock, so one code is good once even when two requests carry it at the
 * same instant. `integer` is enough: the step count passes 2^31 in the year 4011.
 */
export const adminTotpFactors = pgTable(
  'admin_totp_factors',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    state: text('state').notNull(),
    totpSecretCiphertext: text('totp_secret_ciphertext').notNull(),
    totpSecretKeyId: text('totp_secret_key_id').notNull(),
    lastUsedStep: integer('last_used_step'),
    /**
     * The session that started a PENDING enrolment. Activation is refused from any other
     * session: the secret was shown to that one, and a different session presenting a
     * code is somebody guessing rather than somebody scanning (security review, D2).
     * Null once active, and for an enrolment made without a session.
     */
    enrolledSessionId: uuid('enrolled_session_id'),
    /** Wrong activation codes against this PENDING row; past the cap it is discarded. */
    activationAttempts: integer('activation_attempts').notNull().default(0),
    createdAt: timestamptz('created_at').notNull(),
    activatedAt: timestamptz('activated_at'),
    updatedAt: timestamptz('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('admin_totp_factors_admin_key').on(table.tenantId, table.adminId),
    check('admin_totp_factors_state_check', enumCheck('state', ['PENDING', 'ACTIVE'])),
    // The two columns cannot disagree about whether the factor is on.
    check(
      'admin_totp_factors_activated_check',
      sql`(state = 'ACTIVE') = (activated_at IS NOT NULL)`,
    ),
    check('admin_totp_factors_step_check', sql`last_used_step IS NULL OR last_used_step >= 0`),
    check('admin_totp_factors_attempts_check', sql`activation_attempts >= 0`),
    foreignKey({
      name: 'admin_totp_factors_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * Backup codes: one row per code of the administrator's CURRENT generation.
 *
 * Only a hash is stored. The code is 80 bits from the CSPRNG, so — as with a session
 * token — a plain SHA-256 is right and a slow KDF would only add latency: there is
 * nothing to brute-force. The hash is domain-separated and salted with the tenant and
 * administrator, so equal hashes in two rows say nothing.
 *
 * Regenerating DELETES the previous generation in the transaction that inserts the new
 * one; disabling the factor deletes them all. A used code keeps its row (with `used_at`)
 * until then, which is what "N of 10 remaining" counts. Consumption is one conditional
 * UPDATE on `used_at IS NULL`, so a code is spent once however many requests race it.
 */
export const adminBackupCodes = pgTable(
  'admin_backup_codes',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    codeHash: text('code_hash').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    usedAt: timestamptz('used_at'),
  },
  (table) => [
    uniqueIndex('admin_backup_codes_hash_key').on(table.tenantId, table.adminId, table.codeHash),
    foreignKey({
      name: 'admin_backup_codes_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);

/**
 * A password-verified sign-in waiting for its second factor.
 *
 * Not a session, and deliberately not a row in `admin_sessions` with a flag: every reader
 * of that table — authentication, `isLive`, the session list, revocation counts — would
 * have to remember the flag, and the one that forgot would be a session that skipped
 * the second factor. A separate table cannot be mistaken for a session.
 *
 * Only the SHA-256 of the challenge token is stored, like a session's. The
 * `credential_fingerprint` is a SHA-256 of the password hash the first step verified:
 * the session is minted only if the stored hash still matches it, so a password rotated
 * between the two steps voids the challenge exactly as it voids a login in flight.
 * `attempts` bounds the guesses one challenge allows; `consumed_at` makes it single-use.
 */
export const adminLoginChallenges = pgTable(
  'admin_login_challenges',
  {
    id: uuid('id').primaryKey(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    adminId: uuid('admin_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    credentialFingerprint: text('credential_fingerprint').notNull(),
    issuedAt: timestamptz('issued_at').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: timestamptz('consumed_at'),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (table) => [
    // Global, like the session token: it is presented before any tenant is known.
    uniqueIndex('admin_login_challenges_token_key').on(table.tokenHash),
    index('admin_login_challenges_admin_idx').on(table.tenantId, table.adminId),
    // Retention.
    index('admin_login_challenges_retention_idx').on(table.expiresAt),
    check('admin_login_challenges_attempts_check', sql`attempts >= 0`),
    foreignKey({
      name: 'admin_login_challenges_tenant_admin_fk',
      columns: [table.tenantId, table.adminId],
      foreignColumns: [admins.tenantId, admins.id],
    }),
  ],
);
