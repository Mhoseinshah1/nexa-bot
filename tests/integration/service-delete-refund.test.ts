import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMMERCE_ERROR_CODES,
  EMPTY_PRODUCT_DISPLAY,
  PLATFORM_ERROR_CODES,
  SESSION_COOKIE_NAME,
  isNexaError,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type OrderId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { DrizzleOperationRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-operation.repository';
import { ServiceRefundRequestsController } from '../../apps/api/src/surfaces/web/service-refund-requests.controller';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  validatePanelConnection,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * UX/Admin Fix Batch 01, item 11 — an operator's «حذف سرویس و بازگشت وجه»
 * (`docs/ux1-delete-service-refund.md`), end to end against a real PostgreSQL, the real
 * provisioner and the real Marzban adapter on a real socket.
 *
 * What it defends: «فقط حذف» credits nothing; delete-and-refund credits exactly once, and
 * only after the deletion is confirmed; a retry, a double submit and a concurrent duplicate
 * are one credit; a failed or UNKNOWN deletion credits nothing and the request says so; the
 * amount is bounded by what the customer paid; the audit names actor, service, customer,
 * amount and result; the two decision keys, the tenant and a stopped installation are all
 * enforced inside the transaction.
 */

type WebRequest = Parameters<ServiceRefundRequestsController['list']>[0];

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const CUSTOMER_TG = '930931';
const PRICE = 250_000n;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('Item 11 — an operator deletes a service and refunds it to the wallet', () => {
  let ctx: TestContext;
  let panel: FakeMarzban;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let operations: DrizzleOperationRepository;
  let panelId: string;
  let customerA: UserId;
  let owner: ActorContext;
  let ownerId: string;
  let keySeq = 0;

  beforeAll(async () => {
    ctx = await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(ctx.container.database.db);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    operations = new DrizzleOperationRepository(ctx.container.database.db);
    panel = await startFakeMarzban({ host: '127.0.0.2' });

    const seeded = await createAdmin(ctx.container, tenantA, {
      username: 'owner-delete-refund',
      roleKeys: ['owner'],
    });
    ownerId = seeded.id;
    owner = adminActorFor(seeded);

    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-delete-refund-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);

    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-delete-refund',
      telegramUserId: CUSTOMER_TG,
      from: { id: Number(CUSTOMER_TG), first_name: 'سارا' },
      botInstanceId: BOT_A,
    });
    customerA = resolved.customer.id;
  });

  /** A NEW_SERVICE order paid from the wallet, provisioned onto the panel, ACTIVE here. */
  async function activeService(key: string): Promise<{ id: string; orderId: OrderId }> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پایه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(PRICE, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(key), {
      idempotencyKey: `${key}-draft`,
      customerId: customerA,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId: customerA,
      orderId: draft.id,
    });
    await ctx.container.wallet.adjust(tenantA, owner, customerA, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor: PRICE,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), customerA, {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id,
    });
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, confirmed.id);
    if (service === undefined || service === null) throw new Error('no service');
    expect(service.state, 'the fixture must start ACTIVE').toBe('ACTIVE');
    return { id: service.id, orderId: confirmed.id };
  }

  const deleteWithRefund = (
    serviceId: string,
    amountMinor: bigint,
    idempotencyKey = `delete-refund-${String(++keySeq)}`,
    actor: ActorContext = owner,
    scope = tenantA,
  ) =>
    ctx.container.serviceRefundRequests.deleteWithRefund(scope, actor, {
      serviceId,
      amountMinor,
      idempotencyKey,
    });

  const balance = async (): Promise<bigint> =>
    (await ctx.container.wallet.balance(tenantA, owner, customerA)).amountMinor;

  const countRows = async (query: ReturnType<typeof sql>): Promise<number> => {
    const result = (await ctx.container.database.db.execute(query as never)) as unknown as {
      rows: { n: number }[];
    };
    return Number(result.rows[0]?.n ?? 0);
  };

  /** Every wallet credit a refund ever wrote, whatever refund it names. */
  const refundCredits = () =>
    countRows(
      sql`SELECT count(*)::int AS n FROM wallet_entries
           WHERE reason = 'REFUND' AND direction = 'CREDIT' AND customer_id = ${customerA}`,
    );

  const requestsFor = async (serviceId: string) =>
    (
      await ctx.container.serviceRefundRequests.list(tenantA, owner, {
        serviceId,
        limit: 100,
      })
    ).map((item) => item.request);

  const terminateOf = async (serviceId: string) =>
    (await operations.listForService(tenantA, serviceId, 50)).filter(
      (operation) => operation.type === 'TERMINATE',
    );

  const notices = (kind: string) =>
    countRows(sql`SELECT count(*)::int AS n FROM customer_notifications WHERE kind = ${kind}`);

  async function refused(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (error) {
      if (isNexaError(error)) return error.code;
      throw error;
    }
    throw new Error('expected a refusal');
  }

  async function adminWith(username: string, permissions: readonly string[]) {
    const roleId = ctx.container.ids.uuid();
    await ctx.container.database.db.execute(
      sql`INSERT INTO roles (id, tenant_id, key, name, is_system)
          VALUES (${roleId}, ${tenantA.tenantId}, ${username}, ${username}, false)` as never,
    );
    for (const permission of permissions) {
      await ctx.container.database.db.execute(
        sql`INSERT INTO role_permissions (tenant_id, role_id, permission_key)
            VALUES (${tenantA.tenantId}, ${roleId}, ${permission})` as never,
      );
    }
    const admin = await createAdmin(ctx.container, tenantA, { username });
    await ctx.container.database.db.execute(
      sql`INSERT INTO admin_roles (tenant_id, admin_id, role_id)
          VALUES (${tenantA.tenantId}, ${admin.id}, ${roleId})` as never,
    );
    return adminActorFor(admin);
  }

  // ===========================================================================

  it('deletes only: the existing terminate credits nothing and files no request', async () => {
    const service = await activeService('delete-only');
    const before = await balance();
    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'TERMINATE', {
      idempotencyKey: 'delete-only-terminate',
    });
    await ctx.container.provisionerLoop.tick();
    expect((await services.findById(tenantA, service.id))?.state).toBe('TERMINATED');
    expect(await balance(), 'no wallet credit').toBe(before);
    expect(await refundCredits()).toBe(0);
    expect(await requestsFor(service.id)).toHaveLength(0);
  });

  it('deletes and refunds: exactly one credit, written only after the deletion is confirmed', async () => {
    const service = await activeService('delete-refund');
    const username = (await services.findById(tenantA, service.id))?.providerUsername ?? '';
    const before = await balance();

    const request = await deleteWithRefund(service.id, 180_000n, 'one-credit-key');
    expect(request.state).toBe('EXECUTING');
    expect(request.origin).toBe('OPERATOR');
    expect(request.reason).toBeNull();
    expect(request.botInstanceId).toBeNull();
    expect(request.approvedAmount?.amountMinor).toBe(180_000n);
    expect(request.decidedByAdminId).toBe(ownerId);
    expect(await balance(), 'nothing credited before the deletion').toBe(before);
    expect(await refundCredits()).toBe(0);

    await ctx.container.provisionerLoop.tick();
    expect(panel.users.has(username), 'deleted on the panel').toBe(false);
    expect((await services.findById(tenantA, service.id))?.state).toBe('TERMINATED');
    await ctx.container.serviceRefundRequests.settleDue(tenantA);
    await ctx.container.provisionerLoop.tick();

    const [row] = await requestsFor(service.id);
    expect(row?.state).toBe('COMPLETED');
    expect(await balance(), 'credited once, the stated amount').toBe(before + 180_000n);
    expect(await refundCredits()).toBe(1);
    // The reference is the tracking id: the refund row, unique in the ledger.
    expect(
      await countRows(
        sql`SELECT count(*)::int AS n FROM wallet_entries
             WHERE reference = ${`${row?.refundId ?? ''}:refund`} AND actor_admin_id = ${ownerId}`,
      ),
    ).toBe(1);
    // The customer asked for nothing: told the refund, never «your request was approved».
    expect(await notices('REFUND_COMPLETED')).toBe(1);
    expect(await notices('SERVICE_REFUND_REQUEST_APPROVED')).toBe(0);
    // No review card is ever queued for an operator's own request.
    await ctx.container.relay.processBatch();
    expect(await countRows(sql`SELECT count(*)::int AS n FROM service_refund_request_pushes`)).toBe(
      0,
    );
  });

  it('answers a retry and a double submit with the same request, and credits once', async () => {
    const service = await activeService('retry');
    const before = await balance();
    const first = await deleteWithRefund(service.id, 100_000n, 'retry-key');
    const again = await deleteWithRefund(service.id, 100_000n, 'retry-key');
    expect(again.id).toBe(first.id);
    // A second key for the same service is a second command, refused: one is already running.
    expect(await refused(deleteWithRefund(service.id, 100_000n, 'other-key'))).toBe(
      COMMERCE_ERROR_CODES.SERVICE_REFUND_NOT_ELIGIBLE,
    );
    // The same key carrying another amount is not the same command.
    expect(await refused(deleteWithRefund(service.id, 90_000n, 'retry-key'))).toBe(
      COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
    );
    expect(await terminateOf(service.id)).toHaveLength(1);
    await ctx.container.provisionerLoop.tick();
    await ctx.container.serviceRefundRequests.settleDue(tenantA);
    // A retry after completion is still the same request, and still one credit.
    const late = await deleteWithRefund(service.id, 100_000n, 'retry-key');
    expect(late.id).toBe(first.id);
    expect(late.state).toBe('COMPLETED');
    expect(await refundCredits()).toBe(1);
    expect(await balance()).toBe(before + 100_000n);
  });

  it('creates one request and one credit from concurrent submits, keyed or not', async () => {
    const service = await activeService('concurrent');
    const before = await balance();
    const sameKey = await Promise.allSettled(
      Array.from({ length: 4 }, () => deleteWithRefund(service.id, 120_000n, 'same-key')),
    );
    const fulfilled = sameKey.filter((one) => one.status === 'fulfilled');
    expect(fulfilled, 'every duplicate of one command is answered').toHaveLength(4);
    expect(
      new Set(fulfilled.map((one) => (one as PromiseFulfilledResult<{ id: string }>).value.id))
        .size,
    ).toBe(1);

    const other = await activeService('concurrent-2');
    const distinct = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) => deleteWithRefund(other.id, 120_000n, `distinct-${i}`)),
    );
    expect(distinct.filter((one) => one.status === 'fulfilled')).toHaveLength(1);

    expect(
      await countRows(sql`SELECT count(*)::int AS n FROM service_refund_requests`),
      'one request per service',
    ).toBe(2);
    expect(
      await countRows(
        sql`SELECT count(*)::int AS n FROM refunds WHERE reason = 'SERVICE_REFUND_REQUEST'`,
      ),
      'one reservation per service',
    ).toBe(2);
    await ctx.container.provisionerLoop.tick();
    await ctx.container.serviceRefundRequests.settleDue(tenantA);
    expect(await refundCredits()).toBe(2);
    expect(await balance()).toBe(before + 240_000n);
  });

  it('credits nothing while the deletion is UNKNOWN, then exactly once when it is confirmed', async () => {
    const service = await activeService('unknown');
    const before = await balance();
    const request = await deleteWithRefund(service.id, 100_000n);
    // The executor's answer to a lost DELETE, forced so the sweep's reading of it is under test.
    await ctx.container.database.db.execute(
      sql`UPDATE provisioning_operations SET state = 'UNKNOWN'
           WHERE service_id = ${service.id} AND type = 'TERMINATE'` as never,
    );
    await ctx.container.serviceRefundRequests.settleDue(tenantA);
    let [row] = await requestsFor(service.id);
    expect(row?.state, 'pending: neither credited nor released').toBe('EXECUTING');
    expect(await balance()).toBe(before);
    expect(await refundCredits()).toBe(0);
    const view = await ctx.container.serviceRefundRequests.list(tenantA, owner, {
      serviceId: service.id,
      limit: 10,
    });
    expect(view[0]?.operationState, 'the UI is told why it waits').toBe('UNKNOWN');

    // The operator settles it: a plain deletion beside the ambiguous one removes the account.
    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'TERMINATE', {
      idempotencyKey: 'unknown-confirm',
    });
    await ctx.container.provisionerLoop.tick();
    await ctx.container.serviceRefundRequests.settleDue(tenantA);
    [row] = await requestsFor(service.id);
    expect(row?.id).toBe(request.id);
    expect(row?.state).toBe('COMPLETED');
    expect(await refundCredits()).toBe(1);
    expect(await balance()).toBe(before + 100_000n);
  });

  it('credits nothing while the deletion fails and is being retried', async () => {
    const service = await activeService('retrying');
    const before = await balance();
    await deleteWithRefund(service.id, 100_000n);
    panel.behaviour = 'server-error';
    await ctx.container.provisionerLoop.tick();
    await ctx.container.serviceRefundRequests.settleDue(tenantA);
    expect((await terminateOf(service.id))[0]?.state).not.toBe('SUCCEEDED');
    expect((await requestsFor(service.id))[0]?.state).toBe('EXECUTING');
    expect(await refundCredits()).toBe(0);
    expect(await balance()).toBe(before);
  });

  it('releases the reservation and credits nothing when the deletion definitively fails', async () => {
    const service = await activeService('failed');
    const before = await balance();
    await deleteWithRefund(service.id, 100_000n);
    panel.behaviour = 'bad-credentials';
    await ctx.container.provisionerLoop.tick();
    await ctx.container.serviceRefundRequests.settleDue(tenantA);
    const [row] = await requestsFor(service.id);
    expect(row?.state).toBe('FAILED');
    expect(row?.failureKind).toBe('AUTHENTICATION_FAILED');
    expect(await refundCredits()).toBe(0);
    expect(await balance()).toBe(before);
    expect((await services.findById(tenantA, service.id))?.state).toBe('ACTIVE');
    // And may be asked again once the panel works: a new command, a new single credit.
    panel.behaviour = 'healthy';
    await deleteWithRefund(service.id, 100_000n);
    await ctx.container.provisionerLoop.tick();
    await ctx.container.serviceRefundRequests.settleDue(tenantA);
    expect(await refundCredits()).toBe(1);
    expect(await balance()).toBe(before + 100_000n);
  });

  it('validates the amount: positive, and never above what the customer paid and has left', async () => {
    const service = await activeService('amounts');
    expect(await refused(deleteWithRefund(service.id, 0n))).toBe(
      COMMERCE_ERROR_CODES.REFUND_EXCEEDS_REFUNDABLE,
    );
    expect(await refused(deleteWithRefund(service.id, -5n))).toBe(
      COMMERCE_ERROR_CODES.REFUND_EXCEEDS_REFUNDABLE,
    );
    expect(await refused(deleteWithRefund(service.id, PRICE + 1n))).toBe(
      COMMERCE_ERROR_CODES.REFUND_EXCEEDS_REFUNDABLE,
    );
    expect(await requestsFor(service.id), 'a refused amount leaves no row').toHaveLength(0);
    expect(await terminateOf(service.id), 'and plans no deletion').toHaveLength(0);
    // The whole principal is allowed.
    const full = await deleteWithRefund(service.id, PRICE);
    expect(full.approvedAmount?.amountMinor).toBe(PRICE);
  });

  it('bounds the amount by what earlier refunds of the payment left', async () => {
    const service = await activeService('partial-first');
    const quote = await ctx.container.serviceRefundRequests.quoteDeleteWithRefund(
      tenantA,
      owner,
      service.id,
    );
    expect(quote.eligibility.eligible).toBe(true);
    if (!quote.eligibility.eligible) return;
    const paymentId = quote.eligibility.source.payment.id;
    // An operator's own partial refund of the same payment, made first.
    await ctx.container.refunds.request(tenantA, owner, {
      idempotencyKey: 'partial-first-refund',
      paymentId,
      amountMinor: 200_000n,
      reason: 'partial',
    });
    expect(await refused(deleteWithRefund(service.id, 50_001n))).toBe(
      COMMERCE_ERROR_CODES.REFUND_EXCEEDS_REFUNDABLE,
    );
    const ok = await deleteWithRefund(service.id, 50_000n);
    expect(ok.state).toBe('EXECUTING');
  });

  it('writes an audit row naming actor, service, customer, amount and result, with no secret', async () => {
    const service = await activeService('audit');
    const request = await deleteWithRefund(service.id, 70_000n);
    const rows = (await ctx.container.database.db.execute(
      sql`SELECT actor_id, entity_id, after, result FROM audit_logs
           WHERE action = 'service.delete_with_refund'` as never,
    )) as unknown as {
      rows: {
        actor_id: string;
        entity_id: string;
        after: Record<string, unknown>;
        result: string;
      }[];
    };
    expect(rows.rows).toHaveLength(1);
    const audit = rows.rows[0];
    expect(audit?.actor_id).toBe(ownerId);
    expect(audit?.entity_id).toBe(service.id);
    expect(audit?.result).toBe('SUCCESS');
    expect(audit?.after).toMatchObject({
      requestId: request.id,
      customerId: customerA,
      amountMinor: '70000',
      currency: 'IRT',
      destination: 'CUSTOMER_WALLET',
      refundId: request.refundId,
      operationId: request.operationId,
    });
    const text = JSON.stringify(audit?.after);
    expect(text).not.toContain(panel.password);
    expect(text).not.toMatch(/subscription|password|token/iu);
    // The completion is audited too, by the sweep.
    await ctx.container.provisionerLoop.tick();
    await ctx.container.serviceRefundRequests.settleDue(tenantA);
    expect(
      await countRows(
        sql`SELECT count(*)::int AS n FROM audit_logs
             WHERE action = 'service_refund_request.complete' AND entity_id = ${request.id}`,
      ),
    ).toBe(1);
  });

  it('requires refunds.issue AND services.terminate, and records nothing for either alone', async () => {
    const service = await activeService('permissions');
    const refundsOnly = await adminWith('refunds_only', ['refunds.issue', 'refunds.view']);
    const terminateOnly = await adminWith('terminate_only', ['services.terminate']);
    for (const actor of [refundsOnly, terminateOnly]) {
      expect(await refused(deleteWithRefund(service.id, 10_000n, undefined, actor))).toBe(
        PLATFORM_ERROR_CODES.PERMISSION_DENIED,
      );
      expect(
        await refused(
          ctx.container.serviceRefundRequests.quoteDeleteWithRefund(tenantA, actor, service.id),
        ),
      ).toBe(PLATFORM_ERROR_CODES.PERMISSION_DENIED);
    }
    expect(await requestsFor(service.id)).toHaveLength(0);
    expect(await terminateOf(service.id)).toHaveLength(0);
    const both = await adminWith('both_keys', ['refunds.issue', 'services.terminate']);
    expect((await deleteWithRefund(service.id, 10_000n, undefined, both)).state).toBe('EXECUTING');
  });

  it('cannot reach another tenant’s service', async () => {
    const service = await activeService('tenancy');
    const foreign = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-b', roleKeys: ['owner'] }),
    );
    expect(
      await refused(deleteWithRefund(service.id, 10_000n, 'tenancy-key', foreign, tenantB)),
    ).toBe(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND);
    expect(
      await refused(
        ctx.container.serviceRefundRequests.quoteDeleteWithRefund(tenantB, foreign, service.id),
      ),
    ).toBe(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND);
    expect(await requestsFor(service.id)).toHaveLength(0);
  });

  it('refuses an installation that has stopped accepting work, inside the transaction', async () => {
    const service = await activeService('stopped');
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}` as never,
    );
    try {
      expect(await refused(deleteWithRefund(service.id, 10_000n))).toBe(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
      );
    } finally {
      await ctx.container.database.db.execute(
        sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${tenantA.tenantId}` as never,
      );
    }
    expect(await requestsFor(service.id)).toHaveLength(0);
    expect(await terminateOf(service.id)).toHaveLength(0);
  });

  it('refuses beside a customer’s own open request, which is decided on its own card', async () => {
    const service = await activeService('beside-customer');
    const flags = await ctx.container.featureFlags.list(tenantA, owner);
    const current = flags.find((flag) => flag.key === 'customer_refund_requests');
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'customer_refund_requests',
      enabled: true,
      expectedVersion: current?.version ?? null,
      idempotencyKey: 'item11-flag',
      confirmKey: 'customer_refund_requests',
      reason: 'item 11 integration.',
    });
    await ctx.container.serviceRefundRequests.file(tenantA, systemActor('file'), {
      customerId: customerA,
      serviceId: service.id,
      botInstanceId: BOT_A,
      reason: 'دیگر نیازی ندارم',
      idempotencyKey: 'item11-file',
    });
    expect(await refused(deleteWithRefund(service.id, 10_000n))).toBe(
      COMMERCE_ERROR_CODES.SERVICE_REFUND_NOT_ELIGIBLE,
    );
    const quote = await ctx.container.serviceRefundRequests.quoteDeleteWithRefund(
      tenantA,
      owner,
      service.id,
    );
    expect(quote.eligibility).toEqual({ eligible: false, reason: 'ALREADY_REQUESTED' });
  });

  it('refuses a terminated service and offers no refund for it', async () => {
    const service = await activeService('ended');
    await ctx.container.provisioning.requestFromOperator(tenantA, owner, service.id, 'TERMINATE', {
      idempotencyKey: 'ended-terminate',
    });
    await ctx.container.provisionerLoop.tick();
    expect(await refused(deleteWithRefund(service.id, 10_000n))).toBe(
      COMMERCE_ERROR_CODES.SERVICE_REFUND_NOT_ELIGIBLE,
    );
    expect(await refundCredits()).toBe(0);
  });

  it('serves the quote and the command over HTTP, with the explicit confirmation required', async () => {
    const service = await activeService('http');
    const { token } = await ctx.container.auth.login(
      tenantA,
      {
        type: 'API',
        id: null,
        label: null,
        surface: 'WEB',
        correlationId: 'item11-web' as CorrelationId,
      },
      { username: 'owner-delete-refund', password: 'a-perfectly-fine-password' },
      { ip: '203.0.113.10', userAgent: 'vitest' },
    );
    const controller = new ServiceRefundRequestsController(ctx.container);
    const request = {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
      ip: '203.0.113.10',
    } as unknown as WebRequest;

    const quote = await controller.deleteWithRefundQuote(request, service.id);
    expect(quote).toMatchObject({
      serviceId: service.id,
      customerId: customerA,
      customerTelegramUserId: CUSTOMER_TG,
      customerDisplayName: 'سارا',
      eligible: true,
      reason: null,
      principalMinor: PRICE.toString(),
      remainingMinor: PRICE.toString(),
      currency: 'IRT',
    });

    // Without `confirm: true` the schema refuses before anything is read.
    await expect(
      controller.deleteWithRefund(request, service.id, {
        idempotencyKey: 'http-delete-refund',
        amountMinor: '1000',
      }),
    ).rejects.toThrow();
    expect(await requestsFor(service.id)).toHaveLength(0);

    const body = { idempotencyKey: 'http-delete-refund', amountMinor: '1000', confirm: true };
    const first = await controller.deleteWithRefund(request, service.id, body);
    const second = await controller.deleteWithRefund(request, service.id, body);
    expect(first.request.state).toBe('EXECUTING');
    expect(first.request.origin).toBe('OPERATOR');
    expect(first.request.reason).toBeNull();
    expect(first.request.approvedAmountMinor).toBe('1000');
    expect(second.request.id).toBe(first.request.id);
  });
});
