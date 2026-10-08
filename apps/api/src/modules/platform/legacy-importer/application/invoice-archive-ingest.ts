import {
  errors,
  LEGACY_IMPORT_ERROR_CODES,
  type ActorContext,
  type LegacyInvoiceArchiveRunFailure,
  type TenantContext,
} from '@nexa/contracts';
import {
  INVOICE_ARCHIVE_PROMOTE_MAX,
  InvoiceArchiveStagingRefused,
  type LegacyInvoiceArchiveService,
} from '../../legacy-invoice-archive/application/legacy-invoice-archive.service.js';
import type { LegacyInvoiceArchiveRun } from '../../legacy-invoice-archive/application/ports.js';
import {
  INVOICE_ARCHIVE_READ_SET,
  INVOICE_ARCHIVE_READ_SET_NAME,
  INVOICE_ARCHIVE_READ_SET_VERSION,
  digestInvoiceArchiveReadSet,
  readApprovedInvoiceArchiveReadSet,
} from './invoice-archive-read-set.js';
import type { LegacyImportProcessLock, LegacyReadSetRun } from './ports.js';
import { decideEvidenceClass } from './production-guard.js';
import { READ_SET_DEFAULT_BATCH, withBoundReadSetSession } from './read-set.js';
import { LegacySourceRefused, type LegacySourceConnector } from './source-port.js';
import type { LegacyImportV1Identity } from './source-snapshot.js';

/**
 * Mirza migration PR3 — `legacy-import invoices-read`: the `invoice-archive` read set into the
 * append-only legacy invoice archive (`docs/legacy-migration/importer.md` §Invoice archive).
 *
 * ## Two approvals, and nothing archived before both hold
 *
 * 1. Without `expectedInvoiceArchiveFingerprint`: ONE read-only session bound to the approved
 *    v1 source (`--expected-fingerprint`, refused on a mismatch) digests the read set and
 *    returns its fingerprint for the owner to approve. Nothing is written anywhere.
 * 2. With it: under the importer's per-tenant claim, a bound session digests the read set
 *    AGAIN and refuses unless it equals the approval — before a single row is delivered.
 *
 * ## Why STAGING, and not PR2's in-memory gathering
 *
 * The MySQL source refuses to run inside a PostgreSQL transaction, so no transaction can
 * span the delivery, and a read can still fail AFTER its last batch
 * (`READ_SET_SNAPSHOT_DIVERGED`). PR2 holds the delivered rows in memory until the read has
 * returned — right for a product catalogue, wrong for an invoice table of 10^5+ rows. Here
 * each delivered batch is committed into STAGING rows of a run (one transaction per batch,
 * memory bounded by the batch), and the archive itself is touched only after the read has
 * returned AND the staged rows add up to its exact counts:
 *
 * - a fingerprint mismatch delivers nothing: no run is even created (the run starts on the
 *   first delivered batch, which pass 1's verification precedes);
 * - a divergence, a refused batch or any other error during the read FAILS the run and
 *   deletes its staging: nothing of that read is archived;
 * - a process that dies mid-read leaves a STAGING run, which the next invocation fails as
 *   `ABANDONED` (its staging deleted) before it reads again — a resumed read is a fresh read,
 *   because the approval has to be proven over the whole snapshot in the new session;
 * - once VERIFIED, revisions are written batch by batch behind a cursor committed with each
 *   batch: a process that dies mid-promotion leaves a VERIFIED run, which the next
 *   invocation finishes FIRST, from its staging, without the source (and, when it is the
 *   approved read, without reading the source again);
 * - revisions become visible only when their run is COMPLETED.
 *
 * Re-running the same approved read is idempotent: every invoice is UNCHANGED and nothing
 * is appended. The source is never written (READ ONLY session); no provider is contacted.
 */

