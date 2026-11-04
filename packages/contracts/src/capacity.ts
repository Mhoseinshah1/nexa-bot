import { z } from 'zod';

/**
 * Phase 6A PR-2 — capacity guards: what one installation shares between its bots.
 *
 * One Nexa installation on one server hosts the owner's own bot (the installation's PRIMARY
 * tenant) beside many hosted bots (every other tenant). Each resource below is a per-bot
 * (per-tenant) limit the OWNER sets. A bot that reaches a limit is only SLOWER — its work
 * waits in its own queue, or Telegram is asked to deliver again — never lost, and never at
 * another bot's expense. `docs/capacity/after-guards.md` is the reasoning and the numbers.
 *
 * Two tiers decide the defaults: `INSTALLATION` is the owner's own bot (the tenant whose
 * kind is `PRIMARY`), `HOSTED` is every other tenant. A stored limit overrides the default
 * of its tenant's tier; deleting it returns to the default.
 *
 * The `INSTALLATION_*` resources are not per bot: they are knobs of the one server, stored
 * on the installation tenant only, and refused for any other tenant.
 */

export const CAPACITY_TIERS = ['INSTALLATION', 'HOSTED'] as const;
export type CapacityTier = (typeof CAPACITY_TIERS)[number];

export const CAPACITY_RESOURCES = [
  /** Customer updates processed at once for this bot; the excess waits in the bot's queue. */
  'UPDATE_CONCURRENCY',
  /** This bot's share of a process's database pool: its turns inside the database at once. */
  'DB_CONNECTIONS',
  /** Turns this bot gets in each round of the background lanes (outbox, notifications). */
  'JOB_TURN_WEIGHT',
  /** Broadcast messages per second. "Unlimited" is Telegram's own per-bot ceiling. */
  'BROADCAST_PER_SECOND',
  /** Place in the installation-wide heavy-job queue: 1 is the front, 0 waits its turn. */
  'HEAVY_JOB_PRIORITY',
  /** New customers (a first `/start` or first contact) admitted per minute. */
  'NEW_CUSTOMERS_PER_MINUTE',
  /** Support AI requests per calendar month (UTC). */
  'SUPPORT_AI_MONTHLY_REQUESTS',
  /** The bot's stored media, in MB. */
  'STORAGE_MB',
  /** Installation: heavy jobs (backup, import, export, large report) run at once, 1 or 2. */
  'INSTALLATION_HEAVY_JOB_CONCURRENCY',
  /** Installation: a heavy job waits while the server's free memory is below this, in MB. */
  'INSTALLATION_HEAVY_JOB_MIN_FREE_MEMORY_MB',
  /** Installation: the owner is alerted while free memory is below this, in MB. */
  'INSTALLATION_ALERT_MIN_FREE_MEMORY_MB',
  /** Installation: the owner is alerted while the worker's queue lag is above this, in s. */
  'INSTALLATION_ALERT_WORKER_LAG_SECONDS',
] as const;
export type CapacityResource = (typeof CAPACITY_RESOURCES)[number];

export const CAPACITY_LIMIT_MODES = ['LIMITED', 'UNLIMITED'] as const;
export type CapacityLimitMode = (typeof CAPACITY_LIMIT_MODES)[number];

/** A limit: a number, or «نامحدود». Never a sentinel number for "no limit". */
export type CapacityLimit =
  { readonly mode: 'LIMITED'; readonly value: number } | { readonly mode: 'UNLIMITED' };

export const capacityLimitSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('LIMITED'), value: z.number().int().min(0) }),
  z.object({ mode: z.literal('UNLIMITED') }),
]);

export interface CapacityResourceRule {
  readonly min: number;
  readonly max: number;
  /** Whether «نامحدود» is a value this resource can take. */
  readonly allowsUnlimited: boolean;
  /** An installation knob: stored on the installation tenant only. */
  readonly installationOnly: boolean;
  /**
   * Whether this release enforces it (`ACTIVE`) or only stores it (`PLANNED`), the
   * settings registry's rule (`SETTING_CONSUMERS`): a surface must be able to say a value
   * changes nothing yet rather than answer "saved" and leave the owner to find out.
   */
  readonly consumer: 'ACTIVE' | 'PLANNED';
  readonly defaults: Readonly<Record<CapacityTier, CapacityLimit>>;
}

const limited = (value: number): CapacityLimit => ({ mode: 'LIMITED', value });
const UNLIMITED: CapacityLimit = { mode: 'UNLIMITED' };

/** Telegram's own ceiling on one bot's messages per second; "unlimited" broadcast means this. */
export const TELEGRAM_BOT_MESSAGES_PER_SECOND_CEILING = 30;

