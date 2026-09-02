import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorContext } from '@nexa/contracts';
import { NotificationDispatcher } from '../../apps/api/src/modules/control/notifications/application/notification-dispatcher';
import type { RecordingTransport } from '../../apps/api/src/modules/control/notifications/infrastructure/recording-transport';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Notification delivery, end to end, against a real database.
 *
 * The transport is the deterministic recording one, so the assertions are about
 * OUR behaviour — dedupe, retry, back-off, abandonment — rather than about
 * Telegram's. The Telegram transport is real and is exercised separately at the
 * unit level; what cannot be faked is the queue, and that is what runs here.
 */
describe('notification delivery', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let transport: RecordingTransport;

  beforeEach(async () => {
    ctx ??= await createTestContext({ NOTIFICATION_TRANSPORT: 'recording' });
    await ctx.reset();

    transport = ctx.container.notificationTransport as RecordingTransport;
    transport.reset();
    ctx.container.notificationDispatcher.setRateLimitScope(tenantA);

    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner', roleKeys: ['owner'] }),
    );

    // A destination, and the feature turned on. Both are required, and neither
    // implies the other — which is the whole point of ADR-0019.
    await configure(tenantA, owner);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  async function configure(scope: typeof tenantA, actor: ActorContext) {
    await ctx.container.settingsService.set(scope, actor, {
      key: 'ops.notifications.telegram_chat_id',
      value: '-100999',
      expectedVersion: null,
      idempotencyKey: `chat-${scope.tenantId}-${Date.now()}`,
    });
    await ctx.container.featureFlags.set(scope, actor, {
      key: 'ops_notifications',
      enabled: true,
      expectedVersion: null,
      idempotencyKey: `flag-${scope.tenantId}-${Date.now()}`,
      confirmKey: 'ops_notifications',
      reason: 'Test setup.',
    });
  }

  const raiseError = (dedupeKey = 'panel:1', scope = tenantA) =>
    ctx.container.opsLog.record(scope, {
      code: 'panel.unreachable',
      severity: 'ERROR',
      message: 'The panel did not answer.',
      dedupeKey,
    });

  describe('the projection', () => {
    it('queues one notification for a condition, however often it fires', async () => {
      // The legacy log group posted the same expired-TLS error 36 + 15 + 8 + 1
      // times in one day (BUG-LGR-028). Dedupe makes that one row; this makes
      // it one message.
      await raiseError();
      await raiseError();
      await raiseError();

      const queued = await ctx.container.notifications.list(tenantA, owner);
      expect(queued).toHaveLength(1);
      expect(queued[0]?.kind).toBe('OPERATIONAL_EVENT');
    });

    it('queues nothing below the configured severity', async () => {
      await ctx.container.opsLog.record(tenantA, {
        code: 'system.ping',
        severity: 'INFO',
        message: 'ping',
        dedupeKey: 'ping:1',
      });
      expect(await ctx.container.notifications.list(tenantA, owner)).toHaveLength(0);
    });

    it('queues nothing while the feature is off', async () => {
      await ctx.container.featureFlags.set(tenantA, owner, {
        key: 'ops_notifications',
        enabled: false,
        expectedVersion: 1,
        idempotencyKey: `off-${Date.now()}`,
        confirmKey: 'ops_notifications',
        reason: 'Silencing for the test.',
      });

      await raiseError();
      expect(await ctx.container.notifications.list(tenantA, owner)).toHaveLength(0);
    });

    it('queues again when a resolved condition recurs', async () => {
      await raiseError();
      await ctx.container.opsLog.record(tenantA, {
        code: 'panel.reachable',
        severity: 'INFO',
        message: 'Back.',
        recoversCode: 'panel.unreachable',
      });
      await raiseError();

      // Two intents: the original failure and its return. A rule that notified
      // only on new rows would miss the second, which is the one an operator
      // most needs.
      expect(await ctx.container.notifications.list(tenantA, owner)).toHaveLength(2);
    });
  });

  describe('the event and its notification commit together', () => {
    it('leaves neither behind when the enclosing transaction rolls back', async () => {
      // Without this, a process that dies between the two loses the alert
      // permanently: the condition's next occurrence is a repeat rather than a
      // new one, so nothing would announce it until it resolved and came back.
      await expect(
        ctx.container.uow.run(tenantA, async (tx) => {
          await ctx.container.opsLog.record(
            tenantA,
            {
              code: 'panel.unreachable',
              severity: 'ERROR',
              message: 'The panel did not answer.',
              dedupeKey: 'atomic:1',
            },
            tx,
          );
          throw new Error('the caller failed after recording');
        }),
      ).rejects.toThrow('the caller failed after recording');

      expect(await ctx.container.opsLogService.list(tenantA, owner, { limit: 50 })).toHaveLength(0);
      expect(await ctx.container.notifications.list(tenantA, owner)).toHaveLength(0);
    });

    it('keeps the event when the projection itself fails', async () => {
      // The event is the authoritative record and the notification is a
      // projection of it. Where both cannot be committed, the projection is the
      // half to lose — never the other way round.
      const real = ctx.container.notifications.queue.bind(ctx.container.notifications);
      ctx.container.notifications.queue = () => {
        throw new Error('the queue is broken');
      };
      try {
        const recorded = await raiseError('projection-fails');
        expect(recorded.isNew).toBe(true);
      } finally {
        ctx.container.notifications.queue = real;
      }

      const events = await ctx.container.opsLogService.list(tenantA, owner, { limit: 50 });
      expect(events.map((event) => event.code)).toContain('panel.unreachable');
      expect(await ctx.container.notifications.list(tenantA, owner)).toHaveLength(0);
    });
  });

  describe('the dispatcher', () => {
    it('sends a pending intent and records the attempt', async () => {
      await raiseError();

      const result = await ctx.container.notificationDispatcher.tick();
      expect(result).toMatchObject({ claimed: 1, sent: 1 });
      expect(transport.messages).toHaveLength(1);

      const [intent] = await ctx.container.notifications.list(tenantA, owner);
      const detail = await ctx.container.notifications.get(tenantA, owner, intent!.id);

      expect(detail.intent.status).toBe('SENT');
      expect(detail.intent.completedAt).not.toBeNull();
      expect(detail.attempts).toHaveLength(1);
      expect(detail.attempts[0]).toMatchObject({
        attemptNumber: 1,
        outcome: 'SUCCEEDED',
        errorCode: null,
      });
    });

    it('renders the tenant’s override rather than the default', async () => {
      await ctx.container.templatesService.set(tenantA, owner, {
        key: 'ops.notification.operational_event',
        body: 'هشدار {severity}: {code} — {message}',
        expectedVersion: null,
        idempotencyKey: `tpl-${Date.now()}`,
      });

      await raiseError();
      await ctx.container.notificationDispatcher.tick();

      expect(transport.messages[0]?.text).toBe(
        'هشدار ERROR: panel.unreachable — The panel did not answer.',
      );
    });

    it('escapes an interpolated value in an HTML template', async () => {
      // The body's markup is the administrator's and is the point of the
      // format; an event message containing `<` must not be able to close a tag
      // and lose the notification that exists to report the failure.
      await ctx.container.opsLog.record(tenantA, {
        code: 'panel.unreachable',
        severity: 'ERROR',
        message: 'panel <b>down</b>',
        dedupeKey: 'html:1',
      });
      await ctx.container.notificationDispatcher.tick();

      expect(transport.messages[0]?.text).toContain('&lt;b&gt;down&lt;/b&gt;');
      expect(transport.messages[0]?.html).toBe(true);
    });

    it('retries a retryable failure without creating a second notification', async () => {
      await raiseError();
      transport.failNextWith({
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'telegram.rate_limited',
        errorMessage: 'Too Many Requests',
        retryAfterMs: 0,
      });

      const first = await ctx.container.notificationDispatcher.tick();
      expect(first).toMatchObject({ sent: 0, failed: 1 });

      const [intent] = await ctx.container.notifications.list(tenantA, owner);
      let detail = await ctx.container.notifications.get(tenantA, owner, intent!.id);
      expect(detail.intent.status).toBe('PENDING');
      expect(detail.attempts).toHaveLength(1);
      expect(detail.attempts[0]?.retryAfterMs).toBe(0);

      // The retry succeeds. One intent throughout, two attempts.
      const second = await ctx.container.notificationDispatcher.tick();
      expect(second).toMatchObject({ sent: 1 });

      expect(await ctx.container.notifications.list(tenantA, owner)).toHaveLength(1);
      detail = await ctx.container.notifications.get(tenantA, owner, intent!.id);
      expect(detail.intent.status).toBe('SENT');
      expect(detail.attempts.map((a) => a.attemptNumber)).toEqual([1, 2]);
    });

    it('abandons a permanently rejected send on the first attempt', async () => {
      // A wrong chat id does not become right by being retried. The legacy log
      // group's sixty identical errors are what happens without this.
      await raiseError();
      transport.failNextWith({
        outcome: 'FAILED_PERMANENT',
        errorCode: 'telegram.rejected.400',
        errorMessage: 'chat not found',
      });

      const result = await ctx.container.notificationDispatcher.tick();
      expect(result).toMatchObject({ abandoned: 1 });

      const [intent] = await ctx.container.notifications.list(tenantA, owner);
      const detail = await ctx.container.notifications.get(tenantA, owner, intent!.id);
      expect(detail.intent.status).toBe('FAILED');
      expect(detail.attempts).toHaveLength(1);
      expect(detail.attempts[0]?.errorCode).toBe('telegram.rejected.400');
    });

    it('stops after the configured number of attempts', async () => {
      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'ops.notifications.max_attempts',
        value: 2,
        expectedVersion: null,
        idempotencyKey: `max-${Date.now()}`,
      });
      await raiseError();

      const fail = () =>
        transport.failNextWith({
          outcome: 'FAILED_RETRYABLE',
          errorCode: 'telegram.unreachable',
          errorMessage: 'socket hang up',
          retryAfterMs: 0,
        });

      fail();
      await ctx.container.notificationDispatcher.tick();
      fail();
      await ctx.container.notificationDispatcher.tick();

      const [intent] = await ctx.container.notifications.list(tenantA, owner);
      const detail = await ctx.container.notifications.get(tenantA, owner, intent!.id);

      expect(detail.intent.status).toBe('FAILED');
      expect(detail.attempts).toHaveLength(2);

      // And a further tick finds nothing: an abandoned intent is not retried
      // forever, and it is not silently deleted either.
      expect(await ctx.container.notificationDispatcher.tick()).toMatchObject({ claimed: 0 });
    });

    it('does not claim an intent whose back-off has not elapsed', async () => {
      await raiseError();
      transport.failNextWith({
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'telegram.unreachable',
        errorMessage: 'socket hang up',
        // No retry_after: the dispatcher's own exponential back-off applies,
        // which is seconds rather than zero.
      });

      await ctx.container.notificationDispatcher.tick();
      expect(await ctx.container.notificationDispatcher.tick()).toMatchObject({ claimed: 0 });
    });

    it('does not let one undeliverable intent stall the batch', async () => {
      // A PENDING row can outlive the template key it names, across a release
      // that removes one from the frozen catalogue. Without a per-intent catch
      // that throw aborts the loop, and every intent behind it is left leased
      // with its counter incremented and no attempt row — climbing forever,
      // delivering nothing.
      await raiseError('good:1');
      await ctx.container.database.db.execute(
        `INSERT INTO notifications
           (id, tenant_id, kind, dedupe_key, destination, payload, template_key, max_attempts, next_attempt_at)
         VALUES ('${ctx.container.ids.uuid()}', '${tenantA.tenantId}', 'OPERATIONAL_EVENT', 'poison',
                 '{"transport":"RECORDING"}', '{}', 'bot.no_such_key', 5, now() - interval '1 second')` as never,
      );

      const result = await ctx.container.notificationDispatcher.tick();
      expect(result.claimed).toBe(2);
      // The good one still went out.
      expect(transport.messages).toHaveLength(1);

      const all = await ctx.container.notifications.list(tenantA, owner);
      const poison = all.find((n) => n.templateKey === 'bot.no_such_key');
      expect(poison?.status).toBe('FAILED');

      const detail = await ctx.container.notifications.get(tenantA, owner, poison!.id);
      expect(detail.attempts).toHaveLength(1);
      expect(detail.attempts[0]?.outcome).toBe('FAILED_PERMANENT');

      // And it is not claimed again.
      expect(await ctx.container.notificationDispatcher.tick()).toMatchObject({ claimed: 0 });
    });

    it('does not charge an unrenderable intent to the rate ceiling', async () => {
      // The ceiling is a courtesy to Telegram. An intent that failed to render
      // never touched the network, so spending the minute's budget on it would
      // delay the messages that CAN be sent.
      //
      // The first version of this guard tested `intent.status === 'PENDING'`,
      // which is the claim's own predicate and therefore always true: a guard
      // that did nothing, under a comment saying it did.
      //
      // Its own dispatcher, because the window is a counter in the instance's
      // memory and nothing resets it — the container's dispatcher has already
      // spent budget in earlier tests in this file. That is a real property of
      // the design (ADR-0018 says the window is per process), not a test
      // artefact, so the test works with it rather than reaching for a
      // production reset method that exists only for tests.
      const dispatcher = new NotificationDispatcher(
        ctx.container.notificationRepository,
        transport,
        ctx.container.templateResolver,
        ctx.container.settingsResolver,
        ctx.container.clock,
        ctx.container.ids,
        ctx.container.logger,
        {
          pollIntervalMs: 1000,
          batchSize: 10,
          leaseMs: 120_000,
          baseBackoffMs: 5_000,
          maxBackoffMs: 300_000,
        },
      );
      dispatcher.setRateLimitScope(tenantA);

      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'ops.notifications.max_per_minute',
        value: 2,
        expectedVersion: null,
        idempotencyKey: `rate-${Date.now()}`,
      });

      await raiseError('renders:1');
      await ctx.container.database.db.execute(
        `INSERT INTO notifications
           (id, tenant_id, kind, dedupe_key, destination, payload, template_key, max_attempts, next_attempt_at)
         VALUES ('${ctx.container.ids.uuid()}', '${tenantA.tenantId}', 'OPERATIONAL_EVENT', 'unrenderable',
                 '{"transport":"RECORDING"}', '{}', 'bot.no_such_key', 5, now() - interval '1 second')` as never,
      );

      const first = await dispatcher.tick();
      expect(first.claimed).toBe(2);
      expect(first.sent).toBe(1);

      // One of the two spent budget, so one remains this minute. Against the
      // no-op guard both would have counted and this tick would claim nothing.
      await raiseError('renders:2');
      const second = await dispatcher.tick();
      expect(second.claimed).toBe(1);
      expect(second.sent).toBe(1);
    });

    it('stops claiming an intent that has spent its attempts', async () => {
      // The backstop for the case above: abandonment normally happens in
      // `recordAttempt`, which is the code that does not run when a dispatch
      // throws before reaching it.
      await raiseError('spent:1');
      const [intent] = await ctx.container.notifications.list(tenantA, owner);
      await ctx.container.database.db.execute(
        `UPDATE notifications SET attempt_count = max_attempts, next_attempt_at = now() - interval '1 second'
         WHERE id = '${intent!.id}'` as never,
      );

      expect(await ctx.container.notificationDispatcher.tick()).toMatchObject({ claimed: 0 });
    });

    it('cannot be revived by an attempt that outlived its lease', async () => {
      // The lease exists so a stalled sender's work becomes available again. A
      // dispatcher that then returns and writes its outcome unconditionally
      // would put an intent a second dispatcher has already marked SENT back
      // into PENDING — and the same message would go out again, on a schedule.
      await raiseError();
      await ctx.container.notificationDispatcher.tick();

      const [intent] = await ctx.container.notifications.list(tenantA, owner);
      const before = await ctx.container.notifications.get(tenantA, owner, intent!.id);
      expect(before.intent.status).toBe('SENT');

      // The straggler, writing a retryable outcome long after the fact.
      await ctx.container.notificationRepository.recordAttempt({
        attemptId: ctx.container.ids.uuid(),
        tenantId: tenantA.tenantId,
        notificationId: intent!.id,
        attemptNumber: 99,
        transport: 'RECORDING',
        outcome: 'FAILED_RETRYABLE',
        startedAt: new Date(),
        finishedAt: new Date(),
        errorCode: 'telegram.unreachable',
        errorMessage: 'late',
        retryAfterMs: null,
        nextStatus: 'PENDING',
        nextAttemptAt: new Date(0),
      });

      const after = await ctx.container.notifications.get(tenantA, owner, intent!.id);
      // The attempt is recorded, because it happened. The intent does not move.
      expect(after.attempts).toHaveLength(2);
      expect(after.intent.status).toBe('SENT');
      expect(await ctx.container.notificationDispatcher.tick()).toMatchObject({ claimed: 0 });
    });

    it('never sends one tenant’s notification to another', async () => {
      const ownerB = adminActorFor(
        await createAdmin(ctx.container, tenantB, { username: 'owner-b', roleKeys: ['owner'] }),
      );
      await configure(tenantB, ownerB);

      await raiseError('shared', tenantA);
      await raiseError('shared', tenantB);

      // Two intents with the SAME dedupe key, one per tenant: the unique index
      // is scoped, so neither tenant can suppress the other's alert by
      // colliding with it.
      expect(await ctx.container.notifications.list(tenantA, owner)).toHaveLength(1);
      expect(await ctx.container.notifications.list(tenantB, ownerB)).toHaveLength(1);

      await ctx.container.notificationDispatcher.tick();
      expect(transport.messages).toHaveLength(2);

      // And neither tenant can read the other's, however many exist.
      const a = await ctx.container.notifications.list(tenantA, owner);
      await expect(
        ctx.container.notifications.get(tenantB, ownerB, a[0]!.id),
      ).rejects.toMatchObject({ kind: 'NOT_FOUND' });
    });
  });
});
