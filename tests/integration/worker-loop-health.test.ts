import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness';

/**
 * The worker's background loops, and whether the process can tell that one has
 * stopped doing its job.
 *
 * Before this, three of the worker's six loops were invisible to every health
 * signal: the outbox relay, the two retention sweepers and the notification
 * dispatcher. The heartbeat wrote on a successful `SELECT 1`, so a worker whose
 * relay had silently stopped and whose dispatcher was throwing on every tick
 * reported healthy indefinitely.
 *
 * The dispatcher is the one worth stating twice: it drains the queue by which
 * the installation reports anything being wrong. Dead, it means the system has
 * lost its ability to say it is broken, and the only symptom is silence — which
 * is indistinguishable from nothing being wrong.
 *
 * These run against the real relay and the real dispatcher over a real
 * database, because the property is about what a completed tick means, and a
 * fake tick means nothing.
 */
describe('worker loop health', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext();
  }, 60_000);

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  /**
   * Every case drives the loop DIRECTLY and never calls `start()`.
   *
   * That is the design, not a shortcut. `start()` opens a startup grace window
   * — one slack interval in which a loop that has not yet ticked still reports
   * fresh, because at boot the absence of progress is evidence of a young
   * process rather than a broken loop. A test that starts the loop and then
   * asserts freshness is satisfied by the grace alone and stays green with the
   * progress recording deleted: the first version of this file did exactly
   * that, and the falsification run reported SURVIVED for all three loops.
   *
   * Unstarted, `isFresh` can become true only by way of a completed tick.
   */
  describe('the outbox relay', () => {
    it('is not fresh until a batch has completed', async () => {
      const relay = context.container.relay;
      const now = context.container.clock.now().getTime();

      expect(relay.isFresh(now)).toBe(false);
      // A real batch against the real table.
      await relay.processBatch();
      expect(relay.isFresh(now)).toBe(true);
    });

    it('goes stale once batches stop, with its loop still alive', async () => {
      const relay = context.container.relay;
      await relay.processBatch();
      const now = context.container.clock.now().getTime();

      // Far past any plausible poll interval. The relay's timer would still be
      // scheduled; this is the hang, not the crash — `processBatch` never
      // returning means `scheduleNext` is never reached, `running` stays true
      // so `start()` is a no-op, and the heartbeat keeps writing because
      // `SELECT 1` on another checkout still succeeds.
      expect(relay.isFresh(now + 60 * 60 * 1000)).toBe(false);
    });

    it('stops claiming freshness once stopped', async () => {
      const relay = context.container.relay;
      await relay.processBatch();
      expect(relay.isFresh(context.container.clock.now().getTime())).toBe(true);
      relay.start();
      await relay.stop();
      // `stop()` runs on the shutdown path, and a draining worker that still
      // reported fresh would look healthy while it was going away.
      expect(relay.isFresh(context.container.clock.now().getTime())).toBe(false);
    });
  });

  describe('the notification dispatcher', () => {
    it('is not fresh until a tick has completed', async () => {
      const dispatcher = context.container.notificationDispatcher;
      const now = context.container.clock.now().getTime();

      expect(dispatcher.isFresh(now)).toBe(false);
      // An empty queue is still a completed tick: the loop did its job and
      // found nothing to do, which is the overwhelmingly common case and must
      // count as progress or a quiet installation reports unhealthy.
      await dispatcher.tick();
      expect(dispatcher.isFresh(now)).toBe(true);
    });

    it('goes stale once ticks stop', async () => {
      const dispatcher = context.container.notificationDispatcher;
      await dispatcher.tick();
      const now = context.container.clock.now().getTime();
      expect(dispatcher.isFresh(now + 60 * 60 * 1000)).toBe(false);
    });

    it('records no progress for a tick that threw', async () => {
      const dispatcher = context.container.notificationDispatcher;

      /*
       * Cleared first, and asserted at `now` afterwards.
       *
       * The dispatcher is one instance shared across the cases in this file, so
       * an earlier successful tick has already recorded progress whose slack
       * window still covers the present moment. The first version of this case
       * worked around that by asserting an HOUR out — and an hour out no record
       * of any kind can be fresh, so the assertion held whether this tick
       * recorded progress or not. It reported KILLED for the deletion of the
       * recording and SURVIVED for moving the recording BEFORE the await, which
       * is the mutation that actually reintroduces the bug: a tick that threw
       * would count as progress.
       *
       * `stop()` calls `progress.end()`, which clears both the start instant and
       * the last tick. From there `isFresh(now)` can become true only by way of
       * a new record, so the window the assertion reads is this tick's alone.
       */
      await dispatcher.stop();
      const before = context.container.clock.now().getTime();
      expect(dispatcher.isFresh(before)).toBe(false);

      const repository = context.container.notificationRepository as unknown as {
        claimDue: unknown;
      };
      const real = repository.claimDue;
      repository.claimDue = async () => {
        throw new Error('the database is unreachable');
      };
      try {
        await expect(dispatcher.tick()).rejects.toThrow(/unreachable/);
      } finally {
        repository.claimDue = real;
      }

      // The poll loop catches and reschedules, so from outside the process this
      // failure is invisible — which is exactly the state that used to report
      // healthy for ever, on the one loop that drains the queue by which this
      // installation reports anything being wrong.
      expect(dispatcher.isFresh(context.container.clock.now().getTime())).toBe(false);
    });
  });
});
