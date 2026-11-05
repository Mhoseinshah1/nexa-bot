import { z } from 'zod';
import { capacityLimitSchema, CAPACITY_RESOURCES, type CapacityLimitView } from './capacity.js';
import { adminDisplayNameSchema, adminPasswordSchema, adminUsernameSchema } from './identity.js';
import { secondFactorProofSchema } from './admin-security.js';
import type { BotInstanceStatus, TenantStatus } from './tenant.js';

/**
 * Phase 6A PR-3 (D1) — the creator panel, «میزبانی‌ها».
 *
 * One Nexa installation hosts the owner's own bot (the installation's PRIMARY tenant) and a
 * Nexa bot for anyone the owner chooses. Each hosted bot is a full, independent Nexa: a
 * tenant of kind `HOSTED`, child of the installation tenant, with its own Telegram bot, Web
 * Admin, panels, gateways, products, customers and ops group. It is NOT a reseller sub-tenant
 * (`RESELLER_BOT`): a reseller bot sells its parent's catalogue, a hosted bot shares nothing
 * but the server. Billing is out of scope.
 *
 * The section is the installation owner's only (`hosting.manage` in the installation tenant,
 * held through the system `owner` role), and behind its OWN second factor: a TOTP factor and
 * recovery codes separate from the Web Admin sign-in factor, a 12-hour section session bound
 * to the Web Admin session it was opened from, and a fresh code on every sensitive action.
 */

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/**
 * A hosted bot's lifecycle. `SUSPENDED` is the owner's hand, `EXPIRED` the expiry sweep's;
 * `DELETED` is soft (every row kept, restorable); `PURGED` is terminal.
 */
export const HOSTED_BOT_STATES = ['ACTIVE', 'SUSPENDED', 'EXPIRED', 'DELETED', 'PURGED'] as const;
export type HostedBotState = (typeof HOSTED_BOT_STATES)[number];

/**
 * The tenant status each state holds the hosted tenant at, written in the same transaction.
 *
 * The TENANT row is what stops the bot: `ScopeActivityReader` (every write path, inside its
 * transaction), the Telegram webhook, Web Admin sign-in and every authenticated request all
 * refuse a tenant that is not `ACTIVE`. The hosted state only says why.
 */
export const HOSTED_BOT_TENANT_STATUS: Readonly<Record<HostedBotState, TenantStatus>> = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'STOPPED',
  EXPIRED: 'STOPPED',
  DELETED: 'DISABLED',
  PURGED: 'DISABLED',
};

/** The action a state change was. */
export const HOSTED_BOT_ACTIONS = ['SUSPEND', 'ACTIVATE', 'DELETE', 'PURGE', 'EXPIRE'] as const;
export type HostedBotAction = (typeof HOSTED_BOT_ACTIONS)[number];

/** Which states each action may start from. Anything else is `hosting.state_conflict`. */
export const HOSTED_BOT_TRANSITIONS: Readonly<
  Record<HostedBotAction, { readonly from: readonly HostedBotState[]; readonly to: HostedBotState }>
> = {
  SUSPEND: { from: ['ACTIVE', 'EXPIRED'], to: 'SUSPENDED' },
  ACTIVATE: { from: ['SUSPENDED', 'EXPIRED', 'DELETED'], to: 'ACTIVE' },
  DELETE: { from: ['ACTIVE', 'SUSPENDED', 'EXPIRED'], to: 'DELETED' },
  PURGE: { from: ['DELETED'], to: 'PURGED' },
  EXPIRE: { from: ['ACTIVE'], to: 'EXPIRED' },
};

export const HOSTING_FACTOR_STATES = ['NONE', 'PENDING', 'ACTIVE'] as const;
export type HostingFactorState = (typeof HOSTING_FACTOR_STATES)[number];

// ---------------------------------------------------------------------------
// The section's second factor
// ---------------------------------------------------------------------------

