import {
  LEGACY_INVOICE_ARCHIVE_AUDIT_ACTIONS,
  LEGACY_INVOICE_ARCHIVE_CLASSES,
  LEGACY_INVOICE_ARCHIVE_ERROR_CODES,
  LEGACY_INVOICE_ARCHIVE_PAGE_DEFAULT,
  LEGACY_INVOICE_PII_COLUMNS,
  errors,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type LegacyInvoiceArchiveClass,
  type LegacyInvoiceArchiveListQuery,
  type LegacyInvoiceArchiveRunFailure,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../access/application/authorized-mutation.js';
import type { SessionRepository } from '../../identity/application/ports.js';
import type { ScopeActivityReader } from '../../system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  INVOICE_ARCHIVE_NORMALIZATION_VERSION,
  decideRevision,
  invoiceRowChecksum,
  legacyInvoiceProductCode,
  normaliseLegacyInvoice,
  redactInvoiceRow,
  unrepresentableColumn,
  type LegacyInvoiceRawRow,
} from '../domain/invoice-archive-row.js';
import type {
  LegacyInvoiceArchiveFilter,
  LegacyInvoiceArchiveRecord,
  LegacyInvoiceArchiveRepository,
  LegacyInvoiceArchiveRevisionRecord,
  LegacyInvoiceArchiveRun,
  LegacyInvoiceImportOutcome,
  NewLegacyInvoiceArchiveRow,
  StagedLegacyInvoice,
} from './ports.js';

export const LEGACY_INVOICES_VIEW_PERMISSION = 'legacy.invoices.view' satisfies PermissionKey;
export const LEGACY_INVOICES_PII_PERMISSION = 'legacy.invoices.pii.view' satisfies PermissionKey;
/** The CLI ingest: SYSTEM_JOB work, charged like every importer write. */
export const LEGACY_INVOICES_INGEST_PERMISSION = 'maintenance.run' satisfies PermissionKey;

const RUN_ENTITY = 'LegacyInvoiceArchiveRun';
const ROW_ENTITY = 'LegacyInvoiceArchive';

/** The largest promotion batch: one transaction's worth of revisions. */
export const INVOICE_ARCHIVE_PROMOTE_MAX = 1000;

/**
 * A staged batch the archive refuses to hold: the run fails with this code and NOTHING of
 * it is archived. The message names a column or a table, never a value.
 */
export class InvoiceArchiveStagingRefused extends Error {
  constructor(
    readonly failure: Extract<
      LegacyInvoiceArchiveRunFailure,
      'SOURCE_KEY_DUPLICATED' | 'CELL_UNREPRESENTABLE'
    >,
    detail: string,
  ) {
    super(`${failure}: ${detail}`);
  }
}

/** One delivered batch of the `invoice-archive` read set, as the ingest hands it over. */
export interface InvoiceArchiveSourceBatch {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly (string | null)[])[];
}

/** What the read that staged a run proved: its exact row counts and its fingerprints. */
export interface InvoiceArchiveReadEvidence {
  readonly invoiceRows: number;
  readonly userRows: number;
  readonly productRows: number;
  /** The v1 identity's `invoice` row count, from the same session: must be the same table. */
  readonly v1InvoiceRows: number;
}

export interface InvoiceArchiveRunMeta {
  readonly readSetVersion: number;
  readonly readSetFingerprint: string;
  readonly sourceFingerprint: string;
  readonly sourceSchemaHash: string;
  readonly sourceEngine: string;
  readonly synthetic: boolean;
}

/** One archived revision as a reader may see it: the PII fields null when redacted. */
export interface LegacyInvoiceArchiveReadRow {
  readonly record: LegacyInvoiceArchiveRecord;
  readonly piiRedacted: boolean;
}

export interface LegacyInvoiceArchiveDetail extends LegacyInvoiceArchiveReadRow {
  readonly raw: Readonly<Record<string, string | null>>;
  readonly redactedColumns: readonly string[];
  readonly revisions: readonly LegacyInvoiceArchiveRevisionRecord[];
  readonly importOutcome: LegacyInvoiceImportOutcome | null;
}

