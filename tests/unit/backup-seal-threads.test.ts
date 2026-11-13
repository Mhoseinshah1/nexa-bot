import { describe, expect, it } from 'vitest';
import {
  allowedCores,
  parseCgroupBytes,
  parseCgroupV1Cpu,
  parseCgroupV2CpuMax,
  parseInactiveFileBytes,
  readAllowedCores,
  readCgroupAvailableMb,
  type TextReader,
} from '../../apps/api/src/modules/platform/backup/infrastructure/cgroup-limits';
import {
  chooseSevenZipLevel,
  estimateSevenZipPeakMb,
  SEVEN_ZIP_ROWS,
  type SevenZipMemoryPolicy,
} from '../../apps/api/src/modules/platform/backup/infrastructure/seven-zip-levels';
import { sealArgs } from '../../apps/api/src/modules/platform/backup/infrastructure/seven-zip';

/**
 * The 2026-11 backup-speed round: the seal's thread count follows the cores the container is
 * allowed (it was forced to 1 whenever a CPU quota was in force: 26 minutes for a 2 GB dump on
 * a 4-core server), and the memory estimate keeps 7-Zip inside the role's memory limit.
 */

const files = (map: Record<string, string>): TextReader => {
  return async (path) => map[path] ?? null;
};

describe('the cores the container is allowed', () => {
  it('reads cgroup v2 cpu.max: quota over period, floored, at least 1, at most the host', () => {
    expect(parseCgroupV2CpuMax('max 100000\n')).toBeNull();
    expect(parseCgroupV2CpuMax('300000 100000\n')).toBe(3);
    expect(allowedCores(parseCgroupV2CpuMax('250000 100000'), 8)).toBe(2);
    expect(allowedCores(parseCgroupV2CpuMax('50000 100000'), 8)).toBe(1);
    expect(allowedCores(parseCgroupV2CpuMax('800000 100000'), 4)).toBe(4);
    expect(allowedCores(null, 4)).toBe(4);
  });

  it('reads cgroup v1 cfs quota and period, where -1 is no limit', () => {
    expect(parseCgroupV1Cpu('-1\n', '100000\n')).toBeNull();
    expect(parseCgroupV1Cpu('200000\n', '100000\n')).toBe(2);
  });

  it('prefers v2, falls back to v1, and fails open to the host', async () => {
    expect(await readAllowedCores(files({ '/sys/fs/cgroup/cpu.max': '200000 100000' }), 8)).toBe(2);
    expect(
      await readAllowedCores(
        files({
          '/sys/fs/cgroup/cpu/cpu.cfs_quota_us': '300000',
          '/sys/fs/cgroup/cpu/cpu.cfs_period_us': '100000',
        }),
        8,
      ),
    ).toBe(3);
    expect(await readAllowedCores(files({}), 6)).toBe(6);
  });
});

describe('the memory the container may still use', () => {
  const MIB = 1024 * 1024;
  it('is the limit less the non-reclaimable usage, and null with no limit', async () => {
    expect(parseCgroupBytes('max\n')).toBeNull();
    expect(parseCgroupBytes('9223372036854771712')).toBeNull();
    expect(parseInactiveFileBytes('anon 1\ninactive_file 4096\nactive_file 1\n')).toBe(4096);
    expect(parseInactiveFileBytes('total_inactive_file 8192\n')).toBe(8192);
    expect(
      await readCgroupAvailableMb(
        files({
          '/sys/fs/cgroup/memory.max': String(819 * MIB),
          '/sys/fs/cgroup/memory.current': String(500 * MIB),
          '/sys/fs/cgroup/memory.stat': `inactive_file ${String(100 * MIB)}\n`,
        }),
      ),
    ).toBe(419);
    expect(await readCgroupAvailableMb(files({ '/sys/fs/cgroup/memory.max': 'max' }))).toBeNull();
    expect(await readCgroupAvailableMb(files({}))).toBeNull();
  });
});

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

