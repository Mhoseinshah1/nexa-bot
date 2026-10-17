import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_MIGRATION_APPROVAL_PHRASE, type CorrelationId } from '@nexa/contracts';
import { runAsLegacyMigration } from '../../apps/api/src/infrastructure/persistence/write-gate';
import { decideLegacyUser } from '../../apps/api/src/modules/platform/legacy-importer/application/decisions';
import { targetAcknowledgement } from '../../apps/api/src/modules/platform/legacy-importer/application/production-guard';
import { classifyLegacyUserStatus } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { LegacyMigrationExecutor } from '../../apps/api/src/modules/platform/legacy-migration/application/legacy-migration-executor';
import { LegacyMigrationService } from '../../apps/api/src/modules/platform/legacy-migration/application/legacy-migration.service';
import { PipelineBackupPort } from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/migration-adapters';
import { NxpkgMigrationAdapters } from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/nxpkg-migration-adapters';
import { createTestContext, tenantA, type TestContext } from '../integration/harness';
import {
  MigrationRig,
  TENANT,
  generateDataset,
  moneyOfSnapshot,
  paymentRecords,
  writeMigrationPackage,
} from '../support/legacy-migration-rig';

/**
 * Phase 7 at scale: a Mirza backup of ≈198,000 customers and ≈129,000 invoices restored the way
 * the Web Admin's «بکاپ و بازیابی ← عملیات بازیابی» does it — a production-like target, NO
 * `NEXA_LEGACY_IMPORT_TARGET_ACK` in the environment and NO stop-sales incident; the owner's one
 * approval carries the target acknowledgement; the REAL Backup V1 pipeline takes the protective
 * backup (kept on the server, `deliver: false`) before any customer row; the whole installation is
 * frozen while the import applies; then reconcile, the v2 report and the post-import backup.
 *
 * Opt-in (`pnpm test:migration-scale`; size via NEXA_MIGRATION_SCALE_USERS / _INVOICES), never on
 * the pull-request path. Synthetic data only; the marker table is left out so the package is
 * treated as the real backup a production-like target accepts.
 */

const USERS = Number(process.env['NEXA_MIGRATION_SCALE_USERS'] ?? 198_000);
const INVOICES = Number(process.env['NEXA_MIGRATION_SCALE_INVOICES'] ?? 129_000);
const TARGET = { host: 'db.internal', port: '5432', database: 'nexa' };

type Rec = Record<string, unknown>;

