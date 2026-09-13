import { z } from 'zod';
import { adminChangeReasonSchema, adminDisplayNameSchema } from './identity.js';
import {
  DELIVERY_OUTCOMES,
  NOTIFICATION_KINDS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TRANSPORTS,
} from './notifications.js';
import { uuidV7Schema } from './ids.js';
import { CUSTOMER_STATUSES, telegramUserIdSchema } from './customer.js';
import {
  MAX_DEVICE_LIMIT,
  MAX_DURATION_DAYS,
  MAX_TRAFFIC_BYTES,
  PRODUCT_AUDIENCES,
  PRODUCT_DESCRIPTION_MAX_LENGTH,
  PRODUCT_SORT_MAX,
  PRODUCT_SORT_MIN,
  PRODUCT_STATUSES,
  PRODUCT_TITLE_MAX_LENGTH,
} from './catalog.js';
import { ORDER_STATES } from './commerce.js';
import { CURRENCY_CODES } from './money.js';
import { OPERATIONAL_SEVERITIES } from './ports.js';
import {
  SETTING_CLASSIFICATIONS,
  SETTING_CONSUMERS,
  SETTING_MUTABILITIES,
  SETTING_SOURCES,
  ZERO_MEANINGS,
} from './settings.js';
import { FEATURE_FLAG_SOURCES, FLAG_BLAST_RADII } from './features.js';
import { PLACEHOLDER_TYPES, TEMPLATE_FORMATS, TEMPLATE_REVISION_ACTIONS } from './templates.js';
import {
  PANEL_BASE_URL_MAX_LENGTH,
  PANEL_HEALTH_VIEWS,
  PANEL_NAME_MAX_LENGTH,
  PANEL_PAGE_MAX,
  PANEL_NAME_MIN_LENGTH,
  PANEL_STATUSES,
} from './panels.js';
import {
  CREDENTIAL_SHAPES,
  PROVIDER_CAPABILITIES,
  PROVIDER_FAILURE_KINDS,
  PROVIDER_TYPES,
} from './provider.js';
import { isStorableInstant } from './time.js';
import {
  BACKUP_DELIVERY_STATES,
  BACKUP_RUN_STATES,
  BACKUP_STAGES,
  BACKUP_TRIGGERS,
} from './backup.js';
import {
  RECOVERY_CONFIRMATION_PHRASE,
  RECOVERY_FAILURE_CODES,
  RECOVERY_SOURCES,
  RECOVERY_STAGES,
  RECOVERY_STATES,
  recoveryRestoreTestSchema,
  recoveryVerificationSchema,
  uploadedArtifactSchema,
} from './recovery.js';

/**
 * The HTTP seam.
 *
 * These schemas are the single source of truth for API shapes. The server
 * validates responses against them and the web admin parses with them, so a
 * change to a shape is a type error in BOTH at once rather than a runtime
 * surprise in one.
 */

export const API_PREFIX = '/api/admin/v1';

export const dependencyStatusSchema = z.object({
  name: z.string(),
  status: z.enum(['up', 'down']),
  detail: z.string().optional(),
  latencyMs: z.number().nonnegative().optional(),
  /**
   * Whether this dependency being down makes the process NOT READY.
   *
   * Reported rather than implied, because the two are not the same question and
   * conflating them produced a real availability gap: Redis is probed, and Redis
   * stores nothing. `createRedis` is constructed, handed to this probe, exported
   * and closed — four references — and the only command issued anywhere is
   * `ping`. Every piece of admission, rate-limit and idempotency state is in
   * PostgreSQL, on purpose: `login_throttle` writes down why, that an attacker
   * must not be able to clear their own counter by waiting out a cache eviction.
   *
   * So a Redis outage used to fail the API's healthcheck and could roll a release
   * back, for a dependency that holds no state and that nothing reads. That is a
   * self-inflicted outage, and `docs/hardening-audit.md` § F records it as an
   * argument against depending on Redis rather than for it.
   *
   * An administrator still SEES it down — the detail is the point of the
   * authenticated endpoint — and the load balancer is no longer told the process
   * cannot serve traffic it can serve.
   *
   * Optional so an older client parses a newer response; absent means required,
   * which is the safe reading.
   */
  required: z.boolean().optional(),
});
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;

/** Liveness: is the process running. Deliberately says nothing about dependencies. */
export const healthLiveResponseSchema = z.object({
  status: z.literal('ok'),
  uptimeSeconds: z.number().nonnegative(),
});
export type HealthLiveResponse = z.infer<typeof healthLiveResponseSchema>;

/**
 * Readiness: can this process serve traffic. 200 or 503, and nothing else.
 *
 * Deliberately minimal, and it used to carry the dependency list. This endpoint
 * is anonymous — it has to be, because the thing asking is a load balancer or a
 * container orchestrator with no credentials — and what it answered told that
 * anonymous caller which dependencies the deployment has, what each one is
 * called, how long each took to answer, how many migrations are applied, how far
 * behind the outbox relay is, and a classification of the current failure. That
 * is a description of the system's internals, served fastest at exactly the
 * moment it is broken.
 *
 * A load balancer needs the status code. It has never needed the reasons.
 *
 * The detail did not disappear: `systemReadinessResponseSchema` carries it to
 * an authenticated Web Admin session.
 */
export const healthReadyResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
});
export type HealthReadyResponse = z.infer<typeof healthReadyResponseSchema>;

/**
 * Readiness with its reasons, for an operator who has signed in.
 *
 * Authentication is the whole gate, and no new permission guards it. What this
 * exposes is the shape of the deployment rather than any tenant's data, every
 * administrator needs it when something is wrong, and a permission nobody can
 * be denied is a permission that exists to be looked at rather than enforced.
 */
export const systemReadinessResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  dependencies: z.array(dependencyStatusSchema),
});
export type SystemReadinessResponse = z.infer<typeof systemReadinessResponseSchema>;

/**
 * What the background panel monitor is actually configured to do.
 *
 * Read-only, and it exists because the alternative is a screen that PRINTS a
 * cadence. The shipped default is three minutes; a deployment can set anything
 * the schema accepts, and an admin panel that renders "every 3 minutes" from a
 * constant in its own bundle would be stating a number the installation may not
 * be running. That is the legacy statistics screen counting CONFIGURED panels
 * and calling them connected, in a new place.
 *
 * The two ceilings are computed SERVER-side by the same functions the monitor's
 * own capacity conditions use. Recomputing them in the browser would be a
 * second implementation of the arithmetic, free to disagree with the one that
 * decides whether an alarm fires.
 */
export const monitorProfileSchema = z.object({
  enabled: z.boolean(),
  tickMs: z.number().int().positive(),
  healthyIntervalMs: z.number().int().positive(),
  retryableIntervalMs: z.number().int().positive(),
  nonRetryableIntervalMs: z.number().int().positive(),
  batchSize: z.number().int().positive(),
  concurrency: z.number().int().positive(),
  tenantsPerTick: z.number().int().positive(),
  probeTenantLimit: z.number().int().positive(),
  probeTenantWindowMs: z.number().int().positive(),
  probeCooldownMs: z.number().int().positive(),
  budgetReservePercent: z.number().int().nonnegative(),
  /** The constant a surface calls a result stale against. */
  freshForMs: z.number().int().positive(),
  /** The most panels ONE tenant's probe budget could keep inside that window. */
  tenantFreshPanelCeiling: z.number().int().nonnegative(),
  /** The most the scheduler could START on across the whole installation. */
  installationFreshPanelCeiling: z.number().int().nonnegative(),
  /**
   * The most TENANTS the fairness rotation can reach inside one freshness
   * window — a third bound, independent of the two panel ceilings above.
   *
   * A hundred tenants of one panel each is a hundred panels: comfortably under
   * the installation ceiling, and still more tenants than the rotation can
   * visit, so their panels go stale with nothing to say so. Reported because
   * it is the bound that was invisible.
   */
  tenantTurnCeiling: z.number().int().nonnegative(),
  /**
   * Whether the installation is CURRENTLY over that ceiling.
   *
   * The condition itself lives in `operational_events` under `SYSTEM_SCOPE`
   * with a null tenant, where the tenant-scoped `GET /ops-log` reader cannot
   * reach it under any scope. Reported here because this response is already
   * installation-scoped, so it is the one surface that can answer without
   * weakening that reader's isolation.
   */
  schedulerCapacityExceeded: z.boolean(),
});
export type MonitorProfile = z.infer<typeof monitorProfileSchema>;

export const monitorProfileResponseSchema = z.object({ monitor: monitorProfileSchema });
export type MonitorProfileResponse = z.infer<typeof monitorProfileResponseSchema>;

/**
 * Build metadata. Requires an authenticated session.
 *
 * Version, commit, build time, Node version and environment are not secrets and
 * they are not for strangers either: together they name the exact revision an
 * attacker would go and read, and the Node build whose advisories they would
 * check first. An administrator sees it; an anonymous caller does not.
 */
