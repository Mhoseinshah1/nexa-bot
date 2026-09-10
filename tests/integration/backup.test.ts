import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BackupManifest } from '@nexa/contracts';
import { createTestContext, testConfig, type TestContext } from './harness';
import { SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { checksumFile } from '../../apps/api/src/modules/platform/backup/infrastructure/archive';
import { PostgresDatabaseTools } from '../../apps/api/src/modules/platform/backup/infrastructure/pg-tools';
import { FilesystemBackupWorkspaces } from '../../apps/api/src/modules/platform/backup/infrastructure/workspace';
import { BackupService } from '../../apps/api/src/modules/platform/backup/application/backup.service';
import { cmdRun, pointAtInstallation } from '../../apps/api/src/backup.cli';
import type { DeliveryAttempt } from '../../apps/api/src/modules/platform/backup/application/ports';

/**
 * The backup pipeline against a real PostgreSQL, a real `pg_dump` and a real
 * `pg_restore`.
 *
 * This file exists because the unit tests cannot prove the one claim that
 * matters: that the artifact can be turned back into a database. Everything
 * here goes through the real tools, the real archive format and the real
 * partial unique index — no fake stands in for any of them.
 */

function urlFor(database: string): string {
  const url = new URL(testConfig().DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function maintenance<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: urlFor('postgres') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function databaseExists(name: string): Promise<boolean> {
  return maintenance(async (client) => {
    const result = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    return result.rowCount === 1;
  });
}

describe('backup against a real database', () => {
  let context: TestContext;
  let workDir: string;
  /** Every delivery attempt, so "was it delivered" is a fact and not a spy. */
  let delivered: { kind: 'document' | 'message'; caption: string; bytes: number }[];
  let nextDelivery: DeliveryAttempt;
  let deliveryConfigured: boolean;

  beforeAll(async () => {
    context = await createTestContext();
  }, 60_000);

  afterAll(async () => {
    await context.close();
    await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await context.reset();
    workDir = await mkdtemp(join(tmpdir(), 'nexa-backup-it-'));
    delivered = [];
    nextDelivery = { state: 'SUCCEEDED', detail: null };
    deliveryConfigured = true;
  });

  /**
   * A service wired to the REAL tools, archive and repository.
   *
   * Only the Telegram transport is substituted, and only because delivering to
   * Telegram from a test would need an account and a network. Everything it
   * records — the caption, the byte count, whether a document or a message went
   * — is asserted from the artifact on disk, so the substitution cannot hide a
   * pipeline that delivered the wrong thing.
   */
  function service(overrides: { leaseOwner?: string; workDir?: string } = {}): BackupService {
    const config = testConfig();
    const tools = new PostgresDatabaseTools({
      databaseUrl: config.DATABASE_URL,
      dumpTimeoutMs: 120_000,
      restoreTimeoutMs: 120_000,
    });
    return new BackupService({
      runs: context.container.backupRuns,
      tools,
      archiver: context.container.backupArchiver,
      workspaces: new FilesystemBackupWorkspaces(overrides.workDir ?? workDir),
      delivery: {
        get configured() {
          return deliveryConfigured;
        },
        async sendDocument(input) {
          const { size } = await stat(input.archivePath);
          // Read the bytes that would go over the wire, so the "no plaintext is
          // ever delivered" assertion is about the actual file rather than
          // about a path string.
          const bytes = await readFile(input.archivePath);
          delivered.push({ kind: 'document', caption: input.caption, bytes: size });
          deliveredBodies.push(bytes);
          return nextDelivery;
        },
        async sendMessage(text) {
          delivered.push({ kind: 'message', caption: text, bytes: 0 });
          return nextDelivery;
        },
      },
      clock: context.container.clock,
      ids: context.container.ids,
      installationId: () => 'integration-installation',
      // The REAL recorder and the seeded tenant, so a failed run's condition is
      // written to the real `operational_events` table with its real dedupe and
      // recovery semantics rather than to a fake that agrees with itself.
      opsLog: context.container.opsLog,
      scope: () => ({ tenantId: SEED_IDS.tenantA as never, botInstanceId: null }),
      logger: { info() {}, warn() {}, error() {} },
      leaseOwner: overrides.leaseOwner ?? `test:${randomBytes(4).toString('hex')}`,
      retainedArchiveHint: workDir,
    });
  }

  const deliveredBodies: Buffer[] = [];

  it('dumps, checksums, encrypts, restores into a scratch database and delivers', async () => {
    const outcome = await service().run('MANUAL');
    expect(outcome.kind).toBe('COMPLETED');
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
    const run = outcome.run;

    expect(run.state).toBe('SUCCEEDED');
    expect(run.stage).toBe('CLEANUP');
    // A real dump of a real migrated database is not small, and is certainly
    // not zero — the failure that would restore perfectly and hold nothing.
    expect(Number(run.dumpBytes)).toBeGreaterThan(10_000);
    expect(run.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(run.verifiedAt).not.toBeNull();
    expect(run.deliveryState).toBe('SUCCEEDED');
    expect(run.cleanupOk).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.kind).toBe('document');
  }, 180_000);

  it('delivers ciphertext, never the plaintext dump', async () => {
    const outcome = await service().run('MANUAL');
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
    const body = deliveredBodies.at(-1);
    expect(body).toBeDefined();
    if (body === undefined) throw new Error('unreachable');

    // A pg_dump custom-format archive begins with the literal ASCII `PGDMP`.
    // If the plaintext had been delivered — or written through the encryption —
    // this signature would be at the front of the delivered bytes.
    expect(body.subarray(0, 5).toString('ascii')).not.toBe('PGDMP');
    expect(body.subarray(0, 8).toString('ascii')).toBe('NEXABAK1');
    // And nowhere else in it either: this catches an archive that concatenated
    // the plaintext after a header rather than encrypting it.
    expect(body.includes(Buffer.from('PGDMP', 'ascii'))).toBe(false);
    // Table names from this schema are in the dump. None may be readable in the
    // delivered artifact.
    expect(body.includes(Buffer.from('panel_credentials', 'ascii'))).toBe(false);
    expect(body.includes(Buffer.from('operational_events', 'ascii'))).toBe(false);
  }, 180_000);

  it('leaves no plaintext dump on disk and drops the scratch database', async () => {
    const outcome = await service().run('MANUAL');
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
    const run = outcome.run;

    await expect(stat(join(workDir, run.id, 'dump.pgcustom'))).rejects.toThrow();
    await expect(stat(join(workDir, run.id, 'verify.pgcustom'))).rejects.toThrow();
    // The archive is deliberately retained; the plaintext is not.
    await expect(stat(join(workDir, run.id, 'archive.nxb'))).resolves.toBeDefined();

    const scratches = await maintenance(async (client) => {
      const result = await client.query(
        "SELECT datname FROM pg_database WHERE datname LIKE 'nexa_verify_%'",
      );
      return result.rows;
    });
    expect(scratches).toEqual([]);
    expect(run.cleanupOk).toBe(true);
  }, 180_000);

  it('produces an archive the operator restore path turns back into a database', async () => {
    const outcome = await service().run('MANUAL');
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
    const run = outcome.run;

    const restoreDir = await mkdtemp(join(tmpdir(), 'nexa-restore-it-'));
    const target = `nexa_restore_${randomBytes(6).toString('hex')}`;
    try {
      const dumpPath = join(restoreDir, 'dump.pgcustom');
      const opened = await context.container.backupArchiver.open({
        archivePath: join(workDir, run.id, 'archive.nxb'),
        dumpPath,
      });

      // The checksum recorded on the run, the checksum in the manifest, and the
      // checksum of the bytes that came out are all the same number. That is
      // the whole claim the manifest makes, checked end to end.
      const actual = await checksumFile(dumpPath);
      expect(actual.checksum).toBe(run.checksum);
      expect(opened.manifest.checksum).toBe(run.checksum);
      expect(opened.manifest.exclusions).toEqual([]);
      expect(opened.manifest.installationId).toBe('integration-installation');

      await maintenance((client) => client.query(`CREATE DATABASE "${target}"`));
      await context.container.backupTools.restoreInto({ database: target }, dumpPath);

      // The restored database holds the real schema, not a plausible-looking
      // subset: every table the application knows about must be there.
      const restored = new Client({ connectionString: urlFor(target) });
      await restored.connect();
      try {
        const tables = await restored.query(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
        );
        const names = tables.rows.map((row: { table_name: string }) => row.table_name);
        for (const required of [
          'tenants',
          'admins',
          'panels',
          'panel_credentials',
          'outbox_messages',
          // Looks transient, is load-bearing: this is what stands between a
          // redelivered outbox message and a duplicated effect. A backup that
          // "tidied" it away would restore an installation that repeats work.
          'processed_messages',
          'backup_runs',
        ]) {
          expect(names).toContain(required);
        }
      } finally {
        await restored.end();
      }
    } finally {
      await maintenance((client) =>
        client.query(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`),
      );
      await rm(restoreDir, { recursive: true, force: true });
    }
  }, 180_000);

  it('refuses the live database as a restore target, by NAME and before anything else', async () => {
    const live = new PostgresDatabaseTools({
      databaseUrl: testConfig().DATABASE_URL,
      dumpTimeoutMs: 60_000,
      restoreTimeoutMs: 60_000,
    });
    // The MESSAGE, not only the code. The live database also has tables, so the
    // emptiness check below would refuse it too and produce the same code — a
    // falsification run proved that deleting the live-target guard entirely
    // left this test green. The two refusals mean different things and only one
    // of them is the catastrophe guard, so the test names which fired.
    await expect(
      live.restoreInto({ database: live.databaseName }, '/nonexistent'),
    ).rejects.toMatchObject({
      code: 'backup.unsafe_restore_target',
      message: expect.stringContaining('that is the database this installation is running on'),
    });
  });

  it('refuses a restore target that already holds tables', async () => {
    const target = `nexa_populated_${randomBytes(6).toString('hex')}`;
    await maintenance((client) => client.query(`CREATE DATABASE "${target}"`));
    const client = new Client({ connectionString: urlFor(target) });
    await client.connect();
    try {
      await client.query('CREATE TABLE something (id int)');
    } finally {
      await client.end();
    }
    try {
      await expect(
        context.container.backupTools.restoreInto({ database: target }, '/nonexistent'),
      ).rejects.toMatchObject({ code: 'backup.unsafe_restore_target' });
    } finally {
      await maintenance((c) => c.query(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`));
    }
  }, 60_000);

  it('fails the run and delivers nothing when the archive cannot be restored', async () => {
    // The archive is intact; the DUMP inside it is not a dump. This is the
    // shape a corrupted or truncated backup takes when the encryption is fine,
    // and it must not be delivered as though it were a backup.
    const broken = service();
    const tools = new PostgresDatabaseTools({
      databaseUrl: testConfig().DATABASE_URL,
      dumpTimeoutMs: 60_000,
      restoreTimeoutMs: 60_000,
    });
    // Replace only `dump`, so everything downstream is the real implementation
    // operating on a genuinely unrestorable file.
    const sabotaged = Object.create(tools) as PostgresDatabaseTools & {
      dump: (destination: string) => Promise<{ databaseName: string; pgDumpVersion: string }>;
    };
    sabotaged.dump = async (destination: string) => {
      await writeFile(destination, Buffer.from('this is not a pg_dump custom archive'));
      return { databaseName: tools.databaseName, pgDumpVersion: 'pg_dump (PostgreSQL) 16.13' };
    };
    (broken as any).deps.tools = sabotaged;

    const outcome = await broken.run('MANUAL');
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
    expect(outcome.run.state).toBe('FAILED');
    expect(outcome.run.stage).toBe('VERIFY_RESTORE');
    expect(outcome.run.verifiedAt).toBeNull();
    expect(delivered).toEqual([]);
    // The unproven archive is gone, not left on disk where it would look like a
    // backup somebody could rely on.
    await expect(stat(join(workDir, outcome.run.id, 'archive.nxb'))).rejects.toThrow();
    // And the scratch database it created is gone too.
    expect(await databaseExists(outcome.run.stage)).toBe(false);
  }, 180_000);

  it('lets exactly one of several concurrent starts hold the installation', async () => {
    // The real constraint, exercised concurrently: a partial unique index over
    // `state = 'RUNNING'`. Four callers, distinct lease owners — which is what
    // separate worker replicas look like.
    const services = [0, 1, 2, 3].map((n) => service({ leaseOwner: `replica-${String(n)}` }));
    const outcomes = await Promise.all(services.map((s) => s.run('SCHEDULED')));

    const completedRuns = outcomes.filter((o) => o.kind === 'COMPLETED');
    const busy = outcomes.filter((o) => o.kind === 'BUSY');
    expect(completedRuns).toHaveLength(1);
    expect(busy).toHaveLength(3);

    // And the database agrees: exactly one row was ever created, so the losers
    // did not leave half-started runs behind.
    const rows = await context.container.backupRuns.latest(50);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('SUCCEEDED');
    // Only one dump was taken, so only one delivery happened.
    expect(delivered).toHaveLength(1);
  }, 300_000);

  it('reports the actual holder when it reports BUSY', async () => {
    const now = context.container.clock.now();
    const claim = await context.container.backupRuns.start({
      id: context.container.ids.uuid(),
      trigger: 'MANUAL',
      leaseOwner: 'holder',
      now,
    });
    expect(claim.claimed).toBe(true);

    const second = await service().run('SCHEDULED');
    expect(second.kind).toBe('BUSY');
    if (second.kind !== 'BUSY') throw new Error('unreachable');
    if (!claim.claimed) throw new Error('unreachable');
    expect(second.holder.id).toBe(claim.run.id);
    expect(second.holder.leaseOwner).toBe('holder');
  });

  it('releases a lock whose owner stopped reporting, by failing the run', async () => {
    const stale = new Date(context.container.clock.now().getTime() - 60 * 60 * 1000);
    const claim = await context.container.backupRuns.start({
      id: context.container.ids.uuid(),
      trigger: 'SCHEDULED',
      leaseOwner: 'a-process-that-died',
      now: stale,
    });
    if (!claim.claimed) throw new Error('unreachable');

    const outcome = await service().run('MANUAL');
    // The new run got the lock...
    expect(outcome.kind).toBe('COMPLETED');
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
    expect(outcome.run.state).toBe('SUCCEEDED');

    // ...and the abandoned one was CLOSED, not adopted. Its workspace was left
    // in place on purpose: the process that owned it may still be writing.
    const abandoned = await context.container.backupRuns.byId(claim.run.id);
    expect(abandoned?.state).toBe('FAILED');
    expect(abandoned?.failureCode).toBe('backup.lease_expired');
    expect(abandoned?.cleanupOk).toBe(false);
  }, 180_000);

  it('reports an abandoned run rather than only logging it', async () => {
    /*
     * Review finding 3, CONFIRMED. A reclaim means a backup was under way and its
     * process died — the worker SIGKILLed mid-dump, the container evicted, the host
     * rebooted — and the only trace was a `logger.warn`. No condition, no
     * notification.
     *
     * Worse than silent: the run that does the reclaiming goes on to SUCCEED and
     * reports `backup.run_ok`, which closes a condition that was never opened. So
     * an installation that lost a backup ended up looking exactly like one that did
     * not, which is the failure mode item B exists to remove.
     *
     * The run itself succeeding is what makes this case sharp: both events land, in
     * that order, and the assertion is that the FAILURE was recorded at all.
     */
    await pointAtInstallation(context.container);
    const stale = new Date(context.container.clock.now().getTime() - 60 * 60 * 1000);
    await context.container.backupRuns.start({
      id: context.container.ids.uuid(),
      trigger: 'SCHEDULED',
      leaseOwner: 'a-process-that-died',
      now: stale,
    });

    const outcome = await context.container.backup.run('MANUAL');
    expect(outcome.kind).toBe('COMPLETED');

    const events = await context.container.database.db.execute(
      sql`SELECT code FROM operational_events WHERE code = 'backup.run_failed'`,
    );
    expect((events.rows as unknown as readonly unknown[]).length).toBe(1);
  }, 180_000);

  it('refuses a write from a run whose lease was reclaimed', async () => {
    const stale = new Date(context.container.clock.now().getTime() - 60 * 60 * 1000);
    const claim = await context.container.backupRuns.start({
      id: context.container.ids.uuid(),
      trigger: 'SCHEDULED',
      leaseOwner: 'evicted',
      now: stale,
    });
    if (!claim.claimed) throw new Error('unreachable');

    await context.container.backupRuns.reclaimStale({
      staleBefore: context.container.clock.now(),
      now: context.container.clock.now(),
    });

    // The evicted process finally finishes and tries to report success. It must
    // change nothing: the row belongs to the takeover now, and a late SUCCEEDED
    // would report a completed backup for a run that was abandoned.
    await context.container.backupRuns.finish({
      id: claim.run.id,
      leaseOwner: 'evicted',
      state: 'SUCCEEDED',
      stage: 'CLEANUP',
      now: context.container.clock.now(),
      deliveryState: 'SUCCEEDED',
      cleanupOk: true,
    });

    const row = await context.container.backupRuns.byId(claim.run.id);
    expect(row?.state).toBe('FAILED');
    expect(row?.failureCode).toBe('backup.lease_expired');
    expect(row?.deliveryState).toBe('NOT_ATTEMPTED');
  });

  it('refuses a write naming the wrong lease owner even while the run is RUNNING', async () => {
    // The lease guard ON ITS OWN, with the state guard beside it still true.
    // Without this case the two are indistinguishable: a reclaimed run is
    // FAILED, so `state = 'RUNNING'` alone rejects the late write and deleting
    // `lease_owner` from the predicate leaves the suite green — which a
    // falsification run confirmed. Here the row is genuinely still RUNNING and
    // only the owner is wrong.
    const now = context.container.clock.now();
    const claim = await context.container.backupRuns.start({
      id: context.container.ids.uuid(),
      trigger: 'MANUAL',
      leaseOwner: 'the-real-owner',
      now,
    });
    if (!claim.claimed) throw new Error('unreachable');

    await context.container.backupRuns.progress({
      id: claim.run.id,
      stage: 'DELIVER',
      leaseOwner: 'an-impostor',
      now,
    });
    await context.container.backupRuns.finish({
      id: claim.run.id,
      leaseOwner: 'an-impostor',
      state: 'SUCCEEDED',
      stage: 'CLEANUP',
      now,
      deliveryState: 'SUCCEEDED',
      cleanupOk: true,
    });

    const row = await context.container.backupRuns.byId(claim.run.id);
    expect(row?.state).toBe('RUNNING');
    expect(row?.stage).toBe('DUMP');
    expect(row?.leaseOwner).toBe('the-real-owner');
  });

  it('keeps an undelivered but verified archive a success, and an unknown outcome unknown', async () => {
    nextDelivery = { state: 'OUTCOME_UNKNOWN', detail: 'the socket closed while uploading' };
    const outcome = await service().run('SCHEDULED');
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');

    expect(outcome.run.state).toBe('SUCCEEDED');
    expect(outcome.run.verifiedAt).not.toBeNull();
    expect(outcome.run.deliveryState).toBe('OUTCOME_UNKNOWN');
    // Exactly one attempt was made. Nothing resent it.
    expect(delivered).toHaveLength(1);

    const unknown = await context.container.backupRuns.withUnknownDelivery(10);
    expect(unknown.map((row) => row.id)).toEqual([outcome.run.id]);
  }, 180_000);

  it('writes no secret into the run row', async () => {
    const outcome = await service().run('MANUAL');
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');

    const raw = await context.container.database.db.execute(
      `SELECT row_to_json(t)::text AS body FROM backup_runs t` as never,
    );
    const body = JSON.stringify(raw);
    const config = testConfig();
    expect(body).not.toContain(config.DATABASE_URL);
    expect(body).not.toContain('PGPASSWORD');
    expect(body.toLowerCase()).not.toContain('password');
    // The KEK is base64 and would be conspicuous. Its absence is asserted
    // rather than assumed, because the run row is the one place in this feature
    // that a key id and a key could plausibly be confused for each other.
    expect(body).not.toContain(config.SECRETS_KEK ?? 'no-kek-configured');
  }, 180_000);

  it('records what it left behind when a manifest is delivered instead of a document', async () => {
    // Not reachable by making a real database bigger than 50 MiB in a test, so
    // the ceiling is exercised through the archive size the pipeline observes.
    // The assertion is about behaviour at the boundary, not about the number.
    deliveryConfigured = true;
    const svc = service();
    const deps = (svc as any).deps as { archiver: { seal: (i: unknown) => Promise<unknown> } };
    const realSeal = deps.archiver.seal.bind(deps.archiver);
    deps.archiver.seal = async (input: unknown) => {
      const sealed = (await realSeal(input)) as { archiveBytes: number; keyId: string };
      return { ...sealed, archiveBytes: 50 * 1024 * 1024 + 1 };
    };

    const outcome = await svc.run('MANUAL');
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
    expect(outcome.run.state).toBe('SUCCEEDED');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.kind).toBe('message');
    expect(delivered[0]?.caption).toContain('RETAINED:');
    expect(delivered[0]?.caption).toContain(outcome.run.checksum ?? 'no-checksum');
  }, 180_000);

  it('stops a dump that runs past its timeout, and kills the subprocess', async () => {
    /*
     * Item M of the hardening audit: the timeout branch in `pg-tools.ts` existed
     * and nothing reached it, because every test passes a generous timeout — and
     * the `binDir` hook that would make it reachable was unused.
     *
     * So this is the first exercise of the branch, through a REAL subprocess: a
     * `pg_dump` on `binDir` that sleeps far longer than the timeout allows. The
     * tool must reject rather than hang, classify it as `BACKUP_TOOL_FAILED`, and
     * say how long it waited — and it must take the child with it. A dump left
     * running holds a `pg_dump` connection to the database after the run that
     * started it has given up, which is the version of this that looks fine in
     * the application and shows up as a backend nobody can account for.
     */
    const bin = await mkdtemp(join(tmpdir(), 'nexa-fake-bin-'));
    try {
      const fake = join(bin, 'pg_dump');
      const pidFile = join(bin, 'pid');
      /*
       * The pid file path is BAKED INTO the script rather than passed in the
       * environment, and that is the production code asserting itself: `pg-tools`
       * builds a clean environment for the child — PATH, LC_ALL and the PG*
       * variables only — so nothing this process holds reaches it. A first version
       * of this test read `$NEXA_FAKE_PIDFILE` and got an empty path.
       *
       * The `exec` matters too: without it `sh` would be the child and `sleep` its
       * grandchild, so killing the child would leave the sleep behind. That is a
       * real property of the production code, and not the one under test here.
       */
      await writeFile(fake, `#!/bin/sh\necho "$$" > '${pidFile}'\nexec sleep 120\n`);
      await chmod(fake, 0o755);

      const tools = new PostgresDatabaseTools({
        databaseUrl: testConfig().DATABASE_URL,
        dumpTimeoutMs: 1_000,
        restoreTimeoutMs: 1_000,
        binDir: bin,
      });
      const started = Date.now();
      await expect(tools.dump(join(bin, 'out.pgcustom'))).rejects.toMatchObject({
        code: 'backup.tool_failed',
      });
      /*
       * It gave up near its OWN deadline, not the child's and not the backstop's.
       *
       * The upper bound is what makes this a timeout test at all: without it, a
       * tool that simply waited out `sleep 120` would satisfy the rejection above.
       * And it is 4s rather than 30s deliberately — the SIGKILL backstop fires 5s
       * after SIGTERM, so a loose bound cannot tell "terminated promptly" from
       * "terminated five seconds late by the backstop". Measured: deleting the
       * `SIGTERM` leaves this case passing under a 30s bound and failing under
       * this one.
       */
      const waited = Date.now() - started;
      expect(waited).toBeGreaterThanOrEqual(900);
      expect(waited).toBeLessThan(4_000);

      // And the child is GONE. Asked of the operating system, because the point
      // is the process and not the promise: `kill(pid, 0)` throws ESRCH for a pid
      // that no longer exists.
      const pid = Number((await readFile(pidFile, 'utf8')).trim());
      expect(Number.isInteger(pid)).toBe(true);
      let alive = true;
      for (let attempt = 0; attempt < 60 && alive; attempt += 1) {
        try {
          process.kill(pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  }, 60_000);

  it('kills a dump that ignores SIGTERM', async () => {
    /*
     * The BACKSTOP, which the case above cannot test: `sleep` dies on SIGTERM, so
     * removing the `SIGKILL` timer leaves that case green. This child traps SIGTERM
     * and keeps going, which is the state the backstop exists for — and the reason
     * it exists is that a dump still running holds a `pg_dump` connection and the
     * work directory of a run that has already been recorded as failed.
     *
     * Two rules, two cases, because one case covering both is a case that passes
     * when either is deleted.
     */
    const bin = await mkdtemp(join(tmpdir(), 'nexa-stubborn-bin-'));
    try {
      const pidFile = join(bin, 'pid');
      const fake = join(bin, 'pg_dump');
      /*
       * `trap '' TERM` ignores it outright, and no `exec`, because the shell has to
       * stay alive to do the ignoring.
       *
       * `exec >/dev/null 2>&1` after the pid is written is not tidiness. The
       * production code settles on the child's `close` event, which waits for the
       * stdio pipes to close as well as for the process to exit — so a descendant
       * still holding the inherited stdout keeps the promise pending for ever. A
       * first version of this fixture backgrounded `sleep` with the pipes
       * inherited, and the test hung for its full sixty seconds even though the
       * shell had been killed on time. `pg_dump` and `pg_restore` leave no such
       * descendant, which is why this is the fixture's problem and not the
       * product's; handing the orphan `/dev/null` is how the fixture stops lying
       * about it.
       */
      await writeFile(
        fake,
        `#!/bin/sh\ntrap '' TERM\necho "$$" > '${pidFile}'\nexec >/dev/null 2>&1\nsleep 120\n`,
      );
      await chmod(fake, 0o755);

      const tools = new PostgresDatabaseTools({
        databaseUrl: testConfig().DATABASE_URL,
        dumpTimeoutMs: 1_000,
        restoreTimeoutMs: 1_000,
        binDir: bin,
      });
      await expect(tools.dump(join(bin, 'out.pgcustom'))).rejects.toMatchObject({
        code: 'backup.tool_failed',
      });

      const pid = Number((await readFile(pidFile, 'utf8')).trim());
      expect(Number.isInteger(pid)).toBe(true);
      // Up to 20s: SIGTERM at 1s, the backstop 5s after that, plus room for a
      // loaded runner. Without the backstop this child never dies at all.
      let alive = true;
      for (let attempt = 0; attempt < 200 && alive; attempt += 1) {
        try {
          process.kill(pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      await rm(bin, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails the run and delivers nothing when the work directory cannot be written', async () => {
    /*
     * Item M again: disk exhaustion was modelled for the installer and not for
     * `BACKUP_WORK_DIR`, which ADR-0025 itself says needs three artifacts on disk
     * at once.
     *
     * A real OS refusal rather than a stubbed one: the work root's parent is a
     * regular FILE, so `mkdir` inside the production workspace factory fails with
     * ENOTDIR. Not EACCES-by-chmod, which was the first attempt and proved
     * nothing — these suites run as root, root ignores directory permissions, and
     * the backup SUCCEEDED through a mode `0500` directory. A test that can only
     * pass as an unprivileged user is a test that does not run where it matters.
     *
     * ENOSPC specifically needs a size-limited filesystem, and therefore mount
     * privileges CI may not have. It was exercised by hand against a 1 MiB tmpfs
     * and the result is recorded in `docs/hardening-falsification.md`; the rule
     * this case pins is the one both share, which is that a workspace that cannot
     * be written fails the run at its FIRST stage and delivers nothing.
     *
     * What must not happen is the interesting part: a run that cannot write
     * anywhere must not report success with no artifact, and must not deliver.
     */
    const blocker = join(await mkdtemp(join(tmpdir(), 'nexa-backup-blocked-')), 'not-a-directory');
    try {
      await writeFile(blocker, 'occupying the path the work root needs');
      const outcome = await service({ workDir: join(blocker, 'runs') }).run('MANUAL');
      if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
      expect(outcome.run.state).toBe('FAILED');
      // The first stage, because nothing downstream of it could have run.
      expect(outcome.run.stage).toBe('DUMP');
      expect(outcome.run.verifiedAt).toBeNull();
      expect(outcome.run.deliveryState).toBe('NOT_ATTEMPTED');
      expect(delivered).toEqual([]);
      // And the failure is classified and described, not a raw errno left for an
      // operator to interpret on their own.
      expect(outcome.run.failureCode).not.toBeNull();
      expect(outcome.run.failureMessage).not.toBeNull();
    } finally {
      await rm(blocker, { recursive: true, force: true });
    }

    // The lease is RELEASED, which is the operationally important half: the run
    // row used to be claimed before the workspace existed and outside the
    // recorded region, so this failure left a RUNNING row holding the
    // installation's one-backup-at-a-time lock. Every later backup was then
    // refused as BUSY until the lease went stale — an installation that silently
    // stops taking backups, which for a disaster-recovery pipeline is the worst
    // available outcome. A working one, once the disk problem is gone, proves it.
    const next = await service().run('MANUAL');
    expect(next.kind).toBe('COMPLETED');
    if (next.kind !== 'COMPLETED') throw new Error('unreachable');
    expect(next.run.state).toBe('SUCCEEDED');
  }, 180_000);

  it('records what a run is attributable to, and invents no human for a scheduled one', async () => {
    /*
     * Item B of the hardening audit, and the audit's own wording was that the
     * backup module has "no ScopeContext, no ActorContext, no idempotency key, no
     * audit row". That is true, and ADR-0025 now argues each of those as a decision
     * rather than leaving the grep to speak for itself — so this case asserts the
     * SOURCE OF ACCOUNTABILITY that actually exists, which is the run row.
     *
     * The rule with teeth is the second half: a SCHEDULED run must not acquire a
     * human. Attribution is by trigger because the trigger is a fact the pipeline
     * has; an administrator id would have to be invented, and a false attribution
     * is worse than an absent one. `CLAUDE.md` forbids fabricated actors in the
     * same sentence as placeholder abstractions.
     *
     * Asserting that a ceremonial duplicate audit row DOES NOT exist is deliberate
     * too: two rows carrying the same id, times, trigger and outcome are two rows
     * that come to disagree the first time a failure lands between them.
     */
    const manual = await service().run('MANUAL');
    if (manual.kind !== 'COMPLETED') throw new Error('unreachable');
    const scheduled = await service().run('SCHEDULED');
    if (scheduled.kind !== 'COMPLETED') throw new Error('unreachable');

    // The trigger is recorded truthfully, both ways round, so the column is
    // carrying information rather than a constant.
    expect(manual.run.trigger).toBe('MANUAL');
    expect(scheduled.run.trigger).toBe('SCHEDULED');

    for (const run of [manual.run, scheduled.run]) {
      // A stable identity, and the times that bound the run. This is what an
      // operator reconciling "which backup is this Telegram document" has.
      expect(run.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(run.startedAt).toBeInstanceOf(Date);
      expect(run.finishedAt).toBeInstanceOf(Date);
      expect(run.finishedAt!.getTime()).toBeGreaterThanOrEqual(run.startedAt.getTime());
      // The PROCESS identity, which is what the architecture actually knows about
      // who took the backup. Never a person: nothing in this release knows which.
      expect(run.leaseOwner === null || typeof run.leaseOwner === 'string').toBe(true);
      expect(run.checksum).not.toBeNull();
    }

    // And no audit row was invented for either. `audit_logs` is tenant-scoped and
    // a backup is installation-wide, so a row here would have to carry a fabricated
    // scope and a fabricated actor.
    const audits = await context.container.database.db.execute(
      sql`SELECT count(*)::int AS total FROM audit_logs
          WHERE entity_id = ${manual.run.id} OR entity_id = ${scheduled.run.id}`,
    );
    expect((audits.rows as unknown as readonly { total: number }[])[0]?.total).toBe(0);
  }, 180_000);

  it('records the condition when the run comes from the CLI, not only from the worker', async () => {
    /*
     * Review finding 2, CONFIRMED. `resolveInstallationTenant` is called by
     * `main.worker.ts` and `main.monitor.ts` and by nothing else, so the backup
     * CLI's container had `installationTenantId === null` for its whole life:
     * `BackupService.report` took its "no tenant provisioned" branch and recorded
     * NOTHING.
     *
     * The consequence was specific and bad. Nightly scheduled backups fail and
     * `backup.run_failed` is open and alerted — the worker resolves its tenant, so
     * that half worked. The operator then runs `backup run`, it SUCCEEDS, and
     * `backup.run_ok` is never recorded, so `recoversDedupeKey` never fires and the
     * alert stays open. Their only way out was to wait for a scheduled run to
     * succeed. The log line they got instead said "no installation tenant is
     * provisioned", which is false on a provisioned installation.
     *
     * Driven through the exported `cmdRun` rather than the helper it calls, so the
     * CALL SITE is what this pins: removing the call fails this case.
     *
     * `context.container` is built exactly as the CLI builds one — `createContainer`
     * with no tenant resolution — which is also why no existing test could see
     * this. The other cases in this file construct their own `BackupService` with a
     * hardcoded scope.
     */
    /*
     * Its OWN context, with a writable work directory.
     *
     * `BACKUP_WORK_DIR` defaults to `/var/lib/nexa/backups`, and this case runs the
     * real pipeline through `container.backup` rather than through the local
     * `service()` helper that every other case uses — so it is the one case that
     * obeys that default. This session runs as root and can create that path; the
     * CI runner cannot, so the run FAILED at DUMP and `cmdRun` returned 1. The case
     * passed locally for a reason that had nothing to do with what it tests, which
     * is the same trap the work-directory case above records: a test that only
     * passes as root does not run where it matters.
     */
    const cliWorkDir = await mkdtemp(join(tmpdir(), 'nexa-backup-cli-'));
    const cli = await createTestContext({ BACKUP_WORK_DIR: cliWorkDir });
    try {
      await cli.reset();
      await runTheCliCase(cli.container);
    } finally {
      await cli.close();
      await rm(cliWorkDir, { recursive: true, force: true });
    }
  }, 180_000);

  /** The body of the case above, so its context can be closed whatever happens. */
  async function runTheCliCase(container: TestContext['container']): Promise<void> {
    expect(container.installationTenantId).toBeNull();

    // An open failure, recorded the way the worker's failure path records it.
    await container.opsLog.record(
      { tenantId: SEED_IDS.tenantA as never, botInstanceId: null },
      {
        code: 'backup.run_failed',
        severity: 'ERROR',
        message: 'a nightly run failed',
        dedupeKey: 'backup.run',
      },
    );

    const code = await cmdRun(container);
    expect(code).toBe(0);
    // The tenant is now known, which is what lets the recorder address anything.
    expect(container.installationTenantId).toBe(SEED_IDS.tenantA);

    // And the success was recorded against it, so the open failure is resolved.
    // By CODE, not by dedupe key: the success report carries `recoversDedupeKey`
    // and no `dedupeKey` of its own, so the recovery row's key is null. A first
    // version of this query filtered on the key and found only the failure.
    const events = await container.database.db.execute(
      sql`SELECT code, resolved_at FROM operational_events
          WHERE code IN ('backup.run_failed', 'backup.run_ok') ORDER BY code`,
    );
    const rows = events.rows as unknown as readonly { code: string; resolved_at: Date | null }[];
    const failed = rows.find((row) => row.code === 'backup.run_failed');
    const ok = rows.find((row) => row.code === 'backup.run_ok');
    expect(ok).toBeDefined();
    expect(failed?.resolved_at).not.toBeNull();
  }

  it('parses a real manifest against the frozen schema', async () => {
    const outcome = await service().run('MANUAL');
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
    const dir = await mkdtemp(join(tmpdir(), 'nexa-manifest-'));
    try {
      const opened = await context.container.backupArchiver.open({
        archivePath: join(workDir, outcome.run.id, 'archive.nxb'),
        dumpPath: join(dir, 'dump'),
      });
      const manifest: BackupManifest = opened.manifest;
      expect(manifest.manifestVersion).toBe(1);
      expect(manifest.dumpFormat).toBe('custom');
      expect(manifest.backupId).toBe(outcome.run.id);
      // The manifest records the SERVER version and the CLIENT version
      // separately: they differ routinely, and a restore years later needs to
      // know which way round.
      expect(manifest.postgresVersion).toMatch(/^\d+/);
      expect(manifest.pgDumpVersion).toContain('pg_dump');
      // Never a connection string, never a host.
      expect(JSON.stringify(manifest)).not.toContain('postgres://');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
