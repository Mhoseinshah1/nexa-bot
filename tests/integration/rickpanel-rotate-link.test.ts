import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
  type AdminId,
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
import type { ServiceRecord } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import { ROTATION_STORE_STATES } from '../../apps/api/src/modules/commerce/provisioning/application/provision-executor';
import { rotationStamp } from '../../apps/api/src/surfaces/telegram/bot-runtime';
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
 * RickPanel ROTATE_SUBSCRIPTION_LINK, end to end: an operator asks, the provisioner
 * calls `revoke_sub`, the adapter reads the new link back, the service stores it, and
 * the delivery lane sends it. `docs/rickpanel-rotate-audit.md`.
 *
 * Through the shipped container — the real provisioner, the real `RickpanelAdapter`
 * over the real `SafeHttpClient`, the real delivery lane and a Telegram stand-in on a
 * socket — against `tests/support/fake-rickpanel.ts`.
 *
 * The last two cases are the delivery race D5 names, driven by a controlled
 * interleaving rather than by `Promise.all`: the Telegram stand-in HOLDS the old link's
 * send until the rotation has committed, and only then answers it.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

/** One Telegram request the stand-in will hold until released, and how to answer it. */
interface Hold {
  readonly status: number;
  readonly body: unknown;
  arrived: () => void;
  release: Promise<void>;
}

