import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  COMMERCE_ERROR_CODES,
  LEGACY_IMPORT_ERROR_CODES,
  LEGACY_REVIEW_REASON_CODES,
  PLATFORM_ERROR_CODES,
  isNexaError,
  systemJobActor,
  type ActorContext,
  type CorrelationId,
  type LegacyImportReasonCode,
  type LegacyReviewReasonCode,
  type TenantContext,
} from '@nexa/contracts';
import { DrizzleLegacyImportRepository } from '../../apps/api/src/modules/platform/legacy-import/infrastructure/drizzle-legacy-import.repository';
import {
  resumeDecision,
  type LegacyImportDecision,
} from '../../apps/api/src/modules/platform/legacy-import/application/legacy-import-ports';
import {
  adminActorFor,
  createAdmin,
  createTestContext,
  tenantA,
  tenantB,
  type TestContext,
} from './harness';

/**
 * Program 4 Item 9 — the Manual Review Queue over `legacy_import_map`
 * (`docs/legacy-import-metadata.md` § Manual review queue), against a real PostgreSQL:
 * every closed reason, counts per run and tenant, keyset paging with safe context only,
 * resolve / reopen as conditional updates (and their races), a rerun that never silently
 * overwrites a person's resolution and never loses an IMPORTED row, tenant isolation,
 * permission and scope activity.
 */

const A = tenantA as TenantContext;
const B = tenantB as TenantContext;
const FP = '1'.repeat(64);
const FP2 = '2'.repeat(64);
const SUM1 = 'a'.repeat(64);
const SUM2 = 'b'.repeat(64);
const IMPORTER: ActorContext = systemJobActor(
  'legacy-import:review-test',
  'corr-legacy-review' as CorrelationId,
);

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (isNexaError(error)) return error.code;
    throw error;
  }
}

