import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LegacyMigrationStepFailure } from '../../apps/api/src/modules/platform/legacy-migration/application/ports';
import { changedTables, databaseFingerprint } from '../support/database-fingerprint';
import {
  MONEY_SHAPE_DEBTS,
  MONEY_SHAPE_DEBT_SUM,
  MONEY_SHAPE_POSITIVE_SUM,
  moneyShapeUsers,
  type MoneyShape,
} from '../support/legacy-money-shape';
import {
  MigrationRig,
  RIG_PRE_IMPORT_BACKUP_RUN,
  TENANT,
  generateDataset,
  overriding,
  rigExecutor,
  withAfterPhase,
  writeMigrationPackage,
  type GeneratedDataset,
  type MigrationPackage,
} from '../support/legacy-migration-rig';
import { createTestContext, testConfig, type TestContext } from './harness';

/**
 * The real Mirza package's MONEY SHAPE through the whole `.nxpkg` path (the operator's
 * service, the `migration` role's executor, the real importer, PostgreSQL, two fake
 * RickPanels): positive balances summing to exactly 2,986,130,847 IRT, exactly 38 legacy
 * debts summing to 130,634,742 IRT that stay review-only, mixed statuses, and rows the
 * importer must hold (unreadable, out of range, an unknown status, a duplicated id) — a
 * smaller run of what `tests/unit/legacy-money-shape.test.ts` plans at 4,000 customers.
 *
 * - the import credits exactly the positives, records exactly the 38 debts with no ledger
 *   effect, and the report's usersWallets section (U1–U10) holds — per customer as well as in
 *   total; the converter's per-customer records agree; a wallet-history verdict that does not
 *   match the snapshot is a dry-run WARNING, and the snapshot balance is still the opening;
 * - a crash after the openings phase resumes to the same totals: no double credit;
 * - an APPLY that fails after the openings were written ends FAILED, and restoring the
 *   protective backup taken before its first write returns every table — the wallet ledger
 *   and the debts among them — to the pre-import state;
 * - a converter whose reading of a snapshot balance differs from the importer's blocks the
 *   dry run (`DRY_RUN_MISMATCH`), with nothing written.
 *
 * The protective backup here is a plain `pg_dump -Fc` of the test database, restored with
 * `pg_restore --clean` into the SAME database: the real Backup V1 pipeline restores into a
 * scratch database and the recovery role cuts over by rename (ADR-0028), and both create
 * databases this suite must not. What is proved is the strongest equivalent available in one
 * database: the archive taken before the first write, restored, holds exactly the pre-import
 * state of every table. SYNTHETIC data only. NOT EVIDENCE.
 */

const run = promisify(execFile);
const POSITIVES = 120;
const ZEROS = 6;
const INVOICES = 12;

type Rec = Record<string, unknown>;

/** The converter's operational money records for `shape`, as a faithful converter writes them. */
function converterFiles(shape: MoneyShape): Record<string, Rec[]> {
  const customers: Rec[] = [];
  const openings: Rec[] = [];
  const debts: Rec[] = [];
  for (const tg of [...shape.positives.keys(), ...shape.debts.keys(), ...shape.zeros]) {
    customers.push({
      record_type: 'customer',
      idempotency_key: `legacy:customer:${tg}`,
      telegram_user_id: tg,
    });
  }
  for (const [tg, amount] of shape.positives) {
    openings.push({
      record_type: 'wallet_opening_balance',
      idempotency_key: `legacy:opening:${tg}`,
      telegram_user_id: tg,
      amount_minor: amount.toString(),
      currency: 'IRT',
    });
  }
  for (const [tg, amount] of shape.debts) {
    debts.push({
      record_type: 'legacy_debt',
      idempotency_key: `legacy:debt:${tg}`,
      telegram_user_id: tg,
      amount_minor: amount.toString(),
      currency: 'IRT',
    });
  }
  return {
    'records/customers.jsonl': customers,
    'records/wallet_opening_balances.jsonl': openings,
    'records/legacy_debts.jsonl': debts,
  };
}

