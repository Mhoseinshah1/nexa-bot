import { describe, expect, it } from 'vitest';
import { LEGACY_CUTOVER_BINDING_FIELDS, legacyCutoverApproveRequestSchema } from '@nexa/contracts';
import {
  decideCutoverImport,
  supersededSources,
  type CutoverApprovalFacts,
  type CutoverApplyRunFacts,
  type CutoverExpectation,
} from '../../apps/api/src/modules/platform/legacy-cutover/domain/cutover-rules';
import { cutoverGateOf } from '../../apps/api/src/modules/platform/legacy-importer/application/legacy-importer.service';

/**
 * Mirza migration PR6 — the ONE evaluator a gated import and the cutover gate both call
 * (`decideCutoverImport`). Each rule below is a way to import a snapshot nobody approved.
 */

const H = (c: string) => c.repeat(64);
const SOURCE = H('a');
const PRIOR = H('b');

const expectation = (): Record<string, string | null> => ({
  sourceFingerprint: SOURCE,
  panelMapFingerprint: H('1'),
  inventoryFingerprint: H('2'),
  productsFingerprint: H('3'),
  invoiceArchiveFingerprint: H('4'),
  freezeProofSha256: H('5'),
  finalDumpSha256: H('6'),
});

function approval(overrides: Partial<CutoverApprovalFacts> = {}): CutoverApprovalFacts {
  return {
    id: 'cutover-1',
    kind: 'CUTOVER',
    priorSourceFingerprint: null,
    synthetic: false,
    revoked: false,
    ...(expectation() as Record<string, string>),
    ...overrides,
  } as CutoverApprovalFacts;
}

function decide(input: {
  expectation?: Record<string, string | null>;
  approvals?: CutoverApprovalFacts[];
  applyRuns?: CutoverApplyRunFacts[];
  snapshotSynthetic?: boolean;
  productionLikeTarget?: boolean;
}) {
  return decideCutoverImport({
    expectation: (input.expectation ?? expectation()) as CutoverExpectation,
    approvals: input.approvals ?? [approval()],
    applyRuns: input.applyRuns ?? [],
    snapshotSynthetic: input.snapshotSynthetic ?? false,
    productionLikeTarget: input.productionLikeTarget ?? true,
  });
}

const run = (status: string, sourceFingerprint: string): CutoverApplyRunFacts => ({
  id: `${status}-${sourceFingerprint.slice(0, 4)}`,
  status,
  sourceFingerprint,
});

