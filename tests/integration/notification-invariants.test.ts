import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ActorContext } from '@nexa/contracts';
import { notifications, tenants } from '../../apps/api/src/infrastructure/persistence/schema';
import { NotificationDispatcher } from '../../apps/api/src/modules/control/notifications/application/notification-dispatcher';
import type { TemplateResolver } from '../../apps/api/src/modules/control/templates/application/template-resolver';
import type { RecordingTransport } from '../../apps/api/src/modules/control/notifications/infrastructure/recording-transport';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * The dispatcher's state machine: one deterministic regression per failure
 * shape Phase 2 actually found.
 *
 * These run on every pull request and are fast. The exhaustive enumeration
 * that FOUND several of them — 1 341 orderings over six steps, three preludes
 * and three landings — lives in `tests/exhaustive/notification-orderings.test.ts`
 * and runs nightly, because its value is discovering a shape nobody has
 * imagined and that is worth a lot once a night and very little on the ninth
 * push of an afternoon.
 *
 * The split has one rule: nothing may be covered ONLY by the nightly suite. A
 * bug that has already escaped once gets a named test here.
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

  /** Records an operational event, which projects into one notification intent. */
  async function raiseOnly(dedupeKey: string): Promise<void> {
    await ctx.container.opsLog.record(tenantA, {
      code: 'panel.unreachable',
      severity: 'ERROR',
      message: 'The panel did not answer.',
      dedupeKey,
    });
  }

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

  async function statusOf(intent: Awaited<ReturnType<typeof raise>>): Promise<string> {
    const [row] = await ctx.container.database.db
      .select({ status: notifications.status })
      .from(notifications)
      .where(eq(notifications.id, intent.id));
    return row!.status;
  }

  /**
   * A send still in flight when its lease expires, swept, then landing.
   *
   * The ordering the sweep's safety margin exists for, and the one no test
   * could reach until the transport could park: claim, send outstanding, lease
   * expires, `failExhausted` writes the intent off, and only then does the
   * successful outcome arrive. `recordAttempt` widens its predicate to
   * `status <> 'SENT'` precisely so this corrects rather than being discarded.
   */
  it('corrects a swept intent when its in-flight send lands successfully', async () => {
    const intent = await begin('inflight-late-success');

    // Attempt 1 fails, so the outstanding send below is attempt 2 of 2 — the
    // number the sweep's synthetic attempt row would collide with if it used
    // `attempt_count` instead of `attempt_count + 1`.
    await apply('FAIL_RETRYABLE');
    await apply('EXPIRE_LEASE');

    const hold = transport.holdNextSend();
    const slow = ctx.container.notificationDispatcher.tick();
    const arrived = await Promise.race([
      hold.entered.then(() => 'at the barrier' as const),
      slow.then(() => 'finished early' as const),
    ]);
    expect(arrived, 'no send was left in flight').toBe('at the barrier');

    // The lease expires under the running send, and a second tick sweeps it.
    await apply('EXPIRE_LEASE');
    await ctx.container.notificationDispatcher.tick();
    expect(await statusOf(intent), 'the sweep did not write the intent off').toBe('FAILED');

    hold.release();
    await slow;

    expect(await statusOf(intent), 'a delivered message stayed FAILED').toBe('SENT');
    const attempts = await ctx.container.notificationRepository.attempts(tenantA, intent.id);
    const numbers = attempts.map((a) => a.attemptNumber);
    expect(new Set(numbers).size, `duplicate attempt numbers: ${numbers.join(',')}`).toBe(
      numbers.length,
    );
  }, 60_000);

  /**
   * An intent resting PENDING with its attempts spent is the only state the
   * sweep exists for, and nothing a caller can do reaches it — a recorder that
   * died between the claim and the attempt row is what leaves it.
   */
  it('sweeps an intent that is out of attempts and has stopped being claimed', async () => {
    const intent = await begin('exhausted-sweep');

    await apply('LOSE_OUTCOME');
    await apply('EXPIRE_LEASE');
    const before = await statusOf(intent);
    expect(before, 'setup did not leave the intent PENDING').toBe('PENDING');

    const result = await ctx.container.notificationDispatcher.tick();
    expect(result.exhausted, 'the sweep did not run').toBe(1);
    expect(await statusOf(intent), 'the intent was left pending for ever').toBe('FAILED');

    // A terminal intent always has a record of why, even when the outcome that
    // terminalised it was never recorded by a sender.
    const attempts = await ctx.container.notificationRepository.attempts(tenantA, intent.id);
    expect(attempts.length, 'FAILED with no attempt behind it').toBeGreaterThan(0);
  }, 60_000);

  /**
   * Shutdown must not abandon a send that is already talking to Telegram.
   *
   * `stop()` used to clear the next timer and return; `container.shutdown()`
   * then closed the pool while a send was outstanding, so its outcome had
   * nowhere to go, the row kept its lease, and the next deployment sent the
   * same alert again — one duplicate per deploy that happened to overlap.
   */
  it('waits for an in-flight send before it finishes stopping', async () => {
    await begin('shutdown-inflight');

    const hold = transport.holdNextSend();
    const dispatcher = ctx.container.notificationDispatcher;
    const slow = dispatcher.tick();
    const arrived = await Promise.race([
      hold.entered.then(() => 'at the barrier' as const),
      slow.then(() => 'finished early' as const),
    ]);
    expect(arrived, 'no send was left in flight').toBe('at the barrier');

    // `stop()` is called while the send is parked. It must not resolve yet.
    let stopped = false;
    const stopping = dispatcher.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped, 'stop() returned while a send was still outstanding').toBe(false);

    hold.release();
    await slow;
    await stopping;
    expect(stopped).toBe(true);
  }, 60_000);

  it('does not send when the tenant stops while the message is being rendered', async () => {
    const intent = await begin('render-window');

    let markRendering!: () => void;
    const rendering = new Promise<void>((resolve) => {
      markRendering = resolve;
    });
    let releaseRender!: () => void;
    const renderReleased = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });

    const real = ctx.container.templateResolver;
    // Only `render` is reached from `deliver`; the cast says so rather than
    // pretending this is a whole resolver.
    const pausing = {
      render: async (...args: Parameters<TemplateResolver['render']>) => {
        markRendering();
        await renderReleased;
        return real.render(...args);
      },
    } as unknown as TemplateResolver;

    const dispatcher = new NotificationDispatcher(
      ctx.container.notificationRepository,
      transport,
      pausing,
      ctx.container.settingsResolver,
      ctx.container.clock,
      ctx.container.ids,
      ctx.container.logger,
      {
        pollIntervalMs: 1_000,
        batchSize: 10,
        leaseMs: 60_000,
        baseBackoffMs: 1_000,
        maxBackoffMs: 60_000,
      },
    );

    const tick = dispatcher.tick();
    await rendering;

    // Claimed, leased, and now rendering. The operator stops the installation.
    await ctx.container.database.db
      .update(tenants)
      .set({ status: 'STOPPED' })
      .where(eq(tenants.id, tenantA.tenantId));

    releaseRender();
    const result = await tick;

    expect(transport.calls, 'a stopped tenant was sent to after rendering').toBe(0);
    expect(result.released, 'the claim was not handed back').toBe(1);

    const [row] = await ctx.container.database.db
      .select()
      .from(notifications)
      .where(eq(notifications.id, intent.id));
    expect(row!.status).toBe('PENDING');
    expect(row!.attemptCount, 'the released intent was charged an attempt').toBe(0);
  }, 60_000);

  /**
   * A release must not be able to rewind the clock on an attempt still in the
   * air.
   *
   * `releaseClaim` recomputes `last_attempt_at` from the attempt rows, because
   * the claim had set it to the claim time and a released claim never
   * happened. But an attempt whose send outlived its lease has no row yet — it
   * is still running — so the recomputation cannot see it and winds the
   * timestamp back to an older attempt, or to null. The straggler's own
   * `recordAttempt` then wrote its row without touching the timestamp, so the
   * operations view reported "never attempted" for a delivery that had
   * completed. Two correct-looking rules, and the gap between them.
   */
  it('keeps the last attempt time when a straggler lands after a release', async () => {
    const intent = await begin('straggler');
    const now = ctx.container.clock.now();

    // Attempt 1 is claimed and its send outlives the lease. Attempt 2 is then
    // claimed by the next tick.
    await ctx.container.notificationRepository.claimDue(now, 10, 60_000);
    await sql(`UPDATE notifications SET next_attempt_at = now() - interval '1 hour'`);
    await ctx.container.notificationRepository.claimDue(ctx.container.clock.now(), 10, 60_000);

    // The installation stops, so attempt 2 is handed back before it sends.
    await ctx.container.database.db
      .update(tenants)
      .set({ status: 'STOPPED' })
      .where(eq(tenants.id, tenantA.tenantId));
    const { released } = await ctx.container.notificationRepository.releaseClaim({
      tenantId: tenantA.tenantId,
      notificationId: intent.id,
      attemptNumber: 2,
      now: ctx.container.clock.now(),
    });
    expect(released, 'the release did not match the claim it was meant to undo').toBe(true);

    // Only NOW does attempt 1 report. It succeeded, and the record of when it
    // finished is the whole point.
    const finishedAt = new Date(ctx.container.clock.now().getTime() + 1_000);
    await ctx.container.notificationRepository.recordAttempt({
      attemptId: ctx.container.ids.uuid(),
      tenantId: tenantA.tenantId,
      notificationId: intent.id,
      attemptNumber: 1,
      transport: 'RECORDING',
      outcome: 'SUCCEEDED',
      startedAt: now,
      finishedAt,
      errorCode: null,
      errorMessage: null,
      retryAfterMs: null,
      nextStatus: 'SENT',
      nextAttemptAt: finishedAt,
    });

    const [row] = await ctx.container.database.db
      .select()
      .from(notifications)
      .where(eq(notifications.id, intent.id));
    expect(row!.lastAttemptAt, 'a completed attempt left no last-attempt time').not.toBeNull();
    expect(row!.lastAttemptAt!.getTime()).toBe(finishedAt.getTime());
  }, 60_000);

  it('stops sending the rest of a batch when the tenant stops mid-send', async () => {
    await begin('batch:first');
    await raiseOnly('batch:second');

    const queued = await ctx.container.database.db.select().from(notifications);
    expect(queued, 'the batch needs more than one intent to mean anything').toHaveLength(2);

    const hold = transport.holdNextSend();
    const tick = ctx.container.notificationDispatcher.tick();
    await hold.entered;

    // The batch is claimed and the first send is outstanding. NOW the operator
    // stops the installation.
    await ctx.container.database.db
      .update(tenants)
      .set({ status: 'STOPPED' })
      .where(eq(tenants.id, tenantA.tenantId));

    hold.release();
    await tick;

    // The send already in flight lands — a stop cannot un-send it, and
    // pretending otherwise would file a delivered message as undelivered.
    expect(transport.calls, 'the stopped tenant was still sent to').toBe(1);
    expect(transport.messages).toHaveLength(1);

    const rows = await ctx.container.database.db.select().from(notifications);
    expect(rows).toHaveLength(2);
    const held = rows.filter((row) => row.status === 'PENDING');
    expect(held, 'the rest of the batch did not stay queued').toHaveLength(1);

    // Queued, not failed, and not charged for the attempt it never spent. A
    // counter left spent would be swept to FAILED by `failExhausted` after a
    // few stops, reporting a permanent delivery failure for a message no
    // transport was ever asked to carry.
    expect(held[0]!.attemptCount, 'the released intent was charged an attempt').toBe(0);
    expect(held[0]!.completedAt).toBeNull();
  }, 60_000);
});