/** How long one opened section session lasts. Separate from the Web Admin session. */
export const HOSTING_SECTION_SESSION_TTL_SECONDS = 12 * 60 * 60;
/** Consecutive wrong codes (TOTP or recovery) before the section's codes are locked. */
export const HOSTING_CODE_MAX_FAILURES = 5;
/** How long a lock lasts. */
export const HOSTING_CODE_LOCKOUT_SECONDS = 15 * 60;
/** How long a pending enrolment waits for its first code. */
export const HOSTING_ENROLMENT_TTL_SECONDS = 15 * 60;
/** Recovery codes per generation. */
export const HOSTING_RECOVERY_CODE_COUNT = 10;
/** The issuer an authenticator app shows: distinct from the Web Admin sign-in factor's. */
export const HOSTING_TOTP_ISSUER = 'Nexa Hosting';

/** The section session's cookie, in the Web Admin session cookie's two spellings. */
export const HOSTING_SESSION_COOKIE_NAME = 'nexa_hosting';
export const HOSTING_SESSION_COOKIE_NAME_SECURE = `__Host-${HOSTING_SESSION_COOKIE_NAME}` as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const HOSTING_ERROR_CODES = {
  /** Not the installation owner (another tenant's admin, a non-owner admin, a job). */
  OWNER_ONLY: 'hosting.owner_only',
  /** No active section factor yet: enrol first. */
  SECOND_FACTOR_REQUIRED: 'hosting.second_factor_required',
  /** A section factor is already active (enrolling again needs none). */
  SECOND_FACTOR_ACTIVE: 'hosting.second_factor_active',
  /** The pending enrolment is gone or older than its TTL: enrol again. */
  ENROLMENT_EXPIRED: 'hosting.enrolment_expired',
  /** No open section session for this Web Admin session, or it ran out. */
  SECTION_SESSION_REQUIRED: 'hosting.section_session_required',
  /** The code was not accepted (wrong, replayed, or an unknown recovery code). */
  CODE_REJECTED: 'hosting.code_rejected',
  /** Too many wrong codes: locked until `lockedUntil`. */
  CODE_ATTEMPTS_LOCKED: 'hosting.code_attempts_locked',
  BOT_NOT_FOUND: 'hosting.bot_not_found',
  /** The action cannot start from the bot's current state. */
  STATE_CONFLICT: 'hosting.state_conflict',
  /** Activating needs an expiry in the future (or none). */
  EXPIRY_PASSED: 'hosting.expiry_passed',
  SLUG_TAKEN: 'hosting.slug_taken',
  /** Creating hosted bots is closed on this installation (the release gate). */
  CREATE_DISABLED: 'hosting.create_disabled',
  /** The typed confirmation did not match the bot's slug. */
  PURGE_CONFIRMATION_MISMATCH: 'hosting.purge_confirmation_mismatch',
  /** «ورود به پنل» is designed for 6B and not built yet. */
  ENTER_NOT_IMPLEMENTED: 'hosting.enter_not_implemented',
} as const;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** Under `API_PREFIX`. `:tenantId` is the hosted bot's tenant id. */
export const HOSTING_ROUTES = {
  status: '/hosting/status',
  enrol: '/hosting/2fa/enrol',
  activate: '/hosting/2fa/activate',
  recoveryCodes: '/hosting/2fa/recovery-codes',
  openSession: '/hosting/session',
  closeSession: '/hosting/session/close',
  bots: '/hosting/bots',
  suspend: '/hosting/bots/:tenantId/suspend',
  activateBot: '/hosting/bots/:tenantId/activate',
  delete: '/hosting/bots/:tenantId/delete',
  purgePreview: '/hosting/bots/:tenantId/purge-preview',
  purge: '/hosting/bots/:tenantId/purge',
  expiry: '/hosting/bots/:tenantId/expiry',
  limits: '/hosting/limits',
  setLimit: '/hosting/bots/:tenantId/limits',
  enter: '/hosting/bots/:tenantId/enter',
  server: '/hosting/server',
} as const;

