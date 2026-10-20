import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type DomainEvent,
  type UserId,
} from '@nexa/contracts';
import { DrizzleOpsLogFacts } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/drizzle-ops-log-facts';
import { i18nOpsLogWords } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import { LedgerLogConsumer } from '../../apps/api/src/modules/commerce/ops-log/application/ledger-log.consumer';
import type { OpsLogLane } from '../../apps/api/src/modules/commerce/ops-log/application/ports';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * Round 5A item 3 — the two customer-message readers that still ordered the wallet "balance
 * before/after" by time (`refundedForOrder`, `adminAdjustmentFor`), against the real SQL.
 *
 * A writer stamps its entry BEFORE it takes the customer lock, so a movement that committed
 * later can carry an earlier `created_at`. Both readers now sum in COMMIT order through
 * `balanceInCommitOrder`, the reader the operations log already used (Round 4 PR-D, #301).
 *
 * MUTATION (reverted, the named tests failed, restored): the `WHERE` of `balanceInCommitOrder`
 * ordering by `(e.created_at, e.id) <= (last.created_at, last.id)` alone -> all three tests.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const irt = (n: bigint) => money(n, 'IRT');
const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('balance before/after in the customer messages is in commit order', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let facts: DrizzleOpsLogFacts;
  let wallet: DrizzleWalletRepository;
  let seq = 0;
  const key = (label: string) => `r5a-bal-${label}-${String((seq += 1))}`;
  const exec = (query: ReturnType<typeof sql>) => ctx.container.database.db.execute(query);
  const uuid = () => ctx.container.ids.uuid();
  const run = <T>(work: (tx: never) => Promise<T>) =>
    ctx.container.uow.run(tenantA, (tx) => work(tx as never));

  beforeAll(async () => {
    ctx = await createTestContext({ NOTIFICATION_TRANSPORT: 'recording' });
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    facts = new DrizzleOpsLogFacts(ctx.container.database.db);
    wallet = new DrizzleWalletRepository(ctx.container.database.db);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'owner-r5a-balance',
        roleKeys: ['owner'],
      }),
    );
  });

  async function customer(telegramId: string): Promise<UserId> {
    const { customer: created } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(`resolve-${telegramId}`),
      {
        idempotencyKey: `resolve-${telegramId}`,
        telegramUserId: telegramId,
        from: { id: Number(telegramId), first_name: 'نیما', username: `u${telegramId}` },
        botInstanceId: BOT_A,
      },
    );
    return created.id;
  }

  /**
   * Two concurrent movements, the second committing first: the debit stamps its entry, then
   * waits for the customer lock while an operator's credit (no customer lock) commits.
   * Returns both entries; the debit carries the EARLIER `created_at` yet committed LAST.
   */
  async function debitThatWaitedBehindCredit(c: UserId) {
    const adjust = (direction: 'CREDIT' | 'DEBIT', label: string) =>
      ctx.container.wallet.adjust(tenantA, owner, c, {
        idempotencyKey: key(label),
        direction,
        amountMinor: 100_000n,
        currency: 'IRT',
        note: 'آزمایش ترتیب',
      });
    const holder = await ctx.container.database.pool.connect();
    let debit: ReturnType<typeof adjust>;
    let credit: Awaited<ReturnType<typeof adjust>>;
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM customers WHERE id = $1 FOR NO KEY UPDATE', [c]);
      debit = adjust('DEBIT', 'debit');
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = (await exec(
          sql`SELECT 1 FROM pg_stat_activity
               WHERE datname = current_database() AND wait_event_type = 'Lock'
                 AND query ILIKE '%from "customers"%for update%'` as never,
        )) as unknown as { rows: unknown[] };
        if (waiting.rows.length > 0) break;
        if (Date.now() > deadline) throw new Error('the debit never waited for the lock');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      credit = await adjust('CREDIT', 'credit');
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }
    const debited = await debit;
    const rows = (
      (await exec(
        sql`SELECT id, direction FROM wallet_entries WHERE customer_id = ${c}
             ORDER BY created_at, id` as never,
      )) as unknown as { rows: { id: string; direction: string }[] }
    ).rows;
    // The race really happened: the debit carries the earlier stamp.
    expect(rows.map((row) => row.direction)).toEqual(['DEBIT', 'CREDIT']);
    return { debitId: debited.id, creditId: credit.id };
  }

  it('adminAdjustmentFor: the customer message shows each balance as of its own commit', async () => {
    const c = await customer('952001');
    const { debitId, creditId } = await debitThatWaitedBehindCredit(c);
    // Summed by created_at: debit → -100 000, credit → 0.
    expect((await wallet.adminAdjustmentFor(tenantA, creditId))?.balanceAfter).toEqual(
      irt(100_000n),
    );
    expect((await wallet.adminAdjustmentFor(tenantA, debitId))?.balanceAfter).toEqual(irt(0n));
  }, 30_000);

  it('the admin-adjustment ops log agrees: before and after in commit order', async () => {
    const c = await customer('952002');
    const { debitId, creditId } = await debitThatWaitedBehindCredit(c);
    const queued: { values: Record<string, unknown> }[] = [];
    const lane: OpsLogLane = {
      queue: async (_scope, input) => {
        queued.push({ values: input.values as never });
        return undefined;
      },
    };
    const consumer = new LedgerLogConsumer({ lane, facts, words: i18nOpsLogWords });
    const recorded = (entryId: string, reason: string, direction: string): DomainEvent =>
      ({
        eventId: uuid(),
        eventType: 'WalletEntryRecorded',
        eventVersion: 1,
        tenantId: String(tenantA.tenantId),
        aggregateType: 'Wallet',
        aggregateId: c,
        sequence: 1,
        correlationId: 'r5a-balance',
        causationId: null,
        actor: { type: 'SYSTEM_JOB', id: null },
        occurredAt: '2026-10-12T09:30:00.000Z',
        payload: {
          customerId: c,
          entryId,
          direction,
          reason,
          amountMinor: '100000',
          currency: 'IRT',
        },
      }) as unknown as DomainEvent;
    await run((tx) => consumer.handle(recorded(creditId, 'ADMIN_CREDIT', 'CREDIT'), tx));
    await run((tx) => consumer.handle(recorded(debitId, 'ADMIN_DEBIT', 'DEBIT'), tx));
    expect(queued).toHaveLength(2);
    expect(queued[0]!.values).toMatchObject({
      balanceBefore: irt(0n),
      balanceAfter: irt(100_000n),
    });
    expect(queued[1]!.values).toMatchObject({
      balanceBefore: irt(100_000n),
      balanceAfter: irt(0n),
    });
  }, 30_000);

  it('refundedForOrder: a movement that committed after the refund is not in its balance', async () => {
    const c = await customer('952003');
    const panelId = uuid();
    const productId = uuid();
    const orderId = uuid();
    await exec(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelId}, ${tenantA.tenantId}, 'پنل ۱', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await exec(sql`INSERT INTO products (id, tenant_id, title, status, duration_days, traffic_bytes, panel_id, price_amount, price_currency)
      VALUES (${productId}, ${tenantA.tenantId}, 'Plan', 'ACTIVE', 30, 1073741824, ${panelId}, 250000, 'IRT')`);
    await exec(sql`INSERT INTO orders (id, tenant_id, customer_id, state, purpose, product_id, panel_id,
        line_title, line_duration_days, line_traffic_bytes, line_quantity, line_unit_price_amount,
        line_category_name, subtotal_amount, discount_amount, total_amount, currency, quote,
        confirmed_at, settled_at, created_at)
      VALUES (${orderId}, ${tenantA.tenantId}, ${c}, 'PAID', 'NEW_SERVICE', ${productId}, ${panelId},
        'Plan', 30, 1073741824, 1, 250000, 'دسته', 250000, 0, 250000, 'IRT', '{}'::jsonb,
        now(), now(), now())`);

    /*
     * The shape the race leaves, written down directly (the refund path takes the customer
     * lock itself, so it cannot be held back the way an operator's credit can): the opening
     * credit commits first, the REFUND second, and a debit that stamped itself BEFORE the
     * refund but waited for the lock commits third — the outbox `sequence` is the commit order.
     */
    const entry = async (
      direction: 'CREDIT' | 'DEBIT',
      reason: string,
      amount: bigint,
      at: string,
      commitSequence: number,
      withOrder: boolean,
    ) => {
      const id = uuid();
      await exec(sql`INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount,
          currency, reference, order_id, created_at)
        VALUES (${id}, ${tenantA.tenantId}, ${c}, ${direction}, ${reason}, ${amount.toString()}, 'IRT',
          ${key('ref')}, ${withOrder ? orderId : null}, ${at}::timestamptz)`);
      await exec(sql`INSERT INTO outbox_messages (id, tenant_id, aggregate_type, aggregate_id, sequence,
          event_type, event_version, payload, actor, correlation_id, occurred_at, published_at)
        VALUES (${uuid()}, ${tenantA.tenantId}, 'Wallet', ${c}, ${commitSequence}, 'WalletEntryRecorded', 1,
          ${JSON.stringify({ entryId: id })}::jsonb, '{}'::jsonb, 'r5a-balance', ${at}::timestamptz, now())`);
      return id;
    };
    await entry('CREDIT', 'ADMIN_CREDIT', 100_000n, '2026-10-12T09:00:00Z', 1, false);
    await entry('CREDIT', 'REFUND', 50_000n, '2026-10-12T09:02:00Z', 2, true);
    await entry('DEBIT', 'ADMIN_DEBIT', 100_000n, '2026-10-12T09:01:00Z', 3, false);

    const figures = await wallet.refundedForOrder(tenantA, orderId);
    expect(figures?.amount).toEqual(irt(50_000n));
    // By created_at: 100 000 - 100 000 + 50 000 = 50 000, a balance that never existed.
    expect(figures?.balanceAfter).toEqual(irt(150_000n));
  });
});
