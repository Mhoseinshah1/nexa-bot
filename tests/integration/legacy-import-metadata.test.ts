import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  LEGACY_IMPORT_ERROR_CODES,
  LEGACY_IMPORT_SOURCE_TABLES,
  isLegacyImportKey,
  PLATFORM_ERROR_CODES,
  isNexaError,
  type TenantContext,
} from '@nexa/contracts';
import { DrizzleLegacyImportRepository } from '../../apps/api/src/modules/platform/legacy-import/infrastructure/drizzle-legacy-import.repository';
import { createTestContext, tenantA, tenantB, type TestContext } from './harness';

/**
 * Migration P4 (`docs/legacy-import-metadata.md`) against a real PostgreSQL: the unique legacy
 * key, the idempotent upsert, resume semantics, run lifecycle by conditional update, tenant
 * isolation, and the absence of any column that could hold a secret or a raw source row.
 */

const A = tenantA as TenantContext;
const B = tenantB as TenantContext;
const FP1 = '1'.repeat(64);
const FP2 = '2'.repeat(64);
const SUM1 = 'a'.repeat(64);
const SUM2 = 'b'.repeat(64);

/** A PostgreSQL error naming this constraint, wherever drizzle nested it. */
function violates(constraint: string): (error: unknown) => boolean {
  return (error: unknown) => {
    for (let e: unknown = error; e !== null && typeof e === 'object';) {
      if ((e as { constraint?: unknown }).constraint === constraint) return true;
      e = (e as { cause?: unknown }).cause;
    }
    return false;
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (isNexaError(error)) return error.code;
    throw error;
  }
}