const idempotencyKey = z.string().min(8).max(255);
const isoInstant = z.iso.datetime({ offset: true });
/** A tenant slug: lowercase, URL-safe, the same alphabet the seeds use. */
export const hostedBotSlugSchema = z
  .string()
  .trim()
  .min(3)
  .max(48)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, digits and inner hyphens');

/** A fresh second-factor proof: a current TOTP code OR an unused recovery code. */
export const hostingProofSchema = secondFactorProofSchema;
export type HostingProof = z.infer<typeof hostingProofSchema>;

export const hostingEnrolRequestSchema = z.object({ password: z.string().min(1).max(1024) });
export const hostingActivateRequestSchema = z.object({
  code: z
    .string()
    .transform((value) => value.replace(/\s+/g, ''))
    .pipe(z.string().regex(/^[0-9]{6}$/)),
});
export const hostingOpenSessionRequestSchema = z.object({ proof: hostingProofSchema });
export const hostingRecoveryCodesRequestSchema = z.object({ proof: hostingProofSchema });

export const hostedBotCreateRequestSchema = z.object({
  idempotencyKey,
  proof: hostingProofSchema,
  slug: hostedBotSlugSchema,
  displayName: z.string().trim().min(1).max(120),
  /** The hosted bot's first Web Admin owner. */
  adminUsername: adminUsernameSchema,
  adminDisplayName: adminDisplayNameSchema,
  /** Chosen by the creator and handed over by them; never returned, never in the request hash. */
  adminPassword: adminPasswordSchema,
  /** `null` = no expiry. */
  expiresAt: isoInstant.nullable(),
});
export type HostedBotCreateRequest = z.infer<typeof hostedBotCreateRequestSchema>;

export const hostedBotActionRequestSchema = z.object({
  idempotencyKey,
  proof: hostingProofSchema,
  /** Recorded on the audit row; optional. */
  reason: z.string().trim().min(1).max(500).optional(),
});
export type HostedBotActionRequest = z.infer<typeof hostedBotActionRequestSchema>;

export const hostedBotExpiryRequestSchema = z.object({
  idempotencyKey,
  proof: hostingProofSchema,
  /** A manual date; `null` (the field emptied) = no expiry. */
  expiresAt: isoInstant.nullable(),
});

export const hostedBotPurgeRequestSchema = z.object({
  idempotencyKey,
  proof: hostingProofSchema,
  /** The bot's slug, typed by the owner: the proportional confirmation. */
  confirmSlug: z.string().trim().min(1).max(64),
});

export const hostedBotSetLimitRequestSchema = z.object({
  idempotencyKey,
  proof: hostingProofSchema,
  resource: z.enum(CAPACITY_RESOURCES),
  /** `null` = back to the tier default; `{mode:'UNLIMITED'}` = «نامحدود». */
  limit: capacityLimitSchema.nullable(),
});

export const hostedBotEnterRequestSchema = z.object({ proof: hostingProofSchema });

/** Why creating is closed, or null when it is open. */
export const HOSTING_CREATE_REFUSALS = ['FLAG_OFF', 'PRODUCTION_NOT_RELEASED'] as const;
export type HostingCreateRefusal = (typeof HOSTING_CREATE_REFUSALS)[number];

export interface HostingStatusResponse {
  readonly factor: HostingFactorState;
  readonly recoveryCodesRemaining: number;
  /** The open section session for THIS Web Admin session, or null. */
  readonly session: { readonly expiresAt: string } | null;
  /** While the section's codes are locked after wrong guesses. */
  readonly lockedUntil: string | null;
  readonly create: { readonly enabled: boolean; readonly refusal: HostingCreateRefusal | null };
}

export interface HostingEnrolResponse {
  /** Shown once. */
  readonly secret: string;
  readonly otpauthUri: string;
  readonly qrPngDataUrl: string | null;
  readonly expiresAt: string;
  readonly parameters: {
    readonly algorithm: string;
    readonly digits: number;
    readonly periodSeconds: number;
  };
}

export interface HostingActivateResponse {
  /** Shown once. */
  readonly recoveryCodes: readonly string[];
  readonly session: { readonly expiresAt: string };
}

