import { sql } from 'drizzle-orm';
import type { ProductCategoryId } from '@nexa/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  API_PREFIX,
  AUTH_ROUTES,
  COMMERCE_ERROR_CODES,
  PANEL_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  PRODUCT_ROUTES,
  productListResponseSchema,
  productResponseSchema,
  SESSION_COOKIE_NAME,
} from '@nexa/contracts';
import { money, type PanelId, type ProductId } from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
  SEED_IDS,
} from './harness';

/**
 * Products over real HTTP.
 *
 * The rules that only exist at this layer, each a way the domain could be right and the
 * product still wrong:
 *
 *   - the response projection, the one place a field the contract does not declare could
 *     become JSON — and the one place a PANEL's configuration could leak out of a
 *     product that merely names it;
 *   - authorization for an authenticated but unprivileged caller, because the Web Admin
 *     not drawing a button is not authorization, and `catalog.view` and `catalog.edit`
 *     are two separate answers;
 *   - tenant scope taken from the SESSION and never from anything the caller can type,
 *     which is what makes another tenant's product id useless;
 *   - the price PAIR, which the schema, the application and a CHECK constraint each
 *     refuse to split — so a half-price has to be refused three times over.
 */

const ORIGIN = 'https://admin.example.test';

describe('product HTTP surface', () => {
  let api: ApiApp;
  /**
   * A custom role holding `catalog.view` + `catalog.edit`.
   *
   * Custom because NO system role but `owner` holds `catalog.edit`: `operator` and
   * `sales` carry `catalog.view` only, and `sales` adds `catalog.discounts.edit`
   * without it. That is a frozen decision — the catalogue is the owner's to curate —
   * and this suite charges the PERMISSION rather than borrowing `owner`, which holds
   * everything and would therefore prove nothing about which key the route wants.
   */
  let editorCookie: string;
  /** A custom role holding `catalog.view` ALONE — no system role has that shape. */
  let viewerCookie: string;
  /** No catalog permission at all. */
  let technicalCookie: string;
  /** A real panel in tenant A, so a product can name something that exists. */
  let panelA: string;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig();
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  });

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);

    await createAdmin(api.container, tenantA, {
      username: 'technical',
      password: 'the-technical-password',
      roleKeys: ['technical'],
    });

    /*
     * `catalog.view` WITHOUT `catalog.edit`.
     *
     * Built through the same tables the role repository writes, not a stubbed guard: a
     * stub would prove the test's own arithmetic rather than the server's.
     */
    const editorRoleId = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO roles (id, tenant_id, key, name, is_system)
      VALUES (${editorRoleId}, ${tenantA.tenantId}, 'catalog_editor', 'Catalogue editor', false)`);
    await api.container.database.db.execute(sql`
      INSERT INTO role_permissions (tenant_id, role_id, permission_key)
      VALUES (${tenantA.tenantId}, ${editorRoleId}, 'catalog.view'),
             (${tenantA.tenantId}, ${editorRoleId}, 'catalog.edit')`);
    const editor = await createAdmin(api.container, tenantA, {
      username: 'editor',
      password: 'the-editors-password',
    });
    await api.container.database.db.execute(sql`
      INSERT INTO admin_roles (tenant_id, admin_id, role_id)
      VALUES (${tenantA.tenantId}, ${editor.id}, ${editorRoleId})`);

    const viewerRoleId = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO roles (id, tenant_id, key, name, is_system)
      VALUES (${viewerRoleId}, ${tenantA.tenantId}, 'catalog_viewer', 'Catalogue viewer', false)`);
    await api.container.database.db.execute(sql`
      INSERT INTO role_permissions (tenant_id, role_id, permission_key)
      VALUES (${tenantA.tenantId}, ${viewerRoleId}, 'catalog.view')`);
    const viewer = await createAdmin(api.container, tenantA, {
      username: 'viewer',
      password: 'the-viewers-password',
    });
    await api.container.database.db.execute(sql`
      INSERT INTO admin_roles (tenant_id, admin_id, role_id)
      VALUES (${tenantA.tenantId}, ${viewer.id}, ${viewerRoleId})`);

    /*
     * A real panel row, because `products.panel_id` is a foreign key.
     *
     * Written by SQL rather than through `PanelService`: a product test that had to
     * drive the whole panel-creation path — credentials, provider resolution, a probe —
     * would fail for reasons that have nothing to do with products.
     */
    panelA = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://panel.example.test', 'ACTIVE')`);

    editorCookie = await cookieFor('editor', 'the-editors-password');
    viewerCookie = await cookieFor('viewer', 'the-viewers-password');
    technicalCookie = await cookieFor('technical', 'the-technical-password');
  });

  async function cookieFor(username: string, password: string): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password },
    });
    const header = String(response.headers['set-cookie'] ?? '');
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(header);
    if (match === null) throw new Error(`No session cookie for ${username}: ${response.body}`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  const asAdmin = (cookie: string) => ({ cookie, origin: ORIGIN });
  const get = (path: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: asAdmin(cookie) });
  const post = (path: string, cookie: string, payload: unknown) =>
    inject({ method: 'POST', url: `${API_PREFIX}${path}`, headers: asAdmin(cookie), payload });

  let keyCounter = 0;
  const idempotencyKey = () => `product-http-${(keyCounter += 1)}-${Date.now()}`;

  /** A complete, sellable product body. Individual cases override one field. */
  const body = (overrides: Record<string, unknown> = {}) => ({
    idempotencyKey: idempotencyKey(),
    title: 'پلن یک‌ماهه',
    description: null,
    audience: 'EVERYONE',
    sortOrder: 10,
    panelId: panelA,
    /*
     * Every product belongs to exactly one category, so the write schema asks for the
     * id rather than defaulting it — a default here would let a surface create an
     * uncategorised product that the order path then refuses with
     * `PRODUCT_NOT_CATEGORISED`, naming a rule the operator never chose to break.
     * `null` is still accepted by the schema and is what the deliberately-uncategorised
     * cases send.
     */
    categoryId: SEED_IDS.categoryA,
    durationDays: 30,
    trafficBytes: '53687091200',
    deviceLimit: 2,
    priceAmount: '250000',
    priceCurrency: 'IRT',
    ...overrides,
  });

  const createProduct = async (overrides: Record<string, unknown> = {}) => {
    const response = await post(PRODUCT_ROUTES.create, editorCookie, body(overrides));
    expect(response.statusCode, response.body).toBe(201);
    return productResponseSchema.parse(response.json()).product;
  };

  // -------------------------------------------------------------------------
  // The projection
  // -------------------------------------------------------------------------

  it('returns exactly the declared fields, and never the panel behind them', async () => {
    const product = await createProduct();
    const response = await get(PRODUCT_ROUTES.detail(product.id), editorCookie);
    expect(response.statusCode).toBe(200);

    const row = response.json().product as Record<string, unknown>;
    /*
     * The KEY SET, asserted exactly.
     *
     * `productSummarySchema.parse` strips unknown keys and says nothing, so the schema
     * alone cannot catch a response that grew a `panelUrl`. A product NAMES a panel and
     * the panel's address and credentials belong to `/panels` behind its own
     * permission — a catalogue row that carried them would publish an operator's panel
     * to anyone holding `catalog.view`.
     */
    expect(Object.keys(row).sort()).toEqual(
      [
        'audience',
        // WP5: the category a product is filed under — an id this tenant owns, never
        // a panel fact, so it does not widen what `catalog.view` can see.
        'categoryId',
        'createdAt',
        'deviceLimit',
        'description',
        // Customer UX completion §C: what the pre-invoice shows. Marketing copy the
        // operator typed, never a panel fact.
        'displayFeatures',
        'displayLocations',
        'durationDays',
        'id',
        'panelId',
        'priceAmount',
        'priceCurrency',
        'serviceLocationLabel',
        'sortOrder',
        'status',
        'title',
        'trafficBytes',
        'updatedAt',
      ].sort(),
    );
    for (const forbidden of ['panelUrl', 'panelToken', 'credentials', 'providerType', 'password']) {
      expect(Object.keys(row), forbidden).not.toContain(forbidden);
    }
  });

  // -------------------------------------------------------------------------
  // Display metadata over the wire (customer UX completion §C)
  // -------------------------------------------------------------------------

  it('writes an empty display for a body from the previous release, which sends none', async () => {
    /*
     * `body()` predates the three fields and deliberately still omits them: this is the
     * client on the previous release, and its write must still succeed. What it writes
     * is the empty display, which is what its form shows.
     */
    const product = await createProduct();
    expect(product.displayLocations).toEqual([]);
    expect(product.displayFeatures).toEqual([]);
    expect(product.serviceLocationLabel).toBeNull();
  });

  it('keeps the display an update from the previous release did not mention, and clears it only when told', async () => {
    /*
     * A client with no field for the three cannot mean "delete them": an edit to the
     * title from that form keeps every location and feature an operator typed. Clearing
     * is a statement — the three fields sent, empty.
     */
    const created = await createProduct({
      displayLocations: ['🇩🇪 Germany'],
      displayFeatures: ['• No logs'],
      serviceLocationLabel: 'Frankfurt',
    });
    const renamed = await post(
      PRODUCT_ROUTES.update(created.id),
      editorCookie,
      body({ title: 'پلن دوماهه' }),
    );
    expect(renamed.statusCode, renamed.body).toBe(201);
    const kept = productResponseSchema.parse(renamed.json()).product;
    expect(kept.title).toBe('پلن دوماهه');
    expect(kept.displayLocations).toEqual(['🇩🇪 Germany']);
    expect(kept.displayFeatures).toEqual(['• No logs']);
    expect(kept.serviceLocationLabel).toBe('Frankfurt');

    const cleared = await post(
      PRODUCT_ROUTES.update(created.id),
      editorCookie,
      body({ displayLocations: [], displayFeatures: [], serviceLocationLabel: null }),
    );
    expect(cleared.statusCode, cleared.body).toBe(201);
    const empty = productResponseSchema.parse(cleared.json()).product;
    expect(empty.displayLocations).toEqual([]);
    expect(empty.displayFeatures).toEqual([]);
    expect(empty.serviceLocationLabel).toBeNull();
  });

  it('round-trips the display lists in the order they were written', async () => {
    const created = await createProduct({
      displayLocations: ['🇩🇪 Germany', '🇳🇱 Netherlands', '🇫🇮 Finland'],
      displayFeatures: ['• No logs', '• Unlimited devices'],
      serviceLocationLabel: 'Frankfurt',
    });
    expect(created.displayLocations).toEqual(['🇩🇪 Germany', '🇳🇱 Netherlands', '🇫🇮 Finland']);
    expect(created.displayFeatures).toEqual(['• No logs', '• Unlimited devices']);
    expect(created.serviceLocationLabel).toBe('Frankfurt');

    // Reversed on the edit, and read back reversed: the projection copies, never sorts.
    const edited = await post(PRODUCT_ROUTES.update(created.id), editorCookie, {
      ...body({
        displayLocations: ['🇫🇮 Finland', '🇳🇱 Netherlands', '🇩🇪 Germany'],
        displayFeatures: [],
        serviceLocationLabel: null,
      }),
    });
    expect(edited.statusCode, edited.body).toBe(201);
    const after = productResponseSchema.parse(edited.json()).product;
    expect(after.displayLocations).toEqual(['🇫🇮 Finland', '🇳🇱 Netherlands', '🇩🇪 Germany']);
    expect(after.displayFeatures).toEqual([]);
    expect(after.serviceLocationLabel).toBeNull();

    const read = await get(PRODUCT_ROUTES.detail(created.id), editorCookie);
    expect(productResponseSchema.parse(read.json()).product.displayLocations).toEqual([
      '🇫🇮 Finland',
      '🇳🇱 Netherlands',
      '🇩🇪 Germany',
    ]);
  });

  it.each([
    [
      'a thirty-first location',
      { displayLocations: Array.from({ length: 31 }, (_, i) => `L${i}`) },
    ],
    ['a blank location line', { displayLocations: ['Germany', '   '] }],
    ['a location with a line break', { displayLocations: ['Germany\nFrance'] }],
    ['a location over sixty characters', { displayLocations: ['x'.repeat(61)] }],
    ['a feature over two hundred characters', { displayFeatures: ['x'.repeat(201)] }],
    ['a label over sixty characters', { serviceLocationLabel: 'x'.repeat(61) }],
    ['a blank label', { serviceLocationLabel: '' }],
  ])('refuses %s at the boundary', async (_label, overrides) => {
    const response = await post(PRODUCT_ROUTES.create, editorCookie, body(overrides));
    expect(response.statusCode, response.body).toBe(400);
  });

  it('carries the price as a STRING, so a large amount is not rounded by JSON', async () => {
    /*
     * Past 2^53, and the PRICE is where that is reachable.
     *
     * JSON has one number type and it is a double, so an amount above 2^53 comes back
     * as a different amount than the one stored. In minor units of Rial that is about
     * ninety thousand billion — large, and a number a hyperinflated currency reaches.
     *
     * `trafficBytes` is asserted as a string here too but NOT with an oversized value:
     * `MAX_TRAFFIC_BYTES` is 1 PiB, which is BELOW 2^53, so no legal traffic allowance
     * can overflow a double. Claiming otherwise would be an assertion that cannot fail
     * for the reason it names.
     */
    const product = await createProduct({ priceAmount: '9007199254740993' });
    expect(product.priceAmount).toBe('9007199254740993');
    expect(typeof product.priceAmount).toBe('string');
    expect(typeof product.trafficBytes).toBe('string');

    const stored = await api.container.database.db.execute(
      sql`SELECT price_amount FROM products WHERE id = ${product.id}`,
    );
    expect(String((stored.rows[0] as { price_amount: string }).price_amount)).toBe(
      '9007199254740993',
    );
  });

  it('narrows the list to one panel, and excludes a product that names no panel', async () => {
    /*
     * The filter the Web Admin's panel detail asks its "what does this panel
     * carry" question with.
     *
     * The second half is the part worth pinning: `panelId` is an EQUALITY on a
     * nullable column, so a product with no panel does not match — and must
     * not, because "every product on this panel" cannot include one that is on
     * no panel. An `IS NULL OR =` would put it under every panel's heading.
     */
    const second = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${second}, ${tenantA.tenantId}, 'Panel B', 'sanaei', 'https://panel-b.example.test', 'ACTIVE')`);

    const onA = await createProduct({ title: 'on A' });
    await createProduct({ title: 'on B', panelId: second });
    await createProduct({ title: 'on nothing', panelId: null });

    const filtered = productListResponseSchema.parse(
      (await get(`${PRODUCT_ROUTES.list}?panelId=${panelA}`, editorCookie)).json(),
    );
    expect(filtered.products.map((product) => product.id)).toEqual([onA.id]);

    // And the unfiltered list still has all three, so the filter narrowed rather
    // than the fixtures failing to be created.
    const all = productListResponseSchema.parse(
      (await get(PRODUCT_ROUTES.list, editorCookie)).json(),
    );
    expect(all.products).toHaveLength(3);
  });

  it('answers a malformed panel filter with 400 rather than 500', async () => {
    // `products.panel_id` is a `uuid` column, so an unvalidated string reaches
    // PostgreSQL as `invalid input syntax for type uuid` — a 500 for a caller
    // error. The boundary validates it, which is what `uuidV7Schema` is doing
    // in the query schema.
    const response = await get(`${PRODUCT_ROUTES.list}?panelId=not-a-uuid`, editorCookie);
    expect(response.statusCode).toBe(400);
  });

  it('sees nothing of another tenant through the panel filter', async () => {
    // The filter is an extra predicate, never a way around the tenant one: a
    // panel id from tenant B names a real row in `panels` and must still return
    // an empty page rather than tenant B's catalogue.
    const panelB = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelB}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://panel-b.example.test', 'ACTIVE')`);
    await api.container.database.db.execute(sql`
      INSERT INTO products (id, tenant_id, title, audience, sort_order, panel_id,
                            duration_days, traffic_bytes, device_limit,
                            price_amount, price_currency, status)
      VALUES (${api.container.ids.uuid()}, ${tenantB.tenantId}, 'theirs', 'EVERYONE', 10,
              ${panelB}, 30, 53687091200, 2, 250000, 'IRT', 'ACTIVE')`);

    const page = productListResponseSchema.parse(
      (await get(`${PRODUCT_ROUTES.list}?panelId=${panelB}`, editorCookie)).json(),
    );
    expect(page.products).toHaveLength(0);
  });

  it('refuses a traffic allowance past the contract cap', async () => {
    // `MAX_TRAFFIC_BYTES`, 1 PiB. The bound is in the schema, so this is a 400 rather
    // than a row nothing can deliver.
    const response = await post(
      PRODUCT_ROUTES.create,
      editorCookie,
      body({ trafficBytes: '1099511627776001' }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('refuses an input a column cannot hold, as a 400 naming the field', async () => {
    /*
     * Two shapes that validated and then failed in PostgreSQL, both found by the same
     * Codex review and both answered 500 with no field named.
     *
     * `priceAmount` is checked against `bigint`'s maximum: the digit regex admits
     * nineteen digits, which runs past the column by more than an order of magnitude.
     * The boundary is exactly one minor unit past the ceiling AND exactly at it, so a
     * comparison written with the wrong operator fails one of the two.
     */
    const past = await post(
      PRODUCT_ROUTES.create,
      editorCookie,
      body({ priceAmount: '9223372036854775808' }),
    );
    expect(past.statusCode, past.body).toBe(400);
    // `request.invalid`, the error filter's code for a ZodError, not a domain code:
    // the boundary refused it and no service was reached.
    expect(past.json().error.kind).toBe('VALIDATION');

    const atTheCeiling = await post(
      PRODUCT_ROUTES.create,
      editorCookie,
      body({ priceAmount: '9223372036854775807' }),
    );
    expect(atTheCeiling.statusCode, atTheCeiling.body).toBe(201);

    /*
     * `panelId` is a `uuid` column, so an unvalidated string reaches PostgreSQL as
     * `invalid input syntax for type uuid`. Four shapes, because one of them —
     * the empty string — is the one a form submits when nothing was chosen, and a
     * validator that only rejected obvious rubbish would let it through.
     */
    for (const panelId of [
      'not-a-uuid',
      '',
      '../../etc/passwd',
      '01900000-0000-4000-8000-000000000001',
    ]) {
      const response = await post(PRODUCT_ROUTES.create, editorCookie, body({ panelId }));
      expect(response.statusCode, `${panelId}: ${response.body}`).toBe(400);
      expect(response.json().error.kind).toBe('VALIDATION');
    }
  });

  // -------------------------------------------------------------------------
  // Creation and state
  // -------------------------------------------------------------------------

  it('creates every product INACTIVE, whatever the caller asks for', async () => {
    // `status` is not a field of the write schema at all, so there is no way to ask.
    // A product becomes purchasable through its own command, which is what stops one
    // call publishing an unpriced, unfulfillable plan.
    const product = await createProduct();
    expect(product.status).toBe('INACTIVE');
  });

  it('activates and deactivates, and a repeat press is a success that changes nothing', async () => {
    const product = await createProduct();

    const activated = await post(PRODUCT_ROUTES.activate(product.id), editorCookie, {
      idempotencyKey: idempotencyKey(),
    });
    expect(activated.statusCode).toBe(201);
    expect(productResponseSchema.parse(activated.json()).product.status).toBe('ACTIVE');

    // Pressed again under a DIFFERENT key, so this is a genuine second command rather
    // than an idempotency replay. It succeeds and the end state holds.
    const again = await post(PRODUCT_ROUTES.activate(product.id), editorCookie, {
      idempotencyKey: idempotencyKey(),
    });
    expect(again.statusCode).toBe(201);
    expect(productResponseSchema.parse(again.json()).product.status).toBe('ACTIVE');

    const audits = await api.container.database.db.execute(
      sql`SELECT after FROM audit_logs WHERE action = 'product.activate' ORDER BY occurred_at ASC, id ASC`,
    );
    // TWO audit rows, and the second records that nothing moved. The log distinguishes
    // "activated it" from "it was already active", which is the distinction the legacy
    // free-text activity feed could not make.
    expect(audits.rows).toHaveLength(2);
    expect((audits.rows[0] as { after: { changed: boolean } }).after.changed).toBe(true);
    expect((audits.rows[1] as { after: { changed: boolean } }).after.changed).toBe(false);
  });

  it('refuses a half price, at the boundary, in both directions', async () => {
    for (const half of [
      { priceAmount: '250000', priceCurrency: null },
      { priceAmount: null, priceCurrency: 'IRT' },
    ]) {
      const response = await post(PRODUCT_ROUTES.create, editorCookie, body(half));
      expect(response.statusCode, JSON.stringify(half)).toBe(400);
    }
    // And an absent price is fine — it means "not for sale", not "free".
    const unpriced = await createProduct({ priceAmount: null, priceCurrency: null });
    expect(unpriced.priceAmount).toBeNull();
  });

  it('refuses a price in a currency the installation does not sell in', async () => {
    /*
     * `sales.currency` was declared, rendered by the admin, and enforced by nothing.
     * `products_price_currency_check` admits the whole money vocabulary — which exists
     * for CONVERTED payment quotes, a different question from what a shop prices in —
     * so a tenant selling in Toman could hold a product priced in USD.
     *
     * A catalogue in two currencies is the legacy defect made durable: one card-to-card
     * template said تومان where its twin said ریال for the same `{price}` placeholder,
     * a factor of ten, invisible in either screen alone.
     */
    for (const currency of ['USD', 'EUR', 'USDT', 'IRR'] as const) {
      const response = await post(
        PRODUCT_ROUTES.create,
        editorCookie,
        body({ priceCurrency: currency }),
      );
      expect(response.statusCode, `${currency}: ${response.body}`).toBe(409);
      expect(response.json().error.code).toBe(COMMERCE_ERROR_CODES.PRODUCT_CURRENCY_UNSUPPORTED);
    }

    // IRR is in that list on purpose: it is a LEGAL store currency and still wrong
    // here, because this installation sells in the default IRT. A check that merely
    // rejected the non-Iranian three would pass a test built from those alone.
    const list = productListResponseSchema.parse(
      (await get(PRODUCT_ROUTES.list, editorCookie)).json(),
    );
    expect(list.products).toHaveLength(0);
  });

  it('follows the setting when it changes, and does not re-price what exists', async () => {
    /*
     * Two halves of one decision, and the second is the one worth pinning.
     *
     * The check reads `sales.currency` inside the write, so moving the store to Rial
     * makes IRR the accepted currency at once and IRT the refused one. It does NOT
     * touch products already priced: every stored amount carries its own currency, and
     * reinterpreting old amounts under a new unit is the factor of ten the setting
     * exists to prevent.
     */
    const priced = await createProduct();
    expect(priced.priceCurrency).toBe('IRT');

    await api.container.database.db.execute(sql`
      INSERT INTO setting_values (id, tenant_id, setting_key, value, version, updated_at)
      VALUES (${api.container.ids.uuid()}, ${tenantA.tenantId}, 'sales.currency',
              ${JSON.stringify('IRR')}::jsonb, 1, now())`);

    const inRial = await post(PRODUCT_ROUTES.create, editorCookie, body({ priceCurrency: 'IRR' }));
    expect(inRial.statusCode, inRial.body).toBe(201);

    const nowWrong = await post(PRODUCT_ROUTES.create, editorCookie, body());
    expect(nowWrong.statusCode).toBe(409);
    expect(nowWrong.json().error.code).toBe(COMMERCE_ERROR_CODES.PRODUCT_CURRENCY_UNSUPPORTED);

    // The already-priced product is untouched and still says what it was priced in.
    const unchanged = await get(PRODUCT_ROUTES.detail(priced.id), editorCookie);
    expect(productResponseSchema.parse(unchanged.json()).product.priceCurrency).toBe('IRT');
  });

  it('refuses a zero price, because free is not a concept here', async () => {
    const response = await post(PRODUCT_ROUTES.create, editorCookie, body({ priceAmount: '0' }));
    expect(response.statusCode).toBe(400);
  });

  // -------------------------------------------------------------------------
  // RBAC — two separate answers
  // -------------------------------------------------------------------------

  it('lets catalog.view read and refuses it every write', async () => {
    const product = await createProduct();

    expect((await get(PRODUCT_ROUTES.list, viewerCookie)).statusCode).toBe(200);
    expect((await get(PRODUCT_ROUTES.detail(product.id), viewerCookie)).statusCode).toBe(200);

    for (const [path, payload] of [
      [PRODUCT_ROUTES.create, body()],
      [PRODUCT_ROUTES.update(product.id), body()],
      [PRODUCT_ROUTES.activate(product.id), { idempotencyKey: idempotencyKey() }],
      [PRODUCT_ROUTES.deactivate(product.id), { idempotencyKey: idempotencyKey() }],
    ] as const) {
      const refused = await post(path, viewerCookie, payload);
      expect(refused.statusCode, path).toBe(403);
      expect(refused.json().error.code).toBe(PLATFORM_ERROR_CODES.PERMISSION_DENIED);
    }
  });

  it('refuses an unauthorized REPLAY, which never reaches the transaction', async () => {
    /*
     * `runAuthorizedMutation` re-checks inside the committing transaction, which is the
     * rule — and a replay returns before it ever gets there. So a caller holding only
     * `catalog.view` who guesses or observes an editor's idempotency key was answered
     * with the product, which is the write path handing out a read it does not hold.
     *
     * The key is REUSED verbatim with the same body, so this is a genuine replay of a
     * committed write rather than a fresh request that merely happens to be refused.
     */
    const key = idempotencyKey();
    const payload = { ...body(), idempotencyKey: key };
    const first = await post(PRODUCT_ROUTES.create, editorCookie, payload);
    expect(first.statusCode, first.body).toBe(201);

    const replayed = await post(PRODUCT_ROUTES.create, viewerCookie, payload);
    expect(replayed.statusCode, replayed.body).toBe(403);
    expect(replayed.json().error.code).toBe(PLATFORM_ERROR_CODES.PERMISSION_DENIED);

    // The editor's own replay still works, so the guard did not break idempotency.
    const again = await post(PRODUCT_ROUTES.create, editorCookie, payload);
    expect(again.statusCode).toBe(201);
    expect(productResponseSchema.parse(again.json()).product.id).toBe(
      productResponseSchema.parse(first.json()).product.id,
    );
  });

  it('refuses an actor with no catalog permission even the list', async () => {
    const response = await get(PRODUCT_ROUTES.list, technicalCookie);
    expect(response.statusCode).toBe(403);
  });

  it('audits a denied write, so a refusal is not silent', async () => {
    await post(PRODUCT_ROUTES.create, viewerCookie, body());
    const audits = await api.container.database.db.execute(
      sql`SELECT result, after FROM audit_logs WHERE action = 'product.create'`,
    );
    expect(audits.rows).toHaveLength(1);
    expect((audits.rows[0] as { result: string }).result).toBe('DENIED');
    expect((audits.rows[0] as { after: { deniedPermission: string } }).after.deniedPermission).toBe(
      'catalog.edit',
    );
  });

  // -------------------------------------------------------------------------
  // Tenancy
  // -------------------------------------------------------------------------

  it('cannot read, edit or activate another tenant PRODUCT', async () => {
    const mine = await createProduct();

    /*
     * Tenant B's product, written through the REAL repository.
     *
     * Not through HTTP: sign-in resolves the installation's tenant, so tenant B has no
     * session to hold — the same reason `customers-http.test.ts` builds its tenant-B
     * fixture through the repository. What is under test here is the SERVER's scoping,
     * and the fixture only has to be a genuine row in the other tenant.
     */
    const bPanel = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${bPanel}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
    const repository = new DrizzleProductRepository(api.container.database.db);
    const theirProduct = await repository.create(tenantB, {
      id: api.container.ids.uuid() as ProductId,
      draft: {
        title: 'B plan',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 5,
        panelId: bPanel as PanelId,
        /*
         * Tenant B's OWN category. `products_tenant_category_fk` is composite, so a
         * tenant B product filed under tenant A's category is refused by the database
         * — which would turn this cross-tenant isolation case into a foreign-key error
         * instead of the 404 it was written to assert.
         */
        categoryId: SEED_IDS.categoryB as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 1n, deviceLimit: null },
        price: money(100000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: api.container.clock.now(),
    });
    const theirId = theirProduct.id;

    // Tenant A's editor, holding every catalogue permission, gets 404 — not 403.
    // The row is not theirs to know exists.
    expect((await get(PRODUCT_ROUTES.detail(theirId), editorCookie)).statusCode).toBe(404);
    expect((await post(PRODUCT_ROUTES.update(theirId), editorCookie, body())).statusCode).toBe(404);
    expect(
      (
        await post(PRODUCT_ROUTES.activate(theirId), editorCookie, {
          idempotencyKey: idempotencyKey(),
        })
      ).statusCode,
    ).toBe(404);

    // And A's list holds only A's product.
    const list = productListResponseSchema.parse(
      (await get(PRODUCT_ROUTES.list, editorCookie)).json(),
    );
    expect(list.products.map((p) => p.id)).toEqual([mine.id]);
  });

  it('cannot create or edit a product onto another tenant PANEL', async () => {
    /*
     * The other direction of the same rule, and the one that was missing.
     *
     * A product cannot be READ across the tenant boundary — the test above — but until
     * the Codex review of this branch it could be WRITTEN pointing across it:
     * `products.panel_id` referenced `panels(id)`, which says the id is SOME panel in
     * the installation and nothing about whose. Everything downstream believes that
     * pointer: the fulfillable predicate, the order snapshot, and in 4D the provisioning
     * call that dials the panel and creates an account on it.
     *
     * 404 and not 403: a refusal that distinguished "not yours" from "no such panel"
     * would let an operator enumerate another installation's panel ids by watching which
     * answer comes back.
     */
    const bPanel = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${bPanel}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);

    const created = await post(PRODUCT_ROUTES.create, editorCookie, body({ panelId: bPanel }));
    expect(created.statusCode, created.body).toBe(404);
    expect(created.json().error.code).toBe(PANEL_ERROR_CODES.PANEL_NOT_FOUND);

    // A panel that exists nowhere is answered identically. That is the point.
    const absent = await post(
      PRODUCT_ROUTES.create,
      editorCookie,
      body({ panelId: '01999999-9999-7999-8999-999999999999' }),
    );
    expect(absent.statusCode).toBe(404);
    expect(absent.json().error.code).toBe(PANEL_ERROR_CODES.PANEL_NOT_FOUND);

    // Nothing was written by either refusal.
    const beforeEdit = productListResponseSchema.parse(
      (await get(PRODUCT_ROUTES.list, editorCookie)).json(),
    );
    expect(beforeEdit.products).toHaveLength(0);

    // And an EDIT cannot move a legitimate product onto that panel either — the check
    // is on both write paths, because an update reaches the same column.
    const mine = await createProduct();
    const edited = await post(
      PRODUCT_ROUTES.update(mine.id),
      editorCookie,
      body({ panelId: bPanel }),
    );
    expect(edited.statusCode, edited.body).toBe(404);
    expect(edited.json().error.code).toBe(PANEL_ERROR_CODES.PANEL_NOT_FOUND);

    const after = await get(PRODUCT_ROUTES.detail(mine.id), editorCookie);
    expect(productResponseSchema.parse(after.json()).product.panelId).toBe(panelA);
  });

  it('refuses a cross-tenant panel in the DATABASE, not only in the service', async () => {
    /*
     * The check above is a read-then-write: it can be raced by a panel deleted between
     * the read and the commit, and a later caller that forgets it is a caller with no
     * constraint at all. `products_tenant_panel_fk` (migration 0037) is the guarantee,
     * and this asserts the guarantee rather than the message.
     *
     * Raw SQL on purpose — it bypasses every application layer, which is exactly the
     * path a migration, an import or a future repository would take.
     */
    const bPanel = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${bPanel}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);

    /*
     * The RAW client, like `database-invariants.test.ts`. Drizzle's `execute` wraps a
     * driver error in "Failed query: …" and drops the constraint name, so a test
     * asserting through it could not tell THIS foreign key from any other failure —
     * including a typo in the INSERT.
     */
    const insert = async (panel: string | null) =>
      api.container.database.withClient((client) =>
        client.query(
          `INSERT INTO products (id, tenant_id, title, panel_id, duration_days, traffic_bytes)
           VALUES ($1, $2, $3, $4, 30, 1)`,
          [api.container.ids.uuid(), tenantA.tenantId, 'smuggled', panel],
        ),
      );

    await expect(insert(bPanel)).rejects.toThrowError(/products_tenant_panel_fk/);

    // NULL stays legal: MATCH SIMPLE does not enforce a composite key with a null part,
    // which is what keeps an unconfigured product a real state rather than an error.
    await insert(null);
  });

  it('answers a malformed product id with 400 rather than 500', async () => {
    // `products.id` is a `uuid` column: an unvalidated path segment reaches PostgreSQL
    // as `invalid input syntax for type uuid` and is logged as an internal failure.
    const response = await get(PRODUCT_ROUTES.detail('not-a-uuid'), editorCookie);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID);
  });

  it('reports an unknown product as 404 under its own code', async () => {
    const response = await get(
      PRODUCT_ROUTES.detail('01999999-9999-7999-8999-999999999999'),
      editorCookie,
    );
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe(COMMERCE_ERROR_CODES.PRODUCT_NOT_FOUND);
  });

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  it('creates ONE product for a repeated create, and conflicts on a reused key', async () => {
    const payload = body();
    const first = await post(PRODUCT_ROUTES.create, editorCookie, payload);
    const replay = await post(PRODUCT_ROUTES.create, editorCookie, payload);
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(productResponseSchema.parse(replay.json()).product.id).toBe(
      productResponseSchema.parse(first.json()).product.id,
    );

    const count = await api.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM products WHERE tenant_id = ${tenantA.tenantId}`,
    );
    expect((count.rows[0] as { n: number }).n).toBe(1);

    // The SAME key with a DIFFERENT payload is a conflict, not a second product.
    const reused = await post(PRODUCT_ROUTES.create, editorCookie, {
      ...payload,
      title: 'A different plan',
    });
    expect(reused.statusCode).toBe(409);
  });

  // -------------------------------------------------------------------------
  // The invariant the whole phase turns on
  // -------------------------------------------------------------------------

  it('lets an edit change the product without touching what it already was', async () => {
    const product = await createProduct();
    const edited = await post(
      PRODUCT_ROUTES.update(product.id),
      editorCookie,
      body({ title: 'پلن دوماهه', durationDays: 60, priceAmount: '400000' }),
    );
    expect(edited.statusCode).toBe(201);

    const after = productResponseSchema.parse(edited.json()).product;
    expect(after.id).toBe(product.id);
    expect(after.title).toBe('پلن دوماهه');
    expect(after.durationDays).toBe(60);
    expect(after.priceAmount).toBe('400000');
    // Creation time is not an editable property; `updatedAt` moved and `createdAt` did not.
    expect(after.createdAt).toBe(product.createdAt);

    const audits = await api.container.database.db.execute(
      sql`SELECT before, after FROM audit_logs WHERE action = 'product.update'`,
    );
    // A before AND an after, which is what `/admin/logs` could not answer in the legacy
    // system: its audit entry was a free-text sentence with neither.
    const row = audits.rows[0] as { before: { title: string }; after: { title: string } };
    expect(row.before.title).toBe('پلن یک‌ماهه');
    expect(row.after.title).toBe('پلن دوماهه');
  });
});
