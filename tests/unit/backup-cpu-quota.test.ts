import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_CPU_LIMIT_DEFAULT, BACKUP_CPU_LIMIT_SETTING_KEY, SETTINGS } from '@nexa/contracts';
import {
  cpuDutyCycle,
  describeCpuQuota,
  resolveCpuLimit,
  startCpuThrottle,
  type CpuThrottleTimers,
} from '../../apps/api/src/modules/platform/backup/infrastructure/cpu-quota';
import {
  sealSevenZip,
  sealArgs,
  type SevenZipOptions,
} from '../../apps/api/src/modules/platform/backup/infrastructure/seven-zip';
import {
  SEVEN_ZIP_LEVELS,
  chooseSevenZipLevel,
} from '../../apps/api/src/modules/platform/backup/infrastructure/seven-zip-levels';
import { PostgresDatabaseTools } from '../../apps/api/src/modules/platform/backup/infrastructure/pg-tools';
import { loadConfig } from '../../apps/api/src/infrastructure/config/load-config';

/**
 * Round 8 B5: the backup's heavy tools run under a CPU quota, because `nice` alone let a
 * two-thread 7-Zip hold both vCPUs of a two-core host for thirteen minutes.
 */

class FakeTimers implements CpuThrottleTimers {
  readonly pending: { callback: () => void; ms: number; cancelled: boolean }[] = [];
  setTimeout(callback: () => void, ms: number) {
    const entry = { callback, ms, cancelled: false };
    this.pending.push(entry);
    return entry as unknown as { unref?: () => void };
  }
  clearTimeout(handle: unknown): void {
    (handle as { cancelled: boolean }).cancelled = true;
  }
  /** Fires the oldest live timer. */
  fire(): number {
    const next = this.pending.find((entry) => !entry.cancelled);
    if (next === undefined) throw new Error('no timer pending');
    next.cancelled = true;
    next.callback();
    return next.ms;
  }
}

describe('cpu duty cycle', () => {
  it('splits a period by the percentage of one core', () => {
    expect(cpuDutyCycle(70, 100)).toEqual({ runMs: 70, stopMs: 30 });
    expect(cpuDutyCycle(25, 100)).toEqual({ runMs: 25, stopMs: 75 });
    expect(cpuDutyCycle(100, 100)).toEqual({ runMs: 100, stopMs: 0 });
  });

  it('alternates SIGSTOP and SIGCONT for the stated shares, and leaves the tool running on release', () => {
    const signals: string[] = [];
    const timers = new FakeTimers();
    const throttle = startCpuThrottle({ kill: (s) => (signals.push(s), true) }, 70, { timers });
    expect(timers.fire()).toBe(70); // the first slice runs
    expect(signals).toEqual(['SIGSTOP']);
    expect(timers.fire()).toBe(30); // then the stopped slice
    expect(signals).toEqual(['SIGSTOP', 'SIGCONT']);
    timers.fire();
    expect(signals).toEqual(['SIGSTOP', 'SIGCONT', 'SIGSTOP']);
    throttle.release();
    // Released while stopped: it MUST be continued, or a later SIGTERM never lands.
    expect(signals.at(-1)).toBe('SIGCONT');
    const count = signals.length;
    throttle.release();
    expect(signals).toHaveLength(count);
    expect(timers.pending.every((entry) => entry.cancelled)).toBe(true);
  });

  it('touches nothing at 100 percent', () => {
    const signals: string[] = [];
    const timers = new FakeTimers();
    const throttle = startCpuThrottle({ kill: (s) => (signals.push(s), true) }, 100, { timers });
    throttle.release();
    expect(timers.pending).toHaveLength(0);
    expect(signals).toEqual([]);
  });

  it('describes the quota where an operator or a log can see it', () => {
    expect(describeCpuQuota(70)).toBe('cpu-limit=70%');
    expect(describeCpuQuota(100)).toBe('cpu-limit=none');
  });

  it('reads the limit per call and fails to the default rather than blocking a backup', async () => {
    expect(await resolveCpuLimit(async () => 40, 70)).toBe(40);
    expect(await resolveCpuLimit(async () => Number.NaN, 70)).toBe(70);
    expect(
      await resolveCpuLimit(async () => {
        throw new Error('settings unavailable');
      }, 70),
    ).toBe(70);
    expect(await resolveCpuLimit(undefined, 70)).toBe(100);
  });
});

