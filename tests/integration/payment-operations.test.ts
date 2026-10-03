import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  PAYMENT_OPS_QUEUES,
  classifyListSearch,
  isNexaError,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PaymentGatewayProvider,
  type PaymentId,
  type PaymentOpsQueue,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import {
  reconcilableNow,
  reconciliationVocabularies,
} from '../../apps/api/src/modules/commerce/payments/domain/gateway-reconciliation';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzlePaymentAttentionReader } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment-attention.reader';
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
 * The Payment Operations Center against a real PostgreSQL (program §10,
 * `docs/payment-operations-center.md`).
 *
 * Rows are written directly, in the shapes the lanes write, so each queue's predicate is
 * tested on the exact record it reads — across providers, across tenants, at the window's
 * edges and through pagination. The NOWPayments file runs the same queues over the REAL
 * lane (duplicate callbacks, a partial payment, a late completion); this one proves the
 * predicates, the counts and the authority.
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

describe('the Payment Operations Center', () => {
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
      await createAdmin(ctx.container, tenantA, { username: 'owner-ops', roleKeys: ['owner'] }),
    );
    customerA = (
      await ctx.container.customers.resolveFromUpdate(tenantA, system('ra'), {
        idempotencyKey: 'resolve-ops-a',
        telegramUserId: '7100001',
        from: { id: 7100001, first_name: 'آرش' },
        botInstanceId: BOT_A,
      })
    ).customer.id;
    customerB = (
      await ctx.container.customers.resolveFromUpdate(tenantB, system('rb'), {
        idempotencyKey: 'resolve-ops-b',
        telegramUserId: '7200002',
        from: { id: 7200002, first_name: 'بهار' },
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

  /** A payment as a lane writes it. `state` defaults to PENDING. */
  async function payment(options: {
    scope?: TenantContext;
    provider?: PaymentGatewayProvider | null;
    method?: 'GATEWAY' | 'MANUAL_TRANSFER' | 'WALLET';
    state?: 'PENDING' | 'UNKNOWN' | 'CONFIRMED' | 'FAILED';
    createdAt?: Date;
    id?: string;
  }): Promise<PaymentId> {
    seq += 1;
    const scope = options.scope ?? tenantA;
    const id = options.id ?? ctx.container.ids.uuid();
    const createdAt = options.createdAt ?? new Date(Date.now() - 10 * 60_000);
    const provider = options.provider === undefined ? 'TONPAYS' : options.provider;
    const method =
      options.method ??
      (provider === null
        ? 'WALLET'
        : provider === 'MANUAL_TRANSFER'
          ? 'MANUAL_TRANSFER'
          : 'GATEWAY');
    const state = options.state ?? 'PENDING';
    const row: Row = {
      id,
      tenant_id: scope.tenantId,
      customer_id: scope === tenantB ? customerB : customerA,
      method,
      state,
      amount: 250000,
      currency: 'IRT',
      reference: `ops-${String(seq)}-${id.slice(-6)}`,
      gateway_provider: provider,
      created_at: createdAt,
      updated_at: createdAt,
    };
    if (state === 'PENDING' || state === 'UNKNOWN') {
      row.expires_at = new Date(createdAt.getTime() + 70 * 60_000);
    }
    if (state === 'CONFIRMED') {
      row.confirmed_at = createdAt;
      row.evidence_kind = method === 'WALLET' ? 'WALLET_DEBIT' : 'GATEWAY_CALLBACK';
    }
    if (state === 'FAILED') row.resolved_at = createdAt;
    await insertRow('payments', row);
    return id as PaymentId;
  }

  /** The gateway side of a payment, in the provider's own unit and shape. */
  async function invoice(paymentId: string, provider: PaymentGatewayProvider, extra: Row = {}) {
    seq += 1;
    const base: Row = {
      payment_id: paymentId,
      tenant_id: extra.tenant_id ?? tenantA.tenantId,
      provider,
      provider_order_id: `${String(1_000_000_000 + seq)}`,
      creation_state: 'CREATED',
      provider_invoice_id: `inv-${String(seq)}`,
      created_invoice_at: new Date(),
      provider_unit: 'IRT',
      sent_amount: 250000,
    };
    if (provider === 'CENTRALPAY') base.provider_user_id = String(2_000_000_000 + seq);
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

  const ops = () => ctx.container.paymentOperations;

  async function listed(
    queue: PaymentOpsQueue,
    scope: TenantContext = tenantA,
    actor: ActorContext = owner,
  ): Promise<string[]> {
    const ids: string[] = [];
    let page = await ops().list(scope, actor, { limit: 100, search: { queue } }, {});
    ids.push(...page.items.map((item) => item.id));
    while (page.nextCursor !== null) {
      page = await ops().list(
        scope,
        actor,
        { limit: 100, cursor: page.nextCursor, search: { queue } },
        {},
      );
      ids.push(...page.items.map((item) => item.id));
    }
    return ids.sort();
  }

  const refused = async (work: () => Promise<unknown>) => {
    const error = await work().then(
      () => null,
      (caught: unknown) => caught,
    );
    if (error === null) throw new Error('the call was allowed');
    return error;
  };

  // -----------------------------------------------------------------------------------

  it('NEEDS_RECONCILIATION in SQL gives exactly the answer reconcileGatewayPayment’s evidence rules give, over every provider, status, paid and reference', async () => {
    const statuses = [
      ...new Set(reconciliationVocabularies().flatMap((v) => [...v.confirmed, ...v.failed])),
      'waiting',
      'pending',
    ];
    const expected: string[] = [];
    for (const vocabulary of reconciliationVocabularies()) {
      for (const status of [...statuses, null]) {
        for (const paid of [true, false, null]) {
          for (const charge of [false, true]) {
            const id = await payment({ provider: vocabulary.provider, state: 'UNKNOWN' });
            await invoice(id, vocabulary.provider, {
              provider_status: status,
              provider_paid: paid,
              provider_charge_id: charge ? `ch-${id}` : null,
            });
            if (
              reconcilableNow(vocabulary.provider, {
                status,
                paid,
                providerChargeId: charge ? `ch-${id}` : null,
              })
            ) {
              expected.push(id);
            }
          }
        }
      }
    }
    // A PENDING payment holding approving evidence is not in it: only UNKNOWN is reconciled.
    const pending = await payment({ provider: 'TONPAYS', state: 'PENDING' });
    await invoice(pending, 'TONPAYS', { provider_status: 'completed', provider_paid: true });

    expect(expected.length).toBeGreaterThan(10);
    expect(await listed('NEEDS_RECONCILIATION')).toEqual(expected.sort());
    const attention = await ops().attention(tenantA, owner, {});
    expect(attention.totals.NEEDS_RECONCILIATION).toBe(expected.length);
  }, 120_000);

  it('counts every route separately — pending, unknown, a wallet settlement — and omits the empty ones', async () => {
    const tonPending = await payment({ provider: 'TONPAYS' });
    await invoice(tonPending, 'TONPAYS');
    const centralUnknown = await payment({ provider: 'CENTRALPAY', state: 'UNKNOWN' });
    await invoice(centralUnknown, 'CENTRALPAY', { provider_status: 'unverified' });
    await payment({ provider: 'MANUAL_TRANSFER' });
    await payment({ provider: null, state: 'CONFIRMED' });
    const tgFailed = await payment({ provider: 'TONPAYS_TELEGRAM', state: 'FAILED' });
    await invoice(tgFailed, 'TONPAYS_TELEGRAM');

    const view = await ops().attention(tenantA, owner, {});
    const byRoute = new Map(view.byGateway.map((row) => [row.gatewayProvider, row.counts]));
    expect(byRoute.get('TONPAYS')).toMatchObject({ PENDING: 1, UNKNOWN: 0 });
    expect(byRoute.get('CENTRALPAY')).toMatchObject({
      PENDING: 0,
      UNKNOWN: 1,
      NEEDS_RECONCILIATION: 1,
    });
    expect(byRoute.get('MANUAL_TRANSFER')).toMatchObject({ PENDING: 1 });
    // A settled wallet payment and a failed attempt need nobody: no row for either route.
    expect(byRoute.has(null)).toBe(false);
    expect(byRoute.has('TONPAYS_TELEGRAM')).toBe(false);
    expect(view.totals).toMatchObject({ PENDING: 2, UNKNOWN: 1, NEEDS_RECONCILIATION: 1 });
    // Every count is the list's own predicate.
    for (const queue of PAYMENT_OPS_QUEUES) {
      expect((await listed(queue)).length, queue).toBe(view.totals[queue]);
    }
  });

  it('files provider errors, late completions, partials and refunds by what the record says', async () => {
    const createFailed = await payment({ provider: 'TONPAYS', state: 'FAILED' });
    await invoice(createFailed, 'TONPAYS', {
      creation_state: 'CREATE_FAILED',
      provider_invoice_id: null,
      created_invoice_at: null,
      creation_error_code: 'INVALID_API_KEY',
    });
    const createUnknown = await payment({ provider: 'TONPAYS' });
    await invoice(createUnknown, 'TONPAYS', {
      creation_state: 'CREATE_UNKNOWN',
      provider_invoice_id: null,
      created_invoice_at: null,
      creation_error_code: 'TIMEOUT',
    });
    const inquiryError = await payment({ provider: 'CENTRALPAY' });
    await invoice(inquiryError, 'CENTRALPAY', { last_inquiry_error_code: 'HTTP_503' });
    // A CREATED row's machine NOTE is not a provider error.
    const noted = await payment({ provider: 'TONPAYS' });
    await invoice(noted, 'TONPAYS', { creation_error_code: 'nexa.no_payment_link' });
    const late = await payment({ provider: 'TONPAYS', state: 'FAILED' });
    await invoice(late, 'TONPAYS', {
      outcome: 'LATE_COMPLETION',
      outcome_at: new Date(),
      late_completion_observed_at: new Date(),
    });
    const partial = await payment({ provider: 'NOWPAYMENTS', state: 'UNKNOWN' });
    await invoice(partial, 'NOWPAYMENTS', {
      provider_status: 'partially_paid',
      provider_paid: false,
    });
    // TonPays has no partial status; one spelled like NOWPayments' is not a partial there.
    const notPartial = await payment({ provider: 'TONPAYS', state: 'UNKNOWN' });
    await invoice(notPartial, 'TONPAYS', { provider_status: 'partially_paid' });
    const refunded = await payment({ provider: null, state: 'CONFIRMED' });
    await insertRow('refunds', {
      id: ctx.container.ids.uuid(),
      tenant_id: tenantA.tenantId,
      payment_id: refunded,
      customer_id: customerA,
      state: 'REQUESTED',
      channel: 'WALLET_CREDIT',
      amount: 1000,
      currency: 'IRT',
      reason: 'ops test refund',
    });

    expect(await listed('PROVIDER_ERROR')).toEqual(
      [createFailed, createUnknown, inquiryError].sort(),
    );
    expect(await listed('LATE_COMPLETION')).toEqual([late]);
    expect(await listed('PARTIAL')).toEqual([partial]);
    expect(await listed('REFUND_RELATED')).toEqual([refunded]);
    // None of these was a mismatch HOLD — only the lane's audited hold is.
    expect(await listed('MISMATCH')).toEqual([]);
  });

  it('reads MISMATCH from the lane’s audited hold, and not from a lapsed review’s', async () => {
    const held = await payment({ provider: 'NOWPAYMENTS', state: 'UNKNOWN' });
    const lapsed = await payment({ provider: 'TONPAYS_TELEGRAM', state: 'UNKNOWN' });
    const audit = (paymentId: string, after: Row) =>
      insertRow('audit_logs', {
        id: ctx.container.ids.uuid(),
        tenant_id: tenantA.tenantId,
        occurred_at: new Date(),
        actor_type: 'SYSTEM_JOB',
        action: 'payment.lose_track',
        entity_type: 'Payment',
        entity_id: paymentId,
        before: JSON.stringify({ state: 'PENDING' }),
        after: JSON.stringify(after),
        correlation_id: 'ops-test',
        source_surface: 'WORKER',
        result: 'SUCCESS',
      });
    await audit(held, { state: 'UNKNOWN', reason: 'PROVIDER_USER_MISMATCH' });
    await audit(lapsed, { state: 'UNKNOWN', providerReviewUntil: null });
    // The same audit in ANOTHER tenant, naming tenant A's payment, is not tenant A's fact.
    await insertRow('audit_logs', {
      id: ctx.container.ids.uuid(),
      tenant_id: tenantB.tenantId,
      occurred_at: new Date(),
      actor_type: 'SYSTEM_JOB',
      action: 'payment.lose_track',
      entity_type: 'Payment',
      entity_id: lapsed,
      after: JSON.stringify({ reason: 'PROVIDER_AMOUNT_MISMATCH' }),
      correlation_id: 'ops-test',
      source_surface: 'WORKER',
      result: 'SUCCESS',
    });

    expect(await listed('MISMATCH')).toEqual([held]);
    const timeline = await ctx.container.paymentTimeline.timeline(tenantA, owner, held);
    expect(timeline.entries.find((e) => e.kind === 'PAYMENT_OUTCOME_UNKNOWN')).toMatchObject({
      reason: 'PROVIDER_USER_MISMATCH',
    });
    const quiet = await ctx.container.paymentTimeline.timeline(tenantA, owner, lapsed);
    expect(quiet.entries.find((e) => e.kind === 'PAYMENT_OUTCOME_UNKNOWN')).toMatchObject({
      reason: null,
    });
  });

  it('never lists, counts or finds another tenant’s payments', async () => {
    const mine = await payment({ provider: 'CENTRALPAY', state: 'UNKNOWN' });
    await invoice(mine, 'CENTRALPAY', {
      provider_status: 'unverified',
      provider_order_id: '5550000001',
    });
    const theirs = await payment({ scope: tenantB, provider: 'CENTRALPAY', state: 'UNKNOWN' });
    await invoice(theirs, 'CENTRALPAY', {
      tenant_id: tenantB.tenantId,
      provider_status: 'unverified',
      provider_order_id: '5550000002',
      provider_charge_id: 'shared-ref-1',
    });

    expect(await listed('UNKNOWN')).toEqual([mine]);
    expect((await ops().attention(tenantA, owner, {})).totals.UNKNOWN).toBe(1);
    const ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-ops-b', roleKeys: ['owner'] }),
    );
    expect(await listed('UNKNOWN', tenantB, ownerB)).toEqual([theirs]);

    // Tenant B's provider ids find nothing in tenant A.
    for (const q of ['5550000002', 'shared-ref-1']) {
      const text = classifyListSearch(q);
      if (text === null) throw new Error('no search');
      const page = await ops().list(tenantA, owner, { search: { text } }, {});
      expect(page.items, q).toEqual([]);
    }
    const text = classifyListSearch('5550000001');
    if (text === null) throw new Error('no search');
    expect(
      (await ops().list(tenantA, owner, { search: { text } }, {})).items.map((i) => i.id),
    ).toEqual([mine]);
  });

  it('pages a queue deterministically by (created_at, id): every row once, in the same order every time', async () => {
    const at = new Date(Date.now() - 30 * 60_000);
    const ids: string[] = [];
    for (let i = 0; i < 23; i += 1) ids.push(await payment({ provider: 'TONPAYS', createdAt: at }));
    // Interleave rows OUTSIDE the queue at the same instant: they must not shift the pages.
    for (let i = 0; i < 5; i += 1)
      await payment({ provider: 'TONPAYS', state: 'FAILED', createdAt: at });

    const walk = async () => {
      const seen: string[] = [];
      let page = await ops().list(tenantA, owner, { limit: 7, search: { queue: 'PENDING' } }, {});
      seen.push(...page.items.map((item) => item.id));
      while (page.nextCursor !== null) {
        page = await ops().list(
          tenantA,
          owner,
          { limit: 7, cursor: page.nextCursor, search: { queue: 'PENDING' } },
          {},
        );
        seen.push(...page.items.map((item) => item.id));
      }
      return seen;
    };
    const first = await walk();
    expect(first).toEqual([...ids].sort());
    expect(new Set(first).size).toBe(23);
    expect(await walk()).toEqual(first);
  });

  it('bounds the list and the counts by a half-open created-at window', async () => {
    const start = new Date('2026-09-01T00:00:00Z');
    const end = new Date('2026-09-02T00:00:00Z');
    const atStart = await payment({ provider: 'TONPAYS', createdAt: start });
    const inside = await payment({ provider: 'TONPAYS', createdAt: new Date(end.getTime() - 1) });
    await payment({ provider: 'TONPAYS', createdAt: end });
    await payment({ provider: 'TONPAYS', createdAt: new Date(start.getTime() - 1) });

    const repository = new DrizzlePaymentRepository(ctx.container.database.db);
    const page = await repository.list(
      tenantA,
      { queue: 'PENDING', createdIn: { start, end } },
      100,
      null,
    );
    expect(page.items.map((item) => item.id).sort()).toEqual([atStart, inside].sort());
    const reader = new DrizzlePaymentAttentionReader(ctx.container.database.db);
    const rows = await reader.counts(tenantA, { start, end });
    expect(rows.find((row) => row.gatewayProvider === 'TONPAYS')?.counts.PENDING).toBe(2);
    expect((await reader.counts(tenantA, null))[0]?.counts.PENDING).toBe(4);
  });

  it('resolves a named range in the tenant calendar through the reports’ resolver', async () => {
    await payment({ provider: 'TONPAYS', createdAt: new Date(Date.now() - 60_000) });
    await payment({ provider: 'TONPAYS', createdAt: new Date(Date.now() - 400 * 86_400_000) });
    const view = await ops().attention(tenantA, owner, { range: 'LAST_30_DAYS' });
    expect(view.window).not.toBeNull();
    expect(view.totals.PENDING).toBe(1);
    const page = await ops().list(tenantA, owner, { search: {} }, { range: 'LAST_30_DAYS' });
    expect(page.items).toHaveLength(1);
  });

  it('refuses the list and the counts without payments.view, and ask-again without payments.reconcile — audited', async () => {
    const support = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'support-ops', roleKeys: ['support'] }),
    );
    for (const work of [
      () => ops().list(tenantA, support, { search: { queue: 'UNKNOWN' } }, {}),
      () => ops().attention(tenantA, support, {}),
    ]) {
      const error = await refused(work);
      expect(isNexaError(error) && error.kind).toBe('PERMISSION_DENIED');
    }

    const unknown = await payment({ provider: 'TONPAYS', state: 'UNKNOWN' });
    await invoice(unknown, 'TONPAYS', { provider_status: 'completed', provider_paid: true });
    const observer = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'observer-ops',
        roleKeys: ['observer'],
      }),
    );
    // The observer reads the queue…
    expect(await listed('NEEDS_RECONCILIATION', tenantA, observer)).toEqual([unknown]);
    // …and may neither ask again nor reconcile.
    for (const work of [
      () =>
        ctx.container.payments.reinquireGatewayPayment(tenantA, observer, unknown, {
          idempotencyKey: 'observer-ask-1',
        }),
      () =>
        ctx.container.payments.reconcileGatewayPayment(tenantA, observer, unknown, {
          to: 'CONFIRMED',
          note: null,
          idempotencyKey: 'observer-reconcile-1',
        }),
    ]) {
      const error = await refused(work);
      expect(isNexaError(error) && error.kind).toBe('PERMISSION_DENIED');
    }
    const denials = (
      await exec(
        sql`SELECT action FROM audit_logs WHERE entity_id = ${unknown} AND result = 'DENIED' ORDER BY action`,
      )
    ).rows as { action: string }[];
    expect(denials.map((row) => row.action)).toEqual([
      'gateway_invoice.reconcile_inquiry_requested',
      'payment.reconcile_confirmed',
    ]);
    expect((await exec(sql`SELECT state FROM payments WHERE id = ${unknown}`)).rows).toEqual([
      { state: 'UNKNOWN' },
    ]);
  });

  it('shows the settling order’s settlement, delivery and refund only under orders.view, and the audit rows only under audit.view', async () => {
    const observer = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'observer-tl',
        roleKeys: ['observer'],
      }),
    );
    const paid = await payment({ provider: 'TONPAYS', state: 'CONFIRMED' });
    await invoice(paid, 'TONPAYS', {
      provider_status: 'completed',
      provider_paid: true,
      last_inquiry_at: new Date(),
      outcome: 'SETTLED',
      outcome_at: new Date(),
      webhook_count: 2,
      last_webhook_at: new Date(),
      webhook_status_hint: 'completed',
    });
    const owners = await ctx.container.paymentTimeline.timeline(tenantA, owner, paid);
    expect(owners.withheld).toEqual([]);
    expect(owners.entries.map((e) => e.kind)).toEqual(
      expect.arrayContaining([
        'GATEWAY_INVOICE_REQUESTED',
        'GATEWAY_INVOICE_CREATED',
        'GATEWAY_WEBHOOK_HINT',
        'GATEWAY_INQUIRY',
        'PAYMENT_CONFIRMED',
        'GATEWAY_OUTCOME',
      ]),
    );
    // The observer holds orders.view and audit.view (both LOW): nothing withheld either.
    const observers = await ctx.container.paymentTimeline.timeline(tenantA, observer, paid);
    expect(observers.withheld).not.toContain('ORDER');
    const support = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'rr-tl',
        roleKeys: ['receipt_reviewer'],
      }),
    );
    const reviewers = await ctx.container.paymentTimeline.timeline(tenantA, support, paid);
    expect(reviewers.withheld).toEqual(expect.arrayContaining(['ORDER', 'AUDIT']));
    expect(reviewers.entries.map((e) => e.kind)).not.toContain('AUDIT_RECORDED');
  });
});