export interface HostingSessionResponse {
  readonly session: { readonly expiresAt: string };
}

export interface HostingRecoveryCodesResponse {
  readonly recoveryCodes: readonly string[];
}

export interface HostedBotResourceView {
  readonly limit: CapacityLimitView;
  /**
   * The owner's pressure alerts about this bot and limit in the last 24 h
   * (`capacity.bot_limit_pressure`: each one is 50+ hits within 5 minutes). 0 = no pressure.
   */
  readonly pressureAlertsLast24h: number;
}

export interface HostedBotView {
  readonly tenantId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly state: HostedBotState;
  readonly tenantStatus: TenantStatus;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly stateChangedAt: string;
  readonly deletedAt: string | null;
  readonly purgedAt: string | null;
  readonly customerCount: number;
  /** The hosted bot's first Web Admin owner, by username. Never a credential. */
  readonly webAdmin: { readonly username: string } | null;
  /** The hosted tenant's Telegram bot, once its owner connected one. */
  readonly telegramBot: { readonly username: string; readonly status: BotInstanceStatus } | null;
  /**
   * The newest SUCCEEDED installation backup finished after this bot was created (the
   * backup is installation-wide: one dump holds every bot), or null.
   */
  readonly lastBackupAt: string | null;
  readonly resources: readonly HostedBotResourceView[];
}

export interface HostedBotsResponse {
  readonly bots: readonly HostedBotView[];
  readonly create: { readonly enabled: boolean; readonly refusal: HostingCreateRefusal | null };
}

export interface HostedBotResponse {
  readonly bot: HostedBotView;
  readonly replayed: boolean;
}

export interface HostedBotPurgePreviewResponse {
  readonly tenantId: string;
  /** What the owner must type. */
  readonly confirmSlug: string;
  readonly counts: {
    readonly customers: number;
    readonly orders: number;
    readonly services: number;
    readonly payments: number;
    readonly admins: number;
  };
}

export interface HostedBotPurgeResponse extends HostedBotResponse {
  /**
   * `PENDING`: the tenant is closed for good (sessions revoked, bots disabled) and its rows
   * stay until the erasure job (6B) removes them; nothing can reopen it.
   */
  readonly erasure: 'PENDING';
}

export interface HostingServerResponse {
  readonly measuredAt: string;
  readonly cpu: {
    readonly cores: number;
    readonly loadAverage1m: number;
    /** 1-minute load as a percent of the cores. */
    readonly loadPercent: number;
  };
  readonly memory: { readonly totalBytes: number; readonly availableBytes: number | null };
  readonly disks: readonly {
    readonly path: string;
    readonly totalBytes: number;
    readonly availableBytes: number;
    readonly usedPercent: number;
  }[];
  readonly estimate: HostingCapacityEstimate;
}

/**
 * How many more hosted bots fit, from `docs/capacity/after-guards.md`: one API process holds
 * about 75 concurrently active customers at p95 < 1 s with the nightly backup and a broadcast
 * running, on 4 vCPU; the owner's bot keeps 25 of them. Formula:
 *
 *   budget   = floor(75 × min(1, cores / 4))
 *   used     = 25 (owner) + Σ live hosted bots × 1 (a small bot's peak)
 *   headroom = max(0, budget − used)
 *   more     = { small: headroom ÷ 1, medium: ⌊headroom ÷ 3⌋, large: ⌊headroom ÷ 10⌋ }
 *
 * and 0 while free memory is under the owner's alert floor or a disk is at 90 % or more.
 */
export interface HostingCapacityEstimate {
  readonly formula: string;
  readonly budgetConcurrentCustomers: number;
  readonly ownerReserved: number;
  readonly liveHostedBots: number;
  readonly headroom: number;
  readonly moreSmallBots: number;
  readonly moreMediumBots: number;
  readonly moreLargeBots: number;
  readonly blockedBy: 'MEMORY' | 'DISK' | null;
}
