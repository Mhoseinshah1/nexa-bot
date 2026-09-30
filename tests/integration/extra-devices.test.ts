import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  EMPTY_PRODUCT_DISPLAY,
  MAX_MONEY_AMOUNT_MINOR,
  money,
  providerDescriptor,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type OrderId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type ProviderCapability,
  type ProviderDeviceLimitOutcome,
  type ProviderUserRef,
  type UserId,
} from '@nexa/contracts';
import {
  encodeDeviceQuantity,
  encodeIdPair,
} from '../../apps/api/src/surfaces/telegram/bot-runtime';
import { MarzbanAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/marzban.adapter';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { DrizzleOperationRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-operation.repository';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  validatePanelConnection,
  type TestContext,
} from './harness';

/**
 * Extra users / devices (WP-A5), end to end: a real PostgreSQL, the real bot runtime, the
 * real commercial, payment, settlement, provisioner, refund and notification lanes.
 *
 * ## What is real and what is not
 *
 * No provider in this release declares `DEVICE_LIMIT_ADJUSTMENT`: Marzban v0.8.4 and
 * RickPanel's contract have no such field, and 3X-UI is frozen by the owner. So the first
 * block runs against the SHIPPED descriptors and proves the customer is offered nothing
 * and a crafted callback buys nothing.
 *
 * Everything after it needs a panel that CAN raise a limit, and none exists — so for the
 * duration of that block the Marzban descriptor is given the capability and the Marzban
 * adapter the two methods, backed by `devicePanel` below, an in-memory panel whose answer
 * each case scripts. That is a fake of the PROVIDER, not of Nexa: every row, lock,
 * transition, refund and notification the cases assert is produced by production code.
 * What it cannot prove — that some real panel assigns a limit absolutely and answers a
 * replay with no change — is the acceptance a declaring adapter must bring with it
 * (`IDEMPOTENT_MUTATIONS`' docblock), and is claimed nowhere here.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

/** What the scripted panel does with the NEXT write. */
type WriteMode = 'APPLY' | 'LOST_AFTER_APPLY' | 'LOST_BEFORE_APPLY' | 'REFUSED' | 'ABSENT';

const devicePanel = {
  limits: new Map<string, number>(),
  mode: 'APPLY' as WriteMode,
  writes: [] as { username: string; limit: number }[],
  reads: 0,
};

const originalCapabilities: ProviderCapability[] = [];

/** Gives the Marzban descriptor and adapter the capability, for one block only. */
function installDevicePanel(): void {
  const descriptor = providerDescriptor('marzban');
  if (descriptor === null) throw new Error('no marzban descriptor');
  const capabilities = descriptor.capabilities as ProviderCapability[];
  originalCapabilities.splice(0, originalCapabilities.length, ...capabilities);
  capabilities.push('DEVICE_LIMIT_ADJUSTMENT');
  const proto = MarzbanAdapter.prototype as unknown as Record<string, unknown>;
  proto['readDeviceLimit'] = async (
    _target: unknown,
    _http: unknown,
    ref: ProviderUserRef,
  ): Promise<ProviderDeviceLimitOutcome> => {
    devicePanel.reads += 1;
    const held = devicePanel.limits.get(ref.username);
    return held === undefined
      ? { ok: true, found: false }
      : { ok: true, found: true, deviceLimit: held, maxDeviceLimit: null };
  };
  proto['applyDeviceLimit'] = async (
    _target: unknown,
    _http: unknown,
    ref: ProviderUserRef,
    limit: number,
  ): Promise<ProviderDeviceLimitOutcome> => {
    devicePanel.writes.push({ username: ref.username, limit });
    const held = devicePanel.limits.get(ref.username);
    switch (devicePanel.mode) {
      case 'ABSENT':
        return { ok: true, found: false };
      case 'REFUSED':
        return { ok: false, failure: 'PROVIDER_REFUSED', status: 400 };
      case 'LOST_BEFORE_APPLY':
        return { ok: false, failure: 'TIMEOUT', status: null };
      case 'LOST_AFTER_APPLY':
        devicePanel.limits.set(ref.username, Math.max(held ?? 0, limit));
        return { ok: false, failure: 'TIMEOUT', status: null };
      case 'APPLY': {
        // Never lowers: the contract `applyDeviceLimit` states.
        const next = Math.max(held ?? 0, limit);
        devicePanel.limits.set(ref.username, next);
        return { ok: true, found: true, deviceLimit: next, maxDeviceLimit: null };
      }
    }
  };
}

