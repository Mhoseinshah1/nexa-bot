import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  APPEARANCE_ERROR_CODES,
  APPEARANCE_ROUTES,
  APPEARANCE_SLOTS,
  AUTH_ROUTES,
  CONTROL_ERROR_CODES,
  CONTROL_ROUTES,
  SESSION_COOKIE_NAME,
  appearanceResponseSchema,
  appearanceSlotMutationResponseSchema,
  appearanceTestResponseSchema,
  type BotInstanceId,
  type TenantContext,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { appearanceFallbackText } from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';
import { TelegramCustomerMessenger } from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';
import {
  CachedAppearanceReader,
  DrizzleAppearanceRepository,
} from '../../apps/api/src/modules/control/appearance/infrastructure/drizzle-appearance.repository';
import { DrizzleOperationalConditionReader } from '../../apps/api/src/modules/platform/opslog/infrastructure/drizzle-operational-event.reader';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
  type SeededAdmin,
} from './harness';

/**
 * Premium UI end to end (`docs/premium-ui-audit.md`): the appearance slots over HTTP, the
 * test message through the real transport to a Telegram-shaped server, the verdict recorded
 * per bot, and the customer messenger decorating only after that verdict — through the real
 * repository, the real renderer and the real transport. What Telegram actually answers a bot
 * that may or may not use custom emoji is the operator acceptance's to prove.
 */

const ORIGIN = 'https://admin.example.test';
const OPERATOR_TELEGRAM_ID = '424242';
const ID = '5368324170671202286';
const BOT_A1 = SEED_IDS.botA1 as BotInstanceId;
const BOT_A2 = SEED_IDS.botA2 as BotInstanceId;
const BOT_B1 = SEED_IDS.botB1 as BotInstanceId;

interface Call {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

describe('the bot appearance over HTTP and the messenger (Premium UI)', () => {
  let api: ApiApp;
  let telegram: Server;
  let calls: Call[];
  /** What the fake answers `sendMessage` with next: Telegram's own shapes. */
  let sendAnswer: { status: number; body: Record<string, unknown> };
  let ownerB: SeededAdmin;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  function answer(
    request: IncomingMessage,
    response: ServerResponse,
    body: Record<string, unknown>,
  ) {
    const method = (request.url ?? '').split('/').pop() ?? '';
    calls.push({ method, body });
    if (method === 'sendMessage') {
      response.writeHead(sendAnswer.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(sendAnswer.body));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, result: true }));
  }

