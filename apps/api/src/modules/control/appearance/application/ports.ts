import type {
  AppearanceSlot,
  AppearanceTestErrorCode,
  AppearanceTestOutcome,
  BotInstanceId,
  BotInstanceStatus,
  ScopeContext,
  TenantContext,
} from '@nexa/contracts';
import type {
  AppearanceProbeMessage,
  AppearanceProbeResult,
} from '../../../commerce/messaging/application/ports.js';

/**
 * Premium UI — what the appearance service reads and writes (`docs/premium-ui-audit.md`).
 *
 * The slot rows hold an id and a switch, never a rendered string or an HTML fragment. The
 * bot's test result lives on `bot_instances`, because eligibility is a property of a bot.
 */

/** One configured slot as stored. A slot with no row is the catalogue fallback, switched on. */
export interface StoredAppearanceSlot {
  readonly slot: AppearanceSlot;
  readonly customEmojiId: string | null;
  readonly enabled: boolean;
  readonly version: number;
  readonly updatedAt: Date;
  readonly updatedByAdminId: string | null;
}

/** One of the tenant's bots, with its last eligibility test. */
export interface AppearanceBotRecord {
  readonly id: BotInstanceId;
  readonly username: string;
  readonly status: BotInstanceStatus;
  readonly test: {
    readonly testedAt: Date;
    readonly outcome: AppearanceTestOutcome;
    readonly errorCode: AppearanceTestErrorCode | null;
  } | null;
}

export interface AppearanceRepository {
  listSlots(scope: ScopeContext, tx?: unknown): Promise<StoredAppearanceSlot[]>;
  /** The row `FOR UPDATE` when `tx` is given, so a version is compared under the lock. */
  findSlot(
    scope: ScopeContext,
    slot: AppearanceSlot,
    tx?: unknown,
    forUpdate?: boolean,
  ): Promise<StoredAppearanceSlot | null>;
  /**
   * Create the row — and ONLY when none exists: `ON CONFLICT DO NOTHING`. Null when another
   * request created it first, which the caller reports as a version conflict. A row that
   * did not exist locks nothing under `findSlot(..., forUpdate)`, so two first saves both
   * pass the version check; the insert is where they meet (Codex, PR #121, finding 3).
   */
  insertSlot(
    scope: ScopeContext,
    input: {
      readonly id: string;
      readonly slot: AppearanceSlot;
      readonly customEmojiId: string | null;
      readonly enabled: boolean;
      readonly now: Date;
      readonly updatedByAdminId: string | null;
    },
    tx: unknown,
  ): Promise<StoredAppearanceSlot | null>;
  /**
   * Change the row WHERE it is still at `expectedVersion`, bumping the version. Null when
   * no row was at that version — the predicate is the rule, whatever lock the caller holds.
   */
  updateSlot(
    scope: ScopeContext,
    input: {
      readonly slot: AppearanceSlot;
      readonly expectedVersion: number;
      readonly customEmojiId: string | null;
      readonly enabled: boolean;
      readonly now: Date;
      readonly updatedByAdminId: string | null;
    },
    tx: unknown,
  ): Promise<StoredAppearanceSlot | null>;
  /** Remove the row WHERE it is still at `expectedVersion`; false when none was. */
  deleteSlot(
    scope: ScopeContext,
    slot: AppearanceSlot,
    expectedVersion: number,
    tx: unknown,
  ): Promise<boolean>;
  /** The tenant's bots, oldest first, each with its last test. */
  listBots(scope: ScopeContext, tx?: unknown): Promise<AppearanceBotRecord[]>;
  /**
   * ONE bot of the tenant, `FOR UPDATE`: what a test's result transaction reads before it
   * writes, so the audit row's `before` is the verdict this write replaces and not the one
   * read before the claim and the Telegram call (Codex, PR #121, finding 7).
   */
  lockBot(
    scope: ScopeContext,
    botInstanceId: BotInstanceId,
    tx: unknown,
  ): Promise<AppearanceBotRecord | null>;
  /**
   * Record a test's answer on the bot row. A conditional UPDATE on the tenant AND the bot,
   * so a bot id from another tenant records nothing; false when no row matched.
   */
  recordTest(
    scope: ScopeContext,
    botInstanceId: BotInstanceId,
    result: {
      readonly testedAt: Date;
      readonly outcome: AppearanceTestOutcome;
      readonly errorCode: AppearanceTestErrorCode | null;
    },
    tx?: unknown,
  ): Promise<boolean>;
}

/** The one send the service makes: the messenger's probe, behind a port it cannot widen. */
export interface AppearanceProbeSender {
  sendAppearanceProbe(
    scope: TenantContext,
    message: AppearanceProbeMessage,
  ): Promise<AppearanceProbeResult>;
}

/** The signed-in administrator's Telegram binding (HB-3), and nothing else about them. */
export interface AppearanceAdminReader {
  telegramUserIdOf(scope: ScopeContext, adminId: string): Promise<string | null>;
}
