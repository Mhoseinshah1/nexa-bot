import { z } from 'zod';
import { adminChangeReasonSchema, adminDisplayNameSchema } from './identity.js';
import {
  DELIVERY_OUTCOMES,
  NOTIFICATION_KINDS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TRANSPORTS,
} from './notifications.js';
import { OPERATIONAL_SEVERITIES } from './ports.js';
import {
  SETTING_CLASSIFICATIONS,
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
  PANEL_NAME_MIN_LENGTH,
  PANEL_STATUSES,
} from './panels.js';
import {
  CREDENTIAL_SHAPES,
  PROVIDER_CAPABILITIES,
  PROVIDER_FAILURE_KINDS,
  PROVIDER_TYPES,
} from './provider.js';

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
const isoTimestamp = z.iso.datetime();
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
});
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

export const panelListResponseSchema = z.object({ panels: z.array(panelSummarySchema) });
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
export const panelCredentialsInputSchema = z.object({
  username: z.string().min(1).max(512).nullable().optional(),
  password: z.string().min(1).max(1024).nullable().optional(),
  apiToken: z.string().min(1).max(4096).nullable().optional(),
});
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

export const setPanelStatusRequestSchema = z.object({
  status: z.enum(PANEL_STATUSES),
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
