import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  COMMERCE_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  SERVICE_ROUTES,
  SESSION_COOKIE_NAME,
  money,
  serviceListResponseSchema,
  serviceOperationsResponseSchema,
  serviceResponseSchema,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type OrderId,
  type PanelId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
} from './harness';

/**
 * Services over real HTTP. The READS, which are this file's subject.
 *
 * `docs/phase4h-audit.md` §7 measured what this closes: four `services.*` permissions
 * declared since Phase 2, three seeded roles carrying two of them, real service rows
 * since 4D — and no route at all, so an operator whose role said they could view
 * services was shown a "planned" placeholder.
 *
 * What only exists at this layer:
 *
 *   - the PROJECTION, which is the one place a field the contract does not declare
 *     could become JSON. Three fields must never appear and each is a live credential:
 *     the subscription URL, the subscription ref and the provider client id;
 *   - authorization for an authenticated caller who does not hold `services.view`,
 *     because the Web Admin not drawing a link is not authorization;
 *   - tenant scope taken from the SESSION, which is what makes another tenant's
 *     service id useless rather than merely unlikely;
 *   - the ABSENCE of a transfer. Phase 6A built the operator writes — they are proved
 *     in `service-operations-http.test.ts` — and left transfer unbuilt because its
 *     product rule is undecided. The case at the bottom asserts that by asking.
 */

const ORIGIN = 'https://admin.example.test';

