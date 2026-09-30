import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  BOT_COMMANDS,
  BOT_ERROR_CODES,
  BOT_MENU_ROUTES,
  CONTROL_ROUTES,
  SESSION_COOKIE_NAME,
  botMenuConfigResponseSchema,
  checkBotMenuResponseSchema,
  syncBotMenuResponseSchema,
  type ActorContext,
  type BotInstanceId,
  type TenantContext,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  BOT_COMMAND_SYNC_BACKOFF_BASE_MS,
  COMMAND_SYNC_FAILING_CODE,
  COMMAND_SYNC_RECOVERED_CODE,
} from '../../apps/api/src/modules/platform/tenancy/domain/bot-command-sync';
import { startFakeTelegramBotApi, type FakeTelegramBotApi } from '../support/fake-telegram-bot-api';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  SEED_IDS,
  tenantA,
  tenantB,
  testConfig,
} from './harness';

/**
 * Round P (COMMAND-MENU) — the slash-command sync lane and the menu endpoint, over the
 * real app, a real database and the HTTP fake of Telegram (`fake-telegram-bot-api.ts`,
 * which now models `setMyCommands` / `getMyCommands` per the Bot API's documented bounds).
 *
 * `docs/command-menu-audit.md` lists what each case protects.
 */

const ORIGIN = 'https://admin.example.test';
const WEBHOOK_SECRET = 'command-sync-integration-secret';
const BOT_A1 = SEED_IDS.botA1 as BotInstanceId;
const BOT_A2 = SEED_IDS.botA2 as BotInstanceId;
const BOT_B1 = SEED_IDS.botB1 as BotInstanceId;
const ID_A1 = 7100000001;
const ID_A2 = 7100000002;
const ID_B1 = 7100000003;

