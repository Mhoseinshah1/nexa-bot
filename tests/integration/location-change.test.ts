import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  EMPTY_PRODUCT_DISPLAY,
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
  type ProviderLocationOutcome,
  type ProviderUserRef,
  type UserId,
} from '@nexa/contracts';
import { encodeIdPair } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import { MarzbanAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/marzban.adapter';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { DrizzleOperationRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-operation.repository';
import { SERVICE_LOCATION_WRITE_LOCK_CLASS } from '../../apps/api/src/modules/commerce/locations/infrastructure/drizzle-service-location.repository';
import type { ServiceLocationInput } from '../../apps/api/src/modules/commerce/locations/application/service-location-admin.service';
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
 * Service location change (WP-A6), end to end: a real PostgreSQL, the real bot runtime,
 * the real commercial, payment, settlement, provisioner, refund and notification lanes.
 *
 * ## What is real and what is not
 *
 * No provider in this release declares `LOCATION_CHANGE`: nothing about a live move has
 * been measured on a real panel (Marzban), a RickPanel account has no per-user location,
 * and 3X-UI is frozen by the owner. So the first block runs against the SHIPPED
 * descriptors and proves the customer is offered nothing, and a crafted callback, a
 * direct quote and a free request all move nothing.
 *
 * Everything after it needs a panel that CAN move an account, and none exists — so for
 * that block the Marzban descriptor is given the capability and the Marzban adapter the
 * two methods, backed by `locationPanel` below, an in-memory panel whose answer each case
 * scripts. That is a fake of the PROVIDER, not of Nexa: every row, lock, transition,
 * refund and notification the cases assert is production code. What it cannot prove —
 * that some real panel moves the SAME account absolutely, answers a replay with no change
 * and reports where it put it — is the acceptance a declaring adapter must bring with it,
 * and is claimed nowhere here.
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

/** What the scripted panel does with the NEXT move. */
type WriteMode = 'APPLY' | 'LOST_AFTER_APPLY' | 'LOST_BEFORE_APPLY' | 'REFUSED' | 'ABSENT';

const locationPanel = {
  at: new Map<string, string>(),
  mode: 'APPLY' as WriteMode,
  /** When set, a move rotates the account's link to this one, as a panel might. */
  newLink: null as string | null,
  writes: [] as { username: string; key: string }[],
  reads: 0,
};

const originalCapabilities: ProviderCapability[] = [];

/** Gives the Marzban descriptor and adapter the capability, for one block only. */
function installLocationPanel(): void {
  const descriptor = providerDescriptor('marzban');
  if (descriptor === null) throw new Error('no marzban descriptor');
  const capabilities = descriptor.capabilities as ProviderCapability[];
  originalCapabilities.splice(0, originalCapabilities.length, ...capabilities);
  capabilities.push('LOCATION_CHANGE');
  const proto = MarzbanAdapter.prototype as unknown as Record<string, unknown>;
  proto['readLocation'] = async (
    _target: unknown,
    _http: unknown,
    ref: ProviderUserRef,
  ): Promise<ProviderLocationOutcome> => {
    locationPanel.reads += 1;
    const held = locationPanel.at.get(ref.username);
    return held === undefined
      ? { ok: true, found: false }
      : { ok: true, found: true, locationKey: held, subscriptionUrl: locationPanel.newLink };
  };
  proto['applyLocation'] = async (
    _target: unknown,
    _http: unknown,
    ref: ProviderUserRef,
    key: string,
  ): Promise<ProviderLocationOutcome> => {
    locationPanel.writes.push({ username: ref.username, key });
    switch (locationPanel.mode) {
      case 'ABSENT':
        return { ok: true, found: false };
      case 'REFUSED':
        return { ok: false, failure: 'PROVIDER_REFUSED', status: 400 };
      case 'LOST_BEFORE_APPLY':
        return { ok: false, failure: 'TIMEOUT', status: null };
      case 'LOST_AFTER_APPLY':
        locationPanel.at.set(ref.username, key);
        return { ok: false, failure: 'TIMEOUT', status: null };
      case 'APPLY':
        locationPanel.at.set(ref.username, key);
        return { ok: true, found: true, locationKey: key, subscriptionUrl: locationPanel.newLink };
    }
  };
}

function uninstallLocationPanel(): void {
  const descriptor = providerDescriptor('marzban');
  if (descriptor === null) return;
  const capabilities = descriptor.capabilities as ProviderCapability[];
  capabilities.splice(0, capabilities.length, ...originalCapabilities);
  const proto = MarzbanAdapter.prototype as unknown as Record<string, unknown>;
  delete proto['readLocation'];
  delete proto['applyLocation'];
}

describe('service location change (WP-A6)', () => {
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
    uninstallLocationPanel();
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
    locationPanel.at.clear();
    locationPanel.mode = 'APPLY';
    locationPanel.newLink = null;
    locationPanel.writes = [];
    locationPanel.reads = 0;

    panel = await startFakeMarzban({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'owner-locations',
        roleKeys: ['owner'],
      }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-locations-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);

    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-locations',
      telegramUserId: '940940',
      from: { id: 940940, first_name: 'مریم' },
      botInstanceId: BOT_A,
    });
    customerA = resolved.customer.id;
  });

  /** An ACTIVE service on the panel, which the scripted panel holds in `de`. */
  async function activeService(key: string): Promise<{ id: string; username: string }> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ماهانه',
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
    locationPanel.at.set(service.providerUsername, 'de');
    return { id: service.id, username: service.providerUsername };
  }

  async function fund(key: string): Promise<void> {
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: `loc-${key}-fund`,
      direction: 'CREDIT',
      amountMinor: 5_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
  }

  const location = (overrides: Partial<ServiceLocationInput>): ServiceLocationInput => ({
    panelId,
    productId: null,
    locationKey: 'nl',
    label: 'هلند',
    initial: false,
    enabled: true,
    price: { amountMinor: 30_000n, currency: 'IRT' },
    limits: { cooldownHours: null, maxChanges: null, periodDays: null },
    sortOrder: 10,
    ...overrides,
  });

  let locationSeq = 0;
  async function configure(input: ServiceLocationInput): Promise<string> {
    locationSeq += 1;
    const saved = await ctx.container.serviceLocations.create(tenantA, owner, {
      idempotencyKey: `loc-config-${String(locationSeq)}`,
      location: input,
    });
    return saved.location.id;
  }

  /** The panel's initial location `de`, a paid `nl` and a free `fi`. */
  async function standardLocations(
    limits: ServiceLocationInput['limits'] = {
      cooldownHours: null,
      maxChanges: null,
      periodDays: null,
    },
  ): Promise<{ de: string; nl: string; fi: string }> {
    const de = await configure(
      location({ locationKey: 'de', label: 'آلمان', initial: true, enabled: false, price: null }),
    );
    const nl = await configure(location({ limits }));
    const fi = await configure(
      location({
        locationKey: 'fi',
        label: 'فنلاند',
        price: { amountMinor: 0n, currency: 'IRT' },
        limits,
        sortOrder: 20,
      }),
    );
    return { de, nl, fi };
  }

  const draftMove = (serviceId: string, locationId: string, key: string) =>
    ctx.container.commercialActions.draft(tenantA, systemActor(key), customerA, {
      serviceId,
      kind: 'CHANGE_LOCATION',
      locationId,
      idempotencyKey: `loc-${key}-quote`,
    });

  const confirmMove = (orderId: string, key: string) =>
    ctx.container.commercialActions.confirm(tenantA, systemActor(key), customerA, {
      orderId,
      idempotencyKey: `loc-${key}-confirm`,
    });

  const payMove = (orderId: string, key: string) =>
    ctx.container.payments.settleFromWallet(tenantA, systemActor(key), customerA, {
      idempotencyKey: `loc-${key}-pay`,
      orderId,
    });

  async function buyMove(serviceId: string, locationId: string, key: string): Promise<OrderId> {
    const { order } = await draftMove(serviceId, locationId, key);
    await confirmMove(order.id, key);
    await payMove(order.id, key);
    return order.id;
  }

  const requestFree = (serviceId: string, locationId: string, key: string) =>
    ctx.container.locationChanges.requestFree(tenantA, systemActor(key), customerA, {
      serviceId,
      locationId,
      idempotencyKey: `loc-${key}-free`,
    });

  const tapUpdate = (data: string, telegramUserId = '940940', bot: BotInstanceId = BOT_A) => {
    updateSeq += 1;
    return {
      idempotencyKey: `loc-update-${String(updateSeq)}`,
      botInstanceId: bot,
      update: {
        update_id: updateSeq,
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'مریم' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: 6160, type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'مریم' },
    };
  };

  const runtime = () => ctx.container.botRuntime;
  const lastMessage = () =>
    JSON.stringify(sent.filter((one) => one.url.includes('/sendMessage')).at(-1) ?? {});
  const drawnCallbacks = (): string[] =>
    [...lastMessage().matchAll(/callback_data\\?":\\?"([^"\\]+)/gu)].map((match) => match[1] ?? '');

  const moveOf = async (serviceId: string) =>
    (await operations.listForService(tenantA, serviceId, 50)).filter(
      (operation) => operation.type === 'CHANGE_LOCATION',
    );

  const orderState = async (orderId: string) =>
    (
      await ctx.container.database.db.execute<{ state: string }>(
        sql`SELECT state FROM orders WHERE id = ${orderId}`,
      )
    ).rows[0]?.state;

  const count = async (table: 'orders' | 'service_location_changes', where = sql`TRUE`) =>
    Number(
      (
        await ctx.container.database.db.execute<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM ${sql.raw(table)} WHERE ${where}`,
        )
      ).rows[0]?.n ?? '0',
    );

  const makeDue = () =>
    ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET next_attempt_at = now() - interval '1 hour'
           WHERE type = 'CHANGE_LOCATION'`,
    );

  const balance = async () =>
    (await ctx.container.wallet.balance(tenantA, owner, customerA)).amountMinor;

  // =========================================================================
  // The shipped descriptors: nothing is offered and nothing can be moved
  // =========================================================================

  describe('on a panel whose adapter does not declare LOCATION_CHANGE', () => {
    it('draws no button, and a crafted callback, quote or free request moves nothing', async () => {
      const service = await activeService('gate');
      const { nl, fi } = await standardLocations();

      await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`s:${service.id}`));
      expect(drawnCallbacks().some((data) => data.startsWith('lc:'))).toBe(false);
      expect(
        await ctx.container.commercialActions.availableFor(
          tenantA,
          systemActor('offer'),
          (await services.findById(tenantA, service.id))!,
        ),
      ).not.toContain('CHANGE_LOCATION');

      const choice = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(`lc:${service.id}`),
      );
      expect(choice.intent).toBe('SERVICE_CHANGE_LOCATION');
      expect(choice.replyKey).toBe('bot.service.capability_unsupported');

      const target = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(`lt:${encodeIdPair(service.id, nl)}`),
      );
      expect(target.intent).toBe('SERVICE_LOCATION_TARGET');
      expect(target.replyKey).toBe('bot.service.capability_unsupported');

      const free = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(`lf:${encodeIdPair(service.id, fi)}`),
      );
      expect(free.intent).toBe('SERVICE_LOCATION_CONFIRM');
      expect(free.replyKey).toBe('bot.service.capability_unsupported');

      await expect(draftMove(service.id, nl, 'gate-direct')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
      });
      await expect(requestFree(service.id, fi, 'gate-free')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
      });
      expect(await count('orders', sql`purpose = 'CHANGE_LOCATION'`)).toBe(0);
      expect(await count('service_location_changes')).toBe(0);
      expect(await moveOf(service.id)).toEqual([]);
      expect(locationPanel.writes).toEqual([]);
    });
  });

  // =========================================================================
  // A panel that can move an account
  // =========================================================================

  describe('on a panel whose adapter declares and implements it', () => {
    beforeAll(() => installLocationPanel());
    afterAll(() => uninstallLocationPanel());

    it('offers it, quotes a paid move, snapshots it, and moves the SAME service once paid', async () => {
      const service = await activeService('happy');
      const { nl, fi } = await standardLocations();
      await fund('happy');
      const before = (await services.findById(tenantA, service.id))!;

      await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`s:${service.id}`));
      expect(drawnCallbacks()).toContain(`lc:${service.id}`);

      const choice = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(`lc:${service.id}`),
      );
      expect(choice.replyKey).toBe('bot.service.location_choice');
      // Where it is now, and one button per configured target OTHER than it.
      expect(lastMessage()).toContain('آلمان');
      expect(drawnCallbacks().filter((data) => data.startsWith('lt:'))).toEqual([
        `lt:${encodeIdPair(service.id, nl)}`,
        `lt:${encodeIdPair(service.id, fi)}`,
      ]);

      const quoted = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(`lt:${encodeIdPair(service.id, nl)}`),
      );
      expect(quoted.replyKey).toBe('bot.order.preinvoice');
      expect(lastMessage()).toContain('هلند');

      // The snapshot: the order line, the commercial action and the frozen change request.
      const snapshot = await ctx.container.database.db.execute<{
        id: string;
        state: string;
        line_unit_price_amount: string;
        total_amount: string;
        quote: { trace: { ruleId: string | null }[] };
        location_id: string;
        from_location_key: string;
        from_location_label: string;
        to_location_key: string;
        to_location_label: string;
        location_version: number;
        price_amount: string;
        operation_id: string | null;
      }>(sql`
        SELECT o.id, o.state, o.line_unit_price_amount::text, o.total_amount::text, o.quote,
               a.location_id, c.from_location_key, c.from_location_label, c.to_location_key,
               c.to_location_label, c.location_version, c.price_amount::text, c.operation_id
          FROM orders o
          JOIN service_commercial_actions a ON a.order_id = o.id
          JOIN service_location_changes c ON c.order_id = o.id
         WHERE o.purpose = 'CHANGE_LOCATION'`);
      expect(snapshot.rows).toHaveLength(1);
      const row = snapshot.rows[0]!;
      expect(row).toMatchObject({
        state: 'DRAFT',
        line_unit_price_amount: '30000',
        total_amount: '30000',
        location_id: nl,
        from_location_key: 'de',
        from_location_label: 'آلمان',
        to_location_key: 'nl',
        to_location_label: 'هلند',
        location_version: 1,
        price_amount: '30000',
        operation_id: null,
      });
      expect(row.quote.trace[0]?.ruleId).toBe(nl);

      await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`q:${row.id}`));
      expect(await orderState(row.id)).toBe('AWAITING_PAYMENT');
      const paidFrom = await balance();
      await payMove(row.id, 'happy');
      expect(paidFrom - (await balance())).toBe(30_000n);
      expect(await orderState(row.id)).toBe('PAID');

      const [planned] = await moveOf(service.id);
      expect(planned?.target).toEqual({
        expiresAt: null,
        trafficLimitBytes: null,
        deviceLimit: null,
        locationKey: 'nl',
      });
      expect(planned?.orderId).toBe(row.id);

      await ctx.container.provisionerLoop.tick();
      expect((await moveOf(service.id))[0]?.state).toBe('SUCCEEDED');
      expect(locationPanel.writes).toEqual([{ username: service.username, key: 'nl' }]);

      // The SAME service record, moved: its identity, order, state and allowance kept.
      const after = (await services.findById(tenantA, service.id))!;
      expect(after).toMatchObject({
        id: before.id,
        orderId: before.orderId,
        state: 'ACTIVE',
        providerUsername: before.providerUsername,
        expiresAt: before.expiresAt,
        trafficLimitBytes: before.trafficLimitBytes,
        subscriptionUrl: before.subscriptionUrl,
        locationKey: 'nl',
        locationLabel: 'هلند',
      });
      // No new service, and the original order is untouched.
      expect(
        Number(
          (
            await ctx.container.database.db.execute<{ n: string }>(
              sql`SELECT count(*)::text AS n FROM services`,
            )
          ).rows[0]?.n,
        ),
      ).toBe(1);
      expect(await orderState(before.orderId)).toBe('PAID');

      // The audit row: old and new location, the order and the operation.
      const audited = await ctx.container.database.db.execute<{
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      }>(
        sql`SELECT before, after FROM audit_logs
             WHERE action = 'service.change_location' AND entity_id = ${service.id}`,
      );
      expect(audited.rows).toHaveLength(1);
      expect(audited.rows[0]?.before).toMatchObject({ locationKey: null });
      expect(audited.rows[0]?.after).toMatchObject({
        locationKey: 'nl',
        locationLabel: 'هلند',
        orderId: row.id,
        operationId: planned?.operationId,
        connectionDetailsChanged: false,
      });
      const events = await ctx.container.database.db.execute<{ payload: unknown }>(
        sql`SELECT payload FROM outbox_messages
             WHERE event_type = 'ServiceLocationChanged' AND aggregate_id = ${service.id}`,
      );
      expect(events.rows.map((one) => one.payload)).toEqual([
        { customerId: customerA, fromLocationKey: 'de', toLocationKey: 'nl' },
      ]);

      // The customer is told through the notification lane, keyed on the operation.
      const told = await ctx.container.database.db.execute<{ kind: string }>(
        sql`SELECT kind FROM customer_notifications WHERE subject_id = ${planned!.id}`,
      );
      expect(told.rows.map((one) => one.kind)).toEqual(['SERVICE_ACTION_SUCCEEDED']);

      // The card now shows where it is, and the next choice starts from there.
      const offer = await ctx.container.commercialActions.offer(
        tenantA,
        systemActor('again'),
        customerA,
        service.id,
        'CHANGE_LOCATION',
      );
      expect(offer.locations?.current).toEqual({ key: 'nl', label: 'هلند' });
      expect(offer.locations?.targets.map((one) => one.locationKey)).toEqual(['fi']);
    });

    it('delivers a link the move rotated, through the ordinary delivery lane', async () => {
      const service = await activeService('rotated');
      const { nl } = await standardLocations();
      await fund('rotated');
      locationPanel.newLink = 'https://sub.example.test/sub/rotated-by-move';
      await buyMove(service.id, nl, 'rotated');
      await ctx.container.provisionerLoop.tick();

      const after = (await services.findById(tenantA, service.id))!;
      expect(after.locationKey).toBe('nl');
      expect(after.subscriptionUrl).toBe('https://sub.example.test/sub/rotated-by-move');
      const rotated = await ctx.container.database.db.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM outbox_messages
             WHERE event_type = 'ServiceSubscriptionRotated' AND aggregate_id = ${service.id}`,
      );
      expect(rotated.rows[0]?.n).toBe('1');
      // The link never reaches the audit log.
      const audited = await ctx.container.database.db.execute<{ row: string }>(
        sql`SELECT after::text AS row FROM audit_logs WHERE action = 'service.change_location'`,
      );
      expect(audited.rows[0]?.row).not.toContain('rotated-by-move');
      expect(audited.rows[0]?.row).toContain('"connectionDetailsChanged": true');
    });

    it('asks a FREE move for an explicit confirmation, writes no order, and moves it once', async () => {
      const service = await activeService('free');
      const { fi } = await standardLocations();

      const asked = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(`lt:${encodeIdPair(service.id, fi)}`),
      );
      expect(asked.replyKey).toBe('bot.service.location_confirm_free');
      expect(drawnCallbacks()).toContain(`lf:${encodeIdPair(service.id, fi)}`);
      // Nothing is written by the question.
      expect(await count('service_location_changes')).toBe(0);

      const tap = tapUpdate(`lf:${encodeIdPair(service.id, fi)}`);
      const confirmed = await runtime().handle(tenantA, systemActor('bot'), tap);
      expect(confirmed.replyKey).toBe('bot.service.location_requested');
      // Telegram redelivering the same update requests it once.
      await runtime().handle(tenantA, systemActor('bot'), tap);
      expect(await count('service_location_changes')).toBe(1);
      expect(await count('orders', sql`purpose = 'CHANGE_LOCATION'`)).toBe(0);

      const [planned] = await moveOf(service.id);
      expect(planned).toMatchObject({ orderId: null, requestedByCustomerId: customerA });
      const change = await ctx.container.database.db.execute<{
        operation_id: string;
        price_amount: string;
        from_location_key: string;
        to_location_key: string;
      }>(sql`SELECT operation_id, price_amount::text, from_location_key, to_location_key
               FROM service_location_changes`);
      expect(change.rows[0]).toMatchObject({
        operation_id: planned?.id,
        price_amount: '0',
        from_location_key: 'de',
        to_location_key: 'fi',
      });

      const walletBefore = await balance();
      await ctx.container.provisionerLoop.tick();
      expect((await moveOf(service.id))[0]?.state).toBe('SUCCEEDED');
      expect((await services.findById(tenantA, service.id))?.locationKey).toBe('fi');
      expect(locationPanel.writes).toHaveLength(1);
      expect(await balance()).toBe(walletBefore);
    });

    it('offers nothing where the declaration outran the methods: both are required', async () => {
      const service = await activeService('half');
      const { nl } = await standardLocations();
      const proto = MarzbanAdapter.prototype as unknown as Record<string, unknown>;
      const write = proto['applyLocation'];
      delete proto['applyLocation'];
      try {
        const record = (await services.findById(tenantA, service.id))!;
        expect(
          await ctx.container.commercialActions.availableFor(tenantA, systemActor('half'), record),
        ).not.toContain('CHANGE_LOCATION');
        await expect(draftMove(service.id, nl, 'half')).rejects.toMatchObject({
          code: COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
        });
      } finally {
        proto['applyLocation'] = write;
      }
      expect(await count('orders', sql`purpose = 'CHANGE_LOCATION'`)).toBe(0);
    });

    it('asks again when the money moves: a service already there is not charged', async () => {
      const service = await activeService('landed');
      const { nl } = await standardLocations();
      await fund('landed');
      const { order } = await draftMove(service.id, nl, 'landed');
      await confirmMove(order.id, 'landed');
      // Another change landed the service in `nl` between the confirmation and the payment.
      await ctx.container.database.db.execute(
        sql`UPDATE services SET location_key = 'nl', location_label = 'هلند' WHERE id = ${service.id}`,
      );
      const before = await balance();
      await expect(payMove(order.id, 'landed')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.LOCATION_CHANGE_SAME_LOCATION,
      });
      // A wallet purchase is refused, never refunded: nothing was taken.
      expect(await balance()).toBe(before);
      expect(await orderState(order.id)).toBe('AWAITING_PAYMENT');
      expect(await moveOf(service.id)).toEqual([]);
    });

    it('is idempotent: a replayed quote, confirmation and payment move it once', async () => {
      const service = await activeService('idem');
      const { nl } = await standardLocations();
      await fund('idem');

      const first = await draftMove(service.id, nl, 'idem');
      const again = await draftMove(service.id, nl, 'idem');
      expect(again.order.id).toBe(first.order.id);
      await confirmMove(first.order.id, 'idem');
      await confirmMove(first.order.id, 'idem');
      const before = await balance();
      await payMove(first.order.id, 'idem');
      await payMove(first.order.id, 'idem');
      expect(before - (await balance())).toBe(30_000n);

      await ctx.container.provisionerLoop.tick();
      await ctx.container.provisionerLoop.tick();
      expect(locationPanel.writes).toHaveLength(1);
      expect(await count('orders', sql`purpose = 'CHANGE_LOCATION'`)).toBe(1);
      expect(await count('service_location_changes')).toBe(1);
    });

    it('settles an ambiguous move by READING the target, and never sends it again', async () => {
      const service = await activeService('lost-applied');
      const { nl } = await standardLocations();
      await fund('lost-applied');
      const orderId = await buyMove(service.id, nl, 'lost-applied');
      const paid = await balance();

      locationPanel.mode = 'LOST_AFTER_APPLY';
      await ctx.container.provisionerLoop.tick();
      expect((await moveOf(service.id))[0]?.state).toBe('UNKNOWN');
      // Nothing recorded, nothing refunded, while it is unknown.
      expect((await services.findById(tenantA, service.id))?.locationKey).toBeNull();
      expect(await orderState(orderId)).toBe('PAID');

      // Another move — or any paid action — cannot start meanwhile.
      await expect(buyMove(service.id, nl, 'lost-applied-2')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.SERVICE_ACTION_IN_PROGRESS,
      });

      locationPanel.mode = 'APPLY';
      await makeDue();
      await ctx.container.provisionerLoop.tick();

      const moves = await moveOf(service.id);
      expect(moves.find((one) => one.orderId === orderId)?.state).toBe('SUCCEEDED');
      expect(locationPanel.reads).toBeGreaterThanOrEqual(1);
      expect(locationPanel.writes, 'the move went out once').toHaveLength(1);
      expect((await services.findById(tenantA, service.id))?.locationKey).toBe('nl');
      expect(await orderState(orderId)).toBe('PAID');
      expect(await balance()).toBe(paid);
    });

    it('refunds an ambiguous move the READ proves did not land, without sending it again', async () => {
      const service = await activeService('lost-absent');
      const { nl } = await standardLocations();
      await fund('lost-absent');
      const beforePurchase = await balance();
      const orderId = await buyMove(service.id, nl, 'lost-absent');

      locationPanel.mode = 'LOST_BEFORE_APPLY';
      await ctx.container.provisionerLoop.tick();
      expect((await moveOf(service.id))[0]?.state).toBe('UNKNOWN');

      await makeDue();
      await ctx.container.provisionerLoop.tick();

      expect((await moveOf(service.id))[0]?.state).toBe('FAILED');
      expect(locationPanel.writes, 'no blind replay').toHaveLength(1);
      expect(await orderState(orderId)).toBe('REFUNDED');
      expect(await balance()).toBe(beforePurchase);
      expect((await services.findById(tenantA, service.id))?.locationKey).toBeNull();
    });

    it('refunds a definitive refusal once, and a free one fails with nothing to refund', async () => {
      const service = await activeService('refused');
      const { nl, fi } = await standardLocations();
      await fund('refused');
      const beforePurchase = await balance();
      const orderId = await buyMove(service.id, nl, 'refused');
      expect(beforePurchase - (await balance())).toBe(30_000n);

      locationPanel.mode = 'REFUSED';
      await ctx.container.provisionerLoop.tick();
      expect((await moveOf(service.id))[0]?.state).toBe('FAILED');
      expect(await orderState(orderId)).toBe('REFUNDED');
      expect(await balance()).toBe(beforePurchase);
      const credits = await ctx.container.database.db.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM wallet_entries
             WHERE direction = 'CREDIT' AND order_id = ${orderId}`,
      );
      expect(credits.rows[0]?.n).toBe('1');

      // A failed move does not count against the service, so a free one may follow.
      await requestFree(service.id, fi, 'refused-free');
      await ctx.container.provisionerLoop.tick();
      const free = (await moveOf(service.id)).find((one) => one.orderId === null);
      expect(free?.state).toBe('FAILED');
      expect(await balance()).toBe(beforePurchase);
      const told = await ctx.container.database.db.execute<{ kind: string }>(
        sql`SELECT kind FROM customer_notifications WHERE subject_id = ${free!.id}`,
      );
      expect(told.rows.map((one) => one.kind)).toEqual(['SERVICE_ACTION_FAILED']);
      expect((await services.findById(tenantA, service.id))?.locationKey).toBeNull();
    });

    it('refuses a move to where the service already is, and never offers one', async () => {
      const service = await activeService('same');
      // The initial location is a priced target too: moving BACK there is a real move.
      const de = await configure(
        location({ locationKey: 'de', label: 'آلمان', initial: true, enabled: true }),
      );
      const nl = await configure(location({}));
      const offer = await ctx.container.commercialActions.offer(
        tenantA,
        systemActor('same'),
        customerA,
        service.id,
        'CHANGE_LOCATION',
      );
      expect(offer.locations?.targets.map((one) => one.id)).toEqual([nl]);
      await expect(draftMove(service.id, de, 'same')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.LOCATION_CHANGE_SAME_LOCATION,
      });
      const tapped = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(`lt:${encodeIdPair(service.id, de)}`),
      );
      expect(tapped.replyKey).toBe('bot.service.location_same');
      expect(await count('orders', sql`purpose = 'CHANGE_LOCATION'`)).toBe(0);
    });

    it('holds a cooldown and a rolling limit, counted from the changes that happened', async () => {
      const service = await activeService('window');
      const { de, nl, fi } = await standardLocations({
        cooldownHours: 24,
        maxChanges: null,
        periodDays: null,
      });
      await requestFree(service.id, fi, 'window-1');
      await ctx.container.provisionerLoop.tick();
      expect((await services.findById(tenantA, service.id))?.locationKey).toBe('fi');

      // Every target is inside its cooldown now, so nothing is advertised: no button, no
      // choice screen, rather than a tap that is then refused (Codex #1 on PR #101).
      expect(
        await ctx.container.commercialActions.availableFor(
          tenantA,
          systemActor('window-offer'),
          (await services.findById(tenantA, service.id))!,
        ),
      ).not.toContain('CHANGE_LOCATION');
      await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`s:${service.id}`));
      expect(drawnCallbacks().some((data) => data.startsWith('lc:'))).toBe(false);

      await expect(draftMove(service.id, nl, 'window-2')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.LOCATION_CHANGE_COOLDOWN,
      });
      const tapped = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(`lt:${encodeIdPair(service.id, nl)}`),
      );
      expect(tapped.replyKey).toBe('bot.service.location_cooldown');

      // A limit of one change in thirty days, and no cooldown, on a target of its own.
      await ctx.container.serviceLocations.update(tenantA, owner, {
        idempotencyKey: 'loc-window-de',
        locationId: de,
        location: location({
          locationKey: 'de',
          label: 'آلمان',
          initial: true,
          enabled: true,
          price: { amountMinor: 0n, currency: 'IRT' },
          limits: { cooldownHours: null, maxChanges: 1, periodDays: 30 },
        }),
      });
      await expect(requestFree(service.id, de, 'window-3')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.LOCATION_CHANGE_LIMIT_REACHED,
      });
      expect(await count('service_location_changes')).toBe(1);
    });

    it('refuses a service that is not live', async () => {
      const service = await activeService('blocked');
      const { nl, fi } = await standardLocations();
      await ctx.container.database.db.execute(
        sql`UPDATE services SET state = 'SUSPENDED' WHERE id = ${service.id}`,
      );
      await expect(draftMove(service.id, nl, 'blocked')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
      });
      await expect(requestFree(service.id, fi, 'blocked-free')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
      });
      expect(await count('service_location_changes')).toBe(0);
    });

    it('refuses a move while a refund request for the service is open', async () => {
      const service = await activeService('refund-open');
      const { nl, fi } = await standardLocations();
      const flags = await ctx.container.featureFlags.list(tenantA, owner);
      const current = flags.find((flag) => flag.key === 'customer_refund_requests');
      await ctx.container.featureFlags.set(tenantA, owner, {
        key: 'customer_refund_requests',
        enabled: true,
        expectedVersion: current?.version ?? null,
        idempotencyKey: 'loc-refund-flag',
        confirmKey: 'customer_refund_requests',
        reason: 'WP-A6 integration.',
      });
      await ctx.container.serviceRefundRequests.file(tenantA, systemActor('file'), {
        customerId: customerA,
        serviceId: service.id,
        botInstanceId: BOT_A,
        reason: 'دیگر نیازی به این سرویس ندارم',
        idempotencyKey: 'loc-refund-file',
      });

      await expect(draftMove(service.id, nl, 'refund-open')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
      });
      await expect(requestFree(service.id, fi, 'refund-open-free')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
      });
      expect(await count('service_location_changes')).toBe(0);
      expect(await moveOf(service.id)).toEqual([]);
    });

    it('offers nothing while the current location is unknown: never where it already is', async () => {
      const service = await activeService('unknown-origin');
      // A target, and no initial location: where a never-moved service is, nobody said.
      const nl = await configure(location({}));
      expect(
        await ctx.container.commercialActions.availableFor(
          tenantA,
          systemActor('offer'),
          (await services.findById(tenantA, service.id))!,
        ),
      ).not.toContain('CHANGE_LOCATION');
      await expect(draftMove(service.id, nl, 'unknown-origin')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
      });
      const tapped = await runtime().handle(
        tenantA,
        systemActor('bot'),
        tapUpdate(`lc:${service.id}`),
      );
      expect(tapped.replyKey).toBe('bot.service.action_unavailable');
    });

    it("freezes where a never-moved service is before its panel's initial location changes", async () => {
      const service = await activeService('frozen-origin');
      const { de } = await standardLocations();
      expect((await services.findById(tenantA, service.id))?.locationKey).toBeNull();

      // The operator re-points the panel's initial location: new accounts start elsewhere.
      await ctx.container.serviceLocations.update(tenantA, owner, {
        idempotencyKey: 'loc-frozen-edit',
        locationId: de,
        location: location({
          locationKey: 'de-2',
          label: 'آلمان ۲',
          initial: true,
          enabled: false,
          price: null,
        }),
      });
      // The old service is still where it was, recorded on it rather than inferred.
      expect(await services.findById(tenantA, service.id)).toMatchObject({
        locationKey: 'de',
        locationLabel: 'آلمان',
      });
      const offer = await ctx.container.commercialActions.offer(
        tenantA,
        systemActor('frozen'),
        customerA,
        service.id,
        'CHANGE_LOCATION',
      );
      expect(offer.locations?.current).toEqual({ key: 'de', label: 'آلمان' });
      const audited = await ctx.container.database.db.execute<{ after: Record<string, unknown> }>(
        sql`SELECT after FROM audit_logs WHERE action = 'service_location.update'`,
      );
      expect(audited.rows[0]?.after).toMatchObject({ unmovedServicesFrozen: 1 });
    });

    it('confirms a paid move under the limits it was quoted with, not ones written since', async () => {
      const service = await activeService('frozen-limits');
      const { nl, fi } = await standardLocations();
      await fund('frozen-limits');
      await requestFree(service.id, fi, 'frozen-limits-free');
      await ctx.container.provisionerLoop.tick();
      expect((await services.findById(tenantA, service.id))?.locationKey).toBe('fi');

      const { order } = await draftMove(service.id, nl, 'frozen-limits');
      // After the quote, the operator allows one change in thirty days — already used.
      await ctx.container.serviceLocations.update(tenantA, owner, {
        idempotencyKey: 'loc-frozen-limits-edit',
        locationId: nl,
        location: location({ limits: { cooldownHours: null, maxChanges: 1, periodDays: 30 } }),
      });
      await confirmMove(order.id, 'frozen-limits');
      expect(await orderState(order.id)).toBe('AWAITING_PAYMENT');
      const frozen = await ctx.container.database.db.execute<{ max_changes: number | null }>(
        sql`SELECT max_changes FROM service_location_changes WHERE order_id = ${order.id}`,
      );
      expect(frozen.rows[0]?.max_changes).toBeNull();
    });

    it("checks a reseller's tier for a FREE move too, deny by default", async () => {
      const service = await activeService('reseller-free');
      const { fi } = await standardLocations();
      const tier = await ctx.container.resellersAdmin.createTier(tenantA, owner, {
        idempotencyKey: 'loc-reseller-tier',
        write: {
          name: 'Tier L',
          pricingMode: 'LIST_PRICE',
          discountPercentage: null,
          creditLimit: money(0n, 'IRT'),
        },
      });
      const grants = [
        { kind: 'OPERATION' as const, subject: 'RENEW' },
        { kind: 'PRODUCT' as const, subject: null },
        { kind: 'PANEL' as const, subject: null },
        { kind: 'BOT' as const, subject: null },
      ];
      await ctx.container.resellersAdmin.replaceGrants(tenantA, owner, {
        idempotencyKey: 'loc-reseller-grants-1',
        tierId: tier.id,
        grants,
      });
      await ctx.container.resellersAdmin.register(tenantA, owner, {
        idempotencyKey: 'loc-reseller-register',
        customerId: customerA,
        write: {
          tierId: tier.id,
          pricingMode: 'TIER',
          discountPercentage: null,
          creditLimit: null,
        },
      });

      await expect(requestFree(service.id, fi, 'reseller-free-1')).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.RESELLER_NOT_ENTITLED,
      });
      expect(await count('service_location_changes')).toBe(0);

      await ctx.container.resellersAdmin.replaceGrants(tenantA, owner, {
        idempotencyKey: 'loc-reseller-grants-2',
        tierId: tier.id,
        grants: [...grants, { kind: 'OPERATION' as const, subject: 'CHANGE_LOCATION' }],
      });
      await requestFree(service.id, fi, 'reseller-free-2');
      expect(await count('service_location_changes')).toBe(1);
    });

    it("keeps one tenant's service and locations out of another's reach", async () => {
      const service = await activeService('iso');
      const { nl, fi } = await standardLocations();
      const resolvedB = await ctx.container.customers.resolveFromUpdate(tenantB, systemActor('b'), {
        idempotencyKey: 'resolve-locations-b',
        telegramUserId: '950950',
        from: { id: 950950, first_name: 'B' },
        botInstanceId: BOT_B,
      });
      await expect(
        ctx.container.commercialActions.draft(tenantB, systemActor('b'), resolvedB.customer.id, {
          serviceId: service.id,
          kind: 'CHANGE_LOCATION',
          locationId: nl,
          idempotencyKey: 'loc-iso-b-quote',
        }),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND });
      await expect(
        ctx.container.locationChanges.requestFree(
          tenantB,
          systemActor('b'),
          resolvedB.customer.id,
          {
            serviceId: service.id,
            locationId: fi,
            idempotencyKey: 'loc-iso-b-free',
          },
        ),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND });

      const ownerB = adminActorFor(
        await createAdmin(ctx.container, tenantB, { username: 'owner-loc-b', roleKeys: ['owner'] }),
      );
      expect(await ctx.container.serviceLocations.list(tenantB, ownerB)).toEqual([]);
      await expect(
        ctx.container.serviceLocations.create(tenantB, ownerB, {
          idempotencyKey: 'loc-iso-b-config',
          location: location({ locationKey: 'b' }),
        }),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.SERVICE_LOCATION_INVALID });
      await expect(
        ctx.container.serviceLocations.remove(tenantB, ownerB, {
          idempotencyKey: 'loc-iso-b-delete',
          locationId: nl,
        }),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.SERVICE_LOCATION_NOT_FOUND });
      expect(await count('orders', sql`purpose = 'CHANGE_LOCATION'`)).toBe(0);
      expect(await count('service_location_changes')).toBe(0);
    });
  });

  // =========================================================================
  // The operator's configuration
  // =========================================================================

  describe('the configured locations', () => {
    async function secondPanel(): Promise<string> {
      const created = await ctx.container.panels.create(tenantA, owner, {
        name: 'Marzban B',
        providerType: 'marzban',
        baseUrl: 'http://127.0.0.9:8000',
        credentials: { username: 'admin', password: 'secret-password' },
        activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
        idempotencyKey: 'panel-locations-create-b',
      });
      return created.view.panel.id;
    }

    it('refuses a product scope from another panel, and a panel past its location cap', async () => {
      const other = await secondPanel();
      const product = await products.create(tenantA, {
        id: ctx.container.ids.uuid() as ProductId,
        draft: {
          title: 'پلن پنل دیگر',
          description: null,
          audience: 'EVERYONE',
          sortOrder: 0,
          panelId: other as PanelId,
          categoryId: SEED_IDS.categoryA as ProductCategoryId,
          specification: { durationDays: 30, trafficBytes: 1_073_741_824n, deviceLimit: null },
          price: money(10_000n, 'IRT'),
          display: EMPTY_PRODUCT_DISPLAY,
        },
        now: ctx.container.clock.now(),
      });
      await expect(configure(location({ productId: product.id }))).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.SERVICE_LOCATION_INVALID,
        details: { reason: 'PRODUCT_PANEL' },
      });
      // On its own panel the same scope is accepted.
      await configure(location({ panelId: other, productId: product.id }));

      for (let n = 0; n < 20; n += 1) await configure(location({ locationKey: `k-${String(n)}` }));
      await expect(configure(location({ locationKey: 'k-20' }))).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.SERVICE_LOCATION_INVALID,
        details: { reason: 'PANEL_FULL' },
      });
    });

    it('holds the tenant cap under two concurrent creates: exactly one takes the last place', async () => {
      const other = await secondPanel();
      // 499 rows, written past the service so the per-panel cap is not what is measured.
      await ctx.container.database.db.execute(sql`
        INSERT INTO service_locations (id, tenant_id, panel_id, location_key, label)
        SELECT gen_random_uuid(), ${tenantA.tenantId}::uuid, ${other}::uuid, 'bulk-' || n, 'x'
          FROM generate_series(1, 499) AS n`);
      /*
       * The interleaving made deterministic: the FIRST writer takes the tenant's location
       * lock, adds the 500th row and holds its transaction open while the second create
       * starts. With the lock, the second waits and then counts 500; without it, it counts
       * 499 past the uncommitted row and both land — which two creates racing on their own
       * rarely manage to show inside a test.
       */
      let second: Promise<unknown> | undefined;
      await ctx.container.database.db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${SERVICE_LOCATION_WRITE_LOCK_CLASS}, hashtext(${tenantA.tenantId}))`,
        );
        await tx.execute(sql`
          INSERT INTO service_locations (id, tenant_id, panel_id, location_key, label)
          VALUES (gen_random_uuid(), ${tenantA.tenantId}::uuid, ${panelId}::uuid, 'first', 'x')`);
        second = ctx.container.serviceLocations
          .create(tenantA, owner, {
            idempotencyKey: 'loc-race-b',
            location: location({ locationKey: 'race-b' }),
          })
          .then(
            () => ({ ok: true }),
            (error: unknown) => ({ ok: false, error }),
          );
        await new Promise((resolve) => setTimeout(resolve, 500));
      });
      expect(await second).toMatchObject({
        ok: false,
        error: {
          code: COMMERCE_ERROR_CODES.SERVICE_LOCATION_INVALID,
          details: { reason: 'COUNT' },
        },
      });
      expect(
        Number(
          (
            await ctx.container.database.db.execute<{ n: string }>(
              sql`SELECT count(*)::text AS n FROM service_locations`,
            )
          ).rows[0]?.n,
        ),
      ).toBe(500);
    });

    it('versions every edit, says when nothing changed, and keeps quoted history', async () => {
      const first = await ctx.container.serviceLocations.create(tenantA, owner, {
        idempotencyKey: 'loc-admin-create',
        location: location({}),
      });
      expect(first.location.version).toBe(1);
      const replay = await ctx.container.serviceLocations.create(tenantA, owner, {
        idempotencyKey: 'loc-admin-create',
        location: location({}),
      });
      expect(replay.location.id).toBe(first.location.id);

      const same = await ctx.container.serviceLocations.update(tenantA, owner, {
        idempotencyKey: 'loc-admin-same',
        locationId: first.location.id,
        location: location({}),
      });
      expect(same).toMatchObject({ changed: false, location: { version: 1 } });
      const edited = await ctx.container.serviceLocations.update(tenantA, owner, {
        idempotencyKey: 'loc-admin-edit',
        locationId: first.location.id,
        location: location({ price: { amountMinor: 45_000n, currency: 'IRT' } }),
      });
      expect(edited).toMatchObject({ changed: true, location: { version: 2 } });
      const audited = await ctx.container.database.db.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM audit_logs
             WHERE entity_type = 'ServiceLocation' AND result = 'SUCCESS'`,
      );
      expect(audited.rows[0]?.n).toBe('2');

      // One initial location per panel, and one row per key per scope.
      await configure(
        location({ locationKey: 'de', label: 'آلمان', initial: true, price: null, enabled: false }),
      );
      await expect(
        configure(
          location({
            locationKey: 'at',
            label: 'اتریش',
            initial: true,
            price: null,
            enabled: false,
          }),
        ),
      ).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.SERVICE_LOCATION_INVALID,
        details: { reason: 'SECOND_INITIAL' },
      });
      await expect(configure(location({}))).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.SERVICE_LOCATION_INVALID,
        details: { reason: 'DUPLICATE_KEY' },
      });
      // Enabled with no price is refused: unconfigured is never free.
      await expect(configure(location({ locationKey: 'se', price: null }))).rejects.toMatchObject({
        code: COMMERCE_ERROR_CODES.SERVICE_LOCATION_INVALID,
        details: { reason: 'UNPRICED' },
      });

      const unused = await configure(location({ locationKey: 'fr', label: 'فرانسه' }));
      expect(
        await ctx.container.serviceLocations.remove(tenantA, owner, {
          idempotencyKey: 'loc-admin-delete',
          locationId: unused,
        }),
      ).toEqual({ deleted: true });
    });

    it('refuses to delete a location a change was quoted from, and a read-only role any write', async () => {
      installLocationPanel();
      try {
        const service = await activeService('in-use');
        const { nl } = await standardLocations();
        await draftMove(service.id, nl, 'in-use');
        await expect(
          ctx.container.serviceLocations.remove(tenantA, owner, {
            idempotencyKey: 'loc-admin-in-use',
            locationId: nl,
          }),
        ).rejects.toMatchObject({
          code: COMMERCE_ERROR_CODES.SERVICE_LOCATION_INVALID,
          details: { reason: 'IN_USE' },
        });
      } finally {
        uninstallLocationPanel();
      }

      const observer = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'observer-loc',
          roleKeys: ['observer'],
        }),
      );
      expect((await ctx.container.serviceLocations.list(tenantA, observer)).length).toBe(3);
      await expect(
        ctx.container.serviceLocations.create(tenantA, observer, {
          idempotencyKey: 'loc-observer-create',
          location: location({ locationKey: 'pl' }),
        }),
      ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
    });
  });
});