export const healthInfoResponseSchema = z.object({
  name: z.string(),
  version: z.string(),
  commit: z.string(),
  buildTime: z.string(),
  nodeVersion: z.string(),
  environment: z.string(),
});
export type HealthInfoResponse = z.infer<typeof healthInfoResponseSchema>;

export const errorResponseSchema = z.object({
  error: z.object({
    kind: z.string(),
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
    correlationId: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const HEALTH_ROUTES = {
  live: '/health/live',
  ready: '/health/ready',
  info: '/health/info',
} as const;

export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const TELEGRAM_SECRET_TOKEN_HEADER = 'x-telegram-bot-api-secret-token';

/**
 * The Telegram update, parsed at the boundary.
 *
 * Deliberately MINIMAL. This is not an attempt to model Telegram's `Update`,
 * which is large, versioned by somebody else, and mostly irrelevant to a phase
 * that handles one command. It states only what this installation actually
 * depends on, and lets everything else through untouched.
 *
 * It exists because `@Body() update: Update` is a TypeScript type and nothing
 * more: at runtime the body was whatever was posted. Every other command on
 * this codebase is parsed at the boundary, and this one was not — so a body
 * with no `update_id` reached the write path and was keyed as the literal
 * string `unknown`, collapsing every malformed update from one bot onto a
 * single idempotency key.
 *
 * `update_id` is an integer in Telegram's own schema. It is required and
 * checked as one here, so a string, a float or an object is refused before
 * anything is written rather than being coerced into a key.
 */
export const telegramUpdateSchema = z
  .object({
    update_id: z.number().int(),
  })
  // Unknown keys pass through: Telegram adds fields without asking, and a
  // strict object here would reject valid traffic on their release schedule
  // rather than on ours.
  .passthrough();
export type TelegramUpdate = z.infer<typeof telegramUpdateSchema>;

// ---------------------------------------------------------------------------
// Web Admin authentication and administration
// ---------------------------------------------------------------------------

/**
 * These schemas are the seam. The server parses requests with them and
 * validates responses against them; the web admin parses responses with the
 * same objects. A shape change is a type error in both at once — which is the
 * mechanism that stops the two surfaces drifting the way the legacy system's
 * did, with four admin roles on one side and seven on the other.
 */

export const loginRequestSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** The admin as any authenticated surface may see them. Never a password field. */
export const adminSummarySchema = z.object({
  id: z.string(),
  username: z.string(),
  displayName: z.string(),
  status: z.enum(['ACTIVE', 'DISABLED']),
  telegramUserId: z.string().nullable(),
  roleKeys: z.array(z.string()),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
});
export type AdminSummary = z.infer<typeof adminSummarySchema>;

/**
 * The login response.
 *
 * It carries NO session credential. The token exists only in the `Set-Cookie`
 * header, which is `HttpOnly`, so page script cannot read it.
 *
 * An earlier version also returned the token in this body, on the reasoning
 * that a non-browser client would want one. That handed the same bearer
 * credential to every script running on the admin page and undid most of what
 * `HttpOnly` buys: one XSS, one `fetch('/auth/login')` away from a token that
 * outlives the page. A CLI or API credential is a separate surface with its own
 * lifetime, scope and revocation — not this cookie leaked through a JSON field.
 *
 * `expiresAt` stays: it is metadata about the session, not a way to use it.
 */
export const loginResponseSchema = z.object({
  expiresAt: z.string(),
  admin: adminSummarySchema,
  /** Resolved server-side. The UI uses it to hide chrome — never to authorize. */
  permissions: z.array(z.string()),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const sessionResponseSchema = z.object({
  admin: adminSummarySchema,
  permissions: z.array(z.string()),
  expiresAt: z.string(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

export const logoutResponseSchema = z.object({ ok: z.literal(true) });
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(12).max(1024),
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const createAdminRequestSchema = z.object({
  username: z.string().min(3).max(64),
  displayName: adminDisplayNameSchema,
  password: z.string().min(12).max(1024),
  roleKeys: z.array(z.string()).min(1),
  telegramUserId: z
    .string()
    .regex(/^[0-9]{1,20}$/)
    .nullable()
    .optional(),
});
export type CreateAdminRequest = z.infer<typeof createAdminRequestSchema>;

export const setAdminStatusRequestSchema = z.object({
  status: z.enum(['ACTIVE', 'DISABLED']),
  reason: adminChangeReasonSchema,
});
export type SetAdminStatusRequest = z.infer<typeof setAdminStatusRequestSchema>;

export const setAdminRolesRequestSchema = z.object({
  roleKeys: z.array(z.string()),
  reason: adminChangeReasonSchema,
});
export type SetAdminRolesRequest = z.infer<typeof setAdminRolesRequestSchema>;

export const adminListResponseSchema = z.object({ admins: z.array(adminSummarySchema) });
export type AdminListResponse = z.infer<typeof adminListResponseSchema>;

export const roleSummarySchema = z.object({
  key: z.string(),
  name: z.string(),
  isSystem: z.boolean(),
  permissions: z.array(z.string()),
});
export type RoleSummary = z.infer<typeof roleSummarySchema>;

export const roleListResponseSchema = z.object({ roles: z.array(roleSummarySchema) });
export type RoleListResponse = z.infer<typeof roleListResponseSchema>;

/** Routes, relative to `API_PREFIX`. One place, so the client cannot guess. */
export const AUTH_ROUTES = {
  login: '/auth/login',
  logout: '/auth/logout',
  session: '/auth/session',
  password: '/auth/password',
} as const;

export const ADMIN_ROUTES = {
  list: '/admins',
  create: '/admins',
  status: (id: string) => `/admins/${id}/status`,
  roles: (id: string) => `/admins/${id}/roles`,
  rolesCatalog: '/roles',
} as const;

// ---------------------------------------------------------------------------
// The control plane
// ---------------------------------------------------------------------------

/**
 * Timestamps cross this seam as ISO-8601 strings in UTC.
 *
 * JSON has no date type, so the alternative is a number whose unit nobody
 * states. The legacy log group mixes Jalali and Gregorian in one stream, which
 * is the same mistake one layer up: Jalali is a display concern and this is a
 * wire format.
 */
const isoTimestamp = z.iso.datetime().refine((v) => isStorableInstant(new Date(v)), {
  // `z.iso.datetime()` is a SHAPE check, not a range one. It accepts
  // `0000-01-01T00:00:00Z`, which parses, reaches the driver, and raises
  // `22008` — a 500 on a bad request, on the endpoint the round that guarded
  // the other two cited as already correct. The rule is `time.ts`'s, so all
  // three cursors now fail the same way for the same reason.
  message: 'Not an instant this API can store.',
});
const nullableIsoTimestamp = isoTimestamp.nullable();

export const resolvedSettingSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  source: z.enum(SETTING_SOURCES),
  /**
   * The stored row's version, or null when there is genuinely no row.
   *
   * A row whose value no longer parses reports `source: 'DEFAULT'` — the
   * default is what is in force — but still reports ITS OWN version, because
   * that is what a caller must state to overwrite it. Reporting null there made
   * the key permanently unwritable: the write took its first-write branch, the
   * insert conflicted with the row that was there all along, and every reload
   * returned null again.
   */
  version: z.number().int().positive().nullable(),
  updatedAt: nullableIsoTimestamp,
  updatedByAdminId: z.string().nullable(),
  description: z.string(),
  /** What `0`, empty or absent means for THIS key. Returned with every read. */
  zeroMeaning: z.enum(ZERO_MEANINGS),
  mutability: z.enum(SETTING_MUTABILITIES),
  classification: z.enum(SETTING_CLASSIFICATIONS),
  configures: z.string().nullable(),
  /**
   * Whether anything in this release reads the value.
   *
   * On the wire so the admin can say "stored, and nothing consumes it yet"
   * without holding its own list of which keys those are — a list that would go
   * stale on the release a consumer lands, and go stale silently.
   */
  consumer: z.enum(SETTING_CONSUMERS),
  /**
   * A row exists whose value no longer parses against its declaration, so the
   * default is in force. A surface should say so rather than present the
   * default as a deliberate choice, and submitting a valid value repairs it.
   */
  storedValueInvalid: z.boolean(),
});
export type ResolvedSettingResponse = z.infer<typeof resolvedSettingSchema>;

export const settingListResponseSchema = z.object({ settings: z.array(resolvedSettingSchema) });
export type SettingListResponse = z.infer<typeof settingListResponseSchema>;

export const setSettingRequestSchema = z.object({
  value: z.unknown(),
  /**
   * The version the caller read. Required, and null means "I read this as
   * unset". An optional expectation becomes an omitted one, and an omitted one
   * is last-writer-wins with extra steps.
   */
  expectedVersion: z.number().int().positive().nullable(),
  idempotencyKey: z.string().min(8).max(255),
});
export type SetSettingRequest = z.infer<typeof setSettingRequestSchema>;

/**
 * What a setting write answers with.
 *
 * The persisted row AND whether it changed anything. `docs/conventions.md`
 * requires that a no-op says it was a no-op: three unrelated legacy subsystems
 * report success for writes that touched nothing, and one of them answered
 * "✅ updated" three times in a row while a product stayed broken
 * (SOURCE_BUG-002). A response that cannot express "nothing changed" cannot
 * comply with that rule however carefully the service computes it.
 */
export const settingWriteResponseSchema = z.object({
  setting: resolvedSettingSchema,
  changed: z.boolean(),
});
export type SettingWriteResponse = z.infer<typeof settingWriteResponseSchema>;

export const featureFlagSchema = z.object({
  key: z.string(),
  enabled: z.boolean(),
  source: z.enum(FEATURE_FLAG_SOURCES),
  version: z.number().int().positive().nullable(),
  updatedAt: nullableIsoTimestamp,
  updatedByAdminId: z.string().nullable(),
  reason: z.string().nullable(),
  description: z.string(),
  /** TENANT_WIDE toggles go through the confirmation protocol (ADR-0010). */
  blastRadius: z.enum(FLAG_BLAST_RADII),
  /**
   * The settings this flag governs, each marked inert when the flag is off.
   *
   * Travelling together is the point: in the legacy system the flag and its
   * threshold sit on different screens, and the flag being off silently makes
   * the value do nothing (CBR-007, GSR-008).
   */
  configuration: z.array(resolvedSettingSchema.extend({ inert: z.boolean() })),
});
export type FeatureFlagResponse = z.infer<typeof featureFlagSchema>;

export const featureFlagListResponseSchema = z.object({ flags: z.array(featureFlagSchema) });
export type FeatureFlagListResponse = z.infer<typeof featureFlagListResponseSchema>;

export const featureFlagWriteResponseSchema = z.object({
  flag: featureFlagSchema,
  changed: z.boolean(),
});
export type FeatureFlagWriteResponse = z.infer<typeof featureFlagWriteResponseSchema>;

export const setFeatureFlagRequestSchema = z.object({
  enabled: z.boolean(),
  expectedVersion: z.number().int().positive().nullable(),
  idempotencyKey: z.string().min(8).max(255),
  /** Typed confirmation of the flag's own key. Required for TENANT_WIDE. */
  confirmKey: z.string().optional(),
  reason: z.string().min(3).max(500).optional(),
});
export type SetFeatureFlagRequest = z.infer<typeof setFeatureFlagRequestSchema>;

export const placeholderSchema = z.object({
  token: z.string(),
  type: z.enum(PLACEHOLDER_TYPES),
  description: z.string(),
  required: z.boolean(),
  repeatable: z.boolean(),
});

export const templateViewSchema = z.object({
  key: z.string(),
  locale: z.string(),
  description: z.string(),
  format: z.enum(TEMPLATE_FORMATS),
  placeholders: z.array(placeholderSchema),
  maxLength: z.number().int().positive(),
  /** The body in force — what a customer would actually receive. */
  body: z.string(),
  /**
   * The tenant's RAW override, if stored, whether or not it is applied.
   * This is what the edit field is populated from. Never a rendered string.
   */
  overrideBody: z.string().nullable(),
  defaultBody: z.string(),
  source: z.enum(['DEFAULT', 'TENANT']),
  overrideSuppressed: z.boolean(),
  version: z.number().int().positive().nullable(),
  revision: z.number().int().positive().nullable(),
  updatedAt: nullableIsoTimestamp,
  updatedByAdminId: z.string().nullable(),
});
export type TemplateViewResponse = z.infer<typeof templateViewSchema>;

export const templateListResponseSchema = z.object({ templates: z.array(templateViewSchema) });
export type TemplateListResponse = z.infer<typeof templateListResponseSchema>;

/**
 * What a template write answers with.
 *
 * The same rule as a setting write: the persisted view, the revision it
 * produced, and whether anything actually changed. Re-saving an identical body
 * is a no-op and says so, rather than answering "saved" and writing a duplicate
 * revision.
 */
export const templateWriteResponseSchema = z.object({
  template: templateViewSchema,
  revision: z.number().int().positive(),
  changed: z.boolean(),
});
export type TemplateWriteResponse = z.infer<typeof templateWriteResponseSchema>;

export const setTemplateRequestSchema = z.object({
  body: z.string().min(1),
  expectedVersion: z.number().int().positive().nullable(),
  /**
   * The revision the caller read, alongside the version.
   *
   * BOTH, because a version alone does not identify a row here. A revert
   * DELETES the override, and the next save inserts a fresh row at version 1 —
   * so an administrator holding a stale version 1 could state it, match the new
   * row's version 1, and silently overwrite work done after the revert. The
   * version check was doing exactly what it was written to do and could not
   * see the difference.
   *
   * `revision` cannot restart: it is `max(template_revisions.revision) + 1`
   * over an append-only table that the revert does not touch, and the revert is
   * itself a revision. Carrying it makes the expectation name a point in the
   * key's history rather than a position in one row's lifetime.
   */
  expectedRevision: z.number().int().positive().nullable(),
  idempotencyKey: z.string().min(8).max(255),
});
export type SetTemplateRequest = z.infer<typeof setTemplateRequestSchema>;

export const revertTemplateRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  /** See `setTemplateRequestSchema.expectedRevision`. */
  expectedRevision: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(255),
});
export type RevertTemplateRequest = z.infer<typeof revertTemplateRequestSchema>;

export const previewTemplateRequestSchema = z.object({
  /** The body on screen, so a preview shows what is being edited. */
  body: z.string(),
  /**
   * Sample values supplied by the caller, never taken from their own account.
   *
   * TEXT, because a preview form is text fields, and coerced server-side to
   * each placeholder's declared type by `coerceTemplateValues`. Accepting
   * `string | number` here instead made a `NUMBER` placeholder rejected on
   * every attempt from the admin screen and made `DATETIME` and `MONEY` ones
   * impossible to supply at all: the field could only send a string, and the
   * validator only accepted a `Date` or a `Money`.
   */
  values: z
    .record(
      z.string().max(200),
      // BOUNDED. The values reach `coerceTemplateValues`, and an unbounded one
      // was a way for any `templates.view` holder to hand the server a
      // megabyte to parse as a number.
      z.string().max(1_000),
    )
    .optional(),
});
export type PreviewTemplateRequest = z.infer<typeof previewTemplateRequestSchema>;

export const previewTemplateResponseSchema = z.object({
  rendered: z.string(),
  unresolved: z.array(z.string()),
});
export type PreviewTemplateResponse = z.infer<typeof previewTemplateResponseSchema>;

export const templateRevisionSchema = z.object({
  revision: z.number().int().positive(),
  action: z.enum(TEMPLATE_REVISION_ACTIONS),
  /** The body a SET stored. Null for a REVERT, which stores none. */
  body: z.string().nullable(),
  createdAt: isoTimestamp,
  createdByAdminId: z.string().nullable(),
});
export type TemplateRevisionResponse = z.infer<typeof templateRevisionSchema>;

export const templateRevisionListResponseSchema = z.object({
  revisions: z.array(templateRevisionSchema),
});
export type TemplateRevisionListResponse = z.infer<typeof templateRevisionListResponseSchema>;

export const operationalEventSchema = z.object({
  id: z.string(),
  code: z.string(),
  severity: z.enum(OPERATIONAL_SEVERITIES),
  message: z.string(),
  context: z.record(z.string(), z.unknown()).nullable(),
  occurrenceCount: z.number().int().positive(),
  firstSeenAt: isoTimestamp,
  lastSeenAt: isoTimestamp,
  correlationId: z.string().nullable(),
  recoversCode: z.string().nullable(),
  /** Set when the condition cleared. The row is never removed either way. */
  resolvedAt: nullableIsoTimestamp,
  resolvedByEventId: z.string().nullable(),
});
export type OperationalEventResponse = z.infer<typeof operationalEventSchema>;

export const operationalEventListResponseSchema = z.object({
  events: z.array(operationalEventSchema),
  /**
   * The cursor for the next (older) page, or `null` on the last one.
   *
   * Returned by the server, which is the only party that can know. A surface
   * comparing `rows.length` against the size it asked for cannot tell a full
   * last page from a full page with more behind it, so it offers an "older"
   * page that does not exist and the operator lands on the empty state — a
   * false "no open alerts" in the subsystem whose stated rule is that silence
   * is the one outcome it may not produce.
   *
   * It carries `(first_seen_at, id)` — the IMMUTABLE pair — and the list is
   * ordered by it, `DESC` on both. Not `last_seen_at`: every repeat occurrence
   * of a deduped condition rewrites that, so a row below the cursor that
   * recurred jumped above it and appeared on no later page. `lastSeenAt` above
   * is still the latest occurrence and is what the screen displays; it is
   * metadata, not a traversal key.
   *
   * So this list is ordered by when a condition FIRST appeared. A
   * most-recently-active ordering is a different view with its own pagination
   * semantics for a mutable key, and is deliberately not bought by weakening
   * this one.
   */
  nextCursor: z.object({ at: isoTimestamp, id: z.string() }).nullable(),
});
export type OperationalEventListResponse = z.infer<typeof operationalEventListResponseSchema>;

export const notificationSchema = z.object({
  id: z.string(),
  kind: z.enum(NOTIFICATION_KINDS),
  status: z.enum(NOTIFICATION_STATUSES),
  templateKey: z.string(),
  attemptCount: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  createdAt: isoTimestamp,
  lastAttemptAt: nullableIsoTimestamp,
  completedAt: nullableIsoTimestamp,
  correlationId: z.string().nullable(),
});
export type NotificationResponse = z.infer<typeof notificationSchema>;

export const notificationListResponseSchema = z.object({
  notifications: z.array(notificationSchema),
  /**
   * The cursor for the next (older) page, or `null` on the last one.
   *
   * Returned rather than derived by the caller, so a surface cannot tell a
   * full page from the last one by guessing at the page size — the mistake
   * that had the alerts pager offering an "older" page that did not exist.
   */
  nextCursor: z.object({ at: isoTimestamp, id: z.string() }).nullable(),
});
/**
 * The bounded page size a notification list accepts.
 *
 * A schema rather than `Number(query.limit)` followed by a clamp. The clamp
 * carried `NaN` straight through — `Math.min(Math.max(NaN, 1), 200)` is `NaN` —
 * and into the SQL `LIMIT`, where it surfaced as an internal error rather than
 * a bad request. Fractional, infinite, zero and negative spellings were
 * silently rewritten rather than refused, so a caller could not tell a
 * misspelled request from an honoured one.
 */
export const notificationListQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(200).optional(),
    /**
     * The keyset cursor: the `createdAt` of the oldest intent already shown,
     * and its id.
     *
     * BOTH, because `created_at` is not unique — a `Clock.now()` is captured
     * once per transaction, so several intents share one microsecond — and a
     * strict comparison on the timestamp alone skips the rest of a group that
     * straddles a page boundary. Those rows then appear on no page at all,
     * which is the defect the operational log had to fix for the same reason.
     *
     * Before this existed, the repository accepted `before` and the controller
     * never parsed it, so the newest page was the ONLY page: past fifty intents
     * the older ones were unreachable from the Web Admin unless their UUID was
     * already known.
     */
    before: isoTimestamp.optional(),
    /**
     * Validated as an ID, not as any string under 64 characters.
     *
     * `beforeId=oops` used to reach the repository, which compares it against a
     * PostgreSQL `uuid` column — so a malformed cursor became a driver error and
     * a 500 where the caller had sent a bad query parameter and deserved a 400.
     */
    beforeId: uuidV7Schema.optional(),
  })
  .refine((query) => (query.before === undefined) === (query.beforeId === undefined), {
    // BOTH halves or neither. A timestamp without its tie-break is the cursor
    // bug this pair exists to avoid, and the controller silently dropped a
    // lone half and answered 200 with the NEWEST page — so a paging client
    // whose cursor was truncated looped on page one instead of being told.
    message: 'before and beforeId must be supplied together.',
    path: ['beforeId'],
  });

/**
 * The page size a notification list uses when the caller names none.
 *
 * Shared, because the controller has to know the size it asked for in order to
 * decide whether `nextCursor` is set, and the service applies the same default
 * when it clamps. Two spellings of "50" would make the pager offer a page that
 * is not there, or hide one that is.
 */
export const NOTIFICATION_PAGE_DEFAULT = 50;
export type NotificationListQuery = z.infer<typeof notificationListQuerySchema>;

export type NotificationListResponse = z.infer<typeof notificationListResponseSchema>;

export const deliveryAttemptSchema = z.object({
  attemptNumber: z.number().int().positive(),
  transport: z.enum(NOTIFICATION_TRANSPORTS),
  outcome: z.enum(DELIVERY_OUTCOMES),
  startedAt: isoTimestamp,
  finishedAt: isoTimestamp,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  retryAfterMs: z.number().int().nonnegative().nullable(),
});
export type DeliveryAttemptResponse = z.infer<typeof deliveryAttemptSchema>;

/**
 * A claim that was handed back without ever reaching the transport.
 *
 * The counterpart to a delivery attempt: an attempt row says what happened on
 * the wire, and one of these says that on this number nothing did. Together
 * they are what the intent's `attemptCount` is made of, so an operator reading
 * a history where the two disagree in number can see why.
 *
 * `reason` is a machine code, never a sentence — `tenant.not_active` for a
 * claim returned because the installation was stopped mid-batch, and
 * `sweep.withdrawn` for the one case that reads strangely without it: the
 * exhaustion sweep's own FAILED_PERMANENT row, retired when a hand-back showed
 * the intent had never actually spent its attempts. Without this array that row
 * is an ordinary permanent failure sitting in the history of an intent that is
 * somehow PENDING again.
 */
export const releasedClaimSchema = z.object({
  attemptNumber: z.number().int().positive(),
  releasedAt: isoTimestamp,
  reason: z.string(),
});
export type ReleasedClaimResponse = z.infer<typeof releasedClaimSchema>;

/**
 * One intent and everything that happened to it.
 *
 * The two halves are returned together and stay distinguishable, which is the
 * question the legacy system cannot answer about its own notification report
 * (UNK-LGR-015). `releasedClaims` is the third: the claims that were issued and
 * given back, which is the only thing that explains an `attemptCount` larger
 * than the attempt list under it.
 */
export const notificationDetailResponseSchema = z.object({
  notification: notificationSchema,
  attempts: z.array(deliveryAttemptSchema),
  releasedClaims: z.array(releasedClaimSchema),
});
export type NotificationDetailResponse = z.infer<typeof notificationDetailResponseSchema>;

/**
 * The test-send request.
 *
 * It carries an idempotency key because it is a state-changing command and
 * every one of those takes one — a double-clicked button, a browser retry or a
 * proxy replay must not produce two messages and two audit rows. That is a
 * different mechanism from the intent's dedupe key, which answers a different
 * question: each test IS its own question, so two deliberate tests are two
 * intents.
 */
export const sendTestNotificationRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
});
export type SendTestNotificationRequest = z.infer<typeof sendTestNotificationRequestSchema>;

/**
 * What a test send answers with.
 *
 * The intent, its REAL attempts, its returned claims, and whether this call
 * created anything. Answering with the detail shape and a hard-coded empty
 * attempt list said "nothing has been tried yet" for a replay of a key whose
 * message had already failed twice — a screen reporting a state the database
 * does not hold, which is the legacy pattern this module exists to end. A
 * replay whose claims were handed back has the same gap, so the same three
 * fields answer here as on the detail route.
 */
export const sendTestNotificationResponseSchema = z.object({
  notification: notificationSchema,
  attempts: z.array(deliveryAttemptSchema),
  releasedClaims: z.array(releasedClaimSchema),
  /** False when this call replayed an earlier one rather than queueing anything. */
  created: z.boolean(),
  replayed: z.boolean(),
});
export type SendTestNotificationResponse = z.infer<typeof sendTestNotificationResponseSchema>;

export const CONTROL_ROUTES = {
  settings: '/settings',
  setting: (key: string) => `/settings/${encodeURIComponent(key)}`,
  features: '/features',
  feature: (key: string) => `/features/${encodeURIComponent(key)}`,
  templates: '/templates',
  template: (key: string) => `/templates/${encodeURIComponent(key)}`,
  templateRevert: (key: string) => `/templates/${encodeURIComponent(key)}/revert`,
  templatePreview: (key: string) => `/templates/${encodeURIComponent(key)}/preview`,
  templateRevisions: (key: string) => `/templates/${encodeURIComponent(key)}/revisions`,
  opsLog: '/ops-log',
  notifications: '/notifications',
  notification: (id: string) => `/notifications/${encodeURIComponent(id)}`,
  notificationTest: '/notifications/test',
  /** Readiness with dependency detail. Authenticated; see the schema. */
  systemReadiness: '/system/readiness',
  /** What the background panel monitor is configured to do. Read-only. */
  systemMonitor: '/system/monitor',
} as const;

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

/**
 * The panel seam.
 *
 * The single most important thing about these schemas is what is NOT in them.
 * There is no credential field on any response — not the value, not a masked
 * form of it, not the ciphertext, not the key id. The legacy web admin rendered
 * a panel's stored password as readable text on its detail page (WEB-BR-007);
 * an operator there could read every panel credential by visiting a page.
 *
 * A masked placeholder would be worse than the omission it pretends to be. An
 * edit form populated with `********` submits `********` back, and the panel
 * password becomes eight asterisks — so the shape below reports only WHETHER a
 * credential is configured and when it was last replaced.
 */
export const panelCredentialStateSchema = z.object({
  configured: z.boolean(),
  /** Null when never set. Not a value, and not derivable into one. */
  lastReplacedAt: nullableIsoTimestamp,
});
export type PanelCredentialState = z.infer<typeof panelCredentialStateSchema>;

export const panelHealthSchema = z.object({
  state: z.enum(PANEL_HEALTH_VIEWS),
  checkedAt: nullableIsoTimestamp,
  latencyMs: z.number().int().nonnegative().nullable(),
  /** The normalized failure, never a provider message. Null when healthy. */
  failure: z.enum(PROVIDER_FAILURE_KINDS).nullable(),
  /** The upstream status, when there was one. A number discloses nothing. */
  status: z.number().int().nullable(),
  providerVersion: z.string().nullable(),
  lastHealthyAt: nullableIsoTimestamp,
  /**
   * Whether the result is old enough that an operator should not act on it.
   *
   * Computed server-side against one constant rather than sent as a threshold
   * for each client to apply differently — the legacy statistics screen counts
   * CONFIGURED panels and calls them "connected" (RSV2-BR-021), which is the
   * same class of mistake: a surface deciding for itself what a number means.
   */
  stale: z.boolean(),
});
export type PanelHealthResponse = z.infer<typeof panelHealthSchema>;

export const panelSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  providerType: z.enum(PROVIDER_TYPES),
  providerName: z.string(),
  baseUrl: z.string(),
  status: z.enum(PANEL_STATUSES),
  /**
   * Declared by the adapter's descriptor, never discovered and never stored.
   *
   * A capability read from a row is a capability that can be stale, and a stale
   * one is how an installation tries an operation the panel cannot do — or
   * refuses one it can. The descriptor is code, so it is right by construction.
   */
  capabilities: z.array(z.enum(PROVIDER_CAPABILITIES)),
  credentials: z.object({
    username: panelCredentialStateSchema,
    password: panelCredentialStateSchema,
    apiToken: panelCredentialStateSchema,
  }),
  health: panelHealthSchema,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type PanelSummaryResponse = z.infer<typeof panelSummarySchema>;

/**
 * Which side of the archive to list.
 *
 * `exclude` is the working fleet and the default — an archived panel is retired
 * and does not belong in the list an operator scans every day.
 *
 * `only` exists because "not in the list" turned out to mean "gone". Archiving
 * removed a panel from the ONE browser the Web Admin has, so the Restore
 * control on its detail page was reachable only by an operator who had kept the
 * UUID. A lifecycle with an exit and no way back to the door is a dead end, and
 * the server could already answer the question.
 *
 * Deliberately two values rather than an `includeArchived` boolean: mixing
 * retired panels into the live list is a different, worse answer to a different
 * question, and it is the one an operator looking for something to restore
 * would have to filter by eye.
 */
export const PANEL_LIST_ARCHIVED_MODES = ['exclude', 'only'] as const;
export type PanelListArchivedMode = (typeof PANEL_LIST_ARCHIVED_MODES)[number];

/**
 * The panel page, and the ONE place that says what an unreadable cursor does.
 *
 * A cursor this server cannot decode is a **400**. It never restarts the
 * traversal.
 *
 *   - absent  → the first page
 *   - valid   → the next page
 *   - anything else → 400, never a successful-looking answer
 *
 * TWO codes, because there are two bounds and saying there is one was not
 * true: a cursor longer than the `max(512)` below is `request.invalid` from
 * this schema, and everything that reaches the decoder is
 * `control.invalid_value`. Both are 400s a client can act on, and both are
 * asserted separately in `panels-http.test.ts` so the two cannot swap
 * unnoticed. The length bound lives HERE and only here — the decoder used to
 * carry a second copy of it, which could not fire and whose comment described
 * a path that no longer existed.
 *
 * This is the house rule for every cursor in this API, and `/ops-log` and
 * `/notifications` have always followed it. Panels did not: `decodeCursor`
 * returned `null` for anything unreadable, a null cursor dropped the keyset
 * predicate, and the endpoint answered 200 with page ONE. A client that
 * truncated or invented a cursor looped on the first page for ever and was
 * never told — while the Web Admin's own client docblock promised a 400 that
 * had never existed. Two defensible rules described in three places that
 * disagreed, resolved by the owner in favour of refusing.
 *
 * The old argument for restarting — that refusing a legal-but-unknown id would
 * "restart the traversal for ever rather than fail it" — is inverted
 * deliberately. Failing loudly once is strictly better than looping silently,
 * because the loop is invisible to everyone including the operator watching it.
 *
 * The list used to return every live panel of the tenant with both child rows
 * joined, so one request materialised the whole collection, sorted it and
 * serialised it on the event loop. At the stated target of tens of thousands of
 * panels that is a request any administrator can repeat. `nextCursor` is null
 * on the last page and opaque on purpose — a caller that parsed it would be
 * depending on an ordering this API has not promised.
 */
export const panelListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(PANEL_PAGE_MAX).optional(),
  cursor: z.string().max(512).optional(),
  archived: z.enum(PANEL_LIST_ARCHIVED_MODES).optional(),
});
export type PanelListQuery = z.infer<typeof panelListQuerySchema>;

