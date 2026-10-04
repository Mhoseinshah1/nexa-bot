import { describe, expect, it } from 'vitest';
import {
  LEGACY_IMPORT_REASON_CODES,
  LEGACY_REVIEW_REASON_CODES,
  LEGACY_REVIEW_RESOLUTION_CODES,
  LEGACY_REVIEW_RESOLUTION_STATE,
  LEGACY_REVIEW_RETRY_RESOLUTIONS,
  type LegacyReviewResolutionCode,
  type LegacyReviewState,
} from '@nexa/contracts';
import {
  decideMapWrite,
  isReviewClosedToRerun,
  resumeDecision,
  reviewAfterWrite,
  type LegacyImportDecision,
} from '../../apps/api/src/modules/platform/legacy-import/application/legacy-import-ports';
import { decisionForLegacyMatch } from '../../apps/api/src/modules/platform/legacy-import/application/legacy-review-routing';

/**
 * Program 4 Item 9 — the pure rules of the Manual Review Queue: the closed reason set, the
 * resolution vocabulary, what a rerun may do to a reviewed row, and how a P5 match outcome
 * becomes a map decision (`docs/legacy-import-metadata.md` § Manual review queue).
 */

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const E1 = '00000000-0000-4000-8000-000000000001';

const reviewRow = (
  reviewState: LegacyReviewState,
  reviewResolutionCode: LegacyReviewResolutionCode | null = null,
) => ({
  status: 'MANUAL_REVIEW' as const,
  checksum: A,
  entityType: null,
  entityId: null,
  reasonCode: 'PROVIDER_MISSING' as const,
  reviewState,
  reviewResolutionCode,
});

const same: LegacyImportDecision = { status: 'MANUAL_REVIEW', reasonCode: 'PROVIDER_MISSING' };
const imported: LegacyImportDecision = {
  status: 'IMPORTED',
  entityType: 'SERVICE',
  entityId: E1,
  reasonCode: null,
};
const others: LegacyImportDecision[] = [
  imported,
  { status: 'MANUAL_REVIEW', reasonCode: 'AMBIGUOUS_PANEL' },
  { status: 'SKIPPED', reasonCode: 'TEST_PANEL' },
  { status: 'FAILED', reasonCode: 'INTERNAL_ERROR' },
];

describe('the closed review vocabulary', () => {
  it("covers the program's list, one code each, all inside the map's reason set", () => {
    // Program §13 spelling → code.
    const program: Record<string, string> = {
      provider_missing: 'PROVIDER_MISSING',
      ambiguous_panel: 'AMBIGUOUS_PANEL',
      username_case_collision: 'USERNAME_CASE_COLLISION',
      panel_mapping_missing: 'PANEL_UNMAPPED',
      inventory_incomplete: 'INVENTORY_INCOMPLETE',
      customer_missing: 'CUSTOMER_MISSING',
      product_mapping_unresolved: 'PRODUCT_MAPPING_UNRESOLVED',
      subscription_ref_blocked: 'SUBSCRIPTION_REF_BLOCKED',
      invalid_phone: 'INVALID_PHONE',
      conflicting_existing_entity: 'CONFLICTING_EXISTING_ENTITY',
      unsupported_shape: 'UNSUPPORTED_SHAPE',
    };
    for (const code of Object.values(program)) {
      expect(LEGACY_REVIEW_REASON_CODES as readonly string[]).toContain(code);
    }
    for (const code of LEGACY_REVIEW_REASON_CODES) {
      expect(LEGACY_IMPORT_REASON_CODES as readonly string[]).toContain(code);
    }
    expect(new Set(LEGACY_REVIEW_REASON_CODES).size).toBe(LEGACY_REVIEW_REASON_CODES.length);
  });

  it('keeps warnings, skips and retryable failures out of review', () => {
    for (const code of [
      'EXISTING_CUSTOMER',
      'NEGATIVE_BALANCE',
      'TEST_PANEL',
      'HISTORY_NOT_IMPORTED',
      'PROVIDER_READ_FAILED',
      'INTERNAL_ERROR',
    ]) {
      expect(LEGACY_REVIEW_REASON_CODES as readonly string[]).not.toContain(code);
    }
  });

  it('gives every resolution exactly one closed state, and only RETRY_AFTER_FIX retries', () => {
    for (const code of LEGACY_REVIEW_RESOLUTION_CODES) {
      expect(['RESOLVED', 'DISMISSED']).toContain(LEGACY_REVIEW_RESOLUTION_STATE[code]);
    }
    expect([...LEGACY_REVIEW_RETRY_RESOLUTIONS]).toEqual(['RETRY_AFTER_FIX']);
    expect(LEGACY_REVIEW_RESOLUTION_STATE.RETRY_AFTER_FIX).toBe('RESOLVED');
  });
});

