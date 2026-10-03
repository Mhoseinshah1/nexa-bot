import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  PANEL_UNHEALTHY_AFTER_FAILURES,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import type { ProductRecord } from '../../apps/api/src/modules/commerce/catalog/application/ports';
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
 * Phase C3: automatic panel balancing, against a real database.
 *
 * The draft decides where a new account goes; confirmation's `acquire` still takes the
 * one slot under the panel's lock. So every case drives the ordinary customer path —
 * draft, then confirm — and reads back both the order's panel and the explanation row.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'panel-balancing:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('automatic panel balancing', () => {
  let ctx: TestContext;
  let products: DrizzleProductRepository;
  let owner: ActorContext;
  let ownerB: ActorContext;
  let home: string;
  let peer: string;
  let n = 0;
  const key = () => `panel-balancing-key-${(n += 1)}`;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    products = new DrizzleProductRepository(ctx.container.database.db);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-bal', roleKeys: ['owner'] }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-bal-b', roleKeys: ['owner'] }),
    );
    // Two ids in a known order, so "the lowest id" is the one a reader expects.
    home = '01a0c300-0000-7000-8000-00000000000a';
    peer = '01a0c300-0000-7000-8000-00000000000b';
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${home}, ${tenantA.tenantId}, 'Home', 'sanaei', 'https://home.example.test', 'ACTIVE'),
             (${peer}, ${tenantA.tenantId}, 'Peer', 'sanaei', 'https://peer.example.test', 'ACTIVE')`);
    await makePanelSellable(ctx.container, tenantA, home);
    await makePanelSellable(ctx.container, tenantA, peer);
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function customer(telegramUserId: string, scope: TenantContext = tenantA): Promise<UserId> {
    const { customer: record } = await ctx.container.customers.resolveFromUpdate(
      scope,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'نیما' },
        botInstanceId: scope === tenantA ? BOT_A : (SEED_IDS.botB1 as BotInstanceId),
      },
    );
    return record.id;
  }

  async function productOn(
    panelId: string,
    scope: TenantContext = tenantA,
  ): Promise<ProductRecord> {
    const created = await products.create(scope, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن متوازن',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: (scope === tenantA
          ? SEED_IDS.categoryA
          : SEED_IDS.categoryB) as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 0n, deviceLimit: 1 },
        price: money(100_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(scope, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const after = await products.findById(scope, created.id);
    if (after === null) throw new Error('product vanished');
    return after;
  }

  const draft = (customerId: UserId, product: ProductRecord, scope: TenantContext = tenantA) => {
    const k = key();
    return ctx.container.orders.createDraft(scope, systemActor(k), {
      idempotencyKey: k,
      customerId,
      productId: product.id,
    });
  };

  const confirm = (customerId: UserId, orderId: string) => {
    const k = key();
    return ctx.container.orders.confirm(tenantA, systemActor(k), {
      idempotencyKey: k,
      customerId,
      orderId,
    });
  };

  async function setFlag(enabled: boolean, scope: TenantContext = tenantA, actor = owner) {
    const before = (await ctx.container.featureFlags.list(scope, actor)).find(
      (flag) => flag.key === 'panel_auto_balancing',
    );
    if (before === undefined) throw new Error('no panel_auto_balancing flag');
    await ctx.container.featureFlags.set(scope, actor, {
      idempotencyKey: key(),
      key: 'panel_auto_balancing',
      enabled,
      expectedVersion: before.version,
      confirmKey: 'panel_auto_balancing',
      reason: 'balancing suite',
    });
  }

  /** Through the real panel write path, so the audit and validation are the ones exercised. */
  const group = (panelId: string, balancingGroup: string | null) =>
    ctx.container.panels.update(tenantA, owner, panelId, {
      balancingGroup,
      idempotencyKey: key(),
    });

  const setCap = (panelId: string, cap: number | null) =>
    ctx.container.database.db.execute(
      sql`UPDATE panels SET max_services = ${cap} WHERE id = ${panelId}`,
    );

  const setDrained = (panelId: string) =>
    ctx.container.database.db.execute(
      sql`UPDATE panels SET drained_at = now(), drain_reason = 'نگهداری' WHERE id = ${panelId}`,
    );

  const setHealth = (panelId: string, state: string, streak: number) =>
    ctx.container.database.db.execute(sql`
      UPDATE panel_health
         SET state = ${state}, unusable_streak = ${streak},
             failure = ${state === 'HEALTHY' || state === 'DEGRADED' ? null : 'TIMEOUT'},
             checked_at = ${ctx.container.clock.now()}
       WHERE panel_id = ${panelId}`);

  /** Occupy `count` slots on a panel with confirmed orders made while balancing is off. */
  async function load(panelId: string, count: number): Promise<void> {
    const product = await productOn(panelId);
    for (let i = 0; i < count; i += 1) {
      const buyer = await customer(String(910_000 + (n += 1)));
      const order = await draft(buyer, product);
      await confirm(buyer, order.id);
    }
  }

  const reservationsOn = async (panelId: string): Promise<number> => {
    const rows = await ctx.container.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM panel_capacity_reservations WHERE panel_id = ${panelId}`,
    );
    return rows.rows[0]?.n ?? 0;
  };

  // -------------------------------------------------------------------------
  // The explicit route takes precedence
  // -------------------------------------------------------------------------

  describe('the explicit route', () => {
    it('places on the product panel while the flag is off, however loaded it is', async () => {
      await group(home, 'eu');
      await group(peer, 'eu');
      await load(home, 2);
      const order = await draft(await customer('900001'), await productOn(home));
      expect(order.line.panelId).toBe(home);
      expect(await ctx.container.orders.placement(tenantA, owner, order.id)).toBeNull();
    });

    it('places on the product panel when it is in no group, flag on', async () => {
      await setFlag(true);
      await group(peer, 'eu');
      await load(home, 2);
      const order = await draft(await customer('900002'), await productOn(home));
      expect(order.line.panelId).toBe(home);
      expect(await ctx.container.orders.placement(tenantA, owner, order.id)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Balancing
  // -------------------------------------------------------------------------

  describe('within a group', () => {
    beforeEach(async () => {
      await group(home, 'eu');
      await group(peer, 'eu');
    });

    it('moves a new account to the less loaded panel and explains why', async () => {
      await load(home, 2);
      await setFlag(true);
      const buyer = await customer('900010');
      const order = await draft(buyer, await productOn(home));
      expect(order.line.panelId).toBe(peer);

      const placement = await ctx.container.orders.placement(tenantA, owner, order.id);
      expect(placement).toMatchObject({
        homePanelId: home,
        chosenPanelId: peer,
        group: 'eu',
        strategy: 'LEAST_USED',
        decidedBy: 'LOAD',
      });
      expect(placement?.candidates.map((row) => [row.panelId, row.rank, row.used])).toEqual([
        [peer, 1, 0],
        [home, 2, 2],
      ]);
      // And confirmation takes the slot on the panel the draft named.
      await confirm(buyer, order.id);
      expect(await reservationsOn(peer)).toBe(1);
    });

    it('equal candidates keep the home: the decision is stable', async () => {
      await setFlag(true);
      const order = await draft(await customer('900011'), await productOn(home));
      expect(order.line.panelId).toBe(home);
      expect(await ctx.container.orders.placement(tenantA, owner, order.id)).toMatchObject({
        decidedBy: 'HOME_PREFERENCE',
      });
    });

    it('prefers the healthy panel over one that is eligible but failing', async () => {
      await load(peer, 3);
      // One failed probe: still sellable (hysteresis), but not healthy.
      await setHealth(home, 'UNREACHABLE', 1);
      await setFlag(true);
      const order = await draft(await customer('900012'), await productOn(home));
      expect(order.line.panelId).toBe(peer);
      expect(await ctx.container.orders.placement(tenantA, owner, order.id)).toMatchObject({
        decidedBy: 'HEALTH',
      });
    });

    it('never places on a confirmed-unhealthy panel', async () => {
      await load(home, 3);
      await setHealth(peer, 'UNREACHABLE', PANEL_UNHEALTHY_AFTER_FAILURES);
      await setFlag(true);
      const order = await draft(await customer('900013'), await productOn(home));
      expect(order.line.panelId).toBe(home);
      const placement = await ctx.container.orders.placement(tenantA, owner, order.id);
      expect(placement?.decidedBy).toBe('SOLE_CANDIDATE');
      expect(placement?.candidates.find((row) => row.panelId === peer)).toMatchObject({
        excluded: 'INELIGIBLE',
        ineligibleReason: 'UNHEALTHY',
      });
    });

    it('never places on a drained panel', async () => {
      await load(home, 3);
      await setDrained(peer);
      await setFlag(true);
      const order = await draft(await customer('900014'), await productOn(home));
      expect(order.line.panelId).toBe(home);
      expect(
        (await ctx.container.orders.placement(tenantA, owner, order.id))?.candidates.find(
          (row) => row.panelId === peer,
        ),
      ).toMatchObject({ excluded: 'INELIGIBLE', ineligibleReason: 'DRAINING' });
    });

    it('at the capacity boundary: a full home sends the account to the peer', async () => {
      await setCap(home, 1);
      await load(home, 1);
      await setFlag(true);
      const buyer = await customer('900015');
      const order = await draft(buyer, await productOn(home));
      expect(order.line.panelId).toBe(peer);
      await expect(confirm(buyer, order.id)).resolves.toMatchObject({ state: 'AWAITING_PAYMENT' });
    });

    it('with no eligible panel keeps the home and confirmation refuses for its reason', async () => {
      await setCap(home, 1);
      await setCap(peer, 1);
      await load(home, 1);
      await load(peer, 1);
      await setFlag(true);
      const buyer = await customer('900016');
      const order = await draft(buyer, await productOn(home));
      expect(order.line.panelId).toBe(home);
      expect(await ctx.container.orders.placement(tenantA, owner, order.id)).toMatchObject({
        decidedBy: 'NO_ELIGIBLE_CANDIDATE',
      });
      await expect(confirm(buyer, order.id)).rejects.toMatchObject({
        code: 'commerce.panel_not_eligible',
        details: { reason: 'AT_CAPACITY' },
      });
      expect(await reservationsOn(home)).toBe(1);
      expect(await reservationsOn(peer)).toBe(1);
    });

    it('never over-allocates when confirmations race across the group', async () => {
      // One slot on each panel and four customers at once. The drafts are placed first
      // (all see the same empty group, so all go home), then all four confirm together:
      // exactly one takes the home's slot. The losers start again and are placed on the
      // peer, where exactly one more succeeds. Never more than one hold per panel.
      await setCap(home, 1);
      await setCap(peer, 1);
      await setFlag(true);
      const product = await productOn(home);
      const buyers = await Promise.all(
        ['900020', '900021', '900022', '900023'].map((id) => customer(id)),
      );
      const drafts = await Promise.all(buyers.map((buyer) => draft(buyer, product)));
      const first = await Promise.allSettled(
        drafts.map((order, index) => confirm(buyers[index]!, order.id)),
      );
      expect(first.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
      for (const refused of first.filter((one) => one.status === 'rejected')) {
        expect((refused as PromiseRejectedResult).reason).toMatchObject({
          details: { reason: 'AT_CAPACITY' },
        });
      }

      const losers = buyers.filter((_, index) => first[index]!.status === 'rejected');
      const second = await Promise.allSettled(
        losers.map(async (buyer) => {
          const again = await draft(buyer, product);
          expect(again.line.panelId).toBe(peer);
          return confirm(buyer, again.id);
        }),
      );
      expect(second.filter((one) => one.status === 'fulfilled')).toHaveLength(1);
      expect(await reservationsOn(home)).toBe(1);
      expect(await reservationsOn(peer)).toBe(1);
    });

    it('offers a product whose own panel is drained when its group can take the account', async () => {
      await productOn(home);
      await setDrained(home);
      const browse = () => ctx.container.products.browse(tenantA, systemActor(key()), 20);
      expect((await browse()).items, 'flag off: the explicit route, so hidden').toHaveLength(0);
      await setFlag(true);
      expect((await browse()).items).toHaveLength(1);
      const order = await draft(await customer('900030'), (await browse()).items[0]!);
      expect(order.line.panelId).toBe(peer);
    });

    it('excludes a panel of another provider from the group', async () => {
      const other = '01a0c300-0000-7000-8000-00000000000c';
      await ctx.container.database.db.execute(sql`
        INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
        VALUES (${other}, ${tenantA.tenantId}, 'Other', 'marzban', 'https://other.example.test', 'ACTIVE')`);
      await group(other, 'eu');
      await load(home, 1);
      await load(peer, 1);
      await setFlag(true);
      const order = await draft(await customer('900031'), await productOn(home));
      expect(order.line.panelId).not.toBe(other);
      expect(
        (await ctx.container.orders.placement(tenantA, owner, order.id))?.candidates.find(
          (row) => row.panelId === other,
        ),
      ).toMatchObject({ excluded: 'PROVIDER_MISMATCH' });
    });

    it("never considers another tenant's panel, whatever its group is called", async () => {
      const foreign = '01a0c300-0000-7000-8000-00000000000f';
      await ctx.container.database.db.execute(sql`
        INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status, balancing_group)
        VALUES (${foreign}, ${tenantB.tenantId}, 'Foreign', 'sanaei', 'https://foreign.example.test',
                'ACTIVE', 'eu')`);
      await makePanelSellable(ctx.container, tenantB, foreign);
      await load(home, 2);
      await load(peer, 2);
      await setFlag(true);
      const order = await draft(await customer('900032'), await productOn(home));
      const placement = await ctx.container.orders.placement(tenantA, owner, order.id);
      expect(placement?.candidates.map((row) => row.panelId)).not.toContain(foreign);
      expect([home, peer]).toContain(order.line.panelId);
      void ownerB;
    });

    it('keeps the explanation exactly as decided: the row cannot be rewritten', async () => {
      await load(home, 1);
      await setFlag(true);
      const order = await draft(await customer('900033'), await productOn(home));
      await expect(
        ctx.container.database.db.execute(
          sql`UPDATE order_panel_placements SET decided_by = 'PANEL_ID' WHERE order_id = ${order.id}`,
        ),
      ).rejects.toThrow();
    });

    it('records the placement in the draft audit row', async () => {
      await load(home, 1);
      await setFlag(true);
      const order = await draft(await customer('900034'), await productOn(home));
      const rows = await ctx.container.database.db.execute<{ after: Record<string, unknown> }>(
        sql`SELECT after FROM audit_logs WHERE action = 'order.draft_create' AND entity_id = ${order.id}`,
      );
      expect(rows.rows[0]?.after).toMatchObject({
        panelId: peer,
        placement: { homePanelId: home, chosenPanelId: peer, decidedBy: 'LOAD' },
      });
    });
  });

  // -------------------------------------------------------------------------
  // The operator's side
  // -------------------------------------------------------------------------

  describe('configuration and reading', () => {
    it('sets and clears a group through the audited panel write, and refuses a bad label', async () => {
      await group(home, 'eu-west');
      const view = await ctx.container.panels.get(tenantA, owner, home);
      expect(view.panel.balancingGroup).toBe('eu-west');
      await group(home, null);
      const audits = await ctx.container.database.db.execute<{
        before: { balancingGroup: string | null };
        after: { balancingGroup: string | null };
      }>(sql`SELECT before, after FROM audit_logs
              WHERE action = 'panel.update' AND entity_id = ${home} ORDER BY occurred_at, id`);
      expect(
        audits.rows.map((row) => [row.before.balancingGroup, row.after.balancingGroup]),
      ).toEqual([
        [null, 'eu-west'],
        ['eu-west', null],
      ]);
      await expect(group(home, 'has space')).rejects.toMatchObject({
        code: 'panel.request_invalid',
      });
    });

    it('lowercases a label, so two spellings are one group', async () => {
      await group(home, 'EU');
      expect((await ctx.container.panels.get(tenantA, owner, home)).panel.balancingGroup).toBe(
        'eu',
      );
    });

    it('refuses the explanation to an actor without orders.view', async () => {
      await group(home, 'eu');
      await group(peer, 'eu');
      await setFlag(true);
      const order = await draft(await customer('900040'), await productOn(home));
      const technical = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: 'tech-bal',
          roleKeys: ['technical'],
        }),
      );
      await expect(
        ctx.container.orders.placement(tenantA, technical, order.id),
      ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
    });

    it('uses the configured strategy', async () => {
      await group(home, 'eu');
      await group(peer, 'eu');
      // home 2 of 10 (20%), peer 1 of 2 (50%): LEAST_USED says peer, utilisation says home.
      await setCap(home, 10);
      await setCap(peer, 2);
      await load(home, 2);
      await load(peer, 1);
      await setFlag(true);
      expect((await draft(await customer('900041'), await productOn(home))).line.panelId).toBe(
        peer,
      );
      const current = (await ctx.container.settingsService.list(tenantA, owner)).find(
        (setting) => setting.key === 'panels.balancing.strategy',
      );
      await ctx.container.settingsService.set(tenantA, owner, {
        key: 'panels.balancing.strategy',
        value: 'LOWEST_UTILISATION',
        expectedVersion: current?.version ?? null,
        idempotencyKey: key(),
      });
      const order = await draft(await customer('900042'), await productOn(home));
      expect(order.line.panelId).toBe(home);
      expect(await ctx.container.orders.placement(tenantA, owner, order.id)).toMatchObject({
        strategy: 'LOWEST_UTILISATION',
        decidedBy: 'LOAD',
      });
    });
  });
});
