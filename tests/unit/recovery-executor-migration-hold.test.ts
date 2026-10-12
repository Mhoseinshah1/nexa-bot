import { describe, expect, it } from 'vitest';
import {
  RecoveryExecutor,
  type RecoveryExecutorDeps,
} from '../../apps/api/src/modules/platform/recovery/application/recovery-executor';

/**
 * Phase 7 (review M1): a confirmed recovery is ALWAYS claimed, even while a Mirza restore is
 * approved or applying. Left unclaimed, an unexpired RESTORE_REQUESTED waited for ever — its
 * expiry is decided only at the claim — and held the installation against every later
 * confirmation. It is claimed and FAILED at once instead (`recovery.confirmation_invalid`,
 * before anything destructive): `recovery-executor.test.ts` proves that against PostgreSQL.
 */
function executor(importActive: boolean) {
  const calls = { claimConfirmed: 0 };
  const deps = {
    requests: {
      reclaimStale: async () => [],
      claimOwn: async () => null,
      claimConfirmed: async () => {
        calls.claimConfirmed += 1;
        return null;
      },
    },
    journal: { pending: async () => [] },
    legacyMigrationActive: async () => importActive,
    clock: { now: () => new Date('2026-10-11T10:00:00Z') },
    leaseOwner: 'recovery:test',
    tickIntervalMs: 60_000,
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as RecoveryExecutorDeps;
  return { executor: new RecoveryExecutor(deps), calls };
}

describe('RecoveryExecutor and a Mirza restore in progress', () => {
  it('claims a confirmed recovery even while an import is approved or applying (no starvation)', async () => {
    const held = executor(true);
    await held.executor.tick();
    expect(held.calls.claimConfirmed).toBe(1);
  });

  it('claims as before when no import is active', async () => {
    const free = executor(false);
    await free.executor.tick();
    expect(free.calls.claimConfirmed).toBe(1);
  });
});
