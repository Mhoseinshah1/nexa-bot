import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIENCE_ERROR_CODES,
  BULK_ERROR_CODES,
  COMMERCE_ERROR_CODES,
  EMPTY_PRODUCT_DISPLAY,
  isNexaError,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { adminPermissionOverrides } from '../../apps/api/src/infrastructure/persistence/schema';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  validatePanelConnection,
  type TestContext,
} from './harness';

/**
 * Program §13 — the Service Operations Center, end to end over a real database, the real
 * provisioner and the pinned Marzban fake: the workspace filters, an operator's free grant
 * and move, and the mass suspend / resume with its dry run, per-item outcomes and the retry
 * of FAILED items only.
 */

const systemActor = (key: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: key as CorrelationId,
});

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (isNexaError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
};

const GB = 1_073_741_824n;
/** Every service of the tenant, whatever its customer's status: the workspace's selection. */
const ALL_SERVICES = { version: 1 as const, customerStatus: 'ANY' as const, service: {} };

describe('the Service Operations Center (program §13)', () => {
  let ctx: TestContext;
  let panel: FakeMarzban;
  let panelId: string;
  let productId: string;
  let owner: ActorContext;
  let operator: ActorContext;
  let ownerB: ActorContext;
  let keys = 0;
  const key = (prefix = 'k') => `${prefix}-${String((keys += 1)).padStart(8, '0')}`;

  beforeAll(async () => {
    ctx = await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
  }, 120_000);

  afterAll(async () => {
    await panel?.close();
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    await panel?.close();
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-soc', roleKeys: ['owner'] }),
    );
    operator = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'operator-soc',
        roleKeys: ['operator'],
      }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-soc-b', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban SOC',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-soc-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    const products = new DrizzleProductRepository(ctx.container.database.db);
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'plan',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 50n * GB, deviceLimit: null },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    productId = product.id;
  });

  /** A customer with one ACTIVE service on the fake panel, bought and provisioned for real. */
  async function activeService(telegramId: number): Promise<{
    id: string;
    username: string;
    customerId: UserId;
  }> {
    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: key('resolve'),
      telegramUserId: String(telegramId),
      from: { id: telegramId, first_name: 'Customer' },
      botInstanceId: SEED_IDS.botA1 as BotInstanceId,
    });
    const customer = resolved.customer.id;
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor('o'), {
      idempotencyKey: key('draft'),
      customerId: customer,
      productId: productId as ProductId,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor('o'), {
      idempotencyKey: key('confirm'),
      customerId: customer,
      orderId: draft.id,
    });
    await ctx.container.wallet.adjust(tenantA, owner, customer, {
      idempotencyKey: key('fund'),
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor('o'), customer, {
      idempotencyKey: key('pay'),
      orderId: confirmed.id,
    });
    await ctx.container.provisionerLoop.tick();
    const service = await new DrizzleServiceRepository(ctx.container.database.db).findByOrderId(
      tenantA,
      confirmed.id,
    );
    if (service === null || service === undefined || service.state !== 'ACTIVE') {
      throw new Error('fixture service did not become ACTIVE');
    }
    return { id: service.id, username: service.providerUsername, customerId: customer };
  }

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await ctx.container.database.db.execute(query)).rows as T[];
  }

  const stateOf = async (serviceId: string) =>
    (
      await rows<{ state: string }>(sql`SELECT state FROM services WHERE id = ${serviceId}::uuid`)
    )[0]?.state;

  const auditOf = (action: string) =>
    rows<{ result: string; actor_id: string | null; reason: string | null }>(
      sql`SELECT result, actor_id, reason FROM audit_logs
          WHERE tenant_id = ${tenantA.tenantId} AND action = ${action} ORDER BY occurred_at, id`,
    );

  async function deny(actor: ActorContext, permission: string) {
    await ctx.container.database.db.insert(adminPermissionOverrides).values({
      tenantId: tenantA.tenantId,
      adminId: actor.id as string,
      permissionKey: permission,
      effect: 'DENY',
      reason: 'test',
      expiresAt: null,
    });
  }

  /** Preview, confirm, and return the operation — the flow the workspace drives. */
  async function massStatus(kind: 'SERVICE_SUSPEND' | 'SERVICE_RESUME', actor = owner) {
    const grant = { kind };
    const preview = await ctx.container.bulkOperations.preview(tenantA, actor, {
      grant,
      definition: ALL_SERVICES,
    });
    const operation = await ctx.container.bulkOperations.create(tenantA, actor, {
      idempotencyKey: key('bulk'),
      grant,
      definition: ALL_SERVICES,
      notify: false,
      note: 'maintenance',
      expectedDefinitionHash: preview.definitionHash,
      expectedCount: preview.count,
      expectedFingerprint: preview.fingerprint,
      expectedTotalMinor: null,
      typedCount: preview.count,
      notBefore: null,
    });
    return { preview, operation };
  }

  // =====================================================================================
  // The workspace's list
  // =====================================================================================

  it('filters by product, location and expiry, and never across tenants', async () => {
    const a = await activeService(930001);
    const b = await activeService(930002);
    await ctx.container.database.db.execute(
      sql`UPDATE services SET location_key = 'de', location_label = 'Germany',
                              expires_at = now() + interval '2 days'
           WHERE id = ${a.id}::uuid`,
    );
    const list = (search: Record<string, unknown>) =>
      ctx.container.serviceAdmin
        .list(tenantA, operator, { search })
        .then((page) => page.items.map((item) => item.id).sort());
    expect(await list({ productId })).toEqual([a.id, b.id].sort());
    expect(await list({ locationKey: 'de' })).toEqual([a.id]);
    const now = ctx.container.clock.now();
    expect(
      await list({
        expiresWithin: { from: now, to: new Date(now.getTime() + 3 * 86_400_000) },
      }),
    ).toEqual([a.id]);
    // Another tenant's administrator sees none of them, with the same filter.
    const other = await ctx.container.serviceAdmin.list(tenantB, ownerB, { search: { productId } });
    expect(other.items).toEqual([]);
  });

  // =====================================================================================
  // One service: the operator's grant and move
  // =====================================================================================

  it('grants one service free traffic through the provisioner, idempotently, with a reason', async () => {
    const service = await activeService(930010);
    const before = BigInt(panel.users.get(service.username)?.dataLimit ?? 0);
    const detail = await ctx.container.serviceAdmin.detail(tenantA, owner, service.id);
    expect(detail.actions.find((entry) => entry.action === 'ADD_TRAFFIC')).toMatchObject({
      available: true,
    });

    const input = {
      idempotencyKey: key('grant'),
      kind: 'ADD_TRAFFIC' as const,
      trafficGb: '5',
      reason: 'support compensation',
    };
    const first = await ctx.container.serviceGrants.grant(tenantA, owner, service.id, input);
    const replay = await ctx.container.serviceGrants.grant(tenantA, owner, service.id, input);
    expect(replay.id).toBe(first.id);
    expect(first.state).toBe('PLANNED');
    // Nothing is applied by the request itself: the provisioner does it.
    expect(BigInt(panel.users.get(service.username)?.dataLimit ?? 0)).toBe(before);
    await ctx.container.provisionerLoop.tick();
    expect(BigInt(panel.users.get(service.username)?.dataLimit ?? 0)).toBe(before + 5n * GB);
    expect(await auditOf('service.operator_grant')).toEqual([
      expect.objectContaining({
        result: 'SUCCESS',
        actor_id: owner.id,
        reason: 'support compensation',
      }),
    ]);
    const planned = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM provisioning_operations
           WHERE service_id = ${service.id}::uuid AND type = 'ADD_TRAFFIC'`,
    );
    expect(planned[0]?.n).toBe(1);
  });

  it('refuses a grant to an operator, to another tenant, and to an unlimited service', async () => {
    const service = await activeService(930011);
    const grant = (actor: ActorContext, tenant = tenantA, id = service.id) =>
      ctx.container.serviceGrants.grant(tenant, actor, id, {
        idempotencyKey: key('grant'),
        kind: 'ADD_TIME',
        durationDays: 7,
        reason: 'x',
      });
    expect(await codeOf(grant(operator))).toMatch(/permission/u);
    expect(await auditOf('service.operator_grant')).toEqual([
      expect.objectContaining({ result: 'DENIED', actor_id: operator.id }),
    ]);
    expect(await codeOf(grant(ownerB, tenantB))).toBe(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND);
    await ctx.container.database.db.execute(
      sql`UPDATE services SET expires_at = NULL WHERE id = ${service.id}::uuid`,
    );
    const detail = await ctx.container.serviceAdmin.detail(tenantA, owner, service.id);
    expect(detail.actions.find((entry) => entry.action === 'ADD_TIME')).toMatchObject({
      available: false,
      blocker: 'UNLIMITED',
    });
    expect(await codeOf(grant(owner))).toBe(COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE);
  });

  it('offers no move on a panel that cannot move accounts, and refuses one asked for anyway', async () => {
    const service = await activeService(930012);
    const detail = await ctx.container.serviceAdmin.detail(tenantA, owner, service.id);
    const move = detail.actions.find((entry) => entry.action === 'CHANGE_LOCATION');
    // Marzban declares no CHANGE_LOCATION capability: the capability answers first.
    expect(move).toMatchObject({ available: false, blocker: 'CAPABILITY' });
    expect(
      await codeOf(
        ctx.container.locationChanges.requestFromOperator(tenantA, owner, {
          serviceId: service.id,
          locationId: ctx.container.ids.uuid(),
          reason: 'move',
          idempotencyKey: key('move'),
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE);
    expect(
      await codeOf(
        ctx.container.locationChanges.requestFromOperator(tenantA, operator, {
          serviceId: service.id,
          locationId: ctx.container.ids.uuid(),
          reason: 'move',
          idempotencyKey: key('move'),
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE);
  });

  // =====================================================================================
  // Many services: suspend / resume, the dry run, per-item outcomes, retry
  // =====================================================================================

  it('previews exactly what it executes: eligible count, the ineligible and why', async () => {
    const a = await activeService(930020);
    const b = await activeService(930021);
    const c = await activeService(930022);
    await ctx.container.database.db.execute(
      sql`UPDATE services SET state = 'SUSPENDED' WHERE id = ${c.id}::uuid`,
    );
    const { preview, operation } = await massStatus('SERVICE_SUSPEND');
    expect(preview.count).toBe(2);
    expect(preview.ineligible).toMatchObject({
      selected: 3,
      notInState: 1,
      panelNotOperable: 0,
      other: 0,
      sample: [expect.objectContaining({ serviceId: c.id, reason: 'NOT_IN_STATE' })],
    });
    const items = await ctx.container.bulkOperations.items(tenantA, owner, operation.id, {
      state: null,
      limit: 10,
      after: null,
    });
    expect(items.map((item) => item.serviceId).sort()).toEqual([a.id, b.id].sort());

    // Processed one transaction per item, then applied by the provisioner, per item.
    await ctx.container.bulkOperationProcessor.pass(tenantA);
    let progress = await ctx.container.bulkOperations.progress(tenantA, owner, [operation.id]);
    expect(progress.counts.get(operation.id)).toMatchObject({ planned: 2, succeeded: 0 });
    await ctx.container.provisionerLoop.tick();
    await ctx.container.bulkOperationProcessor.pass(tenantA);
    progress = await ctx.container.bulkOperations.progress(tenantA, owner, [operation.id]);
    expect(progress.counts.get(operation.id)).toMatchObject({ succeeded: 2, failed: 0 });
    expect(await stateOf(a.id)).toBe('SUSPENDED');
    expect(panel.users.get(a.username)?.status).toBe('disabled');
    expect((await ctx.container.bulkOperations.get(tenantA, owner, operation.id)).state).toBe(
      'COMPLETED',
    );
    // A replayed pass plans nothing more.
    await ctx.container.bulkOperationProcessor.pass(tenantA);
    const suspends = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM provisioning_operations WHERE type = 'SUSPEND'`,
    );
    expect(suspends[0]?.n).toBe(2);

    // And back again, through the resume kind.
    const resumed = await massStatus('SERVICE_RESUME');
    expect(resumed.preview.count).toBe(3);
    await ctx.container.bulkOperationProcessor.pass(tenantA);
    await ctx.container.provisionerLoop.tick();
    expect(await stateOf(a.id)).toBe('ACTIVE');
  });

  it('refuses a confirmation the set no longer matches, and writes nothing', async () => {
    const a = await activeService(930030);
    await activeService(930031);
    const grant = { kind: 'SERVICE_SUSPEND' as const };
    const preview = await ctx.container.bulkOperations.preview(tenantA, owner, {
      grant,
      definition: ALL_SERVICES,
    });
    // A service left the eligible set between the preview and the confirmation.
    await ctx.container.database.db.execute(
      sql`UPDATE services SET state = 'SUSPENDED' WHERE id = ${a.id}::uuid`,
    );
    expect(
      await codeOf(
        ctx.container.bulkOperations.create(tenantA, owner, {
          idempotencyKey: key('bulk'),
          grant,
          definition: ALL_SERVICES,
          notify: false,
          note: 'maintenance',
          expectedDefinitionHash: preview.definitionHash,
          expectedCount: preview.count,
          expectedFingerprint: preview.fingerprint,
          expectedTotalMinor: null,
          typedCount: preview.count,
          notBefore: null,
        }),
      ),
    ).toBe(AUDIENCE_ERROR_CODES.CHANGED);
    const operations = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM bulk_operations`,
    );
    expect(operations[0]?.n).toBe(0);
    // A status change notifies nobody: asking it to is refused.
    expect(
      await codeOf(
        ctx.container.bulkOperations.create(tenantA, owner, {
          idempotencyKey: key('bulk'),
          grant,
          definition: ALL_SERVICES,
          notify: true,
          note: 'maintenance',
          expectedDefinitionHash: preview.definitionHash,
          expectedCount: 1,
          expectedFingerprint: preview.fingerprint,
          expectedTotalMinor: null,
          typedCount: 1,
          notBefore: null,
        }),
      ),
    ).toBe(BULK_ERROR_CODES.NOTIFY_UNSUPPORTED);
  });

  it('records each item’s own outcome, and retries the FAILED ones only, once', async () => {
    const a = await activeService(930040);
    const b = await activeService(930041);
    const { operation } = await massStatus('SERVICE_SUSPEND');
    await ctx.container.bulkOperationProcessor.pass(tenantA);
    // B's account disappears from the panel before the provisioner gets to it.
    panel.forget(b.username);
    await ctx.container.provisionerLoop.tick();
    await ctx.container.bulkOperationProcessor.pass(tenantA);
    const items = await ctx.container.bulkOperations.items(tenantA, owner, operation.id, {
      state: null,
      limit: 10,
      after: null,
    });
    const byService = new Map(items.map((item) => [item.serviceId, item]));
    expect(byService.get(a.id)?.state).toBe('SUCCEEDED');
    expect(byService.get(b.id)?.state).toBe('FAILED');

    const preview = await ctx.container.bulkOperations.retryPreview(tenantA, owner, operation.id);
    expect(preview.count).toBe(1);
    // The account is back: the retry is a NEW operation over exactly that item.
    panel.seed({ username: b.username, status: 'active' });
    const retryKey = key('retry');
    const retry = await ctx.container.bulkOperations.retry(tenantA, owner, operation.id, {
      idempotencyKey: retryKey,
      note: 'panel restored',
      expectedCount: preview.count,
      expectedFingerprint: preview.fingerprint,
      typedCount: null,
    });
    expect(retry.retryOfId).toBe(operation.id);
    expect(retry.itemCount).toBe(1);
    // Replayed, the same retry; asked again from the original, nothing left to retry.
    const replay = await ctx.container.bulkOperations.retry(tenantA, owner, operation.id, {
      idempotencyKey: retryKey,
      note: 'panel restored',
      expectedCount: preview.count,
      expectedFingerprint: preview.fingerprint,
      typedCount: null,
    });
    expect(replay.id).toBe(retry.id);
    expect(
      (await ctx.container.bulkOperations.retryPreview(tenantA, owner, operation.id)).count,
    ).toBe(0);
    expect(
      await codeOf(
        ctx.container.bulkOperations.retry(tenantA, owner, operation.id, {
          idempotencyKey: key('retry'),
          note: 'again',
          expectedCount: 1,
          expectedFingerprint: preview.fingerprint,
          typedCount: null,
        }),
      ),
    ).toBe(BULK_ERROR_CODES.RETRY_NOTHING);

    await ctx.container.bulkOperationProcessor.pass(tenantA);
    await ctx.container.provisionerLoop.tick();
    await ctx.container.bulkOperationProcessor.pass(tenantA);
    expect(await stateOf(b.id)).toBe('SUSPENDED');
    const progress = await ctx.container.bulkOperations.progress(tenantA, owner, [retry.id]);
    expect(progress.counts.get(retry.id)).toMatchObject({ succeeded: 1 });
    // The original's history is untouched: B is still FAILED there.
    const again = await ctx.container.bulkOperations.items(tenantA, owner, operation.id, {
      state: 'FAILED',
      limit: 10,
      after: null,
    });
    expect(again.map((item) => item.serviceId)).toEqual([b.id]);
    expect(await auditOf('bulk.retry')).toEqual([
      expect.objectContaining({ result: 'SUCCESS', reason: 'panel restored' }),
    ]);
  });

  it('never retries an item whose outcome is UNKNOWN', async () => {
    const unknown = await activeService(930050);
    const { operation } = await massStatus('SERVICE_SUSPEND');
    await ctx.container.bulkOperationProcessor.pass(tenantA);
    panel.behaviour = 'server-error';
    await ctx.container.provisionerLoop.tick();
    await ctx.container.bulkOperationProcessor.pass(tenantA);
    const items = await ctx.container.bulkOperations.items(tenantA, owner, operation.id, {
      state: null,
      limit: 10,
      after: null,
    });
    // Still PLANNED behind an operation that is not FAILED: the read decides, not a retry.
    expect(items[0]?.state).toBe('PLANNED');
    expect(items[0]?.operationState).not.toBe('FAILED');
    expect(
      (await ctx.container.bulkOperations.retryPreview(tenantA, owner, operation.id)).count,
    ).toBe(0);
    // Asked directly, with the count and fingerprint that item WOULD have, still nothing.
    expect(
      await codeOf(
        ctx.container.bulkOperations.retry(tenantA, owner, operation.id, {
          idempotencyKey: key('retry'),
          note: 'force it',
          expectedCount: 1,
          expectedFingerprint: createHash('md5').update(unknown.id).digest('hex'),
          typedCount: null,
        }),
      ),
    ).toBe(BULK_ERROR_CODES.RETRY_NOTHING);
  });

  // =====================================================================================
  // Codex review of #157
  // =====================================================================================

  it('classifies an unlimited service on a healthy panel as OTHER, not as its panel', async () => {
    const service = await activeService(930070);
    await ctx.container.database.db.execute(
      sql`UPDATE services SET traffic_limit_bytes = 0 WHERE id = ${service.id}::uuid`,
    );
    const preview = await ctx.container.bulkOperations.preview(tenantA, owner, {
      grant: { kind: 'SERVICE_TRAFFIC', trafficGb: '5' },
      definition: ALL_SERVICES,
    });
    expect(preview.count).toBe(0);
    expect(preview.ineligible).toMatchObject({
      selected: 1,
      notInState: 0,
      panelNotOperable: 0,
      other: 1,
      sample: [expect.objectContaining({ serviceId: service.id, reason: 'OTHER' })],
    });
  });

  it('gives a status-only role the audience builder its form needs', async () => {
    const statusOnly = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'status-only' }),
    );
    for (const permissionKey of ['bulk_operations.view', 'services.mass.status', 'services.edit']) {
      await ctx.container.database.db.insert(adminPermissionOverrides).values({
        tenantId: tenantA.tenantId,
        adminId: statusOnly.id as string,
        permissionKey,
        effect: 'GRANT',
        reason: 'test',
        expiresAt: null,
      });
    }
    const options = await ctx.container.audience.options(tenantA, statusOnly);
    expect(options.currency).toBe('IRT');
  });

  it('answers a retry from a caller without access the same for a real and an unknown id', async () => {
    await activeService(930080);
    const { operation } = await massStatus('SERVICE_SUSPEND');
    const nobody = adminActorFor(await createAdmin(ctx.container, tenantA, { username: 'nobody' }));
    const unknown = ctx.container.ids.uuid();
    const previewCodes = [
      await codeOf(ctx.container.bulkOperations.retryPreview(tenantA, nobody, operation.id)),
      await codeOf(ctx.container.bulkOperations.retryPreview(tenantA, nobody, unknown)),
    ];
    const retry = (id: string) =>
      ctx.container.bulkOperations.retry(tenantA, nobody, id, {
        idempotencyKey: key('retry'),
        note: 'x',
        expectedCount: 1,
        expectedFingerprint: 'a'.repeat(32),
        typedCount: null,
      });
    const retryCodes = [await codeOf(retry(operation.id)), await codeOf(retry(unknown))];
    expect(previewCodes[0]).toMatch(/permission/u);
    expect(previewCodes[1]).toBe(previewCodes[0]);
    expect(retryCodes[0]).toMatch(/permission/u);
    expect(retryCodes[1]).toBe(retryCodes[0]);
    expect((await auditOf('bulk.retry')).map((row) => row.result)).toEqual(['DENIED', 'DENIED']);
  });

  it('does not offer a grant while another commercial action is open on the service', async () => {
    const service = await activeService(930090);
    await ctx.container.serviceGrants.grant(tenantA, owner, service.id, {
      idempotencyKey: key('grant'),
      kind: 'ADD_TIME',
      durationDays: 3,
      reason: 'first',
    });
    const detail = await ctx.container.serviceAdmin.detail(tenantA, owner, service.id);
    // An open ADD_TIME also blocks ADD_TRAFFIC: `prepareCommercialAction` refuses it.
    expect(detail.actions.find((entry) => entry.action === 'ADD_TRAFFIC')).toMatchObject({
      available: false,
      blocker: 'IN_PROGRESS',
    });
    expect(
      await codeOf(
        ctx.container.serviceGrants.grant(tenantA, owner, service.id, {
          idempotencyKey: key('grant'),
          kind: 'ADD_TRAFFIC',
          trafficGb: '1',
          reason: 'second',
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.SERVICE_ACTION_IN_PROGRESS);
  });

  it('charges services.mass.status AND services.edit, and keeps tenants apart', async () => {
    await activeService(930060);
    // The operator holds services.edit but not the mass key.
    expect(await codeOf(massStatus('SERVICE_SUSPEND', operator))).toMatch(/permission/u);
    // The owner without services.edit cannot do in bulk what they could not do once.
    await deny(owner, 'services.edit');
    expect(await codeOf(massStatus('SERVICE_SUSPEND', owner))).toMatch(/permission/u);
    // Another tenant's mass suspend selects none of tenant A's services.
    const preview = await ctx.container.bulkOperations.preview(tenantB, ownerB, {
      grant: { kind: 'SERVICE_SUSPEND' },
      definition: ALL_SERVICES,
    });
    expect(preview.count).toBe(0);
  });
});
