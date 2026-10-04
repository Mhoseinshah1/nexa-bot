import {
  BUSINESS_UPDATE_FAILED_CODE,
  businessConnectionStatus,
  businessTextSchema,
  type ActorContext,
  type BusinessConnectionStatus,
  type Clock,
  type OperationalEventRecorder,
  type ScopeContext,
} from '@nexa/contracts';
import type { BusinessConnectionService } from './business-connection.service.js';
import type {
  BusinessBotTokenSource,
  BusinessConnectionRepository,
  BusinessTelegramGateway,
} from './ports.js';

/**
 * What one send on the business account's behalf did — the customer messenger's four-way
 * taxonomy (ADR-0030), so the TB2 lane can apply the rule that lane already proves:
 *
 *   - `DELIVERED` — Telegram accepted it. `messageId` is what proves a later echo is ours.
 *   - `REFUSED` — nothing was delivered: NEXA refused before calling (the connection is not
 *     ACTIVE, the bot is not ACTIVE, the text is not sendable) or Telegram answered 4xx.
 *     Never retried as-is.
 *   - `RATE_LIMITED` — a 429 with Telegram's own wait. Not an unknown outcome.
 *   - `UNKNOWN` — the request may have been delivered (5xx, timeout, an unreadable 2xx).
 *     NEVER resent: Telegram has no send idempotency (ADR-0033 §6).
 */
export type BusinessSendOutcome =
  | { readonly outcome: 'DELIVERED'; readonly messageId: number | null }
  | {
      readonly outcome: 'REFUSED';
      readonly reason:
        | 'CONNECTION_UNUSABLE'
        | 'CONNECTION_NOT_FOUND'
        | 'BOT_UNAVAILABLE'
        | 'INVALID_TEXT'
        | 'TELEGRAM_REJECTED';
      readonly errorCode: string | null;
      readonly connectionStatus: BusinessConnectionStatus | null;
    }
  | { readonly outcome: 'RATE_LIMITED'; readonly retryAfterMs: number | null }
  | { readonly outcome: 'UNKNOWN'; readonly errorCode: string };

export interface BusinessTransportDeps {
  readonly repository: BusinessConnectionRepository;
  readonly connections: BusinessConnectionService;
  readonly telegram: BusinessTelegramGateway;
  readonly tokens: BusinessBotTokenSource;
  readonly opsLog: OperationalEventRecorder;
  readonly clock: Clock;
}

/**
 * TB1 — the ONE path by which NEXA sends a message as a connected Business account.
 *
 * It decides nothing about WHETHER a conversation may be answered — that is the TB2 lane's
 * epoch-and-state check, made under the conversation's lock before this is called. What it
 * owns is the connection: a connection that is not ACTIVE is refused before any request
 * (fail closed), and a send Telegram refuses triggers a re-read of the connection, because
 * a 4xx on a business send is most often the owner having disconnected or revoked the right
 * to reply, and only Telegram's answer may change the stored state.
 *
 * Must be called OUTSIDE a transaction (`telegramSend` asserts it).
 */
export class BusinessTransport {
  constructor(private readonly deps: BusinessTransportDeps) {}

  async sendText(
    scope: ScopeContext,
    actor: ActorContext,
    input: {
      readonly connectionRowId: string;
      readonly chatId: string;
      readonly text: string;
      readonly replyToMessageId?: number;
    },
  ): Promise<BusinessSendOutcome> {
    const text = businessTextSchema.safeParse(input.text);
    if (!text.success) {
      return {
        outcome: 'REFUSED',
        reason: 'INVALID_TEXT',
        errorCode: null,
        connectionStatus: null,
      };
    }
    const connection = await this.deps.repository.findById(scope, input.connectionRowId);
    if (connection === null) {
      return {
        outcome: 'REFUSED',
        reason: 'CONNECTION_NOT_FOUND',
        errorCode: null,
        connectionStatus: null,
      };
    }
    const status = businessConnectionStatus(connection);
    if (status !== 'ACTIVE') {
      return {
        outcome: 'REFUSED',
        reason: 'CONNECTION_UNUSABLE',
        errorCode: null,
        connectionStatus: status,
      };
    }
    const token = await this.deps.tokens.tokenForBotInstance(scope, connection.botInstanceId);
    if (token === null) {
      return {
        outcome: 'REFUSED',
        reason: 'BOT_UNAVAILABLE',
        errorCode: null,
        connectionStatus: status,
      };
    }

    const sent = await this.deps.telegram.sendText(token, {
      businessConnectionId: connection.connectionId,
      chatId: input.chatId,
      text: text.data,
      ...(input.replyToMessageId === undefined ? {} : { replyToMessageId: input.replyToMessageId }),
    });
    if (sent.outcome === 'SUCCEEDED') return { outcome: 'DELIVERED', messageId: sent.messageId };
    if (sent.outcome === 'FAILED_RETRYABLE') {
      // A 429 is the one retryable answer that is not an unknown outcome: Telegram said
      // "not now", and nothing was delivered.
      if (sent.errorCode === 'telegram.rate_limited') {
        return { outcome: 'RATE_LIMITED', retryAfterMs: sent.retryAfterMs ?? null };
      }
      return { outcome: 'UNKNOWN', errorCode: sent.errorCode };
    }

    const after = await this.reverify(scope, actor, connection.id, sent.errorCode);
    return {
      outcome: 'REFUSED',
      reason: 'TELEGRAM_REJECTED',
      errorCode: sent.errorCode,
      connectionStatus: after ?? status,
    };
  }

  /**
   * Re-reads the connection after a refusal. A failure to re-read is recorded and swallowed:
   * the send's own outcome is already decided, and a refused send must not turn into a
   * thrown one because the follow-up check could not run.
   */
  private async reverify(
    scope: ScopeContext,
    actor: ActorContext,
    connectionRowId: string,
    errorCode: string,
  ): Promise<BusinessConnectionStatus | null> {
    try {
      return await this.deps.connections.verify(scope, actor, {
        idempotencyKey: `business-connection:${connectionRowId}:verify:${this.deps.clock.now().toISOString()}`,
        connectionRowId,
      });
    } catch (error) {
      await this.deps.opsLog.record(scope, {
        code: BUSINESS_UPDATE_FAILED_CODE,
        severity: 'WARN',
        message:
          'Telegram refused a business send and NEXA could not re-read the connection afterwards.',
        dedupeKey: `${BUSINESS_UPDATE_FAILED_CODE}:reverify:${connectionRowId}`,
        context: {
          connectionRowId,
          errorCode,
          error: error instanceof Error ? error.name : 'unknown',
        },
      });
      return null;
    }
  }
}