describe('legacy import metadata', () => {
  let ctx: TestContext;
  let repo: DrizzleLegacyImportRepository;
  let t0: Date;
  const at = (seconds: number): Date => new Date(t0.getTime() + seconds * 1000);

  const run = <T>(scope: TenantContext, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    ctx.container.uow.run(scope, fn);

  const start = (scope: TenantContext, mode: 'APPLY' | 'DRY_RUN' = 'APPLY', fp = FP1) =>
    run(scope, (tx) =>
      repo.startOrResume(
        scope,
        { id: randomUUID(), mode, sourceFingerprint: fp, codeVersion: 'abc1234', now: at(0) },
        tx,
      ),
    );

  const customerDecision = (entityId: string) =>
    ({ status: 'IMPORTED', entityType: 'CUSTOMER', entityId, reasonCode: null }) as const;

  beforeAll(async () => {
    ctx = await createTestContext();
    repo = new DrizzleLegacyImportRepository(ctx.container.database.db);
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    await ctx.reset();
    t0 = new Date('2026-10-03T00:00:00.000Z');
  });

  it('starts a run, and a second start with the same source and mode RESUMES it', async () => {
    const first = await start(A);
    expect(first.kind).toBe('STARTED');
    const again = await start(A);
    expect(again.kind).toBe('RESUMED');
    expect(again.run.id).toBe(first.run.id);
  });

  it('refuses a second RUNNING run with a different source or mode', async () => {
    await start(A);
    expect(await codeOf(start(A, 'APPLY', FP2))).toBe(LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT);
    expect(await codeOf(start(A, 'DRY_RUN', FP1))).toBe(LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT);
  });

  it('two concurrent starts produce one run: one STARTED, one RESUMED', async () => {
    const results = await Promise.all([start(A), start(A)]);
    const kinds = results.map((r) => r.kind).sort();
    expect(kinds).toEqual(['RESUMED', 'STARTED']);
    expect(results[0]?.run.id).toBe(results[1]?.run.id);
  });

  it('upsert by legacy key is idempotent: insert, unchanged replay, one row', async () => {
    const { run: r } = await start(A);
    const entity = randomUUID();
    const write = {
      runId: r.id,
      legacyTable: 'user',
      legacyId: '1000001',
      checksum: SUM1,
      decision: customerDecision(entity),
      now: at(1),
    };
    const first = await run(A, (tx) => repo.recordDecision(A, write, tx));
    expect(first.kind).toBe('INSERTED');
    const second = await run(A, (tx) => repo.recordDecision(A, { ...write, now: at(2) }, tx));
    expect(second.kind).toBe('UNCHANGED');
    expect(second.record.attempts).toBe(1);

    const rows = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM legacy_import_map WHERE legacy_id = '1000001'`,
    );
    expect((rows.rows[0] as { n: number }).n).toBe(1);
  });

  it('two concurrent writes for one legacy key leave one row', async () => {
    const { run: r } = await start(A);
    const entity = randomUUID();
    const write = {
      runId: r.id,
      legacyTable: 'user',
      legacyId: '42',
      checksum: SUM1,
      decision: customerDecision(entity),
      now: at(1),
    };
    const results = await Promise.all([
      run(A, (tx) => repo.recordDecision(A, write, tx)),
      run(A, (tx) => repo.recordDecision(A, write, tx)),
    ]);
    expect(results.map((x) => x.kind).sort()).toEqual(['INSERTED', 'UNCHANGED']);
  });

  it('the database itself refuses a second row for one (tenant, legacy_table, legacy_id)', async () => {
    const { run: r } = await start(A);
    const insert = () =>
      ctx.container.database.db.execute(
        sql`INSERT INTO legacy_import_map (tenant_id, legacy_table, legacy_id, run_id, checksum,
              status, reason_code, created_at, updated_at)
            VALUES (${A.tenantId}, 'user', '7', ${r.id}, ${SUM1}, 'SKIPPED', 'TEST_PANEL', now(), now())`,
      );
    await insert();
    await expect(insert()).rejects.toSatisfy(violates('legacy_import_map_pk'));
  });

  it('an IMPORTED row is never re-pointed, downgraded or silently re-checksummed', async () => {
    const { run: r } = await start(A);
    const entity = randomUUID();
    const base = {
      runId: r.id,
      legacyTable: 'user',
      legacyId: '9',
      checksum: SUM1,
      decision: customerDecision(entity),
      now: at(1),
    };
    await run(A, (tx) => repo.recordDecision(A, base, tx));

    const repoint = await run(A, (tx) =>
      repo.recordDecision(A, { ...base, decision: customerDecision(randomUUID()) }, tx),
    );
    expect(repoint).toMatchObject({ kind: 'REFUSED', reason: 'IMPORTED_ENTITY_MISMATCH' });

    const downgrade = await run(A, (tx) =>
      repo.recordDecision(
        A,
        { ...base, decision: { status: 'FAILED', reasonCode: 'INTERNAL_ERROR' } },
        tx,
      ),
    );
    expect(downgrade).toMatchObject({ kind: 'REFUSED', reason: 'IMPORTED_ENTITY_MISMATCH' });

    const drift = await run(A, (tx) => repo.recordDecision(A, { ...base, checksum: SUM2 }, tx));
    expect(drift).toMatchObject({ kind: 'REFUSED', reason: 'IMPORTED_SOURCE_CHANGED' });

    const [row] = await repo.findByLegacyKeys(A, 'user', ['9']);
    expect(row).toMatchObject({
      status: 'IMPORTED',
      entityId: entity,
      checksum: SUM1,
      attempts: 1,
    });
  });

  it('resume: a later run revisits FAILED/MANUAL_REVIEW rows and keeps IMPORTED ones', async () => {
    const { run: r1 } = await start(A);
    const entity = randomUUID();
    await run(A, async (tx) => {
      await repo.recordDecision(
        A,
        {
          runId: r1.id,
          legacyTable: 'user',
          legacyId: '1',
          checksum: SUM1,
          decision: customerDecision(entity),
          now: at(1),
        },
        tx,
      );
      await repo.recordDecision(
        A,
        {
          runId: r1.id,
          legacyTable: 'user',
          legacyId: '2',
          checksum: SUM1,
          decision: { status: 'FAILED', reasonCode: 'PROVIDER_READ_FAILED' },
          now: at(1),
        },
        tx,
      );
    });
    const failed = await run(A, (tx) =>
      repo.finish(A, r1.id, { status: 'FAILED', failureCode: 'PROVIDER_UNAVAILABLE' }, at(2), tx),
    );
    expect(failed).toMatchObject({ status: 'FAILED', rowsImported: 1, rowsFailed: 1 });

    const { run: r2, kind } = await start(A);
    expect(kind).toBe('STARTED');
    expect(r2.id).not.toBe(r1.id);

    const existing = await repo.findByLegacyKeys(A, 'user', ['1', '2', '3']);
    expect(existing.map((e) => [e.legacyId, e.status])).toEqual([
      ['1', 'IMPORTED'],
      ['2', 'FAILED'],
    ]);

    const retried = await run(A, (tx) =>
      repo.recordDecision(
        A,
        {
          runId: r2.id,
          legacyTable: 'user',
          legacyId: '2',
          checksum: SUM1,
          decision: customerDecision(randomUUID()),
          now: at(3),
        },
        tx,
      ),
    );
    expect(retried.kind).toBe('UPDATED');
    expect(retried.record).toMatchObject({ runId: r2.id, attempts: 2, status: 'IMPORTED' });

    const done = await run(A, (tx) => repo.finish(A, r2.id, { status: 'COMPLETED' }, at(4), tx));
    // Counters are what THIS run wrote: row 1 was not rewritten by r2.
    expect(done).toMatchObject({
      status: 'COMPLETED',
      rowsImported: 1,
      rowsFailed: 0,
      failureCode: null,
    });
  });

  it('run transitions are conditional: a finished run neither finishes again nor writes', async () => {
    const { run: r } = await start(A);
    await run(A, (tx) => repo.checkpoint(A, r.id, 10, at(1), tx));
    const back = await run(A, (tx) => repo.checkpoint(A, r.id, 5, at(2), tx));
    expect(back.rowsSeen).toBe(10);
    await run(A, (tx) => repo.finish(A, r.id, { status: 'ABORTED' }, at(3), tx));

    expect(
      await codeOf(run(A, (tx) => repo.finish(A, r.id, { status: 'COMPLETED' }, at(4), tx))),
    ).toBe(LEGACY_IMPORT_ERROR_CODES.RUN_NOT_WRITABLE);
    expect(await codeOf(run(A, (tx) => repo.checkpoint(A, r.id, 11, at(4), tx)))).toBe(
      LEGACY_IMPORT_ERROR_CODES.RUN_NOT_WRITABLE,
    );
    expect(
      await codeOf(
        run(A, (tx) =>
          repo.recordDecision(
            A,
            {
              runId: r.id,
              legacyTable: 'user',
              legacyId: '1',
              checksum: SUM1,
              decision: customerDecision(randomUUID()),
              now: at(4),
            },
            tx,
          ),
        ),
      ),
    ).toBe(LEGACY_IMPORT_ERROR_CODES.RUN_NOT_WRITABLE);
  });

  it('a DRY_RUN run writes no map rows', async () => {
    const { run: r } = await start(A, 'DRY_RUN');
    expect(
      await codeOf(
        run(A, (tx) =>
          repo.recordDecision(
            A,
            {
              runId: r.id,
              legacyTable: 'user',
              legacyId: '1',
              checksum: SUM1,
              decision: customerDecision(randomUUID()),
              now: at(1),
            },
            tx,
          ),
        ),
      ),
    ).toBe(LEGACY_IMPORT_ERROR_CODES.RUN_NOT_WRITABLE);
  });

  it('a finish waits for an in-flight map write and counts it', async () => {
    const { run: r } = await start(A);
    let releaseWriter!: () => void;
    const writerHolds = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let writerWrote!: () => void;
    const wrote = new Promise<void>((resolve) => {
      writerWrote = resolve;
    });
    const writer = run(A, async (tx) => {
      await repo.recordDecision(
        A,
        {
          runId: r.id,
          legacyTable: 'user',
          legacyId: '1',
          checksum: SUM1,
          decision: customerDecision(randomUUID()),
          now: at(1),
        },
        tx,
      );
      writerWrote();
      await writerHolds;
    });
    await wrote;
    const finishing = run(A, (tx) => repo.finish(A, r.id, { status: 'COMPLETED' }, at(2), tx));
    // Give the finish time to reach the lock it must wait on.
    await new Promise((resolve) => setTimeout(resolve, 200));
    releaseWriter();
    await writer;
    const finished = await finishing;
    expect(finished.rowsImported).toBe(1);
  });

  it('tenant isolation: another tenant cannot see, resume, finish or write through a run', async () => {
    const { run: r } = await start(A);
    await run(A, (tx) =>
      repo.recordDecision(
        A,
        {
          runId: r.id,
          legacyTable: 'user',
          legacyId: '1',
          checksum: SUM1,
          decision: customerDecision(randomUUID()),
          now: at(1),
        },
        tx,
      ),
    );

    expect(await repo.findRun(B, r.id)).toBeNull();
    expect(await repo.findByLegacyKeys(B, 'user', ['1'])).toEqual([]);
    expect(await repo.summarize(B)).toEqual([]);
    expect(
      await codeOf(run(B, (tx) => repo.finish(B, r.id, { status: 'COMPLETED' }, at(2), tx))),
    ).toBe(LEGACY_IMPORT_ERROR_CODES.RUN_NOT_FOUND);
    expect(
      await codeOf(
        run(B, (tx) =>
          repo.recordDecision(
            B,
            {
              runId: r.id,
              legacyTable: 'user',
              legacyId: '1',
              checksum: SUM1,
              decision: customerDecision(randomUUID()),
              now: at(2),
            },
            tx,
          ),
        ),
      ),
    ).toBe(LEGACY_IMPORT_ERROR_CODES.RUN_NOT_FOUND);

    // Tenant B has its own run and its own row for the same legacy key.
    const { run: rb, kind } = await start(B);
    expect(kind).toBe('STARTED');
    const own = await run(B, (tx) =>
      repo.recordDecision(
        B,
        {
          runId: rb.id,
          legacyTable: 'user',
          legacyId: '1',
          checksum: SUM2,
          decision: customerDecision(randomUUID()),
          now: at(2),
        },
        tx,
      ),
    );
    expect(own.kind).toBe('INSERTED');

    // The composite FK refuses a map row naming another tenant's run, whoever writes it.
    await expect(
      ctx.container.database.db.execute(
        sql`INSERT INTO legacy_import_map (tenant_id, legacy_table, legacy_id, run_id, checksum,
              status, reason_code, created_at, updated_at)
            VALUES (${B.tenantId}, 'user', '99', ${r.id}, ${SUM1}, 'SKIPPED', 'TEST_PANEL', now(), now())`,
      ),
    ).rejects.toSatisfy(violates('legacy_import_map_run_fk'));
  });

  it('refuses system scope (no tenant)', async () => {
    const system = { kind: 'SYSTEM', reason: 'test' } as never;
    expect(await codeOf(repo.findRun(system, randomUUID()))).toBe(
      PLATFORM_ERROR_CODES.TENANT_CONTEXT_MISSING,
    );
  });

  it('reconcile and manual review: counts by reason, keyset pages without gaps or repeats', async () => {
    const { run: r } = await start(A);
    await run(A, async (tx) => {
      for (let i = 0; i < 7; i += 1) {
        await repo.recordDecision(
          A,
          {
            runId: r.id,
            legacyTable: 'user',
            legacyId: `${String(100 + i)}`,
            checksum: SUM1,
            decision: {
              status: 'MANUAL_REVIEW',
              reasonCode: i % 2 === 0 ? 'PROVIDER_MISSING' : 'AMBIGUOUS_PANEL',
            },
            now: at(1),
          },
          tx,
        );
      }
      await repo.recordDecision(
        A,
        {
          runId: r.id,
          legacyTable: 'user',
          legacyId: '199',
          checksum: SUM1,
          decision: { status: 'SKIPPED', reasonCode: 'TEST_PANEL' },
          now: at(1),
        },
        tx,
      );
    });

    expect(await repo.summarize(A)).toEqual([
      { legacyTable: 'user', status: 'MANUAL_REVIEW', reasonCode: 'AMBIGUOUS_PANEL', count: 3 },
      { legacyTable: 'user', status: 'MANUAL_REVIEW', reasonCode: 'PROVIDER_MISSING', count: 4 },
      { legacyTable: 'user', status: 'SKIPPED', reasonCode: 'TEST_PANEL', count: 1 },
    ]);

    const seen: string[] = [];
    let after: { legacyTable: string; legacyId: string } | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await repo.listManualReview(A, { limit: 3, ...(after ? { after } : {}) });
      seen.push(...page.items.map((x) => x.legacyId));
      if (page.next === null) break;
      after = page.next;
    }
    expect(seen).toEqual(['100', '101', '102', '103', '104', '105', '106']);

    const missing = await repo.listManualReview(A, { limit: 50, reasonCode: 'PROVIDER_MISSING' });
    expect(missing.items.map((x) => x.legacyId)).toEqual(['100', '102', '104', '106']);
  });

  it('carries no column that could hold a secret, a raw row or free text', async () => {
    const result = await ctx.container.database.db.execute(
      sql`SELECT table_name, column_name, data_type FROM information_schema.columns
          WHERE table_name IN ('legacy_import_runs', 'legacy_import_map') ORDER BY 1, 2`,
    );
    const columns = result.rows as { table_name: string; column_name: string; data_type: string }[];
    expect(columns.length).toBeGreaterThan(0);
    for (const c of columns) {
      expect(c.data_type).not.toMatch(/json|bytea/);
      expect(c.column_name).not.toMatch(
        /secret|password|token|payload|raw|detail|message|phone|url|config|username|blob/,
      );
    }

    // And the free-text-looking columns are closed by CHECK constraints.
    const { run: r } = await start(A);
    await expect(
      ctx.container.database.db.execute(
        sql`INSERT INTO legacy_import_map (tenant_id, legacy_table, legacy_id, run_id, checksum,
              status, reason_code, created_at, updated_at)
            VALUES (${A.tenantId}, 'user', '1', ${r.id}, ${SUM1}, 'FAILED',
                    'password=hunter2', now(), now())`,
      ),
    ).rejects.toSatisfy(violates('legacy_import_map_reason_check'));
    await expect(
      ctx.container.database.db.execute(
        sql`INSERT INTO legacy_import_map (tenant_id, legacy_table, legacy_id, run_id, checksum,
              status, reason_code, created_at, updated_at)
            VALUES (${A.tenantId}, 'user', '1', ${r.id}, 'not a checksum', 'FAILED',
                    'INTERNAL_ERROR', now(), now())`,
      ),
    ).rejects.toSatisfy(violates('legacy_import_map_checksum_check'));
    await expect(
      ctx.container.database.db.execute(
        sql`INSERT INTO legacy_import_map (tenant_id, legacy_table, legacy_id, run_id, checksum,
              status, reason_code, created_at, updated_at)
            VALUES (${A.tenantId}, 'user', '+989121234567 John', ${r.id}, ${SUM1}, 'FAILED',
                    'INTERNAL_ERROR', now(), now())`,
      ),
    ).rejects.toSatisfy(violates('legacy_import_map_legacy_key_check'));
  });

  it('Codex P2 #175: the key CHECK refuses credential-shaped ids for every table and mirrors the contract', async () => {
    const { run: r } = await start(A);
    const tryInsert = async (table: string, id: string): Promise<string | null> => {
      try {
        await ctx.container.database.db.execute(
          sql`INSERT INTO legacy_import_map (tenant_id, legacy_table, legacy_id, run_id, checksum,
                status, reason_code, created_at, updated_at)
              VALUES (${A.tenantId}, ${table}, ${id}, ${r.id}, ${SUM1}, 'SKIPPED', 'TEST_PANEL',
                      now(), now())`,
        );
        await ctx.container.database.db.execute(
          sql`DELETE FROM legacy_import_map WHERE tenant_id = ${A.tenantId}`,
        );
        return null;
      } catch (error) {
        for (let e: unknown = error; e !== null && typeof e === 'object';) {
          const constraint = (e as { constraint?: unknown }).constraint;
          if (typeof constraint === 'string') return constraint;
          e = (e as { cause?: unknown }).cause;
        }
        throw error;
      }
    };
    const samples = [
      'hunter2',
      'password:hunter2',
      '1',
      '42',
      '7123456789',
      '9'.repeat(20),
      '9'.repeat(21),
      '0123',
      '-1',
      '+989121234567',
      'a b',
      // OQ-P4-01: the invoice shapes, accepted and refused, through both answers.
      'a3f9',
      '9c1e04ab',
      '12345678',
      '1000000a3f9',
      '99999999c1e04ab',
      'A3F9',
      'a3f9b2',
      'a3f9b2c1d0',
      '0123456a3f9',
      '1234567a3f9b2',
      'beefcafe\n',
      'https://sub.example/abc',
    ];
    for (const table of [...LEGACY_IMPORT_SOURCE_TABLES, 'invoice']) {
      for (const id of samples) {
        const refusedBy = await tryInsert(table, id);
        // The database and the contract give the same answer for every sample.
        expect({ table, id, accepted: refusedBy === null }).toEqual({
          table,
          id,
          accepted: isLegacyImportKey(table, id),
        });
      }
    }
    expect(await tryInsert('user', 'hunter2')).toBe('legacy_import_map_legacy_key_check');
    expect(await tryInsert('user', 'password:hunter2')).toBe('legacy_import_map_legacy_key_check');
    // The invoice key refuses a credential the same way, and the user shape is not borrowed.
    expect(await tryInsert('invoice', 'hunter2')).toBe('legacy_import_map_legacy_key_check');
    expect(await tryInsert('invoice', 'password:hunter2')).toBe(
      'legacy_import_map_legacy_key_check',
    );
    expect(await tryInsert('invoice', '1')).toBe('legacy_import_map_legacy_key_check');
    expect(await tryInsert('invoice', '9c1e04ab')).toBeNull();
    // Either CHECK may report first; both refuse a table outside the evidenced set.
    expect(await tryInsert('product', '1')).toMatch(/^legacy_import_map_(table|legacy_key)_check$/);
    // And the application refuses before SQL, with a typed error.
    expect(
      await codeOf(
        run(A, (tx) =>
          repo.recordDecision(
            A,
            {
              runId: r.id,
              legacyTable: 'user',
              legacyId: 'password:hunter2',
              checksum: SUM1,
              decision: customerDecision(randomUUID()),
              now: at(1),
            },
            tx,
          ),
        ),
      ),
    ).toBe(LEGACY_IMPORT_ERROR_CODES.INVALID);
  });

  it('OQ-P4-01: an invoice decision is recorded, replayed idempotently and kept apart from user keys', async () => {
    const { run: r } = await start(A);
    const service = randomUUID();
    const write = (legacyTable: string, legacyId: string, entityId: string) =>
      run(A, (tx) =>
        repo.recordDecision(
          A,
          {
            runId: r.id,
            legacyTable,
            legacyId,
            checksum: SUM1,
            decision: { status: 'IMPORTED', entityType: 'SERVICE', entityId, reasonCode: null },
            now: at(1),
          },
          tx,
        ),
      );
    expect((await write('invoice', '12345678', service)).kind).toBe('INSERTED');
    expect((await write('invoice', '12345678', service)).kind).toBe('UNCHANGED');
    // The same characters under `user` are a different legacy record.
    expect((await write('user', '12345678', randomUUID())).kind).toBe('INSERTED');
    // An invoice is never re-pointed to another service.
    expect(await write('invoice', '12345678', randomUUID())).toMatchObject({
      kind: 'REFUSED',
      reason: 'IMPORTED_ENTITY_MISMATCH',
    });
    const [row] = await repo.findByLegacyKeys(A, 'invoice', ['12345678']);
    expect(row).toMatchObject({ legacyTable: 'invoice', entityType: 'SERVICE', entityId: service });
    // A non-evidenced invoice id is a typed refusal before SQL.
    expect(await codeOf(write('invoice', 'a3f9b2', randomUUID()))).toBe(
      LEGACY_IMPORT_ERROR_CODES.INVALID,
    );
  });

  it('Codex P1 #175: a dry run counts its decisions on the run row and writes no map rows', async () => {
    const { run: r } = await start(A, 'DRY_RUN');
    const plan = { IMPORTED: 3, SKIPPED: 2, MANUAL_REVIEW: 1, FAILED: 4 } as const;
    for (const [status, n] of Object.entries(plan)) {
      for (let i = 0; i < n; i += 1) {
        await run(A, (tx) =>
          repo.recordDryRunDecision(A, r.id, status as keyof typeof plan, at(1), tx),
        );
      }
    }
    const done = await run(A, (tx) => repo.finish(A, r.id, { status: 'COMPLETED' }, at(2), tx));
    expect(done).toMatchObject({
      mode: 'DRY_RUN',
      status: 'COMPLETED',
      rowsImported: 3,
      rowsSkipped: 2,
      rowsManualReview: 1,
      rowsFailed: 4,
    });
    const rows = await ctx.container.database.db.execute(
      sql`SELECT count(*)::int AS n FROM legacy_import_map WHERE tenant_id = ${A.tenantId}`,
    );
    expect((rows.rows[0] as { n: number }).n).toBe(0);
    // Finished: no more counting.
    expect(
      await codeOf(run(A, (tx) => repo.recordDryRunDecision(A, r.id, 'IMPORTED', at(3), tx))),
    ).toBe(LEGACY_IMPORT_ERROR_CODES.RUN_NOT_WRITABLE);
  });

  it('Codex P1 #175: an APPLY run refuses dry-run counting and keeps counting from its map', async () => {
    const { run: r } = await start(A);
    expect(
      await codeOf(run(A, (tx) => repo.recordDryRunDecision(A, r.id, 'IMPORTED', at(1), tx))),
    ).toBe(LEGACY_IMPORT_ERROR_CODES.RUN_NOT_WRITABLE);
    await run(A, (tx) =>
      repo.recordDecision(
        A,
        {
          runId: r.id,
          legacyTable: 'user',
          legacyId: '5',
          checksum: SUM1,
          decision: customerDecision(randomUUID()),
          now: at(1),
        },
        tx,
      ),
    );
    const done = await run(A, (tx) => repo.finish(A, r.id, { status: 'COMPLETED' }, at(2), tx));
    expect(done).toMatchObject({
      rowsImported: 1,
      rowsSkipped: 0,
      rowsManualReview: 0,
      rowsFailed: 0,
    });
  });

  it('Codex P1 #175: a running dry run is never resumed (its counters would double)', async () => {
    const first = await start(A, 'DRY_RUN');
    expect(first.kind).toBe('STARTED');
    expect(await codeOf(start(A, 'DRY_RUN'))).toBe(LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT);
    await run(A, (tx) => repo.finish(A, first.run.id, { status: 'ABORTED' }, at(1), tx));
    expect((await start(A, 'DRY_RUN')).kind).toBe('STARTED');
  });

  it('Codex P2 #175: a skewed clock cannot finish a run before its recorded progress', async () => {
    const { run: r } = await start(A);
    await run(A, (tx) => repo.checkpoint(A, r.id, 10, at(100), tx));
    const done = await run(A, (tx) => repo.finish(A, r.id, { status: 'COMPLETED' }, at(50), tx));
    expect(done.finishedAt).toEqual(at(100));
    expect(done.lastProgressAt).toEqual(at(100));
    // And the database refuses the inversion whoever writes it.
    const { run: r2 } = await start(B);
    await run(B, (tx) => repo.checkpoint(B, r2.id, 1, at(100), tx));
    await expect(
      ctx.container.database.db.execute(
        sql`UPDATE legacy_import_runs SET status = 'ABORTED', finished_at = ${at(60)}
            WHERE id = ${r2.id}`,
      ),
    ).rejects.toSatisfy(violates('legacy_import_runs_finish_after_progress_check'));
  });
});
