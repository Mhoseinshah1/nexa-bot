import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SUPPORT_CONTEXT_MAX_BYTES,
  TONPAYS_TELEGRAM_REVIEW_WINDOW_HOURS,
  supportContextPayloadSchema,
  type ActorContext,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { DrizzleSupportContextReader } from '../../apps/api/src/modules/commerce/support-context/infrastructure/drizzle-support-context.reader';
import { AudienceFixtures } from './audience-fixtures';
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
 * TB3 — the support context (`docs/support-agent/tb3-support-context.md`), against a real
 * PostgreSQL: every account fact is the conversation customer's own, of this tenant; a
 * service refunded away is gone; a payment that is ambiguous or waiting on a human is
 * «under review»; nothing the allowlist leaves out reaches the payload.
 */

const SUB_URL = 'https://sub.secret.example/s/TOKEN-tb3-abcdef';
const NOTE = 'customer-note-tb3-secret';
const PAY_REF = 'NX-TB3-REF-SECRET';
const EXT_REF = 'ext-ref-tb3-secret';
const INCIDENT_TITLE = 'incident-title-tb3-secret';
const INCIDENT_DESCRIPTION = 'incident-description-tb3-secret';
const PHONE = '+989120000777';

describe('TB3 — support context', () => {
  let ctx: TestContext;
  let fx: AudienceFixtures;
  let fxB: AudienceFixtures;
  let owner: ActorContext;
  let n = 0;
  const seq = () => (n += 1);

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    fx = new AudienceFixtures(ctx, SEED_IDS.tenantA);
    fxB = new AudienceFixtures(ctx, SEED_IDS.tenantB);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-tb3', roleKeys: ['owner'] }),
    );
  });

  async function run(statement: ReturnType<typeof sql>): Promise<void> {
    await ctx.container.database.db.execute(statement);
  }

  async function rows<T>(statement: ReturnType<typeof sql>): Promise<T[]> {
    return (await ctx.container.database.db.execute(statement)).rows as T[];
  }

  /** A delivered service with a live link, synced usage, a provider id and a note. */
  async function liveService(
    customerId: string,
    panelId: string,
    options: {
      readonly tenant?: 'A' | 'B';
      readonly state?: 'ACTIVE' | 'SUSPENDED' | 'EXPIRED' | 'TERMINATED';
      readonly synced?: boolean;
      readonly productId?: string;
    } = {},
  ): Promise<string> {
    const fixtures = options.tenant === 'B' ? fxB : fx;
    const id = await fixtures.service({
      customerId,
      panelId,
      state: options.state ?? 'ACTIVE',
      trafficLimitBytes: 1000n,
      ...(options.productId === undefined ? {} : { productId: options.productId }),
    });
    await run(sql`UPDATE services
                     SET subscription_url = ${SUB_URL},
                         customer_note = ${NOTE},
                         traffic_used_bytes = ${options.synced === false ? 0 : 400},
                         usage_synced_at = ${options.synced === false ? null : new Date()}
                   WHERE id = ${id}`);
    return id;
  }

  async function payment(
    customerId: string,
    options: {
      readonly tenant?: TenantContext;
      readonly state: 'PENDING' | 'CONFIRMED' | 'UNKNOWN' | 'FAILED';
      readonly method?: 'MANUAL_TRANSFER' | 'GATEWAY' | 'WALLET';
      readonly signalled?: boolean;
      readonly minutesAgo?: number;
      readonly orderId?: string | null;
      readonly provider?: 'TONPAYS' | 'NOWPAYMENTS';
      /** An open provider review (`provider_review_started_at`/`_until`), NOWPayments only. */
      readonly providerReview?: boolean;
    },
  ): Promise<string> {
    const id = ctx.container.ids.uuid();
    const method = options.method ?? 'MANUAL_TRANSFER';
    const review = options.providerReview === true;
    const confirmed = options.state === 'CONFIRMED';
    await run(sql`
      INSERT INTO payments (id, tenant_id, customer_id, order_id, state, method, amount, currency,
                            reference, external_reference, evidence_kind, confirmed_at,
                            resolved_at, customer_signalled_at, gateway_provider,
                            provider_review_started_at, provider_review_until, expires_at,
                            created_at)
      VALUES (${id}, ${(options.tenant ?? tenantA).tenantId}, ${customerId},
              ${options.orderId ?? null}, ${options.state}, ${method}, 250000, 'IRT',
              ${`${PAY_REF}-${String(seq())}`}, ${EXT_REF},
              ${confirmed ? 'OPERATOR_REVIEW' : null}, ${confirmed ? sql`now()` : sql`NULL`},
              ${options.state === 'FAILED' ? sql`now()` : sql`NULL`},
              ${options.signalled === true ? sql`now()` : sql`NULL`},
              ${method === 'GATEWAY' ? (options.provider ?? 'TONPAYS') : null},
              ${review ? sql`now()` : sql`NULL`},
              ${review ? sql`now() + make_interval(hours => ${TONPAYS_TELEGRAM_REVIEW_WINDOW_HOURS})` : sql`NULL`},
              ${review ? sql`now() + interval '70 minutes'` : sql`NULL`},
              now() - make_interval(mins => ${options.minutesAgo ?? 1}))`);
    return id;
  }

  /** The gateway side of a payment (`payment-operations.test.ts`'s shape for each provider). */
  async function invoice(
    paymentId: string,
    provider: 'TONPAYS' | 'NOWPAYMENTS',
    extra: Record<string, unknown>,
  ): Promise<void> {
    const k = seq();
    const row: Record<string, unknown> = {
      payment_id: paymentId,
      tenant_id: tenantA.tenantId,
      provider,
      provider_order_id: String(1_000_000_000 + k),
      creation_state: 'CREATED',
      provider_invoice_id: `inv-tb3-${String(k)}`,
      created_invoice_at: new Date(),
      provider_unit: 'IRT',
      sent_amount: 250000,
      ...(provider === 'NOWPAYMENTS'
        ? {
            provider_unit: 'USD',
            sent_amount: 10,
            conversion_policy: 'CENTRAL_FX',
            fx_quote_id: `q-tb3-${String(k)}`,
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
          }
        : {}),
      ...extra,
    };
    const columns = Object.keys(row);
    await run(
      sql`INSERT INTO gateway_invoices (${sql.raw(columns.join(', '))}) VALUES (${sql.join(
        columns.map((column) => sql`${row[column]}`),
        sql`, `,
      )})`,
    );
  }

  async function refundRow(paymentId: string, customerId: string): Promise<void> {
    await run(sql`
      INSERT INTO refunds (id, tenant_id, payment_id, customer_id, state, channel, amount,
                           currency, reason)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${paymentId}, ${customerId},
              'REQUESTED', 'WALLET_CREDIT', 1000, 'IRT', 'tb3 test refund')`);
  }

  async function writeCount(): Promise<number> {
    const [row] = await rows<{ n: number }>(
      sql`SELECT (SELECT count(*) FROM support_faq_seeds)::int + (SELECT count(*) FROM audit_logs)::int
                 + (SELECT count(*) FROM outbox_messages)::int AS n`,
    );
    return row?.n ?? -1;
  }

  async function incident(input: {
    readonly message: string | null;
    readonly status?: 'ACTIVE' | 'SCHEDULED' | 'RESOLVED';
    readonly targets?: readonly { readonly kind: string; readonly ref: string }[];
    readonly tenant?: TenantContext;
  }): Promise<string> {
    const id = ctx.container.ids.uuid();
    const status = input.status ?? 'ACTIVE';
    const tenantId = (input.tenant ?? tenantA).tenantId;
    await run(sql`
      INSERT INTO incidents (id, tenant_id, kind, severity, status, title, description,
                             customer_message, scheduled_start_at, started_at, resolved_at,
                             created_at, updated_at)
      VALUES (${id}, ${tenantId}, 'INCIDENT', 'MAJOR', ${status}, ${INCIDENT_TITLE},
              ${INCIDENT_DESCRIPTION}, ${input.message},
              ${status === 'SCHEDULED' ? sql`now() + interval '1 day'` : sql`NULL`},
              ${status === 'SCHEDULED' ? sql`NULL` : sql`now() - make_interval(mins => ${seq()})`},
              ${status === 'RESOLVED' ? sql`now()` : sql`NULL`}, now(), now())`);
    for (const target of input.targets ?? []) {
      await run(sql`INSERT INTO incident_targets (tenant_id, incident_id, kind, ref)
                    VALUES (${tenantId}, ${id}, ${target.kind}, ${target.ref})`);
    }
    return id;
  }

  /**
   * A service the customer had refunded away (WP19): a COMPLETED refund request, with the
   * refund, the operation and the deciding administrator it must name.
   */
  async function refundAway(serviceId: string): Promise<void> {
    const [service] = await rows<{ customer_id: string; order_id: string; panel_id: string }>(
      sql`SELECT customer_id, order_id, panel_id FROM services WHERE id = ${serviceId}`,
    );
    if (service === undefined) throw new Error('no service');
    const paymentId = await payment(service.customer_id, {
      state: 'CONFIRMED',
      orderId: service.order_id,
      minutesAgo: 5000,
    });
    const refundId = ctx.container.ids.uuid();
    const adminId = owner.id;
    await run(sql`
      INSERT INTO refunds (id, tenant_id, payment_id, customer_id, order_id, state, channel,
                           amount, currency, reason, requested_by_admin_id, completed_by_admin_id,
                           completed_at)
      VALUES (${refundId}, ${tenantA.tenantId}, ${paymentId}, ${service.customer_id}, NULL,
              'COMPLETED', 'WALLET_CREDIT', 1000, 'IRT', 'UNDELIVERABLE', NULL, NULL, now())`);
    const operationId = ctx.container.ids.uuid();
    await run(sql`
      INSERT INTO provisioning_operations (id, tenant_id, operation_id, service_id, panel_id,
                                           type, state, attempts, failure_kind, completed_at)
      VALUES (${operationId}, ${tenantA.tenantId}, ${seq().toString(16).padStart(16, '0')},
              ${serviceId}, ${service.panel_id}, 'SUSPEND', 'FAILED', 1, 'TIMEOUT', now())`);
    await run(sql`
      INSERT INTO service_refund_requests
        (id, tenant_id, service_id, customer_id, order_id, payment_id, state, origin,
         filing_key, principal_minor, currency, approved_amount_minor, refund_id, operation_id,
         decided_by_admin_id, decided_at, resolved_at)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${serviceId},
              ${service.customer_id}, ${service.order_id}, ${paymentId}, 'COMPLETED', 'OPERATOR',
              ${`tb3-filing-${String(seq())}`}, 1000, 'IRT', 1000, ${refundId}, ${operationId},
              ${adminId}, now(), now())`);
  }

  async function customer(
    telegramUserId: string,
    options: { readonly tenant?: 'A' | 'B'; readonly status?: 'ACTIVE' | 'BLOCKED' } = {},
  ): Promise<UserId> {
    const fixtures = options.tenant === 'B' ? fxB : fx;
    const id = await fixtures.customer({
      telegramUserId,
      botInstanceId: options.tenant === 'B' ? SEED_IDS.botB1 : SEED_IDS.botA1,
      firstName: 'Sara',
      username: `sara${telegramUserId.slice(-2)}`,
      ...(options.status === undefined ? {} : { status: options.status }),
    });
    await run(sql`UPDATE customers SET phone_number = ${PHONE}, phone_verified_at = now()
                   WHERE id = ${id}`);
    return id as UserId;
  }

  it('gives the exact customer their own services, orders and payments — never another customer’s or tenant’s', async () => {
    const panel = await fx.panel('secret-panel-name');
    const [panelName] = await rows<{ name: string }>(
      sql`SELECT name FROM panels WHERE id = ${panel}`,
    );
    const me = await customer('900001');
    const other = await customer('900002');
    const mine = await liveService(me, panel);
    const theirs = await liveService(other, panel);
    await payment(me, { state: 'CONFIRMED', minutesAgo: 10 });
    await payment(other, { state: 'UNKNOWN', method: 'GATEWAY' });
    // Tenant B: a customer with the SAME Telegram id, and their rows.
    const panelB = await fxB.panel('b-panel');
    const meInB = await customer('900001', { tenant: 'B' });
    await liveService(meInB, panelB, { tenant: 'B' });
    await payment(meInB, { tenant: tenantB, state: 'UNKNOWN', method: 'GATEWAY' });

    const built = await ctx.container.supportContext.build(tenantA, me);
    const { payload } = built;
    expect(supportContextPayloadSchema.parse(payload)).toEqual(payload);
    expect(payload.flags.identityLinked).toBe(true);
    expect(payload.customer?.username).toBe('sara01');
    expect(payload.services).toHaveLength(1);
    expect(built.references.services.get('S1')).toBe(mine);
    expect([...built.references.services.values()]).not.toContain(theirs);
    // Their order (one per service) and mine: only mine. Their UNKNOWN payment: not mine.
    expect(payload.orders).toHaveLength(1);
    expect(payload.payments).toHaveLength(1);
    expect(payload.payments[0]?.state).toBe('CONFIRMED');
    expect(payload.flags.hasUnderReviewPayment).toBe(false);

    const service = payload.services[0];
    expect(service).toMatchObject({
      alias: 'S1',
      state: 'ACTIVE',
      displayStatus: 'ACTIVE',
      productTitle: 'plan',
      trafficLimitBytes: '1000',
      trafficUsedBytes: '400',
      remainingTrafficBytes: '600',
      hasSubscriptionLink: true,
      unreconciled: false,
    });

    const [providerIds] = await rows<{ provider_client_id: string; subscription_ref: string }>(
      sql`SELECT provider_client_id, subscription_ref FROM services WHERE id = ${mine}`,
    );
    const json = JSON.stringify(payload);
    for (const secret of [
      SUB_URL,
      'sub.secret.example',
      providerIds?.subscription_ref ?? 'missing',
      providerIds?.provider_client_id ?? 'missing',
      NOTE,
      PAY_REF,
      EXT_REF,
      PHONE,
      '900001',
      panel,
      panelName?.name ?? 'missing',
      'secret-panel-name',
      mine,
      me,
      SEED_IDS.tenantA,
    ]) {
      expect(json, secret).not.toContain(secret);
    }
  });

  it('a customer id from another tenant resolves to nobody: public support only', async () => {
    const panelB = await fxB.panel('b-panel');
    const meInB = await customer('900010', { tenant: 'B' });
    await liveService(meInB, panelB, { tenant: 'B' });
    const built = await ctx.container.supportContext.build(tenantA, meInB);
    expect(built.payload.customer).toBeNull();
    expect(built.payload.services).toEqual([]);
    expect(built.payload.flags.identityLinked).toBe(false);
  });

  it('every reader puts the tenant in its WHERE: the right customer id under the wrong tenant reads nothing', async () => {
    const panel = await fx.panel();
    const me = await customer('900020');
    const product = await fx.product(panel);
    await liveService(me, panel, { productId: product });
    await payment(me, { state: 'UNKNOWN', method: 'GATEWAY' });
    await incident({ message: 'tenant-a outage', targets: [] });
    const reader = new DrizzleSupportContextReader(ctx.container.database.db);
    const [svc] = await rows<{ order_id: string }>(
      sql`SELECT order_id FROM services WHERE customer_id = ${me}`,
    );

    expect(await reader.recentOrders(tenantA, me, 5)).toHaveLength(1);
    expect(await reader.recentOrders(tenantB, me, 5)).toEqual([]);
    expect((await reader.recentPayments(tenantA, me, 5)).items).toHaveLength(1);
    expect(await reader.recentPayments(tenantB, me, 5)).toEqual({
      items: [],
      anyUnderReview: false,
    });
    expect(await reader.activeIncidentNotices(tenantA, me, 5)).toHaveLength(1);
    expect(await reader.activeIncidentNotices(tenantB, me, 5)).toEqual([]);
    const refs = [{ orderId: svc?.order_id ?? '', productId: product }];
    expect((await reader.serviceCardFacts(tenantA, me, refs))[0]?.title).toBe('plan');
    expect(await reader.serviceCardFacts(tenantB, me, refs)).toEqual([
      { title: null, productLocationLabel: null },
    ]);
  });

  it('a service refunded away at the customer’s request is not in the context', async () => {
    const panel = await fx.panel();
    const me = await customer('900030');
    const kept = await liveService(me, panel);
    const gone = await liveService(me, panel);
    await refundAway(gone);
    const built = await ctx.container.supportContext.build(tenantA, me);
    expect([...built.references.services.values()]).toEqual([kept]);
    expect(built.payload.services).toHaveLength(1);
  });

  it('under review: UNKNOWN, and PENDING the customer signalled — not a plain PENDING, not CONFIRMED', async () => {
    const me = await customer('900040');
    const panel = await fx.panel();
    const awaiting = await fx.order({ customerId: me, panelId: panel, state: 'AWAITING_PAYMENT' });
    const unknown = await payment(me, { state: 'UNKNOWN', method: 'GATEWAY', minutesAgo: 4 });
    const signalled = await payment(me, { state: 'PENDING', signalled: true, minutesAgo: 3 });
    const plain = await payment(me, { state: 'PENDING', minutesAgo: 2, orderId: awaiting });
    const confirmed = await payment(me, { state: 'CONFIRMED', minutesAgo: 1 });
    const built = await ctx.container.supportContext.build(tenantA, me);
    const byId = new Map(
      [...built.references.payments.entries()].map(([alias, id]) => [
        id,
        built.payload.payments.find((p) => p.alias === alias),
      ]),
    );
    expect(byId.get(unknown)?.underReview).toBe(true);
    expect(byId.get(signalled)?.underReview).toBe(true);
    expect(byId.get(plain)?.underReview).toBe(false);
    expect(byId.get(confirmed)?.underReview).toBe(false);
    expect(built.payload.payments.map((p) => p.alias)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(built.payload.payments[0]?.state).toBe('CONFIRMED'); // newest first
    expect(byId.get(unknown)?.routeLabelKey).toBe('bot.payment.route_name_tonpays');
    expect(built.payload.flags.hasUnderReviewPayment).toBe(true);
  });

  it('the under-review flag reads ALL payments, not only the five shown', async () => {
    const me = await customer('900041');
    await payment(me, { state: 'UNKNOWN', method: 'GATEWAY', minutesAgo: 600 });
    for (let i = 0; i < 6; i += 1) await payment(me, { state: 'CONFIRMED', minutesAgo: 10 + i });
    const { payload } = await ctx.container.supportContext.build(tenantA, me);
    expect(payload.payments).toHaveLength(5);
    expect(payload.payments.some((p) => p.underReview)).toBe(false);
    expect(payload.flags.hasUnderReviewPayment).toBe(true);
  });

  it('remaining traffic is null while usage was never synced', async () => {
    const panel = await fx.panel();
    const me = await customer('900050');
    await liveService(me, panel, { synced: false });
    const { payload } = await ctx.container.supportContext.build(tenantA, me);
    expect(payload.services[0]?.remainingTrafficBytes).toBeNull();
    expect(payload.services[0]?.usageSyncedAt).toBeNull();
  });

  it('customerId null: no account facts at all, only public support — and nothing is written', async () => {
    const panel = await fx.panel();
    const me = await customer('900060');
    await liveService(me, panel);
    await payment(me, { state: 'UNKNOWN', method: 'GATEWAY' });
    await incident({ message: 'everyone outage' });
    await run(sql`INSERT INTO support_faqs (id, tenant_id, question, answer, status, sort_order,
                                            version, created_at, updated_at)
                  VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, 'Q active', 'A active',
                          'ACTIVE', 1, 1, now(), now()),
                         (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, 'Q off', 'A off',
                          'INACTIVE', 2, 1, now(), now())`);
    await run(sql`INSERT INTO client_apps (id, tenant_id, platform, name, description,
                                           official_url, guide, status)
                  VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, 'ANDROID', 'Hiddify',
                          'desc', 'https://play.example.com/hiddify', 'step one', 'ENABLED')`);
    await ctx.container.settingsService.set(tenantA, owner, {
      idempotencyKey: 'tb3-accounts',
      key: 'support.accounts',
      value: ['@HelpTb3'],
      expectedVersion: null,
    });
    const before = await writeCount();

    // A8: knowledge is what the query matches; «active» matches both FAQs, and the INACTIVE one
    // stays out by its state.
    const { payload } = await ctx.container.supportContext.build(tenantA, null, {
      query: 'active off',
    });
    expect(payload.customer).toBeNull();
    expect(payload.services).toEqual([]);
    expect(payload.orders).toEqual([]);
    expect(payload.payments).toEqual([]);
    expect(payload.incidents).toEqual([]);
    expect(payload.flags).toEqual({
      hasUnderReviewPayment: false,
      hasUnreconciledService: false,
      identityLinked: false,
      customerBlocked: false,
    });
    expect(payload.knowledge).toEqual([
      { alias: 'K1', source: 'FAQ', question: 'Q active', answer: 'A active' },
    ]);
    expect(payload.clientApps.map((app) => app.name)).toEqual(['Hiddify']);
    expect(payload.supportAccounts).toEqual(['@HelpTb3']);

    expect(await writeCount()).toBe(before);

    // A LINKED build writes nothing either.
    const linked = await ctx.container.supportContext.build(tenantA, me);
    expect(linked.payload.flags.identityLinked).toBe(true);
    expect(linked.payload.services).toHaveLength(1);
    expect(await writeCount()).toBe(before);
  });

  it('a BLOCKED customer still gets their context, flagged', async () => {
    const panel = await fx.panel();
    const me = await customer('900070', { status: 'BLOCKED' });
    await liveService(me, panel);
    const { payload } = await ctx.container.supportContext.build(tenantA, me);
    expect(payload.flags.customerBlocked).toBe(true);
    expect(payload.services).toHaveLength(1);
  });

  it('incidents: only ACTIVE ones with a customer message that reach this customer, message only', async () => {
    const panel = await fx.panel();
    const otherPanel = await fx.panel();
    const me = await customer('900080');
    await liveService(me, panel);
    await incident({ message: 'on my panel', targets: [{ kind: 'PANEL', ref: panel }] });
    await incident({ message: 'on another panel', targets: [{ kind: 'PANEL', ref: otherPanel }] });
    await incident({ message: null, targets: [{ kind: 'PANEL', ref: panel }] });
    await incident({ message: 'scheduled', status: 'SCHEDULED' });
    await incident({ message: 'resolved', status: 'RESOLVED' });
    await incident({ message: 'other tenant', tenant: tenantB });
    const { payload } = await ctx.container.supportContext.build(tenantA, me);
    expect(payload.incidents.map((i) => i.customerMessage)).toEqual(['on my panel']);
    const json = JSON.stringify(payload);
    expect(json).not.toContain(INCIDENT_TITLE);
    expect(json).not.toContain(INCIDENT_DESCRIPTION);
  });

  it('incident matching agrees with the notice audience, target shape by target shape', async () => {
    const panel = await fx.panel();
    const otherPanel = await fx.panel();
    const me = await customer('900090');
    const product = await fx.product(panel);
    await liveService(me, panel, { productId: product });
    // A deliverable customer whose ONLY service on the same panel and product is TERMINATED:
    // never in the audience, so never in the context.
    const dead = await customer('900091');
    await liveService(dead, panel, { productId: product, state: 'TERMINATED' });
    const otherProduct = await fx.product(otherPanel);
    const location = ctx.container.ids.uuid();
    const otherLocation = ctx.container.ids.uuid();
    await run(sql`INSERT INTO service_locations (id, tenant_id, panel_id, location_key, label)
                  VALUES (${location}, ${tenantA.tenantId}, ${panel}, 'de', 'DE'),
                         (${otherLocation}, ${tenantA.tenantId}, ${otherPanel}, 'nl', 'NL')`);
    const shapes: Record<string, readonly { kind: string; ref: string }[]> = {
      none: [],
      gateway: [{ kind: 'GATEWAY', ref: 'TONPAYS' }],
      myPanel: [{ kind: 'PANEL', ref: panel }],
      otherPanel: [{ kind: 'PANEL', ref: otherPanel }],
      myProduct: [{ kind: 'PRODUCT', ref: product }],
      otherProduct: [{ kind: 'PRODUCT', ref: otherProduct }],
      myLocation: [{ kind: 'LOCATION', ref: location }],
      otherLocation: [{ kind: 'LOCATION', ref: otherLocation }],
      unknownLocation: [{ kind: 'LOCATION', ref: ctx.container.ids.uuid() }],
      otherPanelAndGateway: [
        { kind: 'PANEL', ref: otherPanel },
        { kind: 'GATEWAY', ref: 'TONPAYS' },
      ],
    };
    const reader = new DrizzleSupportContextReader(ctx.container.database.db);
    const verdicts: Record<string, { audience: boolean; context: boolean }> = {};
    for (const [shape, targets] of Object.entries(shapes)) {
      await run(sql`DELETE FROM incident_targets`);
      await run(sql`DELETE FROM incidents`);
      const id = await incident({ message: shape, targets });
      const preview = await ctx.container.incidents.noticePreview(tenantA, owner, id);
      const notices = await reader.activeIncidentNotices(tenantA, me, 10);
      expect(await reader.activeIncidentNotices(tenantA, dead, 10), shape).toEqual([]);
      expect(preview.recipients, shape).toBeLessThanOrEqual(1);
      verdicts[shape] = { audience: preview.recipients === 1, context: notices.length === 1 };
    }
    for (const verdict of Object.values(verdicts)) expect(verdict.context).toBe(verdict.audience);
    expect(Object.fromEntries(Object.entries(verdicts).map(([k, v]) => [k, v.context]))).toEqual({
      none: true,
      gateway: true,
      myPanel: true,
      otherPanel: false,
      myProduct: true,
      otherProduct: false,
      myLocation: true,
      otherLocation: false,
      unknownLocation: true,
      otherPanelAndGateway: false,
    });
  });

  it('references hold only the aliases that survived the byte budget', async () => {
    const panel = await fx.panel();
    const me = await customer('900200');
    const longLabel = 'ل'.repeat(200);
    for (let i = 0; i < 10; i += 1) await liveService(me, panel);
    await run(
      sql`UPDATE services SET location_key = 'far', location_label = ${longLabel} WHERE customer_id = ${me}`,
    );
    for (let i = 0; i < 5; i += 1) await payment(me, { state: 'CONFIRMED', minutesAgo: i + 1 });
    for (let i = 0; i < 3; i += 1) await incident({ message: 'پ'.repeat(1500) });
    // A8: relevant knowledge inside its reserve holds its share, so the account facts must give way.
    for (let i = 0; i < 3; i += 1) {
      await run(sql`INSERT INTO support_faqs (id, tenant_id, question, answer, status, sort_order,
                                              version, created_at, updated_at)
                    VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${`اتصال ${String(i)}`},
                            ${'ج'.repeat(1500)}, 'ACTIVE', ${i + 1}, 1, now(), now())`);
    }

    const built = await ctx.container.supportContext.build(tenantA, me, { query: 'اتصال' });
    const { payload, references } = built;
    expect(payload.knowledge).toHaveLength(3);
    expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBeLessThanOrEqual(
      SUPPORT_CONTEXT_MAX_BYTES,
    );
    // The budget really cut: the test is about what survives a cut.
    expect(payload.services.length).toBeLessThan(10);
    expect(payload.incidents).toHaveLength(3);
    for (const family of ['services', 'orders', 'payments'] as const) {
      expect(references[family].size, family).toBe(payload[family].length);
      const shown = new Set(payload[family].map((entry) => entry.alias));
      for (const alias of references[family].keys()) expect(shown.has(alias), alias).toBe(true);
    }
  });

  it('an incident on a panel reaches only the customer with a live service there', async () => {
    const panel = await fx.panel();
    const otherPanel = await fx.panel();
    const affected = await customer('900210');
    const elsewhere = await customer('900211');
    await liveService(affected, panel);
    await liveService(elsewhere, otherPanel);
    await incident({ message: 'panel down', targets: [{ kind: 'PANEL', ref: panel }] });
    expect(
      (await ctx.container.supportContext.build(tenantA, affected)).payload.incidents,
    ).toHaveLength(1);
    expect(
      (await ctx.container.supportContext.build(tenantA, elsewhere)).payload.incidents,
    ).toEqual([]);
  });

  it('under review, gateway facets: PARTIAL/LATE_COMPLETION unless CONFIRMED or refunded; PENDING with only a provider review', async () => {
    const me = await customer('900220');
    const partialFailed = await payment(me, {
      state: 'FAILED',
      method: 'GATEWAY',
      provider: 'NOWPAYMENTS',
      minutesAgo: 9,
    });
    await invoice(partialFailed, 'NOWPAYMENTS', {
      provider_status: 'partially_paid',
      provider_paid: false,
    });
    const partialConfirmed = await payment(me, {
      state: 'CONFIRMED',
      method: 'GATEWAY',
      provider: 'NOWPAYMENTS',
      minutesAgo: 8,
    });
    await invoice(partialConfirmed, 'NOWPAYMENTS', {
      provider_status: 'partially_paid',
      provider_paid: false,
    });
    const partialRefunded = await payment(me, {
      state: 'FAILED',
      method: 'GATEWAY',
      provider: 'NOWPAYMENTS',
      minutesAgo: 7,
    });
    await invoice(partialRefunded, 'NOWPAYMENTS', {
      provider_status: 'partially_paid',
      provider_paid: false,
    });
    await refundRow(partialRefunded, me);
    const late = await payment(me, { state: 'FAILED', method: 'GATEWAY', minutesAgo: 6 });
    await invoice(late, 'TONPAYS', {
      outcome: 'LATE_COMPLETION',
      outcome_at: new Date(),
      late_completion_observed_at: new Date(),
    });
    const reviewed = await payment(me, {
      state: 'PENDING',
      method: 'GATEWAY',
      provider: 'NOWPAYMENTS',
      providerReview: true,
      minutesAgo: 5,
    });
    const plainGateway = await payment(me, {
      state: 'PENDING',
      method: 'GATEWAY',
      provider: 'NOWPAYMENTS',
      minutesAgo: 4,
    });

    const reader = new DrizzleSupportContextReader(ctx.container.database.db);
    const read = await reader.recentPayments(tenantA, me, 10);
    const verdict = new Map(read.items.map((item) => [item.id, item.underReview]));
    expect(
      Object.fromEntries([
        ['partialFailed', verdict.get(partialFailed)],
        ['partialConfirmed', verdict.get(partialConfirmed)],
        ['partialRefunded', verdict.get(partialRefunded)],
        ['late', verdict.get(late)],
        ['reviewed', verdict.get(reviewed)],
        ['plainGateway', verdict.get(plainGateway)],
      ]),
    ).toEqual({
      partialFailed: true,
      partialConfirmed: false,
      partialRefunded: false,
      late: true,
      reviewed: true,
      plainGateway: false,
    });
  });

  it('orders: a DRAFT is not in the context; an AWAITING_PAYMENT order is', async () => {
    const panel = await fx.panel();
    const me = await customer('900230');
    const awaiting = await fx.order({ customerId: me, panelId: panel, state: 'AWAITING_PAYMENT' });
    // A DRAFT written as the order service writes one: no confirmation, no expiry, no
    // settlement (the snapshot guard refuses turning a row back into a draft by UPDATE).
    const draft = ctx.container.ids.uuid();
    await run(sql`
      INSERT INTO orders (id, tenant_id, customer_id, state, purpose, product_id, panel_id,
                          line_title, line_duration_days, line_traffic_bytes,
                          line_unit_price_amount, line_quantity, subtotal_amount,
                          discount_amount, total_amount, currency, quote)
      SELECT ${draft}, tenant_id, customer_id, 'DRAFT', purpose, product_id, panel_id,
             line_title, line_duration_days, line_traffic_bytes, line_unit_price_amount,
             line_quantity, subtotal_amount, discount_amount, total_amount, currency, quote
        FROM orders WHERE id = ${awaiting}`);
    expect(draft).not.toBe(awaiting);
    const built = await ctx.container.supportContext.build(tenantA, me);
    expect([...built.references.orders.values()]).toEqual([awaiting]);
    expect(built.payload.orders.map((order) => order.state)).toEqual(['AWAITING_PAYMENT']);
  });

  it('client apps: an app restricted to another provider is not offered to a customer on Marzban', async () => {
    const panel = await fx.panel(); // provider_type 'marzban'
    const me = await customer('900240');
    await liveService(me, panel);
    await run(sql`INSERT INTO client_apps (id, tenant_id, platform, name, description,
                                           official_url, guide, status, provider_types)
                  VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, 'ANDROID', 'AnyApp',
                          'desc', 'https://play.example.com/any', 'g', 'ENABLED', '{}'::text[]),
                         (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, 'ANDROID', 'SanaeiOnly',
                          'desc', 'https://play.example.com/sanaei', 'g', 'ENABLED',
                          ARRAY['sanaei']::text[])`);
    const linked = await ctx.container.supportContext.build(tenantA, me);
    expect(linked.payload.clientApps.map((app) => app.name)).toEqual(['AnyApp']);
    // An unlinked peer has no services to filter by, and is shown both (WP-A10's rule).
    const unlinked = await ctx.container.supportContext.build(tenantA, null);
    expect(unlinked.payload.clientApps.map((app) => app.name).sort()).toEqual([
      'AnyApp',
      'SanaeiOnly',
    ]);
  });

  it('service card facts read only the customer’s own order for a title', async () => {
    const panel = await fx.panel();
    const me = await customer('900250');
    const other = await customer('900251');
    await liveService(me, panel);
    const [mine] = await rows<{ order_id: string }>(
      sql`SELECT order_id FROM services WHERE customer_id = ${me}`,
    );
    const reader = new DrizzleSupportContextReader(ctx.container.database.db);
    const refs = [{ orderId: mine?.order_id ?? '', productId: null }];
    expect((await reader.serviceCardFacts(tenantA, me, refs))[0]?.title).toBe('plan');
    expect((await reader.serviceCardFacts(tenantA, other, refs))[0]?.title).toBeNull();
  });

  it('live services come first: newer TERMINATED ones cannot push an ACTIVE one out of the ten', async () => {
    const panel = await fx.panel();
    const me = await customer('900260');
    const active = await liveService(me, panel);
    await run(
      sql`UPDATE services SET created_at = now() - interval '30 days' WHERE id = ${active}`,
    );
    for (let i = 0; i < 11; i += 1) await liveService(me, panel, { state: 'TERMINATED' });
    const built = await ctx.container.supportContext.build(tenantA, me);
    expect(built.payload.services).toHaveLength(10);
    expect(built.references.services.get('S1')).toBe(active);
    expect(built.payload.services[0]?.state).toBe('ACTIVE');
    expect(built.payload.services.slice(1).every((s) => s.state === 'TERMINATED')).toBe(true);
  });

  it('L4: an UNRECONCILED service beyond the ten shown still sets the flag', async () => {
    const panel = await fx.panel();
    const me = await customer('900270');
    const hidden = await liveService(me, panel);
    await run(
      sql`UPDATE services SET state = 'UNRECONCILED', provisioned_at = NULL,
                              created_at = now() - interval '30 days'
           WHERE id = ${hidden}`,
    );
    for (let i = 0; i < 11; i += 1) await liveService(me, panel);
    const built = await ctx.container.supportContext.build(tenantA, me);
    expect(built.payload.services).toHaveLength(10);
    expect([...built.references.services.values()]).not.toContain(hidden);
    expect(built.payload.services.some((s) => s.unreconciled)).toBe(false);
    expect(built.payload.flags.hasUnreconciledService).toBe(true);
    // The reader is tenant-scoped like every other.
    const reader = new DrizzleSupportContextReader(ctx.container.database.db);
    expect(await reader.anyUnreconciledService(tenantA, me)).toBe(true);
    expect(await reader.anyUnreconciledService(tenantB, me)).toBe(false);
  });

  it('measures one full build: statements and wall time (recorded in the TB3 doc, not asserted)', async () => {
    const panel = await fx.panel();
    const me = await customer('900100');
    for (let i = 0; i < 12; i += 1) await liveService(me, panel);
    for (let i = 0; i < 7; i += 1) await payment(me, { state: 'CONFIRMED', minutesAgo: i + 1 });
    await incident({ message: 'outage' });
    const pool = ctx.container.database.pool;
    let statements = 0;
    const original = pool.query.bind(pool);
    (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
      statements += 1;
      return (original as (...a: unknown[]) => unknown)(...args);
    };
    try {
      await ctx.container.supportContext.build(tenantA, me); // warm
      statements = 0;
      const started = performance.now();
      const built = await ctx.container.supportContext.build(tenantA, me);
      const elapsed = performance.now() - started;
      const bytes = new TextEncoder().encode(JSON.stringify(built.payload)).length;
      console.info(
        `TB3 measure: statements=${String(statements)} ms=${elapsed.toFixed(1)} bytes=${String(bytes)} services=${String(built.payload.services.length)}`,
      );
      statements = 0;
      const publicStarted = performance.now();
      await ctx.container.supportContext.build(tenantA, null);
      console.info(
        `TB3 measure (public): statements=${String(statements)} ms=${(performance.now() - publicStarted).toFixed(1)}`,
      );
      expect(built.payload.services).toHaveLength(10);
      expect(built.payload.payments).toHaveLength(5);
      expect(bytes).toBeLessThanOrEqual(16 * 1024);
    } finally {
      (pool as unknown as { query: unknown }).query = original;
    }
  });
});