/**
 * The owner's table (phase 6A PR-2), binding. A rule's `defaults.HOSTED` is what every
 * hosted bot gets until the owner says otherwise; `defaults.INSTALLATION` is the owner's own.
 */
export const CAPACITY_RESOURCE_RULES: Readonly<Record<CapacityResource, CapacityResourceRule>> = {
  UPDATE_CONCURRENCY: {
    min: 1,
    max: 1_000,
    allowsUnlimited: true,
    installationOnly: false,
    consumer: 'ACTIVE',
    defaults: { HOSTED: limited(8), INSTALLATION: UNLIMITED },
  },
  DB_CONNECTIONS: {
    min: 1,
    max: 100,
    allowsUnlimited: true,
    installationOnly: false,
    consumer: 'ACTIVE',
    defaults: { HOSTED: limited(3), INSTALLATION: UNLIMITED },
  },
  JOB_TURN_WEIGHT: {
    min: 1,
    max: 10,
    allowsUnlimited: false,
    installationOnly: false,
    consumer: 'ACTIVE',
    defaults: { HOSTED: limited(1), INSTALLATION: limited(2) },
  },
  BROADCAST_PER_SECOND: {
    min: 1,
    max: TELEGRAM_BOT_MESSAGES_PER_SECOND_CEILING,
    allowsUnlimited: true,
    installationOnly: false,
    consumer: 'ACTIVE',
    defaults: { HOSTED: limited(10), INSTALLATION: limited(25) },
  },
  HEAVY_JOB_PRIORITY: {
    min: 0,
    max: 1,
    allowsUnlimited: false,
    installationOnly: false,
    consumer: 'ACTIVE',
    defaults: { HOSTED: limited(0), INSTALLATION: limited(1) },
  },
  NEW_CUSTOMERS_PER_MINUTE: {
    min: 1,
    max: 100_000,
    allowsUnlimited: true,
    installationOnly: false,
    consumer: 'ACTIVE',
    defaults: { HOSTED: limited(60), INSTALLATION: UNLIMITED },
  },
  SUPPORT_AI_MONTHLY_REQUESTS: {
    min: 0,
    max: 10_000_000,
    allowsUnlimited: true,
    installationOnly: false,
    consumer: 'PLANNED',
    defaults: { HOSTED: limited(1_000), INSTALLATION: UNLIMITED },
  },
  STORAGE_MB: {
    min: 1,
    max: 1_000_000,
    allowsUnlimited: true,
    installationOnly: false,
    consumer: 'PLANNED',
    defaults: { HOSTED: limited(200), INSTALLATION: UNLIMITED },
  },
  INSTALLATION_HEAVY_JOB_CONCURRENCY: {
    min: 1,
    max: 2,
    allowsUnlimited: false,
    installationOnly: true,
    consumer: 'ACTIVE',
    defaults: { HOSTED: limited(1), INSTALLATION: limited(1) },
  },
  INSTALLATION_HEAVY_JOB_MIN_FREE_MEMORY_MB: {
    min: 0,
    max: 65_536,
    allowsUnlimited: false,
    installationOnly: true,
    consumer: 'ACTIVE',
    defaults: { HOSTED: limited(768), INSTALLATION: limited(768) },
  },
  INSTALLATION_ALERT_MIN_FREE_MEMORY_MB: {
    min: 0,
    max: 65_536,
    allowsUnlimited: false,
    installationOnly: true,
    consumer: 'ACTIVE',
    defaults: { HOSTED: limited(512), INSTALLATION: limited(512) },
  },
  INSTALLATION_ALERT_WORKER_LAG_SECONDS: {
    min: 10,
    max: 86_400,
    allowsUnlimited: false,
    installationOnly: true,
    consumer: 'ACTIVE',
    defaults: { HOSTED: limited(300), INSTALLATION: limited(300) },
  },
};

/** Why a limit cannot be stored for a resource, or null when it can. Pure. */
export function capacityLimitProblem(
  resource: CapacityResource,
  limit: CapacityLimit,
  tier: CapacityTier,
): 'UNLIMITED_NOT_ALLOWED' | 'OUT_OF_RANGE' | 'INSTALLATION_ONLY' | null {
  const rule = CAPACITY_RESOURCE_RULES[resource];
  if (rule.installationOnly && tier !== 'INSTALLATION') return 'INSTALLATION_ONLY';
  if (limit.mode === 'UNLIMITED') return rule.allowsUnlimited ? null : 'UNLIMITED_NOT_ALLOWED';
  return limit.value < rule.min || limit.value > rule.max ? 'OUT_OF_RANGE' : null;
}

/** The limit in force: the stored one, else the tier's default. Pure. */
export function effectiveCapacityLimit(
  resource: CapacityResource,
  tier: CapacityTier,
  stored: CapacityLimit | null | undefined,
): CapacityLimit {
  return stored ?? CAPACITY_RESOURCE_RULES[resource].defaults[tier];
}

