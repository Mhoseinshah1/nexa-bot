import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  systemJobActor,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { exactMatchHolds } from '../../apps/api/src/modules/platform/legacy-materialize/application/ports';
import type { MaterializeContext } from '../../apps/api/src/modules/platform/legacy-materialize/application/ports';
import type { HistoryRecordSource } from '../../apps/api/src/modules/platform/legacy-history/application/ports';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  makePanelSellable,
  tenantA,
  type TestContext,
} from './harness';

/**
 * The one-time Mirza import — products, resellers and discount codes — end to end against
 * PostgreSQL. Records are shaped like the converter's, go through the real history ingest, and
 * are then materialised by the catalogue steps. SYNTHETIC values only.
 *
 * What is pinned, each by a case that fails when its rule is reverted:
 * - a product is ACTIVE only when its panel is bound to a NEXA panel (and it can be sold);
 * - a reseller's wallet is Mirza's `Balance` and nothing else — `maxbuyagent` is a visible
 *   LIMIT that is never a balance, never a credit line, and never lets a purchase through;
 * - a discount code is never ACTIVE, and a code that does not fit NEXA's shape is normalised
 *   with its original text kept;
 * - a rerun writes nothing; nothing is triggered (no outbox, notification, provisioning, ledger
 *   row); the exact-match rows hold.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const PACKAGE_IMPORT_ID = 'synthetic-catalog-0001';
const TG_N = '7100000001'; // agent n, discount 20 %, cap, balance 0
const TG_N2 = '7100000002'; // agent n2, tier prices, 100 % discount (not applied)
const TG_GHOST = '7100000003'; // agent whose customer was never imported
const TG_FORK = '7100000004'; // agent_manage owner, not in the user table
const TG_BUYER = '7100000005'; // an ordinary customer
const IRT = 'IRT';

type Rec = Record<string, unknown>;

const flagsOff = {
  affects_wallet: false,
  applies_to_live_state: false,
  grants_credit: false,
  activates_role: false,
  redeemable: false,
  auto_create: false,
};

function memorySource(files: Readonly<Record<string, readonly Rec[]>>): HistoryRecordSource {
  return {
    files: () => Object.keys(files).map((path) => ({ path })),
    has: (rel) => Object.hasOwn(files, rel),
    async *iterJsonl(rel) {
      for (const record of files[rel] ?? []) yield record;
    },
  };
}

const GIB = 1024n ** 3n;

function proposal(n: number, over: Rec = {}, conv: Rec = {}): Rec {
  return {
    record_type: 'legacy_product_mapping_proposal',
    schema: 'm2n.product_mapping_proposal.v1',
    idempotency_key: `legacy:product-proposal:${n}`,
    legacy_product_id: String(n),
    code_product: `p${n}`,
    title_proposal: `Plan ${n}`,
    conversions: {
      traffic: {
        raw: '10',
        unit: 'GiB',
        note: 'OK',
        proposed_traffic_bytes: String(10n * GIB),
      },
      duration: { raw: '30', unit: 'days', note: 'OK', proposed_duration_days: 30 },
      price: { raw: '150000', parse_note: 'OK', amount_minor: String(150_000 + n), currency: IRT },
      agent_tier: { raw: 'f', normalized: 'CUSTOMER', proposed_audience: 'EVERYONE' },
      panel_scope: { kind: 'PANEL_NAME', resolved_code_panels: ['bac6'], state: 'RESOLVED' },
      category: { raw: 'Gold', matches_category_table: true },
      sale_status: { raw: 'active', read: true },
      ...conv,
    },
    ...flagsOff,
    sellable: false,
    ...over,
  };
}

const category = (n: number, label: string | null): Rec => ({
  record_type: 'legacy_category',
  schema: 'mirza.category.v1',
  idempotency_key: `legacy:category:${n}`,
  legacy_id: String(n),
  label,
  ...flagsOff,
});

const customerRef = (tg: string, valid = true): Rec => ({
  raw_id: tg,
  telegram_user_id: tg,
  decision: valid ? 'IMPORT' : 'NOT_IN_BACKUP',
  valid,
});

function profile(tg: string, tier: string, valid = true): Rec {
  return {
    record_type: 'legacy_agent_profile',
    schema: 'm2n.agents.profile.v1',
    idempotency_key: `legacy:agents:profile:${tg}`,
    customer: customerRef(tg, valid),
    tier,
    status: 'ARCHIVED_NOT_ACTIVATED',
    limits_and_credit: 'RAW_ONLY_NOT_APPLIED',
    ...flagsOff,
  };
}

function state(tg: string, over: { cap?: string | null; percent?: string | null } = {}): Rec {
  return {
    record_type: 'legacy_agent_state',
    schema: 'm2n.agents.state.v1',
    idempotency_key: `legacy:agents:state:${tg}`,
    customer: customerRef(tg),
    credit_debt: {
      overdraft_limit_raw: over.cap ?? null,
      overdraft_limit_staged: over.cap !== undefined,
      credit_granted: false,
      values: 'RAW_ONLY_NOT_APPLIED',
    },
    pricing: {
      percent_discount_raw: over.percent ?? null,
      percent_discount_staged: over.percent !== undefined,
      applies_price: false,
    },
    current_status: { agent_expiry: null, agent_expiry_raw: null, agent_expiry_note: 'NO_EXPIRY' },
    role_active: false,
    ...flagsOff,
  };
}

const priceLevel = (tg: string, index: number): Rec => ({
  record_type: 'legacy_agent_price_level',
  schema: 'm2n.agents.price_level.v1',
  idempotency_key: `legacy:agents:price:${tg}:${index}`,
  owner: customerRef(tg),
  owner_value_raw: tg,
  level_index: index,
  levels_for_owner: 2,
  fields_raw: { price: String(90_000 * index) },
  price_semantics: 'UNKNOWN',
  applies_price: false,
  ...flagsOff,
});

function discount(
  n: number,
  kind: 'PURCHASE_PERCENT_CODE' | 'GIFT_BALANCE_CODE' | 'UNKNOWN',
  over: Rec = {},
): Rec {
  return {
    record_type: 'legacy_discount_code',
    schema: 'm2n.engagement.discount.v1',
    idempotency_key: `legacy:engagement:discount:${n}`,
    kind,
    code_ref: `code:${String(n).padStart(24, '0')}`,
    code_text: `Offer${n}`,
    percent: 25,
    limit_total: 10,
    used_count: 3,
    scope: { type: 'all', first_purchase_only_raw: '0', per_user_limit_raw: '1' },
    expires_at: '2027-01-01T00:00:00Z',
    state: 'UNUSED',
    lifecycle_state: 'ACTIVE_UNUSED',
    ...flagsOff,
    ...over,
  };
}

describe('the one-time Mirza import: products, resellers and discount codes', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  let nxpkgImportId: string;
  let panelA: string;
  let buyer: UserId;
  let agentN: UserId;
  let agentN2: UserId;
  const job = systemJobActor('legacy-migration:catalog', 'corr-catalog' as CorrelationId);
  const db = () => ctx.container.database.db;
  const steps = () => ctx.container.legacyMaterializeCatalog;
  let customerByTg: Map<string, string>;

  const mctx = (): MaterializeContext => ({
    scope: tenantA,
    actor: job,
    packageImportId: nxpkgImportId,
    sourceFingerprint: 'f'.repeat(64),
    now: new Date('2026-10-17T10:00:00Z'),
  });

  async function rows<T>(query: SQL): Promise<T[]> {
    return ((await db().execute(query as never)) as unknown as { rows: T[] }).rows;
  }
  const count = async (table: string): Promise<number> =>
    Number(
      (await rows<{ n: string }>(sql`SELECT count(*)::text AS n FROM ${sql.raw(table)}`))[0]?.n,
    );
  const balance = async (customerId: string): Promise<bigint> =>
    BigInt(
      (
        await rows<{ b: string }>(
          sql`SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS b
                FROM wallet_entries WHERE customer_id = ${customerId} AND currency = 'IRT'`,
        )
      )[0]?.b ?? '0',
    );

  async function newCustomer(tg: string): Promise<UserId> {
    const { customer } = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      {
        type: 'SYSTEM_JOB',
        id: null,
        label: 'telegram-update:test',
        surface: 'TELEGRAM',
        correlationId: `r-${tg}` as CorrelationId,
      },
      {
        idempotencyKey: `resolve-${tg}`,
        telegramUserId: tg,
        from: { id: Number(tg), first_name: 'synthetic' },
        botInstanceId: BOT_A,
      },
    );
    return customer.id;
  }

  async function ingest(files: Record<string, Rec[]>): Promise<void> {
    await ctx.container.legacyHistoryIngest.ingest(tenantA, job, {
      nxpkgImportId,
      packageImportId: PACKAGE_IMPORT_ID,
      source: memorySource(files),
      customerIdByTelegram: (ids) =>
        new Map(ids.flatMap((id) => (customerByTg.has(id) ? [[id, customerByTg.get(id)!]] : []))),
    });
  }

  /** The standard package: 7 products, 4 categories, 4 agents (+1 fork owner), 4 codes. */
  const standard = (): Record<string, Rec[]> => ({
    'records/product_mapping_proposal.jsonl': [
      proposal(1), // ACTIVE: bound panel, price, category
      proposal(
        2,
        {},
        { panel_scope: { kind: 'PANEL_NAME', resolved_code_panels: ['zz9'], state: 'RESOLVED' } },
      ), // panel not bound
      proposal(
        3,
        {},
        { panel_scope: { kind: 'ALL_PANELS', resolved_code_panels: ['bac6'], state: 'RESOLVED' } },
      ),
      proposal(
        4,
        {},
        { agent_tier: { raw: 'n', normalized: 'RESELLER', proposed_audience: 'RESELLERS_ONLY' } },
      ),
      proposal(5, {}, { sale_status: { raw: 'disable', read: true } }),
      proposal(
        6,
        {},
        { traffic: { raw: 'x', note: 'NOT_A_NUMBER', proposed_traffic_bytes: null } },
      ), // gap
      proposal(7, {}, { category: { raw: ' gold ' } }), // matches Gold by name
    ],
    'records/category_catalogue.jsonl': [
      category(1, 'Gold'),
      category(2, 'Silver'),
      category(3, ' gold'),
      category(4, null),
    ],
    'records/agents/profiles.jsonl': [
      profile(TG_N, 'n'),
      profile(TG_N2, 'n2'),
      profile(TG_GHOST, 'n', false),
      profile(TG_FORK, 'NOT_AGENT_IN_USER_TABLE'),
    ],
    'records/agents/state.jsonl': [
      state(TG_N, { cap: '5000000', percent: '20' }),
      state(TG_N2, { cap: null, percent: '100' }),
      state(TG_GHOST),
      state(TG_FORK),
    ],
    'records/agents/tier_prices.jsonl': [
      priceLevel(TG_N2, 1),
      priceLevel(TG_N2, 2),
      priceLevel(TG_GHOST, 1),
    ],
    'records/engagement/discounts.jsonl': [
      discount(1, 'PURCHASE_PERCENT_CODE'),
      discount(2, 'PURCHASE_PERCENT_CODE', { code_text: 'سلام ✓ welcome-2026!' }),
      discount(3, 'PURCHASE_PERCENT_CODE', { code_text: 'offer1' }), // collides with Offer1
      discount(4, 'GIFT_BALANCE_CODE', {
        code_text: 'GIFT4',
        percent: null,
        credit_amount: { amount_minor: '50000', currency: IRT },
      }),
      discount(5, 'PURCHASE_PERCENT_CODE', { percent: null }), // gap
      discount(6, 'PURCHASE_PERCENT_CODE', { code_text: null, code_ref: 'code:abc' }),
      discount(7, 'UNKNOWN'), // gap
    ],
  });

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 600_000);
  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-catalog', roleKeys: ['owner'] }),
    );
    panelA = ctx.container.ids.uuid();
    await db().execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://a.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, panelA);
    const ownerRow = await rows<{ id: string }>(sql`SELECT id FROM admins LIMIT 1`);
    nxpkgImportId = ctx.container.ids.uuid();
    // The bindings as the Web Admin stores them: an array of { codePanel, panelId }. (An object
    // keyed by code here once hid a decoder that read nothing from the real shape — Codex on #288.)
    await db().execute(sql`
      INSERT INTO legacy_nxpkg_imports
        (id, tenant_id, status, file_name, file_path, file_sha256, file_bytes, package_import_id,
         panel_bindings, requested_by_admin_id, created_at, updated_at)
      VALUES (${nxpkgImportId}, ${tenantA.tenantId}, 'VERIFIED', 'synthetic.nxpkg',
              '/nonexistent/synthetic.nxpkg', ${'a'.repeat(64)}, 1, ${PACKAGE_IMPORT_ID},
              ${JSON.stringify([{ codePanel: 'bac6', panelId: panelA }])}::jsonb,
              ${ownerRow[0]!.id}, now(), now())`);
    buyer = await newCustomer(TG_BUYER);
    agentN = await newCustomer(TG_N);
    agentN2 = await newCustomer(TG_N2);
    customerByTg = new Map([
      [TG_BUYER, buyer],
      [TG_N, agentN],
      [TG_N2, agentN2],
    ]);
    await ingest(standard());
  });

  /** Every table a history step must leave exactly as it found it. */
  const UNTOUCHED = [
    'wallet_entries',
    'outbox_messages',
    'customer_notifications',
    'notifications',
    'provisioning_operations',
    'service_reminders',
    'orders',
    'payments',
    'services',
  ] as const;
  const snapshotUntouched = async () =>
    Object.fromEntries(await Promise.all(UNTOUCHED.map(async (t) => [t, await count(t)])));

  async function applyAll() {
    return {
      products: await steps().products.apply(mctx()),
      resellers: await steps().resellers.apply(mctx()),
      discounts: await steps().discounts.apply(mctx()),
    };
  }

  describe('products', () => {
    it('creates every readable product, ACTIVE only when it can be sold', async () => {
      const r = await steps().products.apply(mctx());
      expect(r).toMatchObject({
        step: 'catalog-products',
        written: 6,
        alreadyPresent: 0,
        diverged: 0,
      });
      expect(r.skipped).toEqual({ VOLUME_UNREADABLE: 1 });

      const byRef = Object.fromEntries(
        (
          await rows<{
            source_ref: string;
            status: string;
            audience: string;
            source: string;
            panel_id: string | null;
            category: string | null;
            price: string | null;
            traffic: string;
            days: number;
          }>(sql`SELECT p.source_ref, p.status, p.audience, p.source, p.panel_id, c.name AS category,
                        p.price_amount::text AS price, p.traffic_bytes::text AS traffic,
                        p.duration_days AS days
                   FROM products p LEFT JOIN product_categories c ON c.id = p.category_id
                  WHERE p.source = 'MIRZA'`)
        ).map((p) => [p.source_ref, p]),
      );
      expect(Object.keys(byRef).sort()).toEqual(
        ['product:1', 'product:2', 'product:3', 'product:4', 'product:5', 'product:7'].sort(),
      );
      // The rule: a bound panel (and a sellable shape) is what makes it ACTIVE.
      expect(byRef['product:1']).toMatchObject({
        status: 'ACTIVE',
        audience: 'EVERYONE',
        panel_id: panelA,
        category: 'Gold',
        price: '150001',
        traffic: String(10n * GIB),
        days: 30,
      });
      expect(byRef['product:7']).toMatchObject({ status: 'ACTIVE', category: 'Gold' });
      expect(byRef['product:2']).toMatchObject({ status: 'INACTIVE', panel_id: null });
      expect(byRef['product:3']).toMatchObject({ status: 'INACTIVE', panel_id: null });
      // Reseller-only is an audience, not a reason to withhold it: it sells to resellers.
      expect(byRef['product:4']).toMatchObject({ status: 'ACTIVE', audience: 'RESELLERS_ONLY' });
      expect(byRef['product:5']).toMatchObject({ status: 'INACTIVE', panel_id: panelA });
      expect(r.notes).toMatchObject({
        ACTIVE: 3,
        'INACTIVE:PANEL_NOT_MAPPED': 1,
        'INACTIVE:PANEL_SCOPE_ALL_PANELS': 1,
        'INACTIVE:SOLD_OUT_IN_MIRZA': 1,
      });
    });

    it('matches categories by name and creates the missing ones, once', async () => {
      const r = await steps().products.apply(mctx());
      // Gold (twice, differing in case/space), Silver. The null label creates nothing.
      expect(r.notes['CATEGORY_CREATED']).toBe(2);
      const names = (
        await rows<{ name: string }>(sql`SELECT name FROM product_categories ORDER BY name`)
      )
        .map((c) => c.name)
        .filter((n) => n === 'Gold' || n === 'Silver' || n === 'gold');
      expect(names).toEqual(['Gold', 'Silver']);

      // A category the owner already had is used, never duplicated or claimed.
      await db().execute(sql`DELETE FROM products WHERE source = 'MIRZA'`);
      const again = await steps().products.apply(mctx());
      expect(again.notes['CATEGORY_CREATED']).toBeUndefined();
    });

    it('names the product each Mirza code became, for the adoption lane', async () => {
      await steps().products.apply(mctx());
      const map = await steps().products.productIdsByCode(mctx());
      const ids = Object.fromEntries(
        (
          await rows<{ source_ref: string; id: string }>(
            sql`SELECT source_ref, id FROM products WHERE source = 'MIRZA'`,
          )
        ).map((r) => [r.source_ref, r.id]),
      );
      expect(map.get('p1')).toBe(ids['product:1']);
      expect(map.get('p7')).toBe(ids['product:7']);
      // p6 was a gap: it has no product, so it names none.
      expect(map.has('p6')).toBe(false);
      expect(map.size).toBe(6);
    });

    it('holds the exact match: rows and prices, every gap with its reason', async () => {
      await steps().products.apply(mctx());
      const report = await steps().products.match(mctx());
      const productRow = report.find((x) => x.mirzaTable === 'product')!;
      expect(productRow).toMatchObject({ mirzaRows: 7, nexaRows: 6, nexaTable: 'products' });
      expect(productRow.explained).toEqual([
        { reason: 'VOLUME_UNREADABLE', rows: 1, sumMinor: 150_006n },
      ]);
      expect(exactMatchHolds(productRow)).toBe(true);
      expect(report.every(exactMatchHolds)).toBe(true);
    });

    it('does not hold before the step ran: nothing explains the missing rows', async () => {
      const report = await steps().products.match(mctx());
      expect(report.some((row) => !exactMatchHolds(row))).toBe(true);
    });
  });

  describe('resellers', () => {
    it('creates ACTIVE resellers on list-priced tiers, with only a proven discount applied', async () => {
      const r = await steps().resellers.apply(mctx());
      expect(r).toMatchObject({
        step: 'catalog-resellers',
        written: 2,
        alreadyPresent: 0,
        diverged: 0,
      });
      expect(r.skipped).toEqual({ CUSTOMER_NOT_IMPORTED: 1, NOT_AN_AGENT_TIER: 1 });

      const list = await rows<Record<string, unknown>>(sql`
        SELECT r.source_ref, r.status, r.pricing_mode, r.discount_percentage, r.source,
               r.credit_limit_amount::text AS credit, r.imported_purchase_cap_minor::text AS cap,
               r.imported_purchase_cap_currency AS cap_currency, t.name AS tier,
               t.pricing_mode AS tier_mode, r.source_detail
          FROM resellers r JOIN reseller_tiers t ON t.id = r.tier_id ORDER BY r.source_ref`);
      expect(list).toHaveLength(2);
      const [n, n2] = list;
      expect(n).toMatchObject({
        source_ref: `agent:${TG_N}`,
        status: 'ACTIVE',
        source: 'MIRZA',
        // pricediscount 20 -> the reseller's own percentage override (a USER_OVERRIDE step)
        pricing_mode: 'PERCENTAGE_DISCOUNT',
        discount_percentage: 20,
        credit: null,
        cap: '5000000',
        cap_currency: 'IRT',
        tier: 'Mirza agent (n)',
        tier_mode: 'LIST_PRICE',
      });
      // 100 % is a free product: not proven, so NOT applied. The raw value is kept.
      expect(n2).toMatchObject({
        source_ref: `agent:${TG_N2}`,
        pricing_mode: 'TIER',
        discount_percentage: null,
        cap: null,
        tier: 'Mirza agent (n2)',
      });
      const detail = n2!['source_detail'] as {
        pricediscount: { raw: string; applied: number | null };
        tierPriceLevels: { applied: boolean; levels: unknown[] };
      };
      expect(detail.pricediscount).toEqual({ raw: '100', applied: null });
      // Price semantics UNKNOWN: both levels kept, reversibly, applied to nothing.
      expect(detail.tierPriceLevels.applied).toBe(false);
      expect(detail.tierPriceLevels.levels).toHaveLength(2);
      expect(await count('custom_service_price_rules')).toBe(0);
    });

    it('maxbuyagent is a visible limit, never money: balance 0, no ledger row, purchases still refused', async () => {
      const before = await count('wallet_entries');
      await steps().resellers.apply(mctx());

      // The wallet is exactly Mirza's Balance (here: nothing was posted, so zero) ...
      expect(await balance(agentN)).toBe(0n);
      expect(await count('wallet_entries')).toBe(before);
      expect(await count('wallet_entries')).toBe(0);

      // ... the cap is visible to the owner, through the admin service the API serves ...
      const listing = await ctx.container.resellersAdmin.get(tenantA, owner, agentN);
      expect(listing.importedPurchaseCap).toEqual({ amountMinor: 5_000_000n, currency: 'IRT' });
      expect(listing.source).toBe('MIRZA');
      // ... and is not a credit line: no own limit, the tier's limit is zero, the allowance is zero.
      expect(listing.creditLimit).toBeNull();
      expect(await ctx.container.resellers.creditAllowance(tenantA, agentN, 'IRT', null)).toBe(0n);
      const tierLimits = await rows<{ credit: string }>(
        sql`SELECT credit_limit_amount::text AS credit FROM reseller_tiers`,
      );
      expect(tierLimits.every((t) => t.credit === '0')).toBe(true);

      // The imported tier lets the agent buy an imported product at list ...
      await steps().products.apply(mctx());
      await db().execute(sql`UPDATE bot_instances SET status = 'ACTIVE' WHERE id = ${BOT_A}`);
      const viaBot: TenantContext = { ...tenantA, botInstanceId: BOT_A };
      const [{ id: productId }] = (await rows<{ id: string }>(
        sql`SELECT id FROM products WHERE source_ref = 'product:1'`,
      )) as [{ id: string }];
      const actor = (key: string): ActorContext => ({
        type: 'SYSTEM_JOB',
        id: null,
        label: 'telegram-update:test',
        surface: 'TELEGRAM',
        correlationId: key as CorrelationId,
      });
      const draftOrder = await ctx.container.orders.createDraft(viaBot, actor('d1'), {
        idempotencyKey: 'catalog-draft-1',
        customerId: agentN,
        productId,
      });
      const confirmed = await ctx.container.orders.confirm(viaBot, actor('c1'), {
        idempotencyKey: 'catalog-confirm-1',
        customerId: agentN,
        orderId: draftOrder.id,
      });
      // 20 % off the list price of 150001, as the reseller's own override.
      expect(confirmed.totals.total.amountMinor).toBe(120_000n);
      // ... but a purchase above the (zero) balance is refused, whatever the cap says.
      await expect(
        ctx.container.payments.settleFromWallet(viaBot, actor('s1'), agentN, {
          idempotencyKey: 'catalog-settle-1',
          orderId: confirmed.id,
        }),
      ).rejects.toMatchObject({ code: COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS });
      expect(await balance(agentN)).toBe(0n);
    });

    it('a customer who is already a reseller is left alone', async () => {
      const tierId = ctx.container.ids.uuid();
      await db().execute(sql`
        INSERT INTO reseller_tiers (id, tenant_id, name, pricing_mode, credit_limit_amount, credit_limit_currency)
        VALUES (${tierId}, ${tenantA.tenantId}, 'Hand made', 'LIST_PRICE', 0, 'IRT')`);
      await db().execute(sql`
        INSERT INTO resellers (id, tenant_id, customer_id, tier_id, status, pricing_mode, credit_limit_amount)
        VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, ${agentN}, ${tierId}, 'ACTIVE', 'TIER', NULL)`);
      const r = await steps().resellers.apply(mctx());
      expect(r.written).toBe(1);
      expect(r.skipped).toMatchObject({ CUSTOMER_ALREADY_RESELLER: 1 });
      const report = await steps().resellers.match(mctx());
      expect(report.every(exactMatchHolds)).toBe(true);
    });

    it('holds the exact match: agents, the cap total, and the kept price levels', async () => {
      await steps().resellers.apply(mctx());
      const report = await steps().resellers.match(mctx());
      const agents = report.find((x) => x.mirzaTable === 'agent')!;
      expect(agents).toMatchObject({
        mirzaRows: 4,
        nexaRows: 2,
        mirzaSumMinor: 5_000_000n,
        nexaSumMinor: 5_000_000n,
      });
      expect(agents.explained.map((g) => g.reason).sort()).toEqual([
        'CUSTOMER_NOT_IMPORTED',
        'NOT_AN_AGENT_TIER',
      ]);
      const levels = report.find((x) => x.mirzaTable === 'custom_service_tier_prices')!;
      expect(levels).toMatchObject({ mirzaRows: 3, nexaRows: 2 });
      expect(levels.explained).toEqual([
        { reason: 'OWNER_NOT_AN_IMPORTED_RESELLER', rows: 1, sumMinor: null },
      ]);
      expect(report.every(exactMatchHolds)).toBe(true);
    });
  });

  describe('discount codes', () => {
    it('imports every code INACTIVE; normalises what does not fit and keeps the original', async () => {
      const r = await steps().discounts.apply(mctx());
      expect(r).toMatchObject({ step: 'catalog-discount-codes', written: 5, alreadyPresent: 0 });
      expect(r.skipped).toEqual({ PERCENT_UNREADABLE: 1, KIND_UNKNOWN: 1 });

      const all = await rows<{
        source_ref: string;
        code: string;
        status: string;
        kind: string;
        type: string;
        value: string;
        currency: string | null;
        ends_at: string | null;
        total: number | null;
        per: number | null;
        detail: Record<string, unknown>;
        label: string;
      }>(sql`SELECT source_ref, code, status, kind, type, value::text AS value, currency,
                    ends_at::text AS ends_at, total_redemptions_limit AS total,
                    per_customer_limit AS per, source_detail AS detail, label
               FROM discounts WHERE source = 'MIRZA' ORDER BY source_ref`);
      expect(all).toHaveLength(5);
      expect(all.every((d) => d.status === 'INACTIVE' && d.kind === 'CODE')).toBe(true);
      const by = Object.fromEntries(all.map((d) => [d.source_ref, d]));

      expect(by['discount:engagement:discount:1']).toMatchObject({
        code: 'OFFER1',
        type: 'PERCENTAGE',
        value: '25',
        currency: null,
        total: 10,
        per: 1,
      });
      expect(by['discount:engagement:discount:1']!.detail).toMatchObject({
        codeOriginal: 'Offer1',
        codeNormalised: true,
        usedCount: 3,
      });
      // Invalid characters stripped; the original text kept.
      expect(by['discount:engagement:discount:2']!.code).toBe('WELCOME-2026');
      expect(by['discount:engagement:discount:2']!.detail).toMatchObject({
        codeOriginal: 'سلام ✓ welcome-2026!',
        codeNormalised: true,
      });
      // A collision gets a deterministic suffix; both codes stay distinct.
      const collided = by['discount:engagement:discount:3']!.code;
      expect(collided).toMatch(/^OFFER1-[0-9A-F]{8}$/);
      // The wallet "gift" code has no NEXA equivalent: inactive shell, kind kept.
      expect(by['discount:engagement:discount:4']).toMatchObject({
        type: 'FIXED_AMOUNT',
        value: '50000',
        currency: 'IRT',
      });
      expect(by['discount:engagement:discount:4']!.detail).toMatchObject({
        mirzaKind: 'GIFT_BALANCE_CODE',
      });
      // No text exported: a code derived from the record's own reference, not a guess.
      expect(by['discount:engagement:discount:6']!.code).toMatch(/^MZ-[0-9A-F]{12}$/);
      expect(by['discount:engagement:discount:6']!.detail).toMatchObject({
        codeOriginal: null,
        codeDerived: true,
      });
      expect(r.notes).toMatchObject({
        CODE_SUFFIXED: 1,
        GIFT_CODE_NO_NEXA_EQUIVALENT: 1,
        CODE_DERIVED: 1,
      });
    });

    it('never touches a code the owner already has, and suffixes around it', async () => {
      await db().execute(sql`
        INSERT INTO discounts (id, tenant_id, kind, code, label, type, status, value, applies_to)
        VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, 'CODE', 'OFFER1', 'mine', 'PERCENTAGE',
                'ACTIVE', 5, ARRAY['NEW_SERVICE'])`);
      await steps().discounts.apply(mctx());
      const mine = await rows<{ status: string; value: string; source: string }>(
        sql`SELECT status, value::text AS value, source FROM discounts WHERE code = 'OFFER1'`,
      );
      expect(mine).toEqual([{ status: 'ACTIVE', value: '5', source: 'NEXA' }]);
      const imported = await rows<{ code: string }>(
        sql`SELECT code FROM discounts WHERE source_ref = 'discount:engagement:discount:1'`,
      );
      expect(imported[0]!.code).toMatch(/^OFFER1-[0-9A-F]{8}$/);
    });

    it('holds the exact match with every gap counted', async () => {
      await steps().discounts.apply(mctx());
      const [row] = await steps().discounts.match(mctx());
      expect(row).toMatchObject({ mirzaRows: 7, nexaRows: 5, nexaTable: 'discounts' });
      expect(row!.explained.map((g) => `${g.reason}:${g.rows}`).sort()).toEqual([
        'KIND_UNKNOWN:1',
        'PERCENT_UNREADABLE:1',
      ]);
      expect(exactMatchHolds(row!)).toBe(true);
    });
  });

  describe('all three steps', () => {
    it('is idempotent: a second run writes nothing and changes no count', async () => {
      const first = await applyAll();
      const tables = [
        'products',
        'product_categories',
        'resellers',
        'reseller_tiers',
        'reseller_tier_grants',
        'discounts',
      ];
      const before = Object.fromEntries(
        await Promise.all(tables.map(async (t) => [t, await count(t)])),
      );
      const sums = await rows<Record<string, string>>(sql`
        SELECT (SELECT coalesce(sum(price_amount),0) FROM products)::text AS p,
               (SELECT coalesce(sum(value),0) FROM discounts)::text AS d,
               (SELECT coalesce(sum(imported_purchase_cap_minor),0) FROM resellers)::text AS c`);

      const second = await applyAll();
      expect(second.products).toMatchObject({
        written: 0,
        alreadyPresent: first.products.written,
        diverged: 0,
      });
      expect(second.resellers).toMatchObject({
        written: 0,
        alreadyPresent: first.resellers.written,
        diverged: 0,
      });
      expect(second.discounts).toMatchObject({
        written: 0,
        alreadyPresent: first.discounts.written,
        diverged: 0,
      });
      expect(
        Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await count(t)]))),
      ).toEqual(before);
      expect(
        await rows(sql`
        SELECT (SELECT coalesce(sum(price_amount),0) FROM products)::text AS p,
               (SELECT coalesce(sum(value),0) FROM discounts)::text AS d,
               (SELECT coalesce(sum(imported_purchase_cap_minor),0) FROM resellers)::text AS c`),
      ).toEqual(sums);
    });

    it('triggers nothing: no ledger entry, outbox event, notification, provisioning or reminder', async () => {
      const before = await snapshotUntouched();
      await applyAll();
      expect(await snapshotUntouched()).toEqual(before);
      expect(before['wallet_entries']).toBe(0);
    });

    it('reports a present row with different content as diverged, and never rewrites it', async () => {
      await applyAll();
      await db().execute(
        sql`UPDATE products SET duration_days = 31 WHERE source_ref = 'product:1'`,
      );
      await db().execute(
        sql`UPDATE discounts SET value = 26 WHERE source_ref = 'discount:engagement:discount:1'`,
      );
      const second = await applyAll();
      expect(second.products.diverged).toBe(1);
      expect(second.discounts.diverged).toBe(1);
      expect(second.products.written + second.discounts.written).toBe(0);
      const [p] = await rows<{ d: number }>(
        sql`SELECT duration_days AS d FROM products WHERE source_ref = 'product:1'`,
      );
      expect(p!.d).toBe(31);
    });

    it('writes nothing when the installation has stopped accepting work', async () => {
      const before = {
        products: await count('products'),
        discounts: await count('discounts'),
        resellers: await count('resellers'),
      };
      await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`);
      for (const step of [steps().products, steps().resellers, steps().discounts]) {
        await expect(step.apply(mctx())).rejects.toMatchObject({
          code: COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        });
      }
      expect({
        products: await count('products'),
        discounts: await count('discounts'),
        resellers: await count('resellers'),
      }).toEqual(before);
    });
  });
});
