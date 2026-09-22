import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ProductCategoryId } from '@nexa/contracts';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  COMMERCE_ERROR_CODES,
  IDENTITY_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  SERVICE_OPERATOR_ACTIONS,
  SERVICE_ROUTES,
  SERVICE_TERMINATE_CONFIRMATION,
  SESSION_COOKIE_NAME,
  money,
  serviceActionResponseSchema,
  serviceResponseSchema,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type OrderId,
  type PanelId,
  type ProductId,
  type ServiceActionBlocker,
  type ServiceOperatorAction,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  validatePanelConnection,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
} from './harness';

/**
 * The seven operator service actions, over real HTTP, against a real panel.
 *
 * Phase 6A. `services-http.test.ts` is the READS — the projection, the paging, the
 * credentials that must never appear — and it asserted, correctly for its release, that
 * this surface offered no write at all. This file is the writes, and everything about
 * them that only exists at this layer:
 *
 *   - the PERMISSION split. Terminate charges `services.terminate`, which no seeded role
 *     but `owner` holds; the other six charge `services.edit`. An `operator` session
 *     holds the second and not the first, which is what makes that split observable
 *     rather than asserted against a table;
 *   - the terminate CONFIRMATION phrase, which is the surface's own and is checked
 *     nowhere else;
 *   - the action MATRIX in the response, which is the thing a screen draws buttons
 *     from. A matrix that disagreed with the write path is the defect the evaluator
 *     exists to prevent, and it is proved here by taking the action the matrix offered
 *     and asserting the one it refused;
 *   - the re-read, which is why a planned operation shows as `IN_PROGRESS` in the same
 *     response that planned it;
 *   - idempotency across two real POSTs, tenant isolation on every action, and origin
 *     enforcement, which reads exclude by being reads.
 *
 * A MARZBAN panel, deliberately: `docs/phase4e-audit.md` records the owner's correction
 * that Marzban is the supported mutable provider. The 3X-UI panel appears too, in the
 * capability cases, because "this provider cannot suspend" is a real answer an operator
 * has to be given rather than a button that fails.
 */

