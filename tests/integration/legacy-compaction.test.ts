import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  LEGACY_COMPACTION_ARCHIVE_TITLE,
  LEGACY_COMPACTION_CONFIRMATION_PHRASE,
  PLATFORM_ERROR_CODES,
} from '@nexa/contracts';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  testAppDatabaseUrl,
  testConfig,
  type TestContext,
} from './harness';
import { LegacyCompactionExecutor } from '../../apps/api/src/modules/platform/legacy-compaction/application/legacy-compaction.executor';
import {
  DrizzleLegacyCompactionRepository,
  ownerMaintenanceConnector,
  type MaintenanceConnector,
} from '../../apps/api/src/modules/platform/legacy-compaction/infrastructure/drizzle-legacy-compaction.repository';
import { createDatabase } from '../../apps/api/src/infrastructure/persistence/database';
import { lockLegacyImportExclusion } from '../../apps/api/src/infrastructure/persistence/legacy-import-exclusion';
import type { BackupRunPartRow } from '../../apps/api/src/modules/platform/backup/application/ports';

/**
 * Round 4 PR-E (E1): the legacy-data compaction against PostgreSQL.
 *
 * The backup pipeline is substituted (the real one is `backup-parts.test.ts`'s); what is
 * asserted here is the ORDER — nothing is deleted unless the archive's every part has a
 * message id — the read map's drop list, the dedup's twin rule, the strip, the report and
 * the one audit row per batch.
 */

type Rec = Record<string, unknown>;

/** PR-L: the cleanup's VACUUM session, as the tables' owner (production's wiring). */
const ownerVacuum = () =>
  ownerMaintenanceConnector(testConfig().DATABASE_URL, { lockTimeoutMs: 5_000 });

/** v0.9.7: the import's recorded balance reconciliation, clean (the cleanup's precondition). */
const CLEAN_REPORT = JSON.stringify({
  balanceReconciliation: {
    verdict: 'RECONCILED',
    differences: { BALANCE_DIFFERS: 0, MISSING_IN_NEXA: 0, AGENT_CREDIT_IN_WALLET: 0 },
  },
});

