import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  TELEGRAM_SECRET_TOKEN_HEADER,
  defaultMainMenuButtonConfig,
  type ActorContext,
  type BotInstanceId,
  type ExplicitMainMenu,
  type TemplateKey,
  type TenantContext,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { APPEARANCE_DECORATION_FAILED_CODE } from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';
import {
  FAKE_KEYBOARD_INVALID,
  startFakeTelegramBotApi,
  type FakeTelegramBotApi,
  type FakeTelegramFault,
} from '../support/fake-telegram-bot-api';
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
 * Round T (T2) — the customer reply keyboard, end to end: a published layout read by the
 * runtime, its styles and per-BOT icons on the wire, the one-shot icon fallback, and the
 * UNKNOWN discipline, through the real app against the shared HTTP fake of the Bot API
 * (`tests/support/fake-telegram-bot-api.ts`, which now models `sendMessage`).
 *
 * The fake can only prove that this code and this fake agree. What Telegram itself does with
 * a style, an icon from an ineligible bot, and a tap on an iconed button is the real-bot
 * acceptance checklist (`docs/round-t-button-builder-audit.md` §13, R-ACC-1..3).
 */

const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-the-keyboard';
const ORIGIN = 'https://admin.example.test';
const BOT_A1 = SEED_IDS.botA1 as BotInstanceId;
const BOT_A2 = SEED_IDS.botA2 as BotInstanceId;
const BOT_B1 = SEED_IDS.botB1 as BotInstanceId;
const ID_A1 = 7_100_000_001;
const ID_A2 = 7_100_000_002;
const ID_B1 = 7_100_000_003;
const WALLET_ICON = '5368324170671202286';
const label = (key: TemplateKey) => (CATALOGUE_FA as Record<string, string>)[key] ?? '';

/** A published arrangement the legacy packing could never draw, with styles and icons. */
function layout(): ExplicitMainMenu {
  return {
    v: 1,
    rows: [['wallet', 'catalog', 'services'], ['help']],
    buttons: [
      { ...defaultMainMenuButtonConfig('wallet'), style: 'success', iconSlot: 'wallet' },
      { ...defaultMainMenuButtonConfig('catalog'), style: 'primary' },
      { ...defaultMainMenuButtonConfig('services'), style: 'danger' },
      // An icon slot with no custom emoji configured: never an icon.
      { ...defaultMainMenuButtonConfig('help'), iconSlot: 'support' },
      defaultMainMenuButtonConfig('trial'),
      defaultMainMenuButtonConfig('referral'),
      defaultMainMenuButtonConfig('apps'),
      defaultMainMenuButtonConfig('tickets'),
    ],
  };
}

const PUBLISHED_PLAIN = [
  [
    { text: label('bot.menu.wallet'), style: 'success' },
    { text: label('bot.menu.catalog'), style: 'primary' },
    { text: label('bot.menu.services'), style: 'danger' },
  ],
  [{ text: label('bot.menu.help') }],
];
const PUBLISHED_ICONED = [
  [
    { ...PUBLISHED_PLAIN[0]![0]!, icon_custom_emoji_id: WALLET_ICON },
    ...PUBLISHED_PLAIN[0]!.slice(1),
  ],
  PUBLISHED_PLAIN[1]!,
];

