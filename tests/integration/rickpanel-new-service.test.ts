import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  UNLIMITED_TRAFFIC_BYTES,
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
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
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
 * A RickPanel-backed NEW_SERVICE, end to end: settle -> provision -> read back ->
 * deliver the link. `docs/rickpanel-create-hotfix.md`.
 *
 * The defect this holds: the RickPanel create omitted `proxies`, the owner's panel
 * refused it, and every purchase ended in a refund. The adapter's unit tests prove the
 * request now carries the seed. These prove what that is FOR, through the shipped
 * container — the real provisioner, the real `RickpanelAdapter` over the real
 * `SafeHttpClient`, the real ledger and the real delivery lane — against a fake that
 * refuses an unseeded create as the owner's panel did.
 *
 * And they hold the money rules on the two ways a create still fails: a deterministic
 * refusal refunds exactly once and is never retried, and an ambiguous answer refunds
 * nothing and is settled by a READ, never by a blind second create.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('a RickPanel NEW_SERVICE', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[];
  let panel: FakeRickpanel;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let panelId: string;
  let customerId: UserId;
  let owner: ActorContext;

  beforeAll(async () => {
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        // A photo goes out as multipart; a body that is not JSON is kept raw rather
        // than thrown on, which would leave the request unanswered and the send UNCONFIRMED.
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
    sent = [];

    // 127.0.0.2: the container's URL policy denies the host its own data services
    // listen on, which is 127.0.0.1 here. A panel in private space is reachable.
    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-rick', roleKeys: ['owner'] }),
    );

    // Through the SERVICE, with an EMPTY activation: a RickPanel needs nothing
    // configured, and no protocol or inbound is chosen anywhere on the way to a sale.
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Rick',
      providerType: 'rickpanel',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: {},
      idempotencyKey: 'panel-rick-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);

    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-rick',
      telegramUserId: '920920',
      from: { id: 920920, first_name: 'سارا' },
      botInstanceId: BOT_A,
    });
    customerId = resolved.customer.id;
  });

  /** A wallet-settled order for one product. What plans the PROVISION. */
  async function paidOrder(key: string, trafficBytes: bigint): Promise<OrderId> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ریک',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        // No device limit: the RickPanel descriptor does not declare LIMIT_DEVICES.
        specification: { durationDays: 30, trafficBytes, deviceLimit: null },
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

  const walletEntries = async () =>
    (
      (await ctx.container.database.db.execute(
        sql`SELECT direction, reason, amount::text AS amount
              FROM wallet_entries WHERE customer_id = ${customerId}
             ORDER BY created_at, id` as never,
      )) as unknown as { rows: { direction: string; reason: string; amount: string }[] }
    ).rows;

  const orderState = async (orderId: OrderId) =>
    (
      (await ctx.container.database.db.execute(
        sql`SELECT state FROM orders WHERE id = ${orderId}` as never,
      )) as unknown as { rows: { state: string }[] }
    ).rows[0]?.state;

  const purchases = async () =>
    (await walletEntries()).filter((one) => one.direction === 'DEBIT' && one.reason === 'PURCHASE');
  const refunds = async () => (await walletEntries()).filter((one) => one.reason === 'REFUND');

  async function makeOperationDue(): Promise<void> {
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET next_attempt_at = now() - interval '1 hour'`,
    );
  }

  /** The create request the panel received, as the panel parsed it. */
  const createBodies = () =>
    panel.requests
      .filter((one) => one.method === 'POST' && one.path === '/api/user')
      .map((one) => JSON.parse(one.body) as Record<string, unknown>);

  it('creates, reads back and delivers the link: one debit, one account, no refund', async () => {
    const orderId = await paidOrder('rick-ok', 53_687_091_200n);

    await ctx.container.provisionerLoop.tick();

    const service = await services.findByOrderId(tenantA, orderId);
    expect(service?.state, 'the RickPanel create did not deliver').toBe('ACTIVE');
    const held = panel.users.get(service?.providerUsername ?? 'none');
    expect(held, 'the panel holds no account under the stored name').toBeDefined();
    // The link is the panel's own, from the READ-BACK, made absolute on the address
    // the operator configured.
    expect(service?.subscriptionUrl).toBe(
      `${panel.baseUrl}/sub/${service?.providerUsername ?? ''}/${held?.subToken ?? ''}`,
    );
    // And the READ happened: a create 200 carries no link, so without the read-back
    // there would be nothing to store.
    expect(
      panel.requests.some(
        (one) =>
          one.method === 'GET' && one.path === `/api/user/${service?.providerUsername ?? ''}`,
      ),
    ).toBe(true);

    // The seed, and nothing a customer or operator chose.
    expect(createBodies()).toHaveLength(1);
    expect(createBodies()[0]?.['proxies']).toEqual({ vless: {} });
    expect(createBodies()[0]).not.toHaveProperty('inbounds');

    // Delivered in the same tick, and the message carries the link — and none of the
    // credentials the panel generated behind it.
    expect(service?.deliveryState).toBe('DELIVERED');
    expect(sent).toHaveLength(1);
    // The card is a photo: the link is in its caption, inside the raw multipart body.
    const text = String(sent[0]?.body['text'] ?? sent[0]?.body['unparseable']);
    expect(text).toContain(service?.subscriptionUrl ?? 'no-url');
    expect(text).not.toContain('internal-');

    expect(await purchases(), 'exactly one debit').toHaveLength(1);
    expect(await refunds(), 'a delivered order is not refunded').toHaveLength(0);
    // PAID is the delivered order's resting state: it has no later one, and the
    // service beside it is what says it was delivered.
    expect(await orderState(orderId)).toBe('PAID');

    // Another sweep changes nothing: no second create, no second debit, no refund.
    await makeOperationDue();
    await ctx.container.provisionerLoop.tick();
    expect(panel.createCalls()).toBe(1);
    expect(panel.users.size).toBe(1);
    expect(await purchases()).toHaveLength(1);
    expect(await refunds()).toHaveLength(0);
  });

  it('creates a LIMITED plan with the traffic it was sold, and an unlimited one as 0', async () => {
    const limited = await paidOrder('rick-limited', 1_073_741_824n);
    const unlimited = await paidOrder('rick-unlimited', UNLIMITED_TRAFFIC_BYTES);

    await ctx.container.provisionerLoop.tick();
    await ctx.container.provisionerLoop.tick();

    const one = await services.findByOrderId(tenantA, limited);
    const two = await services.findByOrderId(tenantA, unlimited);
    expect(one?.state).toBe('ACTIVE');
    expect(two?.state).toBe('ACTIVE');
    expect(panel.users.get(one?.providerUsername ?? '')?.dataLimit).toBe(1_073_741_824);
    expect(panel.users.get(two?.providerUsername ?? '')?.dataLimit).toBe(0);
  });

  /**
   * A deterministic refusal: terminal on the first attempt, refunded exactly once.
   *
   * The seed makes the ordinary create succeed; it does not make every create succeed.
   * A panel applying a rule — a user limit, a service rule — answers 400, and that is
   * decided the same way every time. So one create, one refund, and no sweep dials
   * the panel again.
   */
  it('refunds a rule refusal exactly once and never creates again', async () => {
    panel.behaviour = 'refuses-rule';
    const orderId = await paidOrder('rick-refused', 53_687_091_200n);

    await ctx.container.provisionerLoop.tick();

    expect(panel.createCalls()).toBe(1);
    expect(await orderState(orderId)).toBe('REFUNDED');
    expect(await refunds()).toHaveLength(1);
    expect((await refunds())[0]?.amount).toBe('250000');

    for (let round = 0; round < 3; round += 1) {
      await makeOperationDue();
      await ctx.container.provisionerLoop.tick();
    }
    expect(panel.createCalls(), 'a refused create was retried').toBe(1);
    expect(await refunds(), 'the refusal was refunded twice').toHaveLength(1);
    expect(await purchases()).toHaveLength(1);
  });

  /** Every request that reached the panel for one name or the create route, in order. */
  const trail = (name: string) =>
    panel.requests
      .filter(
        (one) =>
          (one.method === 'POST' && one.path === '/api/user') ||
          (one.method === 'GET' && one.path === `/api/user/${name}`),
      )
      .map((one) => (one.method === 'POST' ? 'CREATE' : 'READ'));

  /**
   * An ambiguous create, then a panel that recovers: delivered, nothing refunded, and a
   * READ before the second create.
   *
   * A 422 has not been classified on a real panel (`OQ-RP-06`), so it keeps the
   * UNKNOWN safety model. The service goes UNRECONCILED and a RECONCILE reads the name.
   * One absence is not enough (WP15 G3: a panel may not show an accepted create yet), so
   * the READ is repeated a backoff later, and only the SECOND absence licenses a fresh
   * create — which succeeds here, because the panel has recovered. No money moves in
   * either direction beyond the one debit.
   */
  it('reads before it creates again after an ambiguous create, and refunds nothing', async () => {
    panel.unprocessableCreates = 1;
    const orderId = await paidOrder('rick-unknown', 53_687_091_200n);

    await ctx.container.provisionerLoop.tick();
    for (let round = 0; round < 6; round += 1) {
      await makeOperationDue();
      await ctx.container.provisionerLoop.tick();
    }

    const settled = await services.findByOrderId(tenantA, orderId);
    const name = settled?.providerUsername ?? '';
    expect(settled?.state).toBe('ACTIVE');
    expect(trail(name)).toEqual(['CREATE', 'READ', 'READ', 'CREATE', 'READ']);
    expect(panel.users.size).toBe(1);
    expect(await refunds(), 'an UNKNOWN outcome was refunded').toHaveLength(0);
    expect(await purchases()).toHaveLength(1);
    expect(await orderState(orderId)).toBe('PAID');
  });

  /**
   * WP15 H1 (`docs/wp15-provider-hardening-audit.md`): the create is accepted and the
   * READ after it is lost to a rate limit.
   *
   * A 429 on that GET says the GET was not read, not that the POST was not. Reported as
   * RATE_LIMITED, the PROVISION was safe to replay: the retry met this very account as
   * a 409, was refused, and the order was refunded with the account left on the panel.
   * Now the create is UNKNOWN, a RECONCILE reads the account and adopts it: one create,
   * delivered, nothing refunded.
   */
  it('adopts, never refunds, an accepted create whose read-back was rate-limited', async () => {
    panel.rateLimitedReads = 1;
    const orderId = await paidOrder('rick-lost-read', 53_687_091_200n);

    await ctx.container.provisionerLoop.tick();
    for (let round = 0; round < 3; round += 1) {
      await makeOperationDue();
      await ctx.container.provisionerLoop.tick();
    }

    const settled = await services.findByOrderId(tenantA, orderId);
    expect(settled?.state).toBe('ACTIVE');
    expect(panel.createCalls(), 'an accepted create was replayed').toBe(1);
    expect(panel.users.size).toBe(1);
    expect(await refunds(), 'an accepted create was refunded').toHaveLength(0);
    expect(await orderState(orderId)).toBe('PAID');
  });

  /**
   * The owner's incident, reproduced through the shipped container: a create the panel
   * refuses with a status this adapter does not classify.
   *
   * This is what the missing seed cost on every purchase. Each create is UNKNOWN, two
   * reconcile READs a backoff apart prove the account absent (WP15 G3), and the cycle
   * re-plans until `SERVICE_PROVISION_CYCLE_LIMIT` — then refunds once. It is bounded, it
   * never creates without two READs in between, and it refunds exactly once; but it is
   * three creates for a request that could never succeed, which is why the seed, not the
   * classification, is the fix, and why `OQ-RP-06` is worth settling.
   */
  it('bounds a create the panel keeps answering 422: three rounds, READ between, one refund', async () => {
    panel.behaviour = 'unprocessable';
    const orderId = await paidOrder('rick-cycle', 53_687_091_200n);

    await ctx.container.provisionerLoop.tick();
    for (let round = 0; round < 6; round += 1) {
      await makeOperationDue();
      await ctx.container.provisionerLoop.tick();
    }

    const service = await services.findByOrderId(tenantA, orderId);
    const name = service?.providerUsername ?? '';
    expect(trail(name)).toEqual([
      'CREATE',
      'READ',
      'READ',
      'CREATE',
      'READ',
      'READ',
      'CREATE',
      'READ',
      'READ',
    ]);
    expect(panel.users.size).toBe(0);
    expect(await orderState(orderId)).toBe('REFUNDED');
    expect(await refunds()).toHaveLength(1);

    for (let round = 0; round < 3; round += 1) {
      await makeOperationDue();
      await ctx.container.provisionerLoop.tick();
    }
    expect(panel.createCalls(), 'the exhausted cycle dialled the panel again').toBe(3);
    expect(await refunds(), 'the exhausted cycle was refunded twice').toHaveLength(1);
    expect(await purchases()).toHaveLength(1);
  });
});
