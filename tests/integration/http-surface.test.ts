import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  CONTROL_ROUTES,
  healthLiveResponseSchema,
  healthReadyResponseSchema,
  SESSION_COOKIE_NAME,
  systemReadinessResponseSchema,
  TELEGRAM_SECRET_TOKEN_HEADER,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { auditLogs, outboxMessages } from '../../apps/api/src/infrastructure/persistence/schema';
import { createAdmin, migrateOnce, resetDatabase, tenantA, testConfig } from './harness';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { telegramUpdateKey } from '../../apps/api/src/surfaces/telegram/webhook.controller';

const WEBHOOK_SECRET = 'a-sufficiently-long-secret';

/**
 * The webhook route names the bot instance.
 *
 * Telegram's `update_id` is a per-bot sequence, so two bots in one installation
 * routinely produce the same id. The route carries the bot so the idempotency
 * identity can be `(bot_instance_id, update_id)` rather than `update_id` alone.
 */
const BOT_A = SEED_IDS.botA1;
const BOT_B = SEED_IDS.botB1;
const webhookUrl = (botInstanceId: string) => `/telegram/webhook/${botInstanceId}`;

describe('HTTP surface', () => {
  let api: ApiApp;

  /** Drives the app through Fastify's inject, so no port is bound. */
  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  beforeAll(async () => {
    const config = testConfig({
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
  });

  afterAll(async () => {
    await api?.close();
  });

  describe('health', () => {
    it('reports liveness without consulting dependencies', async () => {
      const response = await inject({ method: 'GET', url: '/health/live' });
      expect(response.statusCode).toBe(200);
      expect(() => healthLiveResponseSchema.parse(response.json())).not.toThrow();
    });

    it('reports readiness to an anonymous caller as a status and nothing else', async () => {
      const response = await inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(200);
      const body: unknown = response.json();
      expect(healthReadyResponseSchema.parse(body).status).toBe('ok');

      // The point of the endpoint, asserted on the RAW body rather than on the
      // parsed one: a schema that strips extra keys would report a clean shape
      // for a response that shipped everything anyway.
      //
      // A load balancer needs the status code. It has never needed to know
      // which dependencies exist, what they are called, how long each took,
      // how many migrations are applied, or how far behind the relay is —
      // served fastest, and in most detail, exactly when the system is broken.
      expect(Object.keys(body as object)).toEqual(['status']);
      expect(JSON.stringify(body)).not.toMatch(/postgres|redis|migrations|outbox|latencyMs/);
    });

    it('refuses build information to an anonymous caller', async () => {
      const response = await inject({ method: 'GET', url: '/health/info' });
      expect(response.statusCode).toBe(401);
      // Version, commit and Node build together name the exact revision to go
      // and read, and the advisories to check first.
      expect(response.body).not.toMatch(/nexa-bot|v\d+\.\d+\.\d+/);
    });

    it('refuses readiness detail to an anonymous caller', async () => {
      const response = await inject({
        method: 'GET',
        url: `${API_PREFIX}${CONTROL_ROUTES.systemReadiness}`,
      });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toMatch(/postgres|redis|migrations|outbox/);
    });

    it('echoes a caller-supplied correlation id when it is a UUID', async () => {
      const supplied = '01900000-0000-7000-8000-0000000000aa';
      const response = await inject({
        method: 'GET',
        url: '/health/live',
        headers: { 'x-correlation-id': supplied },
      });
      expect(response.headers['x-correlation-id']).toBe(supplied);
    });

    it('replaces a correlation id that is not a UUID', async () => {
      // The value lands in append-only columns, so an unbounded caller-supplied
      // string would be undeletable, and a deliberately colliding one would
      // muddy another request's trace.
      const response = await inject({
        method: 'GET',
        url: '/health/live',
        headers: { 'x-correlation-id': 'caller-supplied-id' },
      });
      const echoed = response.headers['x-correlation-id'];
      expect(echoed).not.toBe('caller-supplied-id');
      expect(String(echoed)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe('system ping over HTTP', () => {
    it('runs the write path and returns the event id', async () => {
      const response = await inject({
        method: 'POST',
        url: '/api/admin/v1/system/ping',
        payload: { idempotencyKey: 'http-ping-1', source: 'http' },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json() as { eventId: string; replayed: boolean };
      expect(body.replayed).toBe(false);

      const messages = await api.container.database.db.select().from(outboxMessages);
      expect(messages.some((m) => m.id === body.eventId)).toBe(true);
    });

    it('maps a validation failure to 400 with a correlation id', async () => {
      const response = await inject({
        method: 'POST',
        url: '/api/admin/v1/system/ping',
        payload: { idempotencyKey: 'x', source: 'nope' },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json() as { error: { kind: string; correlationId: string } };
      expect(body.error.kind).toBe('VALIDATION');
      expect(body.error.correlationId).toBeTruthy();
    });
  });

  describe('telegram webhook', () => {
    it('rejects an update with no secret token', async () => {
      const response = await inject({
        method: 'POST',
        url: webhookUrl(BOT_A),
        payload: { update_id: 1 },
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects an update with the wrong secret token', async () => {
      const response = await inject({
        method: 'POST',
        url: webhookUrl(BOT_A),
        headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: 'wrong' },
        payload: { update_id: 2 },
      });
      expect(response.statusCode).toBe(401);
    });

    it('refuses a malformed update before it reaches the write path', async () => {
      // `@Body() update: Update` was a TypeScript type and nothing more, so at
      // runtime this was whatever was posted. A body with no `update_id` was
      // keyed as the literal string `unknown`, which makes every malformed
      // update from one bot a replay of the first — silently swallowed, 200.
      // JSON bodies that parse as JSON and then fail the schema. A non-JSON
      // body is refused earlier still, by the transport, and is not what this
      // is about.
      const malformed: unknown[] = [
        {},
        { update_id: null },
        { update_id: 'not-a-number' },
        { update_id: 1.5 },
        { update_id: { nested: 1 } },
        { update_id: [] },
        [],
      ];

      for (const payload of malformed) {
        const response = await inject({
          method: 'POST',
          url: webhookUrl(BOT_A),
          headers: {
            [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET,
            'content-type': 'application/json',
          },
          payload: JSON.stringify(payload),
        });
        expect(response.statusCode).toBe(400);
      }

      // Nothing was written: no idempotency row, and in particular no row keyed
      // on the string `unknown`.
      const keys = await api.container.database.db.execute(
        `SELECT key FROM request_idempotency WHERE key LIKE 'telegram:%'` as never,
      );
      expect(JSON.stringify(keys)).not.toContain('unknown');
    });

    it('accepts an update whose unknown Telegram fields it does not model', async () => {
      // The schema states what this installation depends on and lets the rest
      // through. Telegram adds fields without asking; a strict object would
      // reject valid traffic on their release schedule rather than ours.
      const response = await inject({
        method: 'POST',
        url: webhookUrl(BOT_A),
        headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
        payload: {
          update_id: 700,
          some_future_telegram_field: { anything: [1, 2, 3] },
          message: { message_id: 1, date: 0, chat: { id: 1, type: 'private' }, text: '/ping' },
        },
      });
      expect(response.statusCode).toBe(201);
    });

    it('accepts update_id 0, which is falsy but valid', async () => {
      // The old `update.update_id ?? 'unknown'` was nullish-coalescing, so 0
      // survived it — but a truthiness test would not have, and the schema is
      // where that is now settled rather than left to a reader's memory.
      const response = await inject({
        method: 'POST',
        url: webhookUrl(BOT_A),
        headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
        payload: { update_id: 0 },
      });
      expect(response.statusCode).toBe(201);
    });

    it('rejects an update for a bot instance that does not exist', async () => {
      // Checked AFTER the secret token, so the endpoint cannot be used to probe
      // which bot ids exist.
      const response = await inject({
        method: 'POST',
        url: webhookUrl('01900000-0000-7000-8000-0000000000ff'),
        headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
        payload: { update_id: 3 },
      });
      expect(response.statusCode).toBe(404);
    });

    it('accepts an authenticated update and records the ping under the bot’s tenant', async () => {
      const response = await inject({
        method: 'POST',
        url: webhookUrl(BOT_A),
        headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
        payload: {
          update_id: 100,
          message: { message_id: 1, date: 0, chat: { id: 1, type: 'private' }, text: '/ping' },
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ ok: true });

      const audits = await api.container.database.db.select().from(auditLogs);
      const row = audits.find((a) => a.actorId === `telegram-update:${BOT_A}:100`);
      expect(row).toBeDefined();
      // Resolving the bot is also what supplies the tenant, so the update no
      // longer writes rows that belong to nobody.
      expect(row?.tenantId).toBe(SEED_IDS.tenantA);
    });

    it('keeps two bots’ identically numbered updates distinct', async () => {
      // The property this route shape exists for. `update_id` is unique per
      // bot, not globally: with a shared key, bot B's update 500 would look
      // like a replay of bot A's — silently dropped, 200, nothing logged.
      const send = (bot: string) =>
        inject({
          method: 'POST',
          url: webhookUrl(bot),
          headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
          payload: {
            update_id: 500,
            message: { message_id: 9, date: 0, chat: { id: 1, type: 'private' }, text: '/ping' },
          },
        });

      await send(BOT_A);
      await send(BOT_B);

      const audits = await api.container.database.db.select().from(auditLogs);
      expect(audits.some((a) => a.actorId === `telegram-update:${BOT_A}:500`)).toBe(true);
      expect(audits.some((a) => a.actorId === `telegram-update:${BOT_B}:500`)).toBe(true);

      // And the keys they were stored under differ by the bot, not by luck.
      expect(telegramUpdateKey(BOT_A, '500')).not.toBe(telegramUpdateKey(BOT_B, '500'));
      const keys = await api.container.database.db.execute(
        `SELECT key FROM request_idempotency WHERE key LIKE 'telegram:%:update:500'` as never,
      );
      expect(JSON.stringify(keys)).toContain(telegramUpdateKey(BOT_A, '500'));
      expect(JSON.stringify(keys)).toContain(telegramUpdateKey(BOT_B, '500'));
    });

    it('treats a redelivered update as a replay, not a second ping', async () => {
      // Telegram retries an update it did not get a 200 for. Keying idempotency
      // on the update id makes the retry harmless.
      const send = () =>
        inject({
          method: 'POST',
          url: webhookUrl(BOT_A),
          headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
          payload: {
            update_id: 200,
            message: { message_id: 2, date: 0, chat: { id: 1, type: 'private' }, text: '/ping' },
          },
        });

      await send();
      await send();

      const messages = await api.container.database.db.select().from(outboxMessages);
      const forUpdate200 = messages.filter((m) => m.correlationId !== null);
      // Exactly one ping event exists for that update, across both deliveries.
      const audits = await api.container.database.db.select().from(auditLogs);
      expect(audits.filter((a) => a.actorId === `telegram-update:${BOT_A}:200`)).toHaveLength(1);
      expect(forUpdate200.length).toBeGreaterThan(0);
    });

    it('answers 200 for an update it does not handle', async () => {
      // A non-2xx makes Telegram retry the same update indefinitely, and an
      // update we do not handle is not an error.
      const response = await inject({
        method: 'POST',
        url: webhookUrl(BOT_A),
        headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
        payload: {
          update_id: 300,
          message: { message_id: 3, date: 0, chat: { id: 1, type: 'private' }, text: 'hello' },
        },
      });
      expect(response.statusCode).toBe(201);
    });
  });
});

describe('readiness when a dependency is down', () => {
  let api: ApiApp;
  let cookie: string;
  const ORIGIN = 'http://localhost:5173';

  beforeAll(async () => {
    const config = testConfig();
    await migrateOnce(config.DATABASE_URL);
    // An unreachable Redis, rather than stopping the shared one out from under
    // the other tests.
    api = await createApiApp({ ...config, REDIS_URL: 'redis://127.0.0.1:6399' });
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    await createAdmin(api.container, tenantA, {
      username: 'reader',
      password: 'a-perfectly-fine-password',
      roleKeys: ['observer'],
    });

    const login = await api.app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: `${API_PREFIX}${AUTH_ROUTES.login}`,
        headers: { origin: ORIGIN },
        payload: { username: 'reader', password: 'a-perfectly-fine-password' },
      });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(login.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error('No session cookie was set.');
    cookie = `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  });

  afterAll(async () => {
    await api?.close();
  });

  const readinessDetail = async () => {
    const response = await api.app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: `${API_PREFIX}${CONTROL_ROUTES.systemReadiness}`,
        headers: { cookie, origin: ORIGIN },
      });
    expect(response.statusCode).toBe(200);
    return systemReadinessResponseSchema.parse(response.json());
  };

  it('stays live while reporting not ready', async () => {
    // This distinction is the entire point of having two endpoints: reporting a
    // dead dependency as "not live" makes an orchestrator restart a healthy
    // process and lose in-flight work.
    const instance = api.app.getHttpAdapter().getInstance();

    const live = await instance.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);

    const ready = await instance.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(503);
    // The 503 is the whole answer for an anonymous caller. Which dependency
    // failed is exactly what a stranger does not get, least of all now.
    expect(Object.keys(ready.json() as object)).toEqual(['status']);
    expect(healthReadyResponseSchema.parse(ready.json()).status).toBe('degraded');
  });

  it('names the failing dependency to an authenticated administrator', async () => {
    const body = await readinessDetail();
    expect(body.status).toBe('degraded');
    expect(body.dependencies.find((d) => d.name === 'redis')?.status).toBe('down');
    expect(body.dependencies.find((d) => d.name === 'postgres')?.status).toBe('up');
  });

  it('describes the failure from a closed vocabulary, not from the driver', async () => {
    // Authentication is not a licence to leak the deployment. A driver message
    // carries internal hostnames, ports, database and role names, and an HTTP
    // body gets pasted into tickets — the real message goes to the log with
    // its correlation id.
    const body = await readinessDetail();
    const redis = body.dependencies.find((d) => d.name === 'redis');

    expect(['unreachable', 'timeout', 'auth failed', 'missing', 'unavailable']).toContain(
      redis?.detail,
    );
    expect(redis?.detail).not.toMatch(/6399|127\.0\.0\.1|ECONNREFUSED/);
  });
});

describe('telegram webhook when disabled', () => {
  let api: ApiApp;

  beforeAll(async () => {
    const config = testConfig({ TELEGRAM_WEBHOOK_ENABLED: 'false' });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  });

  afterAll(async () => {
    await api?.close();
  });

  it('does not expose the route at all', async () => {
    // 404 rather than 401: a deployment with no bot configured has nothing to probe.
    const response = await api.app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'POST', url: '/telegram/webhook', payload: { update_id: 1 } });
    expect(response.statusCode).toBe(404);
  });
});
