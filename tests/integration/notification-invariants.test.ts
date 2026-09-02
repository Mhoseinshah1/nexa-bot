import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ActorContext } from '@nexa/contracts';
import { notifications } from '../../apps/api/src/infrastructure/persistence/schema';
import type { RecordingTransport } from '../../apps/api/src/modules/control/notifications/infrastructure/recording-transport';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * The dispatcher's state machine, checked by ENUMERATING orderings rather than
 * by naming the ones somebody thought of.
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

  const all = sequences(3);

  /**
   * A clean world for one ordering, so nothing a previous sequence left behind
   * can explain this one's result.
   */
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
    const numbers = attempts.map((attempt) => attempt.attemptNumber);
    if (new Set(numbers).size !== numbers.length) {
      broken.push(`[${where}] duplicate attempt numbers: ${numbers.join(',')}`);
    }
    if (transport.calls > row!.maxAttempts) {
      broken.push(`[${where}] transport called ${transport.calls} times`);
    }

    // 5. A terminal status always carries a completion time, and a pending one
    //    never does — the CHECK constraint's rule, asserted from outside it so
    //    a future migration cannot quietly drop it.
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

  it('enumerates a meaningful number of orderings', () => {
    expect(all.length).toBe(STEPS.length ** 3);
  });

  it('holds every invariant across every three-step ordering', async () => {
    const broken: string[] = [];

    for (const sequence of all) {
      const intent = await begin(`panel:${sequence.join('-')}`);
      for (const step of sequence) await apply(step);
      await checkInvariants(
        intent,
        sequence.join(' → '),
        sequence.at(-1) === 'TICK' && sequence.includes('EXPIRE_LEASE'),
        broken,
      );
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
   */
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

  it('holds every invariant when a send is still in flight', async () => {
    const broken: string[] = [];
    let correctedAfterSweep = 0;
    let sweptWhileInFlight = 0;

    let windows: Step[][] = [[]];
    for (let i = 0; i < 3; i += 1) {
      windows = windows.flatMap((prefix) => INTERLEAVED.map((step) => [...prefix, step]));
    }
    const orderings = PRELUDES.flatMap((prelude) => windows.map((window) => ({ prelude, window })));

    for (const { prelude, window: sequence } of orderings) {
      const opening = prelude.length === 0 ? 'first attempt' : prelude.join(' → ');
      const where = `${opening} → send in flight → ${sequence.join(' → ')} → send lands`;
      const intent = await begin(`slow:${prelude.join('-')}:${sequence.join('-')}`);
      for (const step of prelude) await apply(step);

      const hold = transport.holdNextSend();
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
      }

      await checkInvariants(
        intent,
        where,
        sequence.at(-1) === 'TICK' && sequence.includes('EXPIRE_LEASE'),
        broken,
      );
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
  }, 600_000);
});
