import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  BOT_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  BOT_ROUTES,
  SESSION_COOKIE_NAME,
  TELEGRAM_SECRET_TOKEN_HEADER,
  botListResponseSchema,
  botMutationResponseSchema,
  errors,
  isNexaError,
  type ActorContext,
  type BotInstanceId,
  type TenantContext,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  BotManagementService,
  type BotManagementServiceDeps,
} from '../../apps/api/src/modules/platform/tenancy/application/bot-management.service';
import type {
  BotManagementTelegram,
  BotWebhookRead,
} from '../../apps/api/src/modules/platform/tenancy/application/bot-management-ports';
import type { BotIdentityProbe } from '../../apps/api/src/modules/platform/tenancy/application/ports';
import { DrizzleBotManagementRepository } from '../../apps/api/src/modules/platform/tenancy/infrastructure/drizzle-bot-management.repository';
import { currentTransactionLabel } from '../../apps/api/src/infrastructure/transaction-boundary';
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
 * WP13 — managing a bot instance from the Web Admin (`docs/wp13-bots-management-audit.md`).
 *
 * Two halves. The HTTP half runs the real app: the permission split, tenant isolation,
 * the recorded webhook state, a stop that the webhook route and the outbound token lookup
 * both obey, and a view with no credential in it. The service half stubs Telegram at the
 * PORT (never below it — the gateway and the call core are unchanged code with their own
 * tests), because the token replacement and the live check are defined by what happens
 * around a Telegram answer, and a real socket would make those answers unrepeatable.
 */

const ORIGIN = 'https://admin.example.test';
const WEBHOOK_SECRET = 'wp13-integration-webhook-secret';
const BOT_A1 = SEED_IDS.botA1 as BotInstanceId;
const BOT_A2 = SEED_IDS.botA2 as BotInstanceId;
const BOT_B1 = SEED_IDS.botB1 as BotInstanceId;
const TELEGRAM_ID = '7000000001';
/** The URL the installer registers for BOT_A1: an origin, then the route and the bot id. */
const RECORDED_URL = `https://bot.example.test/telegram/webhook/${BOT_A1}`;
const tokenFor = (botId: string, tail: string) => `${botId}:${tail.padEnd(35, 'x')}`;

