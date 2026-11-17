import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:https';
import { HttpsTlsProbe } from '../../apps/api/src/modules/platform/hosting/infrastructure/https-tls-probe';

vi.mock('node:https', () => ({ request: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('hosted TLS wall-clock deadline', () => {
  it('destroys a request whose DNS never reaches a socket timeout, without disabling certificate verification', async () => {
    vi.useFakeTimers();
    const req = Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
    vi.mocked(request).mockReturnValue(req as unknown as ReturnType<typeof request>);
    const result = new HttpsTlsProbe(50).probe('bots.example.com');
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toEqual({ ok: false, reason: 'UNREACHABLE' });
    expect(req.destroy).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'bots.example.com',
        servername: 'bots.example.com',
        rejectUnauthorized: true,
        port: 443,
      }),
      expect.any(Function),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
