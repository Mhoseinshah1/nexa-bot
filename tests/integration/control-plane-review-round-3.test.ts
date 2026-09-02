import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { ActorContext } from '@nexa/contracts';
import {
  auditLogs,
  notifications,
  outboxMessages,
  settingValues,
  templateOverrides,
} from '../../apps/api/src/infrastructure/persistence/schema';
import type { RecordingTransport } from '../../apps/api/src/modules/control/notifications/infrastructure/recording-transport';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * What a third round of review found missing rather than wrong.
 *
 * Every case here is one an existing test could not have caught: deleting the
 * audit and outbox writes from all eight control-plane commands left the whole
 * suite green, the revert-versus-set race was translated by code no test
 * executed, and a setting whose stored value stopped parsing could not be
 * repaired through any surface — with nothing asserting either way.
 */
describe('control plane, third review round', () => {
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
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const db = () => ctx.container.database.db;
  const auditFor = (action: string) =>
    db().select().from(auditLogs).where(eq(auditLogs.action, action));
  const eventsOfType = (eventType: string) =>
    db().select().from(outboxMessages).where(eq(outboxMessages.eventType, eventType));

  const setSetting = (value: unknown, expectedVersion: number | null) =>
    ctx.container.settingsService.set(tenantA, owner, {
      key: 'ops.notifications.max_attempts',
      value,
      expectedVersion,
      idempotencyKey: `set-${Math.random()}`,
    });

  const setTemplate = (body: string, expectedVersion: number | null) =>
    ctx.container.templatesService.set(tenantA, owner, {
      key: 'bot.ping.reply',
      body,
      expectedVersion,
      idempotencyKey: `tpl-${Math.random()}`,
    });

  // -------------------------------------------------------------------------

  describe('every write leaves a record of itself', () => {
    /**
     * The gap this closes is embarrassing and worth stating plainly: all eight
     * control-plane commands wrote an audit row and an outbox event inside
     * their transaction, and NOTHING asserted it. Deleting every one of those
     * sixteen calls left the entire suite green — so the rule the whole
     * architecture is built around was, in test terms, optional.
     */
    it('records a setting change in the audit log and the outbox, with values not references', async () => {
      await setSetting(3, null);

      const [audit] = await auditFor('settings.set');
      expect(audit?.entityType).toBe('Setting');
      expect(audit?.entityId).toBe('ops.notifications.max_attempts');
      expect(audit?.result).toBe('SUCCESS');
      // VALUES. A record that means something after the row changes again is
      // the difference between this and `/admin/logs`, whose free-text Persian
      // sentence carries neither a before nor an after.
      expect(audit?.before).toMatchObject({ value: 5, source: 'DEFAULT' });
      expect(audit?.after).toMatchObject({ value: 3, source: 'TENANT' });

      const [event] = await eventsOfType('SettingChanged');
      expect(event?.aggregateType).toBe('Setting');
      expect(event?.aggregateId).toBe('ops.notifications.max_attempts');
      expect(event?.payload).toMatchObject({ from: 5, to: 3 });
    });

    it('records a template set and a template revert', async () => {
      await setTemplate('سلام {correlationId}', null);
      expect(await auditFor('templates.set')).toHaveLength(1);
      expect(await eventsOfType('TemplateOverrideChanged')).toHaveLength(1);

      const [override] = await db()
        .select()
        .from(templateOverrides)
        .where(eq(templateOverrides.tenantId, SEED_IDS.tenantA));

      await ctx.container.templatesService.revert(tenantA, owner, {
        key: 'bot.ping.reply',
        expectedVersion: override!.version,
        idempotencyKey: `rev-${Math.random()}`,
      });
      expect(await auditFor('templates.revert')).toHaveLength(1);
      expect(await eventsOfType('TemplateOverrideReverted')).toHaveLength(1);
    });

    it('records a feature-flag change', async () => {
      await ctx.container.featureFlags.set(tenantA, owner, {
        key: 'ops_notifications',
        enabled: true,
        expectedVersion: null,
        idempotencyKey: `flag-${Math.random()}`,
        confirmKey: 'ops_notifications',
        reason: 'Turning notifications on for this test.',
      });

      const [audit] = await auditFor('features.set');
      expect(audit?.entityId).toBe('ops_notifications');
      expect(audit?.after).toMatchObject({ enabled: true, source: 'TENANT' });
      // The reason is part of the record, in its own column. A TENANT_WIDE
      // toggle that says only WHAT changed and never WHY is the legacy
      // capability screen.
      expect(audit?.reason).toBe('Turning notifications on for this test.');
      expect(await eventsOfType('FeatureFlagChanged')).toHaveLength(1);
    });

    it('records a refused write as DENIED and writes no event', async () => {
      const observer = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'observer',
          roleKeys: ['observer'],
        }),
      );

      await expect(
        ctx.container.settingsService.set(tenantA, observer, {
          key: 'ops.notifications.max_attempts',
          value: 3,
          expectedVersion: null,
          idempotencyKey: `denied-${Math.random()}`,
        }),
      ).rejects.toMatchObject({ code: 'platform.permission_denied' });

      const rows = await auditFor('settings.set');
      expect(rows.map((row) => row.result)).toEqual(['DENIED']);
      // A denial is a record, not an event. Nothing happened to project.
      expect(await eventsOfType('SettingChanged')).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------

  describe('a setting whose stored value no longer parses', () => {
    /**
     * The trap: the resolver reported `version: null` for such a row because
     * the DEFAULT was in force. A surface then submitted `expectedVersion:
     * null`, the repository took its first-write branch, the insert conflicted
     * with the row that had been there all along, and the answer was
     * `control.version_conflict` — for ever, because reloading returned null
     * again. The key was unwritable through any surface with no recovery that
     * did not involve a database client.
     */
    const corrupt = async () =>
      ctx.container.database.withClient((client) =>
        client.query(
          `UPDATE setting_values SET value = '999'::jsonb
             WHERE tenant_id = $1 AND setting_key = 'ops.notifications.max_attempts'`,
          [SEED_IDS.tenantA],
        ),
      );

    it('reports the default in force, and still reports the row it must overwrite', async () => {
      await setSetting(3, null);
      await corrupt();

      const resolved = await ctx.container.settingsService.get(
        tenantA,
        owner,
        'ops.notifications.max_attempts',
      );
      expect(resolved.value).toBe(5); // the default
      expect(resolved.source).toBe('DEFAULT');
      expect(resolved.storedValueInvalid).toBe(true);
      // The row's own version, which is what a repair has to state.
      expect(resolved.version).toBe(1);
    });

    it('is repaired by an ordinary write, using the version the read reported', async () => {
      await setSetting(3, null);
      await corrupt();

      const read = await ctx.container.settingsService.get(
        tenantA,
        owner,
        'ops.notifications.max_attempts',
      );
      const result = await setSetting(4, read.version);

      expect(result.changed).toBe(true);
      expect(result.setting.value).toBe(4);
      expect(result.setting.source).toBe('TENANT');
      expect(result.setting.storedValueInvalid).toBe(false);
    });

    it('says so out loud rather than ignoring the value silently', async () => {
      await setSetting(3, null);
      await corrupt();
      await ctx.container.settingsService.get(tenantA, owner, 'ops.notifications.max_attempts');

      const events = await ctx.container.opsLogService.list(tenantA, owner, {});
      expect(events.map((event) => event.code)).toContain('settings.stored_value_invalid');
    });
  });

  // -------------------------------------------------------------------------

  describe('two writers on one template', () => {
    /**
     * `appendRevision` translates a unique violation on `(tenant, key, locale,
     * revision)` into `control.version_conflict`, so a revert racing a set gets
     * the same answer as any other stale write. No test executed that
     * translation, which made it a claim rather than a behaviour.
     */
    it('answers a duplicate revision with a version conflict, not a driver error', async () => {
      await setTemplate('اول {correlationId}', null);

      // Revision 1 is taken. Claiming it again is what a revert racing a set
      // arrives at, and the interesting part is the ANSWER: without the
      // translation the caller gets a Postgres 23505 where everything else in
      // this module answers `control.version_conflict`, so one situation would
      // have had two shapes depending on which statement noticed it.
      await expect(
        ctx.container.templateRepository.appendRevision(tenantA, {
          id: '01900000-0000-7000-8000-00000000f001',
          key: 'bot.ping.reply',
          locale: 'fa',
          revision: 1,
          action: 'REVERT',
          body: null,
          now: new Date(),
          adminId: null,
        }),
      ).rejects.toMatchObject({ code: 'control.version_conflict' });
    });
  });

  // -------------------------------------------------------------------------

  describe('reads are guarded too', () => {
    /**
     * Every write path had a 403 test and no read path did — so a GET could
     * have lost its guard entirely and the suite would have said nothing. UI
     * hiding is not authorization; these are the endpoints behind the screens
     * that are hidden.
     */
    let stranger: ActorContext;

    beforeEach(async () => {
      stranger = adminActorFor(
        await createAdmin(ctx.container, tenantA, { username: 'nobody', roleKeys: [] }),
      );
    });

    it('refuses a settings read', async () => {
      await expect(ctx.container.settingsService.list(tenantA, stranger)).rejects.toMatchObject({
        code: 'platform.permission_denied',
      });
    });

    it('refuses a feature-flag read', async () => {
      await expect(ctx.container.featureFlags.list(tenantA, stranger)).rejects.toMatchObject({
        code: 'platform.permission_denied',
      });
    });

    it('refuses a template read and a revision history read', async () => {
      await expect(ctx.container.templatesService.list(tenantA, stranger)).rejects.toMatchObject({
        code: 'platform.permission_denied',
      });
      await expect(
        ctx.container.templatesService.revisions(tenantA, stranger, 'bot.ping.reply'),
      ).rejects.toMatchObject({ code: 'platform.permission_denied' });
    });

    it('refuses an operational-log read and a notification read', async () => {
      await expect(ctx.container.opsLogService.list(tenantA, stranger, {})).rejects.toMatchObject({
        code: 'platform.permission_denied',
      });
      await expect(ctx.container.notifications.list(tenantA, stranger)).rejects.toMatchObject({
        code: 'platform.permission_denied',
      });
    });
  });

  // -------------------------------------------------------------------------

  describe('a preview with typed sample values', () => {
    const sample = {
      severity: 'ERROR',
      code: 'panel.unreachable',
      message: 'The panel did not answer.',
    };

    it('accepts a number typed into a text field', async () => {
      const result = await ctx.container.templatesService.preview(tenantA, owner, {
        key: 'ops.notification.operational_event',
        body: '{severity}: {code} — {message} — {occurrences} بار',
        values: { ...sample, occurrences: '3' },
      });
      expect(result.rendered).toContain('panel.unreachable');
      expect(result.rendered).not.toContain('{occurrences}');
    });

    it('names the token and the form when a sample does not fit its type', async () => {
      await expect(
        ctx.container.templatesService.preview(tenantA, owner, {
          key: 'ops.notification.operational_event',
          body: '{severity}: {code} — {message} — {occurrences} بار',
          values: { ...sample, occurrences: 'three' },
        }),
      ).rejects.toMatchObject({
        code: 'control.invalid_value',
        details: { issues: [expect.stringContaining('{occurrences}')] },
      });
    });

    it('leaves an unsupplied placeholder in the body and reports it', async () => {
      const result = await ctx.container.templatesService.preview(tenantA, owner, {
        key: 'ops.notification.operational_event',
        body: '{severity}: {code} — {message} — {occurrences} بار',
        values: sample,
      });
      expect(result.rendered).toContain('{occurrences}');
      expect(result.unresolved).toContain('occurrences');
    });
  });

  // -------------------------------------------------------------------------

  describe('a notification that has spent its attempts', () => {
    beforeEach(async () => {
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
        reason: 'Test setup.',
      });
      await ctx.container.opsLog.record(tenantA, {
        code: 'panel.unreachable',
        severity: 'ERROR',
        message: 'The panel did not answer.',
        dedupeKey: 'panel:1',
      });
    });

    /**
     * The gap between two correct rules. `claimDue` refuses an intent that has
     * spent its attempts — otherwise it would be claimed for ever — and
     * `recordAttempt` is what normally moves it to FAILED, which is exactly the
     * code that does not run when a dispatch throws before it. Between them, a
     * row could sit PENDING for ever: never claimed, never failed, and never
     * appearing in any list of things that went wrong. Silence is the one
     * outcome this subsystem may not produce.
     */
    it('is swept to FAILED rather than sitting PENDING for ever', async () => {
      const [intent] = await ctx.container.notifications.list(tenantA, owner);

      // The state a throw between the claim and the record leaves behind.
      await ctx.container.database.withClient((client) =>
        client.query(
          `UPDATE notifications
              SET attempt_count = max_attempts, next_attempt_at = now() - interval '1 minute'
            WHERE id = $1`,
          [intent!.id],
        ),
      );

      const result = await ctx.container.notificationDispatcher.tick();
      expect(result.exhausted).toBe(1);
      expect(result.claimed).toBe(0);

      const detail = await ctx.container.notifications.get(tenantA, owner, intent!.id);
      expect(detail.intent.status).toBe('FAILED');
    });

    it('is not swept while a dispatcher still holds its lease', async () => {
      const [intent] = await ctx.container.notifications.list(tenantA, owner);
      await ctx.container.database.withClient((client) =>
        client.query(
          `UPDATE notifications
              SET attempt_count = max_attempts, next_attempt_at = now() + interval '5 minutes'
            WHERE id = $1`,
          [intent!.id],
        ),
      );

      const result = await ctx.container.notificationDispatcher.tick();
      expect(result.exhausted).toBe(0);
      expect(
        (await ctx.container.notifications.get(tenantA, owner, intent!.id)).intent.status,
      ).toBe('PENDING');
    });

    /**
     * A transport that RAISES is a transport failure, not an unknown one.
     * Letting it reach the batch's catch meant guessing, and the guess was
     * permanent failure — so one refused connection ended an intent that had
     * four attempts left, and a throw after a successful send would have filed
     * a delivered message as failed.
     */
    it('retries a transport that throws instead of ending the intent', async () => {
      transport.throwNextWith(new Error('socket hang up'));

      const result = await ctx.container.notificationDispatcher.tick();
      expect(result).toMatchObject({ sent: 0, failed: 1, unrecorded: 0 });

      const [intent] = await ctx.container.notifications.list(tenantA, owner);
      const detail = await ctx.container.notifications.get(tenantA, owner, intent!.id);
      expect(detail.intent.status).toBe('PENDING');
      expect(detail.attempts).toHaveLength(1);
      expect(detail.attempts[0]?.outcome).toBe('FAILED_RETRYABLE');
      expect(detail.attempts[0]?.errorCode).toBe('notification.transport_threw');
    });
  });

  // -------------------------------------------------------------------------

  describe('the test send', () => {
    beforeEach(async () => {
      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'ops.notifications.telegram_chat_id',
        value: '-100999',
        expectedVersion: null,
        idempotencyKey: `chat-${Math.random()}`,
      });
    });

    it('answers a replay with the same intent and says it replayed', async () => {
      const key = `test-${Math.random()}`;
      const first = await ctx.container.notifications.sendTest(tenantA, owner, {
        idempotencyKey: key,
      });
      const second = await ctx.container.notifications.sendTest(tenantA, owner, {
        idempotencyKey: key,
      });

      expect(first).toMatchObject({ created: true, replayed: false });
      expect(second).toMatchObject({ created: false, replayed: true });
      expect(second.intent.id).toBe(first.intent.id);
      expect(
        await db().select().from(notifications).where(eq(notifications.kind, 'OPERATIONS_TEST')),
      ).toHaveLength(1);
    });

    it('queues one message for two simultaneous presses of one key', async () => {
      // `find` runs before the work and cannot see a request that has not
      // committed, so both of these get past it. The insert of the idempotency
      // record is where they meet, and the loser abandons its transaction
      // rather than committing a second message beside the winner's.
      const key = `race-${Math.random()}`;
      const results = await Promise.allSettled([
        ctx.container.notifications.sendTest(tenantA, owner, { idempotencyKey: key }),
        ctx.container.notifications.sendTest(tenantA, owner, { idempotencyKey: key }),
      ]);

      const queued = await db()
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.tenantId, SEED_IDS.tenantA),
            eq(notifications.kind, 'OPERATIONS_TEST'),
          ),
        );
      expect(queued).toHaveLength(1);

      // Whichever way the two interleave, at most one call may claim to have
      // created something. The other either replays or loses the key; both are
      // coherent answers and 'created twice' is not.
      const created = results.filter(
        (result) => result.status === 'fulfilled' && result.value.created,
      );
      expect(created).toHaveLength(1);
    });

    it('refuses when its record names an intent that no longer exists', async () => {
      // Nothing in this system deletes a notification, so this is corruption
      // rather than an ordinary miss — and falling through to create a new one
      // would invert the whole mechanism, making N replays send N messages.
      const key = `orphan-${Math.random()}`;
      const first = await ctx.container.notifications.sendTest(tenantA, owner, {
        idempotencyKey: key,
      });
      await ctx.container.database.withClient((client) =>
        client.query(`DELETE FROM notifications WHERE id = $1`, [first.intent.id]),
      );

      await expect(
        ctx.container.notifications.sendTest(tenantA, owner, { idempotencyKey: key }),
      ).rejects.toMatchObject({ code: 'control.notification_not_found' });
    });
  });

  // -------------------------------------------------------------------------

  describe('one idempotency key is one command', () => {
    it('lets exactly one of two simultaneous setting writes win', async () => {
      const key = `concurrent-${Math.random()}`;
      const write = () =>
        ctx.container.settingsService.set(tenantA, owner, {
          key: 'ops.notifications.max_attempts',
          value: 4,
          expectedVersion: null,
          idempotencyKey: key,
        });

      const results = await Promise.allSettled([write(), write()]);
      // One write, whichever order the two take: the second either loses the
      // version predicate, loses the key, or replays. None of those is a second
      // change.
      const changed = results.filter(
        (result) => result.status === 'fulfilled' && result.value.changed && !result.value.replayed,
      );
      expect(changed).toHaveLength(1);

      const rows = await db()
        .select()
        .from(settingValues)
        .where(eq(settingValues.settingKey, 'ops.notifications.max_attempts'));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.version).toBe(1);
    });
  });
});

