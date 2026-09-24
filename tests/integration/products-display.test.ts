import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  PRODUCT_DISPLAY_LIST_MAX_ITEMS,
  PRODUCT_DISPLAY_LOCATION_MAX_LENGTH,
  PRODUCT_SERVICE_LOCATION_LABEL_MAX_LENGTH,
  money,
  productWriteSchema,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductDisplay,
  type UserId,
} from '@nexa/contracts';
import type { ProductDraft } from '../../apps/api/src/modules/commerce/catalog/application/ports';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { CANARY, startFake3xUi, type Fake3xUi } from '../support/fake-3xui';
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
 * Product display metadata (customer UX completion §C): what a product SHOWS, kept apart
 * from what it PROVISIONS.
 *
 *   - the three fields round-trip through the service exactly, order included, and an
 *     edit that clears them clears them;
 *   - the bounds are the contract's, and the schema is where they bite;
 *   - a row holding something other than an array of strings is refused, never coerced
 *     into a pre-invoice line;
 *   - and the rule the section exists for: a product whose display locations name
 *     ANOTHER panel's host still provisions on its `panel_id` panel. A location string
 *     is a promise to a customer, never an instruction to a machine.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
/** The host the display copy names, and the host the service must NOT land on. */
const DECOY_HOST = 'decoy-panel.example.test';

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('product display metadata', () => {
  let ctx: TestContext;
  let telegram: Server;
  let panel: Fake3xUi;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let panelA: string;
  let decoyPanel: string;
  let customerA: UserId;
  let owner: ActorContext;

  beforeAll(async () => {
    // Delivery follows a provision in the same tick, so Telegram has to answer something.
    telegram = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
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
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(ctx.container.database.db);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-disp', roleKeys: ['owner'] }),
    );

    // The real panel, at 127.0.0.2 for the reason `provisioning-delivery.test.ts` gives.
    panel = await startFake3xUi({ host: '127.0.0.2' });
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Panel A',
      providerType: 'sanaei',
      baseUrl: panel.baseUrl,
      credentials: { username: CANARY.username, password: CANARY.password },
      activation: { subscriptionDomain: 'sub.example.test', inboundId: 1 },
      idempotencyKey: 'panel-disp-create',
    });
    panelA = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelA);

    /*
     * A SECOND panel this tenant owns, whose host the display copy will name. Written
     * by SQL: it exists to be named, not to be dialled, and the assertion below is that
     * nothing dials it.
     */
    decoyPanel = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status, activation)
      VALUES (${decoyPanel}, ${tenantA.tenantId}, 'Decoy', 'sanaei', ${`https://${DECOY_HOST}`},
              'ACTIVE', ${JSON.stringify({ subscriptionDomain: DECOY_HOST, inboundId: 1 })}::jsonb)`);

    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-disp',
      telegramUserId: '910911',
      from: { id: 910911, first_name: 'مریم' },
      botInstanceId: BOT_A,
    });
    customerA = resolved.customer.id;
  });

  const draft = (display: ProductDisplay, panelId: string = panelA): ProductDraft => ({
    title: 'پلن پایه',
    description: null,
    audience: 'EVERYONE',
    sortOrder: 10,
    panelId: panelId as PanelId,
    categoryId: SEED_IDS.categoryA as ProductCategoryId,
    specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
    price: money(250_000n, 'IRT'),
    display,
  });

  // -------------------------------------------------------------------------
  // Round trip
  // -------------------------------------------------------------------------

  it('round-trips ordered lists exactly, through create and update', async () => {
    const display: ProductDisplay = {
      displayLocations: ['🇩🇪 Germany', '🇳🇱 Netherlands', '🇫🇮 Finland'],
      displayFeatures: ['• No logs', '• Unlimited devices', '• 24/7 support'],
      serviceLocationLabel: 'Frankfurt',
    };
    const created = await ctx.container.products.create(tenantA, owner, {
      idempotencyKey: 'disp-create-1',
      draft: draft(display),
    });
    expect(created.display).toEqual(display);
    expect((await products.findById(tenantA, created.id))?.display).toEqual(display);

    // Reordered, not merely changed: the order is data and an edit must move it.
    const reordered: ProductDisplay = {
      displayLocations: ['🇫🇮 Finland', '🇩🇪 Germany', '🇳🇱 Netherlands'],
      displayFeatures: ['• 24/7 support'],
      serviceLocationLabel: null,
    };
    const edited = await ctx.container.products.update(tenantA, owner, {
      idempotencyKey: 'disp-edit-1',
      productId: created.id,
      edit: draft(reordered),
    });
    expect(edited.display).toEqual(reordered);
    expect((await products.findById(tenantA, created.id))?.display).toEqual(reordered);

    // Cleared, and read back as the empty display rather than as the previous one.
    const cleared = await ctx.container.products.update(tenantA, owner, {
      idempotencyKey: 'disp-edit-2',
      productId: created.id,
      edit: draft(EMPTY_PRODUCT_DISPLAY),
    });
    expect(cleared.display).toEqual(EMPTY_PRODUCT_DISPLAY);
  });

  it('treats a reused key whose request changed only the display as a different command', async () => {
    const first = await ctx.container.products.create(tenantA, owner, {
      idempotencyKey: 'disp-key-1',
      draft: draft({ ...EMPTY_PRODUCT_DISPLAY, displayLocations: ['A', 'B'] }),
    });
    // The same key, the same lists in the OTHER order. A replay would answer with
    // `first`; the hash includes the order, so it is refused instead.
    await expect(
      ctx.container.products.create(tenantA, owner, {
        idempotencyKey: 'disp-key-1',
        draft: draft({ ...EMPTY_PRODUCT_DISPLAY, displayLocations: ['B', 'A'] }),
      }),
    ).rejects.toThrow();
    expect((await products.findById(tenantA, first.id))?.display.displayLocations).toEqual([
      'A',
      'B',
    ]);
  });

  it('records the display in the audit pair, so a rewritten list is not a change of nothing', async () => {
    const created = await ctx.container.products.create(tenantA, owner, {
      idempotencyKey: 'disp-audit-1',
      draft: draft({ ...EMPTY_PRODUCT_DISPLAY, displayLocations: ['Germany'] }),
    });
    await ctx.container.products.update(tenantA, owner, {
      idempotencyKey: 'disp-audit-2',
      productId: created.id,
      edit: draft({ ...EMPTY_PRODUCT_DISPLAY, displayLocations: ['France'] }),
    });
    const rows = await ctx.container.database.db.execute<{
      before: { displayLocations?: unknown } | null;
      after: { displayLocations?: unknown };
    }>(sql`
      SELECT before, after FROM audit_logs
       WHERE tenant_id = ${tenantA.tenantId} AND entity_id = ${created.id} AND action = 'product.update'`);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.before?.displayLocations).toEqual(['Germany']);
    expect(rows.rows[0]?.after.displayLocations).toEqual(['France']);
  });

  // -------------------------------------------------------------------------
  // The bounds, at the schema that every surface parses
  // -------------------------------------------------------------------------

  describe('the write schema', () => {
    const base = {
      idempotencyKey: 'schema-key-1',
      title: 'پلن',
      description: null,
      audience: 'EVERYONE',
      sortOrder: 0,
      panelId: null,
      durationDays: 30,
      trafficBytes: '0',
      deviceLimit: null,
      priceAmount: null,
      priceCurrency: null,
      categoryId: null,
    };

    it('defaults an old-style body, which sends none of the three, to the empty display', () => {
      const parsed = productWriteSchema.parse(base);
      expect(parsed.displayLocations).toEqual([]);
      expect(parsed.displayFeatures).toEqual([]);
      expect(parsed.serviceLocationLabel).toBeNull();
    });

    it('keeps the order it was given and trims each line', () => {
      const parsed = productWriteSchema.parse({
        ...base,
        displayLocations: ['  C ', 'A', 'B'],
        displayFeatures: ['z', 'y'],
        serviceLocationLabel: ' Frankfurt ',
      });
      expect(parsed.displayLocations).toEqual(['C', 'A', 'B']);
      expect(parsed.displayFeatures).toEqual(['z', 'y']);
      expect(parsed.serviceLocationLabel).toBe('Frankfurt');
    });

    it.each([
      [
        'one location past the list bound',
        {
          displayLocations: Array.from(
            { length: PRODUCT_DISPLAY_LIST_MAX_ITEMS + 1 },
            (_, i) => `L${String(i)}`,
          ),
        },
      ],
      ['a blank line', { displayLocations: ['Germany', '   '] }],
      ['a line break inside a line', { displayFeatures: ['one\ntwo'] }],
      [
        'a location past its length',
        { displayLocations: ['x'.repeat(PRODUCT_DISPLAY_LOCATION_MAX_LENGTH + 1)] },
      ],
      [
        'a label past its length',
        { serviceLocationLabel: 'x'.repeat(PRODUCT_SERVICE_LOCATION_LABEL_MAX_LENGTH + 1) },
      ],
      ['a blank label', { serviceLocationLabel: '' }],
    ])('refuses %s', (_label, overrides) => {
      expect(productWriteSchema.safeParse({ ...base, ...overrides }).success).toBe(false);
    });

    it('accepts exactly the bound', () => {
      const parsed = productWriteSchema.safeParse({
        ...base,
        displayLocations: Array.from({ length: PRODUCT_DISPLAY_LIST_MAX_ITEMS }, () =>
          'x'.repeat(PRODUCT_DISPLAY_LOCATION_MAX_LENGTH),
        ),
        serviceLocationLabel: 'x'.repeat(PRODUCT_SERVICE_LOCATION_LABEL_MAX_LENGTH),
      });
      expect(parsed.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // A corrupt row is refused, never rendered
  // -------------------------------------------------------------------------

  it('refuses a row whose display column is not an array of strings', async () => {
    const created = await ctx.container.products.create(tenantA, owner, {
      idempotencyKey: 'disp-corrupt-1',
      draft: draft(EMPTY_PRODUCT_DISPLAY),
    });
    /*
     * Two lines of defence, one per shape. A non-array never reaches the row:
     * `products_display_lists_check` refuses it at the table. An array holding a
     * non-string DOES reach it — `jsonb_typeof` says nothing about elements — and the
     * repository is what refuses that, naming the column, rather than handing a
     * number to a renderer as a server location.
     */
    const refused = await ctx.container.database.db
      .execute(
        sql`UPDATE products SET display_locations = '{"host": "x"}'::jsonb WHERE id = ${created.id}`,
      )
      .then(() => null)
      .catch((error: unknown) => error as { cause?: { constraint?: string } });
    expect(refused?.cause?.constraint).toBe('products_display_lists_check');

    await ctx.container.database.db.execute(
      sql`UPDATE products SET display_features = '["ok", 1]'::jsonb WHERE id = ${created.id}`,
    );
    await expect(products.findById(tenantA, created.id)).rejects.toThrow(/display_features/);

    await ctx.container.database.db.execute(
      sql`UPDATE products SET display_features = '[]'::jsonb, display_locations = '[null]'::jsonb
           WHERE id = ${created.id}`,
    );
    await expect(products.findById(tenantA, created.id)).rejects.toThrow(/display_locations/);
  });

  // -------------------------------------------------------------------------
  // Display is not routing
  // -------------------------------------------------------------------------

  it('provisions on the panel_id panel when the display locations name another panel’s host', async () => {
    const product = await ctx.container.products.create(tenantA, owner, {
      idempotencyKey: 'disp-route-1',
      draft: draft({
        displayLocations: [DECOY_HOST, `https://${DECOY_HOST}`],
        displayFeatures: [`Served from ${DECOY_HOST}`],
        serviceLocationLabel: DECOY_HOST,
      }),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());

    const key = 'disp-route';
    const created = await ctx.container.orders.createDraft(tenantA, systemActor(key), {
      idempotencyKey: `${key}-draft`,
      customerId: customerA,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId: customerA,
      orderId: created.id,
    });
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), customerA, {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id,
    });

    await ctx.container.provisionerLoop.tick();

    const service = await services.findByOrderId(tenantA, confirmed.id);
    expect(service?.state, 'the create succeeded').toBe('ACTIVE');
    // The panel the PRODUCT names, not the one its copy describes.
    expect(service?.panelId).toBe(panelA);
    expect(service?.panelId).not.toBe(decoyPanel);
    // The subscription was built from panel A's activation; the decoy host is nowhere in it.
    expect(service?.subscriptionUrl).toMatch(/^https:\/\/sub\.example\.test\//);
    expect(service?.subscriptionUrl).not.toContain(DECOY_HOST);
    // Exactly one provider create, and it reached the fake at 127.0.0.2.
    expect(
      panel.requests.filter((request) => request.path.includes('panel/api/clients/add')),
    ).toHaveLength(1);
    // And no operation was ever planned against the decoy.
    const decoyOperations = await ctx.container.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM provisioning_operations WHERE panel_id = ${decoyPanel}`,
    );
    expect(decoyOperations.rows[0]?.n).toBe(0);
  });
});
