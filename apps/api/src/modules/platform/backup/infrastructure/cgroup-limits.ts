import { readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';

/**
 * What the container is ALLOWED to use, as the kernel states it (cgroup v2 or v1).
 *
 * WHY. `os.cpus().length` and `/proc/meminfo` describe the HOST. A container capped at two
 * cores on a 4-core host, or at 819 MiB on an 8 GiB host, still sees four cores and 8 GiB, and
 * a tool sized from those numbers is either slower than it could be (this file's CPU half
 * replaces a forced single thread) or killed by the memory limit (its memory half). Both
 * readers fail OPEN to the host's figure: an unreadable cgroup tree must not stop a backup.
 */

export type TextReader = (path: string) => Promise<string | null>;

const defaultReader: TextReader = async (path) => {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
};

/** cgroup v2 `cpu.max`: `max 100000` (no limit) or `150000 100000` (1.5 cores). Cores, or null. */
export function parseCgroupV2CpuMax(text: string): number | null {
  const [quota, period] = text.trim().split(/\s+/);
  if (quota === undefined || period === undefined || quota === 'max') return null;
  return coresOf(Number(quota), Number(period));
}

/** cgroup v1 `cpu.cfs_quota_us` (-1: no limit) and `cpu.cfs_period_us`. Cores, or null. */
export function parseCgroupV1Cpu(quotaText: string, periodText: string): number | null {
  return coresOf(Number(quotaText.trim()), Number(periodText.trim()));
}

function coresOf(quota: number, period: number): number | null {
  if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) return null;
  return quota / period;
}

/**
 * The whole cores 7-Zip may use: the cgroup quota floored, at least 1, never more than the
 * cores the host has. No quota: the host's cores. (Floored because a 1.5-core limit run with
 * two busy threads is throttled by the kernel in bursts that stall the process.)
 */
export function allowedCores(quotaCores: number | null, hostCores: number): number {
  const host = Math.max(1, Math.floor(hostCores));
  if (quotaCores === null) return host;
  return Math.min(host, Math.max(1, Math.floor(quotaCores)));
}

export async function readAllowedCores(
  read: TextReader = defaultReader,
  hostCores: number = availableParallelism(),
): Promise<number> {
  const v2 = await read('/sys/fs/cgroup/cpu.max');
  if (v2 !== null) return allowedCores(parseCgroupV2CpuMax(v2), hostCores);
  const quota = await read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
  const period = await read('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
  if (quota !== null && period !== null) {
    return allowedCores(parseCgroupV1Cpu(quota, period), hostCores);
  }
  return allowedCores(null, hostCores);
}

/** A byte figure from a cgroup file: `max` and the v1 "no limit" sentinel are null. */
export function parseCgroupBytes(text: string): number | null {
  const value = text.trim();
  if (value === 'max') return null;
  const bytes = Number(value);
  // v1 reports an unlimited cgroup as a page-rounded 2^63-1.
  if (!Number.isFinite(bytes) || bytes < 0 || bytes >= 2 ** 60) return null;
  return bytes;
}

/** Reclaimable page cache from a `memory.stat` (`inactive_file` v2, `total_inactive_file` v1). */
export function parseInactiveFileBytes(stat: string): number {
  const match = /^(?:total_)?inactive_file\s+(\d+)\s*$/m.exec(stat);
  return match === null ? 0 : Number(match[1]);
}

/**
 * Memory the container may still allocate, MiB: its limit less what it holds that is NOT
 * reclaimable (the dump just written sits in the page cache and is counted in the usage; the
 * kernel drops it before it kills anything, as `docker stats` also assumes). Null when there
 * is no limit or it cannot be read.
 */
export async function readCgroupAvailableMb(
  read: TextReader = defaultReader,
): Promise<number | null> {
  const sets: readonly (readonly [string, string, string])[] = [
    ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.stat'],
    [
      '/sys/fs/cgroup/memory/memory.limit_in_bytes',
      '/sys/fs/cgroup/memory/memory.usage_in_bytes',
      '/sys/fs/cgroup/memory/memory.stat',
    ],
  ];
  for (const [limitPath, usagePath, statPath] of sets) {
    const limitText = await read(limitPath);
    if (limitText === null) continue;
    const limit = parseCgroupBytes(limitText);
    if (limit === null) return null;
    const usageText = await read(usagePath);
    const usage = usageText === null ? 0 : (parseCgroupBytes(usageText) ?? 0);
    const statText = await read(statPath);
    const reclaimable = statText === null ? 0 : parseInactiveFileBytes(statText);
    return Math.max(0, Math.floor((limit - Math.max(0, usage - reclaimable)) / (1024 * 1024)));
  }
  return null;
}
