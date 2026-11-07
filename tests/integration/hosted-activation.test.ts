import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  HOSTED_ACTIVATION_LINK_TTL_SECONDS,
  HOSTED_ACTIVATION_ROUTES,
  HOSTED_DOMAIN_CHECK_PATH,
  HOSTING_ACTIVATION_ERROR_CODES as CODES,
  isNexaError,
  systemContext,
  type ActorContext,
  type CorrelationId,
  type HostedActivationView,
  type TenantContext,
} from '@nexa/contracts';
import type { ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminPermissionOverrides,
  adminRoles,
  adminSessions,
  admins,
  auditLogs,
  botInstances,
  hostedBotActivationLinks,
  hostedBotActivations,
  hostedBots,
  outboxMessages,
  rolePermissions,
  roles,
  tenants,
} from '../../apps/api/src/infrastructure/persistence/schema';
import {
  totpForStep,
  totpStepAt,
} from '../../apps/api/src/modules/platform/identity/application/totp';
import type {
  HostedDnsResolver,
  HostedTlsProbe,
  HostedTlsProbeResult,
} from '../../apps/api/src/modules/platform/hosting/application/activation-ports';
import type { DnsObservation } from '../../apps/api/src/modules/platform/hosting/domain/hosted-domain';
import { DrizzleHostedOwnerActivation } from '../../apps/api/src/modules/platform/hosting/infrastructure/drizzle-hosted-owner-activation';
import { perBotWebhookSecret } from '../../apps/api/src/modules/platform/tenancy/application/webhook-secret';
import { startFakeTelegramBotApi, type FakeTelegramBotApi } from '../support/fake-telegram-bot-api';
import {
  createAdmin,
  createApiApp,
  migrateOnce,
  resetDatabase,
  SEED_IDS,
  tenantA,
  testConfig,
} from './harness';

const ORIGIN = 'https://admin.hosting.test';
const SERVER_IP = '203.0.113.10';
const EDGE_IP = '203.0.113.7';
const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-hosting';
const OWNER_PASSWORD = 'the-owners-own-password';
const PLACEHOLDER_PASSWORD = 'the-creators-placeholder-password';
const DOMAIN = 'bots.alpha-store.com';
const TELEGRAM_ID = 7_100_000_001;

/**
 * Phase 6A PR-4 (D2) — the activation of a hosted bot, against the real app and a real
 * database: Telegram is the HTTP fake, DNS and the HTTPS probe are injected fakes. Every step,
 * its idempotency and its Persian-facing error codes; the one-time link (single use, 24 hours
 * by the Clock, hash only); the edge's certificate question; and Host → tenant resolution.
 */
