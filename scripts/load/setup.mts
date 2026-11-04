/**
 * Fixture for the load harness (scripts/load/run.mjs): N tenants, each with its own bot
 * instance (own token, own derived webhook secret), a sellable panel, one product, a
 * payment destination and the payment routes; one owner administrator on the installation
 * tenant; and K extra customers on the installation tenant for the broadcast audience.
 *
 * Run by run.mjs through apps/api/node_modules/.bin/tsx. LOAD-TEST DATABASES ONLY: it
 * refuses a database whose name has no `load` or `test` marker, and it never talks to
 * Telegram. It reuses the repository's own seed (tenants A/B, their bots and payment rows)
 * and the integration harness's fixtures (a sellable panel, a seeded administrator), then
 * adds the extra tenants the same way the seed adds its own.
 *
 *   tsx scripts/load/setup.mts --tenants 50 --audience 50000 --out fixture.json
 *   env: DATABASE_URL, SECRETS_KEK + SECRETS_KEK_ID (the keyring the API process will use),
 *        TELEGRAM_WEBHOOK_SECRET (the installation secret the per-bot secrets derive from)
 */
import { writeFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { money, type ProductCategoryId, type ProductId } from '@nexa/contracts';
import { EMPTY_PRODUCT_DISPLAY } from '@nexa/contracts';
import { loadConfig } from '../../apps/api/src/infrastructure/config/load-config';
import { createContainer } from '../../apps/api/src/container';
import { runMigrations } from '../../apps/api/src/infrastructure/persistence/migrate';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { perBotWebhookSecret } from '../../apps/api/src/modules/platform/tenancy/application/webhook-secret';
import {
  botInstances,
  paymentAccounts,
  productCategories,
  tenants,
} from '../../apps/api/src/infrastructure/persistence/schema';
// The harness is a CommonJS module to Node (no "type" at the root), so its named exports
// arrive under `default` when it is imported from this ES module.
const harnessModule = await import('../../tests/integration/harness');
const { createAdmin, makePanelSellable, resetDatabase } = (
  'createAdmin' in harnessModule
    ? harnessModule
    : (harnessModule as { default: typeof harnessModule }).default
) as typeof harnessModule;

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && process.argv[at + 1] !== undefined
    ? (process.argv[at + 1] as string)
    : fallback;
}

const config = loadConfig(process.env);
const databaseName = new URL(config.DATABASE_URL).pathname.replace(/^\//, '');
if (!/(^|[_-])(load|test)/i.test(databaseName)) {
  throw new Error(
    `refusing database "${databaseName}": a load-test database name starts a word with "load" or "test"`,
  );
}
const tenantCount = Number(arg('tenants', '50'));
const audience = Number(arg('audience', '50000'));
const out = arg('out', 'fixture.json');
if (!Number.isInteger(tenantCount) || tenantCount < 1) throw new Error('--tenants must be >= 1');
if (!Number.isInteger(audience) || audience < 0) throw new Error('--audience must be >= 0');

const ADMIN_USERNAME = 'load-owner';
const ADMIN_PASSWORD = 'load-test-owner-password';

await runMigrations(config.DATABASE_URL);
const container = createContainer(config, 'worker');
const db = container.database.db;

// Idempotent: a re-run on the same database drops the previous load rows first, so the
// fixture is the same every time. The tables are the load database's own.
await resetDatabase(db);
await seed(db, container.cipher);

const primary = SEED_IDS.tenantA;
const secretMaster = config.TELEGRAM_WEBHOOK_SECRET;
if (secretMaster === '') throw new Error('TELEGRAM_WEBHOOK_SECRET must be set');

interface FixtureTenant {
  index: number;
  tenantId: string;
  botInstanceId: string;
  botToken: string;
  webhookSecret: string;
  productId: string;
}
const fixtureTenants: FixtureTenant[] = [];

const encryptedToken = (token: string, tenantId: string, botId: string) => {
  const sealed = container.cipher.encrypt(token, {
    purpose: 'bot_instance.token',
    tenantId,
    entityId: botId,
  });
  return { tokenCiphertext: sealed.ciphertext, tokenKeyId: sealed.keyId };
};

async function product(tenantId: string, categoryId: string, panelId: string): Promise<string> {
  const repository = new DrizzleProductRepository(db);
  const scope = { tenantId: tenantId as never, botInstanceId: null };
  const now = container.clock.now();
  const created = await repository.create(scope, {
    id: container.ids.uuid() as ProductId,
    draft: {
      title: 'Load plan',
      description: null,
      audience: 'EVERYONE',
      sortOrder: 10,
      panelId: panelId as never,
      categoryId: categoryId as ProductCategoryId,
      specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: 2 },
      price: money(250_000n, 'IRT'),
      display: EMPTY_PRODUCT_DISPLAY,
    },
    now,
  });
  await repository.setStatus(scope, created.id, 'INACTIVE', 'ACTIVE', now);
  return created.id;
}

