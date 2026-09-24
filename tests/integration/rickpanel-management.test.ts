import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type OrderId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleOperationRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-operation.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import type { ServiceRecord } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  validatePanelConnection,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * RickPanel service management through the APPLICATION layer — plan §6.1.
 *
 * The adapter's unit tests prove each request it sends; `rickpanel-new-service` and
 * `rickpanel-rotate-link` prove the create and the rotation end to end. This proves the
 * rest of what an operator or a customer can do to a RickPanel-backed service, through
 * the shipped container — the real commercial-action service, the real settlement, the
 * real provisioner, the real `RickpanelAdapter` over the real `SafeHttpClient` — against
 * `tests/support/fake-rickpanel.ts`, and checks four things of every one:
 *
 *   - Nexa and the panel AGREE afterwards, read from the panel's own record;
 *   - money moves exactly once, and only for what was bought;
 *   - a replay after a lost answer converges rather than applying twice;
 *   - the panel's operability is decided again before anything is sent to it.
 *
 * What these cannot prove is that the real panel behaves like the fake.
 * `tests/acceptance/real-panel-rickpanel.test.ts` is that, and it has not been run.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

/** One Telegram request the stand-in will hold until released, and how to answer it. */
interface Hold {
  readonly status: number;
  readonly body: unknown;
  arrived: () => void;
  release: Promise<void>;
}

