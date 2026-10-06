import { copyFile, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RECOVERY_CANDIDATE_PREFIX,
  RECOVERY_DISPLACED_PREFIX,
  type ActorContext,
} from '@nexa/contracts';
import { createContainer, type Container } from '../../apps/api/src/container';
import { runMigrations } from '../../apps/api/src/infrastructure/persistence/migrate';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { cmdRun, EXIT_RECOVERY_QUIESCED } from '../../apps/api/src/backup.cli';
import { adminActorFor, createAdmin, tenantA, testConfig } from './harness';

/**
 * The E4 failure drills the existing suites did not cover, against a real
 * PostgreSQL, real `pg_dump`/`pg_restore` and — for the restart cases — the
 * real cutover.
 *
 * THE HARNESS RULE (Program E): every database this file touches is created by
 * this file under the file-unique prefix `nexa_e4drill_`, or is named by a
 * recovery id this file created; the teardown drops exactly those names and
 * never sweeps by `LIKE`. Other suites and other agents may hold `nexa_drlive_*`,
 * `nexa_kitlive_*`, `nexa_candidate_*` or `nexa_pre_restore_*` databases right
 * now, and a pattern sweep here would drop them. Modelled on
 * `recovery-kit-restore.test.ts`.
 *
 * Each case builds a THROWAWAY live database, because the executor renames the
 * database it runs against — and because a mutation of the rules under test
 * could make a refusal into a cutover, which must not happen to the suite's own
 * database.
 */

const FILE_PREFIX = 'nexa_e4drill_';

/** The executor's own derivation, so the teardown can name what a case produced. */
function shortId(recoveryId: string): string {
  return recoveryId.replace(/-/g, '').slice(0, 20);
}

interface Live {
  container: Container;
  name: string;
  url: string;
  config: ReturnType<typeof testConfig>;
  workRoot: string;
  recoveryRoot: string;
  owner: ActorContext;
}

