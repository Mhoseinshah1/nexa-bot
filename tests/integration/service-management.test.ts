import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  money,
  providerUsernameFor,
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
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * Pausing, resuming and ending a service — end to end, against real everything.
 *
 * A real PostgreSQL, the real provisioner, the real Marzban adapter, the real
 * `SafeHttpClient`, a deterministic Marzban on a real socket, a real socket standing in
 * for Telegram, and the real bot runtime. Nothing is mocked.
 *
 * A MARZBAN panel, and that is not incidental. `docs/phase4e-audit.md` records the
 * owner's scope correction: Marzban is the supported service-management provider, and
 * 3X-UI keeps what it has. So this file is where the three operations are exercised,
 * and `provisioning-delivery.test.ts` holds the mirror case — a TERMINATE against a
 * 3X-UI panel, refused with `CAPABILITY_UNSUPPORTED` before anything is dialled.
 *
 * ## The three things a panel cannot observe
 *
 * The real-panel acceptance (`tests/acceptance/real-panel-marzban.test.ts`) proves the
 * wire: one account stops serving, its sibling does not, a replay is safe. What it
 * cannot prove is anything about Nexa's own machinery, so these are proved here:
 *
 *   1. an uncertain outcome is retried as the SAME mutation rather than routed to a
 *      reconciliation that could not answer the question;
 *   2. no provider call happens inside a database transaction — enforced at the sink by
 *      `refuseNetworkInsideTransaction`, so a suspend that succeeds is the proof;
 *   3. one tenant's customer cannot reach another tenant's service.
 *
 * ## And the one thing neither proves without the other
 *
 * That ending a service takes TWO taps. The button on the detail screen carries the ASK
 * prefix and the destructive prefix is produced in exactly one place — the confirmation
 * screen — so there is no message in this product whose single tap deletes an account.
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

