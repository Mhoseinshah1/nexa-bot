import type {
  BotCommandEntry,
  BotInstanceId,
  BotInstanceStatus,
  ScopeContext,
} from '@nexa/contracts';
import type { BotCommandsRead, BotCommandsRegistration } from './ports.js';

/** One bot as the lane sees it: its status and what Telegram was last given. No credential. */
export interface CommandSyncBotRecord {
  readonly id: BotInstanceId;
  readonly username: string;
  readonly status: BotInstanceStatus;
  /** `bot_instances.commands_revision`. NULL is unknown, never "matches". */
  readonly syncedHash: string | null;
}

/** The sync row, or null when the lane has never been asked about this bot. */
export interface CommandSyncRow {
  readonly desiredHash: string;
  readonly desiredVersion: number;
  readonly lastSyncedAt: Date | null;
  readonly lastAttemptedAt: Date | null;
  readonly lastErrorCode: string | null;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly claimedUntil: Date | null;
}

export interface CommandSyncStatusRecord {
  readonly bot: CommandSyncBotRecord;
  readonly sync: CommandSyncRow | null;
}

/** A due row the lane claimed: everything an attempt needs except the token. */
export interface ClaimedCommandSync {
  readonly tenantId: string;
  readonly botInstanceId: BotInstanceId;
  readonly desiredHash: string;
  readonly attempts: number;
}

export interface BotCommandSyncRepository {
  /** The tenant's bots, oldest first, each with its sync row. */
  listForTenant(scope: ScopeContext, tx?: unknown): Promise<CommandSyncStatusRecord[]>;
  /**
   * Records what this tenant wants for one bot. Creates the row or updates it; moves
   * `desired_version` on when the hash changed. With `due`, queues an attempt NOW and resets
   * the failure count — the operator's «همگام‌سازی دوباره» and a token replacement; without
   * it, queues one only when the desired hash differs from what Telegram was last given
   * (`commands_revision`) and none is queued yet — the event-driven and sweep callers.
   */
  upsertDesired(
    scope: ScopeContext,
    input: {
      readonly botId: BotInstanceId;
      readonly desiredHash: string;
      readonly now: Date;
      readonly due: boolean;
    },
    tx: unknown,
  ): Promise<void>;
  /**
   * Claims up to `limit` due rows across tenants — ACTIVE tenants and ACTIVE bots only,
   * `next_attempt_at` reached, no live claim — for `leaseMs`. Two replicas claiming at once
   * split the batch; neither sees the other's rows.
   */
  claimDue(now: Date, limit: number, leaseMs: number): Promise<ClaimedCommandSync[]>;
  /**
   * Claims ONE bot for an attempt run on request, queued or not: creates the row when
   * missing, queues it, and takes the lease. Null when the bot is not this tenant's, not
   * ACTIVE, or held by a live claim (a running attempt answers first).
   */
  claimOne(
    scope: ScopeContext,
    botId: BotInstanceId,
    input: { readonly desiredHash: string; readonly now: Date; readonly leaseMs: number },
  ): Promise<ClaimedCommandSync | null>;
  /** The attempt landed: nothing queued, no failures, the lease dropped. */
  recordSuccess(
    scope: ScopeContext,
    botId: BotInstanceId,
    input: { readonly now: Date },
    tx: unknown,
  ): Promise<void>;
  /** The attempt did not land: one more failure, the next attempt at `nextAttemptAt`, the lease dropped. Answers the new count. */
  recordFailure(
    scope: ScopeContext,
    botId: BotInstanceId,
    input: { readonly now: Date; readonly errorCode: string; readonly nextAttemptAt: Date },
    tx: unknown,
  ): Promise<number>;
  /** Hands a claim back without spending an attempt (the scope stopped meanwhile). */
  release(scope: ScopeContext, botId: BotInstanceId, tx?: unknown): Promise<void>;
  /**
   * The reconcile sweep's input: every ACTIVE bot of every ACTIVE tenant, with what
   * Telegram was last given and whether an attempt is queued, tenant by tenant.
   */
  activeBotsAcrossTenants(limit: number): Promise<
    ReadonlyArray<{
      readonly tenantId: string;
      readonly botId: BotInstanceId;
      readonly syncedHash: string | null;
      readonly queued: boolean;
    }>
  >;
}

/** The two Telegram calls the lane makes, on the shared gateway. */
export interface BotCommandSyncTelegram {
  registerCommands(input: {
    readonly token: string;
    readonly commands: readonly BotCommandEntry[];
  }): Promise<BotCommandsRegistration>;
  readCommands(token: string): Promise<BotCommandsRead>;
}
