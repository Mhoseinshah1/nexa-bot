import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_PREFIX,
  DEFAULT_PRODUCT_CATEGORY_NAME,
  EMPTY_PRODUCT_DISPLAY,
  PAYMENT_GATEWAY_PROVIDERS,
  uuidV7Schema,
  money,
  BACKUP_SCHEDULE_SETTING_KEYS,
  HOSTING_CODE_LOCKOUT_SECONDS,
  HOSTING_ERROR_CODES,
  HOSTING_SECTION_SESSION_TTL_SECONDS,
  IDENTITY_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  TELEGRAM_SECRET_TOKEN_HEADER,
  isNexaError,
  systemJobActor,
  type ActorContext,
  type CorrelationId,
  type PanelId,
  type TenantContext,
} from '@nexa/contracts';
import type { ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  adminPermissionOverrides,
  admins,
  auditLogs,
  botInstances,
  hostedBotActivations,
  hostedBots,
  hostingTotpFactors,
  operationalEvents,
  outboxMessages,
  paymentGateways,
  paymentGatewayCredentials,
  productCategories,
  settingValues,
  tenants,
} from '../../apps/api/src/infrastructure/persistence/schema';
import {
  totpForStep,
  totpStepAt,
} from '../../apps/api/src/modules/platform/identity/application/totp';
import {
  createAdmin,
  createApiApp,
  migrateOnce,
  makePanelSellable,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
  type SeededAdmin,
} from './harness';

const ORIGIN = 'https://admin.hosting.test';
const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-hosting';
const OWNER_PASSWORD = 'the-owners-own-password';
const HOSTED_PASSWORD = 'the-hosted-owners-password';

/**
 * Phase 6A PR-3 (D1) — the creator panel against the real app and a real database: the
 * owner-only guard, the section's own second factor and 12-hour session, the fresh code on
 * every sensitive action, every action, the expiry sweep, and that a stopped hosted bot is
 * really stopped (write paths, webhook, Web Admin sign-in and sessions).
 *
 * The app connects as `nexa_app` (ADR-0037, the harness's `createApiApp`), so every statement
 * the panel makes is bound by row-level security; the fixtures and the cross-tenant reads
 * back are the owner's handle (`container.database`).
 *
 * The clock is the container's own, FROZEN in the middle of a TOTP step and moved only by
 * the cases (it once followed the wall clock, so "the step in force now" could land a step
 * after the code was issued when a boundary fell in between: the flake on #443). Every code is a fresh
 * 30-second step (the replay rule refuses a step twice), and the 12-hour expiry and the
 * 15-minute lock are crossed by moving it.
 */