export const panelListResponseSchema = z.object({
  panels: z.array(panelSummarySchema),
  nextCursor: z.string().nullable(),
});
export type PanelListResponse = z.infer<typeof panelListResponseSchema>;

export const panelResponseSchema = z.object({ panel: panelSummarySchema });
export type PanelResponse = z.infer<typeof panelResponseSchema>;

const panelNameSchema = z.string().trim().min(PANEL_NAME_MIN_LENGTH).max(PANEL_NAME_MAX_LENGTH);

const panelBaseUrlSchema = z.string().trim().min(1).max(PANEL_BASE_URL_MAX_LENGTH);

/**
 * The credential half of a write.
 *
 * ABSENT and NULL mean different things, and that difference is the whole
 * reason this is a separate shape. Absent means "leave whatever is stored" —
 * so an operator who edits a panel's name and submits the form does not erase
 * its password by not mentioning it. Null means "remove this credential", which
 * is a deliberate act an operator has to perform on purpose.
 *
 * `.optional()` and `.nullable()` together are therefore load-bearing rather
 * than permissive, and the service branches on `undefined` versus `null`.
 */
export const panelCredentialsInputSchema = z
  .object({
    username: z.string().min(1).max(512).nullable().optional(),
    password: z.string().min(1).max(1024).nullable().optional(),
    apiToken: z.string().min(1).max(4096).nullable().optional(),
  })
  /*
   * AT LEAST ONE recognised field, present or null.
   *
   * Every field being optional made `{}` a valid credential write — and,
   * because unknown keys are stripped, so was `{ api_token: "…" }`. The
   * service then wrote a credential row with every column untouched, made
   * the panel probe-eligible, recorded a SUCCESS replacement naming no
   * credential kinds, and told the caller it had succeeded: a write that
   * changed no secret and said it had. An object that names nothing is a
   * malformed command, not a no-op. Null keeps its meaning — "remove this
   * one" — and a create that omits the object entirely still means "no
   * credentials".
   */
  .refine(
    (input) =>
      input.username !== undefined || input.password !== undefined || input.apiToken !== undefined,
    {
      message:
        'A credential write names at least one credential: username, password or apiToken. ' +
        'Null removes one; omit the object to leave them all as they are.',
    },
  );
