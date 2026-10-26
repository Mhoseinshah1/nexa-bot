import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  customMenuRefOf,
  defaultMainMenuButtonConfig,
  MAIN_MENU_BUTTON_IDS,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  SEED_IDS,
  tenantA,
  type TestContext,
} from './harness';

/**
 * R10 D2 — a tap on an owner-defined main-menu button, end to end: the keyboard the bot draws,
 * the route a label takes, and the answer decided AGAIN from state — through the real runtime
 * and messenger against a capturing HTTP stand-in for the Bot API.
 *
 * The stand-in proves this code and this stand-in agree: that Telegram opens an inline URL
 * button, uploads a multipart photo and shows a reply keyboard is the owner's real-bot
 * acceptance checklist (`docs/project-status.md`, D2).
 */

const BOT_A1 = SEED_IDS.botA1 as BotInstanceId;
const BOT_A2 = SEED_IDS.botA2 as BotInstanceId;
const MARYAM = '910911';

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('UNIQUE-BYTES-OF-THE-STORED-PHOTO'),
]);
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('UNIQUE-STORED-DOCUMENT')]);

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly raw: Buffer;
}

const systemActor = (correlationId: string): ActorContext => ({
  type: 'SYSTEM_JOB',
  id: null,
  label: 'telegram-update:test',
  surface: 'TELEGRAM',
  correlationId: correlationId as CorrelationId,
});

let keyCounter = 0;
const key = () => `custom-runtime-${String((keyCounter += 1)).padStart(8, '0')}`;
const fileOf = (name: string, mimeType: string, bytes: Buffer) => ({
  fileName: name,
  mimeType,
  contentBase64: bytes.toString('base64'),
});