describe('a rerun against a reviewed row (decideMapWrite)', () => {
  it('an OPEN review behaves as before: identical is UNCHANGED, anything else UPDATE', () => {
    expect(decideMapWrite(reviewRow('OPEN'), { checksum: A, decision: same })).toBe('UNCHANGED');
    for (const decision of others) {
      expect(decideMapWrite(reviewRow('OPEN'), { checksum: A, decision })).toBe('UPDATE');
    }
    expect(decideMapWrite(reviewRow('OPEN'), { checksum: B, decision: same })).toBe('UPDATE');
  });

  it('a DISMISSED review refuses every change, source drift included, and replays as UNCHANGED', () => {
    for (const code of ['WILL_NOT_IMPORT', 'TEST_OR_INVALID_DATA', 'DUPLICATE_RECORD'] as const) {
      const row = reviewRow('DISMISSED', code);
      for (const decision of others) {
        expect(decideMapWrite(row, { checksum: A, decision })).toBe('REVIEW_CLOSED');
      }
      expect(decideMapWrite(row, { checksum: B, decision: same })).toBe('REVIEW_CLOSED');
      expect(decideMapWrite(row, { checksum: A, decision: same })).toBe('UNCHANGED');
    }
  });

  it('HANDLED_OUTSIDE_IMPORT is closed to reruns exactly like a dismissal', () => {
    const row = reviewRow('RESOLVED', 'HANDLED_OUTSIDE_IMPORT');
    for (const decision of others) {
      expect(decideMapWrite(row, { checksum: A, decision })).toBe('REVIEW_CLOSED');
    }
    expect(decideMapWrite(row, { checksum: A, decision: same })).toBe('UNCHANGED');
  });

  it('RETRY_AFTER_FIX is always UPDATE — even an identical decision reopens it', () => {
    const row = reviewRow('RESOLVED', 'RETRY_AFTER_FIX');
    for (const decision of [same, ...others]) {
      expect(decideMapWrite(row, { checksum: A, decision })).toBe('UPDATE');
    }
  });

  it('an IMPORTED row is untouched by the review rules (never downgraded)', () => {
    const row = {
      status: 'IMPORTED' as const,
      checksum: A,
      entityType: 'SERVICE' as const,
      entityId: E1,
      reasonCode: null,
      reviewState: null,
      reviewResolutionCode: null,
    };
    expect(decideMapWrite(row, { checksum: A, decision: same })).toBe('IMPORTED_ENTITY_MISMATCH');
    expect(decideMapWrite(row, { checksum: A, decision: imported })).toBe('UNCHANGED');
  });

  it('a record without review fields (an older caller) is treated as no review', () => {
    const row = {
      status: 'MANUAL_REVIEW' as const,
      checksum: A,
      entityType: null,
      entityId: null,
      reasonCode: 'PROVIDER_MISSING' as const,
    };
    expect(decideMapWrite(row, { checksum: A, decision: same })).toBe('UNCHANGED');
    expect(isReviewClosedToRerun(row)).toBe(false);
  });
});

describe('reviewAfterWrite', () => {
  it('leaving review clears the state; staying or entering is OPEN; a closed one coming back counts', () => {
    expect(reviewAfterWrite(reviewRow('OPEN'), 'IMPORTED')).toEqual({
      reviewState: null,
      reopened: false,
    });
    expect(reviewAfterWrite(reviewRow('RESOLVED', 'RETRY_AFTER_FIX'), 'FAILED')).toEqual({
      reviewState: null,
      reopened: false,
    });
    expect(reviewAfterWrite(reviewRow('OPEN'), 'MANUAL_REVIEW')).toEqual({
      reviewState: 'OPEN',
      reopened: false,
    });
    expect(reviewAfterWrite({ status: 'FAILED', reviewState: null }, 'MANUAL_REVIEW')).toEqual({
      reviewState: 'OPEN',
      reopened: false,
    });
    expect(reviewAfterWrite(reviewRow('RESOLVED', 'RETRY_AFTER_FIX'), 'MANUAL_REVIEW')).toEqual({
      reviewState: 'OPEN',
      reopened: true,
    });
  });
});

describe('resumeDecision with a review', () => {
  it('skips a closed review, processes an OPEN or retry-resolved one', () => {
    expect(resumeDecision(reviewRow('DISMISSED', 'WILL_NOT_IMPORT'), A)).toBe('REVIEW_CLOSED');
    expect(resumeDecision(reviewRow('RESOLVED', 'HANDLED_OUTSIDE_IMPORT'), A)).toBe(
      'REVIEW_CLOSED',
    );
    expect(resumeDecision(reviewRow('RESOLVED', 'RETRY_AFTER_FIX'), A)).toBe('PROCESS');
    expect(resumeDecision(reviewRow('OPEN'), A)).toBe('PROCESS');
    expect(resumeDecision({ status: 'IMPORTED', checksum: A, reviewState: null }, A)).toBe('SKIP');
  });
});

describe('decisionForLegacyMatch (P5 match → map decision)', () => {
  it('routes every matcher outcome; nothing ambiguous is guessed or dropped', () => {
    expect(
      decisionForLegacyMatch({
        kind: 'ELIGIBLE',
        panelId: E1,
        username: 'alice',
        providerUsername: 'Alice',
      }),
    ).toBeNull();
    for (const reason of [
      'PROVIDER_MISSING',
      'AMBIGUOUS_PANEL',
      'PANEL_UNMAPPED',
      'USERNAME_CASE_COLLISION',
    ] as const) {
      expect(decisionForLegacyMatch({ kind: 'MANUAL_REVIEW', reason, candidatePanels: 0 })).toEqual(
        { status: 'MANUAL_REVIEW', reasonCode: reason },
      );
    }
    expect(decisionForLegacyMatch({ kind: 'SKIPPED', reason: 'TEST_PANEL' })).toEqual({
      status: 'SKIPPED',
      reasonCode: 'TEST_PANEL',
    });
    expect(decisionForLegacyMatch({ kind: 'INVALID', reason: 'INVALID_SOURCE_ROW' })).toEqual({
      status: 'MANUAL_REVIEW',
      reasonCode: 'INVALID_SOURCE_ROW',
    });
    expect(decisionForLegacyMatch({ kind: 'UNDECIDABLE', reason: 'INVENTORY_INCOMPLETE' })).toEqual(
      { status: 'MANUAL_REVIEW', reasonCode: 'INVENTORY_INCOMPLETE' },
    );
  });
});