/** The converter's own operational totals (records/customers, openings, debts): M8's input. */
function converterFiles(users: readonly Record<string, unknown>[]): Record<string, Rec[]> {
  const customers: Rec[] = [];
  const openings: Rec[] = [];
  const debts: Rec[] = [];
  for (const u of users) {
    const d = decideLegacyUser(
      {
        id: String(u['id']),
        balance: (u['Balance'] as string | null | undefined) ?? null,
        status: classifyLegacyUserStatus((u['User_Status'] as string | null | undefined) ?? null),
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
  return {
    'records/customers.jsonl': customers,
    'records/wallet_opening_balances.jsonl': openings,
    'records/legacy_debts.jsonl': debts,
  };
}

describe('Mirza restore through the restore page, at scale', () => {
  let ctx: TestContext;
  let work: string;
  let migrationRoot: string;
  let rig: MigrationRig;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'mrz-scale-'));
    migrationRoot = await mkdtemp(join(tmpdir(), 'mrz-scale-root-'));
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      LEGACY_MIGRATION_ENABLED: 'true',
      LEGACY_MIGRATION_WORK_DIR: migrationRoot,
      BACKUP_WORK_DIR: work,
    });
    rig = new MigrationRig(ctx, migrationRoot);
  }, 600_000);

  afterAll(async () => {
    await rig?.closePanels();
    await ctx?.close();
    for (const dir of [work, migrationRoot]) await rm(dir, { recursive: true, force: true });
  });

  it(`${String(USERS)} customers and ${String(INVOICES)} invoices: backup first, frozen, every count reconciles`, async () => {
    const container = ctx.container;
    const db = container.database.db;
    const count = async (table: string, where = 'true'): Promise<number> =>
      Number(
        (
          await db.execute<{ n: string }>(
            sql.raw(`SELECT count(*)::text AS n FROM ${table} WHERE ${where}`),
          )
        ).rows[0]?.n ?? '0',
      );
    const memory = { rss: 0, heap: 0 };
    const sampler = setInterval(() => {
      const m = process.memoryUsage();
      memory.rss = Math.max(memory.rss, m.rss);
      memory.heap = Math.max(memory.heap, m.heapUsed);
    }, 200);
    const timings: Record<string, number> = {};
    const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const start = performance.now();
      try {
        return await fn();
      } finally {
        timings[name] = Math.round(performance.now() - start);
      }
    };
    try {
      const generated = await timed('generate', () =>
        Promise.resolve(generateDataset({ users: USERS, invoices: INVOICES })),
      );
      // A real backup carries no synthetic marker: the only kind a production-like target takes.
      const dataset = {
        ...generated.dataset,
        schema: generated.dataset.schema.filter((c) => !c.table.startsWith('nexa_synthetic')),
        tables: Object.fromEntries(
          Object.entries(generated.dataset.tables).filter(([t]) => !t.startsWith('nexa_synthetic')),
        ),
      };
      const live = generated.invoices.filter((i) => i.live).length;
      const converter = converterFiles(
        (dataset.tables['user'] ?? []) as readonly Record<string, unknown>[],
      );
      const converterLines = Object.values(converter).reduce((n, r) => n + r.length, 0);
      const pkg = await timed('writePackage', () =>
        writeMigrationPackage(join(work, 'nexa-restore-mirza-scale.nxpkg'), {
          dataset: dataset as typeof generated.dataset,
          invoices: generated.invoices,
          history: { 'records/payments.jsonl': paymentRecords(generated.users), ...converter },
        }),
      );
      const money = moneyOfSnapshot(pkg.parts);
      await timed('freshTenant', () => rig.freshTenant(generated.liveAccounts));

      // The API process of a production-like installation: the SAME service the page calls.
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
        maxUploadBytes: 4 * 1024 * 1024 * 1024,
        productionLikeTarget: true,
        targetAcknowledgement: (tenantId) => targetAcknowledgement(TARGET, tenantId),
        cutover: () => container.legacyCutover,
        recoveryActive: async (tx) =>
          (await container.recoveryRequests.installationLock(tx)) !== null,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });
      // The recovery role's executor: production-like, NO acknowledgement in its environment.
      const importerPhases: { phase: string; at: number }[] = [];
      const adapters = new NxpkgMigrationAdapters({
        db,
        importer: () => container.legacyImporter(),
        history: () => container.legacyHistoryIngest,
        cutover: () => container.legacyCutover,
        uow: container.uow,
        target: TARGET,
        guardEnv: () => ({ NODE_ENV: 'production' }),
        logger: { warn: () => undefined, error: () => undefined },
      });
      const pipeline = new PipelineBackupPort(container.backup, container.recoveryQuiesced);
      const atBackup: { customers: number; status: unknown }[] = [];
      const frozen: { refused: boolean; code: unknown }[] = [];
      const executor = new LegacyMigrationExecutor({
        repository: container.legacyNxpkgImports,
        workspaces: container.migrationWorkspaces,
        cipher: container.cipher,
        verifier: adapters,
        runner: adapters,
        freshTarget: adapters,
        history: adapters,
        materialize: container.legacyMaterializePort,
        botLink: container.legacyBotLinkPort,
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
        correlation: () => 'corr-restore-scale' as CorrelationId,
        leaseOwner: 'recovery:restore-scale',
        tickIntervalMs: 1000,
        enabled: true,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });

      const id = await timed('upload', () => rig.upload(pkg.path));
      await rig.setKey(id, { keyFileText: pkg.keyFileText });
      await timed('verify', () => executor.tick());
      expect((await rig.detail(id)).status).toBe('VERIFIED');
      await rig.bind(id);
      await rig.requestDryRun(id);
      await timed('dryRun', () => executor.tick());
      const dry = await rig.detail(id);
      expect(dry.status, String(dry.errorCode)).toBe('DRY_RUN_DONE');
      await pageService.approve(tenantA, rig.owner, id, {
        idempotencyKey: `scale-approve-${id}`,
        dryRunSha256: dry.dryRunSha256,
        confirmation: LEGACY_MIGRATION_APPROVAL_PHRASE,
        targetAcknowledgement: targetAcknowledgement(TARGET, TENANT),
      });

      // While the import applies, a write that is not the import's own is refused (sampled).
      const applyStart = performance.now();
      const phases: { phase: string; at: number }[] = [];
      const poll = setInterval(() => {
        void rig.row(id).then(async (row) => {
          const phase = String((row?.['progress'] as { phase?: string } | null)?.phase);
          if (phases.at(-1)?.phase !== phase) {
            phases.push({ phase, at: Math.round(performance.now() - applyStart) });
          }
          if (row?.['status'] === 'APPLYING' && frozen.length < 3) {
            try {
              await container.uow.run(tenantA, async () => undefined);
              frozen.push({ refused: false, code: null });
            } catch (error) {
              frozen.push({ refused: true, code: (error as { code?: unknown }).code ?? null });
            }
          }
        });
      }, 1000);
      try {
        await timed('apply', () => executor.tick());
      } finally {
        clearInterval(poll);
      }
      void importerPhases;
      const view = await rig.detail(id);
      const historyLines = pkg.historyLines - converterLines;

      const result = {
        users: USERS,
        invoices: INVOICES,
        liveInvoices: live,
        historyLines,
        packageBytes: (await stat(pkg.path)).size,
        status: view.status,
        reconcile: view.progress.reconcileVerdict,
        reportHolds: view.applyReport?.reportHolds,
        preImportBackupRunId: view.preImportBackupRunId,
        atProtectiveBackup: atBackup,
        freezeSamples: frozen,
        timingsMs: timings,
        applyPhasesMs: phases,
        peakRssMiB: Math.round(memory.rss / 2 ** 20),
        peakHeapMiB: Math.round(memory.heap / 2 ** 20),
        counts: {
          customers: await rig.count('customers'),
          openings: await rig.count('wallet_entries', "reason = 'MIGRATION_OPENING_BALANCE'"),
          openingSum: await rig.scalar(
            `SELECT coalesce(sum(amount), 0)::text AS v FROM wallet_entries WHERE tenant_id = '${TENANT}'`,
          ),
          debts: await rig.count('legacy_wallet_debts'),
          debtSum: await rig.scalar(
            `SELECT coalesce(sum(amount_minor), 0)::text AS v FROM legacy_wallet_debts WHERE tenant_id = '${TENANT}'`,
          ),
          history: await rig.count('legacy_history_records'),
          services: await rig.count('services'),
          payments: await rig.count('payments'),
          customerNotifications: await count('customer_notifications'),
        },
        expected: {
          customers: money.users,
          openings: money.positive.count,
          openingSum: money.positive.sum.toString(),
          debts: money.negative.count,
          debtSum: money.negative.sum.toString(),
          history: historyLines,
          services: live,
          payments: 0,
          customerNotifications: 0,
        },
        backups: (
          await db.execute<{ trigger: string; state: string; delivery_state: string }>(
            sql`SELECT trigger, state, delivery_state FROM backup_runs ORDER BY started_at`,
          )
        ).rows,
      };
      process.stderr.write(`\nMIRZA_RESTORE_PAGE_SCALE ${JSON.stringify(result, null, 1)}\n`);

      expect(view.status).toBe('COMPLETED');
      expect(view.progress.reconcileVerdict).toBe('RECONCILED');
      expect(result.counts).toEqual(result.expected);
      // The protective backup came first: no customer existed when it was requested.
      expect(atBackup).toEqual([{ customers: 0, status: 'APPROVED' }]);
      expect(view.preImportBackupRunId).not.toBeNull();
      // Both backups verified and kept on the server: nothing delivered to Telegram.
      expect(result.backups.map((b) => [b.trigger, b.state, b.delivery_state])).toEqual([
        ['PRE_RESTORE', 'SUCCEEDED', 'NOT_ATTEMPTED'],
        ['MANUAL', 'SUCCEEDED', 'NOT_ATTEMPTED'],
      ]);
      // Every sampled foreign write during APPLYING was refused by the freeze.
      expect(frozen.length).toBeGreaterThan(0);
      expect(frozen.every((f) => f.refused && f.code === 'recovery.quiesced')).toBe(true);
      expect(rig.providerWrites()).toEqual([]);
      expect(await rig.stepDirectories(id)).toEqual([]);
      expect((await rig.row(id))?.['key_ciphertext']).toBeNull();
    } finally {
      clearInterval(sampler);
    }
  }, 9_000_000);
});
