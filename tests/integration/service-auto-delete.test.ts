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
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import {
  createDatabase,
  type DatabaseHandle,
} from '../../apps/api/src/infrastructure/persistence/database';
import { withDatabaseScope } from '../../apps/api/src/infrastructure/persistence/database-scope';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { DrizzleServiceTransferRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service-transfer.repository';
import { DrizzleNotificationSubjectReader } from '../../apps/api/src/modules/commerce/messaging/infrastructure/drizzle-notification-subject.reader';
import { DrizzleOpsLogFacts } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/drizzle-ops-log-facts';
import { OperationLog } from '../../apps/api/src/modules/commerce/ops-log/application/operation-log';
import { i18nOpsLogWords } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import {
  ServiceAutoDeleteService,
  type ServiceAutoDeleteDeps,
} from '../../apps/api/src/modules/commerce/provisioning/application/service-auto-delete.service';
import { notificationButtons } from '../../apps/api/src/surfaces/telegram/runtime/keyboards';
import { SERVICE_RENEW_CALLBACK_PREFIX } from '../../apps/api/src/surfaces/telegram/runtime/callbacks';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  testAppDatabaseUrl,
  validatePanelConnection,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * NEXA-OWNER-BATCH-1 PR-3 — automatic deletion of finished services, against a real PostgreSQL,
 * the real container (the sweep, the provisioning TERMINATE, the provisioner and the real
 * Marzban adapter on a real socket), driven by the sweep's own `runOnce`.
 *
 * MUTATIONS, each run and seen red (recorded in the PR body):
 * - the open-payment clause of `NOT_BLOCKED` removed: "an undecided payment blocks …".
 * - `stillDeletable` in `plan` skipped: "a renewal after the warning but before the deletion …".
 * - the run-state gate (`r.state = 'SCHEDULED'` in `deletable`/`stillDeletable`) removed and the
 *   TERMINATE key made per attempt: "a failed TERMINATE is never planned again".
 * - the rate limit's room ignored: "at most max_per_minute per panel …".
 * - the flag read in `schedulePass` removed: "the flag off: nothing is warned or deleted".
 * - the transfer's cancellation of the SCHEDULED run removed: "a transfer after the warning …"
 *   (the old run keeps the cycle's key, so the new owner is never warned).
 * - `autoDeleteAfter` made to ignore the warning's lead: "a transfer after the warning …" (the
 *   new owner would be deleted without a full window after their warning).
 * - `s.customer_id = r.customer_id` removed from the reader, `deletable` and `stillDeletable`:
 *   "a run scheduled under another owner …".
 */

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;
const PRICE = 150_000n;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LIMIT_BYTES = 53_687_091_200n;

const botActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

interface TenantFixture {
  readonly scope: TenantContext;
  readonly owner: ActorContext;
  readonly panelId: string;
  readonly categoryId: string;
  readonly botId: BotInstanceId;
}

describe('PR-3 — automatic deletion of finished services', () => {
  let ctx: TestContext;
  let marzban: FakeMarzban;
  let products: DrizzleProductRepository;
  let services: DrizzleServiceRepository;
  let a: TenantFixture;
  let seq = 0;
  const versions = new Map<string, number | null>();

  beforeAll(async () => {
    ctx = await createTestContext({ PANEL_HTTP_ALLOW_LOOPBACK: 'true' });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  afterEach(async () => {
    await marzban?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    versions.clear();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    products = new DrizzleProductRepository(ctx.container.database.db);
    services = new DrizzleServiceRepository(ctx.container.database.db);
    marzban = await startFakeMarzban({ host: '127.0.0.2' });
    a = await tenantFixture(tenantA, SEED_IDS.categoryA, BOT_A, 'a');
    await setFlag(a, true);
  });

  const key = (tag: string): string => {
    seq += 1;
    return `auto-delete-${tag}-${String(seq)}`;
  };

  async function tenantFixture(
    scope: TenantContext,
    categoryId: string,
    botId: BotInstanceId,
    tag: string,
  ): Promise<TenantFixture> {
    const seeded = await createAdmin(ctx.container, scope, {
      username: `owner-auto-delete-${tag}`,
      roleKeys: ['owner'],
      telegramUserId: tag === 'a' ? '950951' : '950952',
    });
    const owner = adminActorFor(seeded);
    const created = await ctx.container.panels.create(scope, owner, {
      name: `Marzban ${tag}`,
      providerType: 'marzban',
      baseUrl: marzban.baseUrl,
      credentials: { username: marzban.username, password: marzban.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: key(`panel-${tag}`),
    });
    await validatePanelConnection(ctx.container, scope, created.view.panel.id);
    return { scope, owner, panelId: created.view.panel.id, categoryId, botId };
  }

  async function setFlag(t: TenantFixture, enabled: boolean): Promise<void> {
    const flags = await ctx.container.featureFlags.list(t.scope, t.owner);
    const current = flags.find((flag) => flag.key === 'service_auto_delete');
    await ctx.container.featureFlags.set(t.scope, t.owner, {
      key: 'service_auto_delete',
      enabled,
      expectedVersion: current?.version ?? null,
      idempotencyKey: key('flag'),
      confirmKey: 'service_auto_delete',
      reason: 'PR-3 integration.',
    });
  }

  async function setSetting(t: TenantFixture, name: string, value: number): Promise<void> {
    const settingKey = `service.auto_delete.${name}`;
    const versionKey = `${String(t.scope.tenantId)}:${settingKey}`;
    const result = await ctx.container.settingsService.set(t.scope, t.owner, {
      key: settingKey,
      value,
      expectedVersion: versions.get(versionKey) ?? null,
      idempotencyKey: key('setting'),
    });
    versions.set(versionKey, result.setting.version);
  }

  async function resolveCustomer(t: TenantFixture, telegramUserId: string): Promise<UserId> {
    const resolved = await ctx.container.customers.resolveFromUpdate(t.scope, botActor('r'), {
      intake: 'INTERNAL',
      idempotencyKey: key(`resolve-${telegramUserId}`),
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'سارا' },
      botInstanceId: t.botId,
    });
    return resolved.customer.id;
  }

  /** A NEW_SERVICE order paid from the wallet and provisioned (ACTIVE on the fake panel). */
  async function activeService(t: TenantFixture, telegramUserId: string): Promise<string> {
    const customerId = await resolveCustomer(t, telegramUserId);
    const now = ctx.container.clock.now();
    const product = await products.create(t.scope, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن ماهانه',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: t.panelId as PanelId,
        categoryId: t.categoryId as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: LIMIT_BYTES, deviceLimit: null },
        price: money(PRICE, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now,
    });
    await products.setStatus(t.scope, product.id, 'INACTIVE', 'ACTIVE', now);
    const k = key('buy');
    const draft = await ctx.container.orders.createDraft(t.scope, botActor(k), {
      idempotencyKey: `${k}-draft`,
      customerId,
      productId: product.id,
    });
    const confirmed = await ctx.container.orders.confirm(t.scope, botActor(k), {
      idempotencyKey: `${k}-confirm`,
      customerId,
      orderId: draft.id,
    });
    await ctx.container.wallet.adjust(t.scope, t.owner, customerId, {
      idempotencyKey: `${k}-credit`,
      direction: 'CREDIT',
      amountMinor: PRICE,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(t.scope, botActor(k), customerId, {
      idempotencyKey: `${k}-pay`,
      orderId: confirmed.id,
    });
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(t.scope, confirmed.id as OrderId);
    if (service === null || service === undefined) throw new Error('no service');
    expect(service.state, 'the fixture must start ACTIVE').toBe('ACTIVE');
    return service.id;
  }

  const run = (query: ReturnType<typeof sql>) => ctx.container.database.db.execute(query);
  const rows = async (query: ReturnType<typeof sql>): Promise<Record<string, unknown>[]> =>
    (await run(query)).rows as Record<string, unknown>[];

  const ago = (ms: number): Date => new Date(ctx.container.clock.now().getTime() - ms);

  /** Lapses the service's window and lets the provisioner's own expiry move it to EXPIRED. */
  async function expire(serviceId: string, opts: { trafficUsedUp: boolean }): Promise<void> {
    if (opts.trafficUsedUp) {
      await run(sql`UPDATE services SET traffic_used_bytes = traffic_limit_bytes,
                                        usage_synced_at = ${ago(HOUR)}
                     WHERE id = ${serviceId}`);
    }
    await run(sql`UPDATE services SET expires_at = ${ago(HOUR)} WHERE id = ${serviceId}`);
    await ctx.container.provisionerLoop.tick();
  }

  /** Moves the service's clock back, as if it had been in its state for `days`. */
  const age = (serviceId: string, days: number) =>
    run(sql`UPDATE services SET state_since = ${ago(days * DAY)} WHERE id = ${serviceId}`);

  const serviceRow = async (serviceId: string) =>
    (
      await rows(sql`SELECT state, state_since, expiry_cause FROM services WHERE id = ${serviceId}`)
    )[0];

  const terminates = (serviceId: string) =>
    rows(sql`SELECT id, state FROM provisioning_operations
              WHERE service_id = ${serviceId} AND type = 'TERMINATE'`);

  const runsOf = (serviceId: string) =>
    rows(sql`SELECT id, state, cause, days, operation_id, warned_at, delete_after
               FROM service_auto_delete_runs WHERE service_id = ${serviceId} ORDER BY created_at`);

  const warnings = (subjectId?: string) =>
    rows(sql`SELECT subject_id FROM customer_notifications
              WHERE kind = 'SERVICE_AUTO_DELETE_WARNING'
                ${subjectId === undefined ? sql`` : sql`AND subject_id = ${subjectId}`}`);

  /** Lets every scheduled cycle be deleted now (the warning's lead elapsed). */
  const leadElapsed = () =>
    run(sql`UPDATE service_auto_delete_runs SET delete_after = ${ago(60_000)}
             WHERE state = 'SCHEDULED'`);

  const deps = (): ServiceAutoDeleteDeps =>
    (ctx.container.serviceAutoDelete as unknown as { deps: ServiceAutoDeleteDeps }).deps;

  it('stores the moment and the cause when a service expires: traffic used up → TRAFFIC, else TIME', async () => {
    const byTraffic = await activeService(a, '960001');
    const byTime = await activeService(a, '960002');
    const before = ctx.container.clock.now().getTime();
    await expire(byTraffic, { trafficUsedUp: true });
    await expire(byTime, { trafficUsedUp: false });
    const t = await serviceRow(byTraffic);
    const m = await serviceRow(byTime);
    expect(t).toMatchObject({ state: 'EXPIRED', expiry_cause: 'TRAFFIC' });
    expect(m).toMatchObject({ state: 'EXPIRED', expiry_cause: 'TIME' });
    // The moment is the expiry's own, from the clock — not the window's end an hour earlier.
    expect(new Date(String(t?.['state_since'])).getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('each cause is deleted after its own days, and only then', async () => {
    await setSetting(a, 'after_traffic_days', 3);
    await setSetting(a, 'after_time_days', 10);
    await setSetting(a, 'after_suspend_days', 5);
    await setSetting(a, 'warn_hours', 0);
    const byTraffic = await activeService(a, '960011');
    const byTime = await activeService(a, '960012');
    const suspended = await activeService(a, '960013');
    await expire(byTraffic, { trafficUsedUp: true });
    await expire(byTime, { trafficUsedUp: false });
    await run(sql`UPDATE services SET state = 'SUSPENDED' WHERE id = ${suspended}`);
    // Four days in each: past the traffic count only.
    for (const id of [byTraffic, byTime, suspended]) await age(id, 4);

    const first = await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(first.planned).toBe(1);
    expect(await terminates(byTraffic)).toHaveLength(1);
    expect(await terminates(byTime)).toHaveLength(0);
    expect(await terminates(suspended)).toHaveLength(0);
    expect(await runsOf(byTraffic)).toEqual([
      expect.objectContaining({ state: 'PLANNED', cause: 'TRAFFIC', days: 3 }),
    ]);

    // Six days suspended: past its five. Nine days expired by time: still short of ten.
    await age(suspended, 6);
    await age(byTime, 9);
    await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(await terminates(suspended)).toHaveLength(1);
    expect(await terminates(byTime)).toHaveLength(0);
    await age(byTime, 11);
    await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(await terminates(byTime)).toHaveLength(1);
    expect((await runsOf(byTime))[0]).toMatchObject({ cause: 'TIME', days: 10 });

    // The provisioner carries the TERMINATE out like an operator's: the service ends, nothing
    // is refunded and the wallet is untouched.
    const entriesBefore = await rows(sql`SELECT count(*)::int AS n FROM wallet_entries`);
    await ctx.container.provisionerLoop.tick();
    expect(await serviceRow(byTraffic)).toMatchObject({ state: 'TERMINATED' });
    expect(await rows(sql`SELECT count(*)::int AS n FROM wallet_entries`)).toEqual(entriesBefore);
    // The request's audit row carries the reason, beside the SYSTEM_JOB actor.
    const audit = await rows(sql`SELECT actor_type, after FROM audit_logs
                                  WHERE action = 'service.request_terminate'
                                    AND entity_id = ${byTraffic}`);
    expect(audit).toEqual([
      expect.objectContaining({
        actor_type: 'SYSTEM_JOB',
        after: expect.objectContaining({ reason: 'AUTO_DELETE', requestedBy: 'OPERATOR' }),
      }),
    ]);
  });

  it('a renewal before the deadline cancels; the warning is sent once per cycle', async () => {
    await setSetting(a, 'after_time_days', 2);
    const serviceId = await activeService(a, '960021');
    await expire(serviceId, { trafficUsedUp: false });
    await age(serviceId, 3);

    // warn_hours (24 by default): scheduled and warned once, not deleted yet.
    const first = await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(first).toMatchObject({ scheduled: 1, warned: 1, planned: 0 });
    const [scheduled] = await runsOf(serviceId);
    expect(scheduled).toMatchObject({ state: 'SCHEDULED' });
    const runId = String(scheduled?.['id']);
    expect(await warnings(runId)).toHaveLength(1);
    // Never deleted sooner than the warning's lead.
    expect(new Date(String(scheduled?.['delete_after'])).getTime()).toBeGreaterThan(
      ctx.container.clock.now().getTime() + 23 * HOUR,
    );
    await ctx.container.serviceAutoDelete.runOnce(tenantA);
    await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(await warnings()).toHaveLength(1);

    // The warning renders the account and offers the existing renew flow.
    const facts = await ctx.container.serviceAutoDelete.noticeFacts(tenantA, runId);
    expect(facts?.serviceId).toBe(serviceId);
    expect(
      notificationButtons('SERVICE_AUTO_DELETE_WARNING', { serviceId }).map((b) =>
        'data' in b ? b.data : null,
      ),
    ).toContain(`${SERVICE_RENEW_CALLBACK_PREFIX}${serviceId}`);
    const reader = new DrizzleNotificationSubjectReader(ctx.container.database.db);
    const now = ctx.container.clock.now();
    expect(await reader.stillHolds(tenantA, 'SERVICE_AUTO_DELETE_WARNING', runId, now)).toBe(true);

    // Renewed: the service is ACTIVE again with a new clock. The warning no longer holds and
    // the cycle is never deleted.
    await run(sql`UPDATE services SET state = 'ACTIVE', state_since = ${now},
                                      expires_at = ${new Date(now.getTime() + 30 * DAY)}
                   WHERE id = ${serviceId}`);
    expect(await reader.stillHolds(tenantA, 'SERVICE_AUTO_DELETE_WARNING', runId, now)).toBe(false);
    await leadElapsed();
    await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(await terminates(serviceId)).toHaveLength(0);

    // It lapses again: a NEW cycle, a new warning — the old one is not reused.
    await expire(serviceId, { trafficUsedUp: false });
    await age(serviceId, 3);
    await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(await runsOf(serviceId)).toHaveLength(2);
    expect(await warnings()).toHaveLength(2);
  });

  it('a renewal after the warning but before the deletion is seen inside the deletion', async () => {
    await setSetting(a, 'after_time_days', 2);
    await setSetting(a, 'warn_hours', 0);
    const serviceId = await activeService(a, '960031');
    await expire(serviceId, { trafficUsedUp: false });
    await age(serviceId, 3);
    // The race: the pass lists the cycle, then the customer's renewal commits, then the pass
    // plans. The re-read under the row lock must see the renewal.
    const real = deps();
    const racing = new ServiceAutoDeleteService({
      ...real,
      repository: Object.assign(Object.create(real.repository) as object, {
        listDeletable: async (...args: Parameters<typeof real.repository.listDeletable>) => {
          const listed = await real.repository.listDeletable(...args);
          await run(sql`UPDATE services SET state = 'ACTIVE', state_since = now()
                         WHERE id = ${serviceId}`);
          return listed;
        },
      }) as typeof real.repository,
    });
    const report = await racing.runOnce(tenantA);
    expect(report.scheduled).toBe(1);
    expect(report.planned).toBe(0);
    expect(await terminates(serviceId)).toHaveLength(0);
    expect(await runsOf(serviceId)).toEqual([expect.objectContaining({ state: 'SCHEDULED' })]);
  });

  it('an open order, and an undecided payment, block the deletion', async () => {
    await setSetting(a, 'after_time_days', 2);
    await setSetting(a, 'warn_hours', 0);
    const serviceId = await activeService(a, '960041');
    await expire(serviceId, { trafficUsedUp: false });
    await age(serviceId, 3);
    const service = await services.findById(tenantA, serviceId);
    if (service === null) throw new Error('no service');
    // The customer started a renewal: an open order.
    const draft = await ctx.container.commercialActions.draft(
      tenantA,
      botActor('renew'),
      service.customerId,
      { serviceId, kind: 'RENEW', idempotencyKey: key('renew') },
    );
    const orderId = draft.order.id;
    expect(await ctx.container.serviceAutoDelete.preview(tenantA, a.owner, {})).toMatchObject({
      total: 0,
    });
    await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(await terminates(serviceId)).toHaveLength(0);
    expect(await runsOf(serviceId)).toHaveLength(0);

    // The order ended, but a payment of it is still undecided (UNKNOWN): still kept.
    await run(sql`UPDATE orders SET state = 'EXPIRED' WHERE id = ${orderId}`);
    await run(sql`
      INSERT INTO payments
      SELECT (jsonb_populate_record(NULL::payments, to_jsonb(p) || jsonb_build_object(
                'id', ${ctx.container.ids.uuid()}::text, 'order_id', ${orderId}::text,
                'state', 'UNKNOWN', 'resolved_at', NULL, 'confirmed_at', NULL, 'code', NULL,
                'reference', 'auto-delete-' || md5(random()::text),
                'idempotency_key', 'auto-delete-' || md5(random()::text)))).*
        FROM payments p
       WHERE p.tenant_id = ${tenantA.tenantId}
       LIMIT 1`);
    await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(await terminates(serviceId)).toHaveLength(0);

    // Decided: the service is deleted.
    await run(
      sql`UPDATE payments SET state = 'FAILED', resolved_at = now() WHERE order_id = ${orderId}`,
    );
    await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(await terminates(serviceId)).toHaveLength(1);
  });

  it('deletes through the terminate path exactly once; a failed TERMINATE is never planned again', async () => {
    await setSetting(a, 'after_time_days', 2);
    await setSetting(a, 'warn_hours', 0);
    const serviceId = await activeService(a, '960051');
    await expire(serviceId, { trafficUsedUp: false });
    await age(serviceId, 3);
    await Promise.allSettled([
      ctx.container.serviceAutoDelete.runOnce(tenantA),
      ctx.container.serviceAutoDelete.runOnce(tenantA),
    ]);
    const ops = await terminates(serviceId);
    expect(ops).toHaveLength(1);
    const [cycle] = await runsOf(serviceId);
    expect(cycle).toMatchObject({ state: 'PLANNED', operation_id: ops[0]?.['id'] });

    // The panel refused for good: the provisioner's own failure path ends it. Never re-planned.
    await run(sql`UPDATE provisioning_operations SET state = 'FAILED', next_attempt_at = NULL,
                         completed_at = now(), failure_kind = 'PROVIDER_REFUSED'
                   WHERE id = ${String(ops[0]?.['id'])}`);
    for (let i = 0; i < 3; i += 1) await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(await terminates(serviceId)).toHaveLength(1);
    expect(await runsOf(serviceId)).toEqual([
      expect.objectContaining({ state: 'PLANNED', operation_id: ops[0]?.['id'] }),
    ]);
  });

  it('at most max_per_minute per panel; the backlog drains at that rate', async () => {
    await setSetting(a, 'after_time_days', 2);
    await setSetting(a, 'warn_hours', 0);
    await setSetting(a, 'max_per_minute', 2);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await activeService(a, `96006${String(i)}`);
      await expire(id, { trafficUsedUp: false });
      await age(id, 3);
      ids.push(id);
    }
    const first = await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(first.planned).toBe(2);
    const second = await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(second.planned).toBe(0);
    expect(
      await rows(sql`SELECT 1 FROM provisioning_operations WHERE type = 'TERMINATE'`),
    ).toHaveLength(2);
    // A minute later the third goes.
    await run(sql`UPDATE service_auto_delete_runs SET planned_at = ${ago(61_000)}
                   WHERE state = 'PLANNED'`);
    const third = await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(third.planned).toBe(1);
  });

  it('a stopped tenant is skipped', async () => {
    await setSetting(a, 'after_time_days', 2);
    await setSetting(a, 'warn_hours', 0);
    const serviceId = await activeService(a, '960071');
    await expire(serviceId, { trafficUsedUp: false });
    await age(serviceId, 3);
    await run(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`);
    try {
      const report = await ctx.container.serviceAutoDelete.runOnce(tenantA);
      expect(report).toMatchObject({ scheduled: 0, planned: 0 });
      expect(await terminates(serviceId)).toHaveLength(0);
      expect(await warnings()).toHaveLength(0);
    } finally {
      await run(sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${tenantA.tenantId}`);
    }
  });

  it('the flag off: nothing is warned or deleted; only unknown clocks are stamped', async () => {
    await setSetting(a, 'after_time_days', 2);
    const serviceId = await activeService(a, '960081');
    await expire(serviceId, { trafficUsedUp: false });
    await age(serviceId, 3);
    // An imported row with no clock.
    const imported = await activeService(a, '960082');
    await run(
      sql`UPDATE services SET state = 'EXPIRED', state_since = NULL WHERE id = ${imported}`,
    );
    await setFlag(a, false);

    const report = await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(report).toMatchObject({ stamped: 1, scheduled: 0, warned: 0, planned: 0 });
    expect(await warnings()).toHaveLength(0);
    expect(await runsOf(serviceId)).toHaveLength(0);
    expect(await terminates(serviceId)).toHaveLength(0);
    // The unknown clock starts NOW, never earlier: switching the flag on deletes nothing of it.
    const stamped = await serviceRow(imported);
    expect(new Date(String(stamped?.['state_since'])).getTime()).toBeGreaterThan(
      ctx.container.clock.now().getTime() - 60_000,
    );
    await setFlag(a, true);
    await setSetting(a, 'warn_hours', 0);
    await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(await terminates(imported)).toHaveLength(0);
    expect(await terminates(serviceId)).toHaveLength(1);
  });

  it('the preview counts what the next day would delete, per cause, with the settings being edited', async () => {
    await setSetting(a, 'after_traffic_days', 30);
    const byTraffic = await activeService(a, '960091');
    const byTime = await activeService(a, '960092');
    await expire(byTraffic, { trafficUsedUp: true });
    await expire(byTime, { trafficUsedUp: false });
    await age(byTraffic, 10);
    await age(byTime, 10);
    const preview = (query: Parameters<ServiceAutoDeleteService['preview']>[2]) =>
      ctx.container.serviceAutoDelete.preview(tenantA, a.owner, query);
    // Stored: traffic 30, time off — nothing in the next day.
    expect(await preview({})).toMatchObject({ traffic: 0, time: 0, suspended: 0, total: 0 });
    // Being edited: traffic 7 and time 10 → both due; the warning's 24h is inside the window.
    expect(await preview({ afterTrafficDays: 7, afterTimeDays: 10 })).toMatchObject({
      traffic: 1,
      time: 1,
      suspended: 0,
      total: 2,
      windowHours: 24,
      enabled: true,
    });
    // A warning longer than the window pushes them out of it.
    expect(await preview({ afterTrafficDays: 7, afterTimeDays: 10, warnHours: 48 })).toMatchObject({
      total: 0,
    });
    // Eleven days of time: not yet (one day after the window).
    expect(await preview({ afterTimeDays: 12 })).toMatchObject({ time: 0 });
  });

  it('logs each deletion to the operations group with the account, the cause and the days', async () => {
    await setSetting(a, 'after_traffic_days', 3);
    await setSetting(a, 'warn_hours', 0);
    const serviceId = await activeService(a, '960101');
    await expire(serviceId, { trafficUsedUp: true });
    await age(serviceId, 4);
    await ctx.container.serviceAutoDelete.runOnce(tenantA);
    await ctx.container.provisionerLoop.tick();
    const [op] = await terminates(serviceId);
    expect(op).toMatchObject({ state: 'SUCCEEDED' });
    const queued: { templateKey: string; values: Record<string, unknown> }[] = [];
    const log = new OperationLog({
      lane: {
        queue: async (_scope: unknown, message: { templateKey: string; values: never }) => {
          queued.push({ templateKey: message.templateKey, values: message.values });
        },
      } as never,
      facts: new DrizzleOpsLogFacts(ctx.container.database.db),
      words: i18nOpsLogWords,
      clock: ctx.container.clock,
    });
    await ctx.container.uow.run(tenantA, (tx) =>
      log.operationSucceeded(tenantA, String(op?.['id']), tx),
    );
    expect(queued).toEqual([
      expect.objectContaining({
        templateKey: 'ops.log.service_auto_deleted',
        values: expect.objectContaining({ deleteCause: 'پایان حجم', deleteDays: 3 }),
      }),
    ]);
    // An operator's terminate is not an automatic deletion's log.
    const other = await activeService(a, '960102');
    await ctx.container.provisioning.requestFromOperator(tenantA, a.owner, other, 'TERMINATE', {
      idempotencyKey: key('operator-terminate'),
    });
    await ctx.container.provisionerLoop.tick();
    const [operatorOp] = await terminates(other);
    queued.length = 0;
    await ctx.container.uow.run(tenantA, (tx) =>
      log.operationSucceeded(tenantA, String(operatorOp?.['id']), tx),
    );
    expect(queued).toHaveLength(0);
  });

  /** The transfer's own two writes, as `ServiceTransferService.transfer` makes them. */
  async function transfer(serviceId: string, to: UserId, opts: { reassign: boolean }) {
    const from = (await services.findById(tenantA, serviceId))?.customerId as UserId;
    const repository = new DrizzleServiceTransferRepository(ctx.container.database.db);
    const now = ctx.container.clock.now();
    await ctx.container.uow.run(tenantA, async (tx) => {
      await repository.create(
        tenantA,
        {
          id: ctx.container.ids.uuid(),
          serviceId,
          fromCustomerId: from,
          toCustomerId: to,
          botInstanceId: BOT_A,
          idempotencyKey: key('transfer'),
          actorType: 'SYSTEM_JOB',
          actorLabel: 'test',
          correlationId: 'transfer-test',
          now,
        },
        tx,
      );
      if (opts.reassign) {
        await repository.reassign(
          tenantA,
          { serviceId, fromCustomerId: from, toCustomerId: to, now },
          tx,
        );
      } else {
        // Another path that changes the owner and leaves the clock alone.
        await tx.tx.execute(sql`UPDATE services SET customer_id = ${to} WHERE id = ${serviceId}`);
      }
    });
  }

  /** A SUSPENDED service (transferable), its clock three days back, warned under its owner. */
  async function warnedSuspended(
    telegramUserId: string,
  ): Promise<{ serviceId: string; runId: string }> {
    await setSetting(a, 'after_suspend_days', 2);
    const serviceId = await activeService(a, telegramUserId);
    await run(sql`UPDATE services SET state = 'SUSPENDED' WHERE id = ${serviceId}`);
    await age(serviceId, 3);
    await ctx.container.serviceAutoDelete.runOnce(tenantA);
    const [first] = await runsOf(serviceId);
    expect(first).toMatchObject({ state: 'SCHEDULED' });
    return { serviceId, runId: String(first?.['id']) };
  }

  it('a transfer after the warning: no deletion at the old deadline; the new owner is warned first', async () => {
    const { serviceId, runId: oldRun } = await warnedSuspended('960121');
    const clockBefore = String((await serviceRow(serviceId))?.['state_since']);
    const to = await resolveCustomer(a, '960122');
    await transfer(serviceId, to, { reassign: true });
    // The transfer cancels the scheduled run and leaves the clock alone.
    expect((await runsOf(serviceId))[0]).toMatchObject({ id: oldRun, state: 'CANCELLED' });
    expect(String((await serviceRow(serviceId))?.['state_since'])).toBe(clockBefore);
    const reader = new DrizzleNotificationSubjectReader(ctx.container.database.db);
    const now = ctx.container.clock.now();
    expect(await reader.stillHolds(tenantA, 'SERVICE_AUTO_DELETE_WARNING', oldRun, now)).toBe(
      false,
    );

    const warnedFor = async (runId: string) =>
      rows(sql`SELECT customer_id FROM customer_notifications
                WHERE kind = 'SERVICE_AUTO_DELETE_WARNING' AND subject_id = ${runId}`);
    const live = async () =>
      (await runsOf(serviceId)).filter((row) => row['state'] !== 'CANCELLED');

    // The old deadline passes: nothing is deleted; the new owner is scheduled and warned, with a
    // full warning window of their own (deadline = max(due, now + warn_hours)).
    await leadElapsed();
    const atWarning = ctx.container.clock.now().getTime();
    await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(await terminates(serviceId)).toHaveLength(0);
    const [second] = await live();
    expect(second).toMatchObject({ state: 'SCHEDULED' });
    expect(await warnedFor(String(second?.['id']))).toEqual([{ customer_id: to }]);
    const secondDeadline = new Date(String(second?.['delete_after'])).getTime();
    expect(secondDeadline).toBeGreaterThanOrEqual(atWarning + 24 * HOUR - 1000);
    // A pass before that window ends deletes nothing.
    await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(await terminates(serviceId)).toHaveLength(0);

    // Transferred again: the deadline is the LAST warning's plus warn_hours, never further, and
    // the clock still has not moved.
    const third = await resolveCustomer(a, '960123');
    await transfer(serviceId, third, { reassign: true });
    const atLastWarning = ctx.container.clock.now().getTime();
    await ctx.container.serviceAutoDelete.runOnce(tenantA);
    const [last] = await live();
    expect(await warnedFor(String(last?.['id']))).toEqual([{ customer_id: third }]);
    const lastDeadline = new Date(String(last?.['delete_after'])).getTime();
    expect(lastDeadline).toBeGreaterThanOrEqual(atLastWarning + 24 * HOUR - 1000);
    expect(lastDeadline).toBeLessThanOrEqual(ctx.container.clock.now().getTime() + 24 * HOUR);
    expect(String((await serviceRow(serviceId))?.['state_since'])).toBe(clockBefore);

    // Once that window has passed, the service is deleted.
    await leadElapsed();
    await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(await terminates(serviceId)).toHaveLength(1);
  });

  it('a run scheduled under another owner neither warns nor deletes', async () => {
    const { serviceId, runId } = await warnedSuspended('960131');
    const other = await resolveCustomer(a, '960132');
    await transfer(serviceId, other, { reassign: false });
    const reader = new DrizzleNotificationSubjectReader(ctx.container.database.db);
    const now = ctx.container.clock.now();
    expect(await reader.stillHolds(tenantA, 'SERVICE_AUTO_DELETE_WARNING', runId, now)).toBe(false);
    await leadElapsed();
    await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(await terminates(serviceId)).toHaveLength(0);
  });

  it('RLS: one tenant’s pass and its rows never reach another tenant', async () => {
    const b = await tenantFixture(tenantB, SEED_IDS.categoryB, BOT_B, 'b');
    await setFlag(b, true);
    for (const t of [a, b]) {
      await setSetting(t, 'after_time_days', 2);
      await setSetting(t, 'warn_hours', 24);
    }
    const inA = await activeService(a, '960111');
    const inB = await activeService(b, '960112');
    for (const id of [inA, inB]) {
      await expire(id, { trafficUsedUp: false });
      await age(id, 3);
    }
    // Tenant A's pass schedules only A's service.
    await ctx.container.serviceAutoDelete.runOnce(tenantA);
    expect(await runsOf(inA)).toHaveLength(1);
    expect(await runsOf(inB)).toHaveLength(0);
    await ctx.container.serviceAutoDelete.runOnce(tenantB);
    expect(await runsOf(inB)).toHaveLength(1);

    // As nexa_app, bound to A: a query with NO tenant predicate sees A's cycle only.
    const app: DatabaseHandle = createDatabase(testAppDatabaseUrl(), 1);
    try {
      expect(await app.scopeEnforcement()).toBe('enforcing');
      const seen = await withDatabaseScope(
        tenantA,
        async () =>
          (await app.db.execute(sql`SELECT service_id FROM service_auto_delete_runs`)).rows,
      );
      expect(seen).toEqual([{ service_id: inA }]);
      const services = await withDatabaseScope(
        tenantA,
        async () =>
          (
            await app.db.execute(
              sql`SELECT id FROM services WHERE state_since IS NOT NULL AND id = ${inB}`,
            )
          ).rows,
      );
      expect(services).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
