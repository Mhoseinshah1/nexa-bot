import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isNexaError, systemJobActor, type CorrelationId } from '@nexa/contracts';
import { exactMatchHolds } from '../../apps/api/src/modules/platform/legacy-materialize/application/ports';
import type { MaterializeContext } from '../../apps/api/src/modules/platform/legacy-materialize/application/ports';
import {
  MigrationRig,
  TENANT,
  generateDataset,
  writeMigrationPackage,
  type GeneratedDataset,
} from '../support/legacy-migration-rig';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';

/**
 * The one-time Mirza import, ended services (owner decision 2026-10-17): a Mirza invoice whose
 * account is not on the panel becomes a TERMINATED NEXA service behind a LEGACY_HISTORY order;
 * a test invoice becomes one marked `is_test`; an account that IS on the panel is adopted by
 * the importer (any invoice status); nothing is provisioned, paid, refunded, announced or
 * written to a panel.
 *
 * Driven through the REAL lifecycle (operator service + the container's `migration` executor
 * over fake RickPanels), so the step reads exactly the archive, the import map and the panel
 * bindings the importer left. SYNTHETIC data only. NOT EVIDENCE.
 */

const USERS = 40;
const INVOICES = 40;
const PRICE = 150_000n;
const SOLD_AT_BASE = 1_700_000_000;
/** The database's own refusal: drizzle wraps it, the trigger's message is the cause's. */
const refusedBy = (text: RegExp) => (e: unknown) =>
  text.test(String((e as { cause?: { message?: string } }).cause?.message ?? ''));

/** Invoices not carried: unpaid, unmapped panel, no panel, unmappable shape, test with no panel. */
const GAPS = 5;