describe('a customer manages the service they bought', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  let reply: (request: IncomingMessage, response: ServerResponse) => void;
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let operations: DrizzleOperationRepository;
  let panelId: string;
  let customerA: UserId;
  let owner: ActorContext;
  let updateSeq = 0;

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
     * 127.0.0.2, not 127.0.0.1, for the reason the delivery suite gives: the
     * container's real URL policy denies whatever DATABASE_URL and REDIS_URL name, and
     * here that is 127.0.0.1. A panel elsewhere on loopback is the production shape.
     */
    panel = await startFakeMarzban({ host: '127.0.0.2' });

    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-manage', roleKeys: ['owner'] }),
    );

    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-manage-create',
    });
    panelId = created.view.panel.id;

    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-manage',
      telegramUserId: '910910',
      from: { id: 910910, first_name: 'مریم' },
      botInstanceId: BOT_A,
    });
    customerA = resolved.customer.id;
  });

  /** A settled order, which is what plans a provisioning operation. */
  async function paidOrder(key: string, customerId: UserId = customerA): Promise<OrderId> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        /*
         * No device limit. Marzban's descriptor does not declare `LIMIT_DEVICES` and
         * the executor refuses to sell one a panel cannot apply, so a fixture with a
         * device limit would never reach ACTIVE and every case here would be testing
         * that refusal instead.
         */
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(250_000n, 'IRT'),
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

  /** A service that exists on the panel and is ACTIVE here. */
  async function activeService(key: string): Promise<{ id: string; username: string }> {
    const orderId = await paidOrder(key);
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, orderId);
    if (service === undefined || service === null) throw new Error('no service');
    expect(service.state, 'the fixture must start ACTIVE').toBe('ACTIVE');
    return { id: service.id, username: providerUsernameFor(service.id) };
  }

  const customerUpdate = (payload: Record<string, unknown>, telegramUserId = '910910') => {
    updateSeq += 1;
    return {
      idempotencyKey: `bot-update-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      update: { update_id: updateSeq, ...payload },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'مریم' },
    };
  };

  const tapUpdate = (data: string, telegramUserId = '910910') =>
    customerUpdate(
      {
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'مریم' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: 5150, type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId,
    );

  const runtime = () => ctx.container.botRuntime;
  const messages = () => sent.filter((one) => one.url.includes('/sendMessage'));
  const lastMessage = () => JSON.stringify(messages()[messages().length - 1] ?? {});

  const operationOf = async (serviceId: string, type: string) =>
    (await operations.listForService(tenantA, serviceId, 50)).find(
      (operation) => operation.type === type,
    );

  /** Makes a backed-off operation due again without waiting out its retry interval. */
  async function makeOperationDue(): Promise<void> {
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET next_attempt_at = now() - interval '1 hour'`,
    );
  }

  // =========================================================================
  // What the customer is offered
  // =========================================================================

  it('offers pause and end on an active service, and the end button only ASKS', async () => {
    const service = await activeService('offer-active');

    const result = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`s:${service.id}`),
    );

    expect(result.replyKey).toBe('bot.service.detail');
    const body = lastMessage();
    expect(body, 'pause is offered').toContain(`u:${service.id}`);
    expect(body, 'resume is not, because the service is not suspended').not.toContain(
      `e:${service.id}`,
    );
    expect(body, 'end is offered as a QUESTION').toContain(`t:${service.id}`);
    /*
     * The destructive prefix appears nowhere on this screen. It is produced in one
     * place only — the confirmation — which is what makes "terminate takes two taps" a
     * property of the code rather than a promise in a comment.
     */
    expect(body, 'and never as the destructive callback').not.toContain(`k:${service.id}`);
  });

  // =========================================================================
  // Suspend and resume
  // =========================================================================

  it('pauses the account on the panel and says the request was recorded, not done', async () => {
    const service = await activeService('suspend-ok');

    const tapped = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`u:${service.id}`),
    );

    expect(tapped.intent).toBe('SERVICE_SUSPEND');
    /*
     * The panel has NOT been called yet. The provisioner claims the operation on its
     * next tick, so the acknowledgement says the request was recorded — claiming the
     * service is paused here would be a claim about somebody else's machine made
     * before anything was asked of it.
     */
    expect(tapped.replyKey).toBe('bot.service.action_requested');
    expect(panel.users.get(service.username)?.status, 'still active on the panel').toBe('active');
    expect((await services.findById(tenantA, service.id))?.state).toBe('ACTIVE');

    await ctx.container.provisionerLoop.tick();

    expect(panel.users.get(service.username)?.status).toBe('disabled');
    expect((await services.findById(tenantA, service.id))?.state).toBe('SUSPENDED');
    expect((await operationOf(service.id, 'SUSPEND'))?.state).toBe('SUCCEEDED');
  });

  it('then offers resume instead of pause, and resuming puts it back', async () => {
    const service = await activeService('resume-ok');
    await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`u:${service.id}`));
    await ctx.container.provisionerLoop.tick();

    const detail = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`s:${service.id}`),
    );
    expect(detail.replyKey).toBe('bot.service.detail');
    expect(lastMessage(), 'resume is offered').toContain(`e:${service.id}`);
    expect(lastMessage(), 'pause is not, because it is already paused').not.toContain(
      `u:${service.id}`,
    );

    await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`e:${service.id}`));
    await ctx.container.provisionerLoop.tick();

    expect(panel.users.get(service.username)?.status).toBe('active');
    expect((await services.findById(tenantA, service.id))?.state).toBe('ACTIVE');
    expect((await operationOf(service.id, 'RESUME'))?.state).toBe('SUCCEEDED');
  });

  it('does not rewrite the allowance the customer paid for while pausing', async () => {
    /*
     * `UserModify` applies every field that is PRESENT, so an adapter echoing the
     * service's expiry or volume would silently reset the customer's plan on every
     * pause. The acceptance suite proves the adapter sends only a status; this proves
     * it end to end, through the executor, against what the panel actually stored.
     */
    const service = await activeService('suspend-keeps-plan');
    const before = panel.users.get(service.username);
    expect(before?.dataLimit, 'the fixture sells 50GB').toBe(53_687_091_200);

    await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`u:${service.id}`));
    await ctx.container.provisionerLoop.tick();

    const after = panel.users.get(service.username);
    expect(after?.dataLimit).toBe(53_687_091_200);
    expect(after?.expire).toBe(before?.expire);
  });

  // =========================================================================
  // Terminate takes two taps
  // =========================================================================

  it('asks before it ends anything, and the question alone plans nothing', async () => {
    const service = await activeService('terminate-asks');

    const asked = await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`t:${service.id}`));

    expect(asked.intent).toBe('SERVICE_TERMINATE_ASK');
    expect(asked.replyKey).toBe('bot.service.terminate_confirm');
    // The one place the destructive callback is produced.
    expect(lastMessage()).toContain(`k:${service.id}`);
    expect(await operationOf(service.id, 'TERMINATE'), 'nothing was planned').toBeUndefined();
    expect(panel.users.has(service.username), 'and nothing was deleted').toBe(true);
  });

  it('ends the service on the second tap, and deletes the account on the panel', async () => {
    const service = await activeService('terminate-ok');
    await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`t:${service.id}`));

    const confirmed = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`k:${service.id}`),
    );

    expect(confirmed.intent).toBe('SERVICE_TERMINATE');
    expect(confirmed.replyKey).toBe('bot.service.action_requested');
    await ctx.container.provisionerLoop.tick();

    expect(panel.users.has(service.username), 'the account is gone').toBe(false);
    expect((await services.findById(tenantA, service.id))?.state).toBe('TERMINATED');
    expect((await operationOf(service.id, 'TERMINATE'))?.state).toBe('SUCCEEDED');
  });

  it('offers nothing further once the service has ended', async () => {
    const service = await activeService('terminate-then-detail');
    await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`k:${service.id}`));
    await ctx.container.provisionerLoop.tick();

    await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`s:${service.id}`));
    const body = lastMessage();
    for (const prefix of ['u:', 'e:', 't:', 'k:']) {
      expect(body, `${prefix} must not be offered for a terminated service`).not.toContain(
        `${prefix}${service.id}`,
      );
    }
    /*
     * And a second terminate is refused rather than becoming a second DELETE against
     * somebody's panel. `TERMINATED` is terminal in SERVICE_MACHINE and absent from
     * `OPERATION_LEGAL_FROM.TERMINATE`.
     */
    const again = await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`k:${service.id}`));
    expect(again.replyKey).toBe('bot.service.capability_unsupported');
  });

  // =========================================================================
  // Who may act
  // =========================================================================

  it('refuses another customer’s service with the SAME answer as one that does not exist', async () => {
    const service = await activeService('owner-only');
    await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r2'), {
      idempotencyKey: 'resolve-other',
      telegramUserId: '920920',
      from: { id: 920920, first_name: 'سارا' },
      botInstanceId: BOT_A,
    });

    const stolen = await runtime().handle(
      tenantA,
      systemActor('bot'),
      tapUpdate(`k:${service.id}`, '920920'),
    );

    expect(stolen.replyKey).toBe('bot.service.not_found');
    expect(await operationOf(service.id, 'TERMINATE'), 'nothing was planned').toBeUndefined();
    await ctx.container.provisionerLoop.tick();
    expect(panel.users.has(service.username), 'and the account is untouched').toBe(true);
  });

  it('cannot be reached from another tenant', async () => {
    /*
     * Tenant isolation, at the layer that matters for this phase: the repository read
     * is scoped, so tenant B asking for tenant A's service id finds nothing — and the
     * answer is the same one an id that does not exist gets, so the id is not an
     * oracle either.
     */
    const service = await activeService('tenant-isolation');
    await expect(
      ctx.container.provisioning.getForCustomer(
        { tenantId: SEED_IDS.tenantB } as never,
        customerA,
        service.id,
      ),
    ).rejects.toMatchObject({ code: 'commerce.service_not_found' });
    expect(panel.users.has(service.username)).toBe(true);
  });

  // =========================================================================
  // Replays, failures and divergence
  // =========================================================================

  it('plans ONE operation however many times the same tap arrives', async () => {
    /*
     * Two taps of one button share an idempotency key, and `findOpen` returns the
     * operation that exists rather than rivalling it. Both matter: the key stops two
     * simultaneous taps deriving two ids, and `findOpen` stops a later tap queueing a
     * second suspend for a service that is already being suspended.
     */
    const service = await activeService('replay-one');
    const tap = tapUpdate(`u:${service.id}`);

    await runtime().handle(tenantA, systemActor('bot'), tap);
    await runtime().handle(tenantA, systemActor('bot'), tap);
    await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`u:${service.id}`));

    const all = (await operations.listForService(tenantA, service.id, 50)).filter(
      (operation) => operation.type === 'SUSPEND',
    );
    expect(all).toHaveLength(1);
  });

  it('retries an uncertain suspend as the same suspend, rather than stranding it', async () => {
    /*
     * The rule `operationFailureOutcome` encodes. A create whose answer was lost is
     * UNKNOWN and waits for a read; a suspend whose answer was lost is FAILED and is
     * tried again, because repeating it changes nothing the first one did not already
     * do — measured against a real v0.8.4, not assumed.
     *
     * Routing it to UNKNOWN would strand it for ever: RECONCILE calls `lookupUser`,
     * which answers whether an account EXISTS and never what state it is in.
     */
    const service = await activeService('suspend-retry');
    await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`u:${service.id}`));

    panel.behaviour = 'server-error';
    await ctx.container.provisionerLoop.tick();

    const failed = await operationOf(service.id, 'SUSPEND');
    expect(failed?.state, 'planned again, not UNKNOWN and not terminal').toBe('PLANNED');
    expect((await services.findById(tenantA, service.id))?.state, 'and nothing moved').toBe(
      'ACTIVE',
    );

    panel.behaviour = 'healthy';
    await makeOperationDue();
    await ctx.container.provisionerLoop.tick();

    expect((await operationOf(service.id, 'SUSPEND'))?.state).toBe('SUCCEEDED');
    expect(panel.users.get(service.username)?.status).toBe('disabled');
  });

  it('never reports a suspend that suspended nothing', async () => {
    /*
     * The panel answers, authenticated, that it does not have this account. That is a
     * divergence and not a failure to reach anything: the operation FAILS with a
     * message naming it, and the service is NOT moved. Moving it would tell the
     * customer their service is paused while something, somewhere, keeps serving it.
     */
    const service = await activeService('suspend-absent');
    await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`u:${service.id}`));
    // Removed behind Nexa's back, as an operator poking the panel directly would.
    panel.forget(service.username);

    await ctx.container.provisionerLoop.tick();

    const operation = await operationOf(service.id, 'SUSPEND');
    expect(operation?.state).toBe('FAILED');
    expect(operation?.failureMessage).toContain('does not have');
    expect(operation?.failureKind, 'not a wire failure, so no failure kind').toBeNull();
    expect((await services.findById(tenantA, service.id))?.state).toBe('ACTIVE');
  });

  it('treats an account the panel has already lost as a terminate that succeeded', async () => {
    /*
     * The other side of the same fact, and the reason `wasPresent` exists: the goal of
     * a terminate is that this account is not on this panel, and that holds whether or
     * not the DELETE found anything. Failing here would strand every terminate whose
     * response went missing.
     */
    const service = await activeService('terminate-absent');
    await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`k:${service.id}`));
    panel.forget(service.username);

    await ctx.container.provisionerLoop.tick();

    expect((await operationOf(service.id, 'TERMINATE'))?.state).toBe('SUCCEEDED');
    expect((await services.findById(tenantA, service.id))?.state).toBe('TERMINATED');
  });

  it('claims no second operation for a service that already has one in flight', async () => {
    /*
     * The race this phase created, and the only one it created.
     *
     * Until TERMINATE became performable, two operations for one service could not both
     * be claimable: each type is legal from exactly one state and a service is in one
     * state. TERMINATE is legal from every non-terminal state, so a customer tapping
     * "end my service" while its PROVISION is on the wire gives two replicas two
     * claimable rows for one service.
     *
     * What that produces is invisible to everything else: the terminate DELETEs an
     * account that does not exist yet — a 404, which is a success — the service goes
     * TERMINATED, and then the create returns 200 and correctly moves nothing. Both
     * operations SUCCEED, no state is wrong, and an account exists on somebody's panel
     * that this installation has no row for.
     *
     * Simulated by stamping a PROVISION in flight with a live lease, which is what a
     * second replica mid-call looks like from this one's point of view.
     */
    const service = await activeService('one-in-flight');
    await ctx.container.database.db.execute(
      /*
       * `completed_at` is cleared in the same statement because
       * `provisioning_operations_completed_check` ties it to the state: a row in
       * IN_FLIGHT that still carries a completion timestamp is not a state this
       * schema will hold. Stamping one is the shape of the real race — a PROVISION
       * still on the wire — not a finished row pretending to be running.
       */
      sql`UPDATE provisioning_operations
             SET state = 'IN_FLIGHT',
                 claimed_by = 'other-replica',
                 lease_until = now() + interval '5 minutes',
                 completed_at = NULL
           WHERE service_id = ${service.id} AND type = 'PROVISION'`,
    );
    await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`u:${service.id}`));
    const deletesBefore = panel.requests.filter((one) => one.method === 'PUT').length;

    await ctx.container.provisionerLoop.tick();

    expect((await operationOf(service.id, 'SUSPEND'))?.state, 'not claimed').toBe('PLANNED');
    expect(panel.requests.filter((one) => one.method === 'PUT').length).toBe(deletesBefore);
    expect(panel.users.get(service.username)?.status).toBe('active');

    /*
     * And it is BLOCKED, not lost: once the sibling is no longer in flight the next
     * tick claims it and it runs on real information rather than a guess about
     * ordering.
     */
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations
             SET state = 'SUCCEEDED',
                 claimed_by = NULL,
                 lease_until = NULL,
                 completed_at = now()
           WHERE service_id = ${service.id} AND type = 'PROVISION'`,
    );
    await ctx.container.provisionerLoop.tick();

    expect((await operationOf(service.id, 'SUSPEND'))?.state).toBe('SUCCEEDED');
    expect(panel.users.get(service.username)?.status).toBe('disabled');
  });

  it('does not answer an outage with a sentence about the customer’s panel', async () => {
    /*
     * The refusal mapping is a CLOSED list, and this is the half of that decision no
     * reader can check by reading it.
     *
     * A catch-all would answer a database failure with `bot.service.capability_unsupported`
     * — "this is not available for your service" — which is a false statement about
     * the customer's panel, made to hide an outage, and indistinguishable in every log
     * this installation keeps from the three codes that really are refusals. The request
     * would also be reported as handled, so nothing would retry it and nothing would
     * record that anything had gone wrong.
     *
     * Injected where a real failure happens, at the write: a trigger that refuses the
     * INSERT the request makes. It is not a `CommerceError`, so no code in the list
     * matches, and the turn must fail rather than reply. Dropped in `finally`, because a
     * trigger left behind would fail every later test in this file with the same error
     * this one asserts.
     */
    const service = await activeService('outage-is-not-a-refusal');
    await ctx.container.database.db.execute(
      sql`CREATE FUNCTION nexa_test_refuse_operation() RETURNS trigger AS $$
            BEGIN RAISE EXCEPTION 'injected storage failure'; END;
          $$ LANGUAGE plpgsql`,
    );
    await ctx.container.database.db.execute(
      sql`CREATE TRIGGER nexa_test_refuse_operation
            BEFORE INSERT ON provisioning_operations
            FOR EACH ROW EXECUTE FUNCTION nexa_test_refuse_operation()`,
    );
    const said = messages().length;

    try {
      await expect(
        runtime().handle(tenantA, systemActor('bot'), tapUpdate(`u:${service.id}`)),
      ).rejects.toThrow();
    } finally {
      await ctx.container.database.db.execute(
        sql`DROP TRIGGER nexa_test_refuse_operation ON provisioning_operations`,
      );
      await ctx.container.database.db.execute(sql`DROP FUNCTION nexa_test_refuse_operation()`);
    }

    expect(messages().length, 'the customer was told nothing').toBe(said);
    expect(await operationOf(service.id, 'SUSPEND'), 'and nothing was planned').toBeUndefined();
  });

  it('records WHO asked for a service to be ended, as its own decision', async () => {
    /*
     * `plan` records no actor — an operation row says what is to be done and which
     * worker claimed it, not who wanted it — so without this row the only answer to
     * "who asked for this account to be deleted" is inferred from the fact that nobody
     * else can. Inference is what the legacy `/admin/logs` offered.
     *
     * TWO rows, and they are different facts: the request is a decision and the
     * execution is an effect. A terminate that was asked for and never carried out must
     * not look like one that was.
     */
    const service = await activeService('audit-terminate');
    await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`k:${service.id}`));

    const requested = await ctx.container.database.db.execute(
      sql`SELECT action, after FROM audit_logs WHERE entity_id = ${service.id} ORDER BY occurred_at`,
    );
    expect(requested.rows.map((row) => row['action'])).toContain('service.request_terminate');
    const decision = requested.rows.find((row) => row['action'] === 'service.request_terminate');
    expect((decision?.['after'] as Record<string, unknown>)['requestedBy']).toBe(customerA);

    await ctx.container.provisionerLoop.tick();

    const after = await ctx.container.database.db.execute(
      sql`SELECT action FROM audit_logs WHERE entity_id = ${service.id} ORDER BY occurred_at`,
    );
    expect(after.rows.map((row) => row['action'])).toEqual([
      // The whole life of this service, in order: settled, created on the panel, asked
      // to be ended, ended.
      'service.plan',
      'service.provision',
      'service.request_terminate',
      'service.terminate',
    ]);
  });

  it('makes its provider calls outside every database transaction', async () => {
    /*
     * Not an assertion about a counter: `refuseNetworkInsideTransaction` THROWS inside
     * `SafeHttpClient` whenever a request is made while a business transaction is open,
     * so an executor that called the panel from inside `uow.run` would fail this case
     * by never reaching the panel at all.
     *
     * Asserted through the whole management lifecycle rather than one call, because the
     * three new branches are three new places the mistake could be made and each of
     * them writes to the database on either side of its provider call.
     */
    const service = await activeService('outside-transactions');
    for (const data of [`u:${service.id}`, `e:${service.id}`, `k:${service.id}`]) {
      await runtime().handle(tenantA, systemActor('bot'), tapUpdate(data));
      await ctx.container.provisionerLoop.tick();
    }
    expect(panel.users.has(service.username), 'every call reached the panel').toBe(false);
    expect((await services.findById(tenantA, service.id))?.state).toBe('TERMINATED');
  });
});
