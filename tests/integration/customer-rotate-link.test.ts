import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  COMMERCE_ERROR_CODES,
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
import type { ServiceRecord } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
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
 * WP6-C: a customer rotates their own subscription link. `docs/wp6c-audit.md`.
 *
 * Through the shipped container and the real bot runtime, against
 * `tests/support/fake-rickpanel.ts` — the one provider that declares
 * `ROTATE_SUBSCRIPTION_LINK`. The operator rotation this reuses has its own suite
 * (`rickpanel-rotate-link.test.ts`); this one holds what WP6-C added: the flag, the
 * cooldown, the lock, the narrower state rule and the surface.
 *
 * The race case uses a row-lock barrier and PROVES both requests are waiting on it
 * before it is released, rather than trusting `Promise.all` to interleave.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const CUSTOMER_TG = '930931';
const OTHER_TG = '930932';

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('a customer rotating their own subscription link', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[];
  let panel: FakeRickpanel;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let operations: DrizzleOperationRepository;
  let panelId: string;
  let customerId: UserId;
  let otherId: UserId;
  let owner: ActorContext;
  let updateSeq = 0;

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
      await createAdmin(ctx.container, tenantA, { username: 'owner-crot', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Rick',
      providerType: 'rickpanel',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: {},
      idempotencyKey: 'panel-crot-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);

    for (const [tg, name] of [
      [CUSTOMER_TG, 'سارا'],
      [OTHER_TG, 'نیما'],
    ] as const) {
      const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor(tg), {
        idempotencyKey: `resolve-${tg}`,
        telegramUserId: tg,
        from: { id: Number(tg), first_name: name },
        botInstanceId: BOT_A,
      });
      if (tg === CUSTOMER_TG) customerId = resolved.customer.id;
      else otherId = resolved.customer.id;
    }
  });

  async function enableRotation(hours?: number): Promise<void> {
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'customer_link_rotation',
      enabled: true,
      expectedVersion: null,
      // TENANT_WIDE: the flag names itself and says why (ADR-0010).
      confirmKey: 'customer_link_rotation',
      reason: 'let customers replace a leaked link',
      idempotencyKey: randomUUID(),
    });
    if (hours !== undefined) {
      const current = await ctx.container.settingsService.get(
        tenantA,
        owner,
        'services.link_rotation_cooldown_hours',
      );
      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'services.link_rotation_cooldown_hours',
        value: hours,
        expectedVersion: current.version,
        idempotencyKey: randomUUID(),
      });
    }
  }

  async function paidOrder(key: string, who: UserId): Promise<OrderId> {
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
      customerId: who,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId: who,
      orderId: draft.id,
    });
    await ctx.container.wallet.adjust(tenantA, owner, who, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), who, {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id,
    });
    return confirmed.id;
  }

  /** An ACTIVE service whose first link has been delivered. */
  async function deliveredService(key: string, who: UserId = customerId): Promise<ServiceRecord> {
    const orderId = await paidOrder(key, who);
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

  const rotations = async (serviceId: string) =>
    (await operations.listForService(tenantA, serviceId, 50)).filter(
      (operation) => operation.type === 'ROTATE_SUBSCRIPTION',
    );

  const request = (serviceId: string, key: string, who: UserId = customerId) =>
    ctx.container.provisioning.requestRotation(tenantA, systemActor(key), who, serviceId, {
      idempotencyKey: key,
    });

  const refusalOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as { code?: string; details?: Record<string, unknown> };
    }
    throw new Error('expected a refusal');
  };

  const count = async (query: ReturnType<typeof sql>): Promise<number> => {
    const rows = (await ctx.container.database.db.execute(query as never)) as unknown as {
      rows: { n: number }[];
    };
    return rows.rows[0]?.n ?? 0;
  };

  const tap = (data: string, telegramUserId = CUSTOMER_TG) => {
    updateSeq += 1;
    return ctx.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: `crot-update-${String(updateSeq)}-${randomUUID()}`,
      botInstanceId: BOT_A,
      update: {
        update_id: updateSeq,
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'سارا' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: Number(telegramUserId), type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'سارا' },
    });
  };
  const lastMessage = () =>
    JSON.stringify(sent.filter((one) => one.url.includes('/sendMessage')).at(-1) ?? {});

  // =========================================================================
  // The flag
  // =========================================================================

  it('draws no button and refuses the tap while the flag is off', async () => {
    const service = await deliveredService('flag-off');

    await tap(`s:${service.id}`);
    expect(lastMessage(), 'no rotation button while the flag is off').not.toContain(
      `rc:${service.id}`,
    );

    const confirmed = await tap(`rd:${service.id}`);
    expect(confirmed.replyKey).toBe('bot.service.capability_unsupported');
    expect(await rotations(service.id)).toHaveLength(0);
    expect(panel.revokeCalls()).toBe(0);
  });

  // =========================================================================
  // End to end
  // =========================================================================

  it('asks first, then rotates the link, delivers it and tells the customer', async () => {
    await enableRotation();
    const service = await deliveredService('e2e');
    const oldUrl = service.subscriptionUrl;

    await tap(`s:${service.id}`);
    expect(lastMessage()).toContain(`rc:${service.id}`);

    const asked = await tap(`rc:${service.id}`);
    expect(asked.intent).toBe('SERVICE_ROTATE_ASK');
    expect(asked.replyKey).toBe('bot.service.rotate_ask');
    expect(lastMessage(), 'the one place the confirming callback is produced').toContain(
      `rd:${service.id}`,
    );
    expect(await rotations(service.id), 'the question alone plans nothing').toHaveLength(0);

    const confirmed = await tap(`rd:${service.id}`);
    expect(confirmed.intent).toBe('SERVICE_ROTATE');
    expect(confirmed.replyKey).toBe('bot.service.action_requested');

    await ctx.container.provisionerLoop.tick();
    const after = await reload(service.id);
    expect(after.subscriptionUrl).not.toBe(oldUrl);
    expect(after.deliveryState).toBe('DELIVERED');
    expect(panel.revokeCalls()).toBe(1);
    const [operation] = await rotations(service.id);
    expect(operation?.state).toBe('SUCCEEDED');
    expect(operation?.requestedByCustomerId, 'the row says a customer asked').toBe(customerId);
    // The customer is answered: the new link was sent, and the outcome is enqueued.
    expect(
      sent.some((one) =>
        String(one.body['text'] ?? one.body['unparseable'] ?? '').includes(
          after.subscriptionUrl ?? '-',
        ),
      ),
    ).toBe(true);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM customer_notifications
             WHERE kind = 'SERVICE_ACTION_SUCCEEDED' AND subject_id = ${operation?.id ?? ''}`,
      ),
    ).toBe(1);
  });

  // =========================================================================
  // The cooldown
  // =========================================================================

  it('refuses a second rotation inside the cooldown, and names when it may be asked again', async () => {
    await enableRotation(24);
    const service = await deliveredService('cool');
    await request(service.id, 'cool-1');
    await ctx.container.provisionerLoop.tick();
    const [first] = await rotations(service.id);
    expect(first?.state).toBe('SUCCEEDED');

    const refused = await refusalOf(request(service.id, 'cool-2'));
    expect(refused.code).toBe(COMMERCE_ERROR_CODES.SERVICE_ROTATION_COOLDOWN);
    expect(refused.details?.['availableAt']).toBe(
      new Date((first?.createdAt.getTime() ?? 0) + 24 * 3_600_000).toISOString(),
    );
    expect(await rotations(service.id)).toHaveLength(1);

    // The surface says the same thing, with the instant in it.
    const tapped = await tap(`rd:${service.id}`);
    expect(tapped.replyKey).toBe('bot.service.rotate_cooldown');
    expect(await rotations(service.id)).toHaveLength(1);
    expect(panel.revokeCalls()).toBe(1);
  });

  it('accepts a rotation once the cooldown has passed', async () => {
    await enableRotation(2);
    const service = await deliveredService('cool-past');
    await request(service.id, 'past-1');
    await ctx.container.provisionerLoop.tick();
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET created_at = now() - interval '3 hours'
           WHERE service_id = ${service.id} AND type = 'ROTATE_SUBSCRIPTION'`,
    );

    const second = await request(service.id, 'past-2');
    expect(second.state).toBe('PLANNED');
    expect(await rotations(service.id)).toHaveLength(2);
  });

  it('answers a redelivered confirmation with the rotation it planned, not the cooldown', async () => {
    await enableRotation();
    const service = await deliveredService('replay');
    const first = await request(service.id, 'replay-1');
    await ctx.container.provisionerLoop.tick();

    const again = await request(service.id, 'replay-1');
    expect(again.id).toBe(first.id);
    expect(again.state).toBe('SUCCEEDED');
    expect(await rotations(service.id)).toHaveLength(1);
  });

  it('does not charge a rotation that failed to the cooldown', async () => {
    await enableRotation();
    const service = await deliveredService('failed');
    panel.revokeMode = 'no-op-200';
    await request(service.id, 'failed-1');
    await ctx.container.provisionerLoop.tick();
    expect((await rotations(service.id))[0]?.state).toBe('FAILED');

    panel.revokeMode = 'rotates';
    const retried = await request(service.id, 'failed-2');
    expect(retried.state).toBe('PLANNED');
  });

  it("does not start the customer's cooldown with an operator's rotation", async () => {
    await enableRotation();
    const service = await deliveredService('by-operator');
    await ctx.container.provisioning.requestFromOperator(
      tenantA,
      owner,
      service.id,
      'ROTATE_SUBSCRIPTION',
      { idempotencyKey: 'by-operator-1' },
    );
    await ctx.container.provisionerLoop.tick();
    expect((await rotations(service.id))[0]?.state).toBe('SUCCEEDED');

    const own = await request(service.id, 'by-operator-2');
    expect(own.state).toBe('PLANNED');
    expect(own.requestedByCustomerId).toBe(customerId);
  });

  // =========================================================================
  // Who and when
  // =========================================================================

  it('refuses a SUSPENDED service, which an operator may still rotate', async () => {
    await enableRotation();
    const service = await deliveredService('suspended');
    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'SUSPEND', {
      idempotencyKey: 'suspended-op',
    });
    await ctx.container.provisionerLoop.tick();
    expect((await reload(service.id)).state).toBe('SUSPENDED');

    expect((await refusalOf(request(service.id, 'suspended-1'))).code).toBe(
      COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
    );
    expect(await rotations(service.id)).toHaveLength(0);
    // And the button is not drawn for it.
    await tap(`s:${service.id}`);
    expect(lastMessage()).not.toContain(`rc:${service.id}`);
  });

  it('refuses a blocked customer inside the transaction', async () => {
    await enableRotation();
    const service = await deliveredService('blocked');
    await ctx.container.customers.block(tenantA, owner, {
      idempotencyKey: 'block-crot',
      customerId,
      reason: 'fixture',
    });

    expect((await refusalOf(request(service.id, 'blocked-1'))).code).toBe(
      COMMERCE_ERROR_CODES.CUSTOMER_BLOCKED,
    );
    expect(await rotations(service.id)).toHaveLength(0);
  });

  it("answers another customer's service exactly as an id that does not exist", async () => {
    await enableRotation();
    const service = await deliveredService('not-theirs');

    expect((await refusalOf(request(service.id, 'not-theirs-1', otherId))).code).toBe(
      COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND,
    );
    const tapped = await tap(`rd:${service.id}`, OTHER_TG);
    expect(tapped.replyKey).toBe('bot.service.not_found');
    expect(await rotations(service.id)).toHaveLength(0);
  });

  it('refuses the tap when the flag is turned off after the question was asked', async () => {
    await enableRotation();
    const service = await deliveredService('flag-late');
    await tap(`rc:${service.id}`);
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'customer_link_rotation',
      enabled: false,
      expectedVersion: 1,
      confirmKey: 'customer_link_rotation',
      reason: 'withdraw it',
      idempotencyKey: randomUUID(),
    });

    const refused = await refusalOf(request(service.id, 'flag-late-1'));
    expect(refused.code).toBe(COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED);
    expect(await rotations(service.id)).toHaveLength(0);
  });

  // =========================================================================
  // The race
  // =========================================================================

  it('serialises two confirmations under different keys on the service row lock', async () => {
    /*
     * Two taps of two different messages: different update keys, so idempotency does not
     * join them. An outside transaction holds the service row; BOTH requests are proven
     * waiting on it before it is released. The first then plans a rotation, and the
     * second — reading after it — is given that same open rotation rather than planning
     * a rival one beside it.
     */
    await enableRotation();
    const service = await deliveredService('race');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const holder = ctx.container.database.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM services WHERE id = ${service.id} FOR UPDATE`);
      locked();
      await gate;
    });
    await holding;

    const both = Promise.all([request(service.id, 'race-a'), request(service.id, 'race-b')]);
    const deadline = Date.now() + 5_000;
    for (;;) {
      const waiting = await count(
        sql`SELECT count(*)::int AS n FROM pg_locks
             WHERE NOT granted AND locktype IN ('tuple', 'transactionid')`,
      );
      if (waiting >= 2) break;
      if (Date.now() > deadline) throw new Error('both requests never waited on the lock');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await holder;
    const [a, b] = await both;

    expect(a.id).toBe(b.id);
    expect(await rotations(service.id)).toHaveLength(1);
  });
});
