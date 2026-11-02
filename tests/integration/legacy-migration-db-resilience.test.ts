import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DrizzleQueryError, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CorrelationId } from '@nexa/contracts';
import { createDatabase } from '../../apps/api/src/infrastructure/persistence/database';
import { databaseProfileFor } from '../../apps/api/src/infrastructure/persistence/database-profile';
import { runAsLegacyMigration } from '../../apps/api/src/infrastructure/persistence/write-gate';
import { LegacyMigrationExecutor } from '../../apps/api/src/modules/platform/legacy-migration/application/legacy-migration-executor';
import type {
  LegacyMigrationLeasePort,
  MigrationRunner,
  PackageVerifier,
} from '../../apps/api/src/modules/platform/legacy-migration/application/ports';
import { errorKind } from '../../apps/api/src/modules/platform/legacy-migration/domain/import-lifecycle';
import { DrizzleLegacyNxpkgImportRepository } from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/drizzle-legacy-nxpkg-import.repository';
import { isTransientDatabaseFailure } from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/transient-database-failure';
import { MigrationRig, type RigLogLine } from '../support/legacy-migration-rig';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  testConfig,
  type TestContext,
} from './harness';

/**
 * The v0.9.3 field failure of the Mirza import (a 197k-customer package, a slow disk), over a
 * real PostgreSQL: the import's own fan-out filled its connection pool, a checkout waited more
 * than the request path's five seconds, and pg-pool rejected it client-side — `DrizzleQueryError`
 * with code null, whose CAUSE is `timeout exceeded when trying to connect`. The lease heartbeat
 * and release shared that pool and failed with it.
 *
 * What this file pins, against real pools and a real executor:
 * - the root cause itself (a full pool, a five-second checkout) and that the `migration` role's
 *   profile outlasts it;
 * - a transient connection failure inside a step runs the step again in place;
 * - a heartbeat that cannot get a connection costs a warning, never the import or its lease;
 * - a failure's log record carries the cause's type, code and message-class and never the SQL
 *   text or a bound value.
 *
 * SYNTHETIC data only. NOT EVIDENCE.
 */

const POOL_MESSAGE = 'timeout exceeded when trying to connect';
/** Longer than the request path's 5 s checkout, shorter than the migration role's 120 s. */
const HOLD_MS = 6_500;

const verifyReport = (): Awaited<ReturnType<PackageVerifier['verify']>> => ({
  packageImportId: 'pkg-resilience-1',
  sourceFingerprint: 'c'.repeat(64),
  packageSchemaVersion: '1.4.0',
  converterVersion: '0.5.0',
  synthetic: true,
  panelTargets: [{ codePanel: 'P1', providerType: 'rickpanel', services: 1 }],
  recordCounts: [{ code: 'user', count: 2 }],
  decisions: null,
});

const DATABASE_URL = testConfig().DATABASE_URL;

