import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { ActorContext, AdminSessionId } from '@nexa/contracts';
import {
  auditLogs,
  notifications,
  operationalEvents,
  outboxMessages,
} from '../../apps/api/src/infrastructure/persistence/schema';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type SeededAdmin,
  type TestContext,
} from './harness';

/**
 * Authority is established INSIDE the transaction that commits the mutation.
 *
 * The check a surface makes first is an early rejection and nothing more —
 * ADR-0014 says so, and Phase 1's administrator mutations already act on it.
 * Between that check and the commit there is a window containing database
 * reads, validation and an idempotency lookup, and an owner revoking a role in
 * that window was losing the race: the mutation, its SUCCESS audit row, its
 * outbox event and its idempotency completion all committed on authority that
 * no longer existed.
 *
 * The interleaving is DETERMINISTIC. A barrier replaces the unit of work's
 * `run` for exactly one call, so administrator A is stopped at the instant it
 * has passed the outer guard and not yet opened its transaction. Owner B then
 * commits the revocation, and only then is A released. No sleeps, and nothing
 * depends on which of two promises the scheduler happens to prefer.
 */
describe('fresh transactional authorization', () => {
  let ctx: TestContext;
  let ownerB: ActorContext;
  let adminA: SeededAdmin;
  let actorA: ActorContext;

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-b', roleKeys: ['owner'] }),
    );
    adminA = await createAdmin(ctx.container, tenantA, {
      username: 'admin-a',
      roleKeys: ['owner'],
    });
    actorA = adminActorFor(adminA);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const db = () => ctx.container.database.db;

  /**
   * Replaces `uow.run` for ONE call, so the next transaction to open is held.
   *
   * One call, not all of them: owner B's revocation goes through the same unit
   * of work, and a barrier that caught every transaction would deadlock the
   * test against itself rather than exercising the race.
   */
  function barrierOnNextTransaction(): { reached: Promise<void>; release: () => void } {
    const uow = ctx.container.uow as unknown as {
      run: (scope: unknown, fn: unknown) => Promise<unknown>;
    };
    const original = uow.run.bind(uow);

    let markReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    let armed = true;
    uow.run = async (scope: unknown, fn: unknown) => {
      if (armed) {
        armed = false;
        uow.run = original;
        markReached();
        await released;
      }
      return original(scope, fn);
    };

    return { reached, release };
  }

  /** Owner B removes A's authority and COMMITS, while A is held at the barrier. */
  async function revokeA(): Promise<void> {
    await ctx.container.adminManagement.setRoles(tenantA, ownerB, adminA.id, {
      roleKeys: ['observer'],
      reason: 'Authority revoked mid-request by the owner.',
    });
  }

  const auditRows = async (action: string) =>
    db()
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, action), eq(auditLogs.actorId, adminA.id)));

  const outboxRows = async (eventType: string) =>
    db().select().from(outboxMessages).where(eq(outboxMessages.eventType, eventType));

  /**
   * One case per protected control-plane mutation.
   *
   * `mutate` is started but NOT awaited: it must reach the barrier before the
   * revocation, which is the whole point of the ordering.
   */
  const CASES = [
    {
      name: 'settings.set',
      action: 'settings.set',
      eventType: 'SettingChanged',
      mutate: () =>
        ctx.container.settingsService.set(tenantA, actorA, {
          key: 'ops.notifications.max_attempts',
          value: 4,
          expectedVersion: null,
          idempotencyKey: 'revoked-settings',
        }),
      unchanged: async () => {
        const resolved = await ctx.container.settingsResolver.resolve(
          tenantA,
          'ops.notifications.max_attempts',
        );
        expect(resolved.source, 'the setting was written by a revoked actor').toBe('DEFAULT');
      },
    },
    {
      name: 'features.set',
      action: 'features.set',
      eventType: 'FeatureFlagChanged',
      mutate: () =>
        ctx.container.featureFlags.set(tenantA, actorA, {
          key: 'template_overrides',
          enabled: false,
          expectedVersion: null,
          idempotencyKey: 'revoked-feature',
          confirmKey: 'template_overrides',
          reason: 'Revocation race.',
        }),
      unchanged: async () => {
        const flag = await ctx.container.featureFlagResolver.resolve(tenantA, 'template_overrides');
        expect(flag.source, 'the flag was written by a revoked actor').toBe('DEFAULT');
      },
    },
    {
      name: 'templates.set',
      action: 'templates.set',
      eventType: 'TemplateOverrideChanged',
      mutate: () =>
        ctx.container.templatesService.set(tenantA, actorA, {
          key: 'ops.notification.operational_event',
          body: '{severity} — {code}\n{message}',
          expectedVersion: null,
          expectedRevision: null,
          idempotencyKey: 'revoked-template',
        }),
      unchanged: async () => {
        const view = await ctx.container.templatesService.get(
          tenantA,
          ownerB,
          'ops.notification.operational_event',
        );
        expect(view.source, 'the override was written by a revoked actor').toBe('DEFAULT');
      },
    },
  ] as const;

  for (const testCase of CASES) {
    it(`refuses ${testCase.name} when authority is revoked before the transaction`, async () => {
      const barrier = barrierOnNextTransaction();

      // 1-2. A holds the required authority and passes the outer guard.
      // 3.   A is paused before its authoritative transaction.
      const attempt = testCase.mutate();
      const settled = attempt.then(
        () => ({ ok: true }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      );
      // A failure BEFORE the barrier means the ordering was never reached, and
      // waiting on a promise that will not resolve would report it as a
      // timeout rather than as what it is.
      const arrived = await Promise.race([
        barrier.reached.then(() => 'at the barrier' as const),
        settled.then(() => 'finished early' as const),
      ]);
      expect(arrived, `${testCase.name} never reached its transaction`).toBe('at the barrier');

      // 4. Owner B removes A's authority and commits.
      await revokeA();

      // 5-7. A resumes, reaches its mutation transaction, and fresh
      //      authorization denies.
      barrier.release();
      const outcome = await settled;
      expect(outcome.ok, `${testCase.name} committed on revoked authority`).toBe(false);
      expect(outcome.ok === false && outcome.error).toMatchObject({
        code: 'platform.permission_denied',
      });

      // 8. The target state is untouched.
      await testCase.unchanged();

      // 9. No SUCCESS audit row and no outbox event for A.
      const audits = await auditRows(testCase.action);
      expect(
        audits.filter((row) => row.result === 'SUCCESS'),
        'a SUCCESS audit row was committed for a denied actor',
      ).toEqual([]);
      expect(
        await outboxRows(testCase.eventType),
        'a domain event was committed for a denied actor',
      ).toEqual([]);

      // 10. The denial itself is recorded truthfully.
      expect(
        audits.filter((row) => row.result === 'DENIED').length,
        'the denial left no audit evidence',
      ).toBeGreaterThan(0);
    }, 30_000);
  }

  /**
   * Permissions and sessions are two different revocations.
   *
   * `authenticated-request.ts` states that `sessionId` is required *"so a
   * mutation can confirm, under the lock it takes anyway, that this session
   * has not been revoked since the request arrived"*. Phase 1's administrator
   * mutations honour that; the control plane did not — so "changing an
   * administrator's roles stops their in-flight write" was true while
   * "revoking their sessions stops it" was false, and a signed-out or
   * password-rotated administrator's write still committed. A comment
   * promising a guarantee the code did not provide.
   */
  it('records an EARLY refusal the same way in every phase', async () => {
    // Four services check a permission before opening a transaction, because
    // the replay path and the connection test both act before one exists. The
    // three written in Phase 2 hand-rolled that recording inline and the one
    // written in Phase 3A used `recordMutationDenial`, so an identical refusal
    // left different evidence depending on which phase wrote the endpoint: the
    // inline version recorded a DENIED row for ANY throw — a missing tenant
    // context is not a denial of `settings.edit` — and emitted no operational
    // event at all.
    //
    // They now share one recorder. This asserts the pair it produces, so a
    // future service that hand-rolls it again is visibly different.
    const support = await createAdmin(ctx.container, tenantA, {
      username: 'denied_early',
      roleKeys: ['support'],
    });

    await expect(
      ctx.container.settingsService.set(tenantA, adminActorFor(support), {
        key: 'ops.notifications.max_attempts',
        value: 3,
        expectedVersion: null,
        idempotencyKey: `early-denial-${Date.now()}`,
      }),
    ).rejects.toMatchObject({ code: 'platform.permission_denied' });

    // Queried by action rather than through `auditRows`, which scopes to the
    // suite's own admin and would silently return nothing for this one.
    const denials = (
      await ctx.container.database.db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, 'settings.set'), eq(auditLogs.actorId, support.id)))
    ).filter((row) => row.result === 'DENIED');
    expect(denials, 'the early refusal left no audit evidence').toHaveLength(1);
    expect(
      (denials[0]?.after as { deniedPermission?: string } | null)?.deniedPermission,
      'the audit row does not name the permission that was refused',
    ).toBe('settings.edit');

    const events = await ctx.container.database.db.select().from(operationalEvents);
    expect(
      events.some((event) => event.code.includes('denied') || event.code.includes('permission')),
      'the early refusal emitted no operational event',
    ).toBe(true);
  }, 30_000);

  it('refuses a control-plane write whose session is revoked before the transaction', async () => {
    const sessionId = ctx.container.ids.uuid() as AdminSessionId;
    await ctx.container.sessions.create(tenantA, {
      id: sessionId,
      adminId: adminA.id,
      tokenHash: 'a'.repeat(64),
      issuedAt: ctx.container.clock.now(),
      expiresAt: new Date(ctx.container.clock.now().getTime() + 3_600_000),
      ip: '198.51.100.7',
      userAgent: 'vitest',
    });
    const withSession: ActorContext = { ...actorA, sessionId };

    const barrier = barrierOnNextTransaction();
    const attempt = ctx.container.settingsService.set(tenantA, withSession, {
      key: 'ops.notifications.max_attempts',
      value: 4,
      expectedVersion: null,
      idempotencyKey: 'revoked-session',
    });
    const settled = attempt.then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
    const arrived = await Promise.race([
      barrier.reached.then(() => 'at the barrier' as const),
      settled.then(() => 'finished early' as const),
    ]);
    expect(arrived, 'settings.set never reached its transaction').toBe('at the barrier');

    // A sign-out, or a password rotation, lands while A is parked.
    await ctx.container.sessions.revoke(sessionId, ctx.container.clock.now(), 'signed out');

    barrier.release();
    const outcome = await settled;
    expect(outcome.ok, 'a revoked session committed a control-plane write').toBe(false);

    const resolved = await ctx.container.settingsResolver.resolve(
      tenantA,
      'ops.notifications.max_attempts',
    );
    expect(resolved.source, 'the setting was written on a revoked session').toBe('DEFAULT');
  }, 30_000);

  it('refuses notifications.test when authority is revoked before the transaction', async () => {
    // The fifth protected control-plane write, and the one a first pass
    // missed: `sendTest` checks `settings.edit` on the pool and then parses,
    // hashes, looks up an idempotency record, resolves a destination and reads
    // a setting before its transaction opens. Same window, and this one ends
    // with a Telegram message going out.
    await ctx.container.settingsService.set(tenantA, ownerB, {
      key: 'ops.notifications.telegram_chat_id',
      value: '-100999',
      expectedVersion: null,
      idempotencyKey: 'revoked-test-setup',
    });

    const barrier = barrierOnNextTransaction();
    const attempt = ctx.container.notifications.sendTest(tenantA, actorA, {
      idempotencyKey: 'revoked-send-test',
    });
    const settled = attempt.then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
    const arrived = await Promise.race([
      barrier.reached.then(() => 'at the barrier' as const),
      settled.then(() => 'finished early' as const),
    ]);
    expect(arrived, 'notifications.test never reached its transaction').toBe('at the barrier');

    await revokeA();

    barrier.release();
    const outcome = await settled;
    expect(outcome.ok, 'notifications.test committed on revoked authority').toBe(false);

    // No intent was queued, so nothing can be sent for it.
    const queued = await db().select().from(notifications);
    expect(queued, 'a notification was queued by a revoked actor').toEqual([]);

    const audits = await auditRows('notifications.test');
    expect(
      audits.filter((row) => row.result === 'SUCCESS'),
      'a SUCCESS audit row was committed for a denied test send',
    ).toEqual([]);
    expect(
      audits.filter((row) => row.result === 'DENIED').length,
      'the denial left no audit evidence',
    ).toBeGreaterThan(0);
  }, 30_000);

  /**
   * `templates.revert` needs an override to remove, so its setup writes one
   * while A still holds authority. That write is A's own, and its SUCCESS rows
   * would mask the assertion below — so the revert is audited under its own
   * action name and asserted on that alone.
   */
  it('refuses templates.revert when authority is revoked before the transaction', async () => {
    const saved = await ctx.container.templatesService.set(tenantA, actorA, {
      key: 'ops.notification.operational_event',
      body: '{severity} — {code}\n{message}',
      expectedVersion: null,
      expectedRevision: null,
      idempotencyKey: 'revert-setup',
    });

    const barrier = barrierOnNextTransaction();
    const attempt = ctx.container.templatesService.revert(tenantA, actorA, {
      key: 'ops.notification.operational_event',
      expectedVersion: saved.template.version,
      expectedRevision: saved.revision,
      idempotencyKey: 'revoked-revert',
    });
    const settled = attempt.then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
    const arrived = await Promise.race([
      barrier.reached.then(() => 'at the barrier' as const),
      settled.then(() => 'finished early' as const),
    ]);
    expect(arrived, 'templates.revert never reached its transaction').toBe('at the barrier');

    await revokeA();

    barrier.release();
    const outcome = await settled;
    expect(outcome.ok, 'templates.revert committed on revoked authority').toBe(false);

    // The override A saved while authorised is still there: the revert did not
    // happen, which is the state assertion that matters.
    const view = await ctx.container.templatesService.get(
      tenantA,
      ownerB,
      'ops.notification.operational_event',
    );
    expect(view.source, 'the override was reverted by a revoked actor').toBe('TENANT');

    const audits = await auditRows('templates.revert');
    expect(
      audits.filter((row) => row.result === 'SUCCESS'),
      'a SUCCESS audit row was committed for a denied revert',
    ).toEqual([]);
    expect(
      await outboxRows('TemplateOverrideReverted'),
      'a domain event was committed for a denied revert',
    ).toEqual([]);
    expect(
      audits.filter((row) => row.result === 'DENIED').length,
      'the denial left no audit evidence',
    ).toBeGreaterThan(0);
  }, 30_000);
});
