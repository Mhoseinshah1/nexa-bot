import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ActorContext } from '@nexa/contracts';
import { notifications } from '../../apps/api/src/infrastructure/persistence/schema';
import type { TransportResult } from '../../apps/api/src/modules/control/notifications/application/ports';
import type { RecordingTransport } from '../../apps/api/src/modules/control/notifications/infrastructure/recording-transport';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from '../integration/harness';

/**
 * The dispatcher's state machine, checked by ENUMERATING orderings rather than
 * by naming the ones somebody thought of.
 *
 * NOT part of the pull-request gate. 1 341 orderings, each with a full database
 * reset, took a CI integration job to fourteen minutes — long enough that the
 * cost of running it lands on every unrelated change. It runs nightly and on
 * demand instead:
 *
 *     pnpm test:exhaustive
 *
 * Nothing here is the ONLY cover for a known bug. Every failure shape these
 * enumerations found has a named, deterministic regression in
 * `tests/integration/notification-invariants.test.ts`, which does run on every
 * pull request. What moves here is the SEARCH — the part whose value is
 * finding a shape nobody has imagined yet, and which is therefore worth a lot
 * once a night and very little on the ninth push of an afternoon.
 *
 * Five defects have been found in this machine across six review rounds — a
 * rate ceiling testing the claim's own predicate, a poison pill that stopped a
 * batch, an abandonment that ignored `maxAttempts`, a sweep that could fail a
 * live send, and a synthetic attempt row that collided with the correction
 * meant to undo it. Every one was an ORDERING: claim, send, record, sweep and
 * a lease expiring, arranged in a way nobody had written a test for.
 *
 * So the sequences below are generated, and the assertions are INVARIANTS that
 * must hold whatever order the steps arrive in. Naming each scenario is what
 * kept missing; the invariants are the same in all of them:
 *
 *   1. A delivered message never ends FAILED.
 *   2. An intent never rests PENDING with its attempts spent.
 *   3. A terminal intent always has at least one attempt row behind it.
 *   4. Attempt numbers are unique and the transport is never called more than
 *      `max_attempts` times for one intent.
 */
