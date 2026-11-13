import { readFile } from 'node:fs/promises';
import { readCgroupAvailableMb } from './cgroup-limits.js';

/**
 * The compression levels the backup may use, and how one is chosen (Round 5B; speed: PR-2 of
 * the 2026-11 round).
 *
 * WHY A TABLE. 7-Zip at `-mx=9` with all cores was measured at about 2.4 GB resident on a
 * 4 GB / 2 vCPU host and was killed by the kernel part-way through the archive. Memory is
 * not a free choice made by the tool: LZMA2's encoder holds roughly twelve times its
 * dictionary per BLOCK thread, so the DICTIONARY (`-md`) and the THREAD count (`-mmt`) are
 * what bound it, and `-mx` only sets the effort. Every argument is stated explicitly, so the
 * peak is a property of the plan and not of whatever the tool decides on this host.
 *
 * WHY NOT `-mx=9`. On a 2.6 GB pg_dump (docs/backup.md § Speed) `-mx=9 -md=64m` ran at
 * 1.3 MiB/s on one core, 36 minutes for the dump; `-mx=5 -md=16m` is 3.5 times faster and
 * the archive is no bigger (database dumps are repetitive text, so a longer match search
 * finds nothing more). The rows below are the ones within ~1.3x of the old archive size; the
 * last-resort row is bigger (1.5x) and is used only when nothing else fits the memory.
 *
 * THE PLAN. A row fixes `-mx` and `-md`. The thread count is not a property of the row: it
 * is the cores the container may use (`cgroup-limits.ts`), reduced until the memory estimate
 * fits. LZMA2 with the binary-tree match finder (`-mx` 5 and up) runs `-mmt=N` as N/2 block
 * coders, each with a dictionary of its own and a match-finder thread beside it, which is
 * why one and two block threads cost the same memory per block and the memory follows
 * `floor(N/2)`; the hash-chain levels (`-mx` 4 and below) run N block coders.
 *
 *   peak MiB = blocks * (12.5 * dictMiB + 32) + 48          (-mx 5 and up)
 *   peak MiB = blocks * ( 9.5 * dictMiB + 16) + 16          (-mx 4 and below)
 *
 * (12.5x covers the measured 11.9-14.4x for 4-16 MiB dictionaries and 10.7x at 64 MiB; the
 * constants are the per-block and shared buffers.) It is checked against measurements in
 * `scripts/measure-seven-zip-memory.sh` and the table in docs/backup.md; when the script's
 * figure exceeds the formula, the formula is wrong and is raised, not the figure ignored.
 *
 * ORDER: within the normal tier, the plan with the highest estimated throughput wins and a
 * tie goes to the earlier (stronger) row; the last-resort tier is considered only when no
 * normal plan fits.
 */
export interface SevenZipRow {
  readonly name: string;
  /** `-mx`: effort. */
  readonly mx: number;
  /** `-md`: LZMA2 dictionary, the argument verbatim (`16m`). */
  readonly md: string;
  /** Measured MiB/s of dump for ONE block coder (docs/backup.md § Speed). */
  readonly speedMibS: number;
  /** Used only when no normal row fits the memory: its archive is ~1.5x bigger. */
  readonly lastResort: boolean;
}

/** A row with the thread count and memory this host and moment gave it. */
export interface SevenZipLevel {
  readonly name: string;
  readonly mx: number;
  readonly md: string;
  /** `-mmt`: compression threads. */
  readonly mmt: number;
  /** The formula's peak resident memory of the 7-Zip process, in MiB. */
  readonly estimatedPeakMb: number;
}

export const SEVEN_ZIP_ROWS: readonly SevenZipRow[] = [
  { name: 'balanced', mx: 5, md: '16m', speedMibS: 2.2, lastResort: false },
  { name: 'fast', mx: 5, md: '4m', speedMibS: 3.4, lastResort: false },
  { name: 'compact', mx: 5, md: '1m', speedMibS: 3.4, lastResort: false },
  { name: 'minimal', mx: 3, md: '4m', speedMibS: 13.6, lastResort: true },
];

/** `-md` argument (`16m`, `1g`) in MiB. */
export function dictionaryMb(md: string): number {
  const match = /^(\d+)([kmg])$/i.exec(md);
  if (match === null) throw new Error(`unsupported 7-Zip dictionary ${md}`);
  const n = Number(match[1]);
  const unit = (match[2] ?? 'm').toLowerCase();
  return unit === 'k' ? n / 1024 : unit === 'g' ? n * 1024 : n;
}

/** Block coders (each with its own dictionary) that `-mmt=threads` runs. */
export function sevenZipBlocks(mx: number, threads: number): number {
  return mx >= 5 ? Math.max(1, Math.floor(threads / 2)) : Math.max(1, threads);
}

/** Estimated peak resident memory, MiB: the formula in this file's header. Rounds up. */
export function estimateSevenZipPeakMb(mx: number, md: string, threads: number): number {
  const blocks = sevenZipBlocks(mx, threads);
  const dict = dictionaryMb(md);
  // Hash-chain levels hold about 9.5 dictionaries per block coder, binary-tree ones 12.5.
  return Math.ceil(mx >= 5 ? blocks * (12.5 * dict + 32) + 48 : blocks * (9.5 * dict + 16) + 16);
}

