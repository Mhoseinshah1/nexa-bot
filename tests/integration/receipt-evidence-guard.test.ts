import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COMMERCE_ERROR_CODES, type BotInstanceId } from '@nexa/contracts';
import { SEED_IDS, tenantA } from './harness';
import {
  TG,
  customerStatus,
  fileReceipt,
  lastKeyboard,
  ledgerCount,
  paymentState,
  receiptFixture,
  rows,
  say,
  signalledTransfer,
  tap,
  type ReceiptFixture,
} from './receipt-review-fixture';

/**
 * A decision made FROM a receipt needs a receipt (pre-release hardening §1).
 *
 * A pending manual transfer the customer never filed evidence for is an ordinary pending
 * transfer. None of the four receipt-review actions — approve, reject, credit to wallet,
 * block from the receipt — may resolve it, whatever callback reaches the bot: the buttons are
 * drawn only on a receipt, so every refusal below is of a CRAFTED callback. Each action is
 * refused at the surface's admission AND at the service that writes, so a test exists for
 * each layer and a mutation of either alone is seen.
 */
describe('receipt-review actions require a stored receipt', () => {
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

  const bot = SEED_IDS.botA1 as BotInstanceId;

  async function receiptCount(paymentId: string): Promise<number> {
    const found = await rows<{ n: number }>(
      f,
      sql`SELECT count(*)::int AS n FROM payment_receipts WHERE payment_id = ${paymentId}`,
    );
    return Number(found[0]?.n ?? 0);
  }

  async function openCaptures(): Promise<number> {
    const found = await rows<{ n: number }>(
      f,
      sql`SELECT count(*)::int AS n FROM admin_amount_captures WHERE closed_at IS NULL`,
    );
    return Number(found[0]?.n ?? 0);
  }

  async function audits(action: string): Promise<number> {
    const found = await rows<{ n: number }>(
      f,
      sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = ${action}`,
    );
    return Number(found[0]?.n ?? 0);
  }

  const noReceipt = {
    code: COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID,
    details: { reason: 'NO_RECEIPT' },
  };

  // =========================================================================
  // Forged callbacks
  // =========================================================================

  it('a forged approve callback on a transfer with no receipt is refused, and it stays pending', async () => {
    const payment = await signalledTransfer(f, 'forged-approve');
    expect(await receiptCount(payment)).toBe(0);
    const ledger = await ledgerCount(f);

    expect((await tap(f, `D:${payment}`, TG.owner)).replyKey).toBe('bot.admin.receipt_gone');

    expect(await paymentState(f, payment)).toBe('PENDING');
    expect(await audits('payment.confirm')).toBe(0);
    expect(await ledgerCount(f)).toBe(ledger);
  });

  it('the review item for a transfer with no receipt draws no decision', async () => {
    const payment = await signalledTransfer(f, 'forged-item');

    expect((await tap(f, `C:${payment}`, TG.owner)).replyKey).toBe('bot.admin.receipt_gone');
    expect(lastKeyboard(f)).toEqual([]);
    expect(await f.ctx.container.receipts.reviewItem(tenantA, f.owner, payment)).toBeNull();
  });

  it('the approval itself refuses a receipt-review confirmation of a transfer with no receipt', async () => {
    const payment = await signalledTransfer(f, 'service-approve');

    await expect(
      f.ctx.container.payments.confirmManualTransfer(tenantA, f.owner, payment, {
        idempotencyKey: 'service-approve',
        note: 'approve',
        requireReceipt: true,
      }),
    ).rejects.toMatchObject(noReceipt);
    expect(await paymentState(f, payment)).toBe('PENDING');
    expect(await audits('payment.confirm')).toBe(0);
  });

  it('a forged reject callback on a transfer with no receipt opens nothing and rejects nothing', async () => {
    const payment = await signalledTransfer(f, 'forged-reject');

    expect((await tap(f, `E:${payment}`, TG.owner)).replyKey).toBe('bot.admin.receipt_gone');
    expect(await openCaptures()).toBe(0);
    // A message typed now is not a reason for anything.
    expect((await say(f, 'رد', TG.owner)).replyKey).not.toBe('bot.admin.reject_confirm');

    expect(await paymentState(f, payment)).toBe('PENDING');
    expect(await audits('payment.reject')).toBe(0);
  });

  it('the rejection itself refuses a receipt-review rejection of a transfer with no receipt', async () => {
    const payment = await signalledTransfer(f, 'service-reject');

    await expect(
      f.ctx.container.payments.rejectManualTransfer(tenantA, f.owner, payment, {
        idempotencyKey: 'service-reject',
        note: 'بدون رسید',
        requireReceipt: true,
      }),
    ).rejects.toMatchObject(noReceipt);
    expect(await paymentState(f, payment)).toBe('PENDING');
  });

  it('the reject capture refuses a transfer with no receipt at the service, not only at the button', async () => {
    const payment = await signalledTransfer(f, 'capture-reject');

    await expect(
      f.ctx.container.receiptRejectCaptures.open(tenantA, f.owner, {
        idempotencyKey: 'capture-reject-open',
        botInstanceId: bot,
        targetId: payment,
      }),
    ).resolves.toEqual({ outcome: 'GONE' });
    expect(await openCaptures()).toBe(0);
  });

  it('a forged credit callback on a transfer with no receipt opens nothing and credits nothing', async () => {
    const payment = await signalledTransfer(f, 'forged-credit');
    const ledger = await ledgerCount(f);

    expect((await tap(f, `wa:${payment}`, TG.owner)).replyKey).toBe('bot.admin.credit_no_receipt');
    expect(await openCaptures()).toBe(0);

    await expect(
      f.ctx.container.receiptDispositions.creditToWallet(tenantA, f.owner, {
        idempotencyKey: 'forged-credit-service',
        paymentId: payment,
        amountMinor: 250_000n,
        note: null,
      }),
    ).rejects.toMatchObject(noReceipt);

    expect(await paymentState(f, payment)).toBe('PENDING');
    expect(await ledgerCount(f)).toBe(ledger);
  });

  it('a forged block-from-receipt callback on a transfer with no receipt asks nothing and blocks nobody', async () => {
    const payment = await signalledTransfer(f, 'forged-block');

    expect((await tap(f, `xa:${payment}`, TG.owner)).replyKey).toBe('bot.admin.receipt_gone');
    expect((await tap(f, `xb:${payment}`, TG.owner)).replyKey).toBe('bot.admin.receipt_gone');
    expect(await openCaptures()).toBe(0);
    await expect(
      f.ctx.container.receiptBlockCaptures.ask(tenantA, f.owner, payment),
    ).resolves.toEqual({ outcome: 'GONE' });

    expect((await customerStatus(f, f.customer)).status).toBe('ACTIVE');
    expect(await audits('customer.block')).toBe(0);
  });

  // =========================================================================
  // A real receipt still supports all four
  // =========================================================================

  it('once a receipt is filed, the same transfer can be approved', async () => {
    const payment = await signalledTransfer(f, 'real-approve');
    expect((await tap(f, `D:${payment}`, TG.owner)).replyKey).toBe('bot.admin.receipt_gone');
    await fileReceipt(f, 'real-approve', 'file-real-approve');

    expect((await tap(f, `D:${payment}`, TG.owner)).replyKey).toBe('bot.admin.approved');
    expect(await paymentState(f, payment)).toBe('CONFIRMED');
  });

  it('a transfer with a receipt can be rejected with a reason', async () => {
    const payment = await signalledTransfer(f, 'real-reject');
    await fileReceipt(f, 'real-reject', 'file-real-reject');

    expect((await tap(f, `E:${payment}`, TG.owner)).replyKey).toBe(
      'bot.admin.reject_reason_prompt',
    );
    expect((await say(f, 'مبلغ نادرست', TG.owner)).replyKey).toBe('bot.admin.reject_confirm');
    const confirm = lastKeyboard(f).find((b) => b.callback_data?.startsWith('xe:'));
    expect((await tap(f, confirm?.callback_data ?? '', TG.owner)).replyKey).toBe(
      'bot.admin.rejected',
    );
    expect(await paymentState(f, payment)).toBe('FAILED');
  });

  it('a transfer with a receipt can be credited to the wallet', async () => {
    const payment = await signalledTransfer(f, 'real-credit');
    await fileReceipt(f, 'real-credit', 'file-real-credit');
    const ledger = await ledgerCount(f);

    await f.ctx.container.receiptDispositions.creditToWallet(tenantA, f.owner, {
      idempotencyKey: 'real-credit-service',
      paymentId: payment,
      amountMinor: 250_000n,
      note: null,
    });
    expect(await paymentState(f, payment)).toBe('FAILED');
    expect(await ledgerCount(f)).toBe(ledger + 1);
    expect((await tap(f, `wa:${payment}`, TG.owner)).replyKey).toBe(
      'bot.admin.receipt_already_credited',
    );
  });

  it('the customer of a transfer with a receipt can be blocked from it', async () => {
    const payment = await signalledTransfer(f, 'real-block');
    await fileReceipt(f, 'real-block', 'file-real-block');

    expect((await tap(f, `xa:${payment}`, TG.owner)).replyKey).toBe('bot.admin.block_ask');
    expect((await tap(f, `xb:${payment}`, TG.owner)).replyKey).toBe(
      'bot.admin.block_reason_prompt',
    );
    expect((await say(f, 'تقلب', TG.owner)).replyKey).toBe('bot.admin.block_confirm');
    const confirm = lastKeyboard(f).find((b) => b.callback_data?.startsWith('xc:'));
    expect((await tap(f, confirm?.callback_data ?? '', TG.owner)).replyKey).toBe(
      'bot.admin.blocked_from_receipt',
    );
    expect((await customerStatus(f, f.customer)).status).toBe('BLOCKED');
  });
});
