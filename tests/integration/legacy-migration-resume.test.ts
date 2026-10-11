import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemJobActor, type CorrelationId } from '@nexa/contracts';
import { LegacyMigrationStepFailure } from '../../apps/api/src/modules/platform/legacy-migration/application/ports';
import { NxpkgMigrationAdapters } from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/nxpkg-migration-adapters';
import {
  MigrationRig,
  TENANT,
  generateDataset,
  moneyOfSnapshot,
  ownershipRecord,
  paymentRecords,
  overriding,
  rigExecutor,
  withAfterPhase,
  writeMigrationPackage,
  type GeneratedDataset,
  type MigrationPackage,
} from '../support/legacy-migration-rig';
import { createTestContext, tenantA, type TestContext } from './harness';

/**
 * Mirza `.nxpkg` Fresh Migration — interruption, resume and rerun, through the `migration`
 * role's executor with its REAL ports over PostgreSQL and two fake RickPanels.
 *
 * The reference is an UNINTERRUPTED run of the same package into a fresh tenant: every
 * interrupted run below must end in exactly that state, keyed by legacy identity (customers
 * by Telegram id, openings by reference and amount, debts, services by panel account and
 * owner, history by idempotency key, the import map and the service candidates), with one
 * completed APPLY run, zero provider writes and no decrypted step directory left.
 *
 * Interruptions: an importer phase boundary (the importer's own `afterPhase` seam); the
 * middle of a batch (a PostgreSQL trigger that raises inside the Nth row's transaction, so a
 * committed prefix and a rolled-back batch are both real); between the importer finishing
 * and the executor's bookmark; inside the history ingest; inside reconcile; and a worker
 * that died holding its lease (taken over only after the lease expires).
 *
 * SYNTHETIC data only (`tests/support/legacy-migration-rig.ts`). NOT EVIDENCE.
 */

const USERS = 600;
const INVOICES = 400;

