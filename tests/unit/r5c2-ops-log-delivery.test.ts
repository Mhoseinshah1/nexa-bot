import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  money,
  templateDefinition,
  type OperationalEventInput,
  type RecordedOperationalEvent,
  type TemplateKey,
  type TenantContext,
} from '@nexa/contracts';
import { CATALOGUE_FA, DEFAULT_TEMPLATE_PRESENTATION, renderTemplateBody } from '@nexa/i18n';
import { toItem } from '../../apps/api/src/surfaces/web/notification-center.controller';
import { OperationalEventPresenter } from '../../apps/api/src/modules/commerce/ops-log/application/event-presenter';
import { serviceCreated } from '../../apps/api/src/modules/commerce/ops-log/application/presenters';
import { i18nOpsLogWords } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import type {
  CustomerFact,
  OpsLogFacts,
  OrderFact,
  PaymentFact,
  ServiceFact,
} from '../../apps/api/src/modules/commerce/ops-log/application/ports';
import { NotifyingOperationalEventRecorder } from '../../apps/api/src/modules/control/notifications/application/operational-event-projector';

/**
 * R5C-2 C1 — the services topic and the errors topic for a delivered or stalled service.
 *
 * - `provisioning.delivered` no longer posts a generic English INFO line when the purchase's
 *   own message (L10/L11) covers it.
 * - `provisioning.stalled` is the L23 error report for a service that was not created, or the
 *   R5A-2 wording (L24) for any other operation, with every field.
 * - L10 renders every field of a purchase from a synthetic fixture.
 *
 * MUTATION: dropping the `provisioning.delivered` branch of `suppresses` fails the first two
 * tests; routing a PROVISION stall back to the generic layout fails the L23 test. R10 B5:
 * `customer.source !== 'NEXA'` put back in `provisioningReport` fails both "R10 B5 — a stall
 * of an imported ..." cases, `service.source !== 'NEXA'` the imported-service one.
 */

const tenant = {
  tenantId: '01900000-0000-7000-8000-000000000001' as never,
  botInstanceId: null,
} as TenantContext;
const AT = new Date('2026-10-20T08:00:00Z');
const MONEY = (n: number) => money(BigInt(n), 'IRT');

const customer: CustomerFact = {
  id: 'cust-1',
  telegramUserId: '700100200',
  username: 'nima_t',
  firstName: 'نیما',
  lastName: 'تهرانی',
  phone: '09120000000',
  source: 'NEXA',
  status: 'ACTIVE',
  blockedReason: null,
};
const order: OrderFact = {
  id: 'ord-1',
  code: 'KQ7M2X9T',
  customerId: 'cust-1',
  purpose: 'NEW_SERVICE',
  origin: 'STANDARD',
  source: 'NEXA',
  state: 'FULFILLED',
  title: 'پلن ۳۰ روزه',
  durationDays: 30,
  trafficBytes: 53_687_091_200n,
  panelId: 'panel-1',
  panelName: 'آلمان ۱',
  locationLabel: '🇩🇪 آلمان',
  subtotal: MONEY(300_000),
  discount: MONEY(50_000),
  total: MONEY(250_000),
  settledAt: AT,
  isFirstPurchase: true,
  reseller: true,
  resellerListPrice: MONEY(300_000),
};
const service: ServiceFact = {
  id: 'svc-1',
  code: 'SV3K9P2Q',
  customerId: 'cust-1',
  orderId: 'ord-1',
  panelId: 'panel-1',
  panelName: 'آلمان ۱',
  providerUsername: 'nx7k2m9q',
  isTrial: false,
  state: 'ACTIVE',
  expiresAt: null,
  trafficLimitBytes: 53_687_091_200n,
  trafficUsedBytes: 0n,
  lastSeenAt: null,
  source: 'NEXA',
};
const payment: PaymentFact = {
  id: 'pay-1',
  code: 'RT4W8N2B',
  reference: 'ref-1',
  method: 'MANUAL_TRANSFER',
  gatewayProvider: null,
  amount: MONEY(250_000),
  state: 'CONFIRMED',
};

