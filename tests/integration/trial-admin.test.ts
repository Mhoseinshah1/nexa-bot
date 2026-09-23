import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  isNexaError,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  validatePanelConnection,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * WP6-B: ADR-0015's per-customer override, its global reset and the operator's view.
 * `docs/wp6-audit.md` §7 is the design; `docs/wp6-falsification.md` TA-01.. names the
 * rule each case holds and the mutation that proved it does.
 *
 * Through the shipped container: `TrialAdminService` for the operator, `TrialService`
 * for the customer — the same allowance evaluator on both sides — against real
 * PostgreSQL. The panel is a fake RickPanel only because a trial product needs a panel
 * that passed a connection test; a claim itself never dials it.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('trial overrides and the global reset', () => {
  let ctx: TestContext;
  let panel: FakeRickpanel;
  let owner: ActorContext;
  let operator: ActorContext;
  let observer: ActorContext;
  let alice: UserId;
  let bob: UserId;

  beforeAll(async () => {
    ctx = await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-ta', roleKeys: ['owner'] }),
    );
    operator = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'op-ta', roleKeys: ['operator'] }),
    );
    observer = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'obs-ta', roleKeys: ['observer'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Rick',
      providerType: 'rickpanel',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: {},
      idempotencyKey: 'panel-trial-admin',
    });
    const panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);

    const products = new DrizzleProductRepository(ctx.container.database.db);
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'تست',
        description: null,
        audience: 'HIDDEN',
        sortOrder: 90,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 1, trafficBytes: 1_073_741_824n, deviceLimit: null },
        price: null,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());

    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'trials',
      enabled: true,
      expectedVersion: null,
      // TENANT_WIDE: the flag names itself and says why (ADR-0010).
      confirmKey: 'trials',
      reason: 'offer a trial',
      idempotencyKey: randomUUID(),
    });
    await setSetting('trial.product_id', product.id);

    alice = await customer(tenantA, '960001', BOT_A);
    bob = await customer(tenantA, '960002', BOT_A);
  });

  async function customer(
    scope: TenantContext,
    telegramId: string,
    bot: BotInstanceId,
  ): Promise<UserId> {
    const resolved = await ctx.container.customers.resolveFromUpdate(
      scope,
      systemActor(`r-${telegramId}`),
      {
        idempotencyKey: `resolve-${telegramId}`,
        telegramUserId: telegramId,
        from: { id: Number(telegramId), first_name: 'سارا' },
        botInstanceId: bot,
      },
    );
    return resolved.customer.id;
  }

  async function setSetting(key: string, value: unknown): Promise<void> {
    let version: number | null;
    try {
      version = (await ctx.container.settingsService.get(tenantA, owner, key)).version;
    } catch {
      version = null;
    }
    await ctx.container.settingsService.set(tenantA, owner, {
      key,
      value,
      expectedVersion: version,
      idempotencyKey: randomUUID(),
    });
  }

  const claim = (who: UserId, key: string) =>
    ctx.container.trials.claim(tenantA, systemActor(key), who, { idempotencyKey: key });

  const setOverride = (who: UserId, limit: number, actor: ActorContext = operator, key?: string) =>
    ctx.container.trialAdmin.setOverride(tenantA, actor, {
      idempotencyKey: key ?? randomUUID(),
      customerId: who,
      limit,
      reason: null,
    });

  const count = async (query: ReturnType<typeof sql>): Promise<number> => {
    const rows = (await ctx.container.database.db.execute(query as never)) as unknown as {
      rows: { n: number }[];
    };
    return rows.rows[0]?.n ?? 0;
  };

  async function refusal(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      if (isNexaError(error)) return error.code;
      throw error;
    }
    throw new Error('expected a refusal, and the call succeeded');
  }

  /** Waits until `expected` transactions are blocked on a row lock — the barrier. */
  async function awaitBlocked(expected: number, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const n = await count(
        sql`SELECT count(*)::int AS n FROM pg_locks
             WHERE NOT granted AND locktype IN ('tuple', 'transactionid')`,
      );
      if (n >= expected) return;
      if (Date.now() > deadline) throw new Error(`${what} never blocked.`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** The set a reset would stamp now, as the preview states it. */
  const fingerprint = async (): Promise<string> =>
    (await ctx.container.trialAdmin.previewReset(tenantA, owner)).fingerprint;
  /** A well-formed fingerprint of no set, for cases refused before any set is compared. */
  const NO_SET = '0'.repeat(32);

  /** Holds a row lock in an outside transaction until `release` is called. */
  async function hold(statement: ReturnType<typeof sql>): Promise<{
    release: () => void;
    done: Promise<void>;
  }> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const done = ctx.container.database.db.transaction(async (tx) => {
      await tx.execute(statement as never);
      locked();
      await gate;
    });
    await holding;
    return { release, done };
  }

  it('lets an override raise one customer above the default, and the claim obeys it', async () => {
    await setOverride(alice, 3);
    for (const key of ['a-1', 'a-2', 'a-3']) {
      expect((await claim(alice, key)).outcome).toBe('ISSUED');
    }
    expect(await claim(alice, 'a-4')).toEqual({ outcome: 'REFUSED', reason: 'LIMIT_REACHED' });
    // Bob has no override and keeps the default of one.
    expect((await claim(bob, 'b-1')).outcome).toBe('ISSUED');
    expect(await claim(bob, 'b-2')).toEqual({ outcome: 'REFUSED', reason: 'LIMIT_REACHED' });

    const view = await ctx.container.trialAdmin.allowance(tenantA, observer, alice);
    expect(view).toMatchObject({
      featureEnabled: true,
      globalLimit: 1,
      override: { limit: 3 },
      effectiveLimit: 3,
      used: 3,
      remaining: 0,
    });
  });

  it('treats an override of zero as zero trials, never as unlimited', async () => {
    await setOverride(alice, 0);
    expect(await claim(alice, 'z-1')).toEqual({ outcome: 'REFUSED', reason: 'LIMIT_REACHED' });
    expect(await ctx.container.trials.availabilityFor(tenantA, systemActor('z'), alice)).toEqual({
      available: false,
      reason: 'LIMIT_REACHED',
    });
    expect(await ctx.container.trialAdmin.allowance(tenantA, operator, alice)).toMatchObject({
      globalLimit: 1,
      override: { limit: 0 },
      effectiveLimit: 0,
      remaining: 0,
    });
  });

  it('removes an override rather than copying the default, so a later default applies', async () => {
    await setOverride(alice, 5);
    const removed = await ctx.container.trialAdmin.removeOverride(tenantA, operator, {
      idempotencyKey: randomUUID(),
      customerId: alice,
      reason: 'back to normal',
    });
    expect(removed).toMatchObject({ override: null, effectiveLimit: 1 });
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_limit_overrides`)).toBe(0);

    // The default moves, and Alice moves with it — she holds no copy of the old one.
    await setSetting('trial.limit_per_customer', 2);
    expect(await ctx.container.trialAdmin.allowance(tenantA, operator, alice)).toMatchObject({
      override: null,
      globalLimit: 2,
      effectiveLimit: 2,
    });
    expect((await claim(alice, 'r-1')).outcome).toBe('ISSUED');
    expect((await claim(alice, 'r-2')).outcome).toBe('ISSUED');
  });

  it('resets consumption for everyone and leaves custom limits alone (ADR-0015)', async () => {
    // ADR-0015's own example: custom limit 5, used 3 → custom limit 5, used 0.
    await setOverride(alice, 5);
    for (const key of ['e-1', 'e-2', 'e-3']) await claim(alice, key);
    await claim(bob, 'e-b');

    const preview = await ctx.container.trialAdmin.previewReset(tenantA, owner);
    expect(preview.affectedGrants).toBe(4);
    expect(preview.affectedCustomers).toBe(2);
    expect(preview.sample.map((row) => [row.customer.id, row.grants])).toEqual([
      [alice, 3],
      [bob, 1],
    ]);
    // A dry run writes nothing.
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_resets`)).toBe(0);

    const reset = await ctx.container.trialAdmin.executeReset(tenantA, owner, {
      idempotencyKey: 'reset-1',
      expectedGrants: 4,
      expectedFingerprint: preview.fingerprint,
      reason: 'new season',
    });
    expect(reset).toMatchObject({
      actorAdminId: owner.id,
      reason: 'new season',
      affectedGrants: 4,
      affectedCustomers: 2,
    });

    expect(await ctx.container.trialAdmin.allowance(tenantA, owner, alice)).toMatchObject({
      override: { limit: 5 },
      used: 0,
      remaining: 5,
    });
    expect(await ctx.container.trialAdmin.allowance(tenantA, owner, bob)).toMatchObject({
      override: null,
      used: 0,
      remaining: 1,
    });
    // Every grant carries the reset that covered it, and nothing else does.
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM trial_grants WHERE reset_id = ${reset.id} AND reset_at IS NOT NULL`,
      ),
    ).toBe(4);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM audit_logs
             WHERE action = 'trial.reset' AND result = 'SUCCESS' AND reason = 'new season'`,
      ),
    ).toBe(1);
    // The list of custom limits counts by the same rule as the card.
    const listed = await ctx.container.trialAdmin.listOverrides(tenantA, observer, {
      limit: 10,
      cursor: null,
    });
    expect(listed.items.map((row) => [row.customer.id, row.limit, row.used])).toEqual([
      [alice, 5, 0],
    ]);
    // Bob may take a trial again; the history lists the reset.
    expect((await claim(bob, 'e-b-2')).outcome).toBe('ISSUED');
    const history = await ctx.container.trialAdmin.listResets(tenantA, observer, {
      limit: 10,
      cursor: null,
    });
    expect(history.items.map((row) => row.id)).toEqual([reset.id]);
  });

  it('refuses a reset whose preview is stale, and writes nothing', async () => {
    await claim(alice, 's-1');
    const preview = await ctx.container.trialAdmin.previewReset(tenantA, owner);
    expect(preview.affectedGrants).toBe(1);
    await claim(bob, 's-2');

    expect(
      await refusal(
        ctx.container.trialAdmin.executeReset(tenantA, owner, {
          idempotencyKey: 'stale-1',
          expectedGrants: preview.affectedGrants,
          expectedFingerprint: preview.fingerprint,
          reason: 'confirmed against an old count',
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.TRIAL_RESET_STALE);
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_resets`)).toBe(0);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM trial_grants WHERE reset_at IS NOT NULL`),
    ).toBe(0);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'trial.reset' AND result = 'SUCCESS'`,
      ),
    ).toBe(0);
  });

  it('refuses a reset with nothing to reset rather than recording an empty one', async () => {
    expect(
      await refusal(
        ctx.container.trialAdmin.executeReset(tenantA, owner, {
          idempotencyKey: 'empty-1',
          expectedGrants: 1,
          expectedFingerprint: NO_SET,
          reason: 'nothing here',
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.TRIAL_RESET_NOTHING);
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_resets`)).toBe(0);
  });

  it('does not count a grant twice when a reset waits on its release', async () => {
    /*
     * The barrier is the grant row. An outside transaction RELEASES Alice's grant and
     * holds it uncommitted; the reset is started and PROVEN to be waiting on that row
     * before the release commits. Re-evaluated against the committed row, the reset
     * must skip the released grant — so it stamps one, not two, and the preview of two
     * is stale.
     */
    const first = await claim(alice, 'w-1');
    await claim(bob, 'w-2');
    if (first.outcome !== 'ISSUED') throw new Error('setup');
    const previewed = await fingerprint();
    const { release, done } = await hold(
      sql`UPDATE trial_grants SET released_at = now() WHERE order_id = ${first.orderId}`,
    );
    const reset = ctx.container.trialAdmin.executeReset(tenantA, owner, {
      idempotencyKey: 'wait-1',
      expectedGrants: 2,
      expectedFingerprint: previewed,
      reason: 'races a release',
    });
    await awaitBlocked(1, 'the reset');
    release();
    await done;

    expect(await refusal(reset)).toBe(COMMERCE_ERROR_CODES.TRIAL_RESET_STALE);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM trial_grants WHERE reset_at IS NOT NULL`),
    ).toBe(0);
    // Preview again, and the reset that describes the world as it is goes through.
    const again = await ctx.container.trialAdmin.previewReset(tenantA, owner);
    expect(again.affectedGrants).toBe(1);
    const done2 = await ctx.container.trialAdmin.executeReset(tenantA, owner, {
      idempotencyKey: 'wait-2',
      expectedGrants: 1,
      expectedFingerprint: again.fingerprint,
      reason: 'again',
    });
    expect(done2).toMatchObject({ affectedGrants: 1, affectedCustomers: 1 });
    expect(await ctx.container.trialAdmin.allowance(tenantA, owner, alice)).toMatchObject({
      used: 0,
    });
  });

  it('records one reset when two operators confirm the same preview at once', async () => {
    /*
     * Two confirmations of one preview, under different keys, so idempotency does not
     * separate them — only the conditional stamp can. The barrier is a grant row held
     * by an outside transaction; BOTH resets are proven to be waiting before it is
     * released. Whichever goes first stamps both grants; the other re-evaluates its
     * `WHERE` against the committed stamps, stamps nothing, and records nothing.
     */
    const first = await claim(alice, 'r2-1');
    await claim(bob, 'r2-2');
    if (first.outcome !== 'ISSUED') throw new Error('setup');
    const previewed = await fingerprint();
    const { release, done } = await hold(
      sql`SELECT id FROM trial_grants WHERE order_id = ${first.orderId} FOR NO KEY UPDATE`,
    );
    const confirm = (key: string) =>
      ctx.container.trialAdmin
        .executeReset(tenantA, owner, {
          idempotencyKey: key,
          expectedGrants: 2,
          expectedFingerprint: previewed,
          reason: key,
        })
        .then(
          (reset) => ({ reset }),
          (error: unknown) => ({ error }),
        );
    const both = Promise.all([confirm('twice-a'), confirm('twice-b')]);
    await awaitBlocked(2, 'both resets');
    release();
    await done;
    const outcomes = await both;

    const won = outcomes.flatMap((o) => ('reset' in o ? [o.reset] : []));
    const lost = outcomes.flatMap((o) => ('error' in o ? [o.error] : []));
    expect(won).toHaveLength(1);
    expect(won[0]).toMatchObject({ affectedGrants: 2, affectedCustomers: 2 });
    expect(lost).toHaveLength(1);
    expect(await refusal(Promise.reject(lost[0]))).toBe(COMMERCE_ERROR_CODES.TRIAL_RESET_NOTHING);
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_resets`)).toBe(1);
    // Every grant names the one reset that covered it.
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM trial_grants WHERE reset_id = ${won[0]?.id ?? null}`,
      ),
    ).toBe(2);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'trial.reset' AND result = 'SUCCESS'`,
      ),
    ).toBe(1);
  });

  it('refuses a reset whose previewed set changed although its size did not', async () => {
    /*
     * Codex, PR #65. Alice and Bob are previewed; Alice's grant is then given back and a
     * third customer takes a trial. Two grants still count, so a count-only confirmation
     * matched — and reset Carol's grant, which the operator never saw.
     */
    const first = await claim(alice, 'set-1');
    await claim(bob, 'set-2');
    if (first.outcome !== 'ISSUED') throw new Error('setup');
    const preview = await ctx.container.trialAdmin.previewReset(tenantA, owner);
    expect(preview.affectedGrants).toBe(2);

    await ctx.container.database.db.execute(
      sql`UPDATE trial_grants SET released_at = now() WHERE order_id = ${first.orderId}`,
    );
    const carol = await customer(tenantA, '960003', BOT_A);
    expect((await claim(carol, 'set-3')).outcome).toBe('ISSUED');
    expect((await ctx.container.trialAdmin.previewReset(tenantA, owner)).affectedGrants).toBe(2);

    expect(
      await refusal(
        ctx.container.trialAdmin.executeReset(tenantA, owner, {
          idempotencyKey: 'set-reset',
          expectedGrants: preview.affectedGrants,
          expectedFingerprint: preview.fingerprint,
          reason: 'confirmed against a different set',
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.TRIAL_RESET_STALE);
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_resets`)).toBe(0);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM trial_grants WHERE reset_at IS NOT NULL`),
    ).toBe(0);
  });

  it('answers a concurrent retry of the same command with the reset it recorded', async () => {
    /*
     * Codex, PR #65. ONE command sent twice at once — the same key, the same body. Both
     * miss the replay read; the barrier holds a grant row, and BOTH are proven waiting
     * before it is released. The first stamps and remembers its key; the second then
     * stamps nothing and used to be refused as NOTHING, telling the operator nothing was
     * reset when their command had succeeded.
     */
    const first = await claim(alice, 'same-1');
    await claim(bob, 'same-2');
    if (first.outcome !== 'ISSUED') throw new Error('setup');
    const input = {
      idempotencyKey: 'same-key',
      expectedGrants: 2,
      expectedFingerprint: await fingerprint(),
      reason: 'sent twice',
    };
    const { release, done } = await hold(
      sql`SELECT id FROM trial_grants WHERE order_id = ${first.orderId} FOR NO KEY UPDATE`,
    );
    const both = Promise.all([
      ctx.container.trialAdmin.executeReset(tenantA, owner, input),
      ctx.container.trialAdmin.executeReset(tenantA, owner, input),
    ]);
    await awaitBlocked(2, 'both copies of the reset');
    release();
    await done;
    const [a, b] = await both;

    expect(a.id).toBe(b.id);
    expect(a).toMatchObject({ affectedGrants: 2, affectedCustomers: 2 });
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_resets`)).toBe(1);
  });

  it('does not show customers to a role that may reset but may not view them', async () => {
    /*
     * Codex, PR #65. The preview's sample names customers, which the catalogue gates
     * behind `users.view`; `settings.destructive` does not require it. A custom role
     * holding the one and not the other is refused the preview.
     */
    const roleId = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO roles (id, tenant_id, key, name, is_system)
      VALUES (${roleId}, ${tenantA.tenantId}, 'reset_only', 'reset_only', false)`);
    for (const permission of ['settings.view', 'settings.destructive']) {
      await ctx.container.database.db.execute(sql`
        INSERT INTO role_permissions (tenant_id, role_id, permission_key)
        VALUES (${tenantA.tenantId}, ${roleId}, ${permission})`);
    }
    const admin = await createAdmin(ctx.container, tenantA, { username: 'reset-only' });
    await ctx.container.database.db.execute(sql`
      INSERT INTO admin_roles (tenant_id, admin_id, role_id)
      VALUES (${tenantA.tenantId}, ${admin.id}, ${roleId})`);
    await claim(alice, 'view-1');

    expect(
      await refusal(ctx.container.trialAdmin.previewReset(tenantA, adminActorFor(admin))),
    ).toBe(PLATFORM_ERROR_CODES.PERMISSION_DENIED);
    // The owner, who holds both, is shown the customer.
    expect(
      (await ctx.container.trialAdmin.previewReset(tenantA, owner)).sample.map(
        (row) => row.customer.id,
      ),
    ).toEqual([alice]);
  });

  it('answers a replayed reset with the reset it recorded, once', async () => {
    await claim(alice, 'p-1');
    const input = {
      idempotencyKey: 'replay-1',
      expectedGrants: 1,
      expectedFingerprint: await fingerprint(),
      reason: 'once',
    };
    const first = await ctx.container.trialAdmin.executeReset(tenantA, owner, input);
    const second = await ctx.container.trialAdmin.executeReset(tenantA, owner, input);
    expect(second).toEqual(first);
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_resets`)).toBe(1);
    expect(
      await refusal(
        ctx.container.trialAdmin.executeReset(tenantA, owner, { ...input, reason: 'different' }),
      ),
    ).toBe(PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH);
  });

  it('takes the customer lock, so an override never lands inside a claim', async () => {
    /*
     * FOR NO KEY UPDATE, not FOR UPDATE, and the difference is the test. The override's
     * insert checks its foreign key to `customers` with a KEY SHARE lock, which a FOR
     * UPDATE holder would also block — so a version that dropped the customer lock
     * still waited here and the first draft of this case stayed green under that
     * mutation (TB-05). NO KEY UPDATE conflicts with the FOR UPDATE that
     * `lockCustomer` takes and not with KEY SHARE, so only the real lock waits.
     */
    const { release, done } = await hold(
      sql`SELECT id FROM customers WHERE id = ${alice} FOR NO KEY UPDATE`,
    );
    let settled = false;
    const write = setOverride(alice, 4).then((result) => {
      settled = true;
      return result;
    });
    await awaitBlocked(1, 'the override');
    expect(settled).toBe(false);
    release();
    await done;
    expect((await write).effectiveLimit).toBe(4);
  });

  it('is idempotent by key, and audits the stored value before and after', async () => {
    await setOverride(alice, 2, operator, 'ov-1');
    await setOverride(alice, 2, operator, 'ov-1');
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'trial.override.set' AND result = 'SUCCESS'`,
      ),
    ).toBe(1);
    expect(await refusal(setOverride(alice, 3, operator, 'ov-1'))).toBe(
      PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
    );
    await setOverride(alice, 7, operator, 'ov-2');
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT before, after FROM audit_logs
           WHERE action = 'trial.override.set' AND result = 'SUCCESS' ORDER BY occurred_at, id` as never,
    )) as unknown as {
      rows: { before: { override: number | null }; after: { override: number } }[];
    };
    expect(rows.rows.map((row) => [row.before.override, row.after.override])).toEqual([
      [null, 2],
      [2, 7],
    ]);
  });

  it('charges each action its own permission', async () => {
    // observer: users.view and settings.view, nothing else.
    expect((await ctx.container.trialAdmin.allowance(tenantA, observer, alice)).used).toBe(0);
    expect(await refusal(setOverride(alice, 2, observer))).toBe(
      PLATFORM_ERROR_CODES.PERMISSION_DENIED,
    );
    await ctx.container.trialAdmin.listResets(tenantA, observer, { limit: 5, cursor: null });
    // operator: the override, and not the reset.
    await setOverride(alice, 2, operator);
    expect(await refusal(ctx.container.trialAdmin.previewReset(tenantA, operator))).toBe(
      PLATFORM_ERROR_CODES.PERMISSION_DENIED,
    );
    await claim(alice, 'perm-1');
    expect(
      await refusal(
        ctx.container.trialAdmin.executeReset(tenantA, operator, {
          idempotencyKey: 'perm-reset',
          expectedGrants: 1,
          expectedFingerprint: NO_SET,
          reason: 'not mine to do',
        }),
      ),
    ).toBe(PLATFORM_ERROR_CODES.PERMISSION_DENIED);
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_resets`)).toBe(0);
  });

  it('keeps each tenant to its own customers and its own grants', async () => {
    const ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-tb', roleKeys: ['owner'] }),
    );
    await customer(tenantB, '960009', BOT_B);
    expect(
      await refusal(
        ctx.container.trialAdmin.setOverride(tenantB, ownerB, {
          idempotencyKey: randomUUID(),
          customerId: alice,
          limit: 9,
          reason: null,
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND);
    expect(await refusal(ctx.container.trialAdmin.allowance(tenantB, ownerB, alice))).toBe(
      COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND,
    );

    await claim(alice, 't-1');
    expect(await ctx.container.trialAdmin.previewReset(tenantB, ownerB)).toMatchObject({
      affectedGrants: 0,
      affectedCustomers: 0,
    });
    expect(
      await refusal(
        ctx.container.trialAdmin.executeReset(tenantB, ownerB, {
          idempotencyKey: 'tb-reset',
          expectedGrants: 1,
          expectedFingerprint: NO_SET,
          reason: 'wrong tenant',
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.TRIAL_RESET_NOTHING);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM trial_grants WHERE reset_at IS NULL`),
    ).toBe(1);
  });

  it('refuses a write on an installation that has stopped accepting work', async () => {
    await claim(alice, 'stop-1');
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
    );
    expect(await refusal(setOverride(alice, 3))).toBe(
      COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
    );
    expect(
      await refusal(
        ctx.container.trialAdmin.executeReset(tenantA, owner, {
          idempotencyKey: 'stop-reset',
          expectedGrants: 1,
          expectedFingerprint: NO_SET,
          reason: 'during a stop',
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID);
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${tenantA.tenantId}`,
    );
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_limit_overrides`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_resets`)).toBe(0);
  });

  it('validates what it is given before touching a row', async () => {
    expect(await refusal(setOverride(alice, 101))).toBe(
      COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
    );
    expect(await refusal(setOverride(alice, 1.5))).toBe(
      COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
    );
    expect(await refusal(ctx.container.trialAdmin.allowance(tenantA, owner, 'not-a-uuid'))).toBe(
      COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
    );
    expect(
      await refusal(
        ctx.container.trialAdmin.executeReset(tenantA, owner, {
          idempotencyKey: 'blank',
          expectedGrants: 1,
          expectedFingerprint: NO_SET,
          reason: '   ',
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID);
  });
});