export interface InvoicesReadInput {
  readonly scope: TenantContext;
  readonly actor: ActorContext;
  readonly connector: LegacySourceConnector;
  /** The approved v1 source fingerprint. Always required: the read is bound to it. */
  readonly expectedFingerprint: string;
  /** The approved invoice-archive read set fingerprint; null = digest only, nothing written. */
  readonly expectedInvoiceArchiveFingerprint: string | null;
  readonly batchSize?: number;
  /** A SYNTHETIC-marked source is refused before any write against a production-like target. */
  readonly productionLikeTarget: boolean;
}

export interface InvoicesReadOutcome {
  /** Null only when an interrupted promotion of the approved read was finished without one. */
  readonly v1: LegacyImportV1Identity | null;
  readonly fingerprintVersion: string;
  readonly fingerprint: string;
  readonly schemaHash: string | null;
  readonly synthetic: boolean;
  /** The read's exact row counts (from the read, or from the finished run). */
  readonly rows: { readonly invoice: number; readonly user: number; readonly product: number };
  /**
   * The `invoice` columns this read actually delivered and fingerprinted (the read's table
   * evidence: the required ones, then the optional ones the source HAS). Null when the outcome
   * finished an earlier run's promotion without reading: that run did not keep the list, and
   * the allowlist is not a claim about what the source had.
   */
  readonly invoiceColumnsRead: readonly string[] | null;
  /** A STAGING run an earlier process left behind, failed as ABANDONED before this read. */
  readonly abandonedRunId: string | null;
  /** A VERIFIED run an earlier process left behind, completed before this read. */
  readonly finishedEarlierRun: LegacyInvoiceArchiveRun | null;
  /** Null when nothing was written (digest only). */
  readonly written: {
    readonly run: LegacyInvoiceArchiveRun;
    readonly recorded: { readonly run: LegacyReadSetRun; readonly created: boolean };
  } | null;
}

export type InvoiceArchiveIngest = Pick<
  LegacyInvoiceArchiveService,
  'openRun' | 'startRun' | 'stageBatch' | 'verifyRun' | 'failRun' | 'promoteBatch' | 'completeRun'
>;

export interface InvoicesReadDeps {
  readonly processLock: LegacyImportProcessLock;
  readonly archive: InvoiceArchiveIngest;
  readonly recordReadSetRun: (
    scope: TenantContext,
    actor: ActorContext,
    observation: Omit<LegacyReadSetRun, 'id' | 'recordedAt' | 'codeVersion'>,
  ) => Promise<{ readonly run: LegacyReadSetRun; readonly created: boolean }>;
}

