import { describe, expect, it } from 'vitest';
import {
  normaliseOpsConnectCode,
  notificationDestinationSchema,
  opsLogTopicCategoryOf,
  opsLogTopicForCode,
  OPS_CONNECT_CODE_ALPHABET,
  OPS_CONNECT_CODE_LENGTH,
  OPS_GROUP_MANAGED_SETTING_KEYS,
  settingDefinition,
  type SettingKey,
} from '@nexa/contracts';
import {
  chatAccessProblemOf,
  isMissingForumTopicError,
} from '../../apps/api/src/infrastructure/telegram/send-message';
import { operationalEventDetails } from '../../apps/api/src/modules/control/notifications/application/event-details';
import {
  hashOpsConnectCode,
  newOpsConnectCode,
} from '../../apps/api/src/modules/control/ops-group/application/connect-code';
import {
  opsConnectAttemptOf,
  opsMembershipChangeOf,
} from '../../apps/api/src/surfaces/telegram/ops-group-updates';

/** WP-A4: the operations log group's pure rules. */

describe('connection codes', () => {
  it('draws from the alphabet, at the length, and differs every time', () => {
    const codes = new Set(Array.from({ length: 200 }, () => newOpsConnectCode()));
    expect(codes.size).toBe(200);
    for (const code of codes) {
      expect(code).toHaveLength(OPS_CONNECT_CODE_LENGTH);
      for (const character of code) expect(OPS_CONNECT_CODE_ALPHABET).toContain(character);
    }
  });

  it('normalises what a person or a deep link sends, and refuses anything else', () => {
    const code = newOpsConnectCode();
    expect(normaliseOpsConnectCode(code)).toBe(code);
    expect(normaliseOpsConnectCode(`ops-${code}`)).toBe(code);
    expect(normaliseOpsConnectCode(`OPS-${code.toLowerCase()}`)).toBe(code);
    expect(normaliseOpsConnectCode(` ${code} `)).toBe(code);
    expect(normaliseOpsConnectCode(code.slice(1))).toBeNull();
    expect(normaliseOpsConnectCode(`${code}A`)).toBeNull();
    // 0, O, 1, I, L and U are not in the alphabet.
    expect(normaliseOpsConnectCode('0'.repeat(OPS_CONNECT_CODE_LENGTH))).toBeNull();
    expect(normaliseOpsConnectCode('')).toBeNull();
  });

  it('stores a digest that does not contain the code', () => {
    const code = newOpsConnectCode();
    const hash = hashOpsConnectCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(code);
    expect(hashOpsConnectCode(code)).toBe(hash);
  });
});

describe('the webhook shapes', () => {
  const chat = { id: -1001, type: 'supergroup', title: 'Ops', is_forum: true };
  const message = (text: string, over: Record<string, unknown> = {}) => ({
    update_id: 1,
    message: { message_id: 1, text, chat: { ...chat, ...over } },
  });

  it('reads the deep link’s /start and the typed command in a group', () => {
    expect(opsConnectAttemptOf(message('/start ops-ABC'))?.rawCode).toBe('ops-ABC');
    expect(opsConnectAttemptOf(message('/start@acme_bot ops-ABC'))?.rawCode).toBe('ops-ABC');
    expect(opsConnectAttemptOf(message('/connect_ops ABC'))?.rawCode).toBe('ABC');
    expect(opsConnectAttemptOf(message('/connect_ops@acme_bot ABC'))).toMatchObject({
      rawCode: 'ABC',
      chat: { id: '-1001', type: 'supergroup', title: 'Ops', isForum: true },
    });
    expect(opsConnectAttemptOf(message('/connect_ops'))?.rawCode).toBe('');
  });

  it('ignores the same text in a private chat, a plain /start and other commands', () => {
    expect(opsConnectAttemptOf(message('/start ops-ABC', { type: 'private', id: 42 }))).toBeNull();
    expect(opsConnectAttemptOf(message('/start'))).toBeNull();
    expect(opsConnectAttemptOf(message('/start ref-ABC'))).toBeNull();
    expect(opsConnectAttemptOf(message('/help'))).toBeNull();
    expect(opsConnectAttemptOf(message('hello /connect_ops ABC'))).toBeNull();
    expect(opsConnectAttemptOf({ update_id: 1 })).toBeNull();
  });

  it('reads the bot’s own membership change', () => {
    expect(
      opsMembershipChangeOf({
        update_id: 1,
        my_chat_member: { chat: { id: -1001 }, new_chat_member: { status: 'kicked' } },
      }),
    ).toEqual({ chatId: '-1001', status: 'kicked' });
    expect(opsMembershipChangeOf({ update_id: 1, message: {} })).toBeNull();
  });
});

