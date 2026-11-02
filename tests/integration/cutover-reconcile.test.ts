import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TargetRefused,
  parseReconcileArgs,
  runCutoverReconcile,
} from '../../apps/api/src/cutover-reconcile.cli';
import { checkMigrations } from '../../apps/api/src/infrastructure/persistence/migrate';
import {
  MigrationRig,
  TENANT,
  generateDataset,
  mirzaAgentRecords,
  rigExecutor,
  writeMigrationPackage,
  type GeneratedDataset,
  type MigrationPackage,
} from '../support/legacy-migration-rig';
import { createTestContext, type TestContext } from './harness';

/**
 * `pnpm cutover-reconcile` over a REAL import: a synthetic Mirza `.nxpkg` goes through the
 * whole executor (dry run, apply, history, materialize — agents become resellers), and the
 * cutover's reconciliation then reads the package and this test database and must say
 * RECONCILED. Then, one at a time, the conditions it exists to catch are put into the
 * database by hand, and each must be named: agent credit in a wallet, a wallet one Toman off,
 * a reseller credit limit, a customer Mirza never had.
 *
 * The reconciliation itself must write nothing: the database's footprint is the same before
 * and after every run. SYNTHETIC data only. NOT EVIDENCE.
 */

const USERS = 30;
const INVOICES = 12;
const AGENTS = [
  { i: 1, tier: 'n', cap: '5000000' },
  { i: 4, tier: 'n2', cap: null },
] as const;