describe('the customer reply keyboard on the wire (round T, T2)', () => {
  let api: ApiApp;
  let telegram: FakeTelegramBotApi;
  let owner: ActorContext;
  let ownerB: ActorContext;
  let keyCounter = 0;
  const key = (prefix: string) => `${prefix}-${String((keyCounter += 1)).padStart(8, '0')}`;
  const db = () => api.container.database.db;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

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

  /** Binds a seeded bot row to a fake Telegram bot, ACTIVE, its eligibility test as stated. */
  async function bind(
    botId: BotInstanceId,
    tenantId: string,
    telegramId: number,
    username: string,
    tested: 'SENT' | null,
  ): Promise<void> {
    const token = telegram.createBot({ id: telegramId, username });
    const secret = api.container.cipher.encrypt(token, {
      purpose: 'bot_instance.token',
      tenantId: tenantId as never,
      entityId: botId,
    });
    await db().execute(sql`
      UPDATE bot_instances
         SET telegram_bot_id = ${String(telegramId)}, username = ${username}, status = 'ACTIVE',
             token_ciphertext = ${secret.ciphertext}, token_key_id = ${secret.keyId},
             custom_emoji_tested_at = ${tested === null ? null : sql`now()`},
             custom_emoji_test_outcome = ${tested}
       WHERE id = ${botId}`);
  }

  /** Saving a slot through the service also drops the reader's 30-second cache for the tenant. */
  const configureWalletIcon = (scope: TenantContext, actor: ActorContext) =>
    api.container.appearance.saveSlot(scope, actor, 'wallet', {
      idempotencyKey: key('slot'),
      customEmojiId: WALLET_ICON,
      enabled: true,
      expectedVersion: null,
    });

  const publishLayout = async () => {
    const setting = (
      await db().execute<{ version: number }>(
        sql`SELECT version FROM setting_values
             WHERE tenant_id = ${tenantA.tenantId} AND setting_key = 'bot.main_menu'`,
      )
    ).rows[0];
    await api.container.botMenuBuilder.saveDraft(tenantA, owner, {
      idempotencyKey: key('draft'),
      expectedDraftVersion: null,
      layout: layout(),
      legacyBaselineVersion: setting?.version ?? null,
    });
    await api.container.botMenuBuilder.publish(tenantA, owner, {
      idempotencyKey: key('publish'),
      expectedDraftVersion: 1,
      expectedPublishedRevision: null,
    });
  };

  let updateId = 50_000;
  const say = (bot: BotInstanceId, text = '/start') => {
    const id = (updateId += 1);
    return inject({
      method: 'POST',
      url: `/telegram/webhook/${bot}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: {
        update_id: id,
        message: {
          message_id: id,
          date: 0,
          chat: { id: 4242, type: 'private' },
          from: { id: 5551234567, is_bot: false, first_name: 'Ali' },
          text,
        },
      },
    });
  };

  const sends = () => telegram.calls.filter((call) => call.method === 'sendMessage');
  const keyboardOf = (body: Record<string, unknown> | undefined) =>
    (body?.['reply_markup'] as { keyboard?: unknown } | undefined)?.keyboard;
  const testOutcome = async (bot: BotInstanceId) =>
    (
      await db().execute<{ outcome: string | null }>(
        sql`SELECT custom_emoji_test_outcome AS outcome FROM bot_instances WHERE id = ${bot}`,
      )
    ).rows[0]?.outcome ?? null;
  const decorationEvents = async () =>
    (
      await db().execute<{ context: Record<string, unknown> }>(
        sql`SELECT context FROM operational_events WHERE code = ${APPEARANCE_DECORATION_FAILED_CODE}`,
      )
    ).rows;

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
    ownerB = adminActorFor(
      await createAdmin(api.container, tenantB, {
        username: 'owner-b',
        password: 'the-other-owners-password',
        roleKeys: ['owner'],
      }),
    );
    // Two bots of tenant A — one proved eligible, one never tested — and tenant B's, eligible.
    await bind(BOT_A1, SEED_IDS.tenantA, ID_A1, 'acme_store_bot', 'SENT');
    await bind(BOT_A2, SEED_IDS.tenantA, ID_A2, 'acme_support_bot', null);
    await bind(BOT_B1, SEED_IDS.tenantB, ID_B1, 'globex_store_bot', 'SENT');
    // Last, so each tenant's cached decoration is dropped after the rows above changed.
    await configureWalletIcon(tenantA, owner);
    await configureWalletIcon(tenantB, ownerB);
    telegram.calls.length = 0;
  });

  it('keeps a never-published tenant’s keyboard byte for byte on an ELIGIBLE bot: no style, no icon', async () => {
    expect((await say(BOT_A1)).statusCode).toBe(201);
    expect(sends()).toHaveLength(1);
    const markup = sends()[0]?.body['reply_markup'];
    expect(JSON.stringify(markup)).toBe(
      JSON.stringify({
        keyboard: [
          [{ text: label('bot.menu.catalog') }, { text: label('bot.menu.services') }],
          [{ text: label('bot.menu.wallet') }, { text: label('bot.menu.help') }],
          [{ text: label('bot.menu.apps') }],
          [{ text: label('bot.menu.tickets') }],
        ],
        resize_keyboard: true,
        is_persistent: true,
        one_time_keyboard: false,
        selective: false,
      }),
    );
  });

  it('draws the published rows with their styles, and the icon only from the bot that proved eligibility', async () => {
    await publishLayout();
    await say(BOT_A1);
    await say(BOT_A2);
    expect(sends()).toHaveLength(2);
    expect(keyboardOf(sends()[0]?.body)).toEqual(PUBLISHED_ICONED);
    // Same tenant, same layout, same message: the untested bot draws no icon.
    expect(keyboardOf(sends()[1]?.body)).toEqual(PUBLISHED_PLAIN);
    expect(await testOutcome(BOT_A1)).toBe('SENT');
  });

  it('isolates tenants: an eligible bot of a tenant that never published draws its own legacy rows', async () => {
    await publishLayout();
    await say(BOT_B1);
    const keyboard = keyboardOf(sends()[0]?.body) as Record<string, unknown>[][];
    expect(keyboard.flat().every((button) => Object.keys(button).join() === 'text')).toBe(true);
    expect(keyboard[0]).toEqual([
      { text: label('bot.menu.catalog') },
      { text: label('bot.menu.services') },
    ]);
  });

  it('R-3 routes a tap on an iconed, styled button by its label, exactly as the slash command', async () => {
    await publishLayout();
    await say(BOT_A1);
    // The text the ICONED button actually carries on the wire — what a tap sends back.
    const iconed = (keyboardOf(sends()[0]?.body) as Record<string, unknown>[][])
      .flat()
      .find((button) => button['icon_custom_emoji_id'] === WALLET_ICON);
    expect(iconed?.['text']).toBe(label('bot.menu.wallet'));
    telegram.calls.length = 0;
    await say(BOT_A1, String(iconed?.['text']));
    await say(BOT_A1, '/wallet');
    expect(sends()).toHaveLength(2);
    expect(sends()[0]?.body['text']).toBe(sends()[1]?.body['text']);
  });

  it('R-4 a custom-emoji denial: one icon-less retry lands, styles kept, the bot marked REJECTED', async () => {
    await publishLayout();
    telegram.setCustomEmoji(ID_A1, {
      kind: 'REFUSE',
      description: 'Bad Request: CUSTOM_EMOJI_INVALID',
    });
    await say(BOT_A1);
    expect(sends()).toHaveLength(2);
    expect(keyboardOf(sends()[0]?.body)).toEqual(PUBLISHED_ICONED);
    expect(keyboardOf(sends()[1]?.body)).toEqual(PUBLISHED_PLAIN);
    expect(sends()[1]?.body['text']).toBe(sends()[0]?.body['text']);
    expect(telegram.delivered(ID_A1)).toHaveLength(1);
    expect(await testOutcome(BOT_A1)).toBe('REJECTED');
    expect((await decorationEvents())[0]?.context).toMatchObject({
      botInstanceId: BOT_A1,
      eligibilityChanged: true,
    });
    // The next message from that bot carries no icon and needs no retry.
    telegram.calls.length = 0;
    await say(BOT_A1);
    expect(sends()).toHaveLength(1);
    expect(keyboardOf(sends()[0]?.body)).toEqual(PUBLISHED_PLAIN);
  });

  it('a GENERIC 400 on an iconed keyboard: the one retry lands and the bot stays eligible', async () => {
    await publishLayout();
    telegram.failNext('sendMessage', { kind: 'refuse', description: FAKE_KEYBOARD_INVALID });
    await say(BOT_A1);
    expect(sends()).toHaveLength(2);
    expect(keyboardOf(sends()[1]?.body)).toEqual(PUBLISHED_PLAIN);
    expect(await testOutcome(BOT_A1)).toBe('SENT');
    expect((await decorationEvents())[0]?.context).toMatchObject({
      botInstanceId: BOT_A1,
      keyboardIcons: true,
      eligibilityChanged: false,
    });
    // Eligibility unchanged: the next message carries the icon again.
    telegram.calls.length = 0;
    await say(BOT_A1);
    expect(keyboardOf(sends()[0]?.body)).toEqual(PUBLISHED_ICONED);
  });

  describe('inline-button icons (Phase 2 Item 3, bot.inline_button_icons)', () => {
    const MENU_ICON = '5368324170671202290';
    const setIcons = (scope: TenantContext, actor: ActorContext, value: unknown) =>
      api.container.settingsService.set(scope, actor, {
        key: 'bot.inline_button_icons',
        value,
        expectedVersion: null,
        idempotencyKey: key('icons'),
      });
    /** The inline keyboard of the last message a bot sent that carried one. */
    const inlineOf = (bot: number) => {
      const body = [...sends()]
        .reverse()
        .find(
          (call) =>
            String(call.body['chat_id']) === '4242' &&
            call.botId === bot &&
            (call.body['reply_markup'] as { inline_keyboard?: unknown } | undefined)
              ?.inline_keyboard !== undefined,
        )?.body;
      return (body?.['reply_markup'] as { inline_keyboard: Record<string, unknown>[][] })
        ?.inline_keyboard;
    };
    const withoutIcons = (rows: Record<string, unknown>[][] | undefined) =>
      (rows ?? []).map((row) =>
        row.map((cell) => {
          const { icon_custom_emoji_id: _icon, ...rest } = cell;
          return rest;
        }),
      );
    const mainMenuCell = (rows: Record<string, unknown>[][] | undefined) =>
      (rows ?? []).flat().find((cell) => cell['text'] === label('bot.menu.main_button'));

    it('draws the configured icon on the eligible bot only, never on another tenant, and leaves every route as it was', async () => {
      await setIcons(tenantA, owner, { main_menu: MENU_ICON });
      await say(BOT_A1);
      await say(BOT_A1, '/wallet');
      await say(BOT_A2);
      await say(BOT_A2, '/wallet');
      await say(BOT_B1);
      await say(BOT_B1, '/wallet');
      const eligible = inlineOf(ID_A1);
      const untested = inlineOf(ID_A2);
      const otherTenant = inlineOf(ID_B1);
      expect(mainMenuCell(eligible)?.['icon_custom_emoji_id']).toBe(MENU_ICON);
      // The same tenant's never-tested bot, and tenant B's ELIGIBLE bot: no icon at all.
      expect(JSON.stringify(untested)).not.toContain('icon_custom_emoji_id');
      expect(JSON.stringify(otherTenant)).not.toContain('icon_custom_emoji_id');
      // Text and callback data byte for byte the same with and without the icon.
      expect(JSON.stringify(withoutIcons(eligible))).toBe(JSON.stringify(untested));
      // Tenant B reads its own (empty) value.
      expect(
        await api.container.settingsResolver.valueOf(tenantB, 'bot.inline_button_icons'),
      ).toEqual({});
    });

    it('a removed icon falls back to the plain button', async () => {
      await setIcons(tenantA, owner, { main_menu: MENU_ICON });
      await api.container.settingsService.set(tenantA, owner, {
        key: 'bot.inline_button_icons',
        value: {},
        expectedVersion: 1,
        idempotencyKey: key('icons'),
      });
      await say(BOT_A1);
      await say(BOT_A1, '/wallet');
      expect(mainMenuCell(inlineOf(ID_A1))).toBeDefined();
      expect(JSON.stringify(inlineOf(ID_A1))).not.toContain('icon_custom_emoji_id');
    });

    it('refuses an id that is not digits, writes nothing, and audits the change it does accept', async () => {
      for (const bad of ['abc', '', '💰', '1'.repeat(33), ' 1']) {
        await expect(setIcons(tenantA, owner, { main_menu: bad })).rejects.toMatchObject({
          code: 'control.invalid_value',
        });
      }
      await expect(setIcons(tenantA, owner, { 'no.such.button': MENU_ICON })).rejects.toMatchObject(
        { code: 'control.invalid_value' },
      );
      expect(
        await api.container.settingsResolver.valueOf(tenantA, 'bot.inline_button_icons'),
      ).toEqual({});
      await setIcons(tenantA, owner, { main_menu: MENU_ICON });
      const audit = (
        await db().execute<{ entity_id: string; after: { value: unknown } }>(
          sql`SELECT entity_id, after FROM audit_logs
               WHERE tenant_id = ${tenantA.tenantId} AND action = 'settings.set'
                 AND result = 'SUCCESS'`,
        )
      ).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0]?.entity_id).toBe('bot.inline_button_icons');
      expect(audit[0]?.after.value).toEqual({ main_menu: MENU_ICON });
    });

    it('a custom-emoji denial of an iconed inline keyboard: one icon-less retry lands, the bot marked REJECTED', async () => {
      await setIcons(tenantA, owner, { main_menu: MENU_ICON });
      await say(BOT_A1);
      telegram.setCustomEmoji(ID_A1, {
        kind: 'REFUSE',
        description: 'Bad Request: CUSTOM_EMOJI_INVALID',
      });
      telegram.calls.length = 0;
      await say(BOT_A1, '/wallet');
      const inline = sends().filter(
        (call) =>
          (call.body['reply_markup'] as { inline_keyboard?: unknown } | undefined)
            ?.inline_keyboard !== undefined,
      );
      expect(inline).toHaveLength(2);
      expect(JSON.stringify(inline[0]?.body['reply_markup'])).toContain(MENU_ICON);
      expect(JSON.stringify(inline[1]?.body['reply_markup'])).not.toContain('icon_custom_emoji_id');
      expect(withoutIcons(inlineOf(ID_A1))).toEqual(
        withoutIcons(
          (inline[0]?.body['reply_markup'] as { inline_keyboard: Record<string, unknown>[][] })
            .inline_keyboard,
        ),
      );
      expect(telegram.delivered(ID_A1).length).toBeGreaterThan(0);
      expect(await testOutcome(BOT_A1)).toBe('REJECTED');
    });
  });

  it('R-5 never sends an iconed keyboard twice when the first may have landed, or was not answered', async () => {
    await publishLayout();
    const faults: FakeTelegramFault[] = [
      { kind: 'apply_then_drop' },
      { kind: 'apply_then_garble' },
      { kind: 'drop' },
      { kind: 'server_error' },
      { kind: 'rate_limit', retryAfter: 3 },
    ];
    const botId = ID_A1;
    for (const fault of faults) {
      telegram.calls.length = 0;
      const before = telegram.delivered(botId).length;
      telegram.failNext('sendMessage', fault);
      await say(BOT_A1);
      expect(sends(), fault.kind).toHaveLength(1);
      expect(keyboardOf(sends()[0]?.body), fault.kind).toEqual(PUBLISHED_ICONED);
      const landed = fault.kind === 'apply_then_drop' || fault.kind === 'apply_then_garble' ? 1 : 0;
      expect(telegram.delivered(botId).length - before, fault.kind).toBe(landed);
    }
    expect(await testOutcome(BOT_A1)).toBe('SENT');
    expect(await decorationEvents()).toEqual([]);
  });
});
