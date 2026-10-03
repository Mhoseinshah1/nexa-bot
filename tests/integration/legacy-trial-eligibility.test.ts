import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isNexaError,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
import type { LegacyTrialFacts } from '../../apps/api/src/modules/commerce/trials/application/legacy-trial-eligibility';
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
 * Program Item 15: legacy trial-eligibility preservation, through the shipped container
 * against real PostgreSQL (`docs/legacy-migration/trial-eligibility.md`).
 *
 * Every verdict is checked where it matters — by the customer's own trial CLAIM, decided
 * by the one allowance evaluator — not only by the row the import wrote. The panel is a
 * fake RickPanel only because a trial needs a panel that passed a connection test; no
 * claim here dials it.
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

describe('legacy trial eligibility', () => {
  let ctx: TestContext;
  let panel: FakeRickpanel;
  let owner: ActorContext;
  let operator: ActorContext;
  let observer: ActorContext;
  let trialPanelId: string;

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
      await createAdmin(ctx.container, tenantA, { username: 'owner-lt', roleKeys: ['owner'] }),
    );
    operator = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'op-lt', roleKeys: ['operator'] }),
    );
    observer = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'obs-lt', roleKeys: ['observer'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Rick',
      providerType: 'rickpanel',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: {},
      idempotencyKey: 'panel-legacy-trial',
    });
    trialPanelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, trialPanelId);
    await ctx.container.panelTrials.update(tenantA, owner, trialPanelId, {
      idempotencyKey: randomUUID(),
      expectedRevision: 0,
      enabled: true,
      trafficAmount: '1',
      trafficUnit: 'GB',
      durationHours: 24,
      label: null,
    });
  });

  async function customer(
    telegramId: string,
    scope: TenantContext = tenantA,
    bot: BotInstanceId = BOT_A,
  ): Promise<UserId> {
    const resolved = await ctx.container.customers.resolveFromUpdate(
      scope,
      systemActor(`r-${telegramId}-${String(scope.tenantId)}`),
      {
        idempotencyKey: `resolve-${telegramId}`,
        telegramUserId: telegramId,
        from: { id: Number(telegramId), first_name: 'سارا' },
        botInstanceId: bot,
      },
    );
    return resolved.customer.id;
  }

  const preserve = (
    who: UserId,
    legacy: LegacyTrialFacts,
    opts: { key?: string; actor?: ActorContext; scope?: TenantContext } = {},
  ) =>
    ctx.container.legacyTrials.preserve(opts.scope ?? tenantA, opts.actor ?? operator, {
      idempotencyKey: opts.key ?? randomUUID(),
      customerId: who,
      legacy,
    });

  const claim = (who: UserId, key: string = randomUUID()) =>
    ctx.container.trials.claim(tenantA, systemActor(key), who, {
      idempotencyKey: key,
      panelId: trialPanelId,
    });

  const allowance = (who: UserId) => ctx.container.trialAdmin.allowance(tenantA, owner, who);

  const count = async (query: ReturnType<typeof sql>): Promise<number> => {
    const rows = (await ctx.container.database.db.execute(query as never)) as unknown as {
      rows: { n: number }[];
    };
    return rows.rows[0]?.n ?? 0;
  };

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

  /** Waits until `expected` transactions are blocked on a row lock — the barrier. */
  async function awaitBlocked(expected: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const n = await count(
        sql`SELECT count(*)::int AS n FROM pg_locks
             WHERE NOT granted AND locktype IN ('tuple', 'transactionid')`,
      );
      if (n >= expected) return;
      if (Date.now() > deadline) throw new Error('the imports never blocked.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function refusal(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      if (isNexaError(error)) return error.code;
      if (error instanceof Error) {
        const cause = (error as { cause?: unknown }).cause;
        return cause instanceof Error ? `${error.message} ${cause.message}` : error.message;
      }
      throw error;
    }
    throw new Error('expected a refusal, and the call succeeded');
  }

  it('control: an imported customer with nothing recorded would get a fresh trial', async () => {
    // The hazard this item exists for, demonstrated so the cases below mean something.
    const fresh = await customer('970000');
    expect((await claim(fresh)).outcome).toBe('ISSUED');
  });

  it('legacy no-trial (limit 0) stays no-trial in NEXA', async () => {
    const who = await customer('970001');
    const result = await preserve(who, { limitUsertest: 0, hadTrial: false });
    expect(result).toMatchObject({
      outcome: 'APPLIED',
      record: { decision: 'LEGACY_NO_TRIALS', overrideBefore: null, overrideAfter: 0 },
    });
    expect((await allowance(who)).effectiveLimit).toBe(0);
    expect(await claim(who)).toEqual({ outcome: 'REFUSED', reason: 'LIMIT_REACHED' });
  });

  it('legacy allowed but already used is consumed: no new trial merely for being imported', async () => {
    const who = await customer('970002');
    const result = await preserve(who, { limitUsertest: 1, hadTrial: true });
    expect(result.record.decision).toBe('LEGACY_TRIAL_CONSUMED');
    expect(await claim(who)).toEqual({ outcome: 'REFUSED', reason: 'LIMIT_REACHED' });
  });

  it('an unreadable legacy limit gives no trial', async () => {
    const who = await customer('970003');
    expect((await preserve(who, { limitUsertest: 'n/a', hadTrial: false })).record).toMatchObject({
      decision: 'LEGACY_LIMIT_UNREADABLE',
      legacyLimitUsertest: null,
      overrideAfter: 0,
    });
    expect((await claim(who)).outcome).toBe('REFUSED');
  });

  it('legacy allowed with no evidence of use defers to NEXA policy, and NEXA counts the trial', async () => {
    const who = await customer('970004');
    const result = await preserve(who, { limitUsertest: 1, hadTrial: false });
    expect(result.record).toMatchObject({ decision: 'INHERIT_NEXA_POLICY', overrideAfter: null });
    expect((await allowance(who)).override).toBeNull();
    expect((await claim(who)).outcome).toBe('ISSUED');
    // The ordinary limit then applies: one trial, not one per system.
    expect(await claim(who)).toEqual({ outcome: 'REFUSED', reason: 'LIMIT_REACHED' });
  });

  it("respects an existing NEXA customer's current state and never loosens it", async () => {
    // An operator raised one customer to 3 and closed another at 0, before the import.
    const raised = await customer('970005');
    const closed = await customer('970006');
    await ctx.container.trialAdmin.setOverride(tenantA, operator, {
      idempotencyKey: randomUUID(),
      customerId: raised,
      limit: 3,
      reason: null,
    });
    await ctx.container.trialAdmin.setOverride(tenantA, operator, {
      idempotencyKey: randomUUID(),
      customerId: closed,
      limit: 0,
      reason: null,
    });

    expect((await preserve(raised, { limitUsertest: 0, hadTrial: true })).record).toMatchObject({
      decision: 'KEPT_EXISTING_OVERRIDE',
      overrideBefore: 3,
      overrideAfter: 3,
    });
    expect((await preserve(closed, { limitUsertest: 1, hadTrial: false })).record).toMatchObject({
      decision: 'KEPT_EXISTING_OVERRIDE',
      overrideBefore: 0,
      overrideAfter: 0,
    });
    expect((await allowance(raised)).effectiveLimit).toBe(3);
    expect(await claim(closed)).toEqual({ outcome: 'REFUSED', reason: 'LIMIT_REACHED' });

    // A customer who already used a NEXA trial keeps it used: deferring adds nothing.
    const used = await customer('970007');
    expect((await claim(used)).outcome).toBe('ISSUED');
    await preserve(used, { limitUsertest: 1, hadTrial: false });
    expect(await claim(used)).toEqual({ outcome: 'REFUSED', reason: 'LIMIT_REACHED' });
  });

  it('is idempotent on rerun, never re-imposes a lifted override, and reports changed facts', async () => {
    const who = await customer('970008');
    const key = 'legacy-trial-970008';
    await preserve(who, { limitUsertest: 1, hadTrial: true }, { key });

    // The same command again, and the same facts under another key: both replays.
    expect((await preserve(who, { limitUsertest: 1, hadTrial: true }, { key })).outcome).toBe(
      'APPLIED',
    );
    expect((await preserve(who, { limitUsertest: '1', hadTrial: true })).outcome).toBe('REPLAYED');

    // An operator lifts the override after the import. A rerun must not put it back.
    await ctx.container.trialAdmin.removeOverride(tenantA, operator, {
      idempotencyKey: randomUUID(),
      customerId: who,
      reason: 'بررسی شد',
    });
    expect((await preserve(who, { limitUsertest: 1, hadTrial: true })).outcome).toBe('REPLAYED');
    expect((await allowance(who)).override).toBeNull();

    // Different facts for a decided customer change nothing and say so.
    const conflict = await preserve(who, { limitUsertest: 0, hadTrial: false });
    expect(conflict).toMatchObject({
      outcome: 'CONFLICT',
      record: { decision: 'LEGACY_TRIAL_CONSUMED' },
    });
    expect((await allowance(who)).override).toBeNull();

    expect(await count(sql`SELECT count(*)::int AS n FROM legacy_trial_eligibility`)).toBe(1);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'trial.legacy.preserve' AND result = 'SUCCESS'`,
      ),
    ).toBe(1);
  });

  it('serialises two concurrent imports of one customer under the customer lock', async () => {
    /*
     * A real interleaving: an outside transaction holds the customer's row, and both
     * imports are released only once both are queued behind it — each past its
     * idempotency read. Decided under the lock, the second sees the first's record.
     * Without `lockCustomer` both reach their insert and the second is a key violation.
     */
    const who = await customer('970009');
    const { release, done } = await hold(sql`SELECT 1 FROM customers WHERE id = ${who} FOR UPDATE`);
    const racing = Promise.all([
      preserve(who, { limitUsertest: 1, hadTrial: true }),
      preserve(who, { limitUsertest: 1, hadTrial: true }),
    ]);
    await awaitBlocked(2);
    release();
    await done;
    const results = await racing;
    expect(results.map((r) => r.outcome).sort()).toEqual(['APPLIED', 'REPLAYED']);
    expect(await count(sql`SELECT count(*)::int AS n FROM legacy_trial_eligibility`)).toBe(1);
  });

  it('keeps tenants apart', async () => {
    const inA = await customer('970010');
    const inB = await customer('970010', tenantB, BOT_B);
    const ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-lt-b', roleKeys: ['owner'] }),
    );
    // Tenant A cannot address tenant B's customer.
    expect(await refusal(preserve(inB, { limitUsertest: 0, hadTrial: false }))).toBe(
      'commerce.customer_not_found',
    );
    // One Telegram user, two tenants, two independent decisions.
    await preserve(inA, { limitUsertest: 0, hadTrial: false });
    await preserve(inB, { limitUsertest: 1, hadTrial: false }, { scope: tenantB, actor: ownerB });
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT tenant_id::text AS tenant, decision FROM legacy_trial_eligibility ORDER BY decision` as never,
    )) as unknown as { rows: { tenant: string; decision: string }[] };
    expect(rows.rows).toEqual([
      { tenant: String(tenantB.tenantId), decision: 'INHERIT_NEXA_POLICY' },
      { tenant: String(tenantA.tenantId), decision: 'LEGACY_NO_TRIALS' },
    ]);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM trial_limit_overrides WHERE tenant_id = ${tenantB.tenantId}`,
      ),
    ).toBe(0);
  });

  it('denies an actor without users.trial.edit and writes nothing', async () => {
    const who = await customer('970011');
    expect(
      await refusal(preserve(who, { limitUsertest: 0, hadTrial: false }, { actor: observer })),
    ).toMatch(/permission/u);
    expect(await count(sql`SELECT count(*)::int AS n FROM legacy_trial_eligibility`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM trial_limit_overrides`)).toBe(0);
  });

  it('keeps the decision record append-only', async () => {
    const who = await customer('970012');
    await preserve(who, { limitUsertest: 0, hadTrial: false });
    const db = ctx.container.database.db;
    expect(
      await refusal(
        db.execute(sql`UPDATE legacy_trial_eligibility SET decision = 'INHERIT_NEXA_POLICY'`),
      ),
    ).toMatch(/append-only|not permitted|cannot/iu);
    expect(await refusal(db.execute(sql`DELETE FROM legacy_trial_eligibility`))).toMatch(
      /append-only|not permitted|cannot/iu,
    );
  });
});
