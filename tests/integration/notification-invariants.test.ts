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

  it('enumerates a meaningful number of orderings', () => {
    expect(all.length).toBe(STEPS.length ** 3);
  });

  it('holds every invariant across every three-step ordering', async () => {
    const broken: string[] = [];

    for (const sequence of all) {
      // A full reset per ordering, so one sequence cannot leave state that
      // explains the next one's result. `reset` truncates the admin too, so
      // the actor is rebuilt with it.
      await ctx.reset();
      owner = adminActorFor(
        await createAdmin(ctx.container, tenantA, { username: 'owner', roleKeys: ['owner'] }),
      );
      await configure();
      transport.reset();

      const intent = await raise(`panel:${sequence.join('-')}`);
      const delivered = () => transport.messages.length > 0;

      for (const step of sequence) await apply(step);

      const [row] = await ctx.container.database.db
        .select()
        .from(notifications)
        .where(eq(notifications.id, intent.id));
      const attempts = await ctx.container.notificationRepository.attempts(tenantA, intent.id);
      const where = sequence.join(' → ');

      // 1. A delivered message never ends FAILED.
      if (delivered() && row!.status === 'FAILED') {
        broken.push(`[${where}] delivered but recorded FAILED`);
      }

      // 2. An intent never rests PENDING with its attempts spent. The sweep
      //    only acts once the lease AND its margin have passed, so this is
      //    asserted after a step that guarantees both.
      if (
        row!.status === 'PENDING' &&
        row!.attemptCount >= row!.maxAttempts &&
        sequence.at(-1) === 'TICK' &&
        sequence.includes('EXPIRE_LEASE')
      ) {
        broken.push(`[${where}] PENDING with ${row!.attemptCount}/${row!.maxAttempts} attempts`);
      }

      // 3. A terminal intent always has a record of why.
      if (row!.status !== 'PENDING' && attempts.length === 0) {
        broken.push(`[${where}] ${row!.status} with no attempt behind it`);
      }

      // 4. Attempt numbers are unique, and the transport is not called more
      //    often than the intent's own ceiling allows.
      const numbers = attempts.map((attempt) => attempt.attemptNumber);
      if (new Set(numbers).size !== numbers.length) {
        broken.push(`[${where}] duplicate attempt numbers: ${numbers.join(',')}`);
      }
      if (transport.messages.length > row!.maxAttempts) {
        broken.push(`[${where}] sent ${transport.messages.length} times`);
      }

      // 5. A terminal status always carries a completion time, and a pending
      //    one never does — the CHECK constraint's rule, asserted from outside
      //    it so a future migration cannot quietly drop it.
      const terminalWithoutTime = row!.status !== 'PENDING' && row!.completedAt === null;
      const pendingWithTime = row!.status === 'PENDING' && row!.completedAt !== null;
      if (terminalWithoutTime || pendingWithTime) {
        broken.push(`[${where}] ${row!.status} with completedAt=${String(row!.completedAt)}`);
      }
    }

    expect(
      broken,
      `${broken.length} orderings broke an invariant:\n${broken.slice(0, 10).join('\n')}`,
    ).toEqual([]);
  }, 600_000);
});
