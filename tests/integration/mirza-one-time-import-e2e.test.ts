import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemJobActor, type CorrelationId } from '@nexa/contracts';
import { createTestContext, tenantA, type TestContext } from './harness';
import {
  MigrationRig,
  TENANT,
  generateDataset,
  moneyOfSnapshot,
  paymentRecords,
  rigExecutor,
  writeMigrationPackage,
  type GeneratedDataset,
  type MigrationPackage,
} from '../support/legacy-migration-rig';

/**
 * The one-time Mirza import, end to end (owner decision 2026-10-17,
 * `docs/migration/mirza-import-plan-fa.md` §9.8).
 *
 * A synthetic Mirza backup (positive, negative and zero balances; live and removed invoices;
 * payment history) is packaged exactly as the converter writes a `.nxpkg`, and taken through
 * the Web Admin's own flow — upload, key, verify, panel binding, dry run, the owner's
 * approval — by the service the Web Admin controllers call, then imported by the `migration`
 * role over two fake RickPanel servers. What the owner was promised is asserted from the
 * database, not from the report alone:
 *
 * - every final wallet balance is exactly the Mirza `Balance` (negative included);
 * - every Mirza table is in the exact-match report and every row of it holds, so the import
 *   is COMPLETE; the imported customers are linked to the active bot, with their count;
 * - the history is in the normal tables, marked MIRZA: customers, adopted and ended
 *   services, invoice orders, payments;
 * - not one request that is not a read reached a panel;
 * - running MATERIALIZE again writes nothing and changes no count and no balance.
 *
 * SYNTHETIC data only. NOT EVIDENCE.
 */
const USERS = 60;
const INVOICES = 40;