describe('service HTTP surface', () => {
  let api: ApiApp;
  /** A custom role holding `services.view` alone — no system role has exactly that shape. */
  let viewerCookie: string;
  /**
   * A real operator who holds no `services.*` permission at all.
   *
   * `receipt_reviewer`, not `technical` — `technical` is one of the THREE seeded roles
   * that DO carry `services.view`, which the first version of this case used and which
   * therefore asserted nothing. `receipt_reviewer` holds `payments.view`,
   * `receipts.view` and `receipts.review` and nothing else.
   */
  let reviewerCookie: string;
  let panelA: string;
  let products: DrizzleProductRepository;
  let customerA: UserId;
  let owner: ActorContext;
  let ownerB: ActorContext;

  /** The owner actor for whichever tenant a fixture is being built in. */
  const ownerFor = (scope: typeof tenantA): ActorContext =>
    scope.tenantId === tenantA.tenantId ? owner : ownerB;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig();
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(api.container.database.db);

    await createAdmin(api.container, tenantA, {
      username: 'reviewer',
      password: 'the-reviewers-password',
      roleKeys: ['receipt_reviewer'],
    });

    const viewerRoleId = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO roles (id, tenant_id, key, name, is_system)
      VALUES (${viewerRoleId}, ${tenantA.tenantId}, 'service_viewer', 'Service viewer', false)`);
    await api.container.database.db.execute(sql`
      INSERT INTO role_permissions (tenant_id, role_id, permission_key)
      VALUES (${tenantA.tenantId}, ${viewerRoleId}, 'services.view')`);
    const viewer = await createAdmin(api.container, tenantA, {
      username: 'viewer',
      password: 'the-viewers-password',
    });
    await api.container.database.db.execute(sql`
      INSERT INTO admin_roles (tenant_id, admin_id, role_id)
      VALUES (${tenantA.tenantId}, ${viewer.id}, ${viewerRoleId})`);

    owner = adminActorFor(
      await createAdmin(api.container, tenantA, {
        username: 'owner-services',
        password: 'the-owners-password',
        roleKeys: ['owner'],
      }),
    );

    ownerB = adminActorFor(
      await createAdmin(api.container, tenantB, {
        username: 'owner-services-b',
        password: 'the-owners-password',
        roleKeys: ['owner'],
      }),
    );

    panelA = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelA}, ${tenantA.tenantId}, 'Panel A', 'sanaei', 'https://panel.example.test', 'ACTIVE')`);

    viewerCookie = await cookieFor('viewer', 'the-viewers-password');
    reviewerCookie = await cookieFor('reviewer', 'the-reviewers-password');
    customerA = await customer(tenantA, SEED_IDS.botA1 as BotInstanceId, '920100');
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

  const systemActor = (correlationId: string): ActorContext => ({
    type: 'SYSTEM_JOB',
    id: null,
    label: 'telegram-update:test',
    surface: 'TELEGRAM',
    correlationId: correlationId as CorrelationId,
  });

  async function customer(
    scope: typeof tenantA,
    botInstanceId: BotInstanceId,
    telegramUserId: string,
  ): Promise<UserId> {
    const { customer: record } = await api.container.customers.resolveFromUpdate(
      scope,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: 'زهرا' },
        botInstanceId,
      },
    );
    return record.id;
  }

  /**
   * A real service row, produced the way the product produces one: a settled order.
   *
   * Not an INSERT. The projection is what this file tests, and a hand-written row is a
   * row whose shape the test author chose — the defect `docs/real-panel-acceptance.md`
   * records one layer down, where a fake and an adapter this repository wrote could
   * only prove they agreed with each other.
   */
  async function serviceFor(
    key: string,
    where: { scope: typeof tenantA; panelId: string; customerId: UserId } = {
      scope: tenantA,
      panelId: panelA,
      customerId: customerA,
    },
  ): Promise<{ serviceId: string; orderId: OrderId }> {
    const { scope, panelId, customerId } = where;
    const product = await products.create(scope, {
      id: api.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
        price: money(250_000n, 'IRT'),
      },
      now: api.container.clock.now(),
    });
    await products.setStatus(scope, product.id, 'INACTIVE', 'ACTIVE', api.container.clock.now());
    const draft = await api.container.orders.createDraft(scope, systemActor(key), {
      idempotencyKey: `${key}-draft`,
      customerId,
      productId: product.id,
    });
    const confirmed = await api.container.orders.confirm(scope, systemActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId,
      orderId: draft.id,
    });
    await api.container.wallet.adjust(scope, ownerFor(scope), customerId, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor: 500_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await api.container.payments.settleFromWallet(scope, systemActor(key), customerId, {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id,
    });
    const rows = (await api.container.database.db.execute(
      sql`SELECT id FROM services WHERE order_id = ${confirmed.id}` as never,
    )) as unknown as { rows: { id: string }[] };
    const serviceId = rows.rows[0]?.id;
    if (serviceId === undefined) throw new Error('settlement produced no service');
    return { serviceId, orderId: confirmed.id };
  }

  /**
   * A service that tenant B genuinely OWNS, built the same way tenant A's is.
   *
   * The first version of these cases re-homed a tenant A service with an `UPDATE`, and
   * the database refused it both ways round: `provisioning_operations_service_fk` is
   * composite on `(tenant_id, service_id)`, so moving the service orphans its
   * operations and moving the operations first points them at a service that is not yet
   * there. The foreign key doing exactly its job.
   *
   * Building the row properly is better than working around it. A hand-moved row is a
   * row in a state the product cannot produce, and a tenancy case that proves isolation
   * against an impossible row proves less than it appears to.
   */
  async function foreignService(key: string): Promise<string> {
    const panelB = api.container.ids.uuid();
    await api.container.database.db.execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelB}, ${tenantB.tenantId}, 'Panel B', 'sanaei', 'https://b.example.test', 'ACTIVE')`);
    const customerB = await customer(tenantB, SEED_IDS.botB1 as BotInstanceId, '920900');
    const { serviceId } = await serviceFor(key, {
      scope: tenantB,
      panelId: panelB,
      customerId: customerB,
    });
    return serviceId;
  }

  /** The envelope is `{ error: { code, ... } }`; a top-level `code` is `undefined`. */
  const errorCodeOf = (body: string): unknown =>
    (JSON.parse(body) as { error?: { code?: unknown } }).error?.code;

  const get = (path: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: { cookie, origin: ORIGIN } });

  // -------------------------------------------------------------------------
  // The projection
  // -------------------------------------------------------------------------

  it('lists a service without any of the three credentials', async () => {
    /*
     * The assertion this whole surface turns on.
     *
     * `subscriptionUrl`, `subscriptionRef` and `providerClientId` are bearer
     * capabilities: the first two fetch a working configuration and the third is what
     * a customer's configuration authenticates with. ADR-0023's rule for a panel
     * password is the same rule — a credential travels ONE way — and a list is the
     * worst place to break it, because one request would hand out every customer's
     * live configuration at once.
     *
     * Asserted against the RAW body, not the parsed one: a schema that does not declare
     * a field also does not strip it, and `JSON.parse` would keep it.
     */
    const { serviceId } = await serviceFor('svc-list');

    const response = await get(SERVICE_ROUTES.list, viewerCookie);
    expect(response.statusCode).toBe(200);
    for (const secret of ['subscriptionUrl', 'subscriptionRef', 'providerClientId']) {
      expect(response.body, `the list leaked ${secret}`).not.toContain(secret);
    }

    const body = serviceListResponseSchema.parse(JSON.parse(response.body));
    expect(body.services.map((s) => s.id)).toEqual([serviceId]);
    const [service] = body.services;
    /* The handle an operator types into the panel IS returned. It is not a secret. */
    expect(service?.providerUsername).not.toBe('');
    /* And whether there is something to send, which is all an operator needs. */
    expect(typeof service?.hasSubscription).toBe('boolean');
  });

  it('returns the detail without any of the three credentials either', async () => {
    /*
     * The absence on the list is not a paging optimisation. A detail that carried the
     * URL would make the list's omission a speed bump rather than a rule.
     */
    const { serviceId } = await serviceFor('svc-detail');

    const response = await get(SERVICE_ROUTES.detail(serviceId), viewerCookie);
    expect(response.statusCode).toBe(200);
    for (const secret of ['subscriptionUrl', 'subscriptionRef', 'providerClientId']) {
      expect(response.body, `the detail leaked ${secret}`).not.toContain(secret);
    }

    const body = serviceResponseSchema.parse(JSON.parse(response.body));
    expect(body.service.id).toBe(serviceId);
    /* The two counters that answer "why has this customer not had their link". */
    expect(body.service.deliveryAttempts).toBeGreaterThanOrEqual(0);
  });

  it('keeps delivery on its own axis', async () => {
    /*
     * `state` and `deliveryState` are two fields because they are two facts. 4D's
     * `recordDelivery` exists so a failed Telegram send cannot move a service out of
     * `ACTIVE`; a response that collapsed them would make a provisioned account whose
     * message bounced look unprovisioned, and the obvious remedy for that is to
     * provision it again — a second paid-for account on somebody's panel.
     */
    const { serviceId } = await serviceFor('svc-axes');
    const body = serviceResponseSchema.parse(
      JSON.parse((await get(SERVICE_ROUTES.detail(serviceId), viewerCookie)).body),
    );
    expect(body.service.state).toBe('PENDING_PROVISION');
    expect(body.service.deliveryState).toBe('PENDING');
  });

  it('returns byte counts as text', async () => {
    /* JSON has one number type and a byte count passes 2^53. */
    const { serviceId } = await serviceFor('svc-bytes');
    const raw = JSON.parse(
      (await get(SERVICE_ROUTES.detail(serviceId), viewerCookie)).body,
    ) as Record<string, Record<string, unknown>>;
    expect(typeof raw['service']?.['trafficLimitBytes']).toBe('string');
    expect(typeof raw['service']?.['trafficUsedBytes']).toBe('string');
  });

  // -------------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------------

  it('lists what has been attempted on one service', async () => {
    /*
     * The question an operator actually arrives with. A settled order plans a
     * `PROVISION`, so a freshly paid service has exactly one.
     */
    const { serviceId } = await serviceFor('svc-ops');
    const response = await get(SERVICE_ROUTES.operations(serviceId), viewerCookie);
    expect(response.statusCode).toBe(200);
    const body = serviceOperationsResponseSchema.parse(JSON.parse(response.body));
    expect(body.operations.map((o) => o.type)).toEqual(['PROVISION']);
    expect(body.operations[0]?.state).toBe('PLANNED');
    /* The worker's own bookkeeping is not an operator's business. */
    for (const internal of ['leaseUntil', 'claimedBy']) {
      expect(response.body, `the operations list leaked ${internal}`).not.toContain(internal);
    }
  });

  it("answers operations for another tenant's service as unknown, not as empty", async () => {
    /*
     * `listForService` takes a scope and a service id, so a foreign id would return an
     * empty list — which reads as "nothing has been attempted" rather than "this is not
     * yours". Going through the service read first makes the answer SERVICE_NOT_FOUND,
     * the same answer an id that does not exist gets.
     */
    const serviceId = await foreignService('svc-foreign-ops');

    const response = await get(SERVICE_ROUTES.operations(serviceId), viewerCookie);
    expect(response.statusCode).toBe(404);
    expect(errorCodeOf(response.body)).toBe(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND);
  });

  // -------------------------------------------------------------------------
  // Authorization and scope
  // -------------------------------------------------------------------------

  it('refuses an authenticated operator who does not hold services.view', async () => {
    /*
     * The Web Admin not drawing a link is not authorization. `receipt_reviewer` is a
     * real seeded role with a real session and no `services.*` permission at all.
     *
     * The first version used `technical`, which is one of the three seeded roles that
     * DO hold `services.view` — so it asserted nothing and passed with a 200. A
     * negative authorization case that picks the wrong role is worse than no case,
     * because it reads as coverage.
     */
    await serviceFor('svc-authz');
    for (const path of [SERVICE_ROUTES.list, SERVICE_ROUTES.detail(api.container.ids.uuid())]) {
      const response = await get(path, reviewerCookie);
      expect(response.statusCode).toBe(403);
      expect(errorCodeOf(response.body)).toBe(PLATFORM_ERROR_CODES.PERMISSION_DENIED);
    }
  });

  it('refuses an unauthenticated caller', async () => {
    const response = await inject({
      method: 'GET',
      url: `${API_PREFIX}${SERVICE_ROUTES.list}`,
      headers: { origin: ORIGIN },
    });
    expect(response.statusCode).toBe(401);
  });

  it("cannot reach another tenant's service, and says only that it is unknown", async () => {
    const serviceId = await foreignService('svc-foreign');

    const response = await get(SERVICE_ROUTES.detail(serviceId), viewerCookie);
    expect(response.statusCode).toBe(404);
    expect(errorCodeOf(response.body)).toBe(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND);

    /* And it is absent from the list, not merely unreadable by id. */
    const list = serviceListResponseSchema.parse(
      JSON.parse((await get(SERVICE_ROUTES.list, viewerCookie)).body),
    );
    expect(list.services.map((s) => s.id)).not.toContain(serviceId);
  });

  it('answers a malformed id as unknown rather than failing at the cast', async () => {
    const response = await get(SERVICE_ROUTES.detail('not-a-uuid'), viewerCookie);
    expect(response.statusCode).toBe(404);
    expect(errorCodeOf(response.body)).toBe(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND);
  });

  // -------------------------------------------------------------------------
  // Paging
  // -------------------------------------------------------------------------

  it('pages without repeating a row whose created_at carries microseconds', async () => {
    /*
     * The defect this surface would otherwise have exposed.
     *
     * `ServiceCursor.createdAt` was a `Date` until 4H, and `timestamptz` keeps
     * microseconds while a JavaScript `Date` keeps milliseconds — the driver truncates
     * rather than rounds, so the cursor lands strictly OUTSIDE the row it was built
     * from and the tuple comparison lets that row back in. `CustomerCursor` carries the
     * same measurement; this is the first caller that could see it.
     *
     * The microseconds are written by hand because a settled order stamps a millisecond
     * `Clock.now()`. That is the point: the rows that trigger it are the ones a restore,
     * an import or an ops script created, which is exactly the set nobody tests.
     */
    const older = await serviceFor('svc-page-1');
    const newer = await serviceFor('svc-page-2');
    await api.container.database.db.execute(sql`
      UPDATE services SET created_at = '2026-01-01T00:00:00.000123Z'::timestamptz
       WHERE id = ${older.serviceId}`);
    await api.container.database.db.execute(sql`
      UPDATE services SET created_at = '2026-01-01T00:00:01.000456Z'::timestamptz
       WHERE id = ${newer.serviceId}`);

    const pageOne = serviceListResponseSchema.parse(
      JSON.parse((await get(`${SERVICE_ROUTES.list}?limit=1`, viewerCookie)).body),
    );
    /* NEWEST first — owner revision 13, and the sentence `/services` prints. */
    expect(pageOne.services.map((s) => s.id)).toEqual([newer.serviceId]);
    expect(pageOne.nextCursor).not.toBeNull();

    const pageTwo = serviceListResponseSchema.parse(
      JSON.parse(
        (
          await get(
            `${SERVICE_ROUTES.list}?limit=1&cursor=${encodeURIComponent(pageOne.nextCursor ?? '')}`,
            viewerCookie,
          )
        ).body,
      ),
    );
    /* The OLDER service, not the newer one again. */
    expect(pageTwo.services.map((s) => s.id)).toEqual([older.serviceId]);

    /*
     * And the traversal TERMINATES.
     *
     * `limit=1` is the shape that turns a truncated cursor into an endless list: every
     * page re-serves the row the cursor was built from, `nextCursor` is never null, and
     * an operator pages for ever through two services. Asserted rather than assumed,
     * because the two assertions above would both pass on a cursor that was one
     * microsecond wide in the other direction.
     */
    expect(pageTwo.nextCursor).toBeNull();
  });

  /**
   * Owner revision 13, asserted against the ROWS rather than against the copy.
   *
   * `/users`, `/orders` and `/products` page ASCENDING, and this list deliberately does
   * not: the owner fixed `created_at` descending for services before the surface was
   * built, and `/services` prints that rule in words on the page. A test that only
   * checked the sentence would let the sentence and the data disagree, which is the
   * exact failure mode `docs/conventions.md` calls a truthful-UI defect.
   */
  it('serves the newest service first', async () => {
    const first = await serviceFor('svc-order-1');
    const second = await serviceFor('svc-order-2');
    const third = await serviceFor('svc-order-3');
    await api.container.database.db.execute(sql`
      UPDATE services SET created_at = '2026-02-01T00:00:00Z'::timestamptz
       WHERE id = ${first.serviceId}`);
    await api.container.database.db.execute(sql`
      UPDATE services SET created_at = '2026-02-02T00:00:00Z'::timestamptz
       WHERE id = ${second.serviceId}`);
    await api.container.database.db.execute(sql`
      UPDATE services SET created_at = '2026-02-03T00:00:00Z'::timestamptz
       WHERE id = ${third.serviceId}`);

    const page = serviceListResponseSchema.parse(
      JSON.parse((await get(SERVICE_ROUTES.list, viewerCookie)).body),
    );
    expect(page.services.map((s) => s.id)).toEqual([
      third.serviceId,
      second.serviceId,
      first.serviceId,
    ]);
  });

  it('filters by state and by customer', async () => {
    const { serviceId } = await serviceFor('svc-filter');
    const other = await customer(tenantA, SEED_IDS.botA1 as BotInstanceId, '920101');

    const byState = serviceListResponseSchema.parse(
      JSON.parse((await get(`${SERVICE_ROUTES.list}?state=ACTIVE`, viewerCookie)).body),
    );
    expect(byState.services, 'nothing has provisioned yet').toHaveLength(0);

    const byCustomer = serviceListResponseSchema.parse(
      JSON.parse((await get(`${SERVICE_ROUTES.list}?customerId=${customerA}`, viewerCookie)).body),
    );
    expect(byCustomer.services.map((s) => s.id)).toEqual([serviceId]);

    const byOther = serviceListResponseSchema.parse(
      JSON.parse((await get(`${SERVICE_ROUTES.list}?customerId=${other}`, viewerCookie)).body),
    );
    expect(byOther.services).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // What is deliberately not here
  // -------------------------------------------------------------------------

  it('offers no transfer, and asserts that by asking for one', async () => {
    /*
     * `services.transfer` is still a declared permission with NO endpoint, and that is
     * asserted by ASKING rather than by a comment.
     *
     * Phase 6A built the terminate this case used to forbid, along with six more
     * operator actions — `service-operations-http.test.ts` is where they are proved.
     * Transfer is untouched because its product rule is genuinely undecided:
     * `docs/open-questions.md` still carries what becomes of the order, the payment and
     * the subscription the previous owner holds. A route that half-worked would be the
     * legacy silent-success pattern with a customer's paid-for account attached.
     *
     * The three verbs against the detail path stay here too. Nothing in this release
     * edits a service row through it, and a `PATCH` that quietly appeared would be a
     * write path with none of the refusals the action routes apply.
     */
    const { serviceId } = await serviceFor('svc-nowrite');
    const attempts = [
      { method: 'POST', url: SERVICE_ROUTES.detail(serviceId) },
      { method: 'DELETE', url: SERVICE_ROUTES.detail(serviceId) },
      { method: 'PATCH', url: SERVICE_ROUTES.detail(serviceId) },
      { method: 'POST', url: `${SERVICE_ROUTES.detail(serviceId)}/transfer` },
    ];
    for (const attempt of attempts) {
      const response = await inject({
        method: attempt.method,
        url: `${API_PREFIX}${attempt.url}`,
        headers: { cookie: viewerCookie, origin: ORIGIN },
        payload: {},
      });
      expect(
        response.statusCode,
        `${attempt.method} ${attempt.url} is routed and must not be`,
      ).toBe(404);
    }

    /*
     * And the seven that ARE routed, named here so this case cannot go on passing by
     * the routes having been removed. A 404 from one of these would mean the surface
     * lost an action; they answer 403 because this session holds `services.view` alone.
     */
    for (const action of [
      SERVICE_ROUTES.syncUsage(serviceId),
      SERVICE_ROUTES.resend(serviceId),
      SERVICE_ROUTES.retryProvision(serviceId),
      SERVICE_ROUTES.reconcile(serviceId),
      SERVICE_ROUTES.suspend(serviceId),
      SERVICE_ROUTES.resume(serviceId),
    ]) {
      const response = await inject({
        method: 'POST',
        url: `${API_PREFIX}${action}`,
        headers: { cookie: viewerCookie, origin: ORIGIN },
        payload: { idempotencyKey: 'viewer-attempt-01' },
      });
      expect(response.statusCode, `${action} must be routed`).toBe(403);
    }
    const terminate = await inject({
      method: 'POST',
      url: `${API_PREFIX}${SERVICE_ROUTES.terminate(serviceId)}`,
      headers: { cookie: viewerCookie, origin: ORIGIN },
      payload: { idempotencyKey: 'viewer-attempt-01', confirm: 'TERMINATE' },
    });
    expect(terminate.statusCode, 'terminate must be routed').toBe(403);
  });
});
