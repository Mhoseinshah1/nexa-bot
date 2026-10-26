import { createServer, type Server } from 'node:http';
import { eq, sql } from 'drizzle-orm';
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
import { tenants } from '../../apps/api/src/infrastructure/persistence/schema';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleOperationRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-operation.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import type { ServiceRecord } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import {
  BRIDGE_SECRET,
  bridgeTls,
  startFakeCustomBridge,
  type FakeCustomBridge,
} from '../support/fake-custom-bridge';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * The `custom` provider through the shipped container (R10 C2).
 *
 * The real panel service, provisioner, executor, probe core, monitor, live check, ledger
 * and outbox, the real `CustomPanelAdapter` over the real `SafeHttpClient` — against a
 * mock bridge written from `docs/protocols/custom-panel.md` that verifies every request's
 * signature and signs every answer, over HTTPS through a private CA. Nothing in the
 * application layer knows the provider is new: these tests are what show that
 * registering the adapter wired it into everything the other three are wired into.
 *
 * And the gates the descriptor declares: off by default, https only, a 32-character
 * secret — and a flag turned OFF later stops new panels, never existing ones.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const GIB = 1024n ** 3n;
const OPS_CHAT = '-1001234567890';

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('the custom (bridge protocol) provider', () => {
  const tls = bridgeTls();
  let ctx: TestContext;
  let telegram: Server;
  let bridge: FakeCustomBridge;
  let owner: ActorContext;
  let customerId: UserId;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let operations: DrizzleOperationRepository;
  let counter = 0;
  const key = () => `custom-panel-${String(++counter)}`;

  beforeAll(async () => {
    telegram = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 7 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      // The bridge is HTTPS behind a private CA, and verification stays on.
      PANEL_HTTP_CA_FILE: tls.caFile,
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(ctx.container.database.db);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    operations = new DrizzleOperationRepository(ctx.container.database.db);
    // 127.0.0.2: the container's URL policy denies the host its own data services use.
    bridge = await startFakeCustomBridge({ host: '127.0.0.2', tls });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-custom', roleKeys: ['owner'] }),
    );
    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('c'), {
      idempotencyKey: 'resolve-custom',
      telegramUserId: '930930',
      from: { id: 930930, first_name: 'مریم' },
      botInstanceId: BOT_A,
    });
    customerId = resolved.customer.id;
  });

  afterEach(async () => {
    await bridge?.close();
  });

  async function setFlag(flagKey: string, enabled: boolean): Promise<void> {
    const before = (await ctx.container.featureFlags.list(tenantA, owner)).find(
      (flag) => flag.key === flagKey,
    );
    if (before === undefined) throw new Error(`no ${flagKey} flag`);
    await ctx.container.featureFlags.set(tenantA, owner, {
      idempotencyKey: key(),
      key: flagKey as never,
      enabled,
      expectedVersion: before.version,
      confirmKey: flagKey,
      reason: 'custom panel suite',
    });
  }

  const createPanel = (over: Record<string, unknown> = {}) =>
    ctx.container.panels.create(tenantA, owner, {
      name: 'Bridge',
      providerType: 'custom',
      baseUrl: bridge.baseUrl,
      credentials: { apiToken: BRIDGE_SECRET },
      activation: {},
      idempotencyKey: key(),
      ...over,
    });

  /** A created custom panel that passed its connection test, so it may be sold. */
  async function readyPanel(): Promise<string> {
    await setFlag('custom_panel_provider', true);
    const created = await createPanel();
    const tested = await ctx.container.panels.testConnection(
      tenantA,
      owner,
      created.view.panel.id,
      { idempotencyKey: key() },
    );
    expect(tested.probed).toBe(true);
    return created.view.panel.id;
  }

  /** Make every panel due for the monitor and outside its per-panel probe cooldown. */
  const dueForMonitor = async () => {
    await ctx.container.database.db.execute(
      sql`UPDATE panel_monitor_schedule SET next_eligible_at = now() - interval '1 hour'`,
    );
    await ctx.container.database.db.execute(sql`DELETE FROM panel_probe_claims`);
  };

  const panelRows = async () =>
    (
      await ctx.container.database.db.execute<{ id: string }>(
        sql`SELECT id FROM panels WHERE tenant_id = ${tenantA.tenantId} AND provider_type = 'custom'`,
      )
    ).rows;

  async function paidOrder(panelId: string, tag: string): Promise<OrderId> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پل',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        // A device limit, which the custom descriptor declares (`LIMIT_DEVICES`).
        specification: { durationDays: 30, trafficBytes: 50n * GIB, deviceLimit: 2 },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(tag), {
      idempotencyKey: `${tag}-draft`,
      customerId,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(tag), {
      idempotencyKey: `${tag}-confirm`,
      customerId,
      orderId: draft.id,
    });
    await ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: `${tag}-credit`,
      direction: 'CREDIT',
      amountMinor: 2_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(tag), customerId, {
      idempotencyKey: `${tag}-pay`,
      orderId: confirmed.id,
    });
    return confirmed.id;
  }

  const ledger = async () =>
    (
      await ctx.container.database.db.execute<{ direction: string; reason: string }>(
        sql`SELECT direction, reason FROM wallet_entries WHERE customer_id = ${customerId}
             ORDER BY created_at, id`,
      )
    ).rows;
  const refunds = async () => (await ledger()).filter((one) => one.reason === 'REFUND');

  const reload = async (id: string): Promise<ServiceRecord> => {
    const found = await services.findById(tenantA, id as never);
    if (found === null) throw new Error('service vanished');
    return found;
  };
  const makeDue = () =>
    ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET next_attempt_at = now() - interval '1 hour'
           WHERE state = 'PLANNED'`,
    );
  const operationOf = async (serviceId: string, type: string) =>
    (await operations.listForService(tenantA, serviceId, 50)).find(
      (operation) => operation.type === type,
    );

  async function deliveredService(panelId: string, tag: string): Promise<ServiceRecord> {
    const orderId = await paidOrder(panelId, tag);
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, orderId);
    if (service === null || service.state !== 'ACTIVE') {
      throw new Error(`not provisioned: ${service?.state ?? 'no service'}`);
    }
    return service;
  }

  describe('creating one', () => {
    it('is refused while custom_panel_provider is off — the default — and writes nothing', async () => {
      await expect(createPanel()).rejects.toMatchObject({
        code: 'panel.provider_feature_disabled',
      });
      expect(await panelRows()).toHaveLength(0);
    });

    it('is accepted once the flag is on; the secret goes one way and is never echoed', async () => {
      await setFlag('custom_panel_provider', true);
      const created = await createPanel();
      expect(created.view.panel.providerType).toBe('custom');
      expect(JSON.stringify(created.view)).not.toContain(BRIDGE_SECRET);
      expect(created.view.credentials.apiTokenSetAt).not.toBeNull();
      const stored = await ctx.container.database.db.execute<{ api_token: string | null }>(
        sql`SELECT api_token_ciphertext AS api_token FROM panel_credentials
             WHERE panel_id = ${created.view.panel.id}`,
      );
      expect(String(stored.rows[0]?.api_token)).not.toContain(BRIDGE_SECRET);
    });

    it('refuses an http:// address, at create and at an address change', async () => {
      await setFlag('custom_panel_provider', true);
      const plain = bridge.baseUrl.replace(/^https:/, 'http:');
      await expect(createPanel({ baseUrl: plain })).rejects.toMatchObject({
        code: 'panel.url_invalid',
      });
      const created = await createPanel();
      await expect(
        ctx.container.panels.update(tenantA, owner, created.view.panel.id, {
          baseUrl: plain,
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({ code: 'panel.url_invalid' });
    });

    it('refuses a secret shorter than 32 characters, at create and at replacement', async () => {
      await setFlag('custom_panel_provider', true);
      await expect(
        createPanel({ credentials: { apiToken: 'x'.repeat(31) } }),
      ).rejects.toMatchObject({ code: 'panel.credential_too_short' });
      const created = await createPanel();
      await expect(
        ctx.container.panels.setCredentials(tenantA, owner, created.view.panel.id, {
          credentials: { apiToken: 'y'.repeat(31) },
          idempotencyKey: key(),
        }),
      ).rejects.toMatchObject({ code: 'panel.credential_too_short' });
    });

    it('accepts a per-panel timeout of 1..30 seconds and nothing else', async () => {
      await setFlag('custom_panel_provider', true);
      await expect(createPanel({ activation: { requestTimeoutMs: 31_000 } })).rejects.toMatchObject(
        { code: 'panel.request_invalid' },
      );
      await expect(createPanel({ activation: { inboundId: 3 } })).rejects.toMatchObject({
        code: 'panel.request_invalid',
      });
      const created = await createPanel({ activation: { requestTimeoutMs: 5_000 } });
      expect(created.view.panel.activation).toEqual({ requestTimeoutMs: 5_000 });
    });

    it('is refused for a stopped tenant inside the transaction', async () => {
      await setFlag('custom_panel_provider', true);
      await ctx.container.database.db
        .update(tenants)
        .set({ status: 'STOPPED' })
        .where(eq(tenants.id, tenantA.tenantId));
      await expect(createPanel()).rejects.toMatchObject({ code: 'platform.tenant_not_found' });
      expect(await panelRows()).toHaveLength(0);
    });
  });

  describe('the connection test and the monitor', () => {
    it('a signed health is a healthy, validated, sellable panel with the bridge version', async () => {
      const panelId = await readyPanel();
      const view = await ctx.container.panels.get(tenantA, owner, panelId);
      expect(view.health).toMatchObject({ state: 'HEALTHY', providerVersion: '1.4.2' });
      expect(view.sellability).toMatchObject({ sellable: true });
      expect(bridge.count('health')).toBe(1);
    });

    it('the monitor probes it: upstream down is DEGRADED, a wrong secret is AUTH_FAILED', async () => {
      const panelId = await readyPanel();
      bridge.behave('health', 'upstream-down', 1);
      await dueForMonitor();
      await ctx.container.panelMonitor.tick();
      expect((await ctx.container.panels.get(tenantA, owner, panelId)).health?.state).toBe(
        'DEGRADED',
      );

      await ctx.container.panels.setCredentials(tenantA, owner, panelId, {
        credentials: { apiToken: 'z'.repeat(40) },
        idempotencyKey: key(),
      });
      await dueForMonitor();
      await ctx.container.panelMonitor.tick();
      expect((await ctx.container.panels.get(tenantA, owner, panelId)).health?.state).toBe(
        'AUTH_FAILED',
      );
    });
  });

  describe('a service on it, end to end', () => {
    it('provisions with the operation id and the binding, delivers, and logs the purchase', async () => {
      await setFlag('ops_notifications', true);
      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'ops.notifications.telegram_chat_id',
        value: OPS_CHAT,
        expectedVersion: null,
        idempotencyKey: key(),
      });
      const panelId = await readyPanel();
      const service = await deliveredService(panelId, 'e2e');

      // The bridge holds it under the stored name, bound to the stored clientId.
      const held = bridge.accounts.get(service.providerUsername);
      expect(held?.nexaRef).toBe(service.providerClientId);
      expect(held?.limitBytes).toBe(50n * GIB);
      expect(held?.deviceLimit).toBe(2);
      // The link is the one the bridge issued, from its signed answer.
      expect(service.subscriptionUrl).toBe(bridge.subscriptionUrl(service.providerUsername));
      // The create carried the PROVISION operation's id: the bridge's idempotency key.
      const provision = await operationOf(service.id, 'PROVISION');
      const create = bridge.requests.find((one) => one.route === 'create');
      expect(create?.body?.['operationId']).toBe(provision?.id);
      expect(create?.verified).toBe(true);
      expect(bridge.count('create')).toBe(1);
      expect(await refunds()).toHaveLength(0);

      // The existing purchase log (L11, wallet), from the one ServiceProvisioned event —
      // no new log type for a new provider.
      for (let batch = 0; batch < 50; batch += 1) {
        if ((await ctx.container.relay.processBatch()).claimed === 0) break;
      }
      const logged = await ctx.container.database.db.execute<{ template_key: string }>(
        sql`SELECT template_key FROM notifications
             WHERE tenant_id = ${tenantA.tenantId}
               AND template_key IN ('ops.log.service_created', 'ops.log.service_created_wallet')`,
      );
      expect(logged.rows.map((row) => row.template_key)).toEqual([
        'ops.log.service_created_wallet',
      ]);
    });

    it('suspends, resumes, rotates the link and terminates, each with its own operation id', async () => {
      const panelId = await readyPanel();
      const service = await deliveredService(panelId, 'manage');
      const name = service.providerUsername;

      // The disable is applied and its answer lost: an idempotent mutation, so it is
      // retried as the SAME operation — same id — and the bridge answers it as a replay.
      bridge.behave('disable', '500-after-apply', 1);
      await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'SUSPEND', {
        idempotencyKey: key(),
      });
      await ctx.container.provisionerLoop.tick();
      await makeDue();
      await ctx.container.provisionerLoop.tick();
      expect((await reload(service.id)).state).toBe('SUSPENDED');
      expect(bridge.accounts.get(name)?.disabled).toBe(true);
      const disables = bridge.requests.filter((one) => one.route === 'disable');
      expect(disables).toHaveLength(2);
      const suspendId = (await operationOf(service.id, 'SUSPEND'))?.id;
      expect(disables.map((one) => one.body?.['operationId'])).toEqual([suspendId, suspendId]);
      expect([...bridge.operations.values()].filter((one) => one.op === 'disable')).toHaveLength(1);

      await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'RESUME', {
        idempotencyKey: key(),
      });
      await ctx.container.provisionerLoop.tick();
      expect((await reload(service.id)).state).toBe('ACTIVE');
      expect(bridge.accounts.get(name)?.disabled).toBe(false);

      const before = (await reload(service.id)).subscriptionUrl;
      await ctx.container.provisioning.requestFromOperator(
        tenantA,
        owner,
        service.id,
        'ROTATE_SUBSCRIPTION',
        { idempotencyKey: key() },
      );
      await ctx.container.provisionerLoop.tick();
      const rotated = await reload(service.id);
      expect((await operationOf(service.id, 'ROTATE_SUBSCRIPTION'))?.state).toBe('SUCCEEDED');
      expect(rotated.subscriptionUrl).not.toBe(before);
      expect(rotated.subscriptionUrl).toBe(bridge.subscriptionUrl(name));

      await ctx.container.provisioning.requestFromOperator(
        tenantA,
        owner,
        service.id,
        'TERMINATE',
        { idempotencyKey: key() },
      );
      await ctx.container.provisionerLoop.tick();
      expect((await reload(service.id)).state).toBe('TERMINATED');
      expect(bridge.accounts.has(name)).toBe(false);

      // Every write carried its own operation's id and this service's binding.
      const ids = await operations.listForService(tenantA, service.id, 50);
      for (const route of ['create', 'disable', 'enable', 'rotate', 'delete'] as const) {
        const sent = bridge.requests.find((one) => one.route === route);
        expect(sent?.body?.['nexaRef'], route).toBe(service.providerClientId);
        expect(
          ids.map((op) => op.id),
          route,
        ).toContain(sent?.body?.['operationId']);
      }
      expect(await refunds()).toHaveLength(0);
    });

    it('renews with absolute targets: charged once, applied once, Nexa and the bridge agree', async () => {
      const panelId = await readyPanel();
      const service = await deliveredService(panelId, 'bought');
      const { order } = await ctx.container.commercialActions.draft(
        tenantA,
        systemActor('renew'),
        customerId,
        { serviceId: service.id, kind: 'RENEW', idempotencyKey: 'renew-quote' },
      );
      await ctx.container.commercialActions.confirm(tenantA, systemActor('renew'), customerId, {
        orderId: order.id,
        idempotencyKey: 'renew-confirm',
      });
      await ctx.container.payments.settleFromWallet(tenantA, systemActor('renew'), customerId, {
        idempotencyKey: 'renew-pay',
        orderId: order.id,
      });
      // The bridge applies it and the answer is lost. A renewal whose answer was lost is
      // never re-sent blind (WP15 G2): it goes UNKNOWN and a READ compares the account
      // with the absolute target — the same path every provider's renewal takes.
      bridge.behave('allowance', '500-after-apply', 1);
      await ctx.container.provisionerLoop.tick();
      expect((await operationOf(service.id, 'RENEW'))?.state).toBe('UNKNOWN');
      expect(await refunds()).toHaveLength(0);
      await ctx.container.database.db.execute(
        sql`UPDATE provisioning_operations SET next_attempt_at = now() - interval '1 hour'
             WHERE state = 'UNKNOWN' AND next_attempt_at IS NOT NULL`,
      );
      await ctx.container.provisionerLoop.tick();

      const renew = await operationOf(service.id, 'RENEW');
      expect(renew?.state).toBe('SUCCEEDED');
      const after = await reload(service.id);
      expect(after.expiresAt?.getTime()).toBe(
        (service.expiresAt?.getTime() ?? 0) + 30 * 86_400_000,
      );
      expect(after.trafficLimitBytes).toBe(service.trafficLimitBytes + 50n * GIB);
      const held = bridge.accounts.get(service.providerUsername);
      expect(held?.limitBytes).toBe(after.trafficLimitBytes);
      expect(Date.parse(held?.expiresAt ?? '')).toBe(
        Math.floor((after.expiresAt?.getTime() ?? 0) / 1000) * 1000,
      );
      // ONE write carrying absolute targets and this operation's id; the verification read.
      const allowances = bridge.requests.filter((one) => one.route === 'allowance');
      expect(allowances).toHaveLength(1);
      expect(allowances[0]?.body?.['operationId']).toBe(renew?.id);
      expect(bridge.operations.get(renew?.id ?? '')?.op).toBe('allowance');
      expect(await refunds()).toHaveLength(0);
    });

    it('the live check reads it, and an account gone from the bridge is reported missing', async () => {
      const panelId = await readyPanel();
      const service = await deliveredService(panelId, 'live');
      const refresh = (
        ctx.container.botRuntime as unknown as {
          deps: {
            serviceRefresh: {
              liveCheck: (
                scope: typeof tenantA,
                actor: ActorContext,
                input: { customerId: UserId; serviceId: string },
              ) => Promise<{ outcome: string }>;
            };
          };
        }
      ).deps.serviceRefresh;
      bridge.useTraffic(service.providerUsername, 3n * GIB);
      await ctx.container.database.db.execute(
        sql`UPDATE services SET usage_synced_at = NULL WHERE id = ${service.id}`,
      );
      expect(
        await refresh.liveCheck(tenantA, systemActor('live'), {
          customerId,
          serviceId: service.id,
        }),
      ).toMatchObject({ outcome: 'FRESH' });
      expect((await reload(service.id)).trafficUsedBytes).toBe(3n * GIB);
    });

    it('applies the per-panel timeout: a bridge that hangs is given up on in about a second', async () => {
      await setFlag('custom_panel_provider', true);
      const created = await createPanel({ activation: { requestTimeoutMs: 1_000 } });
      await ctx.container.panels.testConnection(tenantA, owner, created.view.panel.id, {
        idempotencyKey: key(),
      });
      bridge.behave('create', 'hang');
      const orderId = await paidOrder(created.view.panel.id, 'timeout');
      const started = performance.now();
      await ctx.container.provisionerLoop.tick();
      expect(performance.now() - started).toBeLessThan(6_000);
      const service = await services.findByOrderId(tenantA, orderId);
      const provision = await operationOf(service?.id ?? '', 'PROVISION');
      expect(provision?.state).toBe('UNKNOWN');
      expect(provision?.failureKind).toBe('TIMEOUT');
      expect(await refunds(), 'a timed-out create was refunded').toHaveLength(0);
    });
  });

  /*
   * A create is the one write that is never retried after a lost answer. These are the
   * money rules on it, on this provider: an ambiguous create is UNKNOWN and NEVER
   * refunded; a READ decides; a signed 404 twice is the only licence to create again; an
   * account found bound to this service without a recorded create answer waits for an
   * operator (C2-b, auto-adoption by binding, is an open owner question — OQ-C2-01); and
   * only a definitive refusal is refunded, once.
   */
  describe('unknown outcomes on create', () => {
    const rounds = async (count: number) => {
      for (let round = 0; round < count; round += 1) {
        await ctx.container.database.db.execute(
          sql`UPDATE provisioning_operations SET next_attempt_at = now() - interval '1 hour'
               WHERE state IN ('PLANNED', 'UNKNOWN') AND next_attempt_at IS NOT NULL`,
        );
        await ctx.container.provisionerLoop.tick();
      }
    };
    const stalls = async (serviceId: string) =>
      (
        await ctx.container.database.db.execute<{ reason: string }>(
          sql`SELECT context->>'reason' AS reason FROM operational_events
               WHERE code = 'provisioning.stalled' AND context->>'serviceId' = ${serviceId}`,
        )
      ).rows.map((row) => row.reason);

    /** A sellable custom panel whose requests give up after one second. */
    async function quickPanel(): Promise<string> {
      await setFlag('custom_panel_provider', true);
      const created = await createPanel({ activation: { requestTimeoutMs: 1_000 } });
      await ctx.container.panels.testConnection(tenantA, owner, created.view.panel.id, {
        idempotencyKey: key(),
      });
      return created.view.panel.id;
    }

    it.each(['hang-after-apply', '500-after-apply', 'drop-after-apply'] as const)(
      'an answer lost after the bridge applied the create (%s): never refunded, never re-created, left for an operator',
      async (behaviour) => {
        const panelId = await quickPanel();
        bridge.behave('create', behaviour, 1);
        const orderId = await paidOrder(panelId, `lost-${behaviour}`);
        await ctx.container.provisionerLoop.tick();
        const service = await services.findByOrderId(tenantA, orderId);
        expect(service?.state).toBe('UNRECONCILED');
        expect((await operationOf(service?.id ?? '', 'PROVISION'))?.state).toBe('UNKNOWN');
        expect(await refunds()).toHaveLength(0);

        await rounds(6);
        expect(bridge.count('create'), 'a lost create was sent again').toBe(1);
        expect(bridge.accounts.size).toBe(1);
        expect(await refunds(), 'an UNKNOWN create was refunded').toHaveLength(0);
        // Found, bound to this service, and no create answer on record: not adopted.
        expect((await reload(service?.id ?? '')).state).toBe('UNRECONCILED');
        expect(await stalls(service?.id ?? '')).toContain('FOUND_WITHOUT_PROVENANCE');
      },
    );

    it('a 5xx before anything was applied: two signed 404s, then ONE new create, delivered', async () => {
      const panelId = await quickPanel();
      bridge.behave('create', '500-before-apply', 1);
      const orderId = await paidOrder(panelId, 'retry-after-absent');
      await ctx.container.provisionerLoop.tick();
      await rounds(6);
      const service = await services.findByOrderId(tenantA, orderId);
      expect(service?.state).toBe('ACTIVE');
      const creates = bridge.requests.filter((one) => one.route === 'create' && one.verified);
      expect(creates).toHaveLength(2);
      // A new create is a NEW operation: the lost one's id is never re-sent.
      expect(creates[0]?.body?.['operationId']).not.toBe(creates[1]?.body?.['operationId']);
      expect(bridge.count('get')).toBeGreaterThanOrEqual(2);
      expect(bridge.accounts.size).toBe(1);
      expect(await refunds()).toHaveLength(0);
    });

    it('a wrong base URL — every answer an unsigned 404 — is never "absent": no re-create, no refund', async () => {
      const panelId = await quickPanel();
      for (const route of ['create', 'get'] as const) bridge.behave(route, 'unsigned-404');
      const orderId = await paidOrder(panelId, 'wrong-url');
      await ctx.container.provisionerLoop.tick();
      await rounds(6);
      const service = await services.findByOrderId(tenantA, orderId);
      expect(service?.state).not.toBe('ACTIVE');
      expect(bridge.count('create'), 'an unsigned 404 licensed a second create').toBe(1);
      expect(await refunds(), 'an unsigned 404 was read as a refusal').toHaveLength(0);
    });

    it('an unknown error code is UNKNOWN — never refunded on its word', async () => {
      const panelId = await quickPanel();
      bridge.behave('create', 'unknown-code', 1);
      const orderId = await paidOrder(panelId, 'unknown-code');
      await ctx.container.provisionerLoop.tick();
      const service = await services.findByOrderId(tenantA, orderId);
      expect((await operationOf(service?.id ?? '', 'PROVISION'))?.state).toBe('UNKNOWN');
      expect(service?.state).toBe('UNRECONCILED');
      expect(await refunds()).toHaveLength(0);
    });

    it('a signed 422 RULE_REFUSED is definitive: refunded exactly once and never retried', async () => {
      const panelId = await quickPanel();
      bridge.behave('create', 'rule-refused');
      const orderId = await paidOrder(panelId, 'refused');
      await ctx.container.provisionerLoop.tick();
      const service = await services.findByOrderId(tenantA, orderId);
      expect((await operationOf(service?.id ?? '', 'PROVISION'))?.state).toBe('FAILED');
      expect(await refunds()).toHaveLength(1);
      await rounds(4);
      expect(bridge.count('create'), 'a refused create was retried').toBe(1);
      expect(await refunds(), 'refunded twice').toHaveLength(1);
    });

    it('an account under the name bound to ANOTHER ref is neither adopted nor absent', async () => {
      const panelId = await quickPanel();
      bridge.behave('create', '500-before-apply', 1);
      const orderId = await paidOrder(panelId, 'not-bound');
      await ctx.container.provisionerLoop.tick();
      const service = await services.findByOrderId(tenantA, orderId);
      const other = '00000000-0000-4000-8000-0000000000aa';
      bridge.seed({ username: service?.providerUsername ?? '', nexaRef: other });

      await rounds(6);
      expect((await reload(service?.id ?? '')).state).not.toBe('ACTIVE');
      expect(bridge.count('create'), 'a create was sent over somebody else’s account').toBe(1);
      expect(bridge.accounts.get(service?.providerUsername ?? '')?.nexaRef).toBe(other);
      expect(await refunds()).toHaveLength(0);
    });
  });

  describe('turning the flag off later', () => {
    it('stops NEW custom panels and leaves existing ones operating', async () => {
      const panelId = await readyPanel();
      await setFlag('custom_panel_provider', false);

      await expect(createPanel({ name: 'Bridge 2' })).rejects.toMatchObject({
        code: 'panel.provider_feature_disabled',
      });

      // The existing one is still tested, re-keyed and sold onto, and its services operated.
      await ctx.container.panels.setCredentials(tenantA, owner, panelId, {
        credentials: { apiToken: BRIDGE_SECRET },
        idempotencyKey: key(),
      });
      const tested = await ctx.container.panels.testConnection(tenantA, owner, panelId, {
        idempotencyKey: key(),
      });
      expect(tested.view.health?.state).toBe('HEALTHY');
      const service = await deliveredService(panelId, 'flag-off');
      await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'SUSPEND', {
        idempotencyKey: key(),
      });
      await ctx.container.provisionerLoop.tick();
      expect((await reload(service.id)).state).toBe('SUSPENDED');
    });
  });
});