export type PanelCredentialsInput = z.infer<typeof panelCredentialsInputSchema>;

export const createPanelRequestSchema = z.object({
  name: panelNameSchema,
  providerType: z.enum(PROVIDER_TYPES),
  baseUrl: panelBaseUrlSchema,
  credentials: panelCredentialsInputSchema.optional(),
  idempotencyKey: z.string().min(8).max(255),
});
export type CreatePanelRequest = z.infer<typeof createPanelRequestSchema>;

/**
 * A safe-configuration edit. Credentials are NOT here.
 *
 * Replacing a credential is a different permission (`panels.credentials.rotate`,
 * CRITICAL) from editing a name (`panels.edit`, HIGH), so it is a different
 * route. Accepting both on one endpoint would mean the endpoint had to hold the
 * higher permission, and every name change would need the right to rotate
 * credentials.
 *
 * `providerType` is absent deliberately: changing it would reinterpret the
 * stored credentials against a different protocol. Archive the panel and make a
 * new one.
 */
export const updatePanelRequestSchema = z.object({
  name: panelNameSchema.optional(),
  baseUrl: panelBaseUrlSchema.optional(),
  idempotencyKey: z.string().min(8).max(255),
});
export type UpdatePanelRequest = z.infer<typeof updatePanelRequestSchema>;

