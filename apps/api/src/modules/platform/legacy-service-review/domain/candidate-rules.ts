import { createHash } from 'node:crypto';
import {
  LEGACY_SERVICE_ADOPTABLE_OUTCOMES,
  LEGACY_SERVICE_ADOPTED_OUTCOMES,
  type LegacyServiceEvidence,
  type LegacyServiceOutcome,
  type LegacyServiceReviewState,
} from '@nexa/contracts';

/**
 * Mirza migration PR5 — the candidate rules that must be true whoever writes the row, kept
 * pure so a unit test pins every branch and neither the importer nor the Web Admin grows a
 * second opinion.
 */

export function isAdoptedOutcome(outcome: LegacyServiceOutcome): boolean {
  return (LEGACY_SERVICE_ADOPTED_OUTCOMES as readonly string[]).includes(outcome);
}

/** sha256 of the evidence in a canonical key order: a change of evidence is a new version. */
export function evidenceHash(evidence: LegacyServiceEvidence): string {
  const canonical = JSON.stringify([
    evidence.panelCodeClass,
    evidence.mappedPanelId,
    evidence.customer,
    [...evidence.holders]
      .sort((a, b) => (a.panelId < b.panelId ? -1 : a.panelId > b.panelId ? 1 : 0))
      .map((h) => [h.panelId, h.mapped, h.spellings, h.state]),
    [...evidence.incompletePanels].sort(),
    [evidence.product.path, evidence.product.productId, evidence.product.resolved],
    evidence.claims,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The panels an ADOPT approval may name: a production panel the map maps EXPLICITLY whose
 * complete inventory, in the run that decided the candidate, held exactly one spelling of the
 * invoice's name. Never a panel guessed for the operator; never one without the account.
 */
export function adoptPanelsOf(evidence: LegacyServiceEvidence): readonly string[] {
  return evidence.holders
    .filter((h) => h.mapped && h.spellings === 1)
    .map((h) => h.panelId)
    .sort();
}

/**
 * What a run's re-decision does to the review state.
 *
 * - An adopted outcome is `ADOPTED`, always.
 * - An `ADOPTED` row receiving anything else is a broken invariant (a service is never
 *   unadopted; 0230 refuses it too): thrown, never absorbed.
 * - `ACKNOWLEDGED` was of the facts the person saw: a different outcome puts it back OPEN.
 * - `KEPT_AS_HISTORY` is a person's decision about the invoice: it holds until reopened.
 * - `ADOPT_APPROVED` / `ADOPTING` belong to the approval executor, which settles them.
 */
export function reviewStateAfterRun(
  existing: {
    readonly reviewState: LegacyServiceReviewState;
    readonly outcome: LegacyServiceOutcome;
  },
  outcome: LegacyServiceOutcome,
): LegacyServiceReviewState {
  if (isAdoptedOutcome(outcome)) return 'ADOPTED';
  switch (existing.reviewState) {
    case 'ADOPTED':
      throw new Error(
        `an adopted legacy service candidate cannot become ${outcome}; a service is never unadopted`,
      );
    case 'ACKNOWLEDGED':
      return existing.outcome === outcome ? 'ACKNOWLEDGED' : 'OPEN';
    case 'OPEN':
    case 'KEPT_AS_HISTORY':
    case 'ADOPT_APPROVED':
    case 'ADOPTING':
      return existing.reviewState;
  }
}

/** A new candidate's first review state. */
export function initialReviewState(outcome: LegacyServiceOutcome): LegacyServiceReviewState {
  return isAdoptedOutcome(outcome) ? 'ADOPTED' : 'OPEN';
}

/**
 * Whether a run's re-decision is a new version: anything a person's decision could have
 * been made from changed. The run id and the walk's time alone are not.
 */
export function isMaterialChange(
  existing: {
    readonly outcome: string;
    readonly blocker: string | null;
    readonly invoiceChecksum: string;
    readonly evidenceHash: string;
    readonly reviewState: string;
    readonly archiveId: string | null;
    readonly serviceId: string | null;
  },
  next: {
    readonly outcome: string;
    readonly blocker: string | null;
    readonly invoiceChecksum: string;
    readonly evidenceHash: string;
    readonly reviewState: string;
    readonly archiveId: string | null;
    readonly serviceId: string | null;
  },
): boolean {
  return (
    existing.outcome !== next.outcome ||
    existing.blocker !== next.blocker ||
    existing.invoiceChecksum !== next.invoiceChecksum ||
    existing.evidenceHash !== next.evidenceHash ||
    existing.reviewState !== next.reviewState ||
    existing.archiveId !== next.archiveId ||
    existing.serviceId !== next.serviceId
  );
}

export type AdoptRequestDecision =
  | { readonly ok: true; readonly approvedPanelId: string | null }
  | {
      readonly ok: false;
      readonly code: 'NOT_ADOPTABLE' | 'PANEL_REFUSED';
      readonly message: string;
    };

/**
 * Whether an operator may ASK to adopt this candidate, and with which panel. A courtesy
 * check against the latest evidence: the run that executes the approval decides again,
 * authoritatively, against the inventory it walks.
 *
 * - The outcome must be one a person can clear (`LEGACY_SERVICE_ADOPTABLE_OUTCOMES`).
 * - When the map gives the invoice NO panel (empty code — owner decision 8 —, an unmapped,
 *   unresolved or declared-missing code), the operator MUST name one, and it must be a
 *   mapped panel holding the account (`adoptPanelsOf`). Never guessed for them.
 * - When the map gives a panel, a different one is refused: an explicit mapping is never
 *   overridden by a click. Naming the same one is accepted and recorded as "the map's".
 */
export function decideAdoptRequest(
  candidate: { readonly outcome: LegacyServiceOutcome; readonly evidence: LegacyServiceEvidence },
  panelId: string | undefined,
): AdoptRequestDecision {
  if (!(LEGACY_SERVICE_ADOPTABLE_OUTCOMES as readonly string[]).includes(candidate.outcome)) {
    return {
      ok: false,
      code: 'NOT_ADOPTABLE',
      message: `A ${candidate.outcome} candidate cannot be approved for adoption.`,
    };
  }
  const mapped = candidate.evidence.mappedPanelId;
  if (mapped === null) {
    if (panelId === undefined) {
      return {
        ok: false,
        code: 'PANEL_REFUSED',
        message:
          'This invoice names no mapped panel: name the mapped panel that holds the account.',
      };
    }
    if (!adoptPanelsOf(candidate.evidence).includes(panelId)) {
      return {
        ok: false,
        code: 'PANEL_REFUSED',
        message:
          'That panel is not a mapped panel whose inventory held exactly this account in the latest run.',
      };
    }
    return { ok: true, approvedPanelId: panelId };
  }
  if (panelId !== undefined && panelId !== mapped) {
    return {
      ok: false,
      code: 'PANEL_REFUSED',
      message:
        "The panel map gives this invoice's code another panel; a mapping is never overridden.",
    };
  }
  return { ok: true, approvedPanelId: null };
}
