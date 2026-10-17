import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PER_FILE_SETUP_SECONDS,
  partitionByWeight,
  readIntegrationTimings,
} from '../support/timed-sequencer.mjs';

/**
 * The integration matrix's sharding. The one property that matters is the one
 * vitest's own sharding has: every file runs in exactly one shard, whatever the
 * timing table says. Balance is the point of the change, and is checked second.
 */
const ROOT = join(__dirname, '../..');
const files = readdirSync(join(ROOT, 'tests/integration'), { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => `tests/integration/${f.split('\\').join('/')}`)
  .sort();
const timings = readIntegrationTimings(ROOT);

describe('partitionByWeight', () => {
  it('puts every integration file in exactly one shard, for any shard count', () => {
    expect(files.length).toBeGreaterThan(100);
    for (let count = 1; count <= 16; count += 1) {
      const shards = partitionByWeight(files, timings, count);
      expect(shards).toHaveLength(count);
      const all = shards.flat();
      expect(all.length, `count ${count}: a file runs twice`).toBe(new Set(all).size);
      expect([...all].sort(), `count ${count}: a file never runs`).toEqual(files);
    }
  });

  it('is the same partition on every runner: input order does not matter', () => {
    const shuffled = [...files].reverse();
    expect(partitionByWeight(shuffled, timings, 8)).toEqual(partitionByWeight(files, timings, 8));
  });

  it('still runs a file the table does not know, weighted at the median', () => {
    const unknown = 'tests/integration/not-yet-measured.test.ts';
    const shards = partitionByWeight([...files, unknown], timings, 8);
    expect(shards.flat().filter((f) => f === unknown)).toHaveLength(1);
    // With no table at all every file still runs once.
    const blind = partitionByWeight(files, {}, 8).flat();
    expect([...blind].sort()).toEqual(files);
  });

  it('balances the committed table far better than equal file counts', () => {
    const weight = (f: string) => (timings[f] ?? 0) + PER_FILE_SETUP_SECONDS;
    const loads = partitionByWeight(files, timings, 8).map((s) =>
      s.reduce((sum, f) => sum + weight(f), 0),
    );
    const total = files.reduce((sum, f) => sum + weight(f), 0);
    // The longest file is far below a shard's share, so greedy longest-first
    // lands every shard within a few percent of total / 8.
    expect(Math.max(...loads)).toBeLessThan((total / 8) * 1.05);
    expect(Math.min(...loads)).toBeGreaterThan((total / 8) * 0.95);
  });

  it('refuses a shard count that is not a positive integer', () => {
    expect(() => partitionByWeight(files, timings, 0)).toThrow();
    expect(() => partitionByWeight(files, timings, 2.5)).toThrow();
  });
});