describe('ended services: every Mirza invoice is a live, ended or counted service', () => {
  let ctx: TestContext;
  let work: string;
  let migrationRoot: string;
  let rig: MigrationRig;
  let generated: GeneratedDataset;
  let importId: string;
  let sourceFingerprint: string;
  /** invoice index → what the test did to it. */
  const special = new Map<number, string>();

  const db = () => ctx.container.database.db;
  const step = () => ctx.container.legacyEndedServices;
  const context = (): MaterializeContext => ({
    scope: tenantA,
    actor: systemJobActor('legacy-materialize:test', 'corr-ended-1' as CorrelationId),
    packageImportId: importId,
    sourceFingerprint,
    now: new Date('2026-10-17T00:00:00.000Z'),
  });
  const scalar = async (query: string): Promise<string> => {
    const r = await db().execute<{ v: string }>(sql.raw(query));
    return String(r.rows[0]?.v ?? '');
  };
  /** Every table the step must NEVER write, counted. */
  const untouched = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const table of [
      'provisioning_operations',
      'service_username_reservations',
      'wallet_entries',
      'outbox_messages',
      'customer_notifications',
      'payments',
      'service_reminders',
      'service_commercial_actions',
    ]) {
      out[table] = Number(await scalar(`SELECT count(*)::int AS v FROM ${table}`));
    }
    return out;
  };

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'lend-'));
    migrationRoot = await mkdtemp(join(tmpdir(), 'lend-root-'));
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

  /**
   * The generated dataset has live invoices (`active`, account on the panel) and `removed`
   * ones (no account). Each special case changes ONE non-live invoice, so the live adoption
   * numbers of the rig stay what the rig computes.
   */
  function shapeDataset(): Record<string, string> {
    const rows = (
      generated.dataset.tables as unknown as Record<string, Record<string, string | null>[]>
    )['invoice'] as Record<string, string | null>[];
    const nonLive = generated.invoices.map((i, index) => ({ i, index })).filter((x) => !x.i.live);
    const pick = (n: number) => {
      const found = nonLive[n];
      if (found === undefined) throw new Error('not enough non-live invoices');
      return found.index;
    };
    const names: Record<string, string> = {};
    const mark = (n: number, why: string, change: Record<string, string | null>) => {
      const index = pick(n);
      Object.assign(rows[index] as Record<string, string | null>, change);
      special.set(index, why);
      names[why] = generated.invoices[index]?.id ?? '';
    };
    // never paid: an abandoned order
    mark(0, 'unpaid', { Status: 'unpaid' });
    // a Mirza test invoice, removed long ago
    mark(1, 'test', { is_test: '1', price_product: '0' });
    // a panel code nobody mapped (the unselected `zzz` target)
    mark(2, 'unmapped', { code_panel: 'zzz' });
    // no panel named at all
    mark(3, 'nopanel', { code_panel: null });
    // a shape the import cannot name (zero volume)
    mark(4, 'shape', { Volume: '0' });
    // removed in Mirza, but the account is STILL on the panel (expired there): adopted
    mark(5, 'onpanel', { Status: 'removebyuser' });
    // a price that does not read
    mark(6, 'noprice', { price_product: 'free' });
    // a status that is neither live nor a never-paid one, account gone
    mark(7, 'warned', { Status: 'end_of_time' });
    // sold as a NAMED Mirza product with a shape of its own (77 GB), account gone: it still points
    // at its shape's hidden product — which exists only because EVERY candidate gets a shape
    mark(8, 'named', { code_product: 'p1', Volume: '77' });
    // a Mirza TEST invoice that names no panel: ended needs a panel, so it is a counted gap
    mark(9, 'testnopanel', { is_test: '1', code_panel: null, price_product: '0' });
    return names;
  }

  let names: Record<string, string>;

  it('runs the whole import first: widened matching, ended invoices are PROVIDER_MISSING', async () => {
    names = shapeDataset();
    const onPanel = generated.invoices.find((i) => i.id === names['onpanel']);
    if (onPanel === undefined) throw new Error('no on-panel invoice');
    const accounts = {
      rp1: [...generated.liveAccounts.rp1],
      rp2: [...generated.liveAccounts.rp2],
    };
    accounts[onPanel.codePanel].push(onPanel.username);
    await rig.freshTenant(accounts);
    const pkg = await writeMigrationPackage(join(work, 'ended.nxpkg'), {
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

    const view = await rig.detail(importId);
    expect(view.status).toBe('COMPLETED');
    sourceFingerprint = String((await rig.row(importId))?.['package_source_fingerprint']);
    expect(sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);

    // The importer adopted every live invoice AND the removed one whose account is on the
    // panel (every invoice is matched, not only the live ones), as MIRZA-marked rows.
    const live = generated.invoices.filter((i) => i.live).length;
    expect(await rig.count('services')).toBe(live + 1);
    expect(await rig.count('services', "source = 'MIRZA' AND source_ref LIKE 'invoice:%'")).toBe(
      live + 1,
    );
    expect(
      await rig.count(
        'orders',
        `origin = 'LEGACY_ADOPTION' AND source = 'MIRZA' AND source_ref = 'invoice:${names['onpanel']}'`,
      ),
    ).toBe(1);
    expect(await rig.count('services', `source_ref = 'invoice:${names['onpanel']}'`)).toBe(1);
    // …and nothing ended yet: the ended step has not run.
    expect(await rig.count('services', "state = 'TERMINATED'")).toBe(0);
  }, 600_000);

  it('the exact-match report cannot hold before the step has run, and says why', async () => {
    const rows = await step().match(context());
    const orders = rows.find((r) => r.nexaTable === 'orders');
    expect(orders).toBeDefined();
    if (orders === undefined) return;
    expect(orders.mirzaRows).toBe(INVOICES);
    expect(orders.nexaRows).toBe(0);
    expect(exactMatchHolds(orders)).toBe(false);
  });

  it('apply writes one TERMINATED service and one LEGACY_HISTORY order per ended invoice, and nothing else', async () => {
    const before = await untouched();
    const balances = await scalar(
      `SELECT coalesce(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS v FROM wallet_entries`,
    );

    const outcome = await step().apply(context());

    // 40 invoices: 16 live + 1 on-panel are adopted; the unpaid, no-panel, unmapped and
    // unmappable-shape ones are counted gaps; everything else is ended.
    const live = generated.invoices.filter((i) => i.live).length;
    const gaps = GAPS; // unpaid, unmapped, nopanel, shape, and a test invoice with no panel
    const ended = INVOICES - live - 1 - gaps;
    expect(outcome).toMatchObject({
      step: 'ended-services',
      written: ended,
      alreadyPresent: 0,
      diverged: 0,
    });
    expect(outcome.skipped).toEqual({
      ADOPTED_BY_IMPORTER: live + 1,
      NEVER_PAID: 1,
      PANEL_NOT_MAPPED: 1,
      NO_PANEL: 2,
      SHAPE_UNMAPPABLE: 1,
    });

    // The ended rows.
    expect(await rig.count('services', "state = 'TERMINATED'")).toBe(ended);
    expect(
      await rig.count(
        'services',
        "state = 'TERMINATED' AND source = 'MIRZA' AND source_ref LIKE 'invoice:%' AND provisioned_at IS NULL AND terminated_at IS NOT NULL",
      ),
    ).toBe(ended);
    expect(
      await rig.count(
        'orders',
        "origin = 'LEGACY_HISTORY' AND state = 'PAID' AND purpose = 'NEW_SERVICE' AND source = 'MIRZA'",
      ),
    ).toBe(ended);
    // Each ended service hangs off its own history order, for the same customer and panel.
    expect(
      Number(
        await scalar(
          `SELECT count(*)::int AS v FROM services s JOIN orders o ON o.tenant_id = s.tenant_id AND o.id = s.order_id
            WHERE s.state = 'TERMINATED' AND o.origin = 'LEGACY_HISTORY' AND o.source_ref = s.source_ref
              AND o.customer_id = s.customer_id AND o.panel_id = s.panel_id`,
        ),
      ),
    ).toBe(ended);

    // The invoice's own amount and date; an unreadable price is 0, never a guess.
    const test = names['test'];
    const priced = await db().execute<{ source_ref: string; total: string; created: string }>(
      sql`SELECT source_ref, total_amount::text AS total, extract(epoch FROM created_at)::bigint::text AS created
            FROM orders WHERE origin = 'LEGACY_HISTORY' ORDER BY source_ref`,
    );
    for (const row of priced.rows) {
      const index = generated.invoices.findIndex((i) => `invoice:${i.id}` === row.source_ref);
      const wanted =
        special.get(index) === 'test'
          ? '0'
          : special.get(index) === 'noprice'
            ? '0'
            : PRICE.toString();
      expect(row.total, row.source_ref).toBe(wanted);
      expect(row.created, row.source_ref).toBe(String(SOLD_AT_BASE + index));
    }
    expect(priced.rows.some((r) => r.source_ref === `invoice:${test}`)).toBe(true);

    // Every ended order points at the hidden product of its shape — a named-product invoice
    // included (its shape exists because EVERY candidate gets one, not only the productless).
    expect(
      Number(
        await scalar(
          `SELECT count(*)::int AS v FROM orders o
             JOIN legacy_product_shapes s ON s.tenant_id = o.tenant_id AND s.product_id = o.product_id
            WHERE o.origin = 'LEGACY_HISTORY'`,
        ),
      ),
    ).toBe(ended);
    expect(
      await rig.count(
        'orders',
        `source_ref = 'invoice:${names['named']}' AND origin = 'LEGACY_HISTORY'`,
      ),
    ).toBe(1);

    // The test invoice is an ended service marked test; no other service is.
    expect(await rig.count('services', 'is_test')).toBe(1);
    expect(await rig.count('services', `is_test AND source_ref = 'invoice:${names['test']}'`)).toBe(
      1,
    );

    // Nothing else moved: no operation, hold, ledger entry, event, notice, payment, reminder.
    expect(await untouched()).toEqual(before);
    expect(
      await scalar(
        `SELECT coalesce(sum(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS v FROM wallet_entries`,
      ),
    ).toBe(balances);
    // …and no panel was written to, ever.
    expect(rig.providerWrites()).toEqual([]);
  }, 300_000);

  it('the exact-match report now holds for orders and services, with every gap named and counted', async () => {
    const rows = await step().match(context());
    expect(rows.map((r) => r.nexaTable)).toEqual(['services', 'orders']);
    for (const row of rows) expect(exactMatchHolds(row), row.nexaTable).toBe(true);
    const live = generated.invoices.filter((i) => i.live).length;
    const services = rows.find((r) => r.nexaTable === 'services');
    const orders = rows.find((r) => r.nexaTable === 'orders');
    expect(services?.mirzaRows).toBe(INVOICES);
    expect(services?.nexaRows).toBe(INVOICES - GAPS);
    expect(Object.fromEntries((services?.explained ?? []).map((g) => [g.reason, g.rows]))).toEqual({
      NEVER_PAID: 1,
      PANEL_NOT_MAPPED: 1,
      NO_PANEL: 2,
      SHAPE_UNMAPPABLE: 1,
    });
    // The orders table carries the money: the adopted services' free orders are the gap.
    const adopted = (orders?.explained ?? []).find(
      (g) => g.reason === 'ADOPTED_AMOUNT_NOT_CARRIED',
    );
    expect(adopted?.rows).toBe(live + 1);
    expect(adopted?.sumMinor).toBe(PRICE * BigInt(live + 1));
    // the test invoice, the unreadable price and the no-panel test invoice are 0
    expect(orders?.mirzaSumMinor).toBe(PRICE * BigInt(INVOICES - 3));
    expect(orders?.nexaSumMinor).toBe(
      PRICE * BigInt(INVOICES - live - 1 - GAPS - 2) /* ended and priced */,
    );
  });

  it('a rerun writes nothing: every count and sum is what it was', async () => {
    const before = {
      ...(await untouched()),
      services: await rig.count('services'),
      orders: await rig.count('orders'),
      sum: await scalar('SELECT coalesce(sum(total_amount), 0)::text AS v FROM orders'),
    };
    const outcome = await step().apply(context());
    expect(outcome.written).toBe(0);
    expect(outcome.diverged).toBe(0);
    expect(outcome.alreadyPresent).toBe(
      INVOICES - generated.invoices.filter((i) => i.live).length - 1 - GAPS,
    );
    expect({
      ...(await untouched()),
      services: await rig.count('services'),
      orders: await rig.count('orders'),
      sum: await scalar('SELECT coalesce(sum(total_amount), 0)::text AS v FROM orders'),
    }).toEqual(before);
  }, 300_000);

  it('a row that differs from what the package says is diverged and never rewritten', async () => {
    const victim = generated.invoices.find(
      (i) => !i.live && !special.has(generated.invoices.indexOf(i)),
    );
    if (victim === undefined) throw new Error('no plain ended invoice');
    // The order is frozen by the database (below); the service's test mark is not, and a
    // plain invoice that reads as a test one is exactly a divergence from the package.
    await db().execute(
      sql`UPDATE services SET is_test = true
           WHERE tenant_id = ${TENANT} AND source_ref = ${`invoice:${victim.id}`}`,
    );
    const outcome = await step().apply(context());
    expect(outcome).toMatchObject({ written: 0, diverged: 1 });
    expect(
      await scalar(
        `SELECT is_test::text AS v FROM services WHERE source_ref = 'invoice:${victim.id}'`,
      ),
    ).toBe('true');
    // The report cannot say the services match while this one differs from the package…
    expect(await rig.count('services', 'is_test')).toBe(2);
    await db().execute(
      sql`UPDATE services SET is_test = false WHERE source_ref = ${`invoice:${victim.id}`}`,
    );
    expect(await step().apply(context())).toMatchObject({ written: 0, diverged: 0 });
  }, 300_000);

  it('is charged maintenance.run and refuses a stopped tenant inside its transaction — writing nothing', async () => {
    const observer = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'obs-ended', roleKeys: ['observer'] }),
    );
    await expect(step().apply({ ...context(), actor: observer })).rejects.toSatisfy(
      (e: unknown) => isNexaError(e) && e.kind === 'PERMISSION_DENIED',
    );
    // One ended invoice is missing again (as after a crash between two batches): the step
    // would write it — but not for a tenant that has stopped accepting work.
    const victim = generated.invoices.find(
      (i) => !i.live && !special.has(generated.invoices.indexOf(i)),
    );
    if (victim === undefined) throw new Error('no plain ended invoice');
    const ref = `invoice:${victim.id}`;
    await db().execute(
      sql`DELETE FROM services WHERE tenant_id = ${TENANT} AND source_ref = ${ref}`,
    );
    await db().execute(sql`DELETE FROM orders WHERE tenant_id = ${TENANT} AND source_ref = ${ref}`);
    await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${TENANT}`);
    try {
      await expect(step().apply(context())).rejects.toMatchObject({
        code: 'commerce.request_invalid',
      });
      expect(await rig.count('orders', `source_ref = '${ref}'`)).toBe(0);
    } finally {
      await db().execute(sql`UPDATE tenants SET status = 'ACTIVE' WHERE id = ${TENANT}`);
    }
    // …and the same step, run again for an active tenant, finishes exactly that one.
    expect(await step().apply(context())).toMatchObject({ written: 1, diverged: 0 });
    expect(await rig.count('orders', `source_ref = '${ref}'`)).toBe(1);
  }, 300_000);

  it('the database refuses to move an ended service or a history order', async () => {
    const ended = await db().execute<{ id: string; order_id: string }>(
      sql`SELECT id, order_id FROM services WHERE tenant_id = ${TENANT} AND state = 'TERMINATED' LIMIT 1`,
    );
    const row = ended.rows[0];
    if (row === undefined) throw new Error('no ended service');
    // A TERMINATED service is never resumed, however it is asked.
    // Written as a CONSISTENT resume (no end time, a provisioning time where the state needs
    // one), so only the trigger can stop it, not a CHECK.
    for (const state of ['ACTIVE', 'SUSPENDED', 'EXPIRED']) {
      await expect(
        db().execute(
          sql.raw(
            `UPDATE services SET state = '${state}', terminated_at = NULL, provisioned_at = now() WHERE id = '${row.id}'`,
          ),
        ),
      ).rejects.toSatisfy(refusedBy(/is TERMINATED and stays so/));
    }
    await expect(
      db().execute(
        sql.raw(
          `UPDATE services SET state = 'PENDING_PROVISION', terminated_at = NULL WHERE id = '${row.id}'`,
        ),
      ),
    ).rejects.toSatisfy(refusedBy(/is TERMINATED and stays so/));
    // A history order is never cancelled, refunded, re-priced or re-settled.
    for (const set of [
      "state = 'REFUNDED', refunded_at = now()",
      "state = 'CANCELLED', cancelled_at = now()",
      'total_amount = 1',
      'subtotal_amount = 1',
      'settled_at = now()',
    ]) {
      await expect(
        db().execute(sql.raw(`UPDATE orders SET ${set} WHERE id = '${row.order_id}'`)),
      ).rejects.toSatisfy(refusedBy(/LEGACY_HISTORY order/));
    }
    // …while a customer's account transfer may still move the order to another customer.
    expect(
      Number(
        await scalar(
          `SELECT count(*)::int AS v FROM orders WHERE id = '${row.order_id}' AND state = 'PAID'`,
        ),
      ),
    ).toBe(1);
  }, 300_000);
});
