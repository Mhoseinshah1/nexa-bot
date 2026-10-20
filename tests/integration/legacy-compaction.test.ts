import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  LEGACY_COMPACTION_ARCHIVE_TITLE,
  LEGACY_COMPACTION_CONFIRMATION_PHRASE,
  PLATFORM_ERROR_CODES,
} from '@nexa/contracts';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  type TestContext,
} from './harness';
import { LegacyCompactionExecutor } from '../../apps/api/src/modules/platform/legacy-compaction/application/legacy-compaction.executor';
import { DrizzleLegacyCompactionRepository } from '../../apps/api/src/modules/platform/legacy-compaction/infrastructure/drizzle-legacy-compaction.repository';
import type { BackupRunPartRow } from '../../apps/api/src/modules/platform/backup/application/ports';

/**
 * Round 4 PR-E (E1): the legacy-data compaction against PostgreSQL.
 *
 * The backup pipeline is substituted (the real one is `backup-parts.test.ts`'s); what is
 * asserted here is the ORDER — nothing is deleted unless the archive's every part has a
 * message id — the read map's drop list, the dedup's twin rule, the strip, the report and
 * the one audit row per batch.
 */

type Rec = Record<string, unknown>;

describe('the legacy data compaction (E1)', () => {
  let ctx: TestContext;
  let ownerActor: ReturnType<typeof adminActorFor>;
  let importId: string;
  /** What the executor logged as failing: a test that sees it can say why. */
  const errors: string[] = [];

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
  });

  const q = async <T extends Rec>(query: ReturnType<typeof sql>): Promise<T[]> =>
    (await ctx.container.database.db.execute<T>(query)).rows as T[];

  async function history(type: string, payload: Rec): Promise<string> {
    const id = randomUUID();
    await ctx.container.database.db.execute(sql`
      INSERT INTO legacy_history_records
        (id, tenant_id, nxpkg_import_id, package_import_id, record_type, idempotency_key, payload, created_at)
      VALUES (${id}::uuid, ${tenantA.tenantId}::uuid, ${importId}::uuid, 'pkg-1', ${type},
              ${`legacy:${type}:${id}`}, ${JSON.stringify(payload)}::jsonb, now())`);
    return id;
  }

  /** A second import still in flight (VERIFYING), beside the completed one. */
  async function importInFlight(): Promise<string> {
    const id = randomUUID();
    await ctx.container.database.db.execute(sql`
      INSERT INTO legacy_nxpkg_imports
        (id, tenant_id, status, file_name, file_path, file_sha256, file_bytes,
         requested_by_admin_id, created_at, updated_at)
      SELECT ${id}::uuid, ${tenantA.tenantId}, 'VERIFYING', 'second.nxpkg', '/nonexistent/second',
             ${'c'.repeat(64)}, 1, requested_by_admin_id, now(), now()
        FROM legacy_nxpkg_imports WHERE id = ${importId}::uuid`);
    return id;
  }

  beforeEach(async () => {
    await ctx.reset();
    const owner = await createAdmin(ctx.container, tenantA, {
      username: 'owner-compaction',
      roleKeys: ['owner'],
    });
    ownerActor = adminActorFor(owner);
    importId = randomUUID();
    await ctx.container.database.db.execute(sql`
      INSERT INTO legacy_nxpkg_imports
        (id, tenant_id, status, file_name, file_path, file_sha256, file_bytes, package_import_id,
         requested_by_admin_id, approved_dry_run_sha256, approved_at, approved_by_admin_id,
         finished_at, created_at, updated_at)
      VALUES (${importId}::uuid, ${tenantA.tenantId}, 'COMPLETED', 'synthetic.nxpkg',
              '/nonexistent/synthetic.nxpkg', ${'a'.repeat(64)}, 1, 'pkg-1', ${owner.id},
              ${'b'.repeat(64)}, now(), ${owner.id}, now(), now(), now())`);
  });

  function executor(input: {
    parts: readonly Partial<BackupRunPartRow>[];
    backupState?: 'SUCCEEDED' | 'FAILED';
  }): { executor: LegacyCompactionExecutor; titles: string[] } {
    const titles: string[] = [];
    const backupId = randomUUID();
    const c = ctx.container;
    return {
      titles,
      executor: new LegacyCompactionExecutor({
        repository: new DrizzleLegacyCompactionRepository(c.database.db),
        uow: c.uow,
        audit: c.audit,
        opsLog: c.opsLog,
        scopeActivity: c.tenants,
        clock: c.clock,
        backup: {
          run: async (_trigger, options) => {
            titles.push(options.title);
            return {
              kind: 'COMPLETED',
              run: {
                id: backupId,
                state: input.backupState ?? 'SUCCEEDED',
                verifiedAt: input.backupState === 'FAILED' ? null : new Date(),
              },
            } as never;
          },
        },
        backupParts: async () =>
          input.parts.map((part, index) => ({
            backupId,
            partNumber: index + 1,
            filename: `a.7z.${String(index + 1).padStart(3, '0')}`,
            bytes: 1n,
            sha256: 'a'.repeat(64),
            deliveryState: 'SUCCEEDED',
            deliveryAttemptedAt: new Date(),
            telegramMessageId: 1n,
            deliveryDetail: null,
            ...part,
          })),
        quiesced: async () => false,
        actor: () => ({
          type: 'SYSTEM_JOB',
          id: null,
          label: 'legacy-compaction',
          surface: 'WORKER',
          correlationId: 'compaction-test' as never,
        }),
        leaseOwner: 'test:compaction',
        batchSize: 2,
        tickIntervalMs: 60_000,
        logger: {
          info() {},
          warn() {},
          error(context: Record<string, unknown>) {
            errors.push(String(context['err']));
          },
        },
      }),
    };
  }

  async function request(): Promise<void> {
    await ctx.container.legacyCompaction.request(tenantA, ownerActor, {
      idempotencyKey: randomUUID(),
      phrase: LEGACY_COMPACTION_CONFIRMATION_PHRASE,
    });
  }

  const ids = async (): Promise<Set<string>> =>
    new Set(
      (await q<{ id: string }>(sql`SELECT id FROM legacy_history_records`)).map((row) => row.id),
    );

  it('refuses the wrong phrase, an import still running, and a second compaction', async () => {
    await expect(
      ctx.container.legacyCompaction.request(tenantA, ownerActor, {
        idempotencyKey: randomUUID(),
        phrase: 'compact legacy data',
      }),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.LEGACY_COMPACTION_PHRASE_INVALID });
    const second = await importInFlight();
    await expect(request()).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.LEGACY_COMPACTION_UNAVAILABLE,
    });
    // The second import ends (an import row is never deleted): the precondition holds again.
    await ctx.container.database.db.execute(sql`
      UPDATE legacy_nxpkg_imports SET status = 'CANCELLED', error_code = 'IMPORT_FAILED',
             finished_at = now() WHERE id = ${second}::uuid`);
    await request();
    await expect(request()).rejects.toMatchObject({
      code: PLATFORM_ERROR_CODES.LEGACY_COMPACTION_ACTIVE,
    });
  });

  it('deletes NOTHING when a part of the archive has no message id', async () => {
    const dropped = await history('panel_target', { a: 1 });
    await request();
    const { executor: run } = executor({ parts: [{}, { telegramMessageId: null }] });
    const ended = await run.tick();
    expect(ended?.state).toBe('FAILED');
    expect(ended?.failureCode).toBe('legacy_compaction.archive_not_delivered');
    expect((await ids()).has(dropped)).toBe(true);
  });

  it('deletes NOTHING when the archive backup failed', async () => {
    const dropped = await history('agent_log', { a: 1 });
    await request();
    const { executor: run } = executor({ parts: [{}], backupState: 'FAILED' });
    expect((await run.tick())?.failureCode).toBe('legacy_compaction.archive_failed');
    expect((await ids()).has(dropped)).toBe(true);
  });

  it('archives first, then drops unread types, dedups invoice twins, strips flags, and reports', async () => {
    const drop1 = await history('panel_target', { x: 1 });
    const drop2 = await history('configuration_row', { x: 2 });
    const drop3 = await history('support_department', { x: 3 });
    // Read types the owner listed: KEPT.
    const keptOwnership = await history('service_ownership', {
      invoice_key: 'i9',
      affects_wallet: false,
    });
    const keptCheck = await history('wallet_history_check', { verdict: 'OK' });
    // An invoice archive row with a twin in legacy_invoice_archive: deduped.
    const twin = await history('archive_row', {
      provenance: { source_table: 'invoice', source_pk: 'inv-1' },
    });
    // One without a twin, and one of another table: kept.
    const noTwin = await history('archive_row', {
      provenance: { source_table: 'invoice', source_pk: 'inv-404' },
    });
    const otherTable = await history('archive_row', {
      provenance: { source_table: 'user', source_pk: 'inv-1' },
    });
    // A payment with constant flags and *_raw / *_note fields.
    const payment = await history('payment', {
      schema: 'mirza.payment_report.v1',
      affects_wallet: false,
      creates_payment: false,
      amount_raw: '1000',
      price_note: 'OK',
      nested: { affects_wallet: false },
    });
    await insertInvoiceTwin('inv-1');

    await request();
    const { executor: run, titles } = executor({ parts: [{}, {}] });
    const ended = await run.tick();
    expect(errors).toEqual([]);
    expect(titles).toEqual([LEGACY_COMPACTION_ARCHIVE_TITLE]);
    expect(ended?.state).toBe('COMPLETED');

    const left = await ids();
    for (const gone of [drop1, drop2, drop3, twin]) expect(left.has(gone)).toBe(false);
    for (const kept of [keptOwnership, keptCheck, noTwin, otherTable, payment]) {
      expect(left.has(kept)).toBe(true);
    }
    const [paid] = await q<{ payload: Rec }>(
      sql`SELECT payload FROM legacy_history_records WHERE id = ${payment}::uuid`,
    );
    expect(paid?.payload).toEqual({
      schema: 'mirza.payment_report.v1',
      amount_raw: '1000',
      price_note: 'OK',
      nested: { affects_wallet: false },
    });

    expect(ended?.deleted).toBe(3n);
    expect(ended?.deduplicated).toBe(1n);
    expect(ended?.stripped).toBe(2n);
    expect(ended?.before?.recordTypes['panel_target']).toBe(1);
    expect(ended?.after?.recordTypes['panel_target']).toBeUndefined();
    expect(Number(ended?.after?.tables['legacy_history_records'])).toBeGreaterThan(0);

    // One audit row per BATCH (batch size 2): 3 dropped → 2 batches, 1 dedup, 2 stripped → 1.
    const batches = await q<{ after: Rec }>(
      sql`SELECT after FROM audit_logs WHERE action = 'legacy.compaction.batch' ORDER BY occurred_at, id`,
    );
    expect(batches.map((row) => row.after['stage'])).toEqual([
      'DROPPING',
      'DROPPING',
      'DEDUPING',
      'STRIPPING',
    ]);
  }, 120_000);

  it('resumes after the last committed batch, without redoing it', async () => {
    for (let index = 0; index < 5; index += 1) await history('agent_usage', { n: index });
    await request();
    const repository = new DrizzleLegacyCompactionRepository(ctx.container.database.db);
    // A worker that claimed, archived and measured, then died after one batch.
    const { executor: first } = executor({ parts: [{}] });
    const claimed = await repository.claim({
      leaseOwner: 'test:compaction',
      now: new Date(),
      staleBefore: new Date(0),
    });
    if (claimed === null) throw new Error('nothing to claim');
    await repository.advance({
      id: claimed.id,
      leaseOwner: 'test:compaction',
      from: 'REQUESTED',
      to: 'DROPPING',
      now: new Date(),
      archiveBackupId: randomUUID(),
      before: { tables: {}, recordTypes: {} },
    });
    const ended = await first.tick();
    expect(ended?.state).toBe('COMPLETED');
    expect(ended?.deleted).toBe(5n);
    expect((await ids()).size).toBe(0);
  }, 120_000);

  it('keeps the archive append-only for everyone else: no run named, or one not deleting', async () => {
    const row = await history('agent_log', { a: 1 });
    const db = ctx.container.database.db;
    await expect(
      db.execute(sql`DELETE FROM legacy_history_records WHERE id = ${row}::uuid`),
    ).rejects.toThrow();
    await request();
    const [run] = await q<{ id: string }>(sql`SELECT id FROM legacy_compaction_runs`);
    // A REQUESTED run (the archive not yet delivered) authorises nothing.
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('nexa.legacy_compaction_run', ${run?.id ?? ''}, true)`,
        );
        await tx.execute(sql`DELETE FROM legacy_history_records WHERE id = ${row}::uuid`);
      }),
    ).rejects.toThrow();
    // A run in DROPPING authorises a delete, and an UPDATE of the payload only.
    await db.execute(
      sql`UPDATE legacy_compaction_runs SET state = 'DROPPING' WHERE id = ${run?.id ?? ''}::uuid`,
    );
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT set_config('nexa.legacy_compaction_run', ${run?.id ?? ''}, true)`,
        );
        await tx.execute(
          sql`UPDATE legacy_history_records SET record_type = 'payment' WHERE id = ${row}::uuid`,
        );
      }),
    ).rejects.toThrow();
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('nexa.legacy_compaction_run', ${run?.id ?? ''}, true)`,
      );
      await tx.execute(sql`DELETE FROM legacy_history_records WHERE id = ${row}::uuid`);
    });
    expect((await ids()).has(row)).toBe(false);
  });

  /** A valid `legacy_invoice_archive` row (the fixture `legacy-customer-invoices.test.ts` uses). */
  async function insertInvoiceTwin(invoiceKey: string): Promise<void> {
    const HASH = 'a'.repeat(64);
    const run = randomUUID();
    const db = ctx.container.database.db;
    await db.execute(sql`
      INSERT INTO legacy_invoice_archive_runs (id, tenant_id, state, read_set_version,
        read_set_fingerprint, source_fingerprint, source_schema_hash, source_engine, synthetic,
        source_invoice_rows, source_user_rows, source_product_rows, promoted_rows, inserted_new,
        missing_in_snapshot, archive_invoices_after, started_at, verified_at, finished_at,
        updated_at)
      VALUES (${run}, ${tenantA.tenantId}, 'COMPLETED', 1, ${HASH}, ${HASH}, ${HASH},
        'SYNTHETIC_FIXTURE', true, 0, 0, 0, 0, 0, 0, 0, now(), now(), now(), now())`);
    await db.execute(sql`
      INSERT INTO legacy_invoice_archive (id, tenant_id, run_id, invoice_key, revision,
        revision_reason, key_shape_evidenced, raw_row, row_checksum, archive_checksum,
        classification, live, status, is_test, legacy_user_id, owner_present, username,
        panel_code, product_code, product_ref, product_name, price_raw, price_minor,
        price_currency, price_note, sold_at_raw, sold_at, sold_at_note, read_set_fingerprint,
        source_fingerprint, normalization_version, archived_at)
      VALUES (${randomUUID()}, ${tenantA.tenantId}, ${run}, ${invoiceKey}, 1, 'FIRST_SEEN', true,
        jsonb_build_object('id_invoice', ${invoiceKey}::text), ${HASH}, ${HASH}, 'LIVE_CANDIDATE',
        true, 'active', false, '7000000101', true, 'syn_user', 'rp1', NULL, 'NONE', 'synthetic',
        '150000', 150000, 'IRT', NULL, '1700000000', to_timestamp(1700000000), NULL, ${HASH},
        ${HASH}, 'legacy-invoice-archive:v1', now())`);
  }
});