describe('a tap on an owner-defined main-menu button', () => {
  let ctx: TestContext;
  let telegram: Server;
  let sent: Sent[];
  let owner: ActorContext;
  let updateSeq = 0;
  /** When set, a send of this method is refused as Telegram refuses a broken image. */
  let refuse: string | null = null;
  let ids: { text: string; link: string; photo: string; document: string };

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
        sent.push({ url: request.url ?? '', body, raw: Buffer.concat(chunks) });
        if (refuse !== null && String(request.url).includes(`/${refuse}`)) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: 'Bad Request: IMAGE_PROCESS_FAILED',
            }),
          );
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result: { message_id: 11 } }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    ctx = await createTestContext({
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  const db = () => ctx.container.database.db;

  beforeEach(async () => {
    await ctx.reset();
    ctx.container.setInstallationTenant(tenantA.tenantId);
    sent = [];
    refuse = null;
    // The second bot of the tenant is stopped in the seed; the wrong-bot case needs it live.
    await db().execute(sql`UPDATE bot_instances SET status = 'ACTIVE' WHERE id = ${BOT_A2}`);
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-custom', roleKeys: ['owner'] }),
    );
    const make = (input: Record<string, unknown>) =>
      ctx.container.customMenuButtons.create(tenantA, owner, { idempotencyKey: key(), ...input });
    const text = await make({
      label: 'قوانین ما',
      kind: 'TEXT',
      body: 'قوانین: <b>ادب</b> *را* رعایت کنید',
    });
    const link = await make({
      label: 'کانال ما',
      kind: 'LINK',
      url: 'HTTPS://T.me/acme_channel',
      body: 'به کانال بپیوندید',
    });
    const photo = await make({
      label: 'لوگو',
      kind: 'PHOTO',
      body: 'لوگوی ما',
      file: fileOf('logo.png', 'image/png', PNG_BYTES),
    });
    const document = await make({
      label: 'راهنما',
      kind: 'DOCUMENT',
      file: fileOf('guide.pdf', 'application/pdf', PDF_BYTES),
    });
    ids = {
      text: text.button.id,
      link: link.button.id,
      photo: photo.button.id,
      document: document.button.id,
    };
    await setFlag(true);
    await publishLayout(Object.values(ids));
    sent.length = 0;
  });

  async function setFlag(enabled: boolean) {
    const current = await ctx.container.featureFlagResolver.resolve(tenantA, 'custom_menu_buttons');
    await ctx.container.featureFlags.set(tenantA, owner, {
      key: 'custom_menu_buttons',
      enabled,
      expectedVersion: current.version,
      idempotencyKey: key(),
      reason: 'custom menu buttons test',
    });
  }

  async function publishLayout(buttonIds: readonly string[]) {
    const version =
      (
        await db().execute<{ version: number }>(
          sql`SELECT version FROM setting_values
               WHERE tenant_id = ${tenantA.tenantId} AND setting_key = 'bot.main_menu'`,
        )
      ).rows[0]?.version ?? null;
    const refs = buttonIds.map((id) => customMenuRefOf(id));
    const draft = (await ctx.container.botMenuBuilder.view(tenantA, owner)).draft.version;
    const saved = await ctx.container.botMenuBuilder.saveDraft(tenantA, owner, {
      idempotencyKey: key(),
      expectedDraftVersion: draft,
      layout: {
        v: 2,
        rows: [['catalog', 'services'], ...refs.map((ref) => [ref])],
        buttons: MAIN_MENU_BUTTON_IDS.map((id) => defaultMainMenuButtonConfig(id)),
        customButtons: refs.map((ref, index) => ({
          ref,
          enabled: true,
          style: index === 0 ? 'primary' : 'default',
        })),
      },
      legacyBaselineVersion: version,
    });
    const view = await ctx.container.botMenuBuilder.view(tenantA, owner);
    await ctx.container.botMenuBuilder.publish(tenantA, owner, {
      idempotencyKey: key(),
      expectedDraftVersion: saved.head.draft.version ?? 1,
      expectedPublishedRevision: view.published?.revision ?? null,
    });
  }

  const say = (value: string, bot: BotInstanceId = BOT_A1) => {
    updateSeq += 1;
    return ctx.container.botRuntime.handle(tenantA, systemActor('bot'), {
      idempotencyKey: `custom-runtime-update-${String(updateSeq)}`,
      botInstanceId: bot,
      update: {
        update_id: 800_000 + updateSeq,
        message: {
          message_id: updateSeq,
          date: 0,
          chat: { id: Number(MARYAM), type: 'private' },
          from: { id: Number(MARYAM), is_bot: false, first_name: 'مریم' },
          text: value,
        },
      },
      telegramUserId: MARYAM,
      from: { id: Number(MARYAM), first_name: 'مریم' },
    });
  };
  const messages = () => sent.filter((one) => one.url.includes('/sendMessage'));
  const lastMessage = () => messages().at(-1);
  const keyboardTexts = (message: Sent | undefined) =>
    (
      (message?.body['reply_markup'] as { keyboard?: { text: string }[][] } | undefined)
        ?.keyboard ?? []
    ).map((row) => row.map((button) => button.text));
  const rowCount = async (table: string) =>
    Number(
      (await db().execute<{ n: string }>(sql.raw(`SELECT count(*)::text AS n FROM ${table}`)))
        .rows[0]?.n,
    );

  it('draws the owner’s buttons on the keyboard, with their style', async () => {
    await say('/start');
    const keyboard = (
      lastMessage()?.body['reply_markup'] as { keyboard: Record<string, unknown>[][] }
    ).keyboard;
    expect(keyboardTexts(lastMessage())).toEqual([
      [CATALOGUE_FA['bot.menu.catalog'], CATALOGUE_FA['bot.menu.services']],
      ['قوانین ما'],
      ['کانال ما'],
      ['لوگو'],
      ['راهنما'],
    ]);
    expect(keyboard[1]?.[0]).toEqual({ text: 'قوانین ما', style: 'primary' });
  });

  it('draws a button scoped to bot A1 there and not on bot A2', async () => {
    await ctx.container.customMenuButtons.update(tenantA, owner, ids.link, {
      idempotencyKey: key(),
      expectedVersion: 1,
      botScope: 'SELECTED',
      botInstanceIds: [SEED_IDS.botA1],
    });
    await say('/start', BOT_A1);
    expect(keyboardTexts(lastMessage()).flat()).toContain('کانال ما');
    await say('/start', BOT_A2);
    expect(keyboardTexts(lastMessage()).flat()).not.toContain('کانال ما');
    expect(keyboardTexts(lastMessage()).flat()).toContain('قوانین ما');
  });

  it('draws no custom button, and answers a stale tap as unavailable, while the flag is off', async () => {
    await setFlag(false);
    await say('/start');
    expect(keyboardTexts(lastMessage()).flat()).not.toContain('قوانین ما');
    const turn = await say('قوانین ما');
    expect(turn.intent).toBe('CUSTOM_MENU_BUTTON');
    expect(turn.replyKey).toBe('bot.custom_button.unavailable');
    expect(String(lastMessage()?.body['text'])).toBe(CATALOGUE_FA['bot.custom_button.unavailable']);
    expect(String(lastMessage()?.body['text'])).not.toContain('ادب');
  });

  it('sends a text button’s words as PLAIN text, markup and all', async () => {
    const turn = await say('قوانین ما');
    expect(turn).toMatchObject({
      intent: 'CUSTOM_MENU_BUTTON',
      replyKey: 'bot.custom_button.text',
    });
    expect(messages()).toHaveLength(1);
    const message = lastMessage();
    expect(message?.body['text']).toBe('قوانین: <b>ادب</b> *را* رعایت کنید');
    // No parse mode: the operator cannot inject markup.
    expect(message?.body['parse_mode']).toBeUndefined();
    expect(message?.body['entities'] ?? null).toBeNull();
  });

  it('answers a link button with ONE inline URL button holding the stored, normalised address', async () => {
    const turn = await say('کانال ما');
    expect(turn.replyKey).toBe('bot.custom_button.link');
    const markup = lastMessage()?.body['reply_markup'] as {
      inline_keyboard: { text: string; url?: string }[][];
    };
    const buttons = markup.inline_keyboard.flat();
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.url).toBe('https://t.me/acme_channel');
    expect(buttons[0]?.text).toBe(CATALOGUE_FA['bot.custom_button.open_link_button']);
    expect(String(lastMessage()?.body['text'])).toContain('به کانال بپیوندید');
  });

  it('uploads a photo’s stored BYTES as multipart with its caption, never by file id', async () => {
    const turn = await say('لوگو');
    expect(turn.replyKey).toBe('bot.custom_button.caption');
    const photo = sent.find((one) => one.url.includes('/sendPhoto'));
    expect(photo, 'the photo is sent').toBeDefined();
    expect(photo?.raw.includes(PNG_BYTES), 'the stored bytes are in the upload').toBe(true);
    expect(photo?.raw.toString('latin1')).toContain('name="caption"');
    expect(photo?.raw.includes(Buffer.from('لوگوی ما'))).toBe(true);
    expect(messages()).toHaveLength(0);
  });

  it('uploads a document’s stored bytes, bare when it has no caption', async () => {
    await say('راهنما');
    const document = sent.find((one) => one.url.includes('/sendDocument'));
    expect(document?.raw.includes(PDF_BYTES)).toBe(true);
    expect(document?.raw.toString('latin1')).not.toContain('name="caption"');
  });

  it('falls back to the caption as text when Telegram refuses the image, and to "unavailable" with none', async () => {
    refuse = 'sendPhoto';
    await say('لوگو');
    expect(String(lastMessage()?.body['text'])).toBe('لوگوی ما');
    refuse = 'sendDocument';
    sent.length = 0;
    await say('راهنما');
    expect(String(lastMessage()?.body['text'])).toBe(CATALOGUE_FA['bot.custom_button.unavailable']);
  });

  it('answers a tap from a bot the button is not shown on as unavailable, sending nothing of the button', async () => {
    await ctx.container.customMenuButtons.update(tenantA, owner, ids.text, {
      idempotencyKey: key(),
      expectedVersion: 1,
      botScope: 'SELECTED',
      botInstanceIds: [SEED_IDS.botA1],
    });
    const turn = await say('قوانین ما', BOT_A2);
    expect(turn.replyKey).toBe('bot.custom_button.unavailable');
    expect(String(lastMessage()?.body['text'])).not.toContain('ادب');
    const ok = await say('قوانین ما', BOT_A1);
    expect(ok.replyKey).toBe('bot.custom_button.text');
  });

  it('answers a keyboard drawn before an archive as unavailable, and never sends the archived content', async () => {
    await say('/start');
    await ctx.container.customMenuButtons.archive(tenantA, owner, ids.photo, {
      idempotencyKey: key(),
      expectedVersion: 1,
    });
    sent.length = 0;
    const turn = await say('لوگو');
    expect(turn.replyKey).toBe('bot.custom_button.unavailable');
    expect(sent.some((one) => one.url.includes('/sendPhoto'))).toBe(false);
  });

  it('answers unavailable for a button the published layout does not place', async () => {
    await publishLayout([ids.text]);
    const turn = await say('کانال ما');
    expect(turn.replyKey).toBe('bot.custom_button.unavailable');
    expect((await say('قوانین ما')).replyKey).toBe('bot.custom_button.text');
  });

  it('routes nothing for typed text that merely reads mb:<id>', async () => {
    const turn = await say(`mb:${ids.text}`);
    // Free text, as any text that is neither a command nor a label: never the button.
    expect(turn.intent).toBe('USERNAME_TEXT');
    expect(String(turn.replyKey)).not.toMatch(/^bot\.custom_button\./u);
    expect(sent.some((one) => one.url.includes('/sendPhoto'))).toBe(false);
  });

  it('lets a registry label win over a custom label added later with the same name', async () => {
    // The owner renames a registry button onto a custom label afterwards: the registry wins.
    await ctx.container.templatesService.set(tenantA, owner, {
      idempotencyKey: key(),
      key: 'bot.menu.help',
      body: 'قوانین ما',
      expectedVersion: null,
      expectedRevision: null,
    });
    const turn = await say('قوانین ما');
    expect(turn.intent).toBe('HELP');
  });

  it('writes no order, wallet, payment or notification row, and no second customer, for a tap', async () => {
    await say('/start');
    const tables = [
      'orders',
      'wallet_entries',
      'payments',
      'customer_notifications',
      'notifications',
    ];
    const before = await Promise.all(tables.map(rowCount));
    for (const label of ['قوانین ما', 'کانال ما', 'لوگو', 'راهنما']) await say(label);
    expect(await Promise.all(tables.map(rowCount))).toEqual(before);
  });
});
