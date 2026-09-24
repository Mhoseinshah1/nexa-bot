import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ProductCategoryId } from '@nexa/contracts';
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
import { operationIdFor } from '../../apps/api/src/infrastructure/crypto/operation-id';
import {
  SERVICES_PAGE_CALLBACK_PREFIX,
  SERVICES_PAGE_SIZE,
} from '../../apps/api/src/surfaces/telegram/bot-runtime';
import { encodeKeysetToken } from '../../apps/api/src/surfaces/telegram/keyset-token';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { DrizzleOperationRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-operation.repository';
import { SUPERSEDED_BY_AUTOMATIC_REFUND } from '../../apps/api/src/modules/commerce/payments/application/refund.service';
import { CANARY, startFake3xUi, type Fake3xUi } from '../support/fake-3xui';
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
      /*
       * The schema's floor, because one case here waits out a real deadline.
       *
       * `refunds nothing while the outcome is UNKNOWN` needs a create that times out
       * rather than one that is refused, and a timeout is only observable by waiting
       * for it. Every other case answers on loopback in single-digit milliseconds, so
       * a one-second bound is three orders of magnitude of headroom for them and the
       * difference between a 1-second case and an 11-second one for that.
       */
      PANEL_HTTP_TIMEOUT_MS: '1000',
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
    /*
     * And CONNECTION-TESTED, which the create alone is not.
     *
     * `panels.create` writes an ACTIVE row and contacts nothing, so since this
     * hotfix the panel is `UNVALIDATED` and cannot be sold onto — a brand-new
     * row being immediately sellable is one of the holes being closed. The
     * fake panel here is real and reachable, so recording a successful
     * connection test is exactly what an operator would do next.
     */
    await validatePanelConnection(ctx.container, tenantA, panelId);

    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-deliv',
      telegramUserId: '910910',
      from: { id: 910910, first_name: 'مریم' },
      botInstanceId: BOT_A,
    });
    customerA = resolved.customer.id;
  });

  /** A settled order, which is what plans a provisioning operation. */
  /**
   * The order's first create, ended without an account and left for an operator.
   *
   * A fixture for a state `retireExhausted` or an operator's abandon produces: the
   * PROVISION operation is terminal, the service still PENDING_PROVISION and the order
   * still PAID. It is what lets an operator's refund in under WP10 P3, which refuses one
   * while the purchase operation is undecided.
   */
  async function firstCreateEnded(orderId: OrderId): Promise<void> {
    await ctx.container.database.db.execute(sql`
      UPDATE provisioning_operations
         SET state = 'FAILED', completed_at = now(), claimed_by = NULL, lease_until = NULL
       WHERE tenant_id = ${tenantA.tenantId} AND order_id = ${orderId} AND type = 'PROVISION'`);
  }

  /** The operator's retry of that service, which plans a fresh create. */
  async function retryAfterRefund(orderId: OrderId, key: string): Promise<void> {
    const service = await services.findByOrderId(tenantA, orderId);
    await ctx.container.provisioning.retryProvisioning(tenantA, owner, service?.id ?? '', {
      idempotencyKey: key,
    });
  }

  async function paidOrder(key: string): Promise<OrderId> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
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

  /**
   * The same order, paid by BANK TRANSFER rather than from the wallet.
   *
   * Which channel the money arrived through is what decides the shape of an
   * operator's refund of it: `REFUND_METHOD_SUPPORT` resolves `MANUAL_TRANSFER` to
   * `EXTERNAL_MANUAL`, so the refund is born `AWAITING_EXTERNAL` and waits for a
   * human to send the money and record it. A wallet payment's refund is
   * `WALLET_CREDIT` and COMPLETED the moment it is written, which is why
   * `paidOrder` cannot produce the state the case below needs.
   */
  async function transferPaidOrder(key: string): Promise<{ orderId: OrderId; paymentId: string }> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
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
    const { payment } = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor(key),
      customerA,
      { idempotencyKey: `${key}-manual`, orderId: confirmed.id },
    );
    await ctx.container.payments.confirmManualTransfer(tenantA, owner, payment.id, {
      idempotencyKey: `${key}-confirm-transfer`,
      note: 'کارت به کارت',
    });
    return { orderId: confirmed.id, paymentId: payment.id };
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

  /**
   * Ages a service so its usage figure is stale, without waiting out the cadence.
   *
   * `created_at` as well as `usage_synced_at`, because `listUsageSyncDue` measures
   * staleness as `COALESCE(usage_synced_at, created_at)` — a service whose create
   * returned no usage, which every Sanaei service is, is measured from when it was
   * made. Moving only one of the two columns would leave the test unable to tell a
   * sweep that read the panel from one that never found the row.
   */
  async function makeUsageStale(): Promise<void> {
    await ctx.container.database.db.execute(
      sql`UPDATE services SET created_at = now() - interval '30 days',
                              usage_synced_at = NULL`,
    );
  }

  /** How many times the panel was asked for a client's traffic. */
  const trafficCalls = (): number =>
    panel.requests.filter((request) => request.path.includes('panel/api/clients/traffic/')).length;

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

  it('does not spend an attempt when Telegram rate-limits the announcement', async () => {
    /*
     * The defect `docs/phase4h-audit.md` §6b measured, against a real 429.
     *
     * Every link was individually defensible: `send-message.ts` returns
     * `FAILED_RETRYABLE`, the messenger collapsed every retryable failure into
     * `UNKNOWN`, `deliveryStateAfter(PENDING, 'UNKNOWN', n)` is `UNCONFIRMED`, and the
     * claim takes `PENDING` only. Composed, one 429 withheld a PAID customer's
     * subscription link until a person noticed — and Telegram sends a 429 exactly when
     * the most customers are waiting for that message.
     *
     * Three assertions, because the rule has three halves and mutating any one of them
     * away must fail this case:
     *   - the state stays PENDING, so the next sweep re-claims it;
     *   - the attempt counter does NOT move, because it bounds definite refusals and
     *     three bursts would otherwise fail a link Telegram never rejected on its
     *     merits;
     *   - the backoff honours Telegram's own `retry_after`.
     */
    reply = (_request, response) => {
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 900',
          /*
           * Deliberately LONGER than `DELIVERY_BACKOFF_MS` (five minutes).
           *
           * With a shorter value the assertion below cannot tell "honoured Telegram's
           * number" from "fell back to our floor" — and a first version of this test
           * used thirty seconds, so replacing `result.retryAfterMs ?? BACKOFF` with a
           * bare `BACKOFF` left it green. A test that cannot distinguish the rule from
           * its absence is not a test.
           */
          parameters: { retry_after: 900 },
        }),
      );
    };
    const before = ctx.container.clock.now().getTime();
    const orderId = await paidOrder('deliver-rate-limited');

    await ctx.container.provisionerLoop.tick();

    const service = await services.findByOrderId(tenantA, orderId);
    expect(service?.state, 'a rate limit does not unprovision a service').toBe('ACTIVE');
    expect(service?.deliveryState, 'and it stays re-claimable').toBe('PENDING');
    expect(service?.deliveryAttempts, 'a rate limit is not a refusal of this message').toBe(0);
    expect(service?.deliveredAt).toBeNull();
    /* Telegram said fifteen minutes. Anything sooner is us inventing a number. */
    const retryAt = service?.deliveryNextAttemptAt?.getTime() ?? 0;
    expect(retryAt).toBeGreaterThanOrEqual(before + 900_000);
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
      expect(addClientCalls(), 'the panel was never dialled').toBe(0);

      const ops = await operations.listForService(tenantA, service?.id ?? '', 10);
      expect(
        ops[0]?.state,
        'CAPABILITY_UNSUPPORTED is permanent: no retry teaches an adapter a field',
      ).toBe('FAILED');
      /*
       * And the customer gets their money back rather than a row nobody will move.
       *
       * This case used to assert the service stayed `PENDING_PROVISION` — which was
       * the truthful description of a service that was never created, and also a row
       * holding a capacity slot on a panel that can never fill it, for an order that
       * was paid for. There is no state for that any more: the create failed
       * definitively, so the service is terminated and the order is refunded in the
       * transaction that records the failure.
       */
      expect(service?.state, 'nothing was created, and nothing holds a slot').toBe('TERMINATED');
      const order = (await ctx.container.database.db.execute(
        sql`SELECT state FROM orders WHERE id = ${orderId}` as never,
      )) as unknown as { rows: { state: string }[] };
      expect(order.rows[0]?.state).toBe('REFUNDED');
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
    /*
     * BOUGHT FIRST, then the password is broken — and that order is now forced
     * rather than incidental.
     *
     * Replacing a credential changes `connectionIdentityOf`, so the panel's
     * recorded connection test stops vouching for what it is NOW and the sale is
     * refused as `UNVALIDATED`. That is the hotfix working: a panel whose
     * password was changed after its last probe is not a panel this installation
     * has evidence about. What this case is about is what the PROVISIONER does
     * with a wrong password, which needs an order that was legitimately taken
     * while the panel was still sound.
     */
    const orderId = await paidOrder('bad-password');
    await ctx.container.panels.setCredentials(tenantA, owner, panelId, {
      credentials: { password: 'not-the-panel-password' },
      idempotencyKey: 'wrong-password',
    });

    await ctx.container.provisionerLoop.tick();

    const serviceId = (await services.findByOrderId(tenantA, orderId))?.id ?? '';
    const ops = await operations.listForService(tenantA, serviceId, 10);
    const create = ops.find((operation) => operation.type === 'PROVISION');
    expect(
      create?.state,
      'a non-retryable failure is terminal at once, not after four more logins',
    ).toBe('FAILED');
    expect(create?.attempts, 'and it spent exactly the one attempt it was given').toBe(1);

    /*
     * And the customer is not left paying for it while an operator finds the typo.
     *
     * The third of the three terminal branches that refund — this one is
     * `persistFailure`, where the panel ANSWERED and the answer was definitive. The
     * capability case above is `refuse`, where nothing was contacted, and the
     * reconcile-cycle case is the ceiling that leaves no terminal row at all. Each
     * is asserted where it happens, because a refund wired into one of the three
     * looks exactly like a refund wired into all of them until a panel fails the
     * other way.
     */
    const row = (await ctx.container.database.db.execute(
      sql`SELECT o.state, r.state AS refund_state, r.reason
            FROM orders o LEFT JOIN refunds r ON r.order_id = o.id
           WHERE o.id = ${orderId}` as never,
    )) as unknown as {
      rows: { state: string; refund_state: string | null; reason: string | null }[];
    };
    expect(row.rows).toEqual([
      { state: 'REFUNDED', refund_state: 'COMPLETED', reason: 'UNDELIVERABLE' },
    ]);
    expect(
      (await services.findByOrderId(tenantA, orderId))?.state,
      'and the slot is back, because nothing was created to hold it',
    ).toBe('TERMINATED');
  });

  it('credits only what is LEFT when an operator already returned part of it', async () => {
    /*
     * There is one answer to "how much did we give back", and it is a sum.
     *
     * `refundUndeliverable` locks the payment, sums the refunds already committed
     * against it, and credits the REMAINDER — it does not credit the price. Nothing
     * else could: an operator may have returned part of a purchase for their own
     * reason before the provisioner ever dialled, and a second writer that credits
     * the full amount hands the customer more than they paid, in two rows that each
     * look correct on their own. That is the defect a ledger exists to make
     * impossible, so it is asserted as a ledger: two refunds, one total.
     *
     * The order is the correctness and it is asserted as one: the partial goes in
     * FIRST, while the order is still PAID and deliverable, and the create fails
     * afterwards.
     *
     * WP10 P3 refuses an operator's refund while the purchase operation is undecided,
     * so the partial can no longer go in while the first create is merely PLANNED. The
     * state is still reachable, and this reaches it the way production does: the first
     * create ended, the operator refunded part, and then retried the provisioning.
     */
    const orderId = await paidOrder('partial-then-failed');
    const paymentRow = (await ctx.container.database.db.execute(
      sql`SELECT id FROM payments WHERE order_id = ${orderId}` as never,
    )) as unknown as { rows: { id: string }[] };
    await firstCreateEnded(orderId);
    await ctx.container.refunds.request(tenantA, owner, {
      idempotencyKey: 'partial-refund',
      paymentId: paymentRow.rows[0]?.id ?? '',
      amountMinor: 100_000n,
      reason: 'GOODWILL',
    });
    await retryAfterRefund(orderId, 'retry-partial');

    // And now it cannot be delivered at all.
    await ctx.container.panels.setCredentials(tenantA, owner, panelId, {
      credentials: { password: 'not-the-panel-password' },
      idempotencyKey: 'wrong-password-partial',
    });
    await ctx.container.provisionerLoop.tick();

    const ledger = (await ctx.container.database.db.execute(
      sql`SELECT amount::text AS amount, reason, requested_by_admin_id IS NULL AS automatic
            FROM refunds WHERE order_id = ${orderId} ORDER BY amount` as never,
    )) as unknown as {
      rows: { amount: string; reason: string; automatic: boolean }[];
    };
    expect(ledger.rows, 'the remainder, not the price').toEqual([
      { amount: '100000', reason: 'GOODWILL', automatic: false },
      { amount: '150000', reason: 'UNDELIVERABLE', automatic: true },
    ]);

    const credited = (await ctx.container.database.db.execute(
      sql`SELECT coalesce(sum(amount), 0)::text AS total FROM wallet_entries
           WHERE customer_id = ${customerA} AND reason = 'REFUND'` as never,
    )) as unknown as { rows: { total: string }[] };
    expect(
      credited.rows[0]?.total,
      'and the wallet got back exactly the price, once, across both',
    ).toBe('250000');
  });

  it('abandons an operator s unsent refund and returns the whole amount', async () => {
    /*
     * An amount RESERVED by a refund that has not happened is not an amount returned.
     *
     * `REFUND_CONSUMING_STATES` counts `REQUESTED` and `AWAITING_EXTERNAL` against the
     * refundable balance, which is right for the operator path — it is what stops two
     * operators each refunding one payment in full. Applied to the automatic refund it
     * produced the defect this case names: the operator's unsent 100,000 was subtracted,
     * the customer was credited 150,000, and the order went terminal. When the operator
     * then marked that transfer FAILED — because they never sent it — its amount became
     * refundable again with no path left to return it. The customer was permanently
     * 100,000 short, and every row involved looked correct. Found by Codex.
     *
     * So the unfinished ones are FAILED here, in this transaction, BEFORE the sum — and
     * the customer gets the whole 250,000 in one credit.
     *
     * Paid by transfer rather than from the wallet, because that is what produces an
     * `AWAITING_EXTERNAL` refund at all: a wallet refund is COMPLETED when written, and
     * a COMPLETED one is money that really moved, so it is subtracted — which the case
     * above asserts and this one must not contradict.
     */
    const { orderId, paymentId } = await transferPaidOrder('unsent-then-failed');
    // Reached through the operator's retry, for the reason the case above gives (P3).
    await firstCreateEnded(orderId);
    const unsent = await ctx.container.refunds.request(tenantA, owner, {
      idempotencyKey: 'unsent-refund',
      paymentId,
      amountMinor: 100_000n,
      reason: 'GOODWILL',
    });
    expect(unsent.state, 'the operator has recorded an intention, not a transfer').toBe(
      'AWAITING_EXTERNAL',
    );
    await retryAfterRefund(orderId, 'retry-unsent');

    // And now the account cannot be created at all.
    await ctx.container.panels.setCredentials(tenantA, owner, panelId, {
      credentials: { password: 'not-the-panel-password' },
      idempotencyKey: 'wrong-password-unsent',
    });
    await ctx.container.provisionerLoop.tick();

    const ledger = (await ctx.container.database.db.execute(
      sql`SELECT amount::text AS amount, state, channel, reason, completion_note
            FROM refunds WHERE order_id = ${orderId} ORDER BY amount` as never,
    )) as unknown as {
      rows: {
        amount: string;
        state: string;
        channel: string;
        reason: string;
        completion_note: string | null;
      }[];
    };
    expect(
      ledger.rows,
      'the unsent one is abandoned and says why; the whole price goes back',
    ).toEqual([
      {
        amount: '100000',
        state: 'FAILED',
        channel: 'EXTERNAL_MANUAL',
        reason: 'GOODWILL',
        completion_note: SUPERSEDED_BY_AUTOMATIC_REFUND,
      },
      {
        amount: '250000',
        state: 'COMPLETED',
        channel: 'WALLET_CREDIT',
        reason: 'UNDELIVERABLE',
        completion_note: null,
      },
    ]);

    const credited = (await ctx.container.database.db.execute(
      sql`SELECT coalesce(sum(amount), 0)::text AS total, count(*)::int AS n
            FROM wallet_entries
           WHERE customer_id = ${customerA} AND reason = 'REFUND'` as never,
    )) as unknown as { rows: { total: string; n: number }[] };
    expect(
      credited.rows[0],
      'the customer is whole, in one entry — not short by an amount nobody sent',
    ).toEqual({ total: '250000', n: 1 });

    const order = (await ctx.container.database.db.execute(
      sql`SELECT state FROM orders WHERE id = ${orderId}` as never,
    )) as unknown as { rows: { state: string }[] };
    expect(order.rows[0]?.state).toBe('REFUNDED');
  });

  it('refunds nothing while the outcome is UNKNOWN, and waits for the read', async () => {
    /*
     * The rule the whole lane turns on, asserted at the moment it would be broken.
     *
     * A create whose answer was lost MAY have taken effect. Refunding it gives the
     * money back for an account the customer is holding — so `persistFailure` refunds
     * on `FAILED` and never on `UNKNOWN`, and that check is SEPARATE from `!retryable`,
     * which is true for an `UNKNOWN` too. Collapsing the two is a one-word edit, and
     * this case is what dies when somebody makes it.
     *
     * `add-client-hang` is the shape that produces the ambiguity honestly: the panel
     * STORES the client and then never answers, so the request times out — `TIMEOUT`,
     * which `SAFE_TO_REPLAY_FAILURE_KINDS` deliberately excludes — and the account the
     * customer paid for really is on the panel. A refund here would be money returned
     * for a working service. The reconcile that follows asks, finds it PRESENT, and
     * the order is fulfilled: the outcome UNKNOWN was always waiting for.
     */
    const orderId = await paidOrder('unknown-not-refunded');
    panel.setBehaviour('add-client-hang');

    await ctx.container.provisionerLoop.tick();

    const serviceId = (await services.findByOrderId(tenantA, orderId))?.id ?? '';
    const ops = await operations.listForService(tenantA, serviceId, 10);
    const create = ops.find((operation) => operation.type === 'PROVISION');
    expect(create?.failureKind, 'the answer was lost, not refused').toBe('TIMEOUT');
    expect(create?.state, 'and a lost answer is never a definitive failure').not.toBe('FAILED');
    expect(
      ops.some((operation) => operation.type === 'RECONCILE'),
      'the remedy for an unknown is a read, and it was planned',
    ).toBe(true);
    expect(panel.clients.size, 'the account the customer paid for really is there').toBe(1);

    /*
     * Which the read then finds — so the money stays where the customer put it and the
     * service is delivered. Both halves are asserted, because "no refund" alone is
     * also what a stuck lane produces.
     */
    const refunds = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM refunds WHERE order_id = ${orderId}` as never,
    )) as unknown as { rows: { n: number }[] };
    expect(refunds.rows[0]?.n, 'and nothing went back for an account that exists').toBe(0);
    const order = (await ctx.container.database.db.execute(
      sql`SELECT state FROM orders WHERE id = ${orderId}` as never,
    )) as unknown as { rows: { state: string }[] };
    expect(order.rows[0]?.state, 'the order was paid and stays paid').toBe('PAID');
    expect(
      (await services.findByOrderId(tenantA, orderId))?.state,
      "the reconcile found the account and the service is the customer's",
    ).toBe('ACTIVE');
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
     * The retry meets its own account and the panel says so.
     *
     * v3.7.0 exempts a MATCHING `subId` from `checkEmailsExistForClients` and then
     * drops any client already on the inbound, returning `(false, nil)` when that
     * leaves nothing — which the controller reports as success. Nexa's three
     * identities are derived per service, so the replay carries the same email and
     * the same subId: the panel treats it as the idempotent no-op it is, and the
     * PROVISION operation simply SUCCEEDS. No reconcile is needed, because nothing
     * was ever unknown.
     *
     * This assertion used to expect a `PROVIDER_ERROR` and a RECONCILE, on the
     * strength of a docblock saying v3.7.0 "refuses a duplicate email". A real
     * v3.7.0 panel does not, and `tests/acceptance/real-panel-sanaei.test.ts`
     * is what established that — the fake had been written to agree with the
     * adapter rather than with upstream.
     *
     * The claim this case exists to make is unchanged and still proven below: the
     * optimism in `SAFE_TO_REPLAY_FAILURE_KINDS` costs an ATTEMPT and never an
     * ACCOUNT, because the derived username makes the retry collide with itself.
     */
    const adopted = await services.findByOrderId(tenantA, orderId);
    expect(addClientCalls(), 'the retry did reach the panel').toBe(2);
    expect(panel.clients.size, 'and it did NOT make a second account').toBe(1);
    expect(adopted?.state, 'the replay completed the provision').toBe('ACTIVE');
    expect(adopted?.subscriptionUrl).not.toBeNull();
    expect(adopted?.expiresAt, 'with the duration the order paid for').not.toBeNull();
    expect(panel.clients.size, 'one account, for one paid order').toBe(1);

    const all = await operations.listForService(tenantA, adopted?.id ?? '', 10);
    expect(all.map((o) => o.type).sort()).toEqual(['PROVISION']);
    expect(all.find((o) => o.type === 'PROVISION')?.state).toBe('SUCCEEDED');

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
    expect(
      await operations.findOpen(tenantA, serviceId, 'PROVISION'),
      'nothing claimable, so the loop cannot restart itself',
    ).toBeNull();
    expect(await operations.findOpen(tenantA, serviceId, 'RECONCILE')).toBeNull();

    /*
     * An operator was told — and then told it was over.
     *
     * `provisioning.stalled` is an ERROR keyed on the SERVICE, and its only recoveries
     * are deliveries of that service. A service this lane has terminated, for an order
     * it has refunded, can never produce one: before the refund recorded its own
     * recovery, every definitive failure left an open ERROR nobody and nothing could
     * ever close — an operator queue that only grows, which is the exact thing the
     * two-outcome decision deleted. Found by Codex.
     *
     * So the assertion is both halves. The row exists, because the operator needs to
     * know a paid service could not be created; and it is RESOLVED, because the
     * product has already answered it by giving the money back. The panel's OWN
     * condition is a different code with its own recovery and stays open — the panel
     * is still broken.
     */
    const events = (await ctx.container.database.db.execute(
      sql`SELECT code, resolved_at IS NOT NULL AS closed FROM operational_events
           WHERE code IN ('provisioning.stalled', 'order.refunded_undeliverable')
           ORDER BY code` as never,
    )) as unknown as { rows: { code: string; closed: boolean }[] };
    expect(events.rows, 'told, then told it was answered — in two rows, not three').toEqual([
      { code: 'order.refunded_undeliverable', closed: false },
      { code: 'provisioning.stalled', closed: true },
    ]);

    /*
     * And the CUSTOMER is not left in the ceiling with it.
     *
     * This is the case the cycle bound was hardest on before: nothing claimable,
     * nothing in the reconcile queue, and a `PENDING_PROVISION` row holding a
     * capacity slot for an order that was paid for — a dead end whose only exit was
     * an operator noticing the condition. The exits are now the two the product has.
     * The create the reconcile proved absent three times is settled as the definitive
     * failure it is: the service is terminated, the slot is back, and the money is on
     * the customer's wallet.
     *
     * The panel's condition stays open, because the panel is still broken and the
     * next purchase would land in the same place.
     */
    expect(stalled?.state, 'the service is ended, not parked').toBe('TERMINATED');
    const order = (await ctx.container.database.db.execute(
      sql`SELECT state FROM orders WHERE id = ${orderId}` as never,
    )) as unknown as { rows: { state: string }[] };
    expect(order.rows[0]?.state).toBe('REFUNDED');
    const refunds = (await ctx.container.database.db.execute(
      sql`SELECT state, reason FROM refunds WHERE order_id = ${orderId}` as never,
    )) as unknown as { rows: { state: string; reason: string }[] };
    expect(refunds.rows, 'one refund, for the lane that had nobody in it').toEqual([
      { state: 'COMPLETED', reason: 'UNDELIVERABLE' },
    ]);

    // Another tick changes nothing at all: no operation, no call, no second refund.
    await ctx.container.provisionerLoop.tick();
    expect(addClientCalls(), 'and it stays stopped').toBe(3);
    expect((await refundsFor(orderId)).length, 'and refunds once').toBe(1);

    /*
     * `retryProvisioning` is no longer the way back in, and the refusal is the point.
     *
     * It used to be the remedy the stalled condition pointed at. A terminated service
     * cannot be provisioned — `OPERATION_LEGAL_FROM.PROVISION` is `PENDING_PROVISION`
     * alone — so pressing it against a refunded order is refused rather than creating
     * an account for money that has gone back. The customer buys again; the operator
     * fixes the panel.
     */
    panel.setBehaviour('healthy');
    await expect(
      ctx.container.provisioning.retryProvisioning(tenantA, owner, serviceId, {
        idempotencyKey: 'operator-retry-absent',
      }),
    ).rejects.toMatchObject({ code: expect.any(String) });
    expect(panel.clients.size, 'and no account was created for a refunded order').toBe(0);

    const rows = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM services WHERE order_id = ${orderId}`,
    );
    expect((rows.rows[0] as { n: number }).n).toBe(1);
  });

  /** Every refund against one order, so "exactly one" is asserted and not assumed. */
  async function refundsFor(orderId: string): Promise<readonly { state: string }[]> {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT state FROM refunds WHERE order_id = ${orderId}` as never,
    )) as unknown as { rows: { state: string }[] };
    return rows.rows;
  }

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

  // =========================================================================
  // SYNC_USAGE — the figure a customer is told, refreshed from the panel
  // =========================================================================

  it('refreshes a stale usage figure from the panel, and writes what the panel said', async () => {
    const orderId = await paidOrder('usage-ok');
    await ctx.container.provisionerLoop.tick();
    const provisioned = await services.findByOrderId(tenantA, orderId);
    expect(provisioned?.state).toBe('ACTIVE');
    // 3X-UI answers `obj: null` to a create, so there is no figure yet. That is the
    // ordinary case and the reason this sweep exists.
    expect(provisioned?.usageSyncedAt, 'a create leaves no usage figure').toBeNull();

    // The customer uses their service. Only the PANEL knows this.
    const username = provisioned?.providerUsername ?? '';
    panel.useTraffic(username, { up: 1_000_000, down: 24_000_000 });

    await makeUsageStale();
    const before = trafficCalls();
    await ctx.container.provisionerLoop.tick();

    expect(trafficCalls(), 'the panel was asked').toBe(before + 1);
    const synced = await services.findByOrderId(tenantA, orderId);
    expect(synced?.trafficUsedBytes, 'up + down, as the panel reports them').toBe(25_000_000n);
    expect(synced?.usageSyncedAt, 'and when it was asked').not.toBeNull();
    expect(synced?.state, 'a read moves no service').toBe('ACTIVE');

    const all = await operations.listForService(tenantA, synced?.id ?? '', 10);
    expect(all.map((o) => o.type).sort()).toEqual(['PROVISION', 'SYNC_USAGE']);
    expect(all.find((o) => o.type === 'SYNC_USAGE')?.state).toBe('SUCCEEDED');
  });

  it('does not sync a service whose figure is still fresh', async () => {
    // The cadence is the whole point of the setting. A service provisioned moments ago
    // is not stale, and a sweep that read it anyway would spend a tenant's outbound
    // budget re-reading an account the call before it had just created.
    await paidOrder('usage-fresh');
    await ctx.container.provisionerLoop.tick();
    const before = trafficCalls();

    await ctx.container.provisionerLoop.tick();
    await ctx.container.provisionerLoop.tick();

    expect(trafficCalls(), 'no panel read for a fresh figure').toBe(before);
  });

  it('plans ONE sync per cadence window however many ticks run', async () => {
    // The operation id is derived from the service and the window, and `plan` is
    // ON CONFLICT DO NOTHING — which is what makes two replicas on a rolling update
    // produce one row between them rather than two reads of the same figure.
    const orderId = await paidOrder('usage-once');
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, orderId);
    await makeUsageStale();

    await ctx.container.provisionerLoop.tick();
    // The first tick performed the sync; age it again so the PLANNER would queue
    // another if the derived id did not stop it.
    await makeUsageStale();
    await ctx.container.provisionerLoop.tick();

    const syncs = (await operations.listForService(tenantA, service?.id ?? '', 20)).filter(
      (operation) => operation.type === 'SYNC_USAGE',
    );
    expect(syncs, 'one sync for one cadence window').toHaveLength(1);
  });

  it('a sync that the panel refuses is FAILED, never UNKNOWN, and moves no service', async () => {
    // The rule `finishUsageSync` rests on: `isMutatingOperation('SYNC_USAGE')` is false,
    // so `failureOutcome` gives FAILED. An UNKNOWN would send the service to
    // UNRECONCILED — a working, paid service moved by a read that timed out.
    const orderId = await paidOrder('usage-refused');
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, orderId);

    await makeUsageStale();
    panel.setBehaviour('traffic-500');
    await ctx.container.provisionerLoop.tick();

    const after = await services.findByOrderId(tenantA, orderId);
    expect(after?.state, 'a failed read moves nothing').toBe('ACTIVE');
    expect(after?.usageSyncedAt, 'and claims no refresh it did not make').toBeNull();
    const sync = (await operations.listForService(tenantA, service?.id ?? '', 20)).find(
      (operation) => operation.type === 'SYNC_USAGE',
    );
    /*
     * Back to PLANNED for another attempt, with the failure recorded — NOT `UNKNOWN`.
     *
     * The distinction is the claim. `UNKNOWN` means "a mutation may have taken effect
     * and this installation must ask", and it is what sends a service to
     * `UNRECONCILED`. A read that did not answer changed nothing by definition, so it
     * is retried by the ordinary attempt machinery and the service stays where it is.
     * Terminal `FAILED` arrives only at `OPERATION_MAX_ATTEMPTS`, which one tick is not.
     */
    expect(sync?.state).toBe('PLANNED');
    expect(sync?.state).not.toBe('UNKNOWN');
    expect(sync?.failureKind).toBe('PROVIDER_ERROR');
    expect(sync?.attempts).toBe(1);
  });

  /** Plans one operation by hand, for the types no code plans. */
  async function planByHand(
    serviceId: string,
    orderId: OrderId,
    type: 'ROTATE_SUBSCRIPTION' | 'TERMINATE' | 'SUSPEND' | 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME',
    label: string,
  ): Promise<void> {
    await ctx.container.uow.run(tenantA, async (tx) =>
      operations.plan(
        tenantA,
        {
          id: ctx.container.ids.uuid(),
          // Derived, because `provisioning_operations_operation_id_check` requires
          // sixteen lowercase hex characters. A uuid is refused by the database, which
          // is the schema saying the same thing the application does: an operation id
          // is retry-stable, not random.
          operationId: operationIdFor('provider', label),
          serviceId,
          orderId,
          /*
           * Null: these are planned by hand, by nobody. Each case here is about what
           * the EXECUTOR does with a type, never about who is told afterwards — the
           * announcer's rule has its own cases in
           * `tests/unit/operation-outcome-announcer.test.ts`.
           */
          requestedByCustomerId: null,
          panelId: panelId as PanelId,
          type,
          /*
           * A target for the three commercial types and none for the others.
           *
           * `provisioning_operations_target_present_check` refuses a commercial row
           * with neither field and `..._target_check` refuses one on any other type, so
           * this is not a convenience: it is the only shape the database will take.
           */
          ...(type === 'RENEW' || type === 'ADD_TRAFFIC' || type === 'ADD_TIME'
            ? {
                target: {
                  expiresAt: new Date(ctx.container.clock.now().getTime() + 86_400_000),
                  trafficLimitBytes: 1_000n,
                },
              }
            : {}),
        },
        ctx.container.clock.now(),
        tx,
      ),
    );
  }

  it('refuses a rotation on a panel that cannot rotate, before contacting a panel', async () => {
    /*
     * This case used to be "an operation type this release cannot perform", made with
     * `ROTATE_SUBSCRIPTION`, and ABANDONED. RickPanel's `rotateSubscription` made that
     * type performable, and with it every member of `OPERATION_TYPES` is: there is no
     * contract type left that reaches `isPerformableOperation`'s refusal, so that branch
     * waits for the next type the contract gains, and `tests/unit/registries.test.ts`
     * pins the performable list so such a type cannot slip in without its branch.
     *
     * What remains true for this panel is the other refusal. A 3X-UI declares no
     * `ROTATE_SUBSCRIPTION_LINK`, so `decideOperability` refuses before a socket is
     * opened, and the row stops as FAILED with `CAPABILITY_UNSUPPORTED` — terminal,
     * because no retry gives a panel a capability.
     *
     * Planned by hand because no surface offers a rotation on this panel: the Web Admin
     * and Telegram Admin both ask the same evaluator, which answers CAPABILITY.
     */
    const orderId = await paidOrder('usage-unperformable');
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, orderId);
    const before = panel.requests.length;
    const linkBefore = service?.subscriptionUrl;

    await planByHand(service?.id ?? '', orderId, 'ROTATE_SUBSCRIPTION', 'unperformable-rotate');
    await ctx.container.provisionerLoop.tick();

    expect(panel.requests.length, 'the panel was not contacted at all').toBe(before);
    const rotate = (await operations.listForService(tenantA, service?.id ?? '', 20)).find(
      (operation) => operation.type === 'ROTATE_SUBSCRIPTION',
    );
    expect(rotate?.state).toBe('FAILED');
    expect(rotate?.failureMessage).toBe('CAPABILITY_UNSUPPORTED');
    const after = await services.findByOrderId(tenantA, orderId);
    expect(after?.state, 'and the service is untouched').toBe('ACTIVE');
    expect(after?.subscriptionUrl, 'and so is its link').toBe(linkBefore);
  });

  it('refuses a performable operation on a panel that cannot do it, before contacting it', async () => {
    /*
     * The other half, and the one the 3X-UI deferral rests on. `TERMINATE` has a branch
     * in the executor now, so `isPerformableOperation` lets it through — and the panel
     * is a 3X-UI, whose descriptor declares no `DELETE_USER`. `decideOperability` reads
     * `OPERATION_REQUIRED_CAPABILITIES` against that descriptor and refuses.
     *
     * Terminal FAILED rather than ABANDONED, and the difference is exact:
     * `refusalIsPermanent` says CAPABILITY_UNSUPPORTED cannot be fixed without a new
     * release, so the row stops instead of being claimed on every tick. The panel is
     * not contacted either way, which is the assertion that matters — a customer's
     * account on a panel this release cannot manage is not touched by an operation it
     * cannot carry out.
     */
    const orderId = await paidOrder('sanaei-terminate');
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, orderId);
    const before = panel.requests.length;

    await planByHand(service?.id ?? '', orderId, 'TERMINATE', 'sanaei-terminate-refused');
    await ctx.container.provisionerLoop.tick();

    expect(panel.requests.length, 'the panel was not contacted at all').toBe(before);
    const terminate = (await operations.listForService(tenantA, service?.id ?? '', 20)).find(
      (operation) => operation.type === 'TERMINATE',
    );
    expect(terminate?.state).toBe('FAILED');
    expect(terminate?.failureMessage).toBe('CAPABILITY_UNSUPPORTED');
    expect((await services.findByOrderId(tenantA, orderId))?.state).toBe('ACTIVE');
  });

  it('refuses each commercial operation on a 3X-UI panel, before contacting it', async () => {
    /*
     * The owner's Phase 4F scope decision, made mechanical.
     *
     * `RENEW`, `ADD_TRAFFIC` and `ADD_TIME` all have executor branches now, so
     * `isPerformableOperation` lets each through — and the panel is a 3X-UI, whose
     * descriptor declares none of `RENEW_USER`, `ADD_VOLUME` or `ADD_TIME`.
     * `decideOperability` reads `OPERATION_REQUIRED_CAPABILITIES` against that
     * descriptor and refuses before a socket is opened.
     *
     * All THREE, not one of them. They are three separate capabilities and three
     * separate predicates, so a descriptor edit that added one would leave the other
     * two refusing — and a test that checked only a renewal would pass while extra
     * traffic was quietly sold on a panel that cannot apply it.
     *
     * Terminal FAILED rather than ABANDONED, for the reason the terminate case above
     * gives: `refusalIsPermanent` says CAPABILITY_UNSUPPORTED cannot be fixed without a
     * new release, so the row stops instead of being claimed on every tick.
     */
    /*
     * ONE SERVICE PER TYPE, not three operations against one.
     *
     * `provisioning_operations_open_commercial_key` admits one open commercial action
     * per service across all three types, so planning three for one service is a state
     * the database refuses — correctly, and for a reason this case is not about: two
     * absolute targets computed from one reading of a service charge twice and apply
     * once. Three services keeps this case testing the capability refusal it is named
     * for rather than colliding with the serialisation rule.
     */
    const planned: {
      readonly type: 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME';
      readonly serviceId: string;
      readonly orderId: OrderId;
    }[] = [];
    for (const type of ['RENEW', 'ADD_TRAFFIC', 'ADD_TIME'] as const) {
      const orderId = await paidOrder(`sanaei-${type.toLowerCase()}`);
      await ctx.container.provisionerLoop.tick();
      const service = await services.findByOrderId(tenantA, orderId);
      planned.push({ type, serviceId: service?.id ?? '', orderId });
    }
    /*
     * The creates AND their subscription deliveries are drained before the baseline is
     * taken. A delivery landing after it would be counted as this case's, and the
     * assertion below would fail for a reason that has nothing to do with capabilities.
     */
    await ctx.container.provisionerLoop.tick();
    const before = panel.requests.length;
    expect(before, 'the three creates did contact the panel').toBeGreaterThan(0);

    for (const { type, serviceId, orderId } of planned) {
      await planByHand(serviceId, orderId, type, `sanaei-${type.toLowerCase()}`);
    }
    await ctx.container.provisionerLoop.tick();
    await ctx.container.provisionerLoop.tick();
    await ctx.container.provisionerLoop.tick();

    expect(panel.requests.length, 'no commercial operation contacted the panel').toBe(before);
    for (const { type, serviceId } of planned) {
      const rows = await operations.listForService(tenantA, serviceId, 20);
      const operation = rows.find((one) => one.type === type);
      expect(operation?.state, type).toBe('FAILED');
      expect(operation?.failureMessage, type).toBe('CAPABILITY_UNSUPPORTED');
      // And the customer's service is exactly as it was.
      expect((await services.findById(tenantA, serviceId))?.state).toBe('ACTIVE');
    }
  });

  // =========================================================================
  // Expiry — a Nexa-side transition, with no panel contacted
  // =========================================================================

  it('expires a service whose window has closed, without contacting the panel', async () => {
    const orderId = await paidOrder('expire-ok');
    await ctx.container.provisionerLoop.tick();
    const active = await services.findByOrderId(tenantA, orderId);
    expect(active?.state).toBe('ACTIVE');
    expect(active?.expiresAt, 'the create wrote a window').not.toBeNull();

    const requestsBefore = panel.requests.length;
    await ctx.container.database.db.execute(
      sql`UPDATE services SET expires_at = now() - interval '1 minute'`,
    );
    await ctx.container.provisionerLoop.tick();

    const expired = await services.findByOrderId(tenantA, orderId);
    expect(expired?.state).toBe('EXPIRED');
    /*
     * No panel was contacted, and that is the point rather than an optimisation.
     * 3X-UI enforces the `expiryTime` written into the client at creation, so the
     * account has ALREADY stopped working; what was missing was Nexa agreeing. A
     * provider call here would spend a tenant's outbound budget to be told something
     * this installation already knew.
     */
    expect(panel.requests.length, 'expiry needs no panel').toBe(requestsBefore);
  });

  it('leaves an unlimited service alone for ever', async () => {
    // `expires_at IS NULL` is an unlimited plan. A sweep that treated NULL as "long
    // past" would expire every unlimited service on its first tick — and the adapter
    // writes the panel's own unlimited rather than an epoch, so there is no zero here
    // to be mistaken for a date in 1970 either.
    const orderId = await paidOrder('expire-unlimited');
    await ctx.container.provisionerLoop.tick();
    await ctx.container.database.db.execute(sql`UPDATE services SET expires_at = NULL`);

    await ctx.container.provisionerLoop.tick();
    await ctx.container.provisionerLoop.tick();

    const service = await services.findByOrderId(tenantA, orderId);
    expect(service?.state).toBe('ACTIVE');
  });

  it('does not expire a service whose window is still open', async () => {
    const orderId = await paidOrder('expire-future');
    await ctx.container.provisionerLoop.tick();
    await ctx.container.database.db.execute(
      sql`UPDATE services SET expires_at = now() + interval '30 days'`,
    );

    await ctx.container.provisionerLoop.tick();

    const service = await services.findByOrderId(tenantA, orderId);
    expect(service?.state).toBe('ACTIVE');
  });

  it('records the state the service was actually in, not the one it moved to', async () => {
    /*
     * The reason `expireDue` runs one statement per source state. `RETURNING` hands
     * back the NEW row, so a single UPDATE over {ACTIVE, SUSPENDED} would report
     * EXPIRED as the `before` of every audit record — a record of nothing.
     *
     * SUSPENDED is set here by hand because nothing suspends a service yet: the
     * provider mutations are gated behind the destructive real-panel acceptance. The
     * row shape is real even though no code writes it today, and this is what stops
     * the audit going wrong on the release that does.
     */
    const orderId = await paidOrder('expire-suspended');
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, orderId);
    await ctx.container.database.db.execute(
      sql`UPDATE services SET state = 'SUSPENDED', expires_at = now() - interval '1 minute'`,
    );

    await ctx.container.provisionerLoop.tick();

    const expired = await services.findByOrderId(tenantA, orderId);
    expect(expired?.state).toBe('EXPIRED');

    const records = await ctx.container.database.db.execute(
      sql`SELECT before, after FROM audit_logs
          WHERE action = 'service.expire' AND entity_id = ${service?.id ?? ''}`,
    );
    expect(records.rows).toHaveLength(1);
    expect((records.rows[0] as { before: { state: string } }).before.state).toBe('SUSPENDED');
    expect((records.rows[0] as { after: { state: string } }).after.state).toBe('EXPIRED');
  });

  it('expires nothing for a tenant that has stopped accepting work', async () => {
    // Expiry is a durable write, so it is inside `uow.run` and behind the same tenant
    // gate every other write in the tick is. A stopped tenant accepts none of them.
    const orderId = await paidOrder('expire-stopped');
    await ctx.container.provisionerLoop.tick();
    await ctx.container.database.db.execute(
      sql`UPDATE services SET expires_at = now() - interval '1 minute'`,
    );
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
    );

    await ctx.container.provisionerLoop.tick();

    const service = await services.findByOrderId(tenantA, orderId);
    expect(service?.state, 'a stopped tenant gets no writes').toBe('ACTIVE');
  });

  // =========================================================================
  // The customer's own services, over Telegram
  // =========================================================================

  /** An update as Telegram sends one, through the real runtime rather than the webhook. */
  let updateSeq = 7000;
  const customerUpdate = (
    payload: Record<string, unknown>,
  ): {
    idempotencyKey: string;
    botInstanceId: typeof BOT_A;
    update: unknown;
    telegramUserId: string;
    from: unknown;
  } => {
    updateSeq += 1;
    return {
      idempotencyKey: `bot-update-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      update: { update_id: updateSeq, ...payload },
      telegramUserId: '910910',
      from: { id: 910910, first_name: 'مریم' },
    };
  };

  const textUpdate = (text: string) =>
    customerUpdate({
      message: {
        message_id: updateSeq,
        date: 0,
        chat: { id: 5150, type: 'private' },
        from: { id: 910910, is_bot: false, first_name: 'مریم' },
        text,
      },
    });

  const tapUpdate = (data: string, chatType = 'private') =>
    customerUpdate({
      callback_query: {
        id: `cbq-${String(updateSeq)}`,
        from: { id: 910910, is_bot: false, first_name: 'مریم' },
        data,
        // The message a button hangs off is the BOT's. A runtime reading `message.from`
        // would resolve a customer row for the bot on every tap.
        message: {
          message_id: updateSeq,
          date: 0,
          chat: { id: 5150, type: chatType },
          from: { id: 999999, is_bot: true, first_name: 'Nexa' },
        },
      },
    });

  /**
   * The same tap, from a DIFFERENT Telegram account.
   *
   * `customerUpdate` hardcodes one customer because almost every case here is about
   * that customer's own service. The cursor cases are not: a page token is a position
   * and carries no authority, and proving that needs a second person replaying it.
   */
  const tapUpdateAs = (data: string, telegramUserId: string, firstName: string) => {
    updateSeq += 1;
    return {
      idempotencyKey: `bot-update-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      update: {
        update_id: updateSeq,
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: firstName },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: 5151, type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: firstName },
    };
  };

  const runtime = () => ctx.container.botRuntime;

  /**
   * Only the `sendMessage` calls.
   *
   * A tapped button also produces an `answerCallbackQuery` to stop the spinner, so
   * `sent[sent.length - 1]` after a tap is the spinner and not the answer. Counting or
   * reading the raw array is how an assertion about a message ends up looking at an
   * acknowledgement with no text in it.
   */
  const messages = () => sent.filter((one) => one.url.includes('/sendMessage'));

  it('/services lists the customer’s own service, labelled as it was SOLD', async () => {
    const orderId = await paidOrder('bot-services');
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, orderId);

    const result = await runtime().handle(tenantA, systemActor('bot'), textUpdate('/services'));

    expect(result.intent).toBe('SERVICES');
    expect(result.replyKey).toBe('bot.service.list_heading');
    /*
     * The label is the plan's frozen title, not the product's current one and not the
     * service id. `nexa_orders_snapshot_guard` froze it at confirmation, which is the
     * only copy that still says what the customer agreed to — the legacy defect where
     * renaming a product rewrote past reports, applied to something a customer reads.
     */
    const listed = messages()[messages().length - 1];
    expect(JSON.stringify(listed)).toContain('پلن پایه');
    expect(JSON.stringify(listed)).toContain(`s:${service?.id ?? ''}`);
  });

  it('answers a customer with no services with a different key, not an empty list', async () => {
    const result = await runtime().handle(tenantA, systemActor('bot'), textUpdate('/services'));
    expect(result.replyKey).toBe('bot.service.list_empty');
  });

  /**
   * The bound became a PAGE, and this is what proves it.
   *
   * Before Phase 6A the list was `SERVICES_PAGE_SIZE` services and silence: the
   * repository returned a `nextCursor` and the surface dropped it, so a customer with
   * more than twenty saw twenty and was told nothing about the rest. Twenty is above any
   * list `docs/research/` shows, which is why nobody noticed and not why it was all
   * right.
   *
   * Twenty-one services, built the way the product builds them — a settled order each,
   * no panel involved — because the defect only exists above the bound and a fixture at
   * or below it cannot see either the presence of the button or its absence.
   */
  it('offers a next page rather than silently showing twenty of twenty-one services', async () => {
    const created: string[] = [];
    for (let index = 0; index < SERVICES_PAGE_SIZE + 1; index += 1) {
      const orderId = await paidOrder(`bot-page-${String(index)}`);
      const service = await services.findByOrderId(tenantA, orderId);
      created.push(service?.id ?? '');
    }

    const first = await runtime().handle(tenantA, systemActor('bot'), textUpdate('/services'));
    expect(first.replyKey).toBe('bot.service.list_heading');
    const firstBody = JSON.stringify(messages()[messages().length - 1]);
    const firstPage = created.filter((id) => firstBody.includes(`s:${id}`));
    expect(firstPage, 'the page is the bound, not the whole list').toHaveLength(SERVICES_PAGE_SIZE);
    expect(firstBody, 'and it says there is more').toContain(SERVICES_PAGE_CALLBACK_PREFIX);

    /*
     * The token is taken from the button the bot actually drew, never rebuilt here.
     * A test that constructed its own cursor would pass against a surface that drew a
     * broken one.
     */
    const token = /"l:([^"]+)"/.exec(firstBody)?.[1];
    if (token === undefined) throw new Error(`no page token in ${firstBody}`);
    expect(Buffer.byteLength(`l:${token}`, 'utf8')).toBeLessThanOrEqual(64);

    const second = await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`l:${token}`));
    expect(second.intent).toBe('SERVICES_PAGE');
    expect(second.replyKey).toBe('bot.service.list_heading');
    const secondBody = JSON.stringify(messages()[messages().length - 1]);
    const secondPage = created.filter((id) => secondBody.includes(`s:${id}`));

    /* The twenty-first, and NOT one the first page already showed. */
    expect(secondPage).toHaveLength(1);
    expect(firstPage).not.toContain(secondPage[0]);
    /* And the traversal ends: no further button on the last page. */
    expect(secondBody).not.toContain(SERVICES_PAGE_CALLBACK_PREFIX);

    /* Every service was reachable across the two pages, none twice. */
    expect(new Set([...firstPage, ...secondPage]).size).toBe(SERVICES_PAGE_SIZE + 1);
  });

  it('draws no next-page button for a customer whose services fit on one page', async () => {
    await paidOrder('bot-one-page');
    const result = await runtime().handle(tenantA, systemActor('bot'), textUpdate('/services'));

    expect(result.replyKey).toBe('bot.service.list_heading');
    expect(JSON.stringify(messages()[messages().length - 1])).not.toContain(
      SERVICES_PAGE_CALLBACK_PREFIX,
    );
  });

  it('answers a crafted page token with the unsupported reply, not an error', async () => {
    /*
     * `callback_data` is client text. A token this codec did not produce is refused at
     * the BOUNDARY — the same place a crafted uuid is — so it never reaches the
     * `timestamptz` and `uuid` casts the query performs. The customer gets the reply
     * any other string this bot does not understand gets.
     */
    await paidOrder('bot-bad-token');
    for (const token of ['', 'not-a-cursor', 'zz.0011', '-1.0011']) {
      const result = await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`l:${token}`));
      expect(result.intent, token).toBe('UNSUPPORTED');
    }
  });

  it('shows one customer their own page only, on a token another customer produced', async () => {
    /*
     * A cursor is a POSITION, not an authority. The list is scoped to the tenant and to
     * the customer resolved from the update, so replaying somebody else's token pages
     * through the replayer's own services — and here that customer has none, so it is
     * the empty answer rather than a peek at another customer's list.
     */
    const orderId = await paidOrder('bot-foreign-cursor');
    const mine = await services.findByOrderId(tenantA, orderId);
    const token = encodeKeysetToken({
      createdAt: '2099-01-01 00:00:00.000000+00',
      id: mine?.id ?? '',
    });
    if (token === null) throw new Error('fixture cursor did not encode');

    const other = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('other'), {
      idempotencyKey: 'resolve-other-cursor',
      telegramUserId: '910911',
      from: { id: 910911, first_name: 'سارا' },
      botInstanceId: BOT_A,
    });
    expect(other.customer.id).not.toBe(mine?.customerId);

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdateAs(`l:${token}`, '910911', 'سارا'),
    );
    expect(result.replyKey).toBe('bot.service.list_empty');
    expect(JSON.stringify(messages()[messages().length - 1])).not.toContain(`s:${mine?.id ?? ''}`);
  });

  it('shows one service, with the moment its usage was read', async () => {
    const orderId = await paidOrder('bot-detail');
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, orderId);

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`s:${service?.id ?? ''}`),
    );

    expect(result.intent).toBe('SERVICE');
    expect(result.replyKey).toBe('bot.service.detail');
    // `usage_synced_at` is null until a SYNC_USAGE succeeds, so the template gets an
    // absent `syncedAt` rather than a fabricated one. A figure with no asOf is a figure
    // a customer reads as live.
    expect(service?.usageSyncedAt).toBeNull();
    const shown = messages()[messages().length - 1];
    expect(JSON.stringify(shown)).toContain('پلن پایه');
  });

  it('refuses another customer’s service with the SAME answer as one that does not exist', async () => {
    /*
     * The property that stops this being an oracle. `getForCustomer` compares ownership
     * against the row it read rather than filtering the query, so a foreign id and a
     * nonexistent id are one outcome — and both must reach the customer as one message,
     * or the difference between the two answers tells anybody holding a service id
     * whether it exists.
     *
     * The OTHER customer taps, rather than the service being reassigned. Reassigning it
     * was the first shape and the database refused it: `services_order_fk` is composite
     * on `(tenant_id, order_id, customer_id)`, so a service cannot change hands without
     * its order. That is the schema making the same point this test does, and the
     * realistic version — somebody else pressing the button — is the one a customer can
     * actually perform.
     */
    const orderId = await paidOrder('bot-foreign');
    await ctx.container.provisionerLoop.tick();
    const theirs = await services.findByOrderId(tenantA, orderId);

    // From here on, so the ORIGINAL announcement to the real owner — which of course
    // carries the subscription — is not mistaken for something a stranger was shown.
    const before = messages().length;

    const stranger = (data: string) => ({
      ...tapUpdate(data),
      telegramUserId: '920920',
      from: { id: 920920, first_name: 'سارا' },
    });

    const foreign = await runtime().handle(
      tenantA,
      systemActor('bot'),
      stranger(`s:${theirs?.id ?? ''}`),
    );
    const absent = await runtime().handle(
      tenantA,
      systemActor('bot'),
      stranger(`s:${ctx.container.ids.uuid()}`),
    );

    expect(foreign.replyKey).toBe('bot.service.not_found');
    expect(absent.replyKey).toBe(foreign.replyKey);
    // And a stranger asking for a resend is refused by the same comparison, before
    // `redeliver`'s own ownership check ever runs.
    const resend = await runtime().handle(
      tenantA,
      systemActor('bot'),
      stranger(`r:${theirs?.id ?? ''}`),
    );
    expect(resend.replyKey).toBe('bot.service.not_found');
    expect(JSON.stringify(messages().slice(before))).not.toContain(theirs?.subscriptionRef ?? 'X');
  });

  it('offers no management button for a service on a panel that cannot manage one', async () => {
    /*
     * The customer-facing half of the 3X-UI deferral. `customerActionsFor` asks the
     * PANEL whether it can perform each operation, and this panel's descriptor declares
     * no DISABLE_USER, ENABLE_USER or DELETE_USER — so a customer here is offered a
     * subscription resend and nothing else.
     *
     * Drawing them anyway would be the legacy defect this codebase keeps naming: a
     * product offering an action it cannot honour. Every tap would be refused by
     * `requestFromCustomer` and the customer would have no way to know which of their
     * services the buttons work on.
     */
    const orderId = await paidOrder('bot-no-management');
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, orderId);
    const id = service?.id ?? '';

    const result = await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`s:${id}`));

    expect(result.replyKey).toBe('bot.service.detail');
    const body = JSON.stringify(messages()[messages().length - 1]);
    expect(body, 'the resend button is still offered').toContain(`r:${id}`);
    for (const prefix of ['u:', 'e:', 't:', 'k:']) {
      expect(body, `${prefix} must not be offered on a panel that cannot do it`).not.toContain(
        `${prefix}${id}`,
      );
    }

    // And the request itself is refused, not merely undrawn.
    const tapped = await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`u:${id}`));
    expect(tapped.replyKey).toBe('bot.service.capability_unsupported');
    expect(
      (await operations.listForService(tenantA, id, 50)).some(
        (operation) => operation.type === 'SUSPEND',
      ),
      'nothing was planned',
    ).toBe(false);
  });

  it('sends the subscription again when the customer asks, through the delivery lane', async () => {
    const orderId = await paidOrder('bot-resend');
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, orderId);
    expect(service?.deliveryState, 'the automatic announcement already ran').toBe('DELIVERED');
    const before = messages().length;

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`r:${service?.id ?? ''}`),
    );

    /*
     * `key: null`, and the message still arrives.
     *
     * `DeliveryService.redeliver` is what sends it — through the same `markSendStarted`
     * stamp and the same delivery accounting the automatic sweep uses, so a
     * customer-requested send and a swept one cannot race each other into two messages.
     * A reply key here as well would be the runtime and the delivery lane both
     * answering one tap.
     */
    expect(result.intent).toBe('SERVICE_RESEND');
    expect(result.replyKey).toBeNull();
    expect(messages().length, 'and the subscription really went out').toBeGreaterThan(before);
    const resent = messages()[messages().length - 1];
    expect(JSON.stringify(resent)).toContain(service?.subscriptionRef ?? 'MISSING');

    const after = await services.findByOrderId(tenantA, orderId);
    expect(after?.deliveryAttempts, 'the attempt is accounted for').toBeGreaterThan(
      service?.deliveryAttempts ?? 0,
    );
  });

  it('will not resend a subscription into a group chat', async () => {
    /*
     * A subscription link is a bearer capability. Delivering it anywhere other than the
     * private chat it was asked from is how one lands in a group — and falling back to
     * the chat it was FIRST delivered to would be the same mistake wearing a
     * justification.
     */
    const orderId = await paidOrder('bot-resend-group');
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, orderId);
    const before = messages().length;

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`r:${service?.id ?? ''}`, 'supergroup'),
    );

    expect(result.replyKey).toBe('bot.service.not_found');
    // NOT_ATTEMPTED because `privateChatIdOf` refuses a group, so `handle` has nowhere
    // to send the refusal either. The customer sees nothing, which is right: the tap
    // came from a chat this bot will not talk to about a subscription.
    expect(result.sent, 'and nothing was sent anywhere').toBe('NOT_ATTEMPTED');
    expect(messages().length).toBe(before);
  });

  it('answers a blocked customer with bot.blocked, whatever they tapped', async () => {
    const orderId = await paidOrder('bot-blocked-services');
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, orderId);
    // Through the SERVICE, not an UPDATE. `customers_blocked_at_check` refuses a
    // BLOCKED row with no `blocked_at`, which is the schema saying a block is an event
    // with a time and not a flag — and a fixture that wrote the flag by hand would be
    // testing a row shape no code path can produce.
    await ctx.container.customers.block(tenantA, owner, {
      idempotencyKey: 'block-for-bot-services',
      customerId: customerA,
      reason: 'fixture',
    });
    const before = messages().length;

    const detail = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`s:${service?.id ?? ''}`),
    );
    const resend = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`r:${service?.id ?? ''}`),
    );

    expect(detail.replyKey).toBe('bot.blocked');
    expect(resend.replyKey).toBe('bot.blocked');
    // The blocked branch runs BEFORE `act`, so no subscription was read and none sent.
    expect(JSON.stringify(messages().slice(before))).not.toContain(service?.subscriptionRef ?? 'X');
  });
});