const facts = {
  service: async () => service,
  customer: async () => customer,
  order: async () => order,
  paymentOfOrder: async () => payment,
} as unknown as OpsLogFacts;
const presenter = new OperationalEventPresenter({ facts, words: i18nOpsLogWords });

const recorded: RecordedOperationalEvent = {
  id: 'ev-1',
  code: 'provisioning.stalled',
  severity: 'ERROR',
  message: 'x',
  occurrenceCount: 1,
  firstSeenAt: AT,
  lastSeenAt: AT,
  isNew: true,
  reopened: false,
};
const stalled = (context: Record<string, unknown>): OperationalEventInput => ({
  code: 'provisioning.stalled',
  severity: 'ERROR',
  message: 'x',
  context: { serviceId: 'svc-1', panelId: 'panel-1', ...context },
});
const delivered = (context: Record<string, unknown>): OperationalEventInput => ({
  code: 'provisioning.delivered',
  severity: 'INFO',
  message: 'A paid service was created on its panel.',
  context,
});
const render = (templateKey: string, values: unknown) =>
  renderTemplateBody(
    templateDefinition(templateKey as TemplateKey),
    CATALOGUE_FA[templateKey as TemplateKey],
    values as never,
    'fa',
    DEFAULT_TEMPLATE_PRESENTATION,
  );

describe('provisioning.delivered posts no generic line (the purchase message covers it)', () => {
  it('is suppressed for a created service, and (R10 B5) for one adopted after a lost answer', () => {
    expect(presenter.suppresses(delivered({ serviceId: 'svc-1' }))).toBe(true);
    // The adoption now emits `ServiceProvisioned`, so its «🛒 خرید جدید» covers it too.
    expect(presenter.suppresses(delivered({ serviceId: 'svc-1', adopted: true }))).toBe(true);
  });

  it('queues nothing through the projector, while the event is still recorded', async () => {
    const queued: unknown[] = [];
    const recordedInputs: OperationalEventInput[] = [];
    const projector = new NotifyingOperationalEventRecorder(
      {
        record: async (_scope: unknown, input: OperationalEventInput) => {
          recordedInputs.push(input);
          return { ...recorded, code: input.code, isNew: true };
        },
      } as never,
      { queue: async (_scope: unknown, input: unknown) => queued.push(input) } as never,
      {
        runNested: async (_s: unknown, _tx: unknown, fn: (tx: unknown) => unknown) => fn({}),
      } as never,
      { error: () => undefined } as never,
      presenter,
    );
    await projector.record(tenant, delivered({ serviceId: 'svc-1' }), {});
    await projector.record(tenant, delivered({ serviceId: 'svc-1', adopted: true }), {});
    expect(recordedInputs).toHaveLength(2);
    expect(queued).toEqual([]);
  });
});

describe('R10 B5 — a stall of an imported customer’s or service’s operation is still the error report', () => {
  /*
   * A stall is an operation THIS installation performed; the import performs none. Refusing a
   * `MIRZA` customer or service sent the owner's error report back to the generic English
   * layout for every migrated customer.
   */
  const importedFacts = (who: 'customer' | 'service') =>
    ({
      service: async () => (who === 'service' ? { ...service, source: 'MIRZA' } : service),
      customer: async () => ({ ...customer, source: 'MIRZA' }),
      order: async () => order,
      paymentOfOrder: async () => payment,
    }) as unknown as OpsLogFacts;

  it.each(['customer', 'service'] as const)(
    'an imported %s: a PROVISION stall is L23 and a RENEW stall L24',
    async (who) => {
      const imported = new OperationalEventPresenter({
        facts: importedFacts(who),
        words: i18nOpsLogWords,
      });
      const provision = await imported.present(
        tenant,
        stalled({ reason: 'ATTEMPTS_SPENT', operationType: 'PROVISION' }),
        recorded,
        {},
      );
      expect(provision?.logType).toBe('ERROR_PROVISION');
      const renew = await imported.present(
        tenant,
        stalled({ reason: 'ATTEMPTS_SPENT', operationType: 'RENEW' }),
        recorded,
        {},
      );
      expect(renew?.logType).toBe('ERROR_OPERATION');
    },
  );

  it('a PROVISION stall of an order the import wrote keeps the generic layout', async () => {
    const imported = new OperationalEventPresenter({
      facts: {
        service: async () => service,
        customer: async () => customer,
        order: async () => ({ ...order, source: 'MIRZA' }),
        paymentOfOrder: async () => payment,
      } as unknown as OpsLogFacts,
      words: i18nOpsLogWords,
    });
    const presented = await imported.present(
      tenant,
      stalled({ reason: 'ATTEMPTS_SPENT', operationType: 'PROVISION' }),
      recorded,
      {},
    );
    expect(presented?.logType).toBeUndefined();
  });
});

