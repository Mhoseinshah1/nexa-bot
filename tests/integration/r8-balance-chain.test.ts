import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type Money,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleOpsLogFacts } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/drizzle-ops-log-facts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  tenantA,
  type TestContext,
} from './harness';

/**
 * Round 8 A5 — «موجودی قبل ← بعد» for writes that commit AT THE SAME TIME.
 *
 * Round 5A item 3 moved `refundedForOrder` and `adminAdjustmentFor` onto `balanceInCommitOrder`
 * (`r5a-balance-before-order.test.ts` pins one race each). This suite pins the property the
 * operations log and the customer message both rest on, over several writers released at
 * once: walked in COMMIT order, every movement's «before» is the previous movement's «after»,
 * its «after − before» is its own signed amount, and the last «after» is the wallet's balance.
 * The two customer-message readers agree with that chain entry by entry.
 *
 * The race is forced, never hoped for: a session holds the customer row, the debits (and the
 * refund) stamp their entry from the clock and then queue for that lock, and the operator's
 * credits — which take no customer lock — commit while they wait. Each test asserts the
 * stamps really are out of commit order before it asserts anything else.
 *
 * MUTATION (reverted, both tests failed, restored): `balanceInCommitOrder`'s comparison
 * replaced by `(e.created_at, e.id) <= (last.created_at, last.id)` alone.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const irt = (n: bigint): Money => money(n, 'IRT');
const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

interface ChainRow {
  readonly id: string;
  readonly reason: string;
  readonly signed: bigint;
  readonly seq: number;
  readonly stampRank: number;
}

describe('balance before → after chains in commit order under concurrent writes', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let finance: ActorContext;
  let facts: DrizzleOpsLogFacts;
  let wallet: DrizzleWalletRepository;
  let n = 0;
  const key = (label: string) => `r8-chain-${label}-${String((n += 1))}`;
  const exec = (query: ReturnType<typeof sql>) => ctx.container.database.db.execute(query);

  beforeAll(async () => {
    ctx = await createTestContext({ NOTIFICATION_TRANSPORT: 'recording' });
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await ctx.reset();
    facts = new DrizzleOpsLogFacts(ctx.container.database.db);
    wallet = new DrizzleWalletRepository(ctx.container.database.db);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'owner-r8-chain',
        roleKeys: ['owner'],
      }),
    );
    finance = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'finance-r8-chain',
        roleKeys: ['finance'],
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
        from: { id: Number(telegramId), first_name: 'سارا' },
        botInstanceId: BOT_A,
      },
    );
    return created.id;
  }

  const adjust = (c: UserId, direction: 'CREDIT' | 'DEBIT', amount: bigint) =>
    ctx.container.wallet.adjust(tenantA, owner, c, {
      idempotencyKey: key(direction),
      direction,
      amountMinor: amount,
      currency: 'IRT',
      note: 'آزمایش هم‌زمانی',
    });

  /** Holds the customer row until `release`; resolves once `waiters` sessions queue for a lock. */
  async function holdCustomer(c: UserId) {
    const holder = await ctx.container.database.pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM customers WHERE id = $1 FOR NO KEY UPDATE', [c]);
    return {
      async waitFor(waiters: number): Promise<void> {
        const deadline = Date.now() + 15_000;
        for (;;) {
          const waiting = (await exec(
            sql`SELECT count(*)::int AS n FROM pg_stat_activity
                 WHERE datname = current_database() AND wait_event_type = 'Lock'` as never,
          )) as unknown as { rows: { n: number }[] };
          if ((waiting.rows[0]?.n ?? 0) >= waiters) return;
          if (Date.now() > deadline) throw new Error(`fewer than ${waiters} writers queued`);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      },
      async release(): Promise<void> {
        try {
          await holder.query('COMMIT');
        } finally {
          holder.release();
        }
      },
    };
  }

  /** Every entry of the customer, in commit order (the `WalletEntryRecorded` sequence). */
  async function chainOf(c: UserId): Promise<ChainRow[]> {
    const rows = (
      (await exec(
        sql`SELECT w.id, w.reason,
                   CASE w.direction WHEN 'CREDIT' THEN w.amount ELSE -w.amount END::text AS signed,
                   m.sequence AS seq,
                   rank() OVER (ORDER BY w.created_at, w.id)::int AS stamp_rank
              FROM wallet_entries w
              JOIN outbox_messages m
                ON m.aggregate_type = 'Wallet' AND m.aggregate_id = ${c}
               AND m.event_type = 'WalletEntryRecorded' AND m.payload ->> 'entryId' = w.id::text
             WHERE w.customer_id = ${c}
             ORDER BY m.sequence` as never,
      )) as unknown as {
        rows: { id: string; reason: string; signed: string; seq: number; stamp_rank: number }[];
      }
    ).rows;
    return rows.map((row) => ({
      id: row.id,
      reason: row.reason,
      signed: BigInt(row.signed),
      seq: Number(row.seq),
      stampRank: Number(row.stamp_rank),
    }));
  }

  /** Before/after of every entry, as the operations log reads it, chained in commit order. */
  async function assertChained(c: UserId, chain: readonly ChainRow[]) {
    // The race happened: the stamps are NOT in commit order.
    expect(chain.map((row) => row.stampRank)).not.toEqual(chain.map((_, index) => index + 1));
    let previous = 0n;
    const afters = new Map<string, bigint>();
    for (const row of chain) {
      const around = await ctx.container.uow.run(tenantA, (tx) =>
        facts.balanceAround(tenantA, c, 'IRT', [row.id], tx as never),
      );
      expect(around, `entry ${row.reason} has a balance`).not.toBeNull();
      expect(around?.before, `${row.reason}: before = previous after`).toEqual(irt(previous));
      expect(around?.after, `${row.reason}: after = before + own`).toEqual(
        irt(previous + row.signed),
      );
      previous += row.signed;
      afters.set(row.id, previous);
    }
    const balance = await wallet.balanceOf(tenantA, c, 'IRT');
    expect(balance.amountMinor, 'the last after is the wallet').toBe(previous);
    return afters;
  }

  it('admin credits and debits released together: before of each = after of the one before', async () => {
    const c = await customer('958101');
    await adjust(c, 'CREDIT', 1_000_000n);
    const hold = await holdCustomer(c);
    let debits: Promise<{ id: string }>[];
    let credits: { id: string }[];
    try {
      // Two debits stamp their entries, then queue behind the held row…
      debits = [adjust(c, 'DEBIT', 300_000n), adjust(c, 'DEBIT', 200_000n)];
      await hold.waitFor(2);
      // …while two credits, which take no customer lock, commit at the same moment.
      credits = await Promise.all([adjust(c, 'CREDIT', 50_000n), adjust(c, 'CREDIT', 70_000n)]);
    } finally {
      await hold.release();
    }
    const debited = await Promise.all(debits);

    const chain = await chainOf(c);
    expect(chain).toHaveLength(5);
    const afters = await assertChained(c, chain);
    // The customer message's figure is the same chain's, entry by entry.
    for (const entry of [...credits, ...debited]) {
      const told = await wallet.adminAdjustmentFor(tenantA, entry.id);
      expect(told?.balanceAfter).toEqual(irt(afters.get(entry.id) ?? -1n));
    }
  }, 60_000);

  it('a refund and admin adjustments released together chain the same way', async () => {
    const products = new DrizzleProductRepository(ctx.container.database.db);
    const panelId = ctx.container.ids.uuid();
    await exec(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelId}, ${tenantA.tenantId}, 'Panel R8', 'sanaei', 'https://r8.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, panelId);
    const c = await customer('958102');
    await adjust(c, 'CREDIT', 1_000_000n);

    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: 'یک ماهه',
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const k = key('order');
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(k), {
      idempotencyKey: `${k}-draft`,
      customerId: c,
      productId: product.id,
    });
    const order = await ctx.container.orders.confirm(tenantA, systemActor(k), {
      idempotencyKey: `${k}-confirm`,
      customerId: c,
      orderId: draft.id,
    });
    const { payment } = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor(k),
      c,
      { idempotencyKey: `${k}-manual`, orderId: order.id },
    );
    // The panel can no longer be sold: confirming the transfer refunds the order to the wallet.
    await exec(sql`UPDATE panels SET status = 'DISABLED' WHERE id = ${panelId}`);

    const hold = await holdCustomer(c);
    let debit: Promise<{ id: string }>;
    let refund: Promise<unknown>;
    let credit: { id: string };
    try {
      debit = adjust(c, 'DEBIT', 400_000n);
      await hold.waitFor(1);
      refund = ctx.container.payments.confirmManualTransfer(tenantA, finance, payment.id, {
        idempotencyKey: key('confirm'),
        note: 'کارت به کارت',
      });
      await hold.waitFor(2);
      credit = await adjust(c, 'CREDIT', 30_000n);
    } finally {
      await hold.release();
    }
    const debited = await debit;
    await refund;

    const chain = await chainOf(c);
    expect(chain.map((row) => row.reason)).toContain('REFUND');
    const afters = await assertChained(c, chain);
    const refundRow = chain.find((row) => row.reason === 'REFUND');
    const figures = await wallet.refundedForOrder(tenantA, order.id);
    expect(figures?.amount).toEqual(irt(refundRow?.signed ?? -1n));
    expect(figures?.balanceAfter).toEqual(irt(afters.get(refundRow?.id ?? '') ?? -1n));
    for (const entry of [debited, credit]) {
      expect((await wallet.adminAdjustmentFor(tenantA, entry.id))?.balanceAfter).toEqual(
        irt(afters.get(entry.id) ?? -1n),
      );
    }
  }, 60_000);
});
