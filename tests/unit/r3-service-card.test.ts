import { describe, expect, it } from 'vitest';
import type { BotInstanceId, TenantContext, UnitOfWork, UserId } from '@nexa/contracts';
import {
  callbackAnswerBody,
  editMessageBody,
  isMessageNotModified,
  TELEGRAM_CALLBACK_TEXT_MAX,
} from '../../apps/api/src/infrastructure/telegram/send-message';
import {
  OperationCardEditor,
  type ClaimedCard,
  type OperationCardRepository,
} from '../../apps/api/src/modules/commerce/provisioning/application/operation-card';
import type {
  CustomerEditMessage,
  CustomerMessage,
  CustomerSendResult,
} from '../../apps/api/src/modules/commerce/messaging/application/ports';
import { cardMessageOf } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import { successAnsweredElsewhere } from '../../apps/api/src/modules/commerce/messaging/application/operation-outcome-announcer';
import type { TransactionScope } from '../../apps/api/src/infrastructure/persistence/unit-of-work';

/**
 * R3 (v0.3.5 real-test fixes): the small rules the service card rests on, each of which
 * is a way to lie on a customer's screen or to answer them twice.
 */

const scope = { tenantId: 'tenant-1', botInstanceId: null } as unknown as TenantContext;
const BOT = 'bot-1' as BotInstanceId;

describe('editing a message in place', () => {
  it('always sends the keyboard, so an old switch never survives an edit', () => {
    const body = editMessageBody({
      chatId: '42',
      messageId: 7,
      text: 'card',
      html: false,
      buttons: [],
    });
    expect(body).toEqual({
      chat_id: '42',
      message_id: 7,
      text: 'card',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [] },
    });
    expect(
      editMessageBody({ chatId: '42', messageId: 7, text: 'x', html: true, buttons: [] }),
    ).toMatchObject({ parse_mode: 'HTML' });
  });

  it('treats «message is not modified» as the state already reached, and nothing else', () => {
    expect(
      isMessageNotModified({
        outcome: 'FAILED_PERMANENT',
        errorCode: 'telegram.rejected.400',
        errorMessage:
          'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
      }),
    ).toBe(true);
    expect(
      isMessageNotModified({
        outcome: 'FAILED_PERMANENT',
        errorCode: 'telegram.rejected.400',
        errorMessage: 'Bad Request: message to edit not found',
      }),
    ).toBe(false);
    expect(
      isMessageNotModified({
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'telegram.server_error.502',
        errorMessage: 'message is not modified',
      }),
    ).toBe(false);
  });

  it('answers a button with a notice only when there is one, bounded', () => {
    expect(callbackAnswerBody({ callbackQueryId: 'q' })).toEqual({ callback_query_id: 'q' });
    expect(callbackAnswerBody({ callbackQueryId: 'q', text: 'no' })).toEqual({
      callback_query_id: 'q',
      text: 'no',
    });
    const long = callbackAnswerBody({ callbackQueryId: 'q', text: 'x'.repeat(500) });
    expect(String(long['text'])).toHaveLength(TELEGRAM_CALLBACK_TEXT_MAX);
    expect(String(long['text']).endsWith('…')).toBe(true);
  });

  it('reads the card a tap came from: a private chat and a real message id, or nothing', () => {
    const update = (chatType: string, messageId: unknown) => ({
      callback_query: {
        id: 'q',
        data: 'u:x',
        message: { message_id: messageId, chat: { id: 42, type: chatType } },
      },
    });
    expect(cardMessageOf(update('private', 7), BOT)).toEqual({
      botInstanceId: BOT,
      chatId: '42',
      messageId: 7,
    });
    expect(cardMessageOf(update('group', 7), BOT)).toBeNull();
    expect(cardMessageOf(update('private', '7'), BOT)).toBeNull();
    expect(cardMessageOf(update('private', 0), BOT)).toBeNull();
    expect(cardMessageOf({ message: { chat: { id: 42, type: 'private' } } }, BOT)).toBeNull();
  });
});

describe('who else answers a success', () => {
  it('a link change and a card switch are answered elsewhere; nothing else is', () => {
    expect(successAnsweredElsewhere({ type: 'ROTATE_SUBSCRIPTION' })).toBe(true);
    expect(successAnsweredElsewhere({ type: 'SUSPEND', answeredOnCard: true })).toBe(true);
    expect(successAnsweredElsewhere({ type: 'RESUME', answeredOnCard: true })).toBe(true);
    expect(successAnsweredElsewhere({ type: 'SUSPEND' })).toBe(false);
    expect(successAnsweredElsewhere({ type: 'RESUME', answeredOnCard: false })).toBe(false);
    for (const type of ['RENEW', 'ADD_TRAFFIC', 'ADD_TIME', 'SYNC_USAGE'] as const) {
      expect(successAnsweredElsewhere({ type, answeredOnCard: true }), type).toBe(false);
    }
  });
});

