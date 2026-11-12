import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RESELLER_API_PREFIX,
  RESELLER_SESSION_COOKIE_NAME,
  money,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
  type TenantContext,
  type TenantId,
} from '@nexa/contracts';
import type { ApiApp } from '../../apps/api/src/bootstrap';
import { createDatabase } from '../../apps/api/src/infrastructure/persistence/database';
import { withDatabaseScope } from '../../apps/api/src/infrastructure/persistence/database-scope';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  botInstances,
  hostedBotActivations,
} from '../../apps/api/src/infrastructure/persistence/schema';
import {
  totpForStep,
  totpStepAt,
} from '../../apps/api/src/modules/platform/identity/application/totp';
import {
  adminActorFor,
  createAdmin,
  createApiApp,
  migrateOnce,
  resetDatabase,
  tenantA,
  testAppDatabaseUrl,
  testConfig,
} from './harness';

const ORIGIN = 'https://admin.reseller-hosted.test';
const DOMAIN = 'shop.reseller-hosted.test';
const OWNER_PASSWORD = 'the-owners-own-password';

const systemActor = (id: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: id as CorrelationId,
});

/**
 * PR-4 §5 «Hosted bots»: the reseller panel per tenant, on a hosted tenant's own verified
 * domain, isolated by row-level security. The link is issued for the hosted domain, opens a
 * session only there, and that session (and its rows) do not exist for the installation — by
 * the Host-resolved tenant and by RLS on the application role's pool.
 */
