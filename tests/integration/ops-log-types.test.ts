import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CATALOGUE_FA, DEFAULT_TEMPLATE_PRESENTATION, renderTemplateBody } from '@nexa/i18n';
import {
  money,
  systemJobActor,
  templateDefinition,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type DomainEvent,
  type TemplateKey,
  type UserId,
} from '@nexa/contracts';
import { DrizzleOpsLogFacts } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/drizzle-ops-log-facts';
import { i18nOpsLogWords } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import { LedgerLogConsumer } from '../../apps/api/src/modules/commerce/ops-log/application/ledger-log.consumer';
import { CustomerLogConsumer } from '../../apps/api/src/modules/commerce/ops-log/application/customer-log.consumer';
import type { OpsLogLane } from '../../apps/api/src/modules/commerce/ops-log/application/ports';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * Round 4 PR-D — the wallet and customer logs against a real database, and the per-type
 * switches and the optional storm roll-up on the real notification lane.
 *
 * MUTATION (the money rules, each checked by reverting it and watching the named test fail):
 *  - `balanceAround`: `before = after - own` written `after + own`  -> the first test;
 *  - the commission read from the BUYER's wallet instead of the referrer's -> the commission test;
 *  - the gift's balance read before the entry (the old bot's "unchanged" figure) -> the gift test;
 *  - dropping the `source !== 'NEXA'` refusal in a consumer -> the import test.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const customerActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

interface Queued {
  readonly input: Parameters<OpsLogLane['queue']>[1];
}