describe('hosted bot activation (phase 6A PR-4)', () => {
  let api: ApiApp;
  let telegram: FakeTelegramBotApi;
  let offsetMs = 0;
  let keys = 0;
  let ownerActor: ActorContext;
  let panel: { secret: string; token: string };
  let botToken: string;

  // The fake network, mutated by the cases.
  const dnsNow = new Map<string, DnsObservation>();
  let dnsFails = false;
  const tlsReady = new Set<string>();
  const dns: HostedDnsResolver = {
    observe: (domain) => {
      if (dnsFails) return Promise.reject(new Error('timeout'));
      return Promise.resolve(dnsNow.get(domain) ?? { cname: [], addresses: [] });
    },
    addressesOf: () => Promise.resolve([SERVER_IP]),
  };
  const tls: HostedTlsProbe = {
    probe: (domain): Promise<HostedTlsProbeResult> =>
      Promise.resolve(tlsReady.has(domain) ? { ok: true } : { ok: false, reason: 'CERTIFICATE' }),
  };

  const db = () => api.container.database.db;
  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const key = () => `activation-key-${String((keys += 1))}`;
  const now = () => api.container.clock.now();
  const code = (secret: string) => {
    offsetMs += 30_000;
    return totpForStep(secret, totpStepAt(now()));
  };
  const codeOf = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (error) {
      if (isNexaError(error)) return error.code;
      throw error;
    }
    throw new Error('expected a refusal');
  };
  const anon = { type: 'API', id: null, label: null, surface: 'WEB', correlationId: 'c' } as never;

  async function signIn(admin: { id: string; username: string; password: string }) {
    const result = await api.container.auth.login(
      tenantA,
      { type: 'API', id: null, label: null, surface: 'WEB', correlationId: 'c' as CorrelationId },
      { username: admin.username, password: admin.password },
      { ip: null, userAgent: null },
    );
    return {
      type: 'WEB_ADMIN',
      id: admin.id,
      label: admin.username,
      surface: 'WEB',
      correlationId: 'test-correlation' as CorrelationId,
      sessionId: result.session.id,
    } as ActorContext;
  }

  async function createHosted(slug = 'alpha') {
    const created = await api.container.hosting.create(tenantA, ownerActor, panel.token, {
      idempotencyKey: key(),
      proof: { code: code(panel.secret) },
      slug,
      displayName: `Bot ${slug}`,
      adminUsername: `${slug}-placeholder`,
      adminDisplayName: 'Hosted owner',
      adminPassword: PLACEHOLDER_PASSWORD,
      expiresAt: null,
    });
    return created.bot.tenantId;
  }

  const configure = (id: string, overrides: Record<string, unknown> = {}, idempotencyKey = key()) =>
    api.container.hostedActivation.configure(tenantA, ownerActor, panel.token, id, {
      idempotencyKey,
      proof: { code: code(panel.secret) },
      botToken,
      domain: DOMAIN,
      ...overrides,
    });
  const run = (id: string, step: string, idempotencyKey = key()) =>
    api.container.hostedActivation.runStep(tenantA, ownerActor, panel.token, id, step, {
      idempotencyKey,
    });
  const issueLink = (id: string, idempotencyKey = key()) =>
    api.container.hostedActivation.issueLink(tenantA, ownerActor, panel.token, id, {
      idempotencyKey,
      proof: { code: code(panel.secret) },
    });
  const status = (id: string) =>
    api.container.hostedActivation.status(tenantA, ownerActor, panel.token, id);
  const stepOf = (view: HostedActivationView, step: string) =>
    view.steps.find((entry) => entry.step === step) as HostedActivationView['steps'][number];

  /** DNS points at us, the certificate is there; steps through to the webhook. */
  async function upToWebhook(id: string) {
    await configure(id);
    dnsNow.set(DOMAIN, { cname: ['admin.hosting.test'], addresses: [SERVER_IP] });
    await run(id, 'domain');
    tlsReady.add(DOMAIN);
    await run(id, 'ssl');
    await run(id, 'webhook');
  }

  const redeem = (host: string | undefined, token: string, extra: Record<string, unknown> = {}) =>
    api.container.hostedOwnerActivation.redeem(host, anon, {
      token,
      username: 'alpha-owner',
      password: 'a-brand-new-long-password',
      ...extra,
    });
  const tokenOf = (url: string | null) => {
    const match = /#token=(.+)$/.exec(url ?? '');
    if (match === null) throw new Error('no activation url');
    return match[1] as string;
  };

  beforeAll(async () => {
    telegram = await startFakeTelegramBotApi();
    const config = testConfig({
      WEB_ADMIN_ORIGINS: ORIGIN,
      HOSTED_BOTS_CREATE_ENABLED: 'true',
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_API_BASE_URL: telegram.url,
      NOTIFICATION_SEND_TIMEOUT_MS: '2000',
      DEPLOYMENT_TOPOLOGY: 'reverse-proxy',
      TRUSTED_PROXY_IPS: EDGE_IP,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config, { hostedNetwork: { dns, tls } });
    const clock = api.container.clock as { now: () => Date };
    const real = clock.now.bind(clock);
    clock.now = () => new Date(real().getTime() + offsetMs);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await telegram?.close();
  });

  beforeEach(async () => {
    offsetMs = 0;
    dnsNow.clear();
    dnsFails = false;
    tlsReady.clear();
    await resetDatabase(db());
    await seed(db(), api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    const owner = await createAdmin(api.container, tenantA, {
      username: 'panel-owner',
      password: OWNER_PASSWORD,
      roleKeys: ['owner'],
    });
    ownerActor = await signIn(owner);
    const enrolment = await api.container.hostingSection.enrol(
      tenantA,
      ownerActor,
      { password: OWNER_PASSWORD },
      { ip: null },
    );
    const activated = await api.container.hostingSection.activate(tenantA, ownerActor, {
      code: code(enrolment.secret),
    });
    panel = { secret: enrolment.secret, token: activated.opened.token };
    botToken = telegram.createBot({ id: TELEGRAM_ID, username: 'alpha_store_bot' });
    telegram.calls.length = 0;
  });

  describe('step 1 — the token and the domain', () => {
    it('starts with every step pending', async () => {
      const id = await createHosted();
      const view = await status(id);
      expect(view.steps.map((step) => [step.step, step.state])).toEqual([
        ['TOKEN', 'PENDING'],
        ['DOMAIN', 'PENDING'],
        ['SSL', 'PENDING'],
        ['WEBHOOK', 'PENDING'],
        ['LINK', 'PENDING'],
      ]);
      expect(view.dnsTarget.hostname).toBe('admin.hosting.test');
    });

    it('verifies with getMe, stores the token encrypted on the hosted tenant’s bot, audits and replays', async () => {
      const id = await createHosted();
      const idempotencyKey = key();
      const first = await configure(id, {}, idempotencyKey);
      expect(first.replayed).toBe(false);
      expect(stepOf(first.activation, 'TOKEN').state).toBe('DONE');
      expect(first.activation.botUsername).toBe('alpha_store_bot');
      expect(first.activation.domain).toBe(DOMAIN);

      const [bot] = await db().select().from(botInstances).where(eq(botInstances.tenantId, id));
      expect(bot?.telegramBotId).toBe(String(TELEGRAM_ID));
      expect(bot?.tokenCiphertext).not.toContain(botToken);
      expect(
        api.container.cipher.decrypt(
          { ciphertext: bot?.tokenCiphertext as string, keyId: bot?.tokenKeyId as string },
          { purpose: 'bot_instance.token', tenantId: id, entityId: bot?.id as string },
        ),
      ).toBe(botToken);

      const audited = await db()
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'hosting.activation_configure'));
      expect(audited).toHaveLength(1);
      expect(JSON.stringify(audited)).not.toContain(botToken);
      const events = await db()
        .select()
        .from(outboxMessages)
        .where(eq(outboxMessages.eventType, 'HostedBotSetupStepChanged'));
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain(botToken);

      // The same key and request again: the first result, nothing re-done.
      const callsBefore = telegram.calls.length;
      const replay = await configure(id, {}, idempotencyKey);
      expect(replay.replayed).toBe(true);
      expect(telegram.calls.length).toBe(callsBefore);
      // The same TOKEN under a new key is idempotent too: still one bot instance.
      await configure(id);
      expect(
        await db().select().from(botInstances).where(eq(botInstances.tenantId, id)),
      ).toHaveLength(1);
    });

    it('refuses a token Telegram rejects, a malformed one, and one Telegram cannot be asked about', async () => {
      const id = await createHosted();
      expect(await codeOf(configure(id, { botToken: 'not-a-token' }))).toBe(CODES.TOKEN_MALFORMED);
      expect(await codeOf(configure(id, { botToken: `${TELEGRAM_ID}:${'x'.repeat(35)}` }))).toBe(
        CODES.TOKEN_REJECTED,
      );
      telegram.failNext('getMe', { kind: 'server_error' });
      expect(await codeOf(configure(id))).toBe(CODES.TOKEN_UNREACHABLE);
      expect(
        await db().select().from(botInstances).where(eq(botInstances.tenantId, id)),
      ).toHaveLength(0);
    });

    it('refuses a token already used by another bot instance — the installation’s own and another hosted bot’s', async () => {
      const first = await createHosted('alpha');
      const second = await createHosted('beta');
      await configure(first);
      // Another hosted bot cannot take the same Telegram bot…
      expect(await codeOf(configure(second, { domain: 'bots.beta-store.com' }))).toBe(
        CODES.TOKEN_IN_USE,
      );
      // …nor the installation's own bot (the seeded tenant A bot), whatever token names it.
      const own = telegram.createBot({ id: 7_100_000_002, username: 'owner_main_bot' });
      await db().execute(
        sql`UPDATE bot_instances SET telegram_bot_id = '7100000002', username = 'owner_main_bot' WHERE id = ${SEED_IDS.botA1}`,
      );
      expect(
        await codeOf(configure(second, { botToken: own, domain: 'bots.beta-store.com' })),
      ).toBe(CODES.TOKEN_IN_USE);
      expect(
        await db().select().from(botInstances).where(eq(botInstances.tenantId, second)),
      ).toHaveLength(0);
    });

    it('never repoints: a different bot for the same hosted bot is refused', async () => {
      const id = await createHosted();
      await configure(id);
      const other = telegram.createBot({ id: 7_100_000_009, username: 'other_bot' });
      expect(await codeOf(configure(id, { botToken: other }))).toBe(CODES.TOKEN_OTHER_BOT);
    });

    it('refuses a bad, reserved or taken domain; one at a time per hosted bot', async () => {
      const first = await createHosted('alpha');
      const second = await createHosted('beta');
      for (const bad of [
        'https://bots.alpha-store.com',
        'bots.alpha-store.com/x',
        '1.2.3.4',
        'nodots',
        'a b.com',
        'bad_name.com',
      ]) {
        expect(await codeOf(configure(first, { domain: bad }))).toBe(CODES.DOMAIN_INVALID);
      }
      expect(await codeOf(configure(first, { domain: 'admin.hosting.test' }))).toBe(
        CODES.DOMAIN_RESERVED,
      );
      expect(await codeOf(configure(first, { domain: 'ADMIN.hosting.test.' }))).toBe(
        CODES.DOMAIN_RESERVED,
      );
      await configure(first);
      const other = telegram.createBot({ id: 7_100_000_003, username: 'beta_bot' });
      expect(
        await codeOf(configure(second, { botToken: other, domain: DOMAIN.toUpperCase() })),
      ).toBe(CODES.DOMAIN_TAKEN);
    });

    it('asks for a fresh code: a wrong one changes nothing', async () => {
      const id = await createHosted();
      const wrong = codeOf(
        api.container.hostedActivation.configure(tenantA, ownerActor, panel.token, id, {
          idempotencyKey: key(),
          proof: { code: '000000' },
          botToken,
          domain: DOMAIN,
        }),
      );
      expect(await wrong).not.toBe('');
      expect(
        await db().select().from(botInstances).where(eq(botInstances.tenantId, id)),
      ).toHaveLength(0);
      expect(await db().select().from(hostedBotActivations)).toHaveLength(0);
    });

    it('changing the domain clears the marks the old one earned', async () => {
      const id = await createHosted();
      await upToWebhook(id);
      expect(stepOf(await status(id), 'WEBHOOK').state).toBe('DONE');
      const moved = await configure(id, { domain: 'bots.alpha-two.com' });
      expect(moved.activation.domain).toBe('bots.alpha-two.com');
      expect(moved.activation.steps.map((step) => step.state)).toEqual([
        'DONE',
        'PENDING',
        'PENDING',
        'PENDING',
        'PENDING',
      ]);
    });
  });

  describe('step 2 — DNS', () => {
    it('is blocked before configuring, fails with a recorded code, then passes on a CNAME or on our addresses', async () => {
      const id = await createHosted();
      expect(await codeOf(run(id, 'domain'))).toBe(CODES.NOT_CONFIGURED);
      await configure(id);

      // Nothing points anywhere yet.
      expect(await codeOf(run(id, 'domain'))).toBe(CODES.DNS_NOT_POINTED);
      const failed = stepOf(await status(id), 'DOMAIN');
      expect(failed.state).toBe('FAILED');
      expect(failed.errorCode).toBe(CODES.DNS_NOT_POINTED);

      // A CNAME at someone else's host, an address that is not ours, a mix: all not pointed.
      dnsNow.set(DOMAIN, { cname: ['elsewhere.example.org'], addresses: ['198.51.100.9'] });
      expect(await codeOf(run(id, 'domain'))).toBe(CODES.DNS_NOT_POINTED);
      dnsNow.set(DOMAIN, { cname: [], addresses: [SERVER_IP, '198.51.100.9'] });
      expect(await codeOf(run(id, 'domain'))).toBe(CODES.DNS_NOT_POINTED);

      // An A record straight at this server's address.
      dnsNow.set(DOMAIN, { cname: [], addresses: [SERVER_IP] });
      expect(stepOf((await run(id, 'domain')).activation, 'DOMAIN').state).toBe('DONE');
      // Re-running is idempotent and clears the error; and the CNAME form passes as well.
      dnsNow.set(DOMAIN, { cname: ['admin.hosting.test'], addresses: [] });
      const again = await run(id, 'domain');
      expect(stepOf(again.activation, 'DOMAIN')).toMatchObject({ state: 'DONE', errorCode: null });
    });

    it('a lookup that times out is a lookup failure, not "not pointed"; a later failure clears the mark', async () => {
      const id = await createHosted();
      await configure(id);
      dnsNow.set(DOMAIN, { cname: ['admin.hosting.test'], addresses: [] });
      await run(id, 'domain');
      dnsFails = true;
      expect(await codeOf(run(id, 'domain'))).toBe(CODES.DNS_LOOKUP_FAILED);
      const after = await status(id);
      expect(stepOf(after, 'DOMAIN')).toMatchObject({
        state: 'FAILED',
        errorCode: CODES.DNS_LOOKUP_FAILED,
        doneAt: null,
      });
    });

    it('re-running replays the same idempotency key without checking again', async () => {
      const id = await createHosted();
      await configure(id);
      dnsNow.set(DOMAIN, { cname: ['admin.hosting.test'], addresses: [] });
      const idempotencyKey = key();
      expect((await run(id, 'domain', idempotencyKey)).replayed).toBe(false);
      dnsNow.clear();
      const replay = await run(id, 'domain', idempotencyKey);
      expect(replay.replayed).toBe(true);
      expect(stepOf(replay.activation, 'DOMAIN').state).toBe('DONE');
    });
  });

  describe('steps 3 and 4 — SSL and the webhook', () => {
    it('SSL waits for DNS, reports not ready, then done once the probe holds', async () => {
      const id = await createHosted();
      await configure(id);
      expect(await codeOf(run(id, 'ssl'))).toBe(CODES.STEP_BLOCKED);
      dnsNow.set(DOMAIN, { cname: ['admin.hosting.test'], addresses: [] });
      await run(id, 'domain');
      expect(await codeOf(run(id, 'ssl'))).toBe(CODES.SSL_NOT_READY);
      expect(stepOf(await status(id), 'SSL').state).toBe('FAILED');
      tlsReady.add(DOMAIN);
      expect(stepOf((await run(id, 'ssl')).activation, 'SSL').state).toBe('DONE');
    });

    it('the webhook waits for SSL, registers on the domain with the bot’s own secret, and is re-runnable', async () => {
      const id = await createHosted();
      await configure(id);
      expect(await codeOf(run(id, 'webhook'))).toBe(CODES.STEP_BLOCKED);
      dnsNow.set(DOMAIN, { cname: ['admin.hosting.test'], addresses: [] });
      await run(id, 'domain');
      tlsReady.add(DOMAIN);
      await run(id, 'ssl');
      const done = await run(id, 'webhook');
      expect(stepOf(done.activation, 'WEBHOOK').state).toBe('DONE');
      const [bot] = await db().select().from(botInstances).where(eq(botInstances.tenantId, id));
      const registration = telegram.registration(TELEGRAM_ID);
      expect(registration?.url).toBe(`https://${DOMAIN}/telegram/webhook/${bot?.id as string}`);
      expect(registration?.secretToken).toBe(
        perBotWebhookSecret(WEBHOOK_SECRET, bot?.id as string),
      );
      expect(bot?.webhookRegisteredAt).not.toBeNull();
      // Run again: nothing breaks, still done.
      expect(stepOf((await run(id, 'webhook')).activation, 'WEBHOOK').state).toBe('DONE');
    });

    it('a webhook Telegram refuses is a recorded failure with its code', async () => {
      const id = await createHosted();
      await configure(id);
      dnsNow.set(DOMAIN, { cname: ['admin.hosting.test'], addresses: [] });
      await run(id, 'domain');
      tlsReady.add(DOMAIN);
      await run(id, 'ssl');
      telegram.failNext('setWebhook', { kind: 'refuse', description: 'Bad Request: bad webhook' });
      expect(await codeOf(run(id, 'webhook'))).toBe(CODES.WEBHOOK_FAILED);
      expect(stepOf(await status(id), 'WEBHOOK')).toMatchObject({
        state: 'FAILED',
        errorCode: CODES.WEBHOOK_FAILED,
      });
      expect(stepOf((await run(id, 'webhook')).activation, 'WEBHOOK').state).toBe('DONE');
    });

    it('re-verifies the stored token, and a revoked one fails the step', async () => {
      const id = await createHosted();
      await configure(id);
      expect(stepOf((await run(id, 'token')).activation, 'TOKEN').state).toBe('DONE');
      telegram.revoke(TELEGRAM_ID, { keepWebhook: true });
      expect(await codeOf(run(id, 'token'))).toBe(CODES.TOKEN_REJECTED);
      expect(stepOf(await status(id), 'TOKEN').state).toBe('FAILED');
    });

    it('nothing is set up for a bot that is not active', async () => {
      const id = await createHosted();
      await db()
        .update(hostedBots)
        .set({ state: 'SUSPENDED' })
        .where(eq(hostedBots.hostedTenantId, id));
      expect(await codeOf(configure(id))).toBe(CODES.BOT_NOT_ACTIVE);
    });
  });

  describe('step 5 — the one-time activation link', () => {
    it('needs every earlier step; then shows the URL once and stores only a hash', async () => {
      const id = await createHosted();
      expect(await codeOf(issueLink(id))).toBe(CODES.STEP_BLOCKED);
      await upToWebhook(id);

      const idempotencyKey = key();
      const made = await issueLink(id, idempotencyKey);
      expect(made.activationUrl).toMatch(new RegExp(`^https://${DOMAIN}/activate#token=nxact_`));
      const token = tokenOf(made.activationUrl);
      expect(stepOf(made.activation, 'LINK').state).toBe('DONE');
      expect(made.activation.link?.state).toBe('ACTIVE');
      const lifetime =
        new Date(made.activation.link?.expiresAt as string).getTime() -
        new Date(made.activation.link?.createdAt as string).getTime();
      expect(lifetime).toBe(HOSTED_ACTIVATION_LINK_TTL_SECONDS * 1000);

      // Hash only: the token is in no row, no audit entry, no event.
      const links = await db().select().from(hostedBotActivationLinks);
      expect(links).toHaveLength(1);
      expect(links[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(links[0]?.tokenHash).not.toContain(token);
      for (const table of [
        'audit_logs',
        'outbox_messages',
        'request_idempotency',
        'hosted_bot_activation_links',
        'hosted_bot_activations',
      ]) {
        const dump = await db().execute(sql.raw(`SELECT t::text AS row FROM ${table} t`));
        expect(JSON.stringify(dump.rows)).not.toContain(token);
      }

      // A replay of the same request cannot show it again.
      const replay = await issueLink(id, idempotencyKey);
      expect(replay.replayed).toBe(true);
      expect(replay.activationUrl).toBeNull();
      expect(await db().select().from(hostedBotActivationLinks)).toHaveLength(1);
    });

    it('a newer link revokes the older unused one', async () => {
      const id = await createHosted();
      await upToWebhook(id);
      const older = tokenOf((await issueLink(id)).activationUrl);
      const newer = tokenOf((await issueLink(id)).activationUrl);
      expect(await codeOf(redeem(DOMAIN, older))).toBe(CODES.LINK_EXPIRED);
      await redeem(DOMAIN, newer);
    });
  });

  describe('redeeming the link', () => {
    async function readyLink() {
      const id = await createHosted();
      await upToWebhook(id);
      const token = tokenOf((await issueLink(id)).activationUrl);
      return { id, token };
    }

    it('sets the hosted owner’s username and password, burns the link, audits — and they sign in normally', async () => {
      const { id, token } = await readyLink();
      await redeem(DOMAIN, token, { displayName: 'Alpha Owner' });

      const [owner] = await db()
        .select()
        .from(admins)
        .where(and(eq(admins.tenantId, id), eq(admins.username, 'alpha-owner')));
      expect(owner?.displayName).toBe('Alpha Owner');
      const [link] = await db().select().from(hostedBotActivationLinks);
      expect(link?.usedAt).not.toBeNull();
      const [activation] = await db().select().from(hostedBotActivations);
      expect(activation?.ownerActivatedAt).not.toBeNull();
      const audited = await db()
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'hosting.owner_activated'));
      expect(audited).toHaveLength(1);
      expect(audited[0]?.tenantId).toBe(id);
      expect(JSON.stringify(audited)).not.toContain('a-brand-new-long-password');
      expect(JSON.stringify(audited)).not.toContain(token);
      expect(
        await db()
          .select()
          .from(outboxMessages)
          .where(eq(outboxMessages.eventType, 'HostedBotOwnerActivated')),
      ).toHaveLength(1);

      // The creator's placeholder no longer signs in; the chosen credentials do — on the
      // hosted domain, over HTTP.
      const login = (username: string, password: string) =>
        inject({
          method: 'POST',
          url: `${API_PREFIX}/auth/login`,
          headers: { host: DOMAIN, origin: `https://${DOMAIN}` },
          payload: { username, password },
        });
      expect((await login('alpha-placeholder', PLACEHOLDER_PASSWORD)).statusCode).toBe(401);
      expect((await login('alpha-owner', 'a-brand-new-long-password')).statusCode).toBe(201);
    });

    it('is single-use: the second redemption, sequential or concurrent, changes nothing', async () => {
      const { token } = await readyLink();
      const results = await Promise.allSettled([
        redeem(DOMAIN, token, { username: 'first-owner' }),
        redeem(DOMAIN, token, { username: 'second-owner' }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const [loser] = results.filter((result) => result.status === 'rejected');
      expect(isNexaError((loser as PromiseRejectedResult).reason)).toBe(true);
      expect(await codeOf(redeem(DOMAIN, token, { username: 'third-owner' }))).toBe(
        CODES.LINK_USED,
      );
      const names = (await db().select().from(admins)).map((admin) => admin.username);
      expect(names.filter((name) => /^(first|second|third)-owner$/.test(name))).toHaveLength(1);
      expect(
        await db().select().from(auditLogs).where(eq(auditLogs.action, 'hosting.owner_activated')),
      ).toHaveLength(1);
    });

    it('expires 24 hours after it was made, by the Clock', async () => {
      const { token } = await readyLink();
      offsetMs += HOSTED_ACTIVATION_LINK_TTL_SECONDS * 1000 - 60_000;
      // One minute before: still good — proven by NOT redeeming it, only by the boundary below.
      const [link] = await db().select().from(hostedBotActivationLinks);
      expect(link?.expiresAt.getTime()).toBeGreaterThan(now().getTime());
      offsetMs += 61_000;
      expect(await codeOf(redeem(DOMAIN, token))).toBe(CODES.LINK_EXPIRED);
      expect((await db().select().from(hostedBotActivationLinks))[0]?.usedAt).toBeNull();
    });

    it('is good just before the 24 hours are up', async () => {
      const { token } = await readyLink();
      offsetMs += HOSTED_ACTIVATION_LINK_TTL_SECONDS * 1000 - 60_000;
      await redeem(DOMAIN, token);
    });

    it('is valid only on the domain it was made for, and an unknown token is just invalid', async () => {
      const { token } = await readyLink();
      expect(await codeOf(redeem('admin.hosting.test', token))).toBe(CODES.LINK_INVALID);
      expect(await codeOf(redeem('somewhere-else.com', token))).toBe(CODES.LINK_INVALID);
      expect(await codeOf(redeem(undefined, token))).toBe(CODES.LINK_INVALID);
      expect(await codeOf(redeem(DOMAIN, `nxact_${'a'.repeat(43)}`))).toBe(CODES.LINK_INVALID);
      // Still unspent.
      await redeem(DOMAIN, token);
    });

    it('another hosted bot’s verified domain cannot redeem it either', async () => {
      const { token } = await readyLink();
      const beta = await createHosted('beta');
      const betaBot = telegram.createBot({ id: 7_100_000_004, username: 'beta_store_bot' });
      await configure(beta, { botToken: betaBot, domain: 'bots.beta-store.com' });
      dnsNow.set('bots.beta-store.com', { cname: ['admin.hosting.test'], addresses: [] });
      await run(beta, 'domain');
      // A resolvable hosted domain, but not the one this link was made for.
      expect(await codeOf(redeem('bots.beta-store.com', token))).toBe(CODES.LINK_INVALID);
      expect((await db().select().from(hostedBotActivationLinks))[0]?.usedAt).toBeNull();
      await redeem(DOMAIN, token);
    });

    it('a username another admin holds refuses the redemption and does NOT spend the link', async () => {
      const { id, token } = await readyLink();
      await createAdmin(
        api.container,
        { tenantId: id as never, botInstanceId: null } as TenantContext,
        { username: 'taken-name', roleKeys: ['operator'] },
      );
      expect(await codeOf(redeem(DOMAIN, token, { username: 'taken-name' }))).toBe(
        CODES.USERNAME_TAKEN,
      );
      expect((await db().select().from(hostedBotActivationLinks))[0]?.usedAt).toBeNull();
      await redeem(DOMAIN, token);
    });

    it('is refused for a bot that is no longer active, and the weak password policy still applies', async () => {
      const { id, token } = await readyLink();
      await expect(redeem(DOMAIN, token, { password: 'short' })).rejects.toBeDefined();
      await db().update(tenants).set({ status: 'STOPPED' }).where(eq(tenants.id, id));
      expect(await codeOf(redeem(DOMAIN, token))).toBe(CODES.BOT_NOT_ACTIVE);
      expect((await db().select().from(hostedBotActivationLinks))[0]?.usedAt).toBeNull();
    });

    it('the spend itself refuses a used, revoked or expired link, whatever the caller checked first', async () => {
      const { id } = await readyLink();
      const [link] = await db().select().from(hostedBotActivationLinks);
      const spend = (at: Date) =>
        db().transaction((tx) =>
          new DrizzleHostedOwnerActivation(db()).burnLink(
            systemContext('hosting.activate_owner'),
            link?.id as string,
            at,
            { tx } as never,
          ),
        );
      // Expired: at the expiry instant itself, and after it.
      expect(await spend(link?.expiresAt as Date)).toBe(false);
      expect(await spend(new Date((link?.expiresAt as Date).getTime() + 1000))).toBe(false);
      // Revoked by a newer link.
      await issueLink(id);
      expect(await spend(now())).toBe(false);
      const [newest] = (await db().select().from(hostedBotActivationLinks)).filter(
        (row) => row.revokedAt === null,
      );
      expect(newest).toBeDefined();
      // Used: the first spend wins, the second does not.
      const spendNewest = (at: Date) =>
        db().transaction((tx) =>
          new DrizzleHostedOwnerActivation(db()).burnLink(
            systemContext('hosting.activate_owner'),
            newest?.id as string,
            at,
            { tx } as never,
          ),
        );
      expect(await spendNewest(now())).toBe(true);
      expect(await spendNewest(now())).toBe(false);
    });

    it('no new link once the hosted owner has activated', async () => {
      const { id, token } = await readyLink();
      await redeem(DOMAIN, token);
      expect(await codeOf(issueLink(id))).toBe(CODES.LINK_USED);
    });
  });

  describe('Host → tenant: Web Admin sign-in on a hosted domain', () => {
    async function activated() {
      const id = await createHosted();
      await upToWebhook(id);
      await redeem(DOMAIN, tokenOf((await issueLink(id)).activationUrl));
      return id;
    }
    const login = (
      headers: Record<string, string>,
      credentials = { username: 'alpha-owner', password: 'a-brand-new-long-password' },
      remoteAddress?: string,
    ) =>
      inject({
        method: 'POST',
        url: `${API_PREFIX}/auth/login`,
        headers,
        payload: credentials,
        ...(remoteAddress === undefined ? {} : { remoteAddress }),
      });

    it('a verified hosted domain signs in THAT tenant, sets a session that works there, and nowhere else', async () => {
      const id = await activated();
      const response = await login({ host: DOMAIN, origin: `https://${DOMAIN}` });
      expect(response.statusCode).toBe(201);
      const cookie = /nexa_admin_session=([^;]+)/.exec(String(response.headers['set-cookie']))?.[1];
      const session = await inject({
        method: 'GET',
        url: `${API_PREFIX}/auth/session`,
        headers: { host: DOMAIN, cookie: `nexa_admin_session=${cookie as string}` },
      });
      expect(session.statusCode).toBe(200);
      expect(session.json().admin.username).toBe('alpha-owner');
      const [admin] = await db().select().from(admins).where(eq(admins.username, 'alpha-owner'));
      expect(admin?.tenantId).toBe(id);
      // The hosted owner holds every key in their tenant, but not the creator panel.
      const panelStatus = await inject({
        method: 'GET',
        url: `${API_PREFIX}/hosting/status`,
        headers: { host: DOMAIN, cookie: `nexa_admin_session=${cookie as string}` },
      });
      expect(panelStatus.statusCode).toBe(403);
    });

    it('the installation host never signs a hosted admin in, and unknown hosts keep the installation’s behaviour', async () => {
      await activated();
      expect((await login({ host: 'admin.hosting.test', origin: ORIGIN })).statusCode).toBe(401);
      expect((await login({ origin: ORIGIN })).statusCode).toBe(401);
      expect((await login({ host: 'unknown-domain.com', origin: ORIGIN })).statusCode).toBe(401);
      // The installation owner still signs in on the installation host.
      expect(
        (
          await login(
            { host: 'admin.hosting.test', origin: ORIGIN },
            { username: 'panel-owner', password: OWNER_PASSWORD },
          )
        ).statusCode,
      ).toBe(201);
      // …and a hosted domain does not sign the installation owner in.
      expect(
        (
          await login(
            { host: DOMAIN, origin: `https://${DOMAIN}` },
            { username: 'panel-owner', password: OWNER_PASSWORD },
          )
        ).statusCode,
      ).toBe(401);
    });

    it('an untrusted peer’s X-Forwarded-Host cannot name a hosted domain; a trusted proxy’s can', async () => {
      await activated();
      // From a peer that is not in TRUSTED_PROXY_IPS the header is ignored: the request is
      // addressed to the installation host, so the hosted owner's credentials do not work.
      const spoofed = await login(
        { host: 'admin.hosting.test', 'x-forwarded-host': DOMAIN, origin: ORIGIN },
        undefined,
        '198.51.100.9',
      );
      expect(spoofed.statusCode).toBe(401);
      // Even claiming the hosted Origin with it does not help: the Origin must match the Host.
      const spoofedOrigin = await login(
        { host: 'admin.hosting.test', 'x-forwarded-host': DOMAIN, origin: `https://${DOMAIN}` },
        undefined,
        '198.51.100.9',
      );
      expect(spoofedOrigin.statusCode).toBe(403);
      // The edge (a trusted proxy) forwards the real Host, and the hosted tenant resolves.
      const proxied = await login(
        { host: 'api:3000', 'x-forwarded-host': DOMAIN, origin: `https://${DOMAIN}` },
        undefined,
        EDGE_IP,
      );
      expect(proxied.statusCode).toBe(201);
    });

    it('an unverified domain resolves to nothing, even with the right Origin', async () => {
      const id = await createHosted();
      await configure(id);
      // Configured but DNS never verified: not trusted, not a hosted host.
      const response = await login({ host: DOMAIN, origin: `https://${DOMAIN}` });
      expect(response.statusCode).toBe(403);
    });

    it('the activation page’s redeem route works on the hosted domain only, with its own Origin', async () => {
      const id = await createHosted();
      await upToWebhook(id);
      const token = tokenOf((await issueLink(id)).activationUrl);
      const url = `${API_PREFIX}${HOSTED_ACTIVATION_ROUTES.redeem}`;
      const payload = { token, username: 'alpha-owner', password: 'a-brand-new-long-password' };
      expect(
        (
          await inject({
            method: 'POST',
            url,
            headers: { host: DOMAIN, origin: 'https://evil.example' },
            payload,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await inject({
            method: 'POST',
            url,
            headers: { host: 'admin.hosting.test', origin: ORIGIN },
            payload,
          })
        ).json().error.code,
      ).toBe(CODES.LINK_INVALID);
      const ok = await inject({
        method: 'POST',
        url,
        headers: { host: DOMAIN, origin: `https://${DOMAIN}` },
        payload,
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['cache-control']).toBe('no-store');
      const again = await inject({
        method: 'POST',
        url,
        headers: { host: DOMAIN, origin: `https://${DOMAIN}` },
        payload,
      });
      expect(again.json().error.code).toBe(CODES.LINK_USED);
    });
  });

  describe('the edge’s certificate question', () => {
    const ask = (
      domain: string | undefined,
      options: { remoteAddress?: string; headers?: Record<string, string> } = {},
    ) =>
      inject({
        method: 'GET',
        url: `${HOSTED_DOMAIN_CHECK_PATH}${domain === undefined ? '' : `?domain=${encodeURIComponent(domain)}`}`,
        ...(options.remoteAddress === undefined ? {} : { remoteAddress: options.remoteAddress }),
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      });

    it('answers 200 only for a DNS-verified domain of an ACTIVE hosted bot; 404 for everything else', async () => {
      const id = await createHosted();
      // Nothing known.
      expect((await ask(DOMAIN)).statusCode).toBe(404);
      await configure(id);
      // Configured, not verified.
      expect((await ask(DOMAIN)).statusCode).toBe(404);
      dnsNow.set(DOMAIN, { cname: ['admin.hosting.test'], addresses: [] });
      await run(id, 'domain');
      expect((await ask(DOMAIN)).statusCode).toBe(200);
      expect((await ask(DOMAIN.toUpperCase())).statusCode).toBe(200);
      // Others: unknown, a lookalike, the installation's own name, an address, garbage, none.
      for (const other of [
        'evil.example.org',
        `x.${DOMAIN}`,
        `${DOMAIN}.evil.com`,
        'admin.hosting.test',
        '203.0.113.10',
        '../etc',
        '',
      ]) {
        expect((await ask(other)).statusCode).toBe(404);
      }
      expect((await ask(undefined)).statusCode).toBe(404);
      expect((await ask(DOMAIN)).body).toBe('');
    });

    it('stops answering 200 when the hosted bot is suspended or its DNS check later fails', async () => {
      const id = await createHosted();
      await configure(id);
      dnsNow.set(DOMAIN, { cname: ['admin.hosting.test'], addresses: [] });
      await run(id, 'domain');
      expect((await ask(DOMAIN)).statusCode).toBe(200);
      await db().update(tenants).set({ status: 'STOPPED' }).where(eq(tenants.id, id));
      expect((await ask(DOMAIN)).statusCode).toBe(404);
      await db().update(tenants).set({ status: 'ACTIVE' }).where(eq(tenants.id, id));
      expect((await ask(DOMAIN)).statusCode).toBe(200);
      await db()
        .update(hostedBots)
        .set({ state: 'SUSPENDED' })
        .where(eq(hostedBots.hostedTenantId, id));
      expect((await ask(DOMAIN)).statusCode).toBe(404);
      await db()
        .update(hostedBots)
        .set({ state: 'ACTIVE' })
        .where(eq(hostedBots.hostedTenantId, id));
      dnsNow.clear();
      await run(id, 'domain').catch(() => undefined);
      expect((await ask(DOMAIN)).statusCode).toBe(404);
    });

    it('is not abusable: only the edge, never a proxied request, and a budget', async () => {
      const id = await createHosted();
      await configure(id);
      dnsNow.set(DOMAIN, { cname: ['admin.hosting.test'], addresses: [] });
      await run(id, 'domain');
      expect((await ask(DOMAIN, { remoteAddress: '127.0.0.1' })).statusCode).toBe(200);
      expect((await ask(DOMAIN, { remoteAddress: EDGE_IP })).statusCode).toBe(200);
      // A peer that is neither loopback nor the edge.
      expect((await ask(DOMAIN, { remoteAddress: '198.51.100.9' })).statusCode).toBe(404);
      // A request that came THROUGH a proxy (the public internet's path) carries forwarding headers.
      expect(
        (await ask(DOMAIN, { headers: { 'x-forwarded-for': '198.51.100.9' } })).statusCode,
      ).toBe(404);
      expect((await ask(DOMAIN, { headers: { 'x-forwarded-host': DOMAIN } })).statusCode).toBe(404);
      expect((await ask(DOMAIN, { headers: { forwarded: 'for=198.51.100.9' } })).statusCode).toBe(
        404,
      );
      // A budget across every caller.
      let refused = 0;
      for (let call = 0; call < 140; call += 1) {
        if ((await ask(DOMAIN)).statusCode === 404) refused += 1;
      }
      expect(refused).toBeGreaterThan(0);
    });

    it('the edge does not proxy the internal path: routes.caddy has no handler for it', async () => {
      const routes = await import('node:fs').then((fs) =>
        fs.readFileSync('deploy/caddy/routes.caddy', 'utf8'),
      );
      expect(routes).not.toContain('/internal');
    });
  });

  /**
   * ADR-0037: the activation's three adapters reach other tenants' rows only on the system
   * path, and only where that is the point. These are the rules that routing must not weaken:
   * the hosted owner's activation and sign-in are the HOSTED tenant's, never the PRIMARY
   * (installation) tenant's, and they never carry the creator panel's permission.
   */
  describe('under row-level security — what the system path must not widen', () => {
    const NEW_PASSWORD = 'a-brand-new-long-password';
    const hostedLogin = (username: string, password: string, host = DOMAIN) =>
      inject({
        method: 'POST',
        url: `${API_PREFIX}/auth/login`,
        headers: { host, origin: host === DOMAIN ? `https://${DOMAIN}` : ORIGIN },
        payload: { username, password },
      });

    const betaToken = () => telegram.createBot({ id: TELEGRAM_ID + 1, username: 'beta_store_bot' });

    async function readyLink(slug = 'alpha', domain = DOMAIN, token = botToken) {
      const id = await createHosted(slug);
      await configure(id, { domain, botToken: token });
      dnsNow.set(domain, { cname: ['admin.hosting.test'], addresses: [SERVER_IP] });
      await run(id, 'domain');
      tlsReady.add(domain);
      await run(id, 'ssl');
      await run(id, 'webhook');
      return { id, token: tokenOf((await issueLink(id)).activationUrl) };
    }

    /** Everything that decides what a person may do, in every tenant. */
    async function permissionState() {
      const [roleKeys, grants, assignments, overrides] = await Promise.all([
        db().select().from(roles),
        db().select().from(rolePermissions),
        db().select().from(adminRoles),
        db().select().from(adminPermissionOverrides),
      ]);
      const order = (rows: object[]) => rows.map((row) => JSON.stringify(row)).sort();
      return {
        roles: order(roleKeys),
        grants: order(grants),
        assignments: order(assignments),
        overrides: order(overrides),
      };
    }

    async function primaryState() {
      const [people, sessions, trail] = await Promise.all([
        db().select().from(admins).where(eq(admins.tenantId, tenantA.tenantId)),
        db().select().from(adminSessions).where(eq(adminSessions.tenantId, tenantA.tenantId)),
        db().select().from(auditLogs).where(eq(auditLogs.tenantId, tenantA.tenantId)),
      ]);
      const order = (rows: object[]) => rows.map((row) => JSON.stringify(row)).sort();
      return {
        admins: order(people),
        sessions: order(sessions),
        audit: trail.map((row) => row.action).sort(),
      };
    }

    it('the app runs as nexa_app: the policies bind it, so a missed system path would raise', async () => {
      const who = await api.container.uow.run(
        tenantA,
        async (tx) => (await tx.tx.execute(sql`SELECT session_user AS who`)).rows[0],
      );
      expect((who as { who: string }).who).toBe('nexa_app');
    });

    it('a redemption writes the hosted owner and two named installation rows — nothing of the PRIMARY tenant', async () => {
      const { id, token } = await readyLink();
      const before = await primaryState();
      await redeem(DOMAIN, token);
      expect(await primaryState()).toEqual(before);
      const [owner] = await db()
        .select()
        .from(admins)
        .where(and(eq(admins.tenantId, id), eq(admins.username, 'alpha-owner')));
      expect(owner).toBeDefined();
      // Its audit row and its event belong to the hosted tenant.
      const trail = await db()
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'hosting.owner_activated'));
      expect(trail.map((row) => row.tenantId)).toEqual([id]);
      const events = await db()
        .select()
        .from(outboxMessages)
        .where(eq(outboxMessages.eventType, 'HostedBotOwnerActivated'));
      expect(events.map((row) => row.tenantId)).toEqual([id]);
    });

    it('the credential write runs under the hosted tenant’s own binding: another tenant’s admin is not found, PRIMARY’s included', async () => {
      const alpha = await readyLink('alpha');
      const beta = await readyLink('beta', 'bots.beta-store.com', betaToken());
      const [primaryOwner] = await db()
        .select()
        .from(admins)
        .where(and(eq(admins.tenantId, tenantA.tenantId), eq(admins.username, 'panel-owner')));
      const [alphaOwner] = await db().select().from(admins).where(eq(admins.tenantId, alpha.id));
      const before = await primaryState();
      const hashes = async () =>
        (await db().select({ id: admins.id, hash: admins.passwordHash }).from(admins))
          .map((row) => `${row.id}:${row.hash}`)
          .sort();
      const hashesBefore = await hashes();
      const attempt = (hostedTenantId: string, ownerAdminId: string) =>
        api.container.uow.run({ tenantId: beta.id as never, botInstanceId: null }, (tx) =>
          new DrizzleHostedOwnerActivation(db()).setOwnerCredentials(
            systemContext('hosting.activate_owner'),
            {
              hostedTenantId,
              ownerAdminId,
              username: 'taken-over',
              passwordHash: 'x'.repeat(32),
              now: now(),
            },
            tx,
          ),
        );
      // Bound to beta, handed alpha's owner, PRIMARY's owner — under either tenant's id.
      expect(await attempt(beta.id, alphaOwner?.id as string)).toBe('NOT_FOUND');
      expect(await attempt(beta.id, primaryOwner?.id as string)).toBe('NOT_FOUND');
      expect(await attempt(alpha.id, alphaOwner?.id as string)).toBe('NOT_FOUND');
      expect(await attempt(tenantA.tenantId as string, primaryOwner?.id as string)).toBe(
        'NOT_FOUND',
      );
      expect(await primaryState()).toEqual(before);
      expect(await hashes()).toEqual(hashesBefore);
    });

    it('sign-in on a hosted domain is the HOSTED tenant’s, even for a username PRIMARY also has', async () => {
      const { id, token } = await readyLink();
      // `panel-owner` is the installation owner's own username in PRIMARY.
      await redeem(DOMAIN, token, { username: 'panel-owner', password: NEW_PASSWORD });
      const before = (
        await db().select().from(adminSessions).where(eq(adminSessions.tenantId, tenantA.tenantId))
      ).length;

      const hosted = await hostedLogin('panel-owner', NEW_PASSWORD);
      expect(hosted.statusCode).toBe(201);
      const [session] = await db()
        .select()
        .from(adminSessions)
        .where(eq(adminSessions.tenantId, id));
      expect(session).toBeDefined();
      expect(
        (
          await db()
            .select()
            .from(adminSessions)
            .where(eq(adminSessions.tenantId, tenantA.tenantId))
        ).length,
      ).toBe(before);
      // PRIMARY's password is not accepted on the hosted domain, nor the hosted one on PRIMARY's.
      expect((await hostedLogin('panel-owner', OWNER_PASSWORD)).statusCode).toBe(401);
      expect(
        (await hostedLogin('panel-owner', NEW_PASSWORD, 'admin.hosting.test')).statusCode,
      ).toBe(401);
      expect(
        (await hostedLogin('panel-owner', OWNER_PASSWORD, 'admin.hosting.test')).statusCode,
      ).toBe(201);
    });

    it('activation never gives the hosted owner hosting.manage: nothing is granted, the chrome list and the panel refuse', async () => {
      const { token } = await readyLink();
      const before = await permissionState();
      await redeem(DOMAIN, token);
      expect(await permissionState()).toEqual(before);

      const response = await hostedLogin('alpha-owner', NEW_PASSWORD);
      expect(response.statusCode).toBe(201);
      const cookie = /nexa_admin_session=([^;]+)/.exec(String(response.headers['set-cookie']))?.[1];
      const headers = { host: DOMAIN, cookie: `nexa_admin_session=${cookie as string}` };
      const listed = (response.json() as { permissions: string[] }).permissions;
      const session = await inject({ method: 'GET', url: `${API_PREFIX}/auth/session`, headers });
      const afterwards = (session.json() as { permissions: string[] }).permissions;
      // They do hold their own tenant's keys (the list is not empty)…
      expect(listed.length).toBeGreaterThan(5);
      expect(afterwards.length).toBeGreaterThan(5);
      // …but never the creator panel's, and the panel itself says no.
      expect(listed).not.toContain('hosting.manage');
      expect(afterwards).not.toContain('hosting.manage');
      expect(
        (await inject({ method: 'GET', url: `${API_PREFIX}/hosting/status`, headers })).statusCode,
      ).toBe(403);
      expect(
        (
          await inject({
            method: 'POST',
            url: `${API_PREFIX}/hosting/bots`,
            headers: { ...headers, origin: `https://${DOMAIN}` },
            payload: {},
          })
        ).statusCode,
      ).toBe(403);
    });

    it('an activation token is refused when reused, when expired and when carried to another hosted domain', async () => {
      const alpha = await readyLink('alpha');
      const beta = await readyLink('beta', 'bots.beta-store.com', betaToken());
      // Another hosted bot's verified domain, with a perfectly good link of its own.
      expect(await codeOf(redeem('bots.beta-store.com', alpha.token))).toBe(CODES.LINK_INVALID);
      expect(
        (await db().select().from(hostedBotActivationLinks)).filter((row) => row.usedAt !== null),
      ).toHaveLength(0);
      await redeem(DOMAIN, alpha.token);
      expect(await codeOf(redeem(DOMAIN, alpha.token))).toBe(CODES.LINK_USED);
      // Beta's own link lapses after its 24 hours, by the Clock.
      offsetMs += HOSTED_ACTIVATION_LINK_TTL_SECONDS * 1000;
      expect(await codeOf(redeem('bots.beta-store.com', beta.token))).toBe(CODES.LINK_EXPIRED);
      expect(
        (await db().select().from(admins).where(eq(admins.tenantId, beta.id))).map(
          (row) => row.username,
        ),
      ).not.toContain('alpha-owner');
    });
  });
});
