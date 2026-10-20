import {
  LEGACY_IMPORT_ERROR_CODES,
  errors,
  type ActorContext,
  type TenantContext,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { LegacyCustomerWriter, LegacyImportProcessLock } from './ports.js';
import { decideEvidenceClass } from './production-guard.js';
import {
  READ_SET_DEFAULT_BATCH,
  USER_TERMS_READ_SET,
  legacyRulesAccepted,
  readLegacyReadSet,
  withBoundReadSetSession,
} from './read-set.js';
import { LegacySourceRefused, type LegacySourceConnector } from './source-port.js';
import type { LegacyImportV1Identity } from './source-snapshot.js';

/**
 * R4 A4 — `legacy-import terms-backfill`: for an installation imported BEFORE the import
 * carried the previous bot's rules acceptance, records it now, from the same approved source.
 *
 * The products-read shape, for the same reasons:
 *
 * 1. Without `expectedTermsFingerprint`: a read-only session bound to the approved v1
 *    fingerprint digests the `user-terms` read set and prints its fingerprint for approval.
 *    Nothing is written.
 * 2. With it: the importer's per-tenant claim is taken (never beside an import), the bound
 *    session delivers the read set only once it is proven to be the approved one, and the
 *    users whose `roll_Status` is true are marked in batches — each batch ONE transaction,
 *    a conditional UPDATE through `legacy_import_map` (`legacy_terms_accepted_at IS NULL`).
 *
 * Idempotent and resumable by construction: a rerun, or a run after a crash, marks only the
 * customers not marked yet. Nothing else is touched — no status, no wallet, no service — and
 * nothing is sent: it writes one timestamp column and one audit row per batch, never an
 * outbox event. The source is never written; no provider is contacted.
 */

export interface TermsBackfillInput {
  readonly scope: TenantContext;
  readonly actor: ActorContext;
  readonly connector: LegacySourceConnector;
  /** The approved v1 source fingerprint. Always required: the read is bound to it. */
  readonly expectedFingerprint: string;
  /** The approved `user-terms` read set fingerprint; null = digest only, nothing written. */
  readonly expectedTermsFingerprint: string | null;
  readonly batchSize?: number;
  readonly productionLikeTarget: boolean;
}

export interface TermsBackfillOutcome {
  readonly v1: LegacyImportV1Identity;
  readonly fingerprintVersion: string;
  readonly fingerprint: string;
  readonly synthetic: boolean;
  /** Rows of the legacy `user` table in the snapshot. */
  readonly userRows: number;
  /** Whether the source has `user.roll_Status` at all. Without it nobody is accepted. */
  readonly columnPresent: boolean;
  /** Null when nothing was written (digest only). */
  readonly written: {
    /** Users the source says accepted. */
    readonly accepted: number;
    /** Customers marked by THIS run (0 on a rerun). */
    readonly marked: number;
  } | null;
}

export interface TermsBackfillDeps {
  readonly processLock: LegacyImportProcessLock;
  readonly customers: Pick<LegacyCustomerWriter, 'markLegacyTermsAccepted'>;
  /** One authorised, scope-checked, audited transaction (`LegacyImporterService.mutate`). */
  readonly mutate: <T>(
    scope: TenantContext,
    actor: ActorContext,
    action: string,
    entityId: string,
    fn: (tx: TransactionScope) => Promise<T>,
  ) => Promise<T>;
  readonly audit: (
    scope: TenantContext,
    actor: ActorContext,
    after: Record<string, unknown>,
    tx: TransactionScope,
  ) => Promise<void>;
  readonly now: () => Date;
}

export async function backfillLegacyTerms(
  deps: TermsBackfillDeps,
  input: TermsBackfillInput,
): Promise<TermsBackfillOutcome> {
  if (input.expectedTermsFingerprint === null) {
    return withBoundReadSetSession(
      input.connector,
      input.expectedFingerprint,
      async (session, v1) => {
        const digest = await readLegacyReadSet(session, USER_TERMS_READ_SET);
        const user = digest.tables['user'];
        return {
          v1,
          fingerprintVersion: digest.fingerprintVersion,
          fingerprint: digest.fingerprint,
          synthetic: digest.synthetic,
          userRows: user?.rows ?? 0,
          columnPresent: user?.columns.includes('roll_Status') ?? false,
          written: null,
        };
      },
    );
  }
  const approved = input.expectedTermsFingerprint;
  const batchSize = input.batchSize ?? READ_SET_DEFAULT_BATCH;
  const lease = await deps.processLock.tryAcquire(input.scope.tenantId);
  if (lease === null) {
    throw errors.conflict(
      LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT,
      "Another importer process holds this tenant's import claim right now. Wait for it to finish.",
    );
  }
  try {
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
        const accepted: string[] = [];
        const result = await readLegacyReadSet(session, USER_TERMS_READ_SET, {
          batchSize,
          expectedFingerprint: approved,
          onBatch: (batch) => {
            for (const row of batch.rows) {
              const id = row[0] ?? null;
              if (id !== null && legacyRulesAccepted(row[1] ?? null)) accepted.push(id);
            }
          },
        });
        return { v1, result, accepted };
      },
    );
    // The legacy session is closed and the delivered read verified: only now is anything
    // written, one transaction per batch.
    let marked = 0;
    for (let i = 0; i < read.accepted.length; i += batchSize) {
      if (lease.isLost()) {
        throw errors.conflict(
          LEGACY_IMPORT_ERROR_CODES.RUN_CONFLICT,
          "The importer's claim on this tenant was lost; nothing more was written. Run it again.",
        );
      }
      const chunk = read.accepted.slice(i, i + batchSize);
      marked += await deps.mutate(
        input.scope,
        input.actor,
        'legacy_import.terms_backfill',
        read.result.fingerprint,
        async (tx) => {
          const count = await deps.customers.markLegacyTermsAccepted(
            input.scope,
            chunk,
            deps.now(),
            tx,
          );
          await deps.audit(
            input.scope,
            input.actor,
            {
              readSetFingerprint: read.result.fingerprint,
              sourceFingerprint: read.v1.fingerprint,
              batchUsers: chunk.length,
              marked: count,
            },
            tx,
          );
          return count;
        },
      );
    }
    const user = read.result.tables['user'];
    return {
      v1: read.v1,
      fingerprintVersion: read.result.fingerprintVersion,
      fingerprint: read.result.fingerprint,
      synthetic: read.result.synthetic,
      userRows: user?.rows ?? 0,
      columnPresent: user?.columns.includes('roll_Status') ?? false,
      written: { accepted: read.accepted.length, marked },
    };
  } finally {
    await lease.release();
  }
}
