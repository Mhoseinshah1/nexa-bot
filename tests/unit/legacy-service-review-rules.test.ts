import { describe, expect, it } from 'vitest';
import {
  LEGACY_SERVICE_ADOPTABLE_OUTCOMES,
  LEGACY_SERVICE_APPROVAL_REFUSALS,
  LEGACY_SERVICE_OUTCOMES,
  LEGACY_SERVICE_REVIEW_STATES,
  legacyServiceAdoptRequestSchema,
  legacyServiceCandidateListQuerySchema,
  type LegacyServiceEvidence,
  type LegacyServiceOutcome,
} from '@nexa/contracts';
import {
  adoptPanelsOf,
  decideAdoptRequest,
  evidenceHash,
  initialReviewState,
  isMaterialChange,
  reviewStateAfterRun,
} from '../../apps/api/src/modules/platform/legacy-service-review/domain/candidate-rules';
import {
  approvalGate,
  buildServiceOutcomesSection,
  candidateEvidence,
  candidateOutcome,
  claimsByName,
} from '../../apps/api/src/modules/platform/legacy-importer/application/service-outcomes';
import { reportHolds } from '../../apps/api/src/modules/platform/legacy-importer/application/legacy-importer.service';
import { SERVICE_CANDIDATE_CATEGORIES } from '../../apps/api/src/modules/platform/legacy-importer/application/decisions';
import { parsePanelMapping } from '../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';
import type { LegacyInvoiceRow } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { syntheticMappingFile, syntheticInventories } from '../fixtures/legacy/synthetic-support';
import { SYNTHETIC_PANEL_CODES } from '../fixtures/legacy/synthetic-legacy';

/**
 * Mirza migration PR5 — the pure rules of service outcomes and the operator's review
 * (`docs/legacy-migration/service-review.md`). Each `it` names the rule it pins; the
 * mutation driver `scripts/mutate-mirza-pr5.py` reverts each and watches it fail.
 */

const TENANT = '01900000-0000-7000-8000-000000000001';
const PANEL_A = '01900000-0000-7000-8000-0000000000aa';
const PANEL_B = '01900000-0000-7000-8000-0000000000bb';
const H = (c: string) => c.repeat(64);

const evidence = (over: Partial<LegacyServiceEvidence> = {}): LegacyServiceEvidence => ({
  panelCodeClass: 'EMPTY',
  mappedPanelId: null,
  customer: 'IMPORTED',
  holders: [
    { panelId: PANEL_B, mapped: true, spellings: 1, state: 'active' },
    { panelId: PANEL_A, mapped: true, spellings: 2, state: null },
  ],
  incompletePanels: [],
  product: { path: 'HIDDEN_SHAPE', productId: null, resolved: true },
  claims: 1,
  ...over,
});

const row = (over: Partial<LegacyInvoiceRow> = {}): LegacyInvoiceRow => ({
  idInvoice: 'a0000001',
  idUser: '1',
  username: 'svc_nullmatch',
  status: 'active',
  isTest: '0',
  codePanel: null,
  codeProduct: null,
  volume: '30',
  serviceTime: '30',
  timeUnit: '',
  isCustom: '0',
  checksum: H('c'),
  ...over,
});

describe('the outcome vocabulary', () => {
  it('every importer category IS an outcome, and the adopted pair and approval refusals are closed', () => {
    for (const category of SERVICE_CANDIDATE_CATEGORIES) {
      expect(LEGACY_SERVICE_OUTCOMES as readonly string[]).toContain(category);
    }
    for (const o of ['ADOPTED', 'ALREADY_ADOPTED', 'NO_PANEL', 'AMBIGUOUS_OWNERSHIP'] as const) {
      expect(LEGACY_SERVICE_OUTCOMES).toContain(o);
    }
    expect(LEGACY_SERVICE_APPROVAL_REFUSALS).not.toContain('ADOPTED');
    expect(LEGACY_SERVICE_APPROVAL_REFUSALS).toContain('SOURCE_CHANGED');
    for (const o of [
      'TEST_INVOICE_SKIPPED',
      'INVOICE_KEY_INVALID',
      'AMBIGUOUS_OWNERSHIP',
    ] as const) {
      expect(LEGACY_SERVICE_ADOPTABLE_OUTCOMES as readonly string[]).not.toContain(o);
    }
    for (const s of ['OPEN', 'KEPT_AS_HISTORY', 'ADOPT_APPROVED', 'ADOPTING', 'ADOPTED'] as const) {
      expect(LEGACY_SERVICE_REVIEW_STATES).toContain(s);
    }
  });

  it('a verbatim invoice id is never trimmed; a code (stored trimmed) is', () => {
    expect(legacyServiceCandidateListQuerySchema.parse({ invoiceId: ' a0 ' }).invoiceId).toBe(
      ' a0 ',
    );
    expect(legacyServiceCandidateListQuerySchema.parse({ panelCode: ' rp1 ' }).panelCode).toBe(
      'rp1',
    );
    expect(() =>
      legacyServiceAdoptRequestSchema.parse({
        idempotencyKey: 'k'.repeat(8),
        expectedVersion: 1,
        reason: 'x',
        extra: true,
      }),
    ).toThrow();
  });
});

