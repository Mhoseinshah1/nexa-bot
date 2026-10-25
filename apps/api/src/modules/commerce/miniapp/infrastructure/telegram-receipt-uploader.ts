import type { BotInstanceId, ScopeContext, TenantContext } from '@nexa/contracts';
import {
  deleteMessageBody,
  fileUploadBody,
  telegramSend,
} from '../../../../infrastructure/telegram/send-message.js';
import type { ReceiptImageMime, ReceiptImageUploader } from '../application/ports.js';

const EXTENSION: Readonly<Record<ReceiptImageMime, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Puts a mini-app receipt image into Telegram with the bot the customer is talking to, so
 * the receipt module gets what it stores for a photo sent in the bot: a `file_id` that
 * bot can fetch, and a `file_unique_id`.
 *
 * The photo is sent into the customer's OWN private chat with that bot — the one chat a
 * bot is certain to be able to write to for this person, and the chat the bot path's photo
 * lives in — and the message is deleted at once: the `file_id` outlives the message, and
 * leaving it would be a customer message the bot path does not send. A deletion Telegram
 * refuses is logged and does not fail the receipt (the customer sees their own receipt,
 * which is what their chat holds on the bot path anyway).
 *
 * The token is resolved through `resolveToken`, the one outbound token path, and never
 * leaves this adapter.
 */
export class TelegramReceiptUploader implements ReceiptImageUploader {
  constructor(
    private readonly deps: {
      readonly bots: { resolveToken(scope: ScopeContext, id: BotInstanceId): Promise<string> };
      readonly apiBaseUrl: string;
      readonly timeoutMs: number;
      readonly logger: { warn(context: Record<string, unknown>, message: string): void };
    },
  ) {}

  async upload(
    scope: TenantContext,
    input: {
      readonly botInstanceId: BotInstanceId;
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
  > {
    const token = await this.deps.bots.resolveToken(scope, input.botInstanceId);
    const sent = await telegramSend({
      token,
      apiBaseUrl: this.deps.apiBaseUrl,
      timeoutMs: this.deps.timeoutMs,
      method: 'sendPhoto',
      multipart: fileUploadBody({
        chatId: input.chatId,
        kind: 'PHOTO',
        bytes: input.bytes,
        fileName: `receipt.${EXTENSION[input.mimeType]}`,
        mimeType: input.mimeType,
      }),
    });
    if (sent.outcome !== 'SUCCEEDED') return { outcome: 'REFUSED', code: sent.errorCode };
    if (sent.file === undefined) return { outcome: 'REFUSED', code: 'telegram.no_file_in_answer' };
    if (sent.messageId !== null) {
      const removed = await telegramSend({
        token,
        apiBaseUrl: this.deps.apiBaseUrl,
        timeoutMs: this.deps.timeoutMs,
        method: 'deleteMessage',
        body: deleteMessageBody({ chatId: input.chatId, messageId: sent.messageId }),
      });
      if (removed.outcome !== 'SUCCEEDED') {
        this.deps.logger.warn(
          { botInstanceId: input.botInstanceId, errorCode: removed.errorCode },
          'mini-app receipt upload message could not be deleted; the receipt is unaffected',
        );
      }
    }
    return {
      outcome: 'UPLOADED',
      fileId: sent.file.fileId,
      fileUniqueId: sent.file.fileUniqueId,
      messageId: sent.messageId,
    };
  }
}
