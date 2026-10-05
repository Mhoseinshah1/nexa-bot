import {
  SUPPORT_AI_VISION_FETCH_TIMEOUT_MS,
  SUPPORT_AI_VISION_MAX_BYTES,
  type BotInstanceId,
  type ScopeContext,
} from '@nexa/contracts';
import {
  telegramFetchFile,
  type TelegramFileOutcome,
  type TelegramFileRequest,
} from '../../../../infrastructure/telegram/fetch-file.js';
import type {
  BusinessConversationRepository,
  BusinessMessageRepository,
} from '../../../commerce/business-chats/application/ports.js';
import type { SupportImageLoad, SupportImageSource } from '../application/ports.js';
import { sniffSupportImage } from '../domain/vision.js';

/**
 * TB6 — a customer's photo, fetched for a model (program §28).
 *
 * The transport is `telegramFetchFile`, the one Telegram file download this codebase has: it
 * refuses to run inside a transaction, sets `redirect: 'error'` on both legs (the token is in
 * the PATH of each), validates `file_path` against an allow-list before concatenating it,
 * enforces the byte bound on the declared size, the declared length AND while streaming, and
 * times each leg out. This class adds what is specific to support:
 *
 * - **Tenant scope.** The reference is read by tenant + conversation + message id together,
 *   and the token is the token of the bot THAT conversation belongs to, read by tenant. A
 *   message id from another conversation or tenant has no reference here, so it is never
 *   fetched with anybody's token.
 * - **The bound is `SUPPORT_AI_VISION_MAX_BYTES`**, and a declared size over it is refused
 *   before any network call.
 * - **Magic bytes decide the type** (JPEG, PNG, WEBP); Telegram's `content-type` is ignored.
 * - **Nothing is logged and nothing is stored.** The URL holds the token; the outcome holds a
 *   closed reason and never the transport's text.
 */
export class TelegramSupportImageSource implements SupportImageSource {
  constructor(
    private readonly deps: {
      readonly conversations: Pick<BusinessConversationRepository, 'findById'>;
      readonly messages: Pick<BusinessMessageRepository, 'photoReference'>;
      /** The ONE read this needs: an ACTIVE bot's token, by tenant and id. */
      readonly bots: {
        tokenForBotInstance(scope: ScopeContext, id: BotInstanceId): Promise<string | null>;
      };
      readonly apiBaseUrl: string;
      readonly fileBaseUrl: string;
      readonly timeoutMs?: number;
      /** The transport; injectable so a unit test does not need a socket. */
      readonly fetchFile?: (request: TelegramFileRequest) => Promise<TelegramFileOutcome>;
    },
  ) {}

  async load(
    scope: ScopeContext,
    input: { readonly conversationId: string; readonly messageId: string },
  ): Promise<SupportImageLoad> {
    const conversation = await this.deps.conversations.findById(scope, input.conversationId);
    if (conversation === null) return { outcome: 'SKIPPED', reason: 'NO_FILE_REFERENCE' };
    const reference = await this.deps.messages.photoReference(scope, {
      conversationId: conversation.id,
      messageId: input.messageId,
    });
    if (reference === null) return { outcome: 'SKIPPED', reason: 'NO_FILE_REFERENCE' };
    if (reference.fileSize !== null && reference.fileSize > SUPPORT_AI_VISION_MAX_BYTES) {
      return { outcome: 'SKIPPED', reason: 'TOO_LARGE' };
    }
    const token = await this.deps.bots.tokenForBotInstance(
      scope,
      conversation.botInstanceId as BotInstanceId,
    );
    if (token === null) return { outcome: 'SKIPPED', reason: 'DOWNLOAD_FAILED' };
    const fetched = await (this.deps.fetchFile ?? telegramFetchFile)({
      token,
      apiBaseUrl: this.deps.apiBaseUrl,
      fileBaseUrl: this.deps.fileBaseUrl,
      timeoutMs: this.deps.timeoutMs ?? SUPPORT_AI_VISION_FETCH_TIMEOUT_MS,
      fileId: reference.fileId,
      maxBytes: SUPPORT_AI_VISION_MAX_BYTES,
    });
    if (fetched.outcome !== 'SUCCEEDED') {
      return {
        outcome: 'SKIPPED',
        reason: fetched.tooLarge === true ? 'TOO_LARGE' : 'DOWNLOAD_FAILED',
      };
    }
    // Defence in depth: the transport bounds the read, and the bound is re-checked here.
    if (fetched.bytes.byteLength > SUPPORT_AI_VISION_MAX_BYTES) {
      return { outcome: 'SKIPPED', reason: 'TOO_LARGE' };
    }
    const mediaType = sniffSupportImage(fetched.bytes);
    if (mediaType === null) return { outcome: 'SKIPPED', reason: 'UNSUPPORTED_TYPE' };
    return {
      outcome: 'LOADED',
      image: { mediaType, base64: Buffer.from(fetched.bytes).toString('base64') },
      byteSize: fetched.bytes.byteLength,
    };
  }
}
