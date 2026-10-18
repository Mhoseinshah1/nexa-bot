import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemJobActor, type CorrelationId } from '@nexa/contracts';
import { exactMatchHolds } from '../../apps/api/src/modules/platform/legacy-materialize/application/ports';
import type { MaterializeContext } from '../../apps/api/src/modules/platform/legacy-materialize/application/ports';
import {
  MigrationRig,
  TENANT,
  generateDataset,
  writeMigrationPackage,
  type GeneratedDataset,
} from '../support/legacy-migration-rig';
import { createTestContext, tenantA, type TestContext } from './harness';

/**
 * The one-time Mirza import, NEVER-PAID invoices (owner instruction 2026-10-18): an invoice
 * that was never paid — `unpaid`, `Unsuccessful`, or no status — is imported as a
 * `LEGACY_HISTORY` order, EXPIRED or CANCELLED, marked MIRZA under `invoice-never-paid:<id>`,
 * at its own amount and date, and NOTHING else: no service, payment, ledger entry, event or
 * notice. One whose order cannot be written honestly (no usable key, owner, panel or product)
 * is a counted gap with its own reason. The exact-match report counts the orders as NEXA's
 * rows and never adds their amounts to the paid money.
 *
 * Driven through the REAL lifecycle (operator service + the container's `migration` executor
 * over fake RickPanels), so the step reads exactly what the importer left. SYNTHETIC. NOT
 * EVIDENCE.
 */

const USERS = 40;
const INVOICES = 40;
const PRICE = 150_000n;
const SOLD_AT_BASE = 1_700_000_000;

/** The never-paid invoices that become orders, and the state each one is recorded in. */
const WRITTEN: Readonly<Record<string, 'EXPIRED' | 'CANCELLED'>> = {
  unpaid: 'EXPIRED',
  failed: 'CANCELLED',
  nostatus: 'EXPIRED',
  unpaidnoprice: 'EXPIRED',
  unpaidnodate: 'EXPIRED',
};
/** The never-paid invoices that cannot be an order, and the gap each one is counted under. */
const NOT_WRITTEN: Readonly<Record<string, string>> = {
  unpaidnopanel: 'NEVER_PAID_NO_PANEL',
  unpaidunmapped: 'NEVER_PAID_PANEL_NOT_MAPPED',
  unpaidshape: 'NEVER_PAID_SHAPE_UNMAPPABLE',
  unpaidnewshape: 'NEVER_PAID_PRODUCT_NOT_RESOLVED',
  unpaidorphan: 'NEVER_PAID_OWNER_NOT_IMPORTED',
  unpaidbadkey: 'NEVER_PAID_KEY_INVALID',
};
const NEVER_PAID = Object.keys(WRITTEN).length + Object.keys(NOT_WRITTEN).length; // 11

