import type { BusinessBotRight, ScopeContext } from '@nexa/contracts';
import type { BusinessConnectionReport } from '../domain/telegram-business.js';

export type { BusinessConnectionReport };

/**
 * TB1 ports. The application layer declares them; `infrastructure/` implements them.
 */

/** One stored connection. `status` is projected by `businessConnectionStatus`, never stored. */
export interface BusinessConnectionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly botInstanceId: string;
  readonly connectionId: string;
  readonly ownerTelegramUserId: string;
  readonly ownerUserChatId: string;
  readonly isEnabled: boolean;
  readonly rights: readonly BusinessBotRight[];
  readonly connectedAt: Date;
  readonly lastConfirmedAt: Date;
  readonly supersededAt: Date | null;
  readonly version: number;
}

export interface BusinessConnectionRepository {
  find(
    scope: ScopeContext,
    botInstanceId: string,
    connectionId: string,
    tx?: unknown,
  ): Promise<BusinessConnectionRecord | null>;

  findById(scope: ScopeContext, id: string, tx?: unknown): Promise<BusinessConnectionRecord | null>;

  /**
   * The row for `(bot, connection id)`, locked FOR UPDATE, or null. Taken before an
   * apply so two deliveries of reports for one connection are applied one at a time.
   */
  lock(
    scope: ScopeContext,
    botInstanceId: string,
    connectionId: string,
    tx: unknown,
  ): Promise<BusinessConnectionRecord | null>;

  insert(
    scope: ScopeContext,
    row: {
      readonly id: string;
      readonly botInstanceId: string;
      readonly report: BusinessConnectionReport;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<{ readonly record: BusinessConnectionRecord; readonly inserted: boolean }>;

  /** Whether the owner has a live (unsuperseded) row on this bot established after `connectedAt`. */
  hasNewerLive(
    scope: ScopeContext,
    input: {
      readonly botInstanceId: string;
      readonly ownerTelegramUserId: string;
      readonly connectedAt: Date;
      readonly excludeId: string;
    },
    tx: unknown,
  ): Promise<boolean>;

  /** Marks one row superseded and returns it. */
  markSuperseded(
    scope: ScopeContext,
    id: string,
    now: Date,
    tx: unknown,
  ): Promise<BusinessConnectionRecord>;

  /** Rewrites the reported facts and advances `version`; returns the new row. */
  update(
    scope: ScopeContext,
    id: string,
    report: BusinessConnectionReport,
    now: Date,
    tx: unknown,
  ): Promise<BusinessConnectionRecord>;

  /** Stamps `last_confirmed_at` only: the report repeated what is stored. */
  confirm(scope: ScopeContext, id: string, now: Date, tx: unknown): Promise<void>;

  /**
   * Marks every OTHER live row of this owner on this bot established strictly before
   * `olderThan` superseded, returning them. `OQ-TB-02`: a newer connection id for the same
   * owner replaces the older ones — by connection age, never by arrival order.
   */
  supersedeOthers(
    scope: ScopeContext,
    input: {
      readonly botInstanceId: string;
      readonly ownerTelegramUserId: string;
      readonly keepId: string;
      readonly olderThan: Date;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<readonly BusinessConnectionRecord[]>;

  /** This bot's own Telegram id (`bot_instances.telegram_bot_id`), or null when not yet read. */
  ownBotId(scope: ScopeContext, botInstanceId: string): Promise<string | null>;
}

/** The two Telegram calls TB1 makes, behind the bot's own token. */
export interface BusinessTelegramGateway {
  /**
   * `getBusinessConnection`. `NOT_FOUND` is Telegram saying the id is unknown to it
   * (a 4xx); `UNAVAILABLE` is everything that is not an answer (5xx, 429, timeout).
   */
  getConnection(
    token: string,
    connectionId: string,
  ): Promise<
    | { readonly outcome: 'FOUND'; readonly report: BusinessConnectionReport }
    | { readonly outcome: 'NOT_FOUND'; readonly errorCode: string }
    | { readonly outcome: 'UNAVAILABLE'; readonly errorCode: string }
  >;

  /** `sendMessage` with `business_connection_id`. Never throws. */
  sendText(
    token: string,
    input: {
      readonly businessConnectionId: string;
      readonly chatId: string;
      readonly text: string;
      readonly replyToMessageId?: number;
    },
  ): Promise<
    | { readonly outcome: 'SUCCEEDED'; readonly messageId: number | null }
    | {
        readonly outcome: 'FAILED_RETRYABLE';
        readonly errorCode: string;
        readonly retryAfterMs?: number;
      }
    | { readonly outcome: 'FAILED_PERMANENT'; readonly errorCode: string }
  >;
}

/** The bot's token, ACTIVE and tenant-scoped (`tokenForBotInstance`), or null. */
export interface BusinessBotTokenSource {
  tokenForBotInstance(scope: ScopeContext, botInstanceId: string): Promise<string | null>;
}
