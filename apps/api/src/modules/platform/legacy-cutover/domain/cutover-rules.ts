import {
  LEGACY_CUTOVER_BINDING_FIELDS,
  LEGACY_CUTOVER_SUPERSEDING_RUN_STATUSES,
  type LegacyCutoverApprovalKind,
  type LegacyCutoverBinding,
  type LegacyCutoverBindingField,
} from '@nexa/contracts';

/**
 * Mirza migration PR6 — the cutover's rules, pure (owner constraints 3 and 4; audit §6.2).
 *
 * ONE evaluator decides whether an import may proceed against a target where the cutover
 * gate applies; the importer calls it inside its start transaction and the cutover-gate
 * command calls it again, so the two can never disagree about what an approval means.
 */

/** One approval as the rules read it: its binding, whether revoked, and its evidence class. */
export interface CutoverApprovalFacts extends LegacyCutoverBinding {
  readonly id: string;
  readonly kind: LegacyCutoverApprovalKind;
  readonly priorSourceFingerprint: string | null;
  readonly synthetic: boolean;
  readonly revoked: boolean;
}

/** One APPLY run of the tenant, as the supersede rule reads it. */
export interface CutoverApplyRunFacts {
  readonly id: string;
  readonly status: string;
  readonly sourceFingerprint: string;
}

/** What the import was told: every `--expected-*` value, or null where none was given. */
export type CutoverExpectation = Readonly<Record<LegacyCutoverBindingField, string | null>>;

export type CutoverDecision =
  | {
      readonly ok: true;
      /** The CUTOVER approval the import runs under. */
      readonly approvalId: string;
      /** The re-run acknowledgements it also runs under, one per superseded source. */
      readonly rerunApprovalIds: readonly string[];
      /** The earlier sources this import re-runs over (acknowledged), sorted. */
      readonly supersededSources: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code:
        'EXPECTATION_INCOMPLETE' | 'APPROVAL_MISSING' | 'APPROVAL_SYNTHETIC' | 'SOURCE_SUPERSEDED';
      readonly message: string;
      /** EXPECTATION_INCOMPLETE: the fields not given. SOURCE_SUPERSEDED: unacknowledged sources. */
      readonly detail: readonly string[];
    };

/** The binding, when every value was given; else the fields that were not. */
export function completeBinding(
  expectation: CutoverExpectation,
):
  | { readonly ok: true; readonly binding: LegacyCutoverBinding }
  | { readonly ok: false; readonly missing: readonly LegacyCutoverBindingField[] } {
  const missing = LEGACY_CUTOVER_BINDING_FIELDS.filter((field) => expectation[field] === null);
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, binding: expectation as LegacyCutoverBinding };
}

/** Exactly the same seven values. No field is optional and none is compared loosely. */
export function bindingMatches(
  approval: LegacyCutoverBinding,
  binding: LegacyCutoverBinding,
): boolean {
  return LEGACY_CUTOVER_BINDING_FIELDS.every((field) => approval[field] === binding[field]);
}

/**
 * The prior sources an import of `sourceFingerprint` re-runs over: every DIFFERENT source of
 * a finished (COMPLETED, ABORTED or FAILED) APPLY run. Sorted, distinct.
 */
export function supersededSources(
  runs: readonly CutoverApplyRunFacts[],
  sourceFingerprint: string,
): readonly string[] {
  const finished: ReadonlySet<string> = new Set(LEGACY_CUTOVER_SUPERSEDING_RUN_STATUSES);
  return [
    ...new Set(
      runs
        .filter((run) => finished.has(run.status) && run.sourceFingerprint !== sourceFingerprint)
        .map((run) => run.sourceFingerprint),
    ),
  ].sort();
}

/**
 * Whether an import may proceed where the cutover gate applies. In order:
 *
 * 1. every `--expected-*` value was given (EXPECTATION_INCOMPLETE);
 * 2. an UNREVOKED CUTOVER approval matches all seven exactly (APPROVAL_MISSING);
 * 3. on a production-like target, that approval is not synthetic; on any target, its
 *    evidence class is the snapshot's (APPROVAL_SYNTHETIC);
 * 4. every earlier source a finished APPLY run imported is acknowledged by an unrevoked
 *    RERUN_OVER_PRIOR_IMPORT approval with the SAME seven values and that prior source,
 *    of the same evidence class (SOURCE_SUPERSEDED).
 */
