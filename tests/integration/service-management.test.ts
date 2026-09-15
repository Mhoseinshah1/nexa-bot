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

  it('retries a suspend whose worker died mid-call, instead of stranding it for ever', async () => {
    /*
     * The dead end this phase would have shipped, found by review.
     *
     * `reapStrandedCalls` moves an operation whose worker died after the provider call
     * began to `UNKNOWN`, because a create that may have landed must be resolved by a
     * READ. Every mutation this module had until now was such a create. The three added
     * here are not, and for them `UNKNOWN` has no exit at all: the only path out is
     * `listUnknown`, which requires the SERVICE to be `UNRECONCILED`, and a service is
     * moved there from `PENDING_PROVISION` alone. A suspend strands its service `ACTIVE`,
     * so the row matched nothing — never reconciled, never retired, never claimable, and
     * still the open operation the customer's next tap is handed. The one thing they
     * asked for becomes the one thing that can no longer happen.
     *
     * A read could not have rescued it either: `lookupUser` answers whether an account
     * EXISTS, never whether it is disabled, so a reconcile has no question to ask. What
     * resolves it is what the real panel proved — sending the same disable again is
     * sending it once.
     *
     * Simulated exactly as a dead worker leaves the row: IN_FLIGHT, a lapsed lease, and
     * `call_started_at` set, which is the stamp that makes the ordinary lease sweep
     * refuse it.
     */
    const service = await activeService('stranded-suspend');
    await runtime().handle(tenantA, systemActor('bot'), tapUpdate(`u:${service.id}`));
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations
             SET state = 'IN_FLIGHT',
                 attempts = 1,
                 claimed_by = 'a-worker-that-died',
                 lease_until = now() - interval '5 minutes',
                 call_started_at = now() - interval '6 minutes'
           WHERE service_id = ${service.id} AND type = 'SUSPEND'`,
    );

    await ctx.container.provisionerLoop.tick();

    const suspend = await operationOf(service.id, 'SUSPEND');
    expect(suspend?.state, 'reaped to PLANNED and then performed in the same tick').toBe(
      'SUCCEEDED',
    );
    expect(panel.users.get(service.username)?.status, 'the account really was paused').toBe(
      'disabled',
    );
    expect((await services.findById(tenantA, service.id))?.state).toBe('SUSPENDED');

    /*
     * And the two things a stranded CREATE gets, which this must not: a service moved to
     * `UNRECONCILED` announces that this installation does not know what exists, when it
     * does, and an operator condition tells somebody to look into what the next tick
     * simply did.
     */
    const stalled = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS open FROM operational_events
           WHERE code = 'provisioning.stalled' AND resolved_at IS NULL`,
    );
    expect(stalled.rows[0]?.['open'], 'no operator was told to look into it').toBe(0);
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

  // =========================================================================
  // Phase 4F — buying something for a service that already exists
  // =========================================================================

  /** A configured, purchasable package of one kind. */
  async function offeredAddon(
    kind: 'ADD_TRAFFIC' | 'ADD_TIME',
    amount: { trafficBytes?: bigint; durationDays?: number },
    key: string,
  ): Promise<string> {
    const created = await ctx.container.serviceAddons.create(tenantA, owner, {
      idempotencyKey: `${key}-addon`,
      draft: {
        kind,
        title: kind === 'ADD_TRAFFIC' ? 'بسته ۱۰ گیگ' : 'بسته ۱۵ روز',
        sortOrder: 10,
        specification: {
          kind,
          trafficBytes: amount.trafficBytes ?? null,
          durationDays: amount.durationDays ?? null,
        },
        price: money(50_000n, 'IRT'),
      },
    });
    await ctx.container.serviceAddons.activate(tenantA, owner, {
      idempotencyKey: `${key}-addon-on`,
      addonId: created.id,
    });
    return created.id;
  }

  /** Money in the customer's wallet, so a commercial order can settle. */
  async function fund(key: string, customerId: UserId = customerA): Promise<void> {
    await ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: `act-${key}-fund`,
      direction: 'CREDIT',
      amountMinor: 5_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
  }

  /** Quote, confirm, pay — the three taps a customer actually makes. */
  async function buy(
    serviceId: string,
    kind: 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME',
    addonId: string | null,
    key: string,
    customerId: UserId = customerA,
  ): Promise<OrderId> {
    const { order } = await ctx.container.commercialActions.draft(
      tenantA,
      systemActor(key),
      customerId,
      {
        serviceId,
        kind,
        ...(addonId === null ? {} : { addonId }),
        /*
         * `act-` on every key. The fixture's own purchase already spent
         * `<key>-draft`, `<key>-confirm` and `<key>-pay` in the SAME customer
         * namespace, and reusing one with a different payload is a refusal by design —
         * `IDEMPOTENCY_PAYLOAD_MISMATCH` calls it a bug rather than a retry, which is
         * exactly right and exactly what this helper would otherwise be doing.
         */
        idempotencyKey: `act-${key}-quote`,
      },
    );
    await ctx.container.commercialActions.confirm(tenantA, systemActor(key), customerId, {
      orderId: order.id,
      idempotencyKey: `act-${key}-confirm`,
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), customerId, {
      idempotencyKey: `act-${key}-pay`,
      orderId: order.id,
    });
    return order.id;
  }

  it('renews a service: charged once, applied once, and the panel ends up holding it', async () => {
    const service = await activeService('renew-happy');
    const before = await services.findById(tenantA, service.id);
    await fund('renew-happy');

    await buy(service.id, 'RENEW', null, 'renew-happy');

    /*
     * The settling transaction plans the operation and contacts NOTHING. The panel's
     * own record is still what the create left, which is what "no provider call inside
     * a transaction" looks like from outside.
     */
    const planned = await operationOf(service.id, 'RENEW');
    expect(planned?.state).toBe('PLANNED');
    expect(planned?.target?.expiresAt).not.toBeNull();
    expect(planned?.target?.trafficLimitBytes).not.toBeNull();

    await ctx.container.provisionerLoop.tick();

    const done = await operationOf(service.id, 'RENEW');
    expect(done?.state).toBe('SUCCEEDED');

    const after = await services.findById(tenantA, service.id);
    // Strictly additive, and the two numbers the panel holds are the two Nexa stored.
    expect(after?.trafficLimitBytes).toBe((before?.trafficLimitBytes ?? 0n) * 2n);
    expect(after?.expiresAt?.getTime()).toBeGreaterThan(before?.expiresAt?.getTime() ?? 0);
    const onPanel = panel.users.get(service.username);
    expect(onPanel?.dataLimit).toBe(Number(after?.trafficLimitBytes));
    expect(onPanel?.expire).toBe(Math.floor((after?.expiresAt?.getTime() ?? 0) / 1000));

    // ONE debit for the renewal, on top of the original purchase's.
    const balance = await ctx.container.wallet.balance(tenantA, owner, customerA);
    expect(balance.amountMinor).toBe(5_000_000n + 1_000_000n - 250_000n - 250_000n);
  });

  it('adds traffic without touching the window, and keeps what has been consumed', async () => {
    const service = await activeService('traffic-happy');
    const before = await services.findById(tenantA, service.id);
    const addon = await offeredAddon('ADD_TRAFFIC', { trafficBytes: 10_000_000_000n }, 'traffic');
    await fund('traffic-happy');

    await buy(service.id, 'ADD_TRAFFIC', addon, 'traffic-happy');
    await ctx.container.provisionerLoop.tick();

    expect((await operationOf(service.id, 'ADD_TRAFFIC'))?.state).toBe('SUCCEEDED');
    const after = await services.findById(tenantA, service.id);
    expect(after?.trafficLimitBytes).toBe((before?.trafficLimitBytes ?? 0n) + 10_000_000_000n);
    // The window is the operation's null field, so nothing wrote it.
    expect(after?.expiresAt?.getTime()).toBe(before?.expiresAt?.getTime());
    expect(panel.users.get(service.username)?.expire).toBe(
      Math.floor((before?.expiresAt?.getTime() ?? 0) / 1000),
    );
  });

  it('adds time without touching the allowance', async () => {
    const service = await activeService('time-happy');
    const before = await services.findById(tenantA, service.id);
    const addon = await offeredAddon('ADD_TIME', { durationDays: 15 }, 'time');
    await fund('time-happy');

    await buy(service.id, 'ADD_TIME', addon, 'time-happy');
    await ctx.container.provisionerLoop.tick();

    expect((await operationOf(service.id, 'ADD_TIME'))?.state).toBe('SUCCEEDED');
    const after = await services.findById(tenantA, service.id);
    expect(after?.trafficLimitBytes).toBe(before?.trafficLimitBytes);
    expect(after?.expiresAt?.getTime()).toBe((before?.expiresAt?.getTime() ?? 0) + 15 * 86_400_000);
    /*
     * And on the PANEL, which is the half Nexa's own row cannot speak for.
     *
     * The stored allowance is written from the operation's target, and an `ADD_TIME`
     * target carries `null` there — so Nexa's number is unchanged whatever the adapter
     * sent. F4F-17 measured exactly that gap: an adapter that always sent `data_limit`,
     * using the unlimited sentinel for the field the customer did not buy, wiped the
     * cap on the panel and this case stayed green. The mirror of the extra-traffic case
     * above, which asserts the window on the panel for the same reason.
     */
    expect(panel.users.get(service.username)?.dataLimit).toBe(Number(before?.trafficLimitBytes));
  });

  it('takes an EXPIRED service back to ACTIVE, which is the edge this phase exists for', async () => {
    /*
     * `SERVICE_MACHINE`'s `EXPIRED -> ACTIVE on RENEW` was frozen in Phase 4D with no
     * caller at all. This is that caller, end to end: a service whose window closed,
     * a renewal bought for it, and the state the machine — not this file — says it
     * lands in.
     *
     * The period starts from NOW rather than from the old expiry, which is
     * `extendedExpiry`'s second half and `OQ-4F-02`: a customer must not be sold days
     * that have already elapsed. So the new window is in the future, and the sweep on
     * the next tick leaves it alone rather than expiring it again immediately.
     */
    const service = await activeService('renew-expired');
    await ctx.container.database.db.execute(
      sql`UPDATE services SET expires_at = now() - interval '2 days' WHERE id = ${service.id}`,
    );
    await ctx.container.provisionerLoop.tick();
    expect((await services.findById(tenantA, service.id))?.state).toBe('EXPIRED');

    await fund('renew-expired');
    await buy(service.id, 'RENEW', null, 'renew-expired');
    await ctx.container.provisionerLoop.tick();

    expect((await operationOf(service.id, 'RENEW'))?.state).toBe('SUCCEEDED');
    const revived = await services.findById(tenantA, service.id);
    expect(revived?.state).toBe('ACTIVE');
    expect(revived?.expiresAt?.getTime()).toBeGreaterThan(Date.now());

    // And the panel agrees, rather than Nexa reporting a revival it did not make.
    expect(panel.users.get(service.username)?.expire).toBe(
      Math.floor((revived?.expiresAt?.getTime() ?? 0) / 1000),
    );

    // A second sweep does not take it straight back out again.
    await ctx.container.provisionerLoop.tick();
    expect((await services.findById(tenantA, service.id))?.state).toBe('ACTIVE');
  });

  it('settles a renewal without creating a second service', async () => {
    /*
     * The defect the whole phase opened by naming. `confirmAndSettle` used to end in an
     * unconditional `planForSettledOrder`, so a renewal — a NEW order against the SAME
     * service — would have provisioned a second provider account the customer did not
     * buy. `services_tenant_order_key` does not catch it: a renewal has its own order id.
     */
    const service = await activeService('no-second');
    await fund('no-second');
    const orderId = await buy(service.id, 'RENEW', null, 'no-second');

    expect(await services.findByOrderId(tenantA, orderId)).toBeNull();
    const all = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM services WHERE tenant_id = ${tenantA.tenantId}`,
    );
    expect((all.rows[0] as { n: number }).n).toBe(1);
    // And no PROVISION was planned for it either.
    const provisions = (await operations.listForService(tenantA, service.id, 50)).filter(
      (operation) => operation.type === 'PROVISION',
    );
    expect(provisions).toHaveLength(1);
    expect(provisions[0]?.orderId).not.toBe(orderId);
  });

  it('applies a renewal once when the worker dies mid-call and the retry lands', async () => {
    /*
     * The claim `IDEMPOTENT_MUTATIONS` rests on, measured here against Nexa's own
     * machinery rather than the wire. A renewal whose answer was lost is retried as the
     * SAME call with the SAME stored target, so the account ends up where one renewal
     * would leave it and not where two would.
     */
    const service = await activeService('renew-retry');
    const before = await services.findById(tenantA, service.id);
    await fund('renew-retry');
    await buy(service.id, 'RENEW', null, 'renew-retry');

    // A worker that claimed it, started the call and died.
    await ctx.container.provisionerLoop.tick();
    const applied = await services.findById(tenantA, service.id);
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations
             SET state = 'IN_FLIGHT', attempts = 1, completed_at = NULL,
                 claimed_by = 'a-worker-that-died',
                 lease_until = now() - interval '5 minutes',
                 call_started_at = now() - interval '6 minutes'
           WHERE service_id = ${service.id} AND type = 'RENEW'`,
    );
    await ctx.container.provisionerLoop.tick();
    await makeOperationDue();
    await ctx.container.provisionerLoop.tick();

    expect((await operationOf(service.id, 'RENEW'))?.state).toBe('SUCCEEDED');
    const after = await services.findById(tenantA, service.id);
    // ONE renewal's worth, not two. An increment would have doubled it again.
    expect(after?.trafficLimitBytes).toBe(applied?.trafficLimitBytes);
    expect(after?.expiresAt?.getTime()).toBe(applied?.expiresAt?.getTime());
    expect(after?.trafficLimitBytes).toBe((before?.trafficLimitBytes ?? 0n) * 2n);
  });

  it('writes no allowance onto a service that moved while the call was in flight', async () => {
    /*
     * `recordAllowance` is a CONDITIONAL update naming the state the operation was
     * planned from, and this is what that condition is for: a service terminated or
     * expired while the PUT was on the wire keeps what that transition wrote.
     *
     * Reached directly rather than through the loop, because the window it guards is
     * between the provider answering and the transaction committing, and nothing in a
     * single-process test can land inside it. The rule is the `WHERE state = from`, and
     * that is exactly what is measured: the same call, once with the state the service
     * is in and once with the state it has left.
     *
     * F4F-26 reverted the condition and the whole suite stayed green, which is how this
     * case came to exist. Without it, a renewal whose answer arrived after an operator
     * terminated the service would quietly reactivate it and hand the customer thirty
     * days on an account that no longer exists.
     */
    const service = await activeService('late-write');
    const before = await services.findById(tenantA, service.id);
    const target = {
      expiresAt: new Date(Date.now() + 90 * 86_400_000),
      trafficLimitBytes: 999_000_000_000n,
    };

    await ctx.container.database.db.execute(
      sql`UPDATE services SET state = 'TERMINATED', terminated_at = now() WHERE id = ${service.id}`,
    );

    const applied = await ctx.container.uow.run(tenantA, async (tx) =>
      services.recordAllowance(tenantA, service.id, 'ACTIVE', 'ACTIVE', target, new Date(), tx),
    );

    expect(applied, 'the row the operation was planned from is gone').toBe(false);
    const after = await services.findById(tenantA, service.id);
    expect(after?.state).toBe('TERMINATED');
    expect(after?.expiresAt?.getTime()).toBe(before?.expiresAt?.getTime());
    expect(after?.trafficLimitBytes).toBe(before?.trafficLimitBytes);

    // And the same call against the state the row IS in does write.
    const second = await ctx.container.uow.run(tenantA, async (tx) =>
      services.recordAllowance(
        tenantA,
        service.id,
        'TERMINATED',
        'TERMINATED',
        target,
        new Date(),
        tx,
      ),
    );
    expect(second).toBe(true);
    expect((await services.findById(tenantA, service.id))?.trafficLimitBytes).toBe(
      target.trafficLimitBytes,
    );
  });

  it('charges and plans once when the same paid order is settled again', async () => {
    /*
     * Two refusals stand between a replayed settlement and a second renewal, and this
     * names which one actually fires.
     *
     * The OUTER one is the order state machine: a SETTLED order is not
     * `AWAITING_PAYMENT`, so a second settlement is refused before any of this phase's
     * code runs — even under a fresh idempotency key, which is what makes it a real
     * refusal rather than a cached answer.
     *
     * The INNER one is the operation id, derived from `service:kind:order` so a replay
     * plans the SAME row rather than a second one. F4F-24 replaced that derivation
     * with a fresh uuid and nothing failed, because the outer refusal fires first —
     * recorded as a survival in `docs/phase4f-falsification.md` rather than dressed up
     * as coverage. This case is the evidence for that reading, and it is what would
     * start failing if the order machine ever let a second settlement through.
     */
    const service = await activeService('settle-twice');
    await fund('settle-twice');
    const orderId = await buy(service.id, 'RENEW', null, 'settle-twice');
    const balanceAfterOne = await ctx.container.wallet.balance(tenantA, owner, customerA);

    await expect(
      ctx.container.payments.settleFromWallet(tenantA, systemActor('s2'), customerA, {
        idempotencyKey: 'act-settle-twice-pay-again',
        orderId,
      }),
    ).rejects.toMatchObject({ code: 'commerce.order_state_invalid' });

    const renewals = (await operations.listForService(tenantA, service.id, 50)).filter(
      (operation) => operation.type === 'RENEW',
    );
    expect(renewals).toHaveLength(1);
    const actions = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM service_commercial_actions
           WHERE tenant_id = ${tenantA.tenantId} AND service_id = ${service.id}`,
    );
    expect((actions.rows[0] as { n: number }).n).toBe(1);
    const balanceAfterTwo = await ctx.container.wallet.balance(tenantA, owner, customerA);
    expect(balanceAfterTwo.amountMinor).toBe(balanceAfterOne.amountMinor);
  });

  it('refuses a package of the wrong kind on the extra-traffic path', async () => {
    /*
     * The ONE thing a client can influence here: the add-on id. A callback naming an
     * `ADD_TIME` row on the extra-traffic path would otherwise buy a quantity in the
     * wrong unit at the wrong price.
     */
    const service = await activeService('wrong-kind');
    const timeAddon = await offeredAddon('ADD_TIME', { durationDays: 15 }, 'wrong-kind');
    await fund('wrong-kind');

    await expect(
      ctx.container.commercialActions.draft(tenantA, systemActor('wk'), customerA, {
        serviceId: service.id,
        kind: 'ADD_TRAFFIC',
        addonId: timeAddon,
        idempotencyKey: 'wrong-kind-quote',
      }),
    ).rejects.toMatchObject({ code: 'commerce.addon_not_purchasable' });
  });

  it('refuses a package the operator has withdrawn since the button was drawn', async () => {
    /*
     * The callback a customer is holding outlives the row it names.
     *
     * `availableFor` stops drawing the button the moment an add-on is deactivated, and
     * that is not the guard — a customer scrolling back to a message from this morning
     * sends the same id either way. F4F-21 measured it: with the purchasability check
     * removed, every case stayed green and a withdrawn package was still sellable.
     *
     * Deactivating is the operator saying stop selling this. The price is the other
     * half of the same rule — `catalog.ts` says an absent price means unsellable and
     * never free — and both are refused where the id arrives.
     */
    const service = await activeService('withdrawn');
    const addon = await offeredAddon('ADD_TRAFFIC', { trafficBytes: 5_000_000_000n }, 'withdrawn');
    await fund('withdrawn');

    await ctx.container.serviceAddons.deactivate(tenantA, owner, {
      idempotencyKey: 'withdrawn-addon-off',
      addonId: addon,
    });

    // Not offered any more...
    const offered = await ctx.container.commercialActions.availableFor(
      tenantA,
      systemActor('w'),
      (await services.findById(tenantA, service.id)) ??
        (() => {
          throw new Error('no service');
        })(),
    );
    expect(offered).not.toContain('ADD_TRAFFIC');

    // ...and the tap that names it anyway is refused rather than priced.
    await expect(
      ctx.container.commercialActions.draft(tenantA, systemActor('w'), customerA, {
        serviceId: service.id,
        kind: 'ADD_TRAFFIC',
        addonId: addon,
        idempotencyKey: 'withdrawn-quote',
      }),
    ).rejects.toMatchObject({ code: 'commerce.addon_not_purchasable' });
  });

  it('refuses another tenant’s customer, with the answer an absent service gets', async () => {
    const service = await activeService('cross-tenant');
    const stranger = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor('stranger'),
      {
        idempotencyKey: 'resolve-stranger',
        telegramUserId: '111222',
        from: { id: 111222, first_name: 'دیگری' },
        botInstanceId: BOT_A,
      },
    );
    await expect(
      ctx.container.commercialActions.draft(tenantA, systemActor('x'), stranger.customer.id, {
        serviceId: service.id,
        kind: 'RENEW',
        idempotencyKey: 'cross-tenant-quote',
      }),
    ).rejects.toMatchObject({ code: 'commerce.service_not_found' });
  });

  it('makes an action with no configured package explicitly unavailable', async () => {
    /*
     * Never free, and never a guess. `catalog.ts` says an absent price means unsellable,
     * and this is that rule reaching the customer: no package configured, so the button
     * is not offered and the tap is refused.
     */
    const service = await activeService('nothing-offered');

    const offered = await ctx.container.commercialActions.availableFor(
      tenantA,
      systemActor('a'),
      (await services.findById(tenantA, service.id)) ??
        (() => {
          throw new Error('no service');
        })(),
    );
    expect(offered).not.toContain('ADD_TRAFFIC');
    expect(offered).not.toContain('ADD_TIME');
    // The renewal IS offered: its plan is still ACTIVE and priced.
    expect(offered).toContain('RENEW');

    /*
     * With no package configured there is no id to send, and the request that arrives
     * without one is refused as invalid rather than priced at zero. `offer` — the read
     * the surface uses — answers `SERVICE_ACTION_UNAVAILABLE` for the same situation,
     * which is why no button is drawn in the first place.
     */
    await expect(
      ctx.container.commercialActions.draft(tenantA, systemActor('n'), customerA, {
        serviceId: service.id,
        kind: 'ADD_TRAFFIC',
        idempotencyKey: 'nothing-offered-quote',
      }),
    ).rejects.toMatchObject({ code: 'commerce.request_invalid' });
    await expect(
      ctx.container.commercialActions.offer(
        tenantA,
        systemActor('n2'),
        customerA,
        service.id,
        'ADD_TRAFFIC',
      ),
    ).rejects.toMatchObject({ code: 'commerce.service_action_unavailable' });
  });

  it('does not double-buy when the customer taps the quote button twice', async () => {
    const service = await activeService('double-tap');
    await fund('double-tap');

    const first = await ctx.container.commercialActions.draft(
      tenantA,
      systemActor('d'),
      customerA,
      { serviceId: service.id, kind: 'RENEW', idempotencyKey: 'double-tap-quote' },
    );
    const second = await ctx.container.commercialActions.draft(
      tenantA,
      systemActor('d'),
      customerA,
      { serviceId: service.id, kind: 'RENEW', idempotencyKey: 'double-tap-quote' },
    );
    expect(second.order.id).toBe(first.order.id);
    expect(second.action.id).toBe(first.action.id);

    const rows = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM service_commercial_actions
           WHERE tenant_id = ${tenantA.tenantId}`,
    );
    expect((rows.rows[0] as { n: number }).n).toBe(1);
  });

  it('leaves the invoice line unchanged, because evidence that can be edited is not evidence', async () => {
    const service = await activeService('append-only');
    await fund('append-only');
    await buy(service.id, 'RENEW', null, 'append-only');

    await expect(
      ctx.container.database.db.execute(
        sql`UPDATE service_commercial_actions SET amount = 1 WHERE tenant_id = ${tenantA.tenantId}`,
      ),
    ).rejects.toThrow();
    await expect(
      ctx.container.database.db.execute(
        sql`DELETE FROM service_commercial_actions WHERE tenant_id = ${tenantA.tenantId}`,
      ),
    ).rejects.toThrow();
  });

  it('refuses a renewal of a terminated service at settlement, and the money does not move', async () => {
    /*
     * The window between confirming a quote and paying for it is real: a customer can
     * confirm a renewal and pay minutes later, and the service can be terminated in
     * between. The refusal is LOUD — the settlement rolls back — because a paid order
     * with no operation behind it and nothing to say why is exactly what
     * `settlementRefusal` already refuses for the same reason.
     */
    const service = await activeService('gone-by-settlement');
    await fund('gone-by-settlement');
    const { order } = await ctx.container.commercialActions.draft(
      tenantA,
      systemActor('g'),
      customerA,
      { serviceId: service.id, kind: 'RENEW', idempotencyKey: 'gone-quote' },
    );
    await ctx.container.commercialActions.confirm(tenantA, systemActor('g'), customerA, {
      orderId: order.id,
      idempotencyKey: 'gone-confirm',
    });

    const balanceBefore = await ctx.container.wallet.balance(tenantA, owner, customerA);
    await ctx.container.database.db.execute(
      sql`UPDATE services SET state = 'TERMINATED', terminated_at = now()
           WHERE id = ${service.id}`,
    );

    await expect(
      ctx.container.payments.settleFromWallet(tenantA, systemActor('g'), customerA, {
        idempotencyKey: 'gone-pay',
        orderId: order.id,
      }),
    ).rejects.toMatchObject({ code: 'commerce.service_action_not_allowed' });

    const balanceAfter = await ctx.container.wallet.balance(tenantA, owner, customerA);
    expect(balanceAfter.amountMinor).toBe(balanceBefore.amountMinor);
  });
});
