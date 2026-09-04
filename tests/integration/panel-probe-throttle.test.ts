import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Clock, Instant, ProviderProbeOutcome, ProviderType } from '@nexa/contracts';
import { panelProbeClaims } from '../../apps/api/src/infrastructure/persistence/schema';
import { DrizzlePanelCredentialStore } from '../../apps/api/src/modules/platform/panels/infrastructure/drizzle-panel-credentials';
import { DrizzlePanelRepository } from '../../apps/api/src/modules/platform/panels/infrastructure/drizzle-panel.repository';
import { PanelService } from '../../apps/api/src/modules/platform/panels/application/panel.service';
import type { PanelRepository } from '../../apps/api/src/modules/platform/panels/application/ports';
import { providerAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/adapter-registry';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type SeededAdmin,
  type TestContext,
} from './harness';

/**
 * The connection-test throttle.
 *
 * A probe is an operator-triggered outbound request that logs into somebody
 * else's panel. Two things follow, and both are the subject here: a probe
 * without a bound is a way to sweep a network one panel edit at a time, and a
 * login retried on a loop is a way to lock the account it authenticates with.
 *
 * The throttle lives in PostgreSQL rather than in the process, because two API
 * containers share the panel and share nothing else. So every test here uses
 * the real repository against the real database; the only thing scripted is the
 * provider's answer, and the count of how many times it was asked for one is
 * what most of these assert on.
 *
 * The clock is injected so the expiry test can pass time instead of spending
 * it. Nothing else about the service is stubbed — a sleep in a test is a test
 * that will one day be flaky, and `setTimeout(11_000)` is a test nobody runs.
 */

const PASSWORD = 'throttle-suite-password-K3';
const USERNAME = 'throttle-suite-username-M8';

