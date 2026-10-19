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

/**
 * The agents: Mirza user index -> tier, cap (`maxbuyagent`) and `pricediscount`. Index 3 has a
 * NEGATIVE Balance and index 7 a zero one (see `generateDataset`); the last row is the fork's
 * `NOT_AGENT_IN_USER_TABLE`, rightly skipped.
 */
const AGENTS: readonly { i: number; tier: string; cap: string | null; percent: string | null }[] = [
  { i: 1, tier: 'n', cap: '5000000', percent: '20' },
  { i: 2, tier: 'n2', cap: null, percent: null },
  { i: 3, tier: 'n', cap: '900000', percent: '10' },
  { i: 7, tier: 'n2', cap: '1', percent: '100' },
  { i: 5, tier: 'NOT_AGENT_IN_USER_TABLE', cap: '777', percent: null },
];
const agentFlagsOff = {
  affects_wallet: false,
  applies_to_live_state: false,
  grants_credit: false,
  activates_role: false,
  redeemable: false,
  auto_create: false,
};
const agentCustomer = (tg: string) => ({
  raw_id: tg,
  telegram_user_id: tg,
  decision: 'IMPORT',
  valid: true,
});
function agentRecords(users: readonly Record<string, unknown>[]) {
  const profiles = AGENTS.map((a) => {
    const tg = String(users[a.i]!['id']);
    return {
      record_type: 'legacy_agent_profile',
      schema: 'm2n.agents.profile.v1',
      idempotency_key: `legacy:agents:profile:${tg}`,
      customer: agentCustomer(tg),
      tier: a.tier,
      status: 'ARCHIVED_NOT_ACTIVATED',
      limits_and_credit: 'RAW_ONLY_NOT_APPLIED',
      ...agentFlagsOff,
    };
  });
  const states = AGENTS.map((a) => {
    const tg = String(users[a.i]!['id']);
    return {
      record_type: 'legacy_agent_state',
      schema: 'm2n.agents.state.v1',
      idempotency_key: `legacy:agents:state:${tg}`,
      customer: agentCustomer(tg),
      credit_debt: {
        overdraft_limit_raw: a.cap,
        overdraft_limit_staged: true,
        credit_granted: false,
        values: 'RAW_ONLY_NOT_APPLIED',
      },
      pricing: {
        percent_discount_raw: a.percent,
        percent_discount_staged: a.percent !== null,
        applies_price: false,
      },
      current_status: {
        agent_expiry: null,
        agent_expiry_raw: null,
        agent_expiry_note: 'NO_EXPIRY',
      },
      role_active: false,
      ...agentFlagsOff,
    };
  });
  return { profiles, states };
}

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
    const agents = agentRecords(generated.users);
    pkg = await writeMigrationPackage(join(work, 'mirza.nxpkg'), {
      dataset: generated.dataset,
      invoices: generated.invoices,
      history: {
        'records/payments.jsonl': [...paymentRecords(generated.users, 3)].map((r) => {
          payments.n += 1;
          return r;
        }),
        'records/agents/profiles.jsonl': agents.profiles,
        'records/agents/state.jsonl': agents.states,
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

  it('imports the agents as resellers with no credit at all, and their wallet is exactly the Mirza Balance', async () => {
    const imported = await rows<{
      tg: string;
      status: string;
      credit: string | null;
      tier_credit: string;
      cap: string | null;
      pricing_mode: string;
      percent: number | null;
    }>(sql`
      SELECT c.telegram_user_id::text AS tg, r.status, r.credit_limit_amount::text AS credit,
             t.credit_limit_amount::text AS tier_credit, r.imported_purchase_cap_minor::text AS cap,
             r.pricing_mode, r.discount_percentage AS percent
        FROM resellers r
        JOIN customers c ON c.tenant_id = r.tenant_id AND c.id = r.customer_id
        JOIN reseller_tiers t ON t.tenant_id = r.tenant_id AND t.id = r.tier_id
       WHERE r.tenant_id = ${TENANT} AND r.source = 'MIRZA'
       ORDER BY c.telegram_user_id`);
    const agents = AGENTS.filter((a) => a.tier === 'n' || a.tier === 'n2');
    // Every agent tier is carried; NOT_AGENT_IN_USER_TABLE is not.
    expect(imported).toHaveLength(agents.length);
    const skipped = String(generated.users[5]!['id']);
    expect(imported.map((r) => r.tg)).not.toContain(skipped);

    const got = await balances();
    const ids = await rows<{ tg: string; id: string }>(sql`
      SELECT telegram_user_id::text AS tg, id FROM customers WHERE tenant_id = ${TENANT}`);
    const idOf = new Map(ids.map((r) => [r.tg, r.id]));
    for (const a of agents) {
      const user = generated.users[a.i]!;
      const tg = String(user['id']);
      const r = imported.find((x) => x.tg === tg);
      expect(r, tg).toBeDefined();
      expect(r!.status).toBe('ACTIVE');
      // No credit limit of any kind: none of its own, a zero tier limit, a zero allowance ...
      expect(r!.credit, tg).toBeNull();
      expect(BigInt(r!.tier_credit), tg).toBe(0n);
      expect(
        await ctx.container.resellers.creditAllowance(tenantA, idOf.get(tg)!, 'IRT', null),
        tg,
      ).toBe(0n);
      // ... maxbuyagent became no NEXA field ...
      expect(r!.cap, tg).toBeNull();
      // ... the discount percentage is the reseller's own override when it is 1..99 ...
      const percent = a.percent === null ? null : Number(a.percent);
      if (percent !== null && percent >= 1 && percent <= 99) {
        expect(r).toMatchObject({ pricing_mode: 'PERCENTAGE_DISCOUNT', percent });
      } else {
        expect(r).toMatchObject({ pricing_mode: 'TIER', percent: null });
      }
      // ... and the wallet is exactly the Mirza Balance: the cap added nothing.
      expect(got.get(tg), tg).toBe(BigInt(String(user['Balance'])));
    }
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
