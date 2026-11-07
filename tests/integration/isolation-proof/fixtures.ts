import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import {
  API_PREFIX,
  BROADCAST_ROUTES,
  CLIENT_APP_ROUTES,
  GIFT_CARD_ROUTES,
  SESSION_COOKIE_NAME,
  TELEGRAM_SECRET_TOKEN_HEADER,
  TENANT_MEDIA_ROUTES,
  type ActorContext,
  type CorrelationId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { ApiApp } from '../../../apps/api/src/bootstrap';
import { seed } from '../../../apps/api/src/infrastructure/persistence/seed';
import { TENANT_POLICY } from '../../../apps/api/src/infrastructure/persistence/row-level-security';
import { startFakeTelegramBotApi, type FakeTelegramBotApi } from '../../support/fake-telegram-bot-api';
import {
  createAdmin,
  createApiApp,
  migrateOnce,
  resetDatabase,
  SEED_IDS,
  testConfig,
  type SeededAdmin,
} from '../harness';

/**
 * Phase 6A PR-5 (D3) — the isolation proof's one world.
 *
 * THREE tenants, every one of them full: the installation's PRIMARY (the seed's tenant A,
 * the owner's own bot) and TWO HOSTED tenants, children of it, shaped as the creator
 * panel's `provision` writes them (kind HOSTED, a `hosted_bots` row on the installation).
 * Each holds the same household — a bot, an owner and a staff admin with a live Web Admin
 * session, a panel, a product, a customer with the SAME Telegram id as the others' (the
 * twin that makes an accidental cross-tenant match visible), an order, a service, a
 * payment with a receipt, a ticket with an attachment, a wallet credit, a broadcast, a
 * setting and a media file — each tagged with a marker string unique to its tenant, so a
 * leak anywhere in a response body is a substring away.
 *
 * Fixtures are written as the OWNER role (`container.database`): they are not application
 * code. Everything the cases then do goes through the real API app, which connects as
 * `nexa_app` (ADR-0037), so row-level security binds every statement under test.
 *
 * The mutation hook: `NEXA_ISOLATION_MUTATION_DROP_POLICY=<table>` drops that one table's
 * tenant policy (and `NEXA_ISOLATION_MUTATION_DISABLE_RLS=1` also switches the table's RLS
 * off) right after the migration, so `scripts/claude/isolation-mutation.sh` can show the
 * suite going red. The next migration run puts it back (`ensureRowLevelSecurity`). Unset
 * — always, outside that script — it does nothing.
 */

export const ORIGIN = 'https://isolation.example.test';
export const WEBHOOK_SECRET = 'isolation-proof-webhook-secret-0123456789';
export const PASSWORD = 'isolation-proof-password';
/** Every tenant's customer has this Telegram id: the twin. */
export const TWIN_TELEGRAM_USER_ID = '111111111';

export const HOSTED_1 = '01900000-0000-7000-8000-0000000d0001';
export const HOSTED_2 = '01900000-0000-7000-8000-0000000d0002';

export type TenantLabel = 'PRIMARY' | 'HOSTED_1' | 'HOSTED_2';

export interface TenantWorld {
  readonly label: TenantLabel;
  readonly tenantId: string;
  readonly scope: TenantContext;
  /** Unique to this tenant; every record below carries it in a text field. */
  readonly marker: string;
  readonly botId: string;
  readonly telegramBotId: number;
  readonly botToken: string;
  readonly categoryId: string;
  readonly panelId: string;
  readonly productId: string;
  readonly customerId: string;
  readonly orderId: string;
  readonly orderAmountMinor: string;
  readonly serviceId: string;
  readonly paymentId: string;
  readonly paymentCode: string;
  readonly receiptId: string;
  readonly ticketCategoryId: string;
  readonly ticketId: string;
  readonly ticketMessageId: string;
  readonly walletAmountMinor: string;
  readonly broadcastId: string;
  /** A gift-card batch (its codes are an export: a file of bearer instruments). */
  readonly giftCardBatchId: string;
  /** A client-app entry with a stored image (a file served by the entry's id). */
  readonly clientAppId: string;
  readonly owner: SeededAdmin;
  readonly ownerActor: ActorContext;
  readonly staffId: string;
  /** The owner's live Web Admin session, as the browser presents it. */
  readonly cookie: string;
  readonly mediaPurpose: 'REFERRAL_BANNER';
}

export interface World {
  readonly api: ApiApp;
  readonly telegram: FakeTelegramBotApi;
  readonly tenants: Readonly<Record<TenantLabel, TenantWorld>>;
  inject(options: Record<string, unknown>): Promise<{
    statusCode: number;
    body: string;
    headers: Record<string, unknown>;
    json(): unknown;
  }>;
  key(): string;
  close(): Promise<void>;
}

/**
 * [attacker, victim]: the installation and a hosted tenant both ways, and the two hosted
 * tenants both ways. Every cross-tenant case runs over all four.
 */
export const PAIRS: readonly (readonly [TenantLabel, TenantLabel])[] = [
  ['HOSTED_1', 'PRIMARY'],
  ['PRIMARY', 'HOSTED_1'],
  ['HOSTED_1', 'HOSTED_2'],
  ['HOSTED_2', 'HOSTED_1'],
];

const SPEC: Readonly<
  Record<
    TenantLabel,
    {
      tenantId: string;
      botId: string;
      categoryId: string | null;
      marker: string;
      telegramBotId: number;
      botUsername: string;
      orderAmount: string;
      walletAmount: string;
    }
  >
> = {
  PRIMARY: {
    tenantId: SEED_IDS.tenantA,
    botId: SEED_IDS.botA1,
    categoryId: SEED_IDS.categoryA,
    marker: 'zqprimaryq',
    telegramBotId: 7100000001,
    botUsername: 'acme_store_bot',
    orderAmount: '250000',
    walletAmount: '31111',
  },
  HOSTED_1: {
    tenantId: HOSTED_1,
    botId: '01900000-0000-7000-8000-0000000db001',
    categoryId: null,
    marker: 'zqhostedoneq',
    telegramBotId: 7100000002,
    botUsername: 'hosted_one_bot',
    orderAmount: '370000',
    walletAmount: '42222',
  },
  HOSTED_2: {
    tenantId: HOSTED_2,
    botId: '01900000-0000-7000-8000-0000000db002',
    categoryId: null,
    marker: 'zqhostedtwoq',
    telegramBotId: 7100000003,
    botUsername: 'hosted_two_bot',
    orderAmount: '490000',
    walletAmount: '53333',
  },
};

const quote = (productId: string, amount: string) =>
  JSON.stringify({
    productId,
    quotedAt: '2026-01-01T00:00:00.000Z',
    currency: 'IRT',
    finalAmount: { amountMinor: amount, currency: 'IRT' },
    trace: [
      {
        step: 'BASE_PRICE',
        effect: 'REPLACES',
        ruleId: null,
        ruleLabel: 'list price',
        amountBefore: { amountMinor: amount, currency: 'IRT' },
        amountAfter: { amountMinor: amount, currency: 'IRT' },
      },
    ],
  });

/** A minimal PNG: the magic number and filler. */
export function png(size = 64): Buffer {
  const bytes = Buffer.alloc(size, 0x11);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return bytes;
}

/** A PNG whose IHDR names its dimensions (a client app's image is checked for them). */
export function sizedPng(width: number, height: number, total: number): Buffer {
  const bytes = Buffer.alloc(total, 0x2a);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(bytes);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

export async function buildWorld(env: Partial<NodeJS.ProcessEnv> = {}): Promise<World> {
  const telegram = await startFakeTelegramBotApi();
  const config = testConfig({
    WEB_ADMIN_ORIGINS: ORIGIN,
    TELEGRAM_WEBHOOK_ENABLED: 'true',
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_API_BASE_URL: telegram.url,
    ...env,
  });
  await migrateOnce(config.DATABASE_URL);
  const api = await createApiApp(config);
  const owner = api.container.database.db;
  const run = (statement: ReturnType<typeof sql>) => owner.execute(statement);
  const newId = () => api.container.ids.uuid();
  let keys = 0;
  const key = () => `iso-proof-${String((keys += 1)).padStart(6, '0')}`;
  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never) as unknown as ReturnType<World['inject']>;

  await resetDatabase(owner);
  await seed(owner, api.container.cipher);
  await applyMutation(api);
  api.container.setInstallationTenant(SEED_IDS.tenantA as never, 'PRIMARY');

  const tenants = {} as Record<TenantLabel, TenantWorld>;
  for (const label of ['PRIMARY', 'HOSTED_1', 'HOSTED_2'] as const) {
    const spec = SPEC[label];
    const tenantId = spec.tenantId;
    const scope: TenantContext = { tenantId: tenantId as never, botInstanceId: null };
    const token = telegram.createBot({ id: spec.telegramBotId, username: spec.botUsername });
    const secret = api.container.cipher.encrypt(token, {
      purpose: 'bot_instance.token',
      tenantId,
      entityId: spec.botId,
    });
    if (label !== 'PRIMARY') {
      // As the creator panel's `provision` writes a hosted tenant (drizzle-hosted-tenant-
      // system-path.ts), plus the rows the seed gives every tenant it makes.
      await run(sql`INSERT INTO tenants (id, kind, parent_tenant_id, slug, display_name, status,
                                         locale, display_timezone, calendar, currency)
        VALUES (${tenantId}, 'HOSTED', ${SEED_IDS.tenantA}, ${`hosted-${spec.marker}`},
                ${`Hosted ${spec.marker}`}, 'ACTIVE', 'fa', 'Asia/Tehran', 'jalali', 'IRT')`);
      await run(sql`INSERT INTO bot_instances (id, tenant_id, username, status, token_ciphertext,
                                               token_key_id, telegram_bot_id)
        VALUES (${spec.botId}, ${tenantId}, ${spec.botUsername}, 'ACTIVE', ${secret.ciphertext},
                ${secret.keyId}, ${String(spec.telegramBotId)})`);
      await run(sql`INSERT INTO payment_gateways (tenant_id, provider, status, bounds_currency)
        SELECT ${tenantId}, provider, status, bounds_currency FROM payment_gateways
         WHERE tenant_id = ${SEED_IDS.tenantA}`);
    } else {
      await run(sql`UPDATE bot_instances
                       SET token_ciphertext = ${secret.ciphertext}, token_key_id = ${secret.keyId},
                           telegram_bot_id = ${String(spec.telegramBotId)}
                     WHERE id = ${spec.botId}`);
    }
    const categoryId = spec.categoryId ?? newId();
    if (spec.categoryId === null) {
      await run(sql`INSERT INTO product_categories (id, tenant_id, name, sort_order)
        VALUES (${categoryId}, ${tenantId}, ${`Category ${spec.marker}`}, 0)`);
    }

    const ownerAdmin = await createAdmin(api.container, scope, {
      username: `owner-${spec.marker}`,
      password: PASSWORD,
      roleKeys: ['owner'],
    });
    const staff = await createAdmin(api.container, scope, {
      username: `staff-${spec.marker}`,
      password: PASSWORD,
      roleKeys: ['operator'],
    });
    const login = await api.container.auth.login(
      scope,
      { type: 'API', id: null, label: null, surface: 'WEB', correlationId: 'c' as CorrelationId },
      { username: ownerAdmin.username, password: PASSWORD },
      { ip: null, userAgent: null },
    );
    const ownerActor: ActorContext = {
      type: 'WEB_ADMIN',
      id: ownerAdmin.id,
      label: ownerAdmin.username,
      surface: 'WEB',
      correlationId: 'iso-proof' as CorrelationId,
      sessionId: login.session.id,
    };
    if (label !== 'PRIMARY') {
      const installationOwner = tenants.PRIMARY.owner.id;
      await run(sql`INSERT INTO hosted_bots (tenant_id, hosted_tenant_id, state, owner_admin_id,
                                             created_by_admin_id, created_at, state_changed_at,
                                             updated_at)
        VALUES (${SEED_IDS.tenantA}, ${tenantId}, 'ACTIVE', ${ownerAdmin.id},
                ${installationOwner}, now(), now(), now())`);
    }

    // The household (the global-search fixture's, per tenant, plus the files).
    const panelId = newId();
    await run(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
      VALUES (${panelId}, ${tenantId}, ${`Panel ${spec.marker}`}, 'marzban',
              ${`https://${spec.marker}.panel.test`}, 'ACTIVE')`);
    const productId = newId();
    await run(sql`INSERT INTO products
        (id, tenant_id, title, status, audience, sort_order, panel_id, category_id,
         duration_days, traffic_bytes, price_amount, price_currency)
      VALUES (${productId}, ${tenantId}, ${`Plan ${spec.marker}`}, 'ACTIVE', 'EVERYONE', 0,
              ${panelId}, ${categoryId}, 30, 53687091200, ${spec.orderAmount}, 'IRT')`);
    const customerId = newId();
    await run(sql`INSERT INTO customers
        (id, tenant_id, telegram_user_id, username, first_name, last_name, status, created_at,
         first_bot_instance_id)
      VALUES (${customerId}, ${tenantId}, ${TWIN_TELEGRAM_USER_ID}, ${`cust_${spec.marker}`},
              ${`First${spec.marker}`}, 'Rezaei', 'ACTIVE', now() - interval '1 hour',
              ${spec.botId})`);
    const orderId = newId();
    await run(sql`INSERT INTO orders
        (id, tenant_id, customer_id, state, product_id, panel_id, line_title,
         line_duration_days, line_traffic_bytes, line_unit_price_amount, line_quantity,
         subtotal_amount, discount_amount, total_amount, currency, quote, settled_at, confirmed_at)
      VALUES (${orderId}, ${tenantId}, ${customerId}, 'PAID', ${productId}, ${panelId},
              ${`Plan ${spec.marker}`}, 30, 53687091200, ${spec.orderAmount}, 1,
              ${spec.orderAmount}, 0, ${spec.orderAmount}, 'IRT',
              ${quote(productId, spec.orderAmount)}::jsonb, now(), now())`);
    const serviceId = newId();
    await run(sql`INSERT INTO services
        (id, tenant_id, customer_id, order_id, panel_id, product_id, provider_username, state,
         delivery_state, traffic_limit_bytes, traffic_used_bytes, provisioned_at, delivered_at,
         subscription_url)
      VALUES (${serviceId}, ${tenantId}, ${customerId}, ${orderId}, ${panelId}, ${productId},
              ${`svc${spec.marker}`}, 'ACTIVE', 'DELIVERED', 53687091200, 0, now(), now(),
              ${`https://${spec.marker}.panel.test/sub/svc${spec.marker}`})`);
    const paymentId = newId();
    await run(sql`INSERT INTO payments
        (id, tenant_id, customer_id, order_id, state, method, amount, currency, reference,
         expires_at)
      VALUES (${paymentId}, ${tenantId}, ${customerId}, ${orderId}, 'PENDING', 'MANUAL_TRANSFER',
              ${spec.orderAmount}, 'IRT', ${`NX-${spec.marker}`}, now() + interval '1 hour')`);
    const paymentCode = (
      (await run(sql`SELECT code FROM payments WHERE id = ${paymentId}`)).rows[0] as {
        code: string;
      }
    ).code;
    const receiptId = newId();
    await run(sql`INSERT INTO payment_receipts (id, tenant_id, bot_instance_id, customer_id,
                                                payment_id, kind, file_id, file_unique_id,
                                                caption, created_at)
      VALUES (${receiptId}, ${tenantId}, ${spec.botId}, ${customerId}, ${paymentId}, 'PHOTO',
              ${`file-${spec.marker}`}, ${`uniq-${spec.marker}`}, ${`Receipt ${spec.marker}`},
              now())`);
    const ticketCategoryId = newId();
    await run(sql`INSERT INTO ticket_categories (id, tenant_id, title)
      VALUES (${ticketCategoryId}, ${tenantId}, ${`Topic ${spec.marker}`})`);
    const ticketId = newId();
    await run(sql`INSERT INTO tickets
        (id, tenant_id, customer_id, bot_instance_id, category_id, category_title, subject,
         opening_key)
      VALUES (${ticketId}, ${tenantId}, ${customerId}, ${spec.botId}, ${ticketCategoryId},
              ${`Topic ${spec.marker}`}, ${`Subject ${spec.marker}`}, ${`open-${ticketId}`})`);
    const ticketMessageId = newId();
    await run(sql`INSERT INTO ticket_messages
        (id, tenant_id, ticket_id, sender_type, body, attachment_kind, attachment_bot_instance_id,
         attachment_file_id, attachment_file_unique_id, attachment_mime_type,
         attachment_file_name, attachment_file_size, idempotency_key, request_hash)
      VALUES (${ticketMessageId}, ${tenantId}, ${ticketId}, 'CUSTOMER', ${`Body ${spec.marker}`},
              'DOCUMENT', ${spec.botId}, ${`doc-${spec.marker}`}, ${`docu-${spec.marker}`},
              'application/pdf', ${`file-${spec.marker}.pdf`}, 100, ${`msg-${ticketMessageId}`},
              ${`hash-${ticketMessageId}`})`);

    // Through the application, as that tenant's own owner.
    await api.container.wallet.adjust(scope, ownerActor, customerId as UserId, {
      idempotencyKey: key(),
      direction: 'CREDIT',
      amountMinor: BigInt(spec.walletAmount),
      currency: 'IRT',
      note: `Credit ${spec.marker}`,
    });
    await api.container.settingsService.set(scope, ownerActor, {
      key: 'ops.notifications.max_attempts',
      value: label === 'PRIMARY' ? 4 : label === 'HOSTED_1' ? 5 : 6,
      expectedVersion: null,
      idempotencyKey: key(),
    });
    const cookie = `${SESSION_COOKIE_NAME}=${login.token}`;
    const broadcast = await inject({
      method: 'POST',
      url: `${API_PREFIX}${BROADCAST_ROUTES.create}`,
      headers: { origin: ORIGIN, cookie },
      payload: {
        idempotencyKey: key(),
        title: `Broadcast ${spec.marker}`,
        contentKind: 'TEXT',
        body: `Hello ${spec.marker}`,
        buttons: [],
        audience: { version: 1 },
      },
    });
    expect(broadcast.statusCode, broadcast.body).toBe(201);
    const broadcastId = (broadcast.json() as { broadcast: { id: string } }).broadcast.id;
    const media = await inject({
      method: 'POST',
      url: `${API_PREFIX}${TENANT_MEDIA_ROUTES.upload('REFERRAL_BANNER')}`,
      headers: { origin: ORIGIN, cookie },
      payload: {
        mimeType: 'image/png',
        contentBase64: png(64 + Object.keys(tenants).length).toString('base64'),
        idempotencyKey: key(),
      },
    });
    expect(media.statusCode, media.body).toBeLessThan(300);

    // A gift-card batch (an export) and a client app with an image (a file), through the API.
    const giftFlag = (await api.container.featureFlags.list(scope, ownerActor)).find(
      (flag) => flag.key === 'gift_cards',
    );
    if (giftFlag === undefined) throw new Error('no gift_cards flag');
    await api.container.featureFlags.set(scope, ownerActor, {
      idempotencyKey: key(),
      key: 'gift_cards',
      enabled: true,
      expectedVersion: giftFlag.version,
      confirmKey: 'gift_cards',
      reason: 'isolation proof',
    });
    const gift = await inject({
      method: 'POST',
      url: `${API_PREFIX}${GIFT_CARD_ROUTES.batches}`,
      headers: { origin: ORIGIN, cookie },
      payload: {
        idempotencyKey: key(),
        label: `Gift ${spec.marker}`,
        amountMinor: '10000',
        currency: 'IRT',
        count: 2,
        expiresAt: new Date(Date.now() + 30 * 24 * 3_600_000).toISOString(),
        perCustomerLimit: null,
        reason: `Reason ${spec.marker}`,
        expectedTotalMinor: '20000',
        typedCount: 2,
      },
    });
    expect(gift.statusCode, gift.body).toBeLessThan(300);
    const giftCardBatchId = (gift.json() as { batch: { id: string } }).batch.id;
    const app = await inject({
      method: 'POST',
      url: `${API_PREFIX}${CLIENT_APP_ROUTES.create}`,
      headers: { origin: ORIGIN, cookie },
      payload: {
        idempotencyKey: key(),
        platform: 'ANDROID',
        name: `App ${spec.marker}`,
        icon: null,
        description: `About ${spec.marker}`,
        officialUrl: `https://${spec.marker}.downloads.test/app.apk`,
        alternativeUrl: null,
        helpUrl: null,
        guide: `Guide ${spec.marker}`,
        deliveryKinds: [],
        protocols: [],
        providerTypes: [],
        sortOrder: 10,
      },
    });
    expect(app.statusCode, app.body).toBe(201);
    const clientAppId = (app.json() as { id: string }).id;
    const image = await inject({
      method: 'POST',
      url: `${API_PREFIX}${CLIENT_APP_ROUTES.image(clientAppId)}`,
      headers: { origin: ORIGIN, cookie },
      payload: {
        idempotencyKey: key(),
        expectedVersion: 1,
        mimeType: 'image/png',
        contentBase64: sizedPng(256, 256, 300).toString('base64'),
      },
    });
    expect(image.statusCode, image.body).toBe(201);

    tenants[label] = {
      label,
      tenantId,
      scope,
      marker: spec.marker,
      botId: spec.botId,
      telegramBotId: spec.telegramBotId,
      botToken: token,
      categoryId,
      panelId,
      productId,
      customerId,
      orderId,
      orderAmountMinor: spec.orderAmount,
      serviceId,
      paymentId,
      paymentCode,
      receiptId,
      ticketCategoryId,
      ticketId,
      ticketMessageId,
      walletAmountMinor: spec.walletAmount,
      broadcastId,
      giftCardBatchId,
      clientAppId,
      owner: ownerAdmin,
      ownerActor,
      staffId: staff.id,
      cookie,
      mediaPurpose: 'REFERRAL_BANNER',
    };
  }
  telegram.calls.length = 0;

  return {
    api,
    telegram,
    tenants,
    inject,
    key,
    async close() {
      try {
        await api.close();
      } finally {
        await telegram.close();
      }
    },
  };
}

