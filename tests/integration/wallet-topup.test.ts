import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isNexaError,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PaymentId,
  type UserId,
} from '@nexa/contracts';
import type { PaymentRepository } from '../../apps/api/src/modules/commerce/payments/application/ports';
import type { TransactionScope } from '../../apps/api/src/infrastructure/persistence/unit-of-work';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Wallet top-up: a payment that buys nothing, and the one credit it produces.
 *
 * Every case here is one of the ways money could go wrong in a lane with no order to
 * anchor it:
 *
 *   - the AMOUNT is the tenant's configuration, never the tap's claim;
 *   - a confirmed top-up credits the ledger exactly ONCE, however many times it is
 *     confirmed, replayed or raced;
 *   - nothing is provisioned and no order exists to settle;
 *   - a currency that cannot be spent is refused rather than credited;
 *   - one tenant's top-up is unreachable with the other tenant's actor.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const CARD = '6037991234567893';

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('a customer topping up their wallet', () => {
  let ctx: TestContext;
  let customerA: UserId;
  let ownerA: ActorContext;
  let ownerB: ActorContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ownerA = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-topup-a', roleKeys: ['owner'] }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-topup-b', roleKeys: ['owner'] }),
    );
    customerA = await customer('930100');
    // The seed's own enabled default account is the destination — the same one an order's
    // transfer uses, which is the point: a top-up funds through the 5A rail unchanged.
    await setPresets([{ amountMinor: '500000', currency: 'IRT' }]);
  });

  // -------------------------------------------------------------------------
  // The amount is configuration, not the tap
  // -------------------------------------------------------------------------

  it('issues a transfer for an offered amount, against no order', async () => {
    const { payment, destination } = await topup(500_000n, 't1');

    expect(payment.state).toBe('PENDING');
    expect(payment.orderId).toBeNull();
    expect(payment.amount.amountMinor).toBe(500_000n);
    expect(payment.amount.currency).toBe('IRT');
    // The structured destination 5A froze, on the top-up path too.
    expect(destination?.cardNumber).toBe(CARD);

    // Nothing was bought: no order, no service, no provisioning work.
    expect(await count('orders')).toBe(0);
    expect(await count('services')).toBe(0);
    expect(await count('provisioning_operations')).toBe(0);
  });

  it('refuses an amount the tenant does not offer', async () => {
    await expectRefusal(topup(400_000n, 't2'), 'commerce.topup_not_offered');
    expect(await count('payments')).toBe(0);
  });

  it('refuses a preset below the configured minimum', async () => {
    await setPresets([{ amountMinor: '500000', currency: 'IRT' }]);
    await setSetting('wallet.topup.minimum', { amountMinor: '600000', currency: 'IRT' });

    await expectRefusal(topup(500_000n, 't3'), 'commerce.topup_below_minimum');
    expect(await count('payments')).toBe(0);
  });

  it('accepts an amount at exactly the minimum', async () => {
    await setSetting('wallet.topup.minimum', { amountMinor: '500000', currency: 'IRT' });
    const { payment } = await topup(500_000n, 't4');
    expect(payment.amount.amountMinor).toBe(500_000n);
  });

  it('refuses everything when no amount is configured', async () => {
    await setPresets([]);
    await expectRefusal(topup(500_000n, 't5'), 'commerce.topup_unavailable');
    expect(await ctx.container.payments.topupPresets(tenantA)).toHaveLength(0);
  });

  it('refuses when there is nowhere to transfer the money', async () => {
    /*
     * Disabled by SQL, and that is not a shortcut — it is the only way this state is
     * reachable. `PaymentAccountService.setEnabled` refuses to disable the default
     * without another account promoted first, which is a product rule worth having: an
     * installation cannot be left with nowhere to receive money through its own API. So
     * the branch under test here is the service's LAST line of defence, against a state
     * only a direct write or a deleted row can produce.
     */
    await ctx.container.database.db.execute(
      sql`UPDATE payment_accounts SET enabled = false, is_default = false
           WHERE tenant_id = ${tenantA.tenantId}`,
    );

    await expectRefusal(topup(500_000n, 't6'), 'commerce.topup_unavailable');
    expect(await count('payments')).toBe(0);
  });

  it('does not offer a preset in a currency the installation does not sell in', async () => {
    await setPresets([
      { amountMinor: '500000', currency: 'IRT' },
      { amountMinor: '900000', currency: 'IRR' },
    ]);

    // The READ the keyboard is drawn from drops it...
    const offered = await ctx.container.payments.topupPresets(tenantA);
    expect(offered.map((one) => one.amountMinor)).toStrictEqual([500_000n]);
    // ...and the WRITE refuses it, so a customer with an older keyboard cannot use it.
    await expectRefusal(topup(900_000n, 't7'), 'commerce.topup_not_offered');
  });

  it('answers a second tap with the reference the customer already holds', async () => {
    await setPresets([
      { amountMinor: '500000', currency: 'IRT' },
      { amountMinor: '900000', currency: 'IRT' },
    ]);
    const first = await topup(500_000n, 't8-a');
    // A DIFFERENT amount, and deliberately: two open top-ups would be two references for
    // one intention, and the operator could not tell which a bank transfer names.
    const second = await topup(900_000n, 't8-b');

    expect(second.payment.id).toBe(first.payment.id);
    expect(second.payment.amount.amountMinor).toBe(500_000n);
    expect(await count('payments')).toBe(1);
  });

  it('answers a redelivered request without creating a second payment', async () => {
    const first = await topup(500_000n, 't9');
    const replay = await topup(500_000n, 't9');
    expect(replay.payment.id).toBe(first.payment.id);
    expect(await count('payments')).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Exactly one credit
  // -------------------------------------------------------------------------

  it('credits the wallet once when an operator confirms', async () => {
    const { payment } = await topup(500_000n, 'c1');

    const confirmed = await confirm(payment.id, 'c1-confirm');
    expect(confirmed.payment.state).toBe('CONFIRMED');
    expect(confirmed.order).toBeNull();

    const balance = await ctx.container.wallet.balance(tenantA, ownerA, customerA);
    expect(balance.amountMinor).toBe(500_000n);

    const entries = await ledgerRows();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.reason).toBe('TOPUP_RECEIPT');
    expect(entries[0]?.direction).toBe('CREDIT');
    expect(entries[0]?.payment_id).toBe(payment.id);
    expect(entries[0]?.order_id).toBeNull();
    // The reference is derived from the PAYMENT, which is what makes every funding path
    // land on the same row.
    expect(entries[0]?.reference).toBe(`${payment.id}:topup`);

    // The customer is told, in the lane that has a template for it.
    const queued = await notifications();
    expect(queued).toStrictEqual([{ kind: 'WALLET_TOPUP_CREDITED', subject_id: payment.id }]);

    // Still nothing bought.
    expect(await count('orders')).toBe(0);
    expect(await count('services')).toBe(0);
    expect(await count('provisioning_operations')).toBe(0);
  });

  it('announces the TOPUP_RECEIPT credit with one WalletEntryRecorded, and not again for a second operator', async () => {
    /*
     * WP10 P4 (D4). Every other ledger writer emits `WalletEntryRecorded` in its
     * transaction; the top-up credit did not. It does now, and only for the movement it
     * WROTE — a second operator's confirmation re-reads the entry and is not a second one.
     */
    const { payment } = await topup(500_000n, 'c1e');
    await confirm(payment.id, 'c1e-confirm');
    await ctx.container.payments.confirmManualTransfer(
      tenantA,
      adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'finance-topup-event',
          roleKeys: ['finance'],
        }),
      ),
      payment.id,
      { idempotencyKey: 'c1e-second', note: 'seen twice' },
    );

    const entries = (await ctx.container.database.db.execute(
      sql`SELECT id FROM wallet_entries WHERE reason = 'TOPUP_RECEIPT'` as never,
    )) as unknown as { rows: { id: string }[] };
    expect(entries.rows).toHaveLength(1);
    const entry = entries.rows[0];
    const events = (await ctx.container.database.db.execute(
      sql`SELECT payload->>'entryId' AS entry, payload->>'reason' AS reason,
                 payload->>'amountMinor' AS amount, payload->>'currency' AS currency
            FROM outbox_messages WHERE event_type = 'WalletEntryRecorded'` as never,
    )) as unknown as { rows: Record<string, string>[] };
    expect(events.rows).toEqual([
      { entry: entry?.id, reason: 'TOPUP_RECEIPT', amount: '500000', currency: 'IRT' },
    ]);
  });

  it('credits once for a redelivered confirmation', async () => {
    const { payment } = await topup(500_000n, 'c2');
    await confirm(payment.id, 'c2-confirm');
    await confirm(payment.id, 'c2-confirm');

    expect(await ledgerRows()).toHaveLength(1);
    expect((await ctx.container.wallet.balance(tenantA, ownerA, customerA)).amountMinor).toBe(
      500_000n,
    );
  });

  it('credits once when a second operator confirms under a different key', async () => {
    const { payment } = await topup(500_000n, 'c3');
    const second = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'finance-topup',
        roleKeys: ['finance'],
      }),
    );

    await confirm(payment.id, 'c3-first');
    /*
     * A DIFFERENT idempotency key, so nothing is answered from the store: this reaches
     * the mutation, finds the payment already CONFIRMED, and must not append a second
     * entry. The reference is derived from the payment, so there is no second reference
     * for it to append under.
     */
    const again = await ctx.container.payments.confirmManualTransfer(tenantA, second, payment.id, {
      idempotencyKey: 'c3-second',
      note: 'seen in the statement',
    });

    expect(again.payment.state).toBe('CONFIRMED');
    expect(await ledgerRows()).toHaveLength(1);
    expect((await ctx.container.wallet.balance(tenantA, ownerA, customerA)).amountMinor).toBe(
      500_000n,
    );
    // One notification, not two: the loser of the race has nothing new to announce.
    expect(await notifications()).toHaveLength(1);
  });

  it('credits once when two confirmations run concurrently', async () => {
    const { payment } = await topup(500_000n, 'c4');
    const second = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'finance-race',
        roleKeys: ['finance'],
      }),
    );

    /*
     * The interleaving is driven by the PAYMENT ROW: a holder connection takes it FOR
     * UPDATE, the suite waits until both confirmations are provably blocked on it, and
     * only then releases. Not `Promise.all` timing — with the conditional UPDATE removed
     * this test would have to fail for a reason it names, and a sleep could not tell the
     * difference between serialised and lucky.
     */
    const settled = await ctx.container.database.withClient(async (holder) => {
      await holder.query('BEGIN');
      try {
        await holder.query('SELECT id FROM payments WHERE id = $1 FOR UPDATE', [payment.id]);
        const one = outcomeOf(confirm(payment.id, 'c4-a'));
        const two = outcomeOf(
          ctx.container.payments.confirmManualTransfer(tenantA, second, payment.id, {
            idempotencyKey: 'c4-b',
            note: 'also seen',
          }),
        );
        await awaitBlocked(2);
        await holder.query('COMMIT');
        return [one, two] as const;
      } catch (error: unknown) {
        await holder.query('ROLLBACK');
        throw error;
      }
    });

    const done = await Promise.all(settled);
    // Both are ANSWERED — a second operator pressing approve is not an error — and
    // between them they produce one credit.
    expect(done.filter((one) => one.ok)).toHaveLength(2);
    expect(await ledgerRows()).toHaveLength(1);
    expect((await ctx.container.wallet.balance(tenantA, ownerA, customerA)).amountMinor).toBe(
      500_000n,
    );
    expect(await notifications()).toHaveLength(1);
  });

  it('refuses to credit a currency the installation no longer sells in', async () => {
    const { payment } = await topup(500_000n, 'c5');
    // The tenant changes the selling currency AFTER the payment was issued. Crediting the
    // old denomination would put money in a wallet no order can be priced against.
    await setSetting('sales.currency', 'IRR');

    await expectRefusal(confirm(payment.id, 'c5-confirm'), 'commerce.wallet_currency_unsupported');
    expect(await ledgerRows()).toHaveLength(0);
    expect((await paymentRow(payment.id)).state).toBe('PENDING');
  });

  it('rejects a top-up without crediting anything', async () => {
    const { payment } = await topup(500_000n, 'c6');
    await ctx.container.payments.rejectManualTransfer(tenantA, ownerA, payment.id, {
      idempotencyKey: 'c6-reject',
      note: 'nothing arrived',
    });

    expect((await paymentRow(payment.id)).state).toBe('FAILED');
    expect(await ledgerRows()).toHaveLength(0);
    expect((await ctx.container.wallet.balance(tenantA, ownerA, customerA)).amountMinor).toBe(0n);
    /*
     * The customer is told through the SAME kind an order's rejection uses, which is why
     * `bot.payment.rejected` no longer asserts that an order is still open: a rejected
     * top-up has no order, and one kind renders one frozen template for both.
     */
    expect(await notifications()).toStrictEqual([
      { kind: 'PAYMENT_REJECTED', subject_id: payment.id },
    ]);
  });

  // -------------------------------------------------------------------------
  // The 5A/5R rail, unchanged
  // -------------------------------------------------------------------------

  it('takes a receipt against a top-up, through the flow an order uses', async () => {
    const { payment } = await topup(500_000n, 'r1');

    // The combined button: the claim is recorded and the upload window opens.
    const signalled = await ctx.container.payments.signalTransferSent(
      tenantA,
      systemActor('r1-signal'),
      customerA,
      { idempotencyKey: 'r1-signal', paymentId: payment.id as PaymentId, botInstanceId: BOT_A },
    );
    expect(signalled.receiptWindow).not.toBeNull();

    const filed = await ctx.container.receipts.submit(tenantA, systemActor('r1-file'), customerA, {
      idempotencyKey: 'r1-file',
      botInstanceId: BOT_A,
      file: {
        kind: 'PHOTO',
        fileId: 'file-topup-receipt',
        fileUniqueId: 'u-topup-receipt',
        mimeType: null,
        fileSize: 102_400n,
        fileName: null,
        telegramMessageId: 42n,
      },
    });

    // Filed against the TOP-UP, and it settles nothing: the payment is still pending and
    // the wallet is still empty until an operator confirms.
    expect(filed.filed).toBe(true);
    expect(filed.paymentId).toBe(payment.id);
    expect((await paymentRow(payment.id)).state).toBe('PENDING');
    expect(await ledgerRows()).toHaveLength(0);
  });

  it('lets a customer withdraw their own pending top-up', async () => {
    const { payment } = await topup(500_000n, 'w1');

    const withdrawn = await ctx.container.payments.withdrawPending(
      tenantA,
      systemActor('w1-cancel'),
      customerA,
      { idempotencyKey: 'w1-cancel', paymentId: payment.id },
    );

    expect(withdrawn.state).toBe('CANCELLED');
    expect(await ledgerRows()).toHaveLength(0);
    // And the next tap issues a fresh reference rather than handing back a dead one.
    const again = await topup(500_000n, 'w1-again');
    expect(again.payment.id).not.toBe(payment.id);
  });

  // -------------------------------------------------------------------------
  // Tenancy
  // -------------------------------------------------------------------------

  it('does not let another tenant confirm a top-up', async () => {
    const { payment } = await topup(500_000n, 'x1');

    await expectRefusal(
      ctx.container.payments.confirmManualTransfer(tenantB, ownerB, payment.id, {
        idempotencyKey: 'x1-cross',
        note: 'not mine',
      }),
      'commerce.payment_not_found',
    );
    expect(await ledgerRows()).toHaveLength(0);
    expect((await paymentRow(payment.id)).state).toBe('PENDING');
  });

  it('keeps one tenant’s presets out of the other’s', async () => {
    await setPresets([{ amountMinor: '500000', currency: 'IRT' }]);
    expect(await ctx.container.payments.topupPresets(tenantB)).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // One open top-up, under a produced race
  // -------------------------------------------------------------------------

  it('hands a request that arrives mid-flight the top-up already being issued', async () => {
    await setPresets([{ amountMinor: '500000', currency: 'IRT' }]);

    /*
     * The race is MADE. `Promise.allSettled` of two service calls does not reliably
     * interleave — `financial-concurrency.test.ts` records the lesson, and the first
     * draft of this test was green with the lock deleted, which is the proof.
     *
     * A transaction is held open having taken the customer lock and inserted a PENDING
     * top-up, exactly as a first request does. The service is then called with a
     * DIFFERENT idempotency key — a double tap, or the same customer in a second
     * Telegram client — so the store has nothing to replay and the create path runs.
     *
     * With the lock, the racer blocks on the customer row, resumes after the commit,
     * reads the held top-up as open, and hands it back: one reference, and the customer
     * is told the amount they will actually be credited.
     *
     * Without the lock, the racer reads null (the holder is uncommitted), inserts, and
     * blocks on `payments_open_topup_key` instead; the holder commits and the racer's
     * insert dies with a raw 23505 — an error nothing maps, which the webhook swallows,
     * so the customer who double-tapped gets silence. The index alone keeps the ledger
     * honest; the lock is what keeps the customer answered.
     */
    const paymentRepository = new DrizzlePaymentRepository(ctx.container.database.db);
    const walletRepository = new DrizzleWalletRepository(ctx.container.database.db);
    const heldId = ctx.container.ids.uuid() as PaymentId;
    const now = ctx.container.clock.now();

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      holding = resolve;
    });

    const holder = ctx.container.uow.run(tenantA, async (tx) => {
      await walletRepository.lockCustomer(tenantA, customerA, tx);
      await paymentRepository.create(
        tenantA,
        {
          id: heldId,
          customerId: customerA,
          orderId: null,
          method: 'MANUAL_TRANSFER',
          amount: money(500_000n, 'IRT'),
          reference: 'held-open-topup',
          expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
          now,
        },
        tx,
      );
      holding();
      await held;
    });

    await locked;
    const racing = topup(500_000n, 'race-topup-b').then(
      (result) => result,
      (error: unknown) => error,
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await holder;
    const outcome = await racing;

    expect(outcome, 'the racer was not handed the open top-up').toMatchObject({
      payment: { id: heldId, state: 'PENDING' },
    });
    expect(await openTopupCount()).toBe(1);
  }, 30_000);

  it('hands back the SAME reference when the second request follows the first', async () => {
    await setPresets([{ amountMinor: '500000', currency: 'IRT' }]);
    const first = await topup(500_000n, 'serial-topup-a');
    const second = await topup(500_000n, 'serial-topup-b');

    /*
     * The serial case, which the lock must not have changed: an open top-up is handed
     * back rather than refused, because the customer is looking at bank details for it.
     */
    expect(second.payment.id).toBe(first.payment.id);
    expect(await openTopupCount()).toBe(1);
  }, 30_000);

  // -------------------------------------------------------------------------
  // A confirmation that lost its race is not a confirmation
  // -------------------------------------------------------------------------

  it('refuses to confirm a top-up a rejection took mid-flight', async () => {
    await setPresets([{ amountMinor: '500000', currency: 'IRT' }]);
    const { payment } = await topup(500_000n, 'lost-race-reject');

    /*
     * The race is MADE, not hoped for, and it has to be: a rejection committed BEFORE
     * the call is caught by the guard `confirmManualTransfer` runs first, so a
     * sequential test proves nothing about this branch. `financial-concurrency.test.ts`
     * records the same lesson about `Promise.allSettled`.
     *
     * The real window is inside one transaction: `confirmManualTransfer` reads the
     * payment with a plain SELECT — no `FOR UPDATE` — sees PENDING, and only then runs
     * the conditional UPDATE. Anything that moves the row out of PENDING in between wins,
     * and `confirm` returns false. That is an operator rejecting in Telegram while
     * another approves in the Web Admin, or the expiry sweep landing on the same row.
     *
     * So the rejection is committed from inside that window, by hooking the conditional
     * UPDATE itself. Everything before it has already run against a PENDING row.
     */
    const repository = (
      ctx.container.payments as unknown as { deps: { repository: PaymentRepository } }
    ).deps.repository;
    const original = repository.confirm.bind(repository);
    const hook = vi
      .spyOn(repository, 'confirm')
      .mockImplementation(async (...args: Parameters<PaymentRepository['confirm']>) => {
        hook.mockRestore();
        await ctx.container.payments.rejectManualTransfer(tenantA, ownerA, payment.id, {
          idempotencyKey: 'lost-race-reject-reject',
          note: 'no such transfer in the statement',
        });
        return original(...args);
      });

    try {
      /*
       * The branch used to re-read the row and return it WITHOUT checking its state, so
       * the Web Admin showed its confirmation toast and the Telegram admin path replied
       * "approved" over a payment that is FAILED — no wallet credit written, and nothing
       * telling the operator so. The money is the customer's and the operator believes it
       * has been credited.
       */
      await expectRefusal(
        confirm(payment.id, 'lost-race-reject-confirm'),
        'commerce.payment_state_invalid',
      );
    } finally {
      hook.mockRestore();
    }

    expect((await paymentRow(payment.id)).state).toBe('FAILED');
    expect(await ledgerRows()).toHaveLength(0);
  }, 30_000);

  it('still answers a genuine duplicate confirmation with the confirmed row', async () => {
    await setPresets([{ amountMinor: '500000', currency: 'IRT' }]);
    const { payment } = await topup(500_000n, 'dup-confirm');
    const first = await confirm(payment.id, 'dup-confirm-a');

    /*
     * The other half, and the reason it is a separate test: a state check that refused
     * EVERY loser would have broken the idempotent case this branch exists for. Two
     * approvals of the same payment must produce one credit and two successful answers.
     */
    const second = await confirm(payment.id, 'dup-confirm-b');
    expect(second.payment.state).toBe('CONFIRMED');
    expect(second.payment.id).toBe(first.payment.id);
    expect(await ledgerRows()).toHaveLength(1);
  }, 30_000);

  // -------------------------------------------------------------------------
  // A top-up is not refundable: its money is already in the wallet
  // -------------------------------------------------------------------------

  it('refuses to refund a confirmed top-up, whose credit the customer can already spend', async () => {
    await setPresets([{ amountMinor: '500000', currency: 'IRT' }]);
    const { payment } = await topup(500_000n, 'refund-topup');
    await confirm(payment.id, 'refund-topup-confirm');
    expect(await ledgerRows()).toHaveLength(1);

    /*
     * The refund channel was derived from the payment METHOD alone, so a top-up paid by
     * bank transfer resolved to EXTERNAL_MANUAL: an operator could return the money
     * through the bank while the customer kept, and could still spend, the wallet credit
     * the confirmation appended. One transfer, paid back twice.
     */
    await expectRefusal(
      ctx.container.refunds.request(tenantA, ownerA, {
        idempotencyKey: 'refund-topup-request',
        paymentId: payment.id,
        amountMinor: 100_000n,
        reason: 'اشتباه واریز',
      }),
      'commerce.refund_not_permitted',
    );
    expect(await count('refunds')).toBe(0);
    expect(await ledgerRows()).toHaveLength(1);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Three more races, each made with a held transaction
  // -------------------------------------------------------------------------

  it('refuses a top-up when the customer is blocked mid-flight', async () => {
    await setPresets([{ amountMinor: '500000', currency: 'IRT' }]);
    const walletRepository = new DrizzleWalletRepository(ctx.container.database.db);

    /*
     * `assertCustomerMayPay` used to be an ordinary read taken BEFORE the customer lock.
     * A block committing between that read and the insert left a live pending payment,
     * and a live destination, on an account that was BLOCKED. The lock now comes first,
     * so the block waits for this transaction or precedes it, and either order is
     * deterministic. Here it precedes: the holder takes the row, blocks the customer,
     * and the racer must read that state rather than the one it saw a moment earlier.
     */
    const { holder, release, locked } = hold(async (tx) => {
      await walletRepository.lockCustomer(tenantA, customerA, tx);
      await (tx as TransactionScope).tx.execute(
        sql`UPDATE customers SET status = 'BLOCKED', blocked_at = now() WHERE id = ${customerA}`,
      );
    });
    await locked;
    const racing = topup(500_000n, 'race-blocked').then(
      () => 'issued' as const,
      (error: unknown) => (isNexaError(error) ? error.code : `unexpected: ${String(error)}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await holder;

    expect(await racing).toBe('commerce.customer_blocked');
    expect(await openTopupCount()).toBe(0);
  }, 30_000);

  it('refuses a top-up when the only destination is disabled mid-flight', async () => {
    await setPresets([{ amountMinor: '500000', currency: 'IRT' }]);

    /*
     * `selectDestination` was a plain read. An operator disabling the account, or
     * replacing a card number they had just learned was blocked, could commit between
     * the select and the snapshot — and the payment still captured the stale values and
     * told the customer to pay into them. FOR SHARE makes the operator's UPDATE wait or
     * be seen; here it is seen, and there is no destination left to issue against.
     */
    const { holder, release, locked } = hold(async (tx) => {
      // The seeded account is the DEFAULT, and `payment_accounts_default_enabled_check`
      // refuses a default that is disabled — so the operator's action is both at once,
      // which is what the Payment Accounts screen does when the default is switched off.
      await (tx as TransactionScope).tx.execute(
        sql`UPDATE payment_accounts SET enabled = false, is_default = false
            WHERE tenant_id = ${tenantA.tenantId}`,
      );
    });
    await locked;
    const racing = topup(500_000n, 'race-destination').then(
      () => 'issued' as const,
      (error: unknown) => (isNexaError(error) ? error.code : `unexpected: ${String(error)}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await holder;

    // The top-up path's own name for "no destination" — the order path calls it
    // `PAYMENT_DESTINATION_UNCONFIGURED`; the refusal is the same fact.
    expect(await racing).toBe('commerce.topup_unavailable');
    expect(await openTopupCount()).toBe(0);
  }, 30_000);

  it('refuses a top-up when the route is switched off mid-flight', async () => {
    await setPresets([{ amountMinor: '500000', currency: 'IRT' }]);

    /*
     * `offer` read the routes with a plain SELECT even inside the issuing transaction.
     * An operator switching the route off and committing between that read and the
     * insert handed the customer a new live transfer reference for a route that was
     * disabled. Inside a transaction the read now takes FOR SHARE, so `setStatus` waits
     * or is seen.
     */
    const { holder, release, locked } = hold(async (tx) => {
      await (tx as TransactionScope).tx.execute(
        sql`UPDATE payment_gateways SET status = 'DISABLED'
            WHERE tenant_id = ${tenantA.tenantId} AND provider = 'MANUAL_TRANSFER'`,
      );
    });
    await locked;
    const racing = topup(500_000n, 'race-route').then(
      () => 'issued' as const,
      (error: unknown) => (isNexaError(error) ? error.code : `unexpected: ${String(error)}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await holder;

    const outcome = await racing;
    expect(
      outcome === 'commerce.payment_gateway_unavailable' ||
        outcome === 'commerce.topup_not_offered',
      outcome,
    ).toBe(true);
    expect(await openTopupCount()).toBe(0);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * A transaction held open around `work`, for making a race rather than hoping for
   * one. `locked` resolves once `work` has run; `release` lets the holder commit.
   */
  function hold(work: (tx: unknown) => Promise<void>) {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const holder = ctx.container.uow.run(tenantA, async (tx) => {
      try {
        await work(tx);
      } catch (error) {
        // A holder that cannot set the race up must fail the test, not hang it.
        holding();
        throw error;
      }
      holding();
      await held;
    });
    return { holder, release: () => release(), locked };
  }

  async function openTopupCount(): Promise<number> {
    const rows = await ctx.container.database.withClient((client) =>
      client.query(
        `SELECT count(*)::int AS n FROM payments
          WHERE state = 'PENDING' AND order_id IS NULL AND method = 'MANUAL_TRANSFER'`,
      ),
    );
    return (rows.rows[0] as { n: number }).n;
  }

  const topup = (amountMinor: bigint, key: string) =>
    ctx.container.payments.requestWalletTopup(tenantA, systemActor(key), customerA, {
      idempotencyKey: key,
      amountMinor,
    });

  const confirm = (paymentId: string, key: string) =>
    ctx.container.payments.confirmManualTransfer(tenantA, ownerA, paymentId, {
      idempotencyKey: key,
      note: 'seen in the statement',
    });

  async function customer(telegramUserId: string): Promise<UserId> {
    const { customer: record } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'زهرا' },
        botInstanceId: BOT_A,
      },
    );
    return record.id;
  }

  const setPresets = (presets: readonly { amountMinor: string; currency: string }[]) =>
    setSetting('wallet.topup.presets', presets);

  async function setSetting(key: string, value: unknown): Promise<void> {
    await ctx.container.database.db.execute(sql`
      INSERT INTO setting_values (id, tenant_id, setting_key, value, version, updated_at)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${key},
              ${JSON.stringify(value)}::jsonb, 1, now())
      ON CONFLICT (tenant_id, setting_key)
        DO UPDATE SET value = ${JSON.stringify(value)}::jsonb, version = setting_values.version + 1`);
  }

  async function count(table: string): Promise<number> {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM ${sql.raw(`"${table}"`)}` as never,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  }

  async function ledgerRows(): Promise<
    {
      reason: string;
      direction: string;
      payment_id: string | null;
      order_id: string | null;
      reference: string;
    }[]
  > {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT reason, direction, payment_id, order_id, reference FROM wallet_entries
           WHERE tenant_id = ${tenantA.tenantId} ORDER BY created_at ASC` as never,
    )) as unknown as {
      rows: {
        reason: string;
        direction: string;
        payment_id: string | null;
        order_id: string | null;
        reference: string;
      }[];
    };
    return rows.rows;
  }

  async function notifications(): Promise<{ kind: string; subject_id: string }[]> {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT kind, subject_id FROM customer_notifications
           WHERE tenant_id = ${tenantA.tenantId} ORDER BY created_at ASC` as never,
    )) as unknown as { rows: { kind: string; subject_id: string }[] };
    return rows.rows;
  }

  async function paymentRow(id: string): Promise<{ state: string }> {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT state FROM payments WHERE id = ${id}` as never,
    )) as unknown as { rows: { state: string }[] };
    const row = rows.rows[0];
    if (row === undefined) throw new Error(`no payment ${id}`);
    return row;
  }

  /** Waits until `expected` transactions are blocked on a row lock. */
  async function awaitBlocked(expected: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const rows = (await ctx.container.database.db.execute(
        sql`SELECT count(*)::int AS n FROM pg_locks
             WHERE NOT granted AND locktype IN ('tuple', 'transactionid')` as never,
      )) as unknown as { rows: { n: number }[] };
      if ((rows.rows[0]?.n ?? 0) >= expected) return;
      if (Date.now() > deadline) {
        throw new Error(
          `only ${String(rows.rows[0]?.n ?? 0)} of ${String(expected)} confirmations blocked on ` +
            'the payment row. Either the confirmation does not read it under a lock, or it ' +
            'does not run inside the transaction that credits the wallet.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  function outcomeOf<T>(
    running: Promise<T>,
  ): Promise<
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }
  > {
    return running.then(
      (value) => ({ ok: true, value }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );
  }

  async function expectRefusal(running: Promise<unknown>, code: string): Promise<void> {
    const outcome = await outcomeOf(running);
    expect(outcome.ok, `expected ${code}`).toBe(false);
    expect(outcome.ok || !isNexaError(outcome.error) ? null : outcome.error.code).toBe(code);
  }
});