describe('the reseller web panel on a hosted tenant (PR-4)', () => {
  let api: ApiApp;
  let baseMs = 0;
  let offsetMs = 0;
  let hosted: TenantContext;
  let botId: BotInstanceId;
  let reseller: string;

  const db = () => api.container.database.db;
  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject({
        remoteAddress: `10.77.${String(Math.floor(Math.random() * 200))}.5`,
        ...options,
      } as never);
  const code = (secret: string) => {
    offsetMs += 30_000;
    return totpForStep(secret, totpStepAt(api.container.clock.now()));
  };

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN, HOSTED_BOTS_CREATE_ENABLED: 'true' });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
    const clock = api.container.clock as { now: () => Date };
    baseMs = Math.floor(Date.now() / 30_000) * 30_000 + 10_000;
    clock.now = () => new Date(baseMs + offsetMs);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    offsetMs = 0;
    await resetDatabase(db());
    await seed(db(), api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    const owner = await createAdmin(api.container, tenantA, {
      username: 'rwh-owner',
      password: OWNER_PASSWORD,
      roleKeys: ['owner'],
    });
    const login = await api.container.auth.login(
      tenantA,
      { type: 'API', id: null, label: null, surface: 'WEB', correlationId: 'c' as CorrelationId },
      { username: owner.username, password: owner.password },
      { ip: null, userAgent: null },
    );
    const ownerActor: ActorContext = { ...adminActorFor(owner), sessionId: login.session.id };
    const enrolment = await api.container.hostingSection.enrol(
      tenantA,
      ownerActor,
      { password: OWNER_PASSWORD },
      { ip: null },
    );
    const activated = await api.container.hostingSection.activate(tenantA, ownerActor, {
      code: code(enrolment.secret),
    });
    const created = await api.container.hosting.create(
      tenantA,
      ownerActor,
      activated.opened.token,
      {
        idempotencyKey: randomUUID(),
        proof: { code: code(enrolment.secret) },
        slug: 'resel',
        displayName: 'Bot resel',
        adminUsername: 'resel-admin',
        adminDisplayName: 'Hosted owner',
        adminPassword: 'the-hosted-owners-password',
        expiresAt: null,
      },
    );
    hosted = { tenantId: created.bot.tenantId as TenantId, botInstanceId: null };
    const now = api.container.clock.now();
    await db().insert(hostedBotActivations).values({
      tenantId: tenantA.tenantId,
      hostedTenantId: hosted.tenantId,
      domain: DOMAIN,
      dnsVerifiedAt: now,
      tlsVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    botId = randomUUID() as BotInstanceId;
    const sealed = api.container.cipher.encrypt('000000:hosted-token', {
      purpose: 'bot_instance.token',
      tenantId: hosted.tenantId,
      entityId: botId,
    });
    await db()
      .insert(botInstances)
      .values({
        id: botId,
        tenantId: hosted.tenantId,
        username: 'hosted_shop_bot',
        status: 'ACTIVE',
        tokenCiphertext: sealed.ciphertext,
        tokenKeyId: sealed.keyId,
      } as never);
    const hostedAdmin = adminActorFor(
      await createAdmin(api.container, hosted, { username: 'hosted-op', roleKeys: ['owner'] }),
    );
    const resolved = await api.container.customers.resolveFromUpdate(hosted, systemActor('h'), {
      intake: 'INTERNAL',
      idempotencyKey: 'resolve-hosted',
      telegramUserId: '943001',
      from: { id: 943001, first_name: 'هومن' },
      botInstanceId: botId,
    });
    reseller = resolved.customer.id;
    const tier = await api.container.resellersAdmin.createTier(hosted, hostedAdmin, {
      idempotencyKey: randomUUID(),
      write: {
        name: 'Hosted tier',
        pricingMode: 'LIST_PRICE',
        discountPercentage: null,
        creditLimit: money(0n, 'IRT'),
      },
    });
    await api.container.resellersAdmin.register(hosted, hostedAdmin, {
      idempotencyKey: randomUUID(),
      customerId: reseller,
      write: { tierId: tier.id, pricingMode: 'TIER', discountPercentage: null, creditLimit: null },
    });
    const flag = await api.container.featureFlagResolver.resolve(hosted, 'reseller_web_panel');
    await api.container.featureFlags.set(hosted, hostedAdmin, {
      key: 'reseller_web_panel',
      enabled: true,
      expectedVersion: flag.version,
      idempotencyKey: randomUUID(),
      reason: 'hosted reseller panel test',
    });
  });

  it('issues the link for the hosted domain, opens a session only there, and RLS hides it from the installation', async () => {
    const issued = await api.container.resellerWeb.access.issueLink(hosted, systemActor('l'), {
      customerId: reseller,
      botInstanceId: botId,
    });
    expect(issued.kind).toBe('ISSUED');
    const url = issued.kind === 'ISSUED' ? issued.url : '';
    expect(url).toMatch(
      new RegExp(`^https://${DOMAIN.replace(/\./gu, '\\.')}/r/login#token=`, 'u'),
    );
    const token = /#token=(.+)$/u.exec(url)?.[1] as string;

    // On the installation's own host the hosted link does not exist.
    const elsewhere = await inject({
      method: 'POST',
      url: `${RESELLER_API_PREFIX}/auth/exchange`,
      headers: { origin: ORIGIN },
      payload: { token },
    });
    expect(elsewhere.statusCode).toBe(404);

    const opened = await inject({
      method: 'POST',
      url: `${RESELLER_API_PREFIX}/auth/exchange`,
      headers: { host: DOMAIN, origin: `https://${DOMAIN}` },
      payload: { token },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    const cookie = new RegExp(`${RESELLER_SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(opened.headers['set-cookie']),
    )?.[1] as string;
    const me = await inject({
      method: 'GET',
      url: `${RESELLER_API_PREFIX}/me`,
      headers: { host: DOMAIN, cookie: `${RESELLER_SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(me.statusCode, me.body).toBe(200);
    expect((me.json() as { botUsername: string }).botUsername).toBe('hosted_shop_bot');

    // The installation's flag is off: the same cookie on its host is a route that does not exist;
    // switched on there, the hosted session is still nobody's on that host.
    const onInstallation = await inject({
      method: 'GET',
      url: `${RESELLER_API_PREFIX}/me`,
      headers: { cookie: `${RESELLER_SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(onInstallation.statusCode).toBe(404);
    await db().execute(sql`
      INSERT INTO feature_flag_states (id, tenant_id, flag_key, enabled, version, updated_at)
      VALUES (${randomUUID()}, ${tenantA.tenantId}, 'reseller_web_panel', true, 1, now())`);
    const stillNobody = await inject({
      method: 'GET',
      url: `${RESELLER_API_PREFIX}/me`,
      headers: { cookie: `${RESELLER_SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(stillNobody.statusCode).toBe(401);

    // Row-level security alone, through the application role with no tenant predicate.
    const app = createDatabase(testAppDatabaseUrl(), 1);
    try {
      expect(await app.scopeEnforcement()).toBe('enforcing');
      const count = (scope: TenantContext, table: string) =>
        withDatabaseScope(scope, () =>
          app.db.execute<{ n: number }>(sql.raw(`SELECT count(*)::int AS n FROM ${table}`)),
        );
      for (const table of [
        'reseller_web_sessions',
        'reseller_web_login_tokens',
        'reseller_web_devices',
      ]) {
        expect((await count(tenantA, table)).rows[0]?.n, table).toBe(0);
        expect((await count(hosted, table)).rows[0]?.n, table).toBe(1);
      }
    } finally {
      await app.close();
    }
  });
});
