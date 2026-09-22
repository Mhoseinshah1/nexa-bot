import { z } from 'zod';
import { adminChangeReasonSchema, adminDisplayNameSchema } from './identity.js';
import {
  DELIVERY_OUTCOMES,
  NOTIFICATION_KINDS,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TRANSPORTS,
} from './notifications.js';
import { uuidV7Schema } from './ids.js';
import {
  providerUsernameLookupSchema,
  USERNAME_PREFIX_MAX_LENGTH,
  USERNAME_STRATEGIES,
  USERNAME_TEMPLATE_MAX_LENGTH,
} from './service-username.js';
import { paymentAccountInputSchema } from './payment-accounts.js';
import { refundChannelSchema, refundStateSchema } from './refunds.js';
import {
  PAYMENT_GATEWAY_SORT_MAX,
  PAYMENT_GATEWAY_SORT_MIN,
  PAYMENT_GATEWAY_THRESHOLD_MAX,
  paymentGatewayProviderSchema,
  paymentGatewayStatusSchema,
} from './payment-gateways.js';
import { PAYMENT_RECEIPT_KINDS } from './payment-receipts.js';
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
  SERVICE_ADDON_KINDS,
  SERVICE_ADDON_STATUSES,
  SERVICE_ADDON_TITLE_MAX_LENGTH,
} from './catalog.js';
import { ORDER_STATES } from './commerce.js';
import {
  OPERATION_STATES,
  OPERATION_TYPES,
  SERVICE_DELIVERY_STATES,
  SERVICE_STATES,
} from './provisioning.js';
import { LEDGER_DIRECTIONS, LEDGER_REASONS } from './ledger.js';
import {
  PAYMENT_AMOUNT_MAX_MINOR,
  PAYMENT_EVIDENCE_KINDS,
  PAYMENT_METHODS,
  PAYMENT_STATES,
} from './payment.js';
import { CURRENCY_CODES, MAX_MONEY_AMOUNT_MINOR, salesCurrencyCodeSchema } from './money.js';
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
  PANEL_INELIGIBILITY_REASONS,
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

/**
 * The SERVER pattern for a route whose client builder URL-encodes its argument.
 *
 * ## The defect this exists to make unrepeatable
 *
 * Every route builder here calls `encodeURIComponent`, which is correct and must stay:
 * a real account id, a provider name or a payment reference has to survive a slash or a
 * space. But a controller that reused a builder to DECLARE its route —
 * `@Post(PAYMENT_GATEWAY_ROUTES.update(':provider'))` — got `%3Aprovider`, a literal
 * path segment. Nest then registered `/payment-gateways/%3Aprovider`, the real URL
 * matched nothing, and the operator was told `Cannot POST
 * /api/admin/v1/payment-gateways/MANUAL_TRANSFER`.
 *
 * Nine routes were registered that way and none of them worked. It reached a real
 * staging server because every test either called the service directly or stubbed
 * `fetch` — neither of which touches Nest's route table. `route-registration.test.ts`
 * is the test that does.
 *
 * ## Why derive rather than write the pattern out
 *
 * A hand-written `'payment-gateways/:provider'` beside a builder that produces
 * `/payment-gateways/${id}` is two statements of one path, and the next rename moves
 * one of them. This calls the SAME builder with a token `encodeURIComponent` leaves
 * untouched, then substitutes the parameter — so the pattern cannot drift from the URL
 * the client requests, because it is made of it.
 *
 * ## It fails at boot rather than quietly
 *
 * If a builder ever transforms its argument beyond encoding, the token will not appear
 * in the output and this THROWS. A decorator runs at module load, so that is a process
 * that refuses to start — which is the failure an operator can act on, unlike a route
 * that silently is not there.
 */
export function routePattern(build: (value: string) => string, param: string): string {
  /*
   * Unreserved characters only (`A-Z a-z 0-9 - _ . ! ~ * ' ( )`), so
   * `encodeURIComponent` returns it unchanged. Distinctive enough that it cannot
   * collide with a real segment of a path in this file.
   */
  const token = 'nexaRoutePatternParam';
  const built = build(token);
  if (!built.includes(token)) {
    throw new Error(
      `routePattern: the builder for ':${param}' did not pass its argument through ` +
        `verbatim (got ${built}). A builder that transforms its argument cannot be ` +
        'reused to declare a server route.',
    );
  }
  return built.replace(token, `:${param}`);
}

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
  /*
   * OPTIONAL, and what it buys is the difference between a retry and a second
   * command.
   *
   * Create is the one administrator write with no natural no-op: if it commits
   * and the response is lost, the caller's retry finds the username taken and
   * is told the creation FAILED — for an account that exists, holding a
   * credential the operator chose and now believes was never set. `setRoles`
   * and `setStatus` carry the same option for redelivered Telegram updates;
   * here the redeliverer is the browser's own retry policy.
   *
   * Optional rather than required so that a caller with no retry of its own —
   * the bootstrap CLI, a test — is not made to invent one.
   */
  idempotencyKey: z.string().min(8).max(255).optional(),
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

/**
 * Connect, replace or remove an administrator's Telegram binding.
 *
 * `null` removes it. The id is validated with `telegramUserIdSchema` — the one
 * definition of a Telegram numeric id this product has, shared with the
 * webhook that resolves identity from it and the installer that binds the
 * first owner — so a username, an `@handle` or a signed number is refused at
 * the wire, before the service refuses it again.
 *
 * This route exists because an installation can already hold an owner with no
 * binding (v0.2.5 created them that way), and the only other way to bind an
 * administrator, `/link`, has to be sent by an administrator who is already
 * bound. Without it the first Telegram administrator of such an installation
 * could only be made by editing the database.
 */
export const setAdminTelegramBindingRequestSchema = z.object({
  telegramUserId: telegramUserIdSchema.nullable(),
  reason: adminChangeReasonSchema,
});
export type SetAdminTelegramBindingRequest = z.infer<typeof setAdminTelegramBindingRequestSchema>;

export const adminListResponseSchema = z.object({ admins: z.array(adminSummarySchema) });
export type AdminListResponse = z.infer<typeof adminListResponseSchema>;

/**
 * A new password for an administrator who is NOT the caller.
 *
 * No `currentPassword`, and that is why the service refuses a caller who names
 * themselves: `changePasswordRequestSchema` above requires the current one, and
 * that proof of possession is the whole difference between changing your own
 * password and an operator resetting somebody else's. A route that accepted both
 * would let anybody holding `admins.edit` and a hijacked session replace their own
 * credential without knowing it.
 *
 * The same twelve-character floor as every other password this product accepts —
 * one definition, so an operator-set credential cannot be weaker than a
 * self-chosen one.
 */
export const resetAdminPasswordRequestSchema = z.object({
  newPassword: z.string().min(12).max(1024),
  reason: adminChangeReasonSchema,
});
export type ResetAdminPasswordRequest = z.infer<typeof resetAdminPasswordRequestSchema>;

/**
 * What the reset did, which is two facts and not one.
 *
 * `sessionsRevoked` is reported because the operator's question after resetting a
 * compromised credential is "is that person still logged in", and a response that
 * said only "ok" would leave them guessing. It is the count the revocation
 * actually returned, never an assumption that there was one.
 */
export const resetAdminPasswordResponseSchema = z.object({
  admin: adminSummarySchema,
  sessionsRevoked: z.number().int().nonnegative(),
});
export type ResetAdminPasswordResponse = z.infer<typeof resetAdminPasswordResponseSchema>;

/**
 * One live session, as an operator may see it.
 *
 * Exactly the columns `admin_sessions` holds and nothing composed: no device
 * name, no browser, no location. The row records an IP and a user agent because
 * the request carried them, and both are nullable because a request may not; a
 * surface that rendered "Chrome on Windows in Tehran" would be inventing three
 * facts out of one header the client chose to send.
 *
 * There is no token, no token hash and no prefix of either. A session identifier
 * is here only so that a future single-session revocation has something to name,
 * and it is the row's id — never the credential.
 */