export const setPanelCredentialsRequestSchema = z.object({
  credentials: panelCredentialsInputSchema,
  idempotencyKey: z.string().min(8).max(255),
});
export type SetPanelCredentialsRequest = z.infer<typeof setPanelCredentialsRequestSchema>;

/**
 * A lifecycle transition, and — only when leaving the archive — a new name.
 *
 * The name is here because of a real dead end. `panels_tenant_name_live_key` is
 * UNIQUE `(tenant_id, name) WHERE status <> 'ARCHIVED'`, so archiving RELEASES
 * the name and another panel may take it. Restoring then puts the old row back
 * under that index and collides. `update` refuses every edit to an ARCHIVED
 * panel with `PANEL_ARCHIVED`, so the operator could not rename it out of the
 * way either: the panel could never be restored, by any sequence of requests.
 *
 * Renaming AS PART OF the restore is the resolution that does not contradict
 * the archived-edit rule — the row stops being archived in the same
 * transaction, so this is not an edit to an archived panel. It is accepted only
 * on a transition out of `ARCHIVED`; sending it with any other status is a
 * validation error rather than a silently ignored field.
 */
export const setPanelStatusRequestSchema = z.object({
  status: z.enum(PANEL_STATUSES),
  // The SAME schema create and update use. Hand-spelling the bounds here let
  // a change to `PANEL_NAME_MIN_LENGTH`/`MAX_LENGTH` apply everywhere except a
  // restore, which would then store a name the rest of the system rejects.
  name: panelNameSchema.optional(),
  idempotencyKey: z.string().min(8).max(255),
});
export type SetPanelStatusRequest = z.infer<typeof setPanelStatusRequestSchema>;