describe('decideAdoptRequest', () => {
  it('owner decision 8: an invoice with no mapped panel needs a named mapped panel that held exactly the account', () => {
    const c = { outcome: 'NO_PANEL' as const, evidence: evidence() };
    expect(decideAdoptRequest(c, undefined)).toMatchObject({ ok: false, code: 'PANEL_REFUSED' });
    // Panel A holds two spellings: a collision, never offered.
    expect(decideAdoptRequest(c, PANEL_A)).toMatchObject({ ok: false, code: 'PANEL_REFUSED' });
    expect(decideAdoptRequest(c, PANEL_B)).toEqual({ ok: true, approvedPanelId: PANEL_B });
    // A holder the map does not map is never offered.
    const unmapped = {
      outcome: 'NO_PANEL' as const,
      evidence: evidence({
        holders: [{ panelId: PANEL_B, mapped: false, spellings: 1, state: 'active' }],
      }),
    };
    expect(decideAdoptRequest(unmapped, PANEL_B)).toMatchObject({ ok: false });
    expect(adoptPanelsOf(evidence())).toEqual([PANEL_B]);
  });

  it('aud5 F2 / OQ-LSR-01: a non-empty code the map does not map is never adopted onto another panel', () => {
    for (const panelCodeClass of [
      'UNMAPPED',
      'DECLARED_UNRESOLVED',
      'DECLARED_MISSING',
      'TEST',
    ] as const) {
      // PANEL_B is a mapped panel holding exactly the account — and still never offered.
      const e = evidence({ panelCodeClass, mappedPanelId: null });
      expect(adoptPanelsOf(e), panelCodeClass).toEqual([]);
      for (const outcome of ['PANEL_UNMAPPED', 'PROVIDER_MISSING', 'NO_PANEL'] as const) {
        const c = { outcome, evidence: e };
        // Refused for the code, not merely for the panel: the remedy named is the panel map.
        expect(decideAdoptRequest(c, PANEL_B), panelCodeClass).toMatchObject({
          ok: false,
          code: 'PANEL_REFUSED',
          message: expect.stringContaining('names a panel the map does not map'),
        });
        expect(decideAdoptRequest(c, undefined), panelCodeClass).toMatchObject({
          ok: false,
          code: 'PANEL_REFUSED',
        });
      }
    }
    // The EMPTY code keeps its explicit approval.
    expect(adoptPanelsOf(evidence({ panelCodeClass: 'EMPTY' }))).toEqual([PANEL_B]);
  });

  it('an explicit mapping is never overridden by a click; the same panel is the map’s', () => {
    const c = {
      outcome: 'PRODUCT_UNRESOLVED' as const,
      evidence: evidence({ panelCodeClass: 'MAPPED', mappedPanelId: PANEL_A }),
    };
    expect(decideAdoptRequest(c, PANEL_B)).toMatchObject({ ok: false, code: 'PANEL_REFUSED' });
    expect(decideAdoptRequest(c, PANEL_A)).toEqual({ ok: true, approvedPanelId: null });
    expect(decideAdoptRequest(c, undefined)).toEqual({ ok: true, approvedPanelId: null });
  });

  it('only an outcome a person can clear is adoptable', () => {
    for (const outcome of LEGACY_SERVICE_OUTCOMES) {
      const verdict = decideAdoptRequest(
        { outcome, evidence: evidence({ mappedPanelId: PANEL_B }) },
        undefined,
      );
      expect(verdict.ok, outcome).toBe(
        (LEGACY_SERVICE_ADOPTABLE_OUTCOMES as readonly string[]).includes(outcome),
      );
    }
  });
});