/** A clock the test moves by hand. */
class StoppedClock implements Clock {
  constructor(private current: Date) {}
  now(): Instant {
    return this.current as Instant;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

describe('the panel connection-test throttle', () => {
  const COOLDOWN_MS = 10_000;

  let ctx: TestContext;
  let owner: SeededAdmin;
  let ownerB: SeededAdmin;
  let clock: StoppedClock;
  /** How many times the provider was actually asked. THE assertion, mostly. */
  let probes: number;
  let answer: () => Promise<ProviderProbeOutcome>;

  beforeEach(async () => {
    ctx ??= await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
    await ctx.reset();
    owner = await createAdmin(ctx.container, tenantA, {
      username: 'owner_throttle_a',
      roleKeys: ['owner'],
    });
    ownerB = await createAdmin(ctx.container, tenantB, {
      username: 'owner_throttle_b',
      roleKeys: ['owner'],
    });
    clock = new StoppedClock(new Date('2026-09-04T10:00:00.000Z'));
    probes = 0;
    answer = async () => ({ ok: true, degraded: false, providerVersion: '1.2.3' });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  let n = 0;
  const key = () => `throttle-key-${(n += 1)}`;

  /** The service under test: the real one, with a scripted provider answer. */
  const service = (
    repository: PanelRepository = new DrizzlePanelRepository(ctx.container.database.db),
  ) =>
    new PanelService({
      repository,
      credentials: new DrizzlePanelCredentialStore(ctx.container.database.db, ctx.container.cipher),
      guard: ctx.container.guard,
      audit: ctx.container.audit,
      opsLog: ctx.container.opsLog,
      sessions: ctx.container.sessions,
      uow: ctx.container.uow,
      idempotency: ctx.container.idempotency,
      clock,
      ids: ctx.container.ids,
      http: new SafeHttpClient({
        allowLoopback: true,
        totalTimeoutMs: 1_000,
        maxResponseBytes: 1_024,
        maxRetries: 0,
      }),
      urlPolicy: { allowLoopback: true },
      probeCooldownMs: COOLDOWN_MS,
      // Generous, so these suites — which are about something else — never
      // hit the tenant-wide bound. Its own suite pins it low.
      probeBudget: { capacity: 10_000, refillPerMs: 1 },
      adapters: (type: ProviderType) => ({
        ...providerAdapter(type),
        probe: async () => {
          probes += 1;
          return answer();
        },
      }),
      cadence: {
        healthyIntervalMs: 10 * 60 * 1000,
        retryableIntervalMs: 2 * 60 * 1000,
        nonRetryableIntervalMs: 60 * 60 * 1000,
      },
    });

  const panelFor = async (admin: SeededAdmin, scope: typeof tenantA, name: string) => {
    const { view } = await service().create(scope, adminActorFor(admin), {
      name,
      providerType: 'marzban',
      baseUrl: 'https://panel.example.test',
      credentials: { username: USERNAME, password: PASSWORD },
      idempotencyKey: key(),
    });
    return view.panel.id;
  };

  const test = (
    admin: SeededAdmin,
    scope: typeof tenantA,
    panelId: string,
    repository?: PanelRepository,
  ) =>
    service(repository).testConnection(scope, adminActorFor(admin), panelId, {
      idempotencyKey: key(),
    });

  /**
   * A gate that opens when `count` callers have arrived.
   *
   * Two requests reaching `claimProbe` at the same moment is the whole point,
   * and left to chance the first one finishes its statement before the second
   * starts — which is a sequential test wearing a `Promise.all`. The barrier is
   * around the REAL repository method: only the arrival is forced, the claim
   * itself is the production one against the production database.
   */
  function arriveAndWait(count: number): () => Promise<void> {
    let arrived = 0;
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    return async () => {
      arrived += 1;
      if (arrived >= count) open();
      await gate;
    };
  }

  /** The real repository, with every caller of `claimProbe` held at a barrier. */
  function racingRepository(barrier: () => Promise<void>): PanelRepository {
    const real = new DrizzlePanelRepository(ctx.container.database.db);
    return {
      ...real,
      list: real.list.bind(real),
      find: real.find.bind(real),
      create: real.create.bind(real),
      update: real.update.bind(real),
      setStatus: real.setStatus.bind(real),
      nameTaken: real.nameTaken.bind(real),
      recordHealth: real.recordHealth.bind(real),
      takeProbeBudget: real.takeProbeBudget.bind(real),
      claimProbe: async (...args: Parameters<PanelRepository['claimProbe']>) => {
        await barrier();
        return real.claimProbe(...args);
      },
    };
  }

  // -------------------------------------------------------------------------

  it('probes the provider the first time it is asked', async () => {
    const panelId = await panelFor(owner, tenantA, 'First');
    const result = await test(owner, tenantA, panelId);

    expect(probes).toBe(1);
    expect(result.probed).toBe(true);
    expect(result.view.health?.state).toBe('HEALTHY');
    expect(result.view.health?.providerVersion).toBe('1.2.3');
  });

  it('does not probe again immediately, and hands back the stored result', async () => {
    const panelId = await panelFor(owner, tenantA, 'Repeat');
    const first = await test(owner, tenantA, panelId);
    const second = await test(owner, tenantA, panelId);

    // One provider call for two requests. This is the finding.
    expect(probes).toBe(1);
    expect(second.probed).toBe(false);
    // The stored result of the probe that DID run, with its own timestamp —
    // the same thing any read of this panel returns, not a fresh answer.
    expect(second.view.health?.state).toBe('HEALTHY');
    expect(second.view.health?.checkedAt).toEqual(first.view.health?.checkedAt);
  });

  it('throttles one panel without touching another', async () => {
    const first = await panelFor(owner, tenantA, 'One');
    const second = await panelFor(owner, tenantA, 'Two');

    await test(owner, tenantA, first);
    await test(owner, tenantA, first);
    expect(probes).toBe(1);

    const other = await test(owner, tenantA, second);
    expect(probes).toBe(2);
    expect(other.probed).toBe(true);
  });

  it('keeps one tenant’s cooldown out of another tenant’s way', async () => {
    const inA = await panelFor(owner, tenantA, 'Shared name');
    const inB = await panelFor(ownerB, tenantB, 'Shared name');

    await test(owner, tenantA, inA);
    expect(probes).toBe(1);

    // Tenant B is unaffected by A's cooldown.
    expect((await test(ownerB, tenantB, inB)).probed).toBe(true);
    expect(probes).toBe(2);

    // And B cannot reach A's panel at all — not to probe it, and not to
    // consume or clear the claim that is throttling A.
    await expect(test(ownerB, tenantB, inA)).rejects.toMatchObject({
      code: 'panel.not_found',
    });
    expect(probes).toBe(2);
    const [claim] = await ctx.container.database.db
      .select()
      .from(panelProbeClaims)
      .where(eq(panelProbeClaims.panelId, inA));
    expect(claim?.tenantId).toBe(tenantA.tenantId);
  });

  it('lets exactly one of two simultaneous requests reach the provider', async () => {
    // Real concurrency, and the reason the claim is one statement in the
    // database rather than a read followed by a write: both requests are past
    // every check before either has finished probing.
    const panelId = await panelFor(owner, tenantA, 'Racing');
    const repository = racingRepository(arriveAndWait(2));

    const results = await Promise.all([
      test(owner, tenantA, panelId, repository).catch((error: unknown) => error),
      test(owner, tenantA, panelId, repository).catch((error: unknown) => error),
    ]);

    expect(probes).toBe(1);
    const probedFlags = results.map((result) =>
      result instanceof Error ? 'error' : (result as { probed: boolean }).probed,
    );
    expect(probedFlags.filter((flag) => flag === true)).toHaveLength(1);
    expect(probedFlags.filter((flag) => flag === false)).toHaveLength(1);
  });

  it('allows a new probe once the cooldown has passed', async () => {
    const panelId = await panelFor(owner, tenantA, 'Expiring');
    await test(owner, tenantA, panelId);
    expect((await test(owner, tenantA, panelId)).probed).toBe(false);

    clock.advance(COOLDOWN_MS + 1);
    const after = await test(owner, tenantA, panelId);
    expect(after.probed).toBe(true);
    expect(probes).toBe(2);
  });

  it('probes again immediately when the panel’s address changed', async () => {
    // The cooldown answers "did we just ask this question". A different address
    // is a different question, and an operator who has just fixed one needs the
    // answer now — never the previous answer replayed as if it still applied.
    const panelId = await panelFor(owner, tenantA, 'Moved');
    const first = await test(owner, tenantA, panelId);
    expect(probes).toBe(1);

    answer = async () => ({ ok: false, failure: 'UNREACHABLE', status: null });
    // Well inside the cooldown, so the only thing that can let the second probe
    // through is the address having changed.
    clock.advance(1_000);
    await service().update(tenantA, adminActorFor(owner), panelId, {
      baseUrl: 'https://moved.example.test',
      idempotencyKey: key(),
    });

    const second = await test(owner, tenantA, panelId);
    expect(probes).toBe(2);
    expect(second.probed).toBe(true);
    // And the health that comes back describes the NEW address, not the old
    // answer the cooldown could have replayed.
    expect(second.view.health?.state).toBe('UNREACHABLE');
    expect(second.view.health?.checkedAt).not.toEqual(first.view.health?.checkedAt);
  });

  it('probes again immediately when a credential was replaced', async () => {
    const panelId = await panelFor(owner, tenantA, 'Rotated');
    answer = async () => ({ ok: false, failure: 'AUTHENTICATION_FAILED', status: 401 });
    await test(owner, tenantA, panelId);
    expect(probes).toBe(1);

    answer = async () => ({ ok: true, degraded: false, providerVersion: '1.2.3' });
    // Time passes between an operator reading a failure and correcting it. It
    // has to here too: the configuration identity is built from the credential
    // set-at timestamps, so a rotation stamped at the same millisecond as the
    // one before it is indistinguishable from it — the same millisecond of
    // resolution the in-flight guard has carried since C10.
    clock.advance(1_000);
    await service().setCredentials(tenantA, adminActorFor(owner), panelId, {
      credentials: { password: 'a-corrected-password-value' },
      idempotencyKey: key(),
    });

    const after = await test(owner, tenantA, panelId);
    expect(probes).toBe(2);
    expect(after.probed).toBe(true);
    expect(after.view.health?.state).toBe('HEALTHY');
  });

  it('does not retry a rejected login on a loop', async () => {
    // The failure mode this exists for. A panel that answers 401 is a panel
    // whose provider account locks after a few more of them, and a rejected
    // login is exactly the result an operator retries.
    const panelId = await panelFor(owner, tenantA, 'Locked out');
    answer = async () => ({ ok: false, failure: 'AUTHENTICATION_FAILED', status: 401 });

    await test(owner, tenantA, panelId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const repeat = await test(owner, tenantA, panelId);
      expect(repeat.probed).toBe(false);
      expect(repeat.view.health?.state).toBe('AUTH_FAILED');
    }
    expect(probes).toBe(1);
  });

  it('carries no credential or session material in what it throttles with', async () => {
    const panelId = await panelFor(owner, tenantA, 'Opaque');
    await test(owner, tenantA, panelId);
    const throttled = await test(owner, tenantA, panelId);

    const [claim] = await ctx.container.database.db
      .select()
      .from(panelProbeClaims)
      .where(eq(panelProbeClaims.panelId, panelId));
    expect(claim).toBeDefined();

    // Nothing the throttle stores or returns may carry a credential. The
    // claim row is held to more than that: the base URL is not a secret and the
    // panel view carries it legitimately, but a claim row is a place to tell
    // one configuration from another, never a second copy of one.
    const row = JSON.stringify(claim);
    for (const value of [PASSWORD, USERNAME, 'panel.example.test']) {
      expect(row, `the claim row exposes ${value}`).not.toContain(value);
    }
    const response = JSON.stringify(throttled);
    for (const secret of [PASSWORD, USERNAME]) {
      expect(response, `the throttled response exposes ${secret}`).not.toContain(secret);
    }
    // A digest, and nothing else that could be read back.
    expect(claim?.configuration).toMatch(/^[0-9a-f]{64}$/);
  });
});
