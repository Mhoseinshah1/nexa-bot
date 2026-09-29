import { z } from 'zod';
import { BOT_INSTANCE_STATUSES, TENANT_KINDS, type BotInstanceStatus } from './tenant.js';

/**
 * WP13 — managing this installation's Telegram bot instances from the Web Admin
 * (`docs/wp13-bots-management-audit.md`).
 *
 * What it covers is exactly what the architecture can truthfully support: reading a
 * bot's recorded state, stopping and starting it, replacing its token for the SAME
 * bot, and asking Telegram what it currently holds. What it deliberately does not
 * cover — adding a bot, repointing one to another tenant — is recorded in the audit
 * with the decision that rules each out.
 *
 * R4 (item 12) changed one thing here: a token replacement now REGISTERS the webhook
 * with the new token and reads it back before the token is stored, at the one URL this
 * installation has already proved it serves (`webhook_url`'s origin, recomposed). A
 * replacement that stored a token and left the webhook to chance was the defect: the
 * token was accepted and the bot stayed silent.
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

/**
 * R4 — everything a LIVE look at Telegram, plus this process's configuration, found in
 * the way of this bot receiving updates. Empty means ready.
 *
 * The first three are the recorded holding causes (`BOT_HOLDING_CAUSES`), repeated here
 * so one list answers "is it ready"; the rest are what only Telegram can say:
 *
 *  - `TOKEN_NOT_ACCEPTED` — `getMe` did not identify the bot;
 *  - `DIFFERENT_BOT` — it identified a bot other than the recorded one;
 *  - `WEBHOOK_UNREADABLE` — `getWebhookInfo` could not be read;
 *  - `WEBHOOK_EXPECTED_UNKNOWN` — this installation has never recorded the origin it
 *    serves the webhook on, so there is nothing exact to compare with;
 *  - `WEBHOOK_NOT_SET` — Telegram holds no webhook (updates are queued, not delivered);
 *  - `WEBHOOK_ELSEWHERE` — Telegram delivers to a URL that is not this installation's;
 *  - `WEBHOOK_UPDATES_NARROWED` — the registration's `allowed_updates` leaves out an
 *    update type this bot handles;
 *  - `WEBHOOK_SECRET_NOT_CURRENT` — the registration was not recorded as made with the
 *    secret this installation holds now, so the route would refuse what Telegram signs.
 */
export const BOT_LIVE_PROBLEMS = [
  'WEBHOOK_ROUTE_DISABLED',
  'TENANT_INACTIVE',
  'BOT_NOT_ACTIVE',
  'TOKEN_NOT_ACCEPTED',
  'DIFFERENT_BOT',
  'WEBHOOK_UNREADABLE',
  'WEBHOOK_EXPECTED_UNKNOWN',
  'WEBHOOK_NOT_SET',
  'WEBHOOK_ELSEWHERE',
  'WEBHOOK_UPDATES_NARROWED',
  'WEBHOOK_SECRET_NOT_CURRENT',
] as const;
export type BotLiveProblem = (typeof BOT_LIVE_PROBLEMS)[number];

/**
 * R4 — where a token replacement stopped, when it stopped after Telegram was asked to
 * change something. A failure before that point has nothing to put back and carries no
 * stage.
 */
export const BOT_REPLACEMENT_STAGES = ['SET_WEBHOOK', 'VERIFY_WEBHOOK', 'ACTIVATE'] as const;
export type BotReplacementStage = (typeof BOT_REPLACEMENT_STAGES)[number];

/**
 * R4 — what was done at Telegram to undo a replacement that did not complete.
 *
 *  - `NOT_NEEDED` — nothing to undo: Telegram refused the change, or it already
 *    delivered to this installation's own URL before the attempt;
 *  - `RESTORED` — the bot had no webhook before, and it has none again;
 *  - `HELD` — the bot was registered ELSEWHERE before. That registration cannot be put
 *    back (Telegram never reveals the secret it was made with), so the webhook was
 *    removed and Telegram holds the bot's updates instead of delivering them to an
 *    installation whose stored token cannot answer them;
 *  - `SUPERSEDED` — somebody else changed the registration meanwhile; it was left alone;
 *  - `FAILED` — the undo could not be done or confirmed. An operational event says so.
 */
