import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DrizzleSettingRepository } from '../../apps/api/src/modules/control/settings/infrastructure/drizzle-settings.repository';
import { DrizzleTemplateRepository } from '../../apps/api/src/modules/control/templates/infrastructure/drizzle-template.repository';
import { DrizzleFeatureFlagRepository } from '../../apps/api/src/modules/control/features/infrastructure/drizzle-feature-flags.repository';
import { createTestContext, tenantA, type TestContext } from './harness';

/**
 * The compare-and-swap predicates, tested where they actually decide.
 *
 * Every control-plane write reads the current version with a plain `SELECT` —
 * no `FOR UPDATE` — and then issues `UPDATE … WHERE version = expectedVersion`.
 * The port's own docblock states the guarantee that rests on it:
 *
 *   "The check IS the write: the predicate lives in the statement, so there is
 *    no window between deciding that a write is safe and performing it."
 *
 * Nothing tested it. All five predicates — settings, both halves of the
 * template save, the template revert, and feature flags — could be DELETED
 * with the entire 840-test integration suite still green, because the services'
 * pre-check refuses every sequential case before the statement is reached. A
 * reviewer demonstrated the consequence with a barrier probe: hold one request
 * between its read and its statement, let another commit, release the first,
 * and the second administrator's write is silently gone. No conflict, no audit
 * of the loss, and the Web Admin's "changed elsewhere" notice never fires
 * because the server reported success.
 *
 * These drive the REPOSITORIES rather than the services, deliberately. The
 * services are covered by `control-plane-isolation.test.ts`, and their
 * pre-check is exactly what makes a service-level test unable to see whether
 * the statement carries a predicate at all. Two sequential calls with the same
 * `expectedVersion` reproduce the interleaving without needing concurrency:
 * the second call is, by construction, a request built on a version that has
 * already been spent.
 */
