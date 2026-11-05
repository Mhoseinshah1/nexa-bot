import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CAPACITY_ERROR_CODES,
  MINIAPP_API_PREFIX,
  MINIAPP_ROUTES,
  miniAppPath,
  TELEGRAM_SECRET_TOKEN_HEADER,
  isNexaError,
  systemJobActor,
  type ActorContext,
  type BotInstanceId,
  type CorrelationId,
} from '@nexa/contracts';
import { createApiApp, type ApiApp } from '../../apps/api/src/bootstrap';
import { seed, SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import {
  auditLogs,
  customers,
  heavyJobTickets,
  outboxMessages,
  tenantCapacityLimits,
} from '../../apps/api/src/infrastructure/persistence/schema';
import { OutboxRelay } from '../../apps/api/src/modules/platform/eventing/infrastructure/outbox-relay';
import { DrizzleHeavyJobQueueRepository } from '../../apps/api/src/modules/platform/capacity/infrastructure/drizzle-capacity.repository';
import {
  adminActorFor,
  createAdmin,
  migrateOnce,
  resetDatabase,
  tenantA,
  tenantB,
  testConfig,
} from './harness';

const WEBHOOK_SECRET = 'a-sufficiently-long-secret-for-capacity';
const BOT_A = SEED_IDS.botA1 as BotInstanceId;
const BOT_B = SEED_IDS.botB1 as BotInstanceId;
const TOKEN_B = '000000:seed-token-globex-1';

/** A Mini App launch's initData, signed with bot B's token as Telegram signs it. */
function initDataForB(id: number): string {
  const fields: Record<string, string> = {
    query_id: `q-${String(id)}-${String(Math.random()).slice(2, 10)}`,
    user: JSON.stringify({ id, first_name: 'C' }),
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  const check = Object.keys(fields)
    .sort()
    .map((field) => `${field}=${fields[field]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN_B).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

/**
 * Phase 6A PR-2 — capacity guards against the real app and a real database. Telegram is a
 * stub that can HOLD its answers to one chat, which keeps that customer's turn running.
 */
describe('capacity guards (phase 6A PR-2)', () => {
  let api: ApiApp;
  let telegram: Server;
  let owner: ActorContext;
  let hostedOwner: ActorContext;
  let updateId = 500_000;
  let messageId = 1;
  let keys = 0;
  const distDir = mkdtempSync(join(tmpdir(), 'nexa-capacity-miniapp-'));
  /** Chat ids whose answers are held until `release()`. */
  const held = new Set<number>();
  const releases: (() => void)[] = [];

  const release = () => {
    held.clear();
    for (const go of releases.splice(0)) go();
  };

  const inject = (options: Record<string, unknown>) =>
    api.app
      .getHttpAdapter()
      .getInstance()
      .inject(options as never);

  const start = (bot: BotInstanceId, from: number) =>
    inject({
      method: 'POST',
      url: `/telegram/webhook/${bot}`,
      headers: { [TELEGRAM_SECRET_TOKEN_HEADER]: WEBHOOK_SECRET },
      payload: {
        update_id: (updateId += 1),
        message: {
          message_id: (messageId += 1),
          date: 1_700_000_000,
          chat: { id: from, type: 'private' },
          from: { id: from, is_bot: false, first_name: 'C' },
          text: '/start',
        },
      },
    });

  const customerOf = async (tenantId: string, telegramUserId: number) =>
    (
      await api.container.database.db
        .select({ id: customers.id })
        .from(customers)
        .where(
          and(
            eq(customers.tenantId, tenantId),
            eq(customers.telegramUserId, String(telegramUserId)),
          ),
        )
    ).length;

  const setLimit = (
    actor: ActorContext,
    scope: typeof tenantA,
    tenantId: string,
    resource: string,
    limit: unknown,
  ) =>
    api.container.capacityLimits.set(scope, actor, {
      idempotencyKey: `capacity-${String((keys += 1))}`,
      tenantId,
      resource,
      limit,
    });

  beforeAll(async () => {
    telegram = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          body = {};
        }
        const answer = () => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, result: { message_id: (messageId += 1) } }));
        };
        if (held.has(Number(body.chat_id))) releases.push(answer);
        else answer();
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, '127.0.0.1', resolve));
    const address = telegram.address();
    if (address === null || typeof address === 'string') throw new Error('no address');
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>mini</title>');
    const config = testConfig({
      MINIAPP_DIST_DIR: distDir,
      TELEGRAM_WEBHOOK_ENABLED: 'true',
      TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
      TELEGRAM_API_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
    });
    await migrateOnce(config.DATABASE_URL);
    api = await createApiApp(config);
  }, 120_000);

  afterAll(async () => {
    release();
    await api?.close();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
    rmSync(distDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    release();
    await resetDatabase(api.container.database.db);
    await seed(api.container.database.db, api.container.cipher);
    api.container.setInstallationTenant(tenantA.tenantId);
    for (const id of [SEED_IDS.tenantA, SEED_IDS.tenantB])
      api.container.capacityResolver.invalidate(id);
    owner = adminActorFor(
      await createAdmin(api.container, tenantA, { username: 'cap-owner', roleKeys: ['owner'] }),
    );
    hostedOwner = adminActorFor(
      await createAdmin(api.container, tenantB, { username: 'cap-hosted', roleKeys: ['owner'] }),
    );
  });

  describe('the owner’s limits', () => {
    it('lists every bot with its tier and defaults, and stores a change with an audit row', async () => {
      const listed = await api.container.capacityLimits.list(tenantA, owner);
      const hosted = listed.tenants.find((t) => t.tenantId === SEED_IDS.tenantB);
      const own = listed.tenants.find((t) => t.tenantId === SEED_IDS.tenantA);
      expect(own?.tier).toBe('INSTALLATION');
      expect(hosted?.tier).toBe('HOSTED');
      expect(hosted?.limits.find((l) => l.resource === 'UPDATE_CONCURRENCY')).toMatchObject({
        limit: { mode: 'LIMITED', value: 8 },
        source: 'DEFAULT',
      });
      // Installation knobs are the installation's only.
      expect(hosted?.limits.some((l) => l.resource.startsWith('INSTALLATION_'))).toBe(false);

      const changed = await setLimit(owner, tenantA, SEED_IDS.tenantB, 'UPDATE_CONCURRENCY', {
        mode: 'UNLIMITED',
      });
      expect(changed.tenant.limits.find((l) => l.resource === 'UPDATE_CONCURRENCY')).toMatchObject({
        limit: { mode: 'UNLIMITED' },
        source: 'STORED',
      });
      const audit = await api.container.database.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.action, 'capacity.limit.set'));
      expect(audit).toHaveLength(1);
      expect(audit[0]?.result).toBe('SUCCESS');

      // `null` returns the bot to its tier's default.
      await setLimit(owner, tenantA, SEED_IDS.tenantB, 'UPDATE_CONCURRENCY', null);
      expect(await api.container.database.db.select().from(tenantCapacityLimits)).toHaveLength(0);
    });

    it('a hosted bot’s own owner can neither read nor raise them, and the refusal is audited', async () => {
      const refused = await setLimit(hostedOwner, tenantB, SEED_IDS.tenantB, 'UPDATE_CONCURRENCY', {
        mode: 'UNLIMITED',
      }).catch((error: unknown) => error);
      expect(isNexaError(refused) && refused.code).toBe(CAPACITY_ERROR_CODES.OWNER_ONLY);
      await expect(api.container.capacityLimits.list(tenantB, hostedOwner)).rejects.toMatchObject({
        code: CAPACITY_ERROR_CODES.OWNER_ONLY,
      });
      expect(await api.container.database.db.select().from(tenantCapacityLimits)).toHaveLength(0);
      const denied = await api.container.database.db
        .select()
        .from(auditLogs)
        .where(eq(auditLogs.result, 'DENIED'));
      expect(denied.length).toBeGreaterThanOrEqual(2);
    });

    it('refuses an installation knob for a hosted bot, and a value out of range', async () => {
      await expect(
        setLimit(owner, tenantA, SEED_IDS.tenantB, 'INSTALLATION_HEAVY_JOB_CONCURRENCY', {
          mode: 'LIMITED',
          value: 2,
        }),
      ).rejects.toMatchObject({ code: CAPACITY_ERROR_CODES.LIMIT_INVALID });
      await expect(
        setLimit(owner, tenantA, SEED_IDS.tenantA, 'INSTALLATION_HEAVY_JOB_CONCURRENCY', {
          mode: 'LIMITED',
          value: 3,
        }),
      ).rejects.toMatchObject({ code: CAPACITY_ERROR_CODES.LIMIT_INVALID });
      await setLimit(owner, tenantA, SEED_IDS.tenantA, 'INSTALLATION_HEAVY_JOB_CONCURRENCY', {
        mode: 'LIMITED',
        value: 2,
      });
    });
  });

  describe('the webhook', () => {
    // First in this file: the new-customer window is per process and per minute, so it
    // must see this bot's first customers of the minute.
    it('over the new-customer rate: 429 with nothing written, and a returning customer is never counted', async () => {
      await setLimit(owner, tenantA, SEED_IDS.tenantB, 'NEW_CUSTOMERS_PER_MINUTE', {
        mode: 'LIMITED',
        value: 1,
      });
      expect((await start(BOT_B, 920_001)).statusCode).toBe(201);
      const refused = await start(BOT_B, 920_002);
      expect(refused.statusCode).toBe(429);
      expect(JSON.parse(refused.body).code ?? JSON.parse(refused.body).error?.code).toBe(
        CAPACITY_ERROR_CODES.NEW_CUSTOMER_RATE,
      );
      expect(await customerOf(SEED_IDS.tenantB, 920_002)).toBe(0);
      // The customer already admitted comes back freely.
      expect((await start(BOT_B, 920_001)).statusCode).toBe(201);
      // The owner's own bot is unlimited by default.
      for (let i = 0; i < 3; i += 1) expect((await start(BOT_A, 930_000 + i)).statusCode).toBe(201);
    });
    it('security review of #410: the Mini App launch is held to the same rate — 429, no customer; only INTERNAL is exempt', async () => {
      const flag = await api.container.featureFlagResolver.resolve(tenantB, 'mini_app');
      await api.container.featureFlags.set(tenantB, hostedOwner, {
        key: 'mini_app',
        enabled: true,
        expectedVersion: flag.version,
        idempotencyKey: `capacity-flag-${String((keys += 1))}-abcdef`,
        reason: 'capacity test',
      });
      await setLimit(owner, tenantA, SEED_IDS.tenantB, 'NEW_CUSTOMERS_PER_MINUTE', {
        mode: 'LIMITED',
        value: 1,
      });
      const launch = (id: number) =>
        inject({
          method: 'POST',
          url: `${MINIAPP_API_PREFIX}${miniAppPath(MINIAPP_ROUTES.session, { botInstanceId: BOT_B })}`,
          payload: { initData: initDataForB(id) },
        });
      // The window already holds this minute's admissions of bot B (the case above): open a
      // fresh customer until one is refused, then check the refusal.
      let refused = null as Awaited<ReturnType<typeof launch>> | null;
      let refusedId = 0;
      for (let id = 940_001; id < 940_005 && refused === null; id += 1) {
        const answer = await launch(id);
        if (answer.statusCode !== 201) {
          refused = answer;
          refusedId = id;
        }
      }
      expect(refused?.statusCode, refused?.body).toBe(429);
      expect(JSON.parse(refused?.body ?? '{}').error.code).toBe(
        CAPACITY_ERROR_CODES.NEW_CUSTOMER_RATE,
      );
      expect(await customerOf(SEED_IDS.tenantB, refusedId)).toBe(0);
      // An explicit internal caller (an import, a fixture) is not held to the public rate.
      await api.container.customers.resolveFromUpdate(
        tenantB,
        systemJobActor('telegram-update:test', 'corr-cap' as CorrelationId),
        {
          intake: 'INTERNAL',
          idempotencyKey: 'capacity-internal-950001',
          telegramUserId: '950001',
          from: { id: 950_001, first_name: 'I' },
          botInstanceId: BOT_B,
        },
      );
      expect(await customerOf(SEED_IDS.tenantB, 950_001)).toBe(1);
    });

    it('queues a bot’s update over its concurrency and processes it; another bot is not slowed', async () => {
      await setLimit(owner, tenantA, SEED_IDS.tenantB, 'UPDATE_CONCURRENCY', {
        mode: 'LIMITED',
        value: 1,
      });
      held.add(910_001);
      const slow = start(BOT_B, 910_001);
      // Let the slow turn take the bot's one slot and reach Telegram.
      for (let i = 0; i < 100 && releases.length === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(releases.length).toBeGreaterThan(0);
      let queuedDone = false;
      const queued = start(BOT_B, 910_002).then((response) => {
        queuedDone = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      // Waiting in bot B's queue: not answered, nothing of it written yet.
      expect(queuedDone).toBe(false);
      expect(await customerOf(SEED_IDS.tenantB, 910_002)).toBe(0);
      // Bot A is not behind bot B.
      const other = await start(BOT_A, 910_003);
      expect(other.statusCode).toBe(201);
      expect(await customerOf(SEED_IDS.tenantA, 910_003)).toBe(1);

      release();
      const [first, second] = await Promise.all([slow, queued]);
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(201);
      expect(await customerOf(SEED_IDS.tenantB, 910_002)).toBe(1);
    });
  });

  describe('background work in turns', () => {
    it('a long backlog of one bot does not hold another bot’s messages behind it', async () => {
      const actor = () => systemJobActor('test-job', 'corr-cap' as CorrelationId);
      // Tenant A's twenty messages are OLDER than tenant B's two.
      for (let i = 0; i < 20; i += 1) {
        await api.container.uow.run(tenantA, (tx) =>
          api.container.outbox.write(tx, actor(), {
            eventType: 'SystemPinged',
            aggregateType: 'System',
            aggregateId: `a-${String(i)}`,
            payload: { source: 'test' },
          }),
        );
      }
      for (let i = 0; i < 2; i += 1) {
        await api.container.uow.run(tenantB, (tx) =>
          api.container.outbox.write(tx, actor(), {
            eventType: 'SystemPinged',
            aggregateType: 'System',
            aggregateId: `b-${String(i)}`,
            payload: { source: 'test' },
          }),
        );
      }
      const relay = new OutboxRelay(
        api.container.database.db,
        [],
        api.container.clock,
        api.container.logger,
        {
          batchSize: 4,
          pollIntervalMs: 50,
          maxLagMs: 300_000,
          turnWeightOf: async (tenantId) => (tenantId === SEED_IDS.tenantA ? 2 : 1),
        },
      );
      await relay.processBatch();
      const published = await api.container.database.db
        .select({ tenantId: outboxMessages.tenantId })
        .from(outboxMessages)
        .where(sql`${outboxMessages.publishedAt} IS NOT NULL`);
      const byTenant = (id: string) => published.filter((row) => row.tenantId === id).length;
      expect(published).toHaveLength(4);
      // Round 1: A (the owner, double turn) 2, B 1; round 2: A 1. Oldest-first would give B 0.
      expect(byTenant(SEED_IDS.tenantB)).toBe(1);
      expect(byTenant(SEED_IDS.tenantA)).toBe(3);
    });
  });

  describe('the heavy-job queue', () => {
    it('one at a time, the owner’s own bot first, and a dead holder’s place is given up', async () => {
      const queue = new DrizzleHeavyJobQueueRepository(api.container.database.db);
      const t0 = new Date('2026-11-04T10:00:00Z');
      const lease = (ms: number) => new Date(t0.getTime() + ms);
      const ids = {
        running: '01930000-0000-7000-8000-00000000f001',
        hosted: '01930000-0000-7000-8000-00000000f002',
        owner: '01930000-0000-7000-8000-00000000f003',
      };
      await queue.enqueue({
        id: ids.running,
        tenantId: SEED_IDS.tenantB,
        kind: 'EXPORT',
        priority: 0,
        now: t0,
        leaseUntil: lease(60_000),
      });
      expect(
        await queue.tryStart(ids.running, { now: t0, leaseUntil: lease(60_000), concurrency: 1 }),
      ).toBe('RUNNING');
      await queue.enqueue({
        id: ids.hosted,
        tenantId: SEED_IDS.tenantB,
        kind: 'REPORT',
        priority: 0,
        now: lease(1),
        leaseUntil: lease(60_000),
      });
      await queue.enqueue({
        id: ids.owner,
        tenantId: SEED_IDS.tenantA,
        kind: 'BACKUP',
        priority: 1,
        now: lease(2),
        leaseUntil: lease(60_000),
      });
      // One runs: nobody else starts.
      expect(
        await queue.tryStart(ids.owner, {
          now: lease(3),
          leaseUntil: lease(60_000),
          concurrency: 1,
        }),
      ).toBe('QUEUED');
      await queue.finish(ids.running, lease(4));
      // The owner's own job arrived later and goes first.
      expect(
        await queue.tryStart(ids.hosted, {
          now: lease(5),
          // The hosted job's waiter is alive: its lease runs past the owner's.
          leaseUntil: lease(300_000),
          concurrency: 1,
        }),
      ).toBe('QUEUED');
      expect(
        await queue.tryStart(ids.owner, {
          now: lease(6),
          leaseUntil: lease(60_000),
          concurrency: 1,
        }),
      ).toBe('RUNNING');
      // The owner's job dies without finishing: past its lease, the next one starts.
      expect(
        await queue.tryStart(ids.hosted, {
          now: lease(120_000),
          leaseUntil: lease(300_000),
          concurrency: 1,
        }),
      ).toBe('RUNNING');
      const owner = await api.container.database.db
        .select({ state: heavyJobTickets.state })
        .from(heavyJobTickets)
        .where(eq(heavyJobTickets.id, ids.owner));
      expect(owner[0]?.state).toBe('ABANDONED');
    });
  });
});