describe('round P — the Telegram command-menu sync lane', () => {
  let api: ApiApp;
  let telegram: FakeTelegramBotApi;
  let owner: ActorContext;
  const scopeA = tenantA as unknown as TenantContext;
  const scopeB = tenantB as unknown as TenantContext;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const db = () => api.container.database.db;
  const lane = () => api.container.botCommandSync;

  beforeAll(async () => {
    telegram = await startFakeTelegramBotApi();
    const config = testConfig({
      WEB_ADMIN_ORIGINS: ORIGIN,
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_API_BASE_URL: telegram.url,
      NOTIFICATION_SEND_TIMEOUT_MS: '2000',
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await telegram?.close();
  });

  /** Binds a seeded bot row to a fake Telegram bot: its token, its identity, ACTIVE or not. */
  async function bind(
    botId: BotInstanceId,
    tenantId: string,
    telegramId: number,
    username: string,
    status: 'ACTIVE' | 'STOPPED',
  ): Promise<string> {
    const token = telegram.createBot({ id: telegramId, username });
    const secret = api.container.cipher.encrypt(token, {
      purpose: 'bot_instance.token',
      tenantId: tenantId as never,
      entityId: botId,
    });
    await db().execute(sql`
      UPDATE bot_instances
         SET telegram_bot_id = ${String(telegramId)}, username = ${username}, status = ${status},
             token_ciphertext = ${secret.ciphertext}, token_key_id = ${secret.keyId},
             commands_revision = NULL
       WHERE id = ${botId}`);
    return token;
  }

  beforeEach(async () => {
    await resetDatabase(db());
    await seed(db(), api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    owner = adminActorFor(
      await createAdmin(api.container, tenantA, {
        username: 'owner',
        password: 'the-owners-real-password',
        roleKeys: ['owner'],
      }),
    );
    await createAdmin(api.container, tenantA, {
      username: 'observer',
      password: 'the-observer-password',
      roleKeys: ['observer'],
    });
    await bind(BOT_A1, SEED_IDS.tenantA, ID_A1, 'acme_store_bot', 'ACTIVE');
    await bind(BOT_A2, SEED_IDS.tenantA, ID_A2, 'acme_support_bot', 'STOPPED');
    await bind(BOT_B1, SEED_IDS.tenantB, ID_B1, 'globex_store_bot', 'ACTIVE');
    telegram.calls.length = 0;
  });

  async function cookieFor(username: string, password: string): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(response.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error(`No session for ${username}.`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }
  const ownerCookie = () => cookieFor('owner', 'the-owners-real-password');
  const observerCookie = () => cookieFor('observer', 'the-observer-password');
  const get = (path: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: { cookie, origin: ORIGIN } });
  const post = (path: string, cookie: string, payload: unknown) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: { cookie, origin: ORIGIN },
      payload: payload as never,
    });

  const syncRow = async (botId: BotInstanceId) =>
    (
      await db().execute<{
        desired_hash: string;
        desired_version: number;
        attempts: number;
        next_attempt_at: Date | null;
        last_error_code: string | null;
        last_synced_at: Date | null;
        last_attempted_at: Date | null;
        claimed_until: Date | null;
      }>(sql`SELECT * FROM bot_command_syncs WHERE bot_instance_id = ${botId}`)
    ).rows[0] ?? null;
  const revisionOf = async (botId: BotInstanceId) =>
    (
      await db().execute<{ r: string | null }>(sql`
        SELECT commands_revision AS r FROM bot_instances WHERE id = ${botId}`)
    ).rows[0]?.r ?? null;
  const opsRows = async (code: string) =>
    (
      await db().execute<{
        occurrence_count: number;
        resolved_at: Date | null;
        context: unknown;
      }>(sql`
        SELECT occurrence_count, resolved_at, context FROM operational_events WHERE code = ${code}`)
    ).rows;
  const auditRows = async (action: string, botId: BotInstanceId) =>
    (
      await db().execute<{ result: string; after: Record<string, unknown> }>(sql`
        SELECT result, "after" FROM audit_logs
         WHERE action = ${action} AND entity_id = ${botId} ORDER BY occurred_at, id`)
    ).rows;

  const desired = (scope: TenantContext) => api.container.commandMenu.desiredFor(scope);

  // -------------------------------------------------------------------------

  it('registers exactly BOT_COMMANDS, worded by the tenant, and records the digest of what it sent', async () => {
    // The tenant reworded one description; the shared default stands for the rest.
    await api.container.templatesService.set(scopeA, owner, {
      idempotencyKey: 'reword-help',
      key: 'bot.command.help',
      body: 'راهنما، پشتیبانی و سوال‌ها',
      expectedVersion: null,
      expectedRevision: null,
    });

    const result = await lane().syncNow(scopeA, BOT_A1);
    expect(result).toEqual({ botInstanceId: BOT_A1, outcome: 'SYNCED', errorCode: null });

    const registered = telegram.registeredCommands(ID_A1);
    expect(registered.map((entry) => entry.command)).toEqual(
      BOT_COMMANDS.map((entry) => entry.command),
    );
    expect(registered.find((entry) => entry.command === 'help')?.description).toBe(
      'راهنما، پشتیبانی و سوال‌ها',
    );
    expect(registered.find((entry) => entry.command === 'wallet')?.description).toBe(
      CATALOGUE_FA['bot.command.wallet'],
    );
    // Only the customer scope. `/admin`, `/link`, `/role`, `/service`, `/customer` never.
    for (const admin of ['admin', 'link', 'role', 'service', 'customer', 'category_new']) {
      expect(
        registered.some((entry) => entry.command === admin),
        admin,
      ).toBe(false);
    }
    const menu = await desired(scopeA);
    expect(await revisionOf(BOT_A1)).toBe(menu.hash);
    const row = await syncRow(BOT_A1);
    expect(row).toMatchObject({ attempts: 0, next_attempt_at: null, last_error_code: null });
    expect(row?.last_synced_at).not.toBeNull();
    expect(row?.claimed_until).toBeNull();
    expect((await auditRows('bot.commands.sync', BOT_A1)).map((r) => r.result)).toEqual([
      'SUCCESS',
    ]);
    // And the state the Web Admin shows.
    const status = await lane().statusFor(scopeA);
    expect(status.find((bot) => bot.botInstanceId === BOT_A1)?.state).toBe('CURRENT');
    expect(status.find((bot) => bot.botInstanceId === BOT_A2)?.state).toBe('STOPPED');
  });

  it('retries a failed registration with bounded back-off, warns once after three, and recovers', async () => {
    // Queue it, as an event or an operator would.
    await api.container.uow.run(scopeA, (tx) =>
      lane().requestSync(scopeA, BOT_A1, { due: true }, tx),
    );
    // The lane stamps its rows from the clock; the tick's `now` decides only what is due.
    let due = new Date();
    for (const attempt of [1, 2, 3]) {
      telegram.failNext('setMyCommands', { kind: 'server_error' });
      expect(await lane().tick(due)).toMatchObject({ claimed: 1, synced: 0, failed: 1 });
      const row = await syncRow(BOT_A1);
      expect(row?.attempts).toBe(attempt);
      expect(row?.last_error_code).toBe('telegram.server_error.500');
      expect(row?.claimed_until).toBeNull();
      // The next attempt is due after the back-off for THIS many failures, never at once.
      const next = new Date(String(row?.next_attempt_at));
      const attempted = new Date(String(row?.last_attempted_at));
      expect(next.getTime() - attempted.getTime()).toBe(
        BOT_COMMAND_SYNC_BACKOFF_BASE_MS * 2 ** (attempt - 1),
      );
      // And not before it is due: a tick a second earlier claims nothing.
      expect(await lane().tick(new Date(next.getTime() - 1_000))).toMatchObject({ claimed: 0 });
      due = new Date(next.getTime() + 1_000);
    }
    // The warning opened at the third failure, once, per bot.
    const failing = await opsRows(COMMAND_SYNC_FAILING_CODE);
    expect(failing).toHaveLength(1);
    expect(failing[0]?.resolved_at).toBeNull();
    expect(failing[0]?.context).toMatchObject({ botInstanceId: BOT_A1, attempts: 3 });
    const status = await lane().statusFor(scopeA);
    expect(status.find((bot) => bot.botInstanceId === BOT_A1)).toMatchObject({
      state: 'FAILING',
      attempts: 3,
      lastErrorCode: 'telegram.server_error.500',
    });
    expect(await revisionOf(BOT_A1)).toBeNull();

    // A fourth failure counts on the same row; then Telegram answers and the condition closes.
    telegram.failNext('setMyCommands', { kind: 'server_error' });
    expect(await lane().tick(due)).toMatchObject({ claimed: 1, failed: 1 });
    expect((await opsRows(COMMAND_SYNC_FAILING_CODE))[0]?.occurrence_count).toBe(2);
    const after = new Date(String((await syncRow(BOT_A1))?.next_attempt_at));
    expect(await lane().tick(new Date(after.getTime() + 1_000))).toMatchObject({ synced: 1 });
    expect((await opsRows(COMMAND_SYNC_FAILING_CODE))[0]?.resolved_at).not.toBeNull();
    expect(await opsRows(COMMAND_SYNC_RECOVERED_CODE)).toHaveLength(1);
    expect(await revisionOf(BOT_A1)).toBe((await desired(scopeA)).hash);
    expect((await syncRow(BOT_A1))?.attempts).toBe(0);
  });

  it('syncs every ACTIVE bot of every ACTIVE tenant, and one refused bot does not block the others', async () => {
    // Tenant A's second bot is started; tenant B's is a different tenant entirely.
    await db().execute(sql`UPDATE bot_instances SET status = 'ACTIVE' WHERE id = ${BOT_A2}`);
    // A1's stored token is revoked at Telegram: every registration with it is a 401.
    telegram.revoke(ID_A1, { keepWebhook: true });
    await api.container.uow.run(scopeA, (tx) =>
      lane().requestSync(scopeA, null, { due: true }, tx),
    );
    await api.container.uow.run(scopeB, (tx) =>
      lane().requestSync(scopeB, null, { due: true }, tx),
    );

    const tick = await lane().tick(new Date());
    expect(tick).toMatchObject({ claimed: 3, synced: 2, failed: 1 });
    expect(telegram.registeredCommands(ID_A2)).toEqual((await desired(scopeA)).entries);
    expect(telegram.registeredCommands(ID_B1)).toEqual((await desired(scopeB)).entries);
    expect(telegram.registeredCommands(ID_A1)).toEqual([]);
    expect((await syncRow(BOT_A1))?.last_error_code).toBe('telegram.rejected.401');
    expect(await revisionOf(BOT_A2)).toBe((await desired(scopeA)).hash);
    expect(await revisionOf(BOT_B1)).toBe((await desired(scopeB)).hash);
    // Tenant isolation in the read: A's status never lists B's bot.
    expect((await lane().statusFor(scopeA)).map((bot) => bot.botInstanceId).sort()).toEqual(
      [BOT_A1, BOT_A2].sort(),
    );
  });

  it('never claims a stopped bot or a stopped tenant, and a stopped-then-started bot is queued by its event', async () => {
    await api.container.uow.run(scopeA, (tx) =>
      lane().requestSync(scopeA, BOT_A2, { due: true }, tx),
    );
    // Queued while STOPPED (a forced request records what is wanted)... but never claimed.
    expect(await lane().tick(new Date())).toMatchObject({ claimed: 0 });
    expect(telegram.registeredCommands(ID_A2)).toEqual([]);

    // Started through the management service: the status event queues it NOW.
    await api.container.botManagement.setStatus(scopeA, owner, {
      idempotencyKey: 'start-a2',
      botId: BOT_A2,
      status: 'ACTIVE',
    });
    await api.container.relay.processBatch();
    expect((await syncRow(BOT_A2))?.next_attempt_at).not.toBeNull();
    expect(await lane().tick(new Date())).toMatchObject({ claimed: 1, synced: 1 });
    expect(telegram.registeredCommands(ID_A2)).toEqual((await desired(scopeA)).entries);

    // A stopped TENANT's bot waits too.
    await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${SEED_IDS.tenantB}`);
    await db().execute(sql`
      INSERT INTO bot_command_syncs (bot_instance_id, tenant_id, desired_hash, next_attempt_at)
      VALUES (${BOT_B1}, ${SEED_IDS.tenantB}, 'x', now())`);
    expect(await lane().tick(new Date())).toMatchObject({ claimed: 0 });
  });

  it('queues a sync when a bot.command.* text changes, and not when an unrelated text or the arrangement does', async () => {
    // Start CURRENT.
    await lane().syncNow(scopeA, BOT_A1);
    const before = await revisionOf(BOT_A1);
    telegram.calls.length = 0;

    // A menu LABEL change: the keyboard's business, not the command list's.
    await api.container.templatesService.set(scopeA, owner, {
      idempotencyKey: 'reword-menu-label',
      key: 'bot.menu.wallet',
      body: '💳 موجودی',
      expectedVersion: null,
      expectedRevision: null,
    });
    // The arrangement: an event the consumer re-derives on; the digest is unchanged.
    await api.container.settingsService.set(scopeA, owner, {
      idempotencyKey: 'reorder-menu',
      key: 'bot.main_menu',
      value: [{ button: 'wallet', enabled: true, target: 'wallet', appearanceSlot: 'payment' }],
      expectedVersion: null,
    });
    await api.container.relay.processBatch();
    expect((await syncRow(BOT_A1))?.next_attempt_at).toBeNull();
    expect(await lane().tick(new Date())).toMatchObject({ claimed: 0 });

    // A command DESCRIPTION change: queued, sent, and the digest moves on.
    await api.container.templatesService.set(scopeA, owner, {
      idempotencyKey: 'reword-command',
      key: 'bot.command.wallet',
      body: 'موجودی و شارژ',
      expectedVersion: null,
      expectedRevision: null,
    });
    await api.container.relay.processBatch();
    const queued = await syncRow(BOT_A1);
    expect(queued?.next_attempt_at).not.toBeNull();
    expect(queued?.desired_version).toBe(2);
    expect(await lane().tick(new Date())).toMatchObject({ claimed: 1, synced: 1 });
    expect(
      telegram.registeredCommands(ID_A1).find((entry) => entry.command === 'wallet')?.description,
    ).toBe('موجودی و شارژ');
    expect(await revisionOf(BOT_A1)).not.toBe(before);
    expect(await revisionOf(BOT_A1)).toBe((await desired(scopeA)).hash);
    // Nothing was sent for the label or the arrangement.
    expect(telegram.calls.filter((call) => call.method === 'setMyCommands')).toHaveLength(1);
  });

  it('reconciles a bot whose registered digest drifted, without touching one that is current or queued', async () => {
    await lane().syncNow(scopeA, BOT_A1);
    await lane().syncNow(scopeB, BOT_B1);
    // A release that changed the list, or a stale row: the recorded digest differs.
    await db().execute(
      sql`UPDATE bot_instances SET commands_revision = 'old' WHERE id = ${BOT_B1}`,
    );
    expect(await lane().reconcile()).toBe(1);
    expect((await syncRow(BOT_A1))?.next_attempt_at).toBeNull();
    expect((await syncRow(BOT_B1))?.next_attempt_at).not.toBeNull();
    // Idempotent: the second sweep queues nothing more.
    expect(await lane().reconcile()).toBe(0);
    expect(await lane().tick(new Date())).toMatchObject({ claimed: 1, synced: 1 });
    expect(await revisionOf(BOT_B1)).toBe((await desired(scopeB)).hash);
  });

  it('two workers claiming at once split the due rows, and a lapsed claim is retried', async () => {
    await db().execute(sql`UPDATE bot_instances SET status = 'ACTIVE' WHERE id = ${BOT_A2}`);
    await api.container.uow.run(scopeA, (tx) =>
      lane().requestSync(scopeA, null, { due: true }, tx),
    );
    const now = new Date();
    const [first, second] = await Promise.all([lane().tick(now), lane().tick(now)]);
    expect(first.claimed + second.claimed).toBe(2);
    expect(first.synced + second.synced).toBe(2);
    expect(telegram.calls.filter((call) => call.method === 'setMyCommands')).toHaveLength(2);

    // A claim held by a process that died: lapses with its lease, then is retried.
    await db().execute(sql`
      UPDATE bot_command_syncs SET next_attempt_at = now(), claimed_until = now() + interval '1 minute'
       WHERE bot_instance_id = ${BOT_A1}`);
    expect(await lane().tick(new Date())).toMatchObject({ claimed: 0 });
    expect(await lane().tick(new Date(Date.now() + 2 * 60_000))).toMatchObject({ claimed: 1 });
  });

  it('reconciles every bot, page after page, not only the first page (Codex #1)', async () => {
    await lane().syncNow(scopeA, BOT_A1);
    await lane().syncNow(scopeB, BOT_B1);
    await db().execute(
      sql`UPDATE bot_instances SET commands_revision = 'old' WHERE id IN (${BOT_A1}, ${BOT_B1})`,
    );
    // A page of ONE: the sweep must go on to the next page to reach the second bot.
    expect(await lane().reconcile(1)).toBe(2);
    expect((await syncRow(BOT_A1))?.next_attempt_at).not.toBeNull();
    expect((await syncRow(BOT_B1))?.next_attempt_at).not.toBeNull();
  });

  it("waits out Telegram's retry_after when it is longer than the back-off (Codex #2)", async () => {
    await api.container.uow.run(scopeA, (tx) =>
      lane().requestSync(scopeA, BOT_A1, { due: true }, tx),
    );
    telegram.failNext('setMyCommands', { kind: 'rate_limit', retryAfter: 120 });
    expect(await lane().tick(new Date())).toMatchObject({ claimed: 1, failed: 1 });
    const row = await syncRow(BOT_A1);
    expect(row?.last_error_code).toBe('telegram.rate_limited');
    const next = new Date(String(row?.next_attempt_at));
    const attempted = new Date(String(row?.last_attempted_at));
    // 120 s, not the first-failure back-off of 30 s.
    expect(next.getTime() - attempted.getTime()).toBe(120_000);
    expect(next.getTime() - attempted.getTime()).toBeGreaterThan(BOT_COMMAND_SYNC_BACKOFF_BASE_MS);
  });

  it('keeps a row due when the description changed while the registration was in flight (Codex #3)', async () => {
    await lane().syncNow(scopeA, BOT_A1);
    const sent = (await desired(scopeA)).hash;
    // Between rendering the list and recording its success, an operator rewords a
    // description and the consumer moves the desired digest on.
    telegram.beforeNext('setMyCommands', async () => {
      await api.container.templatesService.set(scopeA, owner, {
        idempotencyKey: 'reword-in-flight',
        key: 'bot.command.wallet',
        body: 'موجودی و شارژ کیف پول',
        expectedVersion: null,
        expectedRevision: null,
      });
      await api.container.relay.processBatch();
    });
    expect((await lane().syncNow(scopeA, BOT_A1)).outcome).toBe('SYNCED');
    // What was sent is recorded as sent; the newer text is still owed.
    expect(await revisionOf(BOT_A1)).toBe(sent);
    const row = await syncRow(BOT_A1);
    expect(row?.next_attempt_at).not.toBeNull();
    expect(row?.claimed_until).toBeNull();
    expect(row?.desired_hash).not.toBe(sent);
    expect(await lane().tick(new Date(Date.now() + 1_000))).toMatchObject({
      claimed: 1,
      synced: 1,
    });
    expect(
      telegram.registeredCommands(ID_A1).find((entry) => entry.command === 'wallet')?.description,
    ).toBe('موجودی و شارژ کیف پول');
    expect(await revisionOf(BOT_A1)).toBe((await desired(scopeA)).hash);
    expect((await syncRow(BOT_A1))?.next_attempt_at).toBeNull();
  });

  it('records nothing for a claim another worker took over while the call was in flight (Codex #4)', async () => {
    await api.container.uow.run(scopeA, (tx) =>
      lane().requestSync(scopeA, BOT_A1, { due: true }, tx),
    );
    const takeover = async () => {
      // The first worker's lease lapsed and a second worker claimed the row.
      await db().execute(sql`
        UPDATE bot_command_syncs SET claimed_until = now() + interval '10 minutes'
         WHERE bot_instance_id = ${BOT_A1}`);
    };
    // A failure by the stale holder writes nothing on top of the newer claim...
    telegram.beforeNext('setMyCommands', takeover);
    telegram.failNext('setMyCommands', { kind: 'server_error' });
    expect(await lane().tick(new Date())).toMatchObject({ claimed: 1, failed: 1 });
    let row = await syncRow(BOT_A1);
    expect(row).toMatchObject({ attempts: 0, last_error_code: null });
    expect(row?.claimed_until).not.toBeNull();
    // ...and neither does a success: the digest stays the newer holder's to record.
    await db().execute(
      sql`UPDATE bot_command_syncs SET claimed_until = NULL WHERE bot_instance_id = ${BOT_A1}`,
    );
    telegram.beforeNext('setMyCommands', takeover);
    expect(await lane().tick(new Date())).toMatchObject({ claimed: 1, synced: 1 });
    row = await syncRow(BOT_A1);
    expect(row?.last_synced_at).toBeNull();
    expect(await revisionOf(BOT_A1)).toBeNull();
    expect(row?.claimed_until).not.toBeNull();
  });

  it('records no token, no description of Telegram’s and no payload anywhere', async () => {
    const token = telegram.revoke(ID_A1, { keepWebhook: true });
    const secret = token.split(':')[1] as string;
    // The stored token is now stale → 401, whose description quotes the request URL.
    await lane().syncNow(scopeA, BOT_A1);
    const everything = (
      await db().execute<{ blob: string }>(sql`
        SELECT string_agg(row_to_json(a)::text, '') AS blob FROM audit_logs a
        UNION ALL SELECT coalesce(string_agg(row_to_json(o)::text, ''), '') FROM operational_events o
        UNION ALL SELECT coalesce(string_agg(row_to_json(s)::text, ''), '') FROM bot_command_syncs s`)
    ).rows
      .map((row) => row.blob ?? '')
      .join('');
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain('Unauthorized');
    expect((await syncRow(BOT_A1))?.last_error_code).toBe('telegram.rejected.401');
  });

  // -------------------------------------------------------------------------
  // The HTTP surface: `/bot-menu`
  // -------------------------------------------------------------------------

  describe('over HTTP', () => {
    it('reads the whole configuration: items with target and slot, the command list, and each bot’s state', async () => {
      await api.container.settingsService.set(scopeA, owner, {
        idempotencyKey: 'arrange-the-menu',
        key: 'bot.main_menu',
        value: [
          { button: 'wallet', enabled: true, target: 'wallet', appearanceSlot: 'payment' },
          { button: 'help', enabled: false },
        ],
        expectedVersion: null,
      });
      await lane().syncNow(scopeA, BOT_A1);

      const response = await get(BOT_MENU_ROUTES.config, await observerCookie());
      expect(response.statusCode).toBe(200);
      const body = botMenuConfigResponseSchema.parse(response.json());
      expect(
        body.layout.items.map((item) => [item.id, item.order, item.enabled, item.target]),
      ).toEqual([
        ['wallet', 0, true, 'wallet'],
        ['help', 1, false, 'help'],
        ['catalog', 2, true, 'catalog'],
        ['services', 3, true, 'services'],
        ['trial', 4, true, 'trial'],
        ['referral', 5, true, 'referral'],
        ['apps', 6, true, 'apps'],
        ['tickets', 7, true, 'tickets'],
      ]);
      const wallet = body.layout.items[0];
      expect(wallet).toMatchObject({
        appearanceSlot: 'payment',
        defaultAppearanceSlot: 'wallet',
        label: CATALOGUE_FA['bot.menu.wallet'],
        defaultLabel: CATALOGUE_FA['bot.menu.wallet'],
        labelOverridden: false,
        gate: null,
        shownNow: true,
      });
      // The referral button is on, its flag is off: gated, not shown — no dead button.
      expect(body.layout.items.find((item) => item.id === 'referral')).toMatchObject({
        gate: 'FEATURE',
        gateOpen: false,
        shownNow: false,
      });
      // The trial is on, no panel offers one: gated by the offer, not shown.
      expect(body.layout.items.find((item) => item.id === 'trial')).toMatchObject({
        gate: 'TRIAL_OFFER',
        gateOpen: false,
        shownNow: false,
      });
      expect(body.layout.items.find((item) => item.id === 'help')?.shownNow).toBe(false);
      // The keyboard is the bot's own rows: wallet first, no help, no gated button.
      expect(body.keyboard.flat()).toEqual([
        CATALOGUE_FA['bot.menu.wallet'],
        CATALOGUE_FA['bot.menu.catalog'],
        CATALOGUE_FA['bot.menu.services'],
        CATALOGUE_FA['bot.menu.apps'],
        CATALOGUE_FA['bot.menu.tickets'],
      ]);
      expect(body.commands.entries.map((entry) => entry.command)).toEqual(
        BOT_COMMANDS.map((entry) => entry.command),
      );
      expect(body.commands.hash).toBe((await desired(scopeA)).hash);
      expect(body.bots.map((bot) => [bot.botInstanceId, bot.state])).toEqual([
        [BOT_A1, 'CURRENT'],
        [BOT_A2, 'STOPPED'],
      ]);
      expect(body.layout.version).not.toBeNull();
      // No credential in any form.
      expect(response.body).not.toContain('token_ciphertext');
    });

    it('refuses a target that is not the button’s, and a slot outside the closed list, at the setting', async () => {
      const cookie = await ownerCookie();
      for (const value of [
        [{ button: 'wallet', enabled: true, target: 'catalog' }],
        [{ button: 'wallet', enabled: true, appearanceSlot: 'sparkle' }],
        [{ button: 'wallet', enabled: true, target: 'admin' }],
      ]) {
        const response = await post(CONTROL_ROUTES.setting('bot.main_menu'), cookie, {
          idempotencyKey: `bad-${JSON.stringify(value)}`,
          value,
          expectedVersion: null,
        });
        expect(response.statusCode, JSON.stringify(value)).toBe(400);
      }
    });

    it('resyncs on request under settings.edit, idempotently, and checks what Telegram holds', async () => {
      const cookie = await ownerCookie();
      const sync = await post(BOT_MENU_ROUTES.sync, cookie, {
        idempotencyKey: 'resync-1',
        botInstanceId: BOT_A1,
      });
      expect(sync.statusCode).toBe(201);
      const body = syncBotMenuResponseSchema.parse(sync.json());
      expect(body.results).toEqual([{ botInstanceId: BOT_A1, outcome: 'SYNCED', errorCode: null }]);
      expect(body.bots.find((bot) => bot.botInstanceId === BOT_A1)?.state).toBe('CURRENT');
      expect(telegram.registeredCommands(ID_A1)).toEqual((await desired(scopeA)).entries);

      // The same key answers the first result and sends nothing again.
      const calls = telegram.calls.length;
      const replay = await post(BOT_MENU_ROUTES.sync, cookie, {
        idempotencyKey: 'resync-1',
        botInstanceId: BOT_A1,
      });
      expect(replay.json()).toEqual(sync.json());
      expect(telegram.calls.length).toBe(calls);

      // «بررسی وضعیت»: a read that matches, then one that does not after Telegram drifted.
      const check = checkBotMenuResponseSchema.parse(
        (await post(BOT_MENU_ROUTES.check, cookie, { botInstanceId: BOT_A1 })).json(),
      );
      expect(check.checks).toEqual([
        {
          botInstanceId: BOT_A1,
          outcome: 'READ',
          matches: true,
          registered: (await desired(scopeA)).entries,
        },
      ]);
      await telegram.close();
      telegram = await startFakeTelegramBotApi();
      // A fresh fake on a new port is unreachable from the app's configured base: UNREACHABLE.
      const unreachable = checkBotMenuResponseSchema.parse(
        (await post(BOT_MENU_ROUTES.check, cookie, { botInstanceId: BOT_A1 })).json(),
      );
      expect(unreachable.checks[0]?.outcome).toBe('UNREACHABLE');
    });

    it('charges settings.edit for the two actions, and answers another tenant’s bot as not found', async () => {
      const observer = await observerCookie();
      for (const path of [BOT_MENU_ROUTES.sync, BOT_MENU_ROUTES.check]) {
        const response = await post(path, observer, {
          idempotencyKey: 'observer-tries',
          botInstanceId: BOT_A1,
        });
        expect(response.statusCode, path).toBe(403);
      }
      expect(telegram.calls.filter((call) => call.method === 'setMyCommands')).toHaveLength(0);
      const denied = await db().execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM audit_logs WHERE result = 'DENIED' AND action LIKE 'bot_menu.%'`);
      expect(denied.rows[0]?.n).toBe(2);

      const owner = await ownerCookie();
      const foreign = await post(BOT_MENU_ROUTES.sync, owner, {
        idempotencyKey: 'foreign-bot',
        botInstanceId: BOT_B1,
      });
      expect(foreign.statusCode).toBe(404);
      expect((foreign.json() as { error: { code: string } }).error.code).toBe(
        BOT_ERROR_CODES.BOT_NOT_FOUND,
      );
      // A stopped bot is skipped, never dialled.
      const stoppedResponse = await post(BOT_MENU_ROUTES.sync, owner, {
        idempotencyKey: 'stopped-bot-sync',
        botInstanceId: BOT_A2,
      });
      expect(stoppedResponse.statusCode, stoppedResponse.body).toBe(201);
      const stopped = syncBotMenuResponseSchema.parse(stoppedResponse.json());
      expect(stopped.results).toEqual([
        { botInstanceId: BOT_A2, outcome: 'SKIPPED', errorCode: null },
      ]);
    });
  });
});