export interface LegacyInvoiceArchiveServiceDeps {
  readonly repository: LegacyInvoiceArchiveRepository;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly codeVersion: string | null;
}

/**
 * The keyset cursor: `k` and the last invoice key of the page, base64url. Opaque to the
 * client; the prefix keeps an empty legacy id (which MySQL allows) a non-empty cursor.
 */
export function encodeInvoiceCursor(invoiceKey: string): string {
  return `k${Buffer.from(invoiceKey, 'utf8').toString('base64url')}`;
}

export function decodeInvoiceCursor(cursor: string): string {
  const key = Buffer.from(cursor.slice(1), 'base64url').toString('utf8');
  if (!cursor.startsWith('k') || encodeInvoiceCursor(key) !== cursor) {
    throw errors.validation(LEGACY_INVOICE_ARCHIVE_ERROR_CODES.REQUEST_INVALID, 'Bad cursor.');
  }
  return key;
}

function redactRecord(record: LegacyInvoiceArchiveRecord): LegacyInvoiceArchiveRecord {
  return { ...record, legacyUserId: null, username: null };
}

/**
 * Mirza migration PR3 — the legacy invoice archive (`docs/legacy-migration/importer.md`
 * §Invoice archive).
 *
 * Two kinds of caller:
 *
 * - the CLI ingest (`legacy-import invoices-read`, SYSTEM_JOB, `maintenance.run`) drives a
 *   RUN through its states, every step one transaction that re-checks the permission and
 *   reads the scope's activity: start (STAGING), stage each delivered batch, verify the
 *   staged rows against the read's exact counts (VERIFIED), promote the staged rows into
 *   revisions batch by batch behind a cursor, complete (COMPLETED) — or fail (FAILED, its
 *   staging deleted, nothing archived). Each run transition is audited with counts and
 *   hashes, never a cell;
 * - the Web Admin reads (`legacy.invoices.view`), with the personal cells redacted unless
 *   the reader also holds `legacy.invoices.pii.view`, which a search BY those cells
 *   requires. Each unredacted detail and each such search is audited by name.
 *
 * Nothing here creates an order, a payment, a wallet entry, a service or a provisioning
 * operation, and no report reads the archive.
 */
export class LegacyInvoiceArchiveService {
  constructor(private readonly deps: LegacyInvoiceArchiveServiceDeps) {}

  // --- reads (legacy.invoices.view; PII with legacy.invoices.pii.view) --------------------

  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: LegacyInvoiceArchiveListQuery,
  ): Promise<{
    readonly rows: readonly LegacyInvoiceArchiveReadRow[];
    readonly nextCursor: string | null;
  }> {
    await this.deps.guard.check(scope, actor, LEGACY_INVOICES_VIEW_PERMISSION);
    const piiFilters = (['legacyUserId', 'username'] as const).filter(
      (name) => query[name] !== undefined,
    );
    let pii = await this.deps.guard.has(scope, actor, LEGACY_INVOICES_PII_PERMISSION);
    if (piiFilters.length > 0) {
      await this.requirePii(scope, actor, LEGACY_INVOICE_ARCHIVE_AUDIT_ACTIONS.piiSearch, null);
      pii = true;
      await this.deps.audit.record(scope, actor, {
        action: LEGACY_INVOICE_ARCHIVE_AUDIT_ACTIONS.piiSearch,
        entityType: ROW_ENTITY,
        entityId: null,
        before: null,
        // The filter NAMES only: a Telegram id never enters the append-only audit log.
        after: { filters: [...piiFilters] },
        result: 'SUCCESS',
      });
    }
    const limit = query.limit ?? LEGACY_INVOICE_ARCHIVE_PAGE_DEFAULT;
    const filter: LegacyInvoiceArchiveFilter = {
      ...(query.invoiceId === undefined ? {} : { invoiceIdPrefix: query.invoiceId }),
      ...(query.legacyUserId === undefined ? {} : { legacyUserId: query.legacyUserId }),
      ...(query.username === undefined ? {} : { usernamePrefix: query.username }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.panelCode === undefined ? {} : { panelCode: query.panelCode }),
      ...(query.productCode === undefined ? {} : { productCode: query.productCode }),
      ...(query.classification === undefined ? {} : { classification: query.classification }),
      ...(query.test === undefined ? {} : { isTest: query.test === 'true' }),
    };
    const after = query.after === undefined ? null : decodeInvoiceCursor(query.after);
    const records = await this.deps.repository.list(scope, filter, after, limit + 1);
    const page = records.slice(0, limit);
    const last = page[page.length - 1];
    return {
      rows: page.map((record) => ({
        record: pii ? record : redactRecord(record),
        piiRedacted: !pii,
      })),
      nextCursor:
        records.length > limit && last !== undefined ? encodeInvoiceCursor(last.invoiceKey) : null,
    };
  }

  async get(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<LegacyInvoiceArchiveDetail> {
    await this.deps.guard.check(scope, actor, LEGACY_INVOICES_VIEW_PERMISSION);
    const record = await this.deps.repository.findVisible(scope, id);
    if (record === null) {
      throw errors.notFound(
        LEGACY_INVOICE_ARCHIVE_ERROR_CODES.NOT_FOUND,
        'No such archived legacy invoice.',
      );
    }
    const pii = await this.deps.guard.has(scope, actor, LEGACY_INVOICES_PII_PERMISSION);
    if (pii) {
      await this.deps.audit.record(scope, actor, {
        action: LEGACY_INVOICE_ARCHIVE_AUDIT_ACTIONS.piiView,
        entityType: ROW_ENTITY,
        entityId: record.id,
        before: null,
        after: { revision: record.revision, runId: record.runId },
        result: 'SUCCESS',
      });
    }
    const redacted = pii
      ? { raw: { ...record.rawRow }, redacted: [] as readonly string[] }
      : redactInvoiceRow(record.rawRow, LEGACY_INVOICE_PII_COLUMNS);
    return {
      record: pii ? record : redactRecord(record),
      piiRedacted: !pii,
      raw: redacted.raw,
      redactedColumns: redacted.redacted,
      revisions: await this.deps.repository.revisionsOf(scope, record.invoiceKey),
      importOutcome: await this.deps.repository.importOutcome(scope, record.invoiceKey),
    };
  }

  /** Aggregates only: counts by class, and the recent runs. No invoice, id or username. */
  async summary(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<{
    readonly invoices: number;
    readonly revisions: number;
    readonly classes: Readonly<Record<LegacyInvoiceArchiveClass, number>>;
    readonly runs: readonly LegacyInvoiceArchiveRun[];
  }> {
    await this.deps.guard.check(scope, actor, LEGACY_INVOICES_VIEW_PERMISSION);
    const summary = await this.deps.repository.summary(scope);
    const classes = Object.fromEntries(
      LEGACY_INVOICE_ARCHIVE_CLASSES.map((name) => [name, summary.classes[name] ?? 0]),
    ) as Record<LegacyInvoiceArchiveClass, number>;
    return {
      invoices: summary.invoices,
      revisions: summary.revisions,
      classes,
      runs: await this.deps.repository.listRuns(scope, 10),
    };
  }

  // --- the CLI ingest (SYSTEM_JOB, maintenance.run) ---------------------------------------

  /** The tenant's open run, if any (read for the ingest's housekeeping). */
  async openRun(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<LegacyInvoiceArchiveRun | null> {
    await this.deps.guard.check(scope, actor, LEGACY_INVOICES_INGEST_PERMISSION);
    return this.deps.repository.openRun(scope);
  }

  async findRun(
    scope: TenantContext,
    actor: ActorContext,
    runId: string,
  ): Promise<LegacyInvoiceArchiveRun | null> {
    await this.deps.guard.check(scope, actor, LEGACY_INVOICES_INGEST_PERMISSION);
    return this.deps.repository.findRun(scope, runId);
  }

  /**
   * A new STAGING run for an approved read. Refused (`RUN_CONFLICT`) while another run of
   * this tenant is open: the partial unique index is the rule, not this process.
   */
  async startRun(
    scope: TenantContext,
    actor: ActorContext,
    meta: InvoiceArchiveRunMeta,
  ): Promise<LegacyInvoiceArchiveRun> {
    const id = this.deps.ids.uuid();
    return this.mutate(
      scope,
      actor,
      LEGACY_INVOICE_ARCHIVE_AUDIT_ACTIONS.runStarted,
      id,
      async (tx, now) => {
        const run = await this.deps.repository.insertRun(
          scope,
          { id, ...meta, codeVersion: this.deps.codeVersion, now },
          tx,
        );
        if (run === null) throw runConflict('Another invoice archive run of this tenant is open.');
        await this.auditRun(
          scope,
          actor,
          LEGACY_INVOICE_ARCHIVE_AUDIT_ACTIONS.runStarted,
          null,
          run,
          tx,
        );
        return run;
      },
    );
  }

  /**
   * Stages one delivered batch in ONE transaction. Refuses (`InvoiceArchiveStagingRefused`,
   * the batch rolled back) a cell PostgreSQL cannot hold verbatim and a key the run has
   * already staged — two source rows sharing a key are never silently collapsed.
   */
  async stageBatch(
    scope: TenantContext,
    actor: ActorContext,
    runId: string,
    batch: InvoiceArchiveSourceBatch,
  ): Promise<number> {
    if (batch.rows.length === 0) return 0;
    const table = batch.table;
    if (table !== 'invoice' && table !== 'user' && table !== 'product') {
      throw new Error(`the invoice archive reads no table ${table}`);
    }
    const objects = batch.rows.map((cells) => {
      const row: Record<string, string | null> = {};
      batch.columns.forEach((column, index) => {
        row[column] = cells[index] ?? null;
      });
      return row as LegacyInvoiceRawRow;
    });
    const keyColumn = table === 'invoice' ? 'id_invoice' : 'id';
    for (const row of objects) {
      const bad =
        table === 'invoice'
          ? unrepresentableColumn(row)
          : (Object.entries(row).find(([, v]) => v !== null && v.includes('\u0000'))?.[0] ?? null);
      if (bad !== null) {
        throw new InvoiceArchiveStagingRefused(
          'CELL_UNREPRESENTABLE',
          `${table}.${bad} holds a value the archive cannot keep verbatim`,
        );
      }
      if (row[keyColumn] === null || row[keyColumn] === undefined) {
        throw new InvoiceArchiveStagingRefused(
          'CELL_UNREPRESENTABLE',
          `${table}.${keyColumn} is NULL on a row`,
        );
      }
    }
    return this.mutate(scope, actor, 'legacy.invoice_archive.stage', runId, async (tx) => {
      await this.requireRun(scope, runId, 'STAGING', tx);
      let inserted: number;
      if (table === 'invoice') {
        const staged: StagedLegacyInvoice[] = objects.map((cells) => ({
          invoiceKey: cells['id_invoice'] as string,
          cells,
          rowChecksum: invoiceRowChecksum(cells),
        }));
        inserted = await this.deps.repository.stageInvoices(scope, runId, staged, tx);
      } else {
        inserted = await this.deps.repository.stageKeys(
          scope,
          runId,
          table,
          objects.map((row) => ({
            key: row['id'] as string,
            lookup:
              table === 'user'
                ? (row['id'] as string)
                : legacyInvoiceProductCode(row['code_product']),
          })),
          tx,
        );
      }
      if (inserted !== objects.length) {
        throw new InvoiceArchiveStagingRefused(
          'SOURCE_KEY_DUPLICATED',
          `${String(objects.length - inserted)} ${table} row(s) share a key with a row already read`,
        );
      }
      return inserted;
    });
  }

  /**
   * After the read returned (delivered AND proven equal to the verified pass): the staged
   * rows must add up to the read's exact counts — and the archive read's `invoice` count to
   * the v1 identity's, the same table in the same snapshot. Then VERIFIED; otherwise the
   * run FAILS (`STAGED_COUNT_MISMATCH`) and its staging is deleted.
   */
  async verifyRun(
    scope: TenantContext,
    actor: ActorContext,
    runId: string,
    evidence: InvoiceArchiveReadEvidence,
  ): Promise<
    | { readonly ok: true; readonly run: LegacyInvoiceArchiveRun }
    | { readonly ok: false; readonly run: LegacyInvoiceArchiveRun }
  > {
    return this.mutate(
      scope,
      actor,
      LEGACY_INVOICE_ARCHIVE_AUDIT_ACTIONS.runVerified,
      runId,
      async (tx, now) => {
        const before = await this.requireRun(scope, runId, 'STAGING', tx);
        const staged = await this.deps.repository.stagedCounts(scope, runId, tx);
        const agrees =
          staged.invoice === BigInt(evidence.invoiceRows) &&
          staged.invoice === BigInt(evidence.v1InvoiceRows) &&
          staged.user === BigInt(evidence.userRows) &&
          staged.product === BigInt(evidence.productRows);
        if (!agrees) {
          const failed = await this.failWithin(
            scope,
            actor,
            before,
            'STAGED_COUNT_MISMATCH',
            now,
            tx,
          );
          return { ok: false as const, run: failed };
        }
        const after = await this.deps.repository.transitionRun(
          scope,
          runId,
          ['STAGING'],
          {
            state: 'VERIFIED',
            sourceInvoiceRows: staged.invoice,
            sourceUserRows: staged.user,
            sourceProductRows: staged.product,
            now,
          },
          tx,
        );
        if (after === null) throw runConflict('The run left STAGING while it was being verified.');
        await this.auditRun(
          scope,
          actor,
          LEGACY_INVOICE_ARCHIVE_AUDIT_ACTIONS.runVerified,
          before,
          after,
          tx,
        );
        return { ok: true as const, run: after };
      },
    );
  }

  /**
   * Fails a STAGING run and deletes its staging rows: nothing of its read is archived. A run
   * that is no longer STAGING is left as it is (null): a VERIFIED run's read was proven,
   * and only completes.
   */
  async failRun(
    scope: TenantContext,
    actor: ActorContext,
    runId: string,
    failure: LegacyInvoiceArchiveRunFailure,
  ): Promise<LegacyInvoiceArchiveRun | null> {
    return this.mutate(
      scope,
      actor,
      LEGACY_INVOICE_ARCHIVE_AUDIT_ACTIONS.runFailed,
      runId,
      async (tx, now) => {
        const before = await this.deps.repository.findRun(scope, runId, tx, { forUpdate: true });
        if (before === null || before.state !== 'STAGING') return null;
        return this.failWithin(scope, actor, before, failure, now, tx);
      },
    );
  }

  /**
   * Promotes the next batch of a VERIFIED run's staged invoices, in ONE transaction: for each,
   * the source-derived context from the run's own staged `user` and `product` rows, the
   * normalised fields, and the revision decision against the archive's latest revision —
   * identical facts write nothing, anything else appends revision n+1. The cursor advances in
   * the same transaction, conditionally on where it was: a crash resumes exactly here, and a
   * second writer cannot promote the same batch.
   */
  async promoteBatch(
    scope: TenantContext,
    actor: ActorContext,
    runId: string,
    limit: number,
  ): Promise<{ readonly done: boolean; readonly run: LegacyInvoiceArchiveRun }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > INVOICE_ARCHIVE_PROMOTE_MAX) {
      throw new Error(`a promotion batch is 1-${String(INVOICE_ARCHIVE_PROMOTE_MAX)} rows`);
    }
    return this.mutate(scope, actor, 'legacy.invoice_archive.promote', runId, async (tx, now) => {
      const run = await this.requireRun(scope, runId, 'VERIFIED', tx);
      const staged = await this.deps.repository.stagedInvoicesAfter(
        scope,
        runId,
        run.promotedThrough,
        limit,
        tx,
      );
      const last = staged[staged.length - 1];
      if (last === undefined) return { done: true, run };

      const userIds = [
        ...new Set(staged.flatMap((s) => (s.cells['id_user'] == null ? [] : [s.cells['id_user']]))),
      ];
      const codes = [
        ...new Set(
          staged.flatMap((s) => {
            const code = legacyInvoiceProductCode(s.cells['code_product']);
            return code === null ? [] : [code];
          }),
        ),
      ];
      const owners = await this.deps.repository.presentUsers(scope, runId, userIds, tx);
      const products = await this.deps.repository.presentProductCodes(scope, runId, codes, tx);
      const latest = await this.deps.repository.latestRevisions(
        scope,
        staged.map((s) => s.invoiceKey),
        tx,
      );

      const rows: NewLegacyInvoiceArchiveRow[] = [];
      let insertedNew = 0n;
      let insertedRevision = 0n;
      let unchanged = 0n;
      for (const s of staged) {
        const userId = s.cells['id_user'] ?? null;
        const code = legacyInvoiceProductCode(s.cells['code_product']);
        const normalised = normaliseLegacyInvoice(s.cells, {
          ownerPresent: userId !== null && owners.has(userId),
          productInTable: code !== null && products.has(code),
        });
        // The cells came back from jsonb exactly as they were staged, or nothing is written.
        if (normalised.rowChecksum !== s.rowChecksum || normalised.invoiceKey !== s.invoiceKey) {
          throw new Error('a staged invoice no longer matches its own checksum');
        }
        const decision = decideRevision(latest.get(s.invoiceKey) ?? null, normalised);
        if (decision.kind === 'UNCHANGED') {
          unchanged += 1n;
          continue;
        }
        if (decision.revision === 1) insertedNew += 1n;
        else insertedRevision += 1n;
        const { soldAtEpochSeconds, ...fields } = normalised;
        rows.push({
          ...fields,
          soldAtEpochSeconds,
          id: this.deps.ids.uuid(),
          runId,
          revision: decision.revision,
          revisionReason: decision.reason,
          rawRow: s.cells,
          readSetFingerprint: run.readSetFingerprint,
          sourceFingerprint: run.sourceFingerprint,
          normalizationVersion: INVOICE_ARCHIVE_NORMALIZATION_VERSION,
          archivedAt: now,
        });
      }
      await this.deps.repository.insertRevisions(scope, rows, tx);
      const advanced = await this.deps.repository.advancePromotion(
        scope,
        runId,
        {
          expectedThrough: run.promotedThrough,
          through: last.invoiceKey,
          promoted: BigInt(staged.length),
          insertedNew,
          insertedRevision,
          unchanged,
          now,
        },
        tx,
      );
      if (advanced === null) throw runConflict('The run moved while a batch was being promoted.');
      return { done: false, run: advanced };
    });
  }

  /**
   * Completes a fully promoted run, in ONE transaction: every staged invoice is accounted for
   * (`promoted = source rows`), the archived invoices the snapshot no longer has are counted
   * (never deleted), the closure `archived = source rows + missing` is asserted (and pinned
   * by the run's CHECK), the run becomes COMPLETED — its revisions visible — and its staging
   * is deleted.
   */
  async completeRun(
    scope: TenantContext,
    actor: ActorContext,
    runId: string,
  ): Promise<LegacyInvoiceArchiveRun> {
    return this.mutate(
      scope,
      actor,
      LEGACY_INVOICE_ARCHIVE_AUDIT_ACTIONS.runCompleted,
      runId,
      async (tx, now) => {
        const before = await this.requireRun(scope, runId, 'VERIFIED', tx);
        const pending = await this.deps.repository.stagedInvoicesAfter(
          scope,
          runId,
          before.promotedThrough,
          1,
          tx,
        );
        if (pending.length > 0 || before.promotedRows !== before.sourceInvoiceRows) {
          throw runConflict('The run still has staged invoices to promote.');
        }
        const missing = await this.deps.repository.countMissingFromRun(scope, runId, tx);
        const archived = await this.deps.repository.countArchivedInvoices(scope, tx);
        const sourceRows = before.sourceInvoiceRows ?? 0n;
        if (archived !== sourceRows + missing) {
          throw new Error(
            `the archive holds ${String(archived)} invoices, not the ${String(sourceRows)} read plus ` +
              `${String(missing)} missing: nothing was completed`,
          );
        }
        const after = await this.deps.repository.transitionRun(
          scope,
          runId,
          ['VERIFIED'],
          { state: 'COMPLETED', missingInSnapshot: missing, archiveInvoicesAfter: archived, now },
          tx,
        );
        if (after === null)
          throw runConflict('The run left VERIFIED while it was being completed.');
        await this.deps.repository.deleteStaging(scope, runId, tx);
        await this.auditRun(
          scope,
          actor,
          LEGACY_INVOICE_ARCHIVE_AUDIT_ACTIONS.runCompleted,
          before,
          after,
          tx,
        );
        return after;
      },
    );
  }

  // --- internals ---------------------------------------------------------------------------

  private async failWithin(
    scope: TenantContext,
    actor: ActorContext,
    before: LegacyInvoiceArchiveRun,
    failure: LegacyInvoiceArchiveRunFailure,
    now: Date,
    tx: TransactionScope,
  ): Promise<LegacyInvoiceArchiveRun> {
    const after = await this.deps.repository.transitionRun(
      scope,
      before.id,
      ['STAGING'],
      { state: 'FAILED', failureCode: failure, now },
      tx,
    );
    if (after === null) throw runConflict('The run left STAGING while it was being failed.');
    await this.deps.repository.deleteStaging(scope, before.id, tx);
    await this.auditRun(
      scope,
      actor,
      LEGACY_INVOICE_ARCHIVE_AUDIT_ACTIONS.runFailed,
      before,
      after,
      tx,
    );
    return after;
  }

  private async requireRun(
    scope: TenantContext,
    runId: string,
    state: 'STAGING' | 'VERIFIED',
    tx: TransactionScope,
  ): Promise<LegacyInvoiceArchiveRun> {
    const run = await this.deps.repository.findRun(scope, runId, tx, { forUpdate: true });
    if (run === null || run.state !== state) {
      throw runConflict(`The invoice archive run is not ${state}.`);
    }
    return run;
  }

  /** The PII permission, refused with an audited DENIED row before anything is read. */
  private async requirePii(
    scope: TenantContext,
    actor: ActorContext,
    action: string,
    entityId: string | null,
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, LEGACY_INVOICES_PII_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        LEGACY_INVOICES_PII_PERMISSION,
        { action, entityType: ROW_ENTITY, entityId },
        error,
      );
      throw error;
    }
  }

  private async auditRun(
    scope: TenantContext,
    actor: ActorContext,
    action: string,
    before: LegacyInvoiceArchiveRun | null,
    after: LegacyInvoiceArchiveRun,
    tx: TransactionScope,
  ): Promise<void> {
    await this.deps.audit.record(
      scope,
      actor,
      {
        action,
        entityType: RUN_ENTITY,
        entityId: after.id,
        before: before === null ? null : runAuditView(before),
        after: runAuditView(after),
        result: 'SUCCESS',
      },
      tx,
    );
  }

  /** An ingest transaction: `maintenance.run`, re-checked inside, scope activity read inside. */
  private mutate<T>(
    scope: TenantContext,
    actor: ActorContext,
    action: string,
    runId: string,
    fn: (tx: TransactionScope, now: Date) => Promise<T>,
  ): Promise<T> {
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      LEGACY_INVOICES_INGEST_PERMISSION,
      { action, entityType: RUN_ENTITY, entityId: runId },
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            LEGACY_INVOICE_ARCHIVE_ERROR_CODES.SCOPE_STOPPED,
            'This installation has stopped accepting work.',
          );
        }
        return fn(tx, this.deps.clock.now());
      },
    );
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }
}

function runConflict(message: string): Error {
  return errors.conflict(LEGACY_INVOICE_ARCHIVE_ERROR_CODES.RUN_CONFLICT, message);
}

/** A run as the audit log records it: state, codes, hashes and counts. Never a cell. */
function runAuditView(run: LegacyInvoiceArchiveRun): Record<string, unknown> {
  const n = (value: bigint | null) => (value === null ? null : value.toString());
  return {
    state: run.state,
    failureCode: run.failureCode,
    readSetFingerprint: run.readSetFingerprint,
    sourceFingerprint: run.sourceFingerprint,
    synthetic: run.synthetic,
    sourceInvoiceRows: n(run.sourceInvoiceRows),
    sourceUserRows: n(run.sourceUserRows),
    sourceProductRows: n(run.sourceProductRows),
    promotedRows: n(run.promotedRows),
    insertedNew: n(run.insertedNew),
    insertedRevision: n(run.insertedRevision),
    unchanged: n(run.unchanged),
    missingInSnapshot: n(run.missingInSnapshot),
    archiveInvoicesAfter: n(run.archiveInvoicesAfter),
  };
}