describe('decideCutoverImport', () => {
  it('an unrevoked approval matching all seven values lets the import proceed', () => {
    expect(decide({})).toEqual({
      ok: true,
      approvalId: 'cutover-1',
      rerunApprovalIds: [],
      supersededSources: [],
    });
  });

  it('every missing value is refused as incomplete, naming it', () => {
    for (const field of LEGACY_CUTOVER_BINDING_FIELDS) {
      const result = decide({ expectation: { ...expectation(), [field]: null } });
      expect(result, field).toMatchObject({
        ok: false,
        code: 'EXPECTATION_INCOMPLETE',
        detail: [field],
      });
    }
  });

  it('a changed value voids the approval — every one of the seven', () => {
    for (const field of LEGACY_CUTOVER_BINDING_FIELDS) {
      const result = decide({ approvals: [approval({ [field]: H('9') })] });
      expect(result, field).toMatchObject({ ok: false, code: 'APPROVAL_MISSING' });
    }
  });

  it('a missing or revoked approval is refused', () => {
    expect(decide({ approvals: [] })).toMatchObject({ code: 'APPROVAL_MISSING' });
    expect(decide({ approvals: [approval({ revoked: true })] })).toMatchObject({
      code: 'APPROVAL_MISSING',
    });
    // A re-run acknowledgement alone is not a cutover approval.
    expect(
      decide({
        approvals: [approval({ kind: 'RERUN_OVER_PRIOR_IMPORT', priorSourceFingerprint: PRIOR })],
      }),
    ).toMatchObject({ code: 'APPROVAL_MISSING' });
  });

  it('a synthetic approval never opens a production-like target; elsewhere it must match the snapshot', () => {
    expect(
      decide({ approvals: [approval({ synthetic: true })], snapshotSynthetic: true }),
    ).toMatchObject({ code: 'APPROVAL_SYNTHETIC' });
    expect(
      decide({
        approvals: [approval({ synthetic: true })],
        snapshotSynthetic: true,
        productionLikeTarget: false,
      }).ok,
    ).toBe(true);
    // Fixture consent is never taken for real consent, nor the reverse.
    expect(
      decide({ approvals: [approval({ synthetic: true })], productionLikeTarget: false }),
    ).toMatchObject({ code: 'APPROVAL_SYNTHETIC' });
    expect(
      decide({ approvals: [approval()], snapshotSynthetic: true, productionLikeTarget: false }),
    ).toMatchObject({ code: 'APPROVAL_SYNTHETIC' });
  });

  it('SOURCE_SUPERSEDED: a finished import of another source needs an acknowledgement naming it', () => {
    for (const status of ['COMPLETED', 'ABORTED', 'FAILED']) {
      expect(decide({ applyRuns: [run(status, PRIOR)] }), status).toMatchObject({
        ok: false,
        code: 'SOURCE_SUPERSEDED',
        detail: [PRIOR],
      });
    }
    // A RUNNING run is not a prior import (it is resumed, or refused by the run table).
    expect(decide({ applyRuns: [run('RUNNING', PRIOR)] }).ok).toBe(true);
    // The same source again is a resume or a rerun of the same snapshot, not a supersede.
    expect(decide({ applyRuns: [run('COMPLETED', SOURCE)] }).ok).toBe(true);

    const ack = approval({
      id: 'rerun-1',
      kind: 'RERUN_OVER_PRIOR_IMPORT',
      priorSourceFingerprint: PRIOR,
    });
    expect(decide({ applyRuns: [run('COMPLETED', PRIOR)], approvals: [approval(), ack] })).toEqual({
      ok: true,
      approvalId: 'cutover-1',
      rerunApprovalIds: ['rerun-1'],
      supersededSources: [PRIOR],
    });
    // Revoked, for another prior, bound to another value, or of another class: no acknowledgement.
    for (const other of [
      { ...ack, revoked: true },
      { ...ack, priorSourceFingerprint: H('c') },
      { ...ack, finalDumpSha256: H('9') },
      { ...ack, synthetic: true },
    ]) {
      expect(
        decide({ applyRuns: [run('COMPLETED', PRIOR)], approvals: [approval(), other] }),
      ).toMatchObject({
        code: 'SOURCE_SUPERSEDED',
      });
    }
    // Two earlier sources: both must be acknowledged.
    expect(
      decide({
        applyRuns: [run('COMPLETED', PRIOR), run('ABORTED', H('c'))],
        approvals: [approval(), ack],
      }),
    ).toMatchObject({ code: 'SOURCE_SUPERSEDED', detail: [H('c')] });
  });

  it('supersededSources is distinct and sorted', () => {
    expect(
      supersededSources(
        [
          run('COMPLETED', H('c')),
          run('FAILED', PRIOR),
          run('COMPLETED', H('c')),
          run('COMPLETED', SOURCE),
        ],
        SOURCE,
      ),
    ).toEqual([PRIOR, H('c')]);
  });
});

describe('where the gate applies', () => {
  it('an explicitly production-like target is gated even with no expectation: fail closed', () => {
    const gate = cutoverGateOf({ productionLikeTarget: true });
    expect(gate).not.toBeNull();
    expect(Object.values(gate?.expectation ?? {})).toEqual(
      LEGACY_CUTOVER_BINDING_FIELDS.map(() => null),
    );
    expect(cutoverGateOf({ productionLikeTarget: false })).toBeNull();
    expect(cutoverGateOf({})).toBeNull();
    const asked = { expectation: expectation() as CutoverExpectation };
    expect(cutoverGateOf({ productionLikeTarget: false, cutoverGate: asked })).toBe(asked);
  });
});

describe('the approval request', () => {
  const body = {
    idempotencyKey: 'key-12345',
    kind: 'CUTOVER',
    ...expectation(),
    priorSourceFingerprint: null,
    reason: 'ok',
  };

  it('values are exact: never trimmed, never case-folded', () => {
    expect(legacyCutoverApproveRequestSchema.safeParse(body).success).toBe(true);
    expect(
      legacyCutoverApproveRequestSchema.safeParse({ ...body, finalDumpSha256: ` ${H('6')}` })
        .success,
    ).toBe(false);
    expect(
      legacyCutoverApproveRequestSchema.safeParse({ ...body, finalDumpSha256: H('A') }).success,
    ).toBe(false);
    expect(legacyCutoverApproveRequestSchema.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });

  it('a re-run acknowledgement names a prior source other than this one; a cutover names none', () => {
    const rerun = { ...body, kind: 'RERUN_OVER_PRIOR_IMPORT' };
    expect(legacyCutoverApproveRequestSchema.safeParse(rerun).success).toBe(false);
    expect(
      legacyCutoverApproveRequestSchema.safeParse({ ...rerun, priorSourceFingerprint: SOURCE })
        .success,
    ).toBe(false);
    expect(
      legacyCutoverApproveRequestSchema.safeParse({ ...rerun, priorSourceFingerprint: PRIOR })
        .success,
    ).toBe(true);
    expect(
      legacyCutoverApproveRequestSchema.safeParse({ ...body, priorSourceFingerprint: PRIOR })
        .success,
    ).toBe(false);
  });
});
