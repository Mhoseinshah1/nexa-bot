import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TONPAYS_TELEGRAM_REVIEW_WINDOW_HOURS,
  paymentNeedsAction,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PaymentGatewayProvider,
  type PaymentId,
  type PaymentSituation,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
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
 * Roadmap E1/E2 — the situation guide and the `NEEDS_ACTION` queue against a real PostgreSQL
 * (`docs/payments-under-review-ux.md`).
 *
 * Rows are written directly in the shapes the lanes write them, one per arm of the classifier,
 * so the SQL facet (`payment-ops-queue-sql.ts`) and the TypeScript classifier
 * (`paymentSituationOf`) are held to the SAME answer row by row: a payment is in NEEDS_ACTION
 * exactly when its server-derived situation needs a person, the count is the list's length,
 * and the list is oldest first.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;

const system = (id: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'test',
  surface: 'TELEGRAM',
  correlationId: id as CorrelationId,
});

type Row = Record<string, unknown>;

describe('the payment situation guide and the NEEDS_ACTION queue', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let customerA: UserId;
  let customerB: UserId;
  let seq = 0;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    seq = 0;
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-sit', roleKeys: ['owner'] }),
    );
    customerA = (
      await ctx.container.customers.resolveFromUpdate(tenantA, system('sa'), {
        idempotencyKey: 'resolve-sit-a',
        telegramUserId: '7300001',
        from: { id: 7300001, first_name: 'آرش' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
    customerB = (
      await ctx.container.customers.resolveFromUpdate(tenantB, system('sb'), {
        idempotencyKey: 'resolve-sit-b',
        telegramUserId: '7400002',
        from: { id: 7400002, first_name: 'بهار' },
        botInstanceId: BOT_B,
      })
    ).customer.id;
  });

  const exec = async (query: ReturnType<typeof sql>) => ctx.container.database.db.execute(query);

  function insertRow(table: string, row: Row) {
    const columns = Object.keys(row);
    return exec(
      sql`INSERT INTO ${sql.raw(table)} (${sql.raw(columns.join(', '))}) VALUES (${sql.join(
        columns.map((column) => sql`${row[column]}`),
        sql`, `,
      )})`,
    );
  }

  /** A payment as a lane writes it, created `ageMinutes` ago. */
  async function payment(options: {
    provider: PaymentGatewayProvider | null;
    state: 'PENDING' | 'UNKNOWN' | 'CONFIRMED' | 'FAILED' | 'EXPIRED' | 'CANCELLED';
    ageMinutes: number;
    scope?: TenantContext;
    customer?: UserId;
    extra?: Row;
  }): Promise<PaymentId> {
    seq += 1;
    const scope = options.scope ?? tenantA;
    const id = ctx.container.ids.uuid();
    const createdAt = new Date(Date.now() - options.ageMinutes * 60_000);
    const provider = options.provider;
    const method =
      provider === null ? 'WALLET' : provider === 'MANUAL_TRANSFER' ? 'MANUAL_TRANSFER' : 'GATEWAY';
    const row: Row = {
      id,
      tenant_id: scope.tenantId,
      customer_id: options.customer ?? (scope === tenantB ? customerB : customerA),
      method,
      state: options.state,
      amount: 250000,
      currency: 'IRT',
      reference: `sit-${String(seq)}-${id.slice(-6)}`,
      gateway_provider: provider,
      created_at: createdAt,
      updated_at: createdAt,
    };
    if (options.state === 'PENDING' || options.state === 'UNKNOWN') {
      row.expires_at = new Date(Date.now() + 60 * 60_000);
    }
    if (options.state === 'CONFIRMED') {
      row.confirmed_at = createdAt;
      row.evidence_kind = method === 'WALLET' ? 'WALLET_DEBIT' : 'GATEWAY_CALLBACK';
    }
    if (['FAILED', 'EXPIRED', 'CANCELLED'].includes(options.state)) row.resolved_at = createdAt;
    await insertRow('payments', { ...row, ...options.extra });
    return id as PaymentId;
  }

  async function invoice(paymentId: string, provider: PaymentGatewayProvider, extra: Row = {}) {
    seq += 1;
    const base: Row = {
      payment_id: paymentId,
      tenant_id: tenantA.tenantId,
      provider,
      provider_order_id: `${String(3_000_000_000 + seq)}`,
      creation_state: 'CREATED',
      provider_invoice_id: `sit-inv-${String(seq)}`,
      created_invoice_at: new Date(),
      provider_unit: 'IRT',
      sent_amount: 250000,
    };
    if (provider === 'TONPAYS_TELEGRAM') base.bot_instance_id = BOT_A;
    if (provider === 'NOWPAYMENTS') {
      Object.assign(base, {
        provider_unit: 'USD',
        sent_amount: 10,
        conversion_policy: 'CENTRAL_FX',
        fx_quote_id: `q-${String(seq)}`,
        fx_source: 'WALLEX',
        fx_base_asset: 'USDT',
        fx_quote_currency: 'IRT',
        fx_rate_mantissa: 103500,
        fx_rate_scale: 0,
        fx_fetched_at: new Date(),
        fx_quote_state: 'FRESH',
        fx_policy_version: 1,
        fx_unit_ratio_mantissa: 1,
        fx_unit_ratio_scale: 0,
        fx_effective_rate_numerator: 103500,
        fx_effective_rate_denominator: 1,
      });
    }
    await insertRow('gateway_invoices', { ...base, ...extra });
  }

  async function refund(paymentId: string, state: 'REQUESTED' | 'COMPLETED') {
    await insertRow('refunds', {
      id: ctx.container.ids.uuid(),
      tenant_id: tenantA.tenantId,
      payment_id: paymentId,
      customer_id: customerA,
      state,
      channel: 'WALLET_CREDIT',
      amount: 1000,
      currency: 'IRT',
      reason: 'situation test refund',
      ...(state === 'COMPLETED' ? { completed_at: new Date() } : {}),
    });
  }

  async function mismatchHold(paymentId: string) {
    await insertRow('audit_logs', {
      id: ctx.container.ids.uuid(),
      tenant_id: tenantA.tenantId,
      occurred_at: new Date(),
      actor_type: 'SYSTEM_JOB',
      action: 'payment.lose_track',
      entity_type: 'Payment',
      entity_id: paymentId,
      before: JSON.stringify({ state: 'PENDING' }),
      after: JSON.stringify({ state: 'UNKNOWN', reason: 'PROVIDER_AMOUNT_MISMATCH' }),
      correlation_id: 'sit-test',
      source_surface: 'WORKER',
      result: 'SUCCESS',
    });
  }

  const ops = () => ctx.container.paymentOperations;

  async function listedNeedsAction(): Promise<string[]> {
    const ids: string[] = [];
    let page = await ops().list(
      tenantA,
      owner,
      { limit: 3, search: { queue: 'NEEDS_ACTION' } },
      {},
    );
    ids.push(...page.items.map((item) => item.id));
    while (page.nextCursor !== null) {
      page = await ops().list(
        tenantA,
        owner,
        { limit: 3, cursor: page.nextCursor, search: { queue: 'NEEDS_ACTION' } },
        {},
      );
      ids.push(...page.items.map((item) => item.id));
    }
    return ids;
  }

  /** One row per arm of the classifier, with the situation it must read as. */
  async function everyArm(): Promise<Map<PaymentId, PaymentSituation>> {
    const expected = new Map<PaymentId, PaymentSituation>();
    let age = 200;
    const next = () => (age -= 5);

    expected.set(
      await payment({ provider: 'MANUAL_TRANSFER', state: 'PENDING', ageMinutes: next() }),
      'AWAITING_PAYMENT',
    );
    // One open manual top-up per customer (`payments_open_topup_key`): another customer's.
    const second = (
      await ctx.container.customers.resolveFromUpdate(tenantA, system('sc'), {
        idempotencyKey: 'resolve-sit-c',
        telegramUserId: '7300003',
        from: { id: 7300003, first_name: 'کاوه' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
    expected.set(
      await payment({
        provider: 'MANUAL_TRANSFER',
        state: 'PENDING',
        ageMinutes: next(),
        customer: second,
        extra: { customer_signalled_at: new Date() },
      }),
      'CUSTOMER_SIGNALLED',
    );
    // A claim WITH a filed receipt: what a reviewer acts on (review of PR #243, CX2).
    const third = (
      await ctx.container.customers.resolveFromUpdate(tenantA, system('sd'), {
        idempotencyKey: 'resolve-sit-d',
        telegramUserId: '7300004',
        from: { id: 7300004, first_name: 'نیما' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
    const receipted = await payment({
      provider: 'MANUAL_TRANSFER',
      state: 'PENDING',
      ageMinutes: next(),
      customer: third,
      extra: { customer_signalled_at: new Date() },
    });
    await insertRow('payment_receipts', {
      id: ctx.container.ids.uuid(),
      tenant_id: tenantA.tenantId,
      bot_instance_id: BOT_A,
      customer_id: third,
      payment_id: receipted,
      kind: 'PHOTO',
      file_id: `file-${receipted}`,
      file_unique_id: `uniq-${receipted}`,
    });
    expected.set(receipted, 'RECEIPT_UNDER_REVIEW');

    // A late approval recorded while the payment is still PENDING (review M1).
    const pendingLate = await payment({
      provider: 'NOWPAYMENTS',
      state: 'PENDING',
      ageMinutes: next(),
    });
    await invoice(pendingLate, 'NOWPAYMENTS', {
      provider_status: 'finished',
      outcome: 'LATE_COMPLETION',
      outcome_at: new Date(),
      late_completion_observed_at: new Date(),
    });
    expected.set(pendingLate, 'LATE_COMPLETION');

    // Refused first, approved later: the outcome stays UNSUCCESSFUL, the marker says it (CX1).
    const refusedThenPaid = await payment({
      provider: 'TONPAYS',
      state: 'FAILED',
      ageMinutes: next(),
    });
    await invoice(refusedThenPaid, 'TONPAYS', {
      provider_status: 'completed',
      provider_paid: true,
      outcome: 'UNSUCCESSFUL',
      outcome_at: new Date(),
      late_completion_observed_at: new Date(),
    });
    expected.set(refusedThenPaid, 'LATE_COMPLETION');

    // An operator's reconciliation of a gateway payment to FAILED is not a rejection (CX4)…
    const reconciled = await payment({
      provider: 'TONPAYS',
      state: 'FAILED',
      ageMinutes: next(),
      extra: { resolved_by_admin_id: owner.id },
    });
    await invoice(reconciled, 'TONPAYS', {
      provider_status: 'failed',
      outcome: 'UNSUCCESSFUL',
      outcome_at: new Date(),
    });
    expected.set(reconciled, 'FAILED');
    // …and one whose money went back to the wallet is REFUNDED, not "no money" (M2).
    const returned = await payment({
      provider: 'TONPAYS',
      state: 'FAILED',
      ageMinutes: next(),
      extra: { resolved_by_admin_id: owner.id },
    });
    await invoice(returned, 'TONPAYS', {
      provider_status: 'completed',
      provider_paid: true,
    });
    await refund(returned, 'COMPLETED');
    expected.set(returned, 'REFUNDED');

    const acknowledged = new Date(Date.now() - 60_000);
    const review = await payment({
      provider: 'TONPAYS_TELEGRAM',
      state: 'PENDING',
      ageMinutes: next(),
      // The window is exactly its contract length after the acknowledgement, which is
      // strictly before the attempt's own deadline (`payments_provider_review_check`).
      extra: {
        provider_review_started_at: acknowledged,
        provider_review_until: new Date(
          acknowledged.getTime() + TONPAYS_TELEGRAM_REVIEW_WINDOW_HOURS * 60 * 60_000,
        ),
        expires_at: new Date(acknowledged.getTime() + 10 * 60_000),
      },
    });
    await invoice(review, 'TONPAYS_TELEGRAM');
    expected.set(review, 'PROVIDER_REVIEW');

    const pendingPartial = await payment({
      provider: 'NOWPAYMENTS',
      state: 'PENDING',
      ageMinutes: next(),
    });
    await invoice(pendingPartial, 'NOWPAYMENTS', { provider_status: 'partially_paid' });
    expected.set(pendingPartial, 'PARTIAL');

    const lost = await payment({ provider: 'TONPAYS', state: 'PENDING', ageMinutes: next() });
    await invoice(lost, 'TONPAYS', {
      creation_state: 'CREATE_UNKNOWN',
      provider_invoice_id: null,
      created_invoice_at: null,
      creation_error_code: 'TIMEOUT',
    });
    expected.set(lost, 'INVOICE_NOT_ISSUED');

    const unknown = await payment({ provider: 'TONPAYS', state: 'UNKNOWN', ageMinutes: next() });
    await invoice(unknown, 'TONPAYS', { provider_status: 'pending' });
    expected.set(unknown, 'OUTCOME_UNKNOWN');

    const mismatch = await payment({
      provider: 'NOWPAYMENTS',
      state: 'UNKNOWN',
      ageMinutes: next(),
    });
    await invoice(mismatch, 'NOWPAYMENTS', { provider_status: 'finished' });
    await mismatchHold(mismatch);
    expected.set(mismatch, 'MISMATCH');

    // A late approval on an UNKNOWN: reconciliation is its exit, so it IS work.
    const lateUnknown = await payment({
      provider: 'TONPAYS_TELEGRAM',
      state: 'UNKNOWN',
      ageMinutes: next(),
    });
    await invoice(lateUnknown, 'TONPAYS_TELEGRAM', {
      provider_status: 'completed',
      provider_paid: true,
      outcome: 'LATE_COMPLETION',
      outcome_at: new Date(),
      late_completion_observed_at: new Date(),
    });
    expected.set(lateUnknown, 'LATE_COMPLETION');

    const lateFailed = await payment({ provider: 'TONPAYS', state: 'FAILED', ageMinutes: next() });
    await invoice(lateFailed, 'TONPAYS', {
      outcome: 'LATE_COMPLETION',
      outcome_at: new Date(),
      late_completion_observed_at: new Date(),
    });
    expected.set(lateFailed, 'LATE_COMPLETION');

    const lateExpired = await payment({
      provider: 'TONPAYS',
      state: 'EXPIRED',
      ageMinutes: next(),
    });
    await invoice(lateExpired, 'TONPAYS', {
      outcome: 'LATE_COMPLETION',
      outcome_at: new Date(),
      late_completion_observed_at: new Date(),
    });
    expected.set(lateExpired, 'LATE_COMPLETION');

    const failedPartial = await payment({
      provider: 'NOWPAYMENTS',
      state: 'FAILED',
      ageMinutes: next(),
    });
    await invoice(failedPartial, 'NOWPAYMENTS', { provider_status: 'partially_paid' });
    expected.set(failedPartial, 'PARTIAL');

    const failed = await payment({ provider: 'TONPAYS', state: 'FAILED', ageMinutes: next() });
    await invoice(failed, 'TONPAYS', {
      provider_status: 'failed',
      outcome: 'UNSUCCESSFUL',
      outcome_at: new Date(),
    });
    expected.set(failed, 'FAILED');

    expected.set(
      await payment({
        provider: 'MANUAL_TRANSFER',
        state: 'FAILED',
        ageMinutes: next(),
        extra: { resolved_by_admin_id: owner.id, resolution_note: 'no such transfer' },
      }),
      'REJECTED',
    );
    expected.set(
      await payment({ provider: 'MANUAL_TRANSFER', state: 'EXPIRED', ageMinutes: next() }),
      'EXPIRED',
    );
    expected.set(
      await payment({ provider: 'MANUAL_TRANSFER', state: 'CANCELLED', ageMinutes: next() }),
      'CANCELLED',
    );

    const refunding = await payment({ provider: null, state: 'CONFIRMED', ageMinutes: next() });
    await refund(refunding, 'REQUESTED');
    expected.set(refunding, 'REFUND_IN_PROGRESS');

    const refunded = await payment({ provider: null, state: 'CONFIRMED', ageMinutes: next() });
    await refund(refunded, 'COMPLETED');
    expected.set(refunded, 'REFUNDED');

    const confirmedPartial = await payment({
      provider: 'NOWPAYMENTS',
      state: 'CONFIRMED',
      ageMinutes: next(),
    });
    await invoice(confirmedPartial, 'NOWPAYMENTS', { provider_status: 'partially_paid' });
    expected.set(confirmedPartial, 'CONFIRMED');
    return expected;
  }

  it('derives each arm’s situation on the server, and NEEDS_ACTION in SQL lists exactly the ones that need a person', async () => {
    const expected = await everyArm();
    // Another tenant's UNKNOWN is never this tenant's work.
    await payment({ provider: 'TONPAYS', state: 'UNKNOWN', ageMinutes: 1, scope: tenantB });

    const records = [];
    for (const id of expected.keys()) {
      records.push(await ctx.container.payments.get(tenantA, owner, id));
    }
    const situations = await ctx.container.payments.situations(tenantA, owner, records);
    const needing: string[] = [];
    for (const [id, situation] of expected) {
      const read = situations.get(id);
      expect(read?.guide.situation, id).toBe(situation);
      // The SQL facet (the badge's source) agrees with the specification, arm by arm.
      expect(read?.queues.includes('NEEDS_ACTION'), situation).toBe(
        paymentNeedsAction(situation, (await ctx.container.payments.get(tenantA, owner, id)).state),
      );
      expect(read?.guide.needsAction).toBe(read?.queues.includes('NEEDS_ACTION'));
      if (read?.guide.needsAction === true) needing.push(id);
    }

    // The list, paged three at a time, is exactly those — oldest first.
    const listed = await listedNeedsAction();
    expect([...listed].sort()).toEqual([...needing].sort());
    expect(listed).toEqual(needing);
    // The count is the list's own predicate.
    const attention = await ops().attention(tenantA, owner, {});
    expect(attention.totals.NEEDS_ACTION).toBe(needing.length);
    // A filed receipt, every UNKNOWN (a late approval on one included) and an operator's open
    // refund — and NOT a claim with no receipt, a PENDING late approval, nor late or partial
    // money on attempts that already ended, which no command resolves.
    expect(needing.map((id) => expected.get(id as PaymentId))).toEqual([
      'RECEIPT_UNDER_REVIEW',
      'OUTCOME_UNKNOWN',
      'MISMATCH',
      'LATE_COMPLETION',
      'REFUND_IN_PROGRESS',
    ]);
  }, 120_000);

  it('moves a payment out of NEEDS_ACTION when the fact that put it there resolves', async () => {
    const id = await payment({ provider: null, state: 'CONFIRMED', ageMinutes: 10 });
    await refund(id, 'REQUESTED');
    expect(await listedNeedsAction()).toEqual([id]);
    await exec(
      sql`UPDATE refunds SET state = 'FAILED', updated_at = now() WHERE payment_id = ${id}`,
    );
    expect(await listedNeedsAction()).toEqual([]);
  });

  it('derives the whole guide for an UNKNOWN whose recorded evidence supports a resolution', async () => {
    const id = await payment({ provider: 'TONPAYS', state: 'UNKNOWN', ageMinutes: 5 });
    await invoice(id, 'TONPAYS', { provider_status: 'completed', provider_paid: true });
    const page = await ops().list(tenantA, owner, { limit: 10, search: {} }, {});
    expect(page.items.map((one) => one.id)).toEqual([id]);

    const records = [await ctx.container.payments.get(tenantA, owner, id)];
    const read = (await ctx.container.payments.situations(tenantA, owner, records)).get(id);
    expect(read?.guide).toEqual({
      situation: 'OUTCOME_UNKNOWN',
      money: 'POSSIBLY',
      customer: 'WAIT_DO_NOT_PAY_AGAIN',
      actions: ['ASK_PROVIDER_AGAIN', 'RECONCILE'],
      needsAction: true,
    });
    expect(read?.queues).toEqual(
      expect.arrayContaining(['UNKNOWN', 'NEEDS_RECONCILIATION', 'NEEDS_ACTION']),
    );
  });

  it('refuses the situations read without payments.view', async () => {
    const id = await payment({ provider: 'TONPAYS', state: 'UNKNOWN', ageMinutes: 5 });
    const records = [await ctx.container.payments.get(tenantA, owner, id)];
    const clerk = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'no-view', roleKeys: [] }),
    );
    await expect(ctx.container.payments.situations(tenantA, clerk, records)).rejects.toThrow();
  });
});
