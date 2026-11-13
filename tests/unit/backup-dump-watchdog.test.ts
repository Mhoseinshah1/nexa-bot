import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NexaError, PLATFORM_ERROR_CODES } from '@nexa/contracts';
import {
  DUMP_LOCK_WAIT_TIMEOUT_MS,
  DUMP_TIMEOUT_FLOOR_MS,
  DUMP_TIMEOUT_PER_GIB_MS,
  describeDumpSession,
  dumpApplicationName,
  dumpTimeoutFor,
  lockTimeoutRelations,
  parseDumpSessions,
  parseLockHolders,
} from '../../apps/api/src/modules/platform/backup/infrastructure/dump-watchdog';
import { PostgresDatabaseTools } from '../../apps/api/src/modules/platform/backup/infrastructure/pg-tools';

/**
 * The dump watchdog (field, 2026-11-13: a manual backup read DUMP for almost two hours).
 *
 * The formula is pure and tested as such. The kill is tested on REAL processes: a fake
 * `pg_dump` that starts a child of its own and never ends, so "the process tree is gone" is
 * asked of the operating system, not of a spy.
 */

const MINUTE = 60_000;
const GIB = 1024 ** 3;
const TWO_HOURS = 2 * 60 * MINUTE;

describe('the dump timeout, sized from the database', () => {
  it('is the floor for an empty database', () => {
    expect(dumpTimeoutFor({ databaseBytes: 0, capMs: TWO_HOURS })).toBe(DUMP_TIMEOUT_FLOOR_MS);
    expect(DUMP_TIMEOUT_FLOOR_MS).toBe(20 * MINUTE);
  });

  it('adds the per-GiB allowance, proportionally', () => {
    expect(DUMP_TIMEOUT_PER_GIB_MS).toBe(5 * MINUTE);
    expect(dumpTimeoutFor({ databaseBytes: GIB, capMs: TWO_HOURS })).toBe(25 * MINUTE);
    expect(dumpTimeoutFor({ databaseBytes: 4 * GIB, capMs: TWO_HOURS })).toBe(40 * MINUTE);
    expect(dumpTimeoutFor({ databaseBytes: GIB / 2, capMs: TWO_HOURS })).toBe(22.5 * MINUTE);
  });

  it('never exceeds BACKUP_DUMP_TIMEOUT_MS, however large the database', () => {
    expect(dumpTimeoutFor({ databaseBytes: 100 * GIB, capMs: TWO_HOURS })).toBe(TWO_HOURS);
    expect(dumpTimeoutFor({ databaseBytes: 20 * GIB, capMs: TWO_HOURS })).toBe(TWO_HOURS);
    expect(dumpTimeoutFor({ databaseBytes: 19 * GIB, capMs: TWO_HOURS })).toBe(115 * MINUTE);
  });

  it('is exactly the ceiling when the operator sets it below the floor', () => {
    expect(dumpTimeoutFor({ databaseBytes: 0, capMs: 5 * MINUTE })).toBe(5 * MINUTE);
    expect(dumpTimeoutFor({ databaseBytes: 10 * GIB, capMs: 5 * MINUTE })).toBe(5 * MINUTE);
  });

  it('falls back to the ceiling when the size could not be read', () => {
    expect(dumpTimeoutFor({ databaseBytes: null, capMs: TWO_HOURS })).toBe(TWO_HOURS);
    expect(dumpTimeoutFor({ databaseBytes: Number.NaN, capMs: TWO_HOURS })).toBe(TWO_HOURS);
  });

  it('waits five minutes for a table lock, and names its session', () => {
    expect(DUMP_LOCK_WAIT_TIMEOUT_MS).toBe(5 * MINUTE);
    const name = dumpApplicationName('0a1b2c3d');
    expect(name).toBe('nexa-backup-dump-0a1b2c3d');
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
  });
});

