import { describe, expect, it } from 'vitest';
import {
  DATA_EXPORT_ERROR_CODES,
  DATA_EXPORT_TTL_MS,
  NexaError,
  type DataExportState,
} from '@nexa/contracts';
import { DataExportRunner } from '../../apps/api/src/modules/platform/data-export/application/data-export.runner';
import type {
  DataExportRepository,
  DataExportRow,
} from '../../apps/api/src/modules/platform/data-export/application/ports';

/**
 * Phase 6B PR-3: the worker's side of the export — through the heavy-job queue, a 24 h
 * deadline, the file removed with its link, and no file left behind by a failure.
 */

const T0 = new Date('2026-03-01T10:00:00.000Z');
const TENANT = '01900000-0000-7000-8000-0000000d0001';
const EXPORT_ID = '01900000-0000-7000-8000-00000000ee01';

function row(patch: Partial<DataExportRow> = {}): DataExportRow {
  return {
    id: EXPORT_ID,
    tenantId: TENANT,
    state: 'RUNNING',
    requestedByAdminId: '01900000-0000-7000-8000-00000000ad01',
    requestedByHost: false,
    requestedAt: T0,
    leaseOwner: 'worker:test',
    heartbeatAt: T0,
    attempts: 1,
    fileName: null,
    bytes: null,
    sha256: null,
    readyAt: null,
    expiresAt: null,
    removedAt: null,
    failureCode: null,
    updatedAt: T0,
    ...patch,
  };
}

interface Rig {
  readonly runner: DataExportRunner;
  readonly calls: string[];
  readonly removed: string[];
  readonly ready: { expiresAt: Date; bytes: number; sha256: string }[];
  readonly failed: string[];
}

