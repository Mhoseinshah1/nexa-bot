import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  checksumFile,
  sealArchive,
} from '../../apps/api/src/modules/platform/backup/infrastructure/archive';
import {
  backupWorkDirFromEnvironment,
  cmdRun,
  cmdVerify,
  EXIT_RECOVERY_QUIESCED,
  parseArgs,
  UsageError,
  USAGE,
} from '../../apps/api/src/backup.cli';

/**
 * The operator's backup commands.
 *
 * This file exists because commit `5c040a2` cited seven manually-run command
 * outcomes in its message and committed no test for any of them — which is
 * precisely what CLAUDE.md means by "a claim about testing that leaves no test
 * behind is worse than no claim. Commit the probe or do not cite it." The two
 * refusals that message quoted are the two this file pins.
 *
 * The refusals are tested through `parseArgs` because that is where they now
 * live: they are properties of the arguments, not of a database, and moving
 * them there is what lets a missing `--target` be refused without a connection.
 * The subprocess cases below then prove the wiring — that the exit code an
 * operator sees is the one the code intends — because an exit code is not
 * something a unit test of a pure function can observe.
 */

describe('the backup CLI arguments', () => {
  it('refuses a restore with no target, and says why there is no default', () => {
    // The single most consequential refusal in the whole feature. A restore
    // overwrites, and a default target would be the live database.
    expect(() => parseArgs(['restore', '--archive', '/tmp/a.nxb'])).toThrowError(UsageError);
    expect(() => parseArgs(['restore', '--archive', '/tmp/a.nxb'])).toThrowError(
      /deliberately no default/,
    );
  });

  it('refuses a restore or a verify with no archive', () => {
    expect(() => parseArgs(['restore', '--target', 'db'])).toThrowError(/restore needs --archive/);
    expect(() => parseArgs(['verify'])).toThrowError(/verify needs --archive/);
  });

  it('accepts a fully specified restore', () => {
    expect(parseArgs(['restore', '--archive', '/tmp/a.nxb', '--target', 'nexa_drill'])).toEqual({
      command: 'restore',
      archive: '/tmp/a.nxb',
      target: 'nexa_drill',
      limit: 20,
      kit: null,
    });
  });

  it('takes a Recovery Kit for verify and restore, and for nothing else', () => {
    expect(parseArgs(['verify', '--archive', '/tmp/a.nxb', '--kit', '/tmp/k.nxkit']).kit).toBe(
      '/tmp/k.nxkit',
    );
    expect(() => parseArgs(['run', '--kit', '/tmp/k.nxkit'])).toThrowError(/verify and restore/);
  });

  it('refuses a kit passphrase given as an argument', () => {
    // argv is world-readable in /proc and lands in shell history.
    expect(() =>
      parseArgs(['verify', '--archive', '/tmp/a.nxb', '--kit', 'k', '--passphrase', 'x']),
    ).toThrowError(/standard input/);
  });

  it('refuses a kit passphrase given as --passphrase=VALUE too', () => {
    expect(() =>
      parseArgs(['verify', '--archive', '/tmp/a.nxb', '--kit', 'k', '--passphrase=hunter2-long']),
    ).toThrowError(/standard input/);
  });

  it('refuses an unknown command with the usage text', () => {
    expect(() => parseArgs(['delete-everything'])).toThrowError(UsageError);
    expect(() => parseArgs([])).toThrowError(USAGE);
  });

  it('refuses a flag whose value is another flag', () => {
    // `--archive --target db` would otherwise silently take `--target` as the
    // archive path and then complain that no target was given, which sends an
    // operator looking at the wrong flag.
    expect(() => parseArgs(['restore', '--archive', '--target'])).toThrowError(
      /--archive needs a value/,
    );
  });

  it('bounds --limit rather than trusting it', () => {
    for (const bad of ['0', '501', 'twenty', '-1', '']) {
      expect(() => parseArgs(['list', '--limit', bad])).toThrowError(UsageError);
    }
    expect(parseArgs(['list', '--limit', '5']).limit).toBe(5);
    expect(parseArgs(['list']).limit).toBe(20);
  });

  it('needs neither an archive nor a target to run or list', () => {
    expect(parseArgs(['run']).command).toBe('run');
    expect(parseArgs(['list']).archive).toBeNull();
  });
});