describe('the ops log: wallet figures, imports, switches and the storm roll-up', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let ownerId: string;
  let facts: DrizzleOpsLogFacts;
  let n = 0;
  const key = (): string => `oplog-types-${(n += 1)}`;
  let queued: Queued[] = [];
  const lane: OpsLogLane = {
    queue: async (_scope, input) => {
      queued.push({ input });
      return undefined;
    },
  };

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);
  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    queued = [];
    facts = new DrizzleOpsLogFacts(ctx.container.database.db);
    const admin = await createAdmin(ctx.container, tenantA, {
      username: 'owner-oplog',
      displayName: 'مدیر آزمایشی',
      roleKeys: ['owner'],
    });
    owner = adminActorFor(admin);
    ownerId = admin.id;
  });

  async function customer(telegramId: string, firstName: string): Promise<UserId> {
    const { customer: created } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      customerActor(`resolve-${telegramId}`),
      {
        idempotencyKey: `resolve-${telegramId}`,
        telegramUserId: telegramId,
        from: { id: Number(telegramId), first_name: firstName, username: `u${telegramId}` },
        botInstanceId: BOT_A,
      },
    );
    return created.id;
  }

  /** One ledger row, at an explicit instant so the order is the test's, not the clock's. */
  async function entry(input: {
    customerId: string;
    direction: 'CREDIT' | 'DEBIT';
    reason: string;
    amount: bigint;
    at: string;
    reference?: string;
    note?: string;
    adminId?: string;
    currency?: string;
  }): Promise<string> {
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount, currency,
                                  reference, note, actor_admin_id, created_at)
      VALUES (${id}, ${tenantA.tenantId}, ${input.customerId}, ${input.direction}, ${input.reason},
              ${input.amount.toString()}, ${input.currency ?? 'IRT'},
              ${input.reference ?? `ref-${key()}`}, ${input.note ?? null},
              ${input.adminId ?? null}, ${input.at}::timestamptz)`);
    return id;
  }

  function recorded(customerId: string, entryId: string, reason: string, direction: string) {
    return event('WalletEntryRecorded', customerId, {
      customerId,
      entryId,
      direction,
      reason,
      amountMinor: '1',
      currency: 'IRT',
    });
  }

  function event(eventType: string, aggregateId: string, payload: unknown): DomainEvent {
    return {
      eventId: ctx.container.ids.uuid(),
      eventType,
      eventVersion: 1,
      tenantId: String(tenantA.tenantId),
      aggregateType: 'Test',
      aggregateId,
      sequence: 1,
      correlationId: 'oplog-types',
      causationId: null,
      actor: { type: 'SYSTEM_JOB', id: null },
      occurredAt: '2026-10-12T09:30:00.000Z',
      payload,
    } as unknown as DomainEvent;
  }

  const run = <T>(work: (tx: never) => Promise<T>) =>
    ctx.container.uow.run(tenantA, (tx) => work(tx as never));

  const render = (templateKey: string, values: never): string =>
    renderTemplateBody(
      templateDefinition(templateKey as TemplateKey),
      CATALOGUE_FA[templateKey as TemplateKey],
      values,
      'fa',
      DEFAULT_TEMPLATE_PRESENTATION,
    );

  // -------------------------------------------------------------------------------------

  it('derives the wallet before and after from the ledger: one entry, several entries, never another wallet', async () => {
    const a = await customer('940001', 'الف');
    const b = await customer('940002', 'ب');
    const first = await entry({
      customerId: a,
      direction: 'CREDIT',
      reason: 'ADMIN_CREDIT',
      amount: 100_000n,
      at: '2026-10-12T08:00:00Z',
    });
    const second = await entry({
      customerId: a,
      direction: 'CREDIT',
      reason: 'ADMIN_CREDIT',
      amount: 50_000n,
      at: '2026-10-12T08:10:00Z',
    });
    // Another customer's money and another currency never enter the sum.
    await entry({
      customerId: b,
      direction: 'CREDIT',
      reason: 'ADMIN_CREDIT',
      amount: 999_999n,
      at: '2026-10-12T08:15:00Z',
    });
    await entry({
      customerId: a,
      direction: 'CREDIT',
      reason: 'ADMIN_CREDIT',
      amount: 7n,
      at: '2026-10-12T08:16:00Z',
      currency: 'USD',
    });
    const third = await entry({
      customerId: a,
      direction: 'DEBIT',
      reason: 'ADMIN_DEBIT',
      amount: 30_000n,
      at: '2026-10-12T08:20:00Z',
    });
    // A later movement is after the figure being asked for.
    await entry({
      customerId: a,
      direction: 'CREDIT',
      reason: 'ADMIN_CREDIT',
      amount: 1_000_000n,
      at: '2026-10-12T09:00:00Z',
    });

    const around = (ids: string[]) => run((tx) => facts.balanceAround(tenantA, a, 'IRT', ids, tx));
    expect(await around([first])).toEqual({
      before: money(0n, 'IRT'),
      after: money(100_000n, 'IRT'),
    });
    expect(await around([second])).toEqual({
      before: money(100_000n, 'IRT'),
      after: money(150_000n, 'IRT'),
    });
    expect(await around([third])).toEqual({
      before: money(150_000n, 'IRT'),
      after: money(120_000n, 'IRT'),
    });
    // Several entries of one operation: the wallet on either side of ALL of them.
    expect(await around([second, third])).toEqual({
      before: money(100_000n, 'IRT'),
      after: money(120_000n, 'IRT'),
    });
    expect(await around([])).toBeNull();
  });

  it('L7: an administrator’s credit and debit show the real balance before and after, the admin, and a user button', async () => {
    const c = await customer('940010', 'سارا');
    await entry({
      customerId: c,
      direction: 'CREDIT',
      reason: 'ADMIN_CREDIT',
      amount: 40_000n,
      at: '2026-10-12T07:00:00Z',
    });
    const credit = await entry({
      customerId: c,
      direction: 'CREDIT',
      reason: 'ADMIN_CREDIT',
      amount: 100_000n,
      at: '2026-10-12T08:00:00Z',
      note: 'جبران',
      adminId: ownerId,
    });
    const debit = await entry({
      customerId: c,
      direction: 'DEBIT',
      reason: 'ADMIN_DEBIT',
      amount: 30_000n,
      at: '2026-10-12T09:00:00Z',
      note: 'اصلاح',
      adminId: ownerId,
    });
    const consumer = new LedgerLogConsumer({ lane, facts, words: i18nOpsLogWords });

    await run((tx) => consumer.handle(recorded(c, credit, 'ADMIN_CREDIT', 'CREDIT'), tx));
    await run((tx) => consumer.handle(recorded(c, debit, 'ADMIN_DEBIT', 'DEBIT'), tx));
    expect(queued).toHaveLength(2);
    const [creditMsg, debitMsg] = queued.map((one) => one.input);
    expect(creditMsg!.logType).toBe('ADMIN_WALLET');
    expect(creditMsg!.values).toMatchObject({
      balanceBefore: money(40_000n, 'IRT'),
      balanceAfter: money(140_000n, 'IRT'),
      adminName: 'مدیر آزمایشی',
    });
    expect(debitMsg!.values).toMatchObject({
      balanceBefore: money(140_000n, 'IRT'),
      balanceAfter: money(110_000n, 'IRT'),
    });
    expect(creditMsg!.buttons).toEqual([{ kind: 'USER', ref: c }]);
    const text = render(creditMsg!.templateKey, creditMsg!.values as never);
    expect(text).toContain('۴۰٬۰۰۰ تومان ← ۱۴۰٬۰۰۰ تومان');
    expect(text).not.toMatch(/NaN|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
  });

  it('L8: the commission is the REFERRER’s wallet, before and after, with the buyer apart', async () => {
    const referrer = await customer('940020', 'رضا');
    const buyer = await customer('940021', 'نیما');
    await entry({
      customerId: referrer,
      direction: 'CREDIT',
      reason: 'ADMIN_CREDIT',
      amount: 5_000n,
      at: '2026-10-12T07:00:00Z',
    });
    // The buyer's own wallet is unrelated and larger: reading it would show the wrong figure.
    await entry({
      customerId: buyer,
      direction: 'CREDIT',
      reason: 'ADMIN_CREDIT',
      amount: 900_000n,
      at: '2026-10-12T07:00:00Z',
    });
    const commission = await entry({
      customerId: referrer,
      direction: 'CREDIT',
      reason: 'REFERRAL_COMMISSION',
      amount: 12_500n,
      at: '2026-10-12T08:00:00Z',
    });
    const consumer = new LedgerLogConsumer({ lane, facts, words: i18nOpsLogWords });

    await run((tx) =>
      consumer.handle(recorded(referrer, commission, 'REFERRAL_COMMISSION', 'CREDIT'), tx),
    );
    expect(queued).toHaveLength(1);
    const message = queued[0]!.input;
    expect(message.logType).toBe('REFERRAL_COMMISSION');
    expect(message.values).toMatchObject({
      balanceBefore: money(5_000n, 'IRT'),
      balanceAfter: money(17_500n, 'IRT'),
      amount: money(12_500n, 'IRT'),
    });
    expect(render(message.templateKey, message.values as never)).toContain(
      '۵٬۰۰۰ تومان ← ۱۷٬۵۰۰ تومان',
    );
    void buyer;
  });

  it('L9: the signup gift shows each side’s REAL balance, never the same figure before and after', async () => {
    const referrer = await customer('940030', 'معرف');
    const referee = await customer('940031', 'زیرمجموعه');
    const referralId = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO referrals (id, tenant_id, referrer_id, referee_id, trigger)
      VALUES (${referralId}, ${tenantA.tenantId}, ${referrer}, ${referee}, 'ON_FIRST_PAID_ORDER')`);
    await entry({
      customerId: referrer,
      direction: 'CREDIT',
      reason: 'ADMIN_CREDIT',
      amount: 7_000n,
      at: '2026-10-12T07:00:00Z',
    });
    const refereeGift = await entry({
      customerId: referee,
      direction: 'CREDIT',
      reason: 'REFERRAL_SIGNUP_GIFT',
      amount: 20_000n,
      at: '2026-10-12T08:00:00Z',
      reference: `${referralId}:signup-gift:REFEREE`,
    });
    const referrerGift = await entry({
      customerId: referrer,
      direction: 'CREDIT',
      reason: 'REFERRAL_SIGNUP_GIFT',
      amount: 20_000n,
      at: '2026-10-12T08:00:01Z',
      reference: `${referralId}:signup-gift:REFERRER`,
    });
    const consumer = new LedgerLogConsumer({ lane, facts, words: i18nOpsLogWords });

    // The referee's gift lands first: the referrer's side has nothing to show yet.
    await run((tx) =>
      consumer.handle(recorded(referee, refereeGift, 'REFERRAL_SIGNUP_GIFT', 'CREDIT'), tx),
    );
    const first = queued[0]!.input.values;
    expect(first).toMatchObject({
      refereeBefore: money(0n, 'IRT'),
      refereeAfter: money(20_000n, 'IRT'),
    });
    expect(first).toMatchObject({
      referrerBefore: money(7_000n, 'IRT'),
      referrerAfter: money(27_000n, 'IRT'),
    });

    await run((tx) =>
      consumer.handle(recorded(referrer, referrerGift, 'REFERRAL_SIGNUP_GIFT', 'CREDIT'), tx),
    );
    const second = queued[1]!.input.values as Record<string, unknown>;
    expect(second['refereeBefore']).not.toEqual(second['refereeAfter']);
    expect(second['referrerBefore']).not.toEqual(second['referrerAfter']);
    expect(second).toMatchObject({
      referrerBefore: money(7_000n, 'IRT'),
      referrerAfter: money(27_000n, 'IRT'),
    });
  });

  it('an import produces no group message: an imported customer’s movements, registration and opening balance say nothing', async () => {
    const imported = await customer('940040', 'قدیمی');
    await ctx.container.database.db.execute(
      sql`UPDATE customers SET source = 'MIRZA', source_ref = 'm-940040' WHERE id = ${imported}`,
    );
    // The importer's own writer, so the row has the exact shape the migration gives it.
    await ctx.container.migrationOpeningBalance.post(
      tenantA,
      systemJobActor('legacy-import:test', 'corr-oplog-import' as CorrelationId),
      {
        customerId: imported,
        telegramUserId: '940040',
        legacyBalanceMinor: 500_000n,
        currency: 'IRT',
      },
    );
    const opening = (
      (await ctx.container.database.db.execute(
        sql`SELECT id FROM wallet_entries WHERE customer_id = ${imported}
              AND reason = 'MIGRATION_OPENING_BALANCE'` as never,
      )) as unknown as { rows: { id: string }[] }
    ).rows[0]!.id;
    const credit = await entry({
      customerId: imported,
      direction: 'CREDIT',
      reason: 'ADMIN_CREDIT',
      amount: 1_000n,
      at: '2026-10-12T08:00:00Z',
      adminId: ownerId,
    });
    const ledger = new LedgerLogConsumer({ lane, facts, words: i18nOpsLogWords });
    const customers = new CustomerLogConsumer({ lane, facts, words: i18nOpsLogWords });

    await run((tx) =>
      ledger.handle(recorded(imported, opening, 'MIGRATION_OPENING_BALANCE', 'CREDIT'), tx),
    );
    await run((tx) => ledger.handle(recorded(imported, credit, 'ADMIN_CREDIT', 'CREDIT'), tx));
    await run((tx) => customers.handle(event('CustomerRegistered', imported, {}), tx));
    await run((tx) => customers.handle(event('CustomerBlocked', imported, {}), tx));
    expect(queued).toEqual([]);

    // The same customer as a native one DOES say something, so the silence above is the rule.
    await ctx.container.database.db.execute(
      sql`UPDATE customers SET source = 'NEXA', source_ref = NULL WHERE id = ${imported}`,
    );
    await run((tx) => customers.handle(event('CustomerRegistered', imported, {}), tx));
    expect(queued.map((one) => one.input.logType)).toEqual(['USER_NEW']);
  });

  it('no operations-log consumer subscribes to an import’s events', () => {
    const consumers = (
      ctx.container.relay as unknown as {
        consumers: { name: string; subscribesTo: readonly string[] }[];
      }
    ).consumers;
    const logging = consumers.filter(
      (one) =>
        one.name.startsWith('ops-log.') ||
        one.name === 'payments.financial-log' ||
        one.name === 'tickets.support-notify',
    );
    expect(logging.length).toBeGreaterThanOrEqual(7);
    for (const one of logging) {
      for (const imported of [
        'CustomerImported',
        'ServiceAdopted',
        'LegacyImportMapRow',
        'LegacyImportReviewStateChanged',
      ]) {
        expect(one.subscribesTo, `${one.name} must not hear ${imported}`).not.toContain(imported);
      }
    }
  });

  // -------------------------------------------------------------------------------------
  // The per-type switches and the storm roll-up, on the real lane
  // -------------------------------------------------------------------------------------

  async function enableLane(): Promise<void> {
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'ops_notifications',
      enabled: true,
      expectedVersion: null,
      idempotencyKey: key(),
      confirmKey: 'ops_notifications',
      reason: 'ops log types test',
    });
  }

  async function setting(settingKey: string, value: unknown): Promise<void> {
    await ctx.container.settingsService.set(tenantA, owner, {
      key: settingKey,
      value,
      expectedVersion: null,
      idempotencyKey: key(),
    });
  }

  const userNewValues = {
    displayName: 'نیما',
    username: '@nima',
    telegramId: '1',
    at: new Date('2026-10-12T09:30:00Z'),
  };

  async function post(logType: 'USER_NEW' | 'PAYMENT_TOPUP', dedupeKey: string) {
    return ctx.container.notifications.queue(tenantA, {
      kind: 'OPERATIONAL_EVENT',
      dedupeKey,
      templateKey: (logType === 'USER_NEW'
        ? 'ops.log.user_new'
        : 'ops.financial.topup_credited') as TemplateKey,
      values: logType === 'USER_NEW' ? userNewValues : topupValues,
      logType,
    });
  }
  const topupValues = {
    method: 'کارت به کارت',
    displayName: 'نیما',
    username: '@nima',
    telegramId: '1',
    reference: 'ABCD2345',
    principal: money(1_000n, 'IRT'),
    fee: money(0n, 'IRT'),
    payable: money(1_000n, 'IRT'),
    gift: money(0n, 'IRT'),
    at: new Date('2026-10-12T09:30:00Z'),
  };

  const notificationRows = async (templateKey: string) =>
    (
      (await ctx.container.database.db.execute(
        sql`SELECT payload, destination FROM notifications
             WHERE tenant_id = ${tenantA.tenantId} AND template_key = ${templateKey}` as never,
      )) as unknown as {
        rows: { payload: Record<string, unknown>; destination: Record<string, unknown> }[];
      }
    ).rows;

  it('a type switched off queues nothing; the others, and the type once switched back on, do', async () => {
    await enableLane();
    await setting('ops.log.disabled_types', ['USER_NEW']);

    expect((await post('USER_NEW', 'sw-1')).created).toBe(false);
    expect((await post('PAYMENT_TOPUP', 'sw-2')).created).toBe(true);
    expect(await notificationRows('ops.log.user_new')).toEqual([]);
    expect(await notificationRows('ops.financial.topup_credited')).toHaveLength(1);

    // Switching it back on (the next version of the same setting) applies to the next message.
    const current = await ctx.container.settingsService.get(
      tenantA,
      owner,
      'ops.log.disabled_types',
    );
    await ctx.container.settingsService.set(tenantA, owner, {
      key: 'ops.log.disabled_types',
      value: [],
      expectedVersion: (current as unknown as { version: number }).version,
      idempotencyKey: key(),
    });
    expect((await post('USER_NEW', 'sw-3')).created).toBe(true);
    const [row] = await notificationRows('ops.log.user_new');
    // The type's own topic is the destination's, not SYSTEM.
    expect(row!.destination).toMatchObject({ opsTopic: 'USERS' });
  });

  const stormInput = (customerId: string, dedupeKey: string) => ({
    kind: 'OPERATIONAL_EVENT' as const,
    dedupeKey,
    templateKey: 'ops.log.error_provision' as TemplateKey,
    values: {
      displayName: 'نیما',
      username: '@nima',
      telegramId: customerId,
      cause: 'ساخت روی پنل ممکن نشد',
      technical: 'HTTP 502',
      impact: 'مبلغ به کیف پولش برگشت',
      productTitle: 'پلن',
      amount: money(1_000n, 'IRT'),
      at: new Date('2026-10-12T09:30:00Z'),
    },
    logType: 'ERROR_PROVISION' as const,
    storm: {
      key: 'panel-a:502',
      customer: customerId,
      rollup: { heading: 'خطای ساخت سرویس', cause: 'ساخت روی پنل ممکن نشد', technical: 'HTTP 502' },
    },
  });

  it('the storm roll-up is OFF by default: every identical error is its own message, however many', async () => {
    await enableLane();
    for (let i = 0; i < 30; i += 1) {
      const result = await ctx.container.notifications.queue(
        tenantA,
        stormInput(`c${String(i)}`, `st-${String(i)}`),
      );
      expect(result.created).toBe(true);
    }
    expect(await notificationRows('ops.log.error_provision')).toHaveLength(30);
    expect(await notificationRows('ops.log.storm_rollup')).toEqual([]);
  });

  it('with the roll-up ON, errors past the threshold are merged into one roll-up per window', async () => {
    await enableLane();
    await setting('ops.log.storm_rollup_enabled', true);
    await setting('ops.log.storm_threshold', 3);
    const results: boolean[] = [];
    for (let i = 0; i < 8; i += 1) {
      const result = await ctx.container.notifications.queue(
        tenantA,
        stormInput(`c${String(i % 4)}`, `st-${String(i)}`),
      );
      results.push(result.created);
    }
    // The first three are their own messages; none of the rest is.
    expect(results).toEqual([true, true, true, false, false, false, false, false]);
    expect(await notificationRows('ops.log.error_provision')).toHaveLength(3);
    const rollups = await notificationRows('ops.log.storm_rollup');
    expect(rollups).toHaveLength(1);
    // Five errors from four customers, counted once each.
    expect(rollups[0]!.payload).toMatchObject({ count: 5, users: expect.any(Number) });
  });
});
