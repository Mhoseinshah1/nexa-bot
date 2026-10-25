import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorContext, BotInstanceId, CorrelationId, TenantContext } from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { startFakeTelegramBotApi, type FakeTelegramBotApi } from '../support/fake-telegram-bot-api';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  SEED_IDS,
  tenantA,
  testConfig,
} from './harness';

/**
 * Round 9, C5 — the bot's entry to the mini app: Telegram's chat menu button, set by the
 * command-menu sync lane while the `mini_app` flag is on, and taken back to Telegram's
 * default when it is switched off. With the flag off — the default — the lane asks
 * Telegram NOTHING new, and the bot's own replies and keyboards are byte for byte what
 * they were.
 */

const BOT_A1 = SEED_IDS.botA1 as BotInstanceId;
const BOT_A2 = SEED_IDS.botA2 as BotInstanceId;
const ORIGIN = 'https://shop.example.test';

describe('the mini app menu button', () => {
  let api: ApiApp;
  let telegram: FakeTelegramBotApi;
  let owner: ActorContext;
  const scopeA = tenantA as unknown as TenantContext;
  const db = () => api.container.database.db;
  const lane = () => api.container.botCommandSync;
  let keySeq = 0;
  const key = () => `menu-button-${String((keySeq += 1))}`;

  beforeAll(async () => {
    telegram = await startFakeTelegramBotApi();
    const config = testConfig({
      // The installer's reconcile refuses an installation that does not serve the webhook.
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: 'menu-button-webhook-secret-0123456789',
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

  async function bind(botId: BotInstanceId, telegramId: number, username: string): Promise<string> {
    const token = telegram.createBot({ id: telegramId, username });
    const secret = api.container.cipher.encrypt(token, {
      purpose: 'bot_instance.token',
      tenantId: tenantA.tenantId as never,
      entityId: botId,
    });
    await db().execute(sql`
      UPDATE bot_instances
         SET telegram_bot_id = ${String(telegramId)}, username = ${username}, status = 'ACTIVE',
             token_ciphertext = ${secret.ciphertext}, token_key_id = ${secret.keyId},
             commands_revision = NULL,
             webhook_url = ${`${ORIGIN}/telegram/webhook/${botId}`}
       WHERE id = ${botId}`);
    return token;
  }

  async function setFlag(enabled: boolean) {
    const current = await api.container.featureFlagResolver.resolve(scopeA, 'mini_app');
    await api.container.featureFlags.set(scopeA, owner, {
      key: 'mini_app',
      enabled,
      expectedVersion: current.version,
      idempotencyKey: key(),
      reason: 'menu button test',
    });
  }

  const revisionOf = async (botId: BotInstanceId) =>
    (
      await db().execute<{ r: string | null }>(
        sql`SELECT commands_revision AS r FROM bot_instances WHERE id = ${botId}`,
      )
    ).rows[0]?.r ?? null;
  const menuCalls = () => telegram.calls.filter((call) => call.method === 'setChatMenuButton');

  beforeEach(async () => {
    await resetDatabase(db());
    await seed(db(), api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    owner = adminActorFor(
      await createAdmin(api.container, tenantA, { username: 'owner', roleKeys: ['owner'] }),
    );
    telegram.calls.length = 0;
  });

  it('with the flag off (the default) sets no button and asks Telegram nothing new', async () => {
    await bind(BOT_A1, 7300000001, 'nexa_menu_a1_bot');
    expect((await lane().syncNow(scopeA, BOT_A1)).outcome).toBe('SYNCED');
    expect(menuCalls()).toEqual([]);
    expect(telegram.calls.map((call) => call.method)).toEqual(['setMyCommands']);
    expect(await revisionOf(BOT_A1)).toBe(
      (await api.container.commandMenu.desiredFor(scopeA)).hash,
    );
    expect(await revisionOf(BOT_A1)).not.toMatch(/^m/u);
  });

  it('sets the web_app button while on, per bot, and takes it back when switched off', async () => {
    await bind(BOT_A1, 7300000002, 'nexa_menu_b1_bot');
    await lane().syncNow(scopeA, BOT_A1);
    await setFlag(true);
    expect((await lane().syncNow(scopeA, BOT_A1)).outcome).toBe('SYNCED');
    expect(telegram.menuButton(7300000002)).toEqual({
      type: 'web_app',
      text: CATALOGUE_FA['bot.menu.miniapp_button'],
      url: `${ORIGIN}/miniapp/${BOT_A1}/`,
    });
    expect(await revisionOf(BOT_A1)).toMatch(/^m[0-9a-f]{31}$/u);

    // Nothing more is owed: the stored revision is the desired one, so the sweep skips it.
    const view = (await lane().statusFor(scopeA)).find((row) => row.botInstanceId === BOT_A1);
    expect(view?.syncedHash).toBe(view?.desiredHash);

    await setFlag(false);
    expect((await lane().syncNow(scopeA, BOT_A1)).outcome).toBe('SYNCED');
    expect(telegram.menuButton(7300000002)).toEqual({ type: 'default' });
    expect(await revisionOf(BOT_A1)).not.toMatch(/^m/u);
  });

  it('a bootstrap reconcile between switching off and the lane leaves the reset owed', async () => {
    // Codex on #326: the installer registers commands only; storing their plain digest
    // here would erase the `m` the lane needs to know this bot has a button to reset.
    await bind(BOT_A1, 7300000005, 'nexa_menu_e1_bot');
    await setFlag(true);
    expect((await lane().syncNow(scopeA, BOT_A1)).outcome).toBe('SYNCED');
    expect(telegram.menuButton(7300000005)).toMatchObject({ type: 'web_app' });
    const withButton = await revisionOf(BOT_A1);
    expect(withButton).toMatch(/^m/u);

    await setFlag(false);
    telegram.calls.length = 0;
    const result = await api.container.bootstrapBot.execute(
      { tenantId: tenantA.tenantId, botInstanceId: null } as TenantContext,
      { token: null, publicBaseUrl: ORIGIN },
    );
    expect(result.botInstanceId).toBe(BOT_A1);
    expect(telegram.calls.map((call) => call.method)).toContain('setMyCommands');
    expect(menuCalls(), 'the installer never touches the button').toEqual([]);
    expect(await revisionOf(BOT_A1), 'the pending reset survives the installer').toBe(withButton);
    const view = (await lane().statusFor(scopeA)).find((row) => row.botInstanceId === BOT_A1);
    expect(view?.syncedHash, 'the lane still sees the bot owed a sync').not.toBe(view?.desiredHash);

    expect((await lane().syncNow(scopeA, BOT_A1)).outcome).toBe('SYNCED');
    expect(telegram.menuButton(7300000005)).toEqual({ type: 'default' });
    expect(await revisionOf(BOT_A1)).toBe(
      (await api.container.commandMenu.desiredFor(scopeA)).hash,
    );
    expect(await revisionOf(BOT_A1)).not.toMatch(/^m/u);
  });

  it('a refused button is the attempt failing, retried, never recorded as synced', async () => {
    await bind(BOT_A1, 7300000003, 'nexa_menu_c1_bot');
    await setFlag(true);
    telegram.failNext('setChatMenuButton', { kind: 'refuse', description: 'Bad Request' });
    const first = await lane().syncNow(scopeA, BOT_A1);
    expect(first.outcome).toBe('FAILED');
    expect(await revisionOf(BOT_A1)).toBeNull();
  });

  it('the bot answers /start byte for byte the same with the flag on and off', async () => {
    await bind(BOT_A2, 7300000004, 'nexa_menu_d1_bot');
    const actor: ActorContext = {
      type: 'SYSTEM_JOB',
      id: null,
      label: 'telegram-update:test',
      surface: 'WORKER',
      correlationId: 'menu-start' as CorrelationId,
    };
    const start = (updateId: number) => ({
      idempotencyKey: `menu-start-${String(updateId)}`,
      botInstanceId: BOT_A2,
      update: {
        update_id: updateId,
        message: {
          message_id: updateId,
          date: 0,
          chat: { id: 7300000099, type: 'private' },
          from: { id: 7300000099, is_bot: false, first_name: 'x' },
          text: '/start',
        },
      },
      telegramUserId: '7300000099',
      from: { id: 7300000099, first_name: 'x' },
    });
    const scope: TenantContext = { tenantId: tenantA.tenantId as never, botInstanceId: BOT_A2 };
    const sent = () =>
      telegram.calls
        .filter((call) => call.method === 'sendMessage')
        .map((call) => JSON.stringify({ text: call.body.text, markup: call.body.reply_markup }));

    // The first contact is a welcome; the comparison is between two returning /starts.
    await api.container.botRuntime.handle(scope, actor, start(1));
    telegram.calls.length = 0;
    await api.container.botRuntime.handle(scope, actor, start(2));
    const off = sent();
    telegram.calls.length = 0;
    await setFlag(true);
    await api.container.botRuntime.handle(scope, actor, start(3));
    const on = sent();
    expect(off.length).toBeGreaterThan(0);
    expect(on).toEqual(off);
  });
});
