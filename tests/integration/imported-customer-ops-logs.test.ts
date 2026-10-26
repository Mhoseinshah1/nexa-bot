import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
import { AudienceFixtures } from './audience-fixtures';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  validatePanelConnection,
  type TestContext,
} from './harness';

/**
 * R10 B5 — the v0.8.2-e rule for every operations log an imported customer's life produces.
 *
 * Hotfix v0.8.2-e (179c96f1) found that the one-click `.nxpkg` import marks every customer it
 * wrote `source = 'MIRZA'`, and that the services log refused any such customer, so nothing a
 * migrated customer did afterwards reached the group. It fixed the service logs only. The
 * same refusal still hid, for every migrated customer: a block or an unblock (L18), a service
 * alert (L21), a purchase that failed (L23), a gift that failed (L24) and a ticket (L26).
 *
 * The rule, as the hotfix drew it: ONLY the records the import itself created stay silent.
 * The import writes its rows directly and emits none of the events these logs hear; where a
 * log is ABOUT a record the import could have written (an order, a ticket, a customer row), it
 * is that record's own provenance that is read — never the customer's.
 *
 * And a create whose answer was lost, later adopted from the panel by a reconcile, now posts
 * its «🛒 خرید جدید» (L10/L11) — once.
 *
 * Every case runs the shipped container: the real service a surface calls, the provisioner
 * against a RickPanel on a socket, the relay, the reminder sweep and the dispatcher, and reads
 * what the operations chat RECEIVED. Ops logs are not customer messages: the import-created
 * cases also assert the customer was sent nothing.
 *
 * MUTATIONS (each applied, the named cases red, reverted, green):
 *  - `CustomerLogConsumer`: `customer.source !== 'NEXA'` put back for every event -> "L18 ...
 *    (imported: true)".
 *  - `ServiceAlertLog`: `customer.source !== 'NEXA'` put back -> "L21 ... imported customer:
 *    true" and "L21: an imported service, a period after the import"; `service.source !==
 *    'NEXA'` put back -> the latter.
 *  - `FailureLogConsumer.report`: `customer.source !== 'NEXA'` put back -> "L23 ... (imported:
 *    true)" and "L10/L11 ... (imported: true)" (its pending report); the ORDER's `source`
 *    check removed -> "L23: an order the import wrote stays silent".
 *  - `OperationLog.operationFailed`: `customer.source !== 'NEXA'` put back, and separately
 *    `service.source !== 'NEXA'` -> "L24 ... (imported: true)".
 *  - `TicketSupportNotifyConsumer`: `customerFact?.source !== 'NEXA'` put back -> "L26 ...
 *    (imported: true)" and "L26: a ticket the import wrote ..."; the ticket's own provenance
 *    check removed, and separately applied to replies too -> "L26: a ticket the import
 *    wrote ...".
 *  - the reconcile's `ServiceProvisioned` not written -> "L10/L11: a purchase whose create
 *    answer was lost ..." (both); written even when the conditional move did not happen ->
 *    "L10/L11: an adoption that finds the service already moved ..."; the adopted
 *    `provisioning.delivered` line no longer withheld -> "L10/L11: a purchase whose create
 *    answer was lost ..." (both: the generic line beside the purchase).
 */

const BOT_A1 = SEED_IDS.botA1 as BotInstanceId;
const OPS_CHAT = '-1001234567890';
const GIB = 1024n ** 3n;
const DAY_MS = 86_400_000;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

const CASES = [{ imported: true }, { imported: false }] as const;

