import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  BOT_ERROR_CODES,
  BOT_ROUTES,
  SESSION_COOKIE_NAME,
  TELEGRAM_SECRET_TOKEN_HEADER,
  botDiagnosticResponseSchema,
  botReplacementFailureDetailsSchema,
  botResponseSchema,
  botTokenReplacementResponseSchema,
  type BotInstanceId,
  type TenantContext,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  TOKEN_REPLACEMENT_COMPLETED_CODE,
  TOKEN_REPLACEMENT_INCOMPLETE_CODE,
} from '../../apps/api/src/modules/platform/tenancy/application/bot-management.service';
import { startFakeTelegramBotApi, type FakeTelegramBotApi } from '../support/fake-telegram-bot-api';
import { createAdmin, migrateOnce, resetDatabase, SEED_IDS, tenantA, testConfig } from './harness';

/**
 * R4 (item 12) — replacing a bot's token leaves the bot able to receive updates, or
 * says exactly why it does not.
 *
 * The real API app over a real database, with Telegram replaced by an HTTP fake that
 * answers the documented Bot API shapes (`tests/support/fake-telegram-bot-api.ts`). So the
 * call core, the gateway, the service, the repository and the controller all run as
 * shipped, and the only thing stood in for is Telegram itself.
 *
 * The owner's defect, reproduced by the first case: BotFather issues a new token, the
 * registration is gone, the new token is accepted — and before R4 the bot stayed silent.
 */

const ORIGIN = 'https://admin.example.test';
const WEBHOOK_SECRET = 'r4-integration-webhook-secret';
const BOT_A1 = SEED_IDS.botA1 as BotInstanceId;
const TELEGRAM_ID = 7000000001;
/** What the installer registered for BOT_A1: its public origin, then the route and the id. */
const EXPECTED_URL = `https://bot.example.test/telegram/webhook/${BOT_A1}`;
const FINGERPRINT = createHash('sha256').update(WEBHOOK_SECRET, 'utf8').digest('hex');

