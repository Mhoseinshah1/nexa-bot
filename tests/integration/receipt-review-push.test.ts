import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminId, DomainEvent, PaymentId } from '@nexa/contracts';
import type { TransactionScope } from '../../apps/api/src/infrastructure/persistence/unit-of-work';
import {
  RECEIPT_PUSH_FAILED_CODE,
  receiptPushConditionKey,
} from '../../apps/api/src/modules/commerce/payments/application/receipt-review-push.service';
import { DrizzleReceiptReviewFactsReader } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-receipt-review-facts.reader';
import { createAdmin, tenantA, tenantB } from './harness';
import {
  BOT_A,
  TG,
  bindNewAdmin,
  fileReceipt,
  keyboardOf,
  ledgerCount,
  paymentState,
  pendingWithReceipt,
  photoUpdate,
  receiptFixture,
  rows,
  signalledTransfer,
  systemActor,
  type ReceiptFixture,
} from './receipt-review-fixture';

/**
 * The administrators' receipt push (WP10 follow-up §3, ADR-0031), end to end against real
 * PostgreSQL, the real relay, the real consumer, the real dispatcher and a real socket
 * standing in for Telegram whose answer is chosen per chat.
 *
 * The chain under test: `ReceiptService.submit` writes `PaymentReceiptSubmitted` beside the
 * receipt → the relay runs the fan-out consumer → one `receipt_review_pushes` row per eligible
 * administrator → `ReceiptReviewPushService.deliverDue` sends ONE media message per row.
 */

interface PushRow {
  admin_id: string;
  state: string;
  attempts: number;
  chat_id: string | null;
  last_error_code: string | null;
  next_attempt_at: Date | null;
}

