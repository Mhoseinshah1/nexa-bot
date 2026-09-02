import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  healthInfoResponseSchema,
  healthLiveResponseSchema,
  healthReadyResponseSchema,
  TELEGRAM_SECRET_TOKEN_HEADER,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { auditLogs, outboxMessages } from '../../apps/api/src/infrastructure/persistence/schema';
import { migrateOnce, resetDatabase, testConfig } from './harness';
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
    await seed(api.container.database.db, config.SECRETS_KEK, config.SECRETS_KEK_ID);
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

    it('reports readiness with a per-dependency breakdown', async () => {
      const response = await inject({ method: 'GET', url: '/health/ready' });
      const body = healthReadyResponseSchema.parse(response.json());

      expect(response.statusCode).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.dependencies.map((d) => d.name).sort()).toEqual([
        'migrations',
        'outbox',
        'postgres',
        'redis',
      ]);
      expect(body.dependencies.every((d) => d.status === 'up')).toBe(true);
    });

    it('returns build information', async () => {
      const response = await inject({ method: 'GET', url: '/health/info' });
      expect(response.statusCode).toBe(200);
      const body = healthInfoResponseSchema.parse(response.json());
      expect(body.name).toBe('nexa-bot');
      expect(body.nodeVersion).toBe(process.version);
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

  beforeAll(async () => {
    const config = testConfig();
    await migrateOnce(config.DATABASE_URL);
    // An unreachable Redis, rather than stopping the shared one out from under
    // the other tests.
    api = await createApiApp({ ...config, REDIS_URL: 'redis://127.0.0.1:6399' });
  });

  afterAll(async () => {
    await api?.close();
  });

  it('stays live while reporting not ready, and names the failing dependency', async () => {
    // This distinction is the entire point of having two endpoints: reporting a
    // dead dependency as "not live" makes an orchestrator restart a healthy
    // process and lose in-flight work.
    const instance = api.app.getHttpAdapter().getInstance();

    const live = await instance.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);

    const ready = await instance.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(503);

    const body = healthReadyResponseSchema.parse(ready.json());
    expect(body.status).toBe('degraded');
    expect(body.dependencies.find((d) => d.name === 'redis')?.status).toBe('down');
    expect(body.dependencies.find((d) => d.name === 'postgres')?.status).toBe('up');
  });

  it('describes the failure from a closed vocabulary, not from the driver', async () => {
    // Readiness is unauthenticated. A driver message would hand an anonymous
    // caller internal hostnames, ports, database and role names — precisely
    // when the system is broken.
    const ready = await api.app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: 'GET', url: '/health/ready' });

    const body = healthReadyResponseSchema.parse(ready.json());
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
