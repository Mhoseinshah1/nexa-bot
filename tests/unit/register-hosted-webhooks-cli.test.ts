import { describe, expect, it, vi } from 'vitest';
import {
  registerHostedInteractively,
  requireHostedRecoveryTerminal,
} from '../../apps/api/src/register-hosted-webhooks.cli';

function setup() {
  const result = {
    admin: { id: 'owner', username: 'owner' },
    session: { id: 'session' },
    token: 'never-print-this-session',
  };
  const auth = {
    signIn: vi.fn().mockResolvedValue({ kind: 'SIGNED_IN', result }),
    completeSecondFactor: vi.fn().mockResolvedValue(result),
    logout: vi.fn().mockResolvedValue(undefined),
  };
  const section = {
    openSession: vi.fn().mockResolvedValue({ opened: { token: 'never-print-this-section' } }),
    closeSession: vi.fn().mockResolvedValue({ closed: 1 }),
  };
  const container = {
    auth,
    hostingSection: section,
    tenants: { findPrimary: vi.fn().mockResolvedValue({ id: 'primary', kind: 'PRIMARY' }) },
    setInstallationTenant: vi.fn(),
    ids: { uuid: () => 'correlation' },
  } as unknown as Parameters<typeof registerHostedInteractively>[0];
  const recovery = {
    preview: vi.fn().mockResolvedValue({ count: 2, through: 'hosted' }),
    run: vi.fn().mockResolvedValue({ ready: 1, skipped: 1, failed: 0 }),
  };
  const prompt = {
    line: vi.fn().mockResolvedValueOnce('owner').mockResolvedValueOnce('REGISTER 2'),
    secret: vi
      .fn()
      .mockResolvedValueOnce('never-print-this-password')
      .mockResolvedValueOnce('123456'),
  };
  const write = vi.fn();
  return {
    auth,
    section,
    container,
    recovery,
    prompt,
    write,
    run: () => registerHostedInteractively(container, recovery, prompt, write),
  };
}

describe('hosted recovery CLI authorization', () => {
  it('refuses non-terminals and all arguments without echoing caller values', () => {
    expect(() => requireHostedRecoveryTerminal([], false)).toThrow('terminal');
    expect(() => requireHostedRecoveryTerminal(['secret-token'], true)).toThrow('no arguments');
    try {
      requireHostedRecoveryTerminal(['secret-token'], true);
    } catch (error) {
      expect(String(error)).not.toContain('secret-token');
    }
    expect(() => requireHostedRecoveryTerminal([], true)).not.toThrow();
  });

  it('uses the real owner session, fresh hosting proof, counted confirmation and cleanup', async () => {
    const f = setup();
    expect(await f.run()).toBe(0);
    expect(f.section.openSession).toHaveBeenCalledWith(
      { tenantId: 'primary', botInstanceId: null },
      expect.objectContaining({ type: 'WEB_ADMIN', id: 'owner', sessionId: 'session' }),
      { proof: { code: '123456' } },
    );
    expect(f.recovery.run).toHaveBeenCalledOnce();
    expect(f.section.closeSession).toHaveBeenCalledOnce();
    expect(f.auth.logout).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.write.mock.calls)).not.toContain('never-print');
  });

  it('completes the separate sign-in factor before asking for hosting proof', async () => {
    const f = setup();
    f.auth.signIn.mockResolvedValue({
      kind: 'SECOND_FACTOR_REQUIRED',
      challengeToken: 'private-challenge',
    });
    f.prompt.secret
      .mockReset()
      .mockResolvedValueOnce('password')
      .mockResolvedValueOnce('backup-code')
      .mockResolvedValueOnce('654321');
    await f.run();
    expect(f.auth.completeSecondFactor).toHaveBeenCalledWith(
      'private-challenge',
      expect.objectContaining({ id: null }),
      { backupCode: 'backup-code' },
      expect.anything(),
    );
    expect(f.section.openSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      proof: { code: '654321' },
    });
  });

  it.each(['password', 'signin-factor', 'hosting-factor'])(
    'refuses invalid %s before enumeration',
    async (kind) => {
      const f = setup();
      if (kind === 'password') f.auth.signIn.mockRejectedValue(new Error('rejected'));
      else if (kind === 'signin-factor') {
        f.auth.signIn.mockResolvedValue({
          kind: 'SECOND_FACTOR_REQUIRED',
          challengeToken: 'challenge',
        });
        f.auth.completeSecondFactor.mockRejectedValue(new Error('rejected'));
      } else f.section.openSession.mockRejectedValue(new Error('rejected'));
      await expect(f.run()).rejects.toThrow('rejected');
      expect(f.recovery.preview).not.toHaveBeenCalled();
      expect(f.recovery.run).not.toHaveBeenCalled();
      if (kind === 'hosting-factor') expect(f.auth.logout).toHaveBeenCalledOnce();
    },
  );

  it('cancellation and mismatched counts cannot start the batch', async () => {
    const f = setup();
    f.prompt.line.mockReset().mockResolvedValueOnce('owner').mockResolvedValueOnce('REGISTER 3');
    expect(await f.run()).toBe(1);
    expect(f.recovery.run).not.toHaveBeenCalled();
    expect(f.auth.logout).toHaveBeenCalledOnce();
  });

  it('returns exit 2 for partial failures and cleans up even on a failed batch', async () => {
    const f = setup();
    f.recovery.run.mockResolvedValue({ ready: 0, skipped: 1, failed: 1 });
    expect(await f.run()).toBe(2);
    const broken = setup();
    broken.recovery.run.mockRejectedValue(new Error('db failure'));
    broken.section.closeSession.mockRejectedValue(new Error('cleanup failure'));
    await expect(broken.run()).rejects.toThrow();
    expect(broken.auth.logout).toHaveBeenCalledOnce();
  });
});