describe('provisioning.stalled is the error report, with every field', () => {
  it('a PROVISION stall is L23: customer, product, panel, amount, cause, technical, impact, codes', async () => {
    const presented = await presenter.present(
      tenant,
      stalled({ reason: 'ATTEMPTS_SPENT', operationType: 'PROVISION' }),
      recorded,
      {},
    );
    expect(presented).not.toBeNull();
    expect(presented!.templateKey).toBe('ops.log.error_provision');
    expect(presented!.logType).toBe('ERROR_PROVISION');
    const text = render(presented!.templateKey, presented!.values);
    expect(text).toContain('🚨 سرویس ساخته نشد');
    expect(text).toContain('👤 نیما تهرانی · @nima_t · 700100200');
    expect(text).toContain('📦 پلن ۳۰ روزه');
    expect(text).toContain('🖥 پنل: آلمان ۱');
    expect(text).toContain('💰 مبلغ: ۲۵۰٬۰۰۰ تومان');
    expect(text).toContain('❗ علت: تلاش‌های ساخت سرویس تمام شد و پنل خطا داد');
    expect(text).toContain('🔧 کد: ATTEMPTS_SPENT');
    expect(text).toContain('پول برنمی‌گردد تا نتیجه روشن شود');
    expect(text).toContain('🔖 کد سفارش: KQ7M2X9T');
    expect(text).toContain('🔖 کد پرداخت: RT4W8N2B');
    expect(presented!.buttons).toEqual([
      { kind: 'PANEL', ref: 'panel-1' },
      { kind: 'USER', ref: 'cust-1' },
    ]);
    // None of the generic layout's English survives.
    expect(text).not.toMatch(/provisioning\.stalled|A paid service|تعداد رخداد/);
  });

  it('a stall with no operation type is NOT a PROVISION stall: the generic layout, no order read', async () => {
    const presented = await presenter.present(
      tenant,
      stalled({ reason: 'CALL_STRANDED' }),
      recorded,
      {},
    );
    expect(presented).toBeNull();
  });

  it('a non-PROVISION stall is L24 under the R5A-2 wording, and claims no order or amount', async () => {
    const presented = await presenter.present(
      tenant,
      stalled({ reason: 'ALLOWANCE_UNVERIFIED', operationType: 'RENEW' }),
      recorded,
      {},
    );
    expect(presented!.templateKey).toBe('ops.log.error_operation');
    const text = render(presented!.templateKey, presented!.values);
    expect(text).toContain('تمدید سرویس ناموفق ماند — نتیجه نامشخص');
    expect(text).toContain('🔑 نام سرویس: nx7k2m9q');
    expect(text).toContain('🖥 پنل: آلمان ۱');
    expect(text).toContain('❗ علت: اعمال تغییر روی پنل تأیید نشد');
    expect(text).not.toMatch(/ساخت سرویس|💰|کد سفارش|کد پرداخت/);
  });

  it('is withheld when a refund or an UNKNOWN-outcome report already answers it', () => {
    expect(presenter.suppresses(stalled({ reason: 'EXHAUSTED', answeredBy: 'REFUND' }))).toBe(true);
    expect(presenter.suppresses(stalled({ reason: 'UNRECONCILED' }))).toBe(true);
    expect(presenter.suppresses(stalled({ reason: 'ATTEMPTS_SPENT' }))).toBe(false);
  });

  it('falls back to the generic layout when the service cannot be read', async () => {
    const blind = new OperationalEventPresenter({
      facts: { ...facts, service: async () => null } as unknown as OpsLogFacts,
      words: i18nOpsLogWords,
    });
    expect(
      await blind.present(tenant, stalled({ reason: 'ATTEMPTS_SPENT' }), recorded, {}),
    ).toBeNull();
  });
});

