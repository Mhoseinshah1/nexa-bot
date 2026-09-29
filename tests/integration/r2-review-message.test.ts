import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { money } from '@nexa/contracts';
import {
  BOT_A,
  bindNewAdmin,
  fileReceipt,
  customerStatus,
  keyboardOf,
  ledgerCount,
  paymentState,
  pendingWithReceipt,
  receiptFixture,
  replayOf,
  rows,
  say,
  systemActor,
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

  /** F1: the callback notice a tap was answered with, if any. */
  const toastOf = (sent: readonly Sent[]) =>
    sent.find((one) => one.method === 'answerCallbackQuery')?.body['text'];
  const captionOf = (sent: readonly Sent[], messageId: number) =>
    String(editOf(sent, messageId)?.body['caption'] ?? '');
  async function referenceOf(payment: string): Promise<string> {
    const found = await rows<{ reference: string }>(
      f,
      sql`SELECT reference FROM payments WHERE id = ${payment}`,
    );
    return found[0]?.reference ?? 'MISSING';
  }

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
    /*
     * F1 (round N): the COMPLETE final record — the owner's label first, then the facts the
     * reviewer decided on — and no wallet lines: a purchase approval moved no wallet.
     */
    const record = captionOf(f.sent, 501);
    expect(record.startsWith('✅ پرداخت تأیید شد\n')).toBe(true);
    expect(record).toContain('نوع عملیات: خرید سرویس جدید');
    expect(record).toContain('نام محصول: پلن پایه');
    expect(record).toContain('مدت محصول: 30 روز');
    expect(record).toContain(`شناسه عددی کاربر: ${TG.customer}`);
    expect(record).toContain('یوزرنیم تلگرام: @zahra_pay');
    expect(record).toContain('مبلغ پرداختی: 250,000');
    expect(record).toContain(`کد پیگیری پرداخت: ${await referenceOf(payment)}`);
    expect(record).not.toContain('کیف پول');
    expect(record).not.toContain('—');
    // The decision buttons are gone: nothing on the message can ask again.
    expect(keyboardOf(edited?.body ?? {})).toEqual([]);
    expect(methods(f.sent).filter((m) => m === 'sendMessage')).toEqual([]);
    const ledgerAfter = await ledgerCount(f);

    // The same button again (a double tap): answered, and nothing else.
    const again = await tapOn(f, `D:${payment}`, TG.owner, { id: 501, photo: true }).result;
    expect(again.replyKey).toBeNull();
    expect(again.sent).toBe('NOT_ATTEMPTED');
    expect(methods(f.sent)).toEqual(['answerCallbackQuery']);
    // F1: answered truthfully, from the payment's recorded disposition.
    expect(toastOf(f.sent)).toBe('این پرداخت قبلاً تأیید شده است.');

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

  it('F1: an approved TOP-UP records the wallet movement off the ledger, and no product lines', async () => {
    const c = f.ctx.container;
    const scope = { ...TENANT_A, botInstanceId: BOT_A };
    const issued = await c.payments.requestWalletTopupTyped(
      scope,
      systemActor('f1-topup'),
      f.customer,
      { idempotencyKey: 'f1-topup', amount: money(80_000n, 'IRT'), provider: 'MANUAL_TRANSFER' },
    );
    const payment = issued.payment.id;
    await c.payments.signalTransferSent(TENANT_A, systemActor('f1-topup-s'), f.customer, {
      idempotencyKey: 'f1-topup-signal',
      paymentId: payment,
      botInstanceId: BOT_A,
    });
    await fileReceipt(f, 'f1-topup', 'file-f1-topup');

    await tapOn(f, `D:${payment}`, TG.owner, { id: 506, photo: true }).result;
    expect(await paymentState(f, payment)).toBe('CONFIRMED');
    const record = captionOf(f.sent, 506);
    expect(record.startsWith('✅ پرداخت تأیید شد\n')).toBe(true);
    expect(record).toContain('نوع عملیات: افزایش موجودی کیف پول');
    expect(record).not.toContain('نام محصول');
    expect(record).not.toContain('نام کاربری سرویس');
    expect(record).toContain('مبلغ پرداختی: 80,000');
    expect(record).toContain('مبلغ واریز شده به کیف پول: 80,000');
    expect(record).toContain('موجودی کیف پول پیش از واریز: 0');
    expect(record).toContain('موجودی کیف پول پس از واریز: 80,000');

    const ledger = await ledgerCount(f);
    await tapOn(f, `D:${payment}`, TG.owner, { id: 506, photo: true }).result;
    expect(methods(f.sent)).toEqual(['answerCallbackQuery']);
    expect(toastOf(f.sent)).toBe('این پرداخت قبلاً تأیید شده است.');
    expect(await ledgerCount(f)).toBe(ledger);
  });

  /*
   * Codex review of #113: a receipt PHOTO is edited through its caption, which Telegram bounds
   * at 1,024 characters, and a tenant's override of the record can pass that. The caption is
   * never cut into a record that lost its end: it becomes the decision and the tracking code,
   * and the COMPLETE record is sent as a reply to the same message — once.
   */
  it('F1: a record too long for a caption becomes a bounded caption and the whole record as a reply, once', async () => {
    const padding = 'این متن طولانی را مدیر به قالب افزوده است. '.repeat(40);
    await f.ctx.container.templatesService.set(TENANT_A, f.owner, {
      key: 'bot.admin.review_final',
      body:
        `{outcome}\n\n${padding}\n\nشناسه عددی کاربر: {customer}\nمبلغ پرداختی: {total}\n` +
        'کد پیگیری پرداخت: {reference}\nموجودی کیف پول پس از واریز: {walletAfter}',
      expectedVersion: null,
      expectedRevision: null,
      idempotencyKey: 'f1-long-override',
    });
    const payment = await pendingWithReceipt(f, 'f1-long');
    const reference = await referenceOf(payment);

    await tapOn(f, `wa:${payment}`, TG.owner, { id: 507, photo: true }).result;
    await say(f, '60000', TG.owner);
    const confirm = keyboardOf(f.sent.at(-1)?.body ?? {}).find((b) =>
      (b.callback_data ?? '').startsWith('wb:'),
    )?.callback_data;
    await tapOn(f, confirm ?? '', TG.owner, { id: PROMPT }).result;

    // The caption: bounded, truthful, never an ellipsis-cut record.
    const caption = captionOf(f.sent, 507);
    expect(caption.length).toBeLessThanOrEqual(1024);
    expect(caption.startsWith('💳 مبلغ به کیف پول واریز شد\n')).toBe(true);
    expect(caption).toContain(`کد پیگیری پرداخت: ${reference}`);
    expect(caption).toContain('در پاسخ به همین پیام');
    expect(caption).not.toContain('…');
    // The complete record, as a reply to that very message — its end included.
    const replies = f.sent.filter(
      (one) =>
        one.method === 'sendMessage' &&
        (one.body['reply_parameters'] as { message_id?: number } | undefined)?.message_id === 507,
    );
    expect(replies).toHaveLength(1);
    const record = String(replies[0]?.body['text']);
    expect(record.length).toBeGreaterThan(1024);
    expect(record).toContain(`کد پیگیری پرداخت: ${reference}`);
    expect(record).toContain('موجودی کیف پول پس از واریز: 60,000');

    // A repeated tap on the receipt answers, and never sends the record again.
    await tapOn(f, `D:${payment}`, TG.owner, { id: 507, photo: true }).result;
    expect(methods(f.sent)).toEqual(['answerCallbackQuery']);
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
    expect(captionOf(f.sent, 502).startsWith('❌ پرداخت رد شد\n')).toBe(true);
    expect(captionOf(f.sent, 502)).toContain('مبلغ پرداختی: 250,000');
    expect(keyboardOf(editOf(f.sent, 502)?.body ?? {})).toEqual([]);
    expect(editOf(f.sent, PROMPT)?.method).toBe('editMessageText');
    expect(methods(f.sent).filter((m) => m === 'sendMessage')).toEqual([]);

    const again = await tapOn(f, confirm ?? '', TG.owner, { id: PROMPT }).result;
    expect(again.replyKey).toBeNull();
    expect(methods(f.sent)).toEqual(['answerCallbackQuery']);
    expect(toastOf(f.sent)).toBe('این پرداخت قبلاً رد شده است.');
    // The receipt's own buttons, tapped late: answered, nothing more.
    await tapOn(f, `D:${payment}`, TG.owner, { id: 502, photo: true }).result;
    expect(methods(f.sent)).toEqual(['answerCallbackQuery']);
    expect(toastOf(f.sent)).toBe('این پرداخت قبلاً رد شده است.');

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
    /*
     * F1: the record carries the wallet movement, read off the ledger — the credited amount
     * and the balance immediately before and after THIS payment's entry — for a reviewer
     * holding `users.view` (the owner does).
     */
    const record = captionOf(f.sent, 503);
    expect(record.startsWith('💳 مبلغ به کیف پول واریز شد\n')).toBe(true);
    expect(record).toContain('مبلغ پرداختی: 250,000');
    expect(record).toContain('مبلغ واریز شده به کیف پول: 120,000');
    expect(record).toContain('موجودی کیف پول پیش از واریز: 0');
    expect(record).toContain('موجودی کیف پول پس از واریز: 120,000');
    const ledger = await ledgerCount(f);

    const again = await tapOn(f, confirm ?? '', TG.owner, { id: PROMPT }).result;
    expect(again.replyKey).toBeNull();
    expect(methods(f.sent)).toEqual(['answerCallbackQuery']);
    expect(toastOf(f.sent)).toBe('مبلغ این پرداخت قبلاً به کیف پول واریز شده است.');
    // The receipt's own approve button, tapped late: answered, and still nothing moves.
    await tapOn(f, `D:${payment}`, TG.owner, { id: 503, photo: true }).result;
    expect(methods(f.sent)).toEqual(['answerCallbackQuery']);
    expect(toastOf(f.sent)).toBe('مبلغ این پرداخت قبلاً به کیف پول واریز شده است.');
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
    expect(captionOf(f.sent, 504).startsWith('⛔ کاربر بلاک شد\n')).toBe(true);
    expect(captionOf(f.sent, 504)).toContain(`شناسه عددی کاربر: ${TG.customer}`);
    expect((await customerStatus(f, f.customer)).status).toBe('BLOCKED');
    // A block decides nothing about the payment: it is still in the review queue.
    expect(await paymentState(f, payment)).toBe('PENDING');

    const again = await tapOn(f, confirm ?? '', TG.owner, { id: PROMPT }).result;
    expect(again.replyKey).toBeNull();
    expect(methods(f.sent)).toEqual(['answerCallbackQuery']);
    expect(toastOf(f.sent)).toBe('این کاربر قبلاً بلاک شده است.');
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
    expect(String(onReviewer?.body['caption']).startsWith('✅ پرداخت تأیید شد\n')).toBe(true);
    expect(String(onReviewer?.body['caption'])).toContain('نام محصول: پلن پایه');

    // The reviewer's copy was finalised with it: their late tap is answered and nothing else.
    await tapOn(f, `D:${payment}`, TG.reviewer, { id: 11, photo: true }).result;
    expect(methods(f.sent)).toEqual(['answerCallbackQuery']);
  });

  /*
   * F1: the wallet lines are the DECIDING reviewer's (`users.view`). Another reviewer's copy
   * is read by somebody whose permissions the deciding turn does not know, so their record
   * carries every fact but the balance.
   */
  it('F1: a credit shows the wallet movement on the deciding reviewer’s message, and never on another reviewer’s copy', async () => {
    await bindNewAdmin(f, 'f1-reviewer', TG.reviewer, [
      'payments.view',
      'receipts.view',
      'receipts.review',
    ]);
    const payment = await pendingWithReceipt(f, 'f1-credit-copy');
    // The other reviewer opens the receipt from the queue: their own recorded copy.
    await tapOn(f, `C:${payment}`, TG.reviewer, { id: 900 }).result;
    const copies = await rows<{ chat_id: string }>(
      f,
      sql`SELECT chat_id FROM telegram_review_messages WHERE payment_id = ${payment}`,
    );
    expect(copies.map((row) => row.chat_id)).toEqual([TG.reviewer]);

    await tapOn(f, `wa:${payment}`, TG.owner, { id: 601, photo: true }).result;
    await say(f, '90000', TG.owner);
    const confirm = keyboardOf(f.sent.at(-1)?.body ?? {}).find((b) =>
      (b.callback_data ?? '').startsWith('wb:'),
    )?.callback_data;
    await tapOn(f, confirm ?? '', TG.owner, { id: PROMPT }).result;

    const byChat = (chat: string) =>
      edits(f.sent)
        .filter((one) => String(one.body['chat_id']) === chat)
        .map((one) => String(one.body['caption'] ?? ''))
        .find((caption) => caption.startsWith('💳'));
    expect(byChat(TG.owner)).toContain('موجودی کیف پول پس از واریز: 90,000');
    const theirs = byChat(TG.reviewer) ?? '';
    expect(theirs.startsWith('💳 مبلغ به کیف پول واریز شد\n')).toBe(true);
    expect(theirs).toContain('مبلغ پرداختی: 250,000');
    expect(theirs).not.toContain('کیف پول:');
    expect(theirs).not.toContain('موجودی');
  });

  it('a copy of the receipt decided elsewhere is finalised into the decision on its first tap, then only answers', async () => {
    const payment = await pendingWithReceipt(f, 'r2-copy');
    await tapOn(f, `D:${payment}`, TG.owner, { id: 505, photo: true }).result;
    expect(await paymentState(f, payment)).toBe('CONFIRMED');
    const ledger = await ledgerCount(f);

    // Another message of the same receipt (the push's copy), tapped after the decision.
    const stale = await tapOn(f, `E:${payment}`, TG.owner, { id: 777, photo: true }).result;
    expect(stale.replyKey).toBe('bot.admin.receipt_already_approved');
    expect(captionOf(f.sent, 777).startsWith('✅ پرداخت تأیید شد\n')).toBe(true);

    await tapOn(f, `D:${payment}`, TG.owner, { id: 777, photo: true }).result;
    expect(methods(f.sent)).toEqual(['answerCallbackQuery']);
    expect(await ledgerCount(f)).toBe(ledger);
  });
});