describe('the review state across runs', () => {
  it('an adopted outcome is ADOPTED; an ADOPTED row is never unadopted', () => {
    expect(reviewStateAfterRun({ reviewState: 'OPEN', outcome: 'NO_PANEL' }, 'ADOPTED')).toBe(
      'ADOPTED',
    );
    expect(() =>
      reviewStateAfterRun({ reviewState: 'ADOPTED', outcome: 'ADOPTED' }, 'PROVIDER_MISSING'),
    ).toThrow(/never unadopted/u);
    expect(initialReviewState('ALREADY_ADOPTED')).toBe('ADOPTED');
    expect(initialReviewState('NO_PANEL')).toBe('OPEN');
  });

  it('an acknowledgement of other facts reopens; a keep and an approval hold', () => {
    expect(
      reviewStateAfterRun({ reviewState: 'ACKNOWLEDGED', outcome: 'NO_PANEL' }, 'NO_PANEL'),
    ).toBe('ACKNOWLEDGED');
    expect(
      reviewStateAfterRun({ reviewState: 'ACKNOWLEDGED', outcome: 'NO_PANEL' }, 'PANEL_UNMAPPED'),
    ).toBe('OPEN');
    for (const held of ['KEPT_AS_HISTORY', 'ADOPT_APPROVED', 'ADOPTING'] as const) {
      expect(
        reviewStateAfterRun({ reviewState: held, outcome: 'NO_PANEL' }, 'ADOPTION_ELIGIBLE'),
      ).toBe(held);
    }
  });

  it('a new version only when something a decision rests on changed — never for the run id alone', () => {
    const base = {
      outcome: 'NO_PANEL',
      blocker: 'PANEL_UNMAPPED',
      invoiceChecksum: H('a'),
      evidenceHash: H('b'),
      reviewState: 'OPEN',
      archiveId: null,
      serviceId: null,
    };
    expect(isMaterialChange(base, { ...base })).toBe(false);
    for (const [k, v] of [
      ['outcome', 'PROVIDER_MISSING'],
      ['blocker', null],
      ['invoiceChecksum', H('c')],
      ['evidenceHash', H('d')],
      ['reviewState', 'ACKNOWLEDGED'],
      ['archiveId', 'x'],
      ['serviceId', 'y'],
    ] as const) {
      expect(isMaterialChange(base, { ...base, [k]: v }), k).toBe(true);
    }
  });

  it('the evidence hash is canonical in holder and panel order, and changes with any fact', () => {
    const e = evidence();
    const reordered = evidence({ holders: [...e.holders].reverse() });
    expect(evidenceHash(reordered)).toBe(evidenceHash(e));
    expect(evidenceHash(evidence({ claims: 2 }))).not.toBe(evidenceHash(e));
    expect(evidenceHash(evidence({ customer: 'NOT_IMPORTED' }))).not.toBe(evidenceHash(e));
  });
});

