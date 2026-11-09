import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { NexaError } from '@nexa/contracts';
import { storedFailureMessage } from '../../apps/api/src/modules/platform/backup/application/stored-failure';
import {
  TenantArchiveService,
  TenantRestoreService,
} from '../../apps/api/src/modules/platform/backup/application/tenant-archive.service';

/**
 * Security review of PR #447, finding 1: a tenant restore inserts an archive's rows, and a
 * failed INSERT surfaces as drizzle's `Failed query: <SQL> params: <values>` — customer data.
 * `failure_message` stores a NexaError's own text or the schema-only error chain, never that.
 */
const VALUE = '0192f000-dead-7000-8000-00000000beef';

function failedInsert(): Error {
  const pg = Object.assign(
    new Error(
      'insert or update on table "tickets" violates foreign key constraint "tickets_bot_fk"',
    ),
    {
      name: 'error',
      code: '23503',
      severity: 'ERROR',
      constraint: 'tickets_bot_fk',
      table: 'tickets',
      detail: `Key (bot_instance_id)=(${VALUE}) is not present in table "bot_instances".`,
    },
  );
  return new DrizzleQueryError('insert into "tickets" values ($1, $2)', ['x', VALUE], pg);
}

describe('storedFailureMessage', () => {
  it('keeps the schema-only chain of a failed query and none of its values', () => {
    const raw = failedInsert();
    expect(raw.message).toContain(VALUE);
    const stored = storedFailureMessage(raw);
    expect(stored).not.toContain(VALUE);
    expect(stored).not.toContain('params:');
    expect(stored).toContain('code=23503');
    expect(stored).toContain('constraint=tickets_bot_fk');
    expect(stored).toContain('table=tickets');
  });

  it('keeps a NexaError’s own message, which this codebase wrote', () => {
    expect(
      storedFailureMessage(
        new NexaError({ kind: 'INTERNAL', code: 'x.y', message: 'The scratch lost rows.' }),
      ),
    ).toBe('The scratch lost rows.');
  });

  it('never keeps an arbitrary error’s message', () => {
    expect(storedFailureMessage(new Error(`could not read ${VALUE}`))).not.toContain(VALUE);
  });
});

describe('TenantArchiveService — what a failed run writes on its row', () => {
  it('finishes FAILED with the stored form, not the raw message', async () => {
    const finish = vi.fn(async () => undefined);
    const service = new TenantArchiveService({
      runs: {
        reclaimStale: async () => 0,
        start: async () => ({ claimed: true }),
        heartbeat: async () => undefined,
        progress: async () => undefined,
        finish,
        byId: async () => ({ id: 'run-1' }),
      } as never,
      engine: {
        leaked: [],
        sweepAbandonedScratch: async () => ({ dropped: [], survived: [] }),
        workspace: async () => ({
          plainDirectory: '/p',
          verifyDirectory: '/v',
          archivePath: '/a',
          discardPlaintext: async () => [],
          discardAll: async () => [],
        }),
        dump: async () => {
          throw failedInsert();
        },
      } as never,
      heavyJobs: {
        runWhenAdmitted: async (_k: unknown, _t: unknown, job: () => Promise<unknown>) => ({
          ran: true,
          result: await job(),
        }),
      } as never,
      clock: { now: () => new Date(0) } as never,
      ids: { uuid: () => 'run-1' } as never,
      leaseOwner: 'test',
      queue: { pollMs: 1, maxWaitMs: 1, sleep: async () => undefined },
      logger: { info: () => undefined, error: () => undefined },
    });
    await service.run({ tenantId: 't', trigger: 'MANUAL', password: 'p' });
    expect(finish).toHaveBeenCalledTimes(1);
    const written = (finish.mock.calls[0] as unknown as [{ failureMessage: string }])[0];
    expect(written.failureMessage).not.toContain(VALUE);
    expect(written.failureMessage).not.toContain('params:');
  });
});

describe('TenantRestoreService — what a failed restore writes on its row', () => {
  it('finishes FAILED with the stored form, not the raw message', async () => {
    const finish = vi.fn(async () => undefined);
    const order: string[] = [];
    const service = new TenantRestoreService({
      engine: {
        sha256: async () => 'a'.repeat(64),
        sweepAbandonedScratch: async () => {
          order.push('sweep');
          return { dropped: [], survived: [] };
        },
        restore: async (input: { onOpened: (manifest: unknown) => Promise<void> }) => {
          await input.onOpened({ tenant: { id: 'tenant-x' }, archiveId: 'arch' });
          throw failedInsert();
        },
      } as never,
      requests: {
        create: vi.fn(async () => {
          order.push('create');
        }),
        reclaimStale: vi.fn(async () => {
          order.push('reclaim');
          return 0;
        }),
        heartbeat: vi.fn(),
        stage: vi.fn(),
        confirm: vi.fn(),
        finish,
      } as never,
      heavyJobs: {
        runWhenAdmitted: async (_k: unknown, _t: unknown, job: () => Promise<unknown>) => ({
          ran: true,
          result: await job(),
        }),
      } as never,
      clock: { now: () => new Date(0) } as never,
      ids: { uuid: () => 'id-1' } as never,
      leaseOwner: 'test',
      queue: { pollMs: 1, maxWaitMs: 1, sleep: async () => undefined },
    });
    await expect(
      service.restore({
        installationTenantId: 't',
        actorAdminId: 'a',
        archivePath: '/x.7z',
        password: 'p',
        directory: '/d',
        mode: 'NEW',
      }),
    ).rejects.toBeInstanceOf(DrizzleQueryError);
    expect(finish).toHaveBeenCalledTimes(1);
    const written = (finish.mock.calls[0] as unknown as [unknown, { failureMessage: string }])[1];
    expect(written.failureMessage).not.toContain(VALUE);
    expect(written.failureMessage).not.toContain('params:');
    // Findings 2 and 3: once admitted, a dead restore's slot and scratch are cleared first.
    expect(order).toEqual(['reclaim', 'sweep', 'create']);
  });
});
