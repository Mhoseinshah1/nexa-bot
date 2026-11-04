import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './harness';
import { SEED_IDS } from '../../apps/api/src/infrastructure/persistence/seed';
import { purgePublishedOutboxBefore } from '../../apps/api/src/modules/platform/eventing/infrastructure/outbox-retention';
import { purgeExpiredIdempotencyBefore } from '../../apps/api/src/modules/platform/idempotency/infrastructure/idempotency-retention';

/**
 * Round 4 PR-E (E3): the two retention jobs, against a real PostgreSQL — including the
 * outbox's append-only trigger, which a fake could not have.
 *
 * Each case names what must SURVIVE, because that is what the rule is: an unpublished
 * outbox message whatever its age, the consumers' dedupe ledger, and every idempotency
 * key outside the two interactive namespaces.
 */

const DAY = 24 * 3_600_000;

describe('data retention (E3)', () => {
  let context: TestContext;
  const now = new Date('2026-10-19T12:00:00.000Z');
  const old = new Date(now.getTime() - 30 * DAY);
  const recent = new Date(now.getTime() - 1 * DAY);

  beforeAll(async () => {
    context = await createTestContext();
  }, 60_000);

  afterAll(async () => {
    await context.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  async function outbox(input: {
    published: Date | null;
    occurred: Date;
    exhausted?: Date | null;
    attempts?: number;
  }): Promise<string> {
    const id = randomUUID();
    await context.container.database.db.execute(sql`
      INSERT INTO outbox_messages
        (id, tenant_id, aggregate_type, aggregate_id, sequence, event_type, event_version,
         payload, actor, correlation_id, occurred_at, published_at, attempts, exhausted_at)
      VALUES
        (${id}::uuid, ${SEED_IDS.tenantA}::uuid, 'Customer', ${randomUUID()}, 1, 'CustomerImported', 1,
         '{}'::jsonb, '{"type":"SYSTEM_JOB"}'::jsonb, 'retention-test', ${input.occurred},
         ${input.published}, ${input.attempts ?? 0}, ${input.exhausted ?? null})
    `);
    return id;
  }

  async function outboxIds(): Promise<Set<string>> {
    const rows = await context.container.database.db.execute<{ id: string }>(
      sql`SELECT id FROM outbox_messages`,
    );
    return new Set(rows.rows.map((row) => row.id));
  }

  it('removes only PUBLISHED outbox messages older than the cutoff; never an unpublished one', async () => {
    const publishedOld = await outbox({ published: old, occurred: old });
    const publishedRecent = await outbox({ published: recent, occurred: recent });
    const pendingOld = await outbox({ published: null, occurred: old });
    const failingOld = await outbox({ published: null, occurred: old, attempts: 3 });
    const exhaustedOld = await outbox({
      published: null,
      occurred: old,
      attempts: 9,
      exhausted: old,
    });
    // The consumers' dedupe ledger for the old published message.
    await context.container.database.db.execute(sql`
      INSERT INTO processed_messages (consumer, message_id, processed_at)
      VALUES ('notification-dispatcher', ${publishedOld}::uuid, ${old})
    `);

    const cutoff = new Date(now.getTime() - 7 * DAY);
    expect(await purgePublishedOutboxBefore(context.container.database.db, cutoff, 1000)).toBe(1);

    const left = await outboxIds();
    expect(left.has(publishedOld)).toBe(false);
    for (const kept of [publishedRecent, pendingOld, failingOld, exhaustedOld]) {
      expect(left.has(kept)).toBe(true);
    }
    // processed_messages is not this job's: its row stays.
    const ledger = await context.container.database.db.execute(
      sql`SELECT 1 FROM processed_messages WHERE message_id = ${publishedOld}::uuid`,
    );
    expect(ledger.rows).toHaveLength(1);
    // A second pass finds nothing.
    expect(await purgePublishedOutboxBefore(context.container.database.db, cutoff, 1000)).toBe(0);
  });

  it('drains in batches no larger than the limit', async () => {
    for (let index = 0; index < 5; index += 1) await outbox({ published: old, occurred: old });
    const cutoff = new Date(now.getTime() - 7 * DAY);
    expect(await purgePublishedOutboxBefore(context.container.database.db, cutoff, 2)).toBe(2);
    expect(await purgePublishedOutboxBefore(context.container.database.db, cutoff, 2)).toBe(2);
    expect(await purgePublishedOutboxBefore(context.container.database.db, cutoff, 2)).toBe(1);
  });

  async function key(namespace: string, created: Date): Promise<string> {
    const id = randomUUID();
    await context.container.database.db.execute(sql`
      INSERT INTO request_idempotency (id, scope_ref, tenant_id, key, request_hash, result, created_at)
      VALUES (${id}::uuid, ${`${SEED_IDS.tenantA}|${namespace}`}, ${SEED_IDS.tenantA}::uuid,
              ${`k-${id}`}, 'h', '{}'::jsonb, ${created})
    `);
    return id;
  }

  it('expires only WEB and TELEGRAM idempotency keys; a job or importer key is kept for ever', async () => {
    const webOld = await key('WEB', old);
    const telegramOld = await key('TELEGRAM', old);
    const webRecent = await key('WEB', recent);
    const workerOld = await key('WORKER', old);
    const schedulerOld = await key('SCHEDULER', old);
    const apiOld = await key('API', old);
    // A namespace that merely ENDS like an interactive one is not one.
    const lookalike = await key('NOTWEB', old);

    const cutoff = new Date(now.getTime() - 7 * DAY);
    expect(await purgeExpiredIdempotencyBefore(context.container.database.db, cutoff, 1000)).toBe(
      2,
    );
    const rows = await context.container.database.db.execute<{ id: string }>(
      sql`SELECT id FROM request_idempotency`,
    );
    const left = new Set(rows.rows.map((row) => row.id));
    expect(left.has(webOld)).toBe(false);
    expect(left.has(telegramOld)).toBe(false);
    for (const kept of [webRecent, workerOld, schedulerOld, apiOld, lookalike]) {
      expect(left.has(kept)).toBe(true);
    }
  });

  it('the worker sweepers are wired and remove nothing while a recovery holds the installation', async () => {
    const publishedOld = await outbox({
      published: new Date('2020-01-01T00:00:00Z'),
      occurred: old,
    });
    // The container's sweeper reads the setting (default 7 days) on the installation tenant.
    context.container.setInstallationTenant(SEED_IDS.tenantA as never);
    expect(await context.container.outboxRetentionSweeper.sweep()).toBe(1);
    expect((await outboxIds()).has(publishedOld)).toBe(false);
    expect(await context.container.idempotencyRetentionSweeper.sweep()).toBeGreaterThanOrEqual(0);
  });

  it('v0.9.7: the worker sweepers run with the 7-day defaults, at the boundary, on real rows', async () => {
    // The container's own sweepers on the container's clock and the registry's defaults
    // (nothing stored): published outbox history and interactive keys go at 7 days, one day
    // either side of the boundary decides, and what is work or a job's key stays whatever
    // its age. This is the job that let the outbox reach 198 MB on the test server.
    const at = context.container.clock.now();
    const daysAgo = (days: number) => new Date(at.getTime() - days * DAY);
    const publishedEight = await outbox({ published: daysAgo(8), occurred: daysAgo(8) });
    const publishedSix = await outbox({ published: daysAgo(6), occurred: daysAgo(6) });
    const pendingOld = await outbox({ published: null, occurred: daysAgo(400) });
    const webEight = await key('WEB', daysAgo(8));
    const telegramEight = await key('TELEGRAM', daysAgo(8));
    const webSix = await key('WEB', daysAgo(6));
    const workerOld = await key('WORKER', daysAgo(400));

    context.container.setInstallationTenant(SEED_IDS.tenantA as never);
    expect(await context.container.outboxRetentionSweeper.sweep()).toBe(1);
    expect(await context.container.idempotencyRetentionSweeper.sweep()).toBe(2);

    const left = await outboxIds();
    expect(left.has(publishedEight)).toBe(false);
    expect(left.has(publishedSix)).toBe(true);
    expect(left.has(pendingOld)).toBe(true);
    const keys = new Set(
      (
        await context.container.database.db.execute<{ id: string }>(
          sql`SELECT id FROM request_idempotency`,
        )
      ).rows.map((row) => row.id),
    );
    expect(keys.has(webEight)).toBe(false);
    expect(keys.has(telegramEight)).toBe(false);
    expect(keys.has(webSix)).toBe(true);
    expect(keys.has(workerOld)).toBe(true);
  });

  it('v0.9.7: a stored retention day is what the sweeper uses, not the default', async () => {
    const at = context.container.clock.now();
    const daysAgo = (days: number) => new Date(at.getTime() - days * DAY);
    const publishedEight = await outbox({ published: daysAgo(8), occurred: daysAgo(8) });
    await context.container.database.db.execute(sql`
      INSERT INTO setting_values (id, tenant_id, setting_key, value)
      VALUES (${randomUUID()}::uuid, ${SEED_IDS.tenantA}::uuid, 'retention.outbox_published_days',
              '30'::jsonb)
    `);
    context.container.setInstallationTenant(SEED_IDS.tenantA as never);
    expect(await context.container.outboxRetentionSweeper.sweep()).toBe(0);
    expect((await outboxIds()).has(publishedEight)).toBe(true);
  });
});
