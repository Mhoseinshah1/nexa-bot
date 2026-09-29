import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  CLIENT_APP_MAX_ENTRIES,
  CLIENT_APP_ROUTES,
  COMMERCE_ERROR_CODES,
  CONTROL_ERROR_CODES,
  EMPTY_PRODUCT_DISPLAY,
  SESSION_COOKIE_NAME,
  clientAppListSchema,
  clientAppSchema,
  isNexaError,
  money,
  type ActorContext,
  type BotInstanceId,
  type ClientAppInput,
  type CorrelationId,
  type OrderId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type UserId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { DrizzleServiceRepository } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service.repository';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  migrateOnce,
  resetDatabase,
  SEED_IDS,
  tenantA,
  tenantB,
  testConfig,
  validatePanelConnection,
  type TestContext,
} from './harness';

/**
 * WP-A10 — app downloads and connection guides, against a real PostgreSQL.
 *
 * Every case is one of the ways the feature could send a customer the wrong thing:
 *   - an operator's write that skips its permission, its audit row, its version check or
 *     its idempotency;
 *   - one tenant's entry served to, or edited by, another;
 *   - a disabled entry still offered, or entries out of the operator's order;
 *   - an app offered for a service it cannot connect, decided from the customer's REAL
 *     service on a fake Marzban;
 *   - guide content that reaches Telegram as markup;
 *   - a `tu:` / `to:` button already sitting in a chat that stops answering.
 */

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (isNexaError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
};

let keyCounter = 0;
const key = () => `apps-${String((keyCounter += 1)).padStart(8, '0')}`;

function entry(overrides: Partial<ClientAppInput> = {}): ClientAppInput {
  return {
    platform: 'ANDROID',
    name: 'برنامهٔ نمونه',
    icon: null,
    description: 'سازگار با لینک اشتراک',
    officialUrl: 'https://downloads.example.com/app.apk',
    alternativeUrl: null,
    helpUrl: null,
    guide: '1. برنامه را نصب کنید\n2. لینک اشتراک را وارد کنید',
    deliveryKinds: [],
    protocols: [],
    providerTypes: [],
    sortOrder: 10,
    ...overrides,
  };
}

