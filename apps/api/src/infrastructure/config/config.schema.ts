import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Validated once, at boot. If anything is missing or malformed the process
 * exits non-zero and reports EVERY problem at once — not the first one — so a
 * misconfigured deployment is diagnosed in one pass instead of four restarts.
 */

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no'])])
  .transform((v) => v === true || v === 'true' || v === '1' || v === 'yes');

const port = z.coerce.number().int().min(1).max(65535);

const base64Key = (bytes: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) => {
        try {
          return Buffer.from(value, 'base64').length === bytes;
        } catch {
          return false;
        }
      },
      { message: `must be ${bytes} bytes encoded as base64` },
    );

export const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: port.default(3000),

    DATABASE_URL: z.string().min(1).startsWith('postgres'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    REDIS_URL: z.string().min(1).startsWith('redis'),

    SECRETS_KEK: base64Key(32),
    SECRETS_KEK_ID: z.string().min(1),

    /**
     * Phase 0 ships no authentication. `none` is a development-only value and
     * the refinement below refuses to boot with it anywhere else — a stub login
     * gets copied into Phase 1, a hard failure does not.
     */
    AUTH_MODE: z.enum(['none']).default('none'),

    TELEGRAM_WEBHOOK_ENABLED: booleanish.default(false),
    TELEGRAM_WEBHOOK_SECRET: z.string().default(''),
    TELEGRAM_WEBHOOK_PATH: z.string().startsWith('/').default('/telegram/webhook'),

    OUTBOX_RELAY_ENABLED: booleanish.default(true),
    OUTBOX_RELAY_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
    OUTBOX_RELAY_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
    OUTBOX_RELAY_MAX_LAG_MS: z.coerce.number().int().min(1000).default(300_000),

    BUILD_VERSION: z.string().default('0.0.0-dev'),
    BUILD_COMMIT: z.string().default('unknown'),
    BUILD_TIME: z.string().default('unknown'),
  })
  .superRefine((config, ctx) => {
    if (config.AUTH_MODE === 'none' && config.NODE_ENV !== 'development') {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_MODE'],
        message:
          'AUTH_MODE=none is permitted only when NODE_ENV=development. Phase 0 ships no authentication; ' +
          'see docs/adr/0009-identity-and-auth.md before deploying.',
      });
    }
    if (config.TELEGRAM_WEBHOOK_ENABLED && config.TELEGRAM_WEBHOOK_SECRET.length < 16) {
      ctx.addIssue({
        code: 'custom',
        path: ['TELEGRAM_WEBHOOK_SECRET'],
        message:
          'TELEGRAM_WEBHOOK_SECRET must be at least 16 characters when the webhook is enabled. ' +
          'Every update is authenticated by this header.',
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;
