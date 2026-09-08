import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { operationalEvents } from '../../apps/api/src/infrastructure/persistence/schema';
import { DrizzleOperationalEventReader } from '../../apps/api/src/modules/platform/opslog/infrastructure/drizzle-operational-event.reader';
import { createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * The alerts keyset, which is `(first_seen_at, id)` and must stay immutable.
 *
 * OWNER DECISION. It used to be `(last_seen_at, id)`, and `last_seen_at` is
 * rewritten by every repeat occurrence of a deduped condition — that is what
 * the occurrence counter is for. A row currently below the operator's cursor
 * that recurs jumps ABOVE it and is returned on no subsequent page: a silently
 * skipped alert, in the one subsystem whose stated rule is that silence is the
 * outcome it may not produce.
 *
 * These tests drive the READER directly. The service and the HTTP surface are
 * covered elsewhere; what is under test here is the traversal itself, and the
 * only way to show a mutable key is wrong is to mutate it BETWEEN two page
 * requests — which is exactly what a recurrence does in production and what no
 * end-to-end test was arranging.
 */
describe('the alerts keyset', () => {
  let ctx: TestContext;
  let reader: DrizzleOperationalEventReader;

  beforeEach(async () => {
    ctx = await createTestContext();
    await ctx.reset();
    reader = new DrizzleOperationalEventReader(ctx.container.database.db);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const BASE = Date.parse('2026-09-01T00:00:00.000Z');

  /**
   * Inserts a row directly, so `first_seen_at` and `last_seen_at` can be set
   * apart. The recorder always writes them equal on a first occurrence, which
   * is exactly why a test that went through it could not tell the two columns
   * apart — and why the old keyset looked correct for as long as nothing
   * recurred.
   */
  async function record(
    scope: { tenantId: unknown },
    over: { id: string; firstSeenAt: Date; lastSeenAt?: Date; code?: string },
  ): Promise<void> {
    await ctx.container.database.db.insert(operationalEvents).values({
      id: over.id,
      tenantId: scope.tenantId as string,
      code: over.code ?? 'panel.monitor.tenant_budget_exceeded',
      severity: 'WARN',
      message: `event ${over.id}`,
      context: null,
      dedupeScope: scope.tenantId as string,
      dedupeKey: `dedupe-${over.id}`,
      occurrenceCount: 1,
      firstSeenAt: over.firstSeenAt,
      lastSeenAt: over.lastSeenAt ?? over.firstSeenAt,
      correlationId: 'test',
      recoversCode: null,
      resolvedAt: null,
      resolvedByEventId: null,
    });
  }

  const uuid = (n: number) => `01a05e35-c9ad-7e93-bef3-1ed9b552${String(n).padStart(4, '0')}`;

  it('walks every row exactly once when a recurrence rewrites last_seen_at mid-walk', async () => {
    /*
     * THE decision test.
     *
     * Three rows, first seen an hour apart. Page one takes the newest. Then
     * the OLDEST row recurs — its `last_seen_at` jumps to now, which under the
     * old keyset put it above the cursor the operator is holding, so page two
     * skipped it and it appeared on no page at all.
     *
     * With `first_seen_at` the recurrence cannot move it: the walk sees all
     * three, once each, in first-seen order.
     */
    for (const n of [1, 2, 3]) {
      await record(tenantA, { id: uuid(n), firstSeenAt: new Date(BASE + n * 3_600_000) });
    }

    const pageOne = await reader.list(tenantA, { limit: 1, scope: 'ALL' });
    expect(pageOne).toHaveLength(1);
    expect(pageOne[0]!.id, 'newest first, by first_seen_at').toBe(uuid(3));

    // The OLDEST row recurs while the operator holds the cursor. This is what
    // the occurrence counter does in production.
    const recurredAt = new Date(BASE + 99 * 3_600_000);
    await ctx.container.database.db
      .update(operationalEvents)
      .set({ lastSeenAt: recurredAt, occurrenceCount: 2 })
      .where(eq(operationalEvents.id, uuid(1)));

    const seen = [...pageOne.map((row) => row.id)];
    let cursor = { before: pageOne[0]!.firstSeenAt, beforeId: pageOne[0]!.id };
    for (let page = 0; page < 5; page += 1) {
      const next = await reader.list(tenantA, {
        limit: 1,
        scope: 'ALL',
        before: cursor.before,
        beforeId: cursor.beforeId,
      });
      if (next.length === 0) break;
      seen.push(...next.map((row) => row.id));
      cursor = { before: next[0]!.firstSeenAt, beforeId: next[0]!.id };
    }

    expect(seen, 'the recurring row must not be skipped').toEqual([uuid(3), uuid(2), uuid(1)]);
    expect(new Set(seen).size, 'and must not be returned twice').toBe(seen.length);

    // The recurrence is still VISIBLE — it is metadata, not a traversal key.
    const recurred = (await reader.list(tenantA, { limit: 10, scope: 'ALL' })).find(
      (row) => row.id === uuid(1),
    );
    expect(recurred?.lastSeenAt.toISOString()).toBe(recurredAt.toISOString());
    expect(recurred?.occurrenceCount).toBe(2);
  });

  it('does not return a row twice when a recurrence would move it later', async () => {
    /*
     * The other direction of the same defect. Under `last_seen_at`, a row
     * ALREADY SHOWN whose activity moves below the cursor comes back on a
     * later page — a duplicate rather than a skip. Both are page-boundary
     * corruption and both are fixed by the same immutability.
     */
    for (const n of [1, 2, 3]) {
      await record(tenantA, { id: uuid(n), firstSeenAt: new Date(BASE + n * 3_600_000) });
    }

    const pageOne = await reader.list(tenantA, { limit: 2, scope: 'ALL' });
    expect(pageOne.map((row) => row.id)).toEqual([uuid(3), uuid(2)]);

    // The row already shown becomes the LEAST recently active.
    await ctx.container.database.db
      .update(operationalEvents)
      .set({ lastSeenAt: new Date(BASE - 99 * 3_600_000) })
      .where(eq(operationalEvents.id, uuid(3)));

    const pageTwo = await reader.list(tenantA, {
      limit: 2,
      scope: 'ALL',
      before: pageOne[1]!.firstSeenAt,
      beforeId: pageOne[1]!.id,
    });
    expect(
      pageTwo.map((row) => row.id),
      'no row already shown may return',
    ).toEqual([uuid(1)]);
  });

  it('breaks a shared first_seen_at by id, deterministically', async () => {
    /*
     * `first_seen_at` is a `Clock.now()` captured once per transaction, so
     * distinct conditions really do share one microsecond. Without the id
     * tie-break the order within that group is arbitrary and a cursor cannot
     * resume from it: the tail of the group appears on no page.
     */
    const shared = new Date(BASE);
    for (const n of [11, 12, 13]) {
      await record(tenantA, { id: uuid(n), firstSeenAt: shared });
    }

    const all = await reader.list(tenantA, { limit: 10, scope: 'ALL' });
    expect(
      all.map((row) => row.id),
      'id DESC inside the shared instant',
    ).toEqual([uuid(13), uuid(12), uuid(11)]);

    // And the walk one row at a time sees each exactly once across the group.
    const seen: string[] = [];
    let cursor: { before: Date; beforeId: string } | null = null;
    for (let page = 0; page < 5; page += 1) {
      const next: Awaited<ReturnType<typeof reader.list>> = await reader.list(tenantA, {
        limit: 1,
        scope: 'ALL',
        ...(cursor === null ? {} : { before: cursor.before, beforeId: cursor.beforeId }),
      });
      if (next.length === 0) break;
      seen.push(next[0]!.id);
      cursor = { before: next[0]!.firstSeenAt, beforeId: next[0]!.id };
    }
    expect(seen).toEqual([uuid(13), uuid(12), uuid(11)]);
  });

  it('keeps one tenant out of another tenant"s walk', async () => {
    // The keyset is tenant-scoped, and a cursor minted in one tenant must not
    // walk into another's rows — the change of ordering column must not have
    // moved that predicate.
    await record(tenantA, { id: uuid(21), firstSeenAt: new Date(BASE + 3_600_000) });
    await record(tenantB, { id: uuid(22), firstSeenAt: new Date(BASE + 2 * 3_600_000) });
    await record(tenantB, { id: uuid(23), firstSeenAt: new Date(BASE) });

    const a = await reader.list(tenantA, { limit: 10, scope: 'ALL' });
    expect(a.map((row) => row.id)).toEqual([uuid(21)]);

    // B's cursor, walked as B: only B's older row.
    const b = await reader.list(tenantB, { limit: 1, scope: 'ALL' });
    expect(b.map((row) => row.id)).toEqual([uuid(22)]);
    const bNext = await reader.list(tenantB, {
      limit: 10,
      scope: 'ALL',
      before: b[0]!.firstSeenAt,
      beforeId: b[0]!.id,
    });
    expect(
      bNext.map((row) => row.id),
      "A's row must not appear in B's walk",
    ).toEqual([uuid(23)]);
  });
});
