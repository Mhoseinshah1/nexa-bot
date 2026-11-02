import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
  type BotInstanceId,
  type Clock,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type ResellerStatus,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleCustomerNotificationRepository } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-customer-notification.repository';
import { CustomerNotifier } from '../../apps/api/src/modules/commerce/messaging/application/customer-notifier';
import { ResellerExpiryService } from '../../apps/api/src/modules/commerce/resellers/application/reseller-expiry.service';
import { DrizzleResellerRepository } from '../../apps/api/src/modules/commerce/resellers/infrastructure/drizzle-reseller.repository';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Round 11, C2: the reseller expiry date, end to end at the service boundary over real
 * PostgreSQL. The expiry lives on the reseller's own row (a tier is shared; expiring it
 * would suspend everyone in it). Suspension is a conditional UPDATE by a SYSTEM_JOB sweep;
 * it moves no money; only a suspension MADE BY the expiry is lifted by setting a later date.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const viaBot: TenantContext = { ...tenantA, botInstanceId: BOT_A };
const HOUR = 3_600_000;

const customerActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

const EVERYTHING = [
  { kind: 'OPERATION', subject: null },
  { kind: 'PRODUCT', subject: null },
  { kind: 'PANEL', subject: null },
  { kind: 'BOT', subject: null },
] as const;