/** One `wallet_history_checks.jsonl` record, in the shape converter 0.6.0 writes it. */
function historyCheck(tg: string, verdict: string, snapshotMinor: string, historyMinor: string) {
  return {
    affects_wallet: false,
    applied_to_balance: false,
    applies_to_live_state: false,
    chain_gaps: 0,
    customer: {
      customer_decision: 'IMPORT',
      relation: 'CUSTOMER_IMPORTED',
      source_user_id: tg,
      telegram_user_id: tg,
    },
    delta_snapshot_minus_history_minor:
      verdict === 'MATCHES_SNAPSHOT'
        ? null
        : (BigInt(snapshotMinor) - BigInt(historyMinor)).toString(),
    derived_from: ['wallet_transaction (history)', 'user.Balance (snapshot, read only)'],
    history_last_balance_after: {
      amount_minor: historyMinor,
      currency: 'IRT',
      transaction_id: '4',
    },
    idempotency_key: `legacy:wallet-history-check:${tg}`,
    inconsistent_rows: 0,
    provenance: { source_pk: null, source_table: 'wallet_transaction' },
    record_type: 'legacy_wallet_history_check',
    schema: 'mirza.wallet_transaction.check.v1',
    snapshot_balance: {
      amount_minor: snapshotMinor,
      currency: 'IRT',
      note: 'OK',
      raw: snapshotMinor,
    },
    snapshot_is_the_opening_figure: true,
    transactions: 4,
    verdict,
  };
}

