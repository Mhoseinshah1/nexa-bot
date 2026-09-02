import { z } from 'zod';
import { isValidTrustedEntry } from '../trusted-proxy.js';

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
     * Bounds on a database connection's waiting and working.
     *
     * Postgres defaults all three to 0 — wait forever — which turns one stalled
     * transaction holding the tenant row into an installation-wide outage with
     * no error to see. See `DatabaseTimeouts`. Migrations are exempt: they open
     * their own handle without these.
     */
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(15_000),
    DATABASE_LOCK_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
    DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(600_000)
      .default(30_000),

    /**
     * How long an EXPIRED session row is kept before housekeeping removes it.
     *
     * Not the session's lifetime — `SESSION_TTL_SECONDS` is that. This is how
     * long the dead row stays readable afterwards, which is a forensic
     * question: it carries the IP and user agent a sign-in came from, and the
     * audit log points at it by id. Long enough to investigate an incident
     * found weeks later; not the life of the installation, which is what
     * "never delete" amounted to.
     */
    SESSION_RETENTION_SECONDS: z.coerce
      .number()
      .int()
      .min(3600)
      .max(365 * 24 * 3600)
      .default(30 * 24 * 3600),

    /**
     * How this installation is exposed. There is no default in production,
     * because the two topologies need opposite settings and guessing wrong is a
     * security bug in one direction and an availability bug in the other.
     *
     *   - `reverse-proxy` — the standard deployment, Caddy in front. Requires a
     *     non-empty TRUSTED_PROXY_IPS naming the addresses Caddy connects from.
     *   - `direct` — the API is the thing clients connect to. Requires
     *     TRUSTED_PROXY_IPS to be EMPTY, so `X-Forwarded-For` is ignored
     *     entirely and the client IP is the unforgeable socket address.
     *
     * Modelled explicitly rather than inferred from whether the list happens to
     * be empty: an empty list is a legitimate configuration for one topology
     * and a serious misconfiguration for the other, and nothing at runtime can
     * tell them apart.
     */
    DEPLOYMENT_TOPOLOGY: z.enum(['reverse-proxy', 'direct']).default('reverse-proxy'),

    /**
     * Which upstreams may be believed about the client's IP.
     *
     * A comma-separated list of IPs or CIDRs — the addresses our own reverse
     * proxy connects from. Empty means `X-Forwarded-For` is ignored entirely
     * and the client IP is the socket address.
     *
     * `trustProxy=true` is deliberately not offered. It believes the header
     * from whoever connects, so a client reaching the port directly can claim
     * any IP it likes — and the two things the client IP is used for here are
     * brute-force throttling and audit rows. Spoofable means an attacker
     * rotates a header instead of an address, and the audit trail names
     * whoever they chose.
     */
    TRUSTED_PROXY_IPS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
      ),

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

    /**
     * How long a graceful shutdown may take before the process leaves anyway.
     *
     * Shorter than an orchestrator's grace period, deliberately: the point is
     * to exit with a log line saying what was stuck, rather than to be killed
     * mid-sentence and leave the operator guessing.
     */
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),

    /**
     * Which transport carries operational notifications.
     *
     * `recording` keeps messages in memory instead of sending them, for tests.
     * The refinement below refuses it outside development: a deployment that
     * selected it would report every notification delivered while nothing left
     * the process, which is the "reports success for a write that did not
     * happen" pattern this codebase exists to avoid — on the one channel whose
     * job is to tell somebody things are broken.
     */
    NOTIFICATION_TRANSPORT: z.enum(['telegram', 'recording']).default('telegram'),
    /**
     * Overridable so tests can point at a local stub rather than the real API.
     * Production insists on HTTPS; see the cross-field check below.
     */
    TELEGRAM_API_BASE_URL: z.string().url().default('https://api.telegram.org'),
    NOTIFICATION_SEND_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(10_000),
    NOTIFICATION_DISPATCH_ENABLED: booleanish.default(true),
    NOTIFICATION_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(2000),
    NOTIFICATION_DISPATCH_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
    /**
     * How long a claimed intent stays claimed.
     *
     * Longer than any plausible send, so a slow Telegram cannot produce a second
     * dispatcher sending the same message; short enough that a process killed
     * mid-send releases its work in minutes rather than never.
     */
    NOTIFICATION_CLAIM_LEASE_MS: z.coerce.number().int().min(5_000).max(600_000).default(120_000),
    NOTIFICATION_BACKOFF_BASE_MS: z.coerce.number().int().min(100).max(60_000).default(5_000),
    NOTIFICATION_BACKOFF_MAX_MS: z.coerce.number().int().min(1000).max(3_600_000).default(300_000),

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
          'AUTH_MODE=none is permitted only when NODE_ENV=development. Authentication is real from ' +
          'Phase 1 onward — this setting disables it, and outside development that is a deployment ' +
          'with no front door. See docs/adr/0013-web-admin-authentication.md.',
      });
    }
    if (config.NODE_ENV === 'production') {
      // Parsed, not prefix-matched. `https://evil/?x=http://api.telegram.org`
      // starts with the wrong thing and `HTTPS://…` with the right one, and a
      // `startsWith` gets both backwards. The protocol is a field; read the
      // field.
      //
      // Not silently rewritten to https either. A bot token travels in the URL
      // path of every Telegram call, so an http:// base means every send
      // publishes the credential to the network — and quietly "fixing" the
      // value would hide that somebody had configured it, which is worth
      // knowing about a deployment.
      let protocol: string | null = null;
      try {
        protocol = new URL(config.TELEGRAM_API_BASE_URL).protocol;
      } catch {
        protocol = null;
      }
      if (protocol !== 'https:') {
        ctx.addIssue({
          code: 'custom',
          path: ['TELEGRAM_API_BASE_URL'],
          message:
            'TELEGRAM_API_BASE_URL must use https in production. The bot token is part of every ' +
            'request path, so an insecure base URL publishes the credential on the wire. A local ' +
            'http stub is permitted outside production.',
        });
      }
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
    // Every entry must parse. A typo that silently voids the trusted set turns
    // the proxy's own address into one shared throttle subject for everybody;
    // a typo that silently widens it trusts an upstream nobody chose.
    const invalidProxies = config.TRUSTED_PROXY_IPS.filter((entry) => !isValidTrustedEntry(entry));
    if (invalidProxies.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUSTED_PROXY_IPS'],
        message:
          `Not a valid IP address or CIDR: ${invalidProxies.join(', ')}. ` +
          'Entries look like 127.0.0.1, ::1 or 10.0.0.0/8. A /0 prefix is refused: it would ' +
          'trust every address, which is trustProxy=true spelled differently.',
      });
    }

    if (config.DEPLOYMENT_TOPOLOGY === 'reverse-proxy' && config.TRUSTED_PROXY_IPS.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUSTED_PROXY_IPS'],
        message:
          'DEPLOYMENT_TOPOLOGY=reverse-proxy requires TRUSTED_PROXY_IPS to name the addresses ' +
          'the proxy connects from (for Caddy on the same host, 127.0.0.1,::1). Left empty, ' +
          'every request appears to come from the proxy and one failed-login burst would lock ' +
          'out every administrator. Set DEPLOYMENT_TOPOLOGY=direct if there is genuinely no ' +
          'proxy in front of this process.',
      });
    }

    if (config.DEPLOYMENT_TOPOLOGY === 'direct' && config.TRUSTED_PROXY_IPS.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUSTED_PROXY_IPS'],
        message:
          'DEPLOYMENT_TOPOLOGY=direct means nothing sits in front of this process, so no ' +
          'upstream may be believed about the client IP. Either clear TRUSTED_PROXY_IPS or ' +
          'set DEPLOYMENT_TOPOLOGY=reverse-proxy.',
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
    if (config.NODE_ENV === 'production' && config.DEPLOYMENT_TOPOLOGY === 'direct') {
      ctx.addIssue({
        code: 'custom',
        path: ['DEPLOYMENT_TOPOLOGY'],
        message:
          'DEPLOYMENT_TOPOLOGY=direct is not usable in production: this process serves plain ' +
          'HTTP and has no TLS configuration, while a production login always issues a Secure ' +
          '__Host- cookie that a browser refuses to store over HTTP. Every login would appear to ' +
          'succeed and authenticate nothing. Put TLS in front and set ' +
          'DEPLOYMENT_TOPOLOGY=reverse-proxy with TRUSTED_PROXY_IPS.',
      });
    }
    if (config.NODE_ENV === 'production') {
      // Not a style preference. Production issues the session as a `Secure`
      // `__Host-` cookie, and a browser will not store one from an insecure
      // origin — so an `http://` admin origin boots, passes the Origin check,
      // logs in successfully, and leaves the administrator unauthenticated with
      // nothing to point at. HSTS cannot rescue the first response, because a
      // browser ignores HSTS received over HTTP. Refused at boot instead.
      //
      // Each entry must also be a CANONICAL serialized origin, because that is
      // what the Origin check compares against and a browser sends nothing
      // else. `https://admin.example.com/` — one trailing slash — passes any
      // prefix test, matches no Origin header, and rejects every login and
      // every write on a deployment whose configuration validated cleanly.
      // Parsing settles it, and rejects paths, queries, ports written oddly and
      // embedded credentials at the same time.
      const rejected = config.WEB_ADMIN_ORIGINS.filter((origin) => {
        let parsed: URL;
        try {
          parsed = new URL(origin);
        } catch {
          return true;
        }
        return parsed.protocol !== 'https:' || parsed.origin !== origin;
      });
      if (rejected.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['WEB_ADMIN_ORIGINS'],
          message:
            `Every production admin origin must be a canonical https origin, such as ` +
            `https://admin.example.com with no trailing slash or path. These are not: ` +
            `${rejected.join(', ')}. The session is issued as a Secure __Host- cookie, which a ` +
            'browser refuses to store from an insecure origin; and the Origin check compares ' +
            'exactly what the browser sends, which is the serialized origin and nothing else.',
        });
      }
    }
    if (config.NOTIFICATION_TRANSPORT === 'recording' && config.NODE_ENV !== 'development') {
      ctx.addIssue({
        code: 'custom',
        path: ['NOTIFICATION_TRANSPORT'],
        message:
          'NOTIFICATION_TRANSPORT=recording is permitted only when NODE_ENV=development. It keeps ' +
          'messages in memory instead of sending them, so an installation running it would look ' +
          'healthy while every operational alert went nowhere.',
      });
    }
    if (config.NOTIFICATION_BACKOFF_MAX_MS < config.NOTIFICATION_BACKOFF_BASE_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['NOTIFICATION_BACKOFF_MAX_MS'],
        message:
          'NOTIFICATION_BACKOFF_MAX_MS must be at least NOTIFICATION_BACKOFF_BASE_MS; otherwise the ' +
          'cap is shorter than the first wait and the back-off never grows.',
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
