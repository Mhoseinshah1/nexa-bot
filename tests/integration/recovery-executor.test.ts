import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createContainer, type Container } from '../../apps/api/src/container';
import { runMigrations } from '../../apps/api/src/infrastructure/persistence/migrate';
import { seed } from '../../apps/api/src/infrastructure/persistence/seed';
import { adminActorFor, createAdmin, tenantA, testConfig } from './harness';

/**
 * The recovery executor, against a real PostgreSQL, INCLUDING the real renames.
 *
 * This suite does something no other file here does: it builds a container
 * pointed at a THROWAWAY live database, so the cutover's two `ALTER DATABASE
 * ... RENAME TO` statements operate on a database created for the case and
 * dropped after it. Running it against `nexa_test` would rename the suite's own
 * database out from under every other file.
 *
 * That is also why it is worth the setup cost. The cutover is the only
 * irreversible operation on this branch, and every property that matters about it
 * — that production survives a refusal, that the outgoing database survives under
 * a recorded name, that the connection string keeps working afterwards — is a
 * property of PostgreSQL's behaviour and not of this code's intentions. There is
 * nothing to test about it in the abstract.
 */
describe('the recovery executor', () => {
  let liveName: string;
  let liveUrl: string;
  let container: Container;
  let workRoot: string;
  let recoveryRoot: string;
  /** Every database this case may have created, for the teardown to drop. */
  let created: string[];

  const admin = (): Client => {
    const base = new URL(testConfig().DATABASE_URL);
    base.pathname = '/postgres';
    return new Client({ connectionString: base.toString() });
  };

  /** Runs one statement on the maintenance database. */
  async function maintenance(sql: string): Promise<void> {
    const client = admin();
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  async function queryLive<T extends Record<string, unknown>>(
    database: string,
    sql: string,
  ): Promise<T[]> {
    const url = new URL(testConfig().DATABASE_URL);
    url.pathname = `/${database}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      return (await client.query<T>(sql)).rows;
    } finally {
      await client.end();
    }
  }

  async function databaseExists(name: string): Promise<boolean> {
    const client = admin();
    await client.connect();
    try {
      const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      return rows.length > 0;
    } finally {
      await client.end();
    }
  }

  beforeEach(async () => {
    workRoot = await mkdtemp(join(tmpdir(), 'nexa-exec-backups-'));
    recoveryRoot = await mkdtemp(join(tmpdir(), 'nexa-exec-recovery-'));
    liveName = `nexa_drlive_${randomBytes(6).toString('hex')}`;
    created = [liveName];
    await maintenance(`CREATE DATABASE "${liveName}"`);

    const url = new URL(testConfig().DATABASE_URL);
    url.pathname = `/${liveName}`;
    liveUrl = url.toString();
    await runMigrations(liveUrl);

    const config = testConfig({
      DATABASE_URL: liveUrl,
      BACKUP_WORK_DIR: workRoot,
      RECOVERY_WORK_DIR: recoveryRoot,
    });
    container = createContainer(config, 'recovery');
    await seed(container.database.db, container.cipher);
    container.setInstallationTenant(tenantA.tenantId);
  });

  afterEach(async () => {
    await container?.shutdown();
    // Everything this case could have produced: the live name (which may now be
    // the restored candidate), the displaced database, and any candidate a
    // refusal left behind.
    const all = await (async (): Promise<string[]> => {
      const client = admin();
      await client.connect();
      try {
        const { rows } = await client.query<{ datname: string }>(
          `SELECT datname FROM pg_database
            WHERE datname LIKE 'nexa_drlive_%' OR datname LIKE 'nexa_candidate_%'
               OR datname LIKE 'nexa_pre_restore_%' OR datname LIKE 'nexa_verify_%'
               OR datname LIKE 'nexa_rtest_%'`,
        );
        return rows.map((row) => row.datname);
      } finally {
        await client.end();
      }
    })();
    for (const name of new Set([...created, ...all])) {
      await maintenance(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    }
    await rm(workRoot, { recursive: true, force: true });
    await rm(recoveryRoot, { recursive: true, force: true });
  });

  /**
   * Takes a real backup, uploads it, verifies it, and confirms it.
   *
   * Through the services an operator's requests reach, so the row the executor
   * claims is a row the real path produced — including the confirmation binding,
   * which the executor re-checks.
   */
  async function confirmedRecovery(options?: {
    /**
     * Run after the backup and before the upload.
     *
     * Because one property needs a fact to be true while the ARCHIVE is taken and
     * false afterwards: a recovery row in a destructive state, which is what a
     * `PRE_RESTORE` backup's own row is, and which would otherwise hold the
     * installation's one-at-a-time exclusion and refuse the upload below.
     */
    afterBackup?: () => Promise<void>;
  }): Promise<{ recoveryId: string; backupId: string; archivePath: string }> {
    const outcome = await container.backup.run('MANUAL');
    expect(outcome.kind).toBe('COMPLETED');
    if (outcome.kind !== 'COMPLETED') throw new Error('unreachable');
    expect(outcome.run.state).toBe('SUCCEEDED');
    const backupId = outcome.run.id;
    await options?.afterBackup?.();

    /*
     * A REAL administrator, through the harness's own `createAdmin`.
     *
     * Not a fabricated actor object: the recovery service checks a permission
     * through the guard, and an actor that skipped it would leave the HTTP suite
     * as the only place authorisation is proved — while this file, which drives
     * the destructive path, would be exercising a code path no operator can reach.
     */
    const owner = await createAdmin(container, tenantA, {
      username: 'executor-owner',
      roleKeys: ['owner'],
    });
    const actor = adminActorFor(owner);

    const begun = await container.recoveryService.beginUpload(tenantA, actor, {
      clientFilename: 'from-the-pipeline.nxb',
    });
    // The archive the pipeline just wrote, copied into the recovery workspace the
    // way an upload would have delivered it.
    const { copyFile } = await import('node:fs/promises');
    await copyFile(join(workRoot, backupId, 'archive.nxb'), begun.workspace.archivePath);
    const { stat } = await import('node:fs/promises');
    const stats = await stat(begun.workspace.archivePath);
    await container.recoveryService.completeUpload(tenantA, begun.request.id, {
      sizeBytes: stats.size,
      archiveSha256: 'a'.repeat(64),
    });

    const tested = await container.recoveryService.verifyAndTest(tenantA, actor, begun.request.id);
    expect(tested.failureCode).toBeNull();
    expect(tested.request.state).toBe('RESTORE_TEST_PASSED');

    const confirmed = await container.recoveryService.confirm(tenantA, actor, begun.request.id, {
      phrase: 'RESTORE NEXA',
      artifactChecksum: tested.request.artifactChecksum ?? '',
    });
    expect(confirmed.state).toBe('RESTORE_REQUESTED');
    return {
      recoveryId: begun.request.id,
      backupId,
      archivePath: begun.workspace.archivePath,
    };
  }

  it('cuts over for real: two renames, and production is the restored database', async () => {
    // A marker row, so "the live name now serves the restored data" is a claim
    // about CONTENT rather than about a name. It is written BEFORE the backup, so
    // the restored copy must contain it.
    await container.database.db.execute(
      `INSERT INTO operational_events
         (id, tenant_id, code, severity, message, occurrence_count, first_seen_at, last_seen_at, correlation_id, dedupe_scope)
       VALUES ('01900000-0000-7000-8000-0000000000a1', '${tenantA.tenantId}', 'test.marker', 'INFO',
               'present before the backup', 1, now(), now(), 'exec-test', 'SYSTEM')` as never,
    );

    const { recoveryId } = await confirmedRecovery();

    // A row written AFTER the backup. It must NOT be in the restored database —
    // which is what makes the cutover a restore rather than a no-op.
    await container.database.db.execute(
      `INSERT INTO operational_events
         (id, tenant_id, code, severity, message, occurrence_count, first_seen_at, last_seen_at, correlation_id, dedupe_scope)
       VALUES ('01900000-0000-7000-8000-0000000000a2', '${tenantA.tenantId}', 'test.marker', 'INFO',
               'written after the backup', 1, now(), now(), 'exec-test', 'SYSTEM')` as never,
    );

    await container.recoveryExecutor.tick();

    const row = await container.recoveryRequests.byIdUnscoped(recoveryId);
    expect(row?.failureCode ?? null).toBeNull();
    expect(row?.state).toBe('SUCCEEDED');
    expect(row?.cutoverAt).not.toBeNull();
    expect(row?.displacedDatabase).toMatch(/^nexa_pre_restore_/);
    const displaced = row?.displacedDatabase ?? '';
    created.push(displaced);

    // THE LIVE NAME still resolves, and now serves the RESTORED data: the
    // pre-backup marker is there and the post-backup one is not.
    const markers = await queryLive<{ id: string }>(
      liveName,
      `SELECT id FROM operational_events WHERE code = 'test.marker' ORDER BY id`,
    );
    expect(markers.map((m) => m.id)).toEqual(['01900000-0000-7000-8000-0000000000a1']);

    // THE OUTGOING DATABASE SURVIVES, under the recorded name, with both rows.
    // This is what makes a rollback two more renames instead of another restore.
    expect(await databaseExists(displaced)).toBe(true);
    const outgoing = await queryLive<{ id: string }>(
      displaced,
      `SELECT id FROM operational_events WHERE code = 'test.marker' ORDER BY id`,
    );
    expect(outgoing).toHaveLength(2);

    // And the candidate name is GONE — it became the live name rather than being
    // left beside it.
    expect(row?.candidateDatabase).toMatch(/^nexa_candidate_/);
    expect(await databaseExists(row?.candidateDatabase ?? '')).toBe(false);
  });

  it('re-asserts its own row into the restored database', async () => {
    // ADR-0028 § 4. The row lives in the database that gets renamed away, and the
    // restored candidate carries the rows that were in the BACKUP — which do not
    // include this recovery, because it had not happened when the backup was
    // taken. Without the re-assert, the recovery that produced this database
    // leaves no trace in it.
    const { recoveryId } = await confirmedRecovery();
    await container.recoveryExecutor.tick();

    const inRestored = await queryLive<{ state: string; cutover_at: string | null }>(
      liveName,
      `SELECT state, cutover_at FROM recovery_requests WHERE id = '${recoveryId}'`,
    );
    expect(inRestored).toHaveLength(1);
    expect(inRestored[0]?.state).toBe('SUCCEEDED');
    expect(inRestored[0]?.cutover_at).not.toBeNull();
  });

  it('takes a verified PRE_RESTORE backup before touching anything', async () => {
    const { recoveryId } = await confirmedRecovery();
    await container.recoveryExecutor.tick();

    const row = await container.recoveryRequests.byIdUnscoped(recoveryId);
    expect(row?.preRestoreBackupId).not.toBeNull();

    // In the RESTORED database the pre-restore backup row is absent, because it
    // was taken after the artifact being restored. So it is read from the
    // displaced one, which is where it actually happened.
    const emergency = await queryLive<{
      trigger: string;
      state: string;
      verified_at: string | null;
    }>(
      row?.displacedDatabase ?? '',
      `SELECT trigger, state, verified_at FROM backup_runs WHERE id = '${row?.preRestoreBackupId ?? ''}'`,
    );
    expect(emergency).toHaveLength(1);
    expect(emergency[0]?.trigger).toBe('PRE_RESTORE');
    expect(emergency[0]?.state).toBe('SUCCEEDED');
    // Verified against a REAL restore, not merely dumped. The executor refuses to
    // continue without this.
    expect(emergency[0]?.verified_at).not.toBeNull();
  });

  it('aborts before anything destructive when the emergency backup cannot run', async () => {
    const { recoveryId } = await confirmedRecovery();
    // A RUNNING row holds the installation's one-at-a-time backup lock, so the
    // mandatory pre-restore backup reports BUSY.
    await container.database.db.execute(
      `INSERT INTO backup_runs (id, trigger, state, stage, started_at, lease_owner, lease_heartbeat_at, delivery_state, cleanup_ok)
       VALUES ('01900000-0000-7000-8000-0000000000b1', 'SCHEDULED', 'RUNNING', 'DUMP', now(), 'somebody-else', now(), 'NOT_ATTEMPTED', true)` as never,
    );

    await container.recoveryExecutor.tick();

    const row = await container.recoveryRequests.byIdUnscoped(recoveryId);
    expect(row?.state).toBe('FAILED');
    expect(row?.failureCode).toBe('recovery.emergency_backup_busy');
    // NOTHING destructive happened: no cutover, no candidate, and the live
    // database is still the live database.
    expect(row?.cutoverAt).toBeNull();
    expect(row?.displacedDatabase).toBeNull();
    expect(row?.candidateDatabase).toBeNull();
    expect(await databaseExists(liveName)).toBe(true);
  });

  it('quiesces the installation while restoring, and the relay idles', async () => {
    const { recoveryId } = await confirmedRecovery();
    // Parked in a quiescing state by hand, because the real executor passes
    // through it in milliseconds and the property is about what OTHER writers see
    // while it is there.
    await container.database.db.execute(
      `UPDATE recovery_requests SET state = 'RESTORING', stage = 'RESTORE_CANDIDATE'
        WHERE id = '${recoveryId}'` as never,
    );

    // THE WRITE GATE. Every durable write opens its transaction in the unit of
    // work, so this is the refusal every write path gets — not a per-call-site
    // check somebody could forget to add.
    await expect(
      container.uow.run(tenantA, async () => {
        return 'should not reach here';
      }),
    ).rejects.toThrow(/being restored/i);

    /*
     * And the RELAY, which opens its transaction on the database handle directly
     * and is therefore the one write path the unit of work cannot cover. It
     * claims nothing rather than publishing against a database about to be
     * replaced.
     *
     * A MESSAGE IS PLANTED FIRST, and that is the whole assertion. Without one
     * the relay returns `{claimed: 0}` because there is nothing to claim, so the
     * expectation below was satisfied by an empty outbox and passed with the
     * gate check removed — the falsification harness reported SURVIVED, which is
     * how this was found. The positive control after the quiesce clears is the
     * other half: it proves the zero above came from the gate rather than from
     * the relay being unable to claim anything at all.
     */
    await container.database.db.execute(
      `INSERT INTO outbox_messages
         (id, aggregate_type, aggregate_id, sequence, event_type, payload, actor, correlation_id, occurred_at)
       VALUES ('01900000-0000-7000-8000-00000000ee71', 'System', 'system', 1, 'SystemPinged', '{}', '{}', 'quiesce-probe', now())` as never,
    );
    const batch = await container.relay.processBatch();
    expect(batch).toEqual({ claimed: 0, published: 0, failed: 0 });

    // The message is still there, unclaimed: a gate that swallowed it would be
    // worse than one that let it through.
    const unclaimed = await container.database.db.execute(
      `SELECT count(*)::int AS n FROM outbox_messages
        WHERE correlation_id = 'quiesce-probe' AND published_at IS NULL` as never,
    );
    expect((unclaimed.rows as unknown as readonly { n: number }[])[0]?.n).toBe(1);

    // A READ is unaffected: an operator supervising a recovery is reading.
    const still = await container.recoveryRequests.byIdUnscoped(recoveryId);
    expect(still?.state).toBe('RESTORING');

    // THE POSITIVE CONTROL. With the quiesce lifted, the same relay claims the
    // same message — so the zero above was the gate refusing, and not the relay
    // being incapable.
    await container.database.db.execute(
      `UPDATE recovery_requests SET state = 'FAILED', finished_at = now(),
              failure_code = 'recovery.internal'
        WHERE id = '${recoveryId}'` as never,
    );
    const after = await container.relay.processBatch();
    expect(after.claimed).toBeGreaterThan(0);
  });

  it('lets the recovery lane write while everything else is refused', async () => {
    const { recoveryId } = await confirmedRecovery();
    await container.database.db.execute(
      `UPDATE recovery_requests SET state = 'RESTORING', stage = 'RESTORE_CANDIDATE'
        WHERE id = '${recoveryId}'` as never,
    );
    // The exemption is by SCOPE, not by an option a caller could pass. Without it
    // the executor could not record its own progress during the window it opened.
    const wrote = await container.uow.run(
      { kind: 'SYSTEM', reason: 'recovery' } as never,
      async () => 'the recovery lane writes',
    );
    expect(wrote).toBe('the recovery lane writes');
  });

  it('does not quiesce during the pre-restore backup', async () => {
    // That stage writes to backup_runs, operational_events and the outbox. An
    // installation refusing writes during it could not take the backup that makes
    // everything after it recoverable.
    const { recoveryId } = await confirmedRecovery();
    await container.database.db.execute(
      `UPDATE recovery_requests SET state = 'PRE_RESTORE_BACKUP', stage = 'EMERGENCY_BACKUP'
        WHERE id = '${recoveryId}'` as never,
    );
    const wrote = await container.uow.run(tenantA, async () => 'writes are still permitted');
    expect(wrote).toBe('writes are still permitted');
  });

  it('refuses an expired confirmation, and nothing destructive happens', async () => {
    const { recoveryId } = await confirmedRecovery();
    // Confirmed, and then left. An executor that was not running, a host that was
    // down, a queue nobody drained — the row still says RESTORE_REQUESTED and the
    // operator who typed the phrase went home an hour ago.
    await container.database.db.execute(
      `UPDATE recovery_requests SET confirmation_expires_at = now() - interval '1 minute'
        WHERE id = '${recoveryId}'` as never,
    );

    await container.recoveryExecutor.tick();

    const row = await container.recoveryRequests.byIdUnscoped(recoveryId);
    expect(row?.state).toBe('FAILED');
    expect(row?.failureCode).toBe('recovery.confirmation_invalid');
    // Before the pre-restore backup, let alone the renames.
    expect(row?.preRestoreBackupId).toBeNull();
    expect(row?.candidateDatabase).toBeNull();
    expect(row?.cutoverAt).toBeNull();
    expect(await databaseExists(liveName)).toBe(true);
  });

  it('refuses to cut over to a candidate this release cannot account for', async () => {
    /*
     * The LAST refusal before the renames, and the only one that cannot be
     * reached by feeding the pipeline a bad archive.
     *
     * A diverged archive is refused earlier, by the restore test, so it never
     * becomes a confirmed request — which is why this check looked untestable and
     * why the falsification harness reported SURVIVED for removing it. It is
     * still load-bearing, and reachable in production by two routes the tests
     * above cannot produce: a candidate that passed the restore test as
     * BEHIND-but-migratable and did not become current after `migrateCandidate`,
     * and an executor running a different release's migration journal than the
     * api that tested the archive — which is one moment of every rolling update.
     *
     * So the STATE is injected rather than the archive: the executor's own deps,
     * with `compatibility` reporting a verdict this release cannot cut over to.
     * Reaching into the private field is deliberate and is the narrowest
     * intervention available — everything else is the production object, so what
     * runs is the real `runStages` on a real candidate it really restored.
     */
    const { recoveryId } = await confirmedRecovery();

    type Deps = {
      recovery: { compatibility: (applied: readonly unknown[]) => unknown };
    };
    const deps = (container.recoveryExecutor as unknown as { deps: Deps }).deps;
    const real = deps.recovery.compatibility.bind(deps.recovery);
    deps.recovery.compatibility = () => ({
      verdict: 'DIVERGED',
      permitted: false,
      // NOT migratable: a migration pass would not help, which is the shape that
      // has to reach the final refusal rather than the migrate-and-recheck path.
      migratable: false,
      applied: 30,
      expected: 30,
    });
    try {
      await container.recoveryExecutor.tick();
    } finally {
      deps.recovery.compatibility = real;
    }

    const row = await container.recoveryRequests.byIdUnscoped(recoveryId);
    expect(row?.state).toBe('FAILED');
    expect(row?.failureCode).toBe('recovery.migration_incompatible');
    // The candidate was BUILT — this refusal happens after a real restore — and
    // production is still production. That is the property: a refusal this late
    // costs a candidate database and nothing else.
    expect(row?.candidateDatabase).not.toBeNull();
    expect(row?.cutoverAt).toBeNull();
    expect(row?.displacedDatabase).toBeNull();
    expect(await databaseExists(liveName)).toBe(true);
    // And the live database still holds the rows it held, rather than the
    // candidate's: no rename happened in either direction.
    const rows = await queryLive<{ count: string }>(liveName, 'SELECT count(*) FROM tenants');
    expect(Number(rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });

  it('refuses a request that reached RESTORE_REQUESTED with no confirmation at all', async () => {
    /*
     * The row the executor must not take on trust.
     *
     * It is reachable only by something other than `confirm` writing the state —
     * a hand-written UPDATE, a future code path, a restored database carrying a
     * row mid-flight — and the binding re-check is what catches it, BEFORE the
     * clock check below it. That ordering is why the expiry's own null branch is
     * unreachable and is recorded as such in the falsification record rather than
     * claimed as tested.
     */
    const { recoveryId } = await confirmedRecovery();
    await container.database.db.execute(
      `UPDATE recovery_requests
          SET confirmed_at = NULL, confirmed_by_admin_id = NULL,
              confirmed_checksum = NULL, confirmation_expires_at = NULL
        WHERE id = '${recoveryId}'` as never,
    );

    await container.recoveryExecutor.tick();

    const row = await container.recoveryRequests.byIdUnscoped(recoveryId);
    expect(row?.state).toBe('FAILED');
    expect(row?.failureCode).toBe('recovery.confirmation_invalid');
    expect(row?.cutoverAt).toBeNull();
    expect(await databaseExists(liveName)).toBe(true);
  });

  it('accepts a confirmation that is still inside its window', async () => {
    /*
     * The positive control for the case above, and it is not ceremony: a clock
     * check written the wrong way round — `>=` for `<=`, or a null treated as
     * valid — refuses EVERY recovery, and the expiry case above would pass just
     * as well. That failure mode is this project's own history: a readiness
     * parser was rewritten three times and two of the rewrites inverted the rule
     * they were written to protect.
     */
    const { recoveryId } = await confirmedRecovery();
    const before = await container.recoveryRequests.byIdUnscoped(recoveryId);
    expect(before?.confirmationExpiresAt).not.toBeNull();
    expect(before?.confirmationExpiresAt?.getTime()).toBeGreaterThan(Date.now());

    await container.recoveryExecutor.tick();

    const row = await container.recoveryRequests.byIdUnscoped(recoveryId);
    expect(row?.failureCode).toBeNull();
    expect(row?.state).toBe('SUCCEEDED');
    expect(row?.cutoverAt).not.toBeNull();
  });

  it('fails on a candidate name already taken, and leaves production serving', async () => {
    const { recoveryId } = await confirmedRecovery();
    // The candidate's name is derived from the recovery id, so it can be taken in
    // advance — which is what a previous attempt's debris IS. `CREATE DATABASE`
    // then fails, and the question is whether the failure is named and harmless.
    const candidate = `nexa_candidate_${recoveryId.replace(/-/g, '').slice(0, 20)}`;
    await maintenance(`CREATE DATABASE "${candidate}"`);
    created.push(candidate);

    await container.recoveryExecutor.tick();

    const row = await container.recoveryRequests.byIdUnscoped(recoveryId);
    expect(row?.state).toBe('FAILED');
    expect(row?.failureCode).toBe('recovery.candidate_create_failed');
    // The emergency backup DID run — it precedes the candidate — and the cutover
    // did not. Production is untouched and still answers.
    expect(row?.preRestoreBackupId).not.toBeNull();
    expect(row?.cutoverAt).toBeNull();
    expect(await databaseExists(liveName)).toBe(true);
    const rows = await queryLive<{ count: string }>(liveName, 'SELECT count(*) FROM tenants');
    expect(Number(rows[0]?.count ?? 0)).toBeGreaterThan(0);
  });

  it('lets only one executor claim a confirmed recovery', async () => {
    const { recoveryId } = await confirmedRecovery();
    const now = new Date();
    const [first, second] = await Promise.all([
      container.recoveryRequests.claimConfirmed({ leaseOwner: 'replica-one', now }),
      container.recoveryRequests.claimConfirmed({ leaseOwner: 'replica-two', now }),
    ]);
    const winners = [first, second].filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.id).toBe(recoveryId);
    // And the loser cannot claim it afterwards either: the lease is set by the
    // same statement that claims, so there is no window with an owner-less
    // request in a destructive state.
    const late = await container.recoveryRequests.claimConfirmed({
      leaseOwner: 'replica-three',
      now,
    });
    expect(late).toBeNull();
  });

  it('fails an abandoned recovery rather than adopting it, and names its debris', async () => {
    const { recoveryId } = await confirmedRecovery();
    await container.database.db.execute(
      `UPDATE recovery_requests
          SET state = 'RESTORING', stage = 'RESTORE_CANDIDATE',
              lease_owner = 'a-process-that-died',
              lease_heartbeat_at = now() - interval '1 hour',
              candidate_database = 'nexa_candidate_abandoned'
        WHERE id = '${recoveryId}'` as never,
    );

    await container.recoveryExecutor.tick();

    const row = await container.recoveryRequests.byIdUnscoped(recoveryId);
    expect(row?.state).toBe('FAILED');
    expect(row?.failureCode).toBe('recovery.lease_expired');
    // NOT adopted: the candidate belongs to a process that may still be writing
    // to it, and a second restorer writing into it is how two partial restores
    // become one plausible-looking database. The name stays on the row so an
    // operator can clean it up.
    expect(row?.candidateDatabase).toBe('nexa_candidate_abandoned');
    expect(row?.cutoverAt).toBeNull();
    // And the exclusion is released, so a new recovery is possible.
    const lock = await container.recoveryRequests.installationLock();
    expect(lock).toBeNull();
  });

  it('refuses to cut over to a candidate whose schema it cannot account for', async () => {
    const { recoveryId } = await confirmedRecovery();
    // The compatibility verdict is computed from the CANDIDATE's own
    // `__drizzle_migrations` against this release's journal. A candidate with a
    // migration this release does not know, interleaved among the expected ones,
    // is `diverged` — which has no safe reading, so production is not replaced.
    //
    // Driven through `compatibility` rather than by corrupting a real candidate,
    // because the verdict is the decision under test and the executor applies
    // exactly this function.
    const diverged = container.recoveryService.compatibility([
      { hash: 'not-a-hash-this-release-ships', createdAt: 1 },
    ]);
    expect(diverged.permitted).toBe(false);
    expect(diverged.migratable).toBe(false);
    expect(['DIVERGED', 'BEHIND', 'NONE']).toContain(diverged.verdict);

    // And the positive control, so the case cannot pass by the function always
    // refusing: the live database's own applied set IS permitted.
    const applied = await queryLive<{ hash: string; created_at: string }>(
      liveName,
      `SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
    );
    const current = container.recoveryService.compatibility(
      applied.map((row) => ({ hash: row.hash, createdAt: Number(row.created_at) })),
    );
    expect(current.verdict).toBe('CURRENT');
    expect(current.permitted).toBe(true);
    void recoveryId;
  });

  it('records the real cutover facts when the failure lands after both renames', async () => {
    /*
     * THE ONE FAILURE THAT CANNOT BE RECOVERED FROM A LIE.
     *
     * Every arrow before the cutover leaves production untouched, so a failure
     * path describing the recovery from the row as it was CLAIMED is harmless —
     * that row carries `cutoverAt: null`, `displacedDatabase: null` and
     * `candidateDatabase: null`, and before the cutover all three are true. After
     * the renames every one of them is false, and the one path that writes a row
     * there is this one: the row the operator reads, and a CRITICAL operational
     * event, would both say production was untouched while production was in fact
     * the candidate and the operator's previous data was sitting under a
     * `nexa_pre_restore_` name recorded nowhere. `purgeFinishedBefore` keeps rows
     * by `cutover_at`, so that row was also eligible for deletion.
     *
     * Reaching the window needs a failure BETWEEN the renames and the re-assert,
     * which is a process-level accident rather than a state any input produces.
     * So the re-assert is made to throw once, at the executor's own deps seam —
     * the same narrowest intervention the compatibility case above uses.
     * Everything else is the production object, and the renames really happen.
     */
    await container.database.db.execute(
      `INSERT INTO operational_events
         (id, tenant_id, code, severity, message, occurrence_count, first_seen_at, last_seen_at, correlation_id, dedupe_scope)
       VALUES ('01900000-0000-7000-8000-0000000000a3', '${tenantA.tenantId}', 'test.marker', 'INFO',
               'present before the backup', 1, now(), now(), 'exec-test', 'SYSTEM')` as never,
    );

    const { recoveryId } = await confirmedRecovery();

    type Requests = { reassert: (row: unknown) => Promise<void> };
    const requests = (container.recoveryExecutor as unknown as { deps: { requests: Requests } })
      .deps.requests;
    const real = requests.reassert.bind(requests);
    let calls = 0;
    requests.reassert = async (row) => {
      calls += 1;
      // The FIRST call is `runStages`' own, immediately after the second rename.
      // The second is the failure path's, and it must reach the real repository —
      // a stub that failed both would prove nothing about what gets written.
      if (calls === 1) throw new Error('the process lost its database between the renames');
      return real(row);
    };
    try {
      await container.recoveryExecutor.tick();
    } finally {
      requests.reassert = real;
    }
    // The failure path DID write, rather than the run having failed earlier for
    // some unrelated reason and never reaching the window under test.
    expect(calls).toBe(2);

    const row = await container.recoveryRequests.byIdUnscoped(recoveryId);
    expect(row?.state).toBe('FAILED');
    expect(row?.failureCode).toBe('recovery.internal');
    /*
     * `toBeInstanceOf(Date)` rather than `not.toBeNull()`, deliberately: an ABSENT
     * row satisfies `expect(undefined).not.toBeNull()`, so the weaker form would
     * pass in the very world this case exists to rule out — no row at all after a
     * completed cutover.
     */
    expect(row?.cutoverAt).toBeInstanceOf(Date);
    expect(row?.displacedDatabase).toMatch(/^nexa_pre_restore_/);
    expect(row?.candidateDatabase).toMatch(/^nexa_candidate_/);
    expect(row?.preRestoreBackupId).not.toBeNull();

    const displaced = row?.displacedDatabase ?? '';
    created.push(displaced);
    // AND THEY ARE FACTS. The row above is only worth asserting if the world it
    // describes is the world: the displaced database exists under the name it
    // names, and the live name now serves the restored data.
    expect(await databaseExists(displaced)).toBe(true);
    const markers = await queryLive<{ id: string }>(
      liveName,
      `SELECT id FROM operational_events WHERE code = 'test.marker' ORDER BY id`,
    );
    expect(markers.map((m) => m.id)).toEqual(['01900000-0000-7000-8000-0000000000a3']);
  });

  it('refuses an archive that is not the artifact the operator confirmed', async () => {
    const { recoveryId, archivePath } = await confirmedRecovery();

    /*
     * A SECOND, perfectly sound backup of this installation, swapped into the
     * workspace after the confirmation.
     *
     * This is the substitution nothing else catches. The archive is internally
     * consistent, so its dump matches its own manifest; the row's two checksum
     * columns are written from one value in one statement, so comparing them to
     * each other agrees as it always does; the restore test already passed
     * against the file that WAS there. Only a comparison of the bytes about to be
     * restored against the value the operator confirmed can tell these two
     * archives apart — ADR-0028 § 8, and the reason `decryptForExecutor` takes
     * the confirmed checksum as a parameter at all.
     *
     * A row is written between the two backups so the dumps differ in content and
     * not merely in a header timestamp.
     */
    await container.database.db.execute(
      `INSERT INTO operational_events
         (id, tenant_id, code, severity, message, occurrence_count, first_seen_at, last_seen_at, correlation_id, dedupe_scope)
       VALUES ('01900000-0000-7000-8000-0000000000a4', '${tenantA.tenantId}', 'test.marker', 'INFO',
               'written after the confirmed artifact', 1, now(), now(), 'exec-test', 'SYSTEM')` as never,
    );
    const second = await container.backup.run('MANUAL');
    expect(second.kind).toBe('COMPLETED');
    if (second.kind !== 'COMPLETED') throw new Error('unreachable');
    expect(second.run.state).toBe('SUCCEEDED');
    /*
     * And it is SOUND, proved by the pipeline rather than asserted: `verifiedAt`
     * is set only by a VERIFY_RESTORE that decrypted this ENCRYPTED archive
     * through `openArchive` and restored it. So the refusal below cannot be the
     * file being damaged — it is a good archive that nobody confirmed.
     */
    expect(second.run.verifiedAt).not.toBeNull();
    const { copyFile } = await import('node:fs/promises');
    await copyFile(join(workRoot, second.run.id, 'archive.nxb'), archivePath);

    await container.recoveryExecutor.tick();

    const row = await container.recoveryRequests.byIdUnscoped(recoveryId);
    expect(row?.state).toBe('FAILED');
    /*
     * Under the RESTORE stage's code, because `decryptForExecutor` is called from
     * inside it and that stage names every way it can fail. The code is not what
     * makes this case load-bearing — the mutation that removes the comparison
     * reaches SUCCEEDED, having restored an archive nobody confirmed over
     * production. What distinguishes a swapped archive from a damaged one here is
     * the verified second backup above, not the failure code.
     */
    expect(row?.failureCode).toBe('recovery.candidate_restore_failed');
    // The candidate was built and then thrown away; production was never touched.
    expect(row?.candidateDatabase).not.toBeNull();
    expect(row?.cutoverAt).toBeNull();
    expect(row?.displacedDatabase).toBeNull();
    expect(await databaseExists(liveName)).toBe(true);
    // And the live database is still the live database: the row written after the
    // confirmed artifact is still there, which it would not be had the swapped
    // archive been restored over it.
    const markers = await queryLive<{ id: string }>(
      liveName,
      `SELECT id FROM operational_events WHERE code = 'test.marker' ORDER BY id`,
    );
    expect(markers).toHaveLength(1);
  });

  it('completes a restore whose snapshot carries an outbox older than the lag ceiling', async () => {
    /*
     * `outboxLagMs` is the age of the oldest unpublished message, so after a
     * cutover it is THE AGE OF THE BACKUP — and it cannot recover while the check
     * is being made, because `RESTARTING` still quiesces the relay. Left in the
     * executor's readiness verdict, that reports `recovery.readiness_failed` on a
     * successful restore of any backup older than five minutes, with a CRITICAL
     * event, on an installation that is in fact serving. An operator reading it
     * would try to undo a restore that worked.
     *
     * The message is planted BEFORE the backup, unpublished, with an `occurred_at`
     * well beyond `OUTBOX_RELAY_MAX_LAG_MS`, so the restored candidate carries it.
     * Without it the restored lag is zero and there is nothing for the exclusion
     * to exclude — which is exactly why this rule went untested.
     */
    await container.database.db.execute(
      `INSERT INTO outbox_messages
         (id, aggregate_type, aggregate_id, sequence, event_type, payload, actor, correlation_id, occurred_at)
       VALUES ('01900000-0000-7000-8000-00000000ee18', 'System', 'system', 1, 'SystemPinged', '{}', '{}',
               'stale-lag-probe', now() - interval '2 hours')` as never,
    );

    const { recoveryId } = await confirmedRecovery();
    await container.recoveryExecutor.tick();

    const row = await container.recoveryRequests.byIdUnscoped(recoveryId);
    expect(row?.failureCode).toBeNull();
    expect(row?.state).toBe('SUCCEEDED');
    expect(row?.cutoverAt).not.toBeNull();
    created.push(row?.displacedDatabase ?? '');

    /*
     * THE POSITIVE CONTROL, and the half that makes this case mean something: the
     * restored database really does report the outbox down, right now, on the same
     * computation the load balancer gets. So the recovery above succeeded WHILE
     * that probe was failing, rather than on an installation where it happened to
     * be fine.
     */
    const verdict = await container.readiness.run();
    const outbox = verdict.dependencies.find((dependency) => dependency.name === 'outbox');
    expect(outbox?.status).toBe('down');
    // And nothing else is down, so the verdict turned on the outbox alone — a
    // restored database that failed two probes would make this case pass for the
    // wrong reason.
    expect(verdict.dependencies.filter((d) => d.name !== 'outbox' && d.status === 'down')).toEqual(
      [],
    );
  });

  it('cuts over even when the restored snapshot carries a destructive recovery row', async () => {
    /*
     * THE ROLLBACK'S OWN SHAPE.
     *
     * A `PRE_RESTORE` backup is taken while its recovery row sits in
     * `PRE_RESTORE_BACKUP`, and the dump excludes nothing — so restoring that
     * archive, which is precisely what a rollback restores, lands a row inside
     * `recovery_requests_single_destructive_idx`'s predicate. The re-assert then
     * writes `RESTARTING` into the same predicate and raises 23505 on the partial
     * index rather than on the primary key, which `onConflictDoUpdate(id)` does not
     * cover: a SUCCESSFUL cutover ended as `recovery.internal`.
     *
     * The decoy is inserted before the backup and removed from the live database
     * after it, so it exists in the ARCHIVE and not in the installation — which is
     * the asymmetry a real rollback has, and which the live database cannot hold
     * for long anyway, since the exclusion it sits in is the one this recovery
     * needs.
     */
    const decoy = '01900000-0000-7000-8000-0000000000d1';
    await container.database.db.execute(
      `INSERT INTO recovery_requests (id, tenant_id, source, state, stage, created_at, updated_at)
       VALUES ('${decoy}', '${tenantA.tenantId}', 'UPLOAD', 'PRE_RESTORE_BACKUP', 'EMERGENCY_BACKUP',
               now(), now())` as never,
    );
    const { recoveryId } = await confirmedRecovery({
      afterBackup: async () => {
        await container.database.db.execute(
          `DELETE FROM recovery_requests WHERE id = '${decoy}'` as never,
        );
      },
    });

    await container.recoveryExecutor.tick();

    const row = await container.recoveryRequests.byIdUnscoped(recoveryId);
    expect(row?.failureCode).toBeNull();
    expect(row?.state).toBe('SUCCEEDED');
    expect(row?.cutoverAt).not.toBeNull();
    created.push(row?.displacedDatabase ?? '');

    /*
     * The snapshot really did carry the decoy — without this the case would pass
     * against an archive that never contained one — and it is CLOSED rather than
     * deleted, so an operator can read and date the recovery that was in flight
     * when the backup was taken.
     */
    const closed = await queryLive<{ state: string; stage: string; failure_code: string | null }>(
      liveName,
      `SELECT state, stage, failure_code FROM recovery_requests WHERE id = '${decoy}'`,
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]?.state).toBe('FAILED');
    expect(closed[0]?.stage).toBe('CLEANUP');
    expect(closed[0]?.failure_code).toBe('recovery.lease_expired');
  });

  it('reconstructs a cutover nothing recorded, from the journal on disk', async () => {
    /*
     * The crash the journal exists for: both renames done, and the process gone
     * before the re-assert.
     *
     * Nothing in any database can find this. The row that would describe it was
     * inside the database the cutover renamed away, and the database that is live
     * now carries the BACKUP's rows — which cannot contain a recovery that had not
     * happened when the backup was taken. So `claimOwn` finds nothing, every
     * ordinary path finds nothing, and without the reconciliation the recovery —
     * and the name of the displaced database holding the operator's previous data —
     * is invisible for ever.
     *
     * The journal is written by hand because the only way to produce it otherwise
     * is to kill the process, and a test that kills its own process asserts
     * nothing afterwards. The FILE is the real one, in the real directory, read by
     * the real `FileCutoverJournal`.
     */
    const orphan = '01900000-0000-7000-8000-0000000000c7';
    const displaced = 'nexa_pre_restore_orphanc7';
    const candidate = 'nexa_candidate_orphanc7';
    const { writeFile, readdir } = await import('node:fs/promises');
    await writeFile(
      join(recoveryRoot, `cutover-${orphan}.json`),
      JSON.stringify({
        recoveryId: orphan,
        phase: 'RENAMED',
        liveDatabase: liveName,
        candidateDatabase: candidate,
        displacedDatabase: displaced,
        at: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    // The state a restarted executor actually wakes up in, and the reason the
    // assertion below is about a row coming into EXISTENCE rather than changing.
    expect(await container.recoveryRequests.byIdUnscoped(orphan)).toBeNull();

    await container.recoveryExecutor.tick();

    const row = await container.recoveryRequests.byIdUnscoped(orphan);
    expect(row?.state).toBe('FAILED');
    expect(row?.stage).toBe('CLEANUP');
    expect(row?.failureCode).toBe('recovery.internal');
    // THE ROLLBACK, which is the one fact that must never be lost.
    expect(row?.displacedDatabase).toBe(displaced);
    expect(row?.candidateDatabase).toBe(candidate);
    // `RENAMED` means both renames completed, so production IS the candidate —
    // and `cutover_at` is what keeps this row for ever rather than letting
    // retention purge it.
    expect(row?.cutoverAt).toBeInstanceOf(Date);

    // The journal is cleared once the facts are somewhere an operator reads them,
    // so the next tick does not report the same cutover again.
    expect(await readdir(recoveryRoot)).not.toContain(`cutover-${orphan}.json`);
  });

  it('reconstructs a cutover that renamed the outgoing database and stopped there', async () => {
    /*
     * The OTHER journal phase, and the one no constraint would let the executor
     * record.
     *
     * `ALTER DATABASE` cannot run in a transaction, so a cutover that renamed the
     * outgoing database and then failed to rename the candidate into place ends
     * with the displaced name known and NO cutover performed — journal phase
     * `RENAMED_OUT`, `CutoverError.outgoingRenamed`. The reconstruction writes
     * exactly that row, and `recovery_requests_cutover_check` refused it while it
     * read `(cutover_at IS NULL) = (displaced_database IS NULL)`: the insert
     * raised 23514, so the recovery was recorded NOWHERE, the journal was never
     * cleared, and every later tick threw inside `reconcileCutovers` — which runs
     * before `reclaimAbandoned` and before any claim, so the executor could never
     * take another recovery for the life of the process.
     *
     * Reachable without anybody making a mistake: a `psql` that loses its
     * connection after the server committed the second rename reports failure for
     * a rename that happened, which leaves the live name served by the candidate
     * and this journal on disk.
     */
    const orphan = '01900000-0000-7000-8000-0000000000c9';
    const displaced = 'nexa_pre_restore_orphanc9';
    const candidate = 'nexa_candidate_orphanc9';
    const { writeFile, readdir } = await import('node:fs/promises');
    await writeFile(
      join(recoveryRoot, `cutover-${orphan}.json`),
      JSON.stringify({
        recoveryId: orphan,
        phase: 'RENAMED_OUT',
        liveDatabase: liveName,
        candidateDatabase: candidate,
        displacedDatabase: displaced,
        at: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    expect(await container.recoveryRequests.byIdUnscoped(orphan)).toBeNull();

    await container.recoveryExecutor.tick();

    const row = await container.recoveryRequests.byIdUnscoped(orphan);
    expect(row?.state).toBe('FAILED');
    expect(row?.stage).toBe('CLEANUP');
    // THE ROLLBACK. The operator's previous data is under this name and nothing
    // else on the installation says so.
    expect(row?.displacedDatabase).toBe(displaced);
    expect(row?.candidateDatabase).toBe(candidate);
    // And NOT a cutover: production is not the candidate, nothing bears the live
    // name, and a `cutover_at` here would tell an operator the restore is serving.
    expect(row?.cutoverAt).toBeNull();

    // Cleared, which is what stops the next tick reporting the same cutover — and
    // which never happened while the write above was refused.
    expect(await readdir(recoveryRoot)).not.toContain(`cutover-${orphan}.json`);

    // The tick went on to do its other work rather than dying at the top of it.
    // `reconcileCutovers` runs before `reclaimAbandoned` and before any claim, so
    // a throw in it is an executor that claims nothing ever again.
    expect(container.recoveryExecutor.isFresh(container.clock.now().getTime())).toBe(true);
  });
});