describe('the setting and the defaults', () => {
  it('declares «حداکثر مصرف CPU بکاپ» at 70 percent of one core', () => {
    const definition = SETTINGS.find((one) => one.key === BACKUP_CPU_LIMIT_SETTING_KEY);
    expect(definition?.defaultValue).toBe(70);
    expect(BACKUP_CPU_LIMIT_DEFAULT).toBe(70);
    expect(definition?.schema.safeParse(5).success).toBe(false);
    expect(definition?.schema.safeParse(101).success).toBe(false);
    expect(definition?.schema.safeParse(70).success).toBe(true);
  });

  it('compresses with ONE thread unless an operator raises the ceiling', () => {
    const config = loadConfig({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://u:p@localhost:5432/db',
      REDIS_URL: 'redis://localhost:6379',
      SECRETS_KEK: Buffer.alloc(32, 7).toString('base64'),
      SECRETS_KEK_ID: 'dev-1',
      TRUSTED_PROXY_IPS: '127.0.0.1,::1',
    });
    expect(config.BACKUP_SEVEN_ZIP_THREADS).toBe(1);
  });

  it('never picks a two-thread level under a one-thread ceiling, and states -mmt in argv', async () => {
    const choice = await chooseSevenZipLevel({
      budgetMb: 100_000,
      headroomMb: 0,
      maxMx: 9,
      maxThreads: 1,
      readAvailableMb: async () => null,
    });
    expect(choice.kind).toBe('LEVEL');
    if (choice.kind === 'LEVEL') {
      expect(choice.level.mmt).toBe(1);
      expect(sealArgs(choice.level, 'a.7z', 'd')).toContain('-mmt=1');
    }
    expect(SEVEN_ZIP_LEVELS.filter((level) => level.mmt > 1).map((level) => level.name)).toEqual([
      'max',
    ]);
  });
});

describe('a real process under the quota', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nexa-cpuquota-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A tool that spins for 1.5 s of wall time and reports the CPU it was given. */
  async function spinner(name: string): Promise<{ path: string; report: string }> {
    const report = join(dir, `${name}.report`);
    const path = join(dir, name);
    await writeFile(
      path,
      [
        '#!/bin/bash',
        'if [ "$1" = "--version" ]; then echo "pg_dump (PostgreSQL) 16.1"; exit 0; fi',
        'start=${EPOCHREALTIME/./}',
        'while :; do now=${EPOCHREALTIME/./}; [ $((now - start)) -ge 1500000 ] && break; done',
        'read -r -a stat < /proc/$$/stat',
        // utime and stime, in clock ticks of 10 ms
        `echo "$(( (stat[13] + stat[14]) * 10 )) $(( (now - start) / 1000 ))" > "${report}"`,
        'exit 2',
      ].join('\n') + '\n',
    );
    await chmod(path, 0o755);
    return { path, report };
  }

  async function cpuShare(report: string): Promise<number> {
    const [cpuMs, wallMs] = (await readFile(report, 'utf8')).trim().split(' ').map(Number);
    return (cpuMs ?? 0) / (wallMs ?? 1);
  }

  const sevenZip = (binary: string, extra: Partial<SevenZipOptions>): SevenZipOptions => ({
    binary,
    level: 1,
    threads: 1,
    memoryBudgetMb: 1_000,
    memoryHeadroomMb: 0,
    readAvailableMb: async () => null,
    lowPriorityPrefix: [],
    sealTimeoutMs: 60_000,
    openTimeoutMs: 60_000,
    ...extra,
  });

  async function seal(options: SevenZipOptions): Promise<void> {
    const dump = join(dir, 'dump.pgcustom');
    await writeFile(dump, 'PGDMP');
    await sealSevenZip({
      dumpPath: dump,
      archivePath: join(dir, 'archive.7z'),
      manifest: {} as never,
      password: 'correct horse battery staple',
      options,
    }).catch(() => undefined); // the spinner exits 2 on purpose; only its report matters
  }

  it('holds 7-Zip to its 20 percent share, which the same tool without a limit exceeds', async () => {
    const limited = await spinner('limited');
    await seal(sevenZip(limited.path, { cpuLimit: async () => 20 }));
    const free = await spinner('free');
    await seal(sevenZip(free.path, {}));
    const limitedShare = await cpuShare(limited.report);
    const freeShare = await cpuShare(free.report);
    // Relative, because a shared CI host gives even an unthrottled loop well under a core.
    expect(limitedShare).toBeLessThan(0.25);
    expect(limitedShare).toBeLessThan(freeShare * 0.75);
  }, 30_000);

  it('applies the quota to the verification pg_restore, and only to it', async () => {
    const restore = await spinner('pg_restore');
    await writeFile(join(dir, 'psql'), '#!/bin/sh\necho 0\n');
    await chmod(join(dir, 'psql'), 0o755);
    const asked: string[] = [];
    class Probe extends PostgresDatabaseTools {
      override async createDatabase(): Promise<void> {}
      override async inspectDatabase(): Promise<never> {
        return { tableCount: 3 } as never;
      }
      override async dropDatabase(): Promise<{ dropped: boolean }> {
        return { dropped: true };
      }
    }
    const make = (cpuLimit?: () => Promise<number>) =>
      new Probe({
        databaseUrl: 'postgres://nexa:secret@localhost:5432/nexa',
        dumpTimeoutMs: 60_000,
        restoreTimeoutMs: 60_000,
        binDir: dir,
        migratorEntrypoint: '/nonexistent',
        lowPriorityPrefix: [],
        ...(cpuLimit === undefined ? {} : { cpuLimit }),
      });
    await make(async () => {
      asked.push('asked');
      return 20;
    })
      .verifyRestore(join(dir, 'x.dump'))
      .catch(() => undefined);
    const limitedShare = await cpuShare(restore.report);
    await make()
      .verifyRestore(join(dir, 'x.dump'))
      .catch(() => undefined);
    const freeShare = await cpuShare(restore.report);
    expect(asked.length).toBeGreaterThan(0);
    expect(limitedShare).toBeLessThan(0.25);
    expect(limitedShare).toBeLessThan(freeShare * 0.75);
  }, 30_000);
});
