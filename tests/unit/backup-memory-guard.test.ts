import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_ERROR_CODES, type BackupManifest } from '@nexa/contracts';
import {
  chooseSevenZipLevel,
  parseMemAvailableMb,
  SEVEN_ZIP_LEVELS,
  DEFAULT_SEVEN_ZIP_MEMORY_MB,
  type SevenZipMemoryPolicy,
} from '../../apps/api/src/modules/platform/backup/infrastructure/seven-zip-levels';
import {
  sealArgs,
  sealSevenZip,
  type SevenZipOptions,
} from '../../apps/api/src/modules/platform/backup/infrastructure/seven-zip';
import {
  resolveLowPriorityPrefix,
  wrapLowPriority,
  killedBySignal,
} from '../../apps/api/src/modules/platform/backup/infrastructure/tool-process';
import {
  PostgresDatabaseTools,
  VERIFY_RESTORE_PGOPTIONS,
} from '../../apps/api/src/modules/platform/backup/infrastructure/pg-tools';

/**
 * Round 5B: 7-Zip was OOM-killed on a 4 GB / 2 vCPU host (about 2.4 GB resident at `-mx=9`
 * with every core), and the verification's `pg_restore` pegged the same two vCPUs.
 *
 * Real child processes are used for the argv and signal cases: a fake that records a call
 * proves only that the code made it. The fakes here are tiny shell scripts standing in for
 * 7z / pg_restore, so what is asserted is what a process on this host actually received.
 */

const PEAKS = SEVEN_ZIP_LEVELS.map((level) => level.estimatedPeakMb);
const LIGHTEST = Math.min(...PEAKS);

function policy(overrides: Partial<SevenZipMemoryPolicy> & { available: number | null }) {
  const { available, ...rest } = overrides;
  return {
    budgetMb: 100_000,
    headroomMb: 0,
    maxMx: 9,
    maxThreads: 16,
    readAvailableMb: async () => available,
    ...rest,
  } satisfies SevenZipMemoryPolicy;
}

describe('the 7-Zip level table', () => {
  it('is ordered strongest first, with the memory falling at every step', () => {
    for (let i = 1; i < SEVEN_ZIP_LEVELS.length; i += 1) {
      const before = SEVEN_ZIP_LEVELS[i - 1];
      const level = SEVEN_ZIP_LEVELS[i];
      expect(level?.estimatedPeakMb).toBeLessThan(before?.estimatedPeakMb ?? 0);
    }
  });

  it('fixes the dictionary and the threads of every level explicitly', () => {
    for (const level of SEVEN_ZIP_LEVELS) {
      expect(level.md).toMatch(/^\d+m$/);
      expect(level.mmt).toBeGreaterThanOrEqual(1);
    }
  });

  it('has a level inside the default budget, so a roomy host never refuses', () => {
    expect(LIGHTEST).toBeLessThanOrEqual(DEFAULT_SEVEN_ZIP_MEMORY_MB);
    // ...and the default budget is below the 2.4 GB that was killed.
    expect(DEFAULT_SEVEN_ZIP_MEMORY_MB).toBeLessThan(1_000);
  });
});

