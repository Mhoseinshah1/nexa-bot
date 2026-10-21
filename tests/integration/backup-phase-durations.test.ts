import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness';
import { DrizzleBackupRunRepository } from '../../apps/api/src/modules/platform/backup/infrastructure/drizzle-backup-run.repository';

/**
 * Round 5B: the duration of each backup stage is written with the run and read back with it,
 * through the real column and the real repository.
 */
describe('backup run phase durations', () => {
  let context: TestContext;
  let runs: DrizzleBackupRunRepository;
  const NOW = new Date('2026-10-10T08:00:00.000Z');

  beforeAll(async () => {
    context = await createTestContext();
    runs = new DrizzleBackupRunRepository(context.container.database.db);
  }, 60_000);

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  it('round-trips the per-stage milliseconds, and keeps a never-reached stage absent', async () => {
    const id = randomUUID();
    await runs.start({ id, trigger: 'MANUAL', leaseOwner: 'test', now: NOW });
    await runs.finish({
      id,
      leaseOwner: 'test',
      state: 'FAILED',
      stage: 'ENCRYPT',
      now: NOW,
      deliveryState: 'NOT_ATTEMPTED',
      failureCode: 'backup.tool_oom_killed',
      cleanupOk: true,
      phaseDurationsMs: { DUMP: 41_000, CHECKSUM: 0, ENCRYPT: 7_000 },
    });

    const row = await runs.byId(id);
    expect(row?.phaseDurationsMs).toEqual({ DUMP: 41_000, CHECKSUM: 0, ENCRYPT: 7_000 });
    expect(row?.failureCode).toBe('backup.tool_oom_killed');
  });

  it('is null for a run that recorded none', async () => {
    const id = randomUUID();
    await runs.start({ id, trigger: 'MANUAL', leaseOwner: 'test', now: NOW });
    await runs.finish({
      id,
      leaseOwner: 'test',
      state: 'SUCCEEDED',
      stage: 'CLEANUP',
      now: NOW,
      deliveryState: 'NOT_ATTEMPTED',
      cleanupOk: true,
    });
    expect((await runs.byId(id))?.phaseDurationsMs).toBeNull();
  });
});
