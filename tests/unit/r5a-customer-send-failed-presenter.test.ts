import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_NOTIFICATION_KINDS,
  CUSTOMER_NOTIFICATION_TEMPLATES,
  templateDefinition,
  type RecordedOperationalEvent,
  type TemplateKey,
  type TenantContext,
} from '@nexa/contracts';
import {
  CATALOGUE_FA,
  CUSTOMER_NOTIFICATION_KIND_NAMES_FA,
  DEFAULT_TEMPLATE_PRESENTATION,
  renderTemplateBody,
} from '@nexa/i18n';
import { OperationalEventPresenter } from '../../apps/api/src/modules/commerce/ops-log/application/event-presenter';
import { i18nOpsLogWords } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import type { OpsLogFacts } from '../../apps/api/src/modules/commerce/ops-log/application/ports';
import { notificationKindOf } from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';

/**
 * Round 5A item 1 — «ارسال پیام به مشتری انجام نشد» names WHAT could not be sent, in Persian,
 * and how many customers it touches. MUTATION: dropping the presenter branch -> the heading
 * test; dropping `notificationKind` from the messenger's context -> the kind-of-template test.
 */

const tenant = {
  tenantId: '01900000-0000-7000-8000-000000000001' as never,
  botInstanceId: null,
} as TenantContext;
const BOT = '01900000-0000-7000-8000-0000000000b1';
const asked: unknown[][] = [];
const facts = {
  undeliveredCustomerCount: async (...args: unknown[]) => {
    asked.push(args);
    return 1900;
  },
} as unknown as OpsLogFacts;
const presenter = new OperationalEventPresenter({ facts, words: i18nOpsLogWords });
const recorded: RecordedOperationalEvent = {
  id: 'ev-1',
  code: 'telegram.customer_send_failed',
  severity: 'ERROR',
  message: 'Telegram refused a customer reply.',
  occurrenceCount: 2140,
  firstSeenAt: new Date('2026-10-20T08:00:00Z'),
  lastSeenAt: new Date('2026-10-20T08:42:00Z'),
  isNew: true,
  reopened: false,
};
const render = (templateKey: string, values: unknown) =>
  renderTemplateBody(
    templateDefinition(templateKey as TemplateKey),
    CATALOGUE_FA[templateKey as TemplateKey],
    values as never,
    'fa',
    DEFAULT_TEMPLATE_PRESENTATION,
  );

describe('telegram.customer_send_failed in the operations group', () => {
  it('names the notification kind and the customers in Persian, with the code only as the technical line', async () => {
    const presented = await presenter.present(
      tenant,
      {
        code: 'telegram.customer_send_failed',
        severity: 'ERROR',
        message: recorded.message,
        context: {
          botInstanceId: BOT,
          templateKey: 'bot.service.usage_first',
          notificationKind: 'SERVICE_USAGE_FIRST',
          reason: 'REFUSED',
          errorCode: 'telegram.rejected.400',
        },
      },
      recorded,
      {} as never,
    );
    expect(presented).not.toBeNull();
    const text = render(presented!.templateKey, presented!.values);
    const headline = text.split('\n')[0] ?? '';
    expect(headline).toContain('ارسال پیام به مشتری انجام نشد');
    expect(headline).toContain(CUSTOMER_NOTIFICATION_KIND_NAMES_FA.SERVICE_USAGE_FIRST);
    expect(headline).not.toMatch(/telegram\.customer_send_failed|SERVICE_USAGE_FIRST/);
    expect(text).toContain('تعداد مشتریان در انتظار یا ناموفق: ۱۹۰۰');
    expect(text).toContain('telegram.rejected.400');
    expect(asked.at(-1)).toEqual([tenant, BOT, 'SERVICE_USAGE_FIRST', {}]);
  });

  it('a reply that is not a lane notification, or a kind this build lacks, is still named in Persian', async () => {
    for (const context of [
      { botInstanceId: BOT, templateKey: 'bot.menu.main', reason: 'REFUSED' },
      { botInstanceId: BOT, notificationKind: 'A_KIND_FROM_A_LATER_RELEASE', reason: 'UNCERTAIN' },
    ]) {
      const presented = await presenter.present(
        tenant,
        { code: 'telegram.customer_send_failed', severity: 'ERROR', message: 'x', context },
        recorded,
        {} as never,
      );
      const text = render(presented!.templateKey, presented!.values);
      expect(text.split('\n')[0]).toMatch(/[؀-ۿ]/u);
      expect(text).not.toContain('A_KIND_FROM_A_LATER_RELEASE');
    }
  });
});

describe('the kind of a message, from its template', () => {
  it('every kind of the lane maps back to itself, and every kind has a Persian name', () => {
    for (const kind of CUSTOMER_NOTIFICATION_KINDS) {
      expect(CUSTOMER_NOTIFICATION_KIND_NAMES_FA[kind], kind).toMatch(/[؀-ۿ]/u);
      const key = CUSTOMER_NOTIFICATION_TEMPLATES[kind];
      const back = notificationKindOf(key);
      // Two kinds may share a sentence; the name must then still be one of theirs.
      expect(
        CUSTOMER_NOTIFICATION_KINDS.filter((k) => CUSTOMER_NOTIFICATION_TEMPLATES[k] === key),
        kind,
      ).toContain(back);
    }
    expect(notificationKindOf('bot.service.usage_first')).toBe('SERVICE_USAGE_FIRST');
    expect(notificationKindOf('bot.menu.main')).toBeNull();
  });
});