function constraintOf(error: unknown): string | null {
  for (let e: unknown = error; e !== null && typeof e === 'object';) {
    const c = (e as { constraint?: unknown }).constraint;
    if (typeof c === 'string') return c;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

describe('legacy import manual review queue (Item 9)', () => {
  let ctx: TestContext;
  let repo: DrizzleLegacyImportRepository;
  let key = 0;
  const idem = (): string => `review-${String((key += 1))}`;

  const run = <T>(scope: TenantContext, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    ctx.container.uow.run(scope, fn);
  const queue = () => ctx.container.legacyReviewQueue;
  const db = () => ctx.container.database.db;

  const startRun = async (scope: TenantContext, fp = FP): Promise<string> => {
    const out = await run(scope, (tx) =>
      repo.startOrResume(
        scope,
        {
          id: randomUUID(),
          mode: 'APPLY',
          sourceFingerprint: fp,
          codeVersion: 'test',
          now: new Date(),
        },
        tx,
      ),
    );
    return out.run.id;
  };
  const finishRun = (scope: TenantContext, runId: string) =>
    run(scope, (tx) => repo.finish(scope, runId, { status: 'COMPLETED' }, new Date(), tx));

  const decide = (
    scope: TenantContext,
    runId: string,
    legacyId: string,
    decision: LegacyImportDecision,
    checksum = SUM1,
    legacyTable = 'user',
  ) =>
    run(scope, (tx) =>
      repo.recordDecision(
        scope,
        { runId, legacyTable, legacyId, checksum, decision, now: new Date() },
        tx,
      ),
    );
  const review = (reasonCode: LegacyReviewReasonCode): LegacyImportDecision => ({
    status: 'MANUAL_REVIEW',
    reasonCode,
  });

  const row = async (scope: TenantContext, legacyId: string, legacyTable = 'user') => {
    const [r] = await repo.findByLegacyKeys(scope, legacyTable, [legacyId]);
    return r;
  };
  const count = async (query: ReturnType<typeof sql>): Promise<number> => {
    const [r] = (await db().execute(query)).rows as { n: number }[];
    return Number(r?.n ?? 0);
  };
  const audits = (entityId: string, action: string, result = 'SUCCESS') =>
    count(sql`SELECT count(*)::int AS n FROM audit_logs
      WHERE entity_type = 'LegacyImportMapRow' AND entity_id = ${entityId}
        AND action = ${action} AND result = ${result}`);
  const events = (entityId: string) =>
    count(sql`SELECT count(*)::int AS n FROM outbox_messages
      WHERE event_type = 'LegacyImportReviewStateChanged' AND aggregate_id = ${entityId}`);

  const resolve = (
    legacyId: string,
    resolutionCode: Parameters<
      ReturnType<typeof queue>['resolve']
    >[2]['resolutionCode'] = 'WILL_NOT_IMPORT',
    expectedReasonCode: LegacyReviewReasonCode = 'PROVIDER_MISSING',
    idempotencyKey = idem(),
    scope: TenantContext = A,
    actor: ActorContext = IMPORTER,
  ) =>
    queue().resolve(scope, actor, {
      legacyTable: 'user',
      legacyId,
      expectedReasonCode,
      resolutionCode,
      idempotencyKey,
    });
  const reopen = (legacyId: string, idempotencyKey = idem(), scope: TenantContext = A) =>
    queue().reopen(scope, IMPORTER, { legacyTable: 'user', legacyId, idempotencyKey });

  beforeAll(async () => {
    ctx = await createTestContext();
    repo = new DrizzleLegacyImportRepository(ctx.container.database.db);
  }, 600_000);
  afterAll(async () => {
    await ctx?.close();
  });
  beforeEach(async () => {
    await ctx.reset();
  });

  // ---------------------------------------------------------------------------------------
  // The closed reasons
  // ---------------------------------------------------------------------------------------

  it('every closed review reason enters the queue OPEN and is counted under its own code', async () => {
    const runId = await startRun(A);
    for (const [i, reason] of LEGACY_REVIEW_REASON_CODES.entries()) {
      const out = await decide(A, runId, String(1000 + i), review(reason));
      expect(out.kind).toBe('INSERTED');
      expect(out.record).toMatchObject({ reviewState: 'OPEN', reviewReopenedCount: 0 });
    }
    const counts = await queue().counts(A, IMPORTER);
    expect(counts.rowCount).toBe(LEGACY_REVIEW_REASON_CODES.length);
    expect(counts.byState).toEqual({
      OPEN: LEGACY_REVIEW_REASON_CODES.length,
      RESOLVED: 0,
      DISMISSED: 0,
    });
    expect(counts.byReason.map((b) => b.reasonCode).sort()).toEqual(
      [...LEGACY_REVIEW_REASON_CODES].sort(),
    );
    for (const b of counts.byReason) expect(b).toMatchObject({ open: 1, rowCount: 1 });
  });

  it('the database refuses a review row with a non-review reason or a malformed review', async () => {
    const runId = await startRun(A);
    const insert = async (
      status: string,
      reason: string | null,
      reviewState: string | null,
      extra: { code?: string | null; at?: boolean; type?: string | null; id?: string | null } = {},
    ): Promise<string | null> => {
      try {
        await db().execute(sql`INSERT INTO legacy_import_map (tenant_id, legacy_table, legacy_id,
            run_id, checksum, status, reason_code, review_state, review_resolution_code,
            reviewed_at, reviewed_by_actor_type, reviewed_by_actor_id, created_at, updated_at)
          VALUES (${A.tenantId}, 'user', '5', ${runId}, ${SUM1}, ${status}, ${reason},
            ${reviewState}, ${extra.code ?? null}, ${extra.at === true ? new Date() : null},
            ${extra.type ?? null}, ${extra.id ?? null}, now(), now())`);
        await db().execute(sql`DELETE FROM legacy_import_map WHERE tenant_id = ${A.tenantId}`);
        return null;
      } catch (error) {
        const c = constraintOf(error);
        if (c === null) throw error;
        return c;
      }
    };
    const nonReview: LegacyImportReasonCode[] = [
      'EXISTING_CUSTOMER',
      'TEST_PANEL',
      'HISTORY_NOT_IMPORTED',
      'NEGATIVE_BALANCE',
      'PROVIDER_READ_FAILED',
      'INTERNAL_ERROR',
    ];
    for (const reason of nonReview) {
      expect(await insert('MANUAL_REVIEW', reason, 'OPEN')).toBe(
        'legacy_import_map_review_reason_check',
      );
    }
    // A review state exists exactly on MANUAL_REVIEW rows.
    expect(await insert('MANUAL_REVIEW', 'PROVIDER_MISSING', null)).toBe(
      'legacy_import_map_review_state_check',
    );
    expect(await insert('SKIPPED', 'TEST_PANEL', 'OPEN')).toBe(
      'legacy_import_map_review_state_check',
    );
    // A closed review names a resolution of ITS state, when and by whom.
    const by = { at: true, type: 'SYSTEM_JOB', id: 'legacy-import:x' };
    expect(
      await insert('MANUAL_REVIEW', 'PROVIDER_MISSING', 'DISMISSED', {
        ...by,
        code: 'WILL_NOT_IMPORT',
      }),
    ).toBeNull();
    expect(
      await insert('MANUAL_REVIEW', 'PROVIDER_MISSING', 'RESOLVED', {
        ...by,
        code: 'WILL_NOT_IMPORT',
      }),
    ).toBe('legacy_import_map_review_resolution_check');
    expect(
      await insert('MANUAL_REVIEW', 'PROVIDER_MISSING', 'RESOLVED', { code: 'RETRY_AFTER_FIX' }),
    ).toBe('legacy_import_map_review_resolution_check');
    expect(
      await insert('MANUAL_REVIEW', 'PROVIDER_MISSING', 'OPEN', { ...by, code: 'RETRY_AFTER_FIX' }),
    ).toBe('legacy_import_map_review_resolution_check');
    expect(
      await insert('MANUAL_REVIEW', 'PROVIDER_MISSING', 'DISMISSED', {
        ...by,
        code: 'because I said so',
      }),
    ).toBe('legacy_import_map_review_resolution_check');
    expect(
      await insert('MANUAL_REVIEW', 'PROVIDER_MISSING', 'DISMISSED', {
        ...by,
        id: 'phone +98912 John',
        code: 'WILL_NOT_IMPORT',
      }),
    ).toBe('legacy_import_map_reviewed_by_actor_id_check');
  });

  // ---------------------------------------------------------------------------------------
  // Counts and paging
  // ---------------------------------------------------------------------------------------

  it('counts by reason per tenant and per run, split by review state', async () => {
    const run1 = await startRun(A);
    await decide(A, run1, '1', review('PROVIDER_MISSING'));
    await decide(A, run1, '2', review('PROVIDER_MISSING'));
    await decide(A, run1, '3', review('AMBIGUOUS_PANEL'));
    await decide(A, run1, '4', { status: 'SKIPPED', reasonCode: 'TEST_PANEL' });
    await finishRun(A, run1);
    const run2 = await startRun(A, FP2);
    await decide(A, run2, '5', review('PROVIDER_MISSING'));
    await decide(A, run2, '6', review('INVENTORY_INCOMPLETE'));
    await resolve('1', 'WILL_NOT_IMPORT');

    const tenant = await queue().counts(A, IMPORTER);
    expect(tenant.rowCount).toBe(5);
    expect(tenant.byState).toEqual({ OPEN: 4, RESOLVED: 0, DISMISSED: 1 });
    expect(tenant.byReason).toEqual([
      {
        legacyTable: 'user',
        reasonCode: 'AMBIGUOUS_PANEL',
        open: 1,
        resolved: 0,
        dismissed: 0,
        rowCount: 1,
      },
      {
        legacyTable: 'user',
        reasonCode: 'INVENTORY_INCOMPLETE',
        open: 1,
        resolved: 0,
        dismissed: 0,
        rowCount: 1,
      },
      {
        legacyTable: 'user',
        reasonCode: 'PROVIDER_MISSING',
        open: 2,
        resolved: 0,
        dismissed: 1,
        rowCount: 3,
      },
    ]);
    const perRun2 = await queue().counts(A, IMPORTER, { runId: run2 });
    expect(perRun2).toMatchObject({ runId: run2, rowCount: 2 });
    const perRun1 = await queue().counts(A, IMPORTER, { runId: run1 });
    expect(perRun1).toMatchObject({ runId: run1, rowCount: 3 });
    // The run's own snapshot agrees with the queue's count of its rows.
    const finished = await repo.findRun(A, run1);
    expect(finished?.rowsManualReview).toBe(3);
  });

  it('keyset-pages the queue without gaps or repeats, with filters and safe context only', async () => {
    const runId = await startRun(A);
    for (let i = 0; i < 7; i += 1) {
      await decide(
        A,
        runId,
        String(200 + i),
        review(i % 3 === 0 ? 'CUSTOMER_MISSING' : 'PRODUCT_MAPPING_UNRESOLVED'),
      );
    }
    await decide(A, runId, '9c1e04ab', review('PROVIDER_MISSING'), SUM1, 'invoice');
    await decide(A, runId, '299', {
      status: 'IMPORTED',
      entityType: 'CUSTOMER',
      entityId: randomUUID(),
      reasonCode: null,
    });

    const seen: string[] = [];
    let after: { legacyTable: string; legacyId: string } | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await queue().list(A, IMPORTER, { limit: 3, ...(after ? { after } : {}) });
      seen.push(...page.items.map((x) => `${x.legacyTable}:${x.legacyId}`));
      if (page.next === null) break;
      after = page.next;
    }
    expect(seen).toEqual([
      'invoice:9c1e04ab',
      'user:200',
      'user:201',
      'user:202',
      'user:203',
      'user:204',
      'user:205',
      'user:206',
    ]);

    const page = await queue().list(A, IMPORTER, { limit: 50, reasonCode: 'CUSTOMER_MISSING' });
    expect(page.items.map((x) => x.legacyId)).toEqual(['200', '203', '206']);
    // Safe context: identifiers, closed codes and timestamps — no checksum, no source value.
    expect(Object.keys(page.items[0] ?? {}).sort()).toEqual(
      [
        'attempts',
        'createdAt',
        'legacyId',
        'legacyTable',
        'reasonCode',
        'reopenedCount',
        'resolutionCode',
        'reviewState',
        'reviewedAt',
        'reviewedByActorId',
        'reviewedByActorType',
        'runId',
        'updatedAt',
      ].sort(),
    );

    await queue().resolve(A, IMPORTER, {
      legacyTable: 'user',
      legacyId: '203',
      expectedReasonCode: 'CUSTOMER_MISSING',
      resolutionCode: 'DUPLICATE_RECORD',
      idempotencyKey: idem(),
    });
    const open = await queue().list(A, IMPORTER, {
      limit: 50,
      reasonCode: 'CUSTOMER_MISSING',
      reviewState: 'OPEN',
    });
    expect(open.items.map((x) => x.legacyId)).toEqual(['200', '206']);
    const dismissed = await queue().list(A, IMPORTER, { limit: 50, reviewState: 'DISMISSED' });
    expect(dismissed.items).toMatchObject([
      {
        legacyId: '203',
        resolutionCode: 'DUPLICATE_RECORD',
        reviewedByActorType: 'SYSTEM_JOB',
        reviewedByActorId: 'legacy-import:review-test',
      },
    ]);
    const byRun = await queue().list(A, IMPORTER, { limit: 50, runId: randomUUID() });
    expect(byRun.items).toEqual([]);

    for (const limit of [0, 501, 1.5]) {
      expect(await codeOf(queue().list(A, IMPORTER, { limit }))).toBe(
        LEGACY_IMPORT_ERROR_CODES.INVALID,
      );
    }
    expect(
      await codeOf(
        queue().list(A, IMPORTER, { limit: 5, reasonCode: 'TEST_PANEL' as LegacyReviewReasonCode }),
      ),
    ).toBe(LEGACY_IMPORT_ERROR_CODES.INVALID);
  });

  // ---------------------------------------------------------------------------------------
  // Resolve and reopen
  // ---------------------------------------------------------------------------------------

  it('resolves OPEN → closed once: audit, event, idempotent replay, typed refusals', async () => {
    const runId = await startRun(A);
    await decide(A, runId, '11', review('PROVIDER_MISSING'));
    const k = idem();
    const first = await resolve('11', 'HANDLED_OUTSIDE_IMPORT', 'PROVIDER_MISSING', k);
    expect(first).toMatchObject({
      kind: 'RESOLVED',
      item: { reviewState: 'RESOLVED', resolutionCode: 'HANDLED_OUTSIDE_IMPORT' },
    });
    expect(first.item.reviewedAt).toBeInstanceOf(Date);
    // The same key replays the stored answer; no second audit row or event.
    expect((await resolve('11', 'HANDLED_OUTSIDE_IMPORT', 'PROVIDER_MISSING', k)).kind).toBe(
      'RESOLVED',
    );
    // An identical request under a new key is ALREADY.
    expect((await resolve('11', 'HANDLED_OUTSIDE_IMPORT', 'PROVIDER_MISSING')).kind).toBe(
      'ALREADY',
    );
    expect(await audits('user:11', 'legacy_import.review_resolve')).toBe(1);
    expect(await events('user:11')).toBe(1);
    // The same key with another request is a bug, never a replay.
    expect(await codeOf(resolve('11', 'WILL_NOT_IMPORT', 'PROVIDER_MISSING', k))).toBe(
      PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
    );
    // A different resolution of a closed row is a conflict, not an overwrite.
    expect(await codeOf(resolve('11', 'WILL_NOT_IMPORT'))).toBe(
      LEGACY_IMPORT_ERROR_CODES.REVIEW_CONFLICT,
    );
    expect(await row(A, '11')).toMatchObject({ reviewResolutionCode: 'HANDLED_OUTSIDE_IMPORT' });

    // A reason the caller did not see is a conflict: a rerun moved the row since it was listed.
    await decide(A, runId, '12', review('AMBIGUOUS_PANEL'));
    expect(await codeOf(resolve('12', 'WILL_NOT_IMPORT', 'PROVIDER_MISSING'))).toBe(
      LEGACY_IMPORT_ERROR_CODES.REVIEW_CONFLICT,
    );
    expect((await row(A, '12'))?.reviewState).toBe('OPEN');

    // Not in review, not there at all.
    await decide(A, runId, '13', {
      status: 'IMPORTED',
      entityType: 'CUSTOMER',
      entityId: randomUUID(),
      reasonCode: null,
    });
    expect(await codeOf(resolve('13'))).toBe(LEGACY_IMPORT_ERROR_CODES.REVIEW_NOT_IN_REVIEW);
    expect(await codeOf(reopen('13'))).toBe(LEGACY_IMPORT_ERROR_CODES.REVIEW_NOT_IN_REVIEW);
    expect((await row(A, '13'))?.status).toBe('IMPORTED');
    expect(await codeOf(resolve('14'))).toBe(LEGACY_IMPORT_ERROR_CODES.REVIEW_NOT_FOUND);
    expect(await codeOf(reopen('14'))).toBe(LEGACY_IMPORT_ERROR_CODES.REVIEW_NOT_FOUND);
    // Shape checks before SQL.
    expect(await codeOf(resolve('password:hunter2'))).toBe(LEGACY_IMPORT_ERROR_CODES.INVALID);
    expect(
      await codeOf(resolve('11', 'free text' as never as 'WILL_NOT_IMPORT', 'PROVIDER_MISSING')),
    ).toBe(LEGACY_IMPORT_ERROR_CODES.INVALID);
  });

  it('reopens a closed review: resolution cleared, reopen counted, audited; OPEN is ALREADY', async () => {
    const runId = await startRun(A);
    await decide(A, runId, '21', review('SUBSCRIPTION_REF_BLOCKED'));
    expect((await reopen('21')).kind).toBe('ALREADY');
    await resolve('21', 'TEST_OR_INVALID_DATA', 'SUBSCRIPTION_REF_BLOCKED');
    const out = await reopen('21');
    expect(out).toMatchObject({
      kind: 'REOPENED',
      item: {
        reviewState: 'OPEN',
        resolutionCode: null,
        reviewedAt: null,
        reviewedByActorId: null,
        reopenedCount: 1,
      },
    });
    expect((await reopen('21')).kind).toBe('ALREADY');
    expect(await audits('user:21', 'legacy_import.review_reopen')).toBe(1);
    expect(await events('user:21')).toBe(2);
    // And it can be resolved again.
    expect((await resolve('21', 'RETRY_AFTER_FIX', 'SUBSCRIPTION_REF_BLOCKED')).kind).toBe(
      'RESOLVED',
    );
  });

  // ---------------------------------------------------------------------------------------
  // Races: every transition is a conditional UPDATE naming its from-state
  // ---------------------------------------------------------------------------------------

  it('two concurrent resolutions with different codes: one wins, the other is a conflict', async () => {
    const runId = await startRun(A);
    for (let i = 0; i < 6; i += 1) {
      await decide(A, runId, String(300 + i), review('PROVIDER_MISSING'));
      const results = await Promise.allSettled([
        resolve(String(300 + i), 'WILL_NOT_IMPORT'),
        resolve(String(300 + i), 'RETRY_AFTER_FIX'),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled');
      const lost = results.filter((r) => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(
        isNexaError((lost[0] as PromiseRejectedResult).reason) &&
          (lost[0] as PromiseRejectedResult).reason.code,
      ).toBe(LEGACY_IMPORT_ERROR_CODES.REVIEW_CONFLICT);
      const winner = (won[0] as PromiseFulfilledResult<{ item: { resolutionCode: unknown } }>)
        .value;
      expect((await row(A, String(300 + i)))?.reviewResolutionCode).toBe(
        winner.item.resolutionCode,
      );
      expect(await audits(`user:${String(300 + i)}`, 'legacy_import.review_resolve')).toBe(1);
    }
  });

  it('two concurrent identical resolutions: one RESOLVED, one ALREADY, one audit row', async () => {
    const runId = await startRun(A);
    for (let i = 0; i < 6; i += 1) {
      const id = String(400 + i);
      await decide(A, runId, id, review('PROVIDER_MISSING'));
      const results = await Promise.all([resolve(id), resolve(id)]);
      expect(results.map((r) => r.kind).sort()).toEqual(['ALREADY', 'RESOLVED']);
      expect(await audits(`user:${id}`, 'legacy_import.review_resolve')).toBe(1);
      expect(await events(`user:${id}`)).toBe(1);
    }
  });

  it('resolve racing reopen: the final state is exactly what the winners say', async () => {
    const runId = await startRun(A);
    for (let i = 0; i < 6; i += 1) {
      const id = String(500 + i);
      await decide(A, runId, id, review('PROVIDER_MISSING'));
      await resolve(id, 'WILL_NOT_IMPORT');
      const [r, o] = await Promise.allSettled([resolve(id, 'RETRY_AFTER_FIX'), reopen(id)]);
      expect(o.status).toBe('fulfilled');
      expect((o as PromiseFulfilledResult<{ kind: string }>).value.kind).toBe('REOPENED');
      const final = await row(A, id);
      if (r.status === 'fulfilled') {
        // The resolve ran after the reopen: it closed the reopened row.
        expect(final).toMatchObject({
          reviewState: 'RESOLVED',
          reviewResolutionCode: 'RETRY_AFTER_FIX',
        });
      } else {
        expect(isNexaError(r.reason) && r.reason.code).toBe(
          LEGACY_IMPORT_ERROR_CODES.REVIEW_CONFLICT,
        );
        expect(final).toMatchObject({ reviewState: 'OPEN', reviewResolutionCode: null });
      }
      expect(final?.reviewReopenedCount).toBe(1);
    }
  });

  it('resolve racing a rerun that changes the reason: exactly one takes effect', async () => {
    const run1 = await startRun(A);
    for (let i = 0; i < 6; i += 1) {
      await decide(A, run1, String(600 + i), review('PROVIDER_MISSING'));
    }
    await finishRun(A, run1);
    const run2 = await startRun(A, FP2);
    for (let i = 0; i < 6; i += 1) {
      const id = String(600 + i);
      const [res, rerun] = await Promise.allSettled([
        resolve(id, 'WILL_NOT_IMPORT', 'PROVIDER_MISSING'),
        decide(A, run2, id, review('AMBIGUOUS_PANEL')),
      ]);
      expect(rerun.status).toBe('fulfilled');
      const write = (rerun as PromiseFulfilledResult<{ kind: string; reason?: string }>).value;
      const final = await row(A, id);
      if (res.status === 'fulfilled') {
        // The person won: the rerun found a closed review and was refused, not applied.
        expect(write).toMatchObject({ kind: 'REFUSED', reason: 'REVIEW_CLOSED' });
        expect(final).toMatchObject({
          reasonCode: 'PROVIDER_MISSING',
          reviewState: 'DISMISSED',
          runId: run1,
        });
      } else {
        // The rerun won: the resolution named a reason the row no longer has.
        expect(isNexaError(res.reason) && res.reason.code).toBe(
          LEGACY_IMPORT_ERROR_CODES.REVIEW_CONFLICT,
        );
        expect(write.kind).toBe('UPDATED');
        expect(final).toMatchObject({
          reasonCode: 'AMBIGUOUS_PANEL',
          reviewState: 'OPEN',
          runId: run2,
        });
      }
    }
  });

  // ---------------------------------------------------------------------------------------
  // Reruns after a resolution
  // ---------------------------------------------------------------------------------------

  it('a rerun never overwrites a DISMISSED or HANDLED_OUTSIDE_IMPORT review until it is reopened', async () => {
    const run1 = await startRun(A);
    await decide(A, run1, '31', review('CONFLICTING_EXISTING_ENTITY'));
    await decide(A, run1, '32', review('CONFLICTING_EXISTING_ENTITY'));
    await finishRun(A, run1);
    await resolve('31', 'DUPLICATE_RECORD', 'CONFLICTING_EXISTING_ENTITY');
    await resolve('32', 'HANDLED_OUTSIDE_IMPORT', 'CONFLICTING_EXISTING_ENTITY');

    const run2 = await startRun(A, FP2);
    for (const id of ['31', '32']) {
      const before = await row(A, id);
      expect(resumeDecision(before ?? null, SUM1)).toBe('REVIEW_CLOSED');
      for (const decision of [
        {
          status: 'IMPORTED',
          entityType: 'CUSTOMER',
          entityId: randomUUID(),
          reasonCode: null,
        } as const,
        review('UNSUPPORTED_SHAPE'),
        { status: 'FAILED', reasonCode: 'INTERNAL_ERROR' } as const,
        { status: 'SKIPPED', reasonCode: 'TEST_PANEL' } as const,
      ]) {
        const out = await decide(A, run2, id, decision);
        expect(out).toMatchObject({ kind: 'REFUSED', reason: 'REVIEW_CLOSED' });
      }
      // Source drift is refused too: a person decided about THIS row.
      expect(await decide(A, run2, id, review('CONFLICTING_EXISTING_ENTITY'), SUM2)).toMatchObject({
        kind: 'REFUSED',
        reason: 'REVIEW_CLOSED',
      });
      // An identical replay is not an error.
      expect((await decide(A, run2, id, review('CONFLICTING_EXISTING_ENTITY'))).kind).toBe(
        'UNCHANGED',
      );
      expect(await row(A, id)).toEqual(before);
    }

    // Reopened, the next run may decide again.
    await reopen('31');
    expect(resumeDecision((await row(A, '31')) ?? null, SUM1)).toBe('PROCESS');
    const entityId = randomUUID();
    expect(
      (
        await decide(A, run2, '31', {
          status: 'IMPORTED',
          entityType: 'CUSTOMER',
          entityId,
          reasonCode: null,
        })
      ).kind,
    ).toBe('UPDATED');
    expect(await row(A, '31')).toMatchObject({
      status: 'IMPORTED',
      entityId,
      reviewState: null,
      runId: run2,
    });
  });

  it('RETRY_AFTER_FIX invites the rerun: importable becomes IMPORTED, still ambiguous comes back OPEN', async () => {
    const run1 = await startRun(A);
    await decide(A, run1, '41', review('PANEL_UNMAPPED'));
    await decide(A, run1, '42', review('PANEL_UNMAPPED'));
    await finishRun(A, run1);
    await resolve('41', 'RETRY_AFTER_FIX', 'PANEL_UNMAPPED');
    await resolve('42', 'RETRY_AFTER_FIX', 'PANEL_UNMAPPED');

    const run2 = await startRun(A, FP2);
    expect(resumeDecision((await row(A, '41')) ?? null, SUM1)).toBe('PROCESS');
    const service = randomUUID();
    const imported = await decide(A, run2, '41', {
      status: 'IMPORTED',
      entityType: 'SERVICE',
      entityId: service,
      reasonCode: null,
    });
    expect(imported).toMatchObject({
      kind: 'UPDATED',
      record: {
        status: 'IMPORTED',
        entityId: service,
        reviewState: null,
        reviewResolutionCode: null,
        attempts: 2,
      },
    });

    // The identical decision is NOT "unchanged" here: the retry was asked for, and a decision
    // that comes back the same puts the row back in the queue rather than leaving it closed.
    const again = await decide(A, run2, '42', review('PANEL_UNMAPPED'));
    expect(again).toMatchObject({
      kind: 'UPDATED',
      record: {
        status: 'MANUAL_REVIEW',
        reviewState: 'OPEN',
        reviewResolutionCode: null,
        reviewedAt: null,
        reviewReopenedCount: 1,
        attempts: 2,
        runId: run2,
      },
    });
    // And now it is an ordinary OPEN review: a further identical write changes nothing.
    expect((await decide(A, run2, '42', review('PANEL_UNMAPPED'))).kind).toBe('UNCHANGED');

    // The IMPORTED row is never lost: no later review action reaches it.
    expect(await codeOf(resolve('41', 'WILL_NOT_IMPORT', 'PANEL_UNMAPPED'))).toBe(
      LEGACY_IMPORT_ERROR_CODES.REVIEW_NOT_IN_REVIEW,
    );
    expect(await decide(A, run2, '41', review('PANEL_UNMAPPED')).then((o) => o.kind)).toBe(
      'REFUSED',
    );
    expect(await row(A, '41')).toMatchObject({ status: 'IMPORTED', entityId: service });
  });

  // ---------------------------------------------------------------------------------------
  // Isolation, authority, activity
  // ---------------------------------------------------------------------------------------

  it('tenant isolation: another tenant neither sees, counts nor closes a review row', async () => {
    const runId = await startRun(A);
    await decide(A, runId, '51', review('INVALID_PHONE'));
    expect((await queue().list(B, IMPORTER, { limit: 50 })).items).toEqual([]);
    expect((await queue().counts(B, IMPORTER)).rowCount).toBe(0);
    expect(
      await codeOf(
        queue().resolve(B, IMPORTER, {
          legacyTable: 'user',
          legacyId: '51',
          expectedReasonCode: 'INVALID_PHONE',
          resolutionCode: 'WILL_NOT_IMPORT',
          idempotencyKey: idem(),
        }),
      ),
    ).toBe(LEGACY_IMPORT_ERROR_CODES.REVIEW_NOT_FOUND);
    expect(await codeOf(reopen('51', idem(), B))).toBe(LEGACY_IMPORT_ERROR_CODES.REVIEW_NOT_FOUND);
    expect((await row(A, '51'))?.reviewState).toBe('OPEN');
  });

  it('is denied without maintenance.run (audited), refuses a stopped tenant and an unidentified actor', async () => {
    const runId = await startRun(A);
    await decide(A, runId, '61', review('UNSUPPORTED_SHAPE'));
    const support = adminActorFor(
      await createAdmin(ctx.container, A, { username: 'support-review', roleKeys: ['support'] }),
    );
    expect(await codeOf(queue().list(A, support, { limit: 5 }))).toBe(
      PLATFORM_ERROR_CODES.PERMISSION_DENIED,
    );
    expect(await codeOf(queue().counts(A, support))).toBe(PLATFORM_ERROR_CODES.PERMISSION_DENIED);
    expect(
      await codeOf(resolve('61', 'WILL_NOT_IMPORT', 'UNSUPPORTED_SHAPE', idem(), A, support)),
    ).toBe(PLATFORM_ERROR_CODES.PERMISSION_DENIED);
    expect(await audits('user:61', 'legacy_import.review_resolve', 'DENIED')).toBe(1);

    // An owner holds maintenance.run and passes the same check: no actor type is special.
    const owner = adminActorFor(
      await createAdmin(ctx.container, A, { username: 'owner-review', roleKeys: ['owner'] }),
    );
    expect((await queue().list(A, owner, { limit: 5 })).items).toHaveLength(1);

    // An actor with no stable id cannot be recorded as the closer.
    const anonymous: ActorContext = { ...IMPORTER, id: null };
    expect(
      await codeOf(resolve('61', 'WILL_NOT_IMPORT', 'UNSUPPORTED_SHAPE', idem(), A, anonymous)),
    ).toBe(LEGACY_IMPORT_ERROR_CODES.INVALID);

    await db().execute(sql`UPDATE tenants SET status = 'STOPPED' WHERE id = ${A.tenantId}`);
    expect(await codeOf(resolve('61', 'WILL_NOT_IMPORT', 'UNSUPPORTED_SHAPE'))).toBe(
      COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
    );
    expect((await row(A, '61'))?.reviewState).toBe('OPEN');
  });
});