function rig(options: {
  claim?: DataExportRow | null;
  admitted?: boolean;
  write?: () => Promise<{ bytes: number; sha256: string }>;
  markReady?: boolean;
  pending?: DataExportRow[];
  disk?: { tenantId: string; fileName: string; exportId: string }[];
  states?: { id: string; state: DataExportState; fileName: string | null }[];
}): Rig {
  const calls: string[] = [];
  const removed: string[] = [];
  const ready: Rig['ready'] = [];
  const failed: string[] = [];
  const repository = {
    failAbandoned: async () => {
      calls.push('failAbandoned');
      return 0;
    },
    expireDue: async () => {
      calls.push('expireDue');
      return 0;
    },
    pendingRemoval: async () => options.pending ?? [],
    statesOf: async () => options.states ?? [],
    markRemoved: async (_scope: unknown, id: string) => {
      calls.push(`markRemoved:${id}`);
    },
    claimNext: async () => (options.claim === undefined ? row() : options.claim),
    heartbeat: async () => true,
    release: async () => {
      calls.push('release');
      return true;
    },
    markReady: async (
      _scope: unknown,
      input: { expiresAt: Date; bytes: number; sha256: string },
    ) => {
      ready.push({ expiresAt: input.expiresAt, bytes: input.bytes, sha256: input.sha256 });
      return options.markReady ?? true;
    },
    markFailed: async (_scope: unknown, input: { failureCode: string }) => {
      failed.push(input.failureCode);
      return true;
    },
  } as unknown as DataExportRepository;
  const runner = new DataExportRunner({
    repository,
    files: {
      pathFor: (tenantId, exportId, attempt) => ({
        path: `/x/${tenantId}/${exportId}.${attempt}.zip`,
        fileName: `${exportId}.${attempt}.zip`,
      }),
      list: async () => options.disk ?? [],
      open: async () => null,
      remove: async (_tenantId, fileName) => {
        removed.push(fileName);
      },
    },
    writer: {
      write:
        options.write ??
        (async () => {
          calls.push('write');
          return { bytes: 1234, sha256: 'a'.repeat(64) };
        }),
    },
    queue: {
      runWhenAdmitted: async (kind, tenantId, job) => {
        calls.push(`queue:${kind}:${tenantId}`);
        if (options.admitted === false) return { ran: false };
        return { ran: true, result: await job() };
      },
    },
    clock: { now: () => T0 },
    leaseOwner: 'worker:test',
    tickIntervalMs: 15_000,
    queueOptions: { pollMs: 1, maxWaitMs: 1, sleep: async () => undefined },
    heartbeatMs: 30_000,
    staleAfterMs: 300_000,
    maxAttempts: 3,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  return { runner, calls, removed, ready, failed };
}

describe('the data export runner', () => {
  it('makes the ZIP through the heavy-job queue (kind EXPORT) and ends READY with a 24 h deadline', async () => {
    const r = rig({});
    await r.runner.tick();
    expect(r.calls).toContain(`queue:EXPORT:${TENANT}`);
    // The write happens inside the queue's admission, never before it.
    expect(r.calls.indexOf(`queue:EXPORT:${TENANT}`)).toBeLessThan(r.calls.indexOf('write'));
    expect(r.ready).toHaveLength(1);
    expect(r.ready[0]?.expiresAt.getTime()).toBe(T0.getTime() + DATA_EXPORT_TTL_MS);
    expect(DATA_EXPORT_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(r.ready[0]).toMatchObject({ bytes: 1234, sha256: 'a'.repeat(64) });
  });

  it('puts an export the queue did not admit back in line, writing nothing', async () => {
    const r = rig({ admitted: false });
    await r.runner.tick();
    expect(r.calls).toContain('release');
    expect(r.calls).not.toContain('write');
    expect(r.ready).toHaveLength(0);
  });

  it('does nothing when there is nothing to claim', async () => {
    const r = rig({ claim: null });
    expect(await r.runner.tick()).toBeNull();
    expect(r.calls).not.toContain('write');
  });

  it('ends a failed export FAILED with the failure code and removes its partial file', async () => {
    const r = rig({
      write: async () => {
        throw new Error('disk full');
      },
    });
    await r.runner.tick();
    expect(r.failed).toEqual([DATA_EXPORT_ERROR_CODES.FAILED]);
    expect(r.removed).toEqual([`${EXPORT_ID}.1.zip`]);
    expect(r.ready).toHaveLength(0);
  });

  it('records a file too large for a ZIP as data_export.too_large', async () => {
    const r = rig({
      write: async () => {
        throw new NexaError({
          kind: 'PRECONDITION_FAILED',
          code: DATA_EXPORT_ERROR_CODES.TOO_LARGE,
          message: 'x',
        });
      },
    });
    await r.runner.tick();
    expect(r.failed).toEqual([DATA_EXPORT_ERROR_CODES.TOO_LARGE]);
  });

  it('removes the file when the lease was lost, so it is nobody’s file', async () => {
    const r = rig({ markReady: false });
    await r.runner.tick();
    expect(r.removed).toEqual([`${EXPORT_ID}.1.zip`]);
  });

  it('removes the file of each expired export, then marks it removed; a failure is retried next tick', async () => {
    const expired = row({ state: 'EXPIRED', fileName: `${EXPORT_ID}.1.zip`, expiresAt: T0 });
    const r = rig({ claim: null, pending: [expired] });
    await r.runner.tick();
    expect(r.removed).toEqual([`${EXPORT_ID}.1.zip`]);
    expect(r.calls).toContain(`markRemoved:${EXPORT_ID}`);
    expect(r.calls.indexOf('expireDue')).toBeGreaterThanOrEqual(0);
  });

  it('names each attempt’s file by its attempt, so a replacement never shares a path with a stale worker', async () => {
    const first = rig({ claim: row({ attempts: 1 }), markReady: false });
    const second = rig({ claim: row({ attempts: 2 }), markReady: false });
    await first.runner.tick();
    await second.runner.tick();
    expect(first.removed).toEqual([`${EXPORT_ID}.1.zip`]);
    expect(second.removed).toEqual([`${EXPORT_ID}.2.zip`]);
  });

  it('sweeps files left by an exhausted (FAILED) export, a superseded attempt and a deleted row; keeps live ones', async () => {
    const T = '01900000-0000-7000-8000-00000000aa01';
    const id = (n: number) => `01900000-0000-7000-8000-0000000000e${n}`;
    const file = (n: number, a: number) => ({
      tenantId: T,
      exportId: id(n),
      fileName: `${id(n)}.${a}.zip`,
    });
    const r = rig({
      claim: null,
      disk: [file(1, 3), file(2, 1), file(2, 2), file(3, 1), file(4, 1), file(5, 1)],
      states: [
        { id: id(1), state: 'FAILED', fileName: null },
        { id: id(2), state: 'READY', fileName: `${id(2)}.2.zip` },
        { id: id(3), state: 'RUNNING', fileName: null },
        { id: id(4), state: 'REQUESTED', fileName: null },
      ],
    });
    await r.runner.tick();
    expect(r.removed.sort()).toEqual([`${id(1)}.3.zip`, `${id(2)}.1.zip`, `${id(5)}.1.zip`].sort());
  });
});