/**
 * A connection test.
 *
 * Idempotency-keyed like every other state-changing command, because it IS one:
 * it writes a health row and an audit entry. It is also the one operation that
 * deliberately runs against a DISABLED panel — an operator disables a panel
 * precisely because something is wrong with it, and "you may not test this
 * until you re-enable it" would make them re-enable a panel to find out whether
 * they should. It never runs against an ARCHIVED one.
 */
export const testPanelRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
});
export type TestPanelRequest = z.infer<typeof testPanelRequestSchema>;

export const testPanelResponseSchema = z.object({
  panel: panelSummarySchema,
  /**
   * False when no probe was made and the panel's stored health is what came
   * back — either this call replayed an earlier one under the same idempotency
   * key, or a probe of the same configuration ran recently enough that
   * repeating it would be a way to hammer the provider.
   */
  probed: z.boolean(),
});
export type TestPanelResponse = z.infer<typeof testPanelResponseSchema>;

export const PANEL_ROUTES = {
  list: '/panels',
  create: '/panels',
  detail: (id: string) => `/panels/${encodeURIComponent(id)}`,
  update: (id: string) => `/panels/${encodeURIComponent(id)}`,
  credentials: (id: string) => `/panels/${encodeURIComponent(id)}/credentials`,
  status: (id: string) => `/panels/${encodeURIComponent(id)}/status`,
  test: (id: string) => `/panels/${encodeURIComponent(id)}/test`,
  providers: '/providers',
} as const;

/** The provider catalogue, so a surface can populate a picker without guessing. */
export const providerDescriptorSchema = z.object({
  key: z.enum(PROVIDER_TYPES),
  canonicalName: z.string(),
  // From the frozen list, not a copy of it: a shape added to the catalogue
  // and forgotten here would be a provider the surface cannot describe.
  credentialShape: z.enum(CREDENTIAL_SHAPES),
  capabilities: z.array(z.enum(PROVIDER_CAPABILITIES)),
  requiredActivationFields: z.array(z.string()),
});

export const providerListResponseSchema = z.object({
  providers: z.array(providerDescriptorSchema),
});
export type ProviderListResponse = z.infer<typeof providerListResponseSchema>;

// --- Customers (Phase 4A) ---------------------------------------------------

/**
 * The page and reason bounds, as CONTRACT values.
 *
 * Here rather than in the service, because a schema at the boundary may not import from
 * `apps/` — and because a bound a caller is held to is part of the interface. The service
 * clamps to the same numbers; the schema refuses past them, so an oversized request is a
 * 400 rather than a silently smaller page.
 */
export const CUSTOMER_PAGE_DEFAULT = 25;
export const CUSTOMER_PAGE_MAX = 100;
export const CUSTOMER_BLOCK_REASON_MAX_LENGTH = 500;

/**
 * One customer, as the Web Admin renders them.
 *
 * What is NOT here is the point. No message text, no order history inline, no wallet
 * balance — a list row that carried a balance would make every page a financial
 * aggregate, and a list that carried message text would put third-party prose into a
 * response an operator's browser caches.
 *
 * `telegramUserId` is a STRING, matching the column and `provider-note.ts`: every use of
 * it is identity, and a JSON number above 2^53 is a different id than the one stored.
 *
 * `blockedReason` is an OPERATOR note and is returned only to an operator — it is never
 * rendered to the customer, and `bot.blocked` declares no placeholder for it.
 */
export const customerSummarySchema = z.object({
  id: z.string(),
  telegramUserId: z.string(),
  username: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  languageCode: z.string().nullable(),
  status: z.enum(CUSTOMER_STATUSES),
  /*
   * `z.iso.datetime()`, not `z.string()`.
   *
   * The Web Admin hands each of these straight to `formatTimestamp`, which would
   * render a non-date string as garbage rather than refuse it — and the response
   * schema is the only thing between the wire and that call. The backup and recovery
   * shapes below already use the strict form; `z.string()` here was the loose one.
   */
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
  blockedAt: z.iso.datetime().nullable(),
  blockedReason: z.string().nullable(),
});
export type CustomerSummaryResponse = z.infer<typeof customerSummarySchema>;

/**
 * The list query.
 *
 * `telegramUserId` is EXACT and `username` is a prefix, which is the asymmetry the
 * repository enforces and the reason is worth repeating at the boundary: a partial match
 * on a Telegram id would be a way to enumerate ids, while a username is half-remembered
 * and a prefix is what an operator actually has.
 */
export const customerListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(CUSTOMER_PAGE_MAX).optional(),
  cursor: z.string().max(512).optional(),
  /*
   * The CONTRACT's own Telegram-id schema, not "any short string".
   *
   * This was `z.string().max(32)`, so `?telegramUserId=12ab` was accepted, reached the
   * repository as an exact match, found nothing, and came back 200 with an empty page —
   * telling an operator that no such customer exists rather than that the identifier
   * cannot be read. Those are different answers and only one of them is true.
   *
   * It also made a comment in `apps/web/src/pages/users.tsx` false: that comment said
   * the client validates because "the server's refusal for a malformed one is a 400",
   * and the server did not refuse at all. Reusing `telegramUserIdSchema` here is what
   * makes the sentence true — one definition of what a Telegram id is, shared with the
   * webhook that resolves identity from it.
   *
   * A prefix-`username` search stays a plain bounded string: a half-remembered username
   * is exactly what an operator has, and refusing one would remove the feature.
   */
  telegramUserId: telegramUserIdSchema.optional(),
  username: z.string().max(64).optional(),
  status: z.enum(CUSTOMER_STATUSES).optional(),
});
export type CustomerListQuery = z.infer<typeof customerListQuerySchema>;

export const customerListResponseSchema = z.object({
  customers: z.array(customerSummarySchema),
  nextCursor: z.string().nullable(),
});
export type CustomerListResponse = z.infer<typeof customerListResponseSchema>;

export const customerResponseSchema = z.object({ customer: customerSummarySchema });
export type CustomerResponse = z.infer<typeof customerResponseSchema>;

/**
 * Block or unblock.
 *
 * The reason is optional and bounded. It is an operator note, so it is not required — an
 * operator who must type a justification to press a button types "x" — and it is bounded
 * because it lands in a durable column and an audit row.
 */
export const blockCustomerRequestSchema = z.object({
  /**
   * The key, in the BODY, exactly as every other command on this surface carries it.
   *
   * Not a header. The non-negotiable is that every state-changing command takes an
   * idempotency key, and the twelve commands that already exist take it here — a
   * thirteenth that took it from `Idempotency-Key` would be the one a client forgets,
   * because nothing in the schema would say it was missing.
   */
  idempotencyKey: z.string().min(8).max(255),
  reason: z.string().trim().max(CUSTOMER_BLOCK_REASON_MAX_LENGTH).optional(),
});
export type BlockCustomerRequest = z.infer<typeof blockCustomerRequestSchema>;

export const CUSTOMER_ROUTES = {
  list: '/users',
  detail: (id: string) => `/users/${encodeURIComponent(id)}`,
  block: (id: string) => `/users/${encodeURIComponent(id)}/block`,
  unblock: (id: string) => `/users/${encodeURIComponent(id)}/unblock`,
} as const;

// --- Products (Phase 4B) ----------------------------------------------------

export const PRODUCT_PAGE_DEFAULT = 25;
export const PRODUCT_PAGE_MAX = 100;

