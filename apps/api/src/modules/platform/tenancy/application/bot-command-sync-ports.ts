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
  /**
   * The claim's own token: the `claimed_until` this claim wrote. Every record the attempt
   * makes names it, so a claim that lapsed and was taken over by another worker records
   * nothing on top of that worker's newer state (Codex #4). A new claim is taken only
   * after the previous lapsed, so two claims of one row never carry the same instant.
   */
  readonly claimedUntil: Date;
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
  /**
   * The attempt landed with `sentHash`: no failures, the lease dropped — and nothing
   * queued ONLY when the row still wants `sentHash`. A description edited while the call
   * was in flight moved `desired_hash` on; that row stays due (Codex #3). WHERE the row
   * still holds `claim`; false when it did not (a lapsed claim taken over), and then the
   * caller records nothing else either.
   */
  recordSuccess(
    scope: ScopeContext,
    botId: BotInstanceId,
    input: { readonly now: Date; readonly sentHash: string; readonly claim: Date },
    tx: unknown,
  ): Promise<boolean>;
  /**
   * The attempt did not land: one more failure, the next attempt at `nextAttemptAt`, the
   * lease dropped. Answers the new count, or null when the row no longer holds `claim`.
   */
  recordFailure(
    scope: ScopeContext,
    botId: BotInstanceId,
    input: {
      readonly now: Date;
      readonly errorCode: string;
      readonly nextAttemptAt: Date;
      readonly claim: Date;
    },
    tx: unknown,
  ): Promise<number | null>;
  /** Hands THIS claim back without spending an attempt (the scope stopped meanwhile). */
  release(scope: ScopeContext, botId: BotInstanceId, claim: Date, tx?: unknown): Promise<void>;
  /**
   * The reconcile sweep's input: ACTIVE bots of ACTIVE tenants, ordered by bot id, from
   * the id after `afterBotId` (null starts at the beginning) — a keyset page, so a sweep
   * that loops until a short page reaches every bot whatever the installation's size
   * (Codex #1).
   */
  activeBotsAcrossTenants(
    limit: number,
    afterBotId: string | null,
  ): Promise<
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
