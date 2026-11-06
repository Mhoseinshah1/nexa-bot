import { describe, expect, it } from 'vitest';
import {
  RECOVERY_WRITE_ATTEMPTS,
  recoveryWriteBackoffMs,
  runBoundedWrite,
} from '../../apps/api/src/modules/platform/recovery/application/recovery-write-retry';
import {
  RecoveryExecutor,
  type RecoveryExecutorDeps,
} from '../../apps/api/src/modules/platform/recovery/application/recovery-executor';

describe('runBoundedWrite', () => {
  it('backs off exponentially, capped, and never sleeps after the last attempt', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await runBoundedWrite({
      op: async () => {
        calls += 1;
        throw new Error('fk');
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(RECOVERY_WRITE_ATTEMPTS);
    expect(sleeps).toEqual([500, 1000, 2000, 4000]);
    expect(recoveryWriteBackoffMs(20)).toBe(10_000);
  });

  it('stops at the first success', async () => {
    let calls = 0;
    const result = await runBoundedWrite({
      op: async () => {
        calls += 1;
        if (calls < 3) throw new Error('fk');
      },
      sleep: async () => undefined,
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
  });
});

/**
 * The real failure: a cutover journal says a restore completed, the row it describes has to
 * be written into the restored database, and the tenant this process cached is not in it.
 */
describe('a recovery request row that cannot be written', () => {
  const fk = Object.assign(new Error('violates foreign key'), {
    code: '23503',
    constraint: 'recovery_requests_tenant_id_tenants_id_fk',
  });

  function world(guardAdopts: boolean) {
    const state = {
      tenant: 'old' as string,
      writes: [] as { tenantId: string }[],
      cleared: [] as string[],
      events: [] as { code: string; dedupeKey?: string }[],
      verifies: 0,
      sleeps: [] as number[],
    };
    const executor = new RecoveryExecutor({
      requests: {
        reclaimStale: async () => [],
        claimOwn: async () => null,
        claimConfirmed: async () => null,
        byIdUnscoped: async () => null,
        reassert: async (row: { tenantId: string }) => {
          state.writes.push({ tenantId: row.tenantId });
          if (row.tenantId !== 'new') throw fk;
        },
      },
      journal: {
        pending: async () => ['rec-1'],
        read: async () => ({
          status: 'PRESENT',
          entry: { phase: 'RENAMED', displacedDatabase: 'd', candidateDatabase: 'c' },
        }),
        clear: async (id: string) => {
          state.cleared.push(id);
        },
      },
      readiness: async () => ({ degraded: false }),
      clock: { now: () => new Date('2026-10-06T12:00:00.000Z') },
      opsLog: {
        record: async (_s: unknown, event: { code: string; dedupeKey?: string }) => {
          state.events.push(event);
          return {} as never;
        },
      },
      scope: () => ({ tenantId: state.tenant, botInstanceId: null }),
      tenantGuard: {
        verify: async () => {
          state.verifies += 1;
          if (guardAdopts && state.writes.length >= 2) state.tenant = 'new';
          return state.tenant as never;
        },
      },
      leaseOwner: 'me',
      tickIntervalMs: 60_000,
      sleep: async (ms: number) => {
        state.sleeps.push(ms);
      },
      logger: { info() {}, warn() {}, error() {} },
    } as unknown as RecoveryExecutorDeps);
    return { executor, state };
  }

  it('is attempted five times, reported once, and not attempted again on later ticks', async () => {
    const { executor, state } = world(false);
    await executor.tick();
    await executor.tick();
    await executor.tick();
    expect(state.writes).toHaveLength(5);
    expect(state.sleeps).toEqual([500, 1000, 2000, 4000]);
    expect(state.events.filter((e) => e.dedupeKey === 'recovery.rec-1.request_write')).toHaveLength(
      1,
    );
    expect(state.cleared).toEqual([]);
    expect(state.verifies).toBeGreaterThan(0);
  });

  it('writes under the re-resolved tenant once the guard adopts it, then clears the journal', async () => {
    const { executor, state } = world(true);
    await executor.tick();
    expect(state.writes.map((w) => w.tenantId)).toEqual(['old', 'old', 'new']);
    expect(state.cleared).toEqual(['rec-1']);
  });
});
