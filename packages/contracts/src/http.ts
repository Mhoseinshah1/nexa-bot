import { z } from 'zod';
import { adminDisplayNameSchema } from './identity.js';

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
  reason: z.string().min(1).max(500),
});
export type SetAdminStatusRequest = z.infer<typeof setAdminStatusRequestSchema>;

export const setAdminRolesRequestSchema = z.object({
  roleKeys: z.array(z.string()),
  reason: z.string().min(1).max(500),
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
