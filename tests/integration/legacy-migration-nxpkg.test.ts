import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  LEGACY_MIGRATION_APPROVAL_PHRASE,
  type ActorContext,
  type CorrelationId,
} from '@nexa/contracts';
import { LegacyMigrationExecutor } from '../../apps/api/src/modules/platform/legacy-migration/application/legacy-migration-executor';
import { NxpkgMigrationAdapters } from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/nxpkg-migration-adapters';
import {
  TARGET_ACK_ENV,
  targetAcknowledgement,
} from '../../apps/api/src/modules/platform/legacy-importer/application/production-guard';
import {
  SYNTHETIC_PANEL_ACCOUNTS,
  SYNTHETIC_PANEL_CODES,
  buildSyntheticLegacyDataset,
} from '../fixtures/legacy/synthetic-legacy';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
import { newRawKey, writeNxpkg } from '../support/nxpkg/writer';
import {
  READY_MANIFEST,
  snapshotOfDataset,
  snapshotPackageFiles,
} from '../support/nxpkg-legacy-package';
import {
  SEED_IDS,
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  validatePanelConnection,
  type TestContext,
} from './harness';

/**
 * Mirza `.nxpkg` importer — the `migration` role's executor with its REAL ports
 * (`NxpkgMigrationAdapters`, `PipelineBackupPort`) over a synthetic package: the converter's
 * 1.4.0 layout written by the test writer, opened by the real reader, imported by the
 * EXISTING importer through the CLI's own `runMode`, against PostgreSQL and two fake
 * RickPanels on real sockets.
 *
 * What this file defends: the whole lifecycle UPLOADED → … → COMPLETED* through the
 * operator's service and the executor alone; a wrong key is VERIFY_FAILED
 * (`NXPKG_WRONG_KEY`) with the key erased; customers, openings and history are written once;
 * provider writes are zero; no decrypted directory survives; the key is erased at the end.
 *
 * NOT EVIDENCE about any real Mirza backup or RickPanel.
 */

const TENANT = SEED_IDS.tenantA as unknown as string;

