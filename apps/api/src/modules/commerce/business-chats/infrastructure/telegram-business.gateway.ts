import {
  businessTextMessageBody,
  telegramGetBusinessConnection,
  telegramSend,
} from '../../../../infrastructure/telegram/send-message.js';
import type { BusinessTelegramGateway } from '../application/ports.js';
import { parseBusinessConnection } from '../domain/telegram-business.js';

/**
 * The two Telegram calls TB1 makes, over the shared transport (`send-message.ts`), so they
 * inherit its abort timeout, `redirect: 'error'` and outcome taxonomy rather than a copy of
 * them.
 */
export class TelegramBusinessGateway implements BusinessTelegramGateway {
  constructor(
    private readonly config: { readonly apiBaseUrl: string; readonly timeoutMs: number },
  ) {}

  async getConnection(
    token: string,
    connectionId: string,
  ): ReturnType<BusinessTelegramGateway['getConnection']> {
    const call = await telegramGetBusinessConnection({
      token,
      apiBaseUrl: this.config.apiBaseUrl,
      timeoutMs: this.config.timeoutMs,
      businessConnectionId: connectionId,
    });
    if (call.outcome === 'FAILED_RETRYABLE') {
      return { outcome: 'UNAVAILABLE', errorCode: call.errorCode };
    }
    if (call.outcome === 'FAILED_PERMANENT') {
      return { outcome: 'NOT_FOUND', errorCode: call.errorCode };
    }
    const report = parseBusinessConnection(call.connection);
    // A 2xx that is not a BusinessConnection is not an answer about this connection, and
    // is never read as "it does not exist".
    if (report === null)
      return { outcome: 'UNAVAILABLE', errorCode: 'telegram.unreadable_connection' };
    // Telegram answering about a DIFFERENT id is equally not an answer about this one.
    if (report.connectionId !== connectionId) {
      return { outcome: 'UNAVAILABLE', errorCode: 'telegram.connection_id_mismatch' };
    }
    return { outcome: 'FOUND', report };
  }

  async sendText(
    token: string,
    input: Parameters<BusinessTelegramGateway['sendText']>[1],
  ): ReturnType<BusinessTelegramGateway['sendText']> {
    const sent = await telegramSend({
      token,
      apiBaseUrl: this.config.apiBaseUrl,
      timeoutMs: this.config.timeoutMs,
      method: 'sendMessage',
      body: businessTextMessageBody(input),
    });
    if (sent.outcome === 'SUCCEEDED') return { outcome: 'SUCCEEDED', messageId: sent.messageId };
    if (sent.outcome === 'FAILED_RETRYABLE') {
      return {
        outcome: 'FAILED_RETRYABLE',
        errorCode: sent.errorCode,
        ...(sent.retryAfterMs === undefined ? {} : { retryAfterMs: sent.retryAfterMs }),
      };
    }
    return { outcome: 'FAILED_PERMANENT', errorCode: sent.errorCode };
  }
}