/**
 * What the Codex review found that the three rounds before it did not.
 *
 * Kept in its own describe because the origin matters: each of these is a race
 * or an expectation semantics question that reads correct line by line, which
 * is exactly the class three human-shaped reviews had already walked past.
 */
describe('control plane, Codex round', () => {
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
  });

  afterAll(async () => {
    await ctx?.close();
  });

  describe('a write states the state it was built on, even when it changes nothing', () => {
    /**
     * The no-op shortcut RETURNS without executing the conditional update, so
     * the predicate that normally decides the question never ran. A request
     * built on state that had since moved was therefore accepted as "no change"
     * whenever its value happened to coincide with what was there — telling a
     * caller who believed the key was unset that their expectation held.
     */
    it('refuses a settings no-op whose expectation is stale', async () => {
      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'ops.notifications.max_attempts',
        value: 3,
        expectedVersion: null,
        idempotencyKey: `first-${Math.random()}`,
      });

      // Same value, and an expectation that says "I read this as unset".
      await expect(
        ctx.container.settingsService.set(tenantA, owner, {
          key: 'ops.notifications.max_attempts',
          value: 3,
          expectedVersion: null,
          idempotencyKey: `stale-${Math.random()}`,
        }),
      ).rejects.toMatchObject({ code: 'control.version_conflict' });
    });

    it('still accepts a no-op whose expectation is current, and says it changed nothing', async () => {
      const first = await ctx.container.settingsService.set(tenantA, owner, {
        key: 'ops.notifications.max_attempts',
        value: 3,
        expectedVersion: null,
        idempotencyKey: `first-${Math.random()}`,
      });

      const second = await ctx.container.settingsService.set(tenantA, owner, {
        key: 'ops.notifications.max_attempts',
        value: 3,
        expectedVersion: first.setting.version,
        idempotencyKey: `noop-${Math.random()}`,
      });
      expect(second.changed).toBe(false);
      expect(second.setting.version).toBe(first.setting.version);
    });

    it('refuses a template no-op whose expectation is stale', async () => {
      await ctx.container.templatesService.set(tenantA, owner, {
        key: 'bot.ping.reply',
        body: 'سلام {correlationId}',
        expectedVersion: null,
        idempotencyKey: `tpl-${Math.random()}`,
      });

      await expect(
        ctx.container.templatesService.set(tenantA, owner, {
          key: 'bot.ping.reply',
          body: 'سلام {correlationId}',
          expectedVersion: null,
          idempotencyKey: `tpl-stale-${Math.random()}`,
        }),
      ).rejects.toMatchObject({ code: 'control.version_conflict' });
    });
  });

  describe('a flag reason is part of the request', () => {
    it('rejects a key reused with a different reason instead of replaying', async () => {
      const key = `flag-${Math.random()}`;
      const toggle = (reason: string) =>
        ctx.container.featureFlags.set(tenantA, owner, {
          key: 'ops_notifications',
          enabled: true,
          expectedVersion: null,
          idempotencyKey: key,
          confirmKey: 'ops_notifications',
          reason,
        });

      await toggle('Turning it on for the pilot tenant.');

      // The reason is persisted and audited. Omitting it from the hash made
      // this look like the same request, so the API answered success for a
      // reason it never stored.
      await expect(toggle('Something else entirely.')).rejects.toMatchObject({
        code: 'platform.idempotency_payload_mismatch',
      });
    });
  });

  describe('an attempt that outlived its lease', () => {
    beforeEach(async () => {
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
        reason: 'Test setup.',
      });
      await ctx.container.opsLog.record(tenantA, {
        code: 'panel.unreachable',
        severity: 'ERROR',
        message: 'The panel did not answer.',
        dedupeKey: 'panel:1',
      });
    });

    /**
     * PENDING alone was not enough. Attempt 1 could return RETRYABLE after
     * attempt 2 had claimed the row, replace attempt 2's lease with a short
     * back-off, and let attempt 3 start alongside it — after which attempt 3
     * could mark the intent FAILED while attempt 2's send was succeeding.
     *
     * `attempt_count` is the claim's identity, so a stale writer's status
     * update matches nothing.
     */
    it('cannot move an intent a later attempt has claimed', async () => {
      const [intent] = await ctx.container.notifications.list(tenantA, owner);
      const before = await ctx.container.notifications.get(tenantA, owner, intent!.id);

      // The row as a later claim leaves it: attempt 2 in flight, its lease in
      // the future.
      await ctx.container.database.withClient((client) =>
        client.query(
          `UPDATE notifications
              SET attempt_count = 2, next_attempt_at = now() + interval '5 minutes'
            WHERE id = $1`,
          [intent!.id],
        ),
      );

      // Attempt 1, arriving late with a retryable failure.
      const { moved } = await ctx.container.notificationRepository.recordAttempt({
        attemptId: '01900000-0000-7000-8000-0000000fa001',
        tenantId: SEED_IDS.tenantA,
        notificationId: intent!.id,
        attemptNumber: 1,
        transport: 'RECORDING',
        outcome: 'FAILED_RETRYABLE',
        startedAt: new Date(),
        finishedAt: new Date(),
        errorCode: 'telegram.unreachable',
        errorMessage: 'socket hang up',
        retryAfterMs: 0,
        nextStatus: 'PENDING',
        nextAttemptAt: new Date(),
      });

      expect(moved).toBe(false);

      // Attempt 2's lease is untouched, so attempt 3 cannot start beside it.
      const after = await ctx.container.database.db
        .select()
        .from(notifications)
        .where(eq(notifications.id, intent!.id));
      expect(after[0]!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 60_000);

      // The attempt row is written either way, because it happened.
      const detail = await ctx.container.notifications.get(tenantA, owner, intent!.id);
      expect(detail.attempts.length).toBe(before.attempts.length + 1);
    });

    it('lets a late SUCCESS end the intent, because delivery is terminal truth', async () => {
      const [intent] = await ctx.container.notifications.list(tenantA, owner);
      await ctx.container.database.withClient((client) =>
        client.query(
          `UPDATE notifications
              SET attempt_count = 2, next_attempt_at = now() + interval '5 minutes'
            WHERE id = $1`,
          [intent!.id],
        ),
      );

      // Attempt 1's send landed, late. Recording it as SENT stops attempt 3
      // sending the same message again, and costs nothing: an intent that has
      // been delivered has nothing left to do.
      const { moved } = await ctx.container.notificationRepository.recordAttempt({
        attemptId: '01900000-0000-7000-8000-0000000fa002',
        tenantId: SEED_IDS.tenantA,
        notificationId: intent!.id,
        attemptNumber: 1,
        transport: 'RECORDING',
        outcome: 'SUCCEEDED',
        startedAt: new Date(),
        finishedAt: new Date(),
        errorCode: null,
        errorMessage: null,
        retryAfterMs: null,
        nextStatus: 'SENT',
        nextAttemptAt: new Date(),
      });

      expect(moved).toBe(true);
      expect(
        (await ctx.container.notifications.get(tenantA, owner, intent!.id)).intent.status,
      ).toBe('SENT');
    });
  });

  describe('a message whose values do not satisfy its template', () => {
    /**
     * `catalogue.render` substitutes what it is given and stringifies the rest,
     * so a missing required value leaves a literal `{token}` in the message. A
     * stored payload is only cast on the way out of the database, so neither
     * the type system nor the schema stops one written by hand — and without
     * this the message was sent and recorded SENT.
     */
    it('fails the attempt rather than sending a body with an unresolved placeholder', async () => {
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
        reason: 'Test setup.',
      });
      await ctx.container.opsLog.record(tenantA, {
        code: 'panel.unreachable',
        severity: 'ERROR',
        message: 'The panel did not answer.',
        dedupeKey: 'panel:1',
      });

      const [intent] = await ctx.container.notifications.list(tenantA, owner);
      // A payload with a required value removed, as a hand-written row or an
      // emitter's mistake would leave it.
      await ctx.container.database.withClient((client) =>
        client.query(`UPDATE notifications SET payload = payload - 'message' WHERE id = $1`, [
          intent!.id,
        ]),
      );

      const result = await ctx.container.notificationDispatcher.tick();
      expect(result).toMatchObject({ sent: 0, abandoned: 1 });
      expect(transport.messages).toHaveLength(0);

      const detail = await ctx.container.notifications.get(tenantA, owner, intent!.id);
      expect(detail.intent.status).toBe('FAILED');
      expect(detail.attempts[0]?.errorCode).toBe('notification.render_failed');
    });
  });

  describe('a test send that has already been accepted', () => {
    it('replays after the destination is cleared, rather than refusing it', async () => {
      const first = await ctx.container.settingsService.set(tenantA, owner, {
        key: 'ops.notifications.telegram_chat_id',
        value: '-100999',
        expectedVersion: null,
        idempotencyKey: `chat-${Math.random()}`,
      });

      const key = `test-${Math.random()}`;
      const sent = await ctx.container.notifications.sendTest(tenantA, owner, {
        idempotencyKey: key,
      });

      // The destination changes after the test was accepted. It is server
      // state, not part of the caller's request, and hashing it made an
      // identical retry look like a reused key with different input.
      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'ops.notifications.telegram_chat_id',
        value: '',
        expectedVersion: first.setting.version,
        idempotencyKey: `clear-${Math.random()}`,
      });

      const replay = await ctx.container.notifications.sendTest(tenantA, owner, {
        idempotencyKey: key,
      });
      expect(replay.replayed).toBe(true);
      expect(replay.intent.id).toBe(sent.intent.id);
    });
  });
});