export const adminSessionSummarySchema = z.object({
  id: z.string(),
  issuedAt: z.string(),
  expiresAt: z.string(),
  /** NOT NULL on the row: every session is touched when it is created. */
  lastSeenAt: z.string(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  /** True for the session making this request, so an operator can tell it apart. */
  current: z.boolean(),
});
export type AdminSessionSummary = z.infer<typeof adminSessionSummarySchema>;

export const adminSessionListResponseSchema = z.object({
  sessions: z.array(adminSessionSummarySchema),
});
export type AdminSessionListResponse = z.infer<typeof adminSessionListResponseSchema>;

/** Revoking every session an administrator holds. A reason, like every admin write. */
export const revokeAdminSessionsRequestSchema = z.object({ reason: adminChangeReasonSchema });
export type RevokeAdminSessionsRequest = z.infer<typeof revokeAdminSessionsRequestSchema>;

export const revokeAdminSessionsResponseSchema = z.object({
  revoked: z.number().int().nonnegative(),
});
export type RevokeAdminSessionsResponse = z.infer<typeof revokeAdminSessionsResponseSchema>;

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
  telegram: (id: string) => `/admins/${id}/telegram`,
  password: (id: string) => `/admins/${id}/password`,
  sessions: (id: string) => `/admins/${id}/sessions`,
  revokeSessions: (id: string) => `/admins/${id}/sessions/revoke`,
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

/**
 * A panel's occupancy, as the API states it.
 *
 * `services` and `reservations` are kept apart rather than summed away because
 * they resolve differently: a service leaves only when it is terminated, a
 * reservation leaves on its own when its order is paid, cancelled or expires.
 * `used` is nevertheless returned rather than left to the client to add, so no
 * surface gets its own opinion about what counts.
 */
export const panelCapacitySchema = z.object({
  /** The operator's cap, or null for no limit. Never zero: `DISABLED` says that. */
  maxServices: z.number().int().positive().nullable(),
  /** Services on this panel that occupy a slot — everything but TERMINATED. */
  services: z.number().int().nonnegative(),
  /** Slots held for an order that has neither settled nor lapsed. */
  reservations: z.number().int().nonnegative(),
  used: z.number().int().nonnegative(),
  /** `maxServices - used`, floored at zero; null when there is no cap. */
  available: z.number().int().nonnegative().nullable(),
});
export type PanelCapacityResponse = z.infer<typeof panelCapacitySchema>;

/**
 * Which names a panel will accept for the services sold onto it.
 *
 * Returned in full, like `activation` beside it and for the same reason: a policy an
 * operator can set and cannot read is the legacy write-only settings screen this
 * product exists to replace, where "the only way to read a price is to overwrite it".
 * None of these fields is a secret — the customer is shown the rule before they type.
 *
 * `prefix` and `template` are null unless the saved `strategy` uses them. Null is a
 * real state here and not an absence: it says this panel's generator takes no
 * configuration, which is true of `RANDOM` and `TELEGRAM_ID_RANDOM`.
 */
export const panelUsernamePolicySchema = z.object({
  /** Whether a customer may type their own name. */
  allowCustom: z.boolean(),
  /** Whether the installation may generate one. */
  allowAutomatic: z.boolean(),
  /** Which of the four presets generates it. */
  strategy: z.enum(USERNAME_STRATEGIES),
  /** The `PREFIX_RANDOM` prefix, or null under any other strategy. */
  prefix: z.string().nullable(),
  /** The `CUSTOM_TEMPLATE` template, or null under any other strategy. */
  template: z.string().nullable(),
});
export type PanelUsernamePolicyResponse = z.infer<typeof panelUsernamePolicySchema>;

/**
 * THREE STATES, SAID SEPARATELY, BECAUSE THEY ARE THREE QUESTIONS.
 *
 * A panel read used to answer two of them — `health` said whether the address
 * and credentials reach something, `capacity` said whether there is room — and a
 * screen that showed both green was read as "ready to sell". It was not. Order
 * `01a0c54b` on v0.2.8 was taken by a panel that was ACTIVE, HEALTHY and had
 * free capacity, and that had no Marzban activation configured at all: the
 * customer paid, waited seven minutes and was refunded.
 *
 * So the response now says all three, and never lets one stand in for another:
 *
 *   - `health` (beside this): can we reach it and authenticate?
 *   - `activationComplete` / `missingActivationFields`: is the provider
 *     configuration complete for THIS provider's schema?
 *   - `sellable` / `reason`: may a customer be charged for a new account on it?
 *
 * `sellable` is the one a surface may gate a sale on, and the other two exist so
 * that a `false` is actionable rather than merely disappointing. A panel is not
 * described as unhealthy when what is missing is an inbound tag.
 */
export const panelSellabilitySchema = z.object({
  /**
   * The server's verdict, from the ONE evaluator with four callers.
   *
   * Advisory in exactly the sense `PanelSalesGate` already documents: a read is
   * a snapshot, and confirmation re-decides under the panel's lock while
   * settlement re-decides again. A surface uses this to avoid offering something
   * that will be refused; nothing hangs on it.
   */
  sellable: z.boolean(),
  /** Null exactly when `sellable`. The first reason, in the evaluator's order. */
  reason: z.enum(PANEL_INELIGIBILITY_REASONS).nullable(),
  /**
   * Whether the stored `activation` parses against this provider's schema.
   *
   * Reported even when the panel is unsellable for some other reason, because an
   * operator fixing a disabled panel needs to know whether enabling it will be
   * enough. A single `reason` can only name one thing at a time.
   */
  activationComplete: z.boolean(),
  /**
   * The field paths the schema rejected, as the schema names them — never a
   * provider default invented here.
   *
   * Paths rather than a sentence, so the Web Admin can point at the input that
   * is wrong instead of printing a paragraph. Empty when `activationComplete`.
   */
  missingActivationFields: z.array(z.string()),
  /**
   * Whether a probe ever concluded something usable against the panel's CURRENT
   * identity.
   *
   * Not "recently" — see `UNVALIDATED` in `PANEL_INELIGIBILITY_REASONS` for why
   * freshness is deliberately not part of this.
   */
  connectionValidated: z.boolean(),
});
export type PanelSellability = z.infer<typeof panelSellabilitySchema>;

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
  /**
   * The stored provider configuration, returned IN FULL. Not a credential.
   *
   * `docs/conventions.md` requires a setting surface to return its current value:
   * "the only way to read a price is to overwrite it" is the legacy defect it names,
   * and this field decides where every customer's subscription link points. Writing it
   * without being able to read it meant an operator could change
   * `subscriptionDomain` to a host they chose and nothing in the system could say what
   * it had been, what it became, or what it is now — the audit records the FIELD NAMES,
   * on the stated ground that the panel read answers the rest, which was only true once
   * this field existed.
   *
   * Null when unset, which is a real and common state: a panel is connectable and
   * probeable before anybody has told it which inbound to sell from.
   *
   * It sits beside `credentials` and is shaped nothing like it, deliberately. A
   * credential leaves as three timestamps and never a value; this leaves as the value,
   * because a subscription domain and an inbound number are configuration an operator
   * copies off the panel they already administer.
   */
  activation: z.record(z.string(), z.unknown()).nullable(),
  health: panelHealthSchema,
  /**
   * How full this panel is, and how full it is allowed to get.
   *
   * Four numbers, because one would not answer the question an operator is
   * actually asking. "Used 8 of 8" does not say whether raising the cap is the
   * remedy or whether six of those eight are holds that will lapse in an hour,
   * and an operator who cannot tell those apart terminates a customer's service
   * to make room that was about to free itself.
   *
   * `available` is computed by the server and floored at zero. A cap lowered
   * below current usage is explicitly allowed — it refuses new sales and
   * terminates nothing — so the arithmetic is legitimately negative for a while,
   * and a screen reading "-3 available" is indistinguishable from a broken
   * counter. The honest number of slots left is none.
   */
  capacity: panelCapacitySchema,
  /** Which names this panel accepts. See `panelUsernamePolicySchema`. */
  usernamePolicy: panelUsernamePolicySchema,
  /** Whether this panel may be sold onto, and if not, what to fix. */
  sellability: panelSellabilitySchema,
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

/**
 * The per-panel provider configuration a create or an edit carries.
 *
 * Deliberately UNVALIDATED here beyond "an object, or null". The real shape is per
 * provider — `PANEL_ACTIVATION_SCHEMAS` — and this schema cannot know which provider
 * the request names on an edit, where `providerType` is absent because changing it is
 * forbidden. So the service parses it against the panel's own provider, and a second
 * opinion about the shape is deliberately not expressed here.
 *
 * Three states, exactly as `panelCredentialsInputSchema` has: absent leaves whatever is
 * stored, `null` clears it, an object replaces it. An operator renaming a panel must
 * not silently erase the subscription domain by not mentioning it.
 *
 * NOT a credential, which is why it lives on `panels.edit` rather than behind
 * `panels.credentials.rotate`: a subscription domain and an inbound number are
 * configuration an operator reads off their own panel, and `panels.activation` is
 * returned by every panel read.
 */
export const panelActivationInputSchema = z.union([
  z.record(z.string().min(1).max(64), z.unknown()),
  z.null(),
]);
export type PanelActivationInput = z.infer<typeof panelActivationInputSchema>;

/**
 * The cap, as a request states it.
 *
 * Three states, the same tri-state `activation` and every credential field use:
 * absent leaves whatever is stored, `null` removes the cap, a positive integer
 * sets one. An operator renaming a panel must not silently uncap it by not
 * mentioning the cap.
 *
 * Zero is refused rather than read as "sell nothing". `DISABLED` already means
 * that, it stops the probes, and it reads as a decision somebody made — whereas
 * a zero cap would be a second spelling that nothing else in the system
 * recognises: the panel would still be probed, still report `HEALTHY`, and the
 * catalogue would go quiet with no state anywhere naming why. The CHECK
 * constraint says the same thing one layer down.
 */
export const panelMaxServicesInputSchema = z.union([
  z.number().int().positive().max(1_000_000),
  z.null(),
]);

/**
 * The policy as a request states it, and it is ALL THREE FIELDS or none.
 *
 * Deliberately not three independent optionals. The one rule this policy has — at
 * least one mode must be enabled, which the CHECK constraint states one layer down —
 * is a rule about the pair, and a request that may carry either half alone can only be
 * validated against whatever happens to be stored. That makes a legal request illegal
 * depending on ordering: two operators each disabling the mode the other left on, both
 * accepted, and a panel nothing can be sold onto with no single request to blame.
 * Absent leaves the whole policy; present replaces the whole policy.
 *
 * NOTHING about the policy's MEANING is decided here — not the template's content and
 * not the at-least-one-mode rule. This schema settles shape and length, and
 * `PanelService.validateUsernamePolicy` settles everything else.
 *
 * The template and prefix halves have no choice: whether either can render a legal
 * name is a judgement about the whole policy — the strategy chosen beside it decides
 * which of the two is even read — and a per-field `.refine` cannot see the strategy.
 * This schema settles shape and length; `PanelService.validateUsernamePolicy` settles
 * whether the pieces describe one working generator.
 *
 * The at-least-one-mode half COULD have been decided here, and deliberately is not.
 * A `.refine` was written first and the integration case for the service's own
 * `PANEL_USERNAME_POLICY_EMPTY` then failed with `panel.request_invalid` — the boundary
 * had made the dedicated code unreachable. Two places deciding one rule is the shape
 * this repository keeps refusing: the second opinion is the one that goes stale, and a
 * code nothing can raise is a code a surface cannot map. One evaluator, three callers
 * — create, update, and the CHECK constraint one layer down.
 */
export const panelUsernamePolicyInputSchema = z.object({
  allowCustom: z.boolean(),
  allowAutomatic: z.boolean(),
  strategy: z.enum(USERNAME_STRATEGIES),
  prefix: z.string().min(1).max(USERNAME_PREFIX_MAX_LENGTH).nullable(),
  template: z.string().min(1).max(USERNAME_TEMPLATE_MAX_LENGTH).nullable(),
});
export type PanelUsernamePolicyInput = z.infer<typeof panelUsernamePolicyInputSchema>;

export const createPanelRequestSchema = z.object({
  name: panelNameSchema,
  providerType: z.enum(PROVIDER_TYPES),
  baseUrl: panelBaseUrlSchema,
  credentials: panelCredentialsInputSchema.optional(),
  activation: panelActivationInputSchema.optional(),
  maxServices: panelMaxServicesInputSchema.optional(),
  /** Absent means the default both modes on with the derived generator. */
  usernamePolicy: panelUsernamePolicyInputSchema.optional(),
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
  /**
   * Here and not on a route of its own.
   *
   * Activation is the same permission as a name — `panels.edit` — and the same kind of
   * thing: configuration an operator copies off the panel they already administer.
   * Credentials are a separate route because rotating one is a different, CRITICAL
   * permission; that argument does not reach a subscription domain, and a third route
   * would be a third place to forget the tenant check.
   */
  activation: panelActivationInputSchema.optional(),
  /**
   * `panels.edit`, alongside the name — not a permission of its own.
   *
   * Lowering a cap below current usage is deliberately allowed and deliberately
   * harmless: it refuses NEW sales and terminates nothing. A limit that could
   * delete a customer's service because somebody mistyped a number is not a
   * limit, it is an outage with a form field, so this needs no more authority
   * than renaming the panel does.
   */
  maxServices: panelMaxServicesInputSchema.optional(),
  /**
   * `panels.edit`, alongside the name, and replaced as a whole.
   *
   * It decides what a customer may be offered, never what anything costs, and it is
   * read back by every panel read — so it needs no more authority than renaming does.
   */
  usernamePolicy: panelUsernamePolicyInputSchema.optional(),
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
    /*
     * A UUID, validated HERE — this is the REQUEST schema, where a caller's string
     * arrives. `products.panel_id` is a `uuid` column, so an unvalidated one reaches
     * PostgreSQL as `invalid input syntax for type uuid` and is answered 500; the
     * service's own cross-tenant panel check is never reached. The same defect the
     * order filters had, found by the same review.
     *
     * The response projection above stays `z.string()` on purpose: it renders a value
     * the database already holds, and a validator there would turn a stored row into a
     * serialization failure rather than refusing anything.
     */
    panelId: uuidV7Schema.nullable(),
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
    /**
     * The category to file this product under.
     *
     * NULLABLE on the wire and required as a FIELD, which is the distinction that
     * matters: an operator must say something, and "none" is a thing they can say. It
     * produces a product no customer can reach, refused at confirmation with
     * `PRODUCT_NOT_CATEGORISED` rather than silently absent from every list — because a
     * product that vanishes teaches nobody anything, which is the rule
     * `catalog.ts` already applies to an unbound panel.
     *
     * Reassignment is this same field on an edit. It does not disturb history: an
     * order's category is snapshotted at confirmation, so moving a product changes what
     * NEW customers browse and nothing about what past ones bought.
     */
    categoryId: z.string().uuid().nullable(),
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
  })
  /*
   * And it FITS. `price_amount` is a PostgreSQL `bigint`, and the regex above admits
   * nineteen digits — a range that runs past the column by more than an order of
   * magnitude, so `9999999999999999999` passed validation and failed the INSERT as a
   * 500. Refused at the boundary under the field's own name instead.
   *
   * `trafficBytes` needs no companion rule: `MAX_TRAFFIC_BYTES` already bounds it far
   * below this.
   */
  .refine((p) => p.priceAmount === null || BigInt(p.priceAmount) <= MAX_MONEY_AMOUNT_MINOR, {
    message: 'That price is past the largest amount this system stores.',
    path: ['priceAmount'],
  });
export type ProductWriteRequest = z.infer<typeof productWriteSchema>;

export const productListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(PRODUCT_PAGE_MAX).optional(),
  cursor: z.string().max(512).optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
  audience: z.enum(PRODUCT_AUDIENCES).optional(),
  title: z.string().max(PRODUCT_TITLE_MAX_LENGTH).optional(),
  /*
   * An id, validated HERE, for the reason the write schema above states at
   * length: `products.panel_id` is a `uuid` column, so an unvalidated string
   * reaches PostgreSQL as `invalid input syntax for type uuid` and is answered
   * 500. `serviceListQuerySchema` already carries this filter and this rule.
   */
  panelId: uuidV7Schema.optional(),
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

// --- Service add-ons ---------------------------------------------------------

export const SERVICE_ADDON_PAGE_DEFAULT = 25;
export const SERVICE_ADDON_PAGE_MAX = 100;

/**
 * One configured add-on, as the Web Admin renders it.
 *
 * `trafficBytes` and `priceAmount` are decimal STRINGS on the wire for the reason
 * `productSummarySchema` gives: JSON has one number type and it is a double, and both
 * of these pass 2^53 within reach.
 *
 * The two amount fields are a union the `kind` decides between, and exactly one of them
 * is present on any row — `serviceAddonAmountMatchesKind` is the rule and the schema
 * refines it here as well, because a row whose amount sits in the field its kind does
 * not read is a row that would be sold for a quantity of nothing.
 */
export const serviceAddonSummarySchema = z
  .object({
    id: z.string(),
    kind: z.enum(SERVICE_ADDON_KINDS),
    title: z.string(),
    status: z.enum(SERVICE_ADDON_STATUSES),
    sortOrder: z.number().int(),
    trafficBytes: z.string().nullable(),
    durationDays: z.number().int().nullable(),
    priceAmount: z.string().nullable(),
    priceCurrency: z.enum(CURRENCY_CODES).nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .refine((a) => (a.priceAmount === null) === (a.priceCurrency === null), {
    message: 'A price is an amount and a currency, or it is absent.',
  })
  .refine(
    (a) =>
      a.kind === 'ADD_TRAFFIC'
        ? a.trafficBytes !== null && a.durationDays === null
        : a.durationDays !== null && a.trafficBytes === null,
    { message: 'An add-on carries exactly the amount its kind can use.' },
  );
export type ServiceAddonSummaryResponse = z.infer<typeof serviceAddonSummarySchema>;

/**
 * The fields an operator writes.
 *
 * `status` is absent for the same reason it is absent from `productWriteSchema`: an
 * add-on is created INACTIVE and becomes purchasable through its own command, so one
 * call cannot publish an unpriced one.
 *
 * `kind` is writable on create and is rejected on edit by the service rather than by
 * this schema — changing an `ADD_TRAFFIC` into an `ADD_TIME` would leave every order
 * that already bought it describing a quantity in the wrong unit, and the orders carry
 * their own snapshot precisely so that they do not have to be re-read through this row.
 */
export const serviceAddonWriteSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(255),
    kind: z.enum(SERVICE_ADDON_KINDS),
    title: z.string().trim().min(1).max(SERVICE_ADDON_TITLE_MAX_LENGTH),
    sortOrder: z.number().int().min(PRODUCT_SORT_MIN).max(PRODUCT_SORT_MAX),
    /* Positive and present for `ADD_TRAFFIC`, absent otherwise. Zero is not unlimited here. */
    trafficBytes: z
      .string()
      .regex(/^\d{1,19}$/u)
      .nullable(),
    durationDays: z.number().int().min(1).max(MAX_DURATION_DAYS).nullable(),
    priceAmount: z
      .string()
      .regex(/^\d{1,19}$/u)
      .nullable(),
    priceCurrency: z.enum(CURRENCY_CODES).nullable(),
  })
  .refine((a) => (a.priceAmount === null) === (a.priceCurrency === null), {
    message: 'A price is an amount and a currency, or it is absent.',
    path: ['priceAmount'],
  })
  .refine((a) => a.priceAmount === null || BigInt(a.priceAmount) > 0n, {
    message: 'A price must be greater than zero. Leave it empty for an add-on not for sale.',
    path: ['priceAmount'],
  })
  .refine((a) => a.priceAmount === null || BigInt(a.priceAmount) <= MAX_MONEY_AMOUNT_MINOR, {
    message: 'That price is past the largest amount this system stores.',
    path: ['priceAmount'],
  })
  .refine(
    (a) =>
      a.kind === 'ADD_TRAFFIC'
        ? a.trafficBytes !== null && a.durationDays === null
        : a.durationDays !== null && a.trafficBytes === null,
    {
      message: 'An add-on carries exactly the amount its kind can use.',
      path: ['trafficBytes'],
    },
  )
  .refine((a) => a.trafficBytes === null || BigInt(a.trafficBytes) > 0n, {
    message: 'An add-on of no traffic is not something a customer can buy.',
    path: ['trafficBytes'],
  })
  .refine((a) => a.trafficBytes === null || BigInt(a.trafficBytes) <= MAX_TRAFFIC_BYTES, {
    message: 'That traffic amount is past any real plan.',
    path: ['trafficBytes'],
  });
export type ServiceAddonWriteRequest = z.infer<typeof serviceAddonWriteSchema>;

export const serviceAddonListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(SERVICE_ADDON_PAGE_MAX).optional(),
  cursor: z.string().max(512).optional(),
  kind: z.enum(SERVICE_ADDON_KINDS).optional(),
  status: z.enum(SERVICE_ADDON_STATUSES).optional(),
});
export type ServiceAddonListQuery = z.infer<typeof serviceAddonListQuerySchema>;

