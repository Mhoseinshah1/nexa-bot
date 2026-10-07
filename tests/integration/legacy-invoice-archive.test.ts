import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE_NAME,
  legacyInvoiceArchiveDetailResponseSchema,
  legacyInvoiceArchiveListQuerySchema,
  legacyInvoiceArchiveListResponseSchema,
  legacyInvoiceArchiveSummaryResponseSchema,
  systemJobActor,
  type ActorContext,
  type CorrelationId,
  type TenantContext,
} from '@nexa/contracts';
import { runInvoicesRead, invoicesReadReport } from '../../apps/api/src/legacy-import-invoices';
import {
  readLegacyInvoiceArchive,
  type InvoiceArchiveIngest,
} from '../../apps/api/src/modules/platform/legacy-importer/application/invoice-archive-ingest';
import { digestInvoiceArchiveReadSet } from '../../apps/api/src/modules/platform/legacy-importer/application/invoice-archive-read-set';
import type {
  LegacySourceConnector,
  LegacySourceSession,
} from '../../apps/api/src/modules/platform/legacy-importer/application/source-port';
import { readImportV1Identity } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import { LegacyInvoicesController } from '../../apps/api/src/surfaces/web/legacy-invoices.controller';
import {
  SYNTHETIC_ARCHIVE_SECRETS,
  buildSyntheticLegacyDataset,
  type SyntheticLegacyDataset,
  type SyntheticRow,
} from '../fixtures/legacy/synthetic-legacy';
import { changedTables, databaseFingerprint } from '../support/database-fingerprint';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Mirza migration PR3 — the legacy invoice archive end to end against PostgreSQL, on the
 * SYNTHETIC fixture's archive variant (snapshot A, then the newer snapshot B). NOT EVIDENCE
 * about the legacy archive; every count is derived from the synthetic dataset itself, never
 * a real-data expectation.
 */

type Snapshot = 'A' | 'B';

const datasetOf = (snapshot: Snapshot) => buildSyntheticLegacyDataset({ invoiceArchive: snapshot });
const connectorOf = (dataset: SyntheticLegacyDataset) =>
  new FixtureLegacySourceConnector(dataset as never);

/** One invoice cell changed: the smallest newer snapshot. */
function withOneChange(dataset: SyntheticLegacyDataset, id: string, column: string, value: string) {
  return {
    ...dataset,
    tables: {
      ...dataset.tables,
      invoice: dataset.tables.invoice.map((row) =>
        row['id_invoice'] === id ? { ...row, [column]: value } : row,
      ),
    },
  } as SyntheticLegacyDataset;
}

async function fingerprintsOf(dataset: SyntheticLegacyDataset) {
  const session = await connectorOf(dataset).open();
  try {
    return {
      v1: (await readImportV1Identity(session)).fingerprint,
      archive: (await digestInvoiceArchiveReadSet(session)).fingerprint,
    };
  } finally {
    await session.close();
  }
}

/** A lock that is always free: the crash tests drive the ingest directly. */
const freeLock = {
  tryAcquire: () => Promise.resolve({ isLost: () => false, release: () => Promise.resolve() }),
};

