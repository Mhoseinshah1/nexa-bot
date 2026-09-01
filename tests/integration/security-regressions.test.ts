import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  systemContext,
  systemJobActor,
  type ActorContext,
  type CorrelationId,
} from '@nexa/contracts';
import {
  auditLogs,
  operationalEvents,
  outboxMessages,
} from '../../apps/api/src/infrastructure/persistence/schema';
import { createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * Regressions for the findings the Phase 0 security review raised.
 *
 * Each test names the defect it locks down. None of them is a happy path: they
 * exist because the behaviour they assert was once wrong.
 */
describe('security regressions', () => {
  let ctx: TestContext;
  const correlationId = 'corr-security' as CorrelationId;

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  describe('SYSTEM_JOB is not a permission bypass', () => {
    it('cannot perform an operation outside the background grant', async () => {
      // The guard used to return early for SYSTEM_JOB, so anything able to
      // construct one — including an HTTP surface acting for an anonymous
      // caller — held every permission in the catalog.
      const job = systemJobActor('test-job', correlationId);
      expect(await ctx.container.guard.has(tenantA, job, 'refunds.issue')).toBe(false);
      expect(await ctx.container.guard.has(tenantA, job, 'users.wallet.debit')).toBe(false);

      const denials = await ctx.container.database.db.select().from(operationalEvents);
      expect(denials).toHaveLength(0); // `has` does not record; `check` does.
    });

    it('records a denial for background work like any other actor', async () => {
      const job = systemJobActor('test-job', correlationId);
      await expect(ctx.container.guard.check(tenantA, job, 'refunds.issue')).rejects.toThrowError(
        /refunds.issue/,
      );

      const events = await ctx.container.database.db.select().from(operationalEvents);
      expect(events.map((e) => e.code)).toContain('access.permission_denied');
      expect(events[0]?.tenantId).toBe(tenantA.tenantId);
    });
  });

  describe('idempotency keys are namespaced per surface', () => {
    const webActor = (): ActorContext => ({
      type: 'SYSTEM_JOB',
      id: 'http:system.ping',
      label: 'http',
      surface: 'WEB',
      correlationId,
    });

    const telegramActor = (): ActorContext => ({
      type: 'SYSTEM_JOB',
      id: 'telegram-update:1',
      label: 'telegram',
      surface: 'TELEGRAM',
      correlationId,
    });

    it('does not let one surface consume another surface’s key', async () => {
      // Both surfaces run under a system scope. Sharing one namespace let an
      // HTTP caller pre-claim `telegram:update:<n>` — guessable, because
      // update ids are sequential — so the real update was silently skipped.
      const scope = systemContext('shared');
      const key = 'telegram:update:4242';

      const viaWeb = await ctx.container.recordPing.execute(scope, webActor(), {
        idempotencyKey: key,
        source: 'test',
      });
      const viaTelegram = await ctx.container.recordPing.execute(scope, telegramActor(), {
        idempotencyKey: key,
        source: 'test',
      });

      expect(viaWeb.replayed).toBe(false);
      expect(viaTelegram.replayed).toBe(false);
      expect(viaTelegram.eventId).not.toBe(viaWeb.eventId);

      // Two real writes, not one write and one silently swallowed replay.
      expect(await ctx.container.database.db.select().from(outboxMessages)).toHaveLength(2);
      expect(await ctx.container.database.db.select().from(auditLogs)).toHaveLength(2);
    });

    it('cannot wedge another surface by reusing its key with a different payload', async () => {
      // With a shared namespace this raised CONFLICT on the Telegram path,
      // which returned 409 and made Telegram retry that update forever.
      const scope = systemContext('shared');
      const key = 'telegram:update:9999';

      await ctx.container.recordPing.execute(scope, webActor(), {
        idempotencyKey: key,
        source: 'http',
      });

      await expect(
        ctx.container.recordPing.execute(scope, telegramActor(), {
          idempotencyKey: key,
          source: 'telegram',
        }),
      ).resolves.toMatchObject({ replayed: false });
    });

    it('still replays within one surface', async () => {
      const scope = systemContext('shared');
      const first = await ctx.container.recordPing.execute(scope, telegramActor(), {
        idempotencyKey: 'telegram:update:1',
        source: 'telegram',
      });
      const second = await ctx.container.recordPing.execute(scope, telegramActor(), {
        idempotencyKey: 'telegram:update:1',
        source: 'telegram',
      });
      expect(second.replayed).toBe(true);
      expect(second.eventId).toBe(first.eventId);
    });
  });

  describe('operational event deduplication is scoped per tenant', () => {
    it('keeps two tenants using the same dedupe key apart', async () => {
      // A globally unique dedupe key collapsed both tenants onto one row and
      // let the second overwrite the first's context and correlation id — a
      // cross-tenant write no repository predicate could catch, because the
      // collision happened in the index.
      await ctx.container.opsLog.record(tenantA, {
        code: 'panel.unreachable',
        severity: 'ERROR',
        message: 'down',
        dedupeKey: 'panel-1',
        context: { tenant: 'A' },
      });
      await ctx.container.opsLog.record(tenantB, {
        code: 'panel.unreachable',
        severity: 'ERROR',
        message: 'down',
        dedupeKey: 'panel-1',
        context: { tenant: 'B' },
      });

      const rows = await ctx.container.database.db.select().from(operationalEvents);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.tenantId).sort()).toEqual(
        [tenantA.tenantId, tenantB.tenantId].sort(),
      );
      expect(rows.find((r) => r.tenantId === tenantA.tenantId)?.context).toEqual({ tenant: 'A' });
      expect(rows.find((r) => r.tenantId === tenantB.tenantId)?.context).toEqual({ tenant: 'B' });
    });

    it('still deduplicates within one tenant', async () => {
      for (let i = 0; i < 3; i += 1) {
        await ctx.container.opsLog.record(tenantA, {
          code: 'panel.unreachable',
          severity: 'ERROR',
          message: 'down',
          dedupeKey: 'panel-1',
        });
      }
      const rows = await ctx.container.database.db.select().from(operationalEvents);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.occurrenceCount).toBe(3);
    });
  });

  describe('secrets never reach durable storage', () => {
    it('redacts a credential nested inside an array in an audit row', async () => {
      await ctx.container.audit.record(tenantA, systemJobActor('test-job', correlationId), {
        action: 'test.redaction',
        entityType: 'System',
        entityId: 'system',
        before: null,
        after: { bots: [{ username: 'acme_bot', token: '123456:AAH-real-token' }] },
        result: 'SUCCESS',
      });

      const [row] = await ctx.container.database.db.select().from(auditLogs);
      expect(JSON.stringify(row?.after)).not.toContain('AAH-real-token');
      expect(JSON.stringify(row?.after)).toContain('[redacted]');
      expect(JSON.stringify(row?.after)).toContain('acme_bot');
    });

    it('redacts operational event context, which is projected off-database', async () => {
      await ctx.container.opsLog.record(tenantA, {
        code: 'test.redaction',
        severity: 'INFO',
        message: 'x',
        context: { panels: [{ name: 'p1', apiKey: 'super-secret' }] },
      });

      const [row] = await ctx.container.database.db.select().from(operationalEvents);
      expect(JSON.stringify(row?.context)).not.toContain('super-secret');
      expect(JSON.stringify(row?.context)).toContain('[redacted]');
    });
  });
});