export const serviceAddonListResponseSchema = z.object({
  addons: z.array(serviceAddonSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ServiceAddonListResponse = z.infer<typeof serviceAddonListResponseSchema>;

export const serviceAddonResponseSchema = z.object({ addon: serviceAddonSummarySchema });
export type ServiceAddonResponse = z.infer<typeof serviceAddonResponseSchema>;

export const SERVICE_ADDON_ROUTES = {
  list: '/service-addons',
  create: '/service-addons',
  detail: (id: string) => `/service-addons/${encodeURIComponent(id)}`,
  update: (id: string) => `/service-addons/${encodeURIComponent(id)}`,
  activate: (id: string) => `/service-addons/${encodeURIComponent(id)}/activate`,
  deactivate: (id: string) => `/service-addons/${encodeURIComponent(id)}/deactivate`,
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
  /**
   * When the money arrived, and NOTHING about a service.
   *
   * `orders_settled_at_check` binds this to the settled states — `PAID` and
   * `REFUNDED` — so a non-null value here is the database's own statement that the
   * order was financially settled. A `REFUNDED` order keeps it: the money really did
   * arrive, and the refund is a second movement rather than an erasure of the first.
   */
  settledAt: z.iso.datetime().nullable(),
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

// --- Wallet and payments (Phase 4C) -----------------------------------------

/**
 * How many ledger entries and payments a page may carry.
 *
 * The same shape every other list here uses. The ledger page is a KEYSET over
 * `(createdAt, id)` and never an offset, for the reason `/panels` records: an
 * append-only table grows at the head while an operator reads it, and an offset
 * page shows them the same row twice.
 */
export const WALLET_PAGE_DEFAULT = 25;
export const WALLET_PAGE_MAX = 100;
export const PAYMENT_PAGE_DEFAULT = 25;
export const PAYMENT_PAGE_MAX = 100;

/**
 * One ledger entry, as the Web Admin renders it.
 *
 * `amount` is a STRING and `direction` is its own field, which is the ledger's
 * invariant restated on the wire: an amount is positive and the sign lives beside
 * it. A signed number here would let a client add them up and get the balance
 * wrong in exactly the way `RSV2-BR-019` records — the legacy report adds admin
 * DEBITS to the top-up total instead of subtracting them.
 *
 * `note` is an operator's bounded text and never a customer's. `actorAdminId` is
 * present only for an administrative reason; a flow-produced entry has none, and
 * that difference is the answer to "did a person do this".
 */
export const walletEntrySummarySchema = z.object({
  id: z.string(),
  customerId: z.string(),
  direction: z.enum(LEDGER_DIRECTIONS),
  reason: z.enum(LEDGER_REASONS),
  /** Minor units, always positive. A string because JSON has no bigint. */
  amount: z.string(),
  currency: z.enum(CURRENCY_CODES),
  orderId: z.string().nullable(),
  paymentId: z.string().nullable(),
  actorAdminId: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type WalletEntrySummaryResponse = z.infer<typeof walletEntrySummarySchema>;

/**
 * A customer's wallet: the derived balance and nothing that could disagree with it.
 *
 * `balance` is computed from the entries in the same read, so a caller cannot be
 * shown a balance from one moment and a history from another. There is no stored
 * balance to return and this response is deliberately not a place one could
 * appear.
 *
 * `entryCount` is how many entries the balance was derived FROM. It is here
 * because a balance with no idea how many facts produced it is the legacy summary
 * that left a 916,550 residual unexplained.
 */
export const walletBalanceSchema = z.object({
  customerId: z.string(),
  balanceAmount: z.string(),
  currency: z.enum(CURRENCY_CODES),
  entryCount: z.number().int().nonnegative(),
});
export type WalletBalanceResponse = z.infer<typeof walletBalanceSchema>;

export const walletResponseSchema = z.object({ wallet: walletBalanceSchema });
export type WalletResponse = z.infer<typeof walletResponseSchema>;

/**
 * One entry, wrapped, as an adjustment answers with.
 *
 * A WRAPPER rather than the bare summary, like every other response here: a top-level
 * object leaves room for a field to be added without changing the shape a client
 * destructures, and `apps/web` may not import `zod` to build one of its own.
 */
export const walletEntryResponseSchema = z.object({ entry: walletEntrySummarySchema });
export type WalletEntryResponse = z.infer<typeof walletEntryResponseSchema>;

export const walletEntryListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(WALLET_PAGE_MAX).optional(),
  cursor: z.string().min(1).max(255).optional(),
});
export type WalletEntryListQuery = z.infer<typeof walletEntryListQuerySchema>;

export const walletEntryListResponseSchema = z.object({
  entries: z.array(walletEntrySummarySchema),
  nextCursor: z.string().nullable(),
});
export type WalletEntryListResponse = z.infer<typeof walletEntryListResponseSchema>;

/**
 * An operator moving a customer's money by hand.
 *
 * `direction` is explicit rather than a signed amount, for the same reason the
 * ledger stores it that way. `reason` is NOT a free choice: the service maps a
 * direction to `ADMIN_CREDIT` or `ADMIN_DEBIT`, because those are the only two
 * administrative reasons a single adjustment can legitimately carry and letting a
 * caller pick from the whole vocabulary would let an admin file a debit as a
 * `PURCHASE`.
 *
 * `note` is required and bounded. The legacy system's manual adjustments record
 * the actor, target, delta and resulting balance but NOT the reason
 * (`LGR-BR-063`), which makes every historical adjustment unexplainable.
 */
export const walletAdjustRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  direction: z.enum(LEDGER_DIRECTIONS),
  /*
   * ONE total check, not a chain of refinements, and the difference is a 500.
   *
   * Chained `.refine`s on a STRING schema all run even after an earlier check has
   * failed — unlike the object-level refinements on `productWriteSchema`, which run only
   * once every field has parsed. So `z.string().regex(...).refine((v) => BigInt(v) > 0n)`
   * reaches `BigInt('abc')`, which THROWS a SyntaxError out of `safeParse` itself: not a
   * validation failure the error filter turns into a 400, but an exception that becomes
   * a 500 for what is an ordinary malformed request.
   *
   * `superRefine` with an early return is the fix: the shape is established before any
   * conversion is attempted, and every later check reads a value already known to be
   * digits.
   */
  amount: z.string().superRefine((value, ctx) => {
    if (!/^\d{1,19}$/u.test(value)) {
      ctx.addIssue({
        code: 'custom',
        message: 'An amount is digits only, in minor units.',
      });
      return;
    }
    const minor = BigInt(value);
    if (minor <= 0n) {
      ctx.addIssue({ code: 'custom', message: 'An adjustment must be greater than zero.' });
      return;
    }
    if (minor > PAYMENT_AMOUNT_MAX_MINOR) {
      ctx.addIssue({
        code: 'custom',
        message: 'That amount is past the largest this system moves.',
      });
    }
  }),
  currency: z.enum(CURRENCY_CODES),
  note: z.string().trim().min(1).max(500),
});
export type WalletAdjustRequest = z.infer<typeof walletAdjustRequestSchema>;

/**
 * One payment, as the Web Admin renders it.
 *
 * `orderId` nullable is the whole model on the wire: a payment that names an
 * order settles it, one that does not credits the wallet, and which a given
 * payment is, is a column rather than an inference. `UNK-PR-007` asks that
 * question of the legacy system and cannot answer it.
 *
 * What is NOT here: `evidenceNote` is an operator's own text about somebody's
 * bank transfer and is returned only on the DETAIL, behind the same permission;
 * `externalReference` is a gateway's id and no gateway ships.
 */
export const paymentSummarySchema = z.object({
  id: z.string(),
  customerId: z.string(),
  orderId: z.string().nullable(),
  state: z.enum(PAYMENT_STATES),
  method: z.enum(PAYMENT_METHODS),
  amount: z.string(),
  currency: z.enum(CURRENCY_CODES),
  /** The code the customer quotes. Generated, never customer-supplied. */
  reference: z.string(),
  evidenceKind: z.enum(PAYMENT_EVIDENCE_KINDS).nullable(),
  confirmedAt: z.iso.datetime().nullable(),
  /** Which administrator confirmed it. Frozen once set — migration 0035. */
  confirmedByAdminId: z.string().nullable(),
  /**
   * When the payment ended WITHOUT money — rejected, withdrawn or expired.
   *
   * The mirror of `confirmedAt`, and separate from it because they are different
   * facts and `payments_confirmed_check` binds the confirmation's own fields to
   * CONFIRMED. A surface that showed one field for both would have to decide which
   * meaning it carried by reading `state`, which is how a rejection comes to be
   * displayed as an approval.
   */
  resolvedAt: z.iso.datetime().nullable(),
  /**
   * Which administrator resolved it, when a person did.
   *
   * Null for an expiry — nobody decided that, a deadline did — and null for a
   * customer's own withdrawal. The distinction is the point: "who rejected this and
   * when" is the question `UNK-PR-010` records the legacy system as unable to answer
   * about an approval, and a rejection deserves the same answer.
   */
  resolvedByAdminId: z.string().nullable(),
  /**
   * When the customer said they had sent the transfer. Their CLAIM, never evidence.
   *
   * On the SUMMARY rather than the detail, because it is the field that makes the
   * pending list triageable: `docs/phase4h-audit.md` §4 measured that an operator
   * learns of a transfer from their bank rather than from the product, and a list where
   * every PENDING row looks alike is why.
   *
   * It is deliberately not folded into `state`. A customer's assertion and an
   * operator's confirmation are different facts, and a surface that could not tell them
   * apart is the legacy receipt review, where "receipt" and "payment" name one record
   * (`PRBR-004`). A signalled payment is still PENDING and still needs a human.
   */
  customerSignalledAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PaymentSummaryResponse = z.infer<typeof paymentSummarySchema>;

/**
 * WHERE this payment's instructions told the customer to send the money.
 *
 * Read from the payment's frozen snapshot, so renaming, editing or disabling the
 * account afterwards does not change what this screen says the customer was told. That
 * immutability is the whole reason the snapshot exists, and until this shape existed
 * nothing an operator could open showed it — the `label` was documented as retained
 * for reconciliation and reached no surface. Found by the Codex review of PR #34.
 *
 * `cardLast4`, never the card number. A reviewer's question here is WHICH account a
 * transfer should have arrived in, and the label, the bank, the holder and four digits
 * answer it; the full number is on the Payment Accounts screen under
 * `payments.accounts.edit`, which is the one place it is needed and the one place it is
 * entered. Sending sixteen digits to a browser that does not need them would put a
 * card number in every operator's memory cache and error reporter.
 *
 * `hasIban` rather than the Sheba itself, for the same reason: whether the customer was
 * given one changes how a statement is read; the value does not.
 */
export const paymentDestinationViewSchema = z.object({
  accountId: uuidV7Schema,
  label: z.string(),
  bankName: z.string(),
  holderName: z.string(),
  cardLast4: z.string().regex(/^[0-9]{4}$/u),
  hasIban: z.boolean(),
});
export type PaymentDestinationView = z.infer<typeof paymentDestinationViewSchema>;

export const paymentDetailSchema = paymentSummarySchema.extend({
  /** The operator's note about the evidence. Detail only. */
  evidenceNote: z.string().nullable(),
  /**
   * Why it was rejected, in the operator's own words. Detail only, same as the
   * evidence note and for the same reason — it is one person's text about another
   * person's bank transfer.
   */
  resolutionNote: z.string().nullable(),
  /**
   * Null for a payment that never carried one: a wallet settlement, or a manual
   * transfer issued before 5A existed. Not null for "you may not see it" — the fields
   * here need no permission beyond `payments.view`, because none of them is the number.
   */
  destination: paymentDestinationViewSchema.nullable(),
});
export type PaymentDetailResponse = z.infer<typeof paymentDetailSchema>;

export const paymentListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(PAYMENT_PAGE_MAX).optional(),
  cursor: z.string().min(1).max(255).optional(),
  state: z.enum(PAYMENT_STATES).optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  /* Ids, validated HERE: these reach `uuid` columns. See `orderListQuerySchema`. */
  customerId: uuidV7Schema.optional(),
  orderId: uuidV7Schema.optional(),
  /** The quotable code, matched exactly. What an operator has in front of them. */
  reference: z.string().trim().min(1).max(64).optional(),
});
export type PaymentListQuery = z.infer<typeof paymentListQuerySchema>;

export const paymentListResponseSchema = z.object({
  payments: z.array(paymentSummarySchema),
  nextCursor: z.string().nullable(),
});
export type PaymentListResponse = z.infer<typeof paymentListResponseSchema>;

export const paymentResponseSchema = z.object({ payment: paymentDetailSchema });
export type PaymentResponse = z.infer<typeof paymentResponseSchema>;

/**
 * An operator confirming that money arrived.
 *
 * The note is REQUIRED, and that is the point of the whole endpoint: the legacy
 * receipt review records neither the reviewer nor the time (`UNK-PR-010`), so
 * "was this approved by a human, and on what basis" is unanswerable there. Here
 * the reviewer is taken from the session, the time from the `Clock`, and the
 * basis from this field — and migration 0035 freezes all three the moment the
 * payment is confirmed.
 *
 * The amount is NOT a parameter. A confirmation asserts that the payment's own
 * recorded amount arrived; an editable amount at confirmation time is the legacy
 * unknown `UNK-PR-004` and a way to settle a large order with a small transfer.
 */
export const confirmPaymentRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  evidenceNote: z.string().trim().min(1).max(500),
});
export type ConfirmPaymentRequest = z.infer<typeof confirmPaymentRequestSchema>;

