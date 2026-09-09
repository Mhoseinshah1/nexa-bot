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
   * ONE operational event for an in-transaction refusal, WARN, naming what
   * the audit row names and who was refused. On this path the shared
   * recorder is the only emitter, and its event's CONTENT was pinned by
   * nothing until round 50 — and by round 50 only in the parametrised
   * cases; the two literal barrier tests below use it since round 51.
   */
  const expectOneWarnDenialEvent = async (
    label: string,
    denied: readonly { after: unknown }[],
    permission: string,
  ) => {
    // EXACTLY one DENIED row (round 52: the floor `> 0` let a doubled row
    // through), naming the LITERAL permission the case refuses — so the event
    // is compared against the truth, not against whatever the audit row says.
    expect(denied, `${label}: ONE in-transaction refusal, ONE DENIED audit row`).toHaveLength(1);
    const deniedRow = denied[0];
    const events = await db()
      .select()
      .from(operationalEvents)
      .where(eq(operationalEvents.code, 'access.permission_denied'));
    expect(
      events.map((event) => event.severity),
      `${label}: ONE in-transaction refusal, ONE WARN event`,
    ).toEqual(['WARN']);
    const context = events[0]?.context as Record<string, unknown> | null;
    const deniedPermission = (deniedRow?.after as Record<string, unknown> | null)?.[
      'deniedPermission'
    ];
    expect(deniedPermission, `${label}: the audit row names the refused permission`).toBe(
      permission,
    );
    expect(context?.['permission']).toBe(permission);
    expect(context?.['actorId']).toBe(adminA.id);
  };

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
      permission: 'settings.edit',
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
      // A feature flag's parameters are settings (Phase 2 rule), and so is
      // the permission that edits it.
      permission: 'settings.edit',
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
      permission: 'templates.edit',
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
      const denied = audits.filter((row) => row.result === 'DENIED');

      // 11. ONE operational event for it, WARN, naming what the audit row
      //     names and who was refused.
      await expectOneWarnDenialEvent(testCase.name, denied, testCase.permission);
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

    // EXACTLY one event for the one request above, not "at least one". The
    // floor this replaces — `events.some(code includes 'denied')` — held while
    // every early refusal in this module wrote the event TWICE (OQ-3D-03):
    // `permission-guard` when no transaction is passed, and
    // `recordMutationDenial` again for the same refusal. Settings shares that
    // recorder with panels, features and notifications, so the panel test is
    // not the only place the count has to be exact.
    const denialEvents = await ctx.container.database.db
      .select()
      .from(operationalEvents)
      .where(eq(operationalEvents.code, 'access.permission_denied'));
    expect(
      denialEvents.map((event) => event.code),
      'ONE early refusal must emit ONE operational event',
    ).toEqual(['access.permission_denied']);
  }, 30_000);

  it('records a TEMPLATES early refusal as one audit row and one event, and a non-denial as nothing', async () => {
    // Templates was the last early check IN THE CONTROL PLANE on an inline
    // catch-ANY recorder (identity's audits inline, filtered on the kind; the
    // system ping's went in round 52), and its `catch (denial)` wrote a DENIED
    // row for ANY throw — the operational log being down, a missing tenant
    // context — a false statement in the one ledger that must not contain one. It shares the recorder now (round
    // 49): this permission's refusal is one row and one event, exactly, and
    // an error that is not a denial leaves no DENIED row at all.
    const support = await createAdmin(ctx.container, tenantA, {
      username: 'denied_templates',
      roleKeys: ['support'],
    });
    const deniedRows = async () =>
      (
        await ctx.container.database.db
          .select()
          .from(auditLogs)
          .where(and(eq(auditLogs.action, 'templates.set'), eq(auditLogs.actorId, support.id)))
      ).filter((row) => row.result === 'DENIED');
    const denialEvents = async () =>
      (
        await ctx.container.database.db
          .select()
          .from(operationalEvents)
          .where(eq(operationalEvents.code, 'access.permission_denied'))
      ).length;
    const command = (idempotencyKey: string) => ({
      key: 'ops.notification.operational_event',
      body: '{severity} — {code}\n{message}',
      expectedVersion: null,
      expectedRevision: null,
      idempotencyKey,
    });

    await expect(
      ctx.container.templatesService.set(
        tenantA,
        adminActorFor(support),
        command('templates-early-denial'),
      ),
    ).rejects.toMatchObject({ code: 'platform.permission_denied' });
    const [row] = await deniedRows();
    expect(await deniedRows(), 'ONE early refusal, ONE audit row').toHaveLength(1);
    expect(await denialEvents(), 'ONE early refusal, ONE event').toBe(1);
    // The row's shape: the shared recorder names the permission and the
    // reason, where the inline version wrote `after: null`. A behaviour
    // change of round 49, stated here.
    expect(row).toMatchObject({
      entityType: 'Template',
      after: { deniedPermission: 'templates.edit', reason: 'platform.permission_denied' },
    });

    // Authorized BEFORE parsed: a body the schema rejects is still a 403 with
    // its record, not a 400 with none. The rule every other early check
    // keeps, pinned here on purpose rather than by a fixture that happens to
    // omit a required field.
    await expect(
      ctx.container.templatesService.set(tenantA, adminActorFor(support), { nonsense: true }),
    ).rejects.toMatchObject({ code: 'platform.permission_denied' });
    expect(await deniedRows(), 'a malformed body suppressed the audit row').toHaveLength(2);
    expect(await denialEvents(), 'a malformed body suppressed the event').toBe(2);

    // Not a denial: the guard itself fails. Nothing may be audited as DENIED.
    const guard = ctx.container.guard as unknown as {
      check: (...args: unknown[]) => Promise<void>;
    };
    const realCheck = guard.check;
    guard.check = async () => {
      throw new Error('the operational log is down');
    };
    try {
      await expect(
        ctx.container.templatesService.set(
          tenantA,
          adminActorFor(support),
          command('templates-outage'),
        ),
      ).rejects.toThrow('the operational log is down');
    } finally {
      guard.check = realCheck;
    }
    expect(await deniedRows(), 'an outage is not a denial').toHaveLength(2);
    expect(await denialEvents()).toBe(2);
  }, 30_000);

  it('treats an EXPIRED session as dead, not only a revoked one', async () => {
    /*
     * `isLive` has two halves and only one was tested.
     *
     * Its `isNull(revokedAt)` half is covered by the barrier test below —
     * delete it and that test fails. Its `gt(expiresAt, now)` half was covered
     * by nothing: measured, removing it left the entire 840-test integration
     * suite green. The docblocks promise revocation-freshness explicitly and
     * say nothing about expiry, so the asymmetry is invisible to a reader.
     *
     * The consequence is a session that reaches `expires_at` between request
     * admission and the mutation transaction authorising the write. The window
     * is short — session lifetimes are hours — which is why this is a plain
     * repository test rather than another barrier: what was missing is any
     * assertion at all that expiry is checked.
     */
    const now = ctx.container.clock.now();
    const live = ctx.container.ids.uuid() as AdminSessionId;
    const expired = ctx.container.ids.uuid() as AdminSessionId;
    for (const [id, expiresAt] of [
      [live, new Date(now.getTime() + 3_600_000)],
      [expired, new Date(now.getTime() - 1_000)],
    ] as const) {
      await ctx.container.sessions.create(tenantA, {
        id,
        adminId: adminA.id,
        tokenHash: `${id}`.padEnd(64, 'b').slice(0, 64),
        issuedAt: new Date(now.getTime() - 7_200_000),
        expiresAt,
        ip: '198.51.100.9',
        userAgent: 'vitest',
      });
    }

    // Neither is revoked, so the other half of the predicate cannot be what
    // separates them: expiry is the only difference between these two rows.
    expect(await ctx.container.sessions.isLive(tenantA, live, now)).toBe(true);
    expect(
      await ctx.container.sessions.isLive(tenantA, expired, now),
      'a session past its expiry may not authorise a write',
    ).toBe(false);
  });

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
    const denied = audits.filter((row) => row.result === 'DENIED');
    await expectOneWarnDenialEvent('notifications.test', denied, 'settings.edit');
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
    const denied = audits.filter((row) => row.result === 'DENIED');
    await expectOneWarnDenialEvent('templates.revert', denied, 'templates.edit');
  }, 30_000);
});
