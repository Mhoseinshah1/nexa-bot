import { describe, expect, it } from 'vitest';
import { awaitsReadinessAfterCutover } from '../../apps/api/src/modules/platform/recovery/application/recovery-executor';
import type { RecoveryRequestRow } from '../../apps/api/src/modules/platform/recovery/application/ports';

/**
 * Which re-claimed row a restarted executor may FINISH rather than fail.
 *
 * Only a row that completed its cutover and was waiting on readiness — and only
 * when all four facts the re-assert writes together are present. Anything else
 * goes through the fail-safe path. The end-to-end behaviour, with real renames,
 * is `tests/integration/recovery-failure-drills.test.ts`.
 */
const NOW = new Date('2026-10-06T12:00:00.000Z');

function row(overrides: Partial<RecoveryRequestRow>): RecoveryRequestRow {
  return {
    state: 'RESTARTING',
    cutoverAt: NOW,
    displacedDatabase: 'nexa_pre_restore_x',
    candidateDatabase: 'nexa_candidate_x',
    ...overrides,
  } as RecoveryRequestRow;
}

describe('a re-claimed recovery after a restart', () => {
  it('is finished only when it cut over and was waiting on readiness', () => {
    expect(awaitsReadinessAfterCutover(row({}))).toBe(true);
  });

  it('is never finished without every cutover fact the re-assert writes', () => {
    expect(awaitsReadinessAfterCutover(row({ cutoverAt: null }))).toBe(false);
    expect(awaitsReadinessAfterCutover(row({ displacedDatabase: null }))).toBe(false);
    expect(awaitsReadinessAfterCutover(row({ candidateDatabase: null }))).toBe(false);
  });

  it.each([
    'RESTORE_REQUESTED',
    'PRE_RESTORE_BACKUP',
    'QUIESCING',
    'RESTORING',
    'VALIDATING',
    'CUTTING_OVER',
  ] as const)('is never finished from %s, even with cutover facts on it', (state) => {
    expect(awaitsReadinessAfterCutover(row({ state }))).toBe(false);
  });
});
