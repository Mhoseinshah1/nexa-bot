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
  /** Insert or replace the row, bumping its version. Returns the row as stored. */
  upsertSlot(
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
  ): Promise<StoredAppearanceSlot>;
  /** Remove the row; false when there was none. */
  deleteSlot(scope: ScopeContext, slot: AppearanceSlot, tx: unknown): Promise<boolean>;
  /** The tenant's bots, oldest first, each with its last test. */
  listBots(scope: ScopeContext, tx?: unknown): Promise<AppearanceBotRecord[]>;
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
