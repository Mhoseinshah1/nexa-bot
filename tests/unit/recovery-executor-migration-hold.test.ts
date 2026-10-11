import { describe, expect, it } from 'vitest';
import {
  RecoveryExecutor,
  type RecoveryExecutorDeps,
} from '../../apps/api/src/modules/platform/recovery/application/recovery-executor';

/**
 * Phase 7: a confirmed recovery is not claimed while a Mirza restore is approved or applying.
 * The two confirmations are separate requests and can both commit; the executor's claim is
 * where the import holding the installation wins (the recovery's confirmation then expires).
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
  it('does not claim a confirmed recovery while an import is approved or applying', async () => {
    const held = executor(true);
    await held.executor.tick();
    expect(held.calls.claimConfirmed).toBe(0);
  });

  it('claims as before when no import is active', async () => {
    const free = executor(false);
    await free.executor.tick();
    expect(free.calls.claimConfirmed).toBe(1);
  });
});