describe('candidateOutcome', () => {
  const eligible = {
    category: 'ADOPTION_ELIGIBLE' as const,
    panelId: PANEL_A,
    providerUsername: 'svc_a1',
    product: { kind: 'HIDDEN_SHAPE' as const, shapeKey: 'k', custom: false },
    telegramUserId: '1',
  };
  const mapRow = (over: Record<string, unknown>) =>
    ({
      tenantId: TENANT,
      legacyTable: 'invoice',
      legacyId: 'a0000001',
      runId: 'r',
      checksum: H('c'),
      status: 'MANUAL_REVIEW',
      reasonCode: 'PANEL_UNMAPPED',
      entityType: null,
      entityId: null,
      attempts: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      reviewState: 'OPEN',
      reviewResolutionCode: null,
      reviewedAt: null,
      reviewedByActorType: null,
      reviewedByActorId: null,
      reviewReopenedCount: 0,
      ref: 'x',
      ...over,
    }) as never;

  it('an adopted invoice stays ALREADY_ADOPTED whatever the snapshot says, the fresh category its blocker', () => {
    const adopted = mapRow({
      status: 'IMPORTED',
      entityType: 'SERVICE',
      entityId: 's-1',
      reasonCode: null,
    });
    expect(
      candidateOutcome(
        {
          category: 'PROVIDER_MISSING',
          map: { status: 'MANUAL_REVIEW', reasonCode: 'PROVIDER_MISSING' },
        },
        adopted,
        null,
      ),
    ).toEqual({ outcome: 'ALREADY_ADOPTED', blocker: 'PROVIDER_MISSING', serviceId: 's-1' });
  });

  it('a row a person closed in the terminal queue is REVIEW_CLOSED', () => {
    const closed = mapRow({ reviewState: 'DISMISSED', reviewResolutionCode: 'WILL_NOT_IMPORT' });
    expect(candidateOutcome(eligible, closed, null).outcome).toBe('REVIEW_CLOSED');
  });

  it('maps every adoption answer to exactly one outcome', () => {
    const cases: [unknown, LegacyServiceOutcome][] = [
      [{ kind: 'ADOPTED', serviceId: 's' }, 'ADOPTED'],
      [{ kind: 'ALREADY_ADOPTED', serviceId: 's' }, 'ALREADY_ADOPTED'],
      [{ kind: 'FAILED', reason: 'PROVIDER_READ_FAILED' }, 'PROVIDER_READ_FAILED'],
      [{ kind: 'KEPT_AS_HISTORY' }, 'ADOPTION_ELIGIBLE'],
      [{ kind: 'MANUAL_REVIEW', reason: 'CONFLICTING_EXISTING_ENTITY' }, 'AMBIGUOUS_OWNERSHIP'],
      [{ kind: 'MANUAL_REVIEW', reason: 'CUSTOMER_MISSING' }, 'CUSTOMER_NOT_IMPORTED'],
      [{ kind: 'MANUAL_REVIEW', reason: 'PRODUCT_MAPPING_UNRESOLVED' }, 'PRODUCT_UNRESOLVED'],
      [{ kind: 'MANUAL_REVIEW', reason: 'UNSUPPORTED_SHAPE' }, 'UNSUPPORTED_SHAPE'],
      [{ kind: 'MANUAL_REVIEW', reason: 'SUBSCRIPTION_REF_BLOCKED' }, 'SUBSCRIPTION_REF_BLOCKED'],
    ];
    for (const [answer, outcome] of cases) {
      expect(
        candidateOutcome(eligible, undefined, { kind: 'ADOPTION', outcome: answer as never })
          .outcome,
      ).toBe(outcome);
    }
    expect(candidateOutcome(eligible, undefined, { kind: 'PENDING' }).outcome).toBe(
      'ADOPTION_ELIGIBLE',
    );
    expect(
      candidateOutcome(
        { category: 'NO_PANEL', map: { status: 'MANUAL_REVIEW', reasonCode: 'PANEL_UNMAPPED' } },
        undefined,
        null,
      ),
    ).toEqual({ outcome: 'NO_PANEL', blocker: 'PANEL_UNMAPPED', serviceId: null });
  });
});

describe('the approval gate', () => {
  const mapping = parsePanelMapping(syntheticMappingFile(TENANT, PANEL_A, PANEL_B), TENANT);
  const approval = { synthetic: false, approvedChecksum: H('c'), approvedPanelId: PANEL_B };
  const context = { mapping, productionLikeTarget: false, snapshotSynthetic: false };

  it('a synthetic approval is never acted on against a production-like target', () => {
    expect(
      approvalGate({ ...approval, synthetic: true }, row(), {
        ...context,
        productionLikeTarget: true,
        snapshotSynthetic: true,
      }),
    ).toEqual({ kind: 'LEAVE', why: 'SYNTHETIC_ON_PRODUCTION' });
    // Nor one of the other source class.
    expect(approvalGate({ ...approval, synthetic: true }, row(), context)).toEqual({
      kind: 'LEAVE',
      why: 'SOURCE_CLASS_MISMATCH',
    });
  });

  it('bound to the very row and to an explicitly mapped panel', () => {
    expect(approvalGate(approval, undefined, context)).toEqual({
      kind: 'REFUSE',
      refusal: 'NOT_LIVE',
    });
    expect(approvalGate(approval, row({ checksum: H('d') }), context)).toEqual({
      kind: 'REFUSE',
      refusal: 'SOURCE_CHANGED',
    });
    expect(
      approvalGate(
        { ...approval, approvedPanelId: '01900000-0000-7000-8000-0000000000cc' },
        row(),
        context,
      ),
    ).toEqual({ kind: 'REFUSE', refusal: 'PANEL_NOT_MAPPED' });
    // The invoice's own code maps to A: B would override the map.
    expect(approvalGate(approval, row({ codePanel: 'rp1' }), context)).toEqual({
      kind: 'REFUSE',
      refusal: 'PANEL_CONFLICTS_WITH_MAP',
    });
    expect(approvalGate(approval, row(), context)).toEqual({ kind: 'ACCEPT', panelId: PANEL_B });
    // aud5 F2 / OQ-LSR-01: a named panel is for an EMPTY code only. A real code the map does
    // not map — unresolved, declared missing, test, or never listed — is refused.
    for (const codePanel of [
      SYNTHETIC_PANEL_CODES.unmapped,
      SYNTHETIC_PANEL_CODES.declaredMissing,
      SYNTHETIC_PANEL_CODES.test,
      'never-listed',
    ]) {
      expect(approvalGate(approval, row({ codePanel }), context), codePanel).toEqual({
        kind: 'REFUSE',
        refusal: 'PANEL_UNMAPPED',
      });
    }
    // The code that maps to the approved panel itself is the map's, not an override.
    expect(
      approvalGate(approval, row({ codePanel: SYNTHETIC_PANEL_CODES.mappedB }), context),
    ).toEqual({ kind: 'ACCEPT', panelId: PANEL_B });
    expect(approvalGate({ ...approval, approvedPanelId: null }, row(), context)).toEqual({
      kind: 'ACCEPT',
      panelId: null,
    });
  });
});