/**
 * An operator recording that the money did NOT arrive.
 *
 * The other half of `receipts.review`, which has read *"Approve or reject a receipt"*
 * since the permission catalogue was frozen and has had only the approve half behind it
 * until now. The note is REQUIRED for the same reason it is required on a confirmation:
 * a decision about somebody's money with no recorded basis is the legacy receipt review,
 * which records neither reviewer nor reason.
 *
 * There is no `reason` ENUM beside it. A closed list here would be this schema inventing
 * a taxonomy of why transfers fail, and the operator is the one who just looked at the
 * bank statement.
 *
 * It takes no amount and no state, and there is no matching "unreject": a rejection is
 * legal only from PENDING, and a payment that was CONFIRMED is reversed by a refund
 * rather than by an edit (`OQ-4C-02`).
 */
export const rejectPaymentRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  resolutionNote: z.string().trim().min(1).max(500),
});
export type RejectPaymentRequest = z.infer<typeof rejectPaymentRequestSchema>;

export const WALLET_ROUTES = {
  balance: (customerId: string) => `/users/${encodeURIComponent(customerId)}/wallet`,
  entries: (customerId: string) => `/users/${encodeURIComponent(customerId)}/wallet/entries`,
  adjust: (customerId: string) => `/users/${encodeURIComponent(customerId)}/wallet/adjust`,
} as const;