describe('Mirza PR3: the legacy invoice archive', () => {
  let ctx: TestContext;
  let owner: ActorContext;
  const job = systemJobActor('legacy-import:invoices-read', 'corr-invoices' as CorrelationId);
  const db = () => ctx.container.database.db;
  const fp: Record<Snapshot, { v1: string; archive: string }> = {
    A: { v1: '', archive: '' },
    B: { v1: '', archive: '' },
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    fp.A = await fingerprintsOf(datasetOf('A'));
    fp.B = await fingerprintsOf(datasetOf('B'));
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    owner = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'owner-lia', roleKeys: ['owner'] }),
    );
  });

  const read = (
    dataset: SyntheticLegacyDataset,
    approval: { v1: string; archive: string | null },
    scope: TenantContext = tenantA,
    batchSize = 4,
  ) =>
    runInvoicesRead(
      ctx.container.legacyImporter(),
      connectorOf(dataset),
      {
        expectedFingerprint: approval.v1,
        expectedInvoiceArchiveFingerprint: approval.archive,
        batchSize,
      },
      { scope, actor: job, productionLikeTarget: false },
    );
  const readSnapshot = (snapshot: Snapshot, scope: TenantContext = tenantA) =>
    read(datasetOf(snapshot), fp[snapshot], scope);

  const service = () => ctx.container.legacyInvoiceArchive;

  async function q<T extends Record<string, unknown>>(query: ReturnType<typeof sql>) {
    return (await db().execute<T>(query)).rows;
  }
  const archiveRows = (tenant = tenantA) =>
    q<{ invoice_key: string; revision: number; revision_reason: string; classification: string }>(
      sql`SELECT invoice_key, revision, revision_reason, classification FROM legacy_invoice_archive
           WHERE tenant_id = ${tenant.tenantId} ORDER BY invoice_key, revision`,
    );
  const runs = (tenant = tenantA) =>
    q<{ state: string; failure_code: string | null; n: number }>(
      sql`SELECT state, failure_code, (SELECT count(*)::int FROM legacy_invoice_archive_staging s
                                        WHERE s.run_id = r.id) AS n
            FROM legacy_invoice_archive_runs r WHERE tenant_id = ${tenant.tenantId}
           ORDER BY started_at, id`,
    );
  const auditCount = async (action: string, result = 'SUCCESS') =>
    (
      await q<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM audit_logs WHERE action = ${action} AND result = ${result}`,
      )
    )[0]?.n ?? 0;

  // --- approval and refusal -----------------------------------------------------------

  it('without the archive approval: prints its fingerprint and writes NOTHING', async () => {
    const before = await databaseFingerprint(db());
    const outcome = await read(datasetOf('A'), { v1: fp.A.v1, archive: null });
    expect(outcome.written).toBeNull();
    expect(outcome.fingerprint).toBe(fp.A.archive);
    expect(outcome.rows.invoice).toBe(datasetOf('A').tables.invoice.length);
    expect(changedTables(before, await databaseFingerprint(db()))).toEqual({});
    expect(invoicesReadReport(outcome, 'md')).toContain('NOT_APPROVED_NOTHING_WRITTEN');
  });

  it('a fingerprint that is not the approved one — archive or source — writes NOTHING', async () => {
    const before = await databaseFingerprint(db());
    await expect(read(datasetOf('A'), { v1: fp.A.v1, archive: fp.B.archive })).rejects.toThrow(
      /READ_SET_FINGERPRINT_MISMATCH/u,
    );
    await expect(read(datasetOf('A'), { v1: fp.B.v1, archive: fp.A.archive })).rejects.toThrow(
      /SOURCE_FINGERPRINT_MISMATCH/u,
    );
    expect(changedTables(before, await databaseFingerprint(db()))).toEqual({});
  });

  it('reading the archive does not change the v1 fingerprint of the source', async () => {
    const dataset = datasetOf('A');
    const session = await connectorOf(dataset).open();
    const v1Before = (await readImportV1Identity(session)).fingerprint;
    await digestInvoiceArchiveReadSet(session);
    expect((await readImportV1Identity(session)).fingerprint).toBe(v1Before);
    await session.close();
    expect(v1Before).toBe(fp.A.v1);
  });

  it('a SYNTHETIC source is refused against a production-like target, before any write', async () => {
    const before = await databaseFingerprint(db());
    await expect(
      runInvoicesRead(
        ctx.container.legacyImporter(),
        connectorOf(datasetOf('A')),
        {
          expectedFingerprint: fp.A.v1,
          expectedInvoiceArchiveFingerprint: fp.A.archive,
          batchSize: 4,
        },
        { scope: tenantA, actor: job, productionLikeTarget: true },
      ),
    ).rejects.toThrow(/SOURCE_UNREADABLE/u);
    expect(changedTables(before, await databaseFingerprint(db()))).toEqual({});
  });

  // --- the archive --------------------------------------------------------------------

  it('an approved read archives every invoice once — and touches no order, payment or ledger', async () => {
    const dataset = datasetOf('A');
    const before = await databaseFingerprint(db());
    const outcome = await readSnapshot('A');
    expect(Object.keys(changedTables(before, await databaseFingerprint(db()))).sort()).toEqual([
      'audit_logs',
      'legacy_invoice_archive',
      'legacy_invoice_archive_runs',
      'legacy_read_set_runs',
    ]);
    const source = dataset.tables.invoice.map((row) => row['id_invoice'] as string);
    const rows = await archiveRows();
    // Every source invoice, exactly once, under its key exactly as read — odd shapes too.
    expect(rows.map((r) => r.invoice_key).sort()).toEqual([...source].sort());
    expect(new Set(rows.map((r) => r.revision))).toEqual(new Set([1]));
    expect(rows.map((r) => r.invoice_key)).toEqual(
      expect.arrayContaining(['INV/2024/001', 'ABCD', 'فاکتور-۱', ' padded ', 'LEGACY-X1']),
    );
    const run = outcome.written?.run;
    expect(run).toMatchObject({
      state: 'COMPLETED',
      sourceInvoiceRows: BigInt(source.length),
      insertedNew: BigInt(source.length),
      insertedRevision: 0n,
      unchanged: 0n,
      missingInSnapshot: 0n,
      archiveInvoicesAfter: BigInt(source.length),
      readSetFingerprint: fp.A.archive,
      sourceFingerprint: fp.A.v1,
    });
    expect(outcome.written?.recorded.run).toMatchObject({
      readSet: 'invoice-archive',
      readSetFingerprint: fp.A.archive,
      sourceFingerprint: fp.A.v1,
    });
    // The staging is gone; the run audited at each step.
    expect(await runs()).toEqual([{ state: 'COMPLETED', failure_code: null, n: 0 }]);
    for (const action of ['run_started', 'run_verified', 'run_completed']) {
      expect(await auditCount(`legacy.invoice_archive.${action}`), action).toBe(1);
    }
  });

  it('reports the invoice columns the read actually delivered, never the allowlist', async () => {
    const plain = buildSyntheticLegacyDataset();
    const outcome = await read(plain, await fingerprintsOf(plain));
    expect(outcome.invoiceColumnsRead).toContain('time_sell');
    for (const absent of ['note', 'refral', 'time_cron', 'notifctions']) {
      expect(outcome.invoiceColumnsRead).not.toContain(absent);
    }
    const report = JSON.parse(invoicesReadReport(outcome, 'json')) as { columnsRead: string[] };
    expect(report.columnsRead).toEqual([...(outcome.invoiceColumnsRead ?? [])]);
    const withFork = await readSnapshot('A');
    expect(withFork.invoiceColumnsRead).toEqual(expect.arrayContaining(['note', 'notifctions']));
  });

  it('never stores, logs or reports the columns it must not read', async () => {
    const outcome = await readSnapshot('A');
    const report = invoicesReadReport(outcome, 'json') + invoicesReadReport(outcome, 'md');
    const everything = await q<{ text: string }>(sql`
      SELECT coalesce(string_agg(t::text, ' '), '') AS text FROM (
        SELECT raw_row::text AS t FROM legacy_invoice_archive
        UNION ALL SELECT row_to_json(a)::text FROM audit_logs a
        UNION ALL SELECT row_to_json(r)::text FROM legacy_invoice_archive_runs r
        UNION ALL SELECT row_to_json(o)::text FROM operational_events o) x`);
    for (const secret of Object.values(SYNTHETIC_ARCHIVE_SECRETS)) {
      expect(everything[0]?.text ?? '').not.toContain(secret);
      expect(report).not.toContain(secret);
    }
    const columns = await q<{ k: string }>(
      sql`SELECT DISTINCT jsonb_object_keys(raw_row) AS k FROM legacy_invoice_archive ORDER BY k`,
    );
    expect(columns.map((c) => c.k)).not.toEqual(expect.arrayContaining(['user_info']));
    for (const excluded of ['user_info', 'uuid', 'bottype']) {
      expect(columns.map((c) => c.k)).not.toContain(excluded);
    }
    // ... while the allowlisted fork columns are kept verbatim.
    expect(columns.map((c) => c.k)).toEqual(
      expect.arrayContaining(['note', 'refral', 'notifctions', 'time_sell', 'Service_location']),
    );
    // The report carries no invoice id, Telegram id or username.
    for (const id of ['ab000001', '100000001', 'svc_archive']) expect(report).not.toContain(id);
  });

  it('classifies from the source only, and normalises each field by one rule', async () => {
    await readSnapshot('A');
    const byKey = async (key: string) =>
      (
        await q<Record<string, unknown>>(
          sql`SELECT * FROM legacy_invoice_archive WHERE tenant_id = ${tenantA.tenantId}
               AND invoice_key = ${key}`,
        )
      )[0];
    expect(await byKey('ab000003')).toMatchObject({
      classification: 'ORPHAN_OWNER',
      owner_present: false,
      legacy_user_id: '999999998',
    });
    expect(await byKey('ab000004')).toMatchObject({ classification: 'ORPHAN_OWNER' });
    expect(await byKey('ab000005')).toMatchObject({ classification: 'ORPHAN_OWNER' });
    expect(await byKey('ab000006')).toMatchObject({
      classification: 'LIVE_CANDIDATE',
      product_code: 'p404',
      product_ref: 'NOT_IN_PRODUCT_TABLE',
    });
    expect(await byKey('ab000007')).toMatchObject({ product_code: 'p1', product_ref: 'NAMED' });
    expect(await byKey('ab000008')).toMatchObject({
      classification: 'LIVE_CANDIDATE',
      panel_code: 'zzz',
    });
    for (const key of ['ab000009', 'ab00000a']) {
      expect(await byKey(key)).toMatchObject({ classification: 'NO_PANEL', panel_code: null });
    }
    expect(await byKey('ab00000b')).toMatchObject({ classification: 'TEST', is_test: true });
    expect(await byKey('ab00000c')).toMatchObject({
      classification: 'NOT_LIVE',
      status: 'end_of_time',
    });
    expect(await byKey('INV/2024/001')).toMatchObject({
      classification: 'KEY_SHAPE_UNRECOGNISED',
      key_shape_evidenced: false,
    });
    expect(await byKey('ab000001')).toMatchObject({
      price_raw: '150000',
      price_minor: 150000n,
      price_currency: 'IRT',
      sold_at_raw: '1700000000',
      // unix seconds are UTC by definition: no time zone was guessed.
      sold_at: '2023-11-14 22:13:20+00',
      sold_at_note: null,
    });
    expect(await byKey('ab00000d')).toMatchObject({
      sold_at: null,
      sold_at_note: 'FORMAT_UNKNOWN',
    });
    expect(await byKey('ab00000e')).toMatchObject({ sold_at: null, sold_at_note: 'OUT_OF_RANGE' });
    expect(await byKey('ab00000f')).toMatchObject({ sold_at: null, sold_at_note: 'EMPTY' });
    expect(await byKey('ab000011')).toMatchObject({
      price_raw: '150,000',
      price_minor: null,
      price_currency: null,
      price_note: 'NOT_A_NUMBER',
    });
    expect(await byKey('ab000014')).toMatchObject({ price_raw: null, price_note: 'EMPTY' });
  });

  it('a rerun of the same read appends nothing: idempotent', async () => {
    await readSnapshot('A');
    const first = await archiveRows();
    const before = await databaseFingerprint(db());
    const again = await readSnapshot('A');
    expect(await archiveRows()).toEqual(first);
    expect(again.written?.run).toMatchObject({
      insertedNew: 0n,
      insertedRevision: 0n,
      unchanged: BigInt(first.length),
      missingInSnapshot: 0n,
    });
    // Only the run bookkeeping and its audit moved — never the archive.
    expect(Object.keys(changedTables(before, await databaseFingerprint(db()))).sort()).toEqual([
      'audit_logs',
      'legacy_invoice_archive_runs',
    ]);
    expect(again.written?.recorded.created).toBe(false);
  });

  it('a newer snapshot that changes ONE invoice appends exactly one revision row', async () => {
    const a = datasetOf('A');
    await read(a, fp.A);
    const before = await archiveRows();
    const changed = withOneChange(a, 'ab00000c', 'Status', 'active');
    const outcome = await read(changed, await fingerprintsOf(changed));
    const after = await archiveRows();
    expect(after).toHaveLength(before.length + 1);
    expect(after.filter((r) => r.invoice_key === 'ab00000c')).toEqual([
      {
        invoice_key: 'ab00000c',
        revision: 1,
        revision_reason: 'FIRST_SEEN',
        classification: 'NOT_LIVE',
      },
      {
        invoice_key: 'ab00000c',
        revision: 2,
        revision_reason: 'ROW_CHANGED',
        classification: 'LIVE_CANDIDATE',
      },
    ]);
    expect(outcome.written?.run).toMatchObject({ insertedNew: 0n, insertedRevision: 1n });
  });

  it('snapshot B: revisions for changes, new invoices added, a vanished one kept and counted', async () => {
    await readSnapshot('A');
    const outcome = await readSnapshot('B');
    const rows = await archiveRows();
    const keysA = datasetOf('A').tables.invoice.map((r) => r['id_invoice'] as string);
    const keysB = datasetOf('B').tables.invoice.map((r) => r['id_invoice'] as string);
    // Never a duplicate (tenant, key, revision); never an UPDATE (revision 1 rows unchanged).
    expect(new Set(rows.map((r) => `${r.invoice_key}#${String(r.revision)}`)).size).toBe(
      rows.length,
    );
    expect(rows.filter((r) => r.invoice_key === 'ab000001').map((r) => r.revision_reason)).toEqual([
      'FIRST_SEEN',
      'ROW_CHANGED',
    ]);
    // The orphan's owner now exists: the same row, a different class.
    expect(rows.filter((r) => r.invoice_key === 'ab000003')).toEqual([
      {
        invoice_key: 'ab000003',
        revision: 1,
        revision_reason: 'FIRST_SEEN',
        classification: 'ORPHAN_OWNER',
      },
      {
        invoice_key: 'ab000003',
        revision: 2,
        revision_reason: 'CONTEXT_CHANGED',
        classification: 'LIVE_CANDIDATE',
      },
    ]);
    // The vanished invoice is still archived, once.
    expect(rows.filter((r) => r.invoice_key === 'ab000002')).toHaveLength(1);
    const distinct = new Set(rows.map((r) => r.invoice_key));
    const missing = keysA.filter((k) => !keysB.includes(k));
    expect(missing).toEqual(['ab000002']);
    // The closure equations, from the datasets — never a literal.
    expect(outcome.written?.run).toMatchObject({
      sourceInvoiceRows: BigInt(keysB.length),
      insertedNew: BigInt(keysB.filter((k) => !keysA.includes(k)).length),
      insertedRevision: 2n,
      unchanged: BigInt(keysB.length - keysB.filter((k) => !keysA.includes(k)).length - 2),
      missingInSnapshot: BigInt(missing.length),
      archiveInvoicesAfter: BigInt(distinct.size),
    });
    expect(distinct.size).toBe(keysB.length + missing.length);
  });

  it('streams a larger table in bounded batches: every invoice archived once', async () => {
    // Not a real-data figure: enough rows for hundreds of staging and promotion batches.
    // `NEXA_LEGACY_ARCHIVE_SCALE` raises it for a volume rehearsal (docs: importer.md).
    const extra = Number(process.env['NEXA_LEGACY_ARCHIVE_SCALE'] ?? '3000');
    const dataset = buildSyntheticLegacyDataset({ invoiceArchive: 'A', extraInvoices: extra });
    const outcome = await read(dataset, await fingerprintsOf(dataset), tenantA, 500);
    const total = dataset.tables.invoice.length;
    expect(outcome.written?.run).toMatchObject({
      sourceInvoiceRows: BigInt(total),
      insertedNew: BigInt(total),
      archiveInvoicesAfter: BigInt(total),
    });
    const counted = await q<{ n: number; d: number }>(
      sql`SELECT count(*)::int AS n, count(DISTINCT invoice_key)::int AS d
            FROM legacy_invoice_archive WHERE tenant_id = ${tenantA.tenantId}`,
    );
    expect(counted[0]).toEqual({ n: total, d: total });
  }, 600_000);

  // --- crash, divergence, refusal -------------------------------------------------------

  /** The real ingest steps, with a death injected: the step throws, no cleanup runs. */
  function dyingArchive(dieAt: {
    stage?: number;
    promote?: number;
    /** That staging call "succeeds" without writing: a lost batch. */
    lose?: number;
  }): InvoiceArchiveIngest {
    const real = ctx.container.legacyInvoiceArchive;
    let staged = 0;
    let promoted = 0;
    return {
      openRun: (...a) => real.openRun(...a),
      startRun: (...a) => real.startRun(...a),
      stageBatch: async (...a) => {
        staged += 1;
        if (staged === dieAt.stage) throw new Error('process killed mid-staging');
        if (staged === dieAt.lose) return 0;
        return real.stageBatch(...a);
      },
      verifyRun: (...a) => real.verifyRun(...a),
      // A dead process cleans nothing up.
      failRun: () => Promise.resolve(null),
      promoteBatch: async (...a) => {
        promoted += 1;
        if (promoted === dieAt.promote) throw new Error('process killed mid-promotion');
        return real.promoteBatch(...a);
      },
      completeRun: (...a) => real.completeRun(...a),
    };
  }
  const ingestWith = (
    archive: InvoiceArchiveIngest,
    connector: LegacySourceConnector,
    productionLikeTarget = false,
  ) =>
    readLegacyInvoiceArchive(
      {
        processLock: freeLock,
        archive,
        recordReadSetRun: (scope, actor, observation) =>
          ctx.container.legacyImporter().recordReadSetRun(scope, actor, observation),
      },
      {
        scope: tenantA,
        actor: job,
        connector,
        expectedFingerprint: fp.A.v1,
        expectedInvoiceArchiveFingerprint: fp.A.archive,
        batchSize: 4,
        productionLikeTarget,
      },
    );

  it('a crash mid-staging archives nothing; the next read discards it and archives exactly once', async () => {
    await expect(
      ingestWith(dyingArchive({ stage: 3 }), connectorOf(datasetOf('A'))),
    ).rejects.toThrow(/mid-staging/u);
    expect(await archiveRows()).toEqual([]);
    const left = await runs();
    expect(left).toHaveLength(1);
    expect(left[0]?.state).toBe('STAGING');
    expect(left[0]?.n).toBeGreaterThan(0);
    // Nothing is visible.
    expect((await service().list(tenantA, owner, {})).rows).toEqual([]);

    const outcome = await readSnapshot('A');
    expect(outcome.abandonedRunId).not.toBeNull();
    expect(await runs()).toEqual([
      { state: 'FAILED', failure_code: 'ABANDONED', n: 0 },
      { state: 'COMPLETED', failure_code: null, n: 0 },
    ]);
    const rows = await archiveRows();
    expect(rows).toHaveLength(datasetOf('A').tables.invoice.length);
    expect(new Set(rows.map((r) => r.revision))).toEqual(new Set([1]));
  });

  it('a crash mid-promotion is finished by the next run — without reading the source again', async () => {
    await expect(
      ingestWith(dyingArchive({ promote: 3 }), connectorOf(datasetOf('A'))),
    ).rejects.toThrow(/mid-promotion/u);
    const partial = await archiveRows();
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(datasetOf('A').tables.invoice.length);
    expect((await runs())[0]?.state).toBe('VERIFIED');
    // A VERIFIED run's revisions are not visible yet.
    expect((await service().list(tenantA, owner, {})).rows).toEqual([]);
    expect((await service().summary(tenantA, owner)).invoices).toBe(0);

    const unreadable: LegacySourceConnector = {
      label: 'must not be opened',
      open: () => Promise.reject(new Error('the source was opened')),
    };
    const outcome = await ingestWith(ctx.container.legacyInvoiceArchive, unreadable);
    expect(outcome.written?.run.state).toBe('COMPLETED');
    // Finished without reading: the columns this run read are not claimed.
    expect(outcome.invoiceColumnsRead).toBeNull();
    expect(invoicesReadReport(outcome, 'md')).toContain('invoice columns read: not known');
    expect(JSON.parse(invoicesReadReport(outcome, 'json'))).toMatchObject({ columnsRead: null });
    const rows = await archiveRows();
    expect(rows).toHaveLength(datasetOf('A').tables.invoice.length);
    expect(new Set(rows.map((r) => r.revision))).toEqual(new Set([1]));
    expect(await runs()).toEqual([{ state: 'COMPLETED', failure_code: null, n: 0 }]);
    expect((await service().summary(tenantA, owner)).invoices).toBe(rows.length);
  });

  it('staged rows that do not add up to the read fail the run: nothing archived', async () => {
    await expect(
      ingestWith(dyingArchive({ lose: 2 }), connectorOf(datasetOf('A'))),
    ).rejects.toThrow(/STAGED_COUNT_MISMATCH/u);
    expect(await archiveRows()).toEqual([]);
    expect(await runs()).toEqual([
      { state: 'FAILED', failure_code: 'STAGED_COUNT_MISMATCH', n: 0 },
    ]);
  });

  it('an open SYNTHETIC run is never resumed or discarded on a production-like target', async () => {
    // A VERIFIED synthetic run left open (e.g. a restored or promoted staging database) ...
    await expect(
      ingestWith(dyingArchive({ promote: 2 }), connectorOf(datasetOf('A'))),
    ).rejects.toThrow(/mid-promotion/u);
    const opened: string[] = [];
    const watched: LegacySourceConnector = {
      label: 'watched',
      open: () => {
        opened.push('opened');
        return connectorOf(datasetOf('A')).open();
      },
    };
    const before = await databaseFingerprint(db());
    // ... is refused BEFORE it is promoted, completed or the source opened.
    await expect(
      ingestWith(ctx.container.legacyInvoiceArchive, watched, true),
    ).rejects.toMatchObject({ code: 'SYNTHETIC_RUN_ON_PRODUCTION_TARGET' });
    expect(opened).toEqual([]);
    expect(changedTables(before, await databaseFingerprint(db()))).toEqual({});
    expect((await runs())[0]?.state).toBe('VERIFIED');
    // A STAGING one is not even discarded there.
    await ctx.reset();
    await expect(
      ingestWith(dyingArchive({ stage: 2 }), connectorOf(datasetOf('A'))),
    ).rejects.toThrow(/mid-staging/u);
    const staging = await databaseFingerprint(db());
    await expect(
      ingestWith(ctx.container.legacyInvoiceArchive, watched, true),
    ).rejects.toMatchObject({ code: 'SYNTHETIC_RUN_ON_PRODUCTION_TARGET' });
    expect(changedTables(staging, await databaseFingerprint(db()))).toEqual({});
    expect(opened).toEqual([]);
  });

  it('a read whose delivery diverges from its verified pass archives NOTHING', async () => {
    const dataset = datasetOf('A');
    const base = connectorOf(dataset);
    // The invoice table's SECOND read-set pass sees one cell differently: not one snapshot.
    let invoicePasses = 0;
    const diverging: LegacySourceConnector = {
      label: 'diverging',
      async open() {
        const session = await base.open();
        return {
          ...session,
          readSetRows(table, pk, columns) {
            const rows = session.readSetRows(table, pk, columns);
            if (table !== 'invoice') return rows;
            invoicePasses += 1;
            if (invoicePasses < 2) return rows;
            return (async function* () {
              for await (const r of rows) {
                yield r[0] === 'ab000001' ? r.map((c, i) => (i === 3 ? 'disabled' : c)) : r;
              }
            })();
          },
        } satisfies LegacySourceSession;
      },
    };
    await expect(ingestWith(ctx.container.legacyInvoiceArchive, diverging)).rejects.toThrow(
      /READ_SET_SNAPSHOT_DIVERGED/u,
    );
    expect(await archiveRows()).toEqual([]);
    expect(await runs()).toEqual([{ state: 'FAILED', failure_code: 'SNAPSHOT_DIVERGED', n: 0 }]);
    expect(await auditCount('legacy.invoice_archive.run_failed')).toBe(1);
  });

  it('two source rows sharing an invoice id are refused, never collapsed: nothing archived', async () => {
    const dataset = datasetOf('A');
    const duplicated = {
      ...dataset,
      tables: {
        ...dataset.tables,
        invoice: [
          ...dataset.tables.invoice,
          { ...(dataset.tables.invoice[0] as SyntheticRow), username: 'the other one' },
        ],
      },
    } as SyntheticLegacyDataset;
    await expect(read(duplicated, await fingerprintsOf(duplicated))).rejects.toThrow(
      /SOURCE_KEY_DUPLICATED/u,
    );
    expect(await archiveRows()).toEqual([]);
    expect(await runs()).toEqual([
      { state: 'FAILED', failure_code: 'SOURCE_KEY_DUPLICATED', n: 0 },
    ]);
  });

  it('a cell PostgreSQL cannot hold verbatim fails the run: nothing archived', async () => {
    const poisoned = withOneChange(datasetOf('A'), 'ab000001', 'note', 'a\u0000b');
    await expect(read(poisoned, await fingerprintsOf(poisoned))).rejects.toThrow(
      /CELL_UNREPRESENTABLE: invoice\.note/u,
    );
    expect(await archiveRows()).toEqual([]);
    expect(await runs()).toEqual([{ state: 'FAILED', failure_code: 'CELL_UNREPRESENTABLE', n: 0 }]);
  });

  it('a stopped tenant is refused inside the transaction; nothing archived', async () => {
    await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${tenantA.tenantId}`);
    await expect(readSnapshot('A')).rejects.toMatchObject({
      code: 'legacy_invoice_archive.scope_stopped',
    });
    expect(await archiveRows()).toEqual([]);
  });

  // --- the database guards ------------------------------------------------------------

  it('is append-only at the database: no UPDATE, no DELETE, whoever asks', async () => {
    await readSnapshot('A');
    for (const statement of [
      sql`UPDATE legacy_invoice_archive SET status = 'x' WHERE tenant_id = ${tenantA.tenantId}`,
      sql`DELETE FROM legacy_invoice_archive WHERE tenant_id = ${tenantA.tenantId}`,
      sql`DELETE FROM legacy_invoice_archive_runs WHERE tenant_id = ${tenantA.tenantId}`,
    ]) {
      await expect(db().execute(statement)).rejects.toThrow();
    }
    // A revision whose class disagrees with its own facts cannot be written either.
    await expect(
      db().execute(sql`INSERT INTO legacy_invoice_archive
        SELECT gen_random_uuid(), tenant_id, run_id, invoice_key, revision + 1, 'ROW_CHANGED',
               key_shape_evidenced, raw_row, row_checksum, archive_checksum, 'LIVE_CANDIDATE',
               live, status, is_test, legacy_user_id, owner_present, username, panel_code,
               product_code, product_ref, product_name, price_raw, price_minor, price_currency,
               price_note, sold_at_raw, sold_at, sold_at_note, read_set_fingerprint,
               source_fingerprint, normalization_version, archived_at
          FROM legacy_invoice_archive WHERE invoice_key = 'ab00000b'`),
    ).rejects.toMatchObject({ cause: { constraint: 'legacy_invoice_archive_class_check' } });
  });

  it('references nothing but its tenant and its run: no order, payment, wallet or service', async () => {
    const fks = await q<{ table_name: string; referenced: string }>(sql`
      SELECT c.conrelid::regclass::text AS table_name, c.confrelid::regclass::text AS referenced
        FROM pg_constraint c
       WHERE c.contype = 'f'
         AND c.conrelid::regclass::text IN ('legacy_invoice_archive', 'legacy_invoice_archive_runs',
                                           'legacy_invoice_archive_staging')
       ORDER BY 1, 2`);
    expect(fks.map((fk) => `${fk.table_name}->${fk.referenced}`)).toEqual([
      'legacy_invoice_archive->legacy_invoice_archive_runs',
      'legacy_invoice_archive->tenants',
      'legacy_invoice_archive_runs->tenants',
      'legacy_invoice_archive_staging->legacy_invoice_archive_runs',
      'legacy_invoice_archive_staging->tenants',
    ]);
    // ... and nothing references the archive.
    const inbound = await q<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE contype = 'f' AND confrelid = 'legacy_invoice_archive'::regclass`);
    expect(inbound[0]?.n).toBe(0);
  });

  it('backfills the two keys into existing owner roles only, idempotently', async () => {
    await db().execute(
      sql`DELETE FROM role_permissions WHERE permission_key LIKE 'legacy.invoices.%'`,
    );
    const migration = readFileSync(
      'apps/api/drizzle/0225_legacy_invoice_archive_grants.sql',
      'utf8',
    );
    const backfill = migration.slice(migration.indexOf('INSERT INTO "role_permissions"'));
    await db().execute(sql.raw(backfill));
    await db().execute(sql.raw(backfill));
    const rows = await q<{ role_key: string; permission_key: string }>(
      sql`SELECT r.key AS role_key, rp.permission_key FROM role_permissions rp
            JOIN roles r ON r.id = rp.role_id
           WHERE rp.tenant_id = ${tenantA.tenantId} AND rp.permission_key LIKE 'legacy.invoices.%'
           ORDER BY r.key, rp.permission_key`,
    );
    expect(rows.map((r) => `${r.role_key}:${r.permission_key}`)).toEqual([
      'owner:legacy.invoices.pii.view',
      'owner:legacy.invoices.view',
    ]);
  });

  // --- reads, permissions, tenancy ------------------------------------------------------

  it('lists the latest visible revision with keyset pages and every filter', async () => {
    await readSnapshot('A');
    await readSnapshot('B');
    const all: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await service().list(tenantA, owner, { limit: 7, ...(after ? { after } : {}) });
      all.push(...page.rows.map((r) => r.record.invoiceKey));
      if (page.nextCursor === null) break;
      after = page.nextCursor;
    }
    const distinct = new Set((await archiveRows()).map((r) => r.invoice_key));
    expect(all).toHaveLength(distinct.size);
    expect(new Set(all)).toEqual(distinct);
    // The latest revision only.
    const one = await service().list(tenantA, owner, { invoiceId: 'ab000001' });
    expect(one.rows.map((r) => [r.record.invoiceKey, r.record.revision])).toEqual([
      ['ab000001', 2],
    ]);
    const filtered = async (query: Record<string, string>) =>
      (await service().list(tenantA, owner, query)).rows.map((r) => r.record.invoiceKey).sort();
    expect(await filtered({ invoiceId: 'INV/' })).toEqual(['INV/2024/001']);
    expect(await filtered({ invoiceId: 'ab00000' })).toHaveLength(15);
    expect(await filtered({ classification: 'NO_PANEL', invoiceId: 'ab' })).toEqual([
      'ab000009',
      'ab00000a',
    ]);
    expect(await filtered({ status: 'end_of_time' })).toEqual(['ab000002', 'ab00000c']);
    expect(await filtered({ panelCode: 'zzz', invoiceId: 'ab' })).toEqual(['ab000008']);
    expect(await filtered({ productCode: 'p404' })).toEqual(['ab000006']);
    expect(await filtered({ test: 'true', invoiceId: 'ab' })).toEqual(['ab00000b']);
    expect(await filtered({ legacyUserId: '999999998' })).toEqual(['ab000003']);
    expect(await filtered({ username: 'SVC_ARCH', invoiceId: 'ab00001' })).toHaveLength(5);
    // A pattern character typed into a search is a literal.
    expect(await filtered({ invoiceId: 'ab%' })).toEqual([]);
  });

  it('finds a verbatim key exactly as typed, spaces included, and pages past the longest key', async () => {
    const base = datasetOf('A');
    const longKey = '\u{1F600}'.repeat(500); // 500 four-byte characters: a 2000-byte key
    const template = base.tables.invoice.find(
      (r) => r['id_invoice'] === 'ab000001',
    ) as SyntheticRow;
    const dataset = {
      ...base,
      tables: {
        ...base.tables,
        invoice: [
          ...base.tables.invoice,
          { ...template, id_invoice: longKey },
          { ...template, id_invoice: `${longKey}z` },
        ],
      },
    } as SyntheticLegacyDataset;
    await read(dataset, await fingerprintsOf(dataset));
    const parse = (query: Record<string, unknown>) =>
      legacyInvoiceArchiveListQuerySchema.parse(query);
    // ` padded ` is found by itself; `padded` (no leading space) is a different key.
    expect(
      (await service().list(tenantA, owner, parse({ invoiceId: ' padded ' }))).rows.map(
        (r) => r.record.invoiceKey,
      ),
    ).toEqual([' padded ']);
    expect((await service().list(tenantA, owner, parse({ invoiceId: 'padded' }))).rows).toEqual([]);
    expect(() => parse({ invoiceId: '' })).toThrow();
    // Walk one row per page: the page that ENDS on the longest key has a cursor the contract
    // accepts, and the next page is the key after it.
    const keys: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await service().list(
        tenantA,
        owner,
        parse({ limit: '1', ...(after === undefined ? {} : { after }) }),
      );
      keys.push(...page.rows.map((r) => r.record.invoiceKey));
      if (page.nextCursor === null) break;
      after = page.nextCursor;
    }
    const at = keys.indexOf(longKey);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(keys[at + 1]).toBe(`${longKey}z`);
    expect(keys).toHaveLength(dataset.tables.invoice.length);
  }, 120_000);

  it('redacts personal data without the PII key; a PII search is refused and audited', async () => {
    await readSnapshot('A');
    const viewer = await createAdmin(ctx.container, tenantA, { username: 'viewer-lia' });
    await db().execute(sql`
      INSERT INTO admin_permission_overrides (tenant_id, admin_id, permission_key, effect, reason)
      VALUES (${tenantA.tenantId}, ${viewer.id}, 'legacy.invoices.view', 'GRANT', 'test')`);
    const actor = adminActorFor(viewer);
    const page = await service().list(tenantA, actor, { invoiceId: 'ab000001' });
    expect(page.rows[0]).toMatchObject({
      piiRedacted: true,
      record: { legacyUserId: null, username: null, priceMinor: 150000n },
    });
    const detail = await service().get(tenantA, actor, page.rows[0]?.record.id ?? '');
    expect(detail.redactedColumns).toEqual(['id_user', 'note', 'refral', 'username']);
    expect(detail.raw).toMatchObject({ id_user: null, username: null, note: null, refral: null });
    expect(detail.raw['Status']).toBe('active');
    for (const query of [{ legacyUserId: '100000001' }, { username: 'svc' }]) {
      await expect(service().list(tenantA, actor, query)).rejects.toMatchObject({
        kind: 'PERMISSION_DENIED',
      });
    }
    expect(await auditCount('legacy.invoice_archive.pii_search', 'DENIED')).toBe(2);
    expect(await auditCount('legacy.invoice_archive.pii_view')).toBe(0);

    // The owner holds both: unredacted, and each reveal / PII search audited by NAME only.
    const full = await service().get(tenantA, owner, detail.record.id);
    expect(full.piiRedacted).toBe(false);
    expect(full.raw).toMatchObject({ id_user: '100000001', note: 'my config' });
    await service().list(tenantA, owner, { legacyUserId: '100000001' });
    // The detail, and the unredacted list page the PII search returned.
    expect(await auditCount('legacy.invoice_archive.pii_view')).toBe(2);
    expect(await auditCount('legacy.invoice_archive.pii_search')).toBe(1);
    // An unredacted list WITHOUT a PII filter is a reveal too: audited, ids and counts only.
    const plain = await service().list(tenantA, owner, { invoiceId: 'ab00000', limit: 4 });
    expect(plain.rows[0]?.piiRedacted).toBe(false);
    expect(await auditCount('legacy.invoice_archive.pii_view')).toBe(3);
    const [listed] = await q<{ after: Record<string, unknown> }>(
      sql`SELECT after FROM audit_logs WHERE action = 'legacy.invoice_archive.pii_view'
           ORDER BY occurred_at DESC, id DESC LIMIT 1`,
    );
    expect(listed?.after).toEqual({
      list: true,
      count: 4,
      filters: ['invoiceIdPrefix'],
      rowIds: plain.rows.map((r) => r.record.id),
    });
    // A redacted reader's list reveals nothing and audits nothing.
    await service().list(tenantA, actor, {});
    expect(await auditCount('legacy.invoice_archive.pii_view')).toBe(3);
    const audits = await q<{ t: string }>(
      sql`SELECT row_to_json(a)::text AS t FROM audit_logs a WHERE action LIKE 'legacy.invoice_archive.pii%'`,
    );
    for (const row of audits) expect(row.t).not.toContain('100000001');
  });

  it('operator and observer cannot read the archive; denials are recorded', async () => {
    await readSnapshot('A');
    for (const roleKey of ['operator', 'observer']) {
      const actor = adminActorFor(
        await createAdmin(ctx.container, tenantA, {
          username: `${roleKey}-lia`,
          roleKeys: [roleKey],
        }),
      );
      await expect(service().list(tenantA, actor, {})).rejects.toMatchObject({
        kind: 'PERMISSION_DENIED',
      });
      await expect(service().summary(tenantA, actor)).rejects.toMatchObject({
        kind: 'PERMISSION_DENIED',
      });
    }
    const denials = await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM operational_events
      WHERE code = 'access.permission_denied'`);
    expect(denials[0]?.n).toBeGreaterThan(0);
    // An admin cannot run the ingest steps either: they are maintenance.run.
    await expect(service().openRun(tenantA, owner)).resolves.toBeNull();
    const viewer = adminActorFor(
      await createAdmin(ctx.container, tenantA, { username: 'op2-lia', roleKeys: ['operator'] }),
    );
    await expect(service().openRun(tenantA, viewer)).rejects.toMatchObject({
      kind: 'PERMISSION_DENIED',
    });
  });

  it('keeps tenants apart: another tenant sees none of it and archives its own', async () => {
    await readSnapshot('A');
    const ownerB = adminActorFor(
      await createAdmin(ctx.container, tenantB, { username: 'owner-b-lia', roleKeys: ['owner'] }),
    );
    expect((await service().list(tenantB, ownerB, {})).rows).toEqual([]);
    expect((await service().summary(tenantB, ownerB)).invoices).toBe(0);
    const aRow = (await service().list(tenantA, owner, { limit: 1 })).rows[0];
    await expect(service().get(tenantB, ownerB, aRow?.record.id ?? '')).rejects.toMatchObject({
      code: 'legacy_invoice_archive.not_found',
    });
    await readSnapshot('A', tenantB);
    expect((await archiveRows(tenantB)).length).toBe((await archiveRows(tenantA)).length);
    // Tenant B's read added nothing to tenant A.
    expect((await runs(tenantA)).length).toBe(1);
  });

  it('the Web Admin surface: the wire shapes parse; the summary carries no personal data', async () => {
    await readSnapshot('A');
    const { token } = await ctx.container.auth.login(
      tenantA,
      {
        type: 'API',
        id: null,
        label: null,
        surface: 'WEB',
        correlationId: 'lia-web' as CorrelationId,
      },
      { username: 'owner-lia', password: 'a-perfectly-fine-password' },
      { ip: '203.0.113.10', userAgent: 'vitest' },
    );
    type WebRequest = Parameters<LegacyInvoicesController['list']>[0];
    const request = {
      method: 'GET',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
      ip: '203.0.113.10',
    } as unknown as WebRequest;
    const controller = new LegacyInvoicesController(ctx.container);
    const listed = legacyInvoiceArchiveListResponseSchema.parse(
      await controller.list(request, { limit: '3' }),
    );
    expect(listed.rows).toHaveLength(3);
    expect(listed.nextCursor).not.toBeNull();
    const next = legacyInvoiceArchiveListResponseSchema.parse(
      await controller.list(request, { limit: '3', after: listed.nextCursor }),
    );
    expect(next.rows.map((r) => r.id)).not.toContain(listed.rows[0]?.id);
    const detail = legacyInvoiceArchiveDetailResponseSchema.parse(
      await controller.detail(request, listed.rows[0]?.id ?? ''),
    );
    expect(detail.revisions).toHaveLength(1);
    expect(detail.revisions[0]?.visible).toBe(true);
    const summary = legacyInvoiceArchiveSummaryResponseSchema.parse(
      await controller.summary(request),
    );
    expect(summary.invoices).toBe(datasetOf('A').tables.invoice.length);
    expect(Object.values(summary.classes).reduce((a, b) => a + b, 0)).toBe(summary.invoices);
    const text = JSON.stringify(summary);
    for (const id of ['ab000001', '100000001', 'svc_archive']) expect(text).not.toContain(id);
    await expect(controller.list(request, { after: 'not a cursor!' })).rejects.toThrow();
  });
});