describe('choosing a level from the memory the host has', () => {
  it('reads MemAvailable from /proc/meminfo, in MiB', () => {
    const text = 'MemTotal:        4046848 kB\nMemFree:  100 kB\nMemAvailable:    2097152 kB\n';
    expect(parseMemAvailableMb(text)).toBe(2048);
    expect(parseMemAvailableMb('MemTotal: 1 kB\n')).toBeNull();
  });

  it('takes the strongest level when memory is plentiful', async () => {
    const choice = await chooseSevenZipLevel(policy({ available: 1_000_000 }));
    expect(choice.kind === 'LEVEL' && choice.level).toEqual(SEVEN_ZIP_LEVELS[0]);
  });

  it('takes the strongest level that fits the free memory, less the headroom', async () => {
    for (const level of SEVEN_ZIP_LEVELS) {
      const choice = await chooseSevenZipLevel(
        policy({ available: level.estimatedPeakMb + 256, headroomMb: 256 }),
      );
      // The strongest row whose peak is no more than this row's.
      const expected = SEVEN_ZIP_LEVELS.find(
        (candidate) => candidate.estimatedPeakMb <= level.estimatedPeakMb,
      );
      expect(choice.kind === 'LEVEL' && choice.level.name).toBe(expected?.name);
    }
  });

  it('is bounded by the budget even when the host has more', async () => {
    const choice = await chooseSevenZipLevel(policy({ available: 1_000_000, budgetMb: LIGHTEST }));
    expect(choice.kind === 'LEVEL' && choice.level.estimatedPeakMb).toBe(LIGHTEST);
  });

  it('refuses when even the lightest level does not fit', async () => {
    const choice = await chooseSevenZipLevel(
      policy({ available: LIGHTEST + 255, headroomMb: 256 }),
    );
    expect(choice).toMatchObject({ kind: 'REFUSED', neededMb: LIGHTEST });
  });

  it('uses the budget alone when the host cannot say how much is free', async () => {
    const choice = await chooseSevenZipLevel(policy({ available: null, budgetMb: LIGHTEST }));
    expect(choice.kind).toBe('LEVEL');
  });

  it('never picks a level with more threads than the operator allowed', async () => {
    const choice = await chooseSevenZipLevel(policy({ available: 1_000_000, maxThreads: 1 }));
    expect(choice.kind === 'LEVEL' && choice.level.mmt).toBe(1);
  });

  it('lowers the effort to the operator ceiling without dropping the level', async () => {
    const choice = await chooseSevenZipLevel(policy({ available: 1_000_000, maxMx: 1 }));
    expect(choice.kind === 'LEVEL' && choice.level.mx).toBe(1);
  });
});

describe('the low-priority wrapper', () => {
  const probeOf =
    (works: (command: string, args: readonly string[]) => boolean) =>
    (command: string, args: readonly string[]) =>
      works(command, args);

  it('is ionice idle class under nice 10 when both work', () => {
    expect(resolveLowPriorityPrefix(probeOf(() => true))).toEqual([
      'ionice',
      '-c3',
      'nice',
      '-n',
      '10',
    ]);
  });

  it('falls back to ionice best-effort 7 where idle is refused', () => {
    const prefix = resolveLowPriorityPrefix(
      probeOf((command, args) => !(command === 'ionice' && args[0] === '-c3')),
    );
    expect(prefix).toEqual(['ionice', '-c2', '-n7', 'nice', '-n', '10']);
  });

  it('drops a wrapper that is missing, and runs unwrapped when both are', () => {
    expect(resolveLowPriorityPrefix(probeOf((command) => command !== 'ionice'))).toEqual([
      'nice',
      '-n',
      '10',
    ]);
    expect(resolveLowPriorityPrefix(probeOf(() => false))).toEqual([]);
  });

  it('puts the prefix in front of the command and leaves it alone with none', () => {
    expect(wrapLowPriority('7z', ['a', 'x'], ['ionice', '-c3', 'nice', '-n', '10'])).toEqual({
      command: 'ionice',
      args: ['-c3', 'nice', '-n', '10', '7z', 'a', 'x'],
    });
    expect(wrapLowPriority('7z', ['a'], [])).toEqual({ command: '7z', args: ['a'] });
  });

  it('knows a kernel kill from an ordinary failure', () => {
    expect(killedBySignal(null, 'SIGKILL')).toBe(true);
    expect(killedBySignal(137, null)).toBe(true);
    expect(killedBySignal(2, null)).toBe(false);
    expect(killedBySignal(null, 'SIGTERM')).toBe(false);
  });
});