describe('never-paid Mirza invoices: an order and nothing else, or a counted gap', () => {
  let ctx: TestContext;
  let work: string;
  let migrationRoot: string;
  let rig: MigrationRig;
  let generated: GeneratedDataset;
  let importId: string;
  let sourceFingerprint: string;
  /** what the test did → the invoice key (after the change) and its index in the dataset. */
  const names: Record<string, { key: string; index: number }> = {};

  const db = () => ctx.container.database.db;
  const step = () => ctx.container.legacyEndedServices;
  const context = (): MaterializeContext => ({
    scope: tenantA,
    actor: systemJobActor('legacy-materialize:test', 'corr-never-paid-1' as CorrelationId),
    packageImportId: importId,
    sourceFingerprint,
    now: new Date('2026-10-18T00:00:00.000Z'),
  });
  const scalar = async (query: string): Promise<string> => {
    const r = await db().execute<{ v: string }>(sql.raw(query));
    return String(r.rows[0]?.v ?? '');
  };
  /** Every table and figure a never-paid order must NEVER move, counted. */
  const untouched = async (): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    for (const table of [
      'services',
      'payments',
      'wallet_entries',
      'outbox_messages',
      'customer_notifications',
      'provisioning_operations',
      'service_username_reservations',
      'panel_capacity_reservations',
      'service_reminders',
      'discount_redemptions',
    ]) {
      out[table] = await scalar(`SELECT count(*)::int AS v FROM ${table}`);
    }
    out['balances'] = await scalar(
      `SELECT coalesce(string_agg(c || ':' || b, ',' ORDER BY c), '') AS v FROM (
         SELECT customer_id::text AS c,
                sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END)::text AS b
           FROM wallet_entries GROUP BY customer_id) w`,
    );
    return out;
  };
  const neverPaidRows = async () =>
    (
      await db().execute<{
        source_ref: string;
        state: string;
        purpose: string;
        source: string;
        total: string;
        created: string;
        created_is_updated: boolean;
        settled_at: Date | null;
        cancelled_at: Date | null;
        confirmed_at: Date | null;
        expires_at: Date | null;
        shape_product: boolean;
      }>(
        sql`SELECT o.source_ref, o.state, o.purpose, o.source, o.total_amount::text AS total,
                   extract(epoch FROM o.created_at)::bigint::text AS created,
                   o.created_at = o.updated_at AS created_is_updated,
                   o.settled_at, o.cancelled_at, o.confirmed_at, o.expires_at,
                   EXISTS (SELECT 1 FROM legacy_product_shapes s
                            WHERE s.tenant_id = o.tenant_id AND s.product_id = o.product_id)
                     AS shape_product
              FROM orders o
             WHERE o.tenant_id = ${TENANT} AND o.origin = 'LEGACY_HISTORY'
               AND o.source_ref LIKE 'invoice-never-paid:%'
             ORDER BY o.source_ref`,
      )
    ).rows;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'lnp-'));
    migrationRoot = await mkdtemp(join(tmpdir(), 'lnp-root-'));
    ctx = await createTestContext({
      PANEL_HTTP_ALLOW_LOOPBACK: 'true',
      LEGACY_MIGRATION_ENABLED: 'true',
      LEGACY_MIGRATION_WORK_DIR: migrationRoot,
      BACKUP_WORK_DIR: work,
    });
    rig = new MigrationRig(ctx, migrationRoot);
    generated = generateDataset({ users: USERS, invoices: INVOICES });
  }, 600_000);

  afterAll(async () => {
    await rig?.closePanels();
    await ctx?.close();
    for (const dir of [work, migrationRoot]) await rm(dir, { recursive: true, force: true });
  });

  /** Each case changes ONE non-live invoice ('removed', account gone), so live adoption stays the rig's. */
  function shapeDataset(): void {
    const rows = (
      generated.dataset.tables as unknown as Record<string, Record<string, string | null>[]>
    )['invoice'] as Record<string, string | null>[];
    const nonLive = generated.invoices.map((i, index) => ({ i, index })).filter((x) => !x.i.live);
    let n = 0;
    const mark = (why: string, change: Record<string, string | null>) => {
      const found = nonLive[n];
      n += 1;
      if (found === undefined) throw new Error('not enough non-live invoices');
      const row = rows[found.index] as Record<string, string | null>;
      Object.assign(row, change);
      names[why] = { key: String(row['id_invoice']), index: found.index };
    };
    mark('unpaid', { Status: 'unpaid' });
    mark('failed', { Status: 'Unsuccessful' });
    mark('nostatus', { Status: null });
    mark('unpaidnoprice', { Status: 'unpaid', price_product: 'free' });
    mark('unpaidnodate', { Status: 'unpaid', time_sell: 'not-a-time' });
    mark('unpaidnopanel', { Status: 'unpaid', code_panel: null });
    mark('unpaidunmapped', { Status: 'unpaid', code_panel: 'zzz' });
    mark('unpaidshape', { Status: 'unpaid', Volume: '0' });
    // a shape no PAID invoice has: the importer made no hidden product for it
    mark('unpaidnewshape', { Status: 'unpaid', Volume: '91' });
    // an owner who is not in Mirza's `user` table, so not a NEXA customer
    mark('unpaidorphan', { Status: 'unpaid', id_user: '399999999' });
    // a key outside the evidenced shape
    mark('unpaidbadkey', { Status: 'unpaid', id_invoice: 'not-a-key-1' });
  }

  const live = () => generated.invoices.filter((i) => i.live).length;
  /** 40 - 16 live - 11 never paid = 13 removed invoices whose account is gone: ended. */
  const ended = () => INVOICES - live() - NEVER_PAID;

  it('runs the whole import: each written never-paid invoice is one order in its state, with no service', async () => {
    shapeDataset();
    expect(live()).toBe(16);
    expect(ended()).toBe(13);
    await rig.freshTenant({
      rp1: [...generated.liveAccounts.rp1],
      rp2: [...generated.liveAccounts.rp2],
    });
    const pkg = await writeMigrationPackage(join(work, 'never-paid.nxpkg'), {
      dataset: generated.dataset,
      invoices: generated.invoices,
    });
    const executor = ctx.container.migrationExecutor;
    importId = await rig.upload(pkg.path);
    await rig.setKey(importId, { keyFileText: pkg.keyFileText });
    await executor.tick();
    await rig.bind(importId);
    await rig.requestDryRun(importId);
    await executor.tick();
    await rig.approve(importId);
    await executor.tick();

    // COMPLETED requires every exact-match row to hold — the never-paid ones included.
    expect((await rig.detail(importId)).status).toBe('COMPLETED');
    sourceFingerprint = String((await rig.row(importId))?.['package_source_fingerprint']);

    const rows = await neverPaidRows();
    expect(rows.map((r) => r.source_ref)).toEqual(
      Object.keys(WRITTEN)
        .map((why) => `invoice-never-paid:${names[why]?.key ?? ''}`)
        .sort(),
    );
    for (const [why, state] of Object.entries(WRITTEN)) {
      const at = names[why];
      const row = rows.find((r) => r.source_ref === `invoice-never-paid:${at?.key ?? ''}`);
      expect(row, why).toMatchObject({
        state,
        purpose: 'NEW_SERVICE',
        source: 'MIRZA',
        // the invoice's own amount; an unreadable one is 0, never a guess
        total: why === 'unpaidnoprice' ? '0' : PRICE.toString(),
        settled_at: null,
        confirmed_at: null,
        expires_at: null,
        shape_product: true,
      });
      // the invoice's own date; an unreadable one is the import's (created = updated = now)
      if (why === 'unpaidnodate') expect(row?.created_is_updated, why).toBe(true);
      else expect(row?.created, why).toBe(String(SOLD_AT_BASE + (at?.index ?? -1)));
      if (state === 'CANCELLED') expect(row?.cancelled_at, why).not.toBeNull();
      else expect(row?.cancelled_at, why).toBeNull();
    }
    // Not one service under any never-paid invoice, written or not, by either ref.
    for (const { key } of Object.values(names)) {
      expect(await rig.count('services', `source_ref LIKE '%:${key}'`), key).toBe(0);
    }
    // The gaps wrote nothing at all.
    for (const why of Object.keys(NOT_WRITTEN)) {
      expect(await rig.count('orders', `source_ref LIKE '%:${names[why]?.key ?? ''}'`), why).toBe(
        0,
      );
    }
    // The rest is what the ended-services step already did: 13 ended, each PAID behind a
    // TERMINATED service; 16 adopted.
    expect(await rig.count('services', "state = 'TERMINATED'")).toBe(ended());
    expect(await rig.count('orders', "origin = 'LEGACY_HISTORY' AND state = 'PAID'")).toBe(ended());
    expect(await rig.count('orders', "origin = 'LEGACY_HISTORY'")).toBe(
      ended() + Object.keys(WRITTEN).length,
    );
    // …and no panel was written to, ever.
    expect(rig.providerWrites()).toEqual([]);
  }, 600_000);

  it('the exact-match orders row cannot hold without them, and names what is missing', async () => {
    const before = await neverPaidRows();
    await db().execute(
      sql`DELETE FROM orders WHERE tenant_id = ${TENANT} AND source_ref LIKE 'invoice-never-paid:%'`,
    );
    const rows = await step().match(context());
    const orders = rows.find((r) => r.nexaTable === 'orders');
    expect(orders?.nexaRows).toBe(ended());
    expect(exactMatchHolds(orders as NonNullable<typeof orders>)).toBe(false);
    // The services row never counted them (a never-paid invoice is never a service).
    const services = rows.find((r) => r.nexaTable === 'services');
    expect(exactMatchHolds(services as NonNullable<typeof services>)).toBe(true);
    expect(before).toHaveLength(Object.keys(WRITTEN).length);
  });

  it('apply writes exactly those orders back and moves no money, service, event or notice', async () => {
    const before = await untouched();
    const outcome = await step().apply(context());
    // 13 ended are already present; the five never-paid orders are written again.
    expect(outcome).toMatchObject({
      step: 'ended-services',
      written: Object.keys(WRITTEN).length,
      alreadyPresent: ended(),
      diverged: 0,
    });
    // Every never-paid gap counted under its own reason; the adopted ones as the importer's.
    expect(outcome.skipped).toEqual({
      ADOPTED_BY_IMPORTER: live(),
      ...Object.fromEntries(Object.values(NOT_WRITTEN).map((reason) => [reason, 1])),
    });
    expect((await neverPaidRows()).length).toBe(Object.keys(WRITTEN).length);
    expect(await untouched()).toEqual(before);
  }, 300_000);

  it('the exact-match report holds and counts them as rows, never as paid money', async () => {
    const rows = await step().match(context());
    for (const row of rows) expect(exactMatchHolds(row), row.nexaTable).toBe(true);
    const services = rows.find((r) => r.nexaTable === 'services');
    const orders = rows.find((r) => r.nexaTable === 'orders');
    // services: every never-paid invoice is NEVER_PAID there, written as an order or not.
    expect(services?.mirzaRows).toBe(INVOICES);
    expect(services?.nexaRows).toBe(live() + ended());
    expect(services?.explained).toEqual([
      { reason: 'NEVER_PAID', rows: NEVER_PAID, sumMinor: null },
    ]);
    // orders: 13 ended + 5 never-paid rows are NEXA's; 16 adopted + 6 never-paid gaps explained.
    expect(orders?.mirzaRows).toBe(INVOICES);
    expect(orders?.nexaRows).toBe(ended() + Object.keys(WRITTEN).length);
    // every invoice is priced except the unreadable one
    expect(orders?.mirzaSumMinor).toBe(PRICE * BigInt(INVOICES - 1));
    // NEXA's money is the 13 PAID ended orders' — not one never-paid amount in it
    expect(orders?.nexaSumMinor).toBe(PRICE * BigInt(ended()));
    expect(
      Object.fromEntries((orders?.explained ?? []).map((g) => [g.reason, [g.rows, g.sumMinor]])),
    ).toEqual({
      ADOPTED_AMOUNT_NOT_CARRIED: [live(), PRICE * BigInt(live())],
      // the five written orders' amounts (one of them 0), in money only: their rows are NEXA's
      NEVER_PAID_AMOUNT_NOT_REVENUE: [0, PRICE * 4n],
      ...Object.fromEntries(Object.values(NOT_WRITTEN).map((reason) => [reason, [1, PRICE]])),
    });
  });

  it('a rerun writes nothing, and a changed order is diverged and never rewritten', async () => {
    const before = { ...(await untouched()), orders: await rig.count('orders') };
    const rerun = await step().apply(context());
    expect(rerun).toMatchObject({
      written: 0,
      diverged: 0,
      alreadyPresent: ended() + Object.keys(WRITTEN).length,
    });
    expect({ ...(await untouched()), orders: await rig.count('orders') }).toEqual(before);

    // The state and amounts are frozen by the database; the customer is not (an account
    // transfer moves orders), so a never-paid order of another customer is the divergence.
    const ref = `invoice-never-paid:${names['failed']?.key ?? ''}`;
    const original = await scalar(
      `SELECT customer_id::text AS v FROM orders WHERE source_ref = '${ref}'`,
    );
    const other = await scalar(
      `SELECT id::text AS v FROM customers WHERE tenant_id = '${TENANT}' AND id <> '${original}' ORDER BY id LIMIT 1`,
    );
    await db().execute(
      sql`UPDATE orders SET customer_id = ${other}::uuid WHERE source_ref = ${ref}`,
    );
    try {
      expect(await step().apply(context())).toMatchObject({ written: 0, diverged: 1 });
      expect(
        await scalar(`SELECT customer_id::text AS v FROM orders WHERE source_ref = '${ref}'`),
      ).toBe(other);
      expect(await scalar(`SELECT state AS v FROM orders WHERE source_ref = '${ref}'`)).toBe(
        'CANCELLED',
      );
    } finally {
      await db().execute(
        sql`UPDATE orders SET customer_id = ${original}::uuid WHERE source_ref = ${ref}`,
      );
    }
    expect(await step().apply(context())).toMatchObject({ written: 0, diverged: 0 });
  }, 300_000);
});