describe('reseller expiry (round 11, C2)', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let owner: ActorContext;
  let tierId: string;
  let resellerOne: UserId;
  let resellerTwo: UserId;
  let n = 0;
  const key = (): string => `r11-c2-key-${(n += 1)}`;
  const at = (ms: number): Clock => ({ now: () => new Date(ms) });
  const nowMs = (): number => ctx.container.clock.now().getTime();

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    products = new DrizzleProductRepository(ctx.container.database.db);
    const panel = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panel}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, panel);
    panelId = panel;
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-expiry', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.resellersAdmin.createTier(tenantA, owner, {
      idempotencyKey: key(),
      write: {
        name: 'Gold',
        pricingMode: 'PERCENTAGE_DISCOUNT',
        discountPercentage: 20,
        creditLimit: money(0n, 'IRT'),
      },
    });
    tierId = created.id;
    await ctx.container.resellersAdmin.replaceGrants(tenantA, owner, {
      idempotencyKey: key(),
      tierId,
      grants: EVERYTHING,
    });
    resellerOne = await customer('970001');
    resellerTwo = await customer('970002');
    await register(resellerOne);
    await register(resellerTwo);
  });

  let panelId = '';

  // ---- fixtures ---------------------------------------------------------------------

  async function customer(telegramUserId: string): Promise<UserId> {
    const { customer: record } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      customerActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'سارا' },
        botInstanceId: BOT_A,
      },
    );
    return record.id;
  }

  const register = (customerId: UserId) =>
    ctx.container.resellersAdmin.register(tenantA, owner, {
      idempotencyKey: key(),
      customerId,
      write: { tierId, pricingMode: 'TIER', discountPercentage: null, creditLimit: null },
    });

  async function product(price: bigint): Promise<ProductId> {
    const created = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن فروشنده',
        description: 'یک ماهه',
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(price, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return created.id;
  }

  /** What the customer is quoted for a product right now: the confirmed order's total. */
  async function quote(customerId: UserId, productId: string): Promise<bigint> {
    const order = await ctx.container.orders.createDraft(viaBot, customerActor(key()), {
      idempotencyKey: key(),
      customerId,
      productId,
    });
    const confirmed = await ctx.container.orders.confirm(viaBot, customerActor(key()), {
      idempotencyKey: key(),
      customerId,
      orderId: order.id,
    });
    return confirmed.totals.total.amountMinor;
  }

  const setExpiry = (customerId: UserId, expiresAtMs: number | null, actor = owner) =>
    ctx.container.resellersAdmin.setExpiry(tenantA, actor, {
      idempotencyKey: key(),
      customerId,
      expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs),
    });

  async function setStatus(customerId: UserId, status: ResellerStatus): Promise<void> {
    const current = await ctx.container.resellersAdmin.get(tenantA, owner, customerId);
    await ctx.container.resellersAdmin.update(tenantA, owner, {
      idempotencyKey: key(),
      customerId,
      write: {
        tierId: current.tierId,
        status,
        pricingMode: current.pricingMode,
        discountPercentage: current.discountPercentage,
        creditLimit: null,
      },
    });
  }

  /** The sweep with the test's clock; everything else is the production class. */
  function sweep(clock: Clock, scope: TenantContext = tenantA, batch?: number) {
    const db = ctx.container.database.db;
    return new ResellerExpiryService({
      resellers: new DrizzleResellerRepository(db),
      notifier: new CustomerNotifier({
        notifications: new DrizzleCustomerNotificationRepository(db),
        bots: { botFor: async () => BOT_A },
        ids: ctx.container.ids,
      }),
      audit: ctx.container.audit,
      outbox: ctx.container.outbox,
      scopeActivity: ctx.container.tenants,
      uow: ctx.container.uow,
      clock,
      ids: ctx.container.ids,
      ...(batch === undefined ? {} : { batch }),
    }).runOnce(scope);
  }

  async function rows<T>(query: SQL): Promise<T[]> {
    return (await ctx.container.database.db.execute(query)).rows as T[];
  }
  const count = async (query: SQL): Promise<number> =>
    (await rows<{ n: number }>(query))[0]?.n ?? 0;
  const status = async (customerId: UserId): Promise<ResellerStatus> =>
    (await ctx.container.resellersAdmin.get(tenantA, owner, customerId)).status;
  const notices = () =>
    count(
      sql`SELECT count(*)::int AS n FROM customer_notifications WHERE kind = 'RESELLER_EXPIRED'`,
    );
  const ledgerRows = () => count(sql`SELECT count(*)::int AS n FROM wallet_entries`);
  const expiredAudits = () =>
    count(sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'reseller.expired'`);
  const standingEvents = (change: string) =>
    count(sql`SELECT count(*)::int AS n FROM outbox_messages
               WHERE event_type = 'ResellerStandingChanged' AND payload->>'change' = ${change}`);

  // ---- the rule ---------------------------------------------------------------------

  it('suspends an expired reseller: ops-log event, audit, one notice, normal price, no ledger row', async () => {
    const listed = await product(100_000n);
    expect(await quote(resellerOne, listed), 'an active reseller is discounted').toBe(80_000n);
    await setExpiry(resellerOne, nowMs() + HOUR);
    const ledgerBefore = await ledgerRows();

    expect(await sweep(at(nowMs() + 2 * HOUR))).toBe(1);

    expect(await status(resellerOne)).toBe('SUSPENDED');
    expect(await standingEvents('SUSPENDED')).toBe(1);
    expect(await expiredAudits()).toBe(1);
    const [audit] = await rows<{ actor_type: string; reason: string }>(
      sql`SELECT actor_type, reason FROM audit_logs WHERE action = 'reseller.expired'`,
    );
    expect(audit?.actor_type).toBe('SYSTEM_JOB');
    expect(await notices()).toBe(1);
    expect(
      await quote(resellerOne, await product(100_000n)),
      'a suspended-by-expiry reseller is an ordinary customer',
    ).toBe(100_000n);
    expect(await ledgerRows(), 'suspension writes no ledger entry').toBe(ledgerBefore);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM wallet_entries WHERE customer_id = ${resellerOne}`,
      ),
    ).toBe(0);
  });

  it('leaves a reseller whose date has not passed untouched', async () => {
    await setExpiry(resellerOne, nowMs() + 3 * HOUR);
    expect(await sweep(at(nowMs() + HOUR))).toBe(0);
    expect(await status(resellerOne)).toBe('ACTIVE');
    expect(await notices()).toBe(0);
    expect(await expiredAudits()).toBe(0);
  });

  it('treats the instant of expiry as expired (expires_at <= now)', async () => {
    const date = nowMs() + HOUR;
    await setExpiry(resellerOne, date);
    expect(await sweep(at(date - 1))).toBe(0);
    expect(await sweep(at(date))).toBe(1);
  });

  it('leaves a reseller with no expiry untouched, however late the clock', async () => {
    expect(await sweep(at(nowMs() + 400 * 24 * HOUR))).toBe(0);
    expect(await status(resellerOne)).toBe('ACTIVE');
    expect(await notices()).toBe(0);
  });

  it('is idempotent: a re-run suspends nothing twice and sends one notice', async () => {
    await setExpiry(resellerOne, nowMs() + HOUR);
    const later = at(nowMs() + 2 * HOUR);
    expect(await sweep(later)).toBe(1);
    expect(await sweep(later)).toBe(0);
    expect(await sweep(at(nowMs() + 9 * HOUR))).toBe(0);
    expect(await notices()).toBe(1);
    expect(await expiredAudits()).toBe(1);
    expect(await standingEvents('SUSPENDED')).toBe(1);
  });

  it('does nothing once the tenant has stopped accepting work', async () => {
    await setExpiry(resellerOne, nowMs() + HOUR);
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`,
    );
    expect(await sweep(at(nowMs() + 2 * HOUR))).toBe(0);
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${tenantA.tenantId}`,
    );
    expect(await status(resellerOne)).toBe('ACTIVE');
    expect(await notices()).toBe(0);
  });

  it('keeps two resellers apart: only the expired one is suspended, and another tenant is never read', async () => {
    await setExpiry(resellerOne, nowMs() + HOUR);
    await setExpiry(resellerTwo, nowMs() + 5 * HOUR);
    expect(await sweep(at(nowMs() + 2 * HOUR))).toBe(1);
    expect(await status(resellerOne)).toBe('SUSPENDED');
    expect(await status(resellerTwo)).toBe('ACTIVE');
    // The sweep for the other tenant touches none of tenant A's rows.
    await setExpiry(resellerTwo, nowMs() + 6 * HOUR);
    expect(await sweep(at(nowMs() + 24 * HOUR), tenantB)).toBe(0);
    expect(await status(resellerTwo)).toBe('ACTIVE');
  });

  it('works through a backlog bigger than one batch', async () => {
    await setExpiry(resellerOne, nowMs() + HOUR);
    await setExpiry(resellerTwo, nowMs() + HOUR);
    expect(await sweep(at(nowMs() + 2 * HOUR), tenantA, 1)).toBe(2);
    expect(await notices()).toBe(2);
  });

  // ---- extend, and the concurrency with the sweep ------------------------------------

  it('re-activates a reseller the EXPIRY suspended when a later date is set, with no message and no ledger row', async () => {
    await setExpiry(resellerOne, nowMs() + HOUR);
    await sweep(at(nowMs() + 2 * HOUR));
    const ledgerBefore = await ledgerRows();

    const extended = await setExpiry(resellerOne, nowMs() + 48 * HOUR);

    expect(extended.status).toBe('ACTIVE');
    expect(extended.expirySuspendedAt).toBeNull();
    expect(await standingEvents('REACTIVATED')).toBe(1);
    expect(await notices(), 'extending sends nothing').toBe(1);
    expect(await ledgerRows()).toBe(ledgerBefore);
    expect(await quote(resellerOne, await product(100_000n))).toBe(80_000n);
  });

  it('never re-activates an administrator’s suspension by changing the date', async () => {
    await setExpiry(resellerOne, nowMs() + 10 * HOUR);
    await setStatus(resellerOne, 'SUSPENDED');
    const changed = await setExpiry(resellerOne, nowMs() + 48 * HOUR);
    expect(changed.status).toBe('SUSPENDED');
    expect(changed.expiresAt?.getTime()).toBeGreaterThan(nowMs() + 47 * HOUR);
    expect(await standingEvents('REACTIVATED')).toBe(0);
  });

  it('forgets “suspended by expiry” once an administrator takes over the standing', async () => {
    await setExpiry(resellerOne, nowMs() + HOUR);
    await sweep(at(nowMs() + 2 * HOUR));
    // The administrator clears the date, re-activates by hand, then suspends by hand.
    await setExpiry(resellerOne, null);
    await setStatus(resellerOne, 'ACTIVE');
    await setStatus(resellerOne, 'SUSPENDED');
    const later = await setExpiry(resellerOne, nowMs() + 48 * HOUR);
    expect(later.status, 'a manual suspension is not the expiry’s').toBe('SUSPENDED');
  });

  it('clearing the date never re-activates, and an expired reseller cannot be re-activated by hand until the date is moved', async () => {
    await setExpiry(resellerOne, nowMs() + HOUR);
    await sweep(at(nowMs() + 2 * HOUR));
    const cleared = await setExpiry(resellerOne, null);
    expect(cleared.status).toBe('SUSPENDED');
    expect(cleared.expiresAt).toBeNull();

    // Back to an expired date (as the sweep left it), then a manual ACTIVE is refused.
    await ctx.container.database.db.execute(sql`
      UPDATE resellers SET expires_at = now() - interval '1 hour'
       WHERE customer_id = ${resellerOne}`);
    await expect(setStatus(resellerOne, 'ACTIVE')).rejects.toMatchObject({ kind: 'CONFLICT' });
    expect(await status(resellerOne)).toBe('SUSPENDED');
  });

  it('an extension that holds the row wins over the sweep, and the sweep then finds nothing', async () => {
    await setExpiry(resellerOne, nowMs() + HOUR);
    const db = ctx.container.database.db;
    let swept = -1;
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE resellers SET expires_at = now() + interval '30 days'
         WHERE customer_id = ${resellerOne}`);
      // The sweep runs while the extension is uncommitted: it must neither wait for it nor
      // suspend the row.
      swept = await sweep(at(nowMs() + 2 * HOUR));
    });
    expect(swept).toBe(0);
    expect(await sweep(at(nowMs() + 2 * HOUR))).toBe(0);
    expect(await status(resellerOne)).toBe('ACTIVE');
    expect(await notices()).toBe(0);
  });

  it('a sweep that commits first is undone cleanly by the extension that follows', async () => {
    await setExpiry(resellerOne, nowMs() + HOUR);
    expect(await sweep(at(nowMs() + 2 * HOUR))).toBe(1);
    await setExpiry(resellerOne, nowMs() + 72 * HOUR);
    expect(await status(resellerOne)).toBe('ACTIVE');
    // The new date passes: suspended and told again, once more.
    expect(await sweep(at(nowMs() + 100 * HOUR))).toBe(1);
    expect(await notices()).toBe(2);
    expect(await expiredAudits()).toBe(2);
  });

  // ---- the Web Admin command ---------------------------------------------------------

  it('refuses a date that is not in the future, and a write without resellers.edit (audited)', async () => {
    await expect(setExpiry(resellerOne, nowMs() - HOUR)).rejects.toMatchObject({
      kind: 'CONFLICT',
    });
    const finance = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'finance-expiry',
        roleKeys: ['finance'],
      }),
    );
    await expect(setExpiry(resellerOne, nowMs() + HOUR, finance)).rejects.toMatchObject({
      kind: 'PERMISSION_DENIED',
    });
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'reseller.expiry' AND result <> 'SUCCESS'`,
      ),
    ).toBe(1);
    expect(
      (await ctx.container.resellersAdmin.get(tenantA, owner, resellerOne)).expiresAt,
    ).toBeNull();
  });

  it('audits a set and a clear, and replays the same idempotency key without a second write', async () => {
    const date = new Date(nowMs() + 6 * HOUR);
    const input = { idempotencyKey: key(), customerId: resellerOne, expiresAt: date };
    await ctx.container.resellersAdmin.setExpiry(tenantA, owner, input);
    await ctx.container.resellersAdmin.setExpiry(tenantA, owner, input);
    await setExpiry(resellerOne, null);
    expect(
      await count(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'reseller.expiry' AND result = 'SUCCESS'`,
      ),
    ).toBe(2);
    await expect(
      ctx.container.resellersAdmin.setExpiry(tenantA, owner, {
        ...input,
        expiresAt: new Date(date.getTime() + HOUR),
      }),
    ).rejects.toBeTruthy();
  });
});
