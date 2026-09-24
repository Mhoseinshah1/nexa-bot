import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  type ActorContext,
  type AdminId,
  type BotInstanceId,
  type PaymentId,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { adminActorFor, createAdmin, SEED_IDS, tenantA, tenantB } from './harness';
import { capturingLane } from './notification-capture';
import {
  TG,
  bindNewAdmin,
  customerNamed,
  customerStatus,
  keyboardOf,
  lastKeyboard,
  lastText,
  ledgerCount,
  paymentState,
  pendingWithReceipt,
  receiptFixture,
  rows,
  say,
  systemActor,
  tap,
  type ReceiptFixture,
} from './receipt-review-fixture';

/**
 * Block User from the receipt message (WP10 follow-up §4), the rejection's mandatory reason
 * (File 01 §7) and the blocked customer's reason (File 01 §9) — through the real bot runtime,
 * the real services and PostgreSQL — and the races between a block and each of the three
 * receipt dispositions.
 *
 * Every race is PRODUCED: one side is held inside its transaction just after the write that
 * takes its row, and the other is seen WAITING on that row in `pg_stat_activity` before the
 * first is released. Where the design does NOT serialise the two (a block and a reject touch
 * no common row), the proof is the opposite barrier: the second completes while the first is
 * still held. No bare `Promise.all`.
 */

