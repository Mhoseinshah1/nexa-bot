import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  systemJobActor,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import { DrizzleLegacyImporterRepository } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/drizzle-legacy-importer.repository';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * Round 4 PR-A, the database halves of A5 and A4:
 *
 * - an administrator's manual wallet credit and debit queue ONE lane row each, through the
 *   outbox consumer, naming the ledger entry — and an imported opening balance queues NONE;
 * - the values the lane renders are read from the entry: amount, the balance right after it,
 *   and the note only when the operator ticked «نمایش دلیل به مشتری»;
 * - an unblock queues `ACCOUNT_UNBLOCKED`;
 * - the import's previous-bot rules acceptance is a conditional, idempotent UPDATE that sends
 *   nothing, and the gate counts it.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const IMPORTER = systemJobActor('legacy-import:test', 'corr-r4-notices' as CorrelationId);
const customerActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('R4: customer notices for manual wallet changes and unblocks; imported rules acceptance', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let customerA: UserId;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-r4', roleKeys: ['owner'] }),
    );
    const { customer } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      customerActor('resolve-r4'),
      {
        idempotencyKey: 'resolve-r4',
        telegramUserId: '940001',
        from: { id: 940001, first_name: 'زهرا' },
        botInstanceId: BOT_A,
      },
    );
    customerA = customer.id;
  });

  const notices = async (): Promise<{ kind: string; subject_id: string }[]> =>
    (
      (await ctx.container.database.db.execute(
        sql`SELECT kind, subject_id FROM customer_notifications WHERE customer_id = ${customerA}
             ORDER BY created_at, id` as never,
      )) as unknown as { rows: { kind: string; subject_id: string }[] }
    ).rows;

  const drain = async () => {
    for (let i = 0; i < 5; i += 1) await ctx.container.relay.processBatch();
  };

  it('a manual credit and debit are each told once, with amount, new balance and the ticked reason', async () => {
    const credit = await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: 'r4-credit',
      direction: 'CREDIT',
      amountMinor: 50_000n,
      currency: 'IRT',
      note: 'جبران قطعی',
      showNoteToCustomer: true,
    });
    const debit = await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: 'r4-debit',
      direction: 'DEBIT',
      amountMinor: 20_000n,
      currency: 'IRT',
      note: 'یادداشت داخلی',
    });
    await drain();
    await drain();
    expect(await notices()).toEqual([
      { kind: 'WALLET_ADMIN_CREDITED', subject_id: credit.id },
      { kind: 'WALLET_ADMIN_DEBITED', subject_id: debit.id },
    ]);

    const wallet = new DrizzleWalletRepository(ctx.container.database.db);
    const told = await wallet.adminAdjustmentFor(tenantA, credit.id);
    expect(told).toMatchObject({ direction: 'CREDIT', shownNote: 'جبران قطعی' });
    expect(told?.amount.amountMinor).toBe(50_000n);
    expect(told?.balanceAfter.amountMinor).toBe(50_000n);
    const debited = await wallet.adminAdjustmentFor(tenantA, debit.id);
    expect(debited?.balanceAfter.amountMinor, 'the balance right after the debit').toBe(30_000n);
    expect(debited?.shownNote, 'not ticked: the note stays the operator’s').toBeNull();
  });

  it('NEVER for an imported opening balance', async () => {
    const opened = await ctx.container.migrationOpeningBalance.post(tenantA, IMPORTER, {
      customerId: customerA,
      telegramUserId: '940001',
      legacyBalanceMinor: 75_000n,
      currency: 'IRT',
    });
    expect(opened).toBeDefined();
    await drain();
    expect(await notices(), 'the import is never announced').toEqual([]);
    // And the reader refuses to render the import entry as an adjustment.
    const rows = (
      (await ctx.container.database.db.execute(
        sql`SELECT id FROM wallet_entries WHERE customer_id = ${customerA}` as never,
      )) as unknown as { rows: { id: string }[] }
    ).rows;
    const wallet = new DrizzleWalletRepository(ctx.container.database.db);
    for (const row of rows) expect(await wallet.adminAdjustmentFor(tenantA, row.id)).toBeNull();
  });

  it('an unblock is told; a block is not', async () => {
    await ctx.container.customers.block(tenantA, owner, {
      idempotencyKey: 'r4-block',
      customerId: customerA,
      reason: 'آزمایش',
    });
    await ctx.container.customers.unblock(tenantA, owner, {
      idempotencyKey: 'r4-unblock',
      customerId: customerA,
      reason: null,
    });
    await drain();
    expect((await notices()).map((row) => row.kind)).toEqual(['ACCOUNT_UNBLOCKED']);
  });

  it('the imported rules acceptance: conditional, idempotent, silent — and the gate counts it', async () => {
    const at = ctx.container.clock.now();
    const runId = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO legacy_import_runs (id, tenant_id, mode, status, source_fingerprint, code_version,
                                      started_at, last_progress_at, finished_at)
      VALUES (${runId}, ${tenantA.tenantId}, 'APPLY', 'COMPLETED', repeat('a', 64), 'test',
              now(), now(), now())`);
    await ctx.container.database.db.execute(sql`
      INSERT INTO legacy_import_map (tenant_id, legacy_table, legacy_id, run_id, checksum, status, entity_type, entity_id, created_at, updated_at)
      VALUES (${tenantA.tenantId}, 'user', '940001', ${runId}, repeat('b', 64), 'IMPORTED', 'CUSTOMER', ${customerA}, now(), now())`);
    const repo = new DrizzleLegacyImporterRepository(ctx.container.database.db);
    const mark = () =>
      ctx.container.database.db.transaction((tx) =>
        repo.markLegacyTermsAccepted(tenantA, ['940001', '949999'], at, { tx } as never),
      );
    expect(await mark()).toBe(1);
    expect(await mark(), 'a rerun marks nobody twice').toBe(0);
    const outbox = (
      (await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM outbox_messages WHERE aggregate_id = ${customerA}
             AND event_type NOT IN ('CustomerRegistered', 'CustomerBotLinked')` as never,
      )) as unknown as { rows: { n: number }[] }
    ).rows[0]?.n;
    expect(outbox, 'nothing is announced').toBe(0);
    expect(await notices()).toEqual([]);
    const standing = await ctx.container.termsAcceptance.standing(tenantA, customerA);
    expect(standing.acceptedInPreviousBotAt).not.toBeNull();
  });
});