  beforeAll(async () => {
    telegram = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        answer(request, response, raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const config = testConfig({
      WEB_ADMIN_ORIGINS: ORIGIN,
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  beforeEach(async () => {
    calls = [];
    sendAnswer = { status: 200, body: { ok: true, result: { message_id: 1 } } };
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
      telegramUserId: OPERATOR_TELEGRAM_ID,
    });
    await createAdmin(api.container, tenantA, {
      username: 'unbound',
      password: 'the-unbound-password',
      roleKeys: ['owner'],
    });
    await createAdmin(api.container, tenantA, {
      username: 'observer',
      password: 'the-observer-password',
      roleKeys: ['observer'],
    });
    ownerB = await createAdmin(api.container, tenantB, {
      username: 'owner-b',
      password: 'the-other-owners-password',
      roleKeys: ['owner'],
      telegramUserId: '777',
    });
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

  const get = (path: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: { cookie, origin: ORIGIN } });
  const post = (path: string, cookie: string, payload: unknown) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: { cookie, origin: ORIGIN },
      payload: payload as never,
    });
  const view = async (cookie: string) =>
    appearanceResponseSchema.parse((await get(APPEARANCE_ROUTES.view, cookie)).json());
  const save = (cookie: string, slot: string, body: Record<string, unknown>) =>
    post(APPEARANCE_ROUTES.slot(slot), cookie, {
      idempotencyKey: `save-${slot}-${String(body.expectedVersion)}-${String(body.customEmojiId)}-${String(body.enabled)}`,
      ...body,
    });

  /** The real messenger over the real appearance rows, as the container builds it. */
  function messenger(scope: TenantContext) {
    const db = api.container.database.db;
    const reader = new CachedAppearanceReader(
      new DrizzleAppearanceRepository(db),
      api.container.clock,
    );
    const built = new TelegramCustomerMessenger(
      api.container.templateResolver,
      api.container.botInstances,
      api.container.opsLog,
      new DrizzleOperationalConditionReader(db),
      api.container.config.TELEGRAM_API_BASE_URL,
      api.container.config.NOTIFICATION_SEND_TIMEOUT_MS,
      undefined,
      reader,
    );
    return {
      send: (botInstanceId: BotInstanceId) =>
        built.send(scope, {
          chatId: '9',
          botInstanceId,
          templateKey: 'bot.order.settled',
          values: {},
        }),
    };
  }

  it('lists every slot as the catalogue fallback, saves one against its version, refuses a stale save, and resets it', async () => {
    const owner = await cookieFor('owner', 'the-owners-real-password');
    const before = await view(owner);
    expect(before.slots.map((slot) => slot.slot)).toEqual([...APPEARANCE_SLOTS]);
    expect(
      before.slots.every(
        (slot) => slot.customEmojiId === null && slot.enabled && slot.version === null,
      ),
    ).toBe(true);
    expect(before.bots.map((bot) => bot.id)).toEqual([BOT_A1, BOT_A2]);
    expect(before.bots.every((bot) => bot.customEmojiTest === null)).toBe(true);
    expect(before.operatorTelegramBound).toBe(true);

    const saved = appearanceSlotMutationResponseSchema.parse(
      (
        await save(owner, 'payment', { customEmojiId: ID, enabled: true, expectedVersion: null })
      ).json(),
    );
    expect(saved).toMatchObject({
      changed: true,
      slot: { slot: 'payment', customEmojiId: ID, version: 1 },
    });
    // Saved again unchanged: no change, no version bump.
    const again = appearanceSlotMutationResponseSchema.parse(
      (
        await save(owner, 'payment', { customEmojiId: ID, enabled: true, expectedVersion: 1 })
      ).json(),
    );
    expect(again).toMatchObject({ changed: false, slot: { version: 1 } });
    // A save built on the version before the last one is a conflict, never an overwrite.
    const stale = await save(owner, 'payment', {
      customEmojiId: '1',
      enabled: false,
      expectedVersion: null,
    });
    expect(stale.statusCode).toBe(409);
    expect((stale.json() as { error: { code: string } }).error.code).toBe(
      CONTROL_ERROR_CODES.VERSION_CONFLICT,
    );
    // A malformed id is refused at the schema.
    expect(
      (await save(owner, 'payment', { customEmojiId: '<b>', enabled: true, expectedVersion: 1 }))
        .statusCode,
    ).toBe(400);
    // An unknown slot is not found.
    expect(
      (await save(owner, 'sparkle', { customEmojiId: ID, enabled: true, expectedVersion: null }))
        .statusCode,
    ).toBe(404);

    const reset = appearanceSlotMutationResponseSchema.parse(
      (
        await post(APPEARANCE_ROUTES.slotReset('payment'), owner, {
          idempotencyKey: 'reset-payment-1',
        })
      ).json(),
    );
    expect(reset).toMatchObject({ changed: true, slot: { customEmojiId: null, version: null } });
    const audited = (await api.container.database.db.execute(
      sql`SELECT action FROM audit_logs WHERE entity_type = 'AppearanceSlot' ORDER BY occurred_at`,
    )) as unknown as { rows: { action: string }[] };
    expect(audited.rows.map((row) => row.action)).toEqual([
      'appearance.slot.set',
      'appearance.slot.reset',
    ]);
  });

  it('charges settings.view for the read and settings.edit for every write', async () => {
    const observer = await cookieFor('observer', 'the-observer-password');
    expect((await get(APPEARANCE_ROUTES.view, observer)).statusCode).toBe(200);
    expect(
      (await save(observer, 'payment', { customEmojiId: ID, enabled: true, expectedVersion: null }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await post(APPEARANCE_ROUTES.test, observer, {
          idempotencyKey: 'test-observer-1',
          botInstanceId: BOT_A1,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('keeps one tenant’s slots and bots from another, and refuses a test through another tenant’s bot', async () => {
    const ownerA = await cookieFor('owner', 'the-owners-real-password');
    await save(ownerA, 'payment', { customEmojiId: ID, enabled: true, expectedVersion: null });
    // The HTTP session belongs to the installation tenant; tenant B is read through the
    // same service the controller calls, as its own administrator.
    const seenByB = await api.container.appearance.view(tenantB, adminActorFor(ownerB));
    expect(seenByB.slots.find((slot) => slot.slot === 'payment')?.customEmojiId).toBeNull();
    expect(seenByB.bots.map((bot) => bot.id)).toEqual([BOT_B1]);
    const crossed = await post(APPEARANCE_ROUTES.test, ownerA, {
      idempotencyKey: 'test-cross-1',
      botInstanceId: BOT_B1,
    });
    expect(crossed.statusCode).toBe(412);
    expect((crossed.json() as { error: { code: string } }).error.code).toBe(
      APPEARANCE_ERROR_CODES.BOT_NOT_ACTIVE,
    );
    expect(calls.filter((call) => call.method === 'sendMessage')).toHaveLength(0);
  });

  it('sends a real decorated test to the operator’s own chat, records Telegram’s answer on THAT bot, and only then decorates', async () => {
    const owner = await cookieFor('owner', 'the-owners-real-password');
    // Nothing configured: the test would prove nothing, and is refused before a request.
    const nothing = await post(APPEARANCE_ROUTES.test, owner, {
      idempotencyKey: 'test-nothing-1',
      botInstanceId: BOT_A1,
    });
    expect(nothing.statusCode).toBe(412);
    expect((nothing.json() as { error: { code: string } }).error.code).toBe(
      APPEARANCE_ERROR_CODES.NOTHING_TO_TEST,
    );

    // `success` is what `bot.order.settled` names; `payment` is configured but switched OFF.
    await save(owner, 'success', { customEmojiId: ID, enabled: true, expectedVersion: null });
    await save(owner, 'payment', { customEmojiId: '77', enabled: false, expectedVersion: null });

    // Before any test: the messenger decorates nothing for either bot.
    const send = messenger(tenantA);
    await send.send(BOT_A1);
    const untested = calls.filter((call) => call.method === 'sendMessage').at(-1);
    expect(untested?.body['text']).toBe(appearanceFallbackText(CATALOGUE_FA['bot.order.settled']));
    expect(untested?.body).not.toHaveProperty('entities');

    // An administrator with no Telegram bound has nowhere to receive the test.
    const unbound = await cookieFor('unbound', 'the-unbound-password');
    const noChat = await post(APPEARANCE_ROUTES.test, unbound, {
      idempotencyKey: 'test-unbound-1',
      botInstanceId: BOT_A1,
    });
    expect(noChat.statusCode).toBe(412);
    expect((noChat.json() as { error: { code: string } }).error.code).toBe(
      APPEARANCE_ERROR_CODES.ADMIN_NOT_BOUND,
    );

    calls = [];
    const tested = appearanceTestResponseSchema.parse(
      (
        await post(APPEARANCE_ROUTES.test, owner, {
          idempotencyKey: 'test-a1-1',
          botInstanceId: BOT_A1,
        })
      ).json(),
    );
    expect(tested.bot.customEmojiTest).toMatchObject({ outcome: 'SENT', errorCode: null });
    // The one decorated slot: `payment` is switched off and stays the fallback.
    expect(tested.decoratedSlots).toBe(1);
    const probe = calls.find((call) => call.method === 'sendMessage');
    expect(probe?.body['chat_id']).toBe(OPERATOR_TELEGRAM_ID);
    expect(probe?.body['text']).toBe(
      appearanceFallbackText(CATALOGUE_FA['bot.appearance.test_message']),
    );
    const entities = probe?.body['entities'] as {
      offset: number;
      length: number;
      custom_emoji_id: string;
    }[];
    expect(entities).toHaveLength(1);
    expect(entities[0]?.custom_emoji_id).toBe(ID);
    expect(
      String(probe?.body['text']).slice(
        entities[0]!.offset,
        entities[0]!.offset + entities[0]!.length,
      ),
    ).toBe('✅');
    // A replay answers the recorded result and sends nothing again.
    const replayed = await post(APPEARANCE_ROUTES.test, owner, {
      idempotencyKey: 'test-a1-1',
      botInstanceId: BOT_A1,
    });
    expect(replayed.statusCode).toBe(201);
    expect(calls.filter((call) => call.method === 'sendMessage')).toHaveLength(1);

    // Now the tested bot decorates; its untested sibling still does not (bot isolation).
    await api.container.database.db.execute(
      sql`UPDATE bot_instances SET status = 'ACTIVE' WHERE id = ${BOT_A2}`,
    );
    calls = [];
    const fresh = messenger(tenantA);
    await fresh.send(BOT_A1);
    await fresh.send(BOT_A2);
    const [decorated, plain] = calls.filter((call) => call.method === 'sendMessage');
    expect(decorated?.body['entities']).toEqual([
      { type: 'custom_emoji', offset: 0, length: 1, custom_emoji_id: ID },
    ]);
    expect(String(decorated?.body['text']).startsWith('✅')).toBe(true);
    expect(String(decorated?.body['text'])).toBe(
      appearanceFallbackText(CATALOGUE_FA['bot.order.settled']),
    );
    expect(plain?.body['text']).toBe(decorated?.body['text']);
    expect(plain?.body).not.toHaveProperty('entities');
  });

  it('records a refusal as the bot’s verdict, keeps decoration off, and never rewrites a tenant’s own body', async () => {
    const owner = await cookieFor('owner', 'the-owners-real-password');
    await save(owner, 'success', { customEmojiId: ID, enabled: true, expectedVersion: null });
    sendAnswer = {
      status: 400,
      body: { ok: false, error_code: 400, description: 'Bad Request: CUSTOM_EMOJI_INVALID' },
    };
    const rejected = appearanceTestResponseSchema.parse(
      (
        await post(APPEARANCE_ROUTES.test, owner, {
          idempotencyKey: 'test-a1-rejected',
          botInstanceId: BOT_A1,
        })
      ).json(),
    );
    expect(rejected.bot.customEmojiTest).toMatchObject({
      outcome: 'REJECTED',
      errorCode: 'appearance.custom_emoji_refused',
    });
    const stored = (await api.container.database.db.execute(
      sql`SELECT custom_emoji_test_outcome AS outcome, custom_emoji_test_error_code AS code FROM bot_instances WHERE id = ${BOT_A1}`,
    )) as unknown as { rows: { outcome: string; code: string }[] };
    expect(stored.rows[0]).toEqual({
      outcome: 'REJECTED',
      code: 'appearance.custom_emoji_refused',
    });

    sendAnswer = { status: 200, body: { ok: true, result: { message_id: 2 } } };
    calls = [];
    await messenger(tenantA).send(BOT_A1);
    expect(calls.at(-1)?.body).not.toHaveProperty('entities');

    // Accepted on the next test: the verdict moves to SENT.
    const accepted = appearanceTestResponseSchema.parse(
      (
        await post(APPEARANCE_ROUTES.test, owner, {
          idempotencyKey: 'test-a1-accepted',
          botInstanceId: BOT_A1,
        })
      ).json(),
    );
    expect(accepted.bot.customEmojiTest?.outcome).toBe('SENT');

    // A tenant-authored body with no marker is sent exactly as written — no emoji, no entity —
    // even though the bot is eligible and the slot is configured.
    const custom = 'پرداخت شما تأیید شد. سپاس.';
    const overridden = await inject({
      method: 'POST',
      url: `${API_PREFIX}${CONTROL_ROUTES.template('bot.order.settled')}`,
      headers: { cookie: owner, origin: ORIGIN },
      payload: {
        idempotencyKey: 'override-settled-1',
        body: custom,
        expectedVersion: null,
        expectedRevision: null,
      },
    });
    expect(overridden.statusCode).toBeLessThan(300);
    calls = [];
    await messenger(tenantA).send(BOT_A1);
    const sent = calls.at(-1);
    expect(sent?.body['text']).toBe(custom);
    expect(sent?.body).not.toHaveProperty('entities');
    // And a preview of the DEFAULT body shows the fallback emoji, never the marker.
    const preview = await inject({
      method: 'POST',
      url: `${API_PREFIX}${CONTROL_ROUTES.templatePreview('bot.order.settled')}`,
      headers: { cookie: owner, origin: ORIGIN },
      payload: { body: CATALOGUE_FA['bot.order.settled'], values: {} },
    });
    expect((preview.json() as { rendered: string }).rendered).toBe(
      appearanceFallbackText(CATALOGUE_FA['bot.order.settled']),
    );
  });
});
