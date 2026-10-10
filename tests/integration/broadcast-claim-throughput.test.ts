import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BROADCAST_LARGE_AUDIENCE,
  BROADCAST_LEASE_MS,
  BROADCAST_RETRY_FLOOR_MS,
  BROADCAST_SENDS_PER_SECOND,
  type ActorContext,
  type Clock,
  type TenantContext,
} from '@nexa/contracts';
import { BroadcastDispatcher } from '../../apps/api/src/modules/commerce/broadcasts/application/broadcast-dispatcher';
import { BROADCAST_INTERVAL_MS } from '../../apps/api/src/modules/commerce/broadcasts/application/broadcast-loop';
import type {
  BroadcastDeliverRequest,
  BroadcastPinResult,
  BroadcastRenderRequest,
  BroadcastRenderResult,
  BroadcastSendResult,
  BroadcastTransport,
} from '../../apps/api/src/modules/commerce/broadcasts/application/ports';
import {
  claimDueQuery,
  dueBotsQuery,
  DrizzleBroadcastRepository,
} from '../../apps/api/src/modules/commerce/broadcasts/infrastructure/drizzle-broadcast.repository';
import { DrizzleRecipientFactsReader } from '../../apps/api/src/modules/commerce/broadcasts/infrastructure/drizzle-recipient-facts.reader';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';
import { AudienceFixtures } from './audience-fixtures';

/**
 * FIX-13 (batch 2026-10-10): the broadcast dispatcher's discovery and claim, rewritten to be
 * driven from SENDING broadcasts, against the pre-rewrite queries as the specification of
 * WHICH rows and in WHAT order; their plans at a volume where a paused broadcast sorting
 * ahead used to be walked row by row; and the lane's throughput against a fake Telegram that
 * enforces the per-bot limit and answers 429 with `retry_after` past it. No real Telegram
 * request is made anywhere in this file.
 */

/** Only moves when the test says so: pacing windows, leases and holds are decided here. */
class StoppedClock implements Clock {
  private at = Date.now() + 5_000;
  now(): Date {
    return new Date(this.at);
  }
  advance(ms: number): void {
    this.at += ms;
  }
}

interface TelegramRequest {
  readonly chatId: string;
  readonly bot: string;
  readonly at: number;
  readonly answer: 'SENT' | 'RATE_LIMITED';
  /** Asked while a 429's `retry_after` this fake had answered was still running. */
  readonly duringHold: boolean;
}

/**
 * Telegram, as far as flood control goes: at most `perSecond` accepted messages per bot in any
 * rolling second — counting what OTHER lanes on the same token sent (`otherLane`) — and a 429
 * with `retry_after` past it, during which every request for that bot is refused again.
 */
class RateLimitedTelegram implements BroadcastTransport {
  readonly requests: TelegramRequest[] = [];
  private readonly accepted = new Map<string, number[]>();
  private readonly holds = new Map<string, number>();
  crashOn: string | null = null;

  constructor(
    private readonly clock: StoppedClock,
    private readonly perSecond: number,
    private readonly retryAfterMs: number,
  ) {}

  /** Another lane (notifications, a reply) spends the same bot token's budget now. */
  otherLane(bot: string, count: number): void {
    const times = this.accepted.get(bot) ?? [];
    for (let index = 0; index < count; index += 1) times.push(this.clock.now().getTime());
    this.accepted.set(bot, times);
  }

  /** The most messages this bot had accepted inside any rolling second. */
  peakPerSecond(bot: string): number {
    const times = [...(this.accepted.get(bot) ?? [])].sort((a, b) => a - b);
    let peak = 0;
    let start = 0;
    for (let end = 0; end < times.length; end += 1) {
      while ((times[end] as number) - (times[start] as number) >= 1000) start += 1;
      peak = Math.max(peak, end - start + 1);
    }
    return peak;
  }

  sent(): TelegramRequest[] {
    return this.requests.filter((request) => request.answer === 'SENT');
  }

