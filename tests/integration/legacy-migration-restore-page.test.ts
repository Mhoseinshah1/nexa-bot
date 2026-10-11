import { mkdtemp, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createContainer, type Container } from '../../apps/api/src/container';
import {
  MigrationRig,
  generateDataset,
  rigExecutor,
  writeMigrationPackage,
  type GeneratedDataset,
  type MigrationPackage,
} from '../support/legacy-migration-rig';
import { createTestContext, testConfig, type TestContext } from './harness';

/**
 * Phase 7 — the Mirza `.nxpkg` as the restore page's second source, executed by the
 * `recovery` process role (`main.recovery.ts` starts `container.migrationExecutor`).
 *
 * What this file defends, against PostgreSQL, two fake RickPanels and the REAL Backup V1
 * pipeline:
 *
 * - the executor of a container built for the `recovery` role runs the whole import: its
 *   protective backup is a verified `PRE_RESTORE` run taken under the recovery role's lease
 *   BEFORE the first customer, its lease is held as `recovery:<host>`, and the outcome is
 *   COMPLETED with no provider write;
 * - a protective backup that is not taken and verified FAILS the import
 *   (`PRE_IMPORT_BACKUP_FAILED`) with nothing written — never APPLYING, no read set, no
 *   customer, the key erased.
 *
 * The production-like restore-page path (no env ack, no incident, the freeze probed mid-import)
 * is in `legacy-migration-nxpkg.test.ts`, beside the real-package helpers it needs.
 *
 * SYNTHETIC data only (`tests/support/legacy-migration-rig.ts`). NOT EVIDENCE.
 */

const USERS = 40;
const INVOICES = 30;

describe('legacy migration: the restore page source, executed by the recovery role', () => {
  let ctx: TestContext;
  let recovery: Container;
  let work: string;
  let migrationRoot: string;
  let backupRoot: string;
  let rig: MigrationRig;
  let generated: GeneratedDataset;
  let pkg: MigrationPackage;

  const db = () => ctx.container.database.db;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'lmig-page-'));
    migrationRoot = await mkdtemp(join(tmpdir(), 'lmig-page-root-'));
    backupRoot = await mkdtemp(join(tmpdir(), 'lmig-page-backup-'));
    const env = {
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      LEGACY_MIGRATION_WORK_DIR: migrationRoot,
      BACKUP_WORK_DIR: backupRoot,
    };
    // NOTE: no LEGACY_MIGRATION_ENABLED — on by default since Phase 7.
    ctx = await createTestContext(env);
    // The `recovery` process role's container, over the same database and work directory —
    // what `main.recovery.ts` builds.
    recovery = createContainer(testConfig(env), 'recovery');
    rig = new MigrationRig(ctx, migrationRoot);
    generated = generateDataset({ users: USERS, invoices: INVOICES });
    pkg = await writeMigrationPackage(join(work, 'page.nxpkg'), {
      dataset: generated.dataset,
      invoices: generated.invoices,
    });
  }, 600_000);

  afterAll(async () => {
    await rig?.closePanels();
    await recovery?.shutdown();
    await ctx?.close();
    for (const dir of [work, migrationRoot, backupRoot]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is on by default', () => {
    expect(ctx.container.config.LEGACY_MIGRATION_ENABLED).toBe(true);
    expect(recovery.config.LEGACY_MIGRATION_ENABLED).toBe(true);
  });

  it('the recovery role’s own executor imports a package: verified protective backup first, under its lease', async () => {
    await rig.freshTenant(generated.liveAccounts);
    const executor = recovery.migrationExecutor;
    const id = await rig.prepare(pkg, executor);
    expect((await rig.detail(id)).status).toBe('APPROVED');

    // Who holds the import while it applies: sampled from the database while the tick runs.
    const holders = new Set<string>();
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const claimed = await rig.scalar(
          `SELECT claimed_by AS v FROM legacy_nxpkg_imports WHERE id = '${id}'`,
        );
        if (claimed !== null) holders.add(claimed);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    await executor.tick();
    sampling = false;
    await sampler;

    const done = await rig.detail(id);
    expect(['COMPLETED', 'COMPLETED_WITH_DISCREPANCY'], JSON.stringify(done)).toContain(
      done.status,
    );
    expect([...holders]).toEqual([`recovery:${hostname()}`]);

    // The protective backup: the real pipeline's PRE_RESTORE run, verified, taken by the
    // recovery role, finished before the first customer row was written.
    const backupRunId = done.preImportBackupRunId;
    expect(backupRunId).not.toBeNull();
    const backup = (
      await db().execute<Record<string, unknown>>(
        sql`SELECT trigger, state, verified_at IS NOT NULL AS verified, lease_owner, finished_at
              FROM backup_runs WHERE id = ${backupRunId}`,
      )
    ).rows[0];
    expect(backup).toMatchObject({ trigger: 'PRE_RESTORE', state: 'SUCCEEDED', verified: true });
    const order = await rig.scalar(
      `SELECT (b.finished_at <= (SELECT min(created_at) FROM customers c WHERE c.tenant_id = i.tenant_id))::text AS v
         FROM legacy_nxpkg_imports i JOIN backup_runs b ON b.id = i.pre_import_backup_run_id
        WHERE i.id = '${id}'`,
    );
    expect(order).toBe('true');
    expect(await rig.count('customers')).toBe(USERS);
    expect(rig.providerWrites()).toEqual([]);
    expect(await rig.count('customer_notifications')).toBe(0);
  }, 600_000);

  it('a protective backup that is not taken and verified fails the import with nothing written', async () => {
    await rig.freshTenant(generated.liveAccounts);
    for (const outcome of ['FAILED', 'THROWS'] as const) {
      const executor = rigExecutor(ctx, {
        backup: {
          runBeforeImport: async () => {
            if (outcome === 'THROWS') throw new Error('pg_dump: could not connect');
            return { outcome: 'FAILED', runId: '019600ab-cdef-7012-8345-6789abcd7777' };
          },
        },
      });
      const id = await rig.prepare(pkg, executor);
      await executor.tick();
      const row = await rig.row(id);
      expect(row, outcome).toMatchObject({
        status: 'FAILED',
        error_code: 'PRE_IMPORT_BACKUP_FAILED',
        key_ciphertext: null,
        pre_import_backup_run_id: null,
      });
      // Nothing written: no customer, no ledger entry, no read set, no apply run.
      expect(await rig.count('customers'), outcome).toBe(0);
      expect(await rig.count('wallet_entries'), outcome).toBe(0);
      expect(await rig.count('legacy_read_set_runs'), outcome).toBe(0);
      expect(await rig.count('legacy_import_runs', "mode = 'APPLY'"), outcome).toBe(0);
      expect(rig.providerWrites(), outcome).toEqual([]);
    }
  }, 600_000);
});
