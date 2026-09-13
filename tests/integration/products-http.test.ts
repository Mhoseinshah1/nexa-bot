import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  COMMERCE_ERROR_CODES,
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
import { createAdmin, migrateOnce, resetDatabase, tenantA, tenantB, testConfig } from './harness';

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
        'createdAt',
        'deviceLimit',
        'description',
        'durationDays',
        'id',
        'panelId',
        'priceAmount',
        'priceCurrency',
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
        specification: { durationDays: 30, trafficBytes: 1n, deviceLimit: null },
        price: money(100000n, 'IRT'),
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