export const PAYMENT_ROUTES = {
  list: '/payments',
  detail: (id: string) => `/payments/${encodeURIComponent(id)}`,
  confirm: (id: string) => `/payments/${encodeURIComponent(id)}/confirm`,
  reject: (id: string) => `/payments/${encodeURIComponent(id)}/reject`,
  /** What a customer sent against one payment, under `receipts.view`. */
  receipts: (id: string) => `/payments/${encodeURIComponent(id)}/receipts`,
  /**
   * The BYTES of one receipt, by receipt id rather than by file id.
   *
   * Under `/payments` because that is what it belongs to, and keyed on the receipt so
   * `file_id` never leaves this process: it is what `getFile` takes, it is bot-scoped,
   * and handing it to a browser would let anything achieving script execution on the
   * admin page fetch the file from Telegram with the installation's own bot. That is
   * the rule `bot_instance.bot_token` has had since Phase 0, applied to the identifier
   * that stands in for it.
   */
  receiptContent: (paymentId: string, receiptId: string) =>
    `/payments/${encodeURIComponent(paymentId)}/receipts/${encodeURIComponent(receiptId)}/content`,
} as const;

/**
 * One receipt as the browser receives it. `PaymentReceiptView`'s wire form.
 *
 * `fileId` is absent, and `packages/contracts/src/payment-receipts.ts` states why at
 * length. `fileSize` is a NUMBER here rather than a string: a receipt is bounded by
 * `PAYMENT_RECEIPT_MAX_BYTES` and so cannot reach the range that makes `Money` a string
 * on the wire — the rule is about values that can exceed 2^53, not about every integer.
 */