  async render(_scope: unknown, request: BroadcastRenderRequest): Promise<BroadcastRenderResult> {
    return {
      ok: true,
      rendered: {
        contentKind: request.contentKind,
        text: request.body,
        buttons: request.buttons,
        source: request.source,
      },
    };
  }

  async pin(): Promise<BroadcastPinResult> {
    return { outcome: 'PINNED' };
  }

  async deliver(_scope: unknown, request: BroadcastDeliverRequest): Promise<BroadcastSendResult> {
    const at = this.clock.now().getTime();
    const bot = request.botInstanceId;
    const holdUntil = this.holds.get(bot) ?? 0;
    const record = (answer: TelegramRequest['answer'], duringHold: boolean) =>
      this.requests.push({ chatId: request.chatId, bot, at, answer, duringHold });
    if (at < holdUntil) {
      record('RATE_LIMITED', true);
      return { outcome: 'RATE_LIMITED', retryAfterMs: holdUntil - at };
    }
    const times = this.accepted.get(bot) ?? [];
    if (times.filter((time) => time > at - 1000).length >= this.perSecond) {
      this.holds.set(bot, at + this.retryAfterMs);
      record('RATE_LIMITED', false);
      return { outcome: 'RATE_LIMITED', retryAfterMs: this.retryAfterMs };
    }
    times.push(at);
    this.accepted.set(bot, times);
    record('SENT', false);
    // Telegram took it; the worker "dies" before the answer is recorded.
    if (this.crashOn === request.chatId) throw new Error('worker died mid-send');
    return { outcome: 'SENT', messageId: this.requests.length };
  }
}

