import { z } from 'zod';
import { BOT_INSTANCE_STATUSES, TENANT_KINDS, type BotInstanceStatus } from './tenant.js';

/**
 * WP13 — managing this installation's Telegram bot instances from the Web Admin
 * (`docs/wp13-bots-management-audit.md`).
 *
 * What it covers is exactly what the architecture can truthfully support: reading a
 * bot's recorded state, stopping and starting it, replacing its token for the SAME
 * bot, and asking Telegram what it currently holds. What it deliberately does not
 * cover — adding a bot, repointing one to another tenant, registering a webhook — is
 * recorded in the audit with the decision that rules each out.
 */

/**
 * The statuses an operator may put a bot into.
 *
 * `DISABLED` is a declared status and NOT one of these. Nothing in this codebase writes
 * it and its meaning beyond "not ACTIVE" is not recorded (`OQ-WP13-01`), so the Web
 * Admin neither sets it nor clears it — clearing a state whose purpose nobody wrote
 * down is a guess about why it was set.
 */
export const BOT_OPERATOR_STATUSES = [
  'ACTIVE',
  'STOPPED',
] as const satisfies readonly BotInstanceStatus[];
export type BotOperatorStatus = (typeof BOT_OPERATOR_STATUSES)[number];

/**
 * Whether the webhook was registered with the secret this API process holds NOW.
 *
 * A comparison result, never the digest: the question an operator has is "is this the
 * same secret", and the answer needs no copy of anything derived from it.
 *
 * `UNKNOWN` is a row that predates the fingerprint column; it is never read as a match.
 * `NOT_CONFIGURED` is an installation with no `TELEGRAM_WEBHOOK_SECRET` at all.
 */
export const BOT_WEBHOOK_SECRET_STATES = [
  'MATCHES',
  'DIFFERS',
  'UNKNOWN',
  'NOT_CONFIGURED',
] as const;
export type BotWebhookSecretState = (typeof BOT_WEBHOOK_SECRET_STATES)[number];

/** Whether Telegram was last given the command menu this release would send. */
export const BOT_COMMAND_MENU_STATES = ['CURRENT', 'STALE', 'UNKNOWN'] as const;
export type BotCommandMenuState = (typeof BOT_COMMAND_MENU_STATES)[number];

/**
 * What the recorded state says about receiving updates, from the row and this
 * process's configuration alone.
 *
 * `REGISTERED`, not "receiving": the API process does not know the public origin the
 * webhook should point at (ADR-0029), so it cannot confirm the URL is right — only that
 * a registration was accepted with the current secret. The live check asks Telegram.
 */
export const BOT_READINESS_STATES = ['REGISTERED', 'NOT_REGISTERED', 'HELD'] as const;
export type BotReadinessState = (typeof BOT_READINESS_STATES)[number];

/**
 * Every reason a bot is not `REGISTERED`, in the order an operator can act on them.
 *
 * The first three HOLD the bot whatever its registration says — the route refuses every
 * update — and they are ordered as the bootstrap orders them (webhook route, tenant,
 * bot), so the Web Admin and `botctl telegram status` name the same first cause.
 */
export const BOT_READINESS_CAUSES = [
  'WEBHOOK_ROUTE_DISABLED',
  'TENANT_INACTIVE',
  'BOT_NOT_ACTIVE',
  'WEBHOOK_NEVER_REGISTERED',
  'WEBHOOK_SECRET_CHANGED',
  'WEBHOOK_SECRET_UNKNOWN',
] as const;
export type BotReadinessCause = (typeof BOT_READINESS_CAUSES)[number];

/** The causes that make a bot `HELD` rather than merely `NOT_REGISTERED`. */
export const BOT_HOLDING_CAUSES = [
  'WEBHOOK_ROUTE_DISABLED',
  'TENANT_INACTIVE',
  'BOT_NOT_ACTIVE',
] as const satisfies readonly BotReadinessCause[];

/** What `getMe` answered in a live check. The same four outcomes the bootstrap names. */
export const BOT_IDENTITY_CHECK_OUTCOMES = [
  'IDENTIFIED',
  'REJECTED',
  'NOT_TELEGRAM',
  'UNREACHABLE',
] as const;
export type BotIdentityCheckOutcome = (typeof BOT_IDENTITY_CHECK_OUTCOMES)[number];

/**
 * What `getWebhookInfo` answered. `SKIPPED` when `getMe` did not identify the bot: a
 * token Telegram refuses cannot read the registration either, and asking would report
 * the same refusal twice as two findings.
 */
export const BOT_WEBHOOK_CHECK_OUTCOMES = ['READ', 'REJECTED', 'UNREACHABLE', 'SKIPPED'] as const;
export type BotWebhookCheckOutcome = (typeof BOT_WEBHOOK_CHECK_OUTCOMES)[number];

/** The largest token the endpoint reads. A real one is well under 64 characters. */
export const BOT_TOKEN_MAX_LENGTH = 256;
/** Telegram's own last-error text is bounded before it is returned. */
export const BOT_WEBHOOK_ERROR_MESSAGE_MAX = 512;

