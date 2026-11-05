/**
 * Phase 6A PR-2: what the host says is available (`/proc/meminfo` MemAvailable) and what
 * this container's cgroup still allows (`memory.max - memory.current`, cgroup v2;
 * `limit_in_bytes - usage_in_bytes`, v1) — two separate readings, never one minimum.
 * Pure parsing; reading the files is the infrastructure's.
 */

/** MemAvailable in bytes, or null when the text has none. */
export function memAvailableBytes(meminfo: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo);
  return match === null ? null : Number(match[1]) * 1024;
}

/** MemTotal in bytes, or null. */
export function memTotalBytes(meminfo: string): number | null {
  const match = /^MemTotal:\s+(\d+)\s*kB/m.exec(meminfo);
  return match === null ? null : Number(match[1]) * 1024;
}

/**
 * What a cgroup still allows, or null when it sets no limit (`max`, an absurd v1 sentinel)
 * or the values cannot be read.
 */
export function cgroupHeadroomBytes(
  limitText: string | null,
  usageText: string | null,
): number | null {
  if (limitText === null || usageText === null) return null;
  const limit = limitText.trim();
  const usage = Number(usageText.trim());
  if (limit === 'max' || !/^\d+$/.test(limit) || !Number.isFinite(usage)) return null;
  const max = Number(limit);
  // cgroup v1 reports "no limit" as a page-rounded 2^63: anything past a petabyte is that.
  if (max >= 2 ** 50) return null;
  return Math.max(0, max - usage);
}

/** Percent of a volume used, from statfs-style block counts; null for an empty volume. */
export function diskUsedPercent(totalBytes: number, availableBytes: number): number | null {
  if (!(totalBytes > 0)) return null;
  return ((totalBytes - availableBytes) / totalBytes) * 100;
}
