import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PipelineBackupPort } from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/migration-adapters';
import {
  MigrationRig,
  rigExecutor,
  withAfterPhase,
  TENANT,
  generateDataset,
  moneyOfSnapshot,
  paymentRecords,
  writeMigrationPackage,
} from '../support/legacy-migration-rig';
import { createTestContext, type TestContext } from '../integration/harness';

/**
 * Mirza `.nxpkg` Fresh Migration AT SCALE — opt-in, never on the pull-request path
 * (`pnpm test:migration-scale`; its own vitest project, like `exhaustive`).
 *
 * A synthetic package of NEXA_MIGRATION_SCALE_USERS customers (default 200 000) and
 * NEXA_MIGRATION_SCALE_INVOICES invoices (default 130 000, 40 % live and held as accounts by two
 * fake RickPanels on real sockets), plus one payment history record per two customers, through
 * the `migration` executor with its real ports and the real backup: upload → verify → dry run → approve → apply
 * (import, history ingest, reconcile, final report v2, the standard backup).
 *
 * It records the wall time of each step (and of each apply phase, from the row's own phase
 * bookmark), the process's peak RSS and heap, and requires every count to reconcile with the
 * package, recomputed independently from its snapshot cells: customers = users, the opening
 * credits' sum = the positive Balance cells' sum, the debts' sum = the negative cells'
 * magnitude, history rows = packaged history lines, services = live invoices; zero payments,
 * zero provider writes. SYNTHETIC data only. NOT EVIDENCE about any real backup or panel.
 */

const USERS = Number(process.env['NEXA_MIGRATION_SCALE_USERS'] ?? 200_000);
const INVOICES = Number(process.env['NEXA_MIGRATION_SCALE_INVOICES'] ?? 130_000);

describe('legacy migration at scale', () => {
  let ctx: TestContext;
  let work: string;
  let migrationRoot: string;
  let rig: MigrationRig;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'lmig-scale-'));
    migrationRoot = await mkdtemp(join(tmpdir(), 'lmig-scale-root-'));
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

  it(`${String(USERS)} customers and ${String(INVOICES)} invoices: every count reconciles`, async () => {
    const memory = { rss: 0, heap: 0 };
    const sample = () => {
      const m = process.memoryUsage();
      memory.rss = Math.max(memory.rss, m.rss);
      memory.heap = Math.max(memory.heap, m.heapUsed);
    };
    const sampler = setInterval(sample, 200);
    const timings: Record<string, number> = {};
    const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const start = performance.now();
      try {
        return await fn();
      } finally {
        timings[name] = Math.round(performance.now() - start);
        sample();
      }
    };
    try {
      const generated = await timed('generate', () =>
        Promise.resolve(generateDataset({ users: USERS, invoices: INVOICES })),
      );
      const live = generated.invoices.filter((i) => i.live).length;
      const pkg = await timed('writePackage', () =>
        writeMigrationPackage(join(work, 'scale.nxpkg'), {
          dataset: generated.dataset,
          invoices: generated.invoices,
          history: { 'records/payments.jsonl': paymentRecords(generated.users) },
        }),
      );
      const money = moneyOfSnapshot(pkg.parts);
      await timed('freshTenant', () => rig.freshTenant(generated.liveAccounts));
      // The real ports and the real post-import backup, with the importer's own phase seam
      // used only to time its phases.
      const importerPhases: { phase: string; at: number }[] = [];
      let applyStart = performance.now();
      const executor = rigExecutor(ctx, {
        backup: new PipelineBackupPort(ctx.container.backup, ctx.container.recoveryQuiesced),
        importer: (importer) =>
          withAfterPhase(importer, (phase) => {
            importerPhases.push({ phase, at: Math.round(performance.now() - applyStart) });
          }),
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
      await rig.approve(id);

      // The apply's phases, from the row's own bookmark.
      const phases: { phase: string; at: number }[] = [];
      applyStart = performance.now();
      const poll = setInterval(() => {
        void rig.row(id).then((row) => {
          const phase = String((row?.['progress'] as { phase?: string } | null)?.phase);
          if (phases.at(-1)?.phase !== phase) {
            phases.push({ phase, at: Math.round(performance.now() - applyStart) });
          }
        });
      }, 500);
      try {
        await timed('apply', () => executor.tick());
      } finally {
        clearInterval(poll);
      }
      const view = await rig.detail(id);

      const result = {
        users: USERS,
        invoices: INVOICES,
        liveInvoices: live,
        historyLines: pkg.historyLines,
        packageBytes: (await stat(pkg.path)).size,
        status: view.status,
        reconcile: view.progress.reconcileVerdict,
        reportHolds: view.applyReport?.reportHolds,
        timingsMs: timings,
        applyPhasesMs: phases,
        importerPhasesDoneAtMs: importerPhases,
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
        },
        expected: {
          customers: money.users,
          openings: money.positive.count,
          openingSum: money.positive.sum.toString(),
          debts: money.negative.count,
          debtSum: money.negative.sum.toString(),
          history: pkg.historyLines,
          services: live,
          payments: 0,
        },
      };
      // The run's record, for the PR description: printed whatever the assertions say.
      process.stderr.write(`\nLEGACY_MIGRATION_SCALE ${JSON.stringify(result, null, 1)}\n`);

      expect(view.progress.reconcileVerdict).toBe('RECONCILED');
      expect(result.counts).toEqual(result.expected);
      expect(rig.providerWrites()).toEqual([]);
      expect(await rig.stepDirectories(id)).toEqual([]);
      expect((await rig.row(id))?.['key_ciphertext']).toBeNull();
    } finally {
      clearInterval(sampler);
    }
  }, 7_200_000);
});
