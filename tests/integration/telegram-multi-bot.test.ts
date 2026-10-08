import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BotInstanceId, TenantContext } from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { TelegramCustomerMessenger } from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';
import { TelegramBroadcastTransport } from '../../apps/api/src/modules/commerce/broadcasts/infrastructure/telegram-broadcast.transport';
import { TelegramNotificationTransport } from '../../apps/api/src/modules/control/notifications/infrastructure/telegram-transport';
import { DrizzleOperationalConditionReader } from '../../apps/api/src/modules/platform/opslog/infrastructure/drizzle-operational-event.reader';
import { startFakeTelegramBotApi, type FakeTelegramBotApi } from '../support/fake-telegram-bot-api';
import { migrateOnce, resetDatabase, SEED_IDS, tenantA, testConfig } from './harness';

/**
 * Roadmap D1–D3 (Telegram robustness): every send uses the RIGHT bot, and a send whose
 * outcome is unknown is never repeated.
 *
 * The real API container over a real database — bot rows, tenant scoping, the token
 * cipher, the operational log — with Telegram replaced by the HTTP fake that answers each
 * bot by its own token (`tests/support/fake-telegram-bot-api.ts`). The transports are the
 * shipped classes over the container's own `botInstances` repository; only the template
 * renderer is a stand-in, because the text is not what is under test here.
 *
 * Tenant A has two bots: `acme_store_bot` (A1) and `acme_support_bot` (A2, seeded STOPPED and
 * started here). Tenant B's bot (B1) exists to prove a bot id from another tenant resolves to
 * nothing. Each row's ciphertext is replaced with the fake bot's real token, so a send that
 * reached the fake under the wrong token would be answered for the wrong bot — and counted
 * there.
 */

const BOT_A1 = SEED_IDS.botA1 as BotInstanceId;
const BOT_A2 = SEED_IDS.botA2 as BotInstanceId;
const BOT_B1 = SEED_IDS.botB1 as BotInstanceId;
const TG_A1 = 7000000101;
const TG_A2 = 7000000102;
const TG_B1 = 7000000201;
const PLAIN_KEY = 'bot.admin.receipt' as const;
const WEBHOOK_SECRET = 'multi-bot-integration-webhook-secret';
const ORIGIN = 'https://bot.example.test';
const FINGERPRINT = createHash('sha256').update(WEBHOOK_SECRET, 'utf8').digest('hex');

