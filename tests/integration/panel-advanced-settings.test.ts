import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BYTES_PER_GB,
  COMMERCE_ERROR_CODES,
  EMPTY_PRODUCT_DISPLAY,
  PANEL_ERROR_CODES,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type OrderId,
  type PanelId,
  type PanelPolicy,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleOperationRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-operation.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import type { ServiceRecord } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import {
  adminPermissionOverrides,
  auditLogs,
  panelPolicies,
} from '../../apps/api/src/infrastructure/persistence/schema';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
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
 * WP-A8: a panel's advanced settings, through the shipped container.
 *
 * Against `tests/support/fake-rickpanel.ts`, the provider that declares the most — so
 * every customer action a policy can name is REAL here, and each refusal below is the
 * policy's rather than a capability's. What this suite holds:
 *
 *   - the write: permission, idempotency, the stale-revision refusal, the unsupported
 *     action refusal, the no-op, tenant isolation and the stopped scope;
 *   - the enforcement: at the one place each customer action is decided, inside its
 *     transaction, and NEVER for an operator's action on the same service;
 *   - the read: the registry, the customer availability, the diagnostics, and a
 *     technical view that carries no secret.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const CUSTOMER_TG = '940941';

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

const policyWith = (
  actions: PanelPolicy['actions'],
  mode: PanelPolicy['delivery']['mode'] = 'CARD_WITH_QR',
): PanelPolicy => ({ delivery: { mode }, actions });

