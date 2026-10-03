import { describe, expect, it } from 'vitest';
import {
  normaliseOpsConnectCode,
  notificationDestinationSchema,
  opsLogTopicCategoryOf,
  opsLogTopicForCode,
  OPS_CONNECT_CODE_ALPHABET,
  OPS_CONNECT_CODE_LENGTH,
  OPS_GROUP_MANAGED_SETTING_KEYS,
  OPS_LOG_TOPIC_CATEGORIES,
  OPS_LOG_TOPIC_NAME_TEMPLATES,
  OPS_LOG_TOPIC_ROUTES,
  settingDefinition,
  type SettingKey,
} from '@nexa/contracts';
import {
  chatAccessProblemOf,
  isMissingForumTopicError,
} from '../../apps/api/src/infrastructure/telegram/send-message';
import {
  DETAIL_KEYS,
  OPERATIONAL_MESSAGE_BUDGET,
  TELEGRAM_MESSAGE_MAX,
  boundedForTelegram,
  operationalEventDetails,
} from '../../apps/api/src/modules/control/notifications/application/event-details';
import { CATALOGUE_FA, escapeTelegramHtml, renderTemplateBody } from '@nexa/i18n';
import { templateDefinition } from '@nexa/contracts';
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
  it('sends payments events to the payments topic and anything unclaimed to the system topic', () => {
    expect(opsLogTopicForCode('payments.gateway_misconfigured')).toBe('PAYMENTS');
    expect(opsLogTopicForCode('order.refunded_undeliverable')).toBe('PAYMENTS');
    expect(opsLogTopicForCode('')).toBe('SYSTEM');
    expect(opsLogTopicForCode('something.nobody_routed')).toBe('SYSTEM');
  });

  /**
   * Spec §12: every code prefix the installation records today, each in the topic its
   * concern belongs to. The table is the real vocabulary (grepped from the recorders), so
   * a route that is deleted or reordered — `order.` above `order.refunded_undeliverable`,
   * say, which would move a refund out of the payments log — fails here by name.
   */
  it.each([
    ['payments.gateway_late_completion', 'PAYMENTS'],
    ['payments.receipt_push_failed', 'PAYMENTS'],
    ['order.refunded_undeliverable', 'PAYMENTS'],
    ['fx.source_unavailable', 'PAYMENTS'],
    ['backup.run_failed', 'BACKUPS'],
    ['backup.run_ok', 'BACKUPS'],
    ['recovery.run_failed', 'BACKUPS'],
    ['panel.health.unreachable', 'PANELS'],
    ['panel.capacity.full', 'PANELS'],
    ['provisioning.stalled', 'SERVICES'],
    ['provisioning.delivered', 'SERVICES'],
    ['access.permission_denied', 'SECURITY'],
    ['auth.login_locked_out', 'SECURITY'],
    ['admin.roles_changed', 'SECURITY'],
    ['antispam.unavailable', 'SECURITY'],
    ['telegram.customer_send_failed', 'BOT'],
    ['bot.command_sync_failing', 'BOT'],
    ['bot_menu.published_unreadable', 'BOT'],
    ['channels.membership_unavailable', 'BOT'],
    ['internal.unhandled', 'ERRORS'],
    ['http.error', 'ERRORS'],
    ['outbox.message_exhausted', 'SYSTEM'],
    ['notification.attempts_exhausted', 'SYSTEM'],
    ['settings.stored_value_invalid', 'SYSTEM'],
    ['ops_group.topic_recreated', 'SYSTEM'],
    ['system.ping', 'SYSTEM'],
  ] as const)('routes %s to %s', (code, category) => {
    expect(opsLogTopicForCode(code)).toBe(category);
  });

  it('gives every topic a route, a Persian name and its own template', () => {
    // A category nothing routes to is a topic that is created and stays empty — except
    // SYSTEM, the explicit fallback, which needs no route of its own.
    const routed = new Set(OPS_LOG_TOPIC_ROUTES.map((route) => route.category));
    for (const category of OPS_LOG_TOPIC_CATEGORIES) {
      if (category !== 'SYSTEM') expect(routed.has(category), category).toBe(true);
    }
    const keys = Object.values(OPS_LOG_TOPIC_NAME_TEMPLATES);
    expect(new Set(keys).size).toBe(OPS_LOG_TOPIC_CATEGORIES.length);
    for (const key of keys) {
      expect(CATALOGUE_FA[key as keyof typeof CATALOGUE_FA], key).toMatch(/[؀-ۿ]/);
    }
    // The owner named this one exactly (spec §13.1).
    expect(CATALOGUE_FA[OPS_LOG_TOPIC_NAME_TEMPLATES.BACKUPS]).toBe('💾 بکاپ‌ها');
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

  it('accepts a chat-less destination only when it is routed to an operations topic (HF-A4)', () => {
    // Queued while no group was connected: nothing to snapshot, still routed to the group.
    const waiting = { transport: 'TELEGRAM', chatId: null, topicId: null, opsTopic: 'PAYMENTS' };
    expect(notificationDestinationSchema.parse(waiting)).toEqual(waiting);
    // Without a route there would be nowhere to send it, ever: refused.
    expect(
      notificationDestinationSchema.safeParse({
        transport: 'TELEGRAM',
        chatId: null,
        topicId: null,
      }).success,
    ).toBe(false);
    expect(
      notificationDestinationSchema.safeParse({ ...waiting, chatId: '' }).success,
      'an empty chat is not "no chat"',
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

describe('the rendered event fits one Telegram message (Codex review #1 of PR #99)', () => {
  it('renders a maximal event under 4096 characters, code and correlation id intact', () => {
    // Every allowed key at its longest, in the character that escapes worst (`&` is five).
    const context = Object.fromEntries(DETAIL_KEYS.map((key) => [key, '&'.repeat(500)]));
    const details = operationalEventDetails(context);
    expect(details).toMatch(/… \(\+\d+ more\)$/);
    const rendered = renderTemplateBody(
      templateDefinition('ops.notification.operational_event'),
      CATALOGUE_FA['ops.notification.operational_event'],
      {
        severity: 'CRITICAL',
        code: 'payments.gateway_create_unknown',
        message: boundedForTelegram('<'.repeat(10_000), OPERATIONAL_MESSAGE_BUDGET),
        occurrences: 123456,
        firstSeenAt: new Date('2026-09-01T10:00:00Z'),
        lastSeenAt: new Date('2026-09-01T11:00:00Z'),
        tenantId: '01900000-0000-7000-8000-000000000001',
        botInstanceId: '01900000-0000-7000-8000-00000000a001',
        correlationId: boundedForTelegram('c'.repeat(500), 100),
        ...(details ? { details } : {}),
      },
    );
    expect(rendered.length).toBeLessThan(TELEGRAM_MESSAGE_MAX);
    expect(rendered).toContain('payments.gateway_create_unknown');
    expect(rendered).toContain('CRITICAL');
    expect(rendered).toContain('c'.repeat(90));
  });

  it('cuts text by its escaped length and says it did', () => {
    expect(boundedForTelegram('short', 100)).toBe('short');
    const cut = boundedForTelegram('&'.repeat(100), 50);
    expect(cut.endsWith('…')).toBe(true);
    expect(escapeTelegramHtml(cut).length).toBeLessThanOrEqual(50);
    // The local count agrees with the real escaper on every character it widens.
    const mixed = `a&<>"'b`.repeat(40);
    const bounded = boundedForTelegram(mixed, 120);
    expect(escapeTelegramHtml(bounded).length).toBeLessThanOrEqual(120);
  });
});
