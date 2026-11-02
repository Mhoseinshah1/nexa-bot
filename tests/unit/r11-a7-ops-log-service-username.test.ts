import { describe, expect, it } from 'vitest';
import {
  PAYMENT_LINK_CREATE_FAILED_CODE,
  SERVICE_PANEL_ACCOUNT_MISSING_CODE,
  money,
  templateDefinition,
  type OperationalEventInput,
  type RecordedOperationalEvent,
  type ScopeContext,
  type TemplateKey,
  type TemplateValues,
  type TenantContext,
} from '@nexa/contracts';
import { CATALOGUE_FA, DEFAULT_TEMPLATE_PRESENTATION, renderTemplateBody } from '@nexa/i18n';
import { i18nOpsLogWords as words } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import { OperationalEventPresenter } from '../../apps/api/src/modules/commerce/ops-log/application/event-presenter';
import { STARS_CHARGE_REFUNDED_CODE } from '../../apps/api/src/modules/commerce/payments/application/telegram-stars-payment.service';
import {
  linkChanged,
  operationFailure,
  giftFailure,
  provisionFailure,
  serviceAlert,
  serviceChanged,
  serviceCreated,
  serviceUsernameValue,
  stalledReport,
  trialCreated,
  type Built,
} from '../../apps/api/src/modules/commerce/ops-log/application/presenters';
import type {
  CustomerFact,
  OperationFact,
  OpsLogFacts,
  OrderFact,
  OrderOriginFact,
  PaymentFact,
  ServiceFact,
} from '../../apps/api/src/modules/commerce/ops-log/application/ports';
import { TemplateResolver } from '../../apps/api/src/modules/control/templates/application/template-resolver';
import { I18nTemplateCatalogue } from '../../apps/api/src/modules/control/templates/infrastructure/i18n-template-catalogue';
import type { TemplateRepository } from '../../apps/api/src/modules/control/templates/application/ports';
import type { FeatureFlagResolver } from '../../apps/api/src/modules/control/features/application/feature-flags.service';
import { NotifyingOperationalEventRecorder } from '../../apps/api/src/modules/control/notifications/application/operational-event-projector';

/**
 * R11 A7 — every operations-log message about a SERVICE prints the service's panel account
 * name as its own line: «👤 نام کاربری سرویس: …».
 *
 * One test per log type (the line present with the username, absent without), the redaction of
 * the value, the generic layout of an event about a service, and the template overrides: an
 * override that does not mention the token renders exactly as before, one that does gets it
 * filled. Facts are synthetic.
 *
 * MUTATIONS (each applied, the named tests red, reverted, green) — see the PR description:
 *  - `put(values, 'serviceUsername', …)` removed from one presenter -> that type's case only;
 *  - `serviceUsernameValue` returning the raw string -> the redaction case;
 *  - `OperationalEventPresenter.serviceUsernameOf` returning null -> the generic-layout case;
 *  - the token dropped from a body in `ops-log.fa.ts` -> that type's case (the body cases).
 */

const AT = new Date('2026-10-20T08:00:00Z');
const GIB = 1024n ** 3n;
const irt = (n: number) => money(BigInt(n), 'IRT');
const LINE = '👤 نام کاربری سرویس: nx7k2m9q';
const LABEL = 'نام کاربری سرویس';
const tenant = {
  tenantId: '01900000-0000-7000-8000-000000000001' as never,
  botInstanceId: null,
} as TenantContext;

