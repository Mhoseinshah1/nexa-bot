import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type {
  IdempotencyRecord,
  IdempotencyStore,
  ProviderProbeOutcome,
  ProviderType,
} from '@nexa/contracts';
import { auditLogs, panels } from '../../apps/api/src/infrastructure/persistence/schema';
import { DrizzlePanelCredentialStore } from '../../apps/api/src/modules/platform/panels/infrastructure/drizzle-panel-credentials';
import { DrizzlePanelRepository } from '../../apps/api/src/modules/platform/panels/infrastructure/drizzle-panel.repository';
import { PanelService } from '../../apps/api/src/modules/platform/panels/application/panel.service';
import { providerAdapter } from '../../apps/api/src/modules/platform/providers/infrastructure/adapter-registry';
import { SafeHttpClient } from '../../apps/api/src/infrastructure/net/safe-http';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type SeededAdmin,
  type TestContext,
} from './harness';

/**
 * The panel service under REAL concurrency.
 *
 * Everything here needs two requests genuinely in flight at once. The existing
 * panel suite runs one operation at a time, which is why three of the review's
 * findings lived underneath it: a sequential test cannot see a lost idempotency
 * race, a pool that deadlocks only when every connection is held, or a probe
 * whose panel changed while it was waiting on the network.
 */

const PASSWORD_A = 'winner-password-value-A1';
const PASSWORD_B = 'loser-password-value-B2';

