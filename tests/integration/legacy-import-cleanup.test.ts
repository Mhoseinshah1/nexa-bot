import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  LEGACY_CLEANUP_AWAITING_DESTINATION_CODE,
  LEGACY_CLEANUP_DESTINATION_READY_CODE,
  LEGACY_CLEANUP_RECONCILIATION_DIFFERS_CODE,
  LEGACY_COMPACTION_ARCHIVE_TITLE,
  LEGACY_COMPACTION_CONFIRMATION_PHRASE,
  PLATFORM_ERROR_CODES,
  type BackupDeliveryDestination,
  type Clock,
} from '@nexa/contracts';
import { AudienceFixtures } from './audience-fixtures';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';
import { LegacyCompactionExecutor } from '../../apps/api/src/modules/platform/legacy-compaction/application/legacy-compaction.executor';
import { LegacyCleanupScheduler } from '../../apps/api/src/modules/platform/legacy-compaction/application/legacy-cleanup.scheduler';
import { DrizzleLegacyCompactionRepository } from '../../apps/api/src/modules/platform/legacy-compaction/infrastructure/drizzle-legacy-compaction.repository';
import { DrizzleTermsRepository } from '../../apps/api/src/modules/control/terms/infrastructure/drizzle-terms.repository';
import { DrizzleLegacyRecordsRepository } from '../../apps/api/src/modules/platform/legacy-history/infrastructure/drizzle-legacy-records.repository';
import type { BackupRunPartRow } from '../../apps/api/src/modules/platform/backup/application/ports';

/**
 * v0.9.7 PR-1: the AUTOMATIC cleanup after a clean import, against PostgreSQL.
 *
 * The backup pipeline is substituted (as in `legacy-compaction.test.ts`); what is asserted is
 * when the cleanup runs at all (a finished import, a clean balance reconciliation, a backup
 * destination), what it empties (the import's working tables, for THIS tenant only), what it
 * keeps (`legacy_invoice_archive`, another tenant, an operator's trial override, a staging
 * run still in flight), that it resumes, that the readers of the emptied tables still answer,
 * and that a later import is cleaned up in its turn.
 */

type Rec = Record<string, unknown>;
const HASH = 'a'.repeat(64);
const TG = '7000000201';
const CLEAN = {
  verdict: 'RECONCILED',
  differences: {
    BALANCE_DIFFERS: 0,
    MISSING_IN_NEXA: 0,
    AGENT_CREDIT_IN_WALLET: 0,
    NOT_IN_MIRZA: 0,
  },
};

