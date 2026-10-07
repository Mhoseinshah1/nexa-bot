import {
  errors,
  LEGACY_IMPORT_ERROR_CODES,
  type ActorContext,
  type TenantContext,
} from '@nexa/contracts';
import {
  emptyIngestCounts,
  type LegacyProductIngestCounts,
  type LegacyProductReviewService,
} from '../../../commerce/legacy-product-review/application/legacy-product-review.service.js';
import type { LegacyImportProcessLock, LegacyReadSetRun } from './ports.js';
import {
  PRODUCTS_READ_SET,
  PRODUCTS_READ_SET_NAME,
  PRODUCTS_READ_SET_VERSION,
  ProductObservationAssembler,
  digestProductsReadSet,
  liveInvoiceCountsByCode,
  readApprovedProductsReadSet,
  type ProductRowsSkipped,
} from './products-read-set.js';
import { READ_SET_DEFAULT_BATCH, withBoundReadSetSession } from './read-set.js';
import { LegacySourceRefused, type LegacySourceConnector } from './source-port.js';
import { decideEvidenceClass } from './production-guard.js';
import type { LegacyImportV1Identity } from './source-snapshot.js';

/**
 * Mirza migration PR2 — `legacy-import products-read`: the `products` read set into the
 * legacy product review (`docs/legacy-product-review-design.md` §7).
 *
 * Two steps, two approvals, and nothing written before both hold:
 *
 * 1. Without `expectedProductsFingerprint`: ONE read-only session bound to the approved v1
 *    source (`--expected-fingerprint`, refused on a mismatch) digests the products read set
 *    and returns its fingerprint for the owner to approve. Nothing is written anywhere.
 * 2. With it: the importer's per-tenant claim is taken (a products read never runs beside an
 *    import or another products read), the same kind of bound session digests the read set
 *    AGAIN, refuses unless it equals the approval, and only then delivers the rows in
 *    batches — each batch ONE transaction through the review service. After the last batch,
 *    every code the read did not contain is marked absent, and the read set run is recorded
 *    in `legacy_read_set_runs`. A rerun of the same read writes nothing new.
 *
 * The source is never written (READ ONLY session); no provider is contacted.
 */

export interface ProductsReadInput {
  readonly scope: TenantContext;
  readonly actor: ActorContext;
  readonly connector: LegacySourceConnector;
  /** The approved v1 source fingerprint. Always required: the read is bound to it. */
  readonly expectedFingerprint: string;
  /** The approved products read set fingerprint; null = digest only, nothing written. */
  readonly expectedProductsFingerprint: string | null;
  readonly batchSize?: number;
  /**
   * Whether the target is production-like: a SYNTHETIC-marked source is then refused before
   * any write (the evidence-class rule every mode follows).
   */
  readonly productionLikeTarget: boolean;
}

export interface ProductsReadOutcome {
  readonly v1: LegacyImportV1Identity;
  readonly fingerprintVersion: string;
  readonly fingerprint: string;
  readonly schemaHash: string;
  readonly synthetic: boolean;
  /** Rows of the legacy `product` table in the snapshot. */
  readonly productRows: number;
  /** Null when nothing was written (digest only). */
  readonly written: {
    readonly counts: LegacyProductIngestCounts;
    readonly skipped: ProductRowsSkipped;
    readonly recorded: { readonly run: LegacyReadSetRun; readonly created: boolean };
  } | null;
}

export interface ProductsReadDeps {
  readonly processLock: LegacyImportProcessLock;
  readonly review: Pick<LegacyProductReviewService, 'ingestBatch' | 'markAbsent'>;
  readonly recordReadSetRun: (
    scope: TenantContext,
    actor: ActorContext,
    observation: Omit<LegacyReadSetRun, 'id' | 'recordedAt' | 'codeVersion'>,
  ) => Promise<{ readonly run: LegacyReadSetRun; readonly created: boolean }>;
}

export async function readLegacyProducts(
  deps: ProductsReadDeps,
  input: ProductsReadInput,
): Promise<ProductsReadOutcome> {
  if (input.expectedProductsFingerprint === null) {
    return withBoundReadSetSession(
      input.connector,
      input.expectedFingerprint,
      async (session, v1) => {
        const digest = await digestProductsReadSet(session);
        return {
          v1,
          fingerprintVersion: digest.fingerprintVersion,
          fingerprint: digest.fingerprint,
          schemaHash: digest.schemaHash,
          synthetic: digest.synthetic,
          productRows: digest.tables['product']?.rows ?? 0,
          written: null,
        };
      },
    );
  }
  const approvedProducts = input.expectedProductsFingerprint;
  const batchSize = input.batchSize ?? READ_SET_DEFAULT_BATCH;

  const lease = await deps.processLock.tryAcquire(input.scope.tenantId);
  if (lease === null) {
    throw errors.conflict(
      LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT,
      "Another importer process holds this tenant's import claim right now. Wait for it to finish.",
    );
  }
  try {
    const counts = emptyIngestCounts();
    const add = (more: LegacyProductIngestCounts) => {
      for (const key of Object.keys(counts) as (keyof LegacyProductIngestCounts)[]) {
        counts[key] += more[key];
      }
    };
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
        const liveCounts = await liveInvoiceCountsByCode(session);
        const assembler = new ProductObservationAssembler(liveCounts);
        const result = await readApprovedProductsReadSet(session, approvedProducts, {
          batchSize,
          onBatch: (batch) => assembler.take(batch),
        });
        return { v1, result, skipped: assembler.skipped, observations: assembler.finish() };
      },
    );
    // The legacy session is closed and the delivered read verified: only now is anything
    // written, one transaction per batch of codes. A rerun after a crash is idempotent.
    const target = {
      readSetFingerprint: read.result.fingerprint,
      sourceFingerprint: read.v1.fingerprint,
    };
    for (let i = 0; i < read.observations.length; i += batchSize) {
      if (lease.isLost()) throw lostClaim();
      add(
        await deps.review.ingestBatch(
          input.scope,
          input.actor,
          target,
          read.observations.slice(i, i + batchSize),
        ),
      );
    }
    if (lease.isLost()) throw lostClaim();
    add(
      await deps.review.markAbsent(input.scope, input.actor, {
        readSetFingerprint: read.result.fingerprint,
        sourceFingerprint: read.v1.fingerprint,
      }),
    );
    const productRows = read.result.tables['product']?.rows ?? 0;
    const recorded = await deps.recordReadSetRun(input.scope, input.actor, {
      readSet: PRODUCTS_READ_SET_NAME,
      readSetVersion: PRODUCTS_READ_SET_VERSION,
      fingerprintVersion: PRODUCTS_READ_SET.fingerprintVersion,
      readSetFingerprint: read.result.fingerprint,
      sourceFingerprint: read.v1.fingerprint,
      sourceSchemaHash: read.v1.schemaHash,
      sourceEngine: read.v1.engine,
      synthetic: read.result.synthetic,
      tableCount: PRODUCTS_READ_SET.tables.length,
      rowCount: BigInt(productRows),
    });
    return {
      v1: read.v1,
      fingerprintVersion: read.result.fingerprintVersion,
      fingerprint: read.result.fingerprint,
      schemaHash: read.result.schemaHash,
      synthetic: read.result.synthetic,
      productRows,
      written: { counts, skipped: read.skipped, recorded },
    };
  } finally {
    await lease.release();
  }
}

function lostClaim(): Error {
  return errors.conflict(
    LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT,
    "The importer's claim on this tenant was lost mid-read; nothing after the last committed batch was written. Run products-read again.",
  );
}
