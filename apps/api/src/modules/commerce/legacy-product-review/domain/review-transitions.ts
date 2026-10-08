import {
  LEGACY_PRODUCT_REVIEW_APPROVED_STATES,
  LEGACY_PRODUCT_REVIEW_DECIDED_STATES,
  type LegacyProductReviewState,
} from '@nexa/contracts';

/**
 * Mirza migration PR2 — the review's rules about what a READ does to a row, and when a row
 * exports. Pure, so each rule is one function a test can falsify
 * (`docs/legacy-product-review-design.md` §5, §9; owner constraint 4: a changed source row is
 * detected and reported, never silently overwritten or re-approved).
 */

type DecidedState = (typeof LEGACY_PRODUCT_REVIEW_DECIDED_STATES)[number];

export function isDecided(state: LegacyProductReviewState): state is DecidedState {
  return (LEGACY_PRODUCT_REVIEW_DECIDED_STATES as readonly string[]).includes(state);
}

export function isApproved(state: LegacyProductReviewState): boolean {
  return (LEGACY_PRODUCT_REVIEW_APPROVED_STATES as readonly string[]).includes(state);
}

/** What the review holds about a code, as far as a read is concerned. */
export interface ReviewSourceState {
  readonly state: LegacyProductReviewState;
  readonly factsChecksum: string;
  readonly readFingerprint: string;
  readonly sourceFingerprint: string;
  readonly liveInvoiceCount: number;
  readonly missingSinceReadFingerprint: string | null;
}

/** What one read says about a code. */
export interface ReadObservation {
  readonly factsChecksum: string;
  readonly readFingerprint: string;
  readonly sourceFingerprint: string;
  readonly liveInvoiceCount: number;
}

export type IngestDecision =
  /** A code the review has never seen: a new PENDING_REVIEW row. */
  | { readonly kind: 'CREATE' }
  /** Exactly what is stored: nothing is written. A rerun of the same read is this. */
  | { readonly kind: 'UNCHANGED' }
  /**
   * Same facts, a different read (or the code came back): the provenance, the live count and
   * the absence mark are refreshed. The state — a decision included — is untouched.
   */
  | { readonly kind: 'TOUCH'; readonly reappeared: boolean }
  /** New facts on an undecided row (PENDING_REVIEW, SOURCE_CHANGED): replaced, state kept. */
  | { readonly kind: 'FACTS_UPDATED' }
  /** New facts on a DECIDED row: the decision stops exporting until a person decides again. */
  | { readonly kind: 'SOURCE_CHANGED'; readonly prior: DecidedState };

export function decideIngest(
  existing: ReviewSourceState | null,
  read: ReadObservation,
): IngestDecision {
  if (existing === null) return { kind: 'CREATE' };
  if (existing.factsChecksum !== read.factsChecksum) {
    return isDecided(existing.state)
      ? { kind: 'SOURCE_CHANGED', prior: existing.state }
      : { kind: 'FACTS_UPDATED' };
  }
  if (
    existing.readFingerprint === read.readFingerprint &&
    existing.sourceFingerprint === read.sourceFingerprint &&
    existing.liveInvoiceCount === read.liveInvoiceCount &&
    existing.missingSinceReadFingerprint === null
  ) {
    return { kind: 'UNCHANGED' };
  }
  return { kind: 'TOUCH', reappeared: existing.missingSinceReadFingerprint !== null };
}

export type AbsenceDecision =
  /** This read already recorded the absence: nothing to write. */
  | { readonly kind: 'NONE' }
  /** Undecided and present until now: marked absent, state kept. */
  | { readonly kind: 'MARK_MISSING' }
  /**
   * Absent in an earlier read and STILL absent in this one: the mark moves to this read, state
   * kept. Without it a code that stays gone pins the review to the read that first missed it,
   * and no later read could ever be exported (Codex review of #231, P1).
   */
  | { readonly kind: 'STILL_ABSENT' }
  /** Decided: a code that vanished from the source is a changed source. */
  | { readonly kind: 'SOURCE_CHANGED'; readonly prior: DecidedState };

/** A completed read (`readFingerprint`) did not contain this code. */
export function decideAbsence(
  existing: ReviewSourceState,
  readFingerprint: string,
): AbsenceDecision {
  if (existing.missingSinceReadFingerprint === readFingerprint) return { kind: 'NONE' };
  if (existing.missingSinceReadFingerprint !== null) return { kind: 'STILL_ABSENT' };
  return isDecided(existing.state)
    ? { kind: 'SOURCE_CHANGED', prior: existing.state }
    : { kind: 'MARK_MISSING' };
}

/** What `products-export` needs to know about a row. */
export interface ExportCandidate {
  readonly state: LegacyProductReviewState;
  readonly factsChecksum: string;
  readonly approvedFactsChecksum: string | null;
  readonly approvedProductId: string | null;
  readonly readFingerprint: string;
  readonly missingSinceReadFingerprint: string | null;
  readonly sourceConflict: string | null;
}

/**
 * Whether a row exports under the products read fingerprint `readFingerprint`: approved,
 * approved against the facts it holds NOW, seen by THAT read, present in it, and not a
 * conflicted code. Everything else stays `PRODUCT_MAPPING_UNRESOLVED` for the importer.
 */
export function isExportable(row: ExportCandidate, readFingerprint: string): boolean {
  return (
    isApproved(row.state) &&
    row.approvedProductId !== null &&
    row.approvedFactsChecksum !== null &&
    row.approvedFactsChecksum === row.factsChecksum &&
    row.readFingerprint === readFingerprint &&
    row.missingSinceReadFingerprint === null &&
    row.sourceConflict === null
  );
}
