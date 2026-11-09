import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  API_PREFIX,
  AUTH_ROUTES,
  BUSINESS_CHAT_HISTORY_PAGE,
  BUSINESS_CHAT_ROUTES,
  BUSINESS_MESSAGE_SENDER_ORIGINS,
  SESSION_COOKIE_NAME,
  businessChatHistoryResponseSchema,
  type BusinessChatHistoryResponse,
  type BusinessMessageOrigin,
} from '@nexa/contracts';
import type { ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { withDatabaseScope } from '../../apps/api/src/infrastructure/persistence/database-scope';
import { createDatabase } from '../../apps/api/src/infrastructure/persistence/database';
import {
  createApiApp,
  createAdmin,
  migrateOnce,
  resetDatabase,
  SEED_IDS,
  tenantA,
  tenantB,
  testAppDatabaseUrl,
  testConfig,
} from './harness';

/**
 * Web redesign PR-10 item 2 — one conversation's history, beyond the detail's 100 messages:
 * a cursor «before message id», newest first, 50 a page; a search over the WHOLE conversation
 * by text and by speaker; tenant-scoped (the predicate AND row-level security); and
 * `business_chats.view`, as the detail.
 *
 * Over HTTP, as the Web Admin reads it, through the application's pool (nexa_app), so
 * row-level security is the one production enforces.
 */

const ORIGIN = 'https://admin.example.test';
const ORIGINS: readonly BusinessMessageOrigin[] = ['INBOUND', 'OWN_ECHO', 'HUMAN', 'OFFLINE'];
/** Messages in tenant A's conversation: more than two pages and the detail's window. */
const TOTAL = 137;
/** The oldest message's words — older than the first page, and the detail's window. */
const OLD_NEEDLE = 'کد پیگیری قدیمی ZX-Alpha';

describe('business-chat history (PR-10)', () => {
  let api: ApiApp;
  let owner: string;
  let finance: string;
  let foreign: string;
  let conversationA: string;
  let conversationB: string;
  /** Tenant A's message ids in the order the history must return them. */
  let expectedOrder: string[];
  let foreignMessage: string;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  async function cookieFor(username: string): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username, password: `the-${username}-password` },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(response.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error(`No session cookie for ${username}: ${response.body}`);
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  const history = (conversationId: string, query: Record<string, string> = {}, cookie = owner) => {
    const search = new URLSearchParams(query).toString();
    return inject({
      method: 'GET',
      url: `${API_PREFIX}${BUSINESS_CHAT_ROUTES.history(conversationId)}${search ? `?${search}` : ''}`,
      headers: { cookie, origin: ORIGIN },
    });
  };

  async function page(
    conversationId: string,
    query: Record<string, string> = {},
  ): Promise<BusinessChatHistoryResponse> {
    const response = await history(conversationId, query);
    expect(response.statusCode, response.body).toBe(200);
    return businessChatHistoryResponseSchema.parse(response.json());
  }

  /** Every page from the newest, following `nextCursor` until it is null. */
  async function walk(conversationId: string, query: Record<string, string> = {}) {
    const pages: BusinessChatHistoryResponse[] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const next = await page(conversationId, before === undefined ? query : { ...query, before });
      pages.push(next);
      if (next.nextCursor === null) return pages;
      before = next.nextCursor;
    }
    throw new Error('the history never ended');
  }

  async function conversationIn(tenantId: string, botId: string, peer: string): Promise<string> {
    const db = api.container.database.db;
    const connectionRowId = randomUUID();
    await db.execute(sql`
      INSERT INTO telegram_business_connections
        (id, tenant_id, bot_instance_id, connection_id, owner_telegram_user_id,
         owner_user_chat_id, is_enabled, rights, connected_at, last_confirmed_at)
      VALUES (${connectionRowId}, ${tenantId}, ${botId}, ${`hist-${connectionRowId}`},
              '5000009', '5000009', true, ARRAY['can_reply'], now(), now())`);
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO business_conversations
        (id, tenant_id, bot_instance_id, owner_telegram_user_id, chat_id, connection_row_id,
         peer_telegram_user_id, state, control_epoch)
      VALUES (${id}, ${tenantId}, ${botId}, '5000009', ${peer}, ${connectionRowId},
              ${peer}, 'AI_ACTIVE', 1)`);
    return id;
  }

  async function message(input: {
    tenantId: string;
    conversationId: string;
    telegramMessageId: number;
    origin: BusinessMessageOrigin;
    text: string | null;
    sentAt: string;
  }): Promise<string> {
    const id = randomUUID();
    await api.container.database.db.execute(sql`
      INSERT INTO business_messages
        (id, tenant_id, conversation_id, telegram_message_id, origin, kind, text, sent_at,
         created_at)
      VALUES (${id}, ${input.tenantId}, ${input.conversationId}, ${input.telegramMessageId},
              ${input.origin}, 'TEXT', ${input.text}, ${input.sentAt}::timestamptz, now())`);
    return id;
  }

  beforeAll(async () => {
    const config = testConfig({ WEB_ADMIN_ORIGINS: ORIGIN });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);
  afterAll(async () => {
    await api?.close();
  });

  beforeEach(async () => {
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    for (const [username, roleKeys, scope] of [
      ['owner', ['owner'], tenantA],
      // `finance` holds no `business_chats.view`.
      ['finance', ['finance'], tenantA],
      ['foreign', ['owner'], tenantB],
    ] as const) {
      await createAdmin(api.container, scope, {
        username,
        password: `the-${username}-password`,
        roleKeys: [...roleKeys],
      });
    }
    owner = await cookieFor('owner');
    finance = await cookieFor('finance');
    api.container.setInstallationTenant(tenantB.tenantId);
    foreign = await cookieFor('foreign');
    api.container.setInstallationTenant(tenantA.tenantId);

    conversationA = await conversationIn(tenantA.tenantId, SEED_IDS.botA1, '7400001');
    conversationB = await conversationIn(tenantB.tenantId, SEED_IDS.botB1, '7400002');

    // Tenant A: TOTAL messages over a few minutes. Every third pair shares its instant (the
    // telegram id decides), several instants carry microseconds a JS Date cannot hold, and
    // the telegram ids do NOT follow the instants — so a page boundary falls inside a tie
    // and the order is the keyset's own, not the insertion order.
    const rows: { id: string; at: string; tg: number }[] = [];
    for (let i = 0; i < TOTAL; i += 1) {
      const second = Math.floor(i / 2) + (i % 3 === 0 ? 0 : i % 2);
      const micros = i % 5 === 0 ? `.${String(100000 + i * 7).padStart(6, '0')}` : '';
      const at = `2026-10-01T10:${String(Math.floor(second / 60)).padStart(2, '0')}:${String(second % 60).padStart(2, '0')}${micros}Z`;
      const tg = 10_000 - ((i * 37) % 1000);
      const text = i === 0 ? OLD_NEEDLE : `پیام شماره ${i}`;
      const id = await message({
        tenantId: tenantA.tenantId,
        conversationId: conversationA,
        telegramMessageId: tg,
        origin: ORIGINS[i % ORIGINS.length]!,
        text,
        sentAt: at,
      });
      rows.push({ id, at, tg });
    }
    const ordered = await api.container.database.db.execute<{ id: string }>(sql`
      SELECT id FROM business_messages WHERE conversation_id = ${conversationA}
       ORDER BY sent_at DESC, telegram_message_id DESC`);
    expectedOrder = ordered.rows.map((row) => row.id);
    expect(expectedOrder).toHaveLength(rows.length);

    // Tenant B holds the same words — invisible to tenant A, and A's to B.
    foreignMessage = await message({
      tenantId: tenantB.tenantId,
      conversationId: conversationB,
      telegramMessageId: 1,
      origin: 'INBOUND',
      text: OLD_NEEDLE,
      sentAt: '2026-10-01T09:00:00Z',
    });
  });

  it('pages newest first, 50 at a time, with no gap and no duplicate', async () => {
    const pages = await walk(conversationA);
    expect(pages.map((one) => one.messages.length)).toEqual([
      BUSINESS_CHAT_HISTORY_PAGE,
      BUSINESS_CHAT_HISTORY_PAGE,
      TOTAL - 2 * BUSINESS_CHAT_HISTORY_PAGE,
    ]);
    const ids = pages.flatMap((one) => one.messages.map((m) => m.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expectedOrder);
    // Each cursor is the last message of its page.
    for (const one of pages.slice(0, -1)) {
      expect(one.nextCursor).toBe(one.messages[one.messages.length - 1]!.id);
    }
    // Any message is a cursor: the client's oldest held one continues exactly after it.
    const from = expectedOrder[73]!;
    const after = await page(conversationA, { before: from });
    expect(after.messages.map((m) => m.id)).toEqual(expectedOrder.slice(74, 124));
  });

  it('searches the whole conversation: a message older than the first page is found', async () => {
    const first = await page(conversationA);
    const oldest = expectedOrder[expectedOrder.length - 1]!;
    expect(first.messages.map((m) => m.id)).not.toContain(oldest);

    // Case-insensitive, a substring, and only tenant A's copy of the words.
    const found = await page(conversationA, { q: 'zx-alpha' });
    expect(found.messages.map((m) => m.id)).toEqual([oldest]);
    expect(found.messages[0]!.text).toBe(OLD_NEEDLE);
    expect(found.nextCursor).toBeNull();

    // A `%` or `_` is a character, not a wildcard.
    expect((await page(conversationA, { q: '%' })).messages).toEqual([]);
    expect((await page(conversationA, { q: 'پیام_شماره' })).messages).toEqual([]);

    // By speaker, across every page: exactly the automatic side's (two origins), in the same order.
    const automatic = (await walk(conversationA, { sender: 'ai' })).flatMap((one) =>
      one.messages.map((m) => m.id),
    );
    const all = (await walk(conversationA)).flatMap((one) => one.messages);
    const expectedAutomatic = all
      .filter((m) => BUSINESS_MESSAGE_SENDER_ORIGINS.ai.includes(m.origin))
      .map((m) => m.id);
    expect(automatic).toEqual(expectedAutomatic);
    expect(automatic.length).toBeGreaterThan(BUSINESS_CHAT_HISTORY_PAGE);

    // Text AND speaker: the oldest is the customer's (index 0 is INBOUND), not the AI's.
    expect(
      (await page(conversationA, { q: 'ZX-ALPHA', sender: 'customer' })).messages,
    ).toHaveLength(1);
    expect((await page(conversationA, { q: 'ZX-ALPHA', sender: 'ai' })).messages).toEqual([]);

    // A search pages like the history: every message but the oldest holds «شماره».
    const hits = await walk(conversationA, { q: 'شماره' });
    const hitIds = hits.flatMap((one) => one.messages.map((m) => m.id));
    expect(new Set(hitIds).size).toBe(hitIds.length);
    const expectedHits = all.filter((m) => (m.text ?? '').includes('شماره')).map((m) => m.id);
    expect(hitIds).toEqual(expectedHits);
    expect(hitIds).toHaveLength(TOTAL - 1);
    expect(hits.length).toBe(3);
  });

  it('keeps another tenant’s messages invisible — by the predicate and by row-level security', async () => {
    // Tenant B's admin, asking for A's conversation: no such conversation for them.
    const asForeign = await history(conversationA, {}, foreign);
    expect(asForeign.statusCode, asForeign.body).toBe(404);
    expect(asForeign.body).not.toContain('شماره');
    const searchForeign = await history(conversationA, { q: 'ZX' }, foreign);
    expect(searchForeign.statusCode).toBe(404);

    // Tenant A, with a cursor that is B's message: refused, never read as the first page.
    const forged = await history(conversationA, { before: foreignMessage });
    expect(forged.statusCode, forged.body).toBe(400);
    // B's conversation id from A: not found.
    expect((await history(conversationB)).statusCode).toBe(404);

    // Row-level security on its own, through the application role's pool with NO tenant
    // predicate in the SQL: bound to B, A's rows do not exist, even asked for by id.
    const app = createDatabase(testAppDatabaseUrl(), 1);
    try {
      expect(await app.scopeEnforcement()).toBe('enforcing');
      const count = (scope: typeof tenantA) =>
        withDatabaseScope(scope, () =>
          app.db.execute<{ n: number }>(
            sql`SELECT count(*)::int AS n FROM business_messages WHERE conversation_id = ${conversationA}`,
          ),
        );
      expect((await count(tenantB)).rows[0]?.n).toBe(0);
      const byId = await withDatabaseScope(tenantB, () =>
        app.db.execute(sql`SELECT text FROM business_messages WHERE id = ${expectedOrder[0]!}`),
      );
      expect(byId.rows).toEqual([]);
      expect((await count(tenantA)).rows[0]?.n).toBe(TOTAL);
    } finally {
      await app.close();
    }
  });

  it('refuses a viewer without business_chats.view, before reading anything', async () => {
    for (const query of [{}, { q: 'ZX' }, { before: expectedOrder[10]! }, { sender: 'ai' }]) {
      const denied = await history(conversationA, query, finance);
      expect(denied.statusCode, denied.body).toBe(403);
      expect(denied.body).not.toContain('شماره');
      expect(denied.body).not.toContain('ZX');
    }
    // Without a session at all: not authenticated.
    const anonymous = await inject({
      method: 'GET',
      url: `${API_PREFIX}${BUSINESS_CHAT_ROUTES.history(conversationA)}`,
      headers: { origin: ORIGIN },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('refuses a malformed query with a 400', async () => {
    for (const query of [
      { before: 'not-a-message-id' },
      { before: randomUUID() },
      { q: '   ' },
      { q: 'x'.repeat(101) },
      { sender: 'INBOUND' },
    ]) {
      expect((await history(conversationA, query)).statusCode, JSON.stringify(query)).toBe(400);
    }
  });
});