/**
 * The compiled CLI, run as a process.
 *
 * `dist`, not the source: this is the artifact an operator invokes, and
 * `scripts/check-runtime-cli.sh` already proves it loads without a
 * devDependency. What that script does NOT do is call anything — it asserts the
 * exports exist. These cases call it.
 *
 * No database is touched. That is the point of the refactor these tests pin:
 * every case here is refused before a container is built, so they run in a
 * few milliseconds and work when the database is down — which is the state an
 * operator is in when they reach for this command.
 */
describe('the backup CLI as a process', () => {
  const cli = join(__dirname, '../../apps/api/dist/backup.cli.js');

  function run(args: readonly string[]): { code: number; stderr: string; stdout: string } {
    try {
      const stdout = execFileSync(process.execPath, [cli, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        // A keyring and nothing else. No DATABASE_URL, no REDIS_URL, no
        // AUTH_MODE — so a case that starts needing them fails here rather
        // than quietly becoming an integration test.
        env: {
          PATH: process.env.PATH ?? '',
          SECRETS_KEK: 'A'.repeat(42) + '0=',
          SECRETS_KEK_ID: 'test-1',
        },
      });
      return { code: 0, stdout, stderr: '' };
    } catch (error) {
      const failure = error as { status?: number; stderr?: string; stdout?: string };
      return {
        code: failure.status ?? -1,
        stderr: failure.stderr ?? '',
        stdout: failure.stdout ?? '',
      };
    }
  }

  it('exits 64 on a restore with no target, with no database configured', () => {
    const result = run(['restore', '--archive', '/tmp/nothing.nxb']);
    // 64 is `EX_USAGE`. Distinguishing it from 1 is what lets a script tell an
    // operator's mistake from a failed backup.
    expect(result.code).toBe(64);
    expect(result.stderr).toMatch(/deliberately no default/);
    // And nothing about the database was consulted to reach that answer.
    expect(result.stderr).not.toMatch(/DATABASE_URL|configuration/i);
  });

  it('exits 64 and prints usage when given no command', () => {
    const result = run([]);
    expect(result.code).toBe(64);
    expect(result.stderr).toMatch(/usage:/);
    expect(result.stderr).toMatch(/backup restore --archive PATH --target DB/);
  });

  it('refuses an archive that is not an archive, without a database', () => {
    // `verify` is the command that must work when the database is the thing
    // that is broken. Running it with no database configuration at all proves
    // it builds no container — the property its docblock claims.
    const result = run(['verify', '--archive', '/etc/hostname']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/backup\.archive_malformed/);
  });
});

/**
 * `backup run` during a recovery (E4: "backup while recovery quiesces").
 *
 * The scheduler and the Web button both refused; the CLI did not, so an
 * operator's shell backup during QUIESCING or RESTORING dumped a database about
 * to be renamed away. The integration twin is in
 * `tests/integration/recovery-failure-drills.test.ts`.
 */