describe('RickPanel service management through the application layer', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[];
  let hold: Hold | null;
  let panel: FakeRickpanel;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let operations: DrizzleOperationRepository;
  let panelId: string;
  let customerId: UserId;
  let owner: ActorContext;

  beforeAll(async () => {
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        sent.push({
          url: request.url ?? '',
          body: raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>),
        });
        const held = hold;
        hold = null;
        if (held === null) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, result: { message_id: 7 } }));
          return;
        }
        held.arrived();
        void held.release.then(() => {
          response.writeHead(held.status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(held.body));
        });
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
    telegram.closeAllConnections();
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
    hold = null;

    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-mgmt', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Rick',
      providerType: 'rickpanel',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: {},
      idempotencyKey: 'panel-mgmt-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);

    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-mgmt',
      telegramUserId: '940940',
      from: { id: 940940, first_name: 'سارا' },
      botInstanceId: BOT_A,
    });
    customerId = resolved.customer.id;
  });

  async function paidOrder(key: string): Promise<OrderId> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ریک',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(key), {
      idempotencyKey: `${key}-draft`,
      customerId,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId,
      orderId: draft.id,
    });
    await ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), customerId, {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id,
    });
    return confirmed.id;
  }

  /** A service that is ACTIVE and whose first link has been delivered. */
  async function deliveredService(key: string): Promise<ServiceRecord> {
    const orderId = await paidOrder(key);
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, orderId);
    if (service === null || service.state !== 'ACTIVE') throw new Error('not provisioned');
    expect(service.deliveryState).toBe('DELIVERED');
    return service;
  }

  const reload = async (id: string): Promise<ServiceRecord> => {
    const found = await services.findById(tenantA, id as never);
    if (found === null) throw new Error('service vanished');
    return found;
  };

  /** A purchasable package of one kind. */
  async function offeredAddon(
    kind: 'ADD_TRAFFIC' | 'ADD_TIME',
    amount: { trafficBytes?: bigint; durationDays?: number },
    key: string,
  ): Promise<string> {
    const created = await ctx.container.serviceAddons.create(tenantA, owner, {
      idempotencyKey: `${key}-addon`,
      draft: {
        kind,
        title: kind === 'ADD_TRAFFIC' ? 'بسته ۱۰ گیگ' : 'بسته ۱۵ روز',
        sortOrder: 10,
        specification: {
          kind,
          trafficBytes: amount.trafficBytes ?? null,
          durationDays: amount.durationDays ?? null,
        },
        price: money(50_000n, 'IRT'),
      },
    });
    await ctx.container.serviceAddons.activate(tenantA, owner, {
      idempotencyKey: `${key}-addon-on`,
      addonId: created.id,
    });
    return created.id;
  }

  /** Quote, confirm, pay from the wallet — the three taps a customer makes. */
  async function buy(
    serviceId: string,
    kind: 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME',
    addonId: string | null,
    key: string,
  ): Promise<OrderId> {
    const { order } = await ctx.container.commercialActions.draft(
      tenantA,
      systemActor(key),
      customerId,
      {
        serviceId,
        kind,
        ...(addonId === null ? {} : { addonId }),
        idempotencyKey: `act-${key}-quote`,
      },
    );
    await ctx.container.commercialActions.confirm(tenantA, systemActor(key), customerId, {
      orderId: order.id,
      idempotencyKey: `act-${key}-confirm`,
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), customerId, {
      idempotencyKey: `act-${key}-pay`,
      orderId: order.id,
    });
    return order.id;
  }

  const operationOf = async (serviceId: string, type: string) =>
    (await operations.listForService(tenantA, serviceId, 50)).find(
      (operation) => operation.type === type,
    );

  const ledger = async () =>
    (
      (await ctx.container.database.db.execute(
        sql`SELECT direction, reason, amount::text AS amount FROM wallet_entries
             WHERE customer_id = ${customerId} ORDER BY created_at, id` as never,
      )) as unknown as { rows: { direction: string; reason: string; amount: string }[] }
    ).rows;
  const debits = async () =>
    (await ledger()).filter((one) => one.direction === 'DEBIT' && one.reason === 'PURCHASE');
  const refunds = async () => (await ledger()).filter((one) => one.reason === 'REFUND');

  const makeDue = () =>
    ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET next_attempt_at = now() - interval '1 hour'
           WHERE state = 'PLANNED'`,
    );

  /** What the panel holds for this service, from its own record. */
  const onPanel = (service: ServiceRecord) => panel.users.get(service.providerUsername ?? '');

  /** Nexa and the panel hold the same expiry and the same data limit. */
  function expectAgreement(service: ServiceRecord): void {
    const held = onPanel(service);
    expect(held, 'the panel holds no account for this service').toBeDefined();
    expect(held?.dataLimit, 'data limit: panel vs Nexa').toBe(
      Number(service.trafficLimitBytes ?? 0n),
    );
    expect(held?.expire, 'expiry: panel vs Nexa').toBe(
      service.expiresAt === null ? 0 : Math.floor(service.expiresAt.getTime() / 1000),
    );
  }

  it('renews: charged once, applied once, and Nexa and the panel agree', async () => {
    const service = await deliveredService('renew');
    const token = onPanel(service)?.subToken;
    await ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: 'renew-fund',
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });

    await buy(service.id, 'RENEW', null, 'renew');
    const puts = panel.putCalls();
    await ctx.container.provisionerLoop.tick();

    expect((await operationOf(service.id, 'RENEW'))?.state).toBe('SUCCEEDED');
    const after = await reload(service.id);
    /*
     * EXACTLY what was bought — the plan's 30 days onto the current expiry and its
     * 50 GiB onto the current allowance — not merely "later" and "agreeing". A target
     * computed wrongly would be written to both stores alike, and agreement alone would
     * pass it. Codex on PR #63.
     */
    expect(after.expiresAt?.getTime()).toBe((service.expiresAt?.getTime() ?? 0) + 30 * 86_400_000);
    expect(after.trafficLimitBytes).toBe(service.trafficLimitBytes + 53_687_091_200n);
    expectAgreement(after);
    expect(panel.putCalls() - puts, 'one write to the panel').toBe(1);
    // A renewal is an allowance: the status and the subscription are the panel's own.
    expect(onPanel(after)?.status).toBe('active');
    expect(onPanel(after)?.subToken).toBe(token);
    expect(after.subscriptionUrl).toBe(service.subscriptionUrl);

    expect(
      (await debits()).map((one) => one.amount),
      'the purchase and the renewal, once each, at the plan price',
    ).toEqual(['250000', '250000']);
    expect(await refunds()).toHaveLength(0);

    // A later sweep writes nothing more.
    await makeDue();
    await ctx.container.provisionerLoop.tick();
    expect(panel.putCalls() - puts).toBe(1);
  });

  it('adds traffic without touching the expiry, and adds time without touching the traffic', async () => {
    const service = await deliveredService('addons');
    await ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: 'addons-fund',
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    const traffic = await offeredAddon('ADD_TRAFFIC', { trafficBytes: 10_737_418_240n }, 'tr');
    const time = await offeredAddon('ADD_TIME', { durationDays: 15 }, 'tm');

    await buy(service.id, 'ADD_TRAFFIC', traffic, 'add-traffic');
    await ctx.container.provisionerLoop.tick();
    expect((await operationOf(service.id, 'ADD_TRAFFIC'))?.state).toBe('SUCCEEDED');
    const afterTraffic = await reload(service.id);
    expect(afterTraffic.trafficLimitBytes).toBe(
      (service.trafficLimitBytes ?? 0n) + 10_737_418_240n,
    );
    expect(afterTraffic.expiresAt?.getTime()).toBe(service.expiresAt?.getTime());
    expectAgreement(afterTraffic);

    await buy(service.id, 'ADD_TIME', time, 'add-time');
    await ctx.container.provisionerLoop.tick();
    expect((await operationOf(service.id, 'ADD_TIME'))?.state).toBe('SUCCEEDED');
    const afterTime = await reload(service.id);
    expect(afterTime.expiresAt?.getTime()).toBe(
      (afterTraffic.expiresAt?.getTime() ?? 0) + 15 * 86_400_000,
    );
    expect(afterTime.trafficLimitBytes).toBe(afterTraffic.trafficLimitBytes);
    expectAgreement(afterTime);

    // Each package at ITS price, not the plan's: cardinality alone would pass a
    // settlement that charged an add-on at the wrong amount. Codex on PR #63.
    expect(
      (await debits()).map((one) => one.amount),
      'the purchase and the two packages, once each',
    ).toEqual(['250000', '50000', '50000']);
    expect(await refunds()).toHaveLength(0);
  });

  it('converges when a renewal was applied and its answer lost: the replay sets, it does not add', async () => {
    /*
     * The case `IDEMPOTENT_MUTATIONS` exists for. The panel applied the PUT and the
     * answer was a 500, so the operation is retried — with the SAME absolute target,
     * stored when the order settled. A second increment would give the customer twice
     * what they bought; the target makes the replay a no-op on the panel's record.
     */
    const service = await deliveredService('renew-lost');
    await ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: 'renew-lost-fund',
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await buy(service.id, 'RENEW', null, 'renew-lost');
    const target = (await operationOf(service.id, 'RENEW'))?.target;
    panel.lostPutAnswers = 1;

    await ctx.container.provisioner.runOnce(tenantA);
    const retried = await operationOf(service.id, 'RENEW');
    expect(retried?.state, 'a lost answer on an idempotent write is retried').toBe('PLANNED');
    expect(retried?.failureKind).toBe('PROVIDER_ERROR');

    await makeDue();
    await ctx.container.provisionerLoop.tick();
    expect((await operationOf(service.id, 'RENEW'))?.state).toBe('SUCCEEDED');
    const after = await reload(service.id);
    expect(after.expiresAt?.getTime()).toBe(target?.expiresAt?.getTime());
    expect(after.trafficLimitBytes).toBe(target?.trafficLimitBytes);
    expectAgreement(after);
    expect(panel.putCalls()).toBe(2);
    expect(await debits()).toHaveLength(2);
    expect(await refunds()).toHaveLength(0);
  });

  it('suspends, resumes and terminates, and the panel agrees at every step', async () => {
    const service = await deliveredService('lifecycle');

    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'SUSPEND', {
      idempotencyKey: 'lc-suspend',
    });
    await ctx.container.provisionerLoop.tick();
    expect((await reload(service.id)).state).toBe('SUSPENDED');
    expect(onPanel(service)?.status).toBe('disabled');
    expectAgreement(await reload(service.id));

    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'RESUME', {
      idempotencyKey: 'lc-resume',
    });
    await ctx.container.provisionerLoop.tick();
    expect((await reload(service.id)).state).toBe('ACTIVE');
    expect(onPanel(service)?.status).toBe('active');
    expectAgreement(await reload(service.id));

    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'TERMINATE', {
      idempotencyKey: 'lc-terminate',
    });
    await ctx.container.provisionerLoop.tick();
    expect((await reload(service.id)).state).toBe('TERMINATED');
    expect(onPanel(service), 'the panel still holds a terminated account').toBeUndefined();

    // None of the three moved money: the service was bought once.
    expect(await debits()).toHaveLength(1);
    expect(await refunds()).toHaveLength(0);
  });

  it('decides the panel again before writing: a renewal on a panel disabled since it was paid sends nothing and is refunded once', async () => {
    const service = await deliveredService('renew-disabled');
    await ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: 'renew-disabled-fund',
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await buy(service.id, 'RENEW', null, 'renew-disabled');
    await ctx.container.panels.setStatus(tenantA, owner, panelId, {
      status: 'DISABLED',
      idempotencyKey: 'renew-disabled-panel-off',
    });
    const puts = panel.putCalls();
    const requests = panel.requests.length;

    await ctx.container.provisionerLoop.tick();

    expect(panel.putCalls(), 'a disabled panel was written to').toBe(puts);
    // Not even a login: operability is decided before ANYTHING is sent, so a
    // regression that authenticated first and checked afterwards fails here. Codex on
    // PR #63.
    expect(panel.requests.length, 'a disabled panel was contacted').toBe(requests);
    const after = await reload(service.id);
    expect(after.expiresAt?.getTime()).toBe(service.expiresAt?.getTime());
    expect(after.trafficLimitBytes).toBe(service.trafficLimitBytes);
    const renewal = await operationOf(service.id, 'RENEW');
    // The provisioner decided the panel again and refused: the order could not be
    // delivered, so it was refunded — the exact amount, once, in the same transaction.
    expect(renewal?.state).toBe('FAILED');
    expect(renewal?.failureMessage).toBe('PANEL_DISABLED');
    const charged = await debits();
    expect(charged).toHaveLength(2);
    const given = await refunds();
    expect(given, 'the undeliverable renewal is refunded once').toHaveLength(1);
    expect(given[0]?.direction).toBe('CREDIT');
    expect(given[0]?.amount, 'refunded exactly what the renewal cost').toBe(charged[1]?.amount);

    // A later sweep neither writes to the panel nor refunds again.
    await makeDue();
    await ctx.container.provisionerLoop.tick();
    expect(panel.putCalls()).toBe(puts);
    expect(await refunds()).toHaveLength(1);
  });
});
