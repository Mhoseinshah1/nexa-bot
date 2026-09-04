import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from './harness';

/**
 * The rollback window, proved rather than asserted.
 *
 * `botctl rollback` returns the APPLICATION to the previous release and
 * deliberately does not restore the database — restoring a backup taken before
 * the migration would discard every write made since. That is only sound if
 * release N's schema still works for release N-1's code for as long as the
 * rollback window lasts:
 *
 *     EXPAND -> DEPLOY COMPATIBLE CODE -> CONTRACT LATER
 *
 * Documenting the rule is not evidence. This applies the migrations up to the
 * PREVIOUS release into a scratch database, exercises the operations the
 * previous release performs, applies THIS release's migrations underneath it,
 * and then performs those same operations again. If a migration in this release
 * narrowed anything the previous release still writes, the second pass fails.
 *
 * A scratch database, created and dropped here, so this cannot disturb the
 * suite running beside it.
 */
describe('migration compatibility across the rollback window', () => {
  const journal = JSON.parse(
    readFileSync(join(__dirname, '../../apps/api/drizzle/meta/_journal.json'), 'utf8'),
  ) as { entries: { idx: number; tag: string }[] };

  // The last migration of the PREVIOUS release. Everything up to and including
  // it is what an installation being updated already has; everything AFTER it
  // is what this release will apply underneath the previous release's code.
  //
  // Split by journal ORDER, not by membership of a list. An earlier version
  // named the incoming migrations explicitly, which meant a NEW migration fell
  // into `previous` — it was applied in beforeAll, before the previous
  // release's operations ever ran, so the gate did not apply to the one
  // migration it most needed to. A `DROP COLUMN` in a hypothetical 0017 passed
  // all three tests. This is the ordering the update actually performs.
  const PREVIOUS_RELEASE_LAST = '0014_claim_exclusivity';
  const boundary = journal.entries.findIndex((e) => e.tag === PREVIOUS_RELEASE_LAST);
  if (boundary < 0) throw new Error(`${PREVIOUS_RELEASE_LAST} is not in the journal`);
  const previous = journal.entries.slice(0, boundary + 1);
  const incoming = journal.entries.slice(boundary + 1);

  const scratch = `nexa_rollback_${Date.now()}`;
  const adminUrl = () => testConfig().DATABASE_URL;
  const scratchUrl = () => {
    const u = new URL(adminUrl());
    u.pathname = `/${scratch}`;
    return u.toString();
  };

  const apply = async (client: Client, tag: string) => {
    const sql = readFileSync(join(__dirname, `../../apps/api/drizzle/${tag}.sql`), 'utf8');
    // The same split the drizzle migrator uses.
    for (const statement of sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed) await client.query(trimmed);
    }
  };

  let client: Client;

  beforeAll(async () => {
    const admin = new Client(adminUrl());
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${scratch}`);
    await admin.query(`CREATE DATABASE ${scratch}`);
    await admin.end();

    client = new Client(scratchUrl());
    await client.connect();
    for (const entry of previous) await apply(client, entry.tag);

    // The installation the previous release provisioned. It is already there
    // when an update runs, so the incoming index must tolerate it rather than
    // only an empty table.
    await client.query(
      `INSERT INTO tenants (id, kind, parent_tenant_id, slug, display_name, status,
                            locale, display_timezone, calendar, currency)
       VALUES (gen_random_uuid(), 'PRIMARY', NULL, 'installation', 'Installation', 'ACTIVE',
               'fa', 'Asia/Tehran', 'jalali', 'IRT')`,
    );
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    const admin = new Client(adminUrl());
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${scratch}`);
    await admin.end();
  });

  /**
   * What the PREVIOUS release does to this database.
   *
   * Issued as the SQL that release's code issues, because running its compiled
   * output would need a second checkout of it. These are the writes and reads
   * that must keep working while an operator is rolled back onto it: provision
   * an installation, record a notification, spend an attempt number, hand a
   * different one back, and read the state the dispatcher reads.
   */
  const previousReleaseOperations = async (suffix: string) => {
    const tenant = await client.query(
      `INSERT INTO tenants (id, kind, parent_tenant_id, slug, display_name, status,
                            locale, display_timezone, calendar, currency)
       VALUES (gen_random_uuid(), 'RESELLER_BOT',
               (SELECT id FROM tenants WHERE kind = 'PRIMARY' LIMIT 1),
               $1, 'Compat', 'ACTIVE', 'fa', 'Asia/Tehran', 'jalali', 'IRT')
       RETURNING id`,
      [`compat-${suffix}`],
    );
    const tenantId = String(tenant.rows[0].id);

    const notification = await client.query(
      `INSERT INTO notifications (id, tenant_id, kind, dedupe_key, destination, payload,
                                  template_key, max_attempts)
       VALUES (gen_random_uuid(), $1, 'OPERATIONS_TEST', $2, '{}'::jsonb, '{}'::jsonb,
               'ops.test', 5)
       RETURNING id`,
      [tenantId, `compat-${suffix}`],
    );
    const notificationId = String(notification.rows[0].id);

    // A spent attempt number.
    await client.query(
      `INSERT INTO notification_delivery_attempts
         (id, tenant_id, notification_id, attempt_number, transport, outcome,
          started_at, finished_at)
       VALUES (gen_random_uuid(), $1, $2, 1, 'TELEGRAM', 'SUCCEEDED', now(), now())`,
      [tenantId, notificationId],
    );
    // A returned one, on a DIFFERENT number.
    await client.query(
      `INSERT INTO notification_released_claims
         (tenant_id, notification_id, attempt_number, released_at, reason)
       VALUES ($1, $2, 2, now(), 'worker.handback')`,
      [tenantId, notificationId],
    );

    // The dispatcher's own arithmetic: spend is attempt_count minus the
    // numbers handed back. Recorded here as the previous release records it.
    await client.query(`UPDATE notifications SET attempt_count = 2 WHERE id = $1`, [
      notificationId,
    ]);
    const spend = await client.query(
      `SELECT n.attempt_count
            - (SELECT count(*) FROM notification_released_claims r
                WHERE r.tenant_id = n.tenant_id AND r.notification_id = n.id)::int AS owed
         FROM notifications n WHERE n.id = $1`,
      [notificationId],
    );
    // A panel and its health, with a failure kind the PREVIOUS release writes.
    //
    // Only once `panels` exists. The boundary this file replays from predates
    // the panel tables entirely, so there is nothing to write in the BEFORE
    // run — and nothing to prove there either. The AFTER run is the one that
    // matters: it is the schema an operator is rolled back onto.
    //
    // Here because a CHECK built from a contract enum is redefined whenever
    // that enum grows, and a redefinition is the one shape that can silently
    // NARROW: the constraint is dropped and re-added, and nothing structural
    // says the new list is a superset. This write is what makes the widening
    // behavioural rather than assumed — if a future migration re-adds this
    // constraint without a value the previous release still writes, this row
    // stops inserting and the rollback window is proven broken here rather
    // than on somebody's installation.
    const present = await client.query(`SELECT to_regclass('public.panels') AS t`);
    let failure: string | null = null;
    if (present.rows[0].t !== null) {
      const panel = await client.query(
        `INSERT INTO panels (id, tenant_id, name, provider_type, base_url, status)
         VALUES (gen_random_uuid(), $1, $2, 'marzban', 'https://panel.example.test', 'ACTIVE')
         RETURNING id`,
        [tenantId, `compat-panel-${suffix}`],
      );
      const panelId = String(panel.rows[0].id);
      await client.query(
        `INSERT INTO panel_health
           (panel_id, tenant_id, state, checked_at, latency_ms, failure, status_code)
         VALUES ($1, $2, 'AUTH_FAILED', now(), 12, 'AUTHENTICATION_FAILED', 401)`,
        [panelId, tenantId],
      );
      const health = await client.query(`SELECT failure FROM panel_health WHERE panel_id = $1`, [
        panelId,
      ]);
      failure = String(health.rows[0].failure);
    }

    return { tenantId, notificationId, owed: Number(spend.rows[0].owed), failure };
  };

  it('the previous release works against its own schema', async () => {
    const before = await previousReleaseOperations('before');
    expect(before.notificationId).toBeTruthy();
    // One spent number and one returned: the spend the dispatcher computes.
    expect(before.owed).toBe(1);
  });

  it('this release migrates on top of it without stopping the previous release working', async () => {
    for (const entry of incoming) await apply(client, entry.tag);

    // The rollback window: release N's schema, release N-1's operations.
    const after = await previousReleaseOperations('after');
    expect(after.notificationId).toBeTruthy();
    // The same answer as before the migration. A schema that changed what the
    // previous release computes is a schema it cannot be rolled back onto.
    expect(after.owed).toBe(1);
    // And the widened CHECK still accepts what the previous release writes.
    expect(after.failure).toBe('AUTHENTICATION_FAILED');
  });

  it('the incoming migrations only ADD; they narrow nothing the previous release writes', async () => {
    // Read the incoming SQL and refuse the statements that make a rollback
    // unsound. This is the mechanical half of expand/deploy/contract: the
    // test above proves THIS transition, and this one states the rule the next
    // migration has to obey.
    for (const entry of incoming) {
      const sql = readFileSync(join(__dirname, `../../apps/api/drizzle/${entry.tag}.sql`), 'utf8')
        // Comments explain the rule and would otherwise trip it.
        .replace(/^\s*--.*$/gm, '')
        .toUpperCase();
      // A unique index and a CHECK are additions that NARROW: rows the
      // previous release could write may stop being writable. They are allowed
      // — 0015 adds one — but only because the behavioural replay above proves
      // the previous release still works. Listing them here would forbid the
      // release this file ships with, so the rule is: the shapes below are
      // never acceptable, and a narrowing addition has to survive the replay.
      for (const forbidden of [
        'DROP COLUMN',
        'DROP TABLE',
        'SET NOT NULL',
        'DROP DEFAULT',
        'RENAME COLUMN',
        'RENAME TO',
        'TRUNCATE',
      ]) {
        expect(
          sql,
          `${entry.tag} contains ${forbidden}, which the previous release may still need`,
        ).not.toContain(forbidden);
      }

      // `DROP CONSTRAINT` is handled separately, because two different things
      // wear it. REMOVING a constraint the previous release relies on is
      // exactly what this test forbids. REDEFINING one — dropping it and
      // re-adding it under the same name in the same migration — is the only
      // way PostgreSQL can widen a CHECK, and a CHECK generated from a
      // contract enum has to widen whenever that enum grows. 0021 does this
      // for `panel_health_failure_check`.
      //
      // So the structural rule is: every dropped constraint must be re-added
      // by the same file. That still catches a bare removal, and it does not
      // by itself prove the redefinition is a WIDENING — which is why the
      // replay above now writes a `panel_health` row carrying a failure kind
      // the previous release produces. A re-add that narrowed would fail there.
      const dropped = [...sql.matchAll(/DROP CONSTRAINT\s+"?([A-Z0-9_]+)"?/g)].map((m) => m[1]);
      for (const name of dropped) {
        expect(
          sql,
          `${entry.tag} drops constraint ${name} without re-adding it, so the previous release loses it`,
        ).toMatch(new RegExp(`ADD CONSTRAINT\\s+"?${name}"?`));
      }
    }
  });
});