const customer: CustomerFact = {
  id: 'cust-1',
  telegramUserId: '700100200',
  username: 'nima_t',
  firstName: 'نیما',
  lastName: null,
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
  trafficBytes: 50n * GIB,
  panelId: 'panel-1',
  panelName: 'آلمان ۱',
  locationLabel: null,
  subtotal: irt(300_000),
  discount: irt(0),
  total: irt(300_000),
  settledAt: AT,
  isFirstPurchase: false,
  reseller: false,
  resellerListPrice: null,
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
  expiresAt: new Date('2026-11-20T00:00:00Z'),
  trafficLimitBytes: 50n * GIB,
  trafficUsedBytes: 10n * GIB,
  lastSeenAt: null,
  source: 'NEXA',
};
const payment: PaymentFact = {
  id: 'pay-1',
  code: 'RT4W8N2B',
  reference: 'ref-1',
  method: 'MANUAL_TRANSFER',
  gatewayProvider: null,
  amount: irt(300_000),
  state: 'CONFIRMED',
};
const operation: OperationFact = {
  id: 'op-1',
  type: 'RENEW',
  state: 'SUCCEEDED',
  serviceId: 'svc-1',
  orderId: 'ord-1',
  requestedByCustomerId: 'cust-1',
  panelId: 'panel-1',
  failureKind: null,
  failureMessage: null,
  targetExpiresAt: new Date('2026-12-20T00:00:00Z'),
  targetTrafficLimitBytes: 50n * GIB,
  completedAt: AT,
};

function render(built: Built): string {
  return renderTemplateBody(
    templateDefinition(built.templateKey),
    CATALOGUE_FA[built.templateKey],
    built.values,
    'fa',
    DEFAULT_TEMPLATE_PRESENTATION,
  );
}
const lines = (built: Built): string[] => render(built).split('\n');

describe('R11 A7 — every service log prints the panel account name as its own line', () => {
  const common = { customer, at: AT, words };
  const change = (
    kind: 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME',
    overrides: { service?: ServiceFact; origin?: OrderOriginFact | null } = {},
  ): Built =>
    serviceChanged({
      kind,
      order: { ...order, purpose: kind },
      service: overrides.service ?? service,
      operation,
      before: null,
      payment,
      walletBalance: null,
      origin: overrides.origin ?? null,
      ...common,
    });

  const cases: readonly [string, (svc: ServiceFact) => Built, string][] = [
    [
      'L10 service created',
      (svc) =>
        serviceCreated({
          order,
          service: svc,
          payment,
          walletBalance: null,
          origin: null,
          ...common,
        }),
      'ops.log.service_created',
    ],
    [
      'L11 service created (wallet)',
      (svc) =>
        serviceCreated({
          order,
          service: svc,
          payment: { ...payment, method: 'WALLET' },
          walletBalance: { before: irt(500_000), after: irt(200_000) },
          origin: null,
          ...common,
        }),
      'ops.log.service_created_wallet',
    ],
    ['L12 renewal', (svc) => change('RENEW', { service: svc }), 'ops.log.service_renewed'],
    [
      'L12 auto-renewal (R10 D1)',
      (svc) =>
        change('RENEW', {
          service: svc,
          origin: {
            surface: 'WORKER',
            actorType: 'SYSTEM_JOB',
            actorId: null,
            actorLabel: null,
            autoRenew: true,
          },
        }),
      'ops.log.service_renewed',
    ],
    [
      'L13 extra traffic',
      (svc) => change('ADD_TRAFFIC', { service: svc }),
      'ops.log.traffic_added',
    ],
    ['L14 extra time', (svc) => change('ADD_TIME', { service: svc }), 'ops.log.time_added'],
    [
      'L15 link change',
      (svc) => linkChanged({ service: svc, by: 'CUSTOMER', rotations: 2, ...common }),
      'ops.log.link_changed',
    ],
    [
      'L16 trial',
      (svc) => trialCreated({ service: svc, order: null, ...common }),
      'ops.log.trial_created',
    ],
    [
      'L21 service alert',
      (svc) => serviceAlert({ kind: 'USAGE_FIRST', service: svc, remainingDays: 3, ...common }),
      'ops.log.service_alert',
    ],
    [
      'L23 stalled PROVISION (service in hand)',
      (svc) =>
        stalledReport({
          operationType: 'PROVISION',
          reason: 'ATTEMPTS_SPENT',
          service: svc,
          order,
          payment,
          ...common,
        }),
      'ops.log.error_provision',
    ],
    [
      'L24 stalled RENEW',
      (svc) =>
        stalledReport({
          operationType: 'RENEW',
          reason: 'ATTEMPTS_SPENT',
          service: svc,
          order: null,
          payment: null,
          ...common,
        }),
      'ops.log.error_operation',
    ],
    [
      'L24 free extra-volume gift failed',
      (svc) =>
        giftFailure({
          operation: { ...operation, type: 'ADD_TRAFFIC', orderId: null, failureKind: 'REJECTED' },
          service: svc,
          ...common,
        }),
      'ops.log.error_operation',
    ],
    [
      'L24 renewal failed',
      (svc) =>
        operationFailure({
          order: { ...order, purpose: 'RENEW' },
          service: svc,
          operation: { ...operation, state: 'FAILED', failureKind: 'REJECTED' },
          reason: null,
          payment,
          refunded: irt(300_000),
          unknown: false,
          ...common,
        }),
      'ops.log.error_operation',
    ],
  ];

  it.each(cases)('%s: the line is present, with the username', (_name, build, template) => {
    const built = build(service);
    expect(built.templateKey).toBe(template);
    expect(built.values).toMatchObject({ serviceUsername: 'nx7k2m9q' });
    expect(lines(built)).toContain(LINE);
    expect(render(built)).not.toMatch(/\{[a-zA-Z]+\}|NaN|undefined/);
  });

  it.each(cases)('%s: an imported MIRZA service prints its panel account too', (_n, build) => {
    const built = build({ ...service, source: 'MIRZA', providerUsername: 'mirza_user_7' });
    expect(lines(built)).toContain('👤 نام کاربری سرویس: mirza_user_7');
  });

  it.each(cases)('%s: a service with no name leaves no empty line behind', (_name, build) => {
    const built = build({ ...service, providerUsername: '   ' });
    expect(built.values).not.toHaveProperty('serviceUsername');
    expect(render(built)).not.toContain(LABEL);
  });

  it('the auto-renewal log says «تمدید خودکار» and still names the service', () => {
    const built = change('RENEW', {
      origin: {
        surface: 'WORKER',
        actorType: 'SYSTEM_JOB',
        actorId: null,
        actorLabel: null,
        autoRenew: true,
      },
    });
    expect(lines(built)).toContain('📲 منبع: تمدید خودکار');
    expect(lines(built)).toContain(LINE);
  });
});