describe('the seal plan follows the quota', () => {
  it('uses as many threads as the container has cores, when the memory allows', async () => {
    for (const cores of [1, 2, 3, 4]) {
      const choice = await chooseSevenZipLevel(policy({ available: 8_000, cores }));
      if (choice.kind !== 'LEVEL') throw new Error('refused');
      expect(choice.level.mmt).toBe(cores);
      expect(sealArgs(choice.level, 'a.7z', 'd')).toContain(`-mmt=${String(cores)}`);
    }
  });

  it('never exceeds the operator ceiling nor the cores, and is one thread without a core count', async () => {
    const capped = await chooseSevenZipLevel(policy({ available: 8_000, cores: 8, maxThreads: 3 }));
    expect(capped.kind === 'LEVEL' && capped.level.mmt).toBe(3);
    const unknown = await chooseSevenZipLevel(policy({ available: 8_000 }));
    expect(unknown.kind === 'LEVEL' && unknown.level.mmt).toBe(1);
  });

  it('drops threads, then the dictionary, rather than pass the allowance', async () => {
    for (const allowance of [900, 400, 220, 140, 100, 80]) {
      const choice = await chooseSevenZipLevel(policy({ available: allowance, cores: 4 }));
      if (choice.kind !== 'LEVEL') throw new Error(`refused at ${String(allowance)}`);
      expect(choice.level.estimatedPeakMb).toBeLessThanOrEqual(allowance);
      expect(choice.level.estimatedPeakMb).toBe(
        estimateSevenZipPeakMb(choice.level.mx, choice.level.md, choice.level.mmt),
      );
    }
  });
});

describe('the memory estimate under the role limit', () => {
  // The worker's default `mem_limit` on an 8 GiB host (deploy/compose.yml), less what the
  // Node process itself holds, less the headroom: what the 7-Zip plan may use.
  const WORKER_LIMIT_MB = 819;
  const NODE_RESIDENT_MB = 350;
  const HEADROOM_MB = 256;

  it('keeps every plan 7-Zip can be given on the default worker inside its limit', async () => {
    const available = WORKER_LIMIT_MB - NODE_RESIDENT_MB;
    for (const cores of [1, 2, 4, 8, 16]) {
      const choice = await chooseSevenZipLevel(
        policy({ available, cores, headroomMb: HEADROOM_MB, budgetMb: 600 }),
      );
      if (choice.kind !== 'LEVEL') throw new Error('refused');
      expect(choice.level.estimatedPeakMb + NODE_RESIDENT_MB).toBeLessThanOrEqual(
        WORKER_LIMIT_MB - HEADROOM_MB + NODE_RESIDENT_MB,
      );
      expect(choice.level.estimatedPeakMb).toBeLessThanOrEqual(600);
    }
  });

  it('never estimates below what was measured (docs/backup.md § Speed)', () => {
    // [mx, md, threads, measured peak RSS MiB] on 7-Zip 23.01, a 2.6 GB pg_dump.
    const measured: readonly (readonly [number, string, number, number])[] = [
      [5, '16m', 1, 199],
      [5, '16m', 2, 199],
      [5, '16m', 4, 485],
      [5, '16m', 8, 955],
      [5, '8m', 4, 248],
      [5, '4m', 4, 135],
    ];
    for (const [mx, md, threads, rss] of measured) {
      expect(estimateSevenZipPeakMb(mx, md, threads)).toBeGreaterThanOrEqual(rss);
    }
  });

  it('prefers the dictionary that keeps four cores busy over one core with a bigger one', async () => {
    const choice = await chooseSevenZipLevel(policy({ available: 230, cores: 4 }));
    expect(choice.kind === 'LEVEL' && choice.level.mmt).toBe(4);
    expect(SEVEN_ZIP_ROWS.some((row) => row.md === '4m')).toBe(true);
  });
});
