import { describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@nexa/contracts';
import {
  ASSISTANT_LEASE_MS,
  ASSISTANT_MAX_ATTEMPTS,
  AssistantLoop,
} from '../../apps/api/src/modules/control/support-ai/application/assistant-loop';
import type { SupportAiJobRecord } from '../../apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai-job.repository';

/**
 * TB5 — the `assistant` loop's own rules (PR #200 review, findings 3 and 7, and a nit): its
 * heartbeat stays fresh through a real provider call, the attempts bound is exact, and a
 * missing tenant scope is reported once rather than every two seconds.
 */

const scope = { tenantId: 't', botInstanceId: null } as unknown as TenantContext;

function job(attempts: number): SupportAiJobRecord {
  return { id: `job-${attempts}`, attempts } as unknown as SupportAiJobRecord;
}

function harness(jobs: SupportAiJobRecord[], produceMs = 0) {
  let ms = Date.parse('2026-10-05T00:00:00Z');
  const fresh: boolean[] = [];
  const logger = { info: vi.fn(), error: vi.fn() };
  const queue = [...jobs];
  const assist = {
    claimNext: vi.fn(async () => queue.shift() ?? null),
    produce: vi.fn(async (_scope: TenantContext, _job: SupportAiJobRecord) => {
      ms += produceMs;
      fresh.push(loop.isFresh(ms));
      return 'READY' as const;
    }),
    abandon: vi.fn(async (_scope: TenantContext, _job: SupportAiJobRecord) => 'FAILED' as const),
    purgeExpired: vi.fn(async () => 0),
  };
  let currentScope: TenantContext | null = scope;
  const loop = new AssistantLoop(assist, {
    scope: () => currentScope,
    intervalMs: 2_000,
    now: () => new Date(ms),
    logger,
  });
  return {
    loop,
    assist,
    logger,
    fresh,
    now: () => ms,
    advance: (by: number) => (ms += by),
    noScope: () => (currentScope = null),
  };
}

describe('AssistantLoop', () => {
  it('stays fresh while a provider call takes a minute, job after job', async () => {
    const h = harness([job(1), job(1), job(1)], 60_000);
    h.loop.start();
    await h.loop.tick();
    await h.loop.stop();
    expect(h.assist.produce).toHaveBeenCalledTimes(3);
    expect(h.fresh).toEqual([true, true, true]);
  });

  it('still goes stale once nothing has completed for longer than a job can take', async () => {
    const h = harness([job(1)]);
    h.loop.start();
    await h.loop.tick();
    expect(h.loop.isFresh(h.now() + ASSISTANT_LEASE_MS)).toBe(true);
    expect(h.loop.isFresh(h.now() + ASSISTANT_LEASE_MS + 1)).toBe(false);
    await h.loop.stop();
  });

  it(`abandons a job on claim ${ASSISTANT_MAX_ATTEMPTS + 1}, and produces it on claim ${ASSISTANT_MAX_ATTEMPTS}`, async () => {
    const h = harness([job(ASSISTANT_MAX_ATTEMPTS + 1), job(ASSISTANT_MAX_ATTEMPTS)]);
    await h.loop.tick();
    expect(h.assist.abandon).toHaveBeenCalledTimes(1);
    expect(h.assist.abandon.mock.calls[0]?.[1]).toMatchObject({
      attempts: ASSISTANT_MAX_ATTEMPTS + 1,
    });
    expect(h.assist.produce).toHaveBeenCalledTimes(1);
    expect(h.assist.produce.mock.calls[0]?.[1]).toMatchObject({ attempts: ASSISTANT_MAX_ATTEMPTS });
  });

  it('claims one job at a time, each with a lease from its own claim', async () => {
    const h = harness([job(1), job(1)], 60_000);
    await h.loop.tick();
    const calls = h.assist.claimNext.mock.calls as unknown as [unknown, Date, Date][];
    expect(calls.length).toBe(3);
    for (const [, at, until] of calls) {
      expect(until.getTime() - at.getTime()).toBe(ASSISTANT_LEASE_MS);
    }
    expect(calls[1]![1].getTime() - calls[0]![1].getTime()).toBe(60_000);
  });

  it('reports a missing tenant scope once, not on every pass', async () => {
    const h = harness([]);
    h.noScope();
    await h.loop.tick();
    await h.loop.tick();
    await h.loop.tick();
    expect(h.logger.info).toHaveBeenCalledTimes(1);
    expect(h.assist.claimNext).not.toHaveBeenCalled();
  });
});