describe('notification state machine invariants', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let transport: RecordingTransport;

  async function configure() {
    // TWO attempts, not the default five. With five, a three-step ordering can
    // never spend an intent's allowance, so every invariant about an exhausted
    // intent — and the sweep that exists for it — was unreachable: deleting
    // `failExhausted` outright left this file green. The ceiling is what makes
    // the enumeration reach the states worth asserting about.
    await ctx.container.settingsService.set(tenantA, owner, {
      key: 'ops.notifications.max_attempts',
      value: 2,
      expectedVersion: null,
      idempotencyKey: `max-${Math.random()}`,
    });
    await ctx.container.settingsService.set(tenantA, owner, {
      key: 'ops.notifications.telegram_chat_id',
      value: '-100999',
      expectedVersion: null,
      idempotencyKey: `chat-${Math.random()}`,
    });
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'ops_notifications',
      enabled: true,
      expectedVersion: null,
      idempotencyKey: `flag-${Math.random()}`,
      confirmKey: 'ops_notifications',
      reason: 'Invariant setup.',
    });
  }

  beforeEach(async () => {
    ctx ??= await createTestContext({ NOTIFICATION_TRANSPORT: 'recording' });
    await ctx.reset();
    transport = ctx.container.notificationTransport as RecordingTransport;
    transport.reset();
    ctx.container.notificationDispatcher.setRateLimitScope(tenantA);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner', roleKeys: ['owner'] }),
    );
    await configure();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const sql = (text: string, params: unknown[] = []) =>
    ctx.container.database.withClient((client) => client.query(text, params));

  /** One step a dispatcher, a clock or a network can take. */
  type Step =
    'TICK' | 'FAIL_RETRYABLE' | 'FAIL_PERMANENT' | 'THROW' | 'EXPIRE_LEASE' | 'LOSE_OUTCOME';

  const STEPS: readonly Step[] = [
    'TICK',
    'FAIL_RETRYABLE',
    'FAIL_PERMANENT',
    'THROW',
    'EXPIRE_LEASE',
    'LOSE_OUTCOME',
  ];

  async function raise(dedupeKey: string) {
    await ctx.container.opsLog.record(tenantA, {
      code: 'panel.unreachable',
      severity: 'ERROR',
      message: 'The panel did not answer.',
      dedupeKey,
    });
    const [intent] = await ctx.container.notifications.list(tenantA, owner);
    return intent!;
  }

  async function apply(step: Step): Promise<void> {
    switch (step) {
      case 'TICK':
        await ctx.container.notificationDispatcher.tick();
        return;
      case 'FAIL_RETRYABLE':
        transport.failNextWith({
          outcome: 'FAILED_RETRYABLE',
          errorCode: 'telegram.unreachable',
          errorMessage: 'socket hang up',
          retryAfterMs: 0,
        });
        await ctx.container.notificationDispatcher.tick();
        return;
      case 'FAIL_PERMANENT':
        transport.failNextWith({
          outcome: 'FAILED_PERMANENT',
          errorCode: 'telegram.rejected.400',
          errorMessage: 'chat not found',
        });
        await ctx.container.notificationDispatcher.tick();
        return;
      case 'THROW':
        transport.throwNextWith(new Error('socket hang up'));
        await ctx.container.notificationDispatcher.tick();
        return;
      case 'LOSE_OUTCOME':
        // A recorder that died between the claim and the attempt row. No
        // caller-visible step reaches this, which is exactly why it has to be
        // one: it is the ONLY way an intent rests PENDING with its attempts
        // spent, and therefore the only state the sweep exists for. Without it
        // the enumeration could not tell whether the sweep was there at all.
        await sql(
          `UPDATE notifications SET attempt_count = max_attempts
             WHERE status = 'PENDING'`,
        );
        return;
      case 'EXPIRE_LEASE':
        // Far enough back to clear the sweep's safety margin as well as the
        // lease, which is the state a dead sender leaves behind.
        await sql(
          `UPDATE notifications SET next_attempt_at = now() - interval '1 hour'
             WHERE status = 'PENDING'`,
        );
        return;
    }
  }

  /** Every sequence of `length` steps, in order. */
  function sequences(length: number): Step[][] {
    let all: Step[][] = [[]];
    for (let i = 0; i < length; i += 1) {
      all = all.flatMap((prefix) => STEPS.map((step) => [...prefix, step]));
    }
    return all;
  }

  async function begin(name: string) {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner', roleKeys: ['owner'] }),
    );
    await configure();
    transport.reset();
    // The rate window is PROCESS state on a dispatcher every sequence shares,
    // and `ctx.reset()` cannot touch it. Without this, twenty sends exhausted
    // the per-minute budget and every later sequence claimed nothing — passing
    // its invariants by doing no work, with the coverage silently depending on
    // how fast the suite happened to run.
    ctx.container.notificationDispatcher.resetRateWindow();
    return raise(name);
  }

  /**
   * The five invariants, asserted the same way whatever produced the state.
   *
   * `sweepHadItsChance` is the one thing an ordering has to tell this function:
   * the sweep only acts once a lease AND its safety margin have passed, so
   * "never rests PENDING with its attempts spent" is a claim about an ordering
   * that gave it the opportunity, not about every ordering.
   */
  async function checkInvariants(
    intent: Awaited<ReturnType<typeof raise>>,
    where: string,
    sweepHadItsChance: boolean,
    broken: string[],
  ): Promise<void> {
    const [row] = await ctx.container.database.db
      .select()
      .from(notifications)
      .where(eq(notifications.id, intent.id));
    const attempts = await ctx.container.notificationRepository.attempts(tenantA, intent.id);
    const delivered = transport.messages.length > 0;

    // 1. A delivered message never ends FAILED.
    if (delivered && row!.status === 'FAILED') {
      broken.push(`[${where}] delivered but recorded FAILED`);
    }

    // 2. An intent never rests PENDING with its attempts spent.
    if (sweepHadItsChance && row!.status === 'PENDING' && row!.attemptCount >= row!.maxAttempts) {
      broken.push(`[${where}] PENDING with ${row!.attemptCount}/${row!.maxAttempts} attempts`);
    }

    // 3. A terminal intent always has a record of why.
    if (row!.status !== 'PENDING' && attempts.length === 0) {
      broken.push(`[${where}] ${row!.status} with no attempt behind it`);
    }

    // 4. Attempt numbers are unique, and the transport is not CALLED more
    //    often than the intent's own ceiling allows.
    //
    //    `transport.messages` counts only successful sends, so a regression
    //    letting a third failed call through with `maxAttempts = 2` left it at
    //    zero and passed. `calls` counts every invocation, which is what the
    //    ceiling is about.
    //    Honesty about the first half: a unique index on
    //    `(tenant_id, notification_id, attempt_number)` means no application
    //    change can PERSIST a duplicate — an attempted one aborts its
    //    transaction and surfaces as invariant 1 or as `unrecorded`, never as
    //    this message. It is a guard against a migration dropping that index,
    //    not against a code change, and it only fires if the index is dropped
    //    AND something then writes a duplicate.
    const numbers = attempts.map((attempt) => attempt.attemptNumber);
    if (new Set(numbers).size !== numbers.length) {
      broken.push(`[${where}] duplicate attempt numbers: ${numbers.join(',')}`);
    }
    if (transport.calls > row!.maxAttempts) {
      broken.push(`[${where}] transport called ${transport.calls} times`);
    }

    // 5. A terminal status always carries a completion time, and a pending one
    //    never does — the CHECK constraint's rule, asserted from outside it.
    //
    //    Same honesty as 4a, and it was overclaimed here first: while
    //    `notifications_completed_check` exists, writing the wrong pair raises
    //    a constraint violation rather than producing the row this inspects,
    //    so no code change can make this fire. Dropping the constraint alone
    //    does not either. It fires only if the constraint goes AND the code
    //    then disagrees — which is the migration this is here to survive, but
    //    it is not a live assertion about today's code, and calling it one
    //    would credit the enumeration with work it is not doing.
    const terminalWithoutTime = row!.status !== 'PENDING' && row!.completedAt === null;
    const pendingWithTime = row!.status === 'PENDING' && row!.completedAt !== null;
    if (terminalWithoutTime || pendingWithTime) {
      broken.push(`[${where}] ${row!.status} with completedAt=${String(row!.completedAt)}`);
    }
  }

  async function statusOf(intent: Awaited<ReturnType<typeof raise>>): Promise<string> {
    const [row] = await ctx.container.database.db
      .select({ status: notifications.status })
      .from(notifications)
      .where(eq(notifications.id, intent.id));
    return row!.status;
  }

  const all = sequences(3);

  it('enumerates a meaningful number of orderings', () => {
    expect(all.length).toBe(STEPS.length ** 3);
  });

  it('holds every invariant across every three-step ordering', async () => {
    const broken: string[] = [];

    for (const sequence of all) {
      const intent = await begin(`panel:${sequence.join('-')}`);
      for (const step of sequence) await apply(step);
      await checkInvariants(intent, sequence.join(' → '), sweepHadItsChance(sequence), broken);
    }

    expect(
      broken,
      `${broken.length} orderings broke an invariant:\n${broken.slice(0, 10).join('\n')}`,
    ).toEqual([]);
  }, 600_000);

  /**
   * The same invariants, but with a send genuinely OUTSTANDING.
   *
   * Every step above awaits a whole `tick()`, so claim, send and record are
   * atomic with respect to each other and the ordering the sweep's safety
   * margin exists for is unreachable at ANY sequence length: a send still in
   * flight while its lease expires, the sweep declaring it failed, and the
   * success arriving afterwards. That gap was reported by review, and the
   * answer offered — that the ordering is covered elsewhere by driving
   * `recordAttempt` directly at the number the dispatcher would have used —
   * was not good enough. Driving the repository asserts that the CORRECTION
   * works when handed the right arguments; it cannot show that a real
   * dispatcher produces those arguments, which is the half that had already
   * been wrong twice (a synthetic attempt row colliding with the correction
   * meant to undo it, and a sweep that could fail a live send).
   *
   * So the transport parks here. The send is entered — the row claimed, its
   * counter incremented, its lease held — and then three arbitrary things
   * happen before the outcome is allowed to land.
   *
   * WHAT IS STILL FIXED, stated because an undeclared fixed dimension is how
   * both of this file's holes were made. Every ordering below uses ONE intent,
   * ONE tenant, ONE dispatcher object and `max_attempts = 2`, with unique
   * dedupe keys. So none of these is enumerated here, and each is covered, if
   * at all, by a named scenario elsewhere:
   *
   *   - a batch of more than one (`stops sending the rest of a batch when the
   *     tenant stops mid-send`, below — and it took an outside reviewer to
   *     notice that a batch of one cannot show a batch rule);
   *   - two dispatcher PROCESSES racing on `FOR UPDATE SKIP LOCKED`, which
   *     nothing in this suite tests: every "second dispatcher" here is a
   *     re-entrant `tick()` on the same object;
   *   - the rate ceiling's boundary, which `resetRateWindow()` per ordering
   *     deliberately keeps out of reach (`notification-delivery.test.ts` owns
   *     it);
   *   - the sweep's safety MARGIN, which `EXPIRE_LEASE` backdates an hour past
   *     — so no ordering here can tell `now - leaseMs` from `now`
   *     (`control-plane-review-round-3.test.ts` owns that).
   */
  /**
   * The steps that run a whole `tick()`, and therefore run the sweep.
   *
   * The gate on invariant 2 originally named `TICK` alone, which was simply
   * wrong: `FAIL_RETRYABLE`, `FAIL_PERMANENT` and `THROW` each arm the
   * transport and then run the same `tick()`. Naming one of the four excluded
   * 33 orderings of the 216 that had in fact given the sweep its chance, so
   * the invariant `failExhausted` exists to protect was asserted about 11
   * orderings where it could have been asserted about 44.
   */
  const RUNS_A_TICK: readonly Step[] = ['TICK', 'FAIL_RETRYABLE', 'FAIL_PERMANENT', 'THROW'];

  const sweepHadItsChance = (sequence: readonly Step[]): boolean => {
    const last = sequence.at(-1);
    return last !== undefined && RUNS_A_TICK.includes(last) && sequence.includes('EXPIRE_LEASE');
  };

  const INTERLEAVED: readonly Step[] = [
    'TICK',
    'FAIL_RETRYABLE',
    'FAIL_PERMANENT',
    'EXPIRE_LEASE',
    'LOSE_OUTCOME',
  ];

  /**
   * What has already happened to the intent when the slow send begins.
   *
   * This is not decoration. A window that always opens on a fresh intent puts
   * the outstanding send at attempt 1, so the sweep's synthetic attempt row —
   * written at `attempt_count + 1` — can never land on the number the
   * in-flight send is about to use, and the unique index on
   * `(tenant_id, notification_id, attempt_number)` is never tested by the one
   * ordering that can reach it. The first version of this block had exactly
   * that hole: changing the synthetic row's number to collide left it green.
   *
   * A prelude that spends an attempt and makes the intent due again puts the
   * slow send at attempt 2 of 2, which is where the sweep and the send want
   * the same slot.
   */
  const PRELUDES: readonly (readonly Step[])[] = [
    [],
    ['FAIL_RETRYABLE', 'EXPIRE_LEASE'],
    ['THROW', 'EXPIRE_LEASE'],
  ];

  /**
   * How the outstanding send eventually lands.
   *
   * The first version of this block parked a send and never said what it would
   * report, so it always reported the default — SUCCEEDED. That made the whole
   * enumeration one landing wide: "send in flight → sweep → a RETRYABLE
   * failure lands" and "→ a PERMANENT failure lands" were unreachable, and
   * four of the five invariants had an antecedent that was never true, leaving
   * exactly one doing work. A fixed dimension nobody had declared is the same
   * hole the preludes were added to close, one level up.
   */
  const LANDINGS: readonly { readonly name: string; readonly result: TransportResult }[] = [
    { name: 'succeeds', result: { outcome: 'SUCCEEDED' } },
    {
      name: 'fails retryably',
      result: {
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'telegram.unreachable',
        errorMessage: 'socket hang up',
        retryAfterMs: 0,
      },
    },
    {
      name: 'fails permanently',
      result: {
        outcome: 'FAILED_PERMANENT',
        errorCode: 'telegram.rejected.400',
        errorMessage: 'chat not found',
      },
    },
  ];

  it('holds every invariant when a send is still in flight', async () => {
    const broken: string[] = [];
    let correctedAfterSweep = 0;
    let sweptWhileInFlight = 0;
    let sweptThenFailingLanding = 0;

    let windows: Step[][] = [[]];
    for (let i = 0; i < 3; i += 1) {
      windows = windows.flatMap((prefix) => INTERLEAVED.map((step) => [...prefix, step]));
    }
    const orderings = PRELUDES.flatMap((prelude) =>
      LANDINGS.flatMap((landing) => windows.map((window) => ({ prelude, landing, window }))),
    );

    for (const { prelude, landing, window: sequence } of orderings) {
      const opening = prelude.length === 0 ? 'first attempt' : prelude.join(' → ');
      const where = `${opening} → send in flight → ${sequence.join(' → ')} → send ${landing.name}`;
      const intent = await begin(`slow:${prelude.join('-')}:${landing.name}:${sequence.join('-')}`);
      for (const step of prelude) await apply(step);

      const hold = transport.holdNextSend(landing.result);
      // NOT awaited. This is the whole point: the tick owns a claimed row and
      // is parked inside the transport while the steps below run.
      const slow = ctx.container.notificationDispatcher
        .tick()
        .then(() => null)
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));

      const started = await Promise.race([
        hold.entered.then(() => 'entered' as const),
        slow.then(() => 'finished' as const),
      ]);
      if (started !== 'entered') {
        // A setup that quietly failed to park would make every assertion below
        // vacuous — the exact way this file has already passed twice while
        // testing nothing — so it is a failure, never a skip.
        hold.release();
        await slow;
        broken.push(`[${where}] no send was in flight; the ordering was never reached`);
        continue;
      }

      for (const step of sequence) await apply(step);

      const beforeLanding = await statusOf(intent);
      hold.release();
      const tickError = await slow;
      if (tickError !== null) broken.push(`[${where}] the in-flight tick threw: ${tickError}`);
      const afterLanding = await statusOf(intent);

      if (beforeLanding === 'FAILED') {
        sweptWhileInFlight += 1;
        if (afterLanding === 'SENT') correctedAfterSweep += 1;
        if (landing.name !== 'succeeds') sweptThenFailingLanding += 1;
      }

      await checkInvariants(intent, where, sweepHadItsChance(sequence), broken);
    }

    expect(
      broken,
      `${broken.length} in-flight orderings broke an invariant:\n${broken.slice(0, 10).join('\n')}`,
    ).toEqual([]);

    // The coverage claim, asserted rather than assumed. Without these the
    // block could be green having never reached the state it exists for —
    // which is what "covered by another test" turned out to mean.
    expect(
      sweptWhileInFlight,
      'no ordering swept an intent whose send was still open',
    ).toBeGreaterThan(0);
    expect(
      correctedAfterSweep,
      'a send that landed after its intent was swept never corrected it to SENT',
    ).toBeGreaterThan(0);
    // The landing dimension, asserted rather than assumed — the same guard the
    // preludes needed. Without it every ordering could be parking a success
    // again and the two failing landings would be decoration.
    expect(
      sweptThenFailingLanding,
      'no ordering swept an intent whose outstanding send then FAILED',
    ).toBeGreaterThan(0);
  }, 600_000);

  /**
   * The kill switch governs the WHOLE batch, not whichever message was first.
   *
   * `claimDue` refuses an inactive tenant, and for one intent per tick that is
   * the whole rule. Production claims up to ten and delivers them one at a
   * time: the tenant is checked once, before the batch, and a stop that lands
   * while the first send is outstanding was invisible to every intent behind
   * it. So a stopped installation kept sending — bounded only by the batch
   * size, which is exactly the number of messages nobody wanted.
   *
   * Every ordering above raises ONE intent, so none of them can reach this. It
   * took an outside reviewer asking what a batch of one cannot show; the
   * dimension was fixed and invisible, the same way the attempt number was
   * before the preludes.
   */
  /**
   * The recheck has to be on the line before the send, not before `deliver`.
   *
   * Before `deliver` was the obvious place, and it was wrong for a reason the
   * test above cannot see: `deliver` renders first, and rendering reads the
   * tenant's template override and the feature flags governing it — several
   * awaited queries. A stop landing in THAT window met a check that had
   * already returned true, and the message went out. The comment claimed the
   * remaining window was the unavoidable read-to-send race; it was a
   * multi-query window with the check at the wrong end of it.
   *
   * Reaching it needs a render that can be paused, so this builds its own
   * dispatcher over the container's real repository and transport with a
   * template resolver that parks. The dispatcher takes all of it by
   * constructor, so nothing production-side has a test hook in it.
   */
});
