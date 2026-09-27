import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_PRODUCT_DISPLAY,
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
import { DrizzleDiagnosticsReader } from '../../apps/api/src/modules/platform/system/infrastructure/drizzle-diagnostics.reader';
import type { Database } from '../../apps/api/src/infrastructure/persistence/database';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
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
 * WP16 D2 (`docs/wp16-admin-ops-audit.md`): the diagnostics read.
 *
 * Every row here is a REAL one — a paid order through the shipped container plans its
 * PROVISION and writes its outbox messages — and the test only moves a row into the
 * state a sweep would find it in, so what is asserted is the read's predicates against
 * the schema, not against a fixture shaped to pass. Nothing is ticked: no panel is
 * contacted, and the read itself changes no row.
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

describe('system diagnostics', () => {
  let ctx: TestContext;
  let panel: FakeRickpanel;
  let products: DrizzleProductRepository;
  let panelId: string;
  let customerId: UserId;
  let owner: ActorContext;

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
    panel = await startFakeRickpanel({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-diag', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Rick',
      providerType: 'rickpanel',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: {},
      idempotencyKey: 'panel-diag-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    const resolved = await ctx.container.customers.resolveFromUpdate(tenantA, systemActor('d'), {
      idempotencyKey: 'resolve-diag',
      telegramUserId: '930930',
      from: { id: 930930, first_name: 'Diag' },
      botInstanceId: BOT_A,
    });
    customerId = resolved.customer.id;
  });

  async function paidOrder(key: string): Promise<OrderId> {
    const product = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 1_073_741_824n, deviceLimit: null },
        price: money(10_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(tenantA, product.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor(key), {
      idempotencyKey: `${key}-draft`,
      customerId,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor(key), {
      idempotencyKey: `${key}-confirm`,
      customerId,
      orderId: draft.id,
    });
    await ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: `${key}-credit`,
      direction: 'CREDIT',
      amountMinor: 100_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor(key), customerId, {
      idempotencyKey: `${key}-pay`,
      orderId: confirmed.id,
    });
    return confirmed.id;
  }

  const provisionFor = async (orderId: OrderId): Promise<string> => {
    const rows = await ctx.container.database.db.execute<{ id: string }>(sql`
      SELECT o.id FROM provisioning_operations o
        JOIN services s ON s.id = o.service_id AND s.tenant_id = o.tenant_id
       WHERE s.order_id = ${orderId} AND o.type = 'PROVISION'`);
    const id = rows.rows[0]?.id;
    if (id === undefined) throw new Error('no PROVISION planned');
    return id;
  };

  const exec = (statement: ReturnType<typeof sql>) => ctx.container.database.db.execute(statement);

  it('reports nothing stuck for a freshly planned operation, and the unpublished outbox as pending', async () => {
    await paidOrder('fresh');
    const found = await ctx.container.diagnostics.read(tenantA, owner);
    expect(found.provisioning.counts).toEqual({
      UNKNOWN_OUTCOME: 0,
      LEASE_EXPIRED: 0,
      RETRYING: 0,
      UNANNOUNCED: 0,
    });
    expect(found.provisioning.sample).toEqual([]);
    // The relay was not run, so the order's events are still pending, and none failed.
    expect(found.outbox.pending).toBeGreaterThan(0);
    expect(found.outbox.oldestPendingAt).not.toBeNull();
    expect(found.outbox.failing).toBe(0);
  });

  it('classifies each stuck operation under exactly one reason, as the sweeps would find it', async () => {
    const retrying = await provisionFor(await paidOrder('retrying'));
    const leased = await provisionFor(await paidOrder('leased'));
    const unknown = await provisionFor(await paidOrder('unknown'));
    const unannounced = await provisionFor(await paidOrder('unannounced'));

    await exec(sql`UPDATE provisioning_operations SET attempts = 2 WHERE id = ${retrying}`);
    await exec(sql`UPDATE provisioning_operations
                      SET state = 'IN_FLIGHT', attempts = 1, claimed_by = 'dead-worker',
                          lease_until = now() - interval '5 minutes'
                    WHERE id = ${leased}`);
    await exec(sql`UPDATE provisioning_operations
                      SET state = 'UNKNOWN', attempts = 1
                    WHERE id = ${unknown}`);
    await exec(sql`UPDATE provisioning_operations
                      SET state = 'SUCCEEDED', attempts = 1, next_attempt_at = NULL,
                          completed_at = now() - interval '1 hour', announced_at = NULL
                    WHERE id = ${unannounced}`);

    const found = await ctx.container.diagnostics.read(tenantA, owner);
    expect(found.provisioning.counts).toEqual({
      UNKNOWN_OUTCOME: 1,
      LEASE_EXPIRED: 1,
      RETRYING: 1,
      UNANNOUNCED: 1,
    });
    const reasons = Object.fromEntries(
      found.provisioning.sample.map((row) => [row.operationId, row.reason]),
    );
    expect(reasons).toEqual({
      [retrying]: 'RETRYING',
      [leased]: 'LEASE_EXPIRED',
      [unknown]: 'UNKNOWN_OUTCOME',
      [unannounced]: 'UNANNOUNCED',
    });

    // An announced terminal operation, and one inside the grace, are not stuck.
    await exec(
      sql`UPDATE provisioning_operations SET announced_at = now() WHERE id = ${unannounced}`,
    );
    await exec(sql`UPDATE provisioning_operations SET lease_until = now() + interval '5 minutes'
                    WHERE id = ${leased}`);
    const after = await ctx.container.diagnostics.read(tenantA, owner);
    expect(after.provisioning.counts.UNANNOUNCED).toBe(0);
    expect(after.provisioning.counts.LEASE_EXPIRED).toBe(0);
  });

  it('shows a failing outbox message without payload, and with URLs removed from its error', async () => {
    await paidOrder('outbox');
    const [first] = (
      await exec(sql`SELECT id FROM outbox_messages WHERE tenant_id = ${tenantA.tenantId}
                      ORDER BY occurred_at, sequence LIMIT 1`)
    ).rows as { id: string }[];
    await exec(sql`UPDATE outbox_messages
                      SET attempts = 3,
                          last_error = 'consumer failed delivering https://sub.example.test/sub/secret-token?x=1 to panel'
                    WHERE id = ${first?.id ?? ''}`);

    const found = await ctx.container.diagnostics.read(tenantA, owner);
    expect(found.outbox.failing).toBe(1);
    expect(found.outbox.failingSample).toHaveLength(1);
    const [row] = found.outbox.failingSample;
    expect(row).toMatchObject({ id: first?.id, attempts: 3 });
    expect(row?.lastError).toBe('consumer failed delivering [url] to panel');
    expect(JSON.stringify(found)).not.toContain('secret-token');
    expect(Object.keys(row ?? {})).not.toContain('payload');
  });

  it('shows tenant B nothing of tenant A, and refuses an actor without opslog.view', async () => {
    await paidOrder('isolation');
    const foreign = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-b', roleKeys: ['owner'] }),
    );
    const other = await ctx.container.diagnostics.read(tenantB, foreign);
    expect(other.outbox.pending).toBe(0);
    expect(other.provisioning.sample).toEqual([]);

    const support = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'support-d', roleKeys: ['support'] }),
    );
    await expect(ctx.container.diagnostics.read(tenantA, support)).rejects.toMatchObject({
      kind: 'PERMISSION_DENIED',
    });
  });

  it('shows tenant B none of tenant A’s stuck operations or failing messages', async () => {
    // Tenant A has one of each: an operation stuck in UNKNOWN and an outbox message that keeps
    // failing. The isolation test above only reads pending counts, which cannot see a sample.
    const unknown = await provisionFor(await paidOrder('iso-stuck'));
    await exec(sql`UPDATE provisioning_operations SET state = 'UNKNOWN', attempts = 1
                    WHERE id = ${unknown}`);
    await exec(sql`UPDATE outbox_messages SET attempts = 3, last_error = 'consumer failed'
                    WHERE tenant_id = ${tenantA.tenantId}`);
    const mine = await ctx.container.diagnostics.read(tenantA, owner);
    expect(mine.provisioning.counts.UNKNOWN_OUTCOME).toBe(1);
    expect(mine.outbox.failingSample.length).toBeGreaterThan(0);

    const foreign = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-b-iso', roleKeys: ['owner'] }),
    );
    const other = await ctx.container.diagnostics.read(tenantB, foreign);
    expect(other.provisioning.counts.UNKNOWN_OUTCOME).toBe(0);
    expect(other.provisioning.sample).toEqual([]);
    expect(other.outbox.failing).toBe(0);
    expect(other.outbox.failingSample).toEqual([]);
  });

  /**
   * The database, with a commit from ANOTHER connection landed right after the reader's
   * first statement — whether that statement ran inside a transaction or straight on the
   * pool. Under one repeatable-read snapshot the reader's second statement cannot see it;
   * read statement by statement, the count and the sample would describe two moments.
   * (Codex review of #81.)
   */
  function racing(db: Database, inject: () => Promise<unknown>) {
    let fired = false;
    const configs: unknown[] = [];
    const afterFirst = <T extends { execute: (...args: never[]) => Promise<unknown> }>(
      target: T,
    ): T =>
      new Proxy(target, {
        get(inner, property, receiver) {
          if (property !== 'execute') return Reflect.get(inner, property, receiver) as unknown;
          return async (...args: never[]) => {
            const out = await inner.execute(...args);
            if (!fired) {
              fired = true;
              await inject();
            }
            return out;
          };
        },
      });
    const proxied = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return (fn: (tx: never) => Promise<unknown>, config: unknown) => {
            configs.push(config);
            return target.transaction((tx) => fn(afterFirst(tx) as never), config as never);
          };
        }
        if (property === 'execute') return afterFirst(target).execute;
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    return { db: proxied, configs };
  }

  it('reads the outbox count and its sample as one observation', async () => {
    await paidOrder('snap-outbox');
    const [first] = (
      await exec(sql`SELECT id FROM outbox_messages WHERE tenant_id = ${tenantA.tenantId}
                      ORDER BY occurred_at, sequence LIMIT 1`)
    ).rows as { id: string }[];
    const { db, configs } = racing(ctx.container.database.db, () =>
      exec(sql`UPDATE outbox_messages SET attempts = 3, last_error = 'boom'
                WHERE id = ${first?.id ?? ''}`),
    );

    const during = await new DrizzleDiagnosticsReader(db).outbox(tenantA, 10);
    expect(during.failingSample).toHaveLength(during.failing);
    expect(during.failing).toBe(0);
    expect(configs).toEqual([{ isolationLevel: 'repeatable read', accessMode: 'read only' }]);

    // The commit did land: a read that starts afterwards sees it, count and sample alike.
    const after = await new DrizzleDiagnosticsReader(ctx.container.database.db).outbox(tenantA, 10);
    expect(after.failing).toBe(1);
    expect(after.failingSample).toHaveLength(1);
  });

  it('reads the stuck-operation counts and their sample as one observation', async () => {
    const operation = await provisionFor(await paidOrder('snap-ops'));
    const { db, configs } = racing(ctx.container.database.db, () =>
      exec(sql`UPDATE provisioning_operations SET state = 'UNKNOWN', attempts = 1
                WHERE id = ${operation}`),
    );
    const now = ctx.container.clock.now();
    const before = new Date(now.getTime() - 10 * 60_000);

    const during = await new DrizzleDiagnosticsReader(db).provisioning(tenantA, now, before, 10);
    const counted = Object.values(during.counts).reduce((sum, n) => sum + n, 0);
    expect(during.sample).toHaveLength(counted);
    expect(counted).toBe(0);
    expect(configs).toEqual([{ isolationLevel: 'repeatable read', accessMode: 'read only' }]);

    const after = await new DrizzleDiagnosticsReader(ctx.container.database.db).provisioning(
      tenantA,
      now,
      before,
      10,
    );
    expect(after.counts.UNKNOWN_OUTCOME).toBe(1);
    expect(after.sample.map((row) => row.operationId)).toEqual([operation]);
  });

  it('changes nothing it reads', async () => {
    await paidOrder('readonly');
    const snapshot = async () =>
      (
        await exec(sql`SELECT
          (SELECT string_agg(id::text || state || attempts::text, ',' ORDER BY id) FROM provisioning_operations) AS ops,
          (SELECT string_agg(id::text || attempts::text || coalesce(published_at::text, '-'), ',' ORDER BY id) FROM outbox_messages) AS outbox`)
      ).rows[0];
    const before = await snapshot();
    await ctx.container.diagnostics.read(tenantA, owner);
    expect(await snapshot()).toEqual(before);
  });
});