describe('advanced provider settings', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[];
  let panel: FakeRickpanel;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let operations: DrizzleOperationRepository;
  let panelId: string;
  let productId: ProductId;
  let customerId: UserId;
  let owner: ActorContext;

  beforeAll(async () => {
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: Record<string, unknown>;
        try {
          body = raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>);
        } catch {
          body = { unparseable: raw };
        }
        sent.push({ url: request.url ?? '', body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 7 } }));
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

    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-adv', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Rick',
      providerType: 'rickpanel',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: {},
      idempotencyKey: 'panel-adv-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);

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
    productId = product.id;

    const resolved = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(CUSTOMER_TG),
      {
        idempotencyKey: `resolve-${CUSTOMER_TG}`,
        telegramUserId: CUSTOMER_TG,
        from: { id: Number(CUSTOMER_TG), first_name: 'سارا' },
        botInstanceId: BOT_A,
      },
    );
    customerId = resolved.customer.id;
    await ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: 'adv-fund',
      direction: 'CREDIT',
      amountMinor: 50_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
  });

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  const refusalOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as { code?: string; details?: Record<string, unknown> };
    }
    throw new Error('expected a refusal');
  };

  const setPolicy = async (
    policy: PanelPolicy,
    actor: ActorContext = owner,
    key = randomUUID(),
  ) => {
    const current = await ctx.container.panelAdvanced.advanced(tenantA, owner, panelId);
    return ctx.container.panelAdvanced.updatePolicy(tenantA, actor, panelId, {
      policy,
      expectedRevision: current.policy.revision,
      idempotencyKey: key,
    });
  };

  async function deliveredService(key: string): Promise<ServiceRecord> {
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(key), {
      idempotencyKey: `${key}-draft`,
      customerId,
      productId,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId,
      orderId: draft.id,
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), customerId, {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id,
    });
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, confirmed.id as OrderId);
    if (service === null || service.state !== 'ACTIVE') throw new Error('not provisioned');
    return service;
  }

  async function enableRotation(): Promise<void> {
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'customer_link_rotation',
      enabled: true,
      expectedVersion: null,
      confirmKey: 'customer_link_rotation',
      reason: 'let customers replace a leaked link',
      idempotencyKey: randomUUID(),
    });
  }

  async function offeredTraffic(key: string, gb: bigint, sortOrder = Number(gb)): Promise<string> {
    const created = await ctx.container.serviceAddons.create(tenantA, owner, {
      idempotencyKey: `${key}-addon`,
      draft: {
        kind: 'ADD_TRAFFIC',
        title: `${gb.toString()} GB`,
        sortOrder,
        specification: {
          kind: 'ADD_TRAFFIC',
          trafficBytes: gb * BYTES_PER_GB,
          durationDays: null,
        },
        price: money(10_000n * gb, 'IRT'),
        panelId: null,
        productId: null,
      },
    });
    await ctx.container.serviceAddons.activate(tenantA, owner, {
      idempotencyKey: `${key}-addon-on`,
      addonId: created.id,
    });
    return created.id;
  }

  async function offeredTime(key: string, days: number): Promise<string> {
    const created = await ctx.container.serviceAddons.create(tenantA, owner, {
      idempotencyKey: `${key}-addon`,
      draft: {
        kind: 'ADD_TIME',
        title: `${String(days)} days`,
        sortOrder: days,
        specification: { kind: 'ADD_TIME', trafficBytes: null, durationDays: days },
        price: money(1_000n * BigInt(days), 'IRT'),
        panelId: null,
        productId: null,
      },
    });
    await ctx.container.serviceAddons.activate(tenantA, owner, {
      idempotencyKey: `${key}-addon-on`,
      addonId: created.id,
    });
    return created.id;
  }

  const policyAudits = async () =>
    ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'panel.policy_update'), eq(auditLogs.entityId, panelId)));

  // -------------------------------------------------------------------------
  // the read
  // -------------------------------------------------------------------------

  it('derives the registry from the adapter and says what a customer is offered', async () => {
    const read = await ctx.container.panelAdvanced.advanced(tenantA, owner, panelId);
    const row = (name: string) => read.registry.find((entry) => entry.row === name);

    expect(read.registry.filter((entry) => entry.supported).map((entry) => entry.row)).toEqual([
      'CREATE_SERVICE',
      'RENEW',
      'ADD_TRAFFIC',
      'ADD_TIME',
      'DISABLE_ENABLE',
      'ROTATE_SUBSCRIPTION',
      'SUBSCRIPTION_FILES',
      'USAGE_READ',
      'TERMINATE',
    ]);
    expect(row('LOCATION_CHANGE')).toMatchObject({ supported: false, gap: 'NOT_IN_RELEASE' });
    expect(row('EXTRA_DEVICES')?.customer).toEqual({ available: false, blocker: 'UNSUPPORTED' });
    // Rotation is supported and needs the tenant switch as well.
    expect(row('ROTATE_SUBSCRIPTION')?.customer).toEqual({
      available: false,
      blocker: 'TENANT_FEATURE_OFF',
    });
    expect(row('RENEW')?.customer).toEqual({ available: true, blocker: null });
    // A row no customer acts on carries no customer verdict.
    expect(row('TERMINATE')?.customer).toBeNull();

    expect(read.policy).toMatchObject({ revision: 0, readable: true, updatedAt: null });
    expect(read.providerRules).toMatchObject({ trafficReset: 'NEVER', inbounds: 'PANEL_ASSIGNED' });
    expect(read.diagnostics.overall).toBe('OK');
    expect(read.diagnostics.lastSuccessfulCheckAt).not.toBeNull();
  });

  it('shows the owner a technical view that carries no secret, and refuses a technical role', async () => {
    await setPolicy(policyWith({ RENEW: { customerEnabled: false } }));
    const technical = await ctx.container.panelAdvanced.technical(tenantA, owner, panelId);
    expect(technical.descriptor.capabilities).toContain('ROTATE_SUBSCRIPTION_LINK');
    expect(technical.storedPolicy).toEqual(policyWith({ RENEW: { customerEnabled: false } }));
    expect(technical.credentialsSetAt.password).not.toBeNull();
    const serialized = JSON.stringify(technical);
    expect(serialized).not.toContain(panel.password);
    expect(serialized).not.toMatch(/ciphertext|keyId/i);

    const technicalRole = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'tech-adv', roleKeys: ['technical'] }),
    );
    expect(
      (await refusalOf(ctx.container.panelAdvanced.technical(tenantA, technicalRole, panelId)))
        .code,
    ).toBe('platform.permission_denied');
    /*
     * Codex #1 on PR #102: the key is ADDITIVE to `panels.view`. A role granted it
     * without `panels.view` would pass the endpoint and be refused the page it is on.
     */
    const supportRole = await createAdmin(ctx.container, tenantA, {
      username: 'tech-only-adv',
      roleKeys: ['support'],
    });
    await ctx.container.database.db.insert(adminPermissionOverrides).values({
      tenantId: tenantA.tenantId,
      adminId: supportRole.id,
      permissionKey: 'panels.technical.view',
      effect: 'GRANT',
      reason: 'Debugs an integration.',
      expiresAt: null,
    });
    expect(
      (
        await refusalOf(
          ctx.container.panelAdvanced.technical(tenantA, adminActorFor(supportRole), panelId),
        )
      ).details?.['permission'],
    ).toBe('panels.view');

    // The technical role still reads the Persian registry and diagnostics.
    await expect(
      ctx.container.panelAdvanced.advanced(tenantA, technicalRole, panelId),
    ).resolves.toMatchObject({ panelId });
  });

  // -------------------------------------------------------------------------
  // the write
  // -------------------------------------------------------------------------

  it('refuses a policy write without panels.edit, and audits the denial', async () => {
    const operator = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'op-adv', roleKeys: ['operator'] }),
    );
    const refused = await refusalOf(
      ctx.container.panelAdvanced.updatePolicy(tenantA, operator, panelId, {
        policy: policyWith({ RENEW: { customerEnabled: false } }),
        expectedRevision: 0,
        idempotencyKey: 'op-policy-1',
      }),
    );
    expect(refused.code).toBe('platform.permission_denied');
    const audits = await policyAudits();
    expect(audits.map((row) => row.result)).toEqual(['DENIED']);
    expect(
      (await ctx.container.panelAdvanced.advanced(tenantA, owner, panelId)).policy.revision,
    ).toBe(0);
  });

  it('refuses a policy naming an action this panel cannot perform', async () => {
    const refused = await refusalOf(
      setPolicy(policyWith({ EXTRA_DEVICES: { customerEnabled: true, maxDeviceLimit: 3 } })),
    );
    expect(refused.code).toBe(PANEL_ERROR_CODES.PANEL_POLICY_CAPABILITY_UNSUPPORTED);
    expect(refused.details?.['actions']).toEqual(['EXTRA_DEVICES']);
    expect(await ctx.container.database.db.select().from(panelPolicies)).toHaveLength(0);
  });

  it('replays one key, refuses its reuse with another policy, and refuses a stale revision', async () => {
    const policy = policyWith({ RENEW: { customerEnabled: false } });
    const body = { policy, expectedRevision: 0, idempotencyKey: 'policy-key-1' };
    const first = await ctx.container.panelAdvanced.updatePolicy(tenantA, owner, panelId, body);
    expect(first.changed).toBe(true);
    expect(first.advanced.policy.revision).toBe(1);

    const replay = await ctx.container.panelAdvanced.updatePolicy(tenantA, owner, panelId, body);
    expect(replay.changed, 'a replay reports what the first request did').toBe(true);
    expect(replay.advanced.policy.revision).toBe(1);

    const reused = await refusalOf(
      ctx.container.panelAdvanced.updatePolicy(tenantA, owner, panelId, {
        ...body,
        policy: policyWith({ RENEW: { customerEnabled: true } }),
      }),
    );
    expect(reused.code).toBe('platform.idempotency_payload_mismatch');

    // A colleague still holding revision 0 must not overwrite what they never saw.
    const stale = await refusalOf(
      ctx.container.panelAdvanced.updatePolicy(tenantA, owner, panelId, {
        policy: policyWith({ ADD_TIME: { customerEnabled: false, maxDays: null } }),
        expectedRevision: 0,
        idempotencyKey: 'policy-key-2',
      }),
    );
    expect(stale.code).toBe(PANEL_ERROR_CODES.PANEL_POLICY_STALE);

    const audits = await policyAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.after).toEqual({ revision: 1, policy });
  });

  it('answers a save of the policy in force as unchanged, and writes nothing', async () => {
    const same = await setPolicy(policyWith({}));
    expect(same.changed).toBe(false);
    expect(same.advanced.policy.revision).toBe(0);
    expect(await policyAudits()).toHaveLength(0);
  });

  it("keeps one tenant's policy away from another tenant's administrator", async () => {
    await setPolicy(policyWith({ RENEW: { customerEnabled: false } }));
    const ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-b-adv', roleKeys: ['owner'] }),
    );
    expect(
      (await refusalOf(ctx.container.panelAdvanced.advanced(tenantB, ownerB, panelId))).code,
    ).toBe(PANEL_ERROR_CODES.PANEL_NOT_FOUND);
    expect(
      (
        await refusalOf(
          ctx.container.panelAdvanced.updatePolicy(tenantB, ownerB, panelId, {
            policy: policyWith({}),
            expectedRevision: 1,
            idempotencyKey: 'b-policy',
          }),
        )
      ).code,
    ).toBe(PANEL_ERROR_CODES.PANEL_NOT_FOUND);
    expect(
      (await ctx.container.panelAdvanced.advanced(tenantA, owner, panelId)).policy.policy,
    ).toEqual(policyWith({ RENEW: { customerEnabled: false } }));
  });

  it('refuses a policy write while the tenant is stopped', async () => {
    await ctx.container.database.withClient((client) =>
      client.query(`UPDATE tenants SET status = 'STOPPED' WHERE id = $1`, [SEED_IDS.tenantA]),
    );
    try {
      const refused = await refusalOf(
        ctx.container.panelAdvanced.updatePolicy(tenantA, owner, panelId, {
          policy: policyWith({ RENEW: { customerEnabled: false } }),
          expectedRevision: 0,
          idempotencyKey: 'stopped-policy',
        }),
      );
      expect(refused.code).toBe('platform.tenant_not_found');
    } finally {
      await ctx.container.database.withClient((client) =>
        client.query(`UPDATE tenants SET status = 'ACTIVE' WHERE id = $1`, [SEED_IDS.tenantA]),
      );
    }
    expect(await ctx.container.database.db.select().from(panelPolicies)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // the enforcement
  // -------------------------------------------------------------------------

  it("withdraws a customer's rotation on this panel, and lengthens its cooldown", async () => {
    await enableRotation();
    const service = await deliveredService('rot');
    await setPolicy(
      policyWith({ ROTATE_SUBSCRIPTION: { customerEnabled: false, cooldownMinutes: null } }),
    );

    expect(await ctx.container.provisioning.customerRotationFor(tenantA, service)).toEqual({
      offered: false,
    });
    const refused = await refusalOf(
      ctx.container.provisioning.requestRotation(
        tenantA,
        systemActor('r1'),
        customerId,
        service.id,
        {
          idempotencyKey: 'rot-1',
        },
      ),
    );
    expect(refused.code).toBe(COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE);
    expect(refused.details).toMatchObject({
      reason: 'CUSTOMER_POLICY',
      action: 'ROTATE_SUBSCRIPTION',
    });
    const rotations = async () =>
      (await operations.listForService(tenantA, service.id, 50)).filter(
        (operation) => operation.type === 'ROTATE_SUBSCRIPTION',
      );
    expect(await rotations()).toHaveLength(0);
    expect(panel.revokeCalls()).toBe(0);

    // Back on, with a panel floor far above the tenant's 24 hours.
    await setPolicy(
      policyWith({ ROTATE_SUBSCRIPTION: { customerEnabled: true, cooldownMinutes: 43_200 } }),
    );
    expect(await ctx.container.provisioning.customerRotationFor(tenantA, service)).toEqual({
      offered: true,
      cooldownHours: 720,
    });
    await ctx.container.provisioning.requestRotation(
      tenantA,
      systemActor('r2'),
      customerId,
      service.id,
      {
        idempotencyKey: 'rot-2',
      },
    );
    await ctx.container.provisionerLoop.tick();
    const [done] = await rotations();
    expect(done?.state).toBe('SUCCEEDED');

    const again = await refusalOf(
      ctx.container.provisioning.requestRotation(
        tenantA,
        systemActor('r3'),
        customerId,
        service.id,
        {
          idempotencyKey: 'rot-3',
        },
      ),
    );
    expect(again.code).toBe(COMMERCE_ERROR_CODES.SERVICE_ROTATION_COOLDOWN);
    const availableAt = new Date(String(again.details?.['availableAt'])).getTime();
    const requestedAt = done?.createdAt.getTime() ?? 0;
    expect(availableAt - requestedAt).toBeGreaterThan(24 * 3_600_000);
  });

  it("refuses a customer's suspend on this panel and leaves the operator's alone", async () => {
    const service = await deliveredService('sus');
    await setPolicy(policyWith({ DISABLE_ENABLE: { customerEnabled: false } }));

    expect(await ctx.container.provisioning.customerActionsFor(tenantA, service)).toEqual([]);
    const refused = await refusalOf(
      ctx.container.provisioning.requestFromCustomer(
        tenantA,
        systemActor('c-sus'),
        customerId,
        service.id,
        'SUSPEND',
        { idempotencyKey: 'c-sus-1' },
      ),
    );
    expect(refused.details).toMatchObject({ reason: 'CUSTOMER_POLICY' });

    // The policy is about what customers are offered. An operator still acts.
    const planned = await ctx.container.provisioning.requestFromOperator(
      tenantA,
      owner,
      service.id,
      'SUSPEND',
      { idempotencyKey: 'op-sus-1' },
    );
    expect(planned.type).toBe('SUSPEND');
  });

  it('refuses a renewal switched off after the draft, before any money moves', async () => {
    const service = await deliveredService('ren');
    expect(
      await ctx.container.commercialActions.availableFor(tenantA, systemActor('a'), service),
    ).toContain('RENEW');
    const { order } = await ctx.container.commercialActions.draft(
      tenantA,
      systemActor('ren-draft'),
      customerId,
      { serviceId: service.id, kind: 'RENEW', idempotencyKey: 'ren-action-draft' },
    );

    await setPolicy(policyWith({ RENEW: { customerEnabled: false } }));
    expect(
      await ctx.container.commercialActions.availableFor(tenantA, systemActor('b'), service),
    ).not.toContain('RENEW');
    const refused = await refusalOf(
      ctx.container.commercialActions.confirm(tenantA, systemActor('ren-confirm'), customerId, {
        orderId: order.id,
        idempotencyKey: 'ren-action-confirm',
      }),
    );
    expect(refused.code).toBe(COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE);
    // Nothing moved: the order is still the draft it was, so no payment can be taken.
    expect((await ctx.container.orders.get(tenantA, owner, order.id)).state).toBe('DRAFT');
    expect(
      (
        await refusalOf(
          ctx.container.commercialActions.draft(tenantA, systemActor('ren-2'), customerId, {
            serviceId: service.id,
            kind: 'RENEW',
            idempotencyKey: 'ren-draft-2',
          }),
        )
      ).code,
    ).toBe(COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE);
  });

  it('offers only the traffic packages under the panel cap', async () => {
    const service = await deliveredService('cap');
    const small = await offeredTraffic('small', 10n);
    const large = await offeredTraffic('large', 100n);
    await setPolicy(policyWith({ ADD_TRAFFIC: { customerEnabled: true, maxTrafficGb: 50 } }));

    const offer = await ctx.container.commercialActions.offer(
      tenantA,
      systemActor('cap-offer'),
      customerId,
      service.id,
      'ADD_TRAFFIC',
    );
    expect(offer.addons.map((addon) => addon.id)).toEqual([small]);
    const refused = await refusalOf(
      ctx.container.commercialActions.draft(tenantA, systemActor('cap-draft'), customerId, {
        serviceId: service.id,
        kind: 'ADD_TRAFFIC',
        addonId: large,
        idempotencyKey: 'cap-draft-large',
      }),
    );
    expect(refused.code).toBe(COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE);
    await expect(
      ctx.container.commercialActions.draft(tenantA, systemActor('cap-draft-2'), customerId, {
        serviceId: service.id,
        kind: 'ADD_TRAFFIC',
        addonId: small,
        idempotencyKey: 'cap-draft-small',
      }),
    ).resolves.toMatchObject({ action: { kind: 'ADD_TRAFFIC' } });
  });

  /*
   * Codex #1 on PR #102: the cap was applied AFTER the first page was read, so a page of
   * ten packages over the cap hid an eleventh that fits, and both the offer and the
   * button said nothing was on sale.
   */
  it('finds a package under the cap behind a full page of packages over it', async () => {
    const service = await deliveredService('page');
    for (let index = 1; index <= 10; index += 1) {
      await offeredTraffic(`big-${String(index)}`, 100n, index);
    }
    const fits = await offeredTraffic('fits', 10n, 11);
    await setPolicy(policyWith({ ADD_TRAFFIC: { customerEnabled: true, maxTrafficGb: 50 } }));

    expect(
      await ctx.container.commercialActions.availableFor(tenantA, systemActor('page-a'), service),
    ).toContain('ADD_TRAFFIC');
    const offer = await ctx.container.commercialActions.offer(
      tenantA,
      systemActor('page-offer'),
      customerId,
      service.id,
      'ADD_TRAFFIC',
    );
    expect(offer.addons.map((addon) => addon.id)).toEqual([fits]);
  });

  /*
   * Codex #2 on PR #102: each cap binds only its own kind. A time package has no bytes and
   * a traffic package no days, so a cap applied across kinds hid every package of the
   * other kind, through the offer and the button alike.
   */
  it('lets a traffic cap leave time packages alone, and a time cap leave traffic ones', async () => {
    const service = await deliveredService('kinds');
    const traffic = await offeredTraffic('kinds-traffic', 10n);
    const time = await offeredTime('kinds-time', 30);
    const offered = async (kind: 'ADD_TRAFFIC' | 'ADD_TIME') =>
      (
        await ctx.container.commercialActions.offer(
          tenantA,
          systemActor(`kinds-${kind}`),
          customerId,
          service.id,
          kind,
        )
      ).addons.map((addon) => addon.id);

    await setPolicy(policyWith({ ADD_TRAFFIC: { customerEnabled: true, maxTrafficGb: 50 } }));
    expect(await offered('ADD_TIME')).toEqual([time]);
    expect(
      await ctx.container.commercialActions.availableFor(tenantA, systemActor('k1'), service),
    ).toEqual(expect.arrayContaining(['ADD_TRAFFIC', 'ADD_TIME']));

    await setPolicy(policyWith({ ADD_TIME: { customerEnabled: true, maxDays: 60 } }));
    expect(await offered('ADD_TRAFFIC')).toEqual([traffic]);
    expect(
      await ctx.container.commercialActions.availableFor(tenantA, systemActor('k2'), service),
    ).toEqual(expect.arrayContaining(['ADD_TRAFFIC', 'ADD_TIME']));
  });

  /*
   * Codex #1 on PR #102: an entry for an action the adapter no longer supports — stored
   * while it did — is kept through a save of an unrelated field, and only a CHANGE to it
   * is refused. RickPanel has no extra-users capability, so a row naming one stands for
   * a capability that has since disappeared.
   */
  it('keeps a stored restriction on an action the panel no longer supports', async () => {
    const orphan = { customerEnabled: false, maxDeviceLimit: null };
    await ctx.container.database.db.insert(panelPolicies).values({
      tenantId: tenantA.tenantId,
      panelId,
      policy: policyWith({ EXTRA_DEVICES: orphan }),
      revision: 1,
    });

    const saved = await ctx.container.panelAdvanced.updatePolicy(tenantA, owner, panelId, {
      policy: policyWith({ EXTRA_DEVICES: orphan, RENEW: { customerEnabled: false } }),
      expectedRevision: 1,
      idempotencyKey: 'keep-orphan',
    });
    expect(saved.changed).toBe(true);
    expect(saved.advanced.policy.policy.actions).toEqual({
      EXTRA_DEVICES: orphan,
      RENEW: { customerEnabled: false },
    });

    const changed = await refusalOf(
      ctx.container.panelAdvanced.updatePolicy(tenantA, owner, panelId, {
        policy: policyWith({
          EXTRA_DEVICES: { customerEnabled: false, maxDeviceLimit: 3 },
          RENEW: { customerEnabled: false },
        }),
        expectedRevision: 2,
        idempotencyKey: 'change-orphan',
      }),
    );
    expect(changed.code).toBe(PANEL_ERROR_CODES.PANEL_POLICY_CAPABILITY_UNSUPPORTED);
    expect(changed.details?.['actions']).toEqual(['EXTRA_DEVICES']);
  });

  it('delivers the card as text, with no photo, on a CARD_TEXT panel', async () => {
    await setPolicy(policyWith({}, 'CARD_TEXT'));
    sent = [];
    const service = await deliveredService('txt');
    expect(service.deliveryState).toBe('DELIVERED');
    expect(sent.filter((one) => one.url.includes('/sendPhoto'))).toHaveLength(0);
    const delivered = sent.filter(
      (one) =>
        one.url.includes('/sendMessage') &&
        String(one.body['text'] ?? '').includes(service.subscriptionUrl ?? '\u0000'),
    );
    expect(delivered).toHaveLength(1);
  });

  it('refuses every customer action on a panel whose stored policy does not parse', async () => {
    await enableRotation();
    const service = await deliveredService('bad');
    await ctx.container.database.db.execute(
      sql`INSERT INTO panel_policies (tenant_id, panel_id, policy, revision)
          VALUES (${tenantA.tenantId}, ${panelId}, ${'{"delivery":{"mode":"CARD_WITH_QR"},"actions":{"RENEW":{"customerEnabled":"sometimes"}}}'}::jsonb, 1)`,
    );
    const read = await ctx.container.panelAdvanced.advanced(tenantA, owner, panelId);
    expect(read.policy.readable).toBe(false);
    expect(read.registry.find((entry) => entry.row === 'RENEW')?.customer).toEqual({
      available: false,
      blocker: 'POLICY_UNREADABLE',
    });
    expect(
      await ctx.container.commercialActions.availableFor(tenantA, systemActor('x'), service),
    ).toEqual([]);
    expect(await ctx.container.provisioning.customerRotationFor(tenantA, service)).toEqual({
      offered: false,
    });
    expect(await ctx.container.subscriptionFiles.offered(tenantA, service)).toBe(false);
  });
});
