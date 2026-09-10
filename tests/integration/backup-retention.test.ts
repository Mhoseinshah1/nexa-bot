import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestContext, type TestContext } from './harness';
import { SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { backupRuns } from '../../apps/api/src/infrastructure/persistence/schema';
import { DrizzleBackupRunRepository } from '../../apps/api/src/modules/platform/backup/infrastructure/drizzle-backup-run.repository';

/**
 * Retention for `backup_runs` — ADR-0027.
 *
 * Against a real database, and it could not be otherwise: every rule here is a
 * SQL predicate, and two of them are subqueries for "the most recent row". A
 * fake that reimplemented them would be asserting its own arithmetic — the shape
 * of test this repository keeps finding and removing.
 *
 * The table is small by construction: one row per backup, a few hundred bytes,
 * so at a daily schedule it gains about 365 rows a year. This is therefore not a
 * size control. What it replaces is a table with NO policy, which is the state
 * every table in the legacy system was in, and a scripted manual-backup loop is
 * the case where the bound does real work.
 *
 * Four exclusions, and each one is a correctness rule rather than a preference.
 * The cases below are ordered so that the two "most recent row" rules are tested
 * against a table that HAS older eligible rows — otherwise they would pass
 * because there was nothing to delete.
 */
describe('backup run retention', () => {
  let context: TestContext;
  let runs: DrizzleBackupRunRepository;

  const NOW = new Date('2026-06-01T12:00:00.000Z');
  /** A year back, which is the decided default. */
  const CUTOFF = new Date(NOW.getTime() - 365 * 24 * 3_600_000);
  const ancient = (days: number) => new Date(CUTOFF.getTime() - days * 24 * 3_600_000);

  beforeAll(async () => {
    context = await createTestContext();
    runs = new DrizzleBackupRunRepository(context.container.database.db);
  }, 60_000);

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  /**
   * One row, inserted directly.
   *
   * Not through the service: the service enforces one RUNNING row at a time and
   * takes a real dump, and this file is about what a DELETE may and may not
   * touch. Inserting the state under test is the only way to construct a table
   * that holds a year of history.
   */
  const insert = async (input: {
    id?: string;
    state: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
    startedAt: Date;
    finishedAt: Date | null;
    deliveryState?: string;
    /**
     * Whether a SUCCEEDED row carries its verification.
     *
     * Defaults to true, because the pipeline only ever writes SUCCEEDED after a
     * passed verification. It is a parameter because NOTHING IN THE SCHEMA says so
     * — there is no CHECK tying the two — so the unverified combination is a state
     * the database admits and a future finish path could produce.
     */
    verified?: boolean;
  }): Promise<string> => {
    const id = input.id ?? randomUUID();
    await context.container.database.db.insert(backupRuns).values({
      id,
      trigger: 'SCHEDULED',
      state: input.state,
      stage: input.state === 'RUNNING' ? 'DUMP' : 'CLEANUP',
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      leaseOwner: 'test',
      leaseHeartbeatAt: input.startedAt,
      deliveryState: input.deliveryState ?? 'SUCCEEDED',
      verifiedAt: input.state === 'SUCCEEDED' && input.verified !== false ? input.startedAt : null,
      cleanupOk: true,
    } as never);
    return id;
  };

  const ids = async (): Promise<string[]> => {
    const rows = await context.container.database.db
      .select({ id: backupRuns.id })
      .from(backupRuns)
      .orderBy(backupRuns.startedAt);
    return rows.map((row) => row.id);
  };

  it('protects the most recent VERIFIED success, not merely the most recent SUCCEEDED row', async () => {
    /*
     * Review finding 4. The exclusion filtered on the state alone while
     * `lastSucceededAt()` — the reader it exists to protect — also requires
     * `verified_at IS NOT NULL`. Two predicates for one row.
     *
     * Nothing in the schema ties them: there is no CHECK constraint making a
     * SUCCEEDED row carry a verification, only the pipeline's own ordering. So an
     * unverified SUCCEEDED row absorbed the exclusion, the newest VERIFIED success
     * became eligible, and deleting it makes `lastSucceededAt()` return null — the
     * scheduler then concludes no backup has ever succeeded and derives its whole
     * schedule from the deletion. That is exactly the harm ADR-0027 says this
     * exclusion prevents.
     *
     * All three rows are past the cutoff, so only an exclusion can save any of
     * them. The newest is a FAILED row, and it is there to absorb the
     * most-recent-finished exclusion — without it the unverified success would be
     * kept by THAT clause and the case could not tell the two apart.
     */
    const verified = await insert({
      state: 'SUCCEEDED',
      startedAt: ancient(500),
      finishedAt: ancient(500),
    });
    const unverified = await insert({
      state: 'SUCCEEDED',
      startedAt: ancient(400),
      finishedAt: ancient(400),
      verified: false,
    });
    const newest = await insert({
      state: 'FAILED',
      startedAt: ancient(390),
      finishedAt: ancient(390),
    });

    await context.container.backupRuns.purgeFinishedBefore(CUTOFF, 100);

    const remaining = await ids();
    // The verified one survives, because it is the row the scheduler reads.
    expect(remaining).toContain(verified);
    // The newest finished row survives too, by the other exclusion — stated so a
    // reader can see which clause is doing which job.
    expect(remaining).toContain(newest);
    // And the unverified success does not get to stand in for the verified one.
    expect(remaining).not.toContain(unverified);
  });

  it('protects the most recent FINISHED run even while another is RUNNING', async () => {
    /*
     * The same finding's second half. The exclusion ordered over every state, and a
     * RUNNING row is always the newest — so it absorbed the exclusion meant for "the
     * run being diagnosed", and the newest row an operator can actually READ became
     * eligible whenever a backup happened to be in flight.
     *
     * A RUNNING row needs no protection from this clause: it is already excluded by
     * the state test above, which exists because that row is the installation's
     * backup lock.
     */
    const newestFinished = await insert({
      state: 'FAILED',
      startedAt: ancient(400),
      finishedAt: ancient(400),
    });
    await insert({ state: 'RUNNING', startedAt: ancient(399), finishedAt: null });

    await context.container.backupRuns.purgeFinishedBefore(CUTOFF, 100);

    expect(await ids()).toContain(newestFinished);
  });

  it('removes a finished run that is old enough', async () => {
    // The ordinary case, and it must work or the table has no policy at all.
    // Two rows, because every "most recent" exclusion below would otherwise make
    // the single row ineligible and this case would pass for the wrong reason.
    const old = await insert({
      state: 'SUCCEEDED',
      startedAt: ancient(30),
      finishedAt: ancient(30),
    });
    const recent = await insert({
      state: 'SUCCEEDED',
      startedAt: NOW,
      finishedAt: NOW,
    });

    expect(await runs.purgeFinishedBefore(CUTOFF, 100)).toBe(1);
    expect(await ids()).toEqual([recent]);
    expect(await ids()).not.toContain(old);
  });

  it('keeps a finished run that is newer than the cutoff', async () => {
    // The other direction. Without it a purge that deleted everything would pass
    // the case above.
    await insert({ state: 'SUCCEEDED', startedAt: NOW, finishedAt: NOW });
    await insert({
      state: 'FAILED',
      startedAt: new Date(CUTOFF.getTime() + 24 * 3_600_000),
      finishedAt: new Date(CUTOFF.getTime() + 24 * 3_600_000),
    });

    expect(await runs.purgeFinishedBefore(CUTOFF, 100)).toBe(0);
    expect((await ids()).length).toBe(2);
  });

  it('NEVER removes a RUNNING run, however old', async () => {
    /*
     * The RUNNING row IS the installation's backup lock: the partial unique index
     * is over `(true) WHERE state = 'RUNNING'`. Deleting one releases a lock a
     * process may still be holding, and two concurrent dumps then write the same
     * paths — which is how two partial dumps become one plausible-looking corrupt
     * archive.
     *
     * A run whose process died does not stay RUNNING for ever; `reclaimStale`
     * closes it by FAILING it, which is a different mechanism with its own
     * timeout. Retention must not be a second, slower, less careful version of
     * that.
     */
    const running = await insert({
      state: 'RUNNING',
      startedAt: ancient(400),
      finishedAt: null,
    });
    const old = await insert({
      state: 'SUCCEEDED',
      startedAt: ancient(30),
      finishedAt: ancient(30),
    });
    await insert({ state: 'SUCCEEDED', startedAt: NOW, finishedAt: NOW });

    await runs.purgeFinishedBefore(CUTOFF, 100);
    expect(await ids()).toContain(running);
    expect(await ids()).not.toContain(old);
  });

  it('NEVER removes a run whose delivery outcome was never observed', async () => {
    /*
     * `OUTCOME_UNKNOWN` means Telegram may have accepted an upload whose answer
     * was lost. Nothing resends on it and nothing resolves it automatically, so
     * this row is the only record that an encrypted archive may be sitting in a
     * chat — which is both a recovery asset and, if the chat is wrong, an
     * exposure. `withUnknownDelivery` is what an operator reconciles from.
     *
     * Retained INDEFINITELY, not for longer: there is no age at which an
     * unresolved external side effect becomes safe to forget.
     */
    const unknown = await insert({
      state: 'SUCCEEDED',
      startedAt: ancient(900),
      finishedAt: ancient(900),
      deliveryState: 'OUTCOME_UNKNOWN',
    });
    const old = await insert({
      state: 'SUCCEEDED',
      startedAt: ancient(30),
      finishedAt: ancient(30),
    });
    await insert({ state: 'SUCCEEDED', startedAt: NOW, finishedAt: NOW });

    await runs.purgeFinishedBefore(CUTOFF, 100);
    expect(await ids()).toContain(unknown);
    expect(await ids()).not.toContain(old);
  });

  it('NEVER removes the most recent SUCCEEDED run, even when it is ancient', async () => {
    /*
     * `lastSucceededAt()` reads exactly this row, and the scheduler reads that to
     * decide whether a backup is due. Remove it and the installation believes no
     * backup has ever succeeded: it takes one immediately, and then — because the
     * next row it writes is newer than the interval — settles onto a schedule
     * derived from the deletion rather than from the configuration.
     *
     * An installation that has not succeeded in over a year is in trouble, and
     * deleting the evidence is the worst available response.
     */
    const onlySuccess = await insert({
      state: 'SUCCEEDED',
      startedAt: ancient(500),
      finishedAt: ancient(500),
    });
    const oldFailure = await insert({
      state: 'FAILED',
      startedAt: ancient(30),
      finishedAt: ancient(30),
    });
    await insert({ state: 'FAILED', startedAt: NOW, finishedAt: NOW });

    await runs.purgeFinishedBefore(CUTOFF, 100);
    expect(await ids()).toContain(onlySuccess);
    expect(await ids()).not.toContain(oldFailure);
    // And the scheduler can still read it, which is the property the rule exists
    // for rather than the row's mere presence.
    expect(await runs.lastSucceededAt()).not.toBeNull();
  });

  it('NEVER removes the most recent run of any state', async () => {
    /*
     * The run an operator is looking at when something has just gone wrong. A
     * `backup.run_failed` operational condition is deduped on one
     * installation-wide key and says which run failed; with that run deleted the
     * alert names an id nothing can resolve.
     *
     * Tested on a table where EVERY row is past the cutoff, which is the only
     * arrangement where this rule is the one doing the work.
     */
    const older = await insert({
      state: 'FAILED',
      startedAt: ancient(60),
      finishedAt: ancient(60),
    });
    const newest = await insert({
      state: 'FAILED',
      startedAt: ancient(10),
      finishedAt: ancient(10),
    });

    expect(await runs.purgeFinishedBefore(CUTOFF, 100)).toBe(1);
    expect(await ids()).toEqual([newest]);
    expect(await ids()).not.toContain(older);
  });

  it('respects the batch bound and removes the OLDEST rows first', async () => {
    /*
     * Two rules in one case because they are one rule: a bounded batch with no
     * order takes an arbitrary subset, so the oldest row could survive every pass
     * indefinitely while the table stayed the same size.
     */
    const created: string[] = [];
    for (let day = 100; day >= 91; day -= 1) {
      created.push(
        await insert({ state: 'SUCCEEDED', startedAt: ancient(day), finishedAt: ancient(day) }),
      );
    }
    await insert({ state: 'SUCCEEDED', startedAt: NOW, finishedAt: NOW });

    expect(await runs.purgeFinishedBefore(CUTOFF, 3)).toBe(3);
    const left = await ids();
    // The three oldest are gone; nothing newer was touched.
    expect(left).not.toContain(created[0]);
    expect(left).not.toContain(created[1]);
    expect(left).not.toContain(created[2]);
    expect(left).toContain(created[3]);
  });

  it('drains to the floor over repeated passes, and then stops', async () => {
    // What the sweeper actually does: take batches until one comes back short.
    // The floor is the two protected rows, not zero, and a loop that expected
    // zero would never terminate.
    for (let day = 100; day >= 81; day -= 1) {
      await insert({ state: 'SUCCEEDED', startedAt: ancient(day), finishedAt: ancient(day) });
    }
    let removed = 0;
    let pass = 0;
    for (;;) {
      const n = await runs.purgeFinishedBefore(CUTOFF, 5);
      removed += n;
      pass += 1;
      if (n < 5) break;
      // A loop over a DELETE must not be able to run for ever: a purge that
      // returned a full batch while deleting nothing would hang the sweeper.
      expect(pass).toBeLessThan(20);
    }
    // 20 rows, 19 eligible (the newest is protected, and it is also the newest
    // SUCCEEDED, so the two exclusions name the same row).
    expect(removed).toBe(19);
    expect((await ids()).length).toBe(1);
    expect(await runs.purgeFinishedBefore(CUTOFF, 5)).toBe(0);
  });

  it('is safe with two sweepers running at once', async () => {
    /*
     * Two worker replicas is the normal case on every rolling update. No lock and
     * no coordination: a DELETE of a row another transaction has already deleted
     * matches nothing, so the worst outcome is a batch that removes fewer rows
     * than it asked for — and the caller drains until a batch comes back short.
     *
     * What must NOT happen is a row deleted twice reported as two deletions, or
     * an error. The assertion is on the TOTAL and on the surviving rows, because
     * the split between the two callers is not something either can promise.
     */
    for (let day = 100; day >= 81; day -= 1) {
      await insert({ state: 'SUCCEEDED', startedAt: ancient(day), finishedAt: ancient(day) });
    }
    const [a, b] = await Promise.all([
      runs.purgeFinishedBefore(CUTOFF, 20),
      runs.purgeFinishedBefore(CUTOFF, 20),
    ]);
    expect(a + b).toBe(19);
    expect((await ids()).length).toBe(1);
  });

  it('leaves every other table alone', async () => {
    /*
     * A purge that took a neighbouring table with it is the failure mode worth one
     * cheap assertion. `operational_events` is the neighbour that matters: it holds
     * the conditions these runs opened and it is append-only by trigger.
     *
     * The row is RECORDED here rather than assumed. The first version of this case
     * counted an EMPTY table before and after — nothing in this file opens a
     * condition, because the rows are inserted directly — so it compared 0 to 0 and
     * would have passed if the purge had deleted the whole table. The review of this
     * branch found that. One real row is the difference between a guard and a
     * decoration.
     */
    await context.container.opsLog.record(
      { tenantId: SEED_IDS.tenantA as never, botInstanceId: null },
      { code: 'backup.run_failed', severity: 'ERROR', message: 'a neighbour to preserve' },
    );
    await insert({ state: 'SUCCEEDED', startedAt: ancient(30), finishedAt: ancient(30) });
    await insert({ state: 'SUCCEEDED', startedAt: NOW, finishedAt: NOW });

    const count = async (): Promise<number> => {
      const rows = await context.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM operational_events`,
      );
      return (rows.rows as unknown as readonly { n: number }[])[0]?.n ?? -1;
    };
    const before = await count();
    // The premise, asserted: without this the comparison below is 0 against 0.
    expect(before).toBeGreaterThan(0);

    await runs.purgeFinishedBefore(CUTOFF, 100);

    expect(await count()).toBe(before);
  });
});
