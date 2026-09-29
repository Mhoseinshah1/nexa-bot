import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  validatePanelConnection,
  type TestContext,
} from './harness';

/**
 * A mass traffic grant end to end (round N, B2): the bulk item plans an ordinary ADD_TRAFFIC
 * operation, the EXISTING provisioner executes it against a panel (the pinned Marzban fake),
 * and only then is the item SUCCEEDED and the customer told. No new provider write path.
 */

const systemActor = (key: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: key as CorrelationId,
});

describe('a mass traffic grant through the provisioner', () => {
  let ctx: TestContext;
  let panel: FakeMarzban;
  let panelId: string;
  let owner: ActorContext;
  let customer: UserId;

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
      await createAdmin(ctx.container, tenantA, { username: 'owner-grant', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban G',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-grant-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('r'), {
      idempotencyKey: 'resolve-grant',
      telegramUserId: '920920',
      from: { id: 920920, first_name: 'Sara' },
      botInstanceId: SEED_IDS.botA1 as BotInstanceId,
    });
    customer = resolved.customer.id;
  });

  async function activeService(): Promise<{ id: string; username: string; limit: bigint }> {
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
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(250_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor('o'), {
      idempotencyKey: 'grant-draft',
      customerId: customer,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor('o'), {
      idempotencyKey: 'grant-confirm',
      customerId: customer,
      orderId: draft.id,
    });
    await ctx.container.wallet.adjust(tenantA, owner, customer, {
      idempotencyKey: 'grant-fund',
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor('o'), customer, {
      idempotencyKey: 'grant-pay',
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
    return { id: service.id, username: service.providerUsername, limit: service.trafficLimitBytes };
  }

  it('is applied on the panel by the provisioner before the item or the customer says so', async () => {
    const service = await activeService();
    const grant = { kind: 'SERVICE_TRAFFIC' as const, trafficGb: '10' };
    const definition = { version: 1 as const, service: {} };
    const preview = await ctx.container.bulkOperations.preview(tenantA, owner, {
      grant,
      definition,
    });
    expect(preview.count).toBe(1);
    const operation = await ctx.container.bulkOperations.create(tenantA, owner, {
      idempotencyKey: 'grant-op',
      grant,
      definition,
      notify: true,
      note: 'gift',
      expectedDefinitionHash: preview.definitionHash,
      expectedCount: preview.count,
      expectedFingerprint: preview.fingerprint,
      expectedTotalMinor: null,
      typedCount: preview.count,
      notBefore: null,
    });

    await ctx.container.bulkOperationProcessor.pass(tenantA);
    // Planned, not yet applied: nothing is reported and nobody is told.
    let progress = await ctx.container.bulkOperations.progress(tenantA, owner, [operation.id]);
    expect(progress.counts.get(operation.id)).toMatchObject({
      planned: 1,
      succeeded: 0,
      notified: 0,
    });

    await ctx.container.provisionerLoop.tick();
    const expected = service.limit + 10n * 1_073_741_824n;
    expect(BigInt(panel.users.get(service.username)?.dataLimit ?? 0)).toBe(expected);

    await ctx.container.bulkOperationProcessor.pass(tenantA);
    progress = await ctx.container.bulkOperations.progress(tenantA, owner, [operation.id]);
    expect(progress.counts.get(operation.id)).toMatchObject({ succeeded: 1, notified: 1 });
    expect((await ctx.container.bulkOperations.get(tenantA, owner, operation.id)).state).toBe(
      'COMPLETED',
    );
    const stored = await ctx.container.database.db.execute<{ limit: string }>(
      sql`SELECT traffic_limit_bytes::text AS limit FROM services WHERE id = ${service.id}::uuid`,
    );
    expect(BigInt(stored.rows[0]?.limit ?? '0')).toBe(expected);
    // A replayed pass plans nothing more.
    await ctx.container.bulkOperationProcessor.pass(tenantA);
    const count = await ctx.container.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM provisioning_operations WHERE type = 'ADD_TRAFFIC'`,
    );
    expect(count.rows[0]?.n).toBe(1);
  });
});