describe('the administrators’ receipt push', () => {
  let f: ReceiptFixture;
  let reviewer: AdminId;
  let observer: AdminId;
  let disabled: AdminId;
  let unbound: AdminId;

  beforeAll(async () => {
    f = await receiptFixture();
  }, 120_000);

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    // Eligible: holds receipts.review. Nothing else — no credit, no block, no users.view.
    reviewer = await bindNewAdmin(f, 'reviewer', TG.reviewer, [
      'payments.view',
      'receipts.view',
      'receipts.review',
    ]);
    // Bound, and may LOOK at receipts, but not decide them.
    observer = await bindNewAdmin(f, 'observer', TG.observer, ['payments.view', 'receipts.view']);
    // Holds the permission, and is disabled.
    disabled = await bindNewAdmin(f, 'disabled', TG.disabled, [
      'payments.view',
      'receipts.view',
      'receipts.review',
    ]);
    await f.ctx.container.database.db.execute(
      sql`UPDATE admins SET status = 'DISABLED', disabled_at = now() WHERE id = ${disabled}`,
    );
    // Holds the permission, and has no Telegram binding at all.
    unbound = await bindNewAdmin(f, 'unbound', null, [
      'payments.view',
      'receipts.view',
      'receipts.review',
    ]);
    // Another tenant's owner, bound: every permission, in the wrong installation.
    await createAdmin(f.ctx.container, tenantB, {
      username: 'owner-b',
      roleKeys: ['owner'],
      telegramUserId: TG.tenantB,
    });
  });

  const relay = () => f.ctx.container.relay.processBatch();
  const deliver = () => f.ctx.container.receiptReviewPush.deliverDue(tenantA, 50);

  async function pushes(paymentId: string): Promise<PushRow[]> {
    return rows<PushRow>(
      f,
      sql`SELECT admin_id, state, attempts, chat_id, last_error_code, next_attempt_at
            FROM receipt_review_pushes WHERE payment_id = ${paymentId} ORDER BY created_at, id`,
    );
  }

  const stateOf = async (paymentId: string, adminId: string) =>
    (await pushes(paymentId)).find((row) => row.admin_id === adminId);

  const filesTo = (chat: string) =>
    f.sent.filter(
      (one) =>
        ['sendPhoto', 'sendDocument', 'sendMessage'].includes(one.method) &&
        String(one.body['chat_id']) === chat,
    );

  /** Every row made due now, keeping `next_attempt_at` the only thing that changes. */
  async function makeDue(): Promise<void> {
    await f.ctx.container.database.db.execute(sql`
      UPDATE receipt_review_pushes SET next_attempt_at = now() - interval '1 second'
       WHERE state = 'PENDING'`);
  }

  async function events(code: string): Promise<{ dedupe_key: string; resolved_at: Date | null }[]> {
    return rows(
      f,
      sql`SELECT dedupe_key, resolved_at FROM operational_events WHERE code = ${code} ORDER BY first_seen_at`,
    );
  }

  // =========================================================================
  // Who
  // =========================================================================

  it('pushes ONE media message to each eligible administrator — both of them — and to nobody else', async () => {
    const payment = await pendingWithReceipt(f, 'who', 'از کارت همسرم');
    await relay();
    f.sent = [];

    const report = await deliver();

    expect(report).toMatchObject({ claimed: 2, delivered: 2 });
    const rowsNow = await pushes(payment);
    expect(rowsNow.map((row) => row.admin_id).sort()).toEqual([f.ownerId, reviewer].sort());
    expect(rowsNow.every((row) => row.state === 'DELIVERED')).toBe(true);

    // ONE message per administrator, and it is the photo: the facts ride on it.
    for (const chat of [TG.owner, TG.reviewer]) {
      const messages = filesTo(chat);
      expect(messages.map((one) => one.method)).toEqual(['sendPhoto']);
      const body = messages[0]?.body ?? {};
      expect(body['photo']).toBe('file-who');
      expect(String(body['caption'])).toContain('از کارت همسرم');
      expect(String(body['caption'])).toContain(TG.customer);
    }
    // Nobody else: not the observer, the disabled one, the unbound one or tenant B's owner.
    for (const chat of [TG.observer, TG.disabled, TG.tenantB]) {
      expect(filesTo(chat)).toEqual([]);
    }
    expect(
      rowsNow.some((row) => [observer, disabled, unbound].includes(row.admin_id as AdminId)),
    ).toBe(false);

    // The buttons are each administrator's own: the owner all four, the reviewer two.
    expect(keyboardOf(filesTo(TG.owner)[0]?.body ?? {}).map((b) => b.callback_data)).toEqual([
      `D:${payment}`,
      `E:${payment}`,
      `wa:${payment}`,
      `xa:${payment}`,
    ]);
    expect(keyboardOf(filesTo(TG.reviewer)[0]?.body ?? {}).map((b) => b.callback_data)).toEqual([
      `D:${payment}`,
      `E:${payment}`,
    ]);
  });

  it('pushes nothing for a tenant B receipt to tenant A, and nothing of tenant A to tenant B', async () => {
    const payment = await pendingWithReceipt(f, 'iso');
    await relay();
    // Tenant B's pass sees none of tenant A's rows.
    const reportB = await f.ctx.container.receiptReviewPush.deliverDue(
      { tenantId: tenantB.tenantId, botInstanceId: null },
      50,
    );
    expect(reportB.claimed).toBe(0);
    expect(filesTo(TG.tenantB)).toEqual([]);
    const tenants = await rows<{ tenant_id: string }>(
      f,
      sql`SELECT DISTINCT tenant_id FROM receipt_review_pushes WHERE payment_id = ${payment}`,
    );
    expect(tenants).toEqual([{ tenant_id: tenantA.tenantId }]);
  });

  // =========================================================================
  // No uncontrolled duplicates, no extra money
  // =========================================================================

  it('writes one event per filed receipt, and none for a redelivered customer update', async () => {
    const payment = await signalledTransfer(f, 'dup');
    const first = await fileReceipt(f, 'dup', 'file-dup');
    const replay = await fileReceipt(f, 'dup', 'file-dup');
    expect(first.filed).toBe(true);
    expect(replay.filed).toBe(true);
    // The SAME file in a NEW message: a new update, a new key, and nothing new filed.
    const resent = await fileReceipt(f, 'dup-again', 'file-dup');
    expect(resent.filed).toBe(false);

    const found = await rows<{ n: number }>(
      f,
      sql`SELECT count(*)::int AS n FROM outbox_messages
           WHERE event_type = 'PaymentReceiptSubmitted' AND aggregate_id = ${payment}`,
    );
    expect(found[0]?.n).toBe(1);
  });

  it('a redelivered customer update through the bot, the same file twice, is one push per administrator', async () => {
    const payment = await signalledTransfer(f, 'bot-dup');
    const update = photoUpdate('file-bot-dup', TG.customer, 'wp10f-redelivered-photo');
    const first = await f.ctx.container.botRuntime.handle(tenantA, systemActor('bot'), update);
    const again = await f.ctx.container.botRuntime.handle(tenantA, systemActor('bot'), update);
    expect(first.replyKey).toBe('bot.payment.receipt_received');
    expect(again.replyKey).toBe('bot.payment.receipt_received');
    await relay();
    await relay();
    f.sent = [];
    await deliver();
    await deliver();

    expect(await pushes(payment)).toHaveLength(2);
    expect(filesTo(TG.owner)).toHaveLength(1);
    expect(filesTo(TG.reviewer)).toHaveLength(1);
    // And the retired Phase 5T poke wrote nothing: one message, not two.
    const pokes = await rows<{ n: number }>(
      f,
      sql`SELECT count(*)::int AS n FROM notifications WHERE kind = 'RECEIPT_AWAITING_REVIEW'`,
    );
    expect(pokes[0]?.n).toBe(0);
  });

  it('an outbox redelivery after a lost consumer claim writes no second row, sends no second message and moves no money', async () => {
    const payment = await pendingWithReceipt(f, 'redeliver');
    await relay();
    f.sent = [];
    await deliver();
    const ledgerBefore = await ledgerCount(f);

    // An outbox REDELIVERY: the message is unpublished again and the relay runs. Its
    // `processed_messages` claim answers "already applied" — and `processed_messages` refuses
    // DELETE by trigger, so a lost claim is staged by calling the consumer again directly,
    // past the claim, where the row's unique key is what stands.
    await f.ctx.container.database.db.execute(sql`
      UPDATE outbox_messages SET published_at = NULL
       WHERE event_type = 'PaymentReceiptSubmitted' AND aggregate_id = ${payment}`);
    const again = await relay();
    expect(again.published).toBeGreaterThanOrEqual(1);
    const consumer = (
      f.ctx.container.relay as unknown as {
        consumers: {
          name: string;
          handle: (event: DomainEvent, tx: TransactionScope) => Promise<void>;
        }[];
      }
    ).consumers.find((one) => one.name === 'payments.receipt-review-push');
    if (consumer === undefined) throw new Error('the push consumer is not registered');
    const message = (
      await rows<Record<string, unknown>>(
        f,
        sql`SELECT * FROM outbox_messages
             WHERE event_type = 'PaymentReceiptSubmitted' AND aggregate_id = ${payment}`,
      )
    )[0];
    const event: DomainEvent = {
      eventId: String(message?.['id']),
      eventType: 'PaymentReceiptSubmitted',
      eventVersion: 1,
      tenantId: tenantA.tenantId as string,
      aggregateType: 'Payment',
      aggregateId: payment,
      sequence: 1,
      correlationId: 'replayed',
      causationId: null,
      actor: { type: 'SYSTEM_JOB', id: null },
      occurredAt: new Date().toISOString(),
      payload: message?.['payload'],
    } as DomainEvent;
    await f.ctx.container.uow.run(tenantA, (tx) => consumer.handle(event, tx));
    await deliver();

    expect(await pushes(payment)).toHaveLength(2);
    expect(filesTo(TG.owner)).toHaveLength(1);
    expect(filesTo(TG.reviewer)).toHaveLength(1);
    expect(await ledgerCount(f)).toBe(ledgerBefore);
    expect(await paymentState(f, payment)).toBe('PENDING');
  });

  // =========================================================================
  // Resolved at delivery time
  // =========================================================================

  it('does not send to an administrator whose authority went between the fan-out and the send', async () => {
    const third = await bindNewAdmin(f, 'third', TG.third, [
      'payments.view',
      'receipts.view',
      'receipts.review',
    ]);
    const blocker = await bindNewAdmin(f, 'blocker', TG.blocker, [
      'payments.view',
      'receipts.view',
      'receipts.review',
    ]);
    const payment = await pendingWithReceipt(f, 'revoked');
    await relay();
    expect(await pushes(payment)).toHaveLength(4);

    const db = f.ctx.container.database.db;
    // Disabled.
    await db.execute(
      sql`UPDATE admins SET status = 'DISABLED', disabled_at = now() WHERE id = ${reviewer}`,
    );
    // The role that carried the permission removed.
    await db.execute(sql`DELETE FROM admin_roles WHERE admin_id = ${third}`);
    // The Telegram binding removed.
    await db.execute(sql`UPDATE admins SET telegram_user_id = NULL WHERE id = ${blocker}`);
    f.sent = [];

    await deliver();

    for (const [adminId, chat] of [
      [reviewer, TG.reviewer],
      [third, TG.third],
      [blocker, TG.blocker],
    ] as const) {
      expect(await stateOf(payment, adminId)).toMatchObject({
        state: 'SUPERSEDED',
        last_error_code: 'push.admin_no_authority',
      });
      expect(filesTo(chat)).toEqual([]);
    }
    expect((await stateOf(payment, f.ownerId))?.state).toBe('DELIVERED');
  });

  it('sends to the chat the administrator is bound to AT SEND, not at fan-out', async () => {
    const payment = await pendingWithReceipt(f, 'rebound');
    await relay();
    await f.ctx.container.database.db.execute(
      sql`UPDATE admins SET telegram_user_id = '750777' WHERE id = ${reviewer}`,
    );
    f.sent = [];
    await deliver();
    expect(filesTo(TG.reviewer)).toEqual([]);
    expect(filesTo('750777')).toHaveLength(1);
    expect((await stateOf(payment, reviewer))?.chat_id).toBe('750777');
  });

  it('does not push a receipt that was decided before the send', async () => {
    const payment = await pendingWithReceipt(f, 'decided');
    await relay();
    await f.ctx.container.payments.confirmManualTransfer(tenantA, f.owner, payment, {
      idempotencyKey: 'decided-approve',
      note: 'approved first',
    });
    f.sent = [];
    await deliver();
    const found = await pushes(payment);
    expect(found.every((row) => row.state === 'SUPERSEDED')).toBe(true);
    expect(found.every((row) => row.last_error_code === 'push.payment_decided')).toBe(true);
    expect(f.sent.filter((one) => one.method === 'sendPhoto')).toEqual([]);
  });

  it('writes no row for a receipt decided before the relay reached it', async () => {
    const payment = await pendingWithReceipt(f, 'decided-early');
    await f.ctx.container.payments.rejectManualTransfer(tenantA, f.owner, payment, {
      idempotencyKey: 'decided-early-reject',
      note: 'rejected first',
    });
    await relay();
    expect(await pushes(payment)).toEqual([]);
  });

  // =========================================================================
  // Failure: never loses the receipt, never re-sends an UNKNOWN, isolated, observable
  // =========================================================================

  it('an UNKNOWN send stays UNKNOWN — never DELIVERED, never re-sent — while the other administrator still gets theirs, the receipt stands and the failure is observable', async () => {
    f.behaviour.set(TG.reviewer, 'SERVER_ERROR');
    const payment = await pendingWithReceipt(f, 'unknown');
    await relay();
    f.sent = [];

    await deliver();

    expect(await stateOf(payment, reviewer)).toMatchObject({
      state: 'UNKNOWN',
      last_error_code: 'push.outcome_unknown',
    });
    // Ambiguous is not delivered: the row must never claim a delivery it cannot prove.
    expect((await stateOf(payment, reviewer))?.state).not.toBe('DELIVERED');
    expect((await stateOf(payment, f.ownerId))?.state).toBe('DELIVERED');
    expect(filesTo(TG.reviewer)).toHaveLength(1);

    // Another pass, and another after Telegram recovers: the reviewer is sent nothing more.
    f.behaviour.set(TG.reviewer, 'OK');
    await deliver();
    await deliver();
    expect(filesTo(TG.reviewer)).toHaveLength(1);

    // The receipt and its payment are untouched by any of it.
    const receipts = await rows<{ n: number }>(
      f,
      sql`SELECT count(*)::int AS n FROM payment_receipts WHERE payment_id = ${payment}`,
    );
    expect(receipts[0]?.n).toBe(1);
    expect(await paymentState(f, payment)).toBe('PENDING');

    // And it is on the operational log, once, for that administrator.
    const opened = await events(RECEIPT_PUSH_FAILED_CODE);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.dedupe_key).toBe(receiptPushConditionKey(reviewer));
    expect(opened[0]?.resolved_at).toBeNull();
  });

  it('a send whose process died mid-flight is reaped UNKNOWN, not re-sent', async () => {
    const payment = await pendingWithReceipt(f, 'stranded');
    await relay();
    await f.ctx.container.database.db.execute(sql`
      UPDATE receipt_review_pushes
         SET send_started_at = now() - interval '10 minutes',
             next_attempt_at = now() - interval '5 minutes'
       WHERE admin_id = ${reviewer}`);
    f.sent = [];

    const report = await deliver();

    expect(report.reaped).toBe(1);
    expect(await stateOf(payment, reviewer)).toMatchObject({
      state: 'UNKNOWN',
      last_error_code: 'push.send_stranded',
    });
    expect(filesTo(TG.reviewer)).toEqual([]);
    expect(filesTo(TG.owner)).toHaveLength(1);
  });

  it('a 429 waits Telegram’s own retry_after and spends no attempt', async () => {
    f.behaviour.set(TG.reviewer, 'RATE_LIMITED');
    const payment = await pendingWithReceipt(f, 'limited');
    await relay();
    const before = Date.now();

    await deliver();

    const limited = await stateOf(payment, reviewer);
    expect(limited).toMatchObject({
      state: 'PENDING',
      attempts: 0,
      last_error_code: 'push.rate_limited',
    });
    expect(new Date(String(limited?.next_attempt_at)).getTime()).toBeGreaterThanOrEqual(
      before + 29_000,
    );
    f.sent = [];
    await deliver();
    expect(filesTo(TG.reviewer)).toEqual([]);
  });

  it('a refused file is followed by the same caption and buttons as text', async () => {
    f.behaviour.set(TG.reviewer, 'REFUSE_FILE');
    const payment = await pendingWithReceipt(f, 'fallback');
    await relay();
    f.sent = [];
    await deliver();
    expect(filesTo(TG.reviewer).map((one) => one.method)).toEqual(['sendPhoto', 'sendMessage']);
    expect(keyboardOf(filesTo(TG.reviewer)[1]?.body ?? {}).map((b) => b.callback_data)).toEqual([
      `D:${payment}`,
      `E:${payment}`,
    ]);
    expect((await stateOf(payment, reviewer))?.state).toBe('DELIVERED');
  });

  it('refused on every attempt is FAILED and opens the condition, and the next DELIVERED to that administrator closes it', async () => {
    f.behaviour.set(TG.reviewer, 'REFUSED');
    const payment = await pendingWithReceipt(f, 'refused');
    await relay();
    await deliver();
    await makeDue();
    await deliver();
    await makeDue();
    await deliver();

    expect(await stateOf(payment, reviewer)).toMatchObject({ state: 'FAILED', attempts: 3 });
    expect((await events(RECEIPT_PUSH_FAILED_CODE))[0]?.resolved_at).toBeNull();

    f.behaviour.set(TG.reviewer, 'OK');
    const next = await pendingWithReceipt(f, 'refused-next');
    await relay();
    await deliver();
    expect((await stateOf(next, reviewer))?.state).toBe('DELIVERED');
    expect((await events(RECEIPT_PUSH_FAILED_CODE))[0]?.resolved_at).not.toBeNull();
  });

  it('a fan-out that fails never rolls the receipt back, and is retried by the relay', async () => {
    const payment = await signalledTransfer(f, 'fanout-fails');
    const consumers = (
      f.ctx.container.relay as unknown as {
        consumers: { name: string; deps: { reviewers: { reviewers: () => unknown } } }[];
      }
    ).consumers;
    const consumer = consumers.find((one) => one.name === 'payments.receipt-review-push');
    if (consumer === undefined) throw new Error('the push consumer is not registered');
    const spy = vi
      .spyOn(consumer.deps.reviewers, 'reviewers')
      .mockRejectedValueOnce(new Error('administrators unreadable'));

    const filed = await fileReceipt(f, 'fanout-fails', 'file-fanout-fails');
    expect(filed.filed).toBe(true);
    const failed = await relay();
    expect(failed.failed).toBeGreaterThanOrEqual(1);

    // The receipt committed on its own and is still there; nothing was pushed yet.
    const receipts = await rows<{ n: number }>(
      f,
      sql`SELECT count(*)::int AS n FROM payment_receipts WHERE payment_id = ${payment}`,
    );
    expect(receipts[0]?.n).toBe(1);
    expect(await pushes(payment)).toEqual([]);
    spy.mockRestore();

    await relay();
    expect(await pushes(payment)).toHaveLength(2);
  });

  // =========================================================================
  // The caption (File 01 §4)
  // =========================================================================

  it('carries File 01 §4’s fields, and the balance only for a reviewer who holds users.view', async () => {
    const payment = await pendingWithReceipt(f, 'caption', 'یادداشت مشتری');
    await relay();
    f.sent = [];
    await deliver();

    const owner = String(filesTo(TG.owner)[0]?.body['caption'] ?? '');
    const plain = String(filesTo(TG.reviewer)[0]?.body['caption'] ?? '');
    const reference = (
      await rows<{ reference: string }>(
        f,
        sql`SELECT reference FROM payments WHERE id = ${payment}`,
      )
    )[0]?.reference;
    for (const caption of [owner, plain]) {
      expect(caption).toContain('خرید سرویس جدید'); // operation
      expect(caption).toContain('پلن پایه'); // product title, from the order snapshot
      expect(caption).toContain('زهرا'); // account name
      expect(caption).toContain(TG.customer); // numeric id
      expect(caption).toContain('@zahra_pay'); // username
      expect(caption).toContain('250,000'); // amount
      expect(caption).toContain(String(reference)); // tracking code
      expect(caption).toContain('یادداشت مشتری'); // the customer's note
      expect(caption).not.toContain('file-caption'); // never a file id
      // The order's frozen volume and duration (1 byte, 30 days), typed through their labels.
      expect(caption).toMatch(/حجم محصول: 1\n/u);
      expect(caption).toMatch(/مدت محصول: 30\n/u);
    }
    // The owner holds users.view: the balance. The reviewer does not: a dash in its place.
    expect(owner).toMatch(/موجودی فعلی کاربر: 0 تومان/u);
    expect(plain).toMatch(/موجودی فعلی کاربر: —/u);
  });

  it('reads an add-on’s unbought amount as unknown, never as the line’s zero', async () => {
    const payment = await signalledTransfer(f, 'addon-facts');
    const order = (
      await rows<{ order_id: string }>(f, sql`SELECT order_id FROM payments WHERE id = ${payment}`)
    )[0]?.order_id as never;
    const db = f.ctx.container.database.db;
    const reader = new DrizzleReceiptReviewFactsReader(db);
    expect(await reader.factsFor(tenantA, order)).toMatchObject({
      purpose: 'NEW_SERVICE',
      durationDays: 30,
      trafficBytes: 1n,
    });
    // Reshape the frozen line into each add-on as `CommercialActionService` writes it: the
    // bought amount, and ZERO in the other (`orders_quantity_line_check`). The snapshot is
    // frozen by a trigger, so the reshaping is done the only way it can be, in one transaction.
    const reshape = (purpose: string, days: number, bytes: bigint) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`ALTER TABLE orders DISABLE TRIGGER orders_snapshot_frozen`);
        await tx.execute(sql`
          UPDATE orders SET purpose = ${purpose}, line_duration_days = ${days},
                 line_traffic_bytes = ${bytes}
           WHERE id = ${order}`);
        await tx.execute(sql`ALTER TABLE orders ENABLE TRIGGER orders_snapshot_frozen`);
      });
    await reshape('ADD_TRAFFIC', 0, 1_073_741_824n);
    expect(await reader.factsFor(tenantA, order)).toMatchObject({
      purpose: 'ADD_TRAFFIC',
      durationDays: null,
      trafficBytes: 1_073_741_824n,
    });
    await reshape('ADD_TIME', 15, 0n);
    expect(await reader.factsFor(tenantA, order)).toMatchObject({
      purpose: 'ADD_TIME',
      durationDays: 15,
      trafficBytes: null,
    });
  });

  it('names the service username the order reserved', async () => {
    const payment = await signalledTransfer(f, 'named');
    const order = (
      await rows<{ order_id: string }>(f, sql`SELECT order_id FROM payments WHERE id = ${payment}`)
    )[0]?.order_id;
    // The order's own reservation, as confirmation took it — renamed so the test can find it.
    await f.ctx.container.database.db.execute(sql`
      UPDATE service_username_reservations SET username = 'zahra01' WHERE order_id = ${order}`);
    const held = await rows<{ n: number }>(
      f,
      sql`SELECT count(*)::int AS n FROM service_username_reservations WHERE order_id = ${order}`,
    );
    expect(held[0]?.n).toBe(1);
    await fileReceipt(f, 'named', 'file-named');
    await relay();
    f.sent = [];
    await deliver();
    expect(String(filesTo(TG.owner)[0]?.body['caption'] ?? '')).toContain('zahra01');
  });

  it('files the same message the pull queue shows, for the same reviewer', async () => {
    const payment = await pendingWithReceipt(f, 'same', 'همان');
    await relay();
    f.sent = [];
    await deliver();
    const pushed = String(filesTo(TG.owner)[0]?.body['caption'] ?? '');
    f.sent = [];
    await f.ctx.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: 'wp10f-pull-same',
      botInstanceId: BOT_A,
      update: {
        update_id: 991,
        callback_query: {
          id: 'cbq-same',
          from: { id: Number(TG.owner), is_bot: false, first_name: 'x' },
          data: `C:${payment as PaymentId}`,
          message: { message_id: 1, date: 0, chat: { id: Number(TG.owner), type: 'private' } },
        },
      },
      telegramUserId: TG.owner,
      from: { id: Number(TG.owner), first_name: 'x' },
    });
    const pulled = String(f.sent.find((one) => one.method === 'sendPhoto')?.body['caption'] ?? '');
    expect(pulled).toBe(pushed);
  });
});
