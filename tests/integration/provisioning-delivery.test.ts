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
    panel.requests.filter((request) => request.path.includes('addClient')).length;

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
     * interleave proves nothing, and two sequential sweeps prove the stronger thing —
     * the claim's predicate no longer holds for the second caller whatever the timing.
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
});