describe('client apps — the operator’s service', () => {
  let ctx: TestContext;
  let ownerA: ActorContext;
  let ownerB: ActorContext;
  let supportA: ActorContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ownerA = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-apps', roleKeys: ['owner'] }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-appsb', roleKeys: ['owner'] }),
    );
    // `support` holds `client_apps.view` and not `client_apps.edit` — the seed contract's pair.
    supportA = adminActorFor(
      await createAdmin(ctx.container, tenantA, {
        username: 'support-apps',
        roleKeys: ['support'],
      }),
    );
  });

  const auditOf = async (action: string) => {
    const { rows } = (await ctx.container.database.db.execute(
      sql`SELECT result, before, after FROM audit_logs
           WHERE tenant_id = ${tenantA.tenantId} AND action = ${action}
           ORDER BY occurred_at, id`,
    )) as unknown as {
      rows: {
        result: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      }[];
    };
    return rows;
  };

  it('creates, edits, switches and deletes, each with its own audit row of values', async () => {
    const created = await ctx.container.clientApps.create(tenantA, ownerA, {
      ...entry({ officialUrl: 'HTTPS://Downloads.Example.com/app.apk' }),
      idempotencyKey: key(),
    });
    expect(created).toMatchObject({
      status: 'ENABLED',
      version: 1,
      officialUrl: 'https://downloads.example.com/app.apk',
    });

    const edited = await ctx.container.clientApps.update(tenantA, ownerA, {
      ...entry({ alternativeUrl: 'https://store.example.com/app', sortOrder: 5 }),
      id: created.id,
      expectedVersion: 1,
      idempotencyKey: key(),
    });
    expect(edited).toMatchObject({ version: 2, sortOrder: 5 });

    const disabled = await ctx.container.clientApps.setStatus(tenantA, ownerA, {
      id: created.id,
      status: 'DISABLED',
      expectedVersion: 2,
      idempotencyKey: key(),
    });
    expect(disabled).toMatchObject({ status: 'DISABLED', version: 3 });

    // Already there: the row back, unchanged — no version bump and no audit row.
    const again = await ctx.container.clientApps.setStatus(tenantA, ownerA, {
      id: created.id,
      status: 'DISABLED',
      expectedVersion: 3,
      idempotencyKey: key(),
    });
    expect(again.version).toBe(3);

    const removed = await ctx.container.clientApps.remove(tenantA, ownerA, {
      id: created.id,
      expectedVersion: 3,
      idempotencyKey: key(),
    });
    expect(removed).toEqual({ id: created.id, deleted: true });
    expect(await ctx.container.clientApps.listForOperator(tenantA, ownerA)).toEqual([]);

    const [create] = await auditOf('client_app.create');
    expect(create).toMatchObject({ result: 'SUCCESS', before: null });
    expect(create?.after).toMatchObject({ officialUrl: 'https://downloads.example.com/app.apk' });
    const [update] = await auditOf('client_app.update');
    expect(update?.before).toMatchObject({ alternativeUrl: null, version: 1 });
    expect(update?.after).toMatchObject({
      alternativeUrl: 'https://store.example.com/app',
      version: 2,
    });
    expect(await auditOf('client_app.status')).toHaveLength(1);
    const [deleted] = await auditOf('client_app.delete');
    expect(deleted).toMatchObject({ result: 'SUCCESS', after: null });
    // The removed row's values survive in the audit trail.
    expect(deleted?.before).toMatchObject({ status: 'DISABLED', version: 3 });
  });

  it('refuses a stale version with the current one, and never overwrites', async () => {
    const created = await ctx.container.clientApps.create(tenantA, ownerA, {
      ...entry(),
      idempotencyKey: key(),
    });
    await ctx.container.clientApps.update(tenantA, ownerA, {
      ...entry({ name: 'اول' }),
      id: created.id,
      expectedVersion: 1,
      idempotencyKey: key(),
    });
    const stale = ctx.container.clientApps.update(tenantA, ownerA, {
      ...entry({ name: 'دوم' }),
      id: created.id,
      expectedVersion: 1,
      idempotencyKey: key(),
    });
    await expect(stale).rejects.toMatchObject({
      code: CONTROL_ERROR_CODES.CLIENT_APP_VERSION_CONFLICT,
      details: { currentVersion: 2 },
    });
    expect(
      await codeOf(
        ctx.container.clientApps.remove(tenantA, ownerA, {
          id: created.id,
          expectedVersion: 1,
          idempotencyKey: key(),
        }),
      ),
    ).toBe(CONTROL_ERROR_CODES.CLIENT_APP_VERSION_CONFLICT);
    const [row] = await ctx.container.clientApps.listForOperator(tenantA, ownerA);
    expect(row).toMatchObject({ name: 'اول', version: 2 });
  });

  it('answers a replay with the first result, and refuses the key with a different payload', async () => {
    const idempotencyKey = key();
    const first = await ctx.container.clientApps.create(tenantA, ownerA, {
      ...entry(),
      idempotencyKey,
    });
    const replay = await ctx.container.clientApps.create(tenantA, ownerA, {
      ...entry(),
      idempotencyKey,
    });
    expect(replay.id).toBe(first.id);
    expect(await ctx.container.clientApps.listForOperator(tenantA, ownerA)).toHaveLength(1);
    expect(
      await codeOf(
        ctx.container.clientApps.create(tenantA, ownerA, {
          ...entry({ name: 'دیگری' }),
          idempotencyKey,
        }),
      ),
    ).toBe('platform.idempotency_payload_mismatch');

    // A delete's replay says deleted again rather than "no such entry".
    const removeKey = key();
    await ctx.container.clientApps.remove(tenantA, ownerA, {
      id: first.id,
      expectedVersion: 1,
      idempotencyKey: removeKey,
    });
    expect(
      await ctx.container.clientApps.remove(tenantA, ownerA, {
        id: first.id,
        expectedVersion: 1,
        idempotencyKey: removeKey,
      }),
    ).toEqual({ id: first.id, deleted: true });
  });

  it('lets support read and refuses it every write, auditing the refusal', async () => {
    await ctx.container.clientApps.create(tenantA, ownerA, { ...entry(), idempotencyKey: key() });
    expect(await ctx.container.clientApps.listForOperator(tenantA, supportA)).toHaveLength(1);
    expect(
      await codeOf(
        ctx.container.clientApps.create(tenantA, supportA, { ...entry(), idempotencyKey: key() }),
      ),
    ).toBe('platform.permission_denied');
    const denied = (await auditOf('client_app.create')).filter((row) => row.result === 'DENIED');
    expect(denied).toHaveLength(1);
    expect(denied[0]?.after).toMatchObject({ deniedPermission: 'client_apps.edit' });
  });

  it('keeps each tenant’s entries its own: invisible, unreadable and unwritable to the other', async () => {
    const mine = await ctx.container.clientApps.create(tenantA, ownerA, {
      ...entry(),
      idempotencyKey: key(),
    });
    expect(await ctx.container.clientApps.listForOperator(tenantB, ownerB)).toEqual([]);
    for (const attempt of [
      () =>
        ctx.container.clientApps.update(tenantB, ownerB, {
          ...entry({ name: 'ربوده' }),
          id: mine.id,
          expectedVersion: 1,
          idempotencyKey: key(),
        }),
      () =>
        ctx.container.clientApps.setStatus(tenantB, ownerB, {
          id: mine.id,
          status: 'DISABLED',
          expectedVersion: 1,
          idempotencyKey: key(),
        }),
      () =>
        ctx.container.clientApps.remove(tenantB, ownerB, {
          id: mine.id,
          expectedVersion: 1,
          idempotencyKey: key(),
        }),
    ]) {
      expect(await codeOf(attempt())).toBe(CONTROL_ERROR_CODES.CLIENT_APP_NOT_FOUND);
    }
    // And the customer's read in tenant B does not find it either.
    const customer = '0191f4a0-0000-7000-8000-0000000000c1' as UserId;
    expect(await ctx.container.clientAppCatalog.appFor(tenantB, customer, mine.id)).toBeNull();
    const [still] = await ctx.container.clientApps.listForOperator(tenantA, ownerA);
    expect(still).toMatchObject({ name: 'برنامهٔ نمونه', status: 'ENABLED', version: 1 });
  });

  it('refuses unsafe content from any caller, not only the HTTP surface', async () => {
    for (const bad of [
      entry({ officialUrl: 'javascript:alert(1)' }),
      entry({ officialUrl: 'http://downloads.example.com/app.apk' }),
      entry({ helpUrl: 'data:text/html,<script>alert(1)</script>' }),
      entry({ guide: '<script>alert(1)</script>' }),
      entry({ guide: '[باز کن](javascript:alert(1))' }),
    ]) {
      expect(
        await codeOf(
          ctx.container.clientApps.create(tenantA, ownerA, { ...bad, idempotencyKey: key() }),
        ),
      ).toBe(CONTROL_ERROR_CODES.INVALID_VALUE);
    }
    expect(await ctx.container.clientApps.listForOperator(tenantA, ownerA)).toEqual([]);
    // The table holds the scheme rule too, for a writer that goes around the service.
    await expect(
      ctx.container.database.db.execute(
        sql`INSERT INTO client_apps (id, tenant_id, platform, name, description, official_url, guide)
            VALUES (${'0191f4a0-2d3c-7c2b-9a41-000000000999'}, ${tenantA.tenantId}, 'ANDROID', 'x', 'x',
                    'javascript:alert(1)', 'x')`,
      ),
    ).rejects.toMatchObject({ cause: { constraint: 'client_apps_urls_check' } });
  });

  it('backfills client_apps.* into roles that already exist, and exactly the seeded pairs', async () => {
    // An installation whose roles predate this release holds neither key.
    await ctx.container.database.db.execute(
      sql`DELETE FROM role_permissions WHERE permission_key LIKE 'client_apps.%'`,
    );
    const migration = readFileSync('apps/api/drizzle/0131_wp_a10_client_apps.sql', 'utf8');
    const backfill = migration.slice(migration.indexOf('INSERT INTO "role_permissions"'));
    await ctx.container.database.db.execute(sql.raw(backfill));
    // Idempotent: the release may be re-run.
    await ctx.container.database.db.execute(sql.raw(backfill));
    const { rows } = (await ctx.container.database.db.execute(
      sql`SELECT r.key AS role_key, rp.permission_key
            FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
           WHERE rp.tenant_id = ${tenantA.tenantId} AND rp.permission_key LIKE 'client_apps.%'
           ORDER BY r.key, rp.permission_key`,
    )) as unknown as { rows: { role_key: string; permission_key: string }[] };
    expect(rows.map((row) => `${row.role_key}:${row.permission_key}`)).toEqual([
      'observer:client_apps.view',
      'operator:client_apps.edit',
      'operator:client_apps.view',
      'owner:client_apps.edit',
      'owner:client_apps.view',
      'support:client_apps.view',
    ]);
  });

  it('bounds the entries per tenant, and refuses every write once the tenant is stopped', async () => {
    for (let index = 0; index < CLIENT_APP_MAX_ENTRIES; index += 1) {
      await ctx.container.database.db.execute(
        sql`INSERT INTO client_apps (id, tenant_id, platform, name, description, official_url, guide)
            VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, 'ANDROID', ${`app ${String(index)}`},
                    'd', 'https://downloads.example.com/a', 'g')`,
      );
    }
    expect(
      await codeOf(
        ctx.container.clientApps.create(tenantA, ownerA, { ...entry(), idempotencyKey: key() }),
      ),
    ).toBe(CONTROL_ERROR_CODES.CLIENT_APP_LIMIT);
    await ctx.container.clientApps.create(tenantB, ownerB, { ...entry(), idempotencyKey: key() });

    const [row] = await ctx.container.clientApps.listForOperator(tenantB, ownerB);
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantB.tenantId}`,
    );
    expect(
      await codeOf(
        ctx.container.clientApps.setStatus(tenantB, ownerB, {
          id: row?.id ?? '',
          status: 'DISABLED',
          expectedVersion: 1,
          idempotencyKey: key(),
        }),
      ),
    ).toBe(COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID);
  });
});

// ============================================================================
// The customer's bot
// ============================================================================

const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const MARYAM = '910911';
const REZA = '920921';

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

describe('client apps — what a customer is shown', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  let panel: FakeMarzban;
  let owner: ActorContext;
  let ownerB: ActorContext;
  let panelId: string;
  let maryam: UserId;
  let updateSeq = 0;

  beforeAll(async () => {
    sent = [];
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = { unparseable: true };
        }
        sent.push({ url: request.url ?? '', body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  afterEach(async () => {
    await panel?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    sent = [];
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-appbot', roleKeys: ['owner'] }),
    );
    ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-appbotb', roleKeys: ['owner'] }),
    );
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-apps-create',
    });
    panelId = created.view.panel.id;
    await validatePanelConnection(ctx.container, tenantA, panelId);
    maryam = await resolve(MARYAM, 'مریم');
    // Reza buys nothing: the customer with no live service.
    await resolve(REZA, 'رضا');
  });

  async function resolve(telegramUserId: string, firstName: string): Promise<UserId> {
    const resolved = await ctx.container.customers.resolveFromUpdate(
      tenantA,
      systemActor(`resolve-${telegramUserId}`),
      {
        idempotencyKey: `resolve-${telegramUserId}`,
        telegramUserId,
        from: { id: Number(telegramUserId), first_name: firstName },
        botInstanceId: BOT_A,
      },
    );
    return resolved.customer.id;
  }

  /** One ACTIVE Marzban service for `customerId`, provisioned against the fake panel. */
  async function activeService(customerId: UserId): Promise<string> {
    const products = new DrizzleProductRepository(ctx.container.database.db);
    const services = new DrizzleServiceRepository(ctx.container.database.db);
    const row = await products.create(tenantA, {
      id: ctx.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن اپ',
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
    await products.setStatus(tenantA, row.id, 'INACTIVE', 'ACTIVE', ctx.container.clock.now());
    const draft = await ctx.container.orders.createDraft(tenantA, systemActor('draft'), {
      idempotencyKey: 'apps-draft',
      customerId,
      productId: row.id,
    });
    const confirmed = await ctx.container.orders.confirm(tenantA, systemActor('confirm'), {
      idempotencyKey: 'apps-confirm',
      customerId,
      orderId: draft.id,
    });
    await ctx.container.wallet.adjust(tenantA, owner, customerId, {
      idempotencyKey: 'apps-credit',
      direction: 'CREDIT',
      amountMinor: 1_000_000n,
      currency: 'IRT',
      note: 'fixture',
    });
    await ctx.container.payments.settleFromWallet(tenantA, systemActor('pay'), customerId, {
      idempotencyKey: 'apps-pay',
      orderId: confirmed.id as OrderId,
    });
    await ctx.container.provisionerLoop.tick();
    const service = await services.findByOrderId(tenantA, confirmed.id as OrderId);
    if (service === null || service === undefined) throw new Error('no service');
    expect(service.state, 'the fixture must start ACTIVE').toBe('ACTIVE');
    return service.id;
  }

  async function add(overrides: Partial<ClientAppInput>, scope = tenantA): Promise<string> {
    const created = await ctx.container.clientApps.create(
      scope,
      scope === tenantA ? owner : ownerB,
      { ...entry(overrides), idempotencyKey: key() },
    );
    return created.id;
  }

  const customerUpdate = (payload: Record<string, unknown>, telegramUserId: string) => {
    updateSeq += 1;
    return {
      idempotencyKey: `apps-update-${String(updateSeq)}`,
      botInstanceId: BOT_A,
      update: { update_id: 700_000 + updateSeq, ...payload },
      telegramUserId,
      from: { id: Number(telegramUserId), first_name: 'x' },
    };
  };
  const tap = (data: string, telegramUserId = MARYAM) =>
    customerUpdate(
      {
        callback_query: {
          id: `cbq-${String(updateSeq)}`,
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'x' },
          data,
          message: {
            message_id: updateSeq,
            date: 0,
            chat: { id: Number(telegramUserId), type: 'private' },
            from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          },
        },
      },
      telegramUserId,
    );
  const text = (value: string, telegramUserId = MARYAM) =>
    customerUpdate(
      {
        message: {
          message_id: updateSeq,
          date: 0,
          chat: { id: Number(telegramUserId), type: 'private' },
          from: { id: Number(telegramUserId), is_bot: false, first_name: 'x' },
          text: value,
        },
      },
      telegramUserId,
    );
  const handle = (update: ReturnType<typeof customerUpdate>) =>
    ctx.container.botRuntime.handle(tenantA, systemActor('bot'), update);
  const last = () => sent.filter((one) => one.url.includes('/sendMessage')).at(-1);
  const lastText = () => String(last()?.body['text'] ?? '');
  const lastMarkup = () => JSON.stringify(last()?.body['reply_markup'] ?? {});
  const callbacks = () =>
    [...lastMarkup().matchAll(/"callback_data":"([^"]+)"/g)].map((m) => m[1] as string);
  const urls = () => [...lastMarkup().matchAll(/"url":"([^"]+)"/g)].map((m) => m[1] as string);

  it('keeps the guide exactly as it was when the operator has configured nothing', async () => {
    const choice = await handle(tap('tu:'));
    expect(choice.replyKey).toBe('bot.tutorial.choose');
    expect(callbacks()).toEqual([
      'to:ANDROID',
      'to:IOS',
      'to:WINDOWS',
      'to:MACOS',
      'to:LINUX',
      'mm:',
    ]);
    const android = await handle(tap('to:ANDROID'));
    expect(android.replyKey).toBe('bot.tutorial.android');
    expect(callbacks()).toEqual(['tu:', 'mm:']);
  });

  it('opens from /apps and from the menu label, and lists ENABLED apps in the operator’s order', async () => {
    const second = await add({ name: 'دوم', sortOrder: 20, icon: '🔵' });
    const first = await add({ name: 'اول', sortOrder: 10 });
    const hidden = await add({ name: 'خاموش', sortOrder: 15 });
    await ctx.container.clientApps.setStatus(tenantA, owner, {
      id: hidden,
      status: 'DISABLED',
      expectedVersion: 1,
      idempotencyKey: key(),
    });
    await add({ name: 'آیفون', platform: 'IOS' });

    expect((await handle(text('/apps', REZA))).replyKey).toBe('bot.tutorial.choose');
    expect((await handle(text('📱 دانلود برنامه و آموزش اتصال', REZA))).replyKey).toBe(
      'bot.tutorial.choose',
    );

    const list = await handle(tap('to:ANDROID', REZA));
    expect(list.replyKey).toBe('bot.apps.platform');
    expect(callbacks()).toEqual([`ca:${first}`, `ca:${second}`, 'tu:', 'mm:']);
    expect(lastMarkup()).toContain('🔵 دوم');
    expect(lastMarkup()).not.toContain('خاموش');

    // A disabled entry tapped from an older message is gone, not served.
    expect((await handle(tap(`ca:${hidden}`, REZA))).replyKey).toBe('bot.apps.not_found');
  });

  it('offers «Other» only once an app is filed there', async () => {
    await handle(tap('tu:', REZA));
    expect(callbacks()).not.toContain('to:OTHER');
    const other = await add({ name: 'تلویزیون', platform: 'OTHER' });
    await handle(tap('tu:', REZA));
    expect(callbacks()).toContain('to:OTHER');
    await handle(tap('to:OTHER', REZA));
    expect(callbacks()).toEqual([`ca:${other}`, 'tu:', 'mm:']);
  });

  it('filters by what the customer’s REAL service is, and shows all to a customer with none', async () => {
    const anyApp = await add({ name: 'همه‌کاره', sortOrder: 1 });
    const vless = await add({ name: 'VLESS', sortOrder: 2, protocols: ['vless'] });
    const filesOnly = await add({
      name: 'فایلی',
      sortOrder: 3,
      deliveryKinds: ['CONNECTION_FILES'],
    });
    const rick = await add({ name: 'ریک', sortOrder: 4, providerTypes: ['rickpanel'] });
    const vmess = await add({ name: 'VMESS', sortOrder: 5, protocols: ['vmess'] });
    const serviceId = await activeService(maryam);

    // Reza has bought nothing: every enabled Android app.
    await handle(tap('to:ANDROID', REZA));
    expect(callbacks().slice(0, 5)).toEqual([
      `ca:${anyApp}`,
      `ca:${vless}`,
      `ca:${filesOnly}`,
      `ca:${rick}`,
      `ca:${vmess}`,
    ]);

    // Maryam's service is a Marzban link over vless, with no connection files.
    await handle(tap('to:ANDROID', MARYAM));
    expect(callbacks()).toEqual([`ca:${anyApp}`, `ca:${vless}`, 'tu:', 'mm:']);

    // Her app screen: the links as URL buttons, then the existing redelivery action for
    // her one service — never the subscription URL itself.
    const detail = await handle(tap(`ca:${vless}`, MARYAM));
    expect(detail.replyKey).toBe('bot.apps.detail');
    expect(urls()).toEqual(['https://downloads.example.com/app.apk']);
    expect(callbacks()).toEqual([`r:${serviceId}`, 'to:ANDROID', 'mm:']);
    const services = new DrizzleServiceRepository(ctx.container.database.db);
    const url = (await services.findById(tenantA, serviceId))?.subscriptionUrl ?? '';
    expect(url).not.toBe('');
    expect(JSON.stringify(last()?.body)).not.toContain(url);
  });

  it('sends the guide as plain text, with an unsafe link that got into a row reduced to its label', async () => {
    const id = ctx.container.ids.uuid();
    // A row written around the service, which is the only way such a guide can exist.
    await ctx.container.database.db.execute(
      sql`INSERT INTO client_apps (id, tenant_id, platform, name, description, official_url, guide)
          VALUES (${id}, ${tenantA.tenantId}, 'ANDROID', 'نمونه', 'توضیح',
                  'https://downloads.example.com/a',
                  ${'<b>پررنگ</b>\n- گام اول\n[باز کن](javascript:alert(1))\n[دانلود](https://downloads.example.com/a)'})`,
    );
    const detail = await handle(tap(`ca:${id}`, REZA));
    expect(detail.replyKey).toBe('bot.apps.detail');
    const body = last()?.body ?? {};
    expect(body['parse_mode']).toBeUndefined();
    expect(lastText()).toContain('<b>پررنگ</b>');
    expect(lastText()).toContain('• گام اول');
    expect(lastText()).toContain('دانلود: https://downloads.example.com/a');
    expect(lastText()).toContain('باز کن');
    expect(lastText()).not.toContain('javascript:');
  });

  it('never serves another tenant’s app to this tenant’s customer', async () => {
    const theirs = await add({ name: 'مال دیگری' }, tenantB);
    expect((await handle(tap(`ca:${theirs}`, REZA))).replyKey).toBe('bot.apps.not_found');
    await handle(tap('to:ANDROID', REZA));
    expect(callbacks()).toEqual(['tu:', 'mm:']);
  });

  it('shows an operator’s change on the next tap, with no deploy', async () => {
    const id = await add({ name: 'قدیمی', officialUrl: 'https://old.example.com/a' });
    await handle(tap(`ca:${id}`, REZA));
    expect(urls()).toEqual(['https://old.example.com/a']);
    await ctx.container.clientApps.update(tenantA, owner, {
      ...entry({
        name: 'تازه',
        officialUrl: 'https://new.example.com/a',
        helpUrl: 'https://video.example.com/a',
      }),
      id,
      expectedVersion: 1,
      idempotencyKey: key(),
    });
    await handle(tap(`ca:${id}`, REZA));
    expect(lastText()).toContain('تازه');
    expect(urls()).toEqual(['https://new.example.com/a', 'https://video.example.com/a']);
  });
});

// ============================================================================
// Over HTTP
// ============================================================================

describe('client apps over HTTP', () => {
  const ORIGIN = 'https://admin.example.test';
  let api: ApiApp;
  let cookie: string;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
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
    await createAdmin(api.container, tenantA, {
      username: 'owner-apps-http',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    const login = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner-apps-http', password: 'the-owners-real-password' },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(login.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error('No session cookie.');
    cookie = `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  });

  it('creates, lists, edits and deletes through the controller, and refuses an unsafe body', async () => {
    const created = await inject({
      method: 'POST',
      url: `${API_PREFIX}${CLIENT_APP_ROUTES.create}`,
      headers: { cookie, origin: ORIGIN },
      payload: { ...entry(), idempotencyKey: key() },
    });
    expect(created.statusCode).toBe(201);
    const row = clientAppSchema.parse(created.json());

    const listed = await inject({
      method: 'GET',
      url: `${API_PREFIX}${CLIENT_APP_ROUTES.list}`,
      headers: { cookie },
    });
    expect(clientAppListSchema.parse(listed.json()).items.map((item) => item.id)).toEqual([row.id]);

    const edited = await inject({
      method: 'POST',
      url: `${API_PREFIX}${CLIENT_APP_ROUTES.update(row.id)}`,
      headers: { cookie, origin: ORIGIN },
      payload: { ...entry({ name: 'ویرایش' }), expectedVersion: 1, idempotencyKey: key() },
    });
    expect(clientAppSchema.parse(edited.json())).toMatchObject({ name: 'ویرایش', version: 2 });

    for (const unsafe of [
      { officialUrl: 'javascript:alert(1)' },
      { guide: '<script>alert(1)</script>' },
      { alternativeUrl: 'http://store.example.com/a' },
    ]) {
      const refused = await inject({
        method: 'POST',
        url: `${API_PREFIX}${CLIENT_APP_ROUTES.create}`,
        headers: { cookie, origin: ORIGIN },
        payload: { ...entry(), ...unsafe, idempotencyKey: key() },
      });
      expect(refused.statusCode).toBe(400);
    }

    const removed = await inject({
      method: 'POST',
      url: `${API_PREFIX}${CLIENT_APP_ROUTES.remove(row.id)}`,
      headers: { cookie, origin: ORIGIN },
      payload: { expectedVersion: 2, idempotencyKey: key() },
    });
    expect(removed.json()).toEqual({ id: row.id, deleted: true });

    // A path id that is not a UUID is "no such entry", never a 500 from the uuid cast (C2).
    for (const [url, payload] of [
      [CLIENT_APP_ROUTES.update('not-a-uuid'), { ...entry(), expectedVersion: 1 }],
      [CLIENT_APP_ROUTES.status('not-a-uuid'), { status: 'DISABLED', expectedVersion: 1 }],
      [CLIENT_APP_ROUTES.remove("1' OR '1'='1"), { expectedVersion: 1 }],
    ] as const) {
      const malformed = await inject({
        method: 'POST',
        url: `${API_PREFIX}${url}`,
        headers: { cookie, origin: ORIGIN },
        payload: { ...payload, idempotencyKey: key() },
      });
      expect(malformed.statusCode, url).toBe(404);
      expect(malformed.json()).toMatchObject({
        error: { code: CONTROL_ERROR_CODES.CLIENT_APP_NOT_FOUND },
      });
    }

    const noOrigin = await inject({
      method: 'POST',
      url: `${API_PREFIX}${CLIENT_APP_ROUTES.create}`,
      headers: { cookie },
      payload: { ...entry(), idempotencyKey: key() },
    });
    expect(noOrigin.statusCode).toBe(403);
    const anonymous = await inject({
      method: 'GET',
      url: `${API_PREFIX}${CLIENT_APP_ROUTES.list}`,
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
