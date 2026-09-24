import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type PaymentId,
  type ProductId,
  type UserId,
  type ProductCategoryId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { ProductDraft } from '../../apps/api/src/modules/commerce/catalog/application/ports';
import type { OrderRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import { DrizzleRefundRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-refund.repository';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Refunds: money going back, and every way it could go back twice.
 *
 * What each group defends:
 *
 *   - a refund is bounded by the CONFIRMED payment, and the bound holds under a
 *     produced race rather than a hoped-for one;
 *   - a wallet refund credits the ledger EXACTLY once, and never by editing the debit
 *     it reverses — the original history is asserted byte-for-byte afterwards;
 *   - a manual-transfer refund does NOT claim the money went back. It is born
 *     AWAITING_EXTERNAL and only an operator's completion moves it;
 *   - a replay, a double completion and a second operator all produce one outcome;
 *   - one tenant's payment is unrefundable with the other tenant's actor, and an actor
 *     without `refunds.issue` cannot refund at all.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('refunds', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let refundRepository: DrizzleRefundRepository;
  /** Constructed here rather than exposed on the container: a repository is not a surface. */
  let wallet: DrizzleWalletRepository;
  let panelA: string;
  let customerA: UserId;
  let owner: ActorContext;
  let ownerB: ActorContext;
  let support: ActorContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    products = new DrizzleProductRepository(ctx.container.database.db);
    refundRepository = new DrizzleRefundRepository(ctx.container.database.db);
    wallet = new DrizzleWalletRepository(ctx.container.database.db);
    panelA = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    /*
     * Made GENUINELY sellable, not left as a bare row.
     *
     * A panel with no credentials, no activation and no probe cannot create an
     * account, and since this hotfix `decideEligibility` refuses to take money
     * for one. A fixture that expects a sale therefore has to describe a panel
     * that could deliver it; `makePanelSellable` writes the three things a sale
     * now requires, using the production identity function so it cannot drift.
     */
    await makePanelSellable(ctx.container, tenantA, panelA);
    customerA = await customer('940100');
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-refunds', roleKeys: ['owner'] }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, {
        username: 'owner-refunds-b',
        roleKeys: ['owner'],
      }),
    );
    support = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'support-refunds',
        roleKeys: ['support'],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Authorization and tenancy
  // -------------------------------------------------------------------------

  it('refuses an actor without refunds.issue, and writes nothing', async () => {
    const payment = await walletPayment('a1');

    await expect(refund(support, payment.id, 50_000n, 'auth-a1-0001')).rejects.toMatchObject({
      code: 'platform.permission_denied',
    });

    expect(await count('refunds')).toBe(0);
    // The DENIAL is recorded, which is the other half of the rule: a refused refund is
    // an event an operator can see, not a silence.
    expect(await denials()).toContain('refund.request');
  });

  it('refuses reading a refund history without refunds.view', async () => {
    const payment = await walletPayment('a2');
    await refund(owner, payment.id, 50_000n, 'auth-a2-0001');

    await expect(
      ctx.container.refunds.ledgerFor(tenantA, support, payment.id),
    ).rejects.toMatchObject({ code: 'platform.permission_denied' });
  });

  it('will not refund another tenant’s payment, even as that tenant’s owner', async () => {
    const payment = await walletPayment('a3');

    /*
     * The id is real and the actor is a legitimate owner — of the WRONG tenant. Every
     * repository query carries `tenant_id`, so the payment is not found rather than
     * found and refused, which is the shape that also keeps its existence secret.
     */
    await expect(
      ctx.container.refunds.request(tenantB, ownerB, {
        idempotencyKey: 'auth-a3-0001',
        paymentId: payment.id,
        amountMinor: 50_000n,
        reason: 'دلیل کافی',
      }),
    ).rejects.toMatchObject({ code: 'commerce.payment_not_found' });

    await expect(
      ctx.container.refunds.ledgerFor(tenantB, ownerB, payment.id),
    ).rejects.toMatchObject({ code: 'commerce.payment_not_found' });
    expect(await count('refunds')).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The bound
  // -------------------------------------------------------------------------

  it('refuses more than the payment has left, and says how much that is', async () => {
    const payment = await walletPayment('b1');

    await expect(refund(owner, payment.id, 250_001n, 'bound-b1-0001')).rejects.toMatchObject({
      code: 'commerce.refund_exceeds_refundable',
      details: { refundableMinor: '250000', currency: 'IRT' },
    });
    expect(await count('refunds')).toBe(0);
  });

  it('refuses a payment that never settled', async () => {
    const pending = await manualPayment('b2');

    await expect(refund(owner, pending.id, 50_000n, 'bound-b2-0001')).rejects.toMatchObject({
      code: 'commerce.refund_not_permitted',
      details: { reason: 'PAYMENT_NOT_SETTLED' },
    });
  });

  it('refuses a GATEWAY payment, because this release has no channel to reverse one', async () => {
    /*
     * Written by SQL, and that is not a shortcut — it is the only way this state is
     * reachable. No gateway provider ships in this release, so nothing in the
     * application can produce a CONFIRMED GATEWAY payment; the branch under test is the
     * service's last line of defence for the day one does. `confirmed_at` and
     * `evidence_kind` are both set because `payments_confirmed_check` binds them to the
     * state, and a fixture that omitted them would be refused by the database instead.
     */
    const id = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO payments (id, tenant_id, customer_id, order_id, method, state, amount, currency,
                            reference, confirmed_at, evidence_kind, created_at, updated_at)
      VALUES (${id}, ${tenantA.tenantId}, ${customerA}, NULL, 'GATEWAY', 'CONFIRMED',
              250000, 'IRT', ${`GW-${id.slice(0, 8)}`}, now(), 'GATEWAY_CALLBACK', now(), now())`);

    await expect(refund(owner, id, 50_000n, 'bound-b3-0001')).rejects.toMatchObject({
      code: 'commerce.refund_not_permitted',
      details: { reason: 'CHANNEL_UNSUPPORTED' },
    });
    // And the READ says the same thing, so a surface does not draw a button the write
    // would refuse.
    const view = await ctx.container.refunds.ledgerFor(tenantA, owner, id as PaymentId);
    expect(view.refundable).toBe(false);
  });

  it('allows a partial refund and then exactly the remainder, and no more', async () => {
    const payment = await walletPayment('b4');

    const first = await refund(owner, payment.id, 100_000n, 'bound-b4-0001');
    expect(first.amount.amountMinor).toBe(100_000n);

    let view = await ctx.container.refunds.ledgerFor(tenantA, owner, payment.id);
    expect(view.refundableMinor).toBe(150_000n);
    expect(view.consumedMinor).toBe(100_000n);

    const second = await refund(owner, payment.id, 150_000n, 'bound-b4-0002');
    expect(second.amount.amountMinor).toBe(150_000n);

    view = await ctx.container.refunds.ledgerFor(tenantA, owner, payment.id);
    expect(view.refundableMinor).toBe(0n);
    expect(view.refunds).toHaveLength(2);

    // One minor unit past the total is refused, which is the bound holding across
    // partials rather than per request.
    await expect(refund(owner, payment.id, 1n, 'bound-b4-0003')).rejects.toMatchObject({
      code: 'commerce.refund_exceeds_refundable',
    });
    // The wallet got both, and exactly both.
    expect(await balance()).toMatchObject({ amountMinor: 1_000_000n - 250_000n + 250_000n });
  });

  it('releases the amount again when a refund is abandoned', async () => {
    const payment = await manualConfirmed('b5');

    const first = await refund(owner, payment.id, 250_000n, 'bound-b5-0001');
    await expect(refund(owner, payment.id, 1n, 'bound-b5-0002')).rejects.toMatchObject({
      code: 'commerce.refund_exceeds_refundable',
    });

    await ctx.container.refunds.fail(tenantA, owner, {
      idempotencyKey: 'bound-b5-fail',
      refundId: first.id,
      note: 'واریز انجام نشد',
    });

    /*
     * The whole amount is refundable again, and the abandoned row is STILL THERE. That
     * combination is the point: the amount comes back by the SUM over consuming states,
     * not by the evidence disappearing — which is the over-refund achieved by deleting
     * a record, and why 0073 forbids DELETE outright.
     */
    const view = await ctx.container.refunds.ledgerFor(tenantA, owner, payment.id);
    expect(view.refundableMinor).toBe(250_000n);
    expect(view.refunds).toHaveLength(1);
    expect(view.refunds[0]?.state).toBe('FAILED');

    const second = await refund(owner, payment.id, 250_000n, 'bound-b5-0003');
    expect(second.id).not.toBe(first.id);
    expect(await count('refunds')).toBe(2);
  });

  // -------------------------------------------------------------------------
  // The wallet credit, exactly once
  // -------------------------------------------------------------------------

  it('credits the wallet once and leaves the original debit untouched', async () => {
    const payment = await walletPayment('c1');
    const before = await walletRows();
    expect(before).toHaveLength(2); // the fixture credit, and the purchase debit

    const created = await refund(owner, payment.id, 250_000n, 'wallet-c1-0001');

    // The wallet channel is settled the moment it is recorded: the ledger IS the wallet.
    expect(created.state).toBe('COMPLETED');
    expect(created.channel).toBe('WALLET_CREDIT');
    expect(created.completedAt).not.toBeNull();
    expect(created.completedByAdminId).toBe(owner.id);

    const after = await walletRows();
    expect(after).toHaveLength(3);
    /*
     * Byte-for-byte, and this is the assertion that matters most on this page.
     *
     * A reversal that EDITED the debit would produce a correct-looking balance and
     * destroy the evidence of what was charged — the legacy mutable `balance` column
     * with extra steps. The two pre-existing rows must be identical, in order, after
     * the refund.
     */
    expect(after.slice(0, 2)).toEqual(before);
    expect(after[2]).toMatchObject({
      direction: 'CREDIT',
      reason: 'REFUND',
      amount: '250000',
      reference: `${created.id}:refund`,
      payment_id: payment.id,
    });

    // Charged 250,000 and given it back: the balance is where it started.
    expect(await balance()).toMatchObject({ amountMinor: 1_000_000n });
  });

  /**
   * The DERIVED reference, proved against a writer this service does not control.
   *
   * Worth stating plainly, because the obvious test does not test this: a replayed
   * `request` is answered by the idempotency store and never reaches the ledger, so that
   * case passes with a random reference too — a mutation replacing
   * `${refund.id}:refund` with a fresh uuid SURVIVED it. What the derived reference
   * actually buys is a CONSTRAINT: at most one credit can exist for a given refund,
   * whatever writes it.
   *
   * So the second credit is written here by hand, the way a future second writer or a
   * recovered job would. The ledger's `(tenant_id, reference)` conflict absorbs it. With
   * a non-derived reference this appends a SECOND credit and the customer is refunded
   * twice, which is what the assertions below catch.
   */
  it('cannot be credited twice for one refund, even by a writer outside the service', async () => {
    const payment = await walletPayment('c4');
    const created = await refund(owner, payment.id, 250_000n, 'wallet-c4-0001');

    await ctx.container.uow.run(tenantA, async (tx) => {
      await wallet.append(
        tenantA,
        {
          id: ctx.container.ids.uuid(),
          customerId: customerA,
          direction: 'CREDIT',
          reason: 'REFUND',
          amount: money(250_000n, 'IRT'),
          // The reference the service derives. Nothing else about this append is the
          // service's — a different id, a different transaction, a different caller.
          reference: `${created.id}:refund`,
          note: 'a second writer',
          now: ctx.container.clock.now(),
        },
        tx,
      );
    });

    expect(await refundLedgerCount()).toBe(1);
    expect(await balance()).toMatchObject({ amountMinor: 1_000_000n });
  });

  it('answers a replayed request with the same refund and credits once', async () => {
    const payment = await walletPayment('c2');

    const first = await refund(owner, payment.id, 250_000n, 'wallet-c2-0001');
    // The SAME key and the SAME payload: a retry, not a second command.
    const again = await refund(owner, payment.id, 250_000n, 'wallet-c2-0001');

    expect(again.id).toBe(first.id);
    expect(await count('refunds')).toBe(1);
    expect(await refundLedgerCount()).toBe(1);
    expect(await balance()).toMatchObject({ amountMinor: 1_000_000n });
  });

  it('treats a changed amount under the same key as a conflict, not a second refund', async () => {
    const payment = await walletPayment('c3');
    await refund(owner, payment.id, 100_000n, 'wallet-c3-0001');

    /*
     * The idempotency store refuses a reused key whose payload differs, rather than
     * answering with the first refund. Answering would hand back a refund for a
     * DIFFERENT amount than the caller asked for and report it as theirs.
     */
    await expect(refund(owner, payment.id, 150_000n, 'wallet-c3-0001')).rejects.toMatchObject({
      code: 'platform.idempotency_payload_mismatch',
    });
    expect(await count('refunds')).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The manual channel does not claim the money went back
  // -------------------------------------------------------------------------

  it('records a manual refund as awaiting an external transfer, moving nothing', async () => {
    const payment = await manualConfirmed('d1');
    const walletBefore = await walletRows();

    const created = await refund(owner, payment.id, 250_000n, 'manual-d1-0001');

    expect(created.state).toBe('AWAITING_EXTERNAL');
    expect(created.channel).toBe('EXTERNAL_MANUAL');
    // The three fields that would be a LIE here. Nobody has sent the money.
    expect(created.completedAt).toBeNull();
    expect(created.completedByAdminId).toBeNull();
    expect(created.externalReference).toBeNull();
    // And no ledger movement: a manual refund leaves the system through a bank, not
    // through the wallet. Crediting the wallet here would give the money back twice.
    expect(await walletRows()).toEqual(walletBefore);
  });

  it('records the completion an operator performs, once', async () => {
    const payment = await manualConfirmed('d2');
    const created = await refund(owner, payment.id, 250_000n, 'manual-d2-0001');

    const completed = await ctx.container.refunds.complete(tenantA, owner, {
      idempotencyKey: 'manual-d2-complete-1',
      refundId: created.id,
      note: 'واریز شد',
      externalReference: 'REF-99',
    });

    expect(completed.state).toBe('COMPLETED');
    expect(completed.completedByAdminId).toBe(owner.id);
    expect(completed.completedAt).not.toBeNull();
    expect(completed.externalReference).toBe('REF-99');
    // Completing a manual refund does NOT credit the wallet: the money left the bank.
    expect(await refundLedgerCount()).toBe(0);
  });

  it('answers a second completion with the refund, changing nothing', async () => {
    const payment = await manualConfirmed('d3');
    const created = await refund(owner, payment.id, 250_000n, 'manual-d3-0001');
    const first = await ctx.container.refunds.complete(tenantA, owner, {
      idempotencyKey: 'manual-d3-complete-1',
      refundId: created.id,
      note: 'واریز شد',
      externalReference: 'REF-1',
    });

    /*
     * A DIFFERENT key and a different payload — a second operator pressing the button,
     * not a retry. The refund is already in the end state the caller asked for, so it is
     * answered with the refund rather than refused, and NOTHING is overwritten: the
     * operator and the reference stay the first one's.
     */
    const again = await ctx.container.refunds.complete(tenantA, owner, {
      idempotencyKey: 'manual-d3-complete-2',
      refundId: created.id,
      note: 'دوباره',
      externalReference: 'REF-2',
    });

    expect(again.state).toBe('COMPLETED');
    expect(again.externalReference).toBe('REF-1');
    expect(again.completedAt).toEqual(first.completedAt);
    expect(again.completionNote).toBe(first.completionNote);
  });

  it('refuses to abandon a refund whose money has already gone back', async () => {
    const payment = await manualConfirmed('d4');
    const created = await refund(owner, payment.id, 250_000n, 'manual-d4-0001');
    await ctx.container.refunds.complete(tenantA, owner, {
      idempotencyKey: 'manual-d4-complete',
      refundId: created.id,
      note: 'واریز شد',
      externalReference: null,
    });

    await expect(
      ctx.container.refunds.fail(tenantA, owner, {
        idempotencyKey: 'manual-d4-fail',
        refundId: created.id,
        note: 'پشیمان شدم',
      }),
    ).rejects.toMatchObject({
      code: 'commerce.refund_state_invalid',
      details: { state: 'COMPLETED' },
    });
    // Still consumed. Abandoning it would have released an amount that has left.
    const view = await ctx.container.refunds.ledgerFor(tenantA, owner, payment.id);
    expect(view.refundableMinor).toBe(0n);
  });

  it('refuses to complete a refund that was abandoned', async () => {
    const payment = await manualConfirmed('d5');
    const created = await refund(owner, payment.id, 250_000n, 'manual-d5-0001');
    await ctx.container.refunds.fail(tenantA, owner, {
      idempotencyKey: 'manual-d5-fail',
      refundId: created.id,
      note: 'منصرف شدم',
    });

    await expect(
      ctx.container.refunds.complete(tenantA, owner, {
        idempotencyKey: 'manual-d5-complete',
        refundId: created.id,
        note: 'واریز شد',
        externalReference: null,
      }),
    ).rejects.toMatchObject({
      code: 'commerce.refund_state_invalid',
      details: { state: 'FAILED' },
    });
  });

  it('refuses a completion for a refund that does not exist', async () => {
    await expect(
      ctx.container.refunds.complete(tenantA, owner, {
        idempotencyKey: 'manual-d6-complete',
        refundId: ctx.container.ids.uuid(),
        note: 'واریز شد',
        externalReference: null,
      }),
    ).rejects.toMatchObject({ code: 'commerce.refund_not_found' });
  });

  // -------------------------------------------------------------------------
  // Concurrency, produced rather than hoped for
  // -------------------------------------------------------------------------

  /**
   * Two full refunds of one payment, interleaved on purpose.
   *
   * `Promise.allSettled` does not reliably interleave — `financial-concurrency.test.ts`
   * records that lesson — so the race is MADE. A transaction is held open having
   * already inserted a refund consuming the whole payment; the service is then called,
   * blocks on the payment row it locks before summing, and the holder commits. The
   * service's sum must then SEE the held refund.
   *
   * Without the lock both requests read a consumed total of zero, both pass
   * `refundFitsWithin`, and the payment refunds twice over.
   */
  it('will not let two requests refund the same payment twice', async () => {
    const payment = await manualConfirmed('e1');

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      holding = resolve;
    });

    const holder = ctx.container.uow.run(tenantA, async (tx) => {
      // The lock the service takes, taken here first, so the racer blocks on the same
      // row rather than on the refund it cannot yet see.
      await refundRepository.lockPayment(tenantA, payment.id, tx);
      await refundRepository.create(
        tenantA,
        {
          id: ctx.container.ids.uuid() as never,
          paymentId: payment.id,
          customerId: customerA,
          orderId: null,
          state: 'AWAITING_EXTERNAL',
          channel: 'EXTERNAL_MANUAL',
          amount: money(250_000n, 'IRT'),
          reason: 'held open',
          requestedByAdminId: owner.id,
          completedByAdminId: null,
          completedAt: null,
          now: ctx.container.clock.now(),
        },
        tx,
      );
      holding();
      await held;
    });

    await locked;
    const racing = refund(owner, payment.id, 250_000n, 'race-e1-0001').then(
      () => 'settled' as const,
      (error: unknown) => error,
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await holder;
    const outcome = await racing;

    expect(outcome, 'the second request refunded a payment already fully refunded').toMatchObject({
      code: 'commerce.refund_exceeds_refundable',
    });
    expect(await count('refunds')).toBe(1);
  }, 30_000);

  /**
   * The same race on the WALLET channel, where losing it costs a duplicate credit.
   *
   * Two partial refunds that each fit alone and cannot both fit. The loser must be
   * refused and must leave no ledger entry — a credit written by a transaction whose
   * refund was rolled back would be money created from nothing.
   */
  it('will not let two partial wallet refunds exceed the payment together', async () => {
    const payment = await walletPayment('e2');

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      holding = resolve;
    });

    const holder = ctx.container.uow.run(tenantA, async (tx) => {
      await refundRepository.lockPayment(tenantA, payment.id, tx);
      await refundRepository.create(
        tenantA,
        {
          id: ctx.container.ids.uuid() as never,
          paymentId: payment.id,
          customerId: customerA,
          orderId: payment.orderId as never,
          state: 'COMPLETED',
          channel: 'WALLET_CREDIT',
          amount: money(200_000n, 'IRT'),
          reason: 'held open',
          requestedByAdminId: owner.id,
          completedByAdminId: owner.id,
          completedAt: ctx.container.clock.now(),
          now: ctx.container.clock.now(),
        },
        tx,
      );
      holding();
      await held;
    });

    await locked;
    const racing = refund(owner, payment.id, 100_000n, 'race-e2-0001').then(
      () => 'settled' as const,
      (error: unknown) => error,
    );

    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await holder;
    const outcome = await racing;

    expect(outcome).toMatchObject({ code: 'commerce.refund_exceeds_refundable' });
    // No credit from the loser. The held refund's own credit was never written by the
    // fixture, so a REFUND entry here could only have come from the refused request.
    expect(await refundLedgerCount()).toBe(0);
  }, 30_000);

  /**
   * Two operators completing one manual refund, interleaved on purpose.
   *
   * The sequential version of this passes with either half of the mechanism missing, so
   * it proves less than it looks: the service's early return for an already-COMPLETED
   * refund hides both the `FOR UPDATE` read and the conditional UPDATE's `from`.
   *
   * Here a transaction is held open having already moved the refund to COMPLETED with
   * its own operator and reference. The service is then called and must block on the row
   * — that is what `findByIdForUpdate` is for — and once the holder commits, see the
   * state that is actually there. One completion must survive, with the FIRST operator's
   * evidence, because a second recorded completion is an operator's name against money
   * somebody else returned.
   */
  it('keeps one completion when two operators answer the same refund at once', async () => {
    const payment = await manualConfirmed('e3');
    const created = await refund(owner, payment.id, 250_000n, 'race-e3-0001');
    const second = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'owner-refunds-two',
        roleKeys: ['owner'],
      }),
    );

    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      holding = resolve;
    });

    const holder = ctx.container.uow.run(tenantA, async (tx) => {
      await refundRepository.transition(
        tenantA,
        created.id,
        {
          from: 'AWAITING_EXTERNAL',
          to: 'COMPLETED',
          completedByAdminId: owner.id,
          completedAt: ctx.container.clock.now(),
          externalReference: 'FIRST',
          completionNote: 'واریز شد',
        },
        ctx.container.clock.now(),
        tx,
      );
      holding();
      await held;
    });

    await locked;
    const racing = ctx.container.refunds
      .complete(tenantA, second, {
        idempotencyKey: 'race-e3-complete',
        refundId: created.id,
        note: 'من هم واریز کردم',
        externalReference: 'SECOND',
      })
      .then(
        (value) => ({ ok: true, value }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      );

    await new Promise((resolve) => setTimeout(resolve, 250));
    release();
    await holder;
    const outcome = await racing;

    const view = await ctx.container.refunds.ledgerFor(tenantA, owner, payment.id);
    const row = view.refunds[0];
    expect(row?.state).toBe('COMPLETED');
    // The first operator's evidence, intact. This is the assertion the mechanism exists
    // for: not that the second call fails, but that it cannot overwrite.
    expect(row?.completedByAdminId).toBe(owner.id);
    expect(row?.externalReference).toBe('FIRST');
    expect(row?.completionNote).toBe('واریز شد');
    // And whatever the second caller was told, it was not a completion of its own.
    if (outcome.ok) {
      expect(outcome.value.externalReference).toBe('FIRST');
    } else {
      expect(outcome.error).toMatchObject({ code: 'commerce.refund_state_invalid' });
    }
    expect(await refundLedgerCount()).toBe(0);
  }, 30_000);

  // -------------------------------------------------------------------------
  // The database's own guard
  // -------------------------------------------------------------------------

  it('refuses to change a refund’s amount, and refuses to delete it', async () => {
    const payment = await manualConfirmed('f1');
    const created = await refund(owner, payment.id, 100_000n, 'guard-f1-0001');

    /*
     * A hand-written UPDATE, which is exactly what the guard is for: an edit here moves
     * the payment's refundable balance, because that balance is DERIVED by summing these
     * amounts. An edit creates or destroys money.
     */
    await expect(
      rawQuery(`UPDATE refunds SET amount = 250000 WHERE id = '${created.id}'`),
    ).rejects.toThrowError(/immutable/iu);

    await expect(rawQuery(`DELETE FROM refunds WHERE id = '${created.id}'`)).rejects.toThrowError(
      /append-only/iu,
    );

    expect(await count('refunds')).toBe(1);
  });

  it('refuses to rewrite the reason a refund was issued for', async () => {
    const payment = await manualConfirmed('f3');
    const created = await refund(owner, payment.id, 100_000n, 'guard-f3-0001');

    /*
     * `reason` is why money left, recorded by the person who authorised it leaving. 0073
     * froze the amount and the identity and said in its own exception message that it
     * froze everything except state, completion and `updated_at` — but left `reason` out
     * of the comparison, so this UPDATE succeeded and the evidence could be rewritten
     * after the fact. 0076 closed it.
     */
    await expect(
      rawQuery(`UPDATE refunds SET reason = 'something else' WHERE id = '${created.id}'`),
    ).rejects.toThrowError(/immutable/iu);

    const rows = await rawQuery(`SELECT reason FROM refunds WHERE id = '${created.id}'`);
    expect((rows.rows[0] as { reason: string }).reason).toBe(created.reason);
  });

  it('still allows the completion columns the guard exists to permit', async () => {
    const payment = await manualConfirmed('f4');
    const created = await refund(owner, payment.id, 100_000n, 'guard-f4-0001');

    /*
     * The other half of the rule above, and the reason it is a separate test: a guard
     * that froze one column too many would pass every refusal test in this file and
     * break the one path an operator actually uses. Completing a manual refund is a real
     * UPDATE to state, the completion columns and `updated_at`.
     */
    const completed = await ctx.container.refunds.complete(tenantA, owner, {
      idempotencyKey: 'guard-f4-complete',
      refundId: created.id,
      note: 'واریز شد',
      externalReference: 'TRX-1',
    });
    expect(completed.state).toBe('COMPLETED');
    expect(completed.reason).toBe(created.reason);
  });

  // -------------------------------------------------------------------------
  // Identifiers that name nothing
  // -------------------------------------------------------------------------

  it('answers a malformed payment id with NOT_FOUND rather than a database error', async () => {
    /*
     * `payments.id` is a `uuid` column, and the service used to CAST this string rather
     * than parse it — so PostgreSQL compared 'not-a-uuid' against a uuid and raised
     * `invalid input syntax for type uuid`, which reached the operator as a 500
     * describing the database. The request's only fault is naming nothing.
     */
    const outcome = await ctx.container.refunds
      .request(tenantA, owner, {
        idempotencyKey: 'malformed-payment-0001',
        paymentId: 'not-a-uuid',
        amountMinor: 1_000n,
        reason: 'اشتباه',
      })
      .then(() => null)
      .catch((error: unknown) => error);

    expect(outcome).toMatchObject({ code: 'commerce.payment_not_found' });
    expect(String(outcome)).not.toMatch(/invalid input syntax/iu);
  });

  it('answers a malformed refund id with NOT_FOUND on completion and on failure', async () => {
    for (const [label, call] of [
      [
        'complete',
        () =>
          ctx.container.refunds.complete(tenantA, owner, {
            idempotencyKey: 'malformed-refund-complete',
            refundId: '../../etc/passwd',
            note: 'واریز شد',
            externalReference: null,
          }),
      ],
      [
        'fail',
        () =>
          ctx.container.refunds.fail(tenantA, owner, {
            idempotencyKey: 'malformed-refund-fail',
            refundId: '../../etc/passwd',
            note: 'لغو شد',
          }),
      ],
    ] as const) {
      const outcome = await call()
        .then(() => null)
        .catch((error: unknown) => error);
      expect(outcome, label).toMatchObject({ code: 'commerce.refund_not_found' });
      expect(String(outcome), label).not.toMatch(/invalid input syntax/iu);
    }
  });

  it('refuses a state change out of a terminal state at the database', async () => {
    const payment = await manualConfirmed('f2');
    const created = await refund(owner, payment.id, 100_000n, 'guard-f2-0001');
    await ctx.container.refunds.complete(tenantA, owner, {
      idempotencyKey: 'guard-f2-complete',
      refundId: created.id,
      note: 'واریز شد',
      externalReference: null,
    });

    // The service refuses this too, and the test above proves that. This one proves the
    // database does NOT rely on the service having done so.
    await expect(
      rawQuery(`UPDATE refunds SET state = 'FAILED' WHERE id = '${created.id}'`),
    ).rejects.toThrowError(/terminal/iu);
  });

  // -------------------------------------------------------------------------
  // WP10 P3: an operator's refund has an explicit consequence. P4: it announces itself.
  // -------------------------------------------------------------------------

  describe('an operator refund’s consequences (WP10 P3, P4)', () => {
    it('refuses a refund while the purchase operation is planned or UNKNOWN, and allows it once delivered', async () => {
      const payment = await walletPaymentUndelivered('p3a');

      await expect(refund(owner, payment.id, 50_000n, 'p3a-refund-0001')).rejects.toMatchObject({
        code: 'commerce.refund_not_permitted',
        details: { reason: 'DELIVERY_IN_PROGRESS' },
      });
      expect((await ctx.container.refunds.ledgerFor(tenantA, owner, payment.id)).refundable).toBe(
        false,
      );

      // A create whose answer was lost may have made the account: still no refund.
      await operationState(payment.orderId ?? '', 'UNKNOWN');
      await expect(refund(owner, payment.id, 50_000n, 'p3a-refund-0002')).rejects.toMatchObject({
        code: 'commerce.refund_not_permitted',
        details: { reason: 'DELIVERY_IN_PROGRESS' },
      });
      expect(await count('refunds')).toBe(0);

      await deliver(payment.orderId ?? '');
      expect((await ctx.container.refunds.ledgerFor(tenantA, owner, payment.id)).refundable).toBe(
        true,
      );
      await expect(refund(owner, payment.id, 50_000n, 'p3a-refund-0003')).resolves.toMatchObject({
        state: 'COMPLETED',
      });
    });

    it('keeps the order PAID after a partial refund and tells the customer REFUND_COMPLETED', async () => {
      const payment = await walletPayment('p3b');

      const partial = await refund(owner, payment.id, 100_000n, 'p3b-refund-0001');

      expect(await orderState(payment.orderId ?? '')).toBe('PAID');
      expect(await notifications('REFUND_COMPLETED', partial.id)).toBe(1);
      expect(await orderRefundedEvents(payment.orderId ?? '')).toBe(0);
    });

    it('moves the order REFUNDED at once when a wallet refund returns the whole payment', async () => {
      const payment = await walletPayment('p3c');

      const whole = await refund(owner, payment.id, 250_000n, 'p3c-refund-0001');

      expect(await orderState(payment.orderId ?? '')).toBe('REFUNDED');
      expect(await orderRefundedEvents(payment.orderId ?? '')).toBe(1);
      expect(await notifications('REFUND_COMPLETED', whole.id)).toBe(1);
    });

    it('moves the order REFUNDED with one OrderRefunded when the last external refund completes', async () => {
      const payment = await manualConfirmed('p3d');
      const orderId = await orderOfPayment(payment.id);
      const first = await refund(owner, payment.id, 100_000n, 'p3d-refund-0001');
      const second = await refund(owner, payment.id, 150_000n, 'p3d-refund-0002');

      // Promises, not facts: nothing is told and nothing moves while money is in flight.
      expect(await notifications('REFUND_COMPLETED', first.id)).toBe(0);
      expect(await notifications('REFUND_COMPLETED', second.id)).toBe(0);

      await complete(first.id, 'p3d-complete-0001');
      expect(await orderState(orderId)).toBe('PAID');
      expect(await orderRefundedEvents(orderId)).toBe(0);
      expect(await notifications('REFUND_COMPLETED', first.id)).toBe(1);

      await complete(second.id, 'p3d-complete-0002');
      // A replayed completion under a new key finds it already COMPLETED and does nothing.
      await complete(second.id, 'p3d-complete-0003');
      expect(await orderState(orderId)).toBe('REFUNDED');
      expect(await orderRefundedEvents(orderId)).toBe(1);
      expect(await notifications('REFUND_COMPLETED', second.id)).toBe(1);
    });

    it('emits WalletEntryRecorded for a REFUND credit, once', async () => {
      const payment = await walletPayment('p4a');
      const credited = await refund(owner, payment.id, 50_000n, 'p4a-refund-0001');
      await refund(owner, payment.id, 50_000n, 'p4a-refund-0001');

      const events = (await ctx.container.database.db.execute(
        sql`SELECT payload->>'reason' AS reason, payload->>'amountMinor' AS amount,
                   payload->>'direction' AS direction
              FROM outbox_messages
             WHERE event_type = 'WalletEntryRecorded' AND payload->>'reason' = 'REFUND'` as never,
      )) as unknown as { rows: { reason: string; amount: string; direction: string }[] };
      expect(credited.state).toBe('COMPLETED');
      expect(events.rows).toEqual([{ reason: 'REFUND', amount: '50000', direction: 'CREDIT' }]);
    });
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /*
   * A raw query on a pooled client, not through drizzle.
   *
   * `db.execute` wraps a failure in its own `Failed query:` error, which hides the
   * message the TRIGGER raised — so a test asserting on it would pass against any
   * failure at all, including a typo in the SQL. `database-invariants.test.ts` reads the
   * real message the same way for the same reason.
   */
  const rawQuery = (text: string) =>
    ctx.container.database.withClient((client) => client.query(text));

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

  const draft = (): ProductDraft => ({
    title: 'پلن پایه',
    description: 'یک ماهه',
    audience: 'EVERYONE',
    sortOrder: 10,
    panelId: panelA as PanelId,
    categoryId: SEED_IDS.categoryA as ProductCategoryId,
    specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
    price: money(250_000n, 'IRT'),
  });

  async function awaitingPayment(key: string): Promise<OrderRecord> {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: draft(),
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const order = await ctx.container.orders.createDraft(tenantA, systemActor(`${key}-d`), {
      idempotencyKey: `${key}-draft`,
      customerId: customerA,
      productId: created.id,
    });
    return ctx.container.orders.confirm(tenantA, systemActor(`${key}-c`), {
      idempotencyKey: `${key}-confirm`,
      customerId: customerA,
      orderId: order.id,
    });
  }

  /** A CONFIRMED WALLET payment of 250,000 IRT, and a wallet holding 1,000,000 before it. */
  async function walletPayment(key: string): Promise<{ id: PaymentId; orderId: string | null }> {
    const order = await awaitingPayment(key);
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    const { payment } = await ctx.container.payments.settleFromWallet(
      tenantA,
      systemActor(`${key}-settle`),
      customerA,
      { idempotencyKey: `${key}-settle-0001`, orderId: order.id },
    );
    await deliver(order.id);
    return { id: payment.id, orderId: payment.orderId };
  }

  /** A CONFIRMED wallet payment whose purchase operation has not run yet (P3). */
  async function walletPaymentUndelivered(
    key: string,
  ): Promise<{ id: PaymentId; orderId: string | null }> {
    const order = await awaitingPayment(key);
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    const { payment } = await ctx.container.payments.settleFromWallet(
      tenantA,
      systemActor(`${key}-settle`),
      customerA,
      { idempotencyKey: `${key}-settle-0001`, orderId: order.id },
    );
    return { id: payment.id, orderId: payment.orderId };
  }

  async function operationState(orderId: string, state: 'UNKNOWN'): Promise<void> {
    await ctx.container.database.db.execute(sql`
      UPDATE provisioning_operations SET state = ${state}
       WHERE tenant_id = ${tenantA.tenantId} AND order_id = ${orderId}`);
  }

  const complete = (refundId: string, key: string) =>
    ctx.container.refunds.complete(tenantA, owner, {
      idempotencyKey: key,
      refundId,
      note: 'واریز شد',
      externalReference: null,
    });

  async function scalar<T>(query: ReturnType<typeof sql>): Promise<T | undefined> {
    const result = (await ctx.container.database.db.execute(query as never)) as unknown as {
      rows: { v: T }[];
    };
    return result.rows[0]?.v;
  }

  const orderState = async (orderId: string): Promise<string | undefined> =>
    scalar<string>(sql`SELECT state AS v FROM orders WHERE id = ${orderId}`);

  const orderOfPayment = async (paymentId: string): Promise<string> =>
    (await scalar<string>(sql`SELECT order_id AS v FROM payments WHERE id = ${paymentId}`)) ?? '';

  const notifications = async (kind: string, subjectId: string): Promise<number> =>
    (await scalar<number>(
      sql`SELECT count(*)::int AS v FROM customer_notifications
           WHERE kind = ${kind} AND subject_id = ${subjectId}`,
    )) ?? 0;

  const orderRefundedEvents = async (orderId: string): Promise<number> =>
    (await scalar<number>(
      sql`SELECT count(*)::int AS v FROM outbox_messages
           WHERE event_type = 'OrderRefunded' AND aggregate_id = ${orderId}`,
    )) ?? 0;

  /**
   * The order's purchase operation, SUCCEEDED — the account exists on the panel.
   *
   * WP10 P3: an operator's refund waits while the purchase operation is undecided, so a
   * fixture that means "a paid, delivered order" has to say the delivery happened. The
   * same statement `cashback.test.ts` and `referrals.test.ts` use; the provisioner is
   * not what these cases are about.
   */
  async function deliver(orderId: string): Promise<void> {
    await ctx.container.database.db.execute(sql`
      UPDATE provisioning_operations
         SET state = 'SUCCEEDED', completed_at = now(), claimed_by = NULL, lease_until = NULL
       WHERE tenant_id = ${tenantA.tenantId} AND order_id = ${orderId}`);
  }

  /** A PENDING MANUAL_TRANSFER payment of 250,000 IRT. */
  async function manualPayment(key: string): Promise<{ id: PaymentId }> {
    const order = await awaitingPayment(key);
    const { payment } = await ctx.container.payments.requestManualTransfer(
      tenantA,
      systemActor(`${key}-manual`),
      customerA,
      { idempotencyKey: `${key}-manual-0001`, orderId: order.id },
    );
    return { id: payment.id };
  }

  /** The same, confirmed by an operator — the state a manual refund starts from. */
  async function manualConfirmed(key: string): Promise<{ id: PaymentId }> {
    const pending = await manualPayment(key);
    const { payment } = await ctx.container.payments.confirmManualTransfer(
      tenantA,
      owner,
      pending.id,
      { idempotencyKey: `${key}-confirm-0001`, note: 'کارت به کارت، ۴ رقم آخر ۱۲۳۴' },
    );
    if (payment.orderId !== null) await deliver(payment.orderId);
    return { id: payment.id };
  }

  const refund = (actor: ActorContext, paymentId: string, amountMinor: bigint, key: string) =>
    ctx.container.refunds.request(tenantA, actor, {
      idempotencyKey: key,
      paymentId,
      amountMinor,
      reason: 'مشتری منصرف شد',
    });

  const balance = () => ctx.container.wallet.balance(tenantA, owner, customerA);

  async function count(table: 'refunds' | 'payments'): Promise<number> {
    const rows = (await ctx.container.database.db.execute(
      (table === 'refunds'
        ? sql`SELECT count(*)::int AS n FROM refunds`
        : sql`SELECT count(*)::int AS n FROM payments`) as never,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  }

  /** Every wallet entry, in order, with the fields a reversal must not touch. */
  async function walletRows(): Promise<
    {
      id: string;
      direction: string;
      reason: string;
      amount: string;
      reference: string;
      payment_id: string | null;
    }[]
  > {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT id, direction, reason, amount::text AS amount, reference, payment_id
           FROM wallet_entries WHERE tenant_id = ${tenantA.tenantId}
           ORDER BY created_at ASC, id ASC` as never,
    )) as unknown as {
      rows: {
        id: string;
        direction: string;
        reason: string;
        amount: string;
        reference: string;
        payment_id: string | null;
      }[];
    };
    return rows.rows;
  }

  async function refundLedgerCount(): Promise<number> {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM wallet_entries
           WHERE tenant_id = ${tenantA.tenantId} AND reason = 'REFUND'` as never,
    )) as unknown as { rows: { n: number }[] };
    return rows.rows[0]?.n ?? 0;
  }

  async function denials(): Promise<string[]> {
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT action FROM audit_logs WHERE tenant_id = ${tenantA.tenantId}
           AND result = 'DENIED' ORDER BY occurred_at ASC` as never,
    )) as unknown as { rows: { action: string }[] };
    return rows.rows.map((row) => row.action);
  }
});