describe('legacy migration: the executor over a real package', () => {
  let ctx: TestContext;
  let work: string;
  let migrationRoot: string;
  let backupRoot: string;
  let panelA: FakeRickpanel;
  let panelB: FakeRickpanel;
  let panelAId: string;
  let panelBId: string;
  let owner: ActorContext;
  let keys = 0;
  const key = () => `lmig-nxpkg-${String((keys += 1))}-${String(Date.now())}`;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'lmig-nxpkg-'));
    migrationRoot = await mkdtemp(join(tmpdir(), 'lmig-root-'));
    backupRoot = await mkdtemp(join(tmpdir(), 'lmig-backup-'));
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      LEGACY_MIGRATION_ENABLED: 'true',
      LEGACY_MIGRATION_WORK_DIR: migrationRoot,
      BACKUP_WORK_DIR: backupRoot,
    });
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
    for (const dir of [work, migrationRoot, backupRoot]) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    await panelA?.close();
    await panelB?.close();
  });

  async function rickpanel(host: string, names: readonly string[], name: string) {
    const fake = await startFakeRickpanel({ host });
    for (const user of names) {
      fake.seedUser(user, {
        expire: Math.floor(Date.UTC(2027, 0, 1) / 1000),
        dataLimit: 30 * 1024 ** 3,
        usedTraffic: 1024 ** 3,
      });
    }
    const created = await ctx.container.panels.create(tenantA, owner, {
      name: `Rick ${name}`,
      providerType: 'rickpanel',
      baseUrl: fake.baseUrl,
      credentials: { username: fake.username, password: fake.password },
      activation: {},
      idempotencyKey: `lmig-panel-${name}`,
    });
    await validatePanelConnection(ctx.container, tenantA, created.view.panel.id);
    return { fake, id: created.view.panel.id };
  }

  beforeEach(async () => {
    await ctx.reset();
    for (const entry of await readdir(migrationRoot)) {
      await rm(join(migrationRoot, entry), { recursive: true, force: true });
    }
    owner = {
      ...adminActorFor(
        await createAdmin(ctx.container, tenantA, { username: 'owner-lmig', roleKeys: ['owner'] }),
      ),
    };
    const a = await rickpanel('127.0.0.2', SYNTHETIC_PANEL_ACCOUNTS.A, 'a');
    const b = await rickpanel('127.0.0.3', SYNTHETIC_PANEL_ACCOUNTS.B, 'b');
    panelA = a.fake;
    panelB = b.fake;
    panelAId = a.id;
    panelBId = b.id;
  }, 120_000);

  /** The synthetic dataset as a package with two selected RickPanel targets. */
  async function writePackage(
    options: { readonly real?: boolean } = {},
  ): Promise<{ path: string; keyFileText: string }> {
    const dataset = buildSyntheticLegacyDataset();
    // `real`: the snapshot carries no synthetic marker, as a converted production backup's
    // would not — the only kind a production-like target may ever import.
    const source =
      options.real === true
        ? {
            ...dataset,
            // Neither the marker nor the deliberately UNCLASSIFIED table: the cutover gate
            // refuses any table not classified in a reviewed commit.
            schema: dataset.schema.filter((c) => !c.table.startsWith('nexa_synthetic')),
          }
        : dataset;
    const parts = snapshotOfDataset(source as never);
    const C = SYNTHETIC_PANEL_CODES;
    const target = (code: string, selected: boolean) => ({
      record_type: 'legacy_panel_target',
      schema: 'm2n.legacy_panel_target.v1',
      idempotency_key: `legacy:panel-target:${code}`,
      code_panel: code,
      target: selected
        ? {
            provider_type: 'rickpanel',
            provider_display_name: 'RickPanel',
            provider_version_declared: '1.0.0',
            nexa_panel_id: null,
            binding: 'CREATE_IN_NEXA_THEN_CONNECT',
            decided_by: 'operator',
            evidence: [],
          }
        : null,
      mapping_state: selected ? 'TARGET_SELECTED' : 'OPERATOR_MUST_MAP',
      nexa_panel_map_entry: null,
      credentials_in_package: false,
      services_reprovisioned: false,
      provision: false,
      applies_to_live_state: false,
    });
    const raw = newRawKey();
    const written = await writeNxpkg(join(work, `p-${ctx.container.ids.uuid()}.nxpkg`), {
      files: snapshotPackageFiles(parts, {
        'records/panel_target_mapping.jsonl': {
          records: [
            target(C.mappedA, true),
            target(C.mappedB, true),
            target(C.test, false),
            target(C.declaredMissing, false),
            target(C.unmapped, false),
            target('(no code_panel)', false),
          ],
        },
      }),
      secret: { rawKey: raw.rawKey },
      manifest: { ...READY_MANIFEST, import_id: 'abcdefabcdefabcdefabcdefabcdefab' },
    });
    return { path: written.path, keyFileText: raw.keyFileText };
  }

  /** The operator's upload, as the controller does it: bytes into the service's own path. */
  async function upload(path: string): Promise<string> {
    const service = ctx.container.legacyMigration;
    const pending = await service.beginUpload(tenantA, owner, { fileName: 'mirza.nxpkg' });
    await copyFile(path, pending.packagePath);
    const bytes = await readFile(path);
    const view = await service.completeUpload(tenantA, owner, pending, {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    return view.id;
  }

  async function count(table: string): Promise<number> {
    const result = await ctx.container.database.db.execute<{ n: number }>(
      sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = '${TENANT}'`),
    );
    return result.rows[0]?.n ?? 0;
  }

  const detail = (id: string) => ctx.container.legacyMigration.detail(tenantA, owner, id);
  const row = async (id: string) =>
    (
      await ctx.container.database.db.execute<Record<string, unknown>>(
        sql`SELECT * FROM legacy_nxpkg_imports WHERE id = ${id}`,
      )
    ).rows[0];

  it('verifies, dry-runs, imports, archives, reconciles and reports a package; the key is erased', async () => {
    const pkg = await writePackage();
    const id = await upload(pkg.path);
    const service = ctx.container.legacyMigration;
    const executor = ctx.container.migrationExecutor;

    await service.setKey(tenantA, owner, id, {
      idempotencyKey: key(),
      keyFileText: pkg.keyFileText,
    });
    await executor.tick();
    const verified = await detail(id);
    expect(verified.status, JSON.stringify(verified.errorCode)).toBe('VERIFIED');
    expect(verified.verifyReport?.synthetic).toBe(true);
    expect(verified.verifyReport?.panelTargets.map((t) => t.codePanel).sort()).toEqual(
      [SYNTHETIC_PANEL_CODES.mappedA, SYNTHETIC_PANEL_CODES.mappedB].sort(),
    );

    await service.setPanelBindings(tenantA, owner, id, {
      idempotencyKey: key(),
      bindings: [
        { codePanel: SYNTHETIC_PANEL_CODES.mappedA, panelId: panelAId },
        { codePanel: SYNTHETIC_PANEL_CODES.mappedB, panelId: panelBId },
      ],
    });
    await service.requestDryRun(tenantA, owner, id, { idempotencyKey: key() });
    await executor.tick();
    const dry = await detail(id);
    expect(dry.status, JSON.stringify(dry.errorCode)).toBe('DRY_RUN_DONE');
    expect(dry.dryRunReport?.sections.find((s) => s.section === 'customers')).toMatchObject({
      imported: 8,
    });
    // The dry run wrote no customer, balance or service.
    expect(await count('customers')).toBe(0);
    expect(await count('wallet_entries')).toBe(0);

    await service.approve(tenantA, owner, id, {
      idempotencyKey: key(),
      dryRunSha256: dry.dryRunSha256,
      confirmation: LEGACY_MIGRATION_APPROVAL_PHRASE,
    });
    await executor.tick();
    const done = await detail(id);
    expect(['COMPLETED', 'COMPLETED_WITH_DISCREPANCY'], JSON.stringify(done)).toContain(
      done.status,
    );
    expect(done.progress.reconcileVerdict).toBe('RECONCILED');
    expect(done.applyLegacyRunId).not.toBeNull();
    // The standard backup after the import, through the unmodified pipeline.
    expect(done.progress.backup).toBe('TAKEN');
    expect(done.backupRunId).not.toBeNull();
    expect(done.applyReport?.reconcileVerdict).toBe('RECONCILED');
    expect(await count('customers')).toBe(8);
    const stored = await row(id);
    expect(stored?.['key_ciphertext']).toBeNull();
    expect(stored?.['key_key_id']).toBeNull();

    // Provider writes during a migration: zero.
    for (const fake of [panelA, panelB]) {
      const writes = fake.requests.filter(
        (r) => !(r.method === 'GET' || (r.method === 'POST' && r.path === '/api/admin/token')),
      );
      expect(writes).toEqual([]);
    }
    // No decrypted step directory survived.
    expect((await readdir(join(migrationRoot, id))).filter((n) => n.startsWith('step-'))).toEqual(
      [],
    );
  }, 300_000);

  it('a wrong key is VERIFY_FAILED with NXPKG_WRONG_KEY, and the key is erased', async () => {
    const pkg = await writePackage();
    const id = await upload(pkg.path);
    const other = newRawKey();
    await ctx.container.legacyMigration.setKey(tenantA, owner, id, {
      idempotencyKey: key(),
      keyFileText: other.keyFileText,
    });
    await ctx.container.migrationExecutor.tick();
    const stored = await row(id);
    expect(stored).toMatchObject({ status: 'VERIFY_FAILED', error_code: 'NXPKG_WRONG_KEY' });
    expect(stored?.['key_ciphertext']).toBeNull();
  }, 120_000);

  /**
   * A production-like target, simulated the way the guard's own tests do: a database NAME with
   * no non-production token, and `NODE_ENV=production` in the migration process's environment.
   * The CLI's gates, unchanged, decide: without the process's target acknowledgement the dry
   * run waits; without the owner's cutover approval of the dry run's seven values the import
   * waits; without stop-sales it waits; with all three it runs.
   */
  it('production-like: waits for the ack, the cutover approval and stop-sales, then imports', async () => {
    const target = { host: 'db.internal', port: '5432', database: 'nexa' };
    const env: { NODE_ENV: string; [TARGET_ACK_ENV]?: string } = { NODE_ENV: 'production' };
    const container = ctx.container;
    const adapters = new NxpkgMigrationAdapters({
      db: container.database.db,
      importer: () => container.legacyImporter(),
      history: () => container.legacyHistoryIngest,
      cutover: () => container.legacyCutover,
      uow: container.uow,
      target,
      guardEnv: () => env,
      logger: { warn: () => undefined, error: () => undefined },
    });
    const executor = new LegacyMigrationExecutor({
      repository: container.legacyNxpkgImports,
      workspaces: container.migrationWorkspaces,
      cipher: container.cipher,
      verifier: adapters,
      runner: adapters,
      freshTarget: adapters,
      history: adapters,
      backup: { runAfterImport: async () => ({ outcome: 'TAKEN', runId: null }) },
      clock: container.clock,
      correlation: () => 'corr-prod' as CorrelationId,
      leaseOwner: 'migration:prod-sim',
      tickIntervalMs: 1000,
      enabled: true,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    const service = container.legacyMigration;

    const pkg = await writePackage({ real: true });
    const id = await upload(pkg.path);
    await service.setKey(tenantA, owner, id, {
      idempotencyKey: key(),
      keyFileText: pkg.keyFileText,
    });
    await executor.tick();
    const verified = await detail(id);
    expect(verified.verifyReport?.synthetic, verified.errorCode ?? '').toBe(false);
    await service.setPanelBindings(tenantA, owner, id, {
      idempotencyKey: key(),
      bindings: [
        { codePanel: SYNTHETIC_PANEL_CODES.mappedA, panelId: panelAId },
        { codePanel: SYNTHETIC_PANEL_CODES.mappedB, panelId: panelBId },
      ],
    });
    await service.requestDryRun(tenantA, owner, id, { idempotencyKey: key() });

    // 1. No acknowledgement in the process's environment: the dry run WAITS (nothing read).
    await executor.tick();
    let view = await detail(id);
    expect(view.status).toBe('DRY_RUN_REQUESTED');
    expect(view.progress.blocker).toBe('TARGET_ACK_MISSING');
    // Another target's acknowledgement is no acknowledgement.
    env[TARGET_ACK_ENV] = targetAcknowledgement({ ...target, database: 'nexa_other' }, TENANT);
    await executor.tick();
    expect((await detail(id)).progress.blocker).toBe('TARGET_ACK_MISSING');

    env[TARGET_ACK_ENV] = targetAcknowledgement(target, TENANT);
    await executor.tick();
    view = await detail(id);
    expect(view.status, JSON.stringify(view.errorCode)).toBe('DRY_RUN_DONE');
    expect(view.progress.blocker).toBeNull();
    const values = view.dryRunReport?.cutover;
    if (values === undefined) throw new Error('no cutover values');

    await service.approve(tenantA, owner, id, {
      idempotencyKey: key(),
      dryRunSha256: view.dryRunSha256,
      confirmation: LEGACY_MIGRATION_APPROVAL_PHRASE,
    });

    // 2. No owner cutover approval of these seven values: the import WAITS, still APPROVED.
    await executor.tick();
    view = await detail(id);
    expect(view.status).toBe('APPROVED');
    expect(view.progress.blocker).toBe('CUTOVER_APPROVAL_MISSING');
    expect(await count('customers')).toBe(0);

    await container.legacyCutover.approve(tenantA, owner, {
      idempotencyKey: key(),
      kind: 'CUTOVER',
      ...values,
      priorSourceFingerprint: null,
      reason: 'production-like rehearsal of the migration role',
    });

    // 3. Sales are not stopped: still waiting.
    await executor.tick();
    view = await detail(id);
    expect(view.status).toBe('APPROVED');
    expect(view.progress.blocker).toBe('STOP_SALES_NOT_ACTIVE');
    expect(await count('customers')).toBe(0);

    await stopSales();
    await executor.tick();
    view = await detail(id);
    expect(['COMPLETED', 'COMPLETED_WITH_DISCREPANCY'], JSON.stringify(view)).toContain(
      view.status,
    );
    expect(view.progress.blocker).toBeNull();
    expect(await count('customers')).toBe(8);
    expect((await row(id))?.['key_ciphertext']).toBeNull();
  }, 300_000);

  /** Stop sales the runbook's way (the cutover suite's helper): incident, drained panels, no gateway. */
  async function stopSales(): Promise<void> {
    const db = ctx.container.database.db;
    await db.execute(sql`
      INSERT INTO incidents (id, tenant_id, kind, severity, status, title, stop_sales, admin_banner,
                             started_at, created_at, updated_at)
      VALUES (${ctx.container.ids.uuid()}, ${tenantA.tenantId}, 'MAINTENANCE', 'MAJOR', 'ACTIVE',
              'migration window', true, true, now(), now(), now())`);
    await db.execute(
      sql`UPDATE panels SET drained_at = now(), drain_reason = 'cutover' WHERE tenant_id = ${tenantA.tenantId}`,
    );
    await db.execute(
      sql`UPDATE payment_gateways SET status = 'DISABLED' WHERE tenant_id = ${tenantA.tenantId}`,
    );
  }
});
