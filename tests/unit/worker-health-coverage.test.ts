import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every loop that can report its own freshness must be consulted by the
 * worker's health check.
 *
 * The aggregation is `stalledLoops`, and it is tested in `loop-health.test.ts`.
 * An earlier version of this docblock said it "is a `filter` and needs no test",
 * which is recorded in `docs/hardening-falsification.md` as the false comment that
 * let the filter be replaced with `[]` — a worker reporting healthy with every
 * loop dead — while the whole suite stayed green. The sentence survived into this
 * file after the branch that refuted it, which the review caught.
 *
 * What THIS file covers is the other risk, and no behavioural test can catch it: a
 * loop being OMITTED — added to the container, given an `isFresh`, started by the
 * worker, and never named in the check. That is exactly the state the codebase was
 * in for three loops: the relay, the two sweepers and the dispatcher each had a
 * running timer and no representation in any health signal, and nothing anywhere
 * said so.
 *
 * "Remember to add it" is not a mechanism. This reads the SOURCE, the same way
 * `secret-registry.test.ts` reads the schema rather than trusting an import,
 * because the property is about what the file says and not about what an object
 * graph happens to contain at runtime.
 */
describe('worker health coverage', () => {
  const root = join(__dirname, '../..');
  const container = readFileSync(join(root, 'apps/api/src/container.ts'), 'utf8');
  const worker = readFileSync(join(root, 'apps/api/src/main.worker.ts'), 'utf8');

  /** Every `.ts` file under a directory, so the scan below keeps no list. */
  const sourceFiles = (dir: string): readonly string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && path.endsWith('.ts') ? [path] : [];
    });

  /**
   * Container members whose class declares `isFresh`.
   *
   * BOTH halves are derived. The member scan reads the container's own interface,
   * and the file scan now walks `apps/api/src` — it used to be a hand-kept list of
   * five paths, so a freshness-bearing loop added in a NEW file contributed no class
   * name, its container member was filtered out, and "names every freshness-bearing
   * loop" passed vacuously for exactly the loop that needed covering. That is the
   * failure `require_dir` in `check-boundaries.sh` exists to refuse, and the review
   * of this branch found this file committing it.
   */
  const freshnessBearing = (): readonly string[] => {
    const members = [...container.matchAll(/^ {2}readonly (\w+):\s*([\w<>[\]]+);/gm)].map(
      (match) => ({ name: match[1] ?? '', type: match[2] ?? '' }),
    );
    const classesWithIsFresh = new Set<string>();
    for (const file of sourceFiles(join(root, 'apps/api/src'))) {
      const source = readFileSync(file, 'utf8');
      const declared = [...source.matchAll(/^export class (\w+)/gm)].map((m) => m[1] ?? '');
      if (/^\s{2}(?:iterationIsFresh|isFresh)\(/m.test(source)) {
        for (const name of declared) classesWithIsFresh.add(name);
      }
    }
    return members.filter((m) => classesWithIsFresh.has(m.type)).map((m) => m.name);
  };

  it('finds the loops it is supposed to be checking', () => {
    // A guard on the guard. If the container's shape changes so that this
    // scan matches nothing, every assertion below would pass vacuously — which
    // is the failure mode `check-boundaries.sh` documents at length.
    const loops = freshnessBearing();
    expect(loops.length).toBeGreaterThanOrEqual(5);
    expect(loops).toContain('relay');
    expect(loops).toContain('notificationDispatcher');
  });

  it('names every freshness-bearing loop in the worker health check', () => {
    const missing = freshnessBearing().filter(
      (name) => !new RegExp(`container\\.${name}\\.isFresh\\(`).test(worker),
    );
    // The panel monitor is deliberately absent: it runs in the `monitor` role,
    // and `main.monitor.ts` consults it there. Anything else missing here is a
    // loop the worker starts and cannot tell has stopped.
    expect(missing.filter((name) => name !== 'panelMonitor')).toEqual([]);
  });

  it('checks the monitor loop in the monitor role', () => {
    const monitor = readFileSync(join(root, 'apps/api/src/main.monitor.ts'), 'utf8');
    expect(monitor).toMatch(/panelMonitor\.iterationIsFresh\(/);
  });
});
