import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductId,
  type UserId,
  type ProductCategoryId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceReminderRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service-reminder.repository';
import type { ProductDraft } from '../../apps/api/src/modules/commerce/catalog/application/ports';
import {
  createTestContext,
  SEED_IDS,
  seededCategoryFor,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * A customer is warned BEFORE their service stops working.
 *
 * Six moments: three days left, one day left, expired; four fifths, nineteen
 * twentieths and all of the traffic allowance. Before this release none of them
 * reached anybody — the customer found out when their configuration stopped
 * connecting.
 *
 * The hard part is not deciding when to speak. It is speaking AGAIN. The customer
 * notification lane's uniqueness — `customer_notifications_subject_key`, unique on
 * `(tenant, kind, subject)` with an `ON CONFLICT DO NOTHING` enqueue — is exactly
 * right for everything else it carries and exactly wrong for a reminder: keyed on the
 * service, a customer who renews twice is warned once and silently ignored twice
 * after that, for the life of the service.
 *
 * So the cases below are weighted accordingly. Six prove the thresholds fire; the
 * rest prove they fire AGAIN after a renewal, do not fire twice for one period, and
 * cannot be made to fire by a second worker replica, another tenant's pass, a
 * terminated service, an unlimited allowance or a usage figure nobody has read.
 *
 * Nothing here dials a panel, and nothing here needs to: both halves of the sweep
 * read columns `SYNC_USAGE` and the commercial actions already maintain.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const GIGABYTE = 1_073_741_824n;
/** Fifty gigabytes, the allowance `draft` sells. */
const ALLOWANCE = 50n * GIGABYTE;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

interface Notified {
  readonly kind: string;
  readonly subjectId: string;
  readonly customerId: string;
}

describe('a customer is warned before their service runs out', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let panelA: string;
  let panelB: string;
  let customerA: UserId;
  let customerB: UserId;
  let n = 0;
  const key = (): string => `reminder-key-${(n += 1)}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    products = new DrizzleProductRepository(ctx.container.database.db);
    panelA = ctx.container.ids.uuid();
    panelB = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE'),
             (${panelB}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
    customerA = await customer(tenantA, '910001');
    customerB = await customer(tenantB, '910002');
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function customer(
    scope: typeof tenantA | typeof tenantB,
    telegramUserId: string,
  ): Promise<UserId> {
    const { customer: record } = await ctx.container.customers.resolveFromUpdate(
      scope,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'زهرا' },
        botInstanceId: BOT_A,
      },
    );
    return record.id;
  }

  const draft = (scope: typeof tenantA | typeof tenantB, panelId: string): ProductDraft => ({
    title: 'پلن پایه',
    description: 'یک ماهه',
    audience: 'EVERYONE',
    sortOrder: 10,
    panelId: panelId as PanelId,
    /*
     * The category of the tenant this draft is written for, never a fixed one.
     * `products_tenant_category_fk` is composite, so a tenant B product filed under
     * tenant A's category is refused by the database — turning a cross-tenant
     * isolation test into a foreign-key error instead of the assertion it was
     * written to make.
     */
    categoryId: seededCategoryFor(scope) as ProductCategoryId,
    specification: { durationDays: 30, trafficBytes: ALLOWANCE, deviceLimit: 2 },
    price: money(250_000n, 'IRT'),
    display: EMPTY_PRODUCT_DISPLAY,
  });

  /**
   * A live service, written directly.
   *
   * Direct SQL, because what every case here needs is a service in a particular
   * STATE — two days from its deadline, or eight tenths through its allowance — and
   * a provisioning run reaches none of those. The real create path is driven against
   * a real fake panel by `service-management.test.ts`; reproducing it here would
   * test the panel rather than the reminder.
   */
  async function service(options: {
    readonly scope: typeof tenantA | typeof tenantB;
    readonly panelId: string;
    readonly customerId: UserId;
    /** Days until the deadline. Negative is past it, null is unlimited validity. */
    readonly expiresInDays: number | null;
    readonly state?: string;
    readonly limitBytes?: bigint;
    readonly usedBytes?: bigint;
    /** Whether a panel has ever answered with a usage figure. */
    readonly synced?: boolean;
  }): Promise<string> {
    const scope = options.scope;
    const created = await products.create(scope, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: draft(scope, options.panelId),
      now: ctx.container.clock.now(),
    });
    await products.setStatus(scope, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const k = key();
    const order = await ctx.container.orders.createDraft(scope, systemActor(k), {
      idempotencyKey: `${k}-draft`,
      customerId: options.customerId,
      productId: created.id,
    });
    const id = ctx.container.ids.uuid();
    const days = options.expiresInDays;
    await ctx.container.database.db.execute(sql`
      INSERT INTO services (id, tenant_id, customer_id, order_id, panel_id, product_id,
                            provider_username, subscription_ref, provider_client_id,
                            traffic_limit_bytes, traffic_used_bytes, usage_synced_at,
                            state, provisioned_at, terminated_at, expires_at)
      VALUES (${id}, ${scope.tenantId}, ${options.customerId}, ${order.id},
              ${options.panelId}, ${created.id},
              ${'u' + Math.random().toString(16).slice(2, 12)},
              ${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)},
              ${ctx.container.ids.uuid()},
              ${options.limitBytes ?? ALLOWANCE}, ${options.usedBytes ?? 0n},
              ${(options.synced ?? true) ? sql`now()` : sql`NULL`},
              ${options.state ?? 'ACTIVE'}, now(),
              ${options.state === 'TERMINATED' ? sql`now()` : sql`NULL`},
              ${days === null ? sql`NULL` : sql`now() + make_interval(secs => ${days * 86_400})`})`);
    return id;
  }

  const runPass = () => ctx.container.serviceReminderSweep.runOnce(tenantA);

  /** Every customer notification enqueued so far, oldest first. */
  async function notifications(): Promise<readonly Notified[]> {
    const result = await ctx.container.database.db.execute(sql`
      SELECT kind, subject_id, customer_id FROM customer_notifications
       ORDER BY created_at ASC, kind ASC`);
    return (result.rows as unknown as Record<string, string>[]).map((row) => ({
      kind: row.kind as string,
      subjectId: row.subject_id as string,
      customerId: row.customer_id as string,
    }));
  }

  /** Every reminder row for one service, by kind. */
  async function reminderKinds(serviceId: string): Promise<readonly string[]> {
    const result = await ctx.container.database.db.execute(sql`
      SELECT kind FROM service_reminders WHERE service_id = ${serviceId} ORDER BY kind ASC`);
    return (result.rows as unknown as Record<string, string>[]).map((row) => row.kind as string);
  }

  /** Moves the deadline, which is what a RENEW does to the row. */
  const renewTo = (serviceId: string, days: number) =>
    ctx.container.database.db.execute(sql`
      UPDATE services SET expires_at = now() + make_interval(secs => ${days * 86_400})
       WHERE id = ${serviceId}`);

  const setUsage = (serviceId: string, used: bigint) =>
    ctx.container.database.db.execute(sql`
      UPDATE services SET traffic_used_bytes = ${used}, usage_synced_at = now()
       WHERE id = ${serviceId}`);

  // -------------------------------------------------------------------------
  // The three that are about the clock
  // -------------------------------------------------------------------------

  it('warns two days out, once, naming the reminder row rather than the service', async () => {
    const id = await service({
      scope: tenantA,
      panelId: panelA,
      customerId: customerA,
      expiresInDays: 2,
    });

    expect(await runPass()).toEqual({ expiry: 1, usage: 0 });

    const sent = await notifications();
    expect(sent.map((one) => one.kind)).toEqual(['SERVICE_EXPIRY_FIRST']);
    expect(sent[0]?.customerId).toBe(customerA);
    /*
     * The SUBJECT is the reminder row, and that is the whole design. Were it the
     * service, this same assertion would pass and the renewal case below would fail
     * silently — which is exactly how the defect would have shipped.
     */
    const rows = await ctx.container.database.db.execute(sql`
      SELECT id FROM service_reminders WHERE service_id = ${id}`);
    expect(sent[0]?.subjectId).toBe((rows.rows[0] as { id: string }).id);
    expect(await reminderKinds(id)).toEqual(['EXPIRY_FIRST']);
  });

  it('says nothing on the second pass, or the third', async () => {
    await service({ scope: tenantA, panelId: panelA, customerId: customerA, expiresInDays: 2 });

    await runPass();
    expect(await runPass()).toEqual({ expiry: 0, usage: 0 });
    expect(await runPass()).toEqual({ expiry: 0, usage: 0 });
    expect(await notifications()).toHaveLength(1);
  });

  it('drops a told service out of the CANDIDATE query, not merely out of the message', async () => {
    /*
     * Forward progress, asserted against the query rather than against the outcome —
     * and the distinction is the whole point, because the two fail differently and
     * only one of them is visible from the notification table.
     *
     * A pass is bounded at `SERVICE_REMINDER_SWEEP_LIMIT` and ordered by deadline, so
     * a service that keeps coming back keeps occupying a slot at the head of that
     * bound. Everything the unique constraint then does is make the SYMPTOM invisible:
     * the second insert conflicts, nothing is sent, the counts read zero, and every
     * assertion above still passes while two hundred services sit in front of the ones
     * that need warning.
     *
     * Caught by mutation M1 in `docs/phase6c-username-falsification.md`, which
     * truncates the stored basis to milliseconds. The service's own `expires_at` has
     * microseconds, so `IS NOT DISTINCT FROM` never matches again, and the row is a
     * candidate for ever. Every other case in this file stayed green under it.
     */
    const id = await service({
      scope: tenantA,
      panelId: panelA,
      customerId: customerA,
      expiresInDays: 2,
      usedBytes: ALLOWANCE,
    });
    await runPass();

    const reminders = new DrizzleServiceReminderRepository(ctx.container.database.db);
    const now = ctx.container.clock.now();
    const stillDue = await ctx.container.uow.run(tenantA, (tx) =>
      Promise.all([
        reminders.listExpiryCandidates(
          tenantA,
          {
            now,
            secondAt: new Date(now.getTime() + 86_400_000),
            firstAt: new Date(now.getTime() + 3 * 86_400_000),
          },
          200,
          tx,
        ),
        reminders.listUsageCandidates(tenantA, { lowest: 80, high: 95, full: 100 }, 200, tx),
      ]),
    );

    expect(stillDue[0].map((one) => one.serviceId)).toEqual([]);
    expect(stillDue[1].map((one) => one.serviceId)).toEqual([]);
    // And the fixture could have appeared: it did, on the pass that warned.
    expect(await reminderKinds(id)).toEqual([
      'EXPIRY_FIRST',
      'USAGE_FINAL',
      'USAGE_FIRST',
      'USAGE_SECOND',
    ]);
  });

  it('sends the MOST URGENT threshold and records the one it skipped', async () => {
    /*
     * Half a day left, and the lane has never run for this service. Two thresholds
     * have been crossed; saying "three days left" now and "expires tomorrow" an hour
     * later would be the lane contradicting itself, so only the urgent one is sent
     * and the other is recorded so it can never fire afterwards.
     */
    const id = await service({
      scope: tenantA,
      panelId: panelA,
      customerId: customerA,
      expiresInDays: 0.5,
    });

    expect(await runPass()).toEqual({ expiry: 1, usage: 0 });
    expect((await notifications()).map((one) => one.kind)).toEqual(['SERVICE_EXPIRY_SECOND']);
    expect(await reminderKinds(id)).toEqual(['EXPIRY_FIRST', 'EXPIRY_SECOND']);

    // And the skipped one stays skipped.
    expect(await runPass()).toEqual({ expiry: 0, usage: 0 });
    expect(await notifications()).toHaveLength(1);
  });

  it('warns once the deadline has passed, and records all three', async () => {
    const id = await service({
      scope: tenantA,
      panelId: panelA,
      customerId: customerA,
      expiresInDays: -1,
      state: 'EXPIRED',
    });

    expect(await runPass()).toEqual({ expiry: 1, usage: 0 });
    expect((await notifications()).map((one) => one.kind)).toEqual(['SERVICE_EXPIRED']);
    expect(await reminderKinds(id)).toEqual(['EXPIRED', 'EXPIRY_FIRST', 'EXPIRY_SECOND']);
  });

  it('never warns a service with no deadline', async () => {
    await service({
      scope: tenantA,
      panelId: panelA,
      customerId: customerA,
      expiresInDays: null,
    });

    expect(await runPass()).toEqual({ expiry: 0, usage: 0 });
    expect(await notifications()).toHaveLength(0);
  });

  it('never warns a terminated service', async () => {
    await service({
      scope: tenantA,
      panelId: panelA,
      customerId: customerA,
      expiresInDays: 1,
      state: 'TERMINATED',
      usedBytes: ALLOWANCE,
    });

    expect(await runPass()).toEqual({ expiry: 0, usage: 0 });
    expect(await notifications()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // The requirement the whole design exists for
  // -------------------------------------------------------------------------

  it('warns AGAIN after a renewal, with a new subject', async () => {
    const id = await service({
      scope: tenantA,
      panelId: panelA,
      customerId: customerA,
      expiresInDays: 2,
    });
    await runPass();
    const first = (await notifications())[0];
    expect(first?.kind).toBe('SERVICE_EXPIRY_FIRST');

    // The customer renews. Thirty days out, nothing is due.
    await renewTo(id, 30);
    expect(await runPass()).toEqual({ expiry: 0, usage: 0 });

    // A month later they are two days out again — of the SECOND period.
    await renewTo(id, 2);
    expect(await runPass()).toEqual({ expiry: 1, usage: 0 });

    const sent = await notifications();
    expect(sent.map((one) => one.kind)).toEqual(['SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_FIRST']);
    /*
     * Two DIFFERENT subjects, which is what carries the second message past
     * `customer_notifications_subject_key`. Equal ids here would mean the second row
     * was never written and the customer was never told — silently, with a green
     * suite, which is the failure this file exists to make loud.
     */
    expect(sent[0]?.subjectId).not.toBe(sent[1]?.subjectId);
    expect(await reminderKinds(id)).toEqual(['EXPIRY_FIRST', 'EXPIRY_FIRST']);
  });

  it('warns again about usage after a renewal that reset the counter', async () => {
    /*
     * The case the first design could not answer, and the reason the basis is a PAIR.
     *
     * A renewal does not change the ALLOWANCE — fifty gigabytes before and fifty
     * after — so a usage reminder keyed on the allowance alone would be suppressed
     * for ever. What changes is the period, and the deadline is what names it.
     */
    const id = await service({
      scope: tenantA,
      panelId: panelA,
      customerId: customerA,
      expiresInDays: 10,
      usedBytes: ALLOWANCE,
    });
    expect(await runPass()).toEqual({ expiry: 0, usage: 1 });
    expect((await notifications()).map((one) => one.kind)).toEqual(['SERVICE_USAGE_FINAL']);

    // Renewed: the deadline moves, the panel resets the counter, the allowance does not change.
    await renewTo(id, 40);
    await setUsage(id, 0n);
    expect(await runPass()).toEqual({ expiry: 0, usage: 0 });

    // And they spend four fifths of the new period's allowance.
    await setUsage(id, (ALLOWANCE * 80n) / 100n);
    expect(await runPass()).toEqual({ expiry: 0, usage: 1 });

    const sent = await notifications();
    expect(sent.map((one) => one.kind)).toEqual(['SERVICE_USAGE_FINAL', 'SERVICE_USAGE_FIRST']);
    expect(sent[0]?.subjectId).not.toBe(sent[1]?.subjectId);
  });

  // -------------------------------------------------------------------------
  // The three that are about the allowance
  // -------------------------------------------------------------------------

  it('warns at exactly four fifths, not a byte before', async () => {
    const id = await service({
      scope: tenantA,
      panelId: panelA,
      customerId: customerA,
      expiresInDays: 20,
      usedBytes: (ALLOWANCE * 80n) / 100n - 1n,
    });

    expect(await runPass()).toEqual({ expiry: 0, usage: 0 });

    await setUsage(id, (ALLOWANCE * 80n) / 100n);
    expect(await runPass()).toEqual({ expiry: 0, usage: 1 });
    expect((await notifications()).map((one) => one.kind)).toEqual(['SERVICE_USAGE_FIRST']);
    expect(await reminderKinds(id)).toEqual(['USAGE_FIRST']);
  });

  it('sends only the highest threshold a jump crossed', async () => {
    const id = await service({
      scope: tenantA,
      panelId: panelA,
      customerId: customerA,
      expiresInDays: 20,
      usedBytes: ALLOWANCE,
    });

    expect(await runPass()).toEqual({ expiry: 0, usage: 1 });
    expect((await notifications()).map((one) => one.kind)).toEqual(['SERVICE_USAGE_FINAL']);
    expect(await reminderKinds(id)).toEqual(['USAGE_FINAL', 'USAGE_FIRST', 'USAGE_SECOND']);
    // The two it passed through stay passed through.
    expect(await runPass()).toEqual({ expiry: 0, usage: 0 });
    expect(await notifications()).toHaveLength(1);
  });

  it('never warns about an unlimited allowance, however much is used', async () => {
    await service({
      scope: tenantA,
      panelId: panelA,
      customerId: customerA,
      expiresInDays: 20,
      limitBytes: 0n,
      usedBytes: 900n * GIGABYTE,
    });

    expect(await runPass()).toEqual({ expiry: 0, usage: 0 });
    expect(await notifications()).toHaveLength(0);
  });

  it('cannot warn about a usage figure no panel has answered', async () => {
    /*
     * The strongest form of this rule is not in the sweep — it is in the schema.
     * `services_usage_synced_check` is `traffic_used_bytes = 0 OR usage_synced_at IS
     * NOT NULL`, so a figure with no "as of" is UNREPRESENTABLE and the query's own
     * `usage_synced_at IS NOT NULL` is the second lock rather than the first.
     *
     * Asserted here rather than assumed, because the sweep's predicate reads as dead
     * code to anybody who does not know this constraint exists — and a reviewer who
     * deletes it as dead is right about today and wrong the moment a migration relaxes
     * a constraint on `services` without thinking about this lane.
     */
    const refused = await service({
      scope: tenantA,
      panelId: panelA,
      customerId: customerA,
      expiresInDays: 20,
      usedBytes: ALLOWANCE,
      synced: false,
    }).then(
      () => null,
      // Drizzle wraps the driver error, so the constraint's name is on the cause.
      (error: { cause?: { constraint?: string } }) => error.cause?.constraint ?? 'no constraint',
    );
    expect(refused).toBe('services_usage_synced_check');

    // And a service that HAS never been synced reads zero, which is nobody's four fifths.
    const id = await service({
      scope: tenantA,
      panelId: panelA,
      customerId: customerA,
      expiresInDays: 20,
      usedBytes: 0n,
      synced: false,
    });
    expect(await runPass()).toEqual({ expiry: 0, usage: 0 });
    expect(await reminderKinds(id)).toEqual([]);
  });

  it('reaches a suspended service with both halves', async () => {
    /*
     * A suspended service still has a deadline running down, and its allowance is
     * still the allowance it will have when it resumes. Both facts are worth a
     * sentence, so `SUSPENDED` is in both state sets.
     */
    const id = await service({
      scope: tenantA,
      panelId: panelA,
      customerId: customerA,
      expiresInDays: 2,
      state: 'SUSPENDED',
      usedBytes: ALLOWANCE,
    });

    expect(await runPass()).toEqual({ expiry: 1, usage: 1 });
    expect(await reminderKinds(id)).toEqual([
      'EXPIRY_FIRST',
      'USAGE_FINAL',
      'USAGE_FIRST',
      'USAGE_SECOND',
    ]);
  });

  it('tells an EXPIRED service about its deadline and not about its allowance', async () => {
    /*
     * Where the two state sets differ, and why. `EXPIRED` is in the expiry set because
     * the `SERVICE_EXPIRED` reminder fires after the expiry sweep has already moved the
     * row — the two run in different process roles and in either order, so requiring
     * ACTIVE would make the message a race. It is NOT in the usage set: a service whose
     * window has closed is consuming nothing, and telling its owner they are at
     * nineteen twentieths of an allowance they can no longer use is a sentence with
     * nothing to do.
     */
    const id = await service({
      scope: tenantA,
      panelId: panelA,
      customerId: customerA,
      expiresInDays: -1,
      state: 'EXPIRED',
      usedBytes: ALLOWANCE,
    });

    expect(await runPass()).toEqual({ expiry: 1, usage: 0 });
    expect(await reminderKinds(id)).toEqual(['EXPIRED', 'EXPIRY_FIRST', 'EXPIRY_SECOND']);
  });

  // -------------------------------------------------------------------------
  // Isolation, concurrency and the stop
  // -------------------------------------------------------------------------

  it("does not warn another tenant's customer", async () => {
    const foreign = await service({
      scope: tenantB,
      panelId: panelB,
      customerId: customerB,
      expiresInDays: 1,
      usedBytes: ALLOWANCE,
    });

    expect(await runPass()).toEqual({ expiry: 0, usage: 0 });
    expect(await reminderKinds(foreign)).toEqual([]);
    expect(await notifications()).toHaveLength(0);

    // And tenant B's own pass does reach it, so the silence above is scoping and
    // not a fixture that could never have fired.
    expect(await ctx.container.serviceReminderSweep.runOnce(tenantB)).toEqual({
      expiry: 1,
      usage: 1,
    });
  });

  it('tells the customer once when two replicas sweep at the same moment', async () => {
    const id = await service({
      scope: tenantA,
      panelId: panelA,
      customerId: customerA,
      expiresInDays: 2,
    });

    const [first, second] = await Promise.all([runPass(), runPass()]);

    expect(first.expiry + second.expiry).toBe(1);
    expect(await notifications()).toHaveLength(1);
    expect(await reminderKinds(id)).toEqual(['EXPIRY_FIRST']);
  });

  it('does nothing for a tenant that has stopped accepting work', async () => {
    const id = await service({
      scope: tenantA,
      panelId: panelA,
      customerId: customerA,
      expiresInDays: 2,
    });
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
    );

    expect(await runPass()).toEqual({ expiry: 0, usage: 0 });
    expect(await reminderKinds(id)).toEqual([]);

    // Nothing decayed: started again, the reminder is still owed.
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${tenantA.tenantId}`,
    );
    expect(await runPass()).toEqual({ expiry: 1, usage: 0 });
  });
});
