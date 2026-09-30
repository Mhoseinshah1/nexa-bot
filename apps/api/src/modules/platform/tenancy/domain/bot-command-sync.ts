import type { BotCommandSyncState, BotInstanceStatus } from '@nexa/contracts';

/**
 * The pure rules of the slash-command sync lane (round P, COMMAND-MENU). Each is here,
 * out of the service, so a test can name it and a mutation can be watched to fail it.
 */

/** How often the worker's lane looks for due rows. */
export const BOT_COMMAND_SYNC_INTERVAL_MS = 15_000;
/** How often the lane re-derives every ACTIVE bot's desired menu and queues what differs. */
export const BOT_COMMAND_SYNC_RECONCILE_INTERVAL_MS = 5 * 60_000;
/** Due rows claimed per tick, across tenants. */
export const BOT_COMMAND_SYNC_BATCH = 20;
/** Bots read per page of the reconcile sweep, which pages until a short page. */
export const BOT_COMMAND_SYNC_RECONCILE_PAGE = 500;
/** The first back-off, doubled per consecutive failure. */
export const BOT_COMMAND_SYNC_BACKOFF_BASE_MS = 30_000;
/** The back-off's ceiling. A bot that never answers is asked once an hour, for ever. */
export const BOT_COMMAND_SYNC_BACKOFF_MAX_MS = 60 * 60_000;
/** Consecutive failures before the operations log is told. Deduped per bot after that. */
export const BOT_COMMAND_SYNC_WARN_AFTER_ATTEMPTS = 3;

/** The operational condition a repeatedly failing sync opens, and the recovery that closes it. */
export const COMMAND_SYNC_FAILING_CODE = 'bot.command_sync_failing';
export const COMMAND_SYNC_RECOVERED_CODE = 'bot.command_sync_recovered';
export function commandSyncDedupeKey(botInstanceId: string): string {
  return `bot:${botInstanceId}`;
}

/**
 * The lease one attempt holds: one Telegram call plus a minute, never under two minutes.
 * The same shape as the token replacement's (`tokenReplacementLeaseMs`), so a stuck call
 * blocks a retry for minutes and never for ever.
 */
export function commandSyncLeaseMs(telegramCallTimeoutMs: number): number {
  return Math.max(2 * 60_000, telegramCallTimeoutMs + 60_000);
}

/**
 * When the next attempt is due after `attempts` consecutive failures (the count INCLUDING
 * the one just recorded, so the first failure waits the base). Exponential, bounded: a
 * `retry_after` Telegram names is honoured when it is longer.
 */
export function commandSyncBackoffMs(attempts: number, retryAfterMs: number | null = null): number {
  const exponent = Math.max(0, Math.min(attempts - 1, 30));
  const computed = Math.min(
    BOT_COMMAND_SYNC_BACKOFF_MAX_MS,
    BOT_COMMAND_SYNC_BACKOFF_BASE_MS * 2 ** exponent,
  );
  return retryAfterMs !== null && retryAfterMs > computed ? retryAfterMs : computed;
}

export interface CommandSyncStateInput {
  readonly botStatus: BotInstanceStatus;
  /** `bot_instances.commands_revision`: what Telegram was last given, or unknown. */
  readonly syncedHash: string | null;
  readonly desiredHash: string;
  readonly nextAttemptAt: Date | null;
  readonly attempts: number;
}

/**
 * Where one bot stands (`BOT_COMMAND_SYNC_STATES`). The order of the questions IS the
 * rule: a stopped bot is STOPPED whatever is queued (its credential is not used, so a
 * queued sync would only fail); a queued sync is PENDING or FAILING whatever the hashes say
 * (the lane will decide); only an idle row is judged by its hashes.
 */
export function commandSyncStateOf(input: CommandSyncStateInput): BotCommandSyncState {
  if (input.botStatus !== 'ACTIVE') return 'STOPPED';
  if (input.nextAttemptAt !== null) return input.attempts > 0 ? 'FAILING' : 'PENDING';
  if (input.syncedHash === null) return 'UNKNOWN';
  return input.syncedHash === input.desiredHash ? 'CURRENT' : 'STALE';
}
