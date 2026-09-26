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
import type {
  OperationRecord,
  ServiceRecord,
} from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import type { ProvisionerDeps } from '../../apps/api/src/modules/commerce/provisioning/application/provisioner.service';
import {
  startFakeRickpanel,
  type FakeRickpanel,
  type FakeRickpanelUser,
} from '../support/fake-rickpanel';
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
 * WP15 G1, G3, G5, G7 against the real provisioner, a real PostgreSQL and a real-socket
 * RickPanel fake (`docs/wp15-provider-hardening-audit.md`).
 *
 * The rules under test, each in the owner's words:
 *
 * - G1: a TERMINATE never issues a provider DELETE merely because a username exists.
 * - G3: one early 404 after an accepted create is not enough to re-create.
 * - G5: a record without its usage figure is incomplete, never zero, and is retried.
 * - G7: no blind adoption — a same-username lookup is not proof.
 *
 * What these prove is that the fake and the provisioner agree. Whether a real RickPanel
 * answers the way this fake does is `docs/open-questions.md`, not this file.
 */
const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('WP15 provider safety: provenance, propagation and termination', () => {
  let ctx: TestContext;
  let telegram: Server;
  let panel: FakeRickpanel;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let operations: DrizzleOperationRepository;
  let panelId: string;
  let customerId: UserId;
  let owner: ActorContext;

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

    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-wp15', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Rick',
      providerType: 'rickpanel',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: {},
      idempotencyKey: 'panel-wp15-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);

    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-wp15',
      telegramUserId: '950950',
      from: { id: 950950, first_name: 'نگار' },
      botInstanceId: BOT_A,
    });
    customerId = resolved.customer.id;
  });

  let productSeq = 0;
  async function paidOrder(key: string): Promise<OrderId> {
    productSeq += 1;
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: `پلن ${String(productSeq)}`,
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

  const serviceOf = async (orderId: OrderId): Promise<ServiceRecord> => {
    const found = await services.findByOrderId(tenantA, orderId);
    if (found === null) throw new Error('no service');
    return found;
  };

  const opsOf = (serviceId: string): Promise<readonly OperationRecord[]> =>
    operations.listForService(tenantA, serviceId, 50);

  const makeDue = () =>
    ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET next_attempt_at = now() - interval '1 hour'
           WHERE state = 'PLANNED'`,
    );

  const deletes = () => panel.requests.filter((one) => one.method === 'DELETE').length;

  const refundCount = async (orderId: OrderId): Promise<number> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM refunds WHERE order_id = ${orderId}` as never,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  };

  const stalledReason = async (serviceId: string): Promise<string | null> => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT context->>'reason' AS reason FROM operational_events
           WHERE code = 'provisioning.stalled' AND dedupe_key = ${`provisioning.stalled:${serviceId}`}
             AND resolved_at IS NULL` as never,
    )) as unknown as { rows: { reason: string }[] };
    return rows.rows[0]?.reason ?? null;
  };

  /** An account on the panel that this installation did NOT create. */
  function seedForeignAccount(username: string): FakeRickpanelUser {
    const foreign: FakeRickpanelUser = {
      username,
      status: 'active',
      expire: 1_900_000_000,
      dataLimit: 1,
      usedTraffic: 7,
      proxies: { vless: { id: 'somebody-elses' } },
      subToken: 'foreign00000001',
    };
    (panel.users as Map<string, FakeRickpanelUser>).set(username, foreign);
    return foreign;
  }

  // =========================================================================
  // G3 — propagation
  // =========================================================================

  it('G3: accepted create, first read 404, later visible — one create, no 409, no refund', async () => {
    // Every read-back of the create, and the reconcile's first read, find nothing yet.
    panel.hiddenReads = 3 + 1;
    const orderId = await paidOrder('g3-propagation');

    await ctx.container.provisionerLoop.tick();
    const service = await serviceOf(orderId);
    const create = (await opsOf(service.id)).find((one) => one.type === 'PROVISION');
    expect(create?.state).toBe('UNKNOWN');
    expect(create?.createAcceptedAt, 'the 2xx is durable provenance').not.toBeNull();
    expect(service.state).toBe('UNRECONCILED');

    await makeDue();
    await ctx.container.provisionerLoop.tick();
    const reconcile = (await opsOf(service.id)).find((one) => one.type === 'RECONCILE');
    expect(reconcile?.state, 'one 404 is undecided').toBe('PLANNED');
    expect(reconcile?.absenceObservedAt).not.toBeNull();
    expect(panel.createCalls(), 'and re-creates nothing').toBe(1);

    await makeDue();
    await ctx.container.provisionerLoop.tick();
    const after = await services.findById(tenantA, service.id);
    expect(after?.state, 'the account appeared and was adopted').toBe('ACTIVE');
    expect(after?.subscriptionUrl).not.toBeNull();
    expect(panel.createCalls(), 'ONE create, no 409 loop').toBe(1);
    expect(panel.users.size).toBe(1);
    expect(await refundCount(orderId)).toBe(0);
  });

  // =========================================================================
  // G7 — provenance
  // =========================================================================

  it('G7: an accepted create whose read-back was lost is adopted later, from durable state', async () => {
    panel.droppedReads = 1;
    const orderId = await paidOrder('g7-accepted');

    await ctx.container.provisionerLoop.tick();
    const service = await serviceOf(orderId);
    // Read straight from the table: what survives a restart is the row, not a process.
    const stamped = (await ctx.container.database.db.execute(
      sql`SELECT create_accepted_at IS NOT NULL AS accepted FROM provisioning_operations
           WHERE service_id = ${service.id} AND type = 'PROVISION'` as never,
    )) as unknown as { rows: { accepted: boolean }[] };
    expect(stamped.rows).toEqual([{ accepted: true }]);

    await makeDue();
    await ctx.container.provisionerLoop.tick();
    expect((await services.findById(tenantA, service.id))?.state).toBe('ACTIVE');
    expect(panel.createCalls()).toBe(1);
    expect(await refundCount(orderId)).toBe(0);
  });

  it('G7: a pre-existing same-name account and a 409 are never adopted', async () => {
    const orderId = await paidOrder('g7-conflict');
    const planned = await serviceOf(orderId);
    const foreign = seedForeignAccount(planned.providerUsername);

    await ctx.container.provisionerLoop.tick();
    const service = await services.findById(tenantA, planned.id);
    expect(service?.state, 'refused, refunded, and ended — never ACTIVE').toBe('TERMINATED');
    expect(service?.subscriptionUrl).toBeNull();
    expect(await refundCount(orderId)).toBe(1);
    const create = (await opsOf(planned.id)).find((one) => one.type === 'PROVISION');
    expect(create?.failureKind).toBe('PROVIDER_REFUSED');
    expect(create?.createAcceptedAt).toBeNull();
    expect(panel.users.get(planned.providerUsername), 'somebody else’s account untouched').toBe(
      foreign,
    );
    expect(deletes()).toBe(0);
  });

  it('G7: an unknown create meeting a pre-existing account stalls for an operator, unrefunded', async () => {
    const orderId = await paidOrder('g7-found-foreign');
    const planned = await serviceOf(orderId);
    seedForeignAccount(planned.providerUsername);
    // A 5xx on create: UNKNOWN, and no evidence the panel accepted anything.
    panel.behaviour = 'server-error';

    await ctx.container.provisionerLoop.tick();
    expect((await services.findById(tenantA, planned.id))?.state).toBe('UNRECONCILED');
    panel.behaviour = 'healthy';
    await makeDue();
    await ctx.container.provisionerLoop.tick();

    const service = await services.findById(tenantA, planned.id);
    expect(service?.state, 'nothing adopted on a name').toBe('UNRECONCILED');
    expect(service?.subscriptionUrl).toBeNull();
    expect(await stalledReason(planned.id)).toBe('FOUND_WITHOUT_PROVENANCE');
    expect(await refundCount(orderId), 'UNKNOWN is never refunded').toBe(0);
    const create = (await opsOf(planned.id)).find((one) => one.type === 'PROVISION');
    expect(create?.state).toBe('UNKNOWN');
    expect(create?.verificationAttempts, 'its rounds are spent').toBe(2);

    const reads = panel.requests.length;
    await makeDue();
    await ctx.container.provisionerLoop.tick();
    expect(panel.requests.length, 'and it is not asked again').toBe(reads);
  });

  it('G7: service A’s provenance never lets service B adopt, and tenants never share it', async () => {
    panel.droppedReads = 1;
    const orderA = await paidOrder('g7-a');
    await ctx.container.provisionerLoop.tick();
    const serviceA = await serviceOf(orderA);
    expect(
      (await opsOf(serviceA.id)).find((one) => one.type === 'PROVISION')?.createAcceptedAt,
    ).not.toBeNull();

    const orderB = await paidOrder('g7-b');
    const plannedB = await serviceOf(orderB);
    seedForeignAccount(plannedB.providerUsername);
    panel.behaviour = 'server-error';
    await ctx.container.provisionerLoop.tick();
    panel.behaviour = 'healthy';
    await makeDue();
    await ctx.container.provisionerLoop.tick();

    expect((await services.findById(tenantA, serviceA.id))?.state).toBe('ACTIVE');
    expect((await services.findById(tenantA, plannedB.id))?.state).toBe('UNRECONCILED');
    expect(await stalledReason(plannedB.id)).toBe('FOUND_WITHOUT_PROVENANCE');

    expect(await operations.hasCreateProvenance(tenantA, serviceA.id)).toBe(true);
    expect(await operations.hasCreateProvenance(tenantA, plannedB.id)).toBe(false);
    expect(
      await operations.hasCreateProvenance(tenantB, serviceA.id),
      'another tenant cannot see the evidence at all',
    ).toBe(false);
  });

  // =========================================================================
  // G4 — a reconcile that cannot read the panel
  // =========================================================================

  it('G4: a failed reconcile round gets ONE more automatically, then an operator decides', async () => {
    panel.droppedReads = 1;
    const orderId = await paidOrder('g4-rounds');
    await ctx.container.provisionerLoop.tick();
    const service = await serviceOf(orderId);
    expect(service.state).toBe('UNRECONCILED');

    // Every read of the account is refused from here on: no round can decide.
    panel.rateLimitedReads = 10_000;
    for (let tick = 0; tick < 16; tick += 1) {
      await makeDue();
      await ctx.container.provisionerLoop.tick();
    }

    const reconciles = (await opsOf(service.id)).filter((one) => one.type === 'RECONCILE');
    expect(reconciles, 'the ordinary round and exactly ONE more').toHaveLength(2);
    expect(reconciles.every((one) => one.state === 'FAILED')).toBe(true);
    const create = (await opsOf(service.id)).find((one) => one.type === 'PROVISION');
    expect(create?.state, 'still unknown, and never refunded').toBe('UNKNOWN');
    expect(create?.verificationAttempts, 'the budget is on the row, not in a process').toBe(2);
    expect(await refundCount(orderId)).toBe(0);
    expect(await stalledReason(service.id)).toBe('RECONCILE_EXHAUSTED');

    const reads = panel.requests.length;
    for (let tick = 0; tick < 3; tick += 1) {
      await makeDue();
      await ctx.container.provisionerLoop.tick();
    }
    expect(panel.requests.length, 'no third round, and no polling').toBe(reads);
  });

  // =========================================================================
  // G5 — an incomplete record
  // =========================================================================

  it('G5: a found record without usage is retried, never read as zero, then adopted whole', async () => {
    panel.droppedReads = 1;
    const orderId = await paidOrder('g5-usage');
    await ctx.container.provisionerLoop.tick();
    const service = await serviceOf(orderId);

    panel.omitUsedTraffic = true;
    await makeDue();
    await ctx.container.provisionerLoop.tick();
    const reconcile = (await opsOf(service.id)).find((one) => one.type === 'RECONCILE');
    expect(reconcile?.state, 'an incomplete record is retried').toBe('PLANNED');
    expect(reconcile?.failureMessage ?? '').toContain('USAGE_FIELD_MISSING');
    expect((await services.findById(tenantA, service.id))?.state).toBe('UNRECONCILED');

    panel.omitUsedTraffic = false;
    await makeDue();
    await ctx.container.provisionerLoop.tick();
    const after = await services.findById(tenantA, service.id);
    expect(after?.state).toBe('ACTIVE');
    expect(after?.trafficUsedBytes, 'the figure the panel gave, not an invented zero').toBe(0n);
  });

  // =========================================================================
  // G1 — terminate
  // =========================================================================

  it('G1: a pending service whose create never started ends with ZERO provider calls', async () => {
    const orderId = await paidOrder('g1-never-started');
    const service = await serviceOf(orderId);
    // Keep the create from running first.
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET next_attempt_at = now() + interval '1 day'
           WHERE service_id = ${service.id}`,
    );
    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'TERMINATE', {
      idempotencyKey: 'g1-never-started-terminate',
    });
    const before = panel.requests.length;

    await ctx.container.provisionerLoop.tick();
    expect((await services.findById(tenantA, service.id))?.state).toBe('TERMINATED');
    expect((await opsOf(service.id)).find((one) => one.type === 'TERMINATE')?.state).toBe(
      'SUCCEEDED',
    );
    expect(panel.requests.length - before, 'not even a login').toBe(0);
    expect(deletes()).toBe(0);
    const audit = (await ctx.container.database.db.execute(
      sql`SELECT after FROM audit_logs WHERE entity_id = ${service.id}
           AND action = 'service.terminate'` as never,
    )) as unknown as { rows: { after: Record<string, unknown> }[] };
    expect(audit.rows[0]?.after).toMatchObject({
      providerDelete: 'SKIPPED',
      reason: 'NEVER_CREATED',
    });

    // And the create, when it comes due, finds nothing to create for.
    await makeDue();
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET next_attempt_at = now() - interval '1 hour'
           WHERE service_id = ${service.id} AND state = 'PLANNED'`,
    );
    await ctx.container.provisionerLoop.tick();
    expect(panel.createCalls()).toBe(0);
    expect((await opsOf(service.id)).find((one) => one.type === 'PROVISION')?.state).toBe(
      'ABANDONED',
    );
  });

  it('G1: a service this installation created is terminated on the panel', async () => {
    const orderId = await paidOrder('g1-created');
    await ctx.container.provisionerLoop.tick();
    const service = await serviceOf(orderId);
    expect(service.state).toBe('ACTIVE');

    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'TERMINATE', {
      idempotencyKey: 'g1-created-terminate',
    });
    await ctx.container.provisionerLoop.tick();
    expect((await services.findById(tenantA, service.id))?.state).toBe('TERMINATED');
    expect(deletes(), 'the authorised path deletes').toBe(1);
    expect(panel.users.has(service.providerUsername)).toBe(false);
  });

  it('G1: an UNRECONCILED service WITH provenance takes the ordinary DELETE path', async () => {
    panel.droppedReads = 1;
    const orderId = await paidOrder('g1-accepted');
    await ctx.container.provisionerLoop.tick();
    const service = await serviceOf(orderId);
    expect(service.state).toBe('UNRECONCILED');

    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'TERMINATE', {
      idempotencyKey: 'g1-accepted-terminate',
    });
    await ctx.container.provisionerLoop.tick();
    expect((await services.findById(tenantA, service.id))?.state).toBe('TERMINATED');
    expect(deletes()).toBe(1);
    expect(panel.users.has(service.providerUsername)).toBe(false);
  });

  it('G1: an UNRECONCILED service WITHOUT provenance never deletes the same-named account', async () => {
    const orderId = await paidOrder('g1-foreign');
    const planned = await serviceOf(orderId);
    const foreign = seedForeignAccount(planned.providerUsername);
    panel.behaviour = 'server-error';
    await ctx.container.provisionerLoop.tick();
    panel.behaviour = 'healthy';
    expect((await services.findById(tenantA, planned.id))?.state).toBe('UNRECONCILED');

    await ctx.container.provisioning.requestFromOperator(tenantA, owner, planned.id, 'TERMINATE', {
      idempotencyKey: 'g1-foreign-terminate',
    });
    await ctx.container.provisionerLoop.tick();
    expect((await services.findById(tenantA, planned.id))?.state).toBe('TERMINATED');
    expect(deletes(), 'no DELETE by name').toBe(0);
    expect(panel.users.get(planned.providerUsername)).toBe(foreign);
    const create = (await opsOf(planned.id)).find((one) => one.type === 'PROVISION');
    expect(create?.state, 'the lost create is closed, so the order is not held for ever').toBe(
      'ABANDONED',
    );
  });

  it('G1: a create claimed before a terminate commits finds the service ended and calls nothing', async () => {
    const orderId = await paidOrder('g1-race');
    const service = await serviceOf(orderId);
    const deps = (ctx.container.provisioner as unknown as { deps: ProvisionerDeps }).deps;
    const original = deps.panels.takeProbeBudget.bind(deps.panels);
    /*
     * The interleaving: the PROVISION has passed every check that reads the service and
     * is about to stamp its call. A terminate commits in that gap. The stamp takes the
     * service lock and must see it.
     */
    (deps.panels as { takeProbeBudget: typeof original }).takeProbeBudget = async (...args) => {
      await ctx.container.database.db.execute(
        sql`UPDATE services SET state = 'TERMINATED', terminated_at = now(), updated_at = now()
             WHERE id = ${service.id}`,
      );
      return original(...args);
    };
    try {
      await ctx.container.provisioner.runOnce(tenantA);
    } finally {
      (deps.panels as { takeProbeBudget: typeof original }).takeProbeBudget = original;
    }
    const create = (await opsOf(service.id)).find((one) => one.type === 'PROVISION');
    expect(create?.state).toBe('ABANDONED');
    expect(create?.callStartedAt, 'no call was stamped').toBeNull();
    expect(panel.createCalls(), 'and none was made').toBe(0);
  });

  it('G1: a terminate that meets a create on the wire is put back, not decided', async () => {
    const orderId = await paidOrder('g1-hold');
    const service = await serviceOf(orderId);
    const create = (await opsOf(service.id)).find((one) => one.type === 'PROVISION');
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations
             SET state = 'IN_FLIGHT', claimed_by = 'other-worker', attempts = 1,
                 lease_until = now() + interval '1 hour', call_started_at = now()
           WHERE id = ${create?.id ?? ''}`,
    );
    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'TERMINATE', {
      idempotencyKey: 'g1-hold-terminate',
    });
    const terminate = (await opsOf(service.id)).find((one) => one.type === 'TERMINATE');
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations
             SET state = 'IN_FLIGHT', claimed_by = 'this-worker', attempts = 1,
                 lease_until = now() + interval '1 hour'
           WHERE id = ${terminate?.id ?? ''}`,
    );
    const claimed = await operations.findById(tenantA, terminate?.id ?? '');
    const result = await (
      ctx.container.provisioner as unknown as {
        terminateWithoutProvider(
          scope: typeof tenantA,
          operation: OperationRecord,
          service: ServiceRecord,
          now: Date,
        ): Promise<{ kind: string; reason?: string } | null>;
      }
    ).terminateWithoutProvider(tenantA, claimed as OperationRecord, service, new Date());

    expect(result).toMatchObject({ kind: 'REFUSED', reason: 'PROVISION_IN_FLIGHT' });
    expect((await operations.findById(tenantA, terminate?.id ?? ''))?.state).toBe('PLANNED');
    expect((await services.findById(tenantA, service.id))?.state).toBe('PENDING_PROVISION');
    expect(deletes()).toBe(0);
  });
});
