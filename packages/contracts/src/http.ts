import { z } from 'zod';
import { adminChangeReasonSchema, adminDisplayNameSchema } from './identity.js';

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

/** Readiness: can this process serve traffic. Names the failing dependency. */
export const healthReadyResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  dependencies: z.array(dependencyStatusSchema),
});
export type HealthReadyResponse = z.infer<typeof healthReadyResponseSchema>;

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
  source: z.enum(['DEFAULT', 'TENANT']),
  /** Null when the value is the default: no row, so no version to state. */
  version: z.number().int().positive().nullable(),
  updatedAt: nullableIsoTimestamp,
  updatedByAdminId: z.string().nullable(),
  description: z.string(),
  /** What `0`, empty or absent means for THIS key. Returned with every read. */
  zeroMeaning: z.enum(['DISABLES', 'UNLIMITED', 'LITERAL', 'NOT_APPLICABLE']),
  mutability: z.enum(['RUNTIME', 'RESTART_REQUIRED']),
  classification: z.enum(['PUBLIC', 'SENSITIVE']),
  configures: z.string().nullable(),
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
  source: z.enum(['DEFAULT', 'TENANT']),
  version: z.number().int().positive().nullable(),
  updatedAt: nullableIsoTimestamp,
  updatedByAdminId: z.string().nullable(),
  reason: z.string().nullable(),
  description: z.string(),
  /** TENANT_WIDE toggles go through the confirmation protocol (ADR-0010). */
  blastRadius: z.enum(['LOCAL', 'TENANT_WIDE']),
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
  type: z.enum(['STRING', 'NUMBER', 'MONEY', 'DATETIME', 'DURATION_DAYS', 'BYTES']),
  description: z.string(),
  required: z.boolean(),
  repeatable: z.boolean(),
});

export const templateViewSchema = z.object({
  key: z.string(),
  locale: z.string(),
  description: z.string(),
  format: z.enum(['PLAIN_TEXT', 'TELEGRAM_HTML']),
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

export const setTemplateRequestSchema = z.object({
  body: z.string().min(1),
  expectedVersion: z.number().int().positive().nullable(),
  idempotencyKey: z.string().min(8).max(255),
});
export type SetTemplateRequest = z.infer<typeof setTemplateRequestSchema>;

export const revertTemplateRequestSchema = z.object({
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(255),
});
export type RevertTemplateRequest = z.infer<typeof revertTemplateRequestSchema>;

export const previewTemplateRequestSchema = z.object({
  /** The body on screen, so a preview shows what is being edited. */
  body: z.string(),
  /** Sample values supplied by the caller, never taken from their own account. */
  values: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type PreviewTemplateRequest = z.infer<typeof previewTemplateRequestSchema>;

export const previewTemplateResponseSchema = z.object({
  rendered: z.string(),
  unresolved: z.array(z.string()),
});
export type PreviewTemplateResponse = z.infer<typeof previewTemplateResponseSchema>;

export const templateRevisionSchema = z.object({
  revision: z.number().int().positive(),
  action: z.enum(['SET', 'REVERT']),
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
  severity: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL']),
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
  kind: z.enum(['OPERATIONAL_EVENT', 'OPERATIONS_TEST']),
  status: z.enum(['PENDING', 'SENT', 'FAILED']),
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
  transport: z.enum(['TELEGRAM', 'RECORDING']),
  outcome: z.enum(['SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT']),
  startedAt: isoTimestamp,
  finishedAt: isoTimestamp,
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  retryAfterMs: z.number().int().nonnegative().nullable(),
});
export type DeliveryAttemptResponse = z.infer<typeof deliveryAttemptSchema>;

/**
 * One intent and everything that happened to it.
 *
 * The two halves are returned together and stay distinguishable, which is the
 * question the legacy system cannot answer about its own notification report
 * (UNK-LGR-015).
 */
export const notificationDetailResponseSchema = z.object({
  notification: notificationSchema,
  attempts: z.array(deliveryAttemptSchema),
});
export type NotificationDetailResponse = z.infer<typeof notificationDetailResponseSchema>;

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
} as const;
