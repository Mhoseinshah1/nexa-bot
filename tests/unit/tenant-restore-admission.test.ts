import { describe, expect, it, vi } from 'vitest';
import { TenantRestoreService } from '../../apps/api/src/modules/platform/backup/application/tenant-archive.service';

/**
 * Codex review of PR #447 (P1): the confirmation moves a VERIFIED row to VERIFYING. When heavy-job
 * admission is refused (the callback never runs) the row must stay VERIFIED so the owner can retry;
 * stranded in VERIFYING it would hold the single-active-restore index forever.
 */
describe('TenantRestoreService — confirmation happens only after admission', () => {
  const build = (ran: boolean) => {
    const confirm = vi.fn(async () => ({ hostedTenantId: 'tenant-x' }));
    const sha256 = vi.fn(async () => 'a'.repeat(64));
    const service = new TenantRestoreService({
      engine: {
        sha256,
        restore: vi.fn(async () => ({})),
        sweepAbandonedScratch: vi.fn(async () => ({ dropped: [], survived: [] })),
      } as never,
      requests: {
        confirm,
        stage: vi.fn(),
        finish: vi.fn(),
        create: vi.fn(),
        heartbeat: vi.fn(),
        reclaimStale: vi.fn(async () => 0),
      } as never,
      heavyJobs: {
        runWhenAdmitted: async (_k: unknown, _t: unknown, job: () => Promise<unknown>) =>
          ran ? { ran: true, result: await job().catch(() => 'failed') } : { ran: false },
      } as never,
      clock: { now: () => new Date(0) } as never,
      ids: { uuid: () => 'id-1' } as never,
      leaseOwner: 'test',
      queue: { pollMs: 1, maxWaitMs: 1, sleep: async () => undefined } as never,
    });
    return { service, confirm };
  };
  const input = {
    installationTenantId: 't',
    actorAdminId: 'a',
    archivePath: '/x.7z',
    password: 'p',
    directory: '/d',
    mode: 'NEW' as const,
    confirmRequestId: 'req-1',
  };

  it('does not confirm when admission is refused', async () => {
    const { service, confirm } = build(false);
    expect(await service.restore(input)).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('confirms once admitted', async () => {
    const { service, confirm } = build(true);
    await service.restore(input);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
