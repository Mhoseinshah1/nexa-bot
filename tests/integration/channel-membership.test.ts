import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CHANNEL_MEMBERSHIP_RECOVERED_CODE,
  CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE,
  EMPTY_PRODUCT_DISPLAY,
  money,
  TELEGRAM_SECRET_TOKEN_HEADER,
  type ActorContext,
  type BotInstanceId,
  type PanelId,
  type ProductCategoryId,
  type ProductId,
  type TelegramChannel,
  type TenantContext,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { DrizzleProductRepository } from '../../apps/api/src/modules/commerce/catalog/infrastructure/drizzle-product.repository';
import { startFakeMarzban, type FakeMarzban } from '../support/fake-marzban';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
  validatePanelConnection,
} from './harness';

/**
 * Package B — mandatory channel membership, end to end
 * (`docs/package-b-channel-membership-audit.md`, brief B7).
 *
 * The real app over a real database; Telegram is a fake that answers `getChatMember` from
 * `membership` (chat id → user id → status) and records every call. Updates arrive on the
 * bot's authenticated webhook, so the guard, the cache and the fail-open condition are the
 * production code.
 *
 * The service's cache and its once-a-minute condition throttle live in the process for the
 * whole file, so every case uses its own Telegram user and, where a condition is asserted,
 * its own channel.
 */

const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-channels';
const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;

interface Call {
  readonly method: string;
  readonly token: string;
  readonly body: Record<string, unknown>;
}

type Status = 'creator' | 'administrator' | 'member' | 'restricted' | 'left' | 'kicked';

