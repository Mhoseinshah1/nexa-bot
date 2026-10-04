import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BYTES_PER_GB,
  EMPTY_PRODUCT_DISPLAY,
  isNexaError,
  money,
  systemJobActor,
  type ActorContext,
  type CorrelationId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import { DrizzleLegacyImportRepository } from '../../apps/api/src/modules/platform/legacy-import/infrastructure/drizzle-legacy-import.repository';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzlePanelCapacityRepository } from '../../apps/api/src/modules/platform/panels/infrastructure/drizzle-panel-capacity.repository';
import type {
  AdoptionInventoryMatch,
  AdoptionRuntimeFacts,
  LegacyAdoptionCommand,
  LegacyAdoptionOutcome,
} from '../../apps/api/src/modules/commerce/legacy-adoption/application/legacy-adoption-ports';
import { AudienceFixtures } from './audience-fixtures';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Migration P6 — the service adoption write path (`docs/migration-p6-service-adoption.md`),
 * through the shipped container against real PostgreSQL. ADOPTION IS NOT PROVISIONING:
 * every case below also runs with the process's HTTP(S) transports and `fetch` replaced by
 * a recording fake that throws, and asserts it was never called.
 *
 * Synthetic data: this proves the code, never the legacy dataset.
 */

const GB = BYTES_PER_GB;
const DAY_MS = 86_400_000;
const FP = 'a'.repeat(64);
const SUM = (n: number): string => n.toString(16).padStart(64, '0');
const LINK = 'https://sub.rp.example.test/sub/opaque-token-value';

/** Every outbound HTTP(S) request the process tries during a guarded call. */
let providerCalls: string[] = [];
async function withoutNetwork<T>(fn: () => Promise<T>): Promise<T> {
  const saved = {
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    fetch: globalThis.fetch,
  };
  const refuse = (what: string) =>
    ((..._args: unknown[]) => {
      providerCalls.push(what);
      throw new Error(`provider call attempted during adoption: ${what}`);
    }) as never;
  http.request = refuse('http.request');
  http.get = refuse('http.get');
  https.request = refuse('https.request');
  https.get = refuse('https.get');
  globalThis.fetch = refuse('fetch');
  syncBuiltinESMExports();
  try {
    return await fn();
  } finally {
    http.request = saved.httpRequest;
    http.get = saved.httpGet;
    https.request = saved.httpsRequest;
    https.get = saved.httpsGet;
    globalThis.fetch = saved.fetch;
    syncBuiltinESMExports();
  }
}

