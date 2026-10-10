/**
 * Mirza `.nxpkg` importer — what the converter's ownership evidence means for adoption
 * (`docs/legacy-migration/nxpkg-importer.md` §7; converter `NEXA_IMPORTER_DESIGN.md` §8, §8.1).
 *
 * Nothing here recomputes ownership. NEXA's importer decides every live invoice exactly as it
 * always does (`decideServiceCandidate`, the ownership rule, P6's own checks, the owner being
 * `invoice.id_user`). The package's evidence can only REMOVE an invoice from automatic
 * adoption, never add one: the result is a HOLD set of invoice keys the importer turns into
 * `AMBIGUOUS_OWNERSHIP` manual review (`decideAllServices`, `ServiceReviewInputs.ownershipHold`)
 * — a map row `MANUAL_REVIEW`, a candidate row a person can still look at, and no service.
 *
 * Held (fail closed):
 *
 * - with a verified `ownership-decisions.json`: every `QUARANTINED`, `REJECTED` or `PENDING`
 *   entry, and every `stale` one, whatever its class;
 * - without one: every record whose `ownership_decision` is not proven by evidence
 *   (`CONFIRMED_CURRENT_OWNER`, `CONFIRMED_TRANSFER`, `NO_CONFLICT`) — the `AMBIGUOUS_*` and
 *   orphan states stay quarantined, as the converter's design requires;
 * - a PROVEN record whose proven final owner is not the invoice's `id_user`: NEXA adopts onto
 *   `id_user` only, so a proof about somebody else is no proof for that adoption;
 * - a live invoice the package has no ownership record for.
 *
 * `ADMIN_APPROVED_UNVERIFIED` is NOT held and NOT promoted: it keeps NEXA's own rules (owner =
 * `invoice.id_user`, as the attestation itself says), and is reported separately as
 * `ADMIN_ATTESTATION`, never counted as proven.
 */

export const NXPKG_OWNERSHIP_CLASSES = [
  'PROVEN',
  'ADMIN_APPROVED_UNVERIFIED',
  'PENDING',
  'REJECTED',
  'QUARANTINED',
] as const;
export type NxpkgOwnershipClass = (typeof NXPKG_OWNERSHIP_CLASSES)[number];

/** `BASIS` of the converter's `ownership_review.py`: one per class, never mixed. */
export const NXPKG_OWNERSHIP_BASIS: Readonly<Record<NxpkgOwnershipClass, string>> = {
  PROVEN: 'EVIDENCE',
  ADMIN_APPROVED_UNVERIFIED: 'ADMIN_ATTESTATION',
  PENDING: 'NONE',
  REJECTED: 'ADMIN_REJECTION',
  QUARANTINED: 'SYSTEM_QUARANTINE',
};

/** `PROVEN_DECISIONS` of the converter: ownership proven by evidence, without a person. */
export const NXPKG_PROVEN_OWNERSHIP_DECISIONS: ReadonlySet<string> = new Set([
  'CONFIRMED_CURRENT_OWNER',
  'CONFIRMED_TRANSFER',
  'NO_CONFLICT',
]);

export interface NxpkgOwnershipEntry {
  /** The ownership record's `idempotency_key`. */
  readonly key: string;
  readonly invoiceKey: string | null;
  readonly class: NxpkgOwnershipClass;
  readonly basis: string;
  readonly batchId: string | null;
  readonly stale: boolean;
}

export interface NxpkgOwnershipSummary {
  readonly items: number;
  readonly PROVEN: number;
  readonly ADMIN_APPROVED_UNVERIFIED: number;
  readonly PENDING: number;
  readonly REJECTED: number;
  readonly QUARANTINED: number;
  readonly stale: number;
}

/** A verified `ownership-decisions.json` (`infrastructure/nxpkg-ownership-decisions.ts`). */
export interface VerifiedOwnershipDecisions {
  readonly summary: NxpkgOwnershipSummary;
  /** `entries_digest` = `sealed_digest`: what an audit row and a dry-run digest may cite. */
  readonly entriesDigest: string;
  readonly auditHead: string | null;
  /** By ownership record key. */
  readonly entries: ReadonlyMap<string, NxpkgOwnershipEntry>;
}