export function decideCutoverImport(input: {
  readonly expectation: CutoverExpectation;
  readonly approvals: readonly CutoverApprovalFacts[];
  readonly applyRuns: readonly CutoverApplyRunFacts[];
  readonly snapshotSynthetic: boolean;
  readonly productionLikeTarget: boolean;
}): CutoverDecision {
  const complete = completeBinding(input.expectation);
  if (!complete.ok) {
    return {
      ok: false,
      code: 'EXPECTATION_INCOMPLETE',
      message:
        `the cutover gate needs every approved value; missing: ${complete.missing.join(', ')}. ` +
        'Nothing was written.',
      detail: complete.missing,
    };
  }
  const binding = complete.binding;
  const live = input.approvals.filter((a) => !a.revoked && bindingMatches(a, binding));
  const cutover = live.filter((a) => a.kind === 'CUTOVER');
  if (cutover.length === 0) {
    return {
      ok: false,
      code: 'APPROVAL_MISSING',
      message:
        'no unrevoked owner approval (Web Admin → legacy cutover) matches every value this ' +
        'import was given: source, panel map, inventory, products, invoice archive, freeze ' +
        'proof and final dump. A changed value voids an approval. Nothing was written.',
      detail: [],
    };
  }
  const usable = cutover.filter((a) => evidenceAgrees(a, input));
  const approval = usable[0];
  if (approval === undefined) {
    return {
      ok: false,
      code: 'APPROVAL_SYNTHETIC',
      message: input.productionLikeTarget
        ? 'the matching approval was made over a SYNTHETIC source: a fixture never approves a production-like import. Nothing was written.'
        : 'the matching approval was made over a source of another evidence class than this snapshot. Nothing was written.',
      detail: [],
    };
  }
  const prior = supersededSources(input.applyRuns, binding.sourceFingerprint);
  const reruns = live.filter(
    (a) => a.kind === 'RERUN_OVER_PRIOR_IMPORT' && evidenceAgrees(a, input),
  );
  const unacknowledged = prior.filter(
    (source) => !reruns.some((a) => a.priorSourceFingerprint === source),
  );
  if (unacknowledged.length > 0) {
    return {
      ok: false,
      code: 'SOURCE_SUPERSEDED',
      message:
        `this tenant already holds a finished import of another source (${unacknowledged.join(', ')}). ` +
        'An import over it is a re-run, and needs the owner\'s explicit "re-run over prior import" ' +
        'acknowledgement bound to these values and that prior source. Nothing was written.',
      detail: unacknowledged,
    };
  }
  const rerunApprovalIds = prior.map(
    (source) =>
      (reruns.find((a) => a.priorSourceFingerprint === source) as CutoverApprovalFacts).id,
  );
  return {
    ok: true,
    approvalId: approval.id,
    rerunApprovalIds,
    supersededSources: prior,
  };
}

/**
 * A synthetic approval never authorises a production-like import; and on any target an
 * approval's evidence class must be the snapshot's, so fixture consent is never taken for
 * real consent (PR3's lesson: stored state is re-checked for `synthetic` before acting).
 */
function evidenceAgrees(
  approval: CutoverApprovalFacts,
  input: { readonly snapshotSynthetic: boolean; readonly productionLikeTarget: boolean },
): boolean {
  if (input.productionLikeTarget && approval.synthetic) return false;
  return approval.synthetic === input.snapshotSynthetic;
}

/**
 * A gated import refused. Carries a CODE (one of `LEGACY_CUTOVER_ERROR_CODES`' import
 * refusals, by name) and a message of fingerprints and field names only — never a legacy
 * row. The CLI exits 65 on it, as on every other approval mismatch, with nothing written.
 */
export class LegacyCutoverRefused extends Error {
  override readonly name = 'LegacyCutoverRefused';
  constructor(
    readonly code:
      | 'EXPECTATION_INCOMPLETE'
      | 'APPROVAL_MISSING'
      | 'APPROVAL_SYNTHETIC'
      | 'SOURCE_SUPERSEDED'
      | 'TABLES_UNCLASSIFIED',
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}
