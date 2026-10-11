import { sha256Hex } from './source-snapshot.js';

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
 * - with or without one: every record whose `ownership_decision` is not proven by evidence
 *   (`CONFIRMED_CURRENT_OWNER`, `CONFIRMED_TRANSFER`, `NO_CONFLICT`) — the `AMBIGUOUS_*` and
 *   orphan states stay quarantined, as the converter's design requires;
 * - a PROVEN record whose proven final owner is not the invoice's `id_user`: NEXA adopts onto
 *   `id_user` only, so a proof about somebody else is no proof for that adoption;
 * - a live invoice the package has no ownership record for.
 *
 * The two sources only ever ADD to each other: held = decisionHold(entry) ∪ baselineHold(record),
 * where the baseline is the package's own evidence (not proven, or proven for another owner,
 * or no record) and applies WITH a decisions file as much as without one.
 *
 * `ADMIN_APPROVED_UNVERIFIED` is never promoted and never REMOVES a hold: an attested invoice
 * whose record the evidence does not prove stays held. Only when the evidence itself proves
 * the record for `invoice.id_user` is it left to NEXA's own rules. Either way it is reported
 * separately as `ADMIN_ATTESTATION` (`attested`), never counted as proven.
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
  /**
   * Invoice keys an admin attested (ADMIN_ATTESTATION), for reporting. An attested key may
   * also be in `hold` (the attestation never removes a hold); it is never in `proven`.
   */
  readonly attested: ReadonlySet<string>;
  /** Invoice keys proven by the converter's evidence and agreeing with `id_user`. */
  readonly proven: ReadonlySet<string>;
  /** Counts per reason, one reason per held invoice (Σ = |hold|). No key, no owner. */
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

  for (const invoice of input.liveInvoices) {
    const key = invoice.idInvoice;
    const records = byInvoice.get(key) ?? [];
    // Two records for one invoice is two answers to one question: neither is taken.
    const record = records.length === 1 ? records[0] : undefined;
    let why: NxpkgOwnershipHoldReason | null;
    if (record === undefined) {
      why = 'NO_OWNERSHIP_RECORD';
    } else {
      // held = decisionHold(entry) ∪ baselineHold(record). A decision can only ADD a hold:
      // the admin's attestation never removes one the package's own evidence puts in place.
      const entry = input.decisions?.entries.get(record.key);
      if (entry?.class === 'ADMIN_APPROVED_UNVERIFIED') attested.add(key);
      why = decisionHold(input.decisions, entry) ?? baselineHold(record, invoice.idUser);
      if (why === null && entry?.class !== 'ADMIN_APPROVED_UNVERIFIED') proven.add(key);
    }
    if (why !== null) {
      hold.add(key);
      // One reason per held invoice (the decision's first), so Σ reasons = |hold|.
      reasons[why] = (reasons[why] ?? 0) + 1;
    }
  }
  return { hold, attested, proven, reasons };
}

/**
 * The hold the verified decisions file puts on one record, or null. A file that does not
 * cover a record (verification refuses one; never reached) holds it as PENDING.
 */
function decisionHold(
  decisions: VerifiedOwnershipDecisions | null,
  entry: NxpkgOwnershipEntry | undefined,
): NxpkgOwnershipHoldReason | null {
  if (decisions === null) return null;
  if (entry === undefined) return 'DECISION_PENDING';
  if (entry.stale) return 'DECISION_STALE';
  return HELD_CLASS[entry.class] ?? null;
}

/**
 * The hold the package's own evidence puts on one record, whatever any decision says: not
 * proven by evidence, or proven for somebody other than the invoice's `id_user` (NEXA adopts
 * onto `id_user` only, so a proof about somebody else is no proof for that adoption).
 */
function baselineHold(
  record: NxpkgOwnershipRecordFacts,
  idUser: string | null,
): NxpkgOwnershipHoldReason | null {
  if (record.decision === null || !NXPKG_PROVEN_OWNERSHIP_DECISIONS.has(record.decision)) {
    return 'OWNERSHIP_NOT_PROVEN';
  }
  if (record.finalOwner === null || record.finalOwner !== idUser) {
    return 'PROVEN_OWNER_IS_NOT_INVOICE_OWNER';
  }
  return null;
}

/**
 * What binds a run to its hold (`legacy_import_run_inputs.ownership_hold_digest`): SHA-256 of
 * the sorted held invoice keys and the decisions file's `entries_digest` (or `none`). Recorded
 * when a run starts; a resume, reconcile or report under any other hold is refused.
 */
export function ownershipHoldDigest(
  hold: ReadonlySet<string>,
  decisionsDigest: string | null,
): string {
  const keys = [...hold].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(
    JSON.stringify({
      format: 'nexa-nxpkg-ownership-hold/v1',
      hold: keys,
      decisions: decisionsDigest ?? 'none',
    }),
  );
}