describe('backup run while a recovery holds the installation', () => {
  function stub(quiesced: boolean) {
    const calls: string[] = [];
    const container = {
      recoveryQuiesced: async () => {
        calls.push('quiesced?');
        return quiesced;
      },
      tenants: {
        findPrimary: async () => {
          calls.push('tenant');
          return null;
        },
      },
      setInstallationTenant: () => {
        calls.push('setTenant');
      },
      logger: { warn() {} },
      backup: {
        run: async () => {
          calls.push('run');
          return {
            kind: 'BUSY' as const,
            holder: { id: 'h', startedAt: new Date(0), stage: 'DUMP' },
          };
        },
      },
    };
    return { container: container as unknown as Parameters<typeof cmdRun>[0], calls };
  }

  it('refuses with its own exit code and starts nothing', async () => {
    const { container, calls } = stub(true);
    const write = process.stderr.write.bind(process.stderr);
    let said = '';
    process.stderr.write = ((chunk: string) => {
      said += chunk;
      return true;
    }) as typeof process.stderr.write;
    try {
      expect(await cmdRun(container)).toBe(EXIT_RECOVERY_QUIESCED);
    } finally {
      process.stderr.write = write;
    }
    expect(EXIT_RECOVERY_QUIESCED).toBe(4);
    // Asked FIRST, and nothing after it: no tenant lookup, no backup.
    expect(calls).toEqual(['quiesced?']);
    expect(said).toMatch(/recovery is restoring/);
  });

  it('runs exactly as before when no recovery holds the installation', async () => {
    const { container, calls } = stub(false);
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      // BUSY from the stub: exit 2, which proves `run` was reached.
      expect(await cmdRun(container)).toBe(2);
    } finally {
      process.stdout.write = write;
    }
    expect(calls).toEqual(['quiesced?', 'tenant', 'setTenant', 'run']);
  });
});

describe('where the CLI decrypts', () => {
  it('verify decrypts under BACKUP_WORK_DIR and removes its directory afterwards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexa-cli-verify-'));
    const saved = { ...process.env };
    const write = process.stdout.write.bind(process.stdout);
    try {
      const key = randomBytes(32);
      const dumpPath = join(dir, 'dump.pgcustom');
      await writeFile(dumpPath, randomBytes(4096));
      const archivePath = join(dir, 'archive.nxb');
      await sealArchive({
        dumpPath,
        archivePath,
        keyring: { activeKeyId: 'kcli', keys: new Map([['kcli', key]]), format: 'canonical' },
        manifest: {
          manifestVersion: 1,
          backupId: '0192f000-0000-7000-8000-00000000c11a',
          installationId: 'i',
          createdAt: '2026-01-01T00:00:00.000Z',
          databaseName: 'nexa',
          postgresVersion: '16.13',
          pgDumpVersion: 'pg_dump (PostgreSQL) 16.13',
          dumpFormat: 'custom',
          dumpBytes: 4096,
          checksumAlgorithm: 'sha256',
          checksum: (await checksumFile(dumpPath)).checksum,
          exclusions: [],
        },
      });
      const workDir = join(dir, 'backups');
      process.env.BACKUP_WORK_DIR = workDir;
      process.env.SECRETS_KEYS = `kcli:${key.toString('base64')}`;
      process.env.SECRETS_ACTIVE_KEY_ID = 'kcli';
      delete process.env.SECRETS_KEK;
      delete process.env.SECRETS_KEK_ID;
      process.stdout.write = (() => true) as typeof process.stdout.write;

      expect(await cmdVerify(archivePath)).toBe(0);
      // The work root was used (created on demand, 0700) and the private
      // `.cli-verify-*` directory inside it is gone again.
      expect(await readdir(workDir)).toEqual([]);
    } finally {
      process.stdout.write = write;
      process.env = saved;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses BACKUP_WORK_DIR, with the schema default, and never the system temp directory', () => {
    const saved = process.env.BACKUP_WORK_DIR;
    try {
      delete process.env.BACKUP_WORK_DIR;
      expect(backupWorkDirFromEnvironment()).toBe('/var/lib/nexa/backups');
      process.env.BACKUP_WORK_DIR = '  /srv/nexa/backups ';
      expect(backupWorkDirFromEnvironment()).toBe('/srv/nexa/backups');
    } finally {
      if (saved === undefined) delete process.env.BACKUP_WORK_DIR;
      else process.env.BACKUP_WORK_DIR = saved;
    }
  });
});
