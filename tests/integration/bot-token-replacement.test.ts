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
  // Round P (COMMAND-MENU): the replacement re-registers the command menu AFTERWARDS,
  // as a separate result that never fails the replacement.
  // -------------------------------------------------------------------------

  const syncRow = async () =>
    (
      await db().execute<{
        attempts: number;
        next_attempt_at: string | null;
        last_error_code: string | null;
        last_synced_at: string | null;
      }>(sql`
        SELECT attempts, next_attempt_at, last_error_code, last_synced_at
          FROM bot_command_syncs WHERE bot_instance_id = ${BOT_A1}`)
    ).rows[0];
  const storedRevision = async () =>
    (
      await db().execute<{ r: string | null }>(sql`
        SELECT commands_revision AS r FROM bot_instances WHERE id = ${BOT_A1}`)
    ).rows[0]?.r ?? null;

  it('registers the command menu with the new token after storing it, and the answer carries both', async () => {
    const newToken = telegram.revoke(TELEGRAM_ID, { keepWebhook: false });
    const cookie = await ownerCookie();

    const response = await replace(cookie, newToken, 'replace-and-sync');
    expect(response.statusCode).toBe(201);
    const body = botTokenReplacementResponseSchema.parse(response.json());
    expect(body.changed).toBe(true);
    expect(body.commandSync).toEqual({ outcome: 'SYNCED', errorCode: null });

    // The four calls that decide the replacement, THEN the menu — never before the token
    // is stored, so a menu failure can have nothing to undo.
    expect(telegramMethods()).toEqual([
      'getMe',
      'getWebhookInfo',
      'setWebhook',
      'getWebhookInfo',
      'setMyCommands',
    ]);
    // Exactly the customer scope, with the tenant's own words, and nothing of the panel's.
    const desired = await api.container.commandMenu.desiredFor(scope);
    expect(telegram.registeredCommands(TELEGRAM_ID)).toEqual(desired.entries);
    expect(telegram.registeredCommands(TELEGRAM_ID).map((entry) => entry.command)).not.toContain(
      'admin',
    );
    expect(await storedRevision()).toBe(desired.hash);
    // The answer's `bot` is the snapshot remembered BEFORE the sync (a replay must answer
    // the first result); the bots page reads the live state, which is now current.
    const detail = await inject({
      method: 'GET',
      url: `${API_PREFIX}${BOT_ROUTES.detail(BOT_A1)}`,
      headers: { cookie, origin: ORIGIN },
    });
    expect(botResponseSchema.parse(detail.json()).bot.commandMenu).toBe('CURRENT');
    const row = await syncRow();
    expect(row?.attempts).toBe(0);
    expect(row?.next_attempt_at).toBeNull();
    expect(row?.last_synced_at).not.toBeNull();
  });

  it('keeps a replacement whose menu registration failed a SUCCESS, with the failure as a separate warning', async () => {
    const newToken = telegram.revoke(TELEGRAM_ID, { keepWebhook: false });
    const cookie = await ownerCookie();
    telegram.failNext('setMyCommands', { kind: 'server_error' });

    const response = await replace(cookie, newToken, 'replace-menu-fails');
    // The webhook and the token are the success criterion — and they succeeded.
    expect(response.statusCode).toBe(201);
    const body = botTokenReplacementResponseSchema.parse(response.json());
    expect(body.changed).toBe(true);
    expect(body.verification?.verdict).toEqual({ readyToReceive: true, problems: [] });
    expect(await storedToken()).toBe(newToken);
    expect(await successfulReplacements()).toBe(1);
    expect(await openIncomplete()).toEqual([]);
    // The menu is a SEPARATE, recoverable warning: named, coded, and queued for the lane.
    expect(body.commandSync).toEqual({ outcome: 'FAILED', errorCode: 'telegram.server_error.500' });
    expect(body.bot.commandMenu).not.toBe('CURRENT');
    const row = await syncRow();
    expect(row?.attempts).toBe(1);
    expect(row?.last_error_code).toBe('telegram.server_error.500');
    expect(row?.next_attempt_at).not.toBeNull();
    // Telegram still holds whatever it held: nothing was registered.
    expect(telegram.registeredCommands(TELEGRAM_ID)).toEqual([]);

    // And the lane's next pass, once Telegram answers, converges without the operator.
    const tick = await api.container.botCommandSync.tick(new Date(Date.now() + 60 * 60_000));
    expect(tick).toMatchObject({ claimed: 1, synced: 1, failed: 0 });
    expect(telegram.registeredCommands(TELEGRAM_ID)).toEqual(
      (await api.container.commandMenu.desiredFor(scope)).entries,
    );
    expect((await syncRow())?.attempts).toBe(0);
  });

  it('answers a replayed replacement without a second menu registration, and says so', async () => {
    const newToken = telegram.revoke(TELEGRAM_ID, { keepWebhook: false });
    const cookie = await ownerCookie();
    const first = botTokenReplacementResponseSchema.parse(
      (await replace(cookie, newToken, 'replay-sync')).json(),
    );
    expect(first.commandSync?.outcome).toBe('SYNCED');
    const calls = telegram.calls.length;

    const replay = botTokenReplacementResponseSchema.parse(
      (await replace(cookie, newToken, 'replay-sync')).json(),
    );
    // The first answer, from the store: the sync ran after it was remembered, so it is
    // reported as not having been run by THIS answer rather than invented.
    expect(replay.commandSync).toBeNull();
    expect(replay.bot).toEqual(first.bot);
    expect(telegram.calls.length).toBe(calls);
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
    // the read-back that verifies it. Nothing is stored before the read-back. Round P adds
    // the command menu AFTER the token is stored (asserted on its own below).
    expect(telegramMethods()).toEqual([
      'getMe',
      'getWebhookInfo',
      'setWebhook',
      'getWebhookInfo',
      'setMyCommands',
    ]);
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
    // ...Telegram still delivers to this installation, and once the replacement that took
    // the claim over is done (Codex F1 holds updates while it runs), the installation
    // takes them.
    expect(telegram.registration(TELEGRAM_ID)?.url).toBe(EXPECTED_URL);
    await db().execute(sql`
      UPDATE bot_instances SET token_replacement_claim = NULL, token_replacement_claimed_until = NULL
       WHERE id = ${BOT_A1}`);
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

    // The retry of the same key is the first answer, from the store — except the
    // command-menu sync, which ran after that answer was remembered and is reported as
    // not run by the replay (round P) rather than invented.
    const callsAfter = telegram.calls.length;
    const replay = await replace(cookie, newToken, 'double-submit');
    expect(replay.statusCode).toBe(201);
    const { commandSync: firstSync, ...firstRest } = done.json() as Record<string, unknown>;
    const { commandSync: replaySync, ...replayRest } = replay.json() as Record<string, unknown>;
    expect(replayRest).toEqual(firstRest);
    expect(firstSync).toEqual({ outcome: 'SYNCED', errorCode: null });
    expect(replaySync).toBeNull();
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

  /*
   * Codex F1. A replacement registers the webhook before it stores the token, and Telegram
   * may start flushing its queue at once. Handled then, an update would be answered with
   * the revoked token still stored and lost after a 2xx; held with a non-2xx, Telegram
   * delivers it again once the replacement is done.
   */
  it('holds inbound updates while a live replacement claim is held, and handles them after', async () => {
    const ping = (updateId: number) =>
      inject({
        method: 'POST',
        url: `/telegram/webhook/${BOT_A1}`,
        headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
        payload: {
          update_id: updateId,
          message: { message_id: 1, date: 0, chat: { id: 1, type: 'private' }, text: '/ping' },
        },
      });
    const handled = (updateId: number) =>
      count(sql`SELECT count(*)::int AS n FROM request_idempotency
                 WHERE key = ${`telegram:${BOT_A1}:update:${updateId}`}`);
    const claim = (until: string) =>
      db().execute(sql`
        UPDATE bot_instances
           SET token_replacement_claim = '01900000-0000-7000-8000-00000000ffff',
               token_replacement_claimed_until = ${until}::timestamptz
         WHERE id = ${BOT_A1}`);

    await claim(new Date(Date.now() + 60 * 60_000).toISOString());
    const held = await ping(901);
    expect(held.statusCode).toBe(409);
    expect(errorOf(held).code).toBe(BOT_ERROR_CODES.BOT_TOKEN_REPLACEMENT_IN_PROGRESS);
    // Nothing written for it, so the redelivery is not a replay of a half-handled update.
    expect(await handled(901)).toBe(0);

    await db().execute(sql`
      UPDATE bot_instances SET token_replacement_claim = NULL, token_replacement_claimed_until = NULL
       WHERE id = ${BOT_A1}`);
    const redelivered = await ping(901);
    expect(redelivered.statusCode).toBeLessThan(300);
    expect(await handled(901)).toBe(1);

    // A claim whose lease lapsed (its holder died) holds nothing back.
    await claim(new Date(Date.now() - 1_000).toISOString());
    expect((await ping(902)).statusCode).toBeLessThan(300);
    expect(await handled(902)).toBe(1);
  });
  // -------------------------------------------------------------------------
  // Hardening 2026-10-07, incident A: after a server move `botctl telegram status` said
  // `ready` (local marker) while Telegram held `url: ""` with 22 updates queued, replies
  // failed `telegram.rejected.401`, and several panel replacements did not bring it back.
  // The real gateway, call core and repository below; only Telegram is the HTTP fake.
  // -------------------------------------------------------------------------

  const ORIGIN_OF_EXPECTED = 'https://bot.example.test';
  const bootstrapStatus = () =>
    api.container.bootstrapBot.statusWithReason(
      { tenantId: tenantA.tenantId, botInstanceId: null } as TenantContext,
      ORIGIN_OF_EXPECTED,
    );
  const webhookBodies = () =>
    telegram.calls
      .filter((call) => call.method === 'setWebhook' || call.method === 'deleteWebhook')
      .map((call) => call.body);

  it('status: ready only when the marker AND Telegram agree; a revoked stored token is unavailable, not ready', async () => {
    // As the installer left it: marker current, Telegram holding EXPECTED_URL.
    const ready = await bootstrapStatus();
    expect(ready).toMatchObject({ state: 'ready', reason: null });
    expect(ready.detail?.remote).toMatchObject({ outcome: 'READ', url: EXPECTED_URL });

    // The incident: BotFather revoked the token and the webhook went with it. The MARKER is
    // unchanged, and that is exactly what the old status answered from.
    const newToken = telegram.revoke(TELEGRAM_ID, { keepWebhook: false });
    telegram.setPending(TELEGRAM_ID, 22);
    const revoked = await bootstrapStatus();
    expect(revoked.state).toBe('unavailable');
    expect(revoked.detail?.local.registered).toBe(true);
    expect(revoked.detail?.remote.outcome).toBe('TOKEN_REJECTED');
    expect(revoked.reason).toContain('Web Admin');
    const text = JSON.stringify(revoked);
    expect(text).not.toContain(oldToken);
    expect(text).not.toContain(newToken);
    expect(text).not.toContain(WEBHOOK_SECRET);
    // Status is read-only: no registration was attempted.
    expect(webhookBodies()).toEqual([]);
  });

  it('register reconciles a webhook Telegram dropped: reads first, keeps all 22 queued updates, reads back', async () => {
    telegram.setWebhookDirectly(TELEGRAM_ID, null);
    telegram.setPending(TELEGRAM_ID, 22);
    const before = await bootstrapStatus();
    expect(before.state).toBe('incomplete');
    expect(before.detail?.remote).toMatchObject({ url: null, pendingUpdateCount: 22 });
    telegram.calls.length = 0;

    const result = await api.container.bootstrapBot.execute(
      { tenantId: tenantA.tenantId, botInstanceId: null } as TenantContext,
      { token: null, publicBaseUrl: ORIGIN_OF_EXPECTED },
    );
    expect(result.kind).toBe('RECONCILED');
    expect(telegramMethods().slice(0, 4)).toEqual([
      'getMe',
      'getWebhookInfo',
      'setWebhook',
      'getWebhookInfo',
    ]);
    for (const body of webhookBodies()) expect(body['drop_pending_updates']).toBe(false);
    expect(telegram.registration(TELEGRAM_ID)).toMatchObject({
      url: EXPECTED_URL,
      secretToken: WEBHOOK_SECRET,
    });
    const after = await bootstrapStatus();
    expect(after.state).toBe('ready');
    expect(after.detail?.remote.pendingUpdateCount).toBe(22);
  });

  it('a replacement that cannot register fails EXPLICITLY and is attributable; the queue survives every attempt', async () => {
    const newToken = telegram.revoke(TELEGRAM_ID, { keepWebhook: false });
    telegram.setPending(TELEGRAM_ID, 22);
    const cookie = await ownerCookie();

    // 1. Telegram refuses the URL: nothing changed at Telegram, nothing stored.
    telegram.failNext('setWebhook', { kind: 'refuse', description: 'Bad Request: bad webhook' });
    expect((await replace(cookie, newToken, 'incident-1')).statusCode).toBe(412);
    // 2. The registration lands and its answer is lost: compensation REMOVES it again,
    //    which is how a failed attempt leaves exactly `url: ""` behind.
    telegram.failNext('setWebhook', { kind: 'apply_then_drop' });
    expect((await replace(cookie, newToken, 'incident-2')).statusCode).toBe(409);
    expect(telegram.registration(TELEGRAM_ID)).toBeNull();
    // 3. Telegram cannot be asked at all.
    telegram.failNext('getMe', { kind: 'server_error' });
    expect((await replace(cookie, newToken, 'incident-3')).statusCode).toBeGreaterThanOrEqual(500);

    expect(await storedToken()).toBe(oldToken);
    // Every attempt is in the audit log with the step it stopped at — none of the token.
    const failed = (
      await db().execute<{ after: Record<string, unknown> }>(sql`
        SELECT after FROM audit_logs
         WHERE action = 'bot_instance.token_replace' AND result = 'FAILED'
         ORDER BY occurred_at, id`)
    ).rows.map((row) => row.after);
    expect(failed.map((after) => after['stage'])).toEqual(['SET_WEBHOOK', 'SET_WEBHOOK', 'GET_ME']);
    expect(failed[0]).toMatchObject({
      errorCode: BOT_ERROR_CODES.BOT_WEBHOOK_REFUSED,
      compensation: 'NOT_NEEDED',
      telegramReason: expect.stringContaining('bad webhook'),
    });
    expect(failed[1]).toMatchObject({
      errorCode: BOT_ERROR_CODES.BOT_WEBHOOK_SETUP_FAILED,
      compensation: 'RESTORED',
    });
    expect(failed[2]).toMatchObject({ errorCode: BOT_ERROR_CODES.BOT_TELEGRAM_UNREACHABLE });
    expect(JSON.stringify(failed)).not.toContain(newToken);

    // 4. The same token once Telegram behaves: verified, stored, queue intact.
    const done = await replace(cookie, newToken, 'incident-4');
    expect(done.statusCode).toBe(201);
    expect(await storedToken()).toBe(newToken);
    for (const body of webhookBodies()) expect(body['drop_pending_updates']).toBe(false);
    expect(
      botTokenReplacementResponseSchema.parse(done.json()).verification?.webhook,
    ).toMatchObject({ url: EXPECTED_URL, matchesExpected: true, pendingUpdateCount: 22 });
    await expect(bootstrapStatus()).resolves.toMatchObject({ state: 'ready' });
  });
});