/** The mutation hook (see the file comment). A no-op unless the script sets it. */
async function applyMutation(api: ApiApp): Promise<void> {
  const table = process.env.NEXA_ISOLATION_MUTATION_DROP_POLICY;
  if (table === undefined || table === '') return;
  if (!/^[a-z_]+$/.test(table)) throw new Error(`not a table name: ${table}`);
  await api.container.database.db.execute(
    sql.raw(`DROP POLICY IF EXISTS ${TENANT_POLICY} ON "${table}"`),
  );
  if (process.env.NEXA_ISOLATION_MUTATION_DISABLE_RLS === '1') {
    await api.container.database.db.execute(
      sql.raw(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`),
    );
  }
}

/**
 * Every row a case may have touched, read as the OWNER (who sees every tenant): the
 * victim's records as JSON, so "no row changed" is one equality.
 */
export async function victimRows(world: World, victim: TenantWorld): Promise<string> {
  const db = world.api.container.database.db;
  const one = async (table: string, id: string) =>
    (await db.execute(sql`SELECT to_jsonb(t) AS row FROM ${sql.raw(table)} t WHERE id = ${id}`))
      .rows[0] ?? null;
  const rows = {
    customer: await one('customers', victim.customerId),
    order: await one('orders', victim.orderId),
    product: await one('products', victim.productId),
    category: await one('product_categories', victim.categoryId),
    panel: await one('panels', victim.panelId),
    service: await one('services', victim.serviceId),
    payment: await one('payments', victim.paymentId),
    ticket: await one('tickets', victim.ticketId),
    broadcast: await one('broadcasts', victim.broadcastId),
    giftCardBatch: await one('gift_card_batches', victim.giftCardBatchId),
    clientApp: (
      await db.execute(
        sql`SELECT to_jsonb(t) - 'image_content' AS row FROM client_apps t
             WHERE id = ${victim.clientAppId}`,
      )
    ).rows[0] ?? null,
    giftCards: (
      await db.execute(
        sql`SELECT id, state FROM gift_card_codes WHERE tenant_id = ${victim.tenantId} ORDER BY id`,
      )
    ).rows,
    owner: await one('admins', victim.owner.id),
    staff: await one('admins', victim.staffId),
    wallet: (
      await db.execute(
        sql`SELECT id, amount, direction FROM wallet_entries WHERE tenant_id = ${victim.tenantId}
             ORDER BY id`,
      )
    ).rows,
    gateways: (
      await db.execute(
        sql`SELECT to_jsonb(t) AS row FROM payment_gateways t
             WHERE tenant_id = ${victim.tenantId} ORDER BY provider`,
      )
    ).rows,
    settings: (
      await db.execute(
        sql`SELECT setting_key, value, version FROM setting_values
             WHERE tenant_id = ${victim.tenantId} ORDER BY setting_key`,
      )
    ).rows,
    media: (
      await db.execute(
        sql`SELECT to_jsonb(t) - 'content' AS row FROM tenant_media_assets t
             WHERE tenant_id = ${victim.tenantId} ORDER BY purpose`,
      )
    ).rows,
    ticketMessages: (
      await db.execute(
        sql`SELECT id FROM ticket_messages WHERE tenant_id = ${victim.tenantId} ORDER BY id`,
      )
    ).rows,
    sessions: (
      await db.execute(
        sql`SELECT id, revoked_at FROM admin_sessions WHERE tenant_id = ${victim.tenantId}
             ORDER BY id`,
      )
    ).rows,
  };
  return JSON.stringify(rows, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

/** Every identifying string of a tenant's: none may appear in another tenant's answer. */
export function fingerprints(t: TenantWorld): string[] {
  return [
    t.marker,
    t.categoryId,
    t.ticketCategoryId,
    t.customerId,
    t.orderId,
    t.productId,
    t.panelId,
    t.serviceId,
    t.paymentId,
    t.paymentCode,
    t.receiptId,
    t.ticketId,
    t.ticketMessageId,
    t.broadcastId,
    t.giftCardBatchId,
    t.clientAppId,
    t.owner.id,
    t.staffId,
    t.botId,
    t.tenantId,
  ];
}

/** The fingerprints of `victim` found in `text`. Empty is the only passing answer. */
export function leaks(text: string, victim: TenantWorld): string[] {
  return fingerprints(victim).filter((needle) => text.includes(needle));
}

export const webhookHeaders = { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET };
