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

  describe('what the schema says about money going back', () => {
    /*
     * An automatic refund is completed by nobody, because nobody decided it — and
     * an operator's refund still names who did. Migration 0086 split one check into
     * two so that both could be true, and the pair is asserted here because the
     * alternative the split rejected is the one a future edit will reach for: write
     * the confirming operator's id onto the refund and keep a single check. That is
     * a fabricated actor on a money record, and it says a person decided to return
     * this money when what they decided was to approve a bank transfer.
     *
     * Inserted directly, because what is under test is the CONSTRAINT: a test that
     * went through `RefundService` would be testing the service's choice of
     * arguments rather than the schema's refusal of the others.
     */
    const TENANT = '01900000-0000-7000-8000-000000000001';
    const CUSTOMER = '01900000-0000-7000-8000-0000000ef001';
    const ADMIN = '01900000-0000-7000-8000-0000000ef002';

    const seedPaymentAndAdmin = async (paymentId: string) => {
      await query(`
        INSERT INTO customers (id, tenant_id, telegram_user_id, first_name, status)
        VALUES ('${CUSTOMER}', '${TENANT}', '770001', 'ز', 'ACTIVE')
        ON CONFLICT DO NOTHING`);
      await query(`
        INSERT INTO admins (id, tenant_id, username, display_name, password_hash, status, password_updated_at)
        VALUES ('${ADMIN}', '${TENANT}', 'refund-check', 'refund-check', 'x', 'ACTIVE', now())
        ON CONFLICT DO NOTHING`);
      await query(`
        INSERT INTO payments (id, tenant_id, customer_id, order_id, method, state,
                              amount, currency, reference)
        VALUES ('${paymentId}', '${TENANT}', '${CUSTOMER}', NULL,
                'MANUAL_TRANSFER', 'PENDING', 250000, 'IRT', 'ref-${paymentId.slice(-6)}')`);
    };

    const insertRefund = (
      id: string,
      paymentId: string,
      requestedBy: string,
      completedBy: string,
      completedAt = 'now()',
    ) =>
      query(`
        INSERT INTO refunds (id, tenant_id, payment_id, customer_id, order_id, state,
                             channel, amount, currency, reason,
                             requested_by_admin_id, completed_by_admin_id, completed_at)
        VALUES ('${id}', '${TENANT}', '${paymentId}', '${CUSTOMER}', NULL, 'COMPLETED',
                'WALLET_CREDIT', 250000, 'IRT', 'UNDELIVERABLE',
                ${requestedBy}, ${completedBy}, ${completedAt})`);

    it('accepts an automatic refund that names nobody on either side', async () => {
      const payment = '01900000-0000-7000-8000-0000000ef010';
      await seedPaymentAndAdmin(payment);
      await expect(
        insertRefund('01900000-0000-7000-8000-0000000ef011', payment, 'NULL', 'NULL'),
      ).resolves.toBeDefined();
    });

    it('refuses an automatic refund that names an administrator who did not decide it', async () => {
      const payment = '01900000-0000-7000-8000-0000000ef020';
      await seedPaymentAndAdmin(payment);
      await expect(
        insertRefund('01900000-0000-7000-8000-0000000ef021', payment, 'NULL', `'${ADMIN}'`),
      ).rejects.toThrowError(/refunds_operator_completion_check/);
    });

    it("refuses an operator's completed refund that names nobody", async () => {
      const payment = '01900000-0000-7000-8000-0000000ef030';
      await seedPaymentAndAdmin(payment);
      await expect(
        insertRefund('01900000-0000-7000-8000-0000000ef031', payment, `'${ADMIN}'`, 'NULL'),
      ).rejects.toThrowError(/refunds_operator_completion_check/);
    });

    it('still refuses a COMPLETED refund with no time, whoever asked for it', async () => {
      const payment = '01900000-0000-7000-8000-0000000ef040';
      await seedPaymentAndAdmin(payment);
      await expect(
        insertRefund('01900000-0000-7000-8000-0000000ef041', payment, 'NULL', 'NULL', 'NULL'),
      ).rejects.toThrowError(/refunds_completed_check/);
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

  /**
   * The recovery table's own invariants.
   *
   * Every one of these is a state the application is written never to produce,
   * which is exactly why they are asserted against the DATABASE: a rule enforced
   * only in application code is a rule a second writer does not have. The
   * destructive-recovery exclusion in particular is the thing that stops two
   * operators in an incident, or two executor replicas during a rolling update,
   * from renaming the production database at the same time.
   */
  describe('recovery requests', () => {
    const TENANT = "'01900000-0000-7000-8000-000000000001'";
    const insert = (id: string, state: string, extra = ''): string => `
      INSERT INTO recovery_requests (id, tenant_id, source, state, stage, created_at, updated_at${
        state === 'SUCCEEDED' || state === 'FAILED' ? ', finished_at' : ''
      }${extra === '' ? '' : ', ' + extra.split('=')[0]?.trim()})
      VALUES ('${id}', ${TENANT}, 'UPLOAD', '${state}', 'RECEIVE_UPLOAD', now(), now()${
        state === 'SUCCEEDED' || state === 'FAILED' ? ', now()' : ''
      }${extra === '' ? '' : ', ' + (extra.split('=')[1] ?? '').trim()})`;

    it('permits exactly one destructive recovery at a time', async () => {
      await query(insert('01900000-0000-7000-8000-00000000dd01', 'RESTORING'));
      // A second one, in a DIFFERENT destructive state: the exclusion is over the
      // whole destructive set, not over one state, so two different stages of the
      // chain must still collide.
      await expect(
        query(insert('01900000-0000-7000-8000-00000000dd02', 'CUTTING_OVER')),
      ).rejects.toThrowError(/recovery_requests_single_destructive_idx/);
    });

    it('permits many recoveries that are only verifying an artifact', async () => {
      // Verifying and restore-testing change nothing about the installation, so
      // the exclusion deliberately does not cover them. An index over every live
      // state would make a second operator unable to check a second archive
      // while the first was being checked.
      await query(insert('01900000-0000-7000-8000-00000000dd03', 'VERIFYING'));
      await query(insert('01900000-0000-7000-8000-00000000dd04', 'RESTORE_TESTING'));
      await query(insert('01900000-0000-7000-8000-00000000dd05', 'RESTORE_TEST_PASSED'));
      const { rows } = await query(`SELECT count(*)::int AS n FROM recovery_requests`);
      expect((rows[0] as { n: number }).n).toBe(3);
    });

    it('releases the exclusion when the destructive recovery ends', async () => {
      await query(insert('01900000-0000-7000-8000-00000000dd06', 'RESTORING'));
      await query(`
        UPDATE recovery_requests SET state = 'FAILED', finished_at = now(),
               failure_code = 'recovery.candidate_restore_failed'
         WHERE id = '01900000-0000-7000-8000-00000000dd06'`);
      await query(insert('01900000-0000-7000-8000-00000000dd07', 'RESTORING'));
      const { rows } = await query(
        `SELECT count(*)::int AS n FROM recovery_requests WHERE state = 'RESTORING'`,
      );
      expect((rows[0] as { n: number }).n).toBe(1);
    });

    it('refuses a live request that claims to have finished', async () => {
      await expect(
        query(`
          INSERT INTO recovery_requests (id, tenant_id, source, state, stage, created_at, updated_at, finished_at)
          VALUES ('01900000-0000-7000-8000-00000000dd08', ${TENANT}, 'UPLOAD', 'VERIFYING', 'DECRYPT', now(), now(), now())`),
      ).rejects.toThrowError(/recovery_requests_finished_at_check/);
    });

    it('refuses a terminal request with no end', async () => {
      await expect(
        query(`
          INSERT INTO recovery_requests (id, tenant_id, source, state, stage, created_at, updated_at)
          VALUES ('01900000-0000-7000-8000-00000000dd09', ${TENANT}, 'UPLOAD', 'SUCCEEDED', 'DONE', now(), now())`),
      ).rejects.toThrowError(/recovery_requests_finished_at_check/);
    });

    it('refuses a cutover with no displaced database', async () => {
      // The dangerous direction: production IS the restored candidate and the
      // row does not say where the data it replaced went. Nothing can answer
      // that question afterwards, because the name is derived from an id and a
      // prefix the operator has no reason to know.
      await expect(
        query(`
          INSERT INTO recovery_requests (id, tenant_id, source, state, stage, created_at, updated_at, finished_at, cutover_at)
          VALUES ('01900000-0000-7000-8000-00000000dd0a', ${TENANT}, 'UPLOAD', 'SUCCEEDED', 'DONE', now(), now(), now(), now())`),
      ).rejects.toThrowError(/recovery_requests_cutover_check/);
    });

    it('ACCEPTS a displaced database with no cutover, because the cutover reaches that state', async () => {
      /*
       * The `RENAMED_OUT` window, and it is a real one rather than a tolerance.
       *
       * `ALTER DATABASE` cannot run in a transaction, so a cutover that renamed
       * the outgoing database and then failed to rename the candidate into place
       * ends with the displaced name known and no cutover performed —
       * `CutoverError.outgoingRenamed`. Both reconstruction paths in
       * `recovery-executor.ts` write that row, and while this constraint refused
       * it they raised 23514 instead: the recovery went unrecorded, the journal
       * was never cleared, and every later tick threw inside
       * `reconcileCutovers` before it could claim anything.
       */
      await query(`
          INSERT INTO recovery_requests (id, tenant_id, source, state, stage, created_at, updated_at, finished_at, displaced_database, failure_code)
          VALUES ('01900000-0000-7000-8000-00000000dd0b', ${TENANT}, 'UPLOAD', 'FAILED', 'CLEANUP', now(), now(), now(), 'nexa_pre_restore_x', 'recovery.cutover_failed')`);
      const { rows } = await query(
        `SELECT displaced_database, cutover_at FROM recovery_requests
          WHERE id = '01900000-0000-7000-8000-00000000dd0b'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        displaced_database: 'nexa_pre_restore_x',
        cutover_at: null,
      });
    });

    it('refuses a partial confirmation binding', async () => {
      // A confirmation with a time and no checksum is a confirmation for
      // anything, which is the one thing the binding exists to prevent.
      await expect(
        query(`
          INSERT INTO recovery_requests (id, tenant_id, source, state, stage, created_at, updated_at, confirmed_at)
          VALUES ('01900000-0000-7000-8000-00000000dd0c', ${TENANT}, 'UPLOAD', 'RESTORE_REQUESTED', 'AWAIT_CONFIRMATION', now(), now(), now())`),
      ).rejects.toThrowError(/recovery_requests_confirmation_check/);
    });

    it('accepts a complete confirmation binding', async () => {
      await query(`
        INSERT INTO recovery_requests (id, tenant_id, source, state, stage, created_at, updated_at,
                                       confirmed_at, confirmed_by_admin_id, confirmed_checksum, confirmation_expires_at)
        VALUES ('01900000-0000-7000-8000-00000000dd0d', ${TENANT}, 'UPLOAD', 'RESTORE_REQUESTED', 'AWAIT_CONFIRMATION', now(), now(),
                now(), '01900000-0000-7000-8000-00000000ad01', repeat('a', 64), now() + interval '10 minutes')`);
      const { rows } = await query(
        `SELECT confirmed_checksum FROM recovery_requests WHERE id = '01900000-0000-7000-8000-00000000dd0d'`,
      );
      expect((rows[0] as { confirmed_checksum: string }).confirmed_checksum).toHaveLength(64);
    });

    it('refuses a state, a stage and a failure code the contract does not define', async () => {
      for (const [column, value, constraint] of [
        ['state', 'ALMOST_DONE', 'recovery_requests_state_check'],
        ['stage', 'FIDDLING', 'recovery_requests_stage_check'],
        ['source', 'SOMEWHERE', 'recovery_requests_source_check'],
      ] as const) {
        await expect(
          query(`
            INSERT INTO recovery_requests (id, tenant_id, source, state, stage, created_at, updated_at)
            VALUES ('01900000-0000-7000-8000-00000000dd0e', ${TENANT},
                    ${column === 'source' ? `'${value}'` : "'UPLOAD'"},
                    ${column === 'state' ? `'${value}'` : "'VERIFYING'"},
                    ${column === 'stage' ? `'${value}'` : "'DECRYPT'"}, now(), now())`),
        ).rejects.toThrowError(new RegExp(constraint));
      }
      await expect(
        query(`
          INSERT INTO recovery_requests (id, tenant_id, source, state, stage, created_at, updated_at, finished_at, failure_code)
          VALUES ('01900000-0000-7000-8000-00000000dd0f', ${TENANT}, 'UPLOAD', 'FAILED', 'DONE', now(), now(), now(), 'recovery.it_broke')`),
      ).rejects.toThrowError(/recovery_requests_failure_code_check/);
    });
  });

  describe('the widened backup trigger', () => {
    it('accepts PRE_RESTORE and still refuses an undeclared trigger', async () => {
      // The migration widens a CHECK derived from a contract enum. Both halves
      // matter: a widening that forgot the constraint would accept anything.
      await query(`
        INSERT INTO backup_runs (id, trigger, state, stage, started_at, lease_owner, lease_heartbeat_at, delivery_state, cleanup_ok)
        VALUES ('01900000-0000-7000-8000-00000000db01', 'PRE_RESTORE', 'RUNNING', 'DUMP', now(), 'test', now(), 'NOT_ATTEMPTED', true)`);
      // Terminal, with a finish time, and therefore NOT holding the backup lock:
      // the trigger check has to be the only constraint this row can violate, or
      // the case passes for the wrong reason. It did, on the first run — a
      // SUCCEEDED row with no `finished_at` tripped
      // `backup_runs_finished_at_check` instead, which would have made this
      // assertion green with the trigger constraint dropped entirely.
      await expect(
        query(`
          INSERT INTO backup_runs (id, trigger, state, stage, started_at, finished_at, lease_owner, lease_heartbeat_at, delivery_state, cleanup_ok)
          VALUES ('01900000-0000-7000-8000-00000000db02', 'WHENEVER', 'SUCCEEDED', 'CLEANUP', now(), now(), 'test', now(), 'NOT_ATTEMPTED', true)`),
      ).rejects.toThrowError(/backup_runs_trigger_check/);
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