describe('broadcast claim and discovery, driven from SENDING broadcasts (FIX-13)', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let ownerB: ActorContext;
  let clock: StoppedClock;
  let key = 0;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-fx13', roleKeys: ['owner'] }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-fx13b', roleKeys: ['owner'] }),
    );
    clock = new StoppedClock();
  });

  const idem = () => `fx13-${(key += 1)}-${Date.now()}`;
  const db = () => ctx.container.database.db;
  const repository = () => new DrizzleBroadcastRepository(db());

  function dispatcherWith(transport: BroadcastTransport): BroadcastDispatcher {
    return new BroadcastDispatcher({
      repository: repository(),
      transport,
      facts: new DrizzleRecipientFactsReader(db(), async () => 'IRT'),
      outbox: ctx.container.outbox,
      uow: ctx.container.uow,
      clock,
      ids: ctx.container.ids,
      scopeIsActive: async () => true,
      logger: { info: () => undefined, error: () => undefined },
    });
  }

  /** `count` customers of one bot in one statement: chat ids `${prefix}000000`, `…01`, …. */
  async function customers(
    tenant: string,
    bot: string,
    prefix: number,
    count: number,
  ): Promise<void> {
    await db().execute(sql`
      INSERT INTO customers (id, tenant_id, telegram_user_id, status, first_bot_instance_id,
                             first_seen_at, created_at)
      SELECT gen_random_uuid(), ${tenant}::uuid,
             ${String(prefix)} || lpad(g::text, 6, '0'), 'ACTIVE', ${bot}::uuid,
             '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
        FROM generate_series(0, ${count - 1}) g`);
  }

  async function launch(scope: TenantContext, actor: ActorContext): Promise<string> {
    const broadcasts = ctx.container.broadcasts;
    const draft = await broadcasts.create(scope, actor, {
      idempotencyKey: idem(),
      title: 'FIX-13',
      contentKind: 'TEXT',
      body: 'hello',
      buttons: [],
      audience: { version: 1 },
    });
    const preview = await broadcasts.preview(scope, actor, draft.id);
    const launched = await broadcasts.launch(scope, actor, draft.id, {
      idempotencyKey: idem(),
      mode: 'NOW',
      scheduledAt: null,
      expectedVersion: draft.version,
      expectedDefinitionHash: preview.definitionHash,
      expectedRecipients: preview.customers,
      expectedFingerprint: preview.fingerprint,
      typedCount: preview.customers >= BROADCAST_LARGE_AUDIENCE ? preview.customers : null,
    });
    expect(launched.state).toBe('SENDING');
    return launched.id;
  }

  /** The pre-FIX-13 claim's SELECT, unlocked: the specification of which rows, in what order. */
  async function referenceClaim(bot: string, take: number): Promise<string[]> {
    const at = clock.now().toISOString();
    const result = await db().execute<{ broadcast_id: string; customer_id: string }>(sql`
      SELECT r2.broadcast_id, r2.customer_id
        FROM broadcast_recipients r2
        JOIN broadcasts b ON b.tenant_id = r2.tenant_id AND b.id = r2.broadcast_id
       WHERE r2.tenant_id = ${SEED_IDS.tenantA}::uuid AND r2.bot_instance_id = ${bot}::uuid
         AND r2.state = 'PENDING' AND b.state = 'SENDING'
         AND (r2.next_attempt_at IS NULL OR r2.next_attempt_at <= ${at}::timestamptz)
         AND (r2.lease_until IS NULL OR r2.lease_until <= ${at}::timestamptz)
       ORDER BY r2.broadcast_id, r2.customer_id
       LIMIT ${take}`);
    return result.rows.map((row) => `${row.broadcast_id}/${row.customer_id}`);
  }

  /** The pre-FIX-13 discovery, as the specification of which bots have work. */
  async function referenceBots(tenant: string): Promise<string[]> {
    const at = clock.now().toISOString();
    const result = await db().execute<{ id: string }>(sql`
      SELECT bi.id FROM bot_instances bi
       WHERE bi.tenant_id = ${tenant}::uuid
         AND EXISTS (
           SELECT 1 FROM broadcast_recipients r
             JOIN broadcasts b ON b.tenant_id = r.tenant_id AND b.id = r.broadcast_id
            WHERE r.tenant_id = bi.tenant_id AND r.bot_instance_id = bi.id
              AND r.state = 'PENDING' AND b.state = 'SENDING'
              AND (r.next_attempt_at IS NULL OR r.next_attempt_at <= ${at}::timestamptz)
              AND (r.lease_until IS NULL OR r.lease_until <= ${at}::timestamptz))`);
    return result.rows.map((row) => row.id).sort();
  }

  async function claim(bot: string, max: number) {
    return ctx.container.uow.run(tenantA, (tx) =>
      repository().claimForBot(
        tenantA,
        bot,
        {
          now: clock.now(),
          leaseUntil: new Date(clock.now().getTime() + BROADCAST_LEASE_MS),
          max,
          perSecond: 1_000,
        },
        tx,
      ),
    );
  }

  it('claims exactly the rows, in exactly the order, the pre-rewrite claim chose', async () => {
    await customers(SEED_IDS.tenantA, SEED_IDS.botA1, 70, 9);
    await customers(SEED_IDS.tenantA, SEED_IDS.botA2, 71, 5);
    await customers(SEED_IDS.tenantB, SEED_IDS.botB1, 72, 4);
    // Created first, so it sorts AHEAD of every sending broadcast: the case the rewrite is for.
    const paused = await launch(tenantA, owner);
    await ctx.container.broadcasts.pause(tenantA, owner, paused);
    const first = await launch(tenantA, owner);
    const cancelled = await launch(tenantA, owner);
    await ctx.container.broadcasts.cancel(tenantA, owner, cancelled);
    const second = await launch(tenantA, owner);
    const other = await launch(tenantB, ownerB);
    expect(paused < first && first < second).toBe(true);
    // One row deferred and one leased in the first sending broadcast: neither is due.
    const later = new Date(clock.now().getTime() + 60_000).toISOString();
    await db().execute(sql`
      UPDATE broadcast_recipients SET next_attempt_at = ${later}::timestamptz
       WHERE broadcast_id = ${first}::uuid AND chat_id = '70000001'`);
    await db().execute(sql`
      UPDATE broadcast_recipients SET lease_until = ${later}::timestamptz
       WHERE broadcast_id = ${first}::uuid AND chat_id = '70000002'`);

    expect((await repository().botsWithWork(tenantA, clock.now())).slice().sort()).toEqual(
      await referenceBots(SEED_IDS.tenantA),
    );
    expect(await repository().botsWithWork(tenantB, clock.now())).toEqual([SEED_IDS.botB1]);

    for (const bot of [SEED_IDS.botA1, SEED_IDS.botA2]) {
      const taken: string[] = [];
      for (let round = 0; round < 20; round += 1) {
        const expected = await referenceClaim(bot, 4);
        const claimed = await claim(bot, 4);
        const got = claimed.map((row) => `${row.broadcastId}/${row.customerId}`).sort();
        expect(got).toEqual([...expected].sort());
        taken.push(...got);
        clock.advance(1);
        if (claimed.length === 0) break;
      }
      // Fairness as before: the lower broadcast drains first, and nothing paused, cancelled,
      // deferred, leased or another tenant's is ever offered.
      const owners = taken.map((entry) => entry.split('/')[0]);
      const perBot = bot === SEED_IDS.botA1 ? 9 : 5;
      const blocked = bot === SEED_IDS.botA1 ? 2 : 0;
      expect(owners).toEqual([
        ...Array<string>(perBot - blocked).fill(first),
        ...Array<string>(perBot).fill(second),
      ]);
      expect(owners).not.toContain(paused);
      expect(owners).not.toContain(cancelled);
      expect(owners).not.toContain(other);
    }

    // Everything due is leased now; only the PAUSED broadcast still has unleased PENDING
    // rows, and a paused broadcast is not work.
    expect(await repository().botsWithWork(tenantA, clock.now())).toEqual([]);
    expect(await referenceBots(SEED_IDS.tenantA)).toEqual([]);
    // Tenant B was never touched by tenant A's claims.
    expect(await repository().botsWithWork(tenantB, clock.now())).toEqual([SEED_IDS.botB1]);

    // Resumed, the paused broadcast IS work again — discovered and claimed.
    await ctx.container.broadcasts.resume(tenantA, owner, paused);
    expect(await repository().botsWithWork(tenantA, clock.now())).toEqual(
      expect.arrayContaining([SEED_IDS.botA1, SEED_IDS.botA2]),
    );
    const resumed = await claim(SEED_IDS.botA1, 100);
    expect(resumed.map((row) => row.broadcastId)).toEqual(Array<string>(9).fill(paused));
  });

  it('sends a sending broadcast queued behind a paused one, and never the paused one', async () => {
    await customers(SEED_IDS.tenantA, SEED_IDS.botA1, 73, 30);
    const paused = await launch(tenantA, owner);
    await ctx.container.broadcasts.pause(tenantA, owner, paused);
    const sending = await launch(tenantA, owner);
    // A customer opts out of promotions after the launch: decided at the stamp, never sent.
    await new AudienceFixtures(ctx, SEED_IDS.tenantA).optOutOfMarketing(
      (
        await db().execute<{ id: string }>(
          sql`SELECT id FROM customers WHERE telegram_user_id = '73000005'`,
        )
      ).rows[0]?.id as string,
    );
    const telegram = new RateLimitedTelegram(clock, BROADCAST_SENDS_PER_SECOND, 1_000);
    const dispatcher = dispatcherWith(telegram);

    const firstPass = await dispatcher.pass(tenantA);
    // The whole per-second budget went to the SENDING broadcast, none to the paused one.
    expect(firstPass.claimed).toBe(BROADCAST_SENDS_PER_SECOND);
    clock.advance(BROADCAST_INTERVAL_MS);
    await dispatcher.pass(tenantA);
    const byState = await db().execute<{ broadcast_id: string; state: string; n: number }>(sql`
      SELECT broadcast_id, state, count(*)::int AS n FROM broadcast_recipients
       GROUP BY broadcast_id, state ORDER BY broadcast_id, state`);
    expect(byState.rows).toEqual([
      { broadcast_id: paused, state: 'PENDING', n: 30 },
      { broadcast_id: sending, state: 'SENT', n: 29 },
      { broadcast_id: sending, state: 'SKIPPED', n: 1 },
    ]);
    expect(telegram.sent().map((request) => request.chatId)).not.toContain('73000005');
    expect((await ctx.container.broadcasts.get(tenantA, owner, sending)).state).toBe('COMPLETED');
  });

  /** Every plan node of an EXPLAIN (FORMAT JSON). */
  function nodes(plan: Record<string, unknown>): Record<string, unknown>[] {
    const children = (plan.Plans as Record<string, unknown>[] | undefined) ?? [];
    return [plan, ...children.flatMap(nodes)];
  }

  /**
   * The executed plan's nodes, in a transaction rolled back afterwards — the claim is an
   * UPDATE, and EXPLAIN ANALYZE runs it.
   */
  async function explain(query: SQL): Promise<Record<string, unknown>[]> {
    let plan: Record<string, unknown> | undefined;
    const rollback = new Error('rollback');
    await db()
      .transaction(async (tx) => {
        const result = await tx.execute<{ 'QUERY PLAN': { Plan: Record<string, unknown> }[] }>(
          sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`,
        );
        plan = result.rows[0]?.['QUERY PLAN'][0]?.Plan;
        throw rollback;
      })
      .catch((error: unknown) => {
        if (error !== rollback) throw error;
      });
    return nodes(plan as Record<string, unknown>);
  }

  /** How many recipient rows a plan actually read: returned plus filtered away, every loop. */
  function recipientRowsRead(plan: Record<string, unknown>[]): number {
    return plan
      .filter((node) => node['Relation Name'] === 'broadcast_recipients')
      .reduce(
        (sum, node) =>
          sum +
          ((node['Actual Rows'] as number) + ((node['Rows Removed by Filter'] as number) ?? 0)) *
            (node['Actual Loops'] as number),
        0,
      );
  }

  it('plans both queries as index probes, not a walk of the recipients table', async () => {
    // A paused broadcast with thousands of waiting rows sorting ahead of a sending one with a
    // few — the volume at which the old plans read every paused row on every pass.
    await customers(SEED_IDS.tenantA, SEED_IDS.botA1, 74, 4_000);
    const paused = await launch(tenantA, owner);
    await ctx.container.broadcasts.pause(tenantA, owner, paused);
    const sending = await launch(tenantA, owner);
    // Sends go out in customer order, so a broadcast in progress has its RESOLVED rows first:
    // all but the last 11 by customer are sent. Through the primary key (tenant, broadcast,
    // customer) a probe would walk those 3,989 before reaching a waiting one.
    await db().execute(sql`
      UPDATE broadcast_recipients
         SET state = 'SENT', attempts = 1, send_started_at = now(), resolved_at = now()
       WHERE broadcast_id = ${sending}::uuid
         AND customer_id NOT IN (SELECT customer_id FROM broadcast_recipients
                                  WHERE broadcast_id = ${sending}::uuid
                                  ORDER BY customer_id DESC LIMIT 11)`);
    await db().execute(sql`ANALYZE broadcast_recipients`);
    await db().execute(sql`ANALYZE broadcasts`);

    for (const query of [
      dueBotsQuery(SEED_IDS.tenantA, clock.now()),
      claimDueQuery({
        tenantId: SEED_IDS.tenantA,
        botInstanceId: SEED_IDS.botA2, // a bot with no rows at all: nothing to stop early on
        now: clock.now(),
        leaseUntil: new Date(clock.now().getTime() + BROADCAST_LEASE_MS),
        take: BROADCAST_SENDS_PER_SECOND,
      }),
      claimDueQuery({
        tenantId: SEED_IDS.tenantA,
        botInstanceId: SEED_IDS.botA1,
        now: clock.now(),
        leaseUntil: new Date(clock.now().getTime() + BROADCAST_LEASE_MS),
        take: BROADCAST_SENDS_PER_SECOND,
      }),
    ]) {
      const plan = await explain(query);
      const scans = plan.filter((node) => node['Relation Name'] === 'broadcast_recipients');
      expect(scans.length).toBeGreaterThan(0);
      for (const scan of scans) expect(scan['Node Type']).not.toBe('Seq Scan');
      // The paused broadcast's 4,000 waiting rows are never read: at most the claim's own
      // rows, each read again by the UPDATE's key lookup.
      expect(recipientRowsRead(plan)).toBeLessThanOrEqual(2 * BROADCAST_SENDS_PER_SECOND);
    }
    // And the claim still hands out the sending broadcast's rows, the paused one's none.
    const claimed = await claim(SEED_IDS.botA1, BROADCAST_SENDS_PER_SECOND);
    expect(claimed).toHaveLength(11);
    expect(new Set(claimed.map((row) => row.broadcastId))).toEqual(new Set([sending]));
  });

  describe('throughput against a rate-limited fake Telegram', () => {
    async function recipientStates(broadcastId: string): Promise<Record<string, number>> {
      const result = await db().execute<{ state: string; n: number }>(sql`
        SELECT state, count(*)::int AS n FROM broadcast_recipients
         WHERE broadcast_id = ${broadcastId}::uuid GROUP BY state`);
      return Object.fromEntries(result.rows.map((row) => [row.state, row.n]));
    }

    function duplicates(requests: TelegramRequest[]): string[] {
      const seen = new Set<string>();
      const twice: string[] = [];
      for (const request of requests) {
        if (seen.has(request.chatId)) twice.push(request.chatId);
        seen.add(request.chatId);
      }
      return twice;
    }

    it('delivers N recipients at the configured per-bot rate, with no 429 and no duplicate', async () => {
      const count = 200;
      await customers(SEED_IDS.tenantA, SEED_IDS.botA1, 75, count);
      const broadcastId = await launch(tenantA, owner);
      const telegram = new RateLimitedTelegram(clock, BROADCAST_SENDS_PER_SECOND, 3_000);
      const dispatcher = dispatcherWith(telegram);

      const started = clock.now().getTime();
      const wallStarted = performance.now();
      let passes = 0;
      while ((await recipientStates(broadcastId)).PENDING !== undefined && passes < 60) {
        await dispatcher.pass(tenantA);
        passes += 1;
        clock.advance(BROADCAST_INTERVAL_MS);
      }
      const wallMs = performance.now() - wallStarted;

      expect(await recipientStates(broadcastId)).toEqual({ SENT: count });
      expect(telegram.requests.filter((request) => request.answer !== 'SENT')).toEqual([]);
      expect(duplicates(telegram.requests)).toEqual([]);
      expect(telegram.peakPerSecond(SEED_IDS.botA1)).toBe(BROADCAST_SENDS_PER_SECOND);
      // Simulated seconds from the first send to the end of the last one's second.
      const last = Math.max(...telegram.requests.map((request) => request.at));
      const rate = count / ((last - started + BROADCAST_INTERVAL_MS) / 1000);
      expect(rate).toBeGreaterThanOrEqual(BROADCAST_SENDS_PER_SECOND * 0.95);
      expect(rate).toBeLessThanOrEqual(BROADCAST_SENDS_PER_SECOND);
      // Real time: a pass of a full budget must fit its one-second slot with room to spare,
      // or the lane falls behind its own pacing. Tolerant on purpose: shared CI machines.
      expect(wallMs / passes).toBeLessThan(BROADCAST_INTERVAL_MS);
      expect((await ctx.container.broadcasts.get(tenantA, owner, broadcastId)).state).toBe(
        'COMPLETED',
      );
    }, 60_000);

    it('honours retry_after when another lane spends the budget, survives a restart and a crash, and sends nobody twice', async () => {
      const count = 100;
      await customers(SEED_IDS.tenantA, SEED_IDS.botA1, 76, count);
      const broadcastId = await launch(tenantA, owner);
      const retryAfterMs = 7_000; // above the dispatcher's floor, so Telegram's own time rules
      expect(retryAfterMs).toBeGreaterThan(BROADCAST_RETRY_FLOOR_MS);
      const telegram = new RateLimitedTelegram(clock, BROADCAST_SENDS_PER_SECOND, retryAfterMs);
      let dispatcher = dispatcherWith(telegram);
      const totals = { claimed: 0, sent: 0, rateLimited: 0, released: 0, unconfirmed: 0 };
      const run = async () => {
        const report = await dispatcher.pass(tenantA);
        for (const name of Object.keys(totals) as (keyof typeof totals)[]) {
          totals[name] += report[name];
        }
        clock.advance(BROADCAST_INTERVAL_MS);
      };

      // Notifications on the same token took 5 of this second's 20: the broadcast's 16th
      // request is answered 429.
      telegram.otherLane(SEED_IDS.botA1, 5);
      await run();
      const limited = telegram.requests.filter((request) => request.answer === 'RATE_LIMITED');
      expect(limited.length).toBeGreaterThanOrEqual(1);
      const firstLimit = limited[0] as TelegramRequest;
      // In flight when the 429 arrived: at most the other workers' requests. Nothing STARTS
      // after it — the rest of the batch is handed back, unsent and with no attempt spent.
      expect(limited.filter((request) => request.duringHold).length).toBeLessThanOrEqual(3);
      expect(totals.released).toBeGreaterThan(0);

      // A restart mid-hold: a new dispatcher, as a new worker process would build it.
      dispatcher = dispatcherWith(telegram);
      const holdEnds = firstLimit.at + retryAfterMs;
      while (clock.now().getTime() < holdEnds) await run();
      // Nothing was asked of Telegram for this bot while its retry_after ran.
      expect(
        telegram.requests.filter((request) => request.at > firstLimit.at && request.at < holdEnds),
      ).toEqual([]);

      // One send whose worker dies after Telegram took it: never sent again.
      const crashed = (
        await db().execute<{ chat_id: string }>(sql`
          SELECT chat_id FROM broadcast_recipients
           WHERE broadcast_id = ${broadcastId}::uuid AND state = 'PENDING'
           ORDER BY customer_id LIMIT 1`)
      ).rows[0]?.chat_id as string;
      telegram.crashOn = crashed;
      await run();
      telegram.crashOn = null;
      dispatcher = dispatcherWith(telegram); // and the process restarts again
      for (let passes = 0; passes < 30; passes += 1) {
        if ((await recipientStates(broadcastId)).PENDING === undefined) break;
        await run();
      }
      // The stamped send is reaped UNCONFIRMED once its lease lapses — not re-sent.
      clock.advance(BROADCAST_LEASE_MS);
      await run();

      const accepted = telegram.sent();
      expect(duplicates(accepted)).toEqual([]);
      expect(accepted).toHaveLength(count);
      expect(await recipientStates(broadcastId)).toEqual({ SENT: count - 1, UNCONFIRMED: 1 });
      expect(totals.unconfirmed).toBe(0); // resolved by the reaper, not by a pass's answer
      // Delivered vs attempted: every Telegram request is accounted for exactly once.
      expect(totals.sent).toBe(count - 1);
      expect(totals.rateLimited).toBe(
        telegram.requests.filter((request) => request.answer === 'RATE_LIMITED').length,
      );
      expect(telegram.requests).toHaveLength(count + totals.rateLimited);
      // A 429 spent no attempt, and the crashed send (never recorded) none either: the only
      // attempts are the recorded sends.
      const attempts = await db().execute<{ total: number }>(sql`
        SELECT sum(attempts)::int AS total FROM broadcast_recipients
         WHERE broadcast_id = ${broadcastId}::uuid`);
      expect(attempts.rows[0]?.total).toBe(count - 1);
      expect(telegram.peakPerSecond(SEED_IDS.botA1)).toBeLessThanOrEqual(
        BROADCAST_SENDS_PER_SECOND,
      );
      expect((await ctx.container.broadcasts.get(tenantA, owner, broadcastId)).state).toBe(
        'COMPLETED',
      );
    }, 60_000);
  });
});