describe('the statement-level compare-and-swap', () => {
  let ctx: TestContext;
  let settings: DrizzleSettingRepository;
  let templates: DrizzleTemplateRepository;
  let flags: DrizzleFeatureFlagRepository;

  beforeEach(async () => {
    ctx = await createTestContext();
    await ctx.reset();
    settings = new DrizzleSettingRepository(ctx.container.database.db);
    templates = new DrizzleTemplateRepository(ctx.container.database.db);
    flags = new DrizzleFeatureFlagRepository(ctx.container.database.db);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const now = new Date('2026-09-08T00:00:00.000Z');

  it('refuses a second setting write that names a version already spent', async () => {
    const first = await settings.upsert(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b55292d0',
      key: 'ops.notifications.max_attempts',
      value: 7,
      expectedVersion: null,
      now,
      adminId: null,
    });
    expect(first?.version).toBe(1);

    const winner = await settings.upsert(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b55292d1',
      key: 'ops.notifications.max_attempts',
      value: 9,
      expectedVersion: 1,
      now,
      adminId: null,
    });
    expect(winner?.version).toBe(2);

    // The interleaved administrator: their expectation was version 1, and
    // version 1 is gone. The statement must refuse rather than match on
    // `(tenant_id, setting_key)` and overwrite.
    const loser = await settings.upsert(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b55292d2',
      key: 'ops.notifications.max_attempts',
      value: 11,
      expectedVersion: 1,
      now,
      adminId: null,
    });
    expect(loser, 'a spent expectation must not write').toBeNull();

    // And the winner's value survived, which is the guarantee the null stands
    // for. Asserting only the null would pass if the statement wrote and then
    // returned nothing.
    const stored = await settings.find(tenantA, 'ops.notifications.max_attempts');
    expect(stored?.value).toBe(9);
    expect(stored?.version).toBe(2);
  });

  it('refuses a second template save that names a version already spent', async () => {
    const first = await templates.upsertOverride(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b55292e0',
      key: 'ops.notification.test',
      locale: 'fa',
      body: 'first',
      revision: 1,
      expectedVersion: null,
      expectedRevision: null,
      now,
      adminId: null,
    });
    expect(first?.version).toBe(1);

    const winner = await templates.upsertOverride(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b55292e1',
      key: 'ops.notification.test',
      locale: 'fa',
      body: 'second',
      revision: 2,
      expectedVersion: 1,
      expectedRevision: 1,
      now,
      adminId: null,
    });
    expect(winner?.version).toBe(2);

    const loser = await templates.upsertOverride(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b55292e2',
      key: 'ops.notification.test',
      locale: 'fa',
      body: 'clobbered',
      revision: 3,
      expectedVersion: 1,
      expectedRevision: 1,
      now,
      adminId: null,
    });
    expect(loser, 'a spent expectation must not write').toBeNull();

    const stored = await templates.findOverride(tenantA, 'ops.notification.test', 'fa');
    expect(stored?.body).toBe('second');
  });

  it('refuses a template save whose revision matches but whose version does not', async () => {
    /*
     * The VERSION half, isolated.
     *
     * The realistic case above cannot see it: a save advances both, so the
     * loser's stale revision refuses the write on its own and deleting the
     * version predicate changes nothing. Measured — the test above stayed
     * green with `eq(templateOverrides.version, …)` removed.
     *
     * So this one advances the version and holds the revision still, which the
     * repository permits, leaving the version predicate as the only thing that
     * can refuse. Two predicates need two tests; one fixture cannot show which
     * of them did the work.
     */
    await templates.upsertOverride(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b5529320',
      key: 'ops.notification.test',
      locale: 'fa',
      body: 'first',
      revision: 1,
      expectedVersion: null,
      expectedRevision: null,
      now,
      adminId: null,
    });
    const winner = await templates.upsertOverride(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b5529321',
      key: 'ops.notification.test',
      locale: 'fa',
      body: 'second',
      // The SAME revision, so only the version moves.
      revision: 1,
      expectedVersion: 1,
      expectedRevision: 1,
      now,
      adminId: null,
    });
    expect(winner?.version).toBe(2);
    expect(winner?.revision, 'the revision must be held still for this to isolate').toBe(1);

    const loser = await templates.upsertOverride(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b5529322',
      key: 'ops.notification.test',
      locale: 'fa',
      body: 'clobbered',
      revision: 2,
      expectedVersion: 1,
      expectedRevision: 1,
      now,
      adminId: null,
    });
    expect(loser, 'the revision matches; the version is what must refuse').toBeNull();
    expect((await templates.findOverride(tenantA, 'ops.notification.test', 'fa'))?.body).toBe(
      'second',
    );
  });

  it('refuses a revert whose revision matches but whose version does not', async () => {
    // The same isolation for the revert path, and for the same reason: the
    // realistic case above stayed green with the version predicate removed,
    // because the stale revision refused it first.
    await templates.upsertOverride(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b5529330',
      key: 'ops.notification.test',
      locale: 'fa',
      body: 'first',
      revision: 1,
      expectedVersion: null,
      expectedRevision: null,
      now,
      adminId: null,
    });
    await templates.upsertOverride(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b5529331',
      key: 'ops.notification.test',
      locale: 'fa',
      body: 'second',
      revision: 1,
      expectedVersion: 1,
      expectedRevision: 1,
      now,
      adminId: null,
    });

    const stale = await templates.deleteOverride(tenantA, {
      key: 'ops.notification.test',
      locale: 'fa',
      expectedVersion: 1,
      expectedRevision: 1,
    });
    expect(stale, 'the revision matches; the version is what must refuse').toBeNull();
    expect(
      (await templates.findOverride(tenantA, 'ops.notification.test', 'fa'))?.body,
      'the override is still there',
    ).toBe('second');
  });

  it('refuses a template save whose version matches but whose revision does not', async () => {
    /*
     * The REVISION half, which the version half cannot stand in for.
     *
     * A revert deletes the row and the next save inserts a fresh one at
     * version 1, so a stale version 1 matches a row it has never seen. The
     * revision comes from an append-only table the revert does not touch, so
     * it cannot restart — which is the whole reason the predicate names both.
     *
     * The service refuses this on its own pre-read, which is why the test
     * `control-plane-review-round-3.test.ts` › "refuses a save built on a
     * version that a revert has recycled" passes with this predicate DELETED:
     * it never reaches the statement. This one does.
     */
    await templates.upsertOverride(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b55292f0',
      key: 'ops.notification.test',
      locale: 'fa',
      body: 'before the revert',
      revision: 1,
      expectedVersion: null,
      expectedRevision: null,
      now,
      adminId: null,
    });
    // The revert, then a fresh save: version restarts at 1, revision does not.
    await templates.deleteOverride(tenantA, {
      key: 'ops.notification.test',
      locale: 'fa',
      expectedVersion: 1,
      expectedRevision: 1,
    });
    const reborn = await templates.upsertOverride(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b55292f1',
      key: 'ops.notification.test',
      locale: 'fa',
      body: 'after the revert',
      revision: 3,
      expectedVersion: null,
      expectedRevision: null,
      now,
      adminId: null,
    });
    expect(reborn?.version, 'the version restarts, which is the hazard').toBe(1);
    expect(reborn?.revision).toBe(3);

    // The administrator who was holding `(version 1, revision 1)` across the
    // revert. The version still matches. The revision is what refuses them.
    const stale = await templates.upsertOverride(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b55292f2',
      key: 'ops.notification.test',
      locale: 'fa',
      body: 'clobbered across a revert',
      revision: 4,
      expectedVersion: 1,
      expectedRevision: 1,
      now,
      adminId: null,
    });
    expect(stale, 'a recycled version must not be enough to write').toBeNull();

    const stored = await templates.findOverride(tenantA, 'ops.notification.test', 'fa');
    expect(stored?.body).toBe('after the revert');
  });

  it('refuses a revert that names a version already spent', async () => {
    await templates.upsertOverride(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b5529300',
      key: 'ops.notification.test',
      locale: 'fa',
      body: 'first',
      revision: 1,
      expectedVersion: null,
      expectedRevision: null,
      now,
      adminId: null,
    });
    await templates.upsertOverride(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b5529301',
      key: 'ops.notification.test',
      locale: 'fa',
      body: 'second',
      revision: 2,
      expectedVersion: 1,
      expectedRevision: 1,
      now,
      adminId: null,
    });

    // A revert built on the version the save above has already spent.
    const stale = await templates.deleteOverride(tenantA, {
      key: 'ops.notification.test',
      locale: 'fa',
      expectedVersion: 1,
      expectedRevision: 1,
    });
    expect(stale, 'a spent expectation must not delete').toBeNull();
    expect(
      (await templates.findOverride(tenantA, 'ops.notification.test', 'fa'))?.body,
      'the override is still there',
    ).toBe('second');
  });

  it('refuses a revert whose version matches only because a revert recycled it', async () => {
    /*
     * The revert's REVISION half, isolated — and the scenario its own comment
     * describes: "a revert deletes this row and the next save inserts a fresh
     * one at version 1, so a stale version 1 matches a row it has never seen".
     *
     * Both revert cases above leave the version mismatched, so the version
     * predicate refuses them and this one is never asked. Measured: they stayed
     * green with `eq(templateOverrides.revision, …)` removed from the delete.
     */
    await templates.upsertOverride(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b5529340',
      key: 'ops.notification.test',
      locale: 'fa',
      body: 'before the revert',
      revision: 1,
      expectedVersion: null,
      expectedRevision: null,
      now,
      adminId: null,
    });
    await templates.deleteOverride(tenantA, {
      key: 'ops.notification.test',
      locale: 'fa',
      expectedVersion: 1,
      expectedRevision: 1,
    });
    const reborn = await templates.upsertOverride(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b5529341',
      key: 'ops.notification.test',
      locale: 'fa',
      body: 'after the revert',
      revision: 3,
      expectedVersion: null,
      expectedRevision: null,
      now,
      adminId: null,
    });
    expect(reborn?.version, 'the version restarted, which is the hazard').toBe(1);

    // A revert built on `(version 1, revision 1)` from before the recycle. The
    // version matches the reborn row; the revision is the only thing that can
    // tell it is a different row.
    const stale = await templates.deleteOverride(tenantA, {
      key: 'ops.notification.test',
      locale: 'fa',
      expectedVersion: 1,
      expectedRevision: 1,
    });
    expect(stale, 'a recycled version must not be enough to delete').toBeNull();
    expect(
      (await templates.findOverride(tenantA, 'ops.notification.test', 'fa'))?.body,
      "the other administrator's override survived",
    ).toBe('after the revert');
  });

  it('refuses a second feature-flag write that names a version already spent', async () => {
    const first = await flags.upsert(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b5529310',
      key: 'ops_notifications',
      enabled: false,
      expectedVersion: null,
      reason: null,
      now,
      adminId: null,
    });
    expect(first?.version).toBe(1);

    const winner = await flags.upsert(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b5529311',
      key: 'ops_notifications',
      enabled: true,
      expectedVersion: 1,
      reason: null,
      now,
      adminId: null,
    });
    expect(winner?.version).toBe(2);

    const loser = await flags.upsert(tenantA, {
      id: '01a05e35-c9ad-7e93-bef3-1ed9b5529312',
      key: 'ops_notifications',
      enabled: false,
      expectedVersion: 1,
      reason: null,
      now,
      adminId: null,
    });
    expect(loser, 'a spent expectation must not write').toBeNull();

    const stored = await flags.find(tenantA, 'ops_notifications');
    expect(stored?.enabled, "the winner's write survived").toBe(true);
    expect(stored?.version).toBe(2);
  });
});