describe("reading pg_dump's lock-wait failure and its session", () => {
  const STDERR =
    'pg_dump: error: query failed: ERROR:  canceling statement due to statement timeout\n' +
    'pg_dump: detail: Query was: LOCK TABLE public.processed_messages IN ACCESS SHARE MODE\n';

  it('finds the table pg_dump could not lock', () => {
    expect(lockTimeoutRelations(STDERR)).toEqual(['public.processed_messages']);
    expect(lockTimeoutRelations(STDERR.replace('statement timeout', 'lock timeout'))).toEqual([
      'public.processed_messages',
    ]);
  });

  it('reads an ordinary failure as no lock wait', () => {
    expect(lockTimeoutRelations('pg_dump: error: connection refused')).toBeNull();
    expect(
      lockTimeoutRelations('ERROR:  canceling statement due to statement timeout\nno query'),
    ).toBeNull();
  });

  it('describes a session waiting on a lock, with its holder', () => {
    const sessions = parseDumpSessions(
      JSON.stringify([
        {
          pid: 42,
          state: 'active',
          waitEventType: 'Lock',
          waitEvent: 'relation',
          lock: { locktype: 'relation', mode: 'AccessShareLock', relation: 'legacy_import_map' },
          blockers: [
            {
              pid: 77,
              applicationName: 'nexa-recovery',
              state: 'idle in transaction',
              query: 'TRUNCATE   legacy_import_map',
              mode: 'AccessExclusiveLock',
            },
          ],
        },
      ]),
    );
    expect(describeDumpSession(sessions)).toBe(
      'Its session (pid 42) was waiting for AccessShareLock on legacy_import_map, held by pid 77 ' +
        '"nexa-recovery" (AccessExclusiveLock, idle in transaction): TRUNCATE legacy_import_map.',
    );
  });

  it('describes a session that waited on no lock, a gone session and an unobservable one', () => {
    const busy = parseDumpSessions(
      '[{"pid":5,"state":"active","waitEventType":"Client","waitEvent":"ClientWrite","lock":null,"blockers":[]}]',
    );
    expect(describeDumpSession(busy)).toBe(
      'Its session (pid 5) was not waiting on a lock (active, wait Client/ClientWrite).',
    );
    expect(describeDumpSession(parseDumpSessions('[]'))).toBe(
      'It had no open database session when it was stopped.',
    );
    expect(describeDumpSession(null)).toBe('Its database session could not be observed.');
  });

  it('keeps only well-formed holders', () => {
    expect(
      parseLockHolders(
        '[{"pid":9,"applicationName":"x","state":"active","query":"VACUUM FULL t","mode":"AccessExclusiveLock","relation":"t"},{"nope":1}]',
      ),
    ).toEqual([
      {
        pid: 9,
        applicationName: 'x',
        state: 'active',
        query: 'VACUUM FULL t',
        mode: 'AccessExclusiveLock',
        relation: 't',
      },
    ]);
  });
});

