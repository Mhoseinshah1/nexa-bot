import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import type { Container } from '../../apps/api/src/container';
import { ReadinessProbe } from '../../apps/api/src/surfaces/web/readiness.probe';
import { createTestContext, type TestContext } from './harness';

/**
 * The readiness probe against a real database (C14, C15).
 *
 * C14: "some migration exists" is not "the schema this code expects". The
 * migrations table is edited in place here — rows removed, a hash altered, a
 * future row added — and put back exactly afterwards. Integration files run
 * one at a time against this database, so nothing else observes the edit.
 *
 * C15: a probe that times out must STOP the query it was waiting on. The slow
 * operation is a real `pg_sleep` on the probe's own checked-out connection,
 * and the proof is asked of PostgreSQL: after the probe reports `timeout`,
 * no such statement is still running, and the pool has every connection back.
 */

describe('readiness reflects the migration state this release expects', () => {
  let ctx: TestContext;
  let snapshot: { hash: string; created_at: string }[];

  const migrations = () =>
    ctx.container.database.withClient((client) =>
      client.query<{ hash: string; created_at: string }>(
        'SELECT hash, created_at::text AS created_at FROM drizzle.__drizzle_migrations ORDER BY created_at',
      ),
    );

  beforeAll(async () => {
    ctx = await createTestContext();
    snapshot = (await migrations()).rows;
    expect(snapshot.length).toBeGreaterThanOrEqual(20);
  });

  afterEach(async () => {
    // Put the table back EXACTLY, whatever the test did to it.
    await ctx.container.database.withClient(async (client) => {
      await client.query('DELETE FROM drizzle.__drizzle_migrations');
      for (const row of snapshot) {
        await client.query(
          'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
          [row.hash, row.created_at],
        );
      }
    });
    expect((await migrations()).rows).toEqual(snapshot);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const probe = () => new ReadinessProbe(ctx.container);
  const migrationsStatus = async () =>
    (await probe().run()).dependencies.find((d) => d.name === 'migrations')!;

  it('is ready against the exact expected set', async () => {
    const status = await migrationsStatus();
    expect(status.status).toBe('up');
    expect(status.detail).toBe(`${snapshot.length} applied`);
  });

  it('is not ready with zero migrations', async () => {
    await ctx.container.database.db.execute(sql`DELETE FROM drizzle.__drizzle_migrations`);
    const status = await migrationsStatus();
    expect(status.status).toBe('down');
    expect(status.detail).toBe('no migrations applied');
  });

  it('is not ready with only the first migration', async () => {
    // The state that `applied > 0` accepted.
    await ctx.container.database.db.execute(
      sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at <> (SELECT min(created_at) FROM drizzle.__drizzle_migrations)`,
    );
    const status = await migrationsStatus();
    expect(status.status).toBe('down');
    expect(status.detail).toMatch(/^behind: 1 of \d+ applied, next 0001_/);
  });

  it('is not ready one migration short', async () => {
    await ctx.container.database.db.execute(
      sql`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM drizzle.__drizzle_migrations)`,
    );
    const status = await migrationsStatus();
    expect(status.status).toBe('down');
    expect(status.detail).toContain(`behind: ${snapshot.length - 1} of ${snapshot.length}`);
  });

  it('is not ready when a migration was applied with different content', async () => {
    await ctx.container.database.db.execute(
      sql`UPDATE drizzle.__drizzle_migrations SET hash = 'not-what-this-release-ships' WHERE created_at = (SELECT max(created_at) FROM drizzle.__drizzle_migrations)`,
    );
    const status = await migrationsStatus();
    expect(status.status).toBe('down');
    expect(status.detail).toMatch(/^diverged: /);
  });

  it('stays ready when the database is ahead of this release, so a rollback is not refused', async () => {
    await ctx.container.database.db.execute(
      sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('from-a-newer-release', 9999999999999)`,
    );
    const status = await migrationsStatus();
    expect(status.status).toBe('up');
    expect(status.detail).toContain('1 newer than this release');
  });
});

describe('a readiness timeout stops the query it was waiting on', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    // A pool of TWO, so a probe that leaked its connections would show up
    // within a couple of runs rather than being absorbed by a pool of ten.
    ctx = await createTestContext({ DATABASE_POOL_MAX: '2' });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  /**
   * The container, with every probe checkout made slow: `pg_sleep(20)` runs on
   * the checked-out connection BEFORE the probe's own query. Everything else
   * — the pool, the timeout the probe sets, the release — is the real one.
   */
  const slowContainer = (): Container => ({
    ...ctx.container,
    database: {
      ...ctx.container.database,
      withClient: (fn, options) =>
        ctx.container.database.withClient(async (client: PoolClient) => {
          await client.query('SELECT pg_sleep(20)');
          return fn(client);
        }, options),
    },
  });

  const sleepingStatements = async () =>
    (
      await ctx.container.database.withClient((client) =>
        client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM pg_stat_activity
            WHERE state = 'active' AND query LIKE '%pg_sleep(20)%' AND pid <> pg_backend_pid()`,
        ),
      )
    ).rows[0]!.n;

  it('reports the timeout and leaves no statement running', async () => {
    const started = Date.now();
    const result = await new ReadinessProbe(slowContainer()).run();
    const elapsed = Date.now() - started;

    const postgres = result.dependencies.find((d) => d.name === 'postgres')!;
    expect(postgres.status).toBe('down');
    expect(postgres.detail).toBe('timeout');
    expect(elapsed).toBeLessThan(ReadinessProbe.PROBE_TIMEOUT_MS + 2_500);

    // THE assertion. The race returned on time either way; what matters is
    // that PostgreSQL is no longer running the sleep on our behalf. Without
    // the statement timeout on the checkout, this counts the orphans.
    expect(Number(await sleepingStatements())).toBe(0);
    // The connections came back. `withClient` here is the REAL one and
    // borrows from the same pool of two; it hangs if both are still held.
    await expect(
      Promise.race([
        ctx.container.database.withClient((client) => client.query('SELECT 1')),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('the pool did not get its connections back')), 3_000),
        ),
      ]),
    ).resolves.toBeDefined();
  }, 20_000);

  it('does not accumulate active queries across repeated timeouts', async () => {
    for (let round = 0; round < 3; round += 1) {
      const result = await new ReadinessProbe(slowContainer()).run();
      expect(result.degraded).toBe(true);
    }
    expect(Number(await sleepingStatements())).toBe(0);
    expect(ctx.container.database.pool.totalCount).toBeLessThanOrEqual(2);
    expect(ctx.container.database.pool.waitingCount).toBe(0);
    // And the pool still serves ordinary work promptly.
    const started = Date.now();
    await ctx.container.database.withClient((client) => client.query('SELECT 1'));
    expect(Date.now() - started).toBeLessThan(1_000);
  }, 40_000);

  it('leaves the pool timeout in place for the next borrower', async () => {
    // `RESET` after the probe, or every later query on that connection runs
    // under a three-second cap nothing would explain.
    await new ReadinessProbe(slowContainer()).run();
    const setting = await ctx.container.database.withClient(async (client) => {
      const result = await client.query<{ v: string }>(
        "SELECT current_setting('statement_timeout') AS v",
      );
      return result.rows[0]!.v;
    });
    expect(setting).not.toBe(`${ReadinessProbe.PROBE_TIMEOUT_MS}ms`);
    expect(setting).not.toBe('0');
  }, 20_000);

  it('is unchanged on the success path', async () => {
    const result = await new ReadinessProbe(ctx.container).run();
    expect(result.degraded).toBe(false);
    for (const dependency of result.dependencies) {
      expect(dependency.status, `${dependency.name}: ${dependency.detail ?? ''}`).toBe('up');
    }
  });
});
