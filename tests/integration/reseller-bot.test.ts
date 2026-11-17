import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HOSTING_ERROR_CODES,
  HOSTING_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  API_PREFIX,
  type ResellerBotRequestsAdminResponse,
  RESELLER_BOT_ERROR_CODES as CODES,
  isNexaError,
  systemJobActor,
  type ActorContext,
  type CorrelationId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  auditLogs,
  customerNotifications,
  hostedBots,
  resellerBotFeeCharges,
  resellerBotFeeNotices,
  resellerBotRequests,
  tenants,
  walletEntries,
} from '../../apps/api/src/infrastructure/persistence/schema';
import {
  totpForStep,
  totpStepAt,
} from '../../apps/api/src/modules/platform/identity/application/totp';
import type {
  HostedDnsResolver,
  HostedTlsProbe,
} from '../../apps/api/src/modules/platform/hosting/application/activation-ports';
import type { DnsObservation } from '../../apps/api/src/modules/platform/hosting/domain/hosted-domain';
import {
  ResellerBotFeeService,
  type ResellerBotFeeDeps,
} from '../../apps/api/src/modules/commerce/reseller-bots/application/reseller-bot-fee.service';
import { CustomerNotificationService } from '../../apps/api/src/modules/commerce/messaging/application/customer-notification.service';
import type { CustomerMessage } from '../../apps/api/src/modules/commerce/messaging/application/ports';
import { DrizzleWalletRepository } from '../../apps/api/src/modules/commerce/wallet/infrastructure/drizzle-wallet.repository';
import { DrizzlePaymentRepository } from '../../apps/api/src/modules/commerce/payments/infrastructure/drizzle-payment.repository';
import { DrizzleServiceReminderSnapshotReader } from '../../apps/api/src/modules/commerce/provisioning/infrastructure/drizzle-service-reminder.repository';
import { DrizzleCustomerRepository } from '../../apps/api/src/modules/commerce/customers/infrastructure/drizzle-customer.repository';
import { startFakeTelegramBotApi, type FakeTelegramBotApi } from '../support/fake-telegram-bot-api';
import {
  createAdmin,
  createApiApp,
  migrateOnce,
  resetDatabase,
  SEED_IDS,
  tenantA,
  tenantB,
  testConfig,
} from './harness';

const ORIGIN = 'https://admin.hosting.test';
const SERVER_IP = '203.0.113.10';
const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-hosting';
const OWNER_PASSWORD = 'the-owners-own-password';
const HOSTED_PASSWORD = 'the-hosted-owners-password';
const DOMAIN = 'bots.reseller-one.com';
const FEE = 500_000n;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 31 * DAY_MS;

/**
 * Reseller-phase PR-6 (§5.9) — a reseller's dedicated hosted bot and its monthly wallet fee,
 * against the real app and a real database: Telegram is the HTTP fake, DNS and the HTTPS probe
 * injected fakes, the clock the container's own moved by the cases.
 *
 * Every §5.9 rule: approval debits once (a replay is idempotent); a short wallet refuses the
 * approval and writes nothing; one debit per period; grace notices once a day, then the stop
 * through the existing stop path (data kept); a top-up resumes it (the job, or the reseller's
 * own pay); reject and cancel charge nothing; another reseller cannot see the request; the
 * activation link reaches the reseller and is never stored in clear.
 */
