import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestContext, type TestContext } from './harness';

/**
 * Invariants the database enforces itself.
 *
 * These cannot be expressed against a mock, which is why the integration suite
 * uses a real PostgreSQL. Each one closes a specific documented legacy failure.
 */
describe('database invariants', () => {
  let ctx: TestContext;
  const query = async (text: string) =>
    ctx.container.database.withClient((client) => client.query(text));

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  describe('append-only enforcement', () => {
    const insertAudit = `
      INSERT INTO audit_logs (id, occurred_at, actor_type, action, entity_type, correlation_id, source_surface, result)
      VALUES ('01900000-0000-7000-8000-00000000ee01', now(), 'SYSTEM_JOB', 'test.action', 'System', 'c1', 'WORKER', 'SUCCESS')`;

    it('refuses to update an audit row', async () => {
      // An audit log that can be rewritten is not evidence.
      await query(insertAudit);
      await expect(
        query(`UPDATE audit_logs SET action = 'tampered' WHERE correlation_id = 'c1'`),
      ).rejects.toThrowError(/append-only/i);
    });

    it('refuses to delete an audit row', async () => {
      await query(insertAudit);
      await expect(
        query(`DELETE FROM audit_logs WHERE correlation_id = 'c1'`),
      ).rejects.toThrowError(/append-only/i);
    });

    it('refuses to rewrite an outbox message’s content', async () => {
      await query(`
        INSERT INTO outbox_messages (id, aggregate_type, aggregate_id, sequence, event_type, payload, actor, correlation_id, occurred_at)
        VALUES ('01900000-0000-7000-8000-00000000ee02', 'System', 'system', 1, 'SystemPinged', '{}', '{}', 'c2', now())`);

      await expect(
        query(
          `UPDATE outbox_messages SET event_type = 'SomethingElse' WHERE correlation_id = 'c2'`,
        ),
      ).rejects.toThrowError(/immutable/i);

      // Delivery bookkeeping is still allowed — that is what the relay updates.
      await expect(
        query(`UPDATE outbox_messages SET published_at = now() WHERE correlation_id = 'c2'`),
      ).resolves.toBeDefined();
    });

    it('allows an operational event to accumulate occurrences but not change identity', async () => {
      await query(`
        INSERT INTO operational_events (id, code, severity, message, dedupe_key, occurrence_count, first_seen_at, last_seen_at)
        VALUES ('01900000-0000-7000-8000-00000000ee03', 'panel.unreachable', 'ERROR', 'down', 'k1', 1, now(), now())`);

      // 60 identical TLS errors in one day should be one row with a counter.
      await expect(
        query(
          `UPDATE operational_events SET occurrence_count = 60, last_seen_at = now() WHERE dedupe_key = 'k1'`,
        ),
      ).resolves.toBeDefined();

      await expect(
        query(`UPDATE operational_events SET code = 'something.else' WHERE dedupe_key = 'k1'`),
      ).rejects.toThrowError(/immutable/i);

      await expect(
        query(`UPDATE operational_events SET occurrence_count = 1 WHERE dedupe_key = 'k1'`),
      ).rejects.toThrowError(/may not decrease/i);
    });
  });

  describe('constrained enums', () => {
    it('rejects a status value the contract does not define', async () => {
      // The legacy system encodes one service status four different ways
      // because nothing constrained the column.
      await expect(
        query(`UPDATE tenants SET status = 'فعال' WHERE slug = 'acme'`),
      ).rejects.toThrowError(/tenants_status_check/);
    });

    it('rejects an unknown actor type on an audit row', async () => {
      await expect(
        query(`
          INSERT INTO audit_logs (id, occurred_at, actor_type, action, entity_type, correlation_id, source_surface, result)
          VALUES ('01900000-0000-7000-8000-00000000ee04', now(), 'ROBOT', 'a', 'System', 'c', 'WORKER', 'SUCCESS')`),
      ).rejects.toThrowError(/actor_type_check/);
    });

    it('requires a reseller tenant to have a parent and a primary tenant not to', async () => {
      await expect(
        query(`
          INSERT INTO tenants (id, kind, slug, display_name)
          VALUES ('01900000-0000-7000-8000-00000000ee05', 'RESELLER_BOT', 'orphan', 'Orphan')`),
      ).rejects.toThrowError(/tenants_parent_check/);
    });
  });

  describe('numeric precision', () => {
    it('returns int8 as bigint, exactly, above the safe integer range', async () => {
      // node-postgres returns int8 as a string by default. Parsing it to bigint
      // is a deliberate, tested decision — not something to discover later via
      // a wrong balance.
      const result = await query(`SELECT 9007199254740993::bigint AS value`);
      expect(result.rows[0]?.value).toBe(9007199254740993n);
    });

    it('returns numeric as a string rather than narrowing it', async () => {
      const result = await query(`SELECT 12345678901234567890.123456::numeric AS value`);
      expect(result.rows[0]?.value).toBe('12345678901234567890.123456');
    });
  });

  describe('schema shape', () => {
    it('has no mutable balance column anywhere', async () => {
      // A mutable balance column cannot be audited after the fact. Wallets are
      // an append-only ledger with a derived balance; the CI boundary check
      // rejects a migration that adds one, and this asserts the current state.
      const result = await query(`
        SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name ILIKE '%balance%'`);
      expect(result.rows).toEqual([]);
    });

    it('stores every timestamp with a time zone', async () => {
      const result = await query(`
        SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type LIKE 'timestamp%'
          AND data_type <> 'timestamp with time zone'`);
      expect(result.rows).toEqual([]);
    });

    it('keeps the partial index that makes the relay claim O(unpublished)', async () => {
      const result = await query(`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'outbox_messages' AND indexname = 'outbox_messages_unpublished_idx'`);
      expect(String(result.rows[0]?.indexdef)).toContain('published_at IS NULL');
    });
  });

  describe('idempotency uniqueness', () => {
    it('treats the same key in different tenants as different keys', async () => {
      await ctx.container.database.db.execute(sql`
        INSERT INTO request_idempotency (id, scope_ref, tenant_id, key, request_hash)
        VALUES ('01900000-0000-7000-8000-00000000ee06', 'tenant-a', NULL, 'k', 'h'),
               ('01900000-0000-7000-8000-00000000ee07', 'tenant-b', NULL, 'k', 'h')`);

      // And rejects a genuine duplicate within one scope.
      await expect(
        query(`
          INSERT INTO request_idempotency (id, scope_ref, tenant_id, key, request_hash)
          VALUES ('01900000-0000-7000-8000-00000000ee08', 'tenant-a', NULL, 'k', 'h')`),
      ).rejects.toThrowError(/request_idempotency_scope_key/);
    });
  });
});