describe('the notification center row names the stalled operation (C1)', () => {
  const view = (code: string, context: Record<string, unknown> | null) =>
    ({
      id: 'ev-1',
      code,
      category: 'PROVISIONING',
      severity: 'ERROR',
      message: 'x',
      occurrenceCount: 1,
      firstSeenAt: AT,
      lastSeenAt: AT,
      resolvedAt: null,
      read: false,
      link: { target: 'SERVICE', id: null },
      context,
    }) as never;

  it('carries a known operation type for provisioning.stalled, and nothing else', () => {
    expect(toItem(view('provisioning.stalled', { operationType: 'RENEW' })).operationType).toBe(
      'RENEW',
    );
    expect(
      toItem(view('provisioning.stalled', { operationType: 'NOT_A_TYPE' })),
    ).not.toHaveProperty('operationType');
    expect(toItem(view('provisioning.stalled', null))).not.toHaveProperty('operationType');
    expect(toItem(view('backup.run_failed', { operationType: 'RENEW' }))).not.toHaveProperty(
      'operationType',
    );
  });
});

describe('L10 — a service created after a purchase, with every field', () => {
  it('renders customer, product, panel, username, volume, days, price, codes, badges and buttons', () => {
    const built = serviceCreated({
      order,
      service,
      customer,
      payment,
      walletBalance: null,
      origin: null,
      at: AT,
      words: i18nOpsLogWords,
    });
    expect(built.logType).toBe('SERVICE_CREATED');
    const text = render(built.templateKey, built.values);
    expect(text.split('\n')[0]).toBe('🛒 خرید جدید · 🥇 اولین خرید · 🧑‍💼 نماینده');
    expect(text).toContain('👤 نیما تهرانی · @nima_t · 700100200');
    expect(text).toContain('📞 شماره: 09120000000');
    expect(text).toContain('📦 پلن ۳۰ روزه');
    expect(text).toContain('📍 لوکیشن: 🇩🇪 آلمان');
    expect(text).toContain('📊 حجم: ۵۰ گیگابایت');
    expect(text).toContain('⏳ مدت: ۳۰ روز');
    expect(text).toContain('🖥 پنل: آلمان ۱');
    expect(text).toContain('🔑 نام سرویس: nx7k2m9q');
    expect(text).toContain('💵 قیمت محصول: ۳۰۰٬۰۰۰ تومان');
    expect(text).toContain('💵 قیمت نهایی: ۲۵۰٬۰۰۰ تومان');
    expect(text).toContain('🔖 کد سفارش: KQ7M2X9T');
    expect(text).toContain('🔖 کد پرداخت: RT4W8N2B');
    expect(text).toContain('🧩 کد سرویس: SV3K9P2Q');
    expect(built.buttons).toEqual([
      { kind: 'USER', ref: 'cust-1' },
      { kind: 'SERVICE', ref: 'svc-1' },
    ]);
  });
});

describe('every producer of provisioning.stalled names the operation that stalled', () => {
  it('each record() of the code carries operationType in its context', () => {
    const source = readFileSync(
      'apps/api/src/modules/commerce/provisioning/application/provisioner.service.ts',
      'utf8',
    );
    const blocks = source
      .split('code: PROVISIONING_STALLED_CODE,')
      .slice(1)
      .map((rest) => rest.slice(0, rest.indexOf('dedupeKey')))
      .filter((block) => block.includes('context: {'));
    expect(blocks.length).toBeGreaterThanOrEqual(7);
    for (const block of blocks) expect(block).toContain('operationType: operation.type');
  });
});