describe('a reseller’s dedicated bot (reseller-phase PR-6)', () => {
  let api: ApiApp;
  let telegram: FakeTelegramBotApi;
  let offsetMs = 0;
  let keys = 0;
  let ownerActor: ActorContext;
  let ownerSessionToken: string;
  let owner: { id: string; username: string; password: string };
  let panel: { secret: string; token: string };
  let reseller: UserId;
  let otherReseller: UserId;
  let plainCustomer: UserId;
  let botToken: string;

  const dnsNow = new Map<string, DnsObservation>();
  const tlsReady = new Set<string>();
  const dns: HostedDnsResolver = {
    observe: (domain) => Promise.resolve(dnsNow.get(domain) ?? { cname: [], addresses: [] }),
    addressesOf: () => Promise.resolve([SERVER_IP]),
  };
  const tls: HostedTlsProbe = {
    probe: (domain) =>
      Promise.resolve(tlsReady.has(domain) ? { ok: true } : { ok: false, reason: 'CERTIFICATE' }),
  };

  const db = () => api.container.database.db;
  const bots = () => api.container.resellerBots;
  const key = () => `reseller-bot-key-${String((keys += 1))}`;
  const now = () => api.container.clock.now();
  const panelActor = systemJobActor('reseller-panel', 'c' as CorrelationId);
  const code = () => {
    offsetMs += 30_000;
    return totpForStep(panel.secret, totpStepAt(now()));
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
  const id = () => api.container.ids.uuid();

  async function signIn(admin: { id: string; username: string; password: string }) {
    const result = await api.container.auth.login(
      tenantA,
      { type: 'API', id: null, label: null, surface: 'WEB', correlationId: 'c' as CorrelationId },
      { username: admin.username, password: admin.password },
      { ip: null, userAgent: null },
    );
    ownerSessionToken = result.token;
    return {
      type: 'WEB_ADMIN',
      id: admin.id,
      label: admin.username,
      surface: 'WEB',
      correlationId: 'test-correlation' as CorrelationId,
      sessionId: result.session.id,
    } as ActorContext;
  }

  async function customer(telegramUserId: string, scope: TenantContext = tenantA): Promise<UserId> {
    const customerId = id();
    await db().execute(sql`
      INSERT INTO customers (id, tenant_id, telegram_user_id, status, first_bot_instance_id,
                             first_seen_at, first_name, created_at)
      VALUES (${customerId}, ${scope.tenantId}, ${telegramUserId}, 'ACTIVE',
              ${scope.tenantId === tenantA.tenantId ? SEED_IDS.botA1 : SEED_IDS.botB1},
              now(), 'نماینده', now())`);
    return customerId as UserId;
  }

  async function makeReseller(customerId: string, status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') {
    const tierId = id();
    await db().execute(sql`
      INSERT INTO reseller_tiers (id, tenant_id, name, pricing_mode, credit_limit_currency)
      VALUES (${tierId}, ${tenantA.tenantId}, ${`tier-${tierId.slice(-6)}`}, 'LIST_PRICE', 'IRT')`);
    await db().execute(sql`
      INSERT INTO resellers (id, tenant_id, customer_id, tier_id, status, credit_limit_amount)
      VALUES (${id()}, ${tenantA.tenantId}, ${customerId}, ${tierId}, ${status}, NULL)`);
  }

  async function credit(customerId: string, amount: bigint) {
    const entryId = id();
    await db().execute(sql`
      INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount, currency,
                                  reference, note)
      VALUES (${entryId}, ${tenantA.tenantId}, ${customerId}, 'CREDIT', 'ADMIN_CREDIT',
              ${amount.toString()}, 'IRT', ${`fixture:${entryId}`}, 'fixture')`);
  }

  async function setFee(amountMinor: bigint) {
    const { rows } = await db().execute(
      sql`SELECT version FROM setting_values
           WHERE tenant_id = ${tenantA.tenantId} AND setting_key = 'hosting.reseller_bot_monthly_fee'`,
    );
    await api.container.settingsService.set(tenantA, ownerActor, {
      key: 'hosting.reseller_bot_monthly_fee',
      value: { amountMinor: amountMinor.toString(), currency: 'IRT' },
      expectedVersion: (rows[0] as { version: number } | undefined)?.version ?? null,
      idempotencyKey: key(),
    } as never);
  }

  const feeDebits = async (requestId?: string) =>
    db()
      .select()
      .from(walletEntries)
      .where(
        and(
          eq(walletEntries.reason, 'HOSTED_BOT_FEE'),
          requestId === undefined
            ? sql`true`
            : sql`left(${walletEntries.reference}, 52) = ${`hosted-bot-fee:${requestId}:`}`,
        ),
      );
  const requestRow = async (requestId: string) =>
    (await db().select().from(resellerBotRequests).where(eq(resellerBotRequests.id, requestId)))[0];
  const hostedRow = async (hostedTenantId: string) =>
    (await db().select().from(hostedBots).where(eq(hostedBots.hostedTenantId, hostedTenantId)))[0];
  const tenantRow = async (tenantId: string) =>
    (await db().select().from(tenants).where(eq(tenants.id, tenantId)))[0];
  const balanceOf = async (customerId: string) => {
    const { rows } = await db().execute(
      sql`SELECT coalesce(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS b
            FROM wallet_entries WHERE customer_id = ${customerId}`,
    );
    return BigInt((rows[0] as { b: string }).b);
  };

  const submit = (customerId: string, extra: Record<string, unknown> = {}) =>
    bots().submit(tenantA, panelActor, {
      customerId,
      idempotencyKey: key(),
      botToken,
      domain: null,
      ...extra,
    });
  const approve = (requestId: string, idempotencyKey = key()) =>
    bots().approve(tenantA, ownerActor, panel.token, requestId, {
      idempotencyKey,
      proof: { code: code() },
    });
  const reject = (requestId: string, reason: string) =>
    bots().reject(tenantA, ownerActor, panel.token, requestId, {
      idempotencyKey: key(),
      reason,
    });
  const createLinked = async (requestId: string, slug = 'reseller-one') => {
    const created = await api.container.hosting.create(tenantA, ownerActor, panel.token, {
      idempotencyKey: key(),
      proof: { code: code() },
      slug,
      displayName: `Bot ${slug}`,
      adminUsername: `${slug}-admin`,
      adminDisplayName: 'Reseller',
      adminPassword: HOSTED_PASSWORD,
      expiresAt: null,
      resellerBotRequestId: requestId,
    });
    return created.bot.tenantId;
  };
  /** An approved, linked subscription whose first month is paid. */
  async function subscribed(): Promise<{ requestId: string; hostedTenantId: string }> {
    await credit(reseller, FEE);
    const filed = await submit(reseller);
    await approve(filed.id);
    const hostedTenantId = await createLinked(filed.id);
    return { requestId: filed.id, hostedTenantId };
  }
  const renew = () => api.container.resellerBotFees.runOnce(tenantA);
  /** After a jump of weeks: sign in again and reopen the creator panel's section. */
  async function reopen() {
    ownerActor = await signIn(owner);
    const opened = await api.container.hostingSection.openSession(tenantA, ownerActor, {
      proof: { code: code() },
    });
    panel.token = opened.opened.token;
  }

  beforeAll(async () => {
    telegram = await startFakeTelegramBotApi();
    const config = testConfig({
      WEB_ADMIN_ORIGINS: ORIGIN,
      HOSTED_BOTS_CREATE_ENABLED: 'true',
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_API_BASE_URL: telegram.url,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config, { hostedNetwork: { dns, tls } });
    const clock = api.container.clock as { now: () => Date };
    const base = Math.floor(Date.now() / 30_000) * 30_000 + 10_000;
    clock.now = () => new Date(base + offsetMs);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await telegram?.close();
  });

  beforeEach(async () => {
    offsetMs = 0;
    dnsNow.clear();
    tlsReady.clear();
    await resetDatabase(db());
    await seed(db(), api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    owner = await createAdmin(api.container, tenantA, {
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
    panel = { secret: enrolment.secret, token: '' };
    const activated = await api.container.hostingSection.activate(tenantA, ownerActor, {
      code: code(),
    });
    panel.token = activated.opened.token;
    reseller = await customer('9001');
    otherReseller = await customer('9002');
    plainCustomer = await customer('9003');
    await makeReseller(reseller);
    await makeReseller(otherReseller);
    await setFee(FEE);
    botToken = telegram.createBot({ id: 7_200_000_001, username: 'reseller_one_bot' });
  });

  it('pages through the authenticated owner HTTP endpoint and approves/creates from a later page', async () => {
    const filed = await submit(reseller);
    offsetMs += 1_000;
    const newer = await submit(otherReseller, {
      botToken: telegram.createBot({ id: 7_200_000_002, username: 'second_reseller_bot' }),
    });
    await bots().cancel(tenantA, panelActor, {
      customerId: otherReseller,
      requestId: newer.id,
      idempotencyKey: key(),
    });
    const inject = (query: string, section = true) =>
      api.app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'GET',
          url: `${API_PREFIX}/hosting/reseller-bot-requests${query}`,
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=${ownerSessionToken}${section ? `; ${HOSTING_SESSION_COOKIE_NAME}=${panel.token}` : ''}`,
          },
        });
    const denied = await inject('?limit=1', false);
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toMatchObject({
      error: { code: HOSTING_ERROR_CODES.SECTION_SESSION_REQUIRED },
    });
    const first = await inject('?limit=1');
    expect(first.statusCode, first.body).toBe(200);
    const page = first.json() as ResellerBotRequestsAdminResponse;
    expect(page.requests.map((row) => row.id)).toEqual([newer.id]);
    const second = await inject(`?limit=1&cursor=${page.nextCursor}`);
    const older = second.json() as ResellerBotRequestsAdminResponse;
    expect(older.requests.map((row) => row.id)).toEqual([filed.id]);
    expect(older.nextCursor).toBeNull();
    await credit(reseller, FEE);
    await approve(older.requests[0]!.id);
    const hosted = await createLinked(older.requests[0]!.id);
    expect(
      (
        await bots().adminList(tenantA, ownerActor, panel.token, {
          limit: 1,
          cursor: page.nextCursor,
        })
      ).requests[0],
    ).toMatchObject({ id: filed.id, state: 'APPROVED', hostedTenantId: hosted });
    expect((await inject('?limit=201')).statusCode).toBe(400);
    expect((await inject('?cursor=invalid')).statusCode).toBe(400);
  });

  describe('the offer and the request', () => {
    it('is not offered while the fee is zero, and only an active reseller may ask', async () => {
      await setFee(0n);
      expect((await bots().offer(tenantA, reseller)).offered).toBe(false);
      expect(await codeOf(submit(reseller))).toBe(CODES.NOT_OFFERED);
      await setFee(FEE);
      const offer = await bots().offer(tenantA, reseller);
      expect(offer).toMatchObject({
        offered: true,
        fee: { amountMinor: FEE.toString(), currency: 'IRT' },
        graceDays: 3,
        canRequest: true,
      });
      expect(await codeOf(submit(plainCustomer))).toBe(CODES.NOT_RESELLER);
      // A hosted tenant is not the installation: nothing is offered there.
      expect((await bots().offer(tenantB, reseller)).offered).toBe(false);
    });

    it('validates the token with getMe, seals it, shows it masked, and replays', async () => {
      const idempotencyKey = key();
      const filed = await submit(reseller, { idempotencyKey });
      expect(filed).toMatchObject({ state: 'PENDING', botUsername: 'reseller_one_bot' });
      expect(filed.tokenMasked).not.toContain(botToken);
      expect(telegram.calls.some((call) => call.method === 'getMe')).toBe(true);
      const row = await requestRow(filed.id);
      expect(row?.tokenCiphertext).not.toContain(botToken);
      expect(row?.feeAmountMinor).toBe(FEE);
      const again = await submit(reseller, { idempotencyKey });
      expect(again.id).toBe(filed.id);
      // One open request at a time.
      expect(await codeOf(submit(reseller))).toBe(CODES.REQUEST_OPEN);
      expect(await codeOf(submit(reseller, { botToken: 'not-a-token' }))).toBe(
        CODES.TOKEN_MALFORMED,
      );
    });

    it('refuses a token Telegram rejects, storing nothing', async () => {
      expect(
        await codeOf(submit(reseller, { botToken: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAA' })),
      ).toBe(CODES.TOKEN_REJECTED);
      expect(await db().select().from(resellerBotRequests)).toHaveLength(0);
    });
  });

  describe('approval debits the first month from the wallet', () => {
    it('debits once; a replay is idempotent; a second approval is refused', async () => {
      await credit(reseller, 1_000_000n);
      const filed = await submit(reseller);
      const idempotencyKey = key();
      const first = await approve(filed.id, idempotencyKey);
      expect(first.replayed).toBe(false);
      expect(first.request.state).toBe('APPROVED');
      const replay = await approve(filed.id, idempotencyKey);
      expect(replay.replayed).toBe(true);
      expect(await codeOf(approve(filed.id))).toBe(CODES.STATE_CONFLICT);

      const debits = await feeDebits();
      expect(debits).toHaveLength(1);
      expect(debits[0]).toMatchObject({
        direction: 'DEBIT',
        amount: FEE,
        reference: `hosted-bot-fee:${filed.id}:1`,
      });
      expect(await balanceOf(reseller)).toBe(500_000n);
      const charges = await db().select().from(resellerBotFeeCharges);
      expect(charges.map((one) => [one.period, one.kind])).toEqual([[1, 'APPROVAL']]);
      const audit = await db()
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'hosting.reseller_bot.approve'));
      expect(audit).toHaveLength(1);
      const { rows } = await db().execute(
        sql`SELECT count(*)::int AS n FROM operational_events WHERE code = 'hosting.reseller_bot.approved'`,
      );
      expect((rows[0] as { n: number }).n).toBe(1);
    });

    it('a short wallet refuses the approval and writes nothing (no credit, never negative)', async () => {
      await credit(reseller, FEE - 1n);
      const filed = await submit(reseller);
      expect(await codeOf(approve(filed.id))).toBe(CODES.INSUFFICIENT_FUNDS);
      expect((await requestRow(filed.id))?.status).toBe('PENDING');
      expect(await feeDebits()).toHaveLength(0);
      expect(await db().select().from(resellerBotFeeCharges)).toHaveLength(0);
      expect(await balanceOf(reseller)).toBe(FEE - 1n);
      // Topped up, the same request is approved.
      await credit(reseller, 1n);
      await approve(filed.id);
      expect(await balanceOf(reseller)).toBe(0n);
    });

    it('needs the owner’s fresh code and open section', async () => {
      await credit(reseller, FEE);
      const filed = await submit(reseller);
      expect(
        await codeOf(
          bots().approve(tenantA, ownerActor, null, filed.id, {
            idempotencyKey: key(),
            proof: { code: '000000' },
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.SECTION_SESSION_REQUIRED);
      expect(await feeDebits()).toHaveLength(0);
    });
  });

  describe('reject and cancel charge nothing', () => {
    it('reject needs a 3–500 character reason and moves no money', async () => {
      await credit(reseller, FEE);
      const filed = await submit(reseller);
      await expect(reject(filed.id, 'no')).rejects.toThrow();
      const rejected = await reject(filed.id, 'دامنه مناسب نیست');
      expect(rejected.request).toMatchObject({
        state: 'REJECTED',
        rejectReason: 'دامنه مناسب نیست',
      });
      expect(await codeOf(approve(filed.id))).toBe(CODES.STATE_CONFLICT);
      expect(await feeDebits()).toHaveLength(0);
      expect(await balanceOf(reseller)).toBe(FEE);
    });

    it('the reseller cancels while pending; the owner cannot approve it afterwards', async () => {
      await credit(reseller, FEE);
      const filed = await submit(reseller);
      const cancelled = await bots().cancel(tenantA, panelActor, {
        customerId: reseller,
        requestId: filed.id,
        idempotencyKey: key(),
      });
      expect(cancelled.state).toBe('CANCELLED');
      expect(await codeOf(approve(filed.id))).toBe(CODES.STATE_CONFLICT);
      expect(
        await codeOf(
          bots().cancel(tenantA, panelActor, {
            customerId: reseller,
            requestId: filed.id,
            idempotencyKey: key(),
          }),
        ),
      ).toBe(CODES.STATE_CONFLICT);
      expect(await feeDebits()).toHaveLength(0);
      // The timeline says so.
      const [mine] = await bots().listOwn(tenantA, reseller);
      expect(mine?.timeline.map((entry) => entry.event)).toEqual(['SUBMITTED', 'CANCELLED']);
    });
  });

  describe('ownership', () => {
    it('another reseller can neither see, cancel nor pay the request', async () => {
      await credit(reseller, FEE);
      const filed = await submit(reseller);
      expect(await bots().listOwn(tenantA, otherReseller)).toEqual([]);
      expect((await bots().listOwn(tenantA, reseller)).map((one) => one.id)).toEqual([filed.id]);
      expect(
        await codeOf(
          bots().cancel(tenantA, panelActor, {
            customerId: otherReseller,
            requestId: filed.id,
            idempotencyKey: key(),
          }),
        ),
      ).toBe(CODES.REQUEST_NOT_FOUND);
      await approve(filed.id);
      await credit(otherReseller, FEE * 3n);
      expect(
        await codeOf(
          bots().payAndReactivate(tenantA, panelActor, {
            customerId: otherReseller,
            requestId: filed.id,
            idempotencyKey: key(),
          }),
        ),
      ).toBe(CODES.REQUEST_NOT_FOUND);
      expect((await requestRow(filed.id))?.status).toBe('APPROVED');
      expect(await balanceOf(otherReseller)).toBe(FEE * 3n);
    });
  });

  describe('the monthly renewal', () => {
    it('debits once per period, whatever the number of runs', async () => {
      const { requestId } = await subscribed();
      await credit(reseller, FEE * 2n);
      expect((await renew()).charged).toBe(0);
      offsetMs += MONTH_MS;
      expect((await renew()).charged).toBe(1);
      expect((await renew()).charged).toBe(0);
      offsetMs += MONTH_MS;
      expect((await renew()).charged).toBe(1);
      await renew();
      const debits = await feeDebits(requestId);
      expect(debits.map((one) => one.reference).sort()).toEqual([
        `hosted-bot-fee:${requestId}:1`,
        `hosted-bot-fee:${requestId}:2`,
        `hosted-bot-fee:${requestId}:3`,
      ]);
      expect(await balanceOf(reseller)).toBe(0n);
      expect((await requestRow(requestId))?.lastPeriod).toBe(3);
    });

    it('two runs racing one period debit it once', async () => {
      const { requestId } = await subscribed();
      await credit(reseller, FEE * 2n);
      offsetMs += MONTH_MS;
      await Promise.all([renew(), renew()]);
      expect(await feeDebits(requestId)).toHaveLength(2);
      expect(await balanceOf(reseller)).toBe(FEE);
    });

    it('a short wallet is told once a day in the grace days, then the bot is stopped (data kept)', async () => {
      const { requestId, hostedTenantId } = await subscribed();
      offsetMs += MONTH_MS;
      expect((await renew()).noticed).toBe(1);
      expect((await renew()).noticed).toBe(0);
      offsetMs += DAY_MS;
      expect((await renew()).noticed).toBe(1);
      const notices = await db().select().from(resellerBotFeeNotices);
      expect(notices).toHaveLength(2);
      const queued = await db()
        .select()
        .from(customerNotifications)
        .where(eq(customerNotifications.kind, 'HOSTED_BOT_FEE_SHORT'));
      expect(queued).toHaveLength(2);
      expect((await hostedRow(hostedTenantId))?.state).toBe('ACTIVE');

      offsetMs += 3 * DAY_MS;
      expect((await renew()).stopped).toBe(1);
      expect((await hostedRow(hostedTenantId))?.state).toBe('EXPIRED');
      expect((await tenantRow(hostedTenantId))?.status).toBe('STOPPED');
      expect((await requestRow(requestId))?.feeStoppedAt).not.toBeNull();
      // Stopped, not deleted; and a further run neither stops again nor notices.
      expect(await renew()).toEqual({ charged: 0, noticed: 0, stopped: 0, resumed: 0 });
      expect(await feeDebits(requestId)).toHaveLength(1);
      expect(await balanceOf(reseller)).toBe(0n);
      const stops = await db()
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'hosting.reseller_bot.stop'));
      expect(stops).toHaveLength(1);
      const [mine] = await bots().listOwn(tenantA, reseller);
      expect(mine?.billing.state).toBe('STOPPED');
    });

    it('a top-up resumes the stopped bot on the next run, for a whole month from then', async () => {
      const { requestId, hostedTenantId } = await subscribed();
      offsetMs += MONTH_MS + 4 * DAY_MS;
      await renew();
      expect((await hostedRow(hostedTenantId))?.state).toBe('EXPIRED');
      await credit(reseller, FEE);
      const report = await renew();
      expect(report).toMatchObject({ charged: 1, resumed: 1 });
      expect((await hostedRow(hostedTenantId))?.state).toBe('ACTIVE');
      expect((await tenantRow(hostedTenantId))?.status).toBe('ACTIVE');
      const row = await requestRow(requestId);
      expect(row?.feeStoppedAt).toBeNull();
      expect(row?.paidThrough?.getTime()).toBeGreaterThan(now().getTime() + 27 * DAY_MS);
      const { rows } = await db().execute(
        sql`SELECT count(*)::int AS n FROM operational_events WHERE code = 'hosting.reseller_bot.resumed'`,
      );
      expect((rows[0] as { n: number }).n).toBe(1);
      const [mine] = await bots().listOwn(tenantA, reseller);
      expect(mine?.timeline.map((entry) => entry.event)).toContain('RESUMED');
    });

    it('«پرداخت و فعال‌سازی دوباره» resumes at once; refused when short or nothing is due', async () => {
      const { requestId, hostedTenantId } = await subscribed();
      const pay = () =>
        bots().payAndReactivate(tenantA, panelActor, {
          customerId: reseller,
          requestId,
          idempotencyKey: key(),
        });
      expect(await codeOf(pay())).toBe(CODES.NOTHING_DUE);
      offsetMs += MONTH_MS + 4 * DAY_MS;
      await renew();
      expect((await hostedRow(hostedTenantId))?.state).toBe('EXPIRED');
      expect(await codeOf(pay())).toBe(CODES.INSUFFICIENT_FUNDS);
      expect(await feeDebits(requestId)).toHaveLength(1);
      await credit(reseller, FEE);
      const paid = await pay();
      expect(paid.billing.state).toBe('PAID');
      expect((await hostedRow(hostedTenantId))?.state).toBe('ACTIVE');
      expect(await feeDebits(requestId)).toHaveLength(2);
      expect(await codeOf(pay())).toBe(CODES.NOTHING_DUE);
      expect(await balanceOf(reseller)).toBe(0n);
    });

    it('a full page of subscriptions it cannot settle does not starve a newer due one', async () => {
      // Codex on #470: the pass read ONE page of the oldest due rows, and a row it leaves as it
      // was (short and waiting, or a bot the owner suspended) keeps its paid-through; a page of
      // those came back on every pass. The page is shrunk to 1 so one stuck row fills it.
      const fees = new ResellerBotFeeService({
        ...(Reflect.get(api.container.resellerBotFees, 'deps') as ResellerBotFeeDeps),
        batch: 1,
      });
      const stuck = await subscribed();
      await api.container.hosting.suspend(tenantA, ownerActor, panel.token, stuck.hostedTenantId, {
        idempotencyKey: key(),
        proof: { code: code() },
      });
      await credit(otherReseller, FEE);
      const newer = await submit(otherReseller, {
        botToken: telegram.createBot({ id: 7_200_000_002, username: 'reseller_two_bot' }),
      });
      await approve(newer.id);
      await createLinked(newer.id, 'reseller-two');
      const stuckDue = (await requestRow(stuck.requestId))?.paidThrough?.getTime() ?? 0;
      expect((await requestRow(newer.id))?.paidThrough?.getTime()).toBeGreaterThan(stuckDue);

      offsetMs += MONTH_MS;
      await credit(otherReseller, FEE);
      expect((await fees.runOnce(tenantA)).charged).toBe(1);
      expect(await feeDebits(newer.id)).toHaveLength(2);
      expect(await feeDebits(stuck.requestId)).toHaveLength(1);
      expect(await balanceOf(otherReseller)).toBe(0n);
      // The next pass pages over the stuck row again and charges nothing twice.
      expect((await fees.runOnce(tenantA)).charged).toBe(0);
      expect(await feeDebits(newer.id)).toHaveLength(2);
    });

    it('never bills an unlinked approval, or a bot the owner suspended', async () => {
      await credit(reseller, FEE * 3n);
      const filed = await submit(reseller);
      await approve(filed.id);
      offsetMs += MONTH_MS;
      await renew();
      expect(await feeDebits(filed.id)).toHaveLength(1);
      await reopen();
      const hostedTenantId = await createLinked(filed.id);
      await api.container.hosting.suspend(tenantA, ownerActor, panel.token, hostedTenantId, {
        idempotencyKey: key(),
        proof: { code: code() },
      });
      offsetMs += MONTH_MS;
      await renew();
      expect(await feeDebits(filed.id)).toHaveLength(1);
    });
  });

  describe('the activation link', () => {
    it('reaches the reseller in Telegram and is never stored in clear', async () => {
      const { requestId, hostedTenantId } = await subscribed();
      await bots().configureActivation(tenantA, ownerActor, panel.token, requestId, {
        idempotencyKey: key(),
        proof: { code: code() },
        domain: DOMAIN,
      });
      const run = (step: string) =>
        api.container.hostedActivation.runStep(
          tenantA,
          ownerActor,
          panel.token,
          hostedTenantId,
          step,
          {
            idempotencyKey: key(),
          },
        );
      dnsNow.set(DOMAIN, { cname: ['admin.hosting.test'], addresses: [SERVER_IP] });
      await run('domain');
      tlsReady.add(DOMAIN);
      await run('ssl');
      await run('webhook');
      const issued = await api.container.hostedActivation.issueLink(
        tenantA,
        ownerActor,
        panel.token,
        hostedTenantId,
        { idempotencyKey: key(), proof: { code: code() } },
      );
      const url = issued.activationUrl as string;
      const secret = /#token=(.+)$/.exec(url)?.[1] as string;
      expect(secret.length).toBeGreaterThan(20);

      // The lane, with the real readers and a messenger that records.
      const sends: CustomerMessage[] = [];
      const people = new DrizzleCustomerRepository(db());
      const lane = new CustomerNotificationService({
        notifications: api.container.customerNotifications,
        refundFigures: new DrizzleWalletRepository(db()),
        paymentCredits: new DrizzleWalletRepository(db()),
        rejectionReasons: new DrizzlePaymentRepository(db()),
        reminderSnapshots: new DrizzleServiceReminderSnapshotReader(db()),
        contacts: {
          contactFor: async (scope, customerId, tx) => {
            const found = await people.findById(scope, customerId, tx);
            return found === null
              ? { kind: 'NONE' }
              : { kind: 'CONTACT', contact: { chatId: found.telegramUserId } };
          },
        },
        subjects: { stillHolds: async () => true },
        messenger: {
          send: async (_scope, message) => {
            sends.push(message);
            return { outcome: 'DELIVERED' };
          },
          acknowledge: async () => undefined,
          sendFile: async () => ({ outcome: 'REFUSED' }),
        },
        resellerBots: api.container.resellerBots,
        centreText: {
          render: (scope, templateKey, values) =>
            api.container.templateResolver.render(scope, templateKey, values),
        },
        uow: api.container.uow,
        clock: api.container.clock,
        scopeIsActive: async () => true,
        logger: { info: () => {}, error: () => {} },
      });
      await lane.deliverDue(tenantA, 50);
      const sent = sends.find((one) => one.templateKey === 'bot.hosted_bot.activation_link');
      expect(sent?.values).toMatchObject({ bot: 'reseller_one_bot', url });

      const [row] = await db()
        .select()
        .from(customerNotifications)
        .where(eq(customerNotifications.kind, 'HOSTED_BOT_ACTIVATION_LINK'));
      expect(row?.state).toBe('DELIVERED');
      expect(row?.renderedText).toBeNull();
      // Nowhere at rest: the sealed column is ciphertext; no row of these tables carries it.
      for (const table of [
        'customer_notifications',
        'audit_logs',
        'outbox_messages',
        'operational_events',
        'reseller_bot_requests',
        'hosted_bot_activation_links',
      ]) {
        const { rows } = await db().execute(
          sql.raw(`SELECT count(*)::int AS n FROM ${table} t WHERE t::text LIKE '%${secret}%'`),
        );
        expect((rows[0] as { n: number }).n, table).toBe(0);
      }
      const [mine] = await bots().listOwn(tenantA, reseller);
      expect(mine?.timeline.map((entry) => entry.event)).toContain('LINK_SENT');
    });
  });
});