export const BOT_WEBHOOK_COMPENSATIONS = [
  'NOT_NEEDED',
  'RESTORED',
  'HELD',
  'SUPERSEDED',
  'FAILED',
] as const;
export type BotWebhookCompensation = (typeof BOT_WEBHOOK_COMPENSATIONS)[number];

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
    /**
     * The URL Telegram holds: in full when it is the one this installation recorded, and
     * cut to its origin (`https://host/…`) otherwise — a foreign registration's path is
     * where a bot token or another system's secret lives. An empty registration is null.
     */
    url: z.string().nullable(),
    /** Whether that URL equals the one this installation recorded registering. */
    urlMatchesRecorded: z.boolean().nullable(),
    pendingUpdateCount: z.number().int().nonnegative().nullable(),
    lastErrorAt: isoInstant.nullable(),
    lastErrorMessage: z.string().max(BOT_WEBHOOK_ERROR_MESSAGE_MAX).nullable(),
    maxConnections: z.number().int().nonnegative().nullable(),
    /**
     * R4 — the URL THIS installation registers for this bot: the recorded registration's
     * origin plus `/telegram/webhook/<bot instance id>`. It carries no secret. Null when no
     * origin was ever recorded (`WEBHOOK_EXPECTED_UNKNOWN`).
     */
    expectedUrl: z.string().nullable(),
    /** Whether Telegram's URL is EXACTLY `expectedUrl`. Null when either is unknown. */
    matchesExpected: z.boolean().nullable(),
  }),
  /** R4 — the one answer to "can this bot receive an update right now". */
  verdict: z.object({
    readyToReceive: z.boolean(),
    problems: z.array(z.enum(BOT_LIVE_PROBLEMS)),
  }),
});
export type BotDiagnostic = z.infer<typeof botDiagnosticSchema>;

/**
 * R4 — the answer to a token replacement: the mutation answer, and the verification the
 * replacement itself made — `getMe` with the new token, and the webhook as Telegram
 * reported it AFTER it was registered. It is what the Web Admin shows at once, so the
 * operator does not have to run a live check to find out whether it worked.
 *
 * `changed` is about the TOKEN: `false` means the one supplied was already stored — the
 * webhook was still registered and verified again, which is how a bot left silent by an
 * earlier replacement is repaired. `verification` is null only on a replay of a result
 * stored before this field existed.
 */
export const botTokenReplacementResponseSchema = botMutationResponseSchema.extend({
  verification: botDiagnosticSchema.nullable(),
});
export type BotTokenReplacementResponse = z.infer<typeof botTokenReplacementResponseSchema>;

/**
 * R4 — the `details` of a replacement refused AFTER Telegram was asked to change the
 * webhook (`bot.webhook_refused`, `bot.webhook_setup_failed`,
 * `bot.webhook_verification_failed`, `bot.token_activation_failed`). Nothing in it is
 * secret: the expected URL is this installation's own, the actual one is shown by the
 * rule `url` above follows, and Telegram's reason is redacted and bounded.
 */
export const botReplacementFailureDetailsSchema = z.object({
  stage: z.enum(BOT_REPLACEMENT_STAGES),
  compensation: z.enum(BOT_WEBHOOK_COMPENSATIONS),
  expectedUrl: z.string().nullable(),
  actualUrl: z.string().nullable(),
  telegramReason: z.string().max(BOT_WEBHOOK_ERROR_MESSAGE_MAX).nullable(),
  /**
   * For `bot.token_activation_failed`: the error code the storing transaction ended with
   * (a session that expired meanwhile, a tenant stopped meanwhile, a claim that lapsed),
   * or null when it was not a coded refusal.
   */
  cause: z.string().nullable(),
});
export type BotReplacementFailureDetails = z.infer<typeof botReplacementFailureDetailsSchema>;

export const botDiagnosticResponseSchema = z.object({ diagnostic: botDiagnosticSchema });
export type BotDiagnosticResponse = z.infer<typeof botDiagnosticResponseSchema>;

export const BOT_ROUTES = {
  list: '/bots',
  detail: (id: string) => `/bots/${encodeURIComponent(id)}`,
  status: (id: string) => `/bots/${encodeURIComponent(id)}/status`,
  token: (id: string) => `/bots/${encodeURIComponent(id)}/token`,
  diagnostics: (id: string) => `/bots/${encodeURIComponent(id)}/diagnostics`,
} as const;