describe('a RickPanel subscription rotation', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[];
  let hold: Hold | null;
  let panel: FakeRickpanel;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let operations: DrizzleOperationRepository;
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
        const held = hold;
        hold = null;
        if (held === null) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, result: { message_id: 7 } }));
          return;
        }
        held.arrived();
        void held.release.then(() => {
          response.writeHead(held.status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(held.body));
        });
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
    hold = null;

    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-rot', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Rick',
      providerType: 'rickpanel',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: {},
      idempotencyKey: 'panel-rot-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);

    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-rot',
      telegramUserId: '930930',
      from: { id: 930930, first_name: 'سارا' },
      botInstanceId: BOT_A,
    });
    customerId = resolved.customer.id;
  });

  async function paidOrder(key: string): Promise<OrderId> {
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

  /** A service that is ACTIVE and whose first link has been delivered. */
  async function deliveredService(key: string): Promise<ServiceRecord> {
    const orderId = await paidOrder(key);
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, orderId);
    if (service === null || service.state !== 'ACTIVE') throw new Error('not provisioned');
    expect(service.deliveryState).toBe('DELIVERED');
    return service;
  }

  const reload = async (id: string): Promise<ServiceRecord> => {
    const found = await services.findById(tenantA, id as never);
    if (found === null) throw new Error('service vanished');
    return found;
  };

  /** The messages that carried a subscription link, in the order they were sent. */
  const linksSent = (): string[] =>
    // A link travels as the photo card's caption (multipart, kept raw) or as text.
    sent
      .map((one) => String(one.body['text'] ?? one.body['unparseable'] ?? ''))
      .filter((text) => text.includes('/sub/'));

  const rotate = (serviceId: string, key: string) =>
    ctx.container.provisioning.requestFromOperator(
      tenantA,
      owner,
      serviceId,
      'ROTATE_SUBSCRIPTION',
      { idempotencyKey: key },
    );

  const rotationOperation = async (serviceId: string) =>
    (await operations.listForService(tenantA, serviceId, 20)).find(
      (operation) => operation.type === 'ROTATE_SUBSCRIPTION',
    );

  const makeOperationsDue = () =>
    ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET next_attempt_at = now() - interval '1 hour'
           WHERE state = 'PLANNED'`,
    );

  const walletEntries = async () =>
    (
      (await ctx.container.database.db.execute(
        sql`SELECT direction, reason FROM wallet_entries WHERE customer_id = ${customerId}` as never,
      )) as unknown as { rows: { direction: string; reason: string }[] }
    ).rows;

  it('stores the link the panel minted, re-arms delivery and sends the new link', async () => {
    const service = await deliveredService('rot-ok');
    const oldUrl = service.subscriptionUrl ?? '';
    expect(linksSent()).toHaveLength(1);

    await rotate(service.id, 'rot-ok-1');
    await ctx.container.provisionerLoop.tick();

    const after = await reload(service.id);
    const held = panel.users.get(service.providerUsername ?? '');
    // The link the panel serves NOW, read back — not assembled from the call.
    expect(after.subscriptionUrl).toBe(
      `${panel.baseUrl}/sub/${service.providerUsername ?? ''}/${held?.subToken ?? ''}`,
    );
    expect(after.subscriptionUrl).not.toBe(oldUrl);
    expect(panel.revokeCalls(), 'exactly one rotation reached the panel').toBe(1);
    expect(after.state, 'the service keeps its state').toBe('ACTIVE');
    expect((await rotationOperation(service.id))?.state).toBe('SUCCEEDED');

    // Re-armed and sent in the same tick: the second link message is the NEW link.
    expect(after.deliveryState).toBe('DELIVERED');
    expect(linksSent()).toHaveLength(2);
    expect(linksSent()[1]).toContain(after.subscriptionUrl ?? 'no-url');
    expect(linksSent()[1]).not.toContain(oldUrl);

    // The audit row and the event carry no link — both links are bearer capabilities.
    const audit = (
      (await ctx.container.database.db.execute(
        sql`SELECT before::text AS before, after::text AS after FROM audit_logs
             WHERE action = 'service.rotate_subscription' AND entity_id = ${service.id}` as never,
      )) as unknown as { rows: { before: string; after: string }[] }
    ).rows;
    expect(audit).toHaveLength(1);
    const events = (
      (await ctx.container.database.db.execute(
        sql`SELECT payload::text AS payload FROM outbox_messages
             WHERE event_type = 'ServiceSubscriptionRotated' AND aggregate_id = ${service.id}` as never,
      )) as unknown as { rows: { payload: string }[] }
    ).rows;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]?.payload ?? '{}')).toEqual({ customerId });
    for (const text of [audit[0]?.before, audit[0]?.after, events[0]?.payload]) {
      expect(text).not.toContain('/sub/');
      expect(text).not.toContain(held?.subToken ?? 'no-token');
    }

    // Nothing about money moved.
    expect(await walletEntries()).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ reason: 'REFUND' })]),
    );
  });

  it('counts a rotation whose answer was lost, because the read-back shows it', async () => {
    const service = await deliveredService('rot-lost');
    const oldUrl = service.subscriptionUrl;
    panel.revokeMode = 'rotates-then-500';

    await rotate(service.id, 'rot-lost-1');
    await ctx.container.provisionerLoop.tick();

    const after = await reload(service.id);
    expect(after.subscriptionUrl).not.toBe(oldUrl);
    expect(after.subscriptionUrl).toContain(
      panel.users.get(service.providerUsername ?? '')?.subToken ?? 'no-token',
    );
    expect((await rotationOperation(service.id))?.state).toBe('SUCCEEDED');
    // One call, not a retry that would mint a second token for the same request.
    expect(panel.revokeCalls()).toBe(1);
    expect(linksSent().at(-1)).toContain(after.subscriptionUrl ?? 'no-url');
  });

  it('counts a rotation whose connection dropped, because the read-back shows it', async () => {
    /*
     * A socket that dies after the request was written reaches the adapter as
     * UNREACHABLE, a kind the contract calls never-read. Believing that here would
     * mint a second token on the retry for a request the panel already served.
     */
    const service = await deliveredService('rot-dropped');
    panel.revokeMode = 'rotates-then-drops';

    await rotate(service.id, 'rot-dropped-1');
    await ctx.container.provisionerLoop.tick();

    const after = await reload(service.id);
    expect((await rotationOperation(service.id))?.state).toBe('SUCCEEDED');
    expect(after.subscriptionUrl).not.toBe(service.subscriptionUrl);
    expect(panel.revokeCalls()).toBe(1);
    expect(linksSent().at(-1)).toContain(after.subscriptionUrl ?? 'no-url');
  });

  it('retries a failure that provably changed nothing, and converges when the panel recovers', async () => {
    const service = await deliveredService('rot-retry');
    const oldUrl = service.subscriptionUrl;
    panel.revokeMode = 'fails-500';

    await rotate(service.id, 'rot-retry-1');
    await ctx.container.provisioner.runOnce(tenantA);

    // The read-back still shows the old link, so nothing is stored and the operation
    // is retried — FAILED-and-retryable, never UNKNOWN.
    const pending = await rotationOperation(service.id);
    expect(pending?.state).toBe('PLANNED');
    expect(pending?.failureKind).toBe('PROVIDER_ERROR');
    expect((await reload(service.id)).subscriptionUrl).toBe(oldUrl);
    expect(linksSent(), 'no message for a rotation that did not happen').toHaveLength(1);

    panel.revokeMode = 'rotates';
    await makeOperationsDue();
    await ctx.container.provisionerLoop.tick();

    const after = await reload(service.id);
    expect((await rotationOperation(service.id))?.state).toBe('SUCCEEDED');
    expect(after.subscriptionUrl).not.toBe(oldUrl);
    expect(linksSent().at(-1)).toContain(after.subscriptionUrl ?? 'no-url');
  });

  it('refuses a 200 that changed nothing, stores nothing and does not loop', async () => {
    const service = await deliveredService('rot-noop');
    const oldUrl = service.subscriptionUrl;
    panel.revokeMode = 'no-op-200';

    await rotate(service.id, 'rot-noop-1');
    await ctx.container.provisionerLoop.tick();

    const failed = await rotationOperation(service.id);
    expect(failed?.state).toBe('FAILED');
    expect(failed?.failureKind).toBe('MALFORMED_RESPONSE');
    expect((await reload(service.id)).subscriptionUrl).toBe(oldUrl);
    expect((await reload(service.id)).deliveryState).toBe('DELIVERED');
    expect(linksSent()).toHaveLength(1);

    await makeOperationsDue();
    await ctx.container.provisionerLoop.tick();
    expect(panel.revokeCalls(), 'a panel that says yes and does nothing is not asked again').toBe(
      1,
    );
  });

  it('rotates a SUSPENDED service and sends the new link only once it is resumed', async () => {
    const service = await deliveredService('rot-suspended');
    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'SUSPEND', {
      idempotencyKey: 'rot-suspend',
    });
    await ctx.container.provisionerLoop.tick();
    expect((await reload(service.id)).state).toBe('SUSPENDED');

    await rotate(service.id, 'rot-suspended-1');
    await ctx.container.provisionerLoop.tick();

    const rotated = await reload(service.id);
    expect(rotated.state).toBe('SUSPENDED');
    expect(rotated.subscriptionUrl).not.toBe(service.subscriptionUrl);
    // Stored and re-armed, and NOT sent while the customer's service is paused.
    expect(rotated.deliveryState).toBe('PENDING');
    expect(linksSent()).toHaveLength(1);

    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'RESUME', {
      idempotencyKey: 'rot-resume',
    });
    await ctx.container.provisionerLoop.tick();

    const resumed = await reload(service.id);
    expect(resumed.state).toBe('ACTIVE');
    expect(resumed.deliveryState).toBe('DELIVERED');
    expect(linksSent()).toHaveLength(2);
    expect(linksSent()[1]).toContain(rotated.subscriptionUrl ?? 'no-url');
  });

  it('is refused for a service in a state it is not legal from', async () => {
    const service = await deliveredService('rot-terminated');
    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'TERMINATE', {
      idempotencyKey: 'rot-terminate',
    });
    await ctx.container.provisionerLoop.tick();
    expect((await reload(service.id)).state).toBe('TERMINATED');

    await expect(rotate(service.id, 'rot-terminated-1')).rejects.toThrow();
    expect(panel.revokeCalls()).toBe(0);
  });

  it('stores no rotation on a service that was terminated while it was on the wire', async () => {
    /*
     * The write's own condition, asked directly. The provisioner checks the state before
     * it dials the panel, and a terminate can commit while `revoke_sub` is on the wire;
     * the operation still SUCCEEDS, because the panel did rotate, but a TERMINATED
     * service must not be handed a new link and re-armed for a delivery.
     */
    const service = await deliveredService('rot-late');
    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'TERMINATE', {
      idempotencyKey: 'rot-late-terminate',
    });
    await ctx.container.provisionerLoop.tick();
    expect((await reload(service.id)).state).toBe('TERMINATED');

    const stored = await ctx.container.uow.run(tenantA, async (tx) =>
      services.recordRotation(
        tenantA,
        service.id,
        'https://late.example/sub/x/y',
        ROTATION_STORE_STATES,
        ctx.container.clock.now(),
        tx,
      ),
    );
    expect(stored).toBe(false);
    const after = await reload(service.id);
    expect(after.subscriptionUrl).toBe(service.subscriptionUrl);
    expect(after.deliveryState).toBe('DELIVERED');
  });

  it('keeps the link the panel minted when the service expired while the call was on the wire', async () => {
    /*
     * Codex review of PR #62: the expiry sweep can commit between the executor's state
     * check and the store. The panel has already rotated, so refusing the store would
     * leave Nexa holding the pre-rotation link — and a renewal would bring that link
     * back to an ACTIVE service. The link is stored and delivery re-armed; the sweep
     * claims only ACTIVE services, so nothing is sent to an expired customer.
     */
    const service = await deliveredService('rot-expired');
    panel.afterRotation = async () => {
      await ctx.container.database.db.execute(
        sql`UPDATE services SET state = 'EXPIRED' WHERE id = ${service.id}`,
      );
    };

    await rotate(service.id, 'rot-expired-1');
    await ctx.container.provisionerLoop.tick();

    const after = await reload(service.id);
    expect(after.state).toBe('EXPIRED');
    expect((await rotationOperation(service.id))?.state).toBe('SUCCEEDED');
    expect(after.subscriptionUrl).toContain(
      panel.users.get(service.providerUsername ?? '')?.subToken ?? 'no-token',
    );
    expect(after.subscriptionUrl).not.toBe(service.subscriptionUrl);
    expect(after.deliveryState).toBe('PENDING');
    expect(linksSent(), 'nothing is sent to an expired service').toHaveLength(1);
  });

  /**
   * Arms the Telegram stand-in to hold the NEXT request, and returns the two halves of
   * the barrier: a promise that settles when that request has reached the stand-in, and
   * the function that lets it answer.
   */
  function holdNextSend(status: number, body: unknown) {
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    hold = { status, body, arrived, release: released };
    return { reached, release };
  }

  /** A service that is ACTIVE and whose first link has NOT been sent yet. */
  async function undeliveredService(key: string): Promise<ServiceRecord> {
    const orderId = await paidOrder(key);
    // The provisioner alone, not the loop: the loop would deliver in the same tick.
    await ctx.container.provisioner.runOnce(tenantA);
    const service = await services.findByOrderId(tenantA, orderId);
    if (service === null || service.state !== 'ACTIVE') throw new Error('not provisioned');
    expect(service.deliveryState).toBe('PENDING');
    expect(linksSent()).toHaveLength(0);
    return service;
  }

  it('does not let the OLD link’s in-flight send mark the NEW link delivered', async () => {
    /*
     * The race D5 names, in the one order where it does harm:
     *
     *   1. the sweep claims the service and sends the OLD link, and the stand-in holds it;
     *   2. the rotation commits: the NEW link is stored and delivery is PENDING again;
     *   3. the old send's answer arrives and its record tries to write DELIVERED.
     *
     * Without the compare-and-set on the link, step 3 finds a PENDING row and marks it
     * DELIVERED — the new link is never sent, and the service says it was.
     */
    const service = await undeliveredService('race-deliver');
    const oldUrl = service.subscriptionUrl ?? '';

    const barrier = holdNextSend(200, { ok: true, result: { message_id: 8 } });
    const oldSend = ctx.container.delivery.deliverDue(tenantA, 10);
    await barrier.reached;
    expect(linksSent()).toHaveLength(1);
    expect(linksSent()[0]).toContain(oldUrl);

    await rotate(service.id, 'race-deliver-1');
    await ctx.container.provisioner.runOnce(tenantA);
    const rotated = await reload(service.id);
    expect(rotated.subscriptionUrl).not.toBe(oldUrl);
    expect(rotated.deliveryState).toBe('PENDING');

    barrier.release();
    await oldSend;

    const afterOld = await reload(service.id);
    expect(afterOld.deliveryState, 'the old link’s send recorded over the new link').toBe(
      'PENDING',
    );
    expect(afterOld.subscriptionUrl).toBe(rotated.subscriptionUrl);

    await ctx.container.delivery.deliverDue(tenantA, 10);
    expect(linksSent()).toHaveLength(2);
    expect(linksSent()[1]).toContain(rotated.subscriptionUrl ?? 'no-url');
    expect((await reload(service.id)).deliveryState).toBe('DELIVERED');
  });

  it('does not let the OLD link’s rate limit delay the NEW link', async () => {
    /*
     * The same interleaving with a 429 for the old send. Without the compare-and-set,
     * `recordRateLimited` would write Telegram's retry-after onto the row that now holds
     * the new link, and the new link would wait out a rate limit it never received.
     */
    const service = await undeliveredService('race-limited');

    const barrier = holdNextSend(429, {
      ok: false,
      error_code: 429,
      description: 'Too Many Requests: retry after 3600',
      parameters: { retry_after: 3600 },
    });
    const oldSend = ctx.container.delivery.deliverDue(tenantA, 10);
    await barrier.reached;

    await rotate(service.id, 'race-limited-1');
    await ctx.container.provisioner.runOnce(tenantA);
    const rotated = await reload(service.id);

    barrier.release();
    await oldSend;

    expect((await reload(service.id)).deliveryNextAttemptAt).toBeNull();
    await ctx.container.delivery.deliverDue(tenantA, 10);
    expect(linksSent()).toHaveLength(2);
    expect(linksSent()[1]).toContain(rotated.subscriptionUrl ?? 'no-url');
  });

  it('sends nothing for a claim the rotation overtook before the send was stamped', async () => {
    /*
     * Codex review of PR #62, the window BEFORE the send: the sweep has read the
     * service, the rotation commits, and only then does the sweep stamp its send. The
     * stamp used to check the delivery state alone, so the old link went out and the
     * stamp landed on the rotated row after the rotation had cleared it — the new link
     * stranded behind a send nobody would record. Driven by handing `deliver` the
     * record the sweep read, which is exactly what the sweep holds at that moment.
     */
    const stale = await undeliveredService('race-stamp');

    await rotate(stale.id, 'race-stamp-1');
    await ctx.container.provisioner.runOnce(tenantA);
    const rotated = await reload(stale.id);
    expect(rotated.subscriptionUrl).not.toBe(stale.subscriptionUrl);

    await expect(ctx.container.delivery.deliver(tenantA, stale, '930930', BOT_A)).rejects.toThrow();
    expect(linksSent(), 'the old link went out').toHaveLength(0);
    expect((await reload(stale.id)).deliverySendStartedAt).toBeNull();

    await ctx.container.delivery.deliverDue(tenantA, 10);
    expect(linksSent()).toHaveLength(1);
    expect(linksSent()[0]).toContain(rotated.subscriptionUrl ?? 'no-url');
    expect((await reload(stale.id)).deliveryState).toBe('DELIVERED');
  });

  // =========================================================================
  // The Telegram management panel: ask, then confirm
  // =========================================================================

  /** Spelled out rather than imported, as `telegram-admin-services.test.ts` does. */
  const PREFIX = { service: 'I:', rotateAsk: 'ra:', rotate: 'rb:' } as const;
  let updateSeq = 0;

  const tap = (data: string, telegramUserId: string) => {
    updateSeq += 1;
    return {
      idempotencyKey: `rot-update-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      update: {
        update_id: updateSeq,
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'کاربر' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: Number(telegramUserId), type: 'private' },
            from: { id: 999_999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'کاربر' },
    };
  };

  /** The confirming callback the last message drew for this service, stamp included. */
  const confirmData = (serviceId: string): string => {
    const found = new RegExp(`${PREFIX.rotate}${serviceId}\\.[0-9a-f]{12}`).exec(lastMessage());
    if (found === null) throw new Error('no confirmation was drawn');
    return found[0];
  };

  const lastMessage = () =>
    JSON.stringify(sent.filter((one) => one.url.includes('/sendMessage')).at(-1) ?? {});

  async function bindOwner(telegramUserId: string): Promise<void> {
    await ctx.container.adminManagement.setTelegramBinding(tenantA, owner, owner.id as AdminId, {
      telegramUserId,
      reason: 'test binding',
    });
  }

  /** An administrator whose one role holds `services.view` and nothing else. */
  async function bindViewer(telegramUserId: string): Promise<void> {
    const admin = await createAdmin(ctx.container, tenantA, { username: 'viewer-rot' });
    const roleId = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO roles (id, tenant_id, key, name, is_system)
      VALUES (${roleId}, ${tenantA.tenantId}, 'custom_viewer_rot', 'viewer-rot', false)`);
    await ctx.container.database.db.execute(sql`
      INSERT INTO role_permissions (tenant_id, role_id, permission_key)
      VALUES (${tenantA.tenantId}, ${roleId}, 'services.view')`);
    await ctx.container.database.db.execute(sql`
      INSERT INTO admin_roles (tenant_id, admin_id, role_id)
      VALUES (${tenantA.tenantId}, ${admin.id}, ${roleId})`);
    await ctx.container.adminManagement.setTelegramBinding(tenantA, owner, admin.id as AdminId, {
      telegramUserId,
      reason: 'test binding',
    });
  }

  it('offers the rotation on Telegram only as a QUESTION, and rotates on the confirmation', async () => {
    const service = await deliveredService('tg-rot');
    await bindOwner('700101');
    const runtime = ctx.container.botRuntime;

    await runtime.handle(
      tenantA,
      systemActor('bot'),
      tap(`${PREFIX.service}${service.id}`, '700101'),
    );
    expect(lastMessage(), 'the rotation is offered as a question').toContain(
      `${PREFIX.rotateAsk}${service.id}`,
    );
    expect(lastMessage(), 'a one-tap rotation was drawn').not.toContain(
      `${PREFIX.rotate}${service.id}`,
    );

    const asked = await runtime.handle(
      tenantA,
      systemActor('bot'),
      tap(`${PREFIX.rotateAsk}${service.id}`, '700101'),
    );
    expect(asked.replyKey).toBe('bot.admin.service_rotate_link_ask');
    const confirm = confirmData(service.id);
    // Bound to the link it was asked about, by a digest and never the link itself.
    expect(confirm).toBe(`${PREFIX.rotate}${service.id}.${rotationStamp(service.subscriptionUrl)}`);
    expect(lastMessage()).not.toContain('/sub/');
    expect(await rotationOperation(service.id), 'the question planned something').toBeUndefined();

    const confirmed = await runtime.handle(tenantA, systemActor('bot'), tap(confirm, '700101'));
    expect(confirmed.replyKey).toBe('bot.admin.service_planned');
    expect((await rotationOperation(service.id))?.state).toBe('PLANNED');
    // The admin chat is told it was RECORDED, and it carries no link, old or new.
    expect(lastMessage()).not.toContain('/sub/');

    await ctx.container.provisionerLoop.tick();
    const after = await reload(service.id);
    expect(after.subscriptionUrl).not.toBe(service.subscriptionUrl);
    expect(linksSent().at(-1)).toContain(after.subscriptionUrl ?? 'no-url');
  });

  it('draws no rotation for services.view alone, and plans nothing for a crafted tap', async () => {
    const service = await deliveredService('tg-rot-viewer');
    await bindViewer('700102');
    const runtime = ctx.container.botRuntime;

    await runtime.handle(
      tenantA,
      systemActor('bot'),
      tap(`${PREFIX.service}${service.id}`, '700102'),
    );
    expect(lastMessage()).not.toContain(`${PREFIX.rotateAsk}${service.id}`);

    const asked = await runtime.handle(
      tenantA,
      systemActor('bot'),
      tap(`${PREFIX.rotateAsk}${service.id}`, '700102'),
    );
    expect(asked.replyKey).toBe('bot.admin.refused');
    // A CRAFTED confirmation, with the right stamp: the stamp is not the authority.
    await runtime.handle(
      tenantA,
      systemActor('bot'),
      tap(`${PREFIX.rotate}${service.id}.${rotationStamp(service.subscriptionUrl)}`, '700102'),
    );
    expect(
      await rotationOperation(service.id),
      'a crafted confirmation planned a rotation',
    ).toBeUndefined();
    expect(panel.revokeCalls()).toBe(0);
  });

  it('spends a confirmation with the rotation it confirmed', async () => {
    /*
     * Codex review of PR #62: a rotation leaves the service ACTIVE, so an unstamped
     * confirmation stayed pressable for ever and each press replaced the link again.
     * A second press BEFORE the rotation runs is the same request and plans nothing
     * new; a press AFTER it finds a different link and is refused.
     */
    const service = await deliveredService('tg-rot-once');
    await bindOwner('700103');
    const runtime = ctx.container.botRuntime;

    await runtime.handle(
      tenantA,
      systemActor('bot'),
      tap(`${PREFIX.rotateAsk}${service.id}`, '700103'),
    );
    const confirm = confirmData(service.id);

    expect(
      (await runtime.handle(tenantA, systemActor('bot'), tap(confirm, '700103'))).replyKey,
    ).toBe('bot.admin.service_planned');
    expect(
      (await runtime.handle(tenantA, systemActor('bot'), tap(confirm, '700103'))).replyKey,
    ).toBe('bot.admin.service_planned');
    await ctx.container.provisionerLoop.tick();
    expect(panel.revokeCalls()).toBe(1);

    const stale = await runtime.handle(tenantA, systemActor('bot'), tap(confirm, '700103'));
    expect(stale.replyKey).toBe('bot.admin.service_unavailable');
    await ctx.container.provisionerLoop.tick();
    expect(panel.revokeCalls(), 'an old confirmation rotated the link again').toBe(1);
    const rotations = (await operations.listForService(tenantA, service.id, 20)).filter(
      (operation) => operation.type === 'ROTATE_SUBSCRIPTION',
    );
    expect(rotations).toHaveLength(1);
  });

  it('refuses a confirmation that carries no stamp', async () => {
    const service = await deliveredService('tg-rot-bare');
    await bindOwner('700104');
    await ctx.container.botRuntime.handle(
      tenantA,
      systemActor('bot'),
      tap(`${PREFIX.rotate}${service.id}`, '700104'),
    );
    expect(await rotationOperation(service.id)).toBeUndefined();
  });
});