const ORIGIN = 'https://admin.example.test';
const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('operator service actions over HTTP', () => {
  let api: ApiApp;
  let telegram: Server;
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let marzbanPanelId: string;
  let sanaeiPanelId: string;
  let owner: ActorContext;
  /** `owner`: every permission, including `services.terminate`. */
  let ownerCookie: string;
  /** `operator`: `services.view` and `services.edit`, and NOT `services.terminate`. */
  let editorCookie: string;
  /** A custom role holding `services.view` alone. */
  let viewerCookie: string;
  let customerA: UserId;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    /* A socket standing in for Telegram, so a resend has somewhere real to go. */
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 7 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no telegram address');

    const config = testConfig({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      /* Named, because `assertOriginAllowed` passes everything when the list is empty. */
      WEB_ADMIN_ORIGINS: ORIGIN,
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(api.container.database.db);
    services = new DrizzleServiceRepository(api.container.database.db);

    /* 127.0.0.2, not .1: the URL policy denies whatever DATABASE_URL names. */
    panel = await startFakeMarzban({ host: '127.0.0.2' });

    owner = adminActorFor(
      await createAdmin(api.container, tenantA, {
        username: 'owner-ops',
        password: 'the-owners-password',
        roleKeys: ['owner'],
      }),
    );
    await createAdmin(api.container, tenantA, {
      username: 'editor',
      password: 'the-editors-password',
      roleKeys: ['operator'],
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

    const created = await api.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-ops-create',
    });
    marzbanPanelId = created.view.panel.id;

    /*
     * A 3X-UI panel, fully configured, for the CAPABILITY cases.
     *
     * Configured deliberately: an unconfigured panel refuses everything with
     * `CREDENTIALS_MISSING`, which is a different blocker, and a capability case that
     * passed for that reason would prove nothing about capabilities.
     */
    const sanaei = await api.container.panels.create(tenantA, owner, {
      name: 'Sanaei A',
      providerType: 'sanaei',
      baseUrl: 'https://sanaei.example.test',
      credentials: { username: 'x', password: 'y' },
      activation: { subscriptionDomain: 'sub.example.test', inboundId: 3 },
      idempotencyKey: 'panel-ops-sanaei',
    });
    sanaeiPanelId = sanaei.view.panel.id;
    /*
     * And CONNECTION-TESTED, which the create alone is not.
     *
     * `panels.create` writes an ACTIVE row and contacts nothing, so since this
     * hotfix the panel is `UNVALIDATED` and cannot be sold onto — a brand-new
     * row being immediately sellable is one of the holes being closed. These
     * fake panels are real and reachable, so recording a successful connection
     * test is exactly what an operator would do next.
     */
    await validatePanelConnection(api.container, tenantA, marzbanPanelId);
    await validatePanelConnection(api.container, tenantA, sanaeiPanelId);

    ownerCookie = await cookieFor('owner-ops', 'the-owners-password');
    editorCookie = await cookieFor('editor', 'the-editors-password');
    viewerCookie = await cookieFor('viewer', 'the-viewers-password');
    customerA = await customer('910910');
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

  async function customer(
    telegramUserId: string,
    scope: typeof tenantA = tenantA,
    botInstanceId: BotInstanceId = BOT_A,
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

  /** A settled order, which is what plans a provisioning operation. */
  async function paidOrder(
    key: string,
    where: {
      scope: typeof tenantA;
      panelId: string;
      customerId: UserId;
      /* The credit is authorized, so it must be the SCOPE's own owner, not tenant A's. */
      actor?: ActorContext;
    },
  ): Promise<OrderId> {
    const { scope, panelId, customerId } = where;
    const actingOwner = where.actor ?? owner;
    const product = await products.create(scope, {
      id: api.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        /* No device limit: Marzban does not declare `LIMIT_DEVICES`. */
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
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
    await api.container.wallet.adjust(scope, actingOwner, customerId, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await api.container.payments.settleFromWallet(scope, systemActor(key), customerId, {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id,
    });
    return confirmed.id;
  }

  /** A paid order whose service has NOT been created on the panel yet. */
  async function pendingService(
    key: string,
    panelId: string = marzbanPanelId,
    customerId: UserId = customerA,
  ): Promise<string> {
    const orderId = await paidOrder(key, { scope: tenantA, panelId, customerId });
    const service = await services.findByOrderId(tenantA, orderId);
    if (service === null || service === undefined) throw new Error('settlement made no service');
    expect(service.state).toBe('PENDING_PROVISION');
    return service.id;
  }

  /** A service that exists on the real fake panel and is ACTIVE here. */
  async function activeService(key: string, customerId: UserId = customerA): Promise<string> {
    const id = await pendingService(key, marzbanPanelId, customerId);
    await api.container.provisionerLoop.tick();
    const service = await services.findById(tenantA, id);
    expect(service?.state, 'the fixture must reach ACTIVE').toBe('ACTIVE');
    return id;
  }

  const errorCodeOf = (body: string): unknown =>
    (JSON.parse(body) as { error?: { code?: unknown } }).error?.code;

  const post = (
    path: string,
    cookie: string,
    payload: Record<string, unknown>,
    headers: Record<string, string> = {},
  ) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: { cookie, origin: ORIGIN, ...headers },
      payload,
    });

  const get = (path: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: { cookie, origin: ORIGIN } });

  const matrixOf = async (
    serviceId: string,
    cookie: string = ownerCookie,
  ): Promise<Record<ServiceOperatorAction, ServiceActionBlocker | 'AVAILABLE'>> => {
    const response = await get(SERVICE_ROUTES.detail(serviceId), cookie);
    expect(response.statusCode).toBe(200);
    const body = serviceResponseSchema.parse(JSON.parse(response.body));
    return Object.fromEntries(
      body.service.actions.map((entry) => [
        entry.action,
        entry.available ? 'AVAILABLE' : (entry.blocker as ServiceActionBlocker),
      ]),
    ) as Record<ServiceOperatorAction, ServiceActionBlocker | 'AVAILABLE'>;
  };

  /** Every action route, with a body that would be accepted if it were reached. */
  const everyAction = (
    serviceId: string,
  ): { action: ServiceOperatorAction; path: string; payload: Record<string, unknown> }[] => [
    {
      action: 'SYNC_USAGE',
      path: SERVICE_ROUTES.syncUsage(serviceId),
      payload: { idempotencyKey: 'k-sync-0001' },
    },
    {
      action: 'RESEND_CONFIG',
      path: SERVICE_ROUTES.resend(serviceId),
      payload: { idempotencyKey: 'k-resend-001' },
    },
    {
      action: 'RETRY_PROVISION',
      path: SERVICE_ROUTES.retryProvision(serviceId),
      payload: { idempotencyKey: 'k-retry-0001' },
    },
    {
      action: 'RECONCILE',
      path: SERVICE_ROUTES.reconcile(serviceId),
      payload: { idempotencyKey: 'k-recon-0001' },
    },
    {
      action: 'SUSPEND',
      path: SERVICE_ROUTES.suspend(serviceId),
      payload: { idempotencyKey: 'k-susp-0001' },
    },
    {
      action: 'RESUME',
      path: SERVICE_ROUTES.resume(serviceId),
      payload: { idempotencyKey: 'k-resu-0001' },
    },
    {
      action: 'TERMINATE',
      path: SERVICE_ROUTES.terminate(serviceId),
      payload: { idempotencyKey: 'k-term-0001', confirm: SERVICE_TERMINATE_CONFIRMATION },
    },
  ];

  // -------------------------------------------------------------------------
  // The matrix, and that the writes agree with it
  // -------------------------------------------------------------------------

  it('answers the detail with a verdict for every action the contract declares', async () => {
    const serviceId = await activeService('matrix');
    const matrix = await matrixOf(serviceId);
    expect(Object.keys(matrix).sort()).toEqual([...SERVICE_OPERATOR_ACTIONS].sort());
  });

  it('offers exactly what the write paths then accept, on an ACTIVE Marzban service', async () => {
    /*
     * The assertion that makes the matrix worth computing, and the rule it encodes is
     * NOT "offered iff accepted". It is:
     *
     *   - an action the matrix marks available must be ACCEPTED. A drawn button that
     *     fails is the defect this evaluator exists to prevent;
     *   - an action refused for one of the five SETTLED reasons — the state, the
     *     provider's capabilities, the panel's configuration, nothing to send, nobody
     *     to send to — must be REFUSED. Those are the ones where waiting does not help
     *     and the write path has the same answer;
     *   - `IN_PROGRESS` is the one transient refusal, and there the write path
     *     deliberately ANSWERS with the operation that already exists rather than
     *     conflicting. The matrix does not offer it because a second tap achieves
     *     nothing; the request is idempotent because the first tap may have been lost.
     *     Asserted in the duplicate cases below.
     *
     * Each accepted action changes what the next may do, so the actions are taken
     * against a service of their own rather than in sequence against one.
     */
    const SETTLED: readonly ServiceActionBlocker[] = [
      'STATE',
      'CAPABILITY',
      'PANEL_NOT_OPERABLE',
      'NO_CONFIGURATION',
      'NO_CONTACT',
    ];

    const matrix = await matrixOf(await activeService('agree-matrix'));
    expect(matrix).toEqual({
      SYNC_USAGE: 'AVAILABLE',
      RESEND_CONFIG: 'AVAILABLE',
      /* A settled order already planned the create. There is nothing to retry yet. */
      RETRY_PROVISION: 'STATE',
      RECONCILE: 'STATE',
      SUSPEND: 'AVAILABLE',
      RESUME: 'STATE',
      TERMINATE: 'AVAILABLE',
    });

    for (const attempt of everyAction('placeholder')) {
      const serviceId = await activeService(`agree-${attempt.action}`);
      const verdict = (await matrixOf(serviceId))[attempt.action];
      const path = everyAction(serviceId).find((one) => one.action === attempt.action)?.path;
      if (path === undefined) throw new Error(`no path for ${attempt.action}`);
      const response = await post(path, ownerCookie, attempt.payload);

      if (verdict === 'AVAILABLE') {
        expect(
          response.statusCode,
          `${attempt.action} was offered and answered ${String(response.statusCode)}: ${response.body}`,
        ).toBe(201);
        continue;
      }
      if (SETTLED.includes(verdict)) {
        expect(
          response.statusCode >= 400,
          `${attempt.action} was refused as ${verdict} and answered ${String(response.statusCode)}`,
        ).toBe(true);
        continue;
      }
      expect(verdict, `${attempt.action} produced an unexpected verdict`).toBe('IN_PROGRESS');
      expect(response.statusCode, `${attempt.action}: ${response.body}`).toBe(201);
    }
  });

  it('plans a suspend, reports it as accepted rather than done, and says so in the matrix', async () => {
    /*
     * `state` is `PLANNED` and the service is still ACTIVE. That is the honest answer:
     * the provider has not been called, and a surface reporting success would claim an
     * effect that has not happened. The re-read is what makes the same response carry
     * `IN_PROGRESS` for the action just taken.
     */
    const serviceId = await activeService('suspend');

    const response = await post(SERVICE_ROUTES.suspend(serviceId), editorCookie, {
      idempotencyKey: 'suspend-once-0001',
    });
    expect(response.statusCode, response.body).toBe(201);
    const body = serviceActionResponseSchema.parse(JSON.parse(response.body));
    expect(body.operation?.type).toBe('SUSPEND');
    expect(body.operation?.state).toBe('PLANNED');
    expect(body.service.state, 'nothing has been asked of the panel yet').toBe('ACTIVE');
    expect(body.service.actions.find((entry) => entry.action === 'SUSPEND')).toEqual({
      action: 'SUSPEND',
      available: false,
      blocker: 'IN_PROGRESS',
    });
    /* And a different action is untouched by it. */
    expect(body.service.actions.find((entry) => entry.action === 'TERMINATE')?.available).toBe(
      true,
    );
  });

  it('carries the suspend through the provisioner to a SUSPENDED service that may resume', async () => {
    /*
     * End to end, because the point of the action is the effect. The operation the HTTP
     * request planned is executed by the real provisioner against the real fake panel,
     * and what the operator sees afterwards is a service that may be RESUMED and may
     * not be suspended again.
     */
    const serviceId = await activeService('suspend-through');
    await post(SERVICE_ROUTES.suspend(serviceId), editorCookie, {
      idempotencyKey: 'suspend-through-1',
    });
    await api.container.provisionerLoop.tick();

    expect((await services.findById(tenantA, serviceId))?.state).toBe('SUSPENDED');
    const matrix = await matrixOf(serviceId);
    expect(matrix.RESUME).toBe('AVAILABLE');
    expect(matrix.SUSPEND).toBe('STATE');
    expect(matrix.SYNC_USAGE, 'usage is read from ACTIVE services only').toBe('STATE');

    const resumed = await post(SERVICE_ROUTES.resume(serviceId), editorCookie, {
      idempotencyKey: 'resume-through-1',
    });
    expect(resumed.statusCode, resumed.body).toBe(201);
    await api.container.provisionerLoop.tick();
    expect((await services.findById(tenantA, serviceId))?.state).toBe('ACTIVE');
  });

  // -------------------------------------------------------------------------
  // Authorization
  // -------------------------------------------------------------------------

  it('refuses every action to a session holding services.view alone', async () => {
    /*
     * The rule `docs/conventions.md` states as never by not drawing a button. This
     * session can READ the service — it holds `services.view` — so a 403 here is the
     * write permission being charged and not the read.
     */
    const serviceId = await activeService('authz-view');
    for (const attempt of everyAction(serviceId)) {
      const response = await post(attempt.path, viewerCookie, attempt.payload);
      expect(response.statusCode, `${attempt.action}: ${response.body}`).toBe(403);
      expect(errorCodeOf(response.body), attempt.action).toBe(
        PLATFORM_ERROR_CODES.PERMISSION_DENIED,
      );
    }
  });

  it('lets services.edit act and refuses it the terminate', async () => {
    /*
     * The permission SPLIT, observed rather than asserted against a table. `operator` is
     * a seeded role holding `services.view` and `services.edit`; `services.terminate` is
     * HIGH-risk and no seeded role but `owner` carries it.
     *
     * Proved on one ACTIVE service where BOTH actions are available, so the refusal
     * cannot be the state, the panel or an open operation — only the key.
     */
    const serviceId = await activeService('authz-edit');
    const matrix = await matrixOf(serviceId, editorCookie);
    expect(matrix.SYNC_USAGE).toBe('AVAILABLE');
    expect(matrix.TERMINATE, 'the matrix is about the SERVICE, not the session').toBe('AVAILABLE');

    const terminate = await post(SERVICE_ROUTES.terminate(serviceId), editorCookie, {
      idempotencyKey: 'edit-terminate-01',
      confirm: SERVICE_TERMINATE_CONFIRMATION,
    });
    expect(terminate.statusCode).toBe(403);
    expect(errorCodeOf(terminate.body)).toBe(PLATFORM_ERROR_CODES.PERMISSION_DENIED);

    /* The same session, the same service, the action it DOES hold. */
    const sync = await post(SERVICE_ROUTES.syncUsage(serviceId), editorCookie, {
      idempotencyKey: 'edit-sync-000001',
    });
    expect(sync.statusCode, sync.body).toBe(201);

    /* And the owner's terminate on the same service is accepted. */
    const byOwner = await post(SERVICE_ROUTES.terminate(serviceId), ownerCookie, {
      idempotencyKey: 'owner-terminate-1',
      confirm: SERVICE_TERMINATE_CONFIRMATION,
    });
    expect(byOwner.statusCode, byOwner.body).toBe(201);
  });

  it('refuses an unauthenticated caller before anything else', async () => {
    const serviceId = await activeService('authn');
    for (const attempt of everyAction(serviceId)) {
      const response = await inject({
        method: 'POST',
        url: `${API_PREFIX}${attempt.path}`,
        headers: { origin: ORIGIN },
        payload: attempt.payload,
      });
      expect(response.statusCode, attempt.action).toBe(401);
    }
  });

  it('refuses a cookie-authenticated action from an unlisted origin, on every route', async () => {
    /*
     * The reads do not need this and the writes do: a cookie travels on a cross-site
     * POST, and every other write surface here asserts the same thing.
     *
     * EVERY route, not one. The origin check is a call the handler has to make, four
     * call sites make it, and a route added without it would be silently cross-site
     * writable — which one representative case cannot see. Checked before the
     * permission, so the owner's session gets 403 rather than a planned operation.
     */
    const serviceId = await activeService('origin');
    for (const attempt of everyAction(serviceId)) {
      const response = await inject({
        method: 'POST',
        url: `${API_PREFIX}${attempt.path}`,
        headers: { cookie: ownerCookie, origin: 'https://evil.example.test' },
        payload: attempt.payload,
      });
      expect(response.statusCode, `${attempt.action}: ${response.body}`).toBe(403);
      expect(errorCodeOf(response.body), attempt.action).toBe(
        IDENTITY_ERROR_CODES.AUTH_ORIGIN_REJECTED,
      );
    }
    /* And nothing happened to the service or its operations. */
    expect((await services.findById(tenantA, serviceId))?.state).toBe('ACTIVE');
    const { operations } = await api.container.serviceAdmin.operations(tenantA, owner, serviceId);
    expect(operations.map((one) => one.type)).toEqual(['PROVISION']);
  });

  // -------------------------------------------------------------------------
  // The terminate confirmation
  // -------------------------------------------------------------------------

  it('refuses a terminate whose phrase is missing, wrong or nearly right', async () => {
    /*
     * A near-miss is not a confirmation. The phrase is compared in full after trimming,
     * which is what makes a paste with a trailing newline work and a lowercase attempt
     * or a prefix not.
     */
    const serviceId = await activeService('confirm');
    for (const confirm of ['', 'terminate', 'TERMINATE ME', 'TERMINAT', 'حذف']) {
      const response = await post(SERVICE_ROUTES.terminate(serviceId), ownerCookie, {
        idempotencyKey: 'confirm-refused-1',
        confirm,
      });
      expect(response.statusCode, `"${confirm}" was accepted`).toBe(400);
      expect(errorCodeOf(response.body)).toBe(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID);
    }
    /* Nothing was planned by any of them. */
    const { operations } = await api.container.serviceAdmin.operations(tenantA, owner, serviceId);
    expect(operations.map((one) => one.type)).not.toContain('TERMINATE');

    /* The phrase with surrounding whitespace IS accepted — an operator pasted it. */
    const accepted = await post(SERVICE_ROUTES.terminate(serviceId), ownerCookie, {
      idempotencyKey: 'confirm-accepted-1',
      confirm: `  ${SERVICE_TERMINATE_CONFIRMATION}\n`,
    });
    expect(accepted.statusCode, accepted.body).toBe(201);
  });

  it('refuses a terminate with no confirm field at all, rather than treating it as empty', async () => {
    const serviceId = await activeService('confirm-absent');
    const response = await post(SERVICE_ROUTES.terminate(serviceId), ownerCookie, {
      idempotencyKey: 'confirm-absent-1',
    });
    expect(response.statusCode).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Idempotency and duplicate taps
  // -------------------------------------------------------------------------

  it('answers a repeated POST with the operation it already planned', async () => {
    /*
     * The double-click. Two requests carrying one key must leave ONE operation.
     *
     * Two mechanisms hold this and the pair of cases separates them, because a single
     * case would let either one rot unnoticed. HERE the protection is the derived
     * operation id: the key is the caller's, the id is derived from it, and a second
     * plan under the same id resolves to the row that exists. Reverting the
     * open-operation shortcut leaves this case GREEN, which is how that was measured.
     * The next case is the one the shortcut holds.
     */
    const serviceId = await activeService('dupe');
    const first = await post(SERVICE_ROUTES.suspend(serviceId), ownerCookie, {
      idempotencyKey: 'dupe-suspend-001',
    });
    const second = await post(SERVICE_ROUTES.suspend(serviceId), ownerCookie, {
      idempotencyKey: 'dupe-suspend-001',
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode, second.body).toBe(201);
    const a = serviceActionResponseSchema.parse(JSON.parse(first.body));
    const b = serviceActionResponseSchema.parse(JSON.parse(second.body));
    expect(b.operation?.id).toBe(a.operation?.id);

    const { operations } = await api.container.serviceAdmin.operations(tenantA, owner, serviceId);
    expect(operations.filter((one) => one.type === 'SUSPEND')).toHaveLength(1);
  });

  it('answers a second POST carrying a DIFFERENT key with the same open operation', async () => {
    /*
     * Two deliberate clicks, not one double-click, so the derived id differs and the
     * open-operation read is the ONLY thing standing between this and two SUSPEND rows
     * for one intent — the shape 4D's `retryProvisioning` defect had, where the panel
     * refuses the second, a refusal classifies UNKNOWN on a mutating call, and the
     * service is stranded in `UNRECONCILED` by the button meant to help it.
     *
     * This is the case that fails when the shortcut is removed.
     */
    const serviceId = await activeService('dupe-keys');
    const first = await post(SERVICE_ROUTES.suspend(serviceId), ownerCookie, {
      idempotencyKey: 'keys-suspend-001',
    });
    const second = await post(SERVICE_ROUTES.suspend(serviceId), ownerCookie, {
      idempotencyKey: 'keys-suspend-002',
    });
    const a = serviceActionResponseSchema.parse(JSON.parse(first.body));
    const b = serviceActionResponseSchema.parse(JSON.parse(second.body));
    expect(b.operation?.id).toBe(a.operation?.id);
    const { operations } = await api.container.serviceAdmin.operations(tenantA, owner, serviceId);
    expect(operations.filter((one) => one.type === 'SUSPEND')).toHaveLength(1);
  });

  it('refuses an idempotency key too short to be one', async () => {
    const serviceId = await activeService('key-short');
    const response = await post(SERVICE_ROUTES.suspend(serviceId), ownerCookie, {
      idempotencyKey: 'short',
    });
    expect(response.statusCode).toBe(400);
  });

  // -------------------------------------------------------------------------
  // States and panels that refuse
  // -------------------------------------------------------------------------

  it('tells an operator a 3X-UI panel cannot suspend, and refuses the action if they ask anyway', async () => {
    /*
     * `CAPABILITY` rather than `PANEL_NOT_OPERABLE`, and the difference is which screen
     * the operator goes to: 3X-UI has no `DISABLE_USER`, so no amount of editing this
     * panel row will produce a suspend. The panel is fully configured, so the blocker
     * cannot be a missing credential.
     *
     * And the write path refuses it independently — `PANEL_NOT_OPERABLE` with the
     * panel's own reason — because a matrix is not an authorization.
     */
    const serviceId = await pendingService('sanaei', sanaeiPanelId);
    const matrix = await matrixOf(serviceId);
    expect(matrix.TERMINATE).toBe('CAPABILITY');
    /*
     * And not because the panel is unusable: 3X-UI DOES declare `CREATE_USER`, so the
     * create planned by the settled order is open and retry reads `IN_PROGRESS` — a
     * transient answer, which is the proof that the terminate above is not one.
     */
    expect(matrix.RETRY_PROVISION).toBe('IN_PROGRESS');

    const response = await post(SERVICE_ROUTES.terminate(serviceId), ownerCookie, {
      idempotencyKey: 'sanaei-terminate-1',
      confirm: SERVICE_TERMINATE_CONFIRMATION,
    });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorCodeOf(response.body)).toBe(COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE);
  });

  it('reports a disabled panel as needing fixing, not as an unsupported provider', async () => {
    const serviceId = await activeService('disabled-panel');
    await api.container.panels.setStatus(tenantA, owner, marzbanPanelId, {
      status: 'DISABLED',
      idempotencyKey: 'disable-for-ops',
    });

    const matrix = await matrixOf(serviceId);
    expect(matrix.SUSPEND).toBe('PANEL_NOT_OPERABLE');
    expect(matrix.SYNC_USAGE).toBe('PANEL_NOT_OPERABLE');
    /* A resend touches no panel, so a disabled panel must not block it. */
    expect(matrix.RESEND_CONFIG).toBe('AVAILABLE');

    const response = await post(SERVICE_ROUTES.suspend(serviceId), ownerCookie, {
      idempotencyKey: 'disabled-suspend-1',
    });
    expect(response.statusCode).toBe(409);
    expect(errorCodeOf(response.body)).toBe(COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE);
  });

  it('offers a TERMINATED service nothing, and refuses a second terminate', async () => {
    /*
     * Terminal means terminal. A second terminate is refused HERE rather than turned
     * into a second DELETE against a panel, and the matrix says `STATE` for all seven
     * so no screen offers one.
     */
    const serviceId = await activeService('terminal');
    await post(SERVICE_ROUTES.terminate(serviceId), ownerCookie, {
      idempotencyKey: 'terminal-first-01',
      confirm: SERVICE_TERMINATE_CONFIRMATION,
    });
    await api.container.provisionerLoop.tick();
    expect((await services.findById(tenantA, serviceId))?.state).toBe('TERMINATED');

    const matrix = await matrixOf(serviceId);
    expect(new Set(Object.values(matrix))).toEqual(new Set(['STATE']));

    const again = await post(SERVICE_ROUTES.terminate(serviceId), ownerCookie, {
      idempotencyKey: 'terminal-second-1',
      confirm: SERVICE_TERMINATE_CONFIRMATION,
    });
    expect(again.statusCode).toBe(409);
    expect(errorCodeOf(again.body)).toBe(COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED);
  });

  it('refuses a retry on an UNRECONCILED service and offers the reconcile instead', async () => {
    /*
     * The rule 4D bought with a stranded service: a lost create is RECONCILED, never
     * created again. `retryProvisioning` answers `SERVICE_UNRECONCILED`, which is its
     * own refusal and not the shared one — which is exactly why retry is a separate
     * route rather than a sixth entry in the operator operation list.
     */
    const serviceId = await pendingService('unreconciled');
    await api.container.database.db.execute(sql`
      UPDATE services SET state = 'UNRECONCILED' WHERE id = ${serviceId}`);

    const matrix = await matrixOf(serviceId);
    expect(matrix.RECONCILE).toBe('AVAILABLE');
    expect(matrix.RETRY_PROVISION).toBe('STATE');

    const retry = await post(SERVICE_ROUTES.retryProvision(serviceId), ownerCookie, {
      idempotencyKey: 'unrec-retry-0001',
    });
    expect(retry.statusCode).toBe(409);
    expect(errorCodeOf(retry.body)).toBe(COMMERCE_ERROR_CODES.SERVICE_UNRECONCILED);

    const reconcile = await post(SERVICE_ROUTES.reconcile(serviceId), ownerCookie, {
      idempotencyKey: 'unrec-reconcile-1',
    });
    expect(reconcile.statusCode, reconcile.body).toBe(201);
    expect(serviceActionResponseSchema.parse(JSON.parse(reconcile.body)).operation?.type).toBe(
      'RECONCILE',
    );
  });

  // -------------------------------------------------------------------------
  // Resend
  // -------------------------------------------------------------------------

  it('resends a configuration, plans no operation, and moves no state', async () => {
    /*
     * `operation: null` is the honest answer: no provider is called. What DOES change
     * is the delivery axis, and the service's own `state` must not — 4D's
     * `recordDelivery` exists so a send cannot move a service, and a response that
     * reported otherwise would invite provisioning it again.
     */
    const serviceId = await activeService('resend');
    const before = await services.findById(tenantA, serviceId);

    const response = await post(SERVICE_ROUTES.resend(serviceId), editorCookie, {
      idempotencyKey: 'resend-once-0001',
    });
    expect(response.statusCode, response.body).toBe(201);
    const body = serviceActionResponseSchema.parse(JSON.parse(response.body));
    expect(body.operation, 'a resend plans nothing').toBeNull();
    expect(body.service.state).toBe(before?.state);
    expect(body.service.deliveryState).toBe('DELIVERED');
    /* And no credential rode along on the way out. */
    for (const secret of ['subscriptionUrl', 'subscriptionRef', 'providerClientId']) {
      expect(response.body, `the action response leaked ${secret}`).not.toContain(secret);
    }
  });

  it('refuses a resend to a BLOCKED customer rather than overriding the block', async () => {
    /*
     * The block is an operator's own instruction not to message that customer. A
     * resend that ignored it would be this surface undoing a decision made on another
     * screen, so the matrix says `NO_CONTACT` and the write path refuses.
     */
    const serviceId = await activeService('resend-blocked');
    await api.container.customers.block(tenantA, owner, {
      idempotencyKey: 'block-for-resend',
      customerId: customerA,
      reason: 'fixture',
    });

    expect((await matrixOf(serviceId)).RESEND_CONFIG).toBe('NO_CONTACT');
    const response = await post(SERVICE_ROUTES.resend(serviceId), ownerCookie, {
      idempotencyKey: 'resend-blocked-1',
    });
    expect(response.statusCode).toBe(409);
    expect(errorCodeOf(response.body)).toBe(COMMERCE_ERROR_CODES.SERVICE_NOT_DELIVERABLE);
  });

  it('refuses a resend for a service with no configuration yet', async () => {
    const serviceId = await pendingService('resend-nothing');
    expect((await matrixOf(serviceId)).RESEND_CONFIG).toBe('STATE');
    const response = await post(SERVICE_ROUTES.resend(serviceId), ownerCookie, {
      idempotencyKey: 'resend-nothing-1',
    });
    expect(response.statusCode).toBe(409);
  });

  // -------------------------------------------------------------------------
  // Tenancy
  // -------------------------------------------------------------------------

  it("answers every action on another tenant's service as unknown", async () => {
    /*
     * The scope comes from the SESSION, which is what makes a foreign service id
     * useless rather than merely unlikely. A genuinely tenant-B service, built the way
     * the product builds one, and the answer is the same 404 an id that does not exist
     * gets — never 403, which would confirm the row.
     */
    const ownerB = adminActorFor(
      await createAdmin(api.container, tenantB, {
        username: 'owner-ops-b',
        password: 'the-owners-password',
        roleKeys: ['owner'],
      }),
    );
    const panelB = await api.container.panels.create(tenantB, ownerB, {
      name: 'Sanaei B',
      providerType: 'sanaei',
      baseUrl: 'https://b.example.test',
      credentials: { username: 'x', password: 'y' },
      activation: { subscriptionDomain: 'sub-b.example.test', inboundId: 1 },
      idempotencyKey: 'panel-b-ops',
    });
    // Connection-tested like the tenant-A panels above: a create alone leaves it
    // UNVALIDATED, and this case needs tenant B to have a REAL service for the
    // 404 to be about scope rather than about a sale that never happened.
    await validatePanelConnection(api.container, tenantB, panelB.view.panel.id);
    const customerB = await customer('920920', tenantB, SEED_IDS.botB1 as BotInstanceId);
    const orderB = await paidOrder('foreign', {
      scope: tenantB,
      panelId: panelB.view.panel.id,
      customerId: customerB,
      actor: ownerB,
    });
    const foreign = await services.findByOrderId(tenantB, orderB);
    if (foreign === null || foreign === undefined) throw new Error('no tenant B service');

    for (const attempt of everyAction(foreign.id)) {
      const response = await post(attempt.path, ownerCookie, attempt.payload);
      expect(response.statusCode, `${attempt.action}: ${response.body}`).toBe(404);
      expect(errorCodeOf(response.body), attempt.action).toBe(
        COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND,
      );
    }
    /* And nothing was planned against it. */
    const { operations } = await api.container.serviceAdmin.operations(tenantB, ownerB, foreign.id);
    expect(operations.map((one) => one.type)).toEqual(['PROVISION']);
  });

  it('answers a malformed service id as unknown rather than failing at the cast', async () => {
    for (const attempt of everyAction('not-a-uuid')) {
      const response = await post(attempt.path, ownerCookie, attempt.payload);
      expect(response.statusCode, attempt.action).toBe(404);
      expect(errorCodeOf(response.body), attempt.action).toBe(
        COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND,
      );
    }
  });

  // -------------------------------------------------------------------------
  // Audit and scope activity
  // -------------------------------------------------------------------------

  it('records the real administrator as the actor, and never a fabricated one', async () => {
    /*
     * `docs/conventions.md` on fabricated actors. A Web Admin session has an
     * `ActorContext` of its own, so the audit row must name the administrator who asked
     * rather than a `SYSTEM_JOB` with the requester in a payload.
     */
    const serviceId = await activeService('audit');
    await post(SERVICE_ROUTES.suspend(serviceId), editorCookie, {
      idempotencyKey: 'audit-suspend-001',
    });

    const rows = (await api.container.database.db.execute(
      sql`SELECT actor_type, actor_id, action, entity_id, after FROM audit_logs
           WHERE action = 'service.request_suspend'` as never,
    )) as unknown as {
      rows: { actor_type: string; actor_id: string | null; entity_id: string; after: unknown }[];
    };
    expect(rows.rows).toHaveLength(1);
    const [row] = rows.rows;
    expect(row?.actor_type).toBe('WEB_ADMIN');
    expect(row?.actor_id).not.toBeNull();
    expect(row?.entity_id).toBe(serviceId);
    expect((row?.after as { requestedBy?: unknown }).requestedBy).toBe('OPERATOR');
  });

  it('refuses an action for a tenant that has stopped accepting work', async () => {
    /*
     * Read INSIDE the transaction, which is the rule every write path here follows and
     * the one the panels module was found to have skipped.
     *
     * Asserted against the APPLICATION service, not over HTTP, and that is the honest
     * place: a Web Admin session in a stopped tenant is refused at authentication, so
     * the request never reaches the transaction and a 401 would prove nothing about the
     * gate. The Telegram administrator panel will reach this same method without a Web
     * session, which is why the rule has to hold here rather than at the edge.
     */
    const serviceId = await activeService('stopped');
    await api.container.database.db.execute(sql`
      UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`);

    await expect(
      api.container.provisioning.requestFromOperator(tenantA, owner, serviceId, 'SUSPEND', {
        idempotencyKey: 'stopped-suspend-1',
      }),
    ).rejects.toThrow(/stopped accepting work/i);

    /* And nothing was planned for it. */
    const rows = (await api.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM provisioning_operations WHERE type = 'SUSPEND'` as never,
    )) as unknown as { rows: { n: number }[] };
    expect(rows.rows[0]?.n).toBe(0);
  });

  it('refuses a resend for a tenant that has stopped accepting work', async () => {
    /* The delivery path takes the same gate, through `deliver`. */
    const serviceId = await activeService('stopped-resend');
    await api.container.database.db.execute(sql`
      UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`);

    await expect(
      api.container.delivery.resendForOperator(tenantA, owner, serviceId),
    ).rejects.toThrow();
  });
});
