import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  money,
  operationIdFrom,
  DEFAULT_USERNAME_PATTERN,
  providerUsernameFor,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { sha256Hex } from '../../apps/api/src/infrastructure/crypto/operation-id';
import { DrizzlePanelCredentialStore } from '../../apps/api/src/modules/platform/panels/infrastructure/drizzle-panel-credentials';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { DrizzleOperationRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-operation.repository';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import { RETRYABLE_REFUSALS } from '../../apps/api/src/modules/commerce/provisioning/application/provisioner.service';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  validatePanelConnection,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * The provisioning invariants, against a real database.
 *
 * Every one of these is a way a customer ends up paying for one service and getting
 * none, or getting two. They are proven here rather than in a unit test because the
 * mechanism that holds each of them is a CONSTRAINT or a conditional UPDATE — the
 * things a mock cannot have.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('provisioning invariants', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let operations: DrizzleOperationRepository;
  let panelA: string;
  let customerA: UserId;
  let owner: ActorContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    products = new DrizzleProductRepository(ctx.container.database.db);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    operations = new DrizzleOperationRepository(ctx.container.database.db);
    panelA = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status, activation)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE',
              ${JSON.stringify({ subscriptionDomain: 'sub.example.test', inboundId: 1 })}::jsonb)`);
    /*
     * A real credential, because `decideOperability` checks for one.
     *
     * The fixture panel used to have none, and the activation case below then failed on
     * CREDENTIALS_MISSING — which was the ORDER working as designed (the most
     * operator-intentional cause first) and the fixture being unrealistic. A panel
     * nobody has given credentials to is not the panel any of these cases are about.
     */
    const credentials = new DrizzlePanelCredentialStore(
      ctx.container.database.db,
      ctx.container.cipher,
    );
    await ctx.container.uow.run(tenantA, async (tx) => {
      await credentials.write(
        tenantA,
        panelA,
        { username: 'admin', password: 'hunter2', apiToken: undefined },
        ctx.container.clock.now(),
        tx,
      );
    });
    /*
     * And a recorded connection test, which no part of the fixture above is.
     *
     * Since this hotfix a sale also needs evidence that the panel was CONTACTED
     * with the configuration it has now — `connectionIdentityOf` covers the
     * activation and the three credential timestamps, so this has to come after
     * both. A panel nobody ever probed is not the panel any of these cases are
     * about, exactly as the credential comment above says.
     */
    await validatePanelConnection(ctx.container, tenantA, panelA);
    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-prov',
      telegramUserId: '910910',
      from: { id: 910910, first_name: 'مریم' },
      botInstanceId: BOT_A,
    });
    customerA = resolved.customer.id;
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-prov', roleKeys: ['owner'] }),
    );
  });

  /*
   * The three operation writes that must pass through the unit of work.
   *
   * `claimDue`, `releaseExpiredLeases` and `markCallStarted` used to write on the pool.
   * That put them outside ADR-0028's quiesce gate, which lives in
   * `DrizzleUnitOfWork.run`, so a restore found the provisioner still mutating the
   * database it was replacing. They take a transaction now, and these wrappers keep the
   * cases below reading the way they did.
   */
  const claim = (worker: string, at: Date, lease: Date) =>
    ctx.container.uow.run(tenantA, async (tx) =>
      operations.claimDue(tenantA, worker, at, lease, tx),
    );
  const release = (at: Date, limit: number) =>
    ctx.container.uow.run(tenantA, async (tx) =>
      operations.releaseExpiredLeases(tenantA, at, limit, tx),
    );
  const startCall = (id: string, worker: string, at: Date) =>
    ctx.container.uow.run(tenantA, async (tx) =>
      operations.markCallStarted(tenantA, id, worker, at, tx),
    );

  /** An order that has been confirmed and is waiting for money. */
  async function awaitingPayment(key: string): Promise<OrderRecord> {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelA as PanelId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(250_000n, 'IRT'),
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const order = await ctx.container.orders.createDraft(tenantA, systemActor(key), {
      idempotencyKey: `${key}-draft`,
      customerId: customerA,
      productId: created.id,
    });
    return ctx.container.orders.confirm(tenantA, systemActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId: customerA,
      orderId: order.id,
    });
  }

  /** Settles an order from the wallet, which is the one path that takes `SETTLE`. */
  async function settle(key: string, order: OrderRecord): Promise<void> {
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), customerA, {
      idempotencyKey: `${key}-pay`,
      orderId: order.id,
    });
  }

  it('turns a PAID order into exactly one service and one planned operation', async () => {
    const order = await awaitingPayment('one');
    await settle('one', order);

    const service = await services.findByOrderId(tenantA, order.id);
    expect(service, 'a settled order is owed a service').not.toBeNull();
    expect(service?.state).toBe('PENDING_PROVISION');
    expect(service?.customerId).toBe(customerA);
    expect(service?.panelId).toBe(panelA);
    /*
     * The name the ORDER reserved, not one derived from the service id.
     *
     * This used to assert `providerUsernameFor(service.id)` and call the derivation
     * "what makes adoption possible later". Neither half is true any more: the name is
     * chosen and reserved BEFORE the money moves, so it cannot be a function of an id
     * that does not exist yet, and reconciliation adopts by asking the panel about the
     * name the row already carries.
     */
    expect(service?.providerUsername).toMatch(DEFAULT_USERNAME_PATTERN);

    const planned = await operations.listForService(tenantA, service?.id ?? '', 10);
    expect(planned).toHaveLength(1);
    expect(planned[0]?.type).toBe('PROVISION');
    expect(planned[0]?.state).toBe('PLANNED');
    // Nothing has been attempted, so no attempt has been counted and no call started.
    expect(planned[0]?.attempts).toBe(0);
    expect(planned[0]?.callStartedAt).toBeNull();
  });

  it('gives a service a subscription reference nothing can compute from its id', async () => {
    const order = await awaitingPayment('secret');
    await settle('secret', order);
    const service = await services.findByOrderId(tenantA, order.id);
    const serviceId = service?.id ?? '';

    expect(service?.subscriptionRef, 'the format the panels accept').toMatch(/^[0-9a-f]{32}$/);
    expect(service?.providerClientId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    /*
     * The exact derivation this column replaced, recomputed here.
     *
     * `subscriptionRefFor` was `sha256('nexa:subscription:' + serviceId).slice(0, 32)`
     * with the same unkeyed hasher that mints operation ids, and `providerUsernameFor`
     * is a reversible ENCODING of the service id rather than a hash — so a name read
     * off a panel's client list recovered the id, and the id travels in
     * `operational_events.context`, `audit_logs.entity_id` and
     * `outbox_messages.aggregate_id`. Anybody who could read an audit log could compute
     * the link that serves a customer's configuration unauthenticated.
     *
     * Asserting the stored value is DIFFERENT from that computation is what makes a
     * reintroduction fail here rather than in somebody's logs.
     */
    const oldDerivation = sha256Hex(`nexa:subscription:${serviceId.toLowerCase()}`).slice(0, 32);
    expect(service?.subscriptionRef, 'and not the old unkeyed hash of the id').not.toBe(
      oldDerivation,
    );
    expect(service?.providerClientId).not.toContain(
      sha256Hex(`nexa:client:${serviceId.toLowerCase()}`).slice(0, 8),
    );

    /*
     * And the username is NOT derived from the id either, which is the point of the
     * paragraph above: a name read off a panel's client list must not recover the
     * service id. It used to, because it was a reversible encoding of it.
     */
    expect(service?.providerUsername).not.toBe(providerUsernameFor(serviceId));
    expect(service?.providerUsername).toMatch(DEFAULT_USERNAME_PATTERN);

    // Two services on one panel never share a reference — an index, not a hope.
    const second = await awaitingPayment('secret-2');
    await settle('secret-2', second);
    const other = await services.findByOrderId(tenantA, second.id);
    expect(other?.subscriptionRef).not.toBe(service?.subscriptionRef);
    expect(other?.providerClientId).not.toBe(service?.providerClientId);
  });

  it('refuses a second service for the same order, at the database', async () => {
    const order = await awaitingPayment('dup');
    await settle('dup', order);
    const first = await services.findByOrderId(tenantA, order.id);
    expect(first).not.toBeNull();

    /*
     * The exactly-once rule, exercised against the INDEX rather than against the
     * service that normally guards it.
     *
     * A second insert naming the same order is what a replayed settlement, a second
     * replica or a double-tapped button all reduce to, and this asserts the row cannot
     * exist — so the guarantee does not depend on any application code being reached.
     */
    const second = await ctx.container.uow.run(tenantA, async (tx) =>
      services.create(
        tenantA,
        {
          id: ctx.container.ids.uuid(),
          customerId: customerA,
          orderId: order.id,
          panelId: panelA as PanelId,
          productId: first?.productId ?? ('' as ProductId),
          providerUsername: 'nx00000000000000000000000000000001',
          subscriptionRef: '00000000000000000000000000000001',
          providerClientId: '00000000-0000-4000-8000-000000000001',
          trafficLimitBytes: 0n,
        },
        ctx.container.clock.now(),
        tx,
      ),
    );
    expect(second, 'the unique index refuses a second service for one order').toBeNull();

    const rows = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM services WHERE order_id = ${order.id}`,
    );
    expect((rows.rows[0] as { n: number }).n).toBe(1);
  });

  it('gives two workers deriving one operation id the same row, so only one is planned', async () => {
    const order = await awaitingPayment('race');
    await settle('race', order);
    const service = await services.findByOrderId(tenantA, order.id);
    const serviceId = service?.id ?? '';

    /*
     * The derivation, exercised as the collision it exists to cause.
     *
     * Both callers derive the operation id from the same key with no lookup and no
     * coordination — the property `operation.ts` claims — so the second `plan` finds
     * the first's row instead of inserting one. A generated id here would produce two
     * operations and therefore two provider creates for one paid order, which is what
     * the reconcile path's first draft would have done.
     *
     * The key is the one the service itself uses, not a value invented here: a test
     * that derived its own key would prove the mechanism works on a key nothing sends.
     */
    const operationId = operationIdFrom('provider', `${serviceId}:PROVISION`, sha256Hex);
    const planOnce = (): Promise<{ readonly id: string }> =>
      ctx.container.uow.run(tenantA, async (tx) =>
        operations.plan(
          tenantA,
          {
            id: ctx.container.ids.uuid(),
            operationId,
            serviceId,
            orderId: order.id,
            requestedByCustomerId: null,
            panelId: panelA as PanelId,
            type: 'PROVISION',
          },
          ctx.container.clock.now(),
          tx,
        ),
      );

    const first = await planOnce();
    const second = await planOnce();
    expect(second.id, 'the second plan returns the first row rather than inserting one').toBe(
      first.id,
    );

    const all = await operations.listForService(tenantA, serviceId, 10);
    expect(all, 'one PROVISION operation, not two').toHaveLength(1);
    // And it is the one the SETTLEMENT planned — the derivation agrees across callers.
    expect(all[0]?.operationId).toBe(operationId);
  });

  it('lets only one of two racing workers claim an operation', async () => {
    const order = await awaitingPayment('claim');
    await settle('claim', order);
    const service = await services.findByOrderId(tenantA, order.id);
    const now = ctx.container.clock.now();
    const lease = new Date(now.getTime() + 60_000);

    /*
     * Driven twice IN SEQUENCE rather than with `Promise.allSettled`.
     *
     * `docs/phase4b-falsification.md` records M05 surviving against an allSettled
     * "race" that did not interleave, so this drives the two claims in a definite
     * order instead of hoping for one.
     *
     * It is WEAKER than the rule, and deliberately kept beside the case that is not.
     * A sequential pair is satisfied by the sub-select alone — the second caller's scan
     * simply finds nothing — so removing the outer `state = 'PLANNED'` predicate passes
     * here. `docs/phase4d-falsification.md` records that survival as F4D-05. What this
     * case proves is the ordinary two-worker outcome; the case below proves the
     * predicate, by making the interleaving.
     */
    const first = await claim('worker-1', now, lease);
    const second = await claim('worker-2', now, lease);

    expect(first, 'the first worker gets the operation').not.toBeNull();
    expect(second, 'the second finds nothing claimable').toBeNull();
    expect(first?.claimedBy).toBe('worker-1');
    expect(first?.attempts, 'the claim counted its attempt in the same statement').toBe(1);
    void service;
  });

  it('refuses a claim on a row another worker took while this one was blocked', async () => {
    const order = await awaitingPayment('lock');
    await settle('lock', order);
    const service = await services.findByOrderId(tenantA, order.id);
    const planned = await operations.listForService(tenantA, service?.id ?? '', 10);
    const operationId = planned[0]?.id ?? '';
    const now = ctx.container.clock.now();
    const lease = new Date(now.getTime() + 60_000);

    /*
     * The interleaving is MADE, not hoped for.
     *
     * The sequential case above is satisfied by the sub-select alone: the second
     * caller's scan simply finds nothing. That is why removing the outer
     * `state = 'PLANNED'` predicate SURVIVED it — a weaker test than the rule, which is
     * exactly what `docs/phase4b-falsification.md` records M05 surviving against.
     *
     * The rule this case is about is the concurrent one. Two workers' sub-selects can
     * both see a PLANNED row before either UPDATE commits; under READ COMMITTED the
     * loser then BLOCKS on the row lock and re-evaluates its WHERE clause against the
     * winner's committed row. Without the outer predicate it would match an IN_FLIGHT
     * row and overwrite somebody else's claim — two workers holding one operation, and
     * two provider calls for one paid order.
     *
     * So this holds the row lock in a transaction of its own, starts the claim so it
     * blocks on it, commits the competing claim, and then reads what the blocked caller
     * decided once it could see the new row.
     */
    const claimed = await ctx.container.database.withClient(async (holder) => {
      await holder.query('BEGIN');
      await holder.query(
        `UPDATE provisioning_operations
            SET state = 'IN_FLIGHT', claimed_by = 'holder',
                lease_until = now() + interval '1 hour', attempts = attempts + 1
          WHERE id = $1`,
        [operationId],
      );

      // Started, not awaited: it reaches the row lock and stops there.
      const blocked = claim('worker-2', now, lease);
      // Long enough for the claim to be queued on the lock rather than still parsing.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await holder.query('COMMIT');
      return blocked;
    });

    expect(claimed, 'the blocked worker sees the winner row and takes nothing').toBeNull();

    const after = await operations.findById(tenantA, operationId);
    expect(after?.claimedBy, "the winner's claim is intact").toBe('holder');
    expect(after?.attempts, 'exactly one attempt was counted').toBe(1);
  });

  it('will not release a lease once a provider call has been recorded as started', async () => {
    const order = await awaitingPayment('lease');
    await settle('lease', order);
    const now = ctx.container.clock.now();
    const claimed = await claim('worker-1', now, new Date(now.getTime() - 1_000));
    expect(claimed).not.toBeNull();

    // No call started yet: an expired lease is safe to return to the pool.
    const released = await release(now, 10);
    expect(released, 'an abandoned claim with no call started is reclaimable').toBe(1);

    /*
     * A LIVE lease this time, because the stamp now asserts one.
     *
     * `markCallStarted` refuses a worker whose lease has already lapsed — that window is
     * how two workers came to hold one operation — so proving the release guard needs a
     * claim that is genuinely this worker's at the moment it stamps, and an expiry that
     * arrives afterwards.
     */
    const live = new Date(now.getTime() + 60_000);
    const reclaimed = await claim('worker-2', now, live);
    expect(reclaimed).not.toBeNull();
    const stamped = await startCall(reclaimed?.id ?? '', 'worker-2', now);
    expect(stamped, 'the worker holding a live lease may stamp its call').toBe(true);

    /*
     * The guard `OPERATION_MACHINE` names, as a WHERE clause.
     *
     * A row whose call was started may have taken effect on the panel. Handing it to a
     * third worker would repeat that mutation, which is the duplicate account this
     * column exists to prevent — so the lease sweep will not take it.
     *
     * It is not abandoned either: `reapStrandedCalls` moves exactly these rows to
     * `UNKNOWN`, where a READ resolves them. This assertion is about the RELEASE sweep
     * specifically, which must never be the thing that recovers them.
     */
    const expired = new Date(live.getTime() + 1_000);
    const afterCall = await release(expired, 10);
    expect(afterCall, 'a started call is never released by the sweep').toBe(0);

    const still = await operations.findById(tenantA, reclaimed?.id ?? '');
    expect(still?.state).toBe('IN_FLIGHT');
    expect(still?.callStartedAt).not.toBeNull();
  });

  it('moves a stranded provider call to UNKNOWN, where a read can resolve it', async () => {
    const order = await awaitingPayment('stranded-repo');
    await settle('stranded-repo', order);
    const now = ctx.container.clock.now();

    const claimed = await claim('worker-1', now, new Date(now.getTime() + 1_000));
    expect(claimed).not.toBeNull();
    expect(await startCall(claimed?.id ?? '', 'worker-1', now), 'the call is stamped').toBe(true);

    /*
     * The row `releaseExpiredLeases` refuses, and nothing used to recover.
     *
     * Its comment said such a row waits for "a person or the reconciler", and neither
     * had a path: the reconciler scans UNKNOWN, `retireExhausted` scans PLANNED, and
     * `retryProvisioning` hands the open operation straight back. The paid order sat in
     * PENDING_PROVISION for ever with no operator condition anywhere.
     *
     * UNKNOWN and not PLANNED, because the call may have landed. That is the whole
     * difference, and it is why this is a separate sweep rather than a relaxation of the
     * release guard.
     */
    const expired = new Date(now.getTime() + 2_000);
    const reaped = await ctx.container.uow.run(tenantA, async (tx) =>
      operations.reapStrandedCalls(tenantA, expired, 10, tx),
    );
    expect(reaped, 'exactly the stranded row').toHaveLength(1);
    expect(reaped[0]?.state, 'a mutating call whose answer was lost is UNKNOWN').toBe('UNKNOWN');
    expect(reaped[0]?.claimedBy, 'and it holds no claim any more').toBeNull();

    const row = await operations.findById(tenantA, claimed?.id ?? '');
    expect(row?.state).toBe('UNKNOWN');
    expect(
      row?.completedAt,
      'UNKNOWN is not terminal, so it carries no completion time',
    ).toBeNull();

    const again = await ctx.container.uow.run(tenantA, async (tx) =>
      operations.reapStrandedCalls(tenantA, expired, 10, tx),
    );
    expect(again, 'the sweep is idempotent: a reaped row is no longer IN_FLIGHT').toHaveLength(0);
  });

  it('refuses the call stamp to a worker whose lease expired while it stalled', async () => {
    const order = await awaitingPayment('fence');
    await settle('fence', order);
    const now = ctx.container.clock.now();

    /*
     * The interleaving that produced two creates for one paid order.
     *
     * Worker 1 claims and then stalls. Its lease lapses; the sweep releases the row
     * legitimately, because nothing was stamped; worker 2 claims it. Worker 1 finally
     * wakes and goes to stamp. It must be REFUSED — and before this it was not, because
     * the statement matched on the row id and a null stamp alone, so the stalled worker
     * stamped the new worker's claim and both called the panel.
     */
    const claimed = await claim('worker-1', now, new Date(now.getTime() + 1_000));
    expect(claimed).not.toBeNull();

    const afterExpiry = new Date(now.getTime() + 2_000);
    expect(await release(afterExpiry, 10), 'an unstamped expired lease is released').toBe(1);
    const second = await claim('worker-2', afterExpiry, new Date(afterExpiry.getTime() + 60_000));
    expect(second?.claimedBy, 'the second worker holds it now').toBe('worker-2');

    expect(
      await startCall(claimed?.id ?? '', 'worker-1', afterExpiry),
      'the stalled worker is refused and makes no provider call',
    ).toBe(false);
    expect(
      await startCall(second?.id ?? '', 'worker-2', afterExpiry),
      'the worker that actually holds the claim may stamp',
    ).toBe(true);

    const row = await operations.findById(tenantA, claimed?.id ?? '');
    expect(row?.claimedBy, "the stalled worker did not overwrite the holder's claim").toBe(
      'worker-2',
    );
  });

  it('refuses to plan a retry for a service whose outcome is unknown', async () => {
    const order = await awaitingPayment('unrec');
    await settle('unrec', order);
    const service = await services.findByOrderId(tenantA, order.id);
    const serviceId = service?.id ?? '';

    await ctx.container.uow.run(tenantA, async (tx) => {
      await services.transition(
        tenantA,
        serviceId,
        'PENDING_PROVISION',
        'UNRECONCILED',
        null,
        ctx.container.clock.now(),
        tx,
      );
    });

    /*
     * The refusal `SERVICE_MACHINE` encodes as a missing edge, surfaced.
     *
     * A panel may hold an account for this service. Asking for another one is how a
     * customer ends up paying once and occupying twice, so the remedy is a READ and
     * the button that would skip it is refused by name.
     */
    await expect(
      ctx.container.provisioning.retryProvisioning(tenantA, owner, serviceId, {
        idempotencyKey: 'retry-unreconciled',
      }),
    ).rejects.toMatchObject({ code: 'commerce.service_unreconciled' });

    const all = await operations.listForService(tenantA, serviceId, 10);
    expect(all, 'no second create was planned').toHaveLength(1);
  });

  it('refuses a retry when the panel cannot be operated, and names why', async () => {
    const order = await awaitingPayment('disabled');
    await settle('disabled', order);
    const service = await services.findByOrderId(tenantA, order.id);

    await ctx.container.database.db.execute(
      sql`UPDATE panels SET status = 'DISABLED' WHERE id = ${panelA}`,
    );

    await expect(
      ctx.container.provisioning.retryProvisioning(tenantA, owner, service?.id ?? '', {
        idempotencyKey: 'retry-disabled',
      }),
    ).rejects.toMatchObject({
      code: 'commerce.panel_not_operable',
      details: { reason: 'PANEL_DISABLED' },
    });
  });

  it('refuses a retry when the panel has no activation configured', async () => {
    const order = await awaitingPayment('unset');
    await settle('unset', order);
    const service = await services.findByOrderId(tenantA, order.id);

    await ctx.container.database.db.execute(
      sql`UPDATE panels SET activation = NULL WHERE id = ${panelA}`,
    );

    /*
     * The gap `requiredActivationFields` named since Phase 3 and nothing stored.
     *
     * A 3X-UI panel with no subscription domain cannot produce the one thing a customer
     * buys, and before this phase it would have been connected, probed and reported
     * healthy anyway.
     */
    await expect(
      ctx.container.provisioning.retryProvisioning(tenantA, owner, service?.id ?? '', {
        idempotencyKey: 'retry-unset',
      }),
    ).rejects.toMatchObject({
      code: 'commerce.panel_not_operable',
      details: { reason: 'ACTIVATION_INCOMPLETE' },
    });
  });

  it('shows one tenant nothing of another tenant service', async () => {
    const order = await awaitingPayment('iso');
    await settle('iso', order);
    const service = await services.findByOrderId(tenantA, order.id);
    const serviceId = service?.id ?? '';

    /*
     * The same id, asked for in the wrong tenant.
     *
     * Not a filter on a list but a primary-key lookup, because that is the call a
     * surface makes when a client supplies an id — and the one that would return
     * another tenant's subscription URL, which is a bearer capability.
     */
    expect(await services.findById(tenantB, serviceId)).toBeNull();
    expect(await services.findByOrderId(tenantB, order.id)).toBeNull();
    expect(await operations.listForService(tenantB, serviceId, 10)).toHaveLength(0);
    expect((await services.list(tenantB, {}, 50, null)).items).toHaveLength(0);
  });

  it('leaves a service ACTIVE when its announcement is refused, and schedules a retry', async () => {
    const order = await awaitingPayment('deliver');
    await settle('deliver', order);
    const service = await services.findByOrderId(tenantA, order.id);
    const serviceId = service?.id ?? '';
    const now = ctx.container.clock.now();

    await ctx.container.uow.run(tenantA, async (tx) => {
      await services.transition(
        tenantA,
        serviceId,
        'PENDING_PROVISION',
        'ACTIVE',
        {
          providerUserId: null,
          subscriptionUrl: 'https://sub.example.test/sub/abc',
          expiresAt: new Date(now.getTime() + 86_400_000),
          trafficUsedBytes: null,
          usageSyncedAt: null,
        },
        now,
        tx,
      );
    });

    /*
     * A refused delivery, recorded.
     *
     * The service must stay ACTIVE: a provider account exists and the customer has paid
     * for it. Anything else invites re-provisioning a service that is already there.
     */
    await ctx.container.uow.run(tenantA, async (tx) => {
      await services.recordDelivery(
        tenantA,
        serviceId,
        'PENDING',
        'PENDING',
        { deliveredAt: null, nextAttemptAt: new Date(now.getTime() + 300_000) },
        now,
        tx,
      );
    });

    const after = await services.findById(tenantA, serviceId);
    expect(after?.state, 'a failed send does not unprovision a service').toBe('ACTIVE');
    expect(after?.deliveryState).toBe('PENDING');
    expect(after?.deliveryAttempts).toBe(1);
    expect(after?.deliveredAt).toBeNull();
    expect(after?.subscriptionUrl).toBe('https://sub.example.test/sub/abc');

    // And it is not due again until its backoff has elapsed. The second argument is the
    // lease a sweep would take; it changes nothing for a row that is not due.
    const lease = (at: Date): Date => new Date(at.getTime() + 60_000);
    expect(await services.claimDeliveryDue(tenantA, now, lease(now), 10)).toHaveLength(0);
    const later = new Date(now.getTime() + 300_001);
    expect(await services.claimDeliveryDue(tenantA, later, lease(later), 10)).toHaveLength(1);
    /*
     * And the claim LEASED it: a second sweep at the same moment finds nothing.
     *
     * The property two replicas depend on, asserted here rather than inferred from the
     * statement, because a `claimDeliveryDue` that only selected would satisfy every
     * other assertion in this test.
     */
    expect(await services.claimDeliveryDue(tenantA, later, lease(later), 10)).toHaveLength(0);
  });

  it('refuses a delivery claim on a row another sweep leased while this one was blocked', async () => {
    const order = await awaitingPayment('deliver-lock');
    await settle('deliver-lock', order);
    const service = await services.findByOrderId(tenantA, order.id);
    const serviceId = service?.id ?? '';
    const now = ctx.container.clock.now();
    await ctx.container.uow.run(tenantA, async (tx) => {
      await services.transition(
        tenantA,
        serviceId,
        'PENDING_PROVISION',
        'ACTIVE',
        {
          providerUserId: null,
          subscriptionUrl: 'https://sub.example.test/sub/locked',
          expiresAt: null,
          trafficUsedBytes: null,
          usageSyncedAt: null,
        },
        now,
        tx,
      );
    });

    /*
     * The interleaving is MADE, not hoped for — the same shape as the operation claim
     * above, and for the same reason.
     *
     * Two sequential claims are satisfied by the LEASE alone: the second caller's
     * sub-select sees a `delivery_next_attempt_at` in the future and scans nothing. The
     * rule this case is about is the concurrent one. Two sweeps' sub-selects can both
     * see a due row before either UPDATE commits; under READ COMMITTED the loser BLOCKS
     * on the row lock and re-evaluates its WHERE clause against the winner's committed
     * row. Without the outer `ready` predicate it would lease a row somebody else is
     * already sending — which is the customer receiving "your service is ready" twice,
     * with two different-looking links if the second attempt is ever redelivered.
     */
    const claimed = await ctx.container.database.withClient(async (holder) => {
      await holder.query('BEGIN');
      await holder.query(
        `UPDATE services SET delivery_next_attempt_at = now() + interval '1 hour' WHERE id = $1`,
        [serviceId],
      );

      // Started, not awaited: it reaches the row lock and stops there.
      const blocked = services.claimDeliveryDue(tenantA, now, new Date(now.getTime() + 60_000), 10);
      // Long enough for the claim to be queued on the lock rather than still parsing.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await holder.query('COMMIT');
      return blocked;
    });

    expect(claimed, 'the blocked sweep sees the leased row and takes nothing').toHaveLength(0);

    const after = await services.findById(tenantA, serviceId);
    expect(after?.deliveryState, "and it is still nobody's delivered service").toBe('PENDING');
    expect(after?.deliveryAttempts, 'a lease is not an attempt').toBe(0);
  });

  it('never sweeps a delivery whose outcome was unknown', async () => {
    const order = await awaitingPayment('unknown-send');
    await settle('unknown-send', order);
    const service = await services.findByOrderId(tenantA, order.id);
    const serviceId = service?.id ?? '';
    const now = ctx.container.clock.now();

    await ctx.container.uow.run(tenantA, async (tx) => {
      await services.transition(
        tenantA,
        serviceId,
        'PENDING_PROVISION',
        'ACTIVE',
        {
          providerUserId: null,
          subscriptionUrl: 'https://sub.example.test/sub/xyz',
          expiresAt: null,
          trafficUsedBytes: null,
          usageSyncedAt: null,
        },
        now,
        tx,
      );
      await services.recordDelivery(
        tenantA,
        serviceId,
        'PENDING',
        'UNCONFIRMED',
        { deliveredAt: null, nextAttemptAt: null },
        now,
        tx,
      );
    });

    /*
     * Telegram may have delivered it.
     *
     * The customer messenger's port records the reason this is never retried
     * automatically: a second "your service is ready" is a customer wondering which one
     * is true. Re-delivery from here is a deliberate act, so the sweep must not see it
     * at any time.
     */
    expect(await services.claimDeliveryDue(tenantA, now, now, 10)).toHaveLength(0);
    const far = new Date(now.getTime() + 86_400_000);
    expect(await services.claimDeliveryDue(tenantA, far, far, 10)).toHaveLength(0);
  });

  /*
   * The crash window between terminalising an operation and answering for it.
   *
   * `ProvisionerLoop` terminalises inside `executor.runOnce` and announces on the
   * NEXT line, in a second transaction. A process that dies in that gap leaves an
   * operation that is terminal, un-announced, and that nothing will ever call
   * `announce` for again — `docs/phase4j-audit.md` measures it, and these prove the
   * sweep that closes it against real rows rather than against a stub.
   *
   * Against the DATABASE and not a mock, because every property here is held by a
   * predicate: `announced_at IS NULL`, the `completed_at` grace, and the conditional
   * UPDATE that makes two replicas safe. A mock would assert the shape of a call.
   */
  describe('an operation a crash left terminal and unanswered', () => {
    async function terminalOperation(
      key: string,
      opts: { readonly completedAt: Date },
    ): Promise<string> {
      const order = await awaitingPayment(key);
      await settle(key, order);
      const service = await services.findByOrderId(tenantA, order.id);
      const serviceId = service?.id ?? '';
      const planned = await operations.listForService(tenantA, serviceId, 10);
      const id = planned[0]?.id ?? '';
      // PLANNED -> IN_FLIGHT -> SUCCEEDED, the real path, so `completed_at` is
      // written by the same statement production uses rather than by the test.
      await ctx.container.uow.run(tenantA, async (tx) => {
        await operations.transition(tenantA, id, 'PLANNED', 'IN_FLIGHT', {}, opts.completedAt, tx);
        await operations.transition(
          tenantA,
          id,
          'IN_FLIGHT',
          'SUCCEEDED',
          { completedAt: opts.completedAt },
          opts.completedAt,
          tx,
        );
      });
      return id;
    }

    /** A PROVISION nothing could resolve, which is what a customer is told about. */
    async function abandonedProvision(
      key: string,
      opts: { readonly completedAt: Date },
    ): Promise<{ readonly operationId: string; readonly serviceId: string }> {
      const order = await awaitingPayment(key);
      await settle(key, order);
      const service = await services.findByOrderId(tenantA, order.id);
      const serviceId = service?.id ?? '';
      const planned = await operations.listForService(tenantA, serviceId, 10);
      const operationId = planned[0]?.id ?? '';
      await ctx.container.uow.run(tenantA, async (tx) => {
        await operations.transition(
          tenantA,
          operationId,
          'PLANNED',
          'ABANDONED',
          { completedAt: opts.completedAt },
          opts.completedAt,
          tx,
        );
      });
      return { operationId, serviceId };
    }

    const GRACE_MS = 5 * 60 * 1000;

    it('is found by the sweep once it is past the grace, and not before', async () => {
      const now = ctx.container.clock.now();
      const justNow = await terminalOperation('sweep-fresh', { completedAt: now });
      const longAgo = await terminalOperation('sweep-stale', {
        completedAt: new Date(now.getTime() - GRACE_MS - 60_000),
      });

      const due = await ctx.container.uow.run(tenantA, async (tx) =>
        operations.dueForAnnouncement(tenantA, new Date(now.getTime() - GRACE_MS), 10, tx),
      );
      expect(due, 'the stale operation is swept').toContain(longAgo);
      expect(
        due,
        'the fresh one is left to the loop, which answers it within milliseconds',
      ).not.toContain(justNow);
    });

    it('stops being found once it has been answered', async () => {
      const now = ctx.container.clock.now();
      const before = new Date(now.getTime() - GRACE_MS);
      const id = await terminalOperation('sweep-once', {
        completedAt: new Date(now.getTime() - GRACE_MS - 60_000),
      });

      const first = await ctx.container.uow.run(tenantA, async (tx) =>
        operations.dueForAnnouncement(tenantA, before, 10, tx),
      );
      expect(first).toContain(id);

      await ctx.container.uow.run(tenantA, async (tx) =>
        operations.markAnnounced(tenantA, id, now, tx),
      );

      const second = await ctx.container.uow.run(tenantA, async (tx) =>
        operations.dueForAnnouncement(tenantA, before, 10, tx),
      );
      expect(second, 'a stamped operation is never swept again').not.toContain(id);
    });

    it('keeps the FIRST answer when two replicas stamp the same operation', async () => {
      /*
       * Two sweepers is the normal case on every rolling update. `markAnnounced`
       * carries `announced_at IS NULL` in its predicate, so the second writer
       * changes nothing — which is what makes the sweep safe WITHOUT a lease, and
       * a lease is machinery this would otherwise need.
       */
      const now = ctx.container.clock.now();
      const id = await terminalOperation('sweep-race', {
        completedAt: new Date(now.getTime() - GRACE_MS - 60_000),
      });

      const firstAt = new Date(now.getTime() - 1000);
      await ctx.container.uow.run(tenantA, async (tx) =>
        operations.markAnnounced(tenantA, id, firstAt, tx),
      );
      await ctx.container.uow.run(tenantA, async (tx) =>
        operations.markAnnounced(tenantA, id, now, tx),
      );

      const result = await ctx.container.database.db.execute(
        sql`select announced_at from provisioning_operations where id = ${id}`,
      );
      const row = result.rows[0] as { announced_at: Date | string } | undefined;
      expect(row, 'the operation row could not be read; this check is vacuous').toBeDefined();
      expect(
        new Date(row?.announced_at ?? 0).getTime(),
        'the second stamp overwrote the first',
      ).toBe(firstAt.getTime());
    });

    it('still answers a customer after an operator has STOPPED the tenant', async () => {
      /*
       * The one stated exception to "every write path refuses a stopped scope".
       *
       * `docs/phase4j-audit.md` and `docs/conventions.md` both record it, and this is
       * the test that fails if somebody "fixes" the announcer by adding the check every
       * other write path has. Telling a customer the outcome of work ALREADY DONE is not
       * new business work; suppressing it leaves somebody who paid in silence, which is
       * the gap Phase 4H existed to close. An operator stopping a tenant is not asking
       * for its existing customers to be abandoned mid-provision.
       *
       * The bound matters as much as the exception: the announcer may ENQUEUE. It may
       * not create an order, a payment, a service or an operation for a stopped tenant,
       * and nothing here gives it the means to.
       */
      const now = ctx.container.clock.now();
      const { operationId, serviceId } = await abandonedProvision('sweep-stopped', {
        completedAt: new Date(now.getTime() - GRACE_MS - 60_000),
      });
      ctx.container.setInstallationTenant(tenantA.tenantId);
      await ctx.container.database.db.execute(
        sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
      );

      await ctx.container.provisionerLoop.tick();

      const queued = await ctx.container.database.db.execute(
        sql`SELECT kind FROM customer_notifications
            WHERE tenant_id = ${tenantA.tenantId} AND subject_id = ${serviceId}`,
      );
      expect(queued.rows, 'a stopped tenant swallowed an answer somebody was owed').toHaveLength(1);
      expect((queued.rows[0] as { kind: string }).kind).toBe('SERVICE_PROVISION_DELAYED');

      const stamped = await ctx.container.database.db.execute(
        sql`SELECT announced_at FROM provisioning_operations WHERE id = ${operationId}`,
      );
      expect(
        (stamped.rows[0] as { announced_at: Date | null }).announced_at,
        'the operation was left unanswered, so the sweep will re-read it for ever',
      ).not.toBeNull();
    });

    it('finds the unanswered one without walking the history behind it', async () => {
      /*
       * `dueForAnnouncement` runs on EVERY provisioner tick, and the rows it wants are
       * the rarest in the table: an operation is unanswered only between its terminal
       * transition and the announcement. Without the partial index that is a scan of
       * every terminal operation an installation has ever completed, every tick, to
       * find none. Raised by the Codex review of PR #32.
       *
       * An index is a CLAIM until the planner is asked the question a CALLER asks, so
       * this asks it. Measured on THIS fixture, by deleting the declaration from
       * `ONLINE_INDEXES`, dropping the index and reading the failure: 67 buffers and a
       * `Seq Scan on provisioning_operations` without it. With it the assertion below
       * passes under 25. Both figures come from this file rather than from a
       * standalone probe, which is a distinction this repository has got wrong before.
       */
      const now = ctx.container.clock.now();
      const id = await terminalOperation('sweep-plan', {
        completedAt: new Date(now.getTime() - GRACE_MS - 60_000),
      });
      const seed = await operations.findById(tenantA, id);
      if (seed === null) throw new Error('no seed operation');

      // 3,000 operations this installation has already answered for, which is what the
      // sweep must NOT walk. Straight into the table: this is about the planner.
      await ctx.container.database.db.execute(sql`
        INSERT INTO provisioning_operations
          (id, tenant_id, operation_id, service_id, panel_id, type, state, attempts,
           completed_at, announced_at, created_at, updated_at)
        SELECT gen_random_uuid(), ${tenantA.tenantId}, lpad(to_hex(g + 4096), 16, '0'),
               ${seed.serviceId}, ${seed.panelId}, 'SYNC_USAGE', 'SUCCEEDED', 1,
               now() - ((g + 3600) || ' seconds')::interval,
               now() - ((g + 3000) || ' seconds')::interval,
               now() - ((g + 7200) || ' seconds')::interval,
               now() - ((g + 3000) || ' seconds')::interval
          FROM generate_series(1, 3000) AS g`);
      await ctx.container.database.db.execute(sql`ANALYZE provisioning_operations`);

      const explained = await ctx.container.database.db.execute(sql`
        EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF)
        SELECT id FROM provisioning_operations
         WHERE tenant_id = ${tenantA.tenantId}
           AND state IN ('SUCCEEDED', 'ABANDONED')
           AND announced_at IS NULL
           AND completed_at < ${new Date(now.getTime() - GRACE_MS)}
         ORDER BY completed_at ASC
         LIMIT 25`);
      const plan = (explained.rows as { 'QUERY PLAN': string }[])
        .map((row) => row['QUERY PLAN'])
        .join('\n');

      expect(plan, `the sweep is not served by its index:\n${plan}`).toContain(
        'provisioning_operations_unannounced_idx',
      );
      const buffers = /Buffers: shared( hit=(\d+))?( read=(\d+))?/.exec(plan);
      expect(buffers, `no buffer accounting in:\n${plan}`).not.toBeNull();
      expect(
        Number(buffers?.[2] ?? 0) + Number(buffers?.[4] ?? 0),
        `the sweep walked the answered history:\n${plan}`,
      ).toBeLessThan(25);

      // And it still returns the right row, so the index is not merely fast.
      const due = await ctx.container.uow.run(tenantA, async (tx) =>
        operations.dueForAnnouncement(tenantA, new Date(now.getTime() - GRACE_MS), 25, tx),
      );
      expect(due).toEqual([id]);
    });

    it('never sweeps an operation belonging to another tenant', async () => {
      const now = ctx.container.clock.now();
      const before = new Date(now.getTime() - GRACE_MS);
      const id = await terminalOperation('sweep-tenant', {
        completedAt: new Date(now.getTime() - GRACE_MS - 60_000),
      });

      const otherTenant = await ctx.container.uow.run(tenantB, async (tx) =>
        operations.dueForAnnouncement(tenantB, before, 10, tx),
      );
      expect(otherTenant, 'tenant B cannot see tenant A operations').not.toContain(id);
    });
  });

  /**
   * What the per-operation log line says happened, against what happened.
   *
   * Requirement 9 of the hotfix asks the provisioner to record a terminal outcome
   * per operation, and the field it added was computed rather than observed:
   * `refusalIsPermanent(reason) || exhausted(operation.attempts)`. Codex C3 on
   * PR #58 showed that wrong in both directions, and both are reachable.
   *
   * These assert the CORRESPONDENCE — the flag against the row the same tick
   * wrote — rather than a constant, because a constant is what the computation
   * already was.
   */
  describe('the per-operation log line and the row it describes', () => {
    async function plannedProvision(key: string): Promise<{
      readonly operationId: string;
      readonly serviceId: string;
    }> {
      const order = await awaitingPayment(key);
      await settle(key, order);
      const service = await services.findByOrderId(tenantA, order.id);
      const serviceId = service?.id ?? '';
      const planned = await operations.listForService(tenantA, serviceId, 10);
      return { operationId: planned[0]?.id ?? '', serviceId };
    }

    /**
     * The other direction. An operation whose service has left every state the
     * operation is legal from is transitioned to `ABANDONED` — terminal, nothing
     * will ever claim it again — and answered `SERVICE_ABSENT`, which is in
     * `RETRYABLE_REFUSALS`. The computed flag therefore said "will retry" about a
     * row that cannot.
     */
    it('reports an abandoned operation as terminal, however its reason is classified', async () => {
      const { operationId, serviceId } = await plannedProvision('abandon');
      // The service leaves the state PROVISION is legal from, which is the race
      // this refusal exists for: a terminate landing between the plan and the claim.
      await ctx.container.database.db.execute(
        sql`UPDATE services SET state = 'TERMINATED', terminated_at = now() WHERE id = ${serviceId}`,
      );

      const result = await ctx.container.provisioner.runOnce(tenantA);

      expect(result.kind).toBe('REFUSED');
      if (result.kind !== 'REFUSED') return;
      expect(result.reason).toBe('SERVICE_ABSENT');
      expect(result.terminal).toBe(true);
      // Named rather than inferred: the reason really is the retryable-classified
      // one, so this case cannot pass by the classification quietly changing.
      expect(RETRYABLE_REFUSALS).toContain(result.reason);

      const row = await ctx.container.database.db.execute(
        sql`SELECT state FROM provisioning_operations WHERE id = ${operationId}`,
      );
      expect((row.rows[0] as { state: string } | undefined)?.state).toBe('ABANDONED');
    });
  });
});
