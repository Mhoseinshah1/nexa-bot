import { describe, expect, it } from 'vitest';
import type { TenantContext, TenantId } from '@nexa/contracts';
import {
  ACTIVE_TENANTS_CACHE_MS,
  TenantFanOut,
  forEachLoopTenant,
  reportedTenantFailure,
} from '../../apps/api/src/infrastructure/lifecycle/tenant-pass';

/**
 * Phase 6A PR-6: one background loop, every ACTIVE tenant. The fan-out's rules — the
 * owner's bot first, a fair rotation that resumes where a budget stopped it, no fallback
 * to the installation tenant, one hosted bot's failure contained — pinned against a fake
 * clock and a fake tenant list.
 */
const OWNER = 'tenant-owner' as TenantId;
const A = 'tenant-a' as TenantId;
const B = 'tenant-b' as TenantId;
const C = 'tenant-c' as TenantId;

function harness(options: {
  active: readonly TenantId[];
  installation?: TenantId | null;
  cacheMs?: number;
}) {
  let now = 1_000_000;
  let reads = 0;
  let active = options.active;
  const errors: Record<string, unknown>[] = [];
  const fanOut = new TenantFanOut({
    activeTenants: () => {
      reads += 1;
      return Promise.resolve(active);
    },
    installationTenantId: () => (options.installation === undefined ? OWNER : options.installation),
    now: () => now,
    logger: { error: (context) => errors.push(context) },
    ...(options.cacheMs === undefined ? {} : { cacheMs: options.cacheMs }),
  });
  return {
    fanOut,
    errors,
    reads: () => reads,
    advance: (ms: number) => {
      now += ms;
    },
    setActive: (ids: readonly TenantId[]) => {
      active = ids;
    },
  };
}

async function served(
  pass: ReturnType<TenantFanOut['pass']>,
  body: (scope: TenantContext) => Promise<void> = async () => {},
): Promise<TenantId[]> {
  const seen: TenantId[] = [];
  await pass.each(async (scope) => {
    seen.push(scope.tenantId);
    await body(scope);
  });
  return seen;
}