/**
 * One product, as the Web Admin renders it.
 *
 * `trafficBytes` and `priceAmount` are STRINGS on the wire and `bigint` in the
 * database. JSON has one number type and it is a double: a traffic allowance in bytes
 * passes 2^53 at eight petabytes, and an amount in minor units passes it at ninety
 * thousand billion Rial — both reachable, and both silently wrong rather than refused.
 * `money.ts` makes the same choice for the same reason.
 *
 * The price is two nullable fields rather than a nested object because the table stores
 * two columns and the CHECK binds them together; the application layer reassembles them
 * into one `Money`. What the wire may NOT do is carry one without the other, which is
 * why the schema refines the pair rather than trusting the caller.
 */
export const productSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    status: z.enum(PRODUCT_STATUSES),
    audience: z.enum(PRODUCT_AUDIENCES),
    sortOrder: z.number().int(),
    panelId: z.string().nullable(),
    durationDays: z.number().int(),
    trafficBytes: z.string(),
    deviceLimit: z.number().int().nullable(),
    priceAmount: z.string().nullable(),
    priceCurrency: z.enum(CURRENCY_CODES).nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .refine((p) => (p.priceAmount === null) === (p.priceCurrency === null), {
    message: 'A price is an amount and a currency, or it is absent.',
  });
export type ProductSummaryResponse = z.infer<typeof productSummarySchema>;

/**
 * The fields an operator writes.
 *
 * `status` is absent deliberately: a product is created INACTIVE and becomes
 * purchasable through its own command, so one call cannot publish an unpriced,
 * unfulfillable plan. The same shape serves create and edit, because the set of mutable
 * properties IS the set of writable ones — and every one of them is snapshotted onto an
 * order at confirmation, which is what makes editing safe.
 */
export const productWriteSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(255),
    title: z.string().trim().min(1).max(PRODUCT_TITLE_MAX_LENGTH),
    description: z.string().trim().max(PRODUCT_DESCRIPTION_MAX_LENGTH).nullable(),
    audience: z.enum(PRODUCT_AUDIENCES),
    sortOrder: z.number().int().min(PRODUCT_SORT_MIN).max(PRODUCT_SORT_MAX),
    panelId: z.string().nullable(),
    durationDays: z.number().int().min(0).max(MAX_DURATION_DAYS),
    /* A decimal STRING, parsed to `bigint` by the boundary rather than by the service. */
    trafficBytes: z.string().regex(/^\d{1,19}$/u),
    deviceLimit: z.number().int().min(1).max(MAX_DEVICE_LIMIT).nullable(),
    /*
     * Positive when present. `products_price_positive_check` says the same thing in the
     * database; a zero price would otherwise mean "free", and `catalog.ts` is explicit
     * that free is not a concept here — an absent price means unsellable.
     */
    priceAmount: z
      .string()
      .regex(/^\d{1,19}$/u)
      .nullable(),
    priceCurrency: z.enum(CURRENCY_CODES).nullable(),
  })
  .refine((p) => (p.priceAmount === null) === (p.priceCurrency === null), {
    message: 'A price is an amount and a currency, or it is absent.',
    path: ['priceAmount'],
  })
  .refine((p) => p.priceAmount === null || BigInt(p.priceAmount) > 0n, {
    message:
      'A price must be greater than zero. Leave it empty for a product that is not for sale.',
    path: ['priceAmount'],
  })
  .refine((p) => BigInt(p.trafficBytes) <= MAX_TRAFFIC_BYTES, {
    message: 'That traffic allowance is past any real plan.',
    path: ['trafficBytes'],
  });
export type ProductWriteRequest = z.infer<typeof productWriteSchema>;

export const productListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(PRODUCT_PAGE_MAX).optional(),
  cursor: z.string().max(512).optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
  audience: z.enum(PRODUCT_AUDIENCES).optional(),
  title: z.string().max(PRODUCT_TITLE_MAX_LENGTH).optional(),
});
export type ProductListQuery = z.infer<typeof productListQuerySchema>;

export const productListResponseSchema = z.object({
  products: z.array(productSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ProductListResponse = z.infer<typeof productListResponseSchema>;

export const productResponseSchema = z.object({ product: productSummarySchema });
export type ProductResponse = z.infer<typeof productResponseSchema>;

/** A state change carries only its key: the target state is the route. */
export const productStatusRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
});
export type ProductStatusRequest = z.infer<typeof productStatusRequestSchema>;

export const PRODUCT_ROUTES = {
  list: '/products',
  create: '/products',
  detail: (id: string) => `/products/${encodeURIComponent(id)}`,
  update: (id: string) => `/products/${encodeURIComponent(id)}`,
  activate: (id: string) => `/products/${encodeURIComponent(id)}/activate`,
  deactivate: (id: string) => `/products/${encodeURIComponent(id)}/deactivate`,
} as const;

// --- Orders ------------------------------------------------------------------

export const ORDER_PAGE_DEFAULT = 25;
export const ORDER_PAGE_MAX = 100;

/**
 * One order, as the Web Admin renders it.
 *
 * Every `line*` field is the SNAPSHOT. `productId` is here for navigation and is
 * explicitly not how the purchase is reconstructed — the product may since have been
 * renamed, re-priced or withdrawn, and the legacy «محصول حذف‌شده» is what a report that
 * joins on today's row produces. So the title an operator reads in this response is the
 * title the customer bought, not the title the plan has now.
 *
 * Amounts are decimal STRINGS for the reason `productSummarySchema` states: JSON has one
 * number type and an order total in Rial passes 2^53.
 *
 * There is deliberately no `quote` field. The trace is stored and an operator will need
 * it the day a customer disputes a number, but nothing renders it yet, and a field on the
 * wire with no reader is a field that drifts from the column behind it.
 */
export const orderSummarySchema = z.object({
  id: z.string(),
  customerId: z.string(),
  state: z.enum(ORDER_STATES),
  productId: z.string(),
  panelId: z.string(),
  lineTitle: z.string(),
  lineDurationDays: z.number().int(),
  lineTrafficBytes: z.string(),
  lineDeviceLimit: z.number().int().nullable(),
  lineUnitPriceAmount: z.string(),
  lineQuantity: z.number().int(),
  subtotalAmount: z.string(),
  discountAmount: z.string(),
  totalAmount: z.string(),
  currency: z.enum(CURRENCY_CODES),
  expiresAt: z.iso.datetime().nullable(),
  confirmedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type OrderSummaryResponse = z.infer<typeof orderSummarySchema>;

/**
 * How an operator narrows the list.
 *
 * Exact ids and an exact state, and no free-text search: an order has no name, and what
 * an operator actually quotes from a support conversation is an id.
 */
export const orderListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(ORDER_PAGE_MAX).optional(),
  cursor: z.string().max(512).optional(),
  state: z.enum(ORDER_STATES).optional(),
  /*
   * Checked as IDS, not as bounded strings.
   *
   * `orders.customer_id` and `orders.product_id` are `uuid` columns, so
   * `?customerId=abc` reaches PostgreSQL as `invalid input syntax for type uuid` and is
   * answered 500 — which tells an operator nothing about what they typed and puts a
   * stack trace in the log for a typo. `customerListQuerySchema` records the same
   * defect for `telegramUserId`, where the answer was an empty page reading as "no such
   * customer"; here it is worse, because a 500 reads as "the server is broken".
   *
   * Found by this branch's own self-review, not by a test — which is why the test came
   * with the fix.
   */
  customerId: uuidV7Schema.optional(),
  productId: uuidV7Schema.optional(),
});
export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

export const orderListResponseSchema = z.object({
  orders: z.array(orderSummarySchema),
  nextCursor: z.string().nullable(),
});
export type OrderListResponse = z.infer<typeof orderListResponseSchema>;

export const orderResponseSchema = z.object({ order: orderSummarySchema });
export type OrderResponse = z.infer<typeof orderResponseSchema>;

/**
 * Two routes, both reads.
 *
 * No cancel, no mark-paid, no refund, no settle. Those are real operator actions and
 * every one of them belongs to a phase that has not shipped: a "mark paid" button with
 * no payment behind it is the legacy system's silent-success pattern with a nicer font.
 */
export const ORDER_ROUTES = {
  list: '/orders',
  detail: (id: string) => `/orders/${encodeURIComponent(id)}`,
} as const;

// --- Backup and disaster recovery -------------------------------------------

/**
 * One backup run, as the Web Admin renders it.
 *
 * Every field here is a FACT the pipeline recorded, and the shape refuses to
 * collapse two of them. `state` says whether the run completed; `verifiedAt`
 * says whether a real `pg_restore` into a real empty database succeeded; and
 * `deliveryState` says what is known about Telegram — which, for
 * `OUTCOME_UNKNOWN`, is nothing. A single `status: 'ok'` would be three
 * different lies depending on which one was false.
 *
 * What is NOT here is as deliberate: no workspace path, no archive path, no
 * `keyId`, no connection string. `checksum` is a digest and is included because
 * it is what makes an archive verifiable by hand years later.
 * `archiveAvailable` is a boolean rather than a path — the surface needs to know
 * whether a download button will work, and does not need to know where the file
 * is.
 */
export const backupRunSummarySchema = z.object({
  id: z.string(),
  trigger: z.enum(BACKUP_TRIGGERS),
  state: z.enum(BACKUP_RUN_STATES),
  stage: z.enum(BACKUP_STAGES),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  /** Bytes, as strings: these are `bigint` columns and JSON has no bigint. */
  dumpBytes: z.string().nullable(),
  archiveBytes: z.string().nullable(),
  checksum: z.string().nullable(),
  verifiedAt: z.iso.datetime().nullable(),
  deliveryState: z.enum(BACKUP_DELIVERY_STATES),
  deliveryAttemptedAt: z.iso.datetime().nullable(),
  /**
   * WHETHER the delivery recorded a detail, never the detail.
   *
   * `backup_runs.delivery_detail` is an `Error.message` from the Telegram
   * transport, and its commonest value is an ENOENT naming the absolute path of
   * an encrypted archive. That is the same uncontrolled-string class
   * `failureCode` below exists to keep out of this response, and it was let
   * through one field away from the rule that excludes it.
   */
  deliveryDetailPresent: z.boolean(),
  /**
   * The failure CODE, and never the failure MESSAGE.
   *
   * `backup_runs.failure_message` holds an arbitrary `error.message` — the same
   * uncontrolled string Architecture Hardening finding 18 kept out of the
   * operator channel. It is kept out of this response for the same reason: a
   * code plus the stage is what makes an alert actionable, and the message is in
   * the log with a correlation id where an operator with shell access can read
   * it and a browser cannot.
   */
  failureCode: z.string().nullable(),
  cleanupOk: z.boolean(),
  /**
   * How many artefacts cleanup could not remove. Never their paths.
   *
   * The paths are absolute locations of undeleted PLAINTEXT dumps. An operator
   * needs to know that some remain — which this says — and where they are is a
   * question for the operational log and the host, not for a body any
   * `backup.view` holder can read.
   */
  cleanupLeftovers: z.number().int().nonnegative(),
  /** Whether the encrypted archive is still on this host and downloadable. */
  archiveAvailable: z.boolean(),
});
export type BackupRunSummary = z.infer<typeof backupRunSummarySchema>;

export const backupHistoryResponseSchema = z.object({
  runs: z.array(backupRunSummarySchema),
  /** Opaque keyset cursor for the next page, or null at the end. */
  nextCursor: z.string().nullable(),
});
export type BackupHistoryResponse = z.infer<typeof backupHistoryResponseSchema>;

export const backupRunDetailResponseSchema = z.object({ run: backupRunSummarySchema });
export type BackupRunDetailResponse = z.infer<typeof backupRunDetailResponseSchema>;

/**
 * What the backup section reports about the installation as a whole.
 *
 * `lastSucceededAt` is the same value the scheduler derives its next due time
 * from, so an operator and the scheduler cannot disagree about when the last
 * good backup was. `scheduleEnabled` is reported because a green history with
 * the schedule switched off is the shape that reads as healthy and is not.
 */
export const backupStatusResponseSchema = z.object({
  scheduleEnabled: z.boolean(),
  intervalMs: z.number().int().positive(),
  lastSucceededAt: z.iso.datetime().nullable(),
  /** The run currently holding the installation's backup lock, if any. */
  running: backupRunSummarySchema.nullable(),
  /** How many runs carry an unresolved `OUTCOME_UNKNOWN` delivery. */
  unknownDeliveries: z.number().int().nonnegative(),
  /** Whether a destructive recovery currently refuses new durable writes. */
  quiesced: z.boolean(),
});
export type BackupStatusResponse = z.infer<typeof backupStatusResponseSchema>;

export const runBackupRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
});
export type RunBackupRequest = z.infer<typeof runBackupRequestSchema>;