describe('the real package money shape through the .nxpkg import (integration)', () => {
  let ctx: TestContext;
  let work: string;
  let migrationRoot: string;
  let rig: MigrationRig;
  let generated: GeneratedDataset;
  let shape: MoneyShape;
  let pkg: MigrationPackage;
  const db = () => ctx.container.database.db;

  async function packageOf(
    name: string,
    history: Record<string, Rec[]> = {},
  ): Promise<MigrationPackage> {
    const dataset = {
      ...generated.dataset,
      tables: { ...(generated.dataset as { tables: Rec }).tables, user: shape.users },
    };
    return writeMigrationPackage(join(work, name), {
      dataset: dataset as never,
      invoices: generated.invoices,
      history: { ...converterFiles(shape), ...history },
    });
  }

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'lmig-money-'));
    migrationRoot = await mkdtemp(join(tmpdir(), 'lmig-money-root-'));
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      LEGACY_MIGRATION_ENABLED: 'true',
      LEGACY_MIGRATION_WORK_DIR: migrationRoot,
      BACKUP_WORK_DIR: work,
    });
    rig = new MigrationRig(ctx, migrationRoot);
    // The rig's invoices are owned by users 0..POSITIVES-1: the positive customers below.
    generated = generateDataset({ users: POSITIVES, invoices: INVOICES });
    shape = moneyShapeUsers({
      positives: POSITIVES,
      zeros: ZEROS,
      idBase: 300_000_000,
      // v1 C3 fails on an invalid identity by design; the unit test covers that row.
      invalidIdentity: false,
      duplicateId: false,
    });
    const positive = [...shape.positives.keys()];
    const debtor = [...shape.debts.keys()][0] ?? '';
    pkg = await packageOf('money.nxpkg', {
      'records/wallet_history_checks.jsonl': [
        historyCheck(
          positive[0] ?? '',
          'MATCHES_SNAPSHOT',
          String(shape.positives.get(positive[0] ?? '')),
          String(shape.positives.get(positive[0] ?? '')),
        ),
        // The history ends elsewhere than the snapshot: reported, never applied.
        historyCheck(debtor, 'HISTORY_DIFFERS', `-${String(shape.debts.get(debtor))}`, '1000'),
      ],
    });
  }, 600_000);

  afterAll(async () => {
    await rig?.closePanels();
    await ctx?.close();
    for (const dir of [work, migrationRoot]) await rm(dir, { recursive: true, force: true });
  });

  async function ledger() {
    const rows = (
      await db().execute<{ tg: string; amount: string; direction: string; reason: string }>(
        `SELECT c.telegram_user_id AS tg, w.amount::text AS amount, w.direction, w.reason
           FROM wallet_entries w JOIN customers c ON c.id = w.customer_id
          WHERE w.tenant_id = '${TENANT}'` as never,
      )
    ).rows;
    return rows;
  }

  async function debts() {
    return (
      await db().execute<{ tg: string; amount: string; state: string }>(
        `SELECT legacy_user_id AS tg, amount_minor::text AS amount, state
           FROM legacy_wallet_debts WHERE tenant_id = '${TENANT}'` as never,
      )
    ).rows;
  }

  async function assertMoneyExact(): Promise<void> {
    const entries = await ledger();
    expect(entries).toHaveLength(POSITIVES);
    expect(entries.every((e) => e.direction === 'CREDIT')).toBe(true);
    expect(entries.every((e) => e.reason === 'MIGRATION_OPENING_BALANCE')).toBe(true);
    expect(entries.reduce((a, e) => a + BigInt(e.amount), 0n)).toBe(MONEY_SHAPE_POSITIVE_SUM);
    // Per customer: each positive customer holds exactly their legacy balance, once.
    for (const e of entries) expect(BigInt(e.amount), e.tg).toBe(shape.positives.get(e.tg));
    expect(new Set(entries.map((e) => e.tg)).size).toBe(POSITIVES);

    const recorded = await debts();
    expect(recorded).toHaveLength(MONEY_SHAPE_DEBTS);
    expect(recorded.reduce((a, d) => a + BigInt(d.amount), 0n)).toBe(MONEY_SHAPE_DEBT_SUM);
    for (const d of recorded) {
      expect(BigInt(d.amount), d.tg).toBe(shape.debts.get(d.tg));
      // Review-only: never collected, never decided by the import.
      expect(d.state).toBe('PENDING_REVIEW');
    }
    // No ledger effect for a debt: a debtor has no wallet entry at all.
    expect(entries.some((e) => shape.debts.has(e.tg))).toBe(false);
    // Held rows: no customer, no entry, no debt; one review row each.
    for (const h of shape.held) {
      expect(await rig.count('customers', `telegram_user_id = '${h.id}'`), h.why).toBe(0);
    }
    expect(
      await rig.count('legacy_import_map', "legacy_table = 'user' AND status = 'MANUAL_REVIEW'"),
    ).toBe(shape.held.length);
    expect(await rig.count('customers')).toBe(POSITIVES + MONEY_SHAPE_DEBTS + ZEROS);
    expect(await rig.count('customers', "status = 'BLOCKED'")).toBe(shape.blocked.size);
  }

  async function tickUntilDone(
    id: string,
    executor: ReturnType<typeof rigExecutor>,
  ): Promise<string> {
    for (let i = 0; i < 8; i += 1) {
      await executor.tick();
      const status = (await rig.detail(id)).status;
      if (!['APPROVED', 'APPLYING'].includes(status)) return status;
    }
    return (await rig.detail(id)).status;
  }

  it('imports exactly: 2,986,130,847 credited per customer, 38 debts review-only, held rows reported; a crash after the openings resumes with no double credit', async () => {
    await rig.freshTenant(generated.liveAccounts);
    let armed = false;
    let crashed = 0;
    const executor = rigExecutor(ctx, {
      importer: (importer) =>
        withAfterPhase(importer, (phase) => {
          if (armed && phase === 'openings' && crashed === 0) {
            crashed += 1;
            throw new Error('simulated crash after the openings phase');
          }
        }),
    });
    const id = await rig.prepare(pkg, executor);

    // The dry run: the converter agreed customer by customer (it is APPROVED), and the wallet
    // history's contradiction is a warning, not a refusal.
    const dry = await rig.detail(id);
    const warnings = new Map((dry.dryRunReport?.warnings ?? []).map((w) => [w.code, w.count]));
    expect(warnings.get('WALLET_HISTORY_NOT_MATCHING_SNAPSHOT')).toBe(1);
    expect(warnings.get('WALLET_HISTORY_CHECK:HISTORY_DIFFERS')).toBe(1);
    expect(warnings.has('CONVERTER_TOTALS_ABSENT')).toBe(false);
    expect(dry.dryRunReport?.wallets.afterTotalMinor).toBe(MONEY_SHAPE_POSITIVE_SUM.toString());
    expect(dry.dryRunReport?.debts).toMatchObject({
      count: MONEY_SHAPE_DEBTS,
      totalMinor: MONEY_SHAPE_DEBT_SUM.toString(),
    });

    armed = true;
    await executor.tick();
    expect(crashed).toBe(1);
    expect((await rig.detail(id)).status).toBe('APPLYING');
    // The openings phase finished before the crash: the money is all there, once.
    await assertMoneyExact();

    const status = await tickUntilDone(id, executor);
    const done = await rig.detail(id);
    expect(['COMPLETED', 'COMPLETED_WITH_DISCREPANCY'], JSON.stringify(done)).toContain(status);
    // The resume found every opening and debt already recorded: the same totals, no double.
    await assertMoneyExact();
    expect(await rig.count('legacy_import_runs', "mode = 'APPLY' AND status = 'COMPLETED'")).toBe(
      1,
    );
    // The report's money sections hold (U1–U10 inside usersWallets; WALLETS_RECONCILED).
    expect(done.applyReport?.failedSections ?? ['none']).not.toContain('usersWallets');
    expect(done.applyReport?.failedInvariants ?? ['none']).not.toContain('WALLETS_RECONCILED');
    expect(done.applyReport?.reconcileVerdict).toBe('RECONCILED');
    expect(rig.providerWrites()).toEqual([]);
  }, 600_000);

  it('an APPLY that fails after the openings were written ends FAILED; restoring the protective backup returns the wallet to its pre-import state', async () => {
    await rig.freshTenant(generated.liveAccounts);
    const dump = join(work, 'protective.dump');
    const url = testConfig().DATABASE_URL;
    let before: Awaited<ReturnType<typeof databaseFingerprint>> | null = null;
    let armed = false;
    const executor = rigExecutor(ctx, {
      backup: {
        // The protective backup, taken before the import's first write: a whole-database
        // dump, with the state it holds fingerprinted at the same moment.
        runBeforeImport: async () => {
          before = await databaseFingerprint(db());
          await run('pg_dump', ['--format=custom', '--no-owner', '--file', dump, url]);
          return { outcome: 'TAKEN', runId: RIG_PRE_IMPORT_BACKUP_RUN };
        },
      },
      importer: (importer) =>
        withAfterPhase(importer, (phase) => {
          if (armed && phase === 'openings') throw new Error('injected failure after openings');
        }),
      // The failure is a VERDICT (not a crash the executor resumes): the apply step fails.
      runner: (real) =>
        overriding(real, {
          apply: async (context, input) => {
            try {
              return await real.apply(context, input);
            } catch (error) {
              // The injected failure after the openings phase, whatever the importer wrapped
              // it in: the step's verdict, never a crash to resume.
              if (armed) {
                throw new LegacyMigrationStepFailure('IMPORT_FAILED', 'injected', {
                  cause: error,
                });
              }
              throw error;
            }
          },
        }),
    });
    const id = await rig.prepare(pkg, executor);
    armed = true;
    await executor.tick();
    expect(await rig.row(id)).toMatchObject({ status: 'FAILED', error_code: 'IMPORT_FAILED' });
    expect(before).not.toBeNull();
    // The openings WERE written: the failure came after them.
    await assertMoneyExact();
    expect(await rig.count('legacy_import_runs', "mode = 'APPLY' AND status = 'RUNNING'")).toBe(1);

    // Restore the protective backup (into this test database: see the header).
    await run('pg_restore', [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--single-transaction',
      '--dbname',
      url,
      dump,
    ]);
    const after = await databaseFingerprint(db());
    // Every table is exactly as the backup found it — the ledger and the debts among them.
    expect(changedTables(before ?? {}, after)).toEqual({});
    expect(await ledger()).toEqual([]);
    expect(await debts()).toEqual([]);
    expect(await rig.count('customers')).toBe(0);
    expect(await rig.count('legacy_import_runs', "mode = 'APPLY'")).toBe(0);
  }, 600_000);

  it("a converter whose reading of a snapshot balance is not the importer's blocks the dry run", async () => {
    await rig.freshTenant(generated.liveAccounts);
    const positive = [...shape.positives.keys()][1] ?? '';
    const amount = shape.positives.get(positive) ?? 0n;
    const disputed = await packageOf('disputed.nxpkg', {
      'records/wallet_history_checks.jsonl': [
        historyCheck(positive, 'MATCHES_SNAPSHOT', String(amount + 1n), String(amount + 1n)),
      ],
    });
    const lines: { level: string; context: Record<string, unknown>; message: string }[] = [];
    const executor = rigExecutor(ctx, { lines: lines as never });
    const id = await rig.upload(disputed.path);
    await rig.setKey(id, { keyFileText: disputed.keyFileText });
    await executor.tick();
    expect((await rig.detail(id)).status, JSON.stringify(lines)).toBe('VERIFIED');
    await rig.bind(id);
    await rig.requestDryRun(id);
    await executor.tick();
    const failed = await rig.detail(id);
    expect(failed).toMatchObject({ status: 'DRY_RUN_FAILED', errorCode: 'DRY_RUN_MISMATCH' });
    expect(failed.progress.refusalCounts).toEqual([
      { code: 'wallet_history:snapshot_disagrees', count: 1 },
    ]);
    expect(await rig.count('customers')).toBe(0);
    expect(await rig.count('wallet_entries')).toBe(0);
  }, 600_000);
});