describe('panel service under concurrency', () => {
  let ctx: TestContext;
  let owner: SeededAdmin;

  beforeEach(async () => {
    // A pool of TWO. Enough for a transaction plus one more, so a mutation
    // that takes a second connection while holding one exhausts it — which is
    // the deadlock C2 describes, reproduced rather than reasoned about.
    ctx ??= await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true', DATABASE_POOL_MAX: '2' });
    await ctx.reset();
    owner = await createAdmin(ctx.container, tenantA, { username: 'owner_c', roleKeys: ['owner'] });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  let n = 0;
  const key = () => `conc-key-${(n += 1)}`;

  const create = (overrides: Record<string, unknown> = {}) =>
    ctx.container.panels.create(tenantA, adminActorFor(owner), {
      name: `Panel ${(n += 1)}`,
      providerType: 'marzban',
      baseUrl: 'https://panel.example.test',
      idempotencyKey: key(),
      ...overrides,
    });

  const readCredentials = (panelId: string) =>
    new DrizzlePanelCredentialStore(ctx.container.database.db, ctx.container.cipher).read(
      tenantA,
      panelId,
    );

  // -------------------------------------------------------------------------
  // C3 — the losing half of an idempotency race must not commit
  // -------------------------------------------------------------------------

  it('commits only the winner when two rotations share an idempotency key', async () => {
    const { view } = await create({ credentials: { username: 'u', password: 'original' } });
    const shared = key();
    const actor = adminActorFor(owner);

    // A barrier on `find`, so both requests are past the lookup before either
    // commits. Without it the second simply reads the first's stored record
    // and replays — correct, but not the race, and the window is too narrow to
    // hit by repetition. The store underneath is the real one; only the
    // interleaving is forced, which is the point of a concurrency test.
    const barrier = arriveAndWait(2);
    const racing = () =>
      scriptedService(async () => ({ ok: true, degraded: false, providerVersion: 'x' }), {
        remember: (scope, ns, k, hash, result, tx) =>
          ctx.container.idempotency.remember(scope, ns, k, hash, result, tx),
        find: async <T>(
          scope: Parameters<IdempotencyStore['find']>[0],
          ns: Parameters<IdempotencyStore['find']>[1],
          k: string,
          hash: string,
        ): Promise<IdempotencyRecord<T> | null> => {
          const found = await ctx.container.idempotency.find<T>(scope, ns, k, hash);
          await barrier();
          return found;
        },
      });

    // Same key, DIFFERENT passwords. Credential values are deliberately
    // excluded from the request hash — hashing a secret would put a value
    // derived from it in the idempotency table — so both look identical to
    // `find`, both do the work, and they meet at the insert.
    const settled = await Promise.allSettled([
      racing().setCredentials(tenantA, actor, view.panel.id, {
        credentials: { password: PASSWORD_A },
        idempotencyKey: shared,
      }),
      racing().setCredentials(tenantA, actor, view.panel.id, {
        credentials: { password: PASSWORD_B },
        idempotencyKey: shared,
      }),
    ]);

    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');
    if (fulfilled.length !== 1) {
      console.log(
        'RACE OUTCOME',
        settled.map((r) =>
          r.status === 'rejected'
            ? `rejected: ${(r.reason as { code?: string }).code ?? String(r.reason)}`
            : 'fulfilled',
        ),
      );
    }

    // Exactly one. Before the fix both committed, and the stored password was
    // whichever transaction wrote last — not necessarily the one whose success
    // the client was told about.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'platform.idempotency_in_flight',
    });

    // One secret, one SUCCESS audit row, and the two agree.
    const stored = await readCredentials(view.panel.id);
    expect([PASSWORD_A, PASSWORD_B]).toContain(stored?.password);

    const replacements = await ctx.container.database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'panel.credentials.replace'));
    expect(replacements.filter((row) => row.result === 'SUCCESS')).toHaveLength(1);
  }, 30_000);

  it('commits one panel when two creates share an idempotency key', async () => {
    const shared = key();
    const actor = adminActorFor(owner);
    const command = {
      name: 'Contested',
      providerType: 'marzban' as const,
      baseUrl: 'https://panel.example.test',
      idempotencyKey: shared,
    };

    const results = await Promise.allSettled([
      ctx.container.panels.create(tenantA, actor, command),
      ctx.container.panels.create(tenantA, actor, command),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await ctx.container.database.db.select().from(panels)).toHaveLength(1);
  });

  it('still replays a SEQUENTIAL repeat rather than refusing it', async () => {
    // The control for the two above: `rememberOnce` must not turn an ordinary
    // retry into a conflict. A client that retries after the first completed
    // gets the stored result, which is the whole point of the key.
    const { view } = await create({ credentials: { password: 'original' } });
    const shared = key();
    const actor = adminActorFor(owner);

    await ctx.container.panels.setCredentials(tenantA, actor, view.panel.id, {
      credentials: { password: PASSWORD_A },
      idempotencyKey: shared,
    });
    const replay = await ctx.container.panels.setCredentials(tenantA, actor, view.panel.id, {
      credentials: { password: PASSWORD_A },
      idempotencyKey: shared,
    });

    expect(replay.panel.id).toBe(view.panel.id);
    expect((await readCredentials(view.panel.id))?.password).toBe(PASSWORD_A);
  });

  it('still refuses a replay whose permission was revoked', async () => {
    // The other control: authorization is still checked BEFORE the replay
    // path, which `rememberOnce` must not have moved.
    const technical = await createAdmin(ctx.container, tenantA, {
      username: 'tech_c',
      roleKeys: ['technical'],
    });
    const shared = key();
    const command = {
      name: 'Revocable',
      providerType: 'marzban' as const,
      baseUrl: 'https://panel.example.test',
      idempotencyKey: shared,
    };
    await ctx.container.panels.create(tenantA, adminActorFor(technical), command);
    await ctx.container.roles.setAdminRoles(tenantA, technical.id, [], null);

    await expect(
      ctx.container.panels.create(tenantA, adminActorFor(technical), command),
    ).rejects.toMatchObject({ code: 'platform.permission_denied' });
  });

  // -------------------------------------------------------------------------
  // C2 — a mutation must not need a second connection while holding one
  // -------------------------------------------------------------------------

  it('runs more concurrent mutations than the pool has connections', async () => {
    // Pool of two, four concurrent mutations. Each takes a transaction
    // connection; before the fix each ALSO asked the pool for a second one to
    // read the panel, so every connection was held by a transaction waiting
    // for a connection that would never come. The suite hung until the
    // idle-transaction timeout, which is what production would do too.
    const panelIds = await Promise.all(
      [1, 2, 3, 4].map(async (i) => (await create({ name: `Pooled ${i}` })).view.panel.id),
    );
    const actor = adminActorFor(owner);

    const renames = await Promise.all(
      panelIds.map((id, i) =>
        ctx.container.panels.update(tenantA, actor, id, {
          name: `Renamed ${i}`,
          idempotencyKey: key(),
        }),
      ),
    );

    expect(renames.map((view) => view.panel.name).sort()).toEqual([
      'Renamed 0',
      'Renamed 1',
      'Renamed 2',
      'Renamed 3',
    ]);
  }, 30_000);

  // -------------------------------------------------------------------------
  // C10 — a probe cannot commit against a configuration it did not test
  // -------------------------------------------------------------------------

  it('refuses a probe result whose panel changed while it was in flight', async () => {
    const { view } = await create({ credentials: { username: 'u', password: 'original' } });
    const actor = adminActorFor(owner);
    const panelId = view.panel.id;

    // The probe blocks until the test releases it, so the rotation below lands
    // in the middle of the network call rather than before or after it.
    const started = deferred<void>();
    const release = deferred<void>();

    const scripted = scriptedService(async () => {
      started.resolve();
      await release.promise;
      // A SUCCESS from the OLD credentials. Storing it would mark the
      // replacement healthy on the strength of a login it never made.
      return { ok: true, degraded: false, providerVersion: '0.8.4' };
    });

    const inFlight = scripted.testConnection(tenantA, actor, panelId, { idempotencyKey: key() });
    await started.promise;

    // Config A -> config B, while the probe is blocked.
    await ctx.container.panels.setCredentials(tenantA, actor, panelId, {
      credentials: { password: 'the-replacement-password' },
      idempotencyKey: key(),
    });

    release.resolve();

    await expect(inFlight).rejects.toMatchObject({ code: 'panel.configuration_changed' });

    // Health was never written, so nothing claims the new credentials work.
    const after = await ctx.container.panels.get(tenantA, actor, panelId);
    expect(after.health).toBeNull();
  }, 30_000);

  it('stores a probe result when the panel did NOT change', async () => {
    // The control. The guard must refuse a stale result and nothing else — a
    // version that refused every probe would pass the test above.
    const { view } = await create({ credentials: { username: 'u', password: 'original' } });
    const actor = adminActorFor(owner);

    const scripted = scriptedService(async () => ({
      ok: true,
      degraded: false,
      providerVersion: '0.8.4',
    }));

    const result = await scripted.testConnection(tenantA, actor, view.panel.id, {
      idempotencyKey: key(),
    });
    expect(result.probed).toBe(true);
    expect(result.view.health?.state).toBe('HEALTHY');
  });

  /** A promise whose settlement the test controls. */
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  /**
   * The real service over the container's own collaborators, with one scripted
   * probe. Everything else — repository, credential store, guard, audit, unit
   * of work — is production code, so what the probe returns is the only thing
   * this test controls.
   */
  /** Releases every caller once `count` of them have arrived. */
  function arriveAndWait(count: number): () => Promise<void> {
    let arrived = 0;
    const open = deferred<void>();
    return async () => {
      arrived += 1;
      if (arrived >= count) open.resolve();
      await open.promise;
    };
  }

  function scriptedService(
    probe: () => Promise<ProviderProbeOutcome>,
    idempotency: IdempotencyStore = ctx.container.idempotency,
  ): PanelService {
    return new PanelService({
      repository: new DrizzlePanelRepository(ctx.container.database.db),
      credentials: new DrizzlePanelCredentialStore(ctx.container.database.db, ctx.container.cipher),
      guard: ctx.container.guard,
      audit: ctx.container.audit,
      opsLog: ctx.container.opsLog,
      sessions: ctx.container.sessions,
      uow: ctx.container.uow,
      idempotency,
      clock: ctx.container.clock,
      ids: ctx.container.ids,
      http: new SafeHttpClient({
        allowLoopback: true,
        totalTimeoutMs: 5_000,
        maxResponseBytes: 1024,
        maxRetries: 0,
      }),
      urlPolicy: { allowLoopback: true },
      adapters: (type: ProviderType) => ({ ...providerAdapter(type), probe }),
    });
  }
});