describe('R11 A7 — the provision and operation errors of an order name the service', () => {
  const provision = (input: Partial<Parameters<typeof provisionFailure>[0]> = {}): Built =>
    provisionFailure({
      order,
      customer,
      operation: null,
      reason: null,
      payment,
      refunded: null,
      unknown: false,
      at: AT,
      words,
      ...input,
    });
  const failure = (input: Partial<Parameters<typeof operationFailure>[0]> = {}): Built =>
    operationFailure({
      order: { ...order, purpose: 'RENEW' },
      service: null,
      customer,
      operation: null,
      reason: null,
      payment,
      refunded: null,
      unknown: false,
      at: AT,
      words,
      ...input,
    });

  it('L23 service not created: the service row the failed create left behind names its account', () => {
    const built = provision({ serviceUsername: 'nx7k2m9q' });
    expect(built.templateKey).toBe('ops.log.error_provision');
    expect(lines(built)).toContain(LINE);
  });

  it('L23 (administrator-created): the admin message names it too', () => {
    const built = provision({
      serviceUsername: 'nx7k2m9q',
      createdBy: { admin: null, label: 'مدیر' },
    });
    expect(built.templateKey).toBe('ops.log.error_provision_admin');
    expect(lines(built)).toContain(LINE);
  });

  it('L23: no service known -> no line', () => {
    expect(render(provision())).not.toContain(LABEL);
    expect(render(provision({ serviceUsername: null }))).not.toContain(LABEL);
  });

  it('L24: with no service row the order’s service name is used; a service row wins', () => {
    expect(lines(failure({ serviceUsername: 'nx7k2m9q' }))).toContain(LINE);
    const both = failure({ service, serviceUsername: 'other_name' });
    expect(lines(both)).toContain(LINE);
    expect(render(both)).not.toContain('other_name');
  });

  it('L24: nothing known -> no line', () => {
    expect(render(failure())).not.toContain(LABEL);
  });
});

