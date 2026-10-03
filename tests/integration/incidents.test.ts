import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  isNexaError,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type CreateIncidentRequest,
  type PanelId,
  type PaymentGatewayConfig,
  type ProductCategoryId,
  type ProductId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import {
  IncidentService,
  type IncidentServiceDeps,
} from '../../apps/api/src/modules/platform/incidents/application/incident.service';
import { DrizzleServiceLocationRepository } from '../../apps/api/src/modules/commerce/locations/infrastructure/drizzle-service-location.repository';
import { createIncidentRequestSchema, updateIncidentRequestSchema } from '@nexa/contracts';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Phase E3 — incidents and maintenance, against a real PostgreSQL and the REAL owning
 * modules: every effect below is a real panel drain, product deactivation, location switch
 * or gateway status change made through that module's own service, and every assertion
 * about scope reads the module's own state. Customer notices go through the real customer
 * notification lane to a socket standing in for Telegram.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
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

const systemActor = (k: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'incident:test',
  surface: 'TELEGRAM',
  correlationId: k as CorrelationId,
});

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isNexaError(error)) return { kind: error.kind, code: error.code, details: error.details };
    throw error;
  }
  throw new Error('Expected a refusal.');
}

describe('Phase E3 — incidents and maintenance', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[];
  let owner: ActorContext;
  let support: ActorContext;
  let operator: ActorContext;
  let n = 0;
  const key = () => `incident-key-${String((n += 1))}`;

  beforeAll(async () => {
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = {};
        }
        sent.push({ url: request.url ?? '', body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    ctx = await createTestContext({
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    telegram.closeAllConnections();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    sent = [];
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-inc', roleKeys: ['owner'] }),
    );
    support = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'support-inc', roleKeys: ['support'] }),
    );
    operator = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'operator-inc',
        roleKeys: ['operator'],
      }),
    );
  });

  // --- fixtures ----------------------------------------------------------------------------

  async function panel(
    name: string,
    scope: TenantContext = tenantA,
    actor: ActorContext = owner,
  ): Promise<string> {
    const created = await ctx.container.panels.create(scope, actor, {
      name,
      providerType: 'marzban',
      baseUrl: `https://${name.toLowerCase()}.example.test`,
      idempotencyKey: key(),
    });
    await makePanelSellable(ctx.container, scope, created.view.panel.id);
    return created.view.panel.id;
  }
  const sellable = async (panelId: string) =>
    (await ctx.container.panels.get(tenantA, owner, panelId)).sellability;
  const drainOf = async (panelId: string) =>
    (await ctx.container.panels.get(tenantA, owner, panelId)).panel.drain;

  async function product(panelId: string, title = 'پلن'): Promise<string> {
    const products = new DrizzleProductRepository(ctx.container.database.db);
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title,
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 0n, deviceLimit: 1 },
        price: money(100_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return created.id;
  }
  const productStatus = async (id: string) =>
    (
      await new DrizzleProductRepository(ctx.container.database.db).findById(
        tenantA,
        id as ProductId,
      )
    )?.status;

  async function location(panelId: string, locationKey: string): Promise<string> {
    const saved = await ctx.container.serviceLocations.create(tenantA, owner, {
      idempotencyKey: key(),
      location: {
        panelId,
        productId: null,
        locationKey,
        label: locationKey,
        initial: false,
        enabled: true,
        price: { amountMinor: 1_000n, currency: 'IRT' },
        limits: { cooldownHours: null, maxChanges: null, periodDays: null },
        sortOrder: 1,
      },
    });
    return saved.location.id;
  }
  const locationEnabled = async (id: string) =>
    (
      await rows<{ enabled: boolean }>(sql`SELECT enabled FROM service_locations WHERE id = ${id}`)
    )[0]?.enabled;

  async function gateway(): Promise<void> {
    await ctx.container.paymentGateways.configure(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'CENTRALPAY',
      config: OPEN_ROUTE,
    });
    await ctx.container.paymentGateways.setCredential(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'CENTRALPAY',
      apiKey: 'cp_link_key_for_incident_tests',
    });
    await ctx.container.paymentGateways.setVerifyKey(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'CENTRALPAY',
      verifyKey: 'cp_verify_key_for_incident_tests',
    });
    await ctx.container.paymentGateways.setStatus(tenantA, owner, {
      idempotencyKey: key(),
      provider: 'CENTRALPAY',
      status: 'ACTIVE',
    });
  }
  const gatewayStatus = async () =>
    (
      await rows<{ status: string }>(
        sql`SELECT status FROM payment_gateways WHERE provider = 'CENTRALPAY' AND tenant_id = ${tenantA.tenantId}`,
      )
    )[0]?.status;

  async function customerWithService(telegramUserId: string, panelId: string): Promise<string> {
    const { customer } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(`r-${telegramUserId}`),
      {
        idempotencyKey: `resolve-inc-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'مریم' },
        botInstanceId: BOT_A,
      },
    );
    const productId = await product(panelId, `پلن ${telegramUserId}`);
    const k = key();
    const order = await ctx.container.orders.createDraft(tenantA, systemActor(k), {
      idempotencyKey: k,
      customerId: customer.id as UserId,
      productId: productId as ProductId,
    });
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
                            provider_username, subscription_ref, provider_client_id,
                            traffic_limit_bytes, state, provisioned_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customer.id}, ${order.id}, ${panelId}, ${productId},
              ${'u' + id.replace(/-/g, '').slice(0, 12)}, ${id.replace(/-/g, '').slice(0, 32)},
              ${ctx.container.ids.uuid()}, 0, 'ACTIVE', now())`);
    return customer.id;
  }

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return ((await ctx.container.database.db.execute(query as never)) as unknown as { rows: T[] })
      .rows;
  }
  const count = async (query: ReturnType<typeof sql>) =>
    Number((await rows<{ n: number }>(query))[0]?.n ?? 0);

  const create = (
    input: Partial<CreateIncidentRequest> = {},
    actor: ActorContext = owner,
    scope: TenantContext = tenantA,
  ) =>
    ctx.container.incidents.create(
      scope,
      actor,
      createIncidentRequestSchema.parse({
        idempotencyKey: key(),
        kind: 'MAINTENANCE',
        severity: 'MAJOR',
        title: 'به‌روزرسانی پنل آلمان',
        customerMessage: 'سرویس‌های آلمان امشب ۳۰ دقیقه قطع می‌شوند.',
        ...input,
      }),
    );
  const action = (incident: { incident: { id: string; version: number } }) => ({
    idempotencyKey: key(),
    expectedVersion: incident.incident.version,
  });
  const timeline = async (id: string) =>
    (await ctx.container.incidents.get(tenantA, owner, id)).timeline.map((e) => e.kind);

  // --- scope is precise --------------------------------------------------------------------

  it('stops new sales on exactly the panel it names, and restores it on resolution', async () => {
    const affected = await panel('Frankfurt');
    const untouched = await panel('Amsterdam');
    const started = await create({ stopSales: true, targets: [{ kind: 'PANEL', ref: affected }] });
    expect(started.incident.status).toBe('ACTIVE');
    expect(started.effects).toEqual([
      expect.objectContaining({ kind: 'PANEL_DRAIN', subjectRef: affected, state: 'APPLIED' }),
    ]);
    expect(await sellable(affected)).toMatchObject({ sellable: false, reason: 'DRAINING' });
    expect(await sellable(untouched)).toMatchObject({ sellable: true });
    expect((await drainOf(affected))?.reason).toBe(`incident:${started.incident.id}`);
    // The drain went through the panel module itself: its own audit row, as the operator.
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'panel.drain' AND entity_id = ${affected} AND actor_id = ${owner.id}`,
      ),
    ).toBe(1);

    const resolved = await ctx.container.incidents.resolve(
      tenantA,
      owner,
      started.incident.id,
      action(started),
    );
    expect(resolved.incident.status).toBe('RESOLVED');
    expect(resolved.effects[0]?.state).toBe('REVERTED');
    expect(await sellable(affected)).toMatchObject({ sellable: true });
    expect(await timeline(started.incident.id)).toEqual([
      'CREATED',
      'STARTED',
      'EFFECT',
      'RESOLVED',
      'EFFECT',
    ]);
  });

  it('re-applies after an edit took the stop off: a new version is a new command, never a replay', async () => {
    const affected = await panel('Frankfurt');
    const started = await create({ stopSales: true, targets: [{ kind: 'PANEL', ref: affected }] });
    const edit = (version: number, stopSales: boolean) =>
      ctx.container.incidents.update(
        tenantA,
        owner,
        started.incident.id,
        updateIncidentRequestSchema.parse({
          idempotencyKey: key(),
          expectedVersion: version,
          kind: started.incident.kind,
          severity: started.incident.severity,
          title: started.incident.title,
          stopSales,
          targets: [{ kind: 'PANEL', ref: affected }],
        }),
      );
    const off = await edit(started.incident.version, false);
    expect(off.effects[0]?.state).toBe('REVERTED');
    expect(await sellable(affected)).toMatchObject({ sellable: true });

    const on = await edit(off.incident.version, true);
    expect(on.effects[0]?.state).toBe('APPLIED');
    // The panel is drained AGAIN — recorded APPLIED and actually in force.
    expect(await sellable(affected)).toMatchObject({ sellable: false, reason: 'DRAINING' });
    expect((await drainOf(affected))?.reason).toBe(`incident:${started.incident.id}`);
  });

  // --- review of #162 ------------------------------------------------------------------------

  /** The container's service with its effects port wrapped: a test can hold a module call. */
  function heldService(): {
    service: IncidentService;
    reached: Promise<void>;
    release: () => void;
  } {
    const deps = (ctx.container.incidents as unknown as { deps: IncidentServiceDeps }).deps;
    const real = deps.effects;
    let onReached: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => (onReached = resolve));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const service = new IncidentService({
      ...deps,
      effects: {
        resolve: (scope, target) => real.resolve(scope, target),
        panelOfLocation: (scope, id) => real.panelOfLocation(scope, id),
        status: (scope, kind, subject) => real.status(scope, kind, subject),
        set: async (scope, actor, input) => {
          onReached();
          await gate;
          return real.set(scope, actor, input);
        },
      },
    });
    return { service, reached, release };
  }
  const versionOf = async (id: string) =>
    (await ctx.container.incidents.get(tenantA, owner, id)).incident.version;
  const resolveNow = async (id: string) =>
    ctx.container.incidents.resolve(tenantA, owner, id, {
      idempotencyKey: key(),
      expectedVersion: await versionOf(id),
    });

  it('overlapping incidents on one panel: the first to end hands the drain over, the last restores it', async () => {
    const p = await panel('Frankfurt');
    const first = await create({ stopSales: true, targets: [{ kind: 'PANEL', ref: p }] });
    const second = await create({ stopSales: true, targets: [{ kind: 'PANEL', ref: p }] });
    expect(first.effects[0]?.state).toBe('APPLIED');
    expect(second.effects[0]?.state).toBe('ALREADY');

    const ended = await resolveNow(first.incident.id);
    expect(ended.effects[0]?.state).toBe('HANDED_OVER');
    // The second incident still wants it: the panel stays withdrawn, and it owns it now.
    expect(await sellable(p)).toMatchObject({ sellable: false, reason: 'DRAINING' });
    expect(
      (await ctx.container.incidents.get(tenantA, owner, second.incident.id)).effects[0]?.state,
    ).toBe('APPLIED');

    // Its drain still carries the first incident's marker, which the hand-over vouches for.
    const last = await resolveNow(second.incident.id);
    expect(last.effects[0]?.state).toBe('REVERTED');
    expect(await sellable(p)).toMatchObject({ sellable: true });
  });

  it('overlapping incidents on one product: the withdrawal holds until the last one ends', async () => {
    const productId = await product(await panel('Frankfurt'));
    const first = await create({ stopSales: true, targets: [{ kind: 'PRODUCT', ref: productId }] });
    const second = await create({
      stopSales: true,
      targets: [{ kind: 'PRODUCT', ref: productId }],
    });
    await resolveNow(first.incident.id);
    expect(await productStatus(productId)).toBe('INACTIVE');
    await resolveNow(second.incident.id);
    expect(await productStatus(productId)).toBe('ACTIVE');
  });

  it('two incidents claiming one subject at once: one applies, the other waits and finds it applied', async () => {
    const p = await panel('Frankfurt');
    const [a, b] = await Promise.all([
      create({ stopSales: true, targets: [{ kind: 'PANEL', ref: p }] }),
      create({ stopSales: true, targets: [{ kind: 'PANEL', ref: p }] }),
    ]);
    expect([a.effects[0]?.state, b.effects[0]?.state].sort()).toEqual(['ALREADY', 'APPLIED']);
    // Whichever order they end in, the panel sells again only after both.
    await resolveNow(b.incident.id);
    expect(await sellable(p)).toMatchObject({ sellable: false, reason: 'DRAINING' });
    await resolveNow(a.incident.id);
    expect(await sellable(p)).toMatchObject({ sellable: true });
  });

  it('a second incident waits while the first holds the subject, then finds it withdrawn', async () => {
    const p = await panel('Frankfurt');
    const held = heldService();
    const first = held.service.create(
      tenantA,
      owner,
      createIncidentRequestSchema.parse({
        idempotencyKey: key(),
        kind: 'INCIDENT',
        severity: 'MAJOR',
        title: 'اول',
        stopSales: true,
        targets: [{ kind: 'PANEL', ref: p }],
      }),
    );
    await held.reached;
    // The first incident's drain is claimed and in flight; the second asks for the same panel.
    const second = create({ stopSales: true, targets: [{ kind: 'PANEL', ref: p }] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    held.release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.effects[0]?.state).toBe('APPLIED');
    // Not a second APPLIED: two owners would each restore the panel at their own end.
    expect(b.effects[0]?.state).toBe('ALREADY');
  });

  it('adopts a withdrawal whose incident ended without restoring it, and restores it at its own end', async () => {
    const p = await panel('Frankfurt');
    const orphaned = await create({ stopSales: true, targets: [{ kind: 'PANEL', ref: p }] });
    // A process that resolved the incident and died before its restore pass.
    await ctx.container.database.db.execute(
      sql`UPDATE incidents SET status = 'RESOLVED', resolved_at = now() WHERE id = ${orphaned.incident.id}`,
    );
    const next = await create({ stopSales: true, targets: [{ kind: 'PANEL', ref: p }] });
    expect(next.effects[0]?.state).toBe('APPLIED');
    expect(
      (await ctx.container.incidents.get(tenantA, owner, orphaned.incident.id)).effects[0]?.state,
    ).toBe('HANDED_OVER');
    await resolveNow(next.incident.id);
    expect(await sellable(p)).toMatchObject({ sellable: true });
  });

  it('a resolution that lands while an effect is being applied still restores it', async () => {
    const p = await panel('Frankfurt');
    const held = heldService();
    const creating = held.service.create(
      tenantA,
      owner,
      createIncidentRequestSchema.parse({
        idempotencyKey: key(),
        kind: 'INCIDENT',
        severity: 'MAJOR',
        title: 'قطعی',
        stopSales: true,
        targets: [{ kind: 'PANEL', ref: p }],
      }),
    );
    await held.reached;
    // The effect is claimed PENDING and its module call is held: resolve now.
    const [row] = await rows<{ id: string }>(sql`SELECT id FROM incidents`);
    const resolved = await resolveNow(row!.id);
    expect(resolved.incident.status).toBe('RESOLVED');
    held.release();
    const view = await creating;
    expect(view.effects[0]?.state).toBe('REVERTED');
    expect(await sellable(p)).toMatchObject({ sellable: true });
  });

  it('keeps "effects pending" open while an effect FAILED, and closes it once all are in force', async () => {
    const p = await panel('Frankfurt');
    const startAt = new Date(Date.now() + 1_000);
    const scheduled = await create({
      stopSales: true,
      targets: [{ kind: 'PANEL', ref: p }],
      scheduledStartAt: startAt.toISOString(),
    });
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await ctx.container.incidentSchedulerLoop.tick();
    const pending = async () =>
      (
        await ctx.container.notificationCenter.list(tenantA, owner, {
          limit: 50,
          unreadOnly: false,
          before: null,
        })
      ).find((x) => x.code === 'maintenance.effects_pending');
    expect((await pending())?.resolvedAt).toBeNull();

    // The operator holds no `panels.drain`: the drain FAILED, so nothing is in force yet.
    const tried = await ctx.container.incidents.applyEffects(
      tenantA,
      operator,
      scheduled.incident.id,
    );
    expect(tried.effects[0]?.state).toBe('FAILED');
    expect((await pending())?.resolvedAt).toBeNull();

    await ctx.container.incidents.applyEffects(tenantA, owner, scheduled.incident.id);
    expect((await pending())?.resolvedAt).not.toBeNull();
  });

  it('expires a queued notice for a customer who stays blocked once the incident ends', async () => {
    const affected = await panel('Frankfurt');
    const customerId = await customerWithService('974101', affected);
    const started = await create({ targets: [{ kind: 'PANEL', ref: affected }] });
    const preview = await ctx.container.incidents.noticePreview(
      tenantA,
      owner,
      started.incident.id,
    );
    await ctx.container.incidents.notify(tenantA, owner, started.incident.id, {
      idempotencyKey: key(),
      expectedVersion: preview.version,
      expectedRecipients: 1,
    });
    await ctx.container.customers.block(tenantA, owner, {
      idempotencyKey: key(),
      customerId,
      reason: 'spam',
    });
    await ctx.container.customerNotificationLoop.tick();
    const state = async () =>
      (
        await rows<{ state: string }>(
          sql`SELECT state FROM customer_notifications WHERE kind = 'INCIDENT_NOTICE'`,
        )
      )[0]?.state;
    expect(await state()).toBe('PENDING');
    await resolveNow(started.incident.id);
    await ctx.container.customerNotificationLoop.tick();
    expect(await state()).toBe('SUPERSEDED');
    expect(sent.filter((x) => x.url.endsWith('/sendMessage'))).toHaveLength(0);
  });

  it('counts no customer whose bot is not ACTIVE', async () => {
    const affected = await panel('Frankfurt');
    await customerWithService('974201', affected);
    const started = await create({ targets: [{ kind: 'PANEL', ref: affected }] });
    expect(
      (await ctx.container.incidents.noticePreview(tenantA, owner, started.incident.id)).recipients,
    ).toBe(1);
    await ctx.container.database.db.execute(
      sql`UPDATE bot_instances SET status = 'STOPPED' WHERE id = ${BOT_A}`,
    );
    try {
      expect(
        (await ctx.container.incidents.noticePreview(tenantA, owner, started.incident.id))
          .recipients,
      ).toBe(0);
    } finally {
      await ctx.container.database.db.execute(
        sql`UPDATE bot_instances SET status = 'ACTIVE' WHERE id = ${BOT_A}`,
      );
    }
  });

  it('pages the list by a keyset cursor: every incident once, newest first', async () => {
    for (let i = 0; i < 52; i += 1) await create({ title: `رخداد ${String(i)}` });
    const first = await ctx.container.incidents.list(tenantA, owner);
    expect(first.incidents).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await ctx.container.incidents.list(tenantA, owner, first.nextCursor);
    expect(second.incidents).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.incidents, ...second.incidents].map((v) => v.incident.id);
    expect(new Set(ids).size).toBe(52);
  });

  it('answers a malformed incident id NOT_FOUND, never a database error', async () => {
    for (const id of ['-'.repeat(36), '0'.repeat(36)]) {
      expect((await refusal(ctx.container.incidents.get(tenantA, owner, id))).code).toBe(
        'incident.not_found',
      );
    }
  });

  it('switches a location off without overwriting an edit that committed meanwhile', async () => {
    const p = await panel('Frankfurt');
    const loc = await location(p, 'fra-2');
    const locations = new DrizzleServiceLocationRepository(ctx.container.database.db);
    let releaseEdit: () => void = () => undefined;
    const editHeld = new Promise<void>((resolve) => (releaseEdit = resolve));
    let onLocked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => (onLocked = resolve));
    // An operator's edit holds the location lock, renames the row, and commits a moment later.
    const editing = ctx.container.uow.run(tenantA, async (tx) => {
      await locations.lockForWrite(tenantA, tx);
      await tx.tx.execute(sql`UPDATE service_locations SET label = 'renamed' WHERE id = ${loc}`);
      onLocked();
      await editHeld;
    });
    await locked;
    const starting = create({ stopSales: true, targets: [{ kind: 'LOCATION', ref: loc }] });
    await new Promise((resolve) => setTimeout(resolve, 400));
    releaseEdit();
    await editing;
    await starting;
    const [row] = await rows<{ label: string; enabled: boolean }>(
      sql`SELECT label, enabled FROM service_locations WHERE id = ${loc}`,
    );
    expect(row).toEqual({ label: 'renamed', enabled: false });
  });

  it('refuses a confirmation on the affected panel before any money moves, and confirms elsewhere', async () => {
    const affected = await panel('Frankfurt');
    const untouched = await panel('Amsterdam');
    const { customer } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor('rc'),
      {
        idempotencyKey: 'resolve-inc-buyer',
        telegramUserId: '972001',
        from: { id: 972001, first_name: 'علی' },
        botInstanceId: BOT_A,
      },
    );
    const blockedProduct = await product(affected, 'آلمان');
    const openProduct = await product(untouched, 'هلند');
    await create({ stopSales: true, targets: [{ kind: 'PANEL', ref: affected }] });
    const orderFor = async (productId: string) => {
      const k = key();
      const draft = await ctx.container.orders.createDraft(tenantA, systemActor(k), {
        idempotencyKey: `${k}-d`,
        customerId: customer.id as UserId,
        productId: productId as ProductId,
      });
      return ctx.container.orders.confirm(tenantA, systemActor(k), {
        idempotencyKey: `${k}-c`,
        customerId: customer.id as UserId,
        orderId: draft.id,
      });
    };
    await expect(orderFor(blockedProduct)).rejects.toBeDefined();
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM payments WHERE tenant_id = ${tenantA.tenantId}`,
      ),
    ).toBe(0);
    expect((await orderFor(openProduct)).state).toBe('AWAITING_PAYMENT');
  });

  it('withdraws exactly the product, the location and the gateway it names — through their modules', async () => {
    const p1 = await panel('Frankfurt');
    const affectedProduct = await product(p1, 'آلمان');
    const otherProduct = await product(p1, 'آلمان ویژه');
    const affectedLocation = await location(p1, 'de');
    const otherLocation = await location(p1, 'nl');
    await gateway();
    const started = await create({
      kind: 'INCIDENT',
      stopSales: true,
      targets: [
        { kind: 'PRODUCT', ref: affectedProduct },
        { kind: 'LOCATION', ref: affectedLocation },
        { kind: 'GATEWAY', ref: 'CENTRALPAY' },
      ],
    });
    expect(started.effects.map((e) => [e.kind, e.state]).sort()).toEqual([
      ['GATEWAY_DISABLE', 'APPLIED'],
      ['LOCATION_DISABLE', 'APPLIED'],
      ['PRODUCT_DEACTIVATE', 'APPLIED'],
    ]);
    expect(await productStatus(affectedProduct)).toBe('INACTIVE');
    expect(await productStatus(otherProduct)).toBe('ACTIVE');
    expect(await locationEnabled(affectedLocation)).toBe(false);
    expect(await locationEnabled(otherLocation)).toBe(true);
    expect(await gatewayStatus()).toBe('DISABLED');
    // A panel nobody named keeps selling.
    expect(await sellable(p1)).toMatchObject({ sellable: true });

    await ctx.container.incidents.resolve(tenantA, owner, started.incident.id, action(started));
    expect(await productStatus(affectedProduct)).toBe('ACTIVE');
    expect(await locationEnabled(affectedLocation)).toBe(true);
    expect(await gatewayStatus()).toBe('ACTIVE');
  });

  it('restores only what it changed: a pre-existing drain stays, a drain someone re-made stays', async () => {
    const already = await panel('Frankfurt');
    const retaken = await panel('Amsterdam');
    await ctx.container.panels.setDrain(tenantA, owner, already, {
      draining: true,
      reason: 'مهاجرت',
      idempotencyKey: key(),
    });
    const started = await create({
      stopSales: true,
      targets: [
        { kind: 'PANEL', ref: already },
        { kind: 'PANEL', ref: retaken },
      ],
    });
    expect(started.effects.find((e) => e.subjectRef === already)?.state).toBe('ALREADY');
    // An operator takes over the second panel's drain with their own reason.
    await ctx.container.panels.setDrain(tenantA, owner, retaken, {
      draining: false,
      reason: 'دستی',
      idempotencyKey: key(),
    });
    await ctx.container.panels.setDrain(tenantA, owner, retaken, {
      draining: true,
      reason: 'دستی',
      idempotencyKey: key(),
    });
    const resolved = await ctx.container.incidents.resolve(
      tenantA,
      owner,
      started.incident.id,
      action(started),
    );
    expect(resolved.effects.find((e) => e.subjectRef === retaken)?.state).toBe('KEPT');
    expect((await drainOf(already))?.reason).toBe('مهاجرت');
    expect((await drainOf(retaken))?.reason).toBe('دستی');
  });

  it('touches nothing without stopSales: the incident is a record and a banner', async () => {
    const p = await panel('Frankfurt');
    const started = await create({ stopSales: false, targets: [{ kind: 'PANEL', ref: p }] });
    expect(started.effects).toEqual([]);
    expect(await sellable(p)).toMatchObject({ sellable: true });
    const banner = await ctx.container.incidents.banner(tenantA, support);
    expect(banner.map((b) => b.id)).toEqual([started.incident.id]);
  });

  // --- permissions ---------------------------------------------------------------------------

  it('charges incidents.manage to record, and each effect its own module key', async () => {
    const p = await panel('Frankfurt');
    expect((await refusal(create({}, support))).kind).toBe('PERMISSION_DENIED');
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'incident.create' AND result = 'DENIED'`,
      ),
    ).toBe(1);
    // The operator may run incidents but not drain panels: the incident is recorded, the drain refused.
    const started = await create(
      { stopSales: true, targets: [{ kind: 'PANEL', ref: p }] },
      operator,
    );
    expect(started.effects[0]).toMatchObject({
      state: 'FAILED',
      errorCode: 'platform.permission_denied',
    });
    expect(await sellable(p)).toMatchObject({ sellable: true });
    // Somebody who holds the key retries it.
    const applied = await ctx.container.incidents.applyEffects(tenantA, owner, started.incident.id);
    expect(applied.effects[0]?.state).toBe('APPLIED');
    // Support may read, and nothing more.
    expect((await ctx.container.incidents.list(tenantA, support)).incidents.length).toBe(1);
    expect(
      (await refusal(ctx.container.incidents.noticePreview(tenantA, support, started.incident.id)))
        .kind,
    ).toBe('PERMISSION_DENIED');
  });

  it('isolates tenants: another tenant cannot read or act on it, nor target another tenant’s panel', async () => {
    const ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-inc-b', roleKeys: ['owner'] }),
    );
    const foreignPanel = await panel('Paris', tenantB, ownerB);
    expect(
      (await refusal(create({ stopSales: true, targets: [{ kind: 'PANEL', ref: foreignPanel }] })))
        .code,
    ).toBe('incident.target_invalid');
    const mine = await create();
    expect(
      (await refusal(ctx.container.incidents.get(tenantB, ownerB, mine.incident.id))).kind,
    ).toBe('NOT_FOUND');
    expect(
      (
        await refusal(
          ctx.container.incidents.resolve(tenantB, ownerB, mine.incident.id, action(mine)),
        )
      ).kind,
    ).toBe('NOT_FOUND');
    expect((await ctx.container.incidents.list(tenantB, ownerB)).incidents).toEqual([]);
  });

  // --- lifecycle, idempotency and concurrency --------------------------------------------------

  it('is idempotent: the same create twice is one incident; a stale version is refused', async () => {
    const request = createIncidentRequestSchema.parse({
      idempotencyKey: 'same-incident',
      kind: 'INCIDENT',
      severity: 'MINOR',
      title: 'کندی',
    });
    const [a, b] = await Promise.allSettled([
      ctx.container.incidents.create(tenantA, owner, request),
      ctx.container.incidents.create(tenantA, owner, request),
    ]);
    const ids = [a, b].flatMap((r) => (r.status === 'fulfilled' ? [r.value.incident.id] : []));
    expect(new Set(ids).size).toBe(1);
    const again = await ctx.container.incidents.create(tenantA, owner, request);
    expect(again.incident.id).toBe(ids[0]);
    expect(await count(sql`SELECT count(*)::int AS n FROM incidents`)).toBe(1);

    const stale = { idempotencyKey: key(), expectedVersion: again.incident.version + 5 };
    expect(
      (await refusal(ctx.container.incidents.resolve(tenantA, owner, again.incident.id, stale)))
        .code,
    ).toBe('incident.version_conflict');
  });

  it('applies each effect once under concurrent reconciles, and resolves once under concurrent resolutions', async () => {
    const p1 = await panel('Frankfurt');
    const p2 = await panel('Amsterdam');
    const started = await create(
      {
        stopSales: true,
        targets: [
          { kind: 'PANEL', ref: p1 },
          { kind: 'PANEL', ref: p2 },
        ],
      },
      operator,
    );
    // The operator could not drain; three owners press "apply" at once.
    await Promise.all(
      [1, 2, 3].map(() =>
        ctx.container.incidents.applyEffects(tenantA, owner, started.incident.id),
      ),
    );
    // And once more afterwards: a settled APPLIED effect is not re-claimed — re-reading it
    // would find the drain in force and record ALREADY, and the resolution would then
    // leave the panel drained for ever.
    const again = await ctx.container.incidents.applyEffects(tenantA, owner, started.incident.id);
    expect(again.effects.map((e) => e.state)).toEqual(['APPLIED', 'APPLIED']);
    const applied = await count(
      sql`SELECT count(*)::int AS n FROM incident_events WHERE kind = 'EFFECT' AND detail->>'state' = 'APPLIED'`,
    );
    expect(applied).toBe(2);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'panel.drain' AND result = 'SUCCESS'`,
      ),
    ).toBe(2);

    const current = await ctx.container.incidents.get(tenantA, owner, started.incident.id);
    const results = await Promise.allSettled(
      [1, 2, 3].map((i) =>
        ctx.container.incidents.resolve(tenantA, owner, started.incident.id, {
          idempotencyKey: `resolve-race-${String(i)}`,
          expectedVersion: current.incident.version,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM incident_events WHERE kind = 'RESOLVED'`),
    ).toBe(1);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM incident_events WHERE kind = 'EFFECT' AND detail->>'state' = 'REVERTED'`,
      ),
    ).toBe(2);
    expect(await sellable(p1)).toMatchObject({ sellable: true });
    expect(await sellable(p2)).toMatchObject({ sellable: true });
  });

  it('schedules a window: nothing happens before it, the worker starts it, an operator applies its effects', async () => {
    const p = await panel('Frankfurt');
    const startAt = new Date(Date.now() + 1_500);
    const scheduled = await create({
      stopSales: true,
      targets: [{ kind: 'PANEL', ref: p }],
      scheduledStartAt: startAt.toISOString(),
    });
    expect(scheduled.incident.status).toBe('SCHEDULED');
    await ctx.container.incidentSchedulerLoop.tick();
    expect(
      (await ctx.container.incidents.get(tenantA, owner, scheduled.incident.id)).incident.status,
    ).toBe('SCHEDULED');
    expect(await sellable(p)).toMatchObject({ sellable: true });

    await new Promise((resolve) => setTimeout(resolve, 1_700));
    await ctx.container.incidentSchedulerLoop.tick();
    const started = await ctx.container.incidents.get(tenantA, owner, scheduled.incident.id);
    expect(started.incident.status).toBe('ACTIVE');
    expect(started.timeline.map((e) => e.kind)).toContain('EFFECTS_PENDING');
    // The scheduler holds no module key: the drain waits for a person.
    expect(await sellable(p)).toMatchObject({ sellable: true });
    const inbox = await ctx.container.notificationCenter.list(tenantA, owner, {
      limit: 50,
      unreadOnly: false,
      before: null,
    });
    // The schedule itself, its start, and the effects waiting for a person.
    expect(inbox.map((x) => x.code).sort()).toEqual([
      'maintenance.effects_pending',
      'maintenance.scheduled',
      'maintenance.started',
    ]);

    await ctx.container.incidents.applyEffects(tenantA, owner, scheduled.incident.id);
    expect(await sellable(p)).toMatchObject({ sellable: false, reason: 'DRAINING' });
    const after = await ctx.container.notificationCenter.list(tenantA, owner, {
      limit: 50,
      unreadOnly: false,
      before: null,
    });
    expect(after.find((x) => x.code === 'maintenance.effects_pending')?.resolvedAt).not.toBeNull();
  });

  it('cancels a scheduled window, which applied and restores nothing', async () => {
    const scheduled = await create({
      scheduledStartAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const cancelled = await ctx.container.incidents.cancel(
      tenantA,
      owner,
      scheduled.incident.id,
      action(scheduled),
    );
    expect(cancelled.incident.status).toBe('CANCELLED');
    expect(
      (
        await refusal(
          ctx.container.incidents.start(tenantA, owner, scheduled.incident.id, action(cancelled)),
        )
      ).code,
    ).toBe('incident.state_conflict');
  });

  it('refuses a past start and an end before the start', async () => {
    expect(
      (await refusal(create({ scheduledStartAt: new Date(Date.now() - 60_000).toISOString() })))
        .code,
    ).toBe('incident.schedule_invalid');
    const start = new Date(Date.now() + 60_000);
    expect(
      (
        await refusal(
          create({
            scheduledStartAt: start.toISOString(),
            scheduledEndAt: new Date(start.getTime() - 1).toISOString(),
          }),
        )
      ).code,
    ).toBe('incident.schedule_invalid');
  });

  // --- the ops log, the notification center, audit and outbox ---------------------------------

  it('records every state change in the ops log, the inbox, the audit log, the outbox and the timeline', async () => {
    const started = await create({ kind: 'INCIDENT' });
    const inbox = await ctx.container.notificationCenter.list(tenantA, owner, {
      limit: 50,
      unreadOnly: false,
      before: null,
    });
    expect(inbox).toEqual([
      expect.objectContaining({
        code: 'incident.started',
        category: 'INCIDENTS',
        severity: 'ERROR',
        link: { target: 'INCIDENT', id: started.incident.id },
      }),
    ]);
    await ctx.container.incidents.resolve(tenantA, owner, started.incident.id, action(started));
    const closed = await ctx.container.notificationCenter.list(tenantA, owner, {
      limit: 50,
      unreadOnly: false,
      before: null,
    });
    expect(closed).toHaveLength(1);
    expect(closed[0]?.resolvedAt).not.toBeNull();
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = 'IncidentStateChanged'`,
      ),
    ).toBe(2);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE action IN ('incident.create', 'incident.resolve') AND result = 'SUCCESS'`,
      ),
    ).toBe(2);
    // The timeline is append-only.
    await expect(
      ctx.container.database.db.execute(sql`UPDATE incident_events SET kind = 'NOTE'`),
    ).rejects.toBeDefined();
    // Support (incidents.view) sees it in the inbox; finance does not.
    const finance = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'finance-inc', roleKeys: ['finance'] }),
    );
    expect(
      (
        await ctx.container.notificationCenter.list(tenantA, support, {
          limit: 50,
          unreadOnly: false,
          before: null,
        })
      ).length,
    ).toBe(1);
    expect(
      await ctx.container.notificationCenter.list(tenantA, finance, {
        limit: 50,
        unreadOnly: false,
        before: null,
      }),
    ).toEqual([]);
  });

  // --- customer notice --------------------------------------------------------------------------

  it('tells exactly the affected customers, after a counted preview, through the notification lane', async () => {
    const affected = await panel('Frankfurt');
    const untouched = await panel('Amsterdam');
    await customerWithService('973001', affected);
    await customerWithService('973002', affected);
    await customerWithService('973003', untouched);
    const started = await create({ targets: [{ kind: 'PANEL', ref: affected }] });
    const preview = await ctx.container.incidents.noticePreview(
      tenantA,
      owner,
      started.incident.id,
    );
    expect(preview.recipients).toBe(2);
    expect(
      (
        await refusal(
          ctx.container.incidents.notify(tenantA, owner, started.incident.id, {
            idempotencyKey: key(),
            expectedVersion: preview.version,
            expectedRecipients: 3,
          }),
        )
      ).code,
    ).toBe('incident.notice_refused');

    const noticeKey = key();
    const sentNotice = await ctx.container.incidents.notify(tenantA, owner, started.incident.id, {
      idempotencyKey: noticeKey,
      expectedVersion: preview.version,
      expectedRecipients: 2,
    });
    expect(sentNotice.queued).toBe(2);
    // A double click is the same notice.
    const replay = await ctx.container.incidents.notify(tenantA, owner, started.incident.id, {
      idempotencyKey: noticeKey,
      expectedVersion: preview.version,
      expectedRecipients: 2,
    });
    expect(replay.queued).toBe(2);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM customer_notifications WHERE kind = 'INCIDENT_NOTICE'`,
      ),
    ).toBe(2);

    await ctx.container.customerNotificationLoop.tick();
    const messages = sent.filter((s) => s.url.endsWith('/sendMessage'));
    expect(messages.map((m) => String(m.body.chat_id)).sort()).toEqual(['973001', '973002']);
    expect(String(messages[0]?.body.text)).toContain('سرویس‌های آلمان امشب');
    expect(await timeline(started.incident.id)).toContain('COMMUNICATED');
  });

  it('a notice still queued when the incident is resolved is superseded, never sent', async () => {
    const affected = await panel('Frankfurt');
    await customerWithService('974001', affected);
    const started = await create({ targets: [{ kind: 'PANEL', ref: affected }] });
    const preview = await ctx.container.incidents.noticePreview(
      tenantA,
      owner,
      started.incident.id,
    );
    await ctx.container.incidents.notify(tenantA, owner, started.incident.id, {
      idempotencyKey: key(),
      expectedVersion: preview.version,
      expectedRecipients: 1,
    });
    const current = await ctx.container.incidents.get(tenantA, owner, started.incident.id);
    await ctx.container.incidents.resolve(tenantA, owner, started.incident.id, {
      idempotencyKey: key(),
      expectedVersion: current.incident.version,
    });
    await ctx.container.customerNotificationLoop.tick();
    expect(sent.filter((s) => s.url.endsWith('/sendMessage'))).toHaveLength(0);
    expect(
      (
        await rows<{ state: string }>(
          sql`SELECT state FROM customer_notifications WHERE kind = 'INCIDENT_NOTICE'`,
        )
      )[0]?.state,
    ).toBe('SUPERSEDED');
  });
});
