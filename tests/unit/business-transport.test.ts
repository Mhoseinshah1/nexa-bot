import { describe, expect, it, vi } from 'vitest';
import { systemJobActor, type CorrelationId } from '@nexa/contracts';
import { BusinessTransport } from '../../apps/api/src/modules/commerce/business-chats/application/business-transport';
import type {
  BusinessConnectionRecord,
  BusinessTelegramGateway,
} from '../../apps/api/src/modules/commerce/business-chats/application/ports';
import { businessTextMessageBody } from '../../apps/api/src/infrastructure/telegram/send-message';

/**
 * TB1 — the send-on-behalf transport (ADR-0033 §2, §6).
 *
 * What it owns is the connection and the outcome taxonomy: a connection that is not ACTIVE
 * is refused before any request, a 429 is not an unknown outcome, an unknown outcome is
 * never presented as a refusal (and so never resent), and a refusal re-reads the connection.
 */

const scope = { tenantId: 'tenant-a', botInstanceId: null } as never;
const actor = systemJobActor('business-test', 'c' as CorrelationId);

const active: BusinessConnectionRecord = {
  id: 'row-1',
  tenantId: 'tenant-a',
  botInstanceId: 'bot-1',
  connectionId: 'conn-1',
  ownerTelegramUserId: '5000001',
  ownerUserChatId: '5000001',
  isEnabled: true,
  rights: ['can_reply'],
  connectedAt: new Date(0),
  lastConfirmedAt: new Date(0),
  supersededAt: null,
  version: 1,
};

function transportWith(
  connection: BusinessConnectionRecord | null,
  answer: Awaited<ReturnType<BusinessTelegramGateway['sendText']>> = {
    outcome: 'SUCCEEDED',
    messageId: 55,
  },
) {
  const telegram = {
    getConnection: vi.fn(),
    sendText: vi.fn(async () => answer),
  };
  const connections = { verify: vi.fn(async () => 'DISABLED' as const) };
  const opsLog = { record: vi.fn(async () => ({ isNew: true, reopened: false })) };
  const transport = new BusinessTransport({
    repository: { findById: vi.fn(async () => connection) } as never,
    connections: connections as never,
    telegram,
    tokens: { tokenForBotInstance: vi.fn(async () => 'token') },
    opsLog: opsLog as never,
    clock: { now: () => new Date('2026-10-04T10:00:00Z') },
  });
  const send = (text = 'سلام') =>
    transport.sendText(scope, actor, { connectionRowId: 'row-1', chatId: '7000001', text });
  return { transport, telegram, connections, opsLog, send };
}

describe('sending as a connected Business account', () => {
  it('delivers through the connection, returning the message id that later proves an echo is ours', async () => {
    const { telegram, send } = transportWith(active);
    expect(await send()).toEqual({ outcome: 'DELIVERED', messageId: 55 });
    expect(telegram.sendText).toHaveBeenCalledWith('token', {
      businessConnectionId: 'conn-1',
      chatId: '7000001',
      text: 'سلام',
    });
  });

  it.each([
    ['disabled', { ...active, isEnabled: false }, 'DISABLED'],
    [
      'without can_reply',
      { ...active, rights: ['can_read_messages' as const] },
      'RIGHTS_INSUFFICIENT',
    ],
    ['superseded', { ...active, supersededAt: new Date(1) }, 'SUPERSEDED'],
  ])('refuses before any request when the connection is %s', async (_label, connection, status) => {
    const { telegram, send } = transportWith(connection);
    expect(await send()).toEqual({
      outcome: 'REFUSED',
      reason: 'CONNECTION_UNUSABLE',
      errorCode: null,
      connectionStatus: status,
    });
    expect(telegram.sendText).not.toHaveBeenCalled();
  });

  it('refuses an unknown connection and empty text without calling Telegram', async () => {
    const missing = transportWith(null);
    expect((await missing.send()).outcome).toBe('REFUSED');
    expect(missing.telegram.sendText).not.toHaveBeenCalled();
    const empty = transportWith(active);
    expect(await empty.send('   ')).toMatchObject({ outcome: 'REFUSED', reason: 'INVALID_TEXT' });
    expect(empty.telegram.sendText).not.toHaveBeenCalled();
  });

  it('keeps a 429 apart from an unknown outcome', async () => {
    const { send } = transportWith(active, {
      outcome: 'FAILED_RETRYABLE',
      errorCode: 'telegram.rate_limited',
      retryAfterMs: 3000,
    });
    expect(await send()).toEqual({ outcome: 'RATE_LIMITED', retryAfterMs: 3000 });
  });

  it.each(['telegram.server_error.502', 'telegram.unreachable', 'telegram.unreadable_response'])(
    'reports %s as UNKNOWN — it may have been delivered — and re-reads nothing',
    async (errorCode) => {
      const { connections, send } = transportWith(active, {
        outcome: 'FAILED_RETRYABLE',
        errorCode,
      });
      expect(await send()).toEqual({ outcome: 'UNKNOWN', errorCode });
      expect(connections.verify).not.toHaveBeenCalled();
    },
  );

  it('re-reads the connection after Telegram refuses, and reports what it found', async () => {
    const { connections, send } = transportWith(active, {
      outcome: 'FAILED_PERMANENT',
      errorCode: 'telegram.rejected.403',
    });
    expect(await send()).toEqual({
      outcome: 'REFUSED',
      reason: 'TELEGRAM_REJECTED',
      errorCode: 'telegram.rejected.403',
      connectionStatus: 'DISABLED',
    });
    expect(connections.verify).toHaveBeenCalledOnce();
  });

  it('keeps the refusal when the re-read itself fails, and records that', async () => {
    const { connections, opsLog, send } = transportWith(active, {
      outcome: 'FAILED_PERMANENT',
      errorCode: 'telegram.rejected.400',
    });
    connections.verify.mockRejectedValueOnce(new Error('database unavailable'));
    expect(await send()).toMatchObject({ outcome: 'REFUSED', connectionStatus: 'ACTIVE' });
    expect(opsLog.record).toHaveBeenCalledOnce();
  });
});

describe('the business sendMessage body', () => {
  it('names the connection, sends plain text, and never a reply chat id', () => {
    const body = businessTextMessageBody({
      businessConnectionId: 'conn-1',
      chatId: '7000001',
      text: '<b>x</b>',
      replyToMessageId: 9,
    });
    expect(body).toEqual({
      business_connection_id: 'conn-1',
      chat_id: '7000001',
      text: '<b>x</b>',
      link_preview_options: { is_disabled: true },
      reply_parameters: { message_id: 9, allow_sending_without_reply: true },
    });
    expect(body).not.toHaveProperty('parse_mode');
  });
});
