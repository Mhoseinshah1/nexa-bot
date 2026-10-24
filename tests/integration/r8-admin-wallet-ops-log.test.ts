import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CATALOGUE_FA, DEFAULT_TEMPLATE_PRESENTATION, renderTemplateBody } from '@nexa/i18n';
import {
  templateDefinition,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type UserId,
} from '@nexa/contracts';
import { deserialiseValues } from '../../apps/api/src/modules/control/notifications/application/notification-dispatcher';
import { CustomerNotifier } from '../../apps/api/src/modules/commerce/messaging/application/customer-notifier';
import { BulkOperationProcessor } from '../../apps/api/src/modules/commerce/bulk-operations/application/bulk-operation-processor';
import { DrizzleBulkOperationRepository } from '../../apps/api/src/modules/commerce/bulk-operations/infrastructure/drizzle-bulk-operation.repository';
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
 * Round 8 A4 — an administrator's wallet adjustment reaches the operations group's PAYMENTS
 * topic, through the real write path (`WalletService.adjust`), the real outbox relay and the
 * real notification lane.
 *
 * The owner's report: the customer was told, the group heard nothing. On an installation
 * migrated from the previous bot every customer is imported, and the L7 consumer refused an
 * imported customer outright — but only an operator writes ADMIN_CREDIT/ADMIN_DEBIT, so that
 * silence protected nothing. The message now also says whether the customer is told, and
 * carries «پروفایل کاربر» and «تراکنش».
 *
 * MUTATION (each reverted, the named test failed, restored):
 *  - the `customer.source !== 'NEXA'` refusal put back in `LedgerLogConsumer.adjusted`
 *    -> 'an imported customer's adjustment…';
 *  - `customerNotified` read from the CREDIT switch for a debit -> the same test;
 *  - the mass-credit total read as the operation's amount × item count instead of the ledger's
 *    MASS_CREDIT entries -> 'a mass credit is one summary…'.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

interface Row {
  readonly payload: Record<string, unknown>;
  readonly destination: Record<string, unknown>;
  readonly template_key: string;
}

