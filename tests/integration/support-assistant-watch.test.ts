import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  SUPPORT_AI_DEFAULT_CONFIG,
  SUPPORT_ASSISTANT_STALL_SECONDS,
  systemJobActor,
  type ActorContext,
  type BusinessBotRight,
  type CorrelationId,
} from '@nexa/contracts';
import { AssistantLoop } from '../../apps/api/src/modules/control/support-ai/application/assistant-loop';
import {
  SupportAssistantLiveness,
  SupportAssistantWatch,
} from '../../apps/api/src/modules/control/support-ai/application/assistant-watch';
import { DrizzleSupportAiJobRepository } from '../../apps/api/src/modules/control/support-ai/infrastructure/drizzle-support-ai-job.repository';
import { DrizzleOperationalConditionReader } from '../../apps/api/src/modules/platform/opslog/infrastructure/drizzle-operational-event.reader';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * D5 — a stopped `assistant` role makes a sound. The worker's watch raises
 * `support.assistant.stalled` when due AI work waits unclaimed with nothing leased; the
 * assistant closes it once a pass of its own loop completes.
 */

const BOT = SEED_IDS.botA1;
const scopeA = { ...tenantA, botInstanceId: BOT } as never;
const STALL_MS = SUPPORT_ASSISTANT_STALL_SECONDS * 1_000;

describe('the assistant watch (D5)', () => {
  let ctx: TestContext;
  let operator: ActorContext;
  let conversationId: string;
  let offset: number;
  let watch: SupportAssistantWatch;
  let jobs: DrizzleSupportAiJobRepository;
  let keySeq = 0;
  const key = (label: string) => `${label}-${Date.now()}-${(keySeq += 1)}`;
  const system = () => systemJobActor('watch-test', 'c' as CorrelationId);
  const db = () => ctx.container.database.db;

  async function events() {
    const rows = await db().execute(
      sql`SELECT code, severity, resolved_at, recovers_code FROM operational_events
          WHERE code LIKE 'support.assistant.%' ORDER BY first_seen_at, code DESC`,
    );
    return rows.rows as {
      code: string;
      severity: string;
      resolved_at: Date | null;
      recovers_code: string | null;
    }[];
  }

  const request = () =>
    ctx.container.supportAssist.request(scopeA, operator, {
      conversationId,
      idempotencyKey: key('draft'),
    });

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
    const c = ctx.container;
    operator = adminActorFor(
      await createAdmin(c, tenantA, { username: 'support1', roleKeys: ['support'] }),
    );
    const owner = adminActorFor(
      await createAdmin(c, tenantA, { username: 'owner', roleKeys: ['owner'] }),
    );
    await c.supportAiConfig.update(tenantA, owner, {
      idempotencyKey: key('cfg'),
      expectedVersion: null,
      config: {
        ...SUPPORT_AI_DEFAULT_CONFIG,
        mode: 'ASSIST_ONLY',
        primary: { provider: 'OPENAI', model: 'gpt-5.5' },
      },
    });
    await c.businessConnections.applyReport(scopeA, system(), {
      idempotencyKey: key('conn'),
      botInstanceId: BOT,
      report: {
        connectionId: 'conn-1',
        ownerTelegramUserId: '5000001',
        ownerUserChatId: '5000001',
        isEnabled: true,
        rights: ['can_reply'] as BusinessBotRight[],
        connectedAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    const recorded = await c.businessConversations.recordMessage(scopeA, system(), {
      idempotencyKey: key('msg'),
      botInstanceId: BOT,
      edited: false,
      message: {
        connectionId: 'conn-1',
        chatId: '7000001',
        chatType: 'private',
        messageId: 11,
        fromUserId: '7000001',
        senderBusinessBotId: null,
        isFromOffline: false,
        sentAt: new Date(),
        editedAt: null,
        kind: 'TEXT',
        text: 'سلام، اینترنتم وصل نمی‌شود',
        photo: null,
      },
    });
    conversationId = recorded!.conversationId;
    offset = 0;
    jobs = new DrizzleSupportAiJobRepository(c.database.db);
    watch = new SupportAssistantWatch({
      jobs,
      opsLog: c.opsLogWriter,
      uow: c.uow,
      scopeActivity: c.tenants,
      clock: { now: () => new Date(Date.now() + offset) },
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('a draft due for less than the bound is not a stalled assistant', async () => {
    await request();
    offset = STALL_MS - 10_000;
    expect(await watch.check(scopeA)).toBe('OK');
    expect(await events()).toEqual([]);
  });

  it('raises the condition once due work waits unclaimed past the bound, deduplicated', async () => {
    await request();
    offset = STALL_MS + 5_000;
    expect(await watch.check(scopeA)).toBe('STALLED');
    expect(await watch.check(scopeA)).toBe('STALLED');
    expect(await events()).toMatchObject([
      { code: 'support.assistant.stalled', severity: 'WARN', resolved_at: null },
    ]);
  });

  it('a job under a live lease is a BUSY assistant, not a dead one', async () => {
    await request();
    await request(); // the newer request discards the older draft: one QUEUED job
    const second = await db().execute(
      sql`INSERT INTO support_ai_jobs (id, tenant_id, conversation_id, kind, state, idempotency_key,
            requested_by_admin_id, claimed_until)
          SELECT gen_random_uuid(), tenant_id, conversation_id, kind, 'QUEUED', 'leased-' || id,
                 requested_by_admin_id, now() + interval '1 hour'
            FROM support_ai_jobs WHERE state = 'QUEUED' LIMIT 1 RETURNING id`,
    );
    expect(second.rows).toHaveLength(1);
    offset = STALL_MS + 5_000;
    expect(await watch.check(scopeA)).toBe('OK');
    expect(await events()).toEqual([]);
  });

  it('a stopped tenant is not a stalled assistant, and nothing is written', async () => {
    await request();
    await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${SEED_IDS.tenantA}`);
    offset = STALL_MS + 5_000;
    expect(await watch.check(scopeA)).toBe('INACTIVE');
    expect(await events()).toEqual([]);
  });

  it('the assistant closes the condition once a pass of its loop completes', async () => {
    await request();
    offset = STALL_MS + 5_000;
    expect(await watch.check(scopeA)).toBe('STALLED');
    const c = ctx.container;
    const liveness = new SupportAssistantLiveness({
      conditions: new DrizzleOperationalConditionReader(c.database.db),
      opsLog: c.opsLogWriter,
      uow: c.uow,
      scopeActivity: c.tenants,
    });
    const loop = new AssistantLoop(c.supportAssist, {
      liveness,
      scope: () => tenantA as never,
      intervalMs: 1000,
      now: () => new Date(Date.now() + offset),
      logger: c.logger,
    });
    await loop.tick();
    const after = await events();
    expect(after.map((e) => e.code)).toEqual([
      'support.assistant.stalled',
      'support.assistant.running',
    ]);
    expect(after[0]?.resolved_at).not.toBeNull();
    expect(after[1]?.recovers_code).toBe('support.assistant.stalled');
    // With nothing open, a running assistant writes nothing more.
    expect(await liveness.alive(tenantA as never)).toBe(false);
    expect(await events()).toHaveLength(2);
  });
});