/** Whether a pid still exists, asked of the kernel, waiting up to `ms` for it to go. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('a dump that never ends', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexa-dump-watchdog-'));
  });
  afterEach(async () => {
    for (const file of ['dump.pid', 'child.pid']) {
      const pid = Number(
        await readFile(join(dir, file), 'utf8').then(
          (text) => text.trim(),
          () => '',
        ),
      );
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone, which is what every case asserts.
        }
      }
    }
    await rm(dir, { recursive: true, force: true });
  });

  async function script(name: string, body: string): Promise<void> {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
  }

  /**
   * A `pg_dump` that writes a little, starts a COMPRESSOR-shaped child of its own (a pipeline
   * stage the kill must take too) and never finishes; a `psql` that answers the size query
   * with 1 GiB and the session query with a wait on `legacy_import_map`.
   */
  async function tools(capMs: number): Promise<PostgresDatabaseTools> {
    await script(
      'pg_dump',
      [
        'if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 16.1"; exit 0; fi',
        `printf '%s\\n' "$@" > '${dir}/dump.argv'`,
        `echo "$PGAPPNAME" > '${dir}/dump.appname'`,
        `echo "$$" > '${dir}/dump.pid'`,
        `sleep 600 </dev/null >/dev/null 2>&1 &`,
        `echo "$!" > '${dir}/child.pid'`,
        'exec >/dev/null 2>&1',
        'while :; do sleep 1; done',
      ].join('\n'),
    );
    await script(
      'psql',
      [
        'for arg in "$@"; do last="$arg"; done',
        'case "$last" in',
        `  *pg_database_size*) echo ${String(GIB)} ;;`,
        `  *pg_stat_activity*) echo "$last" > '${dir}/probe.sql'; echo '[{"pid":4242,"state":"active","waitEventType":"Lock","waitEvent":"relation","lock":{"locktype":"relation","mode":"AccessShareLock","relation":"legacy_import_map"},"blockers":[{"pid":77,"applicationName":"nexa-recovery","state":"idle in transaction","query":"TRUNCATE legacy_import_map","mode":"AccessExclusiveLock"}]}]' ;;`,
        '  *) echo 0 ;;',
        'esac',
      ].join('\n'),
    );
    return new PostgresDatabaseTools({
      databaseUrl: 'postgres://nexa:secret@localhost:5432/nexa',
      dumpTimeoutMs: capMs,
      restoreTimeoutMs: 60_000,
      binDir: dir,
      migratorEntrypoint: '/nonexistent',
      lowPriorityPrefix: [],
    });
  }

  it('is stopped at its sized deadline with backup.dump_timeout, the lock it waited on recorded', async () => {
    const dumper = await tools(1_500);
    const started = Date.now();
    const error = await dumper.dump(join(dir, 'out.dump')).then(
      () => null,
      (reason: unknown) => reason,
    );
    const waited = Date.now() - started;

    expect(error).toBeInstanceOf(NexaError);
    const failure = error as NexaError;
    expect(failure.code).toBe(PLATFORM_ERROR_CODES.BACKUP_DUMP_TIMEOUT);
    expect(failure.message).toContain('pg_dump did not finish within');
    expect(failure.message).toContain('sized for 1.00 GiB');
    expect(failure.message).toContain(
      'waiting for AccessShareLock on legacy_import_map, held by pid 77 "nexa-recovery"',
    );
    expect(failure.details).toMatchObject({
      timeoutMs: 1_500,
      databaseBytes: GIB,
      lockRelation: 'legacy_import_map',
      lockMode: 'AccessShareLock',
    });
    // At its own deadline (the 1.5 s ceiling, below the 25 min the size would allow), and
    // promptly: SIGTERM ends it, not the SIGKILL backstop five seconds later.
    expect(waited).toBeGreaterThanOrEqual(1_400);
    expect(waited).toBeLessThan(5_000);

    // The session was looked for by the name the dump was started with.
    const appName = (await readFile(join(dir, 'dump.appname'), 'utf8')).trim();
    expect(appName).toMatch(/^nexa-backup-dump-[0-9a-f]{8}$/);
    expect(failure.details.applicationName).toBe(appName);
    expect(await readFile(join(dir, 'probe.sql'), 'utf8')).toContain(`'${appName}'`);
  }, 30_000);

  it('kills the whole process tree: pg_dump and the child it started', async () => {
    const dumper = await tools(1_000);
    await expect(dumper.dump(join(dir, 'out.dump'))).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.BACKUP_DUMP_TIMEOUT,
    });
    const dumpPid = Number((await readFile(join(dir, 'dump.pid'), 'utf8')).trim());
    const childPid = Number((await readFile(join(dir, 'child.pid'), 'utf8')).trim());
    expect(await goneWithin(dumpPid, 3_000)).toBe(true);
    // The child is in pg_dump's process group, and the group is what the watchdog kills.
    // Killing pg_dump alone leaves it running for its whole ten minutes.
    expect(await goneWithin(childPid, 3_000)).toBe(true);
  }, 30_000);

  it('starts pg_dump with --lock-wait-timeout', async () => {
    await script(
      'pg_dump',
      [
        'if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 16.1"; exit 0; fi',
        `printf '%s\\n' "$@" > '${dir}/dump.argv'`,
      ].join('\n'),
    );
    await script('psql', 'echo 0');
    const dumper = new PostgresDatabaseTools({
      databaseUrl: 'postgres://nexa:secret@localhost:5432/nexa',
      dumpTimeoutMs: 60_000,
      restoreTimeoutMs: 60_000,
      binDir: dir,
      migratorEntrypoint: '/nonexistent',
      lowPriorityPrefix: [],
    });
    await dumper.dump(join(dir, 'out.dump'));
    const argv = (await readFile(join(dir, 'dump.argv'), 'utf8')).split('\n');
    expect(argv).toContain(`--lock-wait-timeout=${String(DUMP_LOCK_WAIT_TIMEOUT_MS)}`);
  });

  it('turns a lock-wait failure into backup.dump_lock_timeout, naming the table and its holder', async () => {
    await script(
      'pg_dump',
      [
        'if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 16.1"; exit 0; fi',
        "echo 'pg_dump: error: query failed: ERROR:  canceling statement due to statement timeout' >&2",
        "echo 'pg_dump: detail: Query was: LOCK TABLE public.legacy_import_map IN ACCESS SHARE MODE' >&2",
        'exit 1',
      ].join('\n'),
    );
    await script(
      'psql',
      [
        'for arg in "$@"; do last="$arg"; done',
        'case "$last" in',
        `  *AccessExclusiveLock*) echo "$last" > '${dir}/holders.sql'; echo '[{"pid":77,"applicationName":"nexa-recovery","state":"active","query":"VACUUM FULL legacy_import_map","mode":"AccessExclusiveLock","relation":"legacy_import_map"}]' ;;`,
        '  *) echo 0 ;;',
        'esac',
      ].join('\n'),
    );
    const dumper = new PostgresDatabaseTools({
      databaseUrl: 'postgres://nexa:secret@localhost:5432/nexa',
      dumpTimeoutMs: 60_000,
      restoreTimeoutMs: 60_000,
      binDir: dir,
      migratorEntrypoint: '/nonexistent',
      lowPriorityPrefix: [],
    });
    const failure = (await dumper.dump(join(dir, 'out.dump')).then(
      () => null,
      (reason: unknown) => reason,
    )) as NexaError;
    expect(failure.code).toBe(PLATFORM_ERROR_CODES.BACKUP_DUMP_LOCK_TIMEOUT);
    expect(failure.message).toContain('could not take its ACCESS SHARE lock on legacy_import_map');
    expect(failure.message).toContain('pid 77 "nexa-recovery" (AccessExclusiveLock, active)');
    expect(failure.details.lockRelation).toBe('legacy_import_map');
    expect(await readFile(join(dir, 'holders.sql'), 'utf8')).toContain(
      "to_regclass('public.legacy_import_map')",
    );
  });
});