describe('R10 B5: what an imported customer does after the import reaches the operations group', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: { url: string; body: Record<string, unknown> }[];
  let panel: FakeRickpanel | undefined;
  let panelId: string;
  let productId: ProductId;
  let owner: ActorContext;
  let fx: AudienceFixtures;
  let seq = 0;
  let tgSeq = 975_000;
  const key = () => `r10b5-key-${String((seq += 1)).padStart(6, '0')}-abcdef`;
  const exec = (query: ReturnType<typeof sql>) => ctx.container.database.db.execute(query);

  beforeAll(async () => {
    sent = [];
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks);
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          body = { multipart: raw.length };
        }
        sent.push({ url: request.url ?? '', body });
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
    telegram.closeAllConnections();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  afterEach(async () => {
    await panel?.close();
    panel = undefined;
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    sent = [];
    fx = new AudienceFixtures(ctx, tenantA.tenantId as string);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'r10b5-owner', roleKeys: ['owner'] }),
    );
    for (const flag of ['ops_notifications', 'service_expiry_reminders']) {
      const current = await ctx.container.featureFlagResolver.resolve(tenantA, flag as never);
      if (current.enabled) continue;
      await ctx.container.featureFlags.set(tenantA, owner, {
        key: flag as never,
        enabled: true,
        expectedVersion: current.version,
        idempotencyKey: key(),
        confirmKey: flag,
        reason: 'R10 B5 integration test',
      });
    }
    await ctx.container.settingsService.set(tenantA, owner, {
      key: 'ops.notifications.telegram_chat_id',
      value: OPS_CHAT,
      expectedVersion: null,
      idempotencyKey: key(),
    });

    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Rick',
      providerType: 'rickpanel',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: {},
      idempotencyKey: key(),
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);

    const products = new DrizzleProductRepository(ctx.container.database.db);
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ریک',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 50n * GIB, deviceLimit: null },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    productId = product.id;
  });

  // --- the pipeline ---------------------------------------------------------------------

  const makeDue = () =>
    exec(
      sql`UPDATE provisioning_operations SET next_attempt_at = now() - interval '1 hour'
           WHERE state = 'PLANNED'`,
    );

  /** The relay and the dispatcher, until nothing is left to do. */
  async function relayAndDispatch(): Promise<void> {
    const dispatcher = ctx.container.notificationDispatcher as unknown as {
      windowStartedAt: number;
    };
    for (let batch = 0; batch < 50; batch += 1) {
      if ((await ctx.container.relay.processBatch()).claimed === 0) break;
    }
    // The courtesy ceiling to Telegram is a per-minute window kept in the process.
    dispatcher.windowStartedAt = 0;
    await ctx.container.notificationDispatcher.tick();
  }

  /** The provisioner (every planned operation due), the relay and the dispatcher. */
  async function settle(): Promise<void> {
    for (let round = 0; round < 3; round += 1) {
      await makeDue();
      await ctx.container.provisionerLoop.tick();
      await relayAndDispatch();
    }
  }

  /**
   * The operations-log rows of these templates about the customer with this Telegram id, and
   * whether the operations chat RECEIVED each: a row is only `SENT` once Telegram took it, and
   * the text Telegram was handed to the operations chat names the customer.
   */
  async function opsLogs(templates: readonly string[], tg: string): Promise<string[]> {
    const rows = (
      await exec(
        sql`SELECT template_key, status FROM notifications
             WHERE tenant_id = ${tenantA.tenantId}
               AND template_key = ANY(${sql.param([...templates])}::text[])
               AND payload ->> 'telegramId' = ${tg}
             ORDER BY created_at, id`,
      )
    ).rows as { template_key: string; status: string }[];
    for (const row of rows) expect(row.status, row.template_key).toBe('SENT');
    const received = sent.filter(
      (one) =>
        one.url.endsWith('/sendMessage') &&
        String(one.body['chat_id']) === OPS_CHAT &&
        String(one.body['text'] ?? '').includes(tg),
    );
    expect(received.length, 'the operations chat received each one').toBeGreaterThanOrEqual(
      rows.length,
    );
    return rows.map((row) => row.template_key);
  }

  /** Everything the customer was sent or is owed: their lane's rows and Telegram's sends. */
  async function customerMessages(customerId: string, tg: string): Promise<number> {
    const rows = (
      await exec(
        sql`SELECT count(*)::int AS n FROM customer_notifications WHERE customer_id = ${customerId}`,
      )
    ).rows as { n: number }[];
    const toChat = sent.filter((one) => String(one.body['chat_id']) === tg).length;
    return Number(rows[0]?.n ?? 0) + toChat;
  }

  /** As the one-click `.nxpkg` import leaves a customer: `source = 'MIRZA'` with its Mirza id. */
  const markImported = (customerId: string) =>
    exec(
      sql`UPDATE customers SET source = 'MIRZA', source_ref = ${`user:${customerId}`}
           WHERE id = ${customerId}`,
    );
  /** As the import leaves a service it adopted from the previous bot's panel. */
  const markServiceImported = (serviceId: string) =>
    exec(
      sql`UPDATE services SET source = 'MIRZA', source_ref = ${`service:${serviceId}`}
           WHERE id = ${serviceId}`,
    );

  /** A customer who reached the bot (so has a bot to be told through), imported or not. */
  async function customer(imported: boolean): Promise<{ id: UserId; tg: string }> {
    tgSeq += 1;
    const tg = String(tgSeq);
    const resolved = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(`resolve-${tg}`),
      {
        idempotencyKey: `r10b5-resolve-${tg}`,
        telegramUserId: tg,
        from: { id: Number(tg), first_name: 'مشتری' },
        botInstanceId: BOT_A1,
      },
    );
    if (imported) await markImported(resolved.customer.id);
    await ctx.container.wallet.adjust(tenantA, owner, resolved.customer.id, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor: 2_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    // What reaching the bot and the credit queued is not what the cases below are about.
    await relayAndDispatch();
    return { id: resolved.customer.id, tg };
  }

  /** A wallet purchase through the order and payment services, up to before provisioning. */
  async function paidOrder(customerId: UserId): Promise<string> {
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor('r10b5-buy'), {
      idempotencyKey: key(),
      customerId,
      productId,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor('r10b5-buy'), {
      idempotencyKey: key(),
      customerId,
      orderId: draft.id,
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor('r10b5-buy'), customerId, {
      idempotencyKey: key(),
      orderId: confirmed.id,
    });
    return confirmed.id;
  }

  const serviceOf = async (orderId: string) => {
    const service = await new DrizzleServiceRepository(ctx.container.database.db).findByOrderId(
      tenantA,
      orderId as never,
    );
    if (service === null) throw new Error('no service');
    return service;
  };

  // --- L18 ------------------------------------------------------------------------------

  it.each(CASES)(
    'L18: a block and an unblock after the import are logged (imported: $imported)',
    async ({ imported }) => {
      const who = await customer(imported);
      await ctx.container.customers.block(tenantA, owner, {
        idempotencyKey: key(),
        customerId: who.id,
        reason: 'spam',
      });
      await ctx.container.customers.unblock(tenantA, owner, {
        idempotencyKey: key(),
        customerId: who.id,
        reason: null,
      });
      await relayAndDispatch();
      expect(await opsLogs(['ops.log.user_blocked'], who.tg)).toEqual([
        'ops.log.user_blocked',
        'ops.log.user_blocked',
      ]);
    },
  );

  it('L18: a customer the import wrote as blocked is silent — no log, no customer message', async () => {
    const tg = '975999001';
    // What the importer writes for a customer Mirza had banned: the row, its status, no event.
    const id = await fx.customer({ telegramUserId: tg, botInstanceId: BOT_A1, status: 'BLOCKED' });
    await markImported(id);
    await relayAndDispatch();
    expect(await opsLogs(['ops.log.user_blocked', 'ops.log.user_new'], tg)).toEqual([]);
    expect(await customerMessages(id, tg)).toBe(0);
  });

  // --- L21 ------------------------------------------------------------------------------

  const sweep = async (): Promise<void> => {
    await ctx.container.serviceReminderSweep.runOnce(tenantA as TenantContext);
    await relayAndDispatch();
  };
  const service = (customerId: string, expiresInDays: number) =>
    fx.service({
      customerId,
      panelId,
      productId,
      expiresAt: new Date(ctx.container.clock.now().getTime() + expiresInDays * DAY_MS),
    });

  it.each(CASES)(
    'L21: a threshold crossed after the import is logged — imported customer: $imported',
    async ({ imported }) => {
      const who = await customer(imported);
      await service(who.id, 2.5);
      await sweep();
      expect(await opsLogs(['ops.log.service_alert'], who.tg)).toEqual(['ops.log.service_alert']);
      // The customer was told (that is what the log reports), once.
      expect(await customerMessages(who.id, who.tg)).toBeGreaterThan(0);
    },
  );

  it('L21: an imported service, a period after the import, is logged', async () => {
    const who = await customer(true);
    const serviceId = await service(who.id, 30);
    await markServiceImported(serviceId);
    // The worker's reconcile: what the service had reached at the import is its baseline.
    await ctx.container.serviceReminderSweep.reconcileImportedNotices(tenantA as TenantContext, {
      unbounded: true,
    });
    await sweep();
    expect(await opsLogs(['ops.log.service_alert'], who.tg)).toEqual([]);
    // Its deadline moved after the import (a new period): the crossing is this installation's.
    await exec(
      sql`UPDATE services SET expires_at = ${new Date(ctx.container.clock.now().getTime() + 2.5 * DAY_MS)}
           WHERE id = ${serviceId}`,
    );
    await sweep();
    expect(await opsLogs(['ops.log.service_alert'], who.tg)).toEqual(['ops.log.service_alert']);
  });

  it('L21: a threshold an imported service had already crossed at the import is silent — no log, no customer message', async () => {
    const who = await customer(true);
    const serviceId = await service(who.id, 2.5);
    await markServiceImported(serviceId);
    const before = await customerMessages(who.id, who.tg);
    await ctx.container.serviceReminderSweep.reconcileImportedNotices(tenantA as TenantContext, {
      unbounded: true,
    });
    await sweep();
    await sweep();
    expect(await opsLogs(['ops.log.service_alert'], who.tg)).toEqual([]);
    expect(await customerMessages(who.id, who.tg)).toBe(before);
  });

  // --- L23 ------------------------------------------------------------------------------

  it.each(CASES)(
    'L23: a purchase the panel refused after the import is reported (imported: $imported)',
    async ({ imported }) => {
      const who = await customer(imported);
      const orderId = await paidOrder(who.id);
      // Somebody else's account already holds the planned name: the create is refused (409),
      // the order is given back automatically.
      panel!.seedUser((await serviceOf(orderId)).providerUsername);
      await settle();
      expect((await serviceOf(orderId)).state).toBe('TERMINATED');
      expect(await opsLogs(['ops.log.error_provision'], who.tg)).toEqual([
        'ops.log.error_provision',
      ]);
    },
  );

  it('L23: an order the import wrote stays silent, whatever its customer', async () => {
    const who = await customer(false);
    const orderId = await paidOrder(who.id);
    panel!.seedUser((await serviceOf(orderId)).providerUsername);
    // The order's provenance, as the import leaves an order it brought over, before the
    // refund's event is relayed: the record the report is about is the import's.
    await makeDue();
    await ctx.container.provisionerLoop.tick();
    await exec(
      sql`UPDATE orders SET source = 'MIRZA', source_ref = ${`invoice:${orderId}`}
           WHERE id = ${orderId}`,
    );
    await relayAndDispatch();
    expect(await opsLogs(['ops.log.error_provision'], who.tg)).toEqual([]);
  });

  // --- L24 ------------------------------------------------------------------------------

  it.each(CASES)(
    'L24: a gift that failed on the panel after the import is reported (imported: $imported)',
    async ({ imported }) => {
      const who = await customer(imported);
      const orderId = await paidOrder(who.id);
      await settle();
      const bought = await serviceOf(orderId);
      expect(bought.state).toBe('ACTIVE');
      if (imported) await markServiceImported(bought.id);
      // The panel refuses the modify outright: a rule was hit (400), nothing applied.
      panel!.intercept = (request) =>
        request.method === 'PUT' && request.path.startsWith('/api/user/')
          ? { status: 400, body: { detail: 'refused' } }
          : null;
      await ctx.container.serviceGrants.grant(tenantA, owner, bought.id, {
        idempotencyKey: key(),
        kind: 'ADD_TRAFFIC',
        trafficGb: '5',
        reason: 'support compensation',
      });
      await settle();
      const failed = (
        await exec(
          sql`SELECT state FROM provisioning_operations
               WHERE service_id = ${bought.id} AND type = 'ADD_TRAFFIC'`,
        )
      ).rows as { state: string }[];
      expect(failed.map((row) => row.state)).toEqual(['FAILED']);
      expect(await opsLogs(['ops.log.error_operation'], who.tg)).toEqual([
        'ops.log.error_operation',
      ]);
    },
  );

  // --- L26 ------------------------------------------------------------------------------

  async function category(): Promise<string> {
    await ctx.container.ticketCategories.ensureSeeded(tenantA);
    const [first] = await ctx.container.ticketCategories.activeForCustomer(tenantA);
    return first!.id;
  }
  const open = async (customerId: UserId, text: string) =>
    (
      await ctx.container.tickets.openByCustomer(tenantA, systemActor('r10b5-ticket'), {
        customerId,
        botInstanceId: BOT_A1,
        categoryId: await category(),
        text,
        file: null,
        idempotencyKey: key(),
      })
    ).ticket.id;
  const reply = (customerId: UserId, ticketId: string, text: string) =>
    ctx.container.tickets.replyByCustomer(tenantA, systemActor('r10b5-ticket'), {
      customerId,
      botInstanceId: BOT_A1,
      ticketId,
      text,
      file: null,
      idempotencyKey: key(),
    });
  const TICKET_LOGS = ['ops.support.ticket_opened', 'ops.support.customer_replied'] as const;

  it.each(CASES)(
    'L26: a ticket opened and answered after the import is logged (imported: $imported)',
    async ({ imported }) => {
      const who = await customer(imported);
      const ticketId = await open(who.id, 'سرویسم وصل نمی‌شود');
      await relayAndDispatch();
      await reply(who.id, ticketId, 'هنوز وصل نیست');
      await relayAndDispatch();
      expect(await opsLogs(TICKET_LOGS, who.tg)).toEqual([...TICKET_LOGS]);
    },
  );

  it('L26: a ticket the import wrote is silent — no log, no customer message; a reply after the import is logged', async () => {
    const who = await customer(true);
    const ticketId = await open(who.id, 'پیام قدیمی از ربات قبلی');
    // The ticket is the import's (as the ticket-history step writes one), before anything is
    // relayed: the record the opening is about is history.
    await exec(
      sql`UPDATE tickets SET source = 'MIRZA', source_ref = ${`ticket:${ticketId}`}
           WHERE id = ${ticketId}`,
    );
    const before = await customerMessages(who.id, who.tg);
    await relayAndDispatch();
    expect(await opsLogs(TICKET_LOGS, who.tg)).toEqual([]);
    expect(await customerMessages(who.id, who.tg)).toBe(before);

    await reply(who.id, ticketId, 'پیام تازه بعد از مهاجرت');
    await relayAndDispatch();
    expect(await opsLogs(TICKET_LOGS, who.tg)).toEqual(['ops.support.customer_replied']);
  });

  // --- L10 / L11: a create whose answer was lost, adopted by a reconcile ------------------

  const CREATED = ['ops.log.service_created', 'ops.log.service_created_wallet'] as const;
  const genericDelivered = async (): Promise<number> =>
    Number(
      (
        (
          await exec(
            sql`SELECT count(*)::int AS n FROM notifications
                 WHERE template_key = 'ops.notification.operational_event'
                   AND payload ->> 'code' = 'provisioning.delivered'`,
          )
        ).rows as { n: number }[]
      )[0]?.n ?? 0,
    );

  it.each(CASES)(
    'L10/L11: a purchase whose create answer was lost, adopted from the panel, posts one «خرید جدید» (imported: $imported)',
    async ({ imported }) => {
      const who = await customer(imported);
      // The create is accepted; the read after it is lost: the outcome is UNKNOWN.
      panel!.droppedReads = 1;
      const orderId = await paidOrder(who.id);
      await ctx.container.provisionerLoop.tick();
      expect((await serviceOf(orderId)).state).toBe('UNRECONCILED');
      await relayAndDispatch();
      // The unknown outcome's own report (L23, nothing refunded, the panel is being asked).
      expect(await opsLogs(['ops.log.error_provision'], who.tg)).toEqual([
        'ops.log.error_provision',
      ]);
      expect(await opsLogs(CREATED, who.tg)).toEqual([]);

      // The reconcile reads the account and adopts it.
      await settle();
      const adopted = await serviceOf(orderId);
      expect(adopted.state).toBe('ACTIVE');
      expect(panel!.createCalls(), 'one create').toBe(1);
      expect(await opsLogs(CREATED, who.tg)).toEqual(['ops.log.service_created_wallet']);
      // Instead of, not beside, the generic English line it used to post.
      expect(await genericDelivered()).toBe(0);

      // Nothing more on further passes: the event is written once, its log once.
      await settle();
      expect(await opsLogs(CREATED, who.tg)).toEqual(['ops.log.service_created_wallet']);
      const events = (
        await exec(
          sql`SELECT count(*)::int AS n FROM outbox_messages
               WHERE event_type = 'ServiceProvisioned' AND aggregate_id = ${adopted.id}`,
        )
      ).rows as { n: number }[];
      expect(events[0]?.n).toBe(1);
    },
  );

  it('L10/L11: an adoption that finds the service already moved writes no second «خرید جدید»', async () => {
    const who = await customer(false);
    panel!.droppedReads = 1;
    const orderId = await paidOrder(who.id);
    await ctx.container.provisionerLoop.tick();
    const lost = await serviceOf(orderId);
    expect(lost.state).toBe('UNRECONCILED');
    await relayAndDispatch();

    // While the reconcile's read is on the wire, the service leaves UNRECONCILED (another path
    // moved it first). The conditional move then does not happen, and nothing is announced.
    let moved: Promise<unknown> | null = null;
    panel!.intercept = (request) => {
      if (moved === null && request.method === 'GET' && request.path.startsWith('/api/user/')) {
        // Sent now, before the panel answers (a Drizzle query runs when it is awaited).
        moved = exec(
          sql`UPDATE services SET state = 'TERMINATED', terminated_at = now()
               WHERE id = ${lost.id} AND state = 'UNRECONCILED'`,
        ).then((result) => result);
      }
      return null;
    };
    await makeDue();
    await ctx.container.provisionerLoop.tick();
    expect(moved, 'the reconcile read the panel').not.toBeNull();
    await moved;
    await relayAndDispatch();
    expect((await serviceOf(orderId)).state).toBe('TERMINATED');
    const events = (
      await exec(
        sql`SELECT count(*)::int AS n FROM outbox_messages
             WHERE event_type = 'ServiceProvisioned' AND aggregate_id = ${lost.id}`,
      )
    ).rows as { n: number }[];
    expect(events[0]?.n).toBe(0);
    expect(await opsLogs(CREATED, who.tg)).toEqual([]);
  });

  it('ServiceProvisioned is heard by the operations log alone: adopting tells no customer anything new', () => {
    const consumers = (
      ctx.container.relay as unknown as {
        consumers: { name: string; subscribesTo: readonly string[] }[];
      }
    ).consumers;
    expect(
      consumers
        .filter((one) => one.subscribesTo.includes('ServiceProvisioned'))
        .map((one) => one.name),
    ).toEqual(['ops-log.services']);
  });
});