export const paymentReceiptViewSchema = z.object({
  id: uuidV7Schema,
  kind: z.enum(PAYMENT_RECEIPT_KINDS),
  fileUniqueId: z.string(),
  mimeType: z.string().nullable(),
  fileSize: z.number().int().nonnegative().nullable(),
  fileName: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const paymentReceiptListResponseSchema = z.object({
  receipts: z.array(paymentReceiptViewSchema),
});
export type PaymentReceiptListResponse = z.infer<typeof paymentReceiptListResponseSchema>;

// --- Manual-transfer accounts -------------------------------------------------

/**
 * One configured destination, as the Web Admin renders it.
 *
 * The card number and the Sheba are returned IN FULL, and that is deliberate rather than
 * an oversight in a codebase that refuses to return a panel credential. They are not
 * secrets: this installation PUBLISHES them, to every customer who chooses to pay out of
 * band, and an operator who cannot read the value cannot check it against their bank.
 * `docs/conventions.md` states the rule directly — a setting surface returns its current
 * value, and "the only way to read a price is to overwrite it" is the legacy defect it
 * names.
 *
 * The masking the Web Admin applies in its LIST is presentation: an operator's screen in
 * a shared office is a different threat from a response body, and the edit form shows the
 * whole number because that is where it is checked.
 */
export const paymentAccountSchema = z.object({
  id: z.string(),
  label: z.string(),
  bankName: z.string(),
  holderName: z.string(),
  cardNumber: z.string(),
  iban: z.string().nullable(),
  enabled: z.boolean(),
  /** At most one per tenant, and it is always enabled. Both are database constraints. */
  isDefault: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PaymentAccountView = z.infer<typeof paymentAccountSchema>;

/**
 * Every account this tenant has, with no cursor.
 *
 * The one list in this API that is not a keyset page, because
 * `PAYMENT_ACCOUNT_MAX_PER_TENANT` makes it complete by construction. A paginated
 * configuration screen silently omits the row an operator is looking for; a bound the
 * create path enforces does not.
 */
export const paymentAccountListResponseSchema = z.object({
  accounts: z.array(paymentAccountSchema),
});
export type PaymentAccountListResponse = z.infer<typeof paymentAccountListResponseSchema>;

export const paymentAccountResponseSchema = z.object({ account: paymentAccountSchema });
export type PaymentAccountResponse = z.infer<typeof paymentAccountResponseSchema>;

/**
 * A create, which carries the fields plus the two decisions that are not fields.
 *
 * `enabled` and `makeDefault` are separate from `paymentAccountInputSchema` because they
 * are not properties of the account — they are the tenant's disposition towards it, and
 * the update path changes each through its own endpoint so that "I edited a card number"
 * and "I changed where money goes" are two different audit rows.
 *
 * The FIRST enabled account a tenant creates becomes the default whether or not
 * `makeDefault` is set, and the service says why: a tenant with one account and no
 * default has a manual-transfer button that refuses, which is a configuration screen
 * that looks complete and is not.
 */
export const createPaymentAccountRequestSchema = paymentAccountInputSchema.extend({
  idempotencyKey: z.string().min(8).max(255),
  enabled: z.boolean(),
  makeDefault: z.boolean(),
});
export type CreatePaymentAccountRequest = z.input<typeof createPaymentAccountRequestSchema>;

/**
 * An edit of the account's own fields, and only those.
 *
 * It cannot enable, disable or promote — those are the endpoints below. Every field is
 * required rather than patchable, because a partial write of a payment destination is how
 * a card number ends up beside the wrong holder name: the form shows all four, the
 * operator retypes the card and the holder stays as it was. The surface submits what it
 * rendered.
 *
 * Editing does NOT touch any payment already issued against this account. That is the
 * whole purpose of `payment_destinations`, and it is enforced by a trigger rather than by
 * this comment.
 */
export const updatePaymentAccountRequestSchema = paymentAccountInputSchema.extend({
  idempotencyKey: z.string().min(8).max(255),
});
export type UpdatePaymentAccountRequest = z.input<typeof updatePaymentAccountRequestSchema>;

/**
 * Enabling or disabling one account.
 *
 * Disabling the DEFAULT is refused with `PAYMENT_ACCOUNT_DISABLED` rather than silently
 * promoting somebody else: which account money should arrive in next is the operator's
 * decision, and a system that picks one for them has made a financial choice nobody
 * recorded.
 */
export const setPaymentAccountEnabledRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  enabled: z.boolean(),
});
export type SetPaymentAccountEnabledRequest = z.infer<typeof setPaymentAccountEnabledRequestSchema>;

/** Promoting one account to be the destination new payments are issued against. */
export const setDefaultPaymentAccountRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
});
export type SetDefaultPaymentAccountRequest = z.infer<typeof setDefaultPaymentAccountRequestSchema>;

export const PAYMENT_ACCOUNT_ROUTES = {
  list: '/payment-accounts',
  create: '/payment-accounts',
  update: (id: string) => `/payment-accounts/${encodeURIComponent(id)}`,
  enabled: (id: string) => `/payment-accounts/${encodeURIComponent(id)}/enabled`,
  makeDefault: (id: string) => `/payment-accounts/${encodeURIComponent(id)}/default`,
} as const;

// --- Refunds -----------------------------------------------------------------

/**
 * One refund, as the Web Admin renders it beneath the payment it reverses.
 *
 * The amount is a decimal STRING of minor units with its currency beside it, for the
 * reason every other amount in this API is: JSON has no bigint and a `number` is the
 * float the money model refuses, silently, above 2^53.
 *
 * Both actor fields and both timestamps are here, and that is the whole point of the
 * shape: a refund nobody can attribute is the legacy `/admin/logs`, a free-text sentence
 * with no entity and no before/after. `completedByAdminId` is null until somebody
 * completes it, which for the manual channel is the only thing that makes the money
 * actually gone.
 */
export const refundSchema = z.object({
  id: z.string(),
  paymentId: z.string(),
  orderId: z.string().nullable(),
  customerId: z.string(),
  state: refundStateSchema,
  channel: refundChannelSchema,
  amountMinor: z.string(),
  currency: z.enum(CURRENCY_CODES),
  reason: z.string(),
  requestedByAdminId: z.string().nullable(),
  completedByAdminId: z.string().nullable(),
  /** The bank reference or note an operator recorded when the money actually left. */
  externalReference: z.string().nullable(),
  completionNote: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});
export type RefundView = z.infer<typeof refundSchema>;

/**
 * A payment's refunds, with the server's own arithmetic beside them.
 *
 * `refundableMinor` travels WITH the list rather than being recomputed by the browser,
 * because the browser would be a second opinion about how much money is left to give
 * back — and the one that disagrees is the one an operator acts on. The server's figure
 * is derived inside a transaction under a lock; this field is a render of that.
 *
 * `refundable` is false for a payment that cannot be refunded AT ALL — never settled,
 * or a method this release has no channel for — which is a different fact from a
 * refundable amount of zero, and a surface that conflated them would offer a button for
 * a gateway payment nobody can reverse.
 */
export const refundListResponseSchema = z.object({
  refunds: z.array(refundSchema),
  paidMinor: z.string(),
  consumedMinor: z.string(),
  refundableMinor: z.string(),
  currency: z.enum(CURRENCY_CODES),
  refundable: z.boolean(),
});
export type RefundListResponse = z.infer<typeof refundListResponseSchema>;

export const refundResponseSchema = z.object({ refund: refundSchema });
export type RefundResponse = z.infer<typeof refundResponseSchema>;

export const REFUND_ROUTES = {
  /** Every refund against one payment, plus what is left to refund. */
  list: (paymentId: string) => `/payments/${encodeURIComponent(paymentId)}/refunds`,
  /** Requests one. The amount is bounded server-side; this body is a proposal. */
  request: (paymentId: string) => `/payments/${encodeURIComponent(paymentId)}/refunds`,
  /** Records that the external transfer actually happened. The manual channel's second step. */
  complete: (refundId: string) => `/refunds/${encodeURIComponent(refundId)}/completion`,
  /** Abandons a refund, releasing its amount back to the refundable balance. */
  fail: (refundId: string) => `/refunds/${encodeURIComponent(refundId)}/failure`,
} as const;

// --- Payment gateways --------------------------------------------------------

/**
 * One configured payment route, as the Web Admin renders it.
 *
 * `provider` is the identity — there is no id, because a route is `(tenant, provider)`
 * and `payment-gateways.ts` records why. `settlesVia` and `requiresCredentials` are
 * echoed from the descriptor rather than stored, so the screen can say what a route
 * actually does without the client holding a copy of the catalogue.
 *
 * Nothing sensitive is in here, and nothing can be: this release stores no credential
 * for any route, and the field does not exist to omit. When one does, it will follow the
 * panels rule — the projection selects a set-at timestamp and never a ciphertext, and
 * never a masked stand-in either, because `********` can be resubmitted as a password.
 *
 * The amounts are STRINGS. `bigint` has no JSON form, and `MoneyWire` is the shape this
 * API already uses for every other amount; a `number` here would be the float the money
 * model refuses, silently, above 2^53.
 */
