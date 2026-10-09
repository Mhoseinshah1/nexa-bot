import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  money,
  paymentTrackingCode,
  templateDefinition,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PaymentGatewayConfig,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { CATALOGUE_FA, renderTemplateBody } from '@nexa/i18n';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleGatewayInvoiceRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-invoice.repository';
import {
  DrizzleGatewayCallBudget,
  DrizzleGatewayCredentialStore,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-gateway-credentials';
import {
  TonPaysAdapter,
  type FetchLike,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';
import { GatewayPaymentService } from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';
import { DrizzleOperationalConditionReader } from '../../apps/api/src/modules/platform/opslog/infrastructure/drizzle-operational-event.reader';
import {
  NotificationDispatcher,
  deserialiseValues,
} from '../../apps/api/src/modules/control/notifications/application/notification-dispatcher';
import type {
  NotificationTransport,
  OutboundMessage,
  TransportResult,
} from '../../apps/api/src/modules/control/notifications/application/ports';
import type { OperationalEventRecorder } from '@nexa/contracts';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * FIX-04 / FIX-05 — a payment link that could not be made reaches the operations log with
 * the facts an operator needs, through the existing recorder, projector and dispatcher.
 *
 * The lane is the REAL `GatewayPaymentService` over the test database with the REAL
 * `TonPaysAdapter`, whose `fetch` is a fake TonPays answering each FIX-04 case. Nothing
 * leaves the process; no real gateway, no real Telegram. Synthetic data only.
 */

const API_KEY = 'tp_live_KEY_that_must_never_leak_71c0de';
const OTHER_KEY = 'tp_live_OTHER_tenant_key_33aa';
const MARYAM = '910910';
const ALI = '920920';
const SIGNED = 'https://pay.tonpays.online/i/TP-9?sig=deadbeefcafe';
const PAN = '6037991234567893';

const OPEN_ROUTE: PaymentGatewayConfig = {
  displayName: null,
  instructions: null,
  minAmountMinor: 0n,
  maxAmountMinor: 0n,
  eligibility: {
    activateAfterPayments: 0,
    deactivateAfterPayments: 0,
    activateAfterAccountDays: 0,
  },
  sortOrder: 0,
  topupCashbackPercent: 0,
  allowServicePurchase: true,
  allowWalletTopup: true,
};

type Mode =
  | 'NO_LINK'
  | 'MALFORMED_LINK'
  | 'SERVER_ERROR'
  | 'TIMEOUT'
  | 'UNREACHABLE'
  | { readonly status: number; readonly code: string };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The create endpoint, answering whichever FIX-04 case the test names. */
function fakeTonPays(mode: () => Mode): { fetch: FetchLike; creates: number } {
  const state = { creates: 0 };
  const fetch: FetchLike = async (url, init) => {
    if (!url.endsWith('/api/v1/invoices/create')) {
      return json(404, { detail: { code: 'INVOICE_NOT_FOUND', message: 'x' } });
    }
    state.creates += 1;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const current = mode();
    if (typeof current === 'object') {
      // A refusal whose MESSAGE quotes things that must never be printed.
      return json(current.status, {
        detail: { code: current.code, message: `refused ${API_KEY} ${SIGNED} ${PAN}` },
      });
    }
    switch (current) {
      case 'SERVER_ERROR':
        return json(502, { error: `bad gateway ${API_KEY}` });
      case 'TIMEOUT':
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        });
      case 'UNREACHABLE':
        throw Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error(`connect ECONNREFUSED ${SIGNED}`), {
            code: 'ECONNREFUSED',
          }),
        });
      case 'NO_LINK':
        return json(201, { invoice_id: 'TP-NOLINK', order_id: body.order_id, status: 'pending' });
      case 'MALFORMED_LINK':
        return json(201, {
          invoice_id: 'TP-BADLINK',
          order_id: body.order_id,
          status: 'pending',
          invoice_url: `http://insecure.example/pay?card=${PAN}`,
          web_invoice_url: 'javascript:alert(1)',
        });
    }
  };
  return {
    fetch,
    get creates() {
      return state.creates;
    },
  };
}

/** A transport that refuses everything, like a log group Telegram will not deliver to. */
class RefusingTransport implements NotificationTransport {
  readonly kind = 'TELEGRAM' as const;
  readonly messages: OutboundMessage[] = [];
  constructor(private readonly answer: TransportResult) {}
  async send(message: OutboundMessage): Promise<TransportResult> {
    this.messages.push(message);
    return this.answer;
  }
}

