import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  systemJobActor,
  TELEGRAM_MESSAGE_STATE_RETENTION_DAYS,
  type BotInstanceId,
  type CorrelationId,
  type TelegramWizardKind,
  type TelegramWizardStep,
  type TenantContext,
} from '@nexa/contracts';
import { TelegramMessageRetentionLoop } from '../../apps/api/src/modules/commerce/messaging/application/telegram-message-retention-loop';
import { SEED_IDS, tenantB } from './harness';
import {
  BOT_A,
  ledgerCount,
  paymentState,
  pendingWithReceipt,
  receiptFixture,
  rows,
  systemActor,
  tapOn,
  TG,
  TENANT_A,
  type ReceiptFixture,
} from './receipt-review-fixture';

/**
 * Retention for `telegram_wizards` and `telegram_review_messages`
 * (`docs/telegram-retention.md`), against the real PostgreSQL statements and the real
 * gates.
 *
 * What it pins, rule by rule:
 *
 *   - a row something live still names survives: touched within the retention period,
 *     held by a lease, showing a payment still `PENDING`/`UNKNOWN`, an `ORDER` wizard whose
 *     order is not done, a review row whose payment is not terminal;
 *   - an old row nothing names is removed, and its chat's purge horizon is raised in the
 *     same transaction;
 *   - a tap on a removed row's message is stale — never adopted, never decided again — so
 *     it moves no money and asks for nothing;
 *   - a sweep racing a tap never lets the tap adopt a row the sweep removed;
 *   - one tenant's sweep never reads or removes another tenant's rows;
 *   - each pass is bounded, and a loop tick stops at its ceiling.
 */
const DAY = 86_400_000;
const OLD = TELEGRAM_MESSAGE_STATE_RETENTION_DAYS + 5;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;
const CHAT = '910777';

