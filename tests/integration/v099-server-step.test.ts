import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { decodeIdPair, encodeIdPair } from '../../apps/api/src/surfaces/telegram/runtime/callbacks';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import { makePanelSellable, SEED_IDS, tenantA, validatePanelConnection } from './harness';
import { makeRig, systemActor } from './r9-char-support';

/**
 * V099 «انتخاب سرور در خرید» (`sales.server_selection`) in the bot's buy flow.
 *
 * A server is a panel. Off, `/catalog` is the category list it always was. On, with two or
 * more servers able to sell, it is server → category (only those with a plan on that server)
 * → plan (only that server's) → the ordinary `p:<product id>`; one server skips the step, and
 * a renewal keeps its own panel and never sees it. Driven through `BotRuntime.handle` against
 * a real PostgreSQL, as the webhook drives it.
 */

const CUSTOMER = '990991';
const GIB = 1024n ** 3n;

describe('V099: the server step of the bot buy flow', () => {
  const rig = makeRig();
  let owner: ActorContext;
  let products: DrizzleProductRepository;
  let keySeq = 0;
  const key = () => `v099-key-${String((keySeq += 1)).padStart(6, '0')}`;

  beforeAll(async () => {
    await rig.start();
  }, 120_000);
  afterAll(async () => {
    await rig.stop();
  });
  beforeEach(async () => {
    await rig.reset();
    owner = await rig.owner();
    products = new DrizzleProductRepository(rig.ctx().container.database.db);
    await rig.resolveCustomer(CUSTOMER);
  });

  const db = () => rig.ctx().container.database.db;

  async function serverSelection(value: boolean, expectedVersion: number | null = null) {
    await rig.ctx().container.settingsService.set(tenantA, owner, {
      key: 'sales.server_selection',
      value,
      expectedVersion,
      idempotencyKey: key(),
    });
  }

  /** A sellable panel of tenant A, by name. */
  async function server(name: string): Promise<string> {
    const id = rig.ctx().container.ids.uuid();
    await db().execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${id}, ${tenantA.tenantId}, ${name}, 'sanaei',
              ${`https://${id.slice(0, 8)}.example.test`}, 'ACTIVE')`);
    await makePanelSellable(rig.ctx().container, tenantA, id);
    return id;
  }

  async function category(name: string, sortOrder: number): Promise<string> {
    const id = rig.ctx().container.ids.uuid();
    await db().execute(sql`
      INSERT INTO product_categories (id, tenant_id, name, status, visibility, sort_order)
      VALUES (${id}, ${tenantA.tenantId}, ${name}, 'ACTIVE', 'VISIBLE', ${sortOrder})`);
    return id;
  }

  async function plan(panelId: string, categoryId: string, title: string): Promise<ProductId> {
    const now = rig.ctx().container.clock.now();
    const created = await products.create(tenantA, {
      id: rig.ctx().container.ids.uuid() as ProductId,
      draft: {
        title,
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: categoryId as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 50n * GIB, deviceLimit: null },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now,
    });
    await products.setStatus(tenantA, created.id, 'INACTIVE', 'ACTIVE', now);
    return created.id;
  }

  const turn = async (update: ReturnType<typeof rig.tap>) => {
    rig.sent.length = 0;
    return rig.handle(update);
  };
  const data = (): string[] => {
    const markup = rig.lastDrawn()?.body['reply_markup'] as
      { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined;
    return (markup?.inline_keyboard ?? []).flat().map((button) => button.callback_data ?? '');
  };
  const labels = (): string[] => {
    const markup = rig.lastDrawn()?.body['reply_markup'] as
      { inline_keyboard?: { text: string }[][] } | undefined;
    return (markup?.inline_keyboard ?? []).flat().map((button) => button.text);
  };
  const productIdsOnScreen = (): string[] =>
    data()
      .filter((one) => one.startsWith('p:'))
      .map((one) => one.slice('p:'.length));

  /**
   * The owner's example: «یک‌ماهه ۳۰ روزه» on both servers with different plans, and a second
   * category («ویژه») sold only on Germany.
   */
  async function twoServers() {
    const germany = await server('آلمان');
    const netherlands = await server('هلند');
    const monthly = await category('یک‌ماهه ۳۰ روزه', 1);
    const special = await category('ویژه', 2);
    const germanyMonthly = await plan(germany, monthly, 'آلمان ۵۰ گیگ');
    const netherlandsMonthly = await plan(netherlands, monthly, 'هلند ۵۰ گیگ');
    const germanySpecial = await plan(germany, special, 'آلمان ویژه');
    return {
      germany,
      netherlands,
      monthly,
      special,
      germanyMonthly,
      netherlandsMonthly,
      germanySpecial,
    };
  }

  it('is OFF by default: /catalog is the category list, with no server step, exactly as before', async () => {
    const fleet = await twoServers();
    const off = await turn(rig.text('/catalog', CUSTOMER));
    expect(off.replyKey).toBe('bot.catalog.categories_heading');
    expect(rig.lastText()).toBe(CATALOGUE_FA['bot.catalog.categories_heading']);
    expect(data()).toStrictEqual([`ck:${fleet.monthly}.0`, `ck:${fleet.special}.0`]);
    // The category opens on EVERY server's plans, as it always has.
    await turn(rig.tap(`ck:${fleet.monthly}.0`, CUSTOMER));
    expect(productIdsOnScreen().sort()).toStrictEqual(
      [fleet.germanyMonthly, fleet.netherlandsMonthly].sort(),
    );
    expect(data()).toContain('cg:0');
  });

  it('turned off again after being on, the flow is the category list again (and a stale cs: recovers to it)', async () => {
    const fleet = await twoServers();
    await serverSelection(true);
    await serverSelection(false, 1);
    await turn(rig.text('/catalog', CUSTOMER));
    expect(data()).toStrictEqual([`ck:${fleet.monthly}.0`, `ck:${fleet.special}.0`]);
    const stale = await turn(rig.tap('cs:0', CUSTOMER));
    expect(stale.replyKey).toBe('bot.catalog.categories_heading');
  });

  it('ON: server → category → plan, each step narrowed to the chosen server, ending on the ordinary plan button', async () => {
    const fleet = await twoServers();
    await serverSelection(true);

    const servers = await turn(rig.text('/catalog', CUSTOMER));
    expect(servers.replyKey).toBe('bot.catalog.servers_heading');
    expect(rig.lastText()).toBe(CATALOGUE_FA['bot.catalog.servers_heading']);
    // By name: «آلمان» sorts before «هلند».
    expect(labels()).toStrictEqual(['آلمان', 'هلند']);
    expect(data()).toStrictEqual([`cr:${fleet.germany}.0`, `cr:${fleet.netherlands}.0`]);

    const categories = await turn(rig.tap(`cr:${fleet.germany}.0`, CUSTOMER));
    expect(categories.intent).toBe('SERVER_CATEGORIES');
    expect(categories.replyKey).toBe('bot.catalog.categories_heading');
    const categoryButtons = data().filter((one) => one.startsWith('cl:'));
    expect(categoryButtons).toHaveLength(2);
    for (const one of categoryButtons) {
      // Telegram's limit, and the pair carries the server and the category.
      expect(Buffer.byteLength(one, 'utf8')).toBeLessThanOrEqual(64);
      const pair = decodeIdPair(one.slice('cl:'.length).split('.')[0] ?? '');
      expect(pair?.first).toBe(fleet.germany);
    }
    const monthlyOnGermany = categoryButtons.find(
      (one) => decodeIdPair(one.slice(3).split('.')[0] ?? '')?.second === fleet.monthly,
    );
    expect(monthlyOnGermany).toBeDefined();

    const plans = await turn(rig.tap(monthlyOnGermany ?? '', CUSTOMER));
    expect(plans.intent).toBe('SERVER_CATEGORY');
    expect(plans.replyKey).toBe('bot.catalog.heading');
    // Only Germany's plan of the shared category, and as the SAME product id a draft takes.
    expect(productIdsOnScreen()).toStrictEqual([fleet.germanyMonthly]);

    const drafted = await turn(rig.tap(`p:${fleet.germanyMonthly}`, CUSTOMER));
    expect(drafted.intent).toBe('ORDER');
    const rows = await db().execute<{ product_id: string }>(
      sql`SELECT product_id FROM orders WHERE tenant_id = ${tenantA.tenantId}`,
    );
    expect(rows.rows.map((row) => row.product_id)).toStrictEqual([fleet.germanyMonthly]);
  });

  it('ON: a category with no plan on the chosen server is not listed there', async () => {
    const fleet = await twoServers();
    await serverSelection(true);
    await turn(rig.tap(`cr:${fleet.netherlands}.0`, CUSTOMER));
    const listed = data()
      .filter((one) => one.startsWith('cl:'))
      .map((one) => decodeIdPair(one.slice(3).split('.')[0] ?? '')?.second);
    // «ویژه» is sold only on Germany.
    expect(listed).toStrictEqual([fleet.monthly]);
    // And a crafted tap on it from the Netherlands opens on nothing of Germany's.
    await turn(rig.tap(`cl:${encodeIdPair(fleet.netherlands, fleet.special)}.0`, CUSTOMER));
    expect(productIdsOnScreen()).toStrictEqual([]);
  });

  it('ON: with ONE server able to sell the step is skipped — a drained or archived panel is not a server', async () => {
    const fleet = await twoServers();
    await serverSelection(true);
    await db().execute(
      sql`UPDATE panels SET drained_at = now(), drain_reason = 'v099 test'
            WHERE id = ${fleet.netherlands}`,
    );
    const skipped = await turn(rig.text('/catalog', CUSTOMER));
    expect(skipped.replyKey).toBe('bot.catalog.categories_heading');
    expect(data().every((one) => one.startsWith('ck:'))).toBe(true);

    // A third panel with no sellable plan is no server either.
    await server('بدون پلن');
    await turn(rig.text('/catalog', CUSTOMER));
    expect(data().every((one) => one.startsWith('ck:'))).toBe(true);

    // A drained panel, tapped from a stale server list, narrows to nothing.
    const stale = await turn(rig.tap(`cr:${fleet.netherlands}.0`, CUSTOMER));
    expect(stale.replyKey).toBe('bot.catalog.empty');
    expect(data()).toStrictEqual(['cs:0']);
  });

  it('ON: back from the plans is the server categories, back from those is the server list, and a new server starts afresh', async () => {
    const fleet = await twoServers();
    await serverSelection(true);
    await turn(rig.tap(`cl:${encodeIdPair(fleet.germany, fleet.special)}.0`, CUSTOMER));
    expect(productIdsOnScreen()).toStrictEqual([fleet.germanySpecial]);
    const backToCategories = data().at(-1);
    expect(backToCategories).toBe(`cr:${fleet.germany}.0`);
    expect(labels().at(-1)).toBe(CATALOGUE_FA['bot.catalog.back_to_categories_button']);

    await turn(rig.tap(backToCategories ?? '', CUSTOMER));
    expect(data().at(-1)).toBe('cs:0');
    expect(labels().at(-1)).toBe(CATALOGUE_FA['bot.catalog.back_to_servers_button']);

    const list = await turn(rig.tap('cs:0', CUSTOMER));
    expect(list.intent).toBe('SERVER_LIST');
    expect(list.replyKey).toBe('bot.catalog.servers_heading');

    // Another server: its own categories, the previous server's category not carried over.
    await turn(rig.tap(`cr:${fleet.netherlands}.0`, CUSTOMER));
    const pairs = data()
      .filter((one) => one.startsWith('cl:'))
      .map((one) => decodeIdPair(one.slice(3).split('.')[0] ?? ''));
    expect(pairs.map((pair) => pair?.first)).toStrictEqual([fleet.netherlands]);
    expect(pairs.map((pair) => pair?.second)).toStrictEqual([fleet.monthly]);
  });

  describe('a renewal', () => {
    let panel: FakeMarzban | undefined;
    afterEach(async () => {
      await panel?.close();
      panel = undefined;
    });

    it('keeps the service own panel and never asks for a server, with the step ON', async () => {
      const container = rig.ctx().container;
      panel = await startFakeMarzban({ host: '127.0.0.2' });
      const created = await container.panels.create(tenantA, owner, {
        name: 'Marzban A',
        providerType: 'marzban',
        baseUrl: panel.baseUrl,
        credentials: { username: panel.username, password: panel.password },
        activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
        idempotencyKey: key(),
      });
      const panelId = created.view.panel.id;
      await validatePanelConnection(container, tenantA, panelId);
      // A second server, so the step WOULD be drawn by the buy entry.
      await plan(await server('هلند'), SEED_IDS.categoryA, 'هلند');
      const productId = await plan(panelId, SEED_IDS.categoryA, 'پلن ماهانه');
      const customer = (await rig.resolveCustomer(CUSTOMER)) as UserId;
      const draft = await container.orders.createDraft(tenantA, systemActor('v099'), {
        idempotencyKey: key(),
        customerId: customer,
        productId,
      });
      const confirmed = await container.orders.confirm(tenantA, systemActor('v099'), {
        idempotencyKey: key(),
        customerId: customer,
        orderId: draft.id,
      });
      await container.wallet.adjust(tenantA, owner, customer, {
        idempotencyKey: key(),
        direction: 'CREDIT',
        amountMinor: 1_000_000n,
        currency: 'IRT',
        note: 'fixture',
      });
      await container.payments.settleFromWallet(tenantA, systemActor('v099'), customer, {
        idempotencyKey: key(),
        orderId: confirmed.id,
      });
      await container.provisionerLoop.tick();
      const service = await new DrizzleServiceRepository(container.database.db).findByOrderId(
        tenantA,
        confirmed.id,
      );
      if (service === undefined || service === null) throw new Error('no service');
      await serverSelection(true);

      // The buy entry now asks for a server…
      expect((await turn(rig.text('/catalog', CUSTOMER))).replyKey).toBe(
        'bot.catalog.servers_heading',
      );
      // …and the renewal does not: its menu, never a server or a category.
      const renew = await turn(rig.tap(`n:${service.id}`, CUSTOMER));
      expect(renew.replyKey).not.toBe('bot.catalog.servers_heading');
      expect(renew.replyKey).not.toBe('bot.catalog.categories_heading');
      expect(data().some((one) => /^c[srl]:/u.test(one))).toBe(false);
    });
  });
});
