import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { ActorContext } from '@nexa/contracts';
import {
  notificationReleasedClaims,
  notifications,
  tenants,
} from '../../apps/api/src/infrastructure/persistence/schema';
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
 * Who owns a claim, and what a hand-back costs.
 *
 * `attempt_count` counts claims ISSUED and never goes down. Capacity comes back
 * by recording the claims that provably never reached the transport, so spend
 * is `attempt_count` minus those records. Three defects fall out of the old
 * model — a decrement matched against the current counter — and each has a
 * case here.
 *
 * All three are deterministic. Interleavings are driven by explicit barriers
 * and by calling the repository at the exact points a second worker would;
 * there are no sleeps and nothing depends on which promise the scheduler
 * happens to prefer.
 */
describe('notification claim ownership', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let transport: RecordingTransport;

  beforeEach(async () => {
    ctx ??= await createTestContext({ NOTIFICATION_TRANSPORT: 'recording' });
    await ctx.reset();
    transport = ctx.container.notificationTransport as RecordingTransport;
    transport.reset();
    ctx.container.notificationDispatcher.resetRateWindow();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner', roleKeys: ['owner'] }),
    );

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
      reason: 'Ownership setup.',
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const db = () => ctx.container.database.db;
  const repo = () => ctx.container.notificationRepository;
  const sql = (text: string) => ctx.container.database.withClient((c) => c.query(text));

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

  const rowOf = async (id: string) => {
    const [row] = await db()
      .select()
      .from(notifications)
      .where(eq(notifications.id, id as never));
    return row!;
  };

  const releasesFor = async (id: string) =>
    db()
      .select()
      .from(notificationReleasedClaims)
      .where(eq(notificationReleasedClaims.notificationId, id as never));

  const stopTenant = () =>
    db().update(tenants).set({ status: 'STOPPED' }).where(eq(tenants.id, tenantA.tenantId));
  const startTenant = () =>
    db().update(tenants).set({ status: 'ACTIVE' }).where(eq(tenants.id, tenantA.tenantId));

  /**
   * FINDING 1. Two claims outstanding, handed back in the WRONG order.
   *
   * The old release matched `attempt_count = attemptNumber`, so of the two only
   * the current one applied: attempt N-1 releasing first was refused outright,
   * nothing retried it, and one attempt of the allowance stayed spent for a
   * message no transport had been asked to carry.
   */
  it('restores capacity when two outstanding claims are handed back out of order', async () => {
    const intent = await raise('out-of-order');

    // Attempt 1 is claimed and its worker stalls past the lease.
    const [first] = await repo().claimDue(ctx.container.clock.now(), 10, 60_000);
    expect(first!.attemptCount).toBe(1);
    await sql(`UPDATE notifications SET next_attempt_at = now() - interval '1 hour'`);

    // A second worker claims attempt 2. BOTH are now outstanding.
    const [second] = await repo().claimDue(ctx.container.clock.now(), 10, 60_000);
    expect(second!.attemptCount).toBe(2);
    expect((await rowOf(intent.id)).attemptCount).toBe(2);

    // The installation stops before either reaches the transport, so both
    // deliveries decide RELEASED.
    await stopTenant();

    // The OLDER claim hands back FIRST. This is the ordering the old model
    // could not represent.
    const older = await repo().releaseClaim({
      tenantId: tenantA.tenantId,
      notificationId: intent.id,
      attemptNumber: 1,
      now: ctx.container.clock.now(),
      reason: 'tenant.not_active',
    });
    expect(older.released, 'the older hand-back was refused').toBe(true);

    const newer = await repo().releaseClaim({
      tenantId: tenantA.tenantId,
      notificationId: intent.id,
      attemptNumber: 2,
      now: ctx.container.clock.now(),
      reason: 'tenant.not_active',
    });
    expect(newer.released, 'the newer hand-back was refused').toBe(true);

    // Nothing was sent, and every claimed attempt is accounted for as unspent.
    expect(transport.calls, 'a stopped tenant was sent to').toBe(0);
    const released = await releasesFor(intent.id);
    expect(released.map((r) => r.attemptNumber).sort()).toEqual([1, 2]);

    const row = await rowOf(intent.id);
    expect(row.status).toBe('PENDING');
    // The counter is monotonic by design; capacity is the DERIVED figure.
    expect(row.attemptCount).toBe(2);
    const spent = row.attemptCount - released.length;
    expect(spent, 'an unsent claim consumed an attempt').toBe(0);

    // And the message can still be delivered its full allowance once the
    // installation comes back.
    await startTenant();
    await ctx.container.notificationDispatcher.tick();
    expect(transport.calls, 'the restored capacity was not usable').toBe(1);
    expect((await rowOf(intent.id)).status).toBe('SENT');
  }, 60_000);

  /**
   * FINDING 2. The sweep terminalises a final claim that is about to be
   * released.
   *
   * The tenant is ACTIVE when its last permitted attempt is claimed; the worker
   * is still rendering when the tenant stops; the safety margin passes and
   * another worker's `failExhausted` writes the intent off. The old release
   * then required `status = 'PENDING'` and refused, so a message that no
   * transport had ever been asked to carry was permanently FAILED because its
   * tenant paused.
   *
   * The owner decision is preserved: `failExhausted` still has no tenant-status
   * filter and still performs historical bookkeeping. What changed is that an
   * intent whose claims were handed back unsent is no longer EXHAUSTED, so the
   * verdict does not apply to it and is withdrawn.
   */
  it('does not permanently fail a final claim that was never sent', async () => {
    const intent = await raise('sweep-vs-release');

    // Attempt 1 spends itself for real, so the next claim is the final one.
    transport.failNextWith({
      outcome: 'FAILED_RETRYABLE',
      errorCode: 'telegram.unreachable',
      errorMessage: 'socket hang up',
      retryAfterMs: 0,
    });
    await ctx.container.notificationDispatcher.tick();
    expect(transport.calls).toBe(1);
    await sql(`UPDATE notifications SET next_attempt_at = now() - interval '1 hour'`);

    // The FINAL permitted attempt is claimed while the tenant is ACTIVE.
    const [final] = await repo().claimDue(ctx.container.clock.now(), 10, 60_000);
    expect(final!.attemptCount).toBe(2);

    // Its worker is still rendering. The tenant stops, and enough logical time
    // passes for the exhaustion margin.
    await stopTenant();
    await sql(`UPDATE notifications SET next_attempt_at = now() - interval '1 hour'`);

    // Another worker sweeps. It is deliberately tenant-blind — the owner
    // decision — and at this instant the intent still looks exhausted.
    const swept = await repo().failExhausted(ctx.container.clock.now(), 10, {
      leaseMs: 60_000,
      transport: 'RECORDING',
    });
    expect(swept, 'the sweep did not run').toBe(1);
    expect((await rowOf(intent.id)).status).toBe('FAILED');

    // Only now does the original worker finish rendering, see the stop, and
    // hand its claim back.
    const handBack = await repo().releaseClaim({
      tenantId: tenantA.tenantId,
      notificationId: intent.id,
      attemptNumber: 2,
      now: ctx.container.clock.now(),
      reason: 'tenant.not_active',
    });
    expect(handBack.released, 'the hand-back was refused').toBe(true);
    expect(handBack.restored, 'the sweep verdict was not withdrawn').toBe(true);

    // No outbound traffic for the stopped tenant, and the intent is not a
    // permanent delivery failure.
    expect(transport.calls, 'a stopped tenant was sent to').toBe(1);
    const row = await rowOf(intent.id);
    expect(row.status, 'an unsent final claim became a permanent failure').toBe('PENDING');
    expect(row.completedAt, 'a pending intent kept a completion time').toBeNull();

    // Real send capacity survives the pause: one genuine attempt was spent, one
    // remains, and it is usable once the tenant resumes.
    await startTenant();
    await ctx.container.notificationDispatcher.tick();
    expect(transport.calls, 'the preserved capacity was not usable').toBe(2);
    expect((await rowOf(intent.id)).status).toBe('SENT');
  }, 60_000);

  /**
   * A REAL permanent refusal is not a sweep verdict, and blocks the restore.
   *
   * The restore predicate has two clauses: the sweep's own exhaustion row must
   * exist, AND no other permanent failure may. Only the first was under test.
   * The existing case for the second builds a real refusal with NO sweep row,
   * which clause (a) already rejects — so clause (b) could be deleted whole and
   * every case here stayed green.
   *
   * This is the ordering that needs it: a final claim parked in the transport,
   * swept while it was outstanding, and THEN landing as the transport's own
   * refusal. Both rows now sit on the intent, so the question is no longer "was
   * there a sweep" but "is the sweep still the reason this intent is failed" —
   * and it is not. A hand-back that never spoke to the transport may withdraw
   * this module's guess about a missing outcome; it may not overturn an answer
   * Telegram actually gave.
   */
  it('does not withdraw a sweep once the transport has refused for real', async () => {
    const intent = await raise('real-refusal-vs-sweep');

    // Attempt 1's worker dies with nothing recorded, so its number stays free
    // for the hand-back at the end.
    const [first] = await repo().claimDue(ctx.container.clock.now(), 10, 60_000);
    expect(first!.attemptCount).toBe(1);
    await sql(`UPDATE notifications SET next_attempt_at = now() - interval '1 hour'`);

    // The FINAL claim's send parks inside the transport, holding a real
    // permanent refusal to deliver when it is let go.
    const held = transport.holdNextSend({
      outcome: 'FAILED_PERMANENT',
      errorCode: 'telegram.rejected.400',
      errorMessage: 'chat not found',
    });
    const tick = ctx.container.notificationDispatcher.tick();
    await held.entered;
    expect((await rowOf(intent.id)).attemptCount, 'the final claim was not issued').toBe(2);

    // Its lease expires, and a full extra lease of quiet passes. Another worker
    // sweeps: at this instant the intent really does look exhausted.
    await sql(`UPDATE notifications SET next_attempt_at = now() - interval '1 hour'`);
    const swept = await repo().failExhausted(ctx.container.clock.now(), 10, {
      leaseMs: 60_000,
      transport: 'RECORDING',
    });
    expect(swept, 'the sweep did not run').toBe(1);
    expect((await rowOf(intent.id)).status).toBe('FAILED');

    // Only now does the parked send land, with the transport's own verdict.
    held.release();
    await tick;
    const attempts = await ctx.container.notificationRepository.attempts(tenantA, intent.id);
    expect(
      attempts.map((attempt) => attempt.errorCode),
      'the late refusal and the sweep verdict are not both on record',
    ).toEqual(['telegram.rejected.400', 'notification.attempts_exhausted']);

    // The straggler from attempt 1 finally hands its claim back. Its capacity
    // returns — that number never reached the transport — but the intent stays
    // failed, because the reason it is failed is no longer the sweep.
    const handBack = await repo().releaseClaim({
      tenantId: tenantA.tenantId,
      notificationId: intent.id,
      attemptNumber: 1,
      now: ctx.container.clock.now(),
      reason: 'tenant.not_active',
    });
    expect(handBack.released, 'the hand-back lost its capacity').toBe(true);
    expect(
      handBack.restored,
      'a hand-back that never spoke to the transport reopened an intent the transport itself refused',
    ).toBe(false);

    const after = await rowOf(intent.id);
    expect(after.status, 'a real permanent refusal was reopened by a hand-back').toBe('FAILED');
    expect(after.completedAt, 'a failed intent lost its completion time').not.toBeNull();

    // And the consequence a person would actually see: the message is not sent
    // to a chat that does not exist, over and over.
    const before = transport.calls;
    await ctx.container.notificationDispatcher.tick();
    expect(transport.calls, 'a permanently refused message was retried').toBe(before);
  }, 60_000);

  /**
   * A withdrawn verdict is REPORTED, not merely applied.
   *
   * `restored` came back from the repository and both dispatcher call sites
   * threw it away. A FAILED intent silently becoming PENDING again is the
   * correction working — and it is also indistinguishable, from outside, from a
   * row changing status for no reason. The sweep's safety margin firing on a
   * claim that was still coming back is a tuning signal, so it is counted,
   * warned about, and written to the operational log the operations view reads.
   *
   * Driven through the DISPATCHER rather than the repository, because the
   * counter and the event are the dispatcher's, and because the ordering that
   * produces one is the dispatcher's own: a stop that lands while an intent is
   * being rendered, which is the window `deliver` re-checks the tenant in.
   */
  it('counts and records a withdrawn sweep verdict', async () => {
    const intent = await raise('restore-is-reported');

    // Attempt 1 spends itself for real, so the next claim is the final one.
    transport.failNextWith({
      outcome: 'FAILED_RETRYABLE',
      errorCode: 'telegram.unreachable',
      errorMessage: 'socket hang up',
      retryAfterMs: 0,
    });
    await ctx.container.notificationDispatcher.tick();
    await sql(`UPDATE notifications SET next_attempt_at = now() - interval '1 hour'`);

    // A dispatcher that can be stopped mid-render, which is the only window in
    // which a claim is held and no transport call has happened yet.
    let markRendering!: () => void;
    const rendering = new Promise<void>((resolve) => {
      markRendering = resolve;
    });
    let releaseRender!: () => void;
    const renderReleased = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const real = ctx.container.templateResolver;
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
      ctx.container.opsLogWriter,
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
    expect((await rowOf(intent.id)).attemptCount, 'the final claim was not issued').toBe(2);

    // The installation is stopped while that render is parked, its lease
    // expires, and another worker sweeps: at this instant the intent really
    // does look exhausted.
    await stopTenant();
    await sql(`UPDATE notifications SET next_attempt_at = now() - interval '1 hour'`);
    await repo().failExhausted(ctx.container.clock.now(), 10, {
      leaseMs: 60_000,
      transport: 'RECORDING',
    });
    expect((await rowOf(intent.id)).status, 'the sweep did not reach a verdict').toBe('FAILED');

    // The render finishes, the tenant re-check fails, and the hand-back
    // withdraws the verdict.
    releaseRender();
    const result = await tick;

    expect(transport.calls, 'a stopped tenant was sent to').toBe(1);
    expect(result.released, 'the claim was not handed back').toBe(1);
    expect(result.restored, 'a withdrawn exhaustion verdict was not counted').toBe(1);
    expect((await rowOf(intent.id)).status).toBe('PENDING');

    // And it is on the record, once, where an operator can see how often the
    // sweep's margin fires on a claim that was still coming back.
    const events = await sql(
      `SELECT code, severity, occurrence_count FROM operational_events
        WHERE code = 'notification.sweep_withdrawn'`,
    );
    expect(events.rows, 'the withdrawal was not recorded anywhere').toHaveLength(1);
    expect(events.rows[0]).toMatchObject({ severity: 'WARN', occurrence_count: 1 });
  }, 60_000);

  /**
   * An ORDINARY hand-back is not a withdrawal, and must not be reported as one.
   *
   * The release brought the intent's derived state up to date in one statement
   * covering both PENDING and FAILED, so its `RETURNING` matched for every
   * successful hand-back — and `restored`, documented as "the release took the
   * intent back out of a sweep's verdict", was true for all of them. Nothing
   * read the flag, so nothing noticed. Counting it, as the tick result now
   * does, would have logged one "a sweep verdict was wrong" warning and
   * recorded one operational event per queued message every time an operator
   * stopped the installation — noise generated by the correction mechanism, on
   * exactly the occasion an operator is reading the log.
   */
  it('does not report an ordinary hand-back as a withdrawn verdict', async () => {
    const intent = await raise('ordinary-handback-is-not-a-withdrawal');

    // No attempts spent, no sweep: this intent is simply put back.
    let markRendering!: () => void;
    const rendering = new Promise<void>((resolve) => {
      markRendering = resolve;
    });
    let releaseRender!: () => void;
    const renderReleased = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const real = ctx.container.templateResolver;
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
      ctx.container.opsLogWriter,
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
    await stopTenant();
    releaseRender();
    const result = await tick;

    expect(result.released, 'the claim was not handed back').toBe(1);
    expect(result.restored, 'an ordinary hand-back was reported as a withdrawn verdict').toBe(0);
    expect((await rowOf(intent.id)).status).toBe('PENDING');

    const events = await sql(
      `SELECT code FROM operational_events WHERE code = 'notification.sweep_withdrawn'`,
    );
    expect(events.rows, 'an ordinary hand-back recorded a withdrawal').toHaveLength(0);
  }, 60_000);

  /**
   * A withdrawn sweep is READABLE.
   *
   * The sweep's FAILED_PERMANENT row stays in the attempt history after being
   * retired — correctly; it is what `sweep.withdrawn` retires, and evidence is
   * not deleted. But the operations view showed only attempts, so an operator
   * read "permanently failed" on an intent that was somehow pending again,
   * with nothing anywhere connecting the two.
   */
  it('shows a withdrawn sweep as withdrawn, not as a permanent failure', async () => {
    const intent = await raise('withdrawn-sweep-is-readable');

    // One real attempt spent, then the final claim taken while the tenant is
    // active and handed back after a stop — the ordering that produces a
    // withdrawal.
    transport.failNextWith({
      outcome: 'FAILED_RETRYABLE',
      errorCode: 'telegram.unreachable',
      errorMessage: 'socket hang up',
      retryAfterMs: 0,
    });
    await ctx.container.notificationDispatcher.tick();
    await sql(`UPDATE notifications SET next_attempt_at = now() - interval '1 hour'`);
    await repo().claimDue(ctx.container.clock.now(), 10, 60_000);
    await stopTenant();
    await sql(`UPDATE notifications SET next_attempt_at = now() - interval '1 hour'`);
    await repo().failExhausted(ctx.container.clock.now(), 10, {
      leaseMs: 60_000,
      transport: 'RECORDING',
    });
    const handBack = await repo().releaseClaim({
      tenantId: tenantA.tenantId,
      notificationId: intent.id,
      attemptNumber: 2,
      now: ctx.container.clock.now(),
      reason: 'tenant.not_active',
    });
    expect(handBack.restored, 'the sweep verdict was not withdrawn').toBe(true);

    // A repeat withdraws nothing. The retry in the dispatcher's hand-back path
    // runs when the first call's outcome is unknown, so it may follow a restore
    // that did commit — and it must not report a second correction. The restore
    // branch requires the intent to be FAILED, which the first call already
    // undid.
    const again = await repo().releaseClaim({
      tenantId: tenantA.tenantId,
      notificationId: intent.id,
      attemptNumber: 2,
      now: ctx.container.clock.now(),
      reason: 'tenant.not_active',
    });
    expect(again.released, 'a repeated hand-back returned capacity twice').toBe(false);
    expect(again.restored, 'a repeated hand-back reported a second withdrawal').toBe(false);
    await startTenant();

    // What the operations view is handed.
    const view = await ctx.container.notifications.get(tenantA, owner, intent.id);
    expect(view.intent.status).toBe('PENDING');

    // The sweep's verdict is still in the attempt history, where it belongs.
    const exhausted = view.attempts.find(
      (attempt) => attempt.errorCode === 'notification.attempts_exhausted',
    );
    expect(exhausted, 'the sweep verdict vanished from the history').toBeDefined();

    // And beside it, the row that says the verdict was taken back — on the
    // same attempt number, so the two are readable as one event.
    expect(
      view.releasedClaims.map((claim) => [claim.attemptNumber, claim.reason]),
      'a permanent failure is shown under a pending intent with nothing withdrawing it',
    ).toEqual(
      expect.arrayContaining([
        [2, 'tenant.not_active'],
        [exhausted!.attemptNumber, 'sweep.withdrawn'],
      ]),
    );
  }, 60_000);

  /**
   * A stale hand-back must not reschedule somebody else's live claim.
   *
   * The release ROW is keyed by attempt number so a straggler can still return
   * its capacity — that is the point. The intent's SCHEDULE is a different
   * question, and dropping the ownership guard from it meant a straggler
   * releasing attempt 1 moved `next_attempt_at` back to now while attempt 2
   * held a live lease. A third worker then claimed and sent the same message
   * while attempt 2's send was still in flight: the lease is this module's
   * only concurrency control, and the stale releaser was cancelling it.
   */
  it('does not reschedule a live claim when a stale hand-back arrives', async () => {
    const intent = await raise('stale-release-lease');

    // Attempt 1 is claimed and stalls past its lease.
    await repo().claimDue(ctx.container.clock.now(), 10, 60_000);
    await sql(`UPDATE notifications SET next_attempt_at = now() - interval '1 hour'`);

    // Attempt 2 is claimed by another worker and holds a fresh lease.
    await repo().claimDue(ctx.container.clock.now(), 10, 60_000);
    const leased = (await rowOf(intent.id)).nextAttemptAt;
    expect(leased.getTime(), 'attempt 2 did not take a lease').toBeGreaterThan(Date.now());

    // The STALE claim hands back. Its capacity must return; the live lease
    // must not move.
    const stale = await repo().releaseClaim({
      tenantId: tenantA.tenantId,
      notificationId: intent.id,
      attemptNumber: 1,
      now: ctx.container.clock.now(),
      reason: 'tenant.not_active',
    });
    expect(stale.released, 'the stale hand-back lost its capacity').toBe(true);

    const after = await rowOf(intent.id);
    expect(after.nextAttemptAt.getTime(), "a stale hand-back cancelled a live claim's lease").toBe(
      leased.getTime(),
    );

    // And the practical consequence: no second worker can claim it, so the
    // message is not sent twice while attempt 2 is still outstanding.
    const stolen = await repo().claimDue(ctx.container.clock.now(), 10, 60_000);
    expect(stolen, 'a third worker claimed an intent that was already in flight').toEqual([]);
  }, 60_000);

  /**
   * Capacity that was handed back must be usable for REAL sends.
   *
   * `claimDue`, `failExhausted` and `releaseClaim` all moved to derived spend;
   * the dispatcher's abandonment test did not, and it read the monotonic claim
   * counter. So an intent handed back through a few stop/start cycles was
   * written off on its FIRST real send — the counter had passed `max_attempts`
   * while nothing had been spent. The defect this pass exists to fix, moved
   * from the repository into the dispatcher.
   */
  it('gives a message its full allowance after repeated stop and start cycles', async () => {
    const intent = await raise('allowance-across-cycles');

    // Six cycles: claimed while active, handed back when the tenant stops.
    for (let cycle = 0; cycle < 6; cycle += 1) {
      await startTenant();
      const [claimed] = await repo().claimDue(ctx.container.clock.now(), 10, 60_000);
      expect(claimed, `cycle ${cycle} could not claim`).toBeDefined();
      await stopTenant();
      await repo().releaseClaim({
        tenantId: tenantA.tenantId,
        notificationId: intent.id,
        attemptNumber: claimed!.attemptCount,
        now: ctx.container.clock.now(),
        reason: 'tenant.not_active',
      });
    }
    expect(transport.calls, 'a stopped tenant was sent to').toBe(0);

    const cycled = await rowOf(intent.id);
    expect(cycled.attemptCount, 'the claim counter is meant to be monotonic').toBe(6);
    expect(cycled.attemptCount - (await releasesFor(intent.id)).length).toBe(0);

    // Now the installation is back. `max_attempts` is 2, so the message gets
    // TWO real sends — not one, and not none.
    await startTenant();
    transport.failNextWith({
      outcome: 'FAILED_RETRYABLE',
      errorCode: 'telegram.unreachable',
      errorMessage: 'socket hang up',
      retryAfterMs: 0,
    });
    await ctx.container.notificationDispatcher.tick();
    expect(transport.calls).toBe(1);
    expect(
      (await rowOf(intent.id)).status,
      'the first real send was written off as exhausted',
    ).toBe('PENDING');

    await sql(`UPDATE notifications SET next_attempt_at = now() - interval '1 hour'`);
    await ctx.container.notificationDispatcher.tick();
    expect(transport.calls, 'the second real attempt never happened').toBe(2);
    expect((await rowOf(intent.id)).status).toBe('SENT');
  }, 60_000);

  /**
   * A FAILED reached any way OTHER than the sweep is a verdict a hand-back may
   * not overturn.
   */
  it('does not reopen an intent that failed for a reason other than the sweep', async () => {
    const intent = await raise('permanent-refusal');

    transport.failNextWith({
      outcome: 'FAILED_PERMANENT',
      errorCode: 'telegram.rejected.400',
      errorMessage: 'chat not found',
    });
    await ctx.container.notificationDispatcher.tick();
    expect((await rowOf(intent.id)).status).toBe('FAILED');

    // A hand-back for a claim that never recorded anything — attempt 2, which
    // has no attempt row — must not resurrect a transport refusal.
    await sql(`UPDATE notifications SET attempt_count = 2`);
    const outcome = await repo().releaseClaim({
      tenantId: tenantA.tenantId,
      notificationId: intent.id,
      attemptNumber: 2,
      now: ctx.container.clock.now(),
      reason: 'tenant.not_active',
    });
    expect(outcome.restored, 'a transport refusal was overturned').toBe(false);
    expect((await rowOf(intent.id)).status, 'a refused message was reopened').toBe('FAILED');
  }, 60_000);

  /** A release for a claim that was never issued cannot invent capacity. */
  it('refuses to release an attempt that was never claimed', async () => {
    const intent = await raise('never-claimed');

    const outcome = await repo().releaseClaim({
      tenantId: tenantA.tenantId,
      notificationId: intent.id,
      attemptNumber: 9,
      now: ctx.container.clock.now(),
      reason: 'tenant.not_active',
    });
    expect(outcome.released, 'capacity was invented for a claim never issued').toBe(false);
    expect(await releasesFor(intent.id)).toEqual([]);

    const row = await rowOf(intent.id);
    expect(
      row.attemptCount - (await releasesFor(intent.id)).length,
      'spend went negative',
    ).toBeGreaterThanOrEqual(0);
  }, 60_000);

  /**
   * A hand-back whose first write fails is retried once, and the retry is safe
   * because the release is keyed by attempt number.
   */
  it('retries a failed hand-back once and recovers the attempt', async () => {
    const intent = await raise('retry-handback');

    const activeTenants = repo().activeTenants.bind(repo());
    (repo() as { activeTenants: typeof activeTenants }).activeTenants = async () => new Set();
    const real = repo().releaseClaim.bind(repo());
    let calls = 0;
    (repo() as { releaseClaim: typeof real }).releaseClaim = async (input) => {
      calls += 1;
      if (calls === 1) throw new Error('the hand-back could not be stored');
      return real(input);
    };

    try {
      const result = await ctx.container.notificationDispatcher.tick();
      expect(calls, 'the hand-back was not retried').toBe(2);
      expect(result.released, 'the retry did not record the hand-back').toBe(1);
      expect(result.unreleased, 'a recovered hand-back was reported as lost').toBe(0);
      expect(transport.calls).toBe(0);
      expect(await releasesFor(intent.id)).toHaveLength(1);
      expect((await rowOf(intent.id)).attemptCount - 1, 'the attempt was spent').toBe(0);
    } finally {
      (repo() as { releaseClaim: typeof real }).releaseClaim = real;
      (repo() as { activeTenants: typeof activeTenants }).activeTenants = activeTenants;
    }
  }, 60_000);

  /**
   * A release must never hand back capacity for a message that WAS sent.
   *
   * The guard is the attempt row: it is the proof a transport call happened.
   * Without it, a late or duplicated release could give an allowance back to a
   * delivered message and have it sent again.
   */
  it('refuses to release an attempt that reached the transport', async () => {
    const intent = await raise('released-after-send');

    await ctx.container.notificationDispatcher.tick();
    expect(transport.calls).toBe(1);
    expect((await rowOf(intent.id)).status).toBe('SENT');

    const outcome = await repo().releaseClaim({
      tenantId: tenantA.tenantId,
      notificationId: intent.id,
      attemptNumber: 1,
      now: ctx.container.clock.now(),
      reason: 'tenant.not_active',
    });
    expect(outcome.released, 'capacity was returned for a message that was sent').toBe(false);
    expect(await releasesFor(intent.id)).toEqual([]);
    expect((await rowOf(intent.id)).status, 'a delivered message was un-sent').toBe('SENT');
  }, 60_000);

  /**
   * A release is idempotent, which is what makes it safe to repeat after a
   * commit whose outcome is unknown.
   */
  it('records a repeated hand-back once', async () => {
    const intent = await raise('idempotent-release');
    await repo().claimDue(ctx.container.clock.now(), 10, 60_000);
    await stopTenant();

    const args = {
      tenantId: tenantA.tenantId,
      notificationId: intent.id,
      attemptNumber: 1,
      now: ctx.container.clock.now(),
      reason: 'tenant.not_active',
    };
    const first = await repo().releaseClaim(args);
    const again = await repo().releaseClaim(args);

    expect(first.released).toBe(true);
    // The second call recorded nothing NEW — and reported that truthfully
    // rather than counting a second hand-back that never happened.
    expect(again.released).toBe(false);
    expect(await releasesFor(intent.id)).toHaveLength(1);

    const row = await rowOf(intent.id);
    expect(row.attemptCount - (await releasesFor(intent.id)).length).toBe(0);
  }, 60_000);

  /**
   * FINDING 3. A hand-back whose storage fails must not strand the rest of the
   * batch.
   *
   * The dispatcher guards `deliver` per intent, but the release ran outside
   * that guard, so a transient database failure there threw out of the loop and
   * left every intent claimed behind it leased, counted and unexplained.
   */
  it('processes the rest of the batch when a hand-back cannot be recorded', async () => {
    await raise('batch-first');
    await raise('batch-second');
    const queued = await db().select().from(notifications);
    expect(queued, 'the batch needs more than one intent to mean anything').toHaveLength(2);

    // The tenant is ACTIVE when the batch is claimed and inactive by the time
    // either is delivered — the real ordering, since `claimDue` refuses an
    // inactive tenant outright. The per-send recheck is the seam, so it is the
    // seam this drives.
    const activeTenants = repo().activeTenants.bind(repo());
    (repo() as { activeTenants: typeof activeTenants }).activeTenants = async () => new Set();

    // BOTH attempts for the first intent fail — the call and its retry — so
    // the intent genuinely loses its hand-back. That is the case that used to
    // throw out of the loop and strand everything claimed behind it.
    const real = repo().releaseClaim.bind(repo());
    let failures = 0;
    (repo() as { releaseClaim: typeof real }).releaseClaim = async (input) => {
      if (failures < 2) {
        failures += 1;
        throw new Error('the hand-back could not be stored');
      }
      return real(input);
    };

    try {
      const result = await ctx.container.notificationDispatcher.tick();

      // The batch was not abandoned: the second intent still got its own
      // hand-back, and the failure was reported as itself.
      expect(result.claimed, 'the whole batch was not claimed').toBe(2);
      expect(result.unreleased, 'the failed hand-back was not reported').toBe(1);
      expect(result.released, 'the second hand-back did not happen').toBe(1);

      // No delivery outcome was invented for either.
      expect(transport.calls, 'a stopped tenant was sent to').toBe(0);
      expect(result.sent + result.failed + result.abandoned).toBe(0);

      // No double decrement, and nothing terminal: exactly one release is
      // recorded, and the intent whose hand-back failed keeps its lease and
      // stays PENDING, so the next claim can repeat the idempotent release.
      const rows = await db().select().from(notifications);
      expect(rows.every((r) => r.status === 'PENDING')).toBe(true);
      const allReleases = await db().select().from(notificationReleasedClaims);
      expect(allReleases, 'the failed hand-back was recorded anyway').toHaveLength(1);
      // No double decrement: the counter is monotonic, so one claim each, and
      // exactly one of the two has its capacity back.
      expect(rows.every((r) => r.attemptCount === 1)).toBe(true);
    } finally {
      (repo() as { releaseClaim: typeof real }).releaseClaim = real;
      (repo() as { activeTenants: typeof activeTenants }).activeTenants = activeTenants;
    }
  }, 60_000);

  /**
   * And the recovery the case above leaves open actually works: the unrecorded
   * hand-back is repeated on the next claim, once the lease expires.
   */
  it('recovers an unrecorded hand-back on the next claim', async () => {
    const intent = await raise('recoverable');
    await stopTenant();

    // A hand-back that never reached storage: the claim is taken, nothing is
    // recorded, and the lease is left to expire.
    await sql(
      `UPDATE notifications SET attempt_count = 1, next_attempt_at = now() - interval '1 hour'`,
    );
    expect(await releasesFor(intent.id)).toEqual([]);

    await startTenant();
    await ctx.container.notificationDispatcher.tick();

    // The intent was claimable again and was delivered. Nothing was lost.
    expect(transport.calls).toBe(1);
    expect((await rowOf(intent.id)).status).toBe('SENT');
  }, 60_000);

  /** Releases are tenant-scoped like every other row in this module. */
  it('scopes a release to its own tenant', async () => {
    const intent = await raise('tenant-scoped');
    await repo().claimDue(ctx.container.clock.now(), 10, 60_000);
    await stopTenant();

    await repo().releaseClaim({
      tenantId: tenantA.tenantId,
      notificationId: intent.id,
      attemptNumber: 1,
      now: ctx.container.clock.now(),
      reason: 'tenant.not_active',
    });

    const [row] = await db()
      .select()
      .from(notificationReleasedClaims)
      .where(
        and(
          eq(notificationReleasedClaims.tenantId, tenantA.tenantId as never),
          eq(notificationReleasedClaims.notificationId, intent.id as never),
        ),
      );
    expect(row!.tenantId).toBe(tenantA.tenantId);
    expect(row!.reason).toBe('tenant.not_active');
  }, 60_000);
});
