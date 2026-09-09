import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every loop that can report its own freshness must be consulted by the
 * worker's health check.
 *
 * The aggregation itself is a `filter` and needs no test. The risk that is
 * real, and that no behavioural test can catch, is a loop being OMITTED — added
 * to the container, given an `isFresh`, started by the worker, and never named
 * in the check. That is exactly the state the codebase was in for three loops:
 * the relay, the two sweepers and the dispatcher each had a running timer and
 * no representation in any health signal, and nothing anywhere said so.
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

  /**
   * Container members whose class declares `isFresh`.
   *
   * Found from the container's own interface rather than from a hand-kept list,
   * so a loop added tomorrow is in scope tomorrow.
   */
  const freshnessBearing = (): readonly string[] => {
    const members = [...container.matchAll(/^ {2}readonly (\w+):\s*([\w<>[\]]+);/gm)].map(
      (match) => ({ name: match[1] ?? '', type: match[2] ?? '' }),
    );
    const classesWithIsFresh = new Set<string>();
    for (const file of [
      'apps/api/src/modules/platform/eventing/infrastructure/outbox-relay.ts',
      'apps/api/src/modules/platform/identity/application/retention-sweeper.ts',
      'apps/api/src/modules/control/notifications/application/notification-dispatcher.ts',
      'apps/api/src/modules/platform/backup/application/backup-scheduler.ts',
      'apps/api/src/modules/platform/panels/application/panel-monitor.service.ts',
    ]) {
      const source = readFileSync(join(root, file), 'utf8');
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
    expect(loops.length).toBeGreaterThanOrEqual(4);
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
