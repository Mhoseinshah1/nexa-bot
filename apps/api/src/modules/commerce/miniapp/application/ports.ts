import type { BotInstanceId, TenantContext, TenantId, UserId } from '@nexa/contracts';

/** One mini-app session row (`miniapp_sessions`). The bearer secret is never here, only its hash. */
export interface MiniAppSessionRecord {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly botInstanceId: BotInstanceId;
  readonly customerId: UserId;
  readonly telegramUserId: string;
  readonly initDataHash: string;
  readonly tokenHash: string;
  readonly authDate: Date;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface MiniAppSessionRepository {
  /**
   * Inserts the session, or reports that this launch already minted one. ONE statement
   * (`INSERT … ON CONFLICT (tenant, bot, init_data_hash) DO NOTHING`), so two replicas asked
   * with the same launch at once mint one session between them, and never two.
   */
  insert(
    scope: TenantContext,
    record: MiniAppSessionRecord,
    tx: unknown,
  ): Promise<'INSERTED' | 'ALREADY_MINTED'>;
  /**
   * The session a bearer token names, by its id, WITHOUT a tenant: the token is what the
   * tenant is derived from — the same shape as resolving a bot from the webhook's path. Every
   * read after this one is scoped to the tenant the row names.
   */
  findById(id: string): Promise<MiniAppSessionRecord | null>;
}

/**
 * The bytes the mini app uploads for a card-to-card receipt, put into Telegram by the bot
 * the customer is talking to so the existing receipt service gets the `file_id` it takes.
 */
export interface ReceiptImageUploader {
  upload(
    scope: TenantContext,
    input: {
      readonly botInstanceId: BotInstanceId;
      /** The customer's private chat with the bot: Telegram's id, as text. */
      readonly chatId: string;
      readonly bytes: Uint8Array;
      readonly mimeType: ReceiptImageMime;
    },
  ): Promise<
    | {
        readonly outcome: 'UPLOADED';
        readonly fileId: string;
        readonly fileUniqueId: string;
        readonly messageId: number | null;
      }
    | { readonly outcome: 'REFUSED'; readonly code: string }
  >;
}

export const RECEIPT_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type ReceiptImageMime = (typeof RECEIPT_IMAGE_MIMES)[number];

/** One delivered bot message, as the notification centre lists it (Round 11, B1). */
export interface NotificationCentreItem {
  readonly id: string;
  readonly text: string;
  readonly deliveredAt: Date;
  /** PostgreSQL's own microsecond text of `deliveredAt`: the cursor must reproduce it exactly. */
  readonly deliveredAtText: string;
  readonly read: boolean;
}

/** Where a page ended: the ordering key `(delivered, id)`, never an offset. */
export interface NotificationCentrePosition {
  readonly deliveredAtText: string;
  readonly id: string;
}

export interface NotificationCentreRepository {
  /**
   * One customer's delivered messages from ONE bot, newest first, from `since` on. Names the
   * tenant, the customer AND the bot in the query: the customer is the session's, never a
   * client's, and another bot's messages are, to this one, nobody's.
   */
  list(
    scope: TenantContext,
    input: {
      readonly customerId: UserId;
      readonly botInstanceId: BotInstanceId;
      readonly since: Date;
      readonly after: NotificationCentrePosition | null;
      readonly limit: number;
    },
    tx?: unknown,
  ): Promise<{
    readonly items: readonly NotificationCentreItem[];
    readonly next: NotificationCentrePosition | null;
  }>;
  unreadCount(
    scope: TenantContext,
    input: {
      readonly customerId: UserId;
      readonly botInstanceId: BotInstanceId;
      readonly since: Date;
    },
    tx?: unknown,
  ): Promise<number>;
  /**
   * Marks ONE message read — a conditional UPDATE that names `customer_read_at IS NULL`, so a
   * second tap changes nothing and keeps the first moment. `ALREADY_READ` is a message that is
   * the customer's and was read; `NOT_FOUND` is one that is not (another customer's, another
   * bot's, another tenant's, not delivered, or nothing at all) — one answer for all of them.
   */
  markRead(
    scope: TenantContext,
    input: {
      readonly customerId: UserId;
      readonly botInstanceId: BotInstanceId;
      readonly id: string;
      readonly at: Date;
    },
    tx: unknown,
  ): Promise<'MARKED' | 'ALREADY_READ' | 'NOT_FOUND'>;
  /** Marks every unread message of this customer and bot read; returns how many it changed. */
  markAllRead(
    scope: TenantContext,
    input: {
      readonly customerId: UserId;
      readonly botInstanceId: BotInstanceId;
      readonly at: Date;
    },
    tx: unknown,
  ): Promise<number>;
}
