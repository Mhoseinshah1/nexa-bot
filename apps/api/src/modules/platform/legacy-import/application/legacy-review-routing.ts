import type { LegacyReviewReasonCode } from '@nexa/contracts';
import type { LegacyImportDecision } from './legacy-import-ports.js';
import type { LegacyMatchReason, LegacyServiceMatch } from './legacy-service-matching.js';

/**
 * Item 9 — the one translation from the P5 matcher's outcome to the map decision the
 * importer records, so no ambiguous row is guessed or dropped (program §10, §13).
 *
 * - `ELIGIBLE` → `null`: the caller adopts (P6) and records `IMPORTED` with what it created.
 * - `MANUAL_REVIEW` → `MANUAL_REVIEW` with the matcher's reason, unchanged.
 * - `SKIPPED` (test panel) → `SKIPPED / TEST_PANEL`.
 * - `NO_PANEL` (owner decision 8: `code_panel` empty or NULL) → `MANUAL_REVIEW /
 *   PANEL_UNMAPPED`: there is no mapped panel for it, and none is searched for. The
 *   candidate's own outcome says `NO_PANEL`; the map keeps its closed review vocabulary.
 * - `INVALID` (a username the matcher will not compare) → `MANUAL_REVIEW /
 *   INVALID_SOURCE_ROW`: a person looks at it; it is not silently dropped.
 * - `UNDECIDABLE` (an incomplete inventory) → `MANUAL_REVIEW / INVENTORY_INCOMPLETE`. Never
 *   "missing": zero matches in a partial walk proves nothing. The row stays OPEN, so the
 *   next run — with a complete inventory — decides it again.
 */
export function decisionForLegacyMatch(match: LegacyServiceMatch): LegacyImportDecision | null {
  switch (match.kind) {
    case 'ELIGIBLE':
      return null;
    case 'MANUAL_REVIEW':
      return { status: 'MANUAL_REVIEW', reasonCode: reviewReasonOf(match.reason) };
    case 'SKIPPED':
      return { status: 'SKIPPED', reasonCode: 'TEST_PANEL' };
    case 'NO_PANEL':
      return { status: 'MANUAL_REVIEW', reasonCode: 'PANEL_UNMAPPED' };
    case 'INVALID':
      return { status: 'MANUAL_REVIEW', reasonCode: 'INVALID_SOURCE_ROW' };
    case 'UNDECIDABLE':
      return { status: 'MANUAL_REVIEW', reasonCode: 'INVENTORY_INCOMPLETE' };
  }
}

/** Compile-time: every matcher reason IS a review reason (a new one fails the build here). */
function reviewReasonOf(reason: LegacyMatchReason): LegacyReviewReasonCode {
  return reason;
}
