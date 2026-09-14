import { z } from 'zod';
import { parseKeyring, type SecretKeyring } from '../crypto/keyring.js';
import { isValidTrustedEntry } from '../trusted-proxy.js';
import { MAX_REQUESTS_PER_PROBE } from '@nexa/contracts';
import {
  effectiveProbeCooldownMs,
  healthyCadenceFitsFreshness,
  healthyCadenceOutlastsCooldown,
  maxHealthyIntervalMs,
  MONITOR_NONRETRYABLE_FLOOR_MS,
} from '../../modules/platform/panels/domain/monitor-cadence.js';

/**
 * The HTTP retry count the panel client is built with.
 *
 * Declared here as well as in `container.ts` because the schema has to refuse a
 * cadence the cooldown cannot honour, and it cannot import the container. A
 * divergence would make the schema accept a configuration the container then
 * obeys differently, so `deployment-compose.test.ts` asserts the two agree.
 */
const PANEL_HTTP_RETRIES = 0;

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

/**
 * A CIDR, loosely. The policy parses it properly; this only stops a typo from
 * becoming a subnet that silently matches nothing.
 */
const CIDR = /^[0-9a-fA-F:.]+\/\d{1,3}$/;

export const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_PORT: port.default(3000),

    DATABASE_URL: z.string().min(1).startsWith('postgres'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    REDIS_URL: z.string().min(1).startsWith('redis'),

    /**
     * The keyring: `id:base64,id:base64`, and the id of the one key new
     * secrets are encrypted with.
     *
     * Both optional in the schema and neither optional in effect — the
     * refinement below requires a usable keyring by one route or the other,
     * and reports every problem with it at once.
     */
    SECRETS_KEYS: z.string().optional(),
    SECRETS_ACTIVE_KEY_ID: z.string().optional(),

    /**
     * The v1 spelling, still accepted.
     *
     * Every installation that exists today was installed with these two and
     * nothing else. Adopting the v2 envelope must not require reinstalling or
     * hand-editing /etc/nexa/nexa.env, so they alias to a one-entry keyring
     * whose only key is the active one — which is precisely what v1 did.
     * Removing them is a later, deliberate release.
     */
    SECRETS_KEK: base64Key(32).optional(),
    SECRETS_KEK_ID: z.string().min(1).optional(),

    /**
     * Whether v1 ciphertext may still be read.
     *
     * Deliberately has NO default here, and is read through `acceptsV1` below
     * rather than directly. A plain `.default('true')` made acceptance the
     * thing that happens when nobody decides — and since a host installed
     * before this setting existed has no such line in its `nexa.env`, "nobody
     * decided" described every installation in production.
     *
     * Worth being exact about what acceptance costs: v1 carries no associated
     * data, so a v1 ciphertext remains transplantable between rows. v2 does not
     * retroactively protect v1 data — re-encrypting every row and then refusing
     * v1 does.
     */
    SECRETS_ACCEPT_V1: z.enum(['true', 'false']).optional(),

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
     * Where the worker writes its heartbeat, and how often.
     *
     * The worker serves no HTTP, so this file is its health check: written
     * every interval after a real database round trip, read by the container
     * check in compose.yml, which requires it to be younger than three
     * intervals. A path under /tmp, which the runtime image's non-root user
     * can write and which is private to the container.
     */
    WORKER_HEARTBEAT_PATH: z.string().min(1).default('/tmp/nexa-worker.heartbeat'),
    WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),

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

    /**
     * How long an outbound provider call may take, in total.
     *
     * DNS, connect, TLS, request and the whole response body. A per-socket
     * timeout does not bound a panel that sends a byte every few seconds
     * forever, which is the shape that ties up a worker without ever looking
     * like a failure.
     */
    PANEL_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(10_000),
    /**
     * How long one panel's connection test occupies that panel.
     *
     * A probe logs into somebody else's panel. Repeated without a bound it is
     * two problems: a way to sweep a network one panel edit at a time, and a
     * way to lock the provider account it authenticates against — several panel
     * packages lock after a handful of failed logins. Within the window the
     * caller gets the stored result of the last probe of the same
     * configuration, and changing the panel or a credential bypasses it.
     *
     * Floored at the HTTP budget rather than taken as given: a cooldown shorter
     * than a probe can run would let a second request start while the first is
     * still on the wire, which is the case the window exists to prevent.
     *
     * There is no off switch. A value floored at one second is the smallest
     * thing that still bounds a loop, and a deployment that could set this to
     * zero would eventually be one that had.
     */
    PANEL_PROBE_COOLDOWN_MS: z.coerce.number().int().min(1_000).max(600_000).default(10_000),
    /**
     * How many REAL outbound provider probes a tenant may make, and over what
     * window — across every panel it has and every API process.
     *
     * The per-panel cooldown is reset by a configuration change on purpose,
     * so an operator can retest a corrected credential at once. That also
     * means alternating two configurations retests on every change, and the
     * total volume of outbound probes needs a bound configuration cannot
     * reset. A token bucket of LIMIT tokens refilling continuously at
     * LIMIT per WINDOW: a burst of LIMIT, then one every WINDOW/LIMIT.
     *
     * A hundred per five minutes, raised from thirty when the health cadence
     * went from ten minutes to three. It is the SAME bucket, not a second one:
     * background probes and an operator's manual tests still come out of one
     * allowance per tenant, which is the whole point of the bound. What changed
     * is its size, and it changed because the cadence did — `n` panels at
     * interval `i` need `n / i` probes per unit time, so holding the fleet a
     * tenant can keep fresh at 60 panels while the interval falls by 3.3x means
     * the refill rate has to rise by the same factor. Leaving it at thirty
     * would have been a silent capacity cut dressed up as a cadence change.
     */
    PANEL_PROBE_TENANT_LIMIT: z.coerce.number().int().min(1).max(10_000).default(100),
    PANEL_PROBE_TENANT_WINDOW_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(24 * 60 * 60 * 1000)
      .default(300_000),
    /**
     * Background panel health monitoring.
     *
     * Five knobs, not twenty: whether the loop runs, how often it wakes, and
     * the three cadences that follow from what the last probe found. Batch
     * size and concurrency bound the work; everything else is derived.
     */
    PANEL_MONITOR_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    /**
     * How often the loop wakes to look for work.
     *
     * Not the probe cadence — a tick that finds nothing due does nothing. It
     * bounds how late a due panel can be, and it is the interval the heartbeat
     * is judged against.
     */
    PANEL_MONITOR_TICK_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(10 * 60 * 1000)
      .default(30_000),
    /**
     * How long a HEALTHY result is allowed to stand before a re-probe.
     *
     * THREE MINUTES, on the owner's instruction: a panel that goes down should
     * be known to be down in minutes, not in a quarter of an hour. It was ten,
     * which sat comfortably inside `PANEL_HEALTH_FRESH_FOR_MS` of fifteen and
     * was chosen for exactly that reason; three sits further inside it still.
     *
     * Faster is not free, and the cost is arithmetic rather than opinion.
     * Keeping `n` panels fresh at interval `i` needs `n / i` probes per unit
     * time, so cutting the interval by 3.3x cuts what a FIXED probe budget can
     * keep fresh by the same factor: at the old budget this default alone would
     * have taken a tenant from 60 panels to 18 and the installation from 1000
     * to 300, silently, with the capacity conditions firing on fleets that were
     * comfortable the release before. `PANEL_PROBE_TENANT_LIMIT` and
     * `PANEL_MONITOR_BATCH_SIZE` are raised in step to hold the ceilings where
     * they were — see the note on each.
     *
     * The per-field ceiling here is only half the bound. Worst-case refresh is
     * the interval PLUS the anti-herd spread PLUS however long a due panel
     * waits for a tick to pick it up, and the last term is another field — so
     * the real check is a cross-field one at the bottom of this schema. A
     * twelve-minute cadence is fine with a thirty-second tick and refused with
     * a ten-minute one, and no single field can express that.
     */
    PANEL_MONITOR_HEALTHY_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(30_000)
      .max(12 * 60 * 1000)
      .default(3 * 60 * 1000),
    /**
     * After a RETRYABLE failure — a timeout, an unreachable host, a provider
     * error. Trying again soon is the point: these are the failures that fix
     * themselves.
     */
    PANEL_MONITOR_RETRYABLE_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(60 * 60 * 1000)
      .default(2 * 60 * 1000),
    /**
     * After a NON-RETRYABLE failure — rejected credentials, a panel wanting a
     * second factor, a refused target, a malformed answer.
     *
     * Long, and that is the safety property rather than a tuning choice. A
     * stable bad credential retried on a short cadence is a credential-stuffing
     * loop pointed at the operator's own panel, and both providers this release
     * speaks to lock an account for exactly that. An operator who fixes the
     * credential does not wait this out: replacing one changes the panel's
     * configuration, which makes it due immediately.
     */
    PANEL_MONITOR_NONRETRYABLE_INTERVAL_MS: z.coerce
      .number()
      .int()
      // Thirty minutes, not one. A minute-scale first retry that doubles is
      // still an automated login hammer: it spends four or five attempts
      // against the operator's own panel before it slows down, and both
      // providers this release speaks to lock an account for fewer than that.
      // `MONITOR_NONRETRYABLE_FLOOR_MS` clamps the policy as well, so a caller
      // that builds a cadence object without going through this schema cannot
      // get under it either.
      .min(MONITOR_NONRETRYABLE_FLOOR_MS)
      .max(24 * 60 * 60 * 1000)
      .default(60 * 60 * 1000),
    /**
     * Panels considered in one tick. The query is LIMITed by this.
     *
     * A hundred and fifty, raised from fifty for the same reason as the tenant
     * limit: the installation-wide ceiling is `batch x (interval / tick)`, so
     * the three-minute cadence would have taken it from 1000 to 300. At 150 it
     * is 900 — near enough the same fleet, with a tick that still does bounded
     * work.
     */
    PANEL_MONITOR_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(150),
    /**
     * How often the monitor re-assesses what this installation can keep fresh.
     *
     * Two aggregates over `panels`, so not every tick — and not once at startup
     * either, because the population an operator GROWS into is exactly the one
     * that matters and a boot-time-only check would never see it. Ten minutes
     * is slow enough to be free and quick enough that an operator who doubles
     * their fleet hears about it in the same sitting.
     */
    PANEL_MONITOR_CAPACITY_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(24 * 60 * 60 * 1000)
      .default(10 * 60 * 1000),
    /**
     * Tenants given a turn in one tick — the fairness dial.
     *
     * With `d` tenants due and this many claimed per tick, no tenant waits
     * longer than `ceil(d / t)` ticks, whatever the backlog inside any one of
     * them. The per-tenant share of the batch is derived from how many were
     * actually claimed, so a single-tenant installation still gets the whole
     * batch and a fifty-tenant one still gets fairness.
     *
     * It is also a CAPACITY bound, and one that no field here can express: the
     * rotation reaches `this x (healthy interval / tick)` tenants inside a
     * freshness window, which at the shipped defaults is 10 x (180s / 30s) =
     * 60. A hundred single-panel tenants is a hundred panels — far under the
     * 900-panel scheduler ceiling, so no capacity condition fires — and forty
     * of them still wait longer than the interval for their first probe. It is
     * reported by `GET /system/monitor` as `tenantTurnCeiling` rather than
     * refused here, because the number of tenants is not configuration: it
     * grows, and a schema cannot see it.
     */
    PANEL_MONITOR_TENANTS_PER_TICK: z.coerce.number().int().min(1).max(200).default(10),
    /** Probes in flight at once. Bounds outbound sockets and pool checkouts. */
    PANEL_MONITOR_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    /**
     * The share of a tenant's probe budget the background loop may not touch,
     * as a percentage held back for operators.
     *
     * Background monitoring is bounded by the same tenant bucket as everything
     * else — there is no second budget and no side door. What this adds is a
     * FLOOR: the monitor's take is refused while fewer than this share of the
     * capacity remains, so an operator pressing "Test connection" still finds
     * capacity on a tenant whose panels are all failing and retrying. Enforced
     * inside the same atomic statement that takes the token, so it holds across
     * however many monitor replicas are running.
     *
     * Zero is refused while monitoring is enabled. The invariant this protects
     * — an operator always outranks the background loop for the last token —
     * is not something a configuration should be able to switch off by
     * accident, and a percentage that rounds to nothing is exactly how it would
     * be switched off by accident. The cross-field check below enforces it.
     */
    PANEL_MONITOR_BUDGET_RESERVE_PERCENT: z.coerce.number().int().min(0).max(90).default(40),
    /** Where the monitor writes its heartbeat, and how often. */
    PANEL_MONITOR_HEARTBEAT_PATH: z.string().trim().min(1).default('/tmp/nexa-monitor.heartbeat'),

    /**
     * Backup.
     *
     * INSTALLATION configuration, in the environment, not tenant settings. A
     * dump is of the whole database; a per-tenant switch for it would be a
     * setting that cannot mean what it says. It also has to be readable by a
     * CLI that runs before — and during — the failure a backup exists for, and
     * a settings table is exactly what is unavailable then.
     */
    BACKUP_SCHEDULE_ENABLED: booleanish.default(false),
    /**
     * How long after the last SUCCESSFUL backup the next one is due.
     *
     * Twenty-four hours. Measured from the last verified artifact rather than
     * from process start, so restarts do not multiply backups and failures do
     * not reset the clock as though they had worked.
     */
    BACKUP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(15 * 60_000)
      .max(30 * 24 * 3_600_000)
      .default(24 * 3_600_000),
    /** How often the worker asks whether a backup is due. Asking is cheap. */
    BACKUP_TICK_MS: z.coerce
      .number()
      .int()
      .min(30_000)
      .max(3_600_000)
      .default(5 * 60_000),
    /**
     * Where run workspaces live.
     *
     * On the installation's data volume, never `/tmp`: a plaintext dump is the
     * database with the encryption taken off, and `/tmp` is world-traversable
     * on a default host, cleaned by a timer nobody here controls, and often a
     * tmpfs a real database will not fit in.
     */
    BACKUP_WORK_DIR: z.string().trim().min(1).default('/var/lib/nexa/backups'),
    /**
     * The Telegram chat the archive is delivered to.
     *
     * Empty means delivery is not configured, which is NOT a failure: a run
     * that dumps, verifies and retains is a backup. ADR-0011's fifth
     * compensating control is that this chat is dedicated and its membership
     * reviewed, which is an operational obligation this field cannot enforce
     * and `docs/backup.md` states.
     */
    BACKUP_TELEGRAM_CHAT_ID: z.string().trim().default(''),
    /**
     * The bot token used for backup delivery.
     *
     * Deliberately its own value rather than the tenant's operational bot. The
     * destination is an installation-level channel holding the whole database,
     * and reusing the customer-facing bot's token would mean the credential
     * that posts backups is the one most widely deployed and most often
     * rotated. Empty means delivery is not configured.
     */
    BACKUP_TELEGRAM_BOT_TOKEN: z.string().trim().default(''),
    /** Ceilings on the tools. A dump that never ends holds the lock for ever. */
    BACKUP_DUMP_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(12 * 3_600_000)
      .default(2 * 3_600_000),
    BACKUP_RESTORE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(12 * 3_600_000)
      .default(2 * 3_600_000),
    BACKUP_DELIVERY_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(3_600_000)
      .default(10 * 60_000),
    /** Where the PostgreSQL client tools live, when they are not on PATH. */
    BACKUP_PG_BIN_DIR: z.string().trim().default(''),

    /**
     * Disaster recovery.
     *
     * INSTALLATION configuration for the same reason backup is: a restore is of
     * the whole database, so a per-tenant switch could not mean what it says, and
     * the executor has to be configurable in exactly the situation where the
     * settings table is what is unavailable.
     */
    /**
     * Where uploaded archives live while a recovery is alive.
     *
     * A DIFFERENT directory from `BACKUP_WORK_DIR`, defaulting beside it. Sharing
     * one would put artifacts an operator uploaded in the directory the backup
     * pipeline creates and removes per-run, and a retention sweep written for one
     * of those would eventually be applied to the other.
     */
    RECOVERY_WORK_DIR: z.string().trim().min(1).default('/var/lib/nexa/recovery'),
    /**
     * The ceiling on an uploaded archive, enforced on the STREAM.
     *
     * Not on `content-length`: a chunked request declares none, so a
     * header check would be advisory. The server counts what it writes and stops.
     *
     * Two gigabytes by default, which is well past Telegram's 50 MiB document
     * ceiling — the archives that need uploading are precisely the ones too large
     * to have been delivered, which an operator retrieved from the host.
     */
    RECOVERY_UPLOAD_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 * 1024 * 1024)
      .default(2 * 1024 * 1024 * 1024),
    /** How often the recovery executor asks whether a confirmed request exists. */
    RECOVERY_TICK_MS: z.coerce.number().int().min(1_000).max(600_000).default(15_000),
    /**
     * Where the recovery executor writes its heartbeat.
     *
     * Its OWN key, not the monitor's path with a suffix appended. Two roles
     * sharing a derived path is how a container healthcheck comes to read the
     * wrong file: the suffix is invisible in the compose file, and an operator
     * who changed the monitor's path would silently move this one too.
     */
    RECOVERY_HEARTBEAT_PATH: z.string().trim().min(1).default('/tmp/nexa-recovery.heartbeat'),
    /**
     * Whether an operator may upload an archive at all.
     *
     * On by default, and switchable off for an installation that would rather
     * restore only from its own retained runs. Reported through the capabilities
     * endpoint so the Web Admin says the feature is off rather than offering a
     * button the server refuses — which is the same rule as everywhere else here:
     * hiding what the server serves is the same defect as offering what it
     * refuses, seen from the other side.
     */
    RECOVERY_UPLOAD_ENABLED: booleanish.default(true),
    /**
     * How long a FINISHED recovery request row is kept.
     *
     * A year, matching `BACKUP_RUN_RETENTION_DAYS`, because the two answer the
     * same kind of question after an incident. A row that recorded a CUTOVER is
     * excluded from the sweep entirely and kept for ever: it is the only record
     * of what the displaced database is called.
     */
    RECOVERY_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(365),
    /**
     * How long a FINISHED backup run row is kept.
     *
     * A year, because the row is the only durable evidence that a backup was
     * taken, verified against a real restore, and delivered — and the question
     * "when did this installation last have a provably restorable backup"
     * is one asked after an incident, not during one. An annual cycle also
     * covers the audit window an operator is most likely to be asked about.
     *
     * It bounds the table rather than rationing it. At one scheduled backup a
     * day a year is about 365 rows of a few hundred bytes, so this is not a size
     * control; what it prevents is a table with no policy at all, which is the
     * state every table in the legacy system was in. A scripted manual backup
     * loop is the case where the bound does work.
     *
     * Four classes of row are NEVER removed whatever this says, and the
     * exclusions are in the query rather than here — see
     * `purgeFinishedBefore` and ADR-0027:
     *
     *   - a RUNNING row, which IS the installation's backup lock;
     *   - a row whose delivery outcome was never observed, which is unresolved
     *     external-effect evidence and the reason the run row exists at all;
     *   - the most recent SUCCEEDED row, which `lastSucceededAt()` reads to
     *     decide whether a backup is due;
     *   - the most recent row of any state, which is the one an operator is
     *     looking at when something has just gone wrong.
     *
     * The floor is a week: anything shorter would start deleting the history a
     * diagnosis needs while the diagnosis is still happening.
     */
    BACKUP_RUN_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(365),
    /** Response bytes kept from a panel. Reading stops the moment it is passed. */
    PANEL_HTTP_MAX_RESPONSE_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(8 * 1024 * 1024)
      .default(512 * 1024),
    /**
     * Whether a panel may live on this process's own loopback interface.
     *
     * FALSE in production, and the default matters: the API runs in a
     * container, so its loopback is itself — a panel URL pointing there
     * reaches Nexa's own internals rather than a panel, which is the classic
     * SSRF pivot. The integration suite sets it true to reach a local fake
     * server, which is the only legitimate use.
     */
    /**
     * A PEM bundle of extra certificate authorities to trust for panel calls.
     *
     * The self-hosted case: a panel behind an organisation's own CA presents a
     * certificate no public trust store knows. Without this the operator's only
     * routes are to disable verification, which this installation will not do,
     * or to obtain a public certificate for a machine that may not be reachable
     * from the internet.
     *
     * Additional, never instead of — the system trust store still applies and
     * verification stays on. Unset means ordinary public verification.
     */
    PANEL_HTTP_CA_FILE: z.string().min(1).optional(),
    /**
     * This installation's own data network, which a panel may never point at.
     *
     * Private space stays reachable — a self-hosted panel on `10.0.0.0/8` is
     * the ordinary case — but the API container shares a bridge network with
     * PostgreSQL and Redis, so without this an operator with `panels.edit`
     * could aim a panel at Nexa's own data subnet and read an open port off
     * the difference between failure kinds.
     *
     * Set by compose from `NEXA_DATA_SUBNET` in deploy.env — the same file and
     * the same expression that create the network — so the runtime learns the
     * subnet from the thing that owns it rather than from a copy an operator
     * has to keep in step. An installation whose nexa.env predates this key is
     * therefore protected on its first start under a compose file that passes
     * it, whatever subnet it uses. Optional only because a process run outside
     * compose (a developer's shell, a test) has no data network to name.
     */
    NEXA_DATA_SUBNET: z
      .string()
      .trim()
      .optional()
      .transform((value) => (value === '' ? undefined : value))
      .refine(
        (value) => value === undefined || CIDR.test(value),
        'NEXA_DATA_SUBNET must be a CIDR, for example 172.29.1.0/24.',
      ),
    /**
     * EXTRA networks a panel may never point at, beyond the installation's
     * own. Comma-separated CIDRs, empty by default: the installation subnet
     * is not configured here and cannot be removed here.
     */
    PANEL_HTTP_DENIED_SUBNETS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry !== ''),
      )
      .refine(
        (entries) => entries.every((entry) => CIDR.test(entry)),
        'PANEL_HTTP_DENIED_SUBNETS must be a comma-separated list of CIDRs, for example 10.99.0.0/24.',
      ),
    PANEL_HTTP_ALLOW_LOOPBACK: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    BUILD_VERSION: z.string().default('0.0.0-dev'),
    BUILD_COMMIT: z.string().default('unknown'),
    BUILD_TIME: z.string().default('unknown'),
  })
  .superRefine((config, ctx) => {
    // Parsed by the same function the container resolves with, so what an
    // operator is told at boot and what the process actually loads cannot
    // drift into two nearly-identical implementations.
    // --- Background monitoring: the cross-field safety rules ----------------
    //
    // Both of these protect an invariant a single field cannot express, and
    // both are refusals rather than clamps. A configuration that would defeat
    // the reason a protection exists should stop the process at boot, where
    // somebody is reading the message, and not be silently corrected into
    // something the operator did not ask for.
    if (config.PANEL_MONITOR_ENABLED) {
      // 0. A claimed tenant must be able to receive at least one candidate.
      //
      // `claimTenants` advances `last_served_at` for every tenant it claims,
      // and the due scan is then capped globally by the batch size. Claiming
      // two hundred tenants for a batch of one marks two hundred tenants as
      // served while one panel is probed, so the documented `ceil(d / t)`
      // fairness bound — the one the rotation exists to provide — is simply
      // false, and a two-hundred-tenant group needs about two hundred ticks
      // rather than one. Refused rather than clamped: an operator who asked
      // for both numbers should be told they contradict each other.
      if (config.PANEL_MONITOR_TENANTS_PER_TICK > config.PANEL_MONITOR_BATCH_SIZE) {
        ctx.addIssue({
          code: 'custom',
          path: ['PANEL_MONITOR_TENANTS_PER_TICK'],
          message:
            `PANEL_MONITOR_TENANTS_PER_TICK (${config.PANEL_MONITOR_TENANTS_PER_TICK}) exceeds ` +
            `PANEL_MONITOR_BATCH_SIZE (${config.PANEL_MONITOR_BATCH_SIZE}). A tick cannot give ` +
            `every claimed tenant a candidate, so claiming them spends their turn for nothing ` +
            `and the ceil(due tenants / tenants per tick) fairness bound does not hold.`,
        });
      }

      // 1. A healthy panel must stay inside the freshness window.
      //
      // Worst case is the interval, plus the deterministic anti-herd spread,
      // plus however long a panel that has just become eligible waits for a
      // tick to pick it up. Twelve minutes is fine at a thirty-second tick and
      // wrong at a ten-minute one, which is exactly why this cannot live on
      // either field alone.
      if (
        !healthyCadenceFitsFreshness(
          config.PANEL_MONITOR_HEALTHY_INTERVAL_MS,
          config.PANEL_MONITOR_TICK_MS,
        )
      ) {
        const ceiling = maxHealthyIntervalMs(config.PANEL_MONITOR_TICK_MS);
        ctx.addIssue({
          code: 'custom',
          path: ['PANEL_MONITOR_HEALTHY_INTERVAL_MS'],
          message:
            `PANEL_MONITOR_HEALTHY_INTERVAL_MS=${config.PANEL_MONITOR_HEALTHY_INTERVAL_MS} with ` +
            `PANEL_MONITOR_TICK_MS=${config.PANEL_MONITOR_TICK_MS} would let a healthy panel's ` +
            'health go stale before it is refreshed: the worst case is the interval, plus a tenth ' +
            'of it for the anti-herd spread, plus one tick of scheduling delay, and that must stay ' +
            `under PANEL_HEALTH_FRESH_FOR_MS. At this tick the interval must be at most ${ceiling}, ` +
            'or lower the tick.',
        });
      }
      // 1b. The healthy interval must outlast the per-panel cooldown floor.
      //
      // A cooldown longer than the interval is not a slow monitor; it is a monitor
      // that does not run. The scheduler finds each panel due, the per-panel claim
      // refuses every attempt with COOLDOWN, and the configured cadence is silently
      // not honoured while the process reports itself healthy.
      //
      // Reachable only since item E-2 multiplied the floor by the longest probe any
      // registered provider makes: at PANEL_HTTP_TIMEOUT_MS=120000 the floor is 480s
      // against a default interval of 180s, and nothing refused that. The number is
      // `effectiveProbeCooldownMs`, the same expression the container builds the
      // probe dependencies from, because a floor computed twice is a floor that
      // disagrees with itself.
      const cooldownFloor = effectiveProbeCooldownMs({
        configuredMs: config.PANEL_PROBE_COOLDOWN_MS,
        timeoutMs: config.PANEL_HTTP_TIMEOUT_MS,
        retries: PANEL_HTTP_RETRIES,
        requestsPerProbe: MAX_REQUESTS_PER_PROBE,
      });
      if (
        !healthyCadenceOutlastsCooldown(config.PANEL_MONITOR_HEALTHY_INTERVAL_MS, cooldownFloor)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['PANEL_MONITOR_HEALTHY_INTERVAL_MS'],
          message:
            `PANEL_MONITOR_HEALTHY_INTERVAL_MS=${config.PANEL_MONITOR_HEALTHY_INTERVAL_MS} is shorter ` +
            `than the per-panel probe cooldown this configuration obeys (${cooldownFloor}ms). The ` +
            'monitor would find every panel due and then refuse every probe as a cooldown, so the ' +
            'configured cadence would not be honoured and nothing would say so. The cooldown is the ' +
            'greater of PANEL_PROBE_COOLDOWN_MS and PANEL_HTTP_TIMEOUT_MS times the longest probe a ' +
            `registered provider makes (${String(MAX_REQUESTS_PER_PROBE)} requests): raise the ` +
            `interval to at least ${cooldownFloor}, or lower PANEL_HTTP_TIMEOUT_MS.`,
        });
      }
      // 2. An operator must always outrank the background loop for the last
      //    token of a tenant's outbound-probe budget.
      //
      // A zero reserve is that invariant switched off, and it is refused rather
      // than rounded up so nobody discovers later that monitoring quietly took
      // the manual lane's headroom.
      // 3. The reserve must leave the monitor a token it can actually reach.
      //
      // The floor rounds UP so a positive reserve is never silently zero — the
      // protection that keeps an operator's last manual probe available at
      // small capacities. The other side of it was unchecked: at
      // PANEL_PROBE_TENANT_LIMIT=1 with any positive percentage the floor is
      // the whole bucket, so every background attempt is refused AFTER it has
      // claimed the panel, and no panel of that tenant is ever monitored while
      // the process reports itself perfectly healthy. Both safety properties
      // are real; a bucket too small to hold both is a contradiction, and the
      // operator is told so rather than given a monitor that cannot monitor.
      const reserveFloor =
        config.PANEL_MONITOR_BUDGET_RESERVE_PERCENT === 0
          ? 0
          : Math.max(
              1,
              Math.ceil(
                (config.PANEL_PROBE_TENANT_LIMIT * config.PANEL_MONITOR_BUDGET_RESERVE_PERCENT) /
                  100,
              ),
            );
      if (config.PANEL_PROBE_TENANT_LIMIT - reserveFloor < 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['PANEL_PROBE_TENANT_LIMIT'],
          message:
            `PANEL_PROBE_TENANT_LIMIT=${config.PANEL_PROBE_TENANT_LIMIT} with ` +
            `PANEL_MONITOR_BUDGET_RESERVE_PERCENT=${config.PANEL_MONITOR_BUDGET_RESERVE_PERCENT} ` +
            `reserves all ${reserveFloor} token(s) for manual tests, leaving the monitor none. ` +
            `Every background probe would be refused after claiming its panel, so no panel of ` +
            `that tenant is ever monitored while the process reports itself healthy. Raise ` +
            `PANEL_PROBE_TENANT_LIMIT to at least ${reserveFloor + 1}, or set ` +
            `PANEL_MONITOR_ENABLED=false if this installation is deliberately not monitoring.`,
        });
      }

      // 4. The freshness promise is a THROUGHPUT promise too.
      //
      // `healthyCadenceFitsFreshness` above proves the cadence fits. It says
      // nothing about whether every panel can be probed on that cadence, which
      // the tenant's bucket decides — see `sustainableFreshPanels`. Reported
      // rather than refused: the supported population is a property of the
      // installation, not a mistake in it, and an operator with twenty panels
      // should not be stopped from booting by a bound they are nowhere near.
      // The monitor reports the tenants that exceed it at startup.

      if (config.PANEL_MONITOR_BUDGET_RESERVE_PERCENT === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['PANEL_MONITOR_BUDGET_RESERVE_PERCENT'],
          message:
            'PANEL_MONITOR_BUDGET_RESERVE_PERCENT=0 while PANEL_MONITOR_ENABLED=true would let ' +
            "background monitoring spend a tenant's last outbound probe, locking an operator out " +
            'of their own "Test connection". Set a positive percentage, or disable monitoring.',
        });
      }
    }

    const keyring = parseKeyring(config);
    if (!keyring.ok) {
      for (const problem of keyring.problems) {
        ctx.addIssue({ code: 'custom', path: ['SECRETS_KEYS'], message: problem });
      }
    }
    if (config.PANEL_HTTP_ALLOW_LOOPBACK && config.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['PANEL_HTTP_ALLOW_LOOPBACK'],
        message:
          "PANEL_HTTP_ALLOW_LOOPBACK is permitted only outside production. In production the API's " +
          'loopback interface is the API itself, so a panel URL pointing there reaches this ' +
          "installation's own internals rather than a panel.",
      });
    }
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
      // Parsed, not string-matched. An `includes('https')` accepts
      // `http://evil.example.com/?x=https://api.telegram.org`, and a
      // `startsWith('https')` rejects `HTTPS://api.telegram.org`, which is the
      // same scheme spelled differently. The protocol is a field; read the
      // field.
      //
      // Not silently rewritten to https either. A bot token travels in the URL
      // path of every Telegram call, so an http:// base means every send
      // publishes the credential to the network — and quietly "fixing" the
      // value would hide that somebody had configured it, which is worth
      // knowing about a deployment.
      let protocol: string | null;
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
    /*
     * TELEGRAM'S alphabet, not ours, and the reason it is checked HERE.
     *
     * `setWebhook` documents `secret_token` as 1-256 characters of `A-Za-z0-9_-`
     * and refuses anything else with a 400. A value this installation cannot
     * register is a value the webhook can never be authenticated with, so the
     * failure belongs at boot, next to the length rule, rather than at the one
     * moment an operator is standing at a half-finished install.
     *
     * This was not hypothetical. The installer minted the secret with plain
     * `base64`, whose alphabet includes `+` and `/` and whose 32-byte output
     * always ends in `=` — so every fresh installation would have produced a
     * secret Telegram rejects, and the installer's own INCOMPLETE summary would
     * have sent the operator to debug DNS for a character-set bug. The
     * generator is fixed; this is what stops the next one being wrong quietly.
     */
    if (
      config.TELEGRAM_WEBHOOK_ENABLED &&
      config.TELEGRAM_WEBHOOK_SECRET.length >= 16 &&
      !/^[A-Za-z0-9_-]{1,256}$/.test(config.TELEGRAM_WEBHOOK_SECRET)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['TELEGRAM_WEBHOOK_SECRET'],
        message:
          'TELEGRAM_WEBHOOK_SECRET may contain only A-Z, a-z, 0-9, underscore and hyphen, and at ' +
          'most 256 characters. Telegram refuses any other secret_token with a 400, so a webhook ' +
          'registered with one could never be authenticated. (The value itself is not shown.)',
      });
    }

    // Half-configured delivery is the failure worth catching here. Neither set
    // is a deliberate choice — the archive stays on the server and the run says
    // NOT_ATTEMPTED — but one set without the other is somebody who believes
    // their backups are being delivered and will find out otherwise during a
    // disaster.
    const chat = config.BACKUP_TELEGRAM_CHAT_ID !== '';
    const token = config.BACKUP_TELEGRAM_BOT_TOKEN !== '';
    if (chat !== token) {
      ctx.addIssue({
        code: 'custom',
        path: [chat ? 'BACKUP_TELEGRAM_BOT_TOKEN' : 'BACKUP_TELEGRAM_CHAT_ID'],
        message:
          'BACKUP_TELEGRAM_CHAT_ID and BACKUP_TELEGRAM_BOT_TOKEN must be set together. Set both to ' +
          'deliver backups to Telegram, or neither to retain them on the server; one alone is an ' +
          'installation that believes its backups are leaving the host and they are not.',
      });
    }
  });