describe('Telegram message-state retention', () => {
  let f: ReceiptFixture;

  beforeAll(async () => {
    f = await receiptFixture();
  }, 120_000);

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
  });

  const c = () => f.ctx.container;
  const db = () => f.ctx.container.database.db;
  const ago = (days: number) => new Date(c().clock.now().getTime() - days * DAY);
  const job = (key: string) => systemJobActor('retention-test', key as CorrelationId);
  const purge = (scope: TenantContext = TENANT_A, limit = 500) =>
    c().telegramMessageState.purgeExpired(scope, job(`purge-${String(Math.random())}`), limit);

  async function wizard(
    messageId: number,
    options: {
      readonly scope?: TenantContext;
      readonly bot?: BotInstanceId;
      readonly chat?: string;
      readonly step?: TelegramWizardStep;
      readonly kind?: TelegramWizardKind;
      readonly ageDays?: number;
      readonly subjectId?: string | null;
      readonly paymentId?: string | null;
      readonly busyUntil?: Date | null;
    } = {},
  ): Promise<void> {
    const at = ago(options.ageDays ?? OLD);
    await db().execute(sql`
      INSERT INTO telegram_wizards
        (id, tenant_id, bot_instance_id, chat_id, message_id, kind, step, version,
         subject_id, payment_id, busy_until, created_at, updated_at)
      VALUES (${c().ids.uuid()}, ${(options.scope ?? TENANT_A).tenantId}, ${options.bot ?? BOT_A},
              ${options.chat ?? CHAT}, ${messageId}, ${options.kind ?? 'ORDER'},
              ${options.step ?? 'CLOSED'}, 3, ${options.subjectId ?? null},
              ${options.paymentId ?? null}, ${options.busyUntil ?? null}, ${at}, ${at})`);
  }

  async function review(
    messageId: number,
    paymentId: string,
    options: { readonly createdDays?: number; readonly finalisedDays?: number | null } = {},
  ): Promise<void> {
    const finalised =
      options.finalisedDays === undefined
        ? ago(OLD)
        : options.finalisedDays === null
          ? null
          : ago(options.finalisedDays);
    await db().execute(sql`
      INSERT INTO telegram_review_messages
        (id, tenant_id, bot_instance_id, chat_id, message_id, payment_id, role, has_media,
         finalised_at, created_at)
      VALUES (${c().ids.uuid()}, ${TENANT_A.tenantId}, ${BOT_A}, ${CHAT}, ${messageId},
              ${paymentId}, 'REVIEW', true, ${finalised}, ${ago(options.createdDays ?? OLD)})`);
  }

  const wizardIds = async (scope: TenantContext = TENANT_A) =>
    (
      await rows<{ message_id: string }>(
        f,
        sql`SELECT message_id::text AS message_id FROM telegram_wizards
            WHERE tenant_id = ${scope.tenantId} ORDER BY message_id`,
      )
    ).map((row) => Number(row.message_id));
  const reviewIds = async () =>
    (
      await rows<{ message_id: string }>(
        f,
        sql`SELECT message_id::text AS message_id FROM telegram_review_messages
            WHERE tenant_id = ${TENANT_A.tenantId} ORDER BY message_id`,
      )
    ).map((row) => Number(row.message_id));
  const horizon = async (scope: TenantContext = TENANT_A, chat = CHAT) =>
    Number(
      (
        await rows<{ through: string }>(
          f,
          sql`SELECT purged_through_message_id::text AS through FROM telegram_message_horizons
              WHERE tenant_id = ${scope.tenantId} AND chat_id = ${chat}`,
        )
      )[0]?.through ?? 0,
    );

  /** A pending transfer's payment and the order it is for. */
  async function pending(key: string): Promise<{ payment: string; order: string }> {
    const payment = await pendingWithReceipt(f, key);
    const found = await rows<{ order_id: string }>(
      f,
      sql`SELECT order_id FROM payments WHERE id = ${payment}`,
    );
    return { payment, order: found[0]?.order_id ?? 'MISSING' };
  }

  /** A transfer approved through the receipt tap: CONFIRMED, its order PAID. */
  async function confirmed(key: string, messageId: number): Promise<string> {
    const payment = await pendingWithReceipt(f, key);
    await tapOn(f, `D:${payment}`, TG.owner, { id: messageId, photo: true }).result;
    expect(await paymentState(f, payment)).toBe('CONFIRMED');
    return payment;
  }

  // ---------------------------------------------------------------------------------------
  // Wizards
  // ---------------------------------------------------------------------------------------

  it('an active wizard survives: recent, leased, an open payment, an unfinished order', async () => {
    const open = await pending('w-active');
    await wizard(101, { step: 'PREINVOICE', ageDays: TELEGRAM_MESSAGE_STATE_RETENTION_DAYS - 1 });
    await wizard(102, { step: 'CLOSED', busyUntil: new Date(c().clock.now().getTime() + 60_000) });
    await wizard(103, { step: 'INVOICE', paymentId: open.payment });
    await wizard(104, { step: 'AWAITING_PAYMENT', subjectId: open.order });
    const draft = await c().orders.createDraft(TENANT_A, systemActor('w-draft'), {
      idempotencyKey: 'w-active-draft-2',
      customerId: f.customer,
      productId: (await rows<{ id: string }>(f, sql`SELECT id FROM products LIMIT 1`))[0]
        ?.id as never,
    });
    await wizard(105, { step: 'PREINVOICE', subjectId: draft.id });

    expect(await purge()).toEqual({ wizards: 0, reviews: 0 });
    expect(await wizardIds()).toEqual([101, 102, 103, 104, 105]);
    expect(await horizon()).toBe(0);
  });

  it('an old wizard nothing names is removed, and its chat horizon is raised in the same commit', async () => {
    const done = await confirmed('w-done', 501);
    await wizard(201, { step: 'CLOSED' });
    await wizard(202, { step: 'NOTICE', kind: 'TOPUP' });
    await wizard(203, { step: 'INVOICE', paymentId: done });
    // A lease that ran out long ago holds nothing.
    await wizard(204, { step: 'PRODUCTS', busyUntil: ago(OLD) });
    // An order wizard whose order is PAID: nothing will close or settle it through here.
    const order = (
      await rows<{ order_id: string }>(f, sql`SELECT order_id FROM payments WHERE id = ${done}`)
    )[0]?.order_id;
    await wizard(205, { step: 'AWAITING_PAYMENT', subjectId: order ?? null });
    // A payment id with no payment row (the column has no foreign key): nothing open.
    await wizard(206, { step: 'INVOICE', paymentId: c().ids.uuid() });
    await wizard(150, { step: 'CLOSED', ageDays: 1 });

    expect(await purge()).toEqual({ wizards: 6, reviews: 0 });
    expect(await wizardIds()).toEqual([150]);
    expect(await horizon()).toBe(206);
    // Business truth is untouched.
    expect(await paymentState(f, done)).toBe('CONFIRMED');
  });

  it('the horizon only rises: a later purge of lower message ids does not lower it', async () => {
    await wizard(300, { step: 'CLOSED' });
    await purge();
    expect(await horizon()).toBe(300);
    await wizard(120, { step: 'CLOSED' });
    await purge();
    expect(await horizon()).toBe(300);
  });

  it('a stale tap on a removed wizard is never adopted: STALE, and nothing is written', async () => {
    await wizard(400, { step: 'CLOSED' });
    await purge();
    const claimed = await c().telegramMessageState.claim(TENANT_A, systemActor('stale'), {
      ref: { botInstanceId: BOT_A, chatId: CHAT, messageId: 400 },
      kind: 'ORDER',
      adoptAs: 'ORDER',
      from: ['PREINVOICE'],
      updateKey: 'stale-400',
    });
    expect(claimed.outcome).toBe('STALE');
    expect(await wizardIds()).toEqual([]);
    // Above the horizon an untracked message is still adopted, exactly as before.
    const fresh = await c().telegramMessageState.claim(TENANT_A, systemActor('fresh'), {
      ref: { botInstanceId: BOT_A, chatId: CHAT, messageId: 401 },
      kind: 'ORDER',
      adoptAs: 'ORDER',
      from: ['PREINVOICE'],
      updateKey: 'fresh-401',
    });
    expect(fresh.outcome).toBe('CLAIMED');
    // And in another chat the horizon is not this one's.
    const elsewhere = await c().telegramMessageState.claim(TENANT_A, systemActor('else'), {
      ref: { botInstanceId: BOT_A, chatId: '910778', messageId: 300 },
      kind: 'ORDER',
      adoptAs: 'ORDER',
      from: ['PREINVOICE'],
      updateKey: 'else-300',
    });
    expect(elsewhere.outcome).toBe('CLAIMED');
  });

  it('a sweep racing taps on its rows: a tap never adopts a row the sweep removed, and a won claim keeps its row', async () => {
    const ROUNDS = 25;
    for (let round = 0; round < ROUNDS; round += 1) {
      const base = 1000 + round * 10;
      // A closed wizard whose old keyboard still shows a pre-invoice button.
      await wizard(base, { step: 'CLOSED' });
      // A notice whose button a tap may legitimately still claim.
      await wizard(base + 1, { step: 'NOTICE', kind: 'TOPUP' });
      const tap = (messageId: number, from: TelegramWizardStep[], kind: TelegramWizardKind) =>
        c().telegramMessageState.claim(TENANT_A, systemActor(`race-${String(messageId)}`), {
          ref: { botInstanceId: BOT_A, chatId: CHAT, messageId },
          kind,
          adoptAs: kind,
          from,
          updateKey: `race-${String(messageId)}`,
        });
      const [, closedTap, noticeTap] = await Promise.all([
        purge(),
        tap(base, ['PREINVOICE'], 'ORDER'),
        tap(base + 1, ['NOTICE'], 'TOPUP'),
      ]);
      // The closed one: whichever came first, never adopted as a fresh pre-invoice.
      expect(closedTap.outcome).toBe('STALE');
      const left = await rows<{ message_id: string; step: string }>(
        f,
        sql`SELECT message_id::text AS message_id, step FROM telegram_wizards
            WHERE tenant_id = ${TENANT_A.tenantId} AND message_id IN (${base}, ${base + 1})`,
      );
      expect(left.filter((row) => row.step === 'PREINVOICE')).toEqual([]);
      // The notice: a won claim kept its row; a lost one found it gone and moved nothing.
      const notice = left.find((row) => Number(row.message_id) === base + 1);
      if (noticeTap.outcome === 'CLAIMED') expect(notice?.step).toBe('NOTICE');
      else expect(notice).toBeUndefined();
    }
    expect(await horizon()).toBeGreaterThanOrEqual(1000);
  });

  // ---------------------------------------------------------------------------------------
  // Review messages
  // ---------------------------------------------------------------------------------------

  it('an active review row survives: its payment still pending, or finalised recently', async () => {
    const open = await pending('r-open');
    const done = await confirmed('r-recent', 502);
    await review(601, open.payment, { finalisedDays: null });
    // A block finalises the reviewer's copy and leaves the payment pending: kept.
    await review(602, open.payment, { finalisedDays: OLD });
    await review(603, done, {
      createdDays: OLD,
      finalisedDays: TELEGRAM_MESSAGE_STATE_RETENTION_DAYS - 1,
    });
    const before = await reviewIds();
    await purge();
    expect(await reviewIds()).toEqual(before);
    expect(before).toEqual(expect.arrayContaining([601, 602, 603]));
  });

  it('an old review row of a terminal payment is removed, finalised or not', async () => {
    const done = await confirmed('r-old', 503);
    await review(701, done, { finalisedDays: OLD });
    // Decided elsewhere (the Web Admin, an expiry) and never finalised here.
    await review(702, done, { finalisedDays: null });
    const result = await purge();
    expect(result.reviews).toBeGreaterThanOrEqual(2);
    expect(await reviewIds()).not.toEqual(expect.arrayContaining([701]));
    expect(await reviewIds()).not.toEqual(expect.arrayContaining([702]));
    expect(await horizon()).toBe(702);
  });

  it('a stale review tap after cleanup only answers: no second decision, no money, no message', async () => {
    const payment = await pendingWithReceipt(f, 'r-stale');
    await tapOn(f, `D:${payment}`, TG.owner, { id: 801, photo: true }).result;
    expect(await paymentState(f, payment)).toBe('CONFIRMED');
    const ledger = await ledgerCount(f);
    await db().execute(sql`
      UPDATE telegram_review_messages SET created_at = ${ago(OLD)}, finalised_at = ${ago(OLD)}
       WHERE tenant_id = ${TENANT_A.tenantId} AND payment_id = ${payment}`);
    expect((await purge()).reviews).toBeGreaterThanOrEqual(1);
    const left = await rows<{ n: number }>(
      f,
      sql`SELECT count(*)::int AS n FROM telegram_review_messages WHERE payment_id = ${payment}`,
    );
    expect(Number(left[0]?.n)).toBe(0);

    for (const data of [`D:${payment}`, `E:${payment}`]) {
      const again = await tapOn(f, data, TG.owner, { id: 801, photo: true }).result;
      expect(again.replyKey).toBeNull();
      expect(f.sent.map((one) => one.method)).toEqual(['answerCallbackQuery']);
    }
    expect(await paymentState(f, payment)).toBe('CONFIRMED');
    expect(await ledgerCount(f)).toBe(ledger);
    const orders = await rows<{ state: string }>(
      f,
      sql`SELECT o.state FROM orders o JOIN payments p ON p.order_id = o.id WHERE p.id = ${payment}`,
    );
    expect(orders.map((o) => o.state)).toEqual(['PAID']);
    // Nothing was recorded again for the old message.
    const recorded = await rows<{ n: number }>(
      f,
      sql`SELECT count(*)::int AS n FROM telegram_review_messages WHERE payment_id = ${payment}`,
    );
    expect(Number(recorded[0]?.n)).toBe(0);
  });

  // ---------------------------------------------------------------------------------------
  // Tenancy, bounds, the loop
  // ---------------------------------------------------------------------------------------

  it("tenant A's sweep never touches tenant B, and B's horizon is its own", async () => {
    await wizard(901, { step: 'CLOSED' });
    await wizard(902, { step: 'CLOSED', scope: tenantB, bot: BOT_B });
    await purge(TENANT_A);
    expect(await wizardIds(TENANT_A)).toEqual([]);
    expect(await wizardIds(tenantB)).toEqual([902]);
    expect(await horizon(tenantB)).toBe(0);
    // A tap in tenant B on the same chat and a lower id is not stale because of A.
    const claimed = await c().telegramMessageState.claim(tenantB, systemActor('b-tap'), {
      ref: { botInstanceId: BOT_B, chatId: CHAT, messageId: 900 },
      kind: 'ORDER',
      adoptAs: 'ORDER',
      from: ['PREINVOICE'],
      updateKey: 'b-900',
    });
    expect(claimed.outcome).toBe('CLAIMED');
    await purge(tenantB);
    expect(await wizardIds(tenantB)).toEqual([900]);
    expect(await horizon(tenantB)).toBe(902);
    expect(await horizon(TENANT_A)).toBe(901);
  });

  it('a stopped scope removes nothing', async () => {
    await wizard(950, { step: 'CLOSED' });
    await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${TENANT_A.tenantId}`);
    try {
      expect(await purge()).toEqual({ wizards: 0, reviews: 0 });
      expect(await wizardIds()).toEqual([950]);
    } finally {
      await db().execute(sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${TENANT_A.tenantId}`);
    }
  });

  it('each pass is bounded, and a loop tick stops at its ceiling and leaves the rest for the next', async () => {
    for (let id = 1; id <= 7; id += 1) await wizard(2000 + id, { step: 'CLOSED' });
    expect((await purge(TENANT_A, 3)).wizards).toBe(3);
    // Oldest first: all seven are equally old, so the lowest ids by tie-break.
    expect((await wizardIds()).length).toBe(4);

    const warnings: unknown[] = [];
    const loop = new TelegramMessageRetentionLoop(c().telegramMessageState, {
      scope: () => TENANT_A,
      intervalMs: 3_600_000,
      initialDelayMs: 1_000,
      batchSize: 1,
      maxBatchesPerTick: 2,
      now: () => c().clock.now().getTime(),
      ids: c().ids,
      opsLog: { record: () => Promise.reject(new Error('not expected')) },
      logger: {
        info: () => undefined,
        warn: (context) => warnings.push(context),
        error: () => undefined,
      },
    });
    expect(await loop.tick()).toEqual({ wizards: 2, reviews: 0 });
    expect(warnings).toHaveLength(1);
    expect((await wizardIds()).length).toBe(2);
    expect(await loop.tick()).toEqual({ wizards: 2, reviews: 0 });
    expect(await loop.tick()).toEqual({ wizards: 0, reviews: 0 });
    expect(await wizardIds()).toEqual([]);
  });
});
