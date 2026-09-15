import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type OrderId,
  type PanelId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { providerDescriptor } from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { DrizzleOperationRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-operation.repository';
import { CANARY, startFake3xUi, type Fake3xUi } from '../support/fake-3xui';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * Provisioning and DELIVERY, in one tick, against real everything.
 *
 * A real PostgreSQL, the real provisioner, the real Sanaei adapter, the real
 * `SafeHttpClient`, a deterministic 3X-UI on a real socket, and a real socket standing
 * in for Telegram. Nothing here is mocked, because every rule under test is about what
 * survives a failure at a boundary — and a stub at that boundary would assert the
 * test's own idea of the boundary rather than the system's.
 *
 * The five things a customer's money depends on:
 *
 *   1. a successful provision announces itself, with no second process and no wait;
 *   2. a Telegram failure leaves the service ACTIVE — anything else invites
 *      re-provisioning an account that already exists;
 *   3. retrying the announcement does not call the provider again;
 *   4. duplicate delivery work cannot produce a duplicate provider account;
 *   5. a send that dies on the wire does not take the committed service with it.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

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

describe('a provisioned service announces itself', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  /** What the fake Telegram answers. Replaced per case for the failure shapes. */
  let reply: (request: IncomingMessage, response: ServerResponse) => void;
  let panel: Fake3xUi;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let operations: DrizzleOperationRepository;
  let panelId: string;
  let customerA: UserId;
  let owner: ActorContext;

  beforeAll(async () => {
    sent = [];
    telegram = createServer((request, response) => {
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
        // Recorded BEFORE the reply, so a case that destroys the socket can still
        // prove the request reached Telegram — which is the whole difference between
        // `UNCONFIRMED` and `REFUSED`.
        sent.push({ url: request.url ?? '', body });
        reply(request, response);
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
    // The loop asks for the installation's tenant per tick.
    ctx.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(ctx.container.database.db);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    operations = new DrizzleOperationRepository(ctx.container.database.db);
    sent = [];
    reply = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
    };

    /*
     * The panel at 127.0.0.2, not 127.0.0.1.
     *
     * The container's real URL policy denies the hostnames in DATABASE_URL and
     * REDIS_URL, which here is 127.0.0.1. Binding elsewhere on loopback is the
     * production shape rather than a way around the policy: a self-hosted panel in
     * private space is reachable while this installation's own data services are not.
     */
    panel = await startFake3xUi({ host: '127.0.0.2' });

    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-deliv', roleKeys: ['owner'] }),
    );

    /*
     * Created through the SERVICE, activation included, not by an INSERT.
     *
     * A fixture that wrote `activation` straight into the table would prove the
     * provisioner reads a column no operator can fill, which is exactly the shape this
     * phase had to fix. Going through `panels.create` means the test fails if the
     * write path regresses.
     */
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Panel A',
      providerType: 'sanaei',
      baseUrl: panel.baseUrl,
      credentials: { username: CANARY.username, password: CANARY.password },
      activation: { subscriptionDomain: 'sub.example.test', inboundId: 1 },
      idempotencyKey: 'panel-deliv-create',
    });
    panelId = created.view.panel.id;

    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-deliv',
      telegramUserId: '910910',
      from: { id: 910910, first_name: 'مریم' },
      botInstanceId: BOT_A,
    });
    customerA = resolved.customer.id;
  });

  /** A settled order, which is what plans a provisioning operation. */
  async function paidOrder(key: string): Promise<OrderId> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(250_000n, 'IRT'),
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
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), customerA, {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id,
    });
    return confirmed.id;
  }

  /** How many times the panel was asked to create a client. The provider-call count. */
  const addClientCalls = (): number =>
    /*
     * The v3.7.0 create route, `POST panel/api/clients/add`.
     *
     * It matched `addClient` — the v2.x path — and after that path was corrected this
     * helper would have counted ZERO for every create while several assertions here
     * expect one. A counter that silently reads zero is worse than a broken one,
     * because `toBe(0)` passes.
     */
    panel.requests.filter((request) => request.path.includes('panel/api/clients/add')).length;

  /** Makes a backed-off operation due again without waiting out its retry interval. */
  async function makeOperationDue(): Promise<void> {
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET next_attempt_at = now() - interval '1 hour'`,
    );
  }

  /** Makes a pending delivery due again without waiting out its five-minute backoff. */
  async function makeDeliveryDue(): Promise<void> {
    await ctx.container.database.db.execute(
      sql`UPDATE services SET delivery_next_attempt_at = now() - interval '1 hour'`,
    );
  }

  it('sends the subscription in the SAME tick that provisions it', async () => {
    const orderId = await paidOrder('deliver-ok');

    await ctx.container.provisionerLoop.tick();

    const service = await services.findByOrderId(tenantA, orderId);
    expect(service?.state, 'the provider create succeeded').toBe('ACTIVE');
    /*
     * Built from the ACTIVATION, not from the panel's own address.
     *
     * 3X-UI serves subscriptions from a separate listener, so a link derived from the
     * panel address points a customer at the admin login. The host here is the one the
     * operator configured, and the panel's own origin is `127.0.0.2`.
     */
    expect(service?.subscriptionUrl).toMatch(/^https:\/\/sub\.example\.test\/sub\/.+/);
    expect(service?.subscriptionUrl).not.toContain('127.0.0.2');
    expect(addClientCalls(), 'exactly one provider create').toBe(1);

    /*
     * ONE tick, not two.
     *
     * The requirement is that a successful provision enters the delivery flow
     * automatically; a test that ticked twice would pass with delivery driven by
     * nothing but its own second call.
     */
    expect(service?.deliveryState).toBe('DELIVERED');
    expect(service?.deliveredAt).not.toBeNull();
    expect(service?.deliveryAttempts).toBe(1);
    expect(service?.deliveryNextAttemptAt).toBeNull();

    expect(sent, 'the customer was told, once').toHaveLength(1);
    expect(sent[0]?.url).toContain('/sendMessage');
    expect(sent[0]?.body['chat_id']).toBe('910910');
    // The link the panel produced, in the message the catalogue rendered.
    expect(String(sent[0]?.body['text'])).toContain(service?.subscriptionUrl ?? 'no-url');
  });

  it('leaves the service ACTIVE when Telegram refuses the message', async () => {
    reply = (_request, response) => {
      // 403 is the customer having blocked the bot: a definite refusal, never a
      // maybe. Anything 5xx would be `UNCONFIRMED` and is the case below.
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked' }),
      );
    };
    const orderId = await paidOrder('deliver-refused');

    await ctx.container.provisionerLoop.tick();

    const service = await services.findByOrderId(tenantA, orderId);
    /*
     * The rule this whole file exists for.
     *
     * Delivery is a separate axis from `ServiceState`. A refused Telegram message that
     * moved the service out of `ACTIVE` would make a provisioned account look
     * unprovisioned, and the obvious remedy for that is to provision it again — which
     * is a second paid-for account on somebody's panel.
     */
    expect(service?.state, 'a failed send does not unprovision a service').toBe('ACTIVE');
    expect(service?.providerUserId, 'nor does it forget the provider account').not.toBeNull();
    expect(service?.subscriptionUrl).not.toBeNull();
    expect(service?.provisionedAt).not.toBeNull();

    expect(service?.deliveryState).toBe('PENDING');
    expect(service?.deliveryAttempts).toBe(1);
    expect(service?.deliveredAt).toBeNull();
    expect(service?.deliveryNextAttemptAt, 'and it backs off').not.toBeNull();

    const ops = await operations.listForService(tenantA, service?.id ?? '', 10);
    expect(ops, 'no second operation was planned').toHaveLength(1);
    expect(ops[0]?.state).toBe('SUCCEEDED');
  });

  it('retries the announcement without calling the provider again', async () => {
    reply = (_request, response) => {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden' }));
    };
    const orderId = await paidOrder('deliver-retry');
    await ctx.container.provisionerLoop.tick();
    expect(addClientCalls()).toBe(1);
    expect(sent).toHaveLength(1);

    // The customer unblocks the bot, and the backoff elapses.
    reply = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: 12 } }));
    };
    await makeDeliveryDue();

    await ctx.container.provisionerLoop.tick();

    expect(addClientCalls(), 'the provider was NOT asked to create a second account').toBe(1);
    expect(panel.clients.size).toBe(1);
    expect(sent, 'the announcement was retried').toHaveLength(2);

    const service = await services.findByOrderId(tenantA, orderId);
    expect(service?.deliveryState).toBe('DELIVERED');
    expect(service?.deliveryAttempts, 'both attempts are counted').toBe(2);
    const ops = await operations.listForService(tenantA, service?.id ?? '', 10);
    expect(ops, 'and still one operation').toHaveLength(1);
  });

  it('cannot duplicate provisioning however many sweeps run', async () => {
    const orderId = await paidOrder('deliver-dup');
    const service0 = await services.findByOrderId(tenantA, orderId);
    const serviceId = service0?.id ?? '';

    // Provision, but do not let the announcement land: the service stays claimable.
    reply = (_request, response) => {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden' }));
    };
    await ctx.container.provisionerLoop.tick();
    expect(addClientCalls()).toBe(1);

    reply = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: 13 } }));
    };
    await makeDeliveryDue();

    /*
     * Two sweeps, IN SEQUENCE.
     *
     * Sequential rather than `Promise.allSettled`, for the reason
     * `docs/phase4b-falsification.md` records: an allSettled pair that does not
     * interleave proves nothing.
     *
     * What this proves is that the second sweep finds nothing to do — which is the
     * ordinary two-replica outcome, and is WEAKER than the claim's own predicate. Here
     * the first sweep DELIVERED the service, so the second is stopped by the delivery
     * state rather than by the lease; `docs/phase4d-falsification.md` records that as
     * F4D-07. The lease and the predicate are proven in `provisioning.test.ts`, where
     * the row is still PENDING and the interleaving is made.
     */
    const first = await ctx.container.delivery.deliverDue(tenantA, 10);
    const second = await ctx.container.delivery.deliverDue(tenantA, 10);

    expect(first.claimed, 'the first sweep takes the service').toBe(1);
    expect(first.delivered).toBe(1);
    expect(second.claimed, 'the second finds nothing claimable').toBe(0);

    expect(sent, 'the customer is told once, not twice').toHaveLength(2);
    expect(addClientCalls(), 'and no sweep ever reaches the provider').toBe(1);
    expect(panel.clients.size).toBe(1);

    const rows = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM services WHERE order_id = ${orderId}`,
    );
    expect((rows.rows[0] as { n: number }).n, 'one service for one order').toBe(1);
    const ops = await operations.listForService(tenantA, serviceId, 10);
    expect(ops, 'one operation for one service').toHaveLength(1);
  });

  it('does not announce to a customer an operator has blocked', async () => {
    reply = (_request, response) => {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden' }));
    };
    const orderId = await paidOrder('deliver-blocked');
    await ctx.container.provisionerLoop.tick();
    expect(sent).toHaveLength(1);

    await ctx.container.customers.block(tenantA, owner, {
      idempotencyKey: 'block-deliv',
      customerId: customerA,
      reason: 'fixture',
    });
    await makeDeliveryDue();
    sent = [];

    /*
     * Excluded AT THE QUERY, not skipped in the sweep.
     *
     * A service the sweep picked up and then declined would either burn an attempt
     * against the ceiling — punishing a customer for a moderation decision that may be
     * reversed — or be skipped without one, which returns the same row every tick for
     * ever and crowds out deliveries that could be made.
     */
    const blocked = await ctx.container.delivery.deliverDue(tenantA, 10);
    expect(blocked.claimed, 'a blocked customer has nothing due').toBe(0);
    expect(sent, 'and nothing was sent').toHaveLength(0);

    const during = await services.findByOrderId(tenantA, orderId);
    expect(during?.deliveryAttempts, 'no attempt was spent on the block').toBe(1);

    // And unblocking resumes it, with nothing to remember.
    await ctx.container.customers.unblock(tenantA, owner, {
      idempotencyKey: 'unblock-deliv',
      customerId: customerA,
      reason: null,
    });
    reply = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: 14 } }));
    };
    await makeDeliveryDue();
    const resumed = await ctx.container.delivery.deliverDue(tenantA, 10);
    expect(resumed.delivered).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it('announces nothing for a tenant that has stopped accepting work', async () => {
    reply = (_request, response) => {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden' }));
    };
    await paidOrder('deliver-stopped');
    await ctx.container.provisionerLoop.tick();
    expect(sent).toHaveLength(1);

    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
    );
    await makeDeliveryDue();
    sent = [];

    /*
     * The kill switch every write path reads, and this one also SENDS.
     *
     * An operator who stopped a tenant expects its customers to stop hearing from it.
     * The panels module was the one write path that skipped this check, which let a
     * stopped tenant go on being given panels and a background monitor.
     */
    const sweep = await ctx.container.delivery.deliverDue(tenantA, 10);
    expect(sweep.claimed, 'nothing is even claimed').toBe(0);
    expect(sent, 'and nothing reaches Telegram').toHaveLength(0);

    /*
     * And the CUSTOMER-initiated path is refused too.
     *
     * The sweep's early return is an optimisation — it stops a stopped tenant's rows
     * being claimed and leased only to be refused one at a time. The gate that makes
     * the rule true is inside `deliver`, and `redeliver` is its other caller. Exercised
     * through that caller so the gate is not a rule with no test, which is how the
     * early return alone would leave it.
     */
    const service = (await services.list(tenantA, {}, 1, null)).items[0];
    await expect(
      ctx.container.delivery.redeliver(
        tenantA,
        service ?? (undefined as never),
        customerA,
        '910910',
        BOT_A,
      ),
    ).rejects.toThrow();
    expect(sent, 'still nothing').toHaveLength(0);
  });

  it('keeps the committed service when the reply dies on the wire', async () => {
    reply = (request, _response) => {
      /*
       * The socket is destroyed AFTER the request body arrived.
       *
       * Which is the case `UNCONFIRMED` exists for: Telegram may well have delivered
       * the message, and nothing can tell from here. A refusal would be a claim the
       * system is not entitled to make, and a retry would be a second "your service is
       * ready" for a customer who may already have the first.
       */
      request.socket.destroy();
    };
    const orderId = await paidOrder('deliver-dead');

    await ctx.container.provisionerLoop.tick();

    expect(sent, 'the request did reach Telegram').toHaveLength(1);

    const service = await services.findByOrderId(tenantA, orderId);
    expect(service?.state, 'the service survives the dead reply').toBe('ACTIVE');
    expect(service?.providerUserId).not.toBeNull();
    expect(service?.subscriptionUrl).not.toBeNull();
    expect(service?.provisionedAt).not.toBeNull();
    expect(service?.expiresAt, 'including what the order paid for').not.toBeNull();

    expect(service?.deliveryState, 'and the uncertainty is recorded, not guessed').toBe(
      'UNCONFIRMED',
    );
    expect(service?.deliveredAt).toBeNull();

    const ops = await operations.listForService(tenantA, service?.id ?? '', 10);
    expect(ops[0]?.state, 'the provisioning operation is still a success').toBe('SUCCEEDED');

    /*
     * And it is never swept again.
     *
     * `DELIVERY_AUTO_RETRY_STATES` is `PENDING` alone. Asserted through the sweep
     * rather than through the state, because the state is what the sweep is supposed
     * to read and a sweep that ignored it would leave this assertion green.
     */
    await makeDeliveryDue();
    const sweep = await ctx.container.delivery.deliverDue(tenantA, 10);
    expect(sweep.claimed).toBe(0);
    expect(sent).toHaveLength(1);
  });

  // =========================================================================
  // What happens when the PROVIDER fails
  //
  // Nothing above this line makes the panel misbehave, and that was a real gap: the
  // rules the whole phase is built around — `call_started_at`, `UNRECONCILED`, the
  // reconcile — were all reachable only through a provider failure, and a mutation of
  // each survived the suite.
  // =========================================================================

  it('stamps that a provider call started, before making it', async () => {
    const orderId = await paidOrder('call-started');
    await ctx.container.provisionerLoop.tick();

    const service = await services.findByOrderId(tenantA, orderId);
    const ops = await operations.listForService(tenantA, service?.id ?? '', 10);
    /*
     * The one fact that stops a crash mid-create becoming a second paid-for account.
     *
     * `releaseExpiredLeases` refuses to re-hand any row carrying it, and that guard has
     * its own test — but nothing distinguished "the executor stamps it" from "the
     * executor does not", so deleting the stamp left the suite green and every crash
     * mid-create a duplicate.
     */
    expect(ops[0]?.callStartedAt, 'the executor stamped the call before making it').not.toBeNull();
  });

  it('recovers a provider call whose worker died, instead of waiting for ever', async () => {
    const orderId = await paidOrder('stranded');
    const service0 = await services.findByOrderId(tenantA, orderId);
    const serviceId = service0?.id ?? '';

    /*
     * The state a crash mid-create leaves behind: IN_FLIGHT, stamped, lease gone.
     *
     * `releaseExpiredLeases` refuses exactly this row on purpose — releasing it would
     * repeat a mutation that may have landed — and its comment said such a row waits for
     * "a person or the reconciler". Neither had a path to it: the reconciler scans
     * UNKNOWN, `retireExhausted` scans PLANNED, and `retryProvisioning` hands the open
     * operation straight back. So the paid order sat in PENDING_PROVISION for ever.
     */
    const claimed = await ctx.container.uow.run(tenantA, async (tx) =>
      operations.claimDue(
        tenantA,
        'worker-that-died',
        ctx.container.clock.now(),
        new Date(Date.now() + 60_000),
        tx,
      ),
    );
    expect(claimed, 'there is a planned create to claim').not.toBeNull();
    await ctx.container.uow.run(tenantA, async (tx) =>
      operations.markCallStarted(
        tenantA,
        claimed?.id ?? '',
        'worker-that-died',
        ctx.container.clock.now(),
        tx,
      ),
    );
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET lease_until = now() - interval '1 hour'`,
    );

    await ctx.container.provisionerLoop.tick();

    const stranded = await operations.findById(tenantA, claimed?.id ?? '');
    expect(
      stranded?.state,
      'the stranded create leaves IN_FLIGHT instead of sitting there for ever',
    ).not.toBe('IN_FLIGHT');

    /*
     * ONE tick does the whole recovery, and the test says so rather than asserting a
     * sequence it does not see.
     *
     * The reap moves the create to UNKNOWN and the service to UNRECONCILED; the same
     * tick plans the reconcile, claims it, and asks the panel — which never received a
     * create here, because this fixture stamped the call without making one — so the
     * verdict is ABSENT, the unknown is resolved to FAILED, and the service returns to
     * PENDING_PROVISION where a fresh create is legal.
     *
     * `reapStrandedCalls` producing UNKNOWN specifically is proved at the repository
     * level in `provisioning.test.ts`, where no later step can move it.
     */
    const planned = await operations.listForService(tenantA, serviceId, 10);
    expect(
      planned.some((operation) => operation.type === 'RECONCILE'),
      'the same tick plans the reconcile that resolves it',
    ).toBe(true);
    const service = await services.findById(tenantA, serviceId);
    /*
     * ACTIVE, because the tick drains: the reconcile proved the panel had no account,
     * the service returned to PENDING_PROVISION where a create is legal, and the same
     * tick made it. That is the outcome a customer who paid should get, and asserting
     * the intermediate PENDING_PROVISION instead would be asserting a state this system
     * passes through rather than the one it lands in.
     */
    expect(service?.state, 'the stranded order is recovered, not merely unstuck').toBe('ACTIVE');
    expect(addClientCalls(), 'and exactly ONE account exists on the panel').toBe(1);
    expect(
      planned.every((operation) => operation.state !== 'IN_FLIGHT'),
      'nothing is left holding a claim',
    ).toBe(true);
  });

  it('keeps reconciling a service whose SECOND create also loses track', async () => {
    /*
     * The queue jamming itself with its own history.
     *
     * `listUnknown` is oldest-first and filtered on the service being UNRECONCILED —
     * true again the moment a second create loses track. It therefore handed back the
     * FIRST, already-reconciled operation; `planReconciles` derived that row's reconcile
     * id, found the terminal reconcile that had already run, and planned nothing. The
     * service stayed UNRECONCILED with no open work for ever, and the cycle ceiling was
     * never reached because the cycle died in round two.
     *
     * Fixed by USING the `UNKNOWN -> SUCCEEDED/FAILED` edges `OPERATION_MACHINE` has
     * always declared and nothing called.
     */
    panel.setBehaviour('add-client-lost-reply');
    const orderId = await paidOrder('twice-lost');

    await ctx.container.provisionerLoop.tick();
    const serviceId = (await services.findByOrderId(tenantA, orderId))?.id ?? '';

    const afterFirst = await operations.listForService(tenantA, serviceId, 20);
    expect(
      afterFirst.every((operation) => operation.state !== 'UNKNOWN'),
      'the reconcile that ran closed the unknown it answered',
    ).toBe(true);

    await makeOperationDue();
    await ctx.container.provisionerLoop.tick();
    await makeOperationDue();
    await ctx.container.provisionerLoop.tick();

    const service = await services.findById(tenantA, serviceId);
    const ops = await operations.listForService(tenantA, serviceId, 50);
    const open = ops.filter(
      (operation) => operation.state === 'PLANNED' || operation.state === 'IN_FLIGHT',
    );
    expect(
      service?.state === 'UNRECONCILED' ? open.length : 1,
      'a service left UNRECONCILED always has open work to resolve it',
    ).toBeGreaterThan(0);
    expect(
      ops.filter((operation) => operation.state === 'UNKNOWN').length,
      'no unknown outlives the reconcile that answered it',
    ).toBe(0);
  });

  it('refuses to sell a device limit the panel cannot apply', async () => {
    /*
     * A product freezes `deviceLimit` for whichever panel it names, and nothing checked
     * that the panel could apply it. `MarzbanAdapter.createUser` builds its body from
     * `username`, `expire`, `data_limit` and `data_limit_reset_strategy` and never reads
     * the field — so a customer buying a two-device plan on a Marzban panel received an
     * unrestricted account and the operation was recorded SUCCEEDED. The number the
     * customer paid for vanished between the order snapshot and the panel with nothing
     * anywhere saying so.
     *
     * Driven here through the CAPABILITY rather than through Marzban, because a fake
     * Marzban would prove what the fake does. The panel under test is a real 3X-UI that
     * really does apply `limitIp`; taking `LIMIT_DEVICES` off the descriptor makes it
     * stand for any adapter that cannot, which is the condition the production rule
     * actually tests.
     */
    const descriptor = providerDescriptor('sanaei');
    const original = descriptor?.capabilities;
    Object.defineProperty(descriptor, 'capabilities', {
      value: (original ?? []).filter((capability) => capability !== 'LIMIT_DEVICES'),
      configurable: true,
    });
    try {
      const orderId = await paidOrder('device-limit');
      await ctx.container.provisionerLoop.tick();

      const service = await services.findByOrderId(tenantA, orderId);
      expect(
        service?.state,
        'nothing is created, because what would be created is not what was sold',
      ).toBe('PENDING_PROVISION');
      expect(addClientCalls(), 'and the panel was never dialled').toBe(0);

      const ops = await operations.listForService(tenantA, service?.id ?? '', 10);
      expect(
        ops[0]?.state,
        'CAPABILITY_UNSUPPORTED is permanent: no retry teaches an adapter a field',
      ).toBe('FAILED');
    } finally {
      Object.defineProperty(descriptor, 'capabilities', {
        value: original,
        configurable: true,
      });
    }
  });

  it('stops dialling a panel that answered with a wrong password', async () => {
    /*
     * Two different questions, and the provisioner used to ask only one.
     *
     * `failureOutcome` says whether the request certainly did not take effect — a fact
     * about the wire that decides FAILED versus UNKNOWN. It does NOT say whether trying
     * again could help, which is what `PROVIDER_FAILURE_RETRYABLE` answers, and which
     * marks AUTHENTICATION_FAILED false with the reason written beside it: each attempt
     * counts against the panel's own login limiter.
     *
     * Re-planning every definitive failure meant a mistyped panel password produced five
     * unattended wrong logins on a 30/60/120-second backoff, which is how an operator
     * gets locked out of their own panel by their own bot.
     */
    await ctx.container.panels.setCredentials(tenantA, owner, panelId, {
      credentials: { password: 'not-the-panel-password' },
      idempotencyKey: 'wrong-password',
    });
    const orderId = await paidOrder('bad-password');

    await ctx.container.provisionerLoop.tick();

    const serviceId = (await services.findByOrderId(tenantA, orderId))?.id ?? '';
    const ops = await operations.listForService(tenantA, serviceId, 10);
    const create = ops.find((operation) => operation.type === 'PROVISION');
    expect(
      create?.state,
      'a non-retryable failure is terminal at once, not after four more logins',
    ).toBe('FAILED');
    expect(create?.attempts, 'and it spent exactly the one attempt it was given').toBe(1);
  });

  it('does not announce twice when the sender dies between the send and the record', async () => {
    const orderId = await paidOrder('stranded-send');
    await ctx.container.provisionerLoop.tick();
    const serviceId = (await services.findByOrderId(tenantA, orderId))?.id ?? '';
    const sentFirst = sent.length;

    /*
     * A sweep killed after Telegram accepted the message and before the outcome was
     * written. The row stays PENDING behind nothing but a lease, and when that lease
     * expires the AUTOMATIC lane announced again — breaking the rule
     * `deliveryStateAfter` states in as many words, on an ordinary container restart.
     */
    await ctx.container.database.db.execute(
      sql`UPDATE services
             SET delivery_state = 'PENDING',
                 delivered_at = NULL,
                 delivery_send_started_at = now() - interval '1 hour',
                 delivery_next_attempt_at = now() - interval '1 hour'
           WHERE id = ${serviceId}`,
    );

    await ctx.container.provisionerLoop.tick();

    const service = await services.findById(tenantA, serviceId);
    expect(
      service?.deliveryState,
      'an unaccounted send leaves the automatic lane as UNCONFIRMED',
    ).toBe('UNCONFIRMED');
    expect(sent.length, 'and the customer is not told a second time').toBe(sentFirst);
    expect(service?.state, 'the service itself is untouched by any of this').toBe('ACTIVE');
  });

  it('creates one account when a create is cut off after the panel stored it', async () => {
    // The client IS written, and the connection dies before the answer arrives.
    panel.setBehaviour('add-client-lost-reply');
    const orderId = await paidOrder('lost-reply');

    await ctx.container.provisionerLoop.tick();

    const lost = await services.findByOrderId(tenantA, orderId);
    /*
     * A connection torn down mid-response reads as `UNREACHABLE`, which
     * `SAFE_TO_REPLAY_FAILURE_KINDS` calls safe — and here it is NOT: the request was
     * fully sent and the panel committed the write. `SafeHttpClient` cannot tell a
     * refused connection from a reset one after the fact, so the taxonomy is optimistic
     * for exactly this shape. `docs/open-questions.md` records it.
     *
     * What this case exists to prove is that the optimism costs an attempt and never an
     * account, because the DERIVED username makes the retry collide instead of
     * duplicating. That containment is the claim; this is the test of it.
     */
    expect(lost?.state, 'the retry is still pending').toBe('PENDING_PROVISION');
    expect(panel.clients.size, 'and the panel really does have the account').toBe(1);

    /*
     * And it is NOT announced while it waits.
     *
     * The sweep takes ACTIVE services only. Without that predicate this service — born
     * `PENDING` with no next-attempt time, so immediately due — would be claimed, found
     * to have no subscription URL, and recorded `FAILED`; and `FAILED` is not in
     * `DELIVERY_AUTO_RETRY_STATES`, so the customer would never be told even after the
     * provisioning eventually succeeded.
     */
    const early = await ctx.container.delivery.deliverDue(tenantA, 10);
    expect(early.claimed, 'an unprovisioned service is not due for delivery').toBe(0);
    expect(lost?.deliveryAttempts, 'and no attempt was spent on it').toBe(0);
    expect(sent).toHaveLength(0);

    // The panel answers again, and the retry meets the account it already made.
    panel.setBehaviour('healthy');
    await makeOperationDue();
    await ctx.container.provisionerLoop.tick();

    /*
     * v3.7.0 refuses a duplicate email with a successful envelope carrying
     * `success: false` — a `PROVIDER_ERROR`, which `failureOutcome` classifies UNKNOWN
     * on a mutating call, which is the state that means "ask the panel". The tick then
     * DRAINS: the next `runOnce` plans the reconcile, claims it and adopts what is
     * there, so one tick carries the service all the way to ACTIVE.
     */
    const adopted = await services.findByOrderId(tenantA, orderId);
    expect(addClientCalls(), 'the retry did reach the panel').toBe(2);
    expect(panel.clients.size, 'and it did NOT make a second account').toBe(1);
    expect(adopted?.state, 'the account was found and adopted').toBe('ACTIVE');
    expect(adopted?.subscriptionUrl).not.toBeNull();
    expect(adopted?.expiresAt, 'with the duration the order paid for').not.toBeNull();
    expect(addClientCalls(), 'and the reconcile created nothing').toBe(2);
    expect(panel.clients.size, 'one account, for one paid order').toBe(1);

    const all = await operations.listForService(tenantA, adopted?.id ?? '', 10);
    expect(all.map((o) => o.type).sort()).toEqual(['PROVISION', 'RECONCILE']);
    expect(all.find((o) => o.type === 'RECONCILE')?.state).toBe('SUCCEEDED');

    // And now that it is ACTIVE, the customer is told.
    expect(sent, 'the announcement follows the adoption').toHaveLength(1);
    expect(adopted?.deliveryState).toBe('DELIVERED');
  });

  it('bounds the create-reconcile-absent cycle instead of dialling for ever', async () => {
    // A 5xx that stored nothing: indistinguishable from a lost answer, from here.
    panel.setBehaviour('add-client-500');
    const orderId = await paidOrder('absent');

    /*
     * One tick DRAINS, so the whole cycle runs inside it: create fails UNKNOWN, the
     * reconcile asks the panel, the panel proves absence, a fresh create is planned —
     * and round again.
     *
     * Absence is what makes a fresh create legal, and that is right ONCE. Left
     * unbounded it is a loop with no ceiling at all: each round derives a new operation
     * id from the round before, so nothing collides and the per-operation attempt
     * ceiling never applies. A panel that fails every create while answering every
     * lookup "absent" would be dialled for ever at the tenant's budget. This test
     * exists because writing it is what found that.
     */
    await ctx.container.provisionerLoop.tick();

    expect(addClientCalls(), 'three cycles, and then it stops').toBe(3);
    expect(panel.clients.size).toBe(0);

    const stalled = await services.findByOrderId(tenantA, orderId);
    const serviceId = stalled?.id ?? '';
    expect(stalled?.state, 'left where a retry can reach it').toBe('PENDING_PROVISION');
    expect(
      await operations.findOpen(tenantA, serviceId, 'PROVISION'),
      'and with nothing claimable, so the loop cannot restart itself',
    ).toBeNull();
    expect(await operations.findOpen(tenantA, serviceId, 'RECONCILE')).toBeNull();

    // An operator has a row to act on.
    const events = await ctx.container.database.db.execute(
      sql`SELECT code, context FROM operational_events WHERE code = 'provisioning.stalled'`,
    );
    expect(events.rows, 'the operator is told').toHaveLength(1);

    // Another tick changes nothing at all: no operation, no call.
    await ctx.container.provisionerLoop.tick();
    expect(addClientCalls(), 'and it stays stopped').toBe(3);

    /*
     * And the deliberate way back in still works.
     *
     * `retryProvisioning` is the remedy the stalled condition points at, and the panel
     * having recovered is exactly when an operator presses it.
     */
    panel.setBehaviour('healthy');
    await ctx.container.provisioning.retryProvisioning(tenantA, owner, serviceId, {
      idempotencyKey: 'operator-retry-absent',
    });
    await ctx.container.provisionerLoop.tick();

    const active = await services.findByOrderId(tenantA, orderId);
    expect(active?.state).toBe('ACTIVE');
    expect(panel.clients.size, 'one account, for one paid order').toBe(1);
    expect(addClientCalls(), 'the three that failed, and the one that worked').toBe(4);

    const rows = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM services WHERE order_id = ${orderId}`,
    );
    expect((rows.rows[0] as { n: number }).n).toBe(1);
  });

  it('holds off a stopped tenant without spending an attempt on it', async () => {
    const orderId = await paidOrder('stopped-provision');
    const service = await services.findByOrderId(tenantA, orderId);
    const serviceId = service?.id ?? '';

    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
    );

    /*
     * Five ticks, which is `OPERATION_MAX_ATTEMPTS`.
     *
     * The gate itself had no test — CLAUDE.md names this as a non-negotiable and names
     * panels as the module that skipped it — and neither did the accounting. A hold-off
     * that SPENT its attempt left the operation PLANNED at the ceiling after exactly
     * this many ticks, where `claimDue` can never select it again: an operator stopping
     * a tenant for twenty-five seconds retired a paid order that no panel ever heard
     * about, silently.
     */
    for (let tick = 0; tick < 5; tick += 1) await ctx.container.provisionerLoop.tick();

    expect(addClientCalls(), 'a stopped tenant dials nothing').toBe(0);
    const held = await operations.listForService(tenantA, serviceId, 10);
    expect(held, 'and plans nothing new').toHaveLength(1);
    expect(held[0]?.state, 'the operation is still claimable').toBe('PLANNED');
    expect(held[0]?.attempts, 'a hold-off contacted nothing, so it costs nothing').toBe(0);

    // Restarting the tenant resumes it, which is the point.
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${tenantA.tenantId}`,
    );
    await ctx.container.provisionerLoop.tick();
    expect(addClientCalls()).toBe(1);
    expect((await services.findByOrderId(tenantA, orderId))?.state).toBe('ACTIVE');
  });

  it('gives up announcing after the attempts are spent, and says so', async () => {
    reply = (_request, response) => {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden' }));
    };
    const orderId = await paidOrder('deliver-ceiling');

    /*
     * `DELIVERY_MAX_ATTEMPTS` attempts, then `FAILED`.
     *
     * The ceiling and the long argument for why it is lower than
     * `OPERATION_MAX_ATTEMPTS` described behaviour nothing checked: replacing the whole
     * branch with "always PENDING" — never give up — passed the suite.
     */
    await ctx.container.provisionerLoop.tick();
    for (let attempt = 1; attempt < 3; attempt += 1) {
      await makeDeliveryDue();
      await ctx.container.delivery.deliverDue(tenantA, 10);
    }

    const service = await services.findByOrderId(tenantA, orderId);
    expect(sent, 'three attempts, and no more').toHaveLength(3);
    expect(service?.deliveryAttempts).toBe(3);
    expect(service?.deliveryState, 'and then it needs a person').toBe('FAILED');
    expect(service?.state, 'the service is still the one they paid for').toBe('ACTIVE');

    // FAILED is never swept again, whatever the clock says.
    await makeDeliveryDue();
    const sweep = await ctx.container.delivery.deliverDue(tenantA, 10);
    expect(sweep.claimed).toBe(0);
    expect(sent).toHaveLength(3);
  });
});
