import { describe, expect, it } from 'vitest';
import {
  monitorBudgetReserveFor,
  USAGE_SYNC_BUDGET_RESERVE_PERCENT,
  usageSyncBudgetReserveFor,
} from '../../apps/api/src/container';

/**
 * Migration P1 (H5): the floor the scheduled usage sweep leaves in a tenant's bucket.
 *
 * Paid and interactive work spend at reserve 0, the monitor above its floor, and the
 * sweep above this one. The ordering is the rule: the sweep's floor is never below the
 * monitor's, so a migration-sized backlog of reads cannot starve the health checks.
 */
describe('usageSyncBudgetReserveFor', () => {
  it('is half the bucket at the default shape, above the monitor floor of 40', () => {
    expect(USAGE_SYNC_BUDGET_RESERVE_PERCENT).toBe(50);
    const monitor = monitorBudgetReserveFor(100, 40);
    expect(monitor).toBe(40);
    expect(usageSyncBudgetReserveFor(100, monitor)).toBe(50);
  });

  it('never sits below the monitor floor, whatever the monitor is configured to', () => {
    for (const capacity of [2, 3, 7, 10, 100, 1000]) {
      for (const percent of [0, 10, 40, 60, 90]) {
        const monitor = monitorBudgetReserveFor(capacity, percent);
        const sweep = usageSyncBudgetReserveFor(capacity, monitor);
        expect(sweep, `capacity ${capacity}, monitor ${percent}%`).toBeGreaterThanOrEqual(monitor);
        expect(sweep).toBeGreaterThanOrEqual(1);
      }
    }
    expect(usageSyncBudgetReserveFor(100, monitorBudgetReserveFor(100, 90))).toBe(90);
  });

  it('rounds UP and never to zero: a positive floor protects the last token', () => {
    expect(usageSyncBudgetReserveFor(3, 0)).toBe(2);
    expect(usageSyncBudgetReserveFor(1, 0)).toBe(1);
  });
});
