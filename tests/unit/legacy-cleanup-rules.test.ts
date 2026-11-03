import { describe, expect, it } from 'vitest';
import {
  LEGACY_CLEANUP_AWAITING_DESTINATION_CODE,
  LEGACY_CLEANUP_BLOCKING_DIFFERENCES,
  LEGACY_CLEANUP_DESTINATION_READY_CODE,
  LEGACY_CLEANUP_RECONCILIATION_DIFFERS_CODE,
  type BackupDeliveryDestination,
  type OperationalEventInput,
} from '@nexa/contracts';
import { balanceReconciliationClean } from '../../apps/api/src/modules/platform/legacy-compaction/application/cleanup-rules';
import { LegacyCleanupScheduler } from '../../apps/api/src/modules/platform/legacy-compaction/application/legacy-cleanup.scheduler';
import { sizeSummary } from '../../apps/api/src/modules/platform/legacy-compaction/application/legacy-compaction.executor';

/**
 * v0.9.7 PR-1: when the automatic cleanup after an import may run — the reconciliation rule
 * and the scheduler's three outcomes (refused, waiting for a destination, requested).
 */

const zero: Record<string, number> = Object.fromEntries(
  LEGACY_CLEANUP_BLOCKING_DIFFERENCES.map((kind) => [kind, 0]),
);
const clean = {
  verdict: 'RECONCILED',
  differences: { ...zero, NOT_IN_MIRZA: 4 } as Record<string, number>,
};

describe('the balance reconciliation rule', () => {
  it('is clean only with every blocking kind recorded as zero', () => {
    expect(balanceReconciliationClean(clean)).toBe(true);
    // Another kind of difference (a Nexa customer Mirza did not have) does not block.
    expect(
      balanceReconciliationClean({ verdict: 'DIFFERENCES', differences: clean.differences }),
    ).toBe(true);
  });

  it.each(LEGACY_CLEANUP_BLOCKING_DIFFERENCES)('blocks on any %s', (kind) => {
    expect(
      balanceReconciliationClean({
        verdict: 'DIFFERENCES',
        differences: { ...clean.differences, [kind]: 1 },
      }),
    ).toBe(false);
  });

  it.each(LEGACY_CLEANUP_BLOCKING_DIFFERENCES)(
    'reads a missing %s as unknown, not zero',
    (kind) => {
      const rest = { ...clean.differences };
      delete rest[kind];
      expect(balanceReconciliationClean({ verdict: 'RECONCILED', differences: rest })).toBe(false);
    },
  );

  it('never reads a missing or malformed reconciliation as clean', () => {
    expect(balanceReconciliationClean(null)).toBe(false);
    expect(balanceReconciliationClean(undefined)).toBe(false);
    expect(balanceReconciliationClean({})).toBe(false);
    expect(balanceReconciliationClean({ verdict: 'FINE', differences: zero })).toBe(false);
    expect(
      balanceReconciliationClean({ verdict: 'RECONCILED', differences: { ...zero, x: -1 } }),
    ).toBe(false);
  });
});

describe('the operations group summary', () => {
  it('prints each table before → after in MiB, sizes only', () => {
    const mib = (n: number) => String(n * 1024 * 1024);
    expect(
      sizeSummary(
        {
          tables: { legacy_history_records: mib(1952), legacy_import_map: mib(162) },
          recordTypes: {},
        },
        { tables: { legacy_history_records: mib(410), legacy_import_map: '0' }, recordTypes: {} },
      ),
    ).toBe(
      'history 1952→410 · map 162→0 · candidates ?→? · staging ?→? · trials ?→? · invoices ?→?',
    );
  });
});

describe('the automatic cleanup scheduler', () => {
  function harness(input: {
    reconciled: boolean;
    destination: BackupDeliveryDestination;
    awaitingOpen?: boolean;
  }) {
    let now = Date.parse('2026-11-03T10:00:00Z');
    const recorded: OperationalEventInput[] = [];
    const requested: string[] = [];
    const scheduler = new LegacyCleanupScheduler({
      repository: {
        automaticCandidates: async () => [{ tenantId: 't-1', importId: 'i-1' }],
        importReadiness: async () => ({
          completed: true,
          inFlight: false,
          reconciled: input.reconciled,
        }),
        awaitingDestinationOpen: async () => input.awaitingOpen === true,
      },
      service: {
        requestAutomatic: async (_scope, _actor, command) => {
          requested.push(command.importId);
          return null;
        },
      },
      backupDestination: async () => input.destination,
      opsLog: {
        record: async (_scope, event) => {
          recorded.push(event);
          return {} as never;
        },
      },
      clock: { now: () => new Date(now) } as never,
      actor: () => ({ type: 'SYSTEM_JOB' }) as never,
      logger: { info() {}, warn() {} },
    });
    return {
      scheduler,
      recorded,
      requested,
      later: (ms: number) => {
        now += ms;
      },
    };
  }

  it('requests nothing while the reconciliation is not clean, and says so once', async () => {
    const h = harness({ reconciled: false, destination: 'OPS_GROUP_TOPIC' });
    await h.scheduler.tick();
    h.later(2 * 3_600_000);
    await h.scheduler.tick();
    expect(h.requested).toEqual([]);
    expect(h.recorded.map((e) => e.code)).toEqual([LEGACY_CLEANUP_RECONCILIATION_DIFFERS_CODE]);
  });

  it('requests nothing without a backup destination, and re-alerts at most daily', async () => {
    const h = harness({ reconciled: true, destination: 'NONE' });
    await h.scheduler.tick();
    h.later(2 * 3_600_000);
    await h.scheduler.tick();
    h.later(23 * 3_600_000);
    await h.scheduler.tick();
    expect(h.requested).toEqual([]);
    expect(h.recorded.map((e) => e.code)).toEqual([
      LEGACY_CLEANUP_AWAITING_DESTINATION_CODE,
      LEGACY_CLEANUP_AWAITING_DESTINATION_CODE,
    ]);
  });

  it('requests the cleanup once everything holds, recovering an open wait', async () => {
    const h = harness({ reconciled: true, destination: 'DEDICATED_CHAT', awaitingOpen: true });
    await h.scheduler.tick();
    expect(h.requested).toEqual(['i-1']);
    expect(h.recorded.map((e) => [e.code, e.recoversCode])).toEqual([
      [LEGACY_CLEANUP_DESTINATION_READY_CODE, LEGACY_CLEANUP_AWAITING_DESTINATION_CODE],
    ]);
    // Evaluated at most hourly.
    await h.scheduler.tick();
    expect(h.requested).toEqual(['i-1']);
  });
});
