import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  isNexaError,
  LEGACY_MIGRATION_APPROVAL_PHRASE,
  LEGACY_MIGRATION_HTTP_ERROR_CODES,
  PLATFORM_ERROR_CODES,
  type ActorContext,
  type CorrelationId,
} from '@nexa/contracts';
import { runAsLegacyMigration } from '../../apps/api/src/infrastructure/persistence/write-gate';
import { LegacyMigrationExecutor } from '../../apps/api/src/modules/platform/legacy-migration/application/legacy-migration-executor';
import { failedDetail } from '../../apps/api/src/cutover-rehearse-import';
import { NxpkgMigrationAdapters } from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/nxpkg-migration-adapters';
import { INVENTORY_READ_ATTEMPTS } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/rickpanel-inventory-source';
import { PipelineBackupPort } from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/migration-adapters';
import { LegacyMigrationService } from '../../apps/api/src/modules/platform/legacy-migration/application/legacy-migration.service';
import type { ApplyPhase } from '../../apps/api/src/modules/platform/legacy-importer/application/legacy-importer.service';
import { withAfterPhase } from '../support/legacy-migration-rig';
import { decideLegacyUser } from '../../apps/api/src/modules/platform/legacy-importer/application/decisions';
import { compareKeyBytes } from '../../apps/api/src/modules/platform/legacy-importer/application/source-port';
import { classifyLegacyUserStatus } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import {
  TARGET_ACK_ENV,
  targetAcknowledgement,
} from '../../apps/api/src/modules/platform/legacy-importer/application/production-guard';
import {
  SYNTHETIC_EXPECTED,
  SYNTHETIC_PANEL_ACCOUNTS,
  SYNTHETIC_PANEL_CODES,
  buildSyntheticLegacyDataset,
} from '../fixtures/legacy/synthetic-legacy';
import { startFakeRickpanel, type FakeRickpanel } from '../support/fake-rickpanel';
import { newRawKey, writeNxpkg } from '../support/nxpkg/writer';
import {
  READY_MANIFEST,
  dropCatalogueColumn,
  dropSnapshotColumn,
  listInCatalogueOnly,
  snapshotOfDataset,
  snapshotPackageFiles,
  type SnapshotParts,
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
const PRE_IMPORT_BACKUP_RUN = '019600ab-cdef-7012-8345-6789abcd8888';

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
    skew: 'none' | 'customers' | 'openings_sum' | 'per_customer' = 'none',
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
          telegram_user_id: tg,
          amount_minor: d.balanceMinor.toString(),
          currency: 'IRT',
        });
      } else if (d.balanceMinor < 0n) {
        debts.push({
          record_type: 'legacy_debt',
          idempotency_key: `legacy:debt:${tg}`,
          legacy_user_id: tg,
          amount_minor: (-d.balanceMinor).toString(),
          currency: 'IRT',
        });
      }
    }
    if (skew === 'customers') {
      customers.push({ record_type: 'customer', idempotency_key: 'legacy:customer:999999999' });
    }
    // Two customers' amounts swapped: every count and sum still equal (M8's totals agree), and
    // each of the two is credited the other's money.
    if (skew === 'per_customer') {
      const [a, b] = openings;
      if (a === undefined || b === undefined || a['amount_minor'] === b['amount_minor']) {
        throw new Error('the fixture needs two openings of different amounts');
      }
      openings[0] = { ...a, amount_minor: b['amount_minor'] };
      openings[1] = { ...b, amount_minor: a['amount_minor'] };
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
      readonly converter?: 'absent' | 'none' | 'customers' | 'openings_sum' | 'per_customer';
      readonly extra?: Record<string, { records: Record<string, unknown>[] }>;
      /**
       * §5a: two more legacy tables in the source catalogue, as a real backup has —
       * `Payment_report` (history) and `admin` (excluded, secret) — with the converter's
       * `reports/coverage.json` (`coverage: true`) or without it.
       */
      readonly historyTables?: { readonly coverage: boolean };
      /** Edits the source snapshot before it is written (a converter's allowlist, a gap). */
      readonly snapshot?: (parts: SnapshotParts) => void;
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
    options.snapshot?.(parts);
    const coverageFiles: Record<string, { json: unknown }> = {};
    if (options.historyTables !== undefined) {
      const catalogTables = parts.catalog['tables'] as Record<string, unknown>[];
      const column = (name: string, dataType: string, ordinal: number) => ({
        column: name,
        data_type: dataType,
        ordinal,
        charset: dataType === 'varchar' ? 'utf8mb4' : null,
      });
      const extraTable = (name: string, rows: number) => ({
        name,
        table_type: 'BASE TABLE',
        storage_engine: 'InnoDB',
        charset: 'utf8mb4',
        collation: 'utf8mb4_general_ci',
        rows,
        columns: [column('id', 'int', 1), column('note', 'varchar', 2)],
      });
      catalogTables.push(extraTable('Payment_report', 3), extraTable('admin', 1));
      catalogTables.sort((a, b) => compareKeyBytes(String(a['name']), String(b['name'])));
      if (options.historyTables.coverage) {
        const line = (table: Record<string, unknown>, over: Record<string, unknown>) => ({
          table: table['name'],
          rows: table['rows'],
          exported: 0,
          archived: 0,
          review: 0,
          skipped: 0,
          accounted_rows: table['rows'],
          ...over,
        });
        coverageFiles['reports/coverage.json'] = {
          json: {
            tables: catalogTables.map((t) =>
              t['name'] === 'Payment_report'
                ? line(t, {
                    class: 'ARCHIVE',
                    status: 'archived',
                    archived: 3,
                    sensitivity: 'financial',
                  })
                : t['name'] === 'admin'
                  ? line(t, {
                      class: 'EXCLUDED',
                      status: 'excluded',
                      skipped: 1,
                      sensitivity: 'secret',
                    })
                  : line(t, { class: 'OPERATIONAL', status: 'executed', exported: t['rows'] }),
            ),
          },
        };
      }
    }
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
        ...coverageFiles,
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
    // Each target carries the live, non-test services the package places on it (Codex review
    // on #278: it was a constant 0), counted here straight from the synthetic source.
    const liveStatuses = new Set([
      'active',
      'disabled',
      'disabledn',
      'disablebyadmin',
      'end_of_volume',
    ]);
    const expectedServices = (code: string): number =>
      (buildSyntheticLegacyDataset().tables['invoice'] ?? []).filter(
        (i) =>
          String(i['code_panel'] ?? '').trim() === code &&
          liveStatuses.has(String(i['Status'] ?? '')) &&
          String(i['is_test'] ?? '').trim() === '0',
      ).length;
    for (const target of verified.verifyReport?.panelTargets ?? []) {
      expect(target.services, target.codePanel).toBe(expectedServices(target.codePanel));
    }
    expect(
      (verified.verifyReport?.panelTargets ?? []).some((t) => t.services > 0),
      'the synthetic source has live services on a mapped panel',
    ).toBe(true);

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
      'wallet_debit_openings',
      'trials',
      'products',
      'invoice_archive',
      'services',
      'history',
    ]) {
      expect(sections.has(name), name).toBe(true);
    }
    expect(sections.get('invoice_archive')?.source).toBeGreaterThan(0);
    // Owner decision 2026-10-17: positives are CREDIT openings, the one negative a DEBIT
    // opening; there is no `legacy_debts` section any more.
    expect(sections.has('legacy_debts')).toBe(false);
    expect(sections.get('wallet_openings')).toMatchObject({
      source: SYNTHETIC_EXPECTED.users.opening.POSITIVE,
      imported: SYNTHETIC_EXPECTED.users.opening.POSITIVE,
      skipped: 0,
      quarantined: 0,
    });
    expect(sections.get('wallet_debit_openings')).toMatchObject({
      source: SYNTHETIC_EXPECTED.users.opening.NEGATIVE,
      imported: SYNTHETIC_EXPECTED.users.opening.NEGATIVE,
      skipped: 0,
      quarantined: 0,
    });
    expect(dry.dryRunReport?.wallets.currency).toBe('IRT');
    // The negative balances' magnitude (the converter's own figure): 20 000.
    expect(dry.dryRunReport?.debts).toMatchObject({
      count: SYNTHETIC_EXPECTED.users.opening.NEGATIVE,
      totalMinor: SYNTHETIC_EXPECTED.users.debtSumMinor.toString(),
    });

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
    // The money, from the ledger: six openings (five CREDITs, one DEBIT of 20 000), a wallet
    // total equal to the Mirza balances' signed sum, and no legacy-debt row.
    const ledger = (
      await ctx.container.database.db.execute<{
        tg: string;
        direction: string;
        reason: string;
        reference: string;
        amount: string;
      }>(
        sql`SELECT c.telegram_user_id AS tg, w.direction, w.reason, w.reference, w.amount::text AS amount
              FROM wallet_entries w JOIN customers c ON c.id = w.customer_id
             WHERE w.tenant_id = ${TENANT}`,
      )
    ).rows;
    expect(ledger).toHaveLength(6);
    expect(ledger.every((e) => e.reason === 'MIGRATION_OPENING_BALANCE')).toBe(true);
    expect(ledger.every((e) => e.reference === `legacy:opening:${e.tg}`)).toBe(true);
    expect(ledger.filter((e) => e.direction === 'DEBIT')).toEqual([
      expect.objectContaining({ tg: '100000003', amount: '20000' }),
    ]);
    expect(
      ledger.reduce((s, e) => s + (e.direction === 'CREDIT' ? 1n : -1n) * BigInt(e.amount), 0n),
    ).toBe(SYNTHETIC_EXPECTED.users.legacyBalanceSumMinor);
    expect(await count('legacy_wallet_debts')).toBe(0);
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

  it("refuses a dry run whose converter credits a customer another's money, though every total agrees", async () => {
    const pkg = await writePackage({ converter: 'per_customer' });
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
    // The two swapped customers, and nothing else: the totals agreed.
    expect(Object.fromEntries(counts)).toEqual({
      'per_customer:wallet_openings:amountDiffers': 2,
    });
    expect(await count('customers')).toBe(0);
    expect(await count('wallet_entries')).toBe(0);
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
   * The CLI / rehearsal path, where the acknowledgement is the PROCESS's environment and this
   * container's own service (not production-like) stores none with the approval.
   *
   * Phase 7 changed three things here, deliberately: the dry run no longer waits for the
   * acknowledgement (it writes no customer and no money); the approval records the owner's
   * cutover approval of the dry run's seven values itself (no `/legacy-cutover` visit); and the
   * import's own installation-wide write freeze is stopped sales (no incident). What still
   * waits is the APPLY, for this target's acknowledgement — and it waits APPROVED, before the
   * protective backup and before the freeze.
   */
  it('production-like (env path): the apply waits for the ack; approval and freeze stand for the cutover gate', async () => {
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
    let backupsBefore = 0;
    const executor = new LegacyMigrationExecutor({
      repository: container.legacyNxpkgImports,
      workspaces: container.migrationWorkspaces,
      cipher: container.cipher,
      verifier: adapters,
      runner: adapters,
      freshTarget: adapters,
      history: adapters,
      materialize: ctx.container.legacyMaterializePort,
      botLink: ctx.container.legacyBotLinkPort,
      backup: {
        runBeforeImport: async () => {
          backupsBefore += 1;
          return { outcome: 'TAKEN', runId: PRE_IMPORT_BACKUP_RUN };
        },
        runAfterImport: async () => ({ outcome: 'TAKEN', runId: null }),
      },
      recoveryActive: async () => false,
      latestCutoverAt: () => container.recoveryRequests.latestCutoverAt(),
      asImportWriter: runAsLegacyMigration,
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

    // 1. No acknowledgement anywhere: the DRY RUN still runs (Phase 7) and writes nothing.
    await executor.tick();
    let view = await detail(id);
    expect(view.status, JSON.stringify(view.errorCode)).toBe('DRY_RUN_DONE');
    expect(view.progress.blocker).toBeNull();
    expect(await count('customers')).toBe(0);
    const values = view.dryRunReport?.cutover;
    if (values === undefined) throw new Error('no cutover values');

    await service.approve(tenantA, owner, id, {
      idempotencyKey: key(),
      dryRunSha256: view.dryRunSha256,
      confirmation: LEGACY_MIGRATION_APPROVAL_PHRASE,
    });
    // The approval recorded the owner's cutover approval of exactly these seven values.
    const approvals = await container.database.db.execute<Record<string, unknown>>(
      sql`SELECT kind, source_fingerprint, final_dump_sha256, synthetic, reason
            FROM legacy_cutover_approvals WHERE tenant_id = ${TENANT}`,
    );
    expect(approvals.rows).toHaveLength(1);
    expect(approvals.rows[0]).toMatchObject({
      kind: 'CUTOVER',
      source_fingerprint: values.sourceFingerprint,
      final_dump_sha256: values.finalDumpSha256,
      synthetic: false,
    });

    // 2. The APPLY waits for this target's acknowledgement — APPROVED, no backup, no freeze.
    await executor.tick();
    view = await detail(id);
    expect(view.status).toBe('APPROVED');
    expect(view.progress.blocker).toBe('TARGET_ACK_MISSING');
    expect(view.preImportBackupRunId).toBeNull();
    expect(backupsBefore).toBe(0);
    // Another target's acknowledgement is no acknowledgement.
    env[TARGET_ACK_ENV] = targetAcknowledgement({ ...target, database: 'nexa_other' }, TENANT);
    await executor.tick();
    expect((await detail(id)).progress.blocker).toBe('TARGET_ACK_MISSING');
    expect(await count('customers')).toBe(0);

    // 3. With it: no incident, no drained panel, no `/legacy-cutover` visit — the import runs.
    env[TARGET_ACK_ENV] = targetAcknowledgement(target, TENANT);
    await executor.tick();
    view = await detail(id);
    expect(view.status, JSON.stringify(view.applyReport)).toBe('COMPLETED');
    expect(view.progress.blocker).toBeNull();
    expect(view.preImportBackupRunId).toBe(PRE_IMPORT_BACKUP_RUN);
    expect(backupsBefore).toBe(1);
    expect(await count('customers')).toBe(8);
    expect(await count('incidents')).toBe(0);
    expect((await row(id))?.['key_ciphertext']).toBeNull();
  }, 300_000);

  /**
   * PHASE 7 — the restore page's path on a production-like target, end to end, with NOTHING
   * done on the server: no `NEXA_LEGACY_IMPORT_TARGET_ACK` in the process environment, no
   * stop-sales incident, no `/legacy-cutover` visit. The owner's one approval carries the
   * target acknowledgement (refused when it is not this installation's own) and records the
   * cutover approval; the executor takes the REAL verified protective backup before any
   * customer row, then freezes the installation while it imports: a normal write is refused
   * with the restore's own code and the outbox relay idles. No customer is told anything and
   * no panel is written to; a second claim afterwards changes nothing.
   */
  it('Phase 7 restore page, production-like: no env ack, no incident — backup first, frozen while applying', async () => {
    const target = { host: 'db.internal', port: '5432', database: 'nexa' };
    const ack = targetAcknowledgement(target, TENANT);
    const container = ctx.container;
    const db = container.database.db;
    // What the API process of a production-like installation is: the SAME service, told the
    // truth about its target.
    const pageService = new LegacyMigrationService({
      repository: container.legacyNxpkgImports,
      workspaces: container.migrationWorkspaces,
      cipher: container.cipher,
      guard: container.guard,
      uow: container.uow,
      audit: container.audit,
      opsLog: container.opsLog,
      sessions: container.sessions,
      idempotency: container.idempotency,
      scopeActivity: container.tenants,
      clock: container.clock,
      ids: container.ids,
      enabled: true,
      maxUploadBytes: 1024 * 1024 * 1024,
      productionLikeTarget: true,
      targetAcknowledgement: (tenantId) => targetAcknowledgement(target, tenantId),
      cutover: () => container.legacyCutover,
      recoveryActive: async (tx) =>
        (await container.recoveryRequests.installationLock(tx)) !== null,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    // The pause: after the importer's customers phase, while APPLYING, the test body (which is
    // NOT the import's writer) probes the freeze; then the import continues.
    let paused: () => void = () => undefined;
    const reachedPause = new Promise<void>((resolve) => (paused = resolve));
    let resume: () => void = () => undefined;
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    let pausedOnce = false;
    const pause = async (phase: ApplyPhase) => {
      if (pausedOnce || phase !== 'customers') return;
      pausedOnce = true;
      paused();
      await resumed;
    };
    const adapters = new NxpkgMigrationAdapters({
      db,
      importer: () => withAfterPhase(container.legacyImporter(), pause),
      history: () => container.legacyHistoryIngest,
      cutover: () => container.legacyCutover,
      uow: container.uow,
      target,
      // A production server's migration process: NODE_ENV=production and NO acknowledgement.
      guardEnv: () => ({ NODE_ENV: 'production' }),
      logger: { warn: () => undefined, error: () => undefined },
    });
    // The REAL Backup V1 pipeline behind the port, observed: how many customers existed and
    // what the import's status was at the moment the protective backup was requested.
    const pipeline = new PipelineBackupPort(container.backup, container.recoveryQuiesced);
    const atBackup: { customers: number; status: unknown }[] = [];
    const executor = new LegacyMigrationExecutor({
      repository: container.legacyNxpkgImports,
      workspaces: container.migrationWorkspaces,
      cipher: container.cipher,
      verifier: adapters,
      runner: adapters,
      freshTarget: adapters,
      history: adapters,
      materialize: ctx.container.legacyMaterializePort,
      botLink: ctx.container.legacyBotLinkPort,
      backup: {
        runBeforeImport: async () => {
          atBackup.push({
            customers: await count('customers'),
            status: (
              await db.execute<{ status: string }>(
                sql`SELECT status FROM legacy_nxpkg_imports WHERE tenant_id = ${TENANT}`,
              )
            ).rows[0]?.status,
          });
          return pipeline.runBeforeImport();
        },
        runAfterImport: () => pipeline.runAfterImport(),
      },
      recoveryActive: async () => (await container.recoveryRequests.installationLock()) !== null,
      latestCutoverAt: () => container.recoveryRequests.latestCutoverAt(),
      asImportWriter: runAsLegacyMigration,
      clock: container.clock,
      correlation: () => 'corr-restore-page' as CorrelationId,
      leaseOwner: 'recovery:restore-page',
      tickIntervalMs: 1000,
      enabled: true,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    const pkg = await writePackage({ real: true, clean: true });
    const id = await upload(pkg.path);
    const service = container.legacyMigration;
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
    // The dry run needs no acknowledgement (Phase 7).
    await executor.tick();
    const dry = await detail(id);
    expect(dry.status, JSON.stringify(dry.errorCode)).toBe('DRY_RUN_DONE');

    const codeOf = async (promise: Promise<unknown>) => {
      try {
        await promise;
        return null;
      } catch (error) {
        if (isNexaError(error)) return error.code;
        throw error;
      }
    };
    const approve = (targetAcknowledgement?: string | null) =>
      pageService.approve(tenantA, owner, id, {
        idempotencyKey: key(),
        dryRunSha256: dry.dryRunSha256,
        confirmation: LEGACY_MIGRATION_APPROVAL_PHRASE,
        ...(targetAcknowledgement === undefined ? {} : { targetAcknowledgement }),
      });
    // Refused on a mismatch — none, null, another database's — nothing approved or recorded.
    for (const wrong of [
      undefined,
      null,
      targetAcknowledgement({ ...target, database: 'nexa_x' }, TENANT),
    ]) {
      expect(await codeOf(approve(wrong)), String(wrong)).toBe(
        LEGACY_MIGRATION_HTTP_ERROR_CODES.TARGET_ACK_MISMATCH,
      );
    }
    expect((await row(id))?.['status']).toBe('DRY_RUN_DONE');
    expect(await count('legacy_cutover_approvals')).toBe(0);

    await approve(ack);
    expect(await row(id)).toMatchObject({ status: 'APPROVED', target_ack: ack });
    // The owner's cutover approval, recorded by the same approval in the owner's name.
    const approvals = await db.execute<Record<string, unknown>>(
      sql`SELECT kind, approved_by_admin_id, reason, synthetic FROM legacy_cutover_approvals
           WHERE tenant_id = ${TENANT}`,
    );
    expect(approvals.rows).toEqual([
      {
        kind: 'CUTOVER',
        approved_by_admin_id: owner.id,
        reason: 'تأیید بازیابی از صفحه بکاپ و بازیابی',
        synthetic: false,
      },
    ]);

    // The installation's tenant, as every role resolves it at boot: without it a backup
    // records no operational event at all, and "nothing was announced" would prove nothing.
    container.setInstallationTenant(tenantA.tenantId);
    const notificationsBefore = await count('notifications');
    const eventsBefore = await count('operational_events');
    // A message waiting in the outbox: proof the relay idles because of the freeze, not
    // because it had nothing to claim (the recovery suite's positive-control rule).
    await db.execute(sql`
      INSERT INTO outbox_messages
        (id, aggregate_type, aggregate_id, sequence, event_type, payload, actor, correlation_id, occurred_at)
      VALUES ('01900000-0000-7000-8000-00000000f7e1', 'System', 'system', 1, 'SystemPinged', '{}', '{}',
              'freeze-probe', now())`);

    const ticking = executor.tick();
    // Either the import pauses mid-way, or the tick ends without ever reaching the pause (a
    // refusal) — never a hang.
    await Promise.race([reachedPause, ticking]);
    expect(pausedOnce, String((await row(id))?.['status'])).toBe(true);

    // --- frozen: the import is APPLYING and has written its customers ---------------------
    const frozen = await row(id);
    expect(frozen?.['status']).toBe('APPLYING');
    const backupRunId = String(frozen?.['pre_import_backup_run_id']);
    expect(backupRunId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await count('customers')).toBe(8);
    // A normal tenant write anywhere in the installation: refused, the restore's own code.
    expect(await codeOf(container.uow.run(tenantA, async () => 'a normal write'))).toBe(
      PLATFORM_ERROR_CODES.RECOVERY_QUIESCED,
    );
    // The relay idles: the message is left unclaimed.
    expect(await container.relay.processBatch()).toEqual({ claimed: 0, published: 0, failed: 0 });
    // Reads still work.
    expect((await detail(id)).status).toBe('APPLYING');
    resume();
    await ticking;

    const done = await detail(id);
    expect(done.status, JSON.stringify(done.applyReport)).toBe('COMPLETED');
    expect(done.preImportBackupRunId).toBe(backupRunId);

    // The protective backup: the REAL pipeline, trigger PRE_RESTORE, verified, taken while
    // the import was still APPROVED and before a single customer existed.
    expect(atBackup).toEqual([{ customers: 0, status: 'APPROVED' }]);
    const backupRow = await db.execute<Record<string, unknown>>(
      sql`SELECT trigger, state, verified_at IS NOT NULL AS verified FROM backup_runs WHERE id = ${backupRunId}`,
    );
    expect(backupRow.rows[0]).toEqual({
      trigger: 'PRE_RESTORE',
      state: 'SUCCEEDED',
      verified: true,
    });

    // The freeze is lifted: writes and the relay work again (the positive control).
    expect(await container.uow.run(tenantA, async () => 'writes again')).toBe('writes again');
    expect((await container.relay.processBatch()).claimed).toBeGreaterThan(0);
    for (let i = 0; i < 5; i += 1) await container.relay.processBatch();

    // No Telegram: no customer was told anything, and no notification intent was created.
    expect(await count('customer_notifications')).toBe(0);
    const intents = await db.execute<{ kind: string }>(
      sql`SELECT kind FROM notifications WHERE tenant_id = ${TENANT} ORDER BY created_at`,
    );
    // Review M2: NOTHING — not even the backups' own run_ok: the import's backups are local
    // only and record their events on the recorder that is not projected to Telegram.
    expect(intents.rows.slice(notificationsBefore), JSON.stringify(intents.rows)).toEqual([]);
    // ...while the backups' events WERE recorded (the condition machinery still runs).
    const recorded = await db.execute<{ code: string }>(
      sql`SELECT code FROM operational_events WHERE tenant_id = ${TENANT} ORDER BY first_seen_at`,
    );
    expect(recorded.rows.slice(eventsBefore).map((r) => r.code)).toContain('backup.run_ok');
    // No panel write: GETs and the token exchange only.
    for (const fake of [panelA, panelB]) {
      expect(
        fake.requests.filter(
          (r) => !(r.method === 'GET' || (r.method === 'POST' && r.path === '/api/admin/token')),
        ),
      ).toEqual([]);
    }
    // No incident was needed, none was opened.
    expect(await count('incidents')).toBe(0);

    // A RERUN changes nothing: no second opening balance, no second backup.
    const ledger = async () =>
      (
        await db.execute<{ n: number; total: string }>(
          sql`SELECT count(*)::int AS n, coalesce(sum(amount), 0)::text AS total
                FROM wallet_entries WHERE tenant_id = ${TENANT}`,
        )
      ).rows[0];
    const before = await ledger();
    await executor.tick();
    expect(await ledger()).toEqual(before);
    expect(atBackup).toHaveLength(1);
    // And the same package again is refused FRESH_TARGET_NOT_EMPTY at its dry run.
    const again = await upload(pkg.path);
    await service.setKey(tenantA, owner, again, {
      idempotencyKey: key(),
      keyFileText: pkg.keyFileText,
    });
    await executor.tick();
    await service.setPanelBindings(tenantA, owner, again, {
      idempotencyKey: key(),
      bindings: [
        { codePanel: SYNTHETIC_PANEL_CODES.mappedA, panelId: panelAId },
        { codePanel: SYNTHETIC_PANEL_CODES.mappedB, panelId: panelBId },
      ],
    });
    await service.requestDryRun(tenantA, owner, again, { idempotencyKey: key() });
    await executor.tick();
    expect(await detail(again)).toMatchObject({
      status: 'DRY_RUN_FAILED',
      errorCode: 'FRESH_TARGET_NOT_EMPTY',
    });
    expect(await ledger()).toEqual(before);
  }, 600_000);

  /**
   * The restore page of a production-like installation, as the Phase 7 test builds it — the
   * SAME service told the truth about its target, the executor with the REAL backup pipeline —
   * with no real pause between inventory attempts.
   */
  function productionLikePage() {
    const target = { host: 'db.internal', port: '5432', database: 'nexa' };
    const ack = targetAcknowledgement(target, TENANT);
    const container = ctx.container;
    const db = container.database.db;
    const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const pageService = new LegacyMigrationService({
      repository: container.legacyNxpkgImports,
      workspaces: container.migrationWorkspaces,
      cipher: container.cipher,
      guard: container.guard,
      uow: container.uow,
      audit: container.audit,
      opsLog: container.opsLog,
      sessions: container.sessions,
      idempotency: container.idempotency,
      scopeActivity: container.tenants,
      clock: container.clock,
      ids: container.ids,
      enabled: true,
      maxUploadBytes: 1024 * 1024 * 1024,
      productionLikeTarget: true,
      targetAcknowledgement: (tenantId) => targetAcknowledgement(target, tenantId),
      cutover: () => container.legacyCutover,
      recoveryActive: async (tx) =>
        (await container.recoveryRequests.installationLock(tx)) !== null,
      logger: quiet,
    });
    // Every importer the adapter asks for, and the step signal it was handed (the lease).
    const importerSignals: (AbortSignal | undefined)[] = [];
    const adapters = new NxpkgMigrationAdapters({
      db,
      importer: (signal) => {
        importerSignals.push(signal);
        return container.legacyImporter({
          inventoryAttempts: INVENTORY_READ_ATTEMPTS,
          inventorySleep: async () => undefined,
          ...(signal === undefined ? {} : { inventorySignal: signal }),
        });
      },
      history: () => container.legacyHistoryIngest,
      cutover: () => container.legacyCutover,
      uow: container.uow,
      target,
      guardEnv: () => ({ NODE_ENV: 'production' }),
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
      materialize: ctx.container.legacyMaterializePort,
      botLink: ctx.container.legacyBotLinkPort,
      backup: new PipelineBackupPort(container.backup, container.recoveryQuiesced),
      recoveryActive: async () => (await container.recoveryRequests.installationLock()) !== null,
      latestCutoverAt: () => container.recoveryRequests.latestCutoverAt(),
      asImportWriter: runAsLegacyMigration,
      clock: container.clock,
      correlation: () => 'corr-inventory' as CorrelationId,
      leaseOwner: 'recovery:inventory',
      tickIntervalMs: 1000,
      enabled: true,
      logger: quiet,
    });
    const service = container.legacyMigration;
    /** Upload, key, verify, bindings, dry run: the restore page's steps up to the review. */
    const toDryRun = async (path: string, keyFileText: string) => {
      const id = await upload(path);
      await service.setKey(tenantA, owner, id, { idempotencyKey: key(), keyFileText });
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
      return id;
    };
    const approve = async (id: string) =>
      pageService.approve(tenantA, owner, id, {
        idempotencyKey: key(),
        dryRunSha256: (await detail(id)).dryRunSha256,
        confirmation: LEGACY_MIGRATION_APPROVAL_PHRASE,
        targetAcknowledgement: ack,
      });
    return { executor, service, toDryRun, approve, importerSignals };
  }

  const codes = (rows: readonly { code: string; count: number }[] | undefined) =>
    Object.fromEntries((rows ?? []).map((w) => [w.code, w.count]));

  it('production-like: a dry run planned on an incomplete RickPanel read is NOT approvable; asked again over a settled panel it is, and imports', async () => {
    const page = productionLikePage();
    const pkg = await writePackage({ real: true, clean: true });

    // The panel never settles during the dry run: an account is created before every page
    // (each walk is one page at this size, so the two walks of every attempt differ).
    let churn = 0;
    panelA.beforeListPage = () => {
      panelA.seedUser(`churn_${String((churn += 1))}`);
    };
    const id = await page.toDryRun(pkg.path, pkg.keyFileText);
    const dry = await detail(id);
    expect(dry.status, JSON.stringify(dry.errorCode)).toBe('DRY_RUN_DONE');
    const warnings = codes(dry.dryRunReport?.warnings);
    expect(warnings['PROVIDER_INVENTORY_INCOMPLETE']).toBe(1);
    expect(warnings['PROVIDER_INVENTORY_INCOMPLETE:WALKS_DIFFER']).toBe(1);
    expect(warnings['INVENTORY_INCOMPLETE']).toBeGreaterThan(0);

    // Not approvable: nothing approved, no cutover approval recorded, nothing written.
    await expect(page.approve(id)).rejects.toMatchObject({
      code: LEGACY_MIGRATION_HTTP_ERROR_CODES.INVALID_STATE,
      details: expect.objectContaining({ reason: 'PROVIDER_INVENTORY_INCOMPLETE' }),
    });
    expect((await row(id))?.['status']).toBe('DRY_RUN_DONE');
    expect(await count('legacy_cutover_approvals')).toBe(0);
    expect(await count('customers')).toBe(0);

    // The panel settles; the owner asks for the dry run again — same import, no new upload.
    panelA.beforeListPage = null;
    await page.service.requestDryRun(tenantA, owner, id, { idempotencyKey: key() });
    await page.executor.tick();
    const again = await detail(id);
    expect(again.status).toBe('DRY_RUN_DONE');
    expect(codes(again.dryRunReport?.warnings)['PROVIDER_INVENTORY_INCOMPLETE']).toBeUndefined();
    expect(codes(again.dryRunReport?.warnings)['INVENTORY_INCOMPLETE']).toBeUndefined();
    expect((await page.approve(id)).status).toBe('APPROVED');

    await page.executor.tick();
    const done = await detail(id);
    expect(done.status, JSON.stringify(done.errorCode)).toBe('COMPLETED');
    // The executor's step signal reaches every importer the adapter built, so a lost lease
    // ends the importer's live panel read (and its pause) before the import's first write.
    expect(page.importerSignals.length).toBeGreaterThan(0);
    for (const signal of page.importerSignals) expect(signal).toBeInstanceOf(AbortSignal);
    for (const fake of [panelA, panelB]) {
      expect(
        fake.requests.filter(
          (r) => !(r.method === 'GET' || (r.method === 'POST' && r.path === '/api/admin/token')),
        ),
      ).toEqual([]);
    }
  }, 600_000);

  it('production-like: the panel changed between the approval and the apply — FAILED DRY_RUN_MISMATCH with both sides counted, nothing written; the same .nxpkg again imports', async () => {
    const page = productionLikePage();
    const pkg = await writePackage({ real: true, clean: true });
    const id = await page.toDryRun(pkg.path, pkg.keyFileText);
    expect((await detail(id)).status).toBe('DRY_RUN_DONE');
    expect((await page.approve(id)).status).toBe('APPROVED');

    // Between the owner's approval and the apply, panel A's accounts are deleted on the panel.
    const removed = [...SYNTHETIC_PANEL_ACCOUNTS.A];
    for (const name of removed) panelA.removeUser(name);
    await page.executor.tick();
    const failed = await detail(id);
    expect(failed).toMatchObject({ status: 'FAILED', errorCode: 'DRY_RUN_MISMATCH' });
    expect(failed.applyLegacyRunId).toBeNull();
    const refusal = codes(failed.progress.refusalCounts);
    // Each moved number, both sides; the money did not move and is not listed. The invoices
    // whose accounts were deleted are now PROVIDER_MISSING (in this package they were spread
    // over other categories before, not ADOPTION_ELIGIBLE: what moved is what is recorded).
    expect(refusal['apply:services:PROVIDER_MISSING']).toBeGreaterThan(
      refusal['dryrun:services:PROVIDER_MISSING'] ?? Infinity,
    );
    expect(Object.keys(refusal).some((k) => /customers|wallet/u.test(k))).toBe(false);
    for (const code of Object.keys(refusal)) {
      // Only the panel read moved, so only service categories are listed — each as a pair.
      expect(code).toMatch(/^(dryrun|apply):services:[A-Z_]+$/u);
      const other = code.startsWith('dryrun:')
        ? code.replace('dryrun:', 'apply:')
        : code.replace('apply:', 'dryrun:');
      expect(refusal[other], other).toBeDefined();
    }
    expect(await count('customers')).toBe(0);
    expect(await count('wallet_entries')).toBe(0);
    expect(await count('services')).toBe(0);

    // The retry: the accounts are back, the SAME .nxpkg is uploaded again (a FAILED import is
    // final), dry-run, approved — and imported.
    for (const name of removed) {
      panelA.seedUser(name, {
        expire: Math.floor(Date.UTC(2027, 0, 1) / 1000),
        dataLimit: 30 * 1024 ** 3,
        usedTraffic: 1024 ** 3,
      });
    }
    const retry = await page.toDryRun(pkg.path, pkg.keyFileText);
    expect((await detail(retry)).status).toBe('DRY_RUN_DONE');
    expect((await page.approve(retry)).status).toBe('APPROVED');
    await page.executor.tick();
    const done = await detail(retry);
    expect(done.status, JSON.stringify(done.errorCode)).toBe('COMPLETED');
  }, 600_000);

  it('production-like: every legacy table is classified from the package coverage report, or the dry run is refused naming it', async () => {
    const target = { host: 'db.internal', port: '5432', database: 'nexa' };
    const env: { NODE_ENV: string; [TARGET_ACK_ENV]?: string } = {
      NODE_ENV: 'production',
      [TARGET_ACK_ENV]: targetAcknowledgement(target, TENANT),
    };
    const container = ctx.container;
    const warnings: Record<string, unknown>[] = [];
    const adapters = new NxpkgMigrationAdapters({
      db: container.database.db,
      importer: () => container.legacyImporter(),
      history: () => container.legacyHistoryIngest,
      cutover: () => container.legacyCutover,
      uow: container.uow,
      target,
      guardEnv: () => env,
      logger: { warn: (fields) => void warnings.push(fields), error: () => undefined },
    });
    const executor = new LegacyMigrationExecutor({
      repository: container.legacyNxpkgImports,
      workspaces: container.migrationWorkspaces,
      cipher: container.cipher,
      verifier: adapters,
      runner: adapters,
      freshTarget: adapters,
      history: adapters,
      materialize: ctx.container.legacyMaterializePort,
      botLink: ctx.container.legacyBotLinkPort,
      backup: {
        runBeforeImport: async () => ({ outcome: 'TAKEN', runId: PRE_IMPORT_BACKUP_RUN }),
        runAfterImport: async () => ({ outcome: 'TAKEN', runId: null }),
      },
      recoveryActive: async () => false,
      latestCutoverAt: () => container.recoveryRequests.latestCutoverAt(),
      asImportWriter: runAsLegacyMigration,
      clock: container.clock,
      correlation: () => 'corr-prod-tables' as CorrelationId,
      leaseOwner: 'migration:prod-tables',
      tickIntervalMs: 1000,
      enabled: true,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    const service = container.legacyMigration;
    const dryRun = async (coverage: boolean) => {
      const pkg = await writePackage({ real: true, clean: true, historyTables: { coverage } });
      const id = await upload(pkg.path);
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
      return detail(id);
    };

    // Without the coverage report, NEXA cannot classify Payment_report or admin: refused,
    // and the log names the two tables (names only, never a row).
    const refused = await dryRun(false);
    expect(refused.status).toBe('DRY_RUN_FAILED');
    expect(refused.errorCode).toBe('IMPORT_FAILED');
    expect(warnings.map((w) => w['unclassified'])).toContainEqual(['Payment_report', 'admin']);
    expect(await count('customers')).toBe(0);

    // With it: Payment_report is history (ARCHIVE), admin is SECRETS_MANUAL, the inventory is
    // COMPLETE, and every table has its own accounting line.
    const done = await dryRun(true);
    expect(done.status, JSON.stringify(done.errorCode)).toBe('DRY_RUN_DONE');
    const sections = new Map(done.dryRunReport?.sections.map((x) => [x.section, x]));
    expect(sections.get('table:ARCHIVE:Payment_report')).toMatchObject({
      source: 3,
      imported: 0,
      archived: 3,
      skipped: 0,
      quarantined: 0,
    });
    expect(sections.get('table:SECRETS_MANUAL:admin')).toMatchObject({ source: 1, skipped: 1 });
    expect(sections.get('table:SUPPORTED:user')?.source).toBeGreaterThan(0);
    expect([...sections.keys()].filter((k) => k.startsWith('table:UNCLASSIFIED'))).toEqual([]);
    expect(done.dryRunReport?.warnings.map((w) => w.code)).not.toContain(
      'TABLE_INVENTORY_INCOMPLETE',
    );
    expect(done.dryRunReport?.warnings.map((w) => w.code)).not.toContain('INVENTORY_INCOMPLETE');
    expect(await count('customers')).toBe(0);
  }, 300_000);

  /** Upload, key, bind both mapped panels and dry-run `pkg`; the row as the owner reads it. */
  async function dryRunOf(pkg: { path: string; keyFileText: string }) {
    const id = await upload(pkg.path);
    const service = ctx.container.legacyMigration;
    const executor = ctx.container.migrationExecutor;
    await service.setKey(tenantA, owner, id, {
      idempotencyKey: key(),
      keyFileText: pkg.keyFileText,
    });
    await executor.tick();
    const verified = await detail(id);
    if (verified.status !== 'VERIFIED') return verified;
    await service.setPanelBindings(tenantA, owner, id, {
      idempotencyKey: key(),
      bindings: [
        { codePanel: SYNTHETIC_PANEL_CODES.mappedA, panelId: panelAId },
        { codePanel: SYNTHETIC_PANEL_CODES.mappedB, panelId: panelBId },
      ],
    });
    await service.requestDryRun(tenantA, owner, id, { idempotencyKey: key() });
    await executor.tick();
    return detail(id);
  }

  it('converter 0.8.0: user.roll_Status in the catalogue but not in the rows file — the dry run passes, the import completes, nobody is carried as accepted', async () => {
    const pkg = await writePackage({
      classified: true,
      clean: true,
      snapshot: (parts) => listInCatalogueOnly(parts, 'user', 'roll_Status', 'tinyint'),
    });
    const dry = await dryRunOf(pkg);
    expect(dry.status, JSON.stringify([dry.errorCode, dry.progress.refusalCounts])).toBe(
      'DRY_RUN_DONE',
    );
    await ctx.container.legacyMigration.approve(tenantA, owner, dry.id, {
      idempotencyKey: key(),
      dryRunSha256: dry.dryRunSha256,
      confirmation: LEGACY_MIGRATION_APPROVAL_PHRASE,
    });
    await ctx.container.migrationExecutor.tick();
    const done = await detail(dry.id);
    expect(done.status, JSON.stringify(done.applyReport)).toBe('COMPLETED');
    expect(await count('customers')).toBe(8);
    const accepted = await ctx.container.database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM customers
           WHERE tenant_id = ${TENANT} AND legacy_terms_accepted_at IS NOT NULL`,
    );
    expect(accepted.rows[0]?.n).toBe(0);
  }, 300_000);

  it('a REQUIRED column missing from the rows file, or from the rows file and the catalogue, is refused naming table.column in the report', async () => {
    // A v1 column is refused at VERIFY (verification recomputes the v1 fingerprint); a read
    // set's own required column (`user-status`: User_Status) at the DRY RUN.
    const cases: [string, 'VERIFY_FAILED' | 'DRY_RUN_FAILED', (parts: SnapshotParts) => void][] = [
      ['user.Balance', 'VERIFY_FAILED', (parts) => dropSnapshotColumn(parts, 'user', 'Balance')],
      [
        'invoice.price_product',
        'VERIFY_FAILED',
        (parts) => {
          dropSnapshotColumn(parts, 'invoice', 'price_product');
          dropCatalogueColumn(parts, 'invoice', 'price_product');
        },
      ],
      [
        'user.User_Status',
        'DRY_RUN_FAILED',
        (parts) => dropSnapshotColumn(parts, 'user', 'User_Status'),
      ],
    ];
    for (const [column, status, snapshot] of cases) {
      const refused = await dryRunOf(
        await writePackage({ classified: true, clean: true, snapshot }),
      );
      expect(refused.status, column).toBe(status);
      expect(refused.errorCode, column).toBe('IMPORT_FAILED');
      expect(refused.progress.refusalCounts, column).toEqual([
        { code: `SOURCE_SCHEMA_MISSING_COLUMN:${column}`, count: 1 },
      ]);
      expect(failedDetail(refused), column).toContain(`SOURCE_SCHEMA_MISSING_COLUMN:${column}`);
    }
    expect(await count('customers')).toBe(0);
  }, 300_000);
});
