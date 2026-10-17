/**
 * `--shard=i/n` by measured duration rather than by file count.
 *
 * Vitest's own sharding sorts the files by a hash of their path and gives every
 * shard the same NUMBER of files. The integration files range from under a
 * second to three and a half minutes, so four equal counts finished between
 * 16 and 33 minutes on the same commit, and the slowest shard was the whole
 * workflow's critical path.
 *
 * This keeps vitest's contract — every file runs in exactly one shard, and
 * every shard computes the same partition from the same file list — and changes
 * only which shard a file lands in: longest first, each into the shard with the
 * least work so far (`partitionByWeight`). The weights are the committed
 * measurements in `integration-timings.json`. A file that is not listed there
 * (a new one) is weighted at the median, so a stale table makes the shards less
 * even and never makes a file run twice or not at all.
 *
 * Nothing else changes: the order inside a shard is vitest's own `sort`, and a
 * run without `--shard` never calls `shard()`.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

/** Per-file cost every file pays before its tests: the `setup` figure, measured at about 2 s. */
export const PER_FILE_SETUP_SECONDS = 2;

/**
 * Split `paths` into `count` groups whose summed weights are as even as a
 * greedy longest-first assignment makes them. Deterministic: equal weights are
 * ordered by path, and equal loads go to the lowest shard. Pure, so the unit
 * test can check it partitions.
 */
export function partitionByWeight(
  paths: readonly string[],
  weights: Readonly<Record<string, number>>,
  count: number,
): string[][] {
  if (!Number.isInteger(count) || count < 1) throw new Error(`invalid shard count ${count}`);
  const known = Object.values(weights)
    .filter((w) => Number.isFinite(w) && w >= 0)
    .sort((a, b) => a - b);
  const fallback = known.length > 0 ? known[Math.floor(known.length / 2)]! : 1;
  const weightOf = (path: string) => {
    const w = weights[path];
    return (
      (typeof w === 'number' && Number.isFinite(w) && w >= 0 ? w : fallback) +
      PER_FILE_SETUP_SECONDS
    );
  };
  const ordered = [...new Set(paths)].sort(
    (a, b) => weightOf(b) - weightOf(a) || (a < b ? -1 : a > b ? 1 : 0),
  );
  const shards: string[][] = Array.from({ length: count }, () => []);
  const load: number[] = Array.from({ length: count }, () => 0);
  for (const path of ordered) {
    let target = 0;
    for (let i = 1; i < count; i += 1) if (load[i]! < load[target]!) target = i;
    shards[target]!.push(path);
    load[target]! += weightOf(path);
  }
  return shards;
}

/** The committed measurements, keyed by repository-relative path. */
export function readIntegrationTimings(root: string): Record<string, number> {
  const raw = JSON.parse(
    readFileSync(join(root, 'tests/support/integration-timings.json'), 'utf8'),
  ) as { files?: Record<string, number> };
  return raw.files ?? {};
}

export default class TimedSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return files;
    const pathOf = (spec: TestSpecification) => relative(root, spec.moduleId).split('\\').join('/');
    const groups = partitionByWeight(files.map(pathOf), readIntegrationTimings(root), shard.count);
    const mine = new Set(groups[shard.index - 1]);
    return files.filter((spec) => mine.has(pathOf(spec)));
  }
}
