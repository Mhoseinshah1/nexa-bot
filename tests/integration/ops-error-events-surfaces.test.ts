import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  API_PREFIX,
  AUTH_ROUTES,
  CONTROL_ROUTES,
  SESSION_COOKIE_NAME,
  TELEGRAM_SECRET_TOKEN_HEADER,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
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
 * FIX-05 — the chokepoints this fix wires, through the real app: an unhandled API failure,
 * a Telegram turn that throws, and an anti-spam block. Each reaches the operations log as
 * ONE aggregated event; none of them can turn the request it reports into a second
 * failure. Synthetic data only; no real Telegram.
 */

const ORIGIN = 'https://admin.example.test';
const WEBHOOK_SECRET = 'fix05-integration-webhook-secret';
const SECRET = 'tp_live_KEY_that_must_never_leak_71c0de';
const BOT_A1 = SEED_IDS.botA1;

describe('FIX-05: the surfaces report through the one recorder', () => {
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
    await api.container.featureFlags.set(tenantA, owner, {
      key: 'ops_notifications',
      enabled: true,
      expectedVersion: null,
      idempotencyKey: 'fix05-flag-on',
      confirmKey: 'ops_notifications',
      reason: 'Test setup.',
    });
  });

  interface Row {
    readonly code: string;
    readonly severity: string;
    readonly occurrence_count: number;
    readonly dedupe_key: string | null;
    readonly message: string;
    readonly context: Record<string, unknown>;
  }

  async function rows(code: string): Promise<Row[]> {
    const result = await db().execute(
      sql`SELECT code, severity, occurrence_count, dedupe_key, message, context
            FROM operational_events WHERE code = ${code} ORDER BY first_seen_at`,
    );
    return result.rows as unknown as Row[];
  }

  /** The API reports its failure without being awaited; wait for the row, bounded. */
  async function eventually(code: string, count: number): Promise<Row[]> {
    for (let i = 0; i < 100; i += 1) {
      const found = await rows(code);
      if (found.length > 0 && found[0]!.occurrence_count >= count) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return rows(code);
  }

  async function cookie(): Promise<string> {
    const response = await inject({
      method: 'POST',
      url: `${API_PREFIX}${AUTH_ROUTES.login}`,
      headers: { origin: ORIGIN },
      payload: { username: 'owner', password: 'the-owners-real-password' },
    });
    const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(
      String(response.headers['set-cookie'] ?? ''),
    );
    if (match === null) throw new Error('no session');
    return `${SESSION_COOKIE_NAME}=${match[1] as string}`;
  }

  function update(updateId: number) {
    return inject({
      method: 'POST',
      url: `/telegram/webhook/${BOT_A1}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: {
        update_id: updateId,
        message: {
          message_id: updateId,
          date: 1_760_000_000,
          chat: { id: 910910, type: 'private' },
          from: { id: 910910, is_bot: false, first_name: 'مریم' },
          text: `/start ${SECRET}`,
        },
      },
    });
  }

  it('an unhandled API failure is one aggregated ERROR naming the route pattern, never the message', async () => {
    const session = await cookie();
    const service = api.container.opsLogService as { list: unknown };
    const original = service.list;
    service.list = () => Promise.reject(new TypeError(`exploded near ${SECRET}`));
    try {
      for (let i = 0; i < 2; i += 1) {
        const response = await inject({
          method: 'GET',
          url: `${API_PREFIX}${CONTROL_ROUTES.opsLog}`,
          headers: { cookie: session, origin: ORIGIN },
        });
        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain(SECRET);
      }
    } finally {
      service.list = original;
    }
    const found = await eventually('internal.unhandled', 2);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'ERROR', occurrence_count: 2 });
    expect(found[0]!.dedupe_key).toMatch(/^internal\.unhandled:.*ops-log:TypeError@\d+$/);
    expect(found[0]!.context).toMatchObject({ kind: 'TypeError', httpStatus: 500 });
    expect(String(found[0]!.context['method'])).toMatch(/^GET \S*ops-log$/);
    expect(JSON.stringify(found)).not.toContain(SECRET);
  });

  it('a Telegram turn that throws is one windowed event, and a log that cannot be written still answers 2xx', async () => {
    const runtime = api.container.botRuntime as { handle: unknown };
    const original = runtime.handle;
    runtime.handle = () => Promise.reject(new RangeError(`broken by ${SECRET}`));
    const recorder = api.container.opsLog as { record: unknown };
    const record = recorder.record;
    try {
      expect((await update(7001)).statusCode).toBe(201);
      expect((await update(7002)).statusCode).toBe(201);
      const found = await rows('telegram.turn_failed');
      expect(found).toHaveLength(1);
      expect(found[0]!.occurrence_count).toBe(2);
      expect(found[0]!.dedupe_key).toMatch(new RegExp(`^telegram\\.turn_failed:${BOT_A1}@\\d+$`));
      expect(found[0]!.context).toMatchObject({ botInstanceId: BOT_A1, error: 'RangeError' });
      expect(JSON.stringify(found)).not.toContain(SECRET);

      // The operations log itself is down: the webhook still answers 2xx, so Telegram does
      // not redeliver the update into the same failure for ever.
      recorder.record = () => Promise.reject(new Error('operations log unavailable'));
      expect((await update(7003)).statusCode).toBe(201);
    } finally {
      runtime.handle = original;
      recorder.record = record;
    }
  });

  it('an anti-spam block is a SECURITY event for the group, once per block', async () => {
    const customerId = (
      await api.container.customers.resolveFromUpdate(
        { ...tenantA, botInstanceId: BOT_A1 as BotInstanceId },
        {
          type: 'SYSTEM_JOB',
          id: null,
          label: 'telegram-update:test',
          surface: 'TELEGRAM',
          correlationId: 'fix05-resolve' as CorrelationId,
        },
        {
          idempotencyKey: 'fix05-resolve-maryam',
          telegramUserId: '910910',
          from: { id: 910910, first_name: 'مریم' },
          botInstanceId: BOT_A1 as BotInstanceId,
        },
      )
    ).customer.id;
    const system: ActorContext = {
      type: 'SYSTEM_JOB',
      id: null,
      label: 'telegram-update:test',
      surface: 'TELEGRAM',
      correlationId: 'fix05-spam' as CorrelationId,
    };
    const first = await api.container.customers.blockForSpam(tenantA, system, {
      idempotencyKey: 'fix05-spam-block-1',
      customerId,
      interactions: 21,
    });
    // A second trigger finds the customer already blocked: nothing changed, nothing reported.
    const second = await api.container.customers.blockForSpam(tenantA, system, {
      idempotencyKey: 'fix05-spam-block-2',
      customerId,
      interactions: 25,
    });
    expect([first.changed, second.changed]).toEqual([true, false]);
    // Codex P2 #251: an EXACT replay of the first block (a redelivered update) answers
    // `changed: true` from the idempotency store — and must not be reported again.
    const replay = await api.container.customers.blockForSpam(tenantA, system, {
      idempotencyKey: 'fix05-spam-block-1',
      customerId,
      interactions: 21,
    });
    expect(replay.changed).toBe(true);

    const found = await rows('antispam.customer_blocked');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'WARN', occurrence_count: 1 });
    expect(found[0]!.context).toMatchObject({
      customerId,
      telegramUserId: '910910',
      reason: 'ANTI_SPAM',
    });
    const queued = await db().execute(
      sql`SELECT template_key, payload, destination FROM notifications
           WHERE tenant_id = ${tenantA.tenantId}
             AND template_key = 'ops.notification.operational_event'`,
    );
    const intents = queued.rows as {
      payload: Record<string, unknown>;
      destination: Record<string, unknown>;
    }[];
    const blocked = intents.filter((row) => row.payload['code'] === 'antispam.customer_blocked');
    expect(blocked).toHaveLength(1);
    // Stored as WARN (the CHECK-pinned vocabulary), presented as SECURITY, in its topic.
    expect(blocked[0]!.payload['severity']).toBe('SECURITY');
    expect(blocked[0]!.destination['opsTopic']).toBe('SECURITY');
  });
});
