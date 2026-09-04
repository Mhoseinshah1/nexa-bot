import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Clock, Instant, ProviderProbeOutcome, ProviderType } from '@nexa/contracts';
import {
  operationalEvents,
  panelProbeBudgets,
} from '../../apps/api/src/infrastructure/persistence/schema';
import { DrizzlePanelCredentialStore } from '../../apps/api/src/modules/platform/panels/infrastructure/drizzle-panel-credentials';
import { DrizzlePanelRepository } from '../../apps/api/src/modules/platform/panels/infrastructure/drizzle-panel.repository';
import { PanelService } from '../../apps/api/src/modules/platform/panels/application/panel.service';
import type { ProbeBudget } from '../../apps/api/src/modules/platform/panels/application/ports';
import { providerAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/adapter-registry';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import type { UrlPolicyOptions } from '../../apps/api/src/infrastructure/net/url-policy';
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
 * The tenant-wide bound on real outbound probes (Fix C).
 *
 * The per-panel cooldown is configuration-aware on purpose, which means
 * alternating two configurations retests on every change. This suite is about
 * the second bound — a token bucket per tenant, in the database — and above
 * all about how the two compose: a replay costs nothing, a refusal leaves no
 * claim behind, and nothing about configuration resets the bucket.
 *
 * Everything runs against the real repository and database; only the
 * provider's answer is scripted, and the count of how many times it was asked
 * is what most tests assert on.
 */

const PASSWORD = 'budget-suite-password-Q7';
const USERNAME = 'budget-suite-username-R2';

class StoppedClock implements Clock {
  constructor(private current: Date) {}
  now(): Instant {
    return this.current as Instant;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

const MINUTE = 60_000;

describe('the tenant-wide probe budget', () => {
  let ctx: TestContext;
  let owner: SeededAdmin;
  let ownerB: SeededAdmin;
  let support: SeededAdmin;
  let clock: StoppedClock;
  let probes: number;
  let answer: () => Promise<ProviderProbeOutcome>;

  beforeEach(async () => {
    ctx ??= await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
    await ctx.reset();
    owner = await createAdmin(ctx.container, tenantA, {
      username: 'owner_bud_a',
      roleKeys: ['owner'],
    });
    ownerB = await createAdmin(ctx.container, tenantB, {
      username: 'owner_bud_b',
      roleKeys: ['owner'],
    });
    support = await createAdmin(ctx.container, tenantA, {
      username: 'sup_bud_a',
      roleKeys: ['support'],
    });
    clock = new StoppedClock(new Date('2026-09-04T12:00:00.000Z'));
    probes = 0;
    answer = async () => ({ ok: true, degraded: false, providerVersion: '1.2.3' });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  let n = 0;
  const key = () => `budget-key-${(n += 1)}`;

  /** N tokens, refilling at N per window. */
  const bucket = (capacity: number, windowMs = 5 * MINUTE): ProbeBudget => ({
    capacity,
    refillPerMs: capacity / windowMs,
  });

  const service = (
    budget: ProbeBudget,
    context: TestContext = ctx,
    urlPolicy: UrlPolicyOptions = { allowLoopback: true },
    cooldownMs = 10_000,
  ) =>
    new PanelService({
      repository: new DrizzlePanelRepository(context.container.database.db),
      credentials: new DrizzlePanelCredentialStore(
        context.container.database.db,
        context.container.cipher,
      ),
      guard: context.container.guard,
      audit: context.container.audit,
      opsLog: context.container.opsLog,
      sessions: context.container.sessions,
      uow: context.container.uow,
      idempotency: context.container.idempotency,
      clock,
      ids: context.container.ids,
      http: new SafeHttpClient({
        allowLoopback: true,
        totalTimeoutMs: 1_000,
        maxResponseBytes: 1_024,
        maxRetries: 0,
      }),
      urlPolicy,
      probeCooldownMs: cooldownMs,
      probeBudget: budget,
      adapters: (type: ProviderType) => ({
        ...providerAdapter(type),
        probe: async () => {
          probes += 1;
          return answer();
        },
      }),
    });

  const panelFor = async (
    svc: PanelService,
    admin: SeededAdmin,
    scope: typeof tenantA,
    name: string,
    baseUrl = 'https://panel.example.test',
  ) => {
    const { view } = await svc.create(scope, adminActorFor(admin), {
      name,
      providerType: 'marzban',
      baseUrl,
      credentials: { username: USERNAME, password: PASSWORD },
      idempotencyKey: key(),
    });
    return view.panel.id;
  };

  const test = (svc: PanelService, admin: SeededAdmin, scope: typeof tenantA, panelId: string) =>
    svc.testConnection(scope, adminActorFor(admin), panelId, { idempotencyKey: key() });

  const attempt = (svc: PanelService, admin: SeededAdmin, scope: typeof tenantA, panelId: string) =>
    test(svc, admin, scope, panelId).then(
      (result) => ({ outcome: result.probed ? 'probed' : 'replayed', error: null }),
      (error: unknown) => ({
        outcome: 'error',
        error: error as { code?: string; details?: Record<string, unknown> },
      }),
    );

  const tokensOf = async (scope: typeof tenantA) =>
    (
      await ctx.container.database.db
        .select()
        .from(panelProbeBudgets)
        .where(eq(panelProbeBudgets.tenantId, scope.tenantId as never))
    )[0];

  const changeAddress = async (svc: PanelService, panelId: string, host: string) => {
    // Time passes between an operator's actions; the configuration identity
    // is a timestamp tuple, so let it.
    clock.advance(1_000);
    await svc.update(tenantA, adminActorFor(owner), panelId, {
      baseUrl: `https://${host}`,
      idempotencyKey: key(),
    });
  };

  // 1 ----------------------------------------------------------------------
  it('spends one token on the first eligible probe', async () => {
    const svc = service(bucket(3));
    const panelId = await panelFor(svc, owner, tenantA, 'First');
    const result = await test(svc, owner, tenantA, panelId);
    expect(result.probed).toBe(true);
    expect(probes).toBe(1);
    expect((await tokensOf(tenantA))?.tokens).toBeCloseTo(2, 6);
  });

  // 2 ----------------------------------------------------------------------
  it('spends nothing on a request the per-panel cooldown replays', async () => {
    const svc = service(bucket(3));
    const panelId = await panelFor(svc, owner, tenantA, 'Replayed');
    await test(svc, owner, tenantA, panelId);
    const replay = await test(svc, owner, tenantA, panelId);
    expect(replay.probed).toBe(false);
    expect(probes).toBe(1);
    // Still two: the cooldown stopped it before the budget was reached.
    expect((await tokensOf(tenantA))?.tokens).toBeCloseTo(2, 6);
  });

  // 3 ----------------------------------------------------------------------
  it('lets an address change bypass the cooldown, and charges it', async () => {
    const svc = service(bucket(3));
    const panelId = await panelFor(svc, owner, tenantA, 'Moved');
    await test(svc, owner, tenantA, panelId);
    await changeAddress(svc, panelId, 'moved.example.test');
    const again = await test(svc, owner, tenantA, panelId);
    expect(again.probed).toBe(true);
    expect(probes).toBe(2);
    // Two tokens spent; the second of clock that passed for the update refilled
    // its share of three per five minutes.
    expect((await tokensOf(tenantA))?.tokens).toBeCloseTo(1 + 3 * (1_000 / (5 * MINUTE)), 6);
  });

  // 4 ----------------------------------------------------------------------
  it('stops alternating configurations at the tenant bound, which they cannot reset', async () => {
    // The gap this exists for: A, B, A, B … each change is a fresh cooldown
    // claim, so without the bucket every one of them is a real outbound probe.
    const svc = service(bucket(4));
    const panelId = await panelFor(svc, owner, tenantA, 'Alternating', 'https://a.example.test');
    const outcomes: string[] = [];
    for (let round = 0; round < 8; round += 1) {
      if (round > 0) {
        await changeAddress(svc, panelId, round % 2 === 0 ? 'a.example.test' : 'b.example.test');
      }
      const result = await attempt(svc, owner, tenantA, panelId);
      outcomes.push(result.outcome === 'error' ? (result.error?.code ?? 'error') : result.outcome);
    }
    expect(probes).toBe(4);
    expect(outcomes.slice(0, 4)).toEqual(['probed', 'probed', 'probed', 'probed']);
    expect(outcomes.slice(4)).toEqual(Array(4).fill('panel.probe_limited'));
  });

  // 5 ----------------------------------------------------------------------
  it('is one capacity for every panel of the tenant', async () => {
    const svc = service(bucket(2));
    const one = await panelFor(svc, owner, tenantA, 'One');
    const two = await panelFor(svc, owner, tenantA, 'Two');
    const three = await panelFor(svc, owner, tenantA, 'Three');
    expect((await test(svc, owner, tenantA, one)).probed).toBe(true);
    expect((await test(svc, owner, tenantA, two)).probed).toBe(true);
    await expect(test(svc, owner, tenantA, three)).rejects.toMatchObject({
      code: 'panel.probe_limited',
    });
    expect(probes).toBe(2);
  });

  // 6 ----------------------------------------------------------------------
  it('is independent per tenant', async () => {
    const svc = service(bucket(1));
    const inA = await panelFor(svc, owner, tenantA, 'A one');
    const inA2 = await panelFor(svc, owner, tenantA, 'A two');
    const inB = await panelFor(svc, ownerB, tenantB, 'B one');
    expect((await test(svc, owner, tenantA, inA)).probed).toBe(true);
    await expect(test(svc, owner, tenantA, inA2)).rejects.toMatchObject({
      code: 'panel.probe_limited',
    });
    // Tenant B is untouched by A having spent its capacity.
    expect((await test(svc, ownerB, tenantB, inB)).probed).toBe(true);
    expect(probes).toBe(2);
    expect((await tokensOf(tenantA))?.tokens).toBeCloseTo(0, 6);
    expect((await tokensOf(tenantB))?.tokens).toBeCloseTo(0, 6);
  });

  // 7 + 8 ----------------------------------------------------------------
  it('never lets simultaneous eligible requests exceed the bound', async () => {
    const svc = service(bucket(5));
    const panels = await Promise.all(
      Array.from({ length: 12 }, (_, i) => panelFor(svc, owner, tenantA, `Burst ${i}`)),
    );
    const results = await Promise.all(panels.map((id) => attempt(svc, owner, tenantA, id)));
    const probed = results.filter((r) => r.outcome === 'probed').length;
    const limited = results.filter((r) => r.error?.code === 'panel.probe_limited').length;
    expect(probed).toBe(5);
    expect(limited).toBe(7);
    // Exactly the bound, and not one more call to the provider.
    expect(probes).toBe(5);
    for (const result of results) {
      if (result.error) {
        expect(Number(result.error.details?.retryAfterSeconds)).toBeGreaterThanOrEqual(1);
      }
    }
  });

  // 9–12 --------------------------------------------------------------------
  it('charges every real outbound attempt, whatever the provider answered', async () => {
    // A failing provider must not become an outbound storm: the token is spent
    // when the call is permitted, not when it succeeds.
    const svc = service(bucket(10));
    const outcomes: ProviderProbeOutcome[] = [
      { ok: false, failure: 'AUTHENTICATION_FAILED', status: 401 },
      { ok: false, failure: 'TIMEOUT', status: null },
      { ok: false, failure: 'TLS_FAILED', status: null },
      { ok: false, failure: 'MALFORMED_RESPONSE', status: 200 },
    ];
    let spent = 10;
    for (const [i, outcome] of outcomes.entries()) {
      const panelId = await panelFor(svc, owner, tenantA, `Failing ${i}`);
      answer = async () => outcome;
      const result = await test(svc, owner, tenantA, panelId);
      expect(result.probed).toBe(true);
      spent -= 1;
      expect((await tokensOf(tenantA))?.tokens).toBeCloseTo(spent, 6);
      // And the cooldown still replays the same failure for free.
      expect((await test(svc, owner, tenantA, panelId)).probed).toBe(false);
      expect((await tokensOf(tenantA))?.tokens).toBeCloseTo(spent, 6);
    }
    expect(probes).toBe(4);
  });

  // 13 ----------------------------------------------------------------------
  it('charges nothing for a request refused before it could go outbound', async () => {
    const svc = service(bucket(3));
    const panelId = await panelFor(svc, owner, tenantA, 'Refused');

    // A malformed id.
    await expect(test(svc, owner, tenantA, 'not-a-uuid')).rejects.toMatchObject({
      code: 'panel.request_invalid',
    });
    // No permission.
    await expect(test(svc, support, tenantA, panelId)).rejects.toMatchObject({
      code: 'platform.permission_denied',
    });
    // A target the policy refuses as written — the installation's own network
    // as a later policy sees it. Judged before any claim or charge.
    const strict = service(bucket(3), ctx, {
      allowLoopback: true,
      deniedHosts: ['panel.example.test'],
    });
    await expect(test(strict, owner, tenantA, panelId)).rejects.toMatchObject({
      code: 'panel.target_blocked',
    });

    expect(probes).toBe(0);
    expect(await tokensOf(tenantA)).toBeUndefined();
  });

  // 14 ----------------------------------------------------------------------
  it('refills continuously up to, and never above, the capacity', async () => {
    // Two tokens per minute: one every thirty seconds.
    const svc = service(bucket(2, MINUTE));
    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, i) => panelFor(svc, owner, tenantA, `Refill ${i}`)),
    );
    expect((await test(svc, owner, tenantA, ids[0]!)).probed).toBe(true);
    expect((await test(svc, owner, tenantA, ids[1]!)).probed).toBe(true);
    await expect(test(svc, owner, tenantA, ids[2]!)).rejects.toMatchObject({
      code: 'panel.probe_limited',
      details: { retryAfterSeconds: 30 },
    });

    clock.advance(29_000);
    await expect(test(svc, owner, tenantA, ids[2]!)).rejects.toMatchObject({
      code: 'panel.probe_limited',
      details: { retryAfterSeconds: 1 },
    });
    clock.advance(1_001);
    expect((await test(svc, owner, tenantA, ids[2]!)).probed).toBe(true);
    await expect(test(svc, owner, tenantA, ids[3]!)).rejects.toMatchObject({
      code: 'panel.probe_limited',
    });

    // A long idle period fills the bucket — to its capacity, no further.
    clock.advance(10 * MINUTE);
    expect((await test(svc, owner, tenantA, ids[3]!)).probed).toBe(true);
    expect((await test(svc, owner, tenantA, ids[4]!)).probed).toBe(true);
    await expect(test(svc, owner, tenantA, ids[5]!)).rejects.toMatchObject({
      code: 'panel.probe_limited',
    });
    expect(probes).toBe(5);
  });

  // 15 + 16 ------------------------------------------------------------------
  it('is not cleared by replacing an address or a credential', async () => {
    const svc = service(bucket(1));
    const panelId = await panelFor(svc, owner, tenantA, 'Persistent');
    expect((await test(svc, owner, tenantA, panelId)).probed).toBe(true);

    await changeAddress(svc, panelId, 'elsewhere.example.test');
    await expect(test(svc, owner, tenantA, panelId)).rejects.toMatchObject({
      code: 'panel.probe_limited',
    });

    clock.advance(1_000);
    await svc.setCredentials(tenantA, adminActorFor(owner), panelId, {
      credentials: { password: 'a-replacement-password-value' },
      idempotencyKey: key(),
    });
    await expect(test(svc, owner, tenantA, panelId)).rejects.toMatchObject({
      code: 'panel.probe_limited',
    });
    expect(probes).toBe(1);
  });

  // 17 ----------------------------------------------------------------------
  it('keeps nothing but a count and a time in the limiter, and reports nothing else', async () => {
    const svc = service(bucket(1));
    const panelId = await panelFor(svc, owner, tenantA, 'Opaque');
    await test(svc, owner, tenantA, panelId);
    const row = JSON.stringify(await tokensOf(tenantA));
    for (const value of [PASSWORD, USERNAME, 'panel.example.test', panelId]) {
      expect(row, `the limiter row carries ${value}`).not.toContain(value);
    }
    expect(Object.keys((await tokensOf(tenantA)) ?? {}).sort()).toEqual([
      'refilledAt',
      'tenantId',
      'tokens',
    ]);

    const refusal = await attempt(
      svc,
      owner,
      tenantA,
      await panelFor(svc, owner, tenantA, 'Second'),
    );
    const text = JSON.stringify(refusal.error);
    for (const value of [PASSWORD, USERNAME, 'panel.example.test', 'tokens', '172.', '10.']) {
      expect(text, `the refusal carries ${value}`).not.toContain(value);
    }
    expect(Object.keys(refusal.error?.details ?? {})).toEqual(['retryAfterSeconds']);
  });

  // 18 ----------------------------------------------------------------------
  it('holds across API processes that share only PostgreSQL', async () => {
    // A second container: its own pool, its own everything — as a second API
    // replica has. Requests alternate between the two, all at once.
    const other = await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
    try {
      const here = service(bucket(6));
      const there = service(bucket(6), other);
      const ids = await Promise.all(
        Array.from({ length: 14 }, (_, i) =>
          panelFor(i % 2 ? there : here, owner, tenantA, `Replica ${i}`),
        ),
      );
      const results = await Promise.all(
        ids.map((id, i) => attempt(i % 2 ? there : here, owner, tenantA, id)),
      );
      expect(results.filter((r) => r.outcome === 'probed')).toHaveLength(6);
      expect(results.filter((r) => r.error?.code === 'panel.probe_limited')).toHaveLength(8);
      expect(probes).toBe(6);
    } finally {
      await other.close();
    }
  });

  it('records one deduplicated operational event for a tenant being limited', async () => {
    const svc = service(bucket(1));
    await test(svc, owner, tenantA, await panelFor(svc, owner, tenantA, 'Loud'));
    for (let i = 0; i < 3; i += 1) {
      await attempt(svc, owner, tenantA, await panelFor(svc, owner, tenantA, `Louder ${i}`));
    }
    const rows = await ctx.container.database.db
      .select()
      .from(operationalEvents)
      .where(eq(operationalEvents.code, 'panel.probe.limited'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurrenceCount).toBe(3);
    expect(JSON.stringify(rows[0])).not.toContain('panel.example.test');
  });
});