describe('recovery and backup failure drills (E4)', () => {
  let created: string[];
  let recoveries: string[];
  const roots: string[] = [];
  const containers: Container[] = [];

  const admin = (): Client => {
    const base = new URL(testConfig().DATABASE_URL);
    base.pathname = '/postgres';
    return new Client({ connectionString: base.toString() });
  };

  async function maintenance(sql: string): Promise<void> {
    const client = admin();
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  async function queryIn<T extends Record<string, unknown>>(
    database: string,
    sql: string,
  ): Promise<T[]> {
    const url = new URL(testConfig().DATABASE_URL);
    url.pathname = `/${database}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      return (await client.query<T>(sql)).rows;
    } finally {
      await client.end();
    }
  }

  async function databaseExists(name: string): Promise<boolean> {
    const client = admin();
    await client.connect();
    try {
      const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      return rows.length > 0;
    } finally {
      await client.end();
    }
  }

  /** A throwaway installation: its own database and work directories. */
  async function live(): Promise<Live> {
    const name = `${FILE_PREFIX}${randomBytes(6).toString('hex')}`;
    created.push(name);
    await maintenance(`CREATE DATABASE "${name}"`);
    const url = new URL(testConfig().DATABASE_URL);
    url.pathname = `/${name}`;
    await runMigrations(url.toString());
    const workRoot = await mkdtemp(join(tmpdir(), 'nexa-e4-backups-'));
    const recoveryRoot = await mkdtemp(join(tmpdir(), 'nexa-e4-recovery-'));
    roots.push(workRoot, recoveryRoot);
    const config = testConfig({
      DATABASE_URL: url.toString(),
      BACKUP_WORK_DIR: workRoot,
      RECOVERY_WORK_DIR: recoveryRoot,
    });
    const container = createContainer(config, 'recovery');
    containers.push(container);
    await seed(container.database.db, container.cipher);
    container.setInstallationTenant(tenantA.tenantId);
    const owner = adminActorFor(
      await createAdmin(container, tenantA, {
        username: `e4-owner-${randomBytes(3).toString('hex')}`,
        roleKeys: ['owner'],
      }),
    );
    return { container, name, url: url.toString(), config, workRoot, recoveryRoot, owner };
  }

  /** The SAME installation's process coming back: same config, same hostname, same lease owner. */
  function restarted(installation: Live): Container {
    const container = createContainer(installation.config, 'recovery');
    containers.push(container);
    container.setInstallationTenant(tenantA.tenantId);
    return container;
  }

  /** Backup, upload, verify, restore-test and confirm, through the operator's own services. */
  async function confirmedRecovery(
    installation: Live,
    afterBackup?: () => Promise<void>,
  ): Promise<string> {
    const { container, owner, workRoot } = installation;
    const outcome = await container.backup.run('MANUAL');
    if (outcome.kind !== 'COMPLETED') throw new Error('expected a completed backup');
    expect(outcome.run.state).toBe('SUCCEEDED');
    await afterBackup?.();
    const begun = await container.recoveryService.beginUpload(tenantA, owner, {
      clientFilename: 'drill.nxb',
    });
    recoveries.push(begun.request.id);
    await copyFile(join(workRoot, outcome.run.id, 'archive.nxb'), begun.workspace.archivePath);
    const { size } = await stat(begun.workspace.archivePath);
    await container.recoveryService.completeUpload(tenantA, begun.request.id, {
      sizeBytes: size,
      archiveSha256: 'a'.repeat(64),
    });
    const tested = await container.recoveryService.verifyAndTest(tenantA, owner, begun.request.id);
    expect(tested.failureCode).toBeNull();
    const confirmed = await container.recoveryService.confirm(tenantA, owner, begun.request.id, {
      phrase: 'RESTORE NEXA',
      artifactChecksum: tested.request.artifactChecksum ?? '',
    });
    expect(confirmed.state).toBe('RESTORE_REQUESTED');
    return begun.request.id;
  }

  /**
   * A marker only the ORIGINAL live database holds — written AFTER the backup, so
   * the archive does not carry it — and "production untouched" is a claim about
   * content rather than about a name.
   */
  async function markLive(installation: Live): Promise<string> {
    const marker = `e4-marker-${randomBytes(4).toString('hex')}`;
    await queryIn(
      installation.name,
      `INSERT INTO operational_events (id, tenant_id, code, severity, message, dedupe_scope,
         occurrence_count, first_seen_at, last_seen_at)
       VALUES (gen_random_uuid(), '${tenantA.tenantId}', 'e4.marker', 'INFO', '${marker}',
         'e4', 1, now(), now())`,
    );
    return marker;
  }

  async function hasMarker(database: string, marker: string): Promise<boolean> {
    const rows = await queryIn<{ n: number }>(
      database,
      `SELECT count(*)::int AS n FROM operational_events WHERE message = '${marker}'`,
    );
    return rows[0]?.n === 1;
  }

  type ExecutorDeps = {
    engine: Record<string, unknown>;
    keys: Record<string, unknown>;
    recovery: Record<string, unknown>;
    readiness: () => Promise<{ degraded: boolean }>;
  };
  const depsOf = (container: Container): ExecutorDeps =>
    (container.recoveryExecutor as unknown as { deps: ExecutorDeps }).deps;

  const leaseOwner = `recovery:${hostname()}`;

  beforeEach(() => {
    created = [];
    recoveries = [];
  });

  afterEach(async () => {
    for (const container of containers.splice(0)) await container.shutdown().catch(() => undefined);
    // Only what THIS case created: its live databases, and the candidate and
    // displaced names derived from its own recovery ids. Never a LIKE sweep.
    const names = new Set(created);
    for (const id of recoveries) {
      names.add(`${RECOVERY_CANDIDATE_PREFIX}${shortId(id)}`);
      names.add(`${RECOVERY_DISPLACED_PREFIX}${shortId(id)}`);
    }
    for (const name of names) {
      await maintenance(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    }
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Backup while a recovery quiesces
  // ---------------------------------------------------------------------------

  it('refuses a CLI `backup run` while a recovery is RESTORING, and writes no run', async () => {
    const installation = await live();
    const recoveryId = await confirmedRecovery(installation);
    const { container } = installation;
    await container.database.db.execute(
      `UPDATE recovery_requests
          SET state = 'RESTORING', stage = 'RESTORE_CANDIDATE',
              lease_owner = 'another-recovery-process', lease_heartbeat_at = now()
        WHERE id = '${recoveryId}'` as never,
    );
    const before = await queryIn<{ n: number }>(
      installation.name,
      'SELECT count(*)::int AS n FROM backup_runs',
    );

    expect(await container.recoveryQuiesced()).toBe(true);
    expect(await cmdRun(container)).toBe(EXIT_RECOVERY_QUIESCED);

    const after = await queryIn<{ n: number }>(
      installation.name,
      'SELECT count(*)::int AS n FROM backup_runs',
    );
    expect(after[0]?.n).toBe(before[0]?.n);
    // The housekeeping asks the same predicate, and does nothing either.
    expect((await container.backupHousekeeping.pass()).skipped).toBe(true);
  }, 240_000);

  it('lets the CLI run while the recovery is only taking its PRE-RESTORE backup', async () => {
    // PRE_RESTORE_BACKUP is deliberately outside the quiesce (ADR-0028): the
    // predicate must say so, or the executor's own backup would be refused.
    const installation = await live();
    const recoveryId = await confirmedRecovery(installation);
    await installation.container.database.db.execute(
      `UPDATE recovery_requests
          SET state = 'PRE_RESTORE_BACKUP', stage = 'EMERGENCY_BACKUP',
              lease_owner = 'another-recovery-process', lease_heartbeat_at = now()
        WHERE id = '${recoveryId}'` as never,
    );
    expect(await installation.container.recoveryQuiesced()).toBe(false);
  }, 240_000);

  // ---------------------------------------------------------------------------
  // Abandonment before the restore stage
  // ---------------------------------------------------------------------------

  it.each([
    ['PRE_RESTORE_BACKUP', 'EMERGENCY_BACKUP'],
    ['QUIESCING', 'QUIESCE'],
  ])(
    'fails a recovery abandoned in %s and releases the installation',
    async (state, stage) => {
      const installation = await live();
      const recoveryId = await confirmedRecovery(installation);
      const { container } = installation;
      await container.database.db.execute(
        `UPDATE recovery_requests
            SET state = '${state}', stage = '${stage}',
                lease_owner = 'a-process-that-died',
                lease_heartbeat_at = now() - interval '1 hour'
          WHERE id = '${recoveryId}'` as never,
      );
      expect(await container.recoveryRequests.installationLock()).not.toBeNull();

      await container.recoveryExecutor.tick();

      const row = await container.recoveryRequests.byIdUnscoped(recoveryId);
      expect(row?.state).toBe('FAILED');
      expect(row?.failureCode).toBe('recovery.lease_expired');
      expect(row?.cutoverAt).toBeNull();
      expect(await container.recoveryRequests.installationLock()).toBeNull();
      expect(await container.recoveryQuiesced()).toBe(false);
    },
    180_000,
  );

  // ---------------------------------------------------------------------------
  // Executor-side candidate validation
  // ---------------------------------------------------------------------------

  const validationCases: readonly {
    name: string;
    code: string;
    inject: (deps: ExecutorDeps) => void;
  }[] = [
    {
      name: 'an EMPTY candidate',
      code: 'recovery.restored_database_empty',
      inject: (deps) => {
        // The CANDIDATE only. The emergency backup's own verification inspects
        // its scratch database through the same engine, and must still pass.
        const real = (deps.engine.inspectDatabase as (name: string) => Promise<object>).bind(
          deps.engine,
        );
        deps.engine.inspectDatabase = async (name: string) =>
          name.startsWith(RECOVERY_CANDIDATE_PREFIX)
            ? { tableCount: 0, migrations: [] }
            : real(name);
      },
    },
    {
      name: 'a candidate whose migrations cannot be read',
      code: 'recovery.migration_state_unreadable',
      inject: (deps) => {
        const real = (deps.engine.inspectDatabase as (name: string) => Promise<object>).bind(
          deps.engine,
        );
        deps.engine.inspectDatabase = async (name: string) =>
          name.startsWith(RECOVERY_CANDIDATE_PREFIX)
            ? { ...(await real(name)), migrations: null }
            : real(name);
      },
    },
    {
      name: 'a BEHIND candidate whose migration fails',
      code: 'recovery.candidate_validation_failed',
      inject: (deps) => {
        deps.recovery.compatibility = () => ({
          verdict: 'BEHIND',
          applied: 1,
          expected: 2,
          permitted: false,
          migratable: true,
        });
        deps.engine.migrateCandidate = async () => {
          throw new Error('a migration failed against the candidate');
        };
      },
    },
    {
      name: 'a key carry that fails',
      code: 'recovery.candidate_validation_failed',
      inject: (deps) => {
        deps.keys.carryInto = async () => {
          throw new Error('the candidate refused the installation keys');
        };
      },
    },
    {
      name: 'a candidate whose secrets need a key this installation lacks (executor re-check)',
      code: 'recovery.candidate_keys_missing',
      inject: (deps) => {
        deps.keys.missingFrom = async () => ['a-key-nobody-holds'];
      },
    },
  ];

  it.each(validationCases)(
    'refuses to cut over to $name, and leaves production untouched',
    async ({ code, inject }) => {
      const installation = await live();
      let marker = '';
      const recoveryId = await confirmedRecovery(installation, async () => {
        marker = await markLive(installation);
      });
      inject(depsOf(installation.container));

      await installation.container.recoveryExecutor.tick();

      const row = await installation.container.recoveryRequests.byIdUnscoped(recoveryId);
      expect(row?.state).toBe('FAILED');
      expect(row?.failureCode).toBe(code);
      // Production is the database it was: no cutover, nothing displaced, the
      // marker still under the live name.
      expect(row?.cutoverAt).toBeNull();
      expect(row?.displacedDatabase).toBeNull();
      expect(await hasMarker(installation.name, marker)).toBe(true);
      expect(await databaseExists(`${RECOVERY_DISPLACED_PREFIX}${shortId(recoveryId)}`)).toBe(
        false,
      );
      // The candidate is NAMED for the operator, and the quiesce is released.
      expect(row?.candidateDatabase).toBe(`${RECOVERY_CANDIDATE_PREFIX}${shortId(recoveryId)}`);
      expect(await installation.container.recoveryRequests.installationLock()).toBeNull();
    },
    240_000,
  );

  // ---------------------------------------------------------------------------
  // A real diverged history, refused at upload
  // ---------------------------------------------------------------------------

  it('refuses at upload an archive whose migration history this release cannot account for', async () => {
    const installation = await live();
    // An applied migration whose content is not what this release ships: the
    // DIVERGED shape, made for real in the database the archive is taken of.
    await queryIn(
      installation.name,
      `UPDATE drizzle.__drizzle_migrations SET hash = 'not-what-this-release-shipped'
        WHERE created_at = (SELECT min(created_at) FROM drizzle.__drizzle_migrations)`,
    );
    const { container, owner, workRoot } = installation;
    const outcome = await container.backup.run('MANUAL');
    if (outcome.kind !== 'COMPLETED') throw new Error('expected a completed backup');
    expect(outcome.run.state).toBe('SUCCEEDED');

    const begun = await container.recoveryService.beginUpload(tenantA, owner, {
      clientFilename: 'diverged.nxb',
    });
    recoveries.push(begun.request.id);
    await copyFile(join(workRoot, outcome.run.id, 'archive.nxb'), begun.workspace.archivePath);
    const { size } = await stat(begun.workspace.archivePath);
    await container.recoveryService.completeUpload(tenantA, begun.request.id, {
      sizeBytes: size,
      archiveSha256: 'a'.repeat(64),
    });
    const tested = await container.recoveryService.verifyAndTest(tenantA, owner, begun.request.id);

    expect(tested.failureCode).toBe('recovery.migration_incompatible');
    expect(tested.request.state).toBe('FAILED');
    // Never confirmable.
    await expect(
      container.recoveryService.confirm(tenantA, owner, begun.request.id, {
        phrase: 'RESTORE NEXA',
        artifactChecksum: tested.request.artifactChecksum ?? 'x'.repeat(64),
      }),
    ).rejects.toBeDefined();
  }, 240_000);

  it('never offers for retention the archive an unfinished recovery names', async () => {
    const installation = await live();
    // The confirmed recovery's `backup_id` is the local run it is restoring.
    const recoveryId = await confirmedRecovery(installation);
    const { container } = installation;
    const named = (await container.recoveryRequests.byIdUnscoped(recoveryId))?.backupId;
    expect(named).toBeTruthy();
    // A newer verified backup, so the named one is not protected as the newest.
    const newer = await container.backup.run('MANUAL');
    if (newer.kind !== 'COMPLETED') throw new Error('expected a completed backup');
    const inUse = await container.recoveryRequests.backupIdsInUse();
    expect(inUse).toContain(named);

    const offered = async (protectedIds: readonly string[]) =>
      (
        await container.backupRuns.archivePruneCandidates({
          finishedBefore: new Date(Date.now() + 60_000),
          keepCount: 1,
          protectedIds,
          limit: 100,
        })
      ).map((row) => row.id);
    // The positive control: without the protection it WOULD be offered.
    expect(await offered([])).toContain(named);
    expect(await offered(inUse)).not.toContain(named);
  }, 240_000);

  // ---------------------------------------------------------------------------
  // The recovery container restarting with the same hostname
  // ---------------------------------------------------------------------------

  it('fails its OWN pre-cutover recovery after a restart, releasing the quiesce and naming the candidate', async () => {
    const installation = await live();
    let marker = '';
    const recoveryId = await confirmedRecovery(installation, async () => {
      marker = await markLive(installation);
    });
    const candidate = `${RECOVERY_CANDIDATE_PREFIX}${shortId(recoveryId)}`;
    // The process died mid-restore: the row is ours by lease, fresh, RESTORING.
    await installation.container.database.db.execute(
      `UPDATE recovery_requests
          SET state = 'RESTORING', stage = 'RESTORE_CANDIDATE',
              lease_owner = '${leaseOwner}', lease_heartbeat_at = now(),
              candidate_database = '${candidate}'
        WHERE id = '${recoveryId}'` as never,
    );

    const after = restarted(installation);
    await after.recoveryExecutor.tick();

    const row = await after.recoveryRequests.byIdUnscoped(recoveryId);
    // NOT continued: a half-finished restore is never resumed by a process that
    // did not watch it start.
    expect(row?.state).toBe('FAILED');
    expect(row?.cutoverAt).toBeNull();
    expect(row?.candidateDatabase).toBe(candidate);
    expect(await after.recoveryRequests.installationLock()).toBeNull();
    expect(await hasMarker(installation.name, marker)).toBe(true);
  }, 240_000);

  it('completes its OWN recovery that had already cut over and was waiting on readiness', async () => {
    const installation = await live();
    let marker = '';
    const recoveryId = await confirmedRecovery(installation, async () => {
      marker = await markLive(installation);
    });
    const displaced = `${RECOVERY_DISPLACED_PREFIX}${shortId(recoveryId)}`;

    // A real recovery, cut over for real.
    await installation.container.recoveryExecutor.tick();
    const done = await installation.container.recoveryRequests.byIdUnscoped(recoveryId);
    expect(done?.state).toBe('SUCCEEDED');
    expect(done?.cutoverAt).not.toBeNull();

    // Rewound to the state a process killed after the re-assert and before the
    // readiness verdict leaves behind: RESTARTING, ours, fresh, cutover recorded.
    await queryIn(
      installation.name,
      `UPDATE recovery_requests
          SET state = 'RESTARTING', stage = 'READINESS', finished_at = NULL,
              failure_code = NULL, lease_owner = '${leaseOwner}', lease_heartbeat_at = now()
        WHERE id = '${recoveryId}'`,
    );
    // operational_events is append-only, so the events are COUNTED, not cleared.
    const countEvents = async (code: string): Promise<number> =>
      (
        await queryIn<{ n: number }>(
          installation.name,
          `SELECT count(*)::int AS n FROM operational_events WHERE code = '${code}'`,
        )
      )[0]?.n ?? 0;
    const okBefore = await countEvents('recovery.run_ok');
    const failedBefore = await countEvents('recovery.run_failed');
    await installation.container.shutdown();

    const after = restarted(installation);
    await after.recoveryExecutor.tick();

    const row = await after.recoveryRequests.byIdUnscoped(recoveryId);
    expect(row?.state).toBe('SUCCEEDED');
    expect(row?.failureCode).toBeNull();
    // The cutover facts are untouched, and the displaced database is still there:
    // the resumption is non-destructive.
    expect(row?.cutoverAt?.getTime()).toBe(done?.cutoverAt?.getTime());
    expect(row?.displacedDatabase).toBe(displaced);
    expect(await databaseExists(displaced)).toBe(true);
    // The displaced database is the ORIGINAL (it has the post-backup marker), and
    // production is the restored one (it does not).
    expect(await hasMarker(displaced, marker)).toBe(true);
    expect(await hasMarker(installation.name, marker)).toBe(false);
    expect(await after.recoveryRequests.installationLock()).toBeNull();
    expect(await countEvents('recovery.run_ok')).toBe(okBefore + 1);
    expect(await countEvents('recovery.run_failed')).toBe(failedBefore);

    // And the journal for it is cleared on the next tick, now the row is terminal.
    await after.recoveryExecutor.tick();
    expect(
      (await readdir(installation.recoveryRoot)).filter((f) => f.startsWith('cutover-')),
    ).toEqual([]);
  }, 300_000);

  it('fails a resumed post-cutover recovery whose installation is not ready, keeping the cutover facts', async () => {
    const installation = await live();
    const recoveryId = await confirmedRecovery(installation);
    const displaced = `${RECOVERY_DISPLACED_PREFIX}${shortId(recoveryId)}`;
    await installation.container.recoveryExecutor.tick();
    await queryIn(
      installation.name,
      `UPDATE recovery_requests
          SET state = 'RESTARTING', stage = 'READINESS', finished_at = NULL,
              failure_code = NULL, lease_owner = '${leaseOwner}', lease_heartbeat_at = now()
        WHERE id = '${recoveryId}'`,
    );
    await installation.container.shutdown();

    const after = restarted(installation);
    depsOf(after).readiness = async () => ({ degraded: true });
    await after.recoveryExecutor.tick();

    const row = await after.recoveryRequests.byIdUnscoped(recoveryId);
    expect(row?.state).toBe('FAILED');
    expect(row?.failureCode).toBe('recovery.readiness_failed');
    expect(row?.cutoverAt).not.toBeNull();
    expect(row?.displacedDatabase).toBe(displaced);
    expect(await databaseExists(displaced)).toBe(true);
  }, 300_000);
});
