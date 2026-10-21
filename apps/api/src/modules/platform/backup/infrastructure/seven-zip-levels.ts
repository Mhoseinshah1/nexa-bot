import { readFile } from 'node:fs/promises';

/**
 * The compression levels the backup may use, and how one is chosen (Round 5B).
 *
 * WHY A TABLE. 7-Zip at `-mx=9` with all cores was measured at about 2.4 GB resident on a
 * 4 GB / 2 vCPU host and was killed by the kernel part-way through the archive. Memory is
 * not a free choice made by the tool: LZMA2's encoder holds roughly eleven times its
 * dictionary per thread, so the DICTIONARY (`-md`) and the THREAD count (`-mmt`) are what
 * bound it, and `-mx` only sets the effort. The levels below fix all three explicitly, so
 * the peak is a property of the level and not of whatever the tool decides on this host.
 *
 * `estimatedPeakMb` is MEASURED, not computed: `scripts/measure-seven-zip-memory.sh` runs
 * each row over a synthetic dump and reports the peak resident set (figures below). Update
 * the script's output first, this table second.
 *
 * ORDER: strongest compression first. Selection takes the first row that fits.
 */
export interface SevenZipLevel {
  readonly name: string;
  /** `-mx`: effort. */
  readonly mx: number;
  /** `-md`: LZMA2 dictionary, the argument verbatim (`64m`). */
  readonly md: string;
  /** `-mmt`: compression threads. */
  readonly mmt: number;
  /** Measured peak resident memory of the 7-Zip process, in MiB. */
  readonly estimatedPeakMb: number;
}

export const SEVEN_ZIP_LEVELS: readonly SevenZipLevel[] = [
  // Measured 2026-10-21, 7-Zip 23.01, peak RSS over a synthetic dump (scripts/measure-seven-zip-memory.sh),
  // rounded UP to the next 5 MiB: 687, 680, 376, 192 and 38 MiB. With -mmt=2 LZMA2 runs the match
  // finder and the coder on two threads over ONE dictionary, so two threads cost the same
  // memory as one; it is only from -mmt=3 that each block thread brings a dictionary of its
  // own, which is how the unbounded default reached 2.4 GB on four cores.
  { name: 'max', mx: 9, md: '64m', mmt: 2, estimatedPeakMb: 690 },
  { name: 'high', mx: 9, md: '64m', mmt: 1, estimatedPeakMb: 685 },
  { name: 'balanced', mx: 7, md: '32m', mmt: 1, estimatedPeakMb: 380 },
  { name: 'light', mx: 5, md: '16m', mmt: 1, estimatedPeakMb: 195 },
  { name: 'minimal', mx: 3, md: '4m', mmt: 1, estimatedPeakMb: 40 },
];

/** The budget a backup's 7-Zip may use unless `BACKUP_SEVEN_ZIP_MEMORY_MB` says otherwise. */
export const DEFAULT_SEVEN_ZIP_MEMORY_MB = 600;
/** Memory the rest of the host keeps free while 7-Zip runs. */
export const DEFAULT_SEVEN_ZIP_HEADROOM_MB = 256;

/** MemAvailable in MiB, or null where it cannot be read (not Linux, a locked-down /proc). */
export type AvailableMemoryReader = () => Promise<number | null>;

/** The default reader: `MemAvailable` from `/proc/meminfo`. */
export const readMemAvailableMb: AvailableMemoryReader = async () => {
  try {
    return parseMemAvailableMb(await readFile('/proc/meminfo', 'utf8'));
  } catch {
    return null;
  }
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
 * The strongest level whose measured peak fits `min(budget, available - headroom)`.
 *
 * When the host's free memory cannot be read, only the budget bounds the choice: refusing to
 * back up because /proc is unreadable would be the worse failure. When even the lightest
 * level does not fit, the answer is a refusal — the caller must not start 7-Zip.
 */
export async function chooseSevenZipLevel(
  policy: SevenZipMemoryPolicy,
  levels: readonly SevenZipLevel[] = SEVEN_ZIP_LEVELS,
): Promise<LevelChoice> {
  const availableMb = await policy.readAvailableMb();
  const fromHost = availableMb === null ? Infinity : availableMb - policy.headroomMb;
  const allowanceMb = Math.floor(Math.min(policy.budgetMb, fromHost));
  // `maxMx` lowers the effort of a row, never removes it (a ceiling of 1 must still back up);
  // `maxThreads` removes the rows that need more threads than the operator allowed.
  const candidates = levels
    .filter((level) => level.mmt <= policy.maxThreads)
    .map((level) => (level.mx > policy.maxMx ? { ...level, mx: policy.maxMx } : level));
  const fits = candidates.find((level) => level.estimatedPeakMb <= allowanceMb);
  if (fits !== undefined) return { kind: 'LEVEL', level: fits, allowanceMb };
  const lightest = candidates.reduce<SevenZipLevel | null>(
    (best, level) => (best === null || level.estimatedPeakMb < best.estimatedPeakMb ? level : best),
    null,
  );
  return {
    kind: 'REFUSED',
    neededMb: lightest?.estimatedPeakMb ?? 0,
    allowanceMb,
    availableMb,
  };
}
