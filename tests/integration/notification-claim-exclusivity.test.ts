import { Client } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, testConfig, type TestContext } from './harness';

/**
 * Migration 0014's invariant, tested through raw SQL and through two genuinely
 * concurrent transactions.
 *
 * The invariant: an attempt number is EITHER spent (a delivery attempt reached
 * the transport) OR returned (its claim was handed back), never both. A number
 * carrying both records counts as returned while its attempt row says it was
 * sent, so a bounded retry becomes an unbounded one.
 *
 * It is enforced in the database because both tables are append-only and the
 * application-level argument — "one worker owns a claim" — is a claim about
 * how callers behave, not a property the database holds.
 *
 * These tests use raw SQL deliberately. The repository methods have their own
 * guards, so exercising them proves the guards in TypeScript and says nothing
 * about the ones in PostgreSQL. Anything that ever writes these tables — a
 * future service, a migration, an operator with psql — meets only the latter.
 */
describe('notification claim exclusivity (0014, serialised by 0016)', () => {
  let ctx: TestContext;
  const url = () => testConfig().DATABASE_URL;

  let tenantId: string;
  let notificationId: string;

  const attemptSql = `
    INSERT INTO notification_delivery_attempts
      (id, tenant_id, notification_id, attempt_number, transport, outcome, started_at, finished_at,
       error_code, error_message)
    VALUES (gen_random_uuid(), $1, $2, $3, 'TELEGRAM', $4, now(), now(), $5, $6)`;
  const releaseSql = `
    INSERT INTO notification_released_claims
      (tenant_id, notification_id, attempt_number, released_at, reason)
    VALUES ($1, $2, $3, now(), $4)`;

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
    const db = ctx.container.database.db;
    const client = new Client(url());
    await client.connect();
    try {
      const tenant = await client.query(`SELECT id FROM tenants WHERE kind = 'PRIMARY' LIMIT 1`);
      tenantId = String(tenant.rows[0].id);
      const created = await client.query(
        `INSERT INTO notifications (id, tenant_id, kind, dedupe_key, destination, payload,
                                    template_key, max_attempts)
         VALUES (gen_random_uuid(), $1, 'OPERATIONS_TEST', $2, '{}'::jsonb, '{}'::jsonb,
                 'ops.test', 5)
         RETURNING id`,
        [tenantId, `exclusivity-${Date.now()}-${Math.random()}`],
      );
      notificationId = String(created.rows[0].id);
    } finally {
      await client.end();
    }
    void db;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const withClient = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
    const client = new Client(url());
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  };

  it('refuses an attempt on a number whose claim was returned', async () => {
    await withClient(async (c) => {
      await c.query(releaseSql, [tenantId, notificationId, 1, 'worker.handback']);
      await expect(
        c.query(attemptSql, [tenantId, notificationId, 1, 'SUCCEEDED', null, null]),
      ).rejects.toThrow(/was released/);
    });
  });

  it('refuses a returned claim on a number that reached the transport', async () => {
    await withClient(async (c) => {
      await c.query(attemptSql, [tenantId, notificationId, 1, 'SUCCEEDED', null, null]);
      await expect(
        c.query(releaseSql, [tenantId, notificationId, 1, 'worker.handback']),
      ).rejects.toThrow(/reached the transport/);
    });
  });

  it('permits the sweep withdrawing its own verdict, and nothing else', async () => {
    await withClient(async (c) => {
      // failExhausted writes a synthetic FAILED_PERMANENT attempt to record the
      // verdict it reached; a later hand-back retires that number because
      // nothing was ever sent on it. Both halves are deliberate.
      await c.query(attemptSql, [
        tenantId,
        notificationId,
        1,
        'FAILED_PERMANENT',
        'notification.attempts_exhausted',
        'exhausted',
      ]);
      await c.query(releaseSql, [tenantId, notificationId, 1, 'sweep.withdrawn']);

      // The carve-out is narrow: the same attempt row does not admit a
      // different reason.
      await c.query(attemptSql, [
        tenantId,
        notificationId,
        2,
        'FAILED_PERMANENT',
        'notification.attempts_exhausted',
        'exhausted',
      ]);
      await expect(
        c.query(releaseSql, [tenantId, notificationId, 2, 'worker.handback']),
      ).rejects.toThrow(/reached the transport/);
    });
  });

  /**
   * Two transactions in flight at once.
   *
   * Before 0016 this passed both inserts: under READ COMMITTED neither
   * statement can see the other's uncommitted row, so both `EXISTS` checks
   * found nothing and both committed — leaving one attempt number both spent
   * and returned, which is exactly the state 0014 exists to prevent.
   *
   * The barrier is a real condition, not a delay: the second transaction is
   * observed WAITING on the advisory lock in `pg_locks` before the first is
   * allowed to commit. A sleep would prove only that a slow second writer
   * loses, which is the case that was never in doubt.
   */
  const runRace = async (
    first: (c: Client) => Promise<unknown>,
    second: (c: Client) => Promise<unknown>,
  ) => {
    const a = new Client(url());
    const b = new Client(url());
    await a.connect();
    await b.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await first(a);

      // Started, NOT awaited: it must block inside the trigger.
      let secondError: unknown;
      const pending = second(b).catch((error: unknown) => {
        secondError = error;
      });

      // The barrier. `pg_advisory_xact_lock` shows up as an ungranted
      // `advisory` lock for as long as the second transaction is waiting.
      const waiting = async () => {
        const { rows } = await a.query(
          `SELECT count(*)::int AS n FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted`,
        );
        return rows[0].n > 0;
      };
      const deadline = Date.now() + 10_000;
      while (!(await waiting())) {
        if (Date.now() > deadline) throw new Error('the second writer never blocked on the lock');
      }

      await a.query('COMMIT');
      await pending;
      try {
        await b.query('COMMIT');
      } catch {
        /* the failed statement already aborted it */
      }
      await b.query('ROLLBACK').catch(() => undefined);
      return secondError;
    } finally {
      await a.end();
      await b.end();
    }
  };

  const counts = async () =>
    withClient(async (c) => {
      const { rows } = await c.query(
        `SELECT (SELECT count(*)::int FROM notification_delivery_attempts
                  WHERE notification_id = $1) AS attempts,
                (SELECT count(*)::int FROM notification_released_claims
                  WHERE notification_id = $1) AS releases`,
        [notificationId],
      );
      return rows[0] as { attempts: number; releases: number };
    });

  it('a concurrent release cannot slip past an attempt that has not committed', async () => {
    const error = await runRace(
      (c) => c.query(attemptSql, [tenantId, notificationId, 1, 'SUCCEEDED', null, null]),
      (c) => c.query(releaseSql, [tenantId, notificationId, 1, 'worker.handback']),
    );
    expect(error, 'the concurrent release was accepted').toBeDefined();
    expect(String(error)).toMatch(/reached the transport/);
    expect(await counts()).toEqual({ attempts: 1, releases: 0 });
  });

  it('a concurrent attempt cannot slip past a release that has not committed', async () => {
    const error = await runRace(
      (c) => c.query(releaseSql, [tenantId, notificationId, 1, 'worker.handback']),
      (c) => c.query(attemptSql, [tenantId, notificationId, 1, 'SUCCEEDED', null, null]),
    );
    expect(error, 'the concurrent attempt was accepted').toBeDefined();
    expect(String(error)).toMatch(/was released/);
    expect(await counts()).toEqual({ attempts: 0, releases: 1 });
  });
});
