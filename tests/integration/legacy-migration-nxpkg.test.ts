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
import { decideLegacyUser } from '../../apps/api/src/modules/platform/legacy-importer/application/decisions';
import { classifyLegacyUserStatus } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
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

  /**
   * TEST-ONLY stand-in for the converter's operational records (`records/customers.jsonl`,
   * `wallet_opening_balances.jsonl`, `legacy_debts.jsonl`): the converter's rules for these
   * users are the importer's own (`decideLegacyUser`, duplicates held), so a faithful
   * converter writes exactly these. `skew` changes one total, as a converter defect would.
   */
  function converterFiles(
    dataset: ReturnType<typeof buildSyntheticLegacyDataset>,
    skew: 'none' | 'customers' | 'openings_sum' = 'none',
  ) {
    const users = (dataset.tables['user'] ?? []) as Record<string, string | null>[];
    const seen = new Map<string, number>();
    for (const u of users) seen.set(String(u['id']), (seen.get(String(u['id'])) ?? 0) + 1);
    const customers: Record<string, unknown>[] = [];
    const openings: Record<string, unknown>[] = [];
    const debts: Record<string, unknown>[] = [];
    for (const u of users) {
      if ((seen.get(String(u['id'])) ?? 0) > 1) continue;
      const d = decideLegacyUser(
        {
          id: String(u['id']),
          balance: u['Balance'] ?? null,
          status: classifyLegacyUserStatus(u['User_Status'] ?? null),
        },
        false,
      );
      if (d.kind !== 'IMPORT') continue;
      const tg = d.telegramUserId;
      customers.push({ record_type: 'customer', idempotency_key: `legacy:customer:${tg}` });
      if (d.balanceMinor > 0n) {
        openings.push({
          record_type: 'wallet_opening_balance',
          idempotency_key: `legacy:opening:${tg}`,
          amount_minor: d.balanceMinor.toString(),
          currency: 'IRT',
        });
      } else if (d.balanceMinor < 0n) {
        debts.push({
          record_type: 'legacy_debt',
          idempotency_key: `legacy:debt:${tg}`,
          amount_minor: (-d.balanceMinor).toString(),
          currency: 'IRT',
        });
      }
    }
    if (skew === 'customers') {
      customers.push({ record_type: 'customer', idempotency_key: 'legacy:customer:999999999' });
    }
    if (skew === 'openings_sum' && openings[0] !== undefined) {
      const first = openings[0];
      openings[0] = {
        ...first,
        amount_minor: (BigInt(String(first['amount_minor'])) + 1n).toString(),
      };
    }
    return {
      'records/customers.jsonl': { records: customers },
      'records/wallet_opening_balances.jsonl': { records: openings },
      'records/legacy_debts.jsonl': { records: debts },
    };
  }

  /** The synthetic dataset as a package with two selected RickPanel targets. */
  async function writePackage(
    options: {
      readonly real?: boolean;
      /** Without the deliberately UNCLASSIFIED table (a synthetic source the gate can pass). */
      readonly classified?: boolean;
      /**
       * Without the legacy rows whose `user.id` is not a Telegram id: the v1 report's C3 holds
       * only for a source with none, so only such a source can import COMPLETED.
       */
      readonly clean?: boolean;
      readonly converter?: 'absent' | 'none' | 'customers' | 'openings_sum';
      readonly extra?: Record<string, { records: Record<string, unknown>[] }>;
    } = {},
  ): Promise<{ path: string; keyFileText: string }> {
    const built = buildSyntheticLegacyDataset();
    const dataset =
      options.clean === true
        ? {
            ...built,
            tables: {
              ...built.tables,
              user: (built.tables['user'] ?? []).filter(
                (u) =>
                  decideLegacyUser(
                    {
                      id: String(u['id']),
                      balance: (u['Balance'] as string | null | undefined) ?? null,
                      status: 'ACTIVE',
                    },
                    false,
                  ).kind !== 'INVALID_IDENTITY',
              ),
            },
          }
        : built;
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
        : options.classified === true
          ? {
              ...dataset,
              schema: dataset.schema.filter((c) => c.table !== 'nexa_synthetic_unclassified'),
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
        ...(options.converter === 'absent'
          ? {}
          : converterFiles(dataset, options.converter ?? 'none')),
        ...(options.extra ?? {}),
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
    const pkg = await writePackage({ classified: true, clean: true });
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
    // The dry run wrote no customer, balance or service — and no read set (H4): no product
    // review, no invoice archive, no read-set run. Only the fingerprints are in its report.
    expect(await count('customers')).toBe(0);
    expect(await count('wallet_entries')).toBe(0);
    expect(await count('legacy_read_set_runs')).toBe(0);
    expect(await count('legacy_product_reviews')).toBe(0);
    expect(await count('legacy_invoice_archive')).toBe(0);
    expect(await count('legacy_invoice_archive_runs')).toBe(0);
    expect(dry.dryRunReport?.planTalliesDigest).toMatch(/^[0-9a-f]{64}$/u);
    const sections = new Map(dry.dryRunReport?.sections.map((x) => [x.section, x]));
    for (const name of [
      'customers:existing',
      'customers:invalid_identity',
      'wallet_openings',
      'legacy_debts',
      'trials',
      'products',
      'invoice_archive',
      'services',
      'history',
    ]) {
      expect(sections.has(name), name).toBe(true);
    }
    expect(sections.get('invoice_archive')?.source).toBeGreaterThan(0);
    expect(dry.dryRunReport?.wallets.currency).toBe('IRT');
    expect(BigInt(dry.dryRunReport?.debts.totalMinor ?? '-1') >= 0n).toBe(true);

    await service.approve(tenantA, owner, id, {
      idempotencyKey: key(),
      dryRunSha256: dry.dryRunSha256,
      confirmation: LEGACY_MIGRATION_APPROVAL_PHRASE,
    });
    await executor.tick();
    const done = await detail(id);
    // A clean synthetic import is COMPLETED: the importer said COMPLETED, the reconcile
    // RECONCILED, and the v2 report holds — never "one of the two".
    expect(done.status, JSON.stringify(done.applyReport)).toBe('COMPLETED');
    expect(done.progress.importerVerdict).toBe('COMPLETED');
    expect(done.applyReport?.reportHolds).toBe(true);
    expect(done.applyReport?.failedSections).toEqual([]);
    expect(done.applyReport?.failedInvariants).toEqual([]);
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
    // The apply recorded the approved read sets (the dry run did not).
    expect(await count('legacy_read_set_runs')).toBeGreaterThan(0);
    // M4: the next tick's sweep removes the finished import's package (not retained).
    await executor.tick();
    expect(await readdir(join(migrationRoot, id))).toEqual([]);
  }, 300_000);

  it('a source the report cannot hold (an invalid legacy id: C3) is COMPLETED_WITH_DISCREPANCY', async () => {
    const pkg = await writePackage({ classified: true });
    const id = await upload(pkg.path);
    const service = ctx.container.legacyMigration;
    const executor = ctx.container.migrationExecutor;
    await service.setKey(tenantA, owner, id, {
      idempotencyKey: key(),
      keyFileText: pkg.keyFileText,
    });
    await executor.tick();
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
    await service.approve(tenantA, owner, id, {
      idempotencyKey: key(),
      dryRunSha256: dry.dryRunSha256,
      confirmation: LEGACY_MIGRATION_APPROVAL_PHRASE,
    });
    await executor.tick();
    const done = await detail(id);
    expect(done.status).toBe('COMPLETED_WITH_DISCREPANCY');
    expect(done.progress.reconcileVerdict).toBe('RECONCILED');
    expect(done.applyReport?.reportHolds).toBe(false);
    expect(done.applyReport?.failedSections).toContain('core');
  }, 300_000);

  it("refuses a dry run whose plan disagrees with the converter's totals, with both numbers", async () => {
    const pkg = await writePackage({ converter: 'customers' });
    const id = await upload(pkg.path);
    const service = ctx.container.legacyMigration;
    const executor = ctx.container.migrationExecutor;
    await service.setKey(tenantA, owner, id, {
      idempotencyKey: key(),
      keyFileText: pkg.keyFileText,
    });
    await executor.tick();
    await service.setPanelBindings(tenantA, owner, id, {
      idempotencyKey: key(),
      bindings: [
        { codePanel: SYNTHETIC_PANEL_CODES.mappedA, panelId: panelAId },
        { codePanel: SYNTHETIC_PANEL_CODES.mappedB, panelId: panelBId },
      ],
    });
    await service.requestDryRun(tenantA, owner, id, { idempotencyKey: key() });
    await executor.tick();
    const failed = await detail(id);
    expect(failed).toMatchObject({ status: 'DRY_RUN_FAILED', errorCode: 'DRY_RUN_MISMATCH' });
    const counts = new Map(failed.progress.refusalCounts.map((c) => [c.code, c.count]));
    expect(counts.get('converter:customers')).toBe((counts.get('importer:customers') ?? -1) + 1);
    expect((await row(id))?.['key_ciphertext']).toBeNull();
  }, 300_000);

  it('fails VERIFY on a history file the archive would refuse, before any dry run', async () => {
    const payment = (n: number) => ({
      record_type: 'legacy_payment_history',
      schema: 'mirza.payment_report.v1',
      // The same key twice: the ingest's first pass refuses it.
      idempotency_key: 'legacy:payment:1',
      customer: { telegram_user_id: null, source_user_id: null, relation: 'CUSTOMER_IMPORTED' },
      amount: { amount_minor: String(1000 * n), currency: 'IRT', raw: String(1000 * n) },
      status: { outcome: 'SUCCEEDED', raw: 'paid' },
      method: { normalized: 'CARD_TO_CARD', raw: 'cart to cart' },
      times: { created: { local: '2025-01-01T08:02:17', unix: 1_735_700_000 + n } },
      provenance: { source_table: 'Payment_report', source_pk: String(n) },
      affects_wallet: false,
      applies_to_live_state: false,
      creates_payment: false,
      counts_as_revenue: false,
    });
    const pkg = await writePackage({
      extra: { 'records/payments.jsonl': { records: [payment(1), payment(2)] } },
    });
    const id = await upload(pkg.path);
    await ctx.container.legacyMigration.setKey(tenantA, owner, id, {
      idempotencyKey: key(),
      keyFileText: pkg.keyFileText,
    });
    await ctx.container.migrationExecutor.tick();
    expect(await row(id)).toMatchObject({ status: 'VERIFY_FAILED', error_code: 'IMPORT_FAILED' });
    expect(await count('legacy_history_records')).toBe(0);
  }, 120_000);

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

    const pkg = await writePackage({ real: true, clean: true });
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
    expect(view.status, JSON.stringify(view.applyReport)).toBe('COMPLETED');
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