export const paymentGatewaySchema = z.object({
  provider: paymentGatewayProviderSchema,
  status: paymentGatewayStatusSchema,
  /** `null` means the product's own name for this route, which is what a fresh row holds. */
  displayName: z.string().nullable(),
  instructions: z.string().nullable(),
  /**
   * The bounds, in minor units as decimal STRINGS, with `0` meaning unbounded.
   *
   * Strings because JSON has no bigint and a `number` here is the float the money model
   * refuses, silently, above 2^53. One `currency` for both, because both are in the
   * installation's `sales.currency` — a route does not carry a denomination of its own,
   * and `payment-gateways.ts` records why one would be a second denomination with no
   * conversion to reach it.
   */
  minAmountMinor: z.string(),
  maxAmountMinor: z.string(),
  /*
   * `salesCurrencyCodeSchema`, NOT `CURRENCY_CODES`.
   *
   * A route's bounds are compared against an amount denominated in `sales.currency`,
   * which is one of two codes — and `money.ts` records why that constant exists: the
   * products form once offered all five, three of which the store cannot sell in, and
   * Codex found it. Widening this field would put the same defect on this screen.
   */
  currency: salesCurrencyCodeSchema,
  eligibility: z.object({
    activateAfterPayments: z.number().int(),
    deactivateAfterPayments: z.number().int(),
    activateAfterAccountDays: z.number().int(),
  }),
  sortOrder: z.number().int(),
  /*
   * The descriptor's two facts — `settlesVia` and `requiresCredentials` — are NOT here.
   *
   * They were, and nothing read them: with one operable route `settlesVia` always says
   * the same thing and there is no credential field to gate. `PAYMENT_GATEWAY_DESCRIPTORS`
   * is where they live and a unit test is what consumes them; a response field with no
   * reader is the placeholder abstraction the conventions refuse, and the i18n checker
   * found the label for one of them rendering nowhere. They land with the second route,
   * which is what makes either of them worth showing.
   */
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PaymentGatewayView = z.infer<typeof paymentGatewaySchema>;

/**
 * Every route this tenant has, in display order, with no cursor.
 *
 * Complete by construction for a stronger reason than the account list's: the roster is
 * bounded by `PAYMENT_GATEWAY_PROVIDERS`, so it cannot exceed the number of routes this
 * release can operate. `WEB-BR-012` reads the same shape off the legacy panel — a fixed
 * roster with no Add Gateway.
 */
export const paymentGatewayListResponseSchema = z.object({
  gateways: z.array(paymentGatewaySchema),
});
export type PaymentGatewayListResponse = z.infer<typeof paymentGatewayListResponseSchema>;

export const paymentGatewayResponseSchema = z.object({ gateway: paymentGatewaySchema });
export type PaymentGatewayResponse = z.infer<typeof paymentGatewayResponseSchema>;

/**
 * An edit of one route's own configuration.
 *
 * Every field is required rather than patchable, for the reason
 * `updatePaymentAccountRequestSchema` states: the form shows all of them, so the surface
 * submits what it rendered. A partial write of an eligibility triple is how a route ends
 * up with a show-after count somebody meant to clear.
 *
 * The amounts arrive as decimal STRINGS of minor units, matching every other amount this
 * API accepts. There is no currency field: a route is denominated in the installation's
 * `sales.currency`, and `payment-gateways.ts` records why a per-route currency would be
 * a second denomination with no conversion to reach it.
 *
 * It cannot switch the route on or off — that is the endpoint below, so that "I changed
 * the limits" and "I stopped accepting this route" are two different audit rows.
 */
export const updatePaymentGatewayRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  /*
   * The two text fields carry no length bound HERE, and that is deliberate.
   *
   * `paymentGatewayConfigSchema` bounds both, and it is what every caller runs — the
   * controller parses this shape and then that one, precisely so the RULES live in one
   * place. Restating a maximum here would be a second number to keep in step, and the
   * one that drifts is the one nobody tests.
   */
  displayName: z.union([z.string(), z.null()]).optional(),
  instructions: z.union([z.string(), z.null()]).optional(),
  minAmountMinor: z.string().regex(/^[0-9]{1,19}$/u),
  maxAmountMinor: z.string().regex(/^[0-9]{1,19}$/u),
  eligibility: z.object({
    activateAfterPayments: z.number().int().min(0).max(PAYMENT_GATEWAY_THRESHOLD_MAX),
    deactivateAfterPayments: z.number().int().min(0).max(PAYMENT_GATEWAY_THRESHOLD_MAX),
    activateAfterAccountDays: z.number().int().min(0).max(PAYMENT_GATEWAY_THRESHOLD_MAX),
  }),
  sortOrder: z.number().int().min(PAYMENT_GATEWAY_SORT_MIN).max(PAYMENT_GATEWAY_SORT_MAX),
});
export type UpdatePaymentGatewayRequest = z.infer<typeof updatePaymentGatewayRequestSchema>;

/**
 * Switching one route on or off.
 *
 * `DISABLED` is the operator saying stop using this for now, and it is the one gateway
 * change a customer notices immediately — so it is its own command with its own audit
 * row, never a field inside an edit.
 */
export const setPaymentGatewayStatusRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  status: paymentGatewayStatusSchema,
});
export type SetPaymentGatewayStatusRequest = z.infer<typeof setPaymentGatewayStatusRequestSchema>;

export const PAYMENT_GATEWAY_ROUTES = {
  list: '/payment-gateways',
  update: (provider: string) => `/payment-gateways/${encodeURIComponent(provider)}`,
  status: (provider: string) => `/payment-gateways/${encodeURIComponent(provider)}/status`,
} as const;

// --- Services ----------------------------------------------------------------

export const SERVICE_PAGE_MAX = 100;

/**
 * One provisioned service, as the Web Admin renders it.
 *
 * `docs/phase4h-audit.md` §7 measured why this shape did not exist: `permissions.ts`
 * has declared `services.view`, `services.edit`, `services.terminate` and
 * `services.transfer` since Phase 2, three seeded roles carry the first two, services
 * have been real rows since 4D — and there was no `SERVICE_ROUTES` and no screen. The
 * same defect class as Codex C5 on PR #29, where `receipt_reviewer` could not open the
 * payment its own name refers to.
 *
 * ## Three fields are deliberately ABSENT, and that is the design
 *
 * `subscriptionRef`, `providerClientId` and `subscriptionUrl` are NOT here. All three
 * are bearer capabilities: the ref and the URL fetch a working configuration, and the
 * client id is what a customer's configuration authenticates with. `ADR-0023`'s panel
 * rule is the same rule one aggregate over — a credential travels ONE way — and an
 * operator list is the worst possible place to break it, because it would hand every
 * customer's live configuration to anybody with `services.view`, in bulk, over a
 * single request.
 *
 * `hasSubscription` is a boolean for the reason `archiveAvailable` is one on a backup
 * run: the surface needs to know whether the thing exists, and nothing about the
 * operator's job needs its value. A masked stand-in is refused for the reason ADR-0023
 * gives about passwords — `********` is a value somebody can try to resubmit.
 *
 * `providerUsername` IS here. It is not a secret: it is the handle an operator types
 * into a panel to find the account, which is the whole point of having this screen,
 * and it is already visible to any operator with panel access.
 *
 * ## Delivery is its own axis and stays separate
 *
 * `state` and `deliveryState` are two fields because they are two facts, and 4D's
 * `recordDelivery` exists precisely so a failed Telegram send cannot move a service out
 * of `ACTIVE`. Collapsing them into one status would make a provisioned account whose
 * message bounced look unprovisioned, and the obvious remedy for that is to provision
 * it again — a second paid-for account on somebody's panel.
 */
