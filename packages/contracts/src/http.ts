import { z } from 'zod';

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