describe('Block User and the rejection reason, from the receipt message', () => {
  let f: ReceiptFixture;
  /** receipts.review only — may decide, may not block. */
  let reviewer: AdminId;
  let reviewerActor: ActorContext;

  beforeAll(async () => {
    f = await receiptFixture();
  }, 120_000);

  afterAll(async () => {
    await f?.close();
  });

  beforeEach(async () => {
    await f.reset();
    reviewer = await bindNewAdmin(f, 'reviewer', TG.reviewer, [
      'payments.view',
      'receipts.view',
      'receipts.review',
    ]);
    await bindNewAdmin(f, 'blocker', TG.blocker, [
      'payments.view',
      'receipts.view',
      'users.view',
      'users.block',
    ]);
    reviewerActor = { ...f.owner, id: reviewer, label: 'reviewer' };
  });

  const db = () => f.ctx.container.database.db;
  const captureIdFrom = (prefix: string) =>
    (lastKeyboard(f).find((b) => b.callback_data?.startsWith(prefix))?.callback_data ?? '').slice(
      prefix.length,
    );

  /** Ask, say yes, type the reason: the confirmation's capture id, nothing blocked yet. */
  async function blockUpTo(
    payment: string,
    telegramUserId: string,
    reason: string,
  ): Promise<string> {
    expect((await tap(f, `xa:${payment}`, telegramUserId)).replyKey).toBe('bot.admin.block_ask');
    expect((await tap(f, `xb:${payment}`, telegramUserId)).replyKey).toBe(
      'bot.admin.block_reason_prompt',
    );
    expect((await say(f, reason, telegramUserId)).replyKey).toBe('bot.admin.block_confirm');
    return captureIdFrom('xc:');
  }

  /** The reject button, and the reason: the confirmation's capture id, nothing rejected yet. */
  async function rejectUpTo(
    payment: string,
    telegramUserId: string,
    reason: string,
  ): Promise<string> {
    expect((await tap(f, `E:${payment}`, telegramUserId)).replyKey).toBe(
      'bot.admin.reject_reason_prompt',
    );
    expect((await say(f, reason, telegramUserId)).replyKey).toBe('bot.admin.reject_confirm');
    return captureIdFrom('xe:');
  }

  async function audits(action: string) {
    return rows<{
      actor_id: string;
      entity_id: string;
      before: unknown;
      after: unknown;
      reason: string | null;
    }>(
      f,
      sql`SELECT actor_id, entity_id, before, after, reason FROM audit_logs
           WHERE action = ${action} ORDER BY occurred_at`,
    );
  }

  async function events(eventType: string): Promise<number> {
    const found = await rows<{ n: number }>(
      f,
      sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = ${eventType}`,
    );
    return Number(found[0]?.n ?? 0);
  }

  async function notices(kind: string): Promise<number> {
    const found = await rows<{ n: number }>(
      f,
      sql`SELECT count(*)::int AS n FROM customer_notifications WHERE kind = ${kind}`,
    );
    return Number(found[0]?.n ?? 0);
  }

  async function openCaptures(): Promise<{ purpose: string }[]> {
    return rows(f, sql`SELECT purpose FROM admin_amount_captures WHERE closed_at IS NULL`);
  }

  // =========================================================================
  // Block User
  // =========================================================================

  describe('Block User (File 01 §9)', () => {
    it('asks, takes a mandatory reason, restates it, then blocks through the customers path — and decides nothing', async () => {
      const payment = await pendingWithReceipt(f, 'b-flow');
      const ledgerBefore = await ledgerCount(f);

      const asked = await tap(f, `xa:${payment}`, TG.owner);
      expect(asked.replyKey).toBe('bot.admin.block_ask');
      expect(lastKeyboard(f).map((b) => b.callback_data)).toEqual([
        `xb:${payment}`,
        `C:${payment}`,
      ]);
      // The confirmation wrote nothing.
      expect((await customerStatus(f, f.customer)).status).toBe('ACTIVE');
      expect(await openCaptures()).toEqual([]);

      await tap(f, `xb:${payment}`, TG.owner);
      expect(await openCaptures()).toEqual([{ purpose: 'RECEIPT_BLOCK_REASON' }]);
      await say(f, '  ارسال رسید جعلی  ', TG.owner);
      // Restated, trimmed, and still nothing blocked.
      expect(lastText(f)).toContain('ارسال رسید جعلی');
      expect((await customerStatus(f, f.customer)).status).toBe('ACTIVE');
      const captureId = captureIdFrom('xc:');

      const done = await tap(f, `xc:${captureId}`, TG.owner);
      expect(done.replyKey).toBe('bot.admin.blocked_from_receipt');
      expect(await customerStatus(f, f.customer)).toEqual({
        status: 'BLOCKED',
        blocked_reason: 'ارسال رسید جعلی',
      });

      // The customers path's own audit and event, with the receipt as the context.
      const [audit] = await audits('customer.block');
      expect(audit).toMatchObject({
        actor_id: f.ownerId,
        entity_id: f.customer,
        reason: 'ارسال رسید جعلی',
        before: { status: 'ACTIVE', blockedReason: null },
        after: {
          status: 'BLOCKED',
          changed: true,
          blockedReason: 'ارسال رسید جعلی',
          context: { source: 'RECEIPT_REVIEW', paymentId: payment, captureId },
        },
      });
      expect(await events('CustomerBlocked')).toBe(1);

      // NOT a disposition: the payment is still pending, nothing credited, no ledger row.
      expect(await paymentState(f, payment)).toBe('PENDING');
      const credits = await rows(
        f,
        sql`SELECT 1 FROM receipt_credits WHERE payment_id = ${payment}`,
      );
      expect(credits).toEqual([]);
      expect(await ledgerCount(f)).toBe(ledgerBefore);
      expect(await audits('payment.reject')).toEqual([]);
      expect(await audits('payment.confirm')).toEqual([]);
    });

    for (const [name, decide] of [
      [
        'approve',
        async (payment: PaymentId) => {
          await f.ctx.container.payments.confirmManualTransfer(tenantA, reviewerActor, payment, {
            idempotencyKey: 'after-block-approve',
            note: 'after the block',
          });
          return 'CONFIRMED';
        },
      ],
      [
        'reject',
        async (payment: PaymentId) => {
          await f.ctx.container.payments.rejectManualTransfer(tenantA, reviewerActor, payment, {
            idempotencyKey: 'after-block-reject',
            note: 'رسید نامعتبر',
          });
          return 'FAILED';
        },
      ],
      [
        'credit',
        async (payment: PaymentId) => {
          await f.ctx.container.receiptDispositions.creditToWallet(tenantA, f.owner, {
            idempotencyKey: 'after-block-credit',
            paymentId: payment,
            amountMinor: 100_000n,
            note: null,
          });
          return 'FAILED';
        },
      ],
    ] as const) {
      it(`leaves the receipt to another administrator to ${name} after the block`, async () => {
        const payment = await pendingWithReceipt(f, `b-then-${name}`);
        const captureId = await blockUpTo(payment, TG.blocker, 'مسدود پیش از تصمیم');
        await tap(f, `xc:${captureId}`, TG.blocker);
        expect((await customerStatus(f, f.customer)).status).toBe('BLOCKED');

        expect(await decide(payment)).toBe(await paymentState(f, payment));
        expect((await customerStatus(f, f.customer)).status).toBe('BLOCKED');
      });
    }

    it('refuses an empty or over-long reason, keeps asking, and the database refuses a confirmed block with none', async () => {
      const payment = await pendingWithReceipt(f, 'b-empty');
      await tap(f, `xa:${payment}`, TG.owner);
      await tap(f, `xb:${payment}`, TG.owner);

      for (const text of ['   ', 'ی'.repeat(501)]) {
        expect((await say(f, text, TG.owner)).replyKey).toBe('bot.admin.block_reason_invalid');
      }
      expect(await openCaptures()).toEqual([{ purpose: 'RECEIPT_BLOCK_REASON' }]);
      expect((await customerStatus(f, f.customer)).status).toBe('ACTIVE');

      await expect(
        db().execute(sql`
          UPDATE admin_amount_captures SET closed_at = now(), close_reason = 'CONFIRMED'
           WHERE closed_at IS NULL`),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
      await expect(
        db().execute(sql`
          UPDATE admin_amount_captures SET reason = '   ' WHERE closed_at IS NULL`),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
    });

    it('draws Block for users.block alone, independently of receipts.review, and each key gates its own path', async () => {
      const payment = await pendingWithReceipt(f, 'b-perm');

      // The reviewer decides and cannot block: no button, and every crafted step refused.
      await tap(f, `C:${payment}`, TG.reviewer);
      const reviewerButtons = keyboardOf(
        f.sent.find((one) => one.method === 'sendPhoto')?.body ?? {},
      );
      expect(reviewerButtons.map((b) => b.callback_data)).toEqual([`D:${payment}`, `E:${payment}`]);
      expect((await tap(f, `xa:${payment}`, TG.reviewer)).replyKey).toBe('bot.admin.refused');
      expect((await tap(f, `xb:${payment}`, TG.reviewer)).replyKey).toBe('bot.admin.refused');
      expect(await openCaptures()).toEqual([]);

      // The blocker blocks and cannot decide: one button, and a crafted approve refused.
      await tap(f, `C:${payment}`, TG.blocker);
      const blockerButtons = keyboardOf(
        f.sent.find((one) => one.method === 'sendPhoto')?.body ?? {},
      );
      expect(blockerButtons.map((b) => b.callback_data)).toEqual([`xa:${payment}`]);
      expect((await tap(f, `D:${payment}`, TG.blocker)).replyKey).toBe('bot.admin.refused');
      expect((await tap(f, `E:${payment}`, TG.blocker)).replyKey).toBe('bot.admin.refused');
      expect(await paymentState(f, payment)).toBe('PENDING');

      const captureId = await blockUpTo(payment, TG.blocker, 'بدرفتاری');
      expect((await tap(f, `xc:${captureId}`, TG.blocker)).replyKey).toBe(
        'bot.admin.blocked_from_receipt',
      );
      expect((await customerStatus(f, f.customer)).status).toBe('BLOCKED');
    });

    it('is fed by nobody else, reads ONE reason, expires, and is confirmed only by its administrator', async () => {
      const payment = await pendingWithReceipt(f, 'b-fin001');
      await tap(f, `xa:${payment}`, TG.owner);
      await tap(f, `xb:${payment}`, TG.owner);

      // Another administrator's message, a customer's, and a command: none is the reason.
      expect((await say(f, 'دلیل دیگری', TG.blocker)).replyKey).toBe('bot.unknown_command');
      expect((await say(f, 'دلیل مشتری', TG.customer)).replyKey).toBe('bot.unknown_command');
      expect((await say(f, '/admin', TG.owner)).replyKey).toBe('bot.admin.panel');
      expect(await openCaptures()).toEqual([{ purpose: 'RECEIPT_BLOCK_REASON' }]);

      await say(f, 'دلیل اصلی', TG.owner);
      const captureId = captureIdFrom('xc:');
      // ONE reason: a second message after the confirmation is not the capture's.
      expect((await say(f, 'دلیل دوم', TG.owner)).replyKey).toBe('bot.unknown_command');
      // Another administrator's tap on the confirm blocks nobody.
      expect((await tap(f, `xc:${captureId}`, TG.blocker)).replyKey).toBe('bot.admin.receipt_gone');
      expect((await customerStatus(f, f.customer)).status).toBe('ACTIVE');

      // Expiry: an aged capture confirms nothing.
      await db().execute(sql`
        UPDATE admin_amount_captures
           SET opened_at = opened_at - interval '1 hour', expires_at = expires_at - interval '1 hour'
         WHERE closed_at IS NULL`);
      expect((await tap(f, `xc:${captureId}`, TG.owner)).replyKey).toBe('bot.admin.block_expired');
      expect((await customerStatus(f, f.customer)).status).toBe('ACTIVE');
    });

    it('opening a block supersedes an open credit capture, and a number typed then is a reason', async () => {
      const payment = await pendingWithReceipt(f, 'b-supersede');
      expect((await tap(f, `wa:${payment}`, TG.owner)).replyKey).toBe(
        'bot.admin.credit_amount_prompt',
      );
      await tap(f, `xb:${payment}`, TG.owner);
      expect(await openCaptures()).toEqual([{ purpose: 'RECEIPT_BLOCK_REASON' }]);
      expect((await say(f, '250000', TG.owner)).replyKey).toBe('bot.admin.block_confirm');
      const credits = await rows(f, sql`SELECT 1 FROM receipt_credits`);
      expect(credits).toEqual([]);
    });

    it('blocks ONCE when the confirm is tapped twice', async () => {
      const payment = await pendingWithReceipt(f, 'b-twice');
      const captureId = await blockUpTo(payment, TG.owner, 'دو بار');
      expect((await tap(f, `xc:${captureId}`, TG.owner)).replyKey).toBe(
        'bot.admin.blocked_from_receipt',
      );
      expect((await tap(f, `xc:${captureId}`, TG.owner)).replyKey).toBe(
        'bot.admin.blocked_from_receipt',
      );
      expect(await audits('customer.block')).toHaveLength(1);
      expect(await events('CustomerBlocked')).toBe(1);
    });

    it('says so, and keeps the stored reason, when the customer was already blocked', async () => {
      const payment = await pendingWithReceipt(f, 'b-already');
      const captureId = await blockUpTo(payment, TG.owner, 'دلیل تازه');
      await f.ctx.container.customers.block(tenantA, f.owner, {
        idempotencyKey: 'blocked-elsewhere',
        customerId: f.customer,
        reason: 'دلیل قبلی',
      });
      expect((await tap(f, `xc:${captureId}`, TG.owner)).replyKey).toBe('bot.admin.block_already');
      expect((await customerStatus(f, f.customer)).blocked_reason).toBe('دلیل قبلی');
    });
  });

  // =========================================================================
  // The blocked customer is told why (File 01 §9)
  // =========================================================================

  describe('the blocked customer’s reason', () => {
    it('shows the blocked customer THEIR OWN stored reason, and nobody else’s', async () => {
      const other = await customerNamed(f, '750901', 'ali_pay');
      await f.ctx.container.customers.block(tenantA, f.owner, {
        idempotencyKey: 'block-zahra',
        customerId: f.customer,
        reason: 'دلیل زهرا',
      });
      await f.ctx.container.customers.block(tenantA, f.owner, {
        idempotencyKey: 'block-ali',
        customerId: other,
        reason: 'دلیل علی',
      });

      await say(f, '/start', TG.customer);
      expect(lastText(f)).toBe(
        CATALOGUE_FA['bot.blocked_with_reason'].replace('{reason}', 'دلیل زهرا'),
      );
      await say(f, '/start', '750901');
      expect(lastText(f)).toBe(
        CATALOGUE_FA['bot.blocked_with_reason'].replace('{reason}', 'دلیل علی'),
      );
      expect(lastText(f)).not.toContain('دلیل زهرا');
    });

    it('reads the reason from THIS tenant’s customer row only', async () => {
      // Tenant B has a blocked customer with the SAME Telegram id and a reason of its own.
      const b = await f.ctx.container.customers.resolveFromUpdate(tenantB, systemActor('b-res'), {
        idempotencyKey: 'b-resolve',
        telegramUserId: TG.customer,
        from: { id: Number(TG.customer), first_name: 'b' },
        botInstanceId: SEED_IDS.botB1 as BotInstanceId,
      });
      const ownerB = adminActorFor(
        await createAdmin(f.ctx.container, tenantB, { username: 'owner-b', roleKeys: ['owner'] }),
      );
      await f.ctx.container.customers.block(tenantB, ownerB, {
        idempotencyKey: 'block-b',
        customerId: b.customer.id,
        reason: 'دلیل مستأجر دیگر',
      });
      await f.ctx.container.customers.block(tenantA, f.owner, {
        idempotencyKey: 'block-a',
        customerId: f.customer,
        reason: 'دلیل مستأجر الف',
      });
      await say(f, '/start', TG.customer);
      expect(lastText(f)).toContain('دلیل مستأجر الف');
      expect(lastText(f)).not.toContain('دلیل مستأجر دیگر');
    });

    it('a block with no reason still reads as the whole blocked sentence', async () => {
      await f.ctx.container.customers.block(tenantA, f.owner, {
        idempotencyKey: 'block-no-reason',
        customerId: f.customer,
        reason: null,
      });
      await say(f, '/start', TG.customer);
      expect(lastText(f)).toBe(CATALOGUE_FA['bot.blocked']);
    });

    it('the customers section’s fixed surface note is never shown as a reason', async () => {
      await f.ctx.container.customers.block(tenantA, f.owner, {
        idempotencyKey: 'block-surface-note',
        customerId: f.customer,
        reason: 'Blocked from the Telegram management panel.',
      });
      await say(f, '/start', TG.customer);
      expect(lastText(f)).toBe(CATALOGUE_FA['bot.blocked']);
    });

    it('the customer blocked from a receipt gets the blocked-account reply with that reason', async () => {
      const payment = await pendingWithReceipt(f, 'b-customer-sees');
      const captureId = await blockUpTo(payment, TG.owner, 'رسید تقلبی');
      await tap(f, `xc:${captureId}`, TG.owner);
      await say(f, '/start', TG.customer);
      expect(lastText(f)).toBe(
        CATALOGUE_FA['bot.blocked_with_reason'].replace('{reason}', 'رسید تقلبی'),
      );
    });
  });

  // =========================================================================
  // The rejection's mandatory reason (File 01 §7)
  // =========================================================================

  describe('the rejection’s mandatory reason (File 01 §7)', () => {
    it('has no one-tap rejection: the button asks for a reason, restates it, and rejects on the confirm', async () => {
      const payment = await pendingWithReceipt(f, 'r-flow');
      await tap(f, `E:${payment}`, TG.reviewer);
      // The tap rejected nothing.
      expect(await paymentState(f, payment)).toBe('PENDING');

      expect((await say(f, '  ', TG.reviewer)).replyKey).toBe('bot.admin.reject_reason_invalid');
      expect((await say(f, 'مبلغ واریزی با سفارش نمی‌خواند', TG.reviewer)).replyKey).toBe(
        'bot.admin.reject_confirm',
      );
      expect(lastText(f)).toContain('مبلغ واریزی با سفارش نمی‌خواند');
      expect(await paymentState(f, payment)).toBe('PENDING');
      const captureId = captureIdFrom('xe:');

      expect((await tap(f, `xe:${captureId}`, TG.reviewer)).replyKey).toBe('bot.admin.rejected');
      expect(await paymentState(f, payment)).toBe('FAILED');
      const [row] = await rows<{ resolution_note: string; resolved_by_admin_id: string }>(
        f,
        sql`SELECT resolution_note, resolved_by_admin_id FROM payments WHERE id = ${payment}`,
      );
      expect(row).toEqual({
        resolution_note: 'مبلغ واریزی با سفارش نمی‌خواند',
        resolved_by_admin_id: reviewer,
      });

      // The customer is told, and told WHY.
      expect(await notices('PAYMENT_REJECTED')).toBe(1);
      const lane = capturingLane(f.ctx);
      await lane.sweep(tenantA);
      const said = lane.sends.filter((one) => one.templateKey === 'bot.payment.rejected');
      expect(said.map((one) => one.values)).toEqual([{ reason: 'مبلغ واریزی با سفارش نمی‌خواند' }]);
      expect(lane.rendered().join('\n')).toContain('دلیل: مبلغ واریزی با سفارش نمی‌خواند');
    });

    it('rejects ONCE and notifies ONCE when the confirm is tapped twice or replayed', async () => {
      const payment = await pendingWithReceipt(f, 'r-twice');
      const captureId = await rejectUpTo(payment, TG.reviewer, 'تکراری');
      expect((await tap(f, `xe:${captureId}`, TG.reviewer)).replyKey).toBe('bot.admin.rejected');
      expect((await tap(f, `xe:${captureId}`, TG.reviewer)).replyKey).toBe('bot.admin.rejected');
      await f.ctx.container.receiptRejectCaptures.confirm(tenantA, reviewerActor, { captureId });
      expect(await audits('payment.reject')).toHaveLength(1);
      expect(await notices('PAYMENT_REJECTED')).toBe(1);
    });

    it('refuses a rejection with no reason at the payment service itself', async () => {
      const payment = await pendingWithReceipt(f, 'r-service');
      for (const note of ['', '   ', 'ی'.repeat(501)]) {
        await expect(
          f.ctx.container.payments.rejectManualTransfer(tenantA, reviewerActor, payment, {
            idempotencyKey: `r-service-${String(note.length)}`,
            note,
          }),
        ).rejects.toMatchObject({
          code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
          details: { reason: 'REJECT_REASON_REQUIRED' },
        });
      }
      expect(await paymentState(f, payment)).toBe('PENDING');
      expect(await notices('PAYMENT_REJECTED')).toBe(0);
    });

    it('a rejection racing an approval through the reason path decides once', async () => {
      const payment = await pendingWithReceipt(f, 'r-race-approve');
      const captureId = await rejectUpTo(payment, TG.reviewer, 'دیر رسید');
      const held = holdPaymentWrite('resolve');
      const rejecting = f.ctx.container.receiptRejectCaptures.confirm(tenantA, reviewerActor, {
        captureId,
      });
      rejecting.catch(() => undefined);
      await held.inside;
      const approving = f.ctx.container.payments.confirmManualTransfer(tenantA, f.owner, payment, {
        idempotencyKey: 'r-race-approve-approve',
        note: 'approve',
      });
      approving.catch(() => undefined);
      await awaitWaitingOn('update "payments"');
      held.release();
      const [r, a] = await Promise.allSettled([rejecting, approving]);
      expect(r.status).toBe('fulfilled');
      expect(a).toMatchObject({
        status: 'rejected',
        reason: { code: COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID },
      });
      expect(await paymentState(f, payment)).toBe('FAILED');
      expect(await notices('PAYMENT_REJECTED')).toBe(1);
      expect(await audits('payment.confirm')).toEqual([]);
      vi.restoreAllMocks();
    }, 30_000);

    it('a credit racing a rejection through the reason path decides once', async () => {
      const payment = await pendingWithReceipt(f, 'r-race-credit');
      const captureId = await rejectUpTo(payment, TG.reviewer, 'رد قبل از واریز');
      const held = holdPaymentWrite('resolve');
      const crediting = f.ctx.container.receiptDispositions.creditToWallet(tenantA, f.owner, {
        idempotencyKey: 'r-race-credit-credit',
        paymentId: payment,
        amountMinor: 50_000n,
        note: null,
      });
      crediting.catch(() => undefined);
      await held.inside;
      const rejecting = f.ctx.container.receiptRejectCaptures.confirm(tenantA, reviewerActor, {
        captureId,
      });
      rejecting.catch(() => undefined);
      await awaitWaitingOn('payments');
      held.release();
      const [c, r] = await Promise.allSettled([crediting, rejecting]);
      expect(c.status).toBe('fulfilled');
      expect(r).toMatchObject({
        status: 'rejected',
        reason: { code: COMMERCE_ERROR_CODES.PAYMENT_STATE_INVALID },
      });
      const credits = await rows(
        f,
        sql`SELECT 1 FROM receipt_credits WHERE payment_id = ${payment}`,
      );
      expect(credits).toHaveLength(1);
      expect(await notices('PAYMENT_REJECTED')).toBe(0);
      expect(await audits('payment.reject')).toEqual([]);
      vi.restoreAllMocks();
    }, 30_000);

    it('answers a stale button with WHICH way the receipt was decided', async () => {
      const credited = await pendingWithReceipt(f, 'r-stale-credit');
      await f.ctx.container.receiptDispositions.creditToWallet(tenantA, f.owner, {
        idempotencyKey: 'stale-credit',
        paymentId: credited,
        amountMinor: 120_000n,
        note: null,
      });
      for (const data of [`D:${credited}`, `E:${credited}`, `wa:${credited}`, `C:${credited}`]) {
        expect((await tap(f, data, TG.owner)).replyKey, data).toBe(
          'bot.admin.receipt_already_credited',
        );
        expect(lastText(f)).toContain('120,000');
      }
      expect(await paymentState(f, credited)).toBe('FAILED');
      expect(await ledgerCount(f)).toBe(1);

      const approved = await pendingWithReceipt(f, 'r-stale-approve');
      await f.ctx.container.payments.confirmManualTransfer(tenantA, f.owner, approved, {
        idempotencyKey: 'stale-approve',
        note: 'ok',
      });
      expect((await tap(f, `E:${approved}`, TG.owner)).replyKey).toBe(
        'bot.admin.receipt_already_approved',
      );

      const rejected = await pendingWithReceipt(f, 'r-stale-reject');
      await f.ctx.container.payments.rejectManualTransfer(tenantA, f.owner, rejected, {
        idempotencyKey: 'stale-reject',
        note: 'no',
      });
      expect((await tap(f, `D:${rejected}`, TG.owner)).replyKey).toBe(
        'bot.admin.receipt_already_rejected',
      );
    });
  });

  // =========================================================================
  // Block against each disposition — produced races
  // =========================================================================

  describe('a block racing each disposition', () => {
    it('credit holds the customer row; the block waits on it; both commit, one credit', async () => {
      const payment = await pendingWithReceipt(f, 'x-credit-first');
      const captureId = await blockUpTo(payment, TG.owner, 'مسابقه با واریز');
      const held = holdLockCustomer();

      const crediting = f.ctx.container.receiptDispositions.creditToWallet(tenantA, f.owner, {
        idempotencyKey: 'x-credit-first-credit',
        paymentId: payment,
        amountMinor: 80_000n,
        note: null,
      });
      crediting.catch(() => undefined);
      await held.inside;
      const blocking = f.ctx.container.receiptBlockCaptures.confirm(tenantA, f.owner, {
        captureId,
      });
      blocking.catch(() => undefined);
      await awaitWaitingOn('update "customers"');
      held.release();

      const [c, b] = await Promise.allSettled([crediting, blocking]);
      expect(c.status).toBe('fulfilled');
      expect(b).toMatchObject({ status: 'fulfilled', value: { outcome: 'DONE' } });
      expect(await paymentState(f, payment)).toBe('FAILED');
      expect(
        await rows(f, sql`SELECT 1 FROM receipt_credits WHERE payment_id = ${payment}`),
      ).toHaveLength(1);
      expect((await customerStatus(f, f.customer)).status).toBe('BLOCKED');
      vi.restoreAllMocks();
    }, 30_000);

    it('the block holds the customer row; the credit waits on it; both commit, one credit', async () => {
      const payment = await pendingWithReceipt(f, 'x-block-first-credit');
      const captureId = await blockUpTo(payment, TG.owner, 'بلاک اول');
      const held = holdCustomerSetStatus();

      const blocking = f.ctx.container.receiptBlockCaptures.confirm(tenantA, f.owner, {
        captureId,
      });
      blocking.catch(() => undefined);
      await held.inside;
      const crediting = f.ctx.container.receiptDispositions.creditToWallet(tenantA, f.owner, {
        idempotencyKey: 'x-block-first-credit-credit',
        paymentId: payment,
        amountMinor: 70_000n,
        note: null,
      });
      crediting.catch(() => undefined);
      await awaitWaitingOn('for update');
      held.release();

      const [b, c] = await Promise.allSettled([blocking, crediting]);
      expect(b).toMatchObject({ status: 'fulfilled', value: { outcome: 'DONE' } });
      expect(c.status).toBe('fulfilled');
      expect(await paymentState(f, payment)).toBe('FAILED');
      expect(
        await rows(f, sql`SELECT 1 FROM receipt_credits WHERE payment_id = ${payment}`),
      ).toHaveLength(1);
      expect((await customerStatus(f, f.customer)).status).toBe('BLOCKED');
      vi.restoreAllMocks();
    }, 30_000);

    it('an approval holds the customer row in settlement; the block waits; both commit, one settlement', async () => {
      const payment = await pendingWithReceipt(f, 'x-approve-first');
      const captureId = await blockUpTo(payment, TG.owner, 'مسابقه با تأیید');
      const held = holdLockCustomer();

      const approving = f.ctx.container.payments.confirmManualTransfer(
        tenantA,
        reviewerActor,
        payment,
        {
          idempotencyKey: 'x-approve-first-approve',
          note: 'approve',
        },
      );
      approving.catch(() => undefined);
      await held.inside;
      const blocking = f.ctx.container.receiptBlockCaptures.confirm(tenantA, f.owner, {
        captureId,
      });
      blocking.catch(() => undefined);
      await awaitWaitingOn('update "customers"');
      held.release();

      const [a, b] = await Promise.allSettled([approving, blocking]);
      expect(a.status).toBe('fulfilled');
      expect(b).toMatchObject({ status: 'fulfilled', value: { outcome: 'DONE' } });
      expect(await paymentState(f, payment)).toBe('CONFIRMED');
      expect(await audits('payment.confirm')).toHaveLength(1);
      expect((await customerStatus(f, f.customer)).status).toBe('BLOCKED');
      vi.restoreAllMocks();
    }, 30_000);

    it('the block holds the customer row; the approval waits in settlement; both commit, one settlement', async () => {
      const payment = await pendingWithReceipt(f, 'x-block-first-approve');
      const captureId = await blockUpTo(payment, TG.owner, 'بلاک پیش از تأیید');
      const held = holdCustomerSetStatus();

      const blocking = f.ctx.container.receiptBlockCaptures.confirm(tenantA, f.owner, {
        captureId,
      });
      blocking.catch(() => undefined);
      await held.inside;
      const approving = f.ctx.container.payments.confirmManualTransfer(
        tenantA,
        reviewerActor,
        payment,
        {
          idempotencyKey: 'x-block-first-approve-approve',
          note: 'approve',
        },
      );
      approving.catch(() => undefined);
      await awaitWaitingOn('for update');
      held.release();

      const [b, a] = await Promise.allSettled([blocking, approving]);
      expect(b).toMatchObject({ status: 'fulfilled', value: { outcome: 'DONE' } });
      expect(a.status).toBe('fulfilled');
      expect(await paymentState(f, payment)).toBe('CONFIRMED');
      expect((await customerStatus(f, f.customer)).status).toBe('BLOCKED');
      vi.restoreAllMocks();
    }, 30_000);

    it('a rejection does NOT wait on a held block — they share no row — and both commit', async () => {
      const payment = await pendingWithReceipt(f, 'x-reject');
      const captureId = await blockUpTo(payment, TG.owner, 'بلاک و رد');
      const held = holdCustomerSetStatus();

      const blocking = f.ctx.container.receiptBlockCaptures.confirm(tenantA, f.owner, {
        captureId,
      });
      blocking.catch(() => undefined);
      await held.inside;
      // The barrier: the rejection completes WHILE the block is still held open.
      const rejected = await f.ctx.container.payments.rejectManualTransfer(
        tenantA,
        reviewerActor,
        payment,
        {
          idempotencyKey: 'x-reject-reject',
          note: 'رد در حین بلاک',
        },
      );
      expect(rejected.state).toBe('FAILED');
      expect((await customerStatus(f, f.customer)).status).toBe('ACTIVE');
      held.release();

      await expect(blocking).resolves.toMatchObject({ outcome: 'DONE' });
      expect(await paymentState(f, payment)).toBe('FAILED');
      expect((await customerStatus(f, f.customer)).status).toBe('BLOCKED');
      expect(await notices('PAYMENT_REJECTED')).toBe(1);
      vi.restoreAllMocks();
    }, 30_000);
  });

  // -------------------------------------------------------------------------
  // Race helpers
  // -------------------------------------------------------------------------

  function gateAfter<T extends object, K extends keyof T & string>(target: T, method: K) {
    const original = (target[method] as unknown as (...args: unknown[]) => Promise<unknown>).bind(
      target,
    );
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let calls = 0;
    vi.spyOn(target, method as never).mockImplementation((async (...args: unknown[]) => {
      const result = await original(...args);
      calls += 1;
      if (calls === 1) {
        entered();
        await gate;
      }
      return result;
    }) as never);
    return { inside, release: open };
  }

  /** The wallet ledger's customer lock, shared by the credit and the settlement. */
  function holdLockCustomer() {
    const wallet = (
      f.ctx.container.receiptDispositions as unknown as {
        deps: { wallet: { lockCustomer: unknown } };
      }
    ).deps.wallet;
    return gateAfter(wallet as { lockCustomer: () => Promise<boolean> }, 'lockCustomer');
  }

  /** The block's conditional UPDATE on the customer row, in `CustomerService`. */
  function holdCustomerSetStatus() {
    const repository = (
      f.ctx.container.customers as unknown as {
        deps: { repository: { setStatus: unknown } };
      }
    ).deps.repository;
    return gateAfter(repository as { setStatus: () => Promise<boolean> }, 'setStatus');
  }

  /** The payment repository's `resolve` (the PENDING→FAILED edge), shared by reject and credit. */
  function holdPaymentWrite(method: 'resolve') {
    const repository = (
      f.ctx.container.payments as unknown as {
        deps: { repository: { resolve: unknown } };
      }
    ).deps.repository;
    return gateAfter(repository as { resolve: () => Promise<boolean> }, method);
  }

  async function awaitWaitingOn(fragment: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const waiting = await rows<{ query: string }>(
        f,
        sql`SELECT query FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'
               AND pid <> pg_backend_pid()`,
      );
      if (waiting.length >= 1) {
        expect(waiting[0]?.query.toLowerCase()).toContain(fragment);
        return;
      }
      if (Date.now() > deadline) throw new Error(`nothing ever waited on ${fragment}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
});
