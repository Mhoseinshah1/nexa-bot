import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIENCE_ERROR_CODES,
  canonicalAudienceDefinition,
  type ActorContext,
  type AudienceDefinitionInput,
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
import { AudienceFixtures } from './audience-fixtures';

/**
 * The shared audience (round N, `docs/round-n-broadcast-audit.md` §3): every dimension
 * selects exactly who it says, on the database's own facts, inside one tenant — and the same
 * definition at the same instant is the same set, byte for byte.
 */

const DAY = 86_400_000;

describe('the shared audience', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let a: AudienceFixtures;
  let b: AudienceFixtures;
  let now: Date;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-aud', roleKeys: ['owner'] }),
    );
    a = new AudienceFixtures(ctx, tenantA.tenantId as string);
    b = new AudienceFixtures(ctx, tenantB.tenantId as string);
    now = ctx.container.clock.now();
  });

  const def = (input: Partial<AudienceDefinitionInput> = {}): AudienceDefinitionInput => ({
    version: 1,
    ...input,
  });

  /** The ids the definition selects, sorted — the set, not only its size. */
  async function members(input: Partial<AudienceDefinitionInput>): Promise<string[]> {
    const { sql } = await import('drizzle-orm');
    const { audienceCustomersQuery } =
      await import('../../apps/api/src/modules/commerce/audience/infrastructure/audience-sql');
    const result = await ctx.container.database.db.execute<{ customer_id: string }>(
      sql`SELECT a.customer_id FROM (${audienceCustomersQuery({
        tenantId: tenantA.tenantId as string,
        definition: canonicalAudienceDefinition(def(input)),
        asOf: now,
      })}) a ORDER BY a.customer_id`,
    );
    return result.rows.map((row) => row.customer_id);
  }

  const sorted = (...ids: string[]) => [...ids].sort();

  it('keeps Mirza’s two VERIFIED dimensions: tier and purchase history, combinable', async () => {
    const panel = await a.panel();
    const ordinaryBuyer = await a.customer({
      telegramUserId: '1001',
      botInstanceId: SEED_IDS.botA1,
    });
    const ordinaryNever = await a.customer({
      telegramUserId: '1002',
      botInstanceId: SEED_IDS.botA1,
    });
    const goldBuyer = await a.customer({ telegramUserId: '1003', botInstanceId: SEED_IDS.botA1 });
    const suspendedReseller = await a.customer({ telegramUserId: '1004' });
    const gold = await a.tier('gold');
    const silver = await a.tier('silver');
    await a.reseller(goldBuyer, gold);
    // A SUSPENDED reseller is an ordinary customer (CLAUDE.md).
    await a.reseller(suspendedReseller, silver, 'SUSPENDED');
    await a.order({ customerId: ordinaryBuyer, panelId: panel });
    await a.order({ customerId: goldBuyer, panelId: panel });
    // Neither a trial, nor a refunded order, nor an unpaid one is a purchase.
    await a.trialGrant(ordinaryNever, panel);
    await a.order({ customerId: ordinaryNever, panelId: panel, state: 'REFUNDED' });
    await a.order({ customerId: ordinaryNever, panelId: panel, state: 'AWAITING_PAYMENT' });

    expect(await members({})).toEqual(
      sorted(ordinaryBuyer, ordinaryNever, goldBuyer, suspendedReseller),
    );
    expect(await members({ segment: { ordinary: true, resellerTierIds: [] } })).toEqual(
      sorted(ordinaryBuyer, ordinaryNever, suspendedReseller),
    );
    expect(await members({ segment: { ordinary: false, resellerTierIds: [gold] } })).toEqual([
      goldBuyer,
    ]);
    expect(await members({ segment: { ordinary: false, resellerTierIds: [silver] } })).toEqual([]);
    expect(await members({ purchase: 'PURCHASED' })).toEqual(sorted(ordinaryBuyer, goldBuyer));
    expect(await members({ purchase: 'NEVER_PURCHASED' })).toEqual(
      sorted(ordinaryNever, suspendedReseller),
    );
    expect(
      await members({ segment: { ordinary: true, resellerTierIds: [] }, purchase: 'PURCHASED' }),
    ).toEqual([ordinaryBuyer]);
  });

  it('selects on status, registration, account age, last purchase and lapse', async () => {
    const panel = await a.panel();
    const old = await a.customer({
      telegramUserId: '2001',
      firstSeenAt: new Date(now.getTime() - 400 * DAY),
    });
    const recent = await a.customer({
      telegramUserId: '2002',
      firstSeenAt: new Date(now.getTime() - 5 * DAY),
    });
    const blocked = await a.customer({
      telegramUserId: '2003',
      status: 'BLOCKED',
      firstSeenAt: new Date(now.getTime() - 5 * DAY),
    });
    await a.order({
      customerId: old,
      panelId: panel,
      settledAt: new Date(now.getTime() - 90 * DAY),
    });
    await a.order({ customerId: recent, panelId: panel, settledAt: new Date(now.getTime() - DAY) });

    // ACTIVE is the default; BLOCKED and ANY are explicit.
    expect(await members({})).toEqual(sorted(old, recent));
    expect(await members({ customerStatus: 'BLOCKED' })).toEqual([blocked]);
    expect(await members({ customerStatus: 'ANY' })).toEqual(sorted(old, recent, blocked));

    const tenDaysAgo = new Date(now.getTime() - 10 * DAY).toISOString();
    expect(await members({ registeredFrom: tenDaysAgo })).toEqual([recent]);
    expect(await members({ registeredBefore: tenDaysAgo })).toEqual([old]);
    expect(await members({ accountAgeMinDays: 30 })).toEqual([old]);
    expect(await members({ accountAgeMaxDays: 5 })).toEqual([recent]);

    expect(await members({ lastPurchaseFrom: tenDaysAgo })).toEqual([recent]);
    expect(await members({ lastPurchaseBefore: tenDaysAgo })).toEqual([old]);
    // No purchase in the last 30 days: the lapsed buyer (and a never-buyer would count too).
    expect(await members({ noPurchaseForDays: 30 })).toEqual([old]);
    expect(await members({ noPurchaseForDays: 30, purchase: 'PURCHASED' })).toEqual([old]);
  });

  it('selects on a ledger-derived wallet balance, trial use and referral part', async () => {
    const panel = await a.panel();
    const rich = await a.customer({ telegramUserId: '3001' });
    const poor = await a.customer({ telegramUserId: '3002' });
    const referred = await a.customer({ telegramUserId: '3003' });
    await a.walletEntry(rich, 'CREDIT', 500_000n);
    await a.walletEntry(rich, 'DEBIT', 100_000n);
    // A balance in another currency is not this range's money.
    await a.walletEntry(poor, 'CREDIT', 900_000n, 'IRR');
    await a.trialGrant(poor, panel);
    await a.referral(rich, referred);

    expect(
      await members({ walletBalance: { currency: 'IRT', minMinor: '400000', maxMinor: null } }),
    ).toEqual([rich]);
    expect(
      await members({ walletBalance: { currency: 'IRT', minMinor: null, maxMinor: '0' } }),
    ).toEqual(sorted(poor, referred));
    expect(await members({ trial: 'USED' })).toEqual([poor]);
    expect(await members({ trial: 'NOT_USED' })).toEqual(sorted(rich, referred));
    expect(await members({ referral: 'REFERRER' })).toEqual([rich]);
    expect(await members({ referral: 'REFERRED' })).toEqual([referred]);
    expect(await members({ referral: 'PARTICIPANT' })).toEqual(sorted(rich, referred));
    expect(await members({ referral: 'NON_PARTICIPANT' })).toEqual([poor]);
  });

  it('selects on one service matching product, panel, state and expiry together', async () => {
    const panelX = await a.panel('x');
    const panelY = await a.panel('y');
    const productX = await a.product(panelX);
    const onX = await a.customer({ telegramUserId: '4001' });
    const onYExpiring = await a.customer({ telegramUserId: '4002' });
    const expired = await a.customer({ telegramUserId: '4003' });
    const none = await a.customer({ telegramUserId: '4004' });
    await a.service({ customerId: onX, panelId: panelX, productId: productX });
    await a.service({
      customerId: onYExpiring,
      panelId: panelY,
      expiresAt: new Date(now.getTime() + 20 * 3_600_000),
    });
    await a.service({ customerId: expired, panelId: panelY, state: 'EXPIRED' });

    expect(await members({ service: {} })).toEqual(sorted(onX, onYExpiring, expired));
    expect(await members({ service: { productIds: [productX] } })).toEqual([onX]);
    expect(await members({ service: { panelIds: [panelY] } })).toEqual(
      sorted(onYExpiring, expired),
    );
    expect(await members({ service: { expiringWithinHours: 24 } })).toEqual([onYExpiring]);
    expect(await members({ service: { expiringWithinHours: 12 } })).toEqual([]);
    expect(await members({ service: { expired: true } })).toEqual([expired]);
    // Product AND panel must be true of the SAME service.
    expect(await members({ service: { productIds: [productX], panelIds: [panelY] } })).toEqual([]);
    expect(await members({ service: { states: ['EXPIRED'] } })).toEqual([expired]);
    expect(none).toBeDefined();
  });

  it('never reaches another tenant, not even through an id an operator typed', async () => {
    const mine = await a.customer({ telegramUserId: '5001' });
    const theirs = await b.customer({ telegramUserId: '5001' });
    const theirTier = await b.tier('gold');
    await b.reseller(theirs, theirTier);
    expect(await members({})).toEqual([mine]);
    expect(await members({ customerIds: [theirs] })).toEqual([]);
    expect(await members({ segment: { ordinary: false, resellerTierIds: [theirTier] } })).toEqual(
      [],
    );
  });

  it('previews a count, the reachable part, the set’s fingerprint and a sample', async () => {
    const withBot = await a.customer({
      telegramUserId: '6001',
      botInstanceId: SEED_IDS.botA1,
      firstName: 'Sara',
    });
    await a.customer({ telegramUserId: '6002' });
    const preview = await ctx.container.audience.preview(tenantA, owner, def({}));
    expect(preview.customers).toBe(2);
    expect(preview.reachable).toBe(1);
    expect(preview.fingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(preview.sample.map((row) => row.id)).toContain(withBot);

    // The same definition, spelled differently, is the same definition.
    const again = await ctx.container.audience.preview(tenantA, owner, {
      purchase: 'ANY',
      version: 1,
      customerStatus: 'ACTIVE',
    });
    expect(again.definitionHash).toBe(preview.definitionHash);
    expect(again.fingerprint).toBe(preview.fingerprint);
  });

  it('refuses an invalid definition with its own code, and a reader without users.view', async () => {
    await expect(
      ctx.container.audience.preview(tenantA, owner, { version: 1, purchase: 'SOMETIMES' }),
    ).rejects.toMatchObject({ code: AUDIENCE_ERROR_CODES.DEFINITION_INVALID });
    const technical = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'tech-aud', roleKeys: ['technical'] }),
    );
    await expect(ctx.container.audience.preview(tenantA, technical, def())).rejects.toMatchObject({
      kind: 'PERMISSION_DENIED',
    });
  });
});