const isoInstant = z.string();

export const botInstanceViewSchema = z.object({
  id: z.string(),
  username: z.string(),
  /** Telegram's numeric id as a decimal string; null for a row that predates it. */
  telegramBotId: z.string().nullable(),
  status: z.enum(BOT_INSTANCE_STATUSES),
  /** The tenant this bot belongs to. Fixed: ADR-0029 refuses repointing a bot. */
  tenant: z.object({
    id: z.string(),
    slug: z.string(),
    displayName: z.string(),
    kind: z.enum(TENANT_KINDS),
  }),
  createdAt: isoInstant,
  updatedAt: isoInstant,
  webhook: z.object({
    registeredAt: isoInstant.nullable(),
    url: z.string().nullable(),
    secret: z.enum(BOT_WEBHOOK_SECRET_STATES),
  }),
  commandMenu: z.enum(BOT_COMMAND_MENU_STATES),
  readiness: z.object({
    state: z.enum(BOT_READINESS_STATES),
    causes: z.array(z.enum(BOT_READINESS_CAUSES)),
  }),
});
export type BotInstanceView = z.infer<typeof botInstanceViewSchema>;

/** What this API process read from its configuration, shared by every bot it serves. */
export const botInstallationViewSchema = z.object({
  webhookRouteEnabled: z.boolean(),
  webhookSecretConfigured: z.boolean(),
});
export type BotInstallationView = z.infer<typeof botInstallationViewSchema>;

export const botListResponseSchema = z.object({
  bots: z.array(botInstanceViewSchema),
  installation: botInstallationViewSchema,
});
export type BotListResponse = z.infer<typeof botListResponseSchema>;

export const botResponseSchema = z.object({
  bot: botInstanceViewSchema,
  installation: botInstallationViewSchema,
});
export type BotResponse = z.infer<typeof botResponseSchema>;

/**
 * The answer to a stop, a start or a token replacement.
 *
 * `changed: false` is a request for the state the bot was already in — stopping a
 * stopped bot, or supplying the token already stored. Nothing was written, and saying
 * so is the difference from reporting a success that did nothing.
 */
export const botMutationResponseSchema = botResponseSchema.extend({ changed: z.boolean() });
export type BotMutationResponse = z.infer<typeof botMutationResponseSchema>;

export const setBotStatusRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  status: z.enum(BOT_OPERATOR_STATUSES),
});
export type SetBotStatusRequest = z.infer<typeof setBotStatusRequestSchema>;

/**
 * A replacement token for the SAME bot.
 *
 * Bounded here and nothing more. Its shape (`<bot id>:<secret>`) is checked by the
 * service, which answers `bot.token_malformed` — a refusal with a remedy rather than a
 * schema error that names the field.
 */
export const replaceBotTokenRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(255),
  token: z.string().min(1).max(BOT_TOKEN_MAX_LENGTH),
});
export type ReplaceBotTokenRequest = z.infer<typeof replaceBotTokenRequestSchema>;

export const botDiagnosticSchema = z.object({
  botInstanceId: z.string(),
  checkedAt: isoInstant,
  identity: z.object({
    outcome: z.enum(BOT_IDENTITY_CHECK_OUTCOMES),
    telegramBotId: z.string().nullable(),
    username: z.string().nullable(),
    /** Whether Telegram's id equals the stored one; null when nothing was identified. */
    idMatches: z.boolean().nullable(),
    /** Whether Telegram's username equals the stored one (it drifts on a rename). */
    usernameMatches: z.boolean().nullable(),
  }),
  webhook: z.object({
    outcome: z.enum(BOT_WEBHOOK_CHECK_OUTCOMES),
    /** The URL Telegram holds; an empty registration is null. */
    url: z.string().nullable(),
    /** Whether that URL equals the one this installation recorded registering. */
    urlMatchesRecorded: z.boolean().nullable(),
    pendingUpdateCount: z.number().int().nonnegative().nullable(),
    lastErrorAt: isoInstant.nullable(),
    lastErrorMessage: z.string().max(BOT_WEBHOOK_ERROR_MESSAGE_MAX).nullable(),
    maxConnections: z.number().int().nonnegative().nullable(),
  }),
});
export type BotDiagnostic = z.infer<typeof botDiagnosticSchema>;

export const botDiagnosticResponseSchema = z.object({ diagnostic: botDiagnosticSchema });
export type BotDiagnosticResponse = z.infer<typeof botDiagnosticResponseSchema>;

export const BOT_ROUTES = {
  list: '/bots',
  detail: (id: string) => `/bots/${encodeURIComponent(id)}`,
  status: (id: string) => `/bots/${encodeURIComponent(id)}/status`,
  token: (id: string) => `/bots/${encodeURIComponent(id)}/token`,
  diagnostics: (id: string) => `/bots/${encodeURIComponent(id)}/diagnostics`,
} as const;
