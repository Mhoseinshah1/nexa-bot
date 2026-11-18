import { describe, expect, it, vi } from 'vitest';
import {
  HOSTING_ACTIVATION_ERROR_CODES as CODES,
  NexaError,
  type ActorContext,
  type TenantContext,
} from '@nexa/contracts';
import { HostedWebhookRecoveryService } from '../../apps/api/src/modules/platform/hosting/application/hosted-webhook-recovery.service';
import type { HostedBotRow } from '../../apps/api/src/modules/platform/hosting/application/ports';

const scope = { tenantId: 'installation', botInstanceId: null } as TenantContext;
const actor = { id: 'owner', type: 'WEB_ADMIN', surface: 'WEB' } as ActorContext;
const now = new Date('2026-11-17T00:00:00Z');
function setup() {
  const row: HostedBotRow = {
    tenantId: 'installation',
    hostedTenantId: 'hosted',
    state: 'ACTIVE',
    expiresAt: null,
    ownerAdminId: 'owner',
    createdByAdminId: 'creator',
    createdAt: now,
    stateChangedAt: now,
    deletedAt: null,
    purgedAt: null,
  };
  const findHosted = vi.fn().mockResolvedValue(row);
  const findById = vi
    .fn()
    .mockResolvedValue({ kind: 'HOSTED', parentTenantId: 'installation', status: 'ACTIVE' });
  const requireSection = vi.fn().mockResolvedValue(scope);
  const replaceInProgress = vi.fn().mockResolvedValue(false);
  const page = vi.fn().mockResolvedValueOnce([row]).mockResolvedValue([]);
  const recoverWebhook = vi.fn().mockResolvedValue(undefined);
  const service = new HostedWebhookRecoveryService({
    candidates: { preview: vi.fn().mockResolvedValue({ count: 1, through: 'hosted' }), page },
    hosting: { findHosted, replaceInProgress },
    tenants: { findById },
    section: { requireSection },
    activation: { recoverWebhook },
    clock: { now: () => now },
    ids: { uuid: () => 'run-id', callbackRef: () => 'callback' },
  });
  const report = vi.fn();
  const run = () => service.run(scope, actor, 'section', { count: 1, through: 'hosted' }, report);
  return {
    row,
    findHosted,
    findById,
    requireSection,
    replaceInProgress,
    page,
    recoverWebhook,
    report,
    run,
  };
}

describe('hosted webhook recovery policy and batch bounds', () => {
  it.each(['SUSPENDED', 'EXPIRED', 'DELETED', 'PURGED'])(
    'skips %s before credential access',
    async (state) => {
      const f = setup();
      f.findHosted.mockResolvedValue({ ...f.row, state });
      expect(await f.run()).toEqual({ ready: 0, skipped: 1, failed: 0 });
      expect(f.recoverWebhook).not.toHaveBeenCalled();
    },
  );

  it.each([
    'expired',
    'deletedAt',
    'purgedAt',
    'wrong-register',
    'missing',
    'replace',
    'stopped-tenant',
    'foreign-parent',
    'primary-kind',
  ])('refuses %s even when the register says ACTIVE', async (reason) => {
    const f = setup();
    if (reason === 'expired') f.findHosted.mockResolvedValue({ ...f.row, expiresAt: now });
    if (reason === 'deletedAt' || reason === 'purgedAt')
      f.findHosted.mockResolvedValue({ ...f.row, [reason]: now });
    if (reason === 'wrong-register')
      f.findHosted.mockResolvedValue({ ...f.row, tenantId: 'other' });
    if (reason === 'missing') f.findHosted.mockResolvedValue(null);
    if (reason === 'replace') f.replaceInProgress.mockResolvedValue(true);
    if (reason === 'stopped-tenant')
      f.findById.mockResolvedValue({
        kind: 'HOSTED',
        parentTenantId: 'installation',
        status: 'STOPPED',
      });
    if (reason === 'foreign-parent')
      f.findById.mockResolvedValue({ kind: 'HOSTED', parentTenantId: 'other', status: 'ACTIVE' });
    if (reason === 'primary-kind')
      f.findById.mockResolvedValue({
        kind: 'PRIMARY',
        parentTenantId: 'installation',
        status: 'ACTIVE',
      });
    expect((await f.run()).skipped).toBe(1);
    expect(f.recoverWebhook).not.toHaveBeenCalled();
  });

  it('never passes the primary tenant to the registrar even if enumeration is corrupt', async () => {
    const f = setup();
    f.page
      .mockReset()
      .mockResolvedValueOnce([{ ...f.row, hostedTenantId: 'installation' }])
      .mockResolvedValue([]);
    expect((await f.run()).skipped).toBe(1);
    expect(f.findById).not.toHaveBeenCalled();
    expect(f.recoverWebhook).not.toHaveBeenCalled();
  });

  it('uses one in-flight bot across pages and isolates closed-code failures without rendering exceptions', async () => {
    const f = setup();
    const rows = Array.from({ length: 101 }, (_, n) => ({
      ...f.row,
      hostedTenantId: `hosted-${String(n).padStart(3, '0')}`,
    }));
    f.page
      .mockReset()
      .mockResolvedValueOnce(rows.slice(0, 50))
      .mockResolvedValueOnce(rows.slice(50, 100))
      .mockResolvedValueOnce(rows.slice(100))
      .mockResolvedValue([]);
    let inFlight = 0;
    let maximum = 0;
    f.recoverWebhook.mockImplementation(async (_scope, _actor, _token, id, _run, eligible) => {
      inFlight += 1;
      maximum = Math.max(maximum, inFlight);
      await eligible();
      await Promise.resolve();
      inFlight -= 1;
      if (id === 'hosted-001')
        throw new NexaError({
          kind: 'VALIDATION',
          code: CODES.TOKEN_REJECTED,
          message: 'secret-token',
        });
      if (id === 'hosted-002')
        throw new NexaError({
          kind: 'VALIDATION',
          code: 'secret-in-code',
          message: 'secret-token',
        });
    });
    expect(await f.run()).toEqual({ ready: 99, skipped: 0, failed: 2 });
    expect(maximum).toBe(1);
    expect(f.page.mock.calls.map((call) => call[1])).toEqual([
      null,
      'hosted-049',
      'hosted-099',
      'hosted-100',
    ]);
    expect(f.page.mock.calls.every((call) => call[0] === scope && call[2] === 'hosted')).toBe(true);
    expect(JSON.stringify(f.report.mock.calls)).not.toContain('secret');
    expect(f.report).toHaveBeenCalledWith({
      hostedTenantId: 'hosted-002',
      outcome: 'FAILED',
      code: 'CHECK_FAILED',
    });
  });

  it('denies a revoked owner section before enumeration', async () => {
    const f = setup();
    f.requireSection.mockRejectedValue(new Error('revoked'));
    await expect(f.run()).rejects.toThrow('revoked');
    expect(f.page).not.toHaveBeenCalled();
    expect(f.recoverWebhook).not.toHaveBeenCalled();
  });
});