/** A limit as a number, with «نامحدود» as `Infinity`: for comparisons only, never stored. */
export function capacityLimitNumber(limit: CapacityLimit): number {
  return limit.mode === 'UNLIMITED' ? Number.POSITIVE_INFINITY : limit.value;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const CAPACITY_ERROR_CODES = {
  /**
   * This bot already has as many customer updates waiting as it may queue. Answered to
   * Telegram as a retryable non-2xx with nothing written, so Telegram delivers it again.
   */
  UPDATE_QUEUE_FULL: 'capacity.update_queue_full',
  /** This bot has admitted as many new customers this minute as it may. Same answer. */
  NEW_CUSTOMER_RATE: 'capacity.new_customer_rate',
  /** The limit is not one this resource can take (range, «نامحدود», installation-only). */
  LIMIT_INVALID: 'capacity.limit_invalid',
  /** Capacity limits are the installation owner's: only from the installation's own admin. */
  OWNER_ONLY: 'capacity.owner_only',
} as const;

// ---------------------------------------------------------------------------
// Operational events (owner only: recorded on the installation tenant)
// ---------------------------------------------------------------------------

/** A hosted bot keeps reaching one of its limits: one row per bot and resource per window. */
export const CAPACITY_BOT_LIMIT_PRESSURE_CODE = 'capacity.bot_limit_pressure';
export const CAPACITY_DISK_WARNING_CODE = 'capacity.disk_warning';
export const CAPACITY_DISK_WARNING_CLEARED_CODE = 'capacity.disk_warning_cleared';
export const CAPACITY_DISK_CRITICAL_CODE = 'capacity.disk_critical';
export const CAPACITY_DISK_CRITICAL_CLEARED_CODE = 'capacity.disk_critical_cleared';
export const CAPACITY_MEMORY_LOW_CODE = 'capacity.memory_low';
export const CAPACITY_MEMORY_OK_CODE = 'capacity.memory_ok';
export const CAPACITY_WORKER_LAG_CODE = 'capacity.worker_lag_growing';
export const CAPACITY_WORKER_LAG_OK_CODE = 'capacity.worker_lag_ok';
/** A heavy job was held back because free memory was below the threshold. */
export const CAPACITY_HEAVY_JOB_DEFERRED_CODE = 'capacity.heavy_job_deferred';

/** The disk thresholds the owner set (percent of the volume used). */
export const CAPACITY_DISK_WARNING_PERCENT = 80;
export const CAPACITY_DISK_CRITICAL_PERCENT = 90;

/** Heavy jobs: what waits in the one installation-wide queue. */
export const HEAVY_JOB_KINDS = ['BACKUP', 'IMPORT', 'EXPORT', 'REPORT'] as const;
export type HeavyJobKind = (typeof HEAVY_JOB_KINDS)[number];
export const HEAVY_JOB_STATES = ['QUEUED', 'RUNNING', 'DONE', 'ABANDONED'] as const;
export type HeavyJobState = (typeof HEAVY_JOB_STATES)[number];

// ---------------------------------------------------------------------------
// HTTP (owner only; the creator panel's page is PR-3)
// ---------------------------------------------------------------------------

export const CAPACITY_ROUTES = {
  list: '/capacity/limits',
  set: '/capacity/limits/set',
} as const;

export interface CapacityLimitView {
  readonly resource: CapacityResource;
  /** The limit in force. */
  readonly limit: CapacityLimit;
  /** Whether it is the owner's own value (`STORED`) or the tier's (`DEFAULT`). */
  readonly source: 'STORED' | 'DEFAULT';
  readonly defaultLimit: CapacityLimit;
  readonly min: number;
  readonly max: number;
  readonly allowsUnlimited: boolean;
  /** `PLANNED`: stored and shown, not yet enforced by this release. */
  readonly consumer: 'ACTIVE' | 'PLANNED';
}

export interface CapacityTenantView {
  readonly tenantId: string;
  readonly displayName: string;
  readonly tier: CapacityTier;
  readonly limits: readonly CapacityLimitView[];
}

export interface CapacityLimitsResponse {
  readonly tenants: readonly CapacityTenantView[];
}

export const capacitySetLimitRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  tenantId: z.string().uuid(),
  resource: z.enum(CAPACITY_RESOURCES),
  /** `null` deletes the stored value: the tier's default is in force again. */
  limit: capacityLimitSchema.nullable(),
});
export type CapacitySetLimitRequest = z.infer<typeof capacitySetLimitRequestSchema>;

export interface CapacitySetLimitResponse {
  readonly tenant: CapacityTenantView;
  readonly replayed: boolean;
}
