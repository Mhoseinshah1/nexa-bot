import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestContext, type TestContext } from './harness';

/**
 * This branch made the tenant row the serialization boundary for every
 * administrator mutation, and made login and the webhook write take a share
 * lock on that same row. Measured, a burst of 16 mutations moves concurrent
 * logins from ~43ms to ~263ms — which is fine, and only fine because the wait
 * is bounded. Postgres defaults all three of these to 0, meaning wait forever:
 * one transaction stalled while holding the tenant row would block every login
 * for the installation, with no error, until the pool filled with waiters.
 */
describe('database connections wait under a bound', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 60_000);

  afterAll(async () => {
    await ctx.close();
  });

  it('applies the configured timeouts to every pooled connection', async () => {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT current_setting('statement_timeout') AS statement,
                 current_setting('lock_timeout') AS lock,
                 current_setting('idle_in_transaction_session_timeout') AS idle`,
    )) as unknown as { rows: { statement: string; lock: string; idle: string }[] };

    const [settings] = rows.rows ?? (rows as unknown as { statement: string }[]);
    expect(settings).toBeDefined();
    // Reported by Postgres in its own units, never as "0" — which is the
    // default and the thing this exists to prevent.
    expect(settings!.statement).not.toBe('0');
    expect((settings as unknown as { lock: string }).lock).not.toBe('0');
    expect((settings as unknown as { idle: string }).idle).not.toBe('0');
  }, 30_000);

  it('fails a lock wait instead of queueing behind it forever', async () => {
    // Hold the tenant row exclusively from one connection, then ask for it from
    // another. Without `lock_timeout` the second waits for as long as the first
    // holds it, which is unbounded when the holder is stalled application code.
    const tenantId = ctx.container.installationTenantId ?? null;
    const holder = ctx.container.database.pool;

    const client = await holder.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM tenants LIMIT 1 FOR UPDATE');

      const started = Date.now();
      const outcome = await ctx.container.database.db
        .execute(sql`SELECT id FROM tenants LIMIT 1 FOR UPDATE`)
        .then(
          () => null,
          (error: unknown) => error,
        );
      const waited = Date.now() - started;

      expect(outcome).not.toBeNull();
      // 55P03 is `lock_not_available` — Postgres refusing the wait, which is
      // the whole point. Drizzle wraps the message, so the driver's own code is
      // what identifies it; matching on text would pass for any failure.
      const code =
        (outcome as { cause?: { code?: string }; code?: string }).cause?.code ??
        (outcome as { code?: string }).code;
      expect(code).toBe('55P03');
      // Bounded by the configured `lock_timeout`, not by the holder letting go.
      expect(waited).toBeGreaterThanOrEqual(ctx.container.config.DATABASE_LOCK_TIMEOUT_MS - 500);
      expect(waited).toBeLessThan(ctx.container.config.DATABASE_LOCK_TIMEOUT_MS + 5_000);
      expect(tenantId).toBeDefined();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }, 60_000);
});