describe('WP13 bot management', () => {
  let api: ApiApp;
  let owner: ActorContext;

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  const db = () => api.container.database.db;

  beforeAll(async () => {
    const config = testConfig({
      WEB_ADMIN_ORIGINS: ORIGIN,
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    await api?.close();
  });

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
    await createAdmin(api.container, tenantA, {
      username: 'operator',
      password: 'the-operator-password',
      roleKeys: ['operator'],
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

  const ownerCookie = () => cookieFor('owner', 'the-owners-real-password');
  const operatorCookie = () => cookieFor('operator', 'the-operator-password');

  const get = async (path: string, cookie: string) =>
    inject({ method: 'GET', url: `${API_PREFIX}${path}`, headers: { cookie, origin: ORIGIN } });
  const post = async (path: string, cookie: string, payload: unknown) =>
    inject({
      method: 'POST',
      url: `${API_PREFIX}${path}`,
      headers: { cookie, origin: ORIGIN },
      payload: payload as never,
    });
  const errorOf = (response: { json: () => unknown }) =>
    (response.json() as { error: { code: string } }).error.code;

  const auditCount = async (action: string, entityId: string) =>
    (
      await db().execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM audit_logs WHERE action = ${action} AND entity_id = ${entityId}`)
    ).rows[0]?.n ?? 0;

  describe('over HTTP', () => {
    it("lists this tenant's bots with their binding and recorded state, and no credential", async () => {
      const response = await get(BOT_ROUTES.list, await ownerCookie());
      expect(response.statusCode).toBe(200);
      const body = botListResponseSchema.parse(response.json());

      expect(body.bots.map((bot) => bot.id).sort()).toEqual([BOT_A1, BOT_A2].sort());
      expect(body.installation).toEqual({
        webhookRouteEnabled: true,
        webhookSecretConfigured: true,
      });
      const active = body.bots.find((bot) => bot.id === BOT_A1);
      const stopped = body.bots.find((bot) => bot.id === BOT_A2);
      expect(active?.tenant.id).toBe(tenantA.tenantId);
      // The seed registers no webhook: recorded state says so, and never "receiving".
      expect(active?.readiness).toEqual({
        state: 'NOT_REGISTERED',
        causes: ['WEBHOOK_NEVER_REGISTERED'],
      });
      expect(stopped?.readiness.state).toBe('HELD');
      expect(stopped?.readiness.causes[0]).toBe('BOT_NOT_ACTIVE');

      // No ciphertext, key id or fingerprint in any form.
      const [row] = (
        await db().execute<{ c: string; k: string }>(sql`
          SELECT token_ciphertext AS c, token_key_id AS k FROM bot_instances WHERE id = ${BOT_A1}`)
      ).rows;
      const raw = response.body;
      expect(raw).not.toContain(row?.c ?? 'unset');
      expect(raw).not.toContain(`secret:${row?.k ?? 'unset'}`);
      expect(raw).not.toMatch(/ciphertext|tokenKeyId|fingerprint/iu);
    });

    it('compares the registered secret with the configured one, and never returns either', async () => {
      const current = createHash('sha256').update(WEBHOOK_SECRET, 'utf8').digest('hex');
      await db().execute(sql`
        UPDATE bot_instances
           SET webhook_registered_at = now(), webhook_url = 'https://bot.example.test/telegram/webhook/x',
               webhook_secret_fingerprint = ${current}
         WHERE id = ${BOT_A1}`);
      const matching = botListResponseSchema.parse(
        (await get(BOT_ROUTES.list, await ownerCookie())).json(),
      );
      const bot = matching.bots.find((candidate) => candidate.id === BOT_A1);
      expect(bot?.webhook.secret).toBe('MATCHES');
      expect(bot?.readiness).toEqual({ state: 'REGISTERED', causes: [] });

      await db().execute(sql`
        UPDATE bot_instances SET webhook_secret_fingerprint = ${'0'.repeat(64)} WHERE id = ${BOT_A1}`);
      const response = await get(BOT_ROUTES.detail(BOT_A1), await ownerCookie());
      const changed = botMutationResponseSchema.omit({ changed: true }).parse(response.json());
      expect(changed.bot.webhook.secret).toBe('DIFFERS');
      expect(changed.bot.readiness).toEqual({
        state: 'NOT_REGISTERED',
        causes: ['WEBHOOK_SECRET_CHANGED'],
      });
      expect(response.body).not.toContain(current);
    });

    it("answers another tenant's bot as unknown", async () => {
      const response = await get(BOT_ROUTES.detail(BOT_B1), await ownerCookie());
      expect(response.statusCode).toBe(404);
      expect(errorOf(response)).toBe(BOT_ERROR_CODES.BOT_NOT_FOUND);
      const stop = await post(BOT_ROUTES.status(BOT_B1), await ownerCookie(), {
        idempotencyKey: 'stop-other-tenant',
        status: 'STOPPED',
      });
      expect(stop.statusCode).toBe(404);
      const [row] = (
        await db().execute<{ status: string }>(
          sql`SELECT status FROM bot_instances WHERE id = ${BOT_B1}`,
        )
      ).rows;
      expect(row?.status).toBe('ACTIVE');
    });

    it('lets settings.view read, and refuses every act to it', async () => {
      const operator = await operatorCookie();
      expect((await get(BOT_ROUTES.list, operator)).statusCode).toBe(200);
      const stop = await post(BOT_ROUTES.status(BOT_A1), operator, {
        idempotencyKey: 'operator-stop',
        status: 'STOPPED',
      });
      expect(stop.statusCode).toBe(403);
      const token = await post(BOT_ROUTES.token(BOT_A1), operator, {
        idempotencyKey: 'operator-token',
        token: tokenFor(TELEGRAM_ID, 'a'),
      });
      expect(token.statusCode).toBe(403);
      expect((await post(BOT_ROUTES.diagnostics(BOT_A1), operator, {})).statusCode).toBe(403);

      const support = await cookieFor('support', 'the-support-password');
      expect((await get(BOT_ROUTES.list, support)).statusCode).toBe(403);
    });

    it('refuses a caller without settings.destructive before judging the token, and records it', async () => {
      const operator = await operatorCookie();
      const before = await auditCount('bot_instance.token_replace', BOT_A1);
      for (const [key, payload] of [
        ['operator-empty', { idempotencyKey: 'operator-empty', token: '' }],
        ['operator-long', { idempotencyKey: 'operator-long', token: 'x'.repeat(10_000) }],
        ['operator-none', { idempotencyKey: 'operator-none' }],
      ] as const) {
        const response = await post(BOT_ROUTES.token(BOT_A1), operator, payload);
        expect(response.statusCode, key).toBe(403);
      }
      // Each refusal is recorded, as an early refusal on every other write path is.
      expect(await auditCount('bot_instance.token_replace', BOT_A1)).toBe(before + 3);

      // The owner is still told the value is malformed.
      const owner = await ownerCookie();
      const empty = await post(BOT_ROUTES.token(BOT_A1), owner, {
        idempotencyKey: 'owner-empty',
        token: '',
      });
      expect(empty.statusCode).toBe(400);
    });

    it('replays a status change as it first answered, not as the bot stands now', async () => {
      const cookie = await ownerCookie();
      const stop = { idempotencyKey: 'snapshot-stop', status: 'STOPPED' };
      const first = botMutationResponseSchema.parse(
        (await post(BOT_ROUTES.status(BOT_A1), cookie, stop)).json(),
      );
      expect(first).toMatchObject({ changed: true, bot: { status: 'STOPPED' } });
      // Somebody starts it again before the stop's response is retried.
      await post(BOT_ROUTES.status(BOT_A1), cookie, {
        idempotencyKey: 'snapshot-start',
        status: 'ACTIVE',
      });

      const replayed = botMutationResponseSchema.parse(
        (await post(BOT_ROUTES.status(BOT_A1), cookie, stop)).json(),
      );
      expect(replayed).toEqual(first);
      // And the replay changed nothing: the bot is still the later command's ACTIVE.
      const current = await get(BOT_ROUTES.detail(BOT_A1), cookie);
      expect((current.json() as { bot: { status: string } }).bot.status).toBe('ACTIVE');
    });

    it('stops a bot so the webhook route and every outbound send refuse it, once, with an event', async () => {
      const cookie = await ownerCookie();
      const stop = await post(BOT_ROUTES.status(BOT_A1), cookie, {
        idempotencyKey: 'stop-a1-once',
        status: 'STOPPED',
      });
      expect(stop.statusCode).toBe(201);
      const body = botMutationResponseSchema.parse(stop.json());
      expect(body.changed).toBe(true);
      expect(body.bot.status).toBe('STOPPED');

      // The kill switch the status already was, now reachable: inbound and outbound.
      const webhook = await inject({
        method: 'POST',
        url: `/telegram/webhook/${BOT_A1}`,
        headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
        payload: { update_id: 1 },
      });
      expect(webhook.statusCode).toBe(404);
      expect(
        await api.container.botInstances.tokenForBotInstance(tenantA as never, BOT_A1),
      ).toBeNull();

      expect(await auditCount('bot_instance.status_change', BOT_A1)).toBe(1);
      const events = await db().execute<{ payload: { from: string; to: string } }>(sql`
        SELECT payload FROM outbox_messages
         WHERE event_type = 'BotInstanceStatusChanged' AND aggregate_id = ${BOT_A1}`);
      expect(events.rows.map((row) => row.payload)).toEqual([{ from: 'ACTIVE', to: 'STOPPED' }]);

      // A replay is answered from the store: the first answer, and nothing written twice.
      const replay = botMutationResponseSchema.parse(
        (
          await post(BOT_ROUTES.status(BOT_A1), cookie, {
            idempotencyKey: 'stop-a1-once',
            status: 'STOPPED',
          })
        ).json(),
      );
      expect(replay.changed).toBe(true);
      // A NEW request for the state it is already in changes nothing, and says so.
      const again = botMutationResponseSchema.parse(
        (
          await post(BOT_ROUTES.status(BOT_A1), cookie, {
            idempotencyKey: 'stop-a1-again',
            status: 'STOPPED',
          })
        ).json(),
      );
      expect(again.changed).toBe(false);
      expect(await auditCount('bot_instance.status_change', BOT_A1)).toBe(1);

      const start = botMutationResponseSchema.parse(
        (
          await post(BOT_ROUTES.status(BOT_A1), cookie, {
            idempotencyKey: 'start-a1',
            status: 'ACTIVE',
          })
        ).json(),
      );
      expect(start.bot.status).toBe('ACTIVE');
      expect(
        await api.container.botInstances.tokenForBotInstance(tenantA as never, BOT_A1),
      ).not.toBeNull();
    });

    it('neither sets nor clears DISABLED', async () => {
      await db().execute(sql`UPDATE bot_instances SET status = 'DISABLED' WHERE id = ${BOT_A2}`);
      const response = await post(BOT_ROUTES.status(BOT_A2), await ownerCookie(), {
        idempotencyKey: 'start-disabled',
        status: 'ACTIVE',
      });
      expect(response.statusCode).toBe(412);
      expect(errorOf(response)).toBe(BOT_ERROR_CODES.BOT_STATUS_NOT_MANAGED);
      const refused = await post(BOT_ROUTES.status(BOT_A2), await ownerCookie(), {
        idempotencyKey: 'disable-by-api',
        status: 'DISABLED',
      });
      expect(refused.statusCode).toBe(400);
    });

    it('refuses a malformed token, and a token for a bot with no recorded identity, before any call', async () => {
      const cookie = await ownerCookie();
      const malformed = await post(BOT_ROUTES.token(BOT_A1), cookie, {
        idempotencyKey: 'token-malformed',
        token: 'not a token',
      });
      expect(malformed.statusCode).toBe(400);
      expect(errorOf(malformed)).toBe(BOT_ERROR_CODES.BOT_TOKEN_MALFORMED);

      // The seed rows predate `telegram_bot_id`, so there is nothing to compare against.
      const unknown = await post(BOT_ROUTES.token(BOT_A1), cookie, {
        idempotencyKey: 'token-unknown-identity',
        token: tokenFor(TELEGRAM_ID, 'b'),
      });
      expect(unknown.statusCode).toBe(412);
      expect(errorOf(unknown)).toBe(BOT_ERROR_CODES.BOT_IDENTITY_UNKNOWN);
      expect(unknown.body).not.toContain(tokenFor(TELEGRAM_ID, 'b'));
    });
  });

  describe('token replacement and the live check, with Telegram stubbed at the port', () => {
    let calls: string[];
    let identity: BotIdentityProbe;
    let webhook: BotWebhookRead;
    let service: BotManagementService;
    let deps: BotManagementServiceDeps;
    const scope = tenantA as unknown as TenantContext;

    beforeEach(async () => {
      calls = [];
      identity = {
        outcome: 'IDENTIFIED',
        botId: TELEGRAM_ID,
        username: 'acme_store_bot',
        isBot: true,
      };
      webhook = {
        outcome: 'READ',
        url: RECORDED_URL,
        pendingUpdateCount: 3,
        lastErrorAt: new Date('2026-09-01T10:00:00Z'),
        lastErrorMessage: 'Wrong response from the webhook: 502 Bad Gateway',
        maxConnections: 40,
        allowedUpdates: null,
      };
      const telegram: BotManagementTelegram = {
        identify: async () => {
          calls.push('identify');
          return identity;
        },
        readWebhook: async () => {
          calls.push('readWebhook');
          return webhook;
        },
        // R4: a replacement registers, and the registration is what a read then reports.
        registerWebhook: async (input) => {
          calls.push('registerWebhook');
          webhook = {
            ...(webhook as Extract<BotWebhookRead, { outcome: 'READ' }>),
            url: input.url,
          };
          return { outcome: 'REGISTERED' };
        },
        removeWebhook: async () => {
          calls.push('removeWebhook');
          return { outcome: 'REMOVED' };
        },
      };
      const c = api.container;
      deps = {
        repository: new DrizzleBotManagementRepository(c.database.db, c.cipher, c.botInstances),
        telegram,
        // Round P: the real menu (templates from the database) and a sync stubbed at the
        // port — this half of the file never reaches a socket. `bot-command-sync.test.ts`
        // runs the real lane against the HTTP fake.
        commandMenu: c.commandMenu,
        commandSync: {
          requestSync: async () => undefined,
          syncNow: async (_scope, botId) => ({
            botInstanceId: botId,
            outcome: 'SKIPPED',
            errorCode: null,
          }),
        },
        guard: c.guard,
        uow: c.uow,
        audit: c.audit,
        opsLog: c.opsLog,
        sessions: c.sessions,
        idempotency: c.idempotency,
        scopeActivity: c.tenants,
        outbox: c.outbox,
        clock: c.clock,
        ids: c.ids,
        webhookSecret: () => WEBHOOK_SECRET,
        webhookEnabled: () => true,
        telegramCallTimeoutMs: 10_000,
      };
      service = new BotManagementService(deps);
      await db().execute(sql`
        UPDATE bot_instances
           SET telegram_bot_id = ${TELEGRAM_ID},
               webhook_url = ${RECORDED_URL},
               webhook_registered_at = now()
         WHERE id = ${BOT_A1}`);
    });

    const refusal = async (run: Promise<unknown>): Promise<string> => {
      try {
        await run;
      } catch (error) {
        if (isNexaError(error)) return error.code;
        throw error;
      }
      throw new Error('expected a refusal');
    };

    it('refuses a token for another bot by its own claim, without asking Telegram', async () => {
      const code = await refusal(
        service.replaceToken(scope, owner, {
          idempotencyKey: 'other-bot-claim',
          botId: BOT_A1,
          token: tokenFor('7000000999', 'c'),
        }),
      );
      expect(code).toBe(BOT_ERROR_CODES.BOT_TOKEN_DIFFERENT_BOT);
      expect(calls).toEqual([]);
    });

    it('refuses before any Telegram call when this installation could not receive what it registered', async () => {
      const next = tokenFor(TELEGRAM_ID, 'unservable');
      for (const [label, changed] of [
        ['route off', { webhookEnabled: () => false }],
        ['no secret', { webhookSecret: () => '' }],
        ['short secret', { webhookSecret: () => 'too-short' }],
      ] as const) {
        const unservable = new BotManagementService({ ...deps, ...changed });
        expect(
          await refusal(
            unservable.replaceToken(scope, owner, {
              idempotencyKey: `unservable-${label}`,
              botId: BOT_A1,
              token: next,
            }),
          ),
          label,
        ).toBe(BOT_ERROR_CODES.BOT_WEBHOOK_ROUTE_UNAVAILABLE);
      }
      // A recorded URL that is not this bot's route is not an origin to build from.
      await db().execute(sql`
        UPDATE bot_instances SET webhook_url = 'https://bot.example.test/telegram/webhook/a1'
         WHERE id = ${BOT_A1}`);
      expect(
        await refusal(
          service.replaceToken(scope, owner, {
            idempotencyKey: 'foreign-recorded-url',
            botId: BOT_A1,
            token: next,
          }),
        ),
      ).toBe(BOT_ERROR_CODES.BOT_WEBHOOK_ORIGIN_UNKNOWN);
      expect(calls).toEqual([]);
    });

    it('refuses a token Telegram identifies as another bot, and one Telegram rejects, writing nothing', async () => {
      const before = await api.container.botInstances.resolveToken(scope as never, BOT_A1);
      identity = {
        outcome: 'IDENTIFIED',
        botId: '7000000999',
        username: 'someone_else_bot',
        isBot: true,
      };
      expect(
        await refusal(
          service.replaceToken(scope, owner, {
            idempotencyKey: 'telegram-says-other',
            botId: BOT_A1,
            token: tokenFor(TELEGRAM_ID, 'd'),
          }),
        ),
      ).toBe(BOT_ERROR_CODES.BOT_TOKEN_DIFFERENT_BOT);

      identity = { outcome: 'REJECTED', detail: 'Unauthorized' };
      expect(
        await refusal(
          service.replaceToken(scope, owner, {
            idempotencyKey: 'telegram-rejects',
            botId: BOT_A1,
            token: tokenFor(TELEGRAM_ID, 'e'),
          }),
        ),
      ).toBe(BOT_ERROR_CODES.BOT_TOKEN_REJECTED);

      identity = { outcome: 'UNREACHABLE', detail: 'timeout' };
      expect(
        await refusal(
          service.replaceToken(scope, owner, {
            idempotencyKey: 'telegram-unreachable',
            botId: BOT_A1,
            token: tokenFor(TELEGRAM_ID, 'f'),
          }),
        ),
      ).toBe(BOT_ERROR_CODES.BOT_TELEGRAM_UNREACHABLE);

      expect(await api.container.botInstances.resolveToken(scope as never, BOT_A1)).toBe(before);
      /*
       * Nothing SUCCEEDED — and, since hardening 2026-10-07 (incident A), each attempt is
       * still attributable afterwards: one FAILED row per attempt, naming the step it stopped
       * at and the code, never the token. Before, these three left no trace at all.
       */
      const rows = (
        await db().execute<{ result: string; after: Record<string, unknown> }>(sql`
          SELECT result, after FROM audit_logs
           WHERE action = 'bot_instance.token_replace' AND entity_id = ${BOT_A1}
           ORDER BY occurred_at, id`)
      ).rows;
      expect(rows.map((row) => row.result)).toEqual(['FAILED', 'FAILED', 'FAILED']);
      expect(rows.map((row) => [row.after['stage'], row.after['errorCode']])).toEqual([
        ['GET_ME', BOT_ERROR_CODES.BOT_TOKEN_DIFFERENT_BOT],
        ['GET_ME', BOT_ERROR_CODES.BOT_TOKEN_REJECTED],
        ['GET_ME', BOT_ERROR_CODES.BOT_TELEGRAM_UNREACHABLE],
      ]);
      expect(JSON.stringify(rows)).not.toContain(tokenFor(TELEGRAM_ID, 'e').split(':')[1]);
    });

    // -----------------------------------------------------------------------
    // Hardening 2026-10-07 review: the failure audit's three unpinned rules.
    // -----------------------------------------------------------------------
    const replacementAudit = async () =>
      (
        await db().execute<{ result: string; after: Record<string, unknown> }>(sql`
          SELECT result, after FROM audit_logs
           WHERE action = 'bot_instance.token_replace' AND entity_id = ${BOT_A1}
           ORDER BY occurred_at, id`)
      ).rows;

    it('a permission withdrawn mid-replacement is ONE denied row, never also a failed one', async () => {
      // The early check passes; the guard inside the claim's transaction refuses — the
      // owner's role changed between the two. `recordMutationDenial` writes the DENIED row;
      // a FAILED row beside it would count one refusal twice.
      const denying = new BotManagementService({
        ...deps,
        guard: {
          check: async (
            s: TenantContext,
            a: ActorContext,
            permission: Parameters<typeof api.container.guard.check>[2],
            tx?: unknown,
          ) => {
            if (tx !== undefined) {
              throw errors.permissionDenied(
                PLATFORM_ERROR_CODES.PERMISSION_DENIED,
                `Missing permission "${permission}".`,
                { permission },
              );
            }
            return api.container.guard.check(s, a, permission, tx);
          },
          denialEvent: (a: ActorContext, permission: string) =>
            api.container.guard.denialEvent(a, permission),
        } as never,
      });
      const code = await refusal(
        denying.replaceToken(scope, owner, {
          idempotencyKey: 'denied-mid-flight',
          botId: BOT_A1,
          token: tokenFor(TELEGRAM_ID, 'denied'),
        }),
      );
      expect(code).toBe(PLATFORM_ERROR_CODES.PERMISSION_DENIED);
      expect((await replacementAudit()).map((row) => row.result)).toEqual(['DENIED']);
      expect(calls).toEqual([]);
    });

    it("an audit writer that fails does not replace the replacement's own error", async () => {
      identity = { outcome: 'REJECTED', detail: 'Unauthorized' };
      const brokenAudit = new BotManagementService({
        ...deps,
        audit: {
          record: async (s, a, entry, tx) => {
            if (entry.result === 'FAILED') throw new Error('audit store unavailable');
            return api.container.audit.record(s, a, entry, tx as never);
          },
        },
      });
      expect(
        await refusal(
          brokenAudit.replaceToken(scope, owner, {
            idempotencyKey: 'audit-down',
            botId: BOT_A1,
            token: tokenFor(TELEGRAM_ID, 'auditdown'),
          }),
        ),
      ).toBe(BOT_ERROR_CODES.BOT_TOKEN_REJECTED);
    });

    it('records a failure that is not a NexaError by the code the error filter answers it with', async () => {
      // A ZodError: the token's shape, parsed after the permission.
      await expect(
        service.replaceToken(scope, owner, {
          idempotencyKey: 'not-a-string',
          botId: BOT_A1,
          token: 12345,
        }),
      ).rejects.toBeTruthy();
      // A bug: the port throws something that is not a NexaError at all.
      const throwing = new BotManagementService({
        ...deps,
        telegram: {
          ...deps.telegram,
          identify: async () => {
            throw new TypeError('boom');
          },
        },
      });
      await expect(
        throwing.replaceToken(scope, owner, {
          idempotencyKey: 'bug',
          botId: BOT_A1,
          token: tokenFor(TELEGRAM_ID, 'bug'),
        }),
      ).rejects.toThrow('boom');
      expect((await replacementAudit()).map((row) => [row.result, row.after['errorCode']])).toEqual(
        [
          ['FAILED', 'request.invalid'],
          ['FAILED', 'internal.unhandled'],
        ],
      );
    });

    // The four Telegram calls a replacement makes, in order (R4): identity, the prior
    // registration, the registration, and the read-back that verifies it.
    const REPLACEMENT_CALLS = ['identify', 'readWebhook', 'registerWebhook', 'readWebhook'];

    it('replaces the token of the same bot, audited without the value, and a stopped bot too', async () => {
      await db().execute(sql`UPDATE bot_instances SET status = 'STOPPED' WHERE id = ${BOT_A1}`);
      const next = tokenFor(TELEGRAM_ID, 'fresh');
      const outcome = await service.replaceToken(scope, owner, {
        idempotencyKey: 'replace-a1',
        botId: BOT_A1,
        token: next,
      });
      expect(outcome.changed).toBe(true);
      expect(outcome.bot.status).toBe('STOPPED');
      expect(calls).toEqual(REPLACEMENT_CALLS);
      expect(await api.container.botInstances.resolveToken(scope as never, BOT_A1)).toBe(next);
      // Verified, and truthful about the stop: the webhook is right, the bot is not ready.
      expect(outcome.verification?.webhook.matchesExpected).toBe(true);
      expect(outcome.verification?.verdict).toEqual({
        readyToReceive: false,
        problems: ['BOT_NOT_ACTIVE'],
      });

      const audits = await db().execute<{ after: unknown; before: unknown }>(sql`
        SELECT "after", "before" FROM audit_logs WHERE action = 'bot_instance.token_replace'`);
      expect(audits.rows).toHaveLength(1);
      expect(JSON.stringify(audits.rows)).not.toContain(next.split(':')[1] as string);

      // The same token again changes no credential — and still registers and verifies the
      // webhook (R4): that is how a bot left silent by an earlier replacement is repaired.
      calls.length = 0;
      const same = await service.replaceToken(scope, owner, {
        idempotencyKey: 'replace-a1-same',
        botId: BOT_A1,
        token: next,
      });
      expect(same.changed).toBe(false);
      expect(calls).toEqual(REPLACEMENT_CALLS);
      expect(await auditCount('bot_instance.token_replace', BOT_A1)).toBe(1);
      expect(await auditCount('bot_instance.webhook_registered', BOT_A1)).toBe(1);
    });

    it('decides whether the token changed only under the row lock, never from an earlier read', async () => {
      const mine = tokenFor(TELEGRAM_ID, 'mine');
      const theirs = tokenFor(TELEGRAM_ID, 'theirs');
      // The stored token is somebody else's replacement.
      await service.replaceToken(scope, owner, {
        idempotencyKey: 'theirs',
        botId: BOT_A1,
        token: theirs,
      });
      calls.length = 0;
      // R4 removed the unlocked "same token" short-cut: every comparison with the stored
      // token on this path is made inside the activating transaction, under the bot's
      // lock, so no replacement can commit between the comparison and the write. A read
      // outside it would be a decision taken on a value that may already have moved.
      const c = api.container;
      const real = new DrizzleBotManagementRepository(c.database.db, c.cipher, c.botInstances);
      const readInside: boolean[] = [];
      const watched = new BotManagementService({
        repository: Object.assign(Object.create(real) as typeof real, {
          resolveToken: async (s: never, id: never) => {
            readInside.push(currentTransactionLabel() !== undefined);
            return real.resolveToken(s, id);
          },
        }),
        telegram: {
          identify: async () => {
            calls.push('identify');
            return identity;
          },
          readWebhook: async () => {
            calls.push('readWebhook');
            return webhook;
          },
          registerWebhook: async () => {
            calls.push('registerWebhook');
            return { outcome: 'REGISTERED' };
          },
          removeWebhook: async () => ({ outcome: 'REMOVED' }),
        },
        commandMenu: c.commandMenu,
        commandSync: deps.commandSync,
        guard: c.guard,
        uow: c.uow,
        audit: c.audit,
        opsLog: c.opsLog,
        sessions: c.sessions,
        idempotency: c.idempotency,
        scopeActivity: c.tenants,
        outbox: c.outbox,
        clock: c.clock,
        ids: c.ids,
        webhookSecret: () => WEBHOOK_SECRET,
        webhookEnabled: () => true,
        telegramCallTimeoutMs: 10_000,
      });

      const outcome = await watched.replaceToken(scope, owner, {
        idempotencyKey: 'mine',
        botId: BOT_A1,
        token: mine,
      });
      expect(outcome.changed).toBe(true);
      expect(calls).toEqual(REPLACEMENT_CALLS);
      expect(readInside).toEqual([true]);
      expect(await api.container.botInstances.resolveToken(scope as never, BOT_A1)).toBe(mine);
    });

    /*
     * Codex F3. A COMMIT that landed and whose acknowledgement was lost throws like one
     * that did not. Compensating then would delete a verified webhook for a token that WAS
     * stored, so the durable outcome is read first.
     */
    describe('an activation whose outcome is ambiguous', () => {
      /** A unit of work that commits the activation (its second run) and then throws. */
      const ackLost = (): BotManagementServiceDeps['uow'] => {
        let runs = 0;
        return {
          ...deps.uow,
          run: async (runScope, fn) => {
            runs += 1;
            const result = await deps.uow.run(runScope, fn);
            if (runs === 2) throw new Error('connection lost after COMMIT');
            return result;
          },
        } as BotManagementServiceDeps['uow'];
      };

      beforeEach(() => {
        // No webhook before, so a compensation WOULD delete the one this attempt set.
        webhook = { ...(webhook as Extract<BotWebhookRead, { outcome: 'READ' }>), url: null };
      });

      it('answers the committed replacement and compensates nothing', async () => {
        const next = tokenFor(TELEGRAM_ID, 'committed');
        const ambiguous = new BotManagementService({ ...deps, uow: ackLost() });
        const outcome = await ambiguous.replaceToken(scope, owner, {
          idempotencyKey: 'ack-lost',
          botId: BOT_A1,
          token: next,
        });
        expect(outcome.changed).toBe(true);
        expect(outcome.verification?.webhook.matchesExpected).toBe(true);
        expect(calls).not.toContain('removeWebhook');
        expect(await api.container.botInstances.resolveToken(scope as never, BOT_A1)).toBe(next);
      });

      it('runs nothing destructive when the outcome cannot be read, and says so', async () => {
        // The replay check on arrival reads normally; the read after the lost COMMIT fails.
        let finds = 0;
        const ambiguous = new BotManagementService({
          ...deps,
          uow: ackLost(),
          idempotency: {
            ...deps.idempotency,
            find: async (...args: Parameters<typeof deps.idempotency.find>) => {
              finds += 1;
              if (finds > 1) throw new Error('database unreachable');
              return deps.idempotency.find(...args);
            },
            remember: deps.idempotency.remember.bind(deps.idempotency),
          },
        });
        const error = await ambiguous
          .replaceToken(scope, owner, {
            idempotencyKey: 'ack-lost-unknown',
            botId: BOT_A1,
            token: tokenFor(TELEGRAM_ID, 'unknown'),
          })
          .then(() => null)
          .catch((caught: unknown) => caught);
        expect(isNexaError(error) && error.code).toBe(BOT_ERROR_CODES.BOT_TOKEN_ACTIVATION_FAILED);
        expect(isNexaError(error) && error.details['compensation']).toBe('FAILED');
        expect(calls).not.toContain('removeWebhook');
      });
    });

    it('refuses a reused key sent with a different token, and never reports it replaced', async () => {
      const first = tokenFor(TELEGRAM_ID, 'first');
      expect(
        (
          await service.replaceToken(scope, owner, {
            idempotencyKey: 'replace-reused',
            botId: BOT_A1,
            token: first,
          })
        ).changed,
      ).toBe(true);

      // The response was lost; the operator retries the same key with another token —
      // another bot's, or a newer one for this bot from BotFather.
      for (const other of [tokenFor('7000000999', 'x'), tokenFor(TELEGRAM_ID, 'newer')]) {
        expect(
          await refusal(
            service.replaceToken(scope, owner, {
              idempotencyKey: 'replace-reused',
              botId: BOT_A1,
              token: other,
            }),
          ),
        ).toBe(PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH);
      }
      expect(await api.container.botInstances.resolveToken(scope as never, BOT_A1)).toBe(first);

      // The same key with the token it stored still answers as itself.
      const again = await service.replaceToken(scope, owner, {
        idempotencyKey: 'replace-reused',
        botId: BOT_A1,
        token: first,
      });
      expect(again.changed).toBe(true);
      // A replay: answered from the store, Telegram not asked again.
      expect(calls).toEqual(REPLACEMENT_CALLS);
    });

    it('shows a webhook URL in full only when it is the recorded one, and a foreign one by its origin', async () => {
      const recorded = await service.diagnose(scope, owner, BOT_A1);
      expect(recorded.webhook.url).toBe(RECORDED_URL);

      // A legacy registration that carries the bot token in its path.
      webhook = {
        ...webhook,
        url: `https://legacy.example.test/${tokenFor(TELEGRAM_ID, 'LEAKED')}/hook`,
      } as BotWebhookRead;
      const foreign = await service.diagnose(scope, owner, BOT_A1);
      expect(foreign.webhook.url).toBe('https://legacy.example.test/…');
      expect(foreign.webhook.urlMatchesRecorded).toBe(false);
      expect(JSON.stringify(foreign)).not.toContain('LEAKED');
    });

    it('reports what Telegram holds, and compares it with what was recorded', async () => {
      const diagnostic = await service.diagnose(scope, owner, BOT_A1);
      expect(calls).toEqual(['identify', 'readWebhook']);
      expect(diagnostic.identity).toEqual({
        outcome: 'IDENTIFIED',
        telegramBotId: TELEGRAM_ID,
        username: 'acme_store_bot',
        idMatches: true,
        usernameMatches: true,
      });
      expect(diagnostic.webhook).toMatchObject({
        outcome: 'READ',
        urlMatchesRecorded: true,
        pendingUpdateCount: 3,
        lastErrorAt: '2026-09-01T10:00:00.000Z',
        maxConnections: 40,
        expectedUrl: RECORDED_URL,
        matchesExpected: true,
      });
      // Registered at the right URL, but never recorded as made with the current secret.
      expect(diagnostic.verdict).toEqual({
        readyToReceive: false,
        problems: ['WEBHOOK_SECRET_NOT_CURRENT'],
      });

      webhook = { ...webhook, url: 'https://elsewhere.example.test/hook' } as BotWebhookRead;
      identity = { outcome: 'IDENTIFIED', botId: TELEGRAM_ID, username: 'renamed_bot' };
      const drifted = await service.diagnose(scope, owner, BOT_A1);
      expect(drifted.webhook.urlMatchesRecorded).toBe(false);
      expect(drifted.webhook.matchesExpected).toBe(false);
      expect(drifted.verdict.problems).toContain('WEBHOOK_ELSEWHERE');
      expect(drifted.identity.usernameMatches).toBe(false);
    });

    it('skips the webhook read when the token is refused, and never checks a stopped bot', async () => {
      identity = { outcome: 'REJECTED', detail: 'Unauthorized' };
      const refused = await service.diagnose(scope, owner, BOT_A1);
      expect(refused.webhook.outcome).toBe('SKIPPED');
      expect(calls).toEqual(['identify']);

      calls = [];
      expect(await refusal(service.diagnose(scope, owner, BOT_A2))).toBe(
        BOT_ERROR_CODES.BOT_NOT_ACTIVE,
      );
      expect(calls).toEqual([]);
    });
  });
});