describe('roadmap D1–D3 — the right bot for every send, and no blind retry', () => {
  let api: ApiApp;
  let telegram: FakeTelegramBotApi;
  let messenger: TelegramCustomerMessenger;
  let broadcast: TelegramBroadcastTransport;
  let ops: TelegramNotificationTransport;
  const scope = tenantA as unknown as TenantContext;
  const db = () => api.container.database.db;

  beforeAll(async () => {
    telegram = await startFakeTelegramBotApi();
    const config = testConfig({
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

  /** Stores `token` as the bot row's credential, exactly as the bootstrap encrypts it. */
  async function storeToken(tenantId: string, botId: BotInstanceId, token: string) {
    const secret = api.container.cipher.encrypt(token, {
      purpose: 'bot_instance.token',
      tenantId,
      entityId: botId,
    });
    await db().execute(sql`
      UPDATE bot_instances
         SET token_ciphertext = ${secret.ciphertext}, token_key_id = ${secret.keyId}
       WHERE id = ${botId}`);
  }

  beforeEach(async () => {
    await resetDatabase(db());
    await seed(db(), api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    // A fresh fake per test would need a fresh app; the bots are re-created instead.
    const a1 = telegram.createBot({ id: TG_A1, username: 'acme_store_bot' });
    const a2 = telegram.createBot({ id: TG_A2, username: 'acme_support_bot' });
    const b1 = telegram.createBot({ id: TG_B1, username: 'globex_store_bot' });
    await storeToken(SEED_IDS.tenantA, BOT_A1, a1);
    await storeToken(SEED_IDS.tenantA, BOT_A2, a2);
    await storeToken(SEED_IDS.tenantB, BOT_B1, b1);
    await db().execute(sql`
      UPDATE bot_instances SET status = 'ACTIVE',
             telegram_bot_id = CASE id WHEN ${BOT_A1} THEN ${String(TG_A1)}
                                       WHEN ${BOT_A2} THEN ${String(TG_A2)}
                                       ELSE ${String(TG_B1)} END`);

    const renderer = { render: async () => 'سلام' };
    messenger = new TelegramCustomerMessenger(
      renderer as never,
      api.container.botInstances,
      api.container.opsLog,
      new DrizzleOperationalConditionReader(db()),
      telegram.url,
      2000,
    );
    broadcast = new TelegramBroadcastTransport(
      renderer as never,
      api.container.botInstances,
      telegram.url,
      2000,
    );
    ops = new TelegramNotificationTransport(api.container.botInstances, telegram.url, 2000);
    telegram.calls.length = 0;
  });

  const send = (botInstanceId: BotInstanceId, chatId: string) =>
    messenger.send(scope, { chatId, botInstanceId, templateKey: PLAIN_KEY, values: {} });
  const calls = (method: string) => telegram.calls.filter((call) => call.method === method);
  const failureEvents = async () =>
    (
      await db().execute<{ context: Record<string, unknown> }>(sql`
        SELECT context FROM operational_events
         WHERE code = 'telegram.customer_send_failed' ORDER BY last_seen_at`)
    ).rows.map((row) => row.context);

  // ---------------------------------------------------------------- D2: the right bot

  it('answers each customer from the bot they wrote to, never the tenant’s other bot', async () => {
    expect(await send(BOT_A1, '1001')).toMatchObject({ outcome: 'DELIVERED' });
    expect(await send(BOT_A2, '1002')).toMatchObject({ outcome: 'DELIVERED' });

    expect(telegram.delivered(TG_A1).map((m) => m.chatId)).toEqual(['1001']);
    expect(telegram.delivered(TG_A2).map((m) => m.chatId)).toEqual(['1002']);
    expect(calls('sendMessage').map((call) => call.botId)).toEqual([TG_A1, TG_A2]);
  });

  it('sends nothing at all through a STOPPED bot, and says so to the operator', async () => {
    await db().execute(sql`UPDATE bot_instances SET status = 'STOPPED' WHERE id = ${BOT_A2}`);

    expect(await send(BOT_A2, '1002')).toEqual({ outcome: 'REFUSED' });
    // Not "sent with the tenant's other bot": no call reached Telegram at all.
    expect(telegram.calls).toHaveLength(0);
    expect(await failureEvents()).toEqual([
      expect.objectContaining({ botInstanceId: BOT_A2, reason: 'NO_BOT' }),
    ]);
  });

  it('never uses another tenant’s bot, even when handed its id', async () => {
    expect(await send(BOT_B1, '1003')).toEqual({ outcome: 'REFUSED' });
    expect(telegram.calls).toHaveLength(0);
    expect(telegram.delivered(TG_B1)).toHaveLength(0);
  });

  it('a file_id one bot received is sent by THAT bot; the other bot is refused once, never retried', async () => {
    telegram.giveFile(TG_A1, 'TUTORIAL-VIDEO-A1');
    const video = (botInstanceId: BotInstanceId) =>
      messenger.sendFile(scope, {
        chatId: '1004',
        botInstanceId,
        kind: 'VIDEO',
        source: { kind: 'FILE_ID', fileId: 'TUTORIAL-VIDEO-A1' },
      });

    expect(await video(BOT_A1)).toMatchObject({ outcome: 'DELIVERED' });
    expect(await video(BOT_A2)).toMatchObject({ outcome: 'REFUSED' });

    expect(telegram.sentMedia(TG_A1)).toHaveLength(1);
    expect(telegram.sentMedia(TG_A2)).toHaveLength(0);
    expect(calls('sendVideo').map((call) => call.botId)).toEqual([TG_A1, TG_A2]);
  });

  it('a broadcast copy from a source only one bot can read: that bot sends, the other is refused', async () => {
    telegram.letRead(TG_A1, '-1001234567890');
    const rendered = {
      contentKind: 'COPY' as const,
      text: '',
      buttons: [],
      source: { chatId: '-1001234567890', messageId: 77 },
    };
    const deliver = (botInstanceId: BotInstanceId, chatId: string) =>
      broadcast.deliver(scope, { chatId, botInstanceId, rendered: rendered as never, media: null });

    expect(await deliver(BOT_A1, '1005')).toMatchObject({ outcome: 'SENT' });
    /*
     * A definite 400: terminal for this recipient, never UNKNOWN and never retried. WHICH
     * terminal state is the broadcast lane's: today a source the bot cannot read answers
     * "chat not found", which `classify` files as the RECIPIENT being unreachable — a
     * misattribution reported to the campaign workstream (docs/telegram-robustness-audit.md
     * §D2-F1), so this asserts only what D2 owns: definite, one request, the right bot.
     */
    const refused = await deliver(BOT_A2, '1006');
    expect(['REFUSED', 'UNREACHABLE']).toContain(refused.outcome);
    expect(calls('copyMessage').map((call) => call.botId)).toEqual([TG_A1, TG_A2]);
    expect(telegram.sentMedia(TG_A1).map((m) => m.chatId)).toEqual(['1005']);
  });

  it('an ops message that names a bot goes through that bot; one that names none, the first active', async () => {
    const message = {
      destination: { transport: 'TELEGRAM' as const, chatId: '-100555', topicId: null },
      text: 'ops',
      html: false,
      tenantId: SEED_IDS.tenantA,
    };
    expect(await ops.send({ ...message, botInstanceId: BOT_A2 })).toEqual({ outcome: 'SUCCEEDED' });
    expect(await ops.send(message)).toEqual({ outcome: 'SUCCEEDED' });
    expect(calls('sendMessage').map((call) => call.botId)).toEqual([TG_A2, TG_A1]);
  });

  // ------------------------------------------- D2/D3: token replacement and revocation

  it('a revoked token is REFUSED and named as such; after replacement the NEW token is used at once', async () => {
    const replacement = telegram.revoke(TG_A1, { keepWebhook: true });

    expect(await send(BOT_A1, '1007')).toEqual({ outcome: 'REFUSED' });
    // The old token reached Telegram once and was answered as nobody's.
    expect(calls('sendMessage').map((call) => call.botId)).toEqual([null]);
    expect(await failureEvents()).toEqual([
      expect.objectContaining({
        botInstanceId: BOT_A1,
        reason: 'TOKEN_REJECTED',
        errorCode: 'telegram.rejected.401',
      }),
    ]);

    // The Web Admin replacement stores the new credential; no cache stands in the way.
    await storeToken(SEED_IDS.tenantA, BOT_A1, replacement);
    expect(await send(BOT_A1, '1007')).toMatchObject({ outcome: 'DELIVERED' });
    expect(telegram.delivered(TG_A1).map((m) => m.chatId)).toEqual(['1007']);
    // ...and the other bot was never the fallback for either attempt.
    expect(telegram.delivered(TG_A2)).toHaveLength(0);
  });

  // --------------------------------------------------- D1: three outcomes, kept apart

  it('a 429 is RATE_LIMITED with Telegram’s wait; nothing delivered and nothing retried', async () => {
    telegram.failNext('sendMessage', { kind: 'rate_limit', retryAfter: 5 });
    expect(await send(BOT_A1, '1008')).toEqual({ outcome: 'RATE_LIMITED', retryAfterMs: 5000 });
    expect(calls('sendMessage')).toHaveLength(1);
    expect(telegram.delivered(TG_A1)).toHaveLength(0);
    // A rate limit is not a failure condition.
    expect(await failureEvents()).toEqual([]);
  });

  it.each([
    ['apply_then_drop', 1],
    ['apply_then_garble', 1],
    ['drop', 0],
    ['server_error', 0],
  ] as const)(
    'a %s is UNKNOWN: ONE request, never a second, whatever landed',
    async (kind, landed) => {
      telegram.failNext('sendMessage', { kind });
      expect(await send(BOT_A1, '1009')).toEqual({ outcome: 'UNKNOWN' });
      expect(calls('sendMessage')).toHaveLength(1);
      expect(telegram.delivered(TG_A1)).toHaveLength(landed);
      expect(await failureEvents()).toEqual([
        expect.objectContaining({ botInstanceId: BOT_A1, reason: 'UNCERTAIN' }),
      ]);
    },
  );

  it('a definite refusal is REFUSED, one request, and the next send through the bot still works', async () => {
    telegram.failNext('sendMessage', {
      kind: 'refuse',
      description: 'Bad Request: chat not found',
    });
    expect(await send(BOT_A1, '1010')).toEqual({ outcome: 'REFUSED' });
    expect(await send(BOT_A1, '1010')).toMatchObject({ outcome: 'DELIVERED' });
    expect(calls('sendMessage')).toHaveLength(2);
    expect(await failureEvents()).toEqual([
      expect.objectContaining({ reason: 'REFUSED', errorCode: 'telegram.rejected.400' }),
    ]);
  });

  // ------------------- PR #238 review B1: the row the operator reads says the right thing

  /** The bot's condition rows as the dashboard shows them: sentence, key, open or not. */
  const conditionRows = async () =>
    (
      await db().execute<{ message: string; dedupe_key: string; open: boolean }>(sql`
        SELECT message, dedupe_key, resolved_at IS NULL AS open FROM operational_events
         WHERE code = 'telegram.customer_send_failed' ORDER BY dedupe_key`)
    ).rows;
  const GENERIC = `telegram.customer_send_failed:${BOT_A1}`;
  const TOKEN = `${GENERIC}:token`;
  const REFUSED_SENTENCE = 'Telegram refused a customer reply.';

  it('B1 step order 1: a refusal, a recovery, then a revoked token — the token remedy IS shown', async () => {
    telegram.failNext('sendMessage', {
      kind: 'refuse',
      description: 'Bad Request: chat not found',
    });
    expect(await send(BOT_A1, '1011')).toEqual({ outcome: 'REFUSED' });
    expect(await send(BOT_A1, '1011')).toMatchObject({ outcome: 'DELIVERED' });
    telegram.revoke(TG_A1, { keepWebhook: true });
    expect(await send(BOT_A1, '1011')).toEqual({ outcome: 'REFUSED' });

    const rows = await conditionRows();
    expect(rows).toEqual([
      { message: REFUSED_SENTENCE, dedupe_key: GENERIC, open: false },
      { message: expect.stringContaining('Replace the token'), dedupe_key: TOKEN, open: true },
    ]);
  });

  it('B1 step order 2: a revoked token, a replacement, then a refusal — no stale token remedy', async () => {
    const replacement = telegram.revoke(TG_A1, { keepWebhook: true });
    expect(await send(BOT_A1, '1012')).toEqual({ outcome: 'REFUSED' });
    await storeToken(SEED_IDS.tenantA, BOT_A1, replacement);
    expect(await send(BOT_A1, '1012')).toMatchObject({ outcome: 'DELIVERED' });
    telegram.failNext('sendMessage', { kind: 'refuse', description: 'Forbidden: bot was blocked' });
    expect(await send(BOT_A1, '1012')).toEqual({ outcome: 'REFUSED' });

    const rows = await conditionRows();
    // The open row says what is true NOW; the token row was closed by the delivery.
    expect(rows).toEqual([
      { message: REFUSED_SENTENCE, dedupe_key: GENERIC, open: true },
      { message: expect.stringContaining('Replace the token'), dedupe_key: TOKEN, open: false },
    ]);
  });

  // ----------------------------------------------------- D3: a BotFather rename

  it('register records a BotFather rename of the SAME bot, audited; status shows it first', async () => {
    const url = `${ORIGIN}/telegram/webhook/${BOT_A1}`;
    await db().execute(sql`
      UPDATE bot_instances
         SET webhook_url = ${url},
             webhook_registered_at = '2026-09-01T10:00:00Z',
             webhook_secret_fingerprint = ${FINGERPRINT}
       WHERE id = ${BOT_A1}`);
    telegram.setWebhookDirectly(TG_A1, { url });
    telegram.rename(TG_A1, 'acme_renamed_bot');
    const tenantScope = { tenantId: tenantA.tenantId, botInstanceId: null } as TenantContext;

    const status = await api.container.bootstrapBot.statusWithReason(tenantScope, ORIGIN);
    expect(status.state).toBe('ready');
    expect(status.detail?.usernameDrift).toEqual({
      stored: 'acme_store_bot',
      reported: 'acme_renamed_bot',
      heldByAnotherRow: false,
    });

    const result = await api.container.bootstrapBot.execute(tenantScope, {
      token: null,
      publicBaseUrl: ORIGIN,
    });
    expect(result).toMatchObject({
      kind: 'ALREADY_COMPLETE',
      username: 'acme_renamed_bot',
      usernameReconcile: 'UPDATED',
    });
    const rows = await db().execute<{ username: string; telegram_bot_id: string }>(sql`
      SELECT username, telegram_bot_id FROM bot_instances WHERE id = ${BOT_A1}`);
    expect(rows.rows[0]).toEqual({
      username: 'acme_renamed_bot',
      telegram_bot_id: String(TG_A1),
    });
    const audits = await db().execute<{ result: string; before: unknown; after: unknown }>(sql`
      SELECT result, before, after FROM audit_logs
       WHERE action = 'bot_instance.username_reconciled' AND entity_id = ${BOT_A1}`);
    expect(audits.rows).toEqual([
      expect.objectContaining({
        result: 'SUCCESS',
        before: expect.objectContaining({ username: 'acme_store_bot' }),
        after: expect.objectContaining({ username: 'acme_renamed_bot' }),
      }),
    ]);
    // No queued update was dropped and no webhook call was made for a rename.
    expect(calls('setWebhook')).toHaveLength(0);
    expect(calls('deleteWebhook')).toHaveLength(0);
  });

  it('a rename onto a name another bot row still holds changes nothing and is audited FAILED', async () => {
    const url = `${ORIGIN}/telegram/webhook/${BOT_A1}`;
    await db().execute(sql`
      UPDATE bot_instances
         SET webhook_url = ${url},
             webhook_registered_at = '2026-09-01T10:00:00Z',
             webhook_secret_fingerprint = ${FINGERPRINT}
       WHERE id = ${BOT_A1}`);
    telegram.setWebhookDirectly(TG_A1, { url });
    telegram.rename(TG_A1, 'acme_support_bot');
    const tenantScope = { tenantId: tenantA.tenantId, botInstanceId: null } as TenantContext;

    const result = await api.container.bootstrapBot.execute(tenantScope, {
      token: null,
      publicBaseUrl: ORIGIN,
    });
    expect(result).toMatchObject({
      kind: 'ALREADY_COMPLETE',
      username: 'acme_store_bot',
      usernameReconcile: 'TAKEN',
    });
    const status = await api.container.bootstrapBot.statusWithReason(tenantScope, ORIGIN);
    expect(status.detail?.usernameDrift).toMatchObject({ heldByAnotherRow: true });
    const rows = await db().execute<{ id: string; username: string }>(sql`
      SELECT id, username FROM bot_instances WHERE tenant_id = ${SEED_IDS.tenantA} ORDER BY id`);
    expect(rows.rows).toEqual([
      { id: BOT_A1, username: 'acme_store_bot' },
      { id: BOT_A2, username: 'acme_support_bot' },
    ]);
    const audits = await db().execute<{ result: string }>(sql`
      SELECT result FROM audit_logs WHERE action = 'bot_instance.username_reconciled'`);
    expect(audits.rows).toEqual([{ result: 'FAILED' }]);
  });
});