describe('R11 A7 — the value is a username, never a secret', () => {
  it('keeps an ordinary panel account name exactly', () => {
    for (const name of ['nx7k2m9q', 'ali_01', 'nx-7f3a91', 'user.name']) {
      expect(serviceUsernameValue(name)).toBe(name);
    }
  });

  it('makes one bounded line and drops an empty one', () => {
    expect(serviceUsernameValue('  a\n b  ')).toBe('a b');
    expect(serviceUsernameValue('x'.repeat(200))?.length).toBeLessThanOrEqual(64);
    expect(serviceUsernameValue(null)).toBeNull();
    expect(serviceUsernameValue(undefined)).toBeNull();
    expect(serviceUsernameValue('   ')).toBeNull();
  });

  it('redacts a subscription link or token that was stored in the name', () => {
    const link = 'https://sub.example.com/s/0123456789abcdef0123456789abcdef';
    const built = serviceCreated({
      order,
      service: { ...service, providerUsername: link },
      payment,
      walletBalance: null,
      origin: null,
      customer,
      at: AT,
      words,
    });
    const text = render(built);
    expect(text).toContain('👤 نام کاربری سرویس: [redacted]');
    expect(text).not.toContain('sub.example.com');
    expect(text).not.toContain('0123456789abcdef');
  });
});