describe('the card editor', () => {
  const passthroughUow = {
    run: async <T>(_scope: unknown, work: (tx: TransactionScope) => Promise<T>) =>
      work({} as TransactionScope),
  } as unknown as UnitOfWork<TransactionScope>;

  const claimed: ClaimedCard = {
    operationId: 'op-1',
    serviceId: 'service-1',
    customerId: 'customer-1' as UserId,
    botInstanceId: BOT,
    chatId: '42',
    messageId: 7,
  };

  function editorWith(options: {
    readonly active?: boolean;
    readonly claim?: ClaimedCard | null;
    readonly card?: boolean;
    readonly edit?: CustomerSendResult;
    readonly send?: CustomerSendResult;
  }) {
    const log: string[] = [];
    const edits: CustomerEditMessage[] = [];
    const sends: CustomerMessage[] = [];
    const cards: OperationCardRepository = {
      attach: async () => undefined,
      hasCard: async () => true,
      claim: async () => {
        log.push('claim');
        return options.claim === undefined ? claimed : options.claim;
      },
      release: async () => void log.push('release'),
      dueForAnswer: async () => ['op-1'],
    };
    const editor = new OperationCardEditor({
      cards,
      renderer: {
        cardFor: async () =>
          options.card === false
            ? null
            : {
                key: 'bot.service.card',
                values: {},
                buttons: [{ label: { kind: 'TEXT', text: 'x' }, data: 'e:1' }],
              },
      },
      messenger: {
        edit: async (_scope, message) => {
          edits.push(message);
          return options.edit ?? { outcome: 'DELIVERED' };
        },
        send: async (_scope, message) => {
          sends.push(message);
          return options.send ?? { outcome: 'DELIVERED' };
        },
      },
      scopeActivity: { scopeIsActive: async () => options.active ?? true },
      uow: passthroughUow,
      clock: { now: () => new Date('2026-09-29T00:00:00Z') },
    });
    return { editor, log, edits, sends };
  }

  it('edits the card it was asked from, once, and sends nothing else', async () => {
    const { editor, edits, sends } = editorWith({});
    expect(await editor.answer(scope, 'op-1')).toBe('EDITED');
    expect(edits.map((one) => [one.chatId, one.messageId, one.botInstanceId])).toEqual([
      ['42', 7, BOT],
    ]);
    expect(sends).toEqual([]);
  });

  it('sends the card once as a new message when the old one cannot be edited', async () => {
    const { editor, sends } = editorWith({ edit: { outcome: 'REFUSED', reason: 'NOT_EDITABLE' } });
    expect(await editor.answer(scope, 'op-1')).toBe('SENT');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.templateKey).toBe('bot.service.card');
  });

  it('gives the claim back only for a rate limit', async () => {
    const limited = editorWith({ edit: { outcome: 'RATE_LIMITED', retryAfterMs: 1000 } });
    expect(await limited.editor.answer(scope, 'op-1')).toBe('RETRY');
    expect(limited.log).toEqual(['claim', 'release']);
    expect(limited.sends).toEqual([]);

    const unknown = editorWith({ edit: { outcome: 'UNKNOWN' } });
    expect(await unknown.editor.answer(scope, 'op-1')).toBe('UNKNOWN');
    expect(unknown.log).toEqual(['claim']);
    expect(unknown.sends, 'an edit that may have landed is not followed by a send').toEqual([]);
  });

  it('claims nothing for a stopped tenant, and draws nothing for a service no longer theirs', async () => {
    const stopped = editorWith({ active: false });
    expect(await stopped.editor.answer(scope, 'op-1')).toBe('INACTIVE');
    expect(stopped.log).toEqual([]);

    const gone = editorWith({ card: false });
    expect(await gone.editor.answer(scope, 'op-1')).toBe('GONE');
    expect(gone.edits).toEqual([]);
    expect(gone.sends).toEqual([]);

    const none = editorWith({ claim: null });
    expect(await none.editor.answer(scope, 'op-1')).toBe('NONE');
    expect(none.edits).toEqual([]);
  });
});