export type AppConfig = z.infer<typeof configSchema>;

/**
 * Whether this installation reads v1 ciphertext — the one place that decides.
 *
 * An explicit `SECRETS_ACCEPT_V1` always wins, in both directions. What this
 * function is really for is the case where the setting is ABSENT, which is not
 * a rare edge: every host installed before the setting existed has no such line
 * in `/etc/nexa/nexa.env`, and a flat `default('true')` therefore meant "on"
 * for the entire installed base with nobody having chosen it.
 *
 * The default is keyed on the keyring's configuration format, because that is
 * the only evidence on a host about which era it came from:
 *
 *   - `SECRETS_KEYS` (canonical) can only have been written by a keyring-era
 *     installer or by `botctl secrets migrate-config`. Both are v2-era, so the
 *     safe default is OFF.
 *   - `SECRETS_KEK` (legacy) can only have been written by an installer that
 *     shipped before v2 existed. That is exactly the population that may still
 *     hold v1 rows, so the default there stays ON — turning it off underneath
 *     them would make an installation unable to read its own secrets, which is
 *     an outage caused by an upgrade nobody asked to change behaviour.
 *
 * It is not a silent fallback: `secrets status` prints the format and the
 * resulting acceptance, and `secrets shutdown-check` refuses to call a
 * legacy-configured host ready.
 *
 * Takes the parsed keyring rather than re-deriving the format, so there is one
 * implementation of "which spelling is this host using".
 */
export function acceptsV1(
  config: Pick<AppConfig, 'SECRETS_ACCEPT_V1'>,
  keyring: Pick<SecretKeyring, 'format'>,
): boolean {
  if (config.SECRETS_ACCEPT_V1 !== undefined) return config.SECRETS_ACCEPT_V1 === 'true';
  return keyring.format === 'legacy';
}
