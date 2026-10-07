import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LegacyInvoiceArchiveFilter } from '../../apps/api/src/modules/platform/legacy-invoice-archive/application/ports';
import { DrizzleLegacyInvoiceArchiveRepository } from '../../apps/api/src/modules/platform/legacy-invoice-archive/infrastructure/drizzle-legacy-invoice-archive.repository';
import { createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * Mirza migration PR3 — the archive's indexes, asked of the PLANNER, at the scale the
 * historical staging snapshot suggests (about 10^5 invoices — a dated baseline, never an
 * expectation: `NEXA_LEGACY_ARCHIVE_PLAN_ROWS` raises it).
 *
 * Every Web Admin filter must be an index-led bounded read of ONE tenant's latest visible
 * revisions — never a walk of the archive. The statement is the REPOSITORY's own
 * (`listStatement(...).toSQL()`), so the plan is for the query production sends.
 * SYNTHETIC rows, inserted in bulk; the ingest itself is exercised in
 * `legacy-invoice-archive.test.ts`.
 */

const ROWS = Number(process.env['NEXA_LEGACY_ARCHIVE_PLAN_ROWS'] ?? '200000');
const PAGE = 51;
const RUN_A = '01900000-0000-7000-8000-00000000a1a1';
const RUN_B = '01900000-0000-7000-8000-00000000b1b1';
const HASH = 'a'.repeat(64);
const CHUNK = 20_000;

describe('the legacy invoice archive query plans', () => {
  let ctx: TestContext;
  let repository: DrizzleLegacyInvoiceArchiveRepository;

  beforeAll(async () => {
    ctx = await createTestContext();
    await ctx.reset();
    repository = new DrizzleLegacyInvoiceArchiveRepository(ctx.container.database.db);
    await ctx.container.database.withClient(async (client) => {
      for (const [scope, run, rows] of [
        [tenantA, RUN_A, ROWS],
        [tenantB, RUN_B, Math.max(1000, Math.floor(ROWS / 10))],
      ] as const) {
        await client.query(
          `INSERT INTO legacy_invoice_archive_runs (id, tenant_id, state, read_set_version,
             read_set_fingerprint, source_fingerprint, source_schema_hash, source_engine, synthetic,
             source_invoice_rows, source_user_rows, source_product_rows, promoted_through,
             promoted_rows, inserted_new, missing_in_snapshot, archive_invoices_after,
             started_at, verified_at, finished_at, updated_at)
           VALUES ($1, $2, 'COMPLETED', 1, $3, $3, $3, 'SYNTHETIC_FIXTURE', true, $4, 0, 0, 'z',
                   $4, $4, 0, $4, now(), now(), now(), now())`,
          [run, scope.tenantId, HASH, rows],
        );
        // One revision per invoice; the facts vary so every filter has rare and common values.
        // The class is computed by the archive's own CASE, so every row passes its CHECK.
        // In chunks: one statement per chunk stays inside the pool's statement timeout.
        for (let from = 1; from <= rows; from += CHUNK) {
          await client.query(
            `INSERT INTO legacy_invoice_archive (id, tenant_id, run_id, invoice_key, revision,
             revision_reason, key_shape_evidenced, raw_row, row_checksum, archive_checksum,
             classification, live, status, is_test, legacy_user_id, owner_present, username,
             panel_code, product_code, product_ref, product_name, price_raw, price_minor,
             price_currency, price_note, sold_at_raw, sold_at, sold_at_note,
             read_set_fingerprint, source_fingerprint, normalization_version, archived_at)
           SELECT gen_random_uuid(), $1::uuid, $2::uuid, f.key, 1, 'FIRST_SEEN', true,
                  jsonb_build_object('id_invoice', f.key), $3, $3,
                  CASE WHEN f.is_test THEN 'TEST' WHEN f.status = 'removed' OR f.status = 'end_of_time'
                       THEN 'NOT_LIVE' WHEN f.panel IS NULL THEN 'NO_PANEL' ELSE 'LIVE_CANDIDATE' END,
                  f.status = 'active', f.status, f.is_test, (100000000 + g % 150000)::text, true,
                  'svc_' || g, f.panel, f.product, CASE WHEN f.product IS NULL THEN 'NONE' ELSE 'NAMED' END,
                  'synthetic', '150000', 150000, 'IRT', NULL, (1700000000 + g)::text,
                  to_timestamp(1700000000 + g), NULL, $3, $3, 'legacy-invoice-archive:v1', now()
             FROM generate_series($4::int, $5::int) AS g,
                  LATERAL (SELECT lpad(to_hex(g), 8, '0') AS key,
                                  (g % 997 = 0) AS is_test,
                                  CASE WHEN g % 1000 = 1 THEN 'end_of_time'
                                       WHEN g % 3 = 0 THEN 'removed' ELSE 'active' END AS status,
                                  CASE WHEN g % 7 = 0 THEN NULL ELSE 'rp' || (g % 1009) END AS panel,
                                  CASE WHEN g % 5 = 0 THEN NULL ELSE 'p' || (g % 2003) END AS product) f`,
            [scope.tenantId, run, HASH, from, Math.min(rows, from + CHUNK - 1)],
          );
        }
        // Every hundredth invoice has a second revision: the latest-visible anti-join matters.
        await client.query(
          `INSERT INTO legacy_invoice_archive
           SELECT gen_random_uuid(), tenant_id, run_id, invoice_key, 2, 'ROW_CHANGED',
                  key_shape_evidenced, raw_row, row_checksum, archive_checksum, classification,
                  live, status, is_test, legacy_user_id, owner_present, username, panel_code,
                  product_code, product_ref, product_name, price_raw, price_minor, price_currency,
                  price_note, sold_at_raw, sold_at, sold_at_note, read_set_fingerprint,
                  source_fingerprint, normalization_version, archived_at
             FROM legacy_invoice_archive
            WHERE tenant_id = $1 AND ('x' || right(invoice_key, 2))::bit(8)::int = 0`,
          [scope.tenantId],
        );
      }
      await client.query('ANALYZE legacy_invoice_archive');
      await client.query('ANALYZE legacy_invoice_archive_runs');
    });
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const planFor = async (filter: LegacyInvoiceArchiveFilter, after: string | null = null) => {
    const compiled = repository.listStatement(tenantA, filter, after, PAGE).toSQL();
    return ctx.container.database.withClient(async (client) => {
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF, SUMMARY OFF) ${compiled.sql}`,
        [...compiled.params],
      );
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });
  };

  const noWalk = (plan: string) => {
    expect(plan, `the archive was walked:\n${plan}`).not.toMatch(
      /Seq Scan on legacy_invoice_archive(?!_runs)/u,
    );
  };

  it('pages the whole archive in key order from the revision key, starting at the cursor', async () => {
    const plan = await planFor({}, '00010000');
    noWalk(plan);
    expect(plan).toContain('legacy_invoice_archive_revision_key');
    expect(plan, 'the page was sorted rather than read in order').not.toContain('Sort Key:');
    expect(plan).toMatch(/Index Cond:.*invoice_key > /su);
  }, 120_000);

  for (const [name, filter, index] of [
    ['invoice id prefix', { invoiceIdPrefix: '0001a' }, 'legacy_invoice_archive_key_prefix_idx'],
    ['legacy owner id', { legacyUserId: '100012345' }, 'legacy_invoice_archive_user_idx'],
    ['username prefix', { usernamePrefix: 'SVC_12345' }, 'legacy_invoice_archive_username_idx'],
    ['a rare status', { status: 'end_of_time' }, 'legacy_invoice_archive_status_idx'],
    ['a panel code', { panelCode: 'rp17' }, 'legacy_invoice_archive_panel_idx'],
    ['a product code', { productCode: 'p1234' }, 'legacy_invoice_archive_product_idx'],
    ['a rare class', { classification: 'TEST' }, 'legacy_invoice_archive_class_idx'],
    ['the test flag', { isTest: true }, 'legacy_invoice_archive_test_idx'],
  ] as const) {
    it(`serves ${name} from ${index}`, async () => {
      const plan = await planFor(filter as LegacyInvoiceArchiveFilter);
      noWalk(plan);
      expect(plan, `${index} is not in the plan:\n${plan}`).toContain(index);
    }, 120_000);
  }

  it('a common filter still reads in key order and stops at the page', async () => {
    const plan = await planFor({ status: 'active' });
    noWalk(plan);
    const removed = /Rows Removed by Filter: (\d+)/u.exec(plan);
    expect(Number(removed?.[1] ?? '0'), plan).toBeLessThan(5000);
  }, 120_000);

  it('the latest-visible check is an index probe, never a scan', async () => {
    const plan = await planFor({ invoiceIdPrefix: '00000' });
    noWalk(plan);
    // The anti-join over newer revisions reads the revision key.
    expect(plan.match(/legacy_invoice_archive_revision_key/gu)?.length ?? 0).toBeGreaterThan(0);
  }, 120_000);
});