describe('legacy migration: the import survives a slow disk', () => {
  let ctx: TestContext;
  let work: string;
  let migrationRoot: string;
  let rig: MigrationRig;

  const db = () => ctx.container.database.db;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'lmig-resil-'));
    migrationRoot = await mkdtemp(join(tmpdir(), 'lmig-resil-root-'));
    ctx = await createTestContext({
      LEGACY_MIGRATION_ENABLED: 'true',
      LEGACY_MIGRATION_WORK_DIR: migrationRoot,
      BACKUP_WORK_DIR: work,
    });
    rig = new MigrationRig(ctx, migrationRoot);
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    for (const dir of [work, migrationRoot]) await rm(dir, { recursive: true, force: true });
  });

  /** An UPLOADED import with its key: the executor's next tick verifies it. */
  async function uploadedImport(): Promise<string> {
    await ctx.reset();
    rig.owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-resil', roleKeys: ['owner'] }),
    );
    const path = join(work, 'resilience.nxpkg');
    await writeFile(path, randomBytes(512));
    const id = await rig.upload(path);
    await rig.setKey(id, { passphrase: 'a passphrase nobody may read back' });
    return id;
  }

  async function importRow(id: string) {
    const rows = await db().execute<Record<string, unknown>>(
      sql`SELECT status, claimed_by, lease_until, progress FROM legacy_nxpkg_imports WHERE id = ${id}`,
    );
    return rows.rows[0] as {
      status: string;
      claimed_by: string | null;
      lease_until: Date | null;
      progress: { verifyAttempts: number };
    };
  }

  function executorOf(options: {
    readonly verify: PackageVerifier['verify'];
    readonly lines: RigLogLine[];
    readonly leases?: LegacyMigrationLeasePort;
    readonly heartbeatMs?: number;
    readonly sleeps?: number[];
    readonly retryDelays?: readonly number[];
  }): LegacyMigrationExecutor {
    const container = ctx.container;
    const keep =
      (level: RigLogLine['level']) => (context: Record<string, unknown>, message: string) => {
        options.lines.push({ level, context, message });
      };
    const unused = new Proxy(
      {},
      {
        get: (_target, name) => () => {
          throw new Error(`the ${String(name)} port is not exercised here`);
        },
      },
    ) as MigrationRunner;
    return new LegacyMigrationExecutor({
      repository: container.legacyNxpkgImports,
      workspaces: container.migrationWorkspaces,
      cipher: container.cipher,
      verifier: { verify: options.verify },
      runner: unused,
      freshTarget: { check: async () => ({ fresh: true }) },
      history: { ingest: async () => ({ counts: [] }) },
      materialize: container.legacyMaterializePort,
      botLink: container.legacyBotLinkPort,
      backup: {
        runBeforeImport: async () => ({
          outcome: 'TAKEN',
          runId: '019600ab-cdef-7012-8345-6789abcd9999',
        }),
        runAfterImport: async () => ({ outcome: 'SKIPPED_QUIESCED', runId: null }),
      },
      recoveryActive: async () => false,
      latestCutoverAt: async () => null,
      asImportWriter: runAsLegacyMigration,
      clock: container.clock,
      correlation: () => 'corr-resilience' as CorrelationId,
      leaseOwner: 'migration:resilience',
      tickIntervalMs: 1000,
      enabled: true,
      logger: { info: keep('info'), warn: keep('warn'), error: keep('error') },
      isTransientFailure: isTransientDatabaseFailure,
      transientRetryDelaysMs: options.retryDelays ?? [7, 11],
      releaseRetryDelaysMs: [3, 5],
      // No real waiting: the delays are recorded, not slept.
      sleep: async (ms) => {
        options.sleeps?.push(ms);
      },
      ...(options.leases === undefined ? {} : { leases: options.leases }),
      ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    });
  }

  /** A pool of one connection that is checked out for good: any query on it times out in 250 ms. */
  function exhaustedPool() {
    const handle = createDatabase(DATABASE_URL, 1, undefined, undefined, {
      connectionTimeoutMs: 250,
    });
    const held = handle.pool.connect();
    return {
      handle,
      async close() {
        (await held).release();
        await handle.close();
      },
    };
  }

  // --- 1. the root cause, and the profile that outlasts it ---------------------------------

  it('a pool its own fan-out filled times a checkout out at 5 s; the migration profile waits it out', async () => {
    const config = testConfig();
    const requestPath = databaseProfileFor('worker', config);
    const migration = databaseProfileFor('migration', config);
    // The profile itself: the request path keeps five seconds, the import role far more than the hold.
    expect(requestPath.pool.connectionTimeoutMs).toBe(5_000);
    expect(migration.pool.connectionTimeoutMs).toBeGreaterThan(HOLD_MS * 2);

    const open = (profile: typeof migration) =>
      createDatabase(DATABASE_URL, 2, profile.timeouts, undefined, profile.pool);
    const old = open(requestPath);
    const fresh = open(migration);
    try {
      // Every connection of each pool busy for longer than five seconds (a checkpoint holding
      // the disk, in the field): the import's own queries are what fill the pool.
      const fill = (handle: typeof old) =>
        [1, 2].map(() => handle.pool.query('SELECT pg_sleep($1)', [HOLD_MS / 1000]));
      const busy = [...fill(old), ...fill(fresh)];
      const probe = async (handle: typeof old) => {
        const started = Date.now();
        const outcome = await new DrizzleLegacyNxpkgImportRepository(handle.db)
          .byIdUnscoped('019600ab-cdef-7012-8345-6789abcd0001')
          .then(
            () => ({ error: null as unknown }),
            (error: unknown) => ({ error }),
          );
        return { ...outcome, waitedMs: Date.now() - started };
      };
      const [before, after] = await Promise.all([probe(old), probe(fresh)]);
      await Promise.all(busy);

      // The OLD five-second bound: the field failure, reproduced exactly.
      expect(before.error).toBeInstanceOf(DrizzleQueryError);
      const cause = (before.error as DrizzleQueryError).cause;
      expect(cause?.message).toBe(POOL_MESSAGE);
      expect((before.error as { code?: unknown }).code).toBeUndefined();
      expect(errorKind(before.error)).toMatchObject({
        type: 'DrizzleQueryError',
        code: null,
        cause: [{ message: POOL_MESSAGE }],
      });
      expect(isTransientDatabaseFailure(before.error)).toBe(true);
      expect(before.waitedMs).toBeGreaterThanOrEqual(4_900);
      expect(before.waitedMs).toBeLessThan(HOLD_MS);

      // The migration role's profile: the same checkout waits for the busy connections and succeeds.
      expect(after.error).toBeNull();
      expect(after.waitedMs).toBeGreaterThanOrEqual(5_000);
    } finally {
      await Promise.all([old.close(), fresh.close()]);
    }
  }, 60_000);

  // --- 1b. a transient failure inside a step runs it again in place -----------------------

  it('retries a step that met a real pool timeout in place, and the import still reaches VERIFIED', async () => {
    const id = await uploadedImport();
    const exhausted = exhaustedPool();
    const lines: RigLogLine[] = [];
    const sleeps: number[] = [];
    let attempts = 0;
    try {
      const executor = executorOf({
        lines,
        sleeps,
        verify: async () => {
          attempts += 1;
          // First try: a REAL checkout timeout from a full pool, wrapped by drizzle as in the field.
          if (attempts === 1)
            await new DrizzleLegacyNxpkgImportRepository(exhausted.handle.db).active(
              tenantA.tenantId,
            );
          return verifyReport();
        },
      });
      await executor.tick();
    } finally {
      await exhausted.close();
    }
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([7]);
    const stored = await importRow(id);
    expect(stored).toMatchObject({ status: 'VERIFIED', claimed_by: null });
    // The attempt the stalled try took is given back, so a slow disk does not spend the bound.
    expect(stored.progress.verifyAttempts).toBe(1);
    const retry = lines.find((line) => line.message.includes('runs again in place'));
    expect(retry?.level).toBe('warn');
    expect(retry?.context).toMatchObject({
      retry: 1,
      delayMs: 7,
      err: { type: 'DrizzleQueryError', cause: [{ message: POOL_MESSAGE }] },
    });
  }, 30_000);

  it('does not retry a failure that is not a connection failure', async () => {
    const id = await uploadedImport();
    const lines: RigLogLine[] = [];
    const sleeps: number[] = [];
    let attempts = 0;
    const executor = executorOf({
      lines,
      sleeps,
      verify: async () => {
        attempts += 1;
        await db().execute(sql`SELECT * FROM a_table_that_does_not_exist`);
        return verifyReport();
      },
    });
    await executor.tick();
    expect(attempts).toBe(1);
    expect(sleeps).toEqual([]);
    expect(await importRow(id)).toMatchObject({ status: 'VERIFYING', claimed_by: null });
  }, 30_000);

  // --- 2. a heartbeat that cannot connect does not abort a healthy import ------------------

  it('a heartbeat on an exhausted lease pool logs a warning; the step completes and the lease holds', async () => {
    const id = await uploadedImport();
    const exhausted = exhaustedPool();
    const lines: RigLogLine[] = [];
    let beats = 0;
    const real = new DrizzleLegacyNxpkgImportRepository(exhausted.handle.db);
    const leases: LegacyMigrationLeasePort = {
      heartbeat: (input) => {
        beats += 1;
        return real.heartbeat(input);
      },
      release: (input) => real.release(input),
    };
    let during: Awaited<ReturnType<typeof importRow>> | null = null;
    try {
      const executor = executorOf({
        lines,
        leases,
        heartbeatMs: 40,
        verify: async () => {
          // The step runs on the main pool for long enough for several heartbeats to fail.
          await new Promise((resolve) => setTimeout(resolve, 900));
          during = await importRow(id);
          return verifyReport();
        },
      });
      await executor.tick();
    } finally {
      await exhausted.close();
    }
    expect(beats).toBeGreaterThanOrEqual(2);
    // The lease is the executor's all through the step, and the import is not aborted.
    expect(during).toMatchObject({ status: 'VERIFYING', claimed_by: 'migration:resilience' });
    expect(await importRow(id)).toMatchObject({ status: 'VERIFIED', claimed_by: null });
    const failed = lines.filter(
      (line) => line.message === 'a legacy migration lease heartbeat failed',
    );
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0]?.level).toBe('warn');
    expect(failed[0]?.context).toMatchObject({
      err: { type: 'DrizzleQueryError', cause: [{ message: POOL_MESSAGE }] },
    });
    expect(lines.some((line) => line.message.includes('no longer this process'))).toBe(false);
    expect(lines.filter((line) => line.level === 'error')).toEqual([]);
  }, 30_000);

  it('a release that cannot connect is retried, then logged; it never throws out of the tick', async () => {
    const id = await uploadedImport();
    const exhausted = exhaustedPool();
    const lines: RigLogLine[] = [];
    const sleeps: number[] = [];
    const real = new DrizzleLegacyNxpkgImportRepository(exhausted.handle.db);
    try {
      const executor = executorOf({
        lines,
        sleeps,
        leases: { heartbeat: async () => true, release: (input) => real.release(input) },
        verify: async () => {
          throw new Error('an unclassified failure of the step itself');
        },
      });
      await expect(executor.tick()).resolves.toBeUndefined();
    } finally {
      await exhausted.close();
    }
    expect(sleeps).toEqual([3, 5]);
    expect(
      lines.filter((line) => line.message.includes('lease release met a transient')),
    ).toHaveLength(2);
    const failed = lines.find((line) => line.message === 'a lease release failed');
    expect(failed?.level).toBe('error');
    // The lease is left to lapse and the sweep; the import is where it was.
    expect(await importRow(id)).toMatchObject({
      status: 'VERIFYING',
      claimed_by: 'migration:resilience',
    });
  }, 30_000);

  // --- 3. the failure log: the cause's kind, never the SQL or a value ----------------------

  it('logs the cause type, code and message class of a failed step, never the SQL text or a bound value', async () => {
    await uploadedImport();
    const lines: RigLogLine[] = [];
    const secret = 'secret-value-5550001234';
    let call = 0;
    const executor = executorOf({
      lines,
      verify: async () => {
        call += 1;
        if (call === 1) {
          // 22P02: the server quotes the bound value in its own primary message.
          await db().execute(sql`SELECT ${secret}::uuid AS leaked_column_alias`);
        }
        // 23505: the server's DETAIL carries the key, and the statement carries both values.
        await db().transaction(async (tx) => {
          await tx.execute(sql`CREATE TEMP TABLE leak_probe (v text UNIQUE) ON COMMIT DROP`);
          await tx.execute(sql`INSERT INTO leak_probe (v) VALUES (${secret})`);
          await tx.execute(sql`INSERT INTO leak_probe (v) VALUES (${secret})`);
        });
        return verifyReport();
      },
    });
    await executor.tick();
    await executor.tick();

    const failures = lines.filter((line) => line.message.includes('failed unexpectedly'));
    expect(failures).toHaveLength(2);
    expect(failures.map((line) => line.context['err'])).toMatchObject([
      { type: 'DrizzleQueryError', code: null, cause: [{ type: 'DatabaseError', code: '22P02' }] },
      { type: 'DrizzleQueryError', code: null, cause: [{ type: 'DatabaseError', code: '23505' }] },
    ]);
    const everything = JSON.stringify(lines);
    for (const leaked of [
      secret,
      '5550001234',
      'leaked_column_alias',
      'CREATE TEMP',
      'VALUES',
      'INSERT INTO',
      'SELECT',
      '$1',
      'already exists',
      'Key (',
    ]) {
      expect(everything, leaked).not.toContain(leaked);
    }
  }, 30_000);
});
