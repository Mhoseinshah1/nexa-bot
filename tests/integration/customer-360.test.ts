import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  EMPTY_PRODUCT_DISPLAY,
  isNexaError,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type OrderId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import type { ServiceRecord } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  validatePanelConnection,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * Customer 360 — the backend controls (spec §11.4–11.10,
 * `docs/customer-account-transfer-audit.md`), end to end against a real PostgreSQL with the
 * migrations' triggers, the real provisioner and Marzban adapter against the fake panel, and
 * a socket standing in for Telegram.
 *
 * Every rule the audit names has a case here: a rule with no test is a rule that will be
 * silently reverted.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const SOURCE_TG = '951001';
const DEST_TG = '951002';
const BLOCKED_TG = '951003';
const PRICE = 250_000n;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('Customer 360 — backend controls', () => {
  let ctx: TestContext;
  let telegram: Server;
  let panel: FakeMarzban;
  let services: DrizzleServiceRepository;
  let productId: ProductId;
  let source: UserId;
  let destination: UserId;
  let blocked: UserId;
  let owner: ActorContext;
  let operator: ActorContext;
  let support: ActorContext;
  let keySeq = 0;
  const key = (label: string) => `${label}-${String((keySeq += 1))}`;

  beforeAll(async () => {
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      request.on('data', () => undefined);
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    telegram.closeAllConnections();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-360', roleKeys: ['owner'] }),
    );
    operator = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'op-360', roleKeys: ['operator'] }),
    );
    support = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'sup-360', roleKeys: ['support'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-360-create',
    });
    await validatePanelConnection(ctx.container, tenantA, created.view.panel.id);
    const products = new DrizzleProductRepository(ctx.container.database.db);
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ۳۶۰',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: created.view.panel.id as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(PRICE, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    productId = product.id;

    source = await resolve(SOURCE_TG, 'مبدا');
    destination = await resolve(DEST_TG, 'مقصد');
    blocked = await resolve(BLOCKED_TG, 'مسدود');
    await ctx.container.customers.block(tenantA, owner, {
      idempotencyKey: 'block-360',
      customerId: blocked,
      reason: 'fixture',
    });
  });

  async function resolve(telegramUserId: string, firstName: string): Promise<UserId> {
    const resolved = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(`r-${telegramUserId}`),
      {
        idempotencyKey: `resolve-360-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: firstName },
        botInstanceId: BOT_A,
      },
    );
    return resolved.customer.id;
  }

  const fund = (customerId: UserId, amount: bigint) =>
    ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: key('credit'),
      direction: 'CREDIT',
      amountMinor: amount,
      currency: 'IRT',
      note: 'fixture',
    });

  const balanceOf = async (customerId: UserId) =>
    (await ctx.container.wallet.balance(tenantA, owner, customerId)).amountMinor;

  /** A NEW_SERVICE order the customer paid from their wallet, provisioned and delivered. */
  async function deliveredService(label: string, buyer: UserId = source): Promise<ServiceRecord> {
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(label), {
      idempotencyKey: key(`${label}-draft`),
      customerId: buyer,
      productId,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(label), {
      idempotencyKey: key(`${label}-confirm`),
      customerId: buyer,
      orderId: draft.id,
    });
    await fund(buyer, PRICE);
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(label), buyer, {
      idempotencyKey: key(`${label}-pay`),
      orderId: confirmed.id as OrderId,
    });
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, confirmed.id);
    if (service === null || service.state !== 'ACTIVE' || service.deliveryState !== 'DELIVERED') {
      throw new Error(`the fixture must start ACTIVE and DELIVERED: ${JSON.stringify(service)}`);
    }
    return service;
  }

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return ((await ctx.container.database.db.execute(query as never)) as unknown as { rows: T[] })
      .rows;
  }

  const count = async (query: ReturnType<typeof sql>): Promise<number> =>
    Number((await rows<{ n: number }>(query))[0]?.n ?? 0);

  async function refusalOf(promise: Promise<unknown>): Promise<{
    code: string;
    details: Record<string, unknown>;
  }> {
    try {
      await promise;
    } catch (error) {
      if (isNexaError(error)) return { code: error.code, details: error.details };
      throw error;
    }
    throw new Error('expected a refusal');
  }

  const auditOf = (action: string) =>
    rows<{ result: string; reason: string | null; entity_id: string }>(
      sql`SELECT result, reason, entity_id FROM audit_logs
           WHERE tenant_id = ${tenantA.tenantId} AND action = ${action} ORDER BY occurred_at`,
    );

  const eventsOf = (eventType: string) =>
    count(sql`SELECT count(*)::int AS n FROM outbox_messages WHERE event_type = ${eventType}`);

  // ===================================================================================
  // §11.4 — the per-customer controls
  // ===================================================================================

  describe('controls', () => {
    it('records a channel exemption with its reason and event, once per key', async () => {
      const first = await ctx.container.customerControls.setChannelExemption(tenantA, operator, {
        idempotencyKey: 'exempt-1',
        customerId: source,
        exempt: true,
        reason: 'VIP',
      });
      expect(first.changed).toBe(true);
      expect(first.overview.customer.channelMembershipExemptAt).not.toBeNull();
      // A replay answers the state now, writes nothing again.
      const replay = await ctx.container.customerControls.setChannelExemption(tenantA, operator, {
        idempotencyKey: 'exempt-1',
        customerId: source,
        exempt: true,
        reason: 'VIP',
      });
      expect(replay.changed).toBe(true);
      // A second key for the same end state is a successful no-op, audited as one.
      const again = await ctx.container.customerControls.setChannelExemption(tenantA, operator, {
        idempotencyKey: 'exempt-2',
        customerId: source,
        exempt: true,
        reason: 'VIP again',
      });
      expect(again.changed).toBe(false);
      const audits = await auditOf('customer.channel_exemption.grant');
      expect(audits.map((row) => [row.result, row.reason])).toEqual([
        ['SUCCESS', 'VIP'],
        ['SUCCESS', 'VIP again'],
      ]);
      expect(await eventsOf('CustomerChannelMembershipExemptionChanged')).toBe(1);
      // A key reused with a DIFFERENT payload is a caller bug, refused.
      await expect(
        ctx.container.customerControls.setChannelExemption(tenantA, operator, {
          idempotencyKey: 'exempt-1',
          customerId: source,
          exempt: false,
          reason: 'VIP',
        }),
      ).rejects.toMatchObject({ code: 'platform.idempotency_payload_mismatch' });
    });

    it('refuses every control to a role without its key, and audits the denial', async () => {
      await expect(
        ctx.container.customerControls.setChannelExemption(tenantA, support, {
          idempotencyKey: 'exempt-denied',
          customerId: source,
          exempt: true,
          reason: 'x',
        }),
      ).rejects.toMatchObject({ code: 'platform.permission_denied' });
      await expect(
        ctx.container.customerControls.setVerifiedPhone(tenantA, support, {
          idempotencyKey: 'phone-denied',
          customerId: source,
          phoneNumber: '+989121234567',
          reason: 'x',
        }),
      ).rejects.toMatchObject({ code: 'platform.permission_denied' });
      expect((await auditOf('customer.channel_exemption.grant'))[0]?.result).toBe('DENIED');
      const row = await ctx.container.customers.get(tenantA, owner, source);
      expect(row.channelMembershipExemptAt).toBeNull();
      expect(row.phoneNumber).toBeNull();
    });

    it('requires a reason', async () => {
      expect(
        (
          await refusalOf(
            ctx.container.customerControls.setChannelExemption(tenantA, operator, {
              idempotencyKey: 'exempt-noreason',
              customerId: source,
              exempt: true,
              reason: '   ',
            }),
          )
        ).code,
      ).toBe(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID);
    });

    it('verifies a phone typed in Persian digits, refuses one without a country code, and revokes', async () => {
      const verified = await ctx.container.customerControls.setVerifiedPhone(tenantA, operator, {
        idempotencyKey: 'phone-1',
        customerId: source,
        phoneNumber: '+۹۸ ۹۱۲-۱۲۳-۴۵۶۷',
        reason: 'called the customer',
      });
      expect(verified.overview.customer.phoneNumber).toBe('+989121234567');
      expect(verified.overview.customer.phoneVerifiedAt).not.toBeNull();
      expect(
        (
          await refusalOf(
            ctx.container.customerControls.setVerifiedPhone(tenantA, operator, {
              idempotencyKey: 'phone-2',
              customerId: source,
              phoneNumber: '09121234567',
              reason: 'x',
            }),
          )
        ).code,
      ).toBe(COMMERCE_ERROR_CODES.CUSTOMER_PHONE_INVALID);
      const revoked = await ctx.container.customerControls.setVerifiedPhone(tenantA, operator, {
        idempotencyKey: 'phone-3',
        customerId: source,
        phoneNumber: null,
        reason: 'number changed',
      });
      expect(revoked.changed).toBe(true);
      expect(revoked.overview.customer.phoneNumber).toBeNull();
      expect(revoked.overview.customer.phoneVerifiedAt).toBeNull();
      // The number never travels in an event.
      const payloads = await rows<{ payload: Record<string, unknown> }>(
        sql`SELECT payload FROM outbox_messages WHERE event_type = 'CustomerPhoneVerificationChanged'`,
      );
      expect(payloads.map((row) => row.payload)).toEqual([{ verified: true }, { verified: false }]);
    });

    it('refuses half a rolling limit, and stores and removes an override', async () => {
      expect(
        (
          await refusalOf(
            ctx.container.customerControls.setLocationOverride(tenantA, operator, {
              idempotencyKey: 'loc-half',
              customerId: source,
              limits: { cooldownHours: null, maxChanges: 2, periodDays: null },
              reason: 'x',
            }),
          )
        ).code,
      ).toBe(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID);
      const set = await ctx.container.customerControls.setLocationOverride(tenantA, operator, {
        idempotencyKey: 'loc-set',
        customerId: source,
        limits: { cooldownHours: 2, maxChanges: 5, periodDays: 30 },
        reason: 'travelling',
      });
      expect(set.overview.locationOverride?.limits).toEqual({
        cooldownHours: 2,
        maxChanges: 5,
        periodDays: 30,
      });
      const removed = await ctx.container.customerControls.setLocationOverride(tenantA, operator, {
        idempotencyKey: 'loc-remove',
        customerId: source,
        limits: null,
        reason: 'back',
      });
      expect(removed.overview.locationOverride).toBeNull();
      expect(await eventsOf('CustomerLocationChangeOverrideChanged')).toBe(2);
    });

    it("sets the promotional opt-out on the customer's behalf, in the column /stop writes", async () => {
      const out = await ctx.container.customerControls.setMarketingPreference(tenantA, operator, {
        idempotencyKey: 'mkt-1',
        customerId: source,
        optedOut: true,
        reason: 'asked on support',
      });
      expect(out.overview.customer.marketingOptOutAt).not.toBeNull();
      const back = await ctx.container.customerControls.setMarketingPreference(tenantA, operator, {
        idempotencyKey: 'mkt-2',
        customerId: source,
        optedOut: false,
        reason: 'asked again',
      });
      expect(back.overview.customer.marketingOptOutAt).toBeNull();
      expect((await auditOf('customer.marketing_opt_out'))[0]?.reason).toBe('asked on support');
    });
  });

  // ===================================================================================
  // §11.5 — the account transfer
  // ===================================================================================

  describe('account transfer', () => {
    const preview = (by: ActorContext = owner, destinationTelegramUserId = DEST_TG) =>
      ctx.container.customerAccountTransfers.preview(tenantA, by, {
        sourceId: source,
        destinationTelegramUserId,
      });

    const transfer = (
      fingerprint: string,
      overrides: Partial<{
        idempotencyKey: string;
        destinationTelegramUserId: string;
        confirmTelegramUserId: string;
        by: ActorContext;
      }> = {},
    ) =>
      ctx.container.customerAccountTransfers.transfer(tenantA, overrides.by ?? owner, {
        idempotencyKey: overrides.idempotencyKey ?? key('transfer'),
        sourceId: source,
        destinationTelegramUserId: overrides.destinationTelegramUserId ?? DEST_TG,
        fingerprint,
        confirmTelegramUserId: overrides.confirmTelegramUserId ?? DEST_TG,
        reason: 'customer lost their Telegram account',
      });

    it('moves every movable service and the whole balance, through ownership rows and a ledger pair', async () => {
      const first = await deliveredService('t1');
      const second = await deliveredService('t2');
      await fund(source, 70_000n);
      await fund(destination, 5_000n);
      // The destination's own service is never touched.
      const theirs = await deliveredService('dest', destination);

      const plan = await preview();
      expect(plan.blockers).toEqual([]);
      expect(plan.moves.services.map((service) => service.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );
      expect(plan.moves.walletAmount).toBe(70_000n);

      const result = await transfer(plan.fingerprint, { idempotencyKey: 'move-all' });
      expect(result.replayed).toBe(false);
      expect(result.transfer.serviceIds).toHaveLength(2);

      expect((await services.findById(tenantA, first.id))?.customerId).toBe(destination);
      expect((await services.findById(tenantA, second.id))?.customerId).toBe(destination);
      expect((await services.findById(tenantA, theirs.id))?.customerId).toBe(destination);
      expect(await balanceOf(source)).toBe(0n);
      expect(await balanceOf(destination)).toBe(75_000n);
      // The orders and payments stay the payer's: history is never rewritten.
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM orders WHERE customer_id = ${source} AND state = 'PAID'`,
        ),
      ).toBe(2);
      expect(
        await count(
          sql`SELECT count(*)::int AS n FROM service_ownership_transfers
               WHERE from_customer_id = ${source} AND bot_instance_id IS NULL
                 AND actor_type = 'WEB_ADMIN'`,
        ),
      ).toBe(2);
      const ledger = await rows<{ reason: string; direction: string; amount: string }>(
        sql`SELECT reason, direction, amount::text FROM wallet_entries
             WHERE reason IN ('ACCOUNT_TRANSFER_OUT', 'ACCOUNT_TRANSFER_IN') ORDER BY direction`,
      );
      expect(ledger).toEqual([
        { reason: 'ACCOUNT_TRANSFER_IN', direction: 'CREDIT', amount: '70000' },
        { reason: 'ACCOUNT_TRANSFER_OUT', direction: 'DEBIT', amount: '70000' },
      ]);
      expect(
        (await auditOf('customer.account_transfer')).map((row) => [row.result, row.entity_id]),
      ).toEqual([['SUCCESS', source]]);
      expect((await auditOf('customer.account_transfer.received'))[0]?.entity_id).toBe(destination);
      expect(await eventsOf('CustomerAccountTransferred')).toBe(1);
      expect(await eventsOf('ServiceOwnershipTransferred')).toBe(2);

      // The same key replays the transfer it wrote and moves nothing again.
      const replay = await transfer(plan.fingerprint, { idempotencyKey: 'move-all' });
      expect(replay.replayed).toBe(true);
      expect(replay.transfer.id).toBe(result.transfer.id);
      expect(await count(sql`SELECT count(*)::int AS n FROM customer_account_transfers`)).toBe(1);
      // A second transfer now has nothing to move.
      expect((await preview()).blockers).toContain('NOTHING_TO_MOVE');
      // The record is append-only.
      await expect(
        ctx.container.database.db.execute(sql`DELETE FROM customer_account_transfers`),
      ).rejects.toThrow();
    });

    it('refuses a confirmation made from a preview that no longer holds', async () => {
      await deliveredService('stale');
      await fund(source, 10_000n);
      const plan = await preview();
      await fund(source, 1n);
      expect((await refusalOf(transfer(plan.fingerprint))).code).toBe(
        COMMERCE_ERROR_CODES.CUSTOMER_TRANSFER_PREVIEW_STALE,
      );
      expect(await balanceOf(source)).toBe(10_001n);
      expect(await count(sql`SELECT count(*)::int AS n FROM service_ownership_transfers`)).toBe(0);
    });

    it('refuses an unknown, blocked or same destination, and a confirmation naming another id', async () => {
      await fund(source, 10_000n);
      expect((await preview(owner, '959999')).blockers).toContain('DESTINATION_UNKNOWN');
      expect((await preview(owner, BLOCKED_TG)).blockers).toContain('DESTINATION_BLOCKED');
      expect((await preview(owner, SOURCE_TG)).blockers).toContain('SAME_CUSTOMER');
      const blockedPlan = await preview(owner, BLOCKED_TG);
      const refused = await refusalOf(
        transfer(blockedPlan.fingerprint, {
          destinationTelegramUserId: BLOCKED_TG,
          confirmTelegramUserId: BLOCKED_TG,
        }),
      );
      expect(refused.code).toBe(COMMERCE_ERROR_CODES.CUSTOMER_TRANSFER_REFUSED);
      expect(refused.details.blockers).toContain('DESTINATION_BLOCKED');

      const plan = await preview();
      expect(
        (await refusalOf(transfer(plan.fingerprint, { confirmTelegramUserId: '951009' }))).code,
      ).toBe(COMMERCE_ERROR_CODES.CUSTOMER_TRANSFER_CONFIRMATION_MISMATCH);
      // Persian digits typed into the confirmation are the same id.
      const done = await transfer(plan.fingerprint, { confirmTelegramUserId: '۹۵۱۰۰۲' });
      expect(done.transfer.walletAmount).toBe(10_000n);
    });

    it('refuses while an order awaits payment: money in flight is never split', async () => {
      await deliveredService('busy');
      const draft = await ctx.container.orders.createDraft(tenantA, systemActor('busy2'), {
        idempotencyKey: key('busy-draft'),
        customerId: source,
        productId,
      });
      await ctx.container.orders.confirm(tenantA, systemActor('busy2'), {
        idempotencyKey: key('busy-confirm'),
        customerId: source,
        orderId: draft.id,
      });
      const plan = await preview();
      expect(plan.blockers).toContain('ORDER_IN_PROGRESS');
      expect((await refusalOf(transfer(plan.fingerprint))).code).toBe(
        COMMERCE_ERROR_CODES.CUSTOMER_TRANSFER_REFUSED,
      );
      expect(await count(sql`SELECT count(*)::int AS n FROM service_ownership_transfers`)).toBe(0);
    });

    it('refuses a service with an undecided operation rather than moving it half-way', async () => {
      const service = await deliveredService('undecided');
      await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'SUSPEND', {
        idempotencyKey: 'suspend-pending',
      });
      expect((await preview()).blockers).toContain('SERVICE_UNSETTLED');
    });

    // --- every blocker and warning, each from the rows that cause it (review round 1) ---

    const run = (query: ReturnType<typeof sql>) =>
      ctx.container.database.db.execute(query as never);
    const blockersNow = async () => (await preview()).blockers;

    it('refuses a reseller source, and warns for a reseller destination', async () => {
      await fund(source, 10_000n);
      const tier = ctx.container.ids.uuid();
      await run(sql`INSERT INTO reseller_tiers (id, tenant_id, name, pricing_mode, credit_limit_currency)
                    VALUES (${tier}, ${tenantA.tenantId}, 'tier', 'LIST_PRICE', 'IRT')`);
      await run(sql`INSERT INTO resellers (id, tenant_id, customer_id, tier_id, status, credit_limit_amount)
                    VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${destination}, ${tier}, 'ACTIVE', NULL)`);
      const plan = await preview();
      expect(plan.blockers).toEqual([]);
      expect(plan.warnings).toContain('DESTINATION_IS_RESELLER');
      await run(sql`INSERT INTO resellers (id, tenant_id, customer_id, tier_id, status, credit_limit_amount)
                    VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${source}, ${tier}, 'ACTIVE', NULL)`);
      expect(await blockersNow()).toContain('SOURCE_IS_RESELLER');
    });

    it('refuses a negative (legacy-debt) balance', async () => {
      await deliveredService('debt');
      await run(sql`INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount, currency, reference)
                    VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${source}, 'DEBIT',
                            'ADMIN_DEBIT', 5000, 'IRT', ${key('debt-ref')})`);
      expect(await blockersNow()).toContain('SOURCE_BALANCE_NEGATIVE');
    });

    it('refuses a pending payment', async () => {
      await fund(source, 10_000n);
      await run(sql`INSERT INTO payments (id, tenant_id, customer_id, state, method, amount, currency, reference, expires_at)
                    VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${source}, 'PENDING',
                            'MANUAL_TRANSFER', 50000, 'IRT', ${key('pay-ref')}, now() + interval '1 hour')`);
      expect(await blockersNow()).toContain('PAYMENT_PENDING');
    });

    it('refuses promised cashback, and a promised referral commission to the source', async () => {
      const service = await deliveredService('reward');
      const rule = ctx.container.ids.uuid();
      await run(sql`INSERT INTO cashback_rules (id, tenant_id, label, percent, applies_to)
                    VALUES (${rule}, ${tenantA.tenantId}, 'rule', 5, ARRAY['NEW_SERVICE'])`);
      const cashback = ctx.container.ids.uuid();
      await run(sql`INSERT INTO order_cashback (id, tenant_id, order_id, customer_id, rule_id, rule_label, percent, amount, currency)
                    VALUES (${cashback}, ${tenantA.tenantId}, ${service.orderId}, ${source}, ${rule}, 'rule', 5, 100, 'IRT')`);
      expect(await blockersNow()).toContain('REWARD_PENDING');
      expect((await preview()).warnings).toContain('REFUNDS_CREDIT_SOURCE');
    });

    it('refuses a referral commission promised to the source, and warns that referral credits stay', async () => {
      await fund(source, 10_000n);
      const referee = await resolve('951009', 'معرفی‌شده');
      const referral = ctx.container.ids.uuid();
      await run(sql`INSERT INTO referrals (id, tenant_id, referrer_id, referee_id, trigger)
                    VALUES (${referral}, ${tenantA.tenantId}, ${source}, ${referee}, 'ON_EVERY_PAID_ORDER')`);
      expect((await preview()).warnings).toContain('REFERRAL_CREDITS_STAY');
      const bought = await deliveredService('referee-buy', referee);
      await run(sql`INSERT INTO order_referral_commissions
                      (id, tenant_id, order_id, referral_id, referrer_id, referee_id, scope, percent, basis_amount, amount, currency)
                    VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${bought.orderId}, ${referral},
                            ${source}, ${referee}, 'EVERY_PAID_ORDER', 10, 250000, 25000, 'IRT')`);
      expect(await blockersNow()).toContain('REWARD_PENDING');
    });

    it('refuses a pending bulk operation item', async () => {
      await fund(source, 10_000n);
      const operation = ctx.container.ids.uuid();
      await run(sql`INSERT INTO bulk_operations
                      (id, tenant_id, kind, amount_minor, currency, notify, note, audience_definition,
                       audience_hash, audience_as_of, item_count, audience_fingerprint, created_by_admin_id)
                    VALUES (${operation}, ${tenantA.tenantId}, 'WALLET_CREDIT', 1000, 'IRT', false, 'x', '{}'::jsonb,
                            ${'a'.repeat(64)}, now(), 1, 'x', ${owner.id})`);
      await run(sql`INSERT INTO bulk_operation_items (id, tenant_id, bulk_operation_id, customer_id)
                    VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${operation}, ${source})`);
      expect(await blockersNow()).toContain('BULK_OPERATION_PENDING');
    });

    it('refuses a PAID order whose service does not exist yet', async () => {
      await fund(source, 10_000n);
      const panel = (
        await rows<{ panel_id: string }>(sql`SELECT panel_id FROM products WHERE id = ${productId}`)
      )[0]!.panel_id;
      await run(sql`INSERT INTO orders
                      (id, tenant_id, customer_id, state, product_id, panel_id, line_title, line_duration_days,
                       line_traffic_bytes, line_unit_price_amount, subtotal_amount, discount_amount,
                       total_amount, currency, quote, confirmed_at, settled_at, purpose)
                    VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${source}, 'PAID', ${productId}, ${panel},
                            'x', 30, 1, 1000, 1000, 0, 1000, 'IRT', '{}'::jsonb, now(), now(), 'NEW_SERVICE')`);
      expect(await blockersNow()).toContain('ORDER_IN_PROGRESS');
    });

    it('refuses a service still being provisioned before taking any service lock', async () => {
      // Settled and not yet provisioned: PENDING_PROVISION.
      const draft = await ctx.container.orders.createDraft(tenantA, systemActor('pp'), {
        idempotencyKey: key('pp-draft'),
        customerId: source,
        productId,
      });
      const confirmed = await ctx.container.orders.confirm(tenantA, systemActor('pp'), {
        idempotencyKey: key('pp-confirm'),
        customerId: source,
        orderId: draft.id,
      });
      await fund(source, PRICE + 1_000n);
      await ctx.container.payments.settleFromWallet(tenantA, systemActor('pp'), source, {
        idempotencyKey: key('pp-pay'),
        orderId: confirmed.id as OrderId,
      });
      const pending = await services.findByOrderId(tenantA, confirmed.id);
      expect(pending?.state).toBe('PENDING_PROVISION');
      // Hold that service's row from outside, the way a provisioning refund would. A transfer
      // that waited for it while holding the customer would close a cycle; it must refuse.
      let release!: () => void;
      const gate = new Promise<void>((done) => (release = done));
      let held!: () => void;
      const holding = new Promise<void>((done) => (held = done));
      const holder = ctx.container.database.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM services WHERE id = ${pending!.id} FOR UPDATE`);
        held();
        await gate;
      });
      await holding;
      try {
        const refused = await refusalOf(transfer('0'.repeat(64)));
        expect(refused.code).toBe(COMMERCE_ERROR_CODES.CUSTOMER_TRANSFER_REFUSED);
        expect(refused.details.blockers).toEqual(['SERVICE_UNSETTLED']);
      } finally {
        release();
        await holder;
      }
    });

    it('refuses, never waits for, a movable service another transaction holds', async () => {
      const service = await deliveredService('held');
      const plan = await preview();
      let release!: () => void;
      const gate = new Promise<void>((done) => (release = done));
      let held!: () => void;
      const holding = new Promise<void>((done) => (held = done));
      const holder = ctx.container.database.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM services WHERE id = ${service.id} FOR NO KEY UPDATE`);
        held();
        await gate;
      });
      await holding;
      try {
        const refused = await refusalOf(transfer(plan.fingerprint));
        expect(refused.details.blockers).toEqual(['SERVICE_UNSETTLED']);
      } finally {
        release();
        await holder;
      }
      expect((await services.findById(tenantA, service.id))?.customerId).toBe(source);
      // Released, the same confirmation goes through.
      expect((await transfer(plan.fingerprint)).transfer.serviceIds).toEqual([service.id]);
    });

    it('locks the newer customer first, the referral order, so it never holds the older while waiting', async () => {
      await fund(source, 10_000n);
      const plan = await preview();
      // `destination` registered after `source`: the newer UUIDv7.
      expect(destination > source).toBe(true);
      let release!: () => void;
      const gate = new Promise<void>((done) => (release = done));
      let held!: () => void;
      const holding = new Promise<void>((done) => (held = done));
      const holder = ctx.container.database.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM customers WHERE id = ${destination} FOR UPDATE`);
        held();
        await gate;
      });
      await holding;
      const racing = transfer(plan.fingerprint);
      // Wait until the transfer blocks on the newer customer.
      const deadline = Date.now() + 5_000;
      for (;;) {
        const waiting = await count(
          sql`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
               WHERE NOT l.granted AND a.datname = current_database()`,
        );
        if (waiting > 0) break;
        if (Date.now() > deadline) throw new Error('the transfer never waited');
        await new Promise((done) => setTimeout(done, 25));
      }
      // The older customer is free: the transfer did not take it before the newer one.
      const older = await ctx.container.database.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM customers WHERE id = ${source} FOR UPDATE NOWAIT`);
        return 'free';
      });
      expect(older).toBe('free');
      release();
      await holder;
      expect((await racing).replayed).toBe(false);
    });

    /** Holds `customerId`'s row in another transaction; `then` runs inside it before release. */
    async function holdCustomer(customerId: string) {
      let release!: (
        then?: (tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }) => Promise<void>,
      ) => void;
      const gate = new Promise<
        | ((tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }) => Promise<void>)
        | undefined
      >((done) => (release = done));
      let held!: () => void;
      const holding = new Promise<void>((done) => (held = done));
      const holder = ctx.container.database.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM customers WHERE id = ${customerId} FOR UPDATE`);
        held();
        const then = await gate;
        if (then !== undefined) await then(tx as never);
      });
      await holding;
      return { release, holder };
    }

    async function waitersAtLeast(expected: number) {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const waiting = await count(
          sql`SELECT count(DISTINCT l.pid)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
               WHERE NOT l.granted AND a.datname = current_database()`,
        );
        if (waiting >= expected) return;
        if (Date.now() > deadline) throw new Error('nothing waited');
        await new Promise((done) => setTimeout(done, 25));
      }
    }

    it('answers a concurrent duplicate of one key as its replay, not as a stale preview', async () => {
      await fund(source, 10_000n);
      const plan = await preview();
      const hold = await holdCustomer(destination);
      const first = transfer(plan.fingerprint, { idempotencyKey: 'twice' });
      const second = transfer(plan.fingerprint, { idempotencyKey: 'twice' });
      await waitersAtLeast(2);
      hold.release();
      await hold.holder;
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(results[0].transfer.id).toBe(results[1].transfer.id);
    });

    it('reads the destination again under its lock: a block committed meanwhile refuses', async () => {
      await fund(source, 10_000n);
      const plan = await preview();
      const hold = await holdCustomer(destination);
      const racing = refusalOf(transfer(plan.fingerprint));
      await waitersAtLeast(1);
      hold.release(async (tx) => {
        await tx.execute(
          sql`UPDATE customers SET status = 'BLOCKED', blocked_at = now() WHERE id = ${destination}`,
        );
      });
      await hold.holder;
      const refused = await racing;
      expect(refused.details.blockers).toContain('DESTINATION_BLOCKED');
      expect(await balanceOf(source)).toBe(10_000n);
    });

    it('lets only a Web Admin ownership row omit the bot', async () => {
      const service = await deliveredService('botless');
      const insert = (actorType: string) =>
        ctx.container.database.db.execute(sql`
          INSERT INTO service_ownership_transfers
            (id, tenant_id, service_id, from_customer_id, to_customer_id, bot_instance_id,
             idempotency_key, actor_type, correlation_id)
          VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${service.id}, ${source},
                  ${destination}, NULL, ${key('botless')}, ${actorType}, 'c')`);
      await expect(insert('SYSTEM_JOB')).rejects.toThrow();
      await expect(insert('CUSTOMER')).rejects.toThrow();
      await expect(insert('WEB_ADMIN')).resolves.toBeDefined();
    });

    it('refuses a key reused for another account or another preview', async () => {
      await fund(source, 10_000n);
      const plan = await preview();
      await transfer(plan.fingerprint, { idempotencyKey: 'reused-key' });
      // Same key, a different fingerprint.
      expect(
        (await refusalOf(transfer('c'.repeat(64), { idempotencyKey: 'reused-key' }))).code,
      ).toBe(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID);
      // Same key, another source.
      expect(
        (
          await refusalOf(
            ctx.container.customerAccountTransfers.transfer(tenantA, owner, {
              idempotencyKey: 'reused-key',
              sourceId: destination,
              destinationTelegramUserId: SOURCE_TG,
              fingerprint: plan.fingerprint,
              confirmTelegramUserId: SOURCE_TG,
              reason: 'x',
            }),
          )
        ).code,
      ).toBe(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID);
    });

    it('is the owner’s alone: an operator is refused the preview and the transfer, audited', async () => {
      await fund(source, 10_000n);
      const plan = await preview();
      await expect(preview(operator)).rejects.toMatchObject({
        code: 'platform.permission_denied',
      });
      await expect(transfer(plan.fingerprint, { by: operator })).rejects.toMatchObject({
        code: 'platform.permission_denied',
      });
      expect((await auditOf('customer.account_transfer'))[0]?.result).toBe('DENIED');
      expect(await balanceOf(source)).toBe(10_000n);
    });
  });

  // ===================================================================================
  // §11.6 — the manual order
  // ===================================================================================

  describe('manual order', () => {
    const place = (by: ActorContext, idempotencyKey = key('manual')) =>
      ctx.container.manualOrders.place(tenantA, by, {
        idempotencyKey,
        customerId: source,
        productId,
        username: null,
        reason: 'sold by phone',
      });

    it('places, prices and settles through the customer path, under the operator’s key', async () => {
      await fund(source, PRICE + 1_000n);
      const sales = owner;
      const { order, payment } = await place(sales, 'manual-1');
      expect(order.state).toBe('PAID');
      expect(order.totals.total.amountMinor).toBe(PRICE);
      expect(payment.method).toBe('WALLET');
      expect(await balanceOf(source)).toBe(1_000n);
      const draftAudit = await rows<{ actor_type: string; source_surface: string }>(
        sql`SELECT actor_type, source_surface FROM audit_logs
             WHERE action = 'order.draft_create' AND entity_id = ${order.id}`,
      );
      expect(draftAudit).toEqual([{ actor_type: 'WEB_ADMIN', source_surface: 'WEB' }]);
      // The same key replays: one order, one debit, one manual-order audit row.
      const replay = await place(sales, 'manual-1');
      expect(replay.order.id).toBe(order.id);
      expect(
        await count(sql`SELECT count(*)::int AS n FROM orders WHERE customer_id = ${source}`),
      ).toBe(1);
      expect(await balanceOf(source)).toBe(1_000n);
      expect(await auditOf('customer.manual_order')).toHaveLength(1);
      // The provisioner creates the service as for any paid order.
      await ctx.container.provisionerLoop.tick();
      expect((await services.findByOrderId(tenantA, order.id))?.customerId).toBe(source);
    });

    it('refuses an underfunded wallet and withdraws the order it confirmed', async () => {
      await fund(source, PRICE - 1n);
      expect((await refusalOf(place(owner))).code).toBe(
        COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS,
      );
      const states = await rows<{ state: string }>(
        sql`SELECT state FROM orders WHERE customer_id = ${source}`,
      );
      expect(states).toEqual([{ state: 'CANCELLED' }]);
      expect(await balanceOf(source)).toBe(PRICE - 1n);
      expect(await count(sql`SELECT count(*)::int AS n FROM panel_capacity_reservations`)).toBe(0);
    });

    it('refuses sales, which holds orders.manual.create but may not debit a wallet', async () => {
      await fund(source, PRICE);
      const sales = adminActorFor(
        await createAdmin(ctx.container, tenantA, { username: 'sales-360', roleKeys: ['sales'] }),
      );
      await expect(place(sales)).rejects.toMatchObject({ code: 'platform.permission_denied' });
      expect(await count(sql`SELECT count(*)::int AS n FROM orders`)).toBe(0);
      expect(await balanceOf(source)).toBe(PRICE);
      const denied = await rows<{ result: string }>(
        sql`SELECT result FROM audit_logs WHERE action = 'customer.manual_order'`,
      );
      expect(denied).toEqual([{ result: 'DENIED' }]);
    });

    it('refuses a role without orders.manual.create, before any order exists', async () => {
      await fund(source, PRICE);
      await expect(place(support)).rejects.toMatchObject({ code: 'platform.permission_denied' });
      expect(await count(sql`SELECT count(*)::int AS n FROM orders`)).toBe(0);
    });
  });

  // ===================================================================================
  // §11.4 configurations, §11.7 aggregates and §11.10 timeline
  // ===================================================================================

  describe('configurations, aggregates and the timeline', () => {
    it("plans a suspend for every active service, and a resume once they're suspended", async () => {
      const a = await deliveredService('cfg-a');
      const b = await deliveredService('cfg-b');
      const suspended = await ctx.container.customerServicesToggle.toggle(tenantA, operator, {
        idempotencyKey: 'suspend-all',
        customerId: source,
        action: 'SUSPEND',
      });
      expect(suspended.map((row) => row.outcome)).toEqual(['PLANNED', 'PLANNED']);
      // A replay of the same key plans nothing new and writes no second summary row.
      const again = await ctx.container.customerServicesToggle.toggle(tenantA, operator, {
        idempotencyKey: 'suspend-all',
        customerId: source,
        action: 'SUSPEND',
      });
      expect(again.map((row) => row.outcome)).toEqual(['PLANNED', 'PLANNED']);
      expect(await auditOf('customer.services.suspend_all')).toHaveLength(1);
      await ctx.container.provisionerLoop.tick();
      expect((await services.findById(tenantA, a.id))?.state).toBe('SUSPENDED');
      expect((await services.findById(tenantA, b.id))?.state).toBe('SUSPENDED');
      const resumed = await ctx.container.customerServicesToggle.toggle(tenantA, operator, {
        idempotencyKey: 'resume-all',
        customerId: source,
        action: 'RESUME',
      });
      expect(resumed).toHaveLength(2);
      await ctx.container.provisionerLoop.tick();
      expect((await services.findById(tenantA, a.id))?.state).toBe('ACTIVE');
      // Finance may read customers and may not edit services.
      const finance = adminActorFor(
        await createAdmin(ctx.container, tenantA, { username: 'fin-360', roleKeys: ['finance'] }),
      );
      await expect(
        ctx.container.customerServicesToggle.toggle(tenantA, finance, {
          idempotencyKey: 'suspend-denied',
          customerId: source,
          action: 'SUSPEND',
        }),
      ).rejects.toMatchObject({ code: 'platform.permission_denied' });
    });

    it('sums exactly what the rows hold, hides what the reader may not see, and lists the timeline', async () => {
      await deliveredService('sum-1');
      await fund(source, 3_000n);
      await ctx.container.customerControls.setChannelExemption(tenantA, owner, {
        idempotencyKey: 'tl-exempt',
        customerId: source,
        exempt: true,
        reason: 'timeline',
      });

      const summary = await ctx.container.customerInsights.financialSummary(tenantA, owner, source);
      expect(summary.denied).toEqual([]);
      expect(summary.orders?.purchases).toEqual([{ currency: 'IRT', count: 1, amount: PRICE }]);
      expect(summary.orders?.discounts).toEqual([{ currency: 'IRT', count: 1, amount: 0n }]);
      expect(summary.payments?.confirmed).toEqual([{ currency: 'IRT', count: 1, amount: PRICE }]);
      expect(summary.services?.byState).toEqual([{ state: 'ACTIVE', count: 1 }]);
      const purchase = summary.ledger?.find((row) => row.reason === 'PURCHASE');
      expect(purchase?.total).toBe(PRICE);

      // Support holds neither payments.view nor audit.view.
      const narrow = await ctx.container.customerInsights.financialSummary(
        tenantA,
        support,
        source,
      );
      expect(narrow.payments).toBeNull();
      expect(narrow.denied).toContain('payments.view');
      await expect(
        ctx.container.customerInsights.timeline(tenantA, support, source),
      ).rejects.toMatchObject({ code: 'platform.permission_denied' });

      const timeline = await ctx.container.customerInsights.timeline(tenantA, owner, source);
      const actions = timeline.map((row) => row.action);
      expect(actions).toContain('customer.channel_exemption.grant');
      expect(actions).toContain('wallet.credit');
      expect(
        timeline.find((row) => row.action === 'customer.channel_exemption.grant')?.reason,
      ).toBe('timeline');
      // Newest first.
      expect(actions[0]).toBe('customer.channel_exemption.grant');
    });
  });
});