describe('routing, not severity', () => {
  it('sends payments events to the payments topic and the rest to the system topic', () => {
    expect(opsLogTopicForCode('payments.gateway_misconfigured')).toBe('PAYMENTS');
    expect(opsLogTopicForCode('order.refunded_undeliverable')).toBe('PAYMENTS');
    expect(opsLogTopicForCode('panel.health.unreachable')).toBe('SYSTEM');
    expect(opsLogTopicForCode('backup.run_failed')).toBe('SYSTEM');
    expect(opsLogTopicForCode('')).toBe('SYSTEM');
  });

  it('routes a category a later release wrote to the system topic instead of failing it', () => {
    expect(opsLogTopicCategoryOf('PAYMENTS')).toBe('PAYMENTS');
    expect(opsLogTopicCategoryOf('SUPPORT')).toBe('SYSTEM');
  });

  it('keeps a stored destination readable with and without the route', () => {
    const base = { transport: 'TELEGRAM', chatId: '-1001', topicId: 7 } as const;
    expect(notificationDestinationSchema.parse(base)).toEqual(base);
    expect(notificationDestinationSchema.parse({ ...base, opsTopic: 'SYSTEM' })).toEqual({
      ...base,
      opsTopic: 'SYSTEM',
    });
    expect(
      notificationDestinationSchema.safeParse({ ...base, opsTopic: 'no spaces' }).success,
    ).toBe(false);
  });

  it('retires min_severity without breaking a stored value, and makes ten attempts the default', () => {
    const severity = settingDefinition('ops.notifications.min_severity' as SettingKey);
    expect(severity.consumer).toBe('PLANNED');
    expect(severity.configures).toBeNull();
    expect(severity.schema.safeParse('ERROR').success).toBe(true);
    expect(settingDefinition('ops.notifications.max_attempts' as SettingKey).defaultValue).toBe(10);
    expect(OPS_GROUP_MANAGED_SETTING_KEYS).toContain('ops.notifications.min_severity');
    expect(OPS_GROUP_MANAGED_SETTING_KEYS).toContain('ops.notifications.max_attempts');
    // The throughput ceiling stays an ordinary setting.
    expect(OPS_GROUP_MANAGED_SETTING_KEYS).not.toContain('ops.notifications.max_per_minute');
  });
});

describe('what an event may print', () => {
  it('prints allowed ids, the transition and the reason, in order', () => {
    expect(
      operationalEventDetails({
        orderId: 'o-1',
        paymentId: 'p-1',
        from: 'AWAITING_PAYMENT',
        to: 'PAID',
        reason: 'late',
      }),
    ).toBe('orderId: o-1\npaymentId: p-1\nfrom: AWAITING_PAYMENT\nto: PAID\nreason: late');
  });

  it('prints nothing it does not know to be safe', () => {
    const printed =
      operationalEventDetails({
        token: '1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw',
        password: 'hunter2',
        subscriptionUrl: 'https://panel.example/sub/abc',
        payload: { card: '6037991234567890' },
        serviceId: { nested: 'object' },
      }) ?? '';
    expect(printed).toBe('');
  });

  it('redacts a secret quoted inside an allowed value', () => {
    const printed =
      operationalEventDetails({
        reason: 'call to /bot1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage failed',
      }) ?? '';
    expect(printed).toContain('reason:');
    expect(printed).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
  });

  it('is absent for an event with no context, so the template drops the line', () => {
    expect(operationalEventDetails(undefined)).toBeUndefined();
    expect(operationalEventDetails({})).toBeUndefined();
  });
});

describe('what Telegram refusals mean', () => {
  it('recognises a deleted topic', () => {
    expect(isMissingForumTopicError('Bad Request: message thread not found')).toBe(true);
    expect(isMissingForumTopicError('Bad Request: TOPIC_DELETED')).toBe(true);
    expect(isMissingForumTopicError('Bad Request: chat not found')).toBe(false);
  });

  it('tells a chat problem from a message problem', () => {
    expect(chatAccessProblemOf('Forbidden: bot was kicked from the supergroup chat')).toBe(
      'BOT_REMOVED',
    );
    expect(chatAccessProblemOf('Bad Request: chat not found')).toBe('CHAT_UNREACHABLE');
    expect(
      chatAccessProblemOf('Bad Request: not enough rights to send text messages to the chat'),
    ).toBe('CANNOT_SEND');
    expect(chatAccessProblemOf('Bad Request: message is too long')).toBeNull();
  });
});
