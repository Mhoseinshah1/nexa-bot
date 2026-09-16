import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTOMER_NOTIFICATION_MAX_ATTEMPTS,
  CUSTOMER_NOTIFICATION_SWEEP_LIMIT,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type CustomerNotificationKind,
  type UserId,
} from '@nexa/contracts';
import { DrizzleCustomerNotificationRepository } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-notification.repository';
import {
  CustomerNotificationService,
  type NotificationSweepReport,
} from '../../apps/api/src/modules/commerce/messaging/application/customer-notification.service';
import type {
  CustomerMessage,
  CustomerSendResult,
} from '../../apps/api/src/modules/commerce/messaging/application/ports';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { createTestContext, SEED_IDS, tenantA, tenantB, type TestContext } from './harness';

/**
 * The customer notification lane, against a real database.
 *
 * `docs/phase4h-audit.md` §1 measured what this replaces: before Phase 4H this product
 * could tell a customer exactly ONE thing they had not asked for, and its state lived in
 * two columns on `services` because there was only ever one subject.
 *
 * Every case here is one of the ways the lane could tell a customer the wrong thing, or
 * the right thing twice, or nothing at all:
 *
 *   - told ONCE, enforced by a constraint rather than a read-then-write, because two
 *     worker replicas are the normal case on every rolling update;
 *   - never RETRIED after an unknown outcome, because a second "your payment was
 *     rejected" is a customer wondering which message is true;
 *   - never STRANDED, because a process that dies mid-send leaves a stamp and something
 *     has to resolve it;
 *   - never SPENDING AN ATTEMPT on a rate limit, which is the defect §6b measured;
 *   - never crossing a tenant boundary.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (key: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'customer-notifications:test',
  surface: 'TELEGRAM',
  correlationId: `corr-${key}` as CorrelationId,
});

describe('the customer notification lane', () => {
  let ctx: TestContext;
  let repo: DrizzleCustomerNotificationRepository;
  let people: DrizzleCustomerRepository;

  /** Every send the fake messenger saw, in order. */
  let sends: CustomerMessage[] = [];
  /** What the next send returns. A queue, so one pass can see several outcomes. */
  let outcomes: CustomerSendResult[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
    repo = new DrizzleCustomerNotificationRepository(ctx.container.database.db);
    people = new DrizzleCustomerRepository(ctx.container.database.db);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    sends = [];
    outcomes = [];
  });

  async function customer(scope: typeof tenantA, telegramUserId: string): Promise<UserId> {
    const { customer: record } = await ctx.container.customers.resolveFromUpdate(
      scope,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'زهرا' },
        botInstanceId: scope === tenantA ? BOT_A : (SEED_IDS.botB1 as BotInstanceId),
      },
    );
    return record.id;
  }

  /** A lane whose messenger is ours, so an outcome is a fixture rather than a network. */
  function lane(options: { readonly stillHolds?: boolean; readonly active?: boolean } = {}) {
    return new CustomerNotificationService({
      notifications: repo,
      contacts: {
        contactFor: async (scope, customerId, tx) => {
          const found = await people.findById(scope, customerId, tx);
          if (found === null) return { kind: 'NONE' };
          if (found.status !== 'ACTIVE') return { kind: 'BLOCKED' };
          return { kind: 'CONTACT', contact: { chatId: found.telegramUserId } };
        },
      },
      subjects: { stillHolds: async () => options.stillHolds ?? true },
      messenger: {
        send: async (_scope, message) => {
          sends.push(message);
          return outcomes.shift() ?? { outcome: 'DELIVERED' };
        },
        acknowledge: async () => undefined,
      },
      uow: ctx.container.uow,
      clock: ctx.container.clock,
      scopeIsActive: async () => options.active ?? true,
      logger: { info: () => {}, error: () => {} },
    });
  }

  async function enqueue(
    scope: typeof tenantA,
    customerId: UserId,
    kind: CustomerNotificationKind,
    subjectId: string,
    id = ctx.container.ids.uuid(),
  ): Promise<boolean> {
    return ctx.container.uow.run(scope, async (tx) =>
      repo.enqueue(
        scope,
        {
          id,
          customerId,
          botInstanceId: scope === tenantA ? BOT_A : (SEED_IDS.botB1 as BotInstanceId),
          kind,
          subjectId,
        },
        ctx.container.clock.now(),
        tx,
      ),
    );
  }

  async function rows(scope: typeof tenantA) {
    const result = await ctx.container.database.db.execute(
      sql`SELECT id, kind, state, attempts, next_attempt_at, send_started_at, resolved_at
          FROM customer_notifications WHERE tenant_id = ${scope.tenantId} ORDER BY created_at`,
    );
    return result.rows as unknown as readonly {
      id: string;
      kind: string;
      state: string;
      attempts: number;
      next_attempt_at: Date | null;
      send_started_at: Date | null;
      resolved_at: Date | null;
    }[];
  }

  const sweep = (l: CustomerNotificationService): Promise<NotificationSweepReport> =>
    l.deliverDue(tenantA, CUSTOMER_NOTIFICATION_SWEEP_LIMIT);

  // -------------------------------------------------------------------------

  it('tells a customer once, and a second producer loses on the constraint', async () => {
    /*
     * The lane's idempotency, and it is a CONSTRAINT rather than a check in a service:
     * producers enqueue inside the transaction that produced the fact, two replicas are
     * normal on every rolling update, and a redelivered outbox message replays its
     * effect. "Payment X was rejected" is told once whichever of those happens.
     */
    const id = await customer(tenantA, '5001');
    const subject = ctx.container.ids.uuid();

    expect(await enqueue(tenantA, id, 'PAYMENT_REJECTED', subject)).toBe(true);
    expect(await enqueue(tenantA, id, 'PAYMENT_REJECTED', subject)).toBe(false);

    expect(await rows(tenantA)).toHaveLength(1);
  });

  it('the same subject may carry two DIFFERENT kinds', async () => {
    // The key is (tenant, kind, subject). A payment that was rejected and an order that
    // expired are different sentences about related things, and both are owed.
    const id = await customer(tenantA, '5002');
    const subject = ctx.container.ids.uuid();
    expect(await enqueue(tenantA, id, 'PAYMENT_REJECTED', subject)).toBe(true);
    expect(await enqueue(tenantA, id, 'PAYMENT_EXPIRED', subject)).toBe(true);
    expect(await rows(tenantA)).toHaveLength(2);
  });

  it('delivers a queued notification and resolves it exactly once', async () => {
    const id = await customer(tenantA, '5003');
    await enqueue(tenantA, id, 'PAYMENT_REJECTED', ctx.container.ids.uuid());

    const report = await sweep(lane());
    expect(report.claimed).toBe(1);
    expect(report.delivered).toBe(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.templateKey).toBe('bot.payment.rejected');

    const [row] = await rows(tenantA);
    expect(row?.state).toBe('DELIVERED');
    expect(row?.attempts).toBe(1);
    expect(row?.resolved_at).not.toBeNull();
    expect(row?.send_started_at).toBeNull();

    // A second pass finds nothing: DELIVERED is not claimable.
    const again = await sweep(lane());
    expect(again.claimed).toBe(0);
    expect(sends).toHaveLength(1);
  });

  it('a rate limit spends NO attempt and leaves the row claimable at Telegram’s time', async () => {
    /*
     * The defect `docs/phase4h-audit.md` §6b measured, in the new lane. A 429 is
     * Telegram declining the request, so the message was not sent and the attempt
     * ceiling — which bounds refusals OF THIS MESSAGE — must not move. Spending one
     * here would fail a message after three busy minutes.
     */
    const id = await customer(tenantA, '5004');
    await enqueue(tenantA, id, 'PAYMENT_EXPIRED', ctx.container.ids.uuid());

    outcomes = [{ outcome: 'RATE_LIMITED', retryAfterMs: 30_000 }];
    const report = await sweep(lane());
    expect(report.rateLimited).toBe(1);

    const [row] = await rows(tenantA);
    expect(row?.state).toBe('PENDING');
    expect(row?.attempts, 'a rate limit spent an attempt').toBe(0);
    expect(row?.resolved_at).toBeNull();
    // Claimable again — the stamp is cleared, because the request was declined rather
    // than lost, so this row does not have to wait for `reapStranded`.
    expect(row?.send_started_at).toBeNull();
    expect(row?.next_attempt_at).not.toBeNull();
  });

  it('a refusal spends an attempt and stops at the ceiling', async () => {
    const id = await customer(tenantA, '5005');
    await enqueue(tenantA, id, 'SERVICE_ACTION_FAILED', ctx.container.ids.uuid());

    for (let attempt = 1; attempt <= CUSTOMER_NOTIFICATION_MAX_ATTEMPTS; attempt += 1) {
      outcomes = [{ outcome: 'REFUSED' }];
      // Backoff pushes `next_attempt_at` out, so each pass needs the clock moved past it.
      await ctx.container.database.db.execute(
        sql`UPDATE customer_notifications SET next_attempt_at = NULL WHERE tenant_id = ${tenantA.tenantId}`,
      );
      await sweep(lane());
      const [row] = await rows(tenantA);
      expect(row?.attempts).toBe(attempt);
      expect(row?.state).toBe(attempt >= CUSTOMER_NOTIFICATION_MAX_ATTEMPTS ? 'FAILED' : 'PENDING');
    }

    // FAILED is terminal: the next pass does not claim it.
    await ctx.container.database.db.execute(
      sql`UPDATE customer_notifications SET next_attempt_at = NULL WHERE tenant_id = ${tenantA.tenantId}`,
    );
    expect((await sweep(lane())).claimed).toBe(0);
  });

  it('an UNKNOWN outcome is never retried automatically', async () => {
    /*
     * The rule the whole lane inherits. A timeout, a 5xx or an unreadable 2xx means
     * Telegram MAY have delivered it, and a retried "your payment was rejected" is a
     * customer wondering which message is true.
     */
    const id = await customer(tenantA, '5006');
    await enqueue(tenantA, id, 'PAYMENT_REJECTED', ctx.container.ids.uuid());

    outcomes = [{ outcome: 'UNKNOWN' }];
    expect((await sweep(lane())).unconfirmed).toBe(1);
    expect((await rows(tenantA))[0]?.state).toBe('UNCONFIRMED');

    await ctx.container.database.db.execute(
      sql`UPDATE customer_notifications SET next_attempt_at = NULL WHERE tenant_id = ${tenantA.tenantId}`,
    );
    expect((await sweep(lane())).claimed, 'UNCONFIRMED was re-claimed').toBe(0);
    expect(sends).toHaveLength(1);
  });

  it('supersedes a notification whose fact stopped being true, without sending it', async () => {
    /*
     * ADR 0030 §3. `SERVICE_PROVISION_DELAYED` is the one kind with a precondition, and
     * telling a customer their service is slow a second after sending them the link
     * would be worse than not telling them.
     */
    const id = await customer(tenantA, '5007');
    await enqueue(tenantA, id, 'SERVICE_PROVISION_DELAYED', ctx.container.ids.uuid());

    const report = await sweep(lane({ stillHolds: false }));
    expect(report.superseded).toBe(1);
    expect(sends, 'a superseded notification was sent anyway').toHaveLength(0);

    const [row] = await rows(tenantA);
    expect(row?.state).toBe('SUPERSEDED');
    expect(row?.resolved_at).not.toBeNull();
  });

  it('does not ask the precondition for a kind that declares none', async () => {
    // Five of the six kinds are terminal facts. Asking would be a read that can only
    // agree, and the reader THROWS if asked, so a regression here fails loudly.
    const id = await customer(tenantA, '5008');
    await enqueue(tenantA, id, 'ORDER_EXPIRED', ctx.container.ids.uuid());

    let asked = false;
    const l = lane();
    (l as unknown as { deps: { subjects: { stillHolds: () => Promise<boolean> } } }).deps.subjects =
      {
        stillHolds: async () => {
          asked = true;
          return true;
        },
      };
    await sweep(l);
    expect(asked, 'the dispatcher asked a precondition for a terminal fact').toBe(false);
  });

  it('resolves a send stranded by a process that died, and never re-sends it', async () => {
    /*
     * A row stamped `send_started_at` with no outcome is a message that MAY have
     * arrived. `claimDue` excludes it, so without `reapStranded` it would sit PENDING
     * behind a lease for ever; resolving it to `UNCONFIRMED` is what keeps the lane from
     * silently shrinking, and `UNCONFIRMED` is what stops it being told twice.
     */
    const id = await customer(tenantA, '5009');
    await enqueue(tenantA, id, 'SERVICE_ACTION_SUCCEEDED', ctx.container.ids.uuid());

    await ctx.container.database.db.execute(
      sql`UPDATE customer_notifications SET send_started_at = now(), next_attempt_at = NULL
          WHERE tenant_id = ${tenantA.tenantId}`,
    );

    const report = await sweep(lane());
    expect(report.claimed, 'a stranded send was claimed as due').toBe(0);
    expect(sends).toHaveLength(0);

    const [row] = await rows(tenantA);
    expect(row?.state).toBe('UNCONFIRMED');
    expect(row?.attempts, 'reaping a stranded send spent an attempt').toBe(0);
    expect(row?.send_started_at).toBeNull();
  });

  it('does not claim a BLOCKED customer’s notification, and spends nothing', async () => {
    /*
     * Excluded AT THE QUERY, not skipped afterwards. A row picked up and then declined
     * would either burn an attempt — punishing a customer for a moderation decision that
     * may be reversed — or be skipped without one, returning the same row every tick.
     */
    const id = await customer(tenantA, '5010');
    await enqueue(tenantA, id, 'PAYMENT_REJECTED', ctx.container.ids.uuid());
    await ctx.container.database.db.execute(
      sql`UPDATE customers SET status = 'BLOCKED', blocked_at = now()
          WHERE tenant_id = ${tenantA.tenantId} AND id = ${id}`,
    );

    expect((await sweep(lane())).claimed).toBe(0);
    const [row] = await rows(tenantA);
    expect(row?.state).toBe('PENDING');
    expect(row?.attempts).toBe(0);

    // Unblocking resumes it with nothing to remember.
    await ctx.container.database.db.execute(
      sql`UPDATE customers SET status = 'ACTIVE', blocked_at = NULL
          WHERE tenant_id = ${tenantA.tenantId} AND id = ${id}`,
    );
    expect((await sweep(lane())).delivered).toBe(1);
  });

  it('a stopped tenant is a healthy pass that did nothing, not a throw', async () => {
    /*
     * 4G shipped the opposite and the self-review caught it: a loop that records no
     * progress for a pass that threw makes the worker unhealthy in three minutes, and
     * `botctl update` then rolls the release back after its migration has run.
     */
    const id = await customer(tenantA, '5011');
    await enqueue(tenantA, id, 'PAYMENT_REJECTED', ctx.container.ids.uuid());

    const report = await sweep(lane({ active: false }));
    expect(report).toMatchObject({ claimed: 0, delivered: 0 });
    expect(sends).toHaveLength(0);
    expect((await rows(tenantA))[0]?.state).toBe('PENDING');
  });

  it('never claims another tenant’s notification', async () => {
    const a = await customer(tenantA, '5012');
    const b = await customer(tenantB, '6012');
    await enqueue(tenantA, a, 'PAYMENT_REJECTED', ctx.container.ids.uuid());
    await enqueue(tenantB, b, 'PAYMENT_REJECTED', ctx.container.ids.uuid());

    const report = await sweep(lane());
    expect(report.claimed).toBe(1);
    expect(await rows(tenantB)).toMatchObject([{ state: 'PENDING' }]);
  });

  it('two concurrent passes deliver one message between them', async () => {
    /*
     * Two worker replicas are normal on every rolling update. The claim is a conditional
     * UPDATE re-checking its own predicates, so the loser blocks on the row lock,
     * re-reads `next_attempt_at` after the winner committed and takes nothing.
     */
    const id = await customer(tenantA, '5013');
    await enqueue(tenantA, id, 'ORDER_EXPIRED', ctx.container.ids.uuid());

    const [first, second] = await Promise.all([sweep(lane()), sweep(lane())]);
    expect(first.claimed + second.claimed, 'both replicas claimed the row').toBe(1);
    expect(sends).toHaveLength(1);
    expect((await rows(tenantA))[0]?.state).toBe('DELIVERED');
  });
});
