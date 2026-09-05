import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';
import type { ActorContext, CorrelationId } from '@nexa/contracts';

/**
 * The operational-event recorder, against a real database.
 *
 * Dedupe, resolution and the reporting the projection depends on. All of it
 * lives in SQL semantics — a unique index, a lock that does not exist until the
 * row does, an upsert — so none of it can be tested against a mock.
 */
describe('operational events', () => {
  let ctx: TestContext;
  let viewer: ActorContext;
  let viewerB: ActorContext;

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
    // A real administrator holding a real role. `SYSTEM_JOB` deliberately does
    // NOT hold `opslog.view` — background work holds an explicit, narrow set —
    // so a test that used one would be testing a bypass rather than the surface.
    viewer = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'watcher', roleKeys: ['observer'] }),
    );
    viewerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'watcher-b', roleKeys: ['observer'] }),
    );
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const record = (input: Parameters<typeof ctx.container.opsLog.record>[1], scope = tenantA) =>
    ctx.container.opsLog.record(scope, input);

  const failure = (dedupeKey = 'panel:1') =>
    ({
      code: 'panel.unreachable',
      severity: 'ERROR',
      message: 'The panel did not answer.',
      dedupeKey,
    }) as const;

  it('reports the first occurrence as new and the rest as not', async () => {
    // This is what makes one message per condition possible. The legacy log
    // group posted the same expired-TLS error 36 + 15 + 8 + 1 times in one day
    // because nothing could tell these apart (BUG-LGR-028).
    const first = await record(failure());
    const second = await record(failure());

    expect(first.isNew).toBe(true);
    expect(first.occurrenceCount).toBe(1);
    expect(second.isNew).toBe(false);
    expect(second.occurrenceCount).toBe(2);
    expect(second.id).toBe(first.id);
  });

  it('survives a concurrent first report of the same condition', async () => {
    // Regression, and the reproduction is deliberate rather than opportunistic.
    //
    // The first version of this locked the row with SELECT ... FOR UPDATE and
    // then inserted. A lock on a row that does not exist locks nothing, so two
    // first reports of one condition both find nothing and both insert, and the
    // second dies on the unique index. It surfaced as an unexplained login
    // failure, because the login throttle records an operational event when it
    // locks somebody out.
    //
    // Simply calling `record` twice at once does NOT reproduce it — the two
    // transactions serialise in practice and the test passes against the broken
    // code, which is worse than having no test. So the interleaving is built:
    // an uncommitted insert from another connection is invisible to this one's
    // SELECT, which is precisely the state the bug needs.
    const key = 'race';
    const other = await ctx.container.database.pool.connect();
    let recorded: Promise<{ isNew: boolean; occurrenceCount: number }>;
    try {
      await other.query('BEGIN');
      await other.query(
        `INSERT INTO operational_events
           (id, tenant_id, code, severity, message, dedupe_scope, dedupe_key,
            occurrence_count, first_seen_at, last_seen_at)
         VALUES ($1, $2, 'panel.unreachable', 'ERROR', 'The panel did not answer.', $3, $4, 1, now(), now())`,
        [ctx.container.ids.uuid(), tenantA.tenantId, `${tenantA.tenantId}|OPSLOG`, key],
      );

      // Starts, sees nothing, and blocks on the unique index behind the
      // uncommitted row above.
      recorded = record(failure(key)) as never;
      await new Promise((resolve) => setTimeout(resolve, 100));
      await other.query('COMMIT');
    } finally {
      other.release();
    }

    // The blocked write must resolve as another occurrence of the existing
    // condition, not as a duplicate-key error.
    const result = await recorded;
    expect(result.isNew).toBe(false);
    expect(result.occurrenceCount).toBe(2);
  });

  it('keeps each tenant’s conditions apart even with the same dedupe key', async () => {
    const a = await record(failure('shared'), tenantA);
    const b = await record(failure('shared'), tenantB);
    expect(a.id).not.toBe(b.id);
    expect(a.isNew).toBe(true);
    expect(b.isNew).toBe(true);
  });

  it('marks a condition resolved without removing anything', async () => {
    const opened = await record(failure());
    await record({
      code: 'panel.reachable',
      severity: 'INFO',
      message: 'The panel answered again.',
      recoversCode: 'panel.unreachable',
    });

    const events = await ctx.container.opsLogService.list(tenantA, viewer, { limit: 10 });
    const failureRow = events.find((row) => row.id === opened.id);

    // The failure keeps its message and its counter. A resolved problem stops
    // looking unresolved; it does not stop having happened.
    expect(failureRow?.message).toBe('The panel did not answer.');
    expect(failureRow?.occurrenceCount).toBe(1);
    expect(failureRow?.resolvedAt).not.toBeNull();
    expect(events.some((row) => row.recoversCode === 'panel.unreachable')).toBe(true);
  });

  it('reopens a resolved condition when it recurs, and says so', async () => {
    await record(failure());
    await record({
      code: 'panel.reachable',
      severity: 'INFO',
      message: 'Back.',
      recoversCode: 'panel.unreachable',
    });

    const again = await record(failure());
    // Not new — it is the same row — but worth telling somebody about, which is
    // exactly the case a plain "notify on new rows" rule would miss.
    expect(again.isNew).toBe(false);
    expect(again.reopened).toBe(true);

    const open = await ctx.container.opsLogService.list(tenantA, viewer, {
      limit: 10,
      open: true,
    });
    expect(open.some((row) => row.code === 'panel.unreachable')).toBe(true);
  });

  it('does not report a still-open condition as reopened', async () => {
    await record(failure());
    const again = await record(failure());
    expect(again.reopened).toBe(false);
  });

  describe('the read model', () => {
    it('filters by severity, code and open state', async () => {
      await record(failure());
      await record({ code: 'system.ping', severity: 'INFO', message: 'ping', dedupeKey: 'p' });

      const actor = viewer;
      expect(
        (await ctx.container.opsLogService.list(tenantA, actor, { severities: ['ERROR'] })).map(
          (row) => row.code,
        ),
      ).toEqual(['panel.unreachable']);

      expect(
        (await ctx.container.opsLogService.list(tenantA, actor, { code: 'system.ping' })).map(
          (row) => row.code,
        ),
      ).toEqual(['system.ping']);
    });

    it('shows one tenant nothing of another’s', async () => {
      await record(failure('shared'), tenantA);
      await record(failure('shared'), tenantB);
      const seen = await ctx.container.opsLogService.list(tenantB, viewerB, { limit: 50 });
      expect(seen).toHaveLength(1);
    });

    it('refuses a caller without opslog.view', async () => {
      await expect(
        ctx.container.opsLogService.list(tenantA, anonymousActor(), {}),
      ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
    });
  });
});

function anonymousActor() {
  return {
    // `API`, not `ANONYMOUS`: there is no such actor type, and this file was
    // outside the test typecheck so nothing said so. The test wants an actor
    // with no admin identity, which is what `API` with a null id is.
    type: 'API' as const,
    id: null,
    label: null,
    surface: 'WEB' as const,
    correlationId: 'test-correlation' as CorrelationId,
  };
}