/**
 * What a "run backup now" press produced.
 *
 * `BUSY` is a first-class outcome and not an error, because one backup at a time
 * is the installation's invariant and a second presser being told "already
 * running, since 09:14" is that invariant working. Modelling it as a 409 would
 * make the surface render a failure for a correct answer.
 */
export const runBackupResponseSchema = z.object({
  outcome: z.enum(['COMPLETED', 'BUSY']),
  run: backupRunSummarySchema,
});
export type RunBackupResponse = z.infer<typeof runBackupResponseSchema>;

/**
 * One recovery request, as the Web Admin renders it.
 *
 * The failure is a CODE from the frozen `RECOVERY_FAILURE_CODES` vocabulary and
 * never a message, for the reason that enum's own docblock gives.
 * `displacedDatabase` is the name the outgoing database was renamed to, present
 * only after a cutover — it is not a secret (it is on the operator's own
 * server, and they need it to roll back by hand) and it is the one piece of
 * state that tells an operator whether production is the old database or the
 * new one.
 */
export const recoveryRequestSummarySchema = z.object({
  id: z.string(),
  source: z.enum(RECOVERY_SOURCES),
  state: z.enum(RECOVERY_STATES),
  stage: z.enum(RECOVERY_STAGES),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Who started it. A label captured at the time, so a rename cannot rewrite it. */
  requestedBy: z.string().nullable(),
  /** The backup this recovery is of, when the artifact identified itself. */
  backupId: z.string().nullable(),
  artifactChecksum: z.string().nullable(),
  failureCode: z.enum(RECOVERY_FAILURE_CODES).nullable(),
  correlationId: z.string().nullable(),
  upload: uploadedArtifactSchema.nullable(),
  verification: recoveryVerificationSchema.nullable(),
  restoreTest: recoveryRestoreTestSchema.nullable(),
  /** Set once a confirmation was accepted; the phrase itself is never stored. */
  confirmedAt: z.iso.datetime().nullable(),
  confirmationExpiresAt: z.iso.datetime().nullable(),
  /** The pre-restore backup this recovery took, once it has one. */
  preRestoreBackupId: z.string().nullable(),
  cutoverAt: z.iso.datetime().nullable(),
  displacedDatabase: z.string().nullable(),
  finishedAt: z.iso.datetime().nullable(),
});
export type RecoveryRequestSummary = z.infer<typeof recoveryRequestSummarySchema>;

export const recoveryListResponseSchema = z.object({
  recoveries: z.array(recoveryRequestSummarySchema),
  nextCursor: z.string().nullable(),
});
export type RecoveryListResponse = z.infer<typeof recoveryListResponseSchema>;

export const recoveryDetailResponseSchema = z.object({
  recovery: recoveryRequestSummarySchema,
});
export type RecoveryDetailResponse = z.infer<typeof recoveryDetailResponseSchema>;

/**
 * Whether this release can restore an archive at all, and from where.
 *
 * A capability document rather than a set of assumptions baked into the
 * surface. `foreignInstallationSupported` is `false` and is REPORTED rather
 * than omitted, so the Web Admin can say «پشتیبانی نمی‌شود» in the place an
 * operator would look for it instead of leaving the absence to be interpreted
 * as an oversight. `docs/disaster-recovery-audit.md` § D-10.
 */
export const recoveryCapabilitiesResponseSchema = z.object({
  uploadEnabled: z.boolean(),
  maxUploadBytes: z.number().int().positive(),
  foreignInstallationSupported: z.literal(false),
  /** The phrase the server will compare against. The surface shows it; it never decides it. */
  confirmationPhrase: z.literal(RECOVERY_CONFIRMATION_PHRASE),
  confirmationTtlMs: z.number().int().positive(),
});
export type RecoveryCapabilitiesResponse = z.infer<typeof recoveryCapabilitiesResponseSchema>;

export const startRecoveryFromRunRequestSchema = z.object({
  backupId: z.string(),
  idempotencyKey: z.string().min(8).max(255),
});
export type StartRecoveryFromRunRequest = z.infer<typeof startRecoveryFromRunRequestSchema>;

export const BACKUP_ROUTES = {
  status: '/backups/status',
  history: '/backups',
  detail: (id: string) => `/backups/${encodeURIComponent(id)}`,
  run: '/backups/run',
  download: (id: string) => `/backups/${encodeURIComponent(id)}/archive`,
} as const;

export const RECOVERY_ROUTES = {
  capabilities: '/recoveries/capabilities',
  list: '/recoveries',
  /**
   * The upload. A raw `application/octet-stream` body, streamed to disk.
   *
   * Not multipart: this endpoint takes exactly one file and no fields, so a
   * multipart parser would be a dependency and an attack surface bought to
   * decode a wrapper around the only thing being sent. The ceiling is enforced
   * on the STREAM by the server's own counter rather than by a declared
   * `content-length`, because a chunked request declares none.
   */
  upload: '/recoveries/upload',
  fromRun: '/recoveries/from-run',
  detail: (id: string) => `/recoveries/${encodeURIComponent(id)}`,
  confirm: (id: string) => `/recoveries/${encodeURIComponent(id)}/confirm`,
} as const;
