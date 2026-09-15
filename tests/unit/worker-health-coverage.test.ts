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

  /**
   * Every entrypoint, read from disk rather than listed.
   *
   * The rule is "the role that STARTS a loop checks it", not "the worker checks
   * everything": the panel monitor runs in the `monitor` role and the recovery
   * executor in the `recovery` role, and each is consulted by its own `main`.
   *
   * Derived, because the previous version of this file carried the exception as a
   * hardcoded `name !== 'panelMonitor'` — so a second role's loop had to be added
   * to that list by hand, and a loop nobody remembered to exclude failed this
   * test while a loop nobody remembered to CHECK would have been excluded and
   * passed. Reading the files removes the list, which is the same correction the
   * file scan above already records having needed once.
   */
  const entrypoints = (): ReadonlyMap<string, string> =>
    new Map(
      readdirSync(join(root, 'apps/api/src'), { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^main(\.\w+)?\.ts$/.test(entry.name))
        .map((entry) => [entry.name, readFileSync(join(root, 'apps/api/src', entry.name), 'utf8')]),
    );

  it('finds every entrypoint, so the scan below cannot pass vacuously', () => {
    const found = [...entrypoints().keys()].sort();
    expect(found).toEqual([
      'main.monitor.ts',
      'main.provisioner.ts',
      'main.recovery.ts',
      'main.ts',
      'main.worker.ts',
    ]);
  });

  it('has the role that starts each loop check that loop', () => {
    const files = entrypoints();
    const unchecked = freshnessBearing().filter((name) => {
      const checked = new RegExp(`container\\.${name}\\.(?:isFresh|iterationIsFresh)\\(`);
      for (const [file, source] of files) {
        // Only the role that STARTS it is obliged to check it. A role that
        // neither starts nor checks a loop is correct; a role that starts one and
        // cannot tell it has stopped is the defect.
        if (!new RegExp(`container\\.${name}\\.start\\(`).test(source)) continue;
        if (!checked.test(source)) return true;
        void file;
      }
      return false;
    });
    expect(unchecked).toEqual([]);
  });

  it('leaves no freshness-bearing loop unstarted by every role', () => {
    // The other half, and the one the rule above cannot see: a loop with an
    // `isFresh` that NO entrypoint starts is either dead code or a loop somebody
    // forgot to wire, and both are worth failing on.
    const files = [...entrypoints().values()];
    const orphans = freshnessBearing().filter(
      (name) => !files.some((source) => new RegExp(`container\\.${name}\\.start\\(`).test(source)),
    );
    expect(orphans).toEqual([]);
  });

  it('names every worker-started loop in the worker health check', () => {
    // The original assertion, kept concrete: these six are the worker's, and
    // naming them here means a future refactor that moved one out of the worker
    // has to say so rather than quietly satisfying the derived rule above.
    for (const name of [
      'relay',
      'throttleSweeper',
      'sessionSweeper',
      'backupRunSweeper',
      'recoveryRequestSweeper',
      'notificationDispatcher',
      'backupScheduler',
    ]) {
      expect(worker, `${name} is not consulted by the worker health check`).toMatch(
        new RegExp(`container\\.${name}\\.isFresh\\(`),
      );
    }
  });

  it('checks the monitor loop in the monitor role', () => {
    const monitor = readFileSync(join(root, 'apps/api/src/main.monitor.ts'), 'utf8');
    expect(monitor).toMatch(/panelMonitor\.iterationIsFresh\(/);
  });

  it('checks the recovery executor in the recovery role', () => {
    const recovery = readFileSync(join(root, 'apps/api/src/main.recovery.ts'), 'utf8');
    expect(recovery).toMatch(/recoveryExecutor\.isFresh\(/);
  });
});
