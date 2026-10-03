import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  money,
  systemJobActor,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import type { MigrationOpeningBalanceCommand } from '../../apps/api/src/modules/commerce/wallet/application/migration-opening-balance.service';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Migration P2 — the legacy opening balance (`docs/migration-opening-balance.md`).
 *
 * The legacy `user.Balance` is carried into the ledger as ONE `MIGRATION_OPENING_BALANCE`
 * entry per customer, under `legacy:opening:<telegram_user_id>`: additive to whatever the
 * customer already holds, negative only through this path, once however many times the
 * import is run, and never read by any report as a sale, a top-up, cash or a grant.
 */

const IMPORTER: ActorContext = systemJobActor(
  'legacy-import:test',
  'corr-legacy-import' as CorrelationId,
);

describe('Migration P2: the legacy opening balance', () => {
  let ctx: TestContext;
  let repository: DrizzleWalletRepository;
  let owner: ActorContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    repository = new DrizzleWalletRepository(ctx.container.database.db);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-opening', roleKeys: ['owner'] }),
    );
  });

  async function customer(scope: typeof tenantA, telegramUserId: string): Promise<UserId> {
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
        from: { id: Number(telegramUserId), first_name: 'زهرا' },
        botInstanceId: (scope === tenantA ? SEED_IDS.botA1 : SEED_IDS.botB1) as BotInstanceId,
      },
    );
    return resolved.customer.id;
  }

  const post = (
    scope: typeof tenantA,
    customerId: UserId,
    telegramUserId: string,
    legacyBalanceMinor: bigint,
    overrides: Partial<MigrationOpeningBalanceCommand> = {},
  ) =>
    ctx.container.migrationOpeningBalance.post(scope, IMPORTER, {
      customerId,
      telegramUserId,
      legacyBalanceMinor,
      currency: 'IRT',
      ...overrides,
    });

  const balance = async (scope: typeof tenantA, customerId: UserId): Promise<bigint> =>
    (await repository.balanceOf(scope, customerId, 'IRT')).amountMinor;

  const openings = async (scope: typeof tenantA, customerId: UserId) =>
    (
      await ctx.container.database.db.execute(sql`
        SELECT direction, amount::text AS amount, reference, actor_admin_id, order_id, payment_id
          FROM wallet_entries
         WHERE tenant_id = ${scope.tenantId} AND customer_id = ${customerId}
           AND reason = 'MIGRATION_OPENING_BALANCE'`)
    ).rows as { direction: string; amount: string; reference: string }[];

  const count = async (query: ReturnType<typeof sql>): Promise<number> => {
    const [row] = (await ctx.container.database.db.execute(query)).rows as { n: number }[];
    return Number(row?.n ?? 0);
  };

  const auditRows = (customerId: UserId, result = 'SUCCESS') =>
    count(sql`SELECT count(*)::int AS n FROM audit_logs
      WHERE action = 'wallet.migration_opening_balance' AND entity_id = ${customerId}
        AND result = ${result}`);

  const events = (customerId: UserId) =>
    count(sql`SELECT count(*)::int AS n FROM outbox_messages
      WHERE event_type = 'WalletEntryRecorded' AND aggregate_id = ${customerId}
        AND payload->>'reason' = 'MIGRATION_OPENING_BALANCE'`);

  // ---------------------------------------------------------------------------
  // Positive, zero, negative
  // ---------------------------------------------------------------------------

  it('opens a new customer at the legacy balance: one CREDIT, audited, with one event', async () => {
    const c = await customer(tenantA, '700100');
    const outcome = await post(tenantA, c, '700100', 1_250_000n);

    expect(outcome.kind).toBe('POSTED');
    if (outcome.kind !== 'POSTED') throw new Error('unreachable');
    expect(outcome.balanceAfterMinor).toBe(1_250_000n);
    expect(outcome.entry.reason).toBe('MIGRATION_OPENING_BALANCE');
    expect(outcome.entry.direction).toBe('CREDIT');
    expect(outcome.entry.amount).toEqual(money(1_250_000n, 'IRT'));
    expect(outcome.entry.reference).toBe('legacy:opening:700100');
    expect(outcome.entry.actorAdminId).toBeNull();
    expect(await balance(tenantA, c)).toBe(1_250_000n);
    expect(await auditRows(c)).toBe(1);
    expect(await events(c)).toBe(1);
  });

  it('writes NOTHING for a zero legacy balance, and says so', async () => {
    const c = await customer(tenantA, '700200');
    expect(await post(tenantA, c, '700200', 0n)).toEqual({ kind: 'ZERO_NO_ENTRY' });
    expect(await post(tenantA, c, '700200', 0n)).toEqual({ kind: 'ZERO_NO_ENTRY' });
    expect(await openings(tenantA, c)).toEqual([]);
    expect(await balance(tenantA, c)).toBe(0n);
    expect(await auditRows(c)).toBe(0);
    expect(await events(c)).toBe(0);
  });

  it('preserves a NEGATIVE legacy balance as a DEBIT, through this path only', async () => {
    const c = await customer(tenantA, '700300');
    const outcome = await post(tenantA, c, '700300', -45_000n);
    expect(outcome.kind).toBe('POSTED');
    expect(await openings(tenantA, c)).toMatchObject([{ direction: 'DEBIT', amount: '45000' }]);
    expect(await balance(tenantA, c)).toBe(-45_000n);
  });

  it('keeps every ORDINARY debit refusing to overdraw a wallet that opened negative', async () => {
    const c = await customer(tenantA, '700400');
    await post(tenantA, c, '700400', -45_000n);

    const debit = (amountMinor: bigint, key: string) =>
      ctx.container.wallet.adjust(tenantA, owner, c, {
        idempotencyKey: key,
        direction: 'DEBIT',
        amountMinor,
        currency: 'IRT',
        note: 'test',
      });
    await expect(debit(1n, 'debit-1')).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS,
    });

    // A credit reduces the legacy debt and is still not enough to spend from.
    await ctx.container.wallet.adjust(tenantA, owner, c, {
      idempotencyKey: 'credit-1',
      direction: 'CREDIT',
      amountMinor: 40_000n,
      currency: 'IRT',
      note: 'test',
    });
    expect(await balance(tenantA, c)).toBe(-5_000n);
    await expect(debit(1n, 'debit-2')).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS,
    });
    expect(await balance(tenantA, c)).toBe(-5_000n);
  });

  // ---------------------------------------------------------------------------
  // Additive for an existing customer
  // ---------------------------------------------------------------------------

  it('ADDS the legacy balance to an existing customer’s NEXA balance, either sign', async () => {
    const rich = await customer(tenantA, '700500');
    const poor = await customer(tenantA, '700501');
    for (const [c, key] of [
      [rich, 'pre-rich'],
      [poor, 'pre-poor'],
    ] as const) {
      await ctx.container.wallet.adjust(tenantA, owner, c, {
        idempotencyKey: key,
        direction: 'CREDIT',
        amountMinor: 70_000n,
        currency: 'IRT',
        note: 'pre-import',
      });
    }

    const up = await post(tenantA, rich, '700500', 50_000n);
    expect(up.kind === 'POSTED' && up.balanceAfterMinor).toBe(120_000n);
    expect(await balance(tenantA, rich)).toBe(120_000n);

    const down = await post(tenantA, poor, '700501', -100_000n);
    expect(down.kind === 'POSTED' && down.balanceAfterMinor).toBe(-30_000n);
    expect(await balance(tenantA, poor)).toBe(-30_000n);
  });

  // ---------------------------------------------------------------------------
  // Idempotency
  // ---------------------------------------------------------------------------

  it('is a no-op on a retry: one entry, one audit row, one event', async () => {
    const c = await customer(tenantA, '700600');
    const first = await post(tenantA, c, '700600', 30_000n);
    const second = await post(tenantA, c, '700600', 30_000n);
    expect(first.kind).toBe('POSTED');
    expect(second.kind).toBe('ALREADY_POSTED');
    if (first.kind !== 'POSTED' || second.kind !== 'ALREADY_POSTED') throw new Error('x');
    expect(second.entry.id).toBe(first.entry.id);
    expect(await openings(tenantA, c)).toHaveLength(1);
    expect(await balance(tenantA, c)).toBe(30_000n);
    expect(await auditRows(c)).toBe(1);
    expect(await events(c)).toBe(1);
  });

  it('refuses a rerun with a DIFFERENT figure instead of answering with the first', async () => {
    const c = await customer(tenantA, '700700');
    await post(tenantA, c, '700700', 30_000n);
    for (const changed of [31_000n, -30_000n, 0n]) {
      await expect(post(tenantA, c, '700700', changed)).rejects.toMatchObject({
        code: PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
      });
    }
    expect(await balance(tenantA, c)).toBe(30_000n);
  });

  it('writes ONE entry when several importers race the same customer', async () => {
    const c = await customer(tenantA, '700800');
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => post(tenantA, c, '700800', -12_345n)),
    );
    expect(outcomes.filter((o) => o.kind === 'POSTED')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'ALREADY_POSTED')).toHaveLength(5);
    expect(await openings(tenantA, c)).toHaveLength(1);
    expect(await balance(tenantA, c)).toBe(-12_345n);
    expect(await events(c)).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Identity, tenancy, authority
  // ---------------------------------------------------------------------------

  it('keeps tenants apart: one Telegram id, two tenants, two independent openings', async () => {
    const a = await customer(tenantA, '700900');
    const b = await customer(tenantB, '700900');
    expect((await post(tenantA, a, '700900', 10_000n)).kind).toBe('POSTED');
    expect((await post(tenantB, b, '700900', -20_000n)).kind).toBe('POSTED');
    expect(await balance(tenantA, a)).toBe(10_000n);
    expect(await balance(tenantB, b)).toBe(-20_000n);

    // A customer of A, named under B's scope, does not exist there.
    await expect(post(tenantB, a, '700900', 10_000n)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND,
    });
  });

  it('refuses a legacy id that is not the customer’s own Telegram id', async () => {
    const c = await customer(tenantA, '701000');
    await customer(tenantA, '701001');
    await expect(post(tenantA, c, '701001', 10_000n)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
    });
    await expect(post(tenantA, c, 'not-an-id', 10_000n)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
    });
    expect(await openings(tenantA, c)).toEqual([]);
  });

  it('refuses a currency the installation does not sell in', async () => {
    const c = await customer(tenantA, '701100');
    await expect(post(tenantA, c, '701100', 10_000n, { currency: 'USD' })).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.WALLET_CURRENCY_UNSUPPORTED,
    });
  });

  it('is denied, and audited as denied, without the permission', async () => {
    const c = await customer(tenantA, '701200');
    const support = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'support-open',
        roleKeys: ['support'],
      }),
    );
    await expect(
      ctx.container.migrationOpeningBalance.post(tenantA, support, {
        customerId: c,
        telegramUserId: '701200',
        legacyBalanceMinor: 10_000n,
        currency: 'IRT',
      }),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.PERMISSION_DENIED });
    expect(await auditRows(c, 'DENIED')).toBe(1);
    expect(await openings(tenantA, c)).toEqual([]);
  });

  it('refuses a tenant that has stopped accepting work', async () => {
    const c = await customer(tenantA, '701300');
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
    );
    await expect(post(tenantA, c, '701300', 10_000n)).rejects.toMatchObject({
      code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
    });
    expect(await openings(tenantA, c)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // The database's own rules
  // ---------------------------------------------------------------------------

  it('reserves the legacy:opening: prefix to the reason, and one opening to a customer', async () => {
    const c = await customer(tenantA, '701400');
    const raw = (reason: 'ADMIN_CREDIT' | 'MIGRATION_OPENING_BALANCE', reference: string) =>
      repository.append(tenantA, {
        id: ctx.container.ids.uuid(),
        customerId: c,
        direction: 'CREDIT',
        reason,
        amount: money(1n, 'IRT'),
        reference,
        now: ctx.container.clock.now(),
      });
    const violates = (constraint: string) =>
      expect.objectContaining({
        cause: expect.objectContaining({ constraint }) as unknown,
      }) as unknown;

    // Another reason may not occupy the reference a rerun would conflict on…
    await expect(raw('ADMIN_CREDIT', 'legacy:opening:701400')).rejects.toEqual(
      violates('wallet_entries_migration_opening_shape_check'),
    );
    // …and the opening may not be written under any other reference.
    await expect(raw('MIGRATION_OPENING_BALANCE', 'something-else')).rejects.toEqual(
      violates('wallet_entries_migration_opening_shape_check'),
    );
    // One opening per customer, whatever reference a writer derived.
    await raw('MIGRATION_OPENING_BALANCE', 'legacy:opening:701400');
    await expect(raw('MIGRATION_OPENING_BALANCE', 'legacy:opening:9999999')).rejects.toEqual(
      violates('wallet_entries_migration_opening_customer_key'),
    );
  });

  // ---------------------------------------------------------------------------
  // Reports
  // ---------------------------------------------------------------------------

  it('is reported as an opening balance alone: never sales, revenue, top-up or cash', async () => {
    const c1 = await customer(tenantA, '701500');
    const c2 = await customer(tenantA, '701501');
    await post(tenantA, c1, '701500', 2_000_000n);
    await post(tenantA, c2, '701501', -300_000n);
    const net = 1_700_000n;
    const request = { range: 'TODAY' as const };

    const financial = await ctx.container.reports.financial(tenantA, owner, request, 'DAY');
    for (const lines of financial.totals) {
      expect(lines).toMatchObject({
        sales: '0',
        grossSales: '0',
        netSales: '0',
        principalReceived: '0',
        customerPaid: '0',
        receiptCredits: '0',
        walletTopups: '0',
        walletSpending: '0',
        gifts: '0',
        cashbackNet: '0',
        commissionNet: '0',
      });
    }
    const [wallet] = financial.wallet;
    expect(wallet?.movements).toEqual([{ group: 'OPENING_BALANCE', amount: net.toString() }]);
    // The identity, against an independent read of every balance.
    const independent = (await balance(tenantA, c1)) + (await balance(tenantA, c2));
    expect(BigInt(wallet?.closing ?? 'x')).toBe(BigInt(wallet?.opening ?? 'x') + net);
    expect(BigInt(wallet?.closing ?? 'x')).toBe(independent);

    const walletReport = await ctx.container.reports.wallet(tenantA, owner, request);
    expect(walletReport.groups).toEqual([
      { group: 'OPENING_BALANCE', currency: 'IRT', entries: 2, amount: net.toString() },
    ]);

    const dashboard = await ctx.container.reports.dashboard(tenantA, owner, request);
    expect(JSON.stringify(dashboard.today.revenue)).not.toContain('2000000');
    expect(dashboard.today.sales.current).toBe(0);
  });
});
