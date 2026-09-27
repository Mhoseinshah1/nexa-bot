import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  EMPTY_PRODUCT_DISPLAY,
  PLATFORM_ERROR_CODES,
  SESSION_COOKIE_NAME,
  errors,
  isNexaError,
  money,
  type ActorContext,
  type AdminId,
  type BotInstanceId,
  type CorrelationId,
  type OrderId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import {
  DrizzleServiceRepository,
  SERVICE_LIFECYCLE_LOCK_CLASS,
} from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { DrizzleOperationRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-operation.repository';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import { ServiceRefundRequestsController } from '../../apps/api/src/surfaces/web/service-refund-requests.controller';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  validatePanelConnection,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * WP19 — a customer's service refund request, end to end, against real everything: a real
 * PostgreSQL, the real provisioner, the real Marzban adapter on a real socket, a real socket
 * standing in for Telegram, and the real bot runtime.
 *
 * What it defends (brief §2.11): one request per service however it is filed; one decision
 * however many administrators press; the money credited exactly once and only after the
 * provider account is gone; nothing credited on an ambiguous or failed deletion; the bound
 * shared with every other refund of the same payment; and the service leaving the customer's
 * view only once the refund COMPLETED.
 */

type WebRequest = Parameters<ServiceRefundRequestsController['list']>[0];

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const CUSTOMER_TG = '910911';
const ADMIN_TG = '920922';
const DECIDER_TG = '920923';
const PRICE = 250_000n;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

describe('WP19 — a customer asks for their money back', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let operations: DrizzleOperationRepository;
  let panelId: string;
  let customerA: UserId;
  let owner: ActorContext;
  let ownerId: AdminId;
  let updateSeq = 0;
  let flagSeq = 0;
  let fileSeq = 0;

  beforeAll(async () => {
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = { unparseable: raw };
        }
        sent.push({ url: request.url ?? '', body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(ctx.container.database.db);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    operations = new DrizzleOperationRepository(ctx.container.database.db);
    sent = [];
    panel = await startFakeMarzban({ host: '127.0.0.2' });

    const seeded = await createAdmin(ctx.container, tenantA, {
      username: 'owner-refunds',
      roleKeys: ['owner'],
      telegramUserId: ADMIN_TG,
    });
    ownerId = seeded.id as AdminId;
    owner = adminActorFor(seeded);

    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-refunds-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);

    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-refunds',
      telegramUserId: CUSTOMER_TG,
      from: { id: Number(CUSTOMER_TG), first_name: 'مریم' },
      botInstanceId: BOT_A,
    });
    customerA = resolved.customer.id;
    await setFlag(true);
  });

  async function setFlag(enabled: boolean): Promise<void> {
    const flags = await ctx.container.featureFlags.list(tenantA, owner);
    const current = flags.find((flag) => flag.key === 'customer_refund_requests');
    flagSeq += 1;
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'customer_refund_requests',
      enabled,
      expectedVersion: current?.version ?? null,
      idempotencyKey: `wp19-flag-${String(flagSeq)}`,
      confirmKey: 'customer_refund_requests',
      reason: 'WP19 integration.',
    });
  }

  /** A NEW_SERVICE order paid from the wallet, provisioned onto the panel, ACTIVE here. */
  async function activeService(key: string): Promise<{ id: string; orderId: OrderId }> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(PRICE, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(key), {
      idempotencyKey: `${key}-draft`,
      customerId: customerA,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId: customerA,
      orderId: draft.id,
    });
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor: PRICE,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), customerA, {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id,
    });
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, confirmed.id);
    if (service === undefined || service === null) throw new Error('no service');
    expect(service.state, 'the fixture must start ACTIVE').toBe('ACTIVE');
    return { id: service.id, orderId: confirmed.id };
  }

  /** A filing; each call is its own update unless it names one. */
  const file = (
    serviceId: string,
    reason = 'دیگر نیازی به این سرویس ندارم',
    idempotencyKey = `wp19-file-${String(++fileSeq)}`,
  ) =>
    ctx.container.serviceRefundRequests.file(tenantA, systemActor('file'), {
      customerId: customerA,
      serviceId,
      botInstanceId: BOT_A,
      reason,
      idempotencyKey,
    });

  /** A paid renewal of the service, from a wallet funded for it: settles, and plans a RENEW. */
  async function renew(serviceId: string, key: string): Promise<void> {
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: `${key}-renew-credit`,
      direction: 'CREDIT',
      amountMinor: PRICE,
      currency: 'IRT',
      note: 'fixture',
    });
    const { order } = await ctx.container.commercialActions.draft(
      tenantA,
      systemActor(key),
      customerA,
      { serviceId, kind: 'RENEW', idempotencyKey: `act-${key}-quote` },
    );
    await ctx.container.commercialActions.confirm(tenantA, systemActor(key), customerA, {
      orderId: order.id,
      idempotencyKey: `act-${key}-confirm`,
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), customerA, {
      idempotencyKey: `act-${key}-pay`,
      orderId: order.id,
    });
  }

  const renewalsOf = async (serviceId: string) =>
    (await operations.listForService(tenantA, serviceId, 50)).filter(
      (operation) => operation.type === 'RENEW',
    );

  /** Holds the service's lifecycle lock in a transaction of its own until released. */
  async function holdLifecycle(serviceId: string): Promise<{ release: () => Promise<void> }> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = ctx.container.database.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${SERVICE_LIFECYCLE_LOCK_CLASS},
              hashtext(${`${tenantA.tenantId}:${serviceId}`}))`,
      );
      held();
      await gate;
    });
    await holding;
    return {
      release: async () => {
        release();
        await holder;
      },
    };
  }

  /** Resolves once some transaction is waiting for an advisory lock. */
  async function someoneWaitsOnAdvisory(what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const waiting = await countRows(
        sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype = 'advisory'`,
      );
      if (waiting >= 1) return;
      if (Date.now() > deadline) throw new Error(`${what} never waited on the lifecycle lock`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const balance = async (): Promise<bigint> =>
    (await ctx.container.wallet.balance(tenantA, owner, customerA)).amountMinor;

  const requestRow = async (id: string) =>
    (await ctx.container.serviceRefundRequests.list(tenantA, owner, { limit: 100 })).find(
      (item) => item.request.id === id,
    );

  const terminateOf = async (serviceId: string) =>
    (await operations.listForService(tenantA, serviceId, 50)).filter(
      (operation) => operation.type === 'TERMINATE',
    );

  const countRows = async (query: ReturnType<typeof sql>): Promise<number> => {
    const result = (await ctx.container.database.db.execute(query as never)) as unknown as {
      rows: { n: number }[];
    };
    return Number(result.rows[0]?.n ?? 0);
  };

  const walletCredits = (refundId: string | null) =>
    countRows(
      sql`SELECT count(*)::int AS n FROM wallet_entries
           WHERE reference = ${`${refundId ?? ''}:refund`}`,
    );

  const notices = (kind: string) =>
    countRows(sql`SELECT count(*)::int AS n FROM customer_notifications WHERE kind = ${kind}`);

  const tapUpdate = (data: string, telegramUserId = CUSTOMER_TG) => {
    updateSeq += 1;
    return {
      idempotencyKey: `wp19-update-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'مریم' },
      update: {
        update_id: updateSeq,
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'مریم' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: Number(telegramUserId), type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
    };
  };

  const textUpdate = (text: string, telegramUserId = CUSTOMER_TG) => {
    updateSeq += 1;
    return {
      idempotencyKey: `wp19-update-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'مریم' },
      update: {
        update_id: updateSeq,
        message: {
          message_id: updateSeq,
          date: 0,
          text,
          chat: { id: Number(telegramUserId), type: 'private' },
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'مریم' },
        },
      },
    };
  };

  const handle = (update: ReturnType<typeof tapUpdate> | ReturnType<typeof textUpdate>) =>
    ctx.container.botRuntime.handle(tenantA, systemActor('bot'), update);

  /** The last message sent or edited — never the bare `answerCallbackQuery` beside it. */
  const lastSent = () =>
    JSON.stringify(sent.filter((one) => !one.url.includes('/answerCallbackQuery')).at(-1) ?? {});

  async function refused(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      if (isNexaError(error)) return error.code;
      throw error;
    }
    throw new Error('expected a refusal');
  }

  /** The Web Admin controller, and a request carrying a real session of the owner's. */
  /** An administrator holding exactly `refunds.issue` and `services.terminate`, and no view. */
  async function deciderOnly(telegramUserId?: string): Promise<ActorContext> {
    const roleId = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(
      sql`INSERT INTO roles (id, tenant_id, key, name, is_system)
          VALUES (${roleId}, ${tenantA.tenantId}, 'refund_deciders', 'refund_deciders', false)` as never,
    );
    for (const permission of ['refunds.issue', 'services.terminate']) {
      await ctx.container.database.db.execute(
        sql`INSERT INTO role_permissions (tenant_id, role_id, permission_key)
            VALUES (${tenantA.tenantId}, ${roleId}, ${permission})` as never,
      );
    }
    const decider = await createAdmin(ctx.container, tenantA, {
      username: 'decider-only',
      ...(telegramUserId === undefined ? {} : { telegramUserId }),
    });
    await ctx.container.database.db.execute(
      sql`INSERT INTO admin_roles (tenant_id, admin_id, role_id)
          VALUES (${tenantA.tenantId}, ${decider.id}, ${roleId})` as never,
    );
    return adminActorFor(decider);
  }

  const asWebOwner = () => asWeb('owner-refunds');

  async function asWeb(username: string): Promise<{
    controller: ServiceRefundRequestsController;
    request: WebRequest;
  }> {
    const { token } = await ctx.container.auth.login(
      tenantA,
      {
        type: 'API',
        id: null,
        label: null,
        surface: 'WEB',
        correlationId: 'wp19-web' as CorrelationId,
      },
      { username, password: 'a-perfectly-fine-password' },
      { ip: '203.0.113.10', userAgent: 'vitest' },
    );
    return {
      controller: new ServiceRefundRequestsController(ctx.container),
      request: {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
        ip: '203.0.113.10',
      } as unknown as WebRequest,
    };
  }

  // ===========================================================================
  // The customer's side
  // ===========================================================================

  it('files one request from Telegram: ask, confirm, reason — and nothing is moved yet', async () => {
    const service = await activeService('tg-file');

    const detail = await handle(tapUpdate(`s:${service.id}`));
    expect(detail.replyKey).toBe('bot.service.card');
    expect(lastSent(), 'the button is drawn').toContain(`fa:${service.id}`);

    const ask = await handle(tapUpdate(`fa:${service.id}`));
    expect(ask.replyKey).toBe('bot.service.refund_request_ask');
    expect(await countRows(sql`SELECT count(*)::int AS n FROM service_refund_requests`)).toBe(0);

    const prompt = await handle(tapUpdate(`fb:${service.id}`));
    expect(prompt.replyKey).toBe('bot.service.refund_request_reason_prompt');
    expect(await countRows(sql`SELECT count(*)::int AS n FROM service_refund_requests`)).toBe(0);

    const before = await balance();
    const filed = await handle(textUpdate('سرعت مناسب نبود'));
    expect(filed.replyKey).toBe('bot.service.refund_request_registered');

    const rows = await ctx.container.serviceRefundRequests.list(tenantA, owner, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.request.state).toBe('OPEN');
    expect(rows[0]?.request.reason).toBe('سرعت مناسب نبود');
    expect(rows[0]?.remaining.amountMinor, 'the principal, and nothing more').toBe(PRICE);
    expect(await balance(), 'no money moved').toBe(before);
    expect((await terminateOf(service.id)).length, 'no deletion planned').toBe(0);
    expect(
      panel.users.has((await services.findById(tenantA, service.id))?.providerUsername ?? ''),
    ).toBe(true);
  });

  it('keeps the reason prompt open when filing fails for a reason nobody classified (Codex review of #83, round 8)', async () => {
    const service = await activeService('tg-file-transient');
    await handle(tapUpdate(`fa:${service.id}`));
    await handle(tapUpdate(`fb:${service.id}`));
    const filing = vi
      .spyOn(ctx.container.serviceRefundRequests, 'file')
      .mockRejectedValueOnce(new Error('connection reset'));
    try {
      await handle(textUpdate('سرعت مناسب نبود')).catch(() => undefined);
    } finally {
      filing.mockRestore();
    }
    expect(await countRows(sql`SELECT count(*)::int AS n FROM service_refund_requests`)).toBe(0);
    // The customer sends the reason again: the window is still there to read it.
    const again = await handle(textUpdate('سرعت مناسب نبود'));
    expect(again.replyKey).toBe('bot.service.refund_request_registered');
    expect(await countRows(sql`SELECT count(*)::int AS n FROM service_refund_requests`)).toBe(1);
  });

  it('keeps the reason prompt open when filing fails with a typed error nobody answers (Codex review of #83, round 9)', async () => {
    const service = await activeService('tg-file-typed');
    await handle(tapUpdate(`fa:${service.id}`));
    await handle(tapUpdate(`fb:${service.id}`));
    const filing = vi
      .spyOn(ctx.container.serviceRefundRequests, 'file')
      .mockRejectedValueOnce(
        errors.internal('platform.outbox_sequence_failed', 'The outbox sequence failed.'),
      );
    try {
      await handle(textUpdate('سرعت مناسب نبود')).catch(() => undefined);
    } finally {
      filing.mockRestore();
    }
    expect(await countRows(sql`SELECT count(*)::int AS n FROM service_refund_requests`)).toBe(0);
    const again = await handle(textUpdate('سرعت مناسب نبود'));
    expect(again.replyKey).toBe('bot.service.refund_request_registered');
    expect(await countRows(sql`SELECT count(*)::int AS n FROM service_refund_requests`)).toBe(1);
  });

  it('keeps the reason prompt shut when filing is refused with a sentence the customer is shown (Codex review of #83, round 9)', async () => {
    const service = await activeService('tg-file-answered');
    await handle(tapUpdate(`fa:${service.id}`));
    await handle(tapUpdate(`fb:${service.id}`));
    const filing = vi
      .spyOn(ctx.container.serviceRefundRequests, 'file')
      .mockRejectedValueOnce(
        errors.conflict(COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE, 'Not offered.'),
      );
    let answered: Awaited<ReturnType<typeof handle>>;
    try {
      answered = await handle(textUpdate('سرعت مناسب نبود'));
    } finally {
      filing.mockRestore();
    }
    expect(answered.replyKey).toBe('bot.service.action_unavailable');
    // An answered refusal is an answer: the next message is not swallowed as a reason.
    const next = await handle(textUpdate('سرعت مناسب نبود'));
    expect(next.replyKey).not.toBe('bot.service.refund_request_registered');
    expect(await countRows(sql`SELECT count(*)::int AS n FROM service_refund_requests`)).toBe(0);
  });

  it('never reads a message sent before the confirmation as the reason (Codex review of #83, round 8)', async () => {
    const service = await activeService('tg-file-order');
    await handle(tapUpdate(`fa:${service.id}`));
    // Typed BEFORE the confirmation tap, delivered after it by a concurrent webhook.
    const early = textUpdate('یک پیام قدیمی');
    await handle(tapUpdate(`fb:${service.id}`));
    const late = await handle(early);
    expect(late.replyKey).not.toBe('bot.service.refund_request_registered');
    expect(await countRows(sql`SELECT count(*)::int AS n FROM service_refund_requests`)).toBe(0);
    // A reason sent after the tap files, as it always did.
    const filed = await handle(textUpdate('سرعت مناسب نبود'));
    expect(filed.replyKey).toBe('bot.service.refund_request_registered');
    expect(await countRows(sql`SELECT count(*)::int AS n FROM service_refund_requests`)).toBe(1);
  });

  it('refuses a reason outside 3–500 code points and asks again, then files the next one', async () => {
    const service = await activeService('tg-reason');
    await handle(tapUpdate(`fb:${service.id}`));
    const short = await handle(textUpdate('نه'));
    expect(short.replyKey).toBe('bot.service.refund_request_reason_invalid');
    expect(await countRows(sql`SELECT count(*)::int AS n FROM service_refund_requests`)).toBe(0);
    const good = await handle(textUpdate('دلیل کافی'));
    expect(good.replyKey).toBe('bot.service.refund_request_registered');
    expect(await countRows(sql`SELECT count(*)::int AS n FROM service_refund_requests`)).toBe(1);
  });

  it('files exactly one request however many times, and however concurrently, it is filed', async () => {
    const service = await activeService('double');
    const results = await Promise.all([file(service.id), file(service.id), file(service.id)]);
    const ids = new Set(results.map((result) => result.request.id));
    expect(ids.size, 'one row').toBe(1);
    expect(results.filter((result) => result.outcome === 'FILED')).toHaveLength(1);
    expect(await countRows(sql`SELECT count(*)::int AS n FROM service_refund_requests`)).toBe(1);
    // And a customer who taps again is told it is pending, not offered a second one.
    const ask = await handle(tapUpdate(`fa:${service.id}`));
    expect(ask.replyKey).toBe('bot.service.refund_request_pending');
  });

  it('offers nothing, and refuses a forged tap, while the switch is off', async () => {
    const service = await activeService('off');
    await setFlag(false);
    await handle(tapUpdate(`s:${service.id}`));
    expect(lastSent(), 'no button').not.toContain(`fa:${service.id}`);
    expect((await handle(tapUpdate(`fa:${service.id}`))).replyKey).toBe(
      'bot.service.refund_request_unavailable',
    );
    expect((await handle(tapUpdate(`fb:${service.id}`))).replyKey).toBe(
      'bot.service.refund_request_unavailable',
    );
    expect(await refused(file(service.id))).toBe(COMMERCE_ERROR_CODES.SERVICE_REFUND_NOT_ELIGIBLE);
  });

  it('keeps a request filed before the switch was turned off decidable', async () => {
    const service = await activeService('off-later');
    const filed = await file(service.id);
    await setFlag(false);
    const rejected = await ctx.container.serviceRefundRequests.reject(tenantA, owner, {
      requestId: filed.request.id,
      reason: 'قابل بازگشت نیست',
    });
    expect(rejected.state).toBe('REJECTED');
  });

  it('answers a request for another customer’s service like one that does not exist', async () => {
    const service = await activeService('other');
    const other = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('o'), {
      idempotencyKey: 'resolve-other',
      telegramUserId: '930930',
      from: { id: 930930, first_name: 'علی' },
      botInstanceId: BOT_A,
    });
    const code = await refused(
      ctx.container.serviceRefundRequests.file(tenantA, systemActor('file'), {
        customerId: other.customer.id,
        serviceId: service.id,
        botInstanceId: BOT_A,
        reason: 'این سرویس من نیست',
        idempotencyKey: 'wp19-file-other',
      }),
    );
    expect(code).toBe(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND);
  });

  // ===========================================================================
  // The decision
  // ===========================================================================

  it('approves once when two administrators approve together', async () => {
    const service = await activeService('two-admins');
    const filed = await file(service.id);
    const second = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-two', roleKeys: ['owner'] }),
    );
    const outcomes = await Promise.allSettled([
      ctx.container.serviceRefundRequests.approve(tenantA, owner, {
        requestId: filed.request.id,
        amountMinor: 100_000n,
      }),
      ctx.container.serviceRefundRequests.approve(tenantA, second, {
        requestId: filed.request.id,
        amountMinor: 100_000n,
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect((await terminateOf(service.id)).length, 'one deletion').toBe(1);
    expect(
      await countRows(
        sql`SELECT count(*)::int AS n FROM refunds WHERE reason = 'SERVICE_REFUND_REQUEST'`,
      ),
      'one reservation',
    ).toBe(1);
  });

  it('lets exactly one of an approval and a rejection win', async () => {
    const service = await activeService('approve-reject');
    const filed = await file(service.id);
    const outcomes = await Promise.allSettled([
      ctx.container.serviceRefundRequests.approve(tenantA, owner, {
        requestId: filed.request.id,
        amountMinor: 50_000n,
      }),
      ctx.container.serviceRefundRequests.reject(tenantA, owner, {
        requestId: filed.request.id,
        reason: 'رد شد',
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const state = (await requestRow(filed.request.id))?.request.state;
    expect(['EXECUTING', 'REJECTED']).toContain(state);
    const planned = (await terminateOf(service.id)).length;
    expect(planned, 'a deletion exactly when the approval won').toBe(state === 'EXECUTING' ? 1 : 0);
  });

  it('refuses an amount above what is left, and zero, with nothing reserved', async () => {
    const service = await activeService('bound');
    const filed = await file(service.id);
    for (const amountMinor of [PRICE + 1n, 0n]) {
      const code = await refused(
        ctx.container.serviceRefundRequests.approve(tenantA, owner, {
          requestId: filed.request.id,
          amountMinor,
        }),
      );
      expect(code).toBe(COMMERCE_ERROR_CODES.REFUND_EXCEEDS_REFUNDABLE);
    }
    expect((await requestRow(filed.request.id))?.request.state).toBe('OPEN');
    expect((await terminateOf(service.id)).length).toBe(0);
  });

  it('shares the payment’s bound with an operator’s own refund made concurrently', async () => {
    const service = await activeService('concurrent-partial');
    const filed = await file(service.id);
    const payment = (await requestRow(filed.request.id))?.request.paymentId as string;
    const outcomes = await Promise.allSettled([
      ctx.container.serviceRefundRequests.approve(tenantA, owner, {
        requestId: filed.request.id,
        amountMinor: 200_000n,
      }),
      ctx.container.refunds.request(tenantA, owner, {
        idempotencyKey: 'op-partial',
        paymentId: payment,
        amountMinor: 200_000n,
        reason: 'بازگشت اپراتور',
      }),
    ]);
    // Both cannot fit in 250,000: exactly one is admitted.
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const reserved = await countRows(
      sql`SELECT COALESCE(sum(amount), 0)::int AS n FROM refunds
           WHERE payment_id = ${payment} AND state <> 'FAILED'`,
    );
    expect(reserved).toBeLessThanOrEqual(Number(PRICE));
  });

  it('refuses an administrator who may refund but not delete, and records nothing', async () => {
    const service = await activeService('permission');
    const filed = await file(service.id);
    const finance = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'finance-only',
        roleKeys: ['finance'],
      }),
    );
    await expect(
      ctx.container.serviceRefundRequests.approve(tenantA, finance, {
        requestId: filed.request.id,
        amountMinor: 1_000n,
      }),
    ).rejects.toThrow();
    await expect(
      ctx.container.serviceRefundRequests.reject(tenantA, finance, {
        requestId: filed.request.id,
        reason: 'نه',
      }),
    ).rejects.toThrow();
    expect((await requestRow(filed.request.id))?.request.state).toBe('OPEN');
  });

  it('cannot be reached from another tenant', async () => {
    const service = await activeService('tenant');
    const filed = await file(service.id);
    const foreign = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-b', roleKeys: ['owner'] }),
    );
    const code = await refused(
      ctx.container.serviceRefundRequests.approve(tenantB, foreign, {
        requestId: filed.request.id,
        amountMinor: 1_000n,
      }),
    );
    expect(code).toBe(COMMERCE_ERROR_CODES.SERVICE_REFUND_REQUEST_NOT_FOUND);
    expect(await ctx.container.serviceRefundRequests.list(tenantB, foreign, { limit: 10 })).toEqual(
      [],
    );
  });

  it('rejects once, with the reason, deleting nothing and moving nothing', async () => {
    const service = await activeService('reject');
    const filed = await file(service.id);
    const before = await balance();
    const rejected = await ctx.container.serviceRefundRequests.reject(tenantA, owner, {
      requestId: filed.request.id,
      reason: 'خارج از بازه',
    });
    expect(rejected.state).toBe('REJECTED');
    // A replay with the same reason answers with the row; a different one is refused.
    expect(
      (
        await ctx.container.serviceRefundRequests.reject(tenantA, owner, {
          requestId: filed.request.id,
          reason: 'خارج از بازه',
        })
      ).state,
    ).toBe('REJECTED');
    expect(
      await refused(
        ctx.container.serviceRefundRequests.reject(tenantA, owner, {
          requestId: filed.request.id,
          reason: 'دلیل دیگر',
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.SERVICE_REFUND_REQUEST_STATE_INVALID);
    expect(await balance()).toBe(before);
    expect((await terminateOf(service.id)).length).toBe(0);
    expect(await notices('SERVICE_REFUND_REQUEST_REJECTED')).toBe(1);
  });

  // ===========================================================================
  // Deletion, then money
  // ===========================================================================

  it('credits the wallet exactly once, only after the account is deleted, then hides the service', async () => {
    const service = await activeService('complete');
    const filed = await file(service.id);
    const username = (await services.findById(tenantA, service.id))?.providerUsername ?? '';
    const before = await balance();

    const approved = await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: filed.request.id,
      amountMinor: 180_000n,
    });
    expect(approved.state).toBe('EXECUTING');
    expect(await balance(), 'nothing credited at approval').toBe(before);
    expect(
      (await ctx.container.provisioning.pageForCustomer(tenantA, customerA, 1)).items.map(
        (item) => item.id,
      ),
      'still the customer’s while it is being deleted',
    ).toContain(service.id);

    await ctx.container.provisionerLoop.tick();
    expect(panel.users.has(username), 'deleted on the panel').toBe(false);
    expect((await services.findById(tenantA, service.id))?.state).toBe('TERMINATED');

    // The sweep runs in the same tick; run it again to prove it credits once.
    await ctx.container.serviceRefundRequests.settleDue(tenantA);
    await ctx.container.provisionerLoop.tick();
    const row = await requestRow(filed.request.id);
    expect(row?.request.state).toBe('COMPLETED');
    expect(await balance(), 'credited once, the approved amount').toBe(before + 180_000n);
    expect(await walletCredits(row?.request.refundId ?? null)).toBe(1);
    expect(await notices('SERVICE_REFUND_REQUEST_APPROVED')).toBe(1);
    // The approval's notice names the amount AND the removal; the generic refund notice
    // would be the same money told twice.
    expect(await notices('REFUND_COMPLETED'), 'told once, not twice').toBe(0);

    const listed = await ctx.container.provisioning.pageForCustomer(tenantA, customerA, 1);
    expect(
      listed.items.map((item) => item.id),
      'gone from the customer’s list',
    ).not.toContain(service.id);
    expect(
      await refused(ctx.container.provisioning.getForCustomer(tenantA, customerA, service.id)),
    ).toBe(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND);
    // And still the operator's, with its history.
    expect((await services.findById(tenantA, service.id))?.id).toBe(service.id);
  });

  it('records a full request refund as removing the service, never as leaving it untouched (Codex review of #83, round 5)', async () => {
    const service = await activeService('full-principal');
    const filed = await file(service.id);
    await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: filed.request.id,
      amountMinor: PRICE,
    });
    await ctx.container.provisionerLoop.tick();
    await ctx.container.serviceRefundRequests.settleDue(tenantA);
    expect((await requestRow(filed.request.id))?.request.state).toBe('COMPLETED');
    const audits = (await ctx.container.database.db.execute(
      sql`SELECT after FROM audit_logs
           WHERE action = 'order.refund' AND entity_id = ${service.orderId}` as never,
    )) as unknown as { rows: { after: Record<string, unknown> }[] };
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]?.after.state).toBe('REFUNDED');
    expect(audits.rows[0]?.after.serviceRemovedByRequest).toBe(true);
    expect(audits.rows[0]?.after).not.toHaveProperty('serviceLeftUntouched');
  });

  it('sends a queued registration notice only while its request is still open (Codex review of #83, round 5)', async () => {
    const service = await activeService('registered-stale');
    const filed = await file(service.id);
    const values = () =>
      ctx.container.serviceRefundRequests.notificationValues(
        tenantA,
        'SERVICE_REFUND_REQUEST_REGISTERED',
        filed.request.id,
      );
    expect(await values()).toEqual({});
    await ctx.container.serviceRefundRequests.reject(tenantA, owner, {
      requestId: filed.request.id,
      reason: 'پس از ثبت رد شد',
    });
    // A fallback still queued behind a rate limit would now say "awaiting review".
    expect(await values()).toBeNull();
  });

  it('names the approving administrator on the wallet credit the sweep writes (Codex review of #83, round 6)', async () => {
    const service = await activeService('credit-actor');
    const filed = await file(service.id);
    await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: filed.request.id,
      amountMinor: 120_000n,
    });
    await ctx.container.provisionerLoop.tick();
    const row = await requestRow(filed.request.id);
    expect(row?.request.state).toBe('COMPLETED');
    const credit = await ctx.container.database.db.execute(
      sql`SELECT actor_admin_id FROM wallet_entries
           WHERE reference = ${`${row?.request.refundId ?? ''}:refund`}`,
    );
    expect(credit.rows, 'one credit').toHaveLength(1);
    expect(
      (credit.rows[0] as { actor_admin_id: string | null }).actor_admin_id,
      'the administrator who decided the amount, not an anonymous system credit',
    ).toBe(ownerId);
  });

  it('keeps a pending request credit as currency exposure until it is decided (Codex review of #83, round 8)', async () => {
    const service = await activeService('currency-exposure');
    const filed = await file(service.id);
    // The whole remaining principal: the reservation consumes the payment's balance.
    await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: filed.request.id,
      amountMinor: PRICE,
    });
    const change = () =>
      ctx.container.settingsService.set(tenantA, owner, {
        key: 'sales.currency',
        value: 'IRR',
        expectedVersion: null,
        idempotencyKey: `currency-exposure-${ctx.container.ids.uuid()}`,
      });
    // The credit is still to be written, in the payment's currency: no change yet.
    await expect(change()).rejects.toMatchObject({ code: 'control.invalid_value' });

    // Deleted and credited: nothing is owed in the old currency any more.
    await ctx.container.provisionerLoop.tick();
    expect((await requestRow(filed.request.id))?.request.state).toBe('COMPLETED');
    await expect(change()).resolves.toBeDefined();
  });

  it('credits nothing while the deletion’s answer is uncertain', async () => {
    const service = await activeService('ambiguous');
    const filed = await file(service.id);
    const before = await balance();
    await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: filed.request.id,
      amountMinor: 100_000n,
    });
    panel.behaviour = 'server-error';
    await ctx.container.provisionerLoop.tick();
    await ctx.container.serviceRefundRequests.settleDue(tenantA);
    const operation = (await terminateOf(service.id))[0];
    expect(operation?.state, 'not decided').not.toBe('SUCCEEDED');
    expect((await requestRow(filed.request.id))?.request.state).toBe('EXECUTING');
    expect(await balance()).toBe(before);
    expect(await notices('SERVICE_REFUND_REQUEST_APPROVED')).toBe(0);
  });

  it('leaves a request whose deletion is UNKNOWN executing, crediting and releasing nothing', async () => {
    const service = await activeService('unknown');
    const filed = await file(service.id);
    const before = await balance();
    await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: filed.request.id,
      amountMinor: 100_000n,
    });
    // The executor's own answer to a lost DELETE; forced so the sweep's reading of it is
    // what is under test: UNKNOWN is neither success nor failure (CLAUDE.md, Phase 4).
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET state = 'UNKNOWN'
           WHERE service_id = ${service.id} AND type = 'TERMINATE'` as never,
    );
    await ctx.container.serviceRefundRequests.settleDue(tenantA);
    const row = await requestRow(filed.request.id);
    expect(row?.request.state).toBe('EXECUTING');
    expect(await balance(), 'nothing credited').toBe(before);
    expect(row?.remaining.amountMinor, 'the reservation still held').toBe(PRICE - 100_000n);
  });

  it('credits nothing when a deletion reads SUCCEEDED but the service did not move', async () => {
    const service = await activeService('unmoved');
    const filed = await file(service.id);
    const before = await balance();
    await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: filed.request.id,
      amountMinor: 100_000n,
    });
    // A state the executor never writes (it terminates the service in the same
    // transaction); forced here so the sweep's own guard is what is under test.
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET state = 'SUCCEEDED', completed_at = now()
           WHERE service_id = ${service.id} AND type = 'TERMINATE'` as never,
    );
    await ctx.container.serviceRefundRequests.settleDue(tenantA);
    expect((await services.findById(tenantA, service.id))?.state).toBe('ACTIVE');
    expect((await requestRow(filed.request.id))?.request.state).toBe('EXECUTING');
    expect(await balance(), 'no money on a guess').toBe(before);
  });

  it('refuses an operator completing or abandoning a request’s reserved refund by hand', async () => {
    const service = await activeService('by-hand');
    const filed = await file(service.id);
    const before = await balance();
    const approved = await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: filed.request.id,
      amountMinor: 100_000n,
    });
    const refundId = approved.refundId ?? '';
    expect(
      await refused(
        ctx.container.refunds.complete(tenantA, owner, {
          idempotencyKey: 'by-hand-complete',
          refundId,
          note: 'paid by hand',
          externalReference: null,
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.REFUND_STATE_INVALID);
    expect(
      await refused(
        ctx.container.refunds.fail(tenantA, owner, {
          idempotencyKey: 'by-hand-fail',
          refundId,
          note: 'abandoned by hand',
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.REFUND_STATE_INVALID);
    expect(await balance(), 'nothing credited by hand').toBe(before);
    expect(await walletCredits(refundId)).toBe(0);
    expect((await requestRow(filed.request.id))?.request.state).toBe('EXECUTING');
  });

  it('refuses to announce a reservation closed elsewhere without its credit, and settles the next request anyway', async () => {
    // A rollback past WP19 runs a release whose operator `complete` knows nothing of
    // reservations: a hand-made call moves the reserved refund to COMPLETED with no
    // ledger credit. Forced here as that release would write it.
    const closed = await activeService('closed-elsewhere');
    const closedFiled = await file(closed.id);
    const next = await activeService('next-in-line');
    const nextFiled = await file(next.id);
    const before = await balance();
    const closedApproved = await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: closedFiled.request.id,
      amountMinor: 100_000n,
    });
    await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: nextFiled.request.id,
      amountMinor: 120_000n,
    });
    const closedRefundId = closedApproved.refundId ?? '';
    await ctx.container.database.db.execute(
      sql`UPDATE refunds SET state = 'COMPLETED', completed_at = now(),
                 completed_by_admin_id = requested_by_admin_id
           WHERE id = ${closedRefundId}` as never,
    );

    // One tick deletes both accounts and runs the sweep, oldest request first.
    await ctx.container.provisionerLoop.tick();
    await ctx.container.serviceRefundRequests.settleDue(tenantA);

    expect(
      (await requestRow(closedFiled.request.id))?.request.state,
      'not announced: its money never moved',
    ).toBe('EXECUTING');
    expect(await walletCredits(closedRefundId), 'and not credited on a guess').toBe(0);
    const nextRow = await requestRow(nextFiled.request.id);
    expect(nextRow?.request.state, 'the one behind it is not held').toBe('COMPLETED');
    expect(await walletCredits(nextRow?.request.refundId ?? null)).toBe(1);
    expect(await balance()).toBe(before + 120_000n);
    expect(await notices('SERVICE_REFUND_REQUEST_APPROVED'), 'one approval told, not two').toBe(1);
  });

  it('never lets rows the sweep leaves standing fill the batch ahead of one it can decide (Codex review of #83)', async () => {
    // The stuck one is OLDER: a deletion reading SUCCEEDED whose service never moved.
    const stuck = await activeService('batch-stuck');
    const stuckFiled = await file(stuck.id);
    await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: stuckFiled.request.id,
      amountMinor: 100_000n,
    });
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET state = 'SUCCEEDED', completed_at = now()
           WHERE service_id = ${stuck.id} AND type = 'TERMINATE'` as never,
    );
    const ready = await activeService('batch-ready');
    const readyFiled = await file(ready.id);
    const before = await balance();
    await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: readyFiled.request.id,
      amountMinor: 110_000n,
    });
    // The newer one's deletion is done, as the executor leaves it.
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET state = 'SUCCEEDED', completed_at = now()
           WHERE service_id = ${ready.id} AND type = 'TERMINATE'` as never,
    );
    await ctx.container.database.db.execute(
      sql`UPDATE services SET state = 'TERMINATED', terminated_at = now() WHERE id = ${ready.id}` as never,
    );

    // A batch of ONE: the stuck row must not be the one it holds.
    await ctx.container.serviceRefundRequests.settleDue(tenantA, 1);
    expect((await requestRow(readyFiled.request.id))?.request.state).toBe('COMPLETED');
    expect(await balance()).toBe(before + 110_000n);
    expect((await requestRow(stuckFiled.request.id))?.request.state).toBe('EXECUTING');
  });

  it('waits, releasing nothing, while another deletion of the service is UNKNOWN (Codex review of #83, round 7)', async () => {
    const { service, filed } = await failedUnswept('removal-unknown');
    const before = await balance();
    const operator = await ctx.container.provisioning.requestFromOperator(
      tenantA,
      owner,
      service.id,
      'TERMINATE',
      { idempotencyKey: 'removal-unknown-operator' },
    );
    // The operator's deletion lost its answer: it may already have removed the account.
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET state = 'UNKNOWN'
           WHERE id = ${operator.id}` as never,
    );
    expect(await ctx.container.serviceRefundRequests.settleDue(tenantA)).toBe(0);
    let row = await requestRow(filed.request.id);
    expect(row?.request.state, 'not released past an ambiguous deletion').toBe('EXECUTING');
    expect(row?.remaining.amountMinor, 'still reserved').toBe(PRICE - 100_000n);

    // A read settles it: the account was gone, and the approved refund is paid.
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET state = 'SUCCEEDED', completed_at = now()
           WHERE id = ${operator.id}` as never,
    );
    await ctx.container.database.db.execute(
      sql`UPDATE services SET state = 'TERMINATED', terminated_at = now() WHERE id = ${service.id}` as never,
    );
    await ctx.container.serviceRefundRequests.settleDue(tenantA);
    row = await requestRow(filed.request.id);
    expect(row?.request.state).toBe('COMPLETED');
    expect(await balance()).toBe(before + 100_000n);
  });

  it('decides FAILED, crediting nothing, a request whose reservation was released elsewhere before its deletion succeeded (Codex review of #83, round 7)', async () => {
    const service = await activeService('released-then-deleted');
    const filed = await file(service.id);
    const before = await balance();
    const approved = await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: filed.request.id,
      amountMinor: 100_000n,
    });
    // The release before WP19 fails the reserved refund by hand; its deletion then succeeds.
    await ctx.container.database.db.execute(
      sql`UPDATE refunds SET state = 'FAILED' WHERE id = ${approved.refundId ?? ''}` as never,
    );
    await ctx.container.provisionerLoop.tick();

    expect((await terminateOf(service.id))[0]?.state).toBe('SUCCEEDED');
    expect((await services.findById(tenantA, service.id))?.state).toBe('TERMINATED');
    const row = await requestRow(filed.request.id);
    expect(row?.request.state, 'decided, never left executing for ever').toBe('FAILED');
    expect(row?.request.failureKind).toBe('RESERVATION_RELEASED');
    expect(await balance(), 'no credit for a released reservation').toBe(before);
    expect(await notices('SERVICE_REFUND_REQUEST_APPROVED')).toBe(0);
  });

  it('never lets a request waiting on another deletion fill the batch (Codex review of #83, round 6)', async () => {
    // The waiting one is OLDER: its deletion failed, and an operator's is still planned.
    // Provisioned first (`activeService` ticks the provisioner, and a tick sweeps), filed after.
    const ready = await activeService('batch-ready-after-wait');
    const waiting = await failedUnswept('batch-waiting');
    const readyFiled = await file(ready.id);
    const before = await balance();
    await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: readyFiled.request.id,
      amountMinor: 110_000n,
    });
    // Planned only now, after every tick: a tick would execute it.
    await ctx.container.provisioning.requestFromOperator(
      tenantA,
      owner,
      waiting.service.id,
      'TERMINATE',
      { idempotencyKey: 'batch-waiting-operator' },
    );
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET state = 'SUCCEEDED', completed_at = now()
           WHERE service_id = ${ready.id} AND type = 'TERMINATE'` as never,
    );
    await ctx.container.database.db.execute(
      sql`UPDATE services SET state = 'TERMINATED', terminated_at = now() WHERE id = ${ready.id}` as never,
    );

    // A batch of ONE: the waiting row must not be the one it holds.
    await ctx.container.serviceRefundRequests.settleDue(tenantA, 1);
    expect((await requestRow(readyFiled.request.id))?.request.state).toBe('COMPLETED');
    expect(await balance()).toBe(before + 110_000n);
    expect((await requestRow(waiting.filed.request.id))?.request.state).toBe('EXECUTING');
  });

  it('decides every other request when one fails inside its own settlement', async () => {
    const failing = await activeService('settle-throws');
    const failingFiled = await file(failing.id);
    const next = await activeService('settle-next');
    const nextFiled = await file(next.id);
    const failingApproved = await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: failingFiled.request.id,
      amountMinor: 100_000n,
    });
    await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: nextFiled.request.id,
      amountMinor: 120_000n,
    });
    for (const id of [failing.id, next.id]) {
      await ctx.container.database.db.execute(
        sql`UPDATE provisioning_operations SET state = 'SUCCEEDED', completed_at = now()
             WHERE service_id = ${id} AND type = 'TERMINATE'` as never,
      );
      await ctx.container.database.db.execute(
        sql`UPDATE services SET state = 'TERMINATED', terminated_at = now() WHERE id = ${id}` as never,
      );
    }
    // The older one's credit cannot be written: its settlement throws.
    const reference = `${failingApproved.refundId}:refund`;
    await ctx.container.database.db.execute(
      sql.raw(`CREATE OR REPLACE FUNCTION wp19_refuse_credit() RETURNS trigger AS $$
               BEGIN
                 IF NEW.reference = '${reference}' THEN RAISE EXCEPTION 'credit refused'; END IF;
                 RETURN NEW;
               END $$ LANGUAGE plpgsql`) as never,
    );
    await ctx.container.database.db.execute(
      sql`CREATE TRIGGER wp19_refuse_credit BEFORE INSERT ON wallet_entries
          FOR EACH ROW EXECUTE FUNCTION wp19_refuse_credit()` as never,
    );
    try {
      await ctx.container.serviceRefundRequests.settleDue(tenantA);
    } finally {
      await ctx.container.database.db.execute(
        sql`DROP TRIGGER wp19_refuse_credit ON wallet_entries` as never,
      );
      await ctx.container.database.db.execute(sql`DROP FUNCTION wp19_refuse_credit()` as never);
    }
    expect((await requestRow(failingFiled.request.id))?.request.state).toBe('EXECUTING');
    expect(await walletCredits(failingApproved.refundId)).toBe(0);
    expect((await requestRow(nextFiled.request.id))?.request.state).toBe('COMPLETED');
  });

  it('lets an operator settle an ordinary refund whose typed reason reads like a request’s (Codex review of #83)', async () => {
    const service = await activeService('reason-lookalike');
    const filed = await file(service.id);
    const approved = await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: filed.request.id,
      amountMinor: 10_000n,
    });
    // An operator's own external refund on the same payment, whose free-text reason
    // happens to be the reservation's: nothing links it to a request.
    const ordinaryId = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(
      sql`INSERT INTO refunds (id, tenant_id, payment_id, customer_id, order_id, state, channel,
                               amount, currency, reason, requested_by_admin_id)
          SELECT ${ordinaryId}, tenant_id, payment_id, customer_id, order_id, 'AWAITING_EXTERNAL',
                 'EXTERNAL_MANUAL', 1000, currency, 'SERVICE_REFUND_REQUEST', requested_by_admin_id
            FROM refunds WHERE id = ${approved.refundId}` as never,
    );
    const failed = await ctx.container.refunds.fail(tenantA, owner, {
      idempotencyKey: 'lookalike-fail',
      refundId: ordinaryId,
      note: 'not sent',
    });
    expect(failed.state).toBe('FAILED');
    // The real reservation is still the workflow's.
    expect(
      await refused(
        ctx.container.refunds.fail(tenantA, owner, {
          idempotencyKey: 'reservation-fail',
          refundId: approved.refundId ?? '',
          note: 'abandoned by hand',
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.REFUND_STATE_INVALID);
  });

  it('releases the reservation and credits nothing when the deletion definitively fails', async () => {
    const service = await activeService('definitive');
    const filed = await file(service.id);
    const before = await balance();
    await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: filed.request.id,
      amountMinor: 100_000n,
    });
    panel.behaviour = 'bad-credentials';
    await ctx.container.provisionerLoop.tick();
    await ctx.container.serviceRefundRequests.settleDue(tenantA);

    expect((await terminateOf(service.id))[0]?.state).toBe('FAILED');
    const row = await requestRow(filed.request.id);
    expect(row?.request.state).toBe('FAILED');
    expect(row?.request.failureKind).toBe('AUTHENTICATION_FAILED');
    expect(await balance(), 'nothing credited').toBe(before);
    expect(row?.remaining.amountMinor, 'the reservation released').toBe(PRICE);
    expect(await notices('SERVICE_REFUND_REQUEST_APPROVED')).toBe(0);
    expect((await services.findById(tenantA, service.id))?.state).toBe('ACTIVE');
    // The financial log hears of it as the request's outcome, never as a RefundFailed
    // whose cause the previous release cannot parse (Codex review of #83, round 4).
    expect(
      await countRows(
        sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'RefundFailed'`,
      ),
    ).toBe(0);
    expect(
      await countRows(
        sql`SELECT count(*)::int AS n FROM outbox_messages
             WHERE event_type = 'ServiceRefundRequestResolved'
               AND payload->>'requestId' = ${filed.request.id}
               AND payload->>'outcome' = 'FAILED'`,
      ),
    ).toBe(1);
  });

  /** The request's own deletion failed, and its sweep has not yet run: a crash, a stopped scope. */
  async function failedUnswept(label: string) {
    const service = await activeService(label);
    const filed = await file(service.id);
    await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: filed.request.id,
      amountMinor: 100_000n,
    });
    panel.behaviour = 'bad-credentials';
    const sweep = vi
      .spyOn(ctx.container.serviceRefundRequests, 'settleDue')
      .mockResolvedValueOnce(0);
    try {
      await ctx.container.provisionerLoop.tick();
    } finally {
      sweep.mockRestore();
    }
    panel.behaviour = 'healthy';
    expect((await terminateOf(service.id))[0]?.state).toBe('FAILED');
    expect((await requestRow(filed.request.id))?.request.state).toBe('EXECUTING');
    return { service, filed };
  }

  it('completes, never releases, a request whose service another deletion removed (Codex review of #83, round 6)', async () => {
    const { service, filed } = await failedUnswept('removed-elsewhere');
    const before = await balance();
    // An operator retries the deletion; the next tick executes it and then sweeps.
    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'TERMINATE', {
      idempotencyKey: 'removed-elsewhere-operator',
    });
    await ctx.container.provisionerLoop.tick();

    expect((await services.findById(tenantA, service.id))?.state).toBe('TERMINATED');
    const row = await requestRow(filed.request.id);
    expect(row?.request.state, 'the approved refund is paid').toBe('COMPLETED');
    expect(await balance(), 'credited the approved amount').toBe(before + 100_000n);
    expect(row?.remaining.amountMinor, 'the reservation settled, not released').toBe(
      PRICE - 100_000n,
    );
    expect(await notices('SERVICE_REFUND_REQUEST_APPROVED')).toBe(1);
  });

  it('releases, never credits, a reservation already released elsewhere when another deletion removed the service (Codex review of #83, round 6)', async () => {
    const { service, filed } = await failedUnswept('released-elsewhere');
    const before = await balance();
    // The release before WP19 fails the reserved refund by hand, as its operator `fail` would.
    const refundId = (await requestRow(filed.request.id))?.request.refundId ?? '';
    await ctx.container.database.db.execute(
      sql`UPDATE refunds SET state = 'FAILED' WHERE id = ${refundId}` as never,
    );
    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'TERMINATE', {
      idempotencyKey: 'released-elsewhere-operator',
    });
    await ctx.container.provisionerLoop.tick();

    expect((await services.findById(tenantA, service.id))?.state).toBe('TERMINATED');
    // Decided, not stranded: a settlement the ledger would refuse is never attempted.
    expect((await requestRow(filed.request.id))?.request.state).toBe('FAILED');
    expect(await balance(), 'nothing credited for a released reservation').toBe(before);
  });

  it('waits, releasing nothing, while another deletion of the service is in flight (Codex review of #83, round 6)', async () => {
    const { service, filed } = await failedUnswept('removal-in-flight');
    const before = await balance();
    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'TERMINATE', {
      idempotencyKey: 'removal-in-flight-operator',
    });
    // The operator's deletion is planned, not executed: the sweep must wait for its answer.
    expect(await ctx.container.serviceRefundRequests.settleDue(tenantA)).toBe(0);
    let row = await requestRow(filed.request.id);
    expect(row?.request.state).toBe('EXECUTING');
    expect(row?.remaining.amountMinor, 'still reserved').toBe(PRICE - 100_000n);

    await ctx.container.provisionerLoop.tick();
    row = await requestRow(filed.request.id);
    expect(row?.request.state).toBe('COMPLETED');
    expect(await balance()).toBe(before + 100_000n);
  });

  it('logs each outcome to the financial log, and the rejection with no amount', async () => {
    const LOG_CHAT = '-1001234567890';
    let seq = 0;
    const key = () => `wp19-log-${String((seq += 1))}`;
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'ops_notifications',
      enabled: true,
      expectedVersion: null,
      idempotencyKey: key(),
      confirmKey: 'ops_notifications',
      reason: 'WP19 financial log.',
    });
    for (const [settingKey, value] of [
      ['ops.notifications.telegram_chat_id', LOG_CHAT],
      ['ops.notifications.telegram_topic_id', 5],
      ['ops.notifications.payments_topic_id', 77],
    ] as const) {
      await ctx.container.settingsService.set(tenantA, owner, {
        key: settingKey,
        value,
        expectedVersion: null,
        idempotencyKey: key(),
      });
    }
    const approvedService = await activeService('log-complete');
    const approvedRequest = await file(approvedService.id);
    await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: approvedRequest.request.id,
      amountMinor: 90_000n,
    });
    await ctx.container.provisionerLoop.tick();
    const rejectedService = await activeService('log-reject');
    const rejectedRequest = await file(rejectedService.id);
    await ctx.container.serviceRefundRequests.reject(tenantA, owner, {
      requestId: rejectedRequest.request.id,
      reason: 'رد شد',
    });
    for (let round = 0; round < 20; round += 1) {
      if ((await ctx.container.relay.processBatch()).claimed === 0) break;
    }
    const result = (await ctx.container.database.db.execute(
      sql`SELECT payload FROM notifications
           WHERE kind = 'OPERATIONAL_EVENT' AND template_key = 'ops.financial.service_refund_request'
           ORDER BY created_at` as never,
    )) as unknown as { rows: { payload: Record<string, unknown> }[] };
    const byRequest = new Map(result.rows.map((row) => [row.payload['requestId'], row.payload]));
    expect(byRequest.get(approvedRequest.request.id)).toMatchObject({
      outcome: 'COMPLETED',
      serviceId: approvedService.id,
      telegramId: CUSTOMER_TG,
      adminId: ownerId,
    });
    expect(byRequest.get(approvedRequest.request.id)?.['amount']).toBeDefined();
    const rejectedLog = byRequest.get(rejectedRequest.request.id);
    expect(rejectedLog).toMatchObject({ outcome: 'REJECTED', adminId: ownerId });
    expect(
      rejectedLog?.['amount'],
      'a rejection moved nothing, so it states no amount',
    ).toBeUndefined();
  });

  // ===========================================================================
  // The administrator's Telegram card
  // ===========================================================================

  it('approves from Telegram: amount, one destructive confirmation, then execution', async () => {
    const service = await activeService('tg-admin');
    const filed = await file(service.id);

    const opened = await handle(tapUpdate(`qa:${filed.request.id}`, ADMIN_TG));
    expect(opened.replyKey).toBe('bot.admin.refund_request_amount_prompt');

    const tooMuch = await handle(textUpdate(String(PRICE + 1n), ADMIN_TG));
    expect(tooMuch.replyKey).toBe('bot.admin.refund_request_amount_invalid');

    const stated = await handle(textUpdate('120000', ADMIN_TG));
    expect(stated.replyKey).toBe('bot.admin.refund_request_confirm');
    const capture = (await ctx.container.database.db.execute(
      sql`SELECT id FROM admin_amount_captures WHERE purpose = 'SERVICE_REFUND_AMOUNT'` as never,
    )) as unknown as { rows: { id: string }[] };
    const captureId = capture.rows[0]?.id ?? '';
    expect(lastSent()).toContain(`qc:${captureId}`);
    expect((await requestRow(filed.request.id))?.request.state, 'not before the confirm').toBe(
      'OPEN',
    );

    const done = await handle(tapUpdate(`qc:${captureId}`, ADMIN_TG));
    expect(done.replyKey).toBe('bot.admin.refund_request_executing');
    // A second tap on the same confirmation is the same approval.
    await handle(tapUpdate(`qc:${captureId}`, ADMIN_TG));
    const row = await requestRow(filed.request.id);
    expect(row?.request.state).toBe('EXECUTING');
    expect(row?.request.approvedAmount?.amountMinor).toBe(120_000n);
    expect(row?.request.decidedByAdminId).toBe(ownerId);
    expect((await terminateOf(service.id)).length).toBe(1);
  });

  it('opens a decision prompt for an administrator holding exactly the two decision keys (Codex review of #83)', async () => {
    const service = await activeService('decide-only');
    const filed = await file(service.id);
    const actor = await deciderOnly();
    // The card is pushed on these two keys; its buttons must work on them too.
    const opened = await ctx.container.serviceRefundDecisions.openApprove(tenantA, actor, {
      botInstanceId: BOT_A,
      requestId: filed.request.id,
    });
    expect(opened.outcome).toBe('OPENED');
    const stated = await ctx.container.serviceRefundDecisions.submitText(tenantA, actor, {
      idempotencyKey: 'wp19-text-1',
      botInstanceId: BOT_A,
      text: '90000',
    });
    expect(stated.outcome).toBe('AMOUNT_ENTERED');
  });

  it('answers a pushed card’s taps from an administrator with no panel section, and nothing else (Codex review of #83, round 9)', async () => {
    const service = await activeService('decide-only-tg');
    const filed = await file(service.id);
    await deciderOnly(DECIDER_TG);
    const opened = await handle(tapUpdate(`qa:${filed.request.id}`, DECIDER_TG));
    expect(opened.replyKey).toBe('bot.admin.refund_request_amount_prompt');
    const stated = await handle(textUpdate('90000', DECIDER_TG));
    expect(stated.replyKey).toBe('bot.admin.refund_request_confirm');
    // The panel is still theirs to not have: only the card's own intents are admitted.
    const panel = await handle(tapUpdate('A:', DECIDER_TG));
    expect(panel.replyKey).not.toBe('bot.admin.panel');
  });

  it('answers a replayed confirmation after the deletion finished as decided, not as started (Codex review of #83)', async () => {
    const service = await activeService('replay-finished');
    const filed = await file(service.id);
    await ctx.container.serviceRefundDecisions.openApprove(tenantA, owner, {
      botInstanceId: BOT_A,
      requestId: filed.request.id,
    });
    const stated = await ctx.container.serviceRefundDecisions.submitText(tenantA, owner, {
      idempotencyKey: 'wp19-text-2',
      botInstanceId: BOT_A,
      text: '100000',
    });
    expect(stated.outcome).toBe('AMOUNT_ENTERED');
    const captureId = stated.outcome === 'AMOUNT_ENTERED' ? stated.capture.id : '';
    const first = await ctx.container.serviceRefundDecisions.confirmApprove(tenantA, owner, {
      captureId,
    });
    expect(first.outcome).toBe('EXECUTING');
    await ctx.container.provisionerLoop.tick();
    await ctx.container.serviceRefundRequests.settleDue(tenantA);
    expect((await requestRow(filed.request.id))?.request.state).toBe('COMPLETED');
    const again = await ctx.container.serviceRefundDecisions.confirmApprove(tenantA, owner, {
      captureId,
    });
    expect(again.outcome).toBe('CLOSED');
  });

  it('rejects and closes its prompt in one transaction, so neither is left without the other (Codex review of #83)', async () => {
    const service = await activeService('reject-atomic');
    const filed = await file(service.id);
    const opened = await ctx.container.serviceRefundDecisions.openReject(tenantA, owner, {
      botInstanceId: BOT_A,
      requestId: filed.request.id,
    });
    expect(opened.outcome).toBe('OPENED');
    // The prompt's close fails. A rejection committed on its own would survive that; one
    // committed with its prompt rolls back with it, and the request is still OPEN.
    await ctx.container.database.db.execute(
      sql`CREATE OR REPLACE FUNCTION wp19_refuse_close() RETURNS trigger AS $$
          BEGIN
            IF NEW.close_reason = 'CONFIRMED' THEN
              RAISE EXCEPTION 'the prompt could not be closed';
            END IF;
            RETURN NEW;
          END $$ LANGUAGE plpgsql` as never,
    );
    await ctx.container.database.db.execute(
      sql`CREATE TRIGGER wp19_refuse_close BEFORE UPDATE ON admin_amount_captures
          FOR EACH ROW EXECUTE FUNCTION wp19_refuse_close()` as never,
    );
    try {
      await expect(
        ctx.container.serviceRefundDecisions.submitText(tenantA, owner, {
          idempotencyKey: 'wp19-text-3',
          botInstanceId: BOT_A,
          text: 'سرویس فعال است',
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.container.database.db.execute(
        sql`DROP TRIGGER wp19_refuse_close ON admin_amount_captures` as never,
      );
      await ctx.container.database.db.execute(sql`DROP FUNCTION wp19_refuse_close()` as never);
    }
    expect((await requestRow(filed.request.id))?.request.state).toBe('OPEN');
    expect(await notices('SERVICE_REFUND_REQUEST_REJECTED')).toBe(0);

    // A rejection made elsewhere while the prompt stood — the Web Admin, say — is answered
    // as itself when the same reason arrives, and the prompt is closed with it.
    const other = await activeService('reject-elsewhere');
    const otherFiled = await file(other.id);
    await ctx.container.serviceRefundDecisions.openReject(tenantA, owner, {
      botInstanceId: BOT_A,
      requestId: otherFiled.request.id,
    });
    await ctx.container.serviceRefundRequests.reject(tenantA, owner, {
      requestId: otherFiled.request.id,
      reason: 'تکراری',
    });
    const redelivered = await ctx.container.serviceRefundDecisions.submitText(tenantA, owner, {
      idempotencyKey: 'wp19-text-4',
      botInstanceId: BOT_A,
      text: 'تکراری',
    });
    expect(redelivered.outcome).toBe('REJECTED');
    const open = await countRows(
      sql`SELECT count(*)::int AS n FROM admin_amount_captures
           WHERE service_refund_request_id = ${otherFiled.request.id} AND closed_at IS NULL`,
    );
    expect(open).toBe(0);
  });

  it('decides nothing with a reason whose prompt was cancelled after the message was read (Codex review of #83)', async () => {
    const service = await activeService('reject-cancelled');
    const filed = await file(service.id);
    await ctx.container.serviceRefundDecisions.openReject(tenantA, owner, {
      botInstanceId: BOT_A,
      requestId: filed.request.id,
    });
    // The race, made deterministic: the message finds its prompt open, and the cancel
    // commits between that read and the decision.
    const decisions = ctx.container.serviceRefundDecisions;
    const captures = (
      decisions as unknown as {
        deps: {
          captures: { findAwaitingReason: (...args: unknown[]) => Promise<{ id: string } | null> };
        };
      }
    ).deps.captures;
    const original = captures.findAwaitingReason;
    captures.findAwaitingReason = async (...args: unknown[]) => {
      const found = await original.apply(captures, args);
      if (found !== null) await decisions.cancel(tenantA, owner, { captureId: found.id });
      return found;
    };
    try {
      const answered = await decisions.submitText(tenantA, owner, {
        idempotencyKey: 'wp19-text-5',
        botInstanceId: BOT_A,
        text: 'این دیگر نباید رد کند',
      });
      expect(answered.outcome).toBe('NO_CAPTURE');
    } finally {
      captures.findAwaitingReason = original;
    }
    const row = await requestRow(filed.request.id);
    expect(row?.request.state).toBe('OPEN');
    expect(row?.request.rejectionReason).toBeNull();
  });

  it("plans one deletion when an operator's terminate races an approval (Codex review of #83, round 4)", async () => {
    const service = await activeService('terminate-race');
    const filed = await file(service.id);
    // The approval holds the service's lock and pauses right after it found no open
    // TERMINATE — the window an unlocked planner could plan a second one in.
    const provisioning = ctx.container.provisioning as unknown as {
      deps: {
        operations: { findOpen: (...args: unknown[]) => Promise<{ id: string } | null> };
      };
    };
    const operations = provisioning.deps.operations;
    const original = operations.findOpen;
    let paused!: () => void;
    const pausedAt = new Promise<void>((resolve) => (paused = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    operations.findOpen = async (...args: unknown[]) => {
      const found = await original.apply(operations, args);
      if (first && args[2] === 'TERMINATE') {
        first = false;
        paused();
        await released;
      }
      return found;
    };
    try {
      const approving = ctx.container.serviceRefundRequests.approve(tenantA, owner, {
        requestId: filed.request.id,
        amountMinor: 10_000n,
      });
      await pausedAt;
      const terminating = ctx.container.provisioning.requestFromOperator(
        tenantA,
        owner,
        service.id,
        'TERMINATE',
        { idempotencyKey: 'terminate-race-operator' },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      const [approved, terminated] = await Promise.all([approving, terminating]);
      const planned = await terminateOf(service.id);
      expect(planned, 'one deletion, answered to both').toHaveLength(1);
      expect(terminated.id).toBe(planned[0]?.id);
      expect(approved.operationId).toBe(planned[0]?.id);
    } finally {
      operations.findOpen = original;
      release();
    }
  });

  it('files nothing for a payment an operator refunded in full while the filing read it (Codex review of #83, round 4)', async () => {
    const service = await activeService('filing-payment-race');
    const paid = (await ctx.container.database.db.execute(
      sql`SELECT id FROM payments WHERE order_id = ${service.orderId}` as never,
    )) as unknown as { rows: { id: string }[] };
    const paymentId = paid.rows[0]?.id ?? '';
    const ledger = (
      ctx.container.serviceRefundRequests as unknown as {
        deps: { refundLedger: { lockPayment: (...args: unknown[]) => Promise<boolean> } };
      }
    ).deps.refundLedger;
    const original = ledger.lockPayment;
    // The operator's full refund commits after the filing read the payment's remainder and
    // before the filing takes the payment's lock.
    ledger.lockPayment = async (...args: unknown[]) => {
      ledger.lockPayment = original;
      await ctx.container.refunds.request(tenantA, owner, {
        idempotencyKey: 'filing-payment-race-operator',
        paymentId,
        amountMinor: PRICE,
        reason: 'operator refund',
      });
      return original.apply(ledger, args);
    };
    try {
      expect(await refused(file(service.id))).toBe(
        COMMERCE_ERROR_CODES.SERVICE_REFUND_NOT_ELIGIBLE,
      );
    } finally {
      ledger.lockPayment = original;
    }
    expect(
      await countRows(
        sql`SELECT count(*)::int AS n FROM service_refund_requests WHERE service_id = ${service.id}`,
      ),
    ).toBe(0);
  });

  it("plans no deletion for an operator's terminate of a service that ended while it waited (Codex review of #83, round 4)", async () => {
    const service = await activeService('terminate-waits');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const holder = ctx.container.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM services WHERE id = ${service.id} FOR UPDATE`);
      await tx.execute(
        sql`UPDATE services SET state = 'TERMINATED', terminated_at = now()
             WHERE id = ${service.id}`,
      );
      locked();
      await gate;
    });
    await holding;
    // Read ACTIVE before the wait; the terminate must judge the row it locked.
    const terminating = refused(
      ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'TERMINATE', {
        idempotencyKey: 'terminate-waits-operator',
      }),
    );
    const deadline = Date.now() + 5_000;
    for (;;) {
      const waiting = await countRows(
        sql`SELECT count(*)::int AS n FROM pg_locks
             WHERE NOT granted AND locktype IN ('tuple', 'transactionid')`,
      );
      if (waiting >= 1) break;
      if (Date.now() > deadline) throw new Error('the terminate never waited on the service');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await holder;
    expect(await terminating).toBe(COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED);
    expect(await terminateOf(service.id)).toHaveLength(0);
  });

  it("reads the panel for an approval's deletion inside the approval's transaction (Codex review of #83, round 4)", async () => {
    const service = await activeService('operability-tx');
    const filed = await file(service.id);
    const panels = (
      ctx.container.provisioning as unknown as {
        deps: { panels: { operability: (...args: unknown[]) => Promise<unknown> } };
      }
    ).deps.panels;
    const original = panels.operability;
    const calls: unknown[][] = [];
    panels.operability = async (...args: unknown[]) => {
      calls.push(args);
      return original.apply(panels, args);
    };
    try {
      await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
        requestId: filed.request.id,
        amountMinor: 1_000n,
      });
    } finally {
      panels.operability = original;
    }
    const terminate = calls.filter((args) => args[2] === 'TERMINATE');
    expect(terminate.length).toBeGreaterThan(0);
    // A read outside it would take a second pool connection while this one holds locks.
    for (const args of terminate) expect(args[3]).toBeDefined();
  });

  it('refuses to preview an approval the approval itself would refuse (Codex review of #83)', async () => {
    const service = await activeService('preview-ended');
    const filed = await file(service.id);
    const opened = await ctx.container.serviceRefundDecisions.openApprove(tenantA, owner, {
      botInstanceId: BOT_A,
      requestId: filed.request.id,
    });
    expect(opened.outcome).toBe('OPENED');
    // The service ends after the request was filed and the prompt opened.
    await ctx.container.database.db.execute(
      sql`UPDATE services SET state = 'TERMINATED', terminated_at = now()
           WHERE id = ${service.id}` as never,
    );
    expect(
      await refused(
        ctx.container.serviceRefundRequests.preview(tenantA, owner, {
          requestId: filed.request.id,
          amountMinor: 1_000n,
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.SERVICE_REFUND_NOT_ELIGIBLE);
    // So the typed amount is answered as not executable, and no confirmation is offered.
    const typed = await ctx.container.serviceRefundDecisions.submitText(tenantA, owner, {
      idempotencyKey: 'wp19-text-6',
      botInstanceId: BOT_A,
      text: '1000',
    });
    expect(typed.outcome).toBe('NOT_EXECUTABLE');
    const recorded = await countRows(
      sql`SELECT count(*)::int AS n FROM admin_amount_captures
           WHERE service_refund_request_id = ${filed.request.id} AND amount_minor IS NOT NULL`,
    );
    expect(recorded).toBe(0);
  });

  it('approves nothing for a service that ends while the approval waits for it (Codex review of #83)', async () => {
    const service = await activeService('approve-race');
    const filed = await file(service.id);
    // An outside termination holds the service row and ends it; the approval must wait for
    // it and then see the service it would be deleting is already gone.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const holder = ctx.container.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM services WHERE id = ${service.id} FOR UPDATE`);
      await tx.execute(
        sql`UPDATE services SET state = 'TERMINATED', terminated_at = now()
             WHERE id = ${service.id}`,
      );
      locked();
      await gate;
    });
    await holding;
    const approval = refused(
      ctx.container.serviceRefundRequests.approve(tenantA, owner, {
        requestId: filed.request.id,
        amountMinor: 1_000n,
      }),
    );
    const deadline = Date.now() + 5_000;
    for (;;) {
      const waiting = await countRows(
        sql`SELECT count(*)::int AS n FROM pg_locks
             WHERE NOT granted AND locktype IN ('tuple', 'transactionid')`,
      );
      if (waiting >= 1) break;
      if (Date.now() > deadline) throw new Error('the approval never waited on the service');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await holder;
    expect(await approval).toBe(COMMERCE_ERROR_CODES.SERVICE_REFUND_NOT_ELIGIBLE);
    const row = await requestRow(filed.request.id);
    expect(row?.request.state).toBe('OPEN');
    expect(row?.request.refundId).toBeNull();
    expect(await terminateOf(service.id)).toHaveLength(0);
    expect(
      await countRows(
        sql`SELECT count(*)::int AS n FROM refunds WHERE payment_id = ${filed.request.paymentId}`,
      ),
    ).toBe(0);
  });

  it('files no request while a paid renewal of the service is undecided, and files and approves once it is applied (Codex review of #83, rounds 9 and 10)', async () => {
    const service = await activeService('renew-first');
    await renew(service.id, 'renew-first');
    expect((await renewalsOf(service.id)).map((operation) => operation.state)).toEqual(['PLANNED']);
    expect(await refused(file(service.id))).toBe(COMMERCE_ERROR_CODES.SERVICE_REFUND_NOT_ELIGIBLE);
    expect(await countRows(sql`SELECT count(*)::int AS n FROM service_refund_requests`)).toBe(0);
    // Applied, the renewal no longer stands in the way.
    await ctx.container.provisionerLoop.tick();
    expect((await renewalsOf(service.id)).map((operation) => operation.state)).toEqual([
      'SUCCEEDED',
    ]);
    const filed = await file(service.id);
    await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: filed.request.id,
      amountMinor: 1_000n,
    });
    expect(await terminateOf(service.id)).toHaveLength(1);
  });

  it('sells no renewal while the service has an open refund request, and sells one once it is decided (Codex review of #83, round 10)', async () => {
    const service = await activeService('renew-open');
    const filed = await file(service.id);
    const before = await balance();
    const error = await renew(service.id, 'renew-open').then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(isNexaError(error) ? error.code : error).toBe(
      COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
    );
    expect(await renewalsOf(service.id)).toHaveLength(0);
    // The fixture credited the price; the refused purchase debited nothing.
    expect(await balance()).toBe(before + PRICE);
    // Rejected, the request no longer stands in the way.
    await ctx.container.serviceRefundRequests.reject(tenantA, owner, {
      requestId: filed.request.id,
      reason: 'این سرویس قابل بازگشت نیست',
    });
    await renew(service.id, 'renew-open-again');
    expect(await renewalsOf(service.id)).toHaveLength(1);
  });

  it('takes no payment for a renewal while an operator’s deletion of the service is undecided (Codex review of #83, round 9)', async () => {
    const service = await activeService('renew-after');
    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'TERMINATE', {
      idempotencyKey: 'renew-after-operator',
    });
    expect(await terminateOf(service.id)).toHaveLength(1);
    const before = await balance();
    const error = await renew(service.id, 'renew-after').then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(isNexaError(error) ? error.code : error).toBe(
      COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
    );
    expect(await renewalsOf(service.id)).toHaveLength(0);
    expect(await balance()).toBe(before + PRICE);
  });

  it('serialises a filing, an approval and a renewal’s settlement on the service’s lifecycle lock (Codex review of #83, rounds 9 and 10)', async () => {
    const service = await activeService('lifecycle-lock');
    // A filing waits for the lock before it decides anything.
    const heldForFiling = await holdLifecycle(service.id);
    const filing = file(service.id);
    await someoneWaitsOnAdvisory('the filing');
    await heldForFiling.release();
    const filed = await filing;
    // And so does the approval.
    const held = await holdLifecycle(service.id);
    const approval = ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: filed.request.id,
      amountMinor: 1_000n,
    });
    await someoneWaitsOnAdvisory('the approval');
    await held.release();
    await approval;
    expect(await terminateOf(service.id)).toHaveLength(1);

    // And a renewal's settlement waits for the same lock.
    const second = await activeService('lifecycle-lock-2');
    const heldAgain = await holdLifecycle(second.id);
    const renewal = renew(second.id, 'lifecycle-lock-2');
    await someoneWaitsOnAdvisory('the renewal');
    await heldAgain.release();
    await renewal;
    expect(await renewalsOf(second.id)).toHaveLength(1);
  });

  it('tells a second administrator who typed the same reason that the request was decided, not that they rejected it (Codex review of #83, round 10)', async () => {
    const service = await activeService('reject-twice');
    const filed = await file(service.id);
    const second = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-three', roleKeys: ['owner'] }),
    );
    const reason = 'این سرویس قابل بازگشت نیست';
    await ctx.container.serviceRefundRequests.reject(tenantA, owner, {
      requestId: filed.request.id,
      reason,
      idempotencyKey: 'reject-twice-first',
    });
    expect(
      await refused(
        ctx.container.serviceRefundRequests.reject(tenantA, second, {
          requestId: filed.request.id,
          reason,
          idempotencyKey: 'reject-twice-second',
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.SERVICE_REFUND_REQUEST_STATE_INVALID);
    // The same administrator's retry is still the same rejection.
    const again = await ctx.container.serviceRefundRequests.reject(tenantA, owner, {
      requestId: filed.request.id,
      reason,
    });
    expect(again.state).toBe('REJECTED');
    expect(again.decidedByAdminId).toBe(ownerId);
  });

  it('answers a malformed request id as one that does not exist, before any query (Codex review of #83)', async () => {
    for (const requestId of ['not-a-uuid', '-'.repeat(36)]) {
      expect(
        await refused(
          ctx.container.serviceRefundRequests.approve(tenantA, owner, {
            requestId,
            amountMinor: 1_000n,
          }),
        ),
      ).toBe(COMMERCE_ERROR_CODES.SERVICE_REFUND_REQUEST_NOT_FOUND);
      expect(
        await refused(
          ctx.container.serviceRefundRequests.reject(tenantA, owner, { requestId, reason: 'رد' }),
        ),
      ).toBe(COMMERCE_ERROR_CODES.SERVICE_REFUND_REQUEST_NOT_FOUND);
      expect(
        await refused(ctx.container.serviceRefundRequests.review(tenantA, owner, requestId)),
      ).toBe(COMMERCE_ERROR_CODES.SERVICE_REFUND_REQUEST_NOT_FOUND);
    }
    // And the HTTP boundary parses its path ids before the service is reached. The bodies are
    // valid, so the only ZodError left to raise is the path id's.
    const { controller, request } = await asWebOwner();
    await expect(
      controller.approve(request, 'not-a-uuid', {
        idempotencyKey: 'wp19-bad-id-approve',
        amountMinor: '1000',
        confirm: true,
      }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await expect(
      controller.reject(request, 'not-a-uuid', {
        idempotencyKey: 'wp19-bad-id-reject',
        reason: 'رد',
      }),
    ).rejects.toMatchObject({
      name: 'ZodError',
    });
    await expect(controller.forService(request, 'not-a-uuid')).rejects.toMatchObject({
      name: 'ZodError',
    });
  });

  it('pages every request in a state by the server’s cursor (Codex review of #83)', async () => {
    const filed: string[] = [];
    for (const key of ['page-a', 'page-b', 'page-c']) {
      const service = await activeService(key);
      filed.push((await file(service.id)).request.id);
    }
    const { controller, request } = await asWebOwner();
    const first = await controller.list(request, { state: 'OPEN', limit: '2' });
    expect(first.requests).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const cursor = first.nextCursor as { at: string; id: string };
    const second = await controller.list(request, {
      state: 'OPEN',
      limit: '2',
      before: cursor.at,
      beforeId: cursor.id,
    });
    expect(second.requests).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const seen = [...first.requests, ...second.requests].map((row) => row.id);
    expect(new Set(seen).size).toBe(3);
    expect([...seen].sort()).toEqual([...filed].sort());
  });

  it('reads every request that wants an operator as one stream, once each, while they move (Codex review of #83, round 6)', async () => {
    const ids: string[] = [];
    for (const key of ['attn-a', 'attn-b', 'attn-c', 'attn-d']) {
      ids.push((await file((await activeService(key)).id)).request.id);
    }
    const [oldest, rejected, moving, newest] = ids as [string, string, string, string];
    await ctx.container.serviceRefundRequests.reject(tenantA, owner, {
      requestId: rejected,
      reason: 'رد',
    });
    const { controller, request } = await asWebOwner();
    const first = await controller.list(request, { attention: 'true', limit: '1' });
    expect(first.requests.map((row) => row.id)).toEqual([newest]);
    // Between two pages, a request moves from OPEN to EXECUTING. Three scans, one per state,
    // could read OPEN after it moved and EXECUTING before; one keyset cannot lose it.
    await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: moving,
      amountMinor: 1_000n,
    });
    const seen = [...first.requests];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = await controller.list(request, {
        attention: 'true',
        limit: '1',
        before: cursor.at,
        beforeId: cursor.id,
      });
      seen.push(...page.requests);
      cursor = page.nextCursor;
    }
    expect(seen.map((row) => row.id)).toEqual([newest, moving, oldest]);
    expect(seen.find((row) => row.id === moving)?.state).toBe('EXECUTING');
    // Never beside a state: two filters naming states would be two answers.
    await expect(controller.list(request, { attention: 'true', state: 'OPEN' })).rejects.toThrow();
  });

  it('answers a decision made on the two decision keys alone with the decided request (Codex review of #83)', async () => {
    const approved = await file((await activeService('decided-view-a')).id);
    const rejected = await file((await activeService('decided-view-r')).id);
    await deciderOnly();
    const { controller, request } = await asWeb('decider-only');
    // The decision commits; the response that reports it must not then need `refunds.view`.
    const approval = await controller.approve(request, approved.request.id, {
      idempotencyKey: 'wp19-decided-view-a',
      amountMinor: '1000',
      confirm: true,
    });
    expect(approval.request.state).toBe('EXECUTING');
    const rejection = await controller.reject(request, rejected.request.id, {
      idempotencyKey: 'wp19-decided-view-r',
      reason: 'رد',
    });
    expect(rejection.request.state).toBe('REJECTED');
  });

  it('rejects through the Web with a reason of 300 emoji (Codex review of #83, round 8)', async () => {
    const filed = await file((await activeService('emoji-reason')).id);
    const reason = '😀'.repeat(300); // 300 code points, 600 UTF-16 units
    const { controller, request } = await asWebOwner();
    const decided = await controller.reject(request, filed.request.id, {
      idempotencyKey: 'wp19-emoji-reject',
      reason,
    });
    expect(decided.request.state).toBe('REJECTED');
    expect(decided.request.rejectionReason).toBe(reason);
    await expect(
      controller.reject(request, filed.request.id, {
        idempotencyKey: 'wp19-emoji-reject-long',
        reason: '😀'.repeat(501),
      }),
    ).rejects.toThrow();
  });

  it('holds a Web decision to its idempotency key (Codex review of #83, round 4)', async () => {
    const first = await file((await activeService('web-key-a')).id);
    const second = await file((await activeService('web-key-b')).id);
    const third = await file((await activeService('web-key-c')).id);
    const fourth = await file((await activeService('web-key-d')).id);
    const { controller, request } = await asWebOwner();
    const approval = { idempotencyKey: 'wp19-web-approve', amountMinor: '1000', confirm: true };
    expect((await controller.approve(request, first.request.id, approval)).request.state).toBe(
      'EXECUTING',
    );
    // A retry of the same command is answered with the request it decided.
    const retried = await controller.approve(request, first.request.id, approval);
    expect(retried.request.id).toBe(first.request.id);
    // The same key for another request, or another amount, is refused and decides nothing.
    expect(await refused(controller.approve(request, second.request.id, approval))).toBe(
      PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
    );
    expect(
      await refused(
        controller.approve(request, first.request.id, { ...approval, amountMinor: '2000' }),
      ),
    ).toBe(PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH);
    expect((await requestRow(second.request.id))?.request.state).toBe('OPEN');

    const rejection = { idempotencyKey: 'wp19-web-reject', reason: 'رد با کلید' };
    expect((await controller.reject(request, third.request.id, rejection)).request.state).toBe(
      'REJECTED',
    );
    expect(await refused(controller.reject(request, fourth.request.id, rejection))).toBe(
      PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
    );
    expect((await requestRow(fourth.request.id))?.request.state).toBe('OPEN');
  });

  it('answers a redelivered amount with the same confirmation (Codex review of #83, round 4)', async () => {
    const service = await activeService('amount-redelivered');
    const filed = await file(service.id);
    await ctx.container.serviceRefundDecisions.openApprove(tenantA, owner, {
      botInstanceId: BOT_A,
      requestId: filed.request.id,
    });
    const typed = { idempotencyKey: 'wp19-amount-redelivered', botInstanceId: BOT_A, text: '1500' };
    const first = await ctx.container.serviceRefundDecisions.submitText(tenantA, owner, typed);
    if (first.outcome !== 'AMOUNT_ENTERED') throw new Error(first.outcome);
    // The first reply was lost; Telegram delivers the same message again.
    const again = await ctx.container.serviceRefundDecisions.submitText(tenantA, owner, typed);
    if (again.outcome !== 'AMOUNT_ENTERED') throw new Error(again.outcome);
    expect(again.capture.id).toBe(first.capture.id);
    expect(again.amount).toEqual(first.amount);
    // A NEW message with the same figure is an ordinary one: no prompt is waiting.
    const another = await ctx.container.serviceRefundDecisions.submitText(tenantA, owner, {
      ...typed,
      idempotencyKey: 'wp19-amount-another',
    });
    expect(another.outcome).toBe('NO_CAPTURE');
    // Once the prompt is decided, the redelivery restates nothing — and is answered as
    // decided rather than offered to any other prompt (Codex review of #83, round 5).
    await ctx.container.serviceRefundDecisions.confirmApprove(tenantA, owner, {
      captureId: first.capture.id,
    });
    expect(
      (await ctx.container.serviceRefundDecisions.submitText(tenantA, owner, typed)).outcome,
    ).toBe('CLOSED');
  });

  it('keeps the amount prompt open when reading its request fails for a reason nobody classified (Codex review of #83, round 4)', async () => {
    const service = await activeService('amount-read-fails');
    const filed = await file(service.id);
    await ctx.container.serviceRefundDecisions.openApprove(tenantA, owner, {
      botInstanceId: BOT_A,
      requestId: filed.request.id,
    });
    const requests = (
      ctx.container.serviceRefundDecisions as unknown as {
        deps: { requests: { reviewForDecision: (...args: unknown[]) => Promise<unknown> } };
      }
    ).deps.requests;
    const original = requests.reviewForDecision;
    requests.reviewForDecision = async () => {
      throw new Error('connection lost');
    };
    try {
      await expect(
        ctx.container.serviceRefundDecisions.submitText(tenantA, owner, {
          idempotencyKey: 'wp19-amount-read-fails-1',
          botInstanceId: BOT_A,
          text: '1000',
        }),
      ).rejects.toThrow('connection lost');
    } finally {
      requests.reviewForDecision = original;
    }
    // The prompt is still the administrator's; the next message is read as its amount.
    const retried = await ctx.container.serviceRefundDecisions.submitText(tenantA, owner, {
      idempotencyKey: 'wp19-amount-read-fails-2',
      botInstanceId: BOT_A,
      text: '1000',
    });
    expect(retried.outcome).toBe('AMOUNT_ENTERED');
  });

  it('answers a redelivered message from its own prompt, never from a newer one (Codex review of #83, round 5)', async () => {
    const first = await file((await activeService('replay-own-a')).id);
    const second = await file((await activeService('replay-own-b')).id);
    const third = await file((await activeService('replay-own-c')).id);
    const decisions = ctx.container.serviceRefundDecisions;
    // An amount typed for the first request's approval, its prompt then cancelled.
    const approve = await decisions.openApprove(tenantA, owner, {
      botInstanceId: BOT_A,
      requestId: first.request.id,
    });
    if (approve.outcome !== 'OPENED') throw new Error(approve.outcome);
    const amount = { idempotencyKey: 'wp19-replay-amount', botInstanceId: BOT_A, text: '1000' };
    expect((await decisions.submitText(tenantA, owner, amount)).outcome).toBe('AMOUNT_ENTERED');
    await decisions.cancel(tenantA, owner, { captureId: approve.capture.id });
    // A rejection of the second request, decided on its reason.
    await decisions.openReject(tenantA, owner, {
      botInstanceId: BOT_A,
      requestId: second.request.id,
    });
    const reason = {
      idempotencyKey: 'wp19-replay-reason',
      botInstanceId: BOT_A,
      text: 'دلیل رد دوم',
    };
    expect((await decisions.submitText(tenantA, owner, reason)).outcome).toBe('REJECTED');
    // A rejection prompt for the third request is open when both messages arrive again.
    await decisions.openReject(tenantA, owner, {
      botInstanceId: BOT_A,
      requestId: third.request.id,
    });
    expect((await decisions.submitText(tenantA, owner, amount)).outcome).toBe('CLOSED');
    expect((await decisions.submitText(tenantA, owner, reason)).outcome).toBe('CLOSED');
    expect((await requestRow(third.request.id))?.request.state).toBe('OPEN');
    expect((await requestRow(first.request.id))?.request.state).toBe('OPEN');
  });

  it('reads only a message sent after the tap that opened the prompt (Codex review of #83, round 5)', async () => {
    const filed = await file((await activeService('replay-older')).id);
    await handle(tapUpdate(`qb:${filed.request.id}`, ADMIN_TG));
    const tappedAt = updateSeq;
    // A message typed BEFORE that tap — for another prompt, delivered again — is not a reason.
    const older = textUpdate('برای درخواست دیگری نوشته شده بود', ADMIN_TG);
    const stale = {
      ...older,
      update: { ...older.update, update_id: tappedAt - 1 },
    };
    await handle(stale);
    expect((await requestRow(filed.request.id))?.request.state).toBe('OPEN');
    // The next message the administrator types is.
    await handle(textUpdate('دلیل واقعی رد', ADMIN_TG));
    const decided = await requestRow(filed.request.id);
    expect(decided?.request.state).toBe('REJECTED');
    expect(decided?.request.rejectionReason).toBe('دلیل واقعی رد');
  });

  it('retires a confirmation whose approval was refused for good (Codex review of #83)', async () => {
    const service = await activeService('retire-confirmed');
    const filed = await file(service.id);
    await ctx.container.serviceRefundDecisions.openApprove(tenantA, owner, {
      botInstanceId: BOT_A,
      requestId: filed.request.id,
    });
    const entered = await ctx.container.serviceRefundDecisions.submitText(tenantA, owner, {
      idempotencyKey: 'wp19-text-7',
      botInstanceId: BOT_A,
      text: '1000',
    });
    if (entered.outcome !== 'AMOUNT_ENTERED') throw new Error(entered.outcome);
    // Between the amount and the confirmation, the service stops being deletable.
    await ctx.container.database.db.execute(
      sql`UPDATE services SET state = 'TERMINATED', terminated_at = now()
           WHERE id = ${service.id}` as never,
    );
    const refusedOnce = await ctx.container.serviceRefundDecisions.confirmApprove(tenantA, owner, {
      captureId: entered.capture.id,
    });
    expect(refusedOnce.outcome).toBe('NOT_EXECUTABLE');
    // It recovers. The administrator was told the approval failed; the same old button must
    // not now carry it out.
    await ctx.container.database.db.execute(
      sql`UPDATE services SET state = 'ACTIVE', terminated_at = NULL WHERE id = ${service.id}` as never,
    );
    const tappedAgain = await ctx.container.serviceRefundDecisions.confirmApprove(tenantA, owner, {
      captureId: entered.capture.id,
    });
    expect(tappedAgain.outcome).not.toBe('EXECUTING');
    const row = await requestRow(filed.request.id);
    expect(row?.request.state).toBe('OPEN');
    expect(await terminateOf(service.id)).toHaveLength(0);
  });

  it('keeps the reason prompt when its rejection fails for a reason nobody classified (Codex review of #83)', async () => {
    const service = await activeService('reject-transient');
    const filed = await file(service.id);
    await ctx.container.serviceRefundDecisions.openReject(tenantA, owner, {
      botInstanceId: BOT_A,
      requestId: filed.request.id,
    });
    await ctx.container.database.db.execute(
      sql`CREATE OR REPLACE FUNCTION wp19_transient() RETURNS trigger AS $$
          BEGIN
            IF NEW.state = 'REJECTED' THEN RAISE EXCEPTION 'a transient failure'; END IF;
            RETURN NEW;
          END $$ LANGUAGE plpgsql` as never,
    );
    await ctx.container.database.db.execute(
      sql`CREATE TRIGGER wp19_transient BEFORE UPDATE ON service_refund_requests
          FOR EACH ROW EXECUTE FUNCTION wp19_transient()` as never,
    );
    try {
      await expect(
        ctx.container.serviceRefundDecisions.submitText(tenantA, owner, {
          idempotencyKey: 'wp19-text-8',
          botInstanceId: BOT_A,
          text: 'رد به دلیل تکرار',
        }),
      ).rejects.toThrow();
    } finally {
      await ctx.container.database.db.execute(
        sql`DROP TRIGGER wp19_transient ON service_refund_requests` as never,
      );
      await ctx.container.database.db.execute(sql`DROP FUNCTION wp19_transient()` as never);
    }
    // The prompt is still there, and the same reason sent again finishes the rejection.
    const retried = await ctx.container.serviceRefundDecisions.submitText(tenantA, owner, {
      idempotencyKey: 'wp19-text-9',
      botInstanceId: BOT_A,
      text: 'رد به دلیل تکرار',
    });
    expect(retried.outcome).toBe('REJECTED');
    expect((await requestRow(filed.request.id))?.request.state).toBe('REJECTED');
  });

  it('files nothing for a service that ends while the filing waits for it (Codex review of #83)', async () => {
    const service = await activeService('file-race');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const holder = ctx.container.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM services WHERE id = ${service.id} FOR UPDATE`);
      await tx.execute(
        sql`UPDATE services SET state = 'TERMINATED', terminated_at = now()
             WHERE id = ${service.id}`,
      );
      locked();
      await gate;
    });
    await holding;
    const filing = refused(file(service.id));
    const deadline = Date.now() + 5_000;
    for (;;) {
      const waiting = await countRows(
        sql`SELECT count(*)::int AS n FROM pg_locks
             WHERE NOT granted AND locktype IN ('tuple', 'transactionid')`,
      );
      if (waiting >= 1) break;
      if (Date.now() > deadline) throw new Error('the filing never waited on the service');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await holder;
    expect(await filing).toBe(COMMERCE_ERROR_CODES.SERVICE_REFUND_NOT_ELIGIBLE);
    expect(
      await countRows(
        sql`SELECT count(*)::int AS n FROM service_refund_requests WHERE service_id = ${service.id}`,
      ),
    ).toBe(0);
  });

  it('answers a redelivered filing with its request even after that request was decided (Codex review of #83)', async () => {
    const service = await activeService('file-replay');
    const first = await file(service.id, 'دیگر نیازی ندارم', 'wp19-file-replay');
    expect(first.outcome).toBe('FILED');
    await ctx.container.serviceRefundRequests.reject(tenantA, owner, {
      requestId: first.request.id,
      reason: 'رد',
    });
    // Telegram redelivers the update that carried the reason.
    const replayed = await file(service.id, 'دیگر نیازی ندارم', 'wp19-file-replay');
    expect(replayed.request.id).toBe(first.request.id);
    expect(
      await countRows(
        sql`SELECT count(*)::int AS n FROM service_refund_requests WHERE service_id = ${service.id}`,
      ),
    ).toBe(1);
    // A new update is a new filing.
    const again = await file(service.id, 'دوباره درخواست دارم', 'wp19-file-new');
    expect(again.request.id).not.toBe(first.request.id);
  });

  it('never tells a redelivered reason "registered" once its request has moved on (Codex review of #83, round 6)', async () => {
    const service = await activeService('tg-file-replay');
    await handle(tapUpdate(`fa:${service.id}`));
    await handle(tapUpdate(`fb:${service.id}`));
    const reason = textUpdate('دیگر به این سرویس نیازی ندارم');
    expect((await handle(reason)).replyKey).toBe('bot.service.refund_request_registered');
    const filed = (
      await ctx.container.serviceRefundRequests.list(tenantA, owner, { limit: 10 })
    )[0];
    if (filed === undefined) throw new Error('nothing filed');

    // Approved and still deleting: pending, as far as the customer has been told.
    await ctx.container.serviceRefundRequests.approve(tenantA, owner, {
      requestId: filed.request.id,
      amountMinor: 100_000n,
    });
    expect((await handle(reason)).replyKey).toBe('bot.service.refund_request_pending');

    // Completed: the service is gone and the customer was told through the lane.
    await ctx.container.provisionerLoop.tick();
    expect((await requestRow(filed.request.id))?.request.state).toBe('COMPLETED');
    const replayed = await handle(reason);
    expect(replayed.replyKey).not.toBe('bot.service.refund_request_registered');
    expect(replayed.replyKey).toBe('bot.service.not_found');
    expect(await notices('SERVICE_REFUND_REQUEST_REGISTERED'), 'no registration queued').toBe(0);
  });

  it('shows a rejected request’s redelivered reason the service as it stands (Codex review of #83, round 6)', async () => {
    const service = await activeService('tg-file-replay-rejected');
    await handle(tapUpdate(`fa:${service.id}`));
    await handle(tapUpdate(`fb:${service.id}`));
    const reason = textUpdate('دیگر به این سرویس نیازی ندارم');
    await handle(reason);
    const filed = (
      await ctx.container.serviceRefundRequests.list(tenantA, owner, { limit: 10 })
    )[0];
    if (filed === undefined) throw new Error('nothing filed');
    await ctx.container.serviceRefundRequests.reject(tenantA, owner, {
      requestId: filed.request.id,
      reason: 'رد',
    });
    expect((await handle(reason)).replyKey).toBe('bot.service.card');
  });

  it('rejects from Telegram with the typed reason', async () => {
    const service = await activeService('tg-reject');
    const filed = await file(service.id);
    expect((await handle(tapUpdate(`qb:${filed.request.id}`, ADMIN_TG))).replyKey).toBe(
      'bot.admin.refund_request_reject_prompt',
    );
    expect((await handle(textUpdate('خرید تخفیف‌دار بود', ADMIN_TG))).replyKey).toBe(
      'bot.admin.refund_request_rejected',
    );
    const row = await requestRow(filed.request.id);
    expect(row?.request.state).toBe('REJECTED');
    expect(row?.request.rejectionReason).toBe('خرید تخفیف‌دار بود');
  });

  it('answers stale and forged decision taps without deciding anything', async () => {
    const service = await activeService('tg-stale');
    const filed = await file(service.id);
    const unknown = ctx.container.ids.uuid();
    expect((await handle(tapUpdate(`qa:${unknown}`, ADMIN_TG))).replyKey).toBe(
      'bot.admin.refund_request_closed',
    );
    expect((await handle(tapUpdate(`qc:${unknown}`, ADMIN_TG))).replyKey).toBe(
      'bot.admin.refund_request_closed',
    );
    // A customer who forges the administrator's callback is not an administrator.
    const forged = await handle(tapUpdate(`qa:${filed.request.id}`));
    expect(forged.replyKey).not.toBe('bot.admin.refund_request_amount_prompt');
    // A decided request answers its old card with "already decided".
    await ctx.container.serviceRefundRequests.reject(tenantA, owner, {
      requestId: filed.request.id,
      reason: 'رد',
    });
    expect((await handle(tapUpdate(`qa:${filed.request.id}`, ADMIN_TG))).replyKey).toBe(
      'bot.admin.refund_request_closed',
    );
    expect((await requestRow(filed.request.id))?.request.state).toBe('REJECTED');
  });

  it('sends each reviewer only the card buttons their permissions open (Codex review of #83, round 10)', async () => {
    const service = await activeService('card-buttons');
    await deciderOnly(DECIDER_TG);
    const filed = await file(service.id);
    await ctx.container.relay.processBatch();
    sent = [];
    await ctx.container.receiptReviewPushLoop.tick();
    const callbacksTo = (chat: string): string[] => {
      const card = sent.find(
        (one) => one.url.includes('/sendMessage') && String(one.body['chat_id']) === chat,
      );
      const markup = card?.body['reply_markup'] as
        { inline_keyboard: { callback_data?: string }[][] } | undefined;
      return (markup?.inline_keyboard ?? []).flat().map((button) => button.callback_data ?? '');
    };
    const decider = callbacksTo(DECIDER_TG);
    expect(decider, 'the decision-only reviewer is sent the two decisions').toEqual([
      `qa:${filed.request.id}`,
      `qb:${filed.request.id}`,
    ]);
    const ownerCard = callbacksTo(ADMIN_TG);
    expect(ownerCard, 'an owner is sent all four').toHaveLength(4);
    expect(ownerCard).toContain(`I:${service.id}`);
  });

  it('enqueues one review card per administrator who may decide, and keeps the request if none is sent', async () => {
    const service = await activeService('cards');
    await createAdmin(ctx.container, tenantA, {
      username: 'finance-tg',
      roleKeys: ['finance'],
      telegramUserId: '940940',
    });
    const filed = await file(service.id);
    await ctx.container.relay.processBatch();
    const pushes = (await ctx.container.database.db.execute(
      sql`SELECT admin_id FROM service_refund_request_pushes WHERE request_id = ${filed.request.id}` as never,
    )) as unknown as { rows: { admin_id: string }[] };
    expect(
      pushes.rows.map((row) => row.admin_id),
      'only the one holding both keys',
    ).toEqual([ownerId]);
    expect((await requestRow(filed.request.id))?.request.state).toBe('OPEN');
  });
});
