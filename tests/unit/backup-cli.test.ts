import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, UsageError, USAGE } from '../../apps/api/src/backup.cli';

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
    });
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