describe('sealing with 7-Zip under a memory budget', () => {
  let dir: string;
  let dumpPath: string;
  let archivePath: string;

  const manifest: BackupManifest = {
    manifestVersion: 1,
    backupId: '0193a000-0000-7000-8000-000000000001',
    installationId: 'installation-1',
    createdAt: '2026-10-19T04:00:00.000Z',
    databaseName: 'nexa',
    postgresVersion: '16.13',
    pgDumpVersion: 'pg_dump (PostgreSQL) 16.13',
    dumpFormat: 'custom',
    dumpBytes: 4,
    checksumAlgorithm: 'sha256',
    checksum: 'a'.repeat(64),
    exclusions: [],
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexa-memguard-'));
    dumpPath = join(dir, 'dump.pgcustom');
    archivePath = join(dir, 'archive.7z');
    await writeFile(dumpPath, 'PGDMP');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function script(name: string, body: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  function options(binary: string, extra: Partial<SevenZipOptions> = {}): SevenZipOptions {
    return {
      binary,
      level: 9,
      threads: 2,
      memoryBudgetMb: 100_000,
      memoryHeadroomMb: 0,
      readAvailableMb: async () => null,
      lowPriorityPrefix: [],
      sealTimeoutMs: 30_000,
      openTimeoutMs: 30_000,
      ...extra,
    };
  }

  async function seal(opts: SevenZipOptions): Promise<unknown> {
    try {
      return await sealSevenZip({ dumpPath, archivePath, manifest, password: 'pw', options: opts });
    } catch (error) {
      return error;
    }
  }

  it('refuses before spawning when the host cannot hold even the lightest level', async () => {
    const marker = join(dir, 'spawned');
    const binary = await script('7z-fake', `touch "${marker}"`);
    const error = await seal(
      options(binary, { memoryHeadroomMb: 256, readAvailableMb: async () => LIGHTEST + 100 }),
    );

    expect(error).toMatchObject({ code: PLATFORM_ERROR_CODES.BACKUP_MEMORY_INSUFFICIENT });
    // 7-Zip never started, and nothing was staged for it.
    await expect(stat(marker)).rejects.toThrow();
    await expect(stat(join(dir, 'manifest.json'))).rejects.toThrow();
  });

  it('records a 7-Zip killed by SIGKILL as an out-of-memory failure', async () => {
    const binary = await script('7z-fake', 'kill -9 $$');
    expect(await seal(options(binary))).toMatchObject({
      code: PLATFORM_ERROR_CODES.BACKUP_TOOL_OOM_KILLED,
    });
  });

  it('records exit status 137 the same way, and an ordinary failure as an ordinary one', async () => {
    expect(await seal(options(await script('7z-137', 'exit 137')))).toMatchObject({
      code: PLATFORM_ERROR_CODES.BACKUP_TOOL_OOM_KILLED,
    });
    expect(await seal(options(await script('7z-2', 'exit 2')))).toMatchObject({
      code: PLATFORM_ERROR_CODES.BACKUP_TOOL_FAILED,
    });
  });

  it('starts 7-Zip with an explicit dictionary and thread count, under the wrapper', async () => {
    const log = join(dir, 'argv.log');
    const wrapped = join(dir, 'wrapped.log');
    const binary = await script('7z-fake', `printf '%s\\n' "$@" > "${log}"\nexit 2`);
    const wrapper = await script('wrapper', `printf '%s\\n' "$@" > "${wrapped}"\nshift\nexec "$@"`);
    await seal(
      options(binary, {
        readAvailableMb: async () => 1_000_000,
        threads: 1,
        lowPriorityPrefix: [wrapper, 'nice-and-ionice'],
      }),
    );

    const argv = (await readFile(log, 'utf8')).split('\n');
    expect(argv).toContain('-mmt=1');
    expect(argv.some((arg) => /^-md=\d+m$/.test(arg))).toBe(true);
    expect(argv.some((arg) => /^-mx=\d$/.test(arg))).toBe(true);
    // The wrapper was put in front: it saw its own argument, then the binary.
    const front = (await readFile(wrapped, 'utf8')).split('\n');
    expect(front[0]).toBe('nice-and-ionice');
    expect(front[1]).toBe(binary);
  });

  it('writes -mmt and -md into the argv of every level', () => {
    for (const level of SEVEN_ZIP_LEVELS) {
      const argv = sealArgs(level, '/a.7z', 'dump');
      expect(argv).toContain(`-mmt=${String(level.mmt)}`);
      expect(argv).toContain(`-md=${level.md}`);
      expect(argv).toContain(`-mx=${String(level.mx)}`);
    }
  });
});

describe('the PostgreSQL tools under a low-priority wrapper', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexa-pgtools-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function script(name: string, body: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  async function tools(pgDump = 'exit 0') {
    await script('psql', 'echo 0');
    await script(
      'pg_restore',
      `{ printf '%s\\n' "$@"; echo "PGOPTIONS=$PGOPTIONS"; } > "${dir}/restore.log"`,
    );
    await script(
      'pg_dump',
      `if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 16.1"; exit 0; fi\n` +
        `printf '%s\\n' "$@" > "${dir}/dump.log"\n${pgDump}`,
    );
    const wrapper = await script(
      'wrapper',
      `printf '%s\\n' "$@" >> "${dir}/wrapped.log"\nshift\nexec "$@"`,
    );
    return new PostgresDatabaseTools({
      databaseUrl: 'postgres://nexa:secret@localhost:5432/nexa',
      dumpTimeoutMs: 60_000,
      restoreTimeoutMs: 60_000,
      binDir: dir,
      migratorEntrypoint: '/nonexistent',
      lowPriorityPrefix: [wrapper, 'low-priority'],
    });
  }

  class VerifyProbe extends PostgresDatabaseTools {
    override async createDatabase(): Promise<void> {}
    override async inspectDatabase(): Promise<never> {
      return { tableCount: 3 } as never;
    }
    override async dropDatabase(): Promise<{ dropped: boolean }> {
      return { dropped: true };
    }
  }

  it('verifies with one restore job, bounded maintenance memory and nice/ionice', async () => {
    await tools();
    const verify = new VerifyProbe({
      databaseUrl: 'postgres://nexa:secret@localhost:5432/nexa',
      dumpTimeoutMs: 60_000,
      restoreTimeoutMs: 60_000,
      binDir: dir,
      migratorEntrypoint: '/nonexistent',
      lowPriorityPrefix: [join(dir, 'wrapper'), 'low-priority'],
    });
    const outcome = await verify.verifyRestore('/tmp/does-not-matter.dump');

    expect(outcome.ok).toBe(true);
    const restore = (await readFile(join(dir, 'restore.log'), 'utf8')).split('\n');
    expect(restore).toContain('--jobs=1');
    expect(restore).toContain(`PGOPTIONS=${VERIFY_RESTORE_PGOPTIONS}`);
    expect(VERIFY_RESTORE_PGOPTIONS).toContain('maintenance_work_mem=64MB');
    const wrapped = (await readFile(join(dir, 'wrapped.log'), 'utf8')).split('\n');
    expect(wrapped[0]).toBe('low-priority');
    expect(wrapped[1]).toBe(join(dir, 'pg_restore'));
  });

  it("leaves the operator's own restore at full speed", async () => {
    const full = await tools();
    await full.restoreIntoEmpty('nexa_target', '/tmp/x.dump');
    const restore = (await readFile(join(dir, 'restore.log'), 'utf8')).split('\n');
    expect(restore).not.toContain('--jobs=1');
    expect(restore).toContain('PGOPTIONS=');
  });

  it('runs pg_dump under the wrapper', async () => {
    const dumper = await tools();
    await dumper.dump('/tmp/out.dump', { uncompressed: true });
    const wrapped = (await readFile(join(dir, 'wrapped.log'), 'utf8')).split('\n');
    expect(wrapped[0]).toBe('low-priority');
    expect(wrapped[1]).toBe(join(dir, 'pg_dump'));
  });

  it('records a pg_dump the kernel killed as an out-of-memory failure', async () => {
    const dumper = await tools('kill -9 $$');
    await expect(dumper.dump('/tmp/out.dump')).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.BACKUP_TOOL_OOM_KILLED,
    });
  });
});