describe('the one-time Mirza import, end to end', () => {
  let ctx: TestContext;
  let work: string;
  let migrationRoot: string;
  let rig: MigrationRig;
  let generated: GeneratedDataset;
  let pkg: MigrationPackage;
  let importId: string;
  const payments = { n: 0 };

  const db = () => ctx.container.database.db;
  const rows = async <T>(query: ReturnType<typeof sql>) =>
    (await db().execute(query)).rows as unknown as T[];

  /** Every customer's derived balance, by Telegram id. */
  async function balances(): Promise<Map<string, bigint>> {
    const r = await rows<{ tg: string; balance: string }>(sql`
      SELECT c.telegram_user_id::text AS tg,
             COALESCE(SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END), 0)::text
               AS balance
        FROM customers c LEFT JOIN wallet_entries e
          ON e.tenant_id = c.tenant_id AND e.customer_id = c.id
       WHERE c.tenant_id = ${TENANT}
       GROUP BY c.telegram_user_id`);
    return new Map(r.map((x) => [x.tg, BigInt(x.balance)]));
  }

  /** The counts and sums a rerun must leave exactly as they are. */
  async function footprint(): Promise<Record<string, string>> {
    const [r] = await rows<Record<string, string>>(sql`
      SELECT
        (SELECT count(*) FROM customers WHERE tenant_id = ${TENANT})::text AS customers,
        (SELECT count(*) FROM wallet_entries WHERE tenant_id = ${TENANT})::text AS wallet_entries,
        (SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)
           FROM wallet_entries WHERE tenant_id = ${TENANT})::text AS ledger,
        (SELECT count(*) FROM orders WHERE tenant_id = ${TENANT})::text AS orders,
        (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE tenant_id = ${TENANT})::text
          AS order_total,
        (SELECT count(*) FROM services WHERE tenant_id = ${TENANT})::text AS services,
        (SELECT count(*) FROM payments WHERE tenant_id = ${TENANT})::text AS payments,
        (SELECT count(*) FROM provisioning_operations WHERE tenant_id = ${TENANT})::text
          AS provisioning,
        (SELECT count(*) FROM customer_notifications WHERE tenant_id = ${TENANT})::text
          AS notifications`);
    return r ?? {};
  }

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'mirza-e2e-'));
    migrationRoot = await mkdtemp(join(tmpdir(), 'mirza-e2e-root-'));
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      LEGACY_MIGRATION_ENABLED: 'true',
      LEGACY_MIGRATION_WORK_DIR: migrationRoot,
      BACKUP_WORK_DIR: work,
    });
    rig = new MigrationRig(ctx, migrationRoot);
    generated = generateDataset({ users: USERS, invoices: INVOICES });
    pkg = await writeMigrationPackage(join(work, 'mirza.nxpkg'), {
      dataset: generated.dataset,
      invoices: generated.invoices,
      history: {
        'records/payments.jsonl': [...paymentRecords(generated.users, 3)].map((r) => {
          payments.n += 1;
          return r;
        }),
      },
    });
    await rig.freshTenant(generated.liveAccounts);
    const executor = rigExecutor(ctx);
    importId = await rig.prepare(pkg, executor);
    await executor.tick();
  }, 900_000);

  afterAll(async () => {
    await rig?.closePanels();
    await ctx?.close();
    for (const dir of [work, migrationRoot]) await rm(dir, { recursive: true, force: true });
  });

  it('is COMPLETE: every Mirza table is in the exact-match report and every row of it holds', async () => {
    const detail = await rig.detail(importId);
    const report = detail.applyReport;
    expect(report?.exactMatch?.unexplained, JSON.stringify(report?.exactMatch)).toBe(0);
    expect(report?.exactMatch?.holds).toBe(true);
    expect(detail.status).toBe('COMPLETED');
    const tables = (report?.exactMatch?.rows ?? []).map((r) => `${r.mirzaTable}>${r.nexaTable}`);
    for (const t of [
      'user>customers',
      'user.Balance>wallet_entries',
      'invoice>services',
      'invoice>orders',
      'Payment_report>payments',
      'wallet_transaction>wallet_history_imports',
      'product>products',
      'agent>resellers',
      'discount>discounts',
      'reagent_report>referrals',
    ]) {
      expect(tables, t).toContain(t);
    }
    for (const row of report?.exactMatch?.rows ?? [])
      expect(row.holds, JSON.stringify(row)).toBe(true);
  });

  it('every final wallet balance is exactly the Mirza Balance, negative and zero included', async () => {
    const money = moneyOfSnapshot(pkg.parts);
    const got = await balances();
    expect(got.size).toBe(USERS);
    let negatives = 0;
    for (const user of generated.users) {
      const tg = String(user['id']);
      const mirza = BigInt(String(user['Balance']));
      if (mirza < 0n) negatives += 1;
      expect(got.get(tg), tg).toBe(mirza);
    }
    expect(negatives).toBe(money.negative.count);
    expect(negatives).toBeGreaterThan(0);
    // No legacy-debt side record: a negative balance is the wallet balance itself.
    expect(await rig.count('legacy_wallet_debts')).toBe(0);
  });

  it('links the imported customers to the active bot, and says how many', async () => {
    const link = (await rig.detail(importId)).applyReport?.botLink;
    expect(link?.outcome).toBe('LINKED');
    expect(link?.linked).toBe(USERS);
    expect(await rig.count('customers', 'first_bot_instance_id IS NULL')).toBe(0);
  });

  it('puts the history in the normal tables, marked MIRZA, and nothing else', async () => {
    const live = generated.invoices.filter((i) => i.live).length;
    expect(await rig.count('customers', "source = 'MIRZA'")).toBe(USERS);
    // Every invoice is a service: adopted when its account is on the panel, ENDED when not.
    expect(await rig.count('services', "source = 'MIRZA'")).toBe(INVOICES);
    expect(await rig.count('services', "source = 'MIRZA' AND state = 'TERMINATED'")).toBe(
      INVOICES - live,
    );
    expect(await rig.count('orders', "source = 'MIRZA'")).toBe(INVOICES);
    expect(await rig.count('payments', "source = 'MIRZA'")).toBe(payments.n);
    expect(await rig.count('payments', "source = 'NEXA'")).toBe(0);
    // History is never a sale and starts nothing.
    expect(await rig.count('orders', "origin = 'STANDARD'")).toBe(0);
    expect(await rig.count('provisioning_operations')).toBe(0);
    expect(await rig.count('customer_notifications')).toBe(0);
  });

  it('wrote nothing to any panel', () => {
    expect(rig.providerWrites()).toEqual([]);
  });

  it('a second MATERIALIZE writes nothing and changes no count, sum or balance', async () => {
    const before = await footprint();
    const balancesBefore = await balances();
    const step = {
      ...(await rig.row(importId)),
    } as Record<string, unknown>;
    const outcomes = await ctx.container.legacyMaterializePort.apply({
      scope: tenantA,
      actor: systemJobActor('mirza-e2e', 'corr-mirza-e2e' as CorrelationId),
      importId,
      packageImportId: String(step['package_import_id']),
      sourceFingerprint: String(step['package_source_fingerprint']),
    } as never);
    for (const o of outcomes) {
      expect(o.written, o.step).toBe(0);
      expect(o.diverged, o.step).toBe(0);
    }
    expect(await footprint()).toEqual(before);
    expect(await balances()).toEqual(balancesBefore);
  });
});