/** Why the archive refused a verified read. Carries a code, never data. */
export class InvoiceArchiveRefused extends Error {
  constructor(
    readonly code: 'STAGED_COUNT_MISMATCH' | 'SYNTHETIC_RUN_ON_PRODUCTION_TARGET',
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

/** The run failure an error during the read stands for. */
export function failureFor(error: unknown): LegacyInvoiceArchiveRunFailure {
  if (error instanceof InvoiceArchiveStagingRefused) return error.failure;
  if (error instanceof LegacySourceRefused && error.code === 'READ_SET_SNAPSHOT_DIVERGED') {
    return 'SNAPSHOT_DIVERGED';
  }
  return 'INTERRUPTED';
}

export async function readLegacyInvoiceArchive(
  deps: InvoicesReadDeps,
  input: InvoicesReadInput,
): Promise<InvoicesReadOutcome> {
  if (input.expectedInvoiceArchiveFingerprint === null) {
    return withBoundReadSetSession(
      input.connector,
      input.expectedFingerprint,
      async (session, v1) => {
        const digest = await digestInvoiceArchiveReadSet(session);
        return {
          v1,
          fingerprintVersion: digest.fingerprintVersion,
          fingerprint: digest.fingerprint,
          schemaHash: digest.schemaHash,
          synthetic: digest.synthetic,
          rows: rowsOf(digest.tables),
          invoiceColumnsRead: digest.tables['invoice']?.columns ?? [],
          abandonedRunId: null,
          finishedEarlierRun: null,
          written: null,
        };
      },
    );
  }
  const approved = input.expectedInvoiceArchiveFingerprint;
  const batchSize = input.batchSize ?? READ_SET_DEFAULT_BATCH;
  const promoteSize = Math.min(batchSize, INVOICE_ARCHIVE_PROMOTE_MAX);
  const { scope, actor } = input;

  const lease = await deps.processLock.tryAcquire(scope.tenantId);
  if (lease === null) {
    throw errors.conflict(
      LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT,
      "Another importer process holds this tenant's import claim right now. Wait for it to finish.",
    );
  }
  const live = () => {
    if (lease.isLost()) throw lostClaim();
  };
  const promoteAndComplete = async (runId: string): Promise<LegacyInvoiceArchiveRun> => {
    for (;;) {
      live();
      const step = await deps.archive.promoteBatch(scope, actor, runId, promoteSize);
      if (step.done) break;
    }
    live();
    return deps.archive.completeRun(scope, actor, runId);
  };
  const record = (run: LegacyInvoiceArchiveRun, engine: string) =>
    deps.recordReadSetRun(scope, actor, {
      readSet: INVOICE_ARCHIVE_READ_SET_NAME,
      readSetVersion: INVOICE_ARCHIVE_READ_SET_VERSION,
      fingerprintVersion: INVOICE_ARCHIVE_READ_SET.fingerprintVersion,
      readSetFingerprint: run.readSetFingerprint,
      sourceFingerprint: run.sourceFingerprint,
      sourceSchemaHash: run.sourceSchemaHash,
      sourceEngine: engine as LegacyReadSetRun['sourceEngine'],
      synthetic: run.synthetic,
      tableCount: INVOICE_ARCHIVE_READ_SET.tables.length,
      rowCount:
        (run.sourceInvoiceRows ?? 0n) + (run.sourceUserRows ?? 0n) + (run.sourceProductRows ?? 0n),
    });

  try {
    // Housekeeping first: what an earlier process left open.
    let abandonedRunId: string | null = null;
    let finishedEarlierRun: LegacyInvoiceArchiveRun | null = null;
    const open = await deps.archive.openRun(scope, actor);
    // A run left open is resumed (VERIFIED) or discarded (STAGING) from what it STORED, without
    // the source — so the evidence-class rule every write obeys is applied to the stored run
    // first: a SYNTHETIC run (a restored or promoted staging database) is never promoted,
    // completed or touched on a production-like target.
    if (open !== null) refuseSyntheticOnProduction(open, input.productionLikeTarget);
    if (open?.state === 'STAGING') {
      await deps.archive.failRun(scope, actor, open.id, 'ABANDONED');
      abandonedRunId = open.id;
    } else if (open?.state === 'VERIFIED') {
      finishedEarlierRun = await promoteAndComplete(open.id);
      if (
        finishedEarlierRun.readSetFingerprint === approved &&
        finishedEarlierRun.sourceFingerprint === input.expectedFingerprint
      ) {
        // The approved read was already verified and staged: finishing it IS this read.
        const recorded = await record(finishedEarlierRun, finishedEarlierRun.sourceEngine);
        return {
          v1: null,
          fingerprintVersion: INVOICE_ARCHIVE_READ_SET.fingerprintVersion,
          fingerprint: finishedEarlierRun.readSetFingerprint,
          schemaHash: null,
          synthetic: finishedEarlierRun.synthetic,
          rows: {
            invoice: Number(finishedEarlierRun.sourceInvoiceRows ?? 0n),
            user: Number(finishedEarlierRun.sourceUserRows ?? 0n),
            product: Number(finishedEarlierRun.sourceProductRows ?? 0n),
          },
          invoiceColumnsRead: null,
          abandonedRunId,
          finishedEarlierRun: null,
          written: { run: finishedEarlierRun, recorded },
        };
      }
    }

    const read = await withBoundReadSetSession(
      input.connector,
      input.expectedFingerprint,
      async (session, v1) => {
        const label = decideEvidenceClass({
          claim: null,
          syntheticSource: (await session.syntheticMarker()) !== null,
          productionLikeTarget: input.productionLikeTarget,
        });
        if (!label.ok) throw new LegacySourceRefused('SOURCE_UNREADABLE', label.message);
        let run: LegacyInvoiceArchiveRun | null = null;
        const start = async () =>
          deps.archive.startRun(scope, actor, {
            readSetVersion: INVOICE_ARCHIVE_READ_SET_VERSION,
            readSetFingerprint: approved,
            sourceFingerprint: v1.fingerprint,
            sourceSchemaHash: v1.schemaHash,
            sourceEngine: v1.engine,
            synthetic: v1.synthetic,
          });
        try {
          const result = await readApprovedInvoiceArchiveReadSet(session, approved, {
            batchSize,
            // Called only after pass 1 proved the read is the approved one.
            onBatch: async (batch) => {
              live();
              run ??= await start();
              await deps.archive.stageBatch(scope, actor, run.id, batch);
            },
          });
          run ??= await start();
          return { v1, result, run };
        } catch (error) {
          const started = run as LegacyInvoiceArchiveRun | null;
          if (started !== null) {
            // Best effort: if this fails too, the run stays STAGING and the next invocation
            // fails it as ABANDONED. Either way nothing of this read is archived.
            await deps.archive
              .failRun(scope, actor, started.id, failureFor(error))
              .catch(() => null);
          }
          throw error;
        }
      },
    );

    // The source session is closed and the delivery proven equal to the verified pass.
    const rows = rowsOf(read.result.tables);
    live();
    const verified = await deps.archive.verifyRun(scope, actor, read.run.id, {
      invoiceRows: rows.invoice,
      userRows: rows.user,
      productRows: rows.product,
      v1InvoiceRows: read.v1.tables.invoice.rows,
    });
    if (!verified.ok) {
      throw new InvoiceArchiveRefused(
        'STAGED_COUNT_MISMATCH',
        'the staged rows do not add up to the read; the run FAILED and nothing was archived.',
      );
    }
    const completed = await promoteAndComplete(read.run.id);
    const recorded = await record(completed, read.v1.engine);
    return {
      v1: read.v1,
      fingerprintVersion: read.result.fingerprintVersion,
      fingerprint: read.result.fingerprint,
      schemaHash: read.result.schemaHash,
      synthetic: read.result.synthetic,
      rows,
      invoiceColumnsRead: read.result.tables['invoice']?.columns ?? [],
      abandonedRunId,
      finishedEarlierRun,
      written: { run: completed, recorded },
    };
  } finally {
    await lease.release();
  }
}

/**
 * The evidence-class rule for a STORED run: a run whose read was SYNTHETIC is refused on a
 * production-like target before anything resumes it — the same refusal a synthetic SOURCE
 * gets (`decideEvidenceClass`), applied where no source is opened.
 */
export function refuseSyntheticOnProduction(
  run: Pick<LegacyInvoiceArchiveRun, 'id' | 'synthetic'>,
  productionLikeTarget: boolean,
): void {
  if (run.synthetic && productionLikeTarget) {
    throw new InvoiceArchiveRefused(
      'SYNTHETIC_RUN_ON_PRODUCTION_TARGET',
      `open invoice archive run ${run.id} was read from a SYNTHETIC source, and this target is ` +
        'production-like: it is neither resumed nor discarded here. Nothing was written. ' +
        'Investigate how a synthetic run reached this database before going on.',
    );
  }
}

function rowsOf(tables: Readonly<Record<string, { readonly rows: number }>>): {
  readonly invoice: number;
  readonly user: number;
  readonly product: number;
} {
  return {
    invoice: tables['invoice']?.rows ?? 0,
    user: tables['user']?.rows ?? 0,
    product: tables['product']?.rows ?? 0,
  };
}

function lostClaim(): Error {
  return errors.conflict(
    LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT,
    "The importer's claim on this tenant was lost mid-read. A STAGING run archives nothing; a VERIFIED one is finished by the next invoices-read.",
  );
}