describe('the evidence and the section', () => {
  const mapping = parsePanelMapping(syntheticMappingFile(TENANT, PANEL_A, PANEL_B), TENANT);
  const inventories = syntheticInventories(PANEL_A, PANEL_B);

  it('evidence names holders, never a username; a no-panel invoice is EMPTY with no mapped panel', () => {
    const e = candidateEvidence(row(), {
      mapping,
      inventories,
      userIds: new Set(['1']),
      importedUsers: new Map([['1', '1']]),
      productCodes: new Set(),
      tariffOf: () => 'RESOLVED',
      claimsByName: claimsByName([row(), row({ idInvoice: 'a0000002' })], new Set(['a0000002'])),
    });
    expect(e).toMatchObject({
      panelCodeClass: 'EMPTY',
      mappedPanelId: null,
      customer: 'IMPORTED',
      holders: [{ panelId: PANEL_B, mapped: true, spellings: 1 }],
      claims: 1,
    });
    expect(JSON.stringify(e)).not.toContain('svc_');
  });

  it('the closure: every candidate exactly one outcome from this run — missing, another run, another source all break it', () => {
    const snap = {
      fingerprint: H('f'),
      synthetic: true,
      liveInvoices: [row(), row({ idInvoice: 'a0000002' })],
    };
    const rec = (key: string, over: Record<string, unknown> = {}) =>
      [
        key,
        {
          invoiceKey: key,
          runId: 'run',
          sourceFingerprint: H('f'),
          invoiceChecksum: H('c'),
          outcome: 'NO_PANEL',
          reviewState: 'OPEN',
          archiveId: 'arch',
          ...over,
        },
      ] as const;
    const ok = buildServiceOutcomesSection({
      snapshot: snap,
      runId: 'run',
      rows: new Map([rec('a0000001'), rec('a0000002')]) as never,
    });
    expect(ok.invariant.holds).toBe(true);
    expect(ok.outcomes.NO_PANEL).toBe(2);
    expect(ok.archivedHistory).toEqual({
      notAdopted: 2,
      linkedToArchive: 2,
      notLinkedToArchive: 0,
    });
    const missing = buildServiceOutcomesSection({
      snapshot: snap,
      runId: 'run',
      rows: new Map([rec('a0000001')]) as never,
    });
    expect(missing.invariant).toMatchObject({ holds: false, missing: 1 });
    const stale = buildServiceOutcomesSection({
      snapshot: snap,
      runId: 'run',
      rows: new Map([rec('a0000001'), rec('a0000002', { runId: 'old' })]) as never,
    });
    expect(stale.invariant).toMatchObject({ holds: false, decidedByAnotherRun: 1 });
    const other = buildServiceOutcomesSection({
      snapshot: snap,
      runId: 'run',
      rows: new Map([rec('a0000001'), rec('a0000002', { sourceFingerprint: H('e') })]) as never,
    });
    expect(other.invariant).toMatchObject({ holds: false, fromAnotherSource: 1 });
  });
});

describe('the report verdict', () => {
  it('the closure of the service outcomes is part of the report verdict', () => {
    const final = { reconciliation: [{ holds: true }] };
    expect(reportHolds(final, { holds: true }, { invariant: { holds: true } })).toBe(true);
    expect(reportHolds(final, { holds: true }, { invariant: { holds: false } })).toBe(false);
    expect(reportHolds(final, { holds: false }, { invariant: { holds: true } })).toBe(false);
    expect(
      reportHolds(
        { reconciliation: [{ holds: false }] },
        { holds: true },
        { invariant: { holds: true } },
      ),
    ).toBe(false);
  });
});