describe('Migration P6: legacy service adoption', () => {
  let ctx: TestContext;
  let fx: AudienceFixtures;
  let owner: ActorContext;
  let products: DrizzleProductRepository;
  let panel: string;
  let product: ProductId;
  let runId: string;
  let n = 0;
  const T = (): number => (n += 1);

  const db = () => ctx.container.database.db;
  const rows = async <R>(query: ReturnType<typeof sql>): Promise<R[]> =>
    (await db().execute(query)).rows as R[];
  const count = async (query: ReturnType<typeof sql>): Promise<number> =>
    Number((await rows<{ n: number }>(query))[0]?.n ?? 0);

  const actor = (): ActorContext =>
    systemJobActor(`legacy-import:${runId}`, `corr-${String(T())}` as CorrelationId);

  beforeAll(async () => {
    ctx = await createTestContext();
    products = new DrizzleProductRepository(ctx.container.database.db);
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function startRun(scope: TenantContext = tenantA): Promise<string> {
    const repo = new DrizzleLegacyImportRepository(db());
    const started = await ctx.container.uow.run(scope, (tx) =>
      repo.startOrResume(
        scope,
        {
          id: randomUUID(),
          mode: 'APPLY',
          sourceFingerprint: FP,
          codeVersion: null,
          now: new Date(),
        },
        tx,
      ),
    );
    return started.run.id;
  }

  async function rickpanel(
    name: string,
    scope: TenantContext = tenantA,
    baseUrl = 'https://rp.example.test',
    providerType = 'rickpanel',
    maxServices: number | null = null,
  ): Promise<string> {
    const id = ctx.container.ids.uuid();
    await db().execute(sql`
      INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status, max_services)
      VALUES (${id}, ${scope.tenantId}, ${`${name}-${id.slice(-6)}`}, ${providerType},
              ${baseUrl}, 'ACTIVE', ${maxServices})`);
    return id;
  }

  async function publicProduct(
    price: bigint,
    spec: { trafficGb: bigint; days: number } = { trafficGb: 50n, days: 30 },
    scope: TenantContext = tenantA,
    panelId: string | null = panel,
  ): Promise<ProductId> {
    const created = await products.create(scope, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن پنجاه گیگ',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: panelId as PanelId | null,
        categoryId: (scope === tenantA
          ? SEED_IDS.categoryA
          : SEED_IDS.categoryB) as ProductCategoryId,
        specification: {
          durationDays: spec.days,
          trafficBytes: spec.trafficGb * GB,
          deviceLimit: null,
        },
        price: money(price, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: ctx.container.clock.now(),
    });
    await products.setStatus(scope, created.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    return created.id;
  }

  beforeEach(async () => {
    await ctx.reset();
    providerCalls = [];
    fx = new AudienceFixtures(ctx, tenantA.tenantId as string);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-p6', roleKeys: ['owner'] }),
    );
    panel = await rickpanel('rp');
    product = await publicProduct(250_000n);
    runId = await startRun();
  });

  const tg = (): string => `5100${String(T()).padStart(5, '0')}`;
  const invoiceKey = (): string => (0x1000 + T()).toString(16).padStart(8, '0');

  function eligible(username: string, panelId = panel): AdoptionInventoryMatch {
    return {
      kind: 'ELIGIBLE',
      panelId,
      username: username.toLowerCase(),
      providerUsername: username,
    };
  }

  function facts(over: Partial<AdoptionRuntimeFacts> = {}): AdoptionRuntimeFacts {
    return {
      state: 'active',
      usage: {
        usedBytes: 10n * GB,
        totalBytes: 50n * GB,
        expiresAt: new Date(Date.now() + 20 * DAY_MS),
      },
      observedAt: new Date(Date.now() - 60_000),
      subscriptionUrl: LINK,
      ...over,
    };
  }

  function command(
    over: Partial<LegacyAdoptionCommand> & { telegramUserId: string },
  ): LegacyAdoptionCommand {
    const key = over.legacyInvoiceKey ?? invoiceKey();
    return {
      runId,
      legacyInvoiceKey: key,
      sourceChecksum: SUM(1),
      match: eligible(`legacy_${key}`),
      runtime: facts(),
      productId: product,
      legacyPurchasedAt: new Date('2026-03-01T10:00:00.000Z'),
      idempotencyKey: `p6:${runId}:${key}`,
      ...over,
    };
  }

  const adopt = (c: LegacyAdoptionCommand, scope: TenantContext = tenantA, as?: ActorContext) =>
    withoutNetwork(() => ctx.container.legacyAdoption.adopt(scope, as ?? actor(), c));

  async function adopted(
    c: LegacyAdoptionCommand,
  ): Promise<Extract<LegacyAdoptionOutcome, { kind: 'ADOPTED' }>> {
    const outcome = await adopt(c);
    if (outcome.kind !== 'ADOPTED')
      throw new Error(`expected ADOPTED, got ${JSON.stringify(outcome)}`);
    return outcome;
  }

  const mapRow = async (key: string) =>
    (
      await rows<{
        status: string;
        reason_code: string | null;
        entity_type: string | null;
        entity_id: string | null;
        checksum: string;
        run_id: string;
      }>(sql`SELECT status, reason_code, entity_type, entity_id, checksum, run_id
               FROM legacy_import_map WHERE legacy_table = 'invoice' AND legacy_id = ${key}`)
    )[0];

  const businessRows = async (): Promise<Record<string, number>> => ({
    orders: await count(sql`SELECT count(*)::int AS n FROM orders`),
    services: await count(sql`SELECT count(*)::int AS n FROM services`),
    reservations: await count(sql`SELECT count(*)::int AS n FROM service_username_reservations`),
    operations: await count(sql`SELECT count(*)::int AS n FROM provisioning_operations`),
    payments: await count(sql`SELECT count(*)::int AS n FROM payments`),
    ledger: await count(sql`SELECT count(*)::int AS n FROM wallet_entries`),
    reminders: await count(sql`SELECT count(*)::int AS n FROM service_reminders`),
    notifications: await count(sql`SELECT count(*)::int AS n FROM customer_notifications`),
  });

  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------

  it('adopts a live account: zero-total adoption order, live service, funded name, provenance', async () => {
    const telegramUserId = tg();
    const customerId = await fx.customer({ telegramUserId });
    const c = command({ telegramUserId, match: eligible('Legacy_Ali7') });
    const outcome = await adopted(c);

    expect(outcome).toMatchObject({ customerId, panelId: panel, state: 'ACTIVE' });
    const [order] = await rows<Record<string, unknown>>(sql`
      SELECT state, purpose, origin, subtotal_amount, discount_amount, total_amount,
             line_unit_price_amount, discount_code, settled_at, product_id, line_traffic_bytes,
             line_duration_days, customer_id
        FROM orders WHERE id = ${outcome.orderId}`);
    expect(order).toMatchObject({
      state: 'PAID',
      purpose: 'NEW_SERVICE',
      origin: 'LEGACY_ADOPTION',
      subtotal_amount: 0n,
      discount_amount: 0n,
      total_amount: 0n,
      line_unit_price_amount: 0n,
      discount_code: null,
      product_id: product,
      line_duration_days: 30,
      customer_id: customerId,
    });
    expect(new Date(order?.settled_at as string).toISOString()).toBe('2026-03-01T10:00:00.000Z');

    const [service] = await rows<Record<string, unknown>>(sql`
      SELECT state, provider_username, subscription_ref, subscription_url, delivery_state,
             traffic_limit_bytes, traffic_used_bytes, usage_synced_at, expires_at,
             provisioned_at, delivered_at, order_id, product_id, is_trial, customer_id
        FROM services WHERE id = ${outcome.serviceId}`);
    expect(service).toMatchObject({
      state: 'ACTIVE',
      provider_username: 'Legacy_Ali7',
      subscription_url: LINK,
      delivery_state: 'DELIVERED',
      traffic_limit_bytes: 50n * GB,
      traffic_used_bytes: 10n * GB,
      order_id: outcome.orderId,
      product_id: product,
      is_trial: false,
      customer_id: customerId,
    });
    expect(service?.subscription_ref).toMatch(/^[0-9a-f]{32}$/);
    expect(service?.usage_synced_at).not.toBeNull();
    expect(service?.provisioned_at).not.toBeNull();

    const [hold] = await rows<Record<string, unknown>>(sql`
      SELECT namespace_key, username, mode, funded_at, order_id FROM service_username_reservations`);
    expect(hold).toMatchObject({
      namespace_key: 'rickpanel:rp.example.test',
      username: 'legacy_ali7',
      mode: 'CUSTOM',
      order_id: outcome.orderId,
    });
    expect(hold?.funded_at).not.toBeNull();

    expect(await mapRow(c.legacyInvoiceKey)).toMatchObject({
      status: 'IMPORTED',
      entity_type: 'SERVICE',
      entity_id: outcome.serviceId,
      reason_code: null,
      checksum: SUM(1),
      run_id: runId,
    });

    const [audit] = await rows<{ after: Record<string, unknown> }>(sql`
      SELECT after FROM audit_logs WHERE action = 'legacy.service.adopt'
         AND entity_id = ${outcome.serviceId}`);
    expect(audit?.after).toMatchObject({
      orderId: outcome.orderId,
      hasLink: true,
      origin: 'LEGACY_ADOPTION',
    });
    // Never the link, the name or the Telegram id in the audit row or the event.
    expect(JSON.stringify(audit)).not.toContain('opaque-token');
    expect(JSON.stringify(audit)).not.toContain(telegramUserId);
    const events = await rows<{ event_type: string; payload: unknown }>(sql`
      SELECT event_type, payload FROM outbox_messages WHERE aggregate_id = ${outcome.serviceId}`);
    expect(events.map((e) => e.event_type)).toEqual(['ServiceAdopted']);
    expect(JSON.stringify(events)).not.toContain('opaque-token');

    expect(await businessRows()).toMatchObject({
      operations: 0,
      payments: 0,
      ledger: 0,
      notifications: 0,
    });
    expect(providerCalls).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Idempotency and concurrency
  // ---------------------------------------------------------------------------

  it('a rerun returns the same mapping and writes nothing — same key, a new key, a resumed run', async () => {
    const telegramUserId = tg();
    await fx.customer({ telegramUserId });
    const c = command({ telegramUserId });
    const first = await adopted(c);
    const before = await businessRows();

    expect(await adopt(c)).toEqual(first);
    const again = await adopt({ ...c, idempotencyKey: `${c.idempotencyKey}:retry` });
    expect(again).toEqual({
      kind: 'ALREADY_ADOPTED',
      serviceId: first.serviceId,
      orderId: first.orderId,
      customerId: first.customerId,
      panelId: first.panelId,
      sourceChanged: false,
    });
    // A changed source row is reported, never re-pointed.
    const changed = await adopt({
      ...c,
      sourceChecksum: SUM(2),
      idempotencyKey: `${c.idempotencyKey}:changed`,
    });
    expect(changed).toMatchObject({
      kind: 'ALREADY_ADOPTED',
      serviceId: first.serviceId,
      sourceChanged: true,
    });
    expect(await mapRow(c.legacyInvoiceKey)).toMatchObject({
      checksum: SUM(1),
      entity_id: first.serviceId,
    });
    expect(await businessRows()).toEqual(before);
  });

  it('refuses a reused idempotency key with a different payload', async () => {
    const telegramUserId = tg();
    await fx.customer({ telegramUserId });
    const c = command({ telegramUserId });
    await adopted(c);
    await expect(adopt({ ...c, productId: null })).rejects.toSatisfy(
      (e: unknown) => isNexaError(e) && e.kind === 'CONFLICT',
    );
  });

  it('N concurrent adoptions of one invoice produce one order and one service', async () => {
    const telegramUserId = tg();
    await fx.customer({ telegramUserId });
    const c = command({ telegramUserId });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        adopt({ ...c, idempotencyKey: `${c.idempotencyKey}:${String(i)}` }),
      ),
    );
    const fulfilled = outcomes.flatMap((o) => (o.status === 'fulfilled' ? [o.value] : []));
    expect(fulfilled).toHaveLength(6);
    const adoptedOnes = fulfilled.filter((o) => o.kind === 'ADOPTED');
    expect(adoptedOnes).toHaveLength(1);
    const winner = adoptedOnes[0] as Extract<LegacyAdoptionOutcome, { kind: 'ADOPTED' }>;
    for (const o of fulfilled.filter((x) => x.kind !== 'ADOPTED')) {
      expect(o).toMatchObject({ kind: 'ALREADY_ADOPTED', serviceId: winner.serviceId });
    }
    expect(await businessRows()).toMatchObject({ orders: 1, services: 1, reservations: 1 });
  });

  // ---------------------------------------------------------------------------
  // Customers
  // ---------------------------------------------------------------------------

  it('adopts beside an existing NEXA customer’s own services, touching none of them', async () => {
    const telegramUserId = tg();
    const customerId = await fx.customer({ telegramUserId });
    const own = await fx.service({ customerId, panelId: panel, productId: product });
    const before = await rows(sql`SELECT * FROM services WHERE id = ${own}`);
    const outcome = await adopted(command({ telegramUserId }));
    expect(outcome.customerId).toBe(customerId);
    expect(await rows(sql`SELECT * FROM services WHERE id = ${own}`)).toEqual(before);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM services WHERE customer_id = ${customerId}`),
    ).toBe(2);
  });

  it('a customer P7 has not created is manual review, with only the map row written', async () => {
    const c = command({ telegramUserId: tg() });
    expect(await adopt(c)).toEqual({
      kind: 'MANUAL_REVIEW',
      reason: 'CUSTOMER_MISSING',
      recorded: true,
    });
    expect(await mapRow(c.legacyInvoiceKey)).toMatchObject({
      status: 'MANUAL_REVIEW',
      reason_code: 'CUSTOMER_MISSING',
      entity_id: null,
    });
    expect(await businessRows()).toMatchObject({ orders: 0, services: 0, reservations: 0 });
    // Once the customer exists, a rerun (a new key, a later run) adopts.
    await fx.customer({ telegramUserId: c.telegramUserId });
    const later = await adopt({ ...c, idempotencyKey: `${c.idempotencyKey}:after-review` });
    expect(later.kind).toBe('ADOPTED');
  });

  // ---------------------------------------------------------------------------
  // Match passthrough
  // ---------------------------------------------------------------------------

  it('passes every non-eligible match through as its closed reason and writes nothing else', async () => {
    const telegramUserId = tg();
    await fx.customer({ telegramUserId });
    const cases: [AdoptionInventoryMatch, LegacyAdoptionOutcome][] = [
      [
        { kind: 'MANUAL_REVIEW', reason: 'PROVIDER_MISSING', candidatePanels: 0 },
        { kind: 'MANUAL_REVIEW', reason: 'PROVIDER_MISSING', recorded: true },
      ],
      [
        { kind: 'MANUAL_REVIEW', reason: 'AMBIGUOUS_PANEL', candidatePanels: 2 },
        { kind: 'MANUAL_REVIEW', reason: 'AMBIGUOUS_PANEL', recorded: true },
      ],
      [
        { kind: 'MANUAL_REVIEW', reason: 'PANEL_UNMAPPED', candidatePanels: 0 },
        { kind: 'MANUAL_REVIEW', reason: 'PANEL_UNMAPPED', recorded: true },
      ],
      [
        { kind: 'MANUAL_REVIEW', reason: 'USERNAME_CASE_COLLISION', candidatePanels: 1 },
        { kind: 'MANUAL_REVIEW', reason: 'USERNAME_CASE_COLLISION', recorded: true },
      ],
      [
        { kind: 'UNDECIDABLE', reason: 'INVENTORY_INCOMPLETE' },
        { kind: 'MANUAL_REVIEW', reason: 'INVENTORY_INCOMPLETE', recorded: true },
      ],
      [
        { kind: 'INVALID', reason: 'INVALID_SOURCE_ROW' },
        { kind: 'MANUAL_REVIEW', reason: 'INVALID_SOURCE_ROW', recorded: true },
      ],
      [
        { kind: 'SKIPPED', reason: 'TEST_PANEL' },
        { kind: 'SKIPPED', reason: 'TEST_PANEL' },
      ],
    ];
    for (const [match, expected] of cases) {
      const c = command({ telegramUserId, match, runtime: null });
      expect(await adopt(c)).toEqual(expected);
      const row = await mapRow(c.legacyInvoiceKey);
      expect(row?.reason_code).toBe(match.reason);
      expect(row?.status).toBe(match.kind === 'SKIPPED' ? 'SKIPPED' : 'MANUAL_REVIEW');
    }
    expect(await businessRows()).toMatchObject({ orders: 0, services: 0, reservations: 0 });
  });

  it('an invoice key outside the evidenced shape is manual review and writes nothing at all', async () => {
    const telegramUserId = tg();
    await fx.customer({ telegramUserId });
    const c = command({ telegramUserId, legacyInvoiceKey: 'NOT-A-KEY' });
    expect(await adopt(c)).toEqual({
      kind: 'MANUAL_REVIEW',
      reason: 'INVALID_SOURCE_ROW',
      recorded: false,
    });
    expect(await count(sql`SELECT count(*)::int AS n FROM legacy_import_map`)).toBe(0);
  });

  it('refuses an exact spelling that does not fold to the matched key', async () => {
    const telegramUserId = tg();
    await fx.customer({ telegramUserId });
    const c = command({
      telegramUserId,
      match: { kind: 'ELIGIBLE', panelId: panel, username: 'alice', providerUsername: 'Alicia' },
    });
    expect(await adopt(c)).toMatchObject({ kind: 'MANUAL_REVIEW', reason: 'INVALID_SOURCE_ROW' });
  });

  // ---------------------------------------------------------------------------
  // Products
  // ---------------------------------------------------------------------------

  async function hiddenShape(resolved: boolean, isCustom: 0 | 1 = 0): Promise<ProductId> {
    const ensured = await ctx.container.legacyProducts.ensureShape(tenantA, owner, {
      idempotencyKey: `shape-${String(T())}`,
      legacy: { codePanel: 'bac6', volume: '50', serviceTime: '30', timeUnit: null, isCustom },
    });
    if (ensured.outcome === 'UNMAPPABLE') throw new Error('unmappable');
    if (resolved) {
      await ctx.container.legacyProducts.resolveTariff(tenantA, owner, {
        idempotencyKey: `resolve-${String(T())}`,
        shapeId: ensured.shape.id,
        request: { kind: 'MATCH' },
      });
    }
    return ensured.shape.productId;
  }

  it('adopts onto a RESOLVED hidden legacy product, and refuses an unresolved one', async () => {
    const telegramUserId = tg();
    await fx.customer({ telegramUserId });
    const unresolved = await hiddenShape(false, 1);
    expect(await adopt(command({ telegramUserId, productId: unresolved }))).toMatchObject({
      kind: 'MANUAL_REVIEW',
      reason: 'PRODUCT_MAPPING_UNRESOLVED',
    });
    const hidden = await hiddenShape(true);
    const outcome = await adopted(command({ telegramUserId, productId: hidden }));
    const [svc] = await rows<{ product_id: string }>(
      sql`SELECT product_id FROM services WHERE id = ${outcome.serviceId}`,
    );
    expect(svc?.product_id).toBe(hidden);
  });

  it('refuses no product, another tenant’s product, an inactive one, and a window mismatch', async () => {
    const telegramUserId = tg();
    await fx.customer({ telegramUserId });
    const panelB = await rickpanel('rpb', tenantB, 'https://rpb.example.test');
    const productB = await publicProduct(250_000n, undefined, tenantB, panelB);
    const inactive = await publicProduct(250_000n);
    await products.setStatus(tenantA, inactive, 'ACTIVE', 'INACTIVE', ctx.container.clock.now());
    const unlimitedTime = await publicProduct(250_000n, { trafficGb: 50n, days: 0 });
    for (const productId of [null, productB, inactive, unlimitedTime]) {
      expect(await adopt(command({ telegramUserId, productId }))).toMatchObject({
        kind: 'MANUAL_REVIEW',
        reason: 'PRODUCT_MAPPING_UNRESOLVED',
      });
    }
    expect(await businessRows()).toMatchObject({ orders: 0, services: 0 });
  });

  // ---------------------------------------------------------------------------
  // Provider identity, state and the subscription constraint
  // ---------------------------------------------------------------------------

  it('maps runtime state: disabled stays disabled, expired, limited, and refuses what it cannot represent', async () => {
    const telegramUserId = tg();
    await fx.customer({ telegramUserId });
    const expected: [AdoptionRuntimeFacts['state'], string][] = [
      ['active', 'ACTIVE'],
      ['limited', 'ACTIVE'],
      ['disabled', 'SUSPENDED'],
      ['expired', 'EXPIRED'],
    ];
    for (const [state, nexa] of expected) {
      const o = await adopted(command({ telegramUserId, runtime: facts({ state }) }));
      expect(o.state).toBe(nexa);
      const [svc] = await rows<{ state: string }>(
        sql`SELECT state FROM services WHERE id = ${o.serviceId}`,
      );
      expect(svc?.state).toBe(nexa);
    }
    for (const state of ['on_hold', 'UNKNOWN'] as const) {
      expect(await adopt(command({ telegramUserId, runtime: facts({ state }) }))).toMatchObject({
        kind: 'MANUAL_REVIEW',
        reason: 'UNSUPPORTED_SHAPE',
      });
    }
    expect(await adopt(command({ telegramUserId, runtime: facts({ usage: null }) }))).toMatchObject(
      {
        kind: 'MANUAL_REVIEW',
        reason: 'PROVIDER_READ_FAILED',
      },
    );
    expect(
      await adopt(
        command({ telegramUserId, runtime: facts({ subscriptionUrl: 'javascript:alert(1)' }) }),
      ),
    ).toMatchObject({ kind: 'MANUAL_REVIEW', reason: 'PROVIDER_READ_FAILED' });
  });

  it('stores unlimited traffic and time as the panel reports them, and no link when none was read', async () => {
    const telegramUserId = tg();
    await fx.customer({ telegramUserId });
    const unlimited = await publicProduct(250_000n, { trafficGb: 0n, days: 0 });
    const o = await adopted(
      command({
        telegramUserId,
        productId: unlimited,
        runtime: facts({
          usage: { usedBytes: 0n, totalBytes: null, expiresAt: null },
          subscriptionUrl: null,
        }),
      }),
    );
    const [svc] = await rows<Record<string, unknown>>(sql`
      SELECT traffic_limit_bytes, expires_at, subscription_url FROM services WHERE id = ${o.serviceId}`);
    expect(svc).toEqual({ traffic_limit_bytes: 0n, expires_at: null, subscription_url: null });
  });

  it('subscription constraint: a non-RickPanel panel is SUBSCRIPTION_REF_BLOCKED', async () => {
    const telegramUserId = tg();
    await fx.customer({ telegramUserId });
    const sanaei = await rickpanel('x', tenantA, 'https://x.example.test', 'sanaei');
    const c = command({ telegramUserId, match: eligible('xuser01', sanaei) });
    expect(await adopt(c)).toMatchObject({
      kind: 'MANUAL_REVIEW',
      reason: 'SUBSCRIPTION_REF_BLOCKED',
    });
    expect(await mapRow(c.legacyInvoiceKey)).toMatchObject({
      reason_code: 'SUBSCRIPTION_REF_BLOCKED',
    });
  });

  it('every adopted service on one panel gets its own random subscription_ref', async () => {
    const telegramUserId = tg();
    await fx.customer({ telegramUserId });
    await adopted(command({ telegramUserId }));
    await adopted(command({ telegramUserId }));
    const refs = await rows<{ subscription_ref: string }>(
      sql`SELECT subscription_ref FROM services`,
    );
    expect(new Set(refs.map((r) => r.subscription_ref)).size).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Conflicts
  // ---------------------------------------------------------------------------

  it('a NEXA service already holding the name on the panel (any case) is a conflict, never a merge', async () => {
    const telegramUserId = tg();
    const customerId = await fx.customer({ telegramUserId });
    const existing = await fx.service({ customerId, panelId: panel, productId: product });
    await db().execute(
      sql`UPDATE services SET provider_username = 'taken_name' WHERE id = ${existing}`,
    );
    const c = command({ telegramUserId, match: eligible('Taken_Name') });
    expect(await adopt(c)).toMatchObject({
      kind: 'MANUAL_REVIEW',
      reason: 'CONFLICTING_EXISTING_ENTITY',
    });
    expect(await count(sql`SELECT count(*)::int AS n FROM services`)).toBe(1);
  });

  it('a hold of the name in the namespace — another tenant on the same host — is a conflict', async () => {
    const telegramUserId = tg();
    await fx.customer({ telegramUserId });
    // Tenant B adopts `shared01` on its own panel row pointing at the SAME host.
    const runB = await startRun(tenantB);
    const fxB = new AudienceFixtures(ctx, tenantB.tenantId as string);
    const tgB = tg();
    await fxB.customer({ telegramUserId: tgB });
    const panelB = await rickpanel('rpb', tenantB, 'https://rp.example.test');
    const productB = await publicProduct(250_000n, undefined, tenantB, panelB);
    const keyB = invoiceKey();
    const outcomeB = await withoutNetwork(() =>
      ctx.container.legacyAdoption.adopt(tenantB, actor(), {
        runId: runB,
        legacyInvoiceKey: keyB,
        sourceChecksum: SUM(3),
        telegramUserId: tgB,
        match: eligible('shared01', panelB),
        runtime: facts(),
        productId: productB,
        legacyPurchasedAt: null,
        idempotencyKey: `b:${keyB}`,
      }),
    );
    expect(outcomeB.kind).toBe('ADOPTED');
    expect(await adopt(command({ telegramUserId, match: eligible('shared01') }))).toMatchObject({
      kind: 'MANUAL_REVIEW',
      reason: 'CONFLICTING_EXISTING_ENTITY',
    });
  });

  // ---------------------------------------------------------------------------
  // Capacity
  // ---------------------------------------------------------------------------

  it('counts against the panel cap, never refuses, and reports going over it', async () => {
    const telegramUserId = tg();
    const customerId = await fx.customer({ telegramUserId });
    const capped = await rickpanel('cap', tenantA, 'https://cap.example.test', 'rickpanel', 1);
    await fx.service({ customerId, panelId: capped, productId: product });
    const o = await adopted(command({ telegramUserId, match: eligible('capuser1', capped) }));
    expect(o.capacity).toEqual({ maxServices: 1, usedAfter: 2, overCap: true });
    const capacity = new DrizzlePanelCapacityRepository(db());
    const read = await capacity.read(tenantA, capped, new Date());
    expect(read).toMatchObject({ services: 2, used: 2, available: 0 });
    const [audit] = await rows<{ after: { capacity: unknown } }>(sql`
      SELECT after FROM audit_logs WHERE action = 'legacy.service.adopt'`);
    expect(audit?.after.capacity).toEqual({ maxServices: 1, usedAfter: 2, overCap: true });
  });

  // ---------------------------------------------------------------------------
  // Reminders (Item 8 inside the adoption)
  // ---------------------------------------------------------------------------

  it('seeds the passed reminders in the adoption: the next sweep sends nothing historical', async () => {
    const telegramUserId = tg();
    await fx.customer({ telegramUserId });
    const o = await adopted(
      command({
        telegramUserId,
        runtime: facts({
          usage: {
            usedBytes: 46n * GB,
            totalBytes: 50n * GB,
            expiresAt: new Date(Date.now() + 2 * DAY_MS),
          },
        }),
      }),
    );
    expect(o.remindersSeeded).toEqual([
      'EXPIRY_EARLY',
      'EXPIRY_FIRST',
      'USAGE_FIRST',
      'USAGE_SECOND',
    ]);
    await ctx.container.serviceReminderSweep.runOnce(tenantA);
    expect(await count(sql`SELECT count(*)::int AS n FROM customer_notifications`)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Revenue exclusion and inertness
  // ---------------------------------------------------------------------------

  it('is never revenue, and nothing — provisioner, earn sweep, refund request — acts on it', async () => {
    const telegramUserId = tg();
    const customerId = await fx.customer({ telegramUserId });
    const referrer = await fx.customer({ telegramUserId: tg() });
    await fx.referral(referrer, customerId);
    const o = await adopted(command({ telegramUserId }));

    const summary = await ctx.container.reports.summary(tenantA, owner, { range: 'TODAY' });
    expect(summary.sales.current).toBe(0);
    expect(summary.newServices.current).toBe(0);
    expect(summary.revenue.every((m) => m.current === '0')).toBe(true);
    const services = await ctx.container.reports.services(tenantA, owner, { range: 'TODAY' });
    expect(services.activeServices).toBe(1);

    ctx.container.setInstallationTenant(tenantA.tenantId);
    await withoutNetwork(async () => {
      await ctx.container.provisionerLoop.tick();
      await ctx.container.provisionerLoop.tick();
    });
    expect(await count(sql`SELECT count(*)::int AS n FROM provisioning_operations`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM order_cashback`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM order_referral_commissions`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM wallet_entries`)).toBe(0);
    expect(await count(sql`SELECT count(*)::int AS n FROM refunds`)).toBe(0);
    const [order] = await rows<{ state: string }>(
      sql`SELECT state FROM orders WHERE id = ${o.orderId}`,
    );
    expect(order?.state).toBe('PAID');
    expect(providerCalls).toEqual([]);
  });

  it('renewal of an adopted service quotes the CURRENT tariff of its product, never a legacy price', async () => {
    const telegramUserId = tg();
    const customerId = (await fx.customer({ telegramUserId })) as UserId;
    // An operable panel (credentials and activation), as a renewal needs; nothing dials it.
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'RP renew',
      providerType: 'rickpanel',
      baseUrl: 'https://rp-renew.example.test',
      credentials: { username: 'nexa', password: 'not-a-real-password' },
      activation: {},
      idempotencyKey: 'panel-p6-renew',
    });
    const renewPanel = created.view.panel.id;
    const o = await adopted(command({ telegramUserId, match: eligible('renewme1', renewPanel) }));
    const quote = async (): Promise<bigint> => {
      const k = `renew-${String(T())}`;
      const { order } = await ctx.container.commercialActions.draft(
        tenantA,
        {
          type: 'SYSTEM_JOB',
          id: null,
          label: 'telegram-update:test',
          surface: 'TELEGRAM',
          correlationId: k as CorrelationId,
        },
        customerId,
        { serviceId: o.serviceId, kind: 'RENEW', idempotencyKey: k },
      );
      return order.totals.total.amountMinor;
    };
    expect(await quote()).toBe(250_000n);
    await db().execute(sql`UPDATE products SET price_amount = 310000 WHERE id = ${product}`);
    expect(await quote()).toBe(310_000n);
  });

  // ---------------------------------------------------------------------------
  // Authority, scope and tenancy
  // ---------------------------------------------------------------------------

  it('refuses an administrator without maintenance.run, audits the denial, writes nothing', async () => {
    const telegramUserId = tg();
    await fx.customer({ telegramUserId });
    const observer = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'obs-p6', roleKeys: ['observer'] }),
    );
    await expect(adopt(command({ telegramUserId }), tenantA, observer)).rejects.toSatisfy(
      (e: unknown) => isNexaError(e) && e.kind === 'PERMISSION_DENIED',
    );
    expect(
      await count(sql`SELECT count(*)::int AS n FROM audit_logs
                       WHERE action = 'legacy.service.adopt' AND result = 'DENIED'`),
    ).toBe(1);
    expect(await count(sql`SELECT count(*)::int AS n FROM legacy_import_map`)).toBe(0);
    expect(await businessRows()).toMatchObject({ orders: 0, services: 0 });
  });

  it('refuses a stopped tenant inside the transaction', async () => {
    const telegramUserId = tg();
    await fx.customer({ telegramUserId });
    await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`);
    await expect(adopt(command({ telegramUserId }))).rejects.toMatchObject({
      code: 'commerce.request_invalid',
    });
    expect(await count(sql`SELECT count(*)::int AS n FROM legacy_import_map`)).toBe(0);
  });

  it('keeps tenants apart: another tenant’s panel or customer is never used', async () => {
    const telegramUserId = tg();
    await fx.customer({ telegramUserId });
    const panelB = await rickpanel('rpb', tenantB, 'https://rpb2.example.test');
    expect(
      await adopt(command({ telegramUserId, match: eligible('isol01', panelB) })),
    ).toMatchObject({
      kind: 'MANUAL_REVIEW',
      reason: 'PANEL_UNMAPPED',
    });
    const fxB = new AudienceFixtures(ctx, tenantB.tenantId as string);
    const onlyInB = tg();
    await fxB.customer({ telegramUserId: onlyInB });
    expect(await adopt(command({ telegramUserId: onlyInB }))).toMatchObject({
      kind: 'MANUAL_REVIEW',
      reason: 'CUSTOMER_MISSING',
    });
    expect(await count(sql`SELECT count(*)::int AS n FROM services`)).toBe(0);
  });

  it('records provenance the run finishes with: imported and review counters from map rows', async () => {
    const telegramUserId = tg();
    await fx.customer({ telegramUserId });
    await adopted(command({ telegramUserId }));
    await adopt(command({ telegramUserId, productId: null }));
    const repo = new DrizzleLegacyImportRepository(db());
    const finished = await ctx.container.uow.run(tenantA, (tx) =>
      repo.finish(tenantA, runId, { status: 'COMPLETED' }, new Date(), tx),
    );
    expect(finished).toMatchObject({ rowsImported: 1, rowsManualReview: 1 });
  });
});