describe('mandatory channel membership (Package B)', () => {
  let api: ApiApp;
  let telegram: Server;
  let calls: Call[] = [];
  /** chat id → Telegram user id → what `getChatMember` answers. Absent is `left`. */
  let membership = new Map<string, Map<number, { status: Status; is_member?: boolean }>>();
  /** chat ids `getChatMember` fails on, with the HTTP status to fail with. */
  let failing = new Map<string, number>();
  let owner: ActorContext;
  let ownerB: ActorContext;
  let panel: FakeMarzban | null = null;
  let updateId = 90_000;
  let messageId = 900;
  let nextUser = 700_000;
  let keys = 0;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const [, tokenPart = '', method = ''] = (request.url ?? '').split('/');
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = {};
        }
        calls.push({ method, token: tokenPart.replace(/^bot/u, ''), body });
        if (method === 'getChatMember') {
          const chat = String(body.chat_id);
          const status = failing.get(chat);
          if (status !== undefined) {
            response.writeHead(status, { 'content-type': 'application/json' });
            response.end(
              JSON.stringify({
                ok: false,
                error_code: status,
                description: 'Forbidden: bot is not a member',
              }),
            );
            return;
          }
          const member = membership.get(chat)?.get(Number(body.user_id)) ?? { status: 'left' };
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ ok: true, result: { user: { id: body.user_id }, ...member } }),
          );
          return;
        }
        const result = method === 'answerCallbackQuery' ? true : { message_id: (messageId += 1) };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true, result }));
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    const config = testConfig({
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await panel?.close();
    await api?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
  });

  beforeEach(async () => {
    await panel?.close();
    panel = null;
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    calls = [];
    membership = new Map();
    failing = new Map();
    owner = adminActorFor(
      await createAdmin(api.container, tenantA, {
        username: 'owner-channels',
        roleKeys: ['owner'],
      }),
    );
    ownerB = adminActorFor(
      await createAdmin(api.container, tenantB, {
        username: 'owner-channels-b',
        roleKeys: ['owner'],
      }),
    );
  });

  // -------------------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------------------

  const user = () => (nextUser += 1);

  async function channels(value: readonly TelegramChannel[], scope: TenantContext = tenantA) {
    await api.container.settingsService.set(scope, scope === tenantA ? owner : ownerB, {
      idempotencyKey: `channels-${String((keys += 1))}`,
      key: 'telegram.channels',
      value,
      expectedVersion: null,
    });
  }

  function member(chat: string, telegramUserId: number, status: Status, isMember?: boolean) {
    const chatMap = membership.get(chat) ?? new Map();
    chatMap.set(
      telegramUserId,
      isMember === undefined ? { status } : { status, is_member: isMember },
    );
    membership.set(chat, chatMap);
  }

  const webhook = (bot: BotInstanceId, update: Record<string, unknown>) =>
    inject({
      method: 'POST',
      url: `/telegram/webhook/${bot}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: { update_id: (updateId += 1), ...update },
    });

  /** Sends text; answers what the bot sent back, as `sendMessage` bodies. */
  async function say(from: number, text: string, bot: BotInstanceId = BOT_A) {
    calls = [];
    await webhook(bot, {
      message: {
        message_id: (messageId += 1),
        date: 0,
        chat: { id: from, type: 'private' },
        from: { id: from, is_bot: false, first_name: 'Customer' },
        text,
      },
    });
    return calls.filter((call) => call.method === 'sendMessage').map((call) => call.body);
  }

  async function tap(from: number, data: string, bot: BotInstanceId = BOT_A) {
    calls = [];
    await webhook(bot, {
      callback_query: {
        id: `cbq-${String(updateId)}`,
        from: { id: from, is_bot: false, first_name: 'Customer' },
        chat_instance: 'ci',
        message: {
          message_id: (messageId += 1),
          date: 0,
          chat: { id: from, type: 'private' },
          from: { id: 999999, is_bot: true, first_name: 'Nexa' },
          text: 'x',
        },
        data,
      },
    });
    return calls.filter((call) => call.method === 'sendMessage').map((call) => call.body);
  }

  const textOf = (bodies: readonly Record<string, unknown>[]) => bodies.map((body) => body.text);

  /** Every inline button of the replies, flattened. */
  const buttonsOf = (bodies: readonly Record<string, unknown>[]) =>
    bodies.flatMap((body) => {
      const markup = body.reply_markup as
        | { inline_keyboard?: { text: string; url?: string; callback_data?: string }[][] }
        | undefined;
      return (markup?.inline_keyboard ?? []).flat();
    });

  const JOIN = CATALOGUE_FA['bot.channels.join_required'];
  const STILL = CATALOGUE_FA['bot.channels.still_missing'];
  const WELCOME_BACK = CATALOGUE_FA['bot.start.welcome_back'];

  async function rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
    return (await api.container.database.db.execute(query)).rows as T[];
  }

  const orderCount = async () =>
    Number(
      (
        await rows<{ n: string }>(
          sql`SELECT count(*)::text AS n FROM orders WHERE tenant_id = ${tenantA.tenantId}`,
        )
      )[0]?.n,
    );

  const conditions = () =>
    rows<{ code: string; resolved_at: Date | null; dedupe_key: string }>(
      sql`SELECT code, resolved_at, dedupe_key FROM operational_events
          WHERE tenant_id = ${tenantA.tenantId} AND code IN (${CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE}, ${CHANNEL_MEMBERSHIP_RECOVERED_CODE})
          ORDER BY first_seen_at`,
    );

  /** An ACTIVE product on a validated Marzban panel; the tap on it drafts an order. */
  async function product(): Promise<string> {
    panel = await startFakeMarzban({ host: '127.0.0.2' });
    const created = await api.container.panels.create(tenantA, owner, {
      name: 'Marzban A',
      providerType: 'marzban',
      baseUrl: panel.baseUrl,
      credentials: { username: panel.username, password: panel.password },
      activation: { proxyProtocols: ['vless'], inboundTags: { vless: ['VLESS TCP'] } },
      idempotencyKey: 'panel-channels-create',
    });
    await validatePanelConnection(api.container, tenantA, created.view.panel.id);
    const products = new DrizzleProductRepository(api.container.database.db);
    const row = await products.create(tenantA, {
      id: api.container.ids.uuid() as ProductId,
      draft: {
        title: 'پلن کانال',
        description: null,
        audience: 'EVERYONE',
        sortOrder: 10,
        panelId: created.view.panel.id as PanelId,
        categoryId: SEED_IDS.categoryA as ProductCategoryId,
        specification: { durationDays: 30, trafficBytes: 53_687_091_200n, deviceLimit: null },
        price: money(200_000n, 'IRT'),
        display: EMPTY_PRODUCT_DISPLAY,
      },
      now: api.container.clock.now(),
    });
    await products.setStatus(tenantA, row.id, 'INACTIVE', 'ACTIVE', api.container.clock.now());
    return row.id;
  }

  // =====================================================================================

  it('lets a customer in every required channel through, and asks with the receiving bot’s token', async () => {
    const customer = user();
    await channels([
      { handle: '@nexa_all_one', mandatory: true },
      { chatId: '-1001000000001', joinUrl: 'https://t.me/+PrivateAll', mandatory: true },
    ]);
    member('@nexa_all_one', customer, 'member');
    member('-1001000000001', customer, 'administrator');
    const replies = await say(customer, '/start');
    expect(textOf(replies)).not.toContain(JOIN);
    const asked = calls.filter((call) => call.method === 'getChatMember');
    expect(asked.map((call) => call.body.chat_id).sort()).toEqual([
      '-1001000000001',
      '@nexa_all_one',
    ]);
    const [token] = new Set(asked.map((call) => call.token));
    const sent = calls.find((call) => call.method === 'sendMessage');
    expect(token).toBe(sent?.token);
  });

  it('stops a customer missing one of two required channels, and shows only that one', async () => {
    const customer = user();
    await channels([
      { handle: '@nexa_two_one', mandatory: true },
      { handle: '@nexa_two_two', mandatory: true },
    ]);
    member('@nexa_two_one', customer, 'member');
    const replies = await say(customer, '/start');
    expect(textOf(replies)).toEqual([JOIN]);
    const buttons = buttonsOf(replies);
    expect(buttons.filter((button) => button.url !== undefined)).toEqual([
      expect.objectContaining({ text: '@nexa_two_two', url: 'https://t.me/nexa_two_two' }),
    ]);
    expect(buttons.at(-1)).toMatchObject({
      text: CATALOGUE_FA['bot.channels.check_button'],
      callback_data: 'mc:',
    });
  });

  it('never enforces, and never asks about, an optional channel', async () => {
    const customer = user();
    await channels([{ handle: '@nexa_optional', mandatory: false }]);
    const replies = await say(customer, '/start');
    expect(textOf(replies)).not.toContain(JOIN);
    expect(calls.some((call) => call.method === 'getChatMember')).toBe(false);
  });

  it('stops a customer who left or was kicked', async () => {
    await channels([{ handle: '@nexa_left_kick', mandatory: true }]);
    const left = user();
    const kicked = user();
    member('@nexa_left_kick', left, 'left');
    member('@nexa_left_kick', kicked, 'kicked');
    expect(textOf(await say(left, '/start'))).toEqual([JOIN]);
    expect(textOf(await say(kicked, '/start'))).toEqual([JOIN]);
  });

  it('reads restricted as a member only when Telegram says is_member', async () => {
    await channels([{ handle: '@nexa_restricted', mandatory: true }]);
    const stillIn = user();
    const out = user();
    member('@nexa_restricted', stillIn, 'restricted', true);
    member('@nexa_restricted', out, 'restricted', false);
    expect(textOf(await say(stillIn, '/start'))).not.toContain(JOIN);
    expect(textOf(await say(out, '/start'))).toEqual([JOIN]);
  });

  it('never locks out a bound administrator', async () => {
    await channels([{ handle: '@nexa_admin_bypass', mandatory: true }]);
    const adminUser = user();
    await createAdmin(api.container, tenantA, {
      username: 'bound-operator',
      roleKeys: ['owner'],
      telegramUserId: String(adminUser),
    });
    expect(textOf(await say(adminUser, '/start'))).not.toContain(JOIN);
  });

  it('fails open when the bot cannot check a channel, raises one condition, and recovers it', async () => {
    const customer = user();
    await channels([{ handle: '@nexa_fail_open', mandatory: true }]);
    failing.set('@nexa_fail_open', 403);
    expect(textOf(await say(customer, '/start'))).not.toContain(JOIN);
    expect(textOf(await say(customer, '/help'))).not.toContain(JOIN);
    let open = await conditions();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      code: CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE,
      resolved_at: null,
      dedupe_key: `${CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE}:${BOT_A}`,
    });

    // Telegram answers again. The check button asks afresh, past the cached unknown.
    failing.delete('@nexa_fail_open');
    member('@nexa_fail_open', customer, 'member');
    expect(textOf(await tap(customer, 'mc:'))).toEqual([WELCOME_BACK]);
    open = await conditions();
    const outage = open.find((row) => row.code === CHANNEL_MEMBERSHIP_UNAVAILABLE_CODE);
    expect(outage?.resolved_at).not.toBeNull();
  });

  it('opens a private channel by its invite link, numbered, and asks about it by id', async () => {
    const customer = user();
    await channels([
      { chatId: '-1001000000099', joinUrl: 'https://t.me/+PrivateInvite', mandatory: true },
    ]);
    const replies = await say(customer, '/start');
    expect(textOf(replies)).toEqual([JOIN]);
    expect(buttonsOf(replies)[0]).toMatchObject({
      text: CATALOGUE_FA['bot.channels.join_private_button'].replace('{number}', '1'),
      url: 'https://t.me/+PrivateInvite',
    });
    expect(calls.find((call) => call.method === 'getChatMember')?.body.chat_id).toBe(
      '-1001000000099',
    );
  });

  it('enforces one tenant’s channels only in that tenant’s bots', async () => {
    const customer = user();
    await channels([{ handle: '@nexa_tenant_a_only', mandatory: true }]);
    expect(textOf(await say(customer, '/start', BOT_A))).toEqual([JOIN]);
    const inB = await say(customer, '/start', BOT_B);
    expect(textOf(inB)).not.toContain(JOIN);
    expect(calls.some((call) => call.method === 'getChatMember')).toBe(false);
  });

  it('runs no business action while a membership is missing, and lets support through', async () => {
    const customer = user();
    const productId = await product();
    await channels([{ handle: '@nexa_no_business', mandatory: true }]);
    expect(textOf(await tap(customer, `p:${productId}`))).toEqual([JOIN]);
    expect(await orderCount()).toBe(0);
    expect(textOf(await say(customer, '/wallet'))).toEqual([JOIN]);
    // Support and /paysupport stay reachable (brief B3).
    expect(textOf(await say(customer, '/paysupport'))).not.toContain(JOIN);
    expect(textOf(await say(customer, '/help'))).not.toContain(JOIN);
  });

  it('answers the check button with the main menu, and never replays the action it stopped', async () => {
    const customer = user();
    const productId = await product();
    await channels([{ handle: '@nexa_no_replay', mandatory: true }]);
    expect(textOf(await tap(customer, `p:${productId}`))).toEqual([JOIN]);

    // Still not joined: the same buttons again.
    const still = await tap(customer, 'mc:');
    expect(textOf(still)).toEqual([STILL]);
    expect(buttonsOf(still).some((button) => button.url === 'https://t.me/nexa_no_replay')).toBe(
      true,
    );

    // Joined: the NEGATIVE answer is cached for ten seconds, and the button asks anyway.
    member('@nexa_no_replay', customer, 'member');
    expect(textOf(await tap(customer, 'mc:'))).toEqual([WELCOME_BACK]);
    expect(await orderCount()).toBe(0);

    // And now the product tap does draft an order.
    await tap(customer, `p:${productId}`);
    expect(await orderCount()).toBe(1);
  });
});
