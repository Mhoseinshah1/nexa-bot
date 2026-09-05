import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { APPEND_ONLY_TABLES } from '../../apps/api/src/infrastructure/persistence/schema';
import { createTestContext, SEED_IDS, tenantA, type TestContext } from './harness';

/**
 * What the Phase 2 tables refuse, enforced by the database rather than by a
 * service remembering to check.
 *
 * Each of these closes a specific documented legacy failure, and each is
 * expressed as raw SQL on purpose: a repository that forgets a predicate is the
 * failure mode being defended against, so the test must not go through one.
 */
describe('control-plane invariants', () => {
  let ctx: TestContext;
  const query = async (text: string) =>
    ctx.container.database.withClient((client) => client.query(text));

  const A = SEED_IDS.tenantA;
  const B = SEED_IDS.tenantB;

  beforeEach(async () => {
    ctx ??= await createTestContext();
    await ctx.reset();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  const insertRevision = (tenant: string, id: string, revision: number, action = 'SET') => `
    INSERT INTO template_revisions (id, tenant_id, template_key, locale, revision, action, body)
    VALUES ('${id}', '${tenant}', 'bot.ping.reply', 'fa', ${revision}, '${action}',
            ${action === 'SET' ? `'سلام {correlationId}'` : 'NULL'})`;

  describe('template revisions are evidence', () => {
    it('refuses an update', async () => {
      // The only record of what a message used to say. The legacy Telegram
      // surface has no reset, no default and no history, so an overwritten text
      // is simply gone (UNK-TXT-008).
      await query(insertRevision(A, '01900000-0000-7000-8000-0000000f0001', 1));
      await expect(
        query(`UPDATE template_revisions SET body = 'x' WHERE revision = 1`),
      ).rejects.toThrowError(/append-only/i);
    });

    it('refuses a delete', async () => {
      await query(insertRevision(A, '01900000-0000-7000-8000-0000000f0002', 1));
      await expect(query(`DELETE FROM template_revisions WHERE revision = 1`)).rejects.toThrowError(
        /append-only/i,
      );
    });

    it('refuses a SET with no body, and a REVERT with one', async () => {
      // A revert stores no body, because reverting means going back to the
      // default rather than copying it into tenant storage.
      await expect(
        query(`
          INSERT INTO template_revisions (id, tenant_id, template_key, locale, revision, action, body)
          VALUES ('01900000-0000-7000-8000-0000000f0003', '${A}', 'bot.ping.reply', 'fa', 1, 'SET', NULL)`),
      ).rejects.toThrowError(/template_revisions_body_check/);

      await expect(
        query(`
          INSERT INTO template_revisions (id, tenant_id, template_key, locale, revision, action, body)
          VALUES ('01900000-0000-7000-8000-0000000f0004', '${A}', 'bot.ping.reply', 'fa', 1, 'REVERT', 'copied default')`),
      ).rejects.toThrowError(/template_revisions_body_check/);
    });

    it('gives each tenant its own revision numbering', async () => {
      await query(insertRevision(A, '01900000-0000-7000-8000-0000000f0005', 1));
      await query(insertRevision(B, '01900000-0000-7000-8000-0000000f0006', 1));
      const rows = await query(`SELECT tenant_id FROM template_revisions WHERE revision = 1`);
      expect(rows.rowCount).toBe(2);
    });
  });

  describe('tenant ownership is a foreign key, not a convention', () => {
    it('refuses an override edited by another tenant’s administrator', async () => {
      // A row naming tenant A while pointing at tenant B's admin would be
      // INVISIBLE to A — every read filters on tenant_id — so it could not be
      // found by the tenant that owns the id. Migration 0007's rule, applied to
      // the new tables.
      const admin = ctx.container.ids.uuid();
      await query(`
        INSERT INTO admins (id, tenant_id, username, display_name, password_hash, password_updated_at, status)
        VALUES ('${admin}', '${B}', 'b-owner', 'B', 'x', now(), 'ACTIVE')`);

      await expect(
        query(`
          INSERT INTO template_overrides (id, tenant_id, template_key, locale, body, revision, updated_by_admin_id)
          VALUES ('01900000-0000-7000-8000-0000000f0010', '${A}', 'bot.ping.reply', 'fa', 'x {correlationId}', 1, '${admin}')`),
      ).rejects.toThrowError(/template_overrides_tenant_admin_fk/);
    });

    it('refuses a delivery attempt against another tenant’s notification', async () => {
      const notification = ctx.container.ids.uuid();
      await query(`
        INSERT INTO notifications (id, tenant_id, kind, dedupe_key, destination, payload, template_key, max_attempts)
        VALUES ('${notification}', '${B}', 'OPERATIONS_TEST', 'k1', '{"transport":"RECORDING"}', '{}', 'ops.notification.test', 5)`);

      await expect(
        query(`
          INSERT INTO notification_delivery_attempts
            (id, tenant_id, notification_id, attempt_number, transport, outcome, started_at, finished_at)
          VALUES ('01900000-0000-7000-8000-0000000f0020', '${A}', '${notification}', 1, 'RECORDING', 'SUCCEEDED', now(), now())`),
      ).rejects.toThrowError(/notification_delivery_attempts_tenant_notification_fk/);
    });
  });

  describe('notifications', () => {
    const insert = (tenant: string, id: string, dedupe: string) => `
      INSERT INTO notifications (id, tenant_id, kind, dedupe_key, destination, payload, template_key, max_attempts)
      VALUES ('${id}', '${tenant}', 'OPERATIONS_TEST', '${dedupe}', '{"transport":"RECORDING"}', '{}', 'ops.notification.test', 5)`;

    it('refuses a second intent with the same dedupe key in one tenant', async () => {
      // "A retry must not create a second logical notification" is a property of
      // this index, not of the queue behaving well.
      await query(insert(A, '01900000-0000-7000-8000-0000000f0030', 'same'));
      await expect(
        query(insert(A, '01900000-0000-7000-8000-0000000f0031', 'same')),
      ).rejects.toThrowError(/notifications_dedupe_key/);
    });

    it('lets two tenants use the same dedupe key', async () => {
      // The dedupe index is scoped, so tenant B cannot suppress tenant A's
      // notification by guessing its key — the collision would happen in the
      // index, where no repository predicate could prevent it.
      await query(insert(A, '01900000-0000-7000-8000-0000000f0032', 'shared'));
      await query(insert(B, '01900000-0000-7000-8000-0000000f0033', 'shared'));
      const rows = await query(`SELECT id FROM notifications WHERE dedupe_key = 'shared'`);
      expect(rows.rowCount).toBe(2);
    });

    it('refuses a terminal status with no completion time', async () => {
      await expect(
        query(`
          INSERT INTO notifications (id, tenant_id, kind, dedupe_key, destination, payload, template_key, max_attempts, status)
          VALUES ('01900000-0000-7000-8000-0000000f0034', '${A}', 'OPERATIONS_TEST', 'k2', '{"transport":"RECORDING"}', '{}', 'ops.notification.test', 5, 'SENT')`),
      ).rejects.toThrowError(/notifications_completed_check/);
    });

    it('refuses a failed attempt with no error code', async () => {
      // Otherwise "why did this fail" is answered by an empty column half the
      // time, which is the legacy log group's whole problem in miniature.
      const notification = ctx.container.ids.uuid();
      await query(insert(A, notification, 'k3'));
      await expect(
        query(`
          INSERT INTO notification_delivery_attempts
            (id, tenant_id, notification_id, attempt_number, transport, outcome, started_at, finished_at)
          VALUES ('01900000-0000-7000-8000-0000000f0035', '${A}', '${notification}', 1, 'RECORDING', 'FAILED_RETRYABLE', now(), now())`),
      ).rejects.toThrowError(/notification_delivery_attempts_error_check/);
    });

    it('refuses an attempt record to be edited after the fact', async () => {
      const notification = ctx.container.ids.uuid();
      await query(insert(A, notification, 'k4'));
      await query(`
        INSERT INTO notification_delivery_attempts
          (id, tenant_id, notification_id, attempt_number, transport, outcome, started_at, finished_at)
        VALUES ('01900000-0000-7000-8000-0000000f0036', '${A}', '${notification}', 1, 'RECORDING', 'SUCCEEDED', now(), now())`);
      await expect(
        query(`UPDATE notification_delivery_attempts SET outcome = 'FAILED_PERMANENT'`),
      ).rejects.toThrowError(/append-only/i);
    });

    /**
     * A released claim is accounting, not just history.
     *
     * Spend is `attempt_count` minus these rows, and `claimDue`,
     * `failExhausted` and the dispatcher's abandonment test all read that
     * figure. So a row DELETED here silently spends an attempt that was handed
     * back — enough of them and a message is written off having never been
     * sent — and a row EDITED here reassigns a hand-back to a different
     * attempt number, which is the identity the whole ownership model rests
     * on. The application only ever inserts, with `ON CONFLICT DO NOTHING`;
     * the database now refuses everything else.
     */
    const insertRelease = (notification: string, attempt: number) => `
      INSERT INTO notification_released_claims
        (tenant_id, notification_id, attempt_number, released_at, reason)
      VALUES ('${A}', '${notification}', ${attempt}, now(), 'tenant.not_active')`;

    it('refuses to edit a released claim', async () => {
      const notification = ctx.container.ids.uuid();
      await query(insert(A, notification, 'k5'));
      await query(insertRelease(notification, 1));
      await expect(
        query(`UPDATE notification_released_claims SET attempt_number = 2`),
      ).rejects.toThrowError(/append-only/i);
    });

    it('refuses to delete a released claim', async () => {
      const notification = ctx.container.ids.uuid();
      await query(insert(A, notification, 'k6'));
      await query(insertRelease(notification, 1));
      await expect(query(`DELETE FROM notification_released_claims`)).rejects.toThrowError(
        /append-only/i,
      );
    });

    /**
     * Every table the code CLAIMS is append-only actually is.
     *
     * `APPEND_ONLY_TABLES` is read by the boundary checks and by anything
     * reasoning about evidence. A name on that list with no trigger behind it
     * is a guarantee asserted in TypeScript and not enforced anywhere — so the
     * list is checked against the database rather than trusted.
     */
    it('enforces every table named in APPEND_ONLY_TABLES', async () => {
      const missing: string[] = [];
      for (const table of APPEND_ONLY_TABLES) {
        const result = await query(`
          SELECT tgname FROM pg_trigger
           WHERE tgrelid = '${table}'::regclass
             AND NOT tgisinternal
             AND tgname IN ('${table}_no_update', '${table}_no_delete')`);
        const found = result.rows.map((row) => String(row.tgname)).sort();
        if (found.length !== 2) missing.push(`${table} (${found.join(', ') || 'no guards'})`);
      }
      expect(missing, `named append-only but not enforced: ${missing.join('; ')}`).toEqual([]);
    });

    /**
     * An attempt number is EITHER spent or returned, never both.
     *
     * The whole ownership model is that sentence, and until now it rested on
     * how the dispatcher happens to behave: one worker owns a claim and either
     * sends on it or hands it back. `releaseClaim` guards its own insert
     * against the attempts table; `recordAttempt` had no mirror guard, and
     * nothing serialises the two. A number carrying both records subtracts to
     * "returned" while its attempt row says it reached the transport — a
     * message sent and its allowance handed back, which turns a bounded retry
     * into an unbounded one.
     */
    const insertAttempt = (notification: string, attempt: number, outcome = 'SUCCEEDED') => `
      INSERT INTO notification_delivery_attempts
        (id, tenant_id, notification_id, attempt_number, transport, outcome, started_at, finished_at, error_code)
      VALUES ('${ctx.container.ids.uuid()}', '${A}', '${notification}', ${attempt}, 'RECORDING', '${outcome}', now(), now(),
              ${outcome === 'SUCCEEDED' ? 'NULL' : `'notification.attempts_exhausted'`})`;

    it('refuses a released claim for an attempt that reached the transport', async () => {
      const notification = ctx.container.ids.uuid();
      await query(insert(A, notification, 'k7'));
      await query(insertAttempt(notification, 1));
      await expect(query(insertRelease(notification, 1))).rejects.toThrowError(
        /reached the transport/i,
      );
    });

    it('refuses an attempt on a number whose claim was returned', async () => {
      const notification = ctx.container.ids.uuid();
      await query(insert(A, notification, 'k8'));
      await query(insertRelease(notification, 1));
      await expect(query(insertAttempt(notification, 1))).rejects.toThrowError(/was released/i);
    });

    it('allows the sweep to withdraw its own verdict', async () => {
      // The one permitted pair, and the reason the guard is not a plain
      // "never both": `failExhausted` writes a synthetic FAILED_PERMANENT row
      // to record the verdict it reached, and a later hand-back retires that
      // number by recording it released, because nothing was ever sent on it.
      const notification = ctx.container.ids.uuid();
      await query(insert(A, notification, 'k9'));
      await query(insertAttempt(notification, 1, 'FAILED_PERMANENT'));
      await query(`
        INSERT INTO notification_released_claims
          (tenant_id, notification_id, attempt_number, released_at, reason)
        VALUES ('${A}', '${notification}', 1, now(), 'sweep.withdrawn')`);
      const rows = await query(
        `SELECT reason FROM notification_released_claims WHERE notification_id = '${notification}'`,
      );
      expect(rows.rows[0]).toMatchObject({ reason: 'sweep.withdrawn' });
    });

    it('refuses to disguise an ordinary hand-back as a sweep withdrawal', async () => {
      // The exception names BOTH halves. A release calling itself
      // `sweep.withdrawn` over a real transport verdict is still a claim being
      // returned for a message that was sent.
      const notification = ctx.container.ids.uuid();
      await query(insert(A, notification, 'k10'));
      await query(insertAttempt(notification, 1));
      await expect(
        query(`
          INSERT INTO notification_released_claims
            (tenant_id, notification_id, attempt_number, released_at, reason)
          VALUES ('${A}', '${notification}', 1, now(), 'sweep.withdrawn')`),
      ).rejects.toThrowError(/reached the transport/i);
    });
  });

  describe('operational event resolution', () => {
    const insertEvent = (id: string, extra = '') => `
      INSERT INTO operational_events
        (id, tenant_id, code, severity, message, dedupe_scope, occurrence_count, first_seen_at, last_seen_at${extra ? ', ' + extra.split('=')[0]!.trim() : ''})
      VALUES ('${id}', '${A}', 'panel.unreachable', 'ERROR', 'down', '${A}|OPSLOG', 1, now(), now()${extra ? ', ' + extra.split('=')[1]!.trim() : ''})`;

    it('marks a row resolved without removing anything', async () => {
      const id = ctx.container.ids.uuid();
      await query(insertEvent(id));
      await query(
        `UPDATE operational_events SET resolved_at = now(), resolved_by_event_id = '${id}' WHERE id = '${id}'`,
      );
      const rows = await query(
        `SELECT message, occurrence_count, resolved_at FROM operational_events WHERE id = '${id}'`,
      );
      // The failure row keeps its message and its counter. Resolution is a
      // marker over history, never a substitute for it.
      expect(rows.rows[0]).toMatchObject({ message: 'down', occurrence_count: 1 });
      expect(rows.rows[0].resolved_at).not.toBeNull();
    });

    it('lets a resolved row be re-opened when the condition recurs', async () => {
      const id = ctx.container.ids.uuid();
      await query(insertEvent(id));
      await query(`UPDATE operational_events SET resolved_at = now() WHERE id = '${id}'`);
      await query(
        `UPDATE operational_events SET resolved_at = NULL, occurrence_count = 2 WHERE id = '${id}'`,
      );
      const rows = await query(`SELECT resolved_at FROM operational_events WHERE id = '${id}'`);
      expect(rows.rows[0].resolved_at).toBeNull();
    });

    it('still refuses to rewrite what the condition was', async () => {
      // Marking something resolved is not permission to re-label it.
      const id = ctx.container.ids.uuid();
      await query(insertEvent(id));
      await expect(
        query(`UPDATE operational_events SET severity = 'INFO' WHERE id = '${id}'`),
      ).rejects.toThrowError(/immutable/i);
      await expect(
        query(`UPDATE operational_events SET code = 'something.else' WHERE id = '${id}'`),
      ).rejects.toThrowError(/immutable/i);
    });

    it('refuses a resolver with no resolution time, on insert and on update', async () => {
      const id = ctx.container.ids.uuid();
      await expect(query(insertEvent(id, `resolved_by_event_id = '${id}'`))).rejects.toThrowError(
        /operational_events_resolution_check/,
      );

      const other = ctx.container.ids.uuid();
      await query(insertEvent(other));
      await expect(
        query(
          `UPDATE operational_events SET resolved_by_event_id = '${other}' WHERE id = '${other}'`,
        ),
      ).rejects.toThrowError(/resolved_at/i);
    });

    it('still refuses a delete, which is why there is no retention sweep', async () => {
      // ADR-0020 records this: the drafted retention setting was removed when
      // this trigger was checked rather than assumed. The guard did not move.
      const id = ctx.container.ids.uuid();
      await query(insertEvent(id));
      await expect(query(`DELETE FROM operational_events WHERE id = '${id}'`)).rejects.toThrowError(
        /append-only/i,
      );
    });
  });

  describe('the role backfill in migration 0011', () => {
    /**
     * The statement, read from the migration rather than retyped.
     *
     * A copy would drift from the file it is meant to prove, and a test that
     * asserts a copy of the SQL is a test of the copy.
     */
    const backfill = () => {
      const sql = readFileSync('apps/api/drizzle/0011_control_plane_guards.sql', 'utf8');
      const start = sql.indexOf('INSERT INTO "role_permissions"');
      expect(start).toBeGreaterThan(-1);
      return sql.slice(start);
    };

    it('gives the three widened seeds their template permissions and nothing else', async () => {
      // Seeded roles are written at creation and never reasserted, so a
      // permission newly added to a seed reaches an existing installation only
      // through a migration. Without this one, `operator` means one thing on an
      // installation created last month and another on one created next month.
      await ctx.container.roles.ensureSystemRoles(tenantA);

      // Put the tenant back into the state a pre-Phase-2 installation is in.
      await query(`DELETE FROM role_permissions WHERE permission_key LIKE 'templates.%'`);
      const before = await query(
        `SELECT count(*)::int AS n FROM role_permissions WHERE permission_key LIKE 'templates.%'`,
      );
      expect(before.rows[0].n).toBe(0);

      await query(backfill());

      const granted = await query(`
        SELECT r.key AS role_key, rp.permission_key
        FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE rp.permission_key LIKE 'templates.%'
        ORDER BY r.key, rp.permission_key`);

      expect(
        granted.rows.map((row: Record<string, string>) => `${row.role_key}:${row.permission_key}`),
      ).toEqual([
        'observer:templates.view',
        'operator:templates.edit',
        'operator:templates.view',
        'owner:templates.edit',
        'owner:templates.view',
      ]);
    });

    it('is idempotent, so a re-run is not an error', async () => {
      await ctx.container.roles.ensureSystemRoles(tenantA);
      await query(backfill());
      await query(backfill());

      const rows = await query(
        `SELECT count(*)::int AS n FROM role_permissions WHERE permission_key LIKE 'templates.%'`,
      );
      // Five grants, not ten. `ON CONFLICT DO NOTHING` is doing the work.
      expect(rows.rows[0].n).toBe(5);
    });

    it('leaves a role an operator created alone', async () => {
      // The create-only rule protects a permission somebody withdrew. A role
      // that was never seeded from the catalogue is not this migration's to
      // widen at all.
      await ctx.container.roles.ensureSystemRoles(tenantA);
      const roleId = ctx.container.ids.uuid();
      await query(`
        INSERT INTO roles (id, tenant_id, key, name, is_system)
        VALUES ('${roleId}', '${A}', 'operator', 'A custom role that shares a key', false)
        ON CONFLICT DO NOTHING`);

      await query(backfill());

      const custom = await query(
        `SELECT count(*)::int AS n FROM role_permissions WHERE role_id = '${roleId}'`,
      );
      expect(custom.rows[0].n).toBe(0);
    });
  });

  describe('optimistic concurrency columns', () => {
    it('refuses a version below one on every versioned table', async () => {
      await expect(
        query(`
          INSERT INTO setting_values (id, tenant_id, setting_key, value, version)
          VALUES ('01900000-0000-7000-8000-0000000f0040', '${A}', 'ops.notifications.max_attempts', '5', 0)`),
      ).rejects.toThrowError(/setting_values_version_check/);

      await expect(
        query(`
          INSERT INTO feature_flag_states (id, tenant_id, flag_key, enabled, version)
          VALUES ('01900000-0000-7000-8000-0000000f0041', '${A}', 'ops_notifications', true, 0)`),
      ).rejects.toThrowError(/feature_flag_states_version_check/);
    });

    it('allows one row per key per tenant and no more', async () => {
      await query(`
        INSERT INTO setting_values (id, tenant_id, setting_key, value, version)
        VALUES ('01900000-0000-7000-8000-0000000f0042', '${A}', 'ops.notifications.max_attempts', '5', 1)`);
      await expect(
        query(`
          INSERT INTO setting_values (id, tenant_id, setting_key, value, version)
          VALUES ('01900000-0000-7000-8000-0000000f0043', '${A}', 'ops.notifications.max_attempts', '6', 1)`),
      ).rejects.toThrowError(/setting_values_key/);
    });
  });
});