describe('the legacy data compaction (E1)', () => {
  let ctx: TestContext;
  let ownerActor: ReturnType<typeof adminActorFor>;
  let importId: string;
  /** What the executor logged as failing: a test that sees it can say why. */
  const errors: string[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  const q = async <T extends Rec>(query: ReturnType<typeof sql>): Promise<T[]> =>
    (await ctx.container.database.db.execute<T>(query)).rows as T[];

  async function history(type: string, payload: Rec): Promise<string> {
    const id = randomUUID();
    await ctx.container.database.db.execute(sql`
      INSERT INTO legacy_history_records
        (id, tenant_id, nxpkg_import_id, package_import_id, record_type, idempotency_key, payload, created_at)
      VALUES (${id}::uuid, ${tenantA.tenantId}::uuid, ${importId}::uuid, 'pkg-1', ${type},
              ${`legacy:${type}:${id}`}, ${JSON.stringify(payload)}::jsonb, now())`);
    return id;
  }

  /** A second import still in flight (VERIFYING), beside the completed one. */
  async function importInFlight(): Promise<string> {
    const id = randomUUID();
    await ctx.container.database.db.execute(sql`
      INSERT INTO legacy_nxpkg_imports
        (id, tenant_id, status, file_name, file_path, file_sha256, file_bytes,
         requested_by_admin_id, created_at, updated_at)
      SELECT ${id}::uuid, ${tenantA.tenantId}, 'VERIFYING', 'second.nxpkg', '/nonexistent/second',
             ${'c'.repeat(64)}, 1, requested_by_admin_id, now(), now()
        FROM legacy_nxpkg_imports WHERE id = ${importId}::uuid`);
    return id;
  }

  beforeEach(async () => {
    errors.length = 0;
    await ctx.reset();
    const owner = await createAdmin(ctx.container, tenantA, {
      username: 'owner-compaction',
      roleKeys: ['owner'],
    });
    ownerActor = adminActorFor(owner);
    importId = randomUUID();
    await ctx.container.database.db.execute(sql`
      INSERT INTO legacy_nxpkg_imports
        (id, tenant_id, status, file_name, file_path, file_sha256, file_bytes, package_import_id,
         requested_by_admin_id, approved_dry_run_sha256, approved_at, approved_by_admin_id,
         apply_report, finished_at, created_at, updated_at)
      VALUES (${importId}::uuid, ${tenantA.tenantId}, 'COMPLETED', 'synthetic.nxpkg',
              '/nonexistent/synthetic.nxpkg', ${'a'.repeat(64)}, 1, 'pkg-1', ${owner.id},
              ${'b'.repeat(64)}, now(), ${owner.id}, ${CLEAN_REPORT}::jsonb, now(), now(), now())`);
  });

  function executor(input: {
    parts: readonly Partial<BackupRunPartRow>[];
    backupState?: 'SUCCEEDED' | 'FAILED';
    /** The failed archive backup's failure code, as its run row carries it. */
    backupFailureCode?: string;
    /** Runs inside the substituted backup, before it answers (a long or failing archive). */
    during?: () => Promise<void>;
    heartbeatIntervalMs?: number;
    /** PR-L: the VACUUM session (default: as the tables' owner, production's wiring). */
    maintenance?: MaintenanceConnector;
    batchSize?: number;
  }): { executor: LegacyCompactionExecutor; titles: string[] } {
    const titles: string[] = [];
    const backupId = randomUUID();
    const c = ctx.container;
    return {
      titles,
      executor: new LegacyCompactionExecutor({
        repository: new DrizzleLegacyCompactionRepository(
          c.database.db,
          input.maintenance ?? ownerVacuum(),
        ),
        uow: c.uow,
        audit: c.audit,
        opsLog: c.opsLog,
        scopeActivity: c.tenants,
        clock: c.clock,
        backup: {
          run: async (_trigger, options) => {
            titles.push(options.title);
            await input.during?.();
            return {
              kind: 'COMPLETED',
              run: {
                id: backupId,
                state: input.backupState ?? 'SUCCEEDED',
                verifiedAt: input.backupState === 'FAILED' ? null : new Date(),
                failureCode: input.backupFailureCode ?? null,
              },
            } as never;
          },
        },
        backupParts: async () =>
          input.parts.map((part, index) => ({
            backupId,
            partNumber: index + 1,
            filename: `a.7z.${String(index + 1).padStart(3, '0')}`,
            bytes: 1n,
            sha256: 'a'.repeat(64),
            deliveryState: 'SUCCEEDED',
            deliveryAttemptedAt: new Date(),
            telegramMessageId: 1n,
            deliveryDetail: null,
            ...part,
          })),
        quiesced: async () => false,
        actor: () => ({
          type: 'SYSTEM_JOB',
          id: null,
          label: 'legacy-compaction',
          surface: 'WORKER',
          correlationId: 'compaction-test' as never,
        }),
        leaseOwner: 'test:compaction',
        batchSize: input.batchSize ?? 2,
        tickIntervalMs: 60_000,
        ...(input.heartbeatIntervalMs === undefined
          ? {}
          : { heartbeatIntervalMs: input.heartbeatIntervalMs }),
        logger: {
          info() {},
          warn() {},
          error(context: Record<string, unknown>) {
            errors.push(JSON.stringify(context['err']));
          },
        },
      }),
    };
  }

  async function request(): Promise<void> {
    await ctx.container.legacyCompaction.request(tenantA, ownerActor, {
      idempotencyKey: randomUUID(),
      phrase: LEGACY_COMPACTION_CONFIRMATION_PHRASE,
    });
  }

  const ids = async (): Promise<Set<string>> =>
    new Set(
      (await q<{ id: string }>(sql`SELECT id FROM legacy_history_records`)).map((row) => row.id),
    );

  it('refuses the wrong phrase, an import still running, and a second compaction', async () => {
    await expect(
      ctx.container.legacyCompaction.request(tenantA, ownerActor, {
        idempotencyKey: randomUUID(),
        phrase: 'compact legacy data',
      }),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.LEGACY_COMPACTION_PHRASE_INVALID });
    const second = await importInFlight();
    await expect(request()).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.LEGACY_COMPACTION_UNAVAILABLE,
    });
    // The second import ends (an import row is never deleted): the precondition holds again.
    await ctx.container.database.db.execute(sql`
      UPDATE legacy_nxpkg_imports SET status = 'CANCELLED', error_code = 'IMPORT_FAILED',
             finished_at = now() WHERE id = ${second}::uuid`);
    await request();
    await expect(request()).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.LEGACY_COMPACTION_ACTIVE,
    });
  });

  it('deletes NOTHING when a part of the archive has no message id', async () => {
    const dropped = await history('panel_target', { a: 1 });
    await request();
    const { executor: run } = executor({ parts: [{}, { telegramMessageId: null }] });
    const ended = await run.tick();
    expect(ended?.state).toBe('FAILED');
    expect(ended?.failureCode).toBe('legacy_compaction.archive_not_delivered');
    expect((await ids()).has(dropped)).toBe(true);
  });

  it('deletes NOTHING when the archive backup failed', async () => {
    const dropped = await history('agent_log', { a: 1 });
    await request();
    const { executor: run } = executor({ parts: [{}], backupState: 'FAILED' });
    expect((await run.tick())?.failureCode).toBe('legacy_compaction.archive_failed');
    expect((await ids()).has(dropped)).toBe(true);
  });

  it.each(['backup.tool_oom_killed', 'backup.memory_insufficient'])(
    'names a memory failure of the archive backup (%s) and deletes NOTHING',
    async (failureCode) => {
      const dropped = await history('agent_log', { a: 1 });
      await request();
      const { executor: run } = executor({
        parts: [{}],
        backupState: 'FAILED',
        backupFailureCode: failureCode,
      });
      expect((await run.tick())?.failureCode).toBe('legacy_compaction.archive_out_of_memory');
      expect((await ids()).has(dropped)).toBe(true);
    },
  );

  it('archives first, then drops unread types, dedups invoice twins, strips flags, and reports', async () => {
    const drop1 = await history('panel_target', { x: 1 });
    const drop2 = await history('configuration_row', { x: 2 });
    const drop3 = await history('support_department', { x: 3 });
    // Read types the owner listed: KEPT.
    const keptOwnership = await history('service_ownership', {
      invoice_key: 'i9',
      affects_wallet: false,
    });
    const keptCheck = await history('wallet_history_check', { verdict: 'OK' });
    // An invoice archive row with a twin in legacy_invoice_archive: deduped.
    const twin = await history('archive_row', {
      provenance: { source_table: 'invoice', source_pk: 'inv-1' },
    });
    // One without a twin, and one of another table: kept.
    const noTwin = await history('archive_row', {
      provenance: { source_table: 'invoice', source_pk: 'inv-404' },
    });
    const otherTable = await history('archive_row', {
      provenance: { source_table: 'user', source_pk: 'inv-1' },
    });
    // A payment with constant flags and *_raw / *_note fields.
    const payment = await history('payment', {
      schema: 'mirza.payment_report.v1',
      affects_wallet: false,
      creates_payment: false,
      amount_raw: '1000',
      price_note: 'OK',
      nested: { affects_wallet: false },
    });
    await insertInvoiceTwin('inv-1');

    await request();
    const { executor: run, titles } = executor({ parts: [{}, {}] });
    const ended = await run.tick();
    expect(errors).toEqual([]);
    expect(titles).toEqual([LEGACY_COMPACTION_ARCHIVE_TITLE]);
    expect(ended?.state).toBe('COMPLETED');

    const left = await ids();
    for (const gone of [drop1, drop2, drop3, twin]) expect(left.has(gone)).toBe(false);
    for (const kept of [keptOwnership, keptCheck, noTwin, otherTable, payment]) {
      expect(left.has(kept)).toBe(true);
    }
    const [paid] = await q<{ payload: Rec }>(
      sql`SELECT payload FROM legacy_history_records WHERE id = ${payment}::uuid`,
    );
    expect(paid?.payload).toEqual({
      schema: 'mirza.payment_report.v1',
      amount_raw: '1000',
      price_note: 'OK',
      nested: { affects_wallet: false },
    });

    expect(ended?.deleted).toBe(3n);
    expect(ended?.deduplicated).toBe(1n);
    expect(ended?.stripped).toBe(2n);
    expect(ended?.before?.recordTypes['panel_target']).toBe(1);
    expect(ended?.after?.recordTypes['panel_target']).toBeUndefined();
    expect(Number(ended?.after?.tables['legacy_history_records'])).toBeGreaterThan(0);

    // One audit row per BATCH (batch size 2): 1 dedup (it runs FIRST, PR-L), 3 dropped →
    // 2 batches, 2 stripped → 1, and the vacuum's proof.
    const batches = await q<{ after: Rec }>(
      sql`SELECT after FROM audit_logs WHERE action = 'legacy.compaction.batch' ORDER BY occurred_at, id`,
    );
    expect(batches.map((row) => row.after['stage'])).toEqual([
      'DEDUPING',
      'DROPPING',
      'DROPPING',
      'STRIPPING',
      'VACUUMING',
    ]);
    expect(batches.at(-1)?.after['tables']).toEqual([
      'legacy_history_records',
      'legacy_trial_eligibility',
      'legacy_service_candidates',
      'legacy_import_map',
      'legacy_invoice_archive_staging',
    ]);
    expect(ended?.vacuumedAt).not.toBeNull();
  }, 120_000);

  it('resumes after the last committed batch, without redoing it', async () => {
    for (let index = 0; index < 5; index += 1) await history('agent_usage', { n: index });
    await request();
    const repository = new DrizzleLegacyCompactionRepository(
      ctx.container.database.db,
      ownerVacuum(),
    );
    // A worker that claimed, archived and measured, then died after one batch.
    const { executor: first } = executor({ parts: [{}] });
    const claimed = await repository.claim({
      leaseOwner: 'test:compaction',
      now: new Date(),
      staleBefore: new Date(0),
    });
    if (claimed === null) throw new Error('nothing to claim');
    await repository.advance({
      id: claimed.id,
      leaseOwner: 'test:compaction',
      from: 'REQUESTED',
      to: 'DROPPING',
      now: new Date(),
      archiveBackupId: randomUUID(),
      before: { tables: {}, recordTypes: {} },
    });
    const ended = await first.tick();
    expect(ended?.state).toBe('COMPLETED');
    expect(ended?.deleted).toBe(5n);
    expect((await ids()).size).toBe(0);
  }, 120_000);

  it('keeps the archive append-only for everyone else: no run named, or one not deleting', async () => {
    const row = await history('agent_log', { a: 1 });
    const db = ctx.container.database.db;
    await expect(
      db.execute(sql`DELETE FROM legacy_history_records WHERE id = ${row}::uuid`),
    ).rejects.toThrow();
    await request();
    const [run] = await q<{ id: string }>(sql`SELECT id FROM legacy_compaction_runs`);
    // A REQUESTED run (the archive not yet delivered) authorises nothing.
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('nexa.legacy_compaction_run', ${run?.id ?? ''}, true)`,
        );
        await tx.execute(sql`DELETE FROM legacy_history_records WHERE id = ${row}::uuid`);
      }),
    ).rejects.toThrow();
    // A run in DROPPING authorises a delete, and an UPDATE of the payload only.
    await db.execute(
      sql`UPDATE legacy_compaction_runs SET state = 'DROPPING' WHERE id = ${run?.id ?? ''}::uuid`,
    );
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('nexa.legacy_compaction_run', ${run?.id ?? ''}, true)`,
        );
        await tx.execute(
          sql`UPDATE legacy_history_records SET record_type = 'payment' WHERE id = ${row}::uuid`,
        );
      }),
    ).rejects.toThrow();
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('nexa.legacy_compaction_run', ${run?.id ?? ''}, true)`,
      );
      await tx.execute(sql`DELETE FROM legacy_history_records WHERE id = ${row}::uuid`);
    });
    expect((await ids()).has(row)).toBe(false);
  });

  /*
   * Review of #300: the lease during a long stage, a lease another replica took over, a stage
   * that keeps failing, and the exclusion with an import for the run's whole lifetime.
   */
  const leaseOf = async (): Promise<{ owner: string | null; beat: Date; state: string }> => {
    const [row] = await q<{ lease_owner: string | null; lease_heartbeat_at: Date; state: string }>(
      sql`SELECT lease_owner, lease_heartbeat_at, state FROM legacy_compaction_runs`,
    );
    if (row === undefined) throw new Error('no compaction run');
    return { owner: row.lease_owner, beat: new Date(row.lease_heartbeat_at), state: row.state };
  };
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('keeps its lease alive while the archive backup runs, however long it takes', async () => {
    await history('agent_log', { a: 1 });
    await request();
    let during: Date | null = null;
    const { executor: run } = executor({
      parts: [{}],
      heartbeatIntervalMs: 20,
      during: async () => {
        // As if the lease had gone stale mid-backup; the heartbeat must bring it back.
        await ctx.container.database.db.execute(
          sql`UPDATE legacy_compaction_runs SET lease_heartbeat_at = 'epoch'`,
        );
        await pause(200);
        during = (await leaseOf()).beat;
      },
    });
    const ended = await run.tick();
    expect(ended?.state).toBe('COMPLETED');
    expect(during).not.toBeNull();
    expect((during as Date | null)?.getTime() ?? 0).toBeGreaterThan(0);
  });

  it('stops driving a run whose lease another replica took over, and takes no second archive', async () => {
    const kept = await history('agent_log', { a: 1 });
    await request();
    const { executor: run, titles } = executor({
      parts: [{}],
      during: async () => {
        await ctx.container.database.db.execute(
          sql`UPDATE legacy_compaction_runs SET lease_owner = 'test:other-replica'`,
        );
      },
    });
    const ended = await run.tick();
    expect(ended?.state).toBe('ARCHIVING');
    expect(titles).toHaveLength(1);
    expect(await leaseOf()).toMatchObject({ owner: 'test:other-replica', state: 'ARCHIVING' });
    expect((await ids()).has(kept)).toBe(true);
  });

  it('fails a stage that keeps failing as step_failed, rather than retrying it for ever', async () => {
    const kept = await history('agent_log', { a: 1 });
    await request();
    const { executor: run } = executor({
      parts: [{}],
      during: async () => {
        throw new Error('no space left on device');
      },
    });
    expect((await run.tick())?.state).toBe('ARCHIVING');
    expect((await run.tick())?.state).toBe('ARCHIVING');
    const ended = await run.tick();
    expect(ended?.state).toBe('FAILED');
    expect(ended?.failureCode).toBe('legacy_compaction.step_failed');
    expect((await ids()).has(kept)).toBe(true);
  });

  it('refuses a new import for the whole life of a compaction, and accepts one after it', async () => {
    await request();
    const [admin] = await q<{ id: string }>(
      sql`SELECT requested_by_admin_id AS id FROM legacy_nxpkg_imports LIMIT 1`,
    );
    const newImport = () =>
      ctx.container.legacyNxpkgImports.insert({
        id: randomUUID(),
        tenantId: tenantA.tenantId,
        fileName: 'later.nxpkg',
        filePath: '/nonexistent/later.nxpkg',
        fileSha256: 'd'.repeat(64),
        fileBytes: 1n,
        requestedByAdminId: admin?.id ?? '',
        now: new Date(),
      });
    await expect(newImport()).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.LEGACY_COMPACTION_ACTIVE,
    });
    // Past REQUESTED, into the deleting stages: still refused.
    await ctx.container.database.db.execute(
      sql`UPDATE legacy_compaction_runs SET state = 'DROPPING'`,
    );
    await expect(newImport()).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.LEGACY_COMPACTION_ACTIVE,
    });
    await ctx.container.database.db.execute(
      sql`UPDATE legacy_compaction_runs SET state = 'COMPLETED', finished_at = now(),
                                            vacuumed_at = now()`,
    );
    await expect(newImport()).resolves.toMatchObject({ status: 'UPLOADED' });
  });

  it('decides its start in one transaction: an import that began first fails the run', async () => {
    const kept = await history('agent_log', { a: 1 });
    await request();
    // An import row that got in before the compaction's start (the request's own check
    // passed earlier): the start, decided under the lock, sees it and stops.
    await importInFlight();
    const { executor: run, titles } = executor({ parts: [{}] });
    const ended = await run.tick();
    expect(ended?.state).toBe('FAILED');
    expect(ended?.failureCode).toBe('legacy_compaction.import_not_completed');
    expect(titles).toHaveLength(0);
    expect((await ids()).has(kept)).toBe(true);
  });

  /** Holds the shared per-tenant lock in another transaction until `release` is called. */
  async function holdImportLock(): Promise<{ release: () => Promise<void> }> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const done = ctx.container.database.db.transaction(async (tx) => {
      await lockLegacyImportExclusion(tx, tenantA.tenantId);
      held();
      await released;
    });
    await holding;
    return {
      release: async () => {
        release();
        await done;
      },
    };
  }
  const settledWithin = async (work: Promise<unknown>, ms: number): Promise<boolean> =>
    Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      pause(ms).then(() => false),
    ]);

  it('an import start and a compaction start both wait on the same per-tenant lock', async () => {
    await request();
    const [run] = await q<{ id: string }>(sql`SELECT id FROM legacy_compaction_runs`);
    const repository = new DrizzleLegacyCompactionRepository(
      ctx.container.database.db,
      ownerVacuum(),
    );
    await repository.claim({
      leaseOwner: 'test:compaction',
      now: new Date(),
      staleBefore: new Date(0),
    });

    const lock = await holdImportLock();
    const begin = repository.beginArchiving({
      id: run?.id ?? '',
      tenantId: tenantA.tenantId,
      leaseOwner: 'test:compaction',
      now: new Date(),
    });
    expect(await settledWithin(begin, 300)).toBe(false);
    await lock.release();
    await expect(begin).resolves.toBe('ADVANCED');

    const [admin] = await q<{ id: string }>(
      sql`SELECT requested_by_admin_id AS id FROM legacy_nxpkg_imports LIMIT 1`,
    );
    const second = await holdImportLock();
    const insert = ctx.container.legacyNxpkgImports.insert({
      id: randomUUID(),
      tenantId: tenantA.tenantId,
      fileName: 'later.nxpkg',
      filePath: '/nonexistent/later.nxpkg',
      fileSha256: 'd'.repeat(64),
      fileBytes: 1n,
      requestedByAdminId: admin?.id ?? '',
      now: new Date(),
    });
    expect(await settledWithin(insert, 300)).toBe(false);
    await second.release();
    await expect(insert).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.LEGACY_COMPACTION_ACTIVE,
    });
  });

  it('vacuums on its own connection, whatever the pool statement timeout is', async () => {
    // Enough rows that a VACUUM FULL takes far longer than the 50 ms the pool allows.
    await ctx.container.database.db.execute(sql`
      INSERT INTO legacy_history_records
        (id, tenant_id, nxpkg_import_id, package_import_id, record_type, idempotency_key, payload, created_at)
      SELECT u, ${tenantA.tenantId}::uuid, ${importId}::uuid, 'pkg-1', 'agent_log',
             'legacy:agent_log:' || u, jsonb_build_object('n', g, 'pad', repeat('x', 200)), now()
        FROM (SELECT gen_random_uuid() AS u, g FROM generate_series(1, 150000) AS g) AS s`);
    const tiny = createDatabase(testConfig().DATABASE_URL, 2, {
      statementTimeoutMs: 50,
      lockTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 60_000,
    });
    try {
      const repository = new DrizzleLegacyCompactionRepository(tiny.db, ownerVacuum());
      await expect(repository.vacuum()).resolves.toMatchObject({
        tables: expect.arrayContaining(['legacy_history_records']) as unknown,
      });
      // The unlimited timeout never reached the pool: a checkout still has 50ms.
      const shown = await tiny.pool.query<{ statement_timeout: string }>('SHOW statement_timeout');
      expect(shown.rows[0]?.statement_timeout).toBe('50ms');
      // And the same VACUUM through the ordinary path IS cancelled: the test has teeth.
      await expect(tiny.db.execute(sql`VACUUM (FULL) legacy_history_records`)).rejects.toThrow();
    } finally {
      await tiny.pool.end();
    }
  }, 120_000);

  // --- PR-L ---------------------------------------------------------------------------------

  /** Typed record `type` of Mirza `table` row `pk`, as the converter writes its provenance. */
  const typed = (type: string, table: string, pk: string, extra: Rec = {}) =>
    history(type, { provenance: { source_table: table, source_pk: pk }, ...extra });
  /** The raw `archive_row` copy of Mirza `table` row `pk`. */
  const raw = (table: string, pk: string) =>
    history('archive_row', {
      schema: 'mirza.archive_row.v1',
      provenance: { source_table: table, source_pk: pk },
      fields_raw: { id: pk },
    });

  it('dedupes an archive row only against a typed twin of the same table and key (L2, L3)', async () => {
    const gone: string[] = [];
    const kept: string[] = [];
    // Every owner pair: a raw copy WITH its twin goes, one WITHOUT stays.
    for (const [table, type] of [
      ['Payment_report', 'payment'],
      ['service_other', 'service_operation'],
      ['reagent_report', 'referral'],
      ['wallet_transaction', 'wallet_transaction'],
      ['discount_sell_used', 'discount_usage'],
    ] as const) {
      await typed(type, table, '1');
      gone.push(await raw(table, '1'));
      kept.push(await raw(table, '2'));
    }
    // The TYPE alone is no twin: `discount_usage` also carries `Giftcodeconsumed` rows.
    await typed('discount_usage', 'Giftcodeconsumed', '9');
    kept.push(await raw('discount_sell_used', '9'));
    // Exact spelling: `Requestagent` and `requestagent` are two tables. The twin's type is
    // DROPPED afterwards, and still proves its raw copy redundant (DEDUPING runs first).
    const agentRequest = await typed('agent_request', 'Requestagent', '7');
    gone.push(await raw('Requestagent', '7'));
    kept.push(await raw('requestagent', '7'));
    // A twin of another tenant's is no twin; a raw row of a table with no pair stays.
    kept.push(await raw('Payment_report', '3'));
    kept.push(await raw('user', '1'));
    // L3: no lucky wheel. Its typed spins and every raw `wheel_list` row go, twin or not.
    const spin = await typed('wheel_result', 'wheel_list', '1');
    gone.push(await raw('wheel_list', '1'), await raw('wheel_list', '404'), spin, agentRequest);

    await request();
    const { executor: run } = executor({ parts: [{}] });
    const ended = await run.tick();
    expect(errors).toEqual([]);
    expect(ended?.state).toBe('COMPLETED');
    const left = await ids();
    for (const id of gone) expect(left.has(id), id).toBe(false);
    for (const id of kept) expect(left.has(id), id).toBe(true);
    // 5 owner pairs, Requestagent and the wheel_list row with its spin deduped (DEDUPING runs
    // first); the twinless wheel_list row, the spin and the request dropped.
    expect(ended?.deduplicated).toBe(7n);
    expect(ended?.deleted).toBe(3n);
  }, 120_000);

  it('gives the space back: after (measured after VACUUM FULL) is smaller than before (L1, L2)', async () => {
    // The size probe of the PR: LEGACY_DEDUPE_SIZE_ROWS=200000 for the PR's numbers.
    const rows = Number(process.env['LEGACY_DEDUPE_SIZE_ROWS'] ?? '4000');
    const pad = (n: number) => sql`repeat('x', ${n})`;
    // Typed payments and their raw `Payment_report` copies (≈ a Mirza row each), plus a
    // tenth more raw rows that have NO twin and stay.
    await ctx.container.database.db.execute(sql`
      INSERT INTO legacy_history_records
        (id, tenant_id, nxpkg_import_id, package_import_id, record_type, idempotency_key, payload, created_at)
      SELECT gen_random_uuid(), ${tenantA.tenantId}::uuid, ${importId}::uuid, 'pkg-1', kind,
             'legacy:' || kind || ':' || g, jsonb_build_object(
               'schema', 'mirza.' || kind || '.v1',
               'provenance', jsonb_build_object('source_table', 'Payment_report', 'source_pk', g::text),
               'fields_raw', jsonb_build_object('id_user', g, 'price', g * 1000, 'note', ${pad(400)})),
             now()
        FROM generate_series(1, ${rows}) AS g, (VALUES ('payment'), ('archive_row')) AS k(kind)`);
    await ctx.container.database.db.execute(sql`
      INSERT INTO legacy_history_records
        (id, tenant_id, nxpkg_import_id, package_import_id, record_type, idempotency_key, payload, created_at)
      SELECT gen_random_uuid(), ${tenantA.tenantId}::uuid, ${importId}::uuid, 'pkg-1', 'archive_row',
             'legacy:orphan:' || g, jsonb_build_object(
               'provenance', jsonb_build_object('source_table', 'Payment_report', 'source_pk', 'x' || g),
               'fields_raw', jsonb_build_object('note', ${pad(400)})), now()
        FROM generate_series(1, ${Math.ceil(rows / 10)}) AS g`);
    await request();
    const { executor: run } = executor({ parts: [{}], batchSize: 5000 });
    const ended = await run.tick();
    expect(errors).toEqual([]);
    expect(ended?.state).toBe('COMPLETED');
    expect(ended?.deduplicated).toBe(BigInt(rows));
    expect(ended?.vacuumedAt).not.toBeNull();
    const before = Number(ended?.before?.tables['legacy_history_records']);
    const after = Number(ended?.after?.tables['legacy_history_records']);
    // Without a real VACUUM FULL the relation keeps every page: after === before, byte for
    // byte, as on the owner's server.
    expect(after).toBeLessThan(before * 0.75);
    expect(ended?.after?.recordTypes['archive_row']).toBe(Math.ceil(rows / 10));
    if (process.env['LEGACY_DEDUPE_SIZE_ROWS'] !== undefined) {
      process.stderr.write(
        `size probe: rows=${String(rows)} history ${String(before)} → ${String(after)} bytes\n`,
      );
    }
  }, 600_000);

  it('FAILS before deleting anything a run whose session may not maintain the tables (nexa_app)', async () => {
    const dropped = await history('agent_log', { a: 1 });
    await request();
    // The application's role owns no table: PostgreSQL 16 answers its VACUUM / ANALYZE with
    // a WARNING and success. That is the owner's v0.9.13 run, which COMPLETED having vacuumed
    // nothing. Now it is found at MEASURING, before the first delete.
    const { executor: run } = executor({
      parts: [{}],
      maintenance: ownerMaintenanceConnector(testAppDatabaseUrl(), { lockTimeoutMs: 5_000 }),
    });
    const ended = await run.tick();
    expect(ended?.state).toBe('FAILED');
    expect(ended?.failureCode).toBe('legacy_compaction.vacuum_failed');
    expect(ended?.vacuumedAt).toBeNull();
    expect((await ids()).has(dropped)).toBe(true);
  }, 120_000);

  it('FAILS, never completes, a run whose VACUUM answers with a WARNING and does nothing', async () => {
    const dropped = await history('agent_log', { a: 1 });
    await request();
    // PostgreSQL's answer to a VACUUM it skips, replayed: a WARNING, then success.
    const owner = ownerVacuum();
    const skipping: MaintenanceConnector = {
      async connect() {
        const session = await owner.connect();
        const listeners: ((n: { severity: string; message: string }) => void)[] = [];
        session.onNotice((n) => {
          for (const l of listeners) l(n);
        });
        return {
          ...session,
          onNotice: (listener) => listeners.push(listener),
          query: async (text, values) => {
            if (!text.startsWith('VACUUM')) return session.query(text, values);
            for (const l of listeners) l({ severity: 'WARNING', message: 'skipping it' });
            return { rows: [] };
          },
        };
      },
    };
    const { executor: run } = executor({ parts: [{}], maintenance: skipping });
    const ended = await run.tick();
    expect(ended?.state).toBe('FAILED');
    expect(ended?.failureCode).toBe('legacy_compaction.vacuum_failed');
    expect(ended?.vacuumedAt).toBeNull();
    expect(ended?.after).toBeNull();
    // The rows went before the vacuum (the archive holds them); the run says it did not finish.
    expect((await ids()).has(dropped)).toBe(false);
  }, 120_000);

  it('FAILS as vacuum_failed a vacuum that keeps hitting its lock timeout, after the retries', async () => {
    await request();
    const owner = ownerVacuum();
    const locked: MaintenanceConnector = {
      async connect() {
        const session = await owner.connect();
        return {
          ...session,
          query: (text, values) =>
            text.startsWith('VACUUM')
              ? Promise.reject(
                  Object.assign(new Error('canceling statement due to lock timeout'), {
                    code: '55P03',
                  }),
                )
              : session.query(text, values),
        };
      },
    };
    const { executor: run } = executor({ parts: [{}], maintenance: locked });
    expect((await run.tick())?.state).toBe('VACUUMING');
    expect((await run.tick())?.state).toBe('VACUUMING');
    const ended = await run.tick();
    expect(ended?.state).toBe('FAILED');
    expect(ended?.failureCode).toBe('legacy_compaction.vacuum_failed');
  }, 120_000);

  it('refuses, in the database, a run of the current rules COMPLETED without a proven vacuum', async () => {
    await request();
    await expect(
      ctx.container.database.db.execute(sql`
        UPDATE legacy_compaction_runs SET state = 'COMPLETED', finished_at = now(), revision = 2`),
    ).rejects.toMatchObject({
      cause: { constraint: 'legacy_compaction_runs_vacuum_proven_check' },
    });
  });

  /** A valid `legacy_invoice_archive` row (the fixture `legacy-customer-invoices.test.ts` uses). */
  async function insertInvoiceTwin(invoiceKey: string): Promise<void> {
    const HASH = 'a'.repeat(64);
    const run = randomUUID();
    const db = ctx.container.database.db;
    await db.execute(sql`
      INSERT INTO legacy_invoice_archive_runs (id, tenant_id, state, read_set_version,
        read_set_fingerprint, source_fingerprint, source_schema_hash, source_engine, synthetic,
        source_invoice_rows, source_user_rows, source_product_rows, promoted_rows, inserted_new,
        missing_in_snapshot, archive_invoices_after, started_at, verified_at, finished_at,
        updated_at)
      VALUES (${run}, ${tenantA.tenantId}, 'COMPLETED', 1, ${HASH}, ${HASH}, ${HASH},
        'SYNTHETIC_FIXTURE', true, 0, 0, 0, 0, 0, 0, 0, now(), now(), now(), now())`);
    await db.execute(sql`
      INSERT INTO legacy_invoice_archive (id, tenant_id, run_id, invoice_key, revision,
        revision_reason, key_shape_evidenced, raw_row, row_checksum, archive_checksum,
        classification, live, status, is_test, legacy_user_id, owner_present, username,
        panel_code, product_code, product_ref, product_name, price_raw, price_minor,
        price_currency, price_note, sold_at_raw, sold_at, sold_at_note, read_set_fingerprint,
        source_fingerprint, normalization_version, archived_at)
      VALUES (${randomUUID()}, ${tenantA.tenantId}, ${run}, ${invoiceKey}, 1, 'FIRST_SEEN', true,
        jsonb_build_object('id_invoice', ${invoiceKey}::text), ${HASH}, ${HASH}, 'LIVE_CANDIDATE',
        true, 'active', false, '7000000101', true, 'syn_user', 'rp1', NULL, 'NONE', 'synthetic',
        '150000', 150000, 'IRT', NULL, '1700000000', to_timestamp(1700000000), NULL, ${HASH},
        ${HASH}, 'legacy-invoice-archive:v1', now())`);
  }
});
