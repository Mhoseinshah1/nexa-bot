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

// Node's base64 decoder silently discards invalid characters, so a length check
// alone accepts a corrupted or truncated key and boots with a key that is not
// the one the operator pasted — producing data nobody can decrypt later.
const base64Key = (bytes: number) =>
  z
    .string()
    .min(1)
    .refine((value) => /^[A-Za-z0-9+/]+={0,2}$/.test(value), {
      message: 'must be valid base64',
    })
    .refine((value) => Buffer.from(value, 'base64').length === bytes, {
      message: `must decode to exactly ${bytes} bytes`,
    })
    .refine((value) => !Buffer.from(value, 'base64').every((byte) => byte === 0), {
      message: 'must not be all zero bytes',
    });

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
     * `password` is the real Web Admin authentication surface: username and
     * password against the `admins` table. `none` remains a development-only
     * escape hatch and the refinement below still refuses to boot with it
     * anywhere else.
     */
    AUTH_MODE: z.enum(['none', 'password']).default('password'),

    /** How long a session lives without being renewed. */
    SESSION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(300)
      .max(30 * 24 * 3600)
      .default(12 * 3600),

    /**
     * Password hashing cost. `fast` makes the test suite finish; the refinement
     * below refuses it in production, the same way it refuses AUTH_MODE=none.
     * Inferring this from NODE_ENV would mean an install left on `development`
     * stored every password at a thousandth of the intended cost.
     */
    PASSWORD_HASH_PROFILE: z.enum(['production', 'fast']).default('production'),

    /** Failed logins per subject before a lockout, and how long it lasts. */
    LOGIN_MAX_ATTEMPTS_PER_USERNAME: z.coerce.number().int().min(1).max(100).default(5),
    LOGIN_MAX_ATTEMPTS_PER_IP: z.coerce.number().int().min(1).max(1000).default(20),
    LOGIN_THROTTLE_WINDOW_SECONDS: z.coerce.number().int().min(30).max(86_400).default(900),
    LOGIN_LOCKOUT_SECONDS: z.coerce.number().int().min(30).max(86_400).default(900),

    /**
     * Origins the browser admin may call from. Empty disables the check, which
     * is only legal outside production: the Origin check is the second half of
     * the CSRF defence, behind SameSite=Strict.
     */
    WEB_ADMIN_ORIGINS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      ),

    TELEGRAM_WEBHOOK_ENABLED: booleanish.default(false),
    // The route itself is fixed at /telegram/webhook. A configurable path was
    // validated here and never read by the controller, so setting it produced a
    // registered URL that 404s while the real endpoint stayed on the default.
    TELEGRAM_WEBHOOK_SECRET: z.string().default(''),

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
    if (config.PASSWORD_HASH_PROFILE === 'fast' && config.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['PASSWORD_HASH_PROFILE'],
        message:
          'PASSWORD_HASH_PROFILE=fast is a test affordance and must never be used in production. ' +
          'It reduces the scrypt work factor by more than two orders of magnitude.',
      });
    }
    if (config.NODE_ENV === 'production' && config.WEB_ADMIN_ORIGINS.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEB_ADMIN_ORIGINS'],
        message:
          'WEB_ADMIN_ORIGINS must list the admin origin in production. It is the second half of ' +
          'the CSRF defence, behind the SameSite=Strict session cookie.',
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