function uninstallDevicePanel(): void {
  const descriptor = providerDescriptor('marzban');
  if (descriptor === null) return;
  const capabilities = descriptor.capabilities as ProviderCapability[];
  capabilities.splice(0, capabilities.length, ...originalCapabilities);
  const proto = MarzbanAdapter.prototype as unknown as Record<string, unknown>;
  delete proto['readDeviceLimit'];
  delete proto['applyDeviceLimit'];
}

describe('extra users / devices on an existing service (WP-A5)', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[];
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let operations: DrizzleOperationRepository;
  let panelId: string;
  let customerA: UserId;
  let owner: ActorContext;
  let updateSeq = 0;

  beforeAll(async () => {
    sent = [];
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
    uninstallDevicePanel();
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
    devicePanel.limits.clear();
    devicePanel.mode = 'APPLY';
    devicePanel.writes = [];
    devicePanel.reads = 0;

    panel = await startFakeMarzban({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-devices', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-devices-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);

    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-devices',
      telegramUserId: '920920',
      from: { id: 920920, first_name: 'سارا' },
      botInstanceId: BOT_A,
    });
    customerA = resolved.customer.id;
  });

  /**
   * An ACTIVE service entitled to two devices.
   *
   * The plan carries no device limit — Marzban declares no `LIMIT_DEVICES`, so the
   * provisioner would refuse one — and the entitlement is then recorded directly, which
   * is the state a plan WITH a limit leaves on a panel that honours it.
   */
  async function activeService(key: string): Promise<{ id: string; username: string }> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن دو کاربره',
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
      customerId: customerA,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId: customerA,
      orderId: draft.id,
    });
    await fund(`${key}-plan`);
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), customerA, {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id,
    });
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, confirmed.id);
    if (service === null || service === undefined) throw new Error('no service');
    expect(service.state, 'the fixture must start ACTIVE').toBe('ACTIVE');
    await ctx.container.database.db.execute(
      sql`UPDATE services SET device_limit = 2 WHERE id = ${service.id}`,
    );
    devicePanel.limits.set(service.providerUsername, 2);
    return { id: service.id, username: service.providerUsername };
  }

  async function fund(key: string): Promise<void> {
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: `dev-${key}-fund`,
      direction: 'CREDIT',
      amountMinor: 5_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
  }

  /** An ACTIVE per-user rate: 50,000 a user, at most `max` per service. */
  async function offeredRate(
    key: string,
    max = 3,
    scope: { panelId?: string | null; productId?: string | null } = {},
  ): Promise<string> {
    const created = await ctx.container.serviceAddons.create(tenantA, owner, {
      idempotencyKey: `${key}-rate`,
      draft: {
        kind: 'ADD_DEVICES',
        title: 'کاربر اضافه',
        sortOrder: 10,
        specification: {
          kind: 'ADD_DEVICES',
          trafficBytes: null,
          durationDays: null,
          maxQuantity: max,
        },
        price: money(50_000n, 'IRT'),
        panelId: (scope.panelId ?? null) as PanelId | null,
        productId: (scope.productId ?? null) as ProductId | null,
      },
    });
    await ctx.container.serviceAddons.activate(tenantA, owner, {
      idempotencyKey: `${key}-rate-on`,
      addonId: created.id,
    });
    return created.id;
  }

  const draftDevices = (serviceId: string, addonId: string, quantity: number, key: string) =>
    ctx.container.commercialActions.draft(tenantA, systemActor(key), customerA, {
      serviceId,
      kind: 'ADD_DEVICES',
      addonId,
      quantity,
      idempotencyKey: `dev-${key}-quote`,
    });

  const confirmDevices = (orderId: string, key: string) =>
    ctx.container.commercialActions.confirm(tenantA, systemActor(key), customerA, {
      orderId,
      idempotencyKey: `dev-${key}-confirm`,
    });

  const payDevices = (orderId: string, key: string) =>
    ctx.container.payments.settleFromWallet(tenantA, systemActor(key), customerA, {
      idempotencyKey: `dev-${key}-pay`,
      orderId,
    });

  async function buyDevices(
    serviceId: string,
    addonId: string,
    quantity: number,
    key: string,
  ): Promise<OrderId> {
    const { order } = await draftDevices(serviceId, addonId, quantity, key);
    await confirmDevices(order.id, key);
    await payDevices(order.id, key);
    return order.id;
  }

  const tapUpdate = (data: string, telegramUserId = '920920', bot: BotInstanceId = BOT_A) => {
    updateSeq += 1;
    return {
      idempotencyKey: `dev-update-${String(updateSeq)}`,
      botInstanceId: bot,
      update: {
        update_id: updateSeq,
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'سارا' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: 5150, type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'سارا' },
    };
  };

  const runtime = () => ctx.container.botRuntime;
  // Round N (F4): a screen a service card's button opens is the card's message, edited.
  const lastMessage = () =>
    JSON.stringify(
      sent
        .filter((one) => one.url.includes('/sendMessage') || one.url.includes('/editMessageText'))
        .at(-1) ?? {},
    );
  const drawnCallbacks = (): string[] =>
    [...lastMessage().matchAll(/callback_data\\?":\\?"([^"\\]+)/gu)].map((match) => match[1] ?? '');

  const operationOf = async (serviceId: string) =>
    (await operations.listForService(tenantA, serviceId, 50)).find(
      (operation) => operation.type === 'ADD_DEVICES',
    );

  const orderState = async (orderId: string) =>
    (
      await ctx.container.database.db.execute<{ state: string }>(
        sql`SELECT state FROM orders WHERE id = ${orderId}`,
      )
    ).rows[0]?.state;

  const countOrders = async (purpose: string) =>
    Number(
      (
        await ctx.container.database.db.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM orders WHERE purpose = ${purpose}`,
        )
      ).rows[0]?.n ?? '0',
    );

  const makeDue = () =>
    ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET next_attempt_at = now() - interval '1 hour'
           WHERE type = 'ADD_DEVICES'`,
    );

  const balance = async () =>
    (await ctx.container.wallet.balance(tenantA, owner, customerA)).amountMinor;

  // =========================================================================
  // The shipped descriptors: nothing is offered and nothing can be bought
  // =========================================================================

  describe('on a panel whose adapter does not declare DEVICE_LIMIT_ADJUSTMENT', () => {
    it('draws no button, and refuses a crafted callback for the offer and for a quantity', async () => {
      const service = await activeService('gate');
      const rate = await offeredRate('gate');

      const card = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(`s:${service.id}`),
      );
      expect(card.replyKey).toBe('bot.service.card');
      expect(drawnCallbacks().some((data) => data.startsWith('dv:'))).toBe(false);
      expect(
        await ctx.container.commercialActions.availableFor(
          tenantA,
          systemActor('offer'),
          (await services.findById(tenantA, service.id))!,
        ),
      ).not.toContain('ADD_DEVICES');

      // A modified client that sends the offer's callback anyway.
      const offer = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(`dv:${service.id}`),
      );
      expect(offer.intent).toBe('SERVICE_ADD_DEVICES');
      expect(offer.replyKey).toBe('bot.service.capability_unsupported');

      // And the quantity's, which would write a draft if anything let it through.
      const buy = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(encodeDeviceQuantity(service.id, rate, 1)),
      );
      expect(buy.intent).toBe('SERVICE_BUY_DEVICES');
      expect(buy.replyKey).toBe('bot.service.capability_unsupported');
      expect(await countOrders('ADD_DEVICES')).toBe(0);

      await expect(draftDevices(service.id, rate, 1, 'gate-direct')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
      });
      expect(devicePanel.writes).toEqual([]);
    });
  });

  // =========================================================================
  // A panel that can raise a limit
  // =========================================================================

  describe('on a panel whose adapter declares and implements it', () => {
    beforeAll(() => installDevicePanel());
    afterAll(() => uninstallDevicePanel());

    it('offers it on the card, quotes the chosen count, snapshots it, and applies it once paid', async () => {
      const service = await activeService('happy');
      const rate = await offeredRate('happy', 3);
      await fund('happy');

      await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`s:${service.id}`));
      expect(drawnCallbacks()).toContain(`dv:${service.id}`);

      const choice = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(`dv:${service.id}`),
      );
      expect(choice.replyKey).toBe('bot.service.devices_choice');
      // One button per count the service may still buy — three — and each names the rate.
      const counts = drawnCallbacks().filter((data) => data.startsWith('dq:'));
      expect(counts).toEqual([1, 2, 3].map((n) => encodeDeviceQuantity(service.id, rate, n)));

      const quoted = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(encodeDeviceQuantity(service.id, rate, 2)),
      );
      expect(quoted.replyKey).toBe('bot.order.preinvoice');

      // The snapshot: quantity, unit price, total principal, target limit, rule and version.
      const snapshot = await ctx.container.database.db.execute<{
        id: string;
        state: string;
        line_quantity: number;
        line_unit_price_amount: string;
        line_device_limit: number;
        subtotal_amount: string;
        total_amount: string;
        quote: { trace: { ruleId: string | null }[] };
        purchased_device_count: number;
        addon_id: string;
        addon_version: number;
      }>(sql`
        SELECT o.id, o.state, o.line_quantity, o.line_unit_price_amount::text, o.line_device_limit,
               o.subtotal_amount::text, o.total_amount::text, o.quote,
               a.purchased_device_count, a.addon_id, a.addon_version
          FROM orders o JOIN service_commercial_actions a ON a.order_id = o.id
         WHERE o.purpose = 'ADD_DEVICES'`);
      expect(snapshot.rows).toHaveLength(1);
      const row = snapshot.rows[0]!;
      expect(row).toMatchObject({
        state: 'DRAFT',
        line_quantity: 2,
        line_unit_price_amount: '50000',
        line_device_limit: 4,
        subtotal_amount: '100000',
        total_amount: '100000',
        purchased_device_count: 2,
        addon_id: rate,
        addon_version: 1,
      });
      expect(row.quote.trace[0]?.ruleId).toBe(rate);

      // Confirm through the same `q:` the other commercial actions use, then the wallet.
      const confirmed = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(`q:${row.id}`),
      );
      expect(await orderState(row.id)).toBe('AWAITING_PAYMENT');
      expect(confirmed.replyKey).not.toBeNull();
      const before = await balance();
      await payDevices(row.id, 'happy');
      expect(before - (await balance())).toBe(100_000n);
      expect(await orderState(row.id)).toBe('PAID');

      const planned = await operationOf(service.id);
      expect(planned?.target).toEqual({ expiresAt: null, trafficLimitBytes: null, deviceLimit: 4 });

      await ctx.container.provisionerLoop.tick();
      expect((await operationOf(service.id))?.state).toBe('SUCCEEDED');
      expect(devicePanel.writes).toEqual([{ username: service.username, limit: 4 }]);
      expect((await services.findById(tenantA, service.id))?.deviceLimit).toBe(4);

      // The customer is told through the notification lane, keyed on the operation.
      const told = await ctx.container.database.db.execute<{ kind: string }>(
        sql`SELECT kind FROM customer_notifications WHERE subject_id = ${planned!.id}`,
      );
      expect(told.rows.map((one) => one.kind)).toEqual(['SERVICE_ACTION_SUCCEEDED']);

      // And what is left under the maximum is what the next offer shows.
      const offer = await ctx.container.commercialActions.offer(
        tenantA,
        systemActor('again'),
        customerA,
        service.id,
        'ADD_DEVICES',
      );
      expect(offer.devices).toMatchObject({ currentLimit: 4, remaining: 1 });
    });

    it('offers nothing where the declaration outran the methods: both are required', async () => {
      const service = await activeService('half');
      const rate = await offeredRate('half');
      const proto = MarzbanAdapter.prototype as unknown as Record<string, unknown>;
      const write = proto['applyDeviceLimit'];
      delete proto['applyDeviceLimit'];
      try {
        const record = (await services.findById(tenantA, service.id))!;
        expect(
          await ctx.container.commercialActions.availableFor(tenantA, systemActor('half'), record),
        ).not.toContain('ADD_DEVICES');
        await expect(draftDevices(service.id, rate, 1, 'half')).rejects.toMatchObject({
          code: COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
        });
      } finally {
        proto['applyDeviceLimit'] = write;
      }
      expect(await countOrders('ADD_DEVICES')).toBe(0);
    });

    it('is idempotent: a replayed draft, confirmation and payment buy it once', async () => {
      const service = await activeService('idem');
      const rate = await offeredRate('idem', 3);
      await fund('idem');

      const first = await draftDevices(service.id, rate, 1, 'idem');
      const again = await draftDevices(service.id, rate, 1, 'idem');
      expect(again.order.id).toBe(first.order.id);
      // The same key with a DIFFERENT count is a different command, refused as such.
      await expect(draftDevices(service.id, rate, 2, 'idem')).rejects.toThrow();

      await confirmDevices(first.order.id, 'idem');
      await confirmDevices(first.order.id, 'idem');
      const before = await balance();
      await payDevices(first.order.id, 'idem');
      await payDevices(first.order.id, 'idem');
      expect(before - (await balance())).toBe(50_000n);

      await ctx.container.provisionerLoop.tick();
      await ctx.container.provisionerLoop.tick();
      expect(devicePanel.writes).toHaveLength(1);
      expect(await countOrders('ADD_DEVICES')).toBe(1);
      expect((await services.findById(tenantA, service.id))?.deviceLimit).toBe(3);
    });

    it('settles an ambiguous write by READING the target, and never sends it again', async () => {
      const service = await activeService('lost-applied');
      const rate = await offeredRate('lost-applied');
      await fund('lost-applied');
      const orderId = await buyDevices(service.id, rate, 1, 'lost-applied');
      const paid = await balance();

      devicePanel.mode = 'LOST_AFTER_APPLY';
      await ctx.container.provisionerLoop.tick();
      expect((await operationOf(service.id))?.state).toBe('UNKNOWN');
      // Nothing is recorded as applied, and nothing is refunded, while it is unknown.
      expect((await services.findById(tenantA, service.id))?.deviceLimit).toBe(2);
      expect(await orderState(orderId)).toBe('PAID');

      // A second purchase cannot be priced from the un-updated limit meanwhile.
      await expect(buyDevices(service.id, rate, 1, 'lost-applied-2')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.SERVICE_ACTION_IN_PROGRESS,
      });

      devicePanel.mode = 'APPLY';
      await makeDue();
      await ctx.container.provisionerLoop.tick();

      expect((await operationOf(service.id))?.state).toBe('SUCCEEDED');
      expect(devicePanel.reads).toBeGreaterThanOrEqual(1);
      expect(devicePanel.writes, 'the write went out once').toHaveLength(1);
      expect((await services.findById(tenantA, service.id))?.deviceLimit).toBe(3);
      expect(await orderState(orderId)).toBe('PAID');
      expect(await balance()).toBe(paid);
    });

    it('refunds an ambiguous write the READ proves did not land, without sending it again', async () => {
      const service = await activeService('lost-absent');
      const rate = await offeredRate('lost-absent');
      await fund('lost-absent');
      const beforePurchase = await balance();
      const orderId = await buyDevices(service.id, rate, 2, 'lost-absent');

      devicePanel.mode = 'LOST_BEFORE_APPLY';
      await ctx.container.provisionerLoop.tick();
      expect((await operationOf(service.id))?.state).toBe('UNKNOWN');

      await makeDue();
      await ctx.container.provisionerLoop.tick();

      expect((await operationOf(service.id))?.state).toBe('FAILED');
      expect(devicePanel.writes, 'no blind replay').toHaveLength(1);
      expect(await orderState(orderId)).toBe('REFUNDED');
      expect(await balance()).toBe(beforePurchase);
      expect((await services.findById(tenantA, service.id))?.deviceLimit).toBe(2);
    });

    it('refunds a definitive refusal through the one credit path, for exactly what was paid', async () => {
      const service = await activeService('refused');
      const rate = await offeredRate('refused');
      await fund('refused');
      const beforePurchase = await balance();
      const orderId = await buyDevices(service.id, rate, 3, 'refused');
      expect(beforePurchase - (await balance())).toBe(150_000n);

      devicePanel.mode = 'REFUSED';
      await ctx.container.provisionerLoop.tick();

      expect((await operationOf(service.id))?.state).toBe('FAILED');
      expect(await orderState(orderId)).toBe('REFUNDED');
      expect(await balance()).toBe(beforePurchase);
      const credits = await ctx.container.database.db.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM wallet_entries
             WHERE direction = 'CREDIT' AND order_id = ${orderId}`,
      );
      expect(credits.rows[0]?.n).toBe('1');
      expect((await services.findById(tenantA, service.id))?.deviceLimit).toBe(2);

      // Never delivered, so refunded quantity is free again: the whole maximum remains.
      const offer = await ctx.container.commercialActions.offer(
        tenantA,
        systemActor('refused-again'),
        customerA,
        service.id,
        'ADD_DEVICES',
      );
      expect(offer.devices?.remaining).toBe(3);
    });

    it('keeps counting a DELIVERED purchase against the maximum after an operator refunds it', async () => {
      /*
       * Codex review #1 on PR #97, C1. A refund lowers neither `services.device_limit` nor
       * the panel's limit, so a delivered-then-refunded purchase still holds its devices —
       * and counting only live orders gave its quantity back to the cap.
       */
      const service = await activeService('refund-delivered');
      const rate = await offeredRate('refund-delivered', 3);
      await fund('refund-delivered');
      const orderId = await buyDevices(service.id, rate, 3, 'refund-delivered');
      await ctx.container.provisionerLoop.tick();
      expect((await operationOf(service.id))?.state).toBe('SUCCEEDED');
      expect((await services.findById(tenantA, service.id))?.deviceLimit).toBe(5);

      const payment = await ctx.container.database.db.execute<{ id: string; amount: string }>(
        sql`SELECT id, amount::text AS amount FROM payments
             WHERE order_id = ${orderId} AND state = 'CONFIRMED'`,
      );
      const paid = payment.rows[0]!;
      await ctx.container.refunds.request(tenantA, owner, {
        idempotencyKey: 'dev-refund-delivered-refund',
        paymentId: paid.id,
        amountMinor: BigInt(paid.amount),
        reason: 'درخواست مشتری',
      });
      expect(await orderState(orderId)).toBe('REFUNDED');
      // The panel and the entitlement still hold the raise the refund gave money back for.
      expect((await services.findById(tenantA, service.id))?.deviceLimit).toBe(5);

      await expect(
        draftDevices(service.id, rate, 1, 'refund-delivered-again'),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE });
      await expect(
        ctx.container.commercialActions.offer(
          tenantA,
          systemActor('refund-delivered-offer'),
          customerA,
          service.id,
          'ADD_DEVICES',
        ),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE });
      expect(devicePanel.writes).toHaveLength(1);
    });

    it('never sells past the maximum: counted from live orders, re-decided at confirmation', async () => {
      const service = await activeService('cap');
      const rate = await offeredRate('cap', 3);
      await fund('cap');

      // Past what remains is refused at the quote.
      await expect(draftDevices(service.id, rate, 4, 'cap-too-many')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
      });

      // Two drafts each fit alone; the second confirmation sees the first live order.
      const one = await draftDevices(service.id, rate, 2, 'cap-one');
      const two = await draftDevices(service.id, rate, 2, 'cap-two');
      await confirmDevices(one.order.id, 'cap-one');
      await expect(confirmDevices(two.order.id, 'cap-two')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
      });
      expect(await orderState(two.order.id)).toBe('DRAFT');
    });

    /*
     * Codex #2 on PR #102: an absolute ceiling — here the panel's own, WP-A8 — is judged
     * against the limit the service reaches once every live purchase is applied, not the
     * limit it records now. At 2 with a ceiling of 15, two +10 orders each fit alone; the
     * second confirmation must see the first and refuse, or settlement takes it to 22.
     */
    it('counts live, unapplied purchases against the panel ceiling, at quote and confirmation', async () => {
      const service = await activeService('ceiling');
      const rate = await offeredRate('ceiling', 20);
      await fund('ceiling');
      await ctx.container.panelAdvanced.updatePolicy(tenantA, owner, panelId, {
        policy: {
          delivery: { mode: 'CARD_WITH_QR' },
          actions: { EXTRA_DEVICES: { customerEnabled: true, maxDeviceLimit: 15 } },
        },
        expectedRevision: 0,
        idempotencyKey: 'ceiling-policy',
      });

      const one = await draftDevices(service.id, rate, 10, 'ceiling-one');
      const two = await draftDevices(service.id, rate, 10, 'ceiling-two');
      await confirmDevices(one.order.id, 'ceiling-one');
      await expect(confirmDevices(two.order.id, 'ceiling-two')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
      });
      expect(await orderState(two.order.id)).toBe('DRAFT');
      // And a fresh quote past what is left is refused before it is drafted.
      await expect(draftDevices(service.id, rate, 4, 'ceiling-three')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
      });
      await expect(draftDevices(service.id, rate, 3, 'ceiling-four')).resolves.toBeDefined();
    });

    it('refuses a rate, and a quote, whose total the order row could not hold', async () => {
      /*
       * Codex review #2 on PR #97. The price bound admits any bigint and the quote is
       * price × count, so a rate near the ceiling overflowed the order insert — a 500.
       */
      const service = await activeService('overflow');
      const half = MAX_MONEY_AMOUNT_MINOR / 2n + 1n;
      const draftOf = (maxQuantity: number, amount: bigint) => ({
        kind: 'ADD_DEVICES' as const,
        title: 'گران',
        sortOrder: 0,
        specification: {
          kind: 'ADD_DEVICES' as const,
          trafficBytes: null,
          durationDays: null,
          maxQuantity,
        },
        price: money(amount, 'IRT'),
      });
      // (a) At save: a maximum of two at over half the ceiling is refused, on create and edit.
      await expect(
        ctx.container.serviceAddons.create(tenantA, owner, {
          idempotencyKey: 'dev-overflow-create',
          draft: draftOf(2, half),
        }),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID });
      const rate = await offeredRate('overflow', 3);
      await expect(
        ctx.container.serviceAddons.update(tenantA, owner, {
          idempotencyKey: 'dev-overflow-edit',
          addonId: rate,
          edit: draftOf(2, half),
        }),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID });

      // (b) A rate stored before that bound existed: the quote refuses, and writes nothing.
      await ctx.container.database.db.execute(
        sql`UPDATE service_addons SET price_amount = ${half.toString()}::bigint WHERE id = ${rate}`,
      );
      await expect(draftDevices(service.id, rate, 2, 'overflow-quote')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
      });
      expect(await countOrders('ADD_DEVICES')).toBe(0);
    });

    it('prices a service from the most specific rate that applies to it', async () => {
      const service = await activeService('scope');
      const record = (await services.findById(tenantA, service.id))!;
      await offeredRate('scope-all', 3);
      const forProduct = await offeredRate('scope-product', 5, { productId: record.productId });

      const offer = await ctx.container.commercialActions.offer(
        tenantA,
        systemActor('scope'),
        customerA,
        service.id,
        'ADD_DEVICES',
      );
      expect(offer.devices?.addon.id).toBe(forProduct);
      expect(offer.devices?.remaining).toBe(5);
    });

    it("keeps one tenant's service, rate and panel out of another's reach", async () => {
      const service = await activeService('iso');
      const rate = await offeredRate('iso');

      const resolvedB = await ctx.container.customers.resolveFromUpdate(tenantB, systemActor('b'), {
        idempotencyKey: 'resolve-devices-b',
        telegramUserId: '930930',
        from: { id: 930930, first_name: 'B' },
        botInstanceId: BOT_B,
      });

      // Tenant B's customer naming tenant A's service and rate: the same NOT_FOUND an id
      // that does not exist gets, and no order anywhere.
      await expect(
        ctx.container.commercialActions.draft(tenantB, systemActor('b'), resolvedB.customer.id, {
          serviceId: service.id,
          kind: 'ADD_DEVICES',
          addonId: rate,
          quantity: 1,
          idempotencyKey: 'dev-iso-b-quote',
        }),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND });
      expect(await countOrders('ADD_DEVICES')).toBe(0);

      // Tenant A's rate is invisible from tenant B, and tenant B cannot scope a rate of its
      // own to tenant A's panel.
      const ownerB = adminActorFor(
        await createAdmin(ctx.container, tenantB, {
          username: 'owner-devices-b',
          roleKeys: ['owner'],
        }),
      );
      await expect(ctx.container.serviceAddons.get(tenantB, ownerB, rate)).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.ADDON_NOT_FOUND,
      });
      await expect(
        ctx.container.serviceAddons.create(tenantB, ownerB, {
          idempotencyKey: 'dev-iso-b-rate',
          draft: {
            kind: 'ADD_DEVICES',
            title: 'B',
            sortOrder: 0,
            specification: {
              kind: 'ADD_DEVICES',
              trafficBytes: null,
              durationDays: null,
              maxQuantity: 2,
            },
            price: money(10_000n, 'IRT'),
            panelId: panelId as PanelId,
          },
        }),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID });

      // And the service's own customer, over Telegram, through tenant B's bot: not found.
      const crossed = await runtime().handle(
        tenantB,
        systemActor('bot-b'),
        tapUpdate(encodeDeviceQuantity(service.id, rate, 1), '930930', BOT_B),
      );
      expect(crossed.replyKey).toBe('bot.service.not_found');
      expect(encodeIdPair(service.id, rate)).toHaveLength(43);
    });
  });
});