async function panel(tenantId: string, label: string): Promise<string> {
  const id = container.ids.uuid();
  await db.execute(sql`
    INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
    VALUES (${id}, ${tenantId}, ${label}, 'sanaei', 'https://panel.example.test', 'ACTIVE')`);
  await makePanelSellable(container, { tenantId: tenantId as never, botInstanceId: null }, id);
  return id;
}

for (let index = 0; index < tenantCount; index += 1) {
  let tenantId: string;
  let botId: string;
  let categoryId: string;
  const token = `${String(700000 + index)}:load-token-${String(index).padStart(4, '0')}`;
  if (index === 0) {
    // The installation tenant: the seed's primary and its ACTIVE bot.
    tenantId = primary;
    botId = SEED_IDS.botA1;
    categoryId = SEED_IDS.categoryA;
    await db.execute(
      sql`UPDATE bot_instances SET token_ciphertext = ${encryptedToken(token, tenantId, botId).tokenCiphertext},
            token_key_id = ${encryptedToken(token, tenantId, botId).tokenKeyId} WHERE id = ${botId}`,
    );
  } else {
    tenantId = container.ids.uuid();
    botId = container.ids.uuid();
    categoryId = container.ids.uuid();
    const slug = `load-${String(index).padStart(3, '0')}`;
    await db.insert(tenants).values({
      id: tenantId,
      kind: 'RESELLER_BOT',
      parentTenantId: primary,
      slug,
      displayName: `Load tenant ${String(index)}`,
      status: 'ACTIVE',
      locale: 'fa',
      displayTimezone: 'Asia/Tehran',
      calendar: 'jalali',
      currency: 'IRT',
    });
    await db.insert(botInstances).values({
      id: botId,
      tenantId,
      username: `${slug.replace('-', '_')}_bot`,
      status: 'ACTIVE',
      ...encryptedToken(token, tenantId, botId),
    });
    await db
      .insert(productCategories)
      .values({ id: categoryId, tenantId, name: 'عمومی', sortOrder: 0 });
    await db.insert(paymentAccounts).values({
      id: container.ids.uuid(),
      tenantId,
      label: 'Load card',
      bankName: 'بانک ملی ایران',
      holderName: 'Load Store',
      cardNumber: '6037991234567893',
      iban: null,
      enabled: true,
      isDefault: true,
      sortOrder: 0,
    });
    // The routes exactly as the seed gives tenant A: copied from its rows.
    await db.execute(sql`
      INSERT INTO payment_gateways (tenant_id, provider, status, bounds_currency)
      SELECT ${tenantId}, provider, status, bounds_currency FROM payment_gateways WHERE tenant_id = ${primary}`);
  }
  const panelId = await panel(tenantId, `Load panel ${String(index)}`);
  fixtureTenants.push({
    index,
    tenantId,
    botInstanceId: botId,
    botToken: token,
    webhookSecret: perBotWebhookSecret(secretMaster, botId),
    productId: await product(tenantId, categoryId, panelId),
  });
}

// One owner on the installation tenant: the broadcast is launched through the admin API.
await createAdmin(
  container,
  { tenantId: primary as never, botInstanceId: null },
  {
    username: ADMIN_USERNAME,
    password: ADMIN_PASSWORD,
    roleKeys: ['owner'],
  },
);

// The broadcast audience: `audience` ACTIVE customers on the installation tenant's bot.
// Telegram ids 10_000_000+ never collide with the virtual customers (900_000_000+).
if (audience > 0) {
  await db.execute(sql`
    INSERT INTO customers (id, tenant_id, telegram_user_id, status, first_bot_instance_id,
                           first_seen_at, first_name, created_at)
    SELECT ('01900000-0000-7000-8000-' || lpad(to_hex(g), 12, '0'))::uuid, ${primary}, (10000000 + g)::text, 'ACTIVE', ${SEED_IDS.botA1},
           now() - interval '30 days', 'aud' || g::text, now() - interval '30 days'
    FROM generate_series(1, ${audience}) AS g`);
}
await db.execute(sql`ANALYZE`);

writeFileSync(
  out,
  JSON.stringify(
    {
      database: databaseName,
      createdAt: new Date().toISOString(),
      installationTenantId: primary,
      admin: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD },
      audience,
      tenants: fixtureTenants,
    },
    null,
    2,
  ),
);
process.stderr.write(
  `fixture: ${String(tenantCount)} tenants, ${String(audience)} audience customers -> ${out}\n`,
);
await container.shutdown();
process.exit(0);
