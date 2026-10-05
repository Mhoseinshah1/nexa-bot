import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BUSINESS_CONNECTION_UNUSABLE_CODE,
  BUSINESS_CONNECTION_USABLE_CODE,
  isNexaError,
  systemJobActor,
  type BusinessBotRight,
  type CorrelationId,
} from '@nexa/contracts';
import { sql } from 'drizzle-orm';
import { BusinessConnectionService } from '../../apps/api/src/modules/commerce/business-chats/application/business-connection.service';
import type {
  BusinessConnectionReport,
  BusinessTelegramGateway,
} from '../../apps/api/src/modules/commerce/business-chats/application/ports';
import { DrizzleBusinessConnectionRepository } from '../../apps/api/src/modules/commerce/business-chats/infrastructure/drizzle-business-connection.repository';
import { SEED_IDS, createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * TB1 — Telegram Business connections against a real database (ADR-0033 §2).
 *
 * Telegram is a scripted fake of the gateway port. What runs for real is what the design
 * rests on: the `(bot, connection id)` key, supersession by owner, the idempotent replay,
 * the scope-activity refusal, and the one open operational condition per connection.
 */

const BOT = SEED_IDS.botA1;
const scopeA = { ...tenantA, botInstanceId: BOT } as never;

class FakeBusinessTelegram implements BusinessTelegramGateway {
  answer: Awaited<ReturnType<BusinessTelegramGateway['getConnection']>> = {
    outcome: 'UNAVAILABLE',
    errorCode: 'telegram.unreachable',
  };
  calls = 0;
  async getConnection() {
    this.calls += 1;
    return this.answer;
  }
  async sendText() {
    return { outcome: 'SUCCEEDED' as const, messageId: 1, sentAt: null };
  }
}

function report(overrides: Partial<BusinessConnectionReport> = {}): BusinessConnectionReport {
  return {
    connectionId: 'conn-1',
    ownerTelegramUserId: '5000001',
    ownerUserChatId: '5000001',
    isEnabled: true,
    rights: ['can_reply'] as BusinessBotRight[],
    connectedAt: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

describe('Telegram Business connections (TB1)', () => {
  let ctx: TestContext;
  let telegram: FakeBusinessTelegram;
  let service: BusinessConnectionService;
  let keySeq = 0;
  const key = (label: string) => `${label}-${Date.now()}-${(keySeq += 1)}`;
  const actor = () => systemJobActor('business-test', 'test-correlation' as CorrelationId);

  async function conditions() {
    const rows = await ctx.container.database.db.execute(
      sql`SELECT code, dedupe_key, resolved_at, recovers_code FROM operational_events
          WHERE code IN (${BUSINESS_CONNECTION_UNUSABLE_CODE}, ${BUSINESS_CONNECTION_USABLE_CODE})
          ORDER BY first_seen_at, code`,
    );
    return rows.rows as {
      code: string;
      dedupe_key: string | null;
      resolved_at: Date | null;
      recovers_code: string | null;
    }[];
  }

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
    telegram = new FakeBusinessTelegram();
    const c = ctx.container;
    service = new BusinessConnectionService({
      repository: new DrizzleBusinessConnectionRepository(c.database.db),
      telegram,
      tokens: c.botInstances,
      guard: c.guard,
      uow: c.uow,
      audit: c.audit,
      opsLog: c.opsLogWriter,
      sessions: c.sessions,
      idempotency: c.idempotency,
      scopeActivity: c.tenants,
      clock: c.clock,
      ids: c.ids,
    });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it('stores a first report as an ACTIVE connection, with an audit row and no alert', async () => {
    const applied = await service.applyReport(scopeA, actor(), {
      idempotencyKey: key('connect'),
      botInstanceId: BOT,
      report: report(),
    });
    expect(applied).toMatchObject({ change: 'INSERTED', status: 'ACTIVE' });
    expect(applied.connection).toMatchObject({ connectionId: 'conn-1', rights: ['can_reply'] });
    expect(await conditions()).toEqual([]);
    const audit = await ctx.container.database.db.execute(
      sql`SELECT action FROM audit_logs WHERE entity_id = ${applied.connection.id}`,
    );
    expect(audit.rows).toEqual([{ action: 'business_connection.report' }]);
  });

  it('replays a redelivered update without a second write', async () => {
    const k = key('connect');
    const first = await service.applyReport(scopeA, actor(), {
      idempotencyKey: k,
      botInstanceId: BOT,
      report: report(),
    });
    const again = await service.applyReport(scopeA, actor(), {
      idempotencyKey: k,
      botInstanceId: BOT,
      report: report(),
    });
    expect(again.connection.id).toBe(first.connection.id);
    expect(again.connection.version).toBe(first.connection.version);
  });

  it('confirms an identical report without a new version or audit row', async () => {
    const first = await service.applyReport(scopeA, actor(), {
      idempotencyKey: key('a'),
      botInstanceId: BOT,
      report: report(),
    });
    const second = await service.applyReport(scopeA, actor(), {
      idempotencyKey: key('b'),
      botInstanceId: BOT,
      report: report(),
    });
    expect(second.change).toBe('CONFIRMED');
    expect(second.connection.version).toBe(first.connection.version);
  });

  it('opens one condition when a connection loses the right to reply, and closes it when restored', async () => {
    await service.applyReport(scopeA, actor(), {
      idempotencyKey: key('a'),
      botInstanceId: BOT,
      report: report(),
    });
    const revoked = await service.applyReport(scopeA, actor(), {
      idempotencyKey: key('b'),
      botInstanceId: BOT,
      report: report({ rights: ['can_read_messages'] }),
    });
    expect(revoked).toMatchObject({ change: 'UPDATED', status: 'RIGHTS_INSUFFICIENT' });
    // Reported again while still revoked: the same condition, not a second one.
    await service.applyReport(scopeA, actor(), {
      idempotencyKey: key('c'),
      botInstanceId: BOT,
      report: report({ rights: [] }),
    });
    let rows = await conditions();
    expect(rows.filter((row) => row.code === BUSINESS_CONNECTION_UNUSABLE_CODE)).toHaveLength(1);
    expect(rows[0]?.resolved_at).toBeNull();

    const restored = await service.applyReport(scopeA, actor(), {
      idempotencyKey: key('d'),
      botInstanceId: BOT,
      report: report(),
    });
    expect(restored.status).toBe('ACTIVE');
    rows = await conditions();
    const open = rows.find((row) => row.code === BUSINESS_CONNECTION_UNUSABLE_CODE);
    expect(open?.resolved_at).not.toBeNull();
  });

  it('reports a disabled connection as a condition from its very first report', async () => {
    const applied = await service.applyReport(scopeA, actor(), {
      idempotencyKey: key('a'),
      botInstanceId: BOT,
      report: report({ isEnabled: false }),
    });
    expect(applied.status).toBe('DISABLED');
    const rows = await conditions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: BUSINESS_CONNECTION_UNUSABLE_CODE, resolved_at: null });
  });

  it('supersedes an owner’s older connection when a new id arrives, and closes its open condition', async () => {
    const old = await service.applyReport(scopeA, actor(), {
      idempotencyKey: key('a'),
      botInstanceId: BOT,
      report: report({ isEnabled: false }),
    });
    const fresh = await service.applyReport(scopeA, actor(), {
      idempotencyKey: key('b'),
      botInstanceId: BOT,
      report: report({ connectionId: 'conn-2', connectedAt: new Date('2026-10-02T00:00:00Z') }),
    });
    expect(fresh.status).toBe('ACTIVE');
    const repository = new DrizzleBusinessConnectionRepository(ctx.container.database.db);
    const stale = await repository.findById(scopeA, old.connection.id);
    expect(stale?.supersededAt).not.toBeNull();
    expect(
      (await conditions()).find((row) => row.code === BUSINESS_CONNECTION_UNUSABLE_CODE)
        ?.resolved_at,
    ).not.toBeNull();

    // A later report about the superseded id cannot hand the account back to it.
    const late = await service.applyReport(scopeA, actor(), {
      idempotencyKey: key('c'),
      botInstanceId: BOT,
      report: report({ connectionId: 'conn-1', isEnabled: true }),
    });
    expect(late.status).toBe('SUPERSEDED');
  });

  // TB1 review B1: supersession follows connection AGE, never arrival order.
  it('a late report about an OLDER connection never supersedes the newer one', async () => {
    const newer = await service.applyReport(scopeA, actor(), {
      idempotencyKey: key('b'),
      botInstanceId: BOT,
      report: report({ connectionId: 'conn-new', connectedAt: new Date('2026-10-03T00:00:00Z') }),
    });
    // The old connection's (redelivered, or fetched late) report arrives afterwards.
    const older = await service.applyReport(scopeA, actor(), {
      idempotencyKey: key('a'),
      botInstanceId: BOT,
      report: report({
        connectionId: 'conn-old',
        isEnabled: false,
        connectedAt: new Date('2026-09-01T00:00:00Z'),
      }),
    });
    expect(older.status).toBe('SUPERSEDED');
    const repository = new DrizzleBusinessConnectionRepository(ctx.container.database.db);
    const stillNewer = await repository.findById(scopeA, newer.connection.id);
    expect(stillNewer?.supersededAt).toBeNull();
    // A superseded report opens no condition: the operator has nothing to act on.
    expect(await conditions()).toEqual([]);
  });

  // TB1 review S1: a concurrent first report that loses the insert race still applies its facts.
  it('applies the facts of a first report that lost the insert race to the winner’s row', async () => {
    await service.applyReport(scopeA, actor(), {
      idempotencyKey: key('a'),
      botInstanceId: BOT,
      report: report(),
    });
    const real = new DrizzleBusinessConnectionRepository(ctx.container.database.db);
    // The loser's `lock` ran before the winner committed, so it found nothing.
    let raced = false;
    const racing = Object.create(real) as DrizzleBusinessConnectionRepository;
    racing.lock = async (...args: Parameters<DrizzleBusinessConnectionRepository['lock']>) => {
      if (!raced) {
        raced = true;
        return null;
      }
      return real.lock(...args);
    };
    const c = ctx.container;
    const loser = new BusinessConnectionService({
      repository: racing,
      telegram,
      tokens: c.botInstances,
      guard: c.guard,
      uow: c.uow,
      audit: c.audit,
      opsLog: c.opsLogWriter,
      sessions: c.sessions,
      idempotency: c.idempotency,
      scopeActivity: c.tenants,
      clock: c.clock,
      ids: c.ids,
    });
    const applied = await loser.applyReport(scopeA, actor(), {
      idempotencyKey: key('b'),
      botInstanceId: BOT,
      report: report({ isEnabled: false }),
    });
    expect(raced).toBe(true);
    expect(applied).toMatchObject({ change: 'UPDATED', status: 'DISABLED' });
    expect((await real.find(scopeA, BOT, 'conn-1'))?.isEnabled).toBe(false);
  });

  it('does not supersede another owner’s connection', async () => {
    const first = await service.applyReport(scopeA, actor(), {
      idempotencyKey: key('a'),
      botInstanceId: BOT,
      report: report(),
    });
    await service.applyReport(scopeA, actor(), {
      idempotencyKey: key('b'),
      botInstanceId: BOT,
      report: report({
        connectionId: 'conn-other',
        ownerTelegramUserId: '5000002',
        ownerUserChatId: '5000002',
      }),
    });
    const repository = new DrizzleBusinessConnectionRepository(ctx.container.database.db);
    expect((await repository.findById(scopeA, first.connection.id))?.supersededAt).toBeNull();
  });

  it('keeps a connection id on one bot apart from the same id on another tenant', async () => {
    await service.applyReport(scopeA, actor(), {
      idempotencyKey: key('a'),
      botInstanceId: BOT,
      report: report(),
    });
    const scopeB = { ...tenantB, botInstanceId: SEED_IDS.botB1 } as never;
    expect(await service.find(scopeB, BOT, 'conn-1')).toBeNull();
    expect(await service.find(scopeB, SEED_IDS.botB1, 'conn-1')).toBeNull();
  });

  it('refuses a report for a tenant that has stopped accepting work', async () => {
    await ctx.container.database.db.execute(
      sql`UPDATE tenants SET status = 'DISABLED' WHERE id = ${SEED_IDS.tenantA}`,
    );
    const attempt = service.applyReport(scopeA, actor(), {
      idempotencyKey: key('a'),
      botInstanceId: BOT,
      report: report(),
    });
    await expect(attempt).rejects.toSatisfy(isNexaError);
    expect(await service.find(scopeA, BOT, 'conn-1')).toBeNull();
  });

  it('learns a connection it has never seen from Telegram, and refuses to guess when Telegram cannot say', async () => {
    telegram.answer = { outcome: 'UNAVAILABLE', errorCode: 'telegram.unreachable' };
    expect(
      await service.ensureKnown(scopeA, actor(), {
        idempotencyKey: key('a'),
        botInstanceId: BOT,
        connectionId: 'conn-1',
      }),
    ).toBeNull();

    telegram.answer = { outcome: 'FOUND', report: report() };
    const learned = await service.ensureKnown(scopeA, actor(), {
      idempotencyKey: key('b'),
      botInstanceId: BOT,
      connectionId: 'conn-1',
    });
    expect(learned?.connectionId).toBe('conn-1');
    // Known now: no second question.
    await service.ensureKnown(scopeA, actor(), {
      idempotencyKey: key('c'),
      botInstanceId: BOT,
      connectionId: 'conn-1',
    });
    expect(telegram.calls).toBe(2);
  });

  it('records a connection Telegram no longer knows as disabled, and an unanswered check as nothing', async () => {
    const applied = await service.applyReport(scopeA, actor(), {
      idempotencyKey: key('a'),
      botInstanceId: BOT,
      report: report(),
    });
    telegram.answer = { outcome: 'UNAVAILABLE', errorCode: 'telegram.server_error.502' };
    expect(
      await service.verify(scopeA, actor(), {
        idempotencyKey: key('b'),
        connectionRowId: applied.connection.id,
      }),
    ).toBe('ACTIVE');
    telegram.answer = { outcome: 'NOT_FOUND', errorCode: 'telegram.rejected.400' };
    expect(
      await service.verify(scopeA, actor(), {
        idempotencyKey: key('c'),
        connectionRowId: applied.connection.id,
      }),
    ).toBe('DISABLED');
  });

  it('classifies by the stored owner and this bot’s own Telegram id', async () => {
    const applied = await service.applyReport(scopeA, actor(), {
      idempotencyKey: key('a'),
      botInstanceId: BOT,
      report: report(),
    });
    await ctx.container.database.db.execute(
      sql`UPDATE bot_instances SET telegram_bot_id = '9000001' WHERE id = ${BOT}`,
    );
    const ownBotId = await new DrizzleBusinessConnectionRepository(
      ctx.container.database.db,
    ).ownBotId(scopeA, BOT);
    expect(ownBotId).toBe('9000001');
    const facts = { connectionId: 'conn-1', chatId: '7000001', messageId: 1, isFromOffline: false };
    expect(
      await service.classify(scopeA, applied.connection, {
        ...facts,
        fromUserId: '7000001',
        senderBusinessBotId: null,
      }),
    ).toBe('INBOUND');
    expect(
      await service.classify(scopeA, applied.connection, {
        ...facts,
        fromUserId: '5000001',
        senderBusinessBotId: null,
      }),
    ).toBe('HUMAN');
    expect(
      await service.classify(scopeA, applied.connection, {
        ...facts,
        fromUserId: '5000001',
        senderBusinessBotId: '9000001',
      }),
    ).toBe('OWN_ECHO');
    expect(
      await service.classify(scopeA, applied.connection, {
        ...facts,
        fromUserId: '5000001',
        senderBusinessBotId: '9000002',
      }),
    ).toBe('OTHER_BOT');
  });
});
