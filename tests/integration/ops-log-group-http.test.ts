import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  OPS_GROUP_ROUTES,
  SESSION_COOKIE_NAME,
  TELEGRAM_SECRET_TOKEN_HEADER,
  opsConnectCodeResponseSchema,
  opsLogGroupResponseSchema,
  systemJobActor,
  type CorrelationId,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';

/**
 * WP-A4 end to end: the Web Admin issues a code, the group's `/start` from the deep link
 * arrives on the bot's real webhook, the worker's pass talks to a Telegram-shaped server
 * through the real adapter, and the panel reads back a healthy group with its topics.
 *
 * The fake answers the Bot API's own shapes (`getChat`, `getChatMember`,
 * `createForumTopic`, `sendMessage`) — which proves the adapter and the webhook parsing,
 * not Telegram. What Telegram actually sends is the operator acceptance's to prove.
 */

const ORIGIN = 'https://admin.example.test';
const WEBHOOK_SECRET = 'wp-a4-ops-group-webhook-secret';
const GROUP_CHAT = -1001234567890;

interface Call {
  readonly method: string;
  readonly body: Record<string, unknown>;
}

describe('the operations log group over HTTP and the webhook (WP-A4)', () => {
  let api: ApiApp;
  let telegram: Server;
  let calls: Call[];
  let nextThread: number;
  let memberStatus: string;

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
    let result: unknown = true;
    if (method === 'getMe') result = { id: 777000, is_bot: true, username: 'acme_store_bot' };
    if (method === 'getChat') {
      result = { id: GROUP_CHAT, type: 'supergroup', title: 'Nexa Ops', is_forum: true };
    }
    if (method === 'getChatMember') {
      result = { status: memberStatus, can_manage_topics: true, user: { id: 777000 } };
    }
    if (method === 'createForumTopic') {
      nextThread += 1;
      result = { message_thread_id: nextThread, name: body.name, icon_color: 0 };
    }
    if (method === 'sendMessage') result = { message_id: 1, chat: { id: body.chat_id } };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, result }));
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
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
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
    nextThread = 500;
    memberStatus = 'administrator';
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    await createAdmin(api.container, tenantA, {
      username: 'support',
      password: 'the-support-password',
      roleKeys: ['support'],
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

  const post = async (path: string, cookie: string, payload: unknown) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: { cookie, origin: ORIGIN },
      payload: payload as never,
    });

  let updateId = 1000;
  const deliver = (update: Record<string, unknown>) =>
    inject({
      method: 'POST',
      url: `/telegram/webhook/${SEED_IDS.botA1}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: { update_id: (updateId += 1), ...update },
    });

  const groupMessage = (text: string, chat: Record<string, unknown> = {}) => ({
    message: {
      message_id: 1,
      date: 1,
      text,
      from: { id: 42, is_bot: false, first_name: 'Operator' },
      chat: { id: GROUP_CHAT, type: 'supergroup', title: 'Nexa Ops', is_forum: true, ...chat },
    },
  });

  it('connects a group with one action, checks it and creates its topics', async () => {
    const owner = await cookieFor('owner', 'the-owners-real-password');
    const issued = opsConnectCodeResponseSchema.parse(
      (
        await post(OPS_GROUP_ROUTES.connectCode, owner, {
          idempotencyKey: 'connect-code-1',
          botInstanceId: SEED_IDS.botA1,
        })
      ).json(),
    );
    expect(issued.deepLink).toBe(
      `https://t.me/acme_store_bot?startgroup=ops-${issued.code}&admin=manage_topics`,
    );
    expect(issued.command).toBe(`/connect_ops@acme_store_bot ${issued.code}`);

    // What the deep link makes Telegram post in the chosen group.
    const delivered = await deliver(groupMessage(`/start@acme_store_bot ops-${issued.code}`));
    expect(delivered.statusCode).toBeLessThan(300);

    // The group was answered in its own chat, from the bot, with the catalogue's words.
    const reply = calls.find((call) => call.method === 'sendMessage');
    expect(reply?.body.chat_id).toBe(String(GROUP_CHAT));
    expect(reply?.body.text).toBe(CATALOGUE_FA['ops.group.connected']);
    // An operator binding the group is not a customer.
    const customers = (await api.container.database.db.execute(
      `SELECT count(*)::int AS n FROM customers WHERE telegram_user_id = '42'` as never,
    )) as unknown as { rows: { n: number }[] };
    expect(customers.rows[0]?.n).toBe(0);

    // The worker's pass.
    await api.container.opsGroups.maintain(tenantA, systemJobActor('test', 'c' as CorrelationId));
    const status = opsLogGroupResponseSchema.parse(
      (
        await inject({
          method: 'GET',
          url: `${API_PREFIX}${OPS_GROUP_ROUTES.status}`,
          headers: { cookie: owner, origin: ORIGIN },
        })
      ).json(),
    );
    expect(status.opsGroup).toMatchObject({
      connection: 'CONNECTED',
      health: 'HEALTHY',
      problems: [],
      group: { title: 'Nexa Ops', bot: { username: 'acme_store_bot' } },
    });
    expect(status.opsGroup.topics.map((topic) => topic.state)).toEqual(['READY', 'READY']);
    const created = calls.filter((call) => call.method === 'createForumTopic');
    expect(created.map((call) => call.body.name)).toEqual([
      CATALOGUE_FA['ops.group.topic_name.system'],
      CATALOGUE_FA['ops.group.topic_name.payments'],
    ]);
    // The chat id never came from a request body, and is not echoed to the panel.
    expect(JSON.stringify(status)).not.toContain(String(GROUP_CHAT));
  });

  it('marks the group for a new check when Telegram says the bot was demoted', async () => {
    const owner = await cookieFor('owner', 'the-owners-real-password');
    const issued = opsConnectCodeResponseSchema.parse(
      (
        await post(OPS_GROUP_ROUTES.connectCode, owner, {
          idempotencyKey: 'connect-code-2',
          botInstanceId: SEED_IDS.botA1,
        })
      ).json(),
    );
    await deliver(groupMessage(`/connect_ops@acme_store_bot ${issued.code}`));
    await api.container.opsGroups.maintain(tenantA, systemJobActor('test', 'c' as CorrelationId));

    memberStatus = 'member';
    await deliver({
      my_chat_member: {
        chat: { id: GROUP_CHAT, type: 'supergroup', title: 'Nexa Ops' },
        from: { id: 42, is_bot: false, first_name: 'Operator' },
        date: 2,
        old_chat_member: { status: 'administrator', user: { id: 777000, is_bot: true } },
        new_chat_member: { status: 'member', user: { id: 777000, is_bot: true } },
      },
    });
    await api.container.opsGroups.maintain(tenantA, systemJobActor('test', 'c' as CorrelationId));
    const status = opsLogGroupResponseSchema.parse(
      (
        await inject({
          method: 'GET',
          url: `${API_PREFIX}${OPS_GROUP_ROUTES.status}`,
          headers: { cookie: owner, origin: ORIGIN },
        })
      ).json(),
    );
    expect(status.opsGroup).toMatchObject({ health: 'PROBLEM', problems: ['BOT_NOT_ADMIN'] });
  });

  it('does not acknowledge a membership change it failed to record (Codex review #2)', async () => {
    const owner = await cookieFor('owner', 'the-owners-real-password');
    const issued = opsConnectCodeResponseSchema.parse(
      (
        await post(OPS_GROUP_ROUTES.connectCode, owner, {
          idempotencyKey: 'connect-code-3',
          botInstanceId: SEED_IDS.botA1,
        })
      ).json(),
    );
    await deliver(groupMessage(`/connect_ops@acme_store_bot ${issued.code}`));
    await api.container.opsGroups.maintain(tenantA, systemJobActor('test', 'c' as CorrelationId));

    const demotion = {
      update_id: (updateId += 1),
      my_chat_member: {
        chat: { id: GROUP_CHAT, type: 'supergroup', title: 'Nexa Ops' },
        from: { id: 42, is_bot: false, first_name: 'Operator' },
        date: 3,
        old_chat_member: { status: 'administrator', user: { id: 777000, is_bot: true } },
        new_chat_member: { status: 'member', user: { id: 777000, is_bot: true } },
      },
    };
    const send = () =>
      inject({
        method: 'POST',
        url: `/telegram/webhook/${SEED_IDS.botA1}`,
        headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
        payload: demotion,
      });

    const real = api.container.opsGroups.membershipChanged.bind(api.container.opsGroups);
    api.container.opsGroups.membershipChanged = () => Promise.reject(new Error('database blip'));
    try {
      // Not 2xx: Telegram delivers it again.
      expect((await send()).statusCode).toBeGreaterThanOrEqual(500);
    } finally {
      api.container.opsGroups.membershipChanged = real;
    }
    // The redelivery is handled, and the group is marked for a new check.
    expect((await send()).statusCode).toBeLessThan(300);
    const group = (await api.container.database.db.execute(
      `SELECT health FROM ops_log_groups` as never,
    )) as unknown as { rows: { health: string }[] };
    expect(group.rows[0]?.health).toBe('UNVERIFIED');
    // A second redelivery of the same update is a replay, and still 2xx.
    expect((await send()).statusCode).toBeLessThan(300);
  });

  it('refuses every write to an administrator without settings.edit', async () => {
    const support = await cookieFor('support', 'the-support-password');
    for (const [path, body] of [
      [OPS_GROUP_ROUTES.connectCode, { idempotencyKey: 'denied-1', botInstanceId: SEED_IDS.botA1 }],
      [OPS_GROUP_ROUTES.verify, { idempotencyKey: 'denied-2' }],
      [OPS_GROUP_ROUTES.test, { idempotencyKey: 'denied-3' }],
      [OPS_GROUP_ROUTES.reconnect, { idempotencyKey: 'denied-4' }],
      [OPS_GROUP_ROUTES.disconnect, { idempotencyKey: 'denied-5' }],
      [OPS_GROUP_ROUTES.requeue, { idempotencyKey: 'denied-6' }],
    ] as const) {
      expect((await post(path, support, body)).statusCode, path).toBe(403);
    }
  });
});
