import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIENCE_ERROR_CODES,
  BULK_ERROR_CODES,
  type ActorContext,
  type AudienceDefinitionInput,
  type BulkGrant,
  type BulkPreview,
  type Clock,
} from '@nexa/contracts';
import { CustomerNotifier } from '../../apps/api/src/modules/commerce/messaging/application/customer-notifier';
import { BulkOperationProcessor } from '../../apps/api/src/modules/commerce/bulk-operations/application/bulk-operation-processor';
import { DrizzleBulkOperationRepository } from '../../apps/api/src/modules/commerce/bulk-operations/infrastructure/drizzle-bulk-operation.repository';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';
import { AudienceFixtures } from './audience-fixtures';

/**
 * Safe mass actions (round N, B2): the money is credited exactly once whatever crashes,
 * cancels or replays in between; a grant is a real provisioning operation whose UNKNOWN
 * outcome is never replayed blind; and nothing is processed before `notBefore`.
 */

class StoppedClock implements Clock {
  private at = Date.now() + 5_000;
  now(): Date {
    return new Date(this.at);
  }
  advance(ms: number): void {
    this.at += ms;
  }
}

const AMOUNT = 50_000n;

describe('mass operations', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let fixtures: AudienceFixtures;
  let clock: StoppedClock;
  let key = 0;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-bulk', roleKeys: ['owner'] }),
    );
    fixtures = new AudienceFixtures(ctx, tenantA.tenantId as string);
    clock = new StoppedClock();
  });

  const idem = () => `bulk-${(key += 1)}-${Date.now()}`;

  function processor(
    wallet: Pick<DrizzleWalletRepository, 'append'> = new DrizzleWalletRepository(
      ctx.container.database.db,
    ),
  ) {
    return new BulkOperationProcessor({
      repository: new DrizzleBulkOperationRepository(ctx.container.database.db),
      wallet,
      grants: ctx.container.provisioning,
      notifier: new CustomerNotifier({
        notifications: ctx.container.customerNotifications,
        bots: { botFor: async () => SEED_IDS.botA1 as never },
        ids: ctx.container.ids,
      }),
      outbox: ctx.container.outbox,
      uow: ctx.container.uow,
      scopeActivity: { scopeIsActive: async () => true },
      sellingCurrency: async () => 'IRT',
      clock,
      ids: ctx.container.ids,
      logger: { info: () => undefined, error: () => undefined },
    });
  }

  async function customers(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push(
        await fixtures.customer({
          telegramUserId: `66${String(1000 + index)}`,
          botInstanceId: SEED_IDS.botA1,
        }),
      );
    }
    return ids;
  }

  const credit: BulkGrant = {
    kind: 'WALLET_CREDIT',
    amountMinor: AMOUNT.toString(),
    currency: 'IRT',
  };

  async function confirm(
    grant: BulkGrant,
    definition: AudienceDefinitionInput = { version: 1 },
    options: { notify?: boolean; notBefore?: Date | null; preview?: BulkPreview } = {},
  ) {
    const preview =
      options.preview ??
      (await ctx.container.bulkOperations.preview(tenantA, owner, { grant, definition }));
    return ctx.container.bulkOperations.create(tenantA, owner, {
      idempotencyKey: idem(),
      grant,
      definition,
      notify: options.notify ?? false,
      note: 'Nowruz gift',
      expectedDefinitionHash: preview.definitionHash,
      expectedCount: preview.count,
      expectedFingerprint: preview.fingerprint,
      expectedTotalMinor: preview.totalLiability?.amountMinor ?? null,
      typedCount: preview.count,
      notBefore: options.notBefore ?? null,
    });
  }

  async function massEntries(): Promise<{ customer_id: string; amount: string }[]> {
    const result = await ctx.container.database.db.execute<{ customer_id: string; amount: string }>(
      sql`SELECT customer_id, amount::text AS amount FROM wallet_entries WHERE reason = 'MASS_CREDIT'`,
    );
    return result.rows;
  }

  it('previews the exact count and total liability, and credits each customer exactly once', async () => {
    await customers(3);
    const preview = await ctx.container.bulkOperations.preview(tenantA, owner, {
      grant: credit,
      definition: { version: 1 },
    });
    expect(preview.count).toBe(3);
    expect(preview.totalLiability).toEqual({
      amountMinor: (AMOUNT * 3n).toString(),
      currency: 'IRT',
    });

    const operation = await confirm(credit, { version: 1 }, { preview, notify: true });
    expect(operation.state).toBe('RUNNING');
    await processor().pass(tenantA);
    await processor().pass(tenantA);
    const entries = await massEntries();
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.amount === AMOUNT.toString())).toBe(true);

    const done = await ctx.container.bulkOperations.get(tenantA, owner, operation.id);
    expect(done.state).toBe('COMPLETED');
    const progress = await ctx.container.bulkOperations.progress(tenantA, owner, [operation.id]);
    expect(progress.credited.get(operation.id)).toBe(AMOUNT * 3n);
    expect(progress.counts.get(operation.id)).toMatchObject({ credited: 3, notified: 3 });
    // The customer is told what the ledger holds.
    const notes = await ctx.container.database.db.execute<{ kind: string }>(
      sql`SELECT kind FROM customer_notifications WHERE kind = 'WALLET_MASS_CREDITED'`,
    );
    expect(notes.rows).toHaveLength(3);
    const subject = await ctx.container.database.db.execute<{ subject_id: string }>(
      sql`SELECT subject_id FROM customer_notifications WHERE kind = 'WALLET_MASS_CREDITED' LIMIT 1`,
    );
    const values = await new DrizzleBulkOperationRepository(
      ctx.container.database.db,
    ).notificationValues(tenantA, 'WALLET_MASS_CREDITED', subject.rows[0]?.subject_id as string);
    expect(values).toMatchObject({ amountMinor: AMOUNT, currency: 'IRT' });
  });

  it('survives a crash mid-item: the rolled-back credit is written once on resume', async () => {
    await customers(3);
    const operation = await confirm(credit);
    const real = new DrizzleWalletRepository(ctx.container.database.db);
    let crashes = 1;
    const crashing: Pick<DrizzleWalletRepository, 'append'> = {
      append: async (scope, draft, tx) => {
        const result = await real.append(scope, draft, tx);
        if (crashes > 0) {
          crashes -= 1;
          // The process dies after the entry is written and before the item commits.
          throw new Error('worker died');
        }
        return result;
      },
    };
    await processor(crashing).pass(tenantA, 1);
    expect(await massEntries()).toHaveLength(0);
    await processor(crashing).pass(tenantA);
    await processor().pass(tenantA);
    expect(await massEntries()).toHaveLength(3);
    expect((await ctx.container.bulkOperations.get(tenantA, owner, operation.id)).state).toBe(
      'COMPLETED',
    );
  });

  it('a replayed confirmation is the same operation, and cancel/resume cannot double credit', async () => {
    await customers(3);
    const preview = await ctx.container.bulkOperations.preview(tenantA, owner, {
      grant: credit,
      definition: { version: 1 },
    });
    const command = {
      idempotencyKey: idem(),
      grant: credit,
      definition: { version: 1 },
      notify: false,
      note: 'gift',
      expectedDefinitionHash: preview.definitionHash,
      expectedCount: preview.count,
      expectedFingerprint: preview.fingerprint,
      expectedTotalMinor: preview.totalLiability?.amountMinor ?? null,
      typedCount: preview.count,
      notBefore: null,
    };
    const first = await ctx.container.bulkOperations.create(tenantA, owner, command);
    const again = await ctx.container.bulkOperations.create(tenantA, owner, command);
    expect(again.id).toBe(first.id);

    await processor().pass(tenantA, 1);
    expect(await massEntries()).toHaveLength(1);
    await ctx.container.bulkOperations.cancel(tenantA, owner, first.id);
    await ctx.container.bulkOperations.cancel(tenantA, owner, first.id);
    await processor().pass(tenantA);
    await processor().pass(tenantA);
    expect(await massEntries()).toHaveLength(1);
    const progress = await ctx.container.bulkOperations.progress(tenantA, owner, [first.id]);
    expect(progress.counts.get(first.id)).toMatchObject({ credited: 1, cancelled: 2, pending: 0 });
    expect(progress.credited.get(first.id)).toBe(AMOUNT);
  });

  it('processes nothing before notBefore, and a cancel before it credits nothing', async () => {
    await customers(2);
    const later = new Date(clock.now().getTime() + 3_600_000);
    const scheduled = await confirm(credit, { version: 1 }, { notBefore: later });
    expect(scheduled.notBefore?.toISOString()).toBe(later.toISOString());
    await processor().pass(tenantA);
    expect(await massEntries()).toHaveLength(0);

    await ctx.container.bulkOperations.cancel(tenantA, owner, scheduled.id);
    clock.advance(2 * 3_600_000);
    await processor().pass(tenantA);
    expect(await massEntries()).toHaveLength(0);
    const progress = await ctx.container.bulkOperations.progress(tenantA, owner, [scheduled.id]);
    expect(progress.counts.get(scheduled.id)).toMatchObject({ cancelled: 2, credited: 0 });

    // And one that is not cancelled runs once its time comes.
    const next = await confirm(
      credit,
      { version: 1 },
      { notBefore: new Date(clock.now().getTime() + 60_000) },
    );
    await processor().pass(tenantA);
    expect(await massEntries()).toHaveLength(0);
    clock.advance(61_000);
    await processor().pass(tenantA);
    expect(await massEntries()).toHaveLength(2);
    expect((await ctx.container.bulkOperations.get(tenantA, owner, next.id)).state).toBe(
      'COMPLETED',
    );
  });

  it('refuses a confirmation whose audience moved, a wrong liability and an untyped count', async () => {
    await customers(2);
    const preview = await ctx.container.bulkOperations.preview(tenantA, owner, {
      grant: credit,
      definition: { version: 1 },
    });
    await fixtures.customer({ telegramUserId: '669999' });
    await expect(confirm(credit, { version: 1 }, { preview })).rejects.toMatchObject({
      code: AUDIENCE_ERROR_CODES.CHANGED,
    });
    const count = await ctx.container.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM bulk_operations`,
    );
    expect(count.rows[0]?.n).toBe(0);

    const fresh = await ctx.container.bulkOperations.preview(tenantA, owner, {
      grant: credit,
      definition: { version: 1 },
    });
    await expect(
      ctx.container.bulkOperations.create(tenantA, owner, {
        idempotencyKey: idem(),
        grant: credit,
        definition: { version: 1 },
        notify: false,
        note: 'gift',
        expectedDefinitionHash: fresh.definitionHash,
        expectedCount: fresh.count,
        expectedFingerprint: fresh.fingerprint,
        expectedTotalMinor: '1',
        typedCount: fresh.count,
        notBefore: null,
      }),
    ).rejects.toMatchObject({ code: BULK_ERROR_CODES.LIABILITY_MISMATCH });
    await expect(
      ctx.container.bulkOperations.create(tenantA, owner, {
        idempotencyKey: idem(),
        grant: credit,
        definition: { version: 1 },
        notify: false,
        note: 'gift',
        expectedDefinitionHash: fresh.definitionHash,
        expectedCount: fresh.count,
        expectedFingerprint: fresh.fingerprint,
        expectedTotalMinor: fresh.totalLiability?.amountMinor ?? null,
        typedCount: null,
        notBefore: null,
      }),
    ).rejects.toMatchObject({ code: BULK_ERROR_CODES.CONFIRMATION_REQUIRED });

    // An operator without users.wallet.mass cannot even preview.
    const finance = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'fin-bulk', roleKeys: ['finance'] }),
    );
    await expect(
      ctx.container.bulkOperations.preview(tenantA, finance, {
        grant: credit,
        definition: { version: 1 },
      }),
    ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
  });

  it('grants traffic through real operations, and leaves an UNKNOWN outcome to reconciliation', async () => {
    const panel = await fixtures.panel('grant');
    await makePanelSellable(ctx.container, tenantA, panel);
    const disabled = await fixtures.panel('off', 'DISABLED');
    const [a, b, c] = await customers(3);
    const serviceA = await fixtures.service({ customerId: a as string, panelId: panel });
    const serviceB = await fixtures.service({ customerId: b as string, panelId: panel });
    // Not eligible: unlimited traffic, a panel that is off, an expired service.
    await fixtures.service({ customerId: c as string, panelId: panel, trafficLimitBytes: 0n });
    await fixtures.service({ customerId: c as string, panelId: disabled });
    await fixtures.service({ customerId: c as string, panelId: panel, state: 'EXPIRED' });

    const grant: BulkGrant = { kind: 'SERVICE_TRAFFIC', trafficGb: '10' };
    const preview = await ctx.container.bulkOperations.preview(tenantA, owner, {
      grant,
      definition: { version: 1, service: {} },
    });
    expect(preview.count).toBe(2);
    expect(preview.trafficBytesPerItem).toBe((10n * 1_073_741_824n).toString());
    const operation = await confirm(grant, { version: 1, service: {} }, { preview, notify: true });

    await processor().pass(tenantA);
    await processor().pass(tenantA);
    const ops = await ctx.container.database.db.execute<{
      id: string;
      service_id: string;
      type: string;
      target: string;
      requested: string | null;
    }>(
      sql`SELECT id, service_id, type, target_traffic_limit_bytes::text AS target,
                 requested_by_customer_id AS requested
            FROM provisioning_operations ORDER BY service_id`,
    );
    // One free ADD_TRAFFIC per eligible service, absolute target, asked by nobody.
    expect(ops.rows).toHaveLength(2);
    expect(ops.rows.map((row) => row.service_id).sort()).toEqual([serviceA, serviceB].sort());
    expect(ops.rows.every((row) => row.type === 'ADD_TRAFFIC' && row.requested === null)).toBe(
      true,
    );
    expect(ops.rows[0]?.target).toBe((53_687_091_200n + 10n * 1_073_741_824n).toString());

    // One lands UNKNOWN: the item waits for reconciliation and nobody is told anything.
    const [first, second] = ops.rows;
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET state = 'UNKNOWN' WHERE id = ${first?.id}::uuid`,
    );
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET state = 'SUCCEEDED', completed_at = now()
           WHERE id = ${second?.id}::uuid`,
    );
    await processor().pass(tenantA);
    await processor().pass(tenantA);
    let progress = await ctx.container.bulkOperations.progress(tenantA, owner, [operation.id]);
    expect(progress.counts.get(operation.id)).toMatchObject({
      planned: 1,
      awaitingReconciliation: 1,
      succeeded: 1,
      notified: 1,
    });
    expect((await ctx.container.bulkOperations.get(tenantA, owner, operation.id)).state).toBe(
      'RUNNING',
    );
    // Never replayed: still exactly two operations.
    const count = await ctx.container.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM provisioning_operations`,
    );
    expect(count.rows[0]?.n).toBe(2);

    // Reconciliation decides; only then is the item settled.
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET state = 'FAILED', completed_at = now()
           WHERE id = ${first?.id}::uuid`,
    );
    await processor().pass(tenantA);
    progress = await ctx.container.bulkOperations.progress(tenantA, owner, [operation.id]);
    expect(progress.counts.get(operation.id)).toMatchObject({
      succeeded: 1,
      failed: 1,
      notified: 1,
    });
    // Told only of the grant that SUCCEEDED, with what it gave.
    const told = await ctx.container.database.db.execute<{ subject_id: string }>(
      sql`SELECT subject_id FROM customer_notifications WHERE kind = 'SERVICE_GIFT_APPLIED'`,
    );
    expect(told.rows).toHaveLength(1);
    const gift = await new DrizzleBulkOperationRepository(
      ctx.container.database.db,
    ).notificationValues(tenantA, 'SERVICE_GIFT_APPLIED', told.rows[0]?.subject_id as string);
    expect(gift).toMatchObject({ trafficBytes: 10n * 1_073_741_824n, durationDays: null });
    expect(gift?.serviceLabel).toMatch(/^nx/);
    expect((await ctx.container.bulkOperations.get(tenantA, owner, operation.id)).state).toBe(
      'COMPLETED',
    );
  });
});
