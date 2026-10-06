import { describe, expect, it } from 'vitest';
import {
  awaitsReadinessAfterCutover,
  RecoveryExecutor,
  type RecoveryExecutorDeps,
} from '../../apps/api/src/modules/platform/recovery/application/recovery-executor';
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

/**
 * The resume path itself, against a fake repository that applies the same
 * lease and state guards the Drizzle repository's `transition` does.
 */
describe('resuming a post-cutover recovery after a restart', () => {
  const OWNER = 'recovery:this-host';

  function world(readiness: readonly (boolean | 'throw')[]) {
    const state = {
      row: row({
        id: '0192f000-0000-7000-8000-00000000r001',
        leaseOwner: OWNER,
      }),
      readinessCalls: 0,
      sleeps: [] as number[],
      events: [] as string[],
      transitions: [] as { to: string; leaseOwner: string | undefined }[],
      /** Called during readiness: lets a test hand the lease to somebody else mid-resume. */
      duringReadiness: () => undefined as void,
    };
    const requests = {
      reclaimStale: async () => [],
      claimOwn: async ({ leaseOwner }: { leaseOwner: string }) =>
        state.row.leaseOwner === leaseOwner && state.row.state === 'RESTARTING' ? state.row : null,
      claimConfirmed: async () => null,
      heartbeat: async () => undefined,
      byIdUnscoped: async () => state.row,
      transition: async (input: {
        id: string;
        from: readonly string[];
        to: string;
        leaseOwner?: string;
      }) => {
        state.transitions.push({ to: input.to, leaseOwner: input.leaseOwner });
        // The repository's guards: state in `from`, and the lease when one is named.
        if (!input.from.includes(state.row.state)) return false;
        if (input.leaseOwner !== undefined && input.leaseOwner !== state.row.leaseOwner) {
          return false;
        }
        state.row = { ...state.row, state: input.to as RecoveryRequestRow['state'] };
        return true;
      },
    };
    const executor = new RecoveryExecutor({
      requests,
      journal: { pending: async () => [] },
      readiness: async () => {
        const answer = readiness[Math.min(state.readinessCalls, readiness.length - 1)];
        state.readinessCalls += 1;
        state.duringReadiness();
        if (answer === 'throw') throw new Error('redis is still starting');
        return { degraded: answer !== true };
      },
      clock: { now: () => NOW },
      opsLog: {
        record: async (_scope: unknown, event: { code: string }) => {
          state.events.push(event.code);
          return {} as never;
        },
      },
      scope: () => ({ tenantId: 't1', botInstanceId: null }),
      leaseOwner: OWNER,
      tickIntervalMs: 60_000,
      resumeReadiness: { attempts: 4, initialDelayMs: 100, maxDelayMs: 250 },
      sleep: async (ms: number) => {
        state.sleeps.push(ms);
      },
      logger: { info() {}, warn() {}, error() {} },
    } as unknown as RecoveryExecutorDeps);
    return { executor, state };
  }

  it('retries readiness and SUCCEEDS when the stack comes up on the third attempt', async () => {
    const { executor, state } = world([false, 'throw', true]);
    await executor.tick();
    expect(state.readinessCalls).toBe(3);
    expect(state.sleeps).toEqual([100, 200]);
    expect(state.row.state).toBe('SUCCEEDED');
    expect(state.events).toEqual(['recovery.run_ok']);
  });

  it('FAILS only after the bound, with backoff capped', async () => {
    const { executor, state } = world([false]);
    await executor.tick();
    expect(state.readinessCalls).toBe(4);
    expect(state.sleeps).toEqual([100, 200, 250]);
    expect(state.row.state).toBe('FAILED');
    expect(state.events).toEqual(['recovery.run_failed']);
  });

  it('writes nothing when the lease moved to another owner during readiness', async () => {
    for (const readiness of [[true], [false]] as const) {
      const { executor, state } = world(readiness);
      state.duringReadiness = () => {
        state.row = { ...state.row, leaseOwner: 'recovery:another-host' };
      };
      await executor.tick();
      // Each transition named OUR lease, and none applied to a row we no longer own.
      expect(state.transitions.length).toBeGreaterThan(0);
      expect(state.transitions.every((t) => t.leaseOwner === OWNER)).toBe(true);
      expect(state.row.state).toBe('RESTARTING');
      expect(state.events).toEqual([]);
    }
  });
});