/** What the hold needs of one `records/service_ownership.jsonl` record. */
export interface NxpkgOwnershipRecordFacts {
  readonly key: string;
  readonly invoiceKey: string | null;
  readonly decision: string | null;
  readonly finalOwner: string | null;
}

export type NxpkgOwnershipHoldReason =
  | 'DECISION_QUARANTINED'
  | 'DECISION_REJECTED'
  | 'DECISION_PENDING'
  | 'DECISION_STALE'
  | 'OWNERSHIP_NOT_PROVEN'
  | 'PROVEN_OWNER_IS_NOT_INVOICE_OWNER'
  | 'NO_OWNERSHIP_RECORD';

export interface NxpkgOwnershipHold {
  /** Invoice keys never adopted automatically (`LegacyImportInput.ownershipHold`). */
  readonly hold: ReadonlySet<string>;
  /** Invoice keys an admin attested (ADMIN_ATTESTATION): adopted only by NEXA's own rules. */
  readonly attested: ReadonlySet<string>;
  /** Invoice keys proven by the converter's evidence and agreeing with `id_user`. */
  readonly proven: ReadonlySet<string>;
  /** Counts per reason. No key, no owner. */
  readonly reasons: Readonly<Partial<Record<NxpkgOwnershipHoldReason, number>>>;
}

const HELD_CLASS: Readonly<Partial<Record<NxpkgOwnershipClass, NxpkgOwnershipHoldReason>>> = {
  QUARANTINED: 'DECISION_QUARANTINED',
  REJECTED: 'DECISION_REJECTED',
  PENDING: 'DECISION_PENDING',
};

/**
 * The hold over the importer's LIVE invoices (`snapshot.liveInvoices`). `decisions` must have
 * been verified against the same package `records` came from.
 */
export function nxpkgOwnershipHold(input: {
  readonly records: readonly NxpkgOwnershipRecordFacts[];
  readonly decisions: VerifiedOwnershipDecisions | null;
  readonly liveInvoices: readonly { readonly idInvoice: string; readonly idUser: string | null }[];
}): NxpkgOwnershipHold {
  const byInvoice = new Map<string, NxpkgOwnershipRecordFacts[]>();
  for (const r of input.records) {
    if (r.invoiceKey === null) continue;
    byInvoice.set(r.invoiceKey, [...(byInvoice.get(r.invoiceKey) ?? []), r]);
  }
  const hold = new Set<string>();
  const attested = new Set<string>();
  const proven = new Set<string>();
  const reasons: Partial<Record<NxpkgOwnershipHoldReason, number>> = {};
  const held = (key: string, why: NxpkgOwnershipHoldReason) => {
    hold.add(key);
    reasons[why] = (reasons[why] ?? 0) + 1;
  };

  for (const invoice of input.liveInvoices) {
    const key = invoice.idInvoice;
    const records = byInvoice.get(key) ?? [];
    // Two records for one invoice is two answers to one question: neither is taken.
    const record = records.length === 1 ? records[0] : undefined;
    if (record === undefined) {
      held(key, 'NO_OWNERSHIP_RECORD');
      continue;
    }
    let provenByEvidence: boolean;
    if (input.decisions !== null) {
      const entry = input.decisions.entries.get(record.key);
      if (entry === undefined) {
        // Verification refuses a file that does not cover every record; never reached.
        held(key, 'DECISION_PENDING');
        continue;
      }
      if (entry.stale) {
        held(key, 'DECISION_STALE');
        continue;
      }
      const why = HELD_CLASS[entry.class];
      if (why !== undefined) {
        held(key, why);
        continue;
      }
      if (entry.class === 'ADMIN_APPROVED_UNVERIFIED') {
        attested.add(key);
        continue;
      }
      provenByEvidence = true;
    } else {
      provenByEvidence =
        record.decision !== null && NXPKG_PROVEN_OWNERSHIP_DECISIONS.has(record.decision);
      if (!provenByEvidence) {
        held(key, 'OWNERSHIP_NOT_PROVEN');
        continue;
      }
    }
    if (provenByEvidence) {
      if (record.finalOwner === null || record.finalOwner !== invoice.idUser) {
        held(key, 'PROVEN_OWNER_IS_NOT_INVOICE_OWNER');
        continue;
      }
      proven.add(key);
    }
  }
  return { hold, attested, proven, reasons };
}
