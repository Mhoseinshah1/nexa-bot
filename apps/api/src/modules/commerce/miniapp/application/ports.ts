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