describe('legacy migration: interrupt, resume and rerun over a real package', () => {
  let ctx: TestContext;
  let work: string;
  let migrationRoot: string;
  let rig: MigrationRig;
  let generated: GeneratedDataset;
  let pkg: MigrationPackage;
  let reference: Record<string, string | number | null>;
  let keyAtBackup: string | null | undefined;

  const db = () => ctx.container.database.db;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'lmig-resume-'));
    migrationRoot = await mkdtemp(join(tmpdir(), 'lmig-resume-root-'));
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      LEGACY_MIGRATION_ENABLED: 'true',
      LEGACY_MIGRATION_WORK_DIR: migrationRoot,
      BACKUP_WORK_DIR: work,
    });
    rig = new MigrationRig(ctx, migrationRoot);
    generated = generateDataset({ users: USERS, invoices: INVOICES });
    pkg = await writeMigrationPackage(join(work, 'resume.nxpkg'), {
      dataset: generated.dataset,
      invoices: generated.invoices,
      history: { 'records/payments.jsonl': paymentRecords(generated.users) },
    });

    // The reference: one uninterrupted run.
    await rig.freshTenant(generated.liveAccounts);
    const executor = rigExecutor(ctx, {
      backup: {
        // The key is erased BEFORE the post-import backup, so no backup can hold it.
        runAfterImport: async () => {
          const rows = await db().execute<{ key: string | null }>(
            sql`SELECT key_ciphertext AS key FROM legacy_nxpkg_imports ORDER BY created_at DESC LIMIT 1`,
          );
          keyAtBackup = rows.rows[0]?.key ?? null;
          return { outcome: 'TAKEN', runId: null };
        },
      },
    });
    const id = await rig.prepare(pkg, executor);
    await executor.tick();
    const done = await rig.detail(id);
    expect(['COMPLETED', 'COMPLETED_WITH_DISCREPANCY'], JSON.stringify(done)).toContain(
      done.status,
    );
    reference = await rig.migratedState();
  }, 600_000);

  afterAll(async () => {
    await rig?.closePanels();
    await dropCrashTriggers();
    await ctx?.close();
    for (const dir of [work, migrationRoot]) await rm(dir, { recursive: true, force: true });
  });

  it('the reference run erased the package key before its post-import backup', () => {
    expect(keyAtBackup).toBeNull();
  });

  it('the reference run imports every user, opening, debt, live service and history line once', () => {
    const money = moneyOfSnapshot(pkg.parts);
    const live = generated.invoices.filter((i) => i.live).length;
    expect(reference).toMatchObject({
      customers: USERS,
      walletEntries: money.positive.count,
      ledgerSum: money.positive.sum.toString(),
      debts: money.negative.count,
      services: live,
      orders: live,
      ordersNonLegacy: 0,
      payments: 0,
      provisioningOperations: 0,
      history: pkg.historyLines,
      candidates: live,
      applyRuns: 1,
    });
  });

  // --- the crash triggers ---------------------------------------------------------------------

  /**
   * Arms a trigger that raises inside the transaction inserting the row that would make
   * `table` hold more than `after` rows of the tenant — a crash in the middle of a batch: the
   * batches before it are committed, the batch it is in rolls back.
   */
  async function armCrash(table: string, after: number): Promise<void> {
    await db().execute(
      sql.raw(`
      CREATE OR REPLACE FUNCTION lmig_test_crash_${table}() RETURNS trigger AS $$
      BEGIN
        IF (SELECT count(*) FROM ${table} WHERE tenant_id = NEW.tenant_id) >= ${String(after)} THEN
          RAISE EXCEPTION 'lmig test: simulated crash inside a ${table} batch';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS lmig_test_crash ON ${table};
      CREATE TRIGGER lmig_test_crash BEFORE INSERT ON ${table}
        FOR EACH ROW EXECUTE FUNCTION lmig_test_crash_${table}();`),
    );
  }

  const CRASH_TABLES = ['customers', 'wallet_entries', 'services', 'legacy_history_records'];
  async function dropCrashTriggers(): Promise<void> {
    if (ctx === undefined) return;
    for (const table of CRASH_TABLES) {
      await db().execute(sql.raw(`DROP TRIGGER IF EXISTS lmig_test_crash ON ${table}`));
      await db().execute(sql.raw(`DROP FUNCTION IF EXISTS lmig_test_crash_${table}()`));
    }
  }

  /** Ticks until the import is terminal (bounded), checking no step directory survives a tick. */
  async function tickToEnd(
    id: string,
    executor: { tick(): Promise<void> },
    max = 6,
  ): Promise<number> {
    for (let i = 1; i <= max; i += 1) {
      await executor.tick();
      expect(await rig.stepDirectories(id)).toEqual([]);
      const status = (await rig.detail(id)).status;
      if (status !== 'APPLYING' && status !== 'APPROVED') return i;
    }
    throw new Error('the import did not finish');
  }

  async function expectReferenceState(id: string): Promise<void> {
    const view = await rig.detail(id);
    // COMPLETED once the final report v2 verdict is read correctly (see the lifecycle suite);
    // either way never FAILED, and every count equal to the uninterrupted run.
    expect(['COMPLETED', 'COMPLETED_WITH_DISCREPANCY'], JSON.stringify(view)).toContain(
      view.status,
    );
    expect(view.progress.reconcileVerdict).toBe('RECONCILED');
    expect(await rig.migratedState()).toEqual(reference);
    // No invoice became two services; no service two invoices.
    expect(
      await rig.scalar(
        `SELECT coalesce(max(n), 0)::text AS v FROM (SELECT count(*) AS n FROM legacy_import_map
           WHERE tenant_id = '${TENANT}' AND legacy_table = 'invoice' AND entity_type = 'service'
           GROUP BY entity_id) x`,
      ),
    ).toMatch(/^[01]$/u);
    expect(
      await rig.scalar(
        `SELECT coalesce(max(n), 0)::text AS v FROM (SELECT count(*) AS n FROM wallet_entries
           WHERE tenant_id = '${TENANT}' GROUP BY reference) x`,
      ),
    ).toBe('1');
    expect(rig.providerWrites()).toEqual([]);
    expect((await rig.row(id))?.['key_ciphertext']).toBeNull();
  }

  it('a crash at an importer phase boundary (after openings) is resumed, not failed', async () => {
    await rig.freshTenant(generated.liveAccounts);
    let crashes = 0;
    const executor = rigExecutor(ctx, {
      importer: (importer) =>
        withAfterPhase(importer, (phase) => {
          if (phase === 'openings' && crashes === 0) {
            crashes += 1;
            throw new Error('simulated crash after the openings phase');
          }
        }),
    });
    const id = await rig.prepare(pkg, executor);
    await executor.tick();
    const interrupted = await rig.row(id);
    expect(interrupted).toMatchObject({ status: 'APPLYING', claimed_by: null });
    expect(interrupted?.['key_ciphertext']).not.toBeNull();
    // What the crash left: every customer and opening, no service yet, the run RUNNING.
    expect(await rig.count('customers')).toBe(USERS);
    expect(await rig.count('services')).toBe(0);
    expect(await rig.count('legacy_import_runs', "mode = 'APPLY' AND status = 'RUNNING'")).toBe(1);

    expect(await tickToEnd(id, executor)).toBe(1);
    expect((await rig.detail(id)).progress.applyAttempts).toBe(2);
    await expectReferenceState(id);
  }, 300_000);

  it.each([
    ['customers', 250],
    ['wallet_entries', 230],
    ['services', 70],
  ])(
    'a crash in the middle of a %s batch (after %i rows) is resumed to the reference state',
    async (table, after) => {
      await rig.freshTenant(generated.liveAccounts);
      const executor = rigExecutor(ctx);
      const id = await rig.prepare(pkg, executor);
      await armCrash(table, after);
      try {
        await executor.tick();
        expect(await rig.row(id)).toMatchObject({ status: 'APPLYING', claimed_by: null });
        // The committed prefix survived, the batch it crashed in did not.
        const left = await rig.count(table);
        expect(left).toBeGreaterThan(0);
        expect(left).toBeLessThanOrEqual(after);
        // Still armed: the resume crashes again at the same row and nothing is duplicated.
        await executor.tick();
        expect(await rig.count(table)).toBe(left);
        expect(await rig.row(id)).toMatchObject({ status: 'APPLYING' });
      } finally {
        await dropCrashTriggers();
      }
      await tickToEnd(id, executor);
      expect((await rig.detail(id)).progress.applyAttempts).toBe(3);
      await expectReferenceState(id);
    },
    300_000,
  );

  it('a crash inside a history ingest batch is resumed by idempotency key', async () => {
    await rig.freshTenant(generated.liveAccounts);
    const executor = rigExecutor(ctx);
    const id = await rig.prepare(pkg, executor);
    await armCrash('legacy_history_records', 120);
    try {
      await executor.tick();
      const row = await rig.detail(id);
      expect(row.status).toBe('APPLYING');
      expect(row.progress.phase).toBe('HISTORY');
      expect(await rig.count('legacy_history_records')).toBeLessThanOrEqual(120);
    } finally {
      await dropCrashTriggers();
    }
    await tickToEnd(id, executor);
    await expectReferenceState(id);
  }, 300_000);

  it('a crash after the importer finished but before the executor recorded it finishes that run, never a second import', async () => {
    await rig.freshTenant(generated.liveAccounts);
    let crashed = false;
    const executor = rigExecutor(ctx, {
      runner: (real) =>
        overriding(real, {
          apply: async (c, i) => {
            const outcome = await real.apply(c, i);
            if (!crashed) {
              crashed = true;
              throw new Error('simulated crash after the importer completed');
            }
            return outcome;
          },
        }),
    });
    const id = await rig.prepare(pkg, executor);
    await executor.tick();
    const row = await rig.detail(id);
    expect(row).toMatchObject({ status: 'APPLYING' });
    expect(row.progress.phase).toBe('APPLY_IMPORT');
    expect(await rig.count('legacy_import_runs', "mode = 'APPLY' AND status = 'COMPLETED'")).toBe(
      1,
    );
    await tickToEnd(id, executor);
    await expectReferenceState(id);
    expect(await rig.count('legacy_import_runs', "mode = 'APPLY'")).toBe(1);
  }, 300_000);

  it('a crash inside reconcile resumes at RECONCILE without touching the import again', async () => {
    await rig.freshTenant(generated.liveAccounts);
    let crashed = false;
    let applies = 0;
    const executor = rigExecutor(ctx, {
      runner: (real) =>
        overriding(real, {
          apply: (c, i) => {
            applies += 1;
            return real.apply(c, i);
          },
          reconcile: async (c) => {
            if (!crashed) {
              crashed = true;
              throw new Error('simulated crash inside reconcile');
            }
            return real.reconcile(c);
          },
        }),
    });
    const id = await rig.prepare(pkg, executor);
    await executor.tick();
    expect((await rig.detail(id)).progress.phase).toBe('RECONCILE');
    await tickToEnd(id, executor);
    expect(applies).toBe(1);
    await expectReferenceState(id);
  }, 300_000);

  it('a worker that died holding its lease is taken over only after the lease expires, and resumed', async () => {
    await rig.freshTenant(generated.liveAccounts);
    let crashes = 0;
    const dead = rigExecutor(ctx, {
      leaseOwner: 'migration:dead',
      importer: (importer) =>
        withAfterPhase(importer, (phase) => {
          if (phase === 'customers' && crashes === 0) {
            crashes += 1;
            throw new Error('the process is about to die');
          }
        }),
    });
    const id = await rig.prepare(pkg, dead);
    await dead.tick();
    // The process "died" mid-apply without releasing: its lease is still on the row.
    await db().execute(sql`
      UPDATE legacy_nxpkg_imports SET claimed_by = 'migration:dead',
        lease_until = now() + interval '10 minutes' WHERE id = ${id}`);
    const survivor = rigExecutor(ctx, { leaseOwner: 'migration:survivor' });
    const before = await rig.migratedState();
    await survivor.tick();
    // Not stale yet: nothing claimed, nothing written.
    expect(await rig.row(id)).toMatchObject({ status: 'APPLYING', claimed_by: 'migration:dead' });
    expect(await rig.migratedState()).toEqual(before);

    await db().execute(sql`
      UPDATE legacy_nxpkg_imports SET lease_until = now() - interval '1 minute' WHERE id = ${id}`);
    await tickToEnd(id, survivor);
    await expectReferenceState(id);
    // The dead owner can write nothing more.
    expect(
      await ctx.container.legacyNxpkgImports.heartbeat({
        id,
        leaseOwner: 'migration:dead',
        now: new Date(),
        leaseUntil: new Date(Date.now() + 60_000),
      }),
    ).toBe(false);
  }, 300_000);

  // --- rerun ------------------------------------------------------------------------------------

  it('after COMPLETED: the same package again is refused FRESH_TARGET_NOT_EMPTY and writes nothing; a re-apply of the finished run writes nothing new; a second active import is refused', async () => {
    await rig.freshTenant(generated.liveAccounts);
    const executor = rigExecutor(ctx);
    const first = await rig.prepare(pkg, executor);
    await executor.tick();
    const completed = await rig.migratedState();
    expect(completed).toEqual(reference);

    // 1. The same package, uploaded again: verified, then its dry run refused, nothing written.
    const second = await rig.upload(pkg.path);
    // One active import per tenant: a third upload while the second is active is refused.
    await expect(
      rig.service.beginUpload(tenantA, rig.owner, { fileName: 'again.nxpkg' }),
    ).rejects.toMatchObject({ code: 'legacy_migration.already_active' });
    expect(await rig.count('legacy_nxpkg_imports')).toBe(2);
    await rig.setKey(second, { keyFileText: pkg.keyFileText });
    await executor.tick();
    expect((await rig.detail(second)).status).toBe('VERIFIED');
    await rig.bind(second);
    await rig.requestDryRun(second);
    await executor.tick();
    const refused = await rig.detail(second);
    expect(refused).toMatchObject({
      status: 'DRY_RUN_FAILED',
      errorCode: 'FRESH_TARGET_NOT_EMPTY',
    });
    expect(refused.progress.refusalCounts).toEqual(
      expect.arrayContaining([
        { code: 'customers', count: USERS },
        { code: 'legacy_history_records', count: pkg.historyLines },
      ]),
    );
    expect((await rig.row(second))?.['key_ciphertext']).toBeNull();
    expect(await rig.migratedState()).toEqual(completed);

    // 2. The finished run, asked to RESUME again (the executor's crash path), is the outcome
    //    already recorded: no new run, no new write.
    const row = await rig.row(first);
    const workDir = await mkdtemp(join(migrationRoot, 'replay-'));
    const adapters = new NxpkgMigrationAdapters({
      db: db(),
      importer: () => ctx.container.legacyImporter(),
      history: () => ctx.container.legacyHistoryIngest,
      cutover: () => ctx.container.legacyCutover,
      uow: ctx.container.uow,
      target: { host: '127.0.0.1', port: '5432', database: 'nexa_test' },
      guardEnv: () => ({ NODE_ENV: 'development' }),
      logger: { warn: () => undefined, error: () => undefined },
    });
    const context = {
      scope: tenantA,
      actor: systemJobActor('legacy-migration', 'corr-replay' as CorrelationId),
      importId: first,
      packageImportId: String(row?.['package_import_id']),
      sourceFingerprint: String(row?.['package_source_fingerprint']),
      // The stored copy is discarded at the terminal state; the same bytes, as uploaded.
      packagePath: pkg.path,
      packageSha256: String(row?.['file_sha256']),
      secret: { keyFileText: pkg.keyFileText },
      workDir,
      decisionsPath: null,
      panelBindings: (await rig.detail(first)).panelBindings ?? [],
      verifyReport: (await rig.detail(first)).verifyReport,
      dryRunReport: (await rig.detail(first)).dryRunReport,
      signal: new AbortController().signal,
    };
    const replay = await adapters.apply(context, {
      mode: 'RESUME',
      approvedDryRunSha256: String(row?.['approved_dry_run_sha256']),
    });
    expect(replay.legacyRunId).toBe(row?.['apply_legacy_run_id']);
    expect(await rig.migratedState()).toEqual(completed);
    const historyAgain = await adapters.ingest(context);
    expect(historyAgain.counts.reduce((a, c) => a + c.count, 0)).toBe(pkg.historyLines);
    expect(await rig.migratedState()).toEqual(completed);

    // 3. A fresh IMPORT of the same package into the now non-fresh tenant is refused (the fresh
    //    guard inside the importer's run-start transaction), and writes nothing — not even a
    //    second APPLY run. Business state is compared first, so a regression in either half
    //    is named by its own assertion.
    const reimport = await adapters
      .apply(context, {
        mode: 'IMPORT',
        approvedDryRunSha256: String(row?.['approved_dry_run_sha256']),
      })
      .then(
        (outcome) => ({ refused: false as const, outcome }),
        (error: unknown) => ({ refused: true as const, error }),
      );
    const { applyRuns: _runs, ...business } = await rig.migratedState();
    const { applyRuns: _before, ...expected } = completed;
    expect(business).toEqual(expected);
    expect(reimport, JSON.stringify(reimport)).toMatchObject({ refused: true });
    if (reimport.refused) {
      expect(reimport.error).toBeInstanceOf(LegacyMigrationStepFailure);
      expect(reimport.error).toMatchObject({ code: 'FRESH_TARGET_NOT_EMPTY' });
    }
    expect(await rig.count('legacy_import_runs', "mode = 'APPLY'")).toBe(1);
    await rm(workDir, { recursive: true, force: true });
    expect(rig.providerWrites()).toEqual([]);
  }, 300_000);

  it('a live invoice whose ownership the converter could not prove is never adopted, through every resume', async () => {
    const held = generated.invoices.find((i) => i.live);
    if (held === undefined) throw new Error('no live invoice');
    const heldPkg = await writeMigrationPackage(join(work, 'held.nxpkg'), {
      dataset: generated.dataset,
      invoices: generated.invoices,
      ownership: { [held.id]: ownershipRecord(held, 'AMBIGUOUS_OWNER', null) },
    });
    await rig.freshTenant(generated.liveAccounts);
    let crashes = 0;
    const executor = rigExecutor(ctx, {
      importer: (importer) =>
        withAfterPhase(importer, (phase) => {
          if (phase === 'adoption' && crashes === 0) {
            crashes += 1;
            throw new Error('simulated crash after adoption');
          }
        }),
    });
    const id = await rig.prepare(heldPkg, executor);
    expect((await rig.detail(id)).dryRunReport?.ownership.proven).toBe(
      generated.invoices.filter((i) => i.live).length - 1,
    );
    await tickToEnd(id, executor);
    const live = generated.invoices.filter((i) => i.live).length;
    expect(await rig.count('services')).toBe(live - 1);
    expect(await rig.count('services', `provider_username = '${held.username}'`)).toBe(0);
    expect(
      await rig.count(
        'legacy_service_candidates',
        `invoice_key = '${held.id}' AND outcome = 'AMBIGUOUS_OWNERSHIP'`,
      ),
    ).toBe(1);
    expect(rig.providerWrites()).toEqual([]);
  }, 300_000);
});