const systemActor = (key: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: key as CorrelationId,
});

describe('FIX-04: payment-link failures reach the operations log', () => {
  let ctx: TestContext;
  let mode: Mode;
  let offsetMs: number;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    mode = 'NO_LINK';
    offsetMs = 0;
  });

  function laneFor(
    key: string,
    opsLog: Pick<OperationalEventRecorder, 'record'> = ctx.container.opsLog,
    options: { readonly noCredential?: boolean } = {},
  ): GatewayPaymentService {
    const db = ctx.container.database.db;
    const fake = fakeTonPays(() => mode);
    const adapter = new TonPaysAdapter({ fetch: fake.fetch, timeoutMs: 50 });
    void key;
    const store = new DrizzleGatewayCredentialStore(db, ctx.container.cipher, () =>
      ctx.container.ids.uuid(),
    );
    // A key that went missing after the route was switched on (deleted, unreadable).
    const credentials =
      options.noCredential === true
        ? new Proxy(store, {
            get: (target, property, receiver) =>
              property === 'read'
                ? () => Promise.resolve(null)
                : (Reflect.get(target, property, receiver) as unknown),
          })
        : store;
    return new GatewayPaymentService({
      invoices: new DrizzleGatewayInvoiceRepository(db),
      payments: ctx.container.payments,
      paymentRecords: new DrizzlePaymentRepository(db),
      adapters: (provider) => (provider === 'TONPAYS' ? adapter : null),
      credentials,
      botTokens: { tokenForBotInstance: () => Promise.resolve(null) },
      presentation: () => Promise.reject(new Error('TonPays renders no invoice text')),
      budget: new DrizzleGatewayCallBudget(db),
      callbackUrlFor: async () => null,
      customers: new DrizzleCustomerRepository(db),
      conditions: new DrizzleOperationalConditionReader(db),
      scopeActivity: ctx.container.tenants,
      uow: ctx.container.uow,
      audit: ctx.container.audit,
      opsLog: opsLog as OperationalEventRecorder,
      outbox: ctx.container.outbox,
      clock: { now: () => new Date(Date.now() + offsetMs) },
      ids: ctx.container.ids,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
  }

  async function enable(scope: TenantContext, apiKey: string, owner: ActorContext) {
    await ctx.container.paymentGateways.configure(scope, owner, {
      idempotencyKey: `cfg-${String(scope.tenantId)}`,
      provider: 'TONPAYS',
      config: OPEN_ROUTE,
    });
    await ctx.container.paymentGateways.setCredential(scope, owner, {
      idempotencyKey: `cred-${String(scope.tenantId)}`,
      provider: 'TONPAYS',
      apiKey,
    });
    await ctx.container.paymentGateways.setStatus(scope, owner, {
      idempotencyKey: `on-${String(scope.tenantId)}`,
      provider: 'TONPAYS',
      status: 'ACTIVE',
    });
  }

  async function customer(scope: TenantContext, telegramId: string, bot: string): Promise<UserId> {
    return (
      await ctx.container.customers.resolveFromUpdate(scope, systemActor(`resolve-${telegramId}`), {
        idempotencyKey: `resolve-${telegramId}`,
        telegramUserId: telegramId,
        from: { id: Number(telegramId), first_name: 'آزمون' },
        botInstanceId: bot as BotInstanceId,
      })
    ).customer.id;
  }

  async function setUp(scope: TenantContext = tenantA, apiKey = API_KEY) {
    const bot = scope.tenantId === tenantB.tenantId ? SEED_IDS.botB1 : SEED_IDS.botA1;
    const owner = adminActorFor(
      await createAdmin(ctx.container, scope, {
        username: `owner-${String(scope.tenantId).slice(-4)}`,
        roleKeys: ['owner'],
      }),
    );
    await enable(scope, apiKey, owner);
    // The operations lane is off by default ("a destination has to be configured first").
    await ctx.container.featureFlags.set(scope, owner, {
      key: 'ops_notifications',
      enabled: true,
      expectedVersion: null,
      idempotencyKey: `flag-${String(scope.tenantId)}`,
      confirmKey: 'ops_notifications',
      reason: 'Test setup.',
    });
    return {
      bot,
      owner,
      customerId: await customer(scope, scope === tenantA ? MARYAM : ALI, bot),
    };
  }

  async function topup(scope: TenantContext, customerId: UserId, key: string, amount = 100_000n) {
    const bot = scope.tenantId === tenantB.tenantId ? SEED_IDS.botB1 : SEED_IDS.botA1;
    return ctx.container.payments.requestGatewayTopup(
      { ...scope, botInstanceId: bot as BotInstanceId },
      systemActor(key),
      customerId,
      { idempotencyKey: key, amount: money(amount, 'IRT'), provider: 'TONPAYS' },
    );
  }

  interface EventRow {
    readonly id: string;
    readonly tenant_id: string;
    readonly code: string;
    readonly severity: string;
    readonly occurrence_count: number;
    readonly context: Record<string, unknown>;
  }

  async function events(scope: TenantContext = tenantA): Promise<EventRow[]> {
    const result = await ctx.container.database.db.execute(
      sql`SELECT id, tenant_id, code, severity, occurrence_count, context
            FROM operational_events WHERE tenant_id = ${scope.tenantId}
             AND code LIKE 'payments.gateway%' ORDER BY first_seen_at, id`,
    );
    return result.rows as unknown as EventRow[];
  }

  async function allEventCount(): Promise<number> {
    const result = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM operational_events`,
    );
    return (result.rows[0] as { n: number }).n;
  }

  /** The group messages queued for a tenant's payment-link failures, rendered as sent. */
  async function messages(scope: TenantContext = tenantA): Promise<string[]> {
    const result = await ctx.container.database.db.execute(
      sql`SELECT template_key, payload FROM notifications
           WHERE tenant_id = ${scope.tenantId}
             AND template_key = 'ops.notification.payment_link_failed'
           ORDER BY created_at, id`,
    );
    return (result.rows as { template_key: string; payload: Record<string, unknown> }[]).map(
      (row) =>
        renderTemplateBody(
          templateDefinition('ops.notification.payment_link_failed'),
          CATALOGUE_FA['ops.notification.payment_link_failed'],
          deserialiseValues({ templateKey: row.template_key, payload: row.payload }),
        ),
    );
  }

  function expectNoSecret(text: string) {
    for (const secret of [API_KEY, OTHER_KEY, SIGNED, 'deadbeefcafe', PAN, 'insecure.example']) {
      expect(text).not.toContain(secret);
    }
  }

  const cases: readonly {
    readonly name: string;
    readonly mode: Mode;
    readonly code: string;
    readonly kind: string;
    readonly status: number | null;
    readonly line: string;
    readonly paymentState: string;
    readonly misconfigured?: true;
  }[] = [
    {
      name: 'no link',
      mode: 'NO_LINK',
      code: 'payments.gateway_link_create_failed',
      kind: 'NO_LINK',
      status: null,
      line: 'علت: درگاه پیش‌فاکتور را ساخت اما لینک پرداخت برنگرداند',
      paymentState: 'PENDING',
    },
    {
      name: 'malformed link',
      mode: 'MALFORMED_LINK',
      code: 'payments.gateway_link_create_failed',
      kind: 'MALFORMED_LINK',
      status: null,
      line: 'علت: لینک پرداختی که درگاه برگرداند نامعتبر یا ناامن بود',
      paymentState: 'PENDING',
    },
    {
      name: '400',
      mode: { status: 400, code: 'AMOUNT_TOO_LOW' },
      code: 'payments.gateway_link_create_failed',
      kind: 'BAD_REQUEST',
      status: 400,
      line: 'علت: درگاه درخواست را نپذیرفت',
      paymentState: 'FAILED',
    },
    {
      name: '401',
      mode: { status: 401, code: 'INVALID_API_KEY' },
      code: 'payments.gateway_link_create_failed',
      kind: 'UNAUTHORIZED',
      status: 401,
      line: 'علت: درگاه احراز هویت را رد کرد',
      paymentState: 'FAILED',
      misconfigured: true,
    },
    {
      name: '403',
      mode: { status: 403, code: 'ACCESS_DENIED' },
      code: 'payments.gateway_link_create_failed',
      kind: 'FORBIDDEN',
      status: 403,
      line: 'علت: درگاه دسترسی را رد کرد',
      paymentState: 'FAILED',
      misconfigured: true,
    },
    {
      name: '5xx',
      mode: 'SERVER_ERROR',
      code: 'payments.gateway_create_unknown',
      kind: 'PROVIDER_ERROR',
      status: 502,
      line: 'علت: پاسخ نامعتبر درگاه؛ خطای سمت درگاه',
      paymentState: 'PENDING',
    },
    {
      name: 'timeout',
      mode: 'TIMEOUT',
      code: 'payments.gateway_create_unknown',
      kind: 'TIMEOUT',
      status: null,
      line: 'علت: پاسخی از درگاه در مهلت مقرر نرسید',
      paymentState: 'PENDING',
    },
    {
      name: 'provider unreachable',
      mode: 'UNREACHABLE',
      code: 'payments.gateway_create_unknown',
      kind: 'UNREACHABLE',
      status: null,
      line: 'علت: اتصال به درگاه برقرار نشد',
      paymentState: 'PENDING',
    },
    {
      name: 'unknown result',
      mode: { status: 409, code: 'DUPLICATE_ORDER_ID' },
      code: 'payments.gateway_create_unknown',
      kind: 'UNKNOWN',
      status: 409,
      line: 'علت: نتیجهٔ درخواست نامشخص است',
      paymentState: 'PENDING',
    },
  ];

  for (const c of cases) {
    it(`${c.name}: one detailed, redacted event and one group message`, async () => {
      const { customerId } = await setUp();
      mode = c.mode;
      const attempt = await topup(tenantA, customerId, `tu-${c.name}`);
      await laneFor('a').runOnce(tenantA);

      const all = await events();
      // A refused CONFIGURATION also opens (once per gateway) the condition it always did.
      expect(all.map((row) => row.code).sort()).toEqual(
        [c.code, ...(c.misconfigured === true ? ['payments.gateway_misconfigured'] : [])].sort(),
      );
      const rows = all.filter((row) => row.code === c.code);
      const context = rows[0]!.context;
      expect(context).toMatchObject({
        phase: 'PAYMENT_LINK_CREATE',
        category: 'PAYMENTS',
        provider: 'TONPAYS',
        method: 'GATEWAY',
        paymentId: attempt.payment.id,
        trackingCode: paymentTrackingCode(attempt.payment.reference),
        telegramUserId: MARYAM,
        failureKind: c.kind,
        classification: c.code.endsWith('unknown') ? 'UNKNOWN' : 'FINAL',
      });
      expect(String(context['trackingCode']), 'the stored role suffix leaked').not.toContain(':');
      if (c.status === null) expect(context).not.toHaveProperty('httpStatus');
      else expect(context['httpStatus']).toBe(c.status);
      expectNoSecret(JSON.stringify(rows));

      const [text, ...more] = await messages();
      expect(more).toEqual([]);
      expect(text).toContain('🚨 خطای ساخت لینک پرداخت');
      expect(text).toContain('درگاه: TONPAYS');
      expect(text).toContain(`کاربر: <code>${MARYAM}</code>`);
      expect(text).toContain(
        `کد پیگیری پرداخت: <code>${paymentTrackingCode(attempt.payment.reference)}</code>`,
      );
      expect(text).toContain(c.line);
      expect(text).toContain(`شناسه رخداد: <code>${rows[0]!.id}</code>`);
      if (c.status !== null) expect(text).toContain(`وضعیت HTTP درگاه: ${String(c.status)}`);
      expect(text).toContain(c.code.endsWith('unknown') ? 'وضعیت: نیازمند بررسی' : 'وضعیت: نهایی');
      expectNoSecret(text!);

      const payment = await ctx.container.database.db.execute(
        sql`SELECT state FROM payments WHERE id = ${attempt.payment.id}`,
      );
      expect((payment.rows[0] as { state: string }).state).toBe(c.paymentState);
    });
  }

  it('a create the worker never heard back from is reported UNKNOWN', async () => {
    const { customerId } = await setUp();
    const attempt = await topup(tenantA, customerId, 'interrupted');
    // A previous worker stamped the send and died before the answer.
    await ctx.container.database.db.execute(
      sql`UPDATE gateway_invoices SET creation_sent_at = now() WHERE payment_id = ${attempt.payment.id}`,
    );
    await laneFor('a').runOnce(tenantA);
    const rows = await events();
    expect(
      rows.map((row) => [row.code, row.context['failureKind'], row.context['errorCode']]),
    ).toEqual([['payments.gateway_create_unknown', 'UNKNOWN', 'nexa.send_interrupted']]);
    const [text] = await messages();
    expect(text).toContain('علت: نتیجهٔ درخواست نامشخص است (<code>nexa.send_interrupted</code>)');
  });

  it('a route whose key is missing is reported as a configuration failure', async () => {
    const { customerId } = await setUp();
    await topup(tenantA, customerId, 'no-key');
    await laneFor('a', ctx.container.opsLog, { noCredential: true }).runOnce(tenantA);
    const rows = (await events()).filter(
      (row) => row.code === 'payments.gateway_link_create_failed',
    );
    expect(rows.map((row) => [row.context['failureKind'], row.context['errorCode']])).toEqual([
      ['CONFIGURATION', 'nexa.credential_missing'],
    ]);
    const [text] = await messages();
    expect(text).toContain('علت: تنظیمات درگاه کامل نیست یا درگاه آن را نپذیرفت');
  });

  it('429: reported once, when the last allowed attempt is refused — never while it is retried', async () => {
    const { customerId } = await setUp();
    mode = { status: 429, code: 'RATE_LIMIT_EXCEEDED' };
    await topup(tenantA, customerId, 'tu-429');
    const lane = laneFor('a');
    await lane.runOnce(tenantA);
    expect(await events()).toEqual([]);
    offsetMs += 20_000;
    await lane.runOnce(tenantA);
    expect(await events()).toEqual([]);
    offsetMs += 20_000;
    await lane.runOnce(tenantA);
    const rows = await events();
    expect(
      rows.map((row) => [row.code, row.context['failureKind'], row.context['httpStatus']]),
    ).toEqual([['payments.gateway_link_create_failed', 'RATE_LIMITED', 429]]);
    const [text] = await messages();
    expect(text).toContain('علت: محدودیت تعداد درخواست درگاه');
    expect(text).toContain('تکرار: ممکن است تلاش بعدی بدون تغییر موفق شود');
  });

  it('aggregates a storm: two customers’ identical failures are one row, one message, counted twice', async () => {
    const { customerId, owner } = await setUp();
    const ali = await customer(tenantA, ALI, SEED_IDS.botA1);
    mode = { status: 401, code: 'INVALID_API_KEY' };
    await topup(tenantA, customerId, 'storm-1', 100_000n);
    await topup(tenantA, ali, 'storm-2', 120_000n);
    await laneFor('a').runOnce(tenantA);
    const rows = (await events()).filter(
      (row) => row.code === 'payments.gateway_link_create_failed',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.occurrence_count).toBe(2);
    const sent = await messages();
    expect(sent).toHaveLength(1);
    // Codex P2 #251: the message is the FIRST occurrence and carries no counter that would
    // stay at 1; it points at the notification centre, where the live count is 2.
    expect(sent[0]).toContain('این پیام نخستین رخداد است');
    expect(sent[0]).not.toMatch(/تعداد رخداد/);
    const inbox = await ctx.container.notificationCenter.list(tenantA, owner, {
      limit: 20,
      unreadOnly: false,
      before: null,
    });
    expect(
      inbox
        .filter((item) => item.code === 'payments.gateway_link_create_failed')
        .map((item) => item.occurrenceCount),
    ).toEqual([2]);
    // The per-attempt evidence is all still there: one audit row per attempt.
    const audit = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM audit_logs
           WHERE tenant_id = ${tenantA.tenantId} AND action = 'gateway_invoice.create_failed'`,
    );
    expect((audit.rows[0] as { n: number }).n).toBe(2);
  });

  it('keeps tenants apart: each tenant’s failure is its own row naming only its own ids', async () => {
    const a = await setUp(tenantA, API_KEY);
    const b = await setUp(tenantB, OTHER_KEY);
    mode = { status: 401, code: 'INVALID_API_KEY' };
    const paidA = await topup(tenantA, a.customerId, 'iso-a');
    const paidB = await topup(tenantB, b.customerId, 'iso-b');
    await laneFor('a').runOnce(tenantA);
    await laneFor('b').runOnce(tenantB);
    const rowsA = await events(tenantA);
    const rowsB = await events(tenantB);
    expect(rowsA.filter((row) => row.code.endsWith('link_create_failed'))).toHaveLength(1);
    expect(rowsB.filter((row) => row.code.endsWith('link_create_failed'))).toHaveLength(1);
    const textA = JSON.stringify(rowsA) + (await messages(tenantA)).join('\n');
    const textB = JSON.stringify(rowsB) + (await messages(tenantB)).join('\n');
    expect(textA).toContain(paidA.payment.id);
    expect(textA).not.toContain(paidB.payment.id);
    expect(textA).not.toContain(String(tenantB.tenantId));
    expect(textA).not.toContain(ALI);
    expect(textB).toContain(paidB.payment.id);
    expect(textB).not.toContain(paidA.payment.id);
    expect(textB).not.toContain(String(tenantA.tenantId));
    expect(textB).not.toContain(MARYAM);
  });

  it('a recorder that cannot write does not fail the payment operation or the pass', async () => {
    const { customerId } = await setUp();
    mode = { status: 400, code: 'AMOUNT_TOO_LOW' };
    const attempt = await topup(tenantA, customerId, 'quiet');
    const broken = { record: () => Promise.reject(new Error('operations log unavailable')) };
    const report = await laneFor('a', broken).runOnce(tenantA);
    expect(report.createFailed).toBe(1);
    const payment = await ctx.container.database.db.execute(
      sql`SELECT state FROM payments WHERE id = ${attempt.payment.id}`,
    );
    expect((payment.rows[0] as { state: string }).state).toBe('FAILED');
  });

  it('a log group that will not take the message: the event stays, the delivery failure is visible, and nothing loops', async () => {
    const { customerId } = await setUp();
    const c = ctx.container;
    const owner = adminActorFor(
      await createAdmin(c, tenantA, { username: 'owner-grp', roleKeys: ['owner'] }),
    );
    await c.settingsService.set(tenantA, owner, {
      key: 'ops.notifications.telegram_chat_id',
      value: '-100555',
      expectedVersion: null,
      idempotencyKey: 'chat-id-setting',
    });
    mode = 'SERVER_ERROR';
    const attempt = await topup(tenantA, customerId, 'group-down');
    await laneFor('a').runOnce(tenantA);
    const before = await allEventCount();

    const transport = new RefusingTransport({
      outcome: 'FAILED_RETRYABLE',
      errorCode: 'telegram.rate_limited',
      errorMessage: 'Too Many Requests: retry after 1',
      retryAfterMs: 1_000,
    });
    const dispatcher = new NotificationDispatcher(
      c.notificationRepository,
      transport,
      c.templateResolver,
      c.settingsResolver,
      c.clock,
      c.ids,
      c.logger,
      c.opsLogWriter,
      { pollIntervalMs: 1_000, batchSize: 10, leaseMs: 60_000, baseBackoffMs: 1, maxBackoffMs: 1 },
    );
    dispatcher.setRateLimitScope(tenantA);
    for (let round = 0; round < 12; round += 1) {
      await c.database.db.execute(
        sql`UPDATE notifications SET next_attempt_at = now() - interval '1 second'
             WHERE status = 'PENDING'`,
      );
      await dispatcher.tick();
    }
    // Telegram was asked, and refused, every time.
    expect(transport.messages.length).toBeGreaterThan(0);
    expect(transport.messages.every((message) => !message.text.includes(API_KEY))).toBe(true);
    // The failure is visible: the intent records its attempts and their error code.
    const intent = await c.database.db.execute(
      sql`SELECT n.status, n.attempt_count,
                 (SELECT count(*)::int FROM notification_delivery_attempts a
                   WHERE a.notification_id = n.id AND a.error_code = 'telegram.rate_limited') AS refused
            FROM notifications n
           WHERE n.tenant_id = ${tenantA.tenantId}
             AND n.template_key = 'ops.notification.payment_link_failed'`,
    );
    const row = intent.rows[0] as { status: string; attempt_count: number; refused: number };
    expect(row.attempt_count).toBeGreaterThan(0);
    expect(row.refused).toBeGreaterThan(0);
    // The event is still there, the payment is as the lane left it, and the failed delivery
    // produced no operational event of its own — no log of the log.
    expect((await events()).map((event) => event.code)).toEqual([
      'payments.gateway_create_unknown',
    ]);
    expect(await allEventCount()).toBe(before);
    const payment = await c.database.db.execute(
      sql`SELECT state FROM payments WHERE id = ${attempt.payment.id}`,
    );
    expect((payment.rows[0] as { state: string }).state).toBe('PENDING');
  });
});
