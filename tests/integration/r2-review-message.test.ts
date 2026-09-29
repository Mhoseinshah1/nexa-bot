import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bindNewAdmin,
  customerStatus,
  keyboardOf,
  ledgerCount,
  paymentState,
  pendingWithReceipt,
  receiptFixture,
  replayOf,
  rows,
  say,
  tapOn,
  TG,
  TENANT_A,
  type ReceiptFixture,
  type Sent,
} from './receipt-review-fixture';

/**
 * R2 (v0.3.5 real-test item 3): the administrator's receipt-review message becomes the
 * decision taken on it — edited IN PLACE, its buttons gone — and a repeated tap on a message
 * already finalised is answered with `answerCallbackQuery` and nothing else: no second
 * decision is asked for, no money moves twice, no message is sent or edited again.
 *
 * Real everything: PostgreSQL, the decision services with their locks, the runtime, and a
 * socket standing in for Telegram. The receipt is tapped as the PHOTO it is (its caption is
 * what an edit changes); the prompts are the messages the bot sent (`message_id` 11).
 */
const PROMPT = 11;

describe('the receipt-review message is edited into its decision, once', () => {
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

  const methods = (sent: readonly Sent[]) => sent.map((one) => one.method);
  const edits = (sent: readonly Sent[]) =>
    sent.filter((one) => one.method === 'editMessageText' || one.method === 'editMessageCaption');
  const editOf = (sent: readonly Sent[], messageId: number) =>
    edits(sent).find((one) => one.body['message_id'] === messageId);

  async function notices(kind: string): Promise<number> {
    const found = await rows<{ n: number }>(
      f,
      sql`SELECT count(*)::int AS n FROM customer_notifications WHERE kind = ${kind}`,
    );
    return Number(found[0]?.n ?? 0);
  }

  it('approve: the receipt photo becomes «✅ پرداخت تأیید شد»; a second tap and a redelivery only answer', async () => {
    const payment = await pendingWithReceipt(f, 'r2-approve');
    const ledgerBefore = await ledgerCount(f);

    const first = tapOn(f, `D:${payment}`, TG.owner, { id: 501, photo: true });
    expect((await first.result).replyKey).toBe('bot.admin.approved');
    expect(await paymentState(f, payment)).toBe('CONFIRMED');
    const edited = editOf(f.sent, 501);
    expect(edited?.method).toBe('editMessageCaption');
    expect(edited?.body['caption']).toBe('✅ پرداخت تأیید شد');
    // The decision buttons are gone: nothing on the message can ask again.
    expect(keyboardOf(edited?.body ?? {})).toEqual([]);
    expect(methods(f.sent).filter((m) => m === 'sendMessage')).toEqual([]);
    const ledgerAfter = await ledgerCount(f);

    // The same button again (a double tap): answered, and nothing else.
    const again = await tapOn(f, `D:${payment}`, TG.owner, { id: 501, photo: true }).result;
    expect(again.replyKey).toBeNull();
    expect(again.sent).toBe('NOT_ATTEMPTED');
    expect(methods(f.sent)).toEqual(['answerCallbackQuery']);

    // Telegram redelivering the FIRST update: the same, answered and nothing else.
    const redelivered = await replayOf(f, first.update);
    expect(redelivered.replyKey).toBeNull();
    expect(methods(f.sent)).toEqual(['answerCallbackQuery']);

    expect(await paymentState(f, payment)).toBe('CONFIRMED');
    expect(await ledgerCount(f)).toBe(ledgerAfter);
    expect(ledgerAfter).toBeGreaterThanOrEqual(ledgerBefore);
    // The order the transfer paid is settled exactly once.
    const orders = await rows<{ state: string }>(
      f,
      sql`SELECT o.state FROM orders o JOIN payments p ON p.order_id = o.id WHERE p.id = ${payment}`,
    );
    expect(orders.map((o) => o.state)).toEqual(['PAID']);
  });

  it('reject: the confirmation becomes the result in place, the receipt «❌ پرداخت رد شد», and a repeat only answers', async () => {
    const payment = await pendingWithReceipt(f, 'r2-reject');

    await tapOn(f, `E:${payment}`, TG.owner, { id: 502, photo: true }).result;
    // The reason prompt is its own message; the receipt keeps its facts until the decision.
    expect(edits(f.sent)).toEqual([]);
    await say(f, 'مبلغ واریزی با فاکتور یکی نیست', TG.owner);
    const confirm = keyboardOf(f.sent.at(-1)?.body ?? {}).find((b) =>
      (b.callback_data ?? '').startsWith('xe:'),
    )?.callback_data;
    expect(confirm).toBeDefined();

    const done = await tapOn(f, confirm ?? '', TG.owner, { id: PROMPT }).result;
    expect(done.replyKey).toBe('bot.admin.rejected');
    expect(await paymentState(f, payment)).toBe('FAILED');
    expect(editOf(f.sent, 502)?.body['caption']).toBe('❌ پرداخت رد شد');
    expect(keyboardOf(editOf(f.sent, 502)?.body ?? {})).toEqual([]);
    expect(editOf(f.sent, PROMPT)?.method).toBe('editMessageText');
    expect(methods(f.sent).filter((m) => m === 'sendMessage')).toEqual([]);

    const again = await tapOn(f, confirm ?? '', TG.owner, { id: PROMPT }).result;
    expect(again.replyKey).toBeNull();
    expect(methods(f.sent)).toEqual(['answerCallbackQuery']);
    // The receipt's own buttons, tapped late: answered, nothing more.
    await tapOn(f, `D:${payment}`, TG.owner, { id: 502, photo: true }).result;
    expect(methods(f.sent)).toEqual(['answerCallbackQuery']);

    expect(await paymentState(f, payment)).toBe('FAILED');
    expect(await notices('PAYMENT_REJECTED')).toBe(1);
  });

  it('credit: the receipt becomes «💳 مبلغ به کیف پول واریز شد», and a repeated confirm credits nothing more', async () => {
    const payment = await pendingWithReceipt(f, 'r2-credit');

    await tapOn(f, `wa:${payment}`, TG.owner, { id: 503, photo: true }).result;
    await say(f, '120000', TG.owner);
    const confirm = keyboardOf(f.sent.at(-1)?.body ?? {}).find((b) =>
      (b.callback_data ?? '').startsWith('wb:'),
    )?.callback_data;
    expect(confirm).toBeDefined();

    const done = await tapOn(f, confirm ?? '', TG.owner, { id: PROMPT }).result;
    expect(done.replyKey).toBe('bot.admin.credited');
    expect(editOf(f.sent, 503)?.body['caption']).toBe('💳 مبلغ به کیف پول واریز شد');
    const ledger = await ledgerCount(f);

    const again = await tapOn(f, confirm ?? '', TG.owner, { id: PROMPT }).result;
    expect(again.replyKey).toBeNull();
    expect(methods(f.sent)).toEqual(['answerCallbackQuery']);
    expect(await ledgerCount(f)).toBe(ledger);
    const credits = await rows<{ n: number }>(
      f,
      sql`SELECT count(*)::int AS n FROM receipt_credits WHERE payment_id = ${payment}`,
    );
    expect(Number(credits[0]?.n ?? 0)).toBe(1);
  });

  it('block: the receipt becomes «⛔ کاربر بلاک شد», the payment stays pending, and a repeat only answers', async () => {
    const payment = await pendingWithReceipt(f, 'r2-block');

    await tapOn(f, `xa:${payment}`, TG.owner, { id: 504, photo: true }).result;
    await tapOn(f, `xb:${payment}`, TG.owner, { id: PROMPT }).result;
    await say(f, 'رسید جعلی', TG.owner);
    const confirm = keyboardOf(f.sent.at(-1)?.body ?? {}).find((b) =>
      (b.callback_data ?? '').startsWith('xc:'),
    )?.callback_data;
    expect(confirm).toBeDefined();

    const done = await tapOn(f, confirm ?? '', TG.owner, { id: PROMPT }).result;
    expect(done.replyKey).toBe('bot.admin.blocked_from_receipt');
    expect(editOf(f.sent, 504)?.body['caption']).toBe('⛔ کاربر بلاک شد');
    expect((await customerStatus(f, f.customer)).status).toBe('BLOCKED');
    // A block decides nothing about the payment: it is still in the review queue.
    expect(await paymentState(f, payment)).toBe('PENDING');

    const again = await tapOn(f, confirm ?? '', TG.owner, { id: PROMPT }).result;
    expect(again.replyKey).toBeNull();
    expect(methods(f.sent)).toEqual(['answerCallbackQuery']);
  });

  it('the receipt PUSHED to every reviewer becomes the result on each of their chats when one decides', async () => {
    await bindNewAdmin(f, 'r2-reviewer', TG.reviewer, [
      'payments.view',
      'receipts.view',
      'receipts.review',
    ]);
    const payment = await pendingWithReceipt(f, 'r2-push');
    await f.ctx.container.relay.processBatch();
    await f.ctx.container.receiptReviewPush.deliverDue(TENANT_A, 50);
    const pushed = await rows<{ chat_id: string; message_id: number; has_media: boolean }>(
      f,
      sql`SELECT chat_id, message_id::int AS message_id, has_media FROM telegram_review_messages
          WHERE payment_id = ${payment} ORDER BY chat_id`,
    );
    expect(pushed.map((row) => row.chat_id)).toEqual([TG.owner, TG.reviewer]);
    expect(pushed.every((row) => row.has_media)).toBe(true);

    // The owner approves on THEIR pushed copy (the fake Telegram gave every send id 11).
    await tapOn(f, `D:${payment}`, TG.owner, { id: 11, photo: true }).result;
    expect(await paymentState(f, payment)).toBe('CONFIRMED');
    const onReviewer = edits(f.sent).find((one) => String(one.body['chat_id']) === TG.reviewer);
    expect(onReviewer?.method).toBe('editMessageCaption');
    expect(onReviewer?.body['caption']).toBe('✅ پرداخت تأیید شد');

    // The reviewer's copy was finalised with it: their late tap is answered and nothing else.
    await tapOn(f, `D:${payment}`, TG.reviewer, { id: 11, photo: true }).result;
    expect(methods(f.sent)).toEqual(['answerCallbackQuery']);
  });

  it('a copy of the receipt decided elsewhere is finalised into the decision on its first tap, then only answers', async () => {
    const payment = await pendingWithReceipt(f, 'r2-copy');
    await tapOn(f, `D:${payment}`, TG.owner, { id: 505, photo: true }).result;
    expect(await paymentState(f, payment)).toBe('CONFIRMED');
    const ledger = await ledgerCount(f);

    // Another message of the same receipt (the push's copy), tapped after the decision.
    const stale = await tapOn(f, `E:${payment}`, TG.owner, { id: 777, photo: true }).result;
    expect(stale.replyKey).toBe('bot.admin.receipt_already_approved');
    expect(editOf(f.sent, 777)?.body['caption']).toBe('✅ پرداخت تأیید شد');

    await tapOn(f, `D:${payment}`, TG.owner, { id: 777, photo: true }).result;
    expect(methods(f.sent)).toEqual(['answerCallbackQuery']);
    expect(await ledgerCount(f)).toBe(ledger);
  });
});