export const serviceSummarySchema = z.object({
  id: z.string(),
  customerId: z.string(),
  orderId: z.string(),
  panelId: z.string(),
  productId: z.string(),
  state: z.enum(SERVICE_STATES),
  /** The handle an operator types into the panel. Not a credential. */
  providerUsername: z.string(),
  /** The panel's own id for the account, once a create has succeeded. */
  providerUserId: z.string().nullable(),
  /**
   * WHETHER a subscription exists, never what it is.
   *
   * A boolean rather than the URL, because the URL is a bearer capability and this is
   * a list an operator can page through. See the docblock.
   */
  hasSubscription: z.boolean(),
  expiresAt: z.iso.datetime().nullable(),
  /** Minor-unit-style text: a byte count passes 2^53 and JSON has one number type. */
  trafficLimitBytes: z.string(),
  trafficUsedBytes: z.string(),
  /** When usage was last read BACK from the panel. Null means never. */
  usageSyncedAt: z.iso.datetime().nullable(),
  deliveryState: z.enum(SERVICE_DELIVERY_STATES),
  deliveredAt: z.iso.datetime().nullable(),
  provisionedAt: z.iso.datetime().nullable(),
  terminatedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ServiceSummaryResponse = z.infer<typeof serviceSummarySchema>;

/**
 * The detail, which adds only what a LIST has no business carrying.
 *
 * `deliveryAttempts` and `deliveryNextAttemptAt` answer "why has this customer not had
 * their link", which is the question that brings an operator to one service. They are
 * not on the summary because a column of attempt counters invites reading the list as
 * a queue, and the queue is the worker's.
 *
 * It adds NO credential. The absence in the summary is not a paging optimisation.
 */
/**
 * What an operator may do to this service RIGHT NOW, and why not when they may not.
 *
 * Phase 6A. The list is computed server-side against the same three authorities the
 * write paths check — `SERVICE_MACHINE`'s legal states, the panel's declared
 * capabilities, and whether an operation of that type is already open — so a surface
 * cannot draw a button the request would refuse, and cannot invent a reason for one it
 * does not draw.
 *
 * It is NOT the authorization. Every action re-checks its permission and all three
 * conditions inside its own request; this exists so the screen can say "this panel
 * cannot disable users" instead of a greyed-out button with no explanation, which is
 * the legacy system's whole style of refusal.
 */
export const SERVICE_OPERATOR_ACTIONS = [
  'SYNC_USAGE',
  'RESEND_CONFIG',
  'RETRY_PROVISION',
  'RECONCILE',
  'SUSPEND',
  'RESUME',
  'TERMINATE',
] as const;
export type ServiceOperatorAction = (typeof SERVICE_OPERATOR_ACTIONS)[number];

/**
 * Why an action is not offered. One of these, never a sentence.
 *
 * A code rather than prose because the surface renders it in Persian from its own
 * catalogue, and because the three that matter are genuinely different jobs:
 * `STATE` is the customer's or the lifecycle's, `CAPABILITY` and `PANEL_NOT_OPERABLE`
 * are the operator's panel configuration, and `IN_PROGRESS` is transient and worth
 * waiting out. `NO_CONFIGURATION` and `NO_CONTACT` are delivery's two: nothing to send,
 * and nobody to send it to.
 */
export const SERVICE_ACTION_BLOCKERS = [
  'STATE',
  'CAPABILITY',
  'PANEL_NOT_OPERABLE',
  'IN_PROGRESS',
  'NO_CONFIGURATION',
  'NO_CONTACT',
] as const;
export type ServiceActionBlocker = (typeof SERVICE_ACTION_BLOCKERS)[number];

export const serviceActionAvailabilitySchema = z.object({
  action: z.enum(SERVICE_OPERATOR_ACTIONS),
  available: z.boolean(),
  /** Null exactly when `available` is true. */
  blocker: z.enum(SERVICE_ACTION_BLOCKERS).nullable(),
});
export type ServiceActionAvailability = z.infer<typeof serviceActionAvailabilitySchema>;

export const serviceDetailSchema = serviceSummarySchema.extend({
  deliveryAttempts: z.number().int(),
  deliveryNextAttemptAt: z.iso.datetime().nullable(),
  /**
   * Every action, available or not, with its blocker. The full list rather than the
   * available subset: a surface that received only what it may do could not tell an
   * action that is unavailable from one this release does not have, and the difference
   * is what an operator is trying to find out.
   */
  actions: z.array(serviceActionAvailabilitySchema),
});
export type ServiceDetailResponse = z.infer<typeof serviceDetailSchema>;

export const serviceListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(SERVICE_PAGE_MAX).optional(),
  cursor: z.string().min(1).max(255).optional(),
  state: z.enum(SERVICE_STATES).optional(),
  deliveryState: z.enum(SERVICE_DELIVERY_STATES).optional(),
  /* Ids, validated HERE: these reach `uuid` columns. See `orderListQuerySchema`. */
  customerId: uuidV7Schema.optional(),
  /**
   * The order that bought the service. At most one row can match.
   *
   * Added so the Web Admin order page can show what its order produced. It had
   * no route to that at all: an operator reading a REFUNDED order saw the money
   * and nothing about the service, the provisioning attempt or why it failed.
   */
  orderId: uuidV7Schema.optional(),
  panelId: uuidV7Schema.optional(),
  /*
   * The name a customer quotes, matched EXACTLY.
   *
   * The one handle a support conversation actually contains: a customer writes "my
   * account nx-7f3a91 stopped working", and until this existed every surface in this
   * product could operate that service and none could find it. The two ways in were
   * the internal uuid, which appears nowhere outside this admin's own URLs, and the
   * customer — if the operator could work out which customer that was.
   *
   * `providerUsernameLookupSchema` folds ASCII case and admits the legacy shape as
   * well as the current one; see its docblock for why it is exact rather than a
   * prefix, and why a prefix here would be an enumeration of a panel's accounts.
   */
  providerUsername: providerUsernameLookupSchema.optional(),
});
export type ServiceListQuery = z.infer<typeof serviceListQuerySchema>;

export const serviceListResponseSchema = z.object({
  services: z.array(serviceSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ServiceListResponse = z.infer<typeof serviceListResponseSchema>;

export const serviceResponseSchema = z.object({ service: serviceDetailSchema });
export type ServiceResponse = z.infer<typeof serviceResponseSchema>;

/**
 * One operation against a service, as the Web Admin renders it.
 *
 * The answer to "what has been attempted on this service and how did it go", which is
 * the other half of the question that brings an operator to a service detail. Without
 * it the screen can say a service is `UNRECONCILED` and nothing about why.
 *
 * `failureMessage` is the ADAPTER's own text and is included: it is what distinguishes
 * a panel refusing a duplicate from a panel that was unreachable, and an operator can
 * act on that difference. It is not a credential and the adapters do not put response
 * bodies in it.
 */
export const serviceOperationSchema = z.object({
  id: z.string(),
  type: z.enum(OPERATION_TYPES),
  state: z.enum(OPERATION_STATES),
  attempts: z.number().int(),
  failureMessage: z.string().nullable(),
  scheduledAt: z.iso.datetime().nullable(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type ServiceOperationResponse = z.infer<typeof serviceOperationSchema>;

/**
 * A service's recent operations, with the bound that produced them.
 *
 * `operations` alone was the whole response, and a client reading fifty rows could not
 * tell whether there had been fifty-one. The Web Admin's copy filled the gap with an
 * opinion — that a service with dozens of operations is itself the problem — which a
 * service renewing monthly for two years falsifies, and which was never a measurement
 * anyway. A truncated list that reads like a complete one is the defect the
 * administrator roster was fixed for in WP1.
 *
 * So the bound travels with the rows: `limit` is what was asked for and `hasMore` is
 * whether the server found one beyond it. Both are facts about THIS response, so a
 * surface can state the bound it is actually subject to rather than a constant it
 * imported.
 */
export const serviceOperationsResponseSchema = z.object({
  operations: z.array(serviceOperationSchema),
  /** How many rows this response was bounded to. Not a constant a client may assume. */
  limit: z.number().int().positive(),
  /**
   * Whether the server saw at least one older operation than the last row here.
   *
   * Measured by reading `limit + 1` and discarding the extra, which is how every paged
   * read in this repository answers the same question without a second COUNT.
   */
  hasMore: z.boolean(),
});
export type ServiceOperationsResponse = z.infer<typeof serviceOperationsResponseSchema>;

/**
 * The word an operator types to terminate a service.
 *
 * A typed phrase rather than a second button, for the reason
 * `RECOVERY_CONFIRMATION_PHRASE` gives: terminate DELETES the account on somebody's
 * panel and the customer keeps their paid-for order, so the confirmation has to cost
 * more than a mis-click. Compared after trimming and in full — a near-miss is not a
 * confirmation.
 */
export const SERVICE_TERMINATE_CONFIRMATION = 'TERMINATE';

/** Every service action but terminate: an idempotency key and nothing else. */
export const serviceActionRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
});
export type ServiceActionRequest = z.infer<typeof serviceActionRequestSchema>;

export const serviceTerminateRequestSchema = serviceActionRequestSchema.extend({
  /** The phrase, exactly. See `SERVICE_TERMINATE_CONFIRMATION`. */
  confirm: z.string().max(64),
});
export type ServiceTerminateRequest = z.infer<typeof serviceTerminateRequestSchema>;

/**
 * What an action answers with: the service as it now is, and the operation it planned.
 *
 * BOTH, and neither is redundant. The service is what the screen redraws — a row left
 * showing its pre-action state is the defect `AdminsSection` had before Phase 3D, where
 * a suspended administrator kept reading as active. The operation is the evidence the
 * work was ACCEPTED and not completed: `state` is `PLANNED`, the provider has not been
 * called, and a surface that reported success would be claiming an effect that has not
 * happened yet. `operation` is null only for the actions that plan none — a resend
 * sends a message and writes a delivery row.
 */
export const serviceActionResponseSchema = z.object({
  service: serviceDetailSchema,
  operation: serviceOperationSchema.nullable(),
});
export type ServiceActionResponse = z.infer<typeof serviceActionResponseSchema>;

/**
 * The routes.
 *
 * Phase 6A adds the writes. The read-only note that stood here said terminate needed
 * "the operator-initiated half of a flow whose customer half 4E built" and that a
 * transfer had no stated rule — the first is what this phase builds, and the second is
 * still true: there is NO transfer route, `services.transfer` remains a declared
 * permission with no endpoint, and `docs/open-questions.md` still carries the question
 * of what becomes of the order, the payment and the subscription the previous owner
 * holds. Inventing that answer in a controller is the guess this repository refuses.
 *
 * Each action is its own path rather than one `POST /operations` taking a type, because
 * the permission differs — terminate charges `services.terminate` and the rest charge
 * `services.edit` — and a single route would make that mapping a runtime switch inside
 * a handler instead of a property of the URL.
 */
export const SERVICE_ROUTES = {
  list: '/services',
  detail: (id: string) => `/services/${encodeURIComponent(id)}`,
  operations: (id: string) => `/services/${encodeURIComponent(id)}/operations`,
  syncUsage: (id: string) => `/services/${encodeURIComponent(id)}/sync-usage`,
  resend: (id: string) => `/services/${encodeURIComponent(id)}/resend`,
  retryProvision: (id: string) => `/services/${encodeURIComponent(id)}/retry-provision`,
  reconcile: (id: string) => `/services/${encodeURIComponent(id)}/reconcile`,
  suspend: (id: string) => `/services/${encodeURIComponent(id)}/suspend`,
  resume: (id: string) => `/services/${encodeURIComponent(id)}/resume`,
  terminate: (id: string) => `/services/${encodeURIComponent(id)}/terminate`,
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