/** Relative throughput of a plan; a second thread (the match finder) is worth about 1.3x. */
function throughput(row: SevenZipRow, threads: number): number {
  return row.speedMibS * sevenZipBlocks(row.mx, threads) * (threads > 1 ? 1.3 : 1);
}

/** The budget a backup's 7-Zip may use unless `BACKUP_SEVEN_ZIP_MEMORY_MB` says otherwise. */
export const DEFAULT_SEVEN_ZIP_MEMORY_MB = 600;
/** Memory the rest of the host keeps free while 7-Zip runs. */
export const DEFAULT_SEVEN_ZIP_HEADROOM_MB = 256;

/** MemAvailable in MiB, or null where it cannot be read (not Linux, a locked-down /proc). */
export type AvailableMemoryReader = () => Promise<number | null>;

/**
 * The default reader: the LESS of the host's `MemAvailable` (`/proc/meminfo`) and what the
 * container's own cgroup limit still allows. `/proc/meminfo` describes the host, so on an 8 GiB
 * server a role limited to 819 MiB would otherwise be told it has gigabytes free and be killed
 * by its limit instead of refused or given a lighter level.
 */
export const readMemAvailableMb: AvailableMemoryReader = async () => {
  let host: number | null = null;
  try {
    host = parseMemAvailableMb(await readFile('/proc/meminfo', 'utf8'));
  } catch {
    host = null;
  }
  const cgroup = await readCgroupAvailableMb();
  if (host === null) return cgroup;
  return cgroup === null ? host : Math.min(host, cgroup);
};

/** `MemAvailable:   1234567 kB` → MiB, or null when the line is absent. */
export function parseMemAvailableMb(meminfo: string): number | null {
  const match = /^MemAvailable:\s+(\d+)\s*kB\s*$/m.exec(meminfo);
  if (match === null) return null;
  return Math.floor(Number(match[1]) / 1024);
}

export interface SevenZipMemoryPolicy {
  /** The most 7-Zip may use. */
  readonly budgetMb: number;
  /** Kept free for everything else. */
  readonly headroomMb: number;
  /** Operator ceilings from `BACKUP_SEVEN_ZIP_LEVEL` / `_THREADS`. */
  readonly maxMx: number;
  readonly maxThreads: number;
  /** The cores the container may use (`readAllowedCores`); absent: one. */
  readonly cores?: number;
  readonly readAvailableMb: AvailableMemoryReader;
}

export type LevelChoice =
  | { readonly kind: 'LEVEL'; readonly level: SevenZipLevel; readonly allowanceMb: number }
  | {
      readonly kind: 'REFUSED';
      readonly neededMb: number;
      readonly allowanceMb: number;
      readonly availableMb: number | null;
    };

/**
 * The fastest plan whose estimated peak fits `min(budget, available - headroom)`.
 *
 * When the host's free memory cannot be read, only the budget bounds the choice: refusing to
 * back up because /proc is unreadable would be the worse failure. When even the lightest
 * plan does not fit, the answer is a refusal — the caller must not start 7-Zip.
 */
export async function chooseSevenZipLevel(
  policy: SevenZipMemoryPolicy,
  rows: readonly SevenZipRow[] = SEVEN_ZIP_ROWS,
): Promise<LevelChoice> {
  const availableMb = await policy.readAvailableMb();
  const fromHost = availableMb === null ? Infinity : availableMb - policy.headroomMb;
  const allowanceMb = Math.floor(Math.min(policy.budgetMb, fromHost));
  const maxThreads = Math.max(1, Math.min(Math.floor(policy.cores ?? 1), policy.maxThreads));
  let best: { level: SevenZipLevel; score: number; lastResort: boolean } | null = null;
  let lightest = Infinity;
  for (const row of rows) {
    // `maxMx` lowers the effort of a row, never removes it (a ceiling of 1 must still back up).
    const mx = Math.min(row.mx, policy.maxMx);
    const effective = { ...row, mx };
    for (let threads = 1; threads <= maxThreads; threads += 1) {
      const peak = estimateSevenZipPeakMb(mx, row.md, threads);
      if (threads === 1) lightest = Math.min(lightest, peak);
      if (peak > allowanceMb) break;
      const score = throughput(effective, threads);
      const better =
        best === null ||
        (best.lastResort && !row.lastResort) ||
        (best.lastResort === row.lastResort &&
          (best.level.name === row.name ? score >= best.score : score > best.score));
      if (better) {
        best = {
          level: { name: row.name, mx, md: row.md, mmt: threads, estimatedPeakMb: peak },
          score,
          lastResort: row.lastResort,
        };
      }
    }
  }
  if (best !== null) return { kind: 'LEVEL', level: best.level, allowanceMb };
  return {
    kind: 'REFUSED',
    neededMb: Number.isFinite(lightest) ? lightest : 0,
    allowanceMb,
    availableMb,
  };
}