describe('R4 — Telegram bot token replacement registers and verifies the webhook', () => {
  let api: ApiApp;
  let telegram: FakeTelegramBotApi;
  let oldToken: string;
  const scope = tenantA as unknown as TenantContext;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);
  const db = () => api.container.database.db;

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

  /** The installation as the installer left it: bot bound, registered here, secret current. */
  beforeEach(async () => {
    await resetDatabase(db());
    await seed(db(), api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    await createAdmin(api.container, tenantA, {
      username: 'owner',
      password: 'the-owners-real-password',
      roleKeys: ['owner'],
    });
    oldToken = telegram.createBot({ id: TELEGRAM_ID, username: 'acme_store_bot' });
    telegram.setWebhookDirectly(TELEGRAM_ID, { url: EXPECTED_URL });
    const secret = api.container.cipher.encrypt(oldToken, {
      purpose: 'bot_instance.token',
      tenantId: tenantA.tenantId,
      entityId: BOT_A1,
    });
    await db().execute(sql`
      UPDATE bot_instances
         SET telegram_bot_id = ${String(TELEGRAM_ID)},
             username = 'acme_store_bot',
             token_ciphertext = ${secret.ciphertext},
             token_key_id = ${secret.keyId},
             webhook_url = ${EXPECTED_URL},
             webhook_registered_at = '2026-09-01T10:00:00Z',
             webhook_secret_fingerprint = ${FINGERPRINT}
       WHERE id = ${BOT_A1}`);
    telegram.calls.length = 0;
  });

  async function ownerCookie(): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner', password: 'the-owners-real-password' },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(response.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error('No session for the owner.');
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  const replace = async (cookie: string, token: string, idempotencyKey: string) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${BOT_ROUTES.token(BOT_A1)}`,
      headers: { cookie, origin: ORIGIN },
      payload: { idempotencyKey, token },
    });
  const errorOf = (response: { json: () => unknown }) =>
    (response.json() as { error: { code: string; details?: unknown } }).error;
  const failureDetails = (response: { json: () => unknown }) =>
    botReplacementFailureDetailsSchema.parse(errorOf(response).details);

  const storedToken = () => api.container.botInstances.resolveToken(scope as never, BOT_A1);
  const telegramMethods = () => telegram.calls.map((call) => call.method);
  const count = async (query: ReturnType<typeof sql>) =>
    ((await db().execute<{ n: number }>(query)).rows[0]?.n ?? 0) as number;
  const successfulReplacements = () =>
    count(sql`SELECT count(*)::int AS n FROM audit_logs
               WHERE action = 'bot_instance.token_replace' AND result = 'SUCCESS'`);
  const openIncomplete = async () =>
    (
      await db().execute<{ context: Record<string, unknown>; severity: string }>(sql`
        SELECT context, severity FROM operational_events
         WHERE code = ${TOKEN_REPLACEMENT_INCOMPLETE_CODE} AND resolved_at IS NULL`)
    ).rows;
  const deliverUpdate = (updateId: number) =>
    inject({
      method: 'POST',
      url: `/telegram/webhook/${BOT_A1}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: { update_id: updateId },
    });

  // -------------------------------------------------------------------------
  // The brief's required regressions
  // -------------------------------------------------------------------------

  it('replaces a revoked token, re-registers the lost webhook, and verifies an EXACT match with Telegram', async () => {
    // The owner's defect: a new token from BotFather, and no webhook left behind it.
    const newToken = telegram.revoke(TELEGRAM_ID, { keepWebhook: false });
    telegram.setPending(TELEGRAM_ID, 4);
    const cookie = await ownerCookie();
    const holdsBefore = api.container.botInstances;

    const response = await replace(cookie, newToken, 'replace-revoked');
    expect(response.statusCode).toBe(201);
    const body = botTokenReplacementResponseSchema.parse(response.json());
    expect(body.changed).toBe(true);

    // The four calls, in order: identity, the prior registration, the registration, and
    // the read-back that verifies it. Nothing is stored before the read-back.
    expect(telegramMethods()).toEqual(['getMe', 'getWebhookInfo', 'setWebhook', 'getWebhookInfo']);
    const set = telegram.calls.find((call) => call.method === 'setWebhook');
    expect(set?.body).toEqual({
      url: EXPECTED_URL,
      secret_token: WEBHOOK_SECRET,
      // Customers' messages queued while the bot was silent are delivered, not dropped.
      drop_pending_updates: false,
      // The documented reset to the default update set.
      allowed_updates: [],
    });
    // What Telegram now holds, including the secret it never reports.
    expect(telegram.registration(TELEGRAM_ID)).toMatchObject({
      url: EXPECTED_URL,
      secretToken: WEBHOOK_SECRET,
      allowedUpdates: null,
    });

    // The verification the replacement made is the Web Admin's diagnostic, refreshed.
    const verification = body.verification;
    expect(verification?.identity).toEqual({
      outcome: 'IDENTIFIED',
      telegramBotId: String(TELEGRAM_ID),
      username: 'acme_store_bot',
      idMatches: true,
      usernameMatches: true,
    });
    expect(verification?.webhook).toMatchObject({
      outcome: 'READ',
      url: EXPECTED_URL,
      expectedUrl: EXPECTED_URL,
      matchesExpected: true,
      pendingUpdateCount: 4,
    });
    expect(verification?.verdict).toEqual({ readyToReceive: true, problems: [] });
    expect(body.bot.readiness).toEqual({ state: 'REGISTERED', causes: [] });
    expect(body.bot.webhook).toMatchObject({ url: EXPECTED_URL, secret: 'MATCHES' });

    // Stored, and used at once by a repository built BEFORE the replacement: nothing in a
    // process caches a token, so no api, worker or provisioner needs a restart.
    expect(await storedToken()).toBe(newToken);
    expect(await holdsBefore.tokenForBotInstance(scope as never, BOT_A1)).toBe(newToken);
    expect(await successfulReplacements()).toBe(1);

    // The Live Check agrees, asked separately with the stored credential.
    const live = await inject({
      method: 'POST',
      url: `${API_PREFIX}${BOT_ROUTES.diagnostics(BOT_A1)}`,
      headers: { cookie, origin: ORIGIN },
      payload: {},
    });
    const diagnostic = botDiagnosticResponseSchema.parse(live.json()).diagnostic;
    expect(diagnostic.verdict).toEqual({ readyToReceive: true, problems: [] });
    expect(diagnostic.webhook.matchesExpected).toBe(true);

    // And the installation accepts what Telegram will now deliver.
    expect((await deliverUpdate(1)).statusCode).toBeLessThan(300);
  });

  it('never reports a replacement when Telegram refuses the webhook, and stores nothing', async () => {
    const newToken = telegram.revoke(TELEGRAM_ID, { keepWebhook: false });
    telegram.failNext('setWebhook', {
      kind: 'refuse',
      description: 'Bad Request: bad webhook: Failed to resolve host: Name or service not known',
    });
    const response = await replace(await ownerCookie(), newToken, 'replace-refused');

    expect(response.statusCode).toBe(412);
    expect(errorOf(response).code).toBe(BOT_ERROR_CODES.BOT_WEBHOOK_REFUSED);
    const details = failureDetails(response);
    expect(details).toMatchObject({
      stage: 'SET_WEBHOOK',
      compensation: 'NOT_NEEDED',
      expectedUrl: EXPECTED_URL,
    });
    expect(details.telegramReason).toContain('Failed to resolve host');
    expect(await storedToken()).toBe(oldToken);
    expect(await successfulReplacements()).toBe(0);
    expect(response.body).not.toContain(newToken);
  });

  it('never reports a replacement when setWebhook is unanswered, and puts Telegram back as it was', async () => {
    const newToken = telegram.revoke(TELEGRAM_ID, { keepWebhook: false });
    const cookie = await ownerCookie();

    // Applied at Telegram, answer lost: the ambiguous case. The prior state had no webhook,
    // so compensation removes the one this attempt may have set.
    telegram.failNext('setWebhook', { kind: 'apply_then_drop' });
    const lost = await replace(cookie, newToken, 'replace-lost');
    expect(lost.statusCode).toBe(409);
    expect(errorOf(lost).code).toBe(BOT_ERROR_CODES.BOT_WEBHOOK_SETUP_FAILED);
    expect(failureDetails(lost)).toMatchObject({ stage: 'SET_WEBHOOK', compensation: 'RESTORED' });
    expect(telegram.registration(TELEGRAM_ID)).toBeNull();
    expect(telegramMethods()).toContain('deleteWebhook');

    // Telegram's own outage: nothing applied, nothing to remove.
    telegram.failNext('setWebhook', { kind: 'server_error' });
    const outage = await replace(cookie, newToken, 'replace-outage');
    expect(outage.statusCode).toBe(409);
    expect(failureDetails(outage)).toMatchObject({ compensation: 'RESTORED' });

    expect(await storedToken()).toBe(oldToken);
    expect(await successfulReplacements()).toBe(0);
    // Visible to the operator, without the token.
    const open = await openIncomplete();
    expect(open).toHaveLength(1);
    expect(open[0]?.context).toMatchObject({ stage: 'SET_WEBHOOK', compensation: 'RESTORED' });

    // Recoverable: the same token again completes, and closes the event.
    const retried = await replace(cookie, newToken, 'replace-retry');
    expect(retried.statusCode).toBe(201);
    expect(await storedToken()).toBe(newToken);
    expect(await openIncomplete()).toHaveLength(0);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM operational_events
                       WHERE code = ${TOKEN_REPLACEMENT_COMPLETED_CODE}`),
    ).toBe(1);
  });

  it('refuses when the read-back is not EXACTLY this installation, including a narrowed update set', async () => {
    const cookie = await ownerCookie();

    // Telegram says ok and holds nothing: the read-back is what catches it.
    const revoked = telegram.revoke(TELEGRAM_ID, { keepWebhook: false });
    telegram.failNext('setWebhook', { kind: 'ok_without_applying' });
    const unset = await replace(cookie, revoked, 'verify-unset');
    expect(unset.statusCode).toBe(409);
    expect(errorOf(unset).code).toBe(BOT_ERROR_CODES.BOT_WEBHOOK_VERIFICATION_FAILED);
    expect(failureDetails(unset)).toMatchObject({
      stage: 'VERIFY_WEBHOOK',
      expectedUrl: EXPECTED_URL,
      actualUrl: null,
    });

    // The right URL is not enough: a registration left narrowed to `message` would never
    // deliver a button press. The URL matches, the update set does not.
    telegram.setWebhookDirectly(TELEGRAM_ID, { url: EXPECTED_URL, allowedUpdates: ['message'] });
    telegram.failNext('setWebhook', { kind: 'ok_without_applying' });
    const narrowed = await replace(cookie, revoked, 'verify-narrowed');
    expect(narrowed.statusCode).toBe(409);
    expect(failureDetails(narrowed)).toMatchObject({
      stage: 'VERIFY_WEBHOOK',
      // It pointed here before; the URL is what it was, so there is nothing to undo.
      compensation: 'NOT_NEEDED',
      actualUrl: EXPECTED_URL,
    });

    expect(await storedToken()).toBe(oldToken);
    expect(await successfulReplacements()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Compensation, secrecy and double submission
  // -------------------------------------------------------------------------

  it('compensates a failure after the webhook was verified, and the bot keeps working as before', async () => {
    // Telegram kept the registration across the revocation: the bot was delivering here.
    const newToken = telegram.revoke(TELEGRAM_ID, { keepWebhook: true });
    const cookie = await ownerCookie();
    const before = botResponseSchema.parse(
      (
        await inject({
          method: 'GET',
          url: `${API_PREFIX}${BOT_ROUTES.detail(BOT_A1)}`,
          headers: { cookie, origin: ORIGIN },
        })
      ).json(),
    ).bot;

    // Storing fails after verification: another holder takes the claim over while
    // Telegram is being asked, so the activation's conditional UPDATE misses.
    telegram.beforeNext('setWebhook', async () => {
      await db().execute(sql`
        UPDATE bot_instances
           SET token_replacement_claim = '01900000-0000-7000-8000-00000000ffff',
               token_replacement_claimed_until = now() + interval '1 hour'
         WHERE id = ${BOT_A1}`);
    });
    const failed = await replace(cookie, newToken, 'activate-fails');
    expect(failed.statusCode).toBe(409);
    expect(errorOf(failed).code).toBe(BOT_ERROR_CODES.BOT_TOKEN_ACTIVATION_FAILED);
    expect(failureDetails(failed)).toMatchObject({
      stage: 'ACTIVATE',
      compensation: 'NOT_NEEDED',
      cause: BOT_ERROR_CODES.BOT_TOKEN_REPLACEMENT_IN_PROGRESS,
    });

    // Nothing half-updated: the row is as it was, credential included...
    expect(await storedToken()).toBe(oldToken);
    const after = botResponseSchema.parse(
      (
        await inject({
          method: 'GET',
          url: `${API_PREFIX}${BOT_ROUTES.detail(BOT_A1)}`,
          headers: { cookie, origin: ORIGIN },
        })
      ).json(),
    ).bot;
    expect(after).toEqual(before);
    // ...Telegram still delivers to this installation, and the installation still takes it.
    expect(telegram.registration(TELEGRAM_ID)?.url).toBe(EXPECTED_URL);
    expect((await deliverUpdate(7)).statusCode).toBeLessThan(300);
    expect(await openIncomplete()).toEqual([
      {
        severity: 'WARN',
        context: { botInstanceId: BOT_A1, stage: 'ACTIVATE', compensation: 'NOT_NEEDED' },
      },
    ]);
  });

  it('removes the webhook it set when storing fails and the bot had none before', async () => {
    const newToken = telegram.revoke(TELEGRAM_ID, { keepWebhook: false });
    const cookie = await ownerCookie();
    telegram.beforeNext('setWebhook', async () => {
      await db().execute(sql`
        UPDATE bot_instances
           SET token_replacement_claim = '01900000-0000-7000-8000-00000000ffff',
               token_replacement_claimed_until = now() + interval '1 hour'
         WHERE id = ${BOT_A1}`);
    });
    const failed = await replace(cookie, newToken, 'activate-fails-none');
    expect(failureDetails(failed)).toMatchObject({ stage: 'ACTIVATE', compensation: 'RESTORED' });
    // Back to no webhook: Telegram holds the updates rather than delivering them to an
    // installation whose stored token cannot answer them.
    expect(telegram.registration(TELEGRAM_ID)).toBeNull();
    // Compare, then delete: it removed the registration only after reading it was its own.
    expect(telegramMethods().slice(-2)).toEqual(['getWebhookInfo', 'deleteWebhook']);
    expect(await storedToken()).toBe(oldToken);

    // The competing claim lapses; the same token then completes.
    await db().execute(sql`
      UPDATE bot_instances SET token_replacement_claimed_until = now() - interval '1 second'
       WHERE id = ${BOT_A1}`);
    const retried = await replace(cookie, newToken, 'activate-retry');
    expect(retried.statusCode).toBe(201);
    expect(telegram.registration(TELEGRAM_ID)?.url).toBe(EXPECTED_URL);
  });

  it('puts no token in any audit row, operational event, outbox row, idempotency record or response', async () => {
    const cookie = await ownerCookie();
    const newToken = telegram.revoke(TELEGRAM_ID, { keepWebhook: false });
    const secretOf = (token: string) => token.split(':')[1] as string;

    telegram.failNext('setWebhook', { kind: 'server_error' });
    const failed = await replace(cookie, newToken, 'secrecy-failed');
    const succeeded = await replace(cookie, newToken, 'secrecy-ok');
    const replayed = await replace(cookie, newToken, 'secrecy-ok');
    expect([failed.statusCode, succeeded.statusCode, replayed.statusCode]).toEqual([409, 201, 201]);

    const dumps = await db().execute<{ dump: string }>(sql`
      SELECT coalesce(string_agg(row_to_json(a)::text, ''), '') AS dump FROM audit_logs a
      UNION ALL SELECT coalesce(string_agg(row_to_json(o)::text, ''), '') FROM operational_events o
      UNION ALL SELECT coalesce(string_agg(row_to_json(m)::text, ''), '') FROM outbox_messages m
      UNION ALL SELECT coalesce(string_agg(row_to_json(r)::text, ''), '') FROM request_idempotency r`);
    const everything = [
      ...dumps.rows.map((row) => row.dump),
      failed.body,
      succeeded.body,
      replayed.body,
    ].join('\n');
    for (const token of [newToken, oldToken]) {
      expect(everything).not.toContain(secretOf(token));
    }
    // The replacement WAS audited — with the identity and the registration, not the value.
    expect(await successfulReplacements()).toBe(1);
  });

  it('is safe under a double submit: one replacement, one Telegram registration, one answer', async () => {
    const cookie = await ownerCookie();
    const newToken = telegram.revoke(TELEGRAM_ID, { keepWebhook: false });

    // The first submission is held inside `setWebhook`...
    const gate = telegram.hold('setWebhook');
    const first = replace(cookie, newToken, 'double-submit');
    await gate.reached;

    // ...and the same click again, under the same key and under a fresh one, is refused
    // without a single Telegram call of its own.
    const callsBefore = telegram.calls.length;
    const sameKey = await replace(cookie, newToken, 'double-submit');
    const otherKey = await replace(cookie, newToken, 'double-submit-2');
    for (const response of [sameKey, otherKey]) {
      expect(response.statusCode).toBe(409);
      expect(errorOf(response).code).toBe(BOT_ERROR_CODES.BOT_TOKEN_REPLACEMENT_IN_PROGRESS);
    }
    expect(telegram.calls.length).toBe(callsBefore);

    gate.release();
    const done = await first;
    expect(done.statusCode).toBe(201);

    // The retry of the same key is the first answer, from the store.
    const callsAfter = telegram.calls.length;
    const replay = await replace(cookie, newToken, 'double-submit');
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(done.json());
    expect(telegram.calls.length).toBe(callsAfter);

    expect(telegramMethods().filter((method) => method === 'setWebhook')).toHaveLength(1);
    expect(await successfulReplacements()).toBe(1);
    expect(await storedToken()).toBe(newToken);
    // And the claim is free again.
    const [claim] = (
      await db().execute<{ c: string | null }>(sql`
        SELECT token_replacement_claim AS c FROM bot_instances WHERE id = ${BOT_A1}`)
    ).rows;
    expect(claim?.c).toBeNull();
  });

  it('repairs a bot left silent by an earlier replacement when its current token is submitted again', async () => {
    // The state v0.3.5 left behind: the new token stored, Telegram holding no webhook.
    const newToken = telegram.revoke(TELEGRAM_ID, { keepWebhook: false });
    const secret = api.container.cipher.encrypt(newToken, {
      purpose: 'bot_instance.token',
      tenantId: tenantA.tenantId,
      entityId: BOT_A1,
    });
    await db().execute(sql`
      UPDATE bot_instances SET token_ciphertext = ${secret.ciphertext}, token_key_id = ${secret.keyId}
       WHERE id = ${BOT_A1}`);

    const response = await replace(await ownerCookie(), newToken, 'repair-silent');
    expect(response.statusCode).toBe(201);
    const body = botTokenReplacementResponseSchema.parse(response.json());
    // The token did not change; the webhook was registered and verified all the same.
    expect(body.changed).toBe(false);
    expect(body.verification?.verdict.readyToReceive).toBe(true);
    expect(telegram.registration(TELEGRAM_ID)?.url).toBe(EXPECTED_URL);
    expect(
      await count(sql`SELECT count(*)::int AS n FROM audit_logs
                       WHERE action = 'bot_instance.webhook_registered' AND result = 'SUCCESS'`),
    ).toBe(1);
  });

  it('refuses before any Telegram call when the installation never recorded where it receives', async () => {
    await db().execute(sql`UPDATE bot_instances SET webhook_url = NULL WHERE id = ${BOT_A1}`);
    const newToken = telegram.revoke(TELEGRAM_ID, { keepWebhook: false });
    const response = await replace(await ownerCookie(), newToken, 'origin-unknown');
    expect(response.statusCode).toBe(412);
    expect(errorOf(response).code).toBe(BOT_ERROR_CODES.BOT_WEBHOOK_ORIGIN_UNKNOWN);
    expect(telegram.calls).toEqual([]);
    expect(await storedToken()).toBe(oldToken);
  });
});
