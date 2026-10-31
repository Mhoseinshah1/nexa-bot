import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
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
import {
  DrizzleServiceRepository,
  SERVICE_LIFECYCLE_LOCK_CLASS,
} from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { DrizzleServiceTransferRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service-transfer.repository';
import { DrizzleNotificationSubjectReader } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-notification-subject.reader';
import { DrizzleOpsLogFacts } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/drizzle-ops-log-facts';
import {
  ServiceAutoRenewService,
  type ServiceAutoRenewDeps,
} from '../../apps/api/src/modules/commerce/provisioning/application/service-auto-renew.service';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
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
 * Round 10, D1 — automatic renewal against a real PostgreSQL, the real container's services
 * (the commercial renewal, the wallet settlement, the provisioner and the real Marzban
 * adapter on a real socket), driven by the sweep's own `runOnce`.
 *
 * What it defends: a covered period is renewed through the ordinary renewal — one RENEW order
 * paid by ONE `PURCHASE` debit, in the worker's SCHEDULER namespace, provisioned, and logged
 * «منبع: تمدید خودکار»; two passes at once renew it once; a short wallet creates no order and
 * is told once per period, and is renewed once topped up; the feature off renews nothing; a
 * transfer clears the consent; the notice is superseded once its fact stops being true; the
 * run row refuses an incoherent state.
 *
 * MUTATIONS, each run and seen red (Round 10):
 * - the transfer repository's consent clearing removed: "a transfer clears the consent".
 * - the subject reader's ledger comparison removed: "a short wallet creates no order …"
 *   (the notice still holds once the wallet covers the quote).
 * - the ops-log facts' run lookup removed: "renews a covered period …" (origin.autoRenew).
 * Codex review of PR 338 (each run and seen red, then restored):
 * - `listDue` cursor rendered through a JavaScript `Date` (microseconds dropped): "pages past a
 *   short wallet …" (the same page comes back for ever; the case times out).
 * - `listDue`'s SCHEDULER exemption removed: "a takeover withdraws the order a stopped pass
 *   left …".
 * - the settlement's `periodCurrent` check removed: "a period renewed by hand since the claim
 *   …".
 * - the bot confirm's figure ignored (`expected` not passed): "the bot asks before …".
 * Not a mutation this suite catches: `claimNew` without `ON CONFLICT … DO NOTHING` stays green,
 * because the period's UNIQUE key still refuses the second claim (that pass's claim transaction
 * fails instead of skipping); "the run row refuses an incoherent state" pins the key itself.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const CUSTOMER_TG = '930931';
const OTHER_TG = '930932';
const ADMIN_TG = '940941';
const PRICE = 150_000n;
const HOUR = 3_600_000;

const botActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('R10 D1 — automatic renewal', () => {
  let ctx: TestContext;
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let panelId: string;
  let customerA: UserId;
  let customerB: UserId;
  let owner: ActorContext;
  let flagSeq = 0;
  let keySeq = 0;
  let updateSeq = 0;
  let telegram: Server;
  let sent: string[] = [];

  beforeAll(async () => {
    // A stand-in for Telegram: every call answered ok, every body kept.
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        sent.push(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
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
    sent = [];
    ctx.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(ctx.container.database.db);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    const seeded = await createAdmin(ctx.container, tenantA, {
      username: 'owner-auto-renew',
      roleKeys: ['owner'],
      telegramUserId: ADMIN_TG,
    });
    owner = adminActorFor(seeded);
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-auto-renew-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    customerA = await resolve(CUSTOMER_TG);
    customerB = await resolve(OTHER_TG);
    await setFlag(true);
  });

  async function resolve(telegramUserId: string): Promise<UserId> {
    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, botActor('r'), {
      idempotencyKey: `resolve-${telegramUserId}`,
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'سارا' },
      botInstanceId: BOT_A,
    });
    return resolved.customer.id;
  }

  async function setFlag(enabled: boolean): Promise<void> {
    const flags = await ctx.container.featureFlags.list(tenantA, owner);
    const current = flags.find((flag) => flag.key === 'service_auto_renew');
    flagSeq += 1;
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'service_auto_renew',
      enabled,
      expectedVersion: current?.version ?? null,
      idempotencyKey: `auto-renew-flag-${String(flagSeq)}`,
      confirmKey: 'service_auto_renew',
      reason: 'R10 D1 integration.',
    });
  }

  async function credit(customerId: UserId, amount: bigint): Promise<void> {
    keySeq += 1;
    await ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: `auto-renew-credit-${String(keySeq)}`,
      direction: 'CREDIT',
      amountMinor: amount,
      currency: 'IRT',
      note: 'fixture',
    });
  }

  /** A NEW_SERVICE order paid from the wallet and provisioned; its deadline then set near. */
  async function activeService(customerId: UserId, hoursLeft = 12): Promise<string> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ماهانه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(PRICE, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    keySeq += 1;
    const key = `auto-renew-buy-${String(keySeq)}`;
    const draft = await ctx.container.orders.createDraft(tenantA, botActor(key), {
      idempotencyKey: `${key}-draft`,
      customerId,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, botActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId,
      orderId: draft.id,
    });
    await credit(customerId, PRICE);
    await ctx.container.payments.settleFromWallet(tenantA, botActor(key), customerId, {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id,
    });
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, confirmed.id as OrderId);
    if (service === null || service === undefined) throw new Error('no service');
    expect(service.state, 'the fixture must start ACTIVE').toBe('ACTIVE');
    await run(
      sql`UPDATE services SET expires_at = ${new Date(
        ctx.container.clock.now().getTime() + hoursLeft * HOUR,
      )} WHERE id = ${service.id}`,
    );
    return service.id;
  }

  const run = (query: ReturnType<typeof sql>) => ctx.container.database.db.execute(query);

  const rows = async (query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> =>
    (await run(query)).rows as Record<string, unknown>[];

  const optIn = (customerId: UserId, serviceId: string) => {
    keySeq += 1;
    return ctx.container.serviceAutoRenew.set(tenantA, botActor('opt-in'), customerId, {
      serviceId,
      enabled: true,
      // The figure the confirmation showed: the fixture's price.
      expected: money(PRICE, 'IRT'),
      idempotencyKey: `auto-renew-opt-${String(keySeq)}`,
    });
  };

  /** The container's own dependencies, for a sweep with one of them replaced. */
  const deps = (): ServiceAutoRenewDeps =>
    (ctx.container.serviceAutoRenew as unknown as { deps: ServiceAutoRenewDeps }).deps;

  const balance = async (customerId: UserId): Promise<bigint> =>
    (await ctx.container.wallet.balance(tenantA, owner, customerId)).amountMinor;

  const renewOrders = (serviceId: string) =>
    rows(sql`SELECT o.id, o.state, o.source_surface
               FROM service_commercial_actions c
               JOIN orders o ON o.tenant_id = c.tenant_id AND o.id = c.order_id
              WHERE c.service_id = ${serviceId} AND c.kind = 'RENEW'`);

  const purchases = (customerId: UserId) =>
    rows(sql`SELECT id, order_id FROM wallet_entries
              WHERE customer_id = ${customerId} AND reason = 'PURCHASE'`);

  const runsOf = (serviceId: string) =>
    rows(sql`SELECT id, state, attempt, refusal, order_id, notified_at
               FROM service_auto_renew_runs WHERE service_id = ${serviceId}`);

  const notices = (kind: string) =>
    rows(sql`SELECT subject_id FROM customer_notifications WHERE kind = ${kind}`);

  it('renews a covered period once, through the ordinary renewal, and logs its source', async () => {
    const serviceId = await activeService(customerA);
    const state = await optIn(customerA, serviceId);
    expect(state.enabled).toBe(true);
    expect(state.price).toEqual(money(PRICE, 'IRT'));
    await credit(customerA, PRICE);
    const before = (await services.findById(tenantA, serviceId))?.expiresAt;

    const report = await ctx.container.serviceAutoRenew.runOnce(tenantA);
    expect(report).toEqual({ renewed: 1, short: 0, refused: 0 });

    const orders = await renewOrders(serviceId);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ state: 'PAID', source_surface: 'SCHEDULER' });
    const orderId = String(orders[0]?.['id']);
    expect(await purchases(customerA)).toHaveLength(2); // the purchase and the renewal
    expect(await balance(customerA)).toBe(0n);
    expect(await runsOf(serviceId)).toEqual([
      expect.objectContaining({ state: 'RENEWED', attempt: 1, order_id: orderId }),
    ]);
    // The settlement's idempotency row is the worker's own namespace.
    expect(
      await rows(sql`SELECT 1 FROM request_idempotency
                      WHERE scope_ref LIKE '%|SCHEDULER' AND key LIKE 'autorenew:%:settle'`),
    ).toHaveLength(1);

    // Provisioned like any paid renewal: the deadline moved.
    await ctx.container.provisionerLoop.tick();
    const after = (await services.findById(tenantA, serviceId))?.expiresAt;
    expect(after?.getTime()).toBeGreaterThan(before?.getTime() ?? 0);

    // «منبع: تمدید خودکار» — decided by the run row naming the order.
    const facts = new DrizzleOpsLogFacts(ctx.container.database.db);
    expect((await facts.orderOrigin(tenantA, orderId, { tx: undefined } as never))?.autoRenew).toBe(
      true,
    );

    // The period is final: another pass buys nothing.
    await ctx.container.serviceAutoRenew.runOnce(tenantA);
    expect(await renewOrders(serviceId)).toHaveLength(1);
  });

  it('two passes at once renew the period once', async () => {
    const serviceId = await activeService(customerA);
    await optIn(customerA, serviceId);
    await credit(customerA, PRICE * 3n);
    await Promise.allSettled([
      ctx.container.serviceAutoRenew.runOnce(tenantA),
      ctx.container.serviceAutoRenew.runOnce(tenantA),
    ]);
    expect(await runsOf(serviceId)).toHaveLength(1);
    expect(await renewOrders(serviceId)).toHaveLength(1);
    expect(await purchases(customerA)).toHaveLength(2);
    expect(await balance(customerA)).toBe(PRICE * 2n);
  });

  it('a short wallet creates no order, is told once per period, and is renewed once topped up', async () => {
    const serviceId = await activeService(customerA);
    await optIn(customerA, serviceId);
    await credit(customerA, PRICE - 1n);

    expect((await ctx.container.serviceAutoRenew.runOnce(tenantA)).short).toBe(1);
    await ctx.container.serviceAutoRenew.runOnce(tenantA);
    await ctx.container.serviceAutoRenew.runOnce(tenantA);
    expect(await renewOrders(serviceId)).toEqual([]);
    const [runRow] = await runsOf(serviceId);
    expect(runRow).toMatchObject({ state: 'FUNDS_SHORT', attempt: 1 });
    expect(await notices('SERVICE_AUTO_RENEW_FUNDS_SHORT')).toEqual([
      { subject_id: runRow?.['id'] },
    ]);

    // The notice holds while the wallet is short, and stops holding once it covers the quote.
    const reader = new DrizzleNotificationSubjectReader(ctx.container.database.db);
    const holds = () =>
      reader.stillHolds(
        tenantA,
        'SERVICE_AUTO_RENEW_FUNDS_SHORT',
        String(runRow?.['id']),
        ctx.container.clock.now(),
      );
    expect(await holds()).toBe(true);
    await credit(customerA, 1n);
    expect(await holds()).toBe(false);

    expect((await ctx.container.serviceAutoRenew.runOnce(tenantA)).renewed).toBe(1);
    expect(await runsOf(serviceId)).toEqual([
      expect.objectContaining({ state: 'RENEWED', attempt: 2 }),
    ]);
    expect(await notices('SERVICE_AUTO_RENEW_FUNDS_SHORT')).toHaveLength(1);
  });

  it('renews nothing while the feature is off, and nothing outside the lead window', async () => {
    const soon = await activeService(customerA);
    await optIn(customerA, soon);
    const later = await activeService(customerA, 48);
    await optIn(customerA, later);
    await credit(customerA, PRICE * 2n);

    await setFlag(false);
    expect(await ctx.container.serviceAutoRenew.runOnce(tenantA)).toEqual({
      renewed: 0,
      short: 0,
      refused: 0,
    });
    expect(await runsOf(soon)).toEqual([]);
    // Switching ON is refused while the feature is off (switching off never is).
    keySeq += 1;
    await expect(
      ctx.container.serviceAutoRenew.set(tenantA, botActor('on'), customerA, {
        serviceId: later,
        enabled: true,
        idempotencyKey: `auto-renew-opt-${String(keySeq)}`,
      }),
    ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.AUTO_RENEW_DISABLED });

    await setFlag(true);
    expect((await ctx.container.serviceAutoRenew.runOnce(tenantA)).renewed).toBe(1);
    expect(await runsOf(soon)).toHaveLength(1);
    expect(await runsOf(later), 'two days out with a one-day lead: not yet').toEqual([]);
  });

  it('a transfer clears the consent: the new owner is never renewed on it', async () => {
    const serviceId = await activeService(customerA);
    await optIn(customerA, serviceId);
    await credit(customerB, PRICE);
    // The repository statement both transfer paths share, after the ownership row it needs.
    const transfers = new DrizzleServiceTransferRepository(ctx.container.database.db);
    await ctx.container.database.db.transaction(async (tx) => {
      const now = ctx.container.clock.now();
      const written = await transfers.create(
        tenantA,
        {
          id: ctx.container.ids.uuid(),
          serviceId,
          fromCustomerId: customerA,
          toCustomerId: customerB,
          botInstanceId: BOT_A,
          idempotencyKey: 'auto-renew-transfer',
          actorType: 'SYSTEM_JOB',
          actorLabel: 'test',
          correlationId: 'auto-renew-transfer' as CorrelationId,
          now,
        },
        { tx } as never,
      );
      expect(written).not.toBeNull();
      const moved = await transfers.reassign(
        tenantA,
        { serviceId, fromCustomerId: customerA, toCustomerId: customerB, now },
        { tx } as never,
      );
      expect(moved).toBe(true);
    });
    expect(
      await rows(sql`SELECT enabled, source, consented_total_minor
                       FROM service_auto_renew_preferences WHERE service_id = ${serviceId}`),
    ).toEqual([{ enabled: false, source: 'TRANSFER', consented_total_minor: null }]);
    await ctx.container.serviceAutoRenew.runOnce(tenantA);
    expect(await runsOf(serviceId)).toEqual([]);
    expect(await balance(customerB)).toBe(PRICE);
  });

  /** A customer's tap on an inline button, through the real bot runtime. */
  const tap = (data: string) => {
    updateSeq += 1;
    return ctx.container.botRuntime.handle(tenantA, botActor('bot'), {
      idempotencyKey: `auto-renew-update-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      telegramUserId: CUSTOMER_TG,
      from: { id: Number(CUSTOMER_TG), first_name: 'سارا' },
      update: {
        update_id: updateSeq,
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(CUSTOMER_TG), is_bot: false, first_name: 'سارا' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: Number(CUSTOMER_TG), type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
    } as never);
  };

  const preference = async (serviceId: string) =>
    (
      await rows(sql`SELECT enabled, consented_total_minor FROM service_auto_renew_preferences
                      WHERE service_id = ${serviceId}`)
    )[0] ?? null;

  it('the bot asks before switching on, records only on confirm, and switches off at once', async () => {
    const serviceId = await activeService(customerA);
    sent = [];
    expect((await tap(`s:${serviceId}`)).replyKey).toBe('bot.service.card');
    expect(sent.join('\n'), 'the ON switch is drawn').toContain(`ar:${serviceId}`);

    sent = [];
    expect((await tap(`ar:${serviceId}`)).replyKey).toBe('bot.service.auto_renew_ask');
    expect(await preference(serviceId), 'asking records nothing').toBeNull();
    // The confirm names the figure the question showed (Codex review of PR 338).
    expect(sent.join('\n')).toContain(`ay:${serviceId}.${String(PRICE)}.IRT`);

    // A confirm drawn before the figure was carried, or one below today's price, records
    // nothing: the question is asked again, at the price now.
    expect((await tap(`ay:${serviceId}`)).replyKey).toBe('bot.service.auto_renew_ask');
    expect((await tap(`ay:${serviceId}.${String(PRICE - 1n)}.IRT`)).replyKey).toBe(
      'bot.service.auto_renew_ask',
    );
    expect(await preference(serviceId)).toBeNull();

    await tap(`ay:${serviceId}.${String(PRICE)}.IRT`);
    expect(await preference(serviceId)).toEqual({
      enabled: true,
      consented_total_minor: PRICE,
    });
    sent = [];
    await tap(`s:${serviceId}`);
    expect(sent.join('\n'), 'the OFF switch replaces it').toContain(`an:${serviceId}`);

    await tap(`an:${serviceId}`);
    expect(await preference(serviceId)).toEqual({ enabled: false, consented_total_minor: null });

    // With the feature off the switch is not drawn, and a stale confirm records nothing.
    await setFlag(false);
    sent = [];
    await tap(`s:${serviceId}`);
    expect(sent.join('\n')).not.toContain(`ar:${serviceId}`);
    expect((await tap(`ay:${serviceId}.${String(PRICE)}.IRT`)).replyKey).toBe(
      'bot.service.auto_renew_unavailable',
    );
    expect(await preference(serviceId)).toEqual({ enabled: false, consented_total_minor: null });
  });

  // --- Codex review of PR 338 ------------------------------------------------------------

  it('pages past a short wallet still short to a covered service behind it', async () => {
    const short = await activeService(customerB);
    const covered = await activeService(customerA);
    // One deadline to the microsecond: the order is then decided by the service id alone,
    // and a cursor that lost the microseconds would hand the first page back for ever.
    await run(sql`UPDATE services
                     SET expires_at = date_trunc('second', now()) + interval '12 hours 123457 microseconds'
                   WHERE id IN (${short}, ${covered})`);
    const [first] = await rows(sql`SELECT id FROM services WHERE id IN (${short}, ${covered})
                                    ORDER BY id LIMIT 1`);
    expect(first?.['id'], 'the fixture needs the short service first').toBe(short);
    const limited = new ServiceAutoRenewService({ ...deps(), batchLimit: 1 });

    await optIn(customerB, short);
    expect((await limited.runOnce(tenantA)).short).toBe(1);

    await optIn(customerA, covered);
    await credit(customerA, PRICE);
    expect(await limited.runOnce(tenantA)).toEqual({ renewed: 1, short: 0, refused: 0 });
    expect(await runsOf(covered)).toEqual([expect.objectContaining({ state: 'RENEWED' })]);
    expect(await runsOf(short)).toEqual([
      expect.objectContaining({ state: 'FUNDS_SHORT', attempt: 1 }),
    ]);
  });

  it('a takeover withdraws the order a stopped pass left, and renews the period once', async () => {
    const serviceId = await activeService(customerA);
    await optIn(customerA, serviceId);
    await credit(customerA, PRICE);
    // A pass confirms its order and then loses the settlement in transit.
    const stopped = new ServiceAutoRenewService({
      ...deps(),
      payments: {
        settleFromWallet: async () => {
          throw new Error('connection reset');
        },
      },
    });
    expect(await stopped.runOnce(tenantA)).toEqual({ renewed: 0, short: 0, refused: 0 });
    const [left] = await renewOrders(serviceId);
    expect(left).toMatchObject({ state: 'AWAITING_PAYMENT', source_surface: 'SCHEDULER' });
    expect(await runsOf(serviceId)).toEqual([
      expect.objectContaining({ state: 'CLAIMED', attempt: 1 }),
    ]);

    // Its lease lapses: the next pass takes the period over.
    await run(sql`UPDATE service_auto_renew_runs
                     SET lease_until = ${new Date(ctx.container.clock.now().getTime() - 60_000)}
                   WHERE service_id = ${serviceId}`);
    expect((await ctx.container.serviceAutoRenew.runOnce(tenantA)).renewed).toBe(1);
    const orders = await renewOrders(serviceId);
    expect(orders).toHaveLength(2);
    expect(orders.find((order) => order['id'] === left?.['id'])).toMatchObject({
      state: 'CANCELLED',
    });
    expect(orders.filter((order) => order['state'] === 'PAID')).toHaveLength(1);
    expect(await purchases(customerA)).toHaveLength(2);
    expect(await balance(customerA)).toBe(0n);
    expect(await runsOf(serviceId)).toEqual([
      expect.objectContaining({ state: 'RENEWED', attempt: 2 }),
    ]);
  });

  it('a period renewed by hand since the claim is never bought again', async () => {
    const serviceId = await activeService(customerA);
    await optIn(customerA, serviceId);
    await credit(customerA, PRICE * 2n);
    const base = deps();
    // The customer's own renewal is applied between this pass's claim and its settlement.
    const racing = new ServiceAutoRenewService({
      ...base,
      commercial: {
        renewalQuote: (...args) => base.commercial.renewalQuote(...args),
        draft: (...args) => base.commercial.draft(...args),
        confirm: async (...args) => {
          const confirmed = await base.commercial.confirm(...args);
          await run(sql`UPDATE services SET expires_at = expires_at + interval '30 days'
                         WHERE id = ${serviceId}`);
          return confirmed;
        },
      },
    });
    expect(await racing.runOnce(tenantA)).toEqual({ renewed: 0, short: 0, refused: 1 });
    expect(await purchases(customerA), 'only the original purchase').toHaveLength(1);
    expect(await balance(customerA)).toBe(PRICE * 2n);
    expect(await runsOf(serviceId)).toEqual([
      expect.objectContaining({ state: 'REFUSED', refusal: 'NOT_RENEWABLE', order_id: null }),
    ]);
    expect(await renewOrders(serviceId)).toEqual([expect.objectContaining({ state: 'CANCELLED' })]);
  });

  /*
   * R12 F1 item 4, after Codex on #360: the renewal locks the service's ROW first in its
   * settling transaction and checks it there. A TERMINATE being planned takes the row and then
   * the lifecycle lock (`ProvisioningService.planWithin`); the renewal used to take the
   * lifecycle lock (`prepareCommercialAction`) and then the row — a lock cycle. Here a planner
   * holds the row, the renewal waits for it, the planner takes the lifecycle lock and commits
   * the termination: no deadlock, and the renewal debits nothing.
   */
  const lockWaiters = async (): Promise<number> =>
    Number(
      (
        await rows(sql`SELECT count(*)::int AS n FROM pg_stat_activity
                        WHERE datname = current_database() AND wait_event_type = 'Lock'`)
      )[0]?.['n'] ?? 0,
    );

  it('R12 F1: a renewal racing a TERMINATE being planned takes the row first — no deadlock, no debit', async () => {
    const serviceId = await activeService(customerA);
    await optIn(customerA, serviceId);
    await credit(customerA, PRICE);
    const planner = new Client({ connectionString: process.env['TEST_DATABASE_URL'] });
    await planner.connect();
    let report: unknown;
    try {
      // The planner's order: the service row, then the lifecycle lock.
      await planner.query('BEGIN');
      await planner.query('SELECT id FROM services WHERE id = $1 FOR NO KEY UPDATE', [serviceId]);
      let done = false;
      const renewing = ctx.container.serviceAutoRenew.runOnce(tenantA).then(
        (value) => {
          done = true;
          return value;
        },
        (error: unknown) => {
          done = true;
          throw error;
        },
      );
      // The renewal reaches its settlement and waits on a lock the planner holds.
      for (let i = 0; i < 200 && !done && (await lockWaiters()) === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await planner.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        SERVICE_LIFECYCLE_LOCK_CLASS,
        `${tenantA.tenantId}:${serviceId}`,
      ]);
      await planner.query(
        `UPDATE services SET state = 'TERMINATED', terminated_at = now() WHERE id = $1`,
        [serviceId],
      );
      await planner.query('COMMIT');
      report = await renewing;
    } finally {
      await planner.end();
    }
    expect(report).toEqual({ renewed: 0, short: 0, refused: 1 });
    expect(await purchases(customerA), 'only the original purchase').toHaveLength(1);
    expect(await balance(customerA)).toBe(PRICE);
    expect(await runsOf(serviceId)).toEqual([
      expect.objectContaining({ state: 'REFUSED', refusal: 'NOT_RENEWABLE', order_id: null }),
    ]);
  });

  it('R12 F1: the settlement already refuses a service terminated before it starts', async () => {
    /*
     * Found on main: `prepareCommercialAction` checks the owner and the state under the
     * lifecycle lock. Pinned here so the period check is not the only line of defence. (A
     * transfer racing the settlement was not reproducible this way: moving `customer_id` waited
     * on the settling transaction's own locks on the service row until it ended.)
     */
    const serviceId = await activeService(customerA);
    await optIn(customerA, serviceId);
    await credit(customerA, PRICE);
    const base = deps();
    const racing = new ServiceAutoRenewService({
      ...base,
      commercial: {
        renewalQuote: (...args) => base.commercial.renewalQuote(...args),
        draft: (...args) => base.commercial.draft(...args),
        confirm: async (...args) => {
          const confirmed = await base.commercial.confirm(...args);
          await run(
            sql`UPDATE services SET state = 'TERMINATED', terminated_at = now()
                 WHERE id = ${serviceId}`,
          );
          return confirmed;
        },
      },
    });
    expect(await racing.runOnce(tenantA)).toEqual({ renewed: 0, short: 0, refused: 1 });
    expect(await purchases(customerA)).toHaveLength(1);
    expect(await balance(customerA)).toBe(PRICE);
  });

  it('the run row refuses an incoherent state', async () => {
    const serviceId = await activeService(customerA);
    const basis = new Date('2030-01-01T00:00:00Z');
    const insert = (state: string, refusal: string | null, orderId: string | null) =>
      run(sql`INSERT INTO service_auto_renew_runs
                (id, tenant_id, service_id, customer_id, basis_expires_at, attempt, state, refusal,
                 service_label, consented_total_minor, consented_currency, order_id,
                 created_at, updated_at)
              VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${serviceId}, ${customerA},
                      ${basis}, 1, ${state}, ${refusal}, 'nx', 1, 'IRT', ${orderId}, now(), now())`);
    await expect(insert('RENEWED', null, null), 'renewed with no order').rejects.toThrow();
    await expect(insert('REFUSED', null, null), 'refused with no reason').rejects.toThrow();
    await expect(
      insert('FUNDS_SHORT', 'PRICE_ROSE', null),
      'a reason off REFUSED',
    ).rejects.toThrow();
    await insert('FUNDS_SHORT', null, null);
    await expect(insert('FUNDS_SHORT', null, null), 'a second run of one period').rejects.toThrow();
  });
});