describe('TenantFanOut', () => {
  it('serves the installation tenant first, then the others', async () => {
    const h = harness({ active: [B, OWNER, A] });
    const pass = h.fanOut.pass('test', { budgetMs: 60_000 });
    expect(await served(pass)).toEqual([OWNER, A, B]);
  });

  it('resumes the rotation where the budget stopped the previous pass', async () => {
    const h = harness({ active: [OWNER, A, B, C], cacheMs: 0 });
    const pass = h.fanOut.pass('test', { budgetMs: 100 });
    // Every tenant takes 60 ms: the owner and A fit, then the budget is spent.
    const slow = async () => h.advance(60);
    expect(await served(pass, slow)).toEqual([OWNER, A]);
    // The owner first again; then B and C, which were not reached, before A.
    expect(await served(pass, slow)).toEqual([OWNER, B]);
    expect(await served(pass, slow)).toEqual([OWNER, C]);
    expect(await served(pass, slow)).toEqual([OWNER, A]);
  });

  it('always serves at least one tenant, however small the budget', async () => {
    const h = harness({ active: [OWNER, A] });
    const pass = h.fanOut.pass('test', { budgetMs: 0 });
    expect(await served(pass)).toEqual([OWNER]);
  });

  it('serves nobody while the installation has no tenant', async () => {
    const h = harness({ active: [A, B], installation: null });
    const pass = h.fanOut.pass('test', { budgetMs: 60_000 });
    expect(await served(pass)).toEqual([]);
    expect(h.reads()).toBe(0);
  });

  it("throws while the installation has no tenant when the loop asks for 'throw'", async () => {
    const h = harness({ active: [A], installation: null });
    const pass = h.fanOut.pass('provisioner', { budgetMs: 60_000, noTenant: 'throw' });
    await expect(served(pass)).rejects.toThrow(/no tenant yet/);
  });

  it('does not serve a tenant that is not active, and never falls back to the installation', async () => {
    // The owner's bot is stopped: it is not in the active list, so it is not served.
    const h = harness({ active: [A] });
    const pass = h.fanOut.pass('test', { budgetMs: 60_000 });
    expect(await served(pass)).toEqual([A]);
    // Nobody active: nobody served, and no fallback to the installation tenant.
    const empty = harness({ active: [] });
    expect(await served(empty.fanOut.pass('test', { budgetMs: 60_000 }))).toEqual([]);
  });

  it("logs one hosted bot's failure and still serves the rest", async () => {
    const h = harness({ active: [OWNER, A, B] });
    const pass = h.fanOut.pass('test', { budgetMs: 60_000 });
    const seen: TenantId[] = [];
    const report = await pass.each(async (scope) => {
      seen.push(scope.tenantId);
      if (scope.tenantId === A) throw new Error('A is broken');
    });
    expect(seen).toEqual([OWNER, A, B]);
    expect(report).toEqual({ served: 3, failed: 1, deferred: 0 });
    expect(h.errors).toEqual([expect.objectContaining({ loop: 'test', tenantId: A })]);
  });

  it("throws when the owner's own bot failed, after serving the others", async () => {
    const h = harness({ active: [OWNER, A] });
    const pass = h.fanOut.pass('test', { budgetMs: 60_000 });
    const seen: TenantId[] = [];
    await expect(
      pass.each(async (scope) => {
        seen.push(scope.tenantId);
        if (scope.tenantId === OWNER) throw new Error('owner broken');
      }),
    ).rejects.toThrow('owner broken');
    expect(seen).toEqual([OWNER, A]);
  });

  it('throws when every tenant served failed', async () => {
    // The owner's bot is not active, so only hosted bots are served — and all fail.
    const h = harness({ active: [A, B] });
    const pass = h.fanOut.pass('test', { budgetMs: 60_000 });
    await expect(
      pass.each(async (scope) => {
        throw new Error(`down ${scope.tenantId}`);
      }),
    ).rejects.toThrow('down tenant-a');
  });

  it('does not log a failure its loop already reported, but still counts it', async () => {
    const h = harness({ active: [OWNER, A] });
    const pass = h.fanOut.pass('test', { budgetMs: 60_000 });
    const report = await pass.each(async (scope) => {
      if (scope.tenantId === A) throw reportedTenantFailure('already logged');
    });
    expect(report.failed).toBe(1);
    expect(h.errors).toEqual([]);
  });

  it('reuses one read of the active tenants within the cache window', async () => {
    const h = harness({ active: [OWNER, A] });
    const one = h.fanOut.pass('one', { budgetMs: 60_000 });
    const two = h.fanOut.pass('two', { budgetMs: 60_000 });
    await served(one);
    h.advance(ACTIVE_TENANTS_CACHE_MS - 1);
    h.setActive([OWNER, A, B]);
    expect(await served(two)).toEqual([OWNER, A]);
    expect(h.reads()).toBe(1);
    h.advance(1);
    expect(await served(one)).toEqual([OWNER, A, B]);
    expect(h.reads()).toBe(2);
  });
});

describe('forEachLoopTenant', () => {
  it('runs the body once for a fixed scope, and not at all for null', async () => {
    const seen: TenantId[] = [];
    const scope: TenantContext = { tenantId: A, botInstanceId: null };
    expect(
      await forEachLoopTenant(
        () => scope,
        async (s) => {
          seen.push(s.tenantId);
        },
      ),
    ).toEqual({ served: 1, failed: 0, deferred: 0 });
    expect(
      await forEachLoopTenant(
        () => null,
        async (s) => {
          seen.push(s.tenantId);
        },
      ),
    ).toEqual({ served: 0, failed: 0, deferred: 0 });
    expect(seen).toEqual([A]);
  });
});