describe('cutover-reconcile over an imported .nxpkg', () => {
  let ctx: TestContext;
  let work: string;
  let migrationRoot: string;
  let rig: MigrationRig;
  let generated: GeneratedDataset;
  let pkg: MigrationPackage;
  let databaseUrl: string;
  let database: string;

  const db = () => ctx.container.database.db;

  async function footprint(): Promise<string> {
    const r = await db().execute(sql`
      SELECT (SELECT count(*) FROM customers)::text || '|' ||
             (SELECT count(*) FROM wallet_entries)::text || '|' ||
             (SELECT coalesce(sum(amount), 0) FROM wallet_entries)::text || '|' ||
             (SELECT count(*) FROM resellers)::text || '|' ||
             (SELECT count(*) FROM audit_logs)::text || '|' ||
             (SELECT count(*) FROM outbox_messages)::text || '|' ||
             (SELECT count(*) FROM customer_notifications)::text AS v`);
    return String((r.rows[0] as { v: string }).v);
  }

  async function reconcile(extra: readonly string[] = []) {
    const args = parseReconcileArgs([
      '--package',
      pkg.path,
      '--package-key-env',
      'CUTOVER_TEST_KEY',
      '--database',
      database,
      '--work-dir',
      work,
      '--json',
      '--list-differences',
      ...extra,
    ]);
    let text = '';
    const before = await footprint();
    const code = await runCutoverReconcile(
      args,
      { DATABASE_URL: databaseUrl, CUTOVER_TEST_KEY: pkg.keyFileText },
      (t) => {
        text += t;
      },
    );
    expect(await footprint(), 'the reconciliation changed the database').toBe(before);
    return { code, report: JSON.parse(text) as Record<string, any> };
  }

  const tgOf = (i: number) => String(generated.users[i]!['id']);
  async function customerIdOf(i: number): Promise<string> {
    const r = await db().execute(
      sql`SELECT id FROM customers WHERE tenant_id = ${TENANT} AND telegram_user_id = ${tgOf(i)}`,
    );
    return String((r.rows[0] as { id: string }).id);
  }

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'cutover-rec-'));
    migrationRoot = await mkdtemp(join(tmpdir(), 'cutover-rec-root-'));
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      LEGACY_MIGRATION_ENABLED: 'true',
      LEGACY_MIGRATION_WORK_DIR: migrationRoot,
      BACKUP_WORK_DIR: work,
    });
    databaseUrl = String(process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']);
    database = new URL(databaseUrl).pathname.slice(1);
    rig = new MigrationRig(ctx, migrationRoot);
    generated = generateDataset({ users: USERS, invoices: INVOICES });
    // Mirza marks an agent in `user.agent` with its tier, as the deployed bot does.
    for (const a of AGENTS) (generated.users[a.i] as Record<string, unknown>)['agent'] = a.tier;
    const agents = mirzaAgentRecords(generated.users, AGENTS);
    pkg = await writeMigrationPackage(join(work, 'mirza.nxpkg'), {
      dataset: generated.dataset,
      invoices: generated.invoices,
      history: {
        'records/agents/profiles.jsonl': agents.profiles,
        'records/agents/state.jsonl': agents.states,
      },
    });
    await rig.freshTenant(generated.liveAccounts);
    const executor = rigExecutor(ctx);
    const id = await rig.prepare(pkg, executor);
    await executor.tick();
    const view = await rig.detail(id);
    if (view.status !== 'COMPLETED')
      throw new Error(`import: ${view.status} ${String(view.errorCode)}`);
  }, 900_000);

  afterAll(async () => {
    await rig?.closePanels();
    await ctx?.close();
    for (const dir of [work, migrationRoot]) await rm(dir, { recursive: true, force: true });
  });

  it('the migration check reads current on the migrated test database', async () => {
    const verdict = await checkMigrations(databaseUrl);
    expect(verdict.state).toBe('current');
  });

  it('RECONCILED after the import: every wallet is the Mirza balance; agent credit only listed', async () => {
    const { code, report } = await reconcile();
    expect(report['differences'], JSON.stringify(report['differenceCounts'])).toEqual([]);
    expect(report['verdict']).toBe('RECONCILED');
    expect(code).toBe(0);
    expect(report['mirza'].rows).toBe(USERS);
    expect(report['matched'].rows).toBe(USERS);
    expect(report['matched'].sumMinor).toBe(report['mirza'].readable.sumMinor);
    expect(report['nexa'].wallets.sumMinor).toBe(report['mirza'].readable.sumMinor);
    expect(report['nexa'].negativeWallets.rows).toBe(report['mirza'].negative.rows);
    expect(report['agents']).toMatchObject({
      mirzaAgents: AGENTS.length,
      agentsMatched: AGENTS.length,
      creditListedNotCredited: { rows: 1, sumMinor: '5000000' },
      resellersFromMirza: AGENTS.length,
    });
  });

  it('names agent credit that reached a wallet, then a wallet one Toman off', async () => {
    const agent = await customerIdOf(AGENTS[0].i);
    const now = ctx.container.clock.now();
    await db().execute(sql`
      INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount, currency,
                                  reference, created_at)
      VALUES (${ctx.container.ids.uuid()}, ${TENANT}, ${agent}, 'CREDIT', 'ADMIN_CREDIT', 5000000,
              'IRT', 'test:agent-credit-as-money', ${now})`);
    const credited = await reconcile();
    expect(credited.code).toBe(3);
    expect(credited.report['verdict']).toBe('DIFFERENCES');
    expect(credited.report['differenceCounts'].AGENT_CREDIT_IN_WALLET).toBe(1);
    expect(credited.report['differences'][0]).toMatchObject({
      kind: 'AGENT_CREDIT_IN_WALLET',
      customerId: agent,
    });

    const plain = await customerIdOf(10);
    await db().execute(sql`
      INSERT INTO wallet_entries (id, tenant_id, customer_id, direction, reason, amount, currency,
                                  reference, created_at)
      VALUES (${ctx.container.ids.uuid()}, ${TENANT}, ${plain}, 'CREDIT', 'ADMIN_CREDIT', 1,
              'IRT', 'test:one-toman', ${now})`);
    const off = await reconcile();
    expect(off.report['differenceCounts'].BALANCE_DIFFERS).toBe(1);
    expect(off.report['differences']).toContainEqual(
      expect.objectContaining({
        kind: 'BALANCE_DIFFERS',
        customerId: plain,
        nexaMinor: expect.any(String),
      }),
    );
    expect(off.report['nexa'].nonOpeningEntries).toBe(2);
  });

  it('names a reseller credit limit and a customer Mirza never had', async () => {
    await db().execute(sql`
      UPDATE resellers SET credit_limit_amount = 100000, credit_limit_currency = 'IRT'
       WHERE tenant_id = ${TENANT} AND customer_id = ${await customerIdOf(AGENTS[1].i)}`);
    await db().execute(sql`
      INSERT INTO customers (id, tenant_id, telegram_user_id)
      VALUES (${ctx.container.ids.uuid()}, ${TENANT}, '777000111')`);
    const { code, report } = await reconcile();
    expect(code).toBe(3);
    expect(report['differenceCounts'].RESELLER_CREDIT_LIMIT).toBe(1);
    expect(report['differenceCounts'].NOT_IN_MIRZA).toBe(1);
  });

  it('refuses a production-like database name before it opens anything', async () => {
    const args = parseReconcileArgs([
      '--package',
      pkg.path,
      '--package-key-env',
      'CUTOVER_TEST_KEY',
      '--database',
      'nexa',
    ]);
    await expect(
      runCutoverReconcile(
        args,
        { DATABASE_URL: databaseUrl, CUTOVER_TEST_KEY: pkg.keyFileText },
        () => {},
      ),
    ).rejects.toBeInstanceOf(TargetRefused);
  });
});