describe('R8 A4: the admin wallet adjustment in the operations group', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let n = 0;
  const key = (label = 'k'): string => `r8-a4-${label}-${String((n += 1))}`;

  beforeAll(async () => {
    ctx = await createTestContext({ NOTIFICATION_TRANSPORT: 'recording' });
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'owner_r8',
        displayName: 'مدیر هشت',
        roleKeys: ['owner'],
      }),
    );
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'ops_notifications',
      enabled: true,
      expectedVersion: null,
      idempotencyKey: key('lane'),
      confirmKey: 'ops_notifications',
      reason: 'r8 a4 test',
    });
  });

  async function customer(telegramId: string, imported: boolean): Promise<UserId> {
    const { customer: created } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(`resolve-${telegramId}`),
      {
        idempotencyKey: `resolve-${telegramId}`,
        telegramUserId: telegramId,
        from: { id: Number(telegramId), first_name: 'مریم', username: `u${telegramId}` },
        botInstanceId: BOT_A,
      },
    );
    if (imported) {
      await ctx.container.database.db.execute(
        sql`UPDATE customers SET source = 'MIRZA', source_ref = ${`m-${telegramId}`}
             WHERE id = ${created.id}`,
      );
    }
    return created.id;
  }

  async function drain(): Promise<void> {
    for (let pass = 0; pass < 10; pass += 1) await ctx.container.relay.processBatch();
  }

  const rows = async (templateKey: string): Promise<Row[]> =>
    (
      (await ctx.container.database.db.execute(
        sql`SELECT payload, destination, template_key FROM notifications
             WHERE tenant_id = ${tenantA.tenantId} AND template_key = ${templateKey}
             ORDER BY created_at, id` as never,
      )) as unknown as { rows: Row[] }
    ).rows;

  const text = (row: Row): string =>
    renderTemplateBody(
      templateDefinition(row.template_key as never),
      CATALOGUE_FA[row.template_key as never],
      deserialiseValues({ templateKey: row.template_key, payload: row.payload }),
      'fa',
      DEFAULT_TEMPLATE_PRESENTATION,
    );

  it('an imported customer’s adjustment is posted to PAYMENTS: before → after, who, notified, two buttons', async () => {
    const c = await customer('958201', true);
    // The debit's customer notice is switched off; the credit's stays on (the default).
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'wallet_admin_debit_notice',
      enabled: false,
      expectedVersion: null,
      idempotencyKey: key('flag'),
      confirmKey: 'wallet_admin_debit_notice',
      reason: 'r8 a4 test',
    });
    await ctx.container.wallet.adjust(tenantA, owner, c, {
      idempotencyKey: key('credit'),
      direction: 'CREDIT',
      amountMinor: 150_000n,
      currency: 'IRT',
      note: 'جبران قطعی سرور',
    });
    await ctx.container.wallet.adjust(tenantA, owner, c, {
      idempotencyKey: key('debit'),
      direction: 'DEBIT',
      amountMinor: 40_000n,
      currency: 'IRT',
      note: 'اصلاح اشتباه',
    });
    await drain();

    const posted = await rows('ops.log.wallet_adjusted');
    expect(posted).toHaveLength(2);
    for (const row of posted) {
      expect(row.destination).toMatchObject({ opsTopic: 'PAYMENTS' });
      expect(row.payload['__buttons']).toEqual([
        { kind: 'USER', ref: c },
        { kind: 'WALLET', ref: c },
      ]);
    }
    const [credit, debit] = posted.map(text);
    expect(credit).toContain('➕ افزایش دستی موجودی — ۱۵۰٬۰۰۰ تومان');
    expect(credit).toContain('👛 موجودی: ۰ تومان ← ۱۵۰٬۰۰۰ تومان');
    expect(credit).toContain('مدیر هشت · @owner_r8');
    expect(credit).toContain('@u958201 · 958201');
    expect(credit).toContain('جبران قطعی سرور');
    expect(credit).toContain('🔔 اطلاع به کاربر: بله');
    // The time in Jalali (۱۴۰۵/…), never an ISO string.
    expect(credit).toMatch(/🕒 ۱۴۰[0-9۰-۹]/u);
    expect(credit).not.toMatch(/T[0-9۰-۹]{2}:/u);
    expect(debit).toContain('➖ کاهش دستی موجودی — ۴۰٬۰۰۰ تومان');
    expect(debit).toContain('👛 موجودی: ۱۵۰٬۰۰۰ تومان ← ۱۱۰٬۰۰۰ تومان');
    expect(debit).toContain('🔔 اطلاع به کاربر: خیر');
  }, 60_000);

  it('a mass credit is one summary for the operation, its total read from the ledger', async () => {
    await customer('958211', false);
    await customer('958212', true);
    const grant = {
      kind: 'WALLET_CREDIT' as const,
      amountMinor: '25000',
      currency: 'IRT' as const,
    };
    const definition = { version: 1 as const };
    const preview = await ctx.container.bulkOperations.preview(tenantA, owner, {
      grant,
      definition,
    });
    expect(preview.count).toBe(2);
    const operation = await ctx.container.bulkOperations.create(tenantA, owner, {
      idempotencyKey: key('bulk'),
      grant,
      definition,
      notify: true,
      note: 'هدیهٔ نوروزی',
      expectedDefinitionHash: preview.definitionHash,
      expectedCount: preview.count,
      expectedFingerprint: preview.fingerprint,
      expectedTotalMinor: preview.totalLiability?.amountMinor ?? null,
      typedCount: preview.count,
      notBefore: null,
    });
    let sellingCalls = 0;
    const processor = new BulkOperationProcessor({
      repository: new DrizzleBulkOperationRepository(ctx.container.database.db),
      wallet: new DrizzleWalletRepository(ctx.container.database.db),
      grants: ctx.container.provisioning,
      notifier: new CustomerNotifier({
        notifications: ctx.container.customerNotifications,
        bots: { botFor: async () => SEED_IDS.botA1 as never },
        ids: ctx.container.ids,
      }),
      outbox: ctx.container.outbox,
      uow: ctx.container.uow,
      scopeActivity: { scopeIsActive: async () => true },
      // The second customer finds the installation's currency changed and is SKIPPED, so the
      // ledger total (one credit) differs from the planned amount × audience (two).
      sellingCurrency: async () => ((sellingCalls += 1) === 1 ? 'IRT' : ('USD' as never)),
      clock: ctx.container.clock,
      ids: ctx.container.ids,
      logger: { info: () => undefined, error: () => undefined },
    });
    await processor.pass(tenantA);
    await processor.pass(tenantA);
    expect((await ctx.container.bulkOperations.get(tenantA, owner, operation.id)).state).toBe(
      'COMPLETED',
    );
    await drain();
    await drain();

    const summary = await rows('ops.log.wallet_mass_credited');
    expect(summary).toHaveLength(1);
    expect(summary[0]!.destination).toMatchObject({ opsTopic: 'PAYMENTS' });
    expect(summary[0]!.payload['__buttons']).toEqual([
      { kind: 'BULK_OPERATION', ref: operation.id },
    ]);
    const body = text(summary[0]!);
    expect(body).toContain('۲۵٬۰۰۰ تومان برای هر کاربر');
    expect(body).toContain('👥 شارژشده: ۱ کاربر');
    expect(body).toContain('⏭ ردشده: ۱ کاربر');
    expect(body).toContain('💵 جمع واریز: ۲۵٬۰۰۰ تومان');
    expect(body).toContain('هدیهٔ نوروزی');
    expect(body).toContain('🔔 اطلاع به کاربران: بله');
    // Never one message per customer.
    expect(await rows('ops.log.wallet_adjusted')).toEqual([]);
  }, 60_000);
});
