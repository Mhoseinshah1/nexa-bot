import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  LEGACY_WALLET_DEBT_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  SESSION_COOKIE_NAME,
  legacyWalletDebtListResponseSchema,
  legacyWalletDebtResponseSchema,
  legacyWalletDebtSummaryResponseSchema,
  systemJobActor,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import { DrizzleLegacyImportRepository } from '../../apps/api/src/modules/platform/legacy-import/infrastructure/drizzle-legacy-import.repository';
import { LegacyDebtsController } from '../../apps/api/src/surfaces/web/legacy-debts.controller';
import { changedTables, databaseFingerprint } from '../support/database-fingerprint';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Mirza migration PR4 — legacy wallet debts (owner decision 6, 2026-10-07): a negative
 * legacy balance is held for review beside the ledger, never collected, and decided per
 * customer by the owner with a label that moves no money. Synthetic data only.
 */

const IMPORTER: ActorContext = systemJobActor(
  'legacy-import:debts',
  'corr-legacy-debts' as CorrelationId,
);
const FP = 'a'.repeat(64);
const ROW = 'b'.repeat(64);

describe('Mirza PR4: legacy wallet debts', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let wallet: DrizzleWalletRepository;
  const runs = new Map<string, string>();

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    runs.clear();
    wallet = new DrizzleWalletRepository(ctx.container.database.db);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-debts', roleKeys: ['owner'] }),
    );
  });

  const db = () => ctx.container.database.db;
  const q = async <R>(query: ReturnType<typeof sql>): Promise<R[]> =>
    (await db().execute(query)).rows as R[];
  const key = () => `debt-${ctx.container.ids.uuid()}`;
  const service = () => ctx.container.legacyWalletDebts;

  async function runFor(scope: TenantContext): Promise<string> {
    const known = runs.get(scope.tenantId);
    if (known !== undefined) return known;
    const started = await ctx.container.uow.run(scope, (tx) =>
      new DrizzleLegacyImportRepository(db()).startOrResume(
        scope,
        {
          id: ctx.container.ids.uuid(),
          mode: 'APPLY',
          sourceFingerprint: FP,
          codeVersion: null,
          now: new Date(),
        },
        tx,
      ),
    );
    runs.set(scope.tenantId, started.run.id);
    return started.run.id;
  }

  async function customer(scope: TenantContext, telegramUserId: string): Promise<UserId> {
    const resolved = await ctx.container.customers.resolveFromUpdate(
      scope,
      {
        type: 'SYSTEM_JOB',
        id: null,
        label: 'telegram-update:test',
        surface: 'TELEGRAM',
        correlationId: `resolve-${telegramUserId}` as never,
      },
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'مریم' },
        botInstanceId: (scope === tenantA ? SEED_IDS.botA1 : SEED_IDS.botB1) as BotInstanceId,
      },
    );
    return resolved.customer.id;
  }

  const post = async (
    scope: TenantContext,
    customerId: UserId,
    telegramUserId: string,
    legacyBalanceMinor: bigint,
    synthetic = false,
  ) =>
    ctx.container.migrationOpeningBalance.post(scope, IMPORTER, {
      customerId,
      telegramUserId,
      legacyBalanceMinor,
      currency: 'IRT',
      provenance: {
        runId: await runFor(scope),
        sourceFingerprint: FP,
        rowChecksum: ROW,
        synthetic,
      },
    });

  const balance = async (scope: TenantContext, customerId: UserId) =>
    (await wallet.balanceOf(scope, customerId, 'IRT')).amountMinor;

  async function debtFor(scope: TenantContext, telegramUserId: string) {
    const c = await customer(scope, telegramUserId);
    const outcome = await post(scope, c, telegramUserId, -45_000n);
    if (outcome.kind !== 'DEBT_RECORDED') throw new Error(`expected a debt, got ${outcome.kind}`);
    return { customerId: c, debt: outcome.debt };
  }

  // --- recording (the importer's path) ----------------------------------------------------

  it('records a negative legacy balance with its provenance, audited, and writes no ledger row', async () => {
    const before = await databaseFingerprint(db());
    const { customerId, debt } = await debtFor(tenantA, '800100');
    expect(debt).toMatchObject({
      customerId,
      legacyUserId: '800100',
      amountMinor: 45_000n,
      currency: 'IRT',
      state: 'PENDING_REVIEW',
      sourceFingerprint: FP,
      rowChecksum: ROW,
      runId: await runFor(tenantA),
      version: 1,
    });
    expect(await balance(tenantA, customerId)).toBe(0n);
    const changed = Object.keys(changedTables(before, await databaseFingerprint(db())));
    // The debt, its audit row, and the scaffolding this test made — never a wallet row.
    expect(changed).toContain('legacy_wallet_debts');
    expect(changed).not.toContain('wallet_entries');
    const audit = await q<{ after: Record<string, unknown> }>(sql`
      SELECT after FROM audit_logs WHERE action = 'legacy.wallet_debt.recorded' AND entity_id = ${debt.id}`);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.after).toMatchObject({ amountMinor: '45000', ledgerEntry: null });
    expect(JSON.stringify(audit)).not.toContain('800100');
  });

  it('a rerun records no second debt; a different figure is refused, never answered with the first', async () => {
    const { customerId } = await debtFor(tenantA, '800200');
    const again = await post(tenantA, customerId, '800200', -45_000n);
    expect(again.kind).toBe('DEBT_ALREADY_RECORDED');
    for (const changed of [-45_001n, 0n, 45_000n]) {
      await expect(post(tenantA, customerId, '800200', changed)).rejects.toMatchObject({
        code: PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
      });
    }
    const rows = await q<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM legacy_wallet_debts WHERE customer_id = ${customerId}`,
    );
    expect(rows[0]?.n).toBe(1);
    expect(await balance(tenantA, customerId)).toBe(0n);
    expect(
      await q(sql`SELECT 1 FROM wallet_entries WHERE customer_id = ${customerId}`),
    ).toHaveLength(0);
  });

  it('never takes a debt recorded from a SYNTHETIC source for a real one, nor the reverse', async () => {
    const c = await customer(tenantA, '800260');
    const first = await post(tenantA, c, '800260', -45_000n, true);
    expect(first.kind === 'DEBT_RECORDED' && first.debt.synthetic).toBe(true);
    await expect(post(tenantA, c, '800260', -45_000n, false)).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
    });
    expect((await post(tenantA, c, '800260', -45_000n, true)).kind).toBe('DEBT_ALREADY_RECORDED');
    const d = await debtFor(tenantA, '800261');
    await expect(post(tenantA, d.customerId, '800261', -45_000n, true)).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
    });
  });

  it('refuses a negative balance without its provenance', async () => {
    const c = await customer(tenantA, '800250');
    await expect(
      ctx.container.migrationOpeningBalance.post(tenantA, IMPORTER, {
        customerId: c,
        telegramUserId: '800250',
        legacyBalanceMinor: -1n,
        currency: 'IRT',
      }),
    ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID });
  });

  it('an existing NEXA customer keeps their balance; the legacy debt is beside it', async () => {
    const c = await customer(tenantA, '800300');
    await ctx.container.wallet.adjust(tenantA, owner, c, {
      idempotencyKey: 'pre-existing',
      direction: 'CREDIT',
      amountMinor: 70_000n,
      currency: 'IRT',
      note: 'nexa',
    });
    expect((await post(tenantA, c, '800300', -100_000n)).kind).toBe('DEBT_RECORDED');
    expect(await balance(tenantA, c)).toBe(70_000n);
    // A purchase-sized debit is paid from that balance in full: the debt takes nothing.
    await ctx.container.wallet.adjust(tenantA, owner, c, {
      idempotencyKey: 'spend',
      direction: 'DEBIT',
      amountMinor: 70_000n,
      currency: 'IRT',
      note: 'nexa',
    });
    expect(await balance(tenantA, c)).toBe(0n);
  });

  // --- the owner's review ----------------------------------------------------------------

  it('lists, summarises and decides: ACKNOWLEDGED, WAIVED, reopen — no decision touches the wallet', async () => {
    const one = await debtFor(tenantA, '800400');
    const two = await debtFor(tenantA, '800401');
    await ctx.container.wallet.adjust(tenantA, owner, one.customerId, {
      idempotencyKey: 'topup-one',
      direction: 'CREDIT',
      amountMinor: 5_000n,
      currency: 'IRT',
      note: 'topup',
    });

    const page = await service().list(tenantA, owner, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe(page.items[0]?.id);
    const next = await service().list(tenantA, owner, { after: page.nextCursor ?? undefined });
    expect(next.items.map((d) => d.id)).toEqual([two.debt.id]);
    expect((await service().list(tenantA, owner, { legacyUserId: '800401' })).items).toHaveLength(
      1,
    );

    const walletBefore = await databaseFingerprint(db());
    const acknowledged = await service().decide(tenantA, owner, one.debt.id, {
      idempotencyKey: key(),
      expectedVersion: 1,
      decision: 'ACKNOWLEDGED',
      reason: 'بدهی ثبت شد',
    });
    expect(acknowledged).toMatchObject({ state: 'ACKNOWLEDGED', version: 2, amountMinor: 45_000n });
    const waived = await service().decide(tenantA, owner, two.debt.id, {
      idempotencyKey: key(),
      expectedVersion: 1,
      decision: 'WAIVED',
      reason: 'بخشیده شد',
    });
    expect(waived.state).toBe('WAIVED');
    const changed = Object.keys(changedTables(walletBefore, await databaseFingerprint(db())));
    for (const money of ['wallet_entries', 'orders', 'payments', 'refunds']) {
      expect(changed, money).not.toContain(money);
    }
    // The top-up is still the customer's in full, whatever the owner decided.
    expect(await balance(tenantA, one.customerId)).toBe(5_000n);

    const summary = await service().summary(tenantA, owner);
    expect(summary.total).toEqual({ count: 2, sumMinor: 90_000n });
    expect(summary.byState).toEqual({
      PENDING_REVIEW: { count: 0, sumMinor: 0n },
      ACKNOWLEDGED: { count: 1, sumMinor: 45_000n },
      WAIVED: { count: 1, sumMinor: 45_000n },
    });

    // Decided debts are not decided again; a reopen brings one back.
    await expect(
      service().decide(tenantA, owner, two.debt.id, {
        idempotencyKey: key(),
        expectedVersion: 2,
        decision: 'ACKNOWLEDGED',
        reason: 'again',
      }),
    ).rejects.toMatchObject({ code: LEGACY_WALLET_DEBT_ERROR_CODES.NOT_IN_STATE });
    const reopened = await service().reopen(tenantA, owner, two.debt.id, {
      idempotencyKey: key(),
      expectedVersion: 2,
      reason: 'دوباره بررسی',
    });
    expect(reopened).toMatchObject({ state: 'PENDING_REVIEW', version: 3 });
    expect(
      await q(
        sql`SELECT 1 FROM audit_logs WHERE action LIKE 'legacy.wallet_debt.%' AND result = 'SUCCESS'`,
      ),
    ).toHaveLength(2 + 3);
  });

  it('a stale version is refused, and an idempotent replay returns the first answer', async () => {
    const { debt } = await debtFor(tenantA, '800500');
    const body = {
      idempotencyKey: key(),
      expectedVersion: 1,
      decision: 'ACKNOWLEDGED',
      reason: 'ok',
    };
    const first = await service().decide(tenantA, owner, debt.id, body);
    const replay = await service().decide(tenantA, owner, debt.id, body);
    expect(replay).toEqual(first);
    await expect(
      service().reopen(tenantA, owner, debt.id, {
        idempotencyKey: key(),
        expectedVersion: 1,
        reason: 'x',
      }),
    ).rejects.toMatchObject({ code: LEGACY_WALLET_DEBT_ERROR_CODES.VERSION_CONFLICT });
    // The strict body has no amount: a decision cannot change what is owed.
    await expect(
      service().reopen(tenantA, owner, debt.id, {
        idempotencyKey: key(),
        expectedVersion: 2,
        reason: 'x',
        amountMinor: '1',
      }),
    ).rejects.toThrow();
  });

  it('a retried decision returns the ORIGINAL response, even after a reopen (Codex on #233)', async () => {
    const { debt } = await debtFor(tenantA, '800550');
    const body = {
      idempotencyKey: key(),
      expectedVersion: 1,
      decision: 'WAIVED',
      reason: 'first',
    };
    const first = await service().decide(tenantA, owner, debt.id, body);
    expect(first).toMatchObject({ state: 'WAIVED', version: 2 });
    await service().reopen(tenantA, owner, debt.id, {
      idempotencyKey: key(),
      expectedVersion: 2,
      reason: 'again',
    });
    expect((await service().get(tenantA, owner, debt.id)).version).toBe(3);
    // The retry of the first key answers with what the first call answered — v2, WAIVED —
    // not the row as it stands now (v3, PENDING_REVIEW), and writes nothing.
    const replay = await service().decide(tenantA, owner, debt.id, body);
    expect(replay).toEqual(first);
    expect((await service().get(tenantA, owner, debt.id)).state).toBe('PENDING_REVIEW');
  });

  it('is permission-gated: an observer cannot view, a support admin cannot decide; denials audited', async () => {
    const { debt } = await debtFor(tenantA, '800600');
    const observer = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'observer-debts',
        roleKeys: ['observer'],
      }),
    );
    await expect(service().list(tenantA, observer, {})).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PERMISSION_DENIED,
    });
    await expect(service().summary(tenantA, observer)).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.PERMISSION_DENIED,
    });
    await expect(
      service().decide(tenantA, observer, debt.id, {
        idempotencyKey: key(),
        expectedVersion: 1,
        decision: 'WAIVED',
        reason: 'no',
      }),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.PERMISSION_DENIED });
    const denied = await q(sql`
      SELECT 1 FROM audit_logs WHERE action = 'legacy.wallet_debt.decide' AND result = 'DENIED'
         AND entity_id = ${debt.id}`);
    expect(denied).toHaveLength(1);
    // The importer's own actor records debts; it may not decide them.
    await expect(
      service().decide(tenantA, IMPORTER, debt.id, {
        idempotencyKey: key(),
        expectedVersion: 1,
        decision: 'WAIVED',
        reason: 'no',
      }),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.PERMISSION_DENIED });
    expect((await service().get(tenantA, owner, debt.id)).state).toBe('PENDING_REVIEW');
  });

  it('keeps tenants apart: B sees and decides none of A’s debts', async () => {
    const { debt } = await debtFor(tenantA, '800700');
    await debtFor(tenantB, '800700');
    const ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-debts-b', roleKeys: ['owner'] }),
    );
    const listedB = await service().list(tenantB, ownerB, {});
    expect(listedB.items).toHaveLength(1);
    expect(listedB.items[0]?.id).not.toBe(debt.id);
    await expect(service().get(tenantB, ownerB, debt.id)).rejects.toMatchObject({
      code: LEGACY_WALLET_DEBT_ERROR_CODES.NOT_FOUND,
    });
    await expect(
      service().decide(tenantB, ownerB, debt.id, {
        idempotencyKey: key(),
        expectedVersion: 1,
        decision: 'WAIVED',
        reason: 'cross-tenant',
      }),
    ).rejects.toMatchObject({ code: LEGACY_WALLET_DEBT_ERROR_CODES.NOT_FOUND });
    expect((await service().get(tenantA, owner, debt.id)).state).toBe('PENDING_REVIEW');
  });

  it('refuses a decision when the tenant has stopped accepting work', async () => {
    const { debt } = await debtFor(tenantA, '800800');
    await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`);
    await expect(
      service().decide(tenantA, owner, debt.id, {
        idempotencyKey: key(),
        expectedVersion: 1,
        decision: 'WAIVED',
        reason: 'x',
      }),
    ).rejects.toMatchObject({ code: LEGACY_WALLET_DEBT_ERROR_CODES.SCOPE_STOPPED });
  });

  // --- the database's own rules ----------------------------------------------------------

  it('the recorded facts are immutable and a debt is never deleted, for every role', async () => {
    const { debt } = await debtFor(tenantA, '800900');
    for (const statement of [
      sql`UPDATE legacy_wallet_debts SET amount_minor = 1 WHERE id = ${debt.id}`,
      sql`UPDATE legacy_wallet_debts SET legacy_user_id = '1' WHERE id = ${debt.id}`,
      sql`UPDATE legacy_wallet_debts SET synthetic = true WHERE id = ${debt.id}`,
      sql`UPDATE legacy_wallet_debts SET source_fingerprint = ${'0'.repeat(64)} WHERE id = ${debt.id}`,
      sql`DELETE FROM legacy_wallet_debts WHERE id = ${debt.id}`,
    ]) {
      await expect(db().execute(statement)).rejects.toThrow();
    }
    // Positive amounts only, IRT only.
    const c = await customer(tenantA, '800901');
    await expect(
      db().execute(sql`
        INSERT INTO legacy_wallet_debts (id, tenant_id, customer_id, legacy_user_id, amount_minor,
          currency, source_fingerprint, row_checksum, run_id, synthetic, state, recorded_at, updated_at)
        VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${c}, '800901', -5, 'IRT',
          ${FP}, ${ROW}, ${await runFor(tenantA)}, false, 'PENDING_REVIEW', now(), now())`),
    ).rejects.toThrow();
    // No foreign key ties a debt to a wallet entry, an order or a payment.
    const fks = await q<{ target: string }>(sql`
      SELECT confrelid::regclass::text AS target FROM pg_constraint
       WHERE contype = 'f' AND conrelid = 'legacy_wallet_debts'::regclass ORDER BY 1`);
    expect(fks.map((f) => f.target).sort()).toEqual(
      ['admins', 'customers', 'legacy_import_runs', 'tenants'].sort(),
    );
  });

  it('backfills the two keys into existing owner roles only, idempotently', async () => {
    await db().execute(
      sql`DELETE FROM role_permissions WHERE permission_key LIKE 'legacy.debts.%'`,
    );
    const migration = readFileSync('apps/api/drizzle/0228_legacy_wallet_debt_grants.sql', 'utf8');
    const backfill = migration.slice(migration.indexOf('INSERT INTO "role_permissions"'));
    await db().execute(sql.raw(backfill));
    await db().execute(sql.raw(backfill));
    const rows = await q<{ role_key: string; permission_key: string }>(
      sql`SELECT r.key AS role_key, rp.permission_key FROM role_permissions rp
            JOIN roles r ON r.id = rp.role_id
           WHERE rp.tenant_id = ${tenantA.tenantId} AND rp.permission_key LIKE 'legacy.debts.%'
           ORDER BY r.key, rp.permission_key`,
    );
    expect(rows.map((r) => `${r.role_key}:${r.permission_key}`)).toEqual([
      'owner:legacy.debts.decide',
      'owner:legacy.debts.view',
    ]);
  });

  // --- the HTTP surface ------------------------------------------------------------------

  it('the Web Admin surface: the wire shape parses, a decision goes through the service', async () => {
    const { debt } = await debtFor(tenantA, '801000');
    const { token } = await ctx.container.auth.login(
      tenantA,
      {
        type: 'API',
        id: null,
        label: null,
        surface: 'WEB',
        correlationId: 'debts-web' as CorrelationId,
      },
      { username: 'owner-debts', password: 'a-perfectly-fine-password' },
      { ip: '203.0.113.10', userAgent: 'vitest' },
    );
    type WebRequest = Parameters<LegacyDebtsController['list']>[0];
    const request = (method: string) =>
      ({
        method,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
        ip: '203.0.113.10',
      }) as unknown as WebRequest;
    const controller = new LegacyDebtsController(ctx.container);
    const listed = legacyWalletDebtListResponseSchema.parse(
      await controller.list(request('GET'), { state: 'PENDING_REVIEW' }),
    );
    expect(listed.debts.map((d) => d.id)).toEqual([debt.id]);
    expect(listed.debts[0]).toMatchObject({ amountMinor: '45000', currency: 'IRT' });
    const summary = legacyWalletDebtSummaryResponseSchema.parse(
      await controller.summary(request('GET')),
    );
    expect(summary.total).toEqual({ count: 1, sumMinor: '45000' });
    const decided = legacyWalletDebtResponseSchema.parse(
      await controller.decide(request('POST'), debt.id, {
        idempotencyKey: key(),
        expectedVersion: 1,
        decision: 'WAIVED',
        reason: 'از طریق وب',
      }),
    );
    expect(decided.debt).toMatchObject({ state: 'WAIVED', decisionReason: 'از طریق وب' });
  });
});