describe('R11 A7 — an operational event about a service (the generic layout)', () => {
  const recorded: RecordedOperationalEvent = {
    id: 'ev-1',
    code: SERVICE_PANEL_ACCOUNT_MISSING_CODE,
    severity: 'ERROR',
    message: 'x',
    occurrenceCount: 1,
    firstSeenAt: AT,
    lastSeenAt: AT,
    isNew: true,
    reopened: false,
  } as unknown as RecordedOperationalEvent;
  const event = (context?: Record<string, unknown>): OperationalEventInput => ({
    code: SERVICE_PANEL_ACCOUNT_MISSING_CODE,
    severity: 'ERROR',
    message: 'The panel answered twice that this service’s account does not exist.',
    ...(context === undefined ? {} : { context }),
  });
  const project = async (
    facts: Partial<OpsLogFacts>,
    input: OperationalEventInput,
  ): Promise<TemplateValues> => {
    const queued: { values: TemplateValues; templateKey: string }[] = [];
    const recorder = new NotifyingOperationalEventRecorder(
      { record: async () => recorded } as never,
      { queue: async (_s: unknown, one: never) => queued.push(one) } as never,
      {
        runNested: async (_s: unknown, _tx: unknown, fn: (tx: unknown) => unknown) => fn({}),
      } as never,
      { error: () => undefined } as never,
      new OperationalEventPresenter({ facts: facts as OpsLogFacts, words }),
    );
    await recorder.record(tenant, input, {});
    expect(queued).toHaveLength(1);
    expect(queued[0]!.templateKey).toBe('ops.notification.operational_event');
    return queued[0]!.values;
  };
  const renderGeneric = (values: TemplateValues): string =>
    renderTemplateBody(
      templateDefinition('ops.notification.operational_event' as TemplateKey),
      CATALOGUE_FA['ops.notification.operational_event' as TemplateKey],
      values,
      'fa',
      DEFAULT_TEMPLATE_PRESENTATION,
    );

  it('prints the panel account name of the service the event names, and no id', async () => {
    const values = await project(
      { service: async () => service },
      event({ serviceId: '01900000-0000-7000-8000-0000000000aa', panelId: 'panel-1' }),
    );
    expect(values).toMatchObject({ serviceUsername: 'nx7k2m9q' });
    const text = renderGeneric(values);
    expect(text.split('\n')).toContain(LINE);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('an event about no service is unchanged: no token, no line', async () => {
    const values = await project({ service: async () => service }, event({ panelId: 'panel-1' }));
    expect(values).not.toHaveProperty('serviceUsername');
    expect(renderGeneric(values)).not.toContain(LABEL);
  });

  it('a service that is gone prints no line', async () => {
    const values = await project(
      { service: async () => null },
      event({ serviceId: '01900000-0000-7000-8000-0000000000aa' }),
    );
    expect(values).not.toHaveProperty('serviceUsername');
  });
});

describe('R12 F1 item 6 — a refunded Stars charge names its ORDER; the line is read through it', () => {
  const presenterWith = (username: string | null) =>
    new OperationalEventPresenter({
      facts: { serviceUsernameOfOrder: async () => username } as unknown as OpsLogFacts,
      words,
    });
  const input = (code: string): OperationalEventInput => ({
    code,
    severity: 'ERROR',
    message: 'refunded',
    context: { orderId: '01900000-0000-7000-8000-0000000000ab', paymentId: 'p-1' },
  });

  it('prints the order’s service username for payments.gateway_charge_refunded', async () => {
    expect(
      await presenterWith('nx7k2m9q').serviceUsernameOf(
        tenant,
        input(STARS_CHARGE_REFUNDED_CODE),
        {},
      ),
    ).toBe('nx7k2m9q');
    expect(
      await presenterWith(null).serviceUsernameOf(tenant, input(STARS_CHARGE_REFUNDED_CODE), {}),
    ).toBeNull();
  });

  it('gives no other event that carries an order id a line it did not have', async () => {
    expect(
      await presenterWith('nx7k2m9q').serviceUsernameOf(
        tenant,
        input('payments.gateway_late_completion'),
        {},
      ),
    ).toBeNull();
  });
});

describe('R11 A7 — L22 a payment link that could not be made, for an order tied to a service', () => {
  const recorded = {
    id: 'ev-2',
    code: PAYMENT_LINK_CREATE_FAILED_CODE,
    severity: 'ERROR',
    occurrenceCount: 1,
    firstSeenAt: AT,
    lastSeenAt: AT,
    isNew: true,
    reopened: false,
  } as unknown as RecordedOperationalEvent;
  const present = async (username: string | null) => {
    const presenter = new OperationalEventPresenter({
      facts: {
        customer: async () => customer,
        order: async () => order,
        serviceUsernameOfOrder: async () => username,
      } as unknown as OpsLogFacts,
      words,
    });
    const input: OperationalEventInput = {
      code: recorded.code,
      severity: 'ERROR',
      message: 'link failed',
      context: {
        phase: 'PAYMENT_LINK_CREATE',
        failureKind: 'PROVIDER_ERROR',
        provider: 'TONPAYS',
        customerId: 'cust-1',
        orderId: 'ord-1',
        errorCode: 'http.502',
      },
    };
    return presenter.present(tenant, input, recorded, {});
  };

  it('prints the line for a renewal / add-on order, and none for an order with no service', async () => {
    const named = await present('nx7k2m9q');
    expect(named?.templateKey).toBe('ops.notification.payment_link_failed');
    const text = renderTemplateBody(
      templateDefinition(named!.templateKey),
      CATALOGUE_FA[named!.templateKey],
      named!.values,
      'fa',
      DEFAULT_TEMPLATE_PRESENTATION,
    );
    expect(text.split('\n')).toContain(LINE);
    const bare = await present(null);
    expect(bare!.values).not.toHaveProperty('serviceUsername');
  });
});

describe('R11 A7 — tenant overrides keep rendering, and may opt in to the token', () => {
  const scope = { tenantId: 't-1', botInstanceId: null } as unknown as ScopeContext;
  function resolver(body: string | null) {
    const repository = {
      findOverride: async (_scope: unknown, key: TemplateKey) =>
        body === null
          ? null
          : { key, locale: 'fa', body, version: 1, revision: 1, updatedAt: new Date(0) },
    } as unknown as TemplateRepository;
    const features = { isEnabled: async () => true } as unknown as FeatureFlagResolver;
    return new TemplateResolver(repository, features, new I18nTemplateCatalogue(), {
      presentationFor: async () => ({ timezone: 'UTC', calendar: 'gregorian' }) as never,
    });
  }

  /** Every key this change touched, with values that satisfy its required tokens. */
  const base = {
    displayName: 'نیما',
    username: '@nima_t',
    telegramId: '700100200',
    at: AT,
    reference: 'RT4W8N2B',
    orderCode: 'KQ7M2X9T',
    method: 'کارت به کارت',
    principal: irt(300_000),
    fee: irt(0),
    payable: irt(300_000),
    amount: irt(300_000),
    cause: 'علت',
    technical: 'REJECTED',
    impact: 'برگشت به کیف پول',
    channel: 'کیف پول',
  };
  const keys: readonly [TemplateKey, TemplateValues][] = [
    ['ops.financial.order_paid' as TemplateKey, base],
    ['ops.financial.refund_completed' as TemplateKey, base],
    ['ops.log.error_provision' as TemplateKey, base],
    ['ops.log.service_renewed' as TemplateKey, { ...base, price: irt(300_000) }],
  ];

  it.each(keys)(
    '%s: an override without the token renders exactly as the operator wrote it',
    async (key, values) => {
      const text = await resolver('پرداخت {reference} · {orderCode} · {displayName}').render(
        scope,
        key,
        { ...values, serviceUsername: 'nx7k2m9q' },
      );
      expect(text).toBe('پرداخت RT4W8N2B · KQ7M2X9T · نیما');
    },
  );

  it.each(keys)('%s: an override that has the token gets it filled', async (key, values) => {
    const text = await resolver('سرویس {serviceUsername} · {orderCode}').render(scope, key, {
      ...values,
      serviceUsername: 'nx7k2m9q',
    });
    expect(text).toBe('سرویس nx7k2m9q · KQ7M2X9T');
  });

  it.each(keys)(
    '%s: an override with the token and no service drops that line only',
    async (key, values) => {
      const text = await resolver('کد {orderCode}\nسرویس {serviceUsername}').render(
        scope,
        key,
        values,
      );
      expect(text).toBe('کد KQ7M2X9T');
    },
  );

  it.each(keys)(
    '%s: the default body is the owner’s line when there is a value, and none without',
    async (key, values) => {
      const withName = await resolver(null).render(scope, key, {
        ...values,
        serviceUsername: 'nx7k2m9q',
      });
      expect(withName.split('\n')).toContain(LINE);
      expect(await resolver(null).render(scope, key, values)).not.toContain(LABEL);
    },
  );
});

describe('R11 A7 — the declaration and the default bodies agree', () => {
  const touched = [
    'ops.notification.operational_event',
    'ops.notification.payment_link_failed',
    'ops.financial.order_paid',
    'ops.log.payment_crypto',
    'ops.financial.payment_failed',
    'ops.financial.invoice_cancelled',
    'ops.financial.receipt_rejected',
    'ops.financial.payment_expired',
    'ops.financial.payment_underpaid',
    'ops.financial.payment_overpaid',
    'ops.financial.late_completion',
    'ops.financial.late_credit',
    'ops.financial.late_credit_returned',
    'ops.financial.outcome_unknown',
    'ops.financial.credit_amount_mismatch',
    'ops.financial.refund_completed',
    'ops.financial.refund_failed',
    'ops.financial.service_refund_request',
    'ops.log.error_provision',
    'ops.log.error_provision_admin',
    'ops.log.error_operation',
    'ops.log.service_created',
    'ops.log.service_created_wallet',
    'ops.log.service_renewed',
    'ops.log.traffic_added',
    'ops.log.time_added',
    'ops.log.link_changed',
    'ops.log.trial_created',
    'ops.log.service_alert',
  ] as const;

  it.each(touched)(
    '%s declares {serviceUsername} OPTIONAL and prints it on a line of its own',
    (key) => {
      const definition = templateDefinition(key as TemplateKey);
      const placeholder = definition.placeholders.find((one) => one.token === 'serviceUsername');
      expect(placeholder?.required).toBe(false);
      expect(placeholder?.type).toBe('STRING');
      const body = CATALOGUE_FA[key as TemplateKey];
      expect(body.split('\n')).toContain('👤 نام کاربری سرویس: {serviceUsername}');
    },
  );

  it('a wallet top-up, a referral commission and a panel message are not given the token', () => {
    for (const key of [
      'ops.financial.topup_credited',
      'ops.log.referral_commission',
      'ops.log.panel_down',
      'ops.log.wallet_adjusted',
    ]) {
      expect(
        templateDefinition(key as TemplateKey).placeholders.some(
          (one) => one.token === 'serviceUsername',
        ),
      ).toBe(false);
      expect(CATALOGUE_FA[key as TemplateKey]).not.toContain('serviceUsername');
    }
  });
});