describe('the automatic cleanup after an import (v0.9.7)', () => {
  let ctx: TestContext;
  let owner: Awaited<ReturnType<typeof createAdmin>>;
  let customer: string;
  let service: string;
  let archiveId: string;
  let nowMs: number;
  const clock: Clock = { now: () => new Date(nowMs) } as Clock;
  const errors: string[] = [];
  const db = () => ctx.container.database.db;
  const q = async <T extends Rec>(query: ReturnType<typeof sql>): Promise<T[]> =>
    (await db().execute<T>(query)).rows as T[];
  const n = async (table: string, tenantId: string = tenantA.tenantId as string) =>
    Number(
      (
        await q<{ n: number }>(
          sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}::uuid`,
        )
      )[0]?.n ?? -1,
    );

  beforeAll(async () => {
    ctx = await createTestContext();
  }, 600_000);

  afterAll(async () => {
    await ctx?.close();
  });

  async function nxpkgImport(input: {
    status: string;
    finishedAt: Date | null;
    reconciliation?: unknown;
    tenantId?: string;
    adminId?: string;
  }): Promise<string> {
    const id = randomUUID();
    const report =
      input.reconciliation === undefined
        ? null
        : JSON.stringify({ balanceReconciliation: input.reconciliation });
    const applied = input.status === 'COMPLETED' || input.status === 'COMPLETED_WITH_DISCREPANCY';
    await db().execute(sql`
      INSERT INTO legacy_nxpkg_imports
        (id, tenant_id, status, file_name, file_path, file_sha256, file_bytes, package_import_id,
         requested_by_admin_id, approved_dry_run_sha256, approved_at, approved_by_admin_id,
         apply_report, adopt_report, finished_at, created_at, updated_at)
      VALUES (${id}::uuid, ${input.tenantId ?? tenantA.tenantId}, ${input.status}, 'syn.nxpkg',
              '/nonexistent/syn.nxpkg', ${HASH}, 1, 'pkg-1', ${input.adminId ?? owner.id},
              ${applied ? HASH : null}, ${applied ? sql`now()` : null},
              ${applied ? (input.adminId ?? owner.id) : null},
              ${report}::jsonb, ${input.status === 'ADOPT_DONE' ? sql`'{}'::jsonb` : null},
              ${input.finishedAt}, now(), now())`);
    return id;
  }

  /** The import's working rows for one tenant, every CHECK satisfied. */
  async function workingRows(
    tenantId: string,
    telegramId: string,
    invoice = 'a1b2',
    stagingRun = true,
  ): Promise<{
    customer: string;
    service: string;
    archiveId: string;
  }> {
    const fx = new AudienceFixtures(ctx, tenantId);
    const who = await fx.customer({ telegramUserId: telegramId });
    const panel = await fx.panel();
    const svc = await fx.service({ customerId: who, panelId: panel });
    await db().execute(sql`
      UPDATE customers SET source = 'MIRZA', source_ref = ${`user:${telegramId}`}
       WHERE id = ${who}::uuid`);
    await db().execute(sql`
      UPDATE services SET source = 'MIRZA', source_ref = ${`invoice:${invoice}`}
       WHERE id = ${svc}::uuid`);
    const run = randomUUID();
    await db().execute(sql`
      INSERT INTO legacy_import_runs (id, tenant_id, mode, status, source_fingerprint,
        started_at, last_progress_at, finished_at)
      VALUES (${run}, ${tenantId}, 'APPLY', 'COMPLETED', ${HASH}, now(), now(), now())`);
    for (const [table, legacyId, type, entity] of [
      ['user', telegramId, 'CUSTOMER', who],
      ['invoice', invoice, 'SERVICE', svc],
    ] as const) {
      await db().execute(sql`
        INSERT INTO legacy_import_map (tenant_id, legacy_table, legacy_id, run_id, checksum,
          status, entity_type, entity_id, created_at, updated_at)
        VALUES (${tenantId}, ${table}, ${legacyId}, ${run}, ${HASH},
          'IMPORTED', ${type}, ${entity}, now(), now())`);
    }
    const done = randomUUID();
    const staging = randomUUID();
    const archiveRuns = [
      [done, 'COMPLETED'],
      [staging, 'STAGING'],
    ] as const;
    for (const [id, state] of stagingRun ? archiveRuns : archiveRuns.slice(0, 1)) {
      const finished = state === 'COMPLETED';
      await db().execute(sql`
        INSERT INTO legacy_invoice_archive_runs (id, tenant_id, state, read_set_version,
          read_set_fingerprint, source_fingerprint, source_schema_hash, source_engine, synthetic,
          source_invoice_rows, source_user_rows, source_product_rows, promoted_rows, inserted_new,
          missing_in_snapshot, archive_invoices_after, started_at, verified_at, finished_at,
          updated_at)
        VALUES (${id}, ${tenantId}, ${state}, 1, ${HASH}, ${HASH}, ${HASH}, 'SYNTHETIC_FIXTURE',
          true, ${finished ? 0 : null}, ${finished ? 0 : null}, ${finished ? 0 : null}, 0, 0,
          ${finished ? 0 : null}, ${finished ? 0 : null}, now(),
          ${finished ? sql`now()` : null}, ${finished ? sql`now()` : null}, now())`);
      for (const key of ['s-1', 's-2', 's-3']) {
        await db().execute(sql`
          INSERT INTO legacy_invoice_archive_staging (run_id, tenant_id, source_table, source_key)
          VALUES (${id}, ${tenantId}, 'user', ${key})`);
      }
    }
    const archive = randomUUID();
    await db().execute(sql`
      INSERT INTO legacy_invoice_archive (id, tenant_id, run_id, invoice_key, revision,
        revision_reason, key_shape_evidenced, raw_row, row_checksum, archive_checksum,
        classification, live, status, is_test, legacy_user_id, owner_present, username,
        panel_code, product_code, product_ref, product_name, price_raw, price_minor,
        price_currency, price_note, sold_at_raw, sold_at, sold_at_note, read_set_fingerprint,
        source_fingerprint, normalization_version, archived_at)
      VALUES (${archive}, ${tenantId}, ${done}, ${invoice}, 1, 'FIRST_SEEN', true,
        jsonb_build_object('id_invoice', ${invoice}::text), ${HASH}, ${HASH}, 'LIVE_CANDIDATE', true,
        'active', false, ${telegramId}, true, 'syn_user', 'rp1', NULL, 'NONE', 'synthetic',
        '150000', 150000, 'IRT', NULL, '1700000000', to_timestamp(1700000000), NULL, ${HASH},
        ${HASH}, 'legacy-invoice-archive:v1', now())`);
    for (const [key, outcome, svcId] of [
      [invoice, 'ADOPTED', svc],
      [`${invoice}-held`, 'INVENTORY_INCOMPLETE', null],
    ] as const) {
      await db().execute(sql`
        INSERT INTO legacy_service_candidates (id, tenant_id, invoice_key, run_id,
          source_fingerprint, synthetic, invoice_checksum, outcome, evidence, evidence_hash,
          panel_code, archive_id, service_id, review_state, first_decided_at, updated_at)
        VALUES (${randomUUID()}, ${tenantId}, ${key}, ${run}, ${HASH}, true, ${HASH}, ${outcome},
          '{}'::jsonb, ${HASH}, 'rp1', ${key === invoice ? archive : null}, ${svcId},
          ${svcId === null ? 'OPEN' : 'ADOPTED'}, now(), now())`);
    }
    // The import's trial decision and the limit of 0 it imposed.
    const decidedAt = new Date('2026-10-01T00:00:00Z');
    await db().execute(sql`
      INSERT INTO trial_limit_overrides (tenant_id, customer_id, trial_limit, set_at)
      VALUES (${tenantId}, ${who}, 0, ${decidedAt})`);
    await db().execute(sql`
      INSERT INTO legacy_trial_eligibility (tenant_id, customer_id, legacy_limit_usertest,
        legacy_had_trial, decision, override_before, override_after, input_hash, recorded_at)
      VALUES (${tenantId}, ${who}, 1, true, 'LEGACY_TRIAL_CONSUMED', NULL, 0, ${HASH}, ${decidedAt})`);
    return { customer: who, service: svc, archiveId: archive };
  }

  beforeEach(async () => {
    await ctx.reset();
    errors.length = 0;
    nowMs = Date.now();
    owner = await createAdmin(ctx.container, tenantA, {
      username: 'owner-cleanup',
      roleKeys: ['owner'],
    });
    ({ customer, service, archiveId } = await workingRows(tenantA.tenantId as string, TG));
  }, 120_000);

  function executor(options: { parts?: readonly Partial<BackupRunPartRow>[] } = {}): {
    executor: LegacyCompactionExecutor;
    titles: string[];
  } {
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
          run: async (_trigger, opts) => {
            titles.push(opts.title);
            return {
              kind: 'COMPLETED',
              run: { id: backupId, state: 'SUCCEEDED', verifiedAt: new Date(), failureCode: null },
            } as never;
          },
        },
        backupParts: async () =>
          (options.parts ?? [{}]).map((part, index) => ({
            backupId,
            partNumber: index + 1,
            filename: `a.7z.${String(index + 1).padStart(3, '0')}`,
            bytes: 1n,
            sha256: HASH,
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
          correlationId: 'cleanup-test' as never,
        }),
        leaseOwner: 'test:cleanup',
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

  function scheduler(destination: () => BackupDeliveryDestination = () => 'DEDICATED_CHAT') {
    const c = ctx.container;
    return new LegacyCleanupScheduler({
      repository: new DrizzleLegacyCompactionRepository(c.database.db),
      service: c.legacyCompaction,
      backupDestination: async () => destination(),
      opsLog: c.opsLog,
      clock,
      actor: () => ({
        type: 'SYSTEM_JOB',
        id: null,
        label: 'legacy-cleanup',
        surface: 'WORKER',
        correlationId: 'cleanup-test' as never,
      }),
      logger: { info() {}, warn() {} },
    });
  }

  const runs = () =>
    q<{ id: string; state: string; failure_code: string | null }>(
      sql`SELECT id, state, failure_code FROM legacy_compaction_runs ORDER BY requested_at, id`,
    );
  const events = (code: string) =>
    q<{ occurrence_count: number; resolved_at: Date | null; context: Rec | null }>(
      sql`SELECT occurrence_count, resolved_at, context FROM operational_events WHERE code = ${code}`,
    );
  const working = async (tenantId?: string) => ({
    map: await n('legacy_import_map', tenantId),
    candidates: await n('legacy_service_candidates', tenantId),
    trials: await n('legacy_trial_eligibility', tenantId),
    staging: await n('legacy_invoice_archive_staging', tenantId),
    archive: await n('legacy_invoice_archive', tenantId),
  });
  const FULL = { map: 2, candidates: 2, trials: 1, staging: 6, archive: 1 };

  it.each([
    [
      'a balance difference',
      {
        ...CLEAN,
        verdict: 'DIFFERENCES',
        differences: { ...CLEAN.differences, BALANCE_DIFFERS: 1 },
      },
    ],
    [
      'a customer missing in Nexa',
      {
        ...CLEAN,
        verdict: 'DIFFERENCES',
        differences: { ...CLEAN.differences, MISSING_IN_NEXA: 2 },
      },
    ],
    [
      'an agent credit in a wallet',
      {
        ...CLEAN,
        verdict: 'DIFFERENCES',
        differences: { ...CLEAN.differences, AGENT_CREDIT_IN_WALLET: 1 },
      },
    ],
    ['no reconciliation recorded', undefined],
  ])('is refused, archived and deleted nothing, with %s', async (_name, reconciliation) => {
    await nxpkgImport({
      status: 'COMPLETED',
      finishedAt: new Date(nowMs - 60_000),
      reconciliation,
    });
    await scheduler().tick();
    expect(await runs()).toEqual([]);
    expect(await events(LEGACY_CLEANUP_RECONCILIATION_DIFFERS_CODE)).toHaveLength(1);
    // The owner's request is refused too.
    await expect(
      ctx.container.legacyCompaction.request(tenantA, adminActorFor(owner), {
        idempotencyKey: randomUUID(),
        phrase: LEGACY_COMPACTION_CONFIRMATION_PHRASE,
      }),
    ).rejects.toMatchObject({ code: PLATFORM_ERROR_CODES.LEGACY_COMPACTION_UNAVAILABLE });
    // And a run that got REQUESTED regardless stops before its archive is even taken.
    await db().execute(sql`
      INSERT INTO legacy_compaction_runs (id, tenant_id, state, requested_at, updated_at)
      VALUES (${randomUUID()}, ${tenantA.tenantId}, 'REQUESTED', now(), now())`);
    const { executor: run, titles } = executor();
    const ended = await run.tick();
    expect(ended?.state).toBe('FAILED');
    expect(ended?.failureCode).toBe('legacy_compaction.reconciliation_not_clean');
    expect(titles).toEqual([]);
    expect(await working()).toEqual(FULL);
  });

  it('deletes nothing without a backup destination: one alert, re-checked daily, then runs', async () => {
    await nxpkgImport({
      status: 'COMPLETED',
      finishedAt: new Date(nowMs - 60_000),
      reconciliation: CLEAN,
    });
    let destination: BackupDeliveryDestination = 'NONE';
    const scheduled = scheduler(() => destination);
    await scheduled.tick();
    await scheduled.tick();
    expect(await runs()).toEqual([]);
    let alerts = await events(LEGACY_CLEANUP_AWAITING_DESTINATION_CODE);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.occurrence_count).toBe(1);
    // A day later, still nothing configured: the same one condition, seen again.
    nowMs += 25 * 60 * 60_000;
    await scheduled.tick();
    alerts = await events(LEGACY_CLEANUP_AWAITING_DESTINATION_CODE);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.occurrence_count).toBe(2);
    expect(await runs()).toEqual([]);
    expect(await working()).toEqual(FULL);
    // A destination appears: the condition recovers and the cleanup is requested.
    destination = 'OPS_GROUP_TOPIC';
    nowMs += 2 * 60 * 60_000;
    await scheduled.tick();
    expect((await events(LEGACY_CLEANUP_AWAITING_DESTINATION_CODE))[0]?.resolved_at).not.toBeNull();
    expect(await events(LEGACY_CLEANUP_DESTINATION_READY_CODE)).toHaveLength(1);
    expect((await runs()).map((row) => row.state)).toEqual(['REQUESTED']);
  });

  it('runs by itself after a clean import: archive first, then empties this tenant only', async () => {
    const other = await workingRows(tenantB.tenantId as string, '7000000202');
    // An operator's own trial limit, set after the import decided: never lifted.
    const kept = await new AudienceFixtures(ctx, tenantA.tenantId as string).customer({
      telegramUserId: '7000000203',
    });
    await db().execute(sql`
      INSERT INTO trial_limit_overrides (tenant_id, customer_id, trial_limit, set_at)
      VALUES (${tenantA.tenantId}, ${kept}, 0, '2026-10-05T00:00:00Z')`);
    await db().execute(sql`
      INSERT INTO legacy_trial_eligibility (tenant_id, customer_id, legacy_limit_usertest,
        legacy_had_trial, decision, override_before, override_after, input_hash, recorded_at)
      VALUES (${tenantA.tenantId}, ${kept}, 0, false, 'LEGACY_NO_TRIALS', NULL, 0, ${HASH},
              '2026-10-01T00:00:00Z')`);
    await nxpkgImport({
      status: 'COMPLETED_WITH_DISCREPANCY',
      finishedAt: new Date(nowMs - 60_000),
      reconciliation: {
        ...CLEAN,
        verdict: 'DIFFERENCES',
        differences: { ...CLEAN.differences, NOT_IN_MIRZA: 3 },
      },
    });
    await scheduler().tick();
    expect((await runs()).map((row) => row.state)).toEqual(['REQUESTED']);

    const { executor: run, titles } = executor({ parts: [{}, {}] });
    const ended = await run.tick();
    expect(errors).toEqual([]);
    expect(titles).toEqual([LEGACY_COMPACTION_ARCHIVE_TITLE]);
    expect(ended?.state).toBe('COMPLETED');

    expect(await working()).toEqual({ map: 0, candidates: 0, trials: 0, staging: 3, archive: 1 });
    // The staging rows left are the in-flight run's.
    expect(
      await q(sql`SELECT 1 FROM legacy_invoice_archive_staging s
                    JOIN legacy_invoice_archive_runs r ON r.id = s.run_id
                   WHERE s.tenant_id = ${tenantA.tenantId} AND r.state <> 'STAGING'`),
    ).toEqual([]);
    expect(await working(tenantB.tenantId as string)).toEqual(FULL);
    // The limit the import imposed is lifted; the operator's is not; tenant B's is not.
    const limits = await q<{ customer_id: string }>(
      sql`SELECT customer_id FROM trial_limit_overrides ORDER BY customer_id`,
    );
    expect(limits.map((row) => row.customer_id).sort()).toEqual([kept, other.customer].sort());

    // The report: every cleared table before and after.
    for (const table of [
      'legacy_import_map',
      'legacy_service_candidates',
      'legacy_trial_eligibility',
      'legacy_invoice_archive_staging',
      'legacy_invoice_archive',
    ]) {
      expect(Number(ended?.before?.tables[table])).toBeGreaterThan(0);
      expect(ended?.after?.tables[table]).toBeDefined();
    }
    const batches = await q<{ after: Rec }>(
      sql`SELECT after FROM audit_logs WHERE action = 'legacy.compaction.batch'
           AND after->>'stage' = 'CLEARING' ORDER BY occurred_at, id`,
    );
    expect(batches.map((row) => row.after['table'])).toEqual([
      'legacy_trial_eligibility',
      'legacy_service_candidates',
      'legacy_import_map',
      'legacy_invoice_archive_staging',
      'legacy_invoice_archive_staging',
    ]);
    expect(batches[0]?.after['trialLimitsLifted']).toBe(1);
    const [completed] = await q<{ context: Rec }>(
      sql`SELECT context FROM operational_events WHERE code = 'maintenance.legacy_compaction_completed'`,
    );
    expect(String(completed?.context['sizes'])).toMatch(/^history \d+→\d+ · map \d+→\d+/u);
    // The automatic request was audited as the job's, under its own permission.
    const [requested] = await q<{ actor_type: string; after: Rec }>(
      sql`SELECT actor_type, after FROM audit_logs WHERE action = 'legacy.compaction.request'`,
    );
    expect(requested).toMatchObject({ actor_type: 'SYSTEM_JOB', after: { automatic: true } });
  }, 120_000);

  it('deletes NOTHING when a part of the archive has no message id', async () => {
    await nxpkgImport({
      status: 'COMPLETED',
      finishedAt: new Date(nowMs - 60_000),
      reconciliation: CLEAN,
    });
    await scheduler().tick();
    const { executor: run } = executor({ parts: [{}, { telegramMessageId: null }] });
    const ended = await run.tick();
    expect(ended?.failureCode).toBe('legacy_compaction.archive_not_delivered');
    expect(await working()).toEqual(FULL);
    // A failure is retried once a day, never in a loop.
    nowMs += 2 * 60 * 60_000;
    await scheduler().tick();
    expect(await runs()).toHaveLength(1);
    nowMs += 25 * 60 * 60_000;
    await scheduler().tick();
    expect((await runs()).map((row) => row.state)).toEqual(['FAILED', 'REQUESTED']);
  });

  it('resumes the clearing after the last committed batch', async () => {
    await nxpkgImport({
      status: 'COMPLETED',
      finishedAt: new Date(nowMs - 60_000),
      reconciliation: CLEAN,
    });
    await scheduler().tick();
    const repository = new DrizzleLegacyCompactionRepository(db());
    const claimed = await repository.claim({
      leaseOwner: 'test:cleanup',
      now: new Date(),
      staleBefore: new Date(0),
    });
    if (claimed === null) throw new Error('nothing to claim');
    // A worker that archived, measured and got into CLEARING, committed one batch, then died.
    await repository.advance({
      id: claimed.id,
      leaseOwner: 'test:cleanup',
      from: 'REQUESTED',
      to: 'CLEARING',
      now: new Date(),
      archiveBackupId: randomUUID(),
      before: { tables: {}, recordTypes: {} },
    });
    await ctx.container.uow.run(tenantA, async (tx) => {
      await repository.authorise(tx.tx, claimed.id);
      expect(
        await repository.clearBatch(tx.tx, { tenantId: tenantA.tenantId as string, limit: 2 }),
      ).toEqual({ table: 'legacy_trial_eligibility', rows: 1, overridesLifted: 1 });
    });
    expect((await working()).trials).toBe(0);
    const ended = await executor().executor.tick();
    expect(errors).toEqual([]);
    expect(ended?.state).toBe('COMPLETED');
    expect(await working()).toEqual({ map: 0, candidates: 0, trials: 0, staging: 3, archive: 1 });
  });

  it('keeps the held services and trial decisions undeletable outside a CLEARING run', async () => {
    await expect(db().execute(sql`DELETE FROM legacy_service_candidates`)).rejects.toThrow();
    await expect(db().execute(sql`DELETE FROM legacy_trial_eligibility`)).rejects.toThrow();
    const run = randomUUID();
    await db().execute(sql`
      INSERT INTO legacy_compaction_runs (id, tenant_id, state, requested_at, updated_at)
      VALUES (${run}, ${tenantA.tenantId}, 'DROPPING', now(), now())`);
    const named = (statement: ReturnType<typeof sql>) =>
      db().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('nexa.legacy_compaction_run', ${run}, true)`);
        await tx.execute(statement);
      });
    // A run in another stage authorises nothing here.
    await expect(named(sql`DELETE FROM legacy_service_candidates`)).rejects.toThrow();
    await db().execute(
      sql`UPDATE legacy_compaction_runs SET state = 'CLEARING' WHERE id = ${run}::uuid`,
    );
    // A CLEARING run of tenant A deletes tenant A's rows only.
    await workingRows(tenantB.tenantId as string, '7000000209');
    await expect(named(sql`DELETE FROM legacy_service_candidates`)).rejects.toThrow();
    await named(
      sql`DELETE FROM legacy_service_candidates WHERE tenant_id = ${tenantA.tenantId}::uuid`,
    );
    expect(await n('legacy_service_candidates')).toBe(0);
    expect(await n('legacy_service_candidates', tenantB.tenantId as string)).toBe(2);
  });

  it('leaves every reader of an emptied table answering, the history card included', async () => {
    await nxpkgImport({
      status: 'COMPLETED',
      finishedAt: new Date(nowMs - 60_000),
      reconciliation: CLEAN,
    });
    await scheduler().tick();
    expect((await executor().executor.tick())?.state).toBe('COMPLETED');
    const actor = adminActorFor(owner);
    const c = ctx.container;
    // The held-services review lane, the manual-review queue, the per-invoice outcome.
    expect((await c.legacyServiceReview.list(tenantA, actor, {})).items).toEqual([]);
    await expect(c.legacyServiceReview.summary(tenantA, actor)).resolves.toBeDefined();
    await expect(c.legacyReviewQueue.counts(tenantA, actor)).resolves.toMatchObject({
      rowCount: 0,
    });
    const invoice = await c.legacyInvoiceArchive.get(tenantA, actor, archiveId);
    expect(invoice.importOutcome).toBeNull();
    // The customer's history card: the invoice, and the service it became.
    const page = await c.legacyHistoryRead.invoicesForCustomer(tenantA, actor, customer, {});
    expect(page.rows.map((row) => row.invoiceKey)).toEqual(['a1b2']);
    expect(page.rows[0]?.candidate).toBeNull();
    expect(
      await c.legacyHistoryRead.adoptionsForCustomer(tenantA, actor, customer, {
        serviceIds: [service],
      }),
    ).toEqual([{ serviceId: service, invoiceKey: 'a1b2' }]);
    expect(
      await new DrizzleLegacyRecordsRepository(db()).invoiceKeysOfService(tenantA, service),
    ).toEqual(['a1b2']);
    // An imported customer stays exempt from the rules (`source = 'MIRZA'`).
    expect(await new DrizzleTermsRepository(db()).exemption(tenantA, customer)).toBe('IMPORTED');
  });

  it('a later import is accepted after the cleanup, and cleaned up in its turn', async () => {
    await nxpkgImport({
      status: 'COMPLETED',
      finishedAt: new Date(nowMs - 60_000),
      reconciliation: CLEAN,
    });
    await scheduler().tick();
    expect((await executor().executor.tick())?.state).toBe('COMPLETED');
    // Nothing more to do for that import.
    nowMs += 2 * 60 * 60_000;
    await scheduler().tick();
    expect(await runs()).toHaveLength(1);
    // A fresh package: the upload is accepted (the exclusion is over).
    await expect(
      ctx.container.legacyNxpkgImports.insert({
        id: randomUUID(),
        tenantId: tenantA.tenantId,
        fileName: 'second.nxpkg',
        filePath: '/nonexistent/second.nxpkg',
        fileSha256: 'd'.repeat(64),
        fileBytes: 1n,
        requestedByAdminId: owner.id,
        now: new Date(),
      }),
    ).resolves.toMatchObject({ status: 'UPLOADED' });
    await db().execute(sql`UPDATE legacy_nxpkg_imports SET status = 'CANCELLED',
      error_code = 'IMPORT_FAILED', finished_at = now() WHERE status = 'UPLOADED'`);
    // It finished, later: its own cleanup is requested.
    await workingRows(tenantA.tenantId as string, '7000000210', 'c3d4', false);
    await nxpkgImport({ status: 'ADOPT_DONE', finishedAt: new Date(nowMs + 60_000) });
    await nxpkgImport({ status: 'COMPLETED', finishedAt: new Date(nowMs), reconciliation: CLEAN });
    nowMs += 2 * 60 * 60_000;
    await scheduler().tick();
    expect((await runs()).map((row) => row.state)).toEqual(['COMPLETED', 'REQUESTED']);
    expect((await executor().executor.tick())?.state).toBe('COMPLETED');
    expect((await working()).map).toBe(0);
  }, 120_000);
});