describe('creator panel «میزبانی‌ها» (phase 6A PR-3)', () => {
  let api: ApiApp;
  let offsetMs = 0;
  /** The frozen instant (the middle of a TOTP step); only `offsetMs` moves the clock. */
  let baseMs = 0;
  let keys = 0;
  let owner: SeededAdmin;
  let ownerActor: ActorContext;
  let operatorActor: ActorContext;
  let hostedOwnerActor: ActorContext;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const key = () => `hosting-key-${String((keys += 1))}`;
  const now = () => api.container.clock.now();
  /** The code `code()` issued last: the one a step spent. */
  let lastCode = '';
  /** A code for a step no earlier code used. */
  const code = (secret: string) => {
    offsetMs += 30_000;
    lastCode = totpForStep(secret, totpStepAt(now()));
    return lastCode;
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

  async function signIn(
    admin: SeededAdmin,
    scope: TenantContext = tenantA,
  ): Promise<{ actor: ActorContext; token: string }> {
    const result = await api.container.auth.login(
      scope,
      { type: 'API', id: null, label: null, surface: 'WEB', correlationId: 'c' as CorrelationId },
      { username: admin.username, password: admin.password },
      { ip: null, userAgent: null },
    );
    return {
      token: result.token,
      actor: {
        type: 'WEB_ADMIN',
        id: admin.id,
        label: admin.username,
        surface: 'WEB',
        correlationId: 'test-correlation' as CorrelationId,
        sessionId: result.session.id,
      },
    };
  }

  /** Enrols and activates the section factor: answers its secret, codes and section token. */
  async function openPanel(actor: ActorContext = ownerActor) {
    const enrolment = await api.container.hostingSection.enrol(
      tenantA,
      actor,
      { password: OWNER_PASSWORD },
      { ip: null },
    );
    const activated = await api.container.hostingSection.activate(tenantA, actor, {
      code: code(enrolment.secret),
    });
    return {
      secret: enrolment.secret,
      recoveryCodes: activated.recoveryCodes,
      token: activated.opened.token,
    };
  }

  async function createBot(
    panel: { secret: string; token: string },
    slug = 'hosted-one',
    extra: Record<string, unknown> = {},
  ) {
    return api.container.hosting.create(tenantA, ownerActor, panel.token, {
      idempotencyKey: key(),
      proof: { code: code(panel.secret) },
      slug,
      displayName: `Bot ${slug}`,
      adminUsername: `${slug}-admin`,
      adminDisplayName: 'Hosted owner',
      adminPassword: HOSTED_PASSWORD,
      expiresAt: null,
      ...extra,
    });
  }

  const tenantRow = async (id: string) =>
    (await api.container.database.db.select().from(tenants).where(eq(tenants.id, id)))[0];

  beforeAll(async () => {
    const config = testConfig({
      WEB_ADMIN_ORIGINS: ORIGIN,
      HOSTED_BOTS_CREATE_ENABLED: 'true',
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
    const clock = api.container.clock as { now: () => Date };
    // Frozen in the middle of a step: nothing moves with the wall clock.
    baseMs = Math.floor(Date.now() / 30_000) * 30_000 + 10_000;
    clock.now = () => new Date(baseMs + offsetMs);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    offsetMs = 0;
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    owner = await createAdmin(api.container, tenantA, {
      username: 'panel-owner',
      password: OWNER_PASSWORD,
      roleKeys: ['owner'],
    });
    ownerActor = (await signIn(owner)).actor;
    // An installation operator handed the key itself through a GRANT override.
    const operator = await createAdmin(api.container, tenantA, {
      username: 'panel-operator',
      roleKeys: ['operator'],
    });
    await api.container.database.db.insert(adminPermissionOverrides).values({
      tenantId: tenantA.tenantId,
      adminId: operator.id,
      permissionKey: 'hosting.manage',
      effect: 'GRANT',
      reason: 'test: a delegated key must not open the owner’s section',
    });
    operatorActor = (await signIn(operator)).actor;
    // Another tenant's owner: holds EVERY key, hosting.manage included, in their tenant.
    const other = await createAdmin(api.container, tenantB, {
      username: 'other-owner',
      roleKeys: ['owner'],
    });
    hostedOwnerActor = (await signIn(other, tenantB)).actor;
  });

  describe('the owner-only guard', () => {
    it('refuses another tenant’s owner, a non-owner installation admin and a job — audited', async () => {
      const panel = await openPanel();
      for (const [actor, scope] of [
        [hostedOwnerActor, tenantB],
        [operatorActor, tenantA],
        [systemJobActor('probe', 'c' as CorrelationId), tenantA],
      ] as const) {
        expect(await codeOf(api.container.hostingSection.status(scope, actor, null))).toBe(
          HOSTING_ERROR_CODES.OWNER_ONLY,
        );
        // Even with the owner's own section token, nothing opens.
        expect(await codeOf(api.container.hosting.list(scope, actor, panel.token))).toBe(
          HOSTING_ERROR_CODES.OWNER_ONLY,
        );
        expect(
          await codeOf(
            api.container.hostingSection.enrol(scope, actor, { password: 'x' }, { ip: null }),
          ),
        ).toBe(HOSTING_ERROR_CODES.OWNER_ONLY);
      }
      // A hosted owner aiming at the installation scope is refused as well (by the guard:
      // they are no administrator there at all).
      await expect(
        api.container.hosting.list(tenantA, hostedOwnerActor, panel.token),
      ).rejects.toMatchObject({
        kind: 'PERMISSION_DENIED',
      });
      const denied = await api.container.database.db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, 'hosting.list'), eq(auditLogs.result, 'DENIED')));
      expect(denied.length).toBe(4);
      // The owner himself is let in.
      expect((await api.container.hosting.list(tenantA, ownerActor, panel.token)).bots).toEqual([]);
    });
  });

  describe('the section’s second factor', () => {
    it('enrols with the password, seals the secret, activates with a code and opens the section', async () => {
      expect(
        await codeOf(
          api.container.hostingSection.enrol(
            tenantA,
            ownerActor,
            { password: 'wrong-password!!' },
            { ip: null },
          ),
        ),
      ).not.toBe('');
      const enrolment = await api.container.hostingSection.enrol(
        tenantA,
        ownerActor,
        { password: OWNER_PASSWORD },
        { ip: null },
      );
      expect(enrolment.otpauthUri).toMatch(/^otpauth:\/\/totp\/Nexa%20Hosting:panel-owner\?/);
      expect(enrolment.qrPngDataUrl).toMatch(/^data:image\/png;base64,/);
      const [stored] = await api.container.database.db.select().from(hostingTotpFactors);
      expect(stored?.totpSecretCiphertext).not.toContain(enrolment.secret);
      expect(stored?.state).toBe('PENDING');

      expect(
        await codeOf(
          api.container.hostingSection.activate(tenantA, ownerActor, { code: '000000' }),
        ),
      ).toBe(HOSTING_ERROR_CODES.CODE_REJECTED);
      const activated = await api.container.hostingSection.activate(tenantA, ownerActor, {
        code: code(enrolment.secret),
      });
      expect(activated.recoveryCodes).toHaveLength(10);
      const status = await api.container.hostingSection.status(
        tenantA,
        ownerActor,
        activated.opened.token,
      );
      expect(status.factor).toBe('ACTIVE');
      expect(status.recoveryCodesRemaining).toBe(10);
      expect(status.session).not.toBeNull();
      // Enrolling again while active is refused.
      expect(
        await codeOf(
          api.container.hostingSection.enrol(
            tenantA,
            ownerActor,
            { password: OWNER_PASSWORD },
            { ip: null },
          ),
        ),
      ).toBe(HOSTING_ERROR_CODES.SECOND_FACTOR_ACTIVE);
    });

    it('a pending enrolment can be finished only from the Web Admin session that saw it', async () => {
      const enrolment = await api.container.hostingSection.enrol(
        tenantA,
        ownerActor,
        { password: OWNER_PASSWORD },
        { ip: null },
      );
      const elsewhere = (await signIn(owner)).actor;
      expect(
        await codeOf(
          api.container.hostingSection.activate(tenantA, elsewhere, {
            code: code(enrolment.secret),
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.ENROLMENT_EXPIRED);
    });

    it('the section session lasts 12 hours by the Clock and is bound to its Web Admin session', async () => {
      const panel = await openPanel();
      expect(await codeOf(api.container.hosting.list(tenantA, ownerActor, null))).toBe(
        HOSTING_ERROR_CODES.SECTION_SESSION_REQUIRED,
      );
      // The same section cookie presented from another sign-in of the same owner opens nothing.
      const elsewhere = (await signIn(owner)).actor;
      expect(await codeOf(api.container.hosting.list(tenantA, elsewhere, panel.token))).toBe(
        HOSTING_ERROR_CODES.SECTION_SESSION_REQUIRED,
      );
      offsetMs += (HOSTING_SECTION_SESSION_TTL_SECONDS - 60) * 1000;
      await api.container.hosting.list(tenantA, ownerActor, panel.token);
      offsetMs += 61 * 1000;
      expect(await codeOf(api.container.hosting.list(tenantA, ownerActor, panel.token))).toBe(
        HOSTING_ERROR_CODES.SECTION_SESSION_REQUIRED,
      );
    });

    it('a recovery code opens the section once; regenerating kills the old set', async () => {
      const panel = await openPanel();
      const first = panel.recoveryCodes[0] as string;
      const opened = await api.container.hostingSection.openSession(tenantA, ownerActor, {
        proof: { backupCode: first },
      });
      await api.container.hosting.list(tenantA, ownerActor, opened.opened.token);
      expect(
        await codeOf(
          api.container.hostingSection.openSession(tenantA, ownerActor, {
            proof: { backupCode: first },
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.CODE_REJECTED);
      const fresh = await api.container.hostingSection.regenerateRecoveryCodes(
        tenantA,
        ownerActor,
        opened.opened.token,
        { proof: { code: code(panel.secret) } },
      );
      expect(fresh.recoveryCodes).toHaveLength(10);
      expect(
        await codeOf(
          api.container.hostingSection.openSession(tenantA, ownerActor, {
            proof: { backupCode: panel.recoveryCodes[1] as string },
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.CODE_REJECTED);
      await api.container.hostingSection.openSession(tenantA, ownerActor, {
        proof: { backupCode: fresh.recoveryCodes[0] as string },
      });
      // The Web Admin sign-in factor's codes and the section's are different sets: a section
      // code never verifies as anything else, and status counts the section's own.
      const status = await api.container.hostingSection.status(tenantA, ownerActor, null);
      expect(status.recoveryCodesRemaining).toBe(9);
    });

    it('five wrong codes lock the section’s codes for 15 minutes, even a right one; then it resets', async () => {
      const panel = await openPanel();
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        expect(
          await codeOf(
            api.container.hostingSection.openSession(tenantA, ownerActor, {
              proof: { code: '123456' },
            }),
          ),
        ).toBe(HOSTING_ERROR_CODES.CODE_REJECTED);
      }
      expect(
        await codeOf(
          api.container.hostingSection.openSession(tenantA, ownerActor, {
            proof: { code: '123456' },
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.CODE_ATTEMPTS_LOCKED);
      // Locked: a correct code and an unused recovery code are refused too.
      expect(
        await codeOf(
          api.container.hostingSection.openSession(tenantA, ownerActor, {
            proof: { code: code(panel.secret) },
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.CODE_ATTEMPTS_LOCKED);
      expect(
        await codeOf(
          api.container.hostingSection.openSession(tenantA, ownerActor, {
            proof: { backupCode: panel.recoveryCodes[0] as string },
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.CODE_ATTEMPTS_LOCKED);
      const status = await api.container.hostingSection.status(tenantA, ownerActor, null);
      expect(status.lockedUntil).not.toBeNull();

      offsetMs += HOSTING_CODE_LOCKOUT_SECONDS * 1000;
      await api.container.hostingSection.openSession(tenantA, ownerActor, {
        proof: { code: code(panel.secret) },
      });
      const [factor] = await api.container.database.db.select().from(hostingTotpFactors);
      expect(factor?.failedAttempts).toBe(0);
      expect(factor?.lockedUntil).toBeNull();
      const failed = await api.container.database.db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, 'hosting.session_open'), eq(auditLogs.result, 'FAILED')));
      expect(failed.length).toBe(7);
    });
  });

  describe('sensitive actions re-ask for a fresh code', () => {
    it('refuses an action with no code, a wrong code, or the code already used — and changes nothing', async () => {
      const panel = await openPanel();
      const created = await createBot(panel);
      const id = created.bot.tenantId;
      const suspend = (proof: unknown) =>
        api.container.hosting.suspend(tenantA, ownerActor, panel.token, id, {
          idempotencyKey: key(),
          proof,
        });
      await expect(suspend(undefined)).rejects.toThrow();
      // A code that is NOT valid for any step the skew window accepts (000000 could be, 1 in
      // 333,000 runs).
      const window = [-2, -1, 0, 1, 2].map((d) => totpForStep(panel.secret, totpStepAt(now()) + d));
      const wrong = ['000000', '111111', '222222'].find((c) => !window.includes(c))!;
      expect(await codeOf(suspend({ code: wrong }))).toBe(HOSTING_ERROR_CODES.CODE_REJECTED);
      // The step the creation itself spent: the code it was given, not "the code of the step
      // in force now" (which is a different, still-acceptable step if a boundary was crossed).
      const spent = lastCode;
      expect(await codeOf(suspend({ code: spent }))).toBe(HOSTING_ERROR_CODES.CODE_REJECTED);
      expect((await tenantRow(id))?.status).toBe('ACTIVE');
      // An open section is not a code: a fresh one is still required, and then it works.
      await suspend({ code: code(panel.secret) });
      expect((await tenantRow(id))?.status).toBe('STOPPED');
    });
  });

  describe('the TOTP step boundary', () => {
    it('a spent code stays refused when the clock crosses into the next step, and the next step’s code is fresh', async () => {
      const panel = await openPanel();
      const created = await createBot(panel);
      const id = created.bot.tenantId;
      const suspend = (proof: unknown) =>
        api.container.hosting.suspend(tenantA, ownerActor, panel.token, id, {
          idempotencyKey: key(),
          proof,
        });
      const spentStep = totpStepAt(now());
      const spent = lastCode;
      // The last millisecond of the spent step ...
      offsetMs += 30_000 - ((baseMs + offsetMs) % 30_000) - 1;
      expect(totpStepAt(now())).toBe(spentStep);
      expect(await codeOf(suspend({ code: spent }))).toBe(HOSTING_ERROR_CODES.CODE_REJECTED);
      // ... and the first millisecond of the next one: the "code of the step in force now"
      // is a DIFFERENT code, which is fresh (this is what made the old assertion flaky); the
      // spent one is still refused.
      offsetMs += 1;
      expect(totpStepAt(now())).toBe(spentStep + 1);
      expect(await codeOf(suspend({ code: spent }))).toBe(HOSTING_ERROR_CODES.CODE_REJECTED);
      expect((await tenantRow(id))?.status).toBe('ACTIVE');
      await suspend({ code: totpForStep(panel.secret, spentStep + 1) });
      expect((await tenantRow(id))?.status).toBe('STOPPED');
    });
  });

  /**
   * SFR A5: the creator entered the bot's token again (and Telegram accepted it) NOW. The
   * real step — «فعال‌سازی» → token, over a fake Telegram — is proven in
   * hosted-activation.test.ts; here only its mark matters, the gate ACTIVATE reads.
   */
  async function tokenReentered(hostedTenantId: string): Promise<void> {
    offsetMs += 1_000; // strictly after the stop, whatever the wall clock's resolution
    const at = now();
    await api.container.database.db
      .insert(hostedBotActivations)
      .values({
        tenantId: tenantA.tenantId,
        hostedTenantId,
        tokenVerifiedAt: at,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [hostedBotActivations.tenantId, hostedBotActivations.hostedTenantId],
        set: { tokenVerifiedAt: at, updatedAt: at },
      });
  }

  describe('the actions', () => {
    it('manually provisions independent owners, isolated routes/categories and no reseller-wallet charge', async () => {
      const db = api.container.database.db;
      const panel = await openPanel();
      const primaryCredential = 'primary-hosting-fixture-key';
      await api.container.paymentGateways.setCredential(tenantA, ownerActor, {
        idempotencyKey: key(),
        provider: 'TONPAYS',
        apiKey: primaryCredential,
      });
      // A parent's sales setting and configured route are NOT defaults for a child.
      await db
        .insert(settingValues)
        .values({
          id: api.container.ids.uuid(),
          tenantId: tenantA.tenantId,
          settingKey: 'sales.currency',
          value: 'IRR',
        })
        .onConflictDoUpdate({
          target: [settingValues.tenantId, settingValues.settingKey],
          set: { value: 'IRR' },
        });
      // Manual creation must stay independent even when legacy reseller billing is offered.
      await db
        .insert(settingValues)
        .values({
          id: api.container.ids.uuid(),
          tenantId: tenantA.tenantId,
          settingKey: 'hosting.reseller_bot_monthly_fee',
          value: { amountMinor: '500000', currency: 'IRR' },
        })
        .onConflictDoUpdate({
          target: [settingValues.tenantId, settingValues.settingKey],
          set: { value: { amountMinor: '500000', currency: 'IRR' } },
        });
      await db
        .update(paymentGateways)
        .set({ instructions: 'Primary-only instructions', minAmountMinor: 123n })
        .where(
          and(
            eq(paymentGateways.tenantId, tenantA.tenantId),
            eq(paymentGateways.provider, 'TONPAYS'),
          ),
        );
      const financialRows = () =>
        db.execute(sql`
        SELECT (SELECT count(*) FROM customers) AS customers,
               (SELECT count(*) FROM resellers) AS resellers,
               (SELECT count(*) FROM wallet_entries) AS entries,
               (SELECT count(*) FROM wallet_entries WHERE reason = 'HOSTED_BOT_FEE') AS hosted_fees,
               (SELECT count(*) FROM reseller_bot_requests) AS requests`);
      const before = await financialRows();
      const expiresAt = new Date(now().getTime() + 31 * 86_400_000).toISOString();
      const first = await createBot(panel, 'independent-one', { expiresAt });
      const second = await createBot(panel, 'independent-two');
      expect(first.bot.expiresAt).toBe(expiresAt);
      expect(first.bot.customerCount).toBe(0);
      expect(second.bot.customerCount).toBe(0);
      // Running the legacy renewal job must not turn these manual bots into subscriptions.
      await api.container.resellerBotFees.runOnce(tenantA);
      expect((await financialRows()).rows).toEqual(before.rows);
      const scope = (id: string): TenantContext => ({ tenantId: id as never, botInstanceId: null });
      const a = scope(first.bot.tenantId);
      const b = scope(second.bot.tenantId);
      const login = async (tenant: TenantContext, slug: string) => {
        const [admin] = await db.select().from(admins).where(eq(admins.tenantId, tenant.tenantId));
        return signIn(
          { id: admin!.id as never, username: `${slug}-admin`, password: HOSTED_PASSWORD },
          tenant,
        );
      };
      const ownerA = (await login(a, 'independent-one')).actor;
      const ownerB = (await login(b, 'independent-two')).actor;
      for (const [tenant, actor] of [
        [a, ownerA],
        [b, ownerB],
      ] as const) {
        const routes = await api.container.paymentGateways.list(tenant, actor);
        expect(routes.currency).toBe('IRT');
        expect(routes.gateways.map((g) => g.provider).sort()).toEqual(
          [...PAYMENT_GATEWAY_PROVIDERS].sort(),
        );
        for (const route of routes.gateways) {
          expect(route).toMatchObject({
            boundsCurrency: 'IRT',
            status: route.provider === 'MANUAL_TRANSFER' ? 'ACTIVE' : 'DISABLED',
            instructions: null,
            displayName: null,
            minAmountMinor: 0n,
            providerUnitRateMinor: null,
          });
        }
        expect(
          await db
            .select()
            .from(paymentGatewayCredentials)
            .where(eq(paymentGatewayCredentials.tenantId, tenant.tenantId)),
        ).toHaveLength(0);
        expect(
          await db.select().from(settingValues).where(eq(settingValues.tenantId, tenant.tenantId)),
        ).toHaveLength(0);
        const categories = await api.container.productCategories.list(tenant, actor);
        expect(categories).toHaveLength(1);
        expect(categories[0]).toMatchObject({
          name: DEFAULT_PRODUCT_CATEGORY_NAME,
          status: 'ACTIVE',
          visibility: 'VISIBLE',
        });
      }
      const category = await api.container.productCategories.create(a, ownerA, {
        idempotencyKey: key(),
        draft: { name: 'Own catalogue', description: null, emoji: null, sortOrder: 10 },
      });
      const panelId = api.container.ids.uuid() as PanelId;
      await db.execute(sql`INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
        VALUES (${panelId}, ${a.tenantId}, 'Hosted panel', 'sanaei', 'https://hosted-panel.example.test', 'ACTIVE')`);
      await makePanelSellable(api.container, a, panelId);
      const product = await api.container.products.create(a, ownerA, {
        idempotencyKey: key(),
        draft: {
          title: 'Own product',
          description: null,
          audience: 'EVERYONE',
          sortOrder: 1,
          panelId,
          categoryId: category.id,
          specification: { durationDays: 30, trafficBytes: 1n, deviceLimit: null },
          price: money(100_000n, 'IRT'),
          display: EMPTY_PRODUCT_DISPLAY,
        },
      });
      const ownKey = 'independent-hosted-fixture-key';
      await api.container.paymentGateways.setCredential(a, ownerA, {
        idempotencyKey: key(),
        provider: 'TONPAYS',
        apiKey: ownKey,
      });
      expect((await api.container.paymentGateways.list(b, ownerB)).gateways).toHaveLength(
        PAYMENT_GATEWAY_PROVIDERS.length,
      );
      await expect(
        api.container.productCategories.get(b, ownerB, category.id),
      ).rejects.toMatchObject({ kind: 'NOT_FOUND' });
      await expect(api.container.products.get(b, ownerB, product.id)).rejects.toMatchObject({
        kind: 'NOT_FOUND',
      });
      await expect(api.container.paymentGateways.list(b, ownerA)).rejects.toMatchObject({
        kind: 'PERMISSION_DENIED',
      });
      await expect(
        api.container.paymentGateways.setCredential(b, ownerA, {
          idempotencyKey: key(),
          provider: 'TONPAYS',
          apiKey: 'unauthorized-fixture-key',
        }),
      ).rejects.toMatchObject({ kind: 'PERMISSION_DENIED' });
      expect(
        await db
          .select()
          .from(paymentGatewayCredentials)
          .where(eq(paymentGatewayCredentials.tenantId, b.tenantId)),
      ).toHaveLength(0);
      const projection = JSON.stringify(
        await api.container.paymentGateways.list(a, ownerA),
        (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      );
      expect(projection).not.toContain(ownKey);
      expect(projection).not.toContain(primaryCredential);
    });

    it('backfills only missing hosted defaults, preserving every configured row on repeated execution', async () => {
      const db = api.container.database.db;
      const panel = await openPanel();
      const a = (await createBot(panel, 'repair-empty')).bot.tenantId;
      const b = (await createBot(panel, 'repair-custom')).bot.tenantId;
      const c = (await createBot(panel, 'repair-invalid')).bot.tenantId;
      await db.insert(settingValues).values([
        { id: api.container.ids.uuid(), tenantId: a, settingKey: 'sales.currency', value: 'IRR' },
        {
          id: api.container.ids.uuid(),
          tenantId: c,
          settingKey: 'sales.currency',
          value: 'invalid-old-currency',
        },
      ]);
      await db.delete(paymentGateways).where(eq(paymentGateways.tenantId, a));
      await db.delete(paymentGateways).where(eq(paymentGateways.tenantId, c));
      await db.delete(productCategories).where(eq(productCategories.tenantId, a));
      // Inactive/hidden and renamed still counts as an existing custom category.
      await db
        .update(productCategories)
        .set({ name: 'Custom name', status: 'INACTIVE', visibility: 'HIDDEN', sortOrder: 45 })
        .where(eq(productCategories.tenantId, b));
      await db
        .update(paymentGateways)
        .set({
          status: 'DISABLED',
          instructions: 'Keep me',
          minAmountMinor: 150n,
          customerFeeBasisPoints: 123,
          requiresVerifiedPhone: true,
        })
        .where(
          and(eq(paymentGateways.tenantId, b), eq(paymentGateways.provider, 'MANUAL_TRANSFER')),
        );
      await db
        .delete(paymentGateways)
        .where(and(eq(paymentGateways.tenantId, b), eq(paymentGateways.provider, 'CUSTOM')));
      const ownerB = await db.select().from(admins).where(eq(admins.tenantId, b));
      const actorB = (
        await signIn(
          {
            id: ownerB[0]!.id as never,
            username: 'repair-custom-admin',
            password: HOSTED_PASSWORD,
          },
          { tenantId: b as never, botInstanceId: null },
        )
      ).actor;
      await api.container.paymentGateways.setCredential(
        { tenantId: b as never, botInstanceId: null },
        actorB,
        { idempotencyKey: key(), provider: 'TONPAYS', apiKey: 'preserved-hosted-fixture-key' },
      );
      const preservedRoutes = await db
        .select()
        .from(paymentGateways)
        .where(eq(paymentGateways.tenantId, b));
      const preservedCategories = await db
        .select()
        .from(productCategories)
        .where(eq(productCategories.tenantId, b));
      const credentials = await db.select().from(paymentGatewayCredentials);
      const primaryRoutes = await db
        .select()
        .from(paymentGateways)
        .where(eq(paymentGateways.tenantId, tenantA.tenantId));
      const primaryCategories = await db
        .select()
        .from(productCategories)
        .where(eq(productCategories.tenantId, tenantA.tenantId));
      const migration = readFileSync('apps/api/drizzle/0347_hosted_tenant_defaults.sql', 'utf8');
      const apply = () =>
        api.container.database.db.transaction(async (tx) => {
          for (const statement of migration.split('--> statement-breakpoint'))
            await tx.execute(sql.raw(statement));
        });
      await apply();
      const repaired = await db
        .select()
        .from(paymentGateways)
        .where(eq(paymentGateways.tenantId, a));
      expect(repaired.map((g) => g.provider).sort()).toEqual([...PAYMENT_GATEWAY_PROVIDERS].sort());
      for (const row of repaired)
        expect(row).toMatchObject({
          boundsCurrency: 'IRR',
          status: row.provider === 'MANUAL_TRANSFER' ? 'ACTIVE' : 'DISABLED',
        });
      const backfilledCategories = await db
        .select()
        .from(productCategories)
        .where(eq(productCategories.tenantId, a));
      expect(backfilledCategories).toMatchObject([{ name: DEFAULT_PRODUCT_CATEGORY_NAME }]);
      const backfilledId = uuidV7Schema.parse(backfilledCategories[0]?.id);
      const [adminA] = await db.select().from(admins).where(eq(admins.tenantId, a));
      const scopeA: TenantContext = { tenantId: a as never, botInstanceId: null };
      const actorA = (
        await signIn(
          { id: adminA!.id as never, username: 'repair-empty-admin', password: HOSTED_PASSWORD },
          scopeA,
        )
      ).actor;
      // A row in the table is not enough: the real service must accept its identifier.
      expect(await api.container.productCategories.get(scopeA, actorA, backfilledId)).toMatchObject(
        { id: backfilledId, name: DEFAULT_PRODUCT_CATEGORY_NAME },
      );
      const invalid = await db
        .select()
        .from(paymentGateways)
        .where(eq(paymentGateways.tenantId, c));
      expect(invalid.every((row) => row.boundsCurrency === 'IRT')).toBe(true);
      const routesB = await db
        .select()
        .from(paymentGateways)
        .where(eq(paymentGateways.tenantId, b));
      expect(routesB).toHaveLength(PAYMENT_GATEWAY_PROVIDERS.length);
      for (const row of preservedRoutes) expect(routesB).toContainEqual(row);
      expect(
        await db.select().from(productCategories).where(eq(productCategories.tenantId, b)),
      ).toEqual(preservedCategories);
      expect(await db.select().from(paymentGatewayCredentials)).toEqual(credentials);
      expect(
        await db
          .select()
          .from(paymentGateways)
          .where(eq(paymentGateways.tenantId, tenantA.tenantId)),
      ).toEqual(primaryRoutes);
      expect(
        await db
          .select()
          .from(productCategories)
          .where(eq(productCategories.tenantId, tenantA.tenantId)),
      ).toEqual(primaryCategories);
      const allRoutes = await db.select().from(paymentGateways);
      const allCategories = await db.select().from(productCategories);
      await apply();
      expect(await db.select().from(paymentGateways)).toEqual(allRoutes);
      expect(await db.select().from(productCategories)).toEqual(allCategories);
      expect(await db.select().from(paymentGatewayCredentials)).toEqual(credentials);
    });

    it('does not duplicate a first custom category committing concurrently with the backfill', async () => {
      const panel = await openPanel();
      const tenantId = (await createBot(panel, 'repair-race')).bot.tenantId;
      const db = api.container.database.db;
      await db.delete(productCategories).where(eq(productCategories.tenantId, tenantId));
      const categoryId = api.container.ids.uuid();
      const migration = readFileSync('apps/api/drizzle/0347_hosted_tenant_defaults.sql', 'utf8');
      await api.container.database.withClient(async (writer) => {
        await writer.query('BEGIN');
        let repair: Promise<unknown> | undefined;
        let committed = false;
        try {
          await writer.query(
            'INSERT INTO product_categories (id, tenant_id, name) VALUES ($1, $2, $3)',
            [categoryId, tenantId, 'Concurrent custom category'],
          );
          repair = db.transaction(async (tx) => {
            for (const statement of migration.split('--> statement-breakpoint'))
              await tx.execute(sql.raw(statement));
          });
          // Observe the actual database lock, not a sleep or a guess that the repair started.
          await vi.waitFor(
            async () => {
              const { rows } = await db.execute(sql`
              SELECT count(*)::int AS waiting FROM pg_locks
              WHERE relation = 'product_categories'::regclass
                AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                AND mode = 'ShareRowExclusiveLock' AND NOT granted`);
              expect(rows).toEqual([{ waiting: 1 }]);
            },
            { timeout: 5000 },
          );
          await writer.query('COMMIT');
          committed = true;
          await repair;
        } finally {
          if (!committed) await writer.query('ROLLBACK');
          // Drain a blocked repair on assertion failure before the next test resets tables.
          if (repair !== undefined) await Promise.allSettled([repair]);
        }
      });
      const categories = await db
        .select()
        .from(productCategories)
        .where(eq(productCategories.tenantId, tenantId));
      expect(categories).toHaveLength(1);
      expect(categories[0]).toMatchObject({ id: categoryId, name: 'Concurrent custom category' });
    });

    it('rolls back routes, categories, identity and tenant rows when owner provisioning fails', async () => {
      const panel = await openPanel();
      const snapshot = async () =>
        (
          await api.container.database.db.execute(sql`
        SELECT (SELECT count(*) FROM tenants) AS tenants,
               (SELECT count(*) FROM admins) AS admins,
               (SELECT count(*) FROM roles) AS roles,
               (SELECT count(*) FROM role_permissions) AS permissions,
               (SELECT count(*) FROM payment_gateways) AS gateways,
               (SELECT count(*) FROM product_categories) AS categories,
               (SELECT count(*) FROM hosted_bots) AS hosted,
               (SELECT count(*) FROM outbox_messages) AS outbox`)
        ).rows;
      const before = await snapshot();
      const fail = vi
        .spyOn(api.container.roles, 'setAdminRoles')
        .mockRejectedValueOnce(new Error('owner provisioning fixture failure'));
      try {
        await expect(createBot(panel, 'must-rollback')).rejects.toThrow(
          'owner provisioning fixture failure',
        );
      } finally {
        fail.mockRestore();
      }
      expect(await snapshot()).toEqual(before);
      expect(
        await api.container.database.db
          .select()
          .from(tenants)
          .where(eq(tenants.slug, 'must-rollback')),
      ).toHaveLength(0);
      // A subsequent attempt can provision normally: no partial slug/owner/defaults survived.
      expect((await createBot(panel, 'must-rollback')).bot.state).toBe('ACTIVE');
    });

    it('creates a HOSTED tenant with its own Web Admin owner, audited in the owner’s log only', async () => {
      const panel = await openPanel();
      const idempotencyKey = key();
      const proof = { code: code(panel.secret) };
      const input = {
        idempotencyKey,
        proof,
        slug: 'hosted-one',
        displayName: 'Hosted One',
        adminUsername: 'hosted-admin',
        adminDisplayName: 'Hosted owner',
        adminPassword: HOSTED_PASSWORD,
        expiresAt: null,
      };
      const created = await api.container.hosting.create(tenantA, ownerActor, panel.token, input);
      expect(created.replayed).toBe(false);
      expect(created.bot).toMatchObject({
        slug: 'hosted-one',
        state: 'ACTIVE',
        tenantStatus: 'ACTIVE',
        customerCount: 0,
        webAdmin: { username: 'hosted-admin' },
        telegramBot: null,
        expiresAt: null,
      });
      expect(created.bot.resources.length).toBeGreaterThan(0);
      const id = created.bot.tenantId;
      const row = await tenantRow(id);
      expect(row).toMatchObject({
        kind: 'HOSTED',
        parentTenantId: tenantA.tenantId,
        status: 'ACTIVE',
      });
      // Nothing was written to the hosted tenant's own audit log by the creation (D5).
      expect(
        await api.container.database.db.select().from(auditLogs).where(eq(auditLogs.tenantId, id)),
      ).toHaveLength(0);
      // Its own owner can sign in to its own tenant.
      const hostedAdmin = (
        await api.container.database.db.select().from(admins).where(eq(admins.tenantId, id))
      )[0];
      expect(
        await api.container.admins.roleKeysFor(
          { tenantId: id as never, botInstanceId: null },
          hostedAdmin?.id as never,
        ),
      ).toEqual(['owner']);
      await signIn(
        { id: hostedAdmin?.id as never, username: 'hosted-admin', password: HOSTED_PASSWORD },
        { tenantId: id as never, botInstanceId: null },
      );
      // Audited in the installation's log; nothing in the hosted tenant's (D5).
      const audit = await api.container.database.db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.action, 'hosting.create'), eq(auditLogs.result, 'SUCCESS')));
      expect(audit).toHaveLength(1);
      expect(audit[0]?.tenantId).toBe(tenantA.tenantId);
      expect(JSON.stringify(audit[0])).not.toContain(HOSTED_PASSWORD);
      const events = await api.container.database.db
        .select()
        .from(outboxMessages)
        .where(eq(outboxMessages.aggregateId, id));
      expect(events.map((event) => event.eventType)).toEqual(['TenantCreated']);

      // A replay of the same key answers the first result without a new code or a new tenant.
      const replay = await api.container.hosting.create(tenantA, ownerActor, panel.token, input);
      expect(replay.replayed).toBe(true);
      expect(replay.bot.tenantId).toBe(id);
      // A taken slug is refused.
      expect(await codeOf(createBot(panel, 'hosted-one'))).toBe(HOSTING_ERROR_CODES.SLUG_TAKEN);
      const list = await api.container.hosting.list(tenantA, ownerActor, panel.token);
      expect(list.bots.map((bot) => bot.tenantId)).toEqual([id]);
      expect(list.create).toEqual({ enabled: true, refusal: null });

      // The fail-closed tenant guard (#411): a new HOSTED tenant is never the installation's
      // PRIMARY, and its creation never re-resolves the role's own tenant.
      expect((await api.container.tenants.findPrimary())?.id).toBe(tenantA.tenantId);
      await expect(api.container.installationTenantGuard.verify()).resolves.toBe(tenantA.tenantId);
    });

    it('suspension really stops the bot: write paths, webhook, Web Admin sign-in and sessions', async () => {
      const panel = await openPanel();
      const created = await createBot(panel);
      const id = created.bot.tenantId;
      const hostedScope: TenantContext = { tenantId: id as never, botInstanceId: null };
      const hostedAdminRow = (
        await api.container.database.db.select().from(admins).where(eq(admins.tenantId, id))
      )[0];
      const hostedAdmin: SeededAdmin = {
        id: hostedAdminRow?.id as never,
        username: hostedAdminRow?.username as string,
        password: HOSTED_PASSWORD,
      };
      const session = await signIn(hostedAdmin, hostedScope);
      const botId = api.container.ids.uuid();
      await api.container.database.db.insert(botInstances).values({
        id: botId,
        tenantId: id,
        username: 'hosted_one_bot',
        status: 'ACTIVE',
        tokenCiphertext: 'not-a-real-token',
        tokenKeyId: 'test-1',
      });
      const writeSetting = () =>
        api.container.settingsService.set(hostedScope, session.actor, {
          key: BACKUP_SCHEDULE_SETTING_KEYS.enabled,
          value: false,
          expectedVersion: null,
          idempotencyKey: key(),
        });

      await api.container.hosting.suspend(tenantA, ownerActor, panel.token, id, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
        reason: 'test',
      });
      expect((await tenantRow(id))?.status).toBe('STOPPED');
      expect(await api.container.tenants.scopeIsActive(hostedScope)).toBe(false);
      // Refused INSIDE its transaction by ScopeActivityReader, whatever the session says.
      expect(await codeOf(writeSetting())).toBe(PLATFORM_ERROR_CODES.TENANT_NOT_FOUND);
      expect(await codeOf(api.container.auth.authenticate(session.token))).toBe(
        IDENTITY_ERROR_CODES.AUTH_TENANT_SUSPENDED,
      );
      await expect(signIn(hostedAdmin, hostedScope)).rejects.toThrow();
      const webhook = await inject({
        method: 'POST',
        url: `/telegram/webhook/${botId}`,
        headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
        payload: {
          update_id: 1,
          message: { message_id: 1, date: 1, chat: { id: 7, type: 'private' }, text: '/start' },
        },
      });
      expect(webhook.statusCode).toBe(404);
      expect(webhook.json().error.code).toBe(PLATFORM_ERROR_CODES.TENANT_NOT_FOUND);
      const changed = await api.container.database.db
        .select()
        .from(outboxMessages)
        .where(
          and(
            eq(outboxMessages.aggregateId, id),
            eq(outboxMessages.eventType, 'HostedBotStateChanged'),
          ),
        );
      expect(changed).toHaveLength(1);

      // SFR A5: not before its token is entered again — the bot stays stopped.
      expect(
        await codeOf(
          api.container.hosting.activate(tenantA, ownerActor, panel.token, id, {
            idempotencyKey: key(),
            proof: { code: code(panel.secret) },
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.TOKEN_REENTRY_REQUIRED);
      expect((await tenantRow(id))?.status).toBe('STOPPED');
      await tokenReentered(id);

      // Activated again: everything is back.
      const activated = await api.container.hosting.activate(tenantA, ownerActor, panel.token, id, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
      });
      expect(activated.bot.state).toBe('ACTIVE');
      await api.container.auth.authenticate(session.token);
      await signIn(hostedAdmin, hostedScope);
      await writeSetting();
      // Activating an ACTIVE bot is a state conflict, refused before a code is spent.
      expect(
        await codeOf(
          api.container.hosting.activate(tenantA, ownerActor, panel.token, id, {
            idempotencyKey: key(),
            proof: { code: '000000' },
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.STATE_CONFLICT);
    });

    it('while a REPLACE of the bot is in progress no transition and no expiry moves it (Phase 6B)', async () => {
      const panel = await openPanel();
      const at = new Date(now().getTime() + 3600_000).toISOString();
      const id = (await createBot(panel, 'replacing', { expiresAt: at })).bot.tenantId;
      const restore = api.container.ids.uuid();
      await api.container.database.db.execute(sql`
        INSERT INTO tenant_restores (id, tenant_id, hosted_tenant_id, mode, state, stage,
                                     artifact_sha256, requested_by_admin_id, created_at, updated_at)
        VALUES (${restore}, ${tenantA.tenantId}, ${id}, 'REPLACE', 'APPLYING', 'APPLY',
                ${'b'.repeat(64)}, ${ownerActor.id}, now(), now())`);
      const act = (action: 'suspend' | 'delete' | 'activate') =>
        api.container.hosting[action](tenantA, ownerActor, panel.token, id, {
          idempotencyKey: key(),
          proof: { code: code(panel.secret) },
        });
      expect(await codeOf(act('suspend'))).toBe(HOSTING_ERROR_CODES.REPLACE_IN_PROGRESS);
      expect(await codeOf(act('delete'))).toBe(HOSTING_ERROR_CODES.REPLACE_IN_PROGRESS);
      // The expiry sweep leaves it alone too.
      offsetMs += 3600_000;
      expect(await api.container.hostedBotExpiry.runOnce(tenantA)).toBe(0);
      expect((await tenantRow(id))?.status).toBe('ACTIVE');
      // Once the replace ends, the bot is the owner's again.
      await api.container.database.db.execute(sql`
        UPDATE tenant_restores SET state = 'FAILED', failure_code = 'x', finished_at = now()
         WHERE id = ${restore}`);
      expect(await api.container.hostedBotExpiry.runOnce(tenantA)).toBe(1);
      expect((await tenantRow(id))?.status).toBe('STOPPED');
      // A held (stopped) bot being replaced is not re-opened from the panel either.
      await api.container.database.db.execute(sql`
        UPDATE tenant_restores SET state = 'VERIFYING', failure_code = NULL, finished_at = NULL
         WHERE id = ${restore}`);
      await api.container.hosting.setExpiry(tenantA, ownerActor, panel.token, id, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
        expiresAt: null,
      });
      expect(await codeOf(act('activate'))).toBe(HOSTING_ERROR_CODES.REPLACE_IN_PROGRESS);
      expect((await tenantRow(id))?.status).toBe('STOPPED');
    });

    it('deletes softly (restorable), and purges only a deleted bot with its slug typed', async () => {
      const panel = await openPanel();
      const id = (await createBot(panel)).bot.tenantId;
      const act = (action: 'delete' | 'activate') =>
        api.container.hosting[action](tenantA, ownerActor, panel.token, id, {
          idempotencyKey: key(),
          proof: { code: code(panel.secret) },
        });
      expect(
        await codeOf(
          api.container.hosting.purge(tenantA, ownerActor, panel.token, id, {
            idempotencyKey: key(),
            proof: { code: code(panel.secret) },
            confirmSlug: 'hosted-one',
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.STATE_CONFLICT);
      const deleted = await act('delete');
      expect(deleted.bot).toMatchObject({ state: 'DELETED', tenantStatus: 'DISABLED' });
      expect(deleted.bot.deletedAt).not.toBeNull();
      // SFR A5: a deleted bot is restored only after its token is entered again.
      expect(await codeOf(act('activate'))).toBe(HOSTING_ERROR_CODES.TOKEN_REENTRY_REQUIRED);
      await tokenReentered(id);
      expect((await act('activate')).bot).toMatchObject({ state: 'ACTIVE', deletedAt: null });
      await act('delete');
      await tokenReentered(id);

      // A deleted bot whose date has passed: ACTIVATE refuses it until the date changes, and
      // changing the date leaves it deleted (the Web Admin offers the expiry action there).
      const soon = new Date(now().getTime() + 60_000).toISOString();
      await api.container.hosting.setExpiry(tenantA, ownerActor, panel.token, id, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
        expiresAt: soon,
      });
      offsetMs += 120_000;
      expect(await codeOf(act('activate'))).toBe(HOSTING_ERROR_CODES.EXPIRY_PASSED);
      const redated = await api.container.hosting.setExpiry(tenantA, ownerActor, panel.token, id, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
        expiresAt: null,
      });
      expect(redated.bot).toMatchObject({ state: 'DELETED', expiresAt: null });
      expect((await act('activate')).bot).toMatchObject({ state: 'ACTIVE', deletedAt: null });
      await act('delete');

      const preview = await api.container.hosting.purgePreview(
        tenantA,
        ownerActor,
        panel.token,
        id,
      );
      expect(preview.confirmSlug).toBe('hosted-one');
      expect(preview.counts.admins).toBe(1);
      expect(
        await codeOf(
          api.container.hosting.purge(tenantA, ownerActor, panel.token, id, {
            idempotencyKey: key(),
            proof: { code: code(panel.secret) },
            confirmSlug: 'hosted-ONE',
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.PURGE_CONFIRMATION_MISMATCH);
      const purged = await api.container.hosting.purge(tenantA, ownerActor, panel.token, id, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
        confirmSlug: 'hosted-one',
      });
      expect(purged).toMatchObject({ erasure: 'PENDING', bot: { state: 'PURGED' } });
      expect(await codeOf(act('activate'))).toBe(HOSTING_ERROR_CODES.STATE_CONFLICT);
      // A purged hosted tenant leaves the installation's own tenant where it was (#411).
      await expect(api.container.installationTenantGuard.verify()).resolves.toBe(tenantA.tenantId);
    });

    it('sets and clears an expiry date; the limits editor changes a limit to «نامحدود»', async () => {
      const panel = await openPanel();
      const id = (await createBot(panel)).bot.tenantId;
      const at = new Date(now().getTime() + 7 * 24 * 3600 * 1000).toISOString();
      const set = await api.container.hosting.setExpiry(tenantA, ownerActor, panel.token, id, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
        expiresAt: at,
      });
      expect(set.bot.expiresAt).toBe(at);
      const cleared = await api.container.hosting.setExpiry(tenantA, ownerActor, panel.token, id, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
        expiresAt: null,
      });
      expect(cleared.bot.expiresAt).toBeNull();

      const limitInput = {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
        resource: 'UPDATE_CONCURRENCY' as const,
        limit: { mode: 'UNLIMITED' as const },
      };
      const changed = await api.container.hosting.setLimit(
        tenantA,
        ownerActor,
        panel.token,
        id,
        limitInput,
      );
      expect(changed.replayed).toBe(false);
      expect(
        changed.tenant.limits.find((limit) => limit.resource === 'UPDATE_CONCURRENCY')?.limit,
      ).toEqual({
        mode: 'UNLIMITED',
      });
      // A retry with the same key (and so the code it already spent) answers the saved result:
      // it is not refused for the used code, and it counts nothing towards the lockout.
      const [before] = await api.container.database.db.select().from(hostingTotpFactors);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const retried = await api.container.hosting.setLimit(
          tenantA,
          ownerActor,
          panel.token,
          id,
          limitInput,
        );
        expect(retried.replayed).toBe(true);
      }
      const [after] = await api.container.database.db.select().from(hostingTotpFactors);
      expect(after?.failedAttempts).toBe(before?.failedAttempts);
      expect(after?.lastUsedStep).toBe(before?.lastUsedStep);
      // Without a fresh code, PR-2's limit is not reached through the panel.
      expect(
        await codeOf(
          api.container.hosting.setLimit(tenantA, ownerActor, panel.token, id, {
            idempotencyKey: key(),
            proof: { code: '000000' },
            resource: 'UPDATE_CONCURRENCY',
            limit: null,
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.CODE_REJECTED);
      const limits = await api.container.hosting.limits(tenantA, ownerActor, panel.token);
      expect(limits.tenants.some((tenant) => tenant.tenantId === id)).toBe(true);
      // An unknown tenant is not a hosted bot.
      expect(
        await codeOf(
          api.container.hosting.setLimit(tenantA, ownerActor, panel.token, tenantB.tenantId, {
            idempotencyKey: key(),
            proof: { code: code(panel.secret) },
            resource: 'UPDATE_CONCURRENCY',
            limit: null,
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.BOT_NOT_FOUND);
    });

    it('«ورود به پنل» needs a verified domain (tests/integration/hosting-enter.test.ts has the rest); the server card reads the host', async () => {
      const panel = await openPanel();
      const id = (await createBot(panel)).bot.tenantId;
      expect(
        await codeOf(
          api.container.hostingEnter.mint(tenantA, ownerActor, panel.token, id, {
            idempotencyKey: key(),
            proof: { code: code(panel.secret) },
          }),
        ),
      ).toBe(HOSTING_ERROR_CODES.ENTER_DOMAIN_REQUIRED);
      const server = await api.container.hosting.server(tenantA, ownerActor, panel.token);
      expect(server.cpu.cores).toBeGreaterThan(0);
      expect(server.memory.totalBytes).toBeGreaterThan(0);
      expect(server.estimate.liveHostedBots).toBe(1);
      expect(server.estimate.formula).toContain('75');
    });
  });

  describe('the expiry sweep', () => {
    it('expires an ACTIVE bot once its date passes, tells the owner’s group once, and is idempotent', async () => {
      const panel = await openPanel();
      const at = new Date(now().getTime() + 3600_000).toISOString();
      const id = (await createBot(panel, 'expiring', { expiresAt: at })).bot.tenantId;
      const suspendedId = (await createBot(panel, 'suspended', { expiresAt: at })).bot.tenantId;
      await api.container.hosting.suspend(tenantA, ownerActor, panel.token, suspendedId, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
      });
      expect(await api.container.hostedBotExpiry.runOnce(tenantA)).toBe(0);
      offsetMs += 3600_000;
      expect(await api.container.hostedBotExpiry.runOnce(tenantA)).toBe(1);
      expect(await api.container.hostedBotExpiry.runOnce(tenantA)).toBe(0);
      expect((await tenantRow(id))?.status).toBe('STOPPED');
      const [row] = await api.container.database.db
        .select()
        .from(hostedBots)
        .where(eq(hostedBots.hostedTenantId, id));
      expect(row?.state).toBe('EXPIRED');
      const [other] = await api.container.database.db
        .select()
        .from(hostedBots)
        .where(eq(hostedBots.hostedTenantId, suspendedId));
      expect(other?.state).toBe('SUSPENDED');
      const told = await api.container.database.db
        .select()
        .from(operationalEvents)
        .where(eq(operationalEvents.code, 'hosting.bot_expired'));
      expect(told).toHaveLength(1);
      expect(told[0]?.tenantId).toBe(tenantA.tenantId);
      const audit = await api.container.database.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'hosting.expire'));
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actorType).toBe('SYSTEM_JOB');

      // Activating needs a date in the future (or none) first.
      const activate = () =>
        api.container.hosting.activate(tenantA, ownerActor, panel.token, id, {
          idempotencyKey: key(),
          proof: { code: code(panel.secret) },
        });
      expect(await codeOf(activate())).toBe(HOSTING_ERROR_CODES.EXPIRY_PASSED);
      await api.container.hosting.setExpiry(tenantA, ownerActor, panel.token, id, {
        idempotencyKey: key(),
        proof: { code: code(panel.secret) },
        expiresAt: null,
      });
      expect((await activate()).bot.state).toBe('ACTIVE');
      expect(await api.container.hostedBotExpiry.runOnce(tenantA)).toBe(0);
    });
  });

  describe('over HTTP', () => {
    function cookieFrom(
      response: { headers: Record<string, unknown> },
      name: string,
    ): string | null {
      const header = response.headers['set-cookie'];
      const all = Array.isArray(header) ? header.map(String) : [String(header ?? '')];
      for (const line of all) {
        const match = new RegExp(`(?:^|\\s)${name}=([^;]+)`).exec(line);
        if (match !== null && match[1] !== '') return `${name}=${match[1] as string}`;
      }
      return null;
    }

    it('the sidebar key is shown to the installation owner only, not to a delegated operator', async () => {
      // The session's permission list is chrome; `hosting.manage` is drawn for the owner alone.
      const shown = async (username: string, password: string) => {
        const login = await inject({
          method: 'POST',
          url: `${API_PREFIX}/auth/login`,
          headers: { origin: ORIGIN },
          payload: { username, password },
        });
        expect(login.statusCode).toBe(201);
        const cookie = cookieFrom(login, 'nexa_admin_session') as string;
        const session = await inject({
          method: 'GET',
          url: `${API_PREFIX}/auth/session`,
          headers: { cookie, origin: ORIGIN },
        });
        expect(session.statusCode).toBe(200);
        return {
          login: (login.json() as { permissions: string[] }).permissions,
          session: (session.json() as { permissions: string[] }).permissions,
        };
      };
      const ownerSees = await shown(owner.username, OWNER_PASSWORD);
      expect(ownerSees.login).toContain('hosting.manage');
      expect(ownerSees.session).toContain('hosting.manage');
      const delegated = await createAdmin(api.container, tenantA, {
        username: 'panel-delegated',
        password: 'the-delegated-password',
        roleKeys: ['operator'],
      });
      await api.container.database.db.insert(adminPermissionOverrides).values({
        tenantId: tenantA.tenantId,
        adminId: delegated.id,
        permissionKey: 'hosting.manage',
        effect: 'GRANT',
        reason: 'test: a delegated key is not drawn',
      });
      const delegatedSees = await shown('panel-delegated', 'the-delegated-password');
      expect(delegatedSees.login).not.toContain('hosting.manage');
      expect(delegatedSees.session).not.toContain('hosting.manage');
    });

    it('the section cookie is issued on activation and required beside the session cookie', async () => {
      const login = await inject({
        method: 'POST',
        url: `${API_PREFIX}/auth/login`,
        headers: { origin: ORIGIN },
        payload: { username: owner.username, password: OWNER_PASSWORD },
      });
      const session = cookieFrom(login, 'nexa_admin_session') as string;
      expect(session).not.toBeNull();
      const as = (cookie: string) => ({ cookie, origin: ORIGIN });
      const status = await inject({
        method: 'GET',
        url: `${API_PREFIX}/hosting/status`,
        headers: as(session),
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        factor: 'NONE',
        session: null,
        create: { enabled: true },
      });
      const enrol = await inject({
        method: 'POST',
        url: `${API_PREFIX}/hosting/2fa/enrol`,
        headers: as(session),
        payload: { password: OWNER_PASSWORD },
      });
      expect(enrol.statusCode).toBe(200);
      expect(enrol.headers['cache-control']).toBe('no-store');
      const activate = await inject({
        method: 'POST',
        url: `${API_PREFIX}/hosting/2fa/activate`,
        headers: as(session),
        payload: { code: code(enrol.json().secret as string) },
      });
      expect(activate.statusCode).toBe(200);
      const section = cookieFrom(activate, 'nexa_hosting') as string;
      expect(section).not.toBeNull();
      const without = await inject({
        method: 'GET',
        url: `${API_PREFIX}/hosting/bots`,
        headers: as(session),
      });
      expect(without.statusCode).toBe(401);
      expect(without.json().error.code).toBe(HOSTING_ERROR_CODES.SECTION_SESSION_REQUIRED);
      const withIt = await inject({
        method: 'GET',
        url: `${API_PREFIX}/hosting/bots`,
        headers: as(`${session}; ${section}`),
      });
      expect(withIt.statusCode).toBe(200);
      expect(withIt.json()).toMatchObject({ bots: [] });
      const close = await inject({
        method: 'POST',
        url: `${API_PREFIX}/hosting/session/close`,
        headers: as(`${session}; ${section}`),
      });
      expect(close.statusCode).toBe(200);
      const after = await inject({
        method: 'GET',
        url: `${API_PREFIX}/hosting/bots`,
        headers: as(`${session}; ${section}`),
      });
      expect(after.statusCode).toBe(401);
    });
  });
});
